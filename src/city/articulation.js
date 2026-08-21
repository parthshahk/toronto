// src/city/articulation.js — ABOVE STREET LEVEL. The bands and appendages hung on a wall over
// its ground floor: balcony bands, cornices, string courses, parapets, fire escapes and loading
// docks.
//
// CONTRACT.md §6.2. The (u, v, d) frame, yaw, the materials, the LOD contract and the two vertex
// invariants are documented once, in ./facadekit.js. Read that first.
//
// These are what stop a tower reading as an extruded prism: a cornice catches the sky at the
// crown, a string course breaks the height into storeys, a balcony band gives a condo its
// horizontal grain, and a fire escape is the single most Toronto thing on a brick side elevation.
// Each export returns the number of vertices it appended.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  FACADE_LOD, F_BAND, F_BOT, F_ENDS, F_IN, F_LEFT, F_OUT, F_RIGHT, F_SHELL, F_TOP, MAT_GLASS,
  MAT_METAL_PALE, MAT_RUBBER, MAT_SHUTTER, MAT_STEEL, SKIN, applyHost, applyMat, frameAt, lodOf,
  planeBoth, quad, readHost, rect, rngOf, slab, vcount,
} from './facadekit.js';

/**
 * One floor of projecting balcony — slab edge, glass rail, metal cap, shadowed underside. THE
 * Toronto condo signature; its absence is the most visible thing missing from the residential
 * stock. (x, y, z) is the wall point at the balcony DECK level (the walking surface); the slab
 * hangs below it and the rail stands on it.
 *
 * opts: { ends: boolean (default true), rail: number rail height, slab: number slab thickness,
 *         lod }
 * Cost: 54 verts with ends, 42 without. At FACADE_LOD.COARSE, 30 and 18.
 *
 * This is the builder LOD matters most for: a 40-storey condo carries up to 20 bands on each of
 * two elevations, so the level chosen here is worth more vertices than every other feature on
 * the building put together.
 * @returns {number} vertices appended
 */
export function appendBalconyBand(mb, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.9) return 0;
  const dp = clamp(isNum(depth) ? depth : 1.8, 0.5, 4.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const th = clamp(isNum(o.slab) ? o.slab : 0.24, 0.10, 0.6);
  const rail = clamp(isNum(o.rail) ? o.rail : 1.07, 0.7, 1.5);
  const ends = o.ends !== false;

  // COARSE: deck slab and glass rail as ONE solid, from the underside of the slab to the top of
  // the balustrade. The two of them are 0.24 m of pale concrete under 1.07 m of dark glass and
  // they sit within 0.07 m of the same plane, so at range they are one 1.31 m projecting band —
  // which is exactly the horizontal striping that makes a Toronto condo read as a condo from two
  // kilometres. 0.80 is the area-weighted lightness of the pair and 0.60 splits their roughness.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.80, 0.60);
    slab(mb, F, -hw, hw, -th, rail, SKIN, dp, F_OUT | F_TOP | F_BOT | (ends ? F_ENDS : 0));
    return vcount(mb) - before;
  }

  // Slab: fascia, deck and ends in the wall's own concrete, underside darker.
  applyHost(mb, host, 0.86, 0.80);
  slab(mb, F, -hw, hw, -th, 0, SKIN, dp, (F_OUT | F_TOP) | (ends ? F_ENDS : 0));
  applyHost(mb, host, 0.38, 0.86);
  slab(mb, F, -hw, hw, -th, 0, SKIN, dp, F_BOT);
  // Glass balustrade, set in from the slab edge, both faces (you see the inboard one from above).
  applyMat(mb, MAT_GLASS);
  const dr = dp - 0.07;
  planeBoth(mb, F, -hw + 0.05, 0.02, dr, hw - 0.05, 0.02, dr, hw - 0.05, rail, dr, -hw + 0.05, rail, dr);
  // Capping rail.
  applyMat(mb, MAT_METAL_PALE);
  slab(mb, F, -hw + 0.05, hw - 0.05, rail, rail + 0.055, dr - 0.045, dr + 0.045, F_OUT | F_TOP);
  return vcount(mb) - before;
}

