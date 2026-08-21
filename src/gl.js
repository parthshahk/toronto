// src/gl.js — WebGL2 plumbing: context creation, a Shader wrapper with
// type-dispatched uniform setting, static/dynamic interleaved triangle meshes, and a fast
// zero-allocation MeshBuilder. Vertex format (NORMATIVE, 11 floats, non-indexed triangles):
//   [ px, py, pz,  nx, ny, nz,  r, g, b,  emissive, tintable ]
// Winding: counter-clockwise = front face (the renderer culls BACK faces).
// Zero dependencies.

export const VERT_FLOATS = 13;
export const ATTR = { pos: 0, normal: 1, color: 2, mat: 3 };

const STRIDE = VERT_FLOATS * 4;
const EPS = 1e-8;
const TAU = Math.PI * 2;
// Key used to remember which program is bound on a given context (avoids a sync getParameter).
const CURRENT_PROGRAM = '__vhCurrentProgram';

/* ------------------------------------------------------------------ context */

export function createGL(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
  } catch (e) {
    gl = null;
  }
  if (!gl) throw new Error('WebGL2 not supported');
  gl[CURRENT_PROGRAM] = null;
  return gl;
}

/* ------------------------------------------------------------------- shader */

function numberedSource(src) {
  const lines = String(src).split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const n = String(i + 1);
    out += (n.length < 4 ? '    '.slice(n.length) + n : n) + ' | ' + lines[i] + '\n';
  }
  return out;
}

function compileStage(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '(empty info log)';
    gl.deleteShader(sh);
    throw new Error(
      'GLSL ' + label + ' shader failed to compile:\n' + log +
      '\n----- ' + label + ' source -----\n' + numberedSource(src)
    );
  }
  return sh;
}

function samplerTarget(gl, type) {
  switch (type) {
    case gl.SAMPLER_2D:
    case gl.SAMPLER_2D_SHADOW:
    case gl.INT_SAMPLER_2D:
    case gl.UNSIGNED_INT_SAMPLER_2D:
      return gl.TEXTURE_2D;
    case gl.SAMPLER_CUBE:
    case gl.SAMPLER_CUBE_SHADOW:
      return gl.TEXTURE_CUBE_MAP;
    case gl.SAMPLER_3D:
    case gl.INT_SAMPLER_3D:
    case gl.UNSIGNED_INT_SAMPLER_3D:
      return gl.TEXTURE_3D;
    case gl.SAMPLER_2D_ARRAY:
    case gl.SAMPLER_2D_ARRAY_SHADOW:
    case gl.INT_SAMPLER_2D_ARRAY:
    case gl.UNSIGNED_INT_SAMPLER_2D_ARRAY:
      return gl.TEXTURE_2D_ARRAY;
    default:
      return 0;
  }
}

function isArrayLike(v) {
  return v !== null && typeof v === 'object' && typeof v.length === 'number';
}

function makeSetter(gl, type, loc) {
  switch (type) {
    case gl.FLOAT:
      return (v) => {
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (isArrayLike(v)) gl.uniform1fv(loc, v);
      };
    case gl.FLOAT_VEC2:
      return (v) => { if (isArrayLike(v)) gl.uniform2fv(loc, v); };
    case gl.FLOAT_VEC3:
      return (v) => { if (isArrayLike(v)) gl.uniform3fv(loc, v); };
    case gl.FLOAT_VEC4:
      return (v) => { if (isArrayLike(v)) gl.uniform4fv(loc, v); };
    case gl.FLOAT_MAT2:
      return (v) => { if (isArrayLike(v)) gl.uniformMatrix2fv(loc, false, v); };
    case gl.FLOAT_MAT3:
      return (v) => { if (isArrayLike(v)) gl.uniformMatrix3fv(loc, false, v); };
    case gl.FLOAT_MAT4:
      return (v) => { if (isArrayLike(v)) gl.uniformMatrix4fv(loc, false, v); };
    case gl.INT:
    case gl.BOOL:
      return (v) => {
        if (typeof v === 'number') gl.uniform1i(loc, v | 0);
        else if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
        else if (isArrayLike(v)) gl.uniform1iv(loc, v);
      };
    case gl.INT_VEC2:
    case gl.BOOL_VEC2:
      return (v) => { if (isArrayLike(v)) gl.uniform2iv(loc, v); };
    case gl.INT_VEC3:
    case gl.BOOL_VEC3:
      return (v) => { if (isArrayLike(v)) gl.uniform3iv(loc, v); };
    case gl.INT_VEC4:
    case gl.BOOL_VEC4:
      return (v) => { if (isArrayLike(v)) gl.uniform4iv(loc, v); };
    case gl.UNSIGNED_INT:
      return (v) => {
        if (typeof v === 'number') gl.uniform1ui(loc, v >>> 0);
        else if (isArrayLike(v)) gl.uniform1uiv(loc, v);
      };
    case gl.UNSIGNED_INT_VEC2:
      return (v) => { if (isArrayLike(v)) gl.uniform2uiv(loc, v); };
    case gl.UNSIGNED_INT_VEC3:
      return (v) => { if (isArrayLike(v)) gl.uniform3uiv(loc, v); };
    case gl.UNSIGNED_INT_VEC4:
      return (v) => { if (isArrayLike(v)) gl.uniform4uiv(loc, v); };
    default:
      // Samplers and anything exotic: a single integer texture unit.
      return (v) => {
        if (typeof v === 'number') gl.uniform1i(loc, v | 0);
        else if (isArrayLike(v)) gl.uniform1iv(loc, v);
      };
  }
}

