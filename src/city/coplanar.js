// src/city/coplanar.js — who owns a shared surface, resolved a building at a time, on demand.
//
// CONTRACT.md §3.1, §8.4 and Amendment 11.1. This is the analysis that used to run over the whole
// city before the first frame and now runs when a tile asks for it:
//
//   walls   the massing extract stacks slabs, so two records routinely extrude the same wall in
//           the same plane. A depth buffer cannot order those and the result is a facade that
//           shimmers as the camera moves; the loser stops where the winner starts.
//   portals opens every wall a depressed corridor or a building passage runs through, before a
//           single quad is emitted (CONTRACT §8.1).
//   caps    the same argument for roof caps, which share a plane far more often than walls do: a
//           cap wholly inside something taller is deleted, and two caps on one plane step apart.
//
// WHY IT CAN BE LAZY AT ALL. Every one of those three questions is answered by geometry that
// TOUCHES the record asking it. A wall can only fight a wall within WALL_TOL of it; a cap can only
// fight a cap whose footprint overlaps it. So the answer for one record is a function of its
// neighbours and of nothing else, and computing it when the record is first needed gives exactly
// the answer the whole-city pass gave — as long as the two rules that used to depend on global
// iteration order are made independent of it, which is what the next two paragraphs are about.
//
// STABLE EDGE KEYS. The wall rule breaks a tie between two equally tall walls by taking "the
// earlier edge", and the global pass numbered edges by the order it happened to build them in.
// Here the number is composed instead: `record key * EDGE_STRIDE + ordinal within the record`.
// The global pass walked records in key order and, within a record, parts then rings then edges,
// so the composed key induces exactly the same total order — and it does so without knowing which
// records have been built yet.
//
// EVALUATION ORDER. wallsCoincide() measures the overlap in the FIRST argument's frame, and two
// walls a hair over 15 degrees apart can be a pair from one side and not from the other. The
// global pass always evaluated the lower-keyed edge first, so this does too (see pairRun), and
// each edge then reads whichever end of the shared band belongs to it.
//
// THE CAP GREEDY. The step-down sorted every live cap by rank and placed them in that order,
// testing each trial level against "every cap already placed". In a rank-ordered sweep that phrase
// means exactly "every HIGHER-RANKED cap", and said that way the rule no longer mentions the sweep:
// a cap's level is a function of the levels of the higher-ranked caps whose footprints overlap it.
// Rank is a strict total order, so the recursion that follows is a DAG, it terminates, and each cap
// lands where the sweep put it. The rank itself — footprint area, then record key, then part index
// — is settled in prepareBuildings so that comparing two records never depends on either of them
// having been visited.
//
// Nothing here emits a vertex. Plan space is (u, v) = (x, -z), as everywhere in this tree.

import { makeGridIndex } from '../data/index.js';
import { partContains } from '../geom/ring.js';
import { WALL_SINK } from '../world/ground.js';
// Headroom a corridor and a building passage each demand of whatever crosses them: the portal
// punched through a wall has to clear the same height the trench below it was cut to.
import { PASSAGE_HEAD, UNDER_CLEAR } from '../world/grade.js';
import {
  WALL_MIN_BAND, WALL_TOL, addWallRing, wallTopAt, wallsCoincide, wallPair,
} from './buildings.js';

const CAP_PLANE_TOL = 0.030;       // two roof caps closer than this in Y are the same plane
const CAP_MIN_SEP = 0.020;         // ...and this is the separation the audit demands afterwards
const CAP_STEP = 0.060;            // how far a losing roof cap steps down out of a shared plane.
                                   // Comfortably more than CAP_PLANE_TOL, so one step always
                                   // clears the band that put the two caps in the same group
const CAP_MAX_STEP = 4;            // deepest a chain may go, so one pathological cluster cannot
                                   // sink a roof half a metre below its own wall head
const PORTAL_MIN_RUN = 1.2;        // a shorter crossing than this is a corner nick, not a doorway
const PORTAL_AXIS_MAX = 0.75;      // |cos| between wall and corridor: above this they are parallel

// Edge ordinals per record. The composed key must sort by (record key, ordinal), which needs the
// stride to exceed every record's edge count; the largest footprint in the massing extract carries
// a few hundred, and 2^20 leaves three orders of magnitude of headroom. Record key * stride stays
// an exact float64 integer well past a million records.
const EDGE_STRIDE = 1048576;

