// src/city/tileindex.js — which tile owns what.
//
// CONTRACT.md §8.4 and Amendment 11.1. Moved out of city.js unchanged. Nothing here emits a
// vertex. It walks every feature the load prepared — footprints, road records, footways,
// subsurface ways, rails, areas, junctions, surveyed nodes, termini, the surround and the islands
// — and files each one into the tile or tiles that will build it, along with the terrain range,
// the draw box and the per-tile caps that tile will need.
//
// It also cuts the two GLOBAL passes' output up: the harbour and the walkability audit cannot be
// built a tile at a time, so they run once into a capture and captureSplit() hands each tile the
// float run that belongs inside its cell. A tile therefore still emits every vertex exactly once,
// and neighbouring tiles share their edge vertices to the bit.
//
// A way longer than a tile is CUT rather than filed whole: 20,374 of the 20,403 road ways fit
// inside one tile, and leaving the remaining arterials whole would mean standing at one end of
// Lake Shore Boulevard and finding no markings, no kerbs and no lamps because the geometry is
// anchored two kilometres away. The cut lands on a shared vertex and is nudged to the straightest
// one in a short window, so the worst residual turn measured over the whole extract is a fraction
// of a degree; `worstCut` accumulates it and the stats line reports it.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { VERT_FLOATS } from '../core/vertex.js';
import { MITER_OVER } from '../geom/ribbon.js';
import { splitLongWay } from '../data/index.js';
import { islandBounds } from '../world/islands.js';
import { SIDEWALK_W, WATER_Y } from '../world/ground.js';
import { DEPTH_MAX, RAIL_DECK, TRENCH_VERGE, TRENCH_WALL, WAY_PASSAGE } from '../world/grade.js';
import { TRAM_POLE_H } from '../world/rail.js';
import { CUL_R_MIN } from '../world/termini.js';
import { SUR_H_JITTER, SUR_H_MIN, SUR_TALL_MAX } from '../world/surround.js';
import { S_DETAIL, captureSplit, ISLE_TILE_UP, ISLE_TILE_DOWN } from './lod.js';

// Scratch for splitLongWay(). Written and read within one call; never carries state between them.
const _spans = [];

/**
 * File every prepared feature into the tile that will build it.
 *
 * Mutates `grid.tiles[k].f` and the capture; returns nothing. Everything it needs arrives in one
 * object so that the pass has no hidden inputs and can be read top to bottom.
 */
/**
 * Give every tile its empty feature lists.
 *
 * Split out of indexTiles() because the building placement pass now files a record's DRAW BOX on
 * its tile before anything is indexed, and the tile builder appends that tile's prepared records
 * to `f.b` when it runs. Both need the lists to exist from the moment the grid does.
 */
function initTileFeatures(grid) {
  for (let k = 0; k < grid.tiles.length; k++) {
    grid.tiles[k].f = {
      i0: 0, i1: 0, j0: 0, j1: 0,
      b: [], recs: [], foot: [], sub: [], pass: [], corr: [], rails: [],
      areas: [], junc: [], parks: [], plazas: [], cn: false, harbour: null, isle: false,
      // Surveyed OSM nodes whose position falls in this tile.
      pois: [],
      // CONTRACT §9.1 / §9.3: designed termini, and the synthesised fringe.
      caps: [], sroads: [], sblocks: [],
      // Captures delivered after this pass ran — see city/lod.js deliverCapture(). An analysis
      // that finishes behind the first frame still has geometry to hand over.
      late: null,
    };
    grid.tiles[k].built = [false, false, false];   // one flag per stage: massing, detail, signs
  }
}

