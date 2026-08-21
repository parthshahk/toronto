// src/city/buildings.js — extruding a footprint, and deciding which faces are worth drawing.
//
// CONTRACT.md §3.1 and Amendment 11.1. Moved out of city.js unchanged. This is the half of the
// building pass that is pure ANALYSIS plus the wall emitter it feeds:
//
//   resolveCoplanarWalls()   the massing extract stacks slabs, so two records routinely extrude
//                            the same wall in the same plane. A depth buffer cannot order those,
//                            and the result is a facade that shimmers as the camera moves. This
//                            pass decides, once and globally, who owns each shared run.
//   punchCorridorPortals()   opens every wall a depressed corridor or a building passage runs
//                            through, before a single quad is emitted.
//   resolveCoplanarCaps()    the same argument for roof caps, which share a plane far more often
//                            than walls do.
//   emitWallFace()           the wall quads themselves, honouring the cuts and holes above.
//
// It is a GLOBAL pass and stays one: which faces a record may draw depends on its neighbours, and
// no record knows its neighbours until every ring is built. It produces no vertices of its own —
// it decides what each tile is allowed to emit later.
//
// Plan space is (u, v) = (x, -z), as everywhere in this tree.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { chunked } from '../core/async.js';
import { buildParts, planArea, planBBox, partContains } from '../geom/ring.js';
import { makeGridIndex } from '../data/index.js';
import {
  readHouseNumber, readLevels, readName, readRoofShape, readUnits,
} from '../data/schema.js';
import { islandBuildingHeight } from '../world/islands.js';
import { MIN_RING_AREA, WALL_SINK, ringPlanArea } from '../world/ground.js';
import { M, facadeMaterial } from './materials.js';
import { assignLandmarks } from './landmarks.js';
import { storeyModel } from './units.js';
// Headroom a corridor and a building passage each demand of whatever crosses them: the portal
// punched through a wall has to clear the same height the trench below it was cut to.
import { PASSAGE_HEAD, UNDER_CLEAR } from '../world/grade.js';

// Coplanar-geometry resolution (Amendment 8 work: the daytime flicker).
//
// Two surfaces at the same plane and the same facing are a z-fight no depth buffer resolves; the
// massing extract is full of them because a real building is often several stacked slabs, each
// carrying its own complete ring, and where two of those rings share an edge both records extrude
// the same wall. WALL_TOL is how far apart two walls may be and still count as the same surface,
// WALL_MIN_OVERLAP the shortest shared run worth resolving, and CAP_COPLANAR_TOL the height
// difference under which two roof caps are the same plane.
const WALL_TOL = 0.06;
const WALL_MIN_OVERLAP = 0.25;
const CAP_PLANE_TOL = 0.030;       // two roof caps closer than this in Y are the same plane
const CAP_MIN_SEP = 0.020;         // ...and this is the separation the audit demands afterwards
const CAP_STEP = 0.060;            // how far a losing roof cap steps down out of a shared plane.
                                   // Comfortably more than CAP_PLANE_TOL, so one step always
                                   // clears the band that put the two caps in the same group
const CAP_MAX_STEP = 4;            // deepest a chain may go, so one pathological cluster cannot
                                   // sink a roof half a metre below its own wall head
