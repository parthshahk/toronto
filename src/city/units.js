// src/city/units.js — the block-face model: every street-facing edge, subdivided into premises.
//
// CONTRACT.md §6.2, Amendment 9 and Amendment 11.1. Moved out of city.js unchanged.
//
// THE PROBLEM THIS SOLVES. The facade pass used to treat ONE frontage per building — the single
// footprint edge nearest a road — and cap the treated length at 24 m. A 60 m block face on Queen
// West got one shopfront and 36 m of blank wall, no building had a corner entrance, and whether
// the ground floor was retail at all was decided by the NIGHT-LIGHTING profile, which for most
// buildings had been guessed from height. A condo or office tower with a retail podium — which is
// most of downtown's actual retail — got a lobby door and no shops.
//
// What replaces it: EVERY street-facing edge of the footprint, along its whole length, subdivided
// into UNITS. Where the survey carries units (3,261 buildings, 8,451 units) they go where they
// really are, in order, with the frontage between and around them filled plausibly; where it does
// not, the whole frontage is synthesised from the same table, so the seam is invisible.
//
// Nothing here emits geometry. It produces the LAYOUT — which edges are frontages, how deep the
// storeys are, where each unit starts and ends and what trade it is — and city/frontage.js builds
// it. Every choice is hashed on world position, so a block face looks the same whichever of its
// tiles happen to be resident.

import { clamp } from '../core/math.js';
import { isNum, hashPos } from '../core/util.js';
import { unitKindOf } from './unitkinds.js';
import { EDGE, ringEdge } from '../world/ground.js';
import { nearestRoad, nearestRoadDist, nearestRoadRec } from '../world/context.js';

/* ================================================================= facades == */


/**
 * The street-facing edge of a building: the one whose OUTWARD normal looks at the nearest
 * carriageway. Writes frontX/frontZ/frontYaw/frontLen onto the record.
 * @returns {boolean} false when no road comes within 45 m
 */
function findFrontage(C, b) {
  const part = b.mainPart;
  if (!part) return false;
  const co = part.outer;
  let bestScore = Infinity;
  for (let i = 0; i < co.length; i += 2) {
    if (!ringEdge(part, i)) continue;
    const px = EDGE.mu + EDGE.nu * 3.0;
    const pz = -(EDGE.mv + EDGE.nv * 3.0);
    const d = nearestRoad(C, px, pz, 45);
    if (!isFinite(d)) continue;
    const score = d - Math.min(EDGE.len, 30) * 0.09;
    if (score < bestScore) {
      bestScore = score;
      b.frontX = EDGE.mu;
      b.frontZ = -EDGE.mv;
      b.frontLen = EDGE.len;
      b.frontNU = EDGE.nu;
      b.frontNV = EDGE.nv;
      // facades.js: yaw faces OUT and the outward normal is (cos yaw, 0, -sin yaw); in plan that
      // is (nu, nv), so yaw = atan2(nv, nu).
      b.frontYaw = Math.atan2(EDGE.nv, EDGE.nu);
    }
  }
  return bestScore < Infinity;
}

// The edge that best faces (wantU, wantV) and is at least `minLen` long — the back elevation,
// where fire escapes, loading docks and the second balcony face belong.
const BACK_EDGE = { x: 0, z: 0, yaw: 0, len: 0 };

