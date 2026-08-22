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
import { TileManager, STATE_READY } from '../tiles.js';
import { TEXT_RANGE, TEXT_DROP } from '../render/text.js';
import { MESH_CLASSES } from './materials.js';

// Level-of-detail stages, cheapest first. Stage 0 is what a tower contributes to a two-kilometre
// view: massing with its real facade colour and lighting profile, the ground it stands on, the
// carriageway ribbons, the rails, the quay. Stage 1 is everything you can only resolve from the
// pavement: markings, kerbs, shopfronts, balconies, street furniture, people.
// Stage 0 is the FAR TIER: the city as it reads from kilometres away, and nothing else. Coarse
// ground, the road network, and a prism for every building tall enough to still be a shape at
// that range. It exists because the map is now 17.3 x 14.6 km while the massing stage reaches
// 5 km, so from any altitude two thirds of the city simply was not there — the player flew over
// open water until land snapped into existence. It is also the cheapest possible answer to that:
// the whole map's worth of far tier costs less than a kilometre of massing.
//
// It is DRAWN ONLY WHERE MASSING IS NOT. See CityTiles.forEachMesh — a tile that has real massing
// suppresses its own far geometry, so the two never z-fight and the swap happens deep in the fog.
const S_FAR = 0;
const S_MASS = 1;
const S_DETAIL = 2;
// Stage 2 is SIGNAGE: the glyph quads for shop names and house numbers. It is separate because a
// 250 mm shop name is a smear past 150 m — render.js fades it out at TEXT_FADE_END and the
// geometry is pure waste beyond that — and because it is the one class that is not drawn with
// the scene shader. Everything it emits is a pure function of the building and the street
// network, so the pass can be re-run in its own stage and land on exactly the fascias the
// detail stage built.
const S_SIGNS = 3;

// Ranges, metres from the camera to the tile's own cell.
//   MASS_RANGE   5.0 km. The map is 6.8 km across and the postcard viewpoint is 2 km out over
//                the lake looking at the whole skyline, so the massing has to reach the far side.
//   DETAIL_RANGE 780 m. A cobra lamp is 9.5 m tall; at 780 m and a 60-degree vertical field on a
//                900-line frame it is 19 px tall and about one across. A balcony band on a condo
//                is under 2 px. Past that the geometry costs vertices and returns nothing.
// The drop distances are ~25% further out, so a camera sitting exactly on a boundary does not
// thrash a tile in and out.
// FAR_RANGE 13 km. The map's diagonal is 22.6 km and the far plane is 18.6 km, but fog closes the
// horizon long before either: past about 13 km the aerial-perspective term has taken a building to
// within a few percent of the sky, so geometry beyond it is paying for pixels that are already the
// colour they would be without it.
const FAR_RANGE = 13000;
const FAR_DROP = 15000;
// HOW FAR YOU CAN ACTUALLY SEE DEPENDS ON HOW HIGH YOU ARE.
//
// 13 km is what the far tier is worth from two thousand metres up. Standing on King Street it is
// worth nothing at all: the next building blocks it, and the 4 M vertices it costs come straight
// out of the street furniture the player IS looking at — measured with the detail stage pinned at
// 94 m while the far tier held 425 tiles nobody could see.
//
// So the far range is driven by eye height. The floor is deliberately past MASS_DROP: stage 0
// gates every later stage, so a far range shorter than the massing drop would pull the massing
// in behind it and take the skyline away at street level, which is the opposite of the point.
const FAR_EYE_BASE = 4000;
const FAR_EYE_PER = 5.5;
// Quantised, so a hovering camera does not re-plan the want set on every frame of a hover.
const FAR_EYE_STEP = 500;

/** The far tier's build radius for an eye at height `y`. */
function farRangeAt(y) {
  const want = FAR_EYE_BASE + Math.max(0, y || 0) * FAR_EYE_PER;
  const q = Math.round(Math.min(FAR_RANGE, want) / FAR_EYE_STEP) * FAR_EYE_STEP;
  return Math.max(FAR_EYE_BASE, Math.min(FAR_RANGE, q));
}
// Buildings shorter than this are left out of the far tier. 58.7% of the stock is 8-15 m and
// 16.6% is under 8 m: house-scale, one or two pixels tall at the ranges this stage serves, and
// three quarters of the building count. The roads and the ground carry those neighbourhoods.
// The far tier is the DISTANT IMAGE, and it is cheap. The adaptive valve may wind it back to
// 7.8 km under pressure and no further: past that the player would watch the far side of the
// city dissolve, which is the exact failure this stage exists to remove.
const FAR_FLOOR = 0.60;
const FAR_MIN_H = 14;
// Every third grid line: 486 vertices of ground a tile instead of 3,750.
//
// Chosen by measuring the chord error against the real height field, because Toronto is not flat
// — the Don and the Humber cut ravines forty metres deep, and decimation is a chord across them.
// Measured worst / 99th-percentile error over the whole map: step 5 gives 26.8 m / 7.1 m, which
// flattens a ravine to a third of its depth and shows as a nine-pixel step at the massing
// boundary; step 3 gives 11.5 m / 3.4 m, about one pixel at that boundary, for 486 vertices. Step
// 2 would be 6.9 m / 1.9 m at 1,014. Terrain is a rounding error against the buildings in this
// tier either way, so the ravines win.
const FAR_TERRAIN_STEP = 3;

