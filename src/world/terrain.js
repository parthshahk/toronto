// src/world/terrain.js — the height field: build, pad, sample, and the cut.
//
// CONTRACT.md §1 and Amendment 11.1. Moved out of city.js unchanged. Everything the ground is
// made of lives here and nowhere else:
//
//   makeTerrain()      the grid off data.terrain, the fallback shoreline for an extract with no
//                      surveyed one, the ponds, and groundY() — the bilinear sample every other
//                      pass in the tree reads to find out where the ground is.
//   padTerrain()       edge replication out to the synthesised fringe (CONTRACT §9.3), so the
//                      ground, its normals and groundY simply continue past the survey.
//   terrainNormals()   the vertex normals, computed once the final heights are known.
//   emitTerrainRange() the ground mesh for one rectangle of the grid, which is what a tile asks
//                      for; cells a depressed corridor crosses are rebuilt at CUT_SUB so the
//                      trench has edges to sit in.
//   emitWaterMesh()    the lake. The one surface that is NOT tiled: it is visible from nearly
//                      every viewpoint in the world and is drawn by its own reflection pass.
//
// Plan space, as everywhere in this tree, is (u, v) = (x, -z): u east, v NORTH, so plan-CCW is
// positive signed area and a cap emitted from it comes out with a +Y normal.

import { clamp, lerp, smoothstep } from '../core/math.js';
import { isNum } from '../core/util.js';
import { makePart, planArea, planBBox, planContains, reverseRing } from '../geom/ring.js';
import { emitCap } from '../geom/extrude.js';
import { M, setMat } from '../city/materials.js';
import { EPS, WATER_Y, LAND_FLOOR } from './ground.js';
// HARBOURFRONT (CONTRACT §8.3). The lake sheet skips a tile the surveyed water already covers;
// harbour.js owns the shoreline, the quay wall and everything on the water.
import { harbourTileHasWater } from './shoreline.js';

// Ground-cover / infrastructure distance beyond which a terrain cell is open water. This is the
// FALLBACK shoreline, for an extract with no surveyed one: the harbour is recovered from the fact
// that land downtown is densely covered by roads, paths, piers and footprints and the lake is not,
// which lands within about +/-25 m. Where data.shore exists — it does for Toronto — harbour.js
// carves the water from the real geometry instead and this whole path is skipped (CONTRACT §8.3).
const WATER_NEAR = 88.0;
const WATER_FAR = 148.0;
const WATER_MIN_Z = 300.0;
const WATER_DEPTH = -2.2;
/* ================================================================ terrain == */

/**
 * The FALLBACK shoreline: which terrain cells are open water, decided by the absence of anything
 * built on them.
 *
 * Rasterise every road, path, rail, pier and footprint edge into the grid, run a two-pass chamfer
 * distance transform, and call the cells far from all of it — and south of WATER_MIN_Z — water.
 * This is only ever used for an extract with NO surveyed shoreline; makeTerrain skips it entirely
 * otherwise, which is why it is a function of its own rather than a block in the middle of one.
 */
function openWaterMask(nx, nz, cell, x0, z0, infraLines) {
  const dist = new Float32Array(nx * nz).fill(1e9);
  const mark = (x, z) => {
    const i = Math.round((x - x0) / cell);
    const j = Math.round((z - z0) / cell);
    if (i >= 0 && i < nx && j >= 0 && j < nz) dist[j * nx + i] = 0;
  };
  for (let l = 0; l < infraLines.length; l++) {
    const pts = infraLines[l];
    if (!pts || pts.length < 1) continue;
    mark(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], az = pts[k - 1][1];
      const bx = pts[k][0], bz = pts[k][1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(512, Math.ceil(len / (cell * 0.5)));
      for (let s = 1; s <= steps; s++) mark(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps);
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

  const mask = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    if (z < WATER_MIN_Z) continue;
    for (let i = 0; i < nx; i++) {
      mask[j * nx + i] = smoothstep(WATER_NEAR, WATER_FAR, dist[j * nx + i]) *
        smoothstep(WATER_MIN_Z, WATER_MIN_Z + 120, z);
    }
  }
  // Two box-blur passes so the shoreline reads as a beach slope rather than 25 m stair steps.
  const tmp = new Float32Array(nx * nz);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let acc = 0, w = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = i + di, b = j + dj;
            if (a < 0 || a >= nx || b < 0 || b >= nz) continue;
            acc += mask[b * nx + a]; w++;
          }
        }
        tmp[j * nx + i] = w > 0 ? acc / w : 0;
      }
    }
    mask.set(tmp);
  }
  return mask;
}

