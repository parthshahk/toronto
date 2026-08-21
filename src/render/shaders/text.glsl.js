// src/render/shaders/text.glsl.js -- world text, drawn as a blended SDF decal pass.
//
// Reads the packed texture coordinate whose encoding core/vertex.js owns (GLSL_UV is the decode
// half of packUv), samples the signed-distance atlas render/font.js rasterises, and shades the
// result with the same sky, fog and cascade terms the fascia behind it got.
// 
// No backticks -- see common.glsl.js.

import { GLSL_UV } from '../../core/vertex.js';
import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GRADE } from './grade.glsl.js';
import { GLSL_SHADOW } from './shadow.glsl.js';

/* ------------------------------------------------------------------- text pass */

// TEXT IN THE WORLD. A separate program rather than a branch in the scene shader, for three
// reasons that are all about not paying for text on the 10.8 M vertices that are not text:
//
//   1. The scene pass is opaque, writes depth and feeds the depth buffer that SSAO and SSR march.
//      A glyph is a DECAL a centimetre off the fascia behind it: it must be blended (its edge is
//      analytic coverage, and a hard alpha test aliases a 3 px cap height into confetti), and it
//      must NOT write depth, or an SSR ray would reflect the letter instead of the shopfront and
//      SSAO would find an occluder floating in front of a flat wall. Those are opposite states.
//   2. Blending needs the text drawn after the opaque geometry. Giving it its own entry point
//      makes that an explicit ordering the caller controls rather than an accident of which
//      material class the glyphs happened to land in.
//   3. It keeps the atlas sampler, the fwidth() of the texture coordinate and the level-of-detail
//      fade out of the shader that every building in the city compiles through.
//
// It is NOT a separate lighting model. Everything below — the daylight albedo expansion, the key,
// the cascades, the directional sky irradiance, the street-lamp spill, the emissive rule and the
// aerial perspective — is the scene shader's, term for term, so a painted board and the wall it
// is painted on move together at every time of day. What is missing is deliberate: no window
// lattice (a glyph is not a curtain wall) and no GGX lobe from the key (vinyl and enamel letters
// are matte, and the board behind them already carries the sheen).
//
// The glyph itself is a signed distance field; see render/font.js for why, and for the atlas.
export const TEXT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
layout(location = 3) in vec4 aMat;
layout(location = 4) in float aUv;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vNormal;
out vec3 vColor;
out vec4 vMat;
out vec3 vWorld;
out vec2 vUv;

