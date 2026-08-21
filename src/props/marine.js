// src/props/marine.js — everything on or at the water: pleasure craft, the island ferries, ferry
// docks and slipways, and the hardware bolted to an engineered edge.
//
// CONTRACT.md §6.1 and §8.3. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// The quay wall is the land/water boundary, so the quay hardware here is bolted to a coping stone,
// driven into the lake bed, or floating on it. (x, y, z) is the footprint centre at the level the
// piece STANDS on — coping top for quay hardware, water level for anything afloat — local +X is
// out over the water, and long pieces run along local Z.
//
// Amendment 7: only genuine light sources are emitters. The lifebuoy-station lamp, the navigation
// lights and the lighthouse lantern are real lamps and carry emissive >= EMITTER_MIN; the ring,
// the daymarks and the buoys are painted steel and plastic and carry exactly zero.

import { TAU, clamp } from '../core/math.js';
import {
  F_ALL, F_BLADEX, F_NOBOT, F_NX, F_NZ, F_PX, F_PY, F_PZ, F_SIDES, beamL, boxL, discY, fin,
  finAngle, hash2, hullL, pickOf, quadDown, quadNX, quadNZ, quadPX, quadPZ, quadUp, ringXY, rnd,
  rr, setL, setMat, torusY,
} from './kit.js';
import { BOAT_HULLS, M } from './materials.js';

// Pleasure craft moored at a Harbourfront quay. Origin is the hull centre AT THE WATERLINE, the
// hull length running along local Z with the bow at +Z. `len` is the overall length.
export function appendBoat(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 9.0), 3.5, 42.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;
  const bw = L * 0.155;
  const fb = L * 0.075;
  const draft = L * 0.045;

  // Hull, then its deck as the same corners in a different material.
  setL(0, -bw * 0.72, -draft, -hl); setL(1, bw * 0.72, -draft, -hl);
  setL(2, -bw, fb, -hl); setL(3, bw, fb, -hl);
  setL(4, -bw * 0.20, -draft * 0.72, hl); setL(5, bw * 0.20, -draft * 0.72, hl);
  setL(6, -bw * 0.34, fb + L * 0.022, hl); setL(7, bw * 0.34, fb + L * 0.022, hl);
  setMat(mb, pickOf(rng, BOAT_HULLS));
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setMat(mb, M.timber);
  hullL(mb, px, py, pz, c, s, F_PY);

  // Cockpit well, recessed into the deck.
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -bw * 0.62, -hl * 0.86, bw * 0.62, -hl * 0.18, fb - 0.03);

  // Deckhouse: vertical sides so the side glazing sits flush, raked ends fore and aft. The
  // windscreen is the hull's own +Z face in glass, not a decal.
  const xw = bw * 0.70;
  const cz0 = -hl * 0.14, cz1 = hl * 0.62;
  const ch = fb + L * 0.085;
  const rakeA = L * 0.020, rakeF = L * 0.095;
  setL(0, -xw, fb, cz0); setL(1, xw, fb, cz0);
  setL(2, -xw, ch, cz0 + rakeA); setL(3, xw, ch, cz0 + rakeA);
  setL(4, -xw, fb, cz1); setL(5, xw, fb, cz1);
  setL(6, -xw, ch, cz1 - rakeF); setL(7, xw, ch, cz1 - rakeF);
  setMat(mb, M.hullWhite);
  hullL(mb, px, py, pz, c, s, F_PX | F_NX | F_PY | F_NZ);
  setMat(mb, M.carGlass);
  hullL(mb, px, py, pz, c, s, F_PZ);
  quadPX(mb, px, py, pz, c, s, xw + 0.006,
    fb + L * 0.020, cz0 + L * 0.05, ch - L * 0.014, cz1 - rakeF - L * 0.02);
  quadNX(mb, px, py, pz, c, s, -xw - 0.006,
    fb + L * 0.020, cz0 + L * 0.05, ch - L * 0.014, cz1 - rakeF - L * 0.02);

  // Guard rails along the sheer.
  setMat(mb, M.chrome);
  for (let i = 0; i < 2; i++) {
    const sx = (i === 0 ? -1 : 1) * bw * 0.92;
    boxL(mb, px, py, pz, c, s, sx - 0.028, fb + L * 0.055, -hl * 0.94,
      sx + 0.028, fb + L * 0.055 + 0.056, hl * 0.80, F_BLADEX);
  }

  // Some carry a mast; the rest get a short radar post.
  setMat(mb, M.galvPale);
  if (rnd(rng) < 0.42) {
    const mz = cz1 * 0.20;
    mb.cylinder(px + mz * s, py + ch, pz + mz * c, L * 0.020, L * 0.011, L * 0.72, 4, a, false);
    beamL(mb, px, py, pz, c, s, 0, ch + L * 0.10, mz, 0, ch + L * 0.16, mz - L * 0.34,
      0.040, 0.040, F_BLADEX);
  } else {
    const mz = cz1 * 0.35;
    mb.cylinder(px + mz * s, py + ch, pz + mz * c, L * 0.016, L * 0.010, L * 0.13, 4, a, false);
  }
}

