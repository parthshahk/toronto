// src/props/structures.js — built structures at street level and on site: tower cranes, sidewalk
// sheds and scaffolding, hoardings and free-standing signage, subway entrances, boardwalk and
// chain-link fencing, roof forms, and the amusement-park pieces on Centre Island.
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// FACE MASKS FOR beam()/beamL(): beam builds its hull in a frame where the mask's "X" bits are the
// width axis, the "Y" bits the thickness axis and the "Z" bits the two END CAPS. A member that
// must be closed along its length therefore uses F_BLADEX (its four long faces); F_SIDES on a beam
// would leave the thickness faces open. boxL/frustL/hullL are in true local axes and keep the
// ordinary meaning.

import { TAU, clamp } from '../core/math.js';
import { ALIGN, VALIGN, appendText } from '../render/text.js';
import {
  F_ALL, F_BLADEX, F_BLADEZ, F_NOBOT, F_NY, F_PLATEX, F_PX, F_PY, F_SIDES, beamL, boxL, discY,
  fin, finAngle, hash2, hullL, quadDown, quadL, quadPX, rnd, rr, setL, setMat, triL,
} from './kit.js';
import { M } from './materials.js';

// Tower crane. Toronto runs more of these than any other city on the continent and a skyline
// without them is simply wrong. The lattice is simplified to four chords plus tie collars, but
// every part that carries the silhouette is here: slewing unit, operator cab, A-frame, hammerhead
// jib on three tapering chords, counter-jib with its counterweight slab, trolley, hoist rope,
// hook block and the red obstruction light at the apex.
//
// (x, y, z) is the base centre at ground level and `h` the height to the slewing ring. The jib
// reaches along local +X, the counter-jib along local -X.
export function appendConstructionCrane(mb, rng, x, y, z, yaw, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const H = clamp(fin(h, 62), 16.0, 150.0);
  const c = Math.cos(a), s = Math.sin(a);

  const sm = clamp(H * 0.030, 1.5, 2.6);        // mast face width
  const hm = sm * 0.5;
  const cr = clamp(sm * 0.055, 0.07, 0.16);     // chord half-thickness
  const jib = clamp(H * 0.78, 15.0, 70.0);
  const cj = clamp(jib * 0.30, 5.0, 20.0);
  const jibY = H + 1.55;
  const apexY = jibY + clamp(jib * 0.16, 3.0, 9.0);

  // Ballast pad.
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -sm * 1.30, -0.30, -sm * 1.30, sm * 1.30, 0.34, sm * 1.30, F_SIDES);

  // Mast: four corner chords plus tie collars. Real diagonals would cost four times as much and
  // at any distance a crane is actually seen from, the collars carry the same read.
  setMat(mb, M.craneYellow);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? hm : -hm;
    const cz = (i & 2) ? hm : -hm;
    boxL(mb, px, py, pz, c, s, cx - cr, 0.0, cz - cr, cx + cr, H, cz + cr, F_SIDES);
  }
  setMat(mb, M.galv);
  for (let i = 0; i < 3; i++) {
    const cy = H * (0.24 + 0.25 * i);
    boxL(mb, px, py, pz, c, s, -hm - cr, cy, -hm - cr, hm + cr, cy + 0.17, hm + cr, F_SIDES);
  }

  // Slewing ring.
  setMat(mb, M.craneYellow);
  mb.cylinder(px, py + H, pz, hm * 1.26, hm * 1.04, 0.92, 6, a, false);

  // Machinery house on the counter-jib, operator cab under the jib root.
  setMat(mb, M.craneWhite);
  boxL(mb, px, py, pz, c, s, -cj * 0.88, jibY - 0.35, -sm * 0.50,
    -cj * 0.24, jibY + 1.45, sm * 0.50, F_NOBOT);
  boxL(mb, px, py, pz, c, s, hm + 0.10, H + 0.92, -sm * 0.62,
    hm + 1.95, H + 3.15, sm * 0.08, F_NOBOT);
  setMat(mb, M.glass);
  quadPX(mb, px, py, pz, c, s, hm + 1.955, H + 1.30, -sm * 0.55, H + 2.95, sm * 0.02);

  // A-frame over the slewing unit.
  setMat(mb, M.craneYellow);
  for (let i = 0; i < 2; i++) {
    const lz = (i === 0 ? -1 : 1) * hm * 0.78;
    beamL(mb, px, py, pz, c, s, -0.18, jibY + 0.10, lz, 0.0, apexY, 0.0, 0.10, 0.10, F_BLADEX);
  }

  // Hammerhead jib: one top chord and two bottom chords, all tapering to the tip, plus a web post.
  // Three chords is what makes it read as a triangular-section boom rather than a stick.
  const tipT = 0.055;
  setL(0, hm * 0.70, jibY + 0.52, -0.11); setL(1, jib, jibY + 0.30, -tipT);
  setL(2, hm * 0.70, jibY + 0.76, -0.11); setL(3, jib, jibY + 0.42, -tipT);
  setL(4, hm * 0.70, jibY + 0.52, 0.11); setL(5, jib, jibY + 0.30, tipT);
  setL(6, hm * 0.70, jibY + 0.76, 0.11); setL(7, jib, jibY + 0.42, tipT);
  hullL(mb, px, py, pz, c, s, F_BLADEZ);
  for (let i = 0; i < 2; i++) {
    const bz = (i === 0 ? -1 : 1) * sm * 0.36;
    setL(0, hm * 0.70, jibY - 0.50, bz - 0.10); setL(1, jib * 0.99, jibY + 0.12, bz - tipT);
    setL(2, hm * 0.70, jibY - 0.26, bz - 0.10); setL(3, jib * 0.99, jibY + 0.24, bz - tipT);
    setL(4, hm * 0.70, jibY - 0.50, bz + 0.10); setL(5, jib * 0.99, jibY + 0.12, bz + tipT);
    setL(6, hm * 0.70, jibY - 0.26, bz + 0.10); setL(7, jib * 0.99, jibY + 0.24, bz + tipT);
    hullL(mb, px, py, pz, c, s, F_BLADEZ);
  }
  beamL(mb, px, py, pz, c, s,
    jib * 0.46, jibY + 0.60, 0, jib * 0.46, jibY - 0.22, 0, 0.06, 0.06, F_BLADEX);

  // Counter-jib and its counterweight slab.
  for (let i = 0; i < 2; i++) {
    const cy = jibY + (i === 0 ? 0.52 : -0.42);
    boxL(mb, px, py, pz, c, s, -cj, cy, -sm * 0.30, -hm * 0.70, cy + 0.22, sm * 0.30, F_BLADEZ);
  }
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -cj - 0.55, jibY - 1.45, -sm * 0.56,
    -cj + 0.35, jibY + 0.55, sm * 0.56, F_ALL);

  // Pendant ties from the A-frame apex.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, 0, apexY, 0, jib * 0.64, jibY + 0.70, 0, 0.055, 0.055, F_BLADEX);
  beamL(mb, px, py, pz, c, s, 0, apexY, 0, -cj * 0.86, jibY + 0.62, 0, 0.055, 0.055, F_BLADEX);

  // Trolley, hoist rope and hook block.
  const tx = jib * (0.34 + 0.50 * rnd(rng));
  const hookY = H * (0.22 + 0.52 * rnd(rng));
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, tx - 0.55, jibY - 0.92, -0.32, tx + 0.55, jibY - 0.34, 0.32, F_NOBOT);
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, tx, jibY - 0.92, 0, tx, hookY, 0, 0.035, 0.035, F_BLADEX);
  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, tx - 0.26, hookY - 0.78, -0.22, tx + 0.26, hookY, 0.22, F_NOBOT);

  // Aviation obstruction light at the apex — a real lamp, so the renderer owns when it is on.
  setMat(mb, M.beaconRed);
  mb.cylinder(px, py + apexY, pz, 0.105, 0.085, 0.22, 4, a, false);
  discY(mb, px, py + apexY + 0.22, pz, 0.085, 4, a, true);
}

