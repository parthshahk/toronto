// src/tiles.js — the lazy per-tile geometry cache and its scheduler. (The grid itself is
// ./tilegrid.js; this file is what owns GL buffers, budgets and eviction.)
//
// WHY THIS EXISTS. The city used to be one merged mesh per material class: 18 draw calls, and
// every footprint triangulated before the first frame. That works at 7 km2. At the current 43 km2
// it is 21.5 M vertices — 1.1 GB of vertex data in eight buffers, several seconds of blocking
// generation, and a shadow pass that redraws the whole city three times per frame. At the full
// city (~428,000 buildings, about 23x this) it is not close.
//
// So geometry is partitioned into a fixed grid of square tiles and built on demand:
//
//   * a feature is indexed into exactly ONE tile — the one holding its anchor — and the tile's
//     draw box grows to contain it. Nothing is clipped, nothing is duplicated, so there is no
//     seam to get wrong. Linear features longer than a tile are cut into per-tile runs upstream
//     (see city.js splitRuns) before they ever reach this file.
//   * each tile builds in STAGES, cheapest first. Stage 0 is massing — the silhouette and the
//     ground, what a tower two kilometres away actually contributes. Stage 1 is everything you
//     can only see from the pavement. A tile that drops out of detail range frees stage 1 and
//     keeps stage 0, so walking away from a block costs nothing to walk back into.
//   * builds run as GENERATORS pumped against a per-frame millisecond budget, so a dense tile
//     costs several partial frames instead of one 60 ms hitch.
//   * geometry is evicted by least-recently-drawn once the resident vertex count passes a cap,
//     and the GL buffers really are deleted.
//
// Determinism is the tiling contract: a tile's content must not depend on which of its
// neighbours happen to be resident, or on the order tiles were built in. city.js keys every
// procedural hash on world position and seeds each tile's RNG from the tile's own coordinates,
// so a tile built alone is byte-identical to the same tile built last.
//
// Zero dependencies.

import { MeshBuilder } from './core/gl.js';
import {
  TILE_SIZE, makeTileGrid, splitRuns, extractPlanes, boxOutside, boxOutsideMargin, boxDist,
} from './tilegrid.js';

// The grid moved to ./tilegrid.js when this file passed the ~800-line ceiling. It is still
// exported from here: world/roads.js, city.js and city/report.js import it by this path.
export { TILE_SIZE, makeTileGrid, splitRuns };

/* ================================================================ constants == */

// Frame times the build budget steers between: under FRAME_ROOMY there is room to generate more
// this frame, over FRAME_TIGHT the generation is already costing the player frames. The gap
// between them is the deadband that stops it hunting.
const FRAME_ROOMY = 19.0;
const FRAME_TIGHT = 24.0;
const BUDGET_STEP = 0.35;

const STATE_EMPTY = 0;
const STATE_BUILDING = 1;
const STATE_READY = 2;

// A pooled MeshBuilder that has grown past this is released instead of reused, so one dense
// downtown tile does not leave 7 oversized scratch buffers pinned for the rest of the session.
const POOL_MAX_FLOATS = 1 << 21;      // 2 M floats = 8 MB per class

// How many queued builds may be passed over for want of data before the scheduler gives up on
// this frame. Passing one over costs a request and a few pointer chases, so a handful is free;
// walking the whole queue every frame while the network catches up is not, and there is nothing
// to gain from it — the requests for the nearest tiles are already in flight by then.
const DATA_SKIP_MAX = 32;

/* ============================================================== manager ==== */

/**
 * Owns every tile's GPU geometry: what is built, what is being built, what is drawn and what is
 * thrown away.
 *
 * opts:
 *   gl          WebGL2 context
 *   grid        makeTileGrid() result
 *   classes     material-class names, in draw order — one merged mesh per class PER TILE
 *   stages      [{ name, range, drop }] cheapest first; `range` is the metres from the camera at
 *               which the stage is wanted and `drop` (> range) where it is released
 *   build       function* (tile, stageIndex, mb) — city.js's per-tile generator
 *   vertexCap   resident-vertex ceiling; eviction runs until the total is back under it
 *   budgetMs    milliseconds per frame the scheduler may spend generating geometry
 *   evictMs     how long a tile may go undrawn before its geometry is released anyway
 *   dataBudgetMs  of `budgetMs`, the most that may go on getting tile DATA resident
 *   dataAhead   metres past stage 0's build range that data is fetched for anyway, so that
 *               walking towards a block does not stall on the network
 */
