// src/world/context.js — the street-detail context, and every question you may ask of a point.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged. A dozen independent
// generators walk the same kerb line, and they only agree with each other because they all read
// the same context object `C`: the terrain sampler, the merged mesh builders, one seeded rng, the
// building broadphase, a carriageway segment index, a deck index and an occupancy grid.
//
// Everything here is a QUERY or a RESERVATION, never a placement:
//
//   inFootprint / footprintDepth / coveringRecord   is a building here, and how far inside?
//   onCarriageway / onPavement / kerbSeat / ...     is this asphalt, pavement, or the kerb line?
//   carriagewayTopY / carriagewayCrown              exactly how high is the road surface here?
//   deckHeadroom / deckFits                         how much air is there before a soffit?
//   reserve / noteProp / noteLight                  claim a disc, and count what went into it.
//
// The placement passes that ask these questions live in world/furniture.js, world/surveyed.js,
// world/vehicles.js and world/people.js.
//
// TIME OF DAY (Amendment 7). Nothing here bakes light. Every surface any of these passes emits
// carries an albedo and a roughness and nothing else — no pre-darkened undersides, no "night"
// tints, no glow decals. The only emissive values in the whole pass come out of props.js and
// facades.js, on real lamps, real signals and real lit interiors, and the renderer alone decides
// when they are on.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { closestOnRing, partContains } from '../geom/ring.js';
import { appendCobraLamp, appendPedestrianLamp, appendAcornLamp } from '../props/index.js';
import { EPS, ROAD_Y, CROWN, CURB, SEED, PED_SEED, distToSeg2 } from './ground.js';
import { makeRng } from '../core/math.js';
import { makeGridIndex } from '../data/index.js';
import { corridorDepth } from './grade.js';

// Heritage lighting districts, local metres (X east, Z south): St Lawrence / Old Town, the
// Distillery approach, and the Front St / Union frontage.
// Heritage lighting districts: where the city fits acorn globes instead of cobra heads. Circles
// in local metres, [x, z, radius].
const ACORN_ZONES = [
  [1180, -430, 470],
  [1490, -250, 300],
  [180, -220, 330],
  // THE DISTILLERY DISTRICT. Toronto's largest surviving Victorian industrial quarter and the one
  // place downtown that is lit entirely by heritage globes — Trinity Street, Tank House Lane,
  // Gristmill Lane and Case Goods Lane are pedestrian setts with acorn posts down both sides. It
  // was outside every zone above, which left the whole quarter with no street lighting at all.
  [2205, -1700, 210],
];

// Streets that actually carry painted bike lanes downtown.
const BIKE_STREETS = ['Richmond', 'Adelaide', 'Bay', 'Simcoe', 'Sherbourne', 'Wellesley', 'Peter'];
/* ========================================== street detail: shared context == */
//
// CONTRACT §6.3. Everything below — paint, kerbs, walkways, track, furniture, vehicles, facades
// and roofscape — reads one context object: the terrain sampler, the merged mesh builders, one
// seeded rng, the building broadphase, a carriageway segment index and an occupancy grid. Passing
// it explicitly keeps these routines at module scope instead of turning loadCity() into a single
// enormous closure, and it guarantees every one of them agrees on where the ground is.
//
// TIME OF DAY (Amendment 7). Nothing here bakes light. Every surface emitted below carries an
// albedo and a roughness and nothing else — no pre-darkened undersides, no "night" tints, no glow
// decals. The only emissive values in the whole pass come out of props.js and facades.js, on real
// lamps, real signals and real lit interiors, and the renderer alone decides when they are on.


/**
 * A disc-occupancy grid. A dozen independent generators walk the same kerb line, so without this
 * a bench, a bin and a tree all land on the same square metre.
 */
