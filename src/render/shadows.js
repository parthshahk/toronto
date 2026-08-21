// src/render/shadows.js -- cascaded shadow maps (CONTRACT 3.2 item 1).
//
// Owns the cascade COUNT and the split anchor for both halves of the feature: the CPU fit here
// and the uniform array sizes in render/shaders/shadow.glsl.js, which imports MAX_CASCADES from
// this file so the two can never disagree.

import { clamp, mat4, vec3, m4identity, m4lookAt, m4mul, m4ortho } from '../core/math.js';
import { BLEND_ALPHA, IDENTITY, numOr } from './util.js';

// Cascaded shadow maps: the shader declares arrays of this size and loops over uCsmCount.
//
// FOUR, not three. Every cascade is fitted to the bounding sphere of its frustum slice and then
// snapped to its own texel grid, which makes one shadow texel almost exactly one screen pixel at
// the FAR edge of that slice, whatever the split — the interesting number is therefore not the
// texel size but the RATIO between consecutive splits, because that is how many pixels a texel
// covers at the NEAR edge, where a cascade is at its worst. Over a fixed reach, n cascades give
// a best-case ratio of (reach / firstSplit)^(1/(n-1)):
//
//     reach 2,860 m, first split 157 m      3 cascades -> 4.3x      4 cascades -> 2.6x
//
// On a 3 km map the far cascade only had to reach 2.4 km and three tiles did it at 4.1x. At the
// new sight lines three tiles cost either a soft mid-field or a near cascade coarser than the one
// the build already ships, and neither is acceptable — so the atlas grows a tile instead. It is
// 8192 x 2048 of DEPTH_COMPONENT24 (67 MB, against 50), _ensureShadowTargets already lays out
// any count over any number of rows, and the shader was already written as a loop to MAX_CASCADES
// with no unrolled special case. Measured cost of the fourth pass: see _fitCascades.
export const MAX_CASCADES = 4;
// --- cascade splits -------------------------------------------------------------------------
// The classic practical split (Zhang et al.) interpolates a logarithmic series with a uniform
// one, and its logarithmic half is anchored at the camera NEAR plane. That anchor is what breaks
// here: main.js drives the near plane from measured clearance and it sits at 0.30-1.60 m, so the
// log series starts at a distance nothing is ever drawn at, and the uniform half — which is a
// terrible split — ends up carrying the result. Fitting from a STREET anchor instead is the
// standard remedy and it is what these numbers are:
//
//   cascade 0 ends at CSM_SPLIT0 metres — an ABSOLUTE distance, not a fraction of the reach;
//   every split after it is GEOMETRIC from there to the reach, which is the series that minimises
//   the worst ratio, i.e. the softest texel-to-pixel figure anywhere in the frame.
//
// ABSOLUTE, and this is the correction the expansion forced. Because every cascade is fitted to
// the bounding sphere of its own slice, its texel-to-pixel ratio at the slice's FAR edge is a
// constant — 0.910 at 1440x900, fov 1.05, 2048 tiles — whatever the split. So the split does not
// buy sharpness at the far edge of the cascade; it buys it in ABSOLUTE METRES near the camera,
// which is where a pedestrian actually looks. A fraction of the reach makes that number a
// function of the time of day, because DAY_SHADOW_DISTANCE buys daylight a longer reach.
//
// The three rules, cascade far distance / world metres per texel, worst ratio between splits:
//
//   3 cascades, practical split lambda 0.76 (what the pre-expansion build shipped)
//     blue, reach 1250   108/0.127   288/0.320   1250/1.414                        4.34
//     day,  reach 2375   200/0.235   515/0.571   2375/2.692                        4.61
//   4 cascades, first split at 5.5% of the reach
//     blue, reach 2200   121/0.142   318/0.353    837/0.928   2200/2.441           2.63
//     day,  reach 2860   157/0.184   414/0.459   1088/1.207   2860/3.173           2.63
//   4 cascades, first split pinned at 110 m — THIS
//     blue, reach 2200   110/0.129   299/0.332    810/0.900   2200/2.444           2.71
//     day,  reach 2860   110/0.129   326/0.363    965/1.077   2860/3.189           2.96
//
// Read the near column: the fraction rule made the shadow under a parked car 30% coarser at three
// in the afternoon than at dusk, for no reason a player could name, and the shipped three-cascade
// rule made it 85% coarser. Pinning the anchor holds 0.129 m per texel at every preset and every
// reach — better than all four of those — and pays 2.71 -> 2.96 for it in the worst ratio, which
// is the texel-per-pixel figure at the near edge of the softest cascade and is nowhere anyone is
// looking. (The numbers above are the fit itself, read back from renderer.shadowStats.)
//
// 110 m is a Toronto block face — King to Adelaide is 110 m, Adelaide to Richmond 112. Below it
// cascade 1 starts across the street you are standing on; above it cascade 0's texels start to
// show at arm's length. The bracket exists only so a pathological `distance` cannot order the
// first split past the last one.
export const CSM_SPLIT0 = 110;
export const CSM_SPLIT_MIN = 40;
export const CSM_SPLIT_MAX = 260;

