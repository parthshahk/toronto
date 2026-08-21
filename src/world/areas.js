// src/world/areas.js — the ground-cover polygons, and the per-city budgets shared out over them.
//
// CONTRACT.md §6.3, §6.4 and Amendment 11.1. Moved out of city.js unchanged.
//
// Parks, grass, surface lots and piers are prepared here but NOT filled: each PART is indexed
// separately, because a park mapped as three polygons belongs in three tiles rather than one, and
// the geometry itself is emitted by whichever tile owns it.
//
// The pass also shares out the budgets that are properties of the WHOLE city rather than of one
// tile — park trees, moored boats, construction cranes and crown signage. They are settled here,
// once, so that which tile happens to be built first can never change which sites get them. That
// is the same determinism rule as everywhere else (CONTRACT §8.4), applied to a scarce resource
// instead of to a hash.

import { chunked, frame } from '../core/async.js';
import { buildParts, planArea } from '../geom/ring.js';
import { harbourWaterAt } from './shoreline.js';
import { M } from '../city/materials.js';
import { findFrontage } from '../city/units.js';
import { MAX_CRANES, MAX_PARK_TREES, MAX_TOWER_SIGNS } from '../city/lod.js';
import { DUP_STAGGER, GRASS_Y, LOT_Y, PARK_Y, PIER_Y } from './ground.js';
import { MAX_BOATS } from './marine.js';

/**
 * Prepare every ground-cover area and settle the per-city budgets over them.
 *
 * @param {object} W the raw area list, the prepared buildings, the street-detail context, the
 *   harbour, the capture builder set and the extent.
 * @returns {Promise<Array>} every area part, in file order, for the tile index to file.
 */
async function prepareAreas(W) {
  const { areasRaw, prepped, C, HARBOUR, cap, extent, report } = W;

  // Parks, grass, surface lots and piers, prepared but not filled. Each PART is indexed
  // separately: a park mapped as three polygons belongs in three tiles, not one.
  report(0.72, 'parks and quays');
  const areaParts = [];
  const lotParts = [];
  const pierParts = [];
  const parkParts = [];
  await chunked(areasRaw.length, 400, (i) => {
    const a = areasRaw[i];
    if (!a || !Array.isArray(a.p) || a.p.length < 3) return;
    if (a.k === 'water') return;                         // handled with the terrain
    const parts = buildParts([a.p], 8);
    if (!parts) return;
    let target = 'terrain', dy = PARK_Y, m = M.park;
    if (a.k === 'grass') { m = M.grass; dy = GRASS_Y; }
    else if (a.k === 'parking') { target = 'roads'; m = M.parking; dy = LOT_Y; }
    else if (a.k === 'pier') { target = 'roads'; m = M.pier; dy = PIER_Y; }
    // The extract carries duplicate and nested polygons of the same kind. Identical covers laid at
    // an identical height are the one case the depth buffer cannot resolve at all, so stagger them
    // by a few millimetres — under every rung of the ladder, over every float epsilon.
    dy += ((i % 3) - 1) * DUP_STAGGER;
    // HARBOURFRONT: a pier standing in the surveyed lake is built as real structure — deck,
    // fascia and piles — by harbour.js, so the flat draped cap is suppressed there. The parts
    // are still collected, because the berths and the moored craft hang off them.
    const harbourPier = a.k === 'pier' && HARBOUR &&
      harbourWaterAt(HARBOUR, a.p[0][0], a.p[0][1]);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      part.kind = a.k;
      part.mat = m;
      part.dy = dy;
      part.target = target;
      part.drape = !harbourPier;
      part.treeCap = 0;
      part.boats = 0;
      part.berth = false;
      part.crane = false;
      areaParts.push(part);
      if (a.k === 'parking') lotParts.push(part);
      else if (a.k === 'pier') pierParts.push(part);
      else if (a.k === 'park') parkParts.push(part);
    }
  }, (f) => report(0.72 + f * 0.03, 'parks and quays'));

  // The rare, deliberately-scarce things are chosen HERE, city-wide and deterministically, so
  // that which tile happens to be built first can never change which sites get them.
  {
    const areaKm2 = Math.max(1, (extent.x * extent.z) / 1e6);
    const treeBudgetTotal = Math.round(MAX_PARK_TREES * areaKm2 / 7);
    let left = treeBudgetTotal;
    for (let i = 0; i < parkParts.length && left > 0; i++) {
      const area = Math.abs(planArea(parkParts[i].outer));
      if (area < 420) continue;
      const cap2 = Math.min(26, Math.floor(area / 260), left);
      parkParts[i].treeCap = cap2;
      left -= cap2;
    }
    let boats = MAX_BOATS;
    for (let i = 0; i < pierParts.length; i++) {
      if (i < 3) pierParts[i].berth = true;
      if (boats <= 0) continue;
      const n = Math.min(3, boats);
      pierParts[i].boats = n;
      boats -= n;
    }
    const big = [];
    for (let i = 0; i < lotParts.length; i++) {
      if (Math.abs(planArea(lotParts[i].outer)) >= 2200) big.push(lotParts[i]);
    }
    big.sort((p, q) => Math.abs(planArea(q.outer)) - Math.abs(planArea(p.outer)));
    for (let i = 0; i < Math.min(MAX_CRANES, big.length); i++) big[i].crane = true;

    const tall = [];
    for (let i = 0; i < prepped.length; i++) {
      const b = prepped[i];
      if (!b.parts || b.buried || b.landmark === 'cn' || b.h < 108) continue;
      tall.push(b);
    }
    tall.sort((p, q) => (q.h - p.h) || (p.cx - q.cx));
    // A tower only carries crown signage if it has real street frontage to hang it on, and the
    // facade pass does not run until the tile is built. Resolve the frontage HERE, for the
    // hundred tallest candidates only, so the eight that get a sign are the eight the old
    // single-pass build would have chosen and not whichever happen to be built first.
    let signs = 0;
    for (let i = 0; i < tall.length && signs < MAX_TOWER_SIGNS; i++) {
      findFrontage(C, tall[i]);
      if (tall[i].frontLen < 7) continue;
      tall[i].towerSign = signs++;
    }
  }
  await frame();

  return areaParts;
}

export { prepareAreas };
