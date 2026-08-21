// src/world/quay.js — THE HARBOUR GEOMETRY: the quay wall and its apron, the crossings, the
// piers and their pile fields and floats, the breakwater mounds and groynes, the marinas, the
// ferry terminal, the walkways carried over the water, and the furniture bolted to the coping.
//
// CONTRACT.md §8.3. Tunables, materials and the shared helpers are in ./waterkit.js; the shoreline
// model these walk along is built in ./shoreline.js and assembled in ./water.js.
//
// Every export APPENDS into the MeshBuilder the caller hands over in ctx and claims its footprint
// through ctx.claim(), so the harbour competes for kerb space with the same reservation system
// city.js's procedural furniture pass uses and nothing is placed twice.
//
// Amendment 7 (time-of-day independence): geometry and material only. Water is not emissive, the
// quay is not emissive, no surface here is pre-darkened or pre-lit. The only emitters are the
// navigation lights and the lifebuoy-station lamps in props/, which are real light sources.

import { TAU, clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  appendBoat, appendDolphin, appendGangway, appendLifebuoyStation, appendMooringBollard,
  appendMooringBuoy, appendNavMarker, appendPedestrianLamp, appendQuayLadder, appendQuayRailing,
  appendTimberBench, appendWaveRock,
} from '../props/index.js';
import {
  APRON_Y, BENCH_SPACING, BEVEL, BEVEL_DROP, BOARD_LIFT, BOLLARD_SPACING, COPE_TOP, COPE_W, EPS,
  FENDER_SPACING, FINGER_W, FLOAT_DRAFT, FLOAT_TOP, FOULED_TOP, GROYNE_HW, LADDER_SPACING,
  LIFEBUOY_SPACING, M, MAX_MOORED, MAX_MOORED_BASIN, MAX_ROCKS, MOUND_CELL, MOUND_CREST,
  MOUND_SLOPE, MOUND_TOE, PIER_LIFT, PILE_SPACING, QUAY_LAMP_SPACING, TRAIL_LIFT, WALL_FOOT,
  bboxOf, boxTop, centroidOf, distToPoly, earClip, hash01, planArea, pointInRing, polyLength,
  quadOut, quadUp, resample, rngAt, sampleTerrain, setMat, triUp,
} from './waterkit.js';
import { nearestShore, waterAt } from './shoreline.js';
import { harbourDeckY, ribbonRing, segRing } from './water.js';

/**
 * Every piece of harbour geometry, in build order: quay walls and their apron, piers and their
 * pile structure, rubble mounds, marina floats, the ferry terminal, the public walkways, then the
 * furniture that sits on all of it.
 *
 * ctx: { mb, data, claim(x, z, r) -> bool, note(kind) }. Every random choice inside is hashed on
 * world position instead of drawing from a shared stream, so a piece of harbour looks the same
 * whatever else was built first (CONTRACT §8.4).
 */
export function appendHarbour(H, ctx) {
  if (!H || !ctx || !ctx.mb) return null;
  const c = {
    mb: ctx.mb,
    claim: typeof ctx.claim === 'function' ? ctx.claim : () => true,
    note: typeof ctx.note === 'function' ? ctx.note : () => {},
    // A real luminaire on the quay, reported at its LENS so city.js can register it with the
    // renderer's local-light rig. Optional: a caller that does not supply it still gets geometry.
    light: typeof ctx.light === 'function' ? ctx.light : () => {},
    data: ctx.data || null,
    H,
    rocks: 0, moored: 0,
  };
  appendQuayWalls(H, c);
  appendCrossings(H, c);
  appendPiers(H, c);
  appendMounds(H, c);
  appendMarinas(H, c);
  appendFerryTerminal(H, c);
  appendWalkways(H, c);
  appendQuayFurniture(H, c);
  return H.stats;
}

/* ---------------------------------------------------------------- quay wall */

/**
 * The quay wall and its apron, station by station along every run of surveyed shoreline.
 *
 * Cross-section, outward (+) to inland (-):
 *   +WALL_PROUD              coping face, standing a little into the water
 *   +WALL_PROUD - COPE_W     coping/paving joint, a 45 mm step
 *   -(w - BEVEL)             promenade paving at deck level
 *   -w                       the apron ramps down and meets the ground exactly
 * and below the coping a vertical face to WALL_FOOT, in two materials: the dry wall, and the
 * fouled band under the waterline.
 */
