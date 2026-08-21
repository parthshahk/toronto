// src/render/bloom.js -- the bloom chain and the anamorphic streak.
//
// CONTRACT 3.2 item 8, and the three-tier fallback the contract says must not be regressed: a
// float offscreen target, an 8-bit range-compressed one, or straight to the screen graded
// in-shader. This module owns the chain depth, the daylight trims and the bright-pass,
// separable-blur and streak drivers; renderer.js owns the order they run in.

// Bloom chain depth: half, quarter and eighth resolution.
export const BLOOM_LEVELS = 3;

// --- daylight -------------------------------------------------------------------------------
// Both trims are exactly 1x at env.daylight 0, so blue hour and night are untouched.
// render/env.js owns the switch itself.
// Bloom in daylight. The threshold is in linear scene light, and daylight raises the whole frame:
// left at the blue-hour value the sky and every pale facade would cross it and the bloom would
// become a wash over the entire image instead of a glow around the few things that are actually
// blinding (the disc, the aureole, glints off glass and water).
export const DAY_BLOOM_THRESHOLD = 2.6;
export const DAY_BLOOM_INTENSITY = 0.55;
// The anamorphic streak is a low-light lens signature. Against a bright sky it stops reading as
// a flare and starts reading as a smear across the image, so daylight nearly closes it.
export const DAY_STREAK_INTENSITY = 0.22;

// Module-scope scratch — the hot paths must not allocate. Both are filled and handed to the
// GPU inside one call.
const _texel = new Float32Array(2);
const _dir = new Float32Array(2);

/* ------------------------------------------------------- the bloom chain */

// Mixed into Renderer.prototype by renderer.js, which owns the order these run in and the
// daylight trims above. The GLSL is BRIGHT_FS and BLUR_FS in render/shaders/post.glsl.js.
export const BloomMethods = {
  // Bright-pass / downsample. `threshold = 0, knee = 0, firefly = 0` degenerates into a plain
  // 4-tap box downsample, which is what the lower levels use.
  _brightPass(srcTex, srcW, srcH, threshold, knee, firefly, decode, dst) {
    const s = this._useShader(this.brightShader);
    _texel[0] = 1 / Math.max(1, srcW);
    _texel[1] = 1 / Math.max(1, srcH);
    s.set('uTexel', _texel);
    s.set('uThreshold', threshold);
    s.set('uKnee', knee);
    s.set('uFirefly', firefly);
    s.set('uDecode', decode);
    s.setTexture('uSrc', 0, srcTex);
    this._postPass(dst);
  },

  // Separable Gaussian in place: level.a -> level.b horizontally, then back the other way.
  _blurLevel(level, radius) {
    const s = this._useShader(this.blurShader);
    _texel[0] = 1 / Math.max(1, level.w);
    _texel[1] = 1 / Math.max(1, level.h);
    s.set('uTexel', _texel);
    s.set('uRadius', radius);

    _dir[0] = 1; _dir[1] = 0;
    s.set('uDir', _dir);
    s.setTexture('uSrc', 0, level.a.tex);
    this._postPass(level.b);

    _dir[0] = 0; _dir[1] = 1;
    s.set('uDir', _dir);
    s.setTexture('uSrc', 0, level.b.tex);
    this._postPass(level.a);
  },

  // One wide horizontal smear, run three times at quarter resolution with a growing radius.
  // Anamorphic flares are a horizontal-only artefact of a cylindrical lens element, which is
  // exactly what this is: no vertical pass, ever.
  _runStreak() {
    const p = this._post;
    if (!p.streakA || !p.streakB || p.levels.length === 0) return null;
    const s = this._useShader(this.blurShader);
    _texel[0] = 1 / Math.max(1, p.streakA.w);
    _texel[1] = 1 / Math.max(1, p.streakA.h);
    _dir[0] = 1; _dir[1] = 0;
    s.set('uTexel', _texel);
    s.set('uDir', _dir);

    const src = p.levels[0].a.tex;
    s.set('uRadius', 3.0);
    s.setTexture('uSrc', 0, src);
    this._postPass(p.streakA);

    s.set('uRadius', 9.0);
    s.setTexture('uSrc', 0, p.streakA.tex);
    this._postPass(p.streakB);

    s.set('uRadius', 27.0);
    s.setTexture('uSrc', 0, p.streakB.tex);
    this._postPass(p.streakA);
    return p.streakA;
  },
};
