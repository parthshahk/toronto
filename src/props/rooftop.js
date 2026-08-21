// src/props/rooftop.js — rooftop plant and the tower crown: illuminated corporate signage,
// packaged rooftop units, elevator penthouses, cooling towers, antenna masts, window-cleaning
// rigs, satellite dishes, wall-mounted condensers and flagpoles.
//
// CONTRACT.md §6.1. Conventions (orientation, vertex channels, winding): see ./kit.js.
//
// Everything here follows the same rules as the street furniture: local +X is out/front, long
// objects run their length along local Z, (x, y, z) is the footprint centre at the surface the
// piece stands on, every numeric argument goes through fin() plus a clamp, and every rng draw goes
// through rnd(). profile is 0 and tintable is 0 on every vertex; emissive is 0 except on the
// genuine light sources (tower-sign faces, antenna beacon), which the renderer switches with time
// of day.
//
// FACE MASKS FOR beam()/beamL(): beam builds its hull in a frame where the mask's "X" bits are the
// width axis, the "Y" bits the thickness axis and the "Z" bits the two END CAPS. A member that
// must be closed along its length therefore uses F_BLADEX (its four long faces); F_SIDES on a beam
// would leave the thickness faces open. boxL/frustL/hullL are in true local axes and keep the
// ordinary meaning.

import { TAU, clamp } from '../core/math.js';
import {
  F_ALL, F_BLADEX, F_BLADEZ, F_NOBOT, F_NY, F_NZ, F_PLATEZ, F_PX, F_PY, F_PZ, F_SIDES, _RGB,
  beamL, boxL, discY, fin, finAngle, hash2, hueRGB, hullL, quadNX, quadNZ, quadPX, quadPZ, rnd,
  setL, setMat, triL,
} from './kit.js';
import { M } from './materials.js';

// Illuminated corporate signage on a tower crown — the bank logos that identify the Financial
// District skyline from anywhere in the city. Channel letters standing proud of a dark raceway:
// bright acrylic faces, dark returns, so the piece reads as a dark band by day and a row of
// glowing letters at night with no special-casing.
//
// (x, y, z) is the centre of the sign's bottom edge at the level the letters stand on. The sign
// faces local +X (out from the parapet) and its width runs along local Z. `w` is the overall
// width, `h` the cap height of the letters, `hue` a hue in turns (0 red, 1/3 green, 2/3 blue).
export function appendTowerSign(mb, rng, x, y, z, yaw, w, h, hue) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 8), 1.6, 44.0);
  const H = clamp(fin(h, 2.4), 0.5, 12.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;
  const depth = clamp(H * 0.16, 0.10, 0.45);

  // Backing raceway. Genuinely dark paint, not a darkened "night" tint.
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, -0.17, -H * 0.10, -hw - 0.10, 0.00, H * 1.10, hw + 0.10, F_ALL);

  // Standoffs back to the parapet.
  setMat(mb, M.steel);
  for (let i = 0; i < 2; i++) {
    const sy = H * (i === 0 ? 0.22 : 0.78);
    beamL(mb, px, py, pz, c, s, -0.52, sy, 0, -0.17, sy, 0, 0.055, 0.055, F_BLADEX);
  }

  // Channel letters. The count follows the width so the letterform proportion stays sane.
  const n = (clamp(Math.round(W / 1.45), 2, 5)) | 0;
  const pitch = W / n;
  hueRGB(fin(hue, 0.58));
  for (let i = 0; i < n; i++) {
    const cz = -hw + pitch * (i + 0.5);
    const lw = pitch * (0.34 + 0.14 * rnd(rng));
    const lh = H * (0.74 + 0.26 * rnd(rng));
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, 0.00, 0.0, cz - lw, depth, lh, cz + lw,
      F_PX | F_PY | F_NY | F_PZ | F_NZ);
    mb.color(_RGB[0], _RGB[1], _RGB[2], 0.90, 0, 0.35, 0);
    quadPX(mb, px, py, pz, c, s, depth + 0.004,
      0.018, cz - lw + 0.018, lh - 0.018, cz + lw - 0.018);
  }
}