export class TileManager {
  constructor(opts) {
    const o = opts || {};
    this.gl = o.gl;
    this.grid = o.grid;
    this.classes = (o.classes || []).slice();
    this.stages = (o.stages || []).map((s) => ({
      name: s.name || 'stage',
      range: Number.isFinite(s.range) ? s.range : 1000,
      drop: Number.isFinite(s.drop) ? s.drop : (Number.isFinite(s.range) ? s.range * 1.3 : 1300),
      // How far the adaptive valve may wind this stage's radius back before it gives up. A stage
      // that is cheap and carries the whole distant image — the far tier — sets a high floor so
      // a squeeze somewhere else cannot take the horizon away.
      floor: Number.isFinite(s.floor) ? s.floor : null,
      // A stage may serve an ANNULUS rather than a disc: `near` is the distance inside which it
      // is not wanted, and `supersededBy` names the stage that has to be STANDING for that to
      // apply. The far tier uses both: inside `near` the massing stage draws over it, so holding
      // it there is paying for geometry that is deliberately never drawn — but only once the
      // massing is actually there. On distance alone, arriving somewhere new left a tile with no
      // far tier and no massing yet, which is a hole in the ground exactly when the player is
      // most likely to be looking at it.
      near: Number.isFinite(s.near) ? s.near : 0,
      supersededBy: Number.isFinite(s.supersededBy) ? s.supersededBy : -1,
    }));
    this.build = typeof o.build === 'function' ? o.build : null;
    this.vertexCap = Number.isFinite(o.vertexCap) ? o.vertexCap : 9000000;
    this.budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : 4.0;

    // THE BUILD BUDGET FINDS ITS OWN LEVEL.
    //
    // A fixed 3.5 ms a frame was set when a tile had two stages and the map was 6.8 km across.
    // It is now four stages over 252 km2: a dense tile costs about 28 ms to generate, and filling
    // the view after a fast move means roughly 150 of them — about 1,200 frames, or twenty
    // seconds of watching the city assemble itself. That is most of what "the detail arrives too
    // late" actually is; the radius is only the other half.
    //
    // So the budget grows while there is work queued and the frame is comfortably inside its
    // slice, and gives ground the moment frames start slipping. Because spending more IS what
    // makes frames slip, this settles by itself at whatever the machine can afford, and it costs
    // nothing on a machine that cannot afford anything. With no work queued it decays back to
    // the base, so a burst never inherits a budget the last one earned.
    this.budgetMaxMs = Number.isFinite(o.budgetMaxMs) ? o.budgetMaxMs : 9.0;
    this._budget = this.budgetMs;
    this._prevNow = 0;
    this.evictMs = Number.isFinite(o.evictMs) ? o.evictMs : 12000;
    this.maxQueue = Number.isFinite(o.maxQueue) ? o.maxQueue : 512;
    this.dataBudgetMs = Number.isFinite(o.dataBudgetMs) ? o.dataBudgetMs : 2.0;
    this.dataAhead = Number.isFinite(o.dataAhead) ? o.dataAhead : 700;

    // THE WANT SET IS SCOPED TO THE VIEW.
    //
    // Range alone decides what gets BUILT, and range is a disc: at 900 m over downtown that is
    // ~200 tiles of massing queued so that ~40 can be drawn. Five sixths of the vertex budget
    // went on geometry behind the camera, and because the budget is a hard cap the adaptive LOD
    // valve paid for it by shrinking the radius of the stages in front — measured with the
    // detail stage pinned at its 0.12 floor, 94 m of a possible 780 m, at every viewpoint in
    // the city. Street furniture arrived a hundred metres away instead of eight hundred, and
    // the massing stopped 2.6 km out instead of 5 km. Both are what the player actually sees.
    //
    // So a tile is only queued if it is inside a WIDENED frustum, or inside `omniRadius` of the
    // camera, where turning on the spot must never rebuild anything. The margin is a fraction of
    // the tile's own distance, which is a constant angle rather than a constant distance, plus a
    // floor so close tiles are generous. Eviction is protected by a larger margin than building
    // uses, so a tile drifting across the edge of the cone is not built and dropped repeatedly.
    //
    // Set `omniRadius` to Infinity to restore the pure-disc behaviour; the geometry tools build
    // every tile directly through _startJob() and never consult any of this.
    this.viewMarginFrac = Number.isFinite(o.viewMarginFrac) ? o.viewMarginFrac : 0.35;
    this.viewMarginMin = Number.isFinite(o.viewMarginMin) ? o.viewMarginMin : 900;
    this.omniRadius = (o.omniRadius === Infinity || Number.isFinite(o.omniRadius))
      ? o.omniRadius : 1300;
    // Hysteresis: what is kept is a wider cone than what is built.
    this.viewKeepMult = Number.isFinite(o.viewKeepMult) ? o.viewKeepMult : 1.8;

    // Adaptive level-of-detail scale — the safety valve that keeps the WANT SET inside the cap.
    //
    // Eviction and the builder used to be able to fight each other. If everything in range added
    // up to more than `vertexCap`, the builder would build a wanted tile, the resident total went
    // over, and eviction picked the furthest READY stage — which was itself still in range, so it
    // was re-queued and rebuilt on the next frame, evicting another. Measured downtown with the
    // camera standing perfectly still: ~210 builds and ~210 evictions per 200 frames, forever,
    // 131 M vertices evicted and 13,000 buffer uploads before anyone noticed.
    //
    // A cap cannot be enforced by throwing away things that are still wanted; the WANT SET itself
    // has to shrink. So each stage carries a scale on its range, and when the resident total runs
    // over the cap the most detailed stage that still has room gives up some radius. The tile
    // eviction then removes is genuinely out of range and is not queued again, and the system
    // settles instead of oscillating.
    //
    // `_lodCeil` remembers the scale at which a stage last overflowed so relaxing cannot walk
    // straight back into the overflow it just escaped. It is forgiven when the camera has moved
    // far enough that "how dense is it here" is a different question — half a tile.
    this.lodStep = Number.isFinite(o.lodStep) ? o.lodStep : 0.04;
    this._lod = new Float64Array(this.stages.length).fill(1);
    this._lodCeil = new Float64Array(this.stages.length).fill(1);
    this._lodCeilCap = this.vertexCap;
    this._lodTurn = 0;
    // Resident vertices per stage, refreshed every frame. The valve needs to know which
    // stage can actually pay for an overflow; see _adaptLod.
    this._stageVerts = new Float64Array(this.stages.length);
    // Floors: massing is the silhouette and gives up radius only after every detail stage has
    // already bottomed out, so detail's floor is the lower of the two. They are set low enough
    // that the valve can ALWAYS reach a want set that fits — a stage whose range has gone to its
    // floor still keeps the tile the camera is standing in, so convergence is guaranteed for any
    // cap that can hold one dense tile (~430 k vertices downtown). Reaching either floor means
    // the cap is badly undersized for the hardware and the skyline will visibly shorten; that is
    // still the right failure, because the alternative measured at 6 M was a permanent treadmill
    // of 150 builds and 150 evictions per 200 frames with the camera standing still.
    this._lodFloor = this.stages.map((s, i) => (
      Number.isFinite(s.floor) ? s.floor : (i === 0 ? 0.20 : 0.12)));
    this._lodAnchor = [Infinity, Infinity, Infinity];

    const nStage = this.stages.length;
    const tiles = this.grid.tiles;
    for (let k = 0; k < tiles.length; k++) {
      const st = new Array(nStage);
      for (let s = 0; s < nStage; s++) {
        st[s] = { state: STATE_EMPTY, meshes: {}, verts: 0, lastWant: 0 };
      }
      tiles[k].st = st;
    }

    this._planes = new Float32Array(24);
    this._pool = null;
    this._job = null;
    this._queue = [];
    this._visible = [];
    this._casters = [];
    this._now = 0;

    // THE DATA SOURCE. Null means the whole city's records were already in memory when the
    // manager was built — the monolithic sidecar — and every tile can be built the moment it is
    // wanted. A CityStream here means the records themselves arrive per tile, and a build waits
    // until its own payload and the handful its features reach into have landed. See
    // src/data/stream.js; setDataSource() is the only way in.
    this._data = null;

    // STATIC GEOMETRY. One mesh per material class that is always resident, always drawn, never
    // culled and never evicted — the world's outermost ground apron and nothing else. The apron
    // is a handful of very large quads that reach thirteen kilometres past the last tile, so it
    // is simultaneously the cheapest thing in the world (about 25 k vertices) and the thing that
    // is on screen from literally every viewpoint. Tiling it would mean either a tile grid two
    // orders of magnitude larger than the city or a draw box so big the culler is a no-op; both
    // are worse than admitting that a few pieces of geometry are genuinely global.
    //
    // They are drawn FIRST within their class, before any tile, so the horizon ground is under
    // everything the city puts on top of it.
    this._statics = new Map();

    this.stats = {
      residentVerts: 0, residentTiles: 0, visibleTiles: 0, drawMeshes: 0,
      built: 0, evicted: 0, evictedVerts: 0, queued: 0, buildMs: 0, lastBuildMs: 0,
      buildBudgetMs: 0,
      peakResidentVerts: 0, uploads: 0, freed: 0, lodScale: 1, lodShrinks: 0, lodRelaxes: 0,
      evictedWanted: 0, staticVerts: 0, staticMeshes: 0,
      dataWaits: 0, dataMs: 0,
    };
  }

