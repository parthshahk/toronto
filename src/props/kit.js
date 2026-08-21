// src/props/kit.js — the shared drawing kit every prop builder in props/ is written against.
//
// CONTRACT.md §6.1 / Amendment 11.1. Zero dependencies. World axes: X = east, Y = up, Z = south,
// true metres. THE CONVENTIONS BELOW GOVERN EVERY FILE IN props/; the domain modules state only
// what is particular to them and point back here.
//
// Every prop builder APPENDS into a MeshBuilder the caller owns; nothing in props/ creates a Mesh,
// so the whole city still merges down to a handful of draw calls. Nothing allocates per call
// either — all working storage is the module-scope scratch below — because these run in the tens
// of thousands.
//
// Orientation convention
// ----------------------
// `yaw` rotates the piece about +Y exactly the way MeshBuilder.box() does:
//     local +X  ->  world ( cos yaw, 0, -sin yaw)
//     local +Z  ->  world ( sin yaw, 0,  cos yaw)
// so a caller that wants a piece to point along a unit direction (dx, dz) uses
//     yaw = Math.atan2(-dz, dx)
// and a plan-space (u = x, v = -z) rotation by +yaw is counter-clockwise, i.e. the usual maths
// convention with north up on paper.
//
// LOCAL +X IS ALWAYS "OUT" OR "FRONT". A lamp's arm reaches along +X, a signal's mast arm reaches
// along +X, a bench/bin/mailbox faces +X. Long objects (bench, shelter, platform) run their length
// along local Z, centred on the origin. `(x, y, z)` is the piece's footprint centre at GROUND
// level — y is the top of the pavement, not the object's centre — so callers pass
// groundY(x, z) + kerb straight through.
//
// Vertex channels
// ---------------
// core/vertex.js's floats; MeshBuilder.color(r, g, b, emissive, tintable, rough, profile).
//   * `profile` is 0 (envelope) on absolutely everything in props/. Street furniture has no window
//     grid and the shader must never paint one onto a litter bin.
//   * because profile is 0, `emissive` may only ever be exactly 0 or >= 0.50 (city.js's
//     EMITTER_MIN). Anything in between is a facade window hint and would be a bug on a prop.
//     Lamp lenses, signal lenses and backlit ad panels are the only emitters; every other
//     surface is exactly 0.
//   * `tintable` is 0 everywhere. The uTint path is for dynamic meshes.
//   * colours are linear-ish scene albedo in the same low-key range city.js uses for ground cover,
//     so props sit in the image instead of punching out of it.
//
// Silhouette first. These are read as dark shapes against a lit ground, so the outline gets the
// vertices and the surface detail does not.
//
// Winding: counter-clockwise seen from outside. The renderer culls back faces. Every triangle in
// props/ goes through MeshBuilder.tri() or MeshBuilder.cylinder()/sphere(), so normals are derived
// from the winding and are always unit length; there is no hand-written normal to get wrong.
//
// SCRATCH IS WRITE-THEN-READ WITHIN ONE CALL. The typed arrays below are shared by every builder
// in props/, exactly as they were when all of them lived in one file. No builder may leave state
// in them across calls: tiles build independently and in any order (Amendment 11.2).

import { TAU } from '../core/math.js';
import { hashCell } from '../core/util.js';

export const EPS = 1e-9;

export const MAX_STA = 8;

const MAX_SIDES = 10;

const _C = new Float64Array(24);              // 8 world hull corners

const _L = new Float64Array(24);              // 8 local hull corners

const _RING = new Float64Array(MAX_STA * MAX_SIDES * 3);

const _STA = new Float64Array(MAX_STA * 3);

const _BR = new Float64Array(MAX_SIDES * 3);

// Hull corner index: bit0 = X (0 -> low, 1 -> high), bit1 = Y, bit2 = Z.
// Face vertex order lifted straight out of MeshBuilder.box() so the winding matches exactly.
const _FI = new Int32Array([
  5, 1, 3, 7,   // +X
  0, 4, 6, 2,   // -X
  6, 7, 3, 2,   // +Y
  0, 1, 5, 4,   // -Y
  4, 5, 7, 6,   // +Z
  1, 0, 2, 3,   // -Z
]);

