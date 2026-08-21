// src/render/ssr.js -- screen-space reflections (CONTRACT 3.2 item 4, the signature of the look).
//
// Marches the depth buffer in VIEW space with a geometrically growing step, binary-refines the
// crossing, then fades on ray length, screen edge and grazing angle, falling back to the
// analytic sky on a miss. Gated on roughness, so wet asphalt, glass and the lake reflect while
// dry concrete never enters the loop.
//
// The ray budget has to cross the HARBOUR, not just a street -- see the ssr block in the
// Renderer constructor for why 42 steps and 1,400 m.
//
// The GLSL is SSR_FS in render/shaders/post.glsl.js; the resolve that consumes the result is
// RESOLVE_FS, driven from renderer.js because it folds SSAO in at the same time.

import { IDENTITY, numOr } from './util.js';

// Module-scope scratch — the hot path must not allocate. Filled and handed to the GPU inside
// one call.
const _ssrParam = new Float32Array(4);

// Mixed into Renderer.prototype by renderer.js.
export const SsrMethods = {
  _runSSR() {
    const p = this._post;
    const cfg = this.ssr;
    const cam = this.camera;
    const e = this.env;
    const s = this._useShader(this.ssrShader);
    _ssrParam[0] = numOr(cfg.maxDistance, 1, 4000, 240);
    _ssrParam[1] = numOr(cfg.steps, 4, 48, 28);
    _ssrParam[2] = numOr(cfg.thickness, 0.05, 40, 1.3);
    _ssrParam[3] = numOr(cfg.stride, 0.05, 20, 0.6);
    s.set('uProj', (cam && cam.proj) || IDENTITY);
    s.set('uView', (cam && cam.view) || IDENTITY);
    s.set('uInvView', (cam && cam.invView) || IDENTITY);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uSunDir', this._normalizedSun());
    s.set('uAmbientGround', e.ambientGround);
    s.set('uSsrParams', _ssrParam);
    s.set('uDecode', p.encode ? 1 : 0);
    s.setTexture('uScene', 1, p.scene.tex);
    s.setTexture('uMat', 2, p.mat);
    this._setDepthUniforms(s, 0);
    this._postPass(p.ssr);
  },
};

/* -------------------------------------------------------------- defaults -- */

// The ray budget has to cross the HARBOUR, not just a street. The reflection of the skyline
// in the lake is the signature shot (CONTRACT §0/§3.2.4) and the towers sit 600-1500 m from
// open water: at the old 240 m reach every lake ray ran out of budget short of the city and
// the resolve's (traced - analytic) delta collapsed to zero, so the harbour rendered as flat
// black. The march grows geometrically (x1.16/step), so 42 steps reach ~2.1 km for the same
// near-field precision that made wet streets work — measured cost at 1440x900 is nil.
export function defaultSsrSettings() {
  return { maxDistance: 1400, steps: 42, thickness: 1.3, stride: 0.6, intensity: 1.0 };
}
