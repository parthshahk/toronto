// src/world/surveyed.js — the street furniture that is where it really is.
//
// CONTRACT.md Amendment 9 and Amendment 11.1. Moved out of city.js unchanged.
//
// data/toronto.json carries 21,974 standalone OSM NODES in local metres — trees, crossings, bike
// stands, benches, lamps, hydrants, bins, signals, transit stops, postboxes, bollards, fountains
// and billboards. Everything here puts them where the survey says they are, and SUPPRESSES the
// procedural pass in world/furniture.js wherever it does, so the two never appear side by side.
//
// The procedural pass is kept rather than replaced because the survey covers a fraction of the
// map, and a street that suddenly loses its lamps is worse than a street lit on a metronome.
//
//   POI_PLACE / POI_SUPPRESS   the registry: kind -> how it is placed, and what it displaces.
//   placeSurveyedFurniture()   one pass over the node list.
//   placeSurveyedCrossings()   surveyed crossings, painted onto the carriageway they cross.
//   surveyCovers()             the predicate world/furniture.js asks before placing anything.

import { clamp, TAU } from '../core/math.js';
import { isNum, hashPos } from '../core/util.js';
import {
  appendBench, appendLitterBin, appendBollard, appendHydrant, appendMailbox,
  appendParkingMachine, appendSignPost, appendStreetTree, appendUtilityBox,
  appendSubwayEntrance, appendStopFlag, appendDrinkingFountain, appendBillboard, appendAdColumn,
  appendBikeCorral, appendUtilityPole, appendFountainBasin, appendFlagPole,
} from '../props/index.js';
import { M, setMat, SIGN_CLASS } from '../city/materials.js';
import { EPS } from './ground.js';
import { inAcornZone, kerbSeat, lampAcorn, lampCobra, lampPedestrian, nearestRoadRec, reserve } from './context.js';
import { recSample } from './roads.js';
import { emitStripe, ZEBRA_BAR, ZEBRA_GAP } from './markings.js';

/* =========================================== surveyed street furniture == */
//
// data/toronto.json now carries 21,974 standalone OSM NODES in local metres — 8,032 trees, 3,717
// crossings, 2,000 bike parking stands, 1,862 benches, 1,403 street lamps, 1,142 hydrants, 842
// bins, 573 signals, and the transit stops, postboxes, bollards, fountains and billboards between
// them. Everything below puts them where they REALLY ARE. The procedural pass that used to place
// all of it on a fixed pitch is kept, because the survey covers a fraction of the map and a
// street that suddenly loses its lamps is worse than a street lit on a metronome — but it is
// SUPPRESSED wherever the survey speaks, so the two never appear side by side and the seam
// between them is not visible (CONTRACT Amendment 9).

// kind -> how the class is placed. `prop` is the counter name (and the PROP_H entry that decides
// whether it fits under a deck), `r` its occupancy radius, `road` the carriageway pad (negative
// for the classes that legitimately stand on one).
const POI_PLACE = {
  tree: { prop: 'streetTree', r: 1.25, road: 0.5 },
  lamp: { prop: 'pedestrianLamp', r: 0.85, road: 0.35 },
  bench: { prop: 'bench', r: 1.10, road: 0.35 },
  bin: { prop: 'litterBin', r: 0.70, road: 0.35 },
  recycling: { prop: 'litterBin', r: 0.70, road: 0.35 },
  hydrant: { prop: 'hydrant', r: 0.42, road: 0.35 },
  bikepark: { prop: 'bikeRing', r: 0.85, road: 0.35 },
  bikeshare: { prop: 'bikeRing', r: 1.60, road: 0.35 },
  postbox: { prop: 'mailbox', r: 0.60, road: 0.35 },
  bollard: { prop: 'bollard', r: 0.35, road: -1 },
  cabinet: { prop: 'utilityBox', r: 0.90, road: 0.35 },
  flagpole: { prop: 'flagPole', r: 0.55, road: 0.35 },
  water: { prop: 'drinkingFountain', r: 0.45, road: 0.35 },
  fountain: { prop: 'fountainBasin', r: 1.80, road: 0.6 },
  billboard: { prop: 'billboard', r: 1.20, road: 0.5 },
  adcolumn: { prop: 'adColumn', r: 0.80, road: 0.4 },
  pole: { prop: 'utilityPole', r: 0.55, road: 0.35 },
  busstop: { prop: 'stopFlag', r: 0.50, road: 0.30 },
  tramstop: { prop: 'stopFlag', r: 0.50, road: -1 },
  subway: { prop: 'subwayEntrance', r: 2.60, road: 0.8 },
};

// How far a surveyed item of a class reaches when it silences the procedural pass. Roughly the
// pitch the procedural pass uses for that class, so one surveyed lamp switches off the metronome
// lamp that would have stood where it does and no further.
const POI_SUPPRESS = {
  lamp: 24, tree: 13, bench: 12, bin: 14, hydrant: 26, bikepark: 12, postbox: 34,
  cabinet: 17, bollard: 9, flagpole: 22,
};

