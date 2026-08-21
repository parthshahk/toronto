// src/render.js — the TORONTO renderer: a free-roam Camera, and a Renderer that owns every GLSL
// program in the project (scene, sky, water, cascaded shadow depth, SSAO, SSR, post), the
// per-frame environment uniforms, and all WebGL state tracking.
//
// ART DIRECTION (CONTRACT §0) — "blue-hour massing model". ~20:45 in June: the sun is BELOW the
// horizon, so there is no sun disc and almost no warm direct light. The image is carried by
//   1. accurate massing lit by a low raking skylight/moon key + cascaded shadows,
//   2. towers lit FROM WITHIN, per BUILDING TYPE — offices, condos, shopfronts, parking decks
//      and heritage stone all light differently, and envelopes (stadium domes, arenas, concert
//      halls, the CN Tower) have no window grid at all,
//   3. facade COLOUR revealed by directional sky irradiance — at blue hour the sky is the only
//      light there is, and it is what makes gold read gold and Mies' black read black,
//   4. wet streets and a glassy lake reflecting the skyline via screen-space reflections,
//   5. a deep cyan-to-indigo sky grading warm orange at the WNW horizon where the sun just set.
//
// VERTEX FORMAT (14 floats, see gl.js): [px,py,pz, nx,ny,nz, r,g,b, emissive, tintable, rough,
// profile, uv]. `aMat` is a **vec4** at attribute location 3 — (emissive, tintable, rough,
// profile). The profile is an OSM-derived lighting class carried per building by
// data/toronto.json:
//   0 envelope (NO windows) · 1 office · 2 residential · 3 retail · 4 parking · 5 civic
//   6 GLYPH — a quad of text in the world (src/text.js), drawn by the text pass below
// It travels to the fragment stage FLAT, never interpolated: it is an enum, not a quantity.
// `aUv` at location 4 is one float carrying a packed [0,1]^2 texture coordinate; only the text
// pass reads it, and gl.js owns both halves of the encoding (packUv / GLSL_UV).
//
// Rendering model: forward, single geometry pass with MRT.
//   COLOR_ATTACHMENT0  RGBA16F (or RGBA8 range-compressed)  linear HDR radiance
//   COLOR_ATTACHMENT1  RGBA8                                oct(N).xy, roughness, ambient share
//   DEPTH_ATTACHMENT   DEPTH_COMPONENT24 TEXTURE            read by SSAO / SSR
// Post then runs: SSAO -> bilateral blur -> SSR -> resolve (applies AO to AMBIENT ONLY, swaps the
// analytic sky reflection for the screen-space one) -> bloom chain + anamorphic streak ->
// composite (filmic grade, split tone, chromatic aberration, grain, dither).
//
// The "ambient share" channel is what makes AO ambient-only without a deferred renderer or a depth
// pre-pass: the scene shader records what fraction of the pixel's luminance came from ambient, and
// the resolve pass multiplies by `1 - share * (1 - ao)`. Direct light and emissive windows are
// never touched by AO, which is the whole point — a lit window inside an alley must not go grey.
//
// LOCAL LIGHTS. Every street lamp in the city is a real punctual light, not merely an emissive
// lens: a clustered forward rig over a world-space uniform grid, culled and ranked per frame,
// bounded per FRAGMENT by the cluster's slot count rather than by how many lamps the city has.
// Register them once with `renderer.setLights(list)` — see that method — and the renderer owns
// culling, ranking, clustering, the per-frame cap and the time-of-day gate from there. Registering
// nothing renders exactly as this file did before the rig existed. See the LIGHT_* constants for
// why the clusters are world-space and 2-D, and GLSL_LIGHTS for the shading.
//
// EVERY feature degrades independently and NONE of them may block boot:
//   renderer.quality = { shadows: 'off'|'low'|'high', ssao, ssr, bloom, clouds, fxaa, lights }
// plus the original three-tier bloom fallback (float target -> RGBA8 target -> straight to the
// screen, graded in-shader). Anything that fails at setup latches itself off with one warning.
//
// `uOutputMode` is still the switch for where the geometry pass writes:
//   0 = straight to the screen, graded here      (no offscreen pass at all)
//   1 = float offscreen target, linear light out (EXT_color_buffer_float / _half_float)
//   2 = 8-bit offscreen target, range-compressed (RGBA8 fallback, less headroom)
//
// Draw order expected by main.js (shadow casters are picked up automatically — see
// setShadowCasters / beginFrame):
//   renderer.beginFrame(camera)      -> cascade fit + depth passes, binds the HDR target,
//                                       clears, draws the sky
//   renderer.drawMesh(city.meshes.terrain, IDENTITY)
//   renderer.drawMesh(city.meshes.buildings, IDENTITY)   ... roads, sidewalks, rails, props, glass
//   renderer.drawWater(city.meshes.water, camera)
//   renderer.drawText(city.meshes.signs, IDENTITY)       LAST of the geometry: a blended decal
//                                       pass that never writes depth and never casts a shadow
//   renderer.endFrame()              -> SSAO, SSR, resolve, bloom, composite
//
// World axes: X = east, Y = up, Z = south. Right-handed. TRUE METRES.

import {
  clamp, mat4, vec3, m4identity, m4lookAt, m4mul, m4ortho, m4perspective, m4invert,
} from './math.js';
import { Shader, GLSL_UV } from './gl.js';
import { getFont, forgetFont, releaseFont, TEXT_FADE_START, TEXT_FADE_END } from './text.js';

/* ----------------------------------------------------------------- constants */

const WHITE = new Float32Array([1, 1, 1]);

// Blend modes tracked by the renderer.
const BLEND_ALPHA = 1;
const BLEND_MULTIPLY = 2;

// Bloom chain depth: half, quarter and eighth resolution.
const BLOOM_LEVELS = 3;

// Cascaded shadow maps: the shader declares arrays of this size and loops over uCsmCount.
//
// FOUR, not three. Every cascade is fitted to the bounding sphere of its frustum slice and then
// snapped to its own texel grid, which makes one shadow texel almost exactly one screen pixel at
// the FAR edge of that slice, whatever the split — the interesting number is therefore not the
// texel size but the RATIO between consecutive splits, because that is how many pixels a texel
// covers at the NEAR edge, where a cascade is at its worst. Over a fixed reach, n cascades give
// a best-case ratio of (reach / firstSplit)^(1/(n-1)):
//
//     reach 2,860 m, first split 157 m      3 cascades -> 4.3x      4 cascades -> 2.6x
//
// On a 3 km map the far cascade only had to reach 2.4 km and three tiles did it at 4.1x. At the
// new sight lines three tiles cost either a soft mid-field or a near cascade coarser than the one
// the build already ships, and neither is acceptable — so the atlas grows a tile instead. It is
// 8192 x 2048 of DEPTH_COMPONENT24 (67 MB, against 50), _ensureShadowTargets already lays out
// any count over any number of rows, and the shader was already written as a loop to MAX_CASCADES
// with no unrolled special case. Measured cost of the fourth pass: see _fitCascades.
const MAX_CASCADES = 4;

// --- cascade splits -------------------------------------------------------------------------
// The classic practical split (Zhang et al.) interpolates a logarithmic series with a uniform
// one, and its logarithmic half is anchored at the camera NEAR plane. That anchor is what breaks
// here: main.js drives the near plane from measured clearance and it sits at 0.30-1.60 m, so the
// log series starts at a distance nothing is ever drawn at, and the uniform half — which is a
// terrible split — ends up carrying the result. Fitting from a STREET anchor instead is the
// standard remedy and it is what these numbers are:
//
//   cascade 0 ends at CSM_SPLIT0 metres — an ABSOLUTE distance, not a fraction of the reach;
//   every split after it is GEOMETRIC from there to the reach, which is the series that minimises
//   the worst ratio, i.e. the softest texel-to-pixel figure anywhere in the frame.
//
// ABSOLUTE, and this is the correction the expansion forced. Because every cascade is fitted to
// the bounding sphere of its own slice, its texel-to-pixel ratio at the slice's FAR edge is a
// constant — 0.910 at 1440x900, fov 1.05, 2048 tiles — whatever the split. So the split does not
// buy sharpness at the far edge of the cascade; it buys it in ABSOLUTE METRES near the camera,
// which is where a pedestrian actually looks. A fraction of the reach makes that number a
// function of the time of day, because DAY_SHADOW_DISTANCE buys daylight a longer reach.
//
// The three rules, cascade far distance / world metres per texel, worst ratio between splits:
//
//   3 cascades, practical split lambda 0.76 (what the pre-expansion build shipped)
//     blue, reach 1250   108/0.127   288/0.320   1250/1.414                        4.34
//     day,  reach 2375   200/0.235   515/0.571   2375/2.692                        4.61
//   4 cascades, first split at 5.5% of the reach
//     blue, reach 2200   121/0.142   318/0.353    837/0.928   2200/2.441           2.63
//     day,  reach 2860   157/0.184   414/0.459   1088/1.207   2860/3.173           2.63
//   4 cascades, first split pinned at 110 m — THIS
//     blue, reach 2200   110/0.129   299/0.332    810/0.900   2200/2.444           2.71
//     day,  reach 2860   110/0.129   326/0.363    965/1.077   2860/3.189           2.96
//
// Read the near column: the fraction rule made the shadow under a parked car 30% coarser at three
// in the afternoon than at dusk, for no reason a player could name, and the shipped three-cascade
// rule made it 85% coarser. Pinning the anchor holds 0.129 m per texel at every preset and every
// reach — better than all four of those — and pays 2.71 -> 2.96 for it in the worst ratio, which
// is the texel-per-pixel figure at the near edge of the softest cascade and is nowhere anyone is
// looking. (The numbers above are the fit itself, read back from renderer.shadowStats.)
//
// 110 m is a Toronto block face — King to Adelaide is 110 m, Adelaide to Richmond 112. Below it
// cascade 1 starts across the street you are standing on; above it cascade 0's texels start to
// show at arm's length. The bracket exists only so a pathological `distance` cannot order the
// first split past the last one.
const CSM_SPLIT0 = 110;
const CSM_SPLIT_MIN = 40;
const CSM_SPLIT_MAX = 260;

// --- daylight -------------------------------------------------------------------------------
// `env.daylight` (0 = blue hour / night, 1 = full sun) is the single switch between the two
// lighting models. Everything keyed off it below is written so that at 0 it multiplies by exactly
// 1.0 or mixes with exactly 0.0, which is what makes the blue-hour image bit-for-bit unchanged.
//
// Shadow strength: 0.74 is a blue-hour figure, where the "shadow" is one part of the sky being
// occluded by another and a hard black would be wrong. Under a real sun an occluded surface loses
// the sun ENTIRELY and keeps only the sky fill, so the direct term has to go to nearly nothing —
// this is what turns a 1-luma difference into the measured 3-5x sun/shade ratio.
const DAY_SHADOW_STRENGTH = 1.0;
// Bloom in daylight. The threshold is in linear scene light, and daylight raises the whole frame:
// left at the blue-hour value the sky and every pale facade would cross it and the bloom would
// become a wash over the entire image instead of a glow around the few things that are actually
// blinding (the disc, the aureole, glints off glass and water).
const DAY_BLOOM_THRESHOLD = 2.6;
const DAY_BLOOM_INTENSITY = 0.55;
// The anamorphic streak is a low-light lens signature. Against a bright sky it stops reading as
// a flare and starts reading as a smear across the image, so daylight nearly closes it.
const DAY_STREAK_INTENSITY = 0.22;
// Cascade reach, as a multiple of shadow.distance. The blue-hour key is a low raking skylight and
// a street-level walk needs far less of it than a skyline shot does, so daylight buys extra reach
// and blue hour keeps a shorter, denser set. Exactly 1x at daylight 0.
//
// The base is now 2,200 m (was 1,250) and the multiplier 1.30 (was 1.9), i.e. 2,860 m of daylight
// reach against 2,375. Two things forced it. The extract is 6.8 x 6.5 km, so the Financial
// District now stands 2.0-2.7 km off the start viewpoint rather than 1.2-1.9, and at the old
// reach the whole core sat past uShadowFar and faded to unshadowed. And main.js sizes its caster
// query as shadow.distance + 1.5 tiles, so the reach and the caster radius have to move together
// or the far cascade covers ground no caster was submitted for.
//
// MEASURED at the start viewpoint, 1440x900, Ultra, four cascades: 1,250 m -> 11.2 ms / 165
// shadow draws; 1,900 -> 11.7 / 249; 2,600 -> 12.4 / 315; 3,400 -> 12.9 / 411. The cost is in
// the caster count, not the cascade count, and it is close to linear at 5.7 us per draw. 2,200
// buys the core for about 0.7 ms of a 16.7 ms budget.
const DAY_SHADOW_DISTANCE = 1.30;
// Fog density, as a multiple of the preset's own. Blue hour WANTS the street grid sunk in haze
// (CONTRACT 3.2 item 7). A clear afternoon does not: at the preset density the aerial term is
// brighter than most facades, so it lifts every distant tower toward a milky grey and takes the
// facade colour with it. Thin it and the skyline stays legible all the way to Yonge.
// Thinned again (0.40 -> 0.24) against the "pale" report: from the harbour the Financial District
// stands 1.2-1.9 km off and the aerial term was still eating a third of its chroma there. What is
// left is enough to read as distance and no longer enough to read as weather.
const DAY_FOG_DENSITY = 0.24;
// Daylight exposure trim, on top of whatever the preset's own `exposure` asks for. The scene is
// physically linear once vhDayAlbedo hands the shading a real reflectance and the sun a real
// irradiance, so SOMETHING has to say how much of it reaches the sensor; this is that number, and
// it is the only knob in the daylight path that moves the sky as well as the city. Exactly 1 at
// daylight 0 — and vhDayTone, the only consumer, is skipped entirely there anyway.
//
// It moved from 1.10 to 5.12 with the daylight tone curve, and the jump is a change of UNITS, not
// of brightness: vhDayTone now applies a shoulder in scene light, and a shoulder has to be told
// where the scene sits relative to it. Exposure is that statement. The two were fitted together
// against a target transfer and the measured street frame comes back within a luma of where it
// was; what changed is how the range above a shaded wall is distributed, not how bright it is.
const DAY_EXPOSURE = 5.12;

// --- local lights: a world-space CLUSTERED forward rig -----------------------------------------
// Why clustered-in-WORLD-SPACE rather than tiled-in-SCREEN-SPACE, which is the usual answer.
//
// A tiled (Forward+) rig bins lights into screen tiles every frame, which means projecting every
// light's bounding sphere, depth-partitioning the tile, and writing a fresh per-tile list — work
// that is proportional to the light count AND has to be redone whenever the camera so much as
// turns. WebGL2 has no compute shaders and no SSBOs, so all of that lands on the CPU and then has
// to be uploaded as a texture anyway.
//
// This city's lights do not move. Ever. They are street lamps bolted to masts, and they are
// distributed as a two-dimensional field: every one of them sits within a couple of metres of
// street level, and its useful reach is a squat cylinder about 30 m across. That makes a plain
// UNIFORM GRID OVER WORLD XZ the natural cluster structure — no depth slices, no frustum maths,
// no projection, and a fragment finds its cluster with two subtractions and a floor. The camera
// only decides WHICH WINDOW of that grid is resident.
//
// So the per-frame CPU work is: pull the lights inside an 896 m window out of a static broadphase
// grid, rank them, stamp each one into the handful of 28 m cells its disc covers, and upload two
// small textures (16 KB of light parameters, 32 KB of cell lists). The per-FRAGMENT work is
// bounded by LIGHT_SLOTS and by nothing else — not by how many lamps the city has, which is the
// entire point and what makes this scale from the 1,403 surveyed lamp positions in the current
// extract to the ~130,000 the full city implies.
//
// A fragment outside the window pays ONE compare. A fragment inside an empty cell pays one
// texelFetch that returns 0 and breaks. That is what pays for the window being big enough to hold
// the pools receding down a street, which is most of what a night street looks like.
//
//   LIGHT_MAX     lights uploaded per frame. Reported as renderer.lightStats.uploaded.
//   LIGHT_GRID_N  cells per side of the window
//   LIGHT_CELL    metres per cell; N x CELL is the window edge (32 x 28 = 896 m)
//   LIGHT_SLOTS   light indices per cell — the HARD per-fragment loop bound
//   LIGHT_CAND    candidates the gather will look at before it gives up ranking them
const LIGHT_MAX = 512;
const LIGHT_GRID_N = 32;
const LIGHT_CELL = 28;
const LIGHT_SLOTS = 16;
const LIGHT_CAND = 4096;
// Broadphase cell for the STATIC index built once by setLights(). Bigger than the cluster cell
// because it is only ever queried with a window-sized box.
const LIGHT_BROAD_CELL = 96;
// The largest influence radius any registered light may claim. It bounds how far outside the
// window the gather has to reach so a lamp just past the edge still lights the ground inside it.
const LIGHT_RADIUS_MAX = 64;

// The luminaire types a caller may name. `power` is scene-linear radiance at one metre — the same
// units the rest of this renderer works in, fitted (see the Renderer's `lights` block) so a cobra
// head at 9.5 m lays a pool on 3% asphalt that reads at roughly 60 luma against a 6 luma street
// between the masts. The 'cone' field is the luminaire distribution: 1 = full cutoff (nothing above
// the horizontal), 0 = a bare globe. NONE of this encodes a time of day — CONTRACT Amendment 7;
// `env.nightFactor` and `env.daylight` alone decide when the rig is on.
const LIGHT_KINDS = [
  // 0 cobra: high-pressure sodium on an arterial mast. Toronto's legacy default and still most
  //   of the network — this is the colour that makes a Toronto night photograph orange.
  { key: 'cobra', color: [1.000, 0.600, 0.220], power: 420, radius: 32, cone: 0.92 },
  // 1 led: the 4000 K replacement head going in across the city. Cooler, tighter, brighter.
  { key: 'led', color: [0.870, 0.930, 1.000], power: 460, radius: 32, cone: 0.95 },
  // 2 acorn: heritage globe (Distillery, St Lawrence, Queens Quay). Non-cutoff, so it glows.
  { key: 'acorn', color: [1.000, 0.760, 0.430], power: 145, radius: 20, cone: 0.15 },
  // 3 ped: pedestrian-scale post top on a sidewalk or a plaza.
  { key: 'ped', color: [1.000, 0.790, 0.480], power: 180, radius: 22, cone: 0.62 },
  // 4 shop: light thrown out of a lit ground-floor interior onto the pavement in front of it.
  { key: 'shop', color: [1.000, 0.870, 0.700], power: 100, radius: 14, cone: 0.30 },
  // 5 signal: a traffic or pedestrian head. Barely lights anything; it is here so a signalised
  //   intersection reads as one at night.
  { key: 'signal', color: [1.000, 0.560, 0.240], power: 36, radius: 10, cone: 0.35 },
  // 6 tunnel: batten luminaire under a soffit, teamway or underpass. Neutral and close in.
  { key: 'tunnel', color: [1.000, 0.940, 0.800], power: 130, radius: 16, cone: 0.55 },
];
const LIGHT_KIND_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < LIGHT_KINDS.length; i++) m[LIGHT_KINDS[i].key] = i;
  // A few aliases a caller is likely to reach for, so registering lamps never needs this table.
  m.sodium = 0; m.lamp = 0; m.street = 0; m.arterial = 0;
  m.white = 1; m.cool = 1;
  m.globe = 2; m.heritage = 2;
  m.pedestrian = 3; m.post = 3;
  m.shopfront = 4; m.interior = 4;
  m.traffic = 5;
  m.batten = 6; m.soffit = 6;
  return m;
})();

// Module-scope scratch — the hot paths must not allocate.
const _tint = new Float32Array(3);
const _sun = new Float32Array(3);
const _key = new Float32Array(3);
const _ray = new Float32Array(3);
const _tmpA = new Float32Array(3);
const _tmpB = new Float32Array(3);
const _tmpC = new Float32Array(3);
const _texel = new Float32Array(2);
const _texel2 = new Float32Array(2);
const _dir = new Float32Array(2);
const _fog = new Float32Array(4);
const _fogRange = new Float32Array(4);
const _csmMat = new Float32Array(MAX_CASCADES * 16);
const _csmTile = new Float32Array(MAX_CASCADES * 4);
const _csmParam = new Float32Array(MAX_CASCADES * 4);
const _shadowTexel = new Float32Array(2);
const _shadowBias = new Float32Array(2);
const _zparam = new Float32Array(2);
const _ssrParam = new Float32Array(4);
const _aoParam = new Float32Array(4);
const _dayInd = new Float32Array(4);
const _cnTower = new Float32Array(4);
// Road surface response: x = wetness, y = dry roughness, z = wet roughness, w = anisotropy.
const _road = new Float32Array(4);
// Local-light cluster window: xy = its world XZ origin, z = 1 / cell size, w = master gain.
const _lightWin = new Float32Array(4);
// x = rig level (0 at midday, 1 at Night), y = 1 when the tables hold something worth sampling.
const _lightRig = new Float32Array(2);
// Text pass: xy = atlas size in texels, z = the SDF's texel range, w = cap height in texels.
const _glyphAtlas = new Float32Array(4);
// x = fade start (m), y = 1 / fade span, z = cap px below which a glyph is gone, w = cap px
// above which it is fully opaque.
const _textLod = new Float32Array(4);
const _lightEye = vec3();
const _lightTarget = vec3();
const _lightUp = vec3(0, 1, 0);
const _mLightView = mat4();
const _mLightProj = mat4();
const _mLightVP = mat4();
const _mTile = mat4();
const IDENTITY = mat4();

// Message text out of anything throwable, without ever throwing itself.
function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return (err.message ? err.message : String(err));
}

function numOr(v, lo, hi, dflt) {
  if (!Number.isFinite(v)) return dflt;
  return v < lo ? lo : (v > hi ? hi : v);
}

function boolOr(v, dflt) {
  if (v === true) return true;
  if (v === false) return false;
  return dflt;
}

function isArrayLike(v) {
  return v !== null && typeof v === 'object' && typeof v.length === 'number' && v.length >= 4;
}

/* --------------------------------------------------------------------- camera */

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

/* ---------------------------------------------------------------------- GLSL */

