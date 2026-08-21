// src/facades.js — building ground-floor and articulation geometry (CONTRACT.md §6.2).
//
// Every building in this city currently meets the pavement as a bare extruded wall. This module
// is what puts a door, a shopfront, a canopy and a balcony on it. Zero dependencies; pure
// geometry builders that APPEND into an existing MeshBuilder so the whole city stays a handful
// of draw calls. Nothing here creates a Mesh and nothing here reads data/toronto.json — city.js
// decides WHERE these go, this file decides WHAT they look like.
//
// World axes: X = east, Y = up, Z = south. Right-handed, true metres.
//
// Yaw and the facade frame
// ------------------------
// `yaw` FACES OUT of the facade. The outward normal is (cos yaw, 0, -sin yaw):
//
//     yaw = 0     -> +X   east          yaw = PI    -> -X   west
//     yaw = PI/2  -> -Z   north         yaw = 3PI/2 -> +Z   south
//
// That is the same right-handed rotation about +Y that MeshBuilder.box(), .cylinder() and
// .append() already use, and it agrees with city.js's plan space (u, v) = (x, -z): in plan, yaw
// is measured counter-clockwise from east. For a footprint edge from A to B wound plan-CCW
// (which is how city.js orients every outer ring), the outward yaw is
// Math.atan2(-(B.z - A.z), B.x - A.x) + PI/2 ... but the direct form is simpler: the outward
// normal of that edge is (-(B.z - A.z), 0, -(B.x - A.x)) normalised, so
// yaw = Math.atan2(B.x - A.x, -(B.z - A.z)) — pass it straight in.
//
// Local coordinates used by every builder in this file are (u, v, d):
//
//     u   along the wall, positive to the RIGHT of someone standing outside looking at it
//     v   up from (x, y, z)
//     d   out of the wall, towards the street
//
// The (u, v, d) basis is right-handed (u x v = d), so a quad wound counter-clockwise in the
// (u, v) plane faces +d — outward — which is exactly what the renderer's back-face culling
// wants. Every face emitted here goes through slab()/rect()/quad(), all of which take their
// winding from that rule, so "is this facing into the building?" is answered once, here, and
// verified by the harness at all four cardinal yaws.
//
// THE WALL AT d = 0 IS SOLID AND CANNOT BE CUT
// --------------------------------------------
// city.js extrudes footprints as closed rings; there is no hole in the wall to recess a door
// into, and any geometry emitted at d < 0 is simply inside the building and invisible. So every
// "recess" here is built OUT, not cut IN: the surround, jambs and soffit project towards the
// street and the door sits back at the wall plane inside them. Seen from the sidewalk that reads
// as a genuine reveal, which is the whole point — a door drawn flat on the wall reads as a decal.
//
// For the same reason the shopfront's "dark interior behind the glass" is expressed two ways:
// the glazing carries a warm dark albedo with a low roughness and a real emissive (an opaque
// renderer cannot see through a pane, so the pane itself has to be the lit interior), and the
// recessed entry — which IS an open cavity — gets a genuine interior plane at the back of it,
// behind the door leaves, showing through the transom.
//
// Materials (CONTRACT.md §2, and city.js's palette)
// -------------------------------------------------
// Vertex format is gl.js's 13 floats; MeshBuilder.color(r, g, b, emissive, tintable, rough,
// profile). Colours here are scene albedo in the same dark blue-hour band city.js emits, never
// display colours. Builders take an optional `mat` — the HOST WALL's material as
// [r, g, b, emissive, tintable, rough, profile] — and derive bulkheads, pilasters, cornices and
// slab edges from it, so a shopfront on a brick building still reads brick. Omit `mat` and the
// host is read from the MeshBuilder's current colour state instead, which means
// `setMat(mb, facade.mat); appendCornice(mb, ...)` does the right thing with no extra plumbing.
//
// Two invariants are enforced on every vertex this module emits, both inherited from city.js:
//   * `tintable` is always 0. The uTint path is for dynamic meshes; tinted city geometry is a bug.
//   * `profile` is always 0 (envelope) and emissive is therefore either exactly 0 or >= 0.50.
//     Profile 0 means "no procedural window grid on this surface", which is correct for explicit
//     geometry: a mullion, a bulkhead or a balcony slab must never have an office window painted
//     over it, and city.js guarantees no profile-0 surface carries a sub-0.1 facade-light hint.
//     Lit signage, valance strips and shop interiors sit at 0.50-0.95 and read as real emitters.
//
// Cost
// ----
// These are applied to thousands of buildings, so every face is counted. Measured vertex costs
// (harness numbers, typical arguments) are in the doc comment of each export; the composite
// appendGroundFloor() lands a full retail treatment near 300 and an office one near 320, inside
// the ~400 budget. Each export returns the number of vertices it appended.
//
// LEVEL OF DETAIL — what the tiling system calls at mid distance
// --------------------------------------------------------------
// The city is streamed as tiles that build in stages, and a frontage a kilometre away cannot
// afford the geometry a frontage across the street deserves. So every builder here takes a
// LEVEL, through the `lod` field of the `opts` object each of them already accepts:
//
//   export const FACADE_LOD = { FULL: 0, COARSE: 1 };            // FULL is the default
//   export const FACADE_LOD_FEATURE = 0.62;                      // metres; see below
//   export function facadeLodFor(dist, mPerPx) -> FACADE_LOD.*   // range -> level
//
// FULL is untouched: every FULL path in this file is the original code and emits the original
// vertices, so nothing the player can walk up to has changed by a triangle.
//
// COARSE keeps the SILHOUETTE, the MATERIALS and the RANDOM CHOICES and throws away the internal
// articulation — mullions, door leaves, the revolving drum, balustrades, tie rods, railings,
// dentil courses, bumpers. What is dropped is either thinner than FACADE_LOD_FEATURE or projects
// less than it, which is one pixel at 484 m in the framing this project is judged at, so the
// difference is not detail the eye is losing, it is high-frequency noise the window LOD in
// render.js would otherwise have to filter out. Measured, per frontage:
//
//   appendGroundFloor  retail 330 -> 48  office 294 -> 42  condo 210 -> 42  service 108 -> 12
//   appendShopfront    318 -> 36     appendEntrance  108-222 -> 12    appendCanopy    72 -> 30
//   appendBalconyBand   54 -> 30     appendCornice        84 -> 30    appendAwning    30 -> 12
//   appendFireEscape   324 -> 72     appendLoadingDock   150 -> 36    appendParapet   30 -> 18
//   appendStringCourse  18 -> 6
//
// (Frontages 8-18 m, four floors of fire escape, ends on. Every one of these is a harness number
// from tools, not an estimate, and the harness also asserts the two invariants below.)
//
// TWO INVARIANTS make the level safe to choose per tile and to change while the player moves:
//
//   1. Both levels draw the SAME number of values off `rng`, in the same order. city.js shares
//      one seeded stream across everything it places in a tile, so a level that drew one value
//      fewer would move every lamp, tree and parked car built after it. Where a COARSE path skips
//      a helper that would have consumed a draw, it consumes one itself and says so.
//   2. Both levels make the same DECISIONS from those values — the same sign, lit the same way,
//      the same entry bay, the same fire-escape side. A tile that swaps level does not swap
//      content; it swaps how finely the same content is modelled.
//
// Neither level knows anything about tiles, ranges or cameras. The caller passes `lod`; this
// file just builds what it was asked for.

import { clamp, lerp } from './math.js';

/* =============================================================== tunables == */

const TAU = Math.PI * 2;
const MIN_EXT = 1e-4;          // an extent below this is zero: skip the face rather than emit slivers

/**
 * How far every wall-parallel detail face stands PROUD of the extrusion it is hung on.
 *
 * This used to be 6 mm, which is a coplanar face as far as a 24-bit integer depth buffer is
 * concerned: at 400 m the smallest resolvable depth step is already larger than that, so a
 * shopfront bulkhead, a string course or a fire-escape landing flickered against the wall behind
 * it for the whole middle distance. 35 mm is the smallest offset that survives the depth
 * resolution out to roughly a kilometre and is still invisible at arm's length — a real
 * shopfront bulkhead projects five times this.
 *
 * Nothing in this module may emit a wall-parallel face at 0 <= d < SKIN. rect() clamps for you
 * and slab() audits its own outward face; facadeAudit() reports the measured minimum so the
 * harness can prove the invariant instead of trusting it.
 */
const SKIN = 0.035;

// Face bits for slab(). OUT is the street-facing face, IN the wall-facing one.
const F_OUT = 1;
const F_IN = 2;
const F_TOP = 4;
const F_BOT = 8;
const F_LEFT = 16;
const F_RIGHT = 32;
const F_ALL = 63;
const F_ENDS = F_LEFT | F_RIGHT;
const F_BAND = F_OUT | F_TOP | F_BOT;          // a band that dies into the wall at both ends
const F_SHELL = F_ALL & ~F_IN;                 // everything except the hidden wall-side face

