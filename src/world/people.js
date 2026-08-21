// src/world/people.js — putting people on the ground.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged.
//
// The city had 1,612 parked cars and 51 km of streetcar track and not one person on it, which
// reads as an evacuation. This pass puts a few thousand of them where they would actually be.
//
// Density follows CONTEXT rather than a uniform scatter, because uniform scatter is exactly what
// makes a crowd read as wallpaper. Three multipliers stack: the road CLASS, the NAMED street
// (Yonge and Queen carry more than a numbered side street), and the DISTRICT (the financial core
// against the edge of the extract). Benches get somebody sitting on them, crossings get somebody
// waiting, bike lanes get cyclists, plazas and parks get their own share by area.
//
// Everything is drawn from ONE seeded stream keyed on world position, so a tile's crowd is the
// same whichever order the tiles were built in, and a person never lands on a carriageway, inside
// a footprint or on top of another prop — the occupancy grid in world/context.js sees to that.

import { clamp, makeRng, TAU } from '../core/math.js';
import { isNum } from '../core/util.js';
import { partContains, planArea } from '../geom/ring.js';
import {
  appendPedestrian, appendPedestrianGroup, appendCyclist, appendDogWalker,
} from '../props/index.js';
import { EPS, CURB, PARK_Y, PATH_Y, ROAD_Y, SIDEWALK_W, PED_SEED } from './ground.js';
import {
  PROP_H, inFootprint, kerbSeat, noteProp, onCarriageway, onPavement, reserve,
} from './context.js';
import { nearJunction, recSample, surfaceY } from './roads.js';

/* ============================================================== people == */
/**
 * PEOPLE. The city has 1,612 parked cars and 51 km of streetcar track and not one person on it,
 * which reads as an evacuation. This pass puts 2,500-4,000 of them on the ground.
 *
 * Density follows context rather than a uniform scatter, because uniform scatter is exactly what
 * makes a crowd read as wallpaper. Three multipliers stack:
 *   * the road CLASS — an arterial carries people, a service lane does not, an expressway
 *     carries none at all;
 *   * the STREET, by name. Yonge, King, Queen, Bay, Front, Dundas and Spadina are where downtown
 *     Toronto actually walks; the numbers below are relative footfall, not invention for its own
 *     sake, and Lake Shore is deliberately near zero because nobody walks it;
 *   * the DISTRICT — a bump centred on King and Bay that fades out over 420 m, which is what puts
 *     the crowd in the Financial District core and leaves the rail lands empty.
 *
 * Everything else is placed from real geometry the rest of the load already built: the OSM
 * footways, the plaza fills, the park polygons, the transit stops, the benches, and the retail
 * frontages the facade pass found. Nobody is scattered anywhere the city does not already say is
 * walkable.
 *
 * Its own rng. The pass is seeded from SEED but with its own stream, so adding people does not
 * shift a single lamp, tree or parked car that was placed before them.
 *
 * PLACEMENT RULES, all audited at the end of the load:
 *   * never inside a building footprint;
 *   * never on a carriageway, except cyclists in the bike lanes and the figures on a crossing;
 *   * never floating and never sunk — every seat is groundY() plus the kerb the site sits on.
 */

const PED_BASE = 50.0;             // metres of kerb per person on an ordinary named street.
                                   // Tuned so the sidewalk pass — which runs last and is the only
                                   // unbounded source — lands clear of MAX_PEOPLE rather than
                                   // being truncated by it, which would leave whichever streets
                                   // happen to be processed last conspicuously empty.
const PED_MIN_W = 0.04;
const PED_R = 0.40;                // occupancy radius of one person
const PED_GROUP_R = 1.30;
const PED_GROUP_P = 0.10;
const PED_STAND_P = 0.20;
const PED_FAST_P = 0.17;
const PED_DOG_P = 0.030;
const PED_SIT_P = 0.34;            // fraction of benches with somebody on them
const PED_XING_P = 0.30;           // fraction of crossing corners with somebody waiting
const CYCLE_SPACING = 130.0;       // metres of bike lane per cyclist
const PLAZA_PER = 300.0;           // square metres of plaza per person
const PARK_PER = 1100.0;           // ...and of park
const WALK_SPACING = 130.0;        // metres of OSM footway per person
// The crowd is budgeted PER TILE, not city-wide. A single global head count was a vertex budget
// in disguise: on a 43 km2 map it is spent long before the camera reaches the Financial District,
// and whichever tiles happened to be built last come out empty. 220 is the old city-wide 4,000
// scaled to one 625 m tile at the density the 7 km2 slice was tuned to (571 people per km2), so a
// street looks exactly as busy as it used to and the number resident at any moment is bounded by
// the detail radius rather than by the size of the map.
const MAX_PEOPLE = 220;

