// src/render/shaders/shadow.glsl.js -- everything shadow, on both sides of the pass.
//
// GLSL_SHADOW is the cascade LOOKUP, composed into the scene, water and text passes. CSM_VS /
// CSM_FS are the depth-only program that FILLS the cascade atlas. GSHADOW_VS / GSHADOW_FS are
// the legacy multiplicative blob-shadow decal, kept for any pre-baked contact-shadow mesh.
// 
// MAX_CASCADES comes from render/shadows.js, which owns the cascade count for the CPU fit as
// well, so the uniform array size and the loop bound cannot drift apart.
// 
// No backticks -- see common.glsl.js.

import { MAX_CASCADES } from '../shadows.js';
import { GLSL_COMMON } from './common.glsl.js';

// Cascaded shadow map lookup, shared by the scene and water shaders. Atlas layout: every cascade
// owns one tile of a single depth texture, and uCsmMat already folds the [-1,1] -> [0,1] bias AND
// the tile transform in, so the fragment shader does one mat4 multiply per cascade and lands
// straight on atlas UVs.
export const GLSL_SHADOW = `
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uCsmMat[${MAX_CASCADES}];
uniform vec4 uCsmTile[${MAX_CASCADES}];    // xy = atlas offset, zw = atlas scale
uniform vec4 uCsmParam[${MAX_CASCADES}];   // x = world texel size, y = 1/depth range,
                                           // z = split far, w = blend start
uniform vec2 uShadowTexel;                 // 1 / atlas size
uniform vec2 uShadowBias;                  // x = constant (m), y = slope-scaled (m)
uniform float uCsmCount;
uniform float uShadowStrength;
uniform float uShadowFar;
uniform float uShadowNormalOffset;         // in world texels

float vhCascade(int ci, vec3 wp, vec3 N, float ndl) {
  vec4 par = uCsmParam[ci];
  // Normal offset: push the sample off the surface by roughly one shadow texel, more as the
  // light grazes. This is what kills acne on the long raking blue-hour key without the
  // peter-panning a big constant depth bias would cause.
  vec3 sp = wp + N * (par.x * uShadowNormalOffset * (1.0 + 2.0 * (1.0 - ndl)));
  vec4 lp = uCsmMat[ci] * vec4(sp, 1.0);
  vec3 c = lp.xyz;
  vec4 tile = uCsmTile[ci];
  vec2 local = (c.xy - tile.xy) / max(tile.zw, vec2(1e-5));
  if (c.z <= 0.0 || c.z >= 1.0) return 1.0;
  if (any(lessThan(local, vec2(0.006))) || any(greaterThan(local, vec2(0.994)))) return 1.0;

  float slope = clamp(sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.10), 0.0, 8.0);
  float bias = (uShadowBias.x + uShadowBias.y * slope) * par.y;
  float z = clamp(c.z - bias, 0.0, 1.0);

  vec2 tmin = tile.xy + uShadowTexel;
  vec2 tmax = tile.xy + tile.zw - uShadowTexel;
  float s = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 uv = clamp(c.xy + vec2(float(x), float(y)) * uShadowTexel, tmin, tmax);
      s += texture(uShadowMap, vec3(uv, z));
    }
  }
  return s * (1.0 / 9.0);
}

float vhShadow(vec3 wp, vec3 N, float ndl, float viewDist) {
  if (uCsmCount < 0.5 || uShadowStrength <= 0.002 || ndl <= 0.0) return 1.0;
  int count = int(uCsmCount + 0.5);
  int ci = 0;
  for (int i = 0; i < ${MAX_CASCADES}; i++) {
    if (i >= count - 1) break;
    if (viewDist > uCsmParam[i].z) ci = i + 1;
  }
  float s = vhCascade(ci, wp, N, ndl);
  // Blend into the next cascade over the tail of this one so the resolution step never shows.
  if (ci + 1 < count) {
    vec4 par = uCsmParam[ci];
    float t = smoothstep(par.w, par.z, viewDist);
    if (t > 0.002) s = mix(s, vhCascade(ci + 1, wp, N, ndl), t);
  }
  float fade = 1.0 - smoothstep(uShadowFar * 0.80, uShadowFar, viewDist);
  return mix(1.0, s, clamp(uShadowStrength, 0.0, 1.0) * fade);
}
`;
/* --------------------------------------------------------- shadow depth pass */

export const CSM_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4 uLightViewProj;
uniform mat4 uModel;

void main() {
  gl_Position = uLightViewProj * (uModel * vec4(aPos, 1.0));
}
`;

// Depth-only: the framebuffer has no colour attachment and its draw buffer is NONE, so this
// write goes nowhere. It exists because a GLSL ES 3.00 program must link a fragment stage.
export const CSM_FS = `#version 300 es
precision highp float;

out vec4 outColor;

void main() {
  outColor = vec4(1.0);
}
`;

/* ------------------------------------------------- legacy blob ground shadows */

export const GSHADOW_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;

uniform mat4 uViewProj;

out vec3 vWorld;

void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

// Multiplicative: dst * src. Kept for any pre-baked contact-shadow mesh a caller still has; the
// cascaded maps are the real shadows now. Writes 1.0 to the material target so the multiplicative
// blend leaves the G-buffer untouched.
export const GSHADOW_FS = `#version 300 es
precision highp float;

in vec3 vWorld;

uniform vec3 uCameraPos;
uniform vec3 uShadowColor;
uniform vec4 uFogParams;
uniform vec4 uFogRange;   // x = horizon-closer start (m), y = 1/span, zw = cap-opening window
uniform float uFogBeta;   // aerial perspective: extinction per metre, ALREADY x daylight
uniform float uAlpha;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMat;
${GLSL_COMMON}
void main() {
  // A shaped roll-off: flat-topped up close, then falling off steeply so nothing survives out at
  // the fog line and the horizon does not turn into a grey smear of leftover shadow ink.
  float f = vhFogAmount(uCameraPos, vWorld, uFogParams, uFogRange, uFogBeta);
  float fade = clamp(1.0 - f * 1.35, 0.0, 1.0);
  float s = clamp(uAlpha, 0.0, 1.0) * fade;
  outColor = vec4(mix(vec3(1.0), uShadowColor, s), 1.0);
  outMat = vec4(1.0);
}
`;
