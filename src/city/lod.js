// src/city/lod.js — the city's tile manager, its level-of-detail stages and its vertex budget.
//
// CONTRACT.md §6.4, §8.4 and Amendment 11.1. Moved out of city.js unchanged. src/tiles.js owns
// the generic grid, the want-set and the scheduler; this module is the CITY's use of it:
//
//   the STAGES      mass, detail, signage — cheapest first, each with its own range and its own
//                   drop distance, so a camera sitting on a boundary cannot thrash a tile.
//   VERTEX_CAP      the resident-vertex ceiling, sized by measurement against the densest want
//                   set in the city rather than by taste.
//   CityTiles       the manager subclass, which knows the one thing a draw loop walking material
//                   classes in order cannot: that 'signs' is drawn in its own blended pass.
//   makeBuilders()  one MeshBuilder per material class.
//   captureSplit()  cuts the two global passes' output up by tile and hands each tile its share.
//
// The per-city CAPS live here too — how many cranes, tower signs and park trees the whole extract
// may hold, and the headroom an island tile's draw box needs. They are budgets like the rest.
//
// Every number here is a measurement or a budget, never a look.

import { MeshBuilder } from '../core/gl.js';
import { VERT_FLOATS } from '../core/vertex.js';
import { TileManager } from '../tiles.js';
import { TEXT_RANGE, TEXT_DROP } from '../render/text.js';
import { MESH_CLASSES } from './materials.js';

// Level-of-detail stages, cheapest first. Stage 0 is what a tower contributes to a two-kilometre
// view: massing with its real facade colour and lighting profile, the ground it stands on, the
// carriageway ribbons, the rails, the quay. Stage 1 is everything you can only resolve from the
// pavement: markings, kerbs, shopfronts, balconies, street furniture, people.
const S_MASS = 0;
const S_DETAIL = 1;
// Stage 2 is SIGNAGE: the glyph quads for shop names and house numbers. It is separate because a
// 250 mm shop name is a smear past 150 m — render.js fades it out at TEXT_FADE_END and the
// geometry is pure waste beyond that — and because it is the one class that is not drawn with
// the scene shader. Everything it emits is a pure function of the building and the street
// network, so the pass can be re-run in its own stage and land on exactly the fascias the
// detail stage built.
const S_SIGNS = 2;

// Ranges, metres from the camera to the tile's own cell.
//   MASS_RANGE   5.0 km. The map is 6.8 km across and the postcard viewpoint is 2 km out over
//                the lake looking at the whole skyline, so the massing has to reach the far side.
//   DETAIL_RANGE 780 m. A cobra lamp is 9.5 m tall; at 780 m and a 60-degree vertical field on a
//                900-line frame it is 19 px tall and about one across. A balcony band on a condo
//                is under 2 px. Past that the geometry costs vertices and returns nothing.
// The drop distances are ~25% further out, so a camera sitting exactly on a boundary does not
// thrash a tile in and out.
const MASS_RANGE = 5000;
const MASS_DROP = 6200;
const DETAIL_RANGE = 780;
const DETAIL_DROP = 980;
// Signage. text.js exports the pair render.js fades over and the pair a tile stage should use;
// TEXT_RANGE sits past TEXT_FADE_END so a run is invisible before its tile is allowed to drop it.
const SIGN_RANGE = TEXT_RANGE;
const SIGN_DROP = TEXT_DROP;

// Resident-vertex ceiling. 11 M vertices is 572 MB of interleaved vertex data at 13 floats —
// 1.57x the pre-expansion build, which shipped 7.0 M vertices (364 MB) in permanently resident
// buffers and held 60 fps, for 6x the area. It leaves the shadow atlas (3 x 2048^2 depth = 50 MB)
// and the post chain (~60 MB at 1440x900) comfortable room inside a 1 GB working set.
//
// Sized by measurement, not by taste: the densest want set in the city is the Financial District
// at street level, where MASS_RANGE holds 131 tiles of massing (~51 k vertices each) and
// DETAIL_RANGE holds 12 tiles of street detail (~379 k each) for 11.2 M vertices. At the old
// 9 M this overflowed permanently and the tile manager thrashed — see TileManager._adaptLod.
// The cap is set above that measured peak on purpose: the adaptive LOD scale is a safety valve
// for the full city, and a safety valve that is load-bearing in ordinary use is not a valve.
const VERTEX_CAP = 11000000;

// Milliseconds per frame the tile scheduler may spend generating geometry. At 60 fps the frame
// is 16.7 ms and the renderer wants most of it; 3.5 ms builds a dense downtown tile over about
// twenty frames, which is a third of a second — faster than the camera can cross the tile at
// anything under the fly boost.
const TILE_BUDGET_MS = 3.5;

// How long a tile may go undrawn before its geometry is released even though it is still in
// range. Long enough that turning round on the spot never rebuilds anything.
const TILE_EVICT_MS = 20000;

