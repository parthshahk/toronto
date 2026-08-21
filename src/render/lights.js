// src/render/lights.js -- the clustered local-light rig (street lamps, shopfronts, signals).
//
// Owns the shape of the two GPU tables for both halves of the feature: the CPU cull, rank and
// cluster here, and the fragment-side lookup in render/shaders/lights.glsl.js, which imports
// LIGHT_GRID_N and LIGHT_SLOTS from this file.

import { clamp } from '../core/math.js';
import { numOr } from './util.js';

// --- local lights: a world-space CLUSTERED forward rig -----------------------------------------
// Why clustered-in-WORLD-SPACE rather than tiled-in-SCREEN-SPACE, which is the usual answer.
//
// A tiled (Forward+) rig bins lights into screen tiles every frame, which means projecting every
// light's bounding sphere, depth-partitioning the tile, and writing a fresh per-tile list — work
// that is proportional to the light count AND has to be redone whenever the camera so much as
// turns. WebGL2 has no compute shaders and no SSBOs, so all of that lands on the CPU and then has
// to be uploaded as a texture anyway.
//
// This city's lights do not move. Ever. They are street lamps bolted to masts, and they are
// distributed as a two-dimensional field: every one of them sits within a couple of metres of
// street level, and its useful reach is a squat cylinder about 30 m across. That makes a plain
// UNIFORM GRID OVER WORLD XZ the natural cluster structure — no depth slices, no frustum maths,
// no projection, and a fragment finds its cluster with two subtractions and a floor. The camera
// only decides WHICH WINDOW of that grid is resident.
//
// So the per-frame CPU work is: pull the lights inside an 896 m window out of a static broadphase
// grid, rank them, stamp each one into the handful of 28 m cells its disc covers, and upload two
// small textures (16 KB of light parameters, 32 KB of cell lists). The per-FRAGMENT work is
// bounded by LIGHT_SLOTS and by nothing else — not by how many lamps the city has, which is the
// entire point and what makes this scale from the 1,403 surveyed lamp positions in the current
// extract to the ~130,000 the full city implies.
//
// A fragment outside the window pays ONE compare. A fragment inside an empty cell pays one
// texelFetch that returns 0 and breaks. That is what pays for the window being big enough to hold
// the pools receding down a street, which is most of what a night street looks like.
//
//   LIGHT_MAX     lights uploaded per frame. Reported as renderer.lightStats.uploaded.
//   LIGHT_GRID_N  cells per side of the window
//   LIGHT_CELL    metres per cell; N x CELL is the window edge (32 x 28 = 896 m)
//   LIGHT_SLOTS   light indices per cell — the HARD per-fragment loop bound
//   LIGHT_CAND    candidates the gather will look at before it gives up ranking them
export const LIGHT_MAX = 512;
export const LIGHT_GRID_N = 32;
export const LIGHT_CELL = 28;
export const LIGHT_SLOTS = 16;
export const LIGHT_CAND = 4096;
// Broadphase cell for the STATIC index built once by setLights(). Bigger than the cluster cell
// because it is only ever queried with a window-sized box.
export const LIGHT_BROAD_CELL = 96;
// The largest influence radius any registered light may claim. It bounds how far outside the
// window the gather has to reach so a lamp just past the edge still lights the ground inside it.
export const LIGHT_RADIUS_MAX = 64;
// The luminaire types a caller may name. `power` is scene-linear radiance at one metre — the same
// units the rest of this renderer works in, fitted (see the Renderer's `lights` block) so a cobra
// head at 9.5 m lays a pool on 3% asphalt that reads at roughly 60 luma against a 6 luma street
// between the masts. The 'cone' field is the luminaire distribution: 1 = full cutoff (nothing above
// the horizontal), 0 = a bare globe. NONE of this encodes a time of day — CONTRACT Amendment 7;
// `env.nightFactor` and `env.daylight` alone decide when the rig is on.
export const LIGHT_KINDS = [
  // 0 cobra: high-pressure sodium on an arterial mast. Toronto's legacy default and still most
  //   of the network — this is the colour that makes a Toronto night photograph orange.
  { key: 'cobra', color: [1.000, 0.600, 0.220], power: 420, radius: 32, cone: 0.92 },
  // 1 led: the 4000 K replacement head going in across the city. Cooler, tighter, brighter.
  { key: 'led', color: [0.870, 0.930, 1.000], power: 460, radius: 32, cone: 0.95 },
  // 2 acorn: heritage globe (Distillery, St Lawrence, Queens Quay). Non-cutoff, so it glows.
  { key: 'acorn', color: [1.000, 0.760, 0.430], power: 145, radius: 20, cone: 0.15 },
  // 3 ped: pedestrian-scale post top on a sidewalk or a plaza.
  { key: 'ped', color: [1.000, 0.790, 0.480], power: 180, radius: 22, cone: 0.62 },
  // 4 shop: light thrown out of a lit ground-floor interior onto the pavement in front of it.
  { key: 'shop', color: [1.000, 0.870, 0.700], power: 100, radius: 14, cone: 0.30 },
  // 5 signal: a traffic or pedestrian head. Barely lights anything; it is here so a signalised
  //   intersection reads as one at night.
  { key: 'signal', color: [1.000, 0.560, 0.240], power: 36, radius: 10, cone: 0.35 },
  // 6 tunnel: batten luminaire under a soffit, teamway or underpass. Neutral and close in.
  { key: 'tunnel', color: [1.000, 0.940, 0.800], power: 130, radius: 16, cone: 0.55 },
];
export const LIGHT_KIND_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < LIGHT_KINDS.length; i++) m[LIGHT_KINDS[i].key] = i;
  // A few aliases a caller is likely to reach for, so registering lamps never needs this table.
  m.sodium = 0; m.lamp = 0; m.street = 0; m.arterial = 0;
  m.white = 1; m.cool = 1;
  m.globe = 2; m.heritage = 2;
  m.pedestrian = 3; m.post = 3;
  m.shopfront = 4; m.interior = 4;
  m.traffic = 5;
  m.batten = 6; m.soffit = 6;
  return m;
})();

