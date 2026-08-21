// src/world/water.js — THE HARBOURFRONT MODEL: buildHarbour(), carveHarbourTerrain(), and the
// public queries city.js asks of the water.
//
//
// Why this module exists
// ----------------------
// The shoreline used to be GUESSED: city.js distance-transformed the road network and called
// everything far from mapped infrastructure "lake", which put the water's edge within about
// +/-25 m of the truth and produced a beach — a soft interpolated slope running down into the
// water. Toronto's harbourfront is not a beach. It is a continuous engineered edge: a vertical
// quay wall standing on the lake bed, a coping stone, and paving right up to it. The wall IS the
// land/water boundary. data/toronto.json now carries that boundary as survey:
//
//   shore[]       ways clipped from the OSM Lake Ontario multipolygon, {role: outer|inner, p}
//   waterfront[]  engineered edges, {k, n, p} with k in
//                 pier | quay | breakwater | groyne | retaining_wall | marina | ferry_terminal
//
// The terrain grid cannot represent a vertical wall
// ------------------------------------------------
// The terrain is a 25 m grid. Between a land vertex and a water vertex it interpolates linearly,
// so the height crosses the lake datum somewhere inside that cell — and wherever that crossing
// falls, it is NOT where the surveyed shoreline runs. Two artifacts follow: water showing inland
// of the wall ("flooding") and terrain poking through the lake surface outside it ("shelf").
//
// Neither artifact can be removed by moving grid heights around alone, so the fix is split:
//
//   1. The LAND SIDE IS NOT TOUCHED. An earlier version graded it down towards the water so the
//      grid's datum crossing would land on the surveyed line; it did, but a dug vertex drags the
//      interpolation with it for a full cell in every direction, which put a 20 m trench along
//      6 km of waterfront and made the apron that had to cover it 34 m wide almost everywhere.
//      The surveyed ground is the ground.
//   2. The LAKE BED is carved steeply and deep (SHORE_SLOPE, LAKE_DEPTH). Between a land vertex
//      at hl and a water vertex at -hw the crossing sits hl/(hl+hw) of the way across the cell,
//      so a deep bed pulls it hard toward the land vertex and the terrain can stand proud of the
//      lake by at most about cell*hl/(hl+LAKE_DEPTH) — a couple of metres, measured, not assumed.
//   3. The QUAY WALL covers what is left on the water side: its face is pushed out per station to
//      exactly where the grid last stands above the lake (WALL_PROUD..WALL_PROUD_MAX).
//   4. The QUAY APRON covers what is left on the land side: a real slab from the wall face inland
//      to exactly where the ground comes back up to quay level, ending in a bevel that crosses
//      the terrain at an angle instead of lying coplanar with it. Nothing is feathered.
//
// Verified by area sampling rather than by eye: 190,290 uniform samples inside the surveyed lake
// leave 1 above the lake plane and not inside the quay (0.0005%, worst 0.03 m), 58,543 samples on
// the land side within 70 m of the wall leave 0 showing water, and the apron hands back to the
// ground with a median step of 0.001 m and a worst of 0.30 m against a 0.45 m limit.
//
// So that a pedestrian walks on the quay rather than on the ground under it, carveHarbourTerrain()
// also WRAPS T.groundY with the deck field (quay apron, pier decks, and any walkway carried over
// the water). Every consumer in city.js — road ribbons, footways, prop seating, the player's feet
// — then agrees with what is drawn. The apron itself is laid at exactly ground level, the bottom
// rung of city.js's ground ladder, so the park, grass, path and plaza covers the survey puts on
// the waterfront all still draw over it and the promenade paving shows only where they do not.
//
// Public API
// ----------
//   buildHarbour(data, opts) -> H
//       opts: { extent, terrain, waterY }. Reads shore[] and waterfront[], chains the ways,
//       builds the water field and the shoreline stations. Pure: touches nothing.
//   carveHarbourTerrain(T, H) -> stats
//       Mutates T.h (the lake bed), drops T.ponds records that fall inside the surveyed lake,
//       sizes the quay wall and apron, decks the walkways that cross open water, and wraps
//       T.groundY with the deck field. Must be called BEFORE city.js reads T.groundY or emits
//       the terrain mesh.
//   harbourWaterAt(H, x, z) -> boolean          surveyed lake coverage, exact
//   harbourTileHasWater(H, x0, z0, x1, z1)      does an axis-aligned tile touch the lake
//   harbourDeckY(H, x, z) -> number             quay/pier deck ground level, -Infinity off deck
//   appendHarbour(H, ctx)                       all harbour geometry and furniture
//       ctx: { mb, data, claim(x, z, r) -> bool, note(kind) }
//   harbourStats(H) -> object                   permanent counters for the console audit
//
// Amendment 7 (time-of-day independence): geometry and material only. Water is not emissive, the
// quay is not emissive, no surface here is pre-darkened or pre-lit. The only emitters are the
// navigation lights and the lifebuoy-station lamps in props/, which are real light sources.
//
// Amendment 8.4 (scaling): nothing is keyed to this bounding box. Extents come from meta, every
// index is a uniform grid, every pass is linear in feature count, and every random choice is
// hashed on WORLD POSITION so a tile looks the same whether or not its neighbours were loaded.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  APRON_MAX, APRON_MIN, APRON_STEP, APRON_Y, BEVEL, BEVEL_DROP, DECK_MAX, DECK_MIN, DECK_SAMPLE,
  EDGE_DROP_MAX, EPS, FINGER_MAX_LEN, GRID_CELL, GRID_REACH, LAKE_DEPTH, PIER_LIFT, PIER_W,
  SHORE_SLOPE, WALL_PROUD, WALL_PROUD_MAX, bboxOf, centroidOf, isClosed, planArea, polyLength,
  resample, sampleTerrain,
} from './waterkit.js';
import { ISLE_REACH } from './islandkit.js';
import {
  buildRuns, chainWays, deckPolyAt, findBasins, makeDeckIndex, makeShoreIndex, makeWaterField,
  nearestShore, waterAt,
} from './shoreline.js';
import { carveIslands, islandGroundY } from './islandterrain.js';
import { nearIsleStation } from './islanddetail.js';
import { buildIslands } from './islands.js';

