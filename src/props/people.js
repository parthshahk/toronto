// src/props/people.js — the crowd: pedestrians standing, walking, leaning and seated, cyclists,
// and dog walkers.
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// The city has 1,612 parked cars and, without this file, nobody standing next to one. People are
// what make a street read as a street. These are seen mostly at 10-60 m and in the hundreds, so
// SILHOUETTE and VARIETY do all the work: nobody resolves a face at 30 m, and everybody notices
// when the crowd is one mannequin cloned four hundred times.
//
// So the geometry is deliberately blunt — flat-sided hulls, no curves, no hands, no features —
// and every knob that changes the READ is rolled per instance from the city's seeded rng:
// stature, build, skin, hair, hat, coat, shirt, trousers or dress, bag, and, for the walking
// poses, the stride phase.
//
// Poses are STATIC GEOMETRY, never animation. 'walk' is one frame of a gait frozen into the mesh:
// the leading leg forward, the OPPOSITE arm forward, the trailing heel lifted off the pavement.
// The phase is drawn from the rng, so consecutive people along a pavement are caught at different
// points of the stride and the row reads as movement rather than as a rank of statues.
//
// Orientation follows the module contract exactly: local +X is the FRONT, so a person built at
// yaw faces world (cos yaw, 0, -sin yaw), and (x, y, z) is the footprint centre at GROUND level —
// the soles land on y, never above or below it.
//
// AMENDMENT 7: a person is NEVER a light source. Every surface in this file is emissive 0,
// tintable 0, profile 0, with albedo and roughness only. No baked shading, no darkened
// undersides, no warm tint "so they read at night". The renderer lights the crowd exactly as it
// lights the pavement, and nothing here knows which of the four times of day is showing.
//
// Vertex cost, measured over 400 seeds: 174 for a standing, walking or leaning person, plus 30
// for a bag or backpack on the 36% that carry one; 210 seated; 294 for a cyclist including the
// bicycle; 366 for a dog walker including the dog and the lead.

import { TAU, clamp } from '../core/math.js';
import {
  EPS, F_ALL, F_NOBOT, F_NY, F_NZ, F_PLATEX, F_PX, F_PZ, F_SIDES, beamL, boxL, discZ, fin,
  finAngle, hullL, pickOf, rnd, rr, setL, setMat,
} from './kit.js';
import { M } from './materials.js';

// Skin. Eight steps across the real range, all the way dark, because a downtown Toronto crowd is
// not eight shades of beige. Values sit in this module's low-key albedo range (a white sign is
// 0.23 here), and the roughness is a physical constant like every other one in the file.
const PED_SKIN = [
  [0.198, 0.143, 0.108, 0, 0, 0.72, 0],
  [0.176, 0.124, 0.091, 0, 0, 0.72, 0],
  [0.152, 0.103, 0.073, 0, 0, 0.72, 0],
  [0.128, 0.085, 0.058, 0, 0, 0.72, 0],
  [0.101, 0.065, 0.043, 0, 0, 0.72, 0],
  [0.074, 0.046, 0.030, 0, 0, 0.72, 0],
  [0.050, 0.030, 0.020, 0, 0, 0.72, 0],
  [0.033, 0.020, 0.014, 0, 0, 0.72, 0],
];

const PED_HAIR = [
  [0.016, 0.014, 0.013, 0, 0, 0.86, 0],   // black
  [0.026, 0.020, 0.017, 0, 0, 0.86, 0],   // near-black
  [0.030, 0.022, 0.016, 0, 0, 0.86, 0],   // dark brown
  [0.052, 0.036, 0.023, 0, 0, 0.86, 0],   // brown
  [0.076, 0.043, 0.021, 0, 0, 0.86, 0],   // auburn
  [0.124, 0.098, 0.052, 0, 0, 0.86, 0],   // fair
  [0.086, 0.086, 0.088, 0, 0, 0.86, 0],   // grey
  [0.164, 0.165, 0.168, 0, 0, 0.86, 0],   // white
];

// Toques, caps and hoods. A hat is drawn as the head volume itself — a colour swap plus a couple
// of centimetres of extra crown — so it costs nothing at all.
const PED_HAT = [
  [0.020, 0.021, 0.024, 0, 0, 0.88, 0],
  [0.028, 0.048, 0.088, 0, 0, 0.88, 0],
  [0.150, 0.036, 0.032, 0, 0, 0.88, 0],
  [0.042, 0.078, 0.052, 0, 0, 0.88, 0],
  [0.112, 0.108, 0.096, 0, 0, 0.88, 0],
  [0.056, 0.058, 0.062, 0, 0, 0.88, 0],
];