  get visibleTiles() { return this._visible; }

  /**
   * Attach the per-tile data source, or pass null to clear it.
   *
   * It is set after construction rather than in the options because the loader has to know the
   * extent before it can build the grid, and has to have the grid before it can trust a
   * manifest's tile ids — so the stream is validated and handed over once both exist.
   *
   * The object needs four methods, all of which CityStream has:
   *   ready(tileId)                 is every payload this tile's build reads decoded?
   *   want(tileId, nowMs, dist)     stamp it and queue whatever is missing
   *   pump(budgetMs)                spend up to that long fetching and decoding; returns the ms
   *   sweep(nowMs, evictMs)         release payloads nobody has wanted for that long
   *
   * A fifth, `bounds(tileId)`, is optional and worth having: see _primeBoxes().
   */
  setDataSource(src) {
    const ok = !!(src && typeof src.ready === 'function' && typeof src.want === 'function' &&
      typeof src.pump === 'function' && typeof src.sweep === 'function');
    this._data = ok ? src : null;
    if (ok && typeof src.bounds === 'function') this._primeBoxes(src);
    return this;
  }

  /**
   * Give every tile its draw box from the MANIFEST, before a single feature has arrived.
   *
   * A tile's box is normally grown one indexed feature at a time, which is fine when the whole
   * city is in memory before the grid is walked. Streamed, it is a deadlock: a tile with no
   * features indexed is `empty`, an empty tile is never queued for a build, a tile that is never
   * queued never asks for its data, and so its features never arrive to make it non-empty.
   *
   * The manifest already carries the box containing everything each tile owns — the packer has
   * to compute it anyway to work out which payloads a build depends on — so priming from it
   * breaks the cycle and, as a bonus, gives the frustum culler and the level-of-detail distance
   * honest boxes from the first frame instead of cell-sized guesses.
   *
   * Boxes only GROW here, exactly as cover() grows them, so a grid that was also indexed the
   * old way ends up with the union rather than whichever ran last.
   */
  _primeBoxes(src) {
    const tiles = this.grid.tiles;
    for (let k = 0; k < tiles.length; k++) {
      const b = src.bounds(k);
      if (!b) continue;
      this.grid.cover(tiles[k], b[0], b[1], b[2], b[3], b[4], b[5]);
    }
  }