// How far apart two cap tops can be and still, conceivably, collide. A cap steps down by at most
// CAP_MAX_STEP * CAP_STEP and so does the one it might land on, and the clash band is CAP_MIN_SEP
// wide, so two tops further apart than the sum can never meet at any trial level. It is what keeps
// the step-down recursion to a handful of caps instead of a district.
const CAP_NEAR = 2 * CAP_MAX_STEP * CAP_STEP + CAP_MIN_SEP;

// Records per yield in the background sweep. One record is a broadphase query and a few dozen
// edge pairs; 64 of them is well under a millisecond even downtown.
const SWEEP_PER_YIELD = 8;

/**
 * Is every point of `part` inside record `o`? Tested at the ring's vertices AND its edge
 * midpoints, which is what catches a footprint that pokes out through the middle of a long edge.
 */
function partInsideRecord(o, part) {
  const co = part.outer;
  const n = co.length;
  const inside = (u, v) => {
    for (let p = 0; p < o.parts.length; p++) if (partContains(o.parts[p], u, v)) return true;
    return false;
  };
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    if (!inside(co[j], co[j + 1])) return false;
    // Walk the edge as well as its ends. A verdict of "buried" DELETES geometry, so a footprint
    // that bows out through the middle of a long edge has to be caught: sample every couple of
    // metres, capped so one 300 m stadium edge cannot dominate the pass.
    const du = co[i] - co[j], dv = co[i + 1] - co[j + 1];
    const len = Math.sqrt(du * du + dv * dv);
    const steps = Math.min(24, Math.max(1, Math.round(len / 2.0)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (!inside(co[j] + du * t, co[j + 1] + dv * t)) return false;
    }
  }
  return true;
}

// Do two footprint parts share any ground? Bounding boxes first, then vertices and centroids of
// each against the other — which is every overlap the massing data actually produces, because a
// footprint is a building outline and not a pinwheel.
function partsOverlap(a, b) {
  const ab = a.bbox, bb = b.bbox;
  if (ab[0] > bb[2] || ab[2] < bb[0] || ab[1] > bb[3] || ab[3] < bb[1]) return false;
  if (partContains(b, (ab[0] + ab[2]) * 0.5, (ab[1] + ab[3]) * 0.5)) return true;
  if (partContains(a, (bb[0] + bb[2]) * 0.5, (bb[1] + bb[3]) * 0.5)) return true;
  const ca = a.outer, cb = b.outer;
  for (let i = 0; i < ca.length; i += 2) if (partContains(b, ca[i], ca[i + 1])) return true;
  for (let i = 0; i < cb.length; i += 2) if (partContains(a, cb[i], cb[i + 1])) return true;
  return false;
}

// A total order over roof caps sharing a plane: the bigger footprint keeps the surface, the record
// key breaks a tie, the part index breaks that. Total matters — a rule with ties either leaves a
// pair unresolved or drops both caps.
function capOutranks(o, oi, b, bi) {
  const oa = o.parts[oi].capArea, ba = b.parts[bi].capArea;
  if (oa !== ba) return oa > ba;
  if (o.key !== b.key) return o.key < b.key;
  return oi < bi;
}

/** A record the resolver may touch: prepared, with real parts, and not the CN Tower. */
function resolvable(b) {
  return !!(b && b.parts && !b.surround && b.landmark !== 'cn');
}

/**
 * Build the on-demand coplanar resolver over one load.
 *
 * `resolve(b)` is idempotent and total: after it returns, `b.walls` carries every wall face the
 * record may emit with its cuts and its portals, and every part of `b` carries its cap verdict.
 * Call it before reading any of those, and never mind whether a neighbour has been resolved —
 * that is this module's problem, not the caller's.
 *
 * @param {object} W { extent, bIndex, stats, grade, terrainY }
 */
