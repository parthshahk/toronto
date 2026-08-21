// src/props/furniture.js — street furniture and ground hardware: seating, waste, cycle parking,
// hydrants, post, news boxes, meters, shelters, manholes, gratings, cabinets, patios, and the
// surveyed classes the procedural pass had no builder for (stop flags, drinking fountains,
// vending machines, payphones, bike corrals, fountain basins).
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// The surveyed pieces exist because data/toronto.json carries 21,974 surveyed OSM NODES, including
// the wall-mounted fixtures the unit survey turns out to be full of (231 vending machines, 65
// ATMs, 58 payphones) — premises in OSM, street furniture in real life.

import { TAU, clamp } from '../core/math.js';
import { ALIGN, VALIGN, appendText } from '../render/text.js';
import {
  F_ALL, F_BLADEX, F_BLADEZ, F_NOBOT, F_NX, F_NZ, F_PLATEX, F_PLATEZ, F_PX, F_PY, F_PZ, F_SIDES,
  beamL, blob, boxL, discX, discY, fin, finAngle, frustL, hullL, pickOf, quadNZ, quadPX, quadPZ,
  quadUp, rnd, rr, setL, setMat, torusY,
} from './kit.js';
import { CABINET_COLOURS, DUMPSTER_COLOURS, M, NEWSBOX_COLOURS } from './materials.js';

// Slatted street bench: length along local Z, seat facing +X.
export function appendBench(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  // Open end frames — a front leg and a back leg that carries on up into the backrest. A single
  // full-height end panel is cheaper but reads as a solid slab from any distance; the gap under
  // the seat is most of what makes this look like a bench.
  setMat(mb, M.castIron);
  for (let i = 0; i < 2; i++) {
    const zc = i === 0 ? -0.80 : 0.80;
    boxL(mb, px, py, pz, c, s, 0.13, 0.01, zc - 0.028, 0.29, 0.47, zc + 0.028, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -0.30, 0.01, zc - 0.028, -0.16, 0.92, zc + 0.028, F_NOBOT);
  }

  setMat(mb, M.woodSlat);
  for (let i = 0; i < 3; i++) {
    const x0 = -0.27 + i * 0.20;
    boxL(mb, px, py, pz, c, s, x0, 0.43, -0.87, x0 + 0.16, 0.48, 0.87, F_NOBOT);
  }
  for (let i = 0; i < 2; i++) {
    const y0 = 0.60 + i * 0.15;
    boxL(mb, px, py, pz, c, s, -0.29, y0, -0.87, -0.25, y0 + 0.12, 0.87, F_BLADEX);
  }
}

// Two-stream bin (waste + recycling) under one curved hood — the standard downtown unit.
export function appendLitterBin(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.binBody);
  boxL(mb, px, py, pz, c, s, -0.29, 0.00, -0.55, 0.29, 0.92, -0.02, F_NOBOT);
  setMat(mb, M.binRecycle);
  boxL(mb, px, py, pz, c, s, -0.29, 0.00, 0.02, 0.29, 0.92, 0.55, F_NOBOT);

  // Two-stage taper so the hood reads as curved rather than as a lid.
  setMat(mb, M.binHood);
  frustL(mb, px, py, pz, c, s, 0.92, 1.02,
    -0.31, -0.57, 0.31, 0.57, -0.29, -0.55, 0.29, 0.55, F_SIDES);
  frustL(mb, px, py, pz, c, s, 1.02, 1.13,
    -0.29, -0.55, 0.29, 0.55, -0.17, -0.46, 0.17, 0.46, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.28, 0.92, -0.015, 0.28, 1.16, 0.015, F_PLATEZ);

  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.294, 0.58, -0.46, 0.86, -0.10);
  quadPX(mb, px, py, pz, c, s, 0.294, 0.58, 0.10, 0.86, 0.46);
}