// Everything shared between stages: hashes, the octahedral normal packing used by the material
// buffer, the blue-hour sky model (the scene and water shaders reflect the SAME function the sky
// shader draws, so a glass tower reflects exactly the sky above it), height fog, the GGX lobe and
// the shared filmic grade.
const GLSL_COMMON = `
const float VH_PI = 3.141592653589793;

float vhLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float vhHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract((p + p) * p);
}
float vhHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vhHash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// --- octahedral normal packing: unit vec3 <-> [0,1]^2, ~1 degree at 8 bits -----------------
vec2 vhOctEncode(vec3 n) {
  n /= max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
  vec2 e = n.xz;
  if (n.y < 0.0) {
    vec2 s = vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
    e = (vec2(1.0) - abs(e.yx)) * s;
  }
  return e * 0.5 + 0.5;
}
vec3 vhOctDecode(vec2 f) {
  vec2 e = f * 2.0 - 1.0;
  vec3 n = vec3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
  float t = max(-n.y, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.z += n.z >= 0.0 ? -t : t;
  return normalize(n);
}

// --- blue-hour sky ------------------------------------------------------------------------
// zen  : deep indigo overhead        hor : cyan band at the horizon
// west : warm orange where the sun sank (its azimuth comes from sunDir, which points at a sun
//        BELOW the horizon — there is no disc, only the afterglow it left behind).
vec3 vhSkyGradient(vec3 dir, vec3 zen, vec3 hor, vec3 west, vec3 sunDir) {
  float up = clamp(dir.y, -1.0, 1.0);

  // Vertical ramp. The cyan band hugs the horizon and the indigo only takes over well up the
  // dome — a straight two-stop lerp reads as a gradient poster, not as air.
  float band = exp2(-1.442695 * max(up, 0.0) * 3.4);
  vec3 col = mix(zen, hor, band);

  // Below the horizon the dome sinks toward the dark ground/lake haze.
  col = mix(col, zen * 0.42 + hor * 0.10, clamp(-up * 3.2, 0.0, 1.0));

  // Azimuthal afterglow. Strongest toward the sun's compass bearing and only near the horizon.
  vec2 dh = dir.xz;
  vec2 sh = sunDir.xz;
  float dl = length(dh), sl = length(sh);
  float az = (dl > 1e-4 && sl > 1e-4) ? dot(dh / dl, sh / sl) : 0.0;
  float warmAz = pow(clamp(az * 0.5 + 0.5, 0.0, 1.0), 2.6);
  float warmEl = exp2(-1.442695 * max(up, 0.0) * 6.5) * smoothstep(-0.30, 0.05, up);
  col += west * warmAz * warmEl;

  // A thin airglow line all the way round: this is what distant fogged geometry blends into.
  col += hor * 0.30 * exp2(-1.442695 * abs(up) * 26.0);
  return max(col, vec3(0.0));
}

// --- height fog + aerial perspective ---------------------------------------------------------
// THREE terms, because one cannot do all three jobs over a 6.8 x 6.5 km map that a player can
// also see 18 km across.
//
// TERM 1, the haze deck. An analytic integral of an exponential density field along the view
// ray, so the street grid sits in haze while the towers rise clear of it (CONTRACT §3.2 item 7).
// p.x = density, p.y = scale height, p.z = base Y, p.w = maximum opacity.
//
// The deck's scale height is 48-120 m across the four presets, which is the point — it is a
// ground-hugging haze, not an atmosphere. Two consequences follow, and both of them are what
// the expanded extract exposed. It cannot fog a TOWER: from the 300 m start viewpoint the whole
// afternoon deck contributes 1.9% of airlight to a roof 2 km away and 4.8% to one at 5 km, so the
// Financial District and the north edge of the extract came back at very nearly the same contrast
// and the city read as a flat sheet of confetti rather than as depth. And it cannot close a
// HORIZON: the deck's entire vertical optical depth is density x H = 0.00749, so the far plane,
// the rim of the water sheet and the last tile the streamer built are all fully legible from any
// altitude. On a 3 km map you never got far enough from anything for either to show. On this one
// you do.
//
// TERM 2, aerial perspective — 'beta', extinction per metre of sightline, altitude-independent.
// This is the term that makes distance READ as distance, and it is the one the expansion needed.
// It is passed in already multiplied by daylight, and that is a physical statement rather than a
// convenience: airlight is SUNLIGHT scattered into the line of sight, so at 15:20 a facade 5 km
// away is half sky-colour and at 23:30 the same facade's lit windows come through nearly intact.
// Anyone who has looked at a city at night from across a lake has seen exactly that. It is also
// what makes "blue hour has not drifted" provable rather than merely intended: beta is
// multiplied by env.daylight on the JS side and by nothing else, and env.daylight is
// exactly 0 at both Blue hour and Night, so THIS TERM cannot move either of them by one bit.
// (The q window below did move them, by a measured fraction of a code value — see the fogRange
// block in the renderer's env defaults for the numbers.)
//
//   beta = 3.912 / V, where V is the Koschmieder visual range. env.fogVisualRange defaults to
//   40 km — a clear, dry Toronto summer afternoon — giving 9.78e-5 per metre.
//
// TERM 3, the horizon closer, quadratic in the excess range beyond q.x. Nothing physical: it is
// the term that guarantees no edge of the drawn world is ever visible, at ANY time of day, which
// is CONTRACT §9.4. Quadratic so that it is small where the city is and unavoidable where it is
// not; NOT daylight-scaled, because a horizon has to shut at night too.
//
//   q.x = 3,000 m  range at which it starts     q.y = 1 / 5,200 m  (one unit of depth per span)
//   q.z, q.w       the window over which the cap is allowed to open from p.w to fully opaque
//
// TOTAL AIRLIGHT, all three terms and the cap, evaluated for a ray from the 300 m start viewpoint
// to a roof at 100 m — which is the shot this build is judged on:
//
//     km        0.5    1     2     3     4     5     6     8    10    12    14    16
//     Afternoon 3.9   7.6  14.4  20.5  27.9  37.9  49.4  72.0  88.9  97.9  99.8  100.0  %
//     Golden    4.3   8.4  16.0  22.8  31.2  42.4  54.6  76.8  91.3  98.2  99.7  100.0  %
//     Blue      2.4   4.7   9.2  13.4  20.3  31.5  45.1  71.5  89.1  97.1  99.4   99.9  %
//     Night     2.0   4.1   7.9  11.7  18.2  29.4  43.3  70.5  88.6  96.9  99.4   99.9  %
//
// So the Financial District at 2.0-2.7 km keeps 82% of its own contrast and its colour, the north
// edge of the extract at 6 km is halfway to the sky and unmistakably far, and the far plane
// cannot be seen from anywhere. Blue hour and Night sit BELOW the daylight curve past 3 km, which
// is the aerial-perspective term doing exactly what it should: after sunset there is no sunlight
// to scatter into the ray, and a lit window five kilometres away comes through.
//
// At street level, where a 1.7 m eye looks along a 90 m facade, the same three terms give
// Afternoon 1.8% at 200 m, 4.5% at 500 m and 12.7% at 1.5 km — the aerial term is a whisper down
// a street and the deck is what carries the haze, which is the division of labour intended.
//
// p.w (fogMax) is a MID-DISTANCE cap: it exists so a skyline 2 km off keeps some of itself and
// does not flatten into the fog colour. Applied at 16 km it is the opposite of useful — it would
// hold the far plane's cut at 28% of full contrast forever. So the cap opens over q.z..q.w and
// the air is allowed to close completely once there is nothing left out there worth seeing.
float vhFogAmount(vec3 camPos, vec3 world, vec4 p, vec4 q, float beta) {
  vec3 d = world - camPos;
  float len = length(d);
  if (len < 1e-4) return 0.0;
  float H = max(p.y, 1.0);
  // Both endpoints are evaluated independently and their exponents are CLAMPED. Folding them
  // into one exponential (the tidy algebraic form) overflows float32 from a helicopter-height
  // camera — exp(+6000/55) is inf, the paired term underflows to 0, and inf * 0 is NaN, which
  // would silently paint the whole city with fog colour.
  float ec = exp2(-1.442695 * clamp((camPos.y - p.z) / H, -8.0, 40.0));
  float ew = exp2(-1.442695 * clamp((world.y - p.z) / H, -8.0, 40.0));
  float dy = d.y;
  float f;
  if (abs(dy) > 1e-3) f = max(p.x, 0.0) * H * (ec - ew) * (len / dy);
  else f = max(p.x, 0.0) * ec * len;
  // Aerial perspective, then the horizon closer. The closer is exactly zero inside q.x, so no
  // sightline shorter than that can be moved by it at any time of day.
  float s = max(len - q.x, 0.0) * max(q.y, 0.0);
  f = clamp(f + max(beta, 0.0) * len + s * s, 0.0, 60.0);
  // The mid-distance cap opens toward fully opaque over q.z..q.w. smoothstep guards itself
  // against q.z >= q.w, so a caller cannot invert the window into a divide by zero.
  float cap = mix(clamp(p.w, 0.0, 1.0), 1.0, smoothstep(q.z, max(q.w, q.z + 1.0), len));
  return clamp(1.0 - exp2(-1.442695 * f), 0.0, 1.0) * cap;
}

// --- GGX ------------------------------------------------------------------------------------
float vhD_GGX(float ndh, float a) {
  float a2 = a * a;
  float f = (ndh * a2 - ndh) * ndh + 1.0;
  return a2 / max(VH_PI * f * f, 1e-7);
}
// Height-correlated Smith visibility: already carries the 1 / (4 ndl ndv) denominator.
float vhV_Smith(float ndv, float ndl, float a) {
  float a2 = a * a;
  float lv = ndl * sqrt(max(ndv * ndv * (1.0 - a2) + a2, 1e-7));
  float ll = ndv * sqrt(max(ndl * ndl * (1.0 - a2) + a2, 1e-7));
  return 0.5 / max(lv + ll, 1e-5);
}
vec3 vhF_Schlick(vec3 f0, float u) {
  float m = clamp(1.0 - u, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (vec3(1.0) - f0) * (m2 * m2 * m);
}
// Karis' analytic split-sum approximation: x scales F0, y is the additive bias.
vec2 vhEnvBRDF(float ndv, float rough) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

// --- environment specular weight ------------------------------------------------------------
// How much of the environment a surface hands back to the eye. This is the FRESNEL term, and it
// is the single reason a glass tower reads as a real building at blue hour: face-on a curtain
// wall shows its tint (weight ~0.04, so 96% of what you see is the glass colour and the room
// behind it), while at a grazing angle it becomes a near-perfect MIRROR of the sky (weight ~0.8).
//
// It depends ONLY on (ndv, rough), both of which the material G-buffer carries, which is what
// lets the SSR resolve pass subtract exactly the analytic sky the scene shader added and put the
// traced reflection in its place. Any change here must stay a pure function of those two.
vec3 vhEnvSpecWeight(float ndv, float rough) {
  vec2 ab = vhEnvBRDF(ndv, rough);
  const vec3 F0 = vec3(0.04);                       // every dielectric in this city
  // The split-sum fit flattens out below ~0.05 roughness; polished glass keeps climbing. Give
  // mirror-smooth dielectrics the missing tail so the grazing edge of a tower really silvers.
  float polish = 1.0 - smoothstep(0.045, 0.30, rough);
  float g = 1.0 - ndv;
  float tail = polish * (g * g) * (g * g) * g * 0.24;
  return clamp(F0 * ab.x + vec3(ab.y + tail), vec3(0.0), vec3(1.0));
}

// --- sky irradiance -------------------------------------------------------------------------
// At blue hour a facade is lit by the SKY, and that is what reveals its colour: gold reads gold,
// Mies black reads black, red granite reads red. A single flat ambient constant cannot do that —
// it lights every face of every building identically and the image goes flat.
//
// So take TWO taps of the very gradient the sky pass draws:
//   dome : the normal pulled toward the zenith, which is most of what a wall actually sees
//   band : the same bearing pushed down to the horizon, where the cyan band and the western
//          afterglow live — this is what makes a west-facing facade warmer than a north one
// and fold in the ground bounce for anything facing down. Directional, so it separates faces
// instead of flattening them.
vec3 vhSkyIrradiance(vec3 N, vec3 zen, vec3 hor, vec3 west, vec3 sunDir, vec3 gnd) {
  // N is unit length, so N + (0, 1.15, 0) is never shorter than 0.15 and normalize is safe.
  vec3 dome = normalize(N + vec3(0.0, 1.15, 0.0));
  vec2 nh = N.xz;
  float fl = length(nh);
  vec3 band = fl > 1e-4 ? vec3(nh.x / fl, 0.085, nh.y / fl) : vec3(0.0, 1.0, 0.0);
  vec3 a = vhSkyGradient(dome, zen, hor, west, sunDir);
  vec3 b = vhSkyGradient(normalize(band), zen, hor, west, sunDir);
  // An upward face is nearly all dome; a vertical wall still takes a quarter of its light off
  // the bright horizon band. The cosine-weighted integral over a hemisphere is close to this.
  float upFace = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(b, a, 0.60 + 0.40 * upFace);
  // Below the equator the surface sees wet asphalt and the harbour instead of sky: DIMMER, and
  // COOLER, because the street is bouncing back the indigo dome without the warm horizon band a
  // wall catches. This is what puts a cold cast under every soffit, canopy and bridge deck.
  vec3 below = gnd * vec3(0.82, 0.95, 1.18);
  return mix(sky, below, clamp(-N.y, 0.0, 1.0) * 0.86);
}

// --- local grade ----------------------------------------------------------------------------
// Downtown Toronto rises about 30 m from the lake up to Queen St, so "height above the street"
// is NOT world Y: at King & Bay grade sits near 16 m, at the ferry docks near 2 m. The shopfront
// band, the parking decks, the street-lamp spill and the contact darkening all need the local
// figure, and there is no terrain sampler in the fragment stage.
//
// This is a least-squares cubic fitted (offline, against data/toronto.json) to the base elevation
// of all 4,818 building records. Residual against the retail stock that actually uses it:
// 0.73 m RMS, 1.10 m at p90, 2.51 m at p99 — comfortably inside the metre-scale soft edges every
// consumer below applies. x and z are in KILOMETRES to keep the cubic terms well conditioned.
float vhGroundApprox(vec2 xz) {
  float x = xz.x * 0.001;
  float z = xz.y * 0.001;
  float g = 8.31393 + z * (-7.83471 + z * (1.32740 + z * -0.29971));
  g += x * (-4.36553 + z * (2.26119 + z * 0.39096));
  g += x * x * (-0.36846 + z * -0.85491);
  g += x * x * x * 0.00940;
  return clamp(g, 0.0, 32.0);
}

// --- interior light palette ------------------------------------------------------------------
// The old grid emitted ONE narrow amber across the entire city, which is exactly why the skyline
// read as procedural wallpaper rather than as Toronto. Real interiors run from 2000 K tungsten
// through halogen and neutral white to 4200 K office fluorescent, with the occasional cold LED.
// This walks that whole line; every profile below biases WHERE on it its windows sit, and that
// bias is most of what tells a condo apart from an office tower at a glance.
vec3 vhLampTint(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(1.000, 0.545, 0.225);                                    // 2000 K tungsten
  c = mix(c, vec3(1.000, 0.730, 0.425), smoothstep(0.00, 0.26, t));      // 2700 K soft warm
  c = mix(c, vec3(1.000, 0.895, 0.735), smoothstep(0.24, 0.52, t));      // 3200 K halogen
  c = mix(c, vec3(0.980, 0.985, 0.960), smoothstep(0.50, 0.72, t));      // neutral white
  c = mix(c, vec3(0.790, 0.930, 1.000), smoothstep(0.70, 0.88, t));      // 4200 K fluorescent
  c = mix(c, vec3(0.545, 0.735, 1.000), smoothstep(0.88, 1.00, t));      // cold LED / blue-white
  return c;
}

// --- the daylight model, in one place ---------------------------------------------------------
// Every constant below is multiplied by uDaylight (0 = blue hour / night, 1 = full sun) at the
// point of use, so at 0 each one is an EXACT no-op and the blue-hour image is unchanged bit for
// bit. They live in GLSL_COMMON rather than in one fragment shader because the scene pass and the
// water pass have to agree on them to the last digit — the city and the harbour in front of it
// are lit by the same sun and fog into the same air.

// Directional sky irradiance, in daylight. At blue hour the sky IS the key light and uSkyBounce
// carries the whole image. Under a sun the roles swap: the disc is the key and the dome is fill.
const float VH_DAY_SKY_FILL = 0.55;

// Direct sun gain, in daylight. uKeyColor is authored at DUSK scale — a luminance near 0.93,
// which is the right number for a key that has to sit beside a blue-hour sky. A real 3 p.m. sun
// is several times the whole sky dome put together: measured against this build's own sky pass,
// the afternoon horizon sits at 0.14 linear, and a mid-grey wall facing it flat used to come back
// at 0.05 — a third of the sky it is standing in front of, when it should be about equal to it.
// That single mis-balance is what made the massing read flat: with the sun that weak, an occluded
// surface loses almost nothing, so neither the cascades nor the facade orientation could show.
// Together with DAY_EXPOSURE this is a two-number fit, and both numbers were measured, not
// guessed: from the harbour vantage at 15:20 they put the sunlit tower band at 146 luma against a
// 146 sky, the sunlit harbourfront at 187, and the sun/shade ratio across thirteen surveyed
// downtown towers at a mean of 3.43 and a median of 3.45 (range 1.5 for a mirror-glass condo
// whose shaded face is all sky reflection, to 4.9 for cast concrete). Nothing hard-clips.
const float VH_DAY_SUN_GAIN = 3.0;

// Ground-cover reflectance, in daylight. city.js authors its ground table (terrain, asphalt,
// sidewalk, grass, pier — its M{} block) on a MUCH darker scale than its facades: the facade
// colours pass through nightAlbedo(), a known bake vhDayAlbedo() below can invert exactly, while
// the ground values are hand-picked blue-hour numbers with nothing behind them to invert. Run
// through the facade inverse they collapse onto the 0.03 floor — 3% reflectance for a concrete
// sidewalk, which is darker than fresh asphalt — and that is precisely why the street reads as
// mud under a noon sun while the towers above it read correctly.
//
// The ground is also the surface that catches the MOST sun (cos 48 deg overhead, against 0.38 on
// a south wall), so under-reading it is the loudest single error in the daylight image. Nothing
// in the vertex format says "this is ground", so this keys off what actually separates ground
// cover from cladding in the real world: it faces the sky, and it is at street level. Against
// published reflectances the result lands asphalt 0.030 -> 0.096 (real 0.09), sidewalk 0.082 ->
// 0.26 (0.30), grass 0.048 -> 0.15 (0.20), terrain 0.052 -> 0.17 (0.15), pier 0.053 -> 0.17.
//
// The height window is set by what has to stay CONSISTENT with the street: city.js's roof caps
// are M.roof plus a tenth of the facade colour, so they are ground-scale too and want the same
// lift, and the Gardiner deck sits 8.2 m up carrying the same asphalt as the road beneath it —
// step the lift off before that and the expressway reads as a dark ribbon over a bright street.
// The fade is done by 22 m, which is below every envelope shell in the dataset whose curved,
// sky-facing cladding is authored on the FACADE scale and must not be touched (Roy Thomson Hall
// at ~30 m is the lowest; the Rogers Centre dome crowns at 86 m).
const float VH_DAY_GROUND_GAIN = 3.2;
const float VH_DAY_GROUND_LOW = 9.0;      // metres above street: full lift at or below this
const float VH_DAY_GROUND_TOP = 22.0;     // metres above street where the lift has faded out

// --- daylight INDIRECT light: uDayIndirect (x = wall, y = street, z = skyView, w = warmth) -----
// The single reason a street canyon used to read as deep dusk at 15:20 while the same preset
// looked right from the harbour. Two errors, both of them specific to being DOWN IN the city.
//
// 1. NO BOUNCE TERM AT ALL. Between two 290 m towers on a 20 m street the sun is geometrically
//    gone: First Canadian Place throws 261 m of shadow to the north-east at 48 degrees of
//    elevation, so every surface below roughly 150 m on both sides of Bay St is genuinely
//    unlit — the cascades are right about that. What fills a real street in that situation is
//    not the sky, it is SUNLIGHT OFF THE FACADE OPPOSITE. Measured at Bay & King, 99% of the
//    roadway pixel's light was ambient and the model's only ambient was a sky the canyon can
//    barely see: the road came back at 29 luma, which is night.
//
//    So: E_bounce = E_sun * coeff * shadeWeight * warmth, where
//      - E_sun is uKeyColor * VH_DAY_SUN_GAIN, i.e. the sun's own irradiance in scene units, so
//        the bounce tracks the time of day for free and vanishes with it;
//      - coeff is uDayIndirect.x for a VERTICAL surface and uDayIndirect.y for a SKY-FACING one,
//        interpolated by N.y. Two independent numbers rather than one and a view-factor
//        multiplier, because a view factor is not what separates them. Single-bounce geometry
//        actually makes them similar: for a 20 m street between 290 m towers a roadway point
//        sees the sunlit wall with a cosine-weighted view factor of 0.48 and a point on the
//        shaded wall opposite sees it with 0.50. What separates them is the OUTPUT curve. A
//        sunlit facade sits on the filmic shoulder at ~207 no matter what feeds it, so the
//        shaded end has to be PLACED to land the 2-3x contrast this build is judged on, and the
//        roadway — 4.6x darker in albedo than the limestone above it — has to be lifted further
//        to stay legible underneath. These two are measured, not derived. See the numbers below.
//      - shadeWeight is (1 - ndl*shadow)^2. The bounce is very nearly isotropic, but the two
//        ends of the range are not symmetric: a surface square to the sun is also square to the
//        open sky and has the LEAST built environment in its hemisphere, while a surface deep in
//        shade is there precisely because it is surrounded by lit building. The square is that
//        correlation, and it is what keeps the sunlit harbourfront (which needs nothing) from
//        moving while the shaded canyon (which needs everything) lifts.
//      - warmth (uDayIndirect.w) leans the bounce toward VH_DAY_BOUNCE_TINT, the mean reflectance
//        spectrum of the stock doing the bouncing — limestone, buff and red brick, granite,
//        bronze glass. This is why a real street in shade at midday photographs warm-neutral and
//        not blue: the fill is not skylight, it is sunlight that has already been filtered by
//        masonry. The tint is renormalised to unit luminance in the shader, so warmth moves
//        colour only and never brightness.
//
// 2. SKY VIEW. vhSkyIrradiance samples the dome ALONG THE NORMAL, which is exactly right at blue
//    hour — it is what makes a west-facing facade catch the afterglow and carries all 33 surveyed
//    facade colours — but it is not a cosine-weighted irradiance integral. Under this sky profile
//    it hands a vertical wall MORE light (0.139) than the road at its foot (0.095), when the road
//    sees twice the sky. uDayIndirect.z restores that ratio, in daylight only.
//
// Every one of them is gated on uDaylight and is exactly 0 (or exactly 1) at daylight 0.
//
// Measured at Bay & King (664, -518), eye 1.7 m, bearing 342.5 deg, 1440x900, 15:20 preset,
// before -> after: roadway 28.7 -> 84.0 luma, shaded facade 54.9 -> 90.3, sunlit facade
// 207.4 -> 210.5, so the sun/shade ratio goes 3.78x -> 2.33x; blue bias (B - R) on the roadway
// +22.7 -> +10.0 and across all facade pixels +24.6 -> -2.9; whole frame 49.7 -> 92.6 at +24.5
// -> +3.5. From the harbour the same change moves the frame mean 153.2 -> 155.9 and the sky not
// at one part in a thousand, which is what makes it safe to apply globally: shaded facade is
// 1.6% of that frame and 49% of this one. Blue hour and night are unchanged to the last digit
// in all fourteen measured quantities at both vantages, because uDaylight is 0 at both.
const vec3 VH_DAY_BOUNCE_TINT = vec3(1.22, 1.00, 0.74);

// Aerial perspective, in daylight. Blue hour's haze is indigo because the only light in the air
// IS the dome; with a sun up there the air is lit from the side and warms up, so some of that
// indigo has to come out or a tower 2 km away dissolves into the dusk sky behind it.
//
// It was at 0.62 — nearly all the way to grey — and that turned out to be most of the "pale".
// Real daytime in-scatter is Rayleigh: it is BLUE, that is why distant hills are blue, and
// flattening it to its own luminance replaces a coloured veil with a milky one. Every distant
// facade then loses chroma toward neutral instead of toward the sky, which is the difference
// between depth and haze. At 0.28 the air keeps its colour, the mid-distance keeps its
// separation, and the frame gets its chroma back for nothing.
const float VH_DAY_HAZE_NEUTRAL = 0.28;

// HORIZON WELD weight, from the sightline length and the same q.z..q.w window the fog cap opens
// over. One ramp, one statement: beyond q.z the air is allowed to close completely, and what it
// closes TO is the sky. Deliberately the same window rather than a second one, because two
// independent ramps over the same pixels is precisely how you get a band.
float vhAerialWeld(float len, vec4 q) {
  return smoothstep(q.z, max(q.w, q.z + 1.0), len);
}

// The daylight aerial-perspective colour. Shared by the scene and water passes so the harbour and
// the shoreline behind it fog into exactly the same air.
//
// The last argument is the HORIZON WELD weight from vhAerialWeld above, and it exists for ONE
// reason. city.js draws the lake as a flat sheet out to z = +10,428, and from the 2,400 m ceiling
// that sheet's far edge is 19 km away and BELOW the true horizon, so it is drawn against sky
// rather than against more water. At full opacity the sheet takes the aerial colour and the sky
// above it takes the sky gradient, and those are two different colours — measured 48/765 of the
// RGB range apart across ten scanlines, which is a visible seam and is exactly the "world
// visibly ends" CONTRACT §9.4 forbids.
//
// The physics says what to do about it: airlight is sky radiance scattered into the ray, so at
// infinite optical depth the haze IS the sky and the artistic uFogColor has to give way. So the
// aerial colour converges, over the whole q.z..q.w window, to what the SKY SHADER would have
// drawn in that direction — its gradient, pulled toward uFogColor by the same horizon-haze term
// SKY_FS applies (0.22 at the horizon, decaying at exp2(-15|up|)). Ten kilometres of ramp is
// what makes it a gradient instead of a band: a convergence keyed on OPACITY instead compresses
// the whole transition into the last 3% of it, which over open water lands as eighteen visible
// scanlines — measured, and tried, before this.
//
// MEASURED at the far corner of the water sheet, over the 120 px column that straddles the sheet
// edge: the largest step between two adjacent scanlines falls from 15.6/765 to 10.6/765 and the
// largest step over any six from 49.8/765 to 18.9/765, and the row profile stops reversing — it
// descends monotonically from the sky into the water with no band anywhere. See the sibling note
// on the horizon-closer window for what this and the window together cost the other presets.
vec3 vhAerial(vec3 fogColor, vec3 viewDir, vec3 zen, vec3 hor, vec3 west, vec3 sunDir,
              vec3 keyColor, float day, float weld) {
  vec3 sky = vhSkyGradient(viewDir, zen, hor, west, sunDir);
  vec3 aerial = mix(fogColor, sky, 0.55);
  float d = clamp(day, 0.0, 1.0);
  aerial = mix(aerial, mix(aerial, vec3(vhLum(aerial)), VH_DAY_HAZE_NEUTRAL), d);
  float sunAz = clamp(dot(viewDir, sunDir), 0.0, 1.0);
  float sunAz2 = sunAz * sunAz;
  aerial += keyColor * ((0.020 + 0.130 * sunAz2 * sunAz2 * sunAz) * d);
  vec3 skyHaze = mix(sky, fogColor, exp2(-1.442695 * abs(viewDir.y) * 15.0) * 0.22);
  return mix(aerial, skyHaze, clamp(weld, 0.0, 1.0));
}

// --- daylight albedo expansion ----------------------------------------------------------------
// city.js bakes a BLUE-HOUR scene albedo straight into the vertex colours (its nightAlbedo()):
// every material is compressed into a narrow band, its chroma is pulled toward neutral by a
// pedestal, and a slight cool cast is laid over whatever came out neutral. Pure white lands at
// 0.179 / 0.182 / 0.188 and pure black at 0.021. That is exactly right for a city lit only by the
// sky and hopelessly wrong for one lit by the sun: nothing at 18% reflectance can look sunlit, and
// the leftover cool cast is precisely the residual blue bias a grey facade shows with every light
// in the scene switched off.
//
// The bake is a known, invertible remap, so undo it in proportion to uDaylight. The single piece
// that cannot be recovered is the per-material 'level' factor (0.62 steel .. 0.94 marble) — the
// fragment stage has no material id — so this assumes a mid level. White lands at the 0.85 ceiling
// and black at the 0.03 floor, which brackets the whole useful range of real architectural
// reflectance anyway.
//
// The constants below MIRROR city.js: NIGHT_FLOOR, NIGHT_SPAN, NIGHT_GAMMA, CHROMA_PEDESTAL and
// COOL_R/G/B. If that bake ever changes, these have to change with it.
const float VH_NIGHT_FLOOR = 0.021;
const float VH_NIGHT_SPAN = 0.225;
const float VH_NIGHT_GAMMA_INV = 1.25;              // 1 / NIGHT_GAMMA (0.80)
const float VH_LEVEL_MID = 0.72;                    // the assumed per-material lightness level
const float VH_CHROMA_PEDESTAL = 0.10;
const vec3 VH_COOL = vec3(0.980, 0.996, 1.028);
const float VH_ALBEDO_MIN = 0.030;                  // soot-black brick still reflects this much
// Published architectural reflectances top out well below the old 0.85: white painted stucco
// 0.70-0.80, white marble 0.55-0.65, fresh white concrete 0.40, limestone 0.35-0.50. 0.85 is
// fresh snow. It is also the value every near-white facade in the dataset was landing on, which
// put them all on the same point of the tone curve's shoulder — the top of the "narrow bright
// band". Both readers are daylight-gated (vhDayAlbedo returns early at day 0, and the ground
// lift's own factor is 0 there), so blue hour and night cannot see the change; the ground table
// tops out at 0.26 reflectance and never reached the old ceiling either way.
const float VH_ALBEDO_MAX = 0.780;                  // white painted stucco, the brightest cladding
const float VH_DAY_CHROMA = 1.20;                   // hue-direction gain in daylight; 1.0 at dusk

vec3 vhDayAlbedo(vec3 baked, float day) {
  if (day <= 0.0) return baked;
  float Ln = max(vhLum(baked), 1e-4);
  // The hue, as a direction whose luminance-weighted mean is 1 by construction.
  vec3 cd = baked / Ln;
  // Undo the cool cast, which city.js applied in proportion to how NEUTRAL the colour ended up.
  // Judging that neutrality from cd rather than from the pre-cast direction is a 3% approximation
  // of a 3% effect, and it is what takes a grey facade's blue bias from +5% back to +0.4%.
  float spread = max(max(abs(cd.r - 1.0), abs(cd.g - 1.0)), abs(cd.b - 1.0));
  float neutral = clamp(1.0 - spread * 2.4, 0.0, 1.0);
  cd /= max(vec3(1.0) + (VH_COOL - vec3(1.0)) * neutral, vec3(1e-3));
  // Undo the chroma pedestal. The inverse preserves the weighted mean exactly, but the clamp on a
  // fully dead channel can move it, so renormalise afterwards.
  cd = max((cd - vec3(VH_CHROMA_PEDESTAL)) / (1.0 - VH_CHROMA_PEDESTAL), vec3(0.0));
  cd /= max(vhLum(cd), 1e-4);
  // Chroma, in daylight only. The pedestal inverse above is exact only at VH_LEVEL_MID, because
  // the fragment stage has no material id to read the real per-material level from; everything
  // lighter or darker than 0.72 comes back a few per cent flat. A few per cent of chroma is the
  // difference between Royal Bank Plaza reading gold and reading beige, and under a sun — where
  // the surface is lit by a broad white key rather than by a coloured sky — that is the ONLY
  // thing carrying a facade's identity. This scales the hue DIRECTION about neutral, and cd has
  // unit luminance by construction, so mixing about vec3(1.0) is luminance-exact: nothing gets
  // brighter, it only gets more like itself.
  cd = max(mix(vec3(1.0), cd, mix(1.0, VH_DAY_CHROMA, day)), vec3(0.0));
  cd /= max(vhLum(cd), 1e-4);
  // Band position -> perceptual lightness -> true linear reflectance.
  float t = clamp((Ln - VH_NIGHT_FLOOR) / VH_NIGHT_SPAN, 0.0, 1.0);
  float p = clamp(pow(max(t / VH_LEVEL_MID, 1e-5), VH_NIGHT_GAMMA_INV), 0.0, 1.0);
  float Ld = pow(max(p, 1e-5), 2.2);
  // The expansion must never make a surface DARKER than it was. Two 2.2-ish gammas compound into
  // a ^2.75 recovery, which is fine at the top of the band and brutally steep at the bottom:
  // everything under about 0.085 baked luminance came back below where it started and then hit
  // the floor together, so half the dark stock in the city — matte-black steel, bronze glass,
  // every one of city.js's directly authored ground and prop colours, none of which ever went
  // through the bake this inverts — arrived at a flat 3% reflectance. Clamping the recovery from
  // below keeps the curve monotone and leaves those materials at the value their author picked,
  // which for the dark end is already close to the real reflectance (matte steel 0.05, tinted
  // glass 0.07). The bright half, where the bake actually compressed something, is untouched.
  Ld = clamp(max(Ld, Ln), VH_ALBEDO_MIN, VH_ALBEDO_MAX);
  return mix(baked, cd * Ld, day);
}
`;

