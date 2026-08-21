// src/props/vehicles.js — static road and rail vehicles: parked cars, vans and SUVs, and the
// GO/UP/VIA rolling stock standing in the rail corridor.
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// ORIENTATION: a vehicle's LENGTH runs along local Z (front at +Z) and its width along local X,
// which matches the module contract's "long objects run along local Z" rule. To park it along a
// kerb whose unit direction is (dx, dz):
//     yaw = Math.atan2(-dz, dx) + Math.PI / 2       (equivalently Math.atan2(dx, dz))
// which points the vehicle along (dx, dz) and puts local +X on its outboard side.
//
// Static geometry, no AI, and nothing emissive — a parked car's lamps are OFF, so the renderer is
// free to light it as an ordinary painted object at any hour.

import {
  F_NOBOT, F_PY, F_SIDES, boxL, discX, fin, finAngle, frustL, hullL, pickOf, quadNX, quadNZ,
  quadPX, quadPZ, rnd, setL, setMat,
} from './kit.js';
import { CAR_COLOURS, M, RAIL_LIVERY } from './materials.js';

// [ length, halfWidth, sillY, beltY, roofY, cabinZ0, cabinZ1, wheelR ] — see appendParkedCar.
const CAR_SEDAN = [4.52, 0.895, 0.30, 0.80, 1.44, -1.25, 0.45, 0.325];

const CAR_SUV = [4.78, 0.955, 0.35, 0.96, 1.80, -1.45, 0.72, 0.370];

const CAR_VAN = [5.36, 0.990, 0.37, 1.06, 2.24, -2.05, 0.80, 0.355];

// Parked car. Static geometry, no AI, and nothing emissive — a parked car's lamps are OFF, so the
// renderer is free to light it as an ordinary painted object at any hour.
//
// ORIENTATION: the car's LENGTH runs along local Z (front at +Z) and its width along local X,
// which matches this module's "long objects run along local Z" rule. To park it along a kerb whose
// unit direction is (dx, dz):
//     yaw = Math.atan2(-dz, dx) + Math.PI / 2       (equivalently Math.atan2(dx, dz))
// which points the car along (dx, dz) and puts local +X on its outboard side.
//
// `kind` is 'sedan' | 'suv' | 'van' | 'taxi'; anything else falls back to 'sedan'.
export function appendParkedCar(mb, rng, x, y, z, yaw, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  const isTaxi = kind === 'taxi';
  const K = kind === 'suv' ? CAR_SUV : (kind === 'van' ? CAR_VAN : CAR_SEDAN);
  const hl = K[0] * 0.5, hw = K[1];
  const sill = K[2], belt = K[3], roof = K[4];
  const cz0 = K[5], cz1 = K[6], wr = K[7];
  const body = isTaxi ? M.craneWhite : pickOf(rng, CAR_COLOURS);

  // Lower body: one hull with a plan taper toward the nose. Five faces — a kerbside car's
  // underside is never seen and these are placed in the thousands.
  setMat(mb, body);
  setL(0, -hw * 0.94, sill, -hl); setL(1, hw * 0.94, sill, -hl);
  setL(2, -hw, belt, -hl); setL(3, hw, belt, -hl);
  setL(4, -hw * 0.88, sill, hl); setL(5, hw * 0.88, sill, hl);
  setL(6, -hw * 0.96, belt, hl); setL(7, hw * 0.96, belt, hl);
  hullL(mb, px, py, pz, c, s, F_NOBOT);

  // Greenhouse: the same hull drawn twice — glass on the four sides, body colour on the roof.
  const cw = hw * 0.93;
  const rake = (roof - belt) * 0.42;
  setL(0, -cw, belt, cz0); setL(1, cw, belt, cz0);
  setL(2, -cw * 0.80, roof, cz0 + rake); setL(3, cw * 0.80, roof, cz0 + rake);
  setL(4, -cw, belt, cz1); setL(5, cw, belt, cz1);
  setL(6, -cw * 0.80, roof, cz1 - rake * 1.5); setL(7, cw * 0.80, roof, cz1 - rake * 1.5);
  setMat(mb, M.carGlass);
  hullL(mb, px, py, pz, c, s, F_SIDES);
  setMat(mb, body);
  hullL(mb, px, py, pz, c, s, F_PY);

  // Wheels: outward-facing discs just proud of the flanks.
  setMat(mb, M.tyre);
  const wz = hl - wr - 0.24;
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const lz = (i & 2) ? wz : -wz;
    discX(mb, px, py, pz, c, s, side * (hw + 0.006), wr, lz, wr, 6, side > 0);
  }

  // Lamp lenses — colour only. A parked car is dark.
  setMat(mb, M.lampClear);
  quadPZ(mb, px, py, pz, c, s, hl + 0.004, -hw * 0.84, sill + 0.18, hw * 0.84, sill + 0.34);
  setMat(mb, M.lampRed);
  quadNZ(mb, px, py, pz, c, s, -hl - 0.004, -hw * 0.86, sill + 0.20, hw * 0.86, sill + 0.38);

  if (isTaxi) {
    setMat(mb, M.taxiOrange);
    boxL(mb, px, py, pz, c, s, -0.30, roof, cz1 * 0.35 - 0.24,
      0.30, roof + 0.24, cz1 * 0.35 + 0.24, F_NOBOT);
  }
}

// One bogie: side frame plus four wheels, centred on local z = zc. 84 verts.
function bogie(mb, ox, oy, oz, c, s, zc) {
  setMat(mb, M.dark);
  boxL(mb, ox, oy, oz, c, s, -0.98, 0.42, zc - 1.08, 0.98, 1.02, zc + 1.08, F_SIDES);
  setMat(mb, M.grateIron);
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const wz = zc + ((i & 2) ? 0.94 : -0.94);
    discX(mb, ox, oy, oz, c, s, side * 1.02, 0.46, wz, 0.46, 5, side > 0);
  }
}

