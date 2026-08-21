// src/props/lighting.js — street lighting and traffic control: cobra heads, acorns, pedestrian
// poles, the tram catenary, signal masts, street-name blades and the utility pole.
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js. The lamp
// and signal lenses here are among the very few genuine emitters in props/ — everything else in
// this file carries emissive 0 (CONTRACT Amendment 7: the renderer decides what is lit, not the
// geometry).

import { clamp } from '../core/math.js';
import { ALIGN, VALIGN, appendText, textWidth } from '../render/text.js';
import {
  F_ALL, F_BLADEX, F_BLADEZ, F_NOBOT, F_PZ, F_SIDES, MAX_STA, beamL, boxL, discY, fin, finAngle,
  hash2, hullL, quadDown, quadNZ, rnd, setL, setMat, sweepL,
} from './kit.js';
import { M } from './materials.js';

const _ARM = new Float64Array(MAX_STA * 3);

// The arm and head of one cobra fitting, hung off a mast top at local height `top`.
// Four stations make the boom read as a smooth curve rather than a straight diagonal, which is the
// single thing that separates a cobra head from a generic pole with a box on it.
function cobraArm(mb, ox, oy, oz, c, s, top) {
  _ARM[0] = 0.00; _ARM[1] = top - 0.06; _ARM[2] = 0.088;
  _ARM[3] = 0.62; _ARM[4] = top + 0.46; _ARM[5] = 0.079;
  _ARM[6] = 1.55; _ARM[7] = top + 0.82; _ARM[8] = 0.070;
  _ARM[9] = 2.40; _ARM[10] = top + 0.93; _ARM[11] = 0.062;
  setMat(mb, M.poleGrey);
  sweepL(mb, ox, oy, oz, c, s, _ARM, 4, 3, false, false);

  // Flat-bottomed LED head: deep at the back where it clamps the boom, tapering to the front.
  const lens = top + 0.70;
  setL(0, 2.28, lens, -0.220); setL(1, 3.36, lens, -0.155);
  setL(2, 2.28, top + 0.99, -0.220); setL(3, 3.36, top + 0.87, -0.155);
  setL(4, 2.28, lens, 0.220); setL(5, 3.36, lens, 0.155);
  setL(6, 2.28, top + 0.99, 0.220); setL(7, 3.36, top + 0.87, 0.155);
  setMat(mb, M.lampBody);
  hullL(mb, ox, oy, oz, c, s, F_NOBOT);

  // Emissive only on the underside — the casing must stay a dark shape against the sky.
  setMat(mb, M.ledWhite);
  quadDown(mb, ox, oy, oz, c, s, 2.33, -0.195, 3.31, 0.195, lens - 0.006);
}

// Arterial street lighting: tapered octagonal mast, curved boom, flat-bottomed LED head.
export function appendCobraLamp(mb, x, y, z, yaw, h = 9.5) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 9.5), 4.0, 16.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.12, pz, 0.168, 0.080, hh + 0.12, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.175, 0.175);
  cobraArm(mb, px, py, pz, c, s, hh);
}

// Median lighting: one mast, a boom to each carriageway.
export function appendTwinCobraLamp(mb, x, y, z, yaw, h = 11) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 11), 5.0, 18.0);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.12, pz, 0.192, 0.090, hh + 0.12, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.20, 0.20);
  cobraArm(mb, px, py, pz, Math.cos(a), Math.sin(a), hh);
  const b = a + Math.PI;
  cobraArm(mb, px, py, pz, Math.cos(b), Math.sin(b), hh);
}

// Heritage acorn: the St Lawrence / Distillery / Front St fitting. Base plinth, fluted post,
// ladder bar, faceted acorn globe. No yaw — it is radially symmetric by design.
export function appendAcornLamp(mb, x, y, z, h = 4.6) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const hh = clamp(fin(h, 4.6), 2.8, 8.0);
  const shaftTop = py + hh - 0.78;

  setMat(mb, M.poleDark);
  // Cast plinth — about 480 mm across, which is what these actually measure. A fatter one starts
  // to read as a bollard.
  mb.cylinder(px, py - 0.04, pz, 0.240, 0.196, 0.34, 6, 0, false);
  discY(mb, px, py + 0.30, pz, 0.196, 6, 0, true);
  // Fluted post: an 8-gon reads as fluting at any distance a pedestrian sees it from.
  mb.cylinder(px, py + 0.28, pz, 0.136, 0.068, hh - 1.06, 8, Math.PI / 8, false);
  // Ladder bar — a small crossbar, and one of the strongest silhouette cues on these poles.
  beamL(mb, px, shaftTop - 0.30, pz, 1, 0, -0.30, 0, 0, 0.30, 0, 0, 0.026, 0.021, F_ALL);

  // Faceted acorn globe: flare, belly, then the cap taper.
  setMat(mb, M.acornWarm);
  mb.cylinder(px, shaftTop, pz, 0.085, 0.215, 0.20, 6, 0, false);
  mb.cylinder(px, shaftTop + 0.20, pz, 0.215, 0.190, 0.24, 6, 0, false);
  setMat(mb, M.poleDark);
  mb.cylinder(px, shaftTop + 0.44, pz, 0.196, 0.052, 0.28, 6, 0, false);
}