  /**
   * Register (or replace) the always-resident mesh of one material class. Pass null to clear.
   * Its vertices come out of the resident cap, so the level-of-detail valve accounts for them
   * exactly as it does for a tile.
   */
  setStatic(cls, mesh) {
    const had = this._statics.get(cls);
    if (had && had !== mesh) had.dispose();
    if (mesh && mesh.vertexCount > 0) this._statics.set(cls, mesh);
    else this._statics.delete(cls);
    let verts = 0;
    for (const m of this._statics.values()) verts += m.vertexCount | 0;
    this.stats.staticVerts = verts;
    this.stats.staticMeshes = this._statics.size;
    return this;
  }

  /** The cap the TILES may fill: whatever is left after the static geometry has taken its share. */
  _cap() {
    const left = this.vertexCap - this.stats.staticVerts;
    return left > 200000 ? left : 200000;
  }

  /** Tile stages wanted but not yet built, as of the last frame(). */
  get pending() { return this._queue.length + (this._job ? 1 : 0); }

  /** Spend `ms` generating geometry right now. The loader uses this; the frame loop does not. */
  pump(ms) {
    const clock = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now() : () => Date.now();
    if (!this._now) this._now = clock();
    const budget = Math.max(0, ms);
    const spent = this._pumpData(budget);
    return spent + this._pump(Math.max(0, budget - spent), clock);
  }

  /**
   * Spend part of the frame's budget getting RECORDS resident, before any of it goes on turning
   * records into triangles. Returns the milliseconds used, which come out of the build budget:
   * the point of the split is to bound the total, not to add a second budget beside the first.
   */
  _pumpData(budget) {
    if (!this._data || !(budget > 0)) return 0;
    const spent = this._data.pump(Math.min(this.dataBudgetMs, budget)) || 0;
    this.stats.dataMs += spent;
    return spent;
  }

  /* ------------------------------------------------------------- builders */

  _builders() {
    if (!this._pool) {
      this._pool = {};
      for (let i = 0; i < this.classes.length; i++) this._pool[this.classes[i]] = new MeshBuilder();
    }
    const mb = this._pool;
    for (let i = 0; i < this.classes.length; i++) mb[this.classes[i]].reset();
    return mb;
  }

  _recyclePool() {
    const mb = this._pool;
    if (!mb) return;
    for (let i = 0; i < this.classes.length; i++) {
      const c = this.classes[i];
      // A builder that grew for one dense tile keeps that buffer forever otherwise.
      if (mb[c]._data.length > POOL_MAX_FLOATS) mb[c] = new MeshBuilder();
    }
  }

  /* ------------------------------------------------------------ residency */

  _release(tile, stage) {
    const rec = tile.st[stage];
    if (rec.state === STATE_EMPTY) return 0;
    let freed = 0;
    for (const name in rec.meshes) {
      const m = rec.meshes[name];
      if (!m) continue;
      freed += m.vertexCount | 0;
      m.dispose();                  // deletes the VAO and the VBO; nothing else holds either
      this.stats.freed++;
    }
    rec.meshes = {};
    rec.verts = 0;
    rec.state = STATE_EMPTY;
    this.stats.residentVerts -= freed;
    if (this.stats.residentVerts < 0) this.stats.residentVerts = 0;
    return freed;
  }

  /** Drop every stage of a tile. Returns the vertices freed. */
  releaseTile(tile) {
    let freed = 0;
    for (let s = 0; s < tile.st.length; s++) freed += this._release(tile, s);
    return freed;
  }

  /**
   * Throw one tile's geometry away because its FEATURES changed, not because it went out of
   * range — the analysis that produced it finished after it was built.
   *
   * This is what lets an analysis pass run behind the first frame instead of in front of it. A
   * pass that is off the critical path can still produce geometry (the walkability audit builds
   * connectors and flights of steps; the quay wall is one continuous run of surveyed shoreline),
   * and a tile that was already standing when its share arrived has to be generated again. The
   * scheduler re-queues it on the next frame like any other empty stage, so the rebuild costs one
   * ordinary budgeted build and never a stall.
   *
   * A stage that is mid-build is abandoned rather than finished: the job's generator holds a
   * MeshBuilder set that is about to be reset anyway, and letting it complete would upload
   * geometry that is already known to be wrong.
   *
   * @param {object} tile the grid tile
   * @param {number} [stage] one stage, or every stage when omitted
   * @returns {number} vertices freed
   */
  invalidate(tile, stage) {
    if (!tile || !tile.st) return 0;
    const one = Number.isFinite(stage);
    const s0 = one ? stage : 0;
    const s1 = one ? stage : tile.st.length - 1;
    if (s0 < 0 || s1 >= tile.st.length) return 0;
    let freed = 0;
    for (let s = s0; s <= s1; s++) {
      const job = this._job;
      if (job && job.tile === tile && job.stage === s) this._job = null;
      freed += this._release(tile, s);
    }
    return freed;
  }

  /* ---------------------------------------------------------------- build */

