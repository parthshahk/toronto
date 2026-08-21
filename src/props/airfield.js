// src/props/airfield.js — Billy Bishop: runway, threshold and taxiway lighting, the approach bars
// out over the Western Gap, the windsock, hangars, aircraft, airstairs, ground-support carts and
// the mandatory-instruction signs.
//
// CONTRACT.md §6.1 and §8.3. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// Amendment 7 still governs. The ONLY emitters here are genuine light sources: runway edge,
// threshold and end lights, taxiway edge lights, and the approach bars. Aircraft, hangars and
// signs carry emissive 0.

import { TAU, clamp } from '../core/math.js';
import {
  F_ALL, F_NOBOT, F_NX, F_NY, F_NZ, F_PLATEX, F_PX, F_PY, F_PZ, F_SIDES, beamL, boxL, discX,
  discY, discZ, fin, finAngle, hash2, hullL, quadL, quadNX, quadNZ, quadPX, quadPZ, ringXY, rnd,
  setL, setMat,
} from './kit.js';
import { M } from './materials.js';

/**
 * One airfield light on its frangible base. `kind`: 0 runway edge (white), 1 threshold (green),
 * 2 runway end (red), 3 taxiway edge (blue). Genuine emitters, all four.
 */
export function appendRunwayLight(mb, x, y, z, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const k = (fin(kind, 0) | 0);
  const lens = k === 1 ? M.runwayGreen : (k === 2 ? M.runwayRed
    : (k === 3 ? M.taxiBlue : M.runwayEdge));

  setMat(mb, M.galv);
  mb.cylinder(px, py, pz, 0.115, 0.075, 0.20, 4, 0.4, false);
  setMat(mb, lens);
  mb.cylinder(px, py + 0.20, pz, 0.085, 0.070, 0.135, 4, 0.4, false);
  discY(mb, px, py + 0.335, pz, 0.070, 4, 0.4, true);
}

/**
 * One bar of the approach lighting system, out over the water off a runway threshold. A frangible
 * lattice mast carrying a crossbar of five lamps, at the height the bar has to be to stay level
 * with the runway as the ground falls away under it.
 */
export function appendApproachMast(mb, x, y, z, yaw, h, lamps) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const H = clamp(fin(h, 3.0), 0.6, 22.0);
  const n = clamp(fin(lamps, 5) | 0, 1, 9);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.galv);
  mb.cylinder(px, py - 1.2, pz, 0.16, 0.11, H + 1.2, 5, a, false);
  boxL(mb, px, py, pz, c, s, -0.07, H, -(n * 0.72) * 0.5, 0.07, H + 0.11, (n * 0.72) * 0.5,
    F_NOBOT);
  setMat(mb, M.approachLamp);
  for (let i = 0; i < n; i++) {
    const lz = (n === 1) ? 0 : (-(n - 1) * 0.36 + i * 0.72);
    boxL(mb, px, py, pz, c, s, -0.11, H + 0.11, lz - 0.13, 0.11, H + 0.36, lz + 0.13, F_NOBOT);
  }
}

/** Windsock on a mast. The sock hangs off local +X and tapers away from the mast. */
export function appendWindsock(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.galv);
  mb.cylinder(px, py, pz, 0.13, 0.085, 6.4, 6, a, false);
  boxL(mb, px, py, pz, c, s, -0.05, 6.20, -0.05, 0.72, 6.30, 0.05, F_NOBOT);
  ringXY(mb, px, py, pz, c, s, 0.72, 5.90, 0, 0.42, 0.030, 6);
  // Five bands: three orange, two white, tapering to the tail.
  for (let i = 0; i < 5; i++) {
    const x0 = 0.72 + i * 0.62, x1 = x0 + 0.62;
    const r0 = 0.42 - i * 0.055, r1 = 0.42 - (i + 1) * 0.055;
    setMat(mb, (i & 1) ? M.flagWhite : M.windsockFlag);
    setL(0, x0, 5.90 - r0, -r0); setL(1, x1, 5.90 - r1, -r1);
    setL(2, x0, 5.90 + r0, -r0); setL(3, x1, 5.90 + r1, -r1);
    setL(4, x0, 5.90 - r0, r0); setL(5, x1, 5.90 - r1, r1);
    setL(6, x0, 5.90 + r0, r0); setL(7, x1, 5.90 + r1, r1);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_PY | F_NY);
  }
}