function makeOccupancy(cell, x0, z0, nx, nz) {
  const cells = new Array(nx * nz);
  let maxR = 1.0;
  const ci = (v) => clamp(Math.floor((v - x0) / cell), 0, nx - 1);
  const cj = (v) => clamp(Math.floor((v - z0) / cell), 0, nz - 1);
  return {
    // Reserve a disc, or return false and reserve nothing.
    claim(x, z, r) {
      const pad = r + maxR;
      const i0 = ci(x - pad), i1 = ci(x + pad);
      const j0 = cj(z - pad), j1 = cj(z + pad);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let k = 0; k < a.length; k += 3) {
            const dx = x - a[k], dz = z - a[k + 1];
            const rr = r + a[k + 2];
            if (dx * dx + dz * dz < rr * rr) return false;
          }
        }
      }
      const k = cj(z) * nx + ci(x);
      let a = cells[k];
      if (!a) { a = []; cells[k] = a; }
      a.push(x, z, r);
      if (r > maxR) maxR = r;
      return true;
    },
  };
}

// Is (x, z) inside — or within `margin` of — any building footprint?
function inFootprint(C, x, z, margin) {
  const m = margin > 0 ? margin : 0;
  const pv = -z;
  let hit = false;
  C.bIndex.query(x, z, m, (b) => {
    if (hit || !b.parts) return;
    if (x < b.bbox[0] - m || x > b.bbox[2] + m || z < b.bbox[1] - m || z > b.bbox[3] + m) return;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (partContains(part, x, pv)) { hit = true; return false; }
      if (m > 0 && closestOnRing(part.outer, x, pv).d2 < m * m) { hit = true; return false; }
    }
  });
  return hit;
}

// How deep inside a footprint (x, z) is, in metres; 0 outside. Used to drop the OSM footways that
// run straight through a tower without also dropping the ones that legitimately clip an arcade.
function footprintDepth(C, x, z) {
  const pv = -z;
  let best = 0;
  C.bIndex.query(x, z, 0.25, (b) => {
    if (!b.parts) return;
    if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
    for (let p = 0; p < b.parts.length; p++) {
      if (!partContains(b.parts[p], x, pv)) continue;
      const d = Math.sqrt(closestOnRing(b.parts[p].outer, x, pv).d2);
      if (d > best) best = d;
    }
  });
  return best;
}

// The building record whose footprint covers (x, z), or null. Used to decide where a corridor has
// a ceiling over it rather than the sky.
function coveringRecord(C, x, z) {
  const pv = -z;
  let found = null;
  C.bIndex.query(x, z, 0.25, (b) => {
    if (found || !b.parts) return;
    if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
    for (let p = 0; p < b.parts.length; p++) {
      if (partContains(b.parts[p], x, pv)) { found = b; return false; }
    }
  });
  return found;
}

// Carriageway index entry:
//   [ax, az, bx, bz, halfWidth, crowned, coverRadius, recordId, pavementRadius]
// Segments are filed under their bbox already grown by coverRadius, so a small query radius still
// finds a wide road.
function onCarriageway(C, x, z, pad) {
  let hit = false;
  C.roadIdx.query(x, z, pad, (s) => {
    if (hit) return false;
    const lim = s[4] + pad;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < lim * lim) { hit = true; return false; }
  });
  return hit;
}

// As above, but blind to one road — for asking "does MY pavement run out over somebody else's
// street", where the answer must not be yes just because my own kerb line is near my own kerb.
function onForeignCarriageway(C, x, z, pad, selfId) {
  let hit = false;
  C.roadIdx.query(x, z, pad, (s) => {
    if (hit) return false;
    if (s[7] === selfId) return;
    const lim = s[4] + pad;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < lim * lim) { hit = true; return false; }
  });
  return hit;
}

/**
 * Is this point already claimed by the pavement of a road that outranks `rec`?
 *
 * At every corner in the city two roads' pavement bands cover the same quadrant, at the same
 * height, in the same material — coincident surfaces the depth buffer resolves differently every
 * frame. One of them has to yield, and the order has to be total and stable or a corner ends up
 * with no pavement at all: the wider road wins, and the lower record id breaks a tie.
 */
function pavementTaken(C, x, z, rec) {
  let hit = false;
  C.roadIdx.query(x, z, 0, (s) => {
    if (hit) return false;
    const band = s[8];
    if (!(band > 0) || s[7] === rec.id) return;
    if (s[4] < rec.hw || (s[4] === rec.hw && s[7] > rec.id)) return;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < band * band) { hit = true; return false; }
  });
  return hit;
}