function makeCoplanarResolver(W) {
  const { extent, bIndex, stats, grade, terrainY } = W;
  const A = stats.coplanar;
  const GR = stats.grade;

  // The wall-edge broadphase, in PLAN space, filled a record at a time. Same cell size and same
  // origin the whole-city pass used, so a pair lands in the same cells and is therefore visited
  // the same number of times — which matters, because an item spanning several cells the query
  // box also spans is visited once per shared cell and the audit counts every visit.
  const cell = 10.0;
  const u0 = -extent.x / 2 - 400, v0 = -extent.z / 2 - 400;
  const idx = makeGridIndex(cell, u0, v0,
    Math.ceil((extent.x + 800) / cell) + 1, Math.ceil((extent.z + 800) / cell) + 1);

  /* ------------------------------------------------------------ wall edges */

  /** Build and index this record's wall faces, once. Returns them, or null. */
  function edgesOf(b) {
    if (b.walls) return b.walls;
    if (!resolvable(b)) return null;
    const list = [];
    const y0 = b.y - WALL_SINK, y1 = b.y + b.h;
    const base = b.key * EDGE_STRIDE;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      addWallRing(list, base, idx, b, part.outer, y0, y1);
      for (let h = 0; h < part.holes.length; h++) {
        addWallRing(list, base, idx, b, part.holes[h], y0, y1);
      }
    }
    b.walls = list;
    A.wallFaces += list.length;
    return list;
  }

  /** Put every record that could share a surface with `b` into the edge index. */
  function indexNeighbours(b) {
    if (b.wallsNear) return;
    b.wallsNear = true;
    const bb = b.bbox;
    bIndex.queryBox(bb[0] - WALL_TOL, bb[1] - WALL_TOL, bb[2] + WALL_TOL, bb[3] + WALL_TOL, (o) => {
      if (o !== b) edgesOf(o);
    });
  }

  /**
   * The shared run of two wall faces, always measured from the lower-keyed edge's frame so the
   * verdict cannot depend on which of the two asked. Fills the module-scope pair through
   * wallPair(); `mine` says which end of it belongs to `e`.
   */
  const _mine = { a: 0, b: 0 };
  function pairRun(e, f) {
    const lo = e.k < f.k ? e : f;
    const hi = lo === e ? f : e;
    const run = wallsCoincide(lo, hi);
    if (run <= 0) return 0;
    const P = wallPair();
    if (lo === e) { _mine.a = P.ta; _mine.b = P.tb; } else { _mine.a = P.sa; _mine.b = P.sb; }
    return run;
  }

  /**
   * Cut this record's wall faces back where somebody else owns the surface.
   *
   * Each edge computes only ITS OWN cuts, from every neighbour it coincides with; the neighbour
   * does the same when its turn comes. That makes the pass symmetric and idempotent — there is no
   * "who went first" — and the cut list per edge is identical to the one the global pass built,
   * because wallTopAt() takes the lowest cut covering a point and emitWallFace() sorts its
   * breakpoints, so the order the cuts were pushed in has never mattered.
   */
  function cutWalls(b) {
    const list = edgesOf(b);
    if (!list) return;
    indexNeighbours(b);
    for (let w = 0; w < list.length; w++) {
      const e = list[w];
      const x0 = Math.min(e.au, e.bu) - WALL_TOL, x1 = Math.max(e.au, e.bu) + WALL_TOL;
      const q0 = Math.min(e.av, e.bv) - WALL_TOL, q1 = Math.max(e.av, e.bv) + WALL_TOL;
      idx.queryBox(x0, q0, x1, q1, (f) => {
        if (f === e) return;
        if (Math.min(e.y1, f.y1) - Math.max(e.y0, f.y0) <= WALL_MIN_BAND) return;
        const run = pairRun(e, f);
        if (run <= 0) return;
        // Total, stable order: the higher wall keeps the surface, ties go to the earlier edge.
        // Counted once per pair, from the lower-keyed side, exactly as the global scan did.
        if (e.k < f.k) { A.wallPairs++; A.wallMetres += run; }
        const eWins = e.y1 > f.y1 || (e.y1 === f.y1 && e.k < f.k);
        if (eWins) return;
        (e.cuts || (e.cuts = [])).push(_mine.a, _mine.b, Math.max(e.y0, f.y0));
      });
    }
  }

  /**
   * CONTRACT 8.1 — "roads that pass under a rail corridor, an expressway or a building must be
   * MODELLED, not deleted". Modelling the road is only half of it: the structure ON TOP has to let
   * it through.
   *
   * York and Bay Streets dive under Union Station into the teamways, and a further 1.6 km of
   * building passages walk straight through the base of a tower. The massing knows nothing about
   * any of that, so its perimeter wall stands square across the carriageway and the underpass —
   * which IS built, and which the ground correctly dips into — dead-ends in a blank facade a
   * pedestrian cannot pass. That is the "roads just cut off" in the report, and this is where it
   * is opened.
   *
   * Wherever a corridor or a passage CROSSES a wall face, the wall goes from its foot up to the
   * head the corridor needs, and the building stands on the lintel that is left. The head is the
   * same number `emitTrench` gives the soffit, so wall and ceiling meet on one line with no seam.
   *
   * Only a crossing wall opens. A building that merely lines a depressed street runs PARALLEL to
   * it with its facade at the back of the pavement — inside the corridor's outer envelope — and
   * would otherwise have its whole ground floor cut away; the direction test and the narrower
   * carriageway envelope are what keep it shut.
   *
   * Purely local: it reads the grade field under this record's own walls and nothing else.
   */
  function punchPortals(b) {
    if (!grade || typeof grade.span !== 'function') return;
    const list = b.walls;
    if (!list) return;
    for (let w = 0; w < list.length; w++) {
      const e = list[w];
      const steps = Math.max(2, Math.min(64, Math.ceil(e.len / 1.0)));
      const dt = e.len / steps;
      let runA = -1, runB = -1, runHead = 0;
      for (let s = 0; s <= steps; s++) {
        const t = s * dt;
        const x = e.au + e.uu * t;
        const z = -(e.av + e.uv * t);
        const sp = grade.span(x, z);
        let head = 0;
        if (sp && sp.d2 <= sp.chw * sp.chw) {
          // World direction of the wall is (uu, -uv); v is -z.
          const dot = Math.abs(e.uu * sp.dx - e.uv * sp.dz);
          if (dot < PORTAL_AXIS_MAX) {
            const floorY = terrainY(x, z) - sp.dep;
            head = floorY + (sp.pass ? PASSAGE_HEAD : UNDER_CLEAR);
          }
        }
        if (head > 0) {
          if (runA < 0) { runA = t; runHead = head; }
          runB = t;
          if (head > runHead) runHead = head;
          if (s < steps) continue;
        }
        if (runA >= 0) {
          const a = runA - dt * 0.5 < 0 ? 0 : (runA - dt * 0.5 > e.len ? e.len : runA - dt * 0.5);
          const bb = runB + dt * 0.5 < 0 ? 0 : (runB + dt * 0.5 > e.len ? e.len : runB + dt * 0.5);
          if (bb - a >= PORTAL_MIN_RUN && runHead > e.y0 + WALL_MIN_BAND) {
            (e.holes || (e.holes = [])).push(a, bb, runHead);
            GR.wallPortals++;
            GR.wallPortalMetres += bb - a;
          }
          runA = -1; runB = -1; runHead = 0;
        }
      }
    }
  }

  /**
   * Any pair of surviving wall faces that still share a band is a fight that got through, and must
   * be zero. Counted once per pair, from the lower-keyed edge, with BOTH sides fully cut first.
   */
  function auditWalls(b) {
    const list = b.walls;
    if (!list) return;
    for (let w = 0; w < list.length; w++) {
      const e = list[w];
      const x0 = Math.min(e.au, e.bu) - WALL_TOL, x1 = Math.max(e.au, e.bu) + WALL_TOL;
      const q0 = Math.min(e.av, e.bv) - WALL_TOL, q1 = Math.max(e.av, e.bv) + WALL_TOL;
      idx.queryBox(x0, q0, x1, q1, (f) => {
        if (f.k <= e.k) return;
        if (Math.min(e.y1, f.y1) - Math.max(e.y0, f.y0) <= WALL_MIN_BAND) return;
        if (pairRun(e, f) <= 0) return;
        // READ THE BAND BEFORE FORCING ANYTHING. wallPair() is one scratch object shared by every
        // call, and cutRecord() below runs a whole record's worth of pair tests through it.
        const P = wallPair();
        const t = (P.ta + P.tb) * 0.5;
        const s = (P.sa + P.sb) * 0.5;
        // The other side's cuts have to be final before its surviving top means anything.
        cutRecord(f.r);
        const eTop = wallTopAt(e, t);
        const fTop = wallTopAt(f, s);
        const lo = Math.max(e.y0, f.y0);
        const hi = Math.min(eTop, fTop);
        if (hi - lo > WALL_MIN_BAND) A.wallPairsLeft++;
      });
    }
  }

  /** Walls cut and portals punched for one record, once. */
  function cutRecord(b) {
    if (!b || b.wallsCut) return;
    b.wallsCut = true;
    cutWalls(b);
    punchPortals(b);
  }

  /* ------------------------------------------------------------- roof caps */
  //
  // A cap is a horizontal face, so its fight is with another cap at the same height — and its
  // other failure is simply being INSIDE something taller, where it costs vertices to draw a roof
  // nobody can see. Two answers, because there are two shapes of problem:
  //
  //   * a cap wholly inside a record that reaches above it is DELETED. Where every part of a
  //     record is wholly inside a neighbour that also starts at or below it, the record is dropped
  //     whole — walls, cap, beacon, ground floor and rooftop plant, all of which were previously
  //     being built inside somebody else's tower.
  //   * two caps on the same plane that merely OVERLAP cannot be resolved by deletion without
  //     clipping one polygon against the other, so the loser STEPS DOWN instead. A roof 6 cm below
  //     its own wall head is a parapet; two roofs at the same height are a fight.
  //
  // BURIAL IS PURELY LOCAL. It reads the neighbours' heights and footprints, every one of which is
  // settled the moment the records are prepared, so a record's verdict is the same whenever it is
  // asked for. `capArea` — the rank the verdict turns on — is computed in prepareBuildings for
  // exactly that reason: a rule that compares two records must not depend on either of them having
  // been visited first.
  //
  // THE STEP-DOWN IS A GREEDY OVER A TOTAL ORDER, which reads as order-dependent and is not. The
  // whole-city pass sorted every live cap by rank and placed them in that order, and each cap's
  // trial level was tested against "every cap already placed" — which, in a rank-ordered sweep, is
  // exactly "every HIGHER-RANKED cap". Written that way the rule stops mentioning the sweep at
  // all: a cap's level is a function of the levels of the higher-ranked caps whose footprints
  // overlap it. Rank is a strict total order, so that recursion is a DAG and terminates, each cap
  // is placed once and memoised on the part, and every cap lands where the sweep put it.
  //
  // The recursion is pruned by height, which is what keeps it a handful of caps rather than a
  // district: a placed cap can only clash with a trial level if the two tops are within CAP_NEAR,
  // because a drop is at most CAP_MAX_STEP steps.

  /** Settle this record's burial verdict, and every one of its parts', once. */
  function ensureBurial(b) {
    if (b.buriedDone) return;
    b.buriedDone = true;
    const top = b.y + b.h;
    const base = b.y - WALL_SINK;
    let allBuried = true;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      const bb = part.bbox;
      const qx = (bb[0] + bb[2]) * 0.5, qz = -(bb[1] + bb[3]) * 0.5;
      const qr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1;
      let buried = false, whole = false;
      bIndex.query(qx, qz, qr, (o) => {
        if (buried || o === b || !resolvable(o)) return;
        const oTop = o.y + o.h;
        const oBase = o.y - WALL_SINK;
        if (oTop > top + CAP_PLANE_TOL) {
          if (oBase > top || !partInsideRecord(o, part)) return;
          buried = true;
          if (oBase <= base + 0.05) whole = true;
          return;
        }
        if (oTop < top - CAP_PLANE_TOL) return;
        for (let q = 0; q < o.parts.length; q++) {
          if (capOutranks(o, q, b, p) && partInsideRecord(o, part)) { buried = true; return; }
        }
      });
      part.capBuried = buried;
      if (buried) {
        A.capsBuried++;
        if (!whole) allBuried = false;
      } else {
        allBuried = false;
      }
    }
    b.buried = allBuried;
    if (allBuried) A.buriedRecords++;
  }

  /**
   * Settle one cap's step-down level, and every higher-ranked cap it might land on first.
   *
   * The trial loop is the whole-city pass's, with one substitution: where that one asked "has this
   * neighbour been placed yet" — true of exactly the higher-ranked caps, because it swept in rank
   * order — this asks whether the neighbour outranks us. The two are the same question there and
   * only the second one is still meaningful when caps are settled in whatever order tiles ask.
   */
  function placeCap(b, p) {
    const part = b.parts[p];
    if (part.capLevel >= 0 || part.capBuried || b.buried) return;
    const top = b.y + b.h;
    const bb = part.bbox;
    const qx = (bb[0] + bb[2]) * 0.5, qz = -(bb[1] + bb[3]) * 0.5;
    const qr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1;

    // Everything that could end up under our feet, placed first.
    bIndex.query(qx, qz, qr, (o) => {
      if (o === b || !resolvable(o)) return;
      if (Math.abs((o.y + o.h) - top) >= CAP_NEAR) return;
      ensureBurial(o);
      if (o.buried) return;
      for (let q = 0; q < o.parts.length; q++) {
        const other = o.parts[q];
        if (other.capBuried || other.capLevel >= 0) continue;
        if (!capOutranks(o, q, b, p)) continue;
        if (partsOverlap(other, part)) placeCap(o, q);
      }
    });

    // Take the first step that is genuinely clear of every cap that outranks this one, tested
    // against the heights they were actually placed at. Counting dominators is not enough: a cap
    // stepping out of ITS plane can land on a neighbouring one, which is exactly the case a chain
    // depth misses.
    let lvl = 0;
    while (lvl <= CAP_MAX_STEP) {
      const y = top - lvl * CAP_STEP;
      let clash = false;
      bIndex.query(qx, qz, qr, (o) => {
        if (clash || o === b || !resolvable(o) || o.buried) return;
        for (let q = 0; q < o.parts.length; q++) {
          const other = o.parts[q];
          if (other.capBuried || !capOutranks(o, q, b, p)) continue;
          if (Math.abs((o.y + o.h - other.capDrop) - y) >= CAP_MIN_SEP) continue;
          if (partsOverlap(other, part)) { clash = true; return false; }
        }
      });
      if (!clash) break;
      lvl++;
    }
    if (lvl > CAP_MAX_STEP) { lvl = CAP_MAX_STEP; A.capDropsClamped++; }
    part.capLevel = lvl;
    if (lvl > 0) { part.capDrop = lvl * CAP_STEP; A.capsStepped++; }
  }

  /**
   * Any two caps still left within CAP_MIN_SEP of each other with overlapping footprints. Counted
   * once per pair, from the lower-keyed record, with both sides finally placed — which is why it
   * forces the neighbour rather than reading whatever level it happens to carry.
   */
  function auditCaps(b) {
    if (b.buried) return;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (part.capBuried) continue;
      const top = b.y + b.h - part.capDrop;
      const bb = part.bbox;
      bIndex.query((bb[0] + bb[2]) * 0.5, -(bb[1] + bb[3]) * 0.5,
        Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1, (o) => {
          if (o === b || !resolvable(o) || o.key <= b.key) return;
          if (Math.abs((o.y + o.h) - (b.y + b.h)) >= CAP_NEAR) return;
          ensureBurial(o);
          if (o.buried) return;
          for (let q = 0; q < o.parts.length; q++) {
            const other = o.parts[q];
            if (other.capBuried) continue;
            placeCap(o, q);
            if (Math.abs((o.y + o.h - other.capDrop) - top) >= CAP_MIN_SEP) continue;
            if (partsOverlap(other, part)) { A.capPairsLeft++; return false; }
          }
        });
    }
  }

  /** Every cap verdict this record needs: buried or not, and how far each cap steps down. */
  function resolveCaps(b) {
    if (b.capsDone) return;
    b.capsDone = true;
    ensureBurial(b);
    for (let p = 0; p < b.parts.length; p++) placeCap(b, p);
    auditCaps(b);
  }

  /* ------------------------------------------------------------------ api */

  /**
   * Everything a record needs decided before its geometry may be emitted: its wall faces, their
   * cuts and portals, the wall audit, and its cap verdicts. Idempotent — a tile that is rebuilt
   * after eviction calls this again and it does nothing.
   */
  function resolve(b) {
    if (!resolvable(b)) return;
    if (b.coplanarDone) return;
    b.coplanarDone = true;
    cutRecord(b);
    auditWalls(b);
    resolveCaps(b);
  }

  /**
   * Is this record wholly inside something taller?
   *
   * The one verdict a caller may need before it needs any geometry: the tower-sign budget in
   * world/areas.js shares eight crown signs out over the tallest records in the city and must not
   * spend one on a record nobody will ever see. Burial is purely local, so this settles that one
   * record and leaves the rest of its cap state for whenever a tile asks.
   */
  function isBuried(b) {
    if (!resolvable(b)) return false;
    ensureBurial(b);
    return !!b.buried;
  }

  /**
   * Resolve whatever is left, off the critical path.
   *
   * A tile resolves the records it holds, which is the whole point — but the AUDIT counters this
   * pass keeps (duplicated wall faces, buried caps, pairs still fighting) are a description of the
   * city, not of where the player flew, and a record that is buried is in no tile at all. So the
   * chore queue finishes the job in record order: every record resolved exactly once, whether or
   * not anything ever asked to draw it, and the totals come out identical to the whole-city pass
   * this replaced.
   *
   * A GENERATOR, driven a couple of milliseconds at a time like every other chore.
   *
   * @param {object[]} records every prepared building record
   */
  function* sweep(records) {
    for (let i = 0; i < records.length; i++) {
      resolve(records[i]);
      if ((i & (SWEEP_PER_YIELD - 1)) === SWEEP_PER_YIELD - 1) yield;
    }
  }

  return { resolve, isBuried, sweep };
}

export { makeCoplanarResolver };