export function appendQuayWalls(H, c) {
  const mbG = c.mb.sidewalks, mbW = c.mb.terrain;
  const S = H.stats;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i + 1 < run.n; i++) {
      const g0 = run.g[i], g1 = run.g[i + 1];
      const t0 = g0 + APRON_Y, t1 = g1 + APRON_Y;
      const c0 = g0 + COPE_TOP, c1 = g1 + COPE_TOP;
      const e0 = run.e[i] - BEVEL_DROP + APRON_Y, e1 = run.e[i + 1] - BEVEL_DROP + APRON_Y;
      const w0 = run.w[i], w1 = run.w[i + 1];

      // Offsets along the mitre. Positive is seaward.
      const p0 = run.pr[i], p1 = run.pr[i + 1];
      const o = (k, d) => [run.x[k] + run.mx[k] * d, run.z[k] + run.mz[k] * d];
      const a0 = o(i, p0), b0 = o(i + 1, p1);
      const a1 = o(i, p0 - COPE_W), b1 = o(i + 1, p1 - COPE_W);
      const a2 = o(i, -(w0 - BEVEL)), b2 = o(i + 1, -(w1 - BEVEL));
      const a3 = o(i, -w0), b3 = o(i + 1, -w1);

      setMat(mbG, M.coping);
      S.folds += quadUp(mbG, a0[0], c0, a0[1], a1[0], c0, a1[1], b1[0], c1, b1[1], b0[0], c1, b0[1]);
      setMat(mbG, M.promenade);
      S.folds += quadUp(mbG, a1[0], t0, a1[1], a2[0], t0, a2[1], b2[0], t1, b2[1], b1[0], t1, b1[1]);
      setMat(mbG, M.promEdge);
      S.folds += quadUp(mbG, a2[0], t0, a2[1], a3[0], e0, a3[1],
        b3[0], e1, b3[1], b2[0], t1, b2[1]);

      // The coping's inland riser and the apron's inland skirt: both keep the slab from ever
      // showing an open edge, whatever the ground under it is doing.
      setMat(mbW, M.coping);
      quadOut(mbW, a1[0], t0, a1[1], b1[0], t1, b1[1], b1[0], c1, b1[1], a1[0], c0, a1[1],
        -run.nx[i], 0, -run.nz[i]);
      setMat(mbW, M.retain);
      quadOut(mbW, a3[0], e0 - 0.45, a3[1], b3[0], e1 - 0.45, b3[1], b3[0], e1, b3[1], a3[0], e0, a3[1],
        -run.nx[i], 0, -run.nz[i]);

      // The wall itself.
      setMat(mbW, M.quayFace);
      quadOut(mbW, a0[0], FOULED_TOP, a0[1], b0[0], FOULED_TOP, b0[1],
        b0[0], c1, b0[1], a0[0], c0, a0[1], run.nx[i], 0, run.nz[i]);
      setMat(mbW, M.quayFouled);
      quadOut(mbW, a0[0], WALL_FOOT, a0[1], b0[0], WALL_FOOT, b0[1],
        b0[0], FOULED_TOP, b0[1], a0[0], FOULED_TOP, a0[1], run.nx[i], 0, run.nz[i]);
    }

    // Fender timbers down the face at a working spacing.
    setMat(mbW, M.fender);
    const total = run.s[run.n - 1];
    for (let d = FENDER_SPACING * 0.5; d < total; d += FENDER_SPACING) {
      const st = atArc(run, d);
      if (!st) continue;
      const yaw = Math.atan2(-st.nz, st.nx);
      boxTop(mbW, st.x + st.nx * (st.pr + 0.07), st.z + st.nz * (st.pr + 0.07),
        0.09, 0.15, H.waterY - 1.35, st.g + COPE_TOP - 0.14, yaw);
    }
  }
}

// The station nearest an arc length along a run, with its interpolated normal and level.
const _st = { x: 0, z: 0, nx: 0, nz: 0, g: 0, w: 0, pr: 0, i: 0 };

