// src/props/vegetation.js — planting: street trees in pits, park trees, shrubs, and the island
// vocabulary (mature canopy trees, hedgerows, bedding, beach grass).
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js. Nothing
// here is an emitter and nothing here is animated; foliage is a blunt hull read as a silhouette.

import { TAU, clamp } from '../core/math.js';
import {
  F_NOBOT, F_NX, F_PLATEZ, F_PX, F_SIDES, beam, blob, boxL, fin, finAngle, hash2, quadL, quadUp,
  rnd, rr, setMat,
} from './kit.js';
import { M } from './materials.js';

// Tree-pit grate: a shallow granite bevel down to a cast grate flush with the sidewalk.
function treePit(mb, px, py, pz, c, s, r) {
  const o = r * 1.24;
  setMat(mb, M.granite);
  quadL(mb, px, py, pz, c, s, -o, 0.03, o, o, 0.03, o, r, 0.00, r, -r, 0.00, r);
  quadL(mb, px, py, pz, c, s, o, 0.03, o, o, 0.03, -o, r, 0.00, -r, r, 0.00, r);
  quadL(mb, px, py, pz, c, s, o, 0.03, -o, -o, 0.03, -o, -r, 0.00, -r, r, 0.00, -r);
  quadL(mb, px, py, pz, c, s, -o, 0.03, -o, -o, 0.03, o, -r, 0.00, r, -r, 0.00, -r);
  setMat(mb, M.grateIron);
  quadUp(mb, px, py, pz, c, s, -r, -r, r, r, 0.005);
}

// Irregular two-section trunk. Returns nothing; the caller places the canopy above it.
function trunk(mb, rng, px, py, pz, r0, r1, r2, h0, h1) {
  const lean = rr(rng, -0.055, 0.055);
  const lz = rr(rng, -0.055, 0.055);
  setMat(mb, rnd(rng) < 0.35 ? M.barkPale : M.bark);
  mb.cylinder(px, py - 0.05, pz, r0, r1, h0 + 0.05, 5, rr(rng, 0, TAU), false);
  mb.cylinder(px + lean, py + h0, pz + lz, r1 * 1.02, r2, h1, 5, rr(rng, 0, TAU), false);
}

// Street tree in a pit: grate, slightly irregular trunk, canopy of overlapping clumps.
export function appendStreetTree(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.45, 2.6);
  const a = rr(rng, 0, TAU);

  treePit(mb, px, py, pz, Math.cos(a), Math.sin(a), 0.62 * sc);

  const h0 = 1.35 * sc, h1 = 1.55 * sc;
  trunk(mb, rng, px, py, pz, 0.20 * sc, 0.132 * sc, 0.086 * sc, h0, h1);

  const cy = py + h0 + h1;
  const rad = 1.30 * sc;
  const leaf = rnd(rng) < 0.4 ? M.foliageWarm : (rnd(rng) < 0.5 ? M.foliageCool : M.foliage);
  setMat(mb, leaf);
  blob(mb, rng, px, cy + 0.30 * sc, pz, rad, 0.92 * sc, rad, 6);
  for (let i = 0; i < 3; i++) {
    const ang = a + (i / 3) * TAU + rr(rng, -0.4, 0.4);
    const off = rr(rng, 0.45, 0.85) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, cy + rr(rng, -0.15, 0.55) * sc, pz + Math.sin(ang) * off,
      rr(rng, 0.62, 0.95) * sc, rr(rng, 0.52, 0.78) * sc, rr(rng, 0.62, 0.95) * sc, 6);
  }
}

// Park tree: no pit, taller, branching, a fuller canopy.
export function appendParkTree(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.45, 3.2);
  const a = rr(rng, 0, TAU);

  const h0 = 1.70 * sc, h1 = 2.10 * sc;
  trunk(mb, rng, px, py, pz, 0.28 * sc, 0.185 * sc, 0.115 * sc, h0, h1);

  const forkY = py + h0 + h1 * 0.55;
  for (let i = 0; i < 2; i++) {
    const ang = a + i * Math.PI + rr(rng, -0.5, 0.5);
    beam(mb,
      px, forkY, pz,
      px + Math.cos(ang) * 0.85 * sc, forkY + rr(rng, 0.85, 1.35) * sc,
      pz + Math.sin(ang) * 0.85 * sc,
      0.055 * sc, 0.055 * sc, F_SIDES);
  }

  // Canopy: the centre clump is deliberately NOT much bigger than the satellites, otherwise it
  // swallows them and the tree reads as one smooth cone instead of a lumpy crown.
  const cy = py + h0 + h1 + 0.35 * sc;
  const rad = 1.42 * sc;
  const leaf = rnd(rng) < 0.45 ? M.foliageWarm : (rnd(rng) < 0.5 ? M.foliageCool : M.foliage);
  setMat(mb, leaf);
  blob(mb, rng, px, cy + 0.30 * sc, pz, rad, 1.10 * sc, rad, 6);
  for (let i = 0; i < 4; i++) {
    const ang = a + (i / 4) * TAU + rr(rng, -0.40, 0.40);
    const off = rr(rng, 0.85, 1.50) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, cy + rr(rng, -0.55, 0.75) * sc, pz + Math.sin(ang) * off,
      rr(rng, 0.95, 1.45) * sc, rr(rng, 0.70, 1.10) * sc, rr(rng, 0.95, 1.45) * sc, 6);
  }
}