function pickEdge(b, wantU, wantV, minLen) {
  const part = b.mainPart;
  if (!part) return false;
  const co = part.outer;
  let best = -2, ok = false;
  for (let i = 0; i < co.length; i += 2) {
    const l = ringEdge(part, i);
    if (l < minLen) continue;
    const score = EDGE.nu * wantU + EDGE.nv * wantV + Math.min(l, 24) * 0.012;
    if (score > best) {
      best = score;
      BACK_EDGE.x = EDGE.mu;
      BACK_EDGE.z = -EDGE.mv;
      BACK_EDGE.len = l;
      BACK_EDGE.yaw = Math.atan2(EDGE.nv, EDGE.nu);
      ok = true;
    }
  }
  return ok;
}
/* ================================================== the block-face model == */
//
// THE PROBLEM THIS SOLVES. buildFacade() used to treat ONE frontage per building — the single
// footprint edge nearest a road — and cap the treated length at 24 m. A 60 m block face on Queen
// West got one shopfront and 36 m of blank wall, no building had a corner entrance, and whether
// the ground floor was retail at all was decided by the NIGHT-LIGHTING profile, which for most
// buildings had been guessed from height. A condo or office tower with a retail podium — which is
// most of downtown's actual retail — got a lobby door and no shops.
//
// What replaces it: EVERY street-facing edge of the footprint, along its whole length, subdivided
// into UNITS. Where the survey carries units (3,261 buildings, 8,451 units) they go where they
// really are, in order, with the frontage between and around them filled plausibly; where it does
// not, the whole frontage is synthesised from the same table, so the seam is invisible
// (CONTRACT Amendment 9).

// How far a carriageway may be from an edge and still make it a frontage. Toronto's downtown
// setback is nearly zero on the retail streets and 6-12 m on the residential ones; 34 m also
// picks up the far side of a wide sidewalk and a forecourt without picking up the next street.
const FRONT_ROAD_MAX = 26;
const FRONT_MIN_LEN = 2.4;         // shorter edges are chamfers and light wells, not elevations
const FRONT_MAX_FACES = 3;         // a corner site has two; a mid-block island has three
const FRONT_MAX_TOTAL = 104;       // metres of frontage treated on one building, worst case
const FRONT_END_MARGIN = 0.30;     // the quoin at each end of a block face

// Unit widths. TARGET is the median Toronto storefront: the 1900-1930 commercial stock that
// makes up Queen, King, College and Dundas was subdivided on a 20-25 foot lot.
const UNIT_MIN = 2.7;
const UNIT_MAX = 17.0;
const UNIT_TARGET = 7.8;
// A surveyed unit whose slot would come out wider than this is a POI attached to a long frontage
// rather than a unit filling it; the slot is capped and the rest becomes filler.
const UNIT_SURVEY_MAX = 15.0;
// Two surveyed records closer together than this along the frontage are one premises.
const UNIT_MERGE = 2.4;

// How close two footprint edges' shared vertex has to be to a surveyed unit for that unit to be
// read as a CORNER entrance, and how close the corner has to be to the junction of two streets
// for a synthesised one.
const CORNER_UNIT_R = 3.2;
const CORNER_MIN_LEN = 4.0;

// Metres of shopfront per crowd anchor. The people pass places one figure per anchor with a 42%
// draw, which is the density the old one-anchor-per-building code produced on a typical
// 15-24 m retail building.
const RETAIL_ANCHOR = 16.0;

// Streets whose ground floor is retail almost everywhere, LONGEST PREFIX WINS — which is why
// Queens Quay has to be able to beat Queen. Not decoration: this is the difference between a
// Queen West that is shops and a Queen West that is walls.
const RETAIL_STREETS = [
  ['Queen', 0.42], ['King', 0.38], ['Yonge', 0.46], ['Spadina', 0.36], ['Dundas', 0.38],
  ['College', 0.36], ['Bloor', 0.42], ['Bathurst', 0.26], ['Church', 0.28], ['Front', 0.24],
  ['Adelaide', 0.16], ['Richmond', 0.16], ['Wellington', 0.14], ['Ossington', 0.34],
  ['Parliament', 0.30], ['Gerrard', 0.30], ['Baldwin', 0.34], ['Augusta', 0.36],
  ['Kensington', 0.36], ['Harbord', 0.26], ['Roncesvalles', 0.34], ['Broadview', 0.26],
  ['Danforth', 0.36], ['Queens Quay', 0.18], ['Bay', 0.22], ['Jarvis', 0.14],
  ['Sherbourne', 0.16], ['Carlton', 0.24], ['Elm', 0.22],
];