/**
 * Aircraft hangar: a portal-framed steel shed with a shallow curved roof and a full-width sliding
 * door on local -X. `w` is the door span, `d` the depth, `h` the eaves height.
 */
export function appendHangar(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 34), 6, 140);
  const D = clamp(fin(d, 30), 6, 140);
  const H = clamp(fin(h, 9.5), 3.5, 26);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;
  const rise = clamp(H * 0.30, 1.2, 5.0);

  // Walls to the eaves, open at the top so the roof can arch over them.
  setMat(mb, M.hangarClad);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, H, hd, F_PX | F_PZ | F_NZ);
  // Curved roof, as a fan of quads across local Z with the crown over the middle.
  const seg = 6;
  const roofY = (t) => H + rise * Math.sin(Math.PI * clamp(t, 0, 1));
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const z0 = -hd + D * t0, z1 = -hd + D * t1;
    quadL(mb, px, py, pz, c, s,
      -hw, roofY(t1), z1, hw, roofY(t1), z1, hw, roofY(t0), z0, -hw, roofY(t0), z0);
  }
  // Gable infill above the eaves at each end.
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * hw;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const z0 = -hd + D * t0, z1 = -hd + D * t1;
      if (k === 0) {
        quadL(mb, px, py, pz, c, s, sx, H, z0, sx, H, z1, sx, roofY(t1), z1, sx, roofY(t0), z0);
      } else {
        quadL(mb, px, py, pz, c, s, sx, H, z1, sx, H, z0, sx, roofY(t0), z0, sx, roofY(t1), z1);
      }
    }
  }
  // The door: a sliding leaf set, recessed a little so the head beam reads.
  setMat(mb, M.hangarDoor);
  const dh = H * 0.86;
  quadNX(mb, px, py, pz, c, s, -hw + 0.14, 0.0, -hd + 0.35, dh, hd - 0.35);
  setMat(mb, M.hangarClad);
  quadNX(mb, px, py, pz, c, s, -hw, 0.0, -hd, H, -hd + 0.35);
  quadNX(mb, px, py, pz, c, s, -hw, 0.0, hd - 0.35, H, hd);
  quadNX(mb, px, py, pz, c, s, -hw, dh, -hd, H, hd);
  // Door leaf joints, and the track above them.
  setMat(mb, M.galv);
  const leaves = Math.max(2, Math.round(W / 9));
  for (let i = 1; i < leaves; i++) {
    const lz = -hd + 0.35 + (D - 0.70) * (i / leaves);
    boxL(mb, px, py, pz, c, s, -hw + 0.10, 0.0, lz - 0.055, -hw + 0.18, dh, lz + 0.055,
      F_NX | F_PZ | F_NZ);
  }
  boxL(mb, px, py, pz, c, s, -hw + 0.02, dh, -hd, -hw + 0.24, dh + 0.24, hd, F_NOBOT);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Regional turboprop on the apron — the aircraft Billy Bishop is known for. High wing, T-tail,
 * two nacelles with six-blade props. `len` is the fuselage length; the span follows from it.
 * Origin is the nose-wheel contact point at the pavement, nose along local +X.
 */
