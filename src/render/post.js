// src/render/post.js -- the post chain: what runs, in what order, and the composite.
//
// CONTRACT 3.2 item 8. The geometry pass leaves linear HDR radiance in the scene target and
// oct(N).xy / roughness / ambient share beside it; from there:
//
//   SSAO -> bilateral blur          render/ssao.js
//   SSR                             render/ssr.js
//   resolve                         here -- folds AO into AMBIENT ONLY through the
//                                   ambient-share channel, and swaps the analytic sky
//                                   reflection for the traced one
//   bright pass -> blur chain       render/bloom.js
//   anamorphic streak               render/bloom.js
//   composite                       here -- the only pass that writes the default
//                                   framebuffer, unless FXAA is on and resolves it
//   FXAA                            here
//
// Every stage is optional and each one is skipped on its own, so a GPU that cannot give one of
// them still gets every other. The GLSL is render/shaders/post.glsl.js.

import { BLEND_ALPHA, IDENTITY, numOr } from './util.js';
import { DAY_BLOOM_THRESHOLD, DAY_BLOOM_INTENSITY, DAY_STREAK_INTENSITY } from './bloom.js';

// Module-scope scratch — the hot paths must not allocate. Each is written and read inside a
// single call and carries nothing between calls.
// Depth reconstruction: the two projection terms SSAO, SSR and the resolve rebuild view-space Z
// from, handed to every one of them by _setDepthUniforms.
const _zparam = new Float32Array(2);
// One over the source size, for the FXAA resolve at the end of the chain.
const _texel = new Float32Array(2);

// The composite dials. Tunable live: `G.renderer.post.grain = 0`.
export function defaultPostSettings() {
  return { streak: 0.5, grain: 0.026, chroma: 0.0032, vignette: 0.30 };
}