// Synthesised unit mix, as a cumulative distribution. The weights are the shape of the SURVEY —
// 996 restaurants, 717 fast food, 496 cafes, 280 clothes, 232 vacant, 196 convenience, 181
// hairdressers, 121 banks — so a synthesised block face has the same trade mix as a surveyed one
// and the two cannot be told apart by what is on them.
const SYNTH_MIX = [
  ['food', 0.255], ['goods', 0.145], ['service', 0.115], ['apparel', 0.075],
  ['grocery', 0.070], ['salon', 0.062], ['vacant', 0.055], ['office', 0.050],
  ['bar', 0.044], ['clinic', 0.038], ['culture', 0.030], ['bank', 0.024],
  ['pharmacy', 0.018], ['gym', 0.010], ['hotel', 0.005], ['civic', 0.004],
];

/**
 * What the front door of a building with no shop on it looks like. The old pass took this from
 * the night-lighting profile alone; that is still the best signal available where the survey is
 * silent, but it is now only used for the ONE unit that is the entrance, not for the whole
 * elevation.
 */
function entranceKind(b) {
  if (b.profile === 0 || b.profile === 4) return 'depot';
  if (b.profile === 5) return 'civic';
  if (b.h >= 26) return 'lobby';
  if (b.h <= 13 && b.area < 420) return 'house';
  return 'lobby';
}

// WHAT A SYNTHESISED SHOP CALLS ITSELF. A blank fascia next to a lettered one is the loudest
// possible seam between surveyed and invented (CONTRACT Amendment 9), and inventing business
// names would be worse than a blank board — it would put fiction on a map that is otherwise
// survey. So a unit with no surveyed name gets its TRADE on the fascia, which is what a very
// large share of real Toronto storefronts carry anyway: CONVENIENCE, BARBER, DRY CLEANING,
// PHARMACY, FOR LEASE. No invented identity, no logo, no brand.
const TRADE_WORDS = {
  food: ['CAFE', 'RESTAURANT', 'PIZZA', 'SUSHI', 'DINER', 'BAKERY', 'TAKE-OUT', 'ESPRESSO BAR',
    'NOODLE HOUSE', 'SANDWICHES', 'JUICE BAR', 'BURGERS', 'SHAWARMA', 'TAQUERIA', 'PHO',
    'ROTI SHOP', 'BUBBLE TEA', 'DUMPLINGS', 'BREAKFAST', 'PATISSERIE'],
  bar: ['PUB', 'TAVERN', 'COCKTAIL BAR', 'BREWERY', 'SPORTS BAR', 'LOUNGE', 'WINE BAR'],
  grocery: ['CONVENIENCE', 'VARIETY', 'SUPERMARKET', 'FRESH MARKET', 'GROCERY', 'FRUIT MARKET',
    'SMOKE SHOP', 'CANNABIS', 'BULK FOODS', 'BUTCHER'],
  bank: ['BANK', 'CREDIT UNION', 'CURRENCY EXCHANGE'],
  pharmacy: ['PHARMACY', 'DRUG MART', 'APOTHECARY'],
  clinic: ['DENTAL', 'MEDICAL CLINIC', 'WALK-IN CLINIC', 'OPTICAL', 'PHYSIOTHERAPY',
    'VETERINARY', 'CHIROPRACTIC'],
  salon: ['HAIR SALON', 'BARBER', 'NAILS', 'DAY SPA', 'BEAUTY BAR', 'MASSAGE', 'TATTOO'],
  apparel: ['CLOTHING', 'SHOES', 'VINTAGE', 'MENSWEAR', 'JEWELLERY', 'BOUTIQUE', 'THRIFT',
    'DENIM', 'OUTERWEAR'],
  goods: ['BOOKS', 'HARDWARE', 'FLORIST', 'PET SUPPLY', 'ELECTRONICS', 'GIFTS', 'FURNITURE',
    'BICYCLES', 'RECORDS', 'STATIONERY', 'TOYS', 'ART SUPPLY', 'HOUSEWARES', 'OPTICIAN'],
  service: ['DRY CLEANING', 'LAUNDROMAT', 'PRINT SHOP', 'TAILOR', 'TRAVEL', 'SHOE REPAIR',
    'KEY CUTTING', 'POSTAL OUTLET', 'PHONE REPAIR'],
  office: ['OFFICES', 'LAW OFFICE', 'REAL ESTATE', 'ACCOUNTING', 'INSURANCE'],
  gym: ['FITNESS', 'YOGA STUDIO', 'GYM', 'MARTIAL ARTS', 'SPIN STUDIO'],
  hotel: ['HOTEL', 'INN', 'SUITES'],
  culture: ['GALLERY', 'THEATRE', 'STUDIO', 'CINEMA', 'MUSEUM'],
  civic: ['COMMUNITY CENTRE', 'LIBRARY', 'POST OFFICE'],
  vacant: ['FOR LEASE', 'SPACE AVAILABLE', 'RETAIL FOR RENT'],
  vehicle: ['PARKING', 'GARAGE ENTRANCE', 'LOADING'],
};