// Face bitmask.
export const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;

export const F_ALL = 63;

export const F_SIDES = F_PX | F_NX | F_PZ | F_NZ;   // 51 — open top and bottom

export const F_NOBOT = F_ALL & ~F_NY;               // 55 — everything but the underside

export const F_PLATEX = F_PX | F_NX;                // 3  — a thin plate whose faces point along X

export const F_PLATEZ = F_PZ | F_NZ;                // 48 — a thin plate whose faces point along Z

export const F_BLADEX = F_PX | F_NX | F_PY | F_NY;  // 15 — plate plus its top and bottom edges

export const F_BLADEZ = F_PZ | F_NZ | F_PY | F_NY;  // 60

export function fin(v, d) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : d;
}

// fin() for an angle, plus a wrap into [-PI, PI]. In practice a yaw only ever arrives from
// Math.atan2 and the wrap is a no-op, but a caller-supplied angle above ~1e16 has lost every low
// bit to the exponent: (i / n) * TAU + yaw is then the SAME number for every i, which collapses
// each ring in mb.cylinder()/discY() to a single point and silently deletes the geometry.
export function finAngle(v, d) {
  const a = (typeof v === 'number' && Number.isFinite(v)) ? v : d;
  if (a >= -Math.PI && a <= Math.PI) return a;
  const r = a % TAU;
  return r > Math.PI ? r - TAU : (r <= -Math.PI ? r + TAU : r);
}

// A guarded draw from the city's seeded rng. A non-function or a non-finite draw must never be
// allowed to reach a vertex — one NaN silently deletes the triangle it lands in.
export function rnd(rng) {
  const v = typeof rng === 'function' ? rng() : Math.random();
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : (v >= 1 ? 0.99999994 : v);
}

export function rr(rng, a, b) {
  return a + (b - a) * rnd(rng);
}

export function pickOf(rng, arr) {
  const i = (rnd(rng) * arr.length) | 0;
  return arr[i < arr.length ? i : arr.length - 1];
}

// Deterministic [0,1) from a world position — lets signal phase and similar per-instance choices
// vary across the city without threading an rng through a contract signature that has none.
// Street props quantise to 1/64 m; the mixer itself is core/util.js's.
export function hash2(x, z) {
  return hashCell(x, z, 64);
}

export function setMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m[6]);
}

function corner(i, lx, ly, lz, ox, oy, oz, c, s) {
  const k = i * 3;
  _C[k] = ox + lx * c + lz * s;
  _C[k + 1] = oy + ly;
  _C[k + 2] = oz - lx * s + lz * c;
}

function hullOut(mb, faces) {
  for (let f = 0; f < 6; f++) {
    if ((faces & (1 << f)) === 0) continue;
    const o = f * 4;
    const a = _FI[o] * 3, b = _FI[o + 1] * 3, c = _FI[o + 2] * 3, d = _FI[o + 3] * 3;
    mb.tri(_C[a], _C[a + 1], _C[a + 2], _C[b], _C[b + 1], _C[b + 2], _C[c], _C[c + 1], _C[c + 2]);
    mb.tri(_C[a], _C[a + 1], _C[a + 2], _C[c], _C[c + 1], _C[c + 2], _C[d], _C[d + 1], _C[d + 2]);
  }
}

// Axis-aligned local box given by its local min/max corner. 6 verts per requested face.
export function boxL(mb, ox, oy, oz, c, s, x0, y0, z0, x1, y1, z1, faces) {
  for (let i = 0; i < 8; i++) {
    corner(i, (i & 1) ? x1 : x0, (i & 2) ? y1 : y0, (i & 4) ? z1 : z0, ox, oy, oz, c, s);
  }
  hullOut(mb, faces);
}