function atArc(run, d) {
  if (!(d >= 0) || d > run.s[run.n - 1]) return null;
  let lo = 0, hi = run.n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (run.s[mid] <= d) lo = mid; else hi = mid;
  }
  const span = run.s[hi] - run.s[lo];
  const t = span > EPS ? (d - run.s[lo]) / span : 0;
  _st.x = lerp(run.x[lo], run.x[hi], t);
  _st.z = lerp(run.z[lo], run.z[hi], t);
  let nx = lerp(run.nx[lo], run.nx[hi], t), nz = lerp(run.nz[lo], run.nz[hi], t);
  const l = Math.hypot(nx, nz);
  if (l > EPS) { nx /= l; nz /= l; } else { nx = 1; nz = 0; }
  _st.nx = nx; _st.nz = nz;
  _st.g = lerp(run.g[lo], run.g[hi], t);
  _st.w = lerp(run.w[lo], run.w[hi], t);
  _st.pr = lerp(run.pr[lo], run.pr[hi], t);
  _st.i = lo;
  return _st;
}

/**
 * The deck under a walkway that crosses open water and is NOT tagged as a bridge: a timber jetty
 * on driven piles, which is what the harbourfront actually carries between the wave decks and the
 * slips. Tagged bridges are left to the street pass so one slip never gets two decks.
 */