// Standard sizes. Real Toronto retail runs a 0.4-0.5 m stall riser, a fascia around 0.6-0.9 m,
// and bays of 2.6-3.4 m between pilasters.
const BULKHEAD_H = 0.44;
const MULLION_W = 0.15;
const MULLION_D = 0.13;
const BAY_TARGET = 3.05;
const RECESS_D = 0.72;         // how far a shopfront entry surround projects, i.e. the reveal depth
const DOOR_H = 2.16;
const LEAF_W = 0.92;

/* ============================================================== materials == */

// [r, g, b, emissive, tintable, rough, profile]. Albedo is linear-ish scene albedo in city.js's
// blue-hour band — a facade there sits near 0.05, so anything above ~0.3 here is an EMITTER and
// is sized accordingly: big surfaces stay dark and glow gently, small strips are bright.

// Shopfront and lobby glazing. Warm-dark rather than cool, because what you are looking at is a
// lit room seen through glass, not a mirror; the low roughness still gives it the sky and the
// street lamps on top. Emissive 0.55 replaces the procedural retail band it covers up.
const MAT_GLASS_LIT = [0.088, 0.076, 0.062, 0.55, 0, 0.09, 0];
// Unlit glazing: sidelights, transoms, upper-floor infill. Cool, dark, mirror-smooth.
const MAT_GLASS = [0.050, 0.055, 0.064, 0, 0, 0.07, 0];
// The back of a recess: a genuine interior plane, seen through the doors and over them.
const MAT_INTERIOR = [0.300, 0.222, 0.140, 0.66, 0, 0.62, 0];
// Concealed strip light under a shopfront head, and the underside of an entrance canopy.
const MAT_VALANCE = [0.620, 0.470, 0.300, 0.92, 0, 0.65, 0];
// Internally lit fascia sign — the one place at street level with real chroma.
const MAT_SIGN_LIT = [0.255, 0.215, 0.172, 0.60, 0, 0.50, 0];
// Anodised dark frame: mullions, door leaves, shutter guides.
const MAT_METAL_DARK = [0.034, 0.035, 0.038, 0, 0, 0.18, 0];
// Stainless / mill-finish aluminium: pull bars, cap rails, revolving-door frames.
const MAT_METAL_PALE = [0.112, 0.116, 0.122, 0, 0, 0.16, 0];
// Painted structural steel, weathered: fire escapes, dock canopies.
const MAT_STEEL = [0.040, 0.037, 0.034, 0, 0, 0.45, 0];
// Galvanised grating and rolling shutters.
const MAT_SHUTTER = [0.062, 0.063, 0.066, 0, 0, 0.34, 0];
// Dock bumpers and door sweeps.
const MAT_RUBBER = [0.017, 0.017, 0.019, 0, 0, 0.90, 0];

// Awning canvas. Muted on purpose — the art direction is desaturated apart from lamps and
// interior light, and a row of primary-coloured awnings would be the loudest thing on the street.
const AWNING_COLS = [
  [0.055, 0.030, 0.026],       // burgundy
  [0.026, 0.041, 0.030],       // dark green
  [0.026, 0.030, 0.048],       // navy
  [0.031, 0.031, 0.032],       // charcoal
  [0.058, 0.047, 0.031],       // ochre canvas
  [0.048, 0.048, 0.046],       // bone
];

const HOST_FALLBACK = [0.052, 0.053, 0.056, 0, 0, 0.88, 0];

/* ================================================================== audit == */

// Coplanar-geometry audit. Every wall-parallel face this module emits at a non-negative depth is
// measured here, so "detail stands proud of the wall" is a number the harness reads back rather
// than a convention the author remembers. Faces at d < 0 are deliberately buried inside the
// extrusion (a threshold step, a parapet's inboard leaf) and are not candidates for a fight.
const _fa = { faces: 0, minProud: Infinity, clamped: 0 };

function noteProud(d) {
  if (!(d >= 0)) return;
  _fa.faces++;
  if (d < _fa.minProud) _fa.minProud = d;
}

/**
 * Read the wall-parallel face audit. `minProud` is the smallest offset from the wall plane any
 * detail face was emitted at, in metres; it must never fall below SKIN.
 * @returns {{faces:number, minProud:number, clamped:number, skin:number}}
 */
export function facadeAudit() {
  return {
    faces: _fa.faces,
    minProud: _fa.faces ? _fa.minProud : 0,
    clamped: _fa.clamped,
    skin: SKIN,
  };
}

/** Zero the audit. city.js calls this once per load so counts are per-city, not per-process. */
export function resetFacadeAudit() {
  _fa.faces = 0;
  _fa.minProud = Infinity;
  _fa.clamped = 0;
}