/**
 * Read the surveyed harbourfront out of the extract. Pure — no geometry, no mutation.
 *
 * @param {object} data  parsed data/toronto.json
 * @param {object} opts  { extent: {x, z}, terrain: T, waterY: number }
 * @returns {object|null} the harbour model, or null when the extract carries no shoreline
 */
export function buildHarbour(data, opts) {
  const o = opts || {};
  const extent = o.extent || { x: 1000, z: 1000 };
  const T = o.terrain;
  const waterY = isNum(o.waterY) ? o.waterY : 0;
  const shore = Array.isArray(data && data.shore) ? data.shore : [];
  const front = Array.isArray(data && data.waterfront) ? data.waterfront : [];
  if (!shore.length || !T) return null;

  // The quay is built only where there is ground to build it on: the terrain grid covers exactly
  // the extent, so the runs are clipped to it plus a short margin that lets the wall reach the
  // edge of the mapped world instead of stopping short of it. The water field itself is NOT
  // clipped — the parity test needs the whole chain, which runs far past the extract.
  const hx = extent.x / 2, hz = extent.z / 2;
  const margin = 30;
  const rect = [-hx - margin, -hz - margin, hx + margin, hz + margin];

  const outer = chainWays(shore.filter((s) => s && s.role !== 'inner'));
  const inner = chainWays(shore.filter((s) => s && s.role === 'inner'));
  const basins = findBasins(data, makeWaterField(outer, inner, null), outer, rect);
  const field = makeWaterField(outer, inner, basins);
  const runs = buildRuns(outer.concat(basins), rect, field);

  const H = {
    rect, extent, waterY, field, runs,
    index: makeShoreIndex(runs, rect),
    terrain: T,
    roads: Array.isArray(data && data.roads) ? data.roads : [],
    crossings: [],
    decks: null,
    piers: [], fingers: [], mounds: [], marinas: [], walls: [], terminals: [],
    stats: {
      shoreMetres: 0, runs: runs.length, quayStations: 0, apronMinW: Infinity, apronMaxW: 0,
      piers: 0, fingers: 0, mounds: 0, marinas: 0, walls: 0, terminals: 0,
      basins: basins.length, inlandWallsSkipped: 0, folds: 0,
      lakeCells: 0, pondsDropped: 0, crossings: 0,
    },
  };
  for (let r = 0; r < runs.length; r++) {
    H.stats.quayStations += runs[r].n;
    H.stats.shoreMetres += runs[r].s[runs[r].n - 1];
  }

  // Quay ground level per station, read off the SURVEYED terrain a little inland (over the water
  // the terrain is meaningless — it was interpolated from building elevations that do not exist
  // out there), then smoothed along the run so the coping is a line and not a staircase.
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    for (let i = 0; i < run.n; i++) {
      const px = run.x[i] - run.nx[i] * DECK_SAMPLE, pz = run.z[i] - run.nz[i] * DECK_SAMPLE;
      run.g[i] = clamp(sampleTerrain(T, px, pz), waterY + DECK_MIN, waterY + DECK_MAX);
    }
    smoothRun(run.g, run.n, 3, 2);
  }

  // Engineered structures. Anything the extract tags as a waterfront edge but that sits well
  // inland is somebody else's wall — the rail corridor and the expressway are full of them — and
  // is left alone rather than dressed up as a quay.
  for (let i = 0; i < front.length; i++) {
    const w = front[i];
    if (!w || !Array.isArray(w.p) || w.p.length < 2) continue;
    const bb = bboxOf(w.p);
    if (bb[2] < rect[0] || bb[0] > rect[2] || bb[3] < rect[1] || bb[1] > rect[3]) continue;
    const closed = isClosed(w.p);
    const len = polyLength(w.p);
    const area = closed ? Math.abs(planArea(w.p)) : 0;
    const cen = centroidOf(w.p);
    const rec = { k: w.k, n: w.n || '', p: w.p, closed, len, area, bbox: bb, cen };
    if (w.k === 'pier') {
      if (!closed && len <= FINGER_MAX_LEN) H.fingers.push(rec);
      else H.piers.push(rec);
    } else if (w.k === 'breakwater' || w.k === 'groyne') {
      H.mounds.push(rec);
    } else if (w.k === 'marina') {
      H.marinas.push(rec);
    } else if (w.k === 'ferry_terminal') {
      H.terminals.push(rec);
    } else if (w.k === 'quay' || w.k === 'retaining_wall') {
      // Waterside only: within a stone's throw of the surveyed lake.
      let near = false;
      for (let k = 0; k < w.p.length && !near; k++) {
        const h = nearestShore(H, w.p[k][0], w.p[k][1]);
        if (h && h.d < 26) near = true;
        if (waterAt(field, w.p[k][0], w.p[k][1])) near = true;
      }
      if (near) H.walls.push(rec); else H.stats.inlandWallsSkipped++;
    }
  }

  // The ferry terminal. The extract tags the island-side dock; the city-side slips at the foot of
  // Bay Street are named on the ROADS that serve them, so the anchor is taken from there and
  // pinned to the surveyed shoreline. Both routes end in the same builder.
  const anchors = [];
  const roads = Array.isArray(data && data.roads) ? data.roads : [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || typeof r.n !== 'string' || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (!/ferry\s*dock|ferry\s*terminal/i.test(r.n)) continue;
    const c = centroidOf(r.p);
    if (c[0] < rect[0] || c[0] > rect[2] || c[1] < rect[1] || c[1] > rect[3]) continue;
    anchors.push(c);
  }
  if (anchors.length) {
    let cx = 0, cz = 0;
    for (let i = 0; i < anchors.length; i++) { cx += anchors[i][0]; cz += anchors[i][1]; }
    cx /= anchors.length; cz /= anchors.length;
    // Walk south (the lake side) until the shoreline is within reach, so the terminal lands on
    // the quay rather than at the road's own centroid.
    let found = null;
    for (let t = 0; t <= 320 && !found; t += 8) {
      const h = nearestShore(H, cx, cz + t);
      if (h && h.d < GRID_REACH * 0.9) found = { x: h.qx, z: h.qz, run: h.run, i: h.i, t: h.t };
    }
    if (found) H.terminals.push({ k: 'ferry_terminal', n: 'Ferry Terminal', anchor: found, p: null });
  }

  // THE ISLANDS. Everything south of the harbour: the surveyed island rings, their edge
  // treatment, Billy Bishop and the ferry routes. Pure, like the rest of buildHarbour.
  H.isle = buildIslands(H, data, inner);
  H.stats.isle = H.isle.stats;

  H.stats.piers = H.piers.length;
  H.stats.fingers = H.fingers.length;
  H.stats.mounds = H.mounds.length;
  H.stats.marinas = H.marinas.length;
  H.stats.walls = H.walls.length;
  H.stats.terminals = H.terminals.length;
  return H;
}

