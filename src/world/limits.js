// src/world/limits.js — where the player is stopped, and the proof they cannot see the end.
//
// CONTRACT.md §9.3, §9.4 and Amendment 11.1. Moved out of city.js unchanged. Two halves of one
// promise: "no viewpoint inside the playable area from which the world visibly ends."
//
//   makeLimits() / limitAxis()  the SOFT limit. A rectangle SOFT_OUT metres outside the data, with
//                               SOFT_EASE metres of deceleration before it, so the player slows to
//                               a stop rather than hitting a wall — and so the last thing they can
//                               reach is still city.
//   auditHorizon()              the PROOF. It re-derives render.js's fog at every time preset, at
//                               every altitude the camera can reach, and reports the airlight at
//                               the point where a sightline leaves the ground plane. It is a
//                               measurement, not an assertion, and it runs every load.

import { clamp, lerp, smoothstep, TAU } from '../core/math.js';
import { isNum } from '../core/util.js';
import { EPS } from './ground.js';
import { SOFT_EASE, SOFT_OUT_FRAC, SOFT_OUT_MAX } from './surround.js';

/* ============================================== the soft limit (§9.3) ===== */
//
// "Then stop the player with a soft, explained limit well inside the visual edge."
//
// The limit is a rectangle SOFT_OUT metres outside the data, so the last thing anyone can reach
// is still synthesised city with several hundred metres of it still ahead. Approaching it, the
// OUTWARD component of the camera's velocity is scaled down over SOFT_EASE metres and reaches
// zero exactly at the limit: the camera coasts to a stop instead of striking a plane, sideways
// motion is never touched, and turning round is instant because the gain applies only to motion
// that is trying to leave. `limitFrac` rises 0 -> 1 across the same band, which is what a HUD or
// a vignette should read to say WHY.
//
// The hard clamp is a backstop for a teleport, not the mechanism.

function makeLimits(extent, fringe) {
  const out = clamp(fringe * SOFT_OUT_FRAC, 120, SOFT_OUT_MAX);
  return {
    x: extent.x / 2 + out, z: extent.z / 2 + out,
    ease: Math.min(SOFT_EASE, out * 0.9),
    out,
  };
}

function limitAxis(u, lim, ease) {
  const m = Math.abs(u);
  const a = lim - ease;
  if (m <= a) return 1;
  return 1 - smoothstep(0, 1, clamp((m - a) / Math.max(ease, EPS), 0, 1));
}

/* ==================================================== horizon audit (§9.4) == */
//
// "No viewpoint inside the playable area from which the world visibly ends."
//
// Proved rather than asserted, and proved GEOMETRICALLY, because a screenshot only ever proves
// one frame. The drawn world is a rectangle: the apron. Along any horizontal bearing from any
// viewpoint there is therefore exactly one distance at which it stops and the sky begins, and
// that distance is computable in closed form. What has to be true is that render.js's air is
// already opaque there — at every one of the four time presets and at every altitude the camera
// can reach.
//
// The fog model below is a faithful JS copy of vhFogAmount() in render.js together with the four
// presets' parameters from main.js. It is duplicated ON PURPOSE and for audit only: the point of
// the test is to fail loudly if either of them changes in a way that reopens the horizon, which a
// shared implementation could not do. render.js is the authority for what is drawn; this is a
// second opinion about it.

// `sun` is the sun's contribution to airlight — render.js multiplies both the haze thinning and
// the aerial-perspective coefficient by it, and by nothing else. NOTE that this table is an
// AUDIT, not detail: it produces no vertex, sets no material and is read by nothing that emits.
// CONTRACT §7 forbids geometry from carrying a notion of time of day, and none here does; what
// this measures is whether the ATMOSPHERE closes the horizon at every hour, which is a question
// that cannot be asked without knowing what the hours are.
const HORIZON_PRESETS = [
  { name: 'Afternoon', sun: 1.00, density: 0.00026, height: 120, base: 4, max: 0.72 },
  { name: 'Golden hour', sun: 0.45, density: 0.00072, height: 85, base: 4, max: 0.86 },
  { name: 'Blue hour', sun: 0.00, density: 0.00110, height: 55, base: 4, max: 0.94 },
  { name: 'Night', sun: 0.00, density: 0.00135, height: 48, base: 4, max: 0.96 },
];
const HORIZON_DAY_FOG = 0.24;       // render.js DAY_FOG_DENSITY
const HORIZON_VISUAL = 40000;       // render.js env.fogVisualRange
const HORIZON_R0 = 3000;            // env.fogRange
const HORIZON_SPAN = 5200;          // env.fogRangeSpan
const HORIZON_CAP0 = 3000;          // env.fogHorizon
const HORIZON_CAP1 = 13000;         // env.fogHorizonEnd
const HORIZON_CEILING = 2400;       // main.js CEILING
const HORIZON_PASS = 0.97;          // airlight below which an edge could still be resolved

