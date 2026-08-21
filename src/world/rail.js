// src/world/rail.js — the streetcar: embedded track, overhead wire, poles and stops.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged. The extract's 209
// railway=tram ways are a defining Toronto feature — King, Queen, Spadina, Bathurst, Queens Quay
// and Dundas — and what makes them read is not the rail, it is the WIRE: a thin line of geometry
// overhead that is unmistakable at any distance.
//
//   emitTramRoute()   the slab under a reserved right of way, the two running rails set flush in
//                     whatever they cross, the catenary poles and the sagging contact wire.
//   placeTramStops()  a shelter at each surveyed stop, and a station record the people pass uses.
//   emitWireSpan()    one span of square-section contact wire between two world points.
//
// Toronto gauge is 4 ft 10 7/8 in — TRAM_GAUGE below, unique in the world, and worth getting
// right for the same reason every other measurement here is.

import { clamp } from '../core/math.js';
import { isNum, sgn } from '../core/util.js';
import { polyResample, pruneSpikes, polyFrames } from '../geom/ribbon.js';
import { appendCatenaryPole, appendTransitShelter, appendPlatformShelter } from '../props/index.js';
import { M, setMat } from '../city/materials.js';
import { EPS, ROAD_Y, ROAD_MAX_SEG, distToSeg2 } from './ground.js';
import {
  carriagewayCrown, inFootprint, kerbSeat, noteProp, onCarriageway, reserve, deckFits, PROP_H,
} from './context.js';
import { emitRibbon } from './audit.js';

const TRAM_GAUGE = 1.495;          // Toronto gauge — 4 ft 10 7/8 in, unique in the world
const TRAM_RAIL_W = 0.078;
const TRACK_SLAB_HW = 1.72;        // half width of the slab under a reserved right of way
const TRACK_SLAB_Y = 0.030;        // ...and how far it stands above the road datum, so a slab that
                                   // clips a carriageway edge is a step, not a coplanar fight
const RAIL_PROUD = 0.050;          // rail head above whatever it is set into. Above MARK_LIFT on
                                   // purpose: real embedded rail is proud of the paint it crosses
const TRAM_POLE_SPACING = 46.0;
const TRAM_POLE_H = 8.4;
const CATENARY_REACH = 1.86;       // documented appendCatenaryPole wire attachment, see its header
const CATENARY_DROP = 0.85;
const WIRE_R = 0.026;
const WIRE_SAG = 0.16;
/* ========================================================= streetcar track == */

// The four faces along a run of overhead contact wire, as a square-section member between two
// world points. 24 verts; back-face culling drops two of the four from any angle.
const _wc = new Float64Array(24);
const _wf = [5, 1, 3, 7, 0, 4, 6, 2, 6, 7, 3, 2, 0, 1, 5, 4];

function emitWireSpan(C, ax, ay, az, bx, by, bz) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0.05)) return;
  dx /= len; dy /= len; dz /= len;
  let rx = -dz, rz = dx;
  const rl = Math.hypot(rx, rz);
  if (rl > 1e-5) { rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
  const ux = dy * rz, uy = dz * rx - dx * rz, uz = -dy * rx;
  for (let i = 0; i < 8; i++) {
    const sr = (i & 1) ? WIRE_R : -WIRE_R;
    const su = (i & 2) ? WIRE_R : -WIRE_R;
    const ex = (i & 4) ? bx : ax, ey = (i & 4) ? by : ay, ez = (i & 4) ? bz : az;
    _wc[i * 3] = ex + rx * sr + ux * su;
    _wc[i * 3 + 1] = ey + uy * su;
    _wc[i * 3 + 2] = ez + rz * sr + uz * su;
  }
  const mb = C.mb.props;
  for (let f = 0; f < 4; f++) {
    const o = f * 4;
    const a = _wf[o] * 3, b = _wf[o + 1] * 3, c = _wf[o + 2] * 3, d = _wf[o + 3] * 3;
    mb.tri(_wc[a], _wc[a + 1], _wc[a + 2], _wc[b], _wc[b + 1], _wc[b + 2],
      _wc[c], _wc[c + 1], _wc[c + 2]);
    mb.tri(_wc[a], _wc[a + 1], _wc[a + 2], _wc[c], _wc[c + 1], _wc[c + 2],
      _wc[d], _wc[d + 1], _wc[d + 2]);
  }
  C.stats.ground.wireMetres += len;
}

function nearestTram(C, x, z) {
  let best = 36;
  C.tramIdx.query(x, z, 6, (s) => {
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 < best) best = d2;
  });
  return Math.sqrt(best);
}

/**
 * One tram way: rails at Toronto's 1.495 m gauge sitting flush in the asphalt where the track is
 * embedded in a street and on their own slab where it runs in a reserved right of way, catenary
 * poles down the route, and the contact wire strung between their documented attachment points.
 */
