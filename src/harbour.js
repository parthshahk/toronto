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

const MAX_MOORED = 26;
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
      const d = hit ? hit.d : LAKE_DEPTH / SHORE_SLOPE;
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
  const G = H.index;
  if (!isNum(x) || !isNum(z)) return y;
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
    for (let z = bb[1] + 18; z < bb[3] - 8 && c.moored < MAX_MOORED; z += 34) {
      for (let x = bb[0] + 18; x < bb[2] - 8 && c.moored < MAX_MOORED; x += 34) {
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
      appendPedestrianLamp(mb, x, st.g + deck, z, yaw + Math.PI, 5.2);
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

export default {
  buildHarbour, carveHarbourTerrain, harbourWaterAt, harbourTileHasWater, harbourDeckY,
  appendHarbour, harbourStats,
};
