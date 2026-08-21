// tools/shadercheck.mjs — the renderer's safety net, the way fingerprint.mjs is the geometry's.
//
//   node tools/shadercheck.mjs             build every program, print the table, write the baseline
//   node tools/shadercheck.mjs --check     build every program, compare against the baseline
//   node tools/shadercheck.mjs --quiet     summary only, no per-program table
//   node tools/shadercheck.mjs --out FILE  write/read a different baseline file
//
// WHY THIS EXISTS. The GLSL lives in JS template literals and is composed by string interpolation
// (render/shaders/*.glsl.js), so the two things most likely to break it are invisible to
// `node --check`: a stray BACKTICK inside a shader or a shader comment silently terminates the
// literal and reshapes the program, and a uniform that a refactor renames on one side only becomes
// a silent no-op, because Shader.set() ignores names the program does not declare (that is its
// contract — it is what lets one uniform block serve several programs).
//
// So this constructs the real Renderer against a FAKE WebGL2 context, which:
//   * records the exact source string handed to every shader stage, and hashes it;
//   * parses the uniform declarations out of that source and serves them back through
//     getActiveUniform, so Shader builds its real uniform table;
//   * records every uniform WRITE the renderer makes, with its value, over a scripted set of
//     frames at four quality/time-of-day presets;
//   * records every write that MISSED, i.e. a name the JS sets that no stage declares.
//
// A pure code move must not change any of that, and the baseline is what says so. What it cannot
// do is compile GLSL — there is no GL here — so it also lints each source for the failure modes
// that do not need a compiler: a truncated literal, an unexpanded interpolation, unbalanced
// braces, a missing version directive.
//
// Zero dependencies, like everything else here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.indexOf(f) >= 0;
const opt = (f, dflt) => {
  const i = ARGV.indexOf(f);
  return (i >= 0 && i + 1 < ARGV.length) ? ARGV[i + 1] : dflt;
};

const CHECK = has('--check');
const QUIET = has('--quiet');
const OUT = resolve(ROOT, opt('--out', 'tools/shaders.baseline.json'));

const FORMAT = 2;
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ stubs -- */

globalThis.performance = { now: () => 0 };

// A 2-D canvas that measures and draws nothing. The atlas it produces is blank, which is fine:
// this file checks the text PROGRAM, not the glyphs. render/font.js only needs the calls to
// succeed so that the renderer does not latch text off before building its shader.
if (typeof globalThis.document === 'undefined') {
  const ctx = {
    font: '', textAlign: '', textBaseline: '', fillStyle: '',
    measureText(s) {
      const n = String(s).length;
      return {
        width: n * 100,
        actualBoundingBoxAscent: 140, actualBoundingBoxDescent: 40,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: n * 100,
      };
    },
    clearRect() {}, fillText() {},
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
  };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return { width: 0, height: 0, getContext: (k) => (k === '2d' ? ctx : null) };
    },
  };
}

const GLSL_TYPES = {
  float: 'FLOAT', vec2: 'FLOAT_VEC2', vec3: 'FLOAT_VEC3', vec4: 'FLOAT_VEC4',
  mat2: 'FLOAT_MAT2', mat3: 'FLOAT_MAT3', mat4: 'FLOAT_MAT4',
  int: 'INT', bool: 'BOOL', ivec2: 'INT_VEC2', ivec3: 'INT_VEC3', ivec4: 'INT_VEC4',
  uint: 'UNSIGNED_INT', uvec2: 'UNSIGNED_INT_VEC2', uvec3: 'UNSIGNED_INT_VEC3',
  uvec4: 'UNSIGNED_INT_VEC4',
  sampler2D: 'SAMPLER_2D', sampler2DShadow: 'SAMPLER_2D_SHADOW',
  isampler2D: 'INT_SAMPLER_2D', usampler2D: 'UNSIGNED_INT_SAMPLER_2D',
  sampler3D: 'SAMPLER_3D', samplerCube: 'SAMPLER_CUBE',
};

const stripComments = (src) =>
  String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

function declaredUniforms(src) {
  const out = [];
  const re =
    /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
  const clean = stripComments(src);
  let m;
  while ((m = re.exec(clean)) !== null) {
    out.push({ type: m[1], name: m[2], size: m[3] ? (m[3] | 0) : 1 });
  }
  return out;
}