// Outerwear. Broader and a little more chromatic than the parked-car palette on purpose: cars
// punching out of the image is a bug, a crowd of grey people is a morgue.
const PED_COAT = [
  [0.022, 0.023, 0.026, 0, 0, 0.86, 0],   // black
  [0.046, 0.047, 0.051, 0, 0, 0.86, 0],   // charcoal
  [0.088, 0.089, 0.093, 0, 0, 0.86, 0],   // mid grey
  [0.026, 0.036, 0.070, 0, 0, 0.86, 0],   // navy
  [0.048, 0.068, 0.104, 0, 0, 0.86, 0],   // denim
  [0.060, 0.066, 0.038, 0, 0, 0.86, 0],   // olive
  [0.030, 0.058, 0.038, 0, 0, 0.86, 0],   // forest
  [0.150, 0.116, 0.070, 0, 0, 0.86, 0],   // camel
  [0.170, 0.156, 0.128, 0, 0, 0.86, 0],   // beige
  [0.205, 0.198, 0.180, 0, 0, 0.86, 0],   // cream
  [0.104, 0.030, 0.038, 0, 0, 0.86, 0],   // burgundy
  [0.215, 0.046, 0.038, 0, 0, 0.86, 0],   // red
  [0.170, 0.078, 0.032, 0, 0, 0.86, 0],   // rust
  [0.190, 0.148, 0.040, 0, 0, 0.86, 0],   // mustard
  [0.030, 0.086, 0.090, 0, 0, 0.86, 0],   // teal
  [0.070, 0.040, 0.098, 0, 0, 0.86, 0],   // purple
  [0.205, 0.116, 0.126, 0, 0, 0.86, 0],   // pink
  [0.072, 0.050, 0.034, 0, 0, 0.86, 0],   // brown
];

// The chest plane is a second garment, not a highlight — see figureTorso().
const PED_SHIRT = [
  [0.222, 0.226, 0.230, 0, 0, 0.88, 0],
  [0.128, 0.156, 0.196, 0, 0, 0.88, 0],
  [0.104, 0.106, 0.110, 0, 0, 0.88, 0],
  [0.026, 0.027, 0.030, 0, 0, 0.88, 0],
  [0.190, 0.048, 0.042, 0, 0, 0.88, 0],
  [0.048, 0.104, 0.062, 0, 0, 0.88, 0],
  [0.205, 0.180, 0.058, 0, 0, 0.88, 0],
  [0.210, 0.104, 0.034, 0, 0, 0.88, 0],
  [0.034, 0.044, 0.078, 0, 0, 0.88, 0],
  [0.128, 0.110, 0.170, 0, 0, 0.88, 0],
  [0.040, 0.110, 0.112, 0, 0, 0.88, 0],
  [0.212, 0.130, 0.140, 0, 0, 0.88, 0],
];

const PED_TROUSER = [
  [0.042, 0.056, 0.086, 0, 0, 0.90, 0],   // indigo denim
  [0.078, 0.096, 0.128, 0, 0, 0.90, 0],   // washed denim
  [0.024, 0.025, 0.028, 0, 0, 0.90, 0],   // black
  [0.050, 0.051, 0.055, 0, 0, 0.90, 0],   // charcoal
  [0.092, 0.093, 0.097, 0, 0, 0.90, 0],   // grey
  [0.134, 0.118, 0.082, 0, 0, 0.90, 0],   // khaki
  [0.156, 0.150, 0.134, 0, 0, 0.90, 0],   // stone
  [0.058, 0.062, 0.038, 0, 0, 0.90, 0],   // olive
  [0.066, 0.048, 0.032, 0, 0, 0.90, 0],   // brown
  [0.030, 0.038, 0.062, 0, 0, 0.90, 0],   // navy
];

// Dresses and skirts. Used as the whole torso hull, which flares below the waist, with bare legs
// under it — so the garment colour has to stand on its own rather than sit under a coat.
const PED_SKIRT = [
  [0.024, 0.025, 0.029, 0, 0, 0.88, 0],
  [0.032, 0.040, 0.074, 0, 0, 0.88, 0],
  [0.180, 0.042, 0.048, 0, 0, 0.88, 0],
  [0.052, 0.096, 0.066, 0, 0, 0.88, 0],
  [0.150, 0.132, 0.100, 0, 0, 0.88, 0],
  [0.108, 0.070, 0.130, 0, 0, 0.88, 0],
  [0.196, 0.176, 0.088, 0, 0, 0.88, 0],
  [0.086, 0.088, 0.092, 0, 0, 0.88, 0],
];

