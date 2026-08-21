// src/geom/extrude.js — footprints to solids: tapered prisms, flat caps and draped caps.
//
// The two cap emitters take a PART from geom/ring.js, triangulate it and lay the triangles at a
// height: emitCap() at one flat height, emitDrapedCap() with every vertex on the terrain, adaptively
// subdivided until the flat plane it lays is within CAP_TOL of the ground underneath it.
//
// Plan CCW in, +Y normal out (x = u, z = -v), which is what the renderer's back-face culling wants.
//
// Pure geometry. `groundY`, `stats` and `grade` are services the caller passes in and this module
// only calls — it knows nothing about terrain, tiles or grade separation beyond their shapes.
// `_capStack` is module scope so the subdivision does not allocate per triangle; it is emptied at
// the top of each triangle and carries nothing between calls.

import { triangulate, CAP_MIN_AREA } from './triangulate.js';

// Tapered prism between two plan rings with the same vertex count (used by the CN Tower lathe).
export function emitPrism(mb, base, top, y0, y1, cap) {
  const n = base.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = base[j], az = -base[j + 1];
    const bx = base[i], bz = -base[i + 1];
    const cx = top[i], cz = -top[i + 1];
    const dx = top[j], dz = -top[j + 1];
    mb.tri(ax, y0, az, bx, y0, bz, cx, y1, cz);
    mb.tri(ax, y0, az, cx, y1, cz, dx, y1, dz);
  }
  if (cap) {
    for (let i = 4; i < n; i += 2) {
      mb.tri(top[0], y1, -top[1], top[i - 2], y1, -top[i - 1], top[i], y1, -top[i + 1]);
    }
  }
}

export function ringPts(cu, cv, r, seg, phase) {
  const out = new Array(seg * 2);
  for (let i = 0; i < seg; i++) {
    const a = phase + (i / seg) * Math.PI * 2;
    out[i * 2] = cu + Math.cos(a) * r;
    out[i * 2 + 1] = cv + Math.sin(a) * r;
  }
  return out;
}

function capArea2(co, a, b, c) {
  return (co[b] - co[a]) * (co[c + 1] - co[a + 1]) - (co[c] - co[a]) * (co[b + 1] - co[a + 1]);
}

// Flat cap over a prepared part at height y (plan CCW -> +Y normal).
export function emitCap(mb, part, y, stats) {
  const tris = triangulate(part.co, part.holeStarts);
  if (!tris.length) { if (stats) stats.capFail++; return 0; }
  const co = part.co;
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
    if (Math.abs(capArea2(co, a, b, c)) < CAP_MIN_AREA) { if (stats) stats.capDegenerate++; continue; }
    mb.tri(co[a], y, -co[a + 1], co[b], y, -co[b + 1], co[c], y, -co[c + 1]);
    n++;
  }
  return n;
}

/**
 * Draped cap: same, but every vertex takes its own terrain height.
 *
 * Ear clipping hands back whatever shape the ring wants, and a park boundary happily produces a
 * 150 m sliver. Sampling the terrain only at its three corners then interpolates a straight plane
 * across ground that curves under it — measured at over a metre on the worst park in the extract,
 * and enough on ordinary ones to punch the terrain mesh through the grass and to swap the order of
 * two ground covers that were laid four centimetres apart. So keep splitting the longest edge
 * until the flat plane is within CAP_TOL of the ground it is supposed to be lying on — which
 * costs nothing where the ground is level and pays where it is not.
 */
const CAP_MAX_EDGE = 6.0;          // no point testing a split shorter than this
const CAP_TOL = 0.012;             // metres the flat plane may cut across the real ground
const CAP_MAX_SPLIT = 7;           // depth guard, so one pathological ring cannot run away
const _capStack = [];

export function emitDrapedCap(mb, part, groundY, dy, stats, grade) {
  const tris = triangulate(part.co, part.holeStarts);
  if (!tris.length) { if (stats) stats.capFail++; return 0; }
  const co = part.co;
  const S = _capStack;
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
    if (Math.abs(capArea2(co, a, b, c)) < CAP_MIN_AREA) { if (stats) stats.capDegenerate++; continue; }
    const ax = co[a], az = -co[a + 1], bx = co[b], bz = -co[b + 1], cx = co[c], cz = -co[c + 1];
    S.length = 0;
    S.push(ax, groundY(ax, az) + dy, az, bx, groundY(bx, bz) + dy, bz,
      cx, groundY(cx, cz) + dy, cz, 0);
    while (S.length) {
      const d = S.pop();
      const zc = S.pop(), yc = S.pop(), xc = S.pop();
      const zb = S.pop(), yb = S.pop(), xb = S.pop();
      const za = S.pop(), ya = S.pop(), xa = S.pop();
      let split = 0;                                   // 0 none, 1 edge ab, 2 edge bc, 3 edge ca
      if (d < CAP_MAX_SPLIT) {
        const e0 = (xb - xa) * (xb - xa) + (zb - za) * (zb - za);
        const e1 = (xc - xb) * (xc - xb) + (zc - zb) * (zc - zb);
        const e2 = (xa - xc) * (xa - xc) + (za - zc) * (za - zc);
        const lim = CAP_MAX_EDGE * CAP_MAX_EDGE;
        if (e0 >= e1 && e0 >= e2) { if (e0 > lim) split = 1; }
        else if (e1 >= e2) { if (e1 > lim) split = 2; }
        else if (e2 > lim) split = 3;
      }
      if (split) {
        // Only actually split where the flat plane misses the ground: a park laid over level
        // terrain stays one big triangle, a park on a slope gets as many as it needs.
        const px = split === 1 ? (xa + xb) * 0.5 : (split === 2 ? (xb + xc) * 0.5 : (xc + xa) * 0.5);
        const pz = split === 1 ? (za + zb) * 0.5 : (split === 2 ? (zb + zc) * 0.5 : (zc + za) * 0.5);
        const flat = split === 1 ? (ya + yb) * 0.5 : (split === 2 ? (yb + yc) * 0.5 : (yc + ya) * 0.5);
        const real = groundY(px, pz) + dy;
        if (Math.abs(real - flat) <= CAP_TOL) split = 0;
        else if (split === 1) {
          S.push(xa, ya, za, px, real, pz, xc, yc, zc, d + 1);
          S.push(px, real, pz, xb, yb, zb, xc, yc, zc, d + 1);
          continue;
        } else if (split === 2) {
          S.push(xa, ya, za, xb, yb, zb, px, real, pz, d + 1);
          S.push(xa, ya, za, px, real, pz, xc, yc, zc, d + 1);
          continue;
        } else {
          S.push(xa, ya, za, xb, yb, zb, px, real, pz, d + 1);
          S.push(px, real, pz, xb, yb, zb, xc, yc, zc, d + 1);
          continue;
        }
      }
      // Where a depressed corridor has taken the ground out from under this cover, the cover
      // goes with it — otherwise a car park roofs over the underpass it sits beside.
      if (grade && grade.cut((xa + xb + xc) / 3, (za + zb + zc) / 3)) {
        if (stats) stats.grade.areaTrisCut++;
        continue;
      }
      mb.tri(xa, ya, za, xb, yb, zb, xc, yc, zc);
      n++;
    }
  }
  return n;
}
