// src/world/airfield.js — BILLY BISHOP: the pavement, the markings, the lighting, the perimeter
// fence, the aircraft and the ground equipment on the west end of the island chain.
//
// CONTRACT.md §8.3. The surveyed aeroway layout — runways, taxiways, aprons, stopways, stands,
// holding positions and hangars — is a table in ./islandplan.js; this file builds from it.
// Tunables, materials and the shared helpers are in ./waterkit.js.
//
// Amendment 7: the only emitters here are the runway edge, threshold and end lights, the taxiway
// edge lights and the approach bars out over the Western Gap. Every one of them is a real light.
// Aircraft, hangars, fencing and painted markings carry emissive 0.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  appendAirfieldSign, appendAirliner, appendAirstairs, appendApproachMast, appendChainFence,
  appendGSECart, appendHangar, appendLightPlane, appendRunwayLight, appendWindsock,
} from '../props/index.js';
import {
  EPS, bboxOf, distToPoly, distToSeg, earClip, hash01, isClosed, planArea, polyLength, quadUp,
  rngAt, sampleTerrain, setMat, triUp,
} from './waterkit.js';
import {
  AERO_APRON, AERO_HANGAR, AERO_HOLD, AERO_RUNWAY, AERO_STAND, AERO_STOPWAY, AERO_TAXIWAY,
  MAG_DECL,
} from './islandplan.js';
import {
  AIR_APPROACH_BARS, AIR_APPROACH_STEP, AIR_BLEND, AIR_CELL, AIR_EDGE_LIGHT, AIR_FENCE_OUT,
  AIR_MARK, AIR_RUN_HW, AIR_SHOULDER, AIR_TAXI_HW, AIR_TAXI_LIGHT, IM, addWay, bearingOf,
  boxHit, makeRingIndex, makeSegIndex, pairs, ringAt,
} from './islandkit.js';
import { harbourWaterAt, waterAt } from './shoreline.js';

/**
 * Billy Bishop, from the baked aeroway survey. Everything the airfield needs to know about
 * itself: where the pavement is, how high it sits, which end of each runway carries which
 * designator, where the stands are, and where the perimeter fence runs.
 */
export function buildAirport(T, wY, field) {
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
export function airInset(A, x, z) {
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
 * Is (x, z) airside? Not "on the pavement" — inside the perimeter, which is the same contour the
 * fence is traced from. An aerodrome's infield is mown grass and nothing else: a tree between a
 * runway and its parallel taxiway is an obstacle, and a flower bed there is nonsense.
 */
export function onAirfield(isle, x, z) {
  return !!(isle && isle.air && airInset(isle.air, x, z) > -AIR_FENCE_OUT);
}

/** And the tight test: is (x, z) actually on the pavement? */
function onAirPavement(isle, x, z) {
  return !!(isle && isle.air && airInset(isle.air, x, z) > -AIR_SHOULDER * 0.5);
}


/* ---------------------------------------------------------------- geometry */

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
export function appendAirfield(isle, c, x0, z0, x1, z1) {
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

export function placeAirfieldDetail(isle, c, x0, z0, x1, z1) {
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

// Hangars the massing extract missed. Where it has a building, that IS the hangar and a second
// shell on top of it would be a duplicate; where it has nothing, the aeroway=hangar footprint
// gives the span, the depth and the door line.
export function placeHangars(isle, c, x0, z0, x1, z1) {
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