export function appendCrossings(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain;
  for (let k = 0; k < H.crossings.length; k++) {
    const cr = H.crossings[k];
    if (cr.bridge) continue;
    for (let i = cr.a; i < cr.b; i++) {
      const t0 = (i - cr.a) / Math.max(1, cr.b - cr.a), t1 = (i + 1 - cr.a) / Math.max(1, cr.b - cr.a);
      const y = Math.max(lerp(cr.ya, cr.yb, t0), lerp(cr.ya, cr.yb, t1)) + APRON_Y;
      const ring = segRing(cr.pts[i], cr.pts[i + 1], cr.hw);
      if (!ring) continue;
      emitDeckSlab(mbD, mbS, ring, y, M.pierDeck, M.pierFascia, y - 0.85);
      const mid = [(cr.pts[i][0] + cr.pts[i + 1][0]) * 0.5, (cr.pts[i][1] + cr.pts[i + 1][1]) * 0.5];
      if (((i - cr.a) & 1) === 0 && waterAt(H.field, mid[0], mid[1])) {
        setMat(mbS, M.pile);
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          let tx = cr.pts[i + 1][0] - cr.pts[i][0], tz = cr.pts[i + 1][1] - cr.pts[i][1];
          const l = Math.hypot(tx, tz);
          if (!(l > EPS)) continue;
          tx /= l; tz /= l;
          const px = mid[0] - tz * sgn * (cr.hw - 0.35), pz = mid[1] + tx * sgn * (cr.hw - 0.35);
          mbS.cylinder(px, H.waterY - 2.8, pz, 0.20, 0.17, y - 0.6 - (H.waterY - 2.8), 5,
            hash01(px, pz) * TAU, false);
          c.note('pile');
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- piers */

export function appendPiers(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain;
  for (let i = 0; i < H.piers.length; i++) {
    const rec = H.piers[i];
    if (!rec.ring || rec.ring.length < 3) continue;
    const deck = rec.y;
    emitDeckSlab(mbD, mbS, rec.ring, deck, M.pierDeck, M.pierFascia, deck - 1.25);
    emitPileField(mbS, rec.ring, deck - 1.05, -2.9, c);
    // Fenders and a rail down each long side, and a marker on the head.
    const bb = rec.bbox;
    if (Math.max(bb[2] - bb[0], bb[3] - bb[1]) > 26) {
      const head = ringFarthest(rec.ring, quayAnchor(H, rec.cen[0], rec.cen[1]));
      if (head && c.claim(head[0], head[1], 2.0)) {
        appendNavMarker(c.mb.props, head[0], H.waterY, head[1], 3.2,
          hash01(head[0], head[1]) < 0.5);
        c.note('navMarker');
      }
    }
  }
  // Floating finger berths.
  for (let i = 0; i < H.fingers.length; i++) {
    const rec = H.fingers[i];
    const ring = ribbonRing(rec.p, FINGER_W * 0.5);
    if (!ring) continue;
    emitFloat(mbD, mbS, ring, H.waterY);
  }
}

// A slab: deck cap plus a fascia skirt all the way round, down to `foot`.
function emitDeckSlab(mbD, mbS, ring, y, capMat, sideMat, foot) {
  setMat(mbD, capMat);
  const tri = earClip(ring);
  for (let i = 0; i < tri.length; i += 3) {
    const a = ring[tri[i]], b = ring[tri[i + 1]], d = ring[tri[i + 2]];
    triUp(mbD, a[0], y, a[1], b[0], y, b[1], d[0], y, d[1]);
  }
  setMat(mbS, sideMat);
  const ccw = planArea(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    let ox = -(b[1] - a[1]), oz = b[0] - a[0];
    if (!ccw) { ox = -ox; oz = -oz; }
    const l = Math.hypot(ox, oz);
    if (l < EPS) continue;
    quadOut(mbS, a[0], foot, a[1], b[0], foot, b[1], b[0], y, b[1], a[0], y, a[1], ox / l, 0, oz / l);
  }
}

// Timber piles on a grid under a deck, only where the deck actually covers them.
function emitPileField(mb, ring, top, bottom, c) {
  const bb = bboxOf(ring);
  setMat(mb, M.pile);
  for (let z = bb[1] + PILE_SPACING * 0.5; z < bb[3]; z += PILE_SPACING) {
    for (let x = bb[0] + PILE_SPACING * 0.5; x < bb[2]; x += PILE_SPACING) {
      const jx = x + (hash01(x, z) - 0.5) * 0.7;
      const jz = z + (hash01(z, x) - 0.5) * 0.7;
      if (!pointInRing(ring, jx, jz)) continue;
      mb.cylinder(jx, bottom, jz, 0.21, 0.185, top - bottom, 5, hash01(jx, jz) * TAU, false);
      c.note('pile');
    }
  }
}

// A floating dock: deck, a body sitting in the water, and a rub rail.
function emitFloat(mbD, mbS, ring, waterY) {
  const top = waterY + FLOAT_TOP;
  setMat(mbD, M.floatDeck);
  const tri = earClip(ring);
  for (let i = 0; i < tri.length; i += 3) {
    const a = ring[tri[i]], b = ring[tri[i + 1]], d = ring[tri[i + 2]];
    triUp(mbD, a[0], top, a[1], b[0], top, b[1], d[0], top, d[1]);
  }
  setMat(mbS, M.floatBody);
  const ccw = planArea(ring) > 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    let ox = -(b[1] - a[1]), oz = b[0] - a[0];
    if (!ccw) { ox = -ox; oz = -oz; }
    const l = Math.hypot(ox, oz);
    if (l < EPS) continue;
    quadOut(mbS, a[0], waterY - FLOAT_DRAFT, a[1], b[0], waterY - FLOAT_DRAFT, b[1],
      b[0], top, b[1], a[0], top, a[1], ox / l, 0, oz / l);
  }
}

function ringFarthest(ring, from) {
  let best = -1, p = null;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - from[0], ring[i][1] - from[1]);
    if (d > best) { best = d; p = ring[i]; }
  }
  return p;
}

function quayAnchor(H, x, z) {
  const hit = nearestShore(H, x, z);
  return hit ? [hit.qx, hit.qz] : [x, z];
}

/* ------------------------------------------------------- breakwaters, mounds */

/**
 * Rubble mound: a heightfield raster over the structure, crest in the middle, battered flanks
 * running down past the waterline to the toe. Works for a closed breakwater ring and for an open
 * groyne line alike, and needs no offsetting or skeleton, so a pathological outline cannot fold it.
 */
export function appendMounds(H, c) {
  const mb = c.mb.terrain;
  for (let m = 0; m < H.mounds.length; m++) {
    const rec = H.mounds[m];
    const closed = rec.closed;
    const ring = closed ? rec.p.slice(0, rec.p.length - 1) : null;
    const bb = rec.bbox;
    const pad = closed ? 0 : GROYNE_HW;
    const x0 = bb[0] - pad, z0 = bb[1] - pad, x1 = bb[2] + pad, z1 = bb[3] + pad;
    const ni = Math.max(1, Math.ceil((x1 - x0) / MOUND_CELL));
    const nj = Math.max(1, Math.ceil((z1 - z0) / MOUND_CELL));
    if (ni * nj > 60000) continue;
    const hgt = new Float64Array((ni + 1) * (nj + 1));
    const inside = new Uint8Array((ni + 1) * (nj + 1));
    for (let j = 0; j <= nj; j++) {
      const z = z0 + j * MOUND_CELL;
      for (let i = 0; i <= ni; i++) {
        const x = x0 + i * MOUND_CELL;
        const k = j * (ni + 1) + i;
        let d;
        if (closed) {
          if (!pointInRing(ring, x, z)) continue;
          d = distToPoly(x, z, rec.p);
        } else {
          d = GROYNE_HW - distToPoly(x, z, rec.p);
          if (d <= 0) continue;
        }
        inside[k] = 1;
        hgt[k] = H.waterY + lerp(MOUND_TOE, MOUND_CREST, clamp(d / MOUND_SLOPE, 0, 1));
      }
    }
    setMat(mb, M.rubble);
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const k00 = j * (ni + 1) + i, k10 = k00 + 1;
        const k01 = k00 + ni + 1, k11 = k01 + 1;
        if (!inside[k00] || !inside[k10] || !inside[k01] || !inside[k11]) continue;
        const xa = x0 + i * MOUND_CELL, xb = xa + MOUND_CELL;
        const za = z0 + j * MOUND_CELL, zb = za + MOUND_CELL;
        quadUp(mb, xa, hgt[k01], zb, xb, hgt[k11], zb, xb, hgt[k10], za, xa, hgt[k00], za);
      }
    }
    // Skirt around the edge cells so the mound is closed against the lake bed rather than
    // ending in an open sheet you can see under.
    setMat(mb, M.rubbleWet);
    const toe = H.waterY + MOUND_TOE;
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const kc = [j * (ni + 1) + i, j * (ni + 1) + i + 1,
          (j + 1) * (ni + 1) + i + 1, (j + 1) * (ni + 1) + i];
        let n = 0;
        for (let e = 0; e < 4; e++) if (inside[kc[e]]) n++;
        if (n === 0 || n === 4) continue;
        const xa = x0 + i * MOUND_CELL, xb = xa + MOUND_CELL;
        const za = z0 + j * MOUND_CELL, zb = za + MOUND_CELL;
        const px = [xa, xb, xb, xa], pz = [za, za, zb, zb];
        const cx = (xa + xb) * 0.5, cz = (za + zb) * 0.5;
        for (let e = 0; e < 4; e++) {
          const a = e, b = (e + 1) % 4;
          if (!inside[kc[a]] || !inside[kc[b]]) continue;
          const mx = (px[a] + px[b]) * 0.5 - cx, mz = (pz[a] + pz[b]) * 0.5 - cz;
          quadOut(mb, px[a], toe, pz[a], px[b], toe, pz[b],
            px[b], hgt[kc[b]], pz[b], px[a], hgt[kc[a]], pz[a], mx, 0, mz);
        }
      }
    }
    // Armour blocks on the crest, seeded on world position.
    for (let t = 0; t < rec.p.length - 1 && c.rocks < MAX_ROCKS; t++) {
      const a = rec.p[t], b = rec.p[t + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.floor(len / 5.5);
      for (let k = 0; k < n && c.rocks < MAX_ROCKS; k++) {
        const f = (k + 0.5) / n;
        const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        const h = hash01(x, z);
        appendWaveRock(c.mb.props, null, x, H.waterY + MOUND_TOE * 0.2, z, 1.0 + h * 1.5);
        c.rocks++;
        c.note('armourStone');
      }
    }
  }
}