// Sidewalk scaffold / hoarding — the covered walkway that wraps half of downtown at any given
// moment. Length along local Z, the building face at local -X, the kerb side at local +X. Tile
// several sections along a long frontage.
//
// The under-deck lamps are REAL fixtures: they are the reason a sidewalk shed is not pitch black
// at night, and the renderer decides when they are on.
export function appendScaffold(mb, rng, x, y, z, yaw, w, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6.0), 1.5, 12.0);
  const H = clamp(fin(h, 3.6), 2.4, 8.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = W * 0.5;
  const dx = 1.20;

  // Standards and ledgers.
  setMat(mb, M.galv);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? dx : -dx;
    const cz = (i & 2) ? hl - 0.22 : -(hl - 0.22);
    boxL(mb, px, py, pz, c, s, cx - 0.055, 0.0, cz - 0.055, cx + 0.055, H, cz + 0.055, F_SIDES);
  }
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? -dx : dx;
    boxL(mb, px, py, pz, c, s, cx - 0.05, H - 0.34, -hl, cx + 0.05, H - 0.24, hl, F_BLADEX);
  }
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, dx, 0.10, -(hl - 0.22), dx, H - 0.30, hl - 0.22,
    0.040, 0.040, F_BLADEX);

  // Deck. Both faces matter — the underside is what a pedestrian actually walks beneath.
  setMat(mb, M.plywood);
  boxL(mb, px, py, pz, c, s, -dx - 0.32, H, -hl - 0.16, dx + 0.32, H + 0.14, hl + 0.16, F_ALL);
  boxL(mb, px, py, pz, c, s, dx + 0.30, H + 0.14, -hl - 0.16, dx + 0.34, H + 0.62, hl + 0.16,
    F_PLATEX);
  boxL(mb, px, py, pz, c, s, -dx - 0.06, 0.0, -hl - 0.10, -dx - 0.02, H * 0.62, hl + 0.10,
    F_PLATEX);

  // Two under-deck lamps.
  const lz = hl * 0.48;
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * lz;
    setMat(mb, M.lampBody);
    boxL(mb, px, py, pz, c, s, -0.16, H - 0.16, cz - 0.34, 0.16, H - 0.02, cz + 0.34, F_SIDES);
    setMat(mb, M.shedLamp);
    quadDown(mb, px, py, pz, c, s, -0.13, cz - 0.30, 0.13, cz + 0.30, H - 0.165);
  }

  if (rnd(rng) < 0.5) {
    setMat(mb, M.signRed);
    quadPX(mb, px, py, pz, c, s, dx + 0.345, H + 0.24, -0.55, H + 0.52, 0.55);
  }
}

