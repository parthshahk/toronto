// src/world/islandterrain.js — carving the island edge and sampling the ground on it.
//
// CONTRACT.md §8.3, Amendment 9.2. Land may not simply become water: every metre of the 35.5 km of
// surveyed island shoreline is classified beach, riprap or seawall in ./islands.js and given a
// real cross-section here — a back, a face, a toe and a drop — cut into the terrain grid the same
// way the mainland quay is. islandGroundY() is then what everything standing on an island reads,
// including the mantle that covers the grid's own interpolation between a land vertex and a water
// one.
//
// Tunables, materials and the shared helpers are in ./waterkit.js; the island model itself is in
// ./islands.js.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { EPS, sampleTerrain } from './waterkit.js';
import {
  AIR_BLEND, AIR_RUN_HW, AIR_SHOULDER, BANK_MAX, BANK_MIN, BANK_SAMPLE, ISLE_BACK_MAX,
  ISLE_GRID, ISLE_TOE_MAX, MANTLE_SINK, SWASH, smoothLoop,
} from './islandkit.js';
import { waterAt } from './shoreline.js';
import { airInset } from './airfield.js';

/**
 * Bring the terrain to the islands: flatten the airfield onto its plane, then read the bank level
 * and the inland edge of the shore mantle off the surveyed ground. Mutates T.h. Called from
 * carveHarbourTerrain() between the lake-bed carve and the deck index, so the mantle levels see
 * the finished grid.
 */
export function carveIslands(T, H, isle) {
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
export function islandGroundY(isle, x, z) {
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