// Vertical frustum: a bottom rectangle at y0 and a different top rectangle at y1.
export function frustL(mb, ox, oy, oz, c, s, y0, y1,
  ax0, az0, ax1, az1, bx0, bz0, bx1, bz1, faces) {
  for (let i = 0; i < 8; i++) {
    const top = (i & 2) !== 0;
    const lx = (i & 1) ? (top ? bx1 : ax1) : (top ? bx0 : ax0);
    const lz = (i & 4) ? (top ? bz1 : az1) : (top ? bz0 : az0);
    corner(i, lx, top ? y1 : y0, lz, ox, oy, oz, c, s);
  }
  hullOut(mb, faces);
}

// Free-form topological cube: the caller fills _L through setL() using the same index bits.
export function setL(i, x, y, z) {
  const k = i * 3;
  _L[k] = x; _L[k + 1] = y; _L[k + 2] = z;
}

export function hullL(mb, ox, oy, oz, c, s, faces) {
  for (let i = 0; i < 8; i++) corner(i, _L[i * 3], _L[i * 3 + 1], _L[i * 3 + 2], ox, oy, oz, c, s);
  hullOut(mb, faces);
}

// Single local quads, in the same corner orders the box faces use, so the normal comes out along
// the named axis. 6 verts each.
export function quadL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const a0 = ox + ax * c + az * s, a1 = oy + ay, a2 = oz - ax * s + az * c;
  const b0 = ox + bx * c + bz * s, b1 = oy + by, b2 = oz - bx * s + bz * c;
  const c0 = ox + cx * c + cz * s, c1 = oy + cy, c2 = oz - cx * s + cz * c;
  const d0 = ox + dx * c + dz * s, d1 = oy + dy, d2 = oz - dx * s + dz * c;
  mb.tri(a0, a1, a2, b0, b1, b2, c0, c1, c2);
  mb.tri(a0, a1, a2, c0, c1, c2, d0, d1, d2);
}

export function quadUp(mb, ox, oy, oz, c, s, x0, z0, x1, z1, y) {
  quadL(mb, ox, oy, oz, c, s, x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0);
}

export function quadDown(mb, ox, oy, oz, c, s, x0, z0, x1, z1, y) {
  quadL(mb, ox, oy, oz, c, s, x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
}

export function quadPX(mb, ox, oy, oz, c, s, x, y0, z0, y1, z1) {
  quadL(mb, ox, oy, oz, c, s, x, y0, z1, x, y0, z0, x, y1, z0, x, y1, z1);
}

export function quadNX(mb, ox, oy, oz, c, s, x, y0, z0, y1, z1) {
  quadL(mb, ox, oy, oz, c, s, x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0);
}

export function quadPZ(mb, ox, oy, oz, c, s, z, x0, y0, x1, y1) {
  quadL(mb, ox, oy, oz, c, s, x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
}

export function quadNZ(mb, ox, oy, oz, c, s, z, x0, y0, x1, y1) {
  quadL(mb, ox, oy, oz, c, s, x1, y0, z, x0, y0, z, x0, y1, z, x1, y1, z);
}

// One triangle given in the piece's local frame. The yaw transform is a proper rotation, so a
// counter-clockwise local winding stays counter-clockwise in world space. 3 verts.
export function triL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, cx, cy, cz) {
  mb.tri(
    ox + ax * c + az * s, oy + ay, oz - ax * s + az * c,
    ox + bx * c + bz * s, oy + by, oz - bx * s + bz * c,
    ox + cx * c + cz * s, oy + cy, oz - cx * s + cz * c);
}

// Flat disc standing in the piece's local Y-Z plane at local x, centred on (ly, lz). `out` = true
// faces local +X. This is the cheap readable wheel/disc: mb.cylinder() only spins about Y.
// 3 verts per segment.
export function discX(mb, ox, oy, oz, c, s, lx, ly, lz, r, seg, out) {
  const n = Math.max(3, Math.min(seg | 0, MAX_SIDES));
  const rad = Math.max(1e-4, r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 1) / n) * TAU;
    const y0 = ly + rad * Math.cos(a0), z0 = lz + rad * Math.sin(a0);
    const y1 = ly + rad * Math.cos(a1), z1 = lz + rad * Math.sin(a1);
    if (out) triL(mb, ox, oy, oz, c, s, lx, ly, lz, lx, y0, z0, lx, y1, z1);
    else triL(mb, ox, oy, oz, c, s, lx, ly, lz, lx, y1, z1, lx, y0, z0);
  }
}