// Toronto's ring-and-post rack: a short post with a horizontal ring.
export function appendBikeRing(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);

  setMat(mb, M.galv);
  mb.cylinder(px, py - 0.04, pz, 0.056, 0.050, 0.90, 6, a, false);
  discY(mb, px, py + 0.86, pz, 0.050, 6, a, true);
  torusY(mb, px, py + 0.60, pz, 0.235, 0.028, 7, 3, a);
}

export function appendBollard(mb, x, y, z) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  setMat(mb, M.castIron);
  mb.cylinder(px, py - 0.04, pz, 0.098, 0.084, 0.99, 6, 0, false);
  discY(mb, px, py + 0.95, pz, 0.084, 6, 0, true);
}

// Precast planter with soil and a couple of shrub clumps. `s` scales the tub.
export function appendPlanter(mb, rng, x, y, z, s) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(s, 1.1), 0.5, 3.2);
  const hh = 0.60 * sc;

  setMat(mb, M.concrete);
  frustL(mb, px, py, pz, 1, 0, 0, hh,
    -0.40 * sc, -0.40 * sc, 0.40 * sc, 0.40 * sc,
    -0.48 * sc, -0.48 * sc, 0.48 * sc, 0.48 * sc, F_NOBOT);
  setMat(mb, M.soil);
  quadUp(mb, px, py, pz, 1, 0, -0.43 * sc, -0.43 * sc, 0.43 * sc, 0.43 * sc, hh + 0.02);

  setMat(mb, M.foliage);
  const n = rnd(rng) < 0.45 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const rad = rr(rng, 0.03, 0.26) * sc;
    // Vertical radius first, then a centre height under half of it: blob()'s lower apex reaches
    // 0.64..0.92 of the vertical radius, so this guarantees the clump beds into the soil instead
    // of hovering above it.
    const vy = rr(rng, 0.18, 0.28) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * rad, py + hh + vy * 0.40, pz + Math.sin(ang) * rad,
      rr(rng, 0.24, 0.36) * sc, vy, rr(rng, 0.24, 0.36) * sc, 5);
  }
}

// Hydrant: barrel, shoulder flange, bonnet and two side outlets. The outlets read from the far
// side of a street even when the barrel does not.
export function appendHydrant(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.hydBody);
  mb.cylinder(px, py - 0.03, pz, 0.135, 0.110, 0.59, 6, a, false);
  mb.cylinder(px, py + 0.56, pz, 0.152, 0.126, 0.09, 6, a, false);
  // Side outlets.
  beamL(mb, px, py, pz, c, s, 0, 0.42, 0.085, 0, 0.42, 0.225, 0.052, 0.052, F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0, 0.42, -0.085, 0, 0.42, -0.225, 0.052, 0.052, F_SIDES | F_NZ);

  setMat(mb, M.hydCap);
  mb.cylinder(px, py + 0.65, pz, 0.128, 0.072, 0.17, 6, a, false);
  discY(mb, px, py + 0.82, pz, 0.072, 6, a, true);
}

// Canada Post street letter box.
export function appendMailbox(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.22, 0.00, -0.24, 0.22, 0.14, 0.24, F_NOBOT);
  setMat(mb, M.postRed);
  boxL(mb, px, py, pz, c, s, -0.25, 0.14, -0.31, 0.25, 1.00, 0.31, F_SIDES);
  frustL(mb, px, py, pz, c, s, 1.00, 1.20,
    -0.25, -0.31, 0.25, 0.31, -0.15, -0.23, 0.17, 0.23, F_NOBOT);
  // Pull flap and slot.
  boxL(mb, px, py, pz, c, s, 0.25, 0.78, -0.22, 0.30, 0.86, 0.22, F_PX | F_PY);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.253, 0.86, -0.20, 0.95, 0.20);
}