function emitTramRoute(C, raw) {
  const pts = pruneSpikes(polyResample(raw, ROAD_MAX_SEG), TRACK_SLAB_HW);
  const n = pts.length;
  if (n < 2) return;
  const frames = polyFrames(pts, TRACK_SLAB_HW);
  const mb = C.mb.rails;

  // Per-vertex: the crown of the street the track is set into, or -1 in a reserved ROW.
  const crown = new Float64Array(n);
  const embedded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = carriagewayCrown(C, pts[i][0], pts[i][1]);
    embedded[i] = c >= 0 ? 1 : 0;
    crown[i] = c >= 0 ? c : 0;
  }

  // Track slab under the stretches that are NOT in a street. It stands TRACK_SLAB_Y above the road
  // datum so that where it clips the edge of a carriageway the two are a step apart rather than
  // coplanar — 1.72 m of slab z-fighting the asphalt shimmers along the whole reserved right of way.
  setMat(mb, M.trackBed);
  const yBed = (x, z) => C.groundY(x, z) + ROAD_Y + TRACK_SLAB_Y;
  const slab = (a, b) => {
    if (b - a < 2) return;
    const seg = pts.slice(a, b);
    emitRibbon(mb, seg, polyFrames(seg, TRACK_SLAB_HW),
      [{ o: -TRACK_SLAB_HW, dy: 0 }, { o: TRACK_SLAB_HW, dy: 0 }], yBed);
  };
  let run = -1;
  for (let i = 0; i < n; i++) {
    if (!embedded[i]) { if (run < 0) run = i; continue; }
    if (run >= 0) slab(run, i);
    run = -1;
  }
  if (run >= 0) slab(run, n);

  // Running rails. The head stands RAIL_PROUD above whatever it is set into, which is what makes an
  // embedded rail catch the light along a whole block. In a street that datum is the crown of the
  // asphalt; on a reserved right of way it is the slab, or the rail would sink into its own bed.
  setMat(mb, M.rail);
  const yRail = (x, z, px, pz, i) =>
    C.groundY(x, z) + ROAD_Y + (embedded[i] ? crown[i] : TRACK_SLAB_Y) + RAIL_PROUD;
  const half = TRAM_GAUGE * 0.5;
  for (let k = 0; k < 2; k++) {
    const c = k === 0 ? -half : half;
    emitRibbon(mb, pts, frames,
      [{ o: c - TRAM_RAIL_W * 0.5, dy: 0 }, { o: c + TRAM_RAIL_W * 0.5, dy: 0 }], yRail);
  }

  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = arc[n - 1];
  C.stats.ground.tramMetres += total;
  if (total < 14) return;

  // Catenary poles and the wire between them.
  let prevX = 0, prevY = 0, prevZ = 0, havePrev = false;
  const count = Math.max(1, Math.round(total / TRAM_POLE_SPACING));
  for (let p = 0; p <= count; p++) {
    const s = (p / count) * total;
    let i = 0;
    while (i + 2 < n && arc[i + 1] < s) i++;
    const span = arc[i + 1] - arc[i];
    const t = span > EPS ? clamp((s - arc[i]) / span, 0, 1) : 0;
    const tx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
    const tz = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let ux = frames[i * 3] + (frames[(i + 1) * 3] - frames[i * 3]) * t;
    let uz = frames[i * 3 + 1] + (frames[(i + 1) * 3 + 1] - frames[i * 3 + 1]) * t;
    const ul = Math.hypot(ux, uz);
    if (ul > EPS) { ux /= ul; uz /= ul; } else { ux = 1; uz = 0; }

    // WHERE THE POLE GOES. Two real arrangements, and the difference is not cosmetic: a
    // 1.86 m bracket cannot reach a track in the middle of King Street, so putting the pole a
    // bracket's length off the rails would stand it in a running lane.
    //   * reserved right of way (Spadina, Queens Quay): pole beside the track, bracket straight
    //     over it, on whichever side is clear of the other track of the pair — a Toronto pair
    //     sits about 3.2 m apart.
    //   * embedded in a street (King, Queen, Dundas): pole on the KERB, and a transverse span
    //     wire carries the contact wire back over the rails.
    const inStreet = carriagewayCrown(C, tx, tz) >= 0;
    let px = tx + ux * CATENARY_REACH, pz = tz + uz * CATENARY_REACH;
    let ok = false, spanned = false;
    if (inStreet) {
      let bestD = Infinity;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        let d = 1.5;
        while (d < 22 && onCarriageway(C, tx + ux * d * sgn, tz + uz * d * sgn, 0)) d += 0.5;
        if (d >= 22 || d >= bestD) continue;
        const cx = tx + ux * (d + 1.35) * sgn, cz = tz + uz * (d + 1.35) * sgn;
        if (inFootprint(C, cx, cz, 0.6)) continue;
        bestD = d; px = cx; pz = cz; ok = true; spanned = true;
      }
    }
    if (!ok) {
      let best = -1e9;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const cx = tx + ux * CATENARY_REACH * sgn, cz = tz + uz * CATENARY_REACH * sgn;
        let score = nearestTram(C, cx, cz);
        if (inFootprint(C, cx, cz, 0.5)) score -= 40;
        if (score > best) { best = score; px = cx; pz = cz; ok = score > -30; }
      }
      spanned = false;
    }
    const base = C.groundY(px, pz) + ROAD_Y;
    const wy = base + TRAM_POLE_H - CATENARY_DROP;
    if (ok && !deckFits(C, px, pz, base, PROP_H.catenaryPole)) ok = false;
    if (ok && C.occ.claim(px, pz, 0.95)) {
      // The bracket arm reaches along local +X, i.e. straight at the track centreline.
      const yaw = Math.atan2(-(tz - pz), tx - px);
      const ax = px + CATENARY_REACH * Math.cos(yaw);
      const az = pz - CATENARY_REACH * Math.sin(yaw);
      // Audit: props.js's documented attachment point must lie on the straight line from the pole
      // to the rails, or the wire hangs off the side of the insulator.
      const run = Math.max(EPS, Math.hypot(tx - px, tz - pz));
      const err = Math.abs((ax - px) * (tz - pz) - (az - pz) * (tx - px)) / run;
      if (err > 0.02) C.stats.wireOffTrack++;
      if (err > C.stats.wireMaxError) C.stats.wireMaxError = err;
      appendCatenaryPole(C.mb.props, px, base, pz, yaw, TRAM_POLE_H);
      noteProp(C, 'catenaryPole');
      C.auditRoad.push(px, pz);
      C.stats.ground.tramPoles++;
      if (spanned) {
        setMat(C.mb.props, M.wire);
        emitWireSpan(C, ax, wy, az, tx, wy, tz);
      }
    }
    if (havePrev) {
      // Two members per span with a drop at midspan: a straight wire reads as a wire, a sagging
      // one reads as Toronto.
      const mx = (prevX + tx) * 0.5, mz = (prevZ + tz) * 0.5;
      const my = (prevY + wy) * 0.5 - WIRE_SAG;
      setMat(C.mb.props, M.wire);
      emitWireSpan(C, prevX, prevY, prevZ, mx, my, mz);
      emitWireSpan(C, mx, my, mz, tx, wy, tz);
    }
    prevX = tx; prevY = wy; prevZ = tz; havePrev = true;
  }
}