/**
 * Chain-link perimeter fence along local Z: posts, a top rail, and the mesh as a single thin
 * plate. `len` is the run, `h` the height. Long runs should be tiled rather than stretched.
 */
export function appendChainFence(mb, x, y, z, yaw, len, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 12), 0.5, 120);
  const H = clamp(fin(h, 2.4), 0.6, 5.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.chainLink);
  boxL(mb, px, py, pz, c, s, -0.018, 0.06, -hl, 0.018, H - 0.10, hl, F_PLATEX);
  boxL(mb, px, py, pz, c, s, -0.028, H - 0.10, -hl, 0.028, H - 0.042, hl, F_NOBOT);
  setMat(mb, M.galv);
  const n = Math.max(1, Math.round(L / 3.0));
  for (let i = 0; i <= n; i++) {
    const lz = -hl + L * (i / n);
    mb.cylinder(px + lz * s, py, pz + lz * c, 0.048, 0.044, H, 4, a, false);
  }
  // Three strands of barbed wire on an outward-canted arm, which is what makes it read as an
  // airfield boundary rather than a garden fence.
  for (let i = 0; i < 3; i++) {
    boxL(mb, px, py, pz, c, s, 0.06 + i * 0.085, H - 0.02 + i * 0.085, -hl,
      0.078 + i * 0.085, H + 0.0 + i * 0.085, hl, F_PLATEX);
  }
}

