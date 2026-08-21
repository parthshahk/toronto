// src/world/fringe.js — the geometry of the world's edge: streets, blocks, bank and apron.
//
// CONTRACT.md §9.2, §9.3 and Amendment 11.1. Moved out of city.js unchanged. world/surround.js
// works out WHAT the fringe would carry; this module emits it:
//
//   emitSurroundStreet()  one synthesised street: carriageway, and a kerbed pavement wherever the
//                         player can actually reach it.
//   emitSurroundBlock()   the generic massing in one fringe block, walked by forEachSurroundMass()
//                         so the same subdivision drives both the geometry and the collision index.
//   emitFringeBank()      the riprap band that clads every land/water meeting past the survey, so
//                         no raw polygon edge is ever visible where the ground meets the lake.
//   emitSurroundApron()   four rings of very large quads carrying the ground out to HAZE_REACH.
//
// Everything is hashed on WORLD POSITION, never on an array index, so a fringe mass looks the
// same whichever tiles happen to be resident (CONTRACT §8.4). Nothing here bakes light.

import { clamp, lerp, smoothstep } from '../core/math.js';
import { isNum, hashPos } from '../core/util.js';
import { shoelace } from '../geom/ring.js';
import { polyResample, pruneSpikes, polyFrames } from '../geom/ribbon.js';
import { emitPrism } from '../geom/extrude.js';
import { M, setMat, facadeMaterial, roofMat } from '../city/materials.js';
import { EPS, ROAD_Y, CROWN, CURB, WATER_Y, triUp } from './ground.js';
import { terrainNormals } from './terrain.js';
import {
  BANK_LIFT, BANK_TOE, BANK_TOP, SUR_COVER_DECAY, SUR_FADE_IN, SUR_H_DECAY, SUR_H_JITTER,
  SUR_H_MIN, SUR_MASS_CAP, SUR_MASS_MAX, SUR_MASS_MIN, SUR_ROAD_SEG, SUR_SETBACK,
  SUR_TALL_MAX, SUR_TALL_P,
} from './surround.js';
import { emitRibbon } from './audit.js';

/* ------------------------------------------------------- surround geometry -- */

/** One synthesised street: carriageway, and a kerbed pavement where the player can reach it. */
function emitSurroundStreet(C, rec) {
  let pts = polyResample(rec.p, SUR_ROAD_SEG);
  if (pts.length < 2) return;
  const hw = rec.w * 0.5;
  const walk = rec.t <= C.surWalk;
  const reach = hw + (walk ? 2.8 : 0.4);
  pts = pruneSpikes(pts, reach);
  if (pts.length < 2) return;
  const frames = polyFrames(pts, reach);
  const yAt = (x, z) => C.groundY(x, z) + ROAD_Y;
  const mbR = C.mb.roads;
  setMat(mbR, M.asphalt);
  emitRibbon(mbR, pts, frames, [{ o: -hw, dy: 0 }, { o: 0, dy: CROWN }, { o: hw, dy: 0 }], yAt);
  if (!walk) return;
  // Kerb face and pavement, only where the player can actually reach it. The cross-section is
  // always given in INCREASING offset, which is what emitRibbon's winding test expects.
  const mbS = C.mb.sidewalks;
  setMat(mbS, M.sidewalk);
  emitRibbon(mbS, pts, frames, [
    { o: -(hw + 2.6), dy: CURB }, { o: -hw, dy: CURB }, { o: -hw, dy: 0 },
  ], yAt);
  emitRibbon(mbS, pts, frames, [
    { o: hw, dy: 0 }, { o: hw, dy: CURB }, { o: hw + 2.6, dy: CURB },
  ], yAt);
}

/**
 * Enumerate the generic masses of one synthesised block: between one and SUR_MASS_CAP of them, at
 * the height and density the real district just inside the boundary was measured at, thinning
 * with distance out.
 *
 * A PURE function of the block and of world position — every choice is hashed on the mass's own
 * centre — so the geometry pass and the collision registration below enumerate exactly the same
 * buildings, and a tile rebuilt after eviction is identical to the one it replaces.
 *
 * `visit(ring, groundY, height, cx, cz)` gets a plan-CCW flat ring, ready for emitPrism.
 */
