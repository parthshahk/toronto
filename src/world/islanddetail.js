// src/world/islanddetail.js — what the islands are made of at eye level: the shore cross-sections
// as geometry, the boardwalks, the planting, the beach furniture, the moored boats and the
// Centreville rides.
//
// CONTRACT.md §8.3. Tunables, materials and the shared helpers are in ./waterkit.js; the model
// that says WHERE any of this goes is in ./islands.js and ./islandterrain.js.
//
// Amendment 7: the lighthouse lantern is the only emitter in this file. Sand, grass, hedges,
// boardwalks, boats and ride pads are geometry and albedo only.
//
// Amendment 8.4: nothing is keyed to the bounding box. Every random choice is hashed on world
// position, so a tile of beach looks the same whether or not its neighbours were built, and every
// emitter takes a tile box and emits only what it owns.

import { TAU, clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  appendBeachGrass, appendBench, appendCanopyTree, appendFerryDock, appendFlowerBed,
  appendGableRoof, appendHedgeRun, appendIslandFerry, appendLifeguardChair, appendLighthouse,
  appendLitterBin, appendMooringBollard, appendPicnicTable, appendQuayRailing, appendRidePad,
  appendShrub, appendSlipway, appendTimberBench, appendTimberRail, appendTransitShelter,
  appendWaveRock,
} from '../props/index.js';
import {
  BOARD_LIFT, EPS, M, bboxOf, hash01, planArea, quadOut, quadUp, resample, rngAt, setMat,
} from './waterkit.js';
import { LIGHTHOUSE, LIGHTHOUSE_H } from './islandplan.js';
import {
  EDGE_BEACH, EDGE_RIP, IM, ISLE_GRID, ISLE_REACH, ISLE_SHORE_PROP, ISLE_STATION,
  ISLE_TREE_CELL, ISLE_TREE_MAX, MANTLE_SINK, OPEN_LAKE, SWASH, boxHit, nearSeg, onIsland,
} from './islandkit.js';
import { onAirfield } from './airfield.js';

// Band materials, indexed [kind][band]. Five bands across the mantle: the inland tie, the bank,
// the face above water, the swash, and the submerged toe.
const BAND_MAT = [
  [IM.bank, M.rubble, M.rubble, M.rubbleWet, M.rubbleWet],
  [IM.sandDry, IM.sandDry, IM.sandDry, IM.sandWet, IM.sandWet],
  [IM.bank, M.coping, M.quayFace, M.quayFouled, M.quayFouled],
];

/**
 * The island shore, station by station: 35 km of surveyed line turned into a real edge.
 *
 * Every strip is the same six-knot cross-section (see mantleY) with the material chosen by the
 * station's classification, so a beach can taper into a seawall without leaving a hole where the
 * two meet. Emitted per tile: a strip belongs to the tile holding its midpoint, and because the
 * offsets are mitred off the whole loop, the strip either side of a tile boundary lands on
 * exactly the same two vertices.
 */