// THE LOW-RISE FABRIC. Leaving out everything under FAR_MIN_H keeps the far tier affordable, but
// leaving out three quarters of the building stock and keeping the streets makes a neighbourhood
// read from the air as bare lots with roads ruled across them — which is worse than crude. So the
// short stock comes back as ONE merged block per cell of a coarse lattice, standing on the total
// footprint area of the buildings in that cell at their area-weighted mean height. Twenty-five
// boxes a tile against the hundred and thirty buildings they stand for.
const FAR_LOW_CELLS = 5;
// A cell holding less built area than this is genuinely empty and gets nothing.
const FAR_LOW_MIN_AREA = 260;

// Road classes the far tier draws. 62% of the road network is `foot` and another 21% is
// `service`: footpaths, alleys and driveways, none of which is resolvable at the ranges this
// stage serves, all of which was being drawn as pale ribbon. Measured at 3.0 M vertices of the
// far tier's 9.9 M, and it turned every distant neighbourhood into a white wash.
const FAR_ROAD_CLASSES = { major: 1, minor: 1, motorway: 1 };

// MASS_RANGE was 5 km when the map was 6.8 km across and the massing stage WAS the distance
// tier. It is not any more: the far tier is, and full massing — real roof forms, graded trench
// profiles, ballasted track, ground covers tessellated to 12 mm — only starts to read inside a
// few kilometres. Measured cost of holding it at 5 km on the expanded map: 9.3 M of an 11 M
// vertex budget, which left the detail stage pinned at its floor with street furniture appearing
// 94 m away instead of 780 m.
const MASS_RANGE = 2800;
// Where the far tier stops being worth holding, because massing is drawn over it from here in.
// Left well short of MASS_RANGE so a tile crossing outward has its coarse geometry standing long
// before the massing is released: 1,100 m of overlap is thirteen seconds at the fly speed.
const FAR_NEAR = 1700;
const MASS_DROP = 3500;
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

  /**
   * Wrap a draw callback so a tile's FAR geometry is skipped once it has real massing.
   *
   * The far tier and the massing tier describe the same buildings on the same ground. Both
   * resident and both drawn, they would z-fight everywhere they overlap. Rather than release the
   * far stage when massing arrives — which would make flying outward pop, because the coarse
   * geometry would then have to be rebuilt — the far stage stays resident and simply stops being
   * drawn for that tile. It costs about 2 k vertices a tile to keep, and it means crossing the
   * massing boundary in either direction is a swap between two things that already exist.
   *
   * Statics arrive with a null tile and stage -1 and are never gated.
   */
  _gate(fn) {
    return (m, t, s) => {
      if (s === S_FAR && t && t.st[S_MASS] && t.st[S_MASS].state === STATE_READY) return;
      fn(m, t, s);
    };
  }

  forEachMesh(cls, fn) {
    const gated = this._gate(fn);
    if (cls === this.signClass) {
      this._signsClaimed = true;
      super.forEachMesh(cls, gated);
      return;
    }
    super.forEachMesh(cls, gated);
    if (this._signsClaimed || cls !== this.lastOpaque || !this.signClass) return;
    const r = this._signRenderer();
    if (!r || !r.font || !r.font.texture) return;
    super.forEachMesh(this.signClass, this._gate((m) => r.drawText(m)));
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
function* splitCapture(grid, cap, stageOf, tileChunks, defaultStage) {
  const VF = VERT_FLOATS;
  const dflt = Number.isFinite(defaultStage) ? defaultStage : S_MASS;
  for (let c = 0; c < MESH_CLASSES.length; c++) {
    const name = MESH_CLASSES[c];
    const stage = stageOf[name] === undefined ? dflt : stageOf[name];
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
      if (!rec) { rec = []; tileChunks.set(id, rec); }
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
function captureSplit(grid, cap, stageOf, tileChunks, defaultStage) {
  const it = splitCapture(grid, cap, stageOf, tileChunks, defaultStage);
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
 * @param {object} W grid, tiles (may be null), cap (a builder set), stageOf, defaultStage, stats
 */
function* deliverCapture(W) {
  const { grid, tiles, cap, stageOf, stats, defaultStage } = W;
  const tileChunks = new Map();
  yield* splitCapture(grid, cap, stageOf || {}, tileChunks, defaultStage);
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
  S_FAR, S_MASS, S_DETAIL, S_SIGNS,
  FAR_RANGE, FAR_DROP, FAR_FLOOR, FAR_NEAR, FAR_MIN_H, FAR_TERRAIN_STEP,
  FAR_LOW_CELLS, FAR_LOW_MIN_AREA, FAR_ROAD_CLASSES, farRangeAt,
  MASS_RANGE, MASS_DROP, DETAIL_RANGE, DETAIL_DROP, SIGN_RANGE, SIGN_DROP,
  VERTEX_CAP, TILE_BUDGET_MS, TILE_EVICT_MS,
  CityTiles, makeBuilders, surroundVerts, captureSplit, deliverCapture, appendChunk,
};