// Ferry / tour-boat dock: timber deck on driven piles, a rub rail on the outboard side, a
// handrail on the landward side and a hinged apron. `w` is the width (along local X), `len` the
// length (along local Z). Tile several of these along a long quay rather than stretching one.
export function appendFerryDock(mb, x, y, z, yaw, w, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6.0), 2.0, 26.0);
  const L = clamp(fin(len, 18.0), 4.0, 64.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hl = L * 0.5;

  setMat(mb, M.timber);
  boxL(mb, px, py, pz, c, s, -hw, -0.34, -hl, hw, 0.0, hl, F_NOBOT);

  // Driven piles, standing proud of the deck the way they do on the real quays.
  setMat(mb, M.bark);
  const np = (clamp(Math.round(L / 10), 1, 3)) | 0;
  for (let i = 0; i < np; i++) {
    const lz = L * ((i + 0.5) / np - 0.5) * 0.92;
    for (let k = 0; k < 2; k++) {
      const cx = (k === 0 ? -1 : 1) * (hw - 0.18);
      boxL(mb, px, py, pz, c, s, cx - 0.16, -1.90, lz - 0.16, cx + 0.16, 0.92, lz + 0.16,
        F_NOBOT);
    }
  }

  // Rub rail outboard, handrail landward.
  setMat(mb, M.tyre);
  boxL(mb, px, py, pz, c, s, hw - 0.02, -0.30, -hl, hw + 0.16, -0.02, hl, F_BLADEX);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -hw + 0.06, 0.96, -hl, -hw + 0.16, 1.04, hl, F_BLADEX);

  // Hinged apron out to the berth.
  setMat(mb, M.grateIron);
  setL(0, hw, 0.0, -hl * 0.34); setL(1, hw + W * 0.28, -0.22, -hl * 0.34);
  setL(2, hw, 0.07, -hl * 0.34); setL(3, hw + W * 0.28, -0.15, -hl * 0.34);
  setL(4, hw, 0.0, hl * 0.34); setL(5, hw + W * 0.28, -0.22, hl * 0.34);
  setL(6, hw, 0.07, hl * 0.34); setL(7, hw + W * 0.28, -0.15, hl * 0.34);
  hullL(mb, px, py, pz, c, s, F_NOBOT);
}

/**
 * Mooring bollard: the cast-iron mushroom head on a bolted base plate that lines every metre of
 * working quay in the harbour. Origin is the coping top; the piece is radially symmetric, so
 * `yaw` only turns the base plate.
 */
export function appendMooringBollard(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.quayIron);
  boxL(mb, px, py, pz, c, s, -0.23, -0.02, -0.23, 0.23, 0.055, 0.23, F_NOBOT);
  mb.cylinder(px, py + 0.05, pz, 0.155, 0.118, 0.40, 8, a, false);
  mb.cylinder(px, py + 0.45, pz, 0.118, 0.185, 0.11, 8, a, false);
  mb.cylinder(px, py + 0.56, pz, 0.185, 0.150, 0.055, 8, a, false);
  discY(mb, px, py + 0.615, pz, 0.150, 8, a, true);
}

/**
 * Recessed steel access ladder down the quay face. Origin is the coping top at the wall line,
 * local +X out over the water; `drop` is how far below the coping the stringers run, which the
 * caller takes from the water level so the bottom rung is always submerged.
 */
