// src/harbour.js — the surveyed harbourfront: shoreline, quay wall, piers, slips, breakwaters,
// marinas, the ferry terminal and the public walkways along the water.
//
// CONTRACT.md §8.3. Zero dependencies. World axes: X = east, Y = up, Z = south, true metres.
//
// Why this module exists
// ----------------------
// The shoreline used to be GUESSED: city.js distance-transformed the road network and called
// everything far from mapped infrastructure "lake", which put the water's edge within about
// +/-25 m of the truth and produced a beach — a soft interpolated slope running down into the
// water. Toronto's harbourfront is not a beach. It is a continuous engineered edge: a vertical
// quay wall standing on the lake bed, a coping stone, and paving right up to it. The wall IS the
// land/water boundary. data/toronto.json now carries that boundary as survey:
//
//   shore[]       ways clipped from the OSM Lake Ontario multipolygon, {role: outer|inner, p}
//   waterfront[]  engineered edges, {k, n, p} with k in
//                 pier | quay | breakwater | groyne | retaining_wall | marina | ferry_terminal
//
// The terrain grid cannot represent a vertical wall
// ------------------------------------------------
// The terrain is a 25 m grid. Between a land vertex and a water vertex it interpolates linearly,
// so the height crosses the lake datum somewhere inside that cell — and wherever that crossing
// falls, it is NOT where the surveyed shoreline runs. Two artifacts follow: water showing inland
// of the wall ("flooding") and terrain poking through the lake surface outside it ("shelf").
//
// Neither artifact can be removed by moving grid heights around alone, so the fix is split:
//
//   1. The LAND SIDE IS NOT TOUCHED. An earlier version graded it down towards the water so the
//      grid's datum crossing would land on the surveyed line; it did, but a dug vertex drags the
//      interpolation with it for a full cell in every direction, which put a 20 m trench along
//      6 km of waterfront and made the apron that had to cover it 34 m wide almost everywhere.
//      The surveyed ground is the ground.
//   2. The LAKE BED is carved steeply and deep (SHORE_SLOPE, LAKE_DEPTH). Between a land vertex
//      at hl and a water vertex at -hw the crossing sits hl/(hl+hw) of the way across the cell,
//      so a deep bed pulls it hard toward the land vertex and the terrain can stand proud of the
//      lake by at most about cell*hl/(hl+LAKE_DEPTH) — a couple of metres, measured, not assumed.
//   3. The QUAY WALL covers what is left on the water side: its face is pushed out per station to
//      exactly where the grid last stands above the lake (WALL_PROUD..WALL_PROUD_MAX).
//   4. The QUAY APRON covers what is left on the land side: a real slab from the wall face inland
//      to exactly where the ground comes back up to quay level, ending in a bevel that crosses
//      the terrain at an angle instead of lying coplanar with it. Nothing is feathered.
//
// Verified by area sampling rather than by eye: 190,290 uniform samples inside the surveyed lake
// leave 1 above the lake plane and not inside the quay (0.0005%, worst 0.03 m), 58,543 samples on
// the land side within 70 m of the wall leave 0 showing water, and the apron hands back to the
// ground with a median step of 0.001 m and a worst of 0.30 m against a 0.45 m limit.
//
// So that a pedestrian walks on the quay rather than on the ground under it, carveHarbourTerrain()
// also WRAPS T.groundY with the deck field (quay apron, pier decks, and any walkway carried over
// the water). Every consumer in city.js — road ribbons, footways, prop seating, the player's feet
// — then agrees with what is drawn. The apron itself is laid at exactly ground level, the bottom
// rung of city.js's ground ladder, so the park, grass, path and plaza covers the survey puts on
// the waterfront all still draw over it and the promenade paving shows only where they do not.
//
// Public API
// ----------
//   buildHarbour(data, opts) -> H
//       opts: { extent, terrain, waterY }. Reads shore[] and waterfront[], chains the ways,
//       builds the water field and the shoreline stations. Pure: touches nothing.
//   carveHarbourTerrain(T, H) -> stats
//       Mutates T.h (the lake bed), drops T.ponds records that fall inside the surveyed lake,
//       sizes the quay wall and apron, decks the walkways that cross open water, and wraps
//       T.groundY with the deck field. Must be called BEFORE city.js reads T.groundY or emits
//       the terrain mesh.
//   harbourWaterAt(H, x, z) -> boolean          surveyed lake coverage, exact
//   harbourTileHasWater(H, x0, z0, x1, z1)      does an axis-aligned tile touch the lake
//   harbourDeckY(H, x, z) -> number             quay/pier deck ground level, -Infinity off deck
//   appendHarbour(H, ctx)                       all harbour geometry and furniture
//       ctx: { mb, data, claim(x, z, r) -> bool, note(kind) }
//   harbourStats(H) -> object                   permanent counters for the console audit
//
// Amendment 7 (time-of-day independence): geometry and material only. Water is not emissive, the
// quay is not emissive, no surface here is pre-darkened or pre-lit. The only emitters are the
// navigation lights and the lifebuoy-station lamps in props.js, which are real light sources.
//
// Amendment 8.4 (scaling): nothing is keyed to this bounding box. Extents come from meta, every
// index is a uniform grid, every pass is linear in feature count, and every random choice is
// hashed on WORLD POSITION so a tile looks the same whether or not its neighbours were loaded.

import { clamp, lerp, makeRng, TAU } from './math.js';
import {
  appendMooringBollard, appendQuayLadder, appendLifebuoyStation, appendQuayRailing,
  appendTimberBench, appendWaveRock, appendGangway, appendNavMarker, appendMooringBuoy,
  appendDolphin, appendPedestrianLamp, appendBoat,
  // THE ISLANDS AND THE AIRPORT (see the section at the foot of this file).
  appendCanopyTree, appendHedgeRun, appendFlowerBed, appendBeachGrass, appendPicnicTable,
  appendLifeguardChair, appendLighthouse, appendRunwayLight, appendApproachMast, appendWindsock,
  appendHangar, appendAirliner, appendLightPlane, appendChainFence, appendIslandFerry,
  appendRidePad, appendTimberRail, appendGableRoof, appendSlipway, appendFerryDock,
  appendShrub, appendBench, appendLitterBin, appendAirstairs, appendGSECart, appendAirfieldSign,
  appendTransitShelter,
} from './props.js';

/* =============================================================== tunables == */

const EPS = 1e-9;

const STATION = 5.0;            // shoreline resample step, metres
// The lake bed falls away from the surveyed line at this slope, to this depth. Both numbers are
// about the TERRAIN GRID, not about bathymetry: nothing under an opaque lake is ever seen. What
// they control is where the grid's own zero crossing lands. Between a land vertex at height hl and
// a water vertex at -hw the interpolated height crosses the datum at hl/(hl+hw) of the way across
// the cell, so a steep, deep bed pulls that crossing hard towards the land vertex and the terrain
// can never stand proud of the lake more than about cell*hl/(hl+LAKE_DEPTH) — a metre or three,
// which the quay wall then covers. The land side is left completely alone (see carveHarbourTerrain).
const SHORE_SLOPE = 0.9;
const LAKE_DEPTH = 14.0;
const DECK_SAMPLE = 22.0;       // how far inland the quay level is read off the surveyed terrain
const DECK_MIN = 0.95;          // quay ground is never closer than this to the water
const DECK_MAX = 7.0;
const APRON_MIN = 3.4;          // narrowest quay apron
const APRON_MAX = 34.0;         // widest — one terrain cell plus the shoreline blend band
const APRON_STEP = 1.5;

// Ground-plane heights, relative to the local quay GROUND level (what groundY returns).
//
// The apron sits at EXACTLY ground level — the bottom rung of city.js's ground ladder. That is
// deliberate: a third of the band the apron has to cover is park, grass or plaza in the extract,
// and every one of those covers is draped on groundY at its own rung (grass 0.022, park 0.098,
// path 0.174, kerbed walk 0.22). Laying the apron under all of them means the quay carries the
// real ground cover wherever the survey has one, and the promenade paving shows only where it
// does not. The coping is the exception: a raised granite edge band that has to win against
// everything, so it sits one rung above the highest of them.
const APRON_Y = 0.0;            // promenade paving == the quay ground
const COPE_TOP = 0.26;          // granite edge band, proud of every ground cover
const COPE_W = 0.72;
const PIER_LIFT = 0.03;         // a pier deck stands a hair above the apron it meets
const BOARD_LIFT = 0.38;        // timber boardwalk deck, genuinely raised above the paving
const TRAIL_LIFT = 0.30;        // asphalt recreational trail
const BEVEL = 2.4;              // the apron's inland edge ramps down over this...
const BEVEL_DROP = 0.10;        // ...and finishes BELOW the ground, so the two surfaces cross at
                                // an angle instead of lying coplanar and fighting for the depth
// How far the apron's inland edge may follow the ground down. On a spit or between two basins the
// grid has no land vertex to hold the ground up and reads well below quay level; the apron stops
// chasing it there, which leaves a step of at most EDGE_DROP_MAX + BEVEL_DROP against the 0.45 m
// walkable limit (CONTRACT §8.2) instead of a two-metre dive.
const EDGE_DROP_MAX = 0.25;
const WALL_PROUD = 0.55;        // the wall face stands at least this far out into the water...
const WALL_PROUD_MAX = 9.5;     // ...and as much as this, where the terrain grid needs covering
const WALL_FOOT = -4.6;
const FOULED_TOP = -0.16;       // below this the wall carries marine growth

const FENDER_SPACING = 9.0;
const BOLLARD_SPACING = 21.0;
const LADDER_SPACING = 58.0;
const LIFEBUOY_SPACING = 112.0;
const QUAY_LAMP_SPACING = 34.0;
const BENCH_SPACING = 62.0;

const PIER_W = 6.5;             // a linear pier way with no width in the data
const FINGER_W = 1.35;          // marina finger berth
const FINGER_MAX_LEN = 46.0;    // longer than this and a pier way is a fixed pier, not a float
const FLOAT_TOP = 0.42;         // floating dock deck above the water
const FLOAT_DRAFT = 0.30;
const PILE_SPACING = 7.5;
const MOUND_CELL = 2.0;         // rubble-mound raster
const MOUND_SLOPE = 4.2;        // horizontal run from toe to crest
const MOUND_CREST = 1.65;
const MOUND_TOE = -2.5;
const GROYNE_HW = 4.5;

const GRID_CELL = 32.0;         // shoreline segment index; segments are inserted inflated by
const GRID_REACH = APRON_MAX;   // GRID_REACH so a query only ever reads its own cell

// A slip or a boat basin cut into the quay is often mapped as its own water polygon rather than
// as part of the lake multipolygon. One that is big enough, close enough to the surveyed
// shoreline, and entirely outside it is harbour water: it gets carved, walled and filled like the
// rest, instead of being flattened into a pond slab sitting a metre and a half above the lake.
const BASIN_MIN_AREA = 250.0;
const BASIN_REACH = 45.0;

// Moored craft. The pre-expansion extract had two marinas in it; the map now carries seven, four
// of them island yacht clubs, and a global budget of 26 left whichever the extract happened to
// list last completely empty. The per-basin cap is what stops one big basin eating the lot.
const MAX_MOORED = 84;
const MAX_MOORED_BASIN = 14;
const MAX_ROCKS = 420;

/* ============================================================== materials == */
// [r, g, b, emissive, tintable, rough, profile]. Linear-ish scene albedo on the same low-key
// ground scale city.js uses. Profile 0 throughout: none of this has windows. Emissive 0
// throughout: none of this is a light source (the lamps live in props.js).

const M = {
  quayFace: [0.080, 0.081, 0.085, 0, 0, 0.88, 0],     // cast concrete quay wall, weathered
  quayFouled: [0.026, 0.030, 0.028, 0, 0, 0.94, 0],   // the band below the waterline, fouled
  coping: [0.094, 0.095, 0.100, 0, 0, 0.60, 0],       // granite coping stone
  promenade: [0.078, 0.080, 0.086, 0, 0, 0.76, 0],    // unit-paved promenade
  promEdge: [0.066, 0.067, 0.072, 0, 0, 0.80, 0],     // the apron's ramped inland edge
  trail: [0.029, 0.031, 0.036, 0, 0, 0.32, 0],        // Martin Goodman Trail asphalt
  boardwalk: [0.088, 0.063, 0.042, 0, 0, 0.88, 0],    // timber deck
  boardEdge: [0.058, 0.042, 0.029, 0, 0, 0.90, 0],    // joist and fascia board
  pierDeck: [0.070, 0.058, 0.047, 0, 0, 0.82, 0],     // pier decking
  pierFascia: [0.056, 0.047, 0.039, 0, 0, 0.86, 0],
  pile: [0.044, 0.033, 0.025, 0, 0, 0.92, 0],         // creosoted timber pile
  steelPile: [0.072, 0.074, 0.079, 0, 0, 0.34, 0],    // sheet-pile / tubular steel
  floatDeck: [0.100, 0.102, 0.107, 0, 0, 0.74, 0],
  floatBody: [0.062, 0.064, 0.068, 0, 0, 0.80, 0],
  rubble: [0.064, 0.063, 0.060, 0, 0, 0.94, 0],       // rubble-mound armour
  rubbleWet: [0.030, 0.031, 0.030, 0, 0, 0.88, 0],    // the mound below the waterline
  retain: [0.074, 0.075, 0.079, 0, 0, 0.90, 0],       // retaining wall
  fender: [0.046, 0.034, 0.025, 0, 0, 0.90, 0],       // fender timber
  terminal: [0.086, 0.088, 0.093, 0, 0, 0.72, 0],     // ferry terminal apron
};

/* ================================================================ scratch == */

const _q = new Float64Array(12);      // one quad, four (x, y, z) corners

/* ============================================================== utilities == */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Deterministic [0, 1) from a world position. CONTRACT §8.4: never hash an array index.
function hash01(x, z) {
  const a = Math.imul((((x * 32) | 0) ^ 0x27d4eb2d) | 0, 0x9e3779b1);
  const b = Math.imul((((z * 32) | 0) ^ 0x165667b1) | 0, 0x85ebca6b);
  let h = (a ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

// An rng seeded on WORLD POSITION (CONTRACT §8.4). A moored boat is the same boat whatever order
// the marinas were built in, and stays the same boat when the city is tiled.
function rngAt(x, z) {
  return makeRng((hash01(x, z) * 4294967296) >>> 0);
}

function setMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m[6]);
}

// A horizontal triangle, always wound so the normal comes out +Y. Returns 1 if it was flipped to
// get there, which is how the ribbon fold counter is fed.
function triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
  // Plan-space signed area with v = -z: positive means the given order already faces up.
  const area = (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
  if (area > EPS) {
    mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
    return 0;
  }
  if (area < -EPS) {
    mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
    return 1;
  }
  return 0;
}

function quadUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const f0 = triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz);
  const f1 = triUp(mb, ax, ay, az, cx, cy, cz, dx, dy, dz);
  // Both halves wound the same way means the quad is simply convex the other way round, which
  // triUp has already fixed. One of each means the quad is folded: the ribbon crossed itself.
  return f0 === f1 ? 0 : 1;
}

// A quad emitted so its face points along (ox, oy, oz). Corners in either rotational order.
function quadOut(mb, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, ox, oy, oz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * ox + ny * oy + nz * oz >= 0) {
    mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
    mb.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
  } else {
    mb.tri(ax, ay, az, dx, dy, dz, cx, cy, cz);
    mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
  }
}

// An upright box given by its plan rectangle and two heights: four sides plus a cap, no
// underside. Used for fender timbers and kerb blocks, where the underside is never seen.
function boxTop(mb, cx, cz, hx, hz, y0, y1, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const lx = [-hx, hx, hx, -hx];
  const lz = [-hz, -hz, hz, hz];
  for (let i = 0; i < 4; i++) {
    _q[i * 3] = cx + lx[i] * c + lz[i] * s;
    _q[i * 3 + 2] = cz - lx[i] * s + lz[i] * c;
  }
  for (let e = 0; e < 4; e++) {
    const a = e * 3, b = ((e + 1) % 4) * 3;
    const mx = (_q[a] + _q[b]) * 0.5 - cx, mz = (_q[a + 2] + _q[b + 2]) * 0.5 - cz;
    quadOut(mb, _q[a], y0, _q[a + 2], _q[b], y0, _q[b + 2],
      _q[b], y1, _q[b + 2], _q[a], y1, _q[a + 2], mx, 0, mz);
  }
  quadUp(mb, _q[0], y1, _q[2], _q[3], y1, _q[5], _q[6], y1, _q[8], _q[9], y1, _q[11]);
}

function polyLength(p) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

// Signed area in PLAN space (u = x, v = -z), so positive means counter-clockwise on paper.
function planArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += p[j][0] * (-p[i][1]) - p[i][0] * (-p[j][1]);
  }
  return a * 0.5;
}

function isClosed(p) {
  const n = p.length;
  return n > 3 && Math.abs(p[0][0] - p[n - 1][0]) < 0.05 && Math.abs(p[0][1] - p[n - 1][1]) < 0.05;
}

function pointInRing(p, x, z) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const zi = p[i][1], zj = p[j][1];
    if ((zi > z) === (zj > z)) continue;
    const t = (z - zi) / (zj - zi);
    if (x < p[i][0] + (p[j][0] - p[i][0]) * t) inside = !inside;
  }
  return inside;
}

function distToSeg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > EPS) t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
  const qx = ax + dx * t, qz = az + dz * t;
  return Math.hypot(x - qx, z - qz);
}

function distToPoly(x, z, p) {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const d = distToSeg(x, z, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    if (d < best) best = d;
  }
  return best;
}

function bboxOf(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i++) {
    if (p[i][0] < x0) x0 = p[i][0];
    if (p[i][0] > x1) x1 = p[i][0];
    if (p[i][1] < z0) z0 = p[i][1];
    if (p[i][1] > z1) z1 = p[i][1];
  }
  return [x0, z0, x1, z1];
}

function centroidOf(p) {
  let x = 0, z = 0;
  for (let i = 0; i < p.length; i++) { x += p[i][0]; z += p[i][1]; }
  return [x / p.length, z / p.length];
}

function resample(p, step) {
  const out = [[p[0][0], p[0][1]]];
  for (let i = 1; i < p.length; i++) {
    const ax = p[i - 1][0], az = p[i - 1][1], bx = p[i][0], bz = p[i][1];
    const len = Math.hypot(bx - ax, bz - az);
    if (!(len > EPS)) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  return out;
}

// Ear clipping for a simple ring, no holes. Returns a flat index triple list; drops slivers
// instead of hanging on a degenerate ring.
function earClip(p) {
  const n = p.length;
  const out = [];
  if (n < 3) return out;
  const idx = [];
  const ccw = planArea(p) > 0;
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  let guard = idx.length * idx.length + 32;
  while (idx.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const ax = p[a][0], av = -p[a][1], bx = p[b][0], bv = -p[b][1], cx = p[c][0], cv = -p[c][1];
      const cross = (bx - ax) * (cv - av) - (cx - ax) * (bv - av);
      if (cross <= EPS) continue;
      let ok = true;
      for (let k = 0; k < idx.length && ok; k++) {
        const q = idx[k];
        if (q === a || q === b || q === c) continue;
        const qx = p[q][0], qv = -p[q][1];
        const d1 = (bx - ax) * (qv - av) - (qx - ax) * (bv - av);
        const d2 = (cx - bx) * (qv - bv) - (qx - bx) * (cv - bv);
        const d3 = (ax - cx) * (qv - cv) - (qx - cx) * (av - cv);
        if (d1 >= 0 && d2 >= 0 && d3 >= 0) ok = false;
      }
      if (!ok) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/* ========================================================== shore assembly == */

// Join ways that share an endpoint into the longest chains available. The OSM multipolygon
// arrives split into ways in no particular order; the full-city extract will have more of them.
function chainWays(ways) {
  const key = (p) => p[0].toFixed(2) + '|' + p[1].toFixed(2);
  const pool = [];
  for (let i = 0; i < ways.length; i++) {
    const p = ways[i] && ways[i].p;
    if (Array.isArray(p) && p.length >= 2) pool.push(p.slice());
  }
  const used = new Uint8Array(pool.length);
  const chains = [];
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let ch = pool[i];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < pool.length; j++) {
        if (used[j]) continue;
        const q = pool[j];
        if (key(q[0]) === key(ch[ch.length - 1])) {
          ch = ch.concat(q.slice(1)); used[j] = 1; grew = true;
        } else if (key(q[q.length - 1]) === key(ch[0])) {
          ch = q.slice(0, -1).concat(ch); used[j] = 1; grew = true;
        } else if (key(q[q.length - 1]) === key(ch[ch.length - 1])) {
          const r = q.slice(0, -1).reverse();
          ch = ch.concat(r); used[j] = 1; grew = true;
        } else if (key(q[0]) === key(ch[0])) {
          const r = q.slice(1).reverse();
          ch = r.concat(ch); used[j] = 1; grew = true;
        }
      }
    }
    chains.push(ch);
  }
  return chains;
}

/**
 * The water field. A vertical ray cast NORTH from any point inside the extract crosses the outer
 * shoreline an odd number of times if and only if the point is in the lake: the outer chain spans
 * the whole east-west range of the extract and everything north of it is land, so the chain alone
 * closes the lake for every ray that matters. Island rings (role "inner") are closed loops and
 * flip the parity back to land in the ordinary even-odd way. Segments are bucketed by column so a
 * query only walks the handful that can cross its ray.
 */
function makeWaterField(outerChains, innerChains, basinRings) {
  const segs = [];
  const add = (p, closeIt) => {
    for (let i = 1; i < p.length; i++) segs.push(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    if (closeIt) {
      const a = p[p.length - 1], b = p[0];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) segs.push(a[0], a[1], b[0], b[1]);
    }
  };
  for (let i = 0; i < outerChains.length; i++) add(outerChains[i], false);
  for (let i = 0; i < innerChains.length; i++) add(innerChains[i], true);
  if (basinRings) for (let i = 0; i < basinRings.length; i++) add(basinRings[i], true);

  let x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < segs.length; i += 4) {
    x0 = Math.min(x0, segs[i], segs[i + 2]);
    x1 = Math.max(x1, segs[i], segs[i + 2]);
  }
  if (!isFinite(x0)) { x0 = 0; x1 = 1; }
  const colW = 48;
  const nCol = Math.max(1, Math.ceil((x1 - x0) / colW) + 1);
  const cols = new Array(nCol);
  for (let i = 0; i < nCol; i++) cols[i] = [];
  for (let i = 0; i < segs.length; i += 4) {
    const lo = Math.min(segs[i], segs[i + 2]), hi = Math.max(segs[i], segs[i + 2]);
    const c0 = clamp(Math.floor((lo - x0) / colW), 0, nCol - 1);
    const c1 = clamp(Math.floor((hi - x0) / colW), 0, nCol - 1);
    for (let c = c0; c <= c1; c++) cols[c].push(i);
  }
  return { segs, cols, x0, colW, nCol, minX: x0, maxX: x1 };
}

function waterAt(F, x, z) {
  if (!isNum(x) || !isNum(z) || x <= F.minX || x >= F.maxX) return false;
  const col = F.cols[clamp(Math.floor((x - F.x0) / F.colW), 0, F.nCol - 1)];
  const s = F.segs;
  let n = 0;
  for (let k = 0; k < col.length; k++) {
    const i = col[k];
    const ax = s[i], az = s[i + 1], bx = s[i + 2], bz = s[i + 3];
    if ((ax > x) === (bx > x)) continue;
    if (az + (bz - az) * ((x - ax) / (bx - ax)) < z) n++;
  }
  return (n & 1) === 1;
}

// Water polygons that are really part of the harbour: big enough to be a basin, close enough to
// the surveyed shoreline to be cut into it, and entirely outside it so that adding them to the
// parity field cannot cancel the lake the field already covers.
function findBasins(data, field, chains, rect) {
  const areas = Array.isArray(data && data.areas) ? data.areas : [];
  const out = [];
  for (let a = 0; a < areas.length; a++) {
    const rec = areas[a];
    if (!rec || rec.k !== 'water' || !Array.isArray(rec.p) || rec.p.length < 4) continue;
    if (Math.abs(planArea(rec.p)) < BASIN_MIN_AREA) continue;
    const bb = bboxOf(rec.p);
    if (bb[2] < rect[0] || bb[0] > rect[2] || bb[3] < rect[1] || bb[1] > rect[3]) continue;
    let clear = true;
    for (let i = 0; i < rec.p.length && clear; i++) {
      if (waterAt(field, rec.p[i][0], rec.p[i][1])) clear = false;
    }
    if (!clear) continue;
    let near = Infinity;
    for (let c = 0; c < chains.length; c++) {
      const ch = chains[c];
      for (let i = 1; i < ch.length; i++) {
        if (Math.min(ch[i - 1][0], ch[i][0]) > bb[2] + BASIN_REACH) continue;
        if (Math.max(ch[i - 1][0], ch[i][0]) < bb[0] - BASIN_REACH) continue;
        if (Math.min(ch[i - 1][1], ch[i][1]) > bb[3] + BASIN_REACH) continue;
        if (Math.max(ch[i - 1][1], ch[i][1]) < bb[1] - BASIN_REACH) continue;
        for (let k = 0; k < rec.p.length; k++) {
          const d = distToSeg(rec.p[k][0], rec.p[k][1],
            ch[i - 1][0], ch[i - 1][1], ch[i][0], ch[i][1]);
          if (d < near) near = d;
        }
      }
    }
    if (near > BASIN_REACH) continue;
    const ring = rec.p.slice();
    const f = ring[0], l = ring[ring.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 0.05) ring.push([f[0], f[1]]);
    out.push(ring);
  }
  return out;
}

/* ============================================ shoreline stations and index == */

// One run of quay: a resampled piece of shoreline inside the working rect, with an outward
// (water-side) normal, a mitre offset, the quay ground level and the apron width at every station.
function buildRuns(chains, rect, F) {
  const runs = [];
  const inRect = (p) => p[0] >= rect[0] && p[0] <= rect[2] && p[1] >= rect[1] && p[1] <= rect[3];
  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c];
    let cur = [];
    for (let i = 0; i < ch.length; i++) {
      if (inRect(ch[i])) {
        // Keep one vertex beyond each end so the wall reaches the rect edge instead of stopping
        // short of it.
        if (!cur.length && i > 0) cur.push(ch[i - 1]);
        cur.push(ch[i]);
      } else if (cur.length) {
        cur.push(ch[i]);
        if (polyLength(cur) > STATION * 2) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1 && polyLength(cur) > STATION * 2) runs.push(cur);
  }

  const out = [];
  for (let r = 0; r < runs.length; r++) {
    const pts = resample(runs[r], STATION);
    const n = pts.length;
    if (n < 3) continue;
    const run = {
      x: new Float64Array(n), z: new Float64Array(n),
      nx: new Float64Array(n), nz: new Float64Array(n),
      mx: new Float64Array(n), mz: new Float64Array(n),
      g: new Float64Array(n), w: new Float64Array(n), e: new Float64Array(n),
      pr: new Float64Array(n), met: new Float64Array(n), s: new Float64Array(n),
      n,
    };
    for (let i = 0; i < n; i++) { run.x[i] = pts[i][0]; run.z[i] = pts[i][1]; }

    // Segment normals, then per-station mitres.
    const sx = new Float64Array(n), sz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
      let tx = run.x[b] - run.x[a], tz = run.z[b] - run.z[a];
      const l = Math.hypot(tx, tz);
      if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
      sx[i] = tx; sz[i] = tz;
      run.nx[i] = -tz; run.nz[i] = tx;
    }
    // Which side is the lake? One vote per sampled station; a chain has a single orientation, so
    // the majority is the answer and a single ambiguous station cannot flip a run.
    let vote = 0;
    const stride = Math.max(1, Math.floor(n / 64));
    for (let i = 0; i < n; i += stride) {
      const px = run.x[i] + run.nx[i] * 4.0, pz = run.z[i] + run.nz[i] * 4.0;
      const qx = run.x[i] - run.nx[i] * 4.0, qz = run.z[i] - run.nz[i] * 4.0;
      const a = waterAt(F, px, pz), b = waterAt(F, qx, qz);
      if (a && !b) vote++;
      else if (b && !a) vote--;
    }
    if (vote < 0) {
      for (let i = 0; i < n; i++) { run.nx[i] = -run.nx[i]; run.nz[i] = -run.nz[i]; }
    }
    if (vote === 0) continue;                   // a run with no water on either side is not quay

    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
      let ax = -sz[a], az = sx[a], bx = -sz[b], bz = sx[b];
      if (vote < 0) { ax = -ax; az = -az; bx = -bx; bz = -bz; }
      let mx = ax + bx, mz = az + bz;
      const l2 = mx * mx + mz * mz;
      if (l2 > 1e-6) {
        mx = mx * 2 / l2; mz = mz * 2 / l2;
        const ml = Math.hypot(mx, mz);
        if (ml > 2.5) { mx = mx * 2.5 / ml; mz = mz * 2.5 / ml; }
      } else { mx = run.nx[i]; mz = run.nz[i]; }
      run.mx[i] = mx; run.mz[i] = mz;
      run.s[i] = i > 0 ? run.s[i - 1] + Math.hypot(run.x[i] - run.x[i - 1], run.z[i] - run.z[i - 1]) : 0;
    }
    out.push(run);
  }
  return out;
}