const PED_BAG = [
  [0.020, 0.021, 0.023, 0, 0, 0.80, 0],
  [0.062, 0.042, 0.026, 0, 0, 0.80, 0],
  [0.028, 0.036, 0.062, 0, 0, 0.80, 0],
  [0.070, 0.074, 0.048, 0, 0, 0.80, 0],
  [0.148, 0.038, 0.034, 0, 0, 0.80, 0],
  [0.088, 0.090, 0.094, 0, 0, 0.80, 0],
];

// Helmet shells are painted plastic: same rules, just smoother than wool.
const PED_HELMET = [
  [0.205, 0.208, 0.214, 0, 0, 0.34, 0],
  [0.026, 0.027, 0.030, 0, 0, 0.34, 0],
  [0.200, 0.048, 0.038, 0, 0, 0.34, 0],
  [0.036, 0.058, 0.120, 0, 0, 0.34, 0],
  [0.150, 0.180, 0.048, 0, 0, 0.34, 0],
];

const BIKE_FRAME = [
  [0.024, 0.025, 0.028, 0, 0, 0.32, 0],
  [0.130, 0.133, 0.138, 0, 0, 0.26, 0],
  [0.160, 0.040, 0.036, 0, 0, 0.30, 0],
  [0.030, 0.052, 0.100, 0, 0, 0.30, 0],
  [0.046, 0.096, 0.078, 0, 0, 0.30, 0],
  [0.170, 0.140, 0.048, 0, 0, 0.30, 0],
];

const DOG_COAT = [
  [0.026, 0.024, 0.022, 0, 0, 0.92, 0],   // black
  [0.058, 0.040, 0.026, 0, 0, 0.92, 0],   // brown
  [0.128, 0.092, 0.048, 0, 0, 0.92, 0],   // golden
  [0.178, 0.170, 0.152, 0, 0, 0.92, 0],   // cream
  [0.092, 0.090, 0.086, 0, 0, 0.92, 0],   // grey
  [0.070, 0.054, 0.040, 0, 0, 0.92, 0],   // brindle
];

// One person's whole appearance and pose, in module scratch. Nothing here allocates: the four
// public builders roll into this object and the private body routines read it back.
//
// Heights are fractions of the figure's own stature `h`, so a 1.55 m person is a small adult and
// not a scaled-down giant. hipY/hemY/shY are absolute local metres once a pose has been chosen.
const _F = {
  h: 1.75, bw: 1.0, flare: 1.0, hatted: false,
  skin: PED_SKIN[0], hair: PED_HAIR[0], coat: PED_COAT[0], chest: PED_SHIRT[0],
  leg: PED_TROUSER[0], acc: null, accBack: false, accSide: 1, hemF: 0.46,
  hipX: 0, hipY: 0.9625, hemY: 0.805, shY: 1.4315,
  lean: 0, swing: 0, reach: 0, handY: 0.8225,
};

// Roll one person. `allowBag` false is for riders and dog walkers, whose hands are busy.
function rollFigure(rng, allowBag) {
  _F.h = rr(rng, 1.55, 1.95);
  _F.bw = rr(rng, 0.88, 1.16);
  _F.skin = pickOf(rng, PED_SKIN);
  _F.hatted = rnd(rng) < 0.26;
  _F.hair = _F.hatted ? pickOf(rng, PED_HAT) : pickOf(rng, PED_HAIR);
  const dress = rnd(rng) < 0.17;
  _F.flare = dress ? rr(rng, 1.10, 1.36) : 1.0;
  _F.coat = dress ? pickOf(rng, PED_SKIRT) : pickOf(rng, PED_COAT);
  _F.chest = pickOf(rng, PED_SHIRT);
  _F.leg = dress ? _F.skin : pickOf(rng, PED_TROUSER);
  _F.hemF = dress ? rr(rng, 0.34, 0.46) : rr(rng, 0.38, 0.52);
  const roll = rnd(rng);
  const wants = allowBag !== false;
  _F.accBack = wants && roll < 0.17;
  _F.acc = (wants && roll < 0.36) ? pickOf(rng, PED_BAG) : null;
  _F.accSide = rnd(rng) < 0.5 ? 1 : -1;
}

// The body leans as a shear about the hips: nothing below the hip moves, the shoulders move by
// `lean`, and the head extrapolates past them. Every part that hangs off the spine places itself
// through this, so a leaning figure stays assembled. The divide is guarded: a pose that collapses
// shY onto hipY would otherwise send the whole upper body to infinity.
function shearAt(y) {
  const d = _F.shY - _F.hipY;
  return _F.hipX + _F.lean * ((y - _F.hipY) / (Math.abs(d) > EPS ? d : 1));
}