export function appendQuayLadder(mb, x, y, z, yaw, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const d = clamp(fin(drop, 2.4), 0.8, 8.0);

  setMat(mb, M.galv);
  // Stringers, standing 0.85 m proud of the coping as a grab handle.
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * 0.23;
    boxL(mb, px, py, pz, c, s, 0.055, -d, lz - 0.035, 0.125, 0.85, lz + 0.035, F_SIDES);
  }
  const n = Math.max(2, Math.round(d / 0.34));
  for (let i = 0; i <= n; i++) {
    const ry = 0.10 - (i / n) * (d + 0.10);
    beamL(mb, px, py, pz, c, s, 0.06, ry, -0.23, 0.06, ry, 0.23, 0.026, 0.026, F_SIDES);
  }
  // Grab bar across the two stringers, over the coping.
  beamL(mb, px, py, pz, c, s, 0.09, 0.85, -0.23, 0.09, 0.85, 0.23, 0.030, 0.030, F_SIDES);
}

/**
 * Lifebuoy station: post, backboard, ring and the small lamp that lights it. The lamp is the only
 * emitter — a real light on a real pole, so it is dark at midday and on at night like every other
 * lamp in the city.
 */
export function appendLifebuoyStation(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleDark);
  mb.cylinder(px, py - 0.04, pz, 0.062, 0.052, 2.28, 6, a, false);
  setMat(mb, M.signRed);
  boxL(mb, px, py, pz, c, s, -0.030, 0.86, -0.42, 0.010, 1.74, 0.42, F_BLADEX);
  setMat(mb, M.lifeRing);
  ringXY(mb, px, py, pz, c, s, 0.10, 1.30, 0.0, 0.335, 0.058, 9);
  setMat(mb, M.canvas);
  beamL(mb, px, py, pz, c, s, 0.10, 1.63, 0.0, 0.10, 1.30, 0.34, 0.014, 0.014, F_ALL);

  setMat(mb, M.lampBody);
  boxL(mb, px, py, pz, c, s, -0.09, 2.24, -0.11, 0.16, 2.36, 0.11, F_NOBOT);
  setMat(mb, M.quayLamp);
  quadDown(mb, px, py, pz, c, s, -0.07, -0.09, 0.14, 0.09, 2.239);
}

/**
 * Tubular guard rail: posts every ~2 m with a top rail and a knee rail, running `len` metres along
 * local Z and centred on the origin. Used on pier edges, gangway landings and the marina docks —
 * NOT along the open quay, which in Toronto has bollards and nothing else.
 */
export function appendQuayRailing(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = clamp(fin(len, 6.0), 1.2, 90.0);
  const hl = L * 0.5;
  const n = Math.max(2, Math.round(L / 2.1));

  setMat(mb, M.galv);
  for (let i = 0; i <= n; i++) {
    const lz = -hl + (i / n) * L;
    boxL(mb, px, py, pz, c, s, -0.032, 0.0, lz - 0.032, 0.032, 1.06, lz + 0.032, F_SIDES);
  }
  beamL(mb, px, py, pz, c, s, 0, 1.06, -hl, 0, 1.06, hl, 0.030, 0.030, F_ALL);
  beamL(mb, px, py, pz, c, s, 0, 0.55, -hl, 0, 0.55, hl, 0.022, 0.022, F_ALL);
}

/**
 * Backless timber bench on stone plinths — the Harbourfront promenade seat. Long axis along
 * local Z, and it faces local +X only in the sense that the plinths are set in from the ends.
 */
export function appendTimberBench(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = rr(rng, 1.70, 2.30);
  const hl = L * 0.5;

  setMat(mb, M.granite);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (hl - 0.34);
    boxL(mb, px, py, pz, c, s, -0.24, 0.0, lz - 0.10, 0.24, 0.40, lz + 0.10, F_NOBOT);
  }
  setMat(mb, M.quayTimber);
  for (let i = 0; i < 3; i++) {
    const x0 = -0.255 + i * 0.175;
    boxL(mb, px, py, pz, c, s, x0, 0.40, -hl, x0 + 0.145, 0.455, hl, F_NOBOT);
  }
}

/**
 * One armour block from the rubble mound: an irregular quarried lump. `s` is its nominal size in
 * metres. The shape is seeded on WORLD POSITION (CONTRACT §8.4) so a given rock is the same rock
 * whether or not its neighbours were built, but an rng may be passed to jitter it further.
 */