// Uniform grid over the station segments. Every segment is inserted into each cell its bbox
// touches once inflated by GRID_REACH, so a lookup within GRID_REACH reads exactly one cell.
function makeShoreIndex(runs, rect) {
  const x0 = rect[0] - GRID_REACH * 2, z0 = rect[1] - GRID_REACH * 2;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + GRID_REACH * 4) / GRID_CELL));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + GRID_REACH * 4) / GRID_CELL));
  const cells = new Array(nx * nz);
  let count = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    for (let i = 0; i + 1 < run.n; i++) {
      const ax = run.x[i], az = run.z[i], bx = run.x[i + 1], bz = run.z[i + 1];
      const i0 = clamp(Math.floor((Math.min(ax, bx) - GRID_REACH - x0) / GRID_CELL), 0, nx - 1);
      const i1 = clamp(Math.floor((Math.max(ax, bx) + GRID_REACH - x0) / GRID_CELL), 0, nx - 1);
      const j0 = clamp(Math.floor((Math.min(az, bz) - GRID_REACH - z0) / GRID_CELL), 0, nz - 1);
      const j1 = clamp(Math.floor((Math.max(az, bz) + GRID_REACH - z0) / GRID_CELL), 0, nz - 1);
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const c = j * nx + k;
          if (!cells[c]) cells[c] = [];
          cells[c].push(r, i);
          count++;
        }
      }
    }
  }
  return { x0, z0, nx, nz, cells, count };
}

const _hit = { d: Infinity, run: null, i: 0, t: 0, qx: 0, qz: 0, side: 0 };

// Nearest point on the shoreline within GRID_REACH. Fills and returns the module-scope _hit, or
// null. `side` is the signed inland distance: positive on land, negative out over the water.
function nearestShore(H, x, z) {
  const G = H.index;
  if (!isNum(x) || !isNum(z)) return null;
  const ci = Math.floor((x - G.x0) / GRID_CELL);
  const cj = Math.floor((z - G.z0) / GRID_CELL);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return null;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return null;
  let best = Infinity, bRun = null, bI = 0, bT = 0, bx = 0, bz = 0;
  for (let k = 0; k < list.length; k += 2) {
    const run = H.runs[list[k]], i = list[k + 1];
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[i + 1] - ax, dz = run.z[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * t, qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; bRun = run; bI = i; bT = t; bx = qx; bz = qz; }
  }
  if (!bRun || best > GRID_REACH) return null;
  const nx = lerp(bRun.nx[bI], bRun.nx[bI + 1], bT);
  const nz = lerp(bRun.nz[bI], bRun.nz[bI + 1], bT);
  const nl = Math.hypot(nx, nz);
  const ux = nl > EPS ? nx / nl : 1, uz = nl > EPS ? nz / nl : 0;
  _hit.d = best; _hit.run = bRun; _hit.i = bI; _hit.t = bT; _hit.qx = bx; _hit.qz = bz;
  _hit.side = -((x - bx) * ux + (z - bz) * uz);
  return _hit;
}

/* ============================================================ deck records == */

// A deck polygon (pier, terminal apron) the player can stand on. Indexed by bbox in a coarse grid.
function makeDeckIndex(polys, rect) {
  const cell = 48;
  const x0 = rect[0] - 64, z0 = rect[1] - 64;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + 128) / cell));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + 128) / cell));
  const cells = new Array(nx * nz);
  for (let p = 0; p < polys.length; p++) {
    const bb = polys[p].bbox;
    const i0 = clamp(Math.floor((bb[0] - x0) / cell), 0, nx - 1);
    const i1 = clamp(Math.floor((bb[2] - x0) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((bb[1] - z0) / cell), 0, nz - 1);
    const j1 = clamp(Math.floor((bb[3] - z0) / cell), 0, nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (!cells[c]) cells[c] = [];
        cells[c].push(p);
      }
    }
  }
  return { cell, x0, z0, nx, nz, cells, polys };
}

function deckPolyAt(D, x, z) {
  if (!D || !isNum(x) || !isNum(z)) return -Infinity;
  const i = Math.floor((x - D.x0) / D.cell), j = Math.floor((z - D.z0) / D.cell);
  if (i < 0 || i >= D.nx || j < 0 || j >= D.nz) return -Infinity;
  const list = D.cells[j * D.nx + i];
  if (!list) return -Infinity;
  let y = -Infinity;
  for (let k = 0; k < list.length; k++) {
    const p = D.polys[list[k]];
    if (x < p.bbox[0] || x > p.bbox[2] || z < p.bbox[1] || z > p.bbox[3]) continue;
    if (pointInRing(p.ring, x, z) && p.y > y) y = p.y;
  }
  return y;
}

/* ================================================================= build == */

/**
 * Read the surveyed harbourfront out of the extract. Pure — no geometry, no mutation.
 *
 * @param {object} data  parsed data/toronto.json
 * @param {object} opts  { extent: {x, z}, terrain: T, waterY: number }
 * @returns {object|null} the harbour model, or null when the extract carries no shoreline
 */
export function buildHarbour(data, opts) {
  const o = opts || {};
  const extent = o.extent || { x: 1000, z: 1000 };
  const T = o.terrain;
  const waterY = isNum(o.waterY) ? o.waterY : 0;
  const shore = Array.isArray(data && data.shore) ? data.shore : [];
  const front = Array.isArray(data && data.waterfront) ? data.waterfront : [];
  if (!shore.length || !T) return null;

  // The quay is built only where there is ground to build it on: the terrain grid covers exactly
  // the extent, so the runs are clipped to it plus a short margin that lets the wall reach the
  // edge of the mapped world instead of stopping short of it. The water field itself is NOT
  // clipped — the parity test needs the whole chain, which runs far past the extract.
  const hx = extent.x / 2, hz = extent.z / 2;
  const margin = 30;
  const rect = [-hx - margin, -hz - margin, hx + margin, hz + margin];

  const outer = chainWays(shore.filter((s) => s && s.role !== 'inner'));
  const inner = chainWays(shore.filter((s) => s && s.role === 'inner'));
  const basins = findBasins(data, makeWaterField(outer, inner, null), outer, rect);
  const field = makeWaterField(outer, inner, basins);
  const runs = buildRuns(outer.concat(basins), rect, field);

  const H = {
    rect, extent, waterY, field, runs,
    index: makeShoreIndex(runs, rect),
    terrain: T,
    roads: Array.isArray(data && data.roads) ? data.roads : [],
    crossings: [],
    decks: null,
    piers: [], fingers: [], mounds: [], marinas: [], walls: [], terminals: [],
    stats: {
      shoreMetres: 0, runs: runs.length, quayStations: 0, apronMinW: Infinity, apronMaxW: 0,
      piers: 0, fingers: 0, mounds: 0, marinas: 0, walls: 0, terminals: 0,
      basins: basins.length, inlandWallsSkipped: 0, folds: 0,
      lakeCells: 0, pondsDropped: 0, crossings: 0,
    },
  };
  for (let r = 0; r < runs.length; r++) {
    H.stats.quayStations += runs[r].n;
    H.stats.shoreMetres += runs[r].s[runs[r].n - 1];
  }

  // Quay ground level per station, read off the SURVEYED terrain a little inland (over the water
  // the terrain is meaningless — it was interpolated from building elevations that do not exist
  // out there), then smoothed along the run so the coping is a line and not a staircase.
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    for (let i = 0; i < run.n; i++) {
      const px = run.x[i] - run.nx[i] * DECK_SAMPLE, pz = run.z[i] - run.nz[i] * DECK_SAMPLE;
      run.g[i] = clamp(sampleTerrain(T, px, pz), waterY + DECK_MIN, waterY + DECK_MAX);
    }
    smoothRun(run.g, run.n, 3, 2);
  }

  // Engineered structures. Anything the extract tags as a waterfront edge but that sits well
  // inland is somebody else's wall — the rail corridor and the expressway are full of them — and
  // is left alone rather than dressed up as a quay.
  for (let i = 0; i < front.length; i++) {
    const w = front[i];
    if (!w || !Array.isArray(w.p) || w.p.length < 2) continue;
    const bb = bboxOf(w.p);
    if (bb[2] < rect[0] || bb[0] > rect[2] || bb[3] < rect[1] || bb[1] > rect[3]) continue;
    const closed = isClosed(w.p);
    const len = polyLength(w.p);
    const area = closed ? Math.abs(planArea(w.p)) : 0;
    const cen = centroidOf(w.p);
    const rec = { k: w.k, n: w.n || '', p: w.p, closed, len, area, bbox: bb, cen };
    if (w.k === 'pier') {
      if (!closed && len <= FINGER_MAX_LEN) H.fingers.push(rec);
      else H.piers.push(rec);
    } else if (w.k === 'breakwater' || w.k === 'groyne') {
      H.mounds.push(rec);
    } else if (w.k === 'marina') {
      H.marinas.push(rec);
    } else if (w.k === 'ferry_terminal') {
      H.terminals.push(rec);
    } else if (w.k === 'quay' || w.k === 'retaining_wall') {
      // Waterside only: within a stone's throw of the surveyed lake.
      let near = false;
      for (let k = 0; k < w.p.length && !near; k++) {
        const h = nearestShore(H, w.p[k][0], w.p[k][1]);
        if (h && h.d < 26) near = true;
        if (waterAt(field, w.p[k][0], w.p[k][1])) near = true;
      }
      if (near) H.walls.push(rec); else H.stats.inlandWallsSkipped++;
    }
  }

  // The ferry terminal. The extract tags the island-side dock; the city-side slips at the foot of
  // Bay Street are named on the ROADS that serve them, so the anchor is taken from there and
  // pinned to the surveyed shoreline. Both routes end in the same builder.
  const anchors = [];
  const roads = Array.isArray(data && data.roads) ? data.roads : [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || typeof r.n !== 'string' || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (!/ferry\s*dock|ferry\s*terminal/i.test(r.n)) continue;
    const c = centroidOf(r.p);
    if (c[0] < rect[0] || c[0] > rect[2] || c[1] < rect[1] || c[1] > rect[3]) continue;
    anchors.push(c);
  }
  if (anchors.length) {
    let cx = 0, cz = 0;
    for (let i = 0; i < anchors.length; i++) { cx += anchors[i][0]; cz += anchors[i][1]; }
    cx /= anchors.length; cz /= anchors.length;
    // Walk south (the lake side) until the shoreline is within reach, so the terminal lands on
    // the quay rather than at the road's own centroid.
    let found = null;
    for (let t = 0; t <= 320 && !found; t += 8) {
      const h = nearestShore(H, cx, cz + t);
      if (h && h.d < GRID_REACH * 0.9) found = { x: h.qx, z: h.qz, run: h.run, i: h.i, t: h.t };
    }
    if (found) H.terminals.push({ k: 'ferry_terminal', n: 'Ferry Terminal', anchor: found, p: null });
  }

  // THE ISLANDS. Everything south of the harbour: the surveyed island rings, their edge
  // treatment, Billy Bishop and the ferry routes. Pure, like the rest of buildHarbour.
  H.isle = buildIslands(H, data, inner);
  H.stats.isle = H.isle.stats;

  H.stats.piers = H.piers.length;
  H.stats.fingers = H.fingers.length;
  H.stats.mounds = H.mounds.length;
  H.stats.marinas = H.marinas.length;
  H.stats.walls = H.walls.length;
  H.stats.terminals = H.terminals.length;
  return H;
}

function smoothRun(a, n, half, passes) {
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let acc = 0, w = 0;
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        acc += a[j]; w++;
      }
      tmp[i] = w > 0 ? acc / w : a[i];
    }
    a.set(tmp);
  }
}

function sampleTerrain(T, x, z) {
  const { nx, nz, cell, x0, z0, h } = T;
  let fx = (x - x0) / cell, fz = (z - z0) / cell;
  if (!isFinite(fx) || !isFinite(fz)) return 0;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
  if (j < 0) j = 0; else if (j > nz - 2) j = nz - 2;
  const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
  const a = h[j * nx + i], b = h[j * nx + i + 1];
  const c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/* ================================================================= carve == */

/**
 * Bring the terrain down to the surveyed water, size the quay apron, and wrap groundY with the
 * deck field. Mutates T. Call once, immediately after makeTerrain() and before anything reads
 * T.groundY or emits the terrain mesh.
 */
export function carveHarbourTerrain(T, H) {
  if (!H || !T) return null;
  const { nx, nz, cell, x0, z0, h } = T;
  const waterY = H.waterY;
  const S = H.stats;

  // --- 1. the lake bed, and NOTHING on the land side --------------------------------------------
  // Which side a vertex is on is decided by the surveyed polygon, never by a local normal: at a
  // slip mouth the nearest segment can face the wrong way. Land vertices are left exactly as
  // surveyed — an earlier version graded them down towards the water, which is what a beach does
  // and what an engineered quay never does, and it dragged a trench a full grid cell inland
  // because the grid interpolates linearly out of every vertex it touches. The lake bed alone is
  // carved, steeply, which pins the grid's datum crossing to within a couple of metres of the
  // surveyed line; the quay wall covers what is left.
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const k = j * nx + i;
      if (!waterAt(H.field, x, z)) continue;
      const hit = nearestShore(H, x, z);
      let d = hit ? hit.d : LAKE_DEPTH / SHORE_SLOPE;
      // THE ISLANDS: an island shore is a shore. Without this the bed beside Ward's Island is
      // carved from its distance to the MAINLAND, comes out at the full LAKE_DEPTH, and the
      // grid's datum crossing lands metres inside the surveyed island.
      const isl = nearIsleStation(H.isle, x, z, ISLE_REACH);
      if (isl && isl.d < d) d = isl.d;
      h[k] = waterY - clamp(d * SHORE_SLOPE, 0.12, LAKE_DEPTH);
      S.lakeCells++;
    }
  }

  // --- 2. inland ponds that fall inside the surveyed lake are not ponds ------------------------
  if (Array.isArray(T.ponds) && T.ponds.length) {
    const keep = [];
    for (let p = 0; p < T.ponds.length; p++) {
      const co = T.ponds[p].co;
      let cx = 0, cv = 0, n = 0;
      for (let i = 0; i + 1 < co.length; i += 2) { cx += co[i]; cv += co[i + 1]; n++; }
      if (n && waterAt(H.field, cx / n, -(cv / n))) { S.pondsDropped++; continue; }
      keep.push(T.ponds[p]);
    }
    T.ponds = keep;
  }

  // --- 3. apron width: out to exactly where the ground comes back up to quay level -------------
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i < run.n; i++) {
      const g = run.g[i];
      // Seaward first: how far out does the grid still stand above the lake? That much of the
      // lake has to be inside the wall, so the wall face goes there.
      let pr = WALL_PROUD;
      for (let t = WALL_PROUD; t <= WALL_PROUD_MAX; t += 0.25) {
        const px = run.x[i] + run.nx[i] * t, pz = run.z[i] + run.nz[i] * t;
        // Stop at the far shore: across a slip or a narrow channel the ray runs back onto land,
        // and that land is the other quay's business, not an excuse to widen this wall.
        if (!waterAt(H.field, px, pz)) break;
        if (sampleTerrain(T, px, pz) > waterY - 0.05) pr = t + 0.35;
      }
      run.pr[i] = clamp(pr, WALL_PROUD, WALL_PROUD_MAX);
      // Then inland: the apron runs to exactly where the ground comes back up to quay level, or
      // to the middle of the strip when the far side is another water body — a slip, a basin, or
      // the far side of a breakwater. In that case it stops FLAT rather than ramping down, since
      // what it meets there is the other side's apron and not ground.
      let w = APRON_MAX;
      let met = false;
      for (let t = APRON_MIN; t <= APRON_MAX; t += APRON_STEP) {
        const px = run.x[i] - run.nx[i] * t, pz = run.z[i] - run.nz[i] * t;
        if (waterAt(H.field, px, pz)) { w = Math.max(APRON_MIN, t * 0.5); met = true; break; }
        if (sampleTerrain(T, px, pz) >= g - 0.04) { w = t; break; }
      }
      run.w[i] = clamp(w, APRON_MIN, APRON_MAX);
      run.met[i] = met ? 1 : 0;
    }
    dilateRun(run.pr, run.n, 2);
    smoothRun(run.pr, run.n, 1, 1);
    // Dilate before smoothing: a station may never end up NARROWER than its neighbours need,
    // because that is exactly where a hole would open between the apron and the ground.
    dilateRun(run.w, run.n, 2);
    smoothRun(run.w, run.n, 1, 1);
    // The inland edge is NOT relaxed out of the folds it makes at tight corners. Trading width
    // for a clean ribbon there was measured at 9 fewer folded quads and a 2.5 m step where the
    // shortened apron stopped over ground that is still below the lake: an overlap of two
    // identical slabs a few centimetres apart is much cheaper than a hole in the waterline.
    for (let i = 0; i < run.n; i++) {
      // Where the apron hands back to the ground, it hands back to the ground that is ACTUALLY
      // there, so the two surfaces cross instead of stepping. The floor under that is the lake
      // itself: on a spit or a breakwater narrower than a terrain cell the grid has no land
      // vertex to interpolate from and reads below the datum, and there the apron IS the ground.
      const ex = run.x[i] - run.nx[i] * run.w[i], ez = run.z[i] - run.nz[i] * run.w[i];
      run.e[i] = run.met[i] ? run.g[i] : clamp(sampleTerrain(T, ex, ez),
        Math.max(H.waterY + 0.22, run.g[i] - EDGE_DROP_MAX), run.g[i]);
      S.apronMinW = Math.min(S.apronMinW, run.w[i]);
      S.apronMaxW = Math.max(S.apronMaxW, run.w[i]);
    }
    smoothRun(run.e, run.n, 1, 1);
  }

  // --- 3b. the islands: the airfield is graded flat and the shore mantle finds its bank ---------
  carveIslands(T, H, H.isle);

  // --- 4. deck polygons (piers, terminal aprons, and walkways over the water) -------------------
  H.decks = makeDeckIndex(collectDeckPolys(H).concat(collectCrossings(H, T)), H.rect);

  // --- 5. groundY now answers with the quay ---------------------------------------------------
  const base = T.groundY;
  T.groundY = (x, z) => {
    const g = base(x, z);
    const d = harbourDeckY(H, x, z);
    return d > g ? d : g;
  };
  H.baseGroundY = base;
  return S;
}

function dilateRun(a, n, half) {
  const tmp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = a[i];
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      if (a[j] > m) m = a[j];
    }
    tmp[i] = m;
  }
  a.set(tmp);
}

// Pier decks and terminal aprons, as plan rings with a deck level. Built once, used by the deck
// field and by the geometry pass so both always agree.
function collectDeckPolys(H) {
  const out = [];
  for (let i = 0; i < H.piers.length; i++) {
    const rec = H.piers[i];
    const ring = rec.closed ? rec.p.slice(0, rec.p.length - 1) : ribbonRing(rec.p, PIER_W * 0.5);
    if (!ring || ring.length < 3) continue;
    rec.ring = ring;
    rec.g = quayLevelNear(H, rec.cen[0], rec.cen[1]);
    rec.y = rec.g + PIER_LIFT;
    out.push({ ring, bbox: bboxOf(ring), y: rec.g });
  }
  for (let i = 0; i < H.terminals.length; i++) {
    const rec = H.terminals[i];
    if (!rec.p) continue;
    const ring = rec.closed ? rec.p.slice(0, rec.p.length - 1) : ribbonRing(rec.p, 9);
    if (!ring || ring.length < 3) continue;
    rec.ring = ring;
    rec.g = quayLevelNear(H, rec.cen[0], rec.cen[1]);
    rec.y = rec.g + PIER_LIFT;
    out.push({ ring, bbox: bboxOf(ring), y: rec.g });
  }
  return out;
}

/**
 * Every walkable way that crosses the surveyed lake gets a ground to cross it on, carried at the
 * level of its own two banks. Without this the ribbon drapes into the slip it is bridging and the
 * pedestrian walks down the lake bed — the exact failure the shoreline survey introduces, because
 * the guessed shoreline used to call these slips dry land.
 *
 * The GROUND is fixed for every crossing, bridge or not. Visible deck geometry is emitted only
 * where the extract does NOT tag a bridge: a tagged bridge is the street pass's to build, with
 * its own abutments and piers, and two decks over one slip is worse than none.
 */
function collectCrossings(H, T) {
  const out = [];
  const roads = Array.isArray(H.roads) ? H.roads : [];
  const STEP = 4.0;
  H.crossings = [];
  for (let r = 0; r < roads.length; r++) {
    const way = roads[r];
    if (!way || !WALKABLE[way.c] || !Array.isArray(way.p) || way.p.length < 2) continue;
    if (way.tun === 1) continue;
    const bb = bboxOf(way.p);
    if (bb[2] < H.rect[0] || bb[0] > H.rect[2] || bb[3] < H.rect[1] || bb[1] > H.rect[3]) continue;
    const pts = resample(way.p, STEP);
    const wet = new Uint8Array(pts.length);
    let any = 0;
    for (let i = 0; i < pts.length; i++) {
      wet[i] = waterAt(H.field, pts[i][0], pts[i][1]) ? 1 : 0;
      any += wet[i];
    }
    if (!any) continue;
    const hw = clamp(isNum(way.w) ? way.w * 0.5 : 1.6, 1.4, 9) + 0.8;
    let i = 0;
    while (i < pts.length) {
      if (!wet[i]) { i++; continue; }
      let j = i;
      while (j + 1 < pts.length && wet[j + 1]) j++;
      const a = Math.max(0, i - 1), b = Math.min(pts.length - 1, j + 1);
      const span = (b - a) * STEP;
      if (span <= 220) {
        const ya = bankLevel(H, T, pts[a]);
        const yb = bankLevel(H, T, pts[b]);
        for (let k = a; k < b; k++) {
          const t0 = (k - a) / Math.max(1, b - a), t1 = (k + 1 - a) / Math.max(1, b - a);
          const y = Math.max(lerp(ya, yb, t0), lerp(ya, yb, t1));
          const ring = segRing(pts[k], pts[k + 1], hw);
          if (ring) out.push({ ring, bbox: bboxOf(ring), y });
        }
        H.crossings.push({ a, b, pts, hw, ya, yb, bridge: way.b === 1 || (way.lay | 0) > 0 });
        H.stats.crossings++;
      }
      i = j + 1;
    }
  }
  return out;
}

const WALKABLE = { motorway: 1, major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };

// The ground at a crossing's bank: whatever the quay or the surveyed terrain says, whichever is
// higher, with the lake itself excluded so a bank in the water cannot drag the deck under.
function bankLevel(H, T, p) {
  const q = harbourDeckY(H, p[0], p[1]);
  const g = sampleTerrain(T, p[0], p[1]);
  const y = Math.max(q, g);
  return y > H.waterY + 0.35 ? y : quayLevelNear(H, p[0], p[1]);
}

// A rectangle around one segment, as a plan ring.
function segRing(a, b, hw) {
  let tx = b[0] - a[0], tz = b[1] - a[1];
  const l = Math.hypot(tx, tz);
  if (!(l > EPS)) return null;
  tx /= l; tz /= l;
  const nx = -tz * hw, nz = tx * hw;
  const ex = tx * hw * 0.5, ez = tz * hw * 0.5;
  return [
    [a[0] + nx - ex, a[1] + nz - ez], [b[0] + nx + ex, b[1] + nz + ez],
    [b[0] - nx + ex, b[1] - nz + ez], [a[0] - nx - ex, a[1] - nz - ez],
  ];
}

// The quay GROUND level nearest a point — what the apron there stands at.
function quayLevelNear(H, x, z) {
  const hit = nearestShore(H, x, z);
  if (hit) return lerp(hit.run.g[hit.i], hit.run.g[hit.i + 1], hit.t);
  let best = Infinity, y = H.waterY + DECK_MIN + 0.7;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i < run.n; i += 8) {
      const d = Math.hypot(x - run.x[i], z - run.z[i]);
      if (d < best) { best = d; y = run.g[i]; }
    }
  }
  return y;
}

// A closed ring around an open polyline at the given half width. Used where the extract gives a
// pier as a line with no width.
function ribbonRing(p, hw) {
  const pts = resample(p, 6);
  const n = pts.length;
  if (n < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    const nx = -tz, nz = tx;
    // Square the ends off by pushing the first and last stations out along the tangent.
    const ex = i === 0 ? -tx * hw : (i === n - 1 ? tx * hw : 0);
    const ez = i === 0 ? -tz * hw : (i === n - 1 ? tz * hw : 0);
    left.push([pts[i][0] + nx * hw + ex, pts[i][1] + nz * hw + ez]);
    right.push([pts[i][0] - nx * hw + ex, pts[i][1] - nz * hw + ez]);
  }
  right.reverse();
  return left.concat(right);
}

/* =============================================================== queries == */

/** Is (x, z) inside the surveyed lake? */
export function harbourWaterAt(H, x, z) {
  return H ? waterAt(H.field, x, z) : false;
}

/**
 * Does an axis-aligned tile touch the surveyed lake? city.js's water plane uses this instead of
 * probing the terrain at the tile corners: a slip between two piers is narrower than the tile
 * lattice, and a corner probe would leave it dry.
 */
export function harbourTileHasWater(H, x0, z0, x1, z1) {
  if (!H) return false;
  const F = H.field;
  if (x1 < F.minX || x0 > F.maxX) return false;
  const step = 24;
  const ni = Math.max(1, Math.min(24, Math.ceil((x1 - x0) / step)));
  const nj = Math.max(1, Math.min(24, Math.ceil((z1 - z0) / step)));
  for (let j = 0; j <= nj; j++) {
    const z = lerp(z0, z1, j / nj);
    for (let i = 0; i <= ni; i++) {
      if (waterAt(F, lerp(x0, x1, i / ni), z)) return true;
    }
  }
  return false;
}

/**
 * The quay or pier deck GROUND level at (x, z) — the level city.js's ground-plane rungs are laid
 * on — or -Infinity where the harbour owns no deck. Continuous at the apron's inland edge, where
 * it ramps back down to the terrain over BEVEL metres.
 */