/**
 * Is there pavement at (x, z)? True where some road's band covers the point and no carriageway
 * does — which is exactly the geometry emitSidewalkBands() lays down, the rank rule only deciding
 * WHICH road paves an overlap, never whether it is paved. Kerb-level props are seated with this:
 * a lamp post where the band was cut away has to stand on the road, not on 16 cm of air.
 */
function onPavement(C, x, z) {
  if (onCarriageway(C, x, z, 0)) return false;
  let hit = false;
  C.roadIdx.query(x, z, 0, (s) => {
    if (hit) return false;
    const band = s[8];
    if (!(band > 0)) return;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < band * band) { hit = true; return false; }
  });
  return hit;
}

// Terrain-relative height for a prop that belongs on the pavement.
function kerbSeat(C, x, z) {
  return onPavement(C, x, z) ? ROAD_Y + CURB : ROAD_Y;
}

/**
 * The height of the HIGHEST carriageway covering (x, z), or -Infinity off the road network.
 *
 * Two streets crossing each other overlap for a whole junction box, and each ribbon crowns
 * independently, so paint laid MARK_LIFT above its own road can still sit several centimetres
 * under the crown of the road it crosses — which is exactly where the crossings and stop bars go.
 * Reconstructed from the index rather than from the ribbon, so it is an estimate: it samples the
 * terrain at the point instead of interpolating the ribbon's edges, which on this terrain differs
 * by about a centimetre. MARK_LIFT is twice that.
 */
function carriagewayTopY(C, x, z) {
  let out = -Infinity;
  C.roadIdx.query(x, z, 0.4, (s) => {
    const hw = s[4];
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) > hw * hw) return;
    let dx = s[2] - s[0], dz = s[3] - s[1];
    const l = Math.hypot(dx, dz);
    if (!(l > EPS)) return;
    dx /= l; dz /= l;
    const ux = -dz, uz = dx;                       // the crossing road's own side vector
    const o = clamp((x - s[0]) * ux + (z - s[1]) * uz, -hw, hw);
    const cx = x - ux * o, cz = z - uz * o;        // back on its centreline, same station
    // Rebuild the cross-section emitRibbon() laid: heights sampled at the ribbon's EDGES and
    // interpolated across, not the terrain read off at the point. Over a wide street on a slope
    // those differ by decimetres, which is ten times the lift the paint has to play with.
    // A depressed carriageway reads its own profile, exactly as its ribbon was laid: over a lid
    // the ground plane and the roadway under it are metres apart, and paint belongs to the road.
    const cor = s[9];
    const base = cor
      ? (bx, bz) => C.terrainY(bx, bz) - corridorDepth(cor, bx, bz)
      : C.groundY;
    let y;
    if (s[5]) {
      const sgn = o < 0 ? -1 : 1;
      const yMid = base(cx, cz) + ROAD_Y + CROWN;
      const yEdge = base(cx + ux * hw * sgn, cz + uz * hw * sgn) + ROAD_Y;
      y = yMid + (yEdge - yMid) * (Math.abs(o) / Math.max(hw, EPS));
    } else {
      const yn = base(cx - ux * hw, cz - uz * hw) + ROAD_Y;
      const yp = base(cx + ux * hw, cz + uz * hw) + ROAD_Y;
      y = yn + (yp - yn) * clamp((o + hw) / (2 * hw), 0, 1);
    }
    if (y > out) out = y;
  });
  return out;
}

// True where a synthetic sidewalk ribbon — or the carriageway itself — already covers this point,
// so a real OSM footway laid here would z-fight what is already on the ground.
function alreadyPaved(C, x, z) {
  let hit = false;
  C.roadIdx.query(x, z, 0.5, (s) => {
    if (hit) return false;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < s[6] * s[6]) { hit = true; return false; }
  });
  return hit;
}

// The crown height of the carriageway at (x, z), or -1 when it is not on one. This is what lets
// embedded tram rail sit IN the asphalt rather than hovering over the crest of a crowned street.
function carriagewayCrown(C, x, z) {
  let best = -1, out = -1;
  C.roadIdx.query(x, z, 0.4, (s) => {
    const hw = s[4];
    if (hw <= best) return;
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 > hw * hw) return;
    best = hw;
    out = s[5] ? CROWN * (1 - Math.sqrt(d2) / Math.max(hw, EPS)) : 0;
  });
  return out;
}

