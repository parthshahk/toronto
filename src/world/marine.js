// src/world/marine.js — what is moored, and what it is moored to.
//
// CONTRACT.md §8.3 and Amendment 11.1. Moved out of city.js unchanged. The harbourfront's water
// is surveyed (harbour.js owns the quay wall, the slips and the piers); this module puts the
// craft and the berths on it:
//
//   placeQuayBerth()    a ferry or tour-boat berth on a Harbourfront quay: on the quay edge, half
//                       of it overhanging the slip, its deck level with the pier cap.
//   placeHarbourCraft() moored craft off one quay. They cannot simply be hung on the quay edge —
//                       open water is recovered from a distance transform and a quay is itself
//                       dense mapped infrastructure, so the lake surface does not begin until
//                       well clear of the slips. Rings are walked outward until the terrain drops
//                       below the lake plane, and each craft is moored broadside so a basin reads
//                       as a marina.

import { clamp, TAU } from '../core/math.js';
import { appendBoat, appendFerryDock } from '../props/index.js';
import { EPS, WATER_Y, EDGE, ringEdge } from './ground.js';
import { inFootprint, noteProp } from './context.js';

const MAX_BOATS = 34;

// A ferry / tour-boat berth on a Harbourfront quay: on the quay edge, half of it overhanging the
// slip, its deck at the same height the pier cap was draped to.
function placeQuayBerth(C, part) {
  const co = part.outer;
  for (let i = 0; i < co.length; i += 2) {
    const l = ringEdge(part, i);
    if (l < 26) continue;
    const mx = EDGE.mu, mz = -EDGE.mv;
    const ox = EDGE.nu, oz = -EDGE.nv;                     // outward, in world
    const fx = mx + ox * 3.2, fz = mz + oz * 3.2;
    if (inFootprint(C, fx, fz, 1.0) || !C.occ.claim(fx, fz, 9.0)) continue;
    // props.js: local +X is the outboard side, so the rub rail faces the water.
    appendFerryDock(C.mb.props, fx, Math.max(C.groundY(mx, mz), 0.9) + 0.35, fz,
      Math.atan2(-oz, ox), 7.0, clamp(l * 0.7, 8, 24));
    noteProp(C, 'ferryDock');
    return true;
  }
  return false;
}

/**
 * Moored craft off one quay. They cannot simply be hung on the quay edge: open water here is
 * recovered from a distance transform (see makeTerrain) and a quay is itself dense mapped
 * infrastructure, so the lake surface does not begin until well clear of the slips. Rings are
 * therefore walked outward from the quay until the terrain genuinely drops below the lake plane,
 * and each craft is moored broadside to the quay so a basin reads as a marina.
 */
function placeHarbourCraft(C, part, budget) {
  const bb = part.bbox;
  const cx = (bb[0] + bb[2]) * 0.5;
  const cz = -(bb[1] + bb[3]) * 0.5;
  const rng = C.rng;
  let placed = 0;
  for (let ring = 34; ring <= 280 && placed < budget; ring += 24) {
    for (let a = 0; a < 12 && placed < budget; a++) {
      const th = (a / 12) * TAU + ring * 0.13;
      const jx = cx + Math.cos(th) * ring;
      const jz = cz + Math.sin(th) * ring;
      if (C.groundY(jx, jz) > -0.55) continue;
      if (!C.occ.claim(jx, jz, 9.5)) continue;
      // Broadside to the quay: perpendicular to the line back to it.
      const tx = cx - jx, tz = cz - jz;
      const tl = Math.hypot(tx, tz);
      const dx = tl > EPS ? -tz / tl : 1, dz = tl > EPS ? tx / tl : 0;
      appendBoat(C.mb.props, rng, jx, WATER_Y, jz, Math.atan2(dx, dz) + (rng() - 0.5) * 0.16,
        8.0 + rng() * 9.0);
      noteProp(C, 'boat');
      placed++;
    }
  }
  return placed;
}



export { MAX_BOATS, placeQuayBerth, placeHarbourCraft };