/** The name on a unit's fascia: the surveyed one, or the trade where the survey is silent. */
function fasciaName(kind, surveyed, x, z) {
  if (surveyed) return surveyed;
  const w = TRADE_WORDS[kind];
  if (!w) return '';
  return w[Math.min(w.length - 1, (hashPos(x, z, 47) * w.length) | 0)];
}

function synthKind(x, z, salt) {
  let r = hashPos(x, z, salt);
  for (let i = 0; i < SYNTH_MIX.length; i++) {
    r -= SYNTH_MIX[i][1];
    if (r <= 0) return SYNTH_MIX[i][0];
  }
  return 'goods';
}

/**
 * REAL STOREY HEIGHTS. b.lv carries the surveyed storey count for 6,928 buildings; use it rather
 * than deriving floors from total height, so the ground storey, the string course, the balcony
 * pitch and the fire-escape landings line up with the real building instead of with an average.
 *
 * A ground storey is taller than the floors above it — GROUND_K times, and more on retail — so
 * h = groundH + (levels - 1) * storeyH with groundH = storeyH * GROUND_K solves for storeyH.
 *
 * GUARDED, because the levels tag was lifted by matching an OSM polygon to a massing record
 * within 34 m and that match is sometimes the building next door: the tenth percentile of h/lv in
 * this dataset is 1.10 m and the ninetieth is 9.89 m, neither of which is a storey. A count that
 * implies a floor-to-floor outside PLAUSIBLE is dropped and the profile default is used instead,
 * which is also what the renderer's own window lattice assumes.
 */
const STOREY_DEFAULT = [3.60, 3.92, 3.06, 4.45, 3.10, 4.35];   // by lighting profile
const STOREY_MIN = 2.45;
const STOREY_MAX = 6.20;

function storeyModel(b) {
  if (b.levels) return;
  const h = b.h > 0 ? b.h : 0;
  const groundK = (b.profile === 3 || b.units) ? 1.42 : 1.18;
  const def = STOREY_DEFAULT[b.profile] || 3.60;
  if (b.lv > 0 && h > 1.5) {
    const sh = h / (b.lv - 1 + groundK);
    if (sh >= STOREY_MIN && sh <= STOREY_MAX) {
      b.levels = b.lv;
      b.storeyH = sh;
      b.groundH = sh * groundK;
      b.levelsFromData = true;
      return;
    }
  }
  const n = Math.max(1, Math.round((h - def * groundK) / def) + 1);
  b.levels = n;
  b.storeyH = clamp(h / (n - 1 + groundK), STOREY_MIN, STOREY_MAX);
  b.groundH = b.storeyH * groundK;
  b.levelsFromData = false;
}