// Distance to the nearest carriageway centreline, or Infinity beyond `maxR`.
function nearestRoad(C, x, z, maxR) {
  let best = maxR * maxR;
  C.roadIdx.query(x, z, maxR, (s) => {
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 < best) best = d2;
  });
  return best < maxR * maxR ? Math.sqrt(best) : Infinity;
}

/**
 * Reserve a ground-level prop site. Nothing may land inside a building footprint, on a
 * carriageway (pass roadPad < 0 for the parked cars, median poles and gutter hardware that
 * legitimately do), on top of another prop, or UNDER AN ELEVATED DECK it does not fit beneath.
 *
 * `height` is how far the prop stands above its seat; omit it and the class's entry in PROP_H is
 * used. That default is what makes the deck rule apply to the whole city rather than to the lamps
 * somebody remembered — a 7 m street tree planted under the Gardiner is the same bug as a mast.
 * @returns {number} the terrain height at the site, or NaN when the site is refused
 */
function reserve(C, kind, x, z, r, roadPad, height) {
  if (!isNum(x) || !isNum(z)) return NaN;
  if (inFootprint(C, x, z, r * 0.55 + 0.30)) return NaN;
  if (roadPad >= 0 && onCarriageway(C, x, z, roadPad)) return NaN;
  const h = isNum(height) ? height : (PROP_H[kind] || 0);
  if (h > 0 && deckHeadroom(C, x, z) < h + DECK_CLEAR) {
    C.stats.deck.propsSkipped++;
    return NaN;
  }
  if (!C.occ.claim(x, z, r)) return NaN;
  C.stats.props[kind] = (C.stats.props[kind] || 0) + 1;
  if (roadPad >= 0) C.audit.push(x, z); else C.auditRoad.push(x, z);
  const y = C.groundY(x, z);
  if (h > 0) C.auditDeck.push(x, z, y, h);
  return y;
}

// A prop that is not on the ground plane at all — roofscape, marine, rolling stock. Counted, but
// never audited against footprints, because standing on a building is the entire point.
function noteProp(C, kind) {
  C.stats.props[kind] = (C.stats.props[kind] || 0) + 1;
}

/**
 * Record a real light source at its LENS — the point light goes where the luminaire is, never at
 * the foot of its post (render.js setLights(), which says so explicitly: a light at the base of a
 * mast lights the mast).
 *
 * WHY THIS EXISTS. Until now a street lamp was geometry and nothing else. The renderer has had a
 * clustered local-light rig the whole time and no caller ever registered anything with it, so
 * `lightStats.registered` sat at 0 and the night image had exactly one light in it: the sky. The
 * road went black, the lamps glowed without illuminating, and walking Queen Street at 23:30 read
 * as a power cut rather than as Toronto.
 *
 * DETERMINISM AND TILES. Tiles build lazily, in any order, and a tile that is evicted and rebuilt
 * runs this again. The key is quantised WORLD POSITION plus kind (CONTRACT §8.4 — never an array
 * index), so the same lamp registers once no matter how many times its tile is rebuilt and the
 * set is identical whichever order the tiles arrived in.
 *
 * TIME OF DAY. Nothing here decides WHEN a lamp is on (CONTRACT Amendment 7); it says only that a
 * luminaire exists at this point. The renderer's own night ramp owns the switch, and the rig is
 * measurably dark at Afternoon: 0 lights uploaded, against 512 at Night.
 */
function noteLight(C, kind, x, y, z) {
  if (!C.lampList || !isNum(x) || !isNum(y) || !isNum(z)) return;
  const key = kind + '|' + Math.round(x * 4) + '|' + Math.round(y * 4) + '|' + Math.round(z * 4);
  if (C.lampKey.has(key)) return;
  C.lampKey.add(key);
  C.lampList.push({ x, y, z, kind });
  C.lampsDirty = true;
}

/*
 * The three lamp builders, each paired with the light it actually casts.
 *
 * These exist so a luminaire's GEOMETRY and its LENS POSITION are written in one place. The offsets
 * below are read straight off props.js: a cobra's LED head spans local x 2.28..3.36 at mast + 0.70,
 * a pedestrian head spans 0.56..0.96 at mast + 0.06, and an acorn's globe sits 0.56 m below its
 * finial. props.js's local frame puts "forward" at (cos yaw, -sin yaw) in world XZ — the same
 * convention the boom-aim audit above uses.
 */