// Module-scope scratch — the hot paths must not allocate. Both are filled and handed to the
// GPU inside one call.
// Local-light cluster window: xy = its world XZ origin, z = 1 / cell size, w = master gain.
const _lightWin = new Float32Array(4);
// x = rig level (0 at midday, 1 at Night), y = 1 when the tables hold something worth sampling.
const _lightRig = new Float32Array(2);

/* ---------------------------------------------------------- the light rig */

// Mixed into Renderer.prototype by renderer.js. The store itself (the parallel arrays, the
// static broadphase and the two staging buffers) is created in the Renderer constructor as
// this._lights, so a Renderer owns its own lights and two of them never share a table.
export const LightMethods = {
  // The two GPU tables the clustered rig reads. Both are tiny and both are rewritten every frame,
  // so they are created ONCE at whatever size the LIGHT_* constants ask for and never resized.
  //
  //   uLightData  RGBA32F, LIGHT_MAX x 2. Row 0 is (x, y, z, radius); row 1 is (r, g, b, cutoff)
  //               with rgb already multiplied by the light's power. Float, because a position
  //               anywhere in a 6.8 km extract quantises to ~4 m in half-float and that would put
  //               every pool in the wrong place. Sampled with texelFetch and NEAREST only, which
  //               is core WebGL2 — no EXT_color_buffer_float, no OES_texture_float_linear.
  //   uLightGrid  R16UI, (LIGHT_GRID_N * LIGHT_SLOTS) x LIGHT_GRID_N. One texel per (cell, slot),
  //               holding the light index PLUS ONE so that 0 can mean "end of this cell's list".
  //
  // 16 KB and 32 KB respectively. If either refuses to allocate the rig latches off for the
  // session and the city renders exactly as it did before it existed.
  _makeLightTables() {
    if (!this._lightsSupported) return false;
    const gl = this.gl;
    const S = this._lights;
    if (S.dataTex && S.gridTex) return true;
    try {
      // Drain any error another module left on the context, so the check below can only ever be
      // reporting on these two allocations.
      while (gl.getError() !== gl.NO_ERROR) { /* discard */ }
      const data = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LIGHT_MAX, 2, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const grid = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, grid);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, LIGHT_GRID_N * LIGHT_SLOTS, LIGHT_GRID_N, 0,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
      // Integer textures may only ever be filtered NEAREST; anything else is incomplete.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(data);
        gl.deleteTexture(grid);
        throw new Error('the driver would not allocate an RGBA32F or R16UI table');
      }
      S.dataTex = data;
      S.gridTex = grid;
      return true;
    } catch (err) {
      this._lightsSupported = false;
      S.dataTex = null;
      S.gridTex = null;
      this._fail('lights', 'the local-light tables could not be allocated', err);
      return false;
    }
  },

  /**
   * Register the city's LOCAL LIGHTS — every street lamp, shopfront and signal that should throw
   * light onto the world rather than merely glow. This REPLACES whatever was registered before.
   *
   * The renderer owns culling, ranking, clustering and the per-frame cap, so a caller hands over
   * the whole city ONCE (after the data loads, not per tile and not per frame) and never thinks
   * about it again. 1,403 surveyed lamps costs 64 KB of index and about 30 microseconds to build.
   *
   * Two accepted shapes:
   *
   *   1. An array of objects. `x`, `y`, `z` are world metres and are the only required fields.
   *        { x, y, z,
   *          kind:   one of 'cobra' | 'led' | 'acorn' | 'ped' | 'shop' | 'signal' | 'tunnel'
   *                  (plus the aliases in LIGHT_KIND_INDEX), or the numeric index. Default cobra.
   *          color:  [r, g, b] overriding the kind's colour
   *          power:  scene-linear radiance at one metre, overriding the kind's
   *          radius: influence radius in metres, overriding the kind's
   *          cone:   0 = a bare globe .. 1 = a full-cutoff head, overriding the kind's }
   *
   *   2. A flat numeric array (typed arrays welcome) of STRIDE 4: x, y, z, kindIndex. This is the
   *      shape to use at full-city scale — 130,000 lamps is a 2 MB Float32Array.
   *
   * Positions should be the LENS, not the base of the mast: a cobra head sits ~9.5 m up and 2 m
   * out over the carriageway, and putting the light at the foot of the post lights the post.
   *
   * Returns the number of lights accepted.
   */
  setLights(list) {
    const S = this._lights;
    S.n = 0;
    S.count = 0;
    S.ready = false;
    this.lightStats.registered = 0;
    if (!list || typeof list !== 'object') return 0;

    const flat = (typeof list[0] === 'number') || ArrayBuffer.isView(list);
    const n = flat ? Math.floor(list.length / 4) : (list.length | 0);
    if (!(n > 0)) return 0;

    const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
    const lr = new Float32Array(n), pw = new Float32Array(n);
    const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
    const cone = new Float32Array(n);
    let m = 0;

    for (let i = 0; i < n; i++) {
      let x, y, z, ki, col = null, power = NaN, radius = NaN, cn = NaN;
      if (flat) {
        const o = i * 4;
        x = +list[o]; y = +list[o + 1]; z = +list[o + 2];
        ki = list[o + 3] | 0;
      } else {
        const L = list[i];
        if (!L) continue;
        x = +L.x; y = +L.y; z = +L.z;
        const k = (L.kind !== undefined) ? L.kind : L.k;
        ki = (typeof k === 'number') ? (k | 0)
          : (typeof k === 'string' && LIGHT_KIND_INDEX[k] !== undefined ? LIGHT_KIND_INDEX[k] : 0);
        // isArrayLike() up top demands four entries (it guards matrices and vec4 uniforms); a
        // colour is three, so the test is written out here rather than reused.
        const rgb = (v) => (v !== null && typeof v === 'object' && v.length >= 3) ? v : null;
        col = rgb(L.color) || rgb(L.c);
        power = +(L.power !== undefined ? L.power : L.p);
        radius = +(L.radius !== undefined ? L.radius : L.r);
        cn = +L.cone;
      }
      // A NaN position would poison the broadphase bounds and take every light with it.
      if (!Number.isFinite(x + y + z)) continue;
      if (ki < 0 || ki >= LIGHT_KINDS.length) ki = 0;
      const K = LIGHT_KINDS[ki];
      const p = numOr(power, 0, 100000, K.power);
      const c = col || K.color;
      px[m] = x; py[m] = y; pz[m] = z;
      lr[m] = numOr(radius, 0.5, LIGHT_RADIUS_MAX, K.radius);
      pw[m] = p;
      cr[m] = numOr(+c[0], 0, 64, 1) * p;
      cg[m] = numOr(+c[1], 0, 64, 1) * p;
      cb[m] = numOr(+c[2], 0, 64, 1) * p;
      cone[m] = numOr(cn, 0, 1, K.cone);
      m++;
    }

    S.px = px; S.py = py; S.pz = pz; S.lr = lr; S.pw = pw;
    S.cr = cr; S.cg = cg; S.cb = cb; S.cone = cone;
    S.n = m;
    this.lightStats.registered = m;
    this._buildLightBroadphase();
    return m;
  },

  /** Forget every registered light. The wash (env.streetColor) is untouched. */
  clearLights() {
    const S = this._lights;
    S.n = 0;
    S.count = 0;
    S.ready = false;
    S.bStart = null;
    S.bItems = null;
    this.lightStats.registered = 0;
  },

  // A counting-sort uniform grid over the whole registered set, built once. The per-frame gather
  // only ever asks it for a window-sized box, so the cell is coarse (LIGHT_BROAD_CELL) and the
  // whole structure is two typed arrays with no per-cell objects. O(n), and linear in the light
  // count exactly as CONTRACT §8.4 requires of everything that has to reach the full city.
  _buildLightBroadphase() {
    const S = this._lights;
    const n = S.n;
    S.bStart = null;
    S.bItems = null;
    if (n <= 0) return;

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = S.px[i], z = S.pz[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cell = LIGHT_BROAD_CELL;
    const nx = Math.max(1, Math.min(4096, Math.ceil((x1 - x0) / cell) + 1));
    const nz = Math.max(1, Math.min(4096, Math.ceil((z1 - z0) / cell) + 1));
    const cells = nx * nz;
    const counts = new Int32Array(cells + 1);
    const idx = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const ci = clamp(Math.floor((S.px[i] - x0) / cell), 0, nx - 1);
      const cj = clamp(Math.floor((S.pz[i] - z0) / cell), 0, nz - 1);
      const c = cj * nx + ci;
      idx[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(n);
    const cursor = new Int32Array(cells);
    for (let i = 0; i < n; i++) {
      const c = idx[i];
      items[counts[c] + cursor[c]] = i;
      cursor[c]++;
    }

    S.bx0 = x0; S.bz0 = z0; S.bnx = nx; S.bnz = nz;
    S.bStart = counts;
    S.bItems = items;
  },

  // Per frame: pick the window, gather, rank, cluster, upload. Called from beginFrame, before
  // anything can ask for the scene uniforms.
  _updateLights() {
    const S = this._lights;
    const st = this.lightStats;
    st.candidates = 0; st.uploaded = 0; st.binned = 0; st.dropped = 0; st.maxCell = 0; st.ms = 0;
    S.count = 0;
    S.ready = false;
    const cam = this.camera;
    if (!this._q.lights || S.n <= 0 || !cam || !S.bStart) return;
    // The rig is dark at Afternoon, so there is nothing to cull, rank, cluster or upload. This is
    // what makes the daylight path an exact no-op on the CPU as well as in the shader.
    if (this._lightRigLevel() <= 0.002) return;
    if (!this._makeLightTables()) return;

    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();

    // The window is SNAPPED to the cluster grid. Without the snap every fragment's cell index
    // would shift by a sub-cell amount each frame and a pool's edge would crawl.
    const span = LIGHT_GRID_N * LIGHT_CELL;
    const cx = Number.isFinite(cam.pos[0]) ? cam.pos[0] : 0;
    const cz = Number.isFinite(cam.pos[2]) ? cam.pos[2] : 0;
    const cy = Number.isFinite(cam.pos[1]) ? cam.pos[1] : 0;
    const ox = Math.floor((cx - span * 0.5) / LIGHT_CELL) * LIGHT_CELL;
    const oz = Math.floor((cz - span * 0.5) / LIGHT_CELL) * LIGHT_CELL;
    S.ox = ox;
    S.oz = oz;

    // Gather. The box is grown by LIGHT_RADIUS_MAX so a lamp just outside the window still lights
    // the strip of ground inside it, which is what stops a seam appearing at the window edge.
    const pad = LIGHT_RADIUS_MAX;
    const bcell = LIGHT_BROAD_CELL;
    const i0 = clamp(Math.floor((ox - pad - S.bx0) / bcell), 0, S.bnx - 1);
    const i1 = clamp(Math.floor((ox + span + pad - S.bx0) / bcell), 0, S.bnx - 1);
    const j0 = clamp(Math.floor((oz - pad - S.bz0) / bcell), 0, S.bnz - 1);
    const j1 = clamp(Math.floor((oz + span + pad - S.bz0) / bcell), 0, S.bnz - 1);

    const cand = S.cand;
    const score = S.score;
    let nc = 0;
    const xLo = ox - pad, xHi = ox + span + pad;
    const zLo = oz - pad, zHi = oz + span + pad;
    for (let j = j0; j <= j1 && nc < LIGHT_CAND; j++) {
      const row = j * S.bnx;
      for (let i = i0; i <= i1 && nc < LIGHT_CAND; i++) {
        const c = row + i;
        const s0 = S.bStart[c], s1 = S.bStart[c + 1];
        for (let k = s0; k < s1 && nc < LIGHT_CAND; k++) {
          const li = S.bItems[k];
          const x = S.px[li], z = S.pz[li];
          if (x < xLo || x > xHi || z < zLo || z > zHi) continue;
          const dx = x - cx, dy = S.py[li] - cy, dz = z - cz;
          // Rank by apparent brightness at the eye, not by distance: an arterial cobra head 200 m
          // down the street contributes more to the image than a shopfront spill 40 m behind the
          // camera. The 400 m^2 pedestal stops the nearest lamp from owning the whole ranking.
          cand[nc] = li;
          score[nc] = S.pw[li] / (dx * dx + dy * dy + dz * dz + 400);
          nc++;
        }
      }
    }
    st.candidates = nc;
    if (nc === 0) return;

    const cfg = this.lights || {};
    const cap = Math.min(LIGHT_MAX, Math.max(0, numOr(cfg.max, 0, LIGHT_MAX, LIGHT_MAX) | 0));
    if (cap === 0) return;
    const gainR = numOr(cfg.radiusScale, 0.1, 4, 1);

    // Rank. The order is also the cluster slot priority, so when a cell overflows it is the
    // dimmest lights in it that are dropped and never the nearest.
    const ord = S.ord;
    ord.length = nc;
    for (let i = 0; i < nc; i++) ord[i] = i;
    ord.sort(S.cmp);
    const take = Math.min(cap, nc);

    // Stage the parameter table. Row 0 at [0, LIGHT_MAX*4), row 1 immediately after it.
    const data = S.data;
    const row1 = LIGHT_MAX * 4;
    for (let s = 0; s < take; s++) {
      const li = cand[ord[s]];
      const o = s * 4;
      data[o] = S.px[li];
      data[o + 1] = S.py[li];
      data[o + 2] = S.pz[li];
      data[o + 3] = S.lr[li] * gainR;
      data[row1 + o] = S.cr[li];
      data[row1 + o + 1] = S.cg[li];
      data[row1 + o + 2] = S.cb[li];
      data[row1 + o + 3] = S.cone[li];
    }

    // Cluster. Every light is stamped into the cells its disc actually covers — at radius 32 m
    // over 28 m cells that is at most 3 x 3, so the whole pass is a few thousand writes.
    const grid = S.grid;
    grid.fill(0);
    const inv = 1 / LIGHT_CELL;
    let binned = 0, dropped = 0, maxCell = 0;
    for (let s = 0; s < take; s++) {
      const li = cand[ord[s]];
      const r = S.lr[li] * gainR;
      const gx0 = Math.floor((S.px[li] - r - ox) * inv);
      const gx1 = Math.floor((S.px[li] + r - ox) * inv);
      const gz0 = Math.floor((S.pz[li] - r - oz) * inv);
      const gz1 = Math.floor((S.pz[li] + r - oz) * inv);
      const ax0 = gx0 < 0 ? 0 : gx0;
      const ax1 = gx1 > LIGHT_GRID_N - 1 ? LIGHT_GRID_N - 1 : gx1;
      const az0 = gz0 < 0 ? 0 : gz0;
      const az1 = gz1 > LIGHT_GRID_N - 1 ? LIGHT_GRID_N - 1 : gz1;
      const id = s + 1;
      for (let gz = az0; gz <= az1; gz++) {
        const base = gz * LIGHT_GRID_N * LIGHT_SLOTS;
        for (let gx = ax0; gx <= ax1; gx++) {
          const cellBase = base + gx * LIGHT_SLOTS;
          let slot = 0;
          while (slot < LIGHT_SLOTS && grid[cellBase + slot] !== 0) slot++;
          if (slot >= LIGHT_SLOTS) { dropped++; continue; }
          grid[cellBase + slot] = id;
          binned++;
          if (slot + 1 > maxCell) maxCell = slot + 1;
        }
      }
    }

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHT_MAX, 2, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, S.gridTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHT_GRID_N * LIGHT_SLOTS, LIGHT_GRID_N,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, grid);
    gl.bindTexture(gl.TEXTURE_2D, null);

    S.count = take;
    S.ready = binned > 0;
    st.uploaded = take;
    st.binned = binned;
    st.dropped = dropped;
    st.maxCell = maxCell;
    st.ms = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()) - t0;
  },

  // The rig's LEVEL, 0..1. nightFactor says how far into the night the preset is and daylight
  // closes the whole thing down under a sun, which together give exactly the Amendment 7 ramp with
  // no new field and nothing baked: Afternoon 0.000, Golden hour 0.099, Blue hour 0.860,
  // Night 1.000.
  _lightRigLevel() {
    const e = this.env;
    return numOr(e.nightFactor, 0, 1, 0.86) * (1 - this._daylight());
  },

  // Cluster uniforms, for any program that shades with local lights. The sampler UNITS are always
  // written even when the rig is dark: leaving two samplers defaulted to unit 0 would put them on
  // the same unit as uShadowMap, and two samplers of different types on one unit is undefined
  // behaviour that some drivers refuse to draw at all.
  _setLightUniforms(s) {
    const S = this._lights;
    const live = S.ready && S.count > 0 && this._q.lights && !!S.dataTex && !!S.gridTex;
    s.setTexture('uLightData', 5, live ? S.dataTex : null);
    s.setTexture('uLightGrid', 6, live ? S.gridTex : null);
    const cfg = this.lights || {};
    _lightWin[0] = S.ox;
    _lightWin[1] = S.oz;
    _lightWin[2] = 1 / LIGHT_CELL;
    _lightWin[3] = numOr(cfg.gain, 0, 32, 1);
    s.set('uLightWindow', _lightWin);
    _lightRig[0] = live ? this._lightRigLevel() : 0;
    _lightRig[1] = live ? 1 : 0;
    s.set('uLightRig', _lightRig);
  },
};