export function appendIsleShores(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.terrain;
  const wY = isle.waterY;
  let strips = 0;
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const n = run.n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (run.x[i] + run.x[j]) * 0.5, mz = (run.z[i] + run.z[j]) * 0.5;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      strips++;
      const bwA = run.bw[i], bwB = run.bw[j];
      const fwA = run.fw[i], fwB = run.fw[j];
      const twA = run.tw[i], twB = run.tw[j];
      const tA = [-bwA, run.bk[i], 0, fwA * SWASH, fwA, fwA + twA];
      const tB = [-bwB, run.bk[j], 0, fwB * SWASH, fwB, fwB + twB];
      const yA = [
        run.e[i] - MANTLE_SINK, run.g[i], wY + run.fr[i], wY + 0.10, wY - 0.10, wY - run.td[i],
      ];
      const yB = [
        run.e[j] - MANTLE_SINK, run.g[j], wY + run.fr[j], wY + 0.10, wY - 0.10, wY - run.td[j],
      ];
      const mats = BAND_MAT[run.kind[i]] || BAND_MAT[0];
      for (let b = 0; b < 5; b++) {
        setMat(mb, mats[b]);
        const ax = run.x[i] + run.mx[i] * tA[b], az = run.z[i] + run.mz[i] * tA[b];
        const bx = run.x[i] + run.mx[i] * tA[b + 1], bz = run.z[i] + run.mz[i] * tA[b + 1];
        const cx = run.x[j] + run.mx[j] * tB[b + 1], cz = run.z[j] + run.mz[j] * tB[b + 1];
        const dx = run.x[j] + run.mx[j] * tB[b], dz = run.z[j] + run.mz[j] * tB[b];
        // Outward hint: the band runs out by dt and drops by dy, so its face points up and out
        // in proportion. A flat band gets the +Y bias and comes out horizontal.
        const dt = Math.max(0.02, (tA[b + 1] - tA[b] + tB[b + 1] - tB[b]) * 0.5);
        const dy = (yA[b] - yA[b + 1] + yB[b] - yB[b + 1]) * 0.5;
        quadOut(mb, ax, yA[b], az, bx, yA[b + 1], bz, cx, yB[b + 1], cz, dx, yB[b], dz,
          run.nx[i] * dy, dt + 0.001, run.nz[i] * dy);
      }
      // THE SKIRT. Where the cover ran out of room before the ground came back up — a sand spit
      // the 25 m terrain grid drowned, an eroding bank — the mantle's inland edge stands proud of
      // the ground it meets. A vertical face closes that: an earth bank, which is what is
      // actually there, and never a raw edge you can see under (Amendment 9.2).
      const sA = run.te[i] - 0.45, sB = run.te[j] - 0.45;
      if (yA[0] - sA > 0.06 || yB[0] - sB > 0.06) {
        c.note('bankSkirt');
        setMat(mb, IM.soil);
        const ax = run.x[i] + run.mx[i] * tA[0], az = run.z[i] + run.mz[i] * tA[0];
        const dx = run.x[j] + run.mx[j] * tB[0], dz = run.z[j] + run.mz[j] * tB[0];
        quadOut(mb, ax, Math.min(sA, yA[0]), az, ax, yA[0], az, dx, yB[0], dz,
          dx, Math.min(sB, yB[0]), dz, -run.nx[i], 0, -run.nz[i]);
      }
      // And the same at the toe, where the carved bed falls away under the sand. Underwater, but
      // the mesh has to be closed there or the lake is see-through from below the surface.
      const oA = Math.min(run.to[i], yA[5]), oB = Math.min(run.to[j], yB[5]);
      if (yA[5] - oA > 0.06 || yB[5] - oB > 0.06) {
        c.note('toeSkirt');
        setMat(mb, run.kind[i] === EDGE_BEACH ? IM.sandWet : M.rubbleWet);
        const ax = run.x[i] + run.mx[i] * tA[5], az = run.z[i] + run.mz[i] * tA[5];
        const dx = run.x[j] + run.mx[j] * tB[5], dz = run.z[j] + run.mz[j] * tB[5];
        quadOut(mb, ax, yA[5], az, ax, oA, az, dx, oB, dz, dx, yB[5], dz,
          run.nx[i], 0, run.nz[i]);
      }
    }
  }
  return strips;
}

/**
 * Timber decking over the island paths that run along a beach.
 *
 * Ward's Island's south shore really is a boardwalk, and so is the run behind Centre Island
 * Beach. city.js has already built these as generic footways; this lays real decking one rung
 * above, exactly as the mainland boardwalk does, so the two can never fight. Which paths qualify
 * is decided by the survey — a path within BOARD_NEAR of shore that is classified beach — and
 * not by name, because most of them are not named.
 */
const BOARD_NEAR = 26.0;

export function appendIsleBoardwalks(isle, c, x0, z0, x1, z1) {
  const data = c.data;
  if (!data || !Array.isArray(data.roads)) return 0;
  const mb = c.mb.sidewalks;
  const IB = isle.bbox;
  let metres = 0;
  for (let i = 0; i < data.roads.length; i++) {
    const r = data.roads[i];
    if (!r || r.c !== 'foot' || !Array.isArray(r.p) || r.p.length < 2 || r.tun === 1) continue;
    const bb = bboxOf(r.p);
    if (!boxHit(bb, IB[0], IB[1], IB[2], IB[3])) continue;
    if (!boxHit(bb, x0 - 200, z0 - 200, x1 + 200, z1 + 200)) continue;
    // Beach-side test on the raw way, before the cost of resampling it.
    let beachy = 0, tested = 0;
    for (let k = 0; k < r.p.length; k += Math.max(1, Math.floor(r.p.length / 6))) {
      const hit = nearIsleStation(isle, r.p[k][0], r.p[k][1], BOARD_NEAR);
      tested++;
      if (hit && hit.kind === EDGE_BEACH) beachy++;
    }
    if (!tested || beachy * 2 < tested) continue;
    const pts = resample(r.p, 4.0);
    const hw = clamp(isNum(r.w) ? r.w * 0.5 : 1.5, 1.1, 2.6);
    metres += emitIsleBoard(mb, pts, hw, c.groundY, x0, z0, x1, z1);
  }
  return metres;
}