/**
 * The tile manager, plus the one thing a draw loop walking material classes in order cannot know
 * about: SIGNAGE.
 *
 * Glyph geometry is not an opaque material class. render.js draws it through drawText() — depth
 * test on, depth WRITE off, alpha blended, its own program and its own atlas sampler — and that
 * pass has to run after every opaque class has written depth and before the water. A caller that
 * simply walks the class list and calls drawMesh() on each would push the glyph quads through the
 * scene shader, which has no sampler for them.
 *
 * So the signs ride out behind the LAST OPAQUE CLASS: forEachMesh() notices the tail of the
 * opaque order going past and flushes the text pass behind it. A caller that asks for the sign
 * class by name has taken ownership of the pass, and the automatic flush switches itself off for
 * the rest of the session — so wiring it up explicitly costs nothing and can never double-draw.
 *
 * The renderer comes from attachRenderer(), or is found once on the global the boot module
 * publishes. Nothing here reaches into the renderer beyond calling the one documented entry
 * point, and a missing renderer, a missing font or a platform with no text support all end the
 * same way: no glyphs, and a city that is otherwise identical.
 */
class CityTiles extends TileManager {
  constructor(opts) {
    super(opts);
    this.signClass = (opts && opts.signClass) || '';
    this.lastOpaque = (opts && opts.lastOpaque) || '';
    this.renderer = null;
    this._signsClaimed = false;
    this._signLooked = false;
  }

  /** Hand the signage pass a renderer explicitly. Returns this. */
  attachRenderer(r) {
    this.renderer = (r && typeof r.drawText === 'function') ? r : null;
    return this;
  }

  _signRenderer() {
    if (this.renderer) return this.renderer;
    if (this._signLooked) return null;
    const g = (typeof globalThis !== 'undefined') ? globalThis.G : null;
    const r = g ? g.renderer : null;
    if (r && typeof r.drawText === 'function') {
      this.renderer = r;
      this._signLooked = true;
      return r;
    }
    return null;
  }

  forEachMesh(cls, fn) {
    if (cls === this.signClass) {
      this._signsClaimed = true;
      super.forEachMesh(cls, fn);
      return;
    }
    super.forEachMesh(cls, fn);
    if (this._signsClaimed || cls !== this.lastOpaque || !this.signClass) return;
    const r = this._signRenderer();
    if (!r || !r.font || !r.font.texture) return;
    super.forEachMesh(this.signClass, (m) => r.drawText(m));
  }
}

function makeBuilders() {
  const o = {};
  for (let i = 0; i < MESH_CLASSES.length; i++) o[MESH_CLASSES[i]] = new MeshBuilder();
  return o;
}

/** Total vertices standing in a builder set, so a pass can measure what it cost. */
function surroundVerts(mb) {
  let n = 0;
  for (let i = 0; i < MESH_CLASSES.length; i++) n += mb[MESH_CLASSES[i]].count;
  return n;
}

/**
 * Split geometry produced by a GLOBAL pass into per-tile chunks.
 *
 * Some passes cannot sensibly be run a tile at a time: the walkability audit has to see the whole
 * network before it knows where to build a flight of steps, and the harbour is one continuous
 * 32 km run of surveyed shoreline in harbour.js, which city.js does not own. They run once,
 * writing into scratch builders; this cuts the result up by triangle centroid and hands each tile
 * the float run it owns. Every triangle lands in exactly one tile, so nothing is dropped and
 * nothing is drawn twice.
 */
function* splitCapture(grid, cap, stageOf, tileChunks) {
  const VF = VERT_FLOATS;
  for (let c = 0; c < MESH_CLASSES.length; c++) {
    const name = MESH_CLASSES[c];
    const stage = stageOf[name] === undefined ? S_MASS : stageOf[name];
    const data = cap[name].data();
    const n = data.length;
    if (n < VF * 3) continue;
    yield;
    const step = VF * 3;
    const count = new Map();
    let since = 0;
    for (let i = 0; i + step <= n; i += step) {
      if (++since >= SPLIT_TRIS_PER_YIELD) { since = 0; yield; }
      const x = (data[i] + data[i + VF] + data[i + VF * 2]) / 3;
      const z = (data[i + 2] + data[i + VF + 2] + data[i + VF * 2 + 2]) / 3;
      const id = grid.idAt(x, z);
      count.set(id, (count.get(id) || 0) + 1);
    }
    const buf = new Map();
    const at = new Map();
    for (const [id, tris] of count) { buf.set(id, new Float32Array(tris * step)); at.set(id, 0); }
    since = 0;
    for (let i = 0; i + step <= n; i += step) {
      if (++since >= SPLIT_TRIS_PER_YIELD) { since = 0; yield; }
      const x = (data[i] + data[i + VF] + data[i + VF * 2]) / 3;
      const z = (data[i + 2] + data[i + VF + 2] + data[i + VF * 2 + 2]) / 3;
      const id = grid.idAt(x, z);
      const dst = buf.get(id);
      const o = at.get(id);
      dst.set(data.subarray(i, i + step), o);
      at.set(id, o + step);
    }
    for (const [id, arr] of buf) {
      let rec = tileChunks.get(id);
      if (!rec) { rec = [null, null]; tileChunks.set(id, rec); }
      if (!rec[stage]) rec[stage] = {};
      rec[stage][name] = arr;
      // Chunks are geometry too: the tile's draw box has to contain them or the culler will
      // throw away a quay wall that is genuinely on screen.
      let x0 = Infinity, z0 = Infinity, y0 = Infinity, x1 = -Infinity, z1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < arr.length; i += VF) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      grid.cover(grid.tiles[id], x0, z0, x1, z1, y0, y1);
      yield;
    }
    cap[name].reset();
  }
}