${GLSL_UV}

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vMat = aMat;
  // Unpacked HERE, per vertex, so the varying interpolates a real vec2 and the 12-bit
  // quantisation cannot accumulate across the quad.
  vUv = vhUnpackUv(aUv);
  gl_Position = uViewProj * wp;
}
`;

export const TEXT_FS = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vColor;
in vec4 vMat;
in vec3 vWorld;
in vec2 vUv;

uniform sampler2D uGlyphs;
uniform vec4 uGlyphAtlas;    // xy = atlas size in texels, z = SDF texel range, w = cap height (texels)
uniform vec4 uTextLod;       // x = fade start (m), y = 1/fade span, z = gone below this cap px,
                             // w = fully opaque above this cap px
uniform float uTextWeight;   // texels of dilation applied as the glyph minifies

uniform vec3 uCameraPos;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uStreetColor;
uniform vec3 uFogColor;
uniform vec3 uTint;
uniform vec4 uFogParams;
uniform vec4 uFogRange;
uniform vec4 uDayIndirect;
uniform float uFogBeta;
uniform float uSkyBounce;
uniform float uNightFactor;
uniform float uDaylight;
uniform float uExposure;
uniform float uAlpha;
uniform float uOutputMode;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMat;
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_SHADOW}

void main() {
  // --- coverage from the distance field -------------------------------------
  // Every derivative is taken up here, in uniform control flow: fwidth() past the discard below
  // would be undefined for any 2x2 quad straddling a glyph edge, which is most of them.
  float sd = texture(uGlyphs, vUv).r;
  vec2 duv = fwidth(vUv) * uGlyphAtlas.xy;
  float texPerPx = max(max(duv.x, duv.y), 1e-5);
  // Signed distance to the outline in TEXELS, positive inside. Dividing by the texel footprint
  // of one screen pixel converts it to pixels of coverage, which is exact antialiasing at any
  // magnification and the whole reason this is a distance field.
  float d = (sd - 0.5) * uGlyphAtlas.z;
  // Strokes thinner than a pixel do not survive a correct coverage calculation: they go grey and
  // then vanish, which reads as the sign going blank rather than going small. Dilating by a
  // fraction of a texel exactly as fast as the glyph minifies keeps the WORD legible as a shape
  // for another 30 m. It is zero at 1:1, so nothing close up is fattened.
  float bold = uTextWeight * smoothstep(0.8, 3.0, texPerPx);
  float cov = clamp((d + bold) / texPerPx + 0.5, 0.0, 1.0);

  // --- level of detail ------------------------------------------------------
  vec3 toEye = uCameraPos - vWorld;
  float viewDist = length(toEye);
  // Two gates, and the tighter one wins. DISTANCE is the hard guarantee the tile stage is built
  // around. SIZE is the honest one: it is keyed on the glyph's cap height in PIXELS, so a 120 mm
  // street blade disappears at 40 m and a 2 m tower crown survives to 700 m, with no per-run
  // attribute and nothing for a caller to get wrong.
  float distFade = 1.0 - clamp((viewDist - uTextLod.x) * uTextLod.y, 0.0, 1.0);
  float capPx = uGlyphAtlas.w / texPerPx;
  float sizeFade = smoothstep(uTextLod.z, uTextLod.w, capPx);
  float alpha = cov * distFade * sizeFade * clamp(uAlpha, 0.0, 1.0);

  // --- key light + cascaded shadows -----------------------------------------
  // Hoisted ABOVE the discard on purpose. vhShadow is the only sampler left in this shader that
  // takes an implicit level of detail, and derivatives are undefined once any lane in the 2x2
  // quad has been killed — which is every quad along a glyph edge, i.e. all of them. Doing the
  // cascade lookup first means nothing after the discard needs a derivative, so the early-out
  // costs the sky, the GGX weights, the fog and the grade and is still legal.
  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uKeyDir), 0.0);
  float shadow = vhShadow(vWorld, N, ndl, viewDist);

  // Below the coverage floor the fragment cannot change the frame: under SRC_ALPHA blending an
  // alpha of zero is an exact no-op on both draw buffers. That is most of the padded quad around
  // every glyph, so the early-out is worth having.
  if (alpha < 0.004) discard;

  // --- material -------------------------------------------------------------
  float emis = clamp(vMat.x, 0.0, 4.0);
  float tintable = clamp(vMat.y, 0.0, 1.0);
  float rough = clamp(vMat.z, 0.03, 1.0);

  vec3 albedo = vColor * mix(vec3(1.0), uTint, tintable);
  float dayAlb = uDaylight * (1.0 - smoothstep(0.44, 0.56, emis));
  albedo = vhDayAlbedo(albedo, dayAlb);

  vec3 V = viewDist > 1e-4 ? toEye / viewDist : vec3(0.0, 1.0, 0.0);
  float ndv = clamp(dot(N, V), 1e-3, 1.0);
  float hAbove = vWorld.y - vhGroundApprox(vWorld.xz);
  float vertical = clamp(1.0 - abs(N.y) * 1.35, 0.0, 1.0);

  vec3 keyCol = uKeyColor * mix(1.0, VH_DAY_SUN_GAIN, uDaylight);
  vec3 direct = keyCol * ndl * shadow;

  // --- urban bounce ---------------------------------------------------------
  float lit = clamp(ndl * shadow, 0.0, 1.0);
  float shadeW = (1.0 - lit) * (1.0 - lit);
  float bounceK = mix(max(uDayIndirect.x, 0.0), max(uDayIndirect.y, 0.0), clamp(N.y, 0.0, 1.0));
  vec3 bTint = mix(vec3(1.0), VH_DAY_BOUNCE_TINT, clamp(uDayIndirect.w, 0.0, 1.0));
  bTint /= max(vhLum(bTint), 1e-4);
  vec3 bounce = keyCol * bTint * (bounceK * shadeW * uDaylight);

  // --- sky ambient ----------------------------------------------------------
  float skyView = mix(1.0, mix(clamp(uDayIndirect.z, 0.0, 1.0), 1.0, clamp(N.y, 0.0, 1.0)),
    uDaylight);
  vec3 ambient = vhSkyIrradiance(N, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir, uAmbientGround)
    * (max(uSkyBounce, 0.0) * mix(1.0, VH_DAY_SKY_FILL, uDaylight) * skyView);

  vec3 R = reflect(-V, N);
  vec3 envSharp = vhSkyGradient(R, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);
  float horizonOcc = clamp(R.y * 2.6 + 0.42, 0.0, 1.0);
  envSharp = mix(uAmbientGround * 1.15, envSharp, horizonOcc);
  vec3 env = mix(uAmbientSky, envSharp, 1.0 - rough);
  vec3 specW = vhEnvSpecWeight(ndv, rough);
  vec3 specEnv = env * specW;
  vec3 kd = vec3(1.0) - specW;

  // --- street lighting ------------------------------------------------------
  // The term that actually makes a shop name readable at night: a fascia sits 3 m off the ground
  // and the lamp wash is what is falling on it.
  float spill = exp2(-1.442695 * clamp(hAbove, 0.0, 80.0) * 0.135) * smoothstep(-3.0, 0.6, hAbove);
  vec3 street = uStreetColor * spill * (0.30 + 0.70 * vertical);

  vec3 ambientTerm = albedo * ((ambient + bounce) + street) * kd + specEnv;
  vec3 col = ambientTerm + albedo * direct * kd;

  // --- emissive: an internally lit sign, and only at night --------------------
  // CONTRACT Amendment 7. A painted board carries emissive 0 and is legible by daylight alone; a
  // lit box sign carries emissive > 0 and the renderer, not the author, decides that it is off at
  // midday and full after dark. Identical arithmetic to the scene shader so the sign face and the
  // letters on it can never disagree about what time it is.
  float night = clamp(uNightFactor, 0.0, 1.0);
  float el = vhLum(albedo);
  vec3 glow = max(mix(vec3(el), albedo, 1.30), vec3(0.0));
  float e = clamp(emis, 0.0, 1.0) * mix(0.20, 1.0, night) * (1.0 - clamp(uDaylight, 0.0, 1.0));
  if (uOutputMode > 0.5) glow *= mix(1.25, 1.62, night);
  col = mix(col, glow, e);

  // --- height fog + aerial perspective ---------------------------------------
  float fogAmt = vhFogAmount(uCameraPos, vWorld, uFogParams, uFogRange, uFogBeta);
  vec3 viewDir = viewDist > 1e-4 ? -V : vec3(0.0, 0.0, 1.0);
  vec3 aerial = vhAerial(uFogColor, viewDir, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir,
    uKeyColor, uDaylight, vhAerialWeld(viewDist, uFogRange));
  col = mix(col, aerial, fogAmt);
  col = max(col, vec3(0.0));

  // The material target is blended by the same coverage, so a glyph edge hands the resolve a
  // weighted mix of the letter and the board it sits on — which is what is actually there. The
  // normal is the board's normal to within a rounding error (the quad is coplanar with it), so
  // blending the octahedral encoding is a no-op in practice rather than the nonsense it would be
  // between two differently-oriented surfaces.
  float ambLum = vhLum(ambientTerm) * (1.0 - e) * (1.0 - fogAmt);
  float share = clamp(ambLum / max(vhLum(col), 1e-4), 0.0, 1.0);
  outMat = vec4(vhOctEncode(N), rough, share);
  outColor = vec4(vhOutD(col, uOutputMode, uDaylight, uExposure), alpha);
}
`;