export function harbourDeckY(H, x, z) {
  if (!H) return -Infinity;
  let y = deckPolyAt(H.decks, x, z);
  if (!isNum(x) || !isNum(z)) return y;
  // THE ISLANDS: the beach, the riprap and the island seawalls are the walking surface too, so
  // the player walks down the sand into the water instead of down a hole in the terrain grid.
  // Read BEFORE the mainland index, which returns early wherever it holds no quay.
  const m = islandGroundY(H.isle, x, z);
  if (m > y) y = m;
  const G = H.index;
  const ci = Math.floor((x - G.x0) / GRID_CELL), cj = Math.floor((z - G.z0) / GRID_CELL);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return y;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return y;
  // EVERY station within reach, not just the nearest: the apron is a ribbon between consecutive
  // stations, so a point can lie inside the slab drawn from one station while the station closest
  // to it — which may be on the far side of a corner, or simply have a narrower apron — says it
  // does not. Taking the highest answer is what makes the field agree with the geometry.
  let inland = -Infinity;
  for (let k = 0; k < list.length; k += 2) {
    const run = H.runs[list[k]], i = list[k + 1];
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[i + 1] - ax, dz = run.z[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * t, qz = az + dz * t;
    let nx = lerp(run.nx[i], run.nx[i + 1], t), nz = lerp(run.nz[i], run.nz[i + 1], t);
    const nl = Math.hypot(nx, nz);
    if (nl < EPS) continue;
    nx /= nl; nz /= nl;
    const side = -((x - qx) * nx + (z - qz) * nz);
    const w = lerp(run.w[i], run.w[i + 1], t);
    const pr = lerp(run.pr[i], run.pr[i + 1], t);
    if (side < -pr - 0.4 || side > w) continue;
    // Past the end of a segment the foot of the projection is clamped, so a point far out in the
    // lake can still project to a small offset. The straight-line distance is the honest test —
    // measured against the apron inland and against the wall face seaward — and it still admits
    // the wedge a mitred corner covers.
    const reach = (side > 0.5 ? w : pr) + 1.5;
    const dx2 = x - qx, dz2 = z - qz;
    if (dx2 * dx2 + dz2 * dz2 > reach * reach) continue;
    const g = lerp(run.g[i], run.g[i + 1], t);
    const e = lerp(run.e[i], run.e[i + 1], t);
    const f = side <= w - BEVEL ? 1 : clamp((w - side) / BEVEL, 0, 1);
    const q = lerp(e - BEVEL_DROP, g, f) + APRON_Y;
    if (side > 0.5) { if (q > inland) inland = q; } else if (q > y) y = q;
  }
  // The band right at the wall belongs to the coping, water side or not. Everything further in is
  // apron, and an apron over open water would be the quay eating the lake — across a slip mouth
  // or a narrow spit the projection can reach there, so the surveyed polygon gets the last word.
  if (inland > y && !waterAt(H.field, x, z)) y = inland;
  return y;
}

/** Permanent counters for the console audit. */
export function harbourStats(H) {
  return H ? H.stats : null;
}

/* ============================================================== geometry == */

/**
 * Every piece of harbour geometry, in build order: quay walls and their apron, piers and their
 * pile structure, rubble mounds, marina floats, the ferry terminal, the public walkways, then the
 * furniture that sits on all of it.
 *
 * ctx: { mb, data, claim(x, z, r) -> bool, note(kind) }. Every random choice inside is hashed on
 * world position instead of drawing from a shared stream, so a piece of harbour looks the same
 * whatever else was built first (CONTRACT §8.4).
 */
export function appendHarbour(H, ctx) {
  if (!H || !ctx || !ctx.mb) return null;
  const c = {
    mb: ctx.mb,
    claim: typeof ctx.claim === 'function' ? ctx.claim : () => true,
    note: typeof ctx.note === 'function' ? ctx.note : () => {},
    // A real luminaire on the quay, reported at its LENS so city.js can register it with the
    // renderer's local-light rig. Optional: a caller that does not supply it still gets geometry.
    light: typeof ctx.light === 'function' ? ctx.light : () => {},
    data: ctx.data || null,
    H,
    rocks: 0, moored: 0,
  };
  appendQuayWalls(H, c);
  appendCrossings(H, c);
  appendPiers(H, c);
  appendMounds(H, c);
  appendMarinas(H, c);
  appendFerryTerminal(H, c);
  appendWalkways(H, c);
  appendQuayFurniture(H, c);
  return H.stats;
}

/* ---------------------------------------------------------------- quay wall */

/**
 * The quay wall and its apron, station by station along every run of surveyed shoreline.
 *
 * Cross-section, outward (+) to inland (-):
 *   +WALL_PROUD              coping face, standing a little into the water
 *   +WALL_PROUD - COPE_W     coping/paving joint, a 45 mm step
 *   -(w - BEVEL)             promenade paving at deck level
 *   -w                       the apron ramps down and meets the ground exactly
 * and below the coping a vertical face to WALL_FOOT, in two materials: the dry wall, and the
 * fouled band under the waterline.
 */
export function appendQuayWalls(H, c) {
  const mbG = c.mb.sidewalks, mbW = c.mb.terrain;
  const S = H.stats;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i + 1 < run.n; i++) {
      const g0 = run.g[i], g1 = run.g[i + 1];
      const t0 = g0 + APRON_Y, t1 = g1 + APRON_Y;
      const c0 = g0 + COPE_TOP, c1 = g1 + COPE_TOP;
      const e0 = run.e[i] - BEVEL_DROP + APRON_Y, e1 = run.e[i + 1] - BEVEL_DROP + APRON_Y;
      const w0 = run.w[i], w1 = run.w[i + 1];

      // Offsets along the mitre. Positive is seaward.
      const p0 = run.pr[i], p1 = run.pr[i + 1];
      const o = (k, d) => [run.x[k] + run.mx[k] * d, run.z[k] + run.mz[k] * d];
      const a0 = o(i, p0), b0 = o(i + 1, p1);
      const a1 = o(i, p0 - COPE_W), b1 = o(i + 1, p1 - COPE_W);
      const a2 = o(i, -(w0 - BEVEL)), b2 = o(i + 1, -(w1 - BEVEL));
      const a3 = o(i, -w0), b3 = o(i + 1, -w1);

      setMat(mbG, M.coping);
      S.folds += quadUp(mbG, a0[0], c0, a0[1], a1[0], c0, a1[1], b1[0], c1, b1[1], b0[0], c1, b0[1]);
      setMat(mbG, M.promenade);
      S.folds += quadUp(mbG, a1[0], t0, a1[1], a2[0], t0, a2[1], b2[0], t1, b2[1], b1[0], t1, b1[1]);
      setMat(mbG, M.promEdge);
      S.folds += quadUp(mbG, a2[0], t0, a2[1], a3[0], e0, a3[1],
        b3[0], e1, b3[1], b2[0], t1, b2[1]);

      // The coping's inland riser and the apron's inland skirt: both keep the slab from ever
      // showing an open edge, whatever the ground under it is doing.
      setMat(mbW, M.coping);
      quadOut(mbW, a1[0], t0, a1[1], b1[0], t1, b1[1], b1[0], c1, b1[1], a1[0], c0, a1[1],
        -run.nx[i], 0, -run.nz[i]);
      setMat(mbW, M.retain);
      quadOut(mbW, a3[0], e0 - 0.45, a3[1], b3[0], e1 - 0.45, b3[1], b3[0], e1, b3[1], a3[0], e0, a3[1],
        -run.nx[i], 0, -run.nz[i]);

      // The wall itself.
      setMat(mbW, M.quayFace);
      quadOut(mbW, a0[0], FOULED_TOP, a0[1], b0[0], FOULED_TOP, b0[1],
        b0[0], c1, b0[1], a0[0], c0, a0[1], run.nx[i], 0, run.nz[i]);
      setMat(mbW, M.quayFouled);
      quadOut(mbW, a0[0], WALL_FOOT, a0[1], b0[0], WALL_FOOT, b0[1],
        b0[0], FOULED_TOP, b0[1], a0[0], FOULED_TOP, a0[1], run.nx[i], 0, run.nz[i]);
    }

    // Fender timbers down the face at a working spacing.
    setMat(mbW, M.fender);
    const total = run.s[run.n - 1];
    for (let d = FENDER_SPACING * 0.5; d < total; d += FENDER_SPACING) {
      const st = atArc(run, d);
      if (!st) continue;
      const yaw = Math.atan2(-st.nz, st.nx);
      boxTop(mbW, st.x + st.nx * (st.pr + 0.07), st.z + st.nz * (st.pr + 0.07),
        0.09, 0.15, H.waterY - 1.35, st.g + COPE_TOP - 0.14, yaw);
    }
  }
}

// The station nearest an arc length along a run, with its interpolated normal and level.
const _st = { x: 0, z: 0, nx: 0, nz: 0, g: 0, w: 0, pr: 0, i: 0 };

function atArc(run, d) {
  if (!(d >= 0) || d > run.s[run.n - 1]) return null;
  let lo = 0, hi = run.n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (run.s[mid] <= d) lo = mid; else hi = mid;
  }
  const span = run.s[hi] - run.s[lo];
  const t = span > EPS ? (d - run.s[lo]) / span : 0;
  _st.x = lerp(run.x[lo], run.x[hi], t);
  _st.z = lerp(run.z[lo], run.z[hi], t);
  let nx = lerp(run.nx[lo], run.nx[hi], t), nz = lerp(run.nz[lo], run.nz[hi], t);
  const l = Math.hypot(nx, nz);
  if (l > EPS) { nx /= l; nz /= l; } else { nx = 1; nz = 0; }
  _st.nx = nx; _st.nz = nz;
  _st.g = lerp(run.g[lo], run.g[hi], t);
  _st.w = lerp(run.w[lo], run.w[hi], t);
  _st.pr = lerp(run.pr[lo], run.pr[hi], t);
  _st.i = lo;
  return _st;
}

/**
 * The deck under a walkway that crosses open water and is NOT tagged as a bridge: a timber jetty
 * on driven piles, which is what the harbourfront actually carries between the wave decks and the
 * slips. Tagged bridges are left to the street pass so one slip never gets two decks.
 */
export function appendCrossings(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain;
  for (let k = 0; k < H.crossings.length; k++) {
    const cr = H.crossings[k];
    if (cr.bridge) continue;
    for (let i = cr.a; i < cr.b; i++) {
      const t0 = (i - cr.a) / Math.max(1, cr.b - cr.a), t1 = (i + 1 - cr.a) / Math.max(1, cr.b - cr.a);
      const y = Math.max(lerp(cr.ya, cr.yb, t0), lerp(cr.ya, cr.yb, t1)) + APRON_Y;
      const ring = segRing(cr.pts[i], cr.pts[i + 1], cr.hw);
      if (!ring) continue;
      emitDeckSlab(mbD, mbS, ring, y, M.pierDeck, M.pierFascia, y - 0.85);
      const mid = [(cr.pts[i][0] + cr.pts[i + 1][0]) * 0.5, (cr.pts[i][1] + cr.pts[i + 1][1]) * 0.5];
      if (((i - cr.a) & 1) === 0 && waterAt(H.field, mid[0], mid[1])) {
        setMat(mbS, M.pile);
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          let tx = cr.pts[i + 1][0] - cr.pts[i][0], tz = cr.pts[i + 1][1] - cr.pts[i][1];
          const l = Math.hypot(tx, tz);
          if (!(l > EPS)) continue;
          tx /= l; tz /= l;
          const px = mid[0] - tz * sgn * (cr.hw - 0.35), pz = mid[1] + tx * sgn * (cr.hw - 0.35);
          mbS.cylinder(px, H.waterY - 2.8, pz, 0.20, 0.17, y - 0.6 - (H.waterY - 2.8), 5,
            hash01(px, pz) * TAU, false);
          c.note('pile');
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- piers */

export function appendPiers(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain;
  for (let i = 0; i < H.piers.length; i++) {
    const rec = H.piers[i];
    if (!rec.ring || rec.ring.length < 3) continue;
    const deck = rec.y;
    emitDeckSlab(mbD, mbS, rec.ring, deck, M.pierDeck, M.pierFascia, deck - 1.25);
    emitPileField(mbS, rec.ring, deck - 1.05, -2.9, c);
    // Fenders and a rail down each long side, and a marker on the head.
    const bb = rec.bbox;
    if (Math.max(bb[2] - bb[0], bb[3] - bb[1]) > 26) {
      const head = ringFarthest(rec.ring, quayAnchor(H, rec.cen[0], rec.cen[1]));
      if (head && c.claim(head[0], head[1], 2.0)) {
        appendNavMarker(c.mb.props, head[0], H.waterY, head[1], 3.2,
          hash01(head[0], head[1]) < 0.5);
        c.note('navMarker');
      }
    }
  }
  // Floating finger berths.
  for (let i = 0; i < H.fingers.length; i++) {
    const rec = H.fingers[i];
    const ring = ribbonRing(rec.p, FINGER_W * 0.5);
    if (!ring) continue;
    emitFloat(mbD, mbS, ring, H.waterY);
  }
}

// A slab: deck cap plus a fascia skirt all the way round, down to `foot`.
function emitDeckSlab(mbD, mbS, ring, y, capMat, sideMat, foot) {
  setMat(mbD, capMat);
  const tri = earClip(ring);
  for (let i = 0; i < tri.length; i += 3) {
    const a = ring[tri[i]], b = ring[tri[i + 1]], d = ring[tri[i + 2]];
    triUp(mbD, a[0], y, a[1], b[0], y, b[1], d[0], y, d[1]);
  }
  setMat(mbS, sideMat);
  const ccw = planArea(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    let ox = -(b[1] - a[1]), oz = b[0] - a[0];
    if (!ccw) { ox = -ox; oz = -oz; }
    const l = Math.hypot(ox, oz);
    if (l < EPS) continue;
    quadOut(mbS, a[0], foot, a[1], b[0], foot, b[1], b[0], y, b[1], a[0], y, a[1], ox / l, 0, oz / l);
  }
}

// Timber piles on a grid under a deck, only where the deck actually covers them.
function emitPileField(mb, ring, top, bottom, c) {
  const bb = bboxOf(ring);
  setMat(mb, M.pile);
  for (let z = bb[1] + PILE_SPACING * 0.5; z < bb[3]; z += PILE_SPACING) {
    for (let x = bb[0] + PILE_SPACING * 0.5; x < bb[2]; x += PILE_SPACING) {
      const jx = x + (hash01(x, z) - 0.5) * 0.7;
      const jz = z + (hash01(z, x) - 0.5) * 0.7;
      if (!pointInRing(ring, jx, jz)) continue;
      mb.cylinder(jx, bottom, jz, 0.21, 0.185, top - bottom, 5, hash01(jx, jz) * TAU, false);
      c.note('pile');
    }
  }
}

// A floating dock: deck, a body sitting in the water, and a rub rail.
function emitFloat(mbD, mbS, ring, waterY) {
  const top = waterY + FLOAT_TOP;
  setMat(mbD, M.floatDeck);
  const tri = earClip(ring);
  for (let i = 0; i < tri.length; i += 3) {
    const a = ring[tri[i]], b = ring[tri[i + 1]], d = ring[tri[i + 2]];
    triUp(mbD, a[0], top, a[1], b[0], top, b[1], d[0], top, d[1]);
  }
  setMat(mbS, M.floatBody);
  const ccw = planArea(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    let ox = -(b[1] - a[1]), oz = b[0] - a[0];
    if (!ccw) { ox = -ox; oz = -oz; }
    const l = Math.hypot(ox, oz);
    if (l < EPS) continue;
    quadOut(mbS, a[0], waterY - FLOAT_DRAFT, a[1], b[0], waterY - FLOAT_DRAFT, b[1],
      b[0], top, b[1], a[0], top, a[1], ox / l, 0, oz / l);
  }
}

function ringFarthest(ring, from) {
  let best = -1, p = null;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - from[0], ring[i][1] - from[1]);
    if (d > best) { best = d; p = ring[i]; }
  }
  return p;
}

function quayAnchor(H, x, z) {
  const hit = nearestShore(H, x, z);
  return hit ? [hit.qx, hit.qz] : [x, z];
}

/* ------------------------------------------------------- breakwaters, mounds */

/**
 * Rubble mound: a heightfield raster over the structure, crest in the middle, battered flanks
 * running down past the waterline to the toe. Works for a closed breakwater ring and for an open
 * groyne line alike, and needs no offsetting or skeleton, so a pathological outline cannot fold it.
 */
export function appendMounds(H, c) {
  const mb = c.mb.terrain;
  for (let m = 0; m < H.mounds.length; m++) {
    const rec = H.mounds[m];
    const closed = rec.closed;
    const ring = closed ? rec.p.slice(0, rec.p.length - 1) : null;
    const bb = rec.bbox;
    const pad = closed ? 0 : GROYNE_HW;
    const x0 = bb[0] - pad, z0 = bb[1] - pad, x1 = bb[2] + pad, z1 = bb[3] + pad;
    const ni = Math.max(1, Math.ceil((x1 - x0) / MOUND_CELL));
    const nj = Math.max(1, Math.ceil((z1 - z0) / MOUND_CELL));
    if (ni * nj > 60000) continue;
    const hgt = new Float64Array((ni + 1) * (nj + 1));
    const inside = new Uint8Array((ni + 1) * (nj + 1));
    for (let j = 0; j <= nj; j++) {
      const z = z0 + j * MOUND_CELL;
      for (let i = 0; i <= ni; i++) {
        const x = x0 + i * MOUND_CELL;
        const k = j * (ni + 1) + i;
        let d;
        if (closed) {
          if (!pointInRing(ring, x, z)) continue;
          d = distToPoly(x, z, rec.p);
        } else {
          d = GROYNE_HW - distToPoly(x, z, rec.p);
          if (d <= 0) continue;
        }
        inside[k] = 1;
        hgt[k] = H.waterY + lerp(MOUND_TOE, MOUND_CREST, clamp(d / MOUND_SLOPE, 0, 1));
      }
    }
    setMat(mb, M.rubble);
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const k00 = j * (ni + 1) + i, k10 = k00 + 1;
        const k01 = k00 + ni + 1, k11 = k01 + 1;
        if (!inside[k00] || !inside[k10] || !inside[k01] || !inside[k11]) continue;
        const xa = x0 + i * MOUND_CELL, xb = xa + MOUND_CELL;
        const za = z0 + j * MOUND_CELL, zb = za + MOUND_CELL;
        quadUp(mb, xa, hgt[k01], zb, xb, hgt[k11], zb, xb, hgt[k10], za, xa, hgt[k00], za);
      }
    }
    // Skirt around the edge cells so the mound is closed against the lake bed rather than
    // ending in an open sheet you can see under.
    setMat(mb, M.rubbleWet);
    const toe = H.waterY + MOUND_TOE;
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const kc = [j * (ni + 1) + i, j * (ni + 1) + i + 1,
          (j + 1) * (ni + 1) + i + 1, (j + 1) * (ni + 1) + i];
        let n = 0;
        for (let e = 0; e < 4; e++) if (inside[kc[e]]) n++;
        if (n === 0 || n === 4) continue;
        const xa = x0 + i * MOUND_CELL, xb = xa + MOUND_CELL;
        const za = z0 + j * MOUND_CELL, zb = za + MOUND_CELL;
        const px = [xa, xb, xb, xa], pz = [za, za, zb, zb];
        const cx = (xa + xb) * 0.5, cz = (za + zb) * 0.5;
        for (let e = 0; e < 4; e++) {
          const a = e, b = (e + 1) % 4;
          if (!inside[kc[a]] || !inside[kc[b]]) continue;
          const mx = (px[a] + px[b]) * 0.5 - cx, mz = (pz[a] + pz[b]) * 0.5 - cz;
          quadOut(mb, px[a], toe, pz[a], px[b], toe, pz[b],
            px[b], hgt[kc[b]], pz[b], px[a], hgt[kc[a]], pz[a], mx, 0, mz);
        }
      }
    }
    // Armour blocks on the crest, seeded on world position.
    for (let t = 0; t < rec.p.length - 1 && c.rocks < MAX_ROCKS; t++) {
      const a = rec.p[t], b = rec.p[t + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.floor(len / 5.5);
      for (let k = 0; k < n && c.rocks < MAX_ROCKS; k++) {
        const f = (k + 0.5) / n;
        const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        const h = hash01(x, z);
        appendWaveRock(c.mb.props, null, x, H.waterY + MOUND_TOE * 0.2, z, 1.0 + h * 1.5);
        c.rocks++;
        c.note('armourStone');
      }
    }
  }
}

/* ------------------------------------------------------------------ marinas */

export function appendMarinas(H, c) {
  const mb = c.mb.props;
  for (let m = 0; m < H.marinas.length; m++) {
    const rec = H.marinas[m];
    // Gangway from the quay down to the nearest float, and a marker at the basin mouth.
    const hit = nearestShore(H, rec.cen[0], rec.cen[1]);
    if (hit) {
      const g = lerp(hit.run.g[hit.i], hit.run.g[hit.i + 1], hit.t);
      const ux = rec.cen[0] - hit.qx, uz = rec.cen[1] - hit.qz;
      const ul = Math.hypot(ux, uz);
      if (ul > EPS && c.claim(hit.qx, hit.qz, 3.0)) {
        appendGangway(mb, hit.qx + (ux / ul) * 0.6, g + COPE_TOP, hit.qz + (uz / ul) * 0.6,
          Math.atan2(-(uz / ul), ux / ul), 8.0, g + COPE_TOP - (H.waterY + FLOAT_TOP));
        c.note('gangway');
      }
    }
    // Mooring buoys and a few moored craft inside the basin, on a deterministic lattice.
    const bb = rec.bbox;
    let own = 0;
    for (let z = bb[1] + 18; z < bb[3] - 8 && c.moored < MAX_MOORED && own < MAX_MOORED_BASIN;
      z += 34) {
      for (let x = bb[0] + 18; x < bb[2] - 8 && c.moored < MAX_MOORED && own < MAX_MOORED_BASIN;
        x += 34) {
        const jx = x + (hash01(x, z) - 0.5) * 16, jz = z + (hash01(z, x) - 0.5) * 16;
        if (!pointInRing(rec.p, jx, jz) || !waterAt(H.field, jx, jz)) continue;
        const hs = nearestShore(H, jx, jz);
        if (hs && hs.side > -6) continue;                 // keep clear of the wall
        if (!c.claim(jx, jz, 7.0)) continue;
        if (hash01(jx + 3.1, jz - 7.7) < 0.34) {
          appendMooringBuoy(mb, jx, H.waterY, jz, 0.36 + hash01(jx, jz) * 0.2);
          c.note('mooringBuoy');
        } else {
          appendBoat(mb, rngAt(jx, jz), jx, H.waterY, jz, hash01(jx, jz) * TAU,
            7.5 + hash01(jz, jx) * 6);
          c.note('boat');
          c.moored++;
          own++;
        }
      }
    }
  }
}

/* ----------------------------------------------------------- ferry terminal */

/**
 * Ferry terminal slips. Toronto's are at the foot of Bay Street: a deck apron on the quay with
 * finger piers running out into the harbour, the slips between them open to the water, fender
 * dolphins at every slip mouth and a mooring dolphin off the end.
 */
export function appendFerryTerminal(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain, mbP = c.mb.props;
  for (let t = 0; t < H.terminals.length; t++) {
    const rec = H.terminals[t];
    if (rec.p && rec.ring) {
      emitDeckSlab(mbD, mbS, rec.ring, rec.y, M.terminal, M.pierFascia, rec.y - 1.6);
      emitPileField(mbS, rec.ring, rec.y - 1.4, -3.0, c);
      continue;
    }
    const a = rec.anchor;
    if (!a) continue;
    const run = a.run, i = a.i;
    let nx = lerp(run.nx[i], run.nx[i + 1], a.t), nz = lerp(run.nz[i], run.nz[i + 1], a.t);
    const nl = Math.hypot(nx, nz);
    if (nl < EPS) continue;
    nx /= nl; nz /= nl;
    const tx = -nz, tz = nx;
    const g = lerp(run.g[i], run.g[i + 1], a.t);
    const deck = g + PIER_LIFT;
    const SLIPS = 3, SLIP_W = 15.0, FINGER_LEN = 34.0, FINGER_HW = 3.2;
    const span = SLIPS * SLIP_W;

    for (let k = 0; k <= SLIPS; k++) {
      const off = -span * 0.5 + k * SLIP_W;
      const bx = a.x + tx * off, bz = a.z + tz * off;
      const ring = [
        [bx - tx * FINGER_HW, bz - tz * FINGER_HW],
        [bx - tx * FINGER_HW + nx * FINGER_LEN, bz - tz * FINGER_HW + nz * FINGER_LEN],
        [bx + tx * FINGER_HW + nx * FINGER_LEN, bz + tz * FINGER_HW + nz * FINGER_LEN],
        [bx + tx * FINGER_HW, bz + tz * FINGER_HW],
      ];
      emitDeckSlab(mbD, mbS, ring, deck, M.terminal, M.pierFascia, deck - 1.5);
      emitPileField(mbS, ring, deck - 1.3, -3.2, c);
      // Berthing dolphins at the head of every finger.
      const hx = bx + nx * (FINGER_LEN + 4.5), hz = bz + nz * (FINGER_LEN + 4.5);
      if (c.claim(hx, hz, 2.4)) {
        appendDolphin(mbP, rngAt(hx, hz), hx, H.waterY, hz, 0.95);
        c.note('dolphin');
      }
      // A rail down the outer edges only — the slip faces stay clear for the ramps.
      const mx = bx + nx * FINGER_LEN * 0.5, mz = bz + nz * FINGER_LEN * 0.5;
      if (c.claim(mx + tx * FINGER_HW, mz + tz * FINGER_HW, 1.2)) {
        appendQuayRailing(mbP, mx + tx * (FINGER_HW - 0.25), deck, mz + tz * (FINGER_HW - 0.25),
          Math.atan2(-nz, nx), FINGER_LEN - 3.0);
        c.note('quayRailing');
      }
    }
    // Landside apron tying the fingers back into the promenade.
    const ap = [
      [a.x - tx * (span * 0.5 + 3) - nx * 1.0, a.z - tz * (span * 0.5 + 3) - nz * 1.0],
      [a.x - tx * (span * 0.5 + 3) + nx * 3.0, a.z - tz * (span * 0.5 + 3) + nz * 3.0],
      [a.x + tx * (span * 0.5 + 3) + nx * 3.0, a.z + tz * (span * 0.5 + 3) + nz * 3.0],
      [a.x + tx * (span * 0.5 + 3) - nx * 1.0, a.z + tz * (span * 0.5 + 3) - nz * 1.0],
    ];
    emitDeckSlab(mbD, mbS, ap, deck, M.terminal, M.pierFascia, deck - 1.5);
    for (let k = 0; k < SLIPS; k++) {
      const off = -span * 0.5 + (k + 0.5) * SLIP_W;
      const bx = a.x + tx * off + nx * 2.0, bz = a.z + tz * off + nz * 2.0;
      if (!c.claim(bx, bz, 2.0)) continue;
      appendNavMarker(mbP, bx + nx * (FINGER_LEN + 2), H.waterY, bz + nz * (FINGER_LEN + 2),
        3.0, (k & 1) === 0);
      c.note('navMarker');
    }
  }
}

/* ---------------------------------------------------------------- walkways */

/**
 * The three public routes along the water get their real surfaces: timber for the boardwalk,
 * asphalt for the Martin Goodman / Waterfront Recreational Trail, and the promenade paving that
 * the quay apron already lays down. city.js has already built these ways as generic footways on
 * the ground; these run one rung above that, so the correct surface is what you see and the
 * generic ribbon underneath can never fight it.
 */
export function appendWalkways(H, c) {
  const data = c.data;
  if (!data || !Array.isArray(data.roads)) return;
  const mb = c.mb.sidewalks;
  const T = H.terrain;
  const gy = (x, z) => {
    const d = harbourDeckY(H, x, z);
    const t = sampleTerrain(T, x, z);
    return d > t ? d : t;
  };
  let boardMetres = 0, trailMetres = 0;
  for (let i = 0; i < data.roads.length; i++) {
    const r = data.roads[i];
    if (!r || typeof r.n !== 'string' || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.tun === 1) continue;
    const board = /boardwalk/i.test(r.n);
    const trail = /martin goodman|recreational trail|waterfront trail/i.test(r.n);
    if (!board && !trail) continue;
    // Only along the water: the trail network runs far inland in the full city extract and those
    // stretches belong to the street pass, not to the harbour.
    const cen = centroidOf(r.p);
    const near = nearestShore(H, cen[0], cen[1]);
    if (!near || near.d > 150) continue;
    const pts = resample(r.p, 4.0);
    const hw = clamp(isNum(r.w) ? r.w * 0.5 : 1.6, 1.2, 3.2);
    if (board) boardMetres += polyLength(pts); else trailMetres += polyLength(pts);
    emitWalkRibbon(mb, pts, hw, gy, board);
  }
  H.stats.boardwalkMetres = boardMetres;
  H.stats.trailMetres = trailMetres;
}

function emitWalkRibbon(mb, pts, hw, gy, board) {
  const n = pts.length;
  const lift = board ? BOARD_LIFT : TRAIL_LIFT;
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    nx[i] = -tz; nz[i] = tx;
  }
  const boards = board ? 5 : 1;
  for (let i = 0; i + 1 < n; i++) {
    const y0 = gy(pts[i][0], pts[i][1]) + lift;
    const y1 = gy(pts[i + 1][0], pts[i + 1][1]) + lift;
    for (let k = 0; k < boards; k++) {
      const g = board ? 0.035 : 0;
      const oa = -hw + (k / boards) * 2 * hw + g;
      const ob = -hw + ((k + 1) / boards) * 2 * hw - g;
      setMat(mb, board ? M.boardwalk : M.trail);
      quadUp(mb,
        pts[i][0] + nx[i] * oa, y0, pts[i][1] + nz[i] * oa,
        pts[i][0] + nx[i] * ob, y0, pts[i][1] + nz[i] * ob,
        pts[i + 1][0] + nx[i + 1] * ob, y1, pts[i + 1][1] + nz[i + 1] * ob,
        pts[i + 1][0] + nx[i + 1] * oa, y1, pts[i + 1][1] + nz[i + 1] * oa);
    }
    // Fascia down each side so a raised deck reads as a deck and never as a floating sheet.
    setMat(mb, board ? M.boardEdge : M.promEdge);
    for (let s = -1; s <= 1; s += 2) {
      const o = s * hw;
      const ax = pts[i][0] + nx[i] * o, az = pts[i][1] + nz[i] * o;
      const bx = pts[i + 1][0] + nx[i + 1] * o, bz = pts[i + 1][1] + nz[i + 1] * o;
      const fa = gy(ax, az) + (board ? 0.04 : 0.02);
      const fb = gy(bx, bz) + (board ? 0.04 : 0.02);
      quadOut(mb, ax, fa, az, bx, fb, bz, bx, y1, bz, ax, y0, az, nx[i] * s, 0, nz[i] * s);
    }
  }
}

/* --------------------------------------------------------------- furniture */

