// src/city/facadekit.js — the frame every facade builder in city/ is written against: the
// (u, v, d) basis, the material palette, the level-of-detail rule, the coplanar-geometry audit and
// the small drawing helpers (quad, rect, slab, drum) that emit into it.
//
// CONTRACT.md §6.2 / Amendment 11.1. THE CONVENTIONS BELOW GOVERN city/facades.js,
// city/articulation.js AND city/unitfronts.js; those files state only what is particular to them
// and point back here.
//
// Every building in this city currently meets the pavement as a bare extruded wall. This module
// is what puts a door, a shopfront, a canopy and a balcony on it. Zero dependencies; pure
// geometry builders that APPEND into an existing MeshBuilder so the whole city stays a handful
// of draw calls. Nothing here creates a Mesh and nothing here reads data/toronto.json — city.js
// decides WHERE these go, the facade builders in city/ decide WHAT they look like.
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
// Local coordinates used by every facade builder in city/ are (u, v, d):
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
// Vertex format is core/vertex.js's; MeshBuilder.color(r, g, b, emissive, tintable, rough,
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
// FULL is untouched: every FULL path in city/ is the original code and emits the original
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

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';

export const TAU = Math.PI * 2;

export const MIN_EXT = 1e-4;          // an extent below this is zero: skip the face rather than emit slivers

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
export const SKIN = 0.035;

// Face bits for slab(). OUT is the street-facing face, IN the wall-facing one.
export const F_OUT = 1;

export const F_IN = 2;

export const F_TOP = 4;

export const F_BOT = 8;

export const F_LEFT = 16;

export const F_RIGHT = 32;

const F_ALL = 63;

export const F_ENDS = F_LEFT | F_RIGHT;

export const F_BAND = F_OUT | F_TOP | F_BOT;          // a band that dies into the wall at both ends

export const F_SHELL = F_ALL & ~F_IN;                 // everything except the hidden wall-side face

// Standard sizes. Real Toronto retail runs a 0.4-0.5 m stall riser, a fascia around 0.6-0.9 m,
// and bays of 2.6-3.4 m between pilasters.
export const BULKHEAD_H = 0.44;

export const MULLION_W = 0.15;

export const MULLION_D = 0.13;

export const BAY_TARGET = 3.05;

export const RECESS_D = 0.72;         // how far a shopfront entry surround projects, i.e. the reveal depth

export const DOOR_H = 2.16;

export const LEAF_W = 0.92;

// Shopfront and lobby glazing. Warm-dark rather than cool, because what you are looking at is a
// lit room seen through glass, not a mirror; the low roughness still gives it the sky and the
// street lamps on top. Emissive 0.55 replaces the procedural retail band it covers up.
export const MAT_GLASS_LIT = [0.088, 0.076, 0.062, 0.55, 0, 0.09, 0];

// Unlit glazing: sidelights, transoms, upper-floor infill. Cool, dark, mirror-smooth.
export const MAT_GLASS = [0.050, 0.055, 0.064, 0, 0, 0.07, 0];

// The back of a recess: a genuine interior plane, seen through the doors and over them.
export const MAT_INTERIOR = [0.300, 0.222, 0.140, 0.66, 0, 0.62, 0];

// Concealed strip light under a shopfront head, and the underside of an entrance canopy.
export const MAT_VALANCE = [0.620, 0.470, 0.300, 0.92, 0, 0.65, 0];

// Internally lit fascia sign — the one place at street level with real chroma.
export const MAT_SIGN_LIT = [0.255, 0.215, 0.172, 0.60, 0, 0.50, 0];

// Anodised dark frame: mullions, door leaves, shutter guides.
export const MAT_METAL_DARK = [0.034, 0.035, 0.038, 0, 0, 0.18, 0];

// Stainless / mill-finish aluminium: pull bars, cap rails, revolving-door frames.
export const MAT_METAL_PALE = [0.112, 0.116, 0.122, 0, 0, 0.16, 0];

// Painted structural steel, weathered: fire escapes, dock canopies.
export const MAT_STEEL = [0.040, 0.037, 0.034, 0, 0, 0.45, 0];

// Galvanised grating and rolling shutters.
export const MAT_SHUTTER = [0.062, 0.063, 0.066, 0, 0, 0.34, 0];

// Dock bumpers and door sweeps.
export const MAT_RUBBER = [0.017, 0.017, 0.019, 0, 0, 0.90, 0];

// Awning canvas. Muted on purpose — the art direction is desaturated apart from lamps and
// interior light, and a row of primary-coloured awnings would be the loudest thing on the street.
export const AWNING_COLS = [
  [0.055, 0.030, 0.026],       // burgundy
  [0.026, 0.041, 0.030],       // dark green
  [0.026, 0.030, 0.048],       // navy
  [0.031, 0.031, 0.032],       // charcoal
  [0.058, 0.047, 0.031],       // ochre canvas
  [0.048, 0.048, 0.046],       // bone
];