// The same disc standing in the piece's local X-Y plane at local z, centred on (lx, ly), drawn
// twice with opposite winding at EXACTLY the same z. That is the bicycle wheel: a car's wheels are
// only ever seen from the outboard side and get one facing each, but a bike is walked around, so a
// single-sided disc would vanish from the far kerb.
//
// The two faces are coincident on purpose. Separating them by even a few millimetres opens a rim
// gap, and a bicycle seen head-on then shows the BACK of its far wheel face through that slot.
// Coincident is safe here because the renderer culls back faces in every pass that draws this
// geometry, the shadow cascades included, so exactly one of the pair ever rasterises and there is
// nothing to z-fight. 6 verts per segment.
export function discZ(mb, ox, oy, oz, c, s, lz, lx, ly, r, seg) {
  const n = Math.max(3, Math.min(seg | 0, MAX_SIDES));
  const rad = Math.max(1e-4, r);
  // Phase so that the first vertex lands at the BOTTOM of the circle. A six-sided wheel built
  // from angle zero rests on an edge instead of a vertex and the whole bicycle floats 13% of a
  // wheel radius — 4.5 cm — above the road. discX() gets this for free by driving its vertical
  // axis with the cosine; this one has to ask.
  const ph = -TAU * 0.25;
  for (let i = 0; i < n; i++) {
    const a0 = ph + (i / n) * TAU;
    const a1 = ph + ((i + 1) / n) * TAU;
    const x0 = lx + rad * Math.cos(a0), y0 = ly + rad * Math.sin(a0);
    const x1 = lx + rad * Math.cos(a1), y1 = ly + rad * Math.sin(a1);
    triL(mb, ox, oy, oz, c, s, lx, ly, lz, x0, y0, lz, x1, y1, lz);
    triL(mb, ox, oy, oz, c, s, lx, ly, lz, x1, y1, lz, x0, y0, lz);
  }
}

// Hue (in turns) -> a saturated sign-face colour, written into module scratch. Used only by
// appendTowerSign so a caller can ask for a specific brand hue without threading a colour array
// through the contract signature.
export const _RGB = new Float64Array(3);

export function hueRGB(h) {
  const t = h - Math.floor(h);
  const k = (t >= 0 && t < 1 ? t : 0) * 6;
  const i = Math.floor(k) % 6;
  const f = k - Math.floor(k);
  const S = 0.70;
  const p = 1 - S, q = 1 - S * f, u = 1 - S * (1 - f);
  if (i === 0) { _RGB[0] = 1; _RGB[1] = u; _RGB[2] = p; }
  else if (i === 1) { _RGB[0] = q; _RGB[1] = 1; _RGB[2] = p; }
  else if (i === 2) { _RGB[0] = p; _RGB[1] = 1; _RGB[2] = u; }
  else if (i === 3) { _RGB[0] = p; _RGB[1] = q; _RGB[2] = 1; }
  else if (i === 4) { _RGB[0] = u; _RGB[1] = p; _RGB[2] = 1; }
  else { _RGB[0] = 1; _RGB[1] = p; _RGB[2] = q; }
}

// Oriented rectangular member between two WORLD points. The width axis is horizontal and
// perpendicular to the member, the thickness axis completes a right-handed frame, so the same
// face table applies with +X = +width, +Y = +thickness, +Z = the B end cap, -Z = the A end cap.
export function beam(mb, ax, ay, az, bx, by, bz, hw, ht, faces) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-5)) return;
  dx /= len; dy /= len; dz /= len;

  let rx = -dz, rz = dx;
  let rl = Math.sqrt(rx * rx + rz * rz);
  if (rl > 1e-5) { rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
  // u = cross(d, r) with r.y = 0; unit because d and r are unit and orthogonal.
  const ux = dy * rz;
  const uy = dz * rx - dx * rz;
  const uz = -dy * rx;

  for (let i = 0; i < 8; i++) {
    const sr = (i & 1) ? hw : -hw;
    const su = (i & 2) ? ht : -ht;
    const px = (i & 4) ? bx : ax;
    const py = (i & 4) ? by : ay;
    const pz = (i & 4) ? bz : az;
    const k = i * 3;
    _C[k] = px + rx * sr + ux * su;
    _C[k + 1] = py + uy * su;
    _C[k + 2] = pz + rz * sr + uz * su;
  }
  hullOut(mb, faces);
}