/* ------------------------------------------------------------------ marinas */

export function appendMarinas(H, c) {
  const mb = c.mb.props;
  for (let m = 0; m < H.marinas.length; m++) {
    const rec = H.marinas[m];
    // Gangway from the quay down to the nearest float, and a marker at the basin mouth.
    const hit = nearestShore(H, rec.cen[0], rec.cen[1]);
    if (hit) {
      const g = lerp(hit.run.g[hit.i], hit.run.g[hit.i + 1], hit.t);
      const ux = rec.cen[0] - hit.qx, uz = rec.cen[1] - hit.qz;
      const ul = Math.hypot(ux, uz);
      if (ul > EPS && c.claim(hit.qx, hit.qz, 3.0)) {
        appendGangway(mb, hit.qx + (ux / ul) * 0.6, g + COPE_TOP, hit.qz + (uz / ul) * 0.6,
          Math.atan2(-(uz / ul), ux / ul), 8.0, g + COPE_TOP - (H.waterY + FLOAT_TOP));
        c.note('gangway');
      }
    }
    // Mooring buoys and a few moored craft inside the basin, on a deterministic lattice.
    const bb = rec.bbox;
    let own = 0;
    for (let z = bb[1] + 18; z < bb[3] - 8 && c.moored < MAX_MOORED && own < MAX_MOORED_BASIN;
      z += 34) {
      for (let x = bb[0] + 18; x < bb[2] - 8 && c.moored < MAX_MOORED && own < MAX_MOORED_BASIN;
        x += 34) {
        const jx = x + (hash01(x, z) - 0.5) * 16, jz = z + (hash01(z, x) - 0.5) * 16;
        if (!pointInRing(rec.p, jx, jz) || !waterAt(H.field, jx, jz)) continue;
        const hs = nearestShore(H, jx, jz);
        if (hs && hs.side > -6) continue;                 // keep clear of the wall
        if (!c.claim(jx, jz, 7.0)) continue;
        if (hash01(jx + 3.1, jz - 7.7) < 0.34) {
          appendMooringBuoy(mb, jx, H.waterY, jz, 0.36 + hash01(jx, jz) * 0.2);
          c.note('mooringBuoy');
        } else {
          appendBoat(mb, rngAt(jx, jz), jx, H.waterY, jz, hash01(jx, jz) * TAU,
            7.5 + hash01(jz, jx) * 6);
          c.note('boat');
          c.moored++;
          own++;
        }
      }
    }
  }
}