// Torso, arms and head: 36 + 60 + 30 = 126 verts.
//
// The coat is five faces of one hull and the chest is the sixth, drawn in a second garment
// colour. That is the front cue the eye needs at 30 m, and because the two passes are different
// FACES of the same hull rather than an overlay, there is no plane to z-fight. The head repeats
// the trick: hair (or hat) on four faces, a skin face on +X.
//
// The torso is CLOSED, all six faces, and the sleeves are closed at the wrist. Those eighteen
// verts are not decoration: a coat hem sits at 0.7-1.0 m and a cuff at 0.8 m, and both are reachable
// from a low fly camera, which with back-face culling would look straight through the figure. The
// head's neck and the sleeve and leg tops need no such face — they are buried inside the closed
// torso — and the soles need none either, because they lie on the pavement mesh.
function figureTorso(mb, px, py, pz, c, s) {
  const H = _F.h, bw = _F.bw;
  const shZ = 0.118 * H * bw, shX = 0.062 * H * bw;
  const hpZ = 0.098 * H * bw * _F.flare, hpX = 0.058 * H * bw * _F.flare;
  const bx = shearAt(_F.hemY), tx = shearAt(_F.shY);

  setL(0, bx - hpX, _F.hemY, -hpZ); setL(1, bx + hpX, _F.hemY, -hpZ);
  setL(2, tx - shX, _F.shY, -shZ);  setL(3, tx + shX, _F.shY, -shZ);
  setL(4, bx - hpX, _F.hemY, hpZ);  setL(5, bx + hpX, _F.hemY, hpZ);
  setL(6, tx - shX, _F.shY, shZ);   setL(7, tx + shX, _F.shY, shZ);
  setMat(mb, _F.coat);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PX);
  setMat(mb, _F.chest);
  hullL(mb, px, py, pz, c, s, F_PX);

  // Arms. The shoulder end is tucked wholly inside the torso — narrower in Z than the shoulder
  // and 2 cm below its top — so the open top of each sleeve can never be seen from above, and
  // the sleeve splays outboard as it drops, which is how a coat actually hangs. The splay is
  // measured, not guessed: the hand ends up 0.26 m off the midline, putting a 1.75 m figure at
  // 0.52 m across the arms against a real adult's 0.50-0.55.
  const aY = _F.shY - 0.020 * H;
  const ax = shearAt(aY);
  const aw = 0.046 * H * bw;
  const hx = tx + _F.reach;
  setMat(mb, _F.coat);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const hxs = hx + sg * _F.swing;
    const z0 = sg > 0 ? shZ * 0.44 : -shZ * 0.96;
    const z1 = sg > 0 ? shZ * 0.96 : -shZ * 0.44;
    const w0 = sg > 0 ? shZ * 0.80 : -shZ * 1.24;
    const w1 = sg > 0 ? shZ * 1.24 : -shZ * 0.80;
    setL(0, hxs - aw * 0.84, _F.handY, w0); setL(1, hxs + aw * 0.84, _F.handY, w0);
    setL(2, ax - aw, aY, z0);               setL(3, ax + aw, aY, z0);
    setL(4, hxs - aw * 0.84, _F.handY, w1); setL(5, hxs + aw * 0.84, _F.handY, w1);
    setL(6, ax - aw, aY, z1);               setL(7, ax + aw, aY, z1);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_NY);
  }

  // Head. The bottom of the hull is the neck and sits BELOW the top of the torso, so there is
  // never a gap at the collar and the open underside is buried. A hat is the same hull, two
  // centimetres taller and a little wider, in a hat colour — free.
  const nbY = _F.shY - 0.030 * H;
  const crY = _F.shY + (_F.hatted ? 0.196 : 0.182) * H;
  const nX = 0.034 * H, nZ = 0.036 * H;
  const kX = (_F.hatted ? 0.056 : 0.052) * H, kZ = (_F.hatted ? 0.049 : 0.045) * H;
  const nx = shearAt(nbY), cx = shearAt(crY);
  setL(0, nx - nX, nbY, -nZ); setL(1, nx + nX, nbY, -nZ);
  setL(2, cx - kX, crY, -kZ); setL(3, cx + kX, crY, -kZ);
  setL(4, nx - nX, nbY, nZ);  setL(5, nx + nX, nbY, nZ);
  setL(6, cx - kX, crY, kZ);  setL(7, cx + kX, crY, kZ);
  setMat(mb, _F.hair);
  hullL(mb, px, py, pz, c, s, F_NOBOT & ~F_PX);
  setMat(mb, _F.skin);
  hullL(mb, px, py, pz, c, s, F_PX);
}