const WALL_MIN_BAND = 0.05;        // a surviving strip of wall shorter than this is not worth a quad
/* ============================================ coplanar face resolution == */
/**
 * THE OTHER HALF OF THE DAYTIME FLICKER.
 *
 * A depth buffer cannot order two surfaces that occupy the same plane and face the same way; it
 * picks a winner per pixel per frame from whatever the interpolator happened to round to, and the
 * result is the shimmer you see across a whole facade as the camera moves. No amount of depth
 * precision fixes it, because the two surfaces are not near each other — they ARE each other.
 *
 * The massing extract is full of them by construction. A real building is often recorded as
 * several stacked slabs (CONTRACT section 1: "Some footprints are stacked massing slabs for one
 * real building. Do not merge them"), and each slab carries its own COMPLETE ring, so wherever two
 * slabs share a boundary both records extrude the same wall over the height they have in common.
 * Measured on this extract: 6,261 wall faces are the same surface as another record's, 44 km of
 * duplicated wall across 1,371 records.
 *
 * What is NOT a fight, and must not be "fixed": two neighbours sharing a party wall. Their rings
 * run in opposite directions along the shared line, so the two faces are back to back — each is a
 * back face from the other one's side and culling already resolves them. Only walls that face the
 * SAME way are a fight, which is what the co-orientation test below is for. Roughly two thirds of
 * all coincident wall pairs in the extract are party walls and are deliberately left alone.
 *
 * The resolution is suppression, not displacement. Nudging one wall inward opens a slot at the
 * corner where its neighbours still meet the original plane, and back-face culling turns that slot
 * into a view straight through the building. Instead the loser stops where the winner starts:
 *
 *   winner  = the record whose wall reaches HIGHER (ties broken by edge order, so it is total and
 *             stable — a rule that is not total leaves a pair unresolved, or resolves it both
 *             ways and deletes the wall entirely)
 *   loser   = keeps only the band BELOW the winner's base, over exactly the length they share
 *
 * Because the loser's top is always inside the winner's band, the survivor is always a single
 * interval [y0, cut] — there is never a hole in the middle of a wall — and the two together still
 * cover every square metre the pair used to. Where the loser is completely covered it emits
 * nothing, which is why this pass costs fewer vertices than it saves.
 */

// One wall face waiting to be emitted: a plan-space edge (au, av) -> (bu, bv) extruded y0..y1.
// `cuts` is a flat [t0, t1, top, ...] list — over the run t0..t1 metres along the edge, this wall
// stops at `top` because somebody else owns the surface above it.
function makeWallEdge(k, r, au, av, bu, bv, len, y0, y1) {
  return {
    k, r, au, av, bu, bv, len, uu: (bu - au) / len, uv: (bv - av) / len, y0, y1,
    cuts: null, holes: null,
  };
}

function addWallRing(list, all, idx, r, co, y0, y1) {
  const n = co.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const au = co[j], av = co[j + 1], bu = co[i], bv = co[i + 1];
    const du = bu - au, dv = bv - av;
    const len = Math.sqrt(du * du + dv * dv);
    if (!(len > 1e-4)) continue;
    const e = makeWallEdge(all.length, r, au, av, bu, bv, len, y0, y1);
    all.push(e);
    list.push(e);
    idx.add(Math.min(au, bu) - WALL_TOL, Math.min(av, bv) - WALL_TOL,
      Math.max(au, bu) + WALL_TOL, Math.max(av, bv) + WALL_TOL, e);
  }
}

// Do these two wall faces occupy the same plane, facing the same way, over a run worth resolving?
// Fills _wp with the shared band and returns its length, or 0.
const _wp = { ta: 0, tb: 0, sa: 0, sb: 0 };

function wallsCoincide(e, f) {
  // Same facing first: it is one dot product and it rejects every party wall in the city.
  if (e.uu * f.uu + e.uv * f.uv <= 0.966) return 0;          // more than 15 degrees apart
  const nu = -e.uv, nv = e.uu;
  const d1 = (f.au - e.au) * nu + (f.av - e.av) * nv;
  const d2 = (f.bu - e.au) * nu + (f.bv - e.av) * nv;
  if (Math.abs(d1) > WALL_TOL || Math.abs(d2) > WALL_TOL) return 0;
  const t1 = (f.au - e.au) * e.uu + (f.av - e.av) * e.uv;
  const t2 = (f.bu - e.au) * e.uu + (f.bv - e.av) * e.uv;
  const ta = Math.max(0, Math.min(t1, t2));
  const tb = Math.min(e.len, Math.max(t1, t2));
  if (tb - ta < WALL_MIN_OVERLAP) return 0;
  const s1 = (e.au - f.au) * f.uu + (e.av - f.av) * f.uv;
  const s2 = (e.bu - f.au) * f.uu + (e.bv - f.av) * f.uv;
  _wp.ta = ta; _wp.tb = tb;
  _wp.sa = Math.max(0, Math.min(s1, s2));
  _wp.sb = Math.min(f.len, Math.max(s1, s2));
  return tb - ta;
}

