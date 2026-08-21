// src/geom/ring.js — plan-space ring predicates and ring repair.
//
// PLAN SPACE. Every routine here works in (u, v) = (x, -z): u is east, v is NORTH. That is the
// ordinary maths convention (v up on paper), so "counter-clockwise = positive signed area" holds
// without any mental gymnastics, and a plan-CCW polygon emitted as 3D triangles with x = u,
// z = -v comes out with a +Y normal — which is what roof caps and every ground ribbon need,
// because the renderer culls back faces.
//
// A RING is a flat coordinate array [u0, v0, u1, v1, ...] with no closing duplicate.
// A PART is one outer ring (forced CCW) plus its holes (forced CW), together with the flat
// coordinate array and hole offsets geom/triangulate.js wants.
//
// RING WINDING. ESRI winds outer rings clockwise and holes counter-clockwise; the build step
// negated north into +Z, which mirrors the plane and flips that. Nothing here assumes either:
// each ring's signed area is measured, the largest |area| ring of a record is the outer boundary,
// rings that share its sign are separate parts (islands) and rings of the opposite sign are holes.
// Orientation is then forced before anything is emitted.
//
// Pure geometry: no city knowledge, no module-level mutable state beyond one write-then-read
// scratch object, no allocation in the hot predicates.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';

const EPS = 1e-9;

// Signed area x2 of co[start..end) — positive = counter-clockwise in plan space.
export function shoelace(co, start, end) {
  let s = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) s += co[j] * co[i + 1] - co[i] * co[j + 1];
  return s;
}


// Plan-space signed area x2 of a triangle, in (u, v) = (x, -z). Positive means the winding gives
// a +Y normal, i.e. the face looks at the sky.
export function planWind2(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
}


// One polygon part: an outer ring (plan CCW) plus its holes (plan CW), plus the flat coordinate
// array and hole offsets that `triangulate` wants.
export function makePart(outerRing, holeRings) {
  const co = [];
  for (let i = 0; i < outerRing.length; i += 2) { co.push(outerRing[i], outerRing[i + 1]); }
  const holeStarts = [];
  for (let h = 0; h < holeRings.length; h++) {
    holeStarts.push(co.length >> 1);
    const r = holeRings[h];
    for (let i = 0; i < r.length; i += 2) co.push(r[i], r[i + 1]);
  }
  return { co, holeStarts, outer: outerRing, holes: holeRings, bbox: planBBox(outerRing) };
}

// Raw [[x,z],...] ring -> flat plan-space [u,v,...] with the closing duplicate and any repeated
// vertices removed. Vertices closer together than WELD are merged: the massing data stores 1 cm
// precision and sub-centimetre edges are digitising noise that turns into needle-thin spikes whose
// walls have no meaningful inside. Returns null when fewer than three distinct points survive.
const WELD = 0.02;
export function toPlan(ring) {
  const n = ring.length;
  if (!n) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
    const u = p[0], v = -p[1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - u) < WELD && Math.abs(out[m - 1] - v) < WELD) continue;
    out.push(u, v);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < WELD &&
    Math.abs(out[1] - out[out.length - 1]) < WELD) out.length -= 2;
  return out.length >= 6 ? out : null;
}

export function planArea(co) { return shoelace(co, 0, co.length) * 0.5; }

export function reverseRing(co) {
  const out = new Array(co.length);
  for (let i = 0, j = co.length - 2; i < co.length; i += 2, j -= 2) {
    out[i] = co[j]; out[i + 1] = co[j + 1];
  }
  return out;
}

export function planBBox(co) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < co.length; i += 2) {
    if (co[i] < x0) x0 = co[i];
    if (co[i] > x1) x1 = co[i];
    if (co[i + 1] < y0) y0 = co[i + 1];
    if (co[i + 1] > y1) y1 = co[i + 1];
  }
  return [x0, y0, x1, y1];
}

export function planContains(co, px, py) {
  let inside = false;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const xi = co[i], yi = co[i + 1], xj = co[j], yj = co[j + 1];
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi + (yj === yi ? EPS : 0)) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// A hole smaller than this is digitising noise, not a courtyard. Overridable per call so a
// caller with a different idea of "noise" does not have to reach into this module.
const MIN_HOLE_AREA = 1.5;

/**
 * Split a record's rings into parts. The largest |area| ring is the outer boundary; rings with the
 * same orientation are separate parts, opposite ones are holes assigned to the part containing them.
 */
export function buildParts(rings, minArea, minHoleArea = MIN_HOLE_AREA) {
  const prepared = [];
  for (let i = 0; i < rings.length; i++) {
    const co = toPlan(rings[i]);
    if (!co) continue;
    const a = planArea(co);
    if (!isNum(a) || Math.abs(a) < 1e-4) continue;
    prepared.push({ co, a });
  }
  if (!prepared.length) return null;
  let big = prepared[0];
  for (let i = 1; i < prepared.length; i++) if (Math.abs(prepared[i].a) > Math.abs(big.a)) big = prepared[i];
  if (Math.abs(big.a) < minArea) return null;
  const outerSign = big.a > 0 ? 1 : -1;

  const parts = [];
  const holes = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const sign = p.a > 0 ? 1 : -1;
    if (sign === outerSign) {
      if (Math.abs(p.a) < minArea) continue;
      const co = p.a > 0 ? p.co : reverseRing(p.co);       // force CCW
      parts.push({ co, area: Math.abs(p.a), bbox: planBBox(co), holes: [] });
    } else {
      if (Math.abs(p.a) < minHoleArea) continue;
      holes.push(p);
    }
  }
  if (!parts.length) return null;

  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const hx = h.co[0], hy = h.co[1];
    let host = null;
    for (let k = 0; k < parts.length; k++) {
      const b = parts[k].bbox;
      if (hx < b[0] || hx > b[2] || hy < b[1] || hy > b[3]) continue;
      if (planContains(parts[k].co, hx, hy)) { host = parts[k]; break; }
    }
    if (!host && parts.length === 1) host = parts[0];
    if (host) host.holes.push(h.a < 0 ? h.co : reverseRing(h.co));   // force CW
  }

  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(makePart(parts[i].co, parts[i].holes));
  return out;
}

// Closest point on a plan ring to (px,pv); returns squared distance and the point.
const _cp = { d2: 0, x: 0, y: 0 };
export function closestOnRing(co, px, pv) {
  let bd = Infinity, bx = px, by = pv;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const ax = co[j], ay = co[j + 1], cx = co[i], cy = co[i + 1];
    const dx = cx - ax, dy = cy - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > EPS) t = clamp(((px - ax) * dx + (pv - ay) * dy) / l2, 0, 1);
    const qx = ax + dx * t, qy = ay + dy * t;
    const ex = px - qx, ey = pv - qy;
    const d2 = ex * ex + ey * ey;
    if (d2 < bd) { bd = d2; bx = qx; by = qy; }
  }
  _cp.d2 = bd; _cp.x = bx; _cp.y = by;
  return _cp;
}

export function partContains(part, px, pv) {
  const b = part.bbox;
  if (px < b[0] || px > b[2] || pv < b[1] || pv > b[3]) return false;
  if (!planContains(part.outer, px, pv)) return false;
  for (let i = 0; i < part.holes.length; i++) if (planContains(part.holes[i], px, pv)) return false;
  return true;
}