export function appendWaveRock(mb, rng, x, y, z, s) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(s, 1.2), 0.25, 6.0);
  const h0 = hash2(px, pz);
  const a = h0 * TAU;
  const c = Math.cos(a), sn = Math.sin(a);
  const j = (i) => 0.62 + 0.42 * hash2(px + i * 7.13, pz - i * 4.31);

  setMat(mb, M.armourStone);
  const hy = sc * (0.42 + 0.26 * h0);
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? 1 : -1, sy = (i & 2) ? 1 : -1, sz = (i & 4) ? 1 : -1;
    // The top face is pulled in so the block reads as a quarried wedge rather than a crate.
    const shrink = sy > 0 ? 0.62 : 1.0;
    setL(i, sx * sc * 0.5 * j(i) * shrink, sy > 0 ? hy : -sc * 0.30,
      sz * sc * 0.5 * j(i + 4) * shrink);
  }
  hullL(mb, px, py, pz, c, sn, F_NOBOT);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Aluminium gangway from a fixed quay down to a floating dock. Origin is the quay-side hinge at
 * deck level, local +X runs out to the float, `len` is the span and `drop` how far the far end
 * sits below the origin.
 */
export function appendGangway(mb, x, y, z, yaw, len, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = clamp(fin(len, 7.0), 2.0, 24.0);
  const d = clamp(fin(drop, 1.4), 0.0, 6.0);
  const hw = 0.62;

  setMat(mb, M.grateIron);
  setL(0, 0, -0.10, -hw); setL(1, L, -0.10 - d, -hw);
  setL(2, 0, 0.02, -hw); setL(3, L, 0.02 - d, -hw);
  setL(4, 0, -0.10, hw); setL(5, L, -0.10 - d, hw);
  setL(6, 0, 0.02, hw); setL(7, L, 0.02 - d, hw);
  hullL(mb, px, py, pz, c, s, F_ALL);

  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * hw;
    beamL(mb, px, py, pz, c, s, 0.10, 1.00, lz, L - 0.10, 1.00 - d, lz, 0.028, 0.028, F_ALL);
    const n = Math.max(2, Math.round(L / 2.0));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      beamL(mb, px, py, pz, c, s, 0.10 + t * (L - 0.20), 0.02 - t * d, lz,
        0.10 + t * (L - 0.20), 1.00 - t * d, lz, 0.026, 0.026, F_SIDES);
    }
  }
}

/**
 * Channel marker on a driven pile: daymark board, and a navigation light that is a REAL light —
 * the only emitter out on the water. `green` picks the starboard-hand colours over port-hand.
 */
export function appendNavMarker(mb, x, y, z, h, green) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 3.4), 1.6, 9.0);
  const a = hash2(px, pz) * TAU;
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.pileTimber);
  mb.cylinder(px, py - 1.60, pz, 0.135, 0.115, H + 1.60, 6, a, false);
  setMat(mb, green ? M.markerGreen : M.markerRed);
  boxL(mb, px, py, pz, c, s, -0.02, H - 0.86, -0.30, 0.02, H - 0.16, 0.30, F_BLADEX);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -0.075, H - 0.06, -0.075, 0.075, H + 0.14, 0.075, F_NOBOT);
  setMat(mb, green ? M.navGreen : M.navRed);
  boxL(mb, px, py, pz, c, s, -0.055, H + 0.14, -0.055, 0.055, H + 0.30, 0.055, F_NOBOT);
}

/**
 * Mooring buoy riding on the water. Origin is the water surface; the body floats about half out.
 */
export function appendMooringBuoy(mb, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const rad = clamp(fin(r, 0.42), 0.15, 1.6);
  const a = hash2(px + 11.7, pz - 3.9) * TAU;

  setMat(mb, M.buoyYellow);
  mb.cylinder(px, py - rad * 0.55, pz, rad * 0.72, rad, rad * 0.85, 7, a, false);
  mb.cylinder(px, py + rad * 0.30, pz, rad, rad * 0.34, rad * 0.42, 7, a, false);
  discY(mb, px, py + rad * 0.72, pz, rad * 0.34, 7, a, true);
  setMat(mb, M.quayIron);
  ringXY(mb, px, py, pz, Math.cos(a), Math.sin(a), 0, rad * 0.95, 0, rad * 0.20, 0.030, 6);
}

/**
 * Pile dolphin: the bound cluster of timber piles that takes the berthing load at a slip mouth or
 * a ferry terminal. Origin is the water surface, `r` the cluster radius.
 */