// Rooftop HVAC plant: curb, casing, condenser fan wells with grilles, an intake hood and a
// refrigerant riser. `w` is the plan size along local Z, `d` the depth along local X, `h` the
// casing height above the roof.
export function appendRooftopUnit(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3.4), 0.9, 16.0);
  const D = clamp(fin(d, 2.0), 0.7, 12.0);
  const H = clamp(fin(h, 1.5), 0.5, 5.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hd - 0.10, 0.0, -hw - 0.10, hd + 0.10, 0.22, hw + 0.10, F_SIDES);

  setMat(mb, rnd(rng) < 0.55 ? M.galvPale : M.alum);
  boxL(mb, px, py, pz, c, s, -hd, 0.18, -hw, hd, 0.18 + H, hw, F_NOBOT);

  // Bolted access panels, standing proud of the casing so the sun rakes their edges.
  setMat(mb, M.alum);
  quadPX(mb, px, py, pz, c, s, hd + 0.012, 0.30, -hw * 0.90, 0.18 + H * 0.86, -hw * 0.06);
  quadPX(mb, px, py, pz, c, s, hd + 0.012, 0.30, hw * 0.06, 0.18 + H * 0.86, hw * 0.90);

  // Condenser fan wells.
  const nf = (clamp(Math.round(W / 2.4), 1, 3)) | 0;
  const fr = Math.min(hd * 0.72, (W / nf) * 0.34);
  const topY = py + 0.18 + H;
  for (let i = 0; i < nf; i++) {
    const lz = W * ((i + 0.5) / nf - 0.5);
    const wx = px + lz * s, wz = pz + lz * c;
    // The grille closes the cowl at ITS OWN rim height: a fixed height would leave the cowl's
    // inner wall visible over the grille from any raised viewpoint.
    const fh = 0.26 + 0.10 * rnd(rng);
    setMat(mb, M.galv);
    mb.cylinder(wx, topY, wz, fr, fr * 0.94, fh, 6, a, false);
    setMat(mb, M.grateIron);
    discY(mb, wx, topY + fh, wz, fr * 0.94, 6, a, true);
  }

  // Intake hood on the back face, one refrigerant riser up the side.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, -hd - 0.34, 0.18 + H * 0.30, -hw * 0.42,
    -hd + 0.02, 0.18 + H * 0.92, hw * 0.42, F_NOBOT);
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, hd + 0.08, 0.24, -hw * 0.96, hd + 0.08, 0.24 + H * 0.70, -hw * 0.96,
    0.045, 0.045, F_BLADEX);
}

// The boxy machine room that caps every tower: solid walls, applied louvre panels, a roof-access
// door, a hatch curb and a vent stub. `w` is the plan size along local Z, `d` along local X,
// `h` the wall height above the roof.
export function appendElevatorPenthouse(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 8.0), 1.8, 34.0);
  const D = clamp(fin(d, 6.0), 1.8, 34.0);
  const H = clamp(fin(h, 4.2), 1.4, 14.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, rnd(rng) < 0.5 ? M.concrete : M.alum);
  boxL(mb, px, py, pz, c, s, -hd, 0.0, -hw, hd, H, hw, F_NOBOT);

  // Coping slab, slightly oversailing.
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hd - 0.12, H, -hw - 0.12, hd + 0.12, H + 0.26, hw + 0.12, F_ALL);

  // Louvre panels: a dark backing applied to the wall with blades proud of it, so the sun rakes
  // them at golden hour instead of a flat painted rectangle.
  const ly0 = H * 0.46, ly1 = H * 0.88;
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, hd + 0.010, ly0, -hw * 0.52, ly1, hw * 0.52);
  quadNZ(mb, px, py, pz, c, s, -hw - 0.010, -hd * 0.52, ly0, hd * 0.52, ly1);
  setMat(mb, M.galv);
  for (let i = 0; i < 3; i++) {
    const by = ly0 + (ly1 - ly0) * (0.14 + 0.32 * i);
    quadPX(mb, px, py, pz, c, s, hd + 0.038, by, -hw * 0.52, by + (ly1 - ly0) * 0.16, hw * 0.52);
  }

  // Roof-access door in its surround.
  const doorH = Math.min(2.24, H * 0.80);
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, hd - 0.02, 0.0, -0.62, hd + 0.09, doorH, 0.62, F_SIDES);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, hd + 0.095, 0.04, -0.52, doorH - 0.06, 0.52);

  // Hatch curb and vent stub on the roof.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, -hd * 0.55, H + 0.26, -hw * 0.30,
    -hd * 0.10, H + 0.62, hw * 0.16, F_NOBOT);
  boxL(mb, px, py, pz, c, s, hd * 0.22, H + 0.26, -hw * 0.42,
    hd * 0.52, H + 0.95, -hw * 0.12, F_NOBOT);
}

