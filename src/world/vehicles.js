// src/world/vehicles.js — what is parked where.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged. Three placement passes,
// all of them seeded on world position so a car looks the same whether or not its neighbours were
// loaded (CONTRACT §8.4):
//
//   placeKerbCars()  kerb-lane parking, the one prop class that belongs ON the carriageway.
//   placeLotCars()   surface lots, in rows aligned to the lot's own longest edge.
//   placeRailCars()  rolling stock in the corridor south of Front, on the track centreline at
//                    top of rail, so a car sits on its own rails rather than beside them.
//
// ISLANDS. Private cars are banned on the Toronto Islands; harbourCarFree() is what keeps a
// kerbside row of them off Lakeshore Avenue, which would be the single most obviously wrong thing
// down there.

import { clamp } from '../core/math.js';
import { polyResample } from '../geom/ribbon.js';
import { partContains } from '../geom/ring.js';
import { appendParkedCar, appendRailCar } from '../props/index.js';
import { harbourCarFree } from './islands.js';
import { EPS, ROAD_MAX_SEG } from './ground.js';
import { PROP_H, deckFits, inFootprint, noteProp } from './context.js';
import { RAIL_BED, corridorDepth } from './grade.js';
import { nearJunction, recSample, surfaceY } from './roads.js';

const CAR_SPACING = 6.6;           // kerb-lane parking pitch, car plus gap
const CAR_FILL = 0.070;             // fraction of kerb-lane slots that hold a car
const STALL_W = 2.65;              // parking-lot stall
const STALL_L = 5.30;
const LOT_FILL = 0.55;
const MAX_LOT_CARS = 620;         // across every surface lot in the extract
const MAX_LOT_CARS_EACH = 34;
// ...and per TILE, which is what actually bounds a frame now: the old city-wide number was a
// vertex budget in disguise, and a vertex budget is what tiles.js enforces.
const MAX_LOT_CARS_TILE = 90;
/* ================================================================ vehicles == */

// Kerb-lane parking — the one prop class that belongs ON the carriageway.
function placeKerbCars(C, rec) {
  if (rec.bridge || rec.foot || rec.cls === 'motorway' || rec.cls === 'pedestrian') return;
  if (rec.hw < 4.6 || rec.len < 22) return;
  const rng = C.rng;
  const mbP = C.mb.props;
  const o0 = rec.hw - 1.02;
  for (let sd = 0; sd < 2; sd++) {
    const sgn = sd === 0 ? 1 : -1;
    const o = o0 * sgn;
    for (let s = 6 + sd * 3.3; s < rec.len - 6; s += CAR_SPACING) {
      if (rng() > CAR_FILL) continue;
      if (nearJunction(rec, s, 7.0)) continue;
      const m = recSample(rec, s);
      const x = m.x + m.sx * o, z = m.z + m.sz * o;
      if (inFootprint(C, x, z, 0.4)) continue;
      // ISLANDS: private cars are banned on the Toronto Islands, and a kerbside row of them on
      // Lakeshore Avenue would be the single most obviously wrong thing down there.
      if (harbourCarFree(C.harbour, x, z)) continue;
      if (!deckFits(C, x, z, surfaceY(C, rec, m, o), PROP_H.parkedCar)) continue;
      if (!C.occ.claim(x, z, 2.6)) continue;
      // Cars face the direction of travel of the lane they sit in. props.js: the car's length
      // runs along local Z, so yaw = atan2(dx, dz) points it along (dx, dz).
      const fx = m.sz * sgn, fz = -m.sx * sgn;
      const r = rng();
      const kind = r < 0.56 ? 'sedan' : (r < 0.80 ? 'suv' : (r < 0.93 ? 'van' : 'taxi'));
      appendParkedCar(mbP, rng, x, surfaceY(C, rec, m, o), z, Math.atan2(fx, fz), kind);
      noteProp(C, 'parkedCar');
      C.auditRoad.push(x, z);
    }
  }
}

