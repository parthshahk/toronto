// src/city/frontage.js — building the block face the unit model laid out.
//
// CONTRACT.md §6.2 and Amendment 11.1. Moved out of city.js unchanged. city/units.js decides WHAT
// is on a frontage — which edges face a street, how deep the storeys are, where each premises
// starts and ends and what trade it is. This module BUILDS it, unit by unit, and hangs everything
// above the ground floor off the same frontage:
//
//   buildFrontage()        one street-facing edge: its units, their fascias, the pavement clutter
//                          that belongs to them, and the corner entrance where two faces meet.
//   buildSignage()         the glyph geometry for shop names and house numbers, in its own class
//                          because render.js draws it in a blended decal pass of its own.
//   buildFacade()          the whole building: frontages, balcony bands, cornices, string courses,
//                          fire escapes, loading docks and the parapet.
//
// TIME OF DAY (CONTRACT §7.1). A shop interior is modelled as real geometry with a real emissive
// ceiling fixture, so at noon it is a dim room with the sun falling into it and after dark it
// glows, with no preset-specific branch anywhere. Nothing here bakes light into albedo.
//
// The two scratch arrays at the top are reused across buildings on purpose: the facade pass runs
// for every building in a tile, and allocating two arrays per building is a garbage-collection
// pause per tile. Both are written and read within one call.

import { clamp } from '../core/math.js';
import { isNum, hashPos } from '../core/util.js';
import { partContains } from '../geom/ring.js';
import {
  appendBalconyBand, appendCornice, appendFireEscape, appendLoadingDock, appendParapet,
  appendStringCourse
} from './articulation.js';
import { appendCornerEntrance, appendUnitFront, appendWallFixture } from './unitfronts.js';
import { unitStyle } from './unitkinds.js';
import { appendPatioSet, appendSandwichBoard, appendVendingMachine, appendPayphone } from '../props/index.js';
import { EMITTER_MIN, SIGN_CLASS, setMat } from './materials.js';
import { CURB, ROAD_Y } from '../world/ground.js';
import { kerbSeat, noteLight, reserve } from '../world/context.js';
import {
  BACK_EDGE, CORNER_MIN_LEN, CORNER_UNIT_R, ENTRY_SLOT, NON_TRADE, RETAIL_ANCHOR,
  assignUnits, collectFrontages, entranceKind, fasciaName, findFrontage, frontageRetail,
  layoutUnits, pickEdge, storeyModel, synthKind, unitsMergedLast,
} from './units.js';

// Bands per facade. The step is floor-to-floor until a tower is tall enough to need more than
// this many, after which it opens up — a band every second storey still reads as a banded tower,
// where a band every fourth storey reads as fins. Paid for out of furniture spacing, per §6.4.
const BALCONY_MAX = 24;
/* ================================================================= facades == */

// One frontage's worth of scratch, reused: the facade pass runs for every building in a tile and
// allocating two arrays per building is a garbage-collection pause per tile.
const _fronts = [];
const _slots = [];

/**
 * The block face: every unit along one street-facing edge, built where the survey says it is.
 */