// Induced-draught cooling tower — the octagonal drum with a recessed louvre band and a fan cowl
// that sits on half the older office stock downtown. `r` is the shell radius, `h` the overall
// height including the cowl.
export function appendCoolingTower(mb, rng, x, y, z, yaw, r, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const R = clamp(fin(r, 1.6), 0.5, 9.0);
  const H = clamp(fin(h, 3.2), 1.0, 14.0);

  const baseH = H * 0.16;
  const louvreH = H * 0.24;
  const shellH = H * 0.34;
  const deckH = H * 0.12;
  const cowlH = Math.max(0.12, H * 0.14) * (0.85 + 0.30 * rnd(rng));

  // The basin tapers straight into the louvre drum's radius. A wider basin rim would leave an
  // uncapped annular ledge that you can see down into from any raised viewpoint.
  setMat(mb, M.concrete);
  mb.cylinder(px, py, pz, R * 1.06, R * 0.97, baseH, 8, a, false);

  // The louvre band is a genuinely recessed drum between two wider rings, not a painted stripe.
  setMat(mb, M.dark);
  mb.cylinder(px, py + baseH, pz, R * 0.97, R * 0.97, louvreH, 8, a, false);

  setMat(mb, rnd(rng) < 0.5 ? M.galvPale : M.alum);
  mb.cylinder(px, py + baseH + louvreH, pz, R, R * 0.98, shellH, 8, a, false);

  const deckY = py + baseH + louvreH + shellH;
  mb.cylinder(px, deckY, pz, R * 0.98, R * 0.86, deckH, 8, a, false);
  setMat(mb, M.galv);
  mb.cylinder(px, deckY + deckH, pz, R * 0.82, R * 0.74, cowlH, 8, a, false);
  setMat(mb, M.grateIron);
  discY(mb, px, deckY + deckH + cowlH, pz, R * 0.74, 8, a, true);
}

// Rooftop mast: stepped tapering pole, three guy wires off the step, a pair of panel antennas on
// a cross-arm, and a red aviation beacon at the top.
export function appendRoofAntenna(mb, rng, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 9.0), 1.5, 44.0);
  const a = rnd(rng) * TAU;
  const c = Math.cos(a), s = Math.sin(a);
  const stepY = H * 0.46;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -0.52, -0.05, -0.52, 0.52, 0.20, 0.52, F_NOBOT);

  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.18, pz, 0.135, 0.098, stepY - 0.18, 5, a, false);
  mb.cylinder(px, py + stepY, pz, 0.086, 0.042, H - stepY, 5, a, false);

  // Guy wires from the step down to roof anchors.
  setMat(mb, M.steel);
  const gr = H * 0.34;
  for (let i = 0; i < 3; i++) {
    const g = (i / 3) * TAU;
    beamL(mb, px, py, pz, c, s, 0, stepY, 0,
      Math.cos(g) * gr, 0.20, Math.sin(g) * gr, 0.022, 0.022, F_BLADEX);
  }

  // Cross-arm with two panel antennas.
  const armY = H * 0.74;
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, -0.62, armY, 0, 0.62, armY, 0, 0.038, 0.038, F_BLADEX);
  setMat(mb, M.craneWhite);
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? -0.66 : 0.50;
    boxL(mb, px, py, pz, c, s, cx, armY - 0.44, -0.075, cx + 0.16, armY + 0.44, 0.075, F_SIDES);
  }

  setMat(mb, M.beaconRed);
  mb.cylinder(px, py + H, pz, 0.075, 0.060, 0.17, 5, a, false);
  discY(mb, px, py + H + 0.17, pz, 0.060, 5, a, true);
}