// Mixed into Renderer.prototype by renderer.js.
export const PostMethods = {
  // Bind a target (null = the default framebuffer, i.e. the screen) and draw the fullscreen
  // triangle. Attributeless: the VAO carries no arrays, the vertices come from gl_VertexID.
  _postPass(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    if (target) gl.viewport(0, 0, target.w, target.h);
    else gl.viewport(0, 0, this._post.w, this._post.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.postPasses++;
  },

  // Depth-texture uniforms shared by SSAO, the AO blur, SSR and the resolve.
  _setDepthUniforms(s, unit) {
    const cam = this.camera;
    const proj = (cam && cam.proj) || IDENTITY;
    _zparam[0] = proj[10];
    _zparam[1] = proj[14];
    s.setTexture('uDepth', unit, this._post.depthTex);
    s.set('uInvProj', (cam && cam.invProj) || IDENTITY);
    s.set('uZParam', _zparam);
  },

  _runResolve() {
    const p = this._post;
    const e = this.env;
    const cam = this.camera;
    const s = this._useShader(this.resolveShader);
    s.set('uInvView', (cam && cam.invView) || IDENTITY);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uSunDir', this._normalizedSun());
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uAoEnabled', p.useAo ? 1 : 0);
    s.set('uSsrEnabled', p.useSsr ? 1 : 0);
    s.set('uSsrIntensity', numOr(this.ssr.intensity, 0, 4, 1));
    s.set('uDaylight', this._daylight());
    s.set('uAoFill', numOr((this.dayIndirect || {}).aoFill, 0, 1, 0.62));
    s.set('uDecode', p.encode ? 1 : 0);
    s.setTexture('uScene', 1, p.scene.tex);
    s.setTexture('uMat', 2, p.mat);
    s.setTexture('uAO', 3, p.useAo ? p.aoB.tex : p.scene.tex);
    s.setTexture('uSSR', 4, p.useSsr ? p.ssr.tex : p.scene.tex);
    this._setDepthUniforms(s, 0);
    this._postPass(p.resolve);
  },

  // The whole post chain. Every stage is optional and the composite is the only pass that ever
  // writes the default framebuffer.
  _runPost() {
    const gl = this.gl;
    const p = this._post;

    this._setDepthTest(false);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);
    if (this.skyVao !== this._vao) {
      gl.bindVertexArray(this.skyVao);
      this._vao = this.skyVao;
      this.stats.vaoBinds++;
    }

    if (p.useAo) this._runSSAO();
    if (p.useSsr) this._runSSR();

    let src = p.scene;
    if ((p.useAo || p.useSsr) && p.resolve) {
      this._runResolve();
      src = p.resolve;
    }

    const decode = p.encode ? 1 : 0;
    const day = this._daylight();
    let streak = null;
    if (p.useBloom) {
      const cfg = this.bloom;
      const threshold = numOr(cfg.threshold, 0, 8, 0.72) * (1 + (DAY_BLOOM_THRESHOLD - 1) * day);
      const radius = numOr(cfg.radius, 0.05, 4, 1);

      // Level 0: threshold straight out of the scene target at half resolution, then blur.
      const l0 = p.levels[0];
      this._brightPass(src.tex, p.w, p.h, threshold, threshold * 0.5, 1, decode, l0.a);
      this._blurLevel(l0, radius);

      // Levels 1..n: box-downsample the level above (no second threshold — it would eat the
      // glow the first pass just produced) and blur again at the new resolution.
      for (let i = 1; i < p.levels.length; i++) {
        const prev = p.levels[i - 1];
        const cur = p.levels[i];
        this._brightPass(prev.a.tex, prev.w, prev.h, 0, 0, 0, 0, cur.a);
        this._blurLevel(cur, radius);
      }
      streak = this._runStreak();
    }

    // --- composite: the last pass before the frame becomes 8-bit -------------
    const cfg = this.post || {};
    const s = this._useShader(this.compShader);
    const b0 = p.useBloom ? p.levels[0].a.tex : src.tex;
    const b1 = p.useBloom ? p.levels[Math.min(1, p.levels.length - 1)].a.tex : src.tex;
    const b2 = p.useBloom ? p.levels[Math.min(2, p.levels.length - 1)].a.tex : src.tex;
    s.set('uIntensity', p.useBloom
      ? numOr(this.bloom.intensity, 0, 8, 0.85) * (1 + (DAY_BLOOM_INTENSITY - 1) * day)
      : 0);
    s.set('uStreakIntensity', streak
      ? numOr(cfg.streak, 0, 4, 0.5) * (1 + (DAY_STREAK_INTENSITY - 1) * day)
      : 0);
    s.set('uChroma', numOr(cfg.chroma, 0, 0.2, 0.0032));
    // With FXAA in play, grain and dither happen in THAT pass instead: graining first would
    // give the edge detector high-frequency noise to chase and soften the whole image.
    s.set('uGrain', p.useFxaa ? 0 : numOr(cfg.grain, 0, 0.5, 0.026));
    s.set('uVignette', numOr(cfg.vignette, 0, 1, 0.30));
    s.set('uTime', numOr(this.env.time, -1e7, 1e7, 0));
    s.set('uDecode', decode);
    s.set('uDaylight', day);
    s.set('uExposure', this._dayExposure());
    s.setTexture('uScene', 0, src.tex);
    s.setTexture('uB0', 1, b0);
    s.setTexture('uB1', 2, b1);
    s.setTexture('uB2', 3, b2);
    s.setTexture('uStreak', 4, streak ? streak.tex : src.tex);
    this._postPass(p.useFxaa ? p.ldr : null);

    // --- FXAA resolve: the only pass that writes the screen when it is on ----
    if (p.useFxaa) {
      const fx = this._useShader(this.fxaaShader);
      _texel[0] = 1 / Math.max(1, p.w);
      _texel[1] = 1 / Math.max(1, p.h);
      fx.set('uTexel', _texel);
      fx.set('uGrain', numOr(cfg.grain, 0, 0.5, 0.026));
      fx.set('uTime', numOr(this.env.time, -1e7, 1e7, 0));
      fx.setTexture('uSrc', 0, p.ldr.tex);
      this._postPass(null);
    }

    // Leave no post texture bound. Next frame the geometry pass renders INTO the very textures
    // these units are holding, and while no scene program samples them (so nothing is actually a
    // feedback loop), an unbound unit is one less thing for a driver to be clever about.
    for (let u = 4; u >= 0; u--) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  },
};