export class Shader {
  constructor(gl, vsSource, fsSource) {
    this.gl = gl;
    this.program = null;
    this.uniforms = new Map();

    const vs = compileStage(gl, gl.VERTEX_SHADER, vsSource, 'vertex');
    let fs;
    try {
      fs = compileStage(gl, gl.FRAGMENT_SHADER, fsSource, 'fragment');
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    // Fixed attribute locations. Shaders may also use layout(location=) qualifiers, which win;
    // both agree with ATTR so the binding is a safety net for shaders written without qualifiers.
    gl.bindAttribLocation(prog, ATTR.pos, 'aPos');
    gl.bindAttribLocation(prog, ATTR.normal, 'aNormal');
    gl.bindAttribLocation(prog, ATTR.color, 'aColor');
    gl.bindAttribLocation(prog, ATTR.mat, 'aMat');
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || '(empty info log)';
      gl.detachShader(prog, vs);
      gl.detachShader(prog, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      throw new Error(
        'GLSL program failed to link:\n' + log +
        '\n----- vertex source -----\n' + numberedSource(vsSource) +
        '\n----- fragment source -----\n' + numberedSource(fsSource)
      );
    }

    gl.detachShader(prog, vs);
    gl.detachShader(prog, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      const rawName = info.name;
      const loc = gl.getUniformLocation(prog, rawName);
      if (loc === null) continue;
      const entry = {
        loc,
        type: info.type,
        size: info.size,
        target: samplerTarget(gl, info.type),
        setter: makeSetter(gl, info.type, loc),
      };
      this.uniforms.set(rawName, entry);
      // 'uThing[0]' is also reachable as 'uThing'.
      const br = rawName.indexOf('[');
      if (br > 0) this.uniforms.set(rawName.slice(0, br), entry);
    }
  }

  use() {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl[CURRENT_PROGRAM] = this.program;
    return this;
  }

  set(name, value) {
    const u = this.uniforms.get(name);
    if (u === undefined) return this;   // unknown uniform: silent no-op by contract
    if (this.gl[CURRENT_PROGRAM] !== this.program) this.use();
    u.setter(value);
    return this;
  }

  setTexture(name, unit, texture) {
    const u = this.uniforms.get(name);
    if (u === undefined) return this;
    const gl = this.gl;
    if (gl[CURRENT_PROGRAM] !== this.program) this.use();
    const target = u.target || gl.TEXTURE_2D;
    gl.activeTexture(gl.TEXTURE0 + (unit | 0));
    gl.bindTexture(target, texture || null);
    gl.uniform1i(u.loc, unit | 0);
    return this;
  }

  dispose() {
    const gl = this.gl;
    if (this.program) {
      if (gl[CURRENT_PROGRAM] === this.program) {
        gl.useProgram(null);
        gl[CURRENT_PROGRAM] = null;
      }
      gl.deleteProgram(this.program);
      this.program = null;
    }
    this.uniforms.clear();
  }
}

/* -------------------------------------------------------------------- meshes */

function bindVertexFormat(gl) {
  gl.enableVertexAttribArray(ATTR.pos);
  gl.vertexAttribPointer(ATTR.pos, 3, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(ATTR.normal);
  gl.vertexAttribPointer(ATTR.normal, 3, gl.FLOAT, false, STRIDE, 12);
  gl.enableVertexAttribArray(ATTR.color);
  gl.vertexAttribPointer(ATTR.color, 3, gl.FLOAT, false, STRIDE, 24);
  gl.enableVertexAttribArray(ATTR.mat);
  gl.vertexAttribPointer(ATTR.mat, 4, gl.FLOAT, false, STRIDE, 36);
}

export class Mesh {
  constructor(gl, floats) {
    const data = (floats instanceof Float32Array) ? floats : new Float32Array(floats || 0);
    this.gl = gl;
    this.vertexCount = (data.length / VERT_FLOATS) | 0;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    bindVertexFormat(gl);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  draw() {
    if (this.vertexCount <= 0 || !this.vao) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }

  dispose() {
    const gl = this.gl;
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.vbo) { gl.deleteBuffer(this.vbo); this.vbo = null; }
    this.vertexCount = 0;
  }
}

export class DynamicMesh {
  constructor(gl, maxVerts) {
    this.gl = gl;
    this.maxVerts = Math.max(0, maxVerts | 0);
    this.vertexCount = 0;
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.maxVerts * STRIDE, gl.DYNAMIC_DRAW);
    bindVertexFormat(gl);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  upload(floats, vertexCount) {
    const gl = this.gl;
    let n = (vertexCount === undefined || vertexCount === null)
      ? ((floats ? floats.length : 0) / VERT_FLOATS) | 0
      : vertexCount | 0;
    if (n < 0) n = 0;
    if (n > this.maxVerts) n = this.maxVerts;
    const need = n * VERT_FLOATS;
    if (floats && floats.length < need) n = (floats.length / VERT_FLOATS) | 0;
    this.vertexCount = n;
    if (n === 0 || !this.vbo) return;
    const src = (floats instanceof Float32Array) ? floats : new Float32Array(floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, src, 0, n * VERT_FLOATS);
  }

  draw() {
    if (this.vertexCount <= 0 || !this.vao) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }

  dispose() {
    const gl = this.gl;
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.vbo) { gl.deleteBuffer(this.vbo); this.vbo = null; }
    this.vertexCount = 0;
    this.maxVerts = 0;
  }
}

/* --------------------------------------------------------------- meshbuilder */

// Module-scope scratch: local quad corners, world quad corners, ring tables.
const _LQ = new Float64Array(12);
const _WQ = new Float64Array(12);
let _rc = new Float64Array(65);
let _rs = new Float64Array(65);

function setQuad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  _LQ[0] = ax; _LQ[1] = ay; _LQ[2] = az;
  _LQ[3] = bx; _LQ[4] = by; _LQ[5] = bz;
  _LQ[6] = cx; _LQ[7] = cy; _LQ[8] = cz;
  _LQ[9] = dx; _LQ[10] = dy; _LQ[11] = dz;
}