// Newspaper / listings vending box. rng picks the livery.
export function appendNewsBox(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.16, 0.00, -0.16, 0.16, 0.22, 0.16, F_SIDES);
  setMat(mb, pickOf(rng, NEWSBOX_COLOURS));
  boxL(mb, px, py, pz, c, s, -0.23, 0.22, -0.21, 0.23, 0.98, 0.21, F_NOBOT);
  // Hood, sloping down toward the front.
  setL(0, -0.23, 0.98, -0.21); setL(1, 0.23, 0.98, -0.21);
  setL(2, -0.23, 1.22, -0.21); setL(3, 0.23, 1.06, -0.21);
  setL(4, -0.23, 0.98, 0.21); setL(5, 0.23, 0.98, 0.21);
  setL(6, -0.23, 1.22, 0.21); setL(7, 0.23, 1.06, 0.21);
  hullL(mb, px, py, pz, c, s, F_NOBOT);

  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.233, 0.54, -0.17, 0.94, 0.17);
}

// Pay-and-display machine: slim column, keypad head, solar cap.
export function appendParkingMachine(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.15, 0.00, -0.21, 0.15, 0.10, 0.21, F_NOBOT);
  setMat(mb, M.cabGrey);
  frustL(mb, px, py, pz, c, s, 0.10, 1.05,
    -0.12, -0.17, 0.12, 0.17, -0.11, -0.155, 0.11, 0.155, F_SIDES);
  boxL(mb, px, py, pz, c, s, -0.16, 1.05, -0.22, 0.16, 1.62, 0.22, F_NOBOT);
  setMat(mb, M.screen);
  quadPX(mb, px, py, pz, c, s, 0.163, 1.20, -0.16, 1.46, 0.16);
  setMat(mb, M.greenP);
  quadPX(mb, px, py, pz, c, s, 0.163, 1.49, -0.13, 1.59, 0.13);
  // Solar cap, tilted up toward the south.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, -0.14, 1.64, 0, 0.20, 1.75, 0, 0.20, 0.014, F_BLADEX);
}

// Glazed transit shelter with a backlit end panel. Length runs along local Z, opening at +X.
export function appendTransitShelter(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(len, 4.6), 2.4, 9.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.steel);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? 0.74 : -0.74;
    const cz = (i & 2) ? hl - 0.07 : -(hl - 0.07);
    boxL(mb, px, py, pz, c, s, cx - 0.045, 0.00, cz - 0.045, cx + 0.045, 2.42, cz + 0.045,
      F_SIDES);
  }
  // Back header rail.
  boxL(mb, px, py, pz, c, s, -0.80, 2.28, -hl, -0.68, 2.40, hl, F_SIDES);

  setMat(mb, M.glass);
  boxL(mb, px, py, pz, c, s, -0.757, 0.28, -(hl - 0.10), -0.727, 2.28, hl - 0.10, F_PLATEX);
  boxL(mb, px, py, pz, c, s, -0.72, 0.28, hl - 0.085, 0.70, 2.28, hl - 0.055, F_PLATEZ);

  // Backlit advertising panel closing the other end.
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.70, 0.22, -(hl - 0.02), 0.70, 2.34, -(hl - 0.17), F_NOBOT);
  setMat(mb, M.adPanel);
  quadNZ(mb, px, py, pz, c, s, -(hl - 0.016), -0.62, 0.34, 0.62, 2.22);
  quadPZ(mb, px, py, pz, c, s, -(hl - 0.156), -0.62, 0.34, 0.62, 2.22);

  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.95, 2.42, -(hl + 0.18), 0.95, 2.57, hl + 0.18, F_ALL);
}