// Window-washing davit and cradle parked at a tower parapet. Put the origin ON the parapet top
// with local +X pointing OUT over the facade; the cradle then hangs clear of the wall. `w` is the
// cradle length, which runs along local Z.
export function appendWindowRig(mb, x, y, z, yaw, w) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3.0), 1.2, 7.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;

  // Track on the parapet.
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -0.70, 0.0, -hw - 0.35, -0.24, 0.22, hw + 0.35, F_NOBOT);

  // Two davit posts with jib arms reaching out over the edge.
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw;
    setMat(mb, M.galv);
    boxL(mb, px, py, pz, c, s, -0.58, 0.22, cz - 0.075, -0.36, 1.32, cz + 0.075, F_SIDES);
    setMat(mb, M.steel);
    beamL(mb, px, py, pz, c, s, -0.52, 1.28, cz, 1.40, 0.96, cz, 0.055, 0.055, F_BLADEX);
  }

  // Winch housing.
  setMat(mb, M.craneWhite);
  boxL(mb, px, py, pz, c, s, -0.66, 0.22, -0.30, -0.28, 0.72, 0.30, F_NOBOT);

  // Suspension ropes down to the cradle.
  const topY = 0.96, cradleTop = -1.55;
  setMat(mb, M.steel);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw;
    beamL(mb, px, py, pz, c, s, 1.38, topY, cz, 1.38, cradleTop, cz, 0.022, 0.022, F_BLADEX);
  }

  // Cradle: a CLOSED tub with a separate top rail. An open-topped box would be see-through from
  // above under back-face culling, and above is the one angle this prop is ever viewed from.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, 1.02, cradleTop - 1.05, -hw - 0.14,
    1.74, cradleTop - 0.30, hw + 0.14, F_ALL);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, 1.00, cradleTop - 0.09, -hw - 0.17,
    1.76, cradleTop, hw + 0.17, F_ALL);
}

// Ballasted satellite dish. Faces local +X at a fixed elevation, which is roughly where a Toronto
// downlink actually points. `r` is the dish radius.
export function appendSatelliteDish(mb, x, y, z, yaw, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const R = clamp(fin(r, 0.65), 0.20, 3.2);
  const c = Math.cos(a), s = Math.sin(a);

  const postH = 0.30 + 0.40 * R;
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -R * 0.62, 0.0, -R * 0.62, R * 0.62, 0.16, R * 0.62, F_NOBOT);
  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.12, pz, R * 0.15, R * 0.11, postH, 6, a, false);
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.06, postH - 0.02, -R * 0.20,
    0.10, postH + R * 0.30, R * 0.20, F_SIDES);

  // Rim plane: axis = (cos e, sin e, 0), in-plane up u = (-sin e, cos e, 0), side v = local +Z.
  // (u, v, axis) is right-handed, so walking the rim from u toward v is CCW seen from the front.
  const e = 0.58;
  const ce = Math.cos(e), se = Math.sin(e);
  const cx0 = 0.06, cy0 = postH + R * 0.55;
  const dep = R * 0.34;
  // The bowl apex sits behind the rim and the back shell BEHIND THE BOWL — putting the back
  // between the bowl and the rim would make the two surfaces swap places along the axis, so the
  // dish would be seen from the front through its own back face.
  const ax = cx0 - dep * ce, ay = cy0 - dep * se;
  const bk = dep + R * 0.06;
  const bx = cx0 - bk * ce, by = cy0 - bk * se;

  setMat(mb, M.craneWhite);
  const seg = 8;
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * TAU, t1 = ((i + 1) / seg) * TAU;
    const k0 = Math.cos(t0), m0 = Math.sin(t0);
    const k1 = Math.cos(t1), m1 = Math.sin(t1);
    const p0x = cx0 - R * k0 * se, p0y = cy0 + R * k0 * ce, p0z = R * m0;
    const p1x = cx0 - R * k1 * se, p1y = cy0 + R * k1 * ce, p1z = R * m1;
    triL(mb, px, py, pz, c, s, ax, ay, 0, p0x, p0y, p0z, p1x, p1y, p1z);
    triL(mb, px, py, pz, c, s, bx, by, 0, p1x, p1y, p1z, p0x, p0y, p0z);
  }

  // Feed arm from the bottom rim up to the focus, LNB on the end.
  const fx = cx0 + R * 0.72 * ce, fy = cy0 + R * 0.72 * se;
  const rbx = cx0 + R * se, rby = cy0 - R * ce;
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, rbx, rby, 0, fx, fy, 0, 0.030, 0.030, F_BLADEX);
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, fx - 0.09, fy - 0.09, -0.07, fx + 0.11, fy + 0.09, 0.07, F_ALL);
}