export function appendAirliner(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 32.8), 12, 60);
  const c = Math.cos(a), s = Math.sin(a);
  const r = L * 0.041;                 // fuselage radius
  const fy = L * 0.098;                // fuselage centreline above the pavement
  const span = L * 0.87;

  // Fuselage: four hull sections along local X, nose at +X.
  const sect = (x0, x1, r0, r1, y0, y1, mat) => {
    setMat(mb, mat);
    setL(0, x0, y0 - r0, -r0); setL(1, x1, y1 - r1, -r1);
    setL(2, x0, y0 + r0, -r0 * 0.92); setL(3, x1, y1 + r1, -r1 * 0.92);
    setL(4, x0, y0 - r0, r0); setL(5, x1, y1 - r1, r1);
    setL(6, x0, y0 + r0, r0 * 0.92); setL(7, x1, y1 + r1, r1 * 0.92);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_PY | F_NY);
  };
  sect(L * 0.44, L * 0.50, r * 0.78, r * 0.20, fy, fy + r * 0.16, M.aircraftGrey);   // radome
  sect(L * 0.20, L * 0.44, r, r * 0.78, fy, fy, M.aircraftWhite);
  sect(-L * 0.20, L * 0.20, r, r, fy, fy, M.aircraftWhite);
  sect(-L * 0.42, -L * 0.20, r * 0.86, r, fy + r * 0.10, fy, M.aircraftWhite);
  sect(-L * 0.50, -L * 0.42, r * 0.20, r * 0.86, fy + r * 0.55, fy + r * 0.10, M.aircraftWhite);

  // Cheatline and cabin windows: one dark band each side, flush with the skin.
  setMat(mb, M.cabinGlass);
  quadPZ(mb, px, py, pz, c, s, r * 0.995, -L * 0.20, fy + r * 0.30, L * 0.34, fy + r * 0.56);
  quadNZ(mb, px, py, pz, c, s, -r * 0.995, -L * 0.20, fy + r * 0.30, L * 0.34, fy + r * 0.56);
  quadPZ(mb, px, py, pz, c, s, r * 0.72, L * 0.36, fy + r * 0.34, L * 0.45, fy + r * 0.70);
  quadNZ(mb, px, py, pz, c, s, -r * 0.72, L * 0.36, fy + r * 0.34, L * 0.45, fy + r * 0.70);
  setMat(mb, M.aircraftTrim);
  quadPZ(mb, px, py, pz, c, s, r * 1.0, -L * 0.46, fy - r * 0.26, L * 0.44, fy - r * 0.10);
  quadNZ(mb, px, py, pz, c, s, -r * 1.0, -L * 0.46, fy - r * 0.26, L * 0.44, fy - r * 0.10);

  // High wing, one hull per side: swept a touch, tapered, with dihedral.
  const wy = fy + r * 0.86;
  setMat(mb, M.aircraftWhite);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const tipZ = sg * span * 0.5;
    setL(0, L * 0.10, wy - r * 0.13, 0); setL(1, -L * 0.10, wy - r * 0.13, 0);
    setL(2, L * 0.10, wy + r * 0.13, 0); setL(3, -L * 0.10, wy + r * 0.13, 0);
    setL(4, L * 0.055, wy + r * 0.22, tipZ); setL(5, -L * 0.035, wy + r * 0.22, tipZ);
    setL(6, L * 0.055, wy + r * 0.36, tipZ); setL(7, -L * 0.035, wy + r * 0.36, tipZ);
    hullL(mb, px, py, pz, c, s, k === 0 ? (F_ALL & ~F_PZ) : (F_ALL & ~F_NZ));
  }

  // Nacelles, spinners and props.
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const nz = sg * span * 0.175;
    setMat(mb, M.aircraftGrey);
    setL(0, -L * 0.13, wy - r * 0.46, nz - r * 0.34); setL(1, L * 0.16, wy - r * 0.30, nz - r * 0.30);
    setL(2, -L * 0.13, wy + r * 0.16, nz - r * 0.34); setL(3, L * 0.16, wy + r * 0.22, nz - r * 0.30);
    setL(4, -L * 0.13, wy - r * 0.46, nz + r * 0.34); setL(5, L * 0.16, wy - r * 0.30, nz + r * 0.30);
    setL(6, -L * 0.13, wy + r * 0.16, nz + r * 0.34); setL(7, L * 0.16, wy + r * 0.22, nz + r * 0.30);
    hullL(mb, px, py, pz, c, s, F_ALL);
    const sx = L * 0.16, sy = wy - r * 0.04;
    setMat(mb, M.aircraftTrim);
    for (let i = 0; i < 3; i++) {
      const th = hash2(px + nz, pz + i) * TAU + (i / 3) * TAU;
      const bl = span * 0.115;
      setMat(mb, M.propBlade);
      beamL(mb, px, py, pz, c, s,
        sx + 0.10, sy, nz,
        sx + 0.10, sy + Math.cos(th) * bl, nz + Math.sin(th) * bl, 0.055, 0.16, F_ALL);
      beamL(mb, px, py, pz, c, s,
        sx + 0.10, sy, nz,
        sx + 0.10, sy - Math.cos(th) * bl, nz - Math.sin(th) * bl, 0.055, 0.16, F_ALL);
    }
    setMat(mb, M.aircraftGrey);
    setL(0, sx, sy - r * 0.24, nz - r * 0.24); setL(1, sx + L * 0.030, sy - r * 0.05, nz - r * 0.05);
    setL(2, sx, sy + r * 0.24, nz - r * 0.24); setL(3, sx + L * 0.030, sy + r * 0.05, nz - r * 0.05);
    setL(4, sx, sy - r * 0.24, nz + r * 0.24); setL(5, sx + L * 0.030, sy - r * 0.05, nz + r * 0.05);
    setL(6, sx, sy + r * 0.24, nz + r * 0.24); setL(7, sx + L * 0.030, sy + r * 0.05, nz + r * 0.05);
    hullL(mb, px, py, pz, c, s, F_ALL);
  }

  // T-tail: fin off the tail cone, stabiliser across the top of it.
  const finTop = fy + r * 0.55 + L * 0.235;
  setMat(mb, M.aircraftTrim);
  setL(0, -L * 0.30, fy + r * 0.55, -r * 0.14); setL(1, -L * 0.47, fy + r * 0.55, -r * 0.14);
  setL(2, -L * 0.40, finTop, -r * 0.08); setL(3, -L * 0.49, finTop, -r * 0.08);
  setL(4, -L * 0.30, fy + r * 0.55, r * 0.14); setL(5, -L * 0.47, fy + r * 0.55, r * 0.14);
  setL(6, -L * 0.40, finTop, r * 0.08); setL(7, -L * 0.49, finTop, r * 0.08);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.aircraftWhite);
  setL(0, -L * 0.385, finTop, 0); setL(1, -L * 0.495, finTop, 0);
  setL(2, -L * 0.385, finTop + r * 0.16, 0); setL(3, -L * 0.495, finTop + r * 0.16, 0);
  setL(4, -L * 0.405, finTop + r * 0.03, span * 0.145); setL(5, -L * 0.485, finTop + r * 0.03, span * 0.145);
  setL(6, -L * 0.405, finTop + r * 0.15, span * 0.145); setL(7, -L * 0.485, finTop + r * 0.15, span * 0.145);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setL(4, -L * 0.405, finTop + r * 0.03, -span * 0.145); setL(5, -L * 0.485, finTop + r * 0.03, -span * 0.145);
  setL(6, -L * 0.405, finTop + r * 0.15, -span * 0.145); setL(7, -L * 0.485, finTop + r * 0.15, -span * 0.145);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Undercarriage: nose leg at the origin, main legs in the nacelles.
  setMat(mb, M.chrome);
  mb.cylinder(px + L * 0.40 * c, py + 0.30, pz - L * 0.40 * s, 0.075, 0.075, fy - r - 0.30, 4, a,
    false);
  setMat(mb, M.tyre);
  discZ(mb, px + L * 0.40 * c, py, pz - L * 0.40 * s, c, s, 0, 0, 0.30, 0.30, 6);
  for (let k = 0; k < 2; k++) {
    const nz = (k === 0 ? -1 : 1) * span * 0.175;
    const gx = -L * 0.02;
    setMat(mb, M.chrome);
    beamL(mb, px, py, pz, c, s, gx, wy - r * 0.40, nz, gx, 0.42, nz, 0.075, 0.075, F_ALL);
    setMat(mb, M.tyre);
    for (let w = 0; w < 2; w++) {
      const wz = nz + (w ? 0.30 : -0.30);
      discZ(mb, px + gx * c + wz * s, py, pz - gx * s + wz * c, c, s, 0, 0, 0.42, 0.42, 6);
    }
  }
  if (typeof rng === 'function') rnd(rng);
}

