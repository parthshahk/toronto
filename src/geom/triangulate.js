// src/geom/triangulate.js — ear clipping with hole bridging, in plan space.
//
// Input is a flat plan-space coordinate array [u0,v0,u1,v1,...] with the outer ring first (CCW)
// and holes after (CW), described by `holeStarts` (vertex indices). Output is a flat array of
// vertex-index triples wound counter-clockwise. See geom/ring.js for what plan space is and for
// buildParts(), which produces the parts this consumes.
//
// Sign convention below matches the classic formulation: turn(p, q, r) < 0 for a CCW turn.
//
// NEVER LOOPS FOREVER. The extract holds ~5,110 rings, a good number of them self-intersecting or
// degenerate, and this runs during loading with the frame budget already spent. Every traversal
// burns from a shared operation budget that triangulate() resets on entry; when it runs out the
// clipper returns what it has rather than hanging. `_ops` is module scope for speed, but it is
// written and read entirely within one triangulate() call and carries nothing between calls.

import { sgn } from '../core/util.js';
import { shoelace } from './ring.js';

const EPS = 1e-9;

// Ear clipping legitimately emits collinear ears where a ring has three points in a line, and a
// zero-area triangle has no normal to derive: MeshBuilder falls back to +Y for it, which on a wall
// or a soffit is simply wrong. They also cost vertices for nothing. Drop them at the source.
export const CAP_MIN_AREA = 1e-7;


// Ear clipping with hole bridging. Input is a flat plan-space coordinate array [u0,v0,u1,v1,...]
// with the outer ring first (CCW) and holes after (CW), described by `holeStarts` (vertex indices).
// Sign convention below matches the classic formulation: turn(p,q,r) < 0 for a CCW turn.

let _ops = 0;
const OP_LIMIT = 600000;

class PNode {
  constructor(i, x, y) {
    this.i = i; this.x = x; this.y = y;
    this.prev = null; this.next = null; this.steiner = false;
  }
}

function nodeInsert(i, x, y, last) {
  const p = new PNode(i, x, y);
  if (!last) { p.prev = p; p.next = p; } else {
    p.next = last.next; p.prev = last; last.next.prev = p; last.next = p;
  }
  return p;
}

function nodeRemove(p) { p.next.prev = p.prev; p.prev.next = p.next; }

function turn(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }

function nodeEq(a, b) { return a.x === b.x && a.y === b.y; }