/**
 * A projecting cornice for masonry and heritage stock: dentil band, corona, weathered crown.
 * (x, y, z) is the wall point at the BOTTOM of the cornice. `depth` is the maximum projection.
 * opts: { ends: boolean (default true), lod } — turn ends off for a band that wraps a building.
 * Cost: 84 verts with ends, 48 without. At FACADE_LOD.COARSE, 30 and 18.
 * @returns {number} vertices appended
 */
export function appendCornice(mb, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.5) return 0;
  const dp = clamp(isNum(depth) ? depth : 0.55, 0.12, 2.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const e = o.ends !== false ? F_ENDS : 0;

  // COARSE: one band at the corona's own projection, spanning the whole cornice height. What a
  // cornice does at range is put a lit top edge and a shadowed underside on the roofline, and a
  // single slab does both; the dentil course and the weathered crown are 0.2 m steps.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.08, 0.78);
    slab(mb, F, -hw, hw, 0, dp * 1.62, SKIN, dp, F_BAND | e);
    return vcount(mb) - before;
  }

  applyHost(mb, host, 1.00, 0.78);
  slab(mb, F, -hw, hw, 0, dp * 0.36, SKIN, dp * 0.34, F_BAND | e);
  applyHost(mb, host, 1.10, 0.78);
  slab(mb, F, -hw, hw, dp * 0.36, dp * 1.05, SKIN, dp, F_BAND | e);
  applyHost(mb, host, 1.16, 0.80);
  slab(mb, F, -hw, hw, dp * 1.05, dp * 1.42, SKIN, dp * 0.62, F_OUT | e);
  // Weathering: the crown slopes back to the wall so it does not read as a shelf.
  quad(mb, F, -hw, dp * 1.42, dp * 0.62, hw, dp * 1.42, dp * 0.62, hw, dp * 1.62, SKIN, -hw, dp * 1.62, SKIN);
  return vcount(mb) - before;
}

/**
 * A string course: the thin horizontal band that ties a masonry facade together at floor lines.
 * (x, y, z) is the wall point at the BOTTOM of the band.
 * opts: { h: band height (0.24), proj: projection (0.10), ends: boolean (default false), lod }
 * Cost: 18 verts, 30 with ends. Already one slab, so COARSE drops it to the outward face alone —
 * 6 verts — and the 0.10 m shadow line it loses there is a tenth of a pixel at that range.
 * @returns {number} vertices appended
 */
export function appendStringCourse(mb, x, y, z, yaw, width, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.4) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const h = clamp(isNum(o.h) ? o.h : 0.24, 0.06, 1.2);
  const proj = clamp(isNum(o.proj) ? o.proj : 0.10, 0.03, 0.8);
  applyHost(mb, host, 1.12, 0.78);
  if (lodOf(o) === FACADE_LOD.COARSE) rect(mb, F, -hw, hw, 0, h, SKIN);
  else slab(mb, F, -hw, hw, 0, h, SKIN, proj, F_BAND | (o.ends ? F_ENDS : 0));
  return vcount(mb) - before;
}