/* ----------------------------------------------------------- ferry terminal */

/**
 * Ferry terminal slips. Toronto's are at the foot of Bay Street: a deck apron on the quay with
 * finger piers running out into the harbour, the slips between them open to the water, fender
 * dolphins at every slip mouth and a mooring dolphin off the end.
 */
export function appendFerryTerminal(H, c) {
  const mbD = c.mb.sidewalks, mbS = c.mb.terrain, mbP = c.mb.props;
  for (let t = 0; t < H.terminals.length; t++) {
    const rec = H.terminals[t];
    if (rec.p && rec.ring) {
      emitDeckSlab(mbD, mbS, rec.ring, rec.y, M.terminal, M.pierFascia, rec.y - 1.6);
      emitPileField(mbS, rec.ring, rec.y - 1.4, -3.0, c);
      continue;
    }
    const a = rec.anchor;
    if (!a) continue;
    const run = a.run, i = a.i;
    let nx = lerp(run.nx[i], run.nx[i + 1], a.t), nz = lerp(run.nz[i], run.nz[i + 1], a.t);
    const nl = Math.hypot(nx, nz);
    if (nl < EPS) continue;
    nx /= nl; nz /= nl;
    const tx = -nz, tz = nx;
    const g = lerp(run.g[i], run.g[i + 1], a.t);
    const deck = g + PIER_LIFT;
    const SLIPS = 3, SLIP_W = 15.0, FINGER_LEN = 34.0, FINGER_HW = 3.2;
    const span = SLIPS * SLIP_W;

    for (let k = 0; k <= SLIPS; k++) {
      const off = -span * 0.5 + k * SLIP_W;
      const bx = a.x + tx * off, bz = a.z + tz * off;
      const ring = [
        [bx - tx * FINGER_HW, bz - tz * FINGER_HW],
        [bx - tx * FINGER_HW + nx * FINGER_LEN, bz - tz * FINGER_HW + nz * FINGER_LEN],
        [bx + tx * FINGER_HW + nx * FINGER_LEN, bz + tz * FINGER_HW + nz * FINGER_LEN],
        [bx + tx * FINGER_HW, bz + tz * FINGER_HW],
      ];
      emitDeckSlab(mbD, mbS, ring, deck, M.terminal, M.pierFascia, deck - 1.5);
      emitPileField(mbS, ring, deck - 1.3, -3.2, c);
      // Berthing dolphins at the head of every finger.
      const hx = bx + nx * (FINGER_LEN + 4.5), hz = bz + nz * (FINGER_LEN + 4.5);
      if (c.claim(hx, hz, 2.4)) {
        appendDolphin(mbP, rngAt(hx, hz), hx, H.waterY, hz, 0.95);
        c.note('dolphin');
      }
      // A rail down the outer edges only — the slip faces stay clear for the ramps.
      const mx = bx + nx * FINGER_LEN * 0.5, mz = bz + nz * FINGER_LEN * 0.5;
      if (c.claim(mx + tx * FINGER_HW, mz + tz * FINGER_HW, 1.2)) {
        appendQuayRailing(mbP, mx + tx * (FINGER_HW - 0.25), deck, mz + tz * (FINGER_HW - 0.25),
          Math.atan2(-nz, nx), FINGER_LEN - 3.0);
        c.note('quayRailing');
      }
    }
    // Landside apron tying the fingers back into the promenade.
    const ap = [
      [a.x - tx * (span * 0.5 + 3) - nx * 1.0, a.z - tz * (span * 0.5 + 3) - nz * 1.0],
      [a.x - tx * (span * 0.5 + 3) + nx * 3.0, a.z - tz * (span * 0.5 + 3) + nz * 3.0],
      [a.x + tx * (span * 0.5 + 3) + nx * 3.0, a.z + tz * (span * 0.5 + 3) + nz * 3.0],
      [a.x + tx * (span * 0.5 + 3) - nx * 1.0, a.z + tz * (span * 0.5 + 3) - nz * 1.0],
    ];
    emitDeckSlab(mbD, mbS, ap, deck, M.terminal, M.pierFascia, deck - 1.5);
    for (let k = 0; k < SLIPS; k++) {
      const off = -span * 0.5 + (k + 0.5) * SLIP_W;
      const bx = a.x + tx * off + nx * 2.0, bz = a.z + tz * off + nz * 2.0;
      if (!c.claim(bx, bz, 2.0)) continue;
      appendNavMarker(mbP, bx + nx * (FINGER_LEN + 2), H.waterY, bz + nz * (FINGER_LEN + 2),
        3.0, (k & 1) === 0);
      c.note('navMarker');
    }
  }
}

