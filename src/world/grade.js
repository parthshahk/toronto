// src/world/grade.js — grade separation: which way passes over which, and how far it moves.
//
// CONTRACT.md §8.1 and Amendment 11.1. Moved out of city.js unchanged. This is the SOLVE, not the
// geometry: it decides, for every road and rail way in the extract, whether it stays at grade,
// dips into a trench, runs underground, is carried over on a deck or passes through a building —
// and by how much, ramped over a realistic distance.
//
//   classifyWay()     the extract's signed `lay` and `tun` -> one of the five WAY_* kinds.
//   makeNodeSet()     welds coincident way endpoints into shared nodes.
//   makeGradeField()  the corridor index, and the offset field that composes the walking surface:
//                     groundY = terrain + field.offset(x, z).
//   findCrossings()   where two ways cross in plan, which is where a clearance is owed.
//   solveGrade()      the priority solve over all of that.
//   corridorDepth()   how deep a corridor is at the point of it nearest (x, z).
//
// The structures the solve implies — retaining walls, verges, portals, ceilings — are emitted by
// world/trench.js, which reads what this module produced.
//
// This file is a little over the ~800-line target and stays one file deliberately: the solver, the
// field it writes and the constants both are expressed in are one unit, and every seam that could
// be cut here would have to be sewn back up with an import cycle.

import { clamp, smoothstep } from '../core/math.js';
import { isNum } from '../core/util.js';
import { makeGridIndex } from '../data/index.js';
import { makeNodeSet, makeMaxHeap, heapValue } from './weld.js';
import {
  EPS, ROAD_Y, BRIDGE_RISE, ROAD_CLASS_OK, SIDEWALK_W, WALK_CLASS, distToSeg2,
} from './ground.js';

/* ========================================================= grade separation == */

/**
 * Where a way sits relative to the ground.
 *
 * The extract's `lay` is a SIGNED OSM layer and `tun` distinguishes a bored tunnel from a
 * building passage; the previous encoding collapsed both into "elevated or deleted", which built
 * 750 underpasses as flyovers and deleted 712 ways outright. Those two mistakes are most of what
 * a pedestrian walks into.
 */
const WAY_GRADE = 0;      // on the ground
const WAY_UNDER = 1;      // depressed carriageway: dips, retaining walls, portal, deck overhead
const WAY_SUB = 2;        // genuinely underground: the PATH concourse network
const WAY_OVER = 3;       // carried over what it crosses: deck, abutments, piers
const WAY_PASSAGE = 4;    // building_passage: stays at grade, stays walkable

const UNDER_CLEAR = 4.50;          // clear headroom demanded under a structure
const RAIL_DECK = 0.95;            // depth of a rail bridge deck below the ballast base
const RAIL_BED = 0.10;             // ballast base above terrain, as the rail pass lays it
const ROAD_DECK = {                // depth of a road bridge deck below its carriageway
  motorway: 1.9, major: 1.3, minor: 1.3, service: 1.1, pedestrian: 0.8, foot: 0.8,
};
const LAYER_DROP = 5.40;           // one negative layer, which is exactly rail clearance
const DEPTH_MAX = 13.0;
const RAMP_GRADE = 0.10;           // 10% — steep for a street, ordinary for an underpass approach
const RAMP_MIN = 30.0;             // CONTRACT 8.1: ramped over 30-80 m depending on depth, so a
const RAMP_MAX = 80.0;             // shallow dip still eases in and a deep one is not a cliff
const RAIL_GRADE = 0.020;          // a railway ramps at 2%, not at a street's 10%
const RAIL_RISE_MAX = 5.00;        // ...and no further than a downtown embankment plausibly goes
const TRENCH_FLOOR = -0.30;        // the deepest a carriageway may be cut, above the lake datum
const TRENCH_WALL = 0.45;          // retaining wall thickness
const TRENCH_MITER = 0.50;         // slack for the mitre throwing the kerb line out at a corner
const TRENCH_VERGE = 3.50;         // paved verge over the ragged edge of the terrain cut
const TRENCH_CUT = 0.50;           // terrain removed this far beyond the wall's outer face
const CUT_MIN = 0.35;              // shallower than this and the corridor is not a cut at all
const SUB_HEAD = 3.20;             // headroom in an underground concourse
const SUB_COVER = 0.80;            // earth left over its ceiling
const PASSAGE_HEAD = 4.60;         // clear height of a building passage
const PASS_HEAD = 2.10;            // eye height plus a hat: what a walker needs to pass under
const TUNNEL_LAMP_PITCH = 11.0;    // metres between batten luminaires under a tunnel soffit
const TUNNEL_LAMP_MIN = 2.60;      // a fixture lower than this over the road is not a tunnel light
const TUNNEL_LAMP_H = 3.70;        // how far over the carriageway a batten hangs, clear of any deck
const SUB_SEG = 45.0;              // resampling step for an underground corridor
const COVER_PAD = 7.0;             // how far a crossing structure counts as roofing the corridor
const CROSS_MIN_SIN = 0.30;        // sin(17.5 deg): shallower than this and they are parallel
const GRADE_CELL = 12.0;           // corridor index cell; also the active-mask resolution

