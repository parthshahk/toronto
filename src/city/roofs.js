// src/city/roofs.js — what is on top: roof form, and the plant standing on it.
//
// CONTRACT.md §6.2 and Amendment 11.1. Moved out of city.js unchanged. Two halves that share one
// question — where the roof actually is:
//
//   ROOF SHAPES.    The surveyed `roof:shape` tag, mapped to the forms worth building. 'flat' is
//                   what the extrusion already is; anything the table does not know is treated as
//                   a gable, which is the commonest pitched roof by a long way and a much smaller
//                   lie than leaving a mansard flat. roofBox() finds the oriented box a pitched
//                   roof sits on and roofRise() how high it goes.
//   THE ROOFSCAPE.  Lift overruns, cooling towers, condensers, aerials, dishes and window rigs,
//                   seated on points proven to be well inside the parapet line so nothing ever
//                   hangs off the edge. Every choice is hashed on world position, never on an
//                   array index, so a roof looks the same whichever tiles are loaded.
//
// Roof caps are profile 0 — a roof has no windows — and nothing here is emissive: a rooftop light
// is the renderer's business, not the geometry's (CONTRACT §7.1).

import { clamp } from '../core/math.js';
import { hashPos } from '../core/util.js';
import { closestOnRing, partContains } from '../geom/ring.js';
import {
  appendRooftopUnit, appendElevatorPenthouse, appendCoolingTower, appendRoofAntenna,
  appendWindowRig, appendSatelliteDish, appendACondenser, appendFlagPole,
} from '../props/index.js';
import { noteProp } from '../world/context.js';
import { EPS } from '../world/ground.js';

/* =============================================================== roofscape == */

// A point well inside a roof part: rejected until it is at least `clear` metres from the edge, so
// plant never hangs off the parapet line.
const _rp = [0, 0];

function roofPoint(part, key, clear) {
  const bb = part.bbox;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  if (w < clear * 2.2 || h < clear * 2.2) return false;
  for (let t = 0; t < 10; t++) {
    const u = bb[0] + w * (0.12 + 0.76 * hashPos(key * 7 + t, key * 13, 3));
    const v = bb[1] + h * (0.12 + 0.76 * hashPos(key * 11 + t, key * 5, 4));
    if (!partContains(part, u, v)) continue;
    if (closestOnRing(part.outer, u, v).d2 < clear * clear) continue;
    _rp[0] = u; _rp[1] = -v;
    return true;
  }
  return false;
}

/**
 * Rooftop plant, scaled to the building. A bare extruded roof is one of the loudest tells that a
 * city was generated; every real flat roof downtown carries at least a condenser and a hatch.
 */
function placeRoofscape(C, b) {
  if (!b.mainPart || b.h < 8 || !(b.area > 0)) return;
  const part = b.mainPart;
  const rng = C.rng;
  const mbP = C.mb.props;
  // The roof cap this plant stands on may have STEPPED DOWN out of a shared plane (see
  // resolveCoplanarCaps), so the deck is not always b.y + b.h. Six centimetres of open air under
  // a cooling tower is small, and it is exactly the kind of small that reads as broken.
  const y = b.y + b.h - (part.capDrop || 0);
  const a = b.area;
  const yaw = b.frontYaw + Math.PI * 0.5;

  const units = a > 3200 ? 2 : (a > 1400 ? 1 : 0);
  for (let i = 0; i < units; i++) {
    if (!roofPoint(part, b.key * 31 + i * 3, 3.4)) break;
    const sz = clamp(Math.sqrt(a) * 0.10, 1.6, 6.5);
    appendRooftopUnit(mbP, rng, _rp[0], y, _rp[1], yaw + i * 0.7,
      sz * (0.8 + rng() * 0.6), sz * 0.62, 1.1 + rng() * 1.1);
    noteProp(C, 'rooftopUnit');
  }
  if (units === 0 && a > 150 && rng() < 0.17 && roofPoint(part, b.key * 17, 1.4)) {
    appendACondenser(mbP, rng, _rp[0], y, _rp[1], yaw);
    noteProp(C, 'acCondenser');
  }
  if (a > 1800 && b.h > 30 && roofPoint(part, b.key * 41, 3.0)) {
    appendCoolingTower(mbP, rng, _rp[0], y, _rp[1], yaw,
      clamp(Math.sqrt(a) * 0.045, 0.9, 3.4), clamp(Math.sqrt(a) * 0.09, 1.8, 6.0));
    noteProp(C, 'coolingTower');
  }
  if (b.h > 52 && a > 500 && roofPoint(part, b.key * 53, 4.2)) {
    const w = clamp(Math.sqrt(a) * 0.26, 4.0, 15.0);
    appendElevatorPenthouse(mbP, rng, _rp[0], y, _rp[1], yaw, w, w * 0.72,
      clamp(b.h * 0.045, 2.6, 7.5));
    noteProp(C, 'elevatorPenthouse');
  }
  if (b.h > 122 && roofPoint(part, b.key * 67, 2.4)) {
    appendRoofAntenna(mbP, rng, _rp[0], y, _rp[1], clamp(b.h * 0.10, 4.0, 22.0));
    noteProp(C, 'roofAntenna');
  }
  if (b.h > 40 && a > 400 && rng() < 0.22 && roofPoint(part, b.key * 71, 2.0)) {
    appendSatelliteDish(mbP, _rp[0], y, _rp[1], yaw + rng() * 1.2, 0.5 + rng() * 0.9);
    noteProp(C, 'satelliteDish');
  }
  // A parked window-washing cradle on the tall stock. The origin goes ON the parapet with local
  // +X out over the facade, which is exactly the frontage frame.
  if (b.h > 150 && b.frontLen > 7) {
    appendWindowRig(mbP, b.frontX, y + 1.05, b.frontZ, b.frontYaw, 3.2);
    noteProp(C, 'windowRig');
  }
  if (b.profile === 5 && b.h > 9 && b.h < 45 && roofPoint(part, b.key * 83, 2.0)) {
    appendFlagPole(mbP, _rp[0], y, _rp[1], clamp(b.h * 0.35, 6, 14));
    noteProp(C, 'flagPole');
  }
}
/* ============================================================ roof shapes == */