export function appendShrub(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.3, 3.0);
  setMat(mb, rnd(rng) < 0.5 ? M.foliage : M.foliageCool);
  const n = rnd(rng) < 0.5 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const off = rr(rng, 0.0, 0.30) * sc;
    // See appendPlanter: centre height is derived from the vertical radius so the clump always
    // beds into the ground rather than floating over it.
    const vy = rr(rng, 0.30, 0.46) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, py + vy * 0.42, pz + Math.sin(ang) * off,
      rr(rng, 0.34, 0.52) * sc, vy, rr(rng, 0.34, 0.52) * sc, 5);
  }
}

// Trunk plus a two-stage taper, taller and thicker than the street version. Shared by every
// island tree species.
function boughs(mb, rng, px, py, pz, sc, a, spread, rise, n) {
  setMat(mb, rnd(rng) < 0.4 ? M.barkPale : M.bark);
  for (let i = 0; i < n; i++) {
    const ang = a + (i / n) * TAU + rr(rng, -0.42, 0.42);
    beam(mb, px, py, pz,
      px + Math.cos(ang) * spread * sc, py + rise * sc, pz + Math.sin(ang) * spread * sc,
      0.062 * sc, 0.062 * sc, F_SIDES);
  }
}

/**
 * Mature parkland tree. `species`: 0 broadleaf (maple, oak — round crown), 1 cottonwood (tall,
 * narrow, the island shelterbelts), 2 weeping willow (short bole, wide drooping crown).
 *
 * Bigger than appendParkTree and built for DISTANCE: these carry the islands' silhouette from
 * two kilometres out, so the crown gets the vertices and the bole does not.
 */
export function appendCanopyTree(mb, rng, x, y, z, scale, species) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.5, 3.4);
  const sp = ((fin(species, 0) | 0) % 3 + 3) % 3;
  const a = rr(rng, 0, TAU);
  const leaf = rnd(rng) < 0.42 ? M.foliageWarm : (rnd(rng) < 0.52 ? M.foliageCool : M.foliage);

  if (sp === 1) {
    // Cottonwood / Lombardy poplar: a column. One tall bole and a narrow stack of clumps.
    const h0 = 3.2 * sc, h1 = 4.4 * sc;
    trunk(mb, rng, px, py, pz, 0.26 * sc, 0.19 * sc, 0.10 * sc, h0, h1);
    setMat(mb, leaf);
    for (let i = 0; i < 3; i++) {
      const cy = py + h0 + h1 * (0.18 + i * 0.34);
      const r = (1.05 - i * 0.22) * sc;
      blob(mb, rng, px + rr(rng, -0.22, 0.22) * sc, cy, pz + rr(rng, -0.22, 0.22) * sc,
        r, 1.35 * sc, r, 7);
    }
    return;
  }
  if (sp === 2) {
    // Willow: a short heavy bole, then a wide crown whose clumps hang BELOW their attachment so
    // the canopy sweeps down toward the water it always stands beside.
    const h0 = 1.55 * sc, h1 = 1.30 * sc;
    trunk(mb, rng, px, py, pz, 0.42 * sc, 0.30 * sc, 0.20 * sc, h0, h1);
    boughs(mb, rng, px, py + h0 + h1 * 0.6, pz, sc, a, 1.05, 0.95, 3);
    setMat(mb, leaf);
    const cy = py + h0 + h1 + 0.55 * sc;
    blob(mb, rng, px, cy, pz, 1.65 * sc, 1.05 * sc, 1.65 * sc, 8);
    for (let i = 0; i < 4; i++) {
      const ang = a + (i / 4) * TAU + rr(rng, -0.35, 0.35);
      const off = rr(rng, 1.20, 1.95) * sc;
      blob(mb, rng, px + Math.cos(ang) * off, cy - rr(rng, 0.55, 1.15) * sc,
        pz + Math.sin(ang) * off,
        rr(rng, 0.85, 1.25) * sc, rr(rng, 0.95, 1.45) * sc, rr(rng, 0.85, 1.25) * sc, 7);
    }
    return;
  }
  // Broadleaf: the default island canopy.
  const h0 = 2.35 * sc, h1 = 2.55 * sc;
  trunk(mb, rng, px, py, pz, 0.40 * sc, 0.27 * sc, 0.165 * sc, h0, h1);
  boughs(mb, rng, px, py + h0 + h1 * 0.55, pz, sc, a, 1.15, 1.25, 2);
  setMat(mb, leaf);
  const cy = py + h0 + h1 + 0.60 * sc;
  blob(mb, rng, px, cy + 0.35 * sc, pz, 1.95 * sc, 1.40 * sc, 1.95 * sc, 8);
  for (let i = 0; i < 3; i++) {
    const ang = a + (i / 3) * TAU + rr(rng, -0.40, 0.40);
    const off = rr(rng, 1.10, 1.85) * sc;
    blob(mb, rng, px + Math.cos(ang) * off, cy + rr(rng, -0.45, 0.85) * sc,
      pz + Math.sin(ang) * off,
      rr(rng, 1.05, 1.60) * sc, rr(rng, 0.80, 1.25) * sc, rr(rng, 1.05, 1.60) * sc, 7);
  }
}