function buildFrontage(C, b, fr, primary, signsOnly) {
  let doors = 0;
  const mb = signsOnly ? C.mb[SIGN_CLASS] : C.mb.buildings;
  const F = C.stats.facades;
  const retail = fr.retail;
  const H = clamp(b.groundH, 2.7, Math.min(6.4, Math.max(2.7, b.h - 0.4)));
  const sill = C.groundY(fr.x, fr.z) + ROAD_Y + CURB * 0.55;
  const yaw = fr.yaw;
  const n = layoutUnits(b, fr, retail, primary, _slots);
  if (!n) return 0;
  let anchor = 0;

  const font = C.font;
  const textMb = C.mb[SIGN_CLASS];
  const opts = {
    kind: 'goods', name: '', house: '', brand: '', font, textMb,
    endL: true, endR: false, mat: b.mat, audit: F, textOnly: !!signsOnly,
  };
  if (!signsOnly) setMat(mb, b.mat);
  for (let i = 0; i < n; i++) {
    const sl = _slots[i];
    const w = sl.s1 - sl.s0;
    const sc = (sl.s0 + sl.s1) * 0.5;
    const x = fr.ax + fr.tx * sc, z = fr.az + fr.tz * sc;
    const entry = sl.rec === ENTRY_SLOT;
    const rec = entry ? null : sl.rec;
    const ox = Math.cos(yaw), oz = -Math.sin(yaw);
    let kind;
    if (entry) kind = entranceKind(b);
    else if (rec) kind = rec.kind;
    else if (retail) kind = synthKind(x, z, 19);
    else kind = 'blank';
    // A unit the survey put on the wall rather than in it: a vending machine, an ATM, a
    // payphone. OSM files all three as premises; on the street they are objects, so they get the
    // object and the frontage carries on past them as if they were not there.
    if (kind === 'fixture') {
      const v = rec ? rec.value : '';
      if (signsOnly) {
        // nothing to letter on a vending machine
      } else if (v === 'vending_machine' || v === 'parcel_locker') {
        const px = x + ox * 0.46, pz = z + oz * 0.46;
        const py = reserve(C, 'vendingMachine', px, pz, 0.55, 0.3);
        if (isNum(py)) appendVendingMachine(C.mb.props, C.rng, px, py + kerbSeat(C, px, pz), pz, yaw);
      } else if (v === 'telephone') {
        const px = x + ox * 0.40, pz = z + oz * 0.40;
        const py = reserve(C, 'payphone', px, pz, 0.45, 0.3);
        if (isNum(py)) appendPayphone(C.mb.props, px, py + kerbSeat(C, px, pz), pz, yaw);
      } else {
        setMat(mb, b.mat);
        appendWallFixture(mb, null, x, sill, z, yaw, v, b.mat, null);
      }
      if (!signsOnly) F.fixtures++;
      kind = retail ? synthKind(x, z, 23) : 'blank';
      opts.name = '';
      opts.house = '';
      opts.brand = '';
    } else {
      opts.name = fasciaName(kind, rec ? rec.name : '', x, z);
      // The building's own street number goes on its front door; a unit's own number, where the
      // survey has one, wins on that unit.
      opts.house = rec ? rec.house : ((entry || (i === 0 && retail)) ? b.hn : '');
      opts.brand = rec ? rec.brand : '';
    }
    opts.kind = kind;
    opts.endL = true;
    opts.endR = i === n - 1;
    if (!signsOnly) setMat(mb, b.mat);
    appendUnitFront(mb, null, x, sill, z, yaw, w, H, b.mat, opts);
    if (signsOnly) continue;
    F.units++;
    if (rec) F.unitsSurveyed++;
    // appendUnitFront needs 1.6 m of clear frontage inside the party pilasters before it will
    // hang a door; anything narrower is a shopfront with no way in, which is what the audit
    // below counts.
    const st0 = unitStyle(kind);
    if (st0.door !== 'none' && w - st0.pil * 2 >= 1.6) doors++;
    const trades = !NON_TRADE[kind];
    if (trades) F.unitsRetail++;
    F.frontageM += w;

    // THE LIGHT A LIT SHOP THROWS ON THE PAVEMENT. The glazing already carries the room behind it
    // as an emissive pane, but an emissive surface only glows — it puts nothing on the ground in
    // front of it, and a street of glowing windows over black pavement is exactly what a Toronto
    // night is not. A unit whose interior material is a genuine emitter (>= EMITTER_MIN, the same
    // threshold the audit uses) gets one 'shop' light just outside its glass. The renderer decides
    // WHEN it is on (CONTRACT Amendment 7); this only says a lit room is here.
    if (st0.glaz > 0.30 && st0.glass && st0.glass[3] >= EMITTER_MIN && w >= 2.6) {
      const d = st0.proj + 0.85;
      noteLight(C, 'shop', x + ox * d, sill + Math.min(2.6, H * 0.62), z + oz * d);
    }

    // What spills onto the sidewalk in front of it, by TRADE rather than by dice: a restaurant
    // has a patio and a cafe has a board, an office lobby has neither.
    const st = st0;
    if (st.patio > 0 && w > 5.0 && hashPos(x, z, 61) < st.patio) {
      const px = x + ox * 2.5, pz = z + oz * 2.5;
      const py = reserve(C, 'patioSet', px, pz, 1.5, 0.4);
      if (isNum(py)) appendPatioSet(C.mb.props, C.rng, px, py + kerbSeat(C, px, pz), pz, yaw);
    }
    if ((kind === 'food' || kind === 'bar' || kind === 'grocery' || kind === 'goods') &&
      hashPos(x, z, 67) < 0.34) {
      const px = x + ox * 1.5, pz = z + oz * 1.5;
      const py = reserve(C, 'sandwichBoard', px, pz, 0.45, 0.3);
      if (isNum(py)) appendSandwichBoard(C.mb.props, C.rng, px, py + kerbSeat(C, px, pz), pz, yaw);
    }
    // One crowd anchor per RETAIL_ANCHOR metres of shopfront, not one per unit: the people pass
    // draws a figure per anchor, and anchoring per unit would put six of them outside every
    // eight-metre cafe.
    if (trades) {
      anchor += w;
      while (anchor >= RETAIL_ANCHOR) {
        anchor -= RETAIL_ANCHOR;
        C.retail.push({ x, z, yaw, len: Math.min(w, RETAIL_ANCHOR) });
      }
    }
  }
  if (signsOnly) return 0;
  if (retail) F.shopfronts++;
  F.faces++;
  F.groundFloors++;
  return doors;
}

