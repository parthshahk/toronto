// src/city/buildings.js — extruding a footprint, and the wall faces that come out of it.
//
// CONTRACT.md §3.1 and Amendment 11.1. This is the half of the building pass that turns a record
// into something a tile can emit:
//
//   addWallRing()       one ring's worth of wall faces, keyed and indexed.
//   wallsCoincide()     do two wall faces occupy the same plane, facing the same way?
//   emitWallFace()      the wall quads themselves, honouring the cuts and the portals.
//
// Turning a raw massing record INTO one of these — rings into oriented parts, material and
// lighting profile, the storey model, the landmark claim, the broadphase — lives in city/prep.js,
// which does it one record at a time, when something asks, rather than for the whole city before
// the first frame.
//
// WHO OWNS A SHARED SURFACE is decided by city/coplanar.js, a record at a time, when a tile first
// asks for that record. It used to be three whole-city passes here — walls, portals and caps —
// and at 43 km2 they cost 418 ms in front of the first frame; over the pre-1998 city they project
// to four seconds of a player staring at a loading bar. The rules did not change, only when they
// run: every one of them is answered by geometry that TOUCHES the record asking, so the answer for
// one record is a function of its neighbours and of nothing else. See city/coplanar.js for the two
// places that used to lean on global iteration order and how each was made independent of it.
//
// Plan space is (u, v) = (x, -z), as everywhere in this tree.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { WALL_SINK } from '../world/ground.js';

// Coplanar-geometry resolution (Amendment 8 work: the daytime flicker).
//
// Two surfaces at the same plane and the same facing are a z-fight no depth buffer resolves; the
// massing extract is full of them because a real building is often several stacked slabs, each
// carrying its own complete ring, and where two of those rings share an edge both records extrude
// the same wall. WALL_TOL is how far apart two walls may be and still count as the same surface
// and WALL_MIN_OVERLAP the shortest shared run worth resolving. The rule that uses them lives in
// city/coplanar.js; the primitives it is built out of live here, next to the emitter they feed.
const WALL_TOL = 0.06;
const WALL_MIN_OVERLAP = 0.25;
const WALL_MIN_BAND = 0.05;        // a surviving strip of wall shorter than this is not worth a quad

/* =================================================== wall faces == */
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
 * SAME way are a fight, which is what the co-orientation test in wallsCoincide() is for. Roughly
 * two thirds of all coincident wall pairs in the extract are party walls and are deliberately left
 * alone.
 *
 * The resolution is suppression, not displacement. Nudging one wall inward opens a slot at the
 * corner where its neighbours still meet the original plane, and back-face culling turns that slot
 * into a view straight through the building. Instead the loser stops where the winner starts:
 *
 *   winner  = the record whose wall reaches HIGHER (ties broken by edge key, so it is total and
 *             stable — a rule that is not total leaves a pair unresolved, or resolves it both
 *             ways and deletes the wall entirely)
 *   loser   = keeps only the band BELOW the winner's base, over exactly the length they share
 *
 * Because the loser's top is always inside the winner's band, the survivor is always a single
 * interval [y0, cut] — there is never a hole in the middle of a wall — and the two together still
 * cover every square metre the pair used to. Where the loser is completely covered it emits
 * nothing, which is why this pass costs fewer vertices than it saves.
 *
 * city/coplanar.js applies that rule, a record at a time, on demand.
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

/**
 * Extrude one ring into wall faces, append them to the record's list and index them.
 *
 * THE KEY IS COMPOSED, not counted: `base` is the record's key times a stride and the ordinal is
 * the record's own edge count so far. The whole-city pass numbered edges by the order it happened
 * to build them in — records in key order, and within a record parts, then rings, then edges — so
 * a composed key induces exactly the same total order while depending on nothing outside the
 * record. That is what lets the tie-break rule ("the earlier edge wins") survive being evaluated
 * a building at a time, in whatever order the tiles ask.
 *
 * @param {object[]} list the record's wall faces, appended to
 * @param {number} base the record's key times EDGE_STRIDE
 * @param {object} idx the plan-space wall broadphase
 * @param {object} rec the building record the faces belong to
 */
function addWallRing(list, base, idx, rec, co, y0, y1) {
  const n = co.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const au = co[j], av = co[j + 1], bu = co[i], bv = co[i + 1];
    const du = bu - au, dv = bv - av;
    const len = Math.sqrt(du * du + dv * dv);
    if (!(len > 1e-4)) continue;
    const e = makeWallEdge(base + list.length, rec, au, av, bu, bv, len, y0, y1);
    list.push(e);
    idx.add(Math.min(au, bu) - WALL_TOL, Math.min(av, bv) - WALL_TOL,
      Math.max(au, bu) + WALL_TOL, Math.max(av, bv) + WALL_TOL, e);
  }
}

// Do these two wall faces occupy the same plane, facing the same way, over a run worth resolving?
// Fills _wp with the shared band and returns its length, or 0.
//
// MEASURED IN THE FIRST ARGUMENT'S FRAME, which is why the caller always passes the lower-keyed
// edge first: the co-orientation test has a 15-degree threshold and the projection is onto e's
// normal, so a pair a hair either side of it can coincide read one way and not the other. `ta/tb`
// are the shared band along e, `sa/sb` the same band along f.
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

/** The shared band the last wallsCoincide() found. Written and read within one call. */
function wallPair() { return _wp; }

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

export {
  WALL_TOL, WALL_MIN_BAND,
  addWallRing, wallsCoincide, wallPair, wallTopAt, emitWallFace,
};