/**
 * The Centreville carousel: a raised timber platform, a centre pole, a twelve-sided canopy with
 * a scalloped valance, and a ring of mounts on brass poles. `r` is the platform radius.
 */
export function appendCarousel(mb, rng, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const R = clamp(fin(r, 9.0), 2.5, 20.0);
  const a = hash2(px, pz) * TAU;

  setMat(mb, M.granite);
  mb.cylinder(px, py, pz, R + 0.55, R + 0.55, 0.34, 12, a, false);
  discY(mb, px, py + 0.34, pz, R + 0.55, 12, a, true);
  setMat(mb, M.woodSlat);
  mb.cylinder(px, py + 0.34, pz, R, R, 0.22, 12, a, false);
  discY(mb, px, py + 0.56, pz, R, 12, a, true);

  setMat(mb, M.rideGold);
  mb.cylinder(px, py + 0.56, pz, R * 0.085, R * 0.070, R * 0.70, 8, a, false);
  // Canopy: a cone from the hub out to the eaves, with a red valance hanging off the rim.
  setMat(mb, M.rideRed);
  mb.cylinder(px, py + 0.56 + R * 0.52, pz, R * 1.02, R * 0.14, R * 0.30, 12, a, false);
  setMat(mb, M.rideCream);
  mb.cylinder(px, py + 0.56 + R * 0.40, pz, R * 1.05, R * 1.02, R * 0.12, 12, a, false);
  discY(mb, px, py + 0.56 + R * 0.40, pz, R * 1.05, 12, a, false);

  // Mounts: two rings of horses, each a body block on a brass pole.
  for (let ring = 0; ring < 2; ring++) {
    const rr0 = R * (ring === 0 ? 0.52 : 0.82);
    const n = ring === 0 ? 8 : 12;
    for (let i = 0; i < n; i++) {
      const th = a + (i / n) * TAU + (ring ? 0.26 : 0);
      const cx = px + Math.cos(th) * rr0, cz = pz + Math.sin(th) * rr0;
      const bob = 0.20 + 0.34 * hash2(cx, cz);
      setMat(mb, M.rideGold);
      mb.cylinder(cx, py + 0.56, cz, 0.038, 0.038, R * 0.40, 4, th, false);
      const c2 = Math.cos(th), s2 = Math.sin(th);
      setMat(mb, rnd(rng) < 0.5 ? M.rideCream : M.rideRed);
      boxL(mb, cx, py + 0.56 + bob, cz, c2, s2, -0.62, 0.42, -0.20, 0.62, 0.96, 0.20, F_NOBOT);
      boxL(mb, cx, py + 0.56 + bob, cz, c2, s2, 0.36, 0.86, -0.14, 0.74, 1.38, 0.14, F_NOBOT);
    }
  }
}

/**
 * Generic fairground ride structure, for the Centreville attractions the extract names but does
 * not describe: a fenced pad, a machinery house, and a frame whose shape follows `kind`
 * (0 flat ride, 1 track ride, 2 water ride).
 */