// Streetcar island platform: raised slab, tactile edge, light canopy and a back rail.
export function appendPlatformShelter(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(len, 12.0), 4.0, 40.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -1.35, 0.00, -hl, 1.35, 0.19, hl, F_NOBOT);
  setMat(mb, M.granite);
  quadUp(mb, px, py, pz, c, s, 1.03, -hl, 1.33, hl, 0.192);
  quadUp(mb, px, py, pz, c, s, -1.33, -hl, -1.03, hl, 0.192);

  setMat(mb, M.steel);
  const chl = Math.min(hl - 0.30, 3.0);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? 0.55 : -0.55;
    const cz = (i & 2) ? chl : -chl;
    boxL(mb, px, py, pz, c, s, cx - 0.042, 0.19, cz - 0.042, cx + 0.042, 2.56, cz + 0.042,
      F_SIDES);
  }
  boxL(mb, px, py, pz, c, s, -1.15, 2.56, -(chl + 0.35), 1.15, 2.72, chl + 0.35, F_ALL);

  setMat(mb, M.glass);
  boxL(mb, px, py, pz, c, s, -0.50, 0.19, -(chl + 0.02), 1.10, 1.95, -(chl - 0.01), F_PLATEZ);

  // Back rail along the track side.
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -1.28, 0.95, -hl, -1.20, 1.03, hl, F_SIDES);
  for (let i = 0; i < 2; i++) {
    const cz = i === 0 ? -hl * 0.5 : hl * 0.5;
    boxL(mb, px, py, pz, c, s, -1.27, 0.19, cz - 0.032, -1.21, 1.03, cz + 0.032, F_SIDES);
  }
}

export function appendManhole(mb, x, y, z) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  // Two stacked discs: the seating ring and the cover proper. Both sit clear of the carriageway
  // plane so they cannot z-fight with the road ribbon the caller placed them on.
  setMat(mb, M.castIron);
  discY(mb, px, py + 0.014, pz, 0.415, 8, 0, true);
  setMat(mb, M.grateIron);
  discY(mb, px, py + 0.030, pz, 0.355, 10, 0.3, true);
}

// Kerbside catch basin. Long axis along local Z, against the kerb at -X.
export function appendGrate(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.32, -0.03, -0.42, 0.32, 0.025, 0.42, F_NOBOT);
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -0.26, -0.36, 0.26, 0.36, 0.004);
  setMat(mb, M.grateIron);
  for (let i = 0; i < 3; i++) {
    const z0 = -0.30 + i * 0.20;
    quadUp(mb, px, py, pz, c, s, -0.26, z0, 0.26, z0 + 0.10, 0.028);
  }
}

// Traffic controller / telecom cabinet on its pad. rng varies size and livery.
export function appendUtilityBox(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const w = rr(rng, 0.44, 0.62);
  const d = rr(rng, 0.28, 0.38);
  const hh = rr(rng, 1.05, 1.40);

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -w - 0.08, 0.00, -d - 0.08, w + 0.08, 0.09, d + 0.08, F_NOBOT);
  setMat(mb, pickOf(rng, CABINET_COLOURS));
  frustL(mb, px, py, pz, c, s, 0.09, hh,
    -w, -d, w, d, -w + 0.015, -d + 0.012, w - 0.015, d - 0.012, F_SIDES);
  boxL(mb, px, py, pz, c, s, -w - 0.04, hh, -d - 0.04, w + 0.04, hh + 0.075, d + 0.04, F_ALL);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, w - 0.008, 0.18, -d + 0.06, hh - 0.10, d - 0.06);
}

// Cafe patio: square bistro table, two chairs and, most of the time, a parasol. Toronto's patio
// season is short and extremely visible while it lasts.
export function appendPatioSet(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  mb.cylinder(px, py, pz, 0.22, 0.055, 0.70, 5, a, false);
  setMat(mb, M.granite);
  boxL(mb, px, py, pz, c, s, -0.36, 0.70, -0.36, 0.36, 0.745, 0.36, F_NOBOT);

  // Two chairs across the table.
  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? 1 : -1;
    const cx = dir * 0.72;
    setMat(mb, M.castIron);
    frustL(mb, px, py, pz, c, s, 0.0, 0.44,
      cx - 0.19, -0.19, cx + 0.19, 0.19, cx - 0.14, -0.14, cx + 0.14, 0.14, F_SIDES);
    setMat(mb, M.woodSlat);
    boxL(mb, px, py, pz, c, s, cx - 0.22, 0.44, -0.22, cx + 0.22, 0.485, 0.22, F_NOBOT);
    const bx = cx + dir * 0.20;
    setL(0, bx - 0.02, 0.485, -0.20); setL(1, bx + 0.02, 0.485, -0.20);
    setL(2, bx + dir * 0.10 - 0.02, 0.90, -0.20); setL(3, bx + dir * 0.10 + 0.02, 0.90, -0.20);
    setL(4, bx - 0.02, 0.485, 0.20); setL(5, bx + 0.02, 0.485, 0.20);
    setL(6, bx + dir * 0.10 - 0.02, 0.90, 0.20); setL(7, bx + dir * 0.10 + 0.02, 0.90, 0.20);
    hullL(mb, px, py, pz, c, s, F_PLATEX);
  }

  if (rnd(rng) < 0.65) {
    setMat(mb, M.galvPale);
    mb.cylinder(px, py + 0.70, pz, 0.032, 0.026, 1.66, 5, a, false);
    setMat(mb, rnd(rng) < 0.5 ? M.canvas : M.canvasRed);
    const rimY = py + 2.02;
    mb.cylinder(px, rimY, pz, 1.18, 0.05, 0.34, 6, a, false);
    discY(mb, px, rimY, pz, 1.18, 6, a, false);
  }
}