// King and Bay, in local metres, and how far the core's footfall bump reaches.
const CORE_X = 684.7, CORE_Z = -489.8, CORE_R = 420.0;

// Relative footfall by street, longest prefix wins. Not decoration: this is the difference
// between a crowd that looks like Toronto and a crowd sprinkled with a shaker.
const PED_STREETS = [
  ['Yonge', 2.00], ['King', 1.90], ['Queen', 1.85], ['Bay', 1.75], ['Front', 1.60],
  ['Dundas', 1.60], ['Spadina', 1.45], ['Queens Quay', 1.35], ['University', 1.25],
  ['Blue Jays', 1.20], ['John', 1.20], ['Richmond', 1.15], ['Adelaide', 1.15], ['Church', 1.10],
  ['York', 1.10], ['Wellington', 1.05], ['Simcoe', 1.00], ['Peter', 1.00], ['Bremner', 0.95],
  ['Bathurst', 0.90], ['Jarvis', 0.80], ['Lower Simcoe', 0.75], ['Lake Shore', 0.30],
  ['Gardiner', 0.00], ['Don Valley', 0.00],
];

// Only the classes that carry a synthetic sidewalk band appear here. Pedestrian ways and OSM
// footways get their people from the plaza and footway passes instead, off their real geometry.
const PED_CLASS_W = { motorway: 0, major: 1.0, minor: 0.52, service: 0.16 };

function pedStreetWeight(name) {
  if (typeof name !== 'string' || !name) return 0.62;      // unnamed lanes and back streets
  let best = 0.85;
  let bestLen = 0;
  for (let i = 0; i < PED_STREETS.length; i++) {
    const k = PED_STREETS[i][0];
    if (k.length > bestLen && name.indexOf(k) === 0) { best = PED_STREETS[i][1]; bestLen = k.length; }
  }
  return best;
}

function pedDistrict(x, z) {
  const d = Math.hypot(x - CORE_X, z - CORE_Z);
  return 1 + 0.85 * clamp(1 - d / CORE_R, 0, 1);
}

// Where the crowd actually ended up, on a 100 m grid. "Dense in the core, sparse in the rail
// lands" is a claim, and a claim about a distribution needs a distribution to check it against.
const CROWD_CELL = 100.0;

function noteCrowd(C, x, z, n) {
  const S = C.stats.people;
  if (Math.hypot(x - CORE_X, z - CORE_Z) <= CORE_R) S.core += n;
  const k = Math.round(x / CROWD_CELL) + ':' + Math.round(z / CROWD_CELL);
  const v = (C.crowd.get(k) || 0) + n;
  C.crowd.set(k, v);
  if (v > S.peakCell) S.peakCell = v;
}

// props.js: local +X is the way a figure faces, so a person walking along (dx, dz) takes
// yaw = atan2(-dz, dx). Same rule as the parked cars and the cyclists.
function faceYaw(dx, dz) { return Math.atan2(-dz, dx); }

/**
 * Put somebody at (x, z). The site must already be somewhere a person can stand; this handles the
 * footprint, carriageway and occupancy tests, the seat height, the pose roll and the audit.
 *
 * opts: { group, kind, pose, seat, roadPad, where }
 * @returns {boolean} true when a figure was actually emitted
 */