function makeTerrain(src, extent, infraLines, waterAreas, surveyedShore) {
  const nx = Math.max(2, src.nx | 0);
  const nz = Math.max(2, src.nz | 0);
  const cell = isNum(src.cell) && src.cell > 0 ? src.cell : 25;
  const x0 = -extent.x / 2;
  const z0 = -extent.z / 2;
  const h = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) h[i] = isNum(src.h[i]) ? src.h[i] : 0;

  // --- open water mask -----------------------------------------------------------------------
  // Rasterise every road, path, rail, pier and footprint edge into the terrain grid, then run a
  // chamfer distance transform. Cells far from ALL of it, south of WATER_MIN_Z, are open water.
  //
  // THE WHOLE BLOCK IS THE FALLBACK, and it is skipped outright where the extract carries a
  // surveyed shoreline: harbour.js then carves the water from the real geometry (CONTRACT §8.3)
  // and `mask` is never read again — not by the height field below, not by the terrain emitter,
  // not by anything downstream. It used to be built regardless, which cost a rasterisation of
  // every road and every building ring in the city, a two-pass chamfer transform and two box
  // blurs over the whole grid, all of it thrown away. Both of those scale — one with the extract,
  // one with its area — and neither buys anything here.
  let mask = null;
  if (!surveyedShore) mask = openWaterMask(nx, nz, cell, x0, z0, infraLines);
  // HARBOURFRONT: where the extract carries a surveyed shoreline the synthesised mask is not
  // applied at all — harbour.js carves the water from the real geometry (CONTRACT §8.3).
  for (let i = 0; i < nx * nz; i++) {
    h[i] = surveyedShore
      ? Math.max(h[i], LAND_FLOOR)
      : lerp(Math.max(h[i], LAND_FLOOR), WATER_DEPTH, clamp(mask[i], 0, 1));
  }

  // --- inland ponds: flatten the grid inside each polygon and remember the surface height ----
  const ponds = [];
  for (let a = 0; a < waterAreas.length; a++) {
    const co = waterAreas[a];
    const bb = planBBox(co);
    let lo = Infinity;
    for (let i = 0; i < co.length; i += 2) {
      const gx = clamp(Math.round((co[i] - x0) / cell), 0, nx - 1);
      const gz = clamp(Math.round((-co[i + 1] - z0) / cell), 0, nz - 1);
      lo = Math.min(lo, h[gz * nx + gx]);
    }
    if (!isFinite(lo)) continue;
    const level = lo - 0.35;
    ponds.push({ co, level });
    const i0 = clamp(Math.floor((bb[0] - x0) / cell), 0, nx - 1);
    const i1 = clamp(Math.ceil((bb[2] - x0) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((-bb[3] - z0) / cell), 0, nz - 1);
    const j1 = clamp(Math.ceil((-bb[1] - z0) / cell), 0, nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell, v = -(z0 + j * cell);
        if (planContains(co, x, v)) h[j * nx + i] = Math.min(h[j * nx + i], level - 0.45);
      }
    }
  }

  const groundY = (x, z) => {
    let fx = (x - x0) / cell;
    let fz = (z - z0) / cell;
    if (!isFinite(fx) || !isFinite(fz)) return 0;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
    if (j < 0) j = 0; else if (j > nz - 2) j = nz - 2;
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const a = h[j * nx + i], b = h[j * nx + i + 1];
    const c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };

  return { nx, nz, cell, x0, z0, h, mask, ponds, groundY, waterY: WATER_Y };
}