// The nearest island station within `reach`, or null. Returns the module scratch.
const _isle = { d: 0, run: null, i: 0, kind: 0, t: 0, x: 0, z: 0, nx: 0, nz: 0 };

export function nearIsleStation(isle, x, z, reach) {
  if (!isle || !isle.index || !isNum(x) || !isNum(z)) return null;
  const G = isle.index;
  const ci = Math.floor((x - G.x0) / ISLE_GRID), cj = Math.floor((z - G.z0) / ISLE_GRID);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return null;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return null;
  let best = Infinity, br = null, bi = 0, bt = 0, bx = 0, bz = 0;
  for (let k = 0; k < list.length; k += 2) {
    const run = isle.runs[list[k]], i = list[k + 1], j = (i + 1) % run.n;
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[j] - ax, dz = run.z[j] - az;
    const l2 = dx * dx + dz * dz;
    let f = 0;
    if (l2 > EPS) f = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * f, qz = az + dz * f;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; br = run; bi = f > 0.5 ? j : i; bt = f; bx = qx; bz = qz; }
  }
  if (!br || best > (isNum(reach) ? reach : ISLE_REACH)) return null;
  _isle.d = best; _isle.run = br; _isle.i = bi; _isle.kind = br.kind[bi];
  _isle.x = bx; _isle.z = bz; _isle.nx = br.nx[bi]; _isle.nz = br.nz[bi];
  _isle.t = (x - bx) * br.nx[bi] + (z - bz) * br.nz[bi];
  return _isle;
}

// A boardwalk ribbon, emitting only the segments this tile owns. The normals come from the whole
// polyline, so the two halves of a run cut by a tile boundary meet on the same vertices.
function emitIsleBoard(mb, pts, hw, gy, x0, z0, x1, z1) {
  const n = pts.length;
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    nx[i] = -tz; nz[i] = tx;
  }
  let metres = 0;
  for (let i = 0; i + 1 < n; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) * 0.5, mz = (pts[i][1] + pts[i + 1][1]) * 0.5;
    if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
    metres += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const y0 = gy(pts[i][0], pts[i][1]) + BOARD_LIFT;
    const y1 = gy(pts[i + 1][0], pts[i + 1][1]) + BOARD_LIFT;
    for (let k = 0; k < 5; k++) {
      const oa = -hw + (k / 5) * 2 * hw + 0.035;
      const ob = -hw + ((k + 1) / 5) * 2 * hw - 0.035;
      setMat(mb, IM.boardIsle);
      quadUp(mb,
        pts[i][0] + nx[i] * oa, y0, pts[i][1] + nz[i] * oa,
        pts[i][0] + nx[i] * ob, y0, pts[i][1] + nz[i] * ob,
        pts[i + 1][0] + nx[i + 1] * ob, y1, pts[i + 1][1] + nz[i + 1] * ob,
        pts[i + 1][0] + nx[i + 1] * oa, y1, pts[i + 1][1] + nz[i + 1] * oa);
    }
    setMat(mb, IM.boardIsleEdge);
    for (let s = -1; s <= 1; s += 2) {
      const o = s * hw;
      const ax = pts[i][0] + nx[i] * o, az = pts[i][1] + nz[i] * o;
      const bx = pts[i + 1][0] + nx[i + 1] * o, bz = pts[i + 1][1] + nz[i + 1] * o;
      quadOut(mb, ax, gy(ax, az) + 0.04, az, bx, gy(bx, bz) + 0.04, bz, bx, y1, bz, ax, y0, az,
        nx[i] * s, 0, nz[i] * s);
    }
  }
  return metres;
}


/* -------------------------------------------------------------- the airfield */

/**
 * The greenest place on the map.
 *
 * A world-aligned lattice, hashed on world position, so the same trees stand in the same places
 * whichever tile is built and in whatever order (CONTRACT 8.4). Density comes from how far the
 * point is from the nearest building or paved road: out in the open it is mature parkland, near
 * the cottages it is gardens and hedges, and right against them nothing, because that is the
 * street pass's business.
 */