function ringTable(seg, offset) {
  if (_rc.length < seg + 1) {
    _rc = new Float64Array(seg + 1);
    _rs = new Float64Array(seg + 1);
  }
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU + offset;
    _rc[i] = Math.cos(a);
    _rs[i] = Math.sin(a);
  }
}

export class MeshBuilder {
  constructor() {
    this._data = new Float32Array(4096);
    this._n = 0;
    this._r = 1; this._g = 1; this._b = 1; this._e = 0; this._t = 0; this._rg = 0.85; this._pf = 0;
  }

  get count() {
    return (this._n / VERT_FLOATS) | 0;
  }

  // rough: 0 = mirror-smooth, 1 = fully matte.
  // profile: night-lighting behaviour of the surface, NOT a colour —
  //   0 envelope (no windows at all: stadiums, domes, the CN Tower shaft, roofs)
  //   1 office      strict curtain-wall grid, warm + cool fluorescent, whole dark floors
  //   2 residential scattered per-unit warm points, balcony spill, occasional TV blue
  //   3 retail      bright lit ground floor, mostly dark above
  //   4 parking     open horizontal deck strips, greenish
  //   5 civic       small punched windows, mostly dark, warm
  color(r, g, b, emissive = 0, tintable = 0, rough = 0.85, profile = 0) {
    this._r = r; this._g = g; this._b = b;
    this._e = emissive; this._t = tintable; this._rg = rough; this._pf = profile;
    return this;
  }