/**
 * Grow the terrain grid outward by `pad` metres of EDGE REPLICATION (CONTRACT §9.3).
 *
 * The bilinear sampler already clamps, so groundY outside the extract has always returned the
 * boundary value and the ground has always been *defined* out there — it simply had no mesh, no
 * normals and nothing standing on it, which is exactly what "you can see the world run out"
 * looks like. Replicating the border rows and columns into a real grid makes the surround ground
 * ordinary terrain: emitTerrainRange builds it a tile at a time, terrainNormals gives it the same
 * normal field, and the seam to the surveyed sheet is not a seam at all because the replicated
 * vertices ARE the surveyed boundary vertices.
 *
 * Run it AFTER carveHarbourTerrain, never before. The carve is what puts the lake bed below the
 * datum; replicating an uncarved border would extrude a wall of land across the open water east
 * and west of the harbour, which is the one thing the surround must not invent.
 *
 * Every grid-shaped array T carries is padded the same way — the heights, the fallback water
 * mask, and harbour.js's island-land flags, which are indexed as j * nx + i and would otherwise
 * be silently reinterpreted against the new stride.
 */
function padTerrain(T, pad) {
  const cells = Math.max(0, Math.round(pad / T.cell));
  if (cells <= 0) return T;
  const onx = T.nx, onz = T.nz;
  const nx = onx + cells * 2, nz = onz + cells * 2;
  const x0 = T.x0 - cells * T.cell, z0 = T.z0 - cells * T.cell;
  const grow = (src, Ctor) => {
    if (!src) return null;
    const dst = new Ctor(nx * nz);
    for (let j = 0; j < nz; j++) {
      const sj = clamp(j - cells, 0, onz - 1);
      for (let i = 0; i < nx; i++) {
        dst[j * nx + i] = src[sj * onx + clamp(i - cells, 0, onx - 1)];
      }
    }
    return dst;
  };
  T.h = grow(T.h, Float32Array);
  if (T.mask) T.mask = grow(T.mask, Float32Array);
  if (T.isleLand) T.isleLand = grow(T.isleLand, Uint8Array);
  T.nx = nx; T.nz = nz; T.x0 = x0; T.z0 = z0;
  T.nrm = null;                     // recomputed over the new grid by terrainNormals()
  T.pad = cells * T.cell;
  const h = T.h, cell = T.cell;
  T.groundY = (x, z) => {
    const fx = (x - x0) / cell;
    const fz = (z - z0) / cell;
    if (!isFinite(fx) || !isFinite(fz)) return 0;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
    if (j < 0) j = 0; else if (j > nz - 2) j = nz - 2;
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const a = h[j * nx + i], b = h[j * nx + i + 1];
    const c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  return T;
}

// How finely a terrain cell is rebuilt where a depressed corridor cuts through it. The cut edge
// is only ever accurate to half a sub-cell diagonal, which is why the corridor's paved verge is
// TRENCH_VERGE wide: it covers whatever raggedness this leaves.
const CUT_SUB = 2.2;

/**
 * The terrain, with the depressed corridors taken out of it.
 *
 * A 25 m grid cannot represent a 14 m trench, and leaving the sheet intact would draw a lid over
 * every underpass in the city. Cells the cut touches — a few dozen of them, proportional to the
 * length of corridor and to nothing else — are rebuilt at CUT_SUB and the sub-cells inside the cut
 * are dropped. A sub-cell goes only when ALL FOUR of its corners are inside, so the terrain always
 * RECEDES from the trench rather than hanging over it; the verge covers the difference.
 *
 * Built a tile at a time by emitTerrainRange() below.
 */

/**
 * Per-vertex terrain normals, computed once and cached on T.
 *
 * Split out of the mesh emitter because the ground is now built a tile at a time: every tile
 * needs the same normal field, and a tile rebuilt after eviction must produce byte-identical
 * geometry to the one it replaces. Central differences over the whole grid do that; per-tile
 * differences would not, because a tile edge has no neighbour to difference against.
 */
function terrainNormals(T) {
  if (T.nrm) return T.nrm;
  const { nx, nz, cell, h } = T;
  const nrm = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const l = h[j * nx + Math.max(0, i - 1)];
      const r = h[j * nx + Math.min(nx - 1, i + 1)];
      const u = h[Math.max(0, j - 1) * nx + i];
      const d = h[Math.min(nz - 1, j + 1) * nx + i];
      const sx = (i === 0 || i === nx - 1) ? cell : cell * 2;
      const sz = (j === 0 || j === nz - 1) ? cell : cell * 2;
      let ax = -(r - l) / sx, ay = 1, az = -(d - u) / sz;
      const il = 1 / Math.sqrt(ax * ax + ay * ay + az * az);
      const o = (j * nx + i) * 3;
      nrm[o] = ax * il; nrm[o + 1] = ay * il; nrm[o + 2] = az * il;
    }
  }
  T.nrm = nrm;
  return nrm;
}