/* ---------------------------------------------------------------- walkways */

/**
 * The three public routes along the water get their real surfaces: timber for the boardwalk,
 * asphalt for the Martin Goodman / Waterfront Recreational Trail, and the promenade paving that
 * the quay apron already lays down. city.js has already built these ways as generic footways on
 * the ground; these run one rung above that, so the correct surface is what you see and the
 * generic ribbon underneath can never fight it.
 */
export function appendWalkways(H, c) {
  const data = c.data;
  if (!data || !Array.isArray(data.roads)) return;
  const mb = c.mb.sidewalks;
  const T = H.terrain;
  const gy = (x, z) => {
    const d = harbourDeckY(H, x, z);
    const t = sampleTerrain(T, x, z);
    return d > t ? d : t;
  };
  let boardMetres = 0, trailMetres = 0;
  for (let i = 0; i < data.roads.length; i++) {
    const r = data.roads[i];
    if (!r || typeof r.n !== 'string' || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.tun === 1) continue;
    const board = /boardwalk/i.test(r.n);
    const trail = /martin goodman|recreational trail|waterfront trail/i.test(r.n);
    if (!board && !trail) continue;
    // Only along the water: the trail network runs far inland in the full city extract and those
    // stretches belong to the street pass, not to the harbour.
    const cen = centroidOf(r.p);
    const near = nearestShore(H, cen[0], cen[1]);
    if (!near || near.d > 150) continue;
    const pts = resample(r.p, 4.0);
    const hw = clamp(isNum(r.w) ? r.w * 0.5 : 1.6, 1.2, 3.2);
    if (board) boardMetres += polyLength(pts); else trailMetres += polyLength(pts);
    emitWalkRibbon(mb, pts, hw, gy, board);
  }
  H.stats.boardwalkMetres = boardMetres;
  H.stats.trailMetres = trailMetres;
}

