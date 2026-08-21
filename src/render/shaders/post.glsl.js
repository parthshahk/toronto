// src/render/shaders/post.glsl.js -- every pass that runs after the geometry.
//
// POST_VS is the attributeless fullscreen triangle they all share. GLSL_DEPTH reconstructs
// view-space position from the depth TEXTURE and is what SSAO, SSR and the resolve are built on.
// Then, in chain order: SSAO and its bilateral blur, SSR, the resolve that folds AO into ambient
// only and swaps the analytic sky reflection for the traced one, the bright pass and separable
// blur that make the bloom chain and the anamorphic streak, the composite that grades the frame,
// and the FXAA that resolves it.
// 
// The pass drivers live in render/ssao.js, render/ssr.js, render/bloom.js and render/renderer.js.
// 
// No backticks -- see common.glsl.js.

import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GRADE } from './grade.glsl.js';

/* ------------------------------------------------------------- post-processing */

// Every post pass is a single fullscreen triangle generated from gl_VertexID — no vertex buffer,
// no attributes, one attributeless VAO shared with the sky.
export const POST_VS = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Shared by SSAO, SSR and the resolve: view-space position out of the depth TEXTURE. This is the
// whole reason the scene framebuffer's depth attachment is a texture and not a renderbuffer.
export const GLSL_DEPTH = `
uniform highp sampler2D uDepth;
uniform mat4 uInvProj;
uniform vec2 uZParam;      // x = proj[10], y = proj[14]

float vhRawDepth(vec2 uv) {
  return texture(uDepth, clamp(uv, vec2(0.0), vec2(1.0))).r;
}
// Positive distance in front of the eye, straight from the projection matrix.
float vhLinearDepth(float d01) {
  float zn = d01 * 2.0 - 1.0;
  return uZParam.y / (uZParam.x + zn - 1e-6);
}
vec3 vhViewPos(vec2 uv, float d01) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d01 * 2.0 - 1.0, 1.0);
  vec4 v = uInvProj * ndc;
  return v.xyz / max(v.w, 1e-8);
}
vec3 vhViewPosAt(vec2 uv) {
  return vhViewPos(uv, vhRawDepth(uv));
}
`;

// SSAO: half resolution, 16 cosine-distributed hemisphere samples, normals reconstructed from
// depth derivatives (best-of-four taps so silhouettes do not smear), and a range check that kills
// the halo you otherwise get around every tower against the sky.
export const SSAO_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform mat4 uProj;
uniform vec2 uSrcTexel;    // 1 / full-res depth size
uniform vec4 uAoParams;    // x = radius (m), y = intensity, z = bias (m), w = power

