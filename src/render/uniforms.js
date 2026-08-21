// src/render/uniforms.js -- the once-per-frame uniform block for each geometry program.
//
// Four blocks, one per program that shades world geometry: scene, water, world text and the
// legacy blob shadow. Each latches on a per-frame flag so it costs one branch on every draw
// after the first, and each reads the SAME env fields as the others -- which is what makes a
// time-of-day change move the fascia and the letters on it together.
//
// The env fields themselves are sanitised in render/env.js; the cascade and local-light blocks
// come from render/shadows.js and render/lights.js. Nothing here decides a value, it only says
// which program is told about it.

import { IDENTITY, WHITE, numOr } from './util.js';
import { TEXT_FADE_START, TEXT_FADE_END } from './text.js';

// Module-scope scratch — the hot paths must not allocate.
// Text pass: xy = atlas size in texels, z = the SDF's texel range, w = cap height in texels.
const _glyphAtlas = new Float32Array(4);
// x = fade start (m), y = 1 / fade span, z = cap px below which a glyph is gone, w = cap px
// above which it is fully opaque.
const _textLod = new Float32Array(4);

// Mixed into Renderer.prototype by renderer.js.
export const UniformMethods = {
  _sceneUniforms() {
    if (this._sceneFrame) return;
    this._sceneFrame = true;
    const e = this.env;
    const s = this.sceneShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uStreetColor', e.streetColor);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uCnTower', this._cnTowerParams());
    s.set('uSkyBounce', numOr(e.skyBounce, 0, 6, 1.85));
    s.set('uNightFactor', numOr(e.nightFactor, 0, 1, 0.86));
    s.set('uWindowMix', 1);
    s.set('uWindowLit', numOr(e.windowLit, 0, 1, 0.50));
    s.set('uWindowGain', numOr(e.windowGain, 0, 8, 1.45));
    s.set('uDaylight', this._daylight());
    s.set('uDayIndirect', this._dayIndirectParams());
    s.set('uRoad', this._roadParams());
    s.set('uEmitterGain', numOr(e.emitterGain, 0, 16, 2.2));
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);
    this._setShadowUniforms(s);
    this._setLightUniforms(s);
  },

  _waterUniforms() {
    if (this._waterFrame) return;
    this._waterFrame = true;
    const e = this.env;
    const s = this.waterShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uDaylight', this._daylight());
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);
    this._setShadowUniforms(s);
  },

  // Per-frame state for the text pass. Every term it shares with the scene shader is read from
  // the same env field, so a preset change moves the fascia and the letters on it together.
  _textUniforms() {
    if (this._textFrame) return;
    this._textFrame = true;
    const e = this.env;
    const s = this.textShader;
    const cam = this.camera;
    const f = this.font;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uStreetColor', e.streetColor);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uSkyBounce', numOr(e.skyBounce, 0, 6, 1.85));
    s.set('uNightFactor', numOr(e.nightFactor, 0, 1, 0.86));
    s.set('uDaylight', this._daylight());
    s.set('uDayIndirect', this._dayIndirectParams());
    s.set('uExposure', this._dayExposure());
    s.set('uOutputMode', this._outputMode);
    _glyphAtlas[0] = f ? f.width : 1;
    _glyphAtlas[1] = f ? f.height : 1;
    _glyphAtlas[2] = f ? f.sdfRange : 12;
    _glyphAtlas[3] = f ? f.capTexels : 24;
    s.set('uGlyphAtlas', _glyphAtlas);
    const t = this.text || {};
    const f0 = numOr(t.fadeStart, 0, 1e6, TEXT_FADE_START);
    const f1 = Math.max(f0 + 1, numOr(t.fadeEnd, 0, 1e6, TEXT_FADE_END));
    const p0 = numOr(t.minPx, 0, 400, 2.4);
    _textLod[0] = f0;
    _textLod[1] = 1 / (f1 - f0);
    _textLod[2] = p0;
    _textLod[3] = Math.max(p0 + 0.25, numOr(t.fadePx, 0, 400, 4.6));
    s.set('uTextLod', _textLod);
    s.set('uTextWeight', numOr(t.weight, 0, 3, 0.42));
    this._setShadowUniforms(s);
  },

  _gshadowUniforms() {
    if (this._gshadowFrame) return;
    this._gshadowFrame = true;
    const e = this.env;
    const s = this.gshadowShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uShadowColor', e.shadowColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
  },
};

/* -------------------------------------------------------------- defaults -- */

// TEXT LEVEL OF DETAIL. Two independent gates; whichever closes first wins.
//
//   fadeStart/fadeEnd  metres. The hard guarantee, and the numbers the caller's tile stage is
//                      built around — render/text.js exports the same pair as TEXT_FADE_START /
//                      TEXT_FADE_END, and TEXT_RANGE sits past fadeEnd so a run is already
//                      invisible before its tile is allowed to drop the geometry.
//   minPx/fadePx       CAP HEIGHT IN PIXELS. This is the gate that does the perceptual work,
//                      because "how far away is it" is the wrong question — a 120 mm street
//                      blade and a 2 m tower crown are unreadable and perfectly readable at
//                      the same 60 m. 4.6 px is about where a word stops being a word;
//                      2.4 px is where it is a smear that only crawls, so it goes.
//   weight             texels of dilation at full minification (see uTextWeight).
// Tunable live: `G.renderer.text.fadeEnd = 260`.
export function defaultTextSettings() {
  return {
    fadeStart: TEXT_FADE_START,
    fadeEnd: TEXT_FADE_END,
    minPx: 2.4,
    fadePx: 4.6,
    weight: 0.42,
  };
}
