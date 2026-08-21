// src/world/trench.js — the structures a grade-separated way needs to be believable.
//
// CONTRACT.md §8.1, §9.2 and Amendment 11.1. Moved out of city.js unchanged. world/grade.js
// decides where every way sits; this module builds what that implies:
//
//   emitTrench()    a depressed corridor: retaining walls up to natural grade, the paved verge
//                   over the edge of the terrain cut, the ceiling where it runs under a building
//                   rather than in the open, batten luminaires under that ceiling, and a portal
//                   at every mouth.
//   emitPassage()   a road through a building at grade (tun = 2), which stays walkable.
//   emitSubway()    an underground concourse: floor, walls, ceiling and cover.
//   emitPortal()    the jambs and lintel where a corridor enters a structure.
//   emitWallStrip() a vertical wall along one lateral offset of a polyline, with independent top
//                   and bottom height functions.
//
// The carriageway itself is NEVER built here — it is the ordinary road ribbon, laid on the same
// composed groundY the corridor defines, which is exactly why the two can never disagree.

import { clamp } from '../core/math.js';
import { polyResample, polyFrames, pruneSpikes, emitSkirt } from '../geom/ribbon.js';
import { isNum } from '../core/util.js';
import { emitRibbon } from './audit.js';
import { M, setMat } from '../city/materials.js';
import { EPS, ROAD_Y, PATH_Y, triDown, boxAA } from './ground.js';
import {
  CUT_MIN, PASSAGE_HEAD, TRENCH_VERGE, UNDER_CLEAR, LAYER_DROP,
  SUB_HEAD, SUB_COVER, SUB_SEG, TUNNEL_LAMP_H, TUNNEL_LAMP_MIN, TUNNEL_LAMP_PITCH, layerDepth,
} from './grade.js';
// The street-detail context: what a corridor runs under, and how much air there is above it.
import { coveringRecord, deckSoffitAbove, inFootprint } from './context.js';

/* ------------------------------------------------------------- structures -- */

/** A vertical wall along one lateral offset, with independent top and bottom height functions. */
function emitWallStrip(mb, pts, frames, offset, yTop, yBot, facing) {
  const n = pts.length;
  let px = 0, pz = 0, pt = 0, pb = 0, have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const o = offset * sc;
    const x = pts[i][0] + sx * o, z = pts[i][1] + sz * o;
    const t = yTop(x, z, i), b = yBot(x, z, i);
    if (have && (t - b > 0.01 || pt - pb > 0.01)) {
      if (facing < 0) {
        mb.tri(px, pb, pz, px, pt, pz, x, t, z);
        mb.tri(px, pb, pz, x, t, z, x, b, z);
      } else {
        mb.tri(px, pb, pz, x, b, z, x, t, z);
        mb.tri(px, pb, pz, x, t, z, px, pt, pz);
      }
    }
    px = x; pz = z; pt = t; pb = b; have = true;
  }
}

/**
 * A portal: two jambs and a lintel across a corridor, at the mouth where it goes under something.
 * Cheap, and it is what turns a hole in the ground into an underpass you can read at a glance.
 */
function emitPortal(mb, x, z, sx, sz, hw, yFloor, yHead) {
  if (!(yHead - yFloor > 0.6) || !(hw > 0.5)) return;
  const t = 0.55;                                   // jamb thickness along the corridor
  const tx = -sz * t * 0.5, tz = sx * t * 0.5;      // half a jamb, along the way
  const jamb = (o) => {
    const cx = x + sx * o, cz = z + sz * o;
    boxAA(mb, cx, cz, tx, tz, sx * 0.45, sz * 0.45, yFloor, yHead + 0.55);
  };
  jamb(-(hw + 0.30));
  jamb(hw + 0.30);
  // Lintel across the top, spanning both jambs.
  boxAA(mb, x, z, tx, tz, sx * (hw + 0.75), sz * (hw + 0.75), yHead, yHead + 0.55);
}


/**
 * The structure of a depressed corridor: retaining walls up to natural grade, the paved verge that
 * covers the edge of the cut taken out of the terrain, the ceiling where the corridor runs under a
 * building rather than in the open, and a portal at every mouth.
 *
 * The carriageway itself is NOT built here — it is the ordinary road ribbon, laid on the same
 * composed `groundY` this corridor defines, which is exactly why the two can never disagree.
 */