/** Is there a surveyed item of `kind` within `r` of (x, z)? */
function surveyedNear(C, kind, x, z, r) {
  const idx = C.poiIdx;
  if (!idx || !(r > 0)) return false;
  const r2 = r * r;
  let hit = false;
  idx.query(x, z, r, (p) => {
    if (hit || p.k !== kind) return;
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz < r2) { hit = true; return false; }
  });
  return hit;
}

/** The procedural pass asks this before every item it would place on a fixed pitch. */
function surveyCovers(C, cls, x, z) {
  const r = POI_SUPPRESS[cls];
  return r ? surveyedNear(C, cls, x, z, r) : false;
}

// Yaw for a surveyed item: it should face the street it stands beside, which is the direction
// from the nearest carriageway centreline out to the item.
function poiYaw(C, x, z) {
  let best = 30 * 30;
  let bx = 0, bz = 0, got = false;
  C.roadIdx.query(x, z, 30, (sg) => {
    const dx = sg[2] - sg[0], dz = sg[3] - sg[1];
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - sg[0]) * dx + (z - sg[1]) * dz) / l2, 0, 1);
    const qx = sg[0] + dx * t, qz = sg[1] + dz * t;
    const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 < best) { best = d2; bx = x - qx; bz = z - qz; got = true; }
  });
  if (!got) return hashPos(x, z, 91) * TAU - Math.PI;
  const l = Math.hypot(bx, bz);
  if (!(l > EPS)) return hashPos(x, z, 91) * TAU - Math.PI;
  // props.js: local +X points along (cos yaw, -sin yaw), and "out" for a kerbside prop is away
  // from the carriageway.
  return Math.atan2(-bz / l, bx / l);
}

/**
 * Build one tile's worth of surveyed furniture. Runs BEFORE the procedural pass so the real
 * positions claim their sites first and the fixed-pitch pass fills only what is left.
 */
function placeSurveyedFurniture(C, list) {
  if (!list || !list.length) return;
  const mbP = C.mb.props;
  const rng = C.rng;
  const S = C.stats.survey;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const spec = POI_PLACE[p.k];
    if (!spec) continue;
    const x = p.x, z = p.z;
    const y = reserve(C, spec.prop, x, z, spec.r, spec.road);
    if (!isNum(y)) { S.refused++; continue; }
    const base = y + kerbSeat(C, x, z);
    const yaw = poiYaw(C, x, z);
    switch (p.k) {
      case 'tree':
        appendStreetTree(mbP, rng, x, base, z, 0.86 + hashPos(x, z, 11) * 0.55);
        break;
      case 'lamp': {
        // The surveyed node does not say what kind of lamp it is, so the same rule the
        // procedural pass uses decides: a cobra head on an arterial, a pedestrian pole on a side
        // street, an acorn in the heritage districts.
        const rec = nearestRoadRec(C, x, z, 26);
        const heritage = inAcornZone(x, z);
        const arterial = !!rec && (rec.cls === 'major' || rec.cls === 'motorway');
        if (heritage) lampAcorn(C, mbP, x, base, z, 4.6);
        else if (arterial) lampCobra(C, mbP, x, base, z, yaw, 9.6);
        else lampPedestrian(C, mbP, x, base, z, yaw, 5.2);
        break;
      }
      case 'bench':
        appendBench(mbP, x, base, z, yaw);
        C.benches.push({ x, y: base, z, yaw });
        break;
      case 'bin':
      case 'recycling':
        appendLitterBin(mbP, x, base, z, yaw);
        break;
      case 'hydrant':
        appendHydrant(mbP, x, base, z, yaw);
        break;
      case 'bikepark':
        appendBikeCorral(mbP, x, base, z, yaw + Math.PI * 0.5,
          1 + Math.floor(hashPos(x, z, 13) * 2));
        break;
      case 'bikeshare':
        appendBikeCorral(mbP, x, base, z, yaw + Math.PI * 0.5, 4);
        appendParkingMachine(mbP, x + Math.cos(yaw) * 0.1, base, z - Math.sin(yaw) * 0.1, yaw);
        break;
      case 'postbox':
        appendMailbox(mbP, x, base, z, yaw);
        break;
      case 'bollard':
        appendBollard(mbP, x, base, z);
        break;
      case 'cabinet':
        appendUtilityBox(mbP, rng, x, base, z, yaw);
        break;
      case 'flagpole':
        appendFlagPole(mbP, x, base, z, 7 + hashPos(x, z, 17) * 6);
        break;
      case 'water':
        appendDrinkingFountain(mbP, x, base, z, yaw);
        break;
      case 'fountain':
        appendFountainBasin(mbP, x, base, z, 1.2 + hashPos(x, z, 19) * 1.1);
        break;
      case 'billboard':
        appendBillboard(mbP, rng, x, base, z, yaw);
        break;
      case 'adcolumn':
        appendAdColumn(mbP, x, base, z);
        break;
      case 'pole':
        appendUtilityPole(mbP, x, base, z, yaw, 8.5 + hashPos(x, z, 23) * 2.5);
        break;
      case 'busstop':
      case 'tramstop':
        appendStopFlag(mbP, x, base, z, yaw, stopLabel(p), { font: C.font, textMb: C.mb[SIGN_CLASS] });
        // The people pass reads a station's frame, not just its position: a flag is a 0.4 m post
        // rather than a 16 m shelter, so the queue beside it is short.
        C.stations.push({ x, y: base, z, yaw, len: 1.2 });
        if (p.n) C.stats.facades.textBlades++;
        break;
      case 'subway':
        appendSubwayEntrance(mbP, x, base, z, yaw, p.n || '',
          { font: C.font, textMb: C.mb[SIGN_CLASS] });
        break;
      default:
        break;
    }
    S.placed++;
    S.byKind[p.k] = (S.byKind[p.k] || 0) + 1;
  }
}