/* ================================================================ helpers == */

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// A deterministic stand-in when a caller passes no rng. Never Math.random: city generation must
// be reproducible, and a facade that changes between loads is a bug you cannot chase.
function fallbackRng(x, z, salt) {
  let s = ((Math.round(x * 16) * 73856093) ^ (Math.round(z * 16) * 19349663) ^ ((salt | 0) * 83492791)) >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngOf(rng, x, z, salt) {
  return typeof rng === 'function' ? rng : fallbackRng(x, z, salt);
}

/* ================================================================== LOD == */

/**
 * Detail level for every builder in this file, selected per call through opts.lod.
 *
 *   FULL    everything the builder knows how to draw. The default, and bit-for-bit what this
 *           module emitted before LOD existed — every FULL path below is the original code.
 *   COARSE  the same SILHOUETTE, the same MATERIALS and the same random choices, with the
 *           internal articulation collapsed: no mullions, no door leaves, no revolving drum, no
 *           balustrades, no tie rods, no railings. Measured 1.7x cheaper on a parapet that was
 *           already a single slab, 8.8x on a shopfront, 18.5x on a revolving-door lobby.
 *
 * @readonly
 */
export const FACADE_LOD = Object.freeze({ FULL: 0, COARSE: 1 });

/**
 * The smallest feature FULL keeps and COARSE drops, in metres. Everything COARSE removes is
 * either thinner than this (a 0.15 m mullion, a 0.07 m grating, a 0.055 m cap rail) or projects
 * less than it (a 0.62 m entrance reveal, a 0.42 m lobby surround). One pixel wide is where the
 * difference stops being visible and starts being noise the LOD in render.js has to filter out.
 */
export const FACADE_LOD_FEATURE = 0.62;

// Angular size of one pixel at the reference framing this project is judged at: 1440 x 900,
// vertical fov 1.05 rad. 2 * tan(fov/2) / heightPx metres per pixel per metre of range.
const REF_M_PER_PX = 1.2814e-3;

/**
 * Which level a frontage at this range should be built at.
 *
 * Pass `mPerPx` — metres per pixel PER METRE of range, i.e. 2 * tan(fov/2) / viewportHeight — to
 * make the switch follow the camera the player actually has; omit it and the reference framing
 * above is assumed, which puts the switch at 484 m.
 *
 * The caller decides WHERE the boundary sits in its own streaming scheme; this function only
 * says where the geometry stops being worth its vertices. A tiling system whose detail stage
 * already ends closer than this can ignore it and always ask for COARSE in its mid stage.
 *
 * @param {number} dist metres from the camera to the frontage
 * @param {number} [mPerPx] metres per pixel per metre of range
 * @returns {number} FACADE_LOD.FULL or FACADE_LOD.COARSE
 */
export function facadeLodFor(dist, mPerPx) {
  const d = isNum(dist) ? dist : 0;
  const k = (isNum(mPerPx) && mPerPx > 1e-9) ? mPerPx : REF_M_PER_PX;
  return d * k > FACADE_LOD_FEATURE ? FACADE_LOD.COARSE : FACADE_LOD.FULL;
}

// opts.lod, defended. Anything that is not a recognised level is FULL: a caller who mistypes the
// option gets the good geometry, never a silently degraded city.
function lodOf(o) {
  return (o && (o.lod | 0) === FACADE_LOD.COARSE) ? FACADE_LOD.COARSE : FACADE_LOD.FULL;
}

/**
 * The local coordinate system of one patch of wall. See the header for (u, v, d).
 * @param {number} x wall point, world X
 * @param {number} y wall point, world Y — the BASE of the feature unless a builder says otherwise
 * @param {number} z wall point, world Z
 * @param {number} yaw facing OUT of the facade
 */
function frameAt(x, y, z, yaw) {
  const a = isNum(yaw) ? yaw : 0;
  return { x, y, z, yaw: a, c: Math.cos(a), s: Math.sin(a) };
}

function fx(F, u, d) { return F.x - u * F.s + d * F.c; }
function fz(F, u, d) { return F.z - u * F.c - d * F.s; }

// One quad from four local corners, wound CCW as seen from the side it should face. Positions go
// through MeshBuilder.tri(), which derives the flat normal from the winding with its own epsilon
// guard — so winding is the single source of truth and a normal can never disagree with a face.
// 6 vertices.
function quad(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3) {
  const ax = fx(F, u0, d0), ay = F.y + v0, az = fz(F, u0, d0);
  const bx = fx(F, u1, d1), by = F.y + v1, bz = fz(F, u1, d1);
  const cx = fx(F, u2, d2), cy = F.y + v2, cz = fz(F, u2, d2);
  const dx = fx(F, u3, d3), dy = F.y + v3, dz = fz(F, u3, d3);
  mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  mb.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
}

// One triangle from three local corners. 3 vertices.
function tri3(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2) {
  mb.tri(
    fx(F, u0, d0), F.y + v0, fz(F, u0, d0),
    fx(F, u1, d1), F.y + v1, fz(F, u1, d1),
    fx(F, u2, d2), F.y + v2, fz(F, u2, d2)
  );
}

// A flat outward-facing rectangle parallel to the wall at depth d. 6 vertices.
//
// This is the one primitive that can put a face exactly on the extrusion plane, so it is also the
// one that clamps: a caller asking for less than SKIN gets SKIN, and the clamp is counted. A door
// leaf drawn flush with the wall does not read as a recessed door, it reads as a flickering decal.
function rect(mb, F, u0, u1, v0, v1, d) {
  if (u1 - u0 < MIN_EXT || v1 - v0 < MIN_EXT) return;
  let dd = isNum(d) ? d : SKIN;
  if (dd < SKIN) { dd = SKIN; _fa.clamped++; }
  noteProud(dd);
  quad(mb, F, u0, v0, dd, u1, v0, dd, u1, v1, dd, u0, v1, dd);
}

// A double-sided plane: the quad and its mirror, so a 40 mm tie rod, stair flight or revolving
// vane reads from every angle without paying for a closed box. 12 vertices.
function planeBoth(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3) {
  quad(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3);
  quad(mb, F, u0, v0, d0, u3, v3, d3, u2, v2, d2, u1, v1, d1);
}

/**
 * An axis-aligned box in local facade space, min/max form, with a face mask so hidden faces cost
 * nothing. This is the workhorse: a band that dies into the wall needs 3 faces (18 verts), a free
 * -standing slab needs 5 (30), a full box is 6 (36).
 * @returns {void}
 */
function slab(mb, F, u0, u1, v0, v1, d0, d1, mask) {
  const ua = Math.min(u0, u1), ub = Math.max(u0, u1);
  const va = Math.min(v0, v1), vb = Math.max(v0, v1);
  const da = Math.min(d0, d1), db = Math.max(d0, d1);
  const su = ub - ua, sv = vb - va, sd = db - da;
  if ((mask & F_OUT) && su > MIN_EXT && sv > MIN_EXT) {
    noteProud(db);
    quad(mb, F, ua, va, db, ub, va, db, ub, vb, db, ua, vb, db);
  }
  if ((mask & F_IN) && su > MIN_EXT && sv > MIN_EXT) {
    quad(mb, F, ub, va, da, ua, va, da, ua, vb, da, ub, vb, da);
  }
  if ((mask & F_TOP) && su > MIN_EXT && sd > MIN_EXT) {
    quad(mb, F, ua, vb, db, ub, vb, db, ub, vb, da, ua, vb, da);
  }
  if ((mask & F_BOT) && su > MIN_EXT && sd > MIN_EXT) {
    quad(mb, F, ua, va, da, ub, va, da, ub, va, db, ua, va, db);
  }
  if ((mask & F_RIGHT) && sv > MIN_EXT && sd > MIN_EXT) {
    quad(mb, F, ub, va, db, ub, va, da, ub, vb, da, ub, vb, db);
  }
  if ((mask & F_LEFT) && sv > MIN_EXT && sd > MIN_EXT) {
    quad(mb, F, ua, va, da, ua, va, db, ua, vb, db, ua, vb, da);
  }
}

// One vertex straight from local coordinates, with a local-space unit normal. The frame is a
// rotation, so the normal stays unit under it — this is the only way into MeshBuilder that keeps
// SMOOTH normals, which a curved surface needs and MeshBuilder.tri()'s flat normal cannot give.
function lvert(mb, F, u, v, d, nu, nv, nd) {
  mb.vert(fx(F, u, d), F.y + v, fz(F, u, d),
    -nu * F.s + nd * F.c, nv, -nu * F.c - nd * F.s);
}

// A vertical arc of a cylinder standing on the facade, centred at local (uc, dc), swept from
// angle a0 to a1 where 0 points straight out of the wall and +90 degrees points along +u. Smooth
// radial normals. 6 * seg vertices.
function drumArc(mb, F, uc, dc, r, v0, v1, a0, a1, seg) {
  const n = Math.max(2, seg | 0);
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (a1 - a0) * (i / n);
    const t1 = a0 + (a1 - a0) * ((i + 1) / n);
    const s0 = Math.sin(t0), c0 = Math.cos(t0);
    const s1 = Math.sin(t1), c1 = Math.cos(t1);
    const u0 = uc + r * s0, d0 = dc + r * c0;
    const u1 = uc + r * s1, d1 = dc + r * c1;
    lvert(mb, F, u0, v0, d0, s0, 0, c0);
    lvert(mb, F, u1, v0, d1, s1, 0, c1);
    lvert(mb, F, u1, v1, d1, s1, 0, c1);
    lvert(mb, F, u0, v0, d0, s0, 0, c0);
    lvert(mb, F, u1, v1, d1, s1, 0, c1);
    lvert(mb, F, u0, v1, d0, s0, 0, c0);
  }
}

// The flat cap over that arc: a fan over the sector, plus one triangle closing the chord back to
// the wall so there is no notch when you look down on it. 3 * (seg + 1) vertices.
function drumCap(mb, F, uc, dc, r, v, a0, a1, seg) {
  const n = Math.max(2, seg | 0);
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (a1 - a0) * (i / n);
    const t1 = a0 + (a1 - a0) * ((i + 1) / n);
    tri3(mb, F, uc, v, dc,
      uc + r * Math.sin(t0), v, dc + r * Math.cos(t0),
      uc + r * Math.sin(t1), v, dc + r * Math.cos(t1));
  }
  tri3(mb, F, uc, v, dc,
    uc + r * Math.sin(a1), v, dc + r * Math.cos(a1),
    uc + r * Math.sin(a0), v, dc + r * Math.cos(a0));
}

/* -------------------------------------------------------------- materials -- */

function applyMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], 0, m[5], 0);
}

// Host-derived: keep the wall's colour (so brick stays brick), scale its lightness, floor its
// roughness at something masonry, and force emissive and profile to 0 — a moulding is solid.
function applyHost(mb, host, k, roughMin) {
  mb.color(host[0] * k, host[1] * k, host[2] * k, 0, 0, Math.max(host[5], roughMin), 0);
}

/**
 * The host wall material for one call: explicit `mat` wins, else the MeshBuilder's current colour
 * state, else a neutral concrete. Returns a fresh 7-array — public builders pass it down to their
 * private helpers rather than re-reading, because by then the builder's colour state is whatever
 * the last face set.
 */
function readHost(mb, mat) {
  const h = [HOST_FALLBACK[0], HOST_FALLBACK[1], HOST_FALLBACK[2], 0, 0, HOST_FALLBACK[5], 0];
  if (Array.isArray(mat) && mat.length >= 3 && isNum(mat[0]) && isNum(mat[1]) && isNum(mat[2])) {
    h[0] = clamp(mat[0], 0, 4);
    h[1] = clamp(mat[1], 0, 4);
    h[2] = clamp(mat[2], 0, 4);
    h[5] = (mat.length >= 6 && isNum(mat[5])) ? clamp(mat[5], 0.03, 1) : HOST_FALLBACK[5];
  } else if (mb && isNum(mb._r) && isNum(mb._g) && isNum(mb._b)) {
    h[0] = clamp(mb._r, 0, 4);
    h[1] = clamp(mb._g, 0, 4);
    h[2] = clamp(mb._b, 0, 4);
    h[5] = isNum(mb._rg) ? clamp(mb._rg, 0.03, 1) : HOST_FALLBACK[5];
  }
  return h;
}

function vcount(mb) {
  return mb && typeof mb.count === 'number' ? mb.count : 0;
}

/* =============================================================== entrances == */

// A door leaf: the leaf panel, its glazing standing proud of it (an opaque renderer cannot see
// glass set BEHIND a frame, so the frame is the plate and the pane sits in front of it, which
// leaves the frame reading as a 90 mm margin all round), and a pull bar. 18 verts.
function doorLeaf(mb, F, u0, u1, v0, v1, d, glassMat) {
  if (u1 - u0 < 0.24 || v1 - v0 < 0.6) return;
  applyMat(mb, MAT_METAL_DARK);
  rect(mb, F, u0, u1, v0, v1, d);
  applyMat(mb, glassMat);
  rect(mb, F, u0 + 0.09, u1 - 0.09, v0 + 0.13, v1 - 0.10, d + 0.026);
  applyMat(mb, MAT_METAL_PALE);
  rect(mb, F, u0 + 0.11, u1 - 0.11, v0 + 0.99, v0 + 1.07, d + 0.058);
}