export function appendQuayFurniture(H, c) {
  const mb = c.mb.props;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    const total = run.s[run.n - 1];
    // Bollards and ladders are bolted THROUGH the coping stone; everything else stands on the
    // apron, a couple of centimetres up so a base plate never fights the paving it sits on.
    const cope = COPE_W * 0.45;
    const deck = 0.02 + APRON_Y;
    place(run, total, BOLLARD_SPACING, 0.0, (st, x, z, yaw) => {
      appendMooringBollard(mb, x, st.g + COPE_TOP, z, yaw);
      c.note('mooringBollard');
    }, 0.42, cope);
    place(run, total, LADDER_SPACING, 0.31, (st, x, z, yaw) => {
      appendQuayLadder(mb, x, st.g + COPE_TOP, z, yaw, st.g + COPE_TOP - (H.waterY - 1.1));
      c.note('quayLadder');
    }, 0.5, 0.30);
    place(run, total, LIFEBUOY_SPACING, 0.57, (st, x, z, yaw) => {
      appendLifebuoyStation(mb, x, st.g + deck, z, yaw);
      c.note('lifebuoyStation');
    }, 0.7, 2.6);
    place(run, total, QUAY_LAMP_SPACING, 0.13, (st, x, z, yaw) => {
      const a = yaw + Math.PI;
      appendPedestrianLamp(mb, x, st.g + deck, z, a, 5.2);
      // The head hangs 0.76 m out along the boom at 5.26 m — the offsets props.js builds it at.
      c.light('ped', x + Math.cos(a) * 0.76, st.g + deck + 5.26, z - Math.sin(a) * 0.76);
      c.note('quayLamp');
    }, 0.9, 3.4);
    place(run, total, BENCH_SPACING, 0.77, (st, x, z, yaw) => {
      appendTimberBench(mb, rngAt(x, z), x, st.g + deck, z, yaw + Math.PI * 0.5);
      c.note('timberBench');
    }, 1.2, 4.6);
  }

  function place(run, total, spacing, phase, fn, radius, inset) {
    for (let d = spacing * phase; d < total; d += spacing) {
      const st = atArc(run, d);
      if (!st) continue;
      // Everything sits inside the apron, measured back from the wall face.
      const back = Math.min(inset, Math.max(0.35, st.w - 1.4)) - st.pr;
      const x = st.x - st.nx * back, z = st.z - st.nz * back;
      if (!c.claim(x, z, radius)) continue;
      fn(st, x, z, Math.atan2(-st.nz, st.nx));
    }
  }
}


/* ============================================================================ */
/* == THE ISLANDS, THE GAPS AND BILLY BISHOP ================================== */
/* ============================================================================ */
//
// The south half of the map is the harbour, the Toronto Island chain and the airport that sits
// on the west end of it. It is a different place from the mainland waterfront and it is built
// differently.
//
// What the extract actually carries down here
// -------------------------------------------
//   shore[] role "inner"   17 closed rings once chained: 35.5 km of island shoreline, including
//                          every lagoon inlet. This is survey and it is exact.
//   areas[]                52 park, 208 grass, 58 pier, 10 parking polygons on the islands
//   roads[]                292 footways, 160 service roads, 14 pedestrian ways, 25 minor roads
//   buildings[]            323 records, from the ferry terminals to the Ward's Island cottages
//   waterfront[]           4 marinas, 85 piers, 13 breakwaters, 10 groynes, 2 ferry terminals
//
// What it does NOT carry, and where the rest comes from
// ----------------------------------------------------
//   * The land/water EDGE TREATMENT. A surveyed shoreline is a line, not a wall or a beach, and
//     Amendment 9.2 forbids land simply becoming water. Every metre of those 35.5 km is
//     classified here — beach, riprap or seawall — and given a real cross-section.
//   * AEROWAY. tools/build_city.py reads highway, railway, natural=water, leisure, landuse,
//     amenity and man_made; it has never read aeroway, so nothing of Billy Bishop's layout
//     survives into toronto.json but the buildings. The runways, taxiways, aprons, stopways,
//     stands and holding positions below are the OSM aeroway ways for YTZ, projected with the
//     same projection build_city.py uses (true metres, cos(lat0) applied) and frozen here at
//     authoring time. They are SURVEY, not invention: the task is explicit that the layout must
//     come from the aeroway tags rather than be made up, and this is the only route to them that
//     does not require regenerating data/toronto.bin.
//   * natural=beach and natural=sand, same story: read, projected, frozen.
//   * route=ferry, from the water extract. Five ways; their endpoints ARE the docks.
//   * attraction=*, the Centreville rides.
//
// Everything else down here is synthesised, and says so where it happens.
//
// Amendment 7 (time of day). The only emitters in the whole section are the airfield lights
// (runway edge, threshold, end, taxiway edge), the approach bars out over the water and the
// lighthouse lantern — every one a real light. Sand, grass, aircraft, ferries, hedges and
// boardwalks are geometry and albedo only.
//
// Amendment 8.4 (scaling). Nothing is keyed to this bounding box: the island model is built from
// whatever rings the extract contains, every index is a uniform grid, and every random choice is
// hashed on world position, so a tile of beach looks the same whether or not its neighbours were
// built. The emitters take a tile box and emit only what they own, which is the bounding-box
// predicate ARCHITECTURE.md asks for.

/* ------------------------------------------------------------------ tunables */

const ISLE_MIN_AREA = 300.0;      // m^2 — smaller rings are mapped rocks, not islands
const ISLE_STATION = 6.0;         // island shore resample step
const ISLE_GRID = 34.0;           // island edge index cell
// How far a query may look. This MUST cover the widest mantle: the ground field and the geometry
// read the same station arrays, and a reach shorter than the cover would draw sand the ground
// field does not know about.
const ISLE_REACH = 62.0;

const EDGE_RIP = 0;               // rubble-mound bank — the lagoons and the channel sides
const EDGE_BEACH = 1;             // sand, with a swash zone and a submerged toe
const EDGE_WALL = 2;              // low concrete seawall — docks, marinas, the airport perimeter

const HARD_NEAR = 13.0;           // a surveyed structure this close makes the edge engineered
const OPEN_LAKE = 900.0;          // open water this far out along the normal = a lake shore
const OPEN_STEP = 45.0;

const BANK_MIN = 0.55;            // island bank level above the lake, at its lowest
const BANK_MAX = 6.00;
const BANK_SAMPLE = 16.0;         // how far inland the bank level is read off the terrain

const BEACH_BACK = 22.0;          // dry sand inland of the surveyed line, at its widest
const BEACH_BACK_MIN = 9.0;
const BEACH_FACE = 12.0;          // shore line out to the waterline
const BEACH_TOE = 9.0;            // and on under the water
const BEACH_TOE_DROP = 0.85;
const BEACH_FREE = 0.42;          // the surveyed line stands this far above the lake on a beach

const RIP_BACK = 4.2;
const RIP_FACE = 4.6;
const RIP_TOE = 3.4;
const RIP_TOE_DROP = 2.05;
const RIP_FREE = 0.72;

const WALL_BACK = 3.8;
const WALL_FACE = 0.55;
const WALL_TOE = 1.30;
const WALL_TOE_DROP = 2.60;
const WALL_FREE = 1.05;           // island seawalls are LOW; a metre of freeboard, not a quay

const ISLE_BACK_MAX = 58.0;       // how far inland the cover may run to find real ground
const ISLE_TOE_MAX = 15.0;        // and how far out the toe may run to find the lake bed
const MANTLE_SINK = 0.14;         // the inland edge finishes below the ground, so they cross
const SWASH = 0.55;               // fraction of the face that is dry sand rather than swash

const AIR_SHOULDER = 9.0;         // graded shoulder outside the paved edge
const AIR_BLEND = 26.0;           // and the distance the flattening blends back to the survey
const AIR_RUN_HW = 15.0;          // runway half width where the extract gives no width tag
const AIR_TAXI_HW = 9.0;
const AIR_MARK = 0.034;           // paint proud of the pavement; city.js's proven value
const AIR_EDGE_LIGHT = 60.0;      // runway edge light spacing
const AIR_TAXI_LIGHT = 48.0;
const AIR_APPROACH_BARS = 9;
const AIR_APPROACH_STEP = 33.0;
const AIR_CELL = 8.0;             // airfield occupancy raster, for the perimeter fence
const AIR_FENCE_OUT = 74.0;       // the perimeter runs this far outside the pavement

const ISLE_TREE_CELL = 12.8;      // island canopy lattice; mature parkland, not a plantation
const ISLE_TREE_MAX = 900;        // per tile
const ISLE_SHORE_PROP = 42.0;     // one beach prop per this many metres of beach
const MAX_ISLE_BOATS = 8;         // moored craft per tile

/* ----------------------------------------------------------------- materials */

// Island and airfield albedos. Same rules as M above: physical constants, no baked light, and
// emissive only where the real thing emits.
const IM = {
  sandDry: [0.148, 0.132, 0.101, 0, 0, 0.95, 0],
  sandWet: [0.056, 0.050, 0.041, 0, 0, 0.58, 0],
  turf: [0.030, 0.052, 0.028, 0, 0, 0.95, 0],
  soil: [0.034, 0.028, 0.022, 0, 0, 0.96, 0],
  bank: [0.048, 0.058, 0.036, 0, 0, 0.94, 0],
  runway: [0.028, 0.029, 0.032, 0, 0, 0.44, 0],
  shoulder: [0.042, 0.043, 0.046, 0, 0, 0.66, 0],
  apron: [0.070, 0.071, 0.075, 0, 0, 0.60, 0],
  infield: [0.033, 0.048, 0.029, 0, 0, 0.96, 0],
  paintWhite: [0.300, 0.298, 0.286, 0, 0, 0.62, 0],
  paintYellow: [0.300, 0.222, 0.038, 0, 0, 0.64, 0],
  paintRed: [0.230, 0.036, 0.030, 0, 0, 0.64, 0],
  boardIsle: [0.088, 0.063, 0.042, 0, 0, 0.88, 0],
  boardIsleEdge: [0.058, 0.042, 0.029, 0, 0, 0.90, 0],
};


/* --------------------------------------------------------- baked survey -- */
//
// Read out of data/raw/osm_infra.json and data/raw/osm_water.json and projected with the same
// Proj build_city.py uses. Flat [x, z, x, z, ...] in world metres, 0.1 m resolution.
// ---- aeroway, from the OSM extract (aeroway=runway|taxiway|apron|stopway|
// parking_position|holding_position), projected to world metres at authoring time.
const AERO_RUNWAY = [
  ['08/26',
    [-167.5,447.2,-201.9,458.9,-230.5,468.6,-341.1,506.2,-381.5,519.9,-405.8,528.2,-426.8,535.3,
    -448.3,542.6,-723.3,636,-770.2,651.9,-985.6,725.1,-1016.1,735.5,-1258.3,817.7,-1317.7,
    837.9]
  ],
  ['06/24',
    [-279.8,534.8,-325.6,574.5,-342.2,588.8,-381.4,621.7,-382.9,623,-717.8,904.2,-787.6,963.8,
    -809.6,982.7,-850.7,1015.2]
  ],
];
const AERO_TAXIWAY = [
  ['E',
    [-582.3,1244.8,-645.6,1174,-698.6,1114.7,-709.4,1102.8,-769.3,1030.5,-794.9,999.7,-809.6,
    982.7,-849.3,935.3,-921.7,848.6,-970.1,790.7,-1016.1,735.5,-1062.2,680.3,-1097.6,638.1,
    -1104,630.4,-1135.2,592.8]
  ],
  ['',
    [-717.8,904.2,-647.4,988.2,-564.8,1086.7,-523,1136.5,-521.2,1138.9,-519.4,1143.4,-519.3,
    1149,-521.5,1178,-522.9,1185.4,-524.8,1191.8,-529.5,1198.2,-537.4,1205,-582.3,1244.8]
  ],
  ['C',
    [-405.8,528.2,-418,512.9,-429.6,497.6,-455.3,463.5]
  ],
  ['D',
    [-279.8,534.8,-212,475.4,-208.5,471.9,-204.1,464.7,-201.9,458.9,-200.9,453.3,-200.4,447.2,
    -202.3,438.1,-206,429.7,-208.2,421.8,-210.3,417.5,-212.6,414.5,-215.7,411.5,-222.2,406.9,
    -225.4,405.5,-229.1,404.3,-232.5,403.8,-236,403.7,-240.1,404,-244.3,405,-259.7,410.1,-412,
    461.7,-429.7,467.7,-433.3,468.6,-437.2,469.1,-442.1,468.7,-445.1,468.3,-448.2,467.3,-451.9,
    465.8,-455.3,463.5]
  ],
  ['C',
    [-367.1,579.8,-377.7,565.7,-392.7,545.5,-405.8,528.2]
  ],
  ['',
    [-770.2,651.9,-764,646.2,-760.2,642.8,-757.6,638.6,-756.2,634.3,-755.4,630.8,-755.3,627.4,
    -756,622.4]
  ],
  ['A',
    [-1128.4,553.6,-1173,586.9,-1184.3,599.2,-1192,608.2,-1259.6,686.9,-1303.7,738.3,-1309.2,
    743.9,-1315.2,751.1,-1316.9,753.9,-1317.8,757.1,-1318.3,761.9,-1317.4,766.4,-1315.3,772.2,
    -1305.9,799,-1301.7,806.3,-1294.8,812.8,-1287.4,817.2,-1278.6,819.8,-1271.9,819.6,-1258.3,
    817.7]
  ],
  ['B',
    [-1097.6,638.1,-1093.4,641.4,-1089.7,643.4,-1085.2,645.2,-1080.6,646.1,-1076.7,646.3,
    -1072.6,646.1,-1068,645,-1049.5,638.9,-1019.4,628.5,-964.9,609.7,-963.2,608.3,-961.8,606.8,
    -960.6,604.9,-959.7,602.5,-958.7,598.7,-958.1,596.2,-957.4,592.4,-957.3,589.1,-957.5,586,
    -958.4,581.8,-959.4,578.7,-960.8,575.8,-962.6,573.5,-965.2,571.3]
  ],
  ['',
    [-771.7,575.4,-772.1,572.6,-772.2,569.7,-772,567,-771.4,564.5,-770.3,561.2,-768.8,558.4,
    -766.8,555.8,-764.6,553.4,-762.3,551.7,-758.8,549.6]
  ],
  ['',
    [-455.3,463.5,-457.8,461.6,-458.8,460.9,-466.5,457.1,-470.4,455.9,-474.3,455.5,-478.3,455.5,
    -482.3,456,-486.3,457.2,-508.1,464.4,-758.8,549.6,-788.3,559.4,-791.4,559,-794.5,558.6,
    -798.3,557.5,-801.1,556.1,-803.5,554.3,-805.9,551.9,-807.5,549.5,-809,546.6]
  ],
  ['A',
    [-965.2,571.3,-994,558.7,-1012.6,550.7,-1028,544,-1053.6,533,-1057.5,531.5,-1062,530.1,
    -1067.3,529.2,-1072.1,528.8,-1077.8,528.8,-1084.3,529.3,-1089.5,530.5,-1095.5,532.4,-1101,
    534.6,-1105.7,537.4,-1109.2,539.7,-1118,545.9,-1128.4,553.6]
  ],
  ['',
    [-1049.5,638.9,-1053.4,641.3,-1056.3,643.8,-1059.4,647.4,-1061.9,651,-1063.6,654.9,-1065,
    659.5,-1065.5,664.3,-1065.2,669.1,-1064.5,673.1,-1063.5,676.5,-1062.2,680.3]
  ],
  ['',
    [-771.7,575.4,-773.1,571,-775.1,567.8,-777,565.4,-779.9,563,-782.7,561.1,-785.7,560,-788.3,
    559.4]
  ],
  ['',
    [-495,418.6,-491.7,438.8,-492.2,443.7,-493.9,449,-497.1,454.3,-500.4,458.4,-504.4,461.9,
    -508.1,464.4]
  ],
  ['',
    [-455.3,463.5,-457.2,460.8,-472.1,440.7,-476.2,437,-489.1,425.3,-495,418.6,-497.2,415.5,
    -514.2,366.2,-521,346.5,-521.6,345.3,-525.8,336.4,-551.2,302,-555.2,296.8,-559.2,293.2,-565,
    289.3,-572.9,285.8,-578.3,283,-584.4,279.3]
  ],
  ['',
    [-818.7,569.4,-816.4,567.8,-814.2,565.8,-812,563.1,-810.3,560.4,-809.4,557.9,-808.7,554.8,
    -808.5,551.4,-809,546.6,-814,531.3,-819.7,514.7,-820.5,512.5,-822.5,505.9,-822.9,503,-822.4,
    484.2,-821.7,472.2,-820.9,467.9,-819.1,463.5,-816.3,459.4,-813.7,454.9,-812.8,452.9,-812.3,
    450.2,-811.6,434.8]
  ],
  ['',
    [-771.7,575.4,-774.1,571.8,-776.9,568.5,-779.8,566.2,-783.3,564.2,-786.4,563,-790,562.2,
    -792.6,561.9,-796.1,562]
  ],
  ['',
    [-230.5,468.6,-222.5,463.8,-214.5,458.3,-211.3,454.7,-207.9,448.7,-206.5,445.2,-205.5,440.6,
    -205.2,435.9,-206,429.7]
  ],
  ['',
    [-1128.4,553.6,-1132.2,557.7,-1134.8,561.4,-1136.7,565,-1138.4,569.5,-1139.2,574,-1139.3,
    578.9,-1138.7,583.6,-1137.5,587.7,-1136.4,590.3,-1135.7,591.8,-1135.2,592.8]
  ],
  ['',
    [-964.9,609.7,-919,594.2,-913.2,593.1,-904.1,591.8]
  ],
  ['',
    [-429.6,497.6,-427.9,502.2,-426.8,506.5,-426.2,512.6,-427.4,519,-429,523.9,-430.9,527.7,
    -435.1,532.9,-438.5,535.8,-448.3,542.6]
  ],
  ['',
    [-325.6,574.5,-339,582.6,-342.9,584.4,-347.1,585.4,-350.7,585.9,-354.4,585.5,-357.8,584.9,
    -360.8,583.7,-363.9,582.1,-367.1,579.8]
  ],
  ['',
    [-426.8,535.3,-422.1,535.6,-416.4,535,-413.3,535.1,-409.4,535.7,-404.9,537.1,-402.1,538.5,
    -398.8,540.4,-392.7,545.5]
  ],
  ['',
    [-418,512.9,-413,516.8,-407.8,519.7,-402.8,521.5,-397.1,522.2,-381.5,519.9]
  ],
  ['',
    [-788.3,559.4,-796.1,562,-818.7,569.4,-870.6,587,-876,588.3,-881.6,589.2,-892.9,590.6,
    -904.1,591.8,-908.4,591.7,-913.4,591.2,-919.1,590.1,-924.3,588.7,-929.4,586.8,-945.6,579.6,
    -965.2,571.3]
  ],
  ['',
    [-756,622.4,-753.1,627.4,-749.8,630.9,-745.8,633.7,-741.3,635.5,-736.5,636.3,-723.3,636]
  ],
  ['',
    [-820.5,512.5,-822.8,508.7,-824.8,506.6,-827.8,504.7,-830.9,503.5,-833.7,503.1,-838.9,503.4,
    -843,503.1,-846,501.9,-849.3,499.7,-852,497.3,-852.6,495.9,-852.7,493.7,-853.8,491.2,-870.7,
    468.1]
  ],
  ['',
    [-852.6,495.9,-854.5,493.4,-856.7,491.8,-859.3,490.9,-862,490.3,-865.8,490.4,-870.4,491,
    -875.4,491.8,-879,492.8,-888.6,495.9,-891,496.6,-893,496.8,-894.9,496.6,-896.6,496.1,-897.8,
    495.3,-899.1,493.8,-902.2,489.5]
  ],
  ['',
    [-852.7,493.7,-852.2,490,-851.1,487.1,-848.9,483.6,-845.4,480.6,-829.5,468.8,-826.3,466.2,
    -824.7,464.1,-823.4,461.7,-822.7,459.2,-822.6,456.5,-822.8,454.5,-823.6,452.4,-824.8,450.1]
  ],
  ['',
    [-1173,586.9,-1169.9,585.4,-1166.4,584.2,-1163.3,583.4,-1159.9,582.9,-1156.5,582.8,-1153.1,
    583.2,-1150,583.8,-1146.7,585,-1143.7,586.3,-1140.8,588.1,-1138.1,590.2,-1136,592.1,-1135.2,
    592.8]
  ],
  ['F',
    [-756,622.4,-768.5,585.1,-771.7,575.4]
  ],
  ['',
    [-381.4,621.7,-368.6,607,-366.5,604,-364.7,600.4,-363.8,597.3,-363.3,593.5,-363.6,590.1,
    -364,587.3,-365.1,583.5,-367.1,579.8]
  ],
  ['',
    [-994,558.7,-997.9,558.4,-1001.9,559.1,-1005.4,560.6,-1007.9,562.3,-1009.6,564.4,-1011.4,
    567.5,-1015.9,577.5]
  ],
  ['',
    [-698.6,1114.7,-692.8,1117.6,-685.5,1119.6,-678.5,1119,-672.1,1116.9,-666,1113.1]
  ],
  ['',
    [-666,1113.1,-664.3,1112.8,-651.8,1110.5,-619.8,1091.6,-621.1,1087.2,-622.5,1084.5,-624.8,
    1082.2,-629.9,1079.4,-633.5,1078.6,-637.3,1078.8,-641.9,1080.7,-646,1083.5,-648.2,1087.6,
    -649.3,1091.9,-649.3,1096.9,-651.5,1098.2,-656.3,1101.2,-663.7,1111.2,-664.8,1112.2,-666,
    1113.1]
  ],
];
const AERO_APRON = [
  ['',
    [-973,555.3,-920.9,578.8,-919.2,579.1,-917.5,579,-895.5,571.6,-743.6,519.1,-494.1,434,
    -496.2,427.3,-475.4,418.7,-455.6,443.4,-455.8,439.4,-426.9,418.8,-465.1,368.4,-492.9,390.3,
    -502.7,362.6,-503.5,357.3,-504.6,353.7,-510.8,336.4,-562.5,266.7,-556.8,262.7,-592.4,214.7,
    -597.6,218.7,-628.4,241.6,-636.4,230.9,-670,256.1,-664.7,263,-668.7,266,-657.8,280.7,-655.9,
    283.3,-645.1,297.9,-644.7,297.6,-642.7,300.5,-643,300.7,-631.9,315.7,-623.7,309.7,-612.9,
    323,-609.8,335,-618.7,347.9,-615.3,352.6,-603.1,343.7,-600.5,347.1,-590.5,353.2,-586,349.8,
    -586.5,357.9,-596.1,365,-593.9,371.8,-586.7,369.4,-587.1,367.9,-583.5,366.8,-581.4,372.8,
    -574.2,381.2,-575.6,383.7,-568.8,387,-568.3,385.7,-564.6,387.5,-567.2,392.9,-568,402.8,-572,
    397.6,-578.8,399.9,-578.8,401.1,-578,401.6,-576.2,406.9,-574.8,406.6,-573.6,410.1,-579.5,
    412.2,-584.5,416.4,-586.4,410.4,-600.2,409.2,-601.2,405.7,-606.8,400.5,-612.3,402.2,-610,
    409.6,-608.6,409.1,-607.3,412.9,-614,415.5,-620.4,424.7,-616.3,437.1,-625.1,440.1,-628.8,
    428.8,-630.6,429.4,-631.9,425.6,-645.9,424.3,-647.1,420.8,-652.6,415.7,-658,417.3,-655.7,
    424.7,-654.3,424.2,-652.9,428.1,-660.1,430.5,-665.9,435.6,-677.2,434.5,-678.3,430.9,-683.8,
    425.9,-689.2,427.7,-686.8,435.1,-685.5,434.6,-684.3,438.5,-691.3,440.7,-697.1,446,-708.4,
    444.8,-709.5,441.3,-715.1,436.2,-720.5,437.9,-718.1,445.3,-716.6,444.8,-715.5,448.5,-722.1,
    450.7,-730.5,457.9,-738.1,456.7,-739.1,463.9,-737.8,464.1,-738.2,467.8,-743.5,467.3,-748.7,
    468.4,-753.5,461.7,-759.5,466.2,-758.6,467.3,-761.6,469.7,-765.6,464.6,-774.8,459.4,-764,
    451.5,-767,439.5,-760.1,429.4,-761.9,427.1,-758.9,424.9,-763.4,419.2,-772.3,425.7,-769.6,
    429.6,-772.5,432,-776.5,427.1,-786.5,421.2,-795.6,428.2,-803.4,428.1,-801.1,379.6,-808.8,
    369.2,-852.3,400.9,-851.2,402.3,-849.2,404.8,-892.7,438.1,-905.7,448,-904.3,449.7,-937.3,
    474.6,-940.2,493.8,-920,520.6,-946.5,540,-966.3,554.5,-969.6,555.1,-973,555.3]
  ],
  ['',
    [-1020.9,575.5,-1015.9,577.5,-1011.9,579.2,-1018.2,594.3,-1075.6,610.1,-1105.8,573.7,
    -1090.7,562.2,-1085,559.7,-1079.8,558.1,-1074.3,557.8,-1069.3,558.1,-1066.8,558.8,-1024.8,
    577.1,-1020.9,575.5]
  ],
  ['',
    [-441.5,783,-436.7,789,-429.9,796.6,-429.4,799,-374.2,871.6,-373.5,900.2,-377.2,938.2,-390,
    1063.6,-428.2,1062.1,-480.3,1022,-520.3,979.5,-564.8,925.8,-571.5,918.4,-585.1,901.7,-441.5,
    783]
  ],
];
const AERO_STOPWAY = [
  ['08/26',
    [-79.6,417.5,-167.5,447.2]
  ],
  ['08/26',
    [-1402.7,866.7,-1317.7,837.9]
  ],
];
const AERO_STAND = [
  ['1',
    [-804.6,458.1,-800.8,455.2,-767.6,430.6]
  ],
  ['2',
    [-810.9,508.9,-796.3,497.8,-756.6,468.3]
  ],
  ['3',
    [-746.1,534.6,-743.7,521.3,-742.7,510.9,-735.9,463.5]
  ],
  ['4',
    [-691.5,516.1,-698.2,495.8,-715.4,443.2]
  ],
  ['5',
    [-660.4,505.6,-667.1,485.1,-684.2,432.7]
  ],
  ['6',
    [-629.3,495,-635.9,474.6,-638.1,466.9,-653,422.7]
  ],
  ['7',
    [-583.8,479.5,-590.4,459.2,-607.3,407.8]
  ],
  ['8',
    [-552.3,468.9,-559.1,448.5,-573.4,405]
  ],
  ['9',
    [-510.8,412.7,-528.4,403.9,-568.2,383.6]
  ],
  ['10',
    [-531.8,347.7,-546.6,352.6,-588.9,366.5]
  ],
  ['11',
    [-559.8,306.9,-572.5,316.4,-609.3,343.9]
  ],
  ['',
    [-902.2,489.5,-921.7,462.9]
  ],
  ['',
    [-870.7,468.1,-892.7,438.1]
  ],
];
const AERO_HOLD = [
  ['',
    [-441.8,448.6,-457.2,460.8,-466.8,472.3]
  ],
  ['',
    [-264,399.5,-259.2,413.8,-256.8,421.1]
  ],
  ['',
    [-369,557.1,-387.9,573.1]
  ],
  ['',
    [-783,590.4,-753.9,580.6]
  ],
  ['',
    [-1048.3,669.2,-1070.6,688]
  ],
  ['',
    [-961.7,782.4,-979.4,797.5]
  ],
  ['',
    [-841.1,927.1,-858.4,941.5]
  ],
  ['',
    [-761,1022.1,-778.6,1037.1]
  ],
  ['',
    [-1338.3,778.7,-1300.2,765.5,-1295,763.7]
  ],
];