function ringToList(co, start, end, wantCCW) {
  let last = null;
  const ccw = shoelace(co, start, end) > 0;
  if (ccw === wantCCW) {
    for (let i = start; i < end; i += 2) last = nodeInsert(i, co[i], co[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = nodeInsert(i, co[i], co[i + 1], last);
  }
  if (last && nodeEq(last, last.next)) { nodeRemove(last); last = last.next; }
  return last;
}

// A vertex this far off the straight line between its neighbours contributes nothing but a
// zero-area ear. An exact `turn() === 0` test misses almost all of them: the massing data is
// stored to the centimetre in coordinates of order 1e3, so three genuinely collinear vertices
// come out of the cross product at 1e-14 rather than at 0, survive the filter, and reach the cap
// as a triangle with no derivable normal. One millimetre of deviation is two orders of magnitude
// below the data's own precision, so nothing real is ever removed.
const COLLINEAR_DEV = 0.001;

// Perpendicular distance x |prev->next| of `q` from the line through its neighbours. |turn| IS
// that product, because cross(q - p, r - q) === cross(q - p, r - p).
function collinearDrop(p) {
  const rx = p.next.x - p.prev.x, ry = p.next.y - p.prev.y;
  const rl = Math.sqrt(rx * rx + ry * ry);
  const t = turn(p.prev, p, p.next);
  return rl > EPS ? Math.abs(t) <= COLLINEAR_DEV * rl : t === 0;
}

// Drop collinear and duplicate vertices.
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    if (++_ops > OP_LIMIT) return p;
    again = false;
    if (!p.steiner && (nodeEq(p, p.next) || collinearDrop(p))) {
      nodeRemove(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}

function pointInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  // Reflex corner — or an ear so thin the cap would drop it anyway. Clipping it would consume a
  // real vertex to produce a triangle with no derivable normal; refusing it lets the clipper find
  // a neighbouring ear that carries area, and the pass ladder collapses whatever is left.
  if (turn(a, b, c) >= -CAP_MIN_AREA) return false;
  let p = c.next;
  while (p !== a) {
    if (++_ops > OP_LIMIT) return false;
    if (pointInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && turn(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function onSegment(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}


/**
 * Do segments p1-q1 and p2-q2 intersect, including at an endpoint or along a collinear overlap?
 *
 * Takes NODES — objects with numeric .x and .y — because that is what the clipper has. It is
 * exported only because one caller outside this module already reaches for it; see the note at
 * that call site in city.js before you use it yourself.
 */
export function segIntersects(p1, q1, p2, q2) {
  const o1 = sgn(turn(p1, q1, p2));
  const o2 = sgn(turn(p1, q1, q2));
  const o3 = sgn(turn(p2, q2, p1));
  const o4 = sgn(turn(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (++_ops > OP_LIMIT) return true;
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
      segIntersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a, b) {
  return turn(a.prev, a, a.next) < 0
    ? turn(a, b, a.next) >= 0 && turn(a, a.prev, b) >= 0
    : turn(a, b, a.prev) < 0 || turn(a, a.next, b) < 0;
}

function middleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (++_ops > OP_LIMIT) return inside;
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
      (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (turn(a.prev, a, b.prev) !== 0 || turn(a, b.prev, b) !== 0)) ||
      (nodeEq(a, b) && turn(a.prev, a, a.next) < 0 && turn(b.prev, b, b.next) < 0));
}

// Split the ring at the diagonal a-b, returning the node that starts the second ring.
function splitPolygon(a, b) {
  const a2 = new PNode(a.i, a.x, a.y);
  const b2 = new PNode(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function leftmost(list) {
  let p = list, best = list;
  do {
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) best = p;
    p = p.next;
  } while (p !== list);
  return best;
}

// Eberly's mutually-visible-vertex search: shoot +u from the hole's leftmost point, take the
// nearest hit edge, then refine against reflex vertices inside the (hole, hit, candidate) triangle.
function findHoleBridge(hole, outer) {
  let p = outer, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {
    if (++_ops > OP_LIMIT) break;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;

  const stop = m;
  const mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (++_ops > OP_LIMIT) break;
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin &&
        (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p; tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m, p) {
  return turn(m.prev, m, p.prev) < 0 && turn(p.next, m, m.next) < 0;
}

function eliminateHole(hole, outer) {
  const bridge = findHoleBridge(hole, outer);
  if (!bridge) return outer;
  const b2 = splitPolygon(bridge, hole);
  filterPoints(b2, b2.next);
  return filterPoints(bridge, bridge.next);
}

function eliminateHoles(co, holeStarts, outer) {
  const queue = [];
  for (let i = 0; i < holeStarts.length; i++) {
    const s = holeStarts[i] * 2;
    const e = i < holeStarts.length - 1 ? holeStarts[i + 1] * 2 : co.length;
    const list = ringToList(co, s, e, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(leftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  let out = outer;
  for (let i = 0; i < queue.length; i++) out = eliminateHole(queue[i], out);
  return out;
}

function cureLocalIntersections(start, tris) {
  let p = start;
  do {
    if (++_ops > OP_LIMIT) break;
    const a = p.prev, b = p.next.next;
    if (!nodeEq(a, b) && segIntersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      // The cure removes two vertices whatever happens; the triangle it hands back in exchange is
      // only worth keeping if it has area. On a self-intersecting ring it very often does not.
      if (Math.abs(turn(a, p, b)) > EPS) tris.push(a.i >> 1, p.i >> 1, b.i >> 1);
      nodeRemove(p); nodeRemove(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start, tris, depth) {
  if (depth > 6 || !start) return;
  let a = start;
  do {
    if (++_ops > OP_LIMIT) return;
    let b = a.next.next;
    while (b !== a.prev) {
      if (++_ops > OP_LIMIT) return;
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        const a2 = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a2, tris, 0, depth + 1);
        earcutLinked(c, tris, 0, depth + 1);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function earcutLinked(ear, tris, pass, depth) {
  if (!ear) return;
  let stop = ear;
  while (ear.prev !== ear.next) {
    if (++_ops > OP_LIMIT) return;
    const prev = ear.prev, next = ear.next;
    if (isEar(ear)) {
      tris.push(prev.i >> 1, ear.i >> 1, next.i >> 1);
      nodeRemove(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), tris, 1, depth);
      else if (pass === 1) {
        const cured = cureLocalIntersections(filterPoints(ear), tris);
        earcutLinked(cured, tris, 2, depth);
      } else if (pass === 2) splitEarcut(ear, tris, depth);
      return;
    }
  }
}

/**
 * Triangulate a plan-space polygon. `co` is [u0,v0,...]; `holeStarts` lists the vertex index each
 * hole begins at. Returns a flat array of vertex-index triples, wound counter-clockwise.
 * Never loops forever: every traversal burns from a shared operation budget.
 */
export function triangulate(co, holeStarts) {
  _ops = 0;
  const tris = [];
  const outerEnd = (holeStarts && holeStarts.length) ? holeStarts[0] * 2 : co.length;
  if (outerEnd < 6) return tris;
  let outer = filterPoints(ringToList(co, 0, outerEnd, true));
  if (!outer || outer.next === outer.prev) return tris;
  if (holeStarts && holeStarts.length) outer = filterPoints(eliminateHoles(co, holeStarts, outer));
  earcutLinked(outer, tris, 0, 0);
  return tris;
}