out vec4 outColor;
${GLSL_COMMON}
${GLSL_DEPTH}
void main() {
  float d = vhRawDepth(vUv);
  if (d >= 0.999999) { outColor = vec4(1.0); return; }

  vec3 P = vhViewPos(vUv, d);

  // --- normal from depth, best of the four neighbours ------------------------
  vec3 pR = vhViewPosAt(vUv + vec2(uSrcTexel.x, 0.0));
  vec3 pL = vhViewPosAt(vUv - vec2(uSrcTexel.x, 0.0));
  vec3 pU = vhViewPosAt(vUv + vec2(0.0, uSrcTexel.y));
  vec3 pD = vhViewPosAt(vUv - vec2(0.0, uSrcTexel.y));
  vec3 dx = abs(pR.z - P.z) < abs(P.z - pL.z) ? (pR - P) : (P - pL);
  vec3 dy = abs(pU.z - P.z) < abs(P.z - pD.z) ? (pU - P) : (P - pD);
  vec3 N = cross(dx, dy);
  float nl = length(N);
  N = nl > 1e-8 ? N / nl : vec3(0.0, 0.0, 1.0);
  // Orient against the view VECTOR, not against sign(N.z). A floor seen from eye level is
  // edge-on, its view-space normal has z ~ 0, and the sign of that z is pure numerical noise —
  // testing it flipped the sampling hemisphere down into the road surface and reported the whole
  // street as 84% occluded. dot(N, P) is unambiguous because P is metres long along the view.
  if (dot(N, P) > 0.0) N = -N;

  // --- per-pixel rotation ---------------------------------------------------
  float ang = vhHash21(gl_FragCoord.xy) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec3 rv = vec3(ca, sa, 0.0);
  vec3 T = rv - N * dot(rv, N);
  float tl = length(T);
  // The fallback only fires when N lies in the screen plane, where this cross product is unit.
  T = tl > 1e-4 ? T / tl : normalize(cross(N, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0));
  vec3 B = cross(N, T);

  float radius = max(uAoParams.x, 0.05);
  // The bias grows with distance because the reconstructed positions do: a 24-bit depth buffer
  // quantises to ~5 cm at 500 m, and that error shows up directly in the dot product below.
  float bias = max(uAoParams.z, 0.0) + 0.0015 * (-P.z);
  float occ = 0.0;

  // Alchemy AO (McGuire et al.) rather than the usual "is the sample behind the depth buffer"
  // test. The occlusion of one sample is the sine of the angle its SURFACE POINT subtends above
  // the tangent plane, falling off with distance squared:
  //
  //     occ += max(0, dot(v, N) - bias) / (dot(v, v) + eps),   v = sampledSurface - P
  //
  // On a flat surface every v lies IN the tangent plane, so dot(v, N) is 0 and the term vanishes
  // no matter how grazing the view is. The classic depth-compare test does not have that
  // property: on a road seen from eye height, half the hemisphere samples land in the same depth
  // texel as the centre and count themselves as occluders, which reported the entire street as
  // ~84% occluded and banded it as the texel boundaries moved. This estimator is immune to it.
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    float u = fi * (1.0 / 16.0);
    float phi = fi * 2.39996323 + ang;
    float ct = sqrt(1.0 - u);
    float st = sqrt(max(1.0 - ct * ct, 0.0));
    vec3 k = vec3(cos(phi) * st, sin(phi) * st, ct);
    float scale = mix(0.20, 1.0, u * u);
    vec3 sp = P + (T * k.x + B * k.y + N * k.z) * (radius * scale);

    vec4 c = uProj * vec4(sp, 1.0);
    if (c.w < 1e-5) continue;
    vec2 suv = c.xy / c.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = vhRawDepth(suv);
    if (sd >= 0.999999) continue;              // sky occludes nothing
    vec3 v = vhViewPos(suv, sd) - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    // Range check: an occluder much further away than the sampling radius is a different part of
    // the city, not a crevice. Without it every tower haloes against whatever is behind it.
    float range = 1.0 - smoothstep(radius * 0.9, radius * 2.2, sqrt(vv));
    occ += max(vn - bias, 0.0) / (vv + 0.08) * range;
  }

  float ao = 1.0 - occ * (radius / 16.0) * max(uAoParams.y, 0.0) * 1.4;
  ao = pow(clamp(ao, 0.0, 1.0), max(uAoParams.w, 0.05));

  // Fade AO out once the sampling radius projects to less than a few pixels. Past that the
  // whole effect is sub-pixel detail, every sample lands in the neighbouring texel, and all that
  // survives the bilateral blur is 16-sample noise crawling over the far half of the city.
  float pxRadius = radius * uProj[0][0] * 0.5 / (max(-P.z, 1e-3) * max(uSrcTexel.x, 1e-9));
  ao = mix(1.0, ao, smoothstep(1.5, 4.5, pxRadius));
  outColor = vec4(ao, ao, ao, 1.0);
}
`;

// 4x4 bilateral blur of the AO buffer: box footprint, weights folded from a depth similarity term
// so the blur never bleeds occlusion across a silhouette.
export const AOBLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uSrc;
uniform vec2 uTexel;       // 1 / AO buffer size
uniform float uSharpness;

out vec4 outColor;
${GLSL_COMMON}
${GLSL_DEPTH}
void main() {
  float dc = vhLinearDepth(vhRawDepth(vUv));
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 off = (vec2(float(x), float(y)) - 1.5) * uTexel;
      vec2 uv = vUv + off;
      float ds = vhLinearDepth(vhRawDepth(uv));
      // The depth tolerance has to be RELATIVE. An absolute metres-per-unit sharpness rejects
      // every neighbour once the plane is far enough away that adjacent texels are metres apart,
      // which switches the blur off exactly where the raw AO is noisiest.
      float w = exp2(-1.442695 * abs(ds - dc) * max(uSharpness, 0.0) / max(dc, 1.0));
      sum += texture(uSrc, clamp(uv, vec2(0.0), vec2(1.0))).r * w;
      wsum += w;
    }
  }
  float ao = wsum > 1e-5 ? sum / wsum : 1.0;
  outColor = vec4(ao, ao, ao, 1.0);
}
`;