function emitTrench(C, cor) {
  const hw = cor.hw;
  const pts = cor.pts, dep = cor.dep, roof = cor.roof;
  const nP = pts.length;
  if (nP < 2) return;
  const frames = polyFrames(pts, hw + TRENCH_VERGE);
  const T = C.terrainY;
  const mb = C.mb.roads;
  const floorY = new Float64Array(nP);
  const topY = new Float64Array(nP);
  for (let i = 0; i < nP; i++) {
    topY[i] = T(pts[i][0], pts[i][1]);
    floorY[i] = topY[i] - dep[i];
  }
  const yTop = (x, z, i) => topY[i];
  const yBot = (x, z, i) => floorY[i] - 0.30;

  // Retaining walls. They stand the full depth wherever there is any, so the wall dies away on
  // its own along the ramp instead of ending in a step.
  setMat(mb, M.bridge);
  emitWallStrip(mb, pts, frames, -hw, yTop, yBot, 1);
  emitWallStrip(mb, pts, frames, hw, yTop, yBot, -1);
  C.stats.grade.wallMetres += arcLength(pts) * 2;

  // The paved verge, over the ragged edge of the terrain cut — but only in the open, because
  // under a building there is no cut to cover.
  setMat(mb, M.sidewalk);
  const vergeY = (x, z) => T(x, z) + PATH_Y;
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    let run = -1;
    for (let i = 0; i <= nP; i++) {
      const open = i < nP && dep[i] > CUT_MIN && !roof[i];
      if (open) { if (run < 0) run = i; continue; }
      if (run >= 0 && i - run >= 2) {
        const seg = pruneSpikes(pts.slice(Math.max(0, run - 1), Math.min(nP, i + 1)),
          hw + TRENCH_VERGE);
        if (seg.length >= 2) {
          const fr = polyFrames(seg, hw + TRENCH_VERGE);
          const a = hw * sgn, b = (hw + TRENCH_VERGE) * sgn;
          emitRibbon(mb, seg, fr, sgn > 0 ? [{ o: a, dy: 0 }, { o: b, dy: 0 }]
            : [{ o: b, dy: 0 }, { o: a, dy: 0 }], vergeY);
          emitSkirt(mb, seg, fr, b, vergeY, PATH_Y + 0.9, sgn);
        }
      }
      run = -1;
    }
  }

  // Ceiling where the corridor is roofed, and a portal wherever roofed meets open.
  setMat(mb, M.bridge);
  const ceilY = new Float64Array(nP);
  for (let i = 0; i < nP; i++) {
    // A lid carries a street across, so its soffit hangs a deck's depth under natural grade.
    ceilY[i] = Math.min(topY[i] - 0.95, floorY[i] + UNDER_CLEAR + 0.55);
  }
  for (let i = 1; i < nP; i++) {
    if (!roof[i - 1] || !roof[i]) continue;
    const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
    const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
    const o0 = hw * c0, o1 = hw * c1;
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    // A soffit, seen from below: wound so its normal points DOWN.
    const p0x = ax - s0 * o0, p0z = az - t0 * o0, p1x = ax + s0 * o0, p1z = az + t0 * o0;
    const q0x = bx - s1 * o1, q0z = bz - t1 * o1, q1x = bx + s1 * o1, q1z = bz + t1 * o1;
    const ya = ceilY[i - 1], yb = ceilY[i];
    triDown(mb, p0x, ya, p0z, p1x, ya, p1z, q1x, yb, q1z);
    triDown(mb, p0x, ya, p0z, q1x, yb, q1z, q0x, yb, q0z);
  }
  for (let i = 1; i < nP; i++) {
    if (roof[i - 1] === roof[i]) continue;
    const k = roof[i] ? i : i - 1;
    if (!(dep[k] > CUT_MIN)) continue;
    emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
      hw * frames[k * 3 + 2], floorY[k], ceilY[k]);
    C.stats.grade.portals++;
  }

  // Under a BUILDING the corridor is not open to the sky — Union Station's teamways are a tunnel
  // through the base of the station, not a trench beside it. `punchCorridorPortals` has already
  // taken the facade out from its foot up to floor + UNDER_CLEAR, so the ceiling goes on exactly
  // that line, the sides are closed from natural grade up to meet it, and a portal frame stands at
  // each mouth. The floor stays the depressed carriageway, which is what keeps it walkable.
  const cover = new Uint8Array(nP);
  const soff = new Float64Array(nP);
  let covered = false;
  for (let i = 0; i < nP; i++) {
    soff[i] = floorY[i] + UNDER_CLEAR;
    if (!roof[i] && coveringRecord(C, pts[i][0], pts[i][1])) { cover[i] = 1; covered = true; }
  }
  if (covered) {
    setMat(mb, M.tunnel);
    for (let i = 1; i < nP; i++) {
      if (!cover[i - 1] || !cover[i]) continue;
      const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
      const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
      const o0 = hw * c0, o1 = hw * c1;
      const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
      const p0x = ax - s0 * o0, p0z = az - t0 * o0, p1x = ax + s0 * o0, p1z = az + t0 * o0;
      const q0x = bx - s1 * o1, q0z = bz - t1 * o1, q1x = bx + s1 * o1, q1z = bz + t1 * o1;
      const ya = soff[i - 1], yb = soff[i];
      triDown(mb, p0x, ya, p0z, p1x, ya, p1z, q1x, yb, q1z);
      triDown(mb, p0x, ya, p0z, q1x, yb, q1z, q0x, yb, q0z);
      C.stats.grade.coveredMetres += Math.hypot(bx - ax, bz - az);
    }
    // Close the sides between natural grade and the soffit wherever the ceiling stands above the
    // ground it passes through, so no strip of sky is left between the trench wall and the lid.
    const spanTop = (x, z, i) => (cover[i] ? Math.max(soff[i], topY[i]) : topY[i]);
    const spanBot = (x, z, i) => topY[i];
    emitWallStrip(mb, pts, frames, -hw, spanTop, spanBot, 1);
    emitWallStrip(mb, pts, frames, hw, spanTop, spanBot, -1);
    for (let i = 1; i < nP; i++) {
      if (cover[i - 1] === cover[i]) continue;
      const k = cover[i] ? i : i - 1;
      emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
        hw * frames[k * 3 + 2], floorY[k], soff[k]);
      C.stats.grade.coverPortals++;
    }
    // Batten luminaires down the crown of the tunnel. Under a building there is no sky and no
    // lamp standard tall enough to matter, so this is the only lighting a teamway has; it is
    // modelled as the fixture and left to the renderer to switch, like every other emitter.
    const mbP = C.mb.props;
    setMat(mbP, M.tunnelLamp);
    for (let i = 1; i < nP; i++) {
      if (!cover[i - 1] || !cover[i]) continue;
      const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
      const seg = Math.hypot(bx - ax, bz - az);
      if (!(seg > EPS)) continue;
      const yaw = Math.atan2(bx - ax, bz - az);
      const n = Math.max(1, Math.round(seg / TUNNEL_LAMP_PITCH));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const floor = floorY[i - 1] + (floorY[i] - floorY[i - 1]) * t;
        // Hang it from whatever is actually lowest overhead. Under Union Station the rail deck
        // carrying the corridor's own tracks sits BELOW the tunnel lid, and a fixture bolted to
        // the lid would be buried in the deck and light nothing — which is exactly how the York
        // teamway came out dark the first time.
        let y = soff[i - 1] + (soff[i] - soff[i - 1]) * t;
        const deck = deckSoffitAbove(C, x, z, floor + TUNNEL_LAMP_MIN);
        if (deck < y) y = deck;
        // ...and never higher than a pendant fixture hangs. A rail bridge carried over the
        // corridor is not in the deck index at all, so a batten pinned to the lid can end up
        // inside the deck above it and light nothing. TUNNEL_LAMP_H is below every structure the
        // grade solve guarantees UNDER_CLEAR for, so this is always in the open.
        if (y > floor + TUNNEL_LAMP_H) y = floor + TUNNEL_LAMP_H;
        if (!(y > floor + TUNNEL_LAMP_MIN)) continue;
        mbP.box(x, y - 0.16, z, 0.34, 0.10, 1.70, yaw);
        C.stats.grade.tunnelLamps++;
      }
    }
    // File that ceiling as an elevated deck. Everything placed later — lamps, signals, trees,
    // parked cars — already knows how to read a soffit and either fit under it or stand down, so
    // one entry stops a 9.5 m cobra lamp growing through the station floor AND is what puts light
    // in the teamway, because a lamp under a deck is shortened to fit rather than skipped.
    const dIdx = C.deckIdx;
    if (dIdx) {
      const covr = hw + 0.40;
      for (let i = 1; i < nP; i++) {
        if (!cover[i - 1] || !cover[i]) continue;
        const a = pts[i - 1], b = pts[i];
        dIdx.add(Math.min(a[0], b[0]) - covr, Math.min(a[1], b[1]) - covr,
          Math.max(a[0], b[0]) + covr, Math.max(a[1], b[1]) + covr,
          [a[0], a[1], b[0], b[1], covr, soff[i - 1], soff[i]]);
        C.stats.deck.segments++;
      }
    }
  }
}