// The world positions of a building's surveyed units, flat [x, z, ...]. An edge that carries one
// of these IS a frontage whatever the road index says: a mapper put a shop on it.
const _uxz = [];
function unitPoints(b) {
  _uxz.length = 0;
  if (!b.units) return 0;
  for (let k = 0; k < b.units.length; k++) {
    if (!unitPosition(b, b.units[k])) continue;
    _uxz.push(_upos[0], _upos[1]);
  }
  return _uxz.length >> 1;
}

/**
 * Every street-facing edge of a footprint, ordered best frontage first, each with its world
 * endpoints, its outward normal, the nearest carriageway and how far away it is.
 *
 * THE WHOLE EDGE is treated, not a 24 m stub: `len` is its real length and the unit layout below
 * fills all of it. Capped at FRONT_MAX_FACES elevations (one more where the survey has premises,
 * because then the extra face is a fact rather than a guess) and FRONT_MAX_TOTAL metres per
 * building, which is what stops a 1.8 km-perimeter rail shed costing more than the whole
 * Financial District.
 */
function collectFrontages(C, b, out) {
  out.length = 0;
  const part = b.mainPart;
  if (!part) return 0;
  const co = part.outer;
  const n = co.length;
  if (n < 6) return 0;
  const nUnits = unitPoints(b);
  // A building the survey has premises on gets a longer leash: the premises are proof that there
  // is a street there, even where the carriageway centreline happens to be further away than the
  // ordinary test allows (a wide forecourt, a plaza, a road the extract clipped).
  const reach = nUnits ? FRONT_ROAD_MAX * 1.6 : FRONT_ROAD_MAX;
  const faceCap = nUnits ? FRONT_MAX_FACES + 1 : FRONT_MAX_FACES;
  const cand = [];
  for (let i = 0; i < n; i += 2) {
    const len = ringEdge(part, i);
    if (len < FRONT_MIN_LEN) continue;
    const j = (i + 2) % n;
    const au = co[i], av = co[i + 1];
    const bu = co[j], bv = co[j + 1];
    const nu = EDGE.nu, nv = EDGE.nv;
    // Sampled at three stations, because a long edge can run past the end of the street it
    // fronts and the midpoint alone would either miss it or claim all of it.
    let bd = Infinity;
    let rec = null;
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + k * 0.3;
      const u = au + (bu - au) * t, v = av + (bv - av) * t;
      const px = u + nu * 3.2, pz = -(v + nv * 3.2);
      const r = nearestRoadRec(C, px, pz, reach);
      const nd = nearestRoadDist();
      if (nd < bd) { bd = nd; rec = r; }
    }
    // Does a surveyed unit sit on this edge?
    let hits = 0;
    if (nUnits) {
      const ax = au, az = -av;
      const tx = (bu - au) / len, tz = -(bv - av) / len;
      for (let k = 0; k < _uxz.length; k += 2) {
        const dx = _uxz[k] - ax, dz = _uxz[k + 1] - az;
        const sPos = clamp(dx * tx + dz * tz, 0, len);
        const qx = ax + tx * sPos, qz = az + tz * sPos;
        if (Math.hypot(_uxz[k] - qx, _uxz[k + 1] - qz) < 5.0) hits++;
      }
    }
    if (!isFinite(bd) && !hits) continue;
    if (!rec && !hits) continue;
    cand.push({
      i,
      len,
      ax: au, az: -av, bx: bu, bz: -bv,
      // Unit tangent from A to B, in world.
      tx: (bu - au) / len, tz: -(bv - av) / len,
      nu, nv,
      x: (au + bu) * 0.5, z: -(av + bv) * 0.5,
      yaw: Math.atan2(nv, nu),
      d: isFinite(bd) ? bd : reach, rec, hits,
      retail: false, units: [],
    });
  }
  if (!cand.length) return 0;
  // Edges the survey has premises on first, then nearest carriageway, then longest: on a corner
  // site both elevations are frontages and the primary one is whichever street is closer.
  cand.sort((p, q) => (q.hits - p.hits) || (p.d - q.d) || (q.len - p.len));
  let total = 0;
  for (let k = 0; k < cand.length && out.length < faceCap; k++) {
    if (total + cand[k].len > FRONT_MAX_TOTAL && out.length && !cand[k].hits) break;
    out.push(cand[k]);
    total += cand[k].len;
  }
  return out.length;
}

