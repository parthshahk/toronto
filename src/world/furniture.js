// src/world/furniture.js — the procedural street furniture pass: what goes along a kerb line.
//
// CONTRACT.md §6.3, §6.4 and Amendment 11.1. Moved out of city.js unchanged.
//
// Every generator here walks the SAME kerb line, and they only avoid each other because they all
// go through the occupancy grid in world/context.js and because `phase` staggers their stations —
// a bin, a bench and a bike ring on one street start at different offsets rather than fighting
// over the same square metre. Spacings are metres along the kerb, per side unless a comment says
// otherwise, and every one of them is a DENSITY dial: CONTRACT §6.4 says a tight budget costs
// spacing, never quality, so sparse good lamps beat dense bad ones.
//
// This pass is SUPPRESSED wherever the survey speaks — see world/surveyed.js — so a street the
// OSM node extract covers gets its real furniture and a street it does not still gets lit.
//
// Nothing here bakes light (CONTRACT §7.1). A lamp is emissive because it is a lamp; the renderer
// decides when it is on.

import { isNum, sgn, hashPos } from '../core/util.js';
import {
  appendBench, appendLitterBin, appendBikeRing, appendBollard, appendPlanter, appendHydrant,
  appendMailbox, appendNewsBox, appendParkingMachine, appendStreetTree, appendManhole,
  appendGrate, appendUtilityBox,
} from '../props/index.js';
import { CURB, GUTTER_LIFT, SIDEWALK_W } from './ground.js';
import {
  DECK_CLEAR, DECK_EDGE_INSET, DECK_LAMP_H, LAMP_OVER, UNDER_DECK_MIN,
  deckHeadroom, deckHeadroomAt, inFootprint, kerbSeat, lampAcorn, lampCobra, lampPedestrian,
  noteProp, reserve,
} from './context.js';
import { recSample, surfaceY } from './roads.js';
import { surveyCovers } from './surveyed.js';

/* ------------------------------------------------- street-detail tunables -- */
// Spacings are metres along the KERB, per side unless the comment says otherwise. Everything
// here is a density dial: CONTRACT §6.4 says a tight budget costs spacing, never quality.




const LAMP_SPACING = { motorway: 55, major: 28, minor: 40 };
const ACORN_SPACING = 55;
// Pedestrian streets and squares. Tighter than a side street's 40 m because the post is short and
// the whole width is walked, so the pools have to overlap rather than merely dot the route.
const PED_LAMP_SPACING = 32;
const TREE_SPACING = 54;
const BIN_SPACING = 260;
const BENCH_SPACING = 430;
const RING_SPACING = 280;
const HYDRANT_SPACING = 210;
const PLANTER_SPACING = 390;
const METER_SPACING = 340;
const NEWSBOX_SPACING = 380;
const MAILBOX_SPACING = 520;
const CABINET_SPACING = 330;
const MANHOLE_SPACING = 280;
const GRATE_SPACING = 420;
/**
 * Street lighting for an elevated carriageway, standing on the deck itself.
 *
 * These are not ground props: they do not take a terrain height, they are not in the occupancy
 * grid (which is a plan grid and would have them fighting whatever stands on the ground 8 m
 * below), and they are not audited against building footprints, for the same reason the roofscape
 * is not. They ARE audited against decks above them, because the Gardiner's own ramps cross over
 * each other.
 */
function placeDeckLamps(C, rec) {
  if (!rec.bridge || !rec.deck || rec.foot) return;
  const spacing = LAMP_SPACING[rec.cls] || 46;
  if (!(rec.len > spacing * 0.6)) return;
  const mbP = C.mb.props;
  const o0 = Math.max(1.0, rec.hw - DECK_EDGE_INSET);
  const want = DECK_LAMP_H[rec.cls] || 8.0;
  let side = 1;
  for (let s = spacing * 0.5; s < rec.len; s += spacing) {
    const m = recSample(rec, s);
    const sg = side;
    side = -side;
    const o = o0 * sg;
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    const y = surfaceY(C, rec, m, o);
    const top = want + LAMP_OVER.cobraLamp;
    if (deckHeadroomAt(C, x, z, y) < top + DECK_CLEAR) { C.stats.deck.propsSkipped++; continue; }
    // The boom reaches back in over the carriageway, exactly as it does at grade.
    const yaw = Math.atan2(m.sz * sg, -m.sx * sg);
    const tipX = x + Math.cos(yaw) * 3.3, tipZ = z - Math.sin(yaw) * 3.3;
    if (Math.hypot(tipX - m.x, tipZ - m.z) >= Math.hypot(x - m.x, z - m.z)) C.stats.boomsMisaimed++;
    lampCobra(C, mbP, x, y, z, yaw, want);
    noteProp(C, 'cobraLamp');
    C.stats.deck.deckLamps++;
    C.auditDeck.push(x, z, y, top);
  }
}

/* =============================================================== furniture == */