/**
 * The gradient a corridor of this depth descends at.
 *
 * RAMP_GRADE where that lands the ramp inside the 30-80 m CONTRACT 8.1 asks for, and stretched or
 * shortened to the nearest end of that band where it does not: a 1.5 m dip taken at 10% would be
 * over in fifteen metres and read as a pothole, and a 13 m one would need a hundred and thirty.
 */
function rampGrade(depth) {
  if (!(depth > 0)) return RAMP_GRADE;
  return clamp(RAMP_GRADE, depth / RAMP_MAX, depth / RAMP_MIN);
}

/** Depth an UNDER way wants purely from its layer, before any clearance requirement. */
function layerDepth(lay, tun) {
  const levels = lay < 0 ? -lay : (tun === 1 ? 1 : 0);
  return Math.min(DEPTH_MAX, LAYER_DROP * levels);
}

function classifyWay(r) {
  const lay = isNum(r.lay) ? clamp(Math.round(r.lay), -4, 4) : 0;
  const tun = r.tun | 0;
  if (tun === 2) return WAY_PASSAGE;
  if (tun === 1 || lay < 0) {
    // Toronto's underground pedestrian network is the PATH, and every metre of it is a footway
    // under a building. Vehicular tunnels are streets. That split is what keeps a concourse from
    // tearing a 5 m pit through the sidewalk above it, and it needs no bounding box to decide.
    return (r.c === 'foot' || r.c === 'pedestrian') ? WAY_SUB : WAY_UNDER;
  }
  if (r.b === 1 || lay > 0) return WAY_OVER;
  return WAY_GRADE;
}


/* --------------------------------------------------------- corridor index -- */

/**
 * The vertical offset the ground takes along every depressed corridor, plus the footprint of the
 * cut that has to be taken out of the terrain to expose it.
 *
 * This is the single authority: `groundY` composes it with the terrain, the carriageway ribbons
 * are laid on the same composition, the pavement bands and every prop follow `groundY`, and the
 * terrain mesh removes exactly the cells the cut covers. Nothing can disagree with anything else
 * because there is only one number.
 *
 * A coarse active mask makes the common case — the 99% of the map with no corridor anywhere near
 * — a single array read, so composing it into `groundY` costs nothing where nothing is happening.
 */
// Scratch for makeGradeField().span(). One field, one reader at a time, no allocation on a query
// that runs several times per frame under the player's feet.
const _span = {
  hit: false, d2: 0, dep: 0, hw: 0, chw: 0, pass: false, roofed: false, way: -1, dx: 1, dz: 0,
};

