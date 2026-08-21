// src/render/camera.js -- the free-roam camera.
//
// Holds pos / target / up / fov / aspect / near / far and rebuilds every matrix the renderer
// and the post chain need from them: view, proj, viewProj and the three inverses that SSAO and
// SSR reconstruct view-space position and reflection rays with.
//
// World axes: X = east, Y = up, Z = south. Right-handed. TRUE METRES.

import {
  clamp, mat4, vec3, m4identity, m4lookAt, m4mul, m4perspective, m4invert,
} from '../core/math.js';

// Module-scope scratch — the hot paths must not allocate. Each of these is written and read
// inside a single call and carries nothing between calls.
const _ray = new Float32Array(3);
const _tmpA = new Float32Array(3);
const _tmpB = new Float32Array(3);

export class Camera {
  constructor() {
    this.pos = vec3(0, 8, -14);
    this.target = vec3(0, 1.7, 0);
    this.up = vec3(0, 1, 0);
    this.fov = 1.05;
    this.aspect = 1.6;
    // --- depth precision ------------------------------------------------------------------
    // The daytime flicker on distant massing was a depth-buffer problem, and in a fixed-point
    // buffer that problem is the NEAR plane and almost nothing else. For a standard perspective
    // projection into a DEPTH_COMPONENT24 attachment the quantisation step at distance z is
    //
    //     dz = 2^-24 * (far - near) * z^2 / (far * near)
    //
    // and with far >> near the (far - near) / far factor is 0.9998, so it collapses to
    // dz ~ 2^-24 * z^2 / near. At the near plane this camera used to run — 0.3 m — that is
    // 0.199 m of depth resolution at a kilometre and 0.79 m at two: WIDER than the gap between
    // the stacked massing slabs data/toronto.json carries for one real building, so their walls
    // quantise to the same value and the depth test picks a different winner every time the
    // camera moves. Precision is inversely proportional to the near plane, so every doubling of
    // it halves the depth resolution and takes a matching bite out of the flicker.
    //
    // The far plane is the OTHER end of the same expression, and the algebra says it is nearly
    // free: dz = 2^-24 * z^2 / near * (1 - near / far), so moving far from 5,600 m to 18,600 m
    // changes the (1 - near/far) factor from 0.999821 to 0.999946 — a 0.012% loss, three orders
    // of magnitude smaller than what the near plane is worth. The far plane is therefore set by
    // VISIBILITY alone, and visibility is what the expanded extract changed.
    //
    // 5,600 m was the diagonal of the OLD reachable world. It is now far too short. main.js
    // clamps the camera to x +/-3,704, z -3,548..+4,508, y -60..2,400; the mapped city fills
    // x +/-3,384, z +/-3,228 and rises to 553 m; and city.js draws the lake as a flat sheet out
    // to x +/-8,184 and z -4,428..+10,428, because the harbour has to have a horizon. The
    // longest sightline that volume admits — the ceiling above the north-west corner of the
    // clamp looking at the far south-east corner of the water — is 18,493 m.
    //
    // MEASURED, at the default lake viewpoint looking south at three pitches: at 5,600 the plane
    // cuts the lake in a band ~20 scanlines deep whose worst row differs from the uncut frame by
    // 117/765 of the RGB range. That is the world visibly ending (CONTRACT §9.4) and it was
    // already happening before the expansion — the old note measured from 207 m, where the cut
    // hides in the horizon band, and not from the 300 m the start viewpoint actually uses.
    //
    // 18,600 m is that worst-case sightline plus 100 m, so there is no camera the game allows
    // from which the plane can cut anything at all. It is belt AND braces: the horizon closer in
    // vhFogAmount below is already at 99.96% opaque by 16 km, so even a plane that did cut would
    // land under one 8-bit code value — but a bound that is simply longer than the world cannot
    // be argued with, and it costs 0.008% of the depth resolution to have.
    //
    // WebGL2 has no glClipControl, so true reversed-Z is unavailable: the [-1,1] NDC z is
    // computed in float32 before the fixed-function viewport transform, and a reversed far plane
    // lands at -1 + eps where float32 resolves 6e-8 anyway. Measured, it is worth about 2x, not
    // the 1000x a [0,1] clip range would buy, so it is not done here.
    //
    // main.js drives `near` per frame from the clearance actually around the eye (see its
    // cameraNear()); this is the value used before the city exists and if nothing drives it.
    this.near = 1.0;
    this.far = 18600;

    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.invViewProj = mat4();
    // Added for SSAO/SSR: post passes reconstruct view-space position from the depth texture
    // (invProj) and need the view rotation to move normals and reflection rays between spaces.
    this.invProj = mat4();
    this.invView = mat4();
  }