/**
 * The signage pass: the same block face, the same units, the same fascias — lettering only.
 *
 * Everything it reads is a pure function of the building record and the street index, and every
 * appearance decision inside appendUnitFront is hashed on world position, so this lands on
 * exactly the boards the detail stage built. It is a separate tile stage because a shop name
 * stops being readable at 150 m and the geometry is dead weight past there.
 */
function buildSignage(C, b) {
  if (!b.parts || b.h < 3.2 || b.landmark === 'cn') return;
  if (!findFrontage(C, b)) return;
  storeyModel(b);
  if (Math.min(b.frontLen - 0.9, 24) < 1.8) return;
  const nf = collectFrontages(C, b, _fronts);
  if (!nf) return;
  assignUnits(b, _fronts);
  for (let f = 0; f < nf; f++) {
    const fr = _fronts[f];
    fr.retail = frontageRetail(C, b, fr) && (f < 2 || fr.units.length > 0);
  }
  for (let f = 0; f < nf; f++) buildFrontage(C, b, _fronts[f], f === 0, true);
}

/**
 * The CORNER ENTRANCE. Two street-facing elevations that meet at a real angle get a splayed door
 * on the corner when the survey puts a unit within CORNER_UNIT_R of the shared vertex, or — where
 * the survey is silent — when the corner is a retail corner at a junction of two named streets.
 * @returns {boolean} whether one was built
 */