const record = { programs: [] };

function makeFakeGL() {
  const enums = new Map();
  let nextEnum = 0x1000;
  let id = 1;
  const shaders = new Map();
  const canvas = { width: 1440, height: 900, addEventListener() {}, removeEventListener() {} };

  const fns = {
    canvas, drawingBufferWidth: 1440, drawingBufferHeight: 900,

    createShader(type) { return { id: id++, type }; },
    shaderSource(sh, src) { shaders.set(sh, String(src)); },
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    deleteShader(sh) { shaders.delete(sh); },

    createProgram() { return { id: id++, stages: [], uniforms: [] }; },
    attachShader(p, sh) { p.stages.push(shaders.get(sh)); },
    detachShader() {},
    bindAttribLocation() {},
    linkProgram(p) {
      const seen = new Set();
      for (const src of p.stages) {
        for (const u of declaredUniforms(src)) {
          if (seen.has(u.name)) continue;
          seen.add(u.name);
          p.uniforms.push(u);
        }
      }
      const vs = p.stages[0] || '';
      const fs = p.stages[1] || '';
      p.rec = {
        label: 'program' + record.programs.length,
        index: record.programs.length,
        vs, fs, vsSha: sha(vs), fsSha: sha(fs),
        declared: p.uniforms.map(
          (u) => u.name + ':' + u.type + (u.size > 1 ? '[' + u.size + ']' : '')
        ).sort(),
        writes: [], missed: [],
      };
      record.programs.push(p.rec);
    },
    getProgramParameter(p, pname) {
      if (pname === gl.LINK_STATUS) return true;
      if (pname === gl.ACTIVE_UNIFORMS) return p.uniforms.length;
      return 0;
    },
    getProgramInfoLog() { return ''; },
    getActiveUniform(p, i) {
      const u = p.uniforms[i];
      if (!u) return null;
      const t = GLSL_TYPES[u.type];
      return {
        name: u.size > 1 ? (u.name + '[0]') : u.name,
        type: t ? gl[t] : gl.SAMPLER_2D,
        size: u.size,
      };
    },
    getUniformLocation(p, name) { return { p: p.id, name }; },
    deleteProgram() {}, useProgram() {},

    createVertexArray() { return { id: id++ }; }, bindVertexArray() {}, deleteVertexArray() {},
    createTexture() { return { id: id++ }; }, activeTexture() {}, bindTexture() {},
    texImage2D() {}, texSubImage2D() {}, texParameteri() {}, generateMipmap() {}, pixelStorei() {},
    deleteTexture() {},
    createFramebuffer() { return { id: id++ }; }, bindFramebuffer() {},
    framebufferTexture2D() {}, framebufferRenderbuffer() {},
    checkFramebufferStatus() { return gl.FRAMEBUFFER_COMPLETE; },
    drawBuffers() {}, readBuffer() {}, deleteFramebuffer() {},
    createRenderbuffer() { return { id: id++ }; }, bindRenderbuffer() {},
    renderbufferStorage() {}, deleteRenderbuffer() {},

    getParameter(pname) { return pname === gl.MAX_TEXTURE_SIZE ? 16384 : 0; },
    getExtension(name) {
      return (name === 'EXT_color_buffer_float' || name === 'EXT_color_buffer_half_float')
        ? {} : null;
    },
    getError() { return gl.NO_ERROR; },

    viewport() {}, enable() {}, disable() {}, blendFunc() {}, depthMask() {}, depthFunc() {},
    frontFace() {}, cullFace() {}, polygonOffset() {}, clearColor() {}, clearDepth() {},
    clear() {}, drawArrays() {},
  };
  for (let i = 1; i <= 4; i++) {
    for (const k of ['f', 'i', 'ui']) {
      fns['uniform' + i + k] = () => {};
      fns['uniform' + i + k + 'v'] = () => {};
    }
    fns['uniformMatrix' + i + 'fv'] = () => {};
  }

  const target = Object.assign(Object.create(null), fns);
  const gl = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]*$/.test(prop)) {
        if (!enums.has(prop)) enums.set(prop, nextEnum++);
        return enums.get(prop);
      }
      return undefined;
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has() { return true; },
  });
  return gl;
}

/* ------------------------------------------------------------- the drive -- */

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

const gl = makeFakeGL();

