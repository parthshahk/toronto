// src/world/ground.js — the ground plane's datum ladder and the tolerances everyone shares.
//
// CONTRACT.md Amendment 11.1. These are the constants that genuinely cross module boundaries: the
// heights at which the flat covers stack, the road datum, the classes a way may be, and the paint
// lift. Every one of them is a value the city already renders with, moved out of city.js verbatim.
//
// The winding-safe triangle emitters and the two plan-space predicates every pass on the ground
// shares live here for the same reason: they are needed by world/, city/ and the loader alike,
// and any other home for them would make one of those import another sideways.
//
// This module is a LEAF apart from core/math. Nothing in world/, city/ or props/ can create an
// import cycle by reading a datum out of it, which is exactly why the ladder lives here rather
// than inside whichever pass happened to lay the first rung.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { partContains } from '../geom/ring.js';

/* =============================================================== tunables == */

const EPS = 1e-9;
const MIN_RING_AREA = 4.0;         // m^2 — smaller footprints are noise in the massing data
const PLAZA_MIN_AREA = 90.0;       // a closed pedestrian way this big is a square, not a loop path
const WALL_SINK = 1.5;             // start walls below the recorded base so no gap opens on slopes
const ROAD_MAX_SEG = 18.0;         // resample polylines so ribbons follow the terrain
const ROAD_Y = 0.06;               // asphalt sits just proud of the terrain
const CROWN = 0.07;                // centre-line crown on carriageways
const CURB = 0.16;

// GROUND-PLANE LADDER. Everything laid flat on the terrain gets its own rung, because two of these
// surfaces overlapping at the same height is a z-fight the depth buffer resolves differently every
// frame. The rungs are far enough apart to survive the drape error — a big ear-clipped cap
// interpolates linearly across ground that curves under it, measured at about 1 cm — and close
// enough together that no rung reads as a step. Ordered: bare terrain < grass < park < carriageway
// edge < parking apron < loose walkway < kerbed walkway.
//
// The rung SIZE is not a taste decision. A 24-bit integer depth buffer resolves about z^2 / (near
// * 2^24) metres, so at 300 m a 1 cm rung is already inside the noise and two ground covers laid
// a centimetre apart shimmer against each other across the whole middle distance. GROUND_RUNG is
// the smallest step that survives out to roughly a kilometre, and DUP_STAGGER — which separates
// the duplicate and nested polygons of the SAME kind that the extract carries — is kept to a
// fraction of it so the stagger can never eat a rung.
const GROUND_RUNG = 0.038;
const DUP_STAGGER = 0.003;         // +/- this, i.e. never more than 2 * DUP_STAGGER between twins
const GRASS_Y = 0.022;             // landuse=grass, the loser wherever it overlaps a park
const PARK_Y = 0.098;              // leisure=park
const LOT_Y = 0.136;               // surface parking apron
const PATH_Y = 0.174;              // OSM footway with no kerb: park and plaza paths
const PIER_Y = 0.350;
const WATER_Y = 0.0;               // lake datum (meta.lake_msl above sea level)
const LAND_FLOOR = 0.30;           // land never dips to the water plane
const TIE_SPACING = 3.0;
const SEED = 0x70720170;           // one seed for the whole detail pass
// ...and one for the people pass, which draws from its own stream so that adding or removing a
// bench cannot move every pedestrian in the city.
const PED_SEED = 0x51ed9a7f;

const MARK_LIFT = 0.034;           // paint above the asphalt — enough to never z-fight, invisible
const GUTTER_LIFT = 0.016;         // manhole and catch-basin castings: proud of the asphalt, under
                                   // the paint, and far enough off it that the two never fight
const ROAD_CLASS_OK = { motorway: 1, major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };
const BRIDGE_RISE = { motorway: 8.2, major: 5.6, minor: 5.0, service: 4.2, pedestrian: 5.4, foot: 5.4 };
const SIDEWALK_W = { major: 3.8, minor: 2.8, pedestrian: 0 };

function distToSeg2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > EPS) t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