export function appendRidePad(mb, rng, x, y, z, yaw, w, d, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 10), 2, 70);
  const D = clamp(fin(d, 10), 2, 70);
  const k = (fin(kind, 0) | 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, 0.12, hd, F_NOBOT);
  // Perimeter rail.
  setMat(mb, M.railGreen);
  for (let side = 0; side < 4; side++) {
    const along = side < 2 ? hw : hd;
    const off = side < 2 ? hd : hw;
    const sg = (side & 1) ? 1 : -1;
    for (let i = 0; i < 2; i++) {
      const yy = 0.42 + i * 0.46;
      if (side < 2) {
        boxL(mb, px, py, pz, c, s, -along, yy, sg * off - 0.03, along, yy + 0.06, sg * off + 0.03,
          F_NOBOT);
      } else {
        boxL(mb, px, py, pz, c, s, sg * off - 0.03, yy, -along, sg * off + 0.03, yy + 0.06, along,
          F_NOBOT);
      }
    }
  }
  // Machinery / ticket house in one corner.
  setMat(mb, M.rideCream);
  boxL(mb, px, py, pz, c, s, hw - Math.min(3.4, W * 0.34), 0.12, hd - Math.min(2.8, D * 0.30),
    hw - 0.35, 2.85, hd - 0.35, F_NOBOT);
  setMat(mb, M.rideRed);
  boxL(mb, px, py, pz, c, s, hw - Math.min(3.6, W * 0.36), 2.85, hd - Math.min(3.0, D * 0.32),
    hw - 0.20, 3.10, hd - 0.20, F_NOBOT);

  if (k === 1) {
    // Track ride: a raised loop on trestles, cut into eight chords round the pad.
    setMat(mb, M.galv);
    const rx = hw * 0.72, rz = hd * 0.72;
    for (let i = 0; i < 8; i++) {
      const t0 = (i / 8) * TAU, t1 = ((i + 1) / 8) * TAU;
      const y0 = 1.20 + 1.35 * (0.5 + 0.5 * Math.sin(t0 * 2));
      const y1 = 1.20 + 1.35 * (0.5 + 0.5 * Math.sin(t1 * 2));
      beamL(mb, px, py, pz, c, s, Math.cos(t0) * rx, y0, Math.sin(t0) * rz,
        Math.cos(t1) * rx, y1, Math.sin(t1) * rz, 0.42, 0.09, F_ALL);
      beamL(mb, px, py, pz, c, s, Math.cos(t0) * rx, 0.12, Math.sin(t0) * rz,
        Math.cos(t0) * rx, y0, Math.sin(t0) * rz, 0.09, 0.09, F_ALL);
    }
  } else if (k === 2) {
    // Water ride: a flume trough on piers, running the length of the pad and back.
    setMat(mb, M.rideCream);
    for (let lane = 0; lane < 2; lane++) {
      const lz = (lane === 0 ? -1 : 1) * hd * 0.45;
      beamL(mb, px, py, pz, c, s, -hw * 0.86, 1.35 + lane * 1.6, lz,
        hw * 0.86, 1.35 + (1 - lane) * 1.6, lz, 0.85, 0.20, F_ALL);
      setMat(mb, M.galv);
      for (let i = 0; i < 4; i++) {
        const lx = -hw * 0.80 + hw * 1.60 * (i / 3);
        beamL(mb, px, py, pz, c, s, lx, 0.12, lz, lx, 1.35 + 1.6 * (lane ? i / 3 : 1 - i / 3), lz,
          0.11, 0.11, F_ALL);
      }
      setMat(mb, M.rideCream);
    }
  } else {
    // Flat ride: a central hub and a canopy of swept arms.
    setMat(mb, M.rideGold);
    const hr = Math.min(hw, hd) * 0.80;
    mb.cylinder(px, py + 0.12, pz, hr * 0.20, hr * 0.14, 3.30, 8, a, false);
    setMat(mb, M.rideRed);
    for (let i = 0; i < 6; i++) {
      const th = a + (i / 6) * TAU;
      beamL(mb, px, py, pz, c, s, 0, 3.10, 0,
        Math.cos(th - a) * hr, 2.35, Math.sin(th - a) * hr, 0.16, 0.10, F_ALL);
    }
  }
  if (typeof rng === 'function') rnd(rng);
}