function lampCobra(C, mb, x, base, z, yaw, mast) {
  appendCobraLamp(mb, x, base, z, yaw, mast);
  noteLight(C, 'cobra', x + Math.cos(yaw) * 2.82, base + mast + 0.70, z - Math.sin(yaw) * 2.82);
}

function lampPedestrian(C, mb, x, base, z, yaw, mast) {
  appendPedestrianLamp(mb, x, base, z, yaw, mast);
  noteLight(C, 'ped', x + Math.cos(yaw) * 0.76, base + mast + 0.06, z - Math.sin(yaw) * 0.76);
}

function lampAcorn(C, mb, x, base, z, mast) {
  appendAcornLamp(mb, x, base, z, mast);
  noteLight(C, 'acorn', x, base + mast - 0.56, z);
}

function inAcornZone(x, z) {
  for (let i = 0; i < ACORN_ZONES.length; i++) {
    const a = ACORN_ZONES[i];
    if (Math.hypot(x - a[0], z - a[1]) < a[2]) return true;
  }
  return false;
}

function isBikeStreet(name) {
  if (typeof name !== 'string' || !name) return false;
  for (let i = 0; i < BIKE_STREETS.length; i++) {
    if (name.indexOf(BIKE_STREETS[i]) === 0) return true;
  }
  return false;
}



/* ================================================== elevated deck cover == */
/**
 * THE GARDINER PROBLEM.
 *
 * The expressway is a road record with `b: 1`, so it is built as a deck 8.2 m up with a 1.9 m
 * structural depth hanging under it. Lake Shore Boulevard, Harbour Street and half a dozen cross
 * streets run underneath at grade — and every one of them is an ordinary road record that gets an
 * ordinary 9.6 m cobra lamp every 28 m, planted on the ground and driven straight up through the
 * expressway. The expressway's OWN lamps were worse: a bridge record's furniture was seated with
 * groundY(), so the Gardiner's street lighting stood on the ground beneath the Gardiner and came
 * up through its deck.
 *
 * The fix needs one thing the rest of the city never asks for: what is directly overhead. This
 * index answers that. Every deck segment is filed with the height of its SOFFIT — the underside
 * of the structure, not the running surface, because that is what a lamp mast hits — and
 * deckHeadroom() reports the clear air above any point on the ground.
 *
 * With that, three rules:
 *   * a prop that does not fit under the deck is refused (reserve() does this for every prop in
 *     the city, using its real height, not just lamps);
 *   * a LAMP that does not fit is rebuilt as a low-mast fixture that does, which is what is
 *     actually bolted under the Gardiner in real life;
 *   * the deck itself gets its lighting placed ON its carriageway, at deck level.
 * The audit at the end of the load re-measures every prop against the finished index.
 */

const DECK_CLEAR = 0.70;           // air a prop must leave under a soffit: its seat plus a margin
const UNDER_DECK_MIN = 3.2;        // shorter than this and it is not a street lamp any more
const DECK_EDGE_INSET = 0.9;       // how far in from the deck edge its own lamps stand
const DECK_LAMP_H = { motorway: 11.0, major: 9.0, minor: 8.0, service: 7.0 };

// How far each lamp's geometry reaches ABOVE its nominal mast height, from props.js: a cobra's
// arm crests 0.93 m over the mast, a pedestrian lamp's 0.32 m, an acorn's globe is inside its
// own figure. Under a soffit the difference between the mast and the top of the arm is the
// difference between a lamp that fits and one that does not.
const LAMP_OVER = { cobraLamp: 1.00, pedestrianLamp: 0.35, acornLamp: 0.10 };