// A-frame sandwich board outside a shop. The chalk face is the panel's own outer face, so it
// catches light exactly like the board it is.
export function appendSandwichBoard(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hh = 0.86 + 0.16 * rnd(rng);
  const spread = 0.24 + 0.06 * rnd(rng);
  const hw = 0.28 + 0.05 * rnd(rng);

  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? 1 : -1;
    const x0 = dir * spread;
    setL(0, x0 - 0.014, 0.0, -hw); setL(1, x0 + 0.014, 0.0, -hw);
    setL(2, -0.014, hh, -hw); setL(3, 0.014, hh, -hw);
    setL(4, x0 - 0.014, 0.0, hw); setL(5, x0 + 0.014, 0.0, hw);
    setL(6, -0.014, hh, hw); setL(7, 0.014, hh, hw);
    const outer = dir > 0 ? F_PX : F_NX;
    setMat(mb, M.dark);
    hullL(mb, px, py, pz, c, s, F_ALL & ~outer);
    setMat(mb, M.chalk);
    hullL(mb, px, py, pz, c, s, outer);
  }
  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.05, hh - 0.02, -hw, 0.05, hh + 0.05, hw, F_NOBOT);
}

// Service-area dumpster: tapered body, rib band, two sloped lids, fork pockets and castors.
export function appendDumpster(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = 0.86 + 0.30 * rnd(rng);
  const hh = 1.06 + 0.22 * rnd(rng);

  setMat(mb, pickOf(rng, DUMPSTER_COLOURS));
  frustL(mb, px, py, pz, c, s, 0.18, hh,
    -0.56, -hl * 0.90, 0.56, hl * 0.90, -0.68, -hl, 0.68, hl, F_SIDES);
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -0.66, -hl + 0.02, 0.66, hl - 0.02, hh - 0.06);

  setMat(mb, M.grateIron);
  boxL(mb, px, py, pz, c, s, -0.63, hh * 0.52, -hl * 0.96, 0.63, hh * 0.52 + 0.07, hl * 0.96,
    F_SIDES);

  // Two lids, hinged at the back and sloping toward the front.
  setMat(mb, M.binHood);
  for (let i = 0; i < 2; i++) {
    const z0 = i === 0 ? -hl : 0.01;
    const z1 = i === 0 ? -0.01 : hl;
    setL(0, -0.70, hh + 0.10, z0); setL(1, 0.70, hh - 0.02, z0);
    setL(2, -0.70, hh + 0.16, z0); setL(3, 0.70, hh + 0.04, z0);
    setL(4, -0.70, hh + 0.10, z1); setL(5, 0.70, hh - 0.02, z1);
    setL(6, -0.70, hh + 0.16, z1); setL(7, 0.70, hh + 0.04, z1);
    hullL(mb, px, py, pz, c, s, F_NOBOT);
  }

  setMat(mb, M.dark);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hl * 0.46;
    boxL(mb, px, py, pz, c, s, -0.60, 0.18, cz - 0.13, 0.60, 0.34, cz + 0.13, F_BLADEZ);
  }

  setMat(mb, M.tyre);
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const cz = (i & 2) ? hl * 0.74 : -hl * 0.74;
    discX(mb, px, py, pz, c, s, side * 0.50, 0.11, cz, 0.11, 5, side > 0);
  }
}