function placePerson(C, P, x, z, yaw, opts) {
  const S = C.stats.people;
  // The head count is the TILE's, not the accumulated total: reading stats.people.total here
  // would spend the whole map's budget on whichever tiles happened to be built first and leave
  // the rest of the city deserted — and would make the crowd a function of the flight path.
  if (C.tilePeople >= MAX_PEOPLE) return false;
  const o = opts || {};
  const group = o.group ? clamp(Math.round(o.group), 2, 4) : 0;
  const kind = o.kind || 'pedestrian';
  const r = group ? PED_GROUP_R : (kind === 'cyclist' ? 1.15 : (kind === 'dogWalker' ? 1.05 : PED_R));
  const roadPad = o.roadPad === undefined ? 0.30 : o.roadPad;
  const gy = reserve(C, group ? 'pedestrianGroup' : kind, x, z, r, roadPad,
    PROP_H[kind] || PROP_H.pedestrian);
  if (!isNum(gy)) return false;
  const base = isNum(o.seat) ? o.seat : gy + kerbSeat(C, x, z);
  const mb = C.mb.props;

  if (kind === 'cyclist') {
    appendCyclist(mb, P, x, base, z, yaw);
    S.cyclists++; S.total++;
  } else if (kind === 'dogWalker') {
    appendDogWalker(mb, P, x, base, z, yaw);
    S.dogWalkers++; S.walking++; S.total++;
  } else if (group) {
    appendPedestrianGroup(mb, P, x, base, z, yaw, group);
    S.groups++; S.grouped += group; S.total += group;
  } else {
    let pose = o.pose;
    if (!pose) {
      const rp = P();
      pose = rp < PED_FAST_P ? 'walkFast' : (rp < PED_FAST_P + PED_STAND_P ? 'stand' : 'walk');
    }
    appendPedestrian(mb, P, x, base, z, yaw, pose);
    if (pose === 'sit') S.sitting++;
    else if (pose === 'stand' || pose === 'lean') S.standing++;
    else S.walking++;
    S.total++;
  }
  if (o.where) S[o.where] = (S[o.where] || 0) + (group || 1);
  C.tilePeople += (group || 1);
  noteCrowd(C, x, z, group || 1);
  // 4th field: whether this figure is ALLOWED on a carriageway. Only the cyclists in the painted
  // lanes are; everybody else being on one is a bug, and the audit has to be able to tell.
  C.auditPed.push(x, z, base, roadPad < 0 ? 1 : 0);
  return true;
}

// Somebody on a bench. The bench is already in the occupancy grid, so this goes round reserve()
// and seats the figure on the bench's own site, which the furniture pass already validated.
function seatOnBench(C, P, b) {
  const S = C.stats.people;
  if (C.tilePeople >= MAX_PEOPLE) return;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const du = 0.10, dv = (P() < 0.5 ? -1 : 1) * (0.30 + P() * 0.34);
  let x = b.x + du * c + dv * s;
  let z = b.z - du * s + dv * c;
  // The bench's own site was validated; the seat is up to two thirds of a metre along it, and on
  // a bench set right at the kerb that offset can put the sitter over the carriageway. Re-test
  // it, fall back to the middle of the bench, and give up rather than seat somebody in traffic.
  if (onCarriageway(C, x, z, 0) || inFootprint(C, x, z, 0)) {
    x = b.x; z = b.z;
    if (onCarriageway(C, x, z, 0) || inFootprint(C, x, z, 0)) return;
  }
  // ...and the same for the GROUND under the offset. A bench on a slope, or one whose ends
  // straddle a kerb, has a seat height that is right at its own centre and wrong two thirds of a
  // metre along it; the sitter would then read as sunk into the pavement or floating over it.
  // Fall back to the middle of the bench, which is the height that was validated.
  if (Math.abs((b.y - kerbSeat(C, x, z)) - C.groundY(x, z)) > 0.06) {
    x = b.x; z = b.z;
    if (Math.abs((b.y - kerbSeat(C, x, z)) - C.groundY(x, z)) > 0.06) return;
  }
  appendPedestrian(C.mb.props, P, x, b.y, z, b.yaw + (P() - 0.5) * 0.30, 'sit');
  noteProp(C, 'pedestrian');
  S.sitting++; S.total++; S.onSidewalk++;
  C.tilePeople++;
  noteCrowd(C, x, z, 1);
  C.auditPed.push(x, z, b.y, 0);
  C.audit.push(x, z);
}