// Rolling stock for the corridor south of Front. Origin is the track centre at TOP OF RAIL and
// the car's length runs along local Z (see appendParkedCar for the alignment formula).
// `kind` is 'coach' | 'locomotive' | 'freight'; anything else falls back to 'coach'.
export function appendRailCar(mb, rng, x, y, z, yaw, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const k = (kind === 'locomotive' || kind === 'freight') ? kind : 'coach';
  const L = k === 'locomotive' ? 21.0 : (k === 'freight' ? 18.5 : 25.0);
  const hl = L * 0.5;
  const bz = hl - 3.4;

  bogie(mb, px, py, pz, c, s, -bz);
  bogie(mb, px, py, pz, c, s, bz);

  if (k === 'locomotive') {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.46, 0.98, -hl, 1.46, 1.34, hl, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.20, 0.44, -3.0, 1.20, 1.00, 3.0, F_SIDES);

    setMat(mb, pickOf(rng, RAIL_LIVERY));
    boxL(mb, px, py, pz, c, s, -1.34, 1.34, -hl + 0.5, 1.34, 3.52, hl - 7.4, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.34, 1.34, hl - 2.2, 1.34, 2.95, hl - 0.5, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.42, 1.34, hl - 7.4, 1.42, 4.05, hl - 2.2, F_NOBOT);

    setMat(mb, M.carGlass);
    quadPX(mb, px, py, pz, c, s, 1.425, 2.85, hl - 6.9, 3.85, hl - 2.9);
    quadNX(mb, px, py, pz, c, s, -1.425, 2.85, hl - 6.9, 3.85, hl - 2.9);
    quadPZ(mb, px, py, pz, c, s, hl - 2.195, -1.16, 2.85, 1.16, 3.80);

    setMat(mb, M.grateIron);
    quadPX(mb, px, py, pz, c, s, 1.345, 2.10, -hl + 1.4, 3.30, -hl + 5.2);
    quadNX(mb, px, py, pz, c, s, -1.345, 2.10, -hl + 1.4, 3.30, -hl + 5.2);

    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -0.42, 3.52, -hl + 3.2, 0.42, 4.02, -hl + 4.1, F_NOBOT);
    setMat(mb, M.lampClear);
    quadNZ(mb, px, py, pz, c, s, -hl + 0.496, -0.34, 2.55, 0.34, 2.92);
  } else if (k === 'freight') {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.44, 0.98, -hl, 1.44, 1.30, hl, F_SIDES);
    setMat(mb, rnd(rng) < 0.5 ? M.rustRed : M.railMaroon);
    boxL(mb, px, py, pz, c, s, -1.56, 1.30, -hl, 1.56, 4.28, hl, F_SIDES);
    frustL(mb, px, py, pz, c, s, 4.28, 4.56,
      -1.56, -hl, 1.56, hl, -1.20, -hl + 0.30, 1.20, hl - 0.30, F_NOBOT);

    // Side ribs, as real proud strips rather than painted lines.
    setMat(mb, M.grateIron);
    for (let i = 0; i < 4; i++) {
      const rz = -hl + L * (0.14 + 0.24 * i);
      quadPX(mb, px, py, pz, c, s, 1.585, 1.36, rz - 0.09, 4.22, rz + 0.09);
      quadNX(mb, px, py, pz, c, s, -1.585, 1.36, rz - 0.09, 4.22, rz + 0.09);
    }
    setMat(mb, M.dark);
    quadPX(mb, px, py, pz, c, s, 1.575, 1.40, -1.85, 3.90, 1.85);
    quadNX(mb, px, py, pz, c, s, -1.575, 1.40, -1.85, 3.90, 1.85);
  } else {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.42, 1.02, -hl + 0.2, 1.42, 1.28, hl - 0.2, F_SIDES);
    setMat(mb, pickOf(rng, RAIL_LIVERY));
    frustL(mb, px, py, pz, c, s, 1.28, 3.60,
      -1.44, -hl, 1.44, hl, -1.52, -hl, 1.52, hl, F_SIDES);
    frustL(mb, px, py, pz, c, s, 3.60, 4.22,
      -1.52, -hl, 1.52, hl, -0.98, -hl + 0.34, 0.98, hl - 0.34, F_NOBOT);

    setMat(mb, M.carGlass);
    quadPX(mb, px, py, pz, c, s, 1.525, 2.35, -hl + 1.6, 3.32, hl - 1.6);
    quadNX(mb, px, py, pz, c, s, -1.525, 2.35, -hl + 1.6, 3.32, hl - 1.6);
    quadPZ(mb, px, py, pz, c, s, hl + 0.004, -1.10, 2.35, 1.10, 3.30);
    quadNZ(mb, px, py, pz, c, s, -hl - 0.004, -1.10, 2.35, 1.10, 3.30);

    setMat(mb, M.dark);
    quadPX(mb, px, py, pz, c, s, 1.520, 1.34, -hl + 0.5, 3.30, -hl + 1.4);
    quadNX(mb, px, py, pz, c, s, -1.520, 1.34, hl - 1.4, 3.30, hl - 0.5);

    setMat(mb, M.galvPale);
    for (let i = 0; i < 2; i++) {
      const rz = (i === 0 ? -1 : 1) * hl * 0.42;
      boxL(mb, px, py, pz, c, s, -0.82, 4.22, rz - 1.05, 0.82, 4.52, rz + 1.05, F_NOBOT);
    }
  }
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendParkedCar,
  appendRailCar,
});