// Every candidate pair, once. `visit(e, f, run)` is called with the shared run in _wp.
function scanWallPairs(all, idx, visit) {
  for (let k = 0; k < all.length; k++) {
    const e = all[k];
    const x0 = Math.min(e.au, e.bu) - WALL_TOL, x1 = Math.max(e.au, e.bu) + WALL_TOL;
    const v0 = Math.min(e.av, e.bv) - WALL_TOL, v1 = Math.max(e.av, e.bv) + WALL_TOL;
    idx.queryBox(x0, v0, x1, v1, (f) => {
      if (f.k <= k) return;
      if (Math.min(e.y1, f.y1) - Math.max(e.y0, f.y0) <= WALL_MIN_BAND) return;
      const run = wallsCoincide(e, f);
      if (run > 0) visit(e, f, run);
    });
  }
}

// The height a wall face still reaches at `t` metres along it, after every cut that covers it.
function wallTopAt(e, t) {
  let top = e.y1;
  const c = e.cuts;
  if (!c) return top;
  for (let i = 0; i < c.length; i += 3) {
    if (t >= c[i] && t <= c[i + 1] && c[i + 2] < top) top = c[i + 2];
  }
  return top;
}

// ...and where its foot starts, after every portal punched through it. The wall above a portal is
// the lintel and stays; everything from the corridor floor to the head of the opening goes.
function wallBaseAt(e, t) {
  let base = e.y0;
  const h = e.holes;
  if (!h) return base;
  for (let i = 0; i < h.length; i += 3) {
    if (t >= h[i] && t <= h[i + 1] && h[i + 2] > base) base = h[i + 2];
  }
  return base;
}

/**
 * Find every duplicated wall face and cut the loser back. Returns the audit.
 * @param {object[]} records prepped buildings, `parts` already built
 */
function resolveCoplanarWalls(records, extent, stats) {
  const cell = 10.0;
  const u0 = -extent.x / 2 - 400, v0 = -extent.z / 2 - 400;
  const idx = makeGridIndex(cell, u0, v0,
    Math.ceil((extent.x + 800) / cell) + 1, Math.ceil((extent.z + 800) / cell) + 1);
  const all = [];
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.landmark === 'cn') continue;
    const y0 = b.y - WALL_SINK, y1 = b.y + b.h;
    const list = [];
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      addWallRing(list, all, idx, r, part.outer, y0, y1);
      for (let h = 0; h < part.holes.length; h++) addWallRing(list, all, idx, r, part.holes[h], y0, y1);
    }
    b.walls = list;
  }

  const A = stats.coplanar;
  A.wallFaces = all.length;
  scanWallPairs(all, idx, (e, f, run) => {
    A.wallPairs++;
    A.wallMetres += run;
    // Total, stable order: the higher wall keeps the surface, ties go to the earlier edge.
    const eWins = e.y1 > f.y1 || (e.y1 === f.y1 && e.k < f.k);
    const L = eWins ? f : e;
    const W = eWins ? e : f;
    const cut = Math.max(L.y0, W.y0);
    const ta = eWins ? _wp.sa : _wp.ta;
    const tb = eWins ? _wp.sb : _wp.tb;
    if (!L.cuts) L.cuts = [];
    L.cuts.push(ta, tb, cut);
  });

  // Re-audit against what will actually be emitted rather than trusting the rule above. Any pair
  // whose two survivors still share a band is a fight that got through, and must be zero.
  scanWallPairs(all, idx, (e, f) => {
    const t = (_wp.ta + _wp.tb) * 0.5;
    const s = (_wp.sa + _wp.sb) * 0.5;
    const eTop = wallTopAt(e, t);
    const fTop = wallTopAt(f, s);
    const lo = Math.max(e.y0, f.y0);
    const hi = Math.min(eTop, fTop);
    if (hi - lo > WALL_MIN_BAND) A.wallPairsLeft++;
  });
  return A;
}