// Streetcar stops: an island platform where the track has its own right of way, a glazed shelter
// on the sidewalk where it runs in the street.
function placeTramStops(C, raw) {
  const pts = pruneSpikes(polyResample(raw, ROAD_MAX_SEG), TRACK_SLAB_HW);
  const n = pts.length;
  if (n < 4) return;
  const frames = polyFrames(pts, TRACK_SLAB_HW);
  let acc = 0;
  for (let i = 2; i < n - 2; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc < 330) continue;
    acc = 0;
    const x0 = pts[i][0], z0 = pts[i][1];
    const sx = frames[i * 3], sz = frames[i * 3 + 1];
    const inStreet = carriagewayCrown(C, x0, z0) >= 0;
    const off = inStreet ? 9.0 : 3.4;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const x = x0 + sx * off * sgn, z = z0 + sz * off * sgn;
      const kind = inStreet ? 'transitShelter' : 'platformShelter';
      const y = reserve(C, kind, x, z, inStreet ? 2.8 : 3.2, inStreet ? 0.4 : -1);
      if (!isNum(y)) continue;
      // Long axis runs along the track; local +X faces back at it.
      const ox = -sx * sgn, oz = -sz * sgn;
      const yaw = Math.atan2(-oz, ox);
      const seat = y + (inStreet ? kerbSeat(C, x, z) : ROAD_Y);
      if (inStreet) appendTransitShelter(C.mb.props, x, seat, z, yaw, 5.0);
      else appendPlatformShelter(C.mb.props, x, seat, z, yaw, 16.0);
      // Somewhere for the people pass to put the people waiting. `yaw` faces back at the track,
      // so a passenger placed in front of the shelter stands between it and the platform edge.
      C.stations.push({ x, y: seat, z, yaw, len: inStreet ? 5.0 : 16.0 });
      break;
    }
  }
}

export {
  RAIL_PROUD, TRACK_SLAB_HW, TRACK_SLAB_Y, TRAM_POLE_H,
  emitWireSpan, emitTramRoute, placeTramStops,
};