function forEachSurroundMass(blk, terrainY, visit, blocked) {
  const co = blk.co;
  // Inset from the streets that bound it.
  const inset = blk.streetHW + SUR_SETBACK;
  const cx = blk.mx, cz = blk.mz;
  const pull = (p) => {
    let dx = cx - p[0], dz = cz - p[1];
    const l = Math.hypot(dx, dz);
    if (!(l > EPS)) return [p[0], p[1]];
    const k = Math.min(inset / l, 0.42);
    return [p[0] + dx * k, p[1] + dz * k];
  };
  const q = [pull(co[0]), pull(co[1]), pull(co[2]), pull(co[3])];
  const eU = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  const eV = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  if (eU < SUR_MASS_MIN || eV < SUR_MASS_MIN) return;
  const nU = clamp(Math.round(eU / SUR_MASS_MAX) || 1, 1, SUR_MASS_CAP);
  const nV = clamp(Math.round(eV / SUR_MASS_MAX) || 1, 1, SUR_MASS_CAP);
  const decayH = Math.pow(0.5, blk.t / SUR_H_DECAY);
  const decayC = Math.pow(0.5, blk.t / SUR_COVER_DECAY);
  // ...and a taper to nothing over the last stretch of the fringe. Without it the invented city
  // stops on a line — the last ring of blocks is still at 40% of its density and then there is
  // bare ground — and a line is exactly what §9.3 says must not be there. With it the blocks
  // thin to scattered outliers and then to open country, which is what the edge of a city looks
  // like from the air and what the haze can then finish.
  const fade = 1 - smoothstep(blk.fringe * SUR_FADE_IN, blk.fringe, blk.t);
  const base = Math.max(SUR_H_MIN, blk.h * decayH);
  const cover = clamp(blk.cover * decayC * 2.4 * fade, 0, 0.94);
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let v = 0; v < nV; v++) {
    for (let u = 0; u < nU; u++) {
      // Bilinear sub-quad of the block, then a gap so the masses read as separate buildings.
      const u0 = u / nU, u1 = (u + 1) / nU, v0 = v / nV, v1 = (v + 1) / nV;
      const corner = (uu, vv) => lerp2(lerp2(q[0], q[1], uu), lerp2(q[3], q[2], uu), vv);
      const p00 = corner(u0, v0), p10 = corner(u1, v0);
      const p11 = corner(u1, v1), p01 = corner(u0, v1);
      const mx = (p00[0] + p10[0] + p11[0] + p01[0]) * 0.25;
      const mz = (p00[1] + p10[1] + p11[1] + p01[1]) * 0.25;
      if (hashPos(mx, mz, 0x5e1) > cover) continue;
      // Side yard, hashed: a constant gap subdivides every block into identical slabs, which is
      // what makes generated filler read as generated.
      const gap = 1.2 + hashPos(mx, mz, 0x5e4) * 3.3;
      const shrink = (p) => {
        let dx = mx - p[0], dz = mz - p[1];
        const l = Math.hypot(dx, dz);
        if (!(l > EPS)) return [p[0], p[1]];
        const k = Math.min(gap / l, 0.40);
        return [p[0] + dx * k, p[1] + dz * k];
      };
      const s00 = shrink(p00), s10 = shrink(p10), s11 = shrink(p11), s01 = shrink(p01);
      const w = Math.hypot(s10[0] - s00[0], s10[1] - s00[1]);
      const d = Math.hypot(s01[0] - s00[0], s01[1] - s00[1]);
      if (w < SUR_MASS_MIN * 0.5 || d < SUR_MASS_MIN * 0.5) continue;
      // Height: the district mean, decayed outward, jittered on world position, and quantised to
      // whole storeys so the fringe skyline has the same step a real one does.
      const j = 1 + (hashPos(mx, mz, 0x5e2) * 2 - 1) * SUR_H_JITTER;
      // ...and the outliers. Every real district has a handful of buildings several times the
      // height of the stock around them — the tower at the subway stop, the slab on the
      // arterial — and a fringe drawn only from the MEAN of its neighbours has none of them,
      // which reads from the air as a container yard rather than as a city.
      const tall = hashPos(mx, mz, 0x5e5);
      const spike = tall < SUR_TALL_P ? lerp(2.2, SUR_TALL_MAX, tall / SUR_TALL_P) : 1;
      const storeys = Math.max(1, Math.round((base * j * spike) / 3.4));
      const h = storeys * 3.4;
      // Ground: the lowest corner, so nothing floats on a slope; the wall starts below it.
      let g = Infinity;
      for (const p of [s00, s10, s11, s01]) {
        const y = terrainY(p[0], p[1]);
        if (isNum(y) && y < g) g = y;
      }
      if (!isFinite(g)) continue;
      // A surveyed footprint is the authority wherever it reaches, and the extract clips at the
      // bounding box rather than at the building, so real footprints spill up to a hundred metres
      // into the fringe. Never invent a mass on top of one. Tested on the centre AND the corners,
      // and by the SAME predicate in both the geometry pass and the collision registration, so
      // what you walk into is still exactly what you can see.
      if (blocked && (blocked(mx, mz) || blocked(s00[0], s00[1]) || blocked(s10[0], s10[1])
        || blocked(s11[0], s11[1]) || blocked(s01[0], s01[1]))) continue;
      let ring = [s00[0], -s00[1], s10[0], -s10[1], s11[0], -s11[1], s01[0], -s01[1]];
      // Plan-CCW, so the prism's walls face out and its cap faces the sky.
      if (shoelace(ring, 0, ring.length) < 0) {
        ring = [ring[6], ring[7], ring[4], ring[5], ring[2], ring[3], ring[0], ring[1]];
      }
      visit(ring, g, h, mx, mz);
    }
  }
}