// The surround: two jambs and a head, all projecting `proj` out of the wall so the opening they
// frame reads as a reveal rather than a decal. The jambs' inward faces and the head's underside
// ARE the reveal. The jambs run the full height so the head needs no end caps, and BOTH sides of
// each jamb are emitted — the outer one is what you see walking along the wall, and leaving it
// off puts a culled hole in the portal at exactly the angle a pedestrian approaches it from.
// 54 verts.
function surround(mb, F, host, hw, h, proj, jambW) {
  applyHost(mb, host, 1.06, 0.50);
  slab(mb, F, -hw - jambW, -hw, 0, h + 0.18, SKIN, proj, F_OUT | F_RIGHT | F_LEFT);
  slab(mb, F, hw, hw + jambW, 0, h + 0.18, SKIN, proj, F_OUT | F_LEFT | F_RIGHT);
  slab(mb, F, -hw, hw, h, h + 0.18, SKIN, proj, F_OUT | F_BOT | F_TOP);
}

// The threshold: a shallow step carrying the doorway out onto the sidewalk. Sunk 20 mm so it
// never floats over a terrain that is sampled somewhere else. 24 verts.
function threshold(mb, F, host, hw, proj) {
  applyHost(mb, host, 0.88, 0.72);
  slab(mb, F, -hw - 0.20, hw + 0.20, -0.02, 0.055, -0.05, proj + 0.22, F_OUT | F_TOP | F_ENDS);
}

// Office towers: a revolving drum with vanes, flanked by a hinged leaf each side. 219 verts.
//
// The drum is set INTO the facade: its axis stands only 0.3 of a radius off the wall, so what
// projects is the front 215 degrees of it — a 1.2 m bulge, which a 3.8 m sidewalk can carry —
// and the arc is cut exactly where the cylinder meets the wall plane, so not one triangle is
// emitted inside the building. A full drum standing clear of the wall would project 2 m onto the
// pavement AND bury a third of itself in masonry.
function entRevolving(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 1.3, 3.6);
  const h = 3.05;
  const proj = 0.62;
  surround(mb, F, host, hw, h, proj, 0.26);
  threshold(mb, F, host, hw, proj);

  // A real revolving door is 1.7-2.4 m across; the radius follows the opening inside that.
  const r = clamp(hw * 0.42, 0.80, 1.15);
  const dc = r * 0.30;
  // Where the drum crosses SKIN rather than the wall plane itself, so not one vertex of the arc
  // lands coplanar with the extrusion it is set into.
  const cut = Math.acos(clamp((SKIN - dc) / r, -1, 1));
  const vTop = 2.42;
  applyMat(mb, MAT_GLASS_LIT);
  drumArc(mb, F, 0, dc, r, -0.02, vTop, -cut, cut, 7);
  applyMat(mb, MAT_METAL_PALE);
  drumCap(mb, F, 0, dc, r + 0.05, vTop + 0.02, -cut, cut, 7);

  // Three vanes on a random phase, so a row of towers does not line up. Any vane that would
  // swing back through the wall is shortened to stop at it.
  const phase = rng() * (TAU / 3);
  applyMat(mb, MAT_GLASS);
  for (let i = 0; i < 3; i++) {
    const a = phase + (i / 3) * TAU;
    const ca = Math.cos(a);
    let len = r - 0.05;
    if (ca < -1e-3 && dc + len * ca < SKIN) len = Math.max(0, (SKIN - dc) / ca);
    if (len < 0.12) continue;
    const ue = Math.sin(a) * len;
    const de = dc + ca * len;
    planeBoth(mb, F, 0, 0.10, dc, ue, 0.10, de, ue, vTop - 0.06, de, 0, vTop - 0.06, dc);
  }

  // Flanking leaves, hard against the jambs.
  const lw = Math.min(LEAF_W, Math.max(0.5, hw - r - 0.24));
  if (lw > 0.5) {
    doorLeaf(mb, F, -hw + 0.06, -hw + 0.06 + lw, 0.05, 0.05 + DOOR_H, 0.05, MAT_GLASS_LIT);
    doorLeaf(mb, F, hw - 0.06 - lw, hw - 0.06, 0.05, 0.05 + DOOR_H, 0.05, MAT_GLASS_LIT);
  }
  // Transom over the whole opening, above the drum.
  applyMat(mb, MAT_GLASS_LIT);
  rect(mb, F, -hw + 0.04, hw - 0.04, vTop + 0.12, h - 0.06, 0.03);
}

// Residential and civic lobbies: a glazed double door with sidelights and a transom. ~144 verts.
function entDouble(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.95, 2.6);
  const h = 2.86;
  const proj = 0.42;
  surround(mb, F, host, hw, h, proj, 0.22);
  threshold(mb, F, host, hw, proj);

  const lw = Math.min(LEAF_W, hw - 0.10);
  const side = Math.max(0, hw - 0.06 - lw);
  applyMat(mb, MAT_INTERIOR);
  rect(mb, F, -hw + 0.04, hw - 0.04, 0.05, h - 0.06, 0.02);
  doorLeaf(mb, F, -lw, 0, 0.05, 0.05 + DOOR_H, 0.06, MAT_GLASS_LIT);
  doorLeaf(mb, F, 0, lw, 0.05, 0.05 + DOOR_H, 0.06, MAT_GLASS_LIT);
  if (side > 0.18) {
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, -hw + 0.06, -hw + 0.06 + side, 0.05, 0.05 + DOOR_H, 0.06);
    rect(mb, F, hw - 0.06 - side, hw - 0.06, 0.05, 0.05 + DOOR_H, 0.06);
  }
  // Transom bar and light over the pair.
  applyMat(mb, MAT_METAL_DARK);
  slab(mb, F, -hw + 0.04, hw - 0.04, 0.05 + DOOR_H, 0.16 + DOOR_H, 0.03, 0.11, F_OUT | F_BOT);
  applyMat(mb, rng() < 0.5 ? MAT_VALANCE : MAT_GLASS_LIT);
  rect(mb, F, -hw + 0.06, hw - 0.06, 0.18 + DOOR_H, h - 0.08, 0.04);
}

// Retail: a recessed single or double leaf under a projecting surround, with a genuine interior
// plane at the back of the cavity. 102 verts. Returns the top of its head, so a shopfront can
// glaze the strip between the entry and its own transom line.
function entShopfront(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.6, 2.4);
  const h = clamp(2.55 + rng() * 0.25, 2.4, 2.9);
  const proj = RECESS_D;
  surround(mb, F, host, hw, h, proj, 0.18);
  // The floor of the recess, tiled out to the sidewalk.
  applyHost(mb, host, 0.80, 0.70);
  slab(mb, F, -hw, hw, -0.02, 0.045, -0.02, proj + 0.14, F_OUT | F_TOP);
  // Interior: the plane you actually see through the doors and over them.
  applyMat(mb, MAT_INTERIOR);
  rect(mb, F, -hw + 0.02, hw - 0.02, 0.045, h - 0.04, 0.03);
  const twin = hw > 1.05;
  const lw = twin ? Math.min(LEAF_W, hw - 0.10) : Math.min(1.05, hw * 2 - 0.14);
  if (twin) {
    doorLeaf(mb, F, -lw, 0, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
    doorLeaf(mb, F, 0, lw, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  } else {
    doorLeaf(mb, F, -lw * 0.5, lw * 0.5, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  }
  // A downlight in the soffit of the recess.
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.25, hw - 0.25, h - 0.09, h - 0.05, proj * 0.35, proj * 0.75, F_BOT);
  return h + 0.18;
}

// Envelope, industrial and rear elevations: a flush steel door in a pressed frame, one step, a
// bulkhead lamp over it. ~96 verts.
function entService(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.5, 1.35);
  const h = 2.32;
  applyHost(mb, host, 0.92, 0.62);
  slab(mb, F, -hw - 0.13, -hw, 0, h + 0.13, SKIN, 0.14, F_OUT | F_RIGHT);
  slab(mb, F, hw, hw + 0.13, 0, h + 0.13, SKIN, 0.14, F_OUT | F_LEFT);
  slab(mb, F, -hw - 0.13, hw + 0.13, h, h + 0.13, SKIN, 0.14, F_OUT | F_BOT | F_TOP);
  applyHost(mb, host, 0.78, 0.72);
  slab(mb, F, -hw - 0.06, hw + 0.06, -0.02, 0.06, -0.03, 0.30, F_OUT | F_TOP | F_ENDS);
  // The leaf: painted steel, one vision panel, a kick plate.
  applyMat(mb, MAT_STEEL);
  rect(mb, F, -hw, hw, 0.05, h - 0.01, 0.045);
  applyMat(mb, MAT_GLASS);
  rect(mb, F, -hw * 0.45, hw * 0.45, h - 0.72, h - 0.20, 0.07);
  applyMat(mb, MAT_METAL_PALE);
  rect(mb, F, -hw + 0.06, hw - 0.06, 0.10, 0.34, 0.07);
  // Bulkhead lamp: a genuine emitter, on about two thirds of service doors.
  if (rng() < 0.66) {
    applyMat(mb, MAT_VALANCE);
    slab(mb, F, -0.16, 0.16, h + 0.20, h + 0.36, 0.06, 0.24, F_OUT | F_BOT | F_ENDS);
  }
}

