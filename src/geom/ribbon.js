// src/geom/ribbon.js — polyline to ribbon: resampling, spike pruning, mitred frames, the
// ribbon surface itself and the vertical skirt down its edge.
//
// A polyline here is [[x, z], ...] in WORLD coordinates, not plan space — these are roads, kerbs,
// tram slabs and quay walks, which are laid on the ground and want x/z directly. The winding test
// still goes through plan space (geom/ring.js planWind2), because "wound to face the sky" is a
// plan-space question.
//
// A FRAME is three floats per station: a unit side vector (+90 degrees from travel) and a mitre
// scale. polyFrames() builds them; every emitter here offsets by `offset * scale` along the side
// vector, so one frame array serves a carriageway, its kerbs and its sidewalk bands at once.
//
// Pure geometry: no city knowledge, no module-level mutable state. The one thing a ribbon wants to
// report — a quad that folded through itself at a corner — is written into an `audit` object the
// caller passes in, so nothing here has to know what stats are.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { planWind2 } from './ring.js';

const EPS = 1e-9;

export function polyResample(pts, maxSeg) {
  const out = [];
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
    if (prev && Math.abs(p[0] - prev[0]) < 1e-4 && Math.abs(p[1] - prev[1]) < 1e-4) continue;
    if (prev) {
      const dx = p[0] - prev[0], dz = p[1] - prev[1];
      const len = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.min(64, Math.floor(len / maxSeg));
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        out.push([prev[0] + dx * t, prev[1] + dz * t]);
      }
    }
    out.push([p[0], p[1]]);
    prev = p;
  }
  return out;
}

/**
 * Per-vertex mitred frames for a polyline: unit side vector plus a clamped miter scale.
 *
 * `reach` is the LARGEST lateral offset the caller will use with these frames — for a road that is
 * the outer edge of its sidewalk band, not the half carriageway — because every clamp below is
 * about how far the corner may throw that outermost edge.
 *
 * Three things bound the scale, and getting any of them wrong puts a tongue of pavement out across
 * the roadway:
 *   1. the true miter, 1 / cos(half the turn) — exact where the corner is gentle;
 *   2. an absolute reach clamp, so no corner adds more than MITER_OVER metres to the edge;
 *   3. a fold clamp: the corner displaces the edge ALONG the road by reach * scale * sin(half the
 *      turn), and once that exceeds the neighbouring segment the ribbon folds back through itself
 *      and emits an inside-out quad that vanishes under back-face culling.
 * Where the corner is too sharp, the join takes the tightest of the three and leaves a small notch
 * on the outside. A notch a few centimetres across is invisible; a nine-metre spike is not.
 *
 * The along-road displacement is `scale * sin`, NOT `tan(half the turn)`: those agree only while
 * the miter is unclamped. Once clamp (1) or (2) has pulled the corner point back along the
 * bisector, sin(half the turn) keeps growing while the tan-derived bound stops — so a hairpin on a
 * wide way slipped through the old test and folded anyway. Bounding `scale * sin` directly is
 * exact for both the clamped and the unclamped case. Where even a butt join (scale 1) would fold —
 * a hairpin whose neighbouring segment is shorter than the way is wide — no clamp can help, and
 * pruneSpikes() has already dropped that station before these frames are built.
 */
export const MITER_OVER = 1.5;            // metres a mitred corner may add to the outermost edge
const MITER_FOLD = 0.45;           // fraction of the shorter neighbouring segment one corner may
                                   // eat. Under a half, because the corner at the OTHER end of
                                   // that segment is eating into it from the far side too

/**
 * Remove the stations no mitre can serve at half-width `reach`.
 *
 * A corner displaces the ribbon edge ALONG the road by reach * scale * sin(half the turn). One
 * segment of length L carries the displacement of the corner at each of its ends, so the segment
 * folds — and emits an inside-out quad that vanishes under back-face culling — exactly when those
 * two add up to more than L. The miter scale is already clamped, and it can never go below 1
 * without folding the quad from the other side, so where the sum still exceeds L no frame can fix
 * it: the vertex itself has to go. In practice these are 20 cm zig-zags on a 26 m carriageway —
 * digitising noise a fraction of a lane wide, which is why dropping them costs nothing.
 *
 * The test is the exact one, run against the frames polyFrames() will actually produce, rather
 * than a conservative per-vertex bound: a conservative test throws away real 90-degree corners on
 * plaza outlines that mitre perfectly well.
 *
 * @returns {Array} the same array when nothing needed pruning, a pruned copy otherwise
 */