const HOST_FALLBACK = [0.052, 0.053, 0.056, 0, 0, 0.88, 0];

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

// A deterministic stand-in when a caller passes no rng. Never Math.random: city generation must
// be reproducible, and a facade that changes between loads is a bug you cannot chase.
export function fallbackRng(x, z, salt) {
  let s = ((Math.round(x * 16) * 73856093) ^ (Math.round(z * 16) * 19349663) ^ ((salt | 0) * 83492791)) >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngOf(rng, x, z, salt) {
  return typeof rng === 'function' ? rng : fallbackRng(x, z, salt);
}

/**
 * Detail level for every facade builder in city/, selected per call through opts.lod.
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
export function lodOf(o) {
  return (o && (o.lod | 0) === FACADE_LOD.COARSE) ? FACADE_LOD.COARSE : FACADE_LOD.FULL;
}

/**
 * The local coordinate system of one patch of wall. See the header for (u, v, d).
 * @param {number} x wall point, world X
 * @param {number} y wall point, world Y — the BASE of the feature unless a builder says otherwise
 * @param {number} z wall point, world Z
 * @param {number} yaw facing OUT of the facade
 */
export function frameAt(x, y, z, yaw) {
  const a = isNum(yaw) ? yaw : 0;
  return { x, y, z, yaw: a, c: Math.cos(a), s: Math.sin(a) };
}

export function fx(F, u, d) { return F.x - u * F.s + d * F.c; }

export function fz(F, u, d) { return F.z - u * F.c - d * F.s; }

// One quad from four local corners, wound CCW as seen from the side it should face. Positions go
// through MeshBuilder.tri(), which derives the flat normal from the winding with its own epsilon
// guard — so winding is the single source of truth and a normal can never disagree with a face.
// 6 vertices.
export function quad(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3) {
  const ax = fx(F, u0, d0), ay = F.y + v0, az = fz(F, u0, d0);
  const bx = fx(F, u1, d1), by = F.y + v1, bz = fz(F, u1, d1);
  const cx = fx(F, u2, d2), cy = F.y + v2, cz = fz(F, u2, d2);
  const dx = fx(F, u3, d3), dy = F.y + v3, dz = fz(F, u3, d3);
  mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  mb.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
}

// One triangle from three local corners. 3 vertices.
export function tri3(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2) {
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
export function rect(mb, F, u0, u1, v0, v1, d) {
  if (u1 - u0 < MIN_EXT || v1 - v0 < MIN_EXT) return;
  let dd = isNum(d) ? d : SKIN;
  if (dd < SKIN) { dd = SKIN; _fa.clamped++; }
  noteProud(dd);
  quad(mb, F, u0, v0, dd, u1, v0, dd, u1, v1, dd, u0, v1, dd);
}

// A double-sided plane: the quad and its mirror, so a 40 mm tie rod, stair flight or revolving
// vane reads from every angle without paying for a closed box. 12 vertices.
export function planeBoth(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3) {
  quad(mb, F, u0, v0, d0, u1, v1, d1, u2, v2, d2, u3, v3, d3);
  quad(mb, F, u0, v0, d0, u3, v3, d3, u2, v2, d2, u1, v1, d1);
}

/**
 * An axis-aligned box in local facade space, min/max form, with a face mask so hidden faces cost
 * nothing. This is the workhorse: a band that dies into the wall needs 3 faces (18 verts), a free
 * -standing slab needs 5 (30), a full box is 6 (36).
 * @returns {void}
 */
export function slab(mb, F, u0, u1, v0, v1, d0, d1, mask) {
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
export function drumArc(mb, F, uc, dc, r, v0, v1, a0, a1, seg) {
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
export function drumCap(mb, F, uc, dc, r, v, a0, a1, seg) {
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

export function applyMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], 0, m[5], 0);
}

// Host-derived: keep the wall's colour (so brick stays brick), scale its lightness, floor its
// roughness at something masonry, and force emissive and profile to 0 — a moulding is solid.
export function applyHost(mb, host, k, roughMin) {
  mb.color(host[0] * k, host[1] * k, host[2] * k, 0, 0, Math.max(host[5], roughMin), 0);
}

/**
 * The host wall material for one call: explicit `mat` wins, else the MeshBuilder's current colour
 * state, else a neutral concrete. Returns a fresh 7-array — public builders pass it down to their
 * private helpers rather than re-reading, because by then the builder's colour state is whatever
 * the last face set.
 */
export function readHost(mb, mat) {
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

export function vcount(mb) {
  return mb && typeof mb.count === 'number' ? mb.count : 0;
}