// Standing/walking legs, 48 verts. Each leg is one hull from the hip down to the sole, and the
// sole rectangle is longer in X than the thigh, which puts a foot on the end of the leg for
// nothing. `stride` splits the pair fore and aft, `ahead` shifts both feet forward (a figure
// leaning back on a wall), `cross` pulls them toward the midline.
//
// BOTH SOLES STAY FLAT ON THE GROUND. The obvious way to draw a toe-off is to lift the trailing
// heel, and it is wrong: a 5 cm heel lift is a third of a pixel of gait at 30 m, but it opens a
// 5 x 12 cm slot under the foot that the pavement no longer covers, and at 10 m, from behind, that
// is a couple of hundred pixels of daylight straight through the figure. The trailing foot instead
// stretches its toe and pulls in its heel, which is what toe-off actually looks like in profile,
// costs nothing, and keeps the sole exactly on the ground where the pavement seals it.
function figureLegs(mb, px, py, pz, c, s, stride, ahead, cross) {
  const H = _F.h, bw = _F.bw;
  const lz = 0.050 * H * bw, lw = 0.040 * H * bw;
  const tx = 0.048 * H * bw;
  const fw = 0.034 * H * bw;
  const roll = Math.min(1, Math.abs(stride) / (0.10 * H));
  setMat(mb, _F.leg);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const back = sg * stride < 0 ? roll : 0;
    const heel = (0.058 - 0.026 * back) * H;
    const toe = (0.092 + 0.030 * back) * H;
    const fx = ahead + sg * stride;
    const fz = sg * (lz - cross);
    const hz = sg * lz;
    setL(0, fx - heel, 0, fz - fw); setL(1, fx + toe, 0, fz - fw);
    setL(2, _F.hipX - tx, _F.hipY, hz - lw); setL(3, _F.hipX + tx, _F.hipY, hz - lw);
    setL(4, fx - heel, 0, fz + fw); setL(5, fx + toe, 0, fz + fw);
    setL(6, _F.hipX - tx, _F.hipY, hz + lw); setL(7, _F.hipX + tx, _F.hipY, hz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
}

// Seated legs: one lap block plus two shins, 84 verts. Two separate thighs would cost 24 more and
// read identically at 10 m, which is as close as anyone ever gets to a bench.
function figureSeatLegs(mb, px, py, pz, c, s, ph) {
  const H = _F.h, bw = _F.bw;
  const seatY = _F.hipY;
  const th = 0.118 * H;
  const kx = _F.hipX + 0.245 * H;
  const lz = 0.050 * H * bw, lw = 0.040 * H * bw;
  setMat(mb, _F.leg);
  boxL(mb, px, py, pz, c, s,
    _F.hipX - 0.062 * H, seatY - th, -0.105 * H * bw,
    kx, seatY, 0.105 * H * bw, F_ALL);
  const fx = kx + 0.020 * H + 0.030 * H * ph;
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const cz = sg * lz;
    const fo = sg * 0.018 * H * ph;
    const ky = seatY - th * 0.45;
    setL(0, fx - 0.058 * H + fo, 0, cz - lw * 0.88);
    setL(1, fx + 0.090 * H + fo, 0, cz - lw * 0.88);
    setL(2, kx - 0.092 * H, ky, cz - lw);
    setL(3, kx - 0.006 * H, ky, cz - lw);
    setL(4, fx - 0.058 * H + fo, 0, cz + lw * 0.88);
    setL(5, fx + 0.090 * H + fo, 0, cz + lw * 0.88);
    setL(6, kx - 0.092 * H, ky, cz + lw);
    setL(7, kx - 0.006 * H, ky, cz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
}

// Bag or backpack, 30 verts either way. Both bury one face in the coat and close the other five:
// the backpack its front, the shoulder bag its inboard side. The bag is carried high, above the
// highest possible hem and well inside the torso's plan, so the buried face stays buried for every
// build, every hem length and every stride — an arm swings, a torso does not.
function figureAccessory(mb, px, py, pz, c, s) {
  if (!_F.acc) return;
  const H = _F.h, bw = _F.bw;
  setMat(mb, _F.acc);
  if (_F.accBack) {
    const y0 = _F.hipY + 0.055 * H, y1 = _F.shY - 0.035 * H;
    const b0 = shearAt(y0) - 0.050 * H * bw, b1 = shearAt(y1) - 0.050 * H * bw;
    const d = 0.082 * H, w = 0.080 * H * bw;
    setL(0, b0 - d * 0.88, y0, -w * 0.88); setL(1, b0, y0, -w * 0.88);
    setL(2, b1 - d, y1, -w);               setL(3, b1, y1, -w);
    setL(4, b0 - d * 0.88, y0, w * 0.88);  setL(5, b0, y0, w * 0.88);
    setL(6, b1 - d, y1, w);                setL(7, b1, y1, w);
    hullL(mb, px, py, pz, c, s, F_ALL & ~F_PX);
  } else {
    const sg = _F.accSide;
    const y0 = _F.hipY - 0.020 * H, y1 = _F.hipY + 0.145 * H;
    const b0 = shearAt(y0), b1 = shearAt(y1);
    const zi = 0.080 * H * bw, zo = 0.165 * H * bw;
    const z0 = sg > 0 ? zi : -zo;
    const z1 = sg > 0 ? zo : -zi;
    setL(0, b0 - 0.044 * H, y0, z0); setL(1, b0 + 0.044 * H, y0, z0);
    setL(2, b1 - 0.046 * H, y1, z0); setL(3, b1 + 0.046 * H, y1, z0);
    setL(4, b0 - 0.044 * H, y0, z1); setL(5, b0 + 0.044 * H, y0, z1);
    setL(6, b1 - 0.046 * H, y1, z1); setL(7, b1 + 0.046 * H, y1, z1);
    hullL(mb, px, py, pz, c, s, F_ALL & ~(sg > 0 ? F_NZ : F_PZ));
  }
}

// An upright figure in one of the four standing poses. `ph` is the gait phase in [-1, 1]: at +1
// the +Z leg is fully forward, at -1 fully back, and near 0 the figure is caught mid-stance.
function uprightFigure(mb, px, py, pz, c, s, pose, ph) {
  const H = _F.h;
  let stride, swing, lean, ahead, cross;
  if (pose === 'walk') {
    stride = 0.150 * H * ph; swing = -0.115 * H * ph;
    lean = 0.014 * H; ahead = 0; cross = 0;
  } else if (pose === 'walkFast') {
    stride = 0.225 * H * ph; swing = -0.185 * H * ph;
    lean = 0.034 * H; ahead = 0.010 * H; cross = 0;
  } else if (pose === 'lean') {
    stride = 0.030 * H * ph; swing = 0.014 * H;
    lean = -0.052 * H; ahead = 0.105 * H; cross = 0.030 * H;
  } else {
    stride = 0.022 * H * ph; swing = 0.012 * H * ph;
    lean = 0; ahead = 0; cross = 0;
  }
  _F.hipX = 0;
  _F.hipY = 0.550 * H;
  _F.hemY = _F.hemF * H;
  _F.shY = 0.818 * H;
  _F.lean = lean;
  _F.swing = swing;
  _F.reach = 0;
  _F.handY = 0.470 * H;
  figureLegs(mb, px, py, pz, c, s, stride, ahead, cross);
  figureTorso(mb, px, py, pz, c, s);
  figureAccessory(mb, px, py, pz, c, s);
}

// One person. `pose` is 'stand' | 'walk' | 'walkFast' | 'sit' | 'lean'; anything else stands.
// 174 verts upright plus 30 for a bag, 210 seated.
export function appendPedestrian(mb, rng, x, y, z, yaw, pose) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  rollFigure(rng, pose !== 'sit');
  const ph = rr(rng, -1, 1);

  if (pose === 'sit') {
    const H = _F.h;
    _F.hipX = -0.175 * H;
    _F.hipY = 0.255 * H;
    _F.hemY = _F.hipY - 0.005 * H;
    _F.shY = _F.hipY + 0.352 * H;
    _F.lean = 0.030 * H;
    _F.swing = 0.012 * H * ph;
    _F.reach = 0.150 * H;
    _F.handY = _F.hipY + 0.045 * H;
    figureSeatLegs(mb, px, py, pz, c, s, ph);
    figureTorso(mb, px, py, pz, c, s);
    return;
  }

  const p = (pose === 'walk' || pose === 'walkFast' || pose === 'lean') ? pose : 'stand';
  uprightFigure(mb, px, py, pz, c, s, p, ph);
}

// Two to four people loosely clustered on one spot: a knot outside a bar, a family at a corner,
// colleagues waiting for a light. Roughly half the groups are walking together and face the same
// way; the rest are standing and turned in toward each other, which is what makes a knot of
// people read as a conversation instead of a queue.
export function appendPedestrianGroup(mb, rng, x, y, z, yaw, n) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const k = clamp(Math.round(fin(n, 3)), 2, 4);
  const moving = rnd(rng) < 0.55;
  const base = (rnd(rng) * TAU) - Math.PI;

  for (let i = 0; i < k; i++) {
    const ang = base + (i / k) * TAU + rr(rng, -0.42, 0.42);
    const rad = rr(rng, 0.40, 0.95);
    const ox = Math.cos(ang) * rad, oz = Math.sin(ang) * rad;
    // Local offset -> world, using the same rotation every other piece in this module uses.
    const wx = px + ox * c + oz * s;
    const wz = pz - ox * s + oz * c;
    // Facing the group centre means pointing along (-ox, -oz), i.e. local yaw atan2(oz, -ox).
    const face = moving ? rr(rng, -0.26, 0.26) : Math.atan2(oz, -ox) + rr(rng, -0.30, 0.30);
    let pose;
    if (moving) pose = rnd(rng) < 0.24 ? 'walkFast' : 'walk';
    else pose = rnd(rng) < 0.14 ? 'lean' : 'stand';
    appendPedestrian(mb, rng, wx, py, wz, a + face, pose);
  }
}