function smoothRun(a, n, half, passes) {
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let acc = 0, w = 0;
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        acc += a[j]; w++;
      }
      tmp[i] = w > 0 ? acc / w : a[i];
    }
    a.set(tmp);
  }
}

/**
 * Bring the terrain down to the surveyed water, size the quay apron, and wrap groundY with the
 * deck field. Mutates T. Call once, immediately after makeTerrain() and before anything reads
 * T.groundY or emits the terrain mesh.
 */
export function carveHarbourTerrain(T, H) {
  if (!H || !T) return null;
  const { nx, nz, cell, x0, z0, h } = T;
  const waterY = H.waterY;
  const S = H.stats;

  // --- 1. the lake bed, and NOTHING on the land side --------------------------------------------
  // Which side a vertex is on is decided by the surveyed polygon, never by a local normal: at a
  // slip mouth the nearest segment can face the wrong way. Land vertices are left exactly as
  // surveyed — an earlier version graded them down towards the water, which is what a beach does
  // and what an engineered quay never does, and it dragged a trench a full grid cell inland
  // because the grid interpolates linearly out of every vertex it touches. The lake bed alone is
  // carved, steeply, which pins the grid's datum crossing to within a couple of metres of the
  // surveyed line; the quay wall covers what is left.
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const k = j * nx + i;
      if (!waterAt(H.field, x, z)) continue;
      const hit = nearestShore(H, x, z);
      let d = hit ? hit.d : LAKE_DEPTH / SHORE_SLOPE;
      // THE ISLANDS: an island shore is a shore. Without this the bed beside Ward's Island is
      // carved from its distance to the MAINLAND, comes out at the full LAKE_DEPTH, and the
      // grid's datum crossing lands metres inside the surveyed island.
      const isl = nearIsleStation(H.isle, x, z, ISLE_REACH);
      if (isl && isl.d < d) d = isl.d;
      h[k] = waterY - clamp(d * SHORE_SLOPE, 0.12, LAKE_DEPTH);
      S.lakeCells++;
    }
  }

  // --- 2. inland ponds that fall inside the surveyed lake are not ponds ------------------------
  if (Array.isArray(T.ponds) && T.ponds.length) {
    const keep = [];
    for (let p = 0; p < T.ponds.length; p++) {
      const co = T.ponds[p].co;
      let cx = 0, cv = 0, n = 0;
      for (let i = 0; i + 1 < co.length; i += 2) { cx += co[i]; cv += co[i + 1]; n++; }
      if (n && waterAt(H.field, cx / n, -(cv / n))) { S.pondsDropped++; continue; }
      keep.push(T.ponds[p]);
    }
    T.ponds = keep;
  }

  // --- 3. apron width: out to exactly where the ground comes back up to quay level -------------
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i < run.n; i++) {
      const g = run.g[i];
      // Seaward first: how far out does the grid still stand above the lake? That much of the
      // lake has to be inside the wall, so the wall face goes there.
      let pr = WALL_PROUD;
      for (let t = WALL_PROUD; t <= WALL_PROUD_MAX; t += 0.25) {
        const px = run.x[i] + run.nx[i] * t, pz = run.z[i] + run.nz[i] * t;
        // Stop at the far shore: across a slip or a narrow channel the ray runs back onto land,
        // and that land is the other quay's business, not an excuse to widen this wall.
        if (!waterAt(H.field, px, pz)) break;
        if (sampleTerrain(T, px, pz) > waterY - 0.05) pr = t + 0.35;
      }
      run.pr[i] = clamp(pr, WALL_PROUD, WALL_PROUD_MAX);
      // Then inland: the apron runs to exactly where the ground comes back up to quay level, or
      // to the middle of the strip when the far side is another water body — a slip, a basin, or
      // the far side of a breakwater. In that case it stops FLAT rather than ramping down, since
      // what it meets there is the other side's apron and not ground.
      let w = APRON_MAX;
      let met = false;
      for (let t = APRON_MIN; t <= APRON_MAX; t += APRON_STEP) {
        const px = run.x[i] - run.nx[i] * t, pz = run.z[i] - run.nz[i] * t;
        if (waterAt(H.field, px, pz)) { w = Math.max(APRON_MIN, t * 0.5); met = true; break; }
        if (sampleTerrain(T, px, pz) >= g - 0.04) { w = t; break; }
      }
      run.w[i] = clamp(w, APRON_MIN, APRON_MAX);
      run.met[i] = met ? 1 : 0;
    }
    dilateRun(run.pr, run.n, 2);
    smoothRun(run.pr, run.n, 1, 1);
    // Dilate before smoothing: a station may never end up NARROWER than its neighbours need,
    // because that is exactly where a hole would open between the apron and the ground.
    dilateRun(run.w, run.n, 2);
    smoothRun(run.w, run.n, 1, 1);
    // The inland edge is NOT relaxed out of the folds it makes at tight corners. Trading width
    // for a clean ribbon there was measured at 9 fewer folded quads and a 2.5 m step where the
    // shortened apron stopped over ground that is still below the lake: an overlap of two
    // identical slabs a few centimetres apart is much cheaper than a hole in the waterline.
    for (let i = 0; i < run.n; i++) {
      // Where the apron hands back to the ground, it hands back to the ground that is ACTUALLY
      // there, so the two surfaces cross instead of stepping. The floor under that is the lake
      // itself: on a spit or a breakwater narrower than a terrain cell the grid has no land
      // vertex to interpolate from and reads below the datum, and there the apron IS the ground.
      const ex = run.x[i] - run.nx[i] * run.w[i], ez = run.z[i] - run.nz[i] * run.w[i];
      run.e[i] = run.met[i] ? run.g[i] : clamp(sampleTerrain(T, ex, ez),
        Math.max(H.waterY + 0.22, run.g[i] - EDGE_DROP_MAX), run.g[i]);
      S.apronMinW = Math.min(S.apronMinW, run.w[i]);
      S.apronMaxW = Math.max(S.apronMaxW, run.w[i]);
    }
    smoothRun(run.e, run.n, 1, 1);
  }

  // --- 3b. the islands: the airfield is graded flat and the shore mantle finds its bank ---------
  carveIslands(T, H, H.isle);

  // --- 4. deck polygons (piers, terminal aprons, and walkways over the water) -------------------
  H.decks = makeDeckIndex(collectDeckPolys(H).concat(collectCrossings(H, T)), H.rect);

  // --- 5. groundY now answers with the quay ---------------------------------------------------
  const base = T.groundY;
  T.groundY = (x, z) => {
    const g = base(x, z);
    const d = harbourDeckY(H, x, z);
    return d > g ? d : g;
  };
  H.baseGroundY = base;
  return S;
}