/** The geometry of one synthesised block. */
function emitSurroundBlock(C, blk) {
  forEachSurroundMass(blk, C.terrainY, (ring, g, h, mx, mz) => {
    const profile = h >= 34 ? (hashPos(mx, mz, 0x5e3) < 0.45 ? 1 : 2) : (h >= 12 ? 3 : 5);
    const spec = facadeMaterial({ h, y: g, cx: mx, cz: mz, t: profile }, null);
    const mb = spec.glassy ? C.mb.glass : C.mb.buildings;
    setMat(mb, spec.mat);
    emitPrism(mb, ring, ring, g - 1.6, g + h, false);
    // The roof is its own material and PROFILE 0 without exception, exactly as the surveyed
    // city's is: a roof that emits window light is the loudest tell there is.
    const mbR = C.mb.buildings;
    setMat(mbR, roofMat(spec.mat));
    const top = g + h;
    for (let k = 4; k < ring.length; k += 2) {
      mbR.tri(ring[0], top, -ring[1], ring[k - 2], top, -ring[k - 1], ring[k], top, -ring[k + 1]);
    }
    C.stats.surround.masses++;
  }, C.realFoot);
}

/**
 * The riprap bank where the synthesised ground meets the water (CONTRACT §9.2).
 *
 * Inside the survey every land/water meeting is an engineered edge that harbour.js builds from
 * surveyed geometry — a quay wall, a beach, a mound of rubble. Outside it there is no survey to
 * build from, and the padded terrain on its own would hand the lake a bare slope of ground: a
 * surface that simply becomes water, which §9.2 forbids in as many words.
 *
 * So the waterline is found in the terrain itself — marching squares over the padded grid, cell
 * by cell, wherever a cell straddles the water plane outside the surveyed rectangle — and clad in
 * a band of riprap: a crest a metre above the water, the waterline itself, and a toe below it, all
 * laid a few centimetres proud of the ground so the stone is what the lake meets and the water
 * plane never intersects bare terrain at a grazing angle.
 *
 * Per tile, from the tile's own terrain cells, so it costs nothing where there is no shore and is
 * built and evicted exactly like the ground it clads.
 */