/** Is this frontage's ground floor retail? The survey decides when it can; otherwise a hash. */
function frontageRetail(C, b, fr) {
  if (b.units && b.units.length) return true;
  const rec = fr.rec;
  if (!rec || rec.bridge || !rec.name) return false;
  if (rec.cls === 'motorway' || rec.cls === 'service' || rec.cls === 'foot') return false;
  if (fr.d > 26 || fr.len < 4.5) return false;
  let p = rec.commercial ? 0.30 : 0.08;
  if (rec.cls === 'major') p += 0.16;
  if (rec.heritage) p += 0.14;
  let hit = -1;
  for (let i = 0; i < RETAIL_STREETS.length; i++) {
    const k = RETAIL_STREETS[i][0];
    if (rec.name.indexOf(k) !== 0) continue;
    if (hit < 0 || k.length > RETAIL_STREETS[hit][0].length) hit = i;
  }
  if (hit >= 0) p += RETAIL_STREETS[hit][1];
  if (b.profile === 3) p += 0.40;
  else if (b.profile === 2) p += 0.12;         // condo podium
  else if (b.profile === 1) p += 0.08;         // office podium
  else if (b.profile === 0 || b.profile === 4) p -= 0.34;
  else if (b.profile === 5) p -= 0.10;
  if (b.h > 100) p -= 0.06;
  if (b.area < 55) p -= 0.20;
  // One draw per FRONTAGE, not per unit: a block face is continuous retail or it is not, and
  // deciding unit by unit produces a checkerboard no street has ever looked like.
  return hashPos(fr.x, fr.z, 37) < clamp(p, 0, 0.96);
}

/**
 * Where a surveyed unit actually is, in world metres. `u.s` indexes a SEGMENT of the building's
 * first raw ring and `u.t` runs along it — see tools/attach_pois.py — so the position comes off
 * the raw ring rather than off the welded, re-wound plan ring the extrusion uses, and the two
 * can never drift apart.
 * @returns {boolean} false if the record cannot be resolved
 */
const _upos = [0, 0];
function unitPosition(b, u) {
  const ring = b.rings && b.rings[0];
  if (!Array.isArray(ring) || ring.length < 2) return false;
  const si = (u.s | 0);
  if (si < 0 || si >= ring.length) return false;
  const a = ring[si], c = ring[(si + 1) % ring.length];
  if (!a || !c || !isNum(a[0]) || !isNum(c[0])) return false;
  const t = isNum(u.t) ? clamp(u.t, 0, 1) : 0.5;
  _upos[0] = a[0] + (c[0] - a[0]) * t;
  _upos[1] = a[1] + (c[1] - a[1]) * t;
  return true;
}

/**
 * Attach every surveyed unit to the frontage it sits on, as a distance ALONG that frontage.
 * Projection rather than index arithmetic: the plan ring is welded and may be reversed relative
 * to the raw one, so the only reliable link between the two is geometry.
 */