// Which roof forms are worth building. 'flat' is what the extrusion already is, and anything
// this table does not know is treated as a gable — the commonest pitched roof by a long way, and
// a much smaller lie than leaving a mansard flat.
const ROOF_SHAPES = {
  gabled: 'gabled', hipped: 'hipped', 'half-hipped': 'half-hipped', pyramidal: 'pyramidal',
  mansard: 'mansard', gambrel: 'gabled', saltbox: 'saltbox', quadruple_saltbo: 'saltbox',
  skillion: 'skillion', 'shed': 'skillion', 'lean_to': 'skillion',
  round: 'round', dome: 'dome', onion: 'dome', cone: 'pyramidal', pitched: 'gabled',
  side_hipped: 'hipped', crosspitched: 'gabled', double_saltbox: 'saltbox',
};

// A roof needs a footprint a roof could sit on. Past this the record is a shed, a warehouse or a
// stacked massing slab, and a 60 m gable over it is worse than the flat lid it replaces.
const ROOF_MAX_SPAN = 46;

function roofShapeOf(b) {
  if (!b.roof || b.roof === 'flat') return '';
  return ROOF_SHAPES[b.roof] || 'gabled';
}

/**
 * The oriented box a pitched roof stands in: the ridge runs along the footprint's LONGEST edge,
 * because that is what a roof does and because an axis-aligned box would sit 17 degrees off the
 * street grid this whole city is built on.
 */
const ROOF_BOX = { cx: 0, cz: 0, yaw: 0, w: 0, d: 0 };
function roofBox(part) {
  if (!part) return false;
  const co = part.outer;
  const n = co.length;
  if (n < 6) return false;
  let au = 1, av = 0, bestL = 0;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const du = co[i] - co[j], dv = co[i + 1] - co[j + 1];
    const l = du * du + dv * dv;
    if (l > bestL) { bestL = l; au = du; av = dv; }
  }
  const l = Math.sqrt(bestL);
  if (!(l > EPS)) return false;
  au /= l; av /= l;
  const nu = -av, nv = au;
  let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
  for (let i = 0; i < n; i += 2) {
    const pp = co[i] * au + co[i + 1] * av;
    const qq = co[i] * nu + co[i + 1] * nv;
    if (pp < p0) p0 = pp;
    if (pp > p1) p1 = pp;
    if (qq < q0) q0 = qq;
    if (qq > q1) q1 = qq;
  }
  const along = p1 - p0, across = q1 - q0;
  if (!(along > 0.8) || !(across > 0.8)) return false;
  if (along > ROOF_MAX_SPAN || across > ROOF_MAX_SPAN) return false;
  const pc = (p0 + p1) * 0.5, qc = (q0 + q1) * 0.5;
  const u = au * pc + nu * qc;
  const v = av * pc + nv * qc;
  ROOF_BOX.cx = u;
  ROOF_BOX.cz = -v;
  ROOF_BOX.w = across;
  ROOF_BOX.d = along;
  // props.js: local +Z is world (sin yaw, cos yaw). The ridge runs along the long axis, whose
  // world direction is (au, -av) because plan v = -z.
  ROOF_BOX.yaw = Math.atan2(au, -av);
  return true;
}

function roofRise(b, box) {
  const span = Math.min(box.w, box.d);
  const k = roofShapeOf(b);
  if (k === 'skillion' || k === 'saltbox') return clamp(box.w * 0.20, 0.7, 3.4);
  if (k === 'pyramidal' || k === 'dome') return clamp(span * 0.46, 1.4, 9.0);
  if (k === 'round') return clamp(box.w * 0.42, 1.0, 6.5);
  return clamp(span * 0.36, 1.2, 6.5);
}

export { placeRoofscape, roofShapeOf, roofBox, roofRise, ROOF_BOX };