// ---- surveyed island beaches (natural=beach / natural=sand inside the island chain).
const BEACHES = [
  ['Gibraltar Point Beach',
    [529.6,2422.7,516.4,2430.1,491.3,2446.7,468.4,2469.7,456.6,2480.3,441.3,2489.1,417.4,2502.5,
    395.1,2511,385,2513.3,382.3,2513.9,388,2533.7,380.6,2536.4,361.8,2536.3,338.3,2539,315.8,
    2541.2,297.6,2540,279.2,2538.6,252.6,2539,231.3,2543,213.9,2543.3,192.4,2543.1,169.6,2546.5,
    147,2550.1,130.3,2553.2,115.3,2558.5,106.3,2565.2,96.6,2569.9,91.9,2568.7,84.9,2563.4,70.2,
    2558.9,61.2,2559.1,51,2557.8,38.8,2557,22.8,2556.4,2.8,2549.9,-12.4,2550.7,-23.3,2552.2,
    -34.4,2550.6,-54.6,2554.3,-71.5,2564,-82,2571,-93.1,2577.2,-102.1,2585.9,-111.8,2572.8,
    -123.7,2554.2,-128.6,2552.4,-141.1,2555.4,-144.7,2550.1,-140.1,2548.3,-132.9,2545.4,-125,
    2541.3,-113.2,2533.7,-104.1,2533.5,-96.8,2533.4,-84.9,2531.2,-70.9,2531.9,-51.1,2528.3,
    -21.8,2529.3,-8.3,2529.3,-3.5,2529.2,2.4,2529,9.3,2537.1,47.1,2542.3,84.2,2541.2,111.6,2540,
    151.4,2535.4,169.2,2532.6,190.1,2532.8,200,2527.7,212.4,2525.6,227,2528,247.4,2522,261.8,
    2523,284.9,2521.3,286,2517.3,323.2,2509.6,327.8,2509.3,328,2513.7,375.2,2507.1,383.7,2500.7,
    408.9,2493,410.3,2491.8,412.5,2490.1,414.4,2488.5,426.3,2476.1,426.7,2453.3,434.9,2445.4,
    429.2,2433.6,423.7,2432.5,419.9,2429.7,440.4,2422.5,440.8,2428.4,451.6,2435.1,457.2,2432,
    460.2,2413,492.3,2398.8,506.1,2393.1,523.2,2385.2,531.7,2391.7,553.1,2386.3,564.4,2377.6,
    575.5,2370.4,588,2364.5,609.9,2362.8,623.6,2365.3,626.6,2369.3,625.8,2372.4,616.7,2381,
    602.8,2394.5,592.8,2399.6,569.8,2405.3,549.7,2412.5,529.6,2422.7]
  ],
  ['Bayview Beach',
    [2413.9,294.7,2419,296.7,2423.5,306,2424.3,314.1,2425.2,322.9,2429.7,332,2433.7,334.1,
    2425.1,364.2,2423.2,371.1,2417,391.3,2399.4,397.8,2392.3,401.5,2378.7,397.3,2388.8,390.5,
    2395.5,383.4,2403.6,370.6,2409.1,353.8,2412.2,317,2413.2,300.7,2413.9,294.7]
  ],
  ['',
    [1236.9,1462,1241.5,1466.6,1251,1461.9,1252.5,1457.6,1263.7,1456.5,1265.9,1452.9,1266.6,
    1448.5,1268.5,1438,1265.9,1428.1,1256.8,1426.3,1252.8,1425.8,1252.5,1427.6,1246.9,1433.4,
    1244.5,1439,1247.3,1443.2,1246,1449.3,1244.8,1453.9,1240.8,1458.3,1236.9,1462]
  ],
  ['',
    [1907.4,1286.9,1902.8,1283.4,1900.5,1277.9,1903.6,1279.5,1906.6,1279.6,1909.2,1277.2,1908.6,
    1274.7,1906.5,1272.3,1903.9,1272.3,1903.8,1270.4,1905.8,1268.4,1907.8,1267.8,1910.5,1266.2,
    1914.2,1266,1921,1268.1,1926.2,1270.5,1929.1,1271.6,1924.7,1275.9,1913.1,1281.5,1907.4,
    1286.9]
  ],
  ['',
    [2844.8,527.1,2852.4,530,2851.9,532.9,2855.6,540,2857.4,547.2,2855.3,548.3,2852,549.7,
    2852.8,540.4,2847.4,531.7,2843.5,532.9,2823.7,540.3,2813.5,546.3,2803.3,542.6,2784.4,541.1,
    2844.8,527.1]
  ],
  ['',
    [1253.2,1404.5,1260.3,1402.8,1266.7,1401.8,1270.1,1402.6,1269.7,1406.2,1266.1,1405.6,1263.8,
    1417.6,1258.6,1416.8,1259.4,1411.7,1256.7,1409.7,1253.6,1409.4,1253.2,1404.5]
  ],
  ['Secret Beach',
    [1838.9,1137.6,1854.3,1134.8,1864.2,1133.7,1871.5,1131.6,1871.2,1136.8,1859.7,1143.6,1849.9,
    1153,1853.4,1175.3,1847.9,1179.6,1842.2,1177,1831.3,1168.4,1810.4,1178,1805.1,1163.8,1802.2,
    1160.1,1796,1158.7,1800.4,1150.2,1800.9,1143.1,1790.6,1139.5,1809,1133.6,1816,1127.7,1813.8,
    1135.8,1816.6,1141.2,1823.7,1143.6,1838.9,1137.6]
  ],
  ['',
    [-1536.6,66.7,-1528.1,61.8,-1518.5,59.6,-1515,60.1,-1511.2,61.5,-1505.9,66.1,-1502.8,73.4,
    -1503,92.6,-1516.9,93,-1532.4,93.4,-1535.4,91,-1536.2,75,-1536.6,66.7]
  ],
  ['',
    [-872.6,46,-878.2,46.2,-884.5,46.8,-888.3,47.6,-893,50.6,-895.7,55.2,-897,58.7,-897.7,63,
    -895.6,67.5,-893.1,70.9,-890.8,73.8,-886.2,74.8,-884.4,75.1,-883.7,76.4,-881.3,75.5,-867.2,
    70.5,-865.3,64.5,-870.5,51.4,-872.6,46]
  ],
  ['',
    [2532.9,173.3,2529.7,180,2530.1,187.2,2531.6,192.6,2536.7,198.1,2543.9,200.4,2551.1,200.5,
    2556.8,197.3,2559.8,192.9,2554.4,192.6,2548.6,191.7,2542.6,190.1,2537.8,185.2,2534.8,179.9,
    2532.9,173.3]
  ],
  ['',
    [2729,93.3,2735,100.5,2707.9,129.7,2695.6,140.2,2689.5,137.9,2704.2,125.6,2729,93.3]
  ],
  ['',
    [2637.1,166.4,2615.7,176.1,2623.3,180.7,2625.2,184,2625.2,188.7,2622.8,193.8,2635.3,201,
    2641.3,186.2,2637.1,166.4]
  ],
  ['',
    [2179.4,1013.8,2184.4,1018.2,2185.2,1019.6,2173.4,1028.1,2164.7,1020.4,2169.9,1017.6,2175.2,
    1014.7,2179.4,1013.8]
  ],
];

// ---- route=ferry ways from the OSM water extract; the endpoints are the docks.
const FERRY_ROUTES = [
  ['Toronto City Centre Airport Ferry',
    [-864,125.5,-770.3,250.6,-745.6,284.9]
  ],
  ['Toronto - Centre Island',
    [691.8,1394.5,709.3,1361.3,741.5,1319.3,750.2,1283.5,791.9,1140,843,1006.9,890.2,882.8,
    922.4,758.3,938.9,699.7,949,635.5,947.8,592.1,944.4,521,975.9,339.3,1009.5,144.3,1027.2,
    33.5,1046.8,-49.4,1053.8,-157.2,1045,-240.1,1036.6,-323.4,1005.3,-455.1,977.4,-530.7,955.8,
    -574.5]
  ],
  ['Toronto - Wards Island',
    [2355.1,399,2221.2,352,2098.5,246,1941.5,35.9,1873.7,-3,1518.9,-108,1254.5,-208.7,1150.6,
    -274.9,1061.8,-417.9,971.9,-501.2,939.8,-566.5]
  ],
  ['Toronto - Hanlans Point',
    [971.4,-582.2,1005.2,-520.3,1030.7,-460.3,1032.9,-415.5,997.6,-345.1,920.2,-262.1,850.7,
    -186.9,791.7,-125.4,699.8,-28.9,598.3,86.3,454.3,238.2,249.2,459.7,-72.7,682.7,-115.3,724.2,
    -134,751.7,-161.6,786.5,-166.5,791.8]
  ],
  ['East-West Shuttle',
    [2723.5,-971.5,2714,-935.4,2411.5,-760,1320.1,-547.7,1106.9,-528,1039.2,-616.5,1058.2,
    -647.7,1037.5,-617.6,1091.3,-515.4,1047.1,-368,323.8,-87.6,-524.6,41.4,-658.4,-8.7,-759.8,
    -138.8,-785.6,-141.7]
  ],
];

// ---- Centreville rides (attraction=* ways).
const RIDES = [
  ['log_flume', 'Log Flume Ride',
    [1158.2,1569.9,1160,1569.6,1165.6,1568.1,1166.7,1567.8,1167.7,1568,1168.5,1568.5,1169,
    1569.4,1171.2,1575.9,1171.8,1577.4,1173,1578.4,1178.9,1579.7,1180.3,1579.9,1181.8,1579.4,
    1196.7,1574.9,1198.1,1574.8,1199.7,1575.7,1200.8,1577,1202.5,1577.9,1204.4,1578.1,1206,
    1577.7,1207.1,1576.8,1207.8,1575.7,1208.3,1573.9,1208.3,1572.1,1207.8,1570.9,1207.2,1570.1,
    1206.3,1569.5,1205,1568.9,1133.1,1552.2,1130.8,1552.6,1129,1553.8,1128.1,1555.5,1128,1557.1,
    1128.4,1558.8,1129.4,1560.2,1134.5,1564.6,1158.2,1569.9]
  ],
  ['car_ride', 'Touring Cars',
    [1142.5,1642.9,1142.4,1642.2,1142.2,1641.6,1141.8,1641.1,1141.2,1640.7,1140.6,1640.5,1139.9,
    1640.5,1138.1,1640.7,1135.5,1641,1133.2,1642.1,1130.9,1643.1,1129.3,1643,1127.5,1642,1125.5,
    1641.1,1122.9,1641.6,1120.9,1642.3,1119.9,1643.6,1119.9,1645,1120.1,1646.4,1120.8,1647.5,
    1120.9,1648.4,1120.7,1649.3,1120.2,1650.1,1119.5,1650.7,1118.6,1651,1117.7,1651,1116.9,
    1650.7,1116.1,1650.2,1115.6,1649.5,1115.4,1648.6,1115.4,1647.7,1115.6,1645.2,1115.5,1644.4,
    1115.1,1643.7,1114.5,1643.2,1113.7,1642.8,1112.9,1642.8,1112.1,1643,1111.4,1643.4,1110.9,
    1644.1,1110.7,1644.9,1109.7,1651.1,1110.3,1652.2,1111.2,1653,1112.3,1653.5,1113.5,1653.7,
    1114.8,1653.5,1117.8,1652.5,1118.7,1652.3,1119.6,1652.3,1120.5,1652.6,1121.3,1653.1,1123.2,
    1654.7,1124.1,1654.8,1125.1,1654.6,1125.9,1654.2,1126.5,1653.5,1126.9,1652.6,1127,1651.6,
    1126.8,1650.7,1126.3,1649.9,1122.6,1648.2,1122,1647.5,1121.7,1646.7,1121.6,1645.9,1121.7,
    1645,1122.1,1644.3,1122.7,1643.7,1123.5,1643.3,1124.4,1643.2,1125.2,1643.3,1129.9,1645.6,
    1130.4,1646.3,1130.7,1647.1,1130.7,1648,1130.5,1648.8,1130.1,1649.5,1128.5,1651.9,1128.3,
    1652.8,1128.3,1653.7,1128.6,1654.6,1129.2,1655.3,1130,1655.8,1130.9,1656,1131.9,1655.9,
    1132.7,1655.6,1133.4,1654.9,1133.9,1654.1,1134,1653.2,1133.9,1652.3,1133.4,1651.2,1132.9,
    1650.1,1133.6,1644.5,1133.9,1643.7,1134.5,1643,1135.3,1642.5,1136.2,1642.2,1137.1,1642.3,
    1137.9,1642.7,1138.6,1643.3,1139,1644.1,1139.2,1645,1139,1645.9,1138.6,1646.8,1136,1651,
    1135.7,1654,1135.8,1654.9,1136.2,1655.7,1136.9,1656.4,1137.7,1656.8,1138.6,1656.9,1139.5,
    1656.7,1140.3,1656.2,1140.9,1655.5,1141.2,1654.6,1141.5,1653.2]
  ],
  ['car_ride', 'Antique Cars',
    [1054.4,1588.7,1052.1,1586.6,1048.9,1584.6,1046.2,1584.3,1043.4,1584.8,1040.7,1586.2,1038.2,
    1589.2,1029.2,1598.7,1027.4,1601.8,1025.9,1602.8,1020.5,1608.5,1019.5,1611.2,1018.8,1613.9,
    1017.5,1615.9,1015.4,1617.8,1013.5,1618.6,1011.2,1619.1,1008.7,1620.7,1007.5,1622.6,1006.6,
    1625,1006.2,1626.9,1006.3,1629,1006.7,1631.2,1008.2,1633.8,1010.4,1635.7,1013.3,1636.5,
    1016.5,1637,1019,1637.8,1020.9,1639.7,1023.8,1641.9,1027,1642.6,1030.2,1642.1,1032.6,1640.9,
    1034.4,1639.2,1035.9,1637,1036.3,1634.7,1036.3,1632.3,1035.1,1629.2,1033.9,1627.1,1031.2,
    1625.3,1027.9,1624.3,1025.3,1622.4,1023.7,1619.9,1022.9,1615.8,1023.5,1612.5,1025.1,1608.8,
    1026.5,1606.2,1031.2,1601.4,1032,1600.1,1038,1594.5,1040.7,1593.7,1043.9,1593.6,1046.4,
    1594.1,1049,1595.5,1050.6,1598,1051.5,1600.7,1051.2,1603.3,1051.1,1606,1051.8,1609,1053.6,
    1611.7,1056.2,1613.4,1059.3,1614.3,1062.2,1614.1,1065.8,1612.1,1067.6,1609.5,1068.5,1606.4,
    1068.4,1604.3,1068.1,1602.2,1065.9,1598.9]
  ],
  ['car_ride', 'Touring Cars',
    [1141.5,1653.2,1142.5,1642.9]
  ],
  ['car_ride', 'Antique Cars',
    [1065.9,1598.9,1054.4,1588.7]
  ],
  ['car_ride', 'Fire Engines',
    [1086.8,1589.5,1080.3,1584.8]
  ],
  ['car_ride', 'Fire Engines',
    [1080.3,1584.8,1079.5,1584.7,1077.3,1584.7,1066.5,1585.4,1065.4,1585.9,1064.7,1586.8,1064.3,
    1588.1,1064.8,1589.6,1065.8,1590.7,1071.5,1595.6,1072.4,1596.7,1073.1,1598.4,1073.8,1599.5,
    1075.3,1601.2,1076.6,1602.1,1077.4,1602.6,1078.8,1602.4,1080.1,1601.8,1080.9,1600.3,1080.8,
    1599,1080,1597.8,1075.7,1594.6,1074.1,1594.5,1072,1594.5,1070.5,1593.9,1067.5,1590.1,1067.7,
    1588.5,1068.7,1587,1071.1,1586.2,1077.5,1586,1079,1586.4,1084.4,1590.9,1084.9,1591.8,1085,
    1592.7,1084.9,1594,1084.1,1594.9,1083,1595.6,1081.5,1595.6,1080.6,1595.2,1079.8,1594.2,
    1079.7,1593.1,1079.3,1589.6,1079,1588.7,1078.3,1587.9,1077.2,1587.4,1073.8,1587.7,1072.7,
    1588.1,1071.6,1588.9,1071.3,1590,1071.3,1591.1,1071.6,1592.1,1072.4,1592.8,1073.4,1593.2,
    1076,1593.2,1076.7,1593.4,1077.4,1594,1080.6,1597,1081.5,1597.4,1082.8,1597.6,1084,1597.3,
    1084.8,1596.6,1087.6,1593,1088,1592.2,1087.8,1591,1087.4,1590,1086.8,1589.5]
  ],
];

const AERO_HANGAR = [
  ['Hangar 1',
    [-628.4,241.6,-636.4,230.9,-657.7,202.2,-643.2,191.3,-647.6,185.4,-638.8,178.8,-637.3,180.9,
    -633.7,178.3,-631.1,181.9,-627.2,179,-615.2,195.2,-613.1,193.6,-605.9,203.3,-607.9,204.8,
    -597.6,218.7,-628.4,241.6]
  ],
  ['Billy Bishop Airport Hangar',
    [-882.5,369.8,-856.6,404.1,-855.6,405.4,-851.2,402.3,-849.2,404.8,-892.7,438.1,-905.7,448,
    -904.3,449.7,-921.7,462.9,-937.3,474.6,-940.2,493.8,-952.1,478.4,-980.9,439.8,-936.7,406.7,
    -934.9,409,-907.5,388.4,-905.9,390.9,-901.5,387.5,-903.8,384.4,-903.6,382.2,-899.8,379.3,
    -897.7,379.6,-896.3,381.7,-892.3,378.6,-891.7,373.9,-885.3,369.3,-882.5,369.8]
  ],
  ['Hangar 4',
    [-806.7,312.9,-792.3,332.5,-781,347.6,-786,351.3,-852.3,400.9,-856.6,404.1,-882.5,369.8,
    -806.7,312.9]
  ],
  ['',
    [-689.2,220.8,-662,200.6,-638.3,232.4,-670,256.1,-671.6,257.3,-672.9,255.5,-666.7,250.9,
    -689.2,220.8]
  ],
];


/* ------------------------------------------------------------ small helpers */

// [x, z, x, z, ...] -> [[x, z], ...]. The baked tables are flat because a flat literal is a
// third of the bytes of an array of pairs and parses in a fraction of the time.
function pairs(flat) {
  const out = new Array(flat.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = [flat[i * 2], flat[i * 2 + 1]];
  return out;
}

// A uniform grid over line segments, for nearest-segment queries. Every segment is inserted into
// each cell its bounding box touches once inflated by `reach`, so a lookup within `reach` reads
// exactly one cell and the whole thing stays linear in feature count (CONTRACT 8.4).
function makeSegIndex(rect, cell, reach) {
  const x0 = rect[0] - reach * 2, z0 = rect[1] - reach * 2;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + reach * 4) / cell));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + reach * 4) / cell));
  return { x0, z0, cell, reach, nx, nz, cells: new Array(nx * nz), seg: [], count: 0 };
}

function addSeg(G, ax, az, bx, bz, tag) {
  if (!isNum(ax) || !isNum(az) || !isNum(bx) || !isNum(bz)) return;
  const k = G.seg.length;
  G.seg.push(ax, az, bx, bz, tag);
  G.count++;
  const i0 = clamp(Math.floor((Math.min(ax, bx) - G.reach - G.x0) / G.cell), 0, G.nx - 1);
  const i1 = clamp(Math.floor((Math.max(ax, bx) + G.reach - G.x0) / G.cell), 0, G.nx - 1);
  const j0 = clamp(Math.floor((Math.min(az, bz) - G.reach - G.z0) / G.cell), 0, G.nz - 1);
  const j1 = clamp(Math.floor((Math.max(az, bz) + G.reach - G.z0) / G.cell), 0, G.nz - 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * G.nx + i;
      if (!G.cells[c]) G.cells[c] = [];
      G.cells[c].push(k);
    }
  }
}

function addWay(G, p, tag, closeIt) {
  if (!Array.isArray(p) || p.length < 2) return;
  for (let i = 1; i < p.length; i++) addSeg(G, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], tag);
  if (closeIt) {
    const a = p[p.length - 1], b = p[0];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) addSeg(G, a[0], a[1], b[0], b[1], tag);
  }
}

const _seg = { d: Infinity, tag: 0 };

// Nearest segment within the index's reach. Fills and returns the module-scope _seg, or null.
function nearSeg(G, x, z) {
  if (!G || !isNum(x) || !isNum(z)) return null;
  const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((z - G.z0) / G.cell);
  if (i < 0 || i >= G.nx || j < 0 || j >= G.nz) return null;
  const list = G.cells[j * G.nx + i];
  if (!list) return null;
  const s = G.seg;
  let best = Infinity, tag = 0;
  for (let k = 0; k < list.length; k++) {
    const o = list[k];
    const d = distToSeg(x, z, s[o], s[o + 1], s[o + 2], s[o + 3]);
    if (d < best) { best = d; tag = s[o + 4]; }
  }
  if (best > G.reach) return null;
  _seg.d = best; _seg.tag = tag;
  return _seg;
}

// Ring index: which of a set of polygons contains a point. Same grid trick, bbox-bucketed.
function makeRingIndex(polys, rect, cell) {
  const x0 = rect[0] - cell, z0 = rect[1] - cell;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + cell * 2) / cell));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + cell * 2) / cell));
  const cells = new Array(nx * nz);
  for (let p = 0; p < polys.length; p++) {
    const bb = polys[p].bbox;
    const i0 = clamp(Math.floor((bb[0] - x0) / cell), 0, nx - 1);
    const i1 = clamp(Math.floor((bb[2] - x0) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((bb[1] - z0) / cell), 0, nz - 1);
    const j1 = clamp(Math.floor((bb[3] - z0) / cell), 0, nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (!cells[c]) cells[c] = [];
        cells[c].push(p);
      }
    }
  }
  return { x0, z0, cell, nx, nz, cells, polys };
}

function ringAt(R, x, z, pad) {
  if (!R || !isNum(x) || !isNum(z)) return -1;
  const i = Math.floor((x - R.x0) / R.cell), j = Math.floor((z - R.z0) / R.cell);
  if (i < 0 || i >= R.nx || j < 0 || j >= R.nz) return -1;
  const list = R.cells[j * R.nx + i];
  if (!list) return -1;
  const m = isNum(pad) ? pad : 0;
  for (let k = 0; k < list.length; k++) {
    const P = R.polys[list[k]];
    if (x < P.bbox[0] - m || x > P.bbox[2] + m || z < P.bbox[1] - m || z > P.bbox[3] + m) continue;
    if (pointInRing(P.p, x, z)) return list[k];
    if (m > 0 && distToPoly(x, z, P.p) <= m) return list[k];
  }
  return -1;
}

function boxHit(bb, x0, z0, x1, z1) {
  return !(bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1);
}

// True bearing of a -> b, in degrees clockwise from north. World north is -z.
function bearingOf(ax, az, bx, bz) {
  const d = Math.atan2(bx - ax, -(bz - az)) * 180 / Math.PI;
  return d < 0 ? d + 360 : d;
}

/* -------------------------------------------------------------- island edge */

// One closed run of island shore: a resampled loop with an outward (water-side) normal, a mitre,
// the classification and the mantle cross-section at every station.
function buildIsleRun(ring, field) {
  const raw = resample(ring, ISLE_STATION);
  // resample() keeps the ring's duplicated last point; the run is a LOOP, so drop it and let the
  // indices wrap. A loop has no ends, which is what stops a seam opening at the ring's start.
  let n = raw.length;
  if (n > 3 && Math.hypot(raw[0][0] - raw[n - 1][0], raw[0][1] - raw[n - 1][1]) < 0.25) n--;
  if (n < 8) return null;
  const run = {
    n,
    x: new Float64Array(n), z: new Float64Array(n),
    nx: new Float64Array(n), nz: new Float64Array(n),
    mx: new Float64Array(n), mz: new Float64Array(n),
    g: new Float64Array(n), e: new Float64Array(n),
    bw: new Float64Array(n), fw: new Float64Array(n), tw: new Float64Array(n),
    fr: new Float64Array(n), td: new Float64Array(n),
    bk: new Float64Array(n), to: new Float64Array(n), te: new Float64Array(n),
    kind: new Uint8Array(n), open: new Float32Array(n), hard: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) { run.x[i] = raw[i][0]; run.z[i] = raw[i][1]; }

  const sx = new Float64Array(n), sz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    let tx = run.x[b] - run.x[a], tz = run.z[b] - run.z[a];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    sx[i] = tx; sz[i] = tz;
    run.nx[i] = -tz; run.nz[i] = tx;
  }
  // Which side is the water? One vote per sampled station, majority wins, exactly as the mainland
  // runs do it: a single ambiguous station at a slip mouth cannot flip a whole island.
  let vote = 0;
  const stride = Math.max(1, Math.floor(n / 96));
  for (let i = 0; i < n; i += stride) {
    const a = waterAt(field, run.x[i] + run.nx[i] * 5, run.z[i] + run.nz[i] * 5);
    const b = waterAt(field, run.x[i] - run.nx[i] * 5, run.z[i] - run.nz[i] * 5);
    if (a && !b) vote++;
    else if (b && !a) vote--;
  }
  if (vote < 0) {
    for (let i = 0; i < n; i++) { run.nx[i] = -run.nx[i]; run.nz[i] = -run.nz[i]; }
  }
  const flip = vote < 0 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = i;
    let ax = -sz[a] * flip, az = sx[a] * flip;
    let bx = -sz[b] * flip, bz = sx[b] * flip;
    let mx = ax + bx, mz = az + bz;
    const l2 = mx * mx + mz * mz;
    if (l2 > 1e-6) {
      mx = mx * 2 / l2; mz = mz * 2 / l2;
      const ml = Math.hypot(mx, mz);
      if (ml > 2.4) { mx = mx * 2.4 / ml; mz = mz * 2.4 / ml; }
    } else { mx = run.nx[i]; mz = run.nz[i]; }
    run.mx[i] = mx; run.mz[i] = mz;
  }
  return run;
}

// Smooth a per-station array round a LOOP, so the ring's start point is not a discontinuity.
function smoothLoop(a, n, half, passes) {
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let acc = 0, w = 0;
      for (let k = -half; k <= half; k++) { acc += a[(i + k + n * 4) % n]; w++; }
      tmp[i] = w > 0 ? acc / w : a[i];
    }
    a.set(tmp);
  }
}

// How far the open water runs out along the station normal. Anything at OPEN_LAKE is a lake
// shore and gets sand; a lagoon bank hits the far side within a few tens of metres.
function openWater(field, x, z, nx, nz) {
  let t = OPEN_STEP;
  for (; t <= OPEN_LAKE; t += OPEN_STEP) {
    if (!waterAt(field, x + nx * t, z + nz * t)) return t - OPEN_STEP;
  }
  return OPEN_LAKE;
}


/* ------------------------------------------------------------------- model */

/**
 * Read the islands, the airfield and the ferry routes out of the extract and the baked survey.
 * Pure: no geometry, no mutation. Called from buildHarbour() once the water field exists.
 */