// Emit a near-horizontal triangle wound so its normal points UP, whatever order the caller gave.
// Plan space is (u, v) = (x, -z), so the plan signed area IS the winding test. Getting this wrong
// on a road marking makes the paint vanish under back-face culling from the one angle you drive
// at it from, which is exactly the bug you never see in a screenshot.
function triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const s = (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
  if (s >= 0) mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  else mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
}
/**
 * An axis-free box from two half-extent vectors in plan and a height range. Both halves are given
 * as VECTORS rather than as an angle, so nothing here has to agree with anyone's yaw convention.
 */
function boxAA(mb, cx, cz, ux, uz, vx, vz, y0, y1) {
  const px = [cx - ux - vx, cx + ux - vx, cx + ux + vx, cx - ux + vx];
  const pz = [cz - uz - vz, cz + uz - vz, cz + uz + vz, cz - uz + vz];
  // Plan winding: make the top face look at the sky whichever way the caller handed the vectors.
  const s = (px[1] - px[0]) * (pz[0] - pz[3]) - (px[3] - px[0]) * (pz[0] - pz[1]);
  const o = s >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  for (let k = 0; k < 4; k++) {
    const a = o[k], b = o[(k + 1) & 3];
    mb.tri(px[a], y0, pz[a], px[b], y0, pz[b], px[b], y1, pz[b]);
    mb.tri(px[a], y0, pz[a], px[b], y1, pz[b], px[a], y1, pz[a]);
  }
  mb.tri(px[o[0]], y1, pz[o[0]], px[o[1]], y1, pz[o[1]], px[o[2]], y1, pz[o[2]]);
  mb.tri(px[o[0]], y1, pz[o[0]], px[o[2]], y1, pz[o[2]], px[o[3]], y1, pz[o[3]]);
  mb.tri(px[o[0]], y0, pz[o[0]], px[o[2]], y0, pz[o[2]], px[o[1]], y0, pz[o[1]]);
  mb.tri(px[o[0]], y0, pz[o[0]], px[o[3]], y0, pz[o[3]], px[o[2]], y0, pz[o[2]]);
}

/** Emit a near-horizontal triangle wound so its normal points DOWN, whatever order it came in. */
function triDown(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const s = (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
  if (s <= 0) mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  else mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
}

const WALK_CLASS = { major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };

// One outer-ring edge in plan space: midpoint, outward unit normal, length. A plan-CCW ring keeps
// its interior on the left of travel, so the outward normal is (dv, -du).
const EDGE = { mu: 0, mv: 0, nu: 1, nv: 0, len: 0 };

function ringEdge(part, i) {
  const co = part.outer;
  const j = (i + 2) % co.length;
  const au = co[i], av = co[i + 1];
  const bu = co[j], bv = co[j + 1];
  const du = bu - au, dv = bv - av;
  const l = Math.hypot(du, dv);
  if (!(l > 0.30)) { EDGE.len = 0; return 0; }
  EDGE.mu = (au + bu) * 0.5;
  EDGE.mv = (av + bv) * 0.5;
  EDGE.nu = dv / l;
  EDGE.nv = -du / l;
  // Defensive: a ring that reached here with the wrong orientation would put every door INSIDE
  // the building, where it is invisible and useless. Cheap to test, impossible to spot later.
  if (partContains(part, EDGE.mu + EDGE.nu * 0.45, EDGE.mv + EDGE.nv * 0.45)) {
    EDGE.nu = -EDGE.nu; EDGE.nv = -EDGE.nv;
  }
  EDGE.len = l;
  return l;
}

// Absolute plan area of a footprint ring, for the island cottage height fix.
function ringPlanArea(r) {
  if (!Array.isArray(r) || r.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (!isNum(r[i][0]) || !isNum(r[j][0])) continue;
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  }
  return Math.abs(a * 0.5);
}

export {
  EPS, MIN_RING_AREA, PLAZA_MIN_AREA, WALL_SINK, ROAD_MAX_SEG, ROAD_Y, CROWN, CURB,
  GROUND_RUNG, DUP_STAGGER, GRASS_Y, PARK_Y, LOT_Y, PATH_Y, PIER_Y, WATER_Y, LAND_FLOOR,
  TIE_SPACING, SEED, PED_SEED, MARK_LIFT, GUTTER_LIFT, ROAD_CLASS_OK, BRIDGE_RISE, SIDEWALK_W, WALK_CLASS,
  distToSeg2, triUp, triDown, boxAA, ringEdge, EDGE, ringPlanArea,
};