// A route number for a stop flag. OSM gives a stop a NAME ("King St West at Spadina Ave"), which
// is far too long for a 340 mm flag; what is actually printed on one is the route number, so the
// digits are taken from the name where it has them and the flag is left blank otherwise.
function stopLabel(p) {
  const n = typeof p.n === 'string' ? p.n : '';
  const m = n.match(/\b(\d{1,3}[A-Z]?)\b/);
  return m ? m[1] : '';
}

/**
 * Mid-block crossings, from the 3,717 surveyed highway=crossing nodes. The junction pass already
 * paints every crossing at an intersection; these are the ones between them — the pedestrian
 * crossovers on Queen, King and College that are a genuine Toronto street feature and were
 * simply absent.
 */
function placeSurveyedCrossings(C, list) {
  if (!list || !list.length) return;
  const mb = C.mb.roads;
  const S = C.stats.survey;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.k !== 'crossing') continue;
    S.crossingNodes++;
    const rec = nearestRoadRec(C, p.x, p.z, 16);
    if (!rec || rec.bridge || rec.foot || rec.cls === 'motorway' || rec.hw < 3.2) {
      S.crossingsOffRoad++;
      continue;
    }
    const st = recStation(rec, p.x, p.z);
    if (!isNum(st.s) || Math.abs(st.off) > rec.hw + 3.0) { S.crossingsOffRoad++; continue; }
    // Not on top of a junction: those are painted from the junction geometry, and painting them
    // twice is a z-fight with itself.
    let near = false;
    for (let k = 0; k < rec.junc.length; k++) {
      if (Math.abs(rec.junc[k].s - st.s) < rec.junc[k].r + 6.5) { near = true; break; }
    }
    if (near) { S.crossingsAtJunction++; continue; }
    const hw = rec.hw;
    const half = 1.55;
    if (st.s < half + 1 || st.s > rec.len - half - 1) continue;
    setMat(mb, M.paintWhite);
    let u = -hw + 0.35;
    let bars = 0;
    while (u + ZEBRA_BAR < hw - 0.35) {
      C.stats.ground.markings += emitStripe(C, rec, st.s - half, st.s + half, u, u + ZEBRA_BAR);
      u += ZEBRA_BAR + ZEBRA_GAP;
      bars++;
    }
    if (!bars) continue;
    C.stats.ground.crosswalks++;
    S.crossings++;
    // The pedestrian crossover's own pair of illuminated X signs, one each side.
    for (let d = 0; d < 2; d++) {
      const sg = d === 0 ? 1 : -1;
      const m = recSample(rec, st.s);
      const px = m.x + m.sx * (hw + 1.5) * sg;
      const pz = m.z + m.sz * (hw + 1.5) * sg;
      const y = reserve(C, 'signPost', px, pz, 0.5, 0.3);
      if (!isNum(y)) continue;
      appendSignPost(C.mb.props, C.rng, px, y + kerbSeat(C, px, pz), pz,
        Math.atan2(m.sz * sg, -m.sx * sg), null);
    }
  }
}

/** Station and signed offset of a point against a road record's centreline. */
const _station = { s: 0, off: 0, d: 0 };
function recStation(rec, x, z) {
  let best = Infinity;
  _station.s = NaN;
  _station.off = 0;
  for (let k = 1; k < rec.pts.length; k++) {
    const a = rec.pts[k - 1], b = rec.pts[k];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    if (!(l2 > EPS)) continue;
    const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
    const qx = a[0] + dx * t, qz = a[1] + dz * t;
    const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 >= best) continue;
    best = d2;
    const l = Math.sqrt(l2);
    _station.s = rec.s[k - 1] + t * l;
    _station.off = ((x - qx) * (-dz / l) + (z - qz) * (dx / l));
    _station.d = Math.sqrt(d2);
  }
  return _station;
}

export { surveyCovers, placeSurveyedFurniture, placeSurveyedCrossings, recStation };