/* -------------------------------------------------------------- defaults -- */

// THE LOCAL LIGHT RIG. Feed it with setLights(); see that method for the shape. Everything
// here is a dial over what setLights() registered, and none of it decides WHEN the lamps are
// on — env.nightFactor and env.daylight do (CONTRACT Amendment 7).
//
//   max          lights uploaded per frame, capped by LIGHT_MAX. The per-FRAGMENT bound is
//                LIGHT_SLOTS (16, at the top of this file) and is unaffected by this.
//   gain         master multiplier on every registered light's power
//   radiusScale  master multiplier on every registered light's influence radius
//
// The powers in LIGHT_KINDS are a FIT, not a guess. Measured at Night on University Avenue,
// sampling the road at the player's own feet (the only sampling geometry in which nothing can
// get between the camera and the surface), a 9.5 m sodium cobra lays a pool of 42 luma
// directly beneath it against 9 luma at mid-span of a 30 m run and 1.3 luma with the rig
// switched off. A 4.4:1 maximum-to-minimum ratio along the run is what IES arterial practice
// actually specifies (3:1 to 6:1), and it is the same order as this build's measured 3.4:1
// sun/shade ratio at Afternoon — a pool at night is the night's version of a sunlit face.
export function defaultLightSettings() {
  return { max: LIGHT_MAX, gain: 1.0, radiusScale: 1.0 };
}