/**
 * The ground, for the cell range [i0, i1) x [j0, j1). Every cell belongs to exactly one tile, so
 * the whole grid is still emitted exactly once and adjacent tiles share their edge vertices to
 * the bit — the seam is not stitched, it simply cannot open.
 */
function emitTerrainRange(mb, T, grade, i0, i1, j0, j1) {
  const { nx, nz, cell, x0, z0, h } = T;
  const nrm = terrainNormals(T);
  // ISLANDS: the Toronto Islands are parkland from shore to shore, and only about half of that
  // is mapped as a park or grass polygon. The rest would draw as the mainland's bare-terrain
  // grey, which on an island reads as dirt. harbour.js marks the cells (T.isleLand); the ground
  // itself carries the park albedo there and every mapped polygon still draws over it.
  const isleLand = T.isleLand || null;
  let isleMat = -1;
  setMat(mb, M.terrain);
  const px = (i) => x0 + i * cell;
  const pz = (j) => z0 + j * cell;
  const ja = Math.max(0, j0), jb = Math.min(nz - 1, j1);
  const ia = Math.max(0, i0), ib = Math.min(nx - 1, i1);
  for (let j = ja; j < jb; j++) {
    for (let i = ia; i < ib; i++) {
      if (isleLand) {
        const want = isleLand[j * nx + i] ? 1 : 0;
        if (want !== isleMat) { isleMat = want; setMat(mb, want ? M.park : M.terrain); }
      }
      const i00 = (j * nx + i) * 3, i10 = (j * nx + i + 1) * 3;
      const i01 = ((j + 1) * nx + i) * 3, i11 = ((j + 1) * nx + i + 1) * 3;
      const x = px(i), x1 = px(i + 1), z = pz(j), z1 = pz(j + 1);
      const y00 = h[j * nx + i], y10 = h[j * nx + i + 1];
      const y01 = h[(j + 1) * nx + i], y11 = h[(j + 1) * nx + i + 1];
      if (grade && grade.boxHot(x, z, x1, z1)) {
        emitCutCell(mb, grade, x, z, x1, z1, y00, y10, y01, y11, nrm, i00, i10, i01, i11);
        continue;
      }
      // CCW seen from above: (i,j+1) -> (i+1,j+1) -> (i+1,j) -> (i,j)
      mb.vert(x, y01, z1, nrm[i01], nrm[i01 + 1], nrm[i01 + 2]);
      mb.vert(x1, y11, z1, nrm[i11], nrm[i11 + 1], nrm[i11 + 2]);
      mb.vert(x1, y10, z, nrm[i10], nrm[i10 + 1], nrm[i10 + 2]);
      mb.vert(x, y01, z1, nrm[i01], nrm[i01 + 1], nrm[i01 + 2]);
      mb.vert(x1, y10, z, nrm[i10], nrm[i10 + 1], nrm[i10 + 2]);
      mb.vert(x, y00, z, nrm[i00], nrm[i00 + 1], nrm[i00 + 2]);
    }
  }
}