async function indexTiles(W) {
  const {
    G, HARBOUR, SUR, T, areaParts, cap, cnBaseY, cnX, cnZ, footJobs, grid, groundY,
    junctions, poisRaw, railsRaw, recs, report, roadsRaw, stats, subJobs,
    termCaps, terrainY, worstCut,
  } = W;

  report(0.76, 'indexing tiles');

  // --- terrain cells. Quad (i, j) belongs to the tile holding its centre, so the whole sheet is
  // still emitted exactly once and neighbouring tiles share their edge vertices to the bit.
  {
    const qi = Math.max(1, T.nx - 1), qj = Math.max(1, T.nz - 1);
    const colOf = new Int32Array(qi), rowOf = new Int32Array(qj);
    for (let i = 0; i < qi; i++) colOf[i] = grid.ci(T.x0 + (i + 0.5) * T.cell);
    for (let j = 0; j < qj; j++) rowOf[j] = grid.cj(T.z0 + (j + 0.5) * T.cell);
    const colA = new Int32Array(grid.nx).fill(-1), colB = new Int32Array(grid.nx).fill(-1);
    const rowA = new Int32Array(grid.nz).fill(-1), rowB = new Int32Array(grid.nz).fill(-1);
    for (let i = 0; i < qi; i++) {
      const c = colOf[i];
      if (colA[c] < 0) colA[c] = i;
      colB[c] = i + 1;
    }
    for (let j = 0; j < qj; j++) {
      const c = rowOf[j];
      if (rowA[c] < 0) rowA[c] = j;
      rowB[c] = j + 1;
    }
    for (let tj = 0; tj < grid.nz; tj++) {
      for (let ti = 0; ti < grid.nx; ti++) {
        const t = grid.tiles[tj * grid.nx + ti];
        if (colA[ti] < 0 || rowA[tj] < 0) continue;
        t.f.i0 = colA[ti]; t.f.i1 = colB[ti];
        t.f.j0 = rowA[tj]; t.f.j1 = rowB[tj];
        let y0 = Infinity, y1 = -Infinity;
        for (let j = t.f.j0; j <= t.f.j1 && j < T.nz; j++) {
          for (let i = t.f.i0; i <= t.f.i1 && i < T.nx; i++) {
            const h = T.h[j * T.nx + i];
            if (h < y0) y0 = h;
            if (h > y1) y1 = h;
          }
        }
        // The trenches cut down and the props stand up; give the ground box real headroom.
        grid.cover(t, T.x0 + t.f.i0 * T.cell, T.z0 + t.f.j0 * T.cell,
          T.x0 + t.f.i1 * T.cell, T.z0 + t.f.j1 * T.cell, y0 - DEPTH_MAX - 2, y1 + 14);
      }
    }
  }

  // --- buildings. NOT INDEXED HERE ANY MORE.
  //
  // A record's draw box was filed on its tile by the placement pass (city/prep.js) from the raw
  // ring box, which contains the prepared one; the record itself is appended to `f.b` by the tile
  // builder, which prepares that tile's records the first time it runs. Both are in file order,
  // so a tile holds exactly what a single up-front pass put in it.
  //
  // A BURIED RECORD IS INDEXED LIKE ANY OTHER. Whether a record is wholly inside something taller
  // is a cap verdict, and cap verdicts are resolved when a tile asks for the record rather than
  // before it is filed (city/coplanar.js). Filing one costs nothing — every emitter skips it —
  // and it cannot move a draw box either: a buried record's footprint is inside the record that
  // buries it and its height range is inside that record's too, so the union is unchanged.
  {
    const t = grid.at(cnX, cnZ);
    t.f.cn = true;
    grid.cover(t, cnX - 60, cnZ - 60, cnX + 60, cnZ + 60, cnBaseY - 2, cnBaseY + 560);
  }

  // --- road records. Sidewalk bands, kerb ramps and street furniture all live within a few
  // metres of the carriageway, and a 12 m lamp mast stands above it.
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const t = grid.at(rec.mx, rec.mz);
    t.f.recs.push(rec);
    const pad = rec.hw + (SIDEWALK_W[rec.cls] || 0) + MITER_OVER + 3;
    const gy = groundY(rec.mx, rec.mz);
    grid.cover(t, rec.bbox[0] - pad, rec.bbox[1] - pad, rec.bbox[2] + pad, rec.bbox[3] + pad,
      gy - DEPTH_MAX - 4, gy + (rec.bridge ? 24 : 14));
    if (rec.plaza) {
      for (let p = 0; p < rec.plaza.length; p++) t.f.plazas.push(rec.plaza[p]);
    }
  }

  const spanOf = (pts) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      if (pts[k][0] < x0) x0 = pts[k][0];
      if (pts[k][0] > x1) x1 = pts[k][0];
      if (pts[k][1] < z0) z0 = pts[k][1];
      if (pts[k][1] > z1) z1 = pts[k][1];
    }
    return [x0, z0, x1, z1];
  };
  const indexLine = (list, item, pts, pad, dy0, dy1) => {
    const mid = pts[pts.length >> 1];
    const t = grid.at(mid[0], mid[1]);
    list(t).push(item);
    const bb = spanOf(pts);
    const gy = groundY(mid[0], mid[1]);
    grid.cover(t, bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad, gy + dy0, gy + dy1);
    return t;
  };

  // --- footways, the concourse, building passages, corridors.
  for (let i = 0; i < footJobs.length; i++) {
    const r = roadsRaw[footJobs[i]];
    _spans.length = 0;
    const cut = splitLongWay(grid, r.p, _spans);
    if (cut > worstCut.worst) worstCut.worst = cut;
    for (let s = 0; s < _spans.length; s++) {
      const sub = _spans[s];
      if (sub.length < 2) continue;
      indexLine((t) => t.f.foot, { r, p: sub }, sub, 8, -4, 8);
    }
  }
  for (let i = 0; i < subJobs.length; i++) {
    const gi = subJobs[i];
    const r = roadsRaw[gi];
    indexLine((t) => t.f.sub, { r, gi }, r.p, 12, -DEPTH_MAX - 8, 2);
  }
  for (let i = 0; i < roadsRaw.length; i++) {
    if (G.kind[i] !== WAY_PASSAGE) continue;
    const r = roadsRaw[i];
    if (!Array.isArray(r.p) || r.p.length < 2) continue;
    indexLine((t) => t.f.pass, { r, hw: clamp(isNum(r.w) ? r.w : 6, 1.6, 44) / 2 }, r.p, 10, -6, 10);
  }
  {
    const seen = new Set();
    for (let i = 0; i < roadsRaw.length; i++) {
      const cor = G.corridor[i];
      if (!cor || seen.has(cor)) continue;
      seen.add(cor);
      if (!Array.isArray(cor.pts) || cor.pts.length < 2) continue;
      indexLine((t) => t.f.corr, cor, cor.pts, TRENCH_VERGE + TRENCH_WALL + 6,
        -DEPTH_MAX - 4, 8);
    }
    stats.grade.corridors = seen.size;
  }

  // --- rails and streetcar track, split the same way the roads were.
  for (let i = 0; i < railsRaw.length; i++) {
    const r = railsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2 || r.k === 'subway') continue;
    _spans.length = 0;
    const cut = splitLongWay(grid, r.p, _spans);
    if (cut > worstCut.worst) worstCut.worst = cut;
    for (let s = 0; s < _spans.length; s++) {
      const sub = _spans[s];
      if (sub.length < 2) continue;
      indexLine((t) => t.f.rails, { raw: r, gi: i, p: sub, heavy: r.k === 'rail' }, sub,
        6, -RAIL_DECK - 4, TRAM_POLE_H + 2);
    }
  }

  stats.worstCutDeg = worstCut.worst * 180 / Math.PI;

  // --- area parts and junctions.
  for (let i = 0; i < areaParts.length; i++) {
    const part = areaParts[i];
    const bb = part.bbox;
    const cu = (bb[0] + bb[2]) * 0.5, cv = (bb[1] + bb[3]) * 0.5;
    const t = grid.at(cu, -cv);
    t.f.areas.push(part);
    if (part.kind === 'park') t.f.parks.push(part);
    const gy = groundY(cu, -cv);
    grid.cover(t, bb[0], -bb[3], bb[2], -bb[1], gy - 4, gy + 16);
  }
  for (const J of junctions.values()) {
    const t = grid.at(J.x, J.z);
    t.f.junc.push(J);
    const gy = groundY(J.x, J.z);
    grid.cover(t, J.x - J.r - 4, J.z - J.r - 4, J.x + J.r + 4, J.z + J.r + 4, gy - 2, gy + 10);
  }

  // --- surveyed nodes. The tallest thing any of them becomes is a 12 m utility pole, and a
  // subway entrance reaches 3.6 m up and half a metre down; the draw box is sized for both.
  for (let i = 0; i < poisRaw.length; i++) {
    const q = poisRaw[i];
    const t = grid.at(q.x, q.z);
    t.f.pois.push(q);
    const gy = groundY(q.x, q.z);
    grid.cover(t, q.x - 3, q.z - 3, q.x + 3, q.z + 3, gy - 1, gy + 13);
  }

  // --- designed termini (CONTRACT §9.1) and the synthesised fringe (§9.3). Indexed like any
  // other feature, which is the whole point: the surround is not a special case in the renderer,
  // in the culler, in the eviction policy or in the vertex budget.
  for (let i = 0; i < termCaps.length; i++) {
    const capRec = termCaps[i];
    const t = grid.at(capRec.x, capRec.z);
    t.f.caps.push(capRec);
    const r = capRec.kind === 'cul' ? Math.max(CUL_R_MIN, capRec.w * 0.5 + 2.2) * 2.2 : 6;
    const gy = groundY(capRec.x, capRec.z);
    grid.cover(t, capRec.x - r, capRec.z - r, capRec.x + r, capRec.z + r, gy - 2, gy + 3);
  }
  {
    const surTiles = new Set();
    for (let i = 0; i < SUR.roads.length; i++) {
      const rec = SUR.roads[i];
      _spans.length = 0;
      const cut = splitLongWay(grid, rec.p, _spans);
      if (cut > worstCut.worst) worstCut.worst = cut;
      for (let s = 0; s < _spans.length; s++) {
        const sub = _spans[s];
        if (sub.length < 2) continue;
        const t = indexLine((tt) => tt.f.sroads, { p: sub, w: rec.w, t: rec.t }, sub,
          rec.w * 0.5 + 4, -3, 4);
        surTiles.add(t.id);
      }
    }
    for (let i = 0; i < SUR.blocks.length; i++) {
      const blk = SUR.blocks[i];
      const t = grid.at(blk.mx, blk.mz);
      t.f.sblocks.push(blk);
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, gy = Infinity;
      for (let k = 0; k < blk.co.length; k++) {
        const p = blk.co[k];
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < z0) z0 = p[1];
        if (p[1] > z1) z1 = p[1];
        const y = terrainY(p[0], p[1]);
        if (isNum(y) && y < gy) gy = y;
      }
      if (!isFinite(gy)) gy = 0;
      // Headroom for the tallest mass this block can hash into: the district mean, undecayed,
      // at full positive jitter.
      const top = Math.max(SUR_H_MIN, blk.h) * (1 + SUR_H_JITTER) * SUR_TALL_MAX + 6;
      grid.cover(t, x0, z0, x1, z1, gy - 3, gy + top);
      surTiles.add(t.id);
    }
    stats.surround.tiles = surTiles.size;
  }

  // --- ISLANDS AND AIRPORT. Not indexed feature by feature: harbour.js holds its own spatial
  // model of the island edges, the airfield and the ferry routes, and emits per tile box. Every
  // tile that touches the island rectangle is flagged and given a box big enough for what the
  // island passes put in it — geometry can overhang a tile edge by a beach width or a tree.
  const ISLE_BOX = HARBOUR ? islandBounds(HARBOUR) : null;
  let isleTiles = 0;
  if (ISLE_BOX) {
    for (let k = 0; k < grid.tiles.length; k++) {
      const t = grid.tiles[k];
      if (t.cx1 < ISLE_BOX[0] || t.cx0 > ISLE_BOX[2]) continue;
      if (t.cz1 < ISLE_BOX[1] || t.cz0 > ISLE_BOX[3]) continue;
      t.f.isle = true;
      isleTiles++;
      const gy = Math.max(WATER_Y, groundY(t.mx, t.mz));
      grid.cover(t, t.cx0 - 46, t.cz0 - 46, t.cx1 + 46, t.cz1 + 46,
        WATER_Y - ISLE_TILE_DOWN, gy + ISLE_TILE_UP);
    }
  }
  stats.isleTiles = isleTiles;

  // --- the global captures, cut up by triangle centroid.
  // The quay wall, the pier decks and the boardwalk are structure and belong to the massing
  // stage; the bollards, ladders, lifebuoys, lamps and moored craft are street furniture on the
  // water and belong to detail, exactly like the furniture on a street.
  const tileChunks = new Map();
  captureSplit(grid, cap, { props: S_DETAIL }, tileChunks);
  for (const [id, rec] of tileChunks) {
    grid.tiles[id].f.harbour = rec;
    grid.tiles[id].empty = false;
  }
  {
    let chunkVerts = 0;
    for (const [, rec] of tileChunks) {
      for (let s = 0; s < rec.length; s++) {
        if (!rec[s]) continue;
        for (const c in rec[s]) chunkVerts += rec[s][c].length / VERT_FLOATS;
      }
    }
    stats.chunkVerts = Math.round(chunkVerts);
  }
  grid.seal(-DEPTH_MAX, 60);

}

export { indexTiles, initTileFeatures };