  // Rebuild view / proj / viewProj / invViewProj / invProj / invView from pos/target/fov/aspect.
  update() {
    const p = this.pos;
    const t = this.target;

    // NaN guard: a single bad frame of movement maths must not poison the matrices forever.
    if (!Number.isFinite(p[0] + p[1] + p[2])) {
      p[0] = 0; p[1] = 8; p[2] = -14;
    }
    if (!Number.isFinite(t[0] + t[1] + t[2])) {
      t[0] = p[0]; t[1] = p[1]; t[2] = p[2] + 1;
    }
    // Degenerate look-at (eye == target) would collapse the basis; nudge along +Z.
    const dx = t[0] - p[0], dy = t[1] - p[1], dz = t[2] - p[2];
    if (dx * dx + dy * dy + dz * dz < 1e-8) t[2] = p[2] + 1;

    const fov = clamp(Number.isFinite(this.fov) ? this.fov : 1.05, 0.15, 2.6);
    const aspect = Number.isFinite(this.aspect) && Math.abs(this.aspect) > 1e-4 ? this.aspect : 1.6;
    // Clamped, not just NaN-guarded: `near` is now written every frame by main.js, and a caller
    // that hands it a metre-scale typo would quietly halve the depth buffer's usable range or
    // clip the whole city away.
    const near = clamp(Number.isFinite(this.near) ? this.near : 1.0, 0.05, 64);
    let far = Number.isFinite(this.far) ? this.far : 18600;
    if (far <= near + 1e-3) far = near + 1000;

    m4lookAt(this.view, p, t, this.up);
    m4perspective(this.proj, fov, aspect, near, far);
    m4mul(this.viewProj, this.proj, this.view);
    if (!m4invert(this.invViewProj, this.viewProj)) m4identity(this.invViewProj);
    if (!m4invert(this.invProj, this.proj)) m4identity(this.invProj);
    if (!m4invert(this.invView, this.view)) m4identity(this.invView);
    return this;
  }

  // Normalized look direction.
  forward(out) {
    const o = out || _tmpA;
    const x = this.target[0] - this.pos[0];
    const y = this.target[1] - this.pos[1];
    const z = this.target[2] - this.pos[2];
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-12)) { o[0] = 0; o[1] = 0; o[2] = 1; return o; }
    const inv = 1 / Math.sqrt(l2);
    o[0] = x * inv; o[1] = y * inv; o[2] = z * inv;
    return o;
  }

  // Normalized camera-right (forward x up, right-handed).
  right(out) {
    const o = out || _tmpB;
    const f = this.forward(_tmpA);
    const ux = this.up[0], uy = this.up[1], uz = this.up[2];
    const x = f[1] * uz - f[2] * uy;
    const y = f[2] * ux - f[0] * uz;
    const z = f[0] * uy - f[1] * ux;
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-12)) { o[0] = 1; o[1] = 0; o[2] = 0; return o; }
    const inv = 1 / Math.sqrt(l2);
    o[0] = x * inv; o[1] = y * inv; o[2] = z * inv;
    return o;
  }

  // Ray through a normalized-device-coordinate point (-1..1). Origin is the eye.
  screenRay(ndcX, ndcY, outOrigin, outDir) {
    const m = this.invViewProj;
    const x = ndcX, y = ndcY;
    // Far-plane point (z = +1) in homogeneous clip space, unprojected.
    const px = m[0] * x + m[4] * y + m[8] + m[12];
    const py = m[1] * x + m[5] * y + m[9] + m[13];
    const pz = m[2] * x + m[6] * y + m[10] + m[14];
    let pw = m[3] * x + m[7] * y + m[11] + m[15];
    if (pw > -1e-9 && pw < 1e-9) pw = 1e-9;
    const inv = 1 / pw;

    if (outOrigin) {
      outOrigin[0] = this.pos[0];
      outOrigin[1] = this.pos[1];
      outOrigin[2] = this.pos[2];
    }
    const o = outDir || _ray;
    const dx = px * inv - this.pos[0];
    const dy = py * inv - this.pos[1];
    const dz = pz * inv - this.pos[2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (!(l2 > 1e-12) || !Number.isFinite(l2)) return this.forward(o);
    const s = 1 / Math.sqrt(l2);
    o[0] = dx * s; o[1] = dy * s; o[2] = dz * s;
    return o;
  }
}