// Shared grade: a gentle filmic curve with a shoulder, a split tone, a small saturation push and
// a light gamma lift. Used by EVERY fragment shader so the horizon (sky / fog / water) matches
// exactly whichever path the frame took.
const GLSL_GRADE = `
vec3 vhFilmic(vec3 x) {
  // Modest exposure, then an exponential highlight shoulder: everything below K passes
  // through untouched and only genuine highlights roll off, asymptoting to 1.0. A classic
  // ACES-style curve would lift mid-grey ~2x here and turn the whole city into a pale wash,
  // because these vertex colours are authored display-referred, not linear HDR.
  //
  // The shoulder is applied to the PEAK CHANNEL and the colour ratio is preserved, rather than
  // rolling each channel off independently. Per-channel rolloff is what bleaches saturated
  // highlights to white: a lit window at (2.20, 1.94, 1.36) has all three channels pushed to
  // ~1.0 separately and arrives grey, so at night the whole city turned into white slabs and
  // lost the warm/cool variety the window palette is built on. Working on the peak keeps hue
  // and saturation intact all the way up. DO NOT REGRESS THIS (CONTRACT §3.2).
  const float K = 0.70;
  x = max(x, vec3(0.0)) * 1.30;
  float peak = max(max(x.r, x.g), x.b);
  if (peak <= 1e-5) return vec3(0.0);
  vec3 ratio = x / peak;
  float hi = max(peak - K, 0.0);
  float mapped = min(peak, K) + (1.0 - K) * (1.0 - exp(-hi / (1.0 - K)));
  // Real overexposure DOES go white, so bleach — but only what is genuinely blown, and only
  // partially, so a bright window core keeps a tint instead of becoming a flat white rectangle.
  ratio = mix(ratio, vec3(1.0), smoothstep(0.86, 1.0, mapped) * 0.26);
  return clamp(ratio * mapped, 0.0, 1.0);
}

// Split tone: teal into the shadows, amber into the highlights. This is the single strongest
// "blue hour" cue in the grade and it lives inside vhGrade so BOTH output paths (straight to the
// screen and through the post chain) get it.
vec3 vhSplitTone(vec3 c) {
  const vec3 SHADOW = vec3(0.72, 1.02, 1.14);
  const vec3 HIGH = vec3(1.06, 1.00, 0.90);
  float l = vhLum(c);
  vec3 lo = c * SHADOW;
  vec3 hi = c * HIGH;
  return mix(lo, hi, smoothstep(0.16, 0.78, l));
}

// --- daylight exposure + OETF -----------------------------------------------------------------
// The curve above is nearly a straight line from scene value to screen value, because the whole
// blue-hour pipeline is authored DISPLAY-REFERRED: the vertex colours are what the surface should
// look like, not how much light it reflects. Daylight cannot work that way. Once vhDayAlbedo hands
// the shading a genuine linear reflectance and the sun hands it a genuine irradiance, the scene is
// physically linear and spans ~50x from a shadowed wall to a sunlit white one, and feeding that
// straight into a display-referred curve puts every sunlit surface hard on the shoulder together.
//
// So the daylight path applies the missing pieces: an exposure (how much light reaches the sensor)
// and an OETF (the ~2.2 gamma that turns linear light into display code values). What comes out is
// display-referred again, which is exactly what the rest of the grade below expects.
//
// day = 0 returns c untouched, bit for bit. This is the gate that keeps blue hour identical.
//
// It was exposure + OETF and nothing else, and that is what left the afternoon image with no
// tonal separation at the top. Measured against the real scene buffer at Bay & King, the transfer
// it produced ran 116 code values at 0.09 scene radiance, 168 at 0.19, 218 at 0.38, 244 at 0.76
// and 252 at 1.5: three stops of sunlit facade — every limestone, marble, granite and painted
// stucco frontage on the street — squeezed into 36 code values with a slope of 9 per stop at the
// top. That is the "narrow bright band", and no amount of grading downstream can pull apart what
// has already been merged.
//
// So the missing piece is a SHOULDER, and it belongs here: in scene light, before the OETF, where
// it shapes the scene's own range instead of the display's. Below the knee nothing is touched at
// all — shadows and midtones pass through exactly as they did — and above it the peak channel
// eases toward VH_DAY_WHITE while the three channels keep their ratio, so a saturated highlight
// climbs without bleaching (the same principle as vhFilmic's rolloff, which is why the two
// compose instead of fighting).
//
// Knee and white point were FITTED, not chosen: against a target transfer with a 20-30 code/stop
// toe, a 42-43 code/stop midtone and a shoulder that decays 36 -> 26 -> 22 -> 18 -> 12, this pair
// plus VH_DAY_FILM_GAIN and DAY_EXPOSURE land it to 4 code values RMS across the whole 0.02 .. 2.9
// range the scene actually occupies.
const float VH_DAY_KNEE = 0.125;      // exposed scene radiance below which nothing is compressed
const float VH_DAY_WHITE = 3.10;      // exposed scene radiance the shoulder asymptotes to

vec3 vhDayTone(vec3 c, float day, float ev) {
  if (day <= 0.0) return c;
  vec3 lin = max(c, vec3(0.0)) * max(ev, 1e-4);
  float p = max(max(lin.r, lin.g), lin.b);
  if (p > VH_DAY_KNEE) {
    float a = VH_DAY_WHITE - VH_DAY_KNEE;
    float np = VH_DAY_KNEE + a * (1.0 - exp(-(p - VH_DAY_KNEE) / a));
    lin *= np / max(p, 1e-6);
  }
  vec3 enc = pow(max(lin, vec3(1e-6)), vec3(1.0 / 2.2));
  return mix(c, enc, clamp(day, 0.0, 1.0));
}

// How much of the split tone survives at full daylight. The teal-shadow / amber-highlight pair is
// the strongest blue-hour cue there is, and at noon it is simply wrong: it swings a neutral sunlit
// concrete wall about 30 code values warm and a neutral shadowed one about 25 cool. At 0.30 a grey
// surface stays grey across the whole range (measured |B - R| <= 11 at every luminance).
const float VH_DAY_SPLIT = 0.30;

// --- the daylight half of the grade ------------------------------------------------------------
// The complaint these three answer is that the afternoon image is bright but WASHED: measured
// from the harbour it sat at 155.9 frame luma with a 30% mean saturation, and at street level the
// sunlit facades came back with a median of 222 and 80% of them over 200. That is not a highlight
// band, it is a clipped one, and everything in it — limestone, white marble, painted stucco, the
// gold on Royal Bank Plaza — arrives at the same value with the same (absent) chroma.
//
// FILM_GAIN. vhFilmic opens with a fixed x1.30, which is a blue-hour figure: at dusk the whole
// image lives near the bottom of the range and needs lifting off the floor. In daylight the
// scene-light shoulder in vhDayTone above has already placed the range, and 1.30 on top of it
// drives everything past the display knee (K = 0.70) together again. The trim and the exposure
// (DAY_EXPOSURE) are the two halves of one fit: together with the knee and white point they
// reproduce the target transfer to 4 code values RMS.
//
// SCURVE and SAT carry the contrast and the colour. The S-curve is the "deepen the shadows a
// little" half — it sits close to the blue-hour value because the shoulder is now doing the work
// that a heavy S was being asked to do — and the saturation push is what finally lets the 33
// surveyed facade colours read as colours rather than as tinted greys.
//
// All three are mix()ed from the blue-hour value by day, so at daylight 0 this function is the
// same arithmetic it always was, bit for bit.
const float VH_DAY_FILM_GAIN = 0.70;                // replaces vhFilmic's 1.30, in daylight only
const float VH_DAY_SCURVE = 0.24;                   // blue hour keeps 0.22
const float VH_DAY_SAT = 1.40;                      // blue hour keeps 1.08

vec3 vhGradeD(vec3 c, float day) {
  float d = clamp(day, 0.0, 1.0);
  // Pre-scaling the input is exactly equivalent to changing vhFilmic's own opening gain, and it
  // leaves that function — the hue-preserving peak rolloff, CONTRACT 3.2 — untouched.
  c = vhFilmic(c * mix(1.0, VH_DAY_FILM_GAIN / 1.30, d));
  c = mix(c, c * c * (3.0 - 2.0 * c), mix(0.22, VH_DAY_SCURVE, d));
  c = mix(c, vhSplitTone(c), 0.85 * mix(1.0, VH_DAY_SPLIT, d));
  float l = vhLum(c);
  c = clamp(mix(vec3(l), c, mix(1.08, VH_DAY_SAT, d)), 0.0, 1.0);
  return pow(c, vec3(0.98));                        // whisper of gamma lift
}

vec3 vhGrade(vec3 c) { return vhGradeD(c, 0.0); }

// --- HDR range compression, used ONLY on the RGBA8 offscreen fallback ----------------------
// A reversible Reinhard curve: slope 1.0 at black so shadows keep every bit they had, with the
// whole (1, inf) range folded into (0.5, 1). Highlights lose precision — that is exactly the
// "less headroom" the RGBA8 path is documented to have — but they are not clipped to white
// before the bright pass gets to see them, which is what makes lit windows still read as warm.
vec3 vhEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return c / (1.0 + c);
}
vec3 vhDecode(vec3 c) {
  c = clamp(c, vec3(0.0), vec3(0.9961));   // 255/256: the largest value an 8-bit target can hold
  return c / (1.0 - c);
}

// Final write for anything that draws into the frame.
//   mode 0: straight to the screen — grade here, no post chain exists.
//   mode 1: float offscreen target — hand the resolve/composite untouched linear light.
//   mode 2: 8-bit offscreen target — range-compress so values above 1.0 survive the trip.
vec3 vhOut(vec3 col, float mode) {
  col = max(col, vec3(0.0));
  if (mode < 0.5) return clamp(vhGrade(col), 0.0, 1.0);
  if (mode < 1.5) return col;
  return vhEncode(col);
}

// Same three modes, with the daylight exposure/OETF folded into the mode-0 (no post chain) path.
// Modes 1 and 2 hand the composite untouched linear light, and the composite applies the daylight
// tone itself — the tone must run exactly ONCE per pixel, wherever the grade happens.
vec3 vhOutD(vec3 col, float mode, float day, float ev) {
  col = max(col, vec3(0.0));
  if (mode < 0.5) return clamp(vhGradeD(vhDayTone(col, day, ev), day), 0.0, 1.0);
  if (mode < 1.5) return col;
  return vhEncode(col);
}
`;

// Cascaded shadow map lookup, shared by the scene and water shaders. Atlas layout: every cascade
// owns one tile of a single depth texture, and uCsmMat already folds the [-1,1] -> [0,1] bias AND
// the tile transform in, so the fragment shader does one mat4 multiply per cascade and lands
// straight on atlas UVs.
const GLSL_SHADOW = `
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

// Procedural facade lighting — CONTRACT §3.2 item 5, and the single thing that makes 4,818 boxes
// read as Toronto rather than as boxes. Everything is derived from WORLD POSITION; there are no
// UVs anywhere in this project.
//
//   storey lines : world Y
//   bay lines    : distance along the facade's own horizontal tangent, T = normalize(up x N),
//                  which is stable for every vertical face and degenerate only on roofs (where
//                  the whole effect is masked out by `vertical`)
//   seed         : hashed from the facade PLANE (its normal and its offset from the origin) plus
//                  the building's lighting profile, so it is constant across one wall and
//                  different for the next building along — no per-building attribute is needed
//                  and no seam can appear mid-facade
//
// THE PROFILE IS THE POINT. data/toronto.json now carries an OSM-derived lighting profile per
// building in aMat.w, and a single office-window treatment applied to every vertical surface in
// the city — stadium domes included — is precisely what made the old build read as procedural:
//
//   0 ENVELOPE     no window grid AT ALL. Rogers Centre, Scotiabank Arena, Roy Thomson Hall,
//                  the CN Tower. Pure material shading; these are envelopes, not curtain walls.
//   1 OFFICE       strict curtain-wall grid, whole floors dark, warm white with a cool minority
//   2 RESIDENTIAL  individual suites: wide cells, LOW lit fraction, much warmer and far more
//                  varied per unit, balcony bands, blue TV flicker, dark vertical runs
//   3 RETAIL       a bright warm shopfront band at street level, dark above
//   4 PARKING      open horizontal deck slots, greenish-white strip lighting, mostly open air
//   5 CIVIC        small punched windows, mostly dark, tungsten — heritage stone character
const GLSL_FACADE = `
// The widest a pane edge may be filtered, in CELLS. It is a clamp rather than the raw footprint
// because a filter wider than the pane itself takes the pane's peak with it, and a window that
// has lost its peak has stopped being interior light and started being a grey wall.
//
// 0.50, not 0.35. The crossfade in vhFacade below hands this function a FINE level whose cell
// footprint runs from VH_WIN_FOLD to 2 x VH_WIN_FOLD of a pixel, so the fine level's aa is
// 0.50-1.00 and the old clamp left it under-filtered over that whole span — including at the
// bottom of it, where the crossfade gives the fine level ALL of the weight. Cost of widening it:
// an office pane's peak coverage falls from 1.000 to 0.960 at the worst point, which is nothing
// next to what it buys in temporal stability at 2 km and beyond (see VH_WIN_FOLD).
const float VH_WIN_AA_MAX = 0.50;
// One evaluation of the facade lattice at ONE cell size. Returns rgb = emitted interior light,
// w = GLAZING coverage (1 inside a pane, 0 on a mullion, spandrel, slab or masonry wall) so the
// caller can keep panes smooth and roughen everything that is not glass.
//
// 'uvw' is (distance along the facade tangent, world Y) and 'aaWorld' is that pair's screen-space
// derivative in METRES. Both are computed by the caller in uniform control flow: fwidth() inside
// this function would be undefined for any 2x2 quad that straddles the "is this a wall?" test.
//
// 'hAbove' is metres above local grade — retail shopfronts and parking decks are placed by it.
vec4 vhFacadeCells(int prof, vec2 uvw, vec2 cellSz, vec2 off, float seed,
                   float lit, float time, vec2 aaWorld, float hAbove) {
  vec2 sz = max(cellSz, vec2(0.35));
  vec2 g = (uvw + off) / sz;
  vec2 aa = max(aaWorld / sz, vec2(1e-5));
  vec2 cell = floor(g);
  vec2 f = g - cell;
  vec2 e = min(aa, vec2(VH_WIN_AA_MAX));

  float r = vhHash21(cell + vec2(seed * 91.7, seed * 47.3));          // per cell
  float rf = vhHash21(vec2(cell.y * 0.5 + 3.0, seed * 137.3));        // per floor
  float rc = vhHash21(vec2(cell.x * 0.5 + 11.0, seed * 61.9));        // per vertical run
  float r2 = fract(r * 13.77);
  float r3 = fract(r * 5.91);

  // Pane rectangle inside the cell (x0, x1, y0, y1), the tint, whether the cell is lit at all,
  // its brightness, and any emitter that is NOT bounded by the pane (strip lights, balcony
  // spill, signage wash). Every profile fills these in its own way.
  vec4 win = vec4(0.11, 0.89, 0.20, 0.88);
  vec3 tint = vec3(1.0);
  vec3 extra = vec3(0.0);
  float on = 0.0;
  float level = 1.0;
  float glazed = 1.0;

  if (prof == 1) {
    // ---- OFFICE -------------------------------------------------------------------------
    // A strict curtain wall: uniform bays, a deep spandrel under every sill, and WHOLE FLOORS
    // dark because the cleaners have been and gone. Colour sits warm-white with a cool
    // fluorescent minority, and a floor tends to share one lamp type because one tenant fitted
    // it out — that floor-wide coherence is a large part of what makes an office read as an
    // office next to a condo.
    win = vec4(0.085, 0.915, 0.215, 0.885);
    float floorDark = step(0.26, rf);
    float bayDark = step(0.05, rc);
    on = step(r, lit) * floorDark * bayDark;
    level = 0.55 + 0.45 * r3;
    tint = vhLampTint(0.30 + 0.66 * pow(r2, 1.25));
    tint = mix(tint, vhLampTint(0.34 + 0.58 * rf), 0.50);
    // A thin line of corridor light survives on some dark floors — never a perfectly black band.
    extra = vec3(0.62, 0.66, 0.72) * (1.0 - floorDark) * step(0.55, rc) * 0.030;
  } else if (prof == 2) {
    // ---- RESIDENTIAL --------------------------------------------------------------------
    // A condo does not light like an office and must not look like one. Cells are a whole SUITE
    // wide, only a quarter to a third are lit, each one is a different warmth and brightness
    // because it is a different person's lamp, whole vertical runs are dark (service cores, the
    // unsold north face), and one in ten lit rooms is a television.
    float balconied = step(0.42, fract(seed * 3.19));
    win = mix(vec4(0.10, 0.90, 0.24, 0.90), vec4(0.055, 0.945, 0.42, 0.945), balconied);
    float runDark = step(0.17, rc);
    float floorDark = step(0.07, rf);
    on = step(r, lit) * runDark * floorDark;
    level = 0.26 + 0.90 * r3 * r3;
    tint = vhLampTint(0.015 + 0.44 * pow(r2, 0.72));
    // Television: a cold blue that breathes. Two detuned sines beat against each other, which
    // reads as cut-to-cut flicker rather than as a sine wave.
    float tv = step(0.895, fract(r * 31.7)) * on;
    float beat = 0.42 + 0.58 * abs(sin(time * 3.1 + r * 61.0) * sin(time * 1.37 + r * 17.0));
    tint = mix(tint, vec3(0.40, 0.58, 1.00), tv * 0.92);
    level *= mix(1.0, beat * 1.35, tv);
    // Balcony slab: a dim warm spill onto the concrete under a lit suite, and the slab edge
    // catching a little of it. This is the horizontal banding that says "condo" from 2 km.
    float slab = (1.0 - smoothstep(0.30, 0.40, f.y)) * balconied;
    extra = tint * on * level * slab * 0.16;
  } else if (prof == 3) {
    // ---- RETAIL -----------------------------------------------------------------------------
    // Bright warm shopfront at street level, dark above. The band is placed by height above LOCAL
    // grade, not world Y — downtown climbs 30 m from the lake and an absolute band would sit in
    // the sky at King & Bay and underground at the ferry docks.
    win = vec4(0.055, 0.945, 0.10, 0.86);
    float band = smoothstep(0.20, 1.10, hAbove) * (1.0 - smoothstep(4.4, 6.6, hAbove));
    // Above the shopfront: a tenth as many windows, dimmer. Not black — a mixed-use podium has
    // a stair core and the odd back office, and pure black slabs read as holes in the street.
    on = mix(step(r, lit * 0.13), step(r, lit), band);
    level = mix(0.30 + 0.30 * r3, 0.72 + 0.42 * r3, band);
    tint = vhLampTint(0.20 + 0.52 * r2);
    // Signage: one shopfront in eight runs a saturated sign, and that is where the only real
    // chroma at street level comes from.
    float neon = step(0.875, fract(r * 23.1)) * band;
    float sk = fract(r * 3.31);
    vec3 signCol = mix(vec3(1.00, 0.24, 0.28), vec3(0.34, 1.00, 0.70), smoothstep(0.28, 0.52, sk));
    signCol = mix(signCol, vec3(0.32, 0.62, 1.00), smoothstep(0.60, 0.84, sk));
    tint = mix(tint, signCol, neon * 0.85);
    // Light spilling out of the shopfront onto the sidewalk soffit above it.
    extra = tint * on * band * 0.10;
  } else if (prof == 4) {
    // ---- PARKING ----------------------------------------------------------------------------
    // Open decks: a continuous horizontal slot broken by a column every cell, not a grid of
    // windows. The slot is OPEN AIR, so it returns no glazing at all (w = 0) and the caller
    // roughens the whole surface as bare concrete. What you actually see at night is the
    // greenish-white strip fitting on the deck ceiling and a dim wash on the slab.
    glazed = 0.0;
    float slot = smoothstep(0.10 - e.x, 0.10 + e.x, f.x) * (1.0 - smoothstep(0.90 - e.x, 0.90 + e.x, f.x));
    slot *= smoothstep(0.20 - e.y, 0.20 + e.y, f.y) * (1.0 - smoothstep(0.82 - e.y, 0.82 + e.y, f.y));
    float deckOn = step(0.12, rf);
    float strip = smoothstep(0.68, 0.74, f.y) * (1.0 - smoothstep(0.79, 0.83, f.y));
    vec3 fluor = vec3(0.74, 0.96, 0.82);
    // The interior is a dark cavity with the fitting glowing in it, plus the fitting itself.
    extra = fluor * deckOn * (slot * 0.085 * (0.7 + 0.6 * rc) + strip * slot * 0.70);
    on = 0.0;
    tint = fluor;
    level = 0.0;
  } else if (prof == 5) {
    // ---- CIVIC ------------------------------------------------------------------------------
    // Heritage stone: small punched openings in a lot of wall, nearly all of them dark, and what
    // little is lit is tungsten. Union Station, St Lawrence Hall, the old bank halls.
    win = vec4(0.335, 0.665, 0.245, 0.700);
    on = step(r, lit) * step(0.30, rf);
    level = 0.32 + 0.46 * r3;
    tint = vhLampTint(0.02 + 0.20 * r2);
  }

  float px = smoothstep(win.x - e.x, win.x + e.x, f.x) * (1.0 - smoothstep(win.y - e.x, win.y + e.x, f.x));
  float py = smoothstep(win.z - e.y, win.z + e.y, f.y) * (1.0 - smoothstep(win.w - e.y, win.w + e.y, f.y));
  float pane = px * py * glazed;
  return vec4(tint * pane * on * level + extra, pane);
}