// One terrain cell, minus whatever the cut covers.
//
// Refined ADAPTIVELY: a square whose corners, edge midpoints and centre are all clear of the cut is
// emitted whole, however big it is, and only the squares the cut edge actually runs through are
// split down to CUT_SUB. A corridor crossing a 25 m cell would otherwise rebuild the entire cell at
// CUT_SUB — a couple of hundred triangles to describe two straight edges.
//
// Heights and normals come from the cell's own bilinear interpolation, so a refined cell is
// geometrically identical to the coarse one everywhere the cut does not reach, and the seam to its
// unrefined neighbours is exact.
function emitCutCell(mb, grade, x0, z0, x1, z1, y00, y10, y01, y11, nrm, i00, i10, i01, i11) {
  const yAt = (u, v) => (y00 * (1 - u) + y10 * u) * (1 - v) + (y01 * (1 - u) + y11 * u) * v;
  const nAt = (u, v, c) => (nrm[i00 + c] * (1 - u) + nrm[i10 + c] * u) * (1 - v) +
    (nrm[i01 + c] * (1 - u) + nrm[i11 + c] * u) * v;
  const put = (u, v) => {
    const px = x0 + (x1 - x0) * u, pz = z0 + (z1 - z0) * v;
    let ax = nAt(u, v, 0), ay = nAt(u, v, 1), az = nAt(u, v, 2);
    const l = Math.sqrt(ax * ax + ay * ay + az * az);
    if (l > EPS) { ax /= l; ay /= l; az /= l; } else { ax = 0; ay = 1; az = 0; }
    mb.vert(px, yAt(u, v), pz, ax, ay, az);
  };
  const cutUV = (u, v) => grade.cut(x0 + (x1 - x0) * u, z0 + (z1 - z0) * v);
  const span = Math.max(x1 - x0, z1 - z0);
  const quad = (u0, v0, u1, v1) => {
    // CCW seen from above.
    put(u0, v1); put(u1, v1); put(u1, v0);
    put(u0, v1); put(u1, v0); put(u0, v0);
  };
  const refine = (u0, v0, u1, v1, depth) => {
    const um = (u0 + u1) * 0.5, vm = (v0 + v1) * 0.5;
    // Nine probes: the corners the quad is built from, the edge midpoints and the centre. A cut is
    // metres wide, so at this size nothing can slip between them unseen.
    const corners = (cutUV(u0, v0) ? 1 : 0) + (cutUV(u1, v0) ? 1 : 0) +
      (cutUV(u0, v1) ? 1 : 0) + (cutUV(u1, v1) ? 1 : 0);
    const inner = (cutUV(um, v0) ? 1 : 0) + (cutUV(um, v1) ? 1 : 0) +
      (cutUV(u0, vm) ? 1 : 0) + (cutUV(u1, vm) ? 1 : 0) + (cutUV(um, vm) ? 1 : 0);
    if (corners === 0 && inner === 0) { quad(u0, v0, u1, v1); return; }
    if (corners === 4 && inner === 5) return;            // wholly inside the cut
    // ANY corner inside removes the quad, so the terrain always RECEDES from the trench rather
    // than hanging a ledge over it. The corridor's verge is TRENCH_VERGE wide precisely so that it
    // covers the sliver of ground this gives away.
    if (span * (u1 - u0) <= CUT_SUB || depth >= 6) return;
    refine(u0, v0, um, vm, depth + 1);
    refine(um, v0, u1, vm, depth + 1);
    refine(u0, vm, um, v1, depth + 1);
    refine(um, vm, u1, v1, depth + 1);
  };
  refine(0, 0, 1, 1, 0);
}