export function placeIslandGreen(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const cell = ISLE_TREE_CELL;
  const u0 = Math.ceil(x0 / cell) * cell, v0 = Math.ceil(z0 / cell) * cell;
  let placed = 0;
  for (let v = v0; v < z1 && placed < ISLE_TREE_MAX; v += cell) {
    for (let u = u0; u < x1 && placed < ISLE_TREE_MAX; u += cell) {
      const h1 = hash01(u, v), h2 = hash01(v, u), h3 = hash01(u + 17.3, v - 41.7);
      const x = u + (h1 - 0.5) * cell * 0.82, z = v + (h2 - 0.5) * cell * 0.82;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      if (!onIsland(isle, x, z)) continue;
      if (onAirfield(isle, x, z)) continue;
      // Never on the shore mantle: the beach is sand and the riprap is rock.
      const near = nearIsleStation(isle, x, z, ISLE_REACH);
      if (near && near.t > -near.run.bw[near.i] * 0.55) continue;
      const hs = nearSeg(isle.hard, x, z);
      const d = hs ? hs.d : 999;
      if (d < 7.0) continue;
      // Open parkland, not a plantation: the islands have big mown lawns — the Avenue of the
      // Islands, the sports fields, the picnic ground — and a canopy at every lattice point
      // would bury them. Nearer the cottages the lattice turns into gardens instead.
      const dense = d > 25 ? 0.70 : 0.34;
      if (h3 > dense) continue;
      if (d > 25) {
        const y = c.reserve('islandTree', x, z, 2.4, 1.6, 9.0);
        if (!isNum(y)) continue;
        const sp = h1 < 0.14 ? 2 : (h2 < 0.24 ? 1 : 0);
        appendCanopyTree(mb, rngAt(x, z), x, y + 0.05, z, 0.85 + h3 * 0.85, sp);
        placed++;
      } else if (h1 < 0.42) {
        const y = c.reserve('islandHedge', x, z, 1.5, 1.2, 2.0);
        if (!isNum(y)) continue;
        appendHedgeRun(mb, rngAt(x, z), x, y + 0.03, z, h2 * TAU, 3.5 + h3 * 5.0,
          1.0 + h1 * 0.6, 0.7 + h2 * 0.4);
        placed++;
      } else if (h1 < 0.62) {
        const y = c.reserve('islandBed', x, z, 1.6, 1.2, 0.6);
        if (!isNum(y)) continue;
        appendFlowerBed(mb, rngAt(x, z), x, y + 0.02, z, h2 * TAU, 2.2 + h3 * 2.6,
          1.6 + h1 * 1.6);
        placed++;
      } else {
        const y = c.reserve('islandShrub', x, z, 1.1, 1.0, 1.6);
        if (!isNum(y)) continue;
        appendShrub(mb, rngAt(x, z), x, y + 0.03, z, 0.9 + h3 * 0.7);
        placed++;
      }
    }
  }
  return placed;
}

/**
 * What stands on the shore itself: marram on the back of the beaches, driftwood and armour stone
 * on the riprap, picnic tables and benches behind the berm, a lifeguard chair where a beach is
 * long enough to need one, and a timber rail wherever the bank drops to a seawall.
 */