// Same, but the endpoints are given in the piece's local frame.
export function beamL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, hw, ht, faces) {
  beam(mb,
    ox + ax * c + az * s, oy + ay, oz - ax * s + az * c,
    ox + bx * c + bz * s, oy + by, oz - bx * s + bz * c,
    hw, ht, faces);
}

// Flat disc, `seg` triangles. up = true faces +Y, false faces -Y. 3 verts per segment.
export function discY(mb, cx, cy, cz, r, seg, yaw, up) {
  const n = Math.max(3, seg | 0);
  const rad = Math.max(1e-4, r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU - yaw;
    const a1 = ((i + 1) / n) * TAU - yaw;
    const x0 = cx + rad * Math.cos(a0), z0 = cz + rad * Math.sin(a0);
    const x1 = cx + rad * Math.cos(a1), z1 = cz + rad * Math.sin(a1);
    if (up) mb.tri(cx, cy, cz, x1, cy, z1, x0, cy, z0);
    else mb.tri(cx, cy, cz, x0, cy, z0, x1, cy, z1);
  }
}

// Sweep a `sides`-gon tube through stations laid out in the local XY plane (X out, Y up); the
// cross-section spans local Z. Stations share their rings, so the cost is sides*6 per SEGMENT
// rather than per station — this is what makes a smoothly curved lamp arm affordable.
// `sta` is [x, y, radius] per station.
export function sweepL(mb, ox, oy, oz, c, s, sta, n, sides, capA, capB) {
  const ns = Math.max(2, Math.min(n | 0, MAX_STA));
  const sd = Math.max(3, Math.min(sides | 0, MAX_SIDES));

  for (let i = 0; i < ns; i++) {
    const i0 = i > 0 ? i - 1 : 0;
    const i1 = i < ns - 1 ? i + 1 : ns - 1;
    let tx = sta[i1 * 3] - sta[i0 * 3];
    let ty = sta[i1 * 3 + 1] - sta[i0 * 3 + 1];
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > EPS) { tx /= tl; ty /= tl; } else { tx = 1; ty = 0; }
    const px = sta[i * 3], py = sta[i * 3 + 1];
    const rad = Math.max(1e-4, sta[i * 3 + 2]);
    // Frame (a, b, d) with a = local +Z, b = cross(d, a) = (ty, -tx, 0); cross(a, b) = d, so the
    // ring order below comes out wound counter-clockwise seen from outside.
    for (let k = 0; k < sd; k++) {
      const th = (k / sd) * TAU;
      const cw = Math.cos(th), sw = Math.sin(th);
      const lx = px + rad * sw * ty;
      const ly = py - rad * sw * tx;
      const lz = rad * cw;
      const o = (i * sd + k) * 3;
      _RING[o] = ox + lx * c + lz * s;
      _RING[o + 1] = oy + ly;
      _RING[o + 2] = oz - lx * s + lz * c;
    }
  }

  for (let i = 0; i < ns - 1; i++) {
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = (i * sd + k) * 3;
      const b = (i * sd + k1) * 3;
      const cI = ((i + 1) * sd + k1) * 3;
      const d = ((i + 1) * sd + k) * 3;
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2]);
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2],
        _RING[d], _RING[d + 1], _RING[d + 2]);
    }
  }

  if (capB) {
    const i = ns - 1;
    const px = sta[i * 3], py = sta[i * 3 + 1];
    const wx = ox + px * c, wy = oy + py, wz = oz - px * s;
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = (i * sd + k) * 3, b = (i * sd + k1) * 3;
      mb.tri(wx, wy, wz, _RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2]);
    }
  }
  if (capA) {
    const px = sta[0], py = sta[1];
    const wx = ox + px * c, wy = oy + py, wz = oz - px * s;
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = k * 3, b = k1 * 3;
      mb.tri(wx, wy, wz, _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[a], _RING[a + 1], _RING[a + 2]);
    }
  }
}