function assignUnits(b, fronts) {
  if (!b.units || !b.units.length || !fronts.length) return 0;
  let placed = 0;
  for (let k = 0; k < b.units.length; k++) {
    const u = b.units[k];
    if (!unitPosition(b, u)) continue;
    const px = _upos[0], pz = _upos[1];
    let best = 26.0, bi = -1, bs = 0;
    for (let f = 0; f < fronts.length; f++) {
      const fr = fronts[f];
      const dx = px - fr.ax, dz = pz - fr.az;
      const s = clamp(dx * fr.tx + dz * fr.tz, 0, fr.len);
      const qx = fr.ax + fr.tx * s, qz = fr.az + fr.tz * s;
      const d = Math.hypot(px - qx, pz - qz);
      if (d < best) { best = d; bi = f; bs = s; }
    }
    if (bi < 0) continue;
    fronts[bi].units.push({
      s: bs, kind: unitKindOf(u.c, u.v), value: u.v,
      name: typeof u.n === 'string' ? u.n : '',
      brand: typeof u.b === 'string' ? u.b : '',
      house: typeof u.h === 'string' ? u.h : '',
      x: px, z: pz, surveyed: true,
    });
    placed++;
  }
  // Sort along the frontage, then MERGE anything closer together than a unit can be. Slot
  // boundaries are midpoints, so two units s apart give slots of s/2 each; below UNIT_MERGE the
  // slot collapses under put()'s minimum and the unit is silently lost. OSM routinely maps a
  // shop, its entrance and its ATM as three nodes a metre apart, and what is wanted there is one
  // shopfront, not three that do not fit.
  let merged = 0;
  for (let f = 0; f < fronts.length; f++) {
    const us = fronts[f].units;
    us.sort((p, q) => p.s - q.s);
    let w = 0;
    for (let k = 0; k < us.length; k++) {
      if (w > 0 && us[k].s - us[w - 1].s < UNIT_MERGE) {
        // Keep whichever record carries more: a name beats no name, a shop beats a fixture.
        const prev = us[w - 1];
        const better = (us[k].name && !prev.name) ||
          (prev.kind === 'fixture' && us[k].kind !== 'fixture');
        if (better) us[w - 1] = us[k];
        merged++;
        continue;
      }
      us[w++] = us[k];
    }
    us.length = w;
  }
  _assignMerged = merged;
  return placed;
}

// How many surveyed records the last assignUnits() call folded into a neighbour.
let _assignMerged = 0;

/**
 * Turn one frontage into a run of SLOTS that covers it end to end.
 *
 * Surveyed units keep their real position: each takes the span midway to its neighbours, capped
 * at UNIT_SURVEY_MAX so a single cafe cannot claim eighty metres of warehouse. Everything left
 * over — the ends of the block, the gaps between capped slots, and the whole frontage of a
 * building the survey never reached — is filled with synthesised units of about UNIT_TARGET,
 * whose kinds come out of the same distribution the survey has. That is what makes the seam
 * between surveyed and invented invisible (CONTRACT Amendment 9).
 */
// The slot marker for the one entrance a non-retail frontage carves out of its party wall.
// CONTRACT §6.2: every building gets at least one door on a street-facing elevation.
const ENTRY_SLOT = Object.freeze({ entrance: true });

// Per-unit width jitter, reused rather than allocated per frontage.
const _wjit = new Float64Array(16);

// Unit kinds that are NOT a trading shopfront: a party wall, a lobby, a house door, a service
// elevation, a civic entrance, a garage opening. They get no crowd outside them and are not
// counted as retail.
const NON_TRADE = {
  blank: 1, lobby: 1, house: 1, depot: 1, civic: 1, vehicle: 1, fixture: 1,
};