// --- daylight -------------------------------------------------------------------------------
// Both of these are exactly 1x at env.daylight 0, so blue hour and night are untouched by the
// daylight model. render/env.js owns the switch itself.
// Shadow strength: 0.74 is a blue-hour figure, where the "shadow" is one part of the sky being
// occluded by another and a hard black would be wrong. Under a real sun an occluded surface loses
// the sun ENTIRELY and keeps only the sky fill, so the direct term has to go to nearly nothing —
// this is what turns a 1-luma difference into the measured 3-5x sun/shade ratio.
export const DAY_SHADOW_STRENGTH = 1.0;
// Cascade reach, as a multiple of shadow.distance. The blue-hour key is a low raking skylight and
// a street-level walk needs far less of it than a skyline shot does, so daylight buys extra reach
// and blue hour keeps a shorter, denser set. Exactly 1x at daylight 0.
//
// The base is now 2,200 m (was 1,250) and the multiplier 1.30 (was 1.9), i.e. 2,860 m of daylight
// reach against 2,375. Two things forced it. The extract is 6.8 x 6.5 km, so the Financial
// District now stands 2.0-2.7 km off the start viewpoint rather than 1.2-1.9, and at the old
// reach the whole core sat past uShadowFar and faded to unshadowed. And main.js sizes its caster
// query as shadow.distance + 1.5 tiles, so the reach and the caster radius have to move together
// or the far cascade covers ground no caster was submitted for.
//
// MEASURED at the start viewpoint, 1440x900, Ultra, four cascades: 1,250 m -> 11.2 ms / 165
// shadow draws; 1,900 -> 11.7 / 249; 2,600 -> 12.4 / 315; 3,400 -> 12.9 / 411. The cost is in
// the caster count, not the cascade count, and it is close to linear at 5.7 us per draw. 2,200
// buys the core for about 0.7 ms of a 16.7 ms budget.
export const DAY_SHADOW_DISTANCE = 1.30;

// Module-scope scratch — the hot paths must not allocate. Every one of these is written and
// read inside a single call and carries nothing between calls.
const _tmpA = new Float32Array(3);
const _tmpB = new Float32Array(3);
const _tmpC = new Float32Array(3);
const _csmMat = new Float32Array(MAX_CASCADES * 16);
const _csmTile = new Float32Array(MAX_CASCADES * 4);
const _csmParam = new Float32Array(MAX_CASCADES * 4);
const _shadowTexel = new Float32Array(2);
const _shadowBias = new Float32Array(2);
const _lightEye = vec3();
const _lightTarget = vec3();
const _lightUp = vec3(0, 1, 0);
const _mLightView = mat4();
const _mLightProj = mat4();
const _mLightVP = mat4();
const _mTile = mat4();