/** Timber picnic table with attached benches. Long axis along local Z. */
export function appendPicnicTable(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = rr(rng, 0.85, 1.05);

  setMat(mb, M.woodSlat);
  boxL(mb, px, py, pz, c, s, -0.38, 0.71, -hl, 0.38, 0.76, hl, F_NOBOT);
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * 0.62;
    boxL(mb, px, py, pz, c, s, sx - 0.14, 0.43, -hl, sx + 0.14, 0.475, hl, F_NOBOT);
  }
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (hl - 0.22);
    beamL(mb, px, py, pz, c, s, -0.76, 0.0, lz, 0.34, 0.72, lz, 0.035, 0.035, F_ALL);
    beamL(mb, px, py, pz, c, s, 0.76, 0.0, lz, -0.34, 0.72, lz, 0.035, 0.035, F_ALL);
  }
}

/** Lifeguard chair: a tall timber seat on splayed legs, facing local +X (out to the water). */
export function appendLifeguardChair(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.woodSlat);
  for (let i = 0; i < 4; i++) {
    const sx = (i & 1) ? 0.42 : -0.42, sz = (i & 2) ? 0.42 : -0.42;
    beamL(mb, px, py, pz, c, s, sx * 1.55, 0, sz * 1.55, sx, 1.72, sz, 0.045, 0.045, F_ALL);
  }
  boxL(mb, px, py, pz, c, s, -0.46, 1.72, -0.46, 0.46, 1.80, 0.46, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.50, 1.80, -0.46, -0.42, 2.52, 0.46, F_NOBOT);
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const sz = (k === 0 ? -1 : 1) * 0.46;
    beamL(mb, px, py, pz, c, s, -0.46, 2.18, sz, 0.46, 2.18, sz, 0.026, 0.026, F_ALL);
  }
}

/**
 * A TTC stop: the pole and the red flag sign, with the route number lettered on it. This is the
 * single most common transit object on the street — 304 bus stops and 287 streetcar stops in the
 * survey — and until now the city had shelters and no stops.
 * Cost: ~90 verts. @returns {number} vertices appended
 */
export function appendStopFlag(mb, x, y, z, yaw, label, opts) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const o = opts || null;

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.05, pz, 0.045, 0.040, 2.95, 6, a, false);
  discY(mb, px, py + 2.90, pz, 0.040, 6, a, true);
  setMat(mb, M.ttcRed);
  boxL(mb, px, py, pz, c, s, -0.012, 2.06, -0.22, 0.012, 2.76, 0.22, F_BLADEX);
  setMat(mb, M.ttcCream);
  boxL(mb, px, py, pz, c, s, -0.018, 2.12, -0.17, 0.018, 2.44, 0.17, F_PLATEX);

  if (o && o.textMb && o.font && typeof label === 'string' && label) {
    const nx = c, nz = -s;
    const ux = -s, uz = -c;
    for (let k = 0; k < 2; k++) {
      const sg = k === 0 ? 1 : -1;
      appendText(o.textMb, o.font, label, {
        x: px + nx * 0.026 * sg, y: py + 2.28, z: pz + nz * 0.026 * sg,
        rx: ux * sg, ry: 0, rz: uz * sg, nx: nx * sg, ny: 0, nz: nz * sg,
        h: 0.15, align: ALIGN.CENTER, vAlign: VALIGN.MIDDLE,
        maxWidth: 0.30, minScale: 0.5, lift: 0.005,
        r: 0.030, g: 0.032, b: 0.036, rough: 0.62,
      });
    }
  }
  return mb.count - before;
}