// Pedestrian-scale pole with a short downlight arm, used on sidewalks and in squares.
export function appendPedestrianLamp(mb, x, y, z, yaw, h = 5.2) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 5.2), 2.6, 9.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.04, pz, 0.140, 0.115, 0.30, 6, a, false);
  mb.cylinder(px, py + 0.26, pz, 0.098, 0.062, hh - 0.26, 6, a, false);
  mb.planeY(px, py + hh, pz, 0.14, 0.14);

  _ARM[0] = 0.00; _ARM[1] = hh - 0.06; _ARM[2] = 0.055;
  _ARM[3] = 0.34; _ARM[4] = hh + 0.20; _ARM[5] = 0.050;
  _ARM[6] = 0.66; _ARM[7] = hh + 0.28; _ARM[8] = 0.045;
  sweepL(mb, px, py, pz, c, s, _ARM, 3, 3, false, false);

  const lens = hh + 0.06;
  setL(0, 0.56, lens, -0.160); setL(1, 0.96, lens, -0.108);
  setL(2, 0.56, hh + 0.32, -0.160); setL(3, 0.96, hh + 0.25, -0.108);
  setL(4, 0.56, lens, 0.160); setL(5, 0.96, lens, 0.108);
  setL(6, 0.56, hh + 0.32, 0.160); setL(7, 0.96, hh + 0.25, 0.108);
  setMat(mb, M.lampBody);
  hullL(mb, px, py, pz, c, s, F_NOBOT);
  setMat(mb, M.sodium);
  quadDown(mb, px, py, pz, c, s, 0.60, -0.135, 0.92, 0.135, lens - 0.006);
}

// Streetcar overhead: pole, bracket arm over the track, tie strut and an insulator. The wire
// itself is drawn by city.js between consecutive poles, hanging off this insulator.
export function appendCatenaryPole(mb, x, y, z, yaw, h = 8.2) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 8.2), 5.0, 13.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleDark);
  mb.cylinder(px, py - 0.05, pz, 0.245, 0.205, 0.45, 6, a, false);
  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.40, pz, 0.150, 0.088, hh - 0.40, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.16, 0.16);

  // Bracket arm out over the running rail, with a diagonal tie back to the pole.
  const armY = hh - 0.55;
  beamL(mb, px, py, pz, c, s, 0.10, armY, 0, 1.95, armY + 0.13, 0, 0.055, 0.055,
    F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0.09, armY - 0.82, 0, 1.52, armY + 0.09, 0, 0.038, 0.038,
    F_SIDES);

  // Insulator, hung under the arm end.
  //
  // WIRE ATTACHMENT POINT for city.js, in world metres:
  //     wx = x + 1.86 * cos(yaw)
  //     wy = y + h - 0.85                      (= h - 0.55 armY, - 0.30 insulator drop)
  //     wz = z - 1.86 * sin(yaw)
  // Run the contact wire between consecutive poles' attachment points and it lands on the
  // insulator's underside at both ends.
  setMat(mb, M.castIron);
  const ix = px + 1.86 * c, iz = pz - 1.86 * s;
  mb.cylinder(ix, py + armY - 0.30, iz, 0.052, 0.062, 0.19, 5, a, false);
}