// Views into the packed cascade uniform arrays, so the fit runs without allocating. Sized from
// MAX_CASCADES rather than written out, because the cascade count is a tuning decision and a
// hand-unrolled list of three is exactly the kind of thing that survives a change to it.
const _csmMatView = [];
const _csmLightVP = [];
for (let i = 0; i < MAX_CASCADES; i++) {
  _csmMatView.push(_csmMat.subarray(i * 16, i * 16 + 16));
  _csmLightVP.push(mat4());
}

/* ------------------------------------------------------------ cascade fit */

// Mixed into Renderer.prototype by renderer.js. The atlas, the caster lists and shadowStats
// all live on the Renderer, so a Renderer owns its own cascades.
export const ShadowMethods = {
  // A 2x2 depth texture with comparison filtering, bound to uShadowMap whenever the real atlas
  // does not exist. Sampling never happens (uCsmCount is 0), but leaving a shadow sampler
  // pointing at an incomplete texture makes some drivers noisy, and this costs 16 bytes.
  _makeDummyShadow() {
    const gl = this.gl;
    try {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 2, 2, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._dummyShadow = tex;
    } catch (err) {
      this._dummyShadow = null;
    }
  },

  _forgetShadowTargets() {
    const s = this._shadowState;
    s.ready = false; s.sig = ''; s.tex = null; s.fbo = null;
    s.size = 0; s.count = 0; s.atlasW = 0; s.atlasH = 0;
    s.tiles = null;
  },

  _destroyShadowTargets() {
    const gl = this.gl;
    const s = this._shadowState;
    if (!s.tex && !s.fbo) { this._forgetShadowTargets(); return; }
    if (!this.contextLost) {
      try {
        if (s.fbo) gl.deleteFramebuffer(s.fbo);
        if (s.tex) gl.deleteTexture(s.tex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (err) {
        // See _destroyTargets.
      }
    }
    this._forgetShadowTargets();
  },

  // The cascade atlas: one depth texture holding `count` square tiles. A single texture and a
  // single sampler keeps the fragment shader to one lookup path, and a single clear per frame.
  _ensureShadowTargets() {
    if (this.contextLost || !this._shadowSupported || !this.csmShader) return false;
    const q = this._q;
    if (q.shadows === 'off') { this._destroyShadowTargets(); return false; }

    const gl = this.gl;
    const low = q.shadows === 'low';
    const count = low ? 1 : MAX_CASCADES;
    let size = low ? 1024 : 2048;
    const s = this._shadowState;
    const sig = count + '@' + size;
    if (s.ready && s.sig === sig) return true;

    this._destroyShadowTargets();
    try {
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
      // Prefer one row of tiles; fall back to a 2-wide grid, then to smaller tiles.
      let cols = count, rows = 1;
      while (size >= 256) {
        cols = count; rows = 1;
        if (cols * size > maxTex) { cols = Math.min(count, 2); rows = Math.ceil(count / cols); }
        if (cols * size <= maxTex && rows * size <= maxTex) break;
        size >>= 1;
      }
      if (size < 256) throw new Error('MAX_TEXTURE_SIZE is too small for a shadow atlas');

      const atlasW = cols * size;
      const atlasH = rows * size;
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, atlasW, atlasH, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      // LINEAR + COMPARE_REF_TO_TEXTURE is hardware PCF: each of the 9 taps below is itself a
      // bilinear 2x2 comparison, so the 3x3 kernel filters a 4x4 footprint for the price of 9.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      // Depth only: no colour attachment, so nothing may be written to one.
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        throw new Error('the shadow framebuffer is incomplete');
      }

      const tiles = [];
      for (let i = 0; i < count; i++) {
        const cx = i % cols;
        const cy = (i / cols) | 0;
        tiles.push({
          px: cx * size, py: cy * size,
          u: (cx * size) / atlasW, v: (cy * size) / atlasH,
          su: size / atlasW, sv: size / atlasH,
        });
      }

      s.tex = tex;
      s.fbo = fbo;
      s.size = size;
      s.count = count;
      s.atlasW = atlasW;
      s.atlasH = atlasH;
      s.tiles = tiles;
      s.sig = sig;
      s.ready = true;
      return true;
    } catch (err) {
      this._destroyShadowTargets();
      this._shadowSupported = false;
      this._fail('shadows', 'shadow map setup failed', err);
      this._resolveQuality();
      return false;
    }
  },

  // Register the meshes that cast shadows, once, at load time:
  //   renderer.setShadowCasters([city.meshes.buildings, city.meshes.terrain, city.meshes.props]);
  // Accepts a Mesh, an array of Meshes, or an array of { mesh, model } pairs. Pass null to go
  // back to the automatic list (whatever was drawn opaque last frame).
  setShadowCasters(list) {
    if (list === null || list === undefined) {
      this._casters = null;
      this._castersSrc = null;
      return this;
    }
    // Re-normalising the same array every frame would allocate for nothing.
    if (list === this._castersSrc && this._casters) return this;
    const out = [];
    const push = (m) => {
      if (!m) return;
      if (m.mesh) out.push({ mesh: m.mesh, model: m.model || null });
      else if (m.vao || typeof m.draw === 'function') out.push({ mesh: m, model: null });
    };
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) push(list[i]);
    } else {
      push(list);
    }
    this._casters = out;
    this._castersSrc = list;
    return this;
  },

  // Remember an opaque draw so the NEXT frame's shadow pass can cast from it. One frame of lag
  // on a static city is invisible, and it means shadows work with no wiring at all.
  _rememberCaster(mesh, model) {
    const cap = this._autoB;
    if (cap.n >= 24 || !mesh || (mesh.vertexCount | 0) <= 0) return;
    let e = cap.list[cap.n];
    if (!e) {
      e = { mesh: null, model: mat4() };
      cap.list.push(e);
    }
    e.mesh = mesh;
    if (model) {
      const m = e.model;
      for (let i = 0; i < 16; i++) m[i] = model[i];
      e.hasModel = true;
    } else {
      e.hasModel = false;
    }
    cap.n++;
  },

  // Fit one orthographic projection per cascade to a bounding SPHERE of the camera frustum
  // slice. The sphere is what makes the fit rotation-invariant: a box fit changes size as the
  // camera turns, and the shadow edges crawl. With the sphere, the only movement left is
  // sub-texel translation, which the snap below removes entirely.
  _fitCascades(cam) {
    const s = this._shadowState;
    const cfg = this.shadow;
    const n = s.count;
    const size = s.size;
    const near = Math.max(Number.isFinite(cam.near) ? cam.near : 1.0, 1.0);
    const camFar = Number.isFinite(cam.far) ? cam.far : 18600;
    // The 'low' preset has ONE 1024 tile to cover the whole range, so it covers less range or its
    // texels turn to mush: at 20% of a 2,200 m reach they are ~1.0 m, the same figure the single
    // cascade landed on before the reach grew, which is still a readable building shadow on a
    // street. (It was 35% of 1,250 m; the fraction moved so the metres did not.)
    // Daylight buys extra reach (DAY_SHADOW_DISTANCE) so the skyline from the harbour is inside
    // the cascades instead of past their fade. Exactly 1x at daylight 0 — blue hour is unchanged.
    const reach = numOr(cfg.distance, 50, 8000, 2200) * (n === 1 ? 0.20 : 1)
      * (1 + (DAY_SHADOW_DISTANCE - 1) * this._daylight());
    const far = Math.max(near + 20, Math.min(reach, camFar));
    const extrude = numOr(cfg.extrude, 10, 4000, 900);
    const blend = numOr(cfg.blend, 0.02, 0.5, 0.16);
    // Street-anchored geometric splits — see the CSM_SPLIT_* block. The anchor is an absolute
    // distance, held below 90% of the reach as well as inside its own bracket, so a pathological
    // `distance` can never order the first split past the last one and hand m4ortho an inverted
    // box.
    const split0 = Math.min(
      far * 0.9,
      clamp(numOr(cfg.split0, 5, 4000, CSM_SPLIT0),
        numOr(cfg.splitMin, 5, 4000, CSM_SPLIT_MIN),
        numOr(cfg.splitMax, 5, 4000, CSM_SPLIT_MAX))
    );
    // Ratio between consecutive splits once the first one is placed. n === 1 never reads it.
    const ratio = n > 1 ? Math.pow(far / Math.max(split0, 1e-3), 1 / (n - 1)) : 1;

    const fov = clamp(Number.isFinite(cam.fov) ? cam.fov : 1.05, 0.15, 2.6);
    const aspect = Number.isFinite(cam.aspect) && Math.abs(cam.aspect) > 1e-4 ? cam.aspect : 1.6;
    const tanHalf = Math.tan(fov * 0.5);

    const f = cam.forward(_tmpA);
    const r = cam.right(_tmpB);
    // True up = right x forward (the camera's own up, not the world's).
    _tmpC[0] = r[1] * f[2] - r[2] * f[1];
    _tmpC[1] = r[2] * f[0] - r[0] * f[2];
    _tmpC[2] = r[0] * f[1] - r[1] * f[0];

    const key = this._normalizedKey();
    // A light pointing straight up would collapse the look-at basis.
    if (Math.abs(key[1]) > 0.985) { _lightUp[0] = 0; _lightUp[1] = 0; _lightUp[2] = 1; }
    else { _lightUp[0] = 0; _lightUp[1] = 1; _lightUp[2] = 0; }

    let sliceNear = near;
    let worstRatio = 0;
    for (let i = 0; i < n; i++) {
      // Cascade 0 takes the street anchor; everything after it is geometric out to the reach;
      // the last one IS the reach, exactly, so uShadowFar and the last split never disagree.
      const sliceFar = (i === n - 1) ? far : split0 * Math.pow(ratio, i);
      if (i > 0 && sliceNear > 1e-3) {
        const r = sliceFar / sliceNear;
        if (r > worstRatio) worstRatio = r;
      }

      const hf = tanHalf * sliceFar;
      const wf = hf * aspect;
      const k = (sliceFar - sliceNear) * 0.5;
      let radius = Math.sqrt(k * k + hf * hf + wf * wf);
      if (!(radius > 0.5)) radius = 0.5;
      const mid = (sliceNear + sliceFar) * 0.5;

      const cx = cam.pos[0] + f[0] * mid;
      const cy = cam.pos[1] + f[1] * mid;
      const cz = cam.pos[2] + f[2] * mid;
      _lightTarget[0] = cx; _lightTarget[1] = cy; _lightTarget[2] = cz;
      const back = radius + extrude;
      _lightEye[0] = cx + key[0] * back;
      _lightEye[1] = cy + key[1] * back;
      _lightEye[2] = cz + key[2] * back;

      const depthRange = 2 * radius + 2 * extrude;
      m4lookAt(_mLightView, _lightEye, _lightTarget, _lightUp);
      m4ortho(_mLightProj, -radius, radius, -radius, radius, 0, depthRange);
      m4mul(_mLightVP, _mLightProj, _mLightView);

      // --- texel snap ---------------------------------------------------------
      // Column 3 of the combined matrix IS the projection of the world origin (w = 1 for an
      // orthographic projection), so rounding it to a whole texel and shifting the clip-space
      // translation by the remainder pins the whole light grid to fixed world texel boundaries.
      // Without this the shadows swim as the camera walks.
      const half = size * 0.5;
      const sx = _mLightVP[12] * half;
      const sy = _mLightVP[13] * half;
      _mLightVP[12] += (Math.round(sx) - sx) / half;
      _mLightVP[13] += (Math.round(sy) - sy) / half;

      const lvp = _csmLightVP[i];
      for (let j = 0; j < 16; j++) lvp[j] = _mLightVP[j];

      // --- bias + atlas tile, folded into the matrix the fragment shader uses ---
      const tile = s.tiles[i];
      m4identity(_mTile);
      _mTile[0] = 0.5 * tile.su;
      _mTile[5] = 0.5 * tile.sv;
      _mTile[10] = 0.5;
      _mTile[12] = tile.u + 0.5 * tile.su;
      _mTile[13] = tile.v + 0.5 * tile.sv;
      _mTile[14] = 0.5;
      m4mul(_csmMatView[i], _mTile, _mLightVP);

      const o = i * 4;
      _csmTile[o] = tile.u; _csmTile[o + 1] = tile.v;
      _csmTile[o + 2] = tile.su; _csmTile[o + 3] = tile.sv;
      _csmParam[o] = (2 * radius) / size;              // world size of one shadow texel
      _csmParam[o + 1] = 1 / depthRange;               // world metres -> [0,1] depth units
      _csmParam[o + 2] = sliceFar;
      _csmParam[o + 3] = sliceFar - (sliceFar - sliceNear) * blend;

      // Reported, not just fitted: `renderer.shadowStats` is what makes a claim about cascade
      // coverage checkable from the console instead of derived on paper from constants that have
      // since moved. Rewritten in place every frame, never reallocated.
      const st = this.shadowStats;
      st.split[i] = sliceFar;
      st.texel[i] = _csmParam[o];
      st.radius[i] = radius;

      sliceNear = sliceFar;
    }
    {
      const st = this.shadowStats;
      st.count = n;
      st.reach = far;
      st.worstRatio = worstRatio;
      for (let i = n; i < MAX_CASCADES; i++) {
        st.split[i] = 0; st.texel[i] = 0; st.radius[i] = 0;
      }
    }

    // Unused cascade slots still get sane values: the shader loops over uCsmCount, but a NaN in
    // an unset uniform slot is exactly the kind of thing that shows up as a black screen on one
    // driver and nothing on another.
    for (let i = n; i < MAX_CASCADES; i++) {
      m4identity(_csmMatView[i]);
      const o = i * 4;
      _csmTile[o] = 0; _csmTile[o + 1] = 0; _csmTile[o + 2] = 1; _csmTile[o + 3] = 1;
      _csmParam[o] = 1; _csmParam[o + 1] = 1; _csmParam[o + 2] = far; _csmParam[o + 3] = far;
    }

    _shadowTexel[0] = 1 / Math.max(1, s.atlasW);
    _shadowTexel[1] = 1 / Math.max(1, s.atlasH);
    _shadowBias[0] = numOr(cfg.constBias, 0, 2, 0.035);
    _shadowBias[1] = numOr(cfg.slopeBias, 0, 8, 0.22);
    this._shadowFar = far;
    this._csmCount = n;
  },

  // Depth-only pass over every caster, once per cascade. Called automatically from beginFrame;
  // call it yourself first if you would rather control the ordering.
  shadowPass(casters, camera) {
    if (this.contextLost) return false;
    if (camera) this.camera = camera;
    const cam = this.camera;
    this._resolveQuality();
    this._csmCount = 0;
    if (this._q.shadows === 'off' || !cam) return false;
    if (!this._ensureShadowTargets()) return false;

    // Resolve the caster list: explicit > argument > whatever was drawn opaque last frame.
    let list = null;
    let count = 0;
    if (casters) {
      this.setShadowCasters(casters);
      list = this._casters;
      count = list ? list.length : 0;
    } else if (this._casters) {
      list = this._casters;
      count = list.length;
    } else {
      list = this._autoA.list;
      count = this._autoA.n;
    }
    if (!list || count === 0) return false;

    this._fitCascades(cam);

    const gl = this.gl;
    const s = this._shadowState;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(0, 0, s.atlasW, s.atlasH);
    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setBlend(false, BLEND_ALPHA);
    this._setCull(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // A small positive polygon offset on top of the normal-offset bias. Depth-only passes are
    // the one place this is nearly free.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3.0);
    this._polyOffset = false;

    const sh = this._useShader(this.csmShader);
    for (let ci = 0; ci < s.count; ci++) {
      const tile = s.tiles[ci];
      gl.viewport(tile.px, tile.py, s.size, s.size);
      sh.set('uLightViewProj', _csmLightVP[ci]);
      for (let i = 0; i < count; i++) {
        const e = list[i];
        if (!e) continue;
        const mesh = e.mesh;
        if (!mesh || (mesh.vertexCount | 0) <= 0) continue;
        sh.set('uModel', (e.hasModel === false ? null : e.model) || IDENTITY);
        this._drawGeom(mesh);
        this.stats.shadowDraws++;
      }
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    this._polyOffset = false;

    // Put the frame's own framebuffer back if we were called mid-frame.
    if (this._frameActive) {
      if (this._frameOffscreen && this._post.scene) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._post.scene.fbo);
        gl.viewport(0, 0, this._post.w, this._post.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
      }
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this._shadowDone = true;
    return true;
  },

  // Cascade uniforms, shared by the scene and water programs.
  _setShadowUniforms(s) {
    const on = this._csmCount > 0 && this._shadowState.ready;
    s.set('uCsmCount', on ? this._csmCount : 0);
    s.setTexture('uShadowMap', 0, on ? this._shadowState.tex : this._dummyShadow);
    if (!on) {
      s.set('uShadowStrength', 0);
      return;
    }
    s.set('uCsmMat', _csmMat);
    s.set('uCsmTile', _csmTile);
    s.set('uCsmParam', _csmParam);
    s.set('uShadowTexel', _shadowTexel);
    s.set('uShadowBias', _shadowBias);
    const base = numOr(this.shadow.strength, 0, 1, 0.74);
    s.set('uShadowStrength', base + (DAY_SHADOW_STRENGTH - base) * this._daylight());
    s.set('uShadowFar', this._shadowFar || 2200);
    s.set('uShadowNormalOffset', numOr(this.shadow.normalOffset, 0, 8, 1.6));
  },
};

/* -------------------------------------------------------------- defaults -- */

// The dials a caller may move, and the state the fit writes back. Both live on the Renderer;
// this is only where their defaults are written down.
export function defaultShadowSettings() {
  return {
    distance: 2200,     // metres of camera frustum covered by the cascades
    // Where the first split lands, in metres, and the bracket it is held in. Defaults are the
    // CSM_SPLIT_* constants; overriding them here is the one knob that trades near sharpness
    // against mid-field sharpness without touching the reach.
    split0: CSM_SPLIT0,
    splitMin: CSM_SPLIT_MIN,
    splitMax: CSM_SPLIT_MAX,
    strength: 0.74,     // 1 = fully black shadow (before ambient fills it back in)
    normalOffset: 1.6,  // in shadow texels
    constBias: 0.035,   // metres
    slopeBias: 0.22,    // metres per unit slope
    extrude: 900,       // metres of caster head-room above each cascade (the CN Tower is 553 m)
    blend: 0.16,        // fraction of each cascade blended into the next
  };
}

// What _fitCascades actually landed on this frame: the far distance of each cascade, the world
// size of one of its shadow texels, the radius of the sphere it was fitted to, and the worst
// texel-per-pixel step between consecutive cascades. Read it, do not write it.
export function makeShadowStats() {
  return {
    count: 0, reach: 0, worstRatio: 0,
    split: new Float64Array(MAX_CASCADES),
    texel: new Float64Array(MAX_CASCADES),
    radius: new Float64Array(MAX_CASCADES),
  };
}

// The cascade atlas and its layout, filled in by _ensureShadowTargets.
export function makeShadowState() {
  return {
    ready: false, sig: '', size: 0, count: 0, atlasW: 0, atlasH: 0,
    tex: null, fbo: null, tiles: null,
  };
}