/**
 * A building passage: a road or walkway that goes THROUGH a building and stays at grade.
 *
 * 75 of these were previously deleted with the tunnels, which is why an arcade or a service
 * courtyard entrance reads as a dead end. The surface is built by the ordinary road pass — a
 * passage is at grade and stays walkable — so what is left is the opening: a portal frame at each
 * mouth, found by walking the way and watching for the moment it enters or leaves a footprint.
 */
function emitPassage(C, r, hw) {
  const pts = pruneSpikes(polyResample(r.p, 4.0), hw);
  if (pts.length < 3) return;
  const frames = polyFrames(pts, hw);
  const mb = C.mb.roads;
  setMat(mb, M.bridge);
  let prev = inFootprint(C, pts[0][0], pts[0][1], 0);
  for (let i = 1; i < pts.length; i++) {
    const cur = inFootprint(C, pts[i][0], pts[i][1], 0);
    if (cur === prev) continue;
    prev = cur;
    const k = cur ? i : i - 1;
    const y = C.groundY(pts[k][0], pts[k][1]) + ROAD_Y;
    emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
      hw * frames[k * 3 + 2], y, y + PASSAGE_HEAD);
    C.stats.grade.passagePortals++;
  }
}

/** Emit a near-horizontal triangle wound so its normal points DOWN, whatever order it came in. */
function arcLength(pts) {
  let l = 0;
  for (let k = 1; k < pts.length; k++) {
    l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  }
  return l;
}

