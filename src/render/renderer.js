// src/render/renderer.js — the TORONTO renderer: frame orchestration, the draw API, and all
// WebGL state tracking.
//
// WHERE EVERYTHING LIVES. The Renderer is one object with one lifetime, but its responsibilities
// are not one file. Each subsystem owns a module and hands its methods back to be installed on
// Renderer.prototype at the bottom of this file (see render/util.js mixin), so they are ordinary
// methods on an ordinary object and `this` means what it always did:
//
//   render/camera.js     the Camera, re-exported below
//   render/programs.js   every GLSL program, built once, each optional one degrading on its own
//   render/env.js        the lighting environment and every uniform derived from it
//   render/uniforms.js   the once-per-frame uniform block for each geometry program
//   render/targets.js    the offscreen render targets
//   render/shadows.js    cascaded shadow maps: atlas, cascade fit, depth pass
//   render/lights.js     the clustered local-light rig
//   render/ssao.js  render/ssr.js  render/bloom.js      the post passes
//   render/font.js  render/text.js                      the glyph atlas and world text
//   render/shaders/*.glsl.js                            the GLSL itself
//
// What is left here: construction and context loss, the quality resolve, the tracked GL state,
// beginFrame / endFrame, the draw calls, and the order the post chain runs in.
//
// ART DIRECTION (CONTRACT §0) — "blue-hour massing model". ~20:45 in June: the sun is BELOW the
// horizon, so there is no sun disc and almost no warm direct light. The image is carried by
//   1. accurate massing lit by a low raking skylight/moon key + cascaded shadows,
//   2. towers lit FROM WITHIN, per BUILDING TYPE — offices, condos, shopfronts, parking decks
//      and heritage stone all light differently, and envelopes (stadium domes, arenas, concert
//      halls, the CN Tower) have no window grid at all,
//   3. facade COLOUR revealed by directional sky irradiance — at blue hour the sky is the only
//      light there is, and it is what makes gold read gold and Mies' black read black,
//   4. wet streets and a glassy lake reflecting the skyline via screen-space reflections,
//   5. a deep cyan-to-indigo sky grading warm orange at the WNW horizon where the sun just set.
//
// VERTEX FORMAT (14 floats, defined once in core/vertex.js): [px,py,pz, nx,ny,nz, r,g,b, emissive, tintable, rough,
// profile, uv]. `aMat` is a **vec4** at attribute location 3 — (emissive, tintable, rough,
// profile). The profile is an OSM-derived lighting class carried per building by
// data/toronto.json:
//   0 envelope (NO windows) · 1 office · 2 residential · 3 retail · 4 parking · 5 civic
//   6 GLYPH — a quad of text in the world (render/text.js), drawn by the text pass below
// It travels to the fragment stage FLAT, never interpolated: it is an enum, not a quantity.
// `aUv` at location 4 is one float carrying a packed [0,1]^2 texture coordinate; only the text
// pass reads it, and core/vertex.js owns both halves of the encoding (packUv / GLSL_UV).
//
// Rendering model: forward, single geometry pass with MRT.
//   COLOR_ATTACHMENT0  RGBA16F (or RGBA8 range-compressed)  linear HDR radiance
//   COLOR_ATTACHMENT1  RGBA8                                oct(N).xy, roughness, ambient share
//   DEPTH_ATTACHMENT   DEPTH_COMPONENT24 TEXTURE            read by SSAO / SSR
// Post then runs: SSAO -> bilateral blur -> SSR -> resolve (applies AO to AMBIENT ONLY, swaps the
// analytic sky reflection for the screen-space one) -> bloom chain + anamorphic streak ->
// composite (filmic grade, split tone, chromatic aberration, grain, dither).
//
// The "ambient share" channel is what makes AO ambient-only without a deferred renderer or a depth
// pre-pass: the scene shader records what fraction of the pixel's luminance came from ambient, and
// the resolve pass multiplies by `1 - share * (1 - ao)`. Direct light and emissive windows are
// never touched by AO, which is the whole point — a lit window inside an alley must not go grey.
//
// LOCAL LIGHTS. Every street lamp in the city is a real punctual light, not merely an emissive
// lens: a clustered forward rig over a world-space uniform grid, culled and ranked per frame,
// bounded per FRAGMENT by the cluster's slot count rather than by how many lamps the city has.
// Register them once with `renderer.setLights(list)` — see that method — and the renderer owns
// culling, ranking, clustering, the per-frame cap and the time-of-day gate from there. Registering
// nothing renders exactly as this file did before the rig existed. See render/lights.js for why
// the clusters are world-space and 2-D, and render/shaders/lights.glsl.js for the shading.
//
// EVERY feature degrades independently and NONE of them may block boot:
//   renderer.quality = { shadows: 'off'|'low'|'high', ssao, ssr, bloom, clouds, fxaa, lights }
// plus the original three-tier bloom fallback (float target -> RGBA8 target -> straight to the
// screen, graded in-shader). Anything that fails at setup latches itself off with one warning.
//
// `uOutputMode` is still the switch for where the geometry pass writes:
//   0 = straight to the screen, graded here      (no offscreen pass at all)
//   1 = float offscreen target, linear light out (EXT_color_buffer_float / _half_float)
//   2 = 8-bit offscreen target, range-compressed (RGBA8 fallback, less headroom)
//
// Draw order expected by app/main.js (shadow casters are picked up automatically — see
// setShadowCasters / beginFrame):
//   renderer.beginFrame(camera)      -> cascade fit + depth passes, binds the HDR target,
//                                       clears, draws the sky
//   renderer.drawMesh(city.meshes.terrain, IDENTITY)
//   renderer.drawMesh(city.meshes.buildings, IDENTITY)   ... roads, sidewalks, rails, props, glass
//   renderer.drawWater(city.meshes.water, camera)
//   renderer.drawText(city.meshes.signs, IDENTITY)       LAST of the geometry: a blended decal
//                                       pass that never writes depth and never casts a shadow
//   renderer.endFrame()              -> SSAO, SSR, resolve, bloom, composite
//
// World axes: X = east, Y = up, Z = south. Right-handed. TRUE METRES.