// Signalised intersection: mast arm over the carriageway with two 3-lamp heads hung from it,
// a pedestrian head and a push button on the post.
// The arm reaches along local +X, i.e. world (cos yaw, 0, -sin yaw); the lamp faces look along
// local -Z, i.e. world (-sin yaw, 0, -cos yaw) — the arm direction turned 90 deg counter-clockwise
// in plan, which is where oncoming traffic sits.
export function appendTrafficSignal(mb, x, y, z, yaw, armLen) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(armLen, 7.5), 2.5, 13.0);
  const c = Math.cos(a), s = Math.sin(a);
  const poleTop = 6.40;

  setMat(mb, M.concrete);
  mb.cylinder(px, py - 0.06, pz, 0.300, 0.260, 0.52, 6, a, false);
  setMat(mb, M.poleGrey);
  mb.cylinder(px, py + 0.46, pz, 0.185, 0.125, poleTop - 0.46, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + poleTop, pz, 0.19, 0.19);

  // Mast arm plus its tie strut.
  beamL(mb, px, py, pz, c, s, 0.10, poleTop - 0.10, 0, L, poleTop + 0.34, 0, 0.098, 0.098,
    F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0.10, poleTop - 1.45, 0, L * 0.42, poleTop + 0.08, 0,
    0.052, 0.052, F_SIDES);

  // Two hanging 3-lamp heads. One lamp lit, chosen per intersection so the city is not all red.
  const phase = (hash2(px, pz) * 3) | 0;
  const lit = phase === 0 ? M.sigRed : (phase === 1 ? M.sigGreen : M.sigAmber);
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? 0.44 : 0.82;
    const hx = L * t;
    const armY = poleTop - 0.10 + (poleTop + 0.34 - (poleTop - 0.10)) * t;
    const bt = armY - 0.10;
    const bb = bt - 0.30;
    setMat(mb, M.poleGrey);
    boxL(mb, px, py, pz, c, s, hx - 0.055, bb, -0.055, hx + 0.055, bt, 0.055, F_SIDES);
    // Head body: three lamp bays stacked vertically.
    const top = bb + 0.02;
    const bot = top - 1.02;
    setMat(mb, M.signalBody);
    boxL(mb, px, py, pz, c, s, hx - 0.17, bot, -0.185, hx + 0.17, top, 0.185, F_NOBOT);
    // Lenses on the -Z face; exactly one is a genuine emitter.
    const lz = -0.190;
    for (let k = 0; k < 3; k++) {
      const cy0 = bot + 0.10 + k * 0.31;
      setMat(mb, k === 2 - phase ? lit : M.dark);
      quadNZ(mb, px, py, pz, c, s, lz, hx - 0.115, cy0, hx + 0.115, cy0 + 0.22);
    }
  }

  // Pedestrian head on the post.
  setMat(mb, M.signalBody);
  boxL(mb, px, py, pz, c, s, -0.21, 2.42, -0.36, 0.21, 2.92, -0.14, F_ALL);
  setMat(mb, M.sigHand);
  quadNZ(mb, px, py, pz, c, s, -0.365, -0.17, 2.48, 0.17, 2.86);

  // Push button assembly at hand height.
  setMat(mb, M.poleGrey);
  boxL(mb, px, py, pz, c, s, -0.075, 1.00, -0.30, 0.075, 1.22, -0.16, F_NOBOT);
}

// Cap height of the legend on a street blade, and the margin each end of it. A Toronto blade is
// 200 mm deep with a ~110 mm upper-case legend and a 12 mm blue border; at 0.115 m a name is
// still four pixels of cap height from across the intersection, which is where you read it from.
const BLADE_CAP = 0.115;

const BLADE_MARGIN = 0.13;

const BLADE_MIN = 0.62;

const BLADE_MAX = 1.72;

const BLADE_H = 0.20;

/** How long a blade carrying `name` has to be, in metres. Pure — city.js sizes text to match. */
export function bladeLength(font, name) {
  const w = (font && typeof name === 'string' && name)
    ? textWidth(font, name, BLADE_CAP) : 0.62;
  return clamp(w + BLADE_MARGIN * 2, BLADE_MIN, BLADE_MAX);
}