function dilateRun(a, n, half) {
  const tmp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = a[i];
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      if (a[j] > m) m = a[j];
    }
    tmp[i] = m;
  }
  a.set(tmp);
}

// Pier decks and terminal aprons, as plan rings with a deck level. Built once, used by the deck
// field and by the geometry pass so both always agree.
function collectDeckPolys(H) {
  const out = [];
  for (let i = 0; i < H.piers.length; i++) {
    const rec = H.piers[i];
    const ring = rec.closed ? rec.p.slice(0, rec.p.length - 1) : ribbonRing(rec.p, PIER_W * 0.5);
    if (!ring || ring.length < 3) continue;
    rec.ring = ring;
    rec.g = quayLevelNear(H, rec.cen[0], rec.cen[1]);
    rec.y = rec.g + PIER_LIFT;
    out.push({ ring, bbox: bboxOf(ring), y: rec.g });
  }
  for (let i = 0; i < H.terminals.length; i++) {
    const rec = H.terminals[i];
    if (!rec.p) continue;
    const ring = rec.closed ? rec.p.slice(0, rec.p.length - 1) : ribbonRing(rec.p, 9);
    if (!ring || ring.length < 3) continue;
    rec.ring = ring;
    rec.g = quayLevelNear(H, rec.cen[0], rec.cen[1]);
    rec.y = rec.g + PIER_LIFT;
    out.push({ ring, bbox: bboxOf(ring), y: rec.g });
  }
  return out;
}