import { clamp } from '../core/math.js';
import {
  BLEND_ALPHA, BLEND_MULTIPLY, IDENTITY, WHITE, errText, numOr, boolOr, mixin,
} from './util.js';
import { defaultEnv, defaultDayIndirect, defaultRoad, EnvMethods } from './env.js';
import { ProgramMethods } from './programs.js';
import { TargetMethods, makePostTargets } from './targets.js';
import { UniformMethods, defaultTextSettings } from './uniforms.js';
import { BloomMethods } from './bloom.js';
import { PostMethods, defaultPostSettings } from './post.js';
import {
  ShadowMethods, defaultShadowSettings, makeShadowStats, makeShadowState,
} from './shadows.js';
import {
  LightMethods, defaultLightSettings, makeLightStats, makeLightStore,
} from './lights.js';
import { SsaoMethods, defaultSsaoSettings } from './ssao.js';
import { SsrMethods, defaultSsrSettings } from './ssr.js';
import { forgetFont, releaseFont } from './font.js';

// The camera moved to its own file; re-exported here so a caller can still take the pair from
// one place.
export { Camera } from './camera.js';

/* ----------------------------------------------------------------- constants */

// Module-scope scratch — the hot paths must not allocate. Every one of these is written and read
// inside a single call and carries nothing between calls.
const _tint = new Float32Array(3);
const _sun = new Float32Array(3);
const _key = new Float32Array(3);

/* -------------------------------------------------------------------- renderer */

