// src/app/time.js — the time-of-day presets and the environment writer.
//
// CONTRACT Amendment 11: lifted out of src/app/main.js unchanged. The numbers here are the
// authored look of the city at four times of day and are NOT to be retuned as part of a move.
//
// The renderer owns one mutable `env` object; a preset is written INTO it rather than swapped for
// it, so every array identity the shaders already hold stays valid. TimeOfDay keeps the snapshot
// of the renderer's own blue-hour defaults, which is why it is an instance and not module state:
// two renderers (or a test) must not share one snapshot.

// The renderer ships a blue-hour environment baked into its defaults. These presets overwrite it
// wholesale so the city can be seen in real daylight as well.
//
// Sun directions are genuine Toronto (43.64 N) solar positions, converted to world axes
// (X = east, Y = up, Z = south):  x = sin(az) * cos(el),  y = sin(el),  z = -cos(az) * cos(el)
// with azimuth measured clockwise from north. The renderer uses cascaded shadow maps, so unlike
// the earlier build nothing constrains the sun's bearing — it can move freely.
//
// The critical daylight difference is not just brightness: `windowGain` goes to zero so interior
// lights vanish, `starAmount` and `streetColor` go dark, `skyBounce` drops (in daylight the SUN is
// the key light, whereas at blue hour the sky is doing all the work), and fog thins by ~3x.
//
// `daylight` (0..1) is the switch between the renderer's two lighting models, and the daylight
// entries below are authored against the DAYLIGHT one — which is a different unit system, not just
// bigger numbers. At daylight 0 the pipeline is display-referred: a vertex colour is what the
// surface should LOOK like. At daylight 1 render.js undoes city.js's blue-hour albedo bake, so the
// same vertex colour becomes a real reflectance (0.03 .. 0.85), the shading is linear radiance, and
// the grade applies an exposure and a 2.2 OETF at the end. That is why keyColor here reads ~0.93
// rather than the 2.55 the old display-referred entry needed: it is now irradiance arriving on a
// surface whose albedo is a real number, and the two multiply out to a sunlit white wall at ~0.47
// linear. Sky colours are likewise LINEAR luminances, which is why they look low next to the
// blue-hour set — a clear zenith really is about a fifth as bright as a sunlit white facade.
export const TIME_PRESETS = [
  {
    name: 'Afternoon', clock: '15:20',
    // az 235 deg (SW), el 48 deg — high summer afternoon sun raking the west and south faces
    daylight: 1.0, exposure: 1.0,
    sunDir: [-0.548, 0.743, 0.384],
    keyDir: [-0.548, 0.743, 0.384],
    // ~5300 K direct sun through 1.35 air masses. Luminance 0.93: with the sky fill at 0.070 this
    // puts the sun 7.3x the sky on a west-facing wall, which is what the shadow contrast needs.
    keyColor: [0.970, 0.925, 0.855],
    // The dome, rebuilt against the "daytime view looks a bit pale" report. These are LINEAR
    // luminances, and the old set was a pale dome with very little chroma anywhere: the zenith
    // carried a 0.83 linear saturation but only 0.076 luminance, and the horizon — which is
    // essentially the whole of the harbour frame, since the camera sees 0 to 26 degrees of
    // elevation from there — sat at 0.42 saturation and 0.27 luminance and graded out at a 21%
    // screen saturation. That is the pale.
    //
    // A clear Toronto afternoon at 48 degrees of solar elevation is a DEEP blue overhead that
    // pales toward the horizon without ever going grey. So: the zenith goes down and further
    // into the blue, and the horizon band gives up some luminance in exchange for chroma rather
    // than the other way round. Both keep their Rayleigh shape (B > G > R, with G doing most of
    // the luminance) — this is not a stylised gradient, it is the same curve with the milk
    // poured out of it.
    skyZenith: [0.020, 0.060, 0.216],
    skyHorizon: [0.158, 0.243, 0.398],
    // The warm quarter of the sky around the sun's bearing, a little stronger to hold its own
    // against the deeper blue everywhere else.
    skyWest: [0.470, 0.372, 0.250],
    ambientSky: [0.068, 0.100, 0.180],
    ambientGround: [0.050, 0.048, 0.043],
    streetColor: [0, 0, 0],
    // Diffuse sky fill. Low on purpose: the sun is 15x this on a west-facing wall, which is what
    // buys the measured 3.4x sun/shade contrast. A clear afternoon sky really is a weak light
    // next to the disc, and the shadows it leaves behind stay blue rather than going black.
    skyBounce: 0.44,
    // Aerial-perspective and horizon-haze colour. This was a near-neutral grey (0.235, 0.255,
    // 0.300) and it is what every distant facade and the whole horizon band were being pulled
    // toward. Daytime in-scatter is Rayleigh and therefore BLUE — see VH_DAY_HAZE_NEUTRAL in
    // render.js — so the haze is now the colour of the air rather than the colour of milk.
    fogColor: [0.185, 0.250, 0.375],
    fogDensity: 0.00026, fogHeight: 120, fogBase: 4, fogMax: 0.72,
    nightFactor: 0.0,
    windowLit: 0.04, windowGain: 0.0,
    cloudAmount: 0.45, cloudCover: 0.52, starAmount: 0.0,
    shadowColor: [0.42, 0.48, 0.62],
  },
  {
    name: 'Golden hour', clock: '19:40',
    // az 292 deg (WNW), el 7 deg — low warm sun, very long shadows down the east-west streets.
    // daylight 0.45: the sun is still the key, but it is 3 air masses deep and the sky behind it
    // has already started to go, so the image sits halfway between the two models.
    daylight: 0.45, exposure: 1.0,
    sunDir: [-0.920, 0.122, -0.372],
    keyDir: [-0.912, 0.170, -0.372],
    keyColor: [1.560, 0.940, 0.470],
    skyZenith: [0.075, 0.150, 0.330],
    skyHorizon: [0.330, 0.330, 0.340],
    skyWest: [0.880, 0.470, 0.180],
    ambientSky: [0.165, 0.185, 0.245],
    ambientGround: [0.075, 0.066, 0.056],
    streetColor: [0.030, 0.021, 0.012],
    skyBounce: 1.05,
    fogColor: [0.330, 0.280, 0.255],
    fogDensity: 0.00072, fogHeight: 85, fogBase: 4, fogMax: 0.86,
    nightFactor: 0.18,
    windowLit: 0.22, windowGain: 0.55,
    cloudAmount: 0.58, cloudCover: 0.50, starAmount: 0.0,
    shadowColor: [0.30, 0.31, 0.40],
  },
  { name: 'Blue hour', clock: '20:45', useRendererDefaults: true },
  {
    // The sun is 25 degrees below the horizon: daylight 0, so this runs the same blue-hour model
    // the default does, only darker.
    name: 'Night', clock: '23:30',
    daylight: 0.0, exposure: 1.0,
    sunDir: [-0.700, -0.420, -0.578],
    keyDir: [-0.690, 0.130, -0.572],
    keyColor: [0.115, 0.130, 0.205],
    skyZenith: [0.012, 0.020, 0.052],
    skyHorizon: [0.048, 0.086, 0.150],
    skyWest: [0.120, 0.098, 0.108],
    ambientSky: [0.055, 0.072, 0.115],
    ambientGround: [0.020, 0.022, 0.030],
    streetColor: [0.230, 0.162, 0.088],
    skyBounce: 1.60,
    fogColor: [0.038, 0.058, 0.092],
    fogDensity: 0.00135, fogHeight: 48, fogBase: 4, fogMax: 0.96,
    nightFactor: 1.0,
    windowLit: 0.60, windowGain: 1.85,
    cloudAmount: 0.50, cloudCover: 0.55, starAmount: 1.0,
    shadowColor: [0.12, 0.14, 0.22],
  },
];

