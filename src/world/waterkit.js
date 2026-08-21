// src/world/waterkit.js — the tunables, materials and small helpers every harbourfront and
// island module in world/ is written against.
//
// CONTRACT.md §8.3 / Amendment 11.1. Zero dependencies. World axes: X = east, Y = up, Z = south,
// true metres.
//
// Nothing here knows about Toronto. It is the numbers that decide how deep the lake bed is cut and
// how far the quay wall stands proud, the palette the waterfront is painted from, and the polygon
// predicates and emit helpers (triUp, quadUp, quadOut, boxTop, earClip, resample, ...) the rest of
// the section shares. Everything else in the harbourfront/island section sits above it:
// islandkit.js, shoreline.js, airfield.js, islandterrain.js, islanddetail.js, islands.js,
// water.js and quay.js.
//
// The polygon routines here are deliberately NOT geom/ring.js's and geom/triangulate.js's: they
// are the ones this section was written and measured against, and swapping them is a behaviour
// change, not a move. See ARCHITECTURE.md for the consolidation that is still owed.

import { clamp, makeRng } from '../core/math.js';
import { hashCell } from '../core/util.js';

export const EPS = 1e-9;

export const STATION = 5.0;            // shoreline resample step, metres

// The lake bed falls away from the surveyed line at this slope, to this depth. Both numbers are
// about the TERRAIN GRID, not about bathymetry: nothing under an opaque lake is ever seen. What
// they control is where the grid's own zero crossing lands. Between a land vertex at height hl and
// a water vertex at -hw the interpolated height crosses the datum at hl/(hl+hw) of the way across
// the cell, so a steep, deep bed pulls that crossing hard towards the land vertex and the terrain
// can never stand proud of the lake more than about cell*hl/(hl+LAKE_DEPTH) — a metre or three,
// which the quay wall then covers. The land side is left completely alone (see carveHarbourTerrain).
export const SHORE_SLOPE = 0.9;

export const LAKE_DEPTH = 14.0;

export const DECK_SAMPLE = 22.0;       // how far inland the quay level is read off the surveyed terrain

export const DECK_MIN = 0.95;          // quay ground is never closer than this to the water

export const DECK_MAX = 7.0;

export const APRON_MIN = 3.4;          // narrowest quay apron

export const APRON_MAX = 34.0;         // widest — one terrain cell plus the shoreline blend band

export const APRON_STEP = 1.5;

// Ground-plane heights, relative to the local quay GROUND level (what groundY returns).
//
// The apron sits at EXACTLY ground level — the bottom rung of city.js's ground ladder. That is
// deliberate: a third of the band the apron has to cover is park, grass or plaza in the extract,
// and every one of those covers is draped on groundY at its own rung (grass 0.022, park 0.098,
// path 0.174, kerbed walk 0.22). Laying the apron under all of them means the quay carries the
// real ground cover wherever the survey has one, and the promenade paving shows only where it
// does not. The coping is the exception: a raised granite edge band that has to win against
// everything, so it sits one rung above the highest of them.
export const APRON_Y = 0.0;            // promenade paving == the quay ground

export const COPE_TOP = 0.26;          // granite edge band, proud of every ground cover

export const COPE_W = 0.72;

export const PIER_LIFT = 0.03;         // a pier deck stands a hair above the apron it meets

export const BOARD_LIFT = 0.38;        // timber boardwalk deck, genuinely raised above the paving

export const TRAIL_LIFT = 0.30;        // asphalt recreational trail

export const BEVEL = 2.4;              // the apron's inland edge ramps down over this...

export const BEVEL_DROP = 0.10;        // ...and finishes BELOW the ground, so the two surfaces cross at

                                // an angle instead of lying coplanar and fighting for the depth
// How far the apron's inland edge may follow the ground down. On a spit or between two basins the
// grid has no land vertex to hold the ground up and reads well below quay level; the apron stops
// chasing it there, which leaves a step of at most EDGE_DROP_MAX + BEVEL_DROP against the 0.45 m
// walkable limit (CONTRACT §8.2) instead of a two-metre dive.
export const EDGE_DROP_MAX = 0.25;

export const WALL_PROUD = 0.55;        // the wall face stands at least this far out into the water...

export const WALL_PROUD_MAX = 9.5;     // ...and as much as this, where the terrain grid needs covering

export const WALL_FOOT = -4.6;

export const FOULED_TOP = -0.16;       // below this the wall carries marine growth

export const FENDER_SPACING = 9.0;

export const BOLLARD_SPACING = 21.0;

export const LADDER_SPACING = 58.0;

export const LIFEBUOY_SPACING = 112.0;

export const QUAY_LAMP_SPACING = 34.0;

export const BENCH_SPACING = 62.0;