// Standing height of each prop class, metres above its own seat. Used to decide what fits under a
// deck; deliberately rounded UP, because the cost of over-estimating is one missing litter bin and
// the cost of under-estimating is a mast through the expressway.
const PROP_H = {
  cobraLamp: 13.0, pedestrianLamp: 5.6, acornLamp: 5.0, trafficSignal: 7.2, signPost: 3.2,
  catenaryPole: 8.8, streetTree: 7.0, parkTree: 10.0, shrub: 1.8, planter: 1.6,
  transitShelter: 3.0, platformShelter: 3.6, litterBin: 1.2, bench: 1.0, bikeRing: 1.0,
  hydrant: 1.0, parkingMachine: 1.6, newsBox: 1.4, mailbox: 1.4, utilityBox: 1.6, bollard: 1.1,
  sandwichBoard: 1.3, patioSet: 2.6, dumpster: 2.0, scaffold: 6.8, crane: 96.0, flagPole: 12.5,
  parkedCar: 2.1, lotCar: 2.1, railCar: 5.2, ferryDock: 4.0, boat: 6.0, grate: 0.1, manhole: 0.1,
  pedestrian: 2.1, cyclist: 2.2, dogWalker: 2.1,
  // Surveyed classes (data/toronto.json pois[]).
  drinkingFountain: 1.1, fountainBasin: 1.0, billboard: 5.0, adColumn: 3.3, utilityPole: 12.0,
  stopFlag: 3.1, subwayEntrance: 3.6, vendingMachine: 2.0, payphone: 2.1,
};

// Soffit interpolation along one filed segment: [ax, az, bx, bz, halfWidth, soffitA, soffitB].
function deckSoffitAbove(C, x, z, y) {
  const idx = C.deckIdx;
  let best = Infinity;
  if (!idx) return best;
  idx.query(x, z, 0, (s) => {
    const hw = s[4];
    const dx = s[2] - s[0], dz = s[3] - s[1];
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
    const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
    if (qx * qx + qz * qz > hw * hw) return;
    const soffit = s[5] + (s[6] - s[5]) * t;
    if (soffit > y && soffit < best) best = soffit;
  });
  return best;
}

/** Metres of clear air above the ground at (x, z) before the underside of a deck. */
function deckHeadroom(C, x, z) {
  const g = C.groundY(x, z);
  const soffit = deckSoffitAbove(C, x, z, g);
  if (soffit === Infinity) return Infinity;
  const head = soffit - g;
  const D = C.stats.deck;
  if (!D.minClearance || head < D.minClearance) D.minClearance = head;
  return head;
}

/** The same question asked from a height that is not the ground — a prop standing on a deck. */
function deckHeadroomAt(C, x, z, y) {
  const soffit = deckSoffitAbove(C, x, z, y + 0.25);
  return soffit === Infinity ? Infinity : soffit - y;
}

/**
 * Deck test for the prop classes that claim their own site instead of going through reserve():
 * catenary poles, rolling stock, parked cars, cranes. Records the prop for the end-of-load audit
 * on success, counts the refusal on failure.
 */
function deckFits(C, x, z, y, h) {
  if (deckHeadroomAt(C, x, z, y) < h + DECK_CLEAR) {
    C.stats.deck.propsSkipped++;
    return false;
  }
  C.auditDeck.push(x, z, y, h);
  return true;
}

/** The nearest carriageway RECORD to a point, with its distance. Null past `maxR`. */
const _nrec = { rec: null, d: Infinity };
function nearestRoadRec(C, x, z, maxR) {
  let best = maxR * maxR;
  let idx = -1;
  C.roadIdx.query(x, z, maxR, (s) => {
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 < best) { best = d2; idx = s[7]; }
  });
  _nrec.rec = idx >= 0 && C.recs ? C.recs[idx] : null;
  _nrec.d = idx >= 0 ? Math.sqrt(best) : Infinity;
  return _nrec.rec;
}

/**
 * How far away the record nearestRoadRec() last found was. Kept as a companion reader rather than
 * returned in a pair so the query stays allocation-free — every caller in the tree already read it
 * this way, out of one shared scratch record, and this is that scratch kept private.
 */
function nearestRoadDist() {
  return _nrec.d;
}


/**
 * Build the street-detail context for one load.
 *
 * `mb`, `rng`, `occ`, `stats` and the site lists all belong to the tile being built and are
 * rebound per tile; the indices below are global and read-only once this returns. Everything the
 * detail passes need arrives through this one object, which is what makes them agree with each
 * other about where the ground, the kerb and the buildings are.
 */