export function pruneSpikes(pts, reach) {
  const w = Math.max(0.25, isNum(reach) ? reach : 1);
  let cur = pts;
  for (let pass = 0; pass < 24; pass++) {
    const n = cur.length;
    if (n < 3) return cur;
    const fr = polyFrames(cur, w);
    // Along-road displacement each station imposes on both of its segments.
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ax = cur[i][0] - cur[i - 1][0], az = cur[i][1] - cur[i - 1][1];
      const bx = cur[i + 1][0] - cur[i][0], bz = cur[i + 1][1] - cur[i][1];
      const al = Math.hypot(ax, az), bl = Math.hypot(bx, bz);
      if (!(al > EPS) || !(bl > EPS)) { d[i] = Infinity; continue; }
      // sin(half the turn) from the half-angle identity, so no trig and no sign ambiguity.
      const dot = clamp((ax * bx + az * bz) / (al * bl), -1, 1);
      d[i] = w * fr[i * 3 + 2] * Math.sqrt(Math.max(0, (1 - dot) * 0.5));
    }
    let drop = null;
    for (let i = 1; i < n; i++) {
      const L = Math.hypot(cur[i][0] - cur[i - 1][0], cur[i][1] - cur[i - 1][1]);
      if (d[i - 1] + d[i] <= L) continue;
      // Drop the sharper of the two ends; a polyline endpoint has no corner and cannot be dropped.
      let k = (d[i] >= d[i - 1] || i - 1 === 0) ? i : i - 1;
      if (k === n - 1) k = i - 1;
      if (k > 0 && k < n - 1) (drop || (drop = new Set())).add(k);
    }
    if (!drop) return cur;
    const out = [];
    // Never drop two neighbours in one pass while there is still room to converge gently: the
    // survivor's geometry is re-measured next pass. Once the gentle passes are spent, take
    // everything that is still flagged in one go rather than leaving a fold in the mesh.
    const gentle = pass < 12;
    let last = -2;
    for (let i = 0; i < n; i++) {
      if (drop.has(i) && (!gentle || i !== last + 1)) { last = i; continue; }
      out.push(cur[i]);
    }
    if (out.length === cur.length) return cur;
    cur = out;
  }
  return cur;
}

export function polyFrames(pts, reach, maxOver = MITER_OVER) {
  const n = pts.length;
  const w = Math.max(0.25, isNum(reach) ? reach : 1);
  const lim = clamp(1 + Math.max(0, maxOver) / w, 1, 6);
  const fr = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    let px = 0, pz = 0, nx = 0, nz = 0, pl = 0, nl = 0;
    if (i > 0) {
      px = pts[i][0] - pts[i - 1][0]; pz = pts[i][1] - pts[i - 1][1];
      pl = Math.hypot(px, pz);
      if (pl > EPS) { px /= pl; pz /= pl; } else { px = 0; pz = 0; pl = 0; }
    }
    if (i < n - 1) {
      nx = pts[i + 1][0] - pts[i][0]; nz = pts[i + 1][1] - pts[i][1];
      nl = Math.hypot(nx, nz);
      if (nl > EPS) { nx /= nl; nz /= nl; } else { nx = 0; nz = 0; nl = 0; }
    }
    if (i === 0) { px = nx; pz = nz; pl = nl; }
    if (i === n - 1) { nx = px; nz = pz; nl = pl; }
    let mx = px + nx, mz = pz + nz;
    let ml = Math.hypot(mx, mz);
    if (ml < 1e-5) { mx = nx; mz = nz; ml = Math.hypot(mx, mz); }   // 180 degree hairpin
    if (ml > EPS) { mx /= ml; mz /= ml; } else { mx = 1; mz = 0; }
    // dot = cos(half the turn angle), always in [0, 1] for the bisector of two unit vectors.
    const dot = clamp(mx * nx + mz * nz, 0, 1);
    const sin = Math.sqrt(Math.max(0, 1 - dot * dot));
    const near = Math.min(pl > 0 ? pl : nl, nl > 0 ? nl : pl);
    let scale = dot > 1e-4 ? 1 / dot : lim;
    if (scale > lim) scale = lim;
    // Along-road displacement of the outermost edge is w * scale * sin; cap it at MITER_FOLD of
    // the shorter neighbouring segment, which the corner at that segment's far end is eating into
    // from the other side.
    if (sin > 1e-6) {
      const fold = (MITER_FOLD * near) / (w * sin);
      if (scale > fold) scale = fold;
    }
    // Never below 1. Pulling the section IN at a corner puts the edge point on the far side of the
    // previous cross-section and folds the quad from the other direction, which is how the first
    // attempt at this clamp traded one fold for another. Stations no scale can serve are removed
    // by pruneSpikes() before the frames are built at all.
    if (!(scale >= 1)) scale = 1;
    fr[i * 3] = -mz;          // side vector, +90 degrees from travel
    fr[i * 3 + 1] = mx;
    fr[i * 3 + 2] = scale;
  }
  return fr;
}