// One blade: the white plate, its blue border returned round the edge, and the legend.
// `alongZ` true means the blade lies along local Z, so its faces point along local +/-X; false is
// the crossing one. `v0` is the underside of the plate and `half` is half its length.
function blade(mb, px, py, pz, c, s, alongZ, v0, half, name, o) {
  const t = 0.014;
  const brown = !!(o && o.heritage);
  setMat(mb, brown ? M.bladeBrown : M.bladeWhite);
  if (alongZ) boxL(mb, px, py, pz, c, s, -t, v0, -half, t, v0 + BLADE_H, half, F_BLADEX);
  else boxL(mb, px, py, pz, c, s, -half, v0, -t, half, v0 + BLADE_H, t, F_BLADEZ);
  // The border, as two thin ribs proud of the plate rather than a painted margin: geometry reads
  // at every time of day and a colour band on a coplanar face cannot.
  setMat(mb, brown ? M.bladeWhite : M.bladeBlue);
  const b = 0.017;
  for (let k = 0; k < 2; k++) {
    const vy = k === 0 ? v0 + 0.006 : v0 + BLADE_H - 0.006 - b;
    if (alongZ) {
      boxL(mb, px, py, pz, c, s, -t - 0.004, vy, -half, t + 0.004, vy + b, half, F_BLADEX);
    } else {
      boxL(mb, px, py, pz, c, s, -half, vy, -t - 0.004, half, vy + b, t + 0.004, F_BLADEZ);
    }
  }
  if (!o || !o.textMb || !o.font || !name) return;
  // Both faces get the legend, because a blade is read from either side of the street.
  const ux = alongZ ? s : c;                 // world direction of the blade's long axis
  const uz = alongZ ? c : -s;
  const nx = alongZ ? c : s;                 // world direction of its face normal
  const nz = alongZ ? -s : c;
  const cy = py + v0 + BLADE_H * 0.5;
  const face = t + 0.006;
  const col = brown ? [0.235, 0.238, 0.244] : [0.020, 0.036, 0.104];
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? 1 : -1;
    appendText(o.textMb, o.font, name, {
      x: px + nx * face * sg, y: cy, z: pz + nz * face * sg,
      rx: ux * sg, ry: 0, rz: uz * sg,
      nx: nx * sg, ny: 0, nz: nz * sg,
      h: BLADE_CAP, align: ALIGN.CENTER, vAlign: VALIGN.MIDDLE,
      maxWidth: half * 2 - BLADE_MARGIN * 2, minScale: 0.55, lift: 0.004,
      r: col[0], g: col[1], b: col[2], rough: 0.62,
    });
  }
}

/**
 * Street-name blades plus a regulatory plate. rng picks the plate — exactly one draw, whatever
 * else is asked for, so a caller sharing one seeded stream across a tile is unaffected by
 * whether this post happened to be named.
 *
 * opts: { a, b: the two street names (a runs along local Z, b across it), font, textMb, heritage }
 * Omit opts and it is the plain post it always was, sized to a default blade.
 */
export function appendSignPost(mb, rng, x, y, z, yaw, opts) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const o = opts || null;
  const nameA = (o && typeof o.a === 'string') ? o.a : '';
  const nameB = (o && typeof o.b === 'string') ? o.b : '';
  const font = o ? o.font : null;

  setMat(mb, M.galv);
  mb.cylinder(px, py - 0.05, pz, 0.048, 0.042, 3.00, 4, a + Math.PI / 4, false);
  discY(mb, px, py + 2.95, pz, 0.055, 4, a + Math.PI / 4, true);

  // Crossed blades, the way Toronto hangs a street name over each approach.
  blade(mb, px, py, pz, c, s, true, 2.55, bladeLength(font, nameA) * 0.5, nameA, o);
  blade(mb, px, py, pz, c, s, false, 2.28, bladeLength(font, nameB) * 0.5, nameB, o);

  const roll = rnd(rng);
  if (roll < 0.72) {
    setMat(mb, roll < 0.34 ? M.signWhite : M.signRed);
    boxL(mb, px, py, pz, c, s, -0.011, 1.52, -0.21, 0.011, 2.02, 0.21, F_BLADEX);
  }
}

/** A timber utility pole with a crossarm — the OSM man_made=utility_pole class. ~70 verts. */
export function appendUtilityPole(mb, x, y, z, yaw, h) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hh = clamp(fin(h, 9.0), 4.0, 14.0);
  setMat(mb, M.pileTimber);
  mb.cylinder(px, py - 0.10, pz, 0.135, 0.098, hh, 6, a, false);
  discY(mb, px, py + hh - 0.10, pz, 0.098, 6, a, true);
  boxL(mb, px, py, pz, c, s, -0.055, hh - 1.10, -1.05, 0.055, hh - 0.98, 1.05, F_NOBOT);
  setMat(mb, M.glass);
  for (let i = 0; i < 3; i++) {
    const lz = (i - 1) * 0.82;
    boxL(mb, px, py, pz, c, s, -0.05, hh - 0.98, lz - 0.05, 0.05, hh - 0.83, lz + 0.05, F_NOBOT);
  }
  return mb.count - before;
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendCobraLamp,
  appendTwinCobraLamp,
  appendAcornLamp,
  appendPedestrianLamp,
  appendCatenaryPole,
  appendTrafficSignal,
  appendSignPost,
  appendUtilityPole,
});