export const PIER_W = 6.5;             // a linear pier way with no width in the data

export const FINGER_W = 1.35;          // marina finger berth

export const FINGER_MAX_LEN = 46.0;    // longer than this and a pier way is a fixed pier, not a float

export const FLOAT_TOP = 0.42;         // floating dock deck above the water

export const FLOAT_DRAFT = 0.30;

export const PILE_SPACING = 7.5;

export const MOUND_CELL = 2.0;         // rubble-mound raster

export const MOUND_SLOPE = 4.2;        // horizontal run from toe to crest

export const MOUND_CREST = 1.65;

export const MOUND_TOE = -2.5;

export const GROYNE_HW = 4.5;

export const GRID_CELL = 32.0;         // shoreline segment index; segments are inserted inflated by

export const GRID_REACH = APRON_MAX;   // GRID_REACH so a query only ever reads its own cell

// A slip or a boat basin cut into the quay is often mapped as its own water polygon rather than
// as part of the lake multipolygon. One that is big enough, close enough to the surveyed
// shoreline, and entirely outside it is harbour water: it gets carved, walled and filled like the
// rest, instead of being flattened into a pond slab sitting a metre and a half above the lake.
export const BASIN_MIN_AREA = 250.0;

export const BASIN_REACH = 45.0;

// Moored craft. The pre-expansion extract had two marinas in it; the map now carries seven, four
// of them island yacht clubs, and a global budget of 26 left whichever the extract happened to
// list last completely empty. The per-basin cap is what stops one big basin eating the lot.
export const MAX_MOORED = 84;

export const MAX_MOORED_BASIN = 14;

export const MAX_ROCKS = 420;

export const M = {
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

const _q = new Float64Array(12);      // one quad, four (x, y, z) corners

// Deterministic [0, 1) from a world position. CONTRACT §8.4: never hash an array index. The
// harbour quantises to 1/32 m; the mixer itself is core/util.js's.
export function hash01(x, z) {
  return hashCell(x, z, 32);
}

// An rng seeded on WORLD POSITION (CONTRACT §8.4). A moored boat is the same boat whatever order
// the marinas were built in, and stays the same boat when the city is tiled.
export function rngAt(x, z) {
  return makeRng((hash01(x, z) * 4294967296) >>> 0);
}

export function setMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m[6]);
}

// A horizontal triangle, always wound so the normal comes out +Y. Returns 1 if it was flipped to
// get there, which is how the ribbon fold counter is fed.
export function triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
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

export function quadUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const f0 = triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz);
  const f1 = triUp(mb, ax, ay, az, cx, cy, cz, dx, dy, dz);
  // Both halves wound the same way means the quad is simply convex the other way round, which
  // triUp has already fixed. One of each means the quad is folded: the ribbon crossed itself.
  return f0 === f1 ? 0 : 1;
}

// A quad emitted so its face points along (ox, oy, oz). Corners in either rotational order.
export function quadOut(mb, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, ox, oy, oz) {
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
export function boxTop(mb, cx, cz, hx, hz, y0, y1, yaw) {
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

export function polyLength(p) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

// Signed area in PLAN space (u = x, v = -z), so positive means counter-clockwise on paper.
export function planArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += p[j][0] * (-p[i][1]) - p[i][0] * (-p[j][1]);
  }
  return a * 0.5;
}

export function isClosed(p) {
  const n = p.length;
  return n > 3 && Math.abs(p[0][0] - p[n - 1][0]) < 0.05 && Math.abs(p[0][1] - p[n - 1][1]) < 0.05;
}

export function pointInRing(p, x, z) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const zi = p[i][1], zj = p[j][1];
    if ((zi > z) === (zj > z)) continue;
    const t = (z - zi) / (zj - zi);
    if (x < p[i][0] + (p[j][0] - p[i][0]) * t) inside = !inside;
  }
  return inside;
}

export function distToSeg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > EPS) t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
  const qx = ax + dx * t, qz = az + dz * t;
  return Math.hypot(x - qx, z - qz);
}

export function distToPoly(x, z, p) {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const d = distToSeg(x, z, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    if (d < best) best = d;
  }
  return best;
}

export function bboxOf(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i++) {
    if (p[i][0] < x0) x0 = p[i][0];
    if (p[i][0] > x1) x1 = p[i][0];
    if (p[i][1] < z0) z0 = p[i][1];
    if (p[i][1] > z1) z1 = p[i][1];
  }
  return [x0, z0, x1, z1];
}

export function centroidOf(p) {
  let x = 0, z = 0;
  for (let i = 0; i < p.length; i++) { x += p[i][0]; z += p[i][1]; }
  return [x / p.length, z / p.length];
}

export function resample(p, step) {
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
export function earClip(p) {
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

export function sampleTerrain(T, x, z) {
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