/**
 * A parapet standing on the roof edge, capped with coping. (x, y, z) is the wall point at ROOF
 * level; the wall face is flush with the facade below and the parapet thickens INWARD, over the
 * roof, so it never floats off the edge of the extrusion.
 * opts: { t: wall thickness (0.30), ends: boolean (default false), lod }
 * Cost: 30 verts, 18 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendParapet(mb, x, y, z, yaw, width, h, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.4) return 0;
  const hh = clamp(isNum(h) ? h : 1.05, 0.25, 4.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const t = clamp(isNum(o.t) ? o.t : 0.30, 0.10, 1.2);
  const e = o.ends ? F_ENDS : 0;
  const capH = Math.min(0.14, hh * 0.3);
  // COARSE: one leaf, coping included. The 0.14 m cap is a lighter line along the very top of the
  // building and it is worth keeping at range — but it is worth keeping as the top face of the
  // wall, not as its own box.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.02, 0.72);
    slab(mb, F, -hw, hw, 0, hh, -t, SKIN, (F_OUT | F_IN | F_TOP) | e);
    return vcount(mb) - before;
  }
  applyHost(mb, host, 0.98, 0.74);
  slab(mb, F, -hw, hw, 0, hh - capH, -t, SKIN, (F_OUT | F_IN) | e);
  applyHost(mb, host, 1.14, 0.70);
  slab(mb, F, -hw, hw, hh - capH, hh, -t - 0.05, 0.05, (F_OUT | F_IN | F_TOP) | e);
  return vcount(mb) - before;
}

/**
 * A bolted-on fire escape for older brick stock — landings, railings, and a flight between each
 * pair of landings. Rear and side elevations only; this is the most expensive builder here.
 * (x, y, z) is the wall point under the CENTRE of the LOWEST landing, at that landing's level.
 *
 * opts: { storey: floor-to-floor (3.4), ladder: boolean (default true), lod }
 * Cost: ~66 verts per floor plus ~24, measured 324 for 4 floors. At FACADE_LOD.COARSE, 18 per
 * floor and nothing fixed — 72 for the same four.
 * @returns {number} vertices appended
 */
export function appendFireEscape(mb, rng, x, y, z, yaw, width, floors, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.2) return 0;
  const n = clamp(Math.round(isNum(floors) ? floors : 3), 1, 8);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 23);
  const hw = Math.min(w, 4.2) * 0.5;
  const st = clamp(isNum(o.storey) ? o.storey : 3.4, 2.4, 5.5);
  const dp = clamp(w * 0.28, 0.95, 1.35);
  const rail = 1.05;
  const side = R() < 0.5 ? -1 : 1;   // which end the flights run from

  // COARSE: the landings, and only the landings. A fire escape at range is a stack of dark
  // horizontal lines on a brick wall — the rails are 30-70 mm of steel, the flights are a
  // diagonal inside a shadow, and the drop ladder is below the bottom landing where nothing can
  // see it. The band here is deck plus rail height, so the stack keeps its full outline.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyMat(mb, MAT_STEEL);
    for (let i = 0; i < n; i++) {
      const v = i * st;
      slab(mb, F, -hw, hw, v, v + rail, SKIN, dp, F_OUT | F_TOP | F_BOT);
    }
    return vcount(mb) - before;
  }

  applyMat(mb, MAT_STEEL);
  for (let i = 0; i < n; i++) {
    const v = i * st;
    // Landing: grating deck, seen from below as much as from above.
    slab(mb, F, -hw, hw, v, v + 0.07, SKIN, dp, F_OUT | F_TOP | F_BOT);
    // Railing: top rail, mid rail, and a stanchion at each end.
    slab(mb, F, -hw, hw, v + rail - 0.05, v + rail, dp - 0.09, dp, F_OUT | F_TOP);
    rect(mb, F, -hw, hw, v + rail * 0.5 - 0.03, v + rail * 0.5 + 0.03, dp);
    slab(mb, F, -hw, -hw + 0.07, v, v + rail, dp - 0.08, dp, F_OUT | F_RIGHT);
    slab(mb, F, hw - 0.07, hw, v, v + rail, dp - 0.08, dp, F_OUT | F_LEFT);
    // Flight up to the next landing: a plate on the diagonal with a handrail over it.
    if (i < n - 1) {
      const u0 = side * (hw - 0.12);
      const u1 = side * (0.12 - hw);
      planeBoth(mb, F,
        u0, v + 0.07, dp * 0.55,
        u1, v + st + 0.07, dp * 0.55,
        u1, v + st + 0.07, dp * 0.95,
        u0, v + 0.07, dp * 0.95);
      planeBoth(mb, F,
        u0, v + 0.95, dp * 0.52,
        u1, v + st + 0.95, dp * 0.52,
        u1, v + st + 0.99, dp * 0.52,
        u0, v + 0.99, dp * 0.52);
    }
  }
  // The counterweighted drop ladder under the bottom landing.
  if (o.ladder !== false) {
    const u = side * (hw - 0.35);
    planeBoth(mb, F,
      u - 0.22, -Math.min(2.2, st * 0.62), dp * 0.7,
      u + 0.22, -Math.min(2.2, st * 0.62), dp * 0.7,
      u + 0.22, 0.06, dp * 0.7,
      u - 0.22, 0.06, dp * 0.7);
  }
  return vcount(mb) - before;
}