function makeGradeField(extent) {
  const pad = 400;
  const x0 = -extent.x / 2 - pad, z0 = -extent.z / 2 - pad;
  const nx = Math.ceil((extent.x + 2 * pad) / GRADE_CELL) + 2;
  const nz = Math.ceil((extent.z + 2 * pad) / GRADE_CELL) + 2;
  const idx = makeGridIndex(GRADE_CELL, x0, z0, nx, nz);
  // Two masks, because they answer different questions at very different costs. `active` says
  // "there is a corridor near here", which makes composing the offset into groundY free
  // everywhere else. `cutMask` says "the terrain is actually open here", and it is what decides
  // whether a 25 m terrain cell has to be rebuilt at CUT_SUB — so it must stay tight, or the
  // approach ramp of every underpass refines half a hectare of ground that never opens.
  const active = new Uint8Array(nx * nz);
  const cutMask = new Uint8Array(nx * nz);
  let any = false;
  const mark = (into, ax, az, bx, bz, r) => {
    const i0 = clamp(Math.floor((Math.min(ax, bx) - r - x0) / GRADE_CELL), 0, nx - 1);
    const i1 = clamp(Math.floor((Math.max(ax, bx) + r - x0) / GRADE_CELL), 0, nx - 1);
    const j0 = clamp(Math.floor((Math.min(az, bz) - r - z0) / GRADE_CELL), 0, nz - 1);
    const j1 = clamp(Math.floor((Math.max(az, bz) + r - z0) / GRADE_CELL), 0, nz - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) into[j * nx + i] = 1;
  };
  const hot = (x, z) => {
    if (!any) return false;
    const i = Math.floor((x - x0) / GRADE_CELL), j = Math.floor((z - z0) / GRADE_CELL);
    if (i < 0 || i >= nx || j < 0 || j >= nz) return false;
    return active[j * nx + i] === 1;
  };
  return {
    hot,
    /**
     * Segment entry:
     *   [ax, az, bx, bz, halfWidth, depthA, depthB, cutHalfWidth, over, way, carriageHalfWidth]
     * `over` is 0 open cut, 1 roofed by a street carried across, 2 a building passage at grade.
     */
    add(ax, az, bx, bz, hw, da, db, roofed, way, chw) {
      const cut = hw + TRENCH_WALL + TRENCH_CUT;
      idx.add(Math.min(ax, bx) - cut, Math.min(az, bz) - cut,
        Math.max(ax, bx) + cut, Math.max(az, bz) + cut,
        [ax, az, bx, bz, hw, da, db, cut, roofed ? 1 : 0, way, isNum(chw) ? chw : hw]);
      mark(active, ax, az, bx, bz, cut);
      if (!roofed && Math.max(da, db) > CUT_MIN) mark(cutMask, ax, az, bx, bz, cut);
      any = true;
    },
    /**
     * A building passage: at grade, so it cuts nothing and drops nothing, but it is still a hole
     * through whatever stands over it. Filed alongside the corridors so a single `span` query
     * answers the only question the wall pass and the player's collision both ask — "is the way
     * through here open?" — for underpasses and passages alike.
     */
    addPassage(ax, az, bx, bz, hw) {
      idx.add(Math.min(ax, bx) - hw, Math.min(az, bz) - hw,
        Math.max(ax, bx) + hw, Math.max(az, bz) + hw,
        [ax, az, bx, bz, hw, 0, 0, hw, 2, -1, hw]);
      mark(active, ax, az, bx, bz, hw);
      any = true;
    },
    /**
     * The corridor covering (x, z), or null. Same nearest-segment rule as `offset`, but roofed
     * spans and passages count too, because what is being asked here is not "how far has the
     * ground dropped" but "is there a way through". The returned record is a SHARED scratch
     * object, valid only until the next call — read it, never keep it.
     */
    span(x, z) {
      if (!hot(x, z)) return null;
      let near = Infinity;
      _span.hit = false;
      idx.query(x, z, 0, (s) => {
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 > s[4] * s[4] || d2 >= near) return;
        near = d2;
        const l = Math.sqrt(l2);
        _span.hit = true;
        _span.d2 = d2;
        _span.dep = s[5] + (s[6] - s[5]) * t;
        _span.hw = s[4];
        _span.chw = s[10];
        _span.pass = s[8] === 2;
        _span.roofed = s[8] === 1;
        _span.way = s[9];
        _span.dx = l > EPS ? dx / l : 1;
        _span.dz = l > EPS ? dz / l : 0;
      });
      return _span.hit ? _span : null;
    },
    /**
     * Metres the walkable ground drops at (x, z); 0 (never positive) off every corridor.
     *
     * The NEAREST covering segment wins, not the deepest. A corridor is filed as a chain of short
     * segments whose half-width is far greater than their length, so every point is covered by
     * several of them at once; taking the deepest makes each point see the low end of whichever
     * neighbouring segment reaches it, and the smooth ramp comes out as a staircase with half-metre
     * risers every few metres — which is exactly what the cliff audit then reports. Nearest gives
     * the segment the point is actually on, and with it the linear interpolation along the ramp.
     */
    offset(x, z) {
      if (!hot(x, z)) return 0;
      let drop = 0, near = Infinity;
      idx.query(x, z, 0, (s) => {
        // A roofed span has ground over it, and the walking surface IS that ground. This is the
        // invariant the whole thing rests on: groundY dips exactly where the terrain has been cut
        // away and nowhere else, so the player can never be walking below what they can see.
        if (s[8]) return;
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const hw = s[4];
        const d2 = qx * qx + qz * qz;
        if (d2 > hw * hw) return;
        const d = s[5] + (s[6] - s[5]) * t;
        // Ties go to the deeper corridor: two carriageways of the same street overlap completely,
        // and the ground between them belongs to whichever one is further down.
        if (d2 < near - 1e-6 || (d2 < near + 1e-6 && d > drop)) { near = d2; drop = d; }
      });
      return -drop;
    },
    /** Is (x, z) inside the footprint the cut takes out of the terrain? */
    cut(x, z) {
      if (!hot(x, z)) return false;
      let hit = false;
      idx.query(x, z, 0, (s) => {
        if (hit || s[8]) return;                     // a roofed corridor keeps its lid of ground
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const r = s[7];
        if (qx * qx + qz * qz > r * r) return;
        if (s[5] + (s[6] - s[5]) * t > CUT_MIN) { hit = true; return false; }
      });
      return hit;
    },
    /** Does the axis-aligned box touch any cut footprint at all? Cheap terrain-mesh reject. */
    boxHot(ax, az, bx, bz) {
      if (!any) return false;
      const i0 = clamp(Math.floor((ax - x0) / GRADE_CELL), 0, nx - 1);
      const i1 = clamp(Math.floor((bx - x0) / GRADE_CELL), 0, nx - 1);
      const j0 = clamp(Math.floor((az - z0) / GRADE_CELL), 0, nz - 1);
      const j1 = clamp(Math.floor((bz - z0) / GRADE_CELL), 0, nz - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (cutMask[j * nx + i]) return true;
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------- crossings --- */

/**
 * Every place two linear features actually cross in plan, derived from segment intersection —
 * never from a shared node, never assumed from a bounding box. CONTRACT 8.1 requires the way with
 * the higher layer to pass above, and that cannot be decided without knowing where they meet.
 *
 * Cost is linear in feature count: segments are filed in a uniform grid and each is tested only
 * against the ones sharing a cell.
 */
function findCrossings(lines, extent, visit) {
  const cell = 24;
  const pad = 400;
  const x0 = -extent.x / 2 - pad, z0 = -extent.z / 2 - pad;
  const nx = Math.ceil((extent.x + 2 * pad) / cell) + 2;
  const nz = Math.ceil((extent.z + 2 * pad) / cell) + 2;
  const idx = makeGridIndex(cell, x0, z0, nx, nz);
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l].p;
    if (!Array.isArray(p)) continue;
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k];
      if (!isNum(a[0]) || !isNum(a[1]) || !isNum(b[0]) || !isNum(b[1])) continue;
      idx.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
        Math.max(a[0], b[0]), Math.max(a[1], b[1]), [a[0], a[1], b[0], b[1], l, k]);
    }
  }
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l].p;
    if (!Array.isArray(p)) continue;
    for (let k = 1; k < p.length; k++) {
      const ax = p[k - 1][0], az = p[k - 1][1], bx = p[k][0], bz = p[k][1];
      if (!isNum(ax) || !isNum(az) || !isNum(bx) || !isNum(bz)) continue;
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const rad = Math.hypot(bx - ax, bz - az) * 0.5;
      idx.query(mx, mz, rad, (s) => {
        // Each unordered pair once, and never a way against itself.
        if (s[4] <= l) return;
        const cx = s[0], cz = s[1], dx = s[2], dz = s[3];
        const r1x = bx - ax, r1z = bz - az;
        const r2x = dx - cx, r2z = dz - cz;
        const den = r1x * r2z - r1z * r2x;
        if (Math.abs(den) < 1e-12) return;
        const t = ((cx - ax) * r2z - (cz - az) * r2x) / den;
        const u = ((cx - ax) * r1z - (cz - az) * r1x) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) return;
        // Two ways running side by side weave across each other every few metres; each of those
        // touches is a digitising artifact, not a grade-separated crossing. |sin| between the two
        // segments IS the normalised determinant, so the filter is one divide.
        const l1 = Math.hypot(r1x, r1z), l2 = Math.hypot(r2x, r2z);
        if (!(l1 > EPS) || !(l2 > EPS)) return;
        if (Math.abs(den) / (l1 * l2) < CROSS_MIN_SIN) return;
        visit(l, k, s[4], s[5], ax + r1x * t, az + r1z * t);
      });
    }
  }
}