function emitFringeBank(C, T, i0, i1, j0, j1, extent) {
  const { nx, nz, cell, x0, z0, h } = T;
  const EX = extent.x / 2, EZ = extent.z / 2;
  const mb = C.mb.terrain;
  const ia = Math.max(0, i0), ib = Math.min(nx - 1, i1);
  const ja = Math.max(0, j0), jb = Math.min(nz - 1, j1);
  let set = false;
  const grad = [0, 0];
  const upAt = (gi, gj) => {
    const a = clamp(gi, 1, nx - 2), b = clamp(gj, 1, nz - 2);
    // Uphill, i.e. inland: the ground rises away from the water on the land side by definition.
    let ux = h[b * nx + a - 1] - h[b * nx + a + 1];
    let uz = h[(b - 1) * nx + a] - h[(b + 1) * nx + a];
    const l = Math.hypot(ux, uz);
    if (l > EPS) { ux /= l; uz /= l; } else { ux = 1; uz = 0; }
    grad[0] = ux; grad[1] = uz;
    // Steepness, metres of rise per metre of plan, from the same central difference.
    const rise = Math.hypot(h[b * nx + a - 1] - h[b * nx + a + 1],
      h[(b - 1) * nx + a] - h[(b + 1) * nx + a]) / (2 * cell);
    return rise > 0.02 ? rise : 0.02;
  };
  for (let j = ja; j < jb; j++) {
    for (let i = ia; i < ib; i++) {
      const xa = x0 + i * cell, xb = xa + cell;
      const za = z0 + j * cell, zb = za + cell;
      // Only outside the surveyed rectangle: inside it the quay, the beach and the rubble mounds
      // are real geometry built from real data and this would be a second, invented edge.
      if (xb > -EX && xa < EX && zb > -EZ && za < EZ) continue;
      const y00 = h[j * nx + i], y10 = h[j * nx + i + 1];
      const y01 = h[(j + 1) * nx + i], y11 = h[(j + 1) * nx + i + 1];
      const s00 = y00 > WATER_Y, s10 = y10 > WATER_Y;
      const s01 = y01 > WATER_Y, s11 = y11 > WATER_Y;
      const nWet = (s00 ? 0 : 1) + (s10 ? 0 : 1) + (s01 ? 0 : 1) + (s11 ? 0 : 1);
      if (nWet === 0 || nWet === 4) continue;
      // Marching squares: the crossing point on each edge that straddles the water plane.
      const cross = [];
      const edge = (ax, az, av, bx, bz, bv) => {
        if ((av > WATER_Y) === (bv > WATER_Y)) return;
        const t = clamp((WATER_Y - av) / ((bv - av) || EPS), 0, 1);
        cross.push(ax + (bx - ax) * t, az + (bz - az) * t);
      };
      edge(xa, za, y00, xb, za, y10);
      edge(xb, za, y10, xb, zb, y11);
      edge(xb, zb, y11, xa, zb, y01);
      edge(xa, zb, y01, xa, za, y00);
      if (cross.length < 4) continue;
      if (!set) { setMat(mb, M.riprap); set = true; }
      for (let k = 0; k + 3 < cross.length; k += 4) {
        const ax = cross[k], az = cross[k + 1], bx = cross[k + 2], bz = cross[k + 3];
        if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
        const rise = upAt(Math.round((((ax + bx) * 0.5) - x0) / cell),
          Math.round((((az + bz) * 0.5) - z0) / cell));
        const ux = grad[0], uz = grad[1];
        const inW = clamp(BANK_TOP / rise, 0.8, 7.0);
        const toeW = clamp(-BANK_TOE / rise, 0.6, 6.0);
        const crest = WATER_Y + BANK_TOP + BANK_LIFT;
        const wl = WATER_Y + BANK_LIFT;
        const toe = WATER_Y + BANK_TOE;
        const iax = ax + ux * inW, iaz = az + uz * inW;
        const ibx = bx + ux * inW, ibz = bz + uz * inW;
        const tax = ax - ux * toeW, taz = az - uz * toeW;
        const tbx = bx - ux * toeW, tbz = bz - uz * toeW;
        triUp(mb, iax, crest, iaz, ibx, crest, ibz, bx, wl, bz);
        triUp(mb, iax, crest, iaz, bx, wl, bz, ax, wl, az);
        triUp(mb, ax, wl, az, bx, wl, bz, tbx, toe, tbz);
        triUp(mb, ax, wl, az, tbx, toe, tbz, tax, toe, taz);
        C.stats.surround.bankMetres += Math.hypot(bx - ax, bz - az);
      }
      C.stats.surround.bankCells++;
    }
  }
}