function buildCornerEntrance(C, b, fronts) {
  const part = b.mainPart;
  if (!part || fronts.length < 2) return false;
  const co = part.outer;
  const n = co.length;
  for (let p = 0; p < fronts.length; p++) {
    for (let q = 0; q < fronts.length; q++) {
      if (p === q) continue;
      const A = fronts[p], B = fronts[q];
      // B must follow A round the ring, so they share A's far vertex.
      if ((A.i + 2) % n !== B.i) continue;
      if (A.len < CORNER_MIN_LEN || B.len < CORNER_MIN_LEN) continue;
      const cx = A.bx, cz = A.bz;
      // Two elevations that are nearly parallel are a jog in the wall, not a corner.
      const dot = A.nu * B.nu + A.nv * B.nv;
      if (dot > 0.72 || dot < -0.72) continue;
      let want = false;
      for (let k = 0; k < A.units.length; k++) {
        if (Math.hypot(A.units[k].x - cx, A.units[k].z - cz) < CORNER_UNIT_R) { want = true; break; }
      }
      for (let k = 0; !want && k < B.units.length; k++) {
        if (Math.hypot(B.units[k].x - cx, B.units[k].z - cz) < CORNER_UNIT_R) { want = true; break; }
      }
      if (!want && A.retail && B.retail && hashPos(cx, cz, 73) < 0.55) want = true;
      if (!want) continue;
      const H = clamp(b.groundH, 2.8, Math.min(6.4, Math.max(2.8, b.h - 0.4)));
      const y = C.groundY(cx, cz) + ROAD_Y + CURB * 0.55;
      setMat(C.mb.buildings, b.mat);
      const kind = (A.units.length ? A.units[A.units.length - 1].kind : 0) ||
        (B.units.length ? B.units[0].kind : 0) || synthKind(cx, cz, 29);
      const got = appendCornerEntrance(C.mb.buildings, null, cx, y, cz, A.yaw, B.yaw, H, b.mat,
        { kind, width: clamp(Math.min(A.len, B.len) * 0.34, 1.6, 3.4) });
      if (got > 0) { C.stats.facades.corners++; return true; }
    }
  }
  return false;
}

/**
 * The whole ground-floor and articulation treatment for one building: every street-facing
 * elevation subdivided into units and built from the survey, a corner entrance where one belongs,
 * balcony bands on residential towers, cornices and string courses on masonry, a fire escape on
 * older brick, a loading dock on service stock, and a parapet on anything tall.
 */