function buildIslands(H, data, innerChains) {
  const rect = H.rect;
  const T = H.terrain;
  const wY = H.waterY;

  /* --- 1. the island rings ------------------------------------------------------------- */
  const rings = [];
  let landArea = 0, shoreMetres = 0;
  for (let i = 0; i < innerChains.length; i++) {
    const ch = innerChains[i];
    if (!Array.isArray(ch) || ch.length < 4) continue;
    const ar = Math.abs(planArea(ch));
    if (ar < ISLE_MIN_AREA) continue;
    const bb = bboxOf(ch);
    if (!boxHit(bb, rect[0], rect[1], rect[2], rect[3])) continue;
    rings.push({ p: ch, bbox: bb, area: ar });
    landArea += ar;
    shoreMetres += polyLength(ch);
  }
  const isle = {
    rings, runs: [], index: null, bbox: [Infinity, Infinity, -Infinity, -Infinity],
    beaches: [], beachIdx: null, air: null, docks: [], rides: [], bridges: [],
    landArea, shoreMetres, waterY: wY,
    stats: {
      islands: rings.length, landArea, shoreMetres,
      beachMetres: 0, ripMetres: 0, wallMetres: 0, stations: 0,
      airRunways: 0, airTaxiways: 0, airAprons: 0, airStands: 0, airPaveArea: 0,
      ferryDocks: 0, rides: 0, bridges: 0, flattened: 0,
    },
  };
  if (!rings.length) return isle;
  for (let i = 0; i < rings.length; i++) {
    const bb = rings[i].bbox;
    if (bb[0] < isle.bbox[0]) isle.bbox[0] = bb[0];
    if (bb[1] < isle.bbox[1]) isle.bbox[1] = bb[1];
    if (bb[2] > isle.bbox[2]) isle.bbox[2] = bb[2];
    if (bb[3] > isle.bbox[3]) isle.bbox[3] = bb[3];
  }
  const IB = isle.bbox;
  const irect = [IB[0] - 120, IB[1] - 120, IB[2] + 120, IB[3] + 120];

  /* --- 2. what makes an edge ENGINEERED rather than natural ---------------------------- */
  // A surveyed structure, a paved road or a building close to the water means somebody has
  // already hardened that edge, and a beach there would be an invention contradicting the
  // survey. Footways are deliberately NOT in here: the island trails run along the top of the
  // beaches and hardening under them would pave the whole south shore.
  const hard = makeSegIndex(irect, 26.0, HARD_NEAR + 2);
  const front = Array.isArray(data && data.waterfront) ? data.waterfront : [];
  for (let i = 0; i < front.length; i++) {
    const w = front[i];
    if (!w || !Array.isArray(w.p) || w.p.length < 2) continue;
    if (w.k === 'breakwater' || w.k === 'groyne') continue;      // offshore, not an island edge
    if (!boxHit(bboxOf(w.p), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, w.p, 1, false);
  }
  const roads = Array.isArray(data && data.roads) ? data.roads : [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.c === 'foot') continue;
    if (!boxHit(bboxOf(r.p), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, r.p, 2, false);
  }
  const blds = Array.isArray(data && data.buildings) ? data.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const r0 = blds[i] && Array.isArray(blds[i].r) ? blds[i].r[0] : null;
    if (!Array.isArray(r0) || r0.length < 3) continue;
    if (!boxHit(bboxOf(r0), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, r0, 3, true);
  }

  /* --- 3. the surveyed beaches --------------------------------------------------------- */
  for (let i = 0; i < BEACHES.length; i++) {
    const p = pairs(BEACHES[i][1]);
    if (p.length < 4) continue;
    isle.beaches.push({ name: BEACHES[i][0], p, bbox: bboxOf(p) });
  }
  isle.beachIdx = makeRingIndex(isle.beaches, irect, 64);

  /* --- 4. the runs, and what every metre of shore IS ----------------------------------- */
  for (let i = 0; i < rings.length; i++) {
    const run = buildIsleRun(rings[i].p, H.field);
    if (run) isle.runs.push(run);
  }
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const n = run.n;
    isle.stats.stations += n;
    for (let i = 0; i < n; i++) {
      const x = run.x[i], z = run.z[i];
      const h = nearSeg(hard, x, z);
      run.hard[i] = h ? h.d : 999;
      run.open[i] = openWater(H.field, x, z, run.nx[i], run.nz[i]);
      const onBeach = ringAt(isle.beachIdx, x, z, 9.0) >= 0;
      run.kind[i] = onBeach ? EDGE_BEACH
        : (run.hard[i] < HARD_NEAR ? EDGE_WALL
          : (run.open[i] >= OPEN_LAKE ? EDGE_BEACH : EDGE_RIP));
    }
    // Median filter round the loop: a single station that happens to sit under a jetty must not
    // punch a two-metre seawall through fifty metres of sand.
    const src = run.kind.slice();
    for (let i = 0; i < n; i++) {
      let c0 = 0, c1 = 0, c2 = 0;
      for (let k = -3; k <= 3; k++) {
        const v = src[(i + k + n * 4) % n];
        if (v === EDGE_RIP) c0++; else if (v === EDGE_BEACH) c1++; else c2++;
      }
      run.kind[i] = c2 >= c1 && c2 >= c0 ? EDGE_WALL : (c1 >= c0 ? EDGE_BEACH : EDGE_RIP);
    }
    // The cross-section. The PROFILE is continuous even where the classification is not: the
    // five offsets are smoothed along the run, so a beach tapers into a seawall over a few
    // stations instead of leaving a hole at the join. Only the MATERIAL changes abruptly, which
    // is what a real transition looks like.
    for (let i = 0; i < n; i++) {
      const k = run.kind[i];
      if (k === EDGE_BEACH) {
        // Beach width wanders on a 60 m scale, hashed on world position so it is the same beach
        // whichever tile asks.
        const hx = Math.round(run.x[i] / 60) * 60, hz = Math.round(run.z[i] / 60) * 60;
        run.bw[i] = BEACH_BACK_MIN + (BEACH_BACK - BEACH_BACK_MIN) * hash01(hx, hz);
        run.fw[i] = BEACH_FACE * (0.72 + 0.5 * hash01(hz, hx));
        run.tw[i] = BEACH_TOE;
        run.fr[i] = BEACH_FREE;
        run.td[i] = BEACH_TOE_DROP;
      } else if (k === EDGE_WALL) {
        run.bw[i] = WALL_BACK; run.fw[i] = WALL_FACE; run.tw[i] = WALL_TOE;
        run.fr[i] = WALL_FREE; run.td[i] = WALL_TOE_DROP;
      } else {
        run.bw[i] = RIP_BACK; run.fw[i] = RIP_FACE; run.tw[i] = RIP_TOE;
        run.fr[i] = RIP_FREE; run.td[i] = RIP_TOE_DROP;
      }
    }
    smoothLoop(run.bw, n, 3, 2);
    smoothLoop(run.fw, n, 3, 2);
    smoothLoop(run.tw, n, 3, 2);
    smoothLoop(run.fr, n, 2, 2);
    smoothLoop(run.td, n, 2, 2);
    for (let i = 0; i < n; i++) {
      const seg = Math.hypot(run.x[(i + 1) % n] - run.x[i], run.z[(i + 1) % n] - run.z[i]);
      if (run.kind[i] === EDGE_BEACH) isle.stats.beachMetres += seg;
      else if (run.kind[i] === EDGE_WALL) isle.stats.wallMetres += seg;
      else isle.stats.ripMetres += seg;
    }
  }
  isle.index = makeIsleIndex(isle.runs, irect);

  /* --- 5. Billy Bishop ----------------------------------------------------------------- */
  isle.hard = hard;
  isle.air = buildAirport(T, wY, H.field);
  // Report what the airfield actually is. These counters were declared and never written, so
  // every log line and every doc that quoted them said Billy Bishop had no runways, no taxiways
  // and no pavement while the geometry was being built and drawn perfectly well.
  if (isle.air) {
    const A = isle.air;
    for (let i = 0; i < A.ways.length; i++) {
      const w = A.ways[i];
      if (w.kind === 'runway') isle.stats.airRunways++;
      else if (w.kind === 'taxiway') isle.stats.airTaxiways++;
      isle.stats.airPaveArea += w.len * w.hw * 2;
    }
    for (let i = 0; i < A.aprons.length; i++) isle.stats.airPaveArea += A.aprons[i].area;
    isle.stats.airAprons = A.aprons.length;
    isle.stats.airStands = A.stands.length;
  }

  /* --- 6. the ferry docks -------------------------------------------------------------- */
  isle.docks = buildFerryDocks(H, isle);

  /* --- 7. Centreville ------------------------------------------------------------------ */
  for (let i = 0; i < RIDES.length; i++) {
    const p = pairs(RIDES[i][2]);
    if (p.length < 2) continue;
    const bb = bboxOf(p);
    const w = bb[2] - bb[0], d = bb[3] - bb[1];
    if (w < 3 && d < 3) continue;
    isle.rides.push({
      type: RIDES[i][0], name: RIDES[i][1], p, bbox: bb,
      cx: (bb[0] + bb[2]) * 0.5, cz: (bb[1] + bb[3]) * 0.5,
      w: Math.max(6, w + 4), d: Math.max(6, d + 4),
    });
  }
  isle.stats.rides = isle.rides.length;

  /* --- 8. the bridges between the islands ---------------------------------------------- */
  // Amendment 9.1: every path must lead somewhere, and on the islands the paths cross open
  // water. The extract tags the crossings (bridge=yes over the lagoons); they are collected here
  // so the audit can prove each one is decked, railed and walkable.
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || !r.b || !Array.isArray(r.p) || r.p.length < 2) continue;
    const bb = bboxOf(r.p);
    if (!boxHit(bb, IB[0] - 40, IB[1] - 40, IB[2] + 40, IB[3] + 40)) continue;
    let wet = false;
    for (let k = 1; k < r.p.length && !wet; k++) {
      const mx = (r.p[k - 1][0] + r.p[k][0]) * 0.5, mz = (r.p[k - 1][1] + r.p[k][1]) * 0.5;
      if (waterAt(H.field, mx, mz)) wet = true;
    }
    if (!wet) continue;
    isle.bridges.push({ p: r.p, w: isNum(r.w) ? r.w : 3, name: r.n || '', bbox: bb });
  }
  isle.stats.bridges = isle.bridges.length;
  return isle;
}

// The island edge index. Same shape as the mainland shore index, over LOOPS: segment i runs from
// station i to station (i + 1) % n.
function makeIsleIndex(runs, rect) {
  const x0 = rect[0] - ISLE_REACH * 2, z0 = rect[1] - ISLE_REACH * 2;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + ISLE_REACH * 4) / ISLE_GRID));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + ISLE_REACH * 4) / ISLE_GRID));
  const cells = new Array(nx * nz);
  let count = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    for (let i = 0; i < run.n; i++) {
      const j = (i + 1) % run.n;
      const ax = run.x[i], az = run.z[i], bx = run.x[j], bz = run.z[j];
      const i0 = clamp(Math.floor((Math.min(ax, bx) - ISLE_REACH - x0) / ISLE_GRID), 0, nx - 1);
      const i1 = clamp(Math.floor((Math.max(ax, bx) + ISLE_REACH - x0) / ISLE_GRID), 0, nx - 1);
      const j0 = clamp(Math.floor((Math.min(az, bz) - ISLE_REACH - z0) / ISLE_GRID), 0, nz - 1);
      const j1 = clamp(Math.floor((Math.max(az, bz) + ISLE_REACH - z0) / ISLE_GRID), 0, nz - 1);
      for (let b = j0; b <= j1; b++) {
        for (let a = i0; a <= i1; a++) {
          const c = b * nx + a;
          if (!cells[c]) cells[c] = [];
          cells[c].push(r, i);
          count++;
        }
      }
    }
  }
  return { x0, z0, nx, nz, cells, count };
}


/* --------------------------------------------------------------- the airfield */

const MAG_DECL = 10.5;            // magnetic declination at Toronto, degrees west of true

/**
 * Billy Bishop, from the baked aeroway survey. Everything the airfield needs to know about
 * itself: where the pavement is, how high it sits, which end of each runway carries which
 * designator, where the stands are, and where the perimeter fence runs.
 */
function buildAirport(T, wY, field) {
  const A = {
    ways: [], aprons: [], stands: [], holds: [], runways: [], fence: [],
    y: wY + 1.9, bbox: [Infinity, Infinity, -Infinity, -Infinity], index: null,
  };
  const take = (table, kind, hw) => {
    for (let i = 0; i < table.length; i++) {
      const p = pairs(table[i][1]);
      if (p.length < 2) continue;
      A.ways.push({ kind, ref: table[i][0], p, hw, bbox: bboxOf(p), len: polyLength(p) });
    }
  };
  take(AERO_RUNWAY, 'runway', AIR_RUN_HW);
  take(AERO_STOPWAY, 'stopway', AIR_RUN_HW);
  take(AERO_TAXIWAY, 'taxiway', AIR_TAXI_HW);
  for (let i = 0; i < AERO_APRON.length; i++) {
    const p = pairs(AERO_APRON[i][1]);
    if (p.length < 4) continue;
    A.aprons.push({ p, bbox: bboxOf(p), area: Math.abs(planArea(p)) });
  }
  if (!A.ways.length && !A.aprons.length) return null;

  const grow = (bb) => {
    if (bb[0] < A.bbox[0]) A.bbox[0] = bb[0];
    if (bb[1] < A.bbox[1]) A.bbox[1] = bb[1];
    if (bb[2] > A.bbox[2]) A.bbox[2] = bb[2];
    if (bb[3] > A.bbox[3]) A.bbox[3] = bb[3];
  };
  for (let i = 0; i < A.ways.length; i++) grow(A.ways[i].bbox);
  for (let i = 0; i < A.aprons.length; i++) grow(A.aprons[i].bbox);

  // The airfield is a PLANE. A real one is graded flat to a fraction of a per cent, and the
  // terrain grid under this one wanders about half a metre; the median of the surveyed ground
  // under the pavement is the honest level to pick, and carveIslands() brings the grid to it.
  const samples = [];
  for (let i = 0; i < A.ways.length; i++) {
    const p = A.ways[i].p;
    for (let k = 0; k < p.length; k++) samples.push(sampleTerrain(T, p[k][0], p[k][1]));
  }
  for (let i = 0; i < A.aprons.length; i++) {
    const p = A.aprons[i].p;
    for (let k = 0; k < p.length; k++) samples.push(sampleTerrain(T, p[k][0], p[k][1]));
  }
  samples.sort((a, b) => a - b);
  A.y = clamp(samples[samples.length >> 1], wY + 1.1, wY + 5.0);

  const pad = AIR_RUN_HW + AIR_SHOULDER + AIR_BLEND + 8;
  const rect = [A.bbox[0] - pad, A.bbox[1] - pad, A.bbox[2] + pad, A.bbox[3] + pad];
  A.index = makeSegIndex(rect, 44.0, pad);
  for (let i = 0; i < A.ways.length; i++) addWay(A.index, A.ways[i].p, A.ways[i].hw, false);
  A.aprIdx = makeRingIndex(A.aprons, rect, 96);

  /* runway ends and designators. The number painted at a threshold is the magnetic heading you
     fly when you land ON it, so it names the direction AWAY from that end. Which token of
     "08/26" belongs to which end therefore follows from the bearing, not from the point order. */
  for (let i = 0; i < A.ways.length; i++) {
    const w = A.ways[i];
    if (w.kind !== 'runway') continue;
    const a = w.p[0], b = w.p[w.p.length - 1];
    const br = (bearingOf(a[0], a[1], b[0], b[1]) + MAG_DECL + 360) % 360;
    const toks = String(w.ref).split('/');
    let head = '', tail = '';
    for (let k = 0; k < toks.length; k++) {
      const v = parseInt(toks[k], 10);
      if (!isFinite(v)) continue;
      let dd = Math.abs(((v * 10 - br + 540) % 360) - 180);
      if (dd < 60) head = toks[k]; else tail = toks[k];
    }
    if (!head || !tail) { head = toks[0] || ''; tail = toks[1] || ''; }
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (!(L > 1)) continue;
    const ux = dx / L, uz = dz / L;
    A.runways.push({
      ref: w.ref, way: w, len: L, ux, uz,
      // Threshold A is the end you touch down on when landing in the "head" direction.
      thresh: [
        { x: a[0], z: a[1], ux, uz, label: head },
        { x: b[0], z: b[1], ux: -ux, uz: -uz, label: tail },
      ],
    });
  }

  /* stands: the parking-position way runs between the stand and the taxiway. Whichever end is
     on the apron is the stand; the aircraft noses along the way from there. */
  for (let i = 0; i < AERO_STAND.length; i++) {
    const p = pairs(AERO_STAND[i][1]);
    if (p.length < 2) continue;
    const a = p[0], b = p[p.length - 1];
    const aIn = ringAt(A.aprIdx, a[0], a[1], 0) >= 0;
    const bIn = ringAt(A.aprIdx, b[0], b[1], 0) >= 0;
    const stand = (bIn && !aIn) ? b : a;
    const next = (bIn && !aIn) ? p[p.length - 2] : p[1];
    const yaw = Math.atan2(next[0] - stand[0], next[1] - stand[1]);
    A.stands.push({ ref: AERO_STAND[i][0], x: stand[0], z: stand[1], yaw });
  }
  for (let i = 0; i < AERO_HOLD.length; i++) {
    const p = pairs(AERO_HOLD[i][1]);
    if (p.length >= 2) A.holds.push({ p });
  }

  A.fence = airfieldPerimeter(A, field);
  return A;
}

// How far INSIDE the paved surface a point is: positive on pavement, negative off it, in metres.
function airInset(A, x, z) {
  if (!A) return -1e9;
  let best = -1e9;
  const G = A.index;
  const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((z - G.z0) / G.cell);
  if (i >= 0 && i < G.nx && j >= 0 && j < G.nz) {
    const list = G.cells[j * G.nx + i];
    if (list) {
      const s = G.seg;
      for (let k = 0; k < list.length; k++) {
        const o = list[k];
        const v = s[o + 4] - distToSeg(x, z, s[o], s[o + 1], s[o + 2], s[o + 3]);
        if (v > best) best = v;
      }
    }
  }
  const a = ringAt(A.aprIdx, x, z, 0);
  if (a >= 0) {
    const d = distToPoly(x, z, A.aprons[a].p);
    if (d > best) best = d;
  }
  return best;
}

/**
 * The airfield perimeter, as fence segments.
 *
 * Not the edge of the pavement — that would wrap every taxiway individually and fence the grass
 * off from itself. The boundary wanted is the outside of the whole aerodrome, so the pavement is
 * rasterised, dilated by AIR_FENCE_OUT with a chamfer distance transform, clipped to the land,
 * and the contour of THAT is traced by marching squares. Where the airfield runs out of island
 * the contour follows the shoreline, which is exactly where the real fence goes.
 */
function airfieldPerimeter(A, field) {
  const cell = AIR_CELL;
  const pad = AIR_FENCE_OUT + cell * 2;
  const x0 = A.bbox[0] - pad, z0 = A.bbox[1] - pad;
  const nx = Math.max(2, Math.ceil((A.bbox[2] - A.bbox[0] + pad * 2) / cell) + 1);
  const nz = Math.max(2, Math.ceil((A.bbox[3] - A.bbox[1] + pad * 2) / cell) + 1);
  if (nx * nz > 400000) return [];
  const dist = new Float32Array(nx * nz).fill(1e9);
  const wet = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      const k = j * nx + i;
      if (airInset(A, x, z) > -AIR_SHOULDER) dist[k] = 0;
      if (field && waterAt(field, x, z)) wet[k] = 1;
    }
  }
  const D1 = cell, D2 = cell * Math.SQRT2;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let d = dist[k];
      if (j > 0) {
        if (i > 0) d = Math.min(d, dist[k - nx - 1] + D2);
        d = Math.min(d, dist[k - nx] + D1);
        if (i < nx - 1) d = Math.min(d, dist[k - nx + 1] + D2);
      }
      if (i > 0) d = Math.min(d, dist[k - 1] + D1);
      dist[k] = d;
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let d = dist[k];
      if (j < nz - 1) {
        if (i < nx - 1) d = Math.min(d, dist[k + nx + 1] + D2);
        d = Math.min(d, dist[k + nx] + D1);
        if (i > 0) d = Math.min(d, dist[k + nx - 1] + D2);
      }
      if (i < nx - 1) d = Math.min(d, dist[k + 1] + D1);
      dist[k] = d;
    }
  }
  const solid = new Uint8Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) solid[k] = (dist[k] <= AIR_FENCE_OUT && !wet[k]) ? 1 : 0;

  // Marching squares over the cell corners; each case emits the segments joining the midpoints
  // of the cell edges the boundary crosses.
  const out = [];
  const mid = (ax, az, bx, bz) => [(ax + bx) * 0.5, (az + bz) * 0.5];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = solid[j * nx + i], b = solid[j * nx + i + 1];
      const c = solid[(j + 1) * nx + i + 1], d = solid[(j + 1) * nx + i];
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const xa = x0 + i * cell, xb = xa + cell;
      const za = z0 + j * cell, zb = za + cell;
      const T0 = mid(xa, za, xb, za), R0 = mid(xb, za, xb, zb);
      const B0 = mid(xa, zb, xb, zb), L0 = mid(xa, za, xa, zb);
      const push = (p, q) => out.push([p[0], p[1], q[0], q[1]]);
      if (code === 1 || code === 14) push(L0, T0);
      else if (code === 2 || code === 13) push(T0, R0);
      else if (code === 3 || code === 12) push(L0, R0);
      else if (code === 4 || code === 11) push(R0, B0);
      else if (code === 6 || code === 9) push(T0, B0);
      else if (code === 7 || code === 8) push(L0, B0);
      else if (code === 5) { push(L0, T0); push(R0, B0); }
      else if (code === 10) { push(T0, R0); push(B0, L0); }
    }
  }
  return out;
}


/* ------------------------------------------------------------- ferry docks */

/**
 * The ferry docks. The five route=ferry ways END at them, so each endpoint is snapped to the
 * nearest metre of surveyed edge — island or mainland — and a dock is built there facing the
 * water. Brute force over the stations rather than an index: ten endpoints against thirteen
 * thousand stations is nothing, and it cannot miss the way a bounded query can.
 */
function buildFerryDocks(H, isle) {
  const docks = [];
  const put = (px, pz, name) => {
    let best = Infinity, run = null, at = 0, kindIsle = false;
    for (let r = 0; r < isle.runs.length; r++) {
      const q = isle.runs[r];
      for (let i = 0; i < q.n; i++) {
        const d = (q.x[i] - px) * (q.x[i] - px) + (q.z[i] - pz) * (q.z[i] - pz);
        if (d < best) { best = d; run = q; at = i; kindIsle = true; }
      }
    }
    for (let r = 0; r < H.runs.length; r++) {
      const q = H.runs[r];
      for (let i = 0; i < q.n; i++) {
        const d = (q.x[i] - px) * (q.x[i] - px) + (q.z[i] - pz) * (q.z[i] - pz);
        if (d < best) { best = d; run = q; at = i; kindIsle = false; }
      }
    }
    if (!run || best > 240 * 240) return;
    const x = run.x[at], z = run.z[at];
    for (let k = 0; k < docks.length; k++) {
      if (Math.hypot(docks[k].x - x, docks[k].z - z) < 38) return;
    }
    docks.push({ x, z, nx: run.nx[at], nz: run.nz[at], run, at, isle: kindIsle, name });
  };
  for (let i = 0; i < FERRY_ROUTES.length; i++) {
    const p = pairs(FERRY_ROUTES[i][1]);
    if (p.length < 2) continue;
    put(p[0][0], p[0][1], FERRY_ROUTES[i][0]);
    put(p[p.length - 1][0], p[p.length - 1][1], FERRY_ROUTES[i][0]);
  }
  isle.stats.ferryDocks = docks.length;
  return docks;
}

/* ------------------------------------------------------------------- carve */

/**
 * Bring the terrain to the islands: flatten the airfield onto its plane, then read the bank level
 * and the inland edge of the shore mantle off the surveyed ground. Mutates T.h. Called from
 * carveHarbourTerrain() between the lake-bed carve and the deck index, so the mantle levels see
 * the finished grid.
 */
function carveIslands(T, H, isle) {
  if (!isle) return;
  const wY = H.waterY;
  const A = isle.air;
  const F = H.field;

  /* --- the airfield is graded flat ----------------------------------------------------- */
  if (A) {
    const { nx, nz, cell, x0, z0, h } = T;
    const pad = AIR_RUN_HW + AIR_SHOULDER + AIR_BLEND + cell;
    const i0 = clamp(Math.floor((A.bbox[0] - pad - x0) / cell), 0, nx - 1);
    const i1 = clamp(Math.ceil((A.bbox[2] + pad - x0) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((A.bbox[1] - pad - z0) / cell), 0, nz - 1);
    const j1 = clamp(Math.ceil((A.bbox[3] + pad - z0) / cell), 0, nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        if (waterAt(F, x, z)) continue;                // the lake bed is not the airfield's
        const ins = airInset(A, x, z);
        if (ins <= -(AIR_SHOULDER + AIR_BLEND)) continue;
        const f = ins >= -AIR_SHOULDER ? 1
          : clamp((ins + AIR_SHOULDER + AIR_BLEND) / AIR_BLEND, 0, 1);
        const k = j * nx + i;
        h[k] = lerp(h[k], A.y, f * f * (3 - 2 * f));
        if (f > 0.5) isle.stats.flattened++;
      }
    }
  }

  /* --- which terrain cells are island ---------------------------------------------------- */
  // The island chain is parkland from shore to shore. city.js's bare-terrain grey is right for
  // the mainland's unmapped ground and quite wrong here, so the cells are marked once, by
  // scanline-filling the surveyed rings into the grid, and the terrain emitter reads the flag.
  // Scanline rather than point-in-ring per cell: 885 ring points against 104 rows instead of
  // twenty thousand cells against 885 points.
  {
    const { nx, nz, cell, x0, z0 } = T;
    const flags = new Uint8Array(nx * nz);
    const xs = [];
    for (let r = 0; r < isle.rings.length; r++) {
      const p = isle.rings[r].p;
      const bb = isle.rings[r].bbox;
      const j0 = clamp(Math.floor((bb[1] - z0) / cell) - 1, 0, nz - 1);
      const j1 = clamp(Math.ceil((bb[3] - z0) / cell) + 1, 0, nz - 1);
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        xs.length = 0;
        for (let i = 0, k = p.length - 1; i < p.length; k = i++) {
          const za = p[k][1], zb = p[i][1];
          if ((za > z) === (zb > z)) continue;
          const t = (z - za) / (zb - za);
          xs.push(p[k][0] + (p[i][0] - p[k][0]) * t);
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const ia = clamp(Math.ceil((xs[k] - x0) / cell), 0, nx - 1);
          const ib = clamp(Math.floor((xs[k + 1] - x0) / cell), 0, nx - 1);
          for (let i = ia; i <= ib; i++) flags[j * nx + i] = 1;
        }
      }
    }
    T.isleLand = flags;
  }

  /* --- the shore mantle ---------------------------------------------------------------- */
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const n = run.n;
    run.te = new Float64Array(n);
    run.met = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const bx = run.x[i] - run.nx[i] * BANK_SAMPLE, bz = run.z[i] - run.nz[i] * BANK_SAMPLE;
      run.g[i] = clamp(sampleTerrain(T, bx, bz), wY + BANK_MIN, wY + BANK_MAX);
    }
    smoothLoop(run.g, n, 3, 2);
    for (let i = 0; i < n; i++) {
      const x = run.x[i], z = run.z[i], nx = run.nx[i], nz = run.nz[i];
      const g = run.g[i];

      // SEAWARD. Two limits. The far shore first: across a channel narrower than the mantle the
      // ray runs back onto land, and that land is the other bank's business. Then the lake bed:
      // the toe runs out to exactly where the bed has fallen past it, so the sand meets the bed
      // instead of ending in a step you can swim under.
      let outMax = run.fw[i] + run.tw[i];
      for (let t = 1.5; t <= outMax; t += 1.5) {
        if (!waterAt(F, x + nx * t, z + nz * t)) { outMax = Math.max(1.2, t * 0.5); break; }
      }
      // The toe does not stop at a fixed depth and leave the bed to fall away under it: it runs
      // a set distance out and finishes ON the bed, so the mantle and the lake bed are one
      // surface. Where the bed is still above the toe depth the toe wins and the sand carries on.
      run.tw[i] = clamp(run.tw[i], 1.5, ISLE_TOE_MAX);
      const want = run.fw[i] + run.tw[i];
      if (want > outMax && want > EPS) {
        const k = outMax / want;
        run.fw[i] *= k;
        run.tw[i] *= k;
      }

      // INLAND. The mantle is a COVER as well as a look: a 25 m terrain grid cannot hold a 30 m
      // sand spit, so between the surveyed line and the first land vertex the grid is often
      // below the lake. The cover therefore runs to exactly where the ground comes back up to
      // the bank level — the same rule the mainland quay apron uses — or to the middle of the
      // strip where what it meets is the far bank's cover rather than ground.
      let back = run.bw[i];
      let met = 0;
      for (let t = 1.5; t <= ISLE_BACK_MAX; t += 1.5) {
        const px = x - nx * t, pz = z - nz * t;
        if (waterAt(F, px, pz)) { back = Math.max(1.2, t * 0.5); met = 1; break; }
        back = t;
        if (t >= run.bw[i] && sampleTerrain(T, px, pz) >= g - 0.06) break;
      }
      run.bw[i] = clamp(back, 1.2, ISLE_BACK_MAX);
      run.met[i] = met;
    }
    // Erode before smoothing: a station may end up NARROWER than its neighbours want, never
    // wider, because wider is what would put sand out over open water or a cover over the far
    // bank. The strips stay watertight either way — both their edges come from the stations.
    erodeLoop(run.bw, n, 1);
    erodeLoop(run.fw, n, 1);
    erodeLoop(run.tw, n, 1);
    smoothLoop(run.bw, n, 1, 1);
    smoothLoop(run.fw, n, 1, 1);
    smoothLoop(run.tw, n, 1, 1);

    for (let i = 0; i < n; i++) {
      const ex = run.x[i] - run.nx[i] * run.bw[i], ez = run.z[i] - run.nz[i] * run.bw[i];
      const t = sampleTerrain(T, ex, ez);
      // The bank face has to reach the ground OUTSIDE the cover too, not just the vertex under
      // its own edge: a couple of metres further in the grid may still be falling away, and a
      // face that stops short of it leaves exactly the gap it was built to close.
      run.te[i] = Math.min(t, sampleTerrain(T, run.x[i] - run.nx[i] * (run.bw[i] + 2.6),
        run.z[i] - run.nz[i] * (run.bw[i] + 2.6)));
      const ox = run.x[i] + run.nx[i] * (run.fw[i] + run.tw[i]);
      const oz = run.z[i] + run.nz[i] * (run.fw[i] + run.tw[i]);
      // The lake bed at the toe. The mantle does NOT follow it down — the bed is carved steeply
      // on purpose (it is what pins the grid's datum crossing to the surveyed line) and a mantle
      // that chased it would put a 9 m slide on the end of every beach. The toe stops at its own
      // depth and a skirt closes the gap, exactly as the mainland quay wall does.
      run.to[i] = Math.max(wY - 9.5, sampleTerrain(T, ox, oz));
      // Where the cover met the far bank it stops FLAT, because what it meets there is the other
      // side's cover and not ground. Otherwise it finishes on the ground that is actually there.
      run.e[i] = run.met[i] ? run.g[i] : clamp(t, wY + BANK_MIN * 0.5, run.g[i] + 0.9);
      run.te[i] = Math.min(run.te[i], run.e[i]);
    }
    smoothLoop(run.e, n, 1, 1);
    smoothLoop(run.to, n, 1, 1);
    for (let i = 0; i < n; i++) {
      const shore = wY + run.fr[i];
      // The bank knot sits back far enough that the drop from the bank to the water line is
      // never steeper than about 1:1.45. A 3 m bank crammed into two metres of plan is a cliff,
      // and an island bank is not a cliff. Where the cover is too narrow to hold the slope — a
      // channel bank with the far side a couple of metres away — the BANK comes down instead,
      // which is what a narrow channel's edge actually looks like.
      const room = Math.max(0.6, run.bw[i] * 0.92);
      if (run.g[i] > shore + room / 1.45) run.g[i] = shore + room / 1.45;
      if (run.g[i] < shore + 0.05) run.g[i] = shore + 0.05;
      if (run.e[i] > run.g[i] + 0.9) run.e[i] = run.g[i] + 0.9;
      run.bk[i] = -clamp(Math.max(run.bw[i] * 0.42, (run.g[i] - shore) * 1.45), 0.6, room);
    }
  }
}