const { Shader } = await import(resolve(ROOT, 'src/core/gl.js'));
const rawSet = Shader.prototype.set;
const rawSetTexture = Shader.prototype.setTexture;

// Uniform values, rendered so a change of one bit in a fitted constant shows up as a difference.
function sig(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(7);
  if (typeof v === 'boolean') return String(v);
  if (typeof v.length === 'number') {
    let s = '[';
    for (let i = 0; i < v.length; i++) {
      const n = v[i];
      s += (i ? ',' : '') +
        (Number.isFinite(n) ? (Number.isInteger(n) ? n : n.toFixed(7)) : String(n));
    }
    return s + ']';
  }
  return typeof v;
}

Shader.prototype.set = function set(name, value) {
  const rec = this.program && this.program.rec;
  if (rec) {
    if (this.uniforms.has(name)) rec.writes.push(name + '=' + sig(value));
    else if (rec.missed.indexOf(name) < 0) rec.missed.push(name);
  }
  return rawSet.call(this, name, value);
};
Shader.prototype.setTexture = function setTexture(name, unit, tex) {
  const rec = this.program && this.program.rec;
  if (rec) {
    if (this.uniforms.has(name)) rec.writes.push(name + '@' + unit + (tex ? '+' : '-'));
    else if (rec.missed.indexOf(name) < 0) rec.missed.push(name);
  }
  return rawSetTexture.call(this, name, unit, tex);
};

const { Camera, Renderer } = await import(resolve(ROOT, 'src/render/renderer.js'));

const cam = new Camera();
cam.pos[0] = 120; cam.pos[1] = 240; cam.pos[2] = -400;
cam.target[0] = -30; cam.target[1] = 90; cam.target[2] = 260;
cam.aspect = 1440 / 900;
cam.near = 0.8;
cam.update();

const r = new Renderer(gl);
r.resize(1440, 900);

// Fake meshes: the renderer only ever reads vao and vertexCount off one.
const mesh = (n, k) => ({ vao: { id: 900 + k }, vertexCount: n });
const opaque = mesh(3600, 1);
const props = mesh(900, 2);
const water = mesh(600, 3);
const signs = mesh(300, 4);

// A lamp field big enough to fill the cluster window and overflow some cells.
const lamps = [];
const KINDS = ['cobra', 'led', 'acorn', 'ped', 'shop', 'signal', 'tunnel'];
for (let i = 0; i < 400; i++) {
  lamps.push({
    x: -300 + (i % 20) * 34, y: 9.5, z: -300 + Math.floor(i / 20) * 31,
    kind: KINDS[i % KINDS.length],
  });
}
const registered = r.setLights(lamps);
r.setShadowCasters([opaque, props]);

const PRESETS = [
  { name: 'blue-hour ultra', daylight: 0,
    q: { shadows: 'high', ssao: true, ssr: true, bloom: true, clouds: true, fxaa: true, lights: true } },
  { name: 'afternoon ultra', daylight: 1,
    q: { shadows: 'high', ssao: true, ssr: true, bloom: true, clouds: true, fxaa: true, lights: true } },
  { name: 'dusk low', daylight: 0.35,
    q: { shadows: 'low', ssao: false, ssr: true, bloom: true, clouds: false, fxaa: false, lights: true } },
  { name: 'night minimal', daylight: 0,
    q: { shadows: 'off', ssao: false, ssr: false, bloom: false, clouds: false, fxaa: false, lights: false } },
];

const frames = [];
for (const p of PRESETS) {
  r.env.daylight = p.daylight;
  r.env.time = 12.5;
  Object.assign(r.quality, p.q);
  r.beginFrame(cam);
  r.drawMesh(opaque, null);
  r.drawMesh(props, null, [0.9, 0.8, 0.7], 0.25, 0.5);
  r.drawShadowMesh(props, 0.4);
  r.drawText(signs, null, [1, 1, 1], 0.8);
  r.drawWater(water, cam);
  r.endFrame();
  frames.push({
    preset: p.name,
    draws: r.stats.draws, tris: r.stats.tris, postPasses: r.stats.postPasses,
    shadowDraws: r.stats.shadowDraws, programSwaps: r.stats.programSwaps,
    cascades: r.shadowStats.count,
    reach: +r.shadowStats.reach.toFixed(4),
    worstRatio: +r.shadowStats.worstRatio.toFixed(6),
    texel: Array.from(r.shadowStats.texel, (v) => +v.toFixed(9)),
    lights: r.lightStats.uploaded + '/' + r.lightStats.candidates +
      ' binned ' + r.lightStats.binned + ' dropped ' + r.lightStats.dropped +
      ' maxCell ' + r.lightStats.maxCell,
  });
}