/**
 * Emit a ribbon along a polyline. `cross` is an ascending list of {o, dy} lateral offsets; `yAt`
 * gives the surface height as (edgeX, edgeZ, centreX, centreZ, vertexIndex). Quads are wound CCW
 * seen from above. `down` flips the winding, for bridge undersides.
 *
 * Each quad is split along one of its two diagonals. A quad between consecutive stations is often
 * NOT convex — the section swings round a corner faster than the ribbon advances — and for a
 * non-convex quad exactly one diagonal lies inside it. Taking the wrong one hands back a triangle
 * wound against the sky, which back-face culling drops from above and shows from below. So the
 * first diagonal is tested, the other is tried when it fails, and only when NEITHER works is the
 * quad a genuine FOLD: the corner threw the edge back past the previous station and the quad
 * crossed itself. Then whatever winds correctly is kept, the rest is dropped rather than shipped,
 * and the fold is counted — into `audit.ribbonFolds` when the caller passed an audit object,
 * which is the only channel this module has back to the outside world.
 */
export function emitRibbon(mb, pts, frames, cross, yAt, down, audit) {
  const n = pts.length;
  if (n < 2 || cross.length < 2) return;
  const m = cross.length;
  const ax = new Float64Array(m), ay = new Float64Array(m), az = new Float64Array(m);
  const bx = new Float64Array(m), by = new Float64Array(m), bz = new Float64Array(m);
  let have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const px = pts[i][0], pz = pts[i][1];
    for (let k = 0; k < m; k++) {
      const o = cross[k].o * sc;
      const x = px + sx * o, z = pz + sz * o;
      bx[k] = x; bz[k] = z; by[k] = yAt(x, z, px, pz, i) + cross[k].dy;
    }
    if (have) {
      for (let k = 0; k + 1 < m; k++) {
        const j = k + 1;
        // Diagonal a[k] -> b[k+1].
        const w1 = planWind2(ax[k], az[k], ax[j], az[j], bx[j], bz[j]);
        const w2 = planWind2(ax[k], az[k], bx[j], bz[j], bx[k], bz[k]);
        if (w1 > 0 && w2 > 0) {
          if (down) {
            mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], ax[j], ay[j], az[j]);
            mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
          } else {
            mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[j], by[j], bz[j]);
            mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
          }
          continue;
        }
        // Diagonal a[k+1] -> b[k].
        const w3 = planWind2(ax[k], az[k], ax[j], az[j], bx[k], bz[k]);
        const w4 = planWind2(ax[j], az[j], bx[j], bz[j], bx[k], bz[k]);
        if (w3 > 0 && w4 > 0) {
          if (down) {
            mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], ax[j], ay[j], az[j]);
            mb.tri(ax[j], ay[j], az[j], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
          } else {
            mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[k], by[k], bz[k]);
            mb.tri(ax[j], ay[j], az[j], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
          }
          continue;
        }
        // A quad with no area at all is not a fold, it is two coincident stations; it is still
        // dropped, because a zero-area triangle has no normal to derive.
        if (audit) audit.ribbonFolds += (w1 < -EPS ? 1 : 0) + (w2 < -EPS ? 1 : 0);
        if (down) {
          if (w1 > 0) mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], ax[j], ay[j], az[j]);
          if (w2 > 0) mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
        } else {
          if (w1 > 0) mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[j], by[j], bz[j]);
          if (w2 > 0) mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
        }
      }
    }
    for (let k = 0; k < m; k++) { ax[k] = bx[k]; ay[k] = by[k]; az[k] = bz[k]; }
    have = true;
  }
}

/**
 * Vertical skirt along one lateral offset of a polyline, from `yTop(...)` down by `depth`.
 * `facing` = -1 makes the face look toward -side (the road), +1 toward +side.
 */
export function emitSkirt(mb, pts, frames, offset, yTop, depth, facing) {
  const n = pts.length;
  let px = 0, pz = 0, py = 0, have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const o = offset * sc;
    const x = pts[i][0] + sx * o, z = pts[i][1] + sz * o;
    const y = yTop(x, z, pts[i][0], pts[i][1], i);
    if (have) {
      if (facing < 0) {
        mb.tri(px, py - depth, pz, px, py, pz, x, y, z);
        mb.tri(px, py - depth, pz, x, y, z, x, y - depth, z);
      } else {
        mb.tri(px, py - depth, pz, x, y - depth, z, x, y, z);
        mb.tri(px, py - depth, pz, x, y, z, px, py, pz);
      }
    }
    px = x; pz = z; py = y; have = true;
  }
}
