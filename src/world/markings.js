// src/world/markings.js — the paint: lane lines, crossings, stop bars, arrows and bike lanes.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged.
//
// Paint is a physical constant like every other surface (CONTRACT §7.1): a bright matte albedo,
// never an emitter. What makes it hard is not the colour, it is the HEIGHT. A marking has to sit
// MARK_LIFT clear of every carriageway beneath it — its own crowned ribbon and any street it
// crosses — or it z-fights the asphalt from exactly one viewing angle, which is the kind of bug
// that never shows up in a screenshot. paintY() answers that question and auditPaint() counts
// every time the answer was not clean.
//
// Winding matters for the same reason: emitStripe() uses the same corner order and the same fold
// test as emitRibbon(), because a stripe crossing a corner can turn inside out exactly as a ribbon
// can, and a marking that vanishes from one direction is the worst kind of bug.

import { clamp } from '../core/math.js';
import { hashPos } from '../core/util.js';
import { planWind2 } from '../geom/ring.js';
import { M, setMat } from '../city/materials.js';
import { EPS, ROAD_Y, CROWN, MARK_LIFT, triUp } from './ground.js';
import { carriagewayTopY } from './context.js';
import { recSample, recBase, surfaceY, nearJunction } from './roads.js';
import { ribbonAudit } from './audit.js';

const LANE_W = 3.35;               // Toronto lane width, used to space lane lines
const DASH_ON = 3.0;
const DASH_OFF = 6.0;
const STOP_BAR_W = 0.50;
const ZEBRA_BAR = 0.60;
const ZEBRA_GAP = 1.25;
const XWALK_DEPTH = 3.1;           // along the roadway, i.e. how deep the crossing is
const XWALK_SETBACK = 1.1;         // from the junction disc to the near edge of the crossing
/* =============================================== markings and crossings == */

/**
 * The height a marking must be laid at to sit MARK_LIFT clear of EVERY carriageway beneath it —
 * its own ribbon, crown included, and any street it crosses. Bridge paint ignores the ground:
 * a deck is not laid on the road running under it.
 */
function paintY(C, rec, m, o) {
  const own = surfaceY(C, rec, m, o);
  if (rec.deck) return own + MARK_LIFT;
  const other = carriagewayTopY(C, m.x + m.sx * o, m.z + m.sz * o);
  return (other > own ? other : own) + MARK_LIFT;
}

/**
 * One painted stripe between arc lengths s0..s1 at lateral offsets o0..o1. The strip breaks at
 * every polyline vertex so it follows curves and terrain, and every corner takes the road's own
 * surface height plus MARK_LIFT — paint on a crowned street or a bridge deck cannot sink.
 * @returns {number} quads emitted
 */
function emitStripe(C, rec, s0, s1, o0, o1) {
  const a = clamp(Math.min(s0, s1), 0, rec.len);
  const b = clamp(Math.max(s0, s1), 0, rec.len);
  if (b - a < 0.04) return 0;
  const lo = Math.min(o0, o1), hi = Math.max(o0, o1);
  if (hi - lo < 0.02) return 0;
  const mb = C.mb.roads;
  const arr = rec.s;
  const st = C.stations;
  st.length = 0;
  st.push(a);
  for (let k = 0; k < arr.length; k++) {
    if (arr[k] > a + 0.02 && arr[k] < b - 0.02) st.push(arr[k]);
  }
  st.push(b);

  let px0 = 0, py0 = 0, pz0 = 0, px1 = 0, py1 = 0, pz1 = 0;
  let have = false, quads = 0;
  for (let k = 0; k < st.length; k++) {
    const m = recSample(rec, st[k]);
    const ax = m.x + m.sx * lo, az = m.z + m.sz * lo;
    const bx = m.x + m.sx * hi, bz = m.z + m.sz * hi;
    const ay = paintY(C, rec, m, lo);
    const by = paintY(C, rec, m, hi);
    if (have) {
      // The same corner order emitRibbon() uses (previous@lo, previous@hi, current@hi), which is
      // the winding that comes out +Y given the frames' side vector is right-of-travel — and the
      // same fold test, because a stripe crossing a corner can turn inside out exactly as a
      // ribbon can, and a marking that vanishes from one direction is the worst kind of bug.
      const w1 = planWind2(px0, pz0, px1, pz1, bx, bz);
      const w2 = planWind2(px0, pz0, bx, bz, ax, az);
      const AU = ribbonAudit();
      if (AU && (w1 < 0 || w2 < 0)) AU.ribbonFolds += (w1 < 0 ? 1 : 0) + (w2 < 0 ? 1 : 0);
      if (w1 > 0) mb.tri(px0, py0, pz0, px1, py1, pz1, bx, by, bz);
      if (w2 > 0) mb.tri(px0, py0, pz0, bx, by, bz, ax, ay, az);
      if (w1 > 0 || w2 > 0) quads++;
      if (!rec.deck) auditPaint(C, rec, m, lo, ay);
    }
    px0 = ax; py0 = ay; pz0 = az;
    px1 = bx; py1 = by; pz1 = bz;
    have = true;
  }
  return quads;
}