function makeDetailContext(W) {
  const {
    mb, groundY, terrainY, gradeField, bIndex, roadIdx, deckIdx, extent, gx0, gz0,
    poisRaw, railsRaw, recs, stats, font, surWalk, harbour, rawY, realFoot,
  } = W;
  // One context object, rebound per tile. `mb`, `rng`, `occ`, `stats` and the site lists all
  // belong to the tile being built; the indices are global and read-only from here on.
  const tramIdx = makeGridIndex(24, gx0, gz0,
    Math.ceil((extent.x + 800) / 24) + 1, Math.ceil((extent.z + 800) / 24) + 1);
  // Surveyed nodes, indexed at the coarsest cell any suppression radius needs (postbox, 34 m).
  const poiIdx = makeGridIndex(36, gx0, gz0,
    Math.ceil((extent.x + 800) / 36) + 1, Math.ceil((extent.z + 800) / 36) + 1);
  for (let i = 0; i < poisRaw.length; i++) {
    const q = poisRaw[i];
    poiIdx.add(q.x, q.z, q.x, q.z, q);
  }
  stats.survey.total = poisRaw.length;
  const C = {
    mb, groundY, terrainY, grade: gradeField, bIndex, roadIdx, tramIdx, deckIdx,
    rng: makeRng(SEED), stats, pedSeed: PED_SEED, tilePeople: 0,
    // Carriageway records, by the index roadIdx stores in its segments: the block-face model
    // needs the street a frontage faces, not just how far away it is.
    recs,
    // Every surveyed node, indexed for the suppression query: a procedural lamp, tree, bench or
    // bin is not placed where the survey already has one of its class.
    poiIdx,
    // The glyph atlas. Built once per GL context and shared with render.js, which binds the same
    // texture; null on any platform without a 2-D canvas, and every caller handles that.
    font,
    // How far into the synthesised fringe a street still gets a kerb and a pavement: exactly as
    // far as the soft limit lets anyone walk, plus a block. Past that nobody is ever closer than
    // a few hundred metres and the detail returns nothing (CONTRACT §9.3).
    surWalk,
    harbour, rawY, realFoot,
    occ: makeOccupancy(5.0, gx0, gz0,
      Math.ceil((extent.x + 800) / 5) + 1, Math.ceil((extent.z + 800) / 5) + 1),
    // Sites the people pass draws on, recorded by the passes that built them so nobody is
    // scattered anywhere the city has not already said is walkable.
    stations: [], corners: [], benches: [], walks: [], plazas: [], retail: [],
    crowd: new Map(),
    audit: [], auditRoad: [], auditDeck: [], auditPed: [],
    // THE LOCAL LIGHT REGISTRY. Every lamp this build places also records its LENS here, and
    // update() hands the accumulated set to render.js's clustered rig. See noteLight().
    lampList: [], lampKey: new Set(), lampsDirty: false,
  };

  for (let i = 0; i < railsRaw.length; i++) {
    const r = railsRaw[i];
    if (!r || r.k !== 'tram' || !Array.isArray(r.p) || r.p.length < 2) continue;
    for (let k = 1; k < r.p.length; k++) {
      const a = r.p[k - 1], b = r.p[k];
      if (!isNum(a[0]) || !isNum(b[0])) continue;
      tramIdx.add(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1,
        Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, [a[0], a[1], b[0], b[1]]);
    }
  }

  return C;
}

export {
  ACORN_ZONES, BIKE_STREETS, nearestRoadRec, nearestRoadDist, makeDetailContext,
  makeOccupancy, inFootprint, footprintDepth, coveringRecord,
  onCarriageway, onForeignCarriageway, pavementTaken, onPavement, kerbSeat,
  carriagewayTopY, alreadyPaved, carriagewayCrown, nearestRoad,
  reserve, noteProp, noteLight, lampCobra, lampPedestrian, lampAcorn,
  inAcornZone, isBikeStreet,
  DECK_CLEAR, UNDER_DECK_MIN, DECK_EDGE_INSET, DECK_LAMP_H, LAMP_OVER, PROP_H,
  deckSoffitAbove, deckHeadroom, deckHeadroomAt, deckFits,
};