/**
 * A loading dock on a rear or service elevation: raised apron, roller shutter in a deep reveal,
 * rubber bumpers and a steel weather canopy. (x, y, z) is the wall point at the CENTRE of the
 * opening, at ground level.
 * opts: { canopy: boolean (default true), dock: number platform height (1.15), lod }
 * Cost: ~132 verts, measured 150 with the canopy. At FACADE_LOD.COARSE, 36 and 18.
 * @returns {number} vertices appended
 */
export function appendLoadingDock(mb, x, y, z, yaw, width, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.8) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const host = readHost(mb, mat);
  const hw = Math.min(w, 9.0) * 0.5;
  const deck = clamp(isNum(o.dock) ? o.dock : 1.15, 0.6, 1.6);
  const doorH = deck + 3.05;

  // COARSE: the apron and the shutter. The reveal, the rubber bumpers and the shutter's guides
  // are all under 0.3 m; what survives is the raised platform, which is a real change of ground
  // level, and the dark rectangle of the door, which is what says "loading dock" at range.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.80, 0.86);
    slab(mb, F, -hw - 0.30, hw + 0.30, 0, deck, -0.05, 1.35, F_OUT | F_TOP);
    applyMat(mb, MAT_SHUTTER);
    rect(mb, F, -hw, hw, deck, doorH, SKIN);
    if (o.canopy !== false) {
      applyMat(mb, MAT_STEEL);
      slab(mb, F, -hw - 0.45, hw + 0.45, doorH + 0.22, doorH + 0.40, SKIN, 1.55, F_OUT | F_TOP | F_BOT);
    }
    return vcount(mb) - before;
  }

  // Apron: the raised platform trucks back up to.
  applyHost(mb, host, 0.80, 0.86);
  slab(mb, F, -hw - 0.30, hw + 0.30, 0, deck, -0.05, 1.35, F_OUT | F_TOP | F_ENDS);
  // Reveal around the opening.
  applyHost(mb, host, 0.94, 0.70);
  slab(mb, F, -hw - 0.22, -hw, deck, doorH + 0.2, SKIN, 0.28, F_OUT | F_RIGHT);
  slab(mb, F, hw, hw + 0.22, deck, doorH + 0.2, SKIN, 0.28, F_OUT | F_LEFT);
  slab(mb, F, -hw - 0.22, hw + 0.22, doorH, doorH + 0.2, SKIN, 0.28, F_OUT | F_BOT);
  // Rolling shutter, and the guides it runs in.
  applyMat(mb, MAT_SHUTTER);
  slab(mb, F, -hw, hw, deck, doorH, SKIN, 0.07, F_OUT | F_TOP);
  // Bumpers.
  applyMat(mb, MAT_RUBBER);
  slab(mb, F, -hw - 0.02, -hw + 0.26, deck - 0.42, deck - 0.06, 1.33, 1.48, F_OUT | F_TOP | F_ENDS);
  slab(mb, F, hw - 0.26, hw + 0.02, deck - 0.42, deck - 0.06, 1.33, 1.48, F_OUT | F_TOP | F_ENDS);
  // Weather canopy over the opening.
  if (o.canopy !== false) {
    applyMat(mb, MAT_STEEL);
    slab(mb, F, -hw - 0.45, hw + 0.45, doorH + 0.22, doorH + 0.40, SKIN, 1.55, F_SHELL);
  }
  return vcount(mb) - before;
}