// One wall quad between two stations along an edge. Winding follows the ring order, so a plan-CCW
// outer ring faces outward and a plan-CW hole ring faces into the void — which is what back-face
// culling wants from each of them.
function wallQuad(mb, e, a, b, y0, y1) {
  const ia = a / e.len, ib = b / e.len;
  const ax = e.au + (e.bu - e.au) * ia, az = -(e.av + (e.bv - e.av) * ia);
  const bx = e.au + (e.bu - e.au) * ib, bz = -(e.av + (e.bv - e.av) * ib);
  mb.tri(ax, y0, az, bx, y0, bz, bx, y1, bz);
  mb.tri(ax, y0, az, bx, y1, bz, ax, y1, az);
}

// Emit one wall face as the runs that survived. Uncut faces — the overwhelming majority — take the
// fast path and cost exactly what a straight extrusion of the ring used to.
const _wbp = [];

function emitWallFace(mb, e, stats) {
  if (!e.cuts && !e.holes) { wallQuad(mb, e, 0, e.len, e.y0, e.y1); return; }
  const cuts = e.cuts;
  const holes = e.holes;
  const bp = _wbp;
  bp.length = 0;
  bp.push(0, e.len);
  if (cuts) {
    for (let i = 0; i < cuts.length; i += 3) {
      const a = clamp(cuts[i], 0, e.len), b = clamp(cuts[i + 1], 0, e.len);
      if (b - a > 1e-4) bp.push(a, b);
    }
  }
  if (holes) {
    for (let i = 0; i < holes.length; i += 3) {
      const a = clamp(holes[i], 0, e.len), b = clamp(holes[i + 1], 0, e.len);
      if (b - a > 1e-4) bp.push(a, b);
    }
  }
  bp.sort((p, q) => p - q);
  for (let k = 0; k + 1 < bp.length; k++) {
    const a = bp[k], b = bp[k + 1];
    // No minimum slice width beyond a float epsilon. A 2 cm strip of wall dropped between two
    // cuts is a 2 cm slot straight through the building, and back-face culling makes a slot a
    // window onto whatever is behind it; six vertices are cheaper than that.
    if (b - a < 1e-4) continue;
    const mid = (a + b) * 0.5;
    const top = wallTopAt(e, mid);
    const base = wallBaseAt(e, mid);
    if (top - base < WALL_MIN_BAND) { stats.coplanar.wallFacesDropped++; continue; }
    if (top < e.y1 - 1e-6) stats.coplanar.wallFacesClipped++;
    wallQuad(mb, e, a, b, base, top);
  }
}

/**
 * CONTRACT 8.1 — "roads that pass under a rail corridor, an expressway or a building must be
 * MODELLED, not deleted". Modelling the road is only half of it: the structure ON TOP has to let
 * it through.
 *
 * York and Bay Streets dive under Union Station into the teamways, and a further 1.6 km of
 * building passages walk straight through the base of a tower. The massing knows nothing about any
 * of that, so its perimeter wall stands square across the carriageway and the underpass — which IS
 * built, and which the ground correctly dips into — dead-ends in a blank facade a pedestrian
 * cannot pass. That is the "roads just cut off" in the report, and this is where it is opened.
 *
 * Wherever a corridor or a passage CROSSES a wall face, the wall goes from its foot up to the head
 * the corridor needs, and the building stands on the lintel that is left. The head is the same
 * number `emitTrench` gives the soffit, so wall and ceiling meet on one line with no seam.
 *
 * Only a crossing wall opens. A building that merely lines a depressed street runs PARALLEL to it
 * with its facade at the back of the pavement — inside the corridor's outer envelope — and would
 * otherwise have its whole ground floor cut away; the direction test and the narrower carriageway
 * envelope are what keep it shut.
 */
const PORTAL_MIN_RUN = 1.2;        // a shorter crossing than this is a corner nick, not a doorway
const PORTAL_AXIS_MAX = 0.75;      // |cos| between wall and corridor: above this they are parallel