// Split-system condenser for low-rise roofs and rear yards. Small, boring, everywhere.
export function appendACondenser(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = 0.40 + 0.10 * rnd(rng);
  const hd = 0.34 + 0.07 * rnd(rng);
  const hh = 0.78 + 0.22 * rnd(rng);

  // Anti-vibration rails.
  setMat(mb, M.tyre);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw * 0.72;
    boxL(mb, px, py, pz, c, s, -hd, 0.0, cz - 0.06, hd, 0.09, cz + 0.06, F_BLADEZ);
  }

  setMat(mb, rnd(rng) < 0.6 ? M.galvPale : M.cabBeige);
  boxL(mb, px, py, pz, c, s, -hd, 0.09, -hw, hd, hh, hw, F_NOBOT);

  // Coil louvres applied to the three closed faces.
  setMat(mb, M.grateIron);
  quadNX(mb, px, py, pz, c, s, -hd - 0.006, 0.16, -hw + 0.05, hh - 0.10, hw - 0.05);
  quadPZ(mb, px, py, pz, c, s, hw + 0.006, -hd + 0.05, 0.16, hd - 0.05, hh - 0.10);
  quadNZ(mb, px, py, pz, c, s, -hw - 0.006, -hd + 0.05, 0.16, hd - 0.05, hh - 0.10);

  // Fan cowl and guard.
  const fr = Math.min(hd, hw);
  setMat(mb, M.galv);
  mb.cylinder(px, py + hh, pz, fr * 0.86, fr * 0.80, 0.10, 6, a, false);
  setMat(mb, M.dark);
  discY(mb, px, py + hh + 0.10, pz, fr * 0.78, 6, a, true);

  // Line set back into the wall.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, -hd - 0.02, hh * 0.62, hw * 0.55,
    -hd - 0.34, hh * 0.62, hw * 0.55, 0.036, 0.036, F_BLADEX);
}

// Flagpole with a wind-blown flag. There is no yaw argument by contract, so the fly direction
// comes from a position hash — a row of poles then reads as one wind rather than a comb.
export function appendFlagPole(mb, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 11.0), 2.5, 32.0);
  const a = hash2(px, pz) * TAU;
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.granite);
  mb.cylinder(px, py - 0.04, pz, 0.34, 0.30, 0.42, 6, a, false);
  discY(mb, px, py + 0.38, pz, 0.30, 6, a, true);

  setMat(mb, M.alum);
  mb.cylinder(px, py + 0.36, pz, 0.115, 0.052, H - 0.36, 6, a, false);
  // The finial tip keeps a small non-zero radius on purpose: mb.cylinder() emits two triangles per
  // segment regardless, so rTop = 0 would collapse one of each pair into a degenerate.
  mb.cylinder(px, py + H, pz, 0.072, 0.010, 0.16, 5, a, false);

  // Flag: three chord segments with a running wave and a little droop toward the fly.
  const fh = clamp(H * 0.19, 0.5, 2.6);
  const fl = fh * 2.0;
  const topY = H - fh * 0.24;
  const t = 0.012;
  for (let i = 0; i < 3; i++) {
    const x0 = fl * (i / 3), x1 = fl * ((i + 1) / 3);
    const w0 = Math.sin(i * 1.9) * fh * 0.13;
    const w1 = Math.sin((i + 1) * 1.9) * fh * 0.13;
    const d0 = -fh * 0.05 * i, d1 = -fh * 0.05 * (i + 1);
    setL(0, x0, topY - fh + d0, w0 - t); setL(1, x1, topY - fh + d1, w1 - t);
    setL(2, x0, topY + d0, w0 - t); setL(3, x1, topY + d1, w1 - t);
    setL(4, x0, topY - fh + d0, w0 + t); setL(5, x1, topY - fh + d1, w1 + t);
    setL(6, x0, topY + d0, w0 + t); setL(7, x1, topY + d1, w1 + t);
    setMat(mb, i === 1 ? M.flagWhite : M.flagRed);
    hullL(mb, px, py, pz, c, s, F_PLATEZ);
  }
}

/* ================================================================ registry = */
// The domain registry. Adding a prop to this domain means writing the builder above and
// adding one entry here; no dispatch block anywhere else changes. props/index.js merges
// every domain registry into PROPS.

export const BUILDERS = Object.freeze({
  appendTowerSign,
  appendRooftopUnit,
  appendElevatorPenthouse,
  appendCoolingTower,
  appendRoofAntenna,
  appendWindowRig,
  appendSatelliteDish,
  appendACondenser,
  appendFlagPole,
});
