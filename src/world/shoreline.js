// src/world/shoreline.js — turning the surveyed shore ways into a usable shoreline: chaining the
// ways into runs and rings, the point-in-lake water field and its two public queries, the enclosed
// basins, the per-station shoreline model, and the uniform-grid indices over the lot.
//
// CONTRACT.md §8.3. Tunables, materials and the shared helpers are in ./waterkit.js.
//
// data/toronto.json carries the boundary as survey — shore[] ways clipped from the OSM Lake
// Ontario multipolygon, and waterfront[] engineered edges — but as ways, in no particular order
// and with no particular orientation. Everything in this file is the work of turning that into
// something the terrain carve and the geometry pass can ask questions of: is this point in the
// lake, where is the nearest shore station, which way does it face, and how far out is the wall.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  BASIN_MIN_AREA, BASIN_REACH, EPS, GRID_CELL, GRID_REACH, STATION, bboxOf, distToSeg, planArea,
  pointInRing, polyLength, resample,
} from './waterkit.js';

// Join ways that share an endpoint into the longest chains available. The OSM multipolygon
// arrives split into ways in no particular order; the full-city extract will have more of them.
export function chainWays(ways) {
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
export function makeWaterField(outerChains, innerChains, basinRings) {
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

export function waterAt(F, x, z) {
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
export function findBasins(data, field, chains, rect) {
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

// One run of quay: a resampled piece of shoreline inside the working rect, with an outward
// (water-side) normal, a mitre offset, the quay ground level and the apron width at every station.
export function buildRuns(chains, rect, F) {
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
export function makeShoreIndex(runs, rect) {
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
export function nearestShore(H, x, z) {
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

// A deck polygon (pier, terminal apron) the player can stand on. Indexed by bbox in a coarse grid.
export function makeDeckIndex(polys, rect) {
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

export function deckPolyAt(D, x, z) {
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