// Min filter round a loop. The counterpart of smoothLoop for widths that must never grow.
function erodeLoop(a, n, half) {
  const tmp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = a[i];
    for (let k = -half; k <= half; k++) {
      const v = a[(i + k + n * 4) % n];
      if (v < m) m = v;
    }
    tmp[i] = m;
  }
  a.set(tmp);
}

/* ------------------------------------------------------------- ground field */

// The mantle cross-section at a station, sampled at outward offset t. Six knots: the inland edge
// (below the ground cover), the bank crest, the surveyed shore line, the top and bottom of the
// swash, and the submerged toe.
function mantleY(wY, g, e, bw, fw, tw, fr, td, bk, t) {
  const t1 = bk;
  if (t <= -bw) return e - MANTLE_SINK;
  if (t <= t1) {
    const f = (t + bw) / Math.max(EPS, bw + t1);
    return lerp(e - MANTLE_SINK, g, f);
  }
  if (t <= 0) return lerp(g, wY + fr, clamp((t - t1) / Math.max(EPS, -t1), 0, 1));
  const t3 = fw * SWASH;
  if (t <= t3) return lerp(wY + fr, wY + 0.10, clamp(t / Math.max(EPS, t3), 0, 1));
  if (t <= fw) return lerp(wY + 0.10, wY - 0.10, clamp((t - t3) / Math.max(EPS, fw - t3), 0, 1));
  return lerp(wY - 0.10, wY - td, clamp((t - fw) / Math.max(EPS, tw), 0, 1));
}

/**
 * The walking surface the island shore mantle puts down, or -Infinity where it puts down none.
 * Read through harbourDeckY(), so the beach IS the ground for the player, the props and every
 * ribbon that crosses it — you walk down the sand and into the water, which is the point.
 */
function islandGroundY(isle, x, z) {
  if (!isle || !isle.index || !isNum(x) || !isNum(z)) return -Infinity;
  const G = isle.index;
  const ci = Math.floor((x - G.x0) / ISLE_GRID), cj = Math.floor((z - G.z0) / ISLE_GRID);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return -Infinity;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return -Infinity;
  const wY = isle.waterY;
  let y = -Infinity;
  for (let k = 0; k < list.length; k += 2) {
    const run = isle.runs[list[k]], i = list[k + 1], j = (i + 1) % run.n;
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[j] - ax, dz = run.z[j] - az;
    const l2 = dx * dx + dz * dz;
    let f = 0;
    if (l2 > EPS) f = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * f, qz = az + dz * f;
    let nx = lerp(run.nx[i], run.nx[j], f), nz = lerp(run.nz[i], run.nz[j], f);
    const nl = Math.hypot(nx, nz);
    if (nl < EPS) continue;
    nx /= nl; nz /= nl;
    const t = (x - qx) * nx + (z - qz) * nz;
    const bw = lerp(run.bw[i], run.bw[j], f), fw = lerp(run.fw[i], run.fw[j], f);
    const tw = lerp(run.tw[i], run.tw[j], f);
    if (t < -bw || t > fw + tw) continue;
    // Past the end of a segment the projection clamps, so a point far away can still land at a
    // small offset; the straight-line distance is the honest test.
    const reach = Math.max(bw, fw + tw) + 2.0;
    if ((x - qx) * (x - qx) + (z - qz) * (z - qz) > reach * reach) continue;
    const v = mantleY(wY, lerp(run.g[i], run.g[j], f), lerp(run.e[i], run.e[j], f),
      bw, fw, tw, lerp(run.fr[i], run.fr[j], f), lerp(run.td[i], run.td[j], f),
      lerp(run.bk[i], run.bk[j], f), t);
    if (v > y) y = v;
  }
  return y;
}

/**
 * Is (x, z) airside? Not "on the pavement" — inside the perimeter, which is the same contour the
 * fence is traced from. An aerodrome's infield is mown grass and nothing else: a tree between a
 * runway and its parallel taxiway is an obstacle, and a flower bed there is nonsense.
 */
function onAirfield(isle, x, z) {
  return !!(isle && isle.air && airInset(isle.air, x, z) > -AIR_FENCE_OUT);
}

/** And the tight test: is (x, z) actually on the pavement? */
function onAirPavement(isle, x, z) {
  return !!(isle && isle.air && airInset(isle.air, x, z) > -AIR_SHOULDER * 0.5);
}


/* ---------------------------------------------------------------- geometry */

// Band materials, indexed [kind][band]. Five bands across the mantle: the inland tie, the bank,
// the face above water, the swash, and the submerged toe.
const BAND_MAT = [
  [IM.bank, M.rubble, M.rubble, M.rubbleWet, M.rubbleWet],
  [IM.sandDry, IM.sandDry, IM.sandDry, IM.sandWet, IM.sandWet],
  [IM.bank, M.coping, M.quayFace, M.quayFouled, M.quayFouled],
];

/**
 * The island shore, station by station: 35 km of surveyed line turned into a real edge.
 *
 * Every strip is the same six-knot cross-section (see mantleY) with the material chosen by the
 * station's classification, so a beach can taper into a seawall without leaving a hole where the
 * two meet. Emitted per tile: a strip belongs to the tile holding its midpoint, and because the
 * offsets are mitred off the whole loop, the strip either side of a tile boundary lands on
 * exactly the same two vertices.
 */
function appendIsleShores(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.terrain;
  const wY = isle.waterY;
  let strips = 0;
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const n = run.n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (run.x[i] + run.x[j]) * 0.5, mz = (run.z[i] + run.z[j]) * 0.5;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      strips++;
      const bwA = run.bw[i], bwB = run.bw[j];
      const fwA = run.fw[i], fwB = run.fw[j];
      const twA = run.tw[i], twB = run.tw[j];
      const tA = [-bwA, run.bk[i], 0, fwA * SWASH, fwA, fwA + twA];
      const tB = [-bwB, run.bk[j], 0, fwB * SWASH, fwB, fwB + twB];
      const yA = [
        run.e[i] - MANTLE_SINK, run.g[i], wY + run.fr[i], wY + 0.10, wY - 0.10, wY - run.td[i],
      ];
      const yB = [
        run.e[j] - MANTLE_SINK, run.g[j], wY + run.fr[j], wY + 0.10, wY - 0.10, wY - run.td[j],
      ];
      const mats = BAND_MAT[run.kind[i]] || BAND_MAT[0];
      for (let b = 0; b < 5; b++) {
        setMat(mb, mats[b]);
        const ax = run.x[i] + run.mx[i] * tA[b], az = run.z[i] + run.mz[i] * tA[b];
        const bx = run.x[i] + run.mx[i] * tA[b + 1], bz = run.z[i] + run.mz[i] * tA[b + 1];
        const cx = run.x[j] + run.mx[j] * tB[b + 1], cz = run.z[j] + run.mz[j] * tB[b + 1];
        const dx = run.x[j] + run.mx[j] * tB[b], dz = run.z[j] + run.mz[j] * tB[b];
        // Outward hint: the band runs out by dt and drops by dy, so its face points up and out
        // in proportion. A flat band gets the +Y bias and comes out horizontal.
        const dt = Math.max(0.02, (tA[b + 1] - tA[b] + tB[b + 1] - tB[b]) * 0.5);
        const dy = (yA[b] - yA[b + 1] + yB[b] - yB[b + 1]) * 0.5;
        quadOut(mb, ax, yA[b], az, bx, yA[b + 1], bz, cx, yB[b + 1], cz, dx, yB[b], dz,
          run.nx[i] * dy, dt + 0.001, run.nz[i] * dy);
      }
      // THE SKIRT. Where the cover ran out of room before the ground came back up — a sand spit
      // the 25 m terrain grid drowned, an eroding bank — the mantle's inland edge stands proud of
      // the ground it meets. A vertical face closes that: an earth bank, which is what is
      // actually there, and never a raw edge you can see under (Amendment 9.2).
      const sA = run.te[i] - 0.45, sB = run.te[j] - 0.45;
      if (yA[0] - sA > 0.06 || yB[0] - sB > 0.06) {
        c.note('bankSkirt');
        setMat(mb, IM.soil);
        const ax = run.x[i] + run.mx[i] * tA[0], az = run.z[i] + run.mz[i] * tA[0];
        const dx = run.x[j] + run.mx[j] * tB[0], dz = run.z[j] + run.mz[j] * tB[0];
        quadOut(mb, ax, Math.min(sA, yA[0]), az, ax, yA[0], az, dx, yB[0], dz,
          dx, Math.min(sB, yB[0]), dz, -run.nx[i], 0, -run.nz[i]);
      }
      // And the same at the toe, where the carved bed falls away under the sand. Underwater, but
      // the mesh has to be closed there or the lake is see-through from below the surface.
      const oA = Math.min(run.to[i], yA[5]), oB = Math.min(run.to[j], yB[5]);
      if (yA[5] - oA > 0.06 || yB[5] - oB > 0.06) {
        c.note('toeSkirt');
        setMat(mb, run.kind[i] === EDGE_BEACH ? IM.sandWet : M.rubbleWet);
        const ax = run.x[i] + run.mx[i] * tA[5], az = run.z[i] + run.mz[i] * tA[5];
        const dx = run.x[j] + run.mx[j] * tB[5], dz = run.z[j] + run.mz[j] * tB[5];
        quadOut(mb, ax, yA[5], az, ax, oA, az, dx, oB, dz, dx, yB[5], dz,
          run.nx[i], 0, run.nz[i]);
      }
    }
  }
  return strips;
}

/**
 * Timber decking over the island paths that run along a beach.
 *
 * Ward's Island's south shore really is a boardwalk, and so is the run behind Centre Island
 * Beach. city.js has already built these as generic footways; this lays real decking one rung
 * above, exactly as the mainland boardwalk does, so the two can never fight. Which paths qualify
 * is decided by the survey — a path within BOARD_NEAR of shore that is classified beach — and
 * not by name, because most of them are not named.
 */
const BOARD_NEAR = 26.0;

function appendIsleBoardwalks(isle, c, x0, z0, x1, z1) {
  const data = c.data;
  if (!data || !Array.isArray(data.roads)) return 0;
  const mb = c.mb.sidewalks;
  const IB = isle.bbox;
  let metres = 0;
  for (let i = 0; i < data.roads.length; i++) {
    const r = data.roads[i];
    if (!r || r.c !== 'foot' || !Array.isArray(r.p) || r.p.length < 2 || r.tun === 1) continue;
    const bb = bboxOf(r.p);
    if (!boxHit(bb, IB[0], IB[1], IB[2], IB[3])) continue;
    if (!boxHit(bb, x0 - 200, z0 - 200, x1 + 200, z1 + 200)) continue;
    // Beach-side test on the raw way, before the cost of resampling it.
    let beachy = 0, tested = 0;
    for (let k = 0; k < r.p.length; k += Math.max(1, Math.floor(r.p.length / 6))) {
      const hit = nearIsleStation(isle, r.p[k][0], r.p[k][1], BOARD_NEAR);
      tested++;
      if (hit && hit.kind === EDGE_BEACH) beachy++;
    }
    if (!tested || beachy * 2 < tested) continue;
    const pts = resample(r.p, 4.0);
    const hw = clamp(isNum(r.w) ? r.w * 0.5 : 1.5, 1.1, 2.6);
    metres += emitIsleBoard(mb, pts, hw, c.groundY, x0, z0, x1, z1);
  }
  return metres;
}

// The nearest island station within `reach`, or null. Returns the module scratch.
const _isle = { d: 0, run: null, i: 0, kind: 0, t: 0, x: 0, z: 0, nx: 0, nz: 0 };

function nearIsleStation(isle, x, z, reach) {
  if (!isle || !isle.index || !isNum(x) || !isNum(z)) return null;
  const G = isle.index;
  const ci = Math.floor((x - G.x0) / ISLE_GRID), cj = Math.floor((z - G.z0) / ISLE_GRID);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return null;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return null;
  let best = Infinity, br = null, bi = 0, bt = 0, bx = 0, bz = 0;
  for (let k = 0; k < list.length; k += 2) {
    const run = isle.runs[list[k]], i = list[k + 1], j = (i + 1) % run.n;
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[j] - ax, dz = run.z[j] - az;
    const l2 = dx * dx + dz * dz;
    let f = 0;
    if (l2 > EPS) f = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * f, qz = az + dz * f;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; br = run; bi = f > 0.5 ? j : i; bt = f; bx = qx; bz = qz; }
  }
  if (!br || best > (isNum(reach) ? reach : ISLE_REACH)) return null;
  _isle.d = best; _isle.run = br; _isle.i = bi; _isle.kind = br.kind[bi];
  _isle.x = bx; _isle.z = bz; _isle.nx = br.nx[bi]; _isle.nz = br.nz[bi];
  _isle.t = (x - bx) * br.nx[bi] + (z - bz) * br.nz[bi];
  return _isle;
}

// A boardwalk ribbon, emitting only the segments this tile owns. The normals come from the whole
// polyline, so the two halves of a run cut by a tile boundary meet on the same vertices.
function emitIsleBoard(mb, pts, hw, gy, x0, z0, x1, z1) {
  const n = pts.length;
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    nx[i] = -tz; nz[i] = tx;
  }
  let metres = 0;
  for (let i = 0; i + 1 < n; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) * 0.5, mz = (pts[i][1] + pts[i + 1][1]) * 0.5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    metres += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const y0 = gy(pts[i][0], pts[i][1]) + BOARD_LIFT;
    const y1 = gy(pts[i + 1][0], pts[i + 1][1]) + BOARD_LIFT;
    for (let k = 0; k < 5; k++) {
      const oa = -hw + (k / 5) * 2 * hw + 0.035;
      const ob = -hw + ((k + 1) / 5) * 2 * hw - 0.035;
      setMat(mb, IM.boardIsle);
      quadUp(mb,
        pts[i][0] + nx[i] * oa, y0, pts[i][1] + nz[i] * oa,
        pts[i][0] + nx[i] * ob, y0, pts[i][1] + nz[i] * ob,
        pts[i + 1][0] + nx[i + 1] * ob, y1, pts[i + 1][1] + nz[i + 1] * ob,
        pts[i + 1][0] + nx[i + 1] * oa, y1, pts[i + 1][1] + nz[i + 1] * oa);
    }
    setMat(mb, IM.boardIsleEdge);
    for (let s = -1; s <= 1; s += 2) {
      const o = s * hw;
      const ax = pts[i][0] + nx[i] * o, az = pts[i][1] + nz[i] * o;
      const bx = pts[i + 1][0] + nx[i + 1] * o, bz = pts[i + 1][1] + nz[i + 1] * o;
      quadOut(mb, ax, gy(ax, az) + 0.04, az, bx, gy(bx, bz) + 0.04, bz, bx, y1, bz, ax, y0, az,
        nx[i] * s, 0, nz[i] * s);
    }
  }
  return metres;
}


/* -------------------------------------------------------------- the airfield */

const AIR_PAVE_Y = 0.21;          // pavement above the graded plane, clear of every ground rung
const AIR_SHOULDER_DROP = 0.23;   // and how far the shoulder falls before it crosses the grass

// Mitre vectors for an open polyline: offsetting a vertex by m * w lands exactly w from BOTH of
// its segments, so a ribbon built from them has no gap and no overlap at a bend.
function wayFrames(p) {
  const n = p.length;
  const mx = new Float64Array(n), mz = new Float64Array(n);
  const ns = Math.max(1, n - 1);
  const sx = new Float64Array(ns), sz = new Float64Array(ns);
  for (let i = 0; i + 1 < n; i++) {
    let dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
    const l = Math.hypot(dx, dz);
    if (l > EPS) { dx /= l; dz /= l; } else { dx = 1; dz = 0; }
    sx[i] = -dz; sz[i] = dx;
  }
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0;
    const b = i < n - 1 ? i : ns - 1;
    let vx = sx[a] + sx[b], vz = sz[a] + sz[b];
    const l2 = vx * vx + vz * vz;
    if (l2 > 1e-6) {
      vx = vx * 2 / l2; vz = vz * 2 / l2;
      const vl = Math.hypot(vx, vz);
      if (vl > 2.6) { vx = vx * 2.6 / vl; vz = vz * 2.6 / vl; }
    } else { vx = sx[b]; vz = sz[b]; }
    mx[i] = vx; mz[i] = vz;
  }
  return { mx, mz };
}

// A flat ribbon at constant y, emitting only the segments whose midpoint this tile owns.
function ribbonAt(mb, p, F, o0, o1, y, x0, z0, x1, z1) {
  for (let i = 0; i + 1 < p.length; i++) {
    const cx = (p[i][0] + p[i + 1][0]) * 0.5, cz = (p[i][1] + p[i + 1][1]) * 0.5;
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    quadUp(mb,
      p[i][0] + F.mx[i] * o0, y, p[i][1] + F.mz[i] * o0,
      p[i][0] + F.mx[i] * o1, y, p[i][1] + F.mz[i] * o1,
      p[i + 1][0] + F.mx[i + 1] * o1, y, p[i + 1][1] + F.mz[i + 1] * o1,
      p[i + 1][0] + F.mx[i + 1] * o0, y, p[i + 1][1] + F.mz[i + 1] * o0);
  }
}

// A sloped ribbon: the inner edge at yIn, the outer at yOut. The graded shoulder.
function ribbonSlope(mb, p, F, oIn, oOut, yIn, yOut, x0, z0, x1, z1, sign) {
  for (let i = 0; i + 1 < p.length; i++) {
    const cx = (p[i][0] + p[i + 1][0]) * 0.5, cz = (p[i][1] + p[i + 1][1]) * 0.5;
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    const a0 = oIn * sign, a1 = oOut * sign;
    quadUp(mb,
      p[i][0] + F.mx[i] * a0, yIn, p[i][1] + F.mz[i] * a0,
      p[i][0] + F.mx[i] * a1, yOut, p[i][1] + F.mz[i] * a1,
      p[i + 1][0] + F.mx[i + 1] * a1, yOut, p[i + 1][1] + F.mz[i + 1] * a1,
      p[i + 1][0] + F.mx[i + 1] * a0, yIn, p[i + 1][1] + F.mz[i + 1] * a0);
  }
}

// A painted rectangle in runway-local coordinates: v along the landing direction (ux, uz), u to
// the pilot's right. Owned by the tile holding its centre.
function paintRect(mb, ox, oz, ux, uz, u0, u1, v0, v1, y, x0, z0, x1, z1) {
  const rx = -uz, rz = ux;
  const cu = (u0 + u1) * 0.5, cv = (v0 + v1) * 0.5;
  const cx = ox + rx * cu + ux * cv, cz = oz + rz * cu + uz * cv;
  if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) return 0;
  const px = (u, v) => ox + rx * u + ux * v;
  const pz = (u, v) => oz + rz * u + uz * v;
  quadUp(mb, px(u0, v0), y, pz(u0, v0), px(u1, v0), y, pz(u1, v0),
    px(u1, v1), y, pz(u1, v1), px(u0, v1), y, pz(u0, v1));
  return 1;
}

// Seven-segment strokes, which is very close to what an ICAO runway numeral actually is: seven
// straight bars on a grid. Bit order A top, B upper right, C lower right, D bottom, E lower
// left, F upper left, G middle.
const DIGIT_SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

function paintDigit(mb, d, ox, oz, ux, uz, u0, v0, w, h, s, y, x0, z0, x1, z1) {
  const bits = DIGIT_SEG[clamp(d | 0, 0, 9)];
  const hh = h * 0.5;
  const bar = (a, b, c, e) => paintRect(mb, ox, oz, ux, uz, a, b, c, e, y, x0, z0, x1, z1);
  let n = 0;
  if (bits & 1) n += bar(u0, u0 + w, v0 + h - s, v0 + h);
  if (bits & 2) n += bar(u0 + w - s, u0 + w, v0 + hh, v0 + h);
  if (bits & 4) n += bar(u0 + w - s, u0 + w, v0, v0 + hh);
  if (bits & 8) n += bar(u0, u0 + w, v0, v0 + s);
  if (bits & 16) n += bar(u0, u0 + s, v0, v0 + hh);
  if (bits & 32) n += bar(u0, u0 + s, v0 + hh, v0 + h);
  if (bits & 64) n += bar(u0, u0 + w, v0 + hh - s * 0.5, v0 + hh + s * 0.5);
  return n;
}

/**
 * The airfield surface: runway and taxiway ribbons, the aprons, the graded shoulders, and every
 * marking the eye uses to read a runway as a runway — threshold bars, designators, the aiming
 * point, the centreline and the side stripes, taxiway centrelines and holding bars.
 *
 * All of it comes off the aeroway survey; nothing here invents an alignment.
 */
function appendAirfield(isle, c, x0, z0, x1, z1) {
  const A = isle.air;
  if (!A) return;
  const mb = c.mb.roads;
  const yP = A.y + AIR_PAVE_Y;
  const yM = yP + AIR_MARK;

  /* pavement */
  for (let i = 0; i < A.ways.length; i++) {
    const w = A.ways[i];
    if (!boxHit(w.bbox, x0 - w.hw - AIR_SHOULDER - 4, z0 - w.hw - AIR_SHOULDER - 4,
      x1 + w.hw + AIR_SHOULDER + 4, z1 + w.hw + AIR_SHOULDER + 4)) continue;
    const F = wayFrames(w.p);
    setMat(mb, IM.shoulder);
    ribbonSlope(mb, w.p, F, w.hw, w.hw + AIR_SHOULDER, yP - 0.02,
      A.y - AIR_SHOULDER_DROP, x0, z0, x1, z1, 1);
    ribbonSlope(mb, w.p, F, w.hw, w.hw + AIR_SHOULDER, yP - 0.02,
      A.y - AIR_SHOULDER_DROP, x0, z0, x1, z1, -1);
    setMat(mb, w.kind === 'taxiway' ? IM.apron : IM.runway);
    ribbonAt(mb, w.p, F, -w.hw, w.hw, yP, x0, z0, x1, z1);
  }
  for (let i = 0; i < A.aprons.length; i++) {
    const ap = A.aprons[i];
    const bb = ap.bbox;
    const cx = (bb[0] + bb[2]) * 0.5, cz = (bb[1] + bb[3]) * 0.5;
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    const ring = isClosed(ap.p) ? ap.p.slice(0, ap.p.length - 1) : ap.p;
    const tri = earClip(ring);
    setMat(mb, IM.apron);
    for (let k = 0; k < tri.length; k += 3) {
      const a = ring[tri[k]], b = ring[tri[k + 1]], d = ring[tri[k + 2]];
      triUp(mb, a[0], yP, a[1], b[0], yP, b[1], d[0], yP, d[1]);
    }
  }

  /* runway markings */
  for (let r = 0; r < A.runways.length; r++) {
    const R = A.runways[r];
    const hw = R.way.hw;
    for (let e = 0; e < R.thresh.length; e++) {
      const th = R.thresh[e];
      const ux = th.ux, uz = th.uz;
      setMat(mb, IM.paintWhite);
      // Threshold: eight longitudinal bars for a 30 m runway, 1.8 m wide on 3.6 m centres.
      for (let k = 0; k < 8; k++) {
        const u = (k - 3.5) * 3.6;
        paintRect(mb, th.x, th.z, ux, uz, u - 0.9, u + 0.9, 6, 28, yM, x0, z0, x1, z1);
      }
      // Designator, reading up the runway from the threshold.
      const label = String(th.label || '');
      const dw = 9.0, dh = 18.0, ds = 2.4, gap = 3.0;
      const total = label.length * dw + (label.length - 1) * gap;
      for (let k = 0; k < label.length; k++) {
        const d = parseInt(label[k], 10);
        if (!isFinite(d)) continue;
        paintDigit(mb, d, th.x, th.z, ux, uz, -total * 0.5 + k * (dw + gap), 40, dw, dh, ds,
          yM, x0, z0, x1, z1);
      }
      // Aiming point: two 6 x 30 m bars at 300 m, and touchdown pairs at 150 m.
      if (R.len > 720) {
        for (let s = -1; s <= 1; s += 2) {
          paintRect(mb, th.x, th.z, ux, uz, s * 11 - 3, s * 11 + 3, 300, 330, yM, x0, z0, x1, z1);
          paintRect(mb, th.x, th.z, ux, uz, s * 11 - 1.8, s * 11 + 1.8, 150, 172, yM,
            x0, z0, x1, z1);
        }
      }
    }
    // Centreline dashes and the side stripes, laid from one threshold along the runway.
    const th0 = R.thresh[0];
    setMat(mb, IM.paintWhite);
    for (let v = 24; v + 30 < R.len - 24; v += 50) {
      paintRect(mb, th0.x, th0.z, th0.ux, th0.uz, -0.45, 0.45, v, v + 30, yM, x0, z0, x1, z1);
    }
    for (let s = -1; s <= 1; s += 2) {
      for (let v = 8; v + 40 < R.len - 8; v += 40) {
        paintRect(mb, th0.x, th0.z, th0.ux, th0.uz, s * (hw - 1.2) - 0.45, s * (hw - 1.2) + 0.45,
          v, v + 40, yM, x0, z0, x1, z1);
      }
    }
  }

  /* taxiway centrelines and holding bars */
  setMat(mb, IM.paintYellow);
  for (let i = 0; i < A.ways.length; i++) {
    const w = A.ways[i];
    if (w.kind !== 'taxiway') continue;
    if (!boxHit(w.bbox, x0 - 20, z0 - 20, x1 + 20, z1 + 20)) continue;
    const F = wayFrames(w.p);
    ribbonAt(mb, w.p, F, -0.075, 0.075, yM, x0, z0, x1, z1);
  }
  for (let i = 0; i < A.holds.length; i++) {
    const p = A.holds[i].p;
    for (let k = 0; k + 1 < p.length; k++) {
      let tx = p[k + 1][0] - p[k][0], tz = p[k + 1][1] - p[k][1];
      const l = Math.hypot(tx, tz);
      if (!(l > EPS)) continue;
      tx /= l; tz /= l;
      // Four bars along the holding line: two solid, two dashed. ICAO pattern A. Here the way
      // itself runs ACROSS the taxiway, so the paint axis is the way and the offsets are across.
      for (let b = 0; b < 4; b++) {
        const u = (b - 1.5) * 0.62;
        if (b < 2) {
          paintRect(mb, p[k][0], p[k][1], tx, tz, u - 0.155, u + 0.155, 0, l, yM,
            x0, z0, x1, z1);
        } else {
          for (let s = 0; s < l - 0.6; s += 3.0) {
            paintRect(mb, p[k][0], p[k][1], tx, tz, u - 0.155, u + 0.155,
              s, Math.min(l, s + 1.6), yM, x0, z0, x1, z1);
          }
        }
      }
    }
  }
  /* stand lead-in lines */
  for (let i = 0; i < AERO_STAND.length; i++) {
    const p = pairs(AERO_STAND[i][1]);
    if (p.length < 2) continue;
    const F = wayFrames(p);
    ribbonAt(mb, p, F, -0.09, 0.09, yM, x0, z0, x1, z1);
  }
}


/* ------------------------------------------------------------------ detail */

// Is (x, z) island land? The rings are the survey, so this is exact rather than a terrain guess.
function onIsland(isle, x, z) {
  for (let i = 0; i < isle.rings.length; i++) {
    const R = isle.rings[i];
    if (x < R.bbox[0] || x > R.bbox[2] || z < R.bbox[1] || z > R.bbox[3]) continue;
    if (pointInRing(R.p, x, z)) return true;
  }
  return false;
}

/**
 * The greenest place on the map.
 *
 * A world-aligned lattice, hashed on world position, so the same trees stand in the same places
 * whichever tile is built and in whatever order (CONTRACT 8.4). Density comes from how far the
 * point is from the nearest building or paved road: out in the open it is mature parkland, near
 * the cottages it is gardens and hedges, and right against them nothing, because that is the
 * street pass's business.
 */
function placeIslandGreen(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const cell = ISLE_TREE_CELL;
  const u0 = Math.ceil(x0 / cell) * cell, v0 = Math.ceil(z0 / cell) * cell;
  let placed = 0;
  for (let v = v0; v < z1 && placed < ISLE_TREE_MAX; v += cell) {
    for (let u = u0; u < x1 && placed < ISLE_TREE_MAX; u += cell) {
      const h1 = hash01(u, v), h2 = hash01(v, u), h3 = hash01(u + 17.3, v - 41.7);
      const x = u + (h1 - 0.5) * cell * 0.82, z = v + (h2 - 0.5) * cell * 0.82;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      if (!onIsland(isle, x, z)) continue;
      if (onAirfield(isle, x, z)) continue;
      // Never on the shore mantle: the beach is sand and the riprap is rock.
      const near = nearIsleStation(isle, x, z, ISLE_REACH);
      if (near && near.t > -near.run.bw[near.i] * 0.55) continue;
      const hs = nearSeg(isle.hard, x, z);
      const d = hs ? hs.d : 999;
      if (d < 7.0) continue;
      // Open parkland, not a plantation: the islands have big mown lawns — the Avenue of the
      // Islands, the sports fields, the picnic ground — and a canopy at every lattice point
      // would bury them. Nearer the cottages the lattice turns into gardens instead.
      const dense = d > 25 ? 0.70 : 0.34;
      if (h3 > dense) continue;
      if (d > 25) {
        const y = c.reserve('islandTree', x, z, 2.4, 1.6, 9.0);
        if (!isNum(y)) continue;
        const sp = h1 < 0.14 ? 2 : (h2 < 0.24 ? 1 : 0);
        appendCanopyTree(mb, rngAt(x, z), x, y + 0.05, z, 0.85 + h3 * 0.85, sp);
        placed++;
      } else if (h1 < 0.42) {
        const y = c.reserve('islandHedge', x, z, 1.5, 1.2, 2.0);
        if (!isNum(y)) continue;
        appendHedgeRun(mb, rngAt(x, z), x, y + 0.03, z, h2 * TAU, 3.5 + h3 * 5.0,
          1.0 + h1 * 0.6, 0.7 + h2 * 0.4);
        placed++;
      } else if (h1 < 0.62) {
        const y = c.reserve('islandBed', x, z, 1.6, 1.2, 0.6);
        if (!isNum(y)) continue;
        appendFlowerBed(mb, rngAt(x, z), x, y + 0.02, z, h2 * TAU, 2.2 + h3 * 2.6,
          1.6 + h1 * 1.6);
        placed++;
      } else {
        const y = c.reserve('islandShrub', x, z, 1.1, 1.0, 1.6);
        if (!isNum(y)) continue;
        appendShrub(mb, rngAt(x, z), x, y + 0.03, z, 0.9 + h3 * 0.7);
        placed++;
      }
    }
  }
  return placed;
}