// Per-profile lattice geometry. Cell size, phase offset, lit fraction and the pane coverage a
// facade converges on once its cells fall below a pixel. Kept in one place so the LOD crossfade
// below is written once and every profile gets it.
void vhFacadeStyle(int prof, float seed, float baseLit,
                   out vec2 cellSz, out vec2 off, out float lit, out float meanPane) {
  float j1 = fract(seed * 7.31);
  float j2 = fract(seed * 3.77);
  // Office: 3.9 m floor-to-floor, ~3 m bays.
  cellSz = vec2(3.00 * (0.86 + 0.34 * j2), 3.92 * (0.95 + 0.13 * j1));
  lit = baseLit * 1.34;
  meanPane = 0.60;
  if (prof == 2) {
    // A condo suite is WIDE and its floors are SHORT — the opposite proportion to an office,
    // which is most of why the two silhouettes read differently before you see a single colour.
    cellSz = vec2(6.45 * (0.84 + 0.36 * j2), 3.06 * (0.96 + 0.10 * j1));
    lit = baseLit * 0.74;
    meanPane = 0.56;
  } else if (prof == 3) {
    cellSz = vec2(2.85 * (0.80 + 0.45 * j2), 4.45 * (0.92 + 0.18 * j1));
    lit = baseLit * 1.55;
    meanPane = 0.62;
  } else if (prof == 4) {
    cellSz = vec2(7.60 * (0.88 + 0.26 * j2), 3.10 * (0.95 + 0.12 * j1));
    lit = baseLit;
    meanPane = 0.0;
  } else if (prof == 5) {
    cellSz = vec2(4.55 * (0.86 + 0.30 * j2), 4.35 * (0.92 + 0.18 * j1));
    lit = baseLit * 0.40;
    meanPane = 0.20;
  }
  off = vec2(fract(seed * 5.17), fract(seed * 11.13)) * cellSz;
  lit = clamp(lit, 0.0, 1.0);
}

// Where the lattice folds, in CELLS PER PIXEL, and how many times it may.
//
// A cell is one pane plus one mullion — one period of the signal — so Nyquist puts the hard floor
// at 1.0 cells per pixel and any real reconstruction filter wants to be well under it. 0.50 holds
// every cell at two pixels or more. It was 0.62 (1.6 px), which is inside the range where the
// per-cell lit/unlit draw is still a random field at the sampling rate, and the crossfade spends
// half its weight on a level finer than that again.
//
// Nothing the player stands next to can be touched by this: the first fold happens where a cell
// first falls under two pixels, which for an office lattice with 2.6-3.6 m bays at 1440x900 is
// 1.0-1.4 km (it was 1.3-1.7 km at 0.62). Street level, and the whole of the detail-tile radius,
// is below lod 0 and runs the unfolded lattice exactly as before.
//
// MEASURED — the temporal CRAWL of a skyline region, i.e. the RMS change over a half-pixel camera
// yaw, reported against the same measurement on a 2x supersampled pair, which is the floor a 1x
// image can reach. Night, where the lattice is the only signal in the frame:
//
//                                    postcard, 2.2 km          far corner, 5.5 km
//     fold 0.62, filter 0.35        0.1088 / 0.0786  1.38     0.0387 / 0.0253  1.53
//     fold 0.50, filter 0.35        0.1040 / 0.0792  1.31     0.0392 / 0.0253  1.55
//     fold 0.50, filter 0.50        0.0994 / 0.0784  1.27     0.0360 / 0.0240  1.50
//
// And the far corner's residual is NOT the lattice. With the window light switched off entirely
// the same region measures 0.0116 / 0.0068 — a ratio of 1.71, worse than the lattice's — because
// what crawls at 5.5 km is the SILHOUETTE, one-pixel roof and wall edges, which is FXAA's problem
// and not the LOD's: with FXAA off the full-lattice figure is 0.0651 / 0.0375. The frequency LOD
// holds at six kilometres; it is the thing keeping that number as low as it is.
const float VH_WIN_FOLD = 0.50;

// How many times the lattice may fold. 4 is 16x cells — a 48 m office bay — which is reached at
// a facade footprint of 24 m per pixel, i.e. only on walls seen within a couple of degrees of
// edge-on. Past that the cell stops tracking and the pane filter carries it; letting it keep
// doubling instead would put one lit-or-unlit cell across a whole tower, which is worse than the
// aliasing it would be fixing.
const float VH_WIN_LOD_MAX = 4.0;

vec3 vhFacade(int prof, vec3 world, vec3 N, vec2 uvw, vec2 aaWorld, float baseLit,
              float time, float hAbove, out float glass) {
  float d = dot(world, N);
  float seed = vhHash31(vec3(floor(d * 0.31 + 0.5) + float(prof) * 19.0,
                             floor(N.x * 5.0 + 5.5), floor(N.z * 5.0 + 5.5)));

  vec2 cellSz, off;
  float lit, meanPane;
  vhFacadeStyle(prof, seed, baseLit, cellSz, off, lit, meanPane);

  // ---------------------------------------------------------------------------------------
  // DISTANCE LOD. Fading 'lit' toward its own mean turns the skyline into flat khaki slabs --
  // bloom and the filmic shoulder are non-linear, so the mean is not the appearance. But full
  // contrast at every distance makes every tower dissolve into sub-pixel speckle from across
  // the harbour, which is worse: the massing stops reading at all.
  //
  // So reduce the FREQUENCY, not the contrast. Cells double in size as they approach a pixel,
  // exactly like a mip level, and crossfade between the two nearest levels so nothing pops.
  // Cells stay fully lit-or-unlit, so they still punch through the tonemap and read as interior
  // light -- but they never fall below the sampling rate. This is also what real buildings look
  // like at 2 km: you see lit clusters and dark floors, not individual panes. Every profile
  // gets it, which matters most for the residential lattice: its cells are the largest, so it
  // is the last to fold, and a condo tower keeps its sparse scattered look furthest out.
  float perPixel = max(aaWorld.x / cellSz.x, aaWorld.y / cellSz.y);
  float lod = clamp(log2(max(perPixel, 1e-5) / VH_WIN_FOLD), 0.0, VH_WIN_LOD_MAX);
  float l0 = floor(lod);
  float t = lod - l0;
  float m0 = exp2(l0);

  vec4 a = vhFacadeCells(prof, uvw, cellSz * m0, off, seed, lit, time, aaWorld, hAbove);
  vec4 b = vhFacadeCells(prof, uvw, cellSz * (m0 * 2.0), off, seed, lit, time, aaWorld, hAbove);
  vec4 res = mix(a, b, t);

  glass = mix(res.w, meanPane, smoothstep(2.5, 4.0, lod));
  return res.rgb;
}

// --- CN Tower ------------------------------------------------------------------------------
// The single most recognisable object on the skyline, and it must not be lit like anything else
// in the city. The real tower carries a programmable LED wash that walks slowly through blues,
// violets and cold whites, lit restaurant and SkyPod glazing bands, and red aviation beacons up
// the mast. All of it is keyed off metres above the tower's own base, so it travels correctly
// whichever way the camera looks at it.
vec3 vhCnWash(float hUp, float time) {
  // A slow travelling gradient: the pattern climbs the shaft while the palette rotates.
  float w = fract(time * 0.026 - hUp * 0.0021);
  vec3 c = vec3(0.10, 0.34, 1.00);                                    // deep blue
  c = mix(c, vec3(0.58, 0.22, 1.00), smoothstep(0.00, 0.28, w));      // violet
  c = mix(c, vec3(0.16, 0.72, 1.00), smoothstep(0.26, 0.52, w));      // cyan
  c = mix(c, vec3(0.82, 0.90, 1.00), smoothstep(0.50, 0.74, w));      // cold white
  c = mix(c, vec3(0.10, 0.34, 1.00), smoothstep(0.72, 1.00, w));      // back to blue, seamlessly
  return c;
}

// One red aviation beacon: a soft band up and down the mast from its fitting, pulsing.
float vhCnBeacon(float hUp, float at, float rate, float time) {
  float band = 1.0 - smoothstep(0.0, 8.0, abs(hUp - at));
  float s = 0.5 + 0.5 * sin(time * rate + at * 0.37);
  float pulse = s * s;
  pulse *= pulse;
  pulse *= pulse;
  return band * (0.10 + 0.90 * pulse);
}
`;

// --- LOCAL LIGHTS ------------------------------------------------------------------------------
// The street lamps, as actual lights. Until this existed the ONLY street lighting in the renderer
// was uStreetColor — one global uniform wash keyed on height above grade and multiplied by 0.30 on
// anything horizontal, which on 3%-reflectance asphalt at Night comes to about 0.002 linear. That
// is black. Every mast in the city carried a genuine emissive lens and lit nothing at all, because
// an emissive lens is a surface that is BRIGHT, not a surface that ILLUMINATES.
//
// So: real punctual lights, clustered in world space. See the LIGHT_* block at the top of this
// file for why the cluster grid is a 2-D world grid rather than a screen tiling.
//
// The rig is gated on nightFactor * (1 - daylight) at the point of use and NOTHING is baked:
// Afternoon multiplies it by exactly zero, Golden hour by 0.099, Blue hour by 0.86 and Night by
// 1.0, all of them read straight off the existing preset fields (CONTRACT Amendment 7).
//
// There are no shadow maps for these lights. A cascade set per lamp is out of the question at this
// count, and the alternative — omitting the lights — is what the previous build did. The reach is
// deliberately short (a windowed inverse square that is fully closed by ~32 m) and the cutoff term
// puts almost nothing above the head, so the leak is bounded to about a wall thickness: a lamp on
// the far side of a building lights a couple of metres of the near face and nothing else.
const GLSL_LIGHTS = `
const int VH_LGRID = ${LIGHT_GRID_N};
const int VH_LSLOTS = ${LIGHT_SLOTS};

// Row 0 of uLightData: xyz = world position, w = influence radius.
// Row 1:               rgb = colour x power, w = cutoff (0 bare globe .. 1 full cutoff head).
uniform highp sampler2D uLightData;
// One texel per (cell, slot): the light index PLUS ONE, so 0 can mean "no more lights here".
uniform highp usampler2D uLightGrid;
uniform vec4 uLightWindow;   // xy = window origin in world XZ, z = 1 / cell size, w = master gain
uniform vec2 uLightRig;      // x = rig level, y = 1 when the tables are live

// Anisotropic GGX (Burley). Two roughnesses about an in-plane frame instead of one, which is what
// turns a lamp's reflection on a road from a round blob into the long smear you actually see.
float vhD_GGXAniso(float ndh, float tdh, float bdh, float ax, float ay) {
  float dx = tdh / max(ax, 1e-4);
  float dy = bdh / max(ay, 1e-4);
  float k = dx * dx + dy * dy + ndh * ndh;
  return 1.0 / max(VH_PI * ax * ay * k * k, 1e-7);
}

// The axis the sheen stretches along: the HORIZONTAL component of the view direction, projected
// into the surface. Asphalt is anisotropic because it is rolled, and it is rolled along the
// carriageway — which is the direction a pedestrian on that carriageway is almost always looking.
// Deriving the axis from the view rather than from a road tangent costs nothing (there are no
// tangents in this vertex format), is continuous everywhere, and degenerates gracefully: looking
// straight down at the road there IS no streak direction, and the fallback below is only ever
// reached within a twentieth of a degree of vertical, where the highlight is a round spot anyway.
vec3 vhAnisoAxis(vec3 N, vec3 V) {
  vec3 t = vec3(V.x, 0.0, V.z);
  t = t - N * dot(N, t);
  float l = length(t);
  if (l > 1e-3) return t / l;
  vec3 f = abs(N.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 t2 = f - N * dot(N, f);
  float l2 = length(t2);
  return l2 > 1e-4 ? t2 / l2 : vec3(1.0, 0.0, 0.0);
}

// Sum the lamps whose cluster cell this fragment falls in. 'aniso' is 0 for everything that is not
// a carriageway, and at 0 the anisotropic lobe below is the isotropic one to the bit.
void vhLocalLights(vec3 P, vec3 N, vec3 V, float ndv, float rough, float aniso,
                   out vec3 diffuse, out vec3 specular) {
  diffuse = vec3(0.0);
  specular = vec3(0.0);
  float rig = uLightRig.x;
  if (rig <= 0.002 || uLightRig.y < 0.5) return;

  // Which cluster cell. Two subtractions, a multiply and a floor — no projection, no frustum.
  vec2 g = (P.xz - uLightWindow.xy) * uLightWindow.z;
  if (g.x < 0.0 || g.y < 0.0) return;
  ivec2 c = ivec2(g);
  if (c.x >= VH_LGRID || c.y >= VH_LGRID) return;

  vec3 T = vhAnisoAxis(N, V);
  vec3 Bt = cross(N, T);
  float a = max(rough * rough, 0.0016);
  // Stretch the lobe along T and narrow it across, holding ax * ay — and therefore the lobe's
  // integral — constant, so anisotropy moves the highlight's SHAPE and never its energy.
  float k = 1.0 + clamp(aniso, 0.0, 1.0) * 2.6;
  float ax = clamp(a * k, 0.0016, 0.98);
  float ay = clamp(a / k, 0.0016, 0.98);
  float aIso = sqrt(max(ax * ay, 1e-8));
  float gain = max(uLightWindow.w, 0.0) * rig;
  int base = c.x * VH_LSLOTS;

  for (int s = 0; s < VH_LSLOTS; s++) {
    uint id = texelFetch(uLightGrid, ivec2(base + s, c.y), 0).r;
    if (id == 0u) break;                       // the cell's list is packed, so this is the end
    int li = int(id) - 1;
    vec4 lp = texelFetch(uLightData, ivec2(li, 0), 0);
    vec3 dv = lp.xyz - P;
    float d2 = dot(dv, dv);
    float r2 = max(lp.w * lp.w, 1e-4);
    if (d2 >= r2) continue;
    float d = sqrt(max(d2, 1e-8));
    vec3 L = dv / d;
    float ndl = dot(N, L);
    if (ndl <= 0.0) continue;

    vec4 lc = texelFetch(uLightData, ivec2(li, 1), 0);
    // Karis' windowed inverse square: physical falloff with a finite radius and no visible edge
    // where it ends. The +1 m^2 is the source's own size — without it a fragment that lands on
    // the lens itself returns infinity.
    float w = clamp(1.0 - d2 / r2, 0.0, 1.0);
    w *= w;
    // Luminaire distribution. A full-cutoff cobra head puts nothing above the horizontal and is
    // at full output a few degrees below it; a heritage globe is very nearly omnidirectional.
    // L points from the fragment TO the lamp, so dot(vec3(0,-1,0), -L) — how far below the lamp
    // this fragment sits, measured along the luminaire's own downward axis — is exactly L.y.
    float cut = mix(1.0, smoothstep(-0.34, 0.10, L.y), clamp(lc.w, 0.0, 1.0));
    float e = (w / (d2 + 1.0)) * cut * gain;
    if (e <= 1e-7) continue;

    diffuse += lc.rgb * (e * ndl);

    vec3 H = normalize(L + V);
    float ndh = clamp(dot(N, H), 0.0, 1.0);
    float vdh = clamp(dot(V, H), 0.0, 1.0);
    float D = vhD_GGXAniso(ndh, dot(T, H), dot(Bt, H), ax, ay);
    vec3 sp = lc.rgb * (e * ndl * D * vhV_Smith(ndv, ndl, aIso)) * vhF_Schlick(vec3(0.04), vdh);
    // One wet pixel lining a lamp up exactly must not return four figures of radiance and become
    // a firefly the bloom chain then smears across the frame.
    specular += min(sp, vec3(6.0));
  }
}

// --- the road surface --------------------------------------------------------------------------
// Value noise on WORLD XZ (CONTRACT §8.4: every procedural hash is keyed on world position, never
// on an index, so a tile looks the same whether or not its neighbours are resident).
float vhNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = vhHash21(i);
  float b = vhHash21(i + vec2(1.0, 0.0));
  float c = vhHash21(i + vec2(0.0, 1.0));
  float d = vhHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// How wet a patch of carriageway is, 0..1. Two octaves at 18 m and 5.5 m: standing water gathers
// in the crown's low side and along the gutter line in patches tens of metres long, and a road
// that is uniformly wet everywhere is exactly the varnished-sheet look this is here to kill.
// 'k' is env-level wetness; at k = 0 the smoothstep window sits entirely above the noise's range
// and this returns 0 for every fragment in the city.
float vhRoadWet(vec2 xz, float k) {
  float f = vhNoise2(xz * 0.0555) * 0.70 + vhNoise2(xz * 0.1820 + vec2(37.3, 11.7)) * 0.30;
  return smoothstep(1.0 - k, 1.02 - k * 0.35, clamp(f, 0.0, 1.0));
}
`;
/* ------------------------------------------------------------------ scene pass */

const SCENE_VS = `#version 300 es
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

const SCENE_FS = `#version 300 es
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
// The glyph itself is a signed distance field; see src/text.js for why, and for the atlas.
const TEXT_VS = `#version 300 es
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

const TEXT_FS = `#version 300 es
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

/* -------------------------------------------------------------------- sky pass */

// Fullscreen triangle from gl_VertexID — no vertex buffer, no attributes.
const SKY_VS = `#version 300 es
precision highp float;

out vec2 vNdc;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}
`;

const SKY_FS = `#version 300 es
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

/* ------------------------------------------------------------------ water pass */

const WATER_VS = `#version 300 es
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

const WATER_FS = `#version 300 es
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

/* --------------------------------------------------------- shadow depth pass */

const CSM_VS = `#version 300 es
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
const CSM_FS = `#version 300 es
precision highp float;

out vec4 outColor;