export function appendDolphin(mb, rng, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const rad = clamp(fin(r, 0.85), 0.35, 3.0);
  const n = rad > 1.1 ? 7 : 5;
  const a0 = hash2(px, pz) * TAU;
  const top = 2.35 + 0.9 * hash2(px - 5.5, pz + 2.2);

  setMat(mb, M.pileTimber);
  for (let i = 0; i < n; i++) {
    const th = a0 + (i / n) * TAU;
    const rr0 = i === 0 && n === 7 ? 0 : rad;
    const cx = px + Math.cos(th) * rr0, cz = pz + Math.sin(th) * rr0;
    // Piles are driven splayed: the head leans in, so the cluster is a cone, not a fence.
    mb.cylinder(cx, py - 2.60, cz, 0.175, 0.150, top + 2.60, 5, th, false);
  }
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const by = py + top - 0.30 - k * 0.75;
    torusY(mb, px, by, pz, rad + 0.17, 0.052, 8, 3, a0);
  }
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Gibraltar Point Lighthouse: a tapered hexagonal rubble tower, a gallery, and a lantern that IS
 * a light (Amendment 7 — a navigation light is a real emitter). `h` is the tower height to the
 * gallery floor.
 */
export function appendLighthouse(mb, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 15.0), 5.0, 42.0);
  const a = hash2(px, pz) * TAU;

  setMat(mb, M.lightStone);
  mb.cylinder(px, py - 0.30, pz, 3.05, 2.72, 1.10, 6, a, false);
  mb.cylinder(px, py + 0.80, pz, 2.72, 1.62, H - 0.80, 6, a, false);
  // Gallery: a corbelled deck ring, then the balustrade.
  setMat(mb, M.granite);
  mb.cylinder(px, py + H, pz, 1.72, 2.16, 0.42, 6, a, false);
  discY(mb, px, py + H + 0.42, pz, 2.16, 6, a, true);
  setMat(mb, M.lightTrim);
  mb.cylinder(px, py + H + 0.42, pz, 2.10, 2.10, 0.86, 6, a, false);
  // Lantern room: a glazed drum under a conical cap, with the light inside it.
  setMat(mb, M.galv);
  mb.cylinder(px, py + H + 1.28, pz, 1.44, 1.44, 0.16, 6, a, false);
  setMat(mb, M.lanternLight);
  mb.cylinder(px, py + H + 1.44, pz, 1.30, 1.30, 1.70, 6, a, false);
  setMat(mb, M.lightTrim);
  mb.cylinder(px, py + H + 3.14, pz, 1.52, 0.10, 1.15, 6, a, false);
  mb.cylinder(px, py + H + 4.29, pz, 0.06, 0.03, 0.85, 4, a, false);
}

/**
 * The island ferry. Double-ended, an open car deck forward, a passenger house amidships and a
 * wheelhouse at each end — the shape of the Ongiara and the Sam McBride. Origin is the waterline
 * at the hull centre, bow along local +Z.
 */