/**
 * Independent audit of a painted corner: how far it stands above the ROAD SURFACE under it. The
 * own-road reference is rebuilt here by walking the cross-section emitRibbon() was actually handed
 * and lerping between the two corners that bracket the offset, rather than by calling surfaceY() —
 * so a sign error or a dropped crown term in surfaceY() is caught rather than confirmed. Where a
 * second street crosses, the reference is whichever surface is higher. Every marking must come out
 * at exactly MARK_LIFT, give or take float noise.
 */
function auditPaint(C, rec, m, o, y) {
  const hs = rec.hw * m.sc;
  let lo = -hs, hi = hs, dyLo = 0, dyHi = 0;
  if (rec.crowned) {
    if (o < 0) { lo = -hs; hi = 0; dyHi = CROWN; } else { lo = 0; hi = hs; dyLo = CROWN; }
  }
  // The record's OWN base, which for a depressed carriageway is its corridor profile rather than
  // the ground plane over the lid that carries a street across it.
  const yLo = recBase(C, rec, m.x + m.sx * lo, m.z + m.sz * lo) + ROAD_Y + dyLo;
  const yHi = recBase(C, rec, m.x + m.sx * hi, m.z + m.sz * hi) + ROAD_Y + dyHi;
  const t = hi - lo > EPS ? clamp((o - lo) / (hi - lo), 0, 1) : 0;
  const own = yLo + (yHi - yLo) * t;
  const cross = carriagewayTopY(C, m.x + m.sx * o, m.z + m.sz * o);
  const lift = y - (cross > own ? cross : own);
  const st = C.stats;
  if (lift < st.markLiftMin) st.markLiftMin = lift;
  if (lift > st.markLiftMax) st.markLiftMax = lift;
  if (lift <= 0.002) st.markingsBelowRoad++;
  // Separately: is this corner under the street it crosses, whatever its own ribbon is doing?
  if (y <= cross) st.markingsUnderCross++;
}

// A continuous line, broken only where it would run through a junction.
function emitSolidLine(C, rec, o0, o1, pad) {
  const arr = rec.s;
  let n = 0, run = -1;
  for (let k = 0; k + 1 < arr.length; k++) {
    const ok = (arr[k + 1] - arr[k] > 0.05) &&
      !nearJunction(rec, (arr[k] + arr[k + 1]) * 0.5, pad);
    if (ok) { if (run < 0) run = arr[k]; }
    else if (run >= 0) { n += emitStripe(C, rec, run, arr[k], o0, o1); run = -1; }
  }
  if (run >= 0) n += emitStripe(C, rec, run, arr[arr.length - 1], o0, o1);
  return n;
}

function emitDashedLine(C, rec, o, halfW, pad) {
  let n = 0;
  for (let s = 2.0; s + DASH_ON < rec.len; s += DASH_ON + DASH_OFF) {
    if (nearJunction(rec, s + DASH_ON * 0.5, pad)) continue;
    n += emitStripe(C, rec, s, s + DASH_ON, o - halfW, o + halfW);
  }
  return n;
}

// Turn arrows as triangle lists in (along the road, right of the driver) metres. The caller maps
// them into each approach frame, so one table serves every approach of every junction.
const ARROW_THRU = [
  -1.70, -0.17, -1.70, 0.17, 0.30, 0.17,
  -1.70, -0.17, 0.30, 0.17, 0.30, -0.17,
  0.30, -0.62, 0.30, 0.62, 1.58, 0.00,
];
const ARROW_TURN = [
  -1.70, -0.17, -1.70, 0.17, 0.66, 0.17,
  -1.70, -0.17, 0.66, 0.17, 0.66, -0.17,
  0.24, -1.00, 0.24, -0.17, 0.66, -0.17,
  0.24, -1.00, 0.66, -0.17, 0.66, -1.00,
  -0.12, -1.00, 1.02, -1.00, 0.45, -1.92,
];

const _apx = new Float64Array(3), _apy = new Float64Array(3), _apz = new Float64Array(3);

// `k` is +1 when the approach runs toward increasing arc length, -1 otherwise; `mirror` turns a
// left arrow into a right one.
function emitArrow(C, rec, sC, oC, k, mirror, table) {
  const mb = C.mb.roads;
  for (let t = 0; t < table.length; t += 6) {
    for (let v = 0; v < 3; v++) {
      const ds = table[t + v * 2], dv = table[t + v * 2 + 1] * mirror;
      const m = recSample(rec, sC + k * ds);
      const o = oC + k * dv;
      _apx[v] = m.x + m.sx * o;
      _apz[v] = m.z + m.sz * o;
      _apy[v] = paintY(C, rec, m, o);
    }
    triUp(mb, _apx[0], _apy[0], _apz[0], _apx[1], _apy[1], _apz[1], _apx[2], _apy[2], _apz[2]);
  }
}

/**
 * Everything painted on one carriageway: centre line, lane lines, motorway edge lines, a bike
 * lane where Toronto really has one, and at every junction the road touches a crossing, a stop
 * bar and lane arrows on each approach.
 */