/**
 * Every walkable way that crosses the surveyed lake gets a ground to cross it on, carried at the
 * level of its own two banks. Without this the ribbon drapes into the slip it is bridging and the
 * pedestrian walks down the lake bed — the exact failure the shoreline survey introduces, because
 * the guessed shoreline used to call these slips dry land.
 *
 * The GROUND is fixed for every crossing, bridge or not. Visible deck geometry is emitted only
 * where the extract does NOT tag a bridge: a tagged bridge is the street pass's to build, with
 * its own abutments and piers, and two decks over one slip is worse than none.
 */
function collectCrossings(H, T) {
  const out = [];
  const roads = Array.isArray(H.roads) ? H.roads : [];
  const STEP = 4.0;
  H.crossings = [];
  for (let r = 0; r < roads.length; r++) {
    const way = roads[r];
    if (!way || !WALKABLE[way.c] || !Array.isArray(way.p) || way.p.length < 2) continue;
    if (way.tun === 1) continue;
    const bb = bboxOf(way.p);
    if (bb[2] < H.rect[0] || bb[0] > H.rect[2] || bb[3] < H.rect[1] || bb[1] > H.rect[3]) continue;
    const pts = resample(way.p, STEP);
    const wet = new Uint8Array(pts.length);
    let any = 0;
    for (let i = 0; i < pts.length; i++) {
      wet[i] = waterAt(H.field, pts[i][0], pts[i][1]) ? 1 : 0;
      any += wet[i];
    }
    if (!any) continue;
    const hw = clamp(isNum(way.w) ? way.w * 0.5 : 1.6, 1.4, 9) + 0.8;
    let i = 0;
    while (i < pts.length) {
      if (!wet[i]) { i++; continue; }
      let j = i;
      while (j + 1 < pts.length && wet[j + 1]) j++;
      const a = Math.max(0, i - 1), b = Math.min(pts.length - 1, j + 1);
      const span = (b - a) * STEP;
      if (span <= 220) {
        const ya = bankLevel(H, T, pts[a]);
        const yb = bankLevel(H, T, pts[b]);
        for (let k = a; k < b; k++) {
          const t0 = (k - a) / Math.max(1, b - a), t1 = (k + 1 - a) / Math.max(1, b - a);
          const y = Math.max(lerp(ya, yb, t0), lerp(ya, yb, t1));
          const ring = segRing(pts[k], pts[k + 1], hw);
          if (ring) out.push({ ring, bbox: bboxOf(ring), y });
        }
        H.crossings.push({ a, b, pts, hw, ya, yb, bridge: way.b === 1 || (way.lay | 0) > 0 });
        H.stats.crossings++;
      }
      i = j + 1;
    }
  }
  return out;
}