// Every generator below walks the same kerb line. `phase` staggers them so a bin, a bench and a
// tree never arrive at the same metre, and the occupancy grid catches whatever still collides.
function placeFurniture(C, rec) {
  const cls = rec.cls;
  const mbP = C.mb.props;
  const hw = rec.hw;
  const rng = C.rng;
  const heritage = rec.heritage;

  /* --- lighting: cobra heads on the arterials, pedestrian poles on the side streets --- */
  // An elevated carriageway is lit from its own deck, not from the ground eight metres below it.
  if (rec.bridge) { placeDeckLamps(C, rec); return; }

  // A PEDESTRIAN STREET IS STILL LIT. `LAMP_SPACING` had no 'pedestrian' entry, so every
  // pedestrianised way in the city — Trinity Street and the Distillery lanes, the Queens Quay
  // promenade, the Kensington closures, every square and mews — fell out of this branch entirely
  // and got no luminaire of any kind. At night those became the darkest ground in the world while
  // the shops either side of them glowed, which is the exact inverse of what they look like. They
  // are lit from posts at pedestrian scale, so they get the pitch a footway gets, not an
  // arterial's.
  //
  // 'pedestrian' ONLY, deliberately. The extract also carries 14,185 'foot' ways and 3,289
  // 'service' ways, and neither wants this: a footway is the pavement beside a carriageway that
  // is already lit from its own masts, and a service way is a Toronto laneway, which really is
  // unlit. Lighting either would double every arterial's lamps and put a post down every alley.
  const pedWay = cls === 'pedestrian';
  const spacing = pedWay ? PED_LAMP_SPACING : (heritage ? ACORN_SPACING : LAMP_SPACING[cls]);
  if (spacing && rec.len > spacing * 0.6) {
    // On a carriageway the post stands BEYOND the kerb, on the pavement. On a pedestrian street
    // there is no carriageway to stand clear of and the whole width is walked, so the post sits
    // just inside the edge — pushing it out by 1.55 m there would plant it in the shopfronts.
    const kerb = pedWay ? Math.max(0.9, hw - 0.75) : hw + 1.55;
    let side = 1;
    for (let s = spacing * 0.5; s < rec.len; s += spacing) {
      const m = recSample(rec, s);
      const o = kerb * side;
      side = -side;
      const x = m.x + m.sx * o, z = m.z + m.sz * o;
      // THE METRONOME STOPS WHERE THE SURVEY STARTS. 1,403 lamp positions are real; on the
      // streets they cover, the fixed pitch would put a second mast between every pair of them.
      if (surveyCovers(C, 'lamp', x, z)) { C.stats.survey.suppressed++; continue; }
      let kind = heritage ? 'acornLamp'
        : ((cls === 'minor' || pedWay) ? 'pedestrianLamp' : 'cobraLamp');
      let mast = heritage ? 4.6
        : ((cls === 'minor' || pedWay) ? 5.2 : (cls === 'motorway' ? 12.0 : 9.6));
      let over = LAMP_OVER[kind];
      // Under a deck the fixture is not skipped, it is SHORTENED: the real Lake Shore runs low
      // mast lighting under the Gardiner, and a dark street under an expressway is its own bug.
      const head = deckHeadroom(C, x, z);
      if (head < mast + over + DECK_CLEAR) {
        kind = 'pedestrianLamp';
        over = LAMP_OVER.pedestrianLamp;
        const fit = head - DECK_CLEAR - CURB - over;
        if (fit < UNDER_DECK_MIN) { C.stats.deck.propsSkipped++; continue; }
        mast = Math.min(mast, fit);
        C.stats.deck.propsShortened++;
      }
      // roadPad -1 on a pedestrian street: reserve() refuses any site that lands ON a carriageway,
      // and a pedestrianised way is still a carriageway RECORD, so every post along one was being
      // refused by the test meant to keep masts out of traffic. There is no traffic to keep them
      // out of here — the paved width IS the walking surface — so the test is skipped, exactly as
      // it is for the other props that legitimately stand on a roadway.
      const y = reserve(C, kind, x, z, 0.85, pedWay ? -1 : 0.35, mast + over);
      if (!isNum(y)) continue;
      const base = y + kerbSeat(C, x, z);
      if (kind === 'acornLamp') { lampAcorn(C, mbP, x, base, z, mast); continue; }
      // The boom reaches from the kerb back out over the carriageway.
      const sg = o < 0 ? -1 : 1;
      const yaw = Math.atan2(m.sz * sg, -m.sx * sg);
      // Audit: the boom tip must end up nearer the carriageway centre than the mast, or the whole
      // city has its lamps hanging over the shopfronts.
      const tipX = x + Math.cos(yaw) * 3.3, tipZ = z - Math.sin(yaw) * 3.3;
      if (Math.hypot(tipX - m.x, tipZ - m.z) >= Math.hypot(x - m.x, z - m.z)) C.stats.boomsMisaimed++;
      if (kind === 'pedestrianLamp') lampPedestrian(C, mbP, x, base, z, yaw, mast);
      else lampCobra(C, mbP, x, base, z, yaw, mast);
    }
  }

  const sw = SIDEWALK_W[cls] || 0;
  if (!sw) return;

  const zone = hw + 0.25 + sw * 0.34;
  const gutter = hw - 0.40;

  for (let sd = 0; sd < 2; sd++) {
    const sgn = sd === 0 ? 1 : -1;
    const o = zone * sgn;

    // Every piece faces the street: local +X is "out" by the props.js contract, and out of a
    // sidewalk means across the kerb.
    // `survey` is the POI class that OWNS this furniture class. Where a surveyed item of that
    // class is already within its suppression radius, the fixed-pitch pass stands down; the
    // result is that a street the survey reached is furnished from the survey and a street it
    // did not is furnished plausibly, with no visible boundary between them.
    const gen = (kind, pitch, phase, radius, survey, fn) => {
      if (pitch <= 0 || rec.len < pitch * 0.35) return;
      for (let s = phase % pitch; s < rec.len; s += pitch) {
        const m = recSample(rec, s);
        const x = m.x + m.sx * o, z = m.z + m.sz * o;
        if (survey && surveyCovers(C, survey, x, z)) { C.stats.survey.suppressed++; continue; }
        const y = reserve(C, kind, x, z, radius, 0.35);
        if (!isNum(y)) continue;
        C.stats.survey.fallback++;
        fn(x, y + kerbSeat(C, x, z), z, Math.atan2(m.sz * sgn, -m.sx * sgn));
      }
    };

    gen('litterBin', BIN_SPACING, 18 + sd * 47, 0.72, 'bin',
      (x, y, z, yaw) => appendLitterBin(mbP, x, y, z, yaw));
    gen('bench', BENCH_SPACING, 55 + sd * 63, 1.15, 'bench', (x, y, z, yaw) => {
      appendBench(mbP, x, y, z, yaw);
      C.benches.push({ x, y, z, yaw });
    });
    gen('bikeRing', RING_SPACING, 33 + sd * 31, 0.45, 'bikepark',
      (x, y, z, yaw) => appendBikeRing(mbP, x, y, z, yaw));
    gen('hydrant', HYDRANT_SPACING, 12 + sd * 35, 0.42, 'hydrant',
      (x, y, z, yaw) => appendHydrant(mbP, x, y, z, yaw));
    gen('planter', PLANTER_SPACING, 76 + sd * 84, 0.9, '',
      (x, y, z) => appendPlanter(mbP, rng, x, y, z, 1.05 + rng() * 0.5));
    gen('parkingMachine', METER_SPACING, 41 + sd * 56, 0.45, '',
      (x, y, z, yaw) => appendParkingMachine(mbP, x, y, z, yaw));
    gen('newsBox', NEWSBOX_SPACING, 96 + sd * 107, 0.45, '',
      (x, y, z, yaw) => appendNewsBox(mbP, rng, x, y, z, yaw));
    gen('mailbox', MAILBOX_SPACING, 140 + sd * 215, 0.6, 'postbox',
      (x, y, z, yaw) => appendMailbox(mbP, x, y, z, yaw));
    gen('utilityBox', CABINET_SPACING, 118 + sd * 134, 0.9, 'cabinet',
      (x, y, z, yaw) => appendUtilityBox(mbP, rng, x, y, z, yaw));
    if (rec.commercial && cls !== 'minor') {
      gen('streetTree', TREE_SPACING, 9 + sd * 13, 1.30, 'tree',
        (x, y, z) => appendStreetTree(mbP, rng, x, y, z, 0.88 + rng() * 0.5));
    }
    if (cls === 'major' && rec.commercial) {
      gen('bollard', 380, 21 + sd * 19, 0.35, 'bollard', (x, y, z) => appendBollard(mbP, x, y, z));
    }

    // Gutter hardware. The catch basin sits against the kerb face; it and the manhole below are
    // ON the carriageway on purpose, so they take the road surface height, not the sidewalk's.
    // Basins go on the arterials, which is where the gutters that need draining actually are.
    const go = gutter * sgn;
    for (let s = 22 + sd * 32; cls === 'major' && s < rec.len; s += GRATE_SPACING) {
      const m = recSample(rec, s);
      const x = m.x + m.sx * go, z = m.z + m.sz * go;
      if (inFootprint(C, x, z, 0.4) || !C.occ.claim(x, z, 0.5)) continue;
      appendGrate(mbP, x, surfaceY(C, rec, m, go) + GUTTER_LIFT, z,
        Math.atan2(m.sz * sgn, -m.sx * sgn));
      noteProp(C, 'grate');
      C.auditRoad.push(x, z);
    }
  }

  for (let s = 46; s < rec.len; s += MANHOLE_SPACING) {
    const m = recSample(rec, s);
    const o = hw * (hashPos(m.x, m.z, 21) < 0.5 ? -0.45 : 0.45);
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    if (inFootprint(C, x, z, 0.3) || !C.occ.claim(x, z, 0.55)) continue;
    appendManhole(mbP, x, surfaceY(C, rec, m, o) + GUTTER_LIFT, z);
    noteProp(C, 'manhole');
    C.auditRoad.push(x, z);
  }
}

export { LAMP_SPACING, ACORN_SPACING, PED_LAMP_SPACING, placeDeckLamps, placeFurniture };