/** Timber handrail along a boardwalk. Runs along local Z; posts every ~2 m. */
export function appendTimberRail(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 8), 0.6, 80);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.boardRail);
  boxL(mb, px, py, pz, c, s, -0.045, 0.94, -hl, 0.045, 1.02, hl, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.035, 0.50, -hl, 0.035, 0.56, hl, F_NOBOT);
  const n = Math.max(1, Math.round(L / 2.0));
  for (let i = 0; i <= n; i++) {
    const lz = -hl + L * (i / n);
    boxL(mb, px, py, pz, c, s, -0.055, 0.0, lz - 0.055, 0.055, 0.94, lz + 0.055, F_NOBOT);
  }
}

/**
 * Gable roof for an island cottage. The massing extract has no roof pitch, and the Ward's and
 * Algonquin houses are all pitched; without this every one of them is a flat-topped box.
 * `w` runs along local X, `d` along local Z, and the ridge runs along local Z.
 */
export function appendGableRoof(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 7), 1.5, 26);
  const D = clamp(fin(d, 9), 1.5, 34);
  const H = clamp(fin(h, 2.2), 0.5, 7.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5 + 0.32, hd = D * 0.5 + 0.32;

  setMat(mb, M.shingle);
  // Two pitches meeting at a ridge over local x = 0.
  quadL(mb, px, py, pz, c, s, -hw, 0, hd, 0, H, hd, 0, H, -hd, -hw, 0, -hd);
  quadL(mb, px, py, pz, c, s, 0, H, hd, hw, 0, hd, hw, 0, -hd, 0, H, -hd);
  // Gable ends, and a fascia band so the eaves are not a paper edge.
  triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, 0, H, hd);
  triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, 0, H, -hd);
  setMat(mb, M.chalk);
  boxL(mb, px, py, pz, c, s, -hw, -0.22, -hd, hw, 0.0, hd, F_SIDES);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * A real roof form standing on a flat extrusion cap. `w` runs along local X, `d` along local Z,
 * `h` is the rise above (x, y, z) — which is the CENTRE of the cap, at cap level.
 *
 * The extrusion underneath keeps its flat cap: this sits ON it rather than replacing it, so a
 * footprint whose ring the massing pass already triangulated needs no second treatment and there
 * is never a hole where the two disagree. The eaves overhang by OVERHANG on all four sides,
 * which is what stops a pitched roof reading as a folded lid.
 *
 * shape: 'gabled' | 'hipped' | 'half-hipped' | 'pyramidal' | 'skillion' | 'saltbox' |
 *        'mansard' | 'round' | 'dome'. Anything else is treated as gabled.
 * Cost: 24 verts pyramidal, 30 gabled, 36 hipped, 42 skillion, ~150 round.
 * @returns {number} vertices appended
 */
