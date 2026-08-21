// src/render/shaders/scene.glsl.js -- the geometry pass.
//
// One forward program with MRT: linear HDR radiance to COLOR_ATTACHMENT0 and
// oct(N).xy / roughness / ambient share to COLOR_ATTACHMENT1. It composes the shared sky and
// fog model, the filmic grade, the cascade lookup, the procedural facade grid and the clustered
// local lights, which is every piece of GLSL in the project except the post chain.
// 
// No backticks -- see common.glsl.js.

import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GRADE } from './grade.glsl.js';
import { GLSL_SHADOW } from './shadow.glsl.js';
import { GLSL_FACADE } from './facade.glsl.js';
import { GLSL_LIGHTS } from './lights.glsl.js';

/* ------------------------------------------------------------------ scene pass */

export const SCENE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
// vec4 since the vertex format grew a fourth material channel:
//   x = emissive, y = tintable, z = roughness, w = LIGHTING PROFILE (0..5, see GLSL_FACADE).
layout(location = 3) in vec4 aMat;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vNormal;
out vec3 vColor;
out vec4 vMat;
out vec3 vWorld;
// The profile is an ENUM, not a quantity. Interpolating it would invent profile 1.5 along any
// triangle whose vertices ever disagree, so it travels flat and the fragment stage can compare
// it with ==.
flat out float vProfile;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vMat = aMat;
  vProfile = aMat.w;
  gl_Position = uViewProj * wp;
}
`;

export const SCENE_FS = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vColor;
in vec4 vMat;
in vec3 vWorld;
flat in float vProfile;

uniform vec3 uCameraPos;
uniform vec3 uKeyDir;        // TOWARD the key light (low raking skylight / moon)
uniform vec3 uKeyColor;
uniform vec3 uSunDir;        // TOWARD the (below-horizon) sun — sets the warm azimuth
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyWest;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uStreetColor;   // sodium/LED wash on the lowest few metres of every facade
uniform vec3 uFogColor;
uniform vec3 uTint;
uniform vec4 uFogParams;
uniform vec4 uFogRange;   // x = horizon-closer start (m), y = 1/span, zw = cap-opening window
uniform float uFogBeta;   // aerial perspective: extinction per metre, ALREADY x daylight
uniform vec4 uCnTower;       // xy = world XZ of the tower axis, z = base Y, w = mask radius (m)
uniform float uSkyBounce;    // gain on the directional sky irradiance
uniform float uNightFactor;
uniform float uWindowMix;
uniform float uWindowLit;
uniform float uWindowGain;
uniform float uDaylight;     // 0 = blue hour / night, 1 = full sun. Every daylight path is gated
                             // on this and is an EXACT no-op at 0.
uniform vec4 uDayIndirect;   // x = wall bounce, y = street bounce, z = sky view, w = warmth
uniform vec4 uRoad;          // x = wetness, y = dry roughness, z = wet roughness, w = anisotropy
uniform float uEmitterGain;  // how much brighter a genuine luminaire is than a lit window pane
uniform float uExposure;     // daylight exposure, applied with the OETF in the grade
uniform float uTime;
uniform float uFlash;
uniform float uAlpha;
uniform float uOutputMode;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outMat;
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_SHADOW}
${GLSL_FACADE}
${GLSL_LIGHTS}

// --- daylight model constants -----------------------------------------------------------------
// VH_DAY_SKY_FILL, VH_DAY_SUN_GAIN and VH_DAY_GROUND_GAIN live in GLSL_COMMON, above: the water
// pass needs them too, and these two are written in terms of them, so they must be declared after
// the include and not before it.
//
// A sun glint on a curtain wall is genuinely blinding, but a whole tower going white is not a
// picture. Widen the sun lobe to something no flat-glass facade beats at 200 m, then cap it.
// The cap tracks VH_DAY_SUN_GAIN — it is a ceiling on the SUN's own lobe, so opening the sun up
// without opening it would clip every glint in the city to the same flat value.
const float VH_DAY_SUN_ALPHA = 0.030;
const float VH_DAY_SPEC_MAX = 1.20 * VH_DAY_SUN_GAIN;

void main() {
  vec3 N = normalize(vNormal);
  float emis = clamp(vMat.x, 0.0, 4.0);
  float tintable = clamp(vMat.y, 0.0, 1.0);
  float rough = clamp(vMat.z, 0.03, 1.0);
  // The AUTHORED roughness, kept because it is the only thing in the vertex format that separates
  // a carriageway from the kerb beside it: city.js gives asphalt 0.18 and highway 0.16 while every
  // matte ground cover it emits — sidewalk 0.72, kerb 0.70, path 0.78, ballast 0.95 — sits far
  // above. The 'rough' local itself is rewritten several times below, so it cannot be used.
  float rough0 = rough;
  // The lighting profile: 0 envelope, 1 office, 2 residential, 3 retail, 4 parking, 5 civic.
  // It arrives flat-interpolated, so this rounds an exact integer and never a blend of two.
  int prof = int(clamp(vProfile, 0.0, 5.0) + 0.5);

  // The emissive channel re-uses the TINTED albedo rather than the raw vertex colour so tintable
  // glowing meshes glow in their tint. For every window/lamp vert (tintable = 0) this is
  // identical to the raw vertex colour.
  vec3 albedo = vColor * mix(vec3(1.0), uTint, tintable);

  // Undo city.js's blue-hour albedo bake in proportion to the daylight, so a white facade really
  // is a 0.85-reflectance white facade under the sun instead of an 18%-reflectance grey one.
  // Genuine emitters (street lamps, beacons, the CN Tower's glazed bands — emissive >= 0.5) carry
  // authored RADIANCE in this channel, not reflectance, so they are excluded.
  float dayAlb = uDaylight * (1.0 - smoothstep(0.44, 0.56, emis));
  albedo = vhDayAlbedo(albedo, dayAlb);

  // The facade's HUE, normalised so it is a filter and not an attenuator, and how glassy the
  // surface was BEFORE the mullion term below roughens it. Interior light has to pass through
  // this material on its way out, and that is the whole reason Royal Bank Plaza glows amber
  // bronze instead of white: its curtain wall is real gold leaf. Blue-green condo glass does the
  // same thing in the other direction, and matte black steel at TD barely tints at all.
  vec3 facadeHue = albedo / max(max(max(albedo.r, albedo.g), albedo.b), 1e-3);
  float glazing = 1.0 - smoothstep(0.10, 0.34, rough);

  vec3 toEye = uCameraPos - vWorld;
  float viewDist = length(toEye);
  vec3 V = viewDist > 1e-4 ? toEye / viewDist : vec3(0.0, 1.0, 0.0);
  float ndv = clamp(dot(N, V), 1e-3, 1.0);

  // Metres above the LOCAL street, which downtown is nowhere near metres above the lake: grade
  // climbs about 30 m from the ferry docks up to Queen St. Shopfront bands, parking decks, the
  // street-lamp spill and the contact darkening are all placed by this, not by world Y.
  float hAbove = vWorld.y - vhGroundApprox(vWorld.xz);

  // --- procedural facade lighting -------------------------------------------
  // Profile 0 is an ENVELOPE and gets NO window grid at all: that is what the Rogers Centre dome,
  // Scotiabank Arena, Roy Thomson Hall and the CN Tower are. Painting one warm office curtain
  // wall over every vertical surface in the city — a stadium roof included — was the single
  // loudest "procedurally generated" tell in the previous build, and this line is the fix.
  //
  // The vertical test keeps roofs out, and also keeps wet asphalt (rough 0.18) and the lake
  // (0.03) out: the old code had a "smooth enough to be glass" fallback that dragged both into
  // the curtain-wall branch and roughened them, which switched off the reflections that are the
  // signature of this look. Profiles make that fallback unnecessary — delete it, do not restore.
  float vertical = clamp(1.0 - abs(N.y) * 1.35, 0.0, 1.0);
  float windowed = prof > 0 ? clamp(uWindowMix * vertical, 0.0, 1.0) : 0.0;

  // Dry pavement. The wet-street look — asphalt at roughness 0.18, mirroring the towers — is a
  // BLUE-HOUR art direction (CONTRACT 0) and city.js bakes it into the roads, sidewalks and
  // terrain. At 15:20 the asphalt is dry, and a mirror-finish road under a noon sun does not read
  // as rain, it reads as a flood. This only touches near-horizontal ground: tower glass is
  // vertical and untouched, roofs are already matte, and Lake Ontario is drawn by the water
  // shader, so the harbour keeps its reflection.
  float ground = smoothstep(0.55, 0.85, N.y);
  rough = clamp(mix(rough, max(rough, 0.72), uDaylight * ground), 0.03, 1.0);

  // --- asphalt is not glass ------------------------------------------------
  // The wet-street look is the signature of this build (CONTRACT §0), and it had been taken to a
  // place where the carriageway behaved like a polished sheet: authored at roughness 0.18 it kept
  // 82% of a SHARP sky reflection, picked up vhEnvSpecWeight's polish tail (a term that exists so
  // mirror-smooth curtain wall silvers at a grazing angle), and handed SSR a confidence of 0.53
  // over the whole roadway. Every square metre of every street mirrored the towers equally. Real
  // asphalt does not. It is a rough mineral aggregate; it returns a BROAD, DIM sheen, and it turns
  // into a mirror only where there is genuinely a film of water on it.
  //
  //   dry  0.55  bituminous aggregate. Wide lobe, no polish tail, and — because SSR reads the
  //              same roughness out of the material G-buffer — SSR switches itself off entirely
  //              (its gate is 1 - smoothstep(0.07, 0.30, rough), which is 0 by 0.30).
  //   wet  0.11  standing water. Sharper than the old blanket 0.18, so where the road IS wet it
  //              mirrors the skyline harder than it ever did — the signature survives, it just
  //              stops being everywhere at once.
  //
  // The wet field is world-space value noise, so puddles sit in the same places every frame and
  // across tile boundaries, and the transition between the two is smooth in ROUGHNESS, which
  // means SSR fades in and out with it instead of switching at a hard edge.
  //
  // Gated on (1 - uDaylight): at Afternoon this whole block multiplies by exactly zero and the
  // line above — which already forces a dry 0.72 under a sun — is untouched, to the bit.
  float roadAmt = ground * (1.0 - smoothstep(0.16, 0.38, rough0)) * (1.0 - uDaylight);
  float roadAniso = 0.0;
  if (roadAmt > 0.002) {
    float wet = vhRoadWet(vWorld.xz, clamp(uRoad.x, 0.0, 1.0));
    rough = clamp(mix(rough, mix(uRoad.y, uRoad.z, wet), roadAmt), 0.03, 1.0);
    // Dry aggregate carries the anisotropy; a wet film is a liquid surface and has none.
    roadAniso = clamp(uRoad.w, 0.0, 1.0) * roadAmt * (1.0 - wet);
  }

  // Ground-cover reflectance under a sun — see VH_DAY_GROUND_GAIN for the numbers and for why
  // the inverse bake cannot do this job. Sky-facing and near the street is what says "ground
  // cover" here: the terrain, the carriageway, the sidewalks, the kerbs, the piers, the bridge
  // and expressway decks, the low roof caps and the tops of the props, all of which city.js
  // authors on the same dark table. It fades out by 22 m so that the curved sky-facing cladding
  // of an envelope, which is authored on the FACADE scale, is never touched.
  //
  // Driven by dayAlb rather than by uDaylight, so it inherits the same EMITTER exclusion
  // vhDayAlbedo uses: a lamp head carries authored RADIANCE in this channel (city.js's sodium is
  // 1.00 in red), not reflectance, and running that through a ground gain would turn the top of
  // every mast in the city into a white chip at noon. The reflectance ceiling is likewise applied
  // INSIDE the mix and never outside it — uTint can push a colour past 1 too. Nothing here is a
  // light: it is what the surface reflects. At groundLift 0 the line below is the identity, to
  // the bit, which is what keeps blue hour and night untouched.
  float groundLift = ground * dayAlb
    * (1.0 - smoothstep(VH_DAY_GROUND_LOW, VH_DAY_GROUND_TOP, hAbove));
  albedo = mix(albedo, min(albedo * VH_DAY_GROUND_GAIN, vec3(VH_ALBEDO_MAX)), groundLift);

  // The facade's own horizontal axis, and the screen-space footprint of one metre along it.
  // Both are computed HERE, outside every branch: fwidth() in non-uniform control flow is
  // undefined, and a 2x2 quad on the edge of a tower straddles the branch below.
  vec3 wT = cross(vec3(0.0, 1.0, 0.0), N);
  float wTl = length(wT);
  wT = wTl > 1e-3 ? wT / wTl : vec3(1.0, 0.0, 0.0);
  vec2 wUv = vec2(dot(vWorld, wT), vWorld.y);
  vec2 wAA = max(fwidth(wUv), vec2(1e-5));

  float pane = 1.0;
  vec3 windowLight = vec3(0.0);
  if (windowed > 0.002) {
    windowLight = vhFacade(prof, vWorld, N, wUv, wAA, uWindowLit, uTime, hAbove, pane) * windowed;
    // Panes are glass; mullions, spandrels, balcony slabs and masonry are not. Only the fraction
    // of the pixel that is actually frame gets roughened and darkened.
    float frameMix = (1.0 - pane) * windowed;
    rough = clamp(mix(rough, min(rough * 2.1 + 0.22, 0.95), frameMix), 0.03, 1.0);
    albedo *= mix(1.0, 0.80, frameMix);
  }

  // --- key light + cascaded shadows ----------------------------------------
  // uKeyColor is a DUSK-scale key (see VH_DAY_SUN_GAIN): at blue hour it stands exactly as the
  // preset authored it, and as the sun comes up it opens to what a real disc delivers next to
  // this sky. Everything the sun does — the diffuse term, the GGX lobe and, through the shadow
  // factor, the cascades — scales together, which is the whole point: a cast shadow is only as
  // legible as the light it is subtracting.
  vec3 keyCol = uKeyColor * mix(1.0, VH_DAY_SUN_GAIN, uDaylight);
  float ndl = max(dot(N, uKeyDir), 0.0);
  float shadow = vhShadow(vWorld, N, ndl, viewDist);
  vec3 direct = keyCol * ndl * shadow;

  // --- urban bounce: what the sunlit city throws back into its own shade -----
  // The term that makes a shaded street BRIGHT at three in the afternoon. See the uDayIndirect
  // block in GLSL_COMMON for the derivation. keyCol already carries VH_DAY_SUN_GAIN, so this is
  // a fraction of the sun's own irradiance; the extra uDaylight makes it exactly zero at blue
  // hour and at night, where the sun is below the horizon and there is nothing to bounce.
  float lit = clamp(ndl * shadow, 0.0, 1.0);
  float shadeW = (1.0 - lit) * (1.0 - lit);
  float bounceK = mix(max(uDayIndirect.x, 0.0), max(uDayIndirect.y, 0.0), clamp(N.y, 0.0, 1.0));
  // Unit-luminance warm tint: warmth moves the bounce's colour, never its brightness.
  vec3 bTint = mix(vec3(1.0), VH_DAY_BOUNCE_TINT, clamp(uDayIndirect.w, 0.0, 1.0));
  bTint /= max(vhLum(bTint), 1e-4);
  vec3 bounce = keyCol * bTint * (bounceK * shadeW * uDaylight);

  // --- GGX specular from the key -------------------------------------------
  float a = max(rough * rough, 0.0016);
  // The sun has a real angular size and no curtain wall is optically flat at 200 m. Under a
  // daylight-scale key a needle-thin mirror lobe returns four figures of radiance from one pixel,
  // so widen the lobe to the sun's own footprint and cap what comes back: the tower keeps a hard
  // bright glint where the reflection lines up and stays a building everywhere else.
  float aKey = max(a, VH_DAY_SUN_ALPHA * uDaylight);
  vec3 H = normalize(uKeyDir + V);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float vdh = clamp(dot(V, H), 0.0, 1.0);
  vec3 F0 = vec3(0.04);
  vec3 F = vhF_Schlick(F0, vdh);
  vec3 spec = keyCol * ndl * shadow * (vhD_GGX(ndh, aKey) * vhV_Smith(ndv, ndl, aKey)) * F;
  spec = min(spec, vec3(mix(12.0, VH_DAY_SPEC_MAX, uDaylight)));

  // --- sky ambient, and why the city has 33 real facade colours -------------
  // At blue hour the sun is gone and a facade is lit by the SKY. That is the ONLY light that
  // reveals what a building is made of, so it cannot be a single flat constant: with a constant,
  // every face of every tower gets the same grey wash, unlit surfaces collapse toward black, and
  // the surveyed colours in data/toronto.json — Royal Bank Plaza's gold, Mies' matte black at TD,
  // Scotia Plaza's red granite, the teal-blue glass on half the condo stock — all disappear.
  //
  // vhSkyIrradiance takes two taps of the same gradient the sky pass draws, so a west-facing
  // facade genuinely catches the afterglow and a north-facing one stays indigo. Directional, so
  // it lifts the colour WITHOUT flattening the image the way raising a constant would.
  //
  // In DAYLIGHT the roles swap: the sun is the key and the sky is fill, so the same directional
  // term is scaled down. What is left is what actually fills a shadow — which is why a shadowed
  // wall at noon comes out sky-blue and about a fifth as bright as the sunlit one beside it,
  // instead of the flat 1-luma difference the blue-hour balance produced.
  //
  // The sky VIEW correction (uDayIndirect.z) rides on the same gate. vhSkyIrradiance samples the
  // dome along the normal, not over a cosine-weighted hemisphere, so under this sky profile a
  // vertical wall collects more of it than the horizontal road at its foot — backwards, and the
  // reason the carriageway was the darkest surface in the frame. It is a pure scale on the
  // DIFFUSE term: env and specEnv below are left exactly as they were, because the SSR resolve
  // subtracts that analytic environment term back out and the delta has to stay exact.
  float skyView = mix(1.0, mix(clamp(uDayIndirect.z, 0.0, 1.0), 1.0, clamp(N.y, 0.0, 1.0)),
    uDaylight);
  vec3 ambient = vhSkyIrradiance(N, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir, uAmbientGround)
    * (max(uSkyBounce, 0.0) * mix(1.0, VH_DAY_SKY_FILL, uDaylight) * skyView);

  // --- ambient specular: the actual sky, in the reflection direction --------
  // This is what separates glass from concrete before SSR even runs, and it is the term SSR
  // later swaps out for a real screen-space hit.
  vec3 R = reflect(-V, N);
  vec3 envSharp = vhSkyGradient(R, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir);
  float horizonOcc = clamp(R.y * 2.6 + 0.42, 0.0, 1.0);
  envSharp = mix(uAmbientGround * 1.15, envSharp, horizonOcc);
  vec3 env = mix(uAmbientSky, envSharp, 1.0 - rough);
  vec3 specW = vhEnvSpecWeight(ndv, rough);
  vec3 specEnv = env * specW;

  // Energy conservation, and the whole reason glass now behaves like glass. What a surface
  // mirrors back it does not also transmit: face-on a curtain wall keeps ~96% of its tint, and
  // at a grazing angle it loses nearly all of it and becomes a mirror of the sky. Without this
  // the diffuse term simply stacked on top of the reflection and every tower read as painted
  // cardboard whichever way you looked at it.
  vec3 kd = vec3(1.0) - specW;

  // --- fake contact AO: vertical faces darken as they approach the ground ----
  // Short ramp (~2 m) so it only grubs up the contact line where geometry meets the street.
  // SSAO does the real work; this survives with SSAO off.
  float contact = 1.0 - 0.32 * (1.0 - smoothstep(0.0, 2.0, hAbove)) * (1.0 - max(N.y, 0.0));

  // --- street lighting ------------------------------------------------------
  // Sodium and cool-LED lamps wash the bottom few metres of every facade in the city. Down at
  // eye level — where the player actually walks — this, not the sky, is what makes a facade's
  // colour and material legible, and it is what puts brick, limestone and painted stucco back
  // into a scene the tower windows would otherwise dominate.
  float spill = exp2(-1.442695 * clamp(hAbove, 0.0, 80.0) * 0.135) * smoothstep(-3.0, 0.6, hAbove);
  vec3 street = uStreetColor * spill * (0.30 + 0.70 * vertical);

  // --- the lamps themselves -------------------------------------------------
  // uStreetColor above is a WASH: one uniform, one exponential in height above grade, the same
  // everywhere in the city. It says "there is street lighting in this world". It cannot say where
  // any of it is, and on a horizontal surface its 0.30 factor put 3%-reflectance asphalt at 0.002
  // linear — black — under every mast in Toronto.
  //
  // These are the actual luminaires: punctual lights at the surveyed lamp positions, clustered in
  // world space (see GLSL_LIGHTS and the LIGHT_* block). The wash is deliberately LEFT ALONE, so a
  // build that registers no lights at all renders exactly as it did; the pools are added on top,
  // and where they exist they are two orders of magnitude above the wash and simply dominate it.
  vec3 lampDiff = vec3(0.0);
  vec3 lampSpec = vec3(0.0);
  vhLocalLights(vWorld, N, V, ndv, rough, roadAniso, lampDiff, lampSpec);

  // The bounce joins the ambient rather than the direct light: it arrives from every direction
  // at once, it is what the SSAO resolve is entitled to occlude (an alcove sees less of the lit
  // city too), and it must not carry a shadow — it IS the light the shadow left behind.
  vec3 ambientTerm = albedo * ((ambient + bounce) * contact + street) * kd + specEnv;
  // Local lights are DIRECT light and stay out of the ambient share for the same reason the key
  // does: the pool under a lamp is not something an ambient-occlusion term is entitled to remove.
  vec3 col = ambientTerm + albedo * direct * kd + spec + albedo * lampDiff * kd + lampSpec;

  // --- emissive -------------------------------------------------------------
  float night = clamp(uNightFactor, 0.0, 1.0);
  // Pre-saturating the glow colour keeps interior light reading as interior light: the filmic
  // shoulder crushes chroma as it approaches white, so pushing chroma out BEFORE the grade is
  // the difference between a warm office window and a flat white one.
  float el = vhLum(albedo);
  vec3 glow = max(mix(vec3(el), albedo, 1.30), vec3(0.0));
  // CONTRACT Amendment 7: an emitter is a LAMP, and a lamp is OFF at midday. The night factor
  // alone left a 20 percent floor under every lamp head, lit sign and shop interior at 15:20 --
  // measured at 123 luma units of glow across 740 pixels in a frame where it should be zero.
  // Daylight closes the rig down, exactly as it already does for the CN Tower's night lighting
  // below. uDaylight is 0 at blue hour and at night, so both of those presets are untouched.
  float e = clamp(emis, 0.0, 1.0) * mix(0.20, 1.0, night) * (1.0 - clamp(uDaylight, 0.0, 1.0))
    * (1.0 - windowed * 0.85);
  // Emissive headroom for the bright pass. Kept modest on purpose: at 2.2 the emitter colour
  // plus the additive bloom halo drove the composite peak far past 1.0 and everything landed on
  // the shoulder together, so most lit pixels came out colourless white.
  if (uOutputMode > 0.5) glow *= mix(1.25, 1.62, night);
  col = mix(col, glow, e);

  // A LAMP IS NOT A LIT WINDOW PANE. mix(col, glow, e) can never take a surface past its own
  // albedo, so a sodium lens at emissive 1.0 arrived at very nearly the same screen value as an
  // office pane behind glass — which is why every mast in the city read as decoration rather than
  // as the source of the light on the pavement under it.
  //
  // city.js and props.js both mark a GENUINE luminaire with emissive >= 0.50 (their EMITTER_MIN)
  // and a facade "there are windows here" hint with emissive <= 0.10, so the two are separable
  // with no new channel. Genuine emitters get their radiance lifted ADDITIVELY, which puts them
  // decisively over the bright pass' threshold and gives them the bloom halo that is what
  // actually makes a lamp read as a lamp from three blocks away.
  //
  // The grazing term is the reason it reads FROM THE SIDE. A cobra head's lens is a downward-
  // facing frosted panel: seen from below it is a flat rectangle, seen from across the street it
  // is edge-on, and a diffuser shows more of its own scattering depth the more obliquely you look
  // through it. Bounded at 1.30 and never divided by ndv, so it cannot go singular.
  //
  // The 'e' factor already carries mix(0.20, 1.0, night) * (1 - uDaylight), so this is off at
  // Afternoon by exactly the gate the rest of the emissive rig uses — CONTRACT Amendment 7.
  float lamp = smoothstep(0.44, 0.56, emis) * e;
  if (lamp > 0.002) col += glow * (lamp * max(uEmitterGain, 0.0) * (0.70 + 0.60 * (1.0 - ndv)));

  // Window light is added, not mixed: the pane still reflects the sky on top of what is behind
  // it, which is exactly how a lit curtain wall behaves at dusk. The gain is deliberately well
  // below where it used to sit — the previous build was so bright and so uniform that the
  // windows WERE the skyline, and drowning the facades is most of what made it read as
  // wallpaper. Interior light should be a texture on the massing, not a replacement for it.
  float winGain = uWindowGain * mix(0.32, 1.0, night) * (uOutputMode > 0.5 ? 1.15 : 1.0);
  // The tint is clamped off zero so a pathological facade colour (OSM carries a few near-black
  // hex values) can never switch a whole channel of a building's interior light off.
  col += windowLight * mix(vec3(1.0), max(facadeHue, vec3(0.22)), 0.65 * glazing) * winGain;

  // --- CN Tower: the one object on this skyline that gets its own identity ---
  // Masked purely by distance from the tower's own axis, so it needs no attribute channel and
  // cannot leak onto a neighbour: the nearest other structure, Ripley's Aquarium, stands 36 m
  // out and the mask is fully closed by 34 m.
  vec2 cnD = vWorld.xz - uCnTower.xy;
  float cnR = length(cnD);
  float cnW = max(uCnTower.w, 1.0);
  float cnMask = 1.0 - smoothstep(cnW * 0.85, cnW, cnR);
  if (cnMask > 0.002) {
    float hUp = vWorld.y - uCnTower.z;
    // The programmable LED wash runs from just above the plaza to the tip of the mast.
    float shaft = smoothstep(2.0, 14.0, hUp) * (1.0 - smoothstep(548.0, 556.0, hUp));
    // A floodlit cylinder reads by its RIM: the wash is brightest where the surface turns away
    // from the eye, which is what stops the tower looking like a flat painted stripe.
    float g1 = 1.0 - ndv;
    float rim = 0.40 + 0.60 * g1 * g1;
    vec3 wash = vhCnWash(hUp, uTime) * shaft * rim * vertical;
    // The restaurant band at 346-357 m and the SkyPod at 437-442 m are GLAZED and lit warm from
    // within. They are the two horizontal accents that fix the tower's proportions in the eye.
    float podBand = smoothstep(345.0, 347.0, hUp) * (1.0 - smoothstep(356.0, 358.5, hUp));
    float skyPod = smoothstep(435.5, 437.0, hUp) * (1.0 - smoothstep(441.5, 443.5, hUp));
    vec3 podLight = vec3(1.00, 0.80, 0.54) * (podBand * 0.95 + skyPod * 0.75);
    // Red aviation beacons up the mast, each on its own slow pulse so they never march in step.
    float beac = vhCnBeacon(hUp, 370.0, 1.9, uTime) + vhCnBeacon(hUp, 447.0, 2.3, uTime)
      + vhCnBeacon(hUp, 498.0, 1.7, uTime) + vhCnBeacon(hUp, 540.0, 2.7, uTime);
    vec3 cn = wash * 0.70 + podLight + vec3(1.00, 0.10, 0.055) * min(beac, 2.0) * 0.90;
    // The LED wash, the lit pod bands and the aviation beacons are a NIGHT lighting rig. At 15:20
    // the rig is off and the tower is just painted concrete, so daylight closes it down.
    col += cn * cnMask * mix(0.30, 1.0, night) * (1.0 - uDaylight);
  }

  // --- height fog + aerial perspective --------------------------------------
  // Per-FRAGMENT view distance. This must not be a varying: the terrain is a handful of large
  // triangles and interpolating distance across them fogs the middle of a plane by the average
  // of its corner distances instead of by what the camera can actually see.
  float fogAmt = vhFogAmount(uCameraPos, vWorld, uFogParams, uFogRange, uFogBeta);
  vec3 viewDir = viewDist > 1e-4 ? -V : vec3(0.0, 0.0, 1.0);
  // vhAerial carries the daylight in-scatter and the de-blueing of the haze; the density that
  // decides HOW MUCH of it lands is thinned on the JS side (DAY_FOG_DENSITY). Both are gated, so
  // blue hour keeps its indigo aerial perspective exactly.
  vec3 aerial = vhAerial(uFogColor, viewDir, uSkyZenith, uSkyHorizon, uSkyWest, uSunDir,
    uKeyColor, uDaylight, vhAerialWeld(viewDist, uFogRange));
  col = mix(col, aerial, fogAmt);

  float flash = clamp(uFlash, 0.0, 4.0);
  float alpha = clamp(uAlpha, 0.0, 1.0);
  col = max(col, vec3(0.0));

  // Ambient share for the SSAO resolve: how much of the final pixel is ambient light. Emissive
  // mixing and fog scale it exactly the way they scale the ambient term itself, so AO can be
  // applied later WITHOUT touching direct light, window emission or fog.
  float ambLum = vhLum(ambientTerm) * (1.0 - e) * (1.0 - fogAmt);
  float share = clamp(ambLum / max(vhLum(col), 1e-4), 0.0, 1.0);

  outMat = vec4(vhOctEncode(N), rough, share);

  if (uOutputMode < 0.5) {
    outColor = vec4(clamp(vhGradeD(vhDayTone(col, uDaylight, uExposure), uDaylight)
      + vec3(flash), 0.0, 1.0), alpha);
  } else {
    col += vec3(flash * 2.0);
    outColor = vec4(uOutputMode < 1.5 ? col : vhEncode(col), alpha);
  }
}
`;