function buildFacade(C, b) {
  if (!b.parts || b.h < 3.2) return;
  if (!findFrontage(C, b)) return;
  const mb = C.mb.buildings;
  const rng = C.rng;
  const F = C.stats.facades;
  const yaw = b.frontYaw;
  const wall = Math.min(b.frontLen - 0.9, 24);
  if (wall < 1.8) return;
  storeyModel(b);

  // Audit: the frontage normal must genuinely leave the building. A door on an inward normal is
  // emitted inside the extrusion, where back-face culling hides it completely.
  if (partContains(b.mainPart, b.frontX + b.frontNU * 1.2, -b.frontZ + b.frontNV * 1.2)) {
    C.stats.facadesFacingIn++;
  }

  // --- the block face: EVERY street-facing elevation, along its whole length ------------------
  // What the previous single-frontage pass would have treated: ONE edge, capped at 24 m. Kept as
  // a measurement so the change is a number rather than a claim.
  F.frontageMBefore += wall;
  const nf = collectFrontages(C, b, _fronts);
  if (nf) {
    const placed = assignUnits(b, _fronts);
    if (b.units && b.units.length) {
      F.unitsAvailable += b.units.length;
      F.unitsMatched += placed;
      F.unitsMerged += unitsMergedLast();
      F.buildingsSurveyed++;
    }
    // Retail wraps a corner, it does not wrap a building. The two elevations nearest the street
    // can be shops; a third or fourth is a lane, a service court or a rear elevation, and it gets
    // shops only where the survey actually put premises on it.
    for (let f = 0; f < nf; f++) {
      const fr = _fronts[f];
      fr.retail = frontageRetail(C, b, fr) && (f < 2 || fr.units.length > 0);
    }
    // Corner first, so it owns the corner and the two block faces meet it rather than run
    // through it. Both elevations then keep their end margin clear of the splay.
    let doors = buildCornerEntrance(C, b, _fronts) ? 1 : 0;
    for (let f = 0; f < nf; f++) doors += buildFrontage(C, b, _fronts[f], f === 0, false);
    if (nf > 1) F.multiFace++;
    // CONTRACT §6.2: every building gets at least one entrance on a street-facing elevation.
    F.doors += doors;
    if (doors === 0) F.noDoor++;
  }
  const floorH = clamp(b.groundH, 2.7, Math.min(6.4, Math.max(2.7, b.h - 0.4)));

  // --- residential balcony bands ------------------------------------------------------------
  if (b.profile === 2 && b.h >= 32 && wall >= 6) {
    // Banded on the REAL floor-to-floor where the survey has one, so a condo's balconies line up
    // with its storeys instead of with an average.
    const step = clamp(b.storeyH, 2.7, Math.max(3.1, (b.h - 10) / BALCONY_MAX));
    const faces = (b.h >= 95 && pickEdge(b, -b.frontNU, -b.frontNV, 6)) ? 2 : 1;
    const bx = BACK_EDGE.x, bz = BACK_EDGE.z, byaw = BACK_EDGE.yaw, blen = BACK_EDGE.len;
    for (let f = 0; f < faces; f++) {
      const fx = f === 0 ? b.frontX : bx;
      const fz = f === 0 ? b.frontZ : bz;
      const fy = f === 0 ? yaw : byaw;
      const fw = Math.min(f === 0 ? wall : blen - 0.9, 30) - 0.7;
      if (fw < 4) continue;
      let n = 0;
      for (let v = b.y + floorH + 2.2; v < b.y + b.h - 3.0 && n < BALCONY_MAX; v += step) {
        appendBalconyBand(mb, fx, v, fz, fy, fw, 1.8, b.mat, { ends: true });
        n++;
      }
      F.balconyBands += n;
    }
  }

  // --- masonry articulation -----------------------------------------------------------------
  const masonry = b.cls === 'brick' || b.cls === 'stone' || b.cls === 'limestone' ||
    b.cls === 'stucco' || b.cls === 'granite';
  let corniced = false;
  if (masonry && b.h >= 7 && b.h <= 48 && wall >= 3.5) {
    corniced = true;
    appendCornice(mb, b.frontX, b.y + b.h - 0.95, b.frontZ, yaw, wall,
      clamp(b.h * 0.022, 0.34, 0.80), b.mat, { ends: true });
    F.cornices++;
    if (b.h > 11.5) {
      appendStringCourse(mb, b.frontX, b.y + floorH + 0.35, b.frontZ, yaw, wall, b.mat,
        { h: 0.26, proj: 0.11 });
      F.stringCourses++;
    }
  }
  if (b.cls === 'brick' && b.h >= 9.5 && b.h <= 32 && rng() < 0.26 &&
    pickEdge(b, -b.frontNU, -b.frontNV, 3.4)) {
    // Landings on the building's REAL floor-to-floor, so the escape lines up with the windows
    // it serves rather than with a 3.4 m guess.
    const st = clamp(b.storeyH, 2.7, 4.6);
    const floors = clamp(Math.round((b.h - floorH) / st), 1, 6);
    appendFireEscape(mb, rng, BACK_EDGE.x, C.groundY(BACK_EDGE.x, BACK_EDGE.z) + floorH - 0.6, BACK_EDGE.z,
      BACK_EDGE.yaw, Math.min(BACK_EDGE.len - 0.6, 3.6), floors, b.mat, { storey: st });
    F.fireEscapes++;
  }
  if ((b.profile === 0 || b.profile === 4) && b.h >= 5 && b.area > 400 &&
    pickEdge(b, -b.frontNU, -b.frontNV, 5.0)) {
    appendLoadingDock(mb, BACK_EDGE.x, C.groundY(BACK_EDGE.x, BACK_EDGE.z) + ROAD_Y, BACK_EDGE.z, BACK_EDGE.yaw,
      Math.min(BACK_EDGE.len - 1.2, 7.0), b.mat, {});
    F.loadingDocks++;
  }
  // A parapet and a cornice occupy the same 1 m of wall; a masonry building gets the cornice.
  if (b.h >= 38 && wall >= 3.5 && !corniced) {
    appendParapet(mb, b.frontX, b.y + b.h, b.frontZ, yaw, wall, 1.05, b.mat, {});
    F.parapets++;
  }
}

export { buildFrontage, buildSignage, buildFacade };
