// src/render/programs.js -- every GLSL program in the project, built once.
//
// The scene, sky, water and blob-shadow programs are REQUIRED: without them there is nothing
// to look at, so a failure here is fatal and boot reports it. Everything else is optional by
// construction -- if the cascade, text, bloom, SSAO, SSR, resolve or FXAA program refuses to
// compile on some driver, that feature latches itself off with one warning and the city still
// boots and renders (CONTRACT 3.2).
//
// This is also the context-loss rebuild path: every GPU object below belongs to the context
// that created it, so after a restore the handles are dropped rather than deleted and this
// runs again from scratch.

import { Shader } from '../core/gl.js';
import { getFont } from './font.js';
import { SCENE_VS, SCENE_FS } from './shaders/scene.glsl.js';
import { TEXT_VS, TEXT_FS } from './shaders/text.glsl.js';
import { SKY_VS, SKY_FS } from './shaders/sky.glsl.js';
import { WATER_VS, WATER_FS } from './shaders/water.glsl.js';
import { CSM_VS, CSM_FS, GSHADOW_VS, GSHADOW_FS } from './shaders/shadow.glsl.js';
import {
  POST_VS, SSAO_FS, AOBLUR_FS, SSR_FS, RESOLVE_FS, BRIGHT_FS, BLUR_FS, COMP_FS, FXAA_FS,
} from './shaders/post.glsl.js';

// Mixed into Renderer.prototype by renderer.js. Called from the constructor and again after a
// context restore.
export const ProgramMethods = {
  _createGpuResources() {
    const gl = this.gl;

    // Required: without these there is nothing to look at, so a failure here is fatal and the
    // caller (main.js boot) reports it.
    this.sceneShader = new Shader(gl, SCENE_VS, SCENE_FS);
    this.skyShader = new Shader(gl, SKY_VS, SKY_FS);
    this.waterShader = new Shader(gl, WATER_VS, WATER_FS);
    this.gshadowShader = new Shader(gl, GSHADOW_VS, GSHADOW_FS);

    // A VAO with zero enabled attribute arrays — the sky triangle and every post pass generate
    // their vertices from gl_VertexID and need no vertex data at all.
    this.skyVao = gl.createVertexArray();

    // Everything below is optional by construction: if any of it refuses to compile on some
    // driver, that feature turns itself off and the game still boots and renders.
    this.csmShader = null;
    this.textShader = null;
    this.font = null;
    this.brightShader = null;
    this.blurShader = null;
    this.compShader = null;
    this.ssaoShader = null;
    this.aoBlurShader = null;
    this.ssrShader = null;
    this.resolveShader = null;
    this.fxaaShader = null;

    if (this._shadowSupported) {
      try {
        this.csmShader = new Shader(gl, CSM_VS, CSM_FS);
      } catch (err) {
        this._shadowSupported = false;
        this._fail('shadows', 'the depth-only shader would not compile', err);
      }
    }
    // Text. Optional like everything else here: a platform with no 2-D canvas, or a driver that
    // will not take the atlas, loses signage and keeps the city.
    if (this._textSupported) {
      try {
        this.font = getFont(gl);
        if (!this.font || !this.font.texture) throw new Error('the glyph atlas could not be built');
        this.textShader = new Shader(gl, TEXT_VS, TEXT_FS);
      } catch (err) {
        if (this.textShader) {
          try { this.textShader.dispose(); } catch (e) { /* best effort */ }
        }
        this.textShader = null;
        this.font = null;
        this._textSupported = false;
        this._fail('text', 'the world-text pass could not be built', err);
      }
    }
    if (this._bloomSupported) {
      try {
        this.brightShader = new Shader(gl, POST_VS, BRIGHT_FS);
        this.blurShader = new Shader(gl, POST_VS, BLUR_FS);
        this.compShader = new Shader(gl, POST_VS, COMP_FS);
      } catch (err) {
        this._bloomSupported = false;
        this._fail('bloom', 'post shaders would not compile', err);
      }
    }
    // The composite is also what grades the frame when SSAO/SSR run without bloom, so if it is
    // missing there is no offscreen path at all.
    if (!this.compShader) {
      this._postSupported = false;
    }
    if (this._ssaoSupported && this._postSupported) {
      try {
        this.ssaoShader = new Shader(gl, POST_VS, SSAO_FS);
        this.aoBlurShader = new Shader(gl, POST_VS, AOBLUR_FS);
      } catch (err) {
        this._ssaoSupported = false;
        this._fail('ssao', 'the SSAO shaders would not compile', err);
      }
    }
    if (this._ssrSupported && this._postSupported) {
      try {
        this.ssrShader = new Shader(gl, POST_VS, SSR_FS);
      } catch (err) {
        this._ssrSupported = false;
        this._fail('ssr', 'the SSR shader would not compile', err);
      }
    }
    if ((this._ssaoSupported || this._ssrSupported) && this._postSupported) {
      try {
        this.resolveShader = new Shader(gl, POST_VS, RESOLVE_FS);
      } catch (err) {
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fail('ssao/ssr', 'the resolve shader would not compile', err);
      }
    }

    if (this._fxaaSupported && this._postSupported) {
      try {
        this.fxaaShader = new Shader(gl, POST_VS, FXAA_FS);
      } catch (err) {
        this._fxaaSupported = false;
        this._fail('fxaa', 'the FXAA shader would not compile', err);
      }
    }

    this._makeDummyShadow();
    // The light tables are GPU textures and a context loss takes them with it. The handles are
    // dropped rather than deleted — deleting through the fresh context is invalid — and remade.
    if (this._lights) {
      this._lights.dataTex = null;
      this._lights.gridTex = null;
      this._lights.ready = false;
      this._lights.count = 0;
      this._makeLightTables();
    }

    this._shader = null;
    this._vao = null;
    this._tr = -1; this._tg = -1; this._tb = -1;
    this._flash = -1;
    this._alpha = -1;
    this._shadowAlpha = -1;
    // Uniform values are per-PROGRAM GL state, so the text pass keeps its own cache rather than
    // sharing the scene pass's and believing a value the other program set.
    this._txTr = -1; this._txTg = -1; this._txTb = -1;
    this._txAlpha = -1;
  },
};
