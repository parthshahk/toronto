// src/core/math.js — scalar helpers, seeded RNG, angle utilities, vec3 ops and a
// column-major (WebGL convention) mat4 suite. Zero dependencies; every other
// module in this project builds on this file.
//
// Conventions:
//   - Matrices are Float32Array(16), column-major: m[c * 4 + r] is row r, column c.
//   - Right-handed world space, +Y up, NDC depth range [-1, 1].
//   - Yaw 0 faces +Z, yaw increases toward +X: forward = (sin(yaw), 0, cos(yaw)).
//   - All angles are radians.

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent lerp. lambda is "how fast", in 1/seconds.
export function damp(a, b, lambda, dt) {
  if (!(dt > 0)) return a;
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

export function smoothstep(e0, e1, x) {
  const d = e1 - e0;
  if (d > -EPS && d < EPS) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / d, 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Random (Math.random based — runtime gameplay only, never city generation)
// ---------------------------------------------------------------------------

export function rand(a = 0, b = 1) {
  return a + Math.random() * (b - a);
}

// Inclusive on both ends.
export function randInt(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function pick(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[(Math.random() * arr.length) | 0];
}

export function chance(p) {
  return Math.random() < p;
}

// mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Deterministic per seed.
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

// Wrap into (-PI, PI].
export function angleWrap(a) {
  if (!Number.isFinite(a)) return 0;
  let r = a % TAU;
  if (r > PI) r -= TAU;
  else if (r <= -PI) r += TAU;
  return r;
}

// Shortest signed delta taking `from` to `to`.
export function angleDiff(from, to) {
  return angleWrap(to - from);
}

export function approachAngle(a, b, maxStep) {
  const d = angleDiff(a, b);
  if (maxStep <= 0) return angleWrap(a);
  if (d > -maxStep && d < maxStep) return angleWrap(b);
  return angleWrap(a + (d > 0 ? maxStep : -maxStep));
}

// ---------------------------------------------------------------------------
// 2D (XZ plane) distance helpers
// ---------------------------------------------------------------------------

export function dist2(x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  return dx * dx + dz * dz;
}

export function dist(x0, z0, x1, z1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------

export function vec3(x = 0, y = 0, z = 0) {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function v3set(out, x, y, z) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function v3copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function v3add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function v3sub(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function v3scale(out, a, s) {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

export function v3addScaled(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function v3dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3cross(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function v3len(a) {
  const x = a[0], y = a[1], z = a[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function v3normalize(out, a) {
  const x = a[0], y = a[1], z = a[2];
  const l2 = x * x + y * y + z * z;
  if (l2 < 1e-20) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const inv = 1 / Math.sqrt(l2);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

export function v3lerp(out, a, b, t) {
  const ax = a[0], ay = a[1], az = a[2];
  out[0] = ax + (b[0] - ax) * t;
  out[1] = ay + (b[1] - ay) * t;
  out[2] = az + (b[2] - az) * t;
  return out;
}

// Full transform including translation and perspective divide by w.
export function v3transformMat4(out, a, m) {
  const x = a[0], y = a[1], z = a[2];
  let w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w > -EPS && w < EPS) w = 1;
  const inv = 1 / w;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * inv;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * inv;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * inv;
  return out;
}

// Direction transform: rotation/scale only, translation ignored, no divide.
export function v3transformDir(out, a, m) {
  const x = a[0], y = a[1], z = a[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

// ---------------------------------------------------------------------------
// mat4 — column-major
// ---------------------------------------------------------------------------

export function mat4() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function m4identity(out) {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

export function m4copy(out, a) {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
  out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
  out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
  out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
  return out;
}

// out = a * b. Safe when `out` aliases `a` and/or `b`: all of `a` is cached in
// locals up front, and each row of `b` is read before the matching slot of
// `out` is written.
export function m4mul(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

// Standard right-handed perspective, depth range [-1, 1]. Supports far = Infinity.
export function m4perspective(out, fovyRad, aspect, near, far) {
  const half = clamp(fovyRad, 0.001, PI - 0.001) * 0.5;
  const t = Math.tan(half);
  const f = 1 / (t > EPS ? t : EPS);
  const a = Math.abs(aspect) > EPS ? aspect : 1;

  out[0] = f / a; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[11] = -1;
  out[12] = 0; out[13] = 0; out[15] = 0;

  if (far != null && Number.isFinite(far)) {
    const d = near - far;
    const nf = 1 / (Math.abs(d) > EPS ? d : -EPS);
    out[10] = (far + near) * nf;
    out[14] = 2 * far * near * nf;
  } else {
    out[10] = -1;
    out[14] = -2 * near;
  }
  return out;
}

export function m4ortho(out, l, r, b, t, n, f) {
  const dx = l - r;
  const dy = b - t;
  const dz = n - f;
  const lr = 1 / (Math.abs(dx) > EPS ? dx : -EPS);
  const bt = 1 / (Math.abs(dy) > EPS ? dy : -EPS);
  const nf = 1 / (Math.abs(dz) > EPS ? dz : -EPS);

  out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
  out[12] = (l + r) * lr;
  out[13] = (t + b) * bt;
  out[14] = (f + n) * nf;
  out[15] = 1;
  return out;
}

// Right-handed view matrix looking from `eye` toward `target`.
export function m4lookAt(out, eye, target, up) {
  const ex = eye[0], ey = eye[1], ez = eye[2];
  const upx = up ? up[0] : 0;
  const upy = up ? up[1] : 1;
  const upz = up ? up[2] : 0;

  // z = normalize(eye - target)  (camera looks down -z)
  let zx = ex - target[0];
  let zy = ey - target[1];
  let zz = ez - target[2];
  let l2 = zx * zx + zy * zy + zz * zz;
  if (l2 < 1e-12) return m4identity(out);
  let inv = 1 / Math.sqrt(l2);
  zx *= inv; zy *= inv; zz *= inv;

  // x = normalize(cross(up, z))
  let xx = upy * zz - upz * zy;
  let xy = upz * zx - upx * zz;
  let xz = upx * zy - upy * zx;
  l2 = xx * xx + xy * xy + xz * xz;
  if (l2 < 1e-12) {
    // up is parallel to the view direction — nudge with a fallback axis.
    const fx = Math.abs(zy) > 0.9 ? 1 : 0;
    const fy = Math.abs(zy) > 0.9 ? 0 : 1;
    xx = fy * zz - 0 * zy;
    xy = 0 * zx - fx * zz;
    xz = fx * zy - fy * zx;
    l2 = xx * xx + xy * xy + xz * xz;
    if (l2 < 1e-12) return m4identity(out);
  }
  inv = 1 / Math.sqrt(l2);
  xx *= inv; xy *= inv; xz *= inv;

  // y = cross(z, x)  (already unit length: z and x are orthonormal)
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

// Full 4x4 inverse via cofactors. Returns out, or null when singular.
export function m4invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function m4transpose(out, a) {
  const a01 = a[1], a02 = a[2], a03 = a[3];
  const a12 = a[6], a13 = a[7];
  const a23 = a[11];

  out[0] = a[0];
  out[1] = a[4];
  out[2] = a[8];
  out[3] = a[12];
  out[4] = a01;
  out[5] = a[5];
  out[6] = a[9];
  out[7] = a[13];
  out[8] = a02;
  out[9] = a12;
  out[10] = a[10];
  out[11] = a[14];
  out[12] = a03;
  out[13] = a13;
  out[14] = a23;
  out[15] = a[15];
  return out;
}

// out = Translate(p) * RotY(yaw) * RotX(pitch) * RotZ(roll) * Scale(s)
export function m4compose(out, px, py, pz, yaw, pitch, roll, sx, sy, sz) {
  const cy = Math.cos(yaw), sinY = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  // R = Ry * Rx * Rz, written out row-wise (rIJ = row I, column J).
  const r00 = cy * cr + sinY * sp * sr;
  const r01 = -cy * sr + sinY * sp * cr;
  const r02 = sinY * cp;
  const r10 = cp * sr;
  const r11 = cp * cr;
  const r12 = -sp;
  const r20 = -sinY * cr + cy * sp * sr;
  const r21 = sinY * sr + cy * sp * cr;
  const r22 = cy * cp;

  out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx; out[3] = 0;
  out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy; out[7] = 0;
  out[8] = r02 * sz; out[9] = r12 * sz; out[10] = r22 * sz; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
  return out;
}

// Fast path for the overwhelmingly common case: yaw rotation + translation.
export function m4fromYawPos(out, yaw, px, py, pz) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
  return out;
}