function punchCorridorPortals(records, grade, terrainY, stats) {
  if (!grade || typeof grade.span !== 'function') return;
  const G = stats.grade;
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b || !b.walls) continue;
    for (let w = 0; w < b.walls.length; w++) {
      const e = b.walls[w];
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
          const a = clamp(runA - dt * 0.5, 0, e.len);
          const bb = clamp(runB + dt * 0.5, 0, e.len);
          if (bb - a >= PORTAL_MIN_RUN && runHead > e.y0 + WALL_MIN_BAND) {
            (e.holes || (e.holes = [])).push(a, bb, runHead);
            G.wallPortals++;
            G.wallPortalMetres += bb - a;
          }
          runA = -1; runB = -1; runHead = 0;
        }
      }
    }
  }
}

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

/**
 * Roof caps. A cap is a horizontal face, so its fight is with another cap at the same height —
 * and its other failure is simply being INSIDE something taller, where it costs vertices to draw
 * a roof nobody can see.
 *
 * Two answers, because there are two shapes of problem:
 *   * a cap wholly inside a record that reaches above it is DELETED. Where every part of a record
 *     is wholly inside a neighbour that also starts at or below it, the record is dropped whole —
 *     walls, cap, beacon, ground floor and rooftop plant, all of which were previously being
 *     built inside somebody else's tower.
 *   * two caps on the same plane that merely OVERLAP cannot be resolved by deletion without
 *     clipping one polygon against the other, so the loser STEPS DOWN instead. A roof 6 cm below
 *     its own wall head is a parapet; two roofs at the same height are a fight.
 *
 * The step has to be a chain depth, not a neighbour count. Where A beats B and B beats C but A
 * and C never touch, counting neighbours puts B and C on the same step and hands the fight
 * straight back; taking each cap's level as one more than the deepest cap that beats it and
 * overlaps it cannot. Ranking is a total order, so processing the caps in it visits every
 * dominator before its dependant and one sweep is enough.
 */
function resolveCoplanarCaps(records, bIndex, stats) {
  const A = stats.coplanar;
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts) continue;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      part.capArea = Math.abs(planArea(part.outer));
      part.capBuried = false;
      part.capDrop = 0;
      part.capLevel = -1;
    }
  }

  /* --- burial ------------------------------------------------------------ */
  const live = [];
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.landmark === 'cn') continue;
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
        if (buried || o === b || !o.parts || o.landmark === 'cn') return;
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
        live.push(b, p);
      }
    }
    b.buried = allBuried;
    if (allBuried) A.buriedRecords++;
  }

  /* --- step-down --------------------------------------------------------- */
  // Sorted into the ranking order, so every cap that can dominate this one already has a level.
  const order = [];
  for (let i = 0; i < live.length; i += 2) {
    if (!live[i].buried) order.push(i);
  }
  order.sort((ia, ib) => {
    const a = live[ia], ap = live[ia + 1];
    const b = live[ib], bp = live[ib + 1];
    return capOutranks(a, ap, b, bp) ? -1 : 1;
  });
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const b = live[i], p = live[i + 1];
    const part = b.parts[p];
    const top = b.y + b.h;
    const bb = part.bbox;
    const qx = (bb[0] + bb[2]) * 0.5, qz = -(bb[1] + bb[3]) * 0.5;
    const qr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1;
    // Take the first step that is genuinely clear of every cap already placed, tested against the
    // heights they were actually placed at. Counting dominators is not enough: a cap stepping out
    // of ITS plane can land on a neighbouring one, which is exactly the case a chain depth misses.
    let lvl = 0;
    while (lvl <= CAP_MAX_STEP) {
      const y = top - lvl * CAP_STEP;
      let clash = false;
      bIndex.query(qx, qz, qr, (o) => {
        if (clash || o === b || !o.parts || o.buried || o.landmark === 'cn') return;
        for (let q = 0; q < o.parts.length; q++) {
          const other = o.parts[q];
          if (other.capBuried || other.capLevel < 0) continue;
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

  /* --- re-audit ---------------------------------------------------------- */
  // Any two caps still left within CAP_MIN_SEP of each other with overlapping footprints.
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.buried || b.landmark === 'cn') continue;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (part.capBuried) continue;
      const top = b.y + b.h - part.capDrop;
      const bb = part.bbox;
      bIndex.query((bb[0] + bb[2]) * 0.5, -(bb[1] + bb[3]) * 0.5,
        Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1, (o) => {
          if (o === b || !o.parts || o.buried || o.key <= b.key || o.landmark === 'cn') return;
          for (let q = 0; q < o.parts.length; q++) {
            const other = o.parts[q];
            if (other.capBuried) continue;
            if (Math.abs((o.y + o.h - other.capDrop) - top) >= CAP_MIN_SEP) continue;
            if (partsOverlap(other, part)) { A.capPairsLeft++; return false; }
          }
        });
    }
  }
}


