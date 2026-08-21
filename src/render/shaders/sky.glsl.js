// src/render/shaders/sky.glsl.js -- the sky dome, as one fullscreen triangle.
//
// Attributeless: the vertices come from gl_VertexID. The gradient, cloud and star model itself
// lives in common.glsl.js so that a glass tower reflects exactly the sky drawn above it.
// 
// No backticks -- see common.glsl.js.

import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GRADE } from './grade.glsl.js';

/* -------------------------------------------------------------------- sky pass */

// Fullscreen triangle from gl_VertexID — no vertex buffer, no attributes.
export const SKY_VS = `#version 300 es
precision highp float;

out vec2 vNdc;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}
`;

export const SKY_FS = `#version 300 es
precision highp float;

in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform vec3 uSunDir;
uniform vec3 uKeyColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uFogColor;
uniform float uCloudAmount;
uniform float uCloudCover;
uniform float uStarAmount;
uniform float uDaylight;
uniform float uExposure;
uniform float uTime;
uniform float uOutputMode;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMat;
${GLSL_COMMON}
${GLSL_GRADE}
float vhVNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = vhHash21(i);
  float b = vhHash21(i + vec2(1.0, 0.0));
  float c = vhHash21(i + vec2(0.0, 1.0));
  float d = vhHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vhFbm(vec2 p) {
  float s = 0.0;
  s += vhVNoise(p) * 0.55;
  s += vhVNoise(p * 2.07 + 17.3) * 0.30;
  s += vhVNoise(p * 4.13 + 41.7) * 0.15;
  return s;
}

void main() {
  // Reconstruct the world-space view ray. Cross-multiplied so there is no division by w.
  vec4 pF = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec4 pN = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec3 d = pF.xyz * pN.w - pN.xyz * pF.w;
  float dl = length(d);
  vec3 dir = dl > 1e-6 ? d / dl : vec3(0.0, 1.0, 0.0);
  float up = dir.y;

  vec3 col = vhSkyGradient(dir, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);

  // --- first stars ----------------------------------------------------------
  // 20:45 in June: only the brightest few are out, and only well above the afterglow.
  float starF = clamp(uStarAmount, 0.0, 1.0) * smoothstep(0.02, 0.34, up);
  float clouds = 0.0;
  float cloudLight = 0.0;
  if (starF > 0.002) {
    vec3 sp = dir * 130.0;
    vec3 cell = floor(sp);
    vec3 f = sp - cell - 0.5;
    float h = vhHash31(cell);
    float present = step(0.9885, h);
    vec3 off = vec3(vhHash31(cell + 11.3), vhHash31(cell + 23.7), vhHash31(cell + 37.1)) - 0.5;
    vec3 r = f - off * 0.62;
    float d2 = dot(r, r);
    float tw = 0.62 + 0.38 * sin(uTime * (1.1 + h * 4.0) + h * 63.0);
    float s = present * exp2(-d2 * 150.0) * tw;
    vec3 starCol = mix(vec3(0.76, 0.84, 1.0), vec3(1.0, 0.93, 0.80), fract(h * 17.0));
    col += starCol * s * starF * 1.35;
  }

  // --- scattered cloud ------------------------------------------------------
  // Projected onto a plane at a fixed altitude, so the deck converges at the horizon the way a
  // real one does. Below the horizon there is no deck at all.
  if (uCloudAmount > 0.002 && up > 0.012) {
    vec2 cuv = (dir.xz / max(up, 0.012)) * 1.6 + vec2(uTime * 0.004, uTime * 0.0022);
    float n = vhFbm(cuv);
    float cover = clamp(uCloudCover, 0.0, 0.98);
    clouds = smoothstep(cover, cover + 0.26, n) * uCloudAmount;
    // Thin out toward the zenith (we see the deck edge-on near the horizon) and fade into haze.
    clouds *= smoothstep(0.012, 0.10, up) * (1.0 - smoothstep(0.55, 1.0, up) * 0.55);
    // Lit warm from beneath on the sun's side, dark indigo elsewhere.
    vec2 sh = uSunDir.xz;
    float sl = length(sh);
    float az = sl > 1e-4 ? dot(normalize(dir.xz + 1e-6), sh / sl) : 0.0;
    cloudLight = pow(clamp(az * 0.5 + 0.5, 0.0, 1.0), 3.0) * exp2(-1.442695 * max(up, 0.0) * 4.0);
    vec3 cloudCol = mix(uSkyZenith * 0.75, uSkyWest * 0.70 + uSkyHorizon * 0.30, cloudLight);
    cloudCol += uSkyHorizon * 0.16;
    col = mix(col, cloudCol, clamp(clouds, 0.0, 1.0));
  }

  // --- the sun itself -------------------------------------------------------
  // Blue hour has no disc by contract (CONTRACT 3.2.6): the sun is 4 degrees below the horizon and
  // all that is left is the afterglow the gradient already draws. Daylight puts it back, along
  // with the two scattering lobes that surround it — a tight Mie aureole a few degrees across and
  // a broad forward-scatter wash that pales the whole quarter of the sky the sun sits in.
  if (uDaylight > 0.0015 && uSunDir.y > -0.02) {
    float cd = clamp(dot(dir, uSunDir), 0.0, 1.0);
    // 0.53 degrees of arc, with a soft limb about a tenth of a degree wide.
    float disc = smoothstep(0.999955, 0.999977, cd);
    float aureole = pow(cd, 2600.0) * 0.42 + pow(cd, 340.0) * 0.085;
    float forward = pow(cd, 26.0) * 0.055 + pow(cd, 4.0) * 0.016;
    // The disc dims and reddens into the horizon haze exactly as the real one does, and it must
    // not survive the moment the sun sets — golden hour sits 7 degrees up, night is below.
    float alt = smoothstep(-0.02, 0.05, uSunDir.y);
    float thick = mix(0.30, 1.0, smoothstep(0.0, 0.22, uSunDir.y));
    vec3 sunCol = max(uKeyColor, vec3(1e-4));
    col += sunCol * ((disc * 13.0 * thick + aureole * thick + forward) * alt * uDaylight);
    // Cloud in front of the sun is bright, not dark: put back the light the deck scatters through.
    col += sunCol * (clouds * (aureole * 0.45 + forward * 0.9) * alt * uDaylight);
  }

  // Horizon haze band — this is what makes distant fogged geometry blend seamlessly.
  col = mix(col, uFogColor, exp2(-1.442695 * abs(up) * 15.0) * 0.22);

  vec3 outc = vhOutD(col, uOutputMode, uDaylight, uExposure);
  // Static ordered-ish dither kills the banding a smooth gradient shows on 8-bit output. In the
  // post path the composite is the 8-bit write, so it dithers there instead of here.
  if (uOutputMode < 0.5) {
    outc = clamp(outc + (vhHash21(gl_FragCoord.xy) - 0.5) * 0.007, 0.0, 1.0);
  }

  outColor = vec4(outc, 1.0);
  // Sky pixels: face the camera, fully rough, no ambient share. SSAO and SSR both reject them on
  // depth anyway; this keeps the material buffer defined everywhere.
  outMat = vec4(vhOctEncode(vec3(0.0, 1.0, 0.0)), 1.0, 0.0);
}
`;