const WALKABLE = { motorway: 1, major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };

// The ground at a crossing's bank: whatever the quay or the surveyed terrain says, whichever is
// higher, with the lake itself excluded so a bank in the water cannot drag the deck under.
function bankLevel(H, T, p) {
  const q = harbourDeckY(H, p[0], p[1]);
  const g = sampleTerrain(T, p[0], p[1]);
  const y = Math.max(q, g);
  return y > H.waterY + 0.35 ? y : quayLevelNear(H, p[0], p[1]);
}

// A rectangle around one segment, as a plan ring.
export function segRing(a, b, hw) {
  let tx = b[0] - a[0], tz = b[1] - a[1];
  const l = Math.hypot(tx, tz);
  if (!(l > EPS)) return null;
  tx /= l; tz /= l;
  const nx = -tz * hw, nz = tx * hw;
  const ex = tx * hw * 0.5, ez = tz * hw * 0.5;
  return [
    [a[0] + nx - ex, a[1] + nz - ez], [b[0] + nx + ex, b[1] + nz + ez],
    [b[0] - nx + ex, b[1] - nz + ez], [a[0] - nx - ex, a[1] - nz - ez],
  ];
}

// The quay GROUND level nearest a point — what the apron there stands at.
function quayLevelNear(H, x, z) {
  const hit = nearestShore(H, x, z);
  if (hit) return lerp(hit.run.g[hit.i], hit.run.g[hit.i + 1], hit.t);
  let best = Infinity, y = H.waterY + DECK_MIN + 0.7;
  for (let r = 0; r < H.runs.length; r++) {
    const run = H.runs[r];
    for (let i = 0; i < run.n; i += 8) {
      const d = Math.hypot(x - run.x[i], z - run.z[i]);
      if (d < best) { best = d; y = run.g[i]; }
    }
  }
  return y;
}