  _grow(need) {
    let cap = this._data.length;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this._data.subarray(0, this._n));
    this._data = next;
  }

  vert(x, y, z, nx, ny, nz) {
    let n = this._n;
    if (n + VERT_FLOATS > this._data.length) this._grow(n + VERT_FLOATS);
    const d = this._data;
    d[n] = x; d[n + 1] = y; d[n + 2] = z;
    d[n + 3] = nx; d[n + 4] = ny; d[n + 5] = nz;
    d[n + 6] = this._r; d[n + 7] = this._g; d[n + 8] = this._b;
    d[n + 9] = this._e; d[n + 10] = this._t; d[n + 11] = this._rg; d[n + 12] = this._pf;
    this._n = n + VERT_FLOATS;
    return this;
  }

  // Triangle with a flat normal derived from CCW winding.
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > EPS) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
    this.vert(ax, ay, az, nx, ny, nz);
    this.vert(bx, by, bz, nx, ny, nz);
    this.vert(cx, cy, cz, nx, ny, nz);
    return this;
  }

  // a,b,c,d are [x,y,z] arrays in CCW order.
  quad(a, b, c, d) {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    return this;
  }

  // Internal: emit _LQ (4 local corners, CCW) rotated by yaw (cos c, sin s) about the Y axis
  // through (ox,oy,oz) and translated there, with the given local face normal.
  _quadLocal(ox, oy, oz, c, s, nx, ny, nz) {
    const wnx = nx * c + nz * s;
    const wnz = -nx * s + nz * c;
    for (let i = 0; i < 12; i += 3) {
      const lx = _LQ[i], ly = _LQ[i + 1], lz = _LQ[i + 2];
      _WQ[i] = ox + lx * c + lz * s;
      _WQ[i + 1] = oy + ly;
      _WQ[i + 2] = oz - lx * s + lz * c;
    }
    this.vert(_WQ[0], _WQ[1], _WQ[2], wnx, ny, wnz);
    this.vert(_WQ[3], _WQ[4], _WQ[5], wnx, ny, wnz);
    this.vert(_WQ[6], _WQ[7], _WQ[8], wnx, ny, wnz);
    this.vert(_WQ[0], _WQ[1], _WQ[2], wnx, ny, wnz);
    this.vert(_WQ[6], _WQ[7], _WQ[8], wnx, ny, wnz);
    this.vert(_WQ[9], _WQ[10], _WQ[11], wnx, ny, wnz);
    return this;
  }

  // Internal: same as _quadLocal but only the first 3 corners of _LQ.
  _triLocal(ox, oy, oz, c, s, nx, ny, nz) {
    const wnx = nx * c + nz * s;
    const wnz = -nx * s + nz * c;
    for (let i = 0; i < 9; i += 3) {
      const lx = _LQ[i], ly = _LQ[i + 1], lz = _LQ[i + 2];
      _WQ[i] = ox + lx * c + lz * s;
      _WQ[i + 1] = oy + ly;
      _WQ[i + 2] = oz - lx * s + lz * c;
    }
    this.vert(_WQ[0], _WQ[1], _WQ[2], wnx, ny, wnz);
    this.vert(_WQ[3], _WQ[4], _WQ[5], wnx, ny, wnz);
    this.vert(_WQ[6], _WQ[7], _WQ[8], wnx, ny, wnz);
    return this;
  }

  // Centred box, FULL sizes, rotated about Y by yaw. Outward normals, CCW winding.
  box(cx, cy, cz, sx, sy, sz, yaw = 0) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const c = yaw === 0 ? 1 : Math.cos(yaw);
    const s = yaw === 0 ? 0 : Math.sin(yaw);
    setQuad(hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz);
    this._quadLocal(cx, cy, cz, c, s, 1, 0, 0);
    setQuad(-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz);
    this._quadLocal(cx, cy, cz, c, s, -1, 0, 0);
    setQuad(-hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz);
    this._quadLocal(cx, cy, cz, c, s, 0, 1, 0);
    setQuad(-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz);
    this._quadLocal(cx, cy, cz, c, s, 0, -1, 0);
    setQuad(-hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz);
    this._quadLocal(cx, cy, cz, c, s, 0, 0, 1);
    setQuad(hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz);
    this._quadLocal(cx, cy, cz, c, s, 0, 0, -1);
    return this;
  }

  boxMinMax(x0, y0, z0, x1, y1, z1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    return this.box((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, bx - ax, by - ay, bz - az, 0);
  }

  // Wedge/ramp inside the same centred bounding box as box(): full height at -z, zero at +z.
  // CONTRACT-NOTE: cy is the CENTRE of the bounding box (consistent with box()), not the base.
  prism(cx, cy, cz, sx, sy, sz, yaw = 0) {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const c = yaw === 0 ? 1 : Math.cos(yaw);
    const s = yaw === 0 ? 0 : Math.sin(yaw);
    // bottom (-Y)
    setQuad(-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz);
    this._quadLocal(cx, cy, cz, c, s, 0, -1, 0);
    // back wall (-Z), full height
    setQuad(hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz);
    this._quadLocal(cx, cy, cz, c, s, 0, 0, -1);
    // slope, from the top of the back wall down to the +z edge
    let sny = hz, snz = hy;
    const sl = Math.sqrt(sny * sny + snz * snz);
    if (sl > EPS) { sny /= sl; snz /= sl; } else { sny = 1; snz = 0; }
    setQuad(-hx, -hy, hz, hx, -hy, hz, hx, hy, -hz, -hx, hy, -hz);
    this._quadLocal(cx, cy, cz, c, s, 0, sny, snz);
    // +X triangular side
    setQuad(hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, 0, 0, 0);
    this._triLocal(cx, cy, cz, c, s, 1, 0, 0);
    // -X triangular side
    setQuad(-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, -hz, 0, 0, 0);
    this._triLocal(cx, cy, cz, c, s, -1, 0, 0);
    return this;
  }

  // Cylinder/cone/tapered tube. Spans y from cy to cy+h. Smooth side normals.
  cylinder(cx, cy, cz, rBottom, rTop, h, seg = 10, yaw = 0, cap = true) {
    const n = Math.max(3, seg | 0);
    ringTable(n, -yaw);
    const y0 = cy, y1 = cy + h;
    const rb = Math.max(0, rBottom), rt = Math.max(0, rTop);
    const dr = rt - rb;
    const sl = Math.sqrt(h * h + dr * dr);
    const nr = sl > EPS ? Math.abs(h) / sl : 1;
    const nyv = sl > EPS ? -dr / sl : 0;

    if (rb > EPS || rt > EPS) {
      for (let i = 0; i < n; i++) {
        const c0 = _rc[i], s0 = _rs[i], c1 = _rc[i + 1], s1 = _rs[i + 1];
        const b0x = cx + rb * c0, b0z = cz + rb * s0;
        const b1x = cx + rb * c1, b1z = cz + rb * s1;
        const t0x = cx + rt * c0, t0z = cz + rt * s0;
        const t1x = cx + rt * c1, t1z = cz + rt * s1;
        const n0x = c0 * nr, n0z = s0 * nr;
        const n1x = c1 * nr, n1z = s1 * nr;
        // quad: bottom0 -> top0 -> top1 -> bottom1 (CCW seen from outside)
        this.vert(b0x, y0, b0z, n0x, nyv, n0z);
        this.vert(t0x, y1, t0z, n0x, nyv, n0z);
        this.vert(t1x, y1, t1z, n1x, nyv, n1z);
        this.vert(b0x, y0, b0z, n0x, nyv, n0z);
        this.vert(t1x, y1, t1z, n1x, nyv, n1z);
        this.vert(b1x, y0, b1z, n1x, nyv, n1z);
      }
    }

    if (cap) {
      if (rt > EPS) {
        for (let i = 0; i < n; i++) {
          const c0 = _rc[i], s0 = _rs[i], c1 = _rc[i + 1], s1 = _rs[i + 1];
          this.vert(cx, y1, cz, 0, 1, 0);
          this.vert(cx + rt * c1, y1, cz + rt * s1, 0, 1, 0);
          this.vert(cx + rt * c0, y1, cz + rt * s0, 0, 1, 0);
        }
      }
      if (rb > EPS) {
        for (let i = 0; i < n; i++) {
          const c0 = _rc[i], s0 = _rs[i], c1 = _rc[i + 1], s1 = _rs[i + 1];
          this.vert(cx, y0, cz, 0, -1, 0);
          this.vert(cx + rb * c0, y0, cz + rb * s0, 0, -1, 0);
          this.vert(cx + rb * c1, y0, cz + rb * s1, 0, -1, 0);
        }
      }
    }
    return this;
  }

  // UV sphere with smooth normals. `seg` = ring count; twice that around the equator.
  sphere(cx, cy, cz, r, seg = 8) {
    const rings = Math.max(2, seg | 0);
    const cols = Math.max(3, (seg | 0) * 2);
    ringTable(cols, 0);
    const rr = Math.abs(r) < EPS ? EPS : r;
    for (let i = 0; i < rings; i++) {
      const th0 = (i / rings) * Math.PI;
      const th1 = ((i + 1) / rings) * Math.PI;
      const c0 = Math.cos(th0), s0 = Math.sin(th0);
      const c1 = Math.cos(th1), s1 = Math.sin(th1);
      for (let j = 0; j < cols; j++) {
        const ca = _rc[j], sa = _rs[j];
        const cb = _rc[j + 1], sb = _rs[j + 1];
        // normals (unit) for the four corners
        const n00x = s0 * ca, n00y = c0, n00z = s0 * sa;
        const n01x = s0 * cb, n01y = c0, n01z = s0 * sb;
        const n11x = s1 * cb, n11y = c1, n11z = s1 * sb;
        const n10x = s1 * ca, n10y = c1, n10z = s1 * sa;
        if (i > 0) {
          this.vert(cx + rr * n00x, cy + rr * n00y, cz + rr * n00z, n00x, n00y, n00z);
          this.vert(cx + rr * n01x, cy + rr * n01y, cz + rr * n01z, n01x, n01y, n01z);
          this.vert(cx + rr * n11x, cy + rr * n11y, cz + rr * n11z, n11x, n11y, n11z);
        }
        if (i < rings - 1) {
          this.vert(cx + rr * n00x, cy + rr * n00y, cz + rr * n00z, n00x, n00y, n00z);
          this.vert(cx + rr * n11x, cy + rr * n11y, cz + rr * n11z, n11x, n11y, n11z);
          this.vert(cx + rr * n10x, cy + rr * n10y, cz + rr * n10z, n10x, n10y, n10z);
        }
      }
    }
    return this;
  }

  // Upward-facing quad centred at (cx, y, cz), FULL sizes.
  planeY(cx, y, cz, sx, sz) {
    const hx = sx * 0.5, hz = sz * 0.5;
    this.vert(cx - hx, y, cz + hz, 0, 1, 0);
    this.vert(cx + hx, y, cz + hz, 0, 1, 0);
    this.vert(cx + hx, y, cz - hz, 0, 1, 0);
    this.vert(cx - hx, y, cz + hz, 0, 1, 0);
    this.vert(cx + hx, y, cz - hz, 0, 1, 0);
    this.vert(cx - hx, y, cz - hz, 0, 1, 0);
    return this;
  }

  // Merge another builder's triangles, scaled uniformly, rotated about Y, then translated.
  append(other, ox = 0, oy = 0, oz = 0, yaw = 0, scale = 1) {
    if (!other) return this;
    const n = other._n;
    if (n <= 0) return this;
    if (this._n + n > this._data.length) this._grow(this._n + n);
    const c = yaw === 0 ? 1 : Math.cos(yaw);
    const s = yaw === 0 ? 0 : Math.sin(yaw);
    const src = other._data;
    const dst = this._data;
    let k = this._n;
    for (let i = 0; i < n; i += VERT_FLOATS) {
      const x = src[i] * scale, y = src[i + 1] * scale, z = src[i + 2] * scale;
      dst[k] = ox + x * c + z * s;
      dst[k + 1] = oy + y;
      dst[k + 2] = oz - x * s + z * c;
      const nx = src[i + 3], ny = src[i + 4], nz = src[i + 5];
      dst[k + 3] = nx * c + nz * s;
      dst[k + 4] = ny;
      dst[k + 5] = -nx * s + nz * c;
      dst[k + 6] = src[i + 6];
      dst[k + 7] = src[i + 7];
      dst[k + 8] = src[i + 8];
      dst[k + 9] = src[i + 9];
      dst[k + 10] = src[i + 10];
      dst[k + 11] = src[i + 11];
      dst[k + 12] = src[i + 12];
      k += VERT_FLOATS;
    }
    this._n = k;
    return this;
  }

  data() {
    return this._data.subarray(0, this._n);
  }

  build(gl) {
    return new Mesh(gl, this.data());
  }

  reset() {
    this._n = 0;
    this._r = 1; this._g = 1; this._b = 1; this._e = 0; this._t = 0; this._rg = 0.85; this._pf = 0;
    return this;
  }
}