export class Renderer {
  constructor(gl) {
    this.gl = gl;
    this.width = gl.drawingBufferWidth || 1;
    this.height = gl.drawingBufferHeight || 1;
    this.camera = null;
    this.contextLost = false;
    // Set when a context loss could not be recovered from and only a page reload will do.
    this.needsReload = false;

    this.stats = {
      draws: 0, tris: 0, programSwaps: 0, vaoBinds: 0, postPasses: 0, shadowDraws: 0,
    };

    // CONTRACT §3.2. Every one of these is independently switchable at runtime from the console
    // (`G.renderer.quality.ssr = false`) and every one degrades to "off" on its own if the GPU
    // cannot provide it. None of them can block boot.
    this.quality = {
      shadows: 'high',   // 'off' | 'low' (1 x 1024) | 'high' (3 x 2048)
      ssao: true,
      ssr: true,
      bloom: true,
      clouds: true,
      fxaa: true,        // the only AA there is once the frame renders offscreen
      lights: true,      // the clustered local-light rig (street lamps)
    };

    // Tunable live: `G.renderer.bloom.intensity = 1.4`.
    this.bloom = { enabled: true, threshold: 0.72, intensity: 0.85, radius: 1.0 };

    // THE SUBSYSTEM DIALS. Every one of these is a live, writable object on the renderer, exactly
    // as it always was — `G.renderer.ssr.steps = 24` still works. What moved is where their
    // DEFAULTS are written down: each now sits in the module that reads it, so adding a knob is a
    // one-file change and the number is documented beside the code that consumes it.
    this.shadow = defaultShadowSettings();       // render/shadows.js
    this.ssao = defaultSsaoSettings();           // render/ssao.js
    this.ssr = defaultSsrSettings();             // render/ssr.js
    this.post = defaultPostSettings();           // render/post.js
    this.text = defaultTextSettings();           // render/uniforms.js
    this.dayIndirect = defaultDayIndirect();     // render/env.js
    this.road = defaultRoad();                   // render/env.js
    this.lights = defaultLightSettings();        // render/lights.js

    // Read these, do not write them: what each rig actually did on the last frame.
    this.lightStats = makeLightStats();
    this.shadowStats = makeShadowStats();

    // Feature latches. Each one flips to false the first time its setup fails, so a broken
    // driver costs one warning for the session, not one per frame.
    this._postSupported = true;      // any offscreen target at all
    this._bloomSupported = true;
    this._textSupported = true;
    this._ssaoSupported = true;
    this._ssrSupported = true;
    this._fxaaSupported = true;
    this._lightsSupported = true;
    this._shadowSupported = true;
    this._depthTexSupported = true;  // depth attachment as a sampleable TEXTURE
    this._mrtSupported = true;       // second colour attachment (normal / roughness / ambient)
    this._floatProbed = false;
    this._float = false;
    this._warned = {};

    // The GPU-side state each subsystem owns. Created here so a Renderer owns its own targets,
    // tables and atlas and two of them can never share one; the shape of each is documented in
    // the module that fills it in.
    this._post = makePostTargets();              // render/targets.js
    this._lights = makeLightStore();             // render/lights.js
    this._lights.cmp = (a, b) => this._lights.score[b] - this._lights.score[a];
    this._shadowState = makeShadowState();       // render/shadows.js
    this._shadowFar = 2200;
    this._dummyShadow = null;

    // Latched at beginFrame so flipping quality mid-frame can never strand the scene in an
    // offscreen target that endFrame then refuses to composite.
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    this._csmCount = 0;
    this._shadowDone = false;

    // Shadow casters. Explicit ones win; otherwise the renderer remembers what was drawn opaque
    // last frame and casts from that, so shadows work even if main.js never registers anything.
    this._casters = null;
    this._castersSrc = null;
    this._autoA = { list: [], n: 0 };
    this._autoB = { list: [], n: 0 };

    // Modules that own geometry subscribe here to re-upload it after a context loss.
    this._restoreHandlers = [];

    // The lighting environment. Blue hour by default; the caller swaps it per time-of-day
    // preset. Every field, and the model each one drives, is documented in render/env.js.
    this.env = defaultEnv();

    // Tracked GL state — every setter below is a no-op when nothing actually changed.
    this._shader = null;
    this._vao = null;
    this._blend = false;
    this._blendMode = 0;
    this._depthTest = false;
    this._depthWrite = false;
    this._cull = false;
    this._polyOffset = false;

    // Cached scalar uniforms (uniform values are per-program GL state, so these survive program
    // switches and only need invalidating when the programs are (re)created).
    this._tr = -1; this._tg = -1; this._tb = -1;
    this._flash = -1;
    this._alpha = -1;
    this._shadowAlpha = -1;

    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;

    this._q = {
      shadows: 'off', ssao: false, ssr: false, bloom: false, clouds: false, fxaa: false,
      lights: false,
    };

    this._createGpuResources();

    // --- context loss: fail quiet, log exactly once per event ---------------
    const canvas = gl.canvas;
    this._canvas = canvas;
    this._onLost = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (this.contextLost) return;
      this.contextLost = true;
      console.warn('[render] WebGL context lost — rendering paused until it is restored.');
    };
    this._onRestored = () => {
      if (!this.contextLost) return;
      try {
        // The old framebuffers/textures belong to the DEAD context. Deleting them through the
        // fresh one is invalid, so drop the handles instead of calling gl.delete*.
        this._forgetTargets();
        this._forgetShadowTargets();
        this._dummyShadow = null;
        // The glyph atlas is a texture in the DEAD context. Forget the handle rather than
        // deleting it — deleting through the fresh context is invalid — so _createGpuResources
        // below rasterises a new one.
        forgetFont(gl);
        // Extension objects are per-context too: without asking again, RGBA16F is not colour
        // renderable on the new context and the post chain would silently drop to 8-bit.
        this._floatProbed = false;
        this._float = false;
        this._createGpuResources();
        this._resetStateCache();
      } catch (err) {
        this._reportUnrecoverableLoss('the renderer could not rebuild its shaders', err);
        return;
      }

      // Renderer-owned GPU state is back — but a context loss takes EVERY GL object in the
      // process with it, and every Mesh in the world lives in another module's VBO. Only their
      // owners can put those back, which is what onContextRestored() is for.
      let rebuilt = 0;
      const hs = this._restoreHandlers.slice();
      for (let i = 0; i < hs.length; i++) {
        try {
          if (hs[i](this) !== false) rebuilt++;
        } catch (err) {
          console.warn('[render] a context-restore handler threw: ' + errText(err));
        }
      }
      if (rebuilt === 0) {
        this._reportUnrecoverableLoss(
          hs.length === 0
            ? 'nothing is subscribed to renderer.onContextRestored, so the world geometry is gone'
            : 'every registered context-restore handler failed',
          null
        );
        return;
      }

      // Meshes are new objects: anything the auto-caster list remembers is a dead handle.
      this._autoA.n = 0;
      this._autoB.n = 0;
      this._castN = 0;
      this.contextLost = false;
      console.warn('[render] WebGL context restored; ' + rebuilt + ' module(s) re-uploaded their geometry.');
    };
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this._onLost, false);
      canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    }
  }

  /* -------------------------------------------------------- context restore */

  // Subscribe to WebGL context restoration. A handler is called with `(renderer)`; return
  // `false` to say "I could not rebuild". Returns an unsubscribe function.
  //
  // If NOTHING is subscribed, or every handler fails, the renderer does NOT report a successful
  // restore over an empty world: it stays in the lost state, sets `needsReload = true`, and
  // surfaces the failure through window.VH_SHELL.showError so the player is told to reload.
  onContextRestored(fn) {
    if (typeof fn !== 'function') return () => {};
    this._restoreHandlers.push(fn);
    return () => {
      const i = this._restoreHandlers.indexOf(fn);
      if (i >= 0) this._restoreHandlers.splice(i, 1);
    };
  }

  // The context came back but the scene cannot be: say so, loudly and exactly once, and leave
  // `contextLost` set so nothing touches the dead handles. Never throws — it runs from an event
  // handler and inside a catch block.
  _reportUnrecoverableLoss(reason, err) {
    this.contextLost = true;
    this.needsReload = true;
    const detail = reason + (err ? (': ' + errText(err)) : '');
    console.warn('[render] WebGL context restored, but the scene cannot be rebuilt — ' + detail +
      '. A page reload is required.');
    try {
      // index.html owns the loading/error shell and names its global; try the ones it has used.
      const w = (typeof window !== 'undefined') ? window : null;
      const shell = w ? (w.SHELL || w.VH_SHELL || w.TO_SHELL || null) : null;
      if (shell && typeof shell.showError === 'function') {
        shell.showError(
          'The graphics context was lost.',
          'The GPU dropped this page\'s WebGL context and took the world geometry with it (' +
          detail + ').\n\nReload the page to get back into downtown Toronto.'
        );
      }
    } catch (e) {
      // Reporting is best-effort; a missing or unhappy shell must not make this worse.
    }
  }

  // One warning per reason per session, and the feature latches off for good.
  _fail(key, reason, err) {
    if (!this._warned[key]) {
      this._warned[key] = true;
      console.warn('[render] ' + key + ' disabled (' + reason + (err ? ': ' + errText(err) : '') + ').');
    }
  }

  _resetStateCache() {
    this._blend = false;
    this._blendMode = 0;
    this._depthTest = false;
    this._depthWrite = false;
    this._cull = false;
    this._polyOffset = false;
    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    this._csmCount = 0;
  }

  resize(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
    if (this.contextLost) return;
    this.gl.viewport(0, 0, this.width, this.height);
    // Post targets are sized to the drawing buffer, so they are rebuilt here — old ones deleted
    // FIRST, which is what keeps a window drag (one resize event per frame) from leaking a
    // framebuffer set per event.
    this._resolveQuality();
    this._ensureTargets();
  }

  // Normalize `quality` into `_q` with every unsupported feature already masked out. Called at
  // the top of every frame, so the console can flip any of these between frames.
  _resolveQuality() {
    const q = this.quality || {};
    let sh = q.shadows;
    if (sh === true) sh = 'high';
    else if (sh === false || sh === null || sh === undefined) sh = 'off';
    else sh = String(sh).toLowerCase();
    if (sh !== 'off' && sh !== 'low' && sh !== 'high') sh = 'high';
    if (!this._shadowSupported || !this.csmShader) sh = 'off';

    const out = this._q;
    out.shadows = sh;
    out.clouds = boolOr(q.clouds, true);
    out.bloom = boolOr(q.bloom, true) && this._bloomSupported && this._postSupported &&
      !!(this.bloom && this.bloom.enabled !== false);
    out.ssao = boolOr(q.ssao, true) && this._ssaoSupported && this._postSupported &&
      this._depthTexSupported && this._mrtSupported && !!this.resolveShader;
    out.ssr = boolOr(q.ssr, true) && this._ssrSupported && this._postSupported &&
      this._depthTexSupported && this._mrtSupported && !!this.resolveShader;
    out.fxaa = boolOr(q.fxaa, true) && this._fxaaSupported && this._postSupported &&
      !!this.fxaaShader;
    // The local lights need no offscreen target and no depth texture — they are part of the
    // geometry pass — so they survive every post-chain fallback there is.
    out.lights = boolOr(q.lights, true) && this._lightsSupported;
    return out;
  }

  /* ------------------------------------------------------- light direction */

  _normalizedKey() {
    const k = this.env.keyDir || WHITE;
    const x = k[0], y = k[1], z = k[2];
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-8) || !Number.isFinite(l2)) {
      _key[0] = -0.845; _key[1] = 0.225; _key[2] = -0.487;
      return _key;
    }
    const inv = 1 / Math.sqrt(l2);
    _key[0] = x * inv; _key[1] = y * inv; _key[2] = z * inv;
    return _key;
  }

  _normalizedSun() {
    const s = this.env.sunDir || WHITE;
    const x = s[0], y = s[1], z = s[2];
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-8) || !Number.isFinite(l2)) {
      _sun[0] = -0.864; _sun[1] = -0.070; _sun[2] = -0.499;
      return _sun;
    }
    const inv = 1 / Math.sqrt(l2);
    _sun[0] = x * inv; _sun[1] = y * inv; _sun[2] = z * inv;
    return _sun;
  }

  /* ---------------------------------------------------------- state helpers */

  _useShader(sh) {
    if (this._shader === sh) return sh;
    sh.use();
    this._shader = sh;
    this.stats.programSwaps++;
    return sh;
  }

  _setBlend(on, mode) {
    const gl = this.gl;
    if (on !== this._blend) {
      this._blend = on;
      if (on) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    }
    if (on && mode !== this._blendMode) {
      this._blendMode = mode;
      if (mode === BLEND_MULTIPLY) gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  _setDepthTest(on) {
    if (on === this._depthTest) return;
    this._depthTest = on;
    const gl = this.gl;
    if (on) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  }

  _setDepthWrite(on) {
    if (on === this._depthWrite) return;
    this._depthWrite = on;
    this.gl.depthMask(on);
  }

  _setCull(on) {
    if (on === this._cull) return;
    this._cull = on;
    const gl = this.gl;
    if (on) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  }

  _setPolyOffset(on) {
    if (on === this._polyOffset) return;
    this._polyOffset = on;
    const gl = this.gl;
    if (on) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1.5, -2.0);
    } else {
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
  }

  // Bind + draw a Mesh/DynamicMesh, skipping the VAO bind when it is already current.
  _drawGeom(mesh) {
    if (!mesh) return;
    const n = mesh.vertexCount | 0;
    if (n <= 0) return;
    const gl = this.gl;
    const vao = mesh.vao;
    if (vao) {
      if (vao !== this._vao) {
        gl.bindVertexArray(vao);
        this._vao = vao;
        this.stats.vaoBinds++;
      }
      gl.drawArrays(gl.TRIANGLES, 0, n);
    } else if (typeof mesh.draw === 'function') {
      mesh.draw();
      this._vao = null;
    } else {
      return;
    }
    this.stats.draws++;
    this.stats.tris += (n / 3) | 0;
  }
  /* ------------------------------------------------------------- frame API */

  // `casters` is optional: pass the meshes that should cast shadows this frame, or register them
  // once with setShadowCasters(), or leave both alone and the renderer casts from whatever was
  // drawn opaque last frame.
  beginFrame(camera, casters) {
    const st = this.stats;
    st.draws = 0;
    st.tris = 0;
    st.programSwaps = 0;
    st.vaoBinds = 0;
    st.postPasses = 0;
    st.shadowDraws = 0;
    this.camera = camera || this.camera;
    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    // Other modules may have created meshes (which bind and unbind VAOs) since the last frame.
    this._vao = null;
    if (this.contextLost) return;

    const gl = this.gl;
    this._resolveQuality();

    // Swap the auto-caster capture buffers: what was drawn last frame becomes this frame's
    // caster list, and this frame starts recording into the other one.
    const prev = this._autoA;
    this._autoA = this._autoB;
    this._autoB = prev;
    this._autoB.n = 0;

    // --- local lights: cull, rank and cluster for THIS camera ---------------
    // Before the shadow pass, because it uploads two textures and the shadow pass is about to
    // change the bound framebuffer; and unconditionally before any program can ask for the scene
    // uniforms, which is where the tables are handed to the shader.
    this._updateLights();

    // --- cascaded shadow maps, before anything binds the scene target -------
    if (!this._shadowDone) this.shadowPass(casters || null, this.camera);
    this._shadowDone = false;

    // --- pick the target: offscreen when any post feature is live -----------
    if (this._ensureTargets()) {
      const p = this._post;
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.scene.fbo);
      gl.viewport(0, 0, p.w, p.h);
      this._frameOffscreen = true;
      this._outputMode = p.encode ? 2 : 1;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
    }
    this._frameActive = true;

    gl.depthFunc(gl.LEQUAL);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    this._setCull(true);
    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    const fc = this.env.fogColor;
    // Alpha 0 in the clear: on the material target that is the ambient-share channel, and an
    // unwritten pixel must not be told it is pure ambient.
    gl.clearColor(fc[0], fc[1], fc[2], 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._drawSky();
  }

  _drawSky() {
    const gl = this.gl;
    const e = this.env;
    const cam = this.camera;

    // The fullscreen triangle sits exactly on the far plane, so it is drawn with the depth test
    // off and the depth buffer untouched, before anything else.
    this._setDepthTest(false);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    const s = this._useShader(this.skyShader);
    s.set('uInvViewProj', (cam && cam.invViewProj) || IDENTITY);
    s.set('uSunDir', this._normalizedSun());
    s.set('uKeyColor', e.keyColor);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uFogColor', e.fogColor);
    s.set('uCloudAmount', this._q.clouds ? numOr(e.cloudAmount, 0, 1, 0.55) : 0);
    s.set('uCloudCover', numOr(e.cloudCover, 0, 0.98, 0.52));
    s.set('uStarAmount', numOr(e.starAmount, 0, 1, 0.55));
    s.set('uDaylight', this._daylight());
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);

    if (this.skyVao !== this._vao) {
      gl.bindVertexArray(this.skyVao);
      this._vao = this.skyVao;
      this.stats.vaoBinds++;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.draws++;
    this.stats.tris += 1;

    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setCull(true);
  }

  drawMesh(mesh, model, tint = WHITE, flash = 0, alpha = 1) {
    if (this.contextLost || !mesh) return;
    const s = this._useShader(this.sceneShader);
    this._sceneUniforms();

    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    const translucent = a < 0.999;
    this._setPolyOffset(false);
    this._setCull(true);
    this._setDepthTest(true);
    this._setBlend(translucent, BLEND_ALPHA);
    this._setDepthWrite(!translucent);

    const tr = tint ? tint[0] : 1;
    const tg = tint ? tint[1] : 1;
    const tb = tint ? tint[2] : 1;
    if (tr !== this._tr || tg !== this._tg || tb !== this._tb) {
      this._tr = tr; this._tg = tg; this._tb = tb;
      _tint[0] = tr; _tint[1] = tg; _tint[2] = tb;
      s.set('uTint', _tint);
    }

    const fl = Number.isFinite(flash) ? clamp(flash, 0, 4) : 0;
    if (fl !== this._flash) {
      this._flash = fl;
      s.set('uFlash', fl);
    }
    if (a !== this._alpha) {
      this._alpha = a;
      s.set('uAlpha', a);
    }

    s.set('uModel', model || IDENTITY);
    this._drawGeom(mesh);
    if (!translucent) this._rememberCaster(mesh, model);
  }

  // Pre-baked contact/blob shadows, if a caller still has such a mesh: multiplicative,
  // depth-tested, never writes depth, offset toward the camera so it cannot z-fight the surface
  // it is painted on. The cascaded maps are the real shadows now.
  drawShadowMesh(mesh, alpha) {
    if (this.contextLost || !mesh) return;
    const s = this._useShader(this.gshadowShader);
    this._gshadowUniforms();

    this._setDepthTest(true);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(true, BLEND_MULTIPLY);
    this._setPolyOffset(true);

    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0.5;
    if (a !== this._shadowAlpha) {
      this._shadowAlpha = a;
      s.set('uAlpha', a);
    }
    this._drawGeom(mesh);

    this._setPolyOffset(false);
  }

  /**
   * Glyph geometry from render/text.js. Draw it AFTER every opaque class and before drawWater or
   * endFrame; it is a blended decal pass, so anything it should sit on top of has to be in the
   * depth buffer already.
   *
   * Three deliberate departures from drawMesh, all of them about a glyph being paint on a surface
   * rather than a surface:
   *   * DEPTH WRITE IS OFF. Depth is what SSAO and SSR march, and a letter is not an occluder and
   *     not a reflector — it is a centimetre of ink on the fascia that already wrote depth there.
   *     With the write on, SSR would trace the reflection of the letter and SSAO would darken
   *     around a shape floating in front of a flat wall.
   *   * IT IS BLENDED. The distance field gives analytic coverage; throwing that away for an
   *     alpha test turns a 3 px cap height into crawling confetti, which is exactly the distance
   *     at which street signage matters most. Glyph quads only overlap where both are at zero
   *     coverage, so the missing depth sort costs nothing.
   *   * IT NEVER BECOMES A SHADOW CASTER. The depth-only cascade program reads position and
   *     nothing else, so a text mesh in the caster list would cast the SOLID QUAD of every glyph
   *     across the pavement. _rememberCaster is not called here, and callers must keep the text
   *     class out of setShadowCasters.
   */
  drawText(mesh, model, tint = WHITE, alpha = 1) {
    if (this.contextLost || !mesh) return;
    if (!this.textShader || !this.font || !this.font.texture) return;
    const s = this._useShader(this.textShader);
    this._textUniforms();

    this._setPolyOffset(false);
    this._setCull(true);
    this._setDepthTest(true);
    this._setBlend(true, BLEND_ALPHA);
    this._setDepthWrite(false);

    const tr = tint ? tint[0] : 1;
    const tg = tint ? tint[1] : 1;
    const tb = tint ? tint[2] : 1;
    if (tr !== this._txTr || tg !== this._txTg || tb !== this._txTb) {
      this._txTr = tr; this._txTg = tg; this._txTb = tb;
      _tint[0] = tr; _tint[1] = tg; _tint[2] = tb;
      s.set('uTint', _tint);
    }
    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    if (a !== this._txAlpha) {
      this._txAlpha = a;
      s.set('uAlpha', a);
    }

    // Texture UNITS are global GL state, not program state, and the post chain uses unit 4 for
    // the SSR and streak buffers. Binding the atlas once per frame with the other uniforms
    // therefore only works until something else touches the unit — which cost most of a day, and
    // presents as text that samples a black atlas and vanishes completely. Bind per draw; it is
    // a handful of calls a frame.
    s.setTexture('uGlyphs', 4, this.font.texture);
    s.set('uModel', model || IDENTITY);
    this._drawGeom(mesh);
  }

  // The lake. Drawn OPAQUE on purpose: an alpha-blended surface would blend the material target
  // too, and SSR would then trace against a smeared normal. Depth in the harbour is not modelled
  // — inside this bbox it is deep enough everywhere to read as opaque anyway.
  drawWater(mesh, camera) {
    if (this.contextLost || !mesh) return;
    if (camera) {
      this.camera = camera;
      this._waterFrame = false;   // a fresh camera was supplied for this call
    }
    this._useShader(this.waterShader);
    this._waterUniforms();
    this.waterShader.set('uModel', IDENTITY);

    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setCull(false);       // visible from underneath too
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    // The lake is deliberately NOT a shadow caster: it is flat, it sits at the bottom of the
    // world, and letting it into the depth pass only buys self-shadowing artefacts on the water.
    this._drawGeom(mesh);
  }

  /* ------------------------------------------------------ end frame, teardown */

  endFrame() {
    if (this.contextLost) return;
    const gl = this.gl;

    if (this._frameOffscreen) {
      this._frameOffscreen = false;
      this._outputMode = 0;
      try {
        this._runPost();
      } catch (err) {
        // A post pass has no business taking the renderer down. Give up on the offscreen path
        // for good and put the screen back under our feet; the next frame draws straight to it.
        this._postSupported = false;
        this._bloomSupported = false;
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fxaaSupported = false;
        this._fail('post', 'a post pass failed', err);
        try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (e) { /* nothing left to do */ }
        this._destroyTargets();
        this._resolveQuality();
      }
    }

    this._frameActive = false;
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);
    this._setDepthWrite(true);
    this._setDepthTest(true);
    this._setCull(true);
    if (this._vao !== null) {
      gl.bindVertexArray(null);
      this._vao = null;
    }
    // NOTE: the program is deliberately left bound. gl.js tracks the live program on the
    // context object, so calling gl.useProgram(null) here would desync Shader.set().
  }

  // Everything this renderer owns. Meshes belong to their own modules and are not touched.
  dispose() {
    const gl = this.gl;
    this._destroyTargets();
    this._destroyShadowTargets();
    if (!this.contextLost) {
      try {
        if (this._dummyShadow) gl.deleteTexture(this._dummyShadow);
        if (this._lights.dataTex) gl.deleteTexture(this._lights.dataTex);
        if (this._lights.gridTex) gl.deleteTexture(this._lights.gridTex);
        if (this.skyVao) gl.deleteVertexArray(this.skyVao);
      } catch (err) {
        // Teardown is best-effort.
      }
    }
    this._lights.dataTex = null;
    this._lights.gridTex = null;
    this._lights.ready = false;
    this._dummyShadow = null;
    this.skyVao = null;
    if (!this.contextLost) releaseFont(gl);
    this.font = null;
    const shaders = [
      this.sceneShader, this.skyShader, this.waterShader, this.gshadowShader, this.csmShader,
      this.textShader, this.brightShader, this.blurShader, this.compShader, this.ssaoShader,
      this.aoBlurShader, this.ssrShader, this.resolveShader, this.fxaaShader,
    ];
    for (let i = 0; i < shaders.length; i++) {
      if (shaders[i] && !this.contextLost) {
        try { shaders[i].dispose(); } catch (err) { /* best effort */ }
      }
    }
    const canvas = this._canvas;
    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('webglcontextlost', this._onLost, false);
      canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
    }
  }
}

// The Renderer is one object with one lifetime, but not one file. Each subsystem module hands
// its methods back as a plain object and they are installed here, non-enumerably, exactly as if
// they had been written in the class body above. See render/util.js mixin().
mixin(
  Renderer.prototype,
  EnvMethods, ProgramMethods, TargetMethods, ShadowMethods, LightMethods, UniformMethods,
  SsaoMethods, SsrMethods, BloomMethods, PostMethods
);