export function appendPitchedRoof(mb, x, y, z, yaw, w, d, h, shape, mat) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const OVERHANG = 0.28;
  const hw = clamp(fin(w, 6) * 0.5, 0.8, 90) + OVERHANG;
  const hd = clamp(fin(d, 6) * 0.5, 0.8, 90) + OVERHANG;
  const rise = clamp(fin(h, 2.4), 0.6, 22);
  const k = typeof shape === 'string' ? shape : 'gabled';
  setMat(mb, mat || M.slate);

  // The fascia band under the eaves: the roof would otherwise float over the wall by OVERHANG
  // with open air visible under it from the street.
  const eave = 0.16;
  boxL(mb, px, py, pz, c, s, -hw, -eave, -hd, hw, 0, hd, F_SIDES | F_NY);

  if (k === 'pyramidal' || k === 'dome') {
    const ap = k === 'dome' ? rise * 1.25 : rise;
    triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, 0, ap, 0);
    triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, 0, ap, 0);
    triL(mb, px, py, pz, c, s, hw, 0, hd, hw, 0, -hd, 0, ap, 0);
    triL(mb, px, py, pz, c, s, -hw, 0, -hd, -hw, 0, hd, 0, ap, 0);
    return mb.count - before;
  }

  if (k === 'skillion' || k === 'saltbox' || k === 'quadruple_saltbo') {
    // A saltbox is a gable with one long side; modelled as a mono-pitch plus the short back
    // wall, which is what it reads as from the street.
    quadL(mb, px, py, pz, c, s, -hw, 0, -hd, -hw, 0, hd, hw, rise, hd, hw, rise, -hd);
    triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, hw, rise, hd);
    triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, hw, rise, -hd);
    quadL(mb, px, py, pz, c, s, hw, 0, hd, hw, 0, -hd, hw, rise, -hd, hw, rise, hd);
    return mb.count - before;
  }

  if (k === 'round') {
    // A barrel vault along local Z: a lathe of quads plus the two end lunettes.
    const seg = 9;
    let ax = hw, ay = 0;
    for (let i = 1; i <= seg; i++) {
      const t = (i / seg) * Math.PI;
      const bx = Math.cos(t) * hw, by = Math.sin(t) * rise;
      quadL(mb, px, py, pz, c, s, ax, ay, hd, ax, ay, -hd, bx, by, -hd, bx, by, hd);
      triL(mb, px, py, pz, c, s, 0, 0, hd, ax, ay, hd, bx, by, hd);
      triL(mb, px, py, pz, c, s, ax, ay, -hd, 0, 0, -hd, bx, by, -hd);
      ax = bx; ay = by;
    }
    return mb.count - before;
  }

  // Gabled, and the hipped family. A hip pulls the ridge in from each end; a half-hip pulls it
  // in half as far and leaves a small gable above it, which at this scale reads as a short hip.
  let inset = 0;
  if (k === 'hipped') inset = Math.min(hw, hd * 0.48);
  else if (k === 'half-hipped' || k === 'mansard') inset = Math.min(hw * 0.55, hd * 0.30);
  const rz = hd - inset;

  quadL(mb, px, py, pz, c, s, hw, 0, hd, hw, 0, -hd, 0, rise, -rz, 0, rise, rz);
  quadL(mb, px, py, pz, c, s, -hw, 0, -hd, -hw, 0, hd, 0, rise, rz, 0, rise, -rz);
  if (inset > 0.02) {
    triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, 0, rise, rz);
    triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, 0, rise, -rz);
  } else {
    triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, 0, rise, hd);
    triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, 0, rise, -hd);
  }
  return mb.count - before;
}

/**
 * A TTC subway entrance: the low parapet walls round the stair head, three visible steps down
 * into the dark, a flat canopy on two posts and the red pylon that carries the station name.
 * The stair descends into geometry rather than into a hole in the terrain — the ground plane is
 * a continuous sheet and cutting it per entrance is not worth a hole nobody can fall through.
 *
 * `name` letters the pylon when a font and a signage builder are supplied in opts.
 * Cost: ~250 verts. @returns {number} vertices appended
 */