/**
 * Prepare every building record: rings into oriented parts, material and lighting profile, the
 * storey model, the landmark claim, and the uniform-grid broadphase they all go into.
 *
 * NOTHING IS TRIANGULATED HERE. Ear clipping happens inside emitCap(), which runs per tile, so
 * the cost of the roof of a building nobody has flown near yet is never paid.
 *
 * @param {object} W the raw building list and everything a record's attributes depend on.
 * @returns {Promise<{prepped: Array, bIndex: object, cnX: number, cnZ: number, cnBaseY: number}>}
 */
async function prepareBuildings(W) {
  const { buildingsRaw, HARBOUR, SUR_FRINGE, extent, groundY, project, report, stats } = W;

  const prepped = new Array(buildingsRaw.length);
  for (let i = 0; i < buildingsRaw.length; i++) {
    const b = buildingsRaw[i];
    const rings = Array.isArray(b.r) ? b.r : [];
    let cx = 0, cz = 0, n = 0;
    const r0 = rings[0];
    if (Array.isArray(r0)) {
      for (let k = 0; k < r0.length; k++) {
        if (!isNum(r0[k][0])) continue;
        cx += r0[k][0]; cz += r0[k][1]; n++;
      }
    }
    prepped[i] = {
      key: i + 1,
      // ISLANDS: on the island cottages the massing extract's height is the tree canopy over the
      // roof, not the roof. islandBuildingHeight() caps a small island footprint at a plausible
      // house; everywhere else it returns b.h untouched. See harbour.js.
      h: islandBuildingHeight(HARBOUR, n ? cx / n : 0, n ? cz / n : 0, ringPlanArea(r0),
        isNum(b.h) ? b.h : 0),
      y: isNum(b.y) ? b.y : 0,
      cx: n ? cx / n : 0,
      cz: n ? cz / n : 0,
      rings,
      // Surveyed per-building attributes: lighting profile, facade colour, material, name.
      t: b.t,
      c: b.c,
      m: b.m,
      name: readName(b),
      // THE SURVEYED GROUND FLOOR. `units` are the premises OSM has on this building's frontage,
      // in order along it, each carrying the footprint SEGMENT and the parameter along it that
      // says where it really is; `hn` its street number; `lv` its real storey count; `roof` its
      // roof shape. Everything the block-face model below builds comes off these four.
      units: readUnits(b),
      hn: readHouseNumber(b),
      lv: readLevels(b),
      roof: readRoofShape(b),
      // Storey model, resolved once by storeyModel(): levels, floor-to-floor, ground storey.
      levels: 0, storeyH: 0, groundH: 0, levelsFromData: false,
      parts: null,
      mainPart: null,
      area: 0,
      mat: null,
      profile: 0,
      cls: '',
      landmark: null,
      bbox: null,
      towerSign: -1,
      // Street frontage, filled in by findFrontage() during the facade pass.
      frontX: 0, frontZ: 0, frontYaw: 0, frontLen: 0, frontNU: 1, frontNV: 0,
    };
  }
  const claims = assignLandmarks(prepped, project);

  // Wide enough to hold the reachable part of the synthesised fringe as well as the survey: a
  // fringe mass indexed outside these bounds would be clamped into a boundary cell, and that cell
  // would then be queried by everything along the whole edge of the map.
  const B_PAD = 200 + SUR_FRINGE;
  const bIndex = makeGridIndex(48, -extent.x / 2 - B_PAD, -extent.z / 2 - B_PAD,
    Math.ceil((extent.x + B_PAD * 2) / 48) + 1, Math.ceil((extent.z + B_PAD * 2) / 48) + 1);

  const cnPoint = project(-79.3871, 43.6426);
  let cnBuilding = null;
  let cnDone = false;

  // Footprint preparation only: rings are split into parts and oriented, but NOTHING is
  // triangulated here. Ear clipping happens inside emitCap(), which now runs per tile, so the
  // cost of the roof of a building nobody has flown near yet is never paid.
  report(0.46, 'reading footprints');
  await chunked(prepped.length, 600, (i) => {
    const b = prepped[i];
    if (b.h <= 0.5) return;
    const parts = buildParts(b.rings, MIN_RING_AREA);
    if (!parts) { stats.ringsSkipped++; return; }
    b.parts = parts;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    let area = 0, bestArea = -1;
    for (let p = 0; p < parts.length; p++) {
      const bb = planBBox(parts[p].outer);
      x0 = Math.min(x0, bb[0]); x1 = Math.max(x1, bb[2]);
      z0 = Math.min(z0, -bb[3]); z1 = Math.max(z1, -bb[1]);
      const a = Math.abs(planArea(parts[p].outer));
      area += a;
      // The detail pass hangs the frontage, the roofscape and the parapet off ONE part; a stacked
      // massing record has several, and the biggest is the one a pedestrian actually meets.
      if (a > bestArea) { bestArea = a; b.mainPart = parts[p]; }
    }
    b.bbox = [x0, z0, x1, z1];
    b.area = bestArea > 0 ? bestArea : area;
    bIndex.add(x0, z0, x1, z1, b);
    stats.buildings++;
    stats.rings += parts.length;

    const L = claims[i];
    b.landmark = L ? L.key : null;
    if (L) stats.landmarkHeights[L.key] = Math.max(stats.landmarkHeights[L.key] || 0, b.h);
    const isCN = L && L.key === 'cn';
    if (isCN && !cnDone) {
      cnDone = true;
      cnBuilding = b;
      b.mat = M.cnShaft;
      b.profile = 0;
      b.cls = 'concrete';
      b.glass = false;
      stats.materials.concrete = (stats.materials.concrete || 0) + 1;
      stats.profiles[0]++;
      return;
    }
    if (isCN) return;

    const spec = facadeMaterial(b, L);
    b.mat = spec.mat;
    b.profile = spec.profile;
    b.cls = spec.cls;
    b.glass = spec.glassy;
    stats.materials[spec.cls] = (stats.materials[spec.cls] || 0) + 1;
    stats.profiles[spec.profile]++;
    if (spec.tagged) stats.surveyedColour++;
    // The storey model, resolved ONCE here rather than per tile: it is a property of the
    // building, every pass that lays anything out vertically reads it, and it is also where the
    // surveyed level count gets accepted or rejected.
    storeyModel(b);
    const FA = stats.facades;
    if (b.levelsFromData) FA.levelsFromData++;
    else {
      FA.levelsDerived++;
      if (b.lv > 0) FA.levelsRejected++;
    }
  }, (f) => report(0.46 + f * 0.06, 'reading footprints'));

  // The CN Tower must exist even if the massing record was rejected. Either way it is a feature
  // like any other, anchored in the tile that holds it.
  const cnX = cnBuilding ? cnBuilding.cx : cnPoint[0];
  const cnZ = cnBuilding ? cnBuilding.cz : cnPoint[1];
  const cnBaseY = cnBuilding ? cnBuilding.y - 0.6 : groundY(cnPoint[0], cnPoint[1]);

  return { prepped, bIndex, cnX, cnZ, cnBaseY };
}

export {
  prepareBuildings, resolveCoplanarWalls, emitWallFace, punchCorridorPortals, resolveCoplanarCaps,
};
