// src/render/shaders/water.glsl.js -- the lake.
//
// Drawn opaque on purpose (see Renderer.drawWater): an alpha-blended surface would blend the
// material target too and SSR would then trace against a smeared normal. Composes the shared
// sky, fog, grade and cascade terms.
// 
// No backticks -- see common.glsl.js.

import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GRADE } from './grade.glsl.js';
import { GLSL_SHADOW } from './shadow.glsl.js';

/* ------------------------------------------------------------------ water pass */

export const WATER_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 2) in vec3 aColor;
// vec4 to match the 13-float vertex format: (emissive, tintable, roughness, lighting profile).
// The lake has no facade, so only .z is read — but the declaration must agree with the buffer.
layout(location = 3) in vec4 aMat;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vWorld;
out vec3 vColor;
out vec4 vMat;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vColor = aColor;
  vMat = aMat;
  gl_Position = uViewProj * wp;
}
`;

export const WATER_FS = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vColor;
in vec4 vMat;

uniform vec3 uCameraPos;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uFogColor;
uniform vec4 uFogParams;
uniform vec4 uFogRange;   // x = horizon-closer start (m), y = 1/span, zw = cap-opening window
uniform float uFogBeta;   // aerial perspective: extinction per metre, ALREADY x daylight
uniform float uDaylight;
uniform float uExposure;
uniform float uTime;
uniform float uOutputMode;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMat;
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_SHADOW}
// The lake under a real sun: the glitter path is the brightest thing in the frame after the disc
// itself, so the same widened-and-capped lobe the scene shader uses applies here too, and the cap
// tracks VH_DAY_SUN_GAIN for the same reason it does there.
const float VH_DAY_SUN_ALPHA_W = 0.022;
const float VH_DAY_SPEC_MAX_W = 1.60 * VH_DAY_SUN_GAIN;
// Volume scattering out of the water column, in daylight. city.js authors the lake on the same
// blue-hour ground scale as the pavement (its M.water, luminance 0.0155), and at dusk that is
// exactly right: with no sun in the sky nothing penetrates the surface, the harbour is a pure
// mirror and the body term is a rounding error. Under a 48-degree sun the top few metres of
// water genuinely glow — that upwelling scatter is what makes water read as WATER instead of as
// wet tarmac, and it is the whole difference between the near field being muddy and being a
// lake. Gated on uDaylight, so blue hour and night keep the glassy mirror the contract asks for.
const float VH_DAY_WATER_BODY = 6.5;      // reflectance lift on the authored body colour
const float VH_DAY_WATER_SUN = 0.34;      // sun coupling into the body (0.10 at blue hour)

void main() {
  vec2 p = vWorld.xz;
  float t = uTime;

  // Lake Ontario inside the harbour at dusk: a long swell, a mid wave and a fine chop. The
  // amplitudes are deliberately tiny — the contract calls for dark and GLASSY, and a choppy
  // surface would destroy the skyline reflection that makes the shot.
  const vec2 k1 = vec2(0.021, 0.013);
  const vec2 k2 = vec2(-0.061, 0.044);
  const vec2 k3 = vec2(0.173, 0.131);
  float p1 = dot(p, k1) + t * 0.42;
  float p2 = dot(p, k2) + t * 0.71;
  float p3 = dot(p, k3) + t * 1.35;
  vec2 grad = 0.42 * cos(p1) * k1 + 0.20 * cos(p2) * k2 + 0.055 * cos(p3) * k3;
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));

  vec3 toEye = uCameraPos - vWorld;
  float viewDist = length(toEye);
  vec3 V = viewDist > 1e-4 ? toEye / viewDist : vec3(0.0, 1.0, 0.0);
  float ndv = clamp(dot(N, V), 1e-3, 1.0);
  float ndl = max(dot(N, uKeyDir), 0.0);
  float shadow = vhShadow(vWorld, N, ndl, viewDist);

  float rough = clamp(vMat.z, 0.02, 0.35);
  float a = max(rough * rough, 0.0012);
  float aKey = max(a, VH_DAY_SUN_ALPHA_W * uDaylight);
  vec3 H = normalize(uKeyDir + V);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float vdh = clamp(dot(V, H), 0.0, 1.0);
  vec3 F0 = vec3(0.02);
  vec3 F = vhF_Schlick(F0, vdh);
  vec3 keyCol = uKeyColor * mix(1.0, VH_DAY_SUN_GAIN, uDaylight);
  vec3 spec = keyCol * ndl * shadow * (vhD_GGX(ndh, aKey) * vhV_Smith(ndv, ndl, aKey)) * F;
  spec = min(spec, vec3(mix(8.0, VH_DAY_SPEC_MAX_W, uDaylight)));

  // Body: almost black at dusk, with a little upward-scattered ambient; a lit water column under
  // a sun. Depth is not modelled — the harbour is deep enough everywhere in this bbox that it
  // reads as opaque.
  vec3 bodyCol = vColor * mix(1.0, VH_DAY_WATER_BODY, uDaylight);
  vec3 body = bodyCol * (uAmbientSky * 0.30 + uAmbientGround * 0.22
    + keyCol * ndl * shadow * mix(0.10, VH_DAY_WATER_SUN, uDaylight));

  // The reflected sky, sharp: SSR will swap this for the real skyline where it can trace it.
  vec3 R = reflect(-V, N);
  vec3 env = vhSkyGradient(R, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);
  env = mix(uAmbientGround * 1.1, env, clamp(R.y * 3.0 + 0.30, 0.0, 1.0));
  // The SAME Fresnel weight the scene shader uses, because the SSR resolve reconstructs it from
  // (ndv, rough) in the material buffer and subtracts it to swap the analytic sky for the traced
  // skyline. A hand-rolled Schlick here left a residual that showed up as a bright rim wherever
  // the lake reflection landed — and the lake reflecting the towers is the signature shot.
  vec3 fres = vhEnvSpecWeight(ndv, rough);

  vec3 col = body * (vec3(1.0) - fres) + env * fres + spec;

  float fogAmt = vhFogAmount(uCameraPos, vWorld, uFogParams, uFogRange, uFogBeta);
  vec3 viewDir = viewDist > 1e-4 ? -V : vec3(0.0, 0.0, 1.0);
  vec3 aerial = vhAerial(uFogColor, viewDir, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir,
    uKeyColor, uDaylight, vhAerialWeld(viewDist, uFogRange));
  col = mix(col, aerial, fogAmt);
  col = max(col, vec3(0.0));

  float ambLum = vhLum(body * (vec3(1.0) - fres) + env * fres) * (1.0 - fogAmt);
  float share = clamp(ambLum / max(vhLum(col), 1e-4), 0.0, 1.0) * 0.35;

  outColor = vec4(vhOutD(col, uOutputMode, uDaylight, uExposure), 1.0);
  outMat = vec4(vhOctEncode(N), rough, share);
}
`;