console.warn = realWarn;

// Name each program after the renderer property that holds it, so the table reads.
const NAMED = [
  'sceneShader', 'skyShader', 'waterShader', 'gshadowShader', 'csmShader', 'textShader',
  'brightShader', 'blurShader', 'compShader', 'ssaoShader', 'aoBlurShader', 'ssrShader',
  'resolveShader', 'fxaaShader',
];
for (const key of NAMED) {
  const s = r[key];
  if (s && s.program && s.program.rec) s.program.rec.label = key.replace(/Shader$/, '');
}

/* -------------------------------------------------------------- GLSL lint -- */

function lint(label, stage, src) {
  const out = [];
  const s = String(src);
  if (s.indexOf('`') >= 0) out.push('contains a BACKTICK — the template literal is broken');
  if (s.indexOf('${') >= 0) out.push('contains an unexpanded ${...} interpolation');
  if (s.trim().indexOf('#version 300 es') !== 0) out.push('does not start with #version 300 es');
  if (!/\bvoid\s+main\s*\(/.test(s)) out.push('has no main()');
  if (!/\bprecision\s+(highp|mediump|lowp)\s+float\s*;/.test(s)) {
    out.push('declares no float precision');
  }
  const clean = stripComments(s);
  const count = (ch) => (clean.split(ch).length - 1);
  if (count('{') !== count('}')) out.push('unbalanced braces (' + count('{') + ' vs ' + count('}') + ')');
  if (count('(') !== count(')')) out.push('unbalanced parens (' + count('(') + ' vs ' + count(')') + ')');
  return out.map((m) => label + ' ' + stage + ': ' + m);
}

const lintErrors = [];
for (const p of record.programs) {
  lintErrors.push(...lint(p.label, 'vertex', p.vs));
  lintErrors.push(...lint(p.label, 'fragment', p.fs));
}

/* -------------------------------------------------------------- reporting -- */

const snapshot = {
  format: FORMAT,
  registered,
  programs: record.programs.map((p) => {
    // The uniform set the program DECLARES against the set the JS actually writes, both ways:
    //   missed  a name the JS sets that no stage declares — a silent no-op, and exactly the
    //           shape a half-finished rename leaves behind
    //   unset   a name the program declares that nothing wrote over the whole drive — dead, or
    //           reachable only on a path these four presets do not take
    const written = new Set(p.writes.map((w) => w.split(/[=@]/)[0]));
    const unset = p.declared
      .map((d) => d.split(':')[0])
      .filter((n) => !written.has(n))
      .sort();
    return {
      label: p.label,
      vsSha: p.vsSha, fsSha: p.fsSha,
      vsLines: p.vs.split('\n').length, fsLines: p.fs.split('\n').length,
      declared: p.declared,
      writes: p.writes.length,
      writesSha: sha(p.writes.join('\n')),
      missed: p.missed.slice().sort(),
      unset,
    };
  }),
  frames,
  warnings,
};

if (!QUIET) {
  console.log('=== shader check ' + '='.repeat(56));
  console.log('  program        vs lines  fs lines   uniforms   writes  missed  unset');
  for (const p of snapshot.programs) {
    console.log('  ' + p.label.padEnd(14) +
      String(p.vsLines).padStart(8) + String(p.fsLines).padStart(10) +
      String(p.declared.length).padStart(11) + String(p.writes).padStart(9) +
      String(p.missed.length).padStart(8) + String(p.unset.length).padStart(7) +
      (p.missed.length ? '  missed: ' + p.missed.join(' ') : '') +
      (p.unset.length ? '  unset: ' + p.unset.join(' ') : ''));
  }
  console.log('');
  for (const f of frames) {
    console.log('  ' + f.preset.padEnd(16) + String(f.draws).padStart(4) + ' draws, ' +
      String(f.postPasses).padStart(3) + ' post, ' + String(f.shadowDraws).padStart(4) +
      ' shadow, ' + f.cascades + ' cascades to ' + Math.round(f.reach) + ' m, lights ' + f.lights);
  }
  console.log('');
}

let failed = false;

for (const m of lintErrors) {
  console.log('  LINT  ' + m);
  failed = true;
}
for (const p of snapshot.programs) {
  if (p.missed.length) {
    // Not fatal by itself — one uniform block deliberately serves several programs — but it is
    // the shape a renamed uniform takes, so it is always reported.
    console.log('  NOTE  ' + p.label + ' is written uniforms it does not declare: ' +
      p.missed.join(' '));
  }
}
for (const w of warnings) console.log('  WARN  ' + w);

if (CHECK) {
  console.log('--- shader check ' + '-'.repeat(56));
  if (!existsSync(OUT)) {
    console.log('  FAIL  no baseline at ' + OUT + ' — run without --check first');
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(OUT, 'utf8'));
  const diffs = [];
  if (base.format !== FORMAT) diffs.push('baseline format ' + base.format + ' != ' + FORMAT);
  if (base.registered !== snapshot.registered) {
    diffs.push('lights registered ' + base.registered + ' -> ' + snapshot.registered);
  }
  const byLabel = (list) => {
    const m = new Map();
    for (const p of list) m.set(p.label, p);
    return m;
  };
  const A = byLabel(base.programs || []);
  const B = byLabel(snapshot.programs);
  for (const [label, a] of A) {
    const b = B.get(label);
    if (!b) { diffs.push('program ' + label + ' is gone'); continue; }
    if (a.vsSha !== b.vsSha) diffs.push(label + ' vertex source changed (' + a.vsSha + ' -> ' + b.vsSha + ')');
    if (a.fsSha !== b.fsSha) diffs.push(label + ' fragment source changed (' + a.fsSha + ' -> ' + b.fsSha + ')');
    const da = new Set(a.declared), db = new Set(b.declared);
    for (const u of da) if (!db.has(u)) diffs.push(label + ' no longer declares ' + u);
    for (const u of db) if (!da.has(u)) diffs.push(label + ' newly declares ' + u);
    if (a.writesSha !== b.writesSha) {
      diffs.push(label + ' uniform writes changed (' + a.writes + ' -> ' + b.writes + ' writes)');
    }
    if (a.missed.join(' ') !== b.missed.join(' ')) {
      diffs.push(label + ' missed writes: [' + a.missed.join(' ') + '] -> [' + b.missed.join(' ') + ']');
    }
    if ((a.unset || []).join(' ') !== b.unset.join(' ')) {
      diffs.push(label + ' never-written uniforms: [' + (a.unset || []).join(' ') +
        '] -> [' + b.unset.join(' ') + ']');
    }
  }
  for (const label of B.keys()) if (!A.has(label)) diffs.push('program ' + label + ' is new');
  if (JSON.stringify(base.frames) !== JSON.stringify(snapshot.frames)) {
    for (let i = 0; i < Math.max((base.frames || []).length, frames.length); i++) {
      const a = (base.frames || [])[i], b = frames[i];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push('frame ' + i + ' (' + ((b && b.preset) || (a && a.preset)) + ') differs:\n' +
          '          was ' + JSON.stringify(a) + '\n          now ' + JSON.stringify(b));
      }
    }
  }
  if ((base.warnings || []).join('|') !== warnings.join('|')) {
    diffs.push('warnings: [' + (base.warnings || []).join(' | ') + '] -> [' + warnings.join(' | ') + ']');
  }

  if (diffs.length || failed) {
    for (const d of diffs) console.log('  DIFF  ' + d);
    console.log('  FAIL  ' + (diffs.length + lintErrors.length) + ' difference(s)');
    process.exit(1);
  }
  console.log('  PASS  ' + snapshot.programs.length + ' programs, ' +
    snapshot.programs.reduce((n, p) => n + p.declared.length, 0) + ' uniforms declared, ' +
    snapshot.programs.reduce((n, p) => n + p.writes, 0) + ' writes, identical');
} else {
  if (failed) {
    console.log('  FAIL  the GLSL lint found problems; baseline NOT written');
    process.exit(1);
  }
  writeFileSync(OUT, JSON.stringify(snapshot, null, 1));
  console.log('  wrote ' + OUT);
}