// COARSE: the opening as two flat faces — the surround's outward plane in the host's own stone,
// and the glazing (or the steel leaf) inside it. Every style draws exactly ONE random value, the
// same as its FULL counterpart, so a caller sharing one rng stream across a tile gets the same
// stream whichever level it asked for. 12 verts against 96-219.
//
// Nothing projects. At the range COARSE is for, the 0.42-0.72 m reveal these builders model is
// under a pixel deep, and a flat panel at SKIN cannot self-shadow, cannot z-fight and cannot
// leave a back-facing hole where a one-sided slab used to be. Returns the head height, as
// entShopfront does, so appendShopfront can glaze above it. 12 verts against 108-222.
function entCoarse(mb, F, rng, host, width, style, base) {
  // Drawn first and unconditionally, exactly as every FULL style draws exactly one value. The
  // shopfront style is the one that USES it — its head height is random — so taking it here
  // keeps both the stream and the head line identical between levels.
  const rv = rng();
  const d0 = isNum(base) ? Math.max(base, SKIN) : SKIN;
  let hw, h, j, glass;
  if (style === 'revolving') {
    hw = clamp(width * 0.5, 1.3, 3.6); h = 3.05; j = 0.26; glass = MAT_GLASS_LIT;
  } else if (style === 'shopfront') {
    hw = clamp(width * 0.5, 0.6, 2.4); h = clamp(2.55 + rv * 0.25, 2.4, 2.9);
    j = 0.18; glass = MAT_INTERIOR;
  } else if (style === 'service') {
    hw = clamp(width * 0.5, 0.5, 1.35); h = 2.32; j = 0.13; glass = MAT_STEEL;
  } else {
    hw = clamp(width * 0.5, 0.95, 2.6); h = 2.86; j = 0.22; glass = MAT_GLASS_LIT;
  }
  applyHost(mb, host, 1.06, 0.50);
  rect(mb, F, -hw - j, hw + j, 0, h + 0.18, d0);
  applyMat(mb, glass);
  rect(mb, F, -hw, hw, 0.05, h - 0.05, d0 + 0.02);
  return h + 0.18;
}

/**
 * A building entrance. `yaw` faces out of the facade; (x, y, z) is the wall point at the CENTRE
 * of the opening, at sidewalk level. `width` is the clear opening — the surround projects and
 * extends ~0.2 m beyond it each side.
 *
 * style: 'revolving' office tower drum + flanking leaves (~213 verts)
 *        'double'    glazed residential/civic lobby pair (~144 verts)
 *        'shopfront' recessed retail entry with an interior plane (~132 verts)
 *        'service'   flush steel door, step and bulkhead lamp (~96 verts)
 *
 * opts: { lod } — FACADE_LOD.COARSE flattens every style to 12 verts. See the LOD block above.
 *
 * @param {MeshBuilder} mb
 * @param {function} rng seeded 0..1 generator; a deterministic positional fallback is used if absent
 * @param {number[]} [mat] host wall material [r,g,b,emissive,tintable,rough,profile]
 * @param {object} [opts]
 * @returns {number} vertices appended
 */
export function appendEntrance(mb, rng, x, y, z, yaw, width, style, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = clamp(isNum(width) ? width : 2.2, 1.0, 8.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 7);
  const host = readHost(mb, mat);
  if (lodOf(opts) === FACADE_LOD.COARSE) entCoarse(mb, F, R, host, w, style);
  else if (style === 'revolving') entRevolving(mb, F, R, host, w);
  else if (style === 'shopfront') entShopfront(mb, F, R, host, w);
  else if (style === 'service') entService(mb, F, R, host, w);
  else entDouble(mb, F, R, host, w);
  return vcount(mb) - before;
}

/* ================================================= shopfronts and awnings == */

/**
 * A retail ground floor: stall riser, pilasters, full-height glazing in bays, a lit valance, a
 * fascia sign band and one recessed entry. This is the single biggest win for street-level
 * believability, and it is what goes on every profile-3 frontage.
 *
 * (x, y, z) is the wall point at the CENTRE of the frontage, at sidewalk level. `height` is the
 * shopfront zone, floor to the top of the fascia — typically 4.2-5.6 m.
 *
 * opts: { door: boolean (default true), sign: boolean, lit: boolean, bay: number, lod }
 * Cost: ~62 verts per bay plus ~66 fixed, ~200 for a 12 m three-bay frontage with a door.
 * At FACADE_LOD.COARSE: 18-36 verts whatever the frontage, because the bays go away.
 *
 * @returns {number} vertices appended
 */
export function appendShopfront(mb, rng, x, y, z, yaw, width, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.6) return 0;
  const H = clamp(isNum(height) ? height : 4.6, 2.8, 8.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 13);
  const host = readHost(mb, mat);

  // Draw every random value up front and in a fixed order, so a branch never shifts the stream.
  const rBays = R();
  const rDoor = R();
  const rSign = R();
  const rLitSign = R();

  const hw = w * 0.5;
  const signH = clamp(H * 0.17, 0.52, 0.95);
  const headH = 0.12;
  const glazTop = H - signH - headH;
  const glazBot = BULKHEAD_H;
  if (glazTop - glazBot < 0.9) return 0;

  const target = isNum(o.bay) ? clamp(o.bay, 1.8, 6.0) : BAY_TARGET * lerp(0.9, 1.12, rBays);
  const nBays = clamp(Math.round(w / target), 1, 12);
  const pitch = w / nBays;
  const wantDoor = o.door !== false && w >= 3.2 && pitch >= 1.5;
  const doorBay = wantDoor ? Math.min(nBays - 1, Math.floor(rDoor * nBays)) : -1;
  const wantSign = o.sign !== false && rSign < 0.92;
  const signLit = o.lit !== undefined ? !!o.lit : rLitSign < 0.48;

  // --- COARSE ---------------------------------------------------------------------------------
  // Four flat bands and, where the full version would recess an entry, one dark panel: riser,
  // glazing, head, fascia. The bay rhythm is what goes — at 0.15 m a mullion is a pixel at 117 m
  // and pure aliasing past that — but the DATUM lines survive, and those are what a shopfront
  // reads as from across a block. Same materials, same sign, same lit/unlit decision, and the
  // same number of draws off the rng: the entry consumes one exactly when the full path's
  // entShopfront would have.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.74, 0.70);
    rect(mb, F, -hw, hw, 0, glazBot, SKIN);
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, -hw, hw, glazBot, glazTop, SKIN + 0.015);
    applyHost(mb, host, 0.92, 0.60);
    rect(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN);
    if (wantSign) {
      if (signLit) applyMat(mb, MAT_SIGN_LIT); else applyHost(mb, host, 0.58, 0.55);
      rect(mb, F, -hw, hw, H - signH, H, SKIN);
    }
    if (doorBay >= 0) {
      const uc = -hw + (doorBay + 0.5) * pitch;
      const clear = pitch - MULLION_W * 1.2;
      const dF = frameAt(fx(F, uc, 0), F.y, fz(F, uc, 0), F.yaw);
      // In front of the glazing band, because the entry is no longer a cavity that could be
      // seen INTO — flat geometry has to be layered, and 0.03 m is under a tenth of a pixel at
      // the range this level is for while being ten times the depth buffer's resolution there.
      entCoarse(mb, dF, R, host, clear, 'shopfront', SKIN + 0.03);
    }
    return vcount(mb) - before;
  }

  // --- stall riser, split around the entry so the recess floor is not blocked ---------------
  applyHost(mb, host, 0.74, 0.70);
  if (doorBay < 0) {
    slab(mb, F, -hw, hw, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP);
  } else {
    const dL = -hw + doorBay * pitch;
    const dR = dL + pitch;
    if (dL + hw > 0.12) slab(mb, F, -hw, dL, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP | F_RIGHT);
    if (hw - dR > 0.12) slab(mb, F, dR, hw, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP | F_LEFT);
  }

  // --- pilasters at every bay line, deepened where they frame the entry ----------------------
  for (let i = 0; i <= nBays; i++) {
    const uc = -hw + i * pitch;
    const isDoorJamb = doorBay >= 0 && (i === doorBay || i === doorBay + 1);
    const proj = isDoorJamb ? RECESS_D : MULLION_D;
    const half = (i === 0 || i === nBays) ? MULLION_W * 1.3 : MULLION_W * 0.5;
    const u0 = (i === 0) ? uc : uc - half;
    const u1 = (i === nBays) ? uc : uc + half;
    applyHost(mb, host, i === 0 || i === nBays ? 1.0 : 0.86, 0.55);
    slab(mb, F, u0, u1, 0, glazTop + 0.06, SKIN, proj, F_OUT | F_LEFT | F_RIGHT);
  }

  // --- glazing, one pane per bay, with the transom bar that gives a shopfront its datum -------
  // The bar is what stops a 3 x 3.3 m sheet of glass reading as a hole: it sits at door-head
  // height, which is the line every real shopfront on Queen West shares.
  const transom = glazTop - glazBot > 2.6 ? glazBot + (glazTop - glazBot) * 0.72 : 0;
  for (let i = 0; i < nBays; i++) {
    if (i === doorBay) continue;
    const u0 = -hw + i * pitch + MULLION_W * 0.6;
    const u1 = -hw + (i + 1) * pitch - MULLION_W * 0.6;
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, u0, u1, glazBot, glazTop, 0.05);
    if (transom > 0) {
      applyMat(mb, MAT_METAL_DARK);
      rect(mb, F, u0, u1, transom - 0.045, transom + 0.045, 0.085);
    }
  }

  // --- head, concealed valance strip, fascia sign -------------------------------------------
  applyHost(mb, host, 0.92, 0.60);
  slab(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN, 0.16, F_OUT | F_BOT);
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.2, hw - 0.2, glazTop - 0.03, glazTop + 0.01, 0.07, 0.15, F_BOT);
  if (wantSign) {
    if (signLit) applyMat(mb, MAT_SIGN_LIT); else applyHost(mb, host, 0.58, 0.55);
    slab(mb, F, -hw, hw, H - signH, H, SKIN, 0.21, F_OUT | F_TOP | F_BOT);
  }

  // --- the entry, and the transom that glazes the gap between its head and the head band ------
  if (doorBay >= 0) {
    const uc = -hw + (doorBay + 0.5) * pitch;
    const clear = pitch - MULLION_W * 1.2;
    const dF = frameAt(fx(F, uc, 0), F.y, fz(F, uc, 0), F.yaw);
    const headTop = entShopfront(mb, dF, R, host, clear);
    if (glazTop - headTop > 0.15) {
      applyMat(mb, MAT_GLASS_LIT);
      rect(mb, F, uc - clear * 0.5, uc + clear * 0.5, headTop, glazTop, 0.05);
    }
  }
  return vcount(mb) - before;
}