// What the rig actually did this frame. Read it, do not write it.
//   registered  lights setLights() is holding
//   candidates  lights the broadphase handed the ranker for this camera
//   uploaded    lights that made the per-frame cap
//   binned      (cell, slot) entries written into the cluster grid
//   dropped     stamps refused because a cell was already full
//   maxCell     the fullest cell's occupancy, out of LIGHT_SLOTS
//   ms          wall-clock cost of the whole update, milliseconds
export function makeLightStats() {
  return {
    registered: 0, candidates: 0, uploaded: 0, binned: 0, dropped: 0, maxCell: 0, ms: 0,
  };
}

// The light store. `n` lights in parallel arrays (structure-of-arrays: the gather touches
// position and power and nothing else, and this keeps that scan in two cache lines), a static
// uniform-grid broadphase built once by setLights(), and the two per-frame staging buffers
// that become the GPU tables. Nothing here is reallocated per frame.
export function makeLightStore() {
  return {
    n: 0,
    px: null, py: null, pz: null, lr: null, pw: null,
    cr: null, cg: null, cb: null, cone: null,
    // Static broadphase over the whole registered set.
    bx0: 0, bz0: 0, bnx: 0, bnz: 0, bStart: null, bItems: null,
    // Per-frame staging.
    data: new Float32Array(LIGHT_MAX * 2 * 4),
    grid: new Uint16Array(LIGHT_GRID_N * LIGHT_SLOTS * LIGHT_GRID_N),
    cand: new Int32Array(LIGHT_CAND),
    score: new Float64Array(LIGHT_CAND),
    ord: [],
    cmp: null,
    // Where this frame's window landed, and how much of it is live.
    ox: 0, oz: 0, count: 0,
    dataTex: null, gridTex: null, ready: false,
  };
}