/** Single-engine light aircraft on the general-aviation apron. Nose along local +X. */
export function appendLightPlane(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const fy = 1.02;

  setMat(mb, M.aircraftWhite);
  setL(0, 2.10, fy - 0.52, -0.52); setL(1, -1.30, fy - 0.46, -0.44);
  setL(2, 2.10, fy + 0.52, -0.46); setL(3, -1.30, fy + 0.46, -0.40);
  setL(4, 2.10, fy - 0.52, 0.52); setL(5, -1.30, fy - 0.46, 0.44);
  setL(6, 2.10, fy + 0.52, 0.46); setL(7, -1.30, fy + 0.46, 0.40);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setL(0, -1.30, fy - 0.46, -0.44); setL(1, -4.05, fy - 0.02, -0.13);
  setL(2, -1.30, fy + 0.46, -0.40); setL(3, -4.05, fy + 0.30, -0.13);
  setL(4, -1.30, fy - 0.46, 0.44); setL(5, -4.05, fy - 0.02, 0.13);
  setL(6, -1.30, fy + 0.46, 0.40); setL(7, -4.05, fy + 0.30, 0.13);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.cabinGlass);
  quadPZ(mb, px, py, pz, c, s, 0.525, 0.30, fy + 0.02, 1.70, fy + 0.50);
  quadNZ(mb, px, py, pz, c, s, -0.525, 0.30, fy + 0.02, 1.70, fy + 0.50);
  quadPX(mb, px, py, pz, c, s, 2.11, fy + 0.05, -0.42, fy + 0.50, 0.42);

  // High wing with struts.
  setMat(mb, M.aircraftWhite);
  setL(0, 1.20, fy + 0.52, -5.50); setL(1, 0.10, fy + 0.52, -5.50);
  setL(2, 1.20, fy + 0.68, -5.50); setL(3, 0.10, fy + 0.68, -5.50);
  setL(4, 1.35, fy + 0.52, 5.50); setL(5, 0.05, fy + 0.52, 5.50);
  setL(6, 1.35, fy + 0.68, 5.50); setL(7, 0.05, fy + 0.68, 5.50);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.chrome);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    beamL(mb, px, py, pz, c, s, 0.40, fy - 0.42, sg * 0.42, 0.55, fy + 0.52, sg * 2.60,
      0.035, 0.035, F_ALL);
  }
  // Fin and tailplane.
  setMat(mb, M.aircraftTrim);
  setL(0, -3.10, fy + 0.28, -0.06); setL(1, -4.05, fy + 0.30, -0.06);
  setL(2, -3.60, fy + 1.55, -0.05); setL(3, -4.12, fy + 1.55, -0.05);
  setL(4, -3.10, fy + 0.28, 0.06); setL(5, -4.05, fy + 0.30, 0.06);
  setL(6, -3.60, fy + 1.55, 0.05); setL(7, -4.12, fy + 1.55, 0.05);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.aircraftWhite);
  boxL(mb, px, py, pz, c, s, -3.95, fy + 0.24, -1.70, -3.25, fy + 0.32, 1.70, F_ALL);
  // Spinner, prop and gear.
  setMat(mb, M.aircraftTrim);
  mb.cylinder(px + 2.10 * c, py + fy, pz - 2.10 * s, 0.22, 0.06, 0.34, 5, a, false);
  setMat(mb, M.propBlade);
  const th = hash2(px, pz) * TAU;
  for (let i = 0; i < 2; i++) {
    const b = th + i * Math.PI;
    beamL(mb, px, py, pz, c, s, 2.26, fy, 0, 2.26, fy + Math.cos(b) * 0.92,
      Math.sin(b) * 0.92, 0.048, 0.11, F_ALL);
  }
  setMat(mb, M.chrome);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    beamL(mb, px, py, pz, c, s, 0.35, fy - 0.48, 0, 0.35, 0.26, sg * 1.15, 0.045, 0.045, F_ALL);
  }
  setMat(mb, M.tyre);
  for (let k = 0; k < 2; k++) {
    const wz = (k === 0 ? -1 : 1) * 1.15;
    discZ(mb, px + 0.35 * c + wz * s, py, pz - 0.35 * s + wz * c, c, s, 0, 0, 0.26, 0.26, 6);
  }
  discZ(mb, px + 2.02 * c, py, pz - 2.02 * s, c, s, 0, 0, 0.20, 0.20, 5);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Mobile boarding stairs on the apron. Origin is the pavement at the chassis centre; the flight
 * climbs toward local +X and the top platform is at cabin-door height.
 */