// A cyclist and the bicycle under them, 294 verts. Local +X is the direction of travel, so a
// caller places one exactly like a car: yaw = Math.atan2(-dz, dx) for a lane running (dx, dz).
//
// The bike is drawn in units of the rider's own stature (bs = h / 1.75) so a small rider is not
// perched on a full-size frame. Wheels are filled discs at six segments, matching the parked-car
// wheels they will be seen next to.
//
// The frame is three tubes — fork, down tube, seat stay — plus the bar, each a two-sided card
// with no thickness across the bike. A real 3 cm tube is a third of a pixel at 20 m, and giving
// it thickness with only its two side faces drawn would leave the ends open: a bicycle seen
// head-on would show the inside of its own frame. Zero thickness cannot. The top tube and the
// chain stay are deliberately absent — the rider's legs and torso fill the first, the rear wheel
// covers the second — and the saddle is absent too, because the rider's hips are already there.
export function appendCyclist(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  rollFigure(rng, false);
  const H = _F.h;
  const bs = H / 1.75;
  if (rnd(rng) < 0.62) { _F.hair = pickOf(rng, PED_HELMET); _F.hatted = true; }

  const R = 0.335 * bs;
  const rear = -0.535 * bs, front = 0.535 * bs;
  const bbx = -0.065 * bs, bby = 0.268 * bs;
  const sadx = -0.395 * bs, sady = 0.875 * bs;
  const barx = 0.415 * bs, bary = 0.985 * bs;

  setMat(mb, M.tyre);
  discZ(mb, px, py, pz, c, s, 0, rear, R, R, 6);
  discZ(mb, px, py, pz, c, s, 0, front, R, R, 6);

  setMat(mb, pickOf(rng, BIKE_FRAME));
  beamL(mb, px, py, pz, c, s, front, R, 0, 0.445 * bs, 0.955 * bs, 0,
    0, 0.021 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, bbx, bby, 0, 0.455 * bs, 0.800 * bs, 0,
    0, 0.023 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, rear, R, 0, sadx, sady - 0.030 * bs, 0,
    0, 0.020 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, barx, bary, -0.215 * bs, barx, bary, 0.215 * bs,
    0, 0.017 * bs, F_PLATEX);

  // Rider. The hips sit on the saddle at 0.50 of stature, which is where a saddle belongs, and
  // the torso shears forward to put the hands on the bars.
  _F.hipX = sadx;
  _F.hipY = 0.500 * H;
  _F.hemY = _F.hipY - 0.030 * H;
  _F.shY = _F.hipY + 0.320 * H;
  _F.lean = 0.240 * H;
  _F.swing = 0;
  _F.reach = barx - (_F.hipX + _F.lean);
  _F.handY = bary;

  // Legs: hip to pedal, one hull each, cranks horizontal. The two come out at noticeably
  // different lengths and the pair reads as one leg straight and one folded.
  const crank = 0.170 * bs;
  setMat(mb, _F.leg);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const fx = bbx + sg * crank;
    const pzl = sg * 0.082 * bs;
    const hz = sg * 0.050 * H * _F.bw;
    const lw = 0.040 * H * _F.bw, fw = 0.034 * H * _F.bw, tw = 0.048 * H * _F.bw;
    setL(0, fx - 0.055 * H, bby, pzl - fw); setL(1, fx + 0.085 * H, bby, pzl - fw);
    setL(2, _F.hipX - tw, _F.hipY, hz - lw); setL(3, _F.hipX + tw, _F.hipY, hz - lw);
    setL(4, fx - 0.055 * H, bby, pzl + fw); setL(5, fx + 0.085 * H, bby, pzl + fw);
    setL(6, _F.hipX - tw, _F.hipY, hz + lw); setL(7, _F.hipX + tw, _F.hipY, hz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
  figureTorso(mb, px, py, pz, c, s);
}

// A dog on a lead. Local +X is the muzzle, (x, y, z) is on the pavement. 180 verts. The barrel
// and the head are closed volumes: a dog's belly is only half a metre up and its underside is an
// ordinary thing to see from a low camera or across a kerb.
function dogFigure(mb, rng, px, py, pz, a, sc) {
  const c = Math.cos(a), s = Math.sin(a);
  const gait = rr(rng, -1, 1);
  setMat(mb, pickOf(rng, DOG_COAT));

  // Barrel: deeper at the shoulder than at the loin, which is the whole silhouette of a dog.
  setL(0, -0.340 * sc, 0.285 * sc, -0.100 * sc); setL(1, 0.200 * sc, 0.265 * sc, -0.108 * sc);
  setL(2, -0.340 * sc, 0.500 * sc, -0.092 * sc); setL(3, 0.200 * sc, 0.545 * sc, -0.108 * sc);
  setL(4, -0.340 * sc, 0.285 * sc, 0.100 * sc);  setL(5, 0.200 * sc, 0.265 * sc, 0.108 * sc);
  setL(6, -0.340 * sc, 0.500 * sc, 0.092 * sc);  setL(7, 0.200 * sc, 0.545 * sc, 0.108 * sc);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Neck and head as one wedge, rooted inside the chest.
  setL(0, 0.160 * sc, 0.430 * sc, -0.070 * sc); setL(1, 0.470 * sc, 0.455 * sc, -0.055 * sc);
  setL(2, 0.160 * sc, 0.665 * sc, -0.076 * sc); setL(3, 0.470 * sc, 0.600 * sc, -0.058 * sc);
  setL(4, 0.160 * sc, 0.430 * sc, 0.070 * sc);  setL(5, 0.470 * sc, 0.455 * sc, 0.055 * sc);
  setL(6, 0.160 * sc, 0.665 * sc, 0.076 * sc);  setL(7, 0.470 * sc, 0.600 * sc, 0.058 * sc);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Four legs, diagonal pairs offset so the animal is trotting rather than standing to attention.
  for (let i = 0; i < 4; i++) {
    const fr = (i & 2) === 0;
    const sg = (i & 1) ? 1 : -1;
    const bx = fr ? 0.145 * sc : -0.255 * sc;
    const sw = (fr ? 1 : -1) * sg * 0.055 * sc * gait;
    boxL(mb, px, py, pz, c, s,
      bx + sw - 0.030 * sc, 0, sg * 0.062 * sc - 0.024 * sc,
      bx + sw + 0.030 * sc, 0.320 * sc, sg * 0.062 * sc + 0.024 * sc, F_SIDES);
  }

  beamL(mb, px, py, pz, c, s, -0.330 * sc, 0.495 * sc, 0, -0.500 * sc, 0.660 * sc, 0,
    0, 0.019 * sc, F_PLATEX);
}

// Somebody walking a dog: 366 verts all in. The lead is a real member from the walker's hand to
// the dog's collar, which is what makes the pair read as one prop instead of two.
export function appendDogWalker(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const side = rnd(rng) < 0.5 ? 1 : -1;

  rollFigure(rng, false);
  const ph = rr(rng, -1, 1);
  uprightFigure(mb, px, py, pz, c, s, rnd(rng) < 0.78 ? 'walk' : 'stand', ph);

  const H = _F.h;
  const sc = rr(rng, 0.72, 1.18);
  const dx = rr(rng, 0.68, 1.05);
  const dz = side * rr(rng, 0.42, 0.78);
  const dyaw = rr(rng, -0.35, 0.35) - side * 0.16;

  dogFigure(mb, rng, px + dx * c + dz * s, py, pz - dx * s + dz * c, a + dyaw, sc);

  // Lead: the walker's hand on the dog's side, to the collar at the top of the dog's neck. The
  // dog's own yaw offset is applied in the walker's local frame so both ends land on real
  // geometry however the dog is angled.
  const shZ = 0.118 * H * _F.bw;
  const hx = shearAt(_F.shY) + side * _F.swing;
  const hz = side * shZ * 1.02;
  const cx = dx + 0.300 * sc * Math.cos(dyaw);
  const cz = dz - 0.300 * sc * Math.sin(dyaw);
  setMat(mb, M.dark);
  beamL(mb, px, py, pz, c, s, hx, _F.handY - 0.010 * H, hz, cx, 0.640 * sc, cz,
    0, 0.010, F_PLATEX);
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendPedestrian,
  appendPedestrianGroup,
  appendCyclist,
  appendDogWalker,
});