// A closed ring around an open polyline at the given half width. Used where the extract gives a
// pier as a line with no width.
export function ribbonRing(p, hw) {
  const pts = resample(p, 6);
  const n = pts.length;
  if (n < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    let tx = pts[b][0] - pts[a][0], tz = pts[b][1] - pts[a][1];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    const nx = -tz, nz = tx;
    // Square the ends off by pushing the first and last stations out along the tangent.
    const ex = i === 0 ? -tx * hw : (i === n - 1 ? tx * hw : 0);
    const ez = i === 0 ? -tz * hw : (i === n - 1 ? tz * hw : 0);
    left.push([pts[i][0] + nx * hw + ex, pts[i][1] + nz * hw + ez]);
    right.push([pts[i][0] - nx * hw + ex, pts[i][1] - nz * hw + ez]);
  }
  right.reverse();
  return left.concat(right);
}

/**
 * The quay or pier deck GROUND level at (x, z) — the level city.js's ground-plane rungs are laid
 * on — or -Infinity where the harbour owns no deck. Continuous at the apron's inland edge, where
 * it ramps back down to the terrain over BEVEL metres.
 */
export function harbourDeckY(H, x, z) {
  if (!H) return -Infinity;
  let y = deckPolyAt(H.decks, x, z);
  if (!isNum(x) || !isNum(z)) return y;
  // THE ISLANDS: the beach, the riprap and the island seawalls are the walking surface too, so
  // the player walks down the sand into the water instead of down a hole in the terrain grid.
  // Read BEFORE the mainland index, which returns early wherever it holds no quay.
  const m = islandGroundY(H.isle, x, z);
  if (m > y) y = m;
  const G = H.index;
  const ci = Math.floor((x - G.x0) / GRID_CELL), cj = Math.floor((z - G.z0) / GRID_CELL);
  if (ci < 0 || ci >= G.nx || cj < 0 || cj >= G.nz) return y;
  const list = G.cells[cj * G.nx + ci];
  if (!list) return y;
  // EVERY station within reach, not just the nearest: the apron is a ribbon between consecutive
  // stations, so a point can lie inside the slab drawn from one station while the station closest
  // to it — which may be on the far side of a corner, or simply have a narrower apron — says it
  // does not. Taking the highest answer is what makes the field agree with the geometry.
  let inland = -Infinity;
  for (let k = 0; k < list.length; k += 2) {
    const run = H.runs[list[k]], i = list[k + 1];
    const ax = run.x[i], az = run.z[i];
    const dx = run.x[i + 1] - ax, dz = run.z[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const qx = ax + dx * t, qz = az + dz * t;
    let nx = lerp(run.nx[i], run.nx[i + 1], t), nz = lerp(run.nz[i], run.nz[i + 1], t);
    const nl = Math.hypot(nx, nz);
    if (nl < EPS) continue;
    nx /= nl; nz /= nl;
    const side = -((x - qx) * nx + (z - qz) * nz);
    const w = lerp(run.w[i], run.w[i + 1], t);
    const pr = lerp(run.pr[i], run.pr[i + 1], t);
    if (side < -pr - 0.4 || side > w) continue;
    // Past the end of a segment the foot of the projection is clamped, so a point far out in the
    // lake can still project to a small offset. The straight-line distance is the honest test —
    // measured against the apron inland and against the wall face seaward — and it still admits
    // the wedge a mitred corner covers.
    const reach = (side > 0.5 ? w : pr) + 1.5;
    const dx2 = x - qx, dz2 = z - qz;
    if (dx2 * dx2 + dz2 * dz2 > reach * reach) continue;
    const g = lerp(run.g[i], run.g[i + 1], t);
    const e = lerp(run.e[i], run.e[i + 1], t);
    const f = side <= w - BEVEL ? 1 : clamp((w - side) / BEVEL, 0, 1);
    const q = lerp(e - BEVEL_DROP, g, f) + APRON_Y;
    if (side > 0.5) { if (q > inland) inland = q; } else if (q > y) y = q;
  }
  // The band right at the wall belongs to the coping, water side or not. Everything further in is
  // apron, and an apron over open water would be the quay eating the lake — across a slip mouth
  // or a narrow spit the projection can reach there, so the surveyed polygon gets the last word.
  if (inland > y && !waterAt(H.field, x, z)) y = inland;
  return y;
}

/** Permanent counters for the console audit. */
export function harbourStats(H) {
  return H ? H.stats : null;
}