/**
 * What stands on the shore itself: marram on the back of the beaches, driftwood and armour stone
 * on the riprap, picnic tables and benches behind the berm, a lifeguard chair where a beach is
 * long enough to need one, and a timber rail wherever the bank drops to a seawall.
 */
function placeShoreProps(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const wY = isle.waterY;
  let n = 0;
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const step = Math.max(1, Math.round(ISLE_SHORE_PROP / ISLE_STATION));
    for (let i = 0; i < run.n; i += step) {
      const x = run.x[i], z = run.z[i];
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      const nx = run.nx[i], nz = run.nz[i];
      const k = run.kind[i];
      const h1 = hash01(x, z), h2 = hash01(z, x);
      if (k === EDGE_BEACH) {
        // Marram on the backshore, in the band the tide never reaches.
        for (let t = 0; t < 3; t++) {
          const o = -run.bw[i] * (0.55 + 0.30 * hash01(x + t * 3.7, z - t * 5.1));
          const px = x + nx * o + nz * (hash01(x + t, z) - 0.5) * 7.0;
          const pz = z + nz * o - nx * (hash01(z, x + t) - 0.5) * 7.0;
          const y = c.groundY(px, pz);
          if (!isNum(y) || y < wY + 0.15) continue;
          appendBeachGrass(mb, rngAt(px, pz), px, y, pz, 0.8 + hash01(pz, px) * 0.8);
          c.note('beachGrass');
          n++;
        }
        if (h1 < 0.30) {
          const o = -run.bw[i] * 1.25;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('picnicTable', px, pz, 1.6, 1.2, 0.9);
          if (isNum(y)) {
            appendPicnicTable(mb, rngAt(px, pz), px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        } else if (h1 < 0.42) {
          const o = -run.bw[i] * 1.1;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('timberBench', px, pz, 1.3, 1.2, 0.9);
          if (isNum(y)) {
            appendTimberBench(mb, rngAt(px, pz), px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        } else if (h1 < 0.47 && run.open[i] >= OPEN_LAKE) {
          const o = -run.bw[i] * 0.30;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('lifeguardChair', px, pz, 1.5, 1.4, 2.6);
          if (isNum(y)) {
            appendLifeguardChair(mb, px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        }
      } else if (k === EDGE_RIP) {
        // Armour stone along the toe, half in the water, exactly as it is placed for real.
        for (let t = 0; t < 2; t++) {
          const o = run.fw[i] * (0.55 + 0.45 * hash01(x - t * 2.3, z + t * 6.1));
          const px = x + nx * o + nz * (hash01(x + t * 5, z) - 0.5) * 6.0;
          const pz = z + nz * o - nx * (hash01(z + t * 5, x) - 0.5) * 6.0;
          appendWaveRock(mb, rngAt(px, pz), px, wY - 0.15, pz, 0.7 + hash01(px, pz) * 1.1);
          c.note('armourStone');
          n++;
        }
      } else if (h2 < 0.55) {
        // A seawall on the islands is a low edge people sit on and fish off: rail it, and put a
        // mooring bollard on the stretches a boat could come alongside.
        const y = run.g[i];
        const px = x - nx * 0.55, pz = z - nz * 0.55;
        if (c.claim(px, pz, 1.2)) {
          appendQuayRailing(mb, px, y, pz, Math.atan2(-nz, nx), 5.4);
          c.note('quayRailing');
          n++;
        }
      }
    }
  }
  return n;
}


/* --------------------------------------------------------- airfield detail */

// Gibraltar Point Lighthouse, 1808, the oldest structure on the islands and the one thing on the
// south shore you can navigate by. It is not in the extract at any tag build_city.py reads, so
// its surveyed position (43.61278 N, 79.38583 W) is projected here the same way everything else
// is. Amendment 7: the lantern is a real light and is the only emitter on the islands.
const LIGHTHOUSE = [94.3, 2472.5];
const LIGHTHOUSE_H = 15.0;

function placeAirfieldDetail(isle, c, x0, z0, x1, z1) {
  const A = isle.air;
  if (!A) return 0;
  const mb = c.mb.props;
  const yP = A.y + AIR_PAVE_Y;
  const wY = isle.waterY;
  let n = 0;
  const inBox = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;

  /* runway edge, threshold and end lights */
  for (let r = 0; r < A.runways.length; r++) {
    const R = A.runways[r];
    const hw = R.way.hw;
    const th = R.thresh[0];
    for (let v = AIR_EDGE_LIGHT * 0.5; v < R.len; v += AIR_EDGE_LIGHT) {
      for (let s = -1; s <= 1; s += 2) {
        const x = th.x + th.ux * v - th.uz * s * (hw + 1.4);
        const z = th.z + th.uz * v + th.ux * s * (hw + 1.4);
        if (!inBox(x, z)) continue;
        appendRunwayLight(mb, x, yP - 0.02, z, 0);
        c.note('runwayLight');
        n++;
      }
    }
    for (let e = 0; e < R.thresh.length; e++) {
      const t = R.thresh[e];
      for (let k = 0; k < 8; k++) {
        const o = (k - 3.5) * (hw * 2 / 8);
        const x = t.x - t.uz * o + t.ux * 1.2, z = t.z + t.ux * o + t.uz * 1.2;
        if (!inBox(x, z)) continue;
        appendRunwayLight(mb, x, yP - 0.02, z, 1);
        c.note('runwayLight');
        n++;
      }
      /* approach bars, out over the water off the threshold */
      for (let b = 1; b <= AIR_APPROACH_BARS; b++) {
        const d = b * AIR_APPROACH_STEP;
        const x = t.x - t.ux * d, z = t.z - t.uz * d;
        if (!inBox(x, z)) continue;
        const wet = harbourWaterAt(c.H, x, z);
        const base = wet ? wY : c.groundY(x, z);
        if (!isNum(base)) continue;
        appendApproachMast(mb, x, base, z, Math.atan2(-t.uz, t.ux), Math.max(0.6, yP - base + 0.3),
          b === AIR_APPROACH_BARS ? 9 : 5);
        c.note('approachMast');
        n++;
      }
    }
  }

  /* taxiway edge lights */
  for (let i = 0; i < A.ways.length; i++) {
    const w = A.ways[i];
    if (w.kind !== 'taxiway') continue;
    if (!boxHit(w.bbox, x0 - 24, z0 - 24, x1 + 24, z1 + 24)) continue;
    const F = wayFrames(w.p);
    let run = 0;
    for (let k = 0; k + 1 < w.p.length; k++) {
      const ax = w.p[k][0], az = w.p[k][1];
      const seg = Math.hypot(w.p[k + 1][0] - ax, w.p[k + 1][1] - az);
      for (let d = 0; d < seg; d += 1.0) {
        run += 1.0;
        if (run < AIR_TAXI_LIGHT) continue;
        run = 0;
        const f = seg > EPS ? d / seg : 0;
        const mxv = lerp(F.mx[k], F.mx[k + 1], f), mzv = lerp(F.mz[k], F.mz[k + 1], f);
        const px = ax + (w.p[k + 1][0] - ax) * f, pz = az + (w.p[k + 1][1] - az) * f;
        for (let s = -1; s <= 1; s += 2) {
          const x = px + mxv * s * (w.hw + 1.0), z = pz + mzv * s * (w.hw + 1.0);
          if (!inBox(x, z)) continue;
          appendRunwayLight(mb, x, yP - 0.02, z, 3);
          c.note('taxiLight');
          n++;
        }
      }
    }
  }

  /* aircraft on the stands, a windsock, and the perimeter fence */
  for (let i = 0; i < A.stands.length; i++) {
    const st = A.stands[i];
    if (!inBox(st.x, st.z)) continue;
    if (!c.claim(st.x, st.z, 12)) continue;
    if (parseInt(st.ref, 10) > 0) {
      appendAirliner(mb, rngAt(st.x, st.z), st.x, yP, st.z, st.yaw, 32.8);
      c.note('airliner');
      // Nose along local +Z; the door is aft on the left, so the stairs stand off to that side
      // facing the fuselage, and the baggage train draws up behind them.
      const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
      const rx = fz, rz = -fx;
      const sx = st.x + fx * 5.2 - rx * 3.6, sz = st.z + fz * 5.2 - rz * 3.6;
      appendAirstairs(mb, sx, yP, sz, Math.atan2(rx, rz));
      c.note('airstairs');
      if (hash01(st.x, st.z) < 0.55) {
        const gx = st.x - fx * 4.0 - rx * 6.4, gz = st.z - fz * 4.0 - rz * 6.4;
        appendGSECart(mb, rngAt(gx, gz), gx, yP, gz, st.yaw, 2);
        c.note('gseCart');
      }
    } else {
      appendLightPlane(mb, rngAt(st.x, st.z), st.x, yP, st.z, st.yaw);
      c.note('lightPlane');
    }
    n++;
  }
  // A frangible sign at each end of every holding position: yellow location boards along the
  // taxiways, red-and-white mandatory boards where a taxiway meets a runway.
  for (let i = 0; i < A.holds.length; i++) {
    const p = A.holds[i].p;
    if (p.length < 2) continue;
    let tx = p[p.length - 1][0] - p[0][0], tz = p[p.length - 1][1] - p[0][1];
    const l = Math.hypot(tx, tz);
    if (!(l > EPS)) continue;
    tx /= l; tz /= l;
    for (let k = 0; k < 2; k++) {
      const e = k === 0 ? p[0] : p[p.length - 1];
      const sg = k === 0 ? -1 : 1;
      const x = e[0] + tx * sg * 3.2, z = e[1] + tz * sg * 3.2;
      if (!inBox(x, z)) continue;
      if (!c.claim(x, z, 1.6)) continue;
      appendAirfieldSign(mb, x, A.y + 0.02, z, Math.atan2(tx, tz), true);
      c.note('airfieldSign');
      n++;
    }
  }
  if (A.runways.length) {
    const R = A.runways[0];
    const wx = R.thresh[0].x + R.ux * R.len * 0.5 - R.thresh[0].uz * (R.way.hw + 34);
    const wz = R.thresh[0].z + R.uz * R.len * 0.5 + R.thresh[0].ux * (R.way.hw + 34);
    if (inBox(wx, wz) && c.claim(wx, wz, 3)) {
      appendWindsock(mb, wx, A.y, wz, Math.atan2(-R.uz, R.ux));
      c.note('windsock');
      n++;
    }
  }
  for (let i = 0; i < A.fence.length; i++) {
    const f = A.fence[i];
    const cx = (f[0] + f[2]) * 0.5, cz = (f[1] + f[3]) * 0.5;
    if (!inBox(cx, cz)) continue;
    const len = Math.hypot(f[2] - f[0], f[3] - f[1]);
    if (!(len > 0.5)) continue;
    const y = c.groundY(cx, cz);
    if (!isNum(y)) continue;
    appendChainFence(mb, cx, y, cz, Math.atan2(f[2] - f[0], f[3] - f[1]), len, 2.6);
    c.note('airportFence');
    n++;
  }
  return n;
}

/* ----------------------------------------------------------- marine detail */

function placeIslandMarine(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const wY = isle.waterY;
  let n = 0;
  for (let i = 0; i < isle.docks.length; i++) {
    const d = isle.docks[i];
    if (d.x < x0 || d.x >= x1 || d.z < z0 || d.z >= z1) continue;
    const g = d.run.g[d.at];
    const yaw = Math.atan2(-d.nz, d.nx);
    // The dock deck sits just off the edge, out over the water, at the bank level it serves.
    const px = d.x + d.nx * 5.0, pz = d.z + d.nz * 5.0;
    appendFerryDock(mb, px, Math.max(wY + 0.9, g), pz, yaw, 9.0, 22.0);
    c.note('ferryDock');
    n++;
    if (hash01(d.x, d.z) < 0.5) {
      const bx = d.x + d.nx * 24.0, bz = d.z + d.nz * 24.0;
      appendIslandFerry(mb, rngAt(bx, bz), bx, wY, bz, yaw + Math.PI * 0.5, 42.0);
      c.note('islandFerry');
      n++;
    }
    if (c.claim(d.x - d.nx * 2.2, d.z - d.nz * 2.2, 1.0)) {
      appendMooringBollard(mb, d.x - d.nx * 2.2, g, d.z - d.nz * 2.2, yaw);
      c.note('mooringBollard');
      n++;
    }
    // Somewhere to wait for the boat. Set back on the land side, off the dock itself.
    const sx = d.x - d.nx * 9.0, sz = d.z - d.nz * 9.0;
    const sy = c.reserve('ferryShelter', sx, sz, 3.0, -1, 2.9);
    if (isNum(sy)) {
      appendTransitShelter(mb, sx, sy + 0.02, sz, yaw, 5.6);
      n++;
    }
  }

  // Handrails along the island bridges. city.js builds the deck, the fascia and the abutments;
  // a lagoon crossing with nothing at the edge is the one thing that still reads as unfinished.
  for (let b = 0; b < isle.bridges.length; b++) {
    const br = isle.bridges[b];
    const hw = clamp(br.w * 0.5, 1.2, 6.0) + 0.25;
    const pts = resample(br.p, 5.0);
    for (let i = 0; i + 1 < pts.length; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) * 0.5, mz = (pts[i][1] + pts[i + 1][1]) * 0.5;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      let tx = pts[i + 1][0] - pts[i][0], tz = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(tx, tz);
      if (!(l > EPS)) continue;
      tx /= l; tz /= l;
      const y = c.groundY(mx, mz);
      if (!isNum(y)) continue;
      for (let sd = -1; sd <= 1; sd += 2) {
        appendTimberRail(mb, mx - tz * hw * sd, y + 0.02, mz + tx * hw * sd,
          Math.atan2(tx, tz), l);
        c.note('bridgeRail');
        n++;
      }
    }
  }
  return n;
}

/* ------------------------------------------------------------- Centreville */

function placeCentreville(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  let n = 0;
  for (let i = 0; i < isle.rides.length; i++) {
    const R = isle.rides[i];
    if (R.cx < x0 || R.cx >= x1 || R.cz < z0 || R.cz >= z1) continue;
    // The massing extract models most of the rides as blocks. Where it does, that IS the ride and
    // a second structure on the same spot would be a duplicate; only the ones it missed are
    // built, and every one of them gets its fence, its bedding and its bins either way.
    const yaw = hash01(R.cx, R.cz) * TAU;
    let clear = !c.inFootprint(R.cx, R.cz, 2.0);
    for (let k = 0; k < 4 && clear; k++) {
      const sx = (k & 1) ? 1 : -1, sz = (k & 2) ? 1 : -1;
      if (c.inFootprint(R.cx + sx * R.w * 0.42, R.cz + sz * R.d * 0.42, 1.0)) clear = false;
    }
    if (clear) {
      const y = c.reserve('ridePad', R.cx, R.cz, Math.min(R.w, R.d) * 0.4, -1, 4.0);
      if (isNum(y)) {
        const kind = R.type === 'log_flume' ? 2 : (R.type === 'car_ride' ? 1 : 0);
        appendRidePad(mb, rngAt(R.cx, R.cz), R.cx, y + 0.02, R.cz, yaw, R.w, R.d, kind);
        n++;
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = hash01(R.cx + k * 7.7, R.cz - k * 3.3) * TAU;
      const rad = Math.max(R.w, R.d) * 0.5 + 3.5 + hash01(R.cz + k, R.cx) * 5.0;
      const px = R.cx + Math.cos(a) * rad, pz = R.cz + Math.sin(a) * rad;
      const u = hash01(px, pz);
      if (u < 0.34) {
        const y = c.reserve('islandBed', px, pz, 1.5, 1.0, 0.6);
        if (isNum(y)) { appendFlowerBed(mb, rngAt(px, pz), px, y + 0.02, pz, a, 2.6, 1.8); n++; }
      } else if (u < 0.62) {
        const y = c.reserve('bench', px, pz, 1.2, 1.0, 0.9);
        if (isNum(y)) { appendBench(mb, px, y + 0.02, pz, a); n++; }
      } else if (u < 0.80) {
        const y = c.reserve('litterBin', px, pz, 0.7, 1.0, 1.1);
        if (isNum(y)) { appendLitterBin(mb, px, y + 0.02, pz, a); n++; }
      } else {
        const y = c.reserve('timberRail', px, pz, 1.0, 1.0, 1.1);
        if (isNum(y)) { appendTimberRail(mb, px, y + 0.02, pz, a, 5.0); n++; }
      }
    }
  }
  return n;
}

/**
 * Gibraltar Point. Placed FIRST, before anything scatters: it is one building in three square
 * kilometres of parkland and a canopy tree must never be the reason it is missing — the same
 * rule city.js uses for the rare things it chooses city-wide before the tiles run.
 */
function placeLighthouse(isle, c, x0, z0, x1, z1) {
  const lx = LIGHTHOUSE[0], lz = LIGHTHOUSE[1];
  if (lx < x0 || lx >= x1 || lz < z0 || lz >= z1) return 0;
  const y = c.reserve('lighthouse', lx, lz, 4.2, -1, LIGHTHOUSE_H + 6);
  if (!isNum(y)) return 0;
  appendLighthouse(c.mb.props, lx, y, lz, LIGHTHOUSE_H);
  // A keeper's path of clipped hedge either side, so it does not stand in bare grass.
  for (let k = 0; k < 2; k++) {
    const px = lx + (k ? 7.5 : -7.5), pz = lz + 4.0;
    const hy = c.reserve('islandHedge', px, pz, 1.4, -1, 1.6);
    if (isNum(hy)) appendHedgeRun(c.mb.props, rngAt(px, pz), px, hy + 0.03, pz, 0, 7.0, 1.1, 0.8);
  }
  return 1;
}


/* --------------------------------------------------- cottages and slipways */

/**
 * Pitched roofs on the island cottages.
 *
 * The massing extract has no roof pitch, and every house on Ward's and Algonquin is pitched;
 * without this the community is two hundred flat-topped boxes. The ridge follows the footprint's
 * long axis, which is what a builder would do on a lot that narrow.
 */
function placeIslandRoofs(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.buildings;
  let n = 0;
  for (let i = 0; i < c.buildings.length; i++) {
    const b = c.buildings[i];
    if (!b || !Array.isArray(b.rings) || !b.rings.length) continue;
    const cx = b.cx, cz = b.cz;
    if (!isNum(cx) || cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    if (!isNum(b.h) || b.h > 12 || b.h < 2) continue;
    const ring = b.rings[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const area = Math.abs(planArea(ring));
    if (area < 25 || area > 420) continue;
    if (!onIsland(isle, cx, cz) || onAirfield(isle, cx, cz)) continue;
    // Longest edge sets the ridge direction; the extents across it set the roof rectangle.
    let bl = 0, dx = 1, dz = 0;
    for (let k = 1; k < ring.length; k++) {
      const ex = ring[k][0] - ring[k - 1][0], ez = ring[k][1] - ring[k - 1][1];
      const l = ex * ex + ez * ez;
      if (l > bl) { bl = l; dx = ex; dz = ez; }
    }
    const dl = Math.hypot(dx, dz);
    if (!(dl > EPS)) continue;
    dx /= dl; dz /= dl;
    let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const px = ring[k][0] - cx, pz = ring[k][1] - cz;
      const a = px * dx + pz * dz;
      const t = -px * dz + pz * dx;
      if (a < lo0) lo0 = a;
      if (a > hi0) hi0 = a;
      if (t < lo1) lo1 = t;
      if (t > hi1) hi1 = t;
    }
    const along = hi0 - lo0, across = hi1 - lo1;
    if (!(along > 1.5) || !(across > 1.5)) continue;
    const mx = cx + dx * (lo0 + hi0) * 0.5 - dz * (lo1 + hi1) * 0.5;
    const mz = cz + dz * (lo0 + hi0) * 0.5 + dx * (lo1 + hi1) * 0.5;
    const pitch = clamp(across * 0.30, 1.1, 3.2);
    appendGableRoof(mb, rngAt(mx, mz), mx, b.y + b.h, mz, Math.atan2(dx, dz),
      across, along, pitch);
    c.note('islandRoof');
    n++;
  }
  return n;
}

// A concrete ramp at each island yacht club, where the marina basin meets the bank. The clubs are
// surveyed as basins with no landing of any kind, and a marina you cannot get a boat into is a
// hole in the story.
function placeIslandSlipways(H, isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  let n = 0;
  for (let m = 0; m < H.marinas.length; m++) {
    const rec = H.marinas[m];
    const hit = nearIsleStation(isle, rec.cen[0], rec.cen[1], 200);
    if (!hit) continue;
    const x = hit.x, z = hit.z;
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    if (!c.claim(x, z, 6.0)) continue;
    const run = hit.run, i = hit.i;
    appendSlipway(mb, x - run.nx[i] * 2.0, run.g[i], z - run.nz[i] * 2.0,
      Math.atan2(-run.nz[i], run.nx[i]), 7.0, 14.0, run.g[i] - (isle.waterY - 1.1));
    c.note('slipway');
    n++;
  }
  return n;
}

// Hangars the massing extract missed. Where it has a building, that IS the hangar and a second
// shell on top of it would be a duplicate; where it has nothing, the aeroway=hangar footprint
// gives the span, the depth and the door line.
function placeHangars(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.buildings;
  let n = 0;
  for (let i = 0; i < AERO_HANGAR.length; i++) {
    const p = pairs(AERO_HANGAR[i][1]);
    if (p.length < 4) continue;
    const bb = bboxOf(p);
    const cx = (bb[0] + bb[2]) * 0.5, cz = (bb[1] + bb[3]) * 0.5;
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    if (c.inFootprint(cx, cz, 3.0)) continue;
    let bl = 0, dx = 1, dz = 0;
    for (let k = 1; k < p.length; k++) {
      const ex = p[k][0] - p[k - 1][0], ez = p[k][1] - p[k - 1][1];
      const l = ex * ex + ez * ez;
      if (l > bl) { bl = l; dx = ex; dz = ez; }
    }
    const dl = Math.hypot(dx, dz);
    if (!(dl > EPS)) continue;
    dx /= dl; dz /= dl;
    let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
    for (let k = 0; k < p.length; k++) {
      const px = p[k][0] - cx, pz = p[k][1] - cz;
      const a = px * dx + pz * dz, t = -px * dz + pz * dx;
      if (a < lo0) lo0 = a;
      if (a > hi0) hi0 = a;
      if (t < lo1) lo1 = t;
      if (t > hi1) hi1 = t;
    }
    const along = hi0 - lo0, across = hi1 - lo1;
    if (!(along > 6) || !(across > 6)) continue;
    const y = c.groundY(cx, cz);
    if (!isNum(y)) continue;
    appendHangar(mb, rngAt(cx, cz), cx, y, cz, Math.atan2(dx, dz), across, along,
      clamp(Math.min(across, along) * 0.34, 5.5, 13.0));
    c.note('hangar');
    n++;
  }
  return n;
}

/* --------------------------------------------------------------- public API */

function makeIsleCtx(H, ctx) {
  return {
    mb: ctx.mb,
    data: ctx.data || null,
    H,
    groundY: typeof ctx.groundY === 'function' ? ctx.groundY : () => H.waterY,
    reserve: typeof ctx.reserve === 'function' ? ctx.reserve : () => NaN,
    claim: typeof ctx.claim === 'function' ? ctx.claim : () => true,
    note: typeof ctx.note === 'function' ? ctx.note : () => {},
    inFootprint: typeof ctx.inFootprint === 'function' ? ctx.inFootprint : () => false,
    buildings: Array.isArray(ctx.buildings) ? ctx.buildings : [],
  };
}

/** The rectangle the island work can put geometry in, so city.js can size the tile boxes. */
export function islandBounds(H) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length) return null;
  const b = isle.bbox.slice();
  if (isle.air) {
    const a = isle.air.bbox;
    if (a[0] < b[0]) b[0] = a[0];
    if (a[1] < b[1]) b[1] = a[1];
    if (a[2] > b[2]) b[2] = a[2];
    if (a[3] > b[3]) b[3] = a[3];
  }
  const pad = Math.max(BEACH_BACK, BEACH_FACE + BEACH_TOE) + AIR_APPROACH_STEP * AIR_APPROACH_BARS;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Private cars are banned on the Toronto Islands. Nothing may park one there. */
export function harbourCarFree(H, x, z) {
  const isle = H && H.isle;
  if (!isle || !isle.rings.length) return false;
  if (x < isle.bbox[0] || x > isle.bbox[2] || z < isle.bbox[1] || z > isle.bbox[3]) return false;
  return onIsland(isle, x, z);
}

/**
 * The island cottage height fix.
 *
 * A DATA DEFECT, in the same class as the CN Tower's missing mast. The massing dataset takes
 * h = max(AVG_HEIGHT, MAX_HEIGHT), and on the islands the LiDAR return over a cottage under
 * mature canopy is the canopy: the median height on Ward's and Algonquin comes out at 19.9 m on
 * a 100 m2 footprint, which is a six-storey tower on a garden shed's plot. 225 of the 288
 * records read over 12 m. Amendment 9 says a believable invention beats a wrong survey, so a
 * small island footprint is capped at a plausible cottage height, hashed on world position so it
 * is the same house every time.
 */
export function islandBuildingHeight(H, cx, cz, area, h) {
  const isle = H && H.isle;
  if (!isle || !isNum(h) || !isNum(area) || !isNum(cx) || !isNum(cz)) return h;
  if (area >= 600 || h <= 8) return h;
  if (cx < isle.bbox[0] || cx > isle.bbox[2] || cz < isle.bbox[1] || cz > isle.bbox[3]) return h;
  if (!onIsland(isle, cx, cz)) return h;
  const cap = 4.6 + area * 0.0075 + hash01(cx, cz) * 1.4;
  return h > cap ? cap : h;
}

/**
 * Island MASSING: the shore mantle, the boardwalks and the airfield surface. Emits only what the
 * tile box [x0, z0) x [x1, z1) owns, so this is the per-tile path ARCHITECTURE.md asks for and
 * nothing is captured, duplicated or clipped.
 */
export function appendIslandMass(H, ctx, x0, z0, x1, z1) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length || !ctx || !ctx.mb) return null;
  const c = makeIsleCtx(H, ctx);
  appendIsleShores(isle, c, x0, z0, x1, z1);
  appendIsleBoardwalks(isle, c, x0, z0, x1, z1);
  appendAirfield(isle, c, x0, z0, x1, z1);
  placeHangars(isle, c, x0, z0, x1, z1);
  return isle.stats;
}

/**
 * Island DETAIL: the tree cover, the gardens, the beach, the airfield lights and aircraft, the
 * ferries, Centreville, the lighthouse and the cottage roofs. Same tile-box contract.
 */
export function appendIslandDetail(H, ctx, x0, z0, x1, z1) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length || !ctx || !ctx.mb) return null;
  const c = makeIsleCtx(H, ctx);
  placeLighthouse(isle, c, x0, z0, x1, z1);
  placeIslandGreen(isle, c, x0, z0, x1, z1);
  placeShoreProps(isle, c, x0, z0, x1, z1);
  placeAirfieldDetail(isle, c, x0, z0, x1, z1);
  placeIslandMarine(isle, c, x0, z0, x1, z1);
  placeIslandSlipways(H, isle, c, x0, z0, x1, z1);
  placeCentreville(isle, c, x0, z0, x1, z1);
  placeIslandRoofs(isle, c, x0, z0, x1, z1);
  return isle.stats;
}

/** The island counters, for the console audit and the harness. */
export function islandStats(H) {
  const isle = H && H.isle;
  return isle ? isle.stats : null;
}

export default {
  buildHarbour, carveHarbourTerrain, harbourWaterAt, harbourTileHasWater, harbourDeckY,
  appendHarbour, harbourStats,
  appendIslandMass, appendIslandDetail, islandBounds, islandStats, harbourCarFree,
  islandBuildingHeight,
};