/** A cast drinking fountain: pedestal, bowl and bubbler. 62 verts. */
export function appendDrinkingFountain(mb, x, y, z, yaw) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  setMat(mb, M.castIron);
  mb.cylinder(px, py - 0.03, pz, 0.19, 0.15, 0.86, 7, a, false);
  setMat(mb, M.railSilver);
  mb.cylinder(px, py + 0.83, pz, 0.24, 0.24, 0.10, 7, a, true);
  setMat(mb, M.dark);
  discY(mb, px, py + 0.905, pz, 0.18, 7, a, true);
  setMat(mb, M.chrome);
  mb.cylinder(px + Math.cos(a) * 0.11, py + 0.93, pz - Math.sin(a) * 0.11, 0.02, 0.02, 0.10, 4, a, true);
  return mb.count - before;
}

/** A glass-fronted vending machine set against a wall; local +X faces the street. 48 verts. */
export function appendVendingMachine(mb, rng, x, y, z, yaw) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const w = rr(rng, 0.50, 0.62);
  setMat(mb, M.vendFront);
  boxL(mb, px, py, pz, c, s, 0, 0, -w, 0.72, 1.86, w, F_NOBOT);
  setMat(mb, M.adPanel);
  quadPX(mb, px, py, pz, c, s, 0.725, 0.42, -w + 0.06, 1.72, w - 0.06);
  return mb.count - before;
}

/** A payphone hood on a post. 44 verts. */
export function appendPayphone(mb, x, y, z, yaw) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  setMat(mb, M.poleGrey);
  boxL(mb, px, py, pz, c, s, -0.05, 0, -0.05, 0.05, 1.02, 0.05, F_SIDES);
  setMat(mb, M.alum);
  boxL(mb, px, py, pz, c, s, -0.16, 1.02, -0.31, 0.24, 1.92, 0.31, F_NOBOT);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.245, 1.16, -0.25, 1.80, 0.25);
  return mb.count - before;
}

/**
 * A bike corral: `n` of Toronto's ring-and-post racks in a row along local Z, at the real
 * 0.9 m pitch. OSM maps a whole corral as one node, so one node is a rack of bikes, not a ring.
 * @returns {number} vertices appended
 */
export function appendBikeCorral(mb, x, y, z, yaw, n) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const k = clamp(Math.round(fin(n, 1)), 1, 6) | 0;
  for (let i = 0; i < k; i++) {
    const lz = (i - (k - 1) * 0.5) * 0.92;
    appendBikeRing(mb, px + lz * s, py, pz + lz * c, a);
  }
  return mb.count - before;
}

/** A low civic fountain basin with a still water disc and a centre jet. ~90 verts. */
export function appendFountainBasin(mb, x, y, z, r) {
  if (!mb) return 0;
  const before = mb.count;
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const rr0 = clamp(fin(r, 1.4), 0.6, 6.0);
  setMat(mb, M.granite);
  mb.cylinder(px, py - 0.04, pz, rr0, rr0, 0.46, 12, 0, false);
  mb.cylinder(px, py + 0.42, pz, rr0, rr0 - 0.16, 0.06, 12, 0, true);
  // The water: dark, mirror-smooth and NOT emissive — it is a surface, not a lamp.
  setMat(mb, M.glass);
  discY(mb, px, py + 0.34, pz, rr0 - 0.17, 12, 0, true);
  setMat(mb, M.granite);
  mb.cylinder(px, py + 0.34, pz, rr0 * 0.18, rr0 * 0.12, 0.34, 8, 0, true);
  return mb.count - before;
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendBench,
  appendLitterBin,
  appendBikeRing,
  appendBollard,
  appendPlanter,
  appendHydrant,
  appendMailbox,
  appendNewsBox,
  appendParkingMachine,
  appendTransitShelter,
  appendPlatformShelter,
  appendManhole,
  appendGrate,
  appendUtilityBox,
  appendPatioSet,
  appendSandwichBoard,
  appendDumpster,
  appendPicnicTable,
  appendLifeguardChair,
  appendStopFlag,
  appendDrinkingFountain,
  appendVendingMachine,
  appendPayphone,
  appendBikeCorral,
  appendFountainBasin,
});
