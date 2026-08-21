// src/render/ssao.js -- screen-space ambient occlusion (CONTRACT 3.2 item 2).
//
// Half resolution, 16 cosine-distributed hemisphere samples against the depth TEXTURE, then a
// bilateral blur whose weights fold in a depth similarity term so occlusion never bleeds
// across a silhouette. The result is applied to AMBIENT ONLY, in the resolve pass, through the
// ambient-share channel the scene shader wrote -- direct light and emissive windows are never
// touched by it, which is what stops a lit window inside an alley going grey.
//
// The GLSL is SSAO_FS and AOBLUR_FS in render/shaders/post.glsl.js.

import { IDENTITY, numOr } from './util.js';

// Module-scope scratch — the hot paths must not allocate. Each is filled and handed to the GPU
// inside one call.
const _texel = new Float32Array(2);
const _texel2 = new Float32Array(2);
const _aoParam = new Float32Array(4);

// Mixed into Renderer.prototype by renderer.js.
export const SsaoMethods = {
  _runSSAO() {
    const p = this._post;
    const cfg = this.ssao;
    const cam = this.camera;
    const s = this._useShader(this.ssaoShader);
    _aoParam[0] = numOr(cfg.radius, 0.05, 64, 3.4);
    _aoParam[1] = numOr(cfg.intensity, 0, 4, 1.0);
    _aoParam[2] = numOr(cfg.bias, 0.001, 4, 0.045);
    _aoParam[3] = numOr(cfg.power, 0.05, 8, 1.35);
    _texel[0] = 1 / Math.max(1, p.w);
    _texel[1] = 1 / Math.max(1, p.h);
    s.set('uProj', (cam && cam.proj) || IDENTITY);
    s.set('uSrcTexel', _texel);
    s.set('uAoParams', _aoParam);
    this._setDepthUniforms(s, 0);
    this._postPass(p.aoA);

    const b = this._useShader(this.aoBlurShader);
    _texel2[0] = 1 / Math.max(1, p.aoA.w);
    _texel2[1] = 1 / Math.max(1, p.aoA.h);
    b.set('uTexel', _texel2);
    b.set('uSharpness', numOr(cfg.sharpness, 0, 64, 5.5));
    b.setTexture('uSrc', 1, p.aoA.tex);
    this._setDepthUniforms(b, 0);
    this._postPass(p.aoB);
  },
};

/* -------------------------------------------------------------- defaults -- */

// Tunable live: `G.renderer.ssao.intensity = 1.4`.
export function defaultSsaoSettings() {
  return { radius: 3.4, intensity: 1.0, bias: 0.045, power: 1.35, sharpness: 5.5 };
}