/**
 * A run of clipped hedge along local Z. Built as a chain of overlapping lobes rather than one
 * long box, because a hedge read end-on is a silhouette of bumps and a box is a wall.
 * `len` is the run length, `h` the trimmed height, `w` the width.
 */
export function appendHedgeRun(mb, rng, x, y, z, yaw, len, h, w) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 6), 0.6, 90);
  const H = clamp(fin(h, 1.35), 0.4, 3.4);
  const W = clamp(fin(w, 0.85), 0.25, 3.0);
  const c = Math.cos(a), s = Math.sin(a);
  const n = Math.max(1, Math.round(L / Math.max(0.9, W * 1.35)));

  setMat(mb, M.hedgeLeaf);
  for (let i = 0; i < n; i++) {
    const lz = -L * 0.5 + L * ((i + 0.5) / n);
    const bx = px + lz * s, bz = pz + lz * c;
    const jitter = 0.88 + 0.24 * hash2(bx, bz);
    blob(mb, rng, bx, py + H * 0.52 * jitter, bz,
      W * 0.55, H * 0.54 * jitter, L / n * 0.78, 6);
  }
}

/** A planted bed: turned soil, a low kerb of edging brick, and clumps of bedding in three hues. */
export function appendFlowerBed(mb, rng, x, y, z, yaw, w, d) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3), 0.5, 26);
  const D = clamp(fin(d, 2), 0.5, 26);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.granite);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, 0.11, hd, F_NOBOT);
  setMat(mb, M.bedSoil);
  quadUp(mb, px, py, pz, c, s, -hw + 0.10, -hd + 0.10, hw - 0.10, hd - 0.10, 0.14);

  const n = clamp(Math.round(W * D * 0.55), 2, 18);
  for (let i = 0; i < n; i++) {
    const lx = rr(rng, -hw + 0.22, hw - 0.22);
    const lz = rr(rng, -hd + 0.22, hd - 0.22);
    const bx = px + lx * c + lz * s, bz = pz - lx * s + lz * c;
    const u = rnd(rng);
    setMat(mb, u < 0.42 ? M.bloomWarm : (u < 0.72 ? M.bloomCool : M.bloomPale));
    blob(mb, rng, bx, py + 0.24, bz, 0.30, 0.16, 0.30, 5);
  }
}

/** Marram tuft on the back of a beach. Cheap: three flat blades, no stem. */
export function appendBeachGrass(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.3, 3.0);
  setMat(mb, M.duneGrass);
  const n = rnd(rng) < 0.5 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const lean = rr(rng, 0.18, 0.46) * sc;
    beam(mb, px, py, pz,
      px + Math.cos(ang) * lean, py + rr(rng, 0.44, 0.86) * sc, pz + Math.sin(ang) * lean,
      0.085 * sc, 0.012, F_PLATEZ | F_PX | F_NX);
  }
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendStreetTree,
  appendParkTree,
  appendShrub,
  appendCanopyTree,
  appendHedgeRun,
  appendFlowerBed,
  appendBeachGrass,
});