void main() {
  outColor = vec4(1.0);
}
`;

/* ------------------------------------------------- legacy blob ground shadows */

const GSHADOW_VS = `#version 300 es
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
const GSHADOW_FS = `#version 300 es
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

/* ------------------------------------------------------------- post-processing */

// Every post pass is a single fullscreen triangle generated from gl_VertexID — no vertex buffer,
// no attributes, one attributeless VAO shared with the sky.
const POST_VS = `#version 300 es
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
const GLSL_DEPTH = `
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
const SSAO_FS = `#version 300 es
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
const AOBLUR_FS = `#version 300 es
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
const SSR_FS = `#version 300 es
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
const RESOLVE_FS = `#version 300 es
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
const BRIGHT_FS = `#version 300 es
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
const BLUR_FS = `#version 300 es
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
const COMP_FS = `#version 300 es
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
const FXAA_FS = `#version 300 es
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

/* -------------------------------------------------------------------- renderer */

// Views into the packed cascade uniform arrays, so the fit runs without allocating. Sized from
// MAX_CASCADES rather than written out, because the cascade count is a tuning decision and a
// hand-unrolled list of three is exactly the kind of thing that survives a change to it.
const _csmMatView = [];
const _csmLightVP = [];
for (let i = 0; i < MAX_CASCADES; i++) {
  _csmMatView.push(_csmMat.subarray(i * 16, i * 16 + 16));
  _csmLightVP.push(mat4());
}

export class Renderer {
  constructor(gl) {
    this.gl = gl;
    this.width = gl.drawingBufferWidth || 1;
    this.height = gl.drawingBufferHeight || 1;
    this.camera = null;
    this.contextLost = false;
    // Set when a context loss could not be recovered from and only a page reload will do.
    this.needsReload = false;

    this.stats = {
      draws: 0, tris: 0, programSwaps: 0, vaoBinds: 0, postPasses: 0, shadowDraws: 0,
    };

    // CONTRACT §3.2. Every one of these is independently switchable at runtime from the console
    // (`G.renderer.quality.ssr = false`) and every one degrades to "off" on its own if the GPU
    // cannot provide it. None of them can block boot.
    this.quality = {
      shadows: 'high',   // 'off' | 'low' (1 x 1024) | 'high' (3 x 2048)
      ssao: true,
      ssr: true,
      bloom: true,
      clouds: true,
      fxaa: true,        // the only AA there is once the frame renders offscreen
      lights: true,      // the clustered local-light rig (street lamps)
    };

    // Tunable live: `G.renderer.bloom.intensity = 1.4`.
    this.bloom = { enabled: true, threshold: 0.72, intensity: 0.85, radius: 1.0 };

    this.shadow = {
      distance: 2200,     // metres of camera frustum covered by the cascades
      // Where the first split lands, in metres, and the bracket it is held in. Defaults are the
      // CSM_SPLIT_* constants; overriding them here is the one knob that trades near sharpness
      // against mid-field sharpness without touching the reach.
      split0: CSM_SPLIT0,
      splitMin: CSM_SPLIT_MIN,
      splitMax: CSM_SPLIT_MAX,
      strength: 0.74,     // 1 = fully black shadow (before ambient fills it back in)
      normalOffset: 1.6,  // in shadow texels
      constBias: 0.035,   // metres
      slopeBias: 0.22,    // metres per unit slope
      extrude: 900,       // metres of caster head-room above each cascade (the CN Tower is 553 m)
      blend: 0.16,        // fraction of each cascade blended into the next
    };

    this.ssao = { radius: 3.4, intensity: 1.0, bias: 0.045, power: 1.35, sharpness: 5.5 };

    // TEXT LEVEL OF DETAIL. Two independent gates; whichever closes first wins.
    //
    //   fadeStart/fadeEnd  metres. The hard guarantee, and the numbers the caller's tile stage is
    //                      built around — src/text.js exports the same pair as TEXT_FADE_START /
    //                      TEXT_FADE_END, and TEXT_RANGE sits past fadeEnd so a run is already
    //                      invisible before its tile is allowed to drop the geometry.
    //   minPx/fadePx       CAP HEIGHT IN PIXELS. This is the gate that does the perceptual work,
    //                      because "how far away is it" is the wrong question — a 120 mm street
    //                      blade and a 2 m tower crown are unreadable and perfectly readable at
    //                      the same 60 m. 4.6 px is about where a word stops being a word;
    //                      2.4 px is where it is a smear that only crawls, so it goes.
    //   weight             texels of dilation at full minification (see uTextWeight).
    // Tunable live: `G.renderer.text.fadeEnd = 260`.
    this.text = {
      fadeStart: TEXT_FADE_START,
      fadeEnd: TEXT_FADE_END,
      minPx: 2.4,
      fadePx: 4.6,
      weight: 0.42,
    };

    // Daylight INDIRECT light: the bounce off the sunlit city, and the sky-view correction that
    // goes with it. This is what makes a street canyon read as three in the afternoon instead of
    // deep dusk — see the uDayIndirect block in GLSL_COMMON for the physics and the measured
    // numbers. Every field is multiplied by uDaylight at the point of use, so at daylight 0 the
    // whole object is an exact no-op and blue hour and night cannot be moved by any of it.
    // Tunable live: `G.renderer.dayIndirect.street = 0.18`.
    this.dayIndirect = {
      wall: 0.030,     // sun irradiance a VERTICAL surface takes back off the sunlit city
      street: 0.150,   // and a SKY-FACING one: carriageway, sidewalk, kerb, deck, prop top
      skyView: 0.52,   // daylight sky-view of a vertical surface, against a horizontal one
      warmth: 0.45,    // how far the bounce leans to the masonry spectrum it came off
      aoFill: 0.62,    // fraction of the SSAO occlusion the bounce hands back, at full daylight
    };
    // The ray budget has to cross the HARBOUR, not just a street. The reflection of the skyline
    // in the lake is the signature shot (CONTRACT §0/§3.2.4) and the towers sit 600-1500 m from
    // open water: at the old 240 m reach every lake ray ran out of budget short of the city and
    // the resolve's (traced - analytic) delta collapsed to zero, so the harbour rendered as flat
    // black. The march grows geometrically (x1.16/step), so 42 steps reach ~2.1 km for the same
    // near-field precision that made wet streets work — measured cost at 1440x900 is nil.
    this.ssr = { maxDistance: 1400, steps: 42, thickness: 1.3, stride: 0.6, intensity: 1.0 };
    this.post = { streak: 0.5, grain: 0.026, chroma: 0.0032, vignette: 0.30 };

    // THE ROAD SURFACE. Asphalt is a rough mineral aggregate, not a mirror — see the "asphalt is
    // not glass" block in SCENE_FS for what each of these does and why the old blanket 0.18 read
    // as a polished sheet. Tunable live: `G.renderer.road.wetness = 0.8` for a downpour, 0 for a
    // dry August night. Every one of them is multiplied by (1 - daylight) at the point of use, so
    // Afternoon cannot be moved by any of it.
    this.road = {
      // Fraction of the carriageway carrying a film of standing water. 0.42 is "it rained an hour
      // ago": the gutter lines and the low side of the crown are wet, the crowns are not.
      wetness: 0.42,
      dryRough: 0.55,    // bituminous aggregate — broad sheen, no SSR (its gate closes by 0.30)
      wetRough: 0.11,    // standing water — sharper than the old blanket value, so wet is WETTER
      // How far the dry sheen is stretched along the direction of travel: the ratio between the
      // two in-plane roughnesses is (1 + 2.6 * aniso)^2, so 0.30 is a 3.2:1 stretch.
      //
      // FITTED against the pool it is allowed to flatten. Walking north on University Avenue at
      // Night, sampling the road at the player's feet every 4 m along a 30 m lamp run, the ratio
      // of the luma directly under a mast to the luma at mid-span runs
      //   aniso 0.00 -> 4.9x     0.20 -> 4.6x     0.30 -> 4.4x     0.45 -> 3.4x     0.62 -> 1.6x
      // and past about 0.45 the streak stops being a sheen on a road and becomes a second, flat,
      // bright field — which is the varnished-sheet look this whole block exists to remove. 0.30
      // is the most stretch the pools survive.
      aniso: 0.30,
    };

    // THE LOCAL LIGHT RIG. Feed it with setLights(); see that method for the shape. Everything
    // here is a dial over what setLights() registered, and none of it decides WHEN the lamps are
    // on — env.nightFactor and env.daylight do (CONTRACT Amendment 7).
    //
    //   max          lights uploaded per frame, capped by LIGHT_MAX. The per-FRAGMENT bound is
    //                LIGHT_SLOTS (16) and is unaffected by this.
    //   gain         master multiplier on every registered light's power
    //   radiusScale  master multiplier on every registered light's influence radius
    //
    // The powers in LIGHT_KINDS are a FIT, not a guess. Measured at Night on University Avenue,
    // sampling the road at the player's own feet (the only sampling geometry in which nothing can
    // get between the camera and the surface), a 9.5 m sodium cobra lays a pool of 42 luma
    // directly beneath it against 9 luma at mid-span of a 30 m run and 1.3 luma with the rig
    // switched off. A 4.4:1 maximum-to-minimum ratio along the run is what IES arterial practice
    // actually specifies (3:1 to 6:1), and it is the same order as this build's measured 3.4:1
    // sun/shade ratio at Afternoon — a pool at night is the night's version of a sunlit face.
    this.lights = { max: LIGHT_MAX, gain: 1.0, radiusScale: 1.0 };

    // What the rig actually did this frame. Read it, do not write it.
    //   registered  lights setLights() is holding
    //   candidates  lights the broadphase handed the ranker for this camera
    //   uploaded    lights that made the per-frame cap
    //   binned      (cell, slot) entries written into the cluster grid
    //   dropped     stamps refused because a cell was already full
    //   maxCell     the fullest cell's occupancy, out of LIGHT_SLOTS
    //   ms          wall-clock cost of the whole update, milliseconds
    this.lightStats = {
      registered: 0, candidates: 0, uploaded: 0, binned: 0, dropped: 0, maxCell: 0, ms: 0,
    };

    // Feature latches. Each one flips to false the first time its setup fails, so a broken
    // driver costs one warning for the session, not one per frame.
    this._postSupported = true;      // any offscreen target at all
    this._bloomSupported = true;
    this._textSupported = true;
    this._ssaoSupported = true;
    this._ssrSupported = true;
    this._fxaaSupported = true;
    this._lightsSupported = true;
    this._shadowSupported = true;
    this._depthTexSupported = true;  // depth attachment as a sampleable TEXTURE
    this._mrtSupported = true;       // second colour attachment (normal / roughness / ambient)
    this._floatProbed = false;
    this._float = false;
    this._warned = {};

    this._post = {
      ready: false, sig: '', w: 0, h: 0, encode: false,
      scene: null, mat: null, depthTex: null, depthRb: null, resolve: null,
      aoA: null, aoB: null, ssr: null, streakA: null, streakB: null, ldr: null,
      levels: [], useAo: false, useSsr: false, useBloom: false, useFxaa: false,
    };
    // The light store. `n` lights in parallel arrays (structure-of-arrays: the gather touches
    // position and power and nothing else, and this keeps that scan in two cache lines), a static
    // uniform-grid broadphase built once by setLights(), and the two per-frame staging buffers
    // that become the GPU tables. Nothing here is reallocated per frame.
    this._lights = {
      n: 0,
      px: null, py: null, pz: null, lr: null, pw: null,
      cr: null, cg: null, cb: null, cone: null,
      // Static broadphase over the whole registered set.
      bx0: 0, bz0: 0, bnx: 0, bnz: 0, bStart: null, bItems: null,
      // Per-frame staging.
      data: new Float32Array(LIGHT_MAX * 2 * 4),
      grid: new Uint16Array(LIGHT_GRID_N * LIGHT_SLOTS * LIGHT_GRID_N),
      cand: new Int32Array(LIGHT_CAND),
      score: new Float64Array(LIGHT_CAND),
      ord: [],
      cmp: null,
      // Where this frame's window landed, and how much of it is live.
      ox: 0, oz: 0, count: 0,
      dataTex: null, gridTex: null, ready: false,
    };
    this._lights.cmp = (a, b) => this._lights.score[b] - this._lights.score[a];

    this._shadowState = {
      ready: false, sig: '', size: 0, count: 0, atlasW: 0, atlasH: 0,
      tex: null, fbo: null, tiles: null,
    };
    this._shadowFar = 2200;
    this._dummyShadow = null;

    // What _fitCascades actually landed on this frame: the far distance of each cascade, the
    // world size of one of its shadow texels, the radius of the sphere it was fitted to, and the
    // worst texel-per-pixel step between consecutive cascades. Read it, do not write it.
    this.shadowStats = {
      count: 0, reach: 0, worstRatio: 0,
      split: new Float64Array(MAX_CASCADES),
      texel: new Float64Array(MAX_CASCADES),
      radius: new Float64Array(MAX_CASCADES),
    };

    // Latched at beginFrame so flipping quality mid-frame can never strand the scene in an
    // offscreen target that endFrame then refuses to composite.
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    this._csmCount = 0;
    this._shadowDone = false;

    // Shadow casters. Explicit ones win; otherwise the renderer remembers what was drawn opaque
    // last frame and casts from that, so shadows work even if main.js never registers anything.
    this._casters = null;
    this._castersSrc = null;
    this._autoA = { list: [], n: 0 };
    this._autoB = { list: [], n: 0 };

    // Modules that own geometry subscribe here to re-upload it after a context loss.
    this._restoreHandlers = [];

    // Environment. Fixed at Toronto blue hour, ~20:45 in June (CONTRACT §0): the sun is BELOW
    // the horizon in the WNW, so `sunDir` only sets where the afterglow sits and `keyDir` is the
    // low raking skylight that actually casts the shadows.
    this.env = {
      // How much of the DAYLIGHT model is in play: 0 = blue hour / night (the default and the
      // benchmark look), 1 = full sun. main.js's TIME_PRESETS set it per time of day. At 0 every
      // daylight code path in every shader is an exact no-op.
      daylight: 0,
      // Daylight exposure, in stops of scene light per unit of display signal. Only ever read
      // inside vhDayTone, which is skipped entirely at daylight 0.
      exposure: 1,
      sunDir: vec3(-0.864, -0.070, -0.499),     // azimuth ~300 degrees, 4 degrees below horizon
      keyDir: vec3(-0.845, 0.225, -0.487),      // same bearing, 13 degrees up: long raking shadows
      keyColor: vec3(0.44, 0.33, 0.25),         // warm afterglow on west-facing facades
      skyZenith: vec3(0.042, 0.072, 0.170),     // deep indigo overhead
      skyHorizon: vec3(0.150, 0.290, 0.410),    // cyan band
      skyWest: vec3(0.640, 0.300, 0.120),       // warm orange where the sun went down
      ambientSky: vec3(0.146, 0.188, 0.268),    // cool skylight, the rough-surface env fallback
      ambientGround: vec3(0.052, 0.058, 0.071), // dark bounce from wet asphalt
      // Sodium and cool-LED street lamps washing the bottom few metres of every facade. This is
      // what makes brick, limestone and painted stucco legible at eye level; without it the only
      // thing lighting a wall at street level is a sky it can barely see.
      streetColor: vec3(0.150, 0.108, 0.062),
      // Gain on the directional sky irradiance. Blue hour is the ONE time of day when the sky is
      // the whole key light, so this term has to carry the facade colours by itself — at the old
      // flat-constant strength every unlit surface collapsed to near-black and all 33 surveyed
      // colours in the dataset were invisible. Calibrated against the albedo band city.js emits
      // (0.021 for a black facade up to ~0.25 for white): at 1.85 every surveyed material lands
      // on a distinct screen colour — gold, Mies black, red granite, teal glass, firebrick,
      // limestone — while a black facade stays black, because the albedo does that work, not the
      // ambient. Pushing it much past 2.3 buys almost nothing and starts washing the shadows.
      skyBounce: 1.85,
      fogColor: vec3(0.098, 0.152, 0.212),
      fogDensity: 0.0011,
      fogHeight: 55,        // scale height (m): the street grid hazes, the towers rise clear
      fogBase: 4,           // world Y the density is measured at
      fogMax: 0.94,
      // AERIAL PERSPECTIVE and the HORIZON CLOSER (vhFogAmount terms 2 and 3). These are metres
      // of SIGHTLINE, not of world, so nothing here is tied to the bounding box: extend the
      // extract and the same numbers still say "the mid-distance is clear, the horizon is shut".
      // main.js's TIME_PRESETS may override them per preset like any other env field, and
      // writeEnv() carries them through untouched when a preset does not mention them, which is
      // why all four currently share one air.
      //
      // The visual range is the Koschmieder figure — the distance at which a black object falls
      // to 2% contrast — and 40 km is a clear, dry Toronto summer afternoon. It is the ONE knob
      // that says how far you can see, and _fogBeta() multiplies it by env.daylight, so it is
      // identically zero at Blue hour and at Night.
      fogVisualRange: 40000,
      // The horizon closer and the window the cap — and with it the horizon weld — opens over.
      // Both moved in from the 4,200 / 4,900 / 7,000 / 15,000 the pre-expansion build shipped:
      // the closer starts earlier so there is aerial depth past 4 km at Blue hour and Night,
      // where the daylight term is identically zero, and the cap window is now wide enough that
      // the weld arrives as a ten-kilometre gradient instead of an eighteen-scanline band.
      //
      // MEASURED cost of moving all four, against the shipped values, grain off, whole frame:
      //
      //   street level, every preset          0 pixels differ by more than 2/255
      //   the lake postcard, Blue hour        mean 0.09/255; 0.96% of pixels over 2, 0.34% over 8
      //   over the Islands, Blue hour         mean 0.35/255; 4.1% over 2, 2.4% over 8, 0% over 32
      //   the north-west corner, Blue hour    mean 0.14/255; 1.8% over 2, 0.93% over 8
      //
      // The handful of pixels that move a long way — 0.08% of the postcard at worst — are
      // single-pixel lit windows four to six kilometres out crossing the bloom threshold, which
      // is a sampling event, not a drift in the preset.
      fogRange: 3000,       // sightline (m) at which the horizon closer starts to accumulate
      fogRangeSpan: 5200,   // metres of EXCESS range that add one unit of optical depth
      fogHorizon: 3000,     // where fogMax starts giving way so the air may close completely
      fogHorizonEnd: 13000, // and where it has given way entirely — inside the far plane
      nightFactor: 0.86,
      // How much brighter a GENUINE luminaire (emissive >= 0.50 — city.js and props.js both call
      // it EMITTER_MIN) is than the lit window pane beside it. Before this existed they were the
      // same brightness, because both went through mix(col, glow, e) and that expression cannot
      // take anything past its own albedo. A lamp lens is a light source and a window is a lit
      // room seen through glass; they are not the same order of magnitude and it shows.
      //
      // Applied through the same (1 - daylight) * nightFactor gate as the rest of the emissive
      // rig, so it is exactly 0 at Afternoon (CONTRACT Amendment 7).
      emitterGain: 2.2,
      // Base lit fraction. Each lighting profile scales it (offices up, condos and civic well
      // down — see vhFacadeStyle), so this is a master dial rather than a literal percentage.
      // It came DOWN from 0.62: the old build lit so much of every wall, in one narrow amber,
      // that the city read as wallpaper instead of as buildings.
      windowLit: 0.50,
      windowGain: 1.45,     // brightness of interior light, ~0.6x what it used to be
      cloudAmount: 0.55,
      cloudCover: 0.52,
      starAmount: 0.55,
      time: 0,
      shadowColor: vec3(0.20, 0.23, 0.32),
      // The CN Tower's own axis: xz = world position of the massing centroid, y = the base the
      // city.js lathe is built from (record base 6.3 m less the 0.6 m sink), w = the radius the
      // LED wash is masked to. Ripley's Aquarium is the nearest other structure at 36 m, so 34
      // covers the 30 m base flare and still cannot leak onto a neighbour.
      cnTower: new Float32Array([114.2, 159.0, 5.7, 34.0]),
    };

    // Tracked GL state — every setter below is a no-op when nothing actually changed.
    this._shader = null;
    this._vao = null;
    this._blend = false;
    this._blendMode = 0;
    this._depthTest = false;
    this._depthWrite = false;
    this._cull = false;
    this._polyOffset = false;

    // Cached scalar uniforms (uniform values are per-program GL state, so these survive program
    // switches and only need invalidating when the programs are (re)created).
    this._tr = -1; this._tg = -1; this._tb = -1;
    this._flash = -1;
    this._alpha = -1;
    this._shadowAlpha = -1;

    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;

    this._q = {
      shadows: 'off', ssao: false, ssr: false, bloom: false, clouds: false, fxaa: false,
      lights: false,
    };

    this._createGpuResources();

    // --- context loss: fail quiet, log exactly once per event ---------------
    const canvas = gl.canvas;
    this._canvas = canvas;
    this._onLost = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (this.contextLost) return;
      this.contextLost = true;
      console.warn('[render] WebGL context lost — rendering paused until it is restored.');
    };
    this._onRestored = () => {
      if (!this.contextLost) return;
      try {
        // The old framebuffers/textures belong to the DEAD context. Deleting them through the
        // fresh one is invalid, so drop the handles instead of calling gl.delete*.
        this._forgetTargets();
        this._forgetShadowTargets();
        this._dummyShadow = null;
        // The glyph atlas is a texture in the DEAD context. Forget the handle rather than
        // deleting it — deleting through the fresh context is invalid — so _createGpuResources
        // below rasterises a new one.
        forgetFont(gl);
        // Extension objects are per-context too: without asking again, RGBA16F is not colour
        // renderable on the new context and the post chain would silently drop to 8-bit.
        this._floatProbed = false;
        this._float = false;
        this._createGpuResources();
        this._resetStateCache();
      } catch (err) {
        this._reportUnrecoverableLoss('the renderer could not rebuild its shaders', err);
        return;
      }

      // Renderer-owned GPU state is back — but a context loss takes EVERY GL object in the
      // process with it, and every Mesh in the world lives in another module's VBO. Only their
      // owners can put those back, which is what onContextRestored() is for.
      let rebuilt = 0;
      const hs = this._restoreHandlers.slice();
      for (let i = 0; i < hs.length; i++) {
        try {
          if (hs[i](this) !== false) rebuilt++;
        } catch (err) {
          console.warn('[render] a context-restore handler threw: ' + errText(err));
        }
      }
      if (rebuilt === 0) {
        this._reportUnrecoverableLoss(
          hs.length === 0
            ? 'nothing is subscribed to renderer.onContextRestored, so the world geometry is gone'
            : 'every registered context-restore handler failed',
          null
        );
        return;
      }

      // Meshes are new objects: anything the auto-caster list remembers is a dead handle.
      this._autoA.n = 0;
      this._autoB.n = 0;
      this._castN = 0;
      this.contextLost = false;
      console.warn('[render] WebGL context restored; ' + rebuilt + ' module(s) re-uploaded their geometry.');
    };
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this._onLost, false);
      canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    }
  }

  /* -------------------------------------------------------- context restore */

  // Subscribe to WebGL context restoration. A handler is called with `(renderer)`; return
  // `false` to say "I could not rebuild". Returns an unsubscribe function.
  //
  // If NOTHING is subscribed, or every handler fails, the renderer does NOT report a successful
  // restore over an empty world: it stays in the lost state, sets `needsReload = true`, and
  // surfaces the failure through window.VH_SHELL.showError so the player is told to reload.
  onContextRestored(fn) {
    if (typeof fn !== 'function') return () => {};
    this._restoreHandlers.push(fn);
    return () => {
      const i = this._restoreHandlers.indexOf(fn);
      if (i >= 0) this._restoreHandlers.splice(i, 1);
    };
  }

  // The context came back but the scene cannot be: say so, loudly and exactly once, and leave
  // `contextLost` set so nothing touches the dead handles. Never throws — it runs from an event
  // handler and inside a catch block.
  _reportUnrecoverableLoss(reason, err) {
    this.contextLost = true;
    this.needsReload = true;
    const detail = reason + (err ? (': ' + errText(err)) : '');
    console.warn('[render] WebGL context restored, but the scene cannot be rebuilt — ' + detail +
      '. A page reload is required.');
    try {
      // index.html owns the loading/error shell and names its global; try the ones it has used.
      const w = (typeof window !== 'undefined') ? window : null;
      const shell = w ? (w.SHELL || w.VH_SHELL || w.TO_SHELL || null) : null;
      if (shell && typeof shell.showError === 'function') {
        shell.showError(
          'The graphics context was lost.',
          'The GPU dropped this page\'s WebGL context and took the world geometry with it (' +
          detail + ').\n\nReload the page to get back into downtown Toronto.'
        );
      }
    } catch (e) {
      // Reporting is best-effort; a missing or unhappy shell must not make this worse.
    }
  }

  // One warning per reason per session, and the feature latches off for good.
  _fail(key, reason, err) {
    if (!this._warned[key]) {
      this._warned[key] = true;
      console.warn('[render] ' + key + ' disabled (' + reason + (err ? ': ' + errText(err) : '') + ').');
    }
  }

  /* ------------------------------------------------------------- resources */

  _createGpuResources() {
    const gl = this.gl;

    // Required: without these there is nothing to look at, so a failure here is fatal and the
    // caller (main.js boot) reports it.
    this.sceneShader = new Shader(gl, SCENE_VS, SCENE_FS);
    this.skyShader = new Shader(gl, SKY_VS, SKY_FS);
    this.waterShader = new Shader(gl, WATER_VS, WATER_FS);
    this.gshadowShader = new Shader(gl, GSHADOW_VS, GSHADOW_FS);

    // A VAO with zero enabled attribute arrays — the sky triangle and every post pass generate
    // their vertices from gl_VertexID and need no vertex data at all.
    this.skyVao = gl.createVertexArray();

    // Everything below is optional by construction: if any of it refuses to compile on some
    // driver, that feature turns itself off and the game still boots and renders.
    this.csmShader = null;
    this.textShader = null;
    this.font = null;
    this.brightShader = null;
    this.blurShader = null;
    this.compShader = null;
    this.ssaoShader = null;
    this.aoBlurShader = null;
    this.ssrShader = null;
    this.resolveShader = null;
    this.fxaaShader = null;

    if (this._shadowSupported) {
      try {
        this.csmShader = new Shader(gl, CSM_VS, CSM_FS);
      } catch (err) {
        this._shadowSupported = false;
        this._fail('shadows', 'the depth-only shader would not compile', err);
      }
    }
    // Text. Optional like everything else here: a platform with no 2-D canvas, or a driver that
    // will not take the atlas, loses signage and keeps the city.
    if (this._textSupported) {
      try {
        this.font = getFont(gl);
        if (!this.font || !this.font.texture) throw new Error('the glyph atlas could not be built');
        this.textShader = new Shader(gl, TEXT_VS, TEXT_FS);
      } catch (err) {
        if (this.textShader) {
          try { this.textShader.dispose(); } catch (e) { /* best effort */ }
        }
        this.textShader = null;
        this.font = null;
        this._textSupported = false;
        this._fail('text', 'the world-text pass could not be built', err);
      }
    }
    if (this._bloomSupported) {
      try {
        this.brightShader = new Shader(gl, POST_VS, BRIGHT_FS);
        this.blurShader = new Shader(gl, POST_VS, BLUR_FS);
        this.compShader = new Shader(gl, POST_VS, COMP_FS);
      } catch (err) {
        this._bloomSupported = false;
        this._fail('bloom', 'post shaders would not compile', err);
      }
    }
    // The composite is also what grades the frame when SSAO/SSR run without bloom, so if it is
    // missing there is no offscreen path at all.
    if (!this.compShader) {
      this._postSupported = false;
    }
    if (this._ssaoSupported && this._postSupported) {
      try {
        this.ssaoShader = new Shader(gl, POST_VS, SSAO_FS);
        this.aoBlurShader = new Shader(gl, POST_VS, AOBLUR_FS);
      } catch (err) {
        this._ssaoSupported = false;
        this._fail('ssao', 'the SSAO shaders would not compile', err);
      }
    }
    if (this._ssrSupported && this._postSupported) {
      try {
        this.ssrShader = new Shader(gl, POST_VS, SSR_FS);
      } catch (err) {
        this._ssrSupported = false;
        this._fail('ssr', 'the SSR shader would not compile', err);
      }
    }
    if ((this._ssaoSupported || this._ssrSupported) && this._postSupported) {
      try {
        this.resolveShader = new Shader(gl, POST_VS, RESOLVE_FS);
      } catch (err) {
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fail('ssao/ssr', 'the resolve shader would not compile', err);
      }
    }

    if (this._fxaaSupported && this._postSupported) {
      try {
        this.fxaaShader = new Shader(gl, POST_VS, FXAA_FS);
      } catch (err) {
        this._fxaaSupported = false;
        this._fail('fxaa', 'the FXAA shader would not compile', err);
      }
    }

    this._makeDummyShadow();
    // The light tables are GPU textures and a context loss takes them with it. The handles are
    // dropped rather than deleted — deleting through the fresh context is invalid — and remade.
    if (this._lights) {
      this._lights.dataTex = null;
      this._lights.gridTex = null;
      this._lights.ready = false;
      this._lights.count = 0;
      this._makeLightTables();
    }

    this._shader = null;
    this._vao = null;
    this._tr = -1; this._tg = -1; this._tb = -1;
    this._flash = -1;
    this._alpha = -1;
    this._shadowAlpha = -1;
    // Uniform values are per-PROGRAM GL state, so the text pass keeps its own cache rather than
    // sharing the scene pass's and believing a value the other program set.
    this._txTr = -1; this._txTg = -1; this._txTb = -1;
    this._txAlpha = -1;
  }

  // A 2x2 depth texture with comparison filtering, bound to uShadowMap whenever the real atlas
  // does not exist. Sampling never happens (uCsmCount is 0), but leaving a shadow sampler
  // pointing at an incomplete texture makes some drivers noisy, and this costs 16 bytes.
  _makeDummyShadow() {
    const gl = this.gl;
    try {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 2, 2, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._dummyShadow = tex;
    } catch (err) {
      this._dummyShadow = null;
    }
  }

  /* -------------------------------------------------------- local lights */

  // The two GPU tables the clustered rig reads. Both are tiny and both are rewritten every frame,
  // so they are created ONCE at whatever size the LIGHT_* constants ask for and never resized.
  //
  //   uLightData  RGBA32F, LIGHT_MAX x 2. Row 0 is (x, y, z, radius); row 1 is (r, g, b, cutoff)
  //               with rgb already multiplied by the light's power. Float, because a position
  //               anywhere in a 6.8 km extract quantises to ~4 m in half-float and that would put
  //               every pool in the wrong place. Sampled with texelFetch and NEAREST only, which
  //               is core WebGL2 — no EXT_color_buffer_float, no OES_texture_float_linear.
  //   uLightGrid  R16UI, (LIGHT_GRID_N * LIGHT_SLOTS) x LIGHT_GRID_N. One texel per (cell, slot),
  //               holding the light index PLUS ONE so that 0 can mean "end of this cell's list".
  //
  // 16 KB and 32 KB respectively. If either refuses to allocate the rig latches off for the
  // session and the city renders exactly as it did before it existed.
  _makeLightTables() {
    if (!this._lightsSupported) return false;
    const gl = this.gl;
    const S = this._lights;
    if (S.dataTex && S.gridTex) return true;
    try {
      // Drain any error another module left on the context, so the check below can only ever be
      // reporting on these two allocations.
      while (gl.getError() !== gl.NO_ERROR) { /* discard */ }
      const data = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LIGHT_MAX, 2, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const grid = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, grid);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, LIGHT_GRID_N * LIGHT_SLOTS, LIGHT_GRID_N, 0,
        gl.RED_INTEGER, gl.UNSIGNED_SHORT, null);
      // Integer textures may only ever be filtered NEAREST; anything else is incomplete.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(data);
        gl.deleteTexture(grid);
        throw new Error('the driver would not allocate an RGBA32F or R16UI table');
      }
      S.dataTex = data;
      S.gridTex = grid;
      return true;
    } catch (err) {
      this._lightsSupported = false;
      S.dataTex = null;
      S.gridTex = null;
      this._fail('lights', 'the local-light tables could not be allocated', err);
      return false;
    }
  }

  /**
   * Register the city's LOCAL LIGHTS — every street lamp, shopfront and signal that should throw
   * light onto the world rather than merely glow. This REPLACES whatever was registered before.
   *
   * The renderer owns culling, ranking, clustering and the per-frame cap, so a caller hands over
   * the whole city ONCE (after the data loads, not per tile and not per frame) and never thinks
   * about it again. 1,403 surveyed lamps costs 64 KB of index and about 30 microseconds to build.
   *
   * Two accepted shapes:
   *
   *   1. An array of objects. `x`, `y`, `z` are world metres and are the only required fields.
   *        { x, y, z,
   *          kind:   one of 'cobra' | 'led' | 'acorn' | 'ped' | 'shop' | 'signal' | 'tunnel'
   *                  (plus the aliases in LIGHT_KIND_INDEX), or the numeric index. Default cobra.
   *          color:  [r, g, b] overriding the kind's colour
   *          power:  scene-linear radiance at one metre, overriding the kind's
   *          radius: influence radius in metres, overriding the kind's
   *          cone:   0 = a bare globe .. 1 = a full-cutoff head, overriding the kind's }
   *
   *   2. A flat numeric array (typed arrays welcome) of STRIDE 4: x, y, z, kindIndex. This is the
   *      shape to use at full-city scale — 130,000 lamps is a 2 MB Float32Array.
   *
   * Positions should be the LENS, not the base of the mast: a cobra head sits ~9.5 m up and 2 m
   * out over the carriageway, and putting the light at the foot of the post lights the post.
   *
   * Returns the number of lights accepted.
   */
  setLights(list) {
    const S = this._lights;
    S.n = 0;
    S.count = 0;
    S.ready = false;
    this.lightStats.registered = 0;
    if (!list || typeof list !== 'object') return 0;

    const flat = (typeof list[0] === 'number') || ArrayBuffer.isView(list);
    const n = flat ? Math.floor(list.length / 4) : (list.length | 0);
    if (!(n > 0)) return 0;

    const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
    const lr = new Float32Array(n), pw = new Float32Array(n);
    const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
    const cone = new Float32Array(n);
    let m = 0;

    for (let i = 0; i < n; i++) {
      let x, y, z, ki, col = null, power = NaN, radius = NaN, cn = NaN;
      if (flat) {
        const o = i * 4;
        x = +list[o]; y = +list[o + 1]; z = +list[o + 2];
        ki = list[o + 3] | 0;
      } else {
        const L = list[i];
        if (!L) continue;
        x = +L.x; y = +L.y; z = +L.z;
        const k = (L.kind !== undefined) ? L.kind : L.k;
        ki = (typeof k === 'number') ? (k | 0)
          : (typeof k === 'string' && LIGHT_KIND_INDEX[k] !== undefined ? LIGHT_KIND_INDEX[k] : 0);
        // isArrayLike() up top demands four entries (it guards matrices and vec4 uniforms); a
        // colour is three, so the test is written out here rather than reused.
        const rgb = (v) => (v !== null && typeof v === 'object' && v.length >= 3) ? v : null;
        col = rgb(L.color) || rgb(L.c);
        power = +(L.power !== undefined ? L.power : L.p);
        radius = +(L.radius !== undefined ? L.radius : L.r);
        cn = +L.cone;
      }
      // A NaN position would poison the broadphase bounds and take every light with it.
      if (!Number.isFinite(x + y + z)) continue;
      if (ki < 0 || ki >= LIGHT_KINDS.length) ki = 0;
      const K = LIGHT_KINDS[ki];
      const p = numOr(power, 0, 100000, K.power);
      const c = col || K.color;
      px[m] = x; py[m] = y; pz[m] = z;
      lr[m] = numOr(radius, 0.5, LIGHT_RADIUS_MAX, K.radius);
      pw[m] = p;
      cr[m] = numOr(+c[0], 0, 64, 1) * p;
      cg[m] = numOr(+c[1], 0, 64, 1) * p;
      cb[m] = numOr(+c[2], 0, 64, 1) * p;
      cone[m] = numOr(cn, 0, 1, K.cone);
      m++;
    }

    S.px = px; S.py = py; S.pz = pz; S.lr = lr; S.pw = pw;
    S.cr = cr; S.cg = cg; S.cb = cb; S.cone = cone;
    S.n = m;
    this.lightStats.registered = m;
    this._buildLightBroadphase();
    return m;
  }

  /** Forget every registered light. The wash (env.streetColor) is untouched. */
  clearLights() {
    const S = this._lights;
    S.n = 0;
    S.count = 0;
    S.ready = false;
    S.bStart = null;
    S.bItems = null;
    this.lightStats.registered = 0;
  }

  // A counting-sort uniform grid over the whole registered set, built once. The per-frame gather
  // only ever asks it for a window-sized box, so the cell is coarse (LIGHT_BROAD_CELL) and the
  // whole structure is two typed arrays with no per-cell objects. O(n), and linear in the light
  // count exactly as CONTRACT §8.4 requires of everything that has to reach the full city.
  _buildLightBroadphase() {
    const S = this._lights;
    const n = S.n;
    S.bStart = null;
    S.bItems = null;
    if (n <= 0) return;

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = S.px[i], z = S.pz[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cell = LIGHT_BROAD_CELL;
    const nx = Math.max(1, Math.min(4096, Math.ceil((x1 - x0) / cell) + 1));
    const nz = Math.max(1, Math.min(4096, Math.ceil((z1 - z0) / cell) + 1));
    const cells = nx * nz;
    const counts = new Int32Array(cells + 1);
    const idx = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const ci = clamp(Math.floor((S.px[i] - x0) / cell), 0, nx - 1);
      const cj = clamp(Math.floor((S.pz[i] - z0) / cell), 0, nz - 1);
      const c = cj * nx + ci;
      idx[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(n);
    const cursor = new Int32Array(cells);
    for (let i = 0; i < n; i++) {
      const c = idx[i];
      items[counts[c] + cursor[c]] = i;
      cursor[c]++;
    }

    S.bx0 = x0; S.bz0 = z0; S.bnx = nx; S.bnz = nz;
    S.bStart = counts;
    S.bItems = items;
  }

  // Per frame: pick the window, gather, rank, cluster, upload. Called from beginFrame, before
  // anything can ask for the scene uniforms.
  _updateLights() {
    const S = this._lights;
    const st = this.lightStats;
    st.candidates = 0; st.uploaded = 0; st.binned = 0; st.dropped = 0; st.maxCell = 0; st.ms = 0;
    S.count = 0;
    S.ready = false;
    const cam = this.camera;
    if (!this._q.lights || S.n <= 0 || !cam || !S.bStart) return;
    // The rig is dark at Afternoon, so there is nothing to cull, rank, cluster or upload. This is
    // what makes the daylight path an exact no-op on the CPU as well as in the shader.
    if (this._lightRigLevel() <= 0.002) return;
    if (!this._makeLightTables()) return;

    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();

    // The window is SNAPPED to the cluster grid. Without the snap every fragment's cell index
    // would shift by a sub-cell amount each frame and a pool's edge would crawl.
    const span = LIGHT_GRID_N * LIGHT_CELL;
    const cx = Number.isFinite(cam.pos[0]) ? cam.pos[0] : 0;
    const cz = Number.isFinite(cam.pos[2]) ? cam.pos[2] : 0;
    const cy = Number.isFinite(cam.pos[1]) ? cam.pos[1] : 0;
    const ox = Math.floor((cx - span * 0.5) / LIGHT_CELL) * LIGHT_CELL;
    const oz = Math.floor((cz - span * 0.5) / LIGHT_CELL) * LIGHT_CELL;
    S.ox = ox;
    S.oz = oz;

    // Gather. The box is grown by LIGHT_RADIUS_MAX so a lamp just outside the window still lights
    // the strip of ground inside it, which is what stops a seam appearing at the window edge.
    const pad = LIGHT_RADIUS_MAX;
    const bcell = LIGHT_BROAD_CELL;
    const i0 = clamp(Math.floor((ox - pad - S.bx0) / bcell), 0, S.bnx - 1);
    const i1 = clamp(Math.floor((ox + span + pad - S.bx0) / bcell), 0, S.bnx - 1);
    const j0 = clamp(Math.floor((oz - pad - S.bz0) / bcell), 0, S.bnz - 1);
    const j1 = clamp(Math.floor((oz + span + pad - S.bz0) / bcell), 0, S.bnz - 1);

    const cand = S.cand;
    const score = S.score;
    let nc = 0;
    const xLo = ox - pad, xHi = ox + span + pad;
    const zLo = oz - pad, zHi = oz + span + pad;
    for (let j = j0; j <= j1 && nc < LIGHT_CAND; j++) {
      const row = j * S.bnx;
      for (let i = i0; i <= i1 && nc < LIGHT_CAND; i++) {
        const c = row + i;
        const s0 = S.bStart[c], s1 = S.bStart[c + 1];
        for (let k = s0; k < s1 && nc < LIGHT_CAND; k++) {
          const li = S.bItems[k];
          const x = S.px[li], z = S.pz[li];
          if (x < xLo || x > xHi || z < zLo || z > zHi) continue;
          const dx = x - cx, dy = S.py[li] - cy, dz = z - cz;
          // Rank by apparent brightness at the eye, not by distance: an arterial cobra head 200 m
          // down the street contributes more to the image than a shopfront spill 40 m behind the
          // camera. The 400 m^2 pedestal stops the nearest lamp from owning the whole ranking.
          cand[nc] = li;
          score[nc] = S.pw[li] / (dx * dx + dy * dy + dz * dz + 400);
          nc++;
        }
      }
    }
    st.candidates = nc;
    if (nc === 0) return;

    const cfg = this.lights || {};
    const cap = Math.min(LIGHT_MAX, Math.max(0, numOr(cfg.max, 0, LIGHT_MAX, LIGHT_MAX) | 0));
    if (cap === 0) return;
    const gainR = numOr(cfg.radiusScale, 0.1, 4, 1);

    // Rank. The order is also the cluster slot priority, so when a cell overflows it is the
    // dimmest lights in it that are dropped and never the nearest.
    const ord = S.ord;
    ord.length = nc;
    for (let i = 0; i < nc; i++) ord[i] = i;
    ord.sort(S.cmp);
    const take = Math.min(cap, nc);

    // Stage the parameter table. Row 0 at [0, LIGHT_MAX*4), row 1 immediately after it.
    const data = S.data;
    const row1 = LIGHT_MAX * 4;
    for (let s = 0; s < take; s++) {
      const li = cand[ord[s]];
      const o = s * 4;
      data[o] = S.px[li];
      data[o + 1] = S.py[li];
      data[o + 2] = S.pz[li];
      data[o + 3] = S.lr[li] * gainR;
      data[row1 + o] = S.cr[li];
      data[row1 + o + 1] = S.cg[li];
      data[row1 + o + 2] = S.cb[li];
      data[row1 + o + 3] = S.cone[li];
    }

    // Cluster. Every light is stamped into the cells its disc actually covers — at radius 32 m
    // over 28 m cells that is at most 3 x 3, so the whole pass is a few thousand writes.
    const grid = S.grid;
    grid.fill(0);
    const inv = 1 / LIGHT_CELL;
    let binned = 0, dropped = 0, maxCell = 0;
    for (let s = 0; s < take; s++) {
      const li = cand[ord[s]];
      const r = S.lr[li] * gainR;
      const gx0 = Math.floor((S.px[li] - r - ox) * inv);
      const gx1 = Math.floor((S.px[li] + r - ox) * inv);
      const gz0 = Math.floor((S.pz[li] - r - oz) * inv);
      const gz1 = Math.floor((S.pz[li] + r - oz) * inv);
      const ax0 = gx0 < 0 ? 0 : gx0;
      const ax1 = gx1 > LIGHT_GRID_N - 1 ? LIGHT_GRID_N - 1 : gx1;
      const az0 = gz0 < 0 ? 0 : gz0;
      const az1 = gz1 > LIGHT_GRID_N - 1 ? LIGHT_GRID_N - 1 : gz1;
      const id = s + 1;
      for (let gz = az0; gz <= az1; gz++) {
        const base = gz * LIGHT_GRID_N * LIGHT_SLOTS;
        for (let gx = ax0; gx <= ax1; gx++) {
          const cellBase = base + gx * LIGHT_SLOTS;
          let slot = 0;
          while (slot < LIGHT_SLOTS && grid[cellBase + slot] !== 0) slot++;
          if (slot >= LIGHT_SLOTS) { dropped++; continue; }
          grid[cellBase + slot] = id;
          binned++;
          if (slot + 1 > maxCell) maxCell = slot + 1;
        }
      }
    }

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, S.dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHT_MAX, 2, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, S.gridTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHT_GRID_N * LIGHT_SLOTS, LIGHT_GRID_N,
      gl.RED_INTEGER, gl.UNSIGNED_SHORT, grid);
    gl.bindTexture(gl.TEXTURE_2D, null);

    S.count = take;
    S.ready = binned > 0;
    st.uploaded = take;
    st.binned = binned;
    st.dropped = dropped;
    st.maxCell = maxCell;
    st.ms = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()) - t0;
  }

  // The rig's LEVEL, 0..1. nightFactor says how far into the night the preset is and daylight
  // closes the whole thing down under a sun, which together give exactly the Amendment 7 ramp with
  // no new field and nothing baked: Afternoon 0.000, Golden hour 0.099, Blue hour 0.860,
  // Night 1.000.
  _lightRigLevel() {
    const e = this.env;
    return numOr(e.nightFactor, 0, 1, 0.86) * (1 - this._daylight());
  }

  // Cluster uniforms, for any program that shades with local lights. The sampler UNITS are always
  // written even when the rig is dark: leaving two samplers defaulted to unit 0 would put them on
  // the same unit as uShadowMap, and two samplers of different types on one unit is undefined
  // behaviour that some drivers refuse to draw at all.
  _setLightUniforms(s) {
    const S = this._lights;
    const live = S.ready && S.count > 0 && this._q.lights && !!S.dataTex && !!S.gridTex;
    s.setTexture('uLightData', 5, live ? S.dataTex : null);
    s.setTexture('uLightGrid', 6, live ? S.gridTex : null);
    const cfg = this.lights || {};
    _lightWin[0] = S.ox;
    _lightWin[1] = S.oz;
    _lightWin[2] = 1 / LIGHT_CELL;
    _lightWin[3] = numOr(cfg.gain, 0, 32, 1);
    s.set('uLightWindow', _lightWin);
    _lightRig[0] = live ? this._lightRigLevel() : 0;
    _lightRig[1] = live ? 1 : 0;
    s.set('uLightRig', _lightRig);
  }

  // The road surface response, sanitised. `rough` multiplies into the material G-buffer and from
  // there into SSR's gate, so a NaN here would switch screen-space reflections on or off over the
  // whole carriageway for a frame.
  _roadParams() {
    const r = this.road || {};
    _road[0] = numOr(r.wetness, 0, 1, 0.42);
    _road[1] = numOr(r.dryRough, 0.03, 1, 0.55);
    _road[2] = numOr(r.wetRough, 0.03, 1, 0.11);
    _road[3] = numOr(r.aniso, 0, 1, 0.62);
    return _road;
  }

  _resetStateCache() {
    this._blend = false;
    this._blendMode = 0;
    this._depthTest = false;
    this._depthWrite = false;
    this._cull = false;
    this._polyOffset = false;
    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    this._csmCount = 0;
  }

  resize(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
    if (this.contextLost) return;
    this.gl.viewport(0, 0, this.width, this.height);
    // Post targets are sized to the drawing buffer, so they are rebuilt here — old ones deleted
    // FIRST, which is what keeps a window drag (one resize event per frame) from leaking a
    // framebuffer set per event.
    this._resolveQuality();
    this._ensureTargets();
  }

  // Normalize `quality` into `_q` with every unsupported feature already masked out. Called at
  // the top of every frame, so the console can flip any of these between frames.
  _resolveQuality() {
    const q = this.quality || {};
    let sh = q.shadows;
    if (sh === true) sh = 'high';
    else if (sh === false || sh === null || sh === undefined) sh = 'off';
    else sh = String(sh).toLowerCase();
    if (sh !== 'off' && sh !== 'low' && sh !== 'high') sh = 'high';
    if (!this._shadowSupported || !this.csmShader) sh = 'off';

    const out = this._q;
    out.shadows = sh;
    out.clouds = boolOr(q.clouds, true);
    out.bloom = boolOr(q.bloom, true) && this._bloomSupported && this._postSupported &&
      !!(this.bloom && this.bloom.enabled !== false);
    out.ssao = boolOr(q.ssao, true) && this._ssaoSupported && this._postSupported &&
      this._depthTexSupported && this._mrtSupported && !!this.resolveShader;
    out.ssr = boolOr(q.ssr, true) && this._ssrSupported && this._postSupported &&
      this._depthTexSupported && this._mrtSupported && !!this.resolveShader;
    out.fxaa = boolOr(q.fxaa, true) && this._fxaaSupported && this._postSupported &&
      !!this.fxaaShader;
    // The local lights need no offscreen target and no depth texture — they are part of the
    // geometry pass — so they survive every post-chain fallback there is.
    out.lights = boolOr(q.lights, true) && this._lightsSupported;
    return out;
  }

  /* -------------------------------------------------------------- targets */

  // One colour texture + its framebuffer. Returns null (having cleaned up after itself) if the
  // format is not renderable here, which is how the RGBA16F -> RGBA8 fallback is detected.
  _makeTarget(w, h, internalFormat, format, type, filter) {
    const gl = this.gl;
    const f = filter || gl.LINEAR;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    }
    return { fbo, tex, w, h };
  }

  // Drop every handle without touching GL. Used after a context loss, where the objects are
  // already gone and deleting them through the new context would be an error.
  _forgetTargets() {
    const p = this._post;
    p.scene = null; p.mat = null; p.depthTex = null; p.depthRb = null; p.resolve = null;
    p.aoA = null; p.aoB = null; p.ssr = null; p.streakA = null; p.streakB = null; p.ldr = null;
    p.levels = [];
    p.ready = false; p.sig = ''; p.w = 0; p.h = 0;
    p.useAo = false; p.useSsr = false; p.useBloom = false; p.useFxaa = false;
  }

  _destroyTargets() {
    const gl = this.gl;
    const p = this._post;
    if (!p.scene && p.levels.length === 0 && !p.ready) return;
    if (!this.contextLost) {
      try {
        const kill = (t) => {
          if (!t) return;
          if (t.fbo) gl.deleteFramebuffer(t.fbo);
          if (t.tex) gl.deleteTexture(t.tex);
        };
        kill(p.scene); kill(p.resolve); kill(p.aoA); kill(p.aoB); kill(p.ssr);
        kill(p.streakA); kill(p.streakB); kill(p.ldr);
        if (p.mat) gl.deleteTexture(p.mat);
        if (p.depthTex) gl.deleteTexture(p.depthTex);
        if (p.depthRb) gl.deleteRenderbuffer(p.depthRb);
        for (let i = 0; i < p.levels.length; i++) {
          kill(p.levels[i].a);
          kill(p.levels[i].b);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (err) {
        // Deleting into a context that died mid-teardown is not worth a crash.
      }
    }
    this._forgetTargets();
  }

  // Build (or rebuild, on a size or quality change) every offscreen target the current quality
  // settings need. Returns true when the offscreen path is live for this frame.
  //
  // Each sub-feature is allowed to fail on its own: no depth TEXTURE means no SSAO and no SSR
  // but bloom still runs; no second colour attachment means the same; no float colour drops the
  // whole chain to the range-compressed RGBA8 path; and if even that fails the renderer goes
  // back to drawing straight to the screen, graded in-shader.
  _ensureTargets() {
    if (this.contextLost || !this._postSupported) { this._destroyTargets(); return false; }

    for (let attempt = 0; attempt < 4; attempt++) {
      const q = this._q;
      const wantBloom = q.bloom;
      const wantAo = q.ssao;
      const wantSsr = q.ssr;
      const wantFxaa = q.fxaa;
      // NOTE: the offscreen path is kept even when every post feature is off, and this is a
      // PERFORMANCE decision, not a tidiness one.
      //
      // gl.js asks for `antialias: true`, so the default framebuffer is 4x multisampled — this
      // context reports SAMPLES = 4. At every preset that runs the post chain, the only thing
      // ever drawn into that framebuffer is one full-screen composite quad, which costs nothing.
      // Take the chain away and the WHOLE SCENE is shaded into a 4x MSAA surface instead, and
      // the cheapest preset becomes the most expensive one.
      //
      // MEASURED, foreground Chrome on an M1 Pro, 3248 x 1500, the harbour viewpoint, 447 draws:
      //   Minimal straight to the 4x MSAA default framebuffer   16.3 ms   61 fps
      //   Minimal through the offscreen target + one composite    8.7 ms  115 fps
      //   Low     (offscreen, 13 post passes)                     8.8 ms  114 fps
      // So the cheapest rung of the quality ladder was 1.87x the cost of the rung above it —
      // which makes stepping down actively harmful, and the adaptive quality step in main.js
      // depends on the ladder being monotonic. One composite pass over a single-sampled target
      // beats shading the city four times over.
      //
      // The fallback for a GPU with no renderable offscreen format is untouched: _postSupported
      // is false there and this function returns at the top, straight to the in-shader grade.
      // What this preset gives up is the default framebuffer's free MSAA — but Minimal has FXAA
      // off anyway, and 87% of the frame time is not a fair price for it.

      const gl = this.gl;
      const w = Math.max(1, gl.drawingBufferWidth || this.width);
      const h = Math.max(1, gl.drawingBufferHeight || this.height);
      const p = this._post;
      const sig = w + 'x' + h + '|' + (wantBloom ? 'b' : '') + (wantAo ? 'a' : '') +
        (wantSsr ? 's' : '') + (wantFxaa ? 'f' : '');
      if (p.ready && p.sig === sig) return true;

      this._destroyTargets();
      let retry = false;
      try {
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
        if (w > maxTex || h > maxTex) throw new Error('drawing buffer is larger than MAX_TEXTURE_SIZE');

        if (!this._floatProbed) {
          this._floatProbed = true;
          this._float = !!(gl.getExtension('EXT_color_buffer_float') ||
                           gl.getExtension('EXT_color_buffer_half_float'));
        }

        let float = this._float;
        let ifmt = float ? gl.RGBA16F : gl.RGBA8;
        let type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
        let scene = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
        if (!scene && float) {
          float = false;
          ifmt = gl.RGBA8;
          type = gl.UNSIGNED_BYTE;
          this._float = false;
          scene = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
        }
        if (!scene) throw new Error('no renderable colour format for the scene target');
        p.scene = scene;
        p.encode = !float;

        const wantGBuffer = wantAo || wantSsr;
        gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);

        // --- second colour attachment: oct normal, roughness, ambient share ---
        if (wantGBuffer && this._mrtSupported) {
          const mat = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mat);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, mat, 0);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.deleteTexture(mat);
            this._mrtSupported = false;
            this._fail('ssao/ssr', 'this driver will not attach a second colour target');
            retry = true;
          } else {
            p.mat = mat;
          }
        } else {
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        }

        // --- depth: a TEXTURE when anything wants to read it, else a renderbuffer ---
        if (!retry) {
          let depthOk = false;
          if (wantGBuffer && this._depthTexSupported) {
            const dt = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, dt);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0,
              gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
            // Depth textures are NOT filterable in WebGL2 unless sampled through a shadow
            // sampler, so NEAREST is mandatory here.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dt, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
              p.depthTex = dt;
              depthOk = true;
            } else {
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
              gl.deleteTexture(dt);
              this._depthTexSupported = false;
              this._fail('ssao/ssr', 'this driver will not attach a depth texture');
              retry = true;
            }
          }
          if (!depthOk && !retry) {
            const rb = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
              gl.deleteRenderbuffer(rb);
              throw new Error('scene framebuffer incomplete with a depth attachment');
            }
            p.depthRb = rb;
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        if (retry) {
          this._destroyTargets();
          this._resolveQuality();
          continue;
        }

        p.useAo = wantAo && !!p.mat && !!p.depthTex;
        p.useSsr = wantSsr && !!p.mat && !!p.depthTex;

        // --- resolve target: what SSAO/SSR write into, and what bloom then reads ---
        if (p.useAo || p.useSsr) {
          p.resolve = this._makeTarget(w, h, ifmt, gl.RGBA, type, gl.LINEAR);
          if (!p.resolve) throw new Error('the resolve target is not renderable');
        }
        const hw = Math.max(1, w >> 1);
        const hh = Math.max(1, h >> 1);
        if (p.useAo) {
          p.aoA = this._makeTarget(hw, hh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
          p.aoB = p.aoA ? this._makeTarget(hw, hh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR) : null;
          if (!p.aoA || !p.aoB) throw new Error('the SSAO targets are not renderable');
        }
        if (p.useSsr) {
          p.ssr = this._makeTarget(hw, hh, ifmt, gl.RGBA, type, gl.LINEAR);
          if (!p.ssr) throw new Error('the SSR target is not renderable');
        }

        // --- bloom chain + anamorphic streak ---
        p.levels = [];
        if (wantBloom) {
          let lw = w, lh = h;
          for (let i = 0; i < BLOOM_LEVELS; i++) {
            lw = Math.max(1, lw >> 1);
            lh = Math.max(1, lh >> 1);
            const a = this._makeTarget(lw, lh, ifmt, gl.RGBA, type, gl.LINEAR);
            const b = a ? this._makeTarget(lw, lh, ifmt, gl.RGBA, type, gl.LINEAR) : null;
            if (!a || !b) {
              if (a) { gl.deleteFramebuffer(a.fbo); gl.deleteTexture(a.tex); }
              throw new Error('bloom level ' + i + ' (' + lw + 'x' + lh + ') is not renderable');
            }
            p.levels.push({ w: lw, h: lh, a, b });
          }
          const sw = p.levels.length > 1 ? p.levels[1].w : Math.max(1, w >> 2);
          const sh2 = p.levels.length > 1 ? p.levels[1].h : Math.max(1, h >> 2);
          p.streakA = this._makeTarget(sw, sh2, ifmt, gl.RGBA, type, gl.LINEAR);
          p.streakB = p.streakA ? this._makeTarget(sw, sh2, ifmt, gl.RGBA, type, gl.LINEAR) : null;
          // The streak is a garnish: losing it must not cost the whole bloom chain.
          if (!p.streakA || !p.streakB) {
            if (p.streakA) { gl.deleteFramebuffer(p.streakA.fbo); gl.deleteTexture(p.streakA.tex); }
            p.streakA = null;
            p.streakB = null;
          }
        }
        p.useBloom = p.levels.length > 0;

        // The LDR target the composite writes when FXAA is going to resolve it to the screen.
        // Losing it is not fatal: the composite simply writes the screen directly instead.
        if (wantFxaa) p.ldr = this._makeTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
        p.useFxaa = !!p.ldr;

        p.w = w;
        p.h = h;
        p.sig = sig;
        p.ready = true;
        return true;
      } catch (err) {
        this._destroyTargets();
        this._postSupported = false;
        this._bloomSupported = false;
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fail('post', 'framebuffer setup failed', err);
        this._resolveQuality();
        return false;
      }
    }
    return false;
  }

  /* -------------------------------------------------------- shadow targets */

  _forgetShadowTargets() {
    const s = this._shadowState;
    s.ready = false; s.sig = ''; s.tex = null; s.fbo = null;
    s.size = 0; s.count = 0; s.atlasW = 0; s.atlasH = 0;
    s.tiles = null;
  }

  _destroyShadowTargets() {
    const gl = this.gl;
    const s = this._shadowState;
    if (!s.tex && !s.fbo) { this._forgetShadowTargets(); return; }
    if (!this.contextLost) {
      try {
        if (s.fbo) gl.deleteFramebuffer(s.fbo);
        if (s.tex) gl.deleteTexture(s.tex);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch (err) {
        // See _destroyTargets.
      }
    }
    this._forgetShadowTargets();
  }

  // The cascade atlas: one depth texture holding `count` square tiles. A single texture and a
  // single sampler keeps the fragment shader to one lookup path, and a single clear per frame.
  _ensureShadowTargets() {
    if (this.contextLost || !this._shadowSupported || !this.csmShader) return false;
    const q = this._q;
    if (q.shadows === 'off') { this._destroyShadowTargets(); return false; }

    const gl = this.gl;
    const low = q.shadows === 'low';
    const count = low ? 1 : MAX_CASCADES;
    let size = low ? 1024 : 2048;
    const s = this._shadowState;
    const sig = count + '@' + size;
    if (s.ready && s.sig === sig) return true;

    this._destroyShadowTargets();
    try {
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
      // Prefer one row of tiles; fall back to a 2-wide grid, then to smaller tiles.
      let cols = count, rows = 1;
      while (size >= 256) {
        cols = count; rows = 1;
        if (cols * size > maxTex) { cols = Math.min(count, 2); rows = Math.ceil(count / cols); }
        if (cols * size <= maxTex && rows * size <= maxTex) break;
        size >>= 1;
      }
      if (size < 256) throw new Error('MAX_TEXTURE_SIZE is too small for a shadow atlas');

      const atlasW = cols * size;
      const atlasH = rows * size;
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, atlasW, atlasH, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      // LINEAR + COMPARE_REF_TO_TEXTURE is hardware PCF: each of the 9 taps below is itself a
      // bilinear 2x2 comparison, so the 3x3 kernel filters a 4x4 footprint for the price of 9.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      // Depth only: no colour attachment, so nothing may be written to one.
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        throw new Error('the shadow framebuffer is incomplete');
      }

      const tiles = [];
      for (let i = 0; i < count; i++) {
        const cx = i % cols;
        const cy = (i / cols) | 0;
        tiles.push({
          px: cx * size, py: cy * size,
          u: (cx * size) / atlasW, v: (cy * size) / atlasH,
          su: size / atlasW, sv: size / atlasH,
        });
      }

      s.tex = tex;
      s.fbo = fbo;
      s.size = size;
      s.count = count;
      s.atlasW = atlasW;
      s.atlasH = atlasH;
      s.tiles = tiles;
      s.sig = sig;
      s.ready = true;
      return true;
    } catch (err) {
      this._destroyShadowTargets();
      this._shadowSupported = false;
      this._fail('shadows', 'shadow map setup failed', err);
      this._resolveQuality();
      return false;
    }
  }

  /* -------------------------------------------------------- shadow casters */

  // Register the meshes that cast shadows, once, at load time:
  //   renderer.setShadowCasters([city.meshes.buildings, city.meshes.terrain, city.meshes.props]);
  // Accepts a Mesh, an array of Meshes, or an array of { mesh, model } pairs. Pass null to go
  // back to the automatic list (whatever was drawn opaque last frame).
  setShadowCasters(list) {
    if (list === null || list === undefined) {
      this._casters = null;
      this._castersSrc = null;
      return this;
    }
    // Re-normalising the same array every frame would allocate for nothing.
    if (list === this._castersSrc && this._casters) return this;
    const out = [];
    const push = (m) => {
      if (!m) return;
      if (m.mesh) out.push({ mesh: m.mesh, model: m.model || null });
      else if (m.vao || typeof m.draw === 'function') out.push({ mesh: m, model: null });
    };
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) push(list[i]);
    } else {
      push(list);
    }
    this._casters = out;
    this._castersSrc = list;
    return this;
  }

  // Remember an opaque draw so the NEXT frame's shadow pass can cast from it. One frame of lag
  // on a static city is invisible, and it means shadows work with no wiring at all.
  _rememberCaster(mesh, model) {
    const cap = this._autoB;
    if (cap.n >= 24 || !mesh || (mesh.vertexCount | 0) <= 0) return;
    let e = cap.list[cap.n];
    if (!e) {
      e = { mesh: null, model: mat4() };
      cap.list.push(e);
    }
    e.mesh = mesh;
    if (model) {
      const m = e.model;
      for (let i = 0; i < 16; i++) m[i] = model[i];
      e.hasModel = true;
    } else {
      e.hasModel = false;
    }
    cap.n++;
  }

  /* ------------------------------------------------------- cascade fitting */

  _normalizedKey() {
    const k = this.env.keyDir || WHITE;
    const x = k[0], y = k[1], z = k[2];
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-8) || !Number.isFinite(l2)) {
      _key[0] = -0.845; _key[1] = 0.225; _key[2] = -0.487;
      return _key;
    }
    const inv = 1 / Math.sqrt(l2);
    _key[0] = x * inv; _key[1] = y * inv; _key[2] = z * inv;
    return _key;
  }

  _normalizedSun() {
    const s = this.env.sunDir || WHITE;
    const x = s[0], y = s[1], z = s[2];
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 1e-8) || !Number.isFinite(l2)) {
      _sun[0] = -0.864; _sun[1] = -0.070; _sun[2] = -0.499;
      return _sun;
    }
    const inv = 1 / Math.sqrt(l2);
    _sun[0] = x * inv; _sun[1] = y * inv; _sun[2] = z * inv;
    return _sun;
  }

  // Fit one orthographic projection per cascade to a bounding SPHERE of the camera frustum
  // slice. The sphere is what makes the fit rotation-invariant: a box fit changes size as the
  // camera turns, and the shadow edges crawl. With the sphere, the only movement left is
  // sub-texel translation, which the snap below removes entirely.
  _fitCascades(cam) {
    const s = this._shadowState;
    const cfg = this.shadow;
    const n = s.count;
    const size = s.size;
    const near = Math.max(Number.isFinite(cam.near) ? cam.near : 1.0, 1.0);
    const camFar = Number.isFinite(cam.far) ? cam.far : 18600;
    // The 'low' preset has ONE 1024 tile to cover the whole range, so it covers less range or its
    // texels turn to mush: at 20% of a 2,200 m reach they are ~1.0 m, the same figure the single
    // cascade landed on before the reach grew, which is still a readable building shadow on a
    // street. (It was 35% of 1,250 m; the fraction moved so the metres did not.)
    // Daylight buys extra reach (DAY_SHADOW_DISTANCE) so the skyline from the harbour is inside
    // the cascades instead of past their fade. Exactly 1x at daylight 0 — blue hour is unchanged.
    const reach = numOr(cfg.distance, 50, 8000, 2200) * (n === 1 ? 0.20 : 1)
      * (1 + (DAY_SHADOW_DISTANCE - 1) * this._daylight());
    const far = Math.max(near + 20, Math.min(reach, camFar));
    const extrude = numOr(cfg.extrude, 10, 4000, 900);
    const blend = numOr(cfg.blend, 0.02, 0.5, 0.16);
    // Street-anchored geometric splits — see the CSM_SPLIT_* block. The anchor is an absolute
    // distance, held below 90% of the reach as well as inside its own bracket, so a pathological
    // `distance` can never order the first split past the last one and hand m4ortho an inverted
    // box.
    const split0 = Math.min(
      far * 0.9,
      clamp(numOr(cfg.split0, 5, 4000, CSM_SPLIT0),
        numOr(cfg.splitMin, 5, 4000, CSM_SPLIT_MIN),
        numOr(cfg.splitMax, 5, 4000, CSM_SPLIT_MAX))
    );
    // Ratio between consecutive splits once the first one is placed. n === 1 never reads it.
    const ratio = n > 1 ? Math.pow(far / Math.max(split0, 1e-3), 1 / (n - 1)) : 1;

    const fov = clamp(Number.isFinite(cam.fov) ? cam.fov : 1.05, 0.15, 2.6);
    const aspect = Number.isFinite(cam.aspect) && Math.abs(cam.aspect) > 1e-4 ? cam.aspect : 1.6;
    const tanHalf = Math.tan(fov * 0.5);

    const f = cam.forward(_tmpA);
    const r = cam.right(_tmpB);
    // True up = right x forward (the camera's own up, not the world's).
    _tmpC[0] = r[1] * f[2] - r[2] * f[1];
    _tmpC[1] = r[2] * f[0] - r[0] * f[2];
    _tmpC[2] = r[0] * f[1] - r[1] * f[0];

    const key = this._normalizedKey();
    // A light pointing straight up would collapse the look-at basis.
    if (Math.abs(key[1]) > 0.985) { _lightUp[0] = 0; _lightUp[1] = 0; _lightUp[2] = 1; }
    else { _lightUp[0] = 0; _lightUp[1] = 1; _lightUp[2] = 0; }

    let sliceNear = near;
    let worstRatio = 0;
    for (let i = 0; i < n; i++) {
      // Cascade 0 takes the street anchor; everything after it is geometric out to the reach;
      // the last one IS the reach, exactly, so uShadowFar and the last split never disagree.
      const sliceFar = (i === n - 1) ? far : split0 * Math.pow(ratio, i);
      if (i > 0 && sliceNear > 1e-3) {
        const r = sliceFar / sliceNear;
        if (r > worstRatio) worstRatio = r;
      }

      const hf = tanHalf * sliceFar;
      const wf = hf * aspect;
      const k = (sliceFar - sliceNear) * 0.5;
      let radius = Math.sqrt(k * k + hf * hf + wf * wf);
      if (!(radius > 0.5)) radius = 0.5;
      const mid = (sliceNear + sliceFar) * 0.5;

      const cx = cam.pos[0] + f[0] * mid;
      const cy = cam.pos[1] + f[1] * mid;
      const cz = cam.pos[2] + f[2] * mid;
      _lightTarget[0] = cx; _lightTarget[1] = cy; _lightTarget[2] = cz;
      const back = radius + extrude;
      _lightEye[0] = cx + key[0] * back;
      _lightEye[1] = cy + key[1] * back;
      _lightEye[2] = cz + key[2] * back;

      const depthRange = 2 * radius + 2 * extrude;
      m4lookAt(_mLightView, _lightEye, _lightTarget, _lightUp);
      m4ortho(_mLightProj, -radius, radius, -radius, radius, 0, depthRange);
      m4mul(_mLightVP, _mLightProj, _mLightView);

      // --- texel snap ---------------------------------------------------------
      // Column 3 of the combined matrix IS the projection of the world origin (w = 1 for an
      // orthographic projection), so rounding it to a whole texel and shifting the clip-space
      // translation by the remainder pins the whole light grid to fixed world texel boundaries.
      // Without this the shadows swim as the camera walks.
      const half = size * 0.5;
      const sx = _mLightVP[12] * half;
      const sy = _mLightVP[13] * half;
      _mLightVP[12] += (Math.round(sx) - sx) / half;
      _mLightVP[13] += (Math.round(sy) - sy) / half;

      const lvp = _csmLightVP[i];
      for (let j = 0; j < 16; j++) lvp[j] = _mLightVP[j];

      // --- bias + atlas tile, folded into the matrix the fragment shader uses ---
      const tile = s.tiles[i];
      m4identity(_mTile);
      _mTile[0] = 0.5 * tile.su;
      _mTile[5] = 0.5 * tile.sv;
      _mTile[10] = 0.5;
      _mTile[12] = tile.u + 0.5 * tile.su;
      _mTile[13] = tile.v + 0.5 * tile.sv;
      _mTile[14] = 0.5;
      m4mul(_csmMatView[i], _mTile, _mLightVP);

      const o = i * 4;
      _csmTile[o] = tile.u; _csmTile[o + 1] = tile.v;
      _csmTile[o + 2] = tile.su; _csmTile[o + 3] = tile.sv;
      _csmParam[o] = (2 * radius) / size;              // world size of one shadow texel
      _csmParam[o + 1] = 1 / depthRange;               // world metres -> [0,1] depth units
      _csmParam[o + 2] = sliceFar;
      _csmParam[o + 3] = sliceFar - (sliceFar - sliceNear) * blend;

      // Reported, not just fitted: `renderer.shadowStats` is what makes a claim about cascade
      // coverage checkable from the console instead of derived on paper from constants that have
      // since moved. Rewritten in place every frame, never reallocated.
      const st = this.shadowStats;
      st.split[i] = sliceFar;
      st.texel[i] = _csmParam[o];
      st.radius[i] = radius;

      sliceNear = sliceFar;
    }
    {
      const st = this.shadowStats;
      st.count = n;
      st.reach = far;
      st.worstRatio = worstRatio;
      for (let i = n; i < MAX_CASCADES; i++) {
        st.split[i] = 0; st.texel[i] = 0; st.radius[i] = 0;
      }
    }

    // Unused cascade slots still get sane values: the shader loops over uCsmCount, but a NaN in
    // an unset uniform slot is exactly the kind of thing that shows up as a black screen on one
    // driver and nothing on another.
    for (let i = n; i < MAX_CASCADES; i++) {
      m4identity(_csmMatView[i]);
      const o = i * 4;
      _csmTile[o] = 0; _csmTile[o + 1] = 0; _csmTile[o + 2] = 1; _csmTile[o + 3] = 1;
      _csmParam[o] = 1; _csmParam[o + 1] = 1; _csmParam[o + 2] = far; _csmParam[o + 3] = far;
    }

    _shadowTexel[0] = 1 / Math.max(1, s.atlasW);
    _shadowTexel[1] = 1 / Math.max(1, s.atlasH);
    _shadowBias[0] = numOr(cfg.constBias, 0, 2, 0.035);
    _shadowBias[1] = numOr(cfg.slopeBias, 0, 8, 0.22);
    this._shadowFar = far;
    this._csmCount = n;
  }

  // Depth-only pass over every caster, once per cascade. Called automatically from beginFrame;
  // call it yourself first if you would rather control the ordering.
  shadowPass(casters, camera) {
    if (this.contextLost) return false;
    if (camera) this.camera = camera;
    const cam = this.camera;
    this._resolveQuality();
    this._csmCount = 0;
    if (this._q.shadows === 'off' || !cam) return false;
    if (!this._ensureShadowTargets()) return false;

    // Resolve the caster list: explicit > argument > whatever was drawn opaque last frame.
    let list = null;
    let count = 0;
    if (casters) {
      this.setShadowCasters(casters);
      list = this._casters;
      count = list ? list.length : 0;
    } else if (this._casters) {
      list = this._casters;
      count = list.length;
    } else {
      list = this._autoA.list;
      count = this._autoA.n;
    }
    if (!list || count === 0) return false;

    this._fitCascades(cam);

    const gl = this.gl;
    const s = this._shadowState;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(0, 0, s.atlasW, s.atlasH);
    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setBlend(false, BLEND_ALPHA);
    this._setCull(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // A small positive polygon offset on top of the normal-offset bias. Depth-only passes are
    // the one place this is nearly free.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3.0);
    this._polyOffset = false;

    const sh = this._useShader(this.csmShader);
    for (let ci = 0; ci < s.count; ci++) {
      const tile = s.tiles[ci];
      gl.viewport(tile.px, tile.py, s.size, s.size);
      sh.set('uLightViewProj', _csmLightVP[ci]);
      for (let i = 0; i < count; i++) {
        const e = list[i];
        if (!e) continue;
        const mesh = e.mesh;
        if (!mesh || (mesh.vertexCount | 0) <= 0) continue;
        sh.set('uModel', (e.hasModel === false ? null : e.model) || IDENTITY);
        this._drawGeom(mesh);
        this.stats.shadowDraws++;
      }
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    this._polyOffset = false;

    // Put the frame's own framebuffer back if we were called mid-frame.
    if (this._frameActive) {
      if (this._frameOffscreen && this._post.scene) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._post.scene.fbo);
        gl.viewport(0, 0, this._post.w, this._post.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
      }
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this._shadowDone = true;
    return true;
  }

  /* ---------------------------------------------------------- state helpers */

  _useShader(sh) {
    if (this._shader === sh) return sh;
    sh.use();
    this._shader = sh;
    this.stats.programSwaps++;
    return sh;
  }

  _setBlend(on, mode) {
    const gl = this.gl;
    if (on !== this._blend) {
      this._blend = on;
      if (on) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    }
    if (on && mode !== this._blendMode) {
      this._blendMode = mode;
      if (mode === BLEND_MULTIPLY) gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  _setDepthTest(on) {
    if (on === this._depthTest) return;
    this._depthTest = on;
    const gl = this.gl;
    if (on) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  }

  _setDepthWrite(on) {
    if (on === this._depthWrite) return;
    this._depthWrite = on;
    this.gl.depthMask(on);
  }

  _setCull(on) {
    if (on === this._cull) return;
    this._cull = on;
    const gl = this.gl;
    if (on) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  }

  _setPolyOffset(on) {
    if (on === this._polyOffset) return;
    this._polyOffset = on;
    const gl = this.gl;
    if (on) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1.5, -2.0);
    } else {
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
  }

  // Bind + draw a Mesh/DynamicMesh, skipping the VAO bind when it is already current.
  _drawGeom(mesh) {
    if (!mesh) return;
    const n = mesh.vertexCount | 0;
    if (n <= 0) return;
    const gl = this.gl;
    const vao = mesh.vao;
    if (vao) {
      if (vao !== this._vao) {
        gl.bindVertexArray(vao);
        this._vao = vao;
        this.stats.vaoBinds++;
      }
      gl.drawArrays(gl.TRIANGLES, 0, n);
    } else if (typeof mesh.draw === 'function') {
      mesh.draw();
      this._vao = null;
    } else {
      return;
    }
    this.stats.draws++;
    this.stats.tris += (n / 3) | 0;
  }

  /* -------------------------------------------------------- frame uniforms */

  // 0 = blue hour / night, 1 = full sun. Sanitised once here so a caller writing garbage into
  // env.daylight cannot half-enable the daylight model in one shader and not another.
  _daylight() {
    return numOr(this.env.daylight, 0, 1, 0);
  }

  _dayExposure() {
    // Preset exposure x the renderer's daylight trim (DAY_EXPOSURE). The trim is exactly 1 at
    // daylight 0, so blue hour and night cannot be moved by it even if a preset sets `exposure`.
    return numOr(this.env.exposure, 0.02, 40, 1)
      * (1 + (DAY_EXPOSURE - 1) * this._daylight());
  }

  _fogParams() {
    const e = this.env;
    // Daylight thins the haze (DAY_FOG_DENSITY). The factor is exactly 1 at daylight 0, so blue
    // hour and night keep the preset's own density to the bit.
    const dayFog = 1 + (DAY_FOG_DENSITY - 1) * this._daylight();
    _fog[0] = numOr(e.fogDensity, 0, 1, 0.0011) * dayFog;
    _fog[1] = numOr(e.fogHeight, 1, 4000, 55);
    _fog[2] = numOr(e.fogBase, -500, 2000, 4);
    _fog[3] = numOr(e.fogMax, 0, 1, 0.94);
    return _fog;
  }

  // The horizon closer — vhFogAmount term 3. Deliberately NOT scaled by daylight: a horizon has
  // to shut at night as well, and CONTRACT §9.4 asks for no viewpoint from which the world
  // visibly ends. It is exactly zero inside `fogRange`, so nothing inside the mapped city can be
  // moved by it at any preset.
  _fogRangeParams() {
    const e = this.env;
    const r0 = numOr(e.fogRange, 0, 200000, 3000);
    const span = Math.max(1, numOr(e.fogRangeSpan, 1, 200000, 5200));
    _fogRange[0] = r0;
    _fogRange[1] = 1 / span;
    _fogRange[2] = numOr(e.fogHorizon, 0, 200000, 3000);
    _fogRange[3] = Math.max(_fogRange[2] + 1, numOr(e.fogHorizonEnd, 0, 200000, 13000));
    return _fogRange;
  }

  // AERIAL PERSPECTIVE — vhFogAmount term 2, extinction per metre of sightline. Koschmieder:
  // a visual range V means a black target falls to 2% contrast at V, i.e. exp(-beta V) = 0.02,
  // so beta = 3.912 / V. Multiplied by env.daylight here and nowhere else, which is what makes
  // the term identically zero at Blue hour and at Night — airlight is scattered SUNLIGHT, and
  // after sunset there is none of it to scatter. Distant lit windows therefore stay sharp at
  // night, which is both correct and the reason those two presets cannot drift.
  _fogBeta() {
    const V = numOr(this.env.fogVisualRange, 200, 1e7, 40000);
    return (3.912 / V) * this._daylight();
  }

  // Cascade uniforms, shared by the scene and water programs.
  _setShadowUniforms(s) {
    const on = this._csmCount > 0 && this._shadowState.ready;
    s.set('uCsmCount', on ? this._csmCount : 0);
    s.setTexture('uShadowMap', 0, on ? this._shadowState.tex : this._dummyShadow);
    if (!on) {
      s.set('uShadowStrength', 0);
      return;
    }
    s.set('uCsmMat', _csmMat);
    s.set('uCsmTile', _csmTile);
    s.set('uCsmParam', _csmParam);
    s.set('uShadowTexel', _shadowTexel);
    s.set('uShadowBias', _shadowBias);
    const base = numOr(this.shadow.strength, 0, 1, 0.74);
    s.set('uShadowStrength', base + (DAY_SHADOW_STRENGTH - base) * this._daylight());
    s.set('uShadowFar', this._shadowFar || 2200);
    s.set('uShadowNormalOffset', numOr(this.shadow.normalOffset, 0, 8, 1.6));
  }

  _sceneUniforms() {
    if (this._sceneFrame) return;
    this._sceneFrame = true;
    const e = this.env;
    const s = this.sceneShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uStreetColor', e.streetColor);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uCnTower', this._cnTowerParams());
    s.set('uSkyBounce', numOr(e.skyBounce, 0, 6, 1.85));
    s.set('uNightFactor', numOr(e.nightFactor, 0, 1, 0.86));
    s.set('uWindowMix', 1);
    s.set('uWindowLit', numOr(e.windowLit, 0, 1, 0.50));
    s.set('uWindowGain', numOr(e.windowGain, 0, 8, 1.45));
    s.set('uDaylight', this._daylight());
    s.set('uDayIndirect', this._dayIndirectParams());
    s.set('uRoad', this._roadParams());
    s.set('uEmitterGain', numOr(e.emitterGain, 0, 16, 2.2));
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);
    this._setShadowUniforms(s);
    this._setLightUniforms(s);
  }

  // The daylight indirect model, sanitised. Nothing here may be NaN: uDayIndirect multiplies the
  // ambient of every fragment in the city, and one bad frame would paint the whole world black.
  _dayIndirectParams() {
    const d = this.dayIndirect || {};
    _dayInd[0] = numOr(d.wall, 0, 2, 0.030);
    _dayInd[1] = numOr(d.street, 0, 2, 0.150);
    _dayInd[2] = numOr(d.skyView, 0.05, 1, 0.52);
    _dayInd[3] = numOr(d.warmth, 0, 1, 0.45);
    return _dayInd;
  }

  // The CN Tower mask, sanitised. `env.cnTower` may be replaced wholesale by a caller (city.js
  // knows where the massing record actually landed), so never hand the GPU a short array or a
  // NaN: a NaN radius makes the mask compare false everywhere and the tower silently loses its
  // identity, which is the hardest kind of bug to spot in a night scene.
  _cnTowerParams() {
    const src = this.env.cnTower;
    const v = isArrayLike(src) ? src : null;
    _cnTower[0] = numOr(v ? v[0] : NaN, -20000, 20000, 114.2);
    _cnTower[1] = numOr(v ? v[1] : NaN, -20000, 20000, 159.0);
    _cnTower[2] = numOr(v ? v[2] : NaN, -500, 2000, 5.7);
    _cnTower[3] = numOr(v ? v[3] : NaN, 1, 400, 34.0);
    return _cnTower;
  }

  _waterUniforms() {
    if (this._waterFrame) return;
    this._waterFrame = true;
    const e = this.env;
    const s = this.waterShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uDaylight', this._daylight());
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);
    this._setShadowUniforms(s);
  }

  // Per-frame state for the text pass. Every term it shares with the scene shader is read from
  // the same env field, so a preset change moves the fascia and the letters on it together.
  _textUniforms() {
    if (this._textFrame) return;
    this._textFrame = true;
    const e = this.env;
    const s = this.textShader;
    const cam = this.camera;
    const f = this.font;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uKeyDir', this._normalizedKey());
    s.set('uKeyColor', e.keyColor);
    s.set('uSunDir', this._normalizedSun());
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uStreetColor', e.streetColor);
    s.set('uFogColor', e.fogColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
    s.set('uSkyBounce', numOr(e.skyBounce, 0, 6, 1.85));
    s.set('uNightFactor', numOr(e.nightFactor, 0, 1, 0.86));
    s.set('uDaylight', this._daylight());
    s.set('uDayIndirect', this._dayIndirectParams());
    s.set('uExposure', this._dayExposure());
    s.set('uOutputMode', this._outputMode);
    _glyphAtlas[0] = f ? f.width : 1;
    _glyphAtlas[1] = f ? f.height : 1;
    _glyphAtlas[2] = f ? f.sdfRange : 12;
    _glyphAtlas[3] = f ? f.capTexels : 24;
    s.set('uGlyphAtlas', _glyphAtlas);
    const t = this.text || {};
    const f0 = numOr(t.fadeStart, 0, 1e6, TEXT_FADE_START);
    const f1 = Math.max(f0 + 1, numOr(t.fadeEnd, 0, 1e6, TEXT_FADE_END));
    const p0 = numOr(t.minPx, 0, 400, 2.4);
    _textLod[0] = f0;
    _textLod[1] = 1 / (f1 - f0);
    _textLod[2] = p0;
    _textLod[3] = Math.max(p0 + 0.25, numOr(t.fadePx, 0, 400, 4.6));
    s.set('uTextLod', _textLod);
    s.set('uTextWeight', numOr(t.weight, 0, 3, 0.42));
    this._setShadowUniforms(s);
  }

  _gshadowUniforms() {
    if (this._gshadowFrame) return;
    this._gshadowFrame = true;
    const e = this.env;
    const s = this.gshadowShader;
    const cam = this.camera;
    s.set('uViewProj', (cam && cam.viewProj) || IDENTITY);
    s.set('uCameraPos', (cam && cam.pos) || WHITE);
    s.set('uShadowColor', e.shadowColor);
    s.set('uFogParams', this._fogParams());
    s.set('uFogRange', this._fogRangeParams());
    s.set('uFogBeta', this._fogBeta());
  }

  /* ------------------------------------------------------------- frame API */

  // `casters` is optional: pass the meshes that should cast shadows this frame, or register them
  // once with setShadowCasters(), or leave both alone and the renderer casts from whatever was
  // drawn opaque last frame.
  beginFrame(camera, casters) {
    const st = this.stats;
    st.draws = 0;
    st.tris = 0;
    st.programSwaps = 0;
    st.vaoBinds = 0;
    st.postPasses = 0;
    st.shadowDraws = 0;
    this.camera = camera || this.camera;
    this._sceneFrame = false;
    this._waterFrame = false;
    this._gshadowFrame = false;
    this._textFrame = false;
    this._frameOffscreen = false;
    this._frameActive = false;
    this._outputMode = 0;
    // Other modules may have created meshes (which bind and unbind VAOs) since the last frame.
    this._vao = null;
    if (this.contextLost) return;

    const gl = this.gl;
    this._resolveQuality();

    // Swap the auto-caster capture buffers: what was drawn last frame becomes this frame's
    // caster list, and this frame starts recording into the other one.
    const prev = this._autoA;
    this._autoA = this._autoB;
    this._autoB = prev;
    this._autoB.n = 0;

    // --- local lights: cull, rank and cluster for THIS camera ---------------
    // Before the shadow pass, because it uploads two textures and the shadow pass is about to
    // change the bound framebuffer; and unconditionally before any program can ask for the scene
    // uniforms, which is where the tables are handed to the shader.
    this._updateLights();

    // --- cascaded shadow maps, before anything binds the scene target -------
    if (!this._shadowDone) this.shadowPass(casters || null, this.camera);
    this._shadowDone = false;

    // --- pick the target: offscreen when any post feature is live -----------
    if (this._ensureTargets()) {
      const p = this._post;
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.scene.fbo);
      gl.viewport(0, 0, p.w, p.h);
      this._frameOffscreen = true;
      this._outputMode = p.encode ? 2 : 1;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
    }
    this._frameActive = true;

    gl.depthFunc(gl.LEQUAL);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    this._setCull(true);
    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    const fc = this.env.fogColor;
    // Alpha 0 in the clear: on the material target that is the ambient-share channel, and an
    // unwritten pixel must not be told it is pure ambient.
    gl.clearColor(fc[0], fc[1], fc[2], 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._drawSky();
  }

  _drawSky() {
    const gl = this.gl;
    const e = this.env;
    const cam = this.camera;

    // The fullscreen triangle sits exactly on the far plane, so it is drawn with the depth test
    // off and the depth buffer untouched, before anything else.
    this._setDepthTest(false);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    const s = this._useShader(this.skyShader);
    s.set('uInvViewProj', (cam && cam.invViewProj) || IDENTITY);
    s.set('uSunDir', this._normalizedSun());
    s.set('uKeyColor', e.keyColor);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uFogColor', e.fogColor);
    s.set('uCloudAmount', this._q.clouds ? numOr(e.cloudAmount, 0, 1, 0.55) : 0);
    s.set('uCloudCover', numOr(e.cloudCover, 0, 0.98, 0.52));
    s.set('uStarAmount', numOr(e.starAmount, 0, 1, 0.55));
    s.set('uDaylight', this._daylight());
    s.set('uExposure', this._dayExposure());
    s.set('uTime', numOr(e.time, -1e7, 1e7, 0));
    s.set('uOutputMode', this._outputMode);

    if (this.skyVao !== this._vao) {
      gl.bindVertexArray(this.skyVao);
      this._vao = this.skyVao;
      this.stats.vaoBinds++;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.draws++;
    this.stats.tris += 1;

    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setCull(true);
  }

  drawMesh(mesh, model, tint = WHITE, flash = 0, alpha = 1) {
    if (this.contextLost || !mesh) return;
    const s = this._useShader(this.sceneShader);
    this._sceneUniforms();

    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    const translucent = a < 0.999;
    this._setPolyOffset(false);
    this._setCull(true);
    this._setDepthTest(true);
    this._setBlend(translucent, BLEND_ALPHA);
    this._setDepthWrite(!translucent);

    const tr = tint ? tint[0] : 1;
    const tg = tint ? tint[1] : 1;
    const tb = tint ? tint[2] : 1;
    if (tr !== this._tr || tg !== this._tg || tb !== this._tb) {
      this._tr = tr; this._tg = tg; this._tb = tb;
      _tint[0] = tr; _tint[1] = tg; _tint[2] = tb;
      s.set('uTint', _tint);
    }

    const fl = Number.isFinite(flash) ? clamp(flash, 0, 4) : 0;
    if (fl !== this._flash) {
      this._flash = fl;
      s.set('uFlash', fl);
    }
    if (a !== this._alpha) {
      this._alpha = a;
      s.set('uAlpha', a);
    }

    s.set('uModel', model || IDENTITY);
    this._drawGeom(mesh);
    if (!translucent) this._rememberCaster(mesh, model);
  }

  // Pre-baked contact/blob shadows, if a caller still has such a mesh: multiplicative,
  // depth-tested, never writes depth, offset toward the camera so it cannot z-fight the surface
  // it is painted on. The cascaded maps are the real shadows now.
  drawShadowMesh(mesh, alpha) {
    if (this.contextLost || !mesh) return;
    const s = this._useShader(this.gshadowShader);
    this._gshadowUniforms();

    this._setDepthTest(true);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(true, BLEND_MULTIPLY);
    this._setPolyOffset(true);

    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0.5;
    if (a !== this._shadowAlpha) {
      this._shadowAlpha = a;
      s.set('uAlpha', a);
    }
    this._drawGeom(mesh);

    this._setPolyOffset(false);
  }

  /**
   * Glyph geometry from src/text.js. Draw it AFTER every opaque class and before drawWater or
   * endFrame; it is a blended decal pass, so anything it should sit on top of has to be in the
   * depth buffer already.
   *
   * Three deliberate departures from drawMesh, all of them about a glyph being paint on a surface
   * rather than a surface:
   *   * DEPTH WRITE IS OFF. Depth is what SSAO and SSR march, and a letter is not an occluder and
   *     not a reflector — it is a centimetre of ink on the fascia that already wrote depth there.
   *     With the write on, SSR would trace the reflection of the letter and SSAO would darken
   *     around a shape floating in front of a flat wall.
   *   * IT IS BLENDED. The distance field gives analytic coverage; throwing that away for an
   *     alpha test turns a 3 px cap height into crawling confetti, which is exactly the distance
   *     at which street signage matters most. Glyph quads only overlap where both are at zero
   *     coverage, so the missing depth sort costs nothing.
   *   * IT NEVER BECOMES A SHADOW CASTER. The depth-only cascade program reads position and
   *     nothing else, so a text mesh in the caster list would cast the SOLID QUAD of every glyph
   *     across the pavement. _rememberCaster is not called here, and callers must keep the text
   *     class out of setShadowCasters.
   */
  drawText(mesh, model, tint = WHITE, alpha = 1) {
    if (this.contextLost || !mesh) return;
    if (!this.textShader || !this.font || !this.font.texture) return;
    const s = this._useShader(this.textShader);
    this._textUniforms();

    this._setPolyOffset(false);
    this._setCull(true);
    this._setDepthTest(true);
    this._setBlend(true, BLEND_ALPHA);
    this._setDepthWrite(false);

    const tr = tint ? tint[0] : 1;
    const tg = tint ? tint[1] : 1;
    const tb = tint ? tint[2] : 1;
    if (tr !== this._txTr || tg !== this._txTg || tb !== this._txTb) {
      this._txTr = tr; this._txTg = tg; this._txTb = tb;
      _tint[0] = tr; _tint[1] = tg; _tint[2] = tb;
      s.set('uTint', _tint);
    }
    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    if (a !== this._txAlpha) {
      this._txAlpha = a;
      s.set('uAlpha', a);
    }

    // Texture UNITS are global GL state, not program state, and the post chain uses unit 4 for
    // the SSR and streak buffers. Binding the atlas once per frame with the other uniforms
    // therefore only works until something else touches the unit — which cost most of a day, and
    // presents as text that samples a black atlas and vanishes completely. Bind per draw; it is
    // a handful of calls a frame.
    s.setTexture('uGlyphs', 4, this.font.texture);
    s.set('uModel', model || IDENTITY);
    this._drawGeom(mesh);
  }

  // The lake. Drawn OPAQUE on purpose: an alpha-blended surface would blend the material target
  // too, and SSR would then trace against a smeared normal. Depth in the harbour is not modelled
  // — inside this bbox it is deep enough everywhere to read as opaque anyway.
  drawWater(mesh, camera) {
    if (this.contextLost || !mesh) return;
    if (camera) {
      this.camera = camera;
      this._waterFrame = false;   // a fresh camera was supplied for this call
    }
    this._useShader(this.waterShader);
    this._waterUniforms();
    this.waterShader.set('uModel', IDENTITY);

    this._setDepthTest(true);
    this._setDepthWrite(true);
    this._setCull(false);       // visible from underneath too
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);

    // The lake is deliberately NOT a shadow caster: it is flat, it sits at the bottom of the
    // world, and letting it into the depth pass only buys self-shadowing artefacts on the water.
    this._drawGeom(mesh);
  }

  /* ------------------------------------------------------------------- post */

  // Bind a target (null = the default framebuffer, i.e. the screen) and draw the fullscreen
  // triangle. Attributeless: the VAO carries no arrays, the vertices come from gl_VertexID.
  _postPass(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    if (target) gl.viewport(0, 0, target.w, target.h);
    else gl.viewport(0, 0, this._post.w, this._post.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.postPasses++;
  }

  // Depth-texture uniforms shared by SSAO, the AO blur, SSR and the resolve.
  _setDepthUniforms(s, unit) {
    const cam = this.camera;
    const proj = (cam && cam.proj) || IDENTITY;
    _zparam[0] = proj[10];
    _zparam[1] = proj[14];
    s.setTexture('uDepth', unit, this._post.depthTex);
    s.set('uInvProj', (cam && cam.invProj) || IDENTITY);
    s.set('uZParam', _zparam);
  }

  _runSSAO() {
    const p = this._post;
    const cfg = this.ssao;
    const cam = this.camera;
    const s = this._useShader(this.ssaoShader);
    _aoParam[0] = numOr(cfg.radius, 0.05, 64, 3.4);
    _aoParam[1] = numOr(cfg.intensity, 0, 4, 1.0);
    _aoParam[2] = numOr(cfg.bias, 0.001, 4, 0.045);
    _aoParam[3] = numOr(cfg.power, 0.05, 8, 1.35);
    _texel[0] = 1 / Math.max(1, p.w);
    _texel[1] = 1 / Math.max(1, p.h);
    s.set('uProj', (cam && cam.proj) || IDENTITY);
    s.set('uSrcTexel', _texel);
    s.set('uAoParams', _aoParam);
    this._setDepthUniforms(s, 0);
    this._postPass(p.aoA);

    const b = this._useShader(this.aoBlurShader);
    _texel2[0] = 1 / Math.max(1, p.aoA.w);
    _texel2[1] = 1 / Math.max(1, p.aoA.h);
    b.set('uTexel', _texel2);
    b.set('uSharpness', numOr(cfg.sharpness, 0, 64, 5.5));
    b.setTexture('uSrc', 1, p.aoA.tex);
    this._setDepthUniforms(b, 0);
    this._postPass(p.aoB);
  }

  _runSSR() {
    const p = this._post;
    const cfg = this.ssr;
    const cam = this.camera;
    const e = this.env;
    const s = this._useShader(this.ssrShader);
    _ssrParam[0] = numOr(cfg.maxDistance, 1, 4000, 240);
    _ssrParam[1] = numOr(cfg.steps, 4, 48, 28);
    _ssrParam[2] = numOr(cfg.thickness, 0.05, 40, 1.3);
    _ssrParam[3] = numOr(cfg.stride, 0.05, 20, 0.6);
    s.set('uProj', (cam && cam.proj) || IDENTITY);
    s.set('uView', (cam && cam.view) || IDENTITY);
    s.set('uInvView', (cam && cam.invView) || IDENTITY);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uSunDir', this._normalizedSun());
    s.set('uAmbientGround', e.ambientGround);
    s.set('uSsrParams', _ssrParam);
    s.set('uDecode', p.encode ? 1 : 0);
    s.setTexture('uScene', 1, p.scene.tex);
    s.setTexture('uMat', 2, p.mat);
    this._setDepthUniforms(s, 0);
    this._postPass(p.ssr);
  }

  _runResolve() {
    const p = this._post;
    const e = this.env;
    const cam = this.camera;
    const s = this._useShader(this.resolveShader);
    s.set('uInvView', (cam && cam.invView) || IDENTITY);
    s.set('uSkyZenith', e.skyZenith);
    s.set('uSkyHorizon', e.skyHorizon);
    s.set('uSkyWest', e.skyWest);
    s.set('uSunDir', this._normalizedSun());
    s.set('uAmbientSky', e.ambientSky);
    s.set('uAmbientGround', e.ambientGround);
    s.set('uAoEnabled', p.useAo ? 1 : 0);
    s.set('uSsrEnabled', p.useSsr ? 1 : 0);
    s.set('uSsrIntensity', numOr(this.ssr.intensity, 0, 4, 1));
    s.set('uDaylight', this._daylight());
    s.set('uAoFill', numOr((this.dayIndirect || {}).aoFill, 0, 1, 0.62));
    s.set('uDecode', p.encode ? 1 : 0);
    s.setTexture('uScene', 1, p.scene.tex);
    s.setTexture('uMat', 2, p.mat);
    s.setTexture('uAO', 3, p.useAo ? p.aoB.tex : p.scene.tex);
    s.setTexture('uSSR', 4, p.useSsr ? p.ssr.tex : p.scene.tex);
    this._setDepthUniforms(s, 0);
    this._postPass(p.resolve);
  }

  // Bright-pass / downsample. `threshold = 0, knee = 0, firefly = 0` degenerates into a plain
  // 4-tap box downsample, which is what the lower levels use.
  _brightPass(srcTex, srcW, srcH, threshold, knee, firefly, decode, dst) {
    const s = this._useShader(this.brightShader);
    _texel[0] = 1 / Math.max(1, srcW);
    _texel[1] = 1 / Math.max(1, srcH);
    s.set('uTexel', _texel);
    s.set('uThreshold', threshold);
    s.set('uKnee', knee);
    s.set('uFirefly', firefly);
    s.set('uDecode', decode);
    s.setTexture('uSrc', 0, srcTex);
    this._postPass(dst);
  }

  // Separable Gaussian in place: level.a -> level.b horizontally, then back the other way.
  _blurLevel(level, radius) {
    const s = this._useShader(this.blurShader);
    _texel[0] = 1 / Math.max(1, level.w);
    _texel[1] = 1 / Math.max(1, level.h);
    s.set('uTexel', _texel);
    s.set('uRadius', radius);

    _dir[0] = 1; _dir[1] = 0;
    s.set('uDir', _dir);
    s.setTexture('uSrc', 0, level.a.tex);
    this._postPass(level.b);

    _dir[0] = 0; _dir[1] = 1;
    s.set('uDir', _dir);
    s.setTexture('uSrc', 0, level.b.tex);
    this._postPass(level.a);
  }

  // One wide horizontal smear, run three times at quarter resolution with a growing radius.
  // Anamorphic flares are a horizontal-only artefact of a cylindrical lens element, which is
  // exactly what this is: no vertical pass, ever.
  _runStreak() {
    const p = this._post;
    if (!p.streakA || !p.streakB || p.levels.length === 0) return null;
    const s = this._useShader(this.blurShader);
    _texel[0] = 1 / Math.max(1, p.streakA.w);
    _texel[1] = 1 / Math.max(1, p.streakA.h);
    _dir[0] = 1; _dir[1] = 0;
    s.set('uTexel', _texel);
    s.set('uDir', _dir);

    const src = p.levels[0].a.tex;
    s.set('uRadius', 3.0);
    s.setTexture('uSrc', 0, src);
    this._postPass(p.streakA);

    s.set('uRadius', 9.0);
    s.setTexture('uSrc', 0, p.streakA.tex);
    this._postPass(p.streakB);

    s.set('uRadius', 27.0);
    s.setTexture('uSrc', 0, p.streakB.tex);
    this._postPass(p.streakA);
    return p.streakA;
  }

  // The whole post chain. Every stage is optional and the composite is the only pass that ever
  // writes the default framebuffer.
  _runPost() {
    const gl = this.gl;
    const p = this._post;

    this._setDepthTest(false);
    this._setDepthWrite(false);
    this._setCull(false);
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);
    if (this.skyVao !== this._vao) {
      gl.bindVertexArray(this.skyVao);
      this._vao = this.skyVao;
      this.stats.vaoBinds++;
    }

    if (p.useAo) this._runSSAO();
    if (p.useSsr) this._runSSR();

    let src = p.scene;
    if ((p.useAo || p.useSsr) && p.resolve) {
      this._runResolve();
      src = p.resolve;
    }

    const decode = p.encode ? 1 : 0;
    const day = this._daylight();
    let streak = null;
    if (p.useBloom) {
      const cfg = this.bloom;
      const threshold = numOr(cfg.threshold, 0, 8, 0.72) * (1 + (DAY_BLOOM_THRESHOLD - 1) * day);
      const radius = numOr(cfg.radius, 0.05, 4, 1);

      // Level 0: threshold straight out of the scene target at half resolution, then blur.
      const l0 = p.levels[0];
      this._brightPass(src.tex, p.w, p.h, threshold, threshold * 0.5, 1, decode, l0.a);
      this._blurLevel(l0, radius);

      // Levels 1..n: box-downsample the level above (no second threshold — it would eat the
      // glow the first pass just produced) and blur again at the new resolution.
      for (let i = 1; i < p.levels.length; i++) {
        const prev = p.levels[i - 1];
        const cur = p.levels[i];
        this._brightPass(prev.a.tex, prev.w, prev.h, 0, 0, 0, 0, cur.a);
        this._blurLevel(cur, radius);
      }
      streak = this._runStreak();
    }

    // --- composite: the last pass before the frame becomes 8-bit -------------
    const cfg = this.post || {};
    const s = this._useShader(this.compShader);
    const b0 = p.useBloom ? p.levels[0].a.tex : src.tex;
    const b1 = p.useBloom ? p.levels[Math.min(1, p.levels.length - 1)].a.tex : src.tex;
    const b2 = p.useBloom ? p.levels[Math.min(2, p.levels.length - 1)].a.tex : src.tex;
    s.set('uIntensity', p.useBloom
      ? numOr(this.bloom.intensity, 0, 8, 0.85) * (1 + (DAY_BLOOM_INTENSITY - 1) * day)
      : 0);
    s.set('uStreakIntensity', streak
      ? numOr(cfg.streak, 0, 4, 0.5) * (1 + (DAY_STREAK_INTENSITY - 1) * day)
      : 0);
    s.set('uChroma', numOr(cfg.chroma, 0, 0.2, 0.0032));
    // With FXAA in play, grain and dither happen in THAT pass instead: graining first would
    // give the edge detector high-frequency noise to chase and soften the whole image.
    s.set('uGrain', p.useFxaa ? 0 : numOr(cfg.grain, 0, 0.5, 0.026));
    s.set('uVignette', numOr(cfg.vignette, 0, 1, 0.30));
    s.set('uTime', numOr(this.env.time, -1e7, 1e7, 0));
    s.set('uDecode', decode);
    s.set('uDaylight', day);
    s.set('uExposure', this._dayExposure());
    s.setTexture('uScene', 0, src.tex);
    s.setTexture('uB0', 1, b0);
    s.setTexture('uB1', 2, b1);
    s.setTexture('uB2', 3, b2);
    s.setTexture('uStreak', 4, streak ? streak.tex : src.tex);
    this._postPass(p.useFxaa ? p.ldr : null);

    // --- FXAA resolve: the only pass that writes the screen when it is on ----
    if (p.useFxaa) {
      const fx = this._useShader(this.fxaaShader);
      _texel[0] = 1 / Math.max(1, p.w);
      _texel[1] = 1 / Math.max(1, p.h);
      fx.set('uTexel', _texel);
      fx.set('uGrain', numOr(cfg.grain, 0, 0.5, 0.026));
      fx.set('uTime', numOr(this.env.time, -1e7, 1e7, 0));
      fx.setTexture('uSrc', 0, p.ldr.tex);
      this._postPass(null);
    }

    // Leave no post texture bound. Next frame the geometry pass renders INTO the very textures
    // these units are holding, and while no scene program samples them (so nothing is actually a
    // feedback loop), an unbound unit is one less thing for a driver to be clever about.
    for (let u = 4; u >= 0; u--) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  endFrame() {
    if (this.contextLost) return;
    const gl = this.gl;

    if (this._frameOffscreen) {
      this._frameOffscreen = false;
      this._outputMode = 0;
      try {
        this._runPost();
      } catch (err) {
        // A post pass has no business taking the renderer down. Give up on the offscreen path
        // for good and put the screen back under our feet; the next frame draws straight to it.
        this._postSupported = false;
        this._bloomSupported = false;
        this._ssaoSupported = false;
        this._ssrSupported = false;
        this._fxaaSupported = false;
        this._fail('post', 'a post pass failed', err);
        try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (e) { /* nothing left to do */ }
        this._destroyTargets();
        this._resolveQuality();
      }
    }

    this._frameActive = false;
    this._setBlend(false, BLEND_ALPHA);
    this._setPolyOffset(false);
    this._setDepthWrite(true);
    this._setDepthTest(true);
    this._setCull(true);
    if (this._vao !== null) {
      gl.bindVertexArray(null);
      this._vao = null;
    }
    // NOTE: the program is deliberately left bound. gl.js tracks the live program on the
    // context object, so calling gl.useProgram(null) here would desync Shader.set().
  }

  // Everything this renderer owns. Meshes belong to their own modules and are not touched.
  dispose() {
    const gl = this.gl;
    this._destroyTargets();
    this._destroyShadowTargets();
    if (!this.contextLost) {
      try {
        if (this._dummyShadow) gl.deleteTexture(this._dummyShadow);
        if (this._lights.dataTex) gl.deleteTexture(this._lights.dataTex);
        if (this._lights.gridTex) gl.deleteTexture(this._lights.gridTex);
        if (this.skyVao) gl.deleteVertexArray(this.skyVao);
      } catch (err) {
        // Teardown is best-effort.
      }
    }
    this._lights.dataTex = null;
    this._lights.gridTex = null;
    this._lights.ready = false;
    this._dummyShadow = null;
    this.skyVao = null;
    if (!this.contextLost) releaseFont(gl);
    this.font = null;
    const shaders = [
      this.sceneShader, this.skyShader, this.waterShader, this.gshadowShader, this.csmShader,
      this.textShader, this.brightShader, this.blurShader, this.compShader, this.ssaoShader,
      this.aoBlurShader, this.ssrShader, this.resolveShader, this.fxaaShader,
    ];
    for (let i = 0; i < shaders.length; i++) {
      if (shaders[i] && !this.contextLost) {
        try { shaders[i].dispose(); } catch (err) { /* best effort */ }
      }
    }
    const canvas = this._canvas;
    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('webglcontextlost', this._onLost, false);
      canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
    }
  }
}