export function appendAirstairs(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const top = 2.55, run = 3.30;

  // Chassis and wheels.
  setMat(mb, M.alum);
  boxL(mb, px, py, pz, c, s, -1.90, 0.40, -0.85, 1.55, 0.62, 0.85, F_NOBOT);
  setMat(mb, M.tyre);
  for (let i = 0; i < 4; i++) {
    const lx = (i & 1) ? 1.20 : -1.55, lz = (i & 2) ? 0.80 : -0.80;
    discX(mb, px, py, pz, c, s, lz > 0 ? 0.86 : -0.86, 0.34, lx, 0.34, 6, lz > 0);
  }
  // The flight: eight treads climbing to the platform.
  setMat(mb, M.galvPale);
  for (let i = 0; i < 8; i++) {
    const f0 = i / 8, f1 = (i + 1) / 8;
    const x0 = -1.70 + run * f0, y0 = 0.62 + (top - 0.62) * f0;
    const y1 = 0.62 + (top - 0.62) * f1;
    boxL(mb, px, py, pz, c, s, x0, y1 - 0.05, -0.62, -1.70 + run * f1, y1, 0.62, F_NOBOT);
    boxL(mb, px, py, pz, c, s, x0, y0, -0.62, x0 + 0.05, y1 - 0.05, 0.62, F_PLATEX);
  }
  // Platform and its rails.
  boxL(mb, px, py, pz, c, s, 1.60, top - 0.06, -0.68, 2.55, top, 0.68, F_NOBOT);
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const sz = (k === 0 ? -1 : 1) * 0.66;
    for (let i = 0; i < 2; i++) {
      const yy = top + 0.52 + i * 0.42;
      beamL(mb, px, py, pz, c, s, -1.66, yy - (top - 0.62) * 0.52, sz, 2.52, yy, sz,
        0.028, 0.028, F_ALL);
    }
    for (let i = 0; i < 4; i++) {
      const lx = -1.5 + i * 1.35;
      const base = 0.62 + (top - 0.62) * clamp((lx + 1.70) / run, 0, 1);
      boxL(mb, px, py, pz, c, s, lx - 0.028, base, sz - 0.028, lx + 0.028, base + 0.96,
        sz + 0.028, F_SIDES);
    }
  }
  // Bumper pads where it meets the fuselage.
  setMat(mb, M.tyre);
  boxL(mb, px, py, pz, c, s, 2.55, top - 0.10, -0.62, 2.68, top + 0.34, 0.62, F_NOBOT);
}