/**
 * The lake, out to the edge of the world.
 *
 * Two lattices at the same Y, so their shared edges are exactly coplanar and a T-junction between
 * them cannot open a crack: a fine one over the mapped city and the fringe, and a coarse one that
 * carries the water out to the apron's reach. Everything is decided by the SAME land/water test
 * the ground uses — the terrain, which harbour.js has already carved to the surveyed shoreline
 * and padTerrain has replicated outward — so past the extract the lake continues exactly where
 * the last surveyed metre of it said it should and stops exactly where the last metre of shore
 * did. Before this the far field was flooded unconditionally and the world north of Bloor was a
 * sea (invisible only because there was no ground out there to hide it).
 */
function emitWaterMesh(mb, T, extent, harbour, reach) {
  setMat(mb, M.water);
  const hx = extent.x / 2, hz = extent.z / 2;
  const pad = isNum(T.pad) ? T.pad : 0;
  const far = isNum(reach) && reach > 0 ? reach : 4800;
  const fine = 220;
  const wet = (xa, za, xb, zb) => {
    if (harbour && harbourTileHasWater(harbour, xa, za, xb, zb)) return true;
    const c = Math.min(
      Math.min(T.groundY(xa, za), T.groundY(xb, za)),
      Math.min(T.groundY(xa, zb), T.groundY(xb, zb))
    );
    return c <= WATER_Y - 0.02;
  };
  const sheet = (x0, z0, x1, z1, step, skipX0, skipZ0, skipX1, skipZ1) => {
    for (let z = z0; z < z1 - EPS; z += step) {
      for (let x = x0; x < x1 - EPS; x += step) {
        const xa = x, xb = Math.min(x + step, x1);
        const za = z, zb = Math.min(z + step, z1);
        if (xa >= skipX0 && xb <= skipX1 && za >= skipZ0 && zb <= skipZ1) continue;
        if (!wet(xa, za, xb, zb)) continue;
        mb.vert(xa, WATER_Y, zb, 0, 1, 0);
        mb.vert(xb, WATER_Y, zb, 0, 1, 0);
        mb.vert(xb, WATER_Y, za, 0, 1, 0);
        mb.vert(xa, WATER_Y, zb, 0, 1, 0);
        mb.vert(xb, WATER_Y, za, 0, 1, 0);
        mb.vert(xa, WATER_Y, za, 0, 1, 0);
      }
    }
  };
  // The fine sheet covers the city, the fringe and a kilometre of slack either side of them, so
  // every slip, basin and island channel is resolved at 220 m.
  const coarse = fine * 5;
  const fx0 = -hx - pad - 1000, fz0 = -hz - pad - 1000;
  // Snapped UP to a whole number of coarse cells, so the coarse lattice's cell edges land exactly
  // on the fine sheet's boundary: every coarse cell is then either wholly inside it (and skipped)
  // or wholly outside it (and kept). A straddling cell would lay a second water plane over the
  // first at the same Y, which is the one overlap the depth buffer cannot arbitrate at all.
  const fx1 = fx0 + Math.ceil((2 * (hx + pad + 1000)) / coarse) * coarse;
  const fz1 = fz0 + Math.ceil((2 * (hz + pad + 1000)) / coarse) * coarse;
  sheet(fx0, fz0, fx1, fz1, fine, Infinity, Infinity, -Infinity, -Infinity);
  // ...and the coarse one carries it to the horizon.
  const cx0 = fx0 - Math.ceil(far / coarse) * coarse;
  const cz0 = fz0 - Math.ceil(far / coarse) * coarse;
  const cx1 = fx1 + Math.ceil(far / coarse) * coarse;
  const cz1 = fz1 + Math.ceil(far / coarse) * coarse;
  sheet(cx0, cz0, cx1, cz1, coarse, fx0, fz0, fx1, fz1);
  for (let p = 0; p < T.ponds.length; p++) {
    const pond = T.ponds[p];
    const part = makePart(planArea(pond.co) > 0 ? pond.co : reverseRing(pond.co), []);
    emitCap(mb, part, pond.level, null);
  }
}

export { makeTerrain, padTerrain, CUT_SUB, terrainNormals, emitTerrainRange, emitWaterMesh };