export function placeShoreProps(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const wY = isle.waterY;
  let n = 0;
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const step = Math.max(1, Math.round(ISLE_SHORE_PROP / ISLE_STATION));
    for (let i = 0; i < run.n; i += step) {
      const x = run.x[i], z = run.z[i];
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      const nx = run.nx[i], nz = run.nz[i];
      const k = run.kind[i];
      const h1 = hash01(x, z), h2 = hash01(z, x);
      if (k === EDGE_BEACH) {
        // Marram on the backshore, in the band the tide never reaches.
        for (let t = 0; t < 3; t++) {
          const o = -run.bw[i] * (0.55 + 0.30 * hash01(x + t * 3.7, z - t * 5.1));
          const px = x + nx * o + nz * (hash01(x + t, z) - 0.5) * 7.0;
          const pz = z + nz * o - nx * (hash01(z, x + t) - 0.5) * 7.0;
          const y = c.groundY(px, pz);
          if (!isNum(y) || y < wY + 0.15) continue;
          appendBeachGrass(mb, rngAt(px, pz), px, y, pz, 0.8 + hash01(pz, px) * 0.8);
          c.note('beachGrass');
          n++;
        }
        if (h1 < 0.30) {
          const o = -run.bw[i] * 1.25;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('picnicTable', px, pz, 1.6, 1.2, 0.9);
          if (isNum(y)) {
            appendPicnicTable(mb, rngAt(px, pz), px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        } else if (h1 < 0.42) {
          const o = -run.bw[i] * 1.1;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('timberBench', px, pz, 1.3, 1.2, 0.9);
          if (isNum(y)) {
            appendTimberBench(mb, rngAt(px, pz), px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        } else if (h1 < 0.47 && run.open[i] >= OPEN_LAKE) {
          const o = -run.bw[i] * 0.30;
          const px = x + nx * o, pz = z + nz * o;
          const y = c.reserve('lifeguardChair', px, pz, 1.5, 1.4, 2.6);
          if (isNum(y)) {
            appendLifeguardChair(mb, px, y + 0.02, pz, Math.atan2(-nz, nx));
            n++;
          }
        }
      } else if (k === EDGE_RIP) {
        // Armour stone along the toe, half in the water, exactly as it is placed for real.
        for (let t = 0; t < 2; t++) {
          const o = run.fw[i] * (0.55 + 0.45 * hash01(x - t * 2.3, z + t * 6.1));
          const px = x + nx * o + nz * (hash01(x + t * 5, z) - 0.5) * 6.0;
          const pz = z + nz * o - nx * (hash01(z + t * 5, x) - 0.5) * 6.0;
          appendWaveRock(mb, rngAt(px, pz), px, wY - 0.15, pz, 0.7 + hash01(px, pz) * 1.1);
          c.note('armourStone');
          n++;
        }
      } else if (h2 < 0.55) {
        // A seawall on the islands is a low edge people sit on and fish off: rail it, and put a
        // mooring bollard on the stretches a boat could come alongside.
        const y = run.g[i];
        const px = x - nx * 0.55, pz = z - nz * 0.55;
        if (c.claim(px, pz, 1.2)) {
          appendQuayRailing(mb, px, y, pz, Math.atan2(-nz, nx), 5.4);
          c.note('quayRailing');
          n++;
        }
      }
    }
  }
  return n;
}


/* --------------------------------------------------------- airfield detail */

export function placeIslandMarine(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  const wY = isle.waterY;
  let n = 0;
  for (let i = 0; i < isle.docks.length; i++) {
    const d = isle.docks[i];
    if (d.x < x0 || d.x >= x1 || d.z < z0 || d.z >= z1) continue;
    const g = d.run.g[d.at];
    const yaw = Math.atan2(-d.nz, d.nx);
    // The dock deck sits just off the edge, out over the water, at the bank level it serves.
    const px = d.x + d.nx * 5.0, pz = d.z + d.nz * 5.0;
    appendFerryDock(mb, px, Math.max(wY + 0.9, g), pz, yaw, 9.0, 22.0);
    c.note('ferryDock');
    n++;
    if (hash01(d.x, d.z) < 0.5) {
      const bx = d.x + d.nx * 24.0, bz = d.z + d.nz * 24.0;
      appendIslandFerry(mb, rngAt(bx, bz), bx, wY, bz, yaw + Math.PI * 0.5, 42.0);
      c.note('islandFerry');
      n++;
    }
    if (c.claim(d.x - d.nx * 2.2, d.z - d.nz * 2.2, 1.0)) {
      appendMooringBollard(mb, d.x - d.nx * 2.2, g, d.z - d.nz * 2.2, yaw);
      c.note('mooringBollard');
      n++;
    }
    // Somewhere to wait for the boat. Set back on the land side, off the dock itself.
    const sx = d.x - d.nx * 9.0, sz = d.z - d.nz * 9.0;
    const sy = c.reserve('ferryShelter', sx, sz, 3.0, -1, 2.9);
    if (isNum(sy)) {
      appendTransitShelter(mb, sx, sy + 0.02, sz, yaw, 5.6);
      n++;
    }
  }

  // Handrails along the island bridges. city.js builds the deck, the fascia and the abutments;
  // a lagoon crossing with nothing at the edge is the one thing that still reads as unfinished.
  for (let b = 0; b < isle.bridges.length; b++) {
    const br = isle.bridges[b];
    const hw = clamp(br.w * 0.5, 1.2, 6.0) + 0.25;
    const pts = resample(br.p, 5.0);
    for (let i = 0; i + 1 < pts.length; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) * 0.5, mz = (pts[i][1] + pts[i + 1][1]) * 0.5;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      let tx = pts[i + 1][0] - pts[i][0], tz = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(tx, tz);
      if (!(l > EPS)) continue;
      tx /= l; tz /= l;
      const y = c.groundY(mx, mz);
      if (!isNum(y)) continue;
      for (let sd = -1; sd <= 1; sd += 2) {
        appendTimberRail(mb, mx - tz * hw * sd, y + 0.02, mz + tx * hw * sd,
          Math.atan2(tx, tz), l);
        c.note('bridgeRail');
        n++;
      }
    }
  }
  return n;
}

/* ------------------------------------------------------------- Centreville */

export function placeCentreville(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  let n = 0;
  for (let i = 0; i < isle.rides.length; i++) {
    const R = isle.rides[i];
    if (R.cx < x0 || R.cx >= x1 || R.cz < z0 || R.cz >= z1) continue;
    // The massing extract models most of the rides as blocks. Where it does, that IS the ride and
    // a second structure on the same spot would be a duplicate; only the ones it missed are
    // built, and every one of them gets its fence, its bedding and its bins either way.
    const yaw = hash01(R.cx, R.cz) * TAU;
    let clear = !c.inFootprint(R.cx, R.cz, 2.0);
    for (let k = 0; k < 4 && clear; k++) {
      const sx = (k & 1) ? 1 : -1, sz = (k & 2) ? 1 : -1;
      if (c.inFootprint(R.cx + sx * R.w * 0.42, R.cz + sz * R.d * 0.42, 1.0)) clear = false;
    }
    if (clear) {
      const y = c.reserve('ridePad', R.cx, R.cz, Math.min(R.w, R.d) * 0.4, -1, 4.0);
      if (isNum(y)) {
        const kind = R.type === 'log_flume' ? 2 : (R.type === 'car_ride' ? 1 : 0);
        appendRidePad(mb, rngAt(R.cx, R.cz), R.cx, y + 0.02, R.cz, yaw, R.w, R.d, kind);
        n++;
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = hash01(R.cx + k * 7.7, R.cz - k * 3.3) * TAU;
      const rad = Math.max(R.w, R.d) * 0.5 + 3.5 + hash01(R.cz + k, R.cx) * 5.0;
      const px = R.cx + Math.cos(a) * rad, pz = R.cz + Math.sin(a) * rad;
      const u = hash01(px, pz);
      if (u < 0.34) {
        const y = c.reserve('islandBed', px, pz, 1.5, 1.0, 0.6);
        if (isNum(y)) { appendFlowerBed(mb, rngAt(px, pz), px, y + 0.02, pz, a, 2.6, 1.8); n++; }
      } else if (u < 0.62) {
        const y = c.reserve('bench', px, pz, 1.2, 1.0, 0.9);
        if (isNum(y)) { appendBench(mb, px, y + 0.02, pz, a); n++; }
      } else if (u < 0.80) {
        const y = c.reserve('litterBin', px, pz, 0.7, 1.0, 1.1);
        if (isNum(y)) { appendLitterBin(mb, px, y + 0.02, pz, a); n++; }
      } else {
        const y = c.reserve('timberRail', px, pz, 1.0, 1.0, 1.1);
        if (isNum(y)) { appendTimberRail(mb, px, y + 0.02, pz, a, 5.0); n++; }
      }
    }
  }
  return n;
}

/**
 * Gibraltar Point. Placed FIRST, before anything scatters: it is one building in three square
 * kilometres of parkland and a canopy tree must never be the reason it is missing — the same
 * rule city.js uses for the rare things it chooses city-wide before the tiles run.
 */
export function placeLighthouse(isle, c, x0, z0, x1, z1) {
  const lx = LIGHTHOUSE[0], lz = LIGHTHOUSE[1];
  if (lx < x0 || lx >= x1 || lz < z0 || lz >= z1) return 0;
  const y = c.reserve('lighthouse', lx, lz, 4.2, -1, LIGHTHOUSE_H + 6);
  if (!isNum(y)) return 0;
  appendLighthouse(c.mb.props, lx, y, lz, LIGHTHOUSE_H);
  // A keeper's path of clipped hedge either side, so it does not stand in bare grass.
  for (let k = 0; k < 2; k++) {
    const px = lx + (k ? 7.5 : -7.5), pz = lz + 4.0;
    const hy = c.reserve('islandHedge', px, pz, 1.4, -1, 1.6);
    if (isNum(hy)) appendHedgeRun(c.mb.props, rngAt(px, pz), px, hy + 0.03, pz, 0, 7.0, 1.1, 0.8);
  }
  return 1;
}


/* --------------------------------------------------- cottages and slipways */

/**
 * Pitched roofs on the island cottages.
 *
 * The massing extract has no roof pitch, and every house on Ward's and Algonquin is pitched;
 * without this the community is two hundred flat-topped boxes. The ridge follows the footprint's
 * long axis, which is what a builder would do on a lot that narrow.
 */
export function placeIslandRoofs(isle, c, x0, z0, x1, z1) {
  const mb = c.mb.buildings;
  let n = 0;
  for (let i = 0; i < c.buildings.length; i++) {
    const b = c.buildings[i];
    if (!b || !Array.isArray(b.rings) || !b.rings.length) continue;
    // A record that is wholly inside something taller is never extruded, so a pitched roof on it
    // would be a gable floating inside a neighbour's walls. The tile hands over every record it
    // holds now, buried or not — city/coplanar.js settles that verdict when the tile is built
    // rather than before the tile index exists — so the filter belongs here.
    if (b.buried) continue;
    const cx = b.cx, cz = b.cz;
    if (!isNum(cx) || cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
    if (!isNum(b.h) || b.h > 12 || b.h < 2) continue;
    const ring = b.rings[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const area = Math.abs(planArea(ring));
    if (area < 25 || area > 420) continue;
    if (!onIsland(isle, cx, cz) || onAirfield(isle, cx, cz)) continue;
    // Longest edge sets the ridge direction; the extents across it set the roof rectangle.
    let bl = 0, dx = 1, dz = 0;
    for (let k = 1; k < ring.length; k++) {
      const ex = ring[k][0] - ring[k - 1][0], ez = ring[k][1] - ring[k - 1][1];
      const l = ex * ex + ez * ez;
      if (l > bl) { bl = l; dx = ex; dz = ez; }
    }
    const dl = Math.hypot(dx, dz);
    if (!(dl > EPS)) continue;
    dx /= dl; dz /= dl;
    let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const px = ring[k][0] - cx, pz = ring[k][1] - cz;
      const a = px * dx + pz * dz;
      const t = -px * dz + pz * dx;
      if (a < lo0) lo0 = a;
      if (a > hi0) hi0 = a;
      if (t < lo1) lo1 = t;
      if (t > hi1) hi1 = t;
    }
    const along = hi0 - lo0, across = hi1 - lo1;
    if (!(along > 1.5) || !(across > 1.5)) continue;
    const mx = cx + dx * (lo0 + hi0) * 0.5 - dz * (lo1 + hi1) * 0.5;
    const mz = cz + dz * (lo0 + hi0) * 0.5 + dx * (lo1 + hi1) * 0.5;
    const pitch = clamp(across * 0.30, 1.1, 3.2);
    appendGableRoof(mb, rngAt(mx, mz), mx, b.y + b.h, mz, Math.atan2(dx, dz),
      across, along, pitch);
    c.note('islandRoof');
    n++;
  }
  return n;
}

// A concrete ramp at each island yacht club, where the marina basin meets the bank. The clubs are
// surveyed as basins with no landing of any kind, and a marina you cannot get a boat into is a
// hole in the story.
export function placeIslandSlipways(H, isle, c, x0, z0, x1, z1) {
  const mb = c.mb.props;
  let n = 0;
  for (let m = 0; m < H.marinas.length; m++) {
    const rec = H.marinas[m];
    const hit = nearIsleStation(isle, rec.cen[0], rec.cen[1], 200);
    if (!hit) continue;
    const x = hit.x, z = hit.z;
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    if (!c.claim(x, z, 6.0)) continue;
    const run = hit.run, i = hit.i;
    appendSlipway(mb, x - run.nx[i] * 2.0, run.g[i], z - run.nz[i] * 2.0,
      Math.atan2(-run.nz[i], run.nx[i]), 7.0, 14.0, run.g[i] - (isle.waterY - 1.1));
    c.note('slipway');
    n++;
  }
  return n;
}