// Surface lots: rows of stalls aligned to the lot's own longest edge.
function placeLotCars(C, part, cap) {
  // ISLANDS: the island car parks are for the park's own service vehicles, and filling them with
  // commuter cars on a chain of islands you can only reach by ferry is a story hole.
  if (harbourCarFree(C.harbour, part.bbox ? (part.bbox[0] + part.bbox[2]) * 0.5 : 0,
    part.bbox ? -(part.bbox[1] + part.bbox[3]) * 0.5 : 0)) return 0;
  const co = part.outer;
  let au = 0, av = 0, bestLen = 0;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const du = co[i] - co[j], dv = co[i + 1] - co[j + 1];
    const l = du * du + dv * dv;
    if (l > bestLen) { bestLen = l; au = du; av = dv; }
  }
  const l = Math.hypot(au, av);
  if (!(l > EPS)) return 0;
  au /= l; av /= l;
  const nu = -av, nv = au;
  const bb = part.bbox;
  const cu = (bb[0] + bb[2]) * 0.5, cv = (bb[1] + bb[3]) * 0.5;
  const reach = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 2;
  const rng = C.rng;
  const mbP = C.mb.props;
  let placed = 0;
  const rowPitch = STALL_L * 2 + 6.2;
  for (let r = -reach; r <= reach && placed < cap; r += rowPitch) {
    for (let k = 0; k < 2 && placed < cap; k++) {
      const face = k === 0 ? -1 : 1;
      const off = r + face * STALL_L * 0.5;
      for (let t = -reach; t <= reach && placed < cap; t += STALL_W) {
        if (rng() > LOT_FILL) continue;
        const u = cu + au * t + nu * off;
        const v = cv + av * t + nv * off;
        if (!partContains(part, u, v)) continue;
        const x = u, z = -v;
        if (inFootprint(C, x, z, 0.5)) continue;
        if (!deckFits(C, x, z, C.groundY(x, z) + 0.07, PROP_H.lotCar)) continue;
        if (!C.occ.claim(x, z, 2.4)) continue;
        // Stalls sit square to the row, nose toward the aisle.
        const dx = nu * face, dz = -nv * face;
        const rr = rng();
        appendParkedCar(mbP, rng, x, C.groundY(x, z) + 0.07, z, Math.atan2(dx, dz),
          rr < 0.58 ? 'sedan' : (rr < 0.84 ? 'suv' : 'van'));
        noteProp(C, 'lotCar');
        C.auditRoad.push(x, z);
        placed++;
      }
    }
  }
  return placed;
}
/* ==================================================================== rail == */

// Rolling stock standing in the corridor south of Front. Placed on the track centreline at top of
// rail, so a car sits on its own rails instead of beside them.
function placeRailCars(C, raw, lift, profile) {
  // `profile` is the WHOLE way when `raw` is one tile's run of it: the embankment's height comes
  // from the corridor the grade solve built for the way, and a run must not re-derive a shorter
  // one or two tiles of the same track disagree about where the railhead is.
  const src = Array.isArray(profile) && profile.length > 1 ? profile : raw;
  const railY = (x, z) => C.terrainY(x, z) +
    (lift ? corridorDepth({ pts: src, dep: lift }, x, z) : 0) + RAIL_BED + 0.20;
  const pts = polyResample(raw, ROAD_MAX_SEG);
  if (pts.length < 3) return;
  const rng = C.rng;
  const arc = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    arc.push(total);
  }
  if (total < 140) return;
  const start = 30 + rng() * (total - 130);
  const n = 2 + ((rng() * 4) | 0);
  for (let k = 0; k < n; k++) {
    const s = start + k * 26.5;
    if (s > total - 24) break;
    let i = 0;
    while (i + 2 < pts.length && arc[i + 1] < s) i++;
    const span = arc[i + 1] - arc[i];
    const t = span > EPS ? clamp((s - arc[i]) / span, 0, 1) : 0;
    const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
    const z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const dl = Math.hypot(dx, dz);
    if (!(dl > EPS)) continue;
    dx /= dl; dz /= dl;
    if (inFootprint(C, x, z, 2.0)) continue;
    const seat = railY(x, z);
    if (!deckFits(C, x, z, seat, PROP_H.railCar)) continue;
    if (!C.occ.claim(x, z, 13.0)) continue;
    appendRailCar(C.mb.props, rng, x, seat, z, Math.atan2(dx, dz),
      k === 0 ? 'locomotive' : (rng() < 0.45 ? 'freight' : 'coach'));
    noteProp(C, 'railCar');
  }
}

export {
  CAR_SPACING, CAR_FILL, STALL_W, STALL_L, LOT_FILL,
  MAX_LOT_CARS, MAX_LOT_CARS_EACH, MAX_LOT_CARS_TILE,
  placeKerbCars, placeLotCars, placeRailCars,
};