/**
 * A fabric awning over a shopfront bay: sloped top, valance, gores at each end. (x, y, z) is the
 * wall point at the TOP fixing; the front bar sits `depth` out and 0.55 m lower.
 * opts: { ends: boolean (default true), lod }
 * Cost: 30 verts, 12 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendAwning(mb, rng, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.8) return 0;
  const dp = clamp(isNum(depth) ? depth : 1.3, 0.5, 3.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 17);
  const o = opts || {};
  const hw = w * 0.5;
  const drop = clamp(dp * 0.42, 0.22, 0.75);
  const val = 0.30;
  const col = AWNING_COLS[Math.min(AWNING_COLS.length - 1, (R() * AWNING_COLS.length) | 0)];
  const rough = 0.90;

  // COARSE: the sloped sheet and its underside. The valance and the end gores are 0.3 m and
  // 0.1 m2 of fabric — under a pixel at the range this level is for — but the awning's own
  // colour and the shade it throws on the shopfront behind it are the whole point of it, and
  // both of those are carried by these two faces.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
    quad(mb, F, -hw, -drop, dp, hw, -drop, dp, hw, 0, SKIN, -hw, 0, SKIN);
    mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
    quad(mb, F, -hw, 0, SKIN, hw, 0, SKIN, hw, -drop, dp, -hw, -drop, dp);
    return vcount(mb) - before;
  }

  mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
  // Top surface, wall high, front bar low. Wound so the normal points up and out.
  quad(mb, F, -hw, -drop, dp, hw, -drop, dp, hw, 0, SKIN, -hw, 0, SKIN);
  // Underside — a shade darker, because the whole reason an awning reads is its shadow.
  mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
  quad(mb, F, -hw, 0, SKIN, hw, 0, SKIN, hw, -drop, dp, -hw, -drop, dp);
  // Valance hanging off the front bar, front and back.
  mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
  rect(mb, F, -hw, hw, -drop - val, -drop, dp);
  mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
  quad(mb, F, hw, -drop - val, dp - 0.02, -hw, -drop - val, dp - 0.02, -hw, -drop, dp - 0.02, hw, -drop, dp - 0.02);
  // End gores.
  if (o.ends !== false) {
    mb.color(col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, 0, 0, rough, 0);
    tri3(mb, F, hw, 0, SKIN, hw, -drop, dp, hw, -drop - val, dp);
    tri3(mb, F, -hw, 0, SKIN, -hw, -drop - val, dp, -hw, -drop, dp);
  }
  return vcount(mb) - before;
}

/**
 * A rigid entrance canopy: a cantilevered slab with a lit soffit, hung on two tie rods.
 * (x, y, z) is the wall point at the canopy's UNDERSIDE.
 * opts: { rods: boolean (default true), lod }
 * Cost: 60 verts, 72 with a third tie rod. 30 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendCanopy(mb, rng, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.8) return 0;
  const dp = clamp(isNum(depth) ? depth : 2.0, 0.6, 5.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 19);
  const o = opts || {};
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const t = clamp(dp * 0.11, 0.16, 0.34);

  // COARSE: one closed slab. The 70 mm tie rods and the strip light in the soffit are the two
  // things that go; the projecting deck, which is the whole silhouette and the whole shadow, is
  // exactly what it was. The rng is drawn under precisely the same condition as below, so the
  // stream does not move.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.02, 0.55);
    slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_SHELL);
    if (o.rods !== false && dp > 0.9 && w > 6.0) R();
    return vcount(mb) - before;
  }

  applyHost(mb, host, 1.02, 0.55);
  slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_SHELL & ~F_BOT);
  // Soffit: a separate darker plate so the underside reads as shade even with SSAO off.
  applyHost(mb, host, 0.42, 0.70);
  slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_BOT);
  // Downlights in the soffit.
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.35, hw - 0.35, -0.012, 0.002, dp * 0.30, dp * 0.72, F_BOT);
  // Tie rods back to the wall, unless the caller wants a bare cantilever. A wide canopy carries
  // a third rod on the centre line about half the time — enough to break up a row of identical
  // entrances without changing what any of them is.
  if (o.rods !== false && dp > 0.9) {
    applyMat(mb, MAT_METAL_PALE);
    const rise = clamp(dp * 0.85, 0.8, 2.2);
    const ur = Math.max(0.2, hw - 0.30);
    const mid = w > 6.0 && R() < 0.5;
    for (let i = 0; i < 3; i++) {
      if (i === 2 && !mid) continue;
      const u = i === 0 ? -ur : (i === 1 ? ur : 0);
      planeBoth(mb, F,
        u - 0.035, t, dp - 0.14,
        u + 0.035, t, dp - 0.14,
        u + 0.035, t + rise, 0.04,
        u - 0.035, t + rise, 0.04);
    }
  }
  return vcount(mb) - before;
}

/* ================================================================ balcony == */

/**
 * One floor of projecting balcony — slab edge, glass rail, metal cap, shadowed underside. THE
 * Toronto condo signature; its absence is the most visible thing missing from the residential
 * stock. (x, y, z) is the wall point at the balcony DECK level (the walking surface); the slab
 * hangs below it and the rail stands on it.
 *
 * opts: { ends: boolean (default true), rail: number rail height, slab: number slab thickness,
 *         lod }
 * Cost: 54 verts with ends, 42 without. At FACADE_LOD.COARSE, 30 and 18.
 *
 * This is the builder LOD matters most for: a 40-storey condo carries up to 20 bands on each of
 * two elevations, so the level chosen here is worth more vertices than every other feature on
 * the building put together.
 * @returns {number} vertices appended
 */