/**
 * A baggage tug with `n` carts behind it, drawn up on the apron. The train runs along local -Z
 * from the tug at the origin.
 */
export function appendGSECart(mb, rng, x, y, z, yaw, n) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const cnt = clamp(fin(n, 2) | 0, 0, 4);

  setMat(mb, M.taxiOrange);
  boxL(mb, px, py, pz, c, s, -0.72, 0.34, -1.30, 0.72, 1.02, 0.95, F_NOBOT);
  setMat(mb, M.cabinGlass);
  quadPZ(mb, px, py, pz, c, s, 0.955, -0.60, 1.06, 0.60, 1.62);
  setMat(mb, M.taxiOrange);
  boxL(mb, px, py, pz, c, s, -0.62, 1.02, -0.10, 0.62, 1.72, 0.94, F_SIDES | F_PY);
  setMat(mb, M.tyre);
  for (let i = 0; i < 4; i++) {
    const lz = (i & 1) ? 0.62 : -0.92, sg = (i & 2) ? 1 : -1;
    discX(mb, px, py, pz, c, s, sg * 0.74, 0.32, lz, 0.32, 6, sg > 0);
  }
  for (let k = 0; k < cnt; k++) {
    const oz = -2.30 - k * 3.05;
    setMat(mb, M.galvPale);
    boxL(mb, px, py, pz, c, s, -0.82, 0.44, oz - 1.20, 0.82, 0.60, oz + 1.20, F_NOBOT);
    setMat(mb, M.canvas);
    boxL(mb, px, py, pz, c, s, -0.80, 0.60, oz - 1.16, 0.80, 1.28 + 0.10 * hash2(px + k, pz),
      oz + 1.16, F_NOBOT);
    setMat(mb, M.tyre);
    for (let i = 0; i < 4; i++) {
      const lz = oz + ((i & 1) ? 0.92 : -0.92), sg = (i & 2) ? 1 : -1;
      discX(mb, px, py, pz, c, s, sg * 0.84, 0.26, lz, 0.26, 5, sg > 0);
    }
    setMat(mb, M.galv);
    beamL(mb, px, py, pz, c, s, 0, 0.42, oz + 1.20, 0, 0.42, oz + 1.85, 0.04, 0.04, F_ALL);
  }
  if (typeof rng === 'function') rnd(rng);
}