/**
 * The apron: the ground between the last tile and the horizon (CONTRACT §9.3, §9.4).
 *
 * Past the padded terrain grid the height field is constant in the outward direction — that is
 * what edge replication means — so the surface out there is exactly a ruled extrusion of the
 * grid's boundary row, and two rings of quads describe it without a single metre of error. Its
 * vertices, its heights and its normals are read from the grid's own boundary, so the join is not
 * a join: the apron's inner edge IS the terrain's outer edge, vertex for vertex.
 *
 * Two rings rather than one only so that no triangle is thirteen kilometres long; the surface is
 * identical either way. It comes to about 17 k vertices for the whole world, is always resident
 * and is never culled, because it is on screen from every viewpoint there is.
 */
function emitSurroundApron(mb, T, reach) {
  const nrm = terrainNormals(T);
  const { nx, nz, cell, x0, z0, h } = T;
  const x1 = x0 + (nx - 1) * cell, z1 = z0 + (nz - 1) * cell;
  const mid = Math.min(800, reach * 0.5);
  const steps = [mid, reach];
  setMat(mb, M.terrain);
  const put = (x, z, k) => {
    const o = k * 3;
    mb.vert(x, h[k], z, nrm[o], nrm[o + 1], nrm[o + 2]);
  };
  // North (outward -Z) and south (+Z): one column of quads per terrain column.
  for (let i = 0; i + 1 < nx; i++) {
    const xa = x0 + i * cell, xb = x0 + (i + 1) * cell;
    let za = z0;
    for (let s = 0; s < steps.length; s++) {
      const zb = z0 - steps[s];
      const ka = i, kb = i + 1;
      put(xa, za, ka); put(xb, za, kb); put(xb, zb, kb);
      put(xa, za, ka); put(xb, zb, kb); put(xa, zb, ka);
      za = zb;
    }
    const r = (nz - 1) * nx;
    let zc = z1;
    for (let s = 0; s < steps.length; s++) {
      const zd = z1 + steps[s];
      const ka = r + i, kb = r + i + 1;
      put(xa, zd, ka); put(xb, zd, kb); put(xb, zc, kb);
      put(xa, zd, ka); put(xb, zc, kb); put(xa, zc, ka);
      zc = zd;
    }
  }
  // West (outward -X) and east (+X).
  for (let j = 0; j + 1 < nz; j++) {
    const za = z0 + j * cell, zb = z0 + (j + 1) * cell;
    let xa = x0;
    for (let s = 0; s < steps.length; s++) {
      const xb = x0 - steps[s];
      const ka = j * nx, kb = (j + 1) * nx;
      put(xb, za, ka); put(xa, za, ka); put(xa, zb, kb);
      put(xb, za, ka); put(xa, zb, kb); put(xb, zb, kb);
      xa = xb;
    }
    let xc = x1;
    for (let s = 0; s < steps.length; s++) {
      const xd = x1 + steps[s];
      const ka = j * nx + nx - 1, kb = (j + 1) * nx + nx - 1;
      put(xc, za, ka); put(xd, za, ka); put(xd, zb, kb);
      put(xc, za, ka); put(xd, zb, kb); put(xc, zb, kb);
      xc = xd;
    }
  }
  // Four corner squares, at the corner vertex's own height and normal.
  const corner = (kx, kz, sx, sz) => {
    const k = kz * nx + kx;
    const ox = kx === 0 ? x0 : x1, oz = kz === 0 ? z0 : z1;
    const ax = ox, az = oz;
    const bx = ox + sx * reach, bz = oz + sz * reach;
    const p = [[ax, az], [bx, az], [bx, bz], [ax, bz]];
    // Wind so the cap faces the sky whichever corner this is.
    const s = (p[1][0] - p[0][0]) * (p[0][1] - p[3][1]) - (p[3][0] - p[0][0]) * (p[0][1] - p[1][1]);
    const o = s >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    put(p[o[0]][0], p[o[0]][1], k); put(p[o[1]][0], p[o[1]][1], k); put(p[o[2]][0], p[o[2]][1], k);
    put(p[o[0]][0], p[o[0]][1], k); put(p[o[2]][0], p[o[2]][1], k); put(p[o[3]][0], p[o[3]][1], k);
  };
  corner(0, 0, -1, -1);
  corner(nx - 1, 0, 1, -1);
  corner(nx - 1, nz - 1, 1, 1);
  corner(0, nz - 1, -1, 1);
}

export {
  emitSurroundStreet, forEachSurroundMass, emitSurroundBlock, emitFringeBank, emitSurroundApron,
};