function emitWalkRibbon(mb, pts, hw, gy, board) {
  const n = pts.length;
  const lift = board ? BOARD_LIFT : TRAIL_LIFT;
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    nx[i] = -tz; nz[i] = tx;
  }
  const boards = board ? 5 : 1;
  for (let i = 0; i + 1 < n; i++) {
    const y0 = gy(pts[i][0], pts[i][1]) + lift;
    const y1 = gy(pts[i + 1][0], pts[i + 1][1]) + lift;
    for (let k = 0; k < boards; k++) {
      const g = board ? 0.035 : 0;
      const oa = -hw + (k / boards) * 2 * hw + g;
      const ob = -hw + ((k + 1) / boards) * 2 * hw - g;
      setMat(mb, board ? M.boardwalk : M.trail);
      quadUp(mb,
        pts[i][0] + nx[i] * oa, y0, pts[i][1] + nz[i] * oa,
        pts[i][0] + nx[i] * ob, y0, pts[i][1] + nz[i] * ob,
        pts[i + 1][0] + nx[i + 1] * ob, y1, pts[i + 1][1] + nz[i + 1] * ob,
        pts[i + 1][0] + nx[i + 1] * oa, y1, pts[i + 1][1] + nz[i + 1] * oa);
    }
    // Fascia down each side so a raised deck reads as a deck and never as a floating sheet.
    setMat(mb, board ? M.boardEdge : M.promEdge);
    for (let s = -1; s <= 1; s += 2) {
      const o = s * hw;
      const ax = pts[i][0] + nx[i] * o, az = pts[i][1] + nz[i] * o;
      const bx = pts[i + 1][0] + nx[i + 1] * o, bz = pts[i + 1][1] + nz[i + 1] * o;
      const fa = gy(ax, az) + (board ? 0.04 : 0.02);
      const fb = gy(bx, bz) + (board ? 0.04 : 0.02);
      quadOut(mb, ax, fa, az, bx, fb, bz, bx, y1, bz, ax, y0, az, nx[i] * s, 0, nz[i] * s);
    }
  }
}

/* --------------------------------------------------------------- furniture */

export function appendQuayFurniture(H, c) {
  const mb = c.mb.props;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    const total = run.s[run.n - 1];
    // Bollards and ladders are bolted THROUGH the coping stone; everything else stands on the
    // apron, a couple of centimetres up so a base plate never fights the paving it sits on.
    const cope = COPE_W * 0.45;
    const deck = 0.02 + APRON_Y;
    place(run, total, BOLLARD_SPACING, 0.0, (st, x, z, yaw) => {
      appendMooringBollard(mb, x, st.g + COPE_TOP, z, yaw);
      c.note('mooringBollard');
    }, 0.42, cope);
    place(run, total, LADDER_SPACING, 0.31, (st, x, z, yaw) => {
      appendQuayLadder(mb, x, st.g + COPE_TOP, z, yaw, st.g + COPE_TOP - (H.waterY - 1.1));
      c.note('quayLadder');
    }, 0.5, 0.30);
    place(run, total, LIFEBUOY_SPACING, 0.57, (st, x, z, yaw) => {
      appendLifebuoyStation(mb, x, st.g + deck, z, yaw);
      c.note('lifebuoyStation');
    }, 0.7, 2.6);
    place(run, total, QUAY_LAMP_SPACING, 0.13, (st, x, z, yaw) => {
      const a = yaw + Math.PI;
      appendPedestrianLamp(mb, x, st.g + deck, z, a, 5.2);
      // The head hangs 0.76 m out along the boom at 5.26 m — the offsets props/ builds it at.
      c.light('ped', x + Math.cos(a) * 0.76, st.g + deck + 5.26, z - Math.sin(a) * 0.76);
      c.note('quayLamp');
    }, 0.9, 3.4);
    place(run, total, BENCH_SPACING, 0.77, (st, x, z, yaw) => {
      appendTimberBench(mb, rngAt(x, z), x, st.g + deck, z, yaw + Math.PI * 0.5);
      c.note('timberBench');
    }, 1.2, 4.6);
  }

  function place(run, total, spacing, phase, fn, radius, inset) {
    for (let d = spacing * phase; d < total; d += spacing) {
      const st = atArc(run, d);
      if (!st) continue;
      // Everything sits inside the apron, measured back from the wall face.
      const back = Math.min(inset, Math.max(0.35, st.w - 1.4)) - st.pr;
      const x = st.x - st.nx * back, z = st.z - st.nz * back;
      if (!c.claim(x, z, radius)) continue;
      fn(st, x, z, Math.atan2(-st.nz, st.nx));
    }
  }
}