  /** Stage range and release distance after the adaptive scale. */
  range(s) { return this.stages[s].range * this._lod[s]; }
  drop(s) { return this.stages[s].drop * this._lod[s]; }

  _wantStage(tile, s) {
    // Stage 0 gates every later one: massing is what a tile IS, and detail proud of a wall that
    // was never emitted would float in space. Only the OUTER limit gates — a stage that serves
    // an annulus must not pull the stages behind it in with its inner edge.
    for (let k = 0; k <= s; k++) {
      if (tile.dist > this.range(k)) return false;
    }
    if (this._superseded(tile, s, 1)) return false;
    return !tile.empty;
  }

  /**
   * Is stage `s` of this tile close enough in that the stage which draws over it has taken over?
   *
   * Both conditions have to hold: inside the annulus AND the superseding stage actually standing.
   * `slack` widens the radius for the keep test so the boundary cannot thrash.
   */
  _superseded(tile, s, slack) {
    const st = this.stages[s];
    if (!(st.near > 0) || tile.dist >= st.near * slack) return false;
    const sup = st.supersededBy;
    if (sup < 0) return true;
    const rec = tile.st[sup];
    return !!rec && rec.state === STATE_READY;
  }

  _keepStage(tile, s) {
    for (let k = 0; k <= s; k++) {
      if (tile.dist > this.drop(k)) return false;
    }
    if (this._superseded(tile, s, 0.72)) return false;
    return true;
  }

  /**
   * Move the level-of-detail scale one step so the want set fits the cap.
   *
   * Shrinks from the most detailed stage down, because detail costs about 7x what massing does
   * per tile (measured downtown: 379 k vertices a tile against 51 k) and is the half of the
   * image a distant viewer cannot resolve anyway. Relaxes from the coarsest stage up, so the
   * skyline comes back before the shopfronts do.
   */
  _adaptLod(px, py, pz) {
    const n = this._lod.length;
    if (!n) return;

    const res = this.stats.residentVerts;
    const cap = this._cap();

    // The ceiling records "this scale overflowed HERE, at THIS cap", so it has to be forgiven
    // whenever either of those stops being true. Without the last of these three the scale is a
    // one-way ratchet: a squeeze that bottoms the valve out leaves the detail radius short for
    // the rest of the session even after the pressure lifts. Measured before this was added —
    // cap restored from 6 M to 11 M, resident 6.8 M against it, and the detail radius stayed at
    // 351 m of a possible 780 m with zero relax events.
    const ax = this._lodAnchor;
    const half = this.grid ? this.grid.size * 0.5 : 312;
    const dx = px - ax[0], dy = py - ax[1], dz = pz - ax[2];
    const moved = !(dx * dx + dy * dy + dz * dz < half * half);
    const capChanged = cap !== this._lodCeilCap;
    // Forgiving the ceiling on genuine headroom. 0.6 was too strict once the far tier made the
    // resident total depend on altitude: flying up frees several million vertices at once, and
    // at 69% full the detail radius stayed pinned where a street-level squeeze had left it with
    // 3.5 M vertices going unused. Overshooting costs one shrink, which the ceiling then pins
    // again; not overshooting costs radius the player can see.
    const roomy = res < cap * 0.82 && !this._job && this._queue.length === 0;
    if (moved || capChanged || roomy) {
      for (let s = 0; s < n; s++) this._lodCeil[s] = 1;
      this._lodCeilCap = cap;
      if (moved) { ax[0] = px; ax[1] = py; ax[2] = pz; }
    }
    if (res > cap) {
      // SHRINK A STAGE THAT CAN ACTUALLY PAY.
      //
      // Walking from the most detailed stage down and taking the first one above its floor meant
      // the signage stage — the last in the list and, at well under ten thousand resident
      // vertices, the cheapest thing in the world — was driven from 165 m to its 20 m floor
      // before the detail stage was touched even once. Twenty-two consecutive shrinks that freed
      // nothing, because the overflow was never signage's to fix; and once bottomed out its
      // ceiling pinned it there for the rest of the session. Shop names simply stopped existing
      // downtown.
      //
      // So a stage is only asked to give up radius if it is holding enough for that to matter.
      // If none is — the overflow is coming from somewhere a stage radius cannot reach — fall
      // back to the old walk so the valve still always converges.
      const payShare = cap * 0.02;
      let pick = -1;
      for (let s = n - 1; s >= 0; s--) {
        if (this._lod[s] <= this._lodFloor[s] + 1e-6) continue;
        if (this._stageVerts[s] < payShare) continue;
        pick = s;
        break;
      }
      if (pick < 0) {
        for (let s = n - 1; s >= 0; s--) {
          if (this._lod[s] > this._lodFloor[s] + 1e-6) { pick = s; break; }
        }
      }
      if (pick >= 0) {
        this._lodCeil[pick] = this._lod[pick];
        this._lod[pick] = Math.max(this._lodFloor[pick], this._lod[pick] - this.lodStep);
        this.stats.lodShrinks++;
      }
    } else if (res < cap && !this._job && this._queue.length === 0) {
      // Only with the want set fully satisfied — relaxing while tiles are still queued would
      // widen the target before the last one had been reached.
      //
      // The test is against the whole cap and not some fraction of it. A deadband here looks
      // like prudence and is actually a trap: downtown at full detail the want set rests at
      // 10.98 M of the 11 M cap, so a relax threshold of 0.75 x cap can never be reached and the
      // scale, once knocked down, stays down — measured stuck at 0.74 (577 m of a possible
      // 780 m) with 2.4 M vertices of headroom going unused. Oscillation is prevented by the
      // ceiling instead, which is the mechanism that actually knows where the edge was: one
      // relax overshoots by a single step, the shrink puts it back, and the ceiling then pins it
      // there.
      // ROUND ROBIN, so a cheap stage cannot be starved by an expensive one.
      //
      // Relaxing from s = 0 every time meant whichever stage was furthest below its ceiling won
      // every turn. Downtown that is the detail stage, which is expensive enough that relaxing it
      // overflows the cap immediately and is shrunk straight back — so the loop spent every frame
      // on the same two steps and never reached the signage stage at all. Measured with 0.88 M
      // vertices of headroom going unused and shop names pinned at 20 m of a possible 165 m, in a
      // stage whose entire resident cost is under ten thousand vertices.
      for (let k = 0; k < n; k++) {
        const s = (this._lodTurn + k) % n;
        const ceil = Math.max(this._lodFloor[s], this._lodCeil[s] - this.lodStep);
        if (this._lod[s] < Math.min(1, ceil) - 1e-6) {
          this._lod[s] = Math.min(1, ceil, this._lod[s] + this.lodStep * 0.5);
          this.stats.lodRelaxes++;
          this._lodTurn = (s + 1) % n;
          break;
        }
      }
    }
    this.stats.lodScale = this._lod[n - 1];
  }