/* ----------------------------------------------------------- the solver ---- */

/**
 * Decide, once, how far above or below the terrain every way sits — and hand back the field the
 * rest of the load reads it from.
 *
 * Four things happen here, in order, and none of them knows anything about this bounding box:
 *   1. every way is classified (at grade / depressed / underground / carried over / passage);
 *   2. every place two ways or a way and a railway actually CROSS is found by segment
 *      intersection, and the pair's layers decide which one is above;
 *   3. the depth each depressed way needs for real headroom under whatever crosses it propagates
 *      outward through the connected street graph at a fixed maximum gradient, so the approach
 *      ramps land on the streets that really carry them and every transition is ramped;
 *   4. the result is rasterised into the corridor field that `groundY` composes with the terrain.
 *
 * @returns {object} kinds, per-way depth and rise profiles, the corridor field and the shared
 *                   street graph the walkability audit runs on.
 */
function solveGrade(roadsRaw, railsRaw, buildingsRaw, extent, terrainY, stats) {
  const n = roadsRaw.length;
  const kind = new Int8Array(n);
  const lay = new Int8Array(n);
  const hwOf = new Float64Array(n);
  const chwOf = new Float64Array(n);
  const clsOf = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = roadsRaw[i];
    kind[i] = classifyWay(r);
    lay[i] = isNum(r.lay) ? clamp(Math.round(r.lay), -4, 4) : 0;
    const cls = ROAD_CLASS_OK[r.c] ? r.c : 'minor';
    clsOf[i] = cls;
    const w = clamp(isNum(r.w) ? r.w : 8, 1.6, 44);
    const sw = SIDEWALK_W[cls] || 0;
    // The corridor is as wide as the ground the way actually claims: carriageway, both pavements,
    // and the slack a mitred corner throws the kerb line out by.
    hwOf[i] = w / 2 + (sw > 0 ? 0.25 + sw : 0.60) + TRENCH_MITER;
    // ...but the hole a corridor punches through a wall is only as wide as the corridor itself.
    // A building that merely LINES a depressed street stands at the back of its pavement, which
    // is inside hwOf; opening the ground floor of every such building would be vandalism.
    chwOf[i] = w / 2 + 0.40;
  }

  /* --- 1. the shared street graph ---------------------------------------- */
  const set = makeNodeSet(0.30);
  const wayNodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = roadsRaw[i].p;
    if (!Array.isArray(p) || p.length < 2) { wayNodes[i] = null; continue; }
    const ids = new Int32Array(p.length);
    for (let k = 0; k < p.length; k++) {
      ids[k] = (isNum(p[k][0]) && isNum(p[k][1])) ? set.at(p[k][0], p[k][1]) : -1;
    }
    wayNodes[i] = ids;
  }
  const nodeCount = set.count;
  const adj = new Array(nodeCount);
  const degree = new Int32Array(nodeCount);
  const touch = new Uint8Array(nodeCount);        // bit 1 surface way, bit 2 depressed way
  for (let i = 0; i < n; i++) {
    const ids = wayNodes[i];
    if (!ids) continue;
    const k0 = kind[i];
    const surface = k0 === WAY_GRADE || k0 === WAY_PASSAGE || k0 === WAY_OVER;
    const p = roadsRaw[i].p;
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] < 0) continue;
      touch[ids[k]] |= surface ? 1 : (k0 === WAY_UNDER ? 2 : 4);
      if (k === 0) continue;
      const a = ids[k - 1], b = ids[k];
      if (a < 0 || b < 0 || a === b) continue;
      const len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      (adj[a] || (adj[a] = [])).push(b, len, i);
      (adj[b] || (adj[b] = [])).push(a, len, i);
      degree[a]++; degree[b]++;
    }
  }

  /* --- 2. crossings ------------------------------------------------------- */
  // Roads first, then the railways that are not underground, in one index so a road/rail crossing
  // costs no more than a road/road one.
  const lines = new Array(n);
  for (let i = 0; i < n; i++) lines[i] = roadsRaw[i];
  // Line index -> railsRaw index. Subway ways are not in `lines` at all, so the two run out of
  // step immediately and the map has to be explicit; indexing railsRaw by (line - n) attaches
  // every rail deck to the wrong piece of track.
  const railFor = [];
  for (let i = 0; i < railsRaw.length; i++) {
    const ra = railsRaw[i];
    if (!ra || ra.k === 'subway' || !Array.isArray(ra.p) || ra.p.length < 2) continue;
    railFor[lines.length - n] = i;
    lines.push(ra);
  }
  const levelOf = (l) => {
    if (l >= n) return 0;                          // a railway is on the ground
    const k = kind[l];
    if (k === WAY_OVER) return Math.max(1, lay[l]);
    if (k === WAY_UNDER || k === WAY_SUB) return Math.min(-1, lay[l]);
    return 0;
  };
  const deckOf = (l) => (l >= n ? RAIL_DECK : (ROAD_DECK[clsOf[l]] || 1.2));

  const reqDepth = new Float64Array(nodeCount);
  const riseNeed = new Float64Array(n);
  // Kept, because the requirement a crossing puts on the way BELOW depends on how far the way
  // ABOVE ends up rising, and that is not known until every crossing has been seen once.
  const cross = [];
  findCrossings(lines, extent, (l1, k1, l2, k2, cx, cz) => {
    const v1 = levelOf(l1), v2 = levelOf(l2);
    if (v1 === v2) return;
    stats.grade.crossings++;
    const below = v1 < v2;
    const lo = below ? l1 : l2, hi = below ? l2 : l1;
    cross.push(lo, hi, below ? k1 : k2, cx, cz);
    if (hi < n && kind[hi] === WAY_OVER) {
      const r = UNDER_CLEAR + ROAD_Y + deckOf(hi) - ROAD_Y;
      if (r > riseNeed[hi]) riseNeed[hi] = r;
    }
  });

  /* --- 3. how far each way carried over something actually rises ---------- */
  const rise = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_OVER) continue;
    const cap = BRIDGE_RISE[clsOf[i]] || 5.0;
    if (roadsRaw[i].b === 1) { rise[i] = cap; continue; }
    // layer > 0 with no bridge tag: it is only above something where it actually crosses
    // something, and it rises exactly as far as that crossing demands. With nothing under it,
    // it belongs on the ground, where it stays walkable.
    const need = riseNeed[i];
    if (need < 0.4) { kind[i] = WAY_GRADE; continue; }
    rise[i] = Math.min(cap, need);
  }


  /* --- 4. the clearance each crossing demands of the way underneath -------- */
  // Now that the deck heights are settled, every crossing is revisited and the way BELOW is told
  // how deep it has to be. A street under the Gardiner asks for nothing — the expressway is
  // already 8 m over it. A street under a railway at grade has to find all of it itself.
  const riseAt = new Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_OVER || !(rise[i] > 0)) continue;
    const p = roadsRaw[i].p;
    const arc = new Float64Array(p.length);
    for (let k = 1; k < p.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    }
    riseAt[i] = arc;
  }
  const deckHeight = (way, cx, cz) => {
    if (way >= n) return RAIL_BED;                 // a railway is on the ground
    if (kind[way] !== WAY_OVER || !(rise[way] > 0)) return ROAD_Y;
    const arc = riseAt[way];
    const p = roadsRaw[way].p;
    let best = 0, bestD = Infinity;
    for (let k = 1; k < p.length; k++) {
      const d2 = distToSeg2(cx, cz, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]);
      if (d2 >= bestD) continue;
      bestD = d2;
      const dx = p[k][0] - p[k - 1][0], dz = p[k][1] - p[k - 1][1];
      const l2 = dx * dx + dz * dz;
      const t = l2 > EPS
        ? clamp(((cx - p[k - 1][0]) * dx + (cz - p[k - 1][1]) * dz) / l2, 0, 1) : 0;
      best = arc[k - 1] + (arc[k] - arc[k - 1]) * t;
    }
    const total = arc[arc.length - 1] || 1;
    const ramp = Math.max(20, rise[way] * 4.5);
    return ROAD_Y + rise[way] *
      Math.min(smoothstep(0, ramp, best), smoothstep(0, ramp, total - best));
  };
  for (let c = 0; c < cross.length; c += 5) {
    const lo = cross[c], hi = cross[c + 1], seg = cross[c + 2];
    const cx = cross[c + 3], cz = cross[c + 4];
    if (lo >= n || kind[lo] !== WAY_UNDER) continue;
    const need = UNDER_CLEAR + ROAD_Y + deckOf(hi) - deckHeight(hi, cx, cz);
    if (!(need > 0)) continue;
    const ids = wayNodes[lo];
    if (!ids) continue;
    const req = Math.min(DEPTH_MAX, need);
    // BOTH ends of the crossed segment, at the full requirement. A corridor's depth is the linear
    // interpolation between its vertices, so two equal endpoints hold the whole segment at that
    // depth and the crossing is covered wherever along it the two lines happen to meet.
    for (const k of [seg - 1, seg]) {
      if (k < 0 || k >= ids.length || ids[k] < 0) continue;
      if (req > reqDepth[ids[k]]) reqDepth[ids[k]] = req;
    }
  }
  /* --- 5. how far every node is from a portal ----------------------------- */
  // A depressed way dips as far as its clearance requirement asks AND as far as the distance to
  // its own portal allows at RAMP_GRADE, whichever is less. That second cap is what keeps the
  // whole thing local: the ramp lives inside the corridor, the portal sits exactly at grade, and
  // the surface street outside it is untouched. Where the corridor is too short to find all the
  // clearance itself, the structure above makes up the difference — see the rail rise below.
  const portalDist = new Float64Array(nodeCount).fill(Infinity);
  {
    const heap = makeMaxHeap();
    for (let v = 0; v < nodeCount; v++) {
      // A portal is where a depressed way meets one that is not — or simply runs out, because a
      // loose end left 5 m down would be a cliff.
      if (!(touch[v] & 2)) continue;
      if ((touch[v] & 1) || degree[v] <= 1) { portalDist[v] = 0; heap.push(v, 0); }
    }
    while (heap.size) {
      const v = heap.pop();
      const d = -heapValue();
      if (d > portalDist[v] + 1e-6) continue;
      const a = adj[v];
      if (!a) continue;
      for (let e = 0; e < a.length; e += 3) {
        if (kind[a[e + 2]] !== WAY_UNDER) continue;
        const nd = d + a[e + 1];
        if (nd < portalDist[a[e]] - 1e-4) { portalDist[a[e]] = nd; heap.push(a[e], -nd); }
      }
    }
  }

  /* --- 6. the depth profile along each corridor --------------------------- */
  // Depth is a function of ARC LENGTH, not of vertex index. Bay Street's teamway is two vertices
  // 109 m apart: sampling only at those would leave it dead flat, portal to portal, and the
  // headline underpass in the city would not exist. The graph distance to the nearest portal is
  // exact for any point of a way — min over its own vertices of (that vertex's distance plus the
  // walk along the way to it) — so the profile can be resampled as finely as the ramp needs.
  // A corridor is ROOFED only where a walkable surface way crosses over it: that crossing needs
  // ground to walk on, so the cut stops and a lid carries it across. It is NOT roofed merely for
  // running under a building — Union Station's teamways are the headline underpass in the city and
  // burying them under a lid would make them unwalkable, which is the bug this whole pass exists
  // to fix. A railway crossing does not roof it either: the railway gets its own deck and the
  // street below stays open to the sky, which is what those underpasses actually look like.
  const lids = new Array(n);
  for (let c = 0; c < cross.length; c += 5) {
    const lo = cross[c], hi = cross[c + 1];
    if (lo >= n || hi >= n || kind[lo] !== WAY_UNDER) continue;
    if (kind[hi] !== WAY_GRADE && kind[hi] !== WAY_PASSAGE) continue;
    if (!WALK_CLASS[roadsRaw[hi].c]) continue;
    (lids[lo] || (lids[lo] = [])).push(cross[c + 3], cross[c + 4]);
  }
  // A streetcar does NOT lid what it crosses: it runs IN the street, so it goes down the ramp with
  // the carriageway it is embedded in. The Bay Street car runs the length of the teamway under
  // Union Station, and roofing it there would put a bridge across the middle of the underpass.

  const field = makeGradeField(extent);
  const corridor = new Array(n);
  let cutMetres = 0, roofMetres = 0, deepest = 0, lidSteps = 0;
  for (let i = 0; i < n; i++) {
    corridor[i] = null;
    if (kind[i] !== WAY_UNDER) continue;
    const ids = wayNodes[i];
    const p = roadsRaw[i].p;
    if (!ids || p.length < 2) continue;
    const arc = new Float64Array(p.length);
    for (let k = 1; k < p.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    }
    const total = arc[p.length - 1];
    if (!(total > 0.5)) continue;
    let want = Math.min(LAYER_DROP, layerDepth(lay[i], roadsRaw[i].tun | 0));
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] >= 0 && reqDepth[ids[k]] > want) want = reqDepth[ids[k]];
    }
    const grade = rampGrade(want);
    const step = Math.max(2.0, Math.min(6.0, total / 3));
    const count = Math.max(2, Math.ceil(total / step) + 1);
    const pts = new Array(count);
    const dep = new Float64Array(count);
    const roof = new Uint8Array(count);
    for (let c = 0; c < count; c++) {
      const sv = total * (c / (count - 1));
      // Locate the sample on the raw polyline.
      let k = 1;
      while (k < p.length - 1 && arc[k] < sv) k++;
      const span = arc[k] - arc[k - 1];
      const t = span > EPS ? clamp((sv - arc[k - 1]) / span, 0, 1) : 0;
      const x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * t;
      const z = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t;
      let d = Infinity;
      for (let m = 0; m < ids.length; m++) {
        if (ids[m] < 0) continue;
        const dd = portalDist[ids[m]] + Math.abs(sv - arc[m]);
        if (dd < d) d = dd;
      }
      pts[c] = [x, z];
      // ...and never below the lake. A trench floor under the water plane is a flooded street,
      // and the player cannot follow it down there anyway.
      dep[c] = Math.max(0, Math.min(want, grade * d, terrainY(x, z) - TRENCH_FLOOR));
      if (dep[c] > deepest) deepest = dep[c];
      roof[c] = 0;
      const lid = lids[i];
      if (dep[c] > CUT_MIN && lid) {
        for (let m = 0; m < lid.length; m += 2) {
          if (Math.hypot(lid[m] - x, lid[m + 1] - z) < COVER_PAD) { roof[c] = 1; break; }
        }
      }
    }
    corridor[i] = { pts, dep, roof, hw: hwOf[i] };
    // Where a street is carried over a corridor on a lid, the ground plane belongs to the street
    // and the roadway runs underneath it. A single heightfield cannot hold both, so `groundY`
    // steps up onto the lid — while the roadway itself, its pavement and its markings all stay
    // down on the corridor profile. Counted, because it is the one place the two disagree.
    for (let c = 1; c < count; c++) {
      if (roof[c] !== roof[c - 1] && Math.max(dep[c], dep[c - 1]) > 0.45) lidSteps++;
    }
    for (let c = 1; c < count; c++) {
      if (!(dep[c - 1] > 0.05 || dep[c] > 0.05)) continue;
      const roofed = roof[c - 1] === 1 && roof[c] === 1;
      field.add(pts[c - 1][0], pts[c - 1][1], pts[c][0], pts[c][1], hwOf[i],
        dep[c - 1], dep[c], roofed, i, chwOf[i]);
      if (Math.max(dep[c - 1], dep[c]) <= CUT_MIN) continue;
      const len = Math.hypot(pts[c][0] - pts[c - 1][0], pts[c][1] - pts[c - 1][1]);
      if (roofed) roofMetres += len; else cutMetres += len;
    }
  }

  // A building passage drops nothing and cuts nothing, but it is still a way THROUGH a structure,
  // so it is filed in the same field: one query then covers every place a wall has to open and
  // the player has to be let through, whether the way dives under the building or walks into it.
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_PASSAGE) continue;
    const p = roadsRaw[i].p;
    if (!Array.isArray(p) || p.length < 2) continue;
    for (let k = 1; k < p.length; k++) {
      if (!isNum(p[k - 1][0]) || !isNum(p[k][0])) continue;
      field.addPassage(p[k - 1][0], p[k - 1][1], p[k][0], p[k][1], chwOf[i]);
    }
  }

  /* --- 7. the rise the structures above still owe ------------------------- */
  // Where a corridor could not find all its clearance inside its own length, the railway over it
  // takes up the rest — which is exactly what Toronto's downtown rail corridor does: it runs on a
  // continuous embankment and the streets pass under it. The rise propagates along the track at a
  // railway gradient, not a road one, so it lands as a long approach rather than a hump.
  const railRise = new Array(railsRaw.length);
  {
    const rset = makeNodeSet(0.40);
    const rNodes = new Array(railsRaw.length);
    const rAdj = [];
    for (let i = 0; i < railsRaw.length; i++) {
      const ra = railsRaw[i];
      rNodes[i] = null;
      if (!ra || ra.k === 'subway' || !Array.isArray(ra.p) || ra.p.length < 2) continue;
      const ids = new Int32Array(ra.p.length);
      for (let k = 0; k < ra.p.length; k++) {
        ids[k] = isNum(ra.p[k][0]) ? rset.at(ra.p[k][0], ra.p[k][1]) : -1;
        if (k > 0 && ids[k] >= 0 && ids[k - 1] >= 0 && ids[k] !== ids[k - 1]) {
          const len = Math.hypot(ra.p[k][0] - ra.p[k - 1][0], ra.p[k][1] - ra.p[k - 1][1]);
          (rAdj[ids[k - 1]] || (rAdj[ids[k - 1]] = [])).push(ids[k], len);
          (rAdj[ids[k]] || (rAdj[ids[k]] = [])).push(ids[k - 1], len);
        }
      }
      rNodes[i] = ids;
    }
    const rn = rset.count;
    const rv = new Float64Array(rn);
    let violations = 0;
    for (let c = 0; c < cross.length; c += 5) {
      const lo = cross[c], hi = cross[c + 1];
      if (hi < n || lo >= n || kind[lo] !== WAY_UNDER) continue;
      if (lines[hi].k !== 'rail') continue;           // a streetcar is not carried on a viaduct
      const cx = cross[c + 3], cz = cross[c + 4];
      const cor = corridor[lo];
      if (!cor) { violations++; continue; }
      const need = UNDER_CLEAR + ROAD_Y + RAIL_DECK - RAIL_BED;
      const have = corridorDepth(cor, cx, cz);
      const deficit = need - have;
      if (deficit < 0.05) continue;
      const ri = railFor[hi - n];
      const ids = ri === undefined ? null : rNodes[ri];
      if (!ids) { violations++; continue; }
      const want = Math.min(RAIL_RISE_MAX, deficit);
      if (want < deficit - 0.05) violations++;
      const p = railsRaw[ri].p;
      for (let k = 1; k < p.length; k++) {
        if (distToSeg2(cx, cz, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]) > 4) continue;
        for (const m of [k - 1, k]) {
          if (ids[m] >= 0 && want > rv[ids[m]]) rv[ids[m]] = want;
        }
      }
    }
    stats.grade.violations = violations;
    const heap = makeMaxHeap();
    for (let v = 0; v < rn; v++) if (rv[v] > 0) heap.push(v, rv[v]);
    while (heap.size) {
      const v = heap.pop();
      const d = heapValue();
      if (d < rv[v] - 1e-6 || d <= 0) continue;
      const a = rAdj[v];
      if (!a) continue;
      for (let e = 0; e < a.length; e += 2) {
        const nd = d - RAIL_GRADE * a[e + 1];
        if (nd > rv[a[e]] + 1e-4) { rv[a[e]] = nd; heap.push(a[e], nd); }
      }
    }
    for (let i = 0; i < railsRaw.length; i++) {
      const ids = rNodes[i];
      if (!ids) { railRise[i] = null; continue; }
      let any = false;
      const out = new Float64Array(ids.length);
      for (let k = 0; k < ids.length; k++) {
        out[k] = ids[k] >= 0 ? rv[ids[k]] : 0;
        if (out[k] > 0.02) any = true;
      }
      railRise[i] = any ? out : null;
    }
  }

  stats.grade.under = 0;
  stats.grade.sub = 0;
  stats.grade.over = 0;
  stats.grade.passage = 0;
  for (let i = 0; i < n; i++) {
    if (kind[i] === WAY_UNDER) stats.grade.under++;
    else if (kind[i] === WAY_SUB) stats.grade.sub++;
    else if (kind[i] === WAY_OVER) stats.grade.over++;
    else if (kind[i] === WAY_PASSAGE) stats.grade.passage++;
  }
  stats.grade.lidSteps = lidSteps;
  stats.grade.cutMetres = cutMetres;
  stats.grade.roofedMetres = roofMetres;
  stats.grade.deepest = deepest;
  stats.grade.nodes = nodeCount;

  return {
    kind, lay, clsOf, hwOf, wayNodes, adj, degree, nodeCount, nodeX: set.xs, nodeZ: set.zs,
    corridor, railRise, rise, field,
  };
}
/** The depth of a corridor at the point of it nearest (x, z). */
function corridorDepth(cor, x, z) {
  const pts = cor.pts;
  let best = 0, bestD = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const d2 = distToSeg2(x, z, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    if (d2 >= bestD) continue;
    bestD = d2;
    const dx = pts[k][0] - pts[k - 1][0], dz = pts[k][1] - pts[k - 1][1];
    const l2 = dx * dx + dz * dz;
    const t = l2 > EPS
      ? clamp(((x - pts[k - 1][0]) * dx + (z - pts[k - 1][1]) * dz) / l2, 0, 1) : 0;
    best = cor.dep[k - 1] + (cor.dep[k] - cor.dep[k - 1]) * t;
  }
  return best;
}

export {
  WAY_GRADE, WAY_UNDER, WAY_SUB, WAY_OVER, WAY_PASSAGE,
  UNDER_CLEAR, RAIL_DECK, RAIL_BED, ROAD_DECK, LAYER_DROP, DEPTH_MAX,
  RAMP_GRADE, RAMP_MIN, RAMP_MAX, RAIL_GRADE, RAIL_RISE_MAX,
  TRENCH_FLOOR, TRENCH_WALL, TRENCH_MITER, TRENCH_VERGE, TRENCH_CUT, CUT_MIN,
  SUB_HEAD, SUB_COVER, PASSAGE_HEAD, PASS_HEAD,
  TUNNEL_LAMP_PITCH, TUNNEL_LAMP_MIN, TUNNEL_LAMP_H, SUB_SEG, COVER_PAD, CROSS_MIN_SIN, GRADE_CELL,
  rampGrade, layerDepth, classifyWay, makeGradeField, findCrossings, solveGrade,
  corridorDepth,
};