// Torus lying in the XZ plane. segMajor * segMinor * 6 verts.
export function torusY(mb, cx, cy, cz, bigR, smallR, segMajor, segMinor, yaw) {
  const nm = Math.max(3, Math.min(segMajor | 0, MAX_STA));
  const nn = Math.max(3, Math.min(segMinor | 0, MAX_SIDES));
  const R = Math.max(1e-3, bigR);
  const r = Math.max(1e-4, smallR);
  for (let i = 0; i < nm; i++) {
    const ph = (i / nm) * TAU - yaw;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    // a = outward radial, b = +Y, cross(a, b) = the major tangent, so the ring order matches.
    for (let k = 0; k < nn; k++) {
      const th = (k / nn) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const o = (i * nn + k) * 3;
      _RING[o] = cx + (R + r * ct) * cp;
      _RING[o + 1] = cy + r * st;
      _RING[o + 2] = cz + (R + r * ct) * sp;
    }
  }
  for (let i = 0; i < nm; i++) {
    const i1 = (i + 1) % nm;
    for (let k = 0; k < nn; k++) {
      const k1 = (k + 1) % nn;
      const a = (i * nn + k) * 3;
      const b = (i * nn + k1) * 3;
      const cI = (i1 * nn + k1) * 3;
      const d = (i1 * nn + k) * 3;
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2]);
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2],
        _RING[d], _RING[d + 1], _RING[d + 2]);
    }
  }
}

// One low-poly foliage clump: an irregular bipyramid. Overlapping several of these reads as a
// canopy far better than one sphere does, and at sides*6 verts it is affordable in the thousands.
export function blob(mb, rng, cx, cy, cz, rx, ry, rz, sides) {
  const n = Math.max(4, Math.min(sides | 0, MAX_SIDES));
  const phase = rnd(rng) * TAU;
  const ax = Math.max(0.05, rx), ay = Math.max(0.05, ry), az = Math.max(0.05, rz);
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const j = 0.74 + 0.44 * rnd(rng);
    const k = i * 3;
    _BR[k] = cx + ax * j * Math.cos(a);
    _BR[k + 1] = cy + (rnd(rng) - 0.5) * ay * 0.28;
    _BR[k + 2] = cz + az * j * Math.sin(a);
  }
  const ty = cy + ay * (0.86 + 0.30 * rnd(rng));
  const by = cy - ay * (0.64 + 0.28 * rnd(rng));
  const tx = cx + (rnd(rng) - 0.5) * ax * 0.34;
  const tz = cz + (rnd(rng) - 0.5) * az * 0.34;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const m = ((i + 1) % n) * 3;
    mb.tri(tx, ty, tz, _BR[m], _BR[m + 1], _BR[m + 2], _BR[k], _BR[k + 1], _BR[k + 2]);
    mb.tri(cx, by, cz, _BR[k], _BR[k + 1], _BR[k + 2], _BR[m], _BR[m + 1], _BR[m + 2]);
  }
}

// A ring of `seg` beams in the local X-Y plane (i.e. standing upright, facing along local Z),
// centred on (cx, cy) at local depth cz. 24 verts per segment.
export function ringXY(mb, ox, oy, oz, c, s, cx, cy, cz, R, r, seg) {
  const n = Math.max(4, seg | 0);
  const rad = Math.max(1e-3, R);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
    beamL(mb, ox, oy, oz, c, s,
      cx + rad * Math.cos(a0), cy + rad * Math.sin(a0), cz,
      cx + rad * Math.cos(a1), cy + rad * Math.sin(a1), cz, r, r, F_ALL);
  }
}