export function snapshotEnv(env) {
  const snap = {};
  for (const k of Object.keys(env)) {
    const v = env[k];
    snap[k] = (v && v.length !== undefined && typeof v !== 'string') ? Array.from(v) : v;
  }
  return snap;
}

export function writeEnv(env, src) {
  for (const k of Object.keys(src)) {
    if (k === 'name' || k === 'clock' || k === 'useRendererDefaults') continue;
    if (!(k in env)) continue;
    const dst = env[k];
    const val = src[k];
    if (dst && dst.length !== undefined && val && val.length !== undefined) {
      for (let i = 0; i < dst.length && i < val.length; i++) dst[i] = val[i];
    } else if (typeof val === 'number') {
      env[k] = val;
    }
  }
}

/**
 * The live time-of-day selection. `defaults` is the renderer's own environment as it was before
 * the first preset was applied — blue hour, per CONTRACT §0 — and every apply() starts from it,
 * so a preset that omits a field cannot inherit the previous preset's value for it.
 */
export class TimeOfDay {
  constructor() {
    this.defaults = null;      // snapshot of the renderer's own blue-hour values
    this.index = 0;            // index into TIME_PRESETS; 0 = Afternoon, the default look
  }

  apply(env, i) {
    if (!this.defaults) this.defaults = snapshotEnv(env);
    this.index = ((i % TIME_PRESETS.length) + TIME_PRESETS.length) % TIME_PRESETS.length;
    const p = TIME_PRESETS[this.index];
    writeEnv(env, this.defaults);            // always start from a known state
    if (!p.useRendererDefaults) writeEnv(env, p);
    return p;
  }
}