/**
 * An underground concourse — the PATH.
 *
 * 630 of these were previously deleted outright, which is a large part of what the user is
 * walking into. They are a genuine second level: a floor, two walls and a ceiling, cut into the
 * ground under the buildings they serve. They do not touch `groundY`, because the ground above
 * them is still ground, and they are audited as their own connected network.
 */
function emitSubway(C, r, gi, G) {
  const w = clamp(isNum(r.w) ? r.w : 4, 1.6, 20);
  // Resampled coarsely on purpose: a concourse is a straight-walled corridor under a building
  // with no terrain to follow, so stations buy nothing but vertices.
  const pts = pruneSpikes(polyResample(r.p, SUB_SEG), w / 2);
  if (pts.length < 2) return;
  const hw = w / 2;
  const frames = polyFrames(pts, hw);
  const T = C.terrainY;
  const drop = layerDepth(G.lay[gi], r.tun | 0) || LAYER_DROP;
  const mb = C.mb.sidewalks;
  // Deep enough that the ceiling always keeps its cover of earth, whatever the terrain does.
  const floorY = (x, z) => Math.min(T(x, z) - SUB_COVER - SUB_HEAD, T(x, z) - drop);
  const ceil = (x, z) => floorY(x, z) + SUB_HEAD;
  setMat(mb, M.path);
  emitRibbon(mb, pts, frames, [{ o: -hw, dy: 0 }, { o: hw, dy: 0 }], floorY);
  setMat(mb, M.bridge);
  emitWallStrip(mb, pts, frames, -hw, ceil, floorY, 1);
  emitWallStrip(mb, pts, frames, hw, ceil, floorY, -1);
  for (let i = 1; i < pts.length; i++) {
    const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
    const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
    const o0 = hw * c0, o1 = hw * c1;
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const ya = ceil(ax, az), yb = ceil(bx, bz);
    triDown(mb, ax - s0 * o0, ya, az - t0 * o0, ax + s0 * o0, ya, az + t0 * o0,
      bx + s1 * o1, yb, bz + t1 * o1);
    triDown(mb, ax - s0 * o0, ya, az - t0 * o0, bx + s1 * o1, yb, bz + t1 * o1,
      bx - s1 * o1, yb, bz - t1 * o1);
  }
  C.stats.grade.subMetres += arcLength(pts);
}

export { emitWallStrip, emitPortal, emitTrench, emitPassage, emitSubway, arcLength };