function emitRoadMarkings(C, rec) {
  if (rec.foot || rec.cls === 'service' || rec.cls === 'pedestrian') return;
  const mb = C.mb.roads;
  const G = C.stats.ground;
  const hw = rec.hw;
  if (hw < 2.6 || rec.len < 8) return;

  // --- centre line -------------------------------------------------------------------------
  if (rec.cls !== 'motorway' && hw >= 4.2) {
    setMat(mb, M.paintYellow);
    if (rec.w >= 12.5) {
      G.markings += emitSolidLine(C, rec, -0.21, -0.11, 1.0);
      G.markings += emitSolidLine(C, rec, 0.11, 0.21, 1.0);
    } else {
      G.markings += emitDashedLine(C, rec, 0, 0.06, 1.0);
    }
  }

  // --- lane lines and edge lines -------------------------------------------------------------
  const lanes = clamp(Math.round((hw - 0.55) / LANE_W), 1, 4);
  setMat(mb, M.paintWhite);
  for (let i = 1; i < lanes; i++) {
    const o = i * LANE_W;
    if (o > hw - 1.0) break;
    G.markings += emitDashedLine(C, rec, o, 0.06, 1.6);
    G.markings += emitDashedLine(C, rec, -o, 0.06, 1.6);
  }
  if (rec.cls === 'motorway') {
    G.markings += emitSolidLine(C, rec, hw - 0.44, hw - 0.32, 0.5);
    G.markings += emitSolidLine(C, rec, -(hw - 0.32), -(hw - 0.44), 0.5);
  }

  // --- bike lane ------------------------------------------------------------------------------
  // Toronto paints the lane green through the conflict zones only and marks it with a solid white
  // line elsewhere; modelling it that way is both cheaper and what is actually on the ground.
  if (rec.bike && hw >= 5.0) {
    const inner = hw - 2.05;
    setMat(mb, M.paintWhite);
    G.markings += emitSolidLine(C, rec, inner - 0.06, inner + 0.06, 0.5);
    setMat(mb, M.bikeGreen);
    for (let k = 0; k < rec.junc.length; k++) {
      const j = rec.junc[k];
      const a = Math.max(0, j.s - j.r - 5.0), b = Math.min(rec.len, j.s + j.r + 5.0);
      G.markings += emitStripe(C, rec, a, b, inner + 0.10, hw - 0.30);
      G.bikeLaneMetres += Math.max(0, b - a);
    }
  }

  // --- junction paint: crossings, stop bars, lane arrows ---------------------------------------
  for (let k = 0; k < rec.junc.length; k++) {
    const j = rec.junc[k];
    if (!j.J.cross) continue;
    for (let d = 0; d < 2; d++) {
      const sigma = d === 0 ? 1 : -1;      // this branch heads toward increasing/decreasing s
      const app = -sigma;                  // ...so traffic approaching the junction travels -sigma
      const nose = j.s + sigma * (j.r + XWALK_SETBACK);
      const far = j.s + sigma * (j.r + XWALK_SETBACK + XWALK_DEPTH);
      if (nose < 0.8 || nose > rec.len - 0.8 || far < 0 || far > rec.len) continue;

      // Crossing: bars run WITH the traffic and are spaced across the roadway.
      setMat(mb, M.paintWhite);
      const ladder = hashPos(j.J.x, j.J.z, 5) < 0.45;
      let u = -hw + 0.35;
      while (u + ZEBRA_BAR < hw - 0.35) {
        G.markings += emitStripe(C, rec, nose, far, u, u + ZEBRA_BAR);
        u += ZEBRA_BAR + ZEBRA_GAP;
      }
      if (ladder) {
        G.markings += emitStripe(C, rec, nose, nose + 0.16, -hw + 0.35, hw - 0.35);
        G.markings += emitStripe(C, rec, far - 0.16, far, -hw + 0.35, hw - 0.35);
      }
      G.crosswalks++;

      // Stop bar, across the approach half only.
      const bar = far + sigma * 0.85;
      if (bar > 0.3 && bar < rec.len - 0.3) {
        G.markings += emitStripe(C, rec, bar, bar + sigma * STOP_BAR_W,
          app * 0.12, app * (hw - 0.32));
        G.stopBars++;
      }

      // Lane arrows, in the lanes nearest the centre line of the approach.
      const aS = bar + sigma * 7.5;
      if (aS > 2.5 && aS < rec.len - 2.5 && hw >= 5.2) {
        const roll = hashPos(j.J.x + sigma, j.J.z, 9);
        emitArrow(C, rec, aS, app * (LANE_W * 0.5), app, 1,
          roll < 0.42 ? ARROW_TURN : ARROW_THRU);
        G.arrows++;
        if (lanes >= 2 && roll >= 0.42) {
          emitArrow(C, rec, aS, app * (LANE_W * 1.5), app, -1, ARROW_TURN);
          G.arrows++;
        }
      }
    }
  }
}

export { paintY, emitStripe, emitSolidLine, emitDashedLine, emitRoadMarkings, ZEBRA_BAR, ZEBRA_GAP };