export function appendIslandFerry(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 45), 14, 90);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5, bw = L * 0.185, draft = L * 0.048, fb = L * 0.075;

  // Hull: a box amidships raked in at both ends, because she is double-ended.
  setMat(mb, M.ferryHull);
  setL(0, -bw * 0.62, -draft, -hl); setL(1, bw * 0.62, -draft, -hl);
  setL(2, -bw * 0.80, fb, -hl); setL(3, bw * 0.80, fb, -hl);
  setL(4, -bw * 0.62, -draft, -hl * 0.62); setL(5, bw * 0.62, -draft, -hl * 0.62);
  setL(6, -bw, fb, -hl * 0.62); setL(7, bw, fb, -hl * 0.62);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setL(0, -bw * 0.62, -draft, -hl * 0.62); setL(1, bw * 0.62, -draft, -hl * 0.62);
  setL(2, -bw, fb, -hl * 0.62); setL(3, bw, fb, -hl * 0.62);
  setL(4, -bw * 0.62, -draft, hl * 0.62); setL(5, bw * 0.62, -draft, hl * 0.62);
  setL(6, -bw, fb, hl * 0.62); setL(7, bw, fb, hl * 0.62);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setL(0, -bw * 0.62, -draft, hl * 0.62); setL(1, bw * 0.62, -draft, hl * 0.62);
  setL(2, -bw, fb, hl * 0.62); setL(3, bw, fb, hl * 0.62);
  setL(4, -bw * 0.62, -draft, hl); setL(5, bw * 0.62, -draft, hl);
  setL(6, -bw * 0.80, fb, hl); setL(7, bw * 0.80, fb, hl);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);

  // Main deck, then the passenger house on it.
  setMat(mb, M.ferryDeck);
  quadUp(mb, px, py, pz, c, s, -bw, -hl, bw, hl, fb);
  const hy = fb + L * 0.072;
  setMat(mb, M.ferryHouse);
  boxL(mb, px, py, pz, c, s, -bw * 0.78, fb, -hl * 0.50, bw * 0.78, hy, hl * 0.30, F_NOBOT);
  setMat(mb, M.cabinGlass);
  quadPX(mb, px, py, pz, c, s, bw * 0.785, fb + L * 0.020, -hl * 0.46, hy - L * 0.014, hl * 0.26);
  quadNX(mb, px, py, pz, c, s, -bw * 0.785, fb + L * 0.020, -hl * 0.46, hy - L * 0.014, hl * 0.26);
  // Upper deck over the house, with a rail round it.
  setMat(mb, M.ferryDeck);
  boxL(mb, px, py, pz, c, s, -bw * 0.82, hy, -hl * 0.54, bw * 0.82, hy + L * 0.006, hl * 0.34,
    F_NOBOT);
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * bw * 0.80;
    boxL(mb, px, py, pz, c, s, sx - 0.03, hy + L * 0.006, -hl * 0.54,
      sx + 0.03, hy + L * 0.026, hl * 0.34, F_BLADEX);
    boxL(mb, px, py, pz, c, s, sx - 0.03, fb + L * 0.020, -hl, sx + 0.03, fb + L * 0.040, hl,
      F_BLADEX);
  }
  // A wheelhouse at each end and a single funnel.
  setMat(mb, M.ferryHouse);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const wz = sg * hl * 0.44;
    boxL(mb, px, py, pz, c, s, -bw * 0.34, hy + L * 0.006, wz - L * 0.038,
      bw * 0.34, hy + L * 0.058, wz + L * 0.038, F_NOBOT);
    setMat(mb, M.cabinGlass);
    quadPZ(mb, px, py, pz, c, s, wz + L * 0.0385, -bw * 0.30, hy + L * 0.024,
      bw * 0.30, hy + L * 0.050);
    quadNZ(mb, px, py, pz, c, s, wz - L * 0.0385, -bw * 0.30, hy + L * 0.024,
      bw * 0.30, hy + L * 0.050);
    setMat(mb, M.ferryHouse);
  }
  setMat(mb, M.ferryHull);
  mb.cylinder(px, py + hy + L * 0.006, pz, L * 0.026, L * 0.022, L * 0.075, 6, a, false);
  if (typeof rng === 'function') rnd(rng);
}

/** Concrete boat slipway running down into the water. Local +X is down the slope. */
export function appendSlipway(mb, x, y, z, yaw, w, len, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6), 1.5, 30);
  const L = clamp(fin(len, 12), 2, 60);
  const dr = clamp(fin(drop, 1.6), 0.2, 6.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;

  setMat(mb, M.concrete);
  setL(0, 0, -0.35, -hw); setL(1, L, -0.35 - dr, -hw);
  setL(2, 0, 0.0, -hw); setL(3, L, -dr, -hw);
  setL(4, 0, -0.35, hw); setL(5, L, -0.35 - dr, hw);
  setL(6, 0, 0.0, hw); setL(7, L, -dr, hw);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_NX);
  setMat(mb, M.granite);
  for (let k = 0; k < 2; k++) {
    const sz = (k === 0 ? -1 : 1) * hw;
    setL(0, 0, 0.0, sz - 0.14); setL(1, L, -dr, sz - 0.14);
    setL(2, 0, 0.22, sz - 0.14); setL(3, L, 0.22 - dr, sz - 0.14);
    setL(4, 0, 0.0, sz + 0.14); setL(5, L, -dr, sz + 0.14);
    setL(6, 0, 0.22, sz + 0.14); setL(7, L, 0.22 - dr, sz + 0.14);
    hullL(mb, px, py, pz, c, s, F_NOBOT);
  }
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendBoat,
  appendFerryDock,
  appendMooringBollard,
  appendQuayLadder,
  appendLifebuoyStation,
  appendQuayRailing,
  appendTimberBench,
  appendWaveRock,
  appendGangway,
  appendNavMarker,
  appendMooringBuoy,
  appendDolphin,
  appendLighthouse,
  appendIslandFerry,
  appendSlipway,
});