export function appendBalconyBand(mb, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.9) return 0;
  const dp = clamp(isNum(depth) ? depth : 1.8, 0.5, 4.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const th = clamp(isNum(o.slab) ? o.slab : 0.24, 0.10, 0.6);
  const rail = clamp(isNum(o.rail) ? o.rail : 1.07, 0.7, 1.5);
  const ends = o.ends !== false;

  // COARSE: deck slab and glass rail as ONE solid, from the underside of the slab to the top of
  // the balustrade. The two of them are 0.24 m of pale concrete under 1.07 m of dark glass and
  // they sit within 0.07 m of the same plane, so at range they are one 1.31 m projecting band —
  // which is exactly the horizontal striping that makes a Toronto condo read as a condo from two
  // kilometres. 0.80 is the area-weighted lightness of the pair and 0.60 splits their roughness.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.80, 0.60);
    slab(mb, F, -hw, hw, -th, rail, SKIN, dp, F_OUT | F_TOP | F_BOT | (ends ? F_ENDS : 0));
    return vcount(mb) - before;
  }

  // Slab: fascia, deck and ends in the wall's own concrete, underside darker.
  applyHost(mb, host, 0.86, 0.80);
  slab(mb, F, -hw, hw, -th, 0, SKIN, dp, (F_OUT | F_TOP) | (ends ? F_ENDS : 0));
  applyHost(mb, host, 0.38, 0.86);
  slab(mb, F, -hw, hw, -th, 0, SKIN, dp, F_BOT);
  // Glass balustrade, set in from the slab edge, both faces (you see the inboard one from above).
  applyMat(mb, MAT_GLASS);
  const dr = dp - 0.07;
  planeBoth(mb, F, -hw + 0.05, 0.02, dr, hw - 0.05, 0.02, dr, hw - 0.05, rail, dr, -hw + 0.05, rail, dr);
  // Capping rail.
  applyMat(mb, MAT_METAL_PALE);
  slab(mb, F, -hw + 0.05, hw - 0.05, rail, rail + 0.055, dr - 0.045, dr + 0.045, F_OUT | F_TOP);
  return vcount(mb) - before;
}

/* ================================================== masonry articulation == */

/**
 * A projecting cornice for masonry and heritage stock: dentil band, corona, weathered crown.
 * (x, y, z) is the wall point at the BOTTOM of the cornice. `depth` is the maximum projection.
 * opts: { ends: boolean (default true), lod } — turn ends off for a band that wraps a building.
 * Cost: 84 verts with ends, 48 without. At FACADE_LOD.COARSE, 30 and 18.
 * @returns {number} vertices appended
 */
export function appendCornice(mb, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.5) return 0;
  const dp = clamp(isNum(depth) ? depth : 0.55, 0.12, 2.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const e = o.ends !== false ? F_ENDS : 0;

  // COARSE: one band at the corona's own projection, spanning the whole cornice height. What a
  // cornice does at range is put a lit top edge and a shadowed underside on the roofline, and a
  // single slab does both; the dentil course and the weathered crown are 0.2 m steps.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.08, 0.78);
    slab(mb, F, -hw, hw, 0, dp * 1.62, SKIN, dp, F_BAND | e);
    return vcount(mb) - before;
  }

  applyHost(mb, host, 1.00, 0.78);
  slab(mb, F, -hw, hw, 0, dp * 0.36, SKIN, dp * 0.34, F_BAND | e);
  applyHost(mb, host, 1.10, 0.78);
  slab(mb, F, -hw, hw, dp * 0.36, dp * 1.05, SKIN, dp, F_BAND | e);
  applyHost(mb, host, 1.16, 0.80);
  slab(mb, F, -hw, hw, dp * 1.05, dp * 1.42, SKIN, dp * 0.62, F_OUT | e);
  // Weathering: the crown slopes back to the wall so it does not read as a shelf.
  quad(mb, F, -hw, dp * 1.42, dp * 0.62, hw, dp * 1.42, dp * 0.62, hw, dp * 1.62, SKIN, -hw, dp * 1.62, SKIN);
  return vcount(mb) - before;
}

/**
 * A string course: the thin horizontal band that ties a masonry facade together at floor lines.
 * (x, y, z) is the wall point at the BOTTOM of the band.
 * opts: { h: band height (0.24), proj: projection (0.10), ends: boolean (default false), lod }
 * Cost: 18 verts, 30 with ends. Already one slab, so COARSE drops it to the outward face alone —
 * 6 verts — and the 0.10 m shadow line it loses there is a tenth of a pixel at that range.
 * @returns {number} vertices appended
 */
export function appendStringCourse(mb, x, y, z, yaw, width, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.4) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const h = clamp(isNum(o.h) ? o.h : 0.24, 0.06, 1.2);
  const proj = clamp(isNum(o.proj) ? o.proj : 0.10, 0.03, 0.8);
  applyHost(mb, host, 1.12, 0.78);
  if (lodOf(o) === FACADE_LOD.COARSE) rect(mb, F, -hw, hw, 0, h, SKIN);
  else slab(mb, F, -hw, hw, 0, h, SKIN, proj, F_BAND | (o.ends ? F_ENDS : 0));
  return vcount(mb) - before;
}

/**
 * A parapet standing on the roof edge, capped with coping. (x, y, z) is the wall point at ROOF
 * level; the wall face is flush with the facade below and the parapet thickens INWARD, over the
 * roof, so it never floats off the edge of the extrusion.
 * opts: { t: wall thickness (0.30), ends: boolean (default false), lod }
 * Cost: 30 verts, 18 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendParapet(mb, x, y, z, yaw, width, h, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.4) return 0;
  const hh = clamp(isNum(h) ? h : 1.05, 0.25, 4.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const t = clamp(isNum(o.t) ? o.t : 0.30, 0.10, 1.2);
  const e = o.ends ? F_ENDS : 0;
  const capH = Math.min(0.14, hh * 0.3);
  // COARSE: one leaf, coping included. The 0.14 m cap is a lighter line along the very top of the
  // building and it is worth keeping at range — but it is worth keeping as the top face of the
  // wall, not as its own box.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.02, 0.72);
    slab(mb, F, -hw, hw, 0, hh, -t, SKIN, (F_OUT | F_IN | F_TOP) | e);
    return vcount(mb) - before;
  }
  applyHost(mb, host, 0.98, 0.74);
  slab(mb, F, -hw, hw, 0, hh - capH, -t, SKIN, (F_OUT | F_IN) | e);
  applyHost(mb, host, 1.14, 0.70);
  slab(mb, F, -hw, hw, hh - capH, hh, -t - 0.05, 0.05, (F_OUT | F_IN | F_TOP) | e);
  return vcount(mb) - before;
}

/* =========================================================== fire escapes == */

/**
 * A bolted-on fire escape for older brick stock — landings, railings, and a flight between each
 * pair of landings. Rear and side elevations only; this is the most expensive builder here.
 * (x, y, z) is the wall point under the CENTRE of the LOWEST landing, at that landing's level.
 *
 * opts: { storey: floor-to-floor (3.4), ladder: boolean (default true), lod }
 * Cost: ~66 verts per floor plus ~24, measured 324 for 4 floors. At FACADE_LOD.COARSE, 18 per
 * floor and nothing fixed — 72 for the same four.
 * @returns {number} vertices appended
 */
export function appendFireEscape(mb, rng, x, y, z, yaw, width, floors, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.2) return 0;
  const n = clamp(Math.round(isNum(floors) ? floors : 3), 1, 8);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 23);
  const hw = Math.min(w, 4.2) * 0.5;
  const st = clamp(isNum(o.storey) ? o.storey : 3.4, 2.4, 5.5);
  const dp = clamp(w * 0.28, 0.95, 1.35);
  const rail = 1.05;
  const side = R() < 0.5 ? -1 : 1;   // which end the flights run from

  // COARSE: the landings, and only the landings. A fire escape at range is a stack of dark
  // horizontal lines on a brick wall — the rails are 30-70 mm of steel, the flights are a
  // diagonal inside a shadow, and the drop ladder is below the bottom landing where nothing can
  // see it. The band here is deck plus rail height, so the stack keeps its full outline.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyMat(mb, MAT_STEEL);
    for (let i = 0; i < n; i++) {
      const v = i * st;
      slab(mb, F, -hw, hw, v, v + rail, SKIN, dp, F_OUT | F_TOP | F_BOT);
    }
    return vcount(mb) - before;
  }

  applyMat(mb, MAT_STEEL);
  for (let i = 0; i < n; i++) {
    const v = i * st;
    // Landing: grating deck, seen from below as much as from above.
    slab(mb, F, -hw, hw, v, v + 0.07, SKIN, dp, F_OUT | F_TOP | F_BOT);
    // Railing: top rail, mid rail, and a stanchion at each end.
    slab(mb, F, -hw, hw, v + rail - 0.05, v + rail, dp - 0.09, dp, F_OUT | F_TOP);
    rect(mb, F, -hw, hw, v + rail * 0.5 - 0.03, v + rail * 0.5 + 0.03, dp);
    slab(mb, F, -hw, -hw + 0.07, v, v + rail, dp - 0.08, dp, F_OUT | F_RIGHT);
    slab(mb, F, hw - 0.07, hw, v, v + rail, dp - 0.08, dp, F_OUT | F_LEFT);
    // Flight up to the next landing: a plate on the diagonal with a handrail over it.
    if (i < n - 1) {
      const u0 = side * (hw - 0.12);
      const u1 = side * (0.12 - hw);
      planeBoth(mb, F,
        u0, v + 0.07, dp * 0.55,
        u1, v + st + 0.07, dp * 0.55,
        u1, v + st + 0.07, dp * 0.95,
        u0, v + 0.07, dp * 0.95);
      planeBoth(mb, F,
        u0, v + 0.95, dp * 0.52,
        u1, v + st + 0.95, dp * 0.52,
        u1, v + st + 0.99, dp * 0.52,
        u0, v + 0.99, dp * 0.52);
    }
  }
  // The counterweighted drop ladder under the bottom landing.
  if (o.ladder !== false) {
    const u = side * (hw - 0.35);
    planeBoth(mb, F,
      u - 0.22, -Math.min(2.2, st * 0.62), dp * 0.7,
      u + 0.22, -Math.min(2.2, st * 0.62), dp * 0.7,
      u + 0.22, 0.06, dp * 0.7,
      u - 0.22, 0.06, dp * 0.7);
  }
  return vcount(mb) - before;
}