/**
 * A frangible airfield sign beside a taxiway: a low panel on two breakaway legs, yellow with a
 * black border for a location sign, red for a runway holding position. Faces along local +/-X.
 * Not emissive — the real ones are internally lit, but a lit sign is the renderer's call and
 * Amendment 7 says detail marks WHAT emits, never WHEN, and this one is too small to matter.
 */
export function appendAirfieldSign(mb, x, y, z, yaw, mandatory) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const w = mandatory ? 1.35 : 1.05;

  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (w - 0.14);
    boxL(mb, px, py, pz, c, s, -0.05, 0.0, lz - 0.05, 0.05, 0.42, lz + 0.05, F_SIDES);
  }
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, -0.07, 0.40, -w, 0.07, 1.06, w, F_NOBOT);
  setMat(mb, mandatory ? M.signRed : M.signYellow);
  quadPX(mb, px, py, pz, c, s, 0.075, 0.47, -w + 0.07, 0.99, w - 0.07);
  quadNX(mb, px, py, pz, c, s, -0.075, 0.47, -w + 0.07, 0.99, w - 0.07);
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendRunwayLight,
  appendApproachMast,
  appendWindsock,
  appendHangar,
  appendAirliner,
  appendLightPlane,
  appendAirstairs,
  appendGSECart,
  appendAirfieldSign,
});