export function appendSubwayEntrance(mb, x, y, z, yaw, name, opts) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const o = opts || null;
  const hw = 1.35, dp = 2.30;

  // Parapets: three sides, open toward +X (the street).
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -0.30, 0, -hw, dp, 0.98, -hw + 0.26, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.30, 0, hw - 0.26, dp, 0.98, hw, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.30, 0, -hw, -0.04, 0.98, hw, F_NOBOT);
  setMat(mb, M.railSilver);
  for (let k = 0; k < 2; k++) {
    const lz = k === 0 ? -hw + 0.13 : hw - 0.13;
    boxL(mb, px, py, pz, c, s, -0.30, 0.98, lz - 0.03, dp, 1.04, lz + 0.03, F_NOBOT);
  }

  // The stair: three treads and then a dark plane. Nothing below ground level.
  setMat(mb, M.concrete);
  for (let i = 0; i < 3; i++) {
    const x0 = dp - (i + 1) * 0.34;
    boxL(mb, px, py, pz, c, s, x0, -0.02 - i * 0.17, -hw + 0.26, x0 + 0.34,
      0.04 - i * 0.17, hw - 0.26, F_PY | F_PX);
  }
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, -0.02, -0.50, -hw + 0.26, 0.98, hw - 0.26);

  // Canopy on two posts, and the pylon.
  setMat(mb, M.poleGrey);
  for (let k = 0; k < 2; k++) {
    const lz = k === 0 ? -hw + 0.16 : hw - 0.16;
    boxL(mb, px, py, pz, c, s, dp - 0.16, 0, lz - 0.06, dp - 0.04, 2.62, lz + 0.06, F_SIDES);
  }
  setMat(mb, M.alum);
  boxL(mb, px, py, pz, c, s, -0.44, 2.62, -hw - 0.16, dp + 0.16, 2.78, hw + 0.16, F_NOBOT);
  setMat(mb, M.ttcRed);
  boxL(mb, px, py, pz, c, s, dp + 0.10, 0, -0.30, dp + 0.28, 3.35, 0.30, F_NOBOT);
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, dp + 0.06, 2.55, -0.26, dp + 0.32, 3.25, 0.26, F_PLATEX);

  if (o && o.textMb && o.font && typeof name === 'string' && name) {
    const nx = c, nz = -s;                                  // world direction of local +X
    const ux = -s, uz = -c;                                 // world direction of local +Z
    for (let k = 0; k < 2; k++) {
      const sg = k === 0 ? 1 : -1;
      const lx = k === 0 ? dp + 0.34 : dp + 0.04;           // just outside each face of the plate
      appendText(o.textMb, o.font, name, {
        x: px + nx * lx, y: py + 2.90, z: pz + nz * lx,
        rx: ux * sg, ry: 0, rz: uz * sg, nx: nx * sg, ny: 0, nz: nz * sg,
        h: 0.13, align: ALIGN.CENTER, vAlign: VALIGN.MIDDLE,
        maxWidth: 0.50, minScale: 0.5, lift: 0.006,
        r: 0.240, g: 0.243, b: 0.248, rough: 0.60,
      });
    }
  }
  return mb.count - before;
}

/** A hoarding-scale advertising billboard on two posts. ~90 verts. */
export function appendBillboard(mb, rng, x, y, z, yaw) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const w = rr(rng, 2.6, 3.4);
  const h = rr(rng, 1.7, 2.3);
  const base = 2.4;
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (w - 0.5);
    boxL(mb, px, py, pz, c, s, -0.07, 0, lz - 0.07, 0.07, base + 0.3, lz + 0.07, F_SIDES);
  }
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, -0.09, base, -w, 0.09, base + h, w, F_NOBOT);
  // The poster itself: an internally lit panel, so it is a genuine emitter and the renderer
  // decides when it is on.
  setMat(mb, M.adPanel);
  quadPX(mb, px, py, pz, c, s, 0.095, base + 0.09, -w + 0.09, base + h - 0.09, w - 0.09);
  return mb.count - before;
}

/** A Morris-column advertising drum. ~80 verts. */
export function appendAdColumn(mb, x, y, z) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  setMat(mb, M.castIron);
  mb.cylinder(px, py - 0.04, pz, 0.62, 0.58, 0.42, 10, 0, false);
  setMat(mb, M.adPanel);
  mb.cylinder(px, py + 0.38, pz, 0.58, 0.58, 2.30, 10, 0, false);
  setMat(mb, M.castIron);
  mb.cylinder(px, py + 2.68, pz, 0.66, 0.30, 0.44, 10, 0, true);
  return mb.count - before;
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendConstructionCrane,
  appendScaffold,
  appendChainFence,
  appendCarousel,
  appendRidePad,
  appendTimberRail,
  appendGableRoof,
  appendPitchedRoof,
  appendSubwayEntrance,
  appendBillboard,
  appendAdColumn,
});