function layoutUnits(b, fr, retail, entrance, out) {
  out.length = 0;
  const a0 = FRONT_END_MARGIN;
  const a1 = fr.len - FRONT_END_MARGIN;
  if (a1 - a0 < 1.2) return 0;
  let entryDone = !entrance;

  const put = (s0, s1, rec) => {
    if (s1 - s0 < 0.9) return;
    out.push({ s0, s1, rec });
  };
  // Synthesise a run of units across a gap.
  const fill = (s0, s1) => {
    const span = s1 - s0;
    if (span < 0.9) return;
    if (!retail) {
      // A party wall, with the building's own front door cut into the first stretch long enough
      // to hold one. Everything either side of it is the cheapest thing in the table.
      if (!entryDone && span >= 2.2) {
        entryDone = true;
        const dw = clamp(span * 0.24, Math.min(2.4, span - 0.2), 5.0);
        const c = s0 + span * (0.28 + hashPos(fr.ax + s0, fr.az, 43) * 0.44);
        const u0 = clamp(c - dw * 0.5, s0, s1 - dw);
        put(s0, u0, null);
        put(u0, u0 + dw, ENTRY_SLOT);
        put(u0 + dw, s1, null);
        return;
      }
      put(s0, s1, null);
      return;
    }
    const n = clamp(Math.round(span / UNIT_TARGET), 1, 12);
    const w = span / n;
    if (w < UNIT_MIN && n > 1) { put(s0, s1, null); return; }
    // Lot widths VARY. Eight identical 7.5 m units in a row is the single most mechanical thing
    // a synthesised block face can do, and the 1900-1930 commercial stock this is standing in
    // for was subdivided lot by lot. The jitter is hashed on the world position of each division
    // and renormalised so the run still covers the span exactly.
    let acc = 0;
    for (let i = 0; i < n; i++) {
      _wjit[i] = 0.74 + hashPos(fr.ax + s0 + i * w, fr.az + i * 3.1, 53) * 0.52;
      acc += _wjit[i];
    }
    let u0 = s0;
    for (let i = 0; i < n; i++) {
      const wi = span * (_wjit[i] / acc);
      put(u0, i === n - 1 ? s1 : u0 + wi, null);
      u0 += wi;
    }
  };

  const us = fr.units;
  if (!us.length) {
    fill(a0, a1);
    return out.length;
  }

  // Boundaries midway between neighbours, then each surveyed slot capped around its own point.
  let cursor = a0;
  for (let i = 0; i < us.length; i++) {
    const s = clamp(us[i].s, a0, a1);
    const prev = i > 0 ? clamp(us[i - 1].s, a0, a1) : a0;
    const next = i < us.length - 1 ? clamp(us[i + 1].s, a0, a1) : a1;
    let lo = i === 0 ? a0 : (prev + s) * 0.5;
    let hi = i === us.length - 1 ? a1 : (s + next) * 0.5;
    if (lo < cursor) lo = cursor;
    if (hi < lo) hi = lo;
    if (hi - lo > UNIT_SURVEY_MAX) {
      const half = UNIT_SURVEY_MAX * 0.5;
      const c = clamp(s, lo + half, hi - half);
      lo = Math.max(lo, c - half);
      hi = Math.min(hi, c + half);
    }
    if (lo - cursor > 0.9) fill(cursor, lo);
    else if (lo > cursor) lo = cursor;
    put(lo, hi, us[i]);
    cursor = hi;
  }
  if (a1 - cursor > 0.9) fill(cursor, a1);
  // CONTRACT §6.2: a street-facing elevation that is the building's PRIMARY one must carry its
  // entrance, whatever it is made of. If no span was long enough to carve one out of, the widest
  // synthesised slot simply becomes the door.
  if (!entryDone) {
    let wi = -1, ww = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i].rec) continue;
      const w = out[i].s1 - out[i].s0;
      if (w > ww) { ww = w; wi = i; }
    }
    if (wi >= 0) out[wi].rec = ENTRY_SLOT;
  }
  return out.length;
}

/** How many surveyed units the last assignUnits() call merged into their neighbours. */
function unitsMergedLast() {
  return _assignMerged;
}

export {
  findFrontage, pickEdge, BACK_EDGE,
  FRONT_END_MARGIN, RETAIL_ANCHOR, UNIT_MIN, ENTRY_SLOT, NON_TRADE,
  CORNER_UNIT_R, CORNER_MIN_LEN,
  entranceKind, fasciaName, synthKind, storeyModel, collectFrontages, frontageRetail,
  unitPosition, assignUnits, layoutUnits, unitsMergedLast,
};