/* ========================================================== loading docks == */

/**
 * A loading dock on a rear or service elevation: raised apron, roller shutter in a deep reveal,
 * rubber bumpers and a steel weather canopy. (x, y, z) is the wall point at the CENTRE of the
 * opening, at ground level.
 * opts: { canopy: boolean (default true), dock: number platform height (1.15), lod }
 * Cost: ~132 verts, measured 150 with the canopy. At FACADE_LOD.COARSE, 36 and 18.
 * @returns {number} vertices appended
 */
export function appendLoadingDock(mb, x, y, z, yaw, width, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.8) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = Math.min(w, 9.0) * 0.5;
  const deck = clamp(isNum(o.dock) ? o.dock : 1.15, 0.6, 1.6);
  const doorH = deck + 3.05;

  // COARSE: the apron and the shutter. The reveal, the rubber bumpers and the shutter's guides
  // are all under 0.3 m; what survives is the raised platform, which is a real change of ground
  // level, and the dark rectangle of the door, which is what says "loading dock" at range.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.80, 0.86);
    slab(mb, F, -hw - 0.30, hw + 0.30, 0, deck, -0.05, 1.35, F_OUT | F_TOP);
    applyMat(mb, MAT_SHUTTER);
    rect(mb, F, -hw, hw, deck, doorH, SKIN);
    if (o.canopy !== false) {
      applyMat(mb, MAT_STEEL);
      slab(mb, F, -hw - 0.45, hw + 0.45, doorH + 0.22, doorH + 0.40, SKIN, 1.55, F_OUT | F_TOP | F_BOT);
    }
    return vcount(mb) - before;
  }

  // Apron: the raised platform trucks back up to.
  applyHost(mb, host, 0.80, 0.86);
  slab(mb, F, -hw - 0.30, hw + 0.30, 0, deck, -0.05, 1.35, F_OUT | F_TOP | F_ENDS);
  // Reveal around the opening.
  applyHost(mb, host, 0.94, 0.70);
  slab(mb, F, -hw - 0.22, -hw, deck, doorH + 0.2, SKIN, 0.28, F_OUT | F_RIGHT);
  slab(mb, F, hw, hw + 0.22, deck, doorH + 0.2, SKIN, 0.28, F_OUT | F_LEFT);
  slab(mb, F, -hw - 0.22, hw + 0.22, doorH, doorH + 0.2, SKIN, 0.28, F_OUT | F_BOT);
  // Rolling shutter, and the guides it runs in.
  applyMat(mb, MAT_SHUTTER);
  slab(mb, F, -hw, hw, deck, doorH, SKIN, 0.07, F_OUT | F_TOP);
  // Bumpers.
  applyMat(mb, MAT_RUBBER);
  slab(mb, F, -hw - 0.02, -hw + 0.26, deck - 0.42, deck - 0.06, 1.33, 1.48, F_OUT | F_TOP | F_ENDS);
  slab(mb, F, hw - 0.26, hw + 0.02, deck - 0.42, deck - 0.06, 1.33, 1.48, F_OUT | F_TOP | F_ENDS);
  // Weather canopy over the opening.
  if (o.canopy !== false) {
    applyMat(mb, MAT_STEEL);
    slab(mb, F, -hw - 0.45, hw + 0.45, doorH + 0.22, doorH + 0.40, SKIN, 1.55, F_SHELL);
  }
  return vcount(mb) - before;
}

/* =========================================================== composition == */

/**
 * The entrance style a building's lighting profile calls for (CONTRACT.md §6.2).
 *   0 envelope -> service   1 office -> revolving (double if it is too small for a drum)
 *   2 residential -> double 3 retail -> shopfront 4 parking -> service 5 civic -> double
 * @param {number} profile city.js lighting profile 0-5
 * @param {number} height building height in metres
 * @returns {string} 'revolving' | 'double' | 'shopfront' | 'service'
 */
export function entranceStyleFor(profile, height) {
  const p = (isNum(profile) ? profile : -1) | 0;
  const h = isNum(height) ? height : 0;
  if (p === 3) return 'shopfront';
  if (p === 0 || p === 4) return 'service';
  if (p === 1) return h >= 34 ? 'revolving' : 'double';
  if (p === 2) return h >= 90 ? 'revolving' : 'double';
  if (p === 5) return 'double';
  return h >= 34 ? 'revolving' : 'double';
}

/**
 * The whole ground-floor treatment for one street-facing frontage, composed from the builders
 * above and sized by the building's lighting profile. This is what city.js calls per frontage;
 * everything it does can also be done piecemeal.
 *
 * (x, y, z) is the wall point at the CENTRE of the frontage, at sidewalk level; `width` is the
 * available frontage.
 *
 * opts: { profile, height (building height), floorH (ground storey, default 4.6),
 *         retail: force a shopfront, canopy: boolean, awning: boolean, lod }
 *
 * `opts` is passed through UNCHANGED to every builder this composes, so one `lod` on the way in
 * sets the level for the whole frontage. Both levels draw the same values off `rng` in the same
 * order, so a tile that builds its frontages COARSE places exactly the same lamps, trees and
 * parked cars afterwards as one that builds them FULL.
 *
 * Measured cost: 292 verts for retail (12 m frontage), 321 for an office tower, 200 for a condo
 * lobby, 96 for a service elevation — all inside the ~400 budget for one building.
 * At FACADE_LOD.COARSE: 48, 42, 42 and 12.
 * @returns {number} vertices appended
 */
export function appendGroundFloor(mb, rng, x, y, z, yaw, width, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.2) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const R = rngOf(rng, x, z, 29);
  const host = readHost(mb, o.mat);
  const profile = isNum(o.profile) ? (o.profile | 0) : 3;
  const bh = isNum(o.height) ? o.height : 20;
  const floorH = clamp(isNum(o.floorH) ? o.floorH : 4.6, 2.8, 8.0);
  let style = typeof o.style === 'string' ? o.style : entranceStyleFor(profile, bh);
  // A drum plus its flanking leaves needs about 4 m of wall. On a narrower frontage — a tower on
  // a corner sliver, or a side elevation — it would hang off both ends of the building, so the
  // lobby falls back to a glazed pair.
  if (style === 'revolving' && w < 4.2) style = 'double';
  const rAwn = R();

  if ((profile === 3 || o.retail) && w >= 4.0 && style !== 'service') {
    appendShopfront(mb, R, x, y, z, yaw, w, floorH, host, o);
    if (o.awning !== false && rAwn < 0.45) {
      const F = frameAt(x, y, z, yaw);
      const aw = Math.min(w * 0.42, 4.2);
      const uc = -w * 0.5 + aw * 0.5 + 0.2;
      appendAwning(mb, R, fx(F, uc, 0), y + floorH - clamp(floorH * 0.17, 0.52, 0.95) - 0.16,
        fz(F, uc, 0), yaw, aw, 1.25, host, o);
    }
    return vcount(mb) - before;
  }

  // The opening is sized by the frontage and then held inside it, surround included, so nothing
  // ever overhangs the end of the wall it was placed on.
  const raw = style === 'revolving' ? clamp(w * 0.30, 3.0, 5.4)
    : (style === 'service' ? clamp(w * 0.22, 1.1, 2.0) : clamp(w * 0.26, 1.9, 3.4));
  const doorW = Math.max(1.0, Math.min(raw, w - 0.7));
  appendEntrance(mb, R, x, y, z, yaw, doorW, style, host, o);
  if (o.canopy !== false && (style === 'revolving' || style === 'double') && w >= 4.0) {
    appendCanopy(mb, R, x, y + floorH * 0.78, z, yaw, Math.min(doorW + 1.5, w),
      style === 'revolving' ? 2.4 : 1.8, host, o);
  }
  return vcount(mb) - before;
}
