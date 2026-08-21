// src/render/targets.js -- the offscreen render targets the post chain runs on.
//
// The scene target (RGBA16F, or RGBA8 range-compressed where float is not renderable), the
// material target that carries oct(N).xy / roughness / ambient share, the depth attachment as
// a sampleable TEXTURE when anything wants to read it, the resolve target, the half-res SSAO
// and SSR buffers, the bloom chain and its streak pair, and the LDR target FXAA resolves.
//
// Every sub-feature is allowed to fail on its own here and latch itself off for the session:
// no depth texture means no SSAO and no SSR but bloom still runs, no second colour attachment
// means the same, no float colour drops the whole chain to RGBA8, and if even that fails the
// renderer goes back to drawing straight to the screen graded in-shader. CONTRACT 3.2: none
// of it may block boot.

import { BLOOM_LEVELS } from './bloom.js';

// Mixed into Renderer.prototype by renderer.js. Every target lives on the Renderer as
// this._post, so a Renderer owns its own framebuffers.
export const TargetMethods = {
  // One colour texture + its framebuffer. Returns null (having cleaned up after itself) if the
  // format is not renderable here, which is how the RGBA16F -> RGBA8 fallback is detected.
  _makeTarget(w, h, internalFormat, format, type, filter) {
    const gl = this.gl;
    const f = filter || gl.LINEAR;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }
    return { fbo, tex, w, h };
  },

  // Drop every handle without touching GL. Used after a context loss, where the objects are
  // already gone and deleting them through the new context would be an error.
  _forgetTargets() {
    const p = this._post;
    p.scene = null; p.mat = null; p.depthTex = null; p.depthRb = null; p.resolve = null;
    p.aoA = null; p.aoB = null; p.ssr = null; p.streakA = null; p.streakB = null; p.ldr = null;
    p.levels = [];
    p.ready = false; p.sig = ''; p.w = 0; p.h = 0;
    p.useAo = false; p.useSsr = false; p.useBloom = false; p.useFxaa = false;
  },

  _destroyTargets() {
    const gl = this.gl;
    const p = this._post;
    if (!p.scene && p.levels.length === 0 && !p.ready) return;
    if (!this.contextLost) {
      try {
        const kill = (t) => {
          if (!t) return;
          if (t.fbo) gl.deleteFramebuffer(t.fbo);
          if (t.tex) gl.deleteTexture(t.tex);
        };
        kill(p.scene); kill(p.resolve); kill(p.aoA); kill(p.aoB); kill(p.ssr);
        kill(p.streakA); kill(p.streakB); kill(p.ldr);
        if (p.mat) gl.deleteTexture(p.mat);
        if (p.depthTex) gl.deleteTexture(p.depthTex);
        if (p.depthRb) gl.deleteRenderbuffer(p.depthRb);
        for (let i = 0; i < p.levels.length; i++) {
          kill(p.levels[i].a);
          kill(p.levels[i].b);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (err) {
        // Deleting into a context that died mid-teardown is not worth a crash.
      }
    }
    this._forgetTargets();
  },

  // Build (or rebuild, on a size or quality change) every offscreen target the current quality
  // settings need. Returns true when the offscreen path is live for this frame.
  //
  // Each sub-feature is allowed to fail on its own: no depth TEXTURE means no SSAO and no SSR
  // but bloom still runs; no second colour attachment means the same; no float colour drops the
  // whole chain to the range-compressed RGBA8 path; and if even that fails the renderer goes
  // back to drawing straight to the screen, graded in-shader.
  _ensureTargets() {
    if (this.contextLost || !this._postSupported) { this._destroyTargets(); return false; }

    for (let attempt = 0; attempt < 4; attempt++) {
      const q = this._q;
      const wantBloom = q.bloom;
      const wantAo = q.ssao;
      const wantSsr = q.ssr;
      const wantFxaa = q.fxaa;
      // NOTE: the offscreen path is kept even when every post feature is off, and this is a
      // PERFORMANCE decision, not a tidiness one.
      //
      // gl.js asks for `antialias: true`, so the default framebuffer is 4x multisampled — this
      // context reports SAMPLES = 4. At every preset that runs the post chain, the only thing
      // ever drawn into that framebuffer is one full-screen composite quad, which costs nothing.
      // Take the chain away and the WHOLE SCENE is shaded into a 4x MSAA surface instead, and
      // the cheapest preset becomes the most expensive one.
      //
      // MEASURED, foreground Chrome on an M1 Pro, 3248 x 1500, the harbour viewpoint, 447 draws:
      //   Minimal straight to the 4x MSAA default framebuffer   16.3 ms   61 fps
      //   Minimal through the offscreen target + one composite    8.7 ms  115 fps
      //   Low     (offscreen, 13 post passes)                     8.8 ms  114 fps
      // So the cheapest rung of the quality ladder was 1.87x the cost of the rung above it —
      // which makes stepping down actively harmful, and the adaptive quality step in main.js
      // depends on the ladder being monotonic. One composite pass over a single-sampled target
      // beats shading the city four times over.
      //
      // The fallback for a GPU with no renderable offscreen format is untouched: _postSupported
      // is false there and this function returns at the top, straight to the in-shader grade.
      // What this preset gives up is the default framebuffer's free MSAA — but Minimal has FXAA
      // off anyway, and 87% of the frame time is not a fair price for it.

      const gl = this.gl;
      const w = Math.max(1, gl.drawingBufferWidth || this.width);
      const h = Math.max(1, gl.drawingBufferHeight || this.height);
      const p = this._post;
      const sig = w + 'x' + h + '|' + (wantBloom ? 'b' : '') + (wantAo ? 'a' : '') +
        (wantSsr ? 's' : '') + (wantFxaa ? 'f' : '');
      if (p.ready && p.sig === sig) return true;

      this._destroyTargets();
      let retry = false;
      try {
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
        if (w > maxTex || h > maxTex) throw new Error('drawing buffer is larger than MAX_TEXTURE_SIZE');

        if (!this._floatProbed) {
          this._floatProbed = true;
          this._float = !!(gl.getExtension('EXT_color_buffer_float') ||
                           gl.getExtension('EXT_color_buffer_half_float'));
        }

        let float = this._float;
        let ifmt = float ? gl.RGBA16F : gl.RGBA8;
        let type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        let scene = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
        if (!scene && float) {
          float = false;
          ifmt = gl.RGBA8;
          type = gl.UNSIGNED_BYTE;
          this._float = false;
          scene = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
        }
        if (!scene) throw new Error('no renderable colour format for the scene target');
        p.scene = scene;
        p.encode = !float;

        const wantGBuffer = wantAo || wantSsr;
        gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);

        // --- second colour attachment: oct normal, roughness, ambient share ---
        if (wantGBuffer && this._mrtSupported) {
          const mat = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mat);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, mat, 0);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.deleteTexture(mat);
            this._mrtSupported = false;
            this._fail('ssao/ssr', 'this driver will not attach a second colour target');
            retry = true;
          } else {
            p.mat = mat;
          }
        } else {
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        }

        // --- depth: a TEXTURE when anything wants to read it, else a renderbuffer ---
        if (!retry) {
          let depthOk = false;
          if (wantGBuffer && this._depthTexSupported) {
            const dt = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, dt);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0,
              gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
            // Depth textures are NOT filterable in WebGL2 unless sampled through a shadow
            // sampler, so NEAREST is mandatory here.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dt, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
              p.depthTex = dt;
              depthOk = true;
            } else {
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
              gl.deleteTexture(dt);
              this._depthTexSupported = false;
              this._fail('ssao/ssr', 'this driver will not attach a depth texture');
              retry = true;
            }
          }
          if (!depthOk && !retry) {
            const rb = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
              gl.deleteRenderbuffer(rb);
              throw new Error('scene framebuffer incomplete with a depth attachment');
            }
            p.depthRb = rb;
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        if (retry) {
          this._destroyTargets();
          this._resolveQuality();
          continue;
        }

        p.useAo = wantAo && !!p.mat && !!p.depthTex;
        p.useSsr = wantSsr && !!p.mat && !!p.depthTex;

        // --- resolve target: what SSAO/SSR write into, and what bloom then reads ---
        if (p.useAo || p.useSsr) {
          p.resolve = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
          if (!p.resolve) throw new Error('the resolve target is not renderable');
        }
        const hw = Math.max(1, w >> 1);
        const hh = Math.max(1, h >> 1);
        if (p.useAo) {
          p.aoA = this._makeTarget(hw, hh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
          p.aoB = p.aoA ? this._makeTarget(hw, hh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR) : null;
          if (!p.aoA || !p.aoB) throw new Error('the SSAO targets are not renderable');
        }
        if (p.useSsr) {
          p.ssr = this._makeTarget(hw, hh, ifmt, gl.RGBA, type, gl.LINEAR);
          if (!p.ssr) throw new Error('the SSR target is not renderable');
        }

        // --- bloom chain + anamorphic streak ---
        p.levels = [];
        if (wantBloom) {
          let lw = w, lh = h;
          for (let i = 0; i < BLOOM_LEVELS; i++) {
            lw = Math.max(1, lw >> 1);
            lh = Math.max(1, lh >> 1);
            const a = this._makeTarget(lw, lh, ifmt, gl.RGBA, type, gl.LINEAR);
            const b = a ? this._makeTarget(lw, lh, ifmt, gl.RGBA, type, gl.LINEAR) : null;
            if (!a || !b) {
              if (a) { gl.deleteFramebuffer(a.fbo); gl.deleteTexture(a.tex); }
              throw new Error('bloom level ' + i + ' (' + lw + 'x' + lh + ') is not renderable');
            }
            p.levels.push({ w: lw, h: lh, a, b });
          }
          const sw = p.levels.length > 1 ? p.levels[1].w : Math.max(1, w >> 2);
          const sh2 = p.levels.length > 1 ? p.levels[1].h : Math.max(1, h >> 2);
          p.streakA = this._makeTarget(sw, sh2, ifmt, gl.RGBA, type, gl.LINEAR);
          p.streakB = p.streakA ? this._makeTarget(sw, sh2, ifmt, gl.RGBA, type, gl.LINEAR) : null;
          // The streak is a garnish: losing it must not cost the whole bloom chain.
          if (!p.streakA || !p.streakB) {
            if (p.streakA) { gl.deleteFramebuffer(p.streakA.fbo); gl.deleteTexture(p.streakA.tex); }
            p.streakA = null;
            p.streakB = null;
          }
        }
        p.useBloom = p.levels.length > 0;

        // The LDR target the composite writes when FXAA is going to resolve it to the screen.
        // Losing it is not fatal: the composite simply writes the screen directly instead.
        if (wantFxaa) p.ldr = this._makeTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        p.useFxaa = !!p.ldr;

        p.w = w;
        p.h = h;
        p.sig = sig;
        p.ready = true;
        return true;
      } catch (err) {
        this._destroyTargets();
        this._postSupported = false;
        this._bloomSupported = false;
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fail('post', 'framebuffer setup failed', err);
        this._resolveQuality();
        return false;
      }
    }
    return false;
  },
};

/* -------------------------------------------------------------- defaults -- */

// The offscreen target set, filled in by _ensureTargets.
export function makePostTargets() {
  return {
    ready: false, sig: '', w: 0, h: 0, encode: false,
    scene: null, mat: null, depthTex: null, depthRb: null, resolve: null,
    aoA: null, aoB: null, ssr: null, streakA: null, streakB: null, ldr: null,
    levels: [], useAo: false, useSsr: false, useBloom: false, useFxaa: false,
  };
}