/** The same split, run to completion, for a caller that is not on a frame budget. */
function captureSplit(grid, cap, stageOf, tileChunks) {
  const it = splitCapture(grid, cap, stageOf, tileChunks);
  for (;;) { if (it.next().done) return; }
}

/**
 * Hand a LATE capture to the tiles that own it, and rebuild whichever of them were already
 * standing.
 *
 * captureSplit() above is for a pass that runs before the tiles are indexed. This is for one that
 * runs AFTER the first frame — the walkability solve, whose connectors and flights of steps are
 * worth far less than the second they used to cost in front of the player. The split is the same;
 * what is new is that a tile may already have geometry, so its share goes on a list rather than
 * into the single slot indexTiles() fills, and the stages that received anything are invalidated
 * so the scheduler generates them again on the next frame.
 *
 * The vertices are identical either way — the same emitters wrote the same floats into the same
 * capture — so a city built through this path is the city built through the other one, and the
 * geometry fingerprint says so.
 *
 * A GENERATOR, because splitting a capture is not free: the quay is 400,000 vertices and cutting
 * them up is a fifth of a second. Doing that in one step would replace the stall this whole change
 * exists to remove with a smaller one in the same place.
 *
 * @param {object} W grid, tiles (may be null), cap (a builder set), stageOf, stats
 */
function* deliverCapture(W) {
  const { grid, tiles, cap, stageOf, stats } = W;
  const tileChunks = new Map();
  yield* splitCapture(grid, cap, stageOf || {}, tileChunks);
  let verts = 0;
  for (const [id, rec] of tileChunks) {
    const t = grid.tiles[id];
    if (!t || !t.f) continue;
    if (!t.f.late) t.f.late = [];
    t.f.late.push(rec);
    t.empty = false;
    for (let s = 0; s < rec.length; s++) {
      if (!rec[s]) continue;
      for (const c in rec[s]) verts += rec[s][c].length / VERT_FLOATS;
      if (tiles) tiles.invalidate(t, s);
    }
  }
  if (stats) stats.chunkVerts = Math.round((stats.chunkVerts || 0) + verts);
}

// Append a captured float run into a live builder, verbatim. MeshBuilder.append() with an
// identity transform copies every channel, so a tiny shim over the raw array is all it takes.
const _chunkShim = { _n: 0, _data: null };
function appendChunk(mb, arr) {
  if (!arr || !arr.length) return;
  _chunkShim._n = arr.length;
  _chunkShim._data = arr;
  mb.append(_chunkShim, 0, 0, 0, 0, 1);
  _chunkShim._data = null;
}

// Triangles a capture split may copy between yields. One is a centroid, a grid lookup and a
// 42-float copy; 8,192 of them is a fraction of a millisecond.
const SPLIT_TRIS_PER_YIELD = 8192;

const MAX_CRANES = 7;
const MAX_TOWER_SIGNS = 8;
const PARK_TREE_SPACING = 17;
const MAX_PARK_TREES = 220;
// Headroom above the ground a tile of islands has to draw: the lighthouse lantern is the tallest
// thing down there at 21 m, an approach mast stands over the water, and a canopy tree tops 14 m.
const ISLE_TILE_UP = 34.0;
const ISLE_TILE_DOWN = 18.0;

export {
  MAX_CRANES, MAX_TOWER_SIGNS, PARK_TREE_SPACING, MAX_PARK_TREES, ISLE_TILE_UP, ISLE_TILE_DOWN,
  S_MASS, S_DETAIL, S_SIGNS,
  MASS_RANGE, MASS_DROP, DETAIL_RANGE, DETAIL_DROP, SIGN_RANGE, SIGN_DROP,
  VERTEX_CAP, TILE_BUDGET_MS, TILE_EVICT_MS,
  CityTiles, makeBuilders, surroundVerts, captureSplit, deliverCapture, appendChunk,
};