function horizonFog(p, camY, worldY, len) {
  const dens = p.density * (1 + (HORIZON_DAY_FOG - 1) * p.sun);
  const beta = (3.912 / HORIZON_VISUAL) * p.sun;
  const H = Math.max(p.height, 1);
  const ec = Math.pow(2, -1.442695 * clamp((camY - p.base) / H, -8, 40));
  const ew = Math.pow(2, -1.442695 * clamp((worldY - p.base) / H, -8, 40));
  const dy = worldY - camY;
  let f = Math.abs(dy) > 1e-3 ? dens * H * (ec - ew) * (len / dy) : dens * ec * len;
  const s = Math.max(len - HORIZON_R0, 0) / HORIZON_SPAN;
  f = clamp(f + beta * len + s * s, 0, 60);
  const cap = lerp(clamp(p.max, 0, 1), 1, smoothstep(HORIZON_CAP0, HORIZON_CAP1, len));
  return clamp(1 - Math.pow(2, -1.442695 * f), 0, 1) * cap;
}

/** Distance along a horizontal bearing from (px,pz) to the edge of the drawn rectangle. */
function exitDistance(px, pz, dx, dz, x0, z0, x1, z1) {
  let t = Infinity;
  if (Math.abs(dx) > EPS) {
    const a = ((dx > 0 ? x1 : x0) - px) / dx;
    if (a > 0 && a < t) t = a;
  }
  if (Math.abs(dz) > EPS) {
    const a = ((dz > 0 ? z1 : z0) - pz) / dz;
    if (a > 0 && a < t) t = a;
  }
  return isFinite(t) ? t : 0;
}

/**
 * Sample the perimeter of the soft limit at several altitudes and bearings and report the WORST
 * airlight the world's edge is seen through. `worst` must stay above HORIZON_PASS.
 */
function auditHorizon(T, limits, reach, groundY, stats) {
  const H = stats.horizon;
  const x0 = T.x0 - reach, z0 = T.z0 - reach;
  const x1 = T.x0 + (T.nx - 1) * T.cell + reach;
  const z1 = T.z0 + (T.nz - 1) * T.cell + reach;
  H.worldX = [x0, x1];
  H.worldZ = [z0, z1];
  const LX = limits.x, LZ = limits.z;
  const spots = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    // Project the direction onto the limit rectangle, so every sample really is ON the limit.
    const cx = Math.cos(a), cz = Math.sin(a);
    const k = Math.min(Math.abs(cx) > EPS ? LX / Math.abs(cx) : Infinity,
      Math.abs(cz) > EPS ? LZ / Math.abs(cz) : Infinity);
    spots.push([cx * k, cz * k]);
  }
  spots.push([0, 0]);
  const alts = [1.7, 120, 300, 1200, HORIZON_CEILING];
  let worst = 1, wx = 0, wz = 0, wAlt = 0, wPreset = '', wLen = 0;
  let rays = 0, fails = 0, minLen = Infinity;
  for (let s = 0; s < spots.length; s++) {
    const px = spots[s][0], pz = spots[s][1];
    const gy = groundY(px, pz);
    for (let b = 0; b < 24; b++) {
      const a = (b / 24) * TAU;
      const dx = Math.cos(a), dz = Math.sin(a);
      const horiz = exitDistance(px, pz, dx, dz, x0, z0, x1, z1);
      if (!(horiz > 0)) continue;
      const ex = px + dx * horiz, ez = pz + dz * horiz;
      const ey = groundY(ex, ez);
      if (horiz < minLen) minLen = horiz;
      for (let ai = 0; ai < alts.length; ai++) {
        const camY = Math.max(alts[ai], isNum(gy) ? gy + 1.7 : 1.7);
        const len = Math.hypot(horiz, camY - (isNum(ey) ? ey : 0));
        for (let p = 0; p < HORIZON_PRESETS.length; p++) {
          const f = horizonFog(HORIZON_PRESETS[p], camY, isNum(ey) ? ey : 0, len);
          rays++;
          if (f < HORIZON_PASS) fails++;
          if (f < worst) {
            worst = f; wx = Math.round(px); wz = Math.round(pz);
            wAlt = Math.round(camY); wPreset = HORIZON_PRESETS[p].name; wLen = Math.round(len);
          }
        }
      }
    }
  }
  H.rays = rays;
  H.fails = fails;
  H.worst = worst;
  H.worstAt = { x: wx, z: wz, alt: wAlt, preset: wPreset, len: wLen };
  H.minEdgeDistance = isFinite(minLen) ? minLen : 0;
  H.pass = HORIZON_PASS;
  return H;
}

export { makeLimits, limitAxis, auditHorizon };