  _startJob(tile, stage) {
    const mb = this._builders();
    let it = null;
    try {
      it = this.build(tile, stage, mb);
    } catch (err) {
      tile.st[stage].state = STATE_READY;   // a tile that throws must not be retried forever
      console.error('[tiles] build ' + tile.i + ',' + tile.j + ' stage ' + stage + ' threw', err);
      return null;
    }
    tile.st[stage].state = STATE_BUILDING;
    return { tile, stage, mb, it, t0: 0 };
  }

  _finishJob(job) {
    const gl = this.gl;
    const rec = job.tile.st[job.stage];
    const mb = job.mb;
    let verts = 0;
    for (let i = 0; i < this.classes.length; i++) {
      const c = this.classes[i];
      const n = mb[c].count;
      if (n <= 0) continue;
      rec.meshes[c] = mb[c].build(gl);
      verts += n;
      this.stats.uploads++;
    }
    rec.verts = verts;
    rec.state = STATE_READY;
    this.stats.residentVerts += verts;
    if (this.stats.residentVerts > this.stats.peakResidentVerts) {
      this.stats.peakResidentVerts = this.stats.residentVerts;
    }
    this.stats.built++;
    this._recyclePool();
  }

  /** Pump the current job (and start new ones) until `budget` ms are spent. */
  _pump(budget, clock) {
    const t0 = clock();
    let spent = 0;
    let guard = 0;
    let skipped = 0;
    while (spent < budget && guard++ < 4096) {
      if (!this._job) {
        if (!this._queue.length || !this.build) break;
        const next = this._queue.shift();
        const rec = next.tile.st[next.stage];
        if (rec.state !== STATE_EMPTY) continue;
        // The queue is built from last frame's distances; a tile that has since fallen out of
        // range must not be built just because it was queued.
        if (!this._wantStage(next.tile, next.stage)) continue;
        // A streamed city has to have the RECORDS before it can have the geometry. Ask for them
        // and move on: the tile is queued again next frame, and by then the group file carrying
        // it is usually already in hand.
        if (this._data && !this._data.ready(next.tile.id)) {
          this._data.want(next.tile.id, this._now, next.tile.dist);
          this.stats.dataWaits++;
          if (++skipped >= DATA_SKIP_MAX) break;
          continue;
        }
        this._job = this._startJob(next.tile, next.stage);
        if (!this._job) continue;
      }
      const job = this._job;
      let done = false;
      try {
        done = job.it.next().done === true;
      } catch (err) {
        console.error('[tiles] build ' + job.tile.i + ',' + job.tile.j + ' threw', err);
        done = true;
      }
      if (done) {
        this._finishJob(job);
        this._job = null;
      }
      spent = clock() - t0;
    }
    this.stats.lastBuildMs = spent;
    this.stats.buildMs += spent;
    return spent;
  }

  /* ------------------------------------------------------------- eviction */

