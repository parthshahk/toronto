// src/world/islandkit.js — the tunables, palette and spatial helpers the island and airfield
// modules share.
//
// CONTRACT.md §8.3 / Amendment 11.1. The numbers here decide the island edge cross-sections (how
// far a beach reaches back, how steep a riprap face is, how deep a seawall toe sits), the airfield
// pavement widths and light spacings, and the density of everything scattered on the islands. The
// helpers are the uniform-grid segment and ring indices ./islands.js builds and ./islanddetail.js,
// ./islandterrain.js and ./airfield.js query.
//
// It sits below all four of them so the dependency arrows point one way (Amendment 11.2): nothing
// here imports anything from world/ except ./waterkit.js.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { distToPoly, distToSeg, pointInRing } from './waterkit.js';

export const ISLE_MIN_AREA = 300.0;      // m^2 — smaller rings are mapped rocks, not islands

export const ISLE_STATION = 6.0;         // island shore resample step

export const ISLE_GRID = 34.0;           // island edge index cell

// How far a query may look. This MUST cover the widest mantle: the ground field and the geometry
// read the same station arrays, and a reach shorter than the cover would draw sand the ground
// field does not know about.
export const ISLE_REACH = 62.0;

export const EDGE_RIP = 0;               // rubble-mound bank — the lagoons and the channel sides

export const EDGE_BEACH = 1;             // sand, with a swash zone and a submerged toe

export const EDGE_WALL = 2;              // low concrete seawall — docks, marinas, the airport perimeter

export const HARD_NEAR = 13.0;           // a surveyed structure this close makes the edge engineered

export const OPEN_LAKE = 900.0;          // open water this far out along the normal = a lake shore

export const OPEN_STEP = 45.0;

export const BANK_MIN = 0.55;            // island bank level above the lake, at its lowest

export const BANK_MAX = 6.00;

export const BANK_SAMPLE = 16.0;         // how far inland the bank level is read off the terrain

export const BEACH_BACK = 22.0;          // dry sand inland of the surveyed line, at its widest

export const BEACH_BACK_MIN = 9.0;

export const BEACH_FACE = 12.0;          // shore line out to the waterline

export const BEACH_TOE = 9.0;            // and on under the water

export const BEACH_TOE_DROP = 0.85;

export const BEACH_FREE = 0.42;          // the surveyed line stands this far above the lake on a beach

export const RIP_BACK = 4.2;

export const RIP_FACE = 4.6;

export const RIP_TOE = 3.4;

export const RIP_TOE_DROP = 2.05;

export const RIP_FREE = 0.72;

export const WALL_BACK = 3.8;

export const WALL_FACE = 0.55;

export const WALL_TOE = 1.30;

export const WALL_TOE_DROP = 2.60;

export const WALL_FREE = 1.05;           // island seawalls are LOW; a metre of freeboard, not a quay

export const ISLE_BACK_MAX = 58.0;       // how far inland the cover may run to find real ground

export const ISLE_TOE_MAX = 15.0;        // and how far out the toe may run to find the lake bed

export const MANTLE_SINK = 0.14;         // the inland edge finishes below the ground, so they cross

export const SWASH = 0.55;               // fraction of the face that is dry sand rather than swash

export const AIR_SHOULDER = 9.0;         // graded shoulder outside the paved edge

export const AIR_BLEND = 26.0;           // and the distance the flattening blends back to the survey

export const AIR_RUN_HW = 15.0;          // runway half width where the extract gives no width tag

export const AIR_TAXI_HW = 9.0;

export const AIR_MARK = 0.034;           // paint proud of the pavement; city.js's proven value

export const AIR_EDGE_LIGHT = 60.0;      // runway edge light spacing

export const AIR_TAXI_LIGHT = 48.0;

export const AIR_APPROACH_BARS = 9;

export const AIR_APPROACH_STEP = 33.0;

export const AIR_CELL = 8.0;             // airfield occupancy raster, for the perimeter fence

export const AIR_FENCE_OUT = 74.0;       // the perimeter runs this far outside the pavement

export const ISLE_TREE_CELL = 12.8;      // island canopy lattice; mature parkland, not a plantation

export const ISLE_TREE_MAX = 900;        // per tile

export const ISLE_SHORE_PROP = 42.0;     // one beach prop per this many metres of beach

const MAX_ISLE_BOATS = 8;         // moored craft per tile

/* ----------------------------------------------------------------- materials */

// Island and airfield albedos. Same rules as M above: physical constants, no baked light, and
// emissive only where the real thing emits.
export const IM = {
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

// [x, z, x, z, ...] -> [[x, z], ...]. The baked tables are flat because a flat literal is a
// third of the bytes of an array of pairs and parses in a fraction of the time.
export function pairs(flat) {
  const out = new Array(flat.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = [flat[i * 2], flat[i * 2 + 1]];
  return out;
}

// A uniform grid over line segments, for nearest-segment queries. Every segment is inserted into
// each cell its bounding box touches once inflated by `reach`, so a lookup within `reach` reads
// exactly one cell and the whole thing stays linear in feature count (CONTRACT 8.4).
export function makeSegIndex(rect, cell, reach) {
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

export function addWay(G, p, tag, closeIt) {
  if (!Array.isArray(p) || p.length < 2) return;
  for (let i = 1; i < p.length; i++) addSeg(G, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], tag);
  if (closeIt) {
    const a = p[p.length - 1], b = p[0];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) addSeg(G, a[0], a[1], b[0], b[1], tag);
  }
}

const _seg = { d: Infinity, tag: 0 };

// Nearest segment within the index's reach. Fills and returns the module-scope _seg, or null.
export function nearSeg(G, x, z) {
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
export function makeRingIndex(polys, rect, cell) {
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

export function ringAt(R, x, z, pad) {
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

export function boxHit(bb, x0, z0, x1, z1) {
  return !(bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1);
}

// True bearing of a -> b, in degrees clockwise from north. World north is -z.
export function bearingOf(ax, az, bx, bz) {
  const d = Math.atan2(bx - ax, -(bz - az)) * 180 / Math.PI;
  return d < 0 ? d + 360 : d;
}

/* -------------------------------------------------------------- island edge */

// Smooth a per-station array round a LOOP, so the ring's start point is not a discontinuity.
export function smoothLoop(a, n, half, passes) {
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

// Is (x, z) island land? The rings are the survey, so this is exact rather than a terrain guess.
export function onIsland(isle, x, z) {
  for (let i = 0; i < isle.rings.length; i++) {
    const R = isle.rings[i];
    if (x < R.bbox[0] || x > R.bbox[2] || z < R.bbox[1] || z > R.bbox[3]) continue;
    if (pointInRing(R.p, x, z)) return true;
  }
  return false;
}