/** Everybody on the streets, the walkways, the plazas, the parks and the stops. */
function placePedestrians(C, recs, parkParts) {
  // Seeded from the TILE, not from a fixed constant. Re-seeding every tile from PED_SEED would
  // hand each of them the identical random stream, so the same corner would be skipped and the
  // same bench left empty in all 156 of them — measured, that moved the crowd off the crossings,
  // the plazas and the parks and dumped it all on the pavement.
  const P = makeRng(isNum(C.pedSeed) ? C.pedSeed : PED_SEED);

  /* --- waiting to cross ------------------------------------------------ */
  // On the corner, facing across the street: the single most legible piece of street behaviour
  // there is, and it puts people exactly where the kerb ramps and crossings already are.
  for (let i = 0; i < C.corners.length; i++) {
    const c = C.corners[i];
    if (P() > PED_XING_P) continue;
    const n = P() < 0.30 ? 2 + ((P() * 2) | 0) : 1;
    const yaw = faceYaw(c.dx, c.dz) + (P() - 0.5) * 0.6;
    placePerson(C, P, c.x, c.z, yaw, {
      group: n > 1 ? n : 0, pose: P() < 0.82 ? 'stand' : 'walk', where: 'atCrossing',
    });
  }

  /* --- transit stops --------------------------------------------------- */
  // Beyond the ends of the shelter rather than in front of it: the shelter has already claimed
  // its own footprint in the occupancy grid, and a passenger standing inside the glass is not a
  // passenger, it is a clipping artifact. The shelter's local +X faces back at the track, so a
  // waiting passenger takes the same yaw.
  for (let i = 0; i < C.stations.length; i++) {
    const st = C.stations[i];
    const n = 1 + ((P() * 3) | 0);
    const c = Math.cos(st.yaw), s = Math.sin(st.yaw);
    for (let k = 0; k < n; k++) {
      const du = (P() - 0.5) * 1.4;
      const dv = (P() < 0.5 ? -1 : 1) * (Math.min(st.len * 0.5, 6.0) + 0.9 + P() * 1.6);
      const x = st.x + du * c + dv * s;
      const z = st.z - du * s + dv * c;
      placePerson(C, P, x, z, st.yaw + (P() - 0.5) * 0.7, {
        pose: P() < 0.75 ? 'stand' : 'walk', where: 'atStop',
      });
    }
  }

  /* --- benches --------------------------------------------------------- */
  for (let i = 0; i < C.benches.length; i++) {
    if (P() < PED_SIT_P) seatOnBench(C, P, C.benches[i]);
  }

  /* --- OSM footways ---------------------------------------------------- */
  for (let i = 0; i < C.walks.length; i++) {
    const run = C.walks[i];
    const pts = run.pts;
    let acc = P() * WALK_SPACING;
    for (let k = 1; k < pts.length; k++) {
      let dx = pts[k][0] - pts[k - 1][0], dz = pts[k][1] - pts[k - 1][1];
      const l = Math.hypot(dx, dz);
      if (!(l > EPS)) continue;
      acc += l;
      if (acc < WALK_SPACING) continue;
      acc = 0;
      dx /= l; dz /= l;
      const t = 0.25 + P() * 0.5;
      const lat = (P() - 0.5) * Math.min(run.w * 0.55, 1.6);
      const x = pts[k - 1][0] + dx * l * t - dz * lat;
      const z = pts[k - 1][1] + dz * l * t + dx * lat;
      const rev = P() < 0.5 ? -1 : 1;
      placePerson(C, P, x, z, faceYaw(dx * rev, dz * rev) + (P() - 0.5) * 0.4, {
        seat: C.groundY(x, z) + (run.kerbed ? ROAD_Y + CURB : PATH_Y),
        where: 'onFootway',
      });
    }
  }

  /* --- plazas ---------------------------------------------------------- */
  for (let i = 0; i < C.plazas.length; i++) {
    const part = C.plazas[i];
    const area = Math.abs(planArea(part.outer));
    const want = Math.min(24, Math.floor(area / PLAZA_PER));
    const bb = part.bbox;
    for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
      const u = bb[0] + P() * (bb[2] - bb[0]);
      const v = bb[1] + P() * (bb[3] - bb[1]);
      if (!partContains(part, u, v)) continue;
      const x = u, z = -v;
      const yaw = P() * TAU - Math.PI;
      const ok = P() < 0.22
        ? placePerson(C, P, x, z, yaw, { group: 2 + ((P() * 3) | 0), seat: C.groundY(x, z) + PATH_Y, where: 'onPlaza' })
        : placePerson(C, P, x, z, yaw, { seat: C.groundY(x, z) + PATH_Y, where: 'onPlaza' });
      if (ok) k++;
    }
  }

  /* --- parks ----------------------------------------------------------- */
  for (let i = 0; i < parkParts.length; i++) {
    const part = parkParts[i];
    const area = Math.abs(planArea(part.outer));
    if (area < 380) continue;
    const want = Math.min(14, Math.floor(area / PARK_PER));
    const bb = part.bbox;
    for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
      const u = bb[0] + P() * (bb[2] - bb[0]);
      const v = bb[1] + P() * (bb[3] - bb[1]);
      if (!partContains(part, u, v)) continue;
      const x = u, z = -v;
      const yaw = P() * TAU - Math.PI;
      const roll = P();
      const opts = { seat: C.groundY(x, z) + PARK_Y, where: 'inPark' };
      if (roll < 0.18) opts.group = 2 + ((P() * 3) | 0);
      else if (roll < 0.28) opts.kind = 'dogWalker';
      else if (roll < 0.44) opts.pose = 'stand';
      if (placePerson(C, P, x, z, yaw, opts)) k++;
    }
  }

  /* --- outside the shops ----------------------------------------------- */
  // Where the facade pass actually built a shopfront. The figure stands off the glass by a metre
  // and a half, facing along the frontage rather than into it.
  for (let i = 0; i < C.retail.length; i++) {
    const f = C.retail[i];
    if (P() > 0.42) continue;
    const ox = Math.cos(f.yaw), oz = -Math.sin(f.yaw);
    const tx = -oz, tz = ox;                       // along the frontage
    const along = (P() - 0.5) * Math.min(f.len * 0.7, 9.0);
    const out = 1.5 + P() * 1.4;
    const x = f.x + ox * out + tx * along;
    const z = f.z + oz * out + tz * along;
    const rev = P() < 0.5 ? -1 : 1;
    const roll = P();
    placePerson(C, P, x, z, faceYaw(tx * rev, tz * rev) + (P() - 0.5) * 0.7, {
      group: roll < 0.20 ? 2 + ((P() * 3) | 0) : 0,
      pose: roll < 0.20 ? undefined : (roll < 0.48 ? 'stand' : undefined),
      where: 'atShopfront',
    });
  }

  /* --- sidewalks ------------------------------------------------------- */
  // LAST, deliberately. The sidewalks are the only unbounded source, so running them last makes
  // them the sink that absorbs whatever is left of the head count instead of eating it all before
  // a single person reaches a plaza, a park or a transit stop.
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const sw = SIDEWALK_W[rec.cls] || 0;
    if (rec.bridge || !(sw > 0)) continue;
    const cls = PED_CLASS_W[rec.cls];
    if (!(cls > 0)) continue;
    const mid = rec.pts[rec.pts.length >> 1];
    const w = cls * pedStreetWeight(rec.name) * pedDistrict(mid[0], mid[1]);
    if (w < PED_MIN_W) continue;
    const pitch = PED_BASE / w;
    if (rec.len < pitch * 0.4) continue;
    const inner = rec.hw + 0.35;
    for (let sd = 0; sd < 2; sd++) {
      const sgn = sd === 0 ? 1 : -1;
      for (let s = pitch * (0.2 + 0.6 * P()); s < rec.len; s += pitch * (0.6 + 0.8 * P())) {
        const m = recSample(rec, s);
        const lat = (inner + sw * (0.20 + P() * 0.62)) * sgn;
        const x = m.x + m.sx * lat, z = m.z + m.sz * lat;
        if (!onPavement(C, x, z)) continue;
        // Along the street, either way. The side vector is +90 degrees from travel, so travel is
        // (sz, -sx) and the two directions are that and its negative.
        const rev = P() < 0.5 ? -1 : 1;
        const yaw = faceYaw(m.sz * rev, -m.sx * rev) + (P() - 0.5) * 0.5;
        const roll = P();
        if (roll < PED_GROUP_P * w) {
          placePerson(C, P, x, z, yaw, { group: 2 + ((P() * 3) | 0), where: 'onSidewalk' });
        } else if (roll < PED_GROUP_P * w + PED_DOG_P) {
          placePerson(C, P, x, z, yaw, { kind: 'dogWalker', where: 'onSidewalk' });
        } else {
          placePerson(C, P, x, z, yaw, { where: 'onSidewalk' });
        }
      }
    }

    /* --- cyclists in the painted bike lanes ---------------------------- */
    // These ARE on the carriageway, which is the point: the lane is between the kerb lane and
    // the parked cars, and a cyclist on the pavement would be the bug.
    if (rec.bike && rec.hw > 4.2 && rec.len > 40) {
      const o0 = rec.hw - 1.75;
      for (let sd = 0; sd < 2; sd++) {
        const sgn = sd === 0 ? 1 : -1;
        for (let s = 12 + P() * CYCLE_SPACING; s < rec.len - 8; s += CYCLE_SPACING * (0.6 + P())) {
          const m = recSample(rec, s);
          const o = o0 * sgn;
          const x = m.x + m.sx * o, z = m.z + m.sz * o;
          if (nearJunction(rec, s, 6.0)) continue;
          // Riding with the traffic on that side: the near-side lane runs one way, the far the
          // other, exactly as the parked cars are oriented.
          const dx = m.sz * sgn, dz = -m.sx * sgn;
          placePerson(C, P, x, z, faceYaw(dx, dz), {
            kind: 'cyclist', roadPad: -1, seat: surfaceY(C, rec, m, o), where: 'inBikeLane',
          });
        }
      }
    }
  }
}

export { placePedestrians };