  /**
   * Two rules, in order.
   *
   *  1. A stage that has been OUT OF RANGE for longer than `evictMs` goes, always. The grace
   *     period is what makes turning round on the spot free — and it has to be measured against
   *     when the stage was last *wanted*, not when the tile was last *drawn*. Measuring it
   *     against drawing looks right and is a churn machine: a tile directly behind the camera is
   *     in range, so it is queued and built, but never in the frustum, so it goes stale and is
   *     thrown away — measured at 120 builds and 120 evictions a second with the camera
   *     standing still.
   *  2. If the resident total is over the cap, the FURTHEST stages go until it is back under,
   *     detail before massing. Distance is the right key here and staleness is not: everything
   *     still in range was wanted this frame, so they all share one timestamp.
   */
  _evict(needVerts) {
    const tiles = this.grid.tiles;
    let freed = 0;
    const over = [];
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k];
      for (let s = t.st.length - 1; s >= 0; s--) {
        const rec = t.st[s];
        if (rec.state !== STATE_READY) continue;
        if (!this._keepStage(t, s)) {
          if (this._now - rec.lastWant > this.evictMs) {
            const n = this._release(t, s);
            freed += n;
            this.stats.evicted++;
            this.stats.evictedVerts += n;
            continue;
          }
        }
        // Ranked so that everything OUT of range goes before anything still in it: evicting a
        // wanted stage guarantees it is queued again on the next frame, which is the treadmill
        // _adaptLod exists to prevent. Within each group the furthest geometry is the least
        // useful, with the stage only breaking ties, so memory pressure never strips the detail
        // off the block the player is standing on while a tile five kilometres away keeps its
        // massing.
        if (needVerts > 0) {
          const spare = this._keepStage(t, s) ? 0 : 1e9;
          over.push(t, s, spare + t.dist * 4 + s);
        }
      }
    }
    if (needVerts <= 0 || freed >= needVerts) return freed;
    const idx = [];
    for (let i = 0; i < over.length; i += 3) idx.push(i);
    idx.sort((a, b) => over[b + 2] - over[a + 2]);
    for (let i = 0; i < idx.length && freed < needVerts; i++) {
      const k = idx[i];
      const rec = over[k].st[over[k + 1]];
      if (rec.state !== STATE_READY) continue;
      if (this._keepStage(over[k], over[k + 1])) this.stats.evictedWanted++;
      const n = this._release(over[k], over[k + 1]);
      freed += n;
      this.stats.evicted++;
      this.stats.evictedVerts += n;
    }
    return freed;
  }

  /* ----------------------------------------------------------------- frame */

  /**
   * One frame of housekeeping: distances, culling, stage decisions, the build budget and
   * eviction. Call before drawing. `budgetMs` overrides the constructor budget (the loader
   * passes a large one).
   */
  frame(camera, nowMs, budgetMs) {
    const clock = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now() : () => Date.now();
    this._now = Number.isFinite(nowMs) ? nowMs : clock();
    const cam = camera;
    const pos = cam ? cam.pos : null;
    const px = pos ? pos[0] : 0, py = pos ? pos[1] : 0, pz = pos ? pos[2] : 0;
    const pl = this._planes;
    if (cam && cam.viewProj) extractPlanes(cam.viewProj, pl);

    const tiles = this.grid.tiles;
    const vis = this._visible;
    vis.length = 0;
    this._queue.length = 0;
    let resident = 0;
    let meshes = 0;
    const sv = this._stageVerts;
    sv.fill(0);

    const maxRange = this.stages.length ? this.drop(0) : 0;
    // THE READ-AHEAD. Records are asked for out to here, past the range anything is actually
    // built at, so a tile's payload has already arrived and been decoded by the time the tile
    // itself comes into range. Without it the first thing that happens when a tile enters range
    // is a network round trip, which is a visible hole in the direction of travel; with it, one
    // tile of warning at RUN 22 m/s is 28 seconds.
    //
    // Measured against stage 0's BUILD range, not its drop range. The drop is 24% further out —
    // where geometry is released rather than made — and records are only ever read to make
    // geometry, so anchoring on it would fetch 54% more area than anything can be built from.
    // A tile drifting through the band between the two keeps the geometry it already has, and
    // the eviction grace period keeps its records for twenty seconds after it stops being asked
    // for, so nothing is re-fetched for hovering on the boundary either.
    const dataRange = this._data ? this.range(0) + this.dataAhead : -1;
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k];
      // Level of detail is measured against the CORE cell (plus the tile's real height range),
      // not the draw box, so one long feature cannot pull a whole tile into detail range.
      t.dist = boxDist(px, py, pz, t.cx0, t.by0, t.cz0, t.cx1, t.by1, t.cz1);
      // Stamped every frame whether or not it is resident, for the same reason rec.lastWant is:
      // this is "when was this last wanted", which is what the eviction grace period below and
      // the stream's own sweep are both measured against.
      if (t.dist <= dataRange && !t.empty) this._data.want(t.id, this._now, t.dist);
      let ready = false;
      for (let s = 0; s < t.st.length; s++) {
        if (t.st[s].state === STATE_READY) {
          resident += t.st[s].verts;
          sv[s] += t.st[s].verts;
          ready = true;
        }
      }
      const inRange = t.dist <= maxRange;
      const shown = ready && inRange && !boxOutside(pl, t.bx0, t.by0, t.bz0, t.bx1, t.by1, t.bz1);
      t.visible = shown;
      if (shown) {
        t.lastSeen = this._now;
        vis.push(t);
        for (let s = 0; s < t.st.length; s++) {
          const rec = t.st[s];
          if (rec.state !== STATE_READY) continue;
          for (const c in rec.meshes) if (rec.meshes[c]) meshes++;
        }
      }
      if (!inRange || t.empty) continue;
      // IN RANGE IS NOT ENOUGH — see viewMarginFrac. A tile is built when it is close enough
      // that turning round must not stall, or when it is inside the widened cone; it is kept
      // against a wider cone still, so the boundary cannot thrash.
      const omni = t.dist <= this.omniRadius;
      let wantable = omni, keepable = omni;
      if (!omni) {
        const m = Math.max(this.viewMarginMin, t.dist * this.viewMarginFrac);
        keepable = !boxOutsideMargin(pl, t.bx0, t.by0, t.bz0, t.bx1, t.by1, t.bz1,
          m * this.viewKeepMult);
        wantable = keepable
          && !boxOutsideMargin(pl, t.bx0, t.by0, t.bz0, t.bx1, t.by1, t.bz1, m);
      }
      for (let s = 0; s < t.st.length; s++) {
        const rec = t.st[s];
        // Stamped whether or not the stage is resident yet: this is "when was this wanted",
        // which is what the eviction grace period has to be measured against.
        if (keepable && this._keepStage(t, s)) rec.lastWant = this._now;
        if (rec.state !== STATE_EMPTY) continue;
        if (!wantable || !this._wantStage(t, s)) continue;
        this._queue.push({ tile: t, stage: s, key: t.dist + s * 100000 });
      }
    }

    this.stats.residentVerts = resident;
    this.stats.visibleTiles = vis.length;
    this.stats.drawMeshes = meshes;
    this.stats.queued = this._queue.length;

    // Nearest first, and massing before detail so a tile always has a silhouette before it
    // grows shopfronts.
    vis.sort((a, b) => a.dist - b.dist);
    if (this._queue.length > 1) this._queue.sort((a, b) => a.key - b.key);
    if (this._queue.length > this.maxQueue) this._queue.length = this.maxQueue;

    // Adapt the budget before spending it. An explicit budgetMs (the loader, the headless tools)
    // overrides the whole mechanism.
    {
      const prev = this._prevNow;
      this._prevNow = this._now;
      const dt = prev ? this._now - prev : 16.7;
      if (this._queue.length || this._job) {
        if (dt > 0 && dt < FRAME_ROOMY) {
          this._budget = Math.min(this.budgetMaxMs, this._budget + BUDGET_STEP);
        } else if (dt > FRAME_TIGHT) {
          this._budget = Math.max(this.budgetMs * 0.5, this._budget - BUDGET_STEP * 2);
        }
      } else if (this._budget !== this.budgetMs) {
        this._budget = this.budgetMs;
      }
      this.stats.buildBudgetMs = this._budget;
    }
    const budget = Number.isFinite(budgetMs) ? budgetMs : this._budget;
    // Data first: there is nothing to triangulate until the records land, and a build that finds
    // its payload missing costs a wasted queue slot.
    const dataMs = this._pumpData(budget);
    if (budget - dataMs > 0) this._pump(budget - dataMs, clock);

    // Shrink the want set BEFORE evicting, so whatever eviction takes is genuinely out of range
    // and will not simply be rebuilt on the next frame.
    this._adaptLod(px, py, pz);

    let over = this.stats.residentVerts - this._cap();
    if (over > 0) this._evict(over);
    else this._evict(0);           // still retire anything past evictMs, so memory comes back
    // ONE eviction policy, not two. The records a tile was built from retire on the same clock
    // and the same grace period as the meshes built from them, so walking away from a block
    // gives back both, and walking back into it pays for both at once rather than finding the
    // geometry gone and the data still pinned, or the reverse.
    if (this._data) this._data.sweep(this._now, this.evictMs);

    let residentTiles = 0;
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k];
      for (let s = 0; s < t.st.length; s++) {
        if (t.st[s].state === STATE_READY) { residentTiles++; break; }
      }
    }
    this.stats.residentTiles = residentTiles;
    return this;
  }

  /**
   * Meshes that should cast shadows this frame: the named classes of every visible tile inside
   * `radius`. The cascades only cover renderer.shadow.distance metres, so casting from the whole
   * resident city is pure waste — and at 43 km2 it is three extra passes over 6 M vertices.
   */
  casters(radius, classNames) {
    const out = this._casters;
    out.length = 0;
    const vis = this._visible;
    for (let i = 0; i < vis.length; i++) {
      const t = vis[i];
      if (t.dist > radius) break;               // sorted nearest-first
      for (let s = 0; s < t.st.length; s++) {
        const rec = t.st[s];
        if (rec.state !== STATE_READY) continue;
        for (let c = 0; c < classNames.length; c++) {
          const m = rec.meshes[classNames[c]];
          if (m && m.vertexCount > 0) out.push(m);
        }
      }
    }
    return out;
  }

  /** Every resident mesh of one class on the visible tiles, nearest first. */
  forEachMesh(cls, fn) {
    const st = this._statics.get(cls);
    if (st && st.vertexCount > 0) fn(st, null, -1);
    const vis = this._visible;
    for (let i = 0; i < vis.length; i++) {
      const t = vis[i];
      for (let s = 0; s < t.st.length; s++) {
        const rec = t.st[s];
        if (rec.state !== STATE_READY) continue;
        const m = rec.meshes[cls];
        if (m && m.vertexCount > 0) fn(m, t, s);
      }
    }
  }

  dispose() {
    const tiles = this.grid.tiles;
    for (let k = 0; k < tiles.length; k++) this.releaseTile(tiles[k]);
    for (const m of this._statics.values()) m.dispose();
    this._statics.clear();
    this.stats.staticVerts = 0;
    this.stats.staticMeshes = 0;
    this._job = null;
    this._queue.length = 0;
    this._visible.length = 0;
    this._pool = null;
  }
}

export { STATE_EMPTY, STATE_BUILDING, STATE_READY };
export default { TILE_SIZE, makeTileGrid, splitRuns, TileManager };