// Screen-space reflections. Marches the depth buffer in VIEW space with a geometrically growing
// step, binary-refines the crossing, then fades on ray length, screen edge and grazing angle.
// Gated on roughness, so wet asphalt (0.18), glass (0.06) and the lake (0.03) reflect while dry
// concrete (0.90) never enters the loop.
export const SSR_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uScene;
uniform highp sampler2D uMat;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uInvView;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uSunDir;
uniform vec3 uAmbientGround;
uniform vec4 uSsrParams;   // x = max distance (m), y = steps, z = thickness (m), w = stride (m)
uniform float uDecode;

out vec4 outColor;
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_DEPTH}
vec3 vhScene(vec2 uv) {
  vec3 c = texture(uScene, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  return uDecode > 0.5 ? vhDecode(c) : max(c, vec3(0.0));
}

void main() {
  outColor = vec4(0.0);

  float d = vhRawDepth(vUv);
  if (d >= 0.999999) return;

  vec4 m = texture(uMat, vUv);
  float rough = m.z;
  float refl = 1.0 - smoothstep(0.07, 0.30, rough);
  if (refl <= 0.004) return;

  vec3 P = vhViewPos(vUv, d);
  vec3 V = normalize(-P);
  vec3 Nw = vhOctDecode(m.xy);
  vec3 Nv = normalize(mat3(uView) * Nw);
  if (dot(Nv, V) < 0.0) Nv = -Nv;
  vec3 Rv = reflect(-V, Nv);

  // The sky the analytic ambient specular already put on this pixel. Returned on a miss so the
  // resolve's delta term collapses to zero instead of punching a hole in the reflection.
  vec3 Rw = normalize(mat3(uInvView) * Rv);
  vec3 sky = vhSkyGradient(Rw, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);
  sky = mix(uAmbientGround * 1.15, sky, clamp(Rw.y * 2.6 + 0.42, 0.0, 1.0));

  float maxDist = max(uSsrParams.x, 1.0);
  float steps = clamp(uSsrParams.y, 4.0, 48.0);
  float thickness = max(uSsrParams.z, 0.05);
  float stride = max(uSsrParams.w, 0.05);

  float jitter = vhHash21(gl_FragCoord.xy * 1.37) * 0.9 + 0.1;
  float t = stride * jitter;
  float step0 = stride;
  float hitT = -1.0;
  vec2 hitUv = vec2(0.0);
  float prevT = 0.0;

  for (int i = 0; i < 48; i++) {
    if (float(i) >= steps) break;
    prevT = t;
    t += step0;
    step0 *= 1.16;                       // geometric growth: fine near the surface, coarse far off
    if (t > maxDist) break;

    vec3 sp = P + Rv * t;
    if (sp.z > -0.05) break;             // the ray has come back to the eye plane

    vec4 c = uProj * vec4(sp, 1.0);
    if (c.w < 1e-5) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sd = vhRawDepth(uv);
    if (sd >= 0.999999) continue;        // sky: nothing to reflect, keep marching
    float sz = vhViewPos(uv, sd).z;

    float delta = sz - sp.z;             // > 0 : the scene surface is in front of the ray
    if (delta > 0.0 && delta < thickness + (t - prevT)) {
      // --- binary refinement -------------------------------------------------
      float lo = prevT, hi = t;
      for (int r = 0; r < 6; r++) {
        float mid = (lo + hi) * 0.5;
        vec3 mp = P + Rv * mid;
        vec4 mc = uProj * vec4(mp, 1.0);
        vec2 muv = mc.w > 1e-5 ? (mc.xy / mc.w * 0.5 + 0.5) : uv;
        float md = vhRawDepth(muv);
        float mz = vhViewPos(muv, md).z;
        if (mz - mp.z > 0.0) hi = mid; else lo = mid;
        uv = muv;
      }
      hitT = hi;
      hitUv = uv;
      break;
    }
  }

  float conf = 0.0;
  vec3 radiance = sky;
  if (hitT > 0.0) {
    vec2 e = smoothstep(vec2(0.0), vec2(0.11), hitUv) *
             (vec2(1.0) - smoothstep(vec2(0.89), vec2(1.0), hitUv));
    float edge = e.x * e.y;
    float lenFade = 1.0 - smoothstep(maxDist * 0.55, maxDist, hitT);
    // A ray heading back toward the camera has no screen information behind it.
    float toward = 1.0 - smoothstep(0.15, 0.65, dot(Rv, V));
    conf = edge * lenFade * toward;
    radiance = mix(sky, vhScene(hitUv), conf);
  }

  outColor = vec4(radiance, refl);
}
`;

// Resolve: fold SSAO into AMBIENT ONLY (via the ambient-share channel the scene shader wrote) and
// swap the analytic sky reflection for the screen-space one. Runs at full resolution and produces
// the texture the bloom chain and the composite read.
export const RESOLVE_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uScene;
uniform highp sampler2D uMat;
uniform highp sampler2D uAO;
uniform highp sampler2D uSSR;
uniform mat4 uInvView;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uSunDir;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAoEnabled;
uniform float uSsrEnabled;
uniform float uSsrIntensity;
uniform float uDaylight;
uniform float uAoFill;       // fraction of the occlusion daylight bounce fills back in
uniform float uDecode;

out vec4 outColor;
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_DEPTH}
void main() {
  vec3 col = texture(uScene, vUv).rgb;
  col = uDecode > 0.5 ? vhDecode(col) : max(col, vec3(0.0));

  float d = vhRawDepth(vUv);
  if (d < 0.999999) {
    vec4 m = texture(uMat, vUv);

    if (uAoEnabled > 0.5) {
      float ao = clamp(texture(uAO, vUv).r, 0.0, 1.0);
      // Occlusion is not extinction. What blocks the sky in a street canyon is a BUILDING, and
      // in daylight that building is itself sunlit and hands most of the light straight back —
      // which is precisely the bounce the scene pass just added, so taking the full occlusion
      // out on top of it double-counts the same geometry. Down at Bay & King the mean blurred AO
      // is 0.81 across the 94% of the frame that is facade and roadway, and the ambient share
      // there is 0.98: an unattenuated multiply was removing a fifth of the only light a street
      // that was already too dark had. Fill it back in proportion to the daylight. At daylight 0
      // this is ao to the bit, so blue hour's contact darkening is exactly what it always was.
      ao = mix(ao, mix(ao, 1.0, clamp(uAoFill, 0.0, 1.0)), clamp(uDaylight, 0.0, 1.0));
      // AO scales the AMBIENT share of this pixel and nothing else. Direct light, window
      // emission and fog all pass through untouched.
      col *= 1.0 - clamp(m.w, 0.0, 1.0) * (1.0 - ao);
    }

    if (uSsrEnabled > 0.5) {
      vec4 s = texture(uSSR, vUv);
      if (s.a > 0.004) {
        vec3 P = vhViewPos(vUv, d);
        vec3 Pw = (uInvView * vec4(P, 1.0)).xyz;
        vec3 camPos = uInvView[3].xyz;
        vec3 toEye = camPos - Pw;
        float dl = length(toEye);
        vec3 V = dl > 1e-4 ? toEye / dl : vec3(0.0, 1.0, 0.0);
        vec3 N = vhOctDecode(m.xy);
        float rough = clamp(m.z, 0.03, 1.0);
        float ndv = clamp(dot(N, V), 1e-3, 1.0);

        // Exactly the environment term the scene shader added, so subtracting it swaps the
        // analytic sky for the traced reflection instead of stacking on top of it. The Fresnel
        // weight comes from the SHARED vhEnvSpecWeight — it is a pure function of (ndv, rough),
        // both of which the material buffer carries, which is the only reason this delta can be
        // exact without a deferred renderer.
        vec3 R = reflect(-V, N);
        vec3 envSharp = vhSkyGradient(R, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);
        envSharp = mix(uAmbientGround * 1.15, envSharp, clamp(R.y * 2.6 + 0.42, 0.0, 1.0));
        vec3 env = mix(uAmbientSky, envSharp, 1.0 - rough);
        vec3 specW = vhEnvSpecWeight(ndv, rough);

        col += (s.rgb - env) * specW * s.a * max(uSsrIntensity, 0.0);
      }
    }
  }

  col = max(col, vec3(0.0));
  outColor = vec4(uDecode > 0.5 ? vhEncode(col) : col, 1.0);
}
`;

// Bright pass AND plain downsample in one program: four bilinear taps (a 4x4 source footprint,
// which is what keeps a one-pixel window from strobing as the camera moves), optionally
// luma-weighted to kill fireflies, then a soft-knee threshold. Call it with uThreshold = 0 and
// uKnee = 0 and the threshold collapses to a no-op, leaving a clean 2x box downsample.
export const BRIGHT_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uSrc;
uniform vec2 uTexel;        // 1 / source size
uniform float uThreshold;
uniform float uKnee;
uniform float uFirefly;     // 1 = luma-weighted tap average (bright pass), 0 = plain box
uniform float uDecode;      // 1 = the source holds range-compressed colour (RGBA8 path)

out vec4 outColor;
${GLSL_COMMON}
${GLSL_GRADE}
vec3 vhTap(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
  return uDecode > 0.5 ? vhDecode(c) : max(c, vec3(0.0));
}
float vhWeight(vec3 c) {
  if (uFirefly < 0.5) return 1.0;
  return 1.0 / (1.0 + vhLum(c));
}

void main() {
  vec2 o = uTexel;
  vec3 a = vhTap(vUv + vec2(-o.x, -o.y));
  vec3 b = vhTap(vUv + vec2( o.x, -o.y));
  vec3 c = vhTap(vUv + vec2(-o.x,  o.y));
  vec3 e = vhTap(vUv + vec2( o.x,  o.y));
  float wa = vhWeight(a), wb = vhWeight(b), wc = vhWeight(c), we = vhWeight(e);
  vec3 col = (a * wa + b * wb + c * wc + e * we) / max(wa + wb + wc + we, 1e-5);

  float br = max(col.r, max(col.g, col.b));
  float knee = max(uKnee, 1e-4);
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);

  outColor = vec4(max(col * contrib, vec3(0.0)), 1.0);
}
`;

// Separable Gaussian: 5 bilinear fetches standing in for a 9-tap kernel (sigma ~2.4), run once
// horizontally and once vertically at each level's own resolution. The anamorphic streak reuses
// it with uDir = (1,0) and a large radius.
export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRadius;

out vec4 outColor;

void main() {
  vec2 o = uTexel * uDir * max(uRadius, 0.05);
  vec2 o1 = o * 1.3846153846;
  vec2 o2 = o * 3.2307692308;
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += (texture(uSrc, vUv + o1).rgb + texture(uSrc, vUv - o1).rgb) * 0.3162162162;
  c += (texture(uSrc, vUv + o2).rgb + texture(uSrc, vUv - o2).rgb) * 0.0702702703;
  outColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;

// The only pass that writes the default framebuffer: chromatic aberration on the scene fetch,
// weighted bloom levels, the anamorphic streak, then the shared filmic grade (tonemap, split
// tone, saturation, gamma) that the geometry shaders skipped, plus grain and dither.
export const COMP_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uScene;
uniform highp sampler2D uB0;
uniform highp sampler2D uB1;
uniform highp sampler2D uB2;
uniform highp sampler2D uStreak;
uniform float uIntensity;
uniform float uStreakIntensity;
uniform float uChroma;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform float uDecode;
uniform float uDaylight;
uniform float uExposure;

out vec4 outColor;
${GLSL_COMMON}
${GLSL_GRADE}
vec3 vhScene(vec2 uv) {
  vec3 c = texture(uScene, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  return uDecode > 0.5 ? vhDecode(c) : max(c, vec3(0.0));
}

// TRANSVERSE CHROMATIC ABERRATION, integrated rather than point-sampled.
//
// A lens does not TRANSLATE the red image by the aberration figure, it SMEARS it over that
// length: red focuses long, so a point source lands as a short radial streak, not as a displaced
// point. Fetching one sample at the far end of that streak is a cheap stand-in and it was a fine
// one on a 3 km map, where the corners of the frame held near geometry and the offset landed
// inside the same roof it started on.
//
// On a 6.8 x 6.5 km map they do not. At the extreme corner the offset is 2.7 px of red-to-blue
// separation, and the corner of the frame is now full of city 3-6 km away whose roofs, kerbs and
// lane dashes are ONE pixel across — so the displaced fetch lands on an unrelated pixel and the
// three channels stop describing the same object.
//
// MEASURED, from the north-east corner of the extract at Afternoon, over the bottom-left quarter
// of the frame — the fraction of pixels carrying strong chroma that their own neighbours do not,
// which is what "isolated magenta dot" means as a number:
//
//     aberration off  0.059%       point-sampled  0.592%       integrated  0.355%
//     mean chroma     0.0539                      0.0721                   0.0629
//
// Four taps from 0 to the offset, averaged, is the integral the point sample was approximating.
// The REACH is unchanged — the far tap is exactly where the old single sample was — so the
// aberration still runs out to the same radius; what changes is that it arrives as a gradient
// instead of a jump, and a one-pixel feature contributes a quarter of its own colour to each
// step instead of all of it to one. That is 44% of the excess speckle and 51% of the excess
// chroma gone. The rest is what a 1.4 px smear of a 1 px feature honestly looks like, and the
// knob for it is renderer.post.chroma, which this change does not touch.
//
// Seven fetches against three, in one full-screen pass at 1440x900: 13.8 ms per frame against
// 14.2 for the three-tap version, i.e. inside the frame-to-frame spread.
vec3 vhSceneCA(vec2 uv, vec2 off) {
  vec3 c0 = vhScene(uv);
  float r = c0.r;
  float b = c0.b;
  for (int i = 1; i <= 3; i++) {
    vec2 d = off * (float(i) * 0.33333333);
    r += vhScene(uv + d).r;
    b += vhScene(uv - d).b;
  }
  return vec3(r * 0.25, c0.g, b * 0.25);
}

void main() {
  vec2 c2 = vUv - 0.5;
  float r2 = dot(c2, c2);

  // Chromatic aberration: zero at the optical centre, growing with r^2 toward the corners.
  vec3 scene;
  if (uChroma > 1e-5) {
    scene = vhSceneCA(vUv, c2 * r2 * uChroma);
  } else {
    scene = vhScene(vUv);
  }

  // Weights sum to 1: the tight level carries the core of the glow, the two wide ones the halo.
  vec3 bloom = texture(uB0, vUv).rgb * 0.46
             + texture(uB1, vUv).rgb * 0.32
             + texture(uB2, vUv).rgb * 0.22;

  vec3 b = max(bloom, vec3(0.0)) * max(uIntensity, 0.0);

  // Bloom is a HALO, not a wash. Adding it flat onto the source pixel destroys the colour of the
  // thing that is glowing: a warm window core measured (240,223,139) with bloom off and
  // (240,236,232) with it on — saturation 0.42 collapsing to 0.03 — because the blur averages the
  // whole neighbourhood to near-neutral and then dumps that on top. Attenuating by how bright the
  // underlying pixel already is lets dark surroundings receive the full glow (which is the effect
  // we actually want) while emitting surfaces keep their own hue. DO NOT REGRESS (CONTRACT §3.2).
  float sceneLum = vhLum(scene);
  b *= mix(1.0, 0.22, clamp(sceneLum, 0.0, 1.0));

  // Anamorphic streak: a wide horizontal smear of the bright pass, cyan in the core and magenta
  // in the tails. Low intensity — it is a lens artefact, not a light source.
  if (uStreakIntensity > 1e-5) {
    vec3 st = max(texture(uStreak, vUv).rgb, vec3(0.0));
    float sl = clamp(vhLum(st) * 2.0, 0.0, 1.0);
    vec3 tint = mix(vec3(1.16, 0.52, 1.02), vec3(0.48, 0.86, 1.34), sl);
    b += st * tint * uStreakIntensity * mix(1.0, 0.30, clamp(sceneLum, 0.0, 1.0));
  }

  // Bloom is added in LINEAR light, before the daylight exposure and OETF: a lens flares on the
  // light that reaches it, not on the code values a display would have shown.
  vec3 col = vhGradeD(vhDayTone(scene + b, uDaylight, uExposure), uDaylight);

  // Vignette, then grain scaled by 1 - luma: film grain lives in the shadows, not the highlights.
  col *= 1.0 - clamp(uVignette, 0.0, 1.0) * smoothstep(0.06, 0.62, r2);
  if (uGrain > 1e-5) {
    float g = vhHash21(gl_FragCoord.xy + vec2(uTime * 61.7, uTime * 37.3)) - 0.5;
    col += g * uGrain * (1.0 - vhLum(col));
  }
  col += (vhHash21(gl_FragCoord.xy * 1.7) - 0.5) * 0.0045;   // dither the 8-bit write
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// FXAA 3.11 "console" variant, run on the finished LDR image as the very last pass. This is the
// only anti-aliasing available once anything post-processes the frame: WebGL2 has no multisampled
// TEXTURES, so the moment the geometry pass moves off the default framebuffer it also loses the
// 4x MSAA the context was created with. With 4,818 buildings the silhouette IS the image, and
// stair-stepped tower edges are the most visible artefact in the whole frame.
//
// Grain and dither live here rather than in the composite whenever this pass exists: running FXAA
// over already-grained pixels makes its edge detector chase the noise and softens the picture.
export const FXAA_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform highp sampler2D uSrc;
uniform vec2 uTexel;
uniform float uGrain;
uniform float uTime;

out vec4 outColor;
${GLSL_COMMON}
void main() {
  vec2 t = uTexel;
  vec3 rgbNW = texture(uSrc, vUv + vec2(-1.0, -1.0) * t).rgb;
  vec3 rgbNE = texture(uSrc, vUv + vec2( 1.0, -1.0) * t).rgb;
  vec3 rgbSW = texture(uSrc, vUv + vec2(-1.0,  1.0) * t).rgb;
  vec3 rgbSE = texture(uSrc, vUv + vec2( 1.0,  1.0) * t).rgb;
  vec3 rgbM  = texture(uSrc, vUv).rgb;

  float lNW = vhLum(rgbNW), lNE = vhLum(rgbNE);
  float lSW = vhLum(rgbSW), lSE = vhLum(rgbSE);
  float lM = vhLum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * t;

  vec3 rgbA = 0.5 * (texture(uSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(uSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(uSrc, vUv + dir * -0.5).rgb +
                                   texture(uSrc, vUv + dir * 0.5).rgb);
  float lB = vhLum(rgbB);
  vec3 col = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  if (uGrain > 1e-5) {
    float g = vhHash21(gl_FragCoord.xy + vec2(uTime * 61.7, uTime * 37.3)) - 0.5;
    col += g * uGrain * (1.0 - vhLum(col));
  }
  col += (vhHash21(gl_FragCoord.xy * 1.7) - 0.5) * 0.0045;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
