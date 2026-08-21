// src/render/env.js -- the lighting environment, and every uniform derived from it.
//
// One place that answers "what time of day is it, and what does the air look like": the
// default environment a Renderer starts with, the DAYLIGHT constants that trim the blue-hour
// model toward a sunlit one, and the small sanitising readers that turn env fields into the
// exact Float32Arrays the shaders take.
//
// CONTRACT Amendment 7 lives here: env.daylight is the single switch, and every daylight term
// is written so that at 0 it multiplies by exactly 1.0 or mixes with exactly 0.0. That is what
// makes the blue-hour image bit-for-bit unchanged whatever the daylight path grows into.
//
// Nothing here may return a NaN: these arrays multiply the ambient of every fragment in the
// city, and one bad frame would paint the whole world black.

import { vec3 } from '../core/math.js';
import { numOr, isArrayLike } from './util.js';

// --- daylight -------------------------------------------------------------------------------
// `env.daylight` (0 = blue hour / night, 1 = full sun) is the single switch between the two
// lighting models. Everything keyed off it below is written so that at 0 it multiplies by exactly
// 1.0 or mixes with exactly 0.0, which is what makes the blue-hour image bit-for-bit unchanged.
//
// Fog density, as a multiple of the preset's own. Blue hour WANTS the street grid sunk in haze
// (CONTRACT 3.2 item 7). A clear afternoon does not: at the preset density the aerial term is
// brighter than most facades, so it lifts every distant tower toward a milky grey and takes the
// facade colour with it. Thin it and the skyline stays legible all the way to Yonge.
// Thinned again (0.40 -> 0.24) against the "pale" report: from the harbour the Financial District
// stands 1.2-1.9 km off and the aerial term was still eating a third of its chroma there. What is
// left is enough to read as distance and no longer enough to read as weather.
export const DAY_FOG_DENSITY = 0.24;
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
export const DAY_EXPOSURE = 5.12;

// Module-scope scratch — the hot paths must not allocate. Each is filled and handed to the GPU
// inside one call.
const _fog = new Float32Array(4);
const _fogRange = new Float32Array(4);
const _dayInd = new Float32Array(4);
const _cnTower = new Float32Array(4);
// Road surface response: x = wetness, y = dry roughness, z = wet roughness, w = anisotropy.
const _road = new Float32Array(4);

// The environment a fresh Renderer starts with.
//
// Fixed at Toronto blue hour, ~20:45 in June (CONTRACT section 0): the sun is BELOW the horizon
// in the WNW, so sunDir only sets where the afterglow sits and keyDir is the low raking
// skylight that actually casts the shadows. The time-of-day presets replace these per preset.
export function defaultEnv() {
  return {
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
}

/* ------------------------------------------------- env -> uniform readers -- */

// Mixed into Renderer.prototype by renderer.js. Every one of these reads this.env (and the
// renderer-level dials beside it) and returns module scratch, so none of them allocates.
export const EnvMethods = {
  // 0 = blue hour / night, 1 = full sun. Sanitised once here so a caller writing garbage into
  // env.daylight cannot half-enable the daylight model in one shader and not another.
  _daylight() {
    return numOr(this.env.daylight, 0, 1, 0);
  },

  _dayExposure() {
    // Preset exposure x the renderer's daylight trim (DAY_EXPOSURE). The trim is exactly 1 at
    // daylight 0, so blue hour and night cannot be moved by it even if a preset sets `exposure`.
    return numOr(this.env.exposure, 0.02, 40, 1)
      * (1 + (DAY_EXPOSURE - 1) * this._daylight());
  },

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
  },

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
  },

  // AERIAL PERSPECTIVE — vhFogAmount term 2, extinction per metre of sightline. Koschmieder:
  // a visual range V means a black target falls to 2% contrast at V, i.e. exp(-beta V) = 0.02,
  // so beta = 3.912 / V. Multiplied by env.daylight here and nowhere else, which is what makes
  // the term identically zero at Blue hour and at Night — airlight is scattered SUNLIGHT, and
  // after sunset there is none of it to scatter. Distant lit windows therefore stay sharp at
  // night, which is both correct and the reason those two presets cannot drift.
  _fogBeta() {
    const V = numOr(this.env.fogVisualRange, 200, 1e7, 40000);
    return (3.912 / V) * this._daylight();
  },

  // The daylight indirect model, sanitised. Nothing here may be NaN: uDayIndirect multiplies the
  // ambient of every fragment in the city, and one bad frame would paint the whole world black.
  _dayIndirectParams() {
    const d = this.dayIndirect || {};
    _dayInd[0] = numOr(d.wall, 0, 2, 0.030);
    _dayInd[1] = numOr(d.street, 0, 2, 0.150);
    _dayInd[2] = numOr(d.skyView, 0.05, 1, 0.52);
    _dayInd[3] = numOr(d.warmth, 0, 1, 0.45);
    return _dayInd;
  },

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
  },

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
  },
};

/* -------------------------------------------------------------- defaults -- */

// Daylight INDIRECT light: the bounce off the sunlit city, and the sky-view correction that
// goes with it. This is what makes a street canyon read as three in the afternoon instead of
// deep dusk — see the uDayIndirect block in shaders/common.glsl.js for the physics and the
// measured numbers. Every field is multiplied by uDaylight at the point of use, so at daylight 0
// the whole object is an exact no-op and blue hour and night cannot be moved by any of it.
// Tunable live: `G.renderer.dayIndirect.street = 0.18`.
export function defaultDayIndirect() {
  return {
    wall: 0.030,     // sun irradiance a VERTICAL surface takes back off the sunlit city
    street: 0.150,   // and a SKY-FACING one: carriageway, sidewalk, kerb, deck, prop top
    skyView: 0.52,   // daylight sky-view of a vertical surface, against a horizontal one
    warmth: 0.45,    // how far the bounce leans to the masonry spectrum it came off
    aoFill: 0.62,    // fraction of the SSAO occlusion the bounce hands back, at full daylight
  };
}

// THE ROAD SURFACE. Asphalt is a rough mineral aggregate, not a mirror — see the "asphalt is
// not glass" block in shaders/scene.glsl.js for what each of these does and why the old blanket
// 0.18 read as a polished sheet. Tunable live: `G.renderer.road.wetness = 0.8` for a downpour,
// 0 for a dry August night. Every one of them is multiplied by (1 - daylight) at the point of
// use, so Afternoon cannot be moved by any of it.
export function defaultRoad() {
  return {
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
}
