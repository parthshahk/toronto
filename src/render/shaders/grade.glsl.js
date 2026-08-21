// src/render/shaders/grade.glsl.js -- THE filmic grade, defined once.
//
// A gentle filmic curve with a hue-preserving peak rolloff, a split tone, a saturation push and
// a gamma lift, plus the daylight tone curve that replaces it under a sun. Every fragment
// shader that can end up writing the screen composes this, so the horizon (sky / fog / water)
// matches whichever path the frame took.
// 
// CONTRACT 3.2: the hue-preserving peak rolloff in vhFilmic must not be regressed.
// 
// No backticks in here -- see common.glsl.js.

// Shared grade: a gentle filmic curve with a shoulder, a split tone, a small saturation push and
// a light gamma lift. Used by EVERY fragment shader so the horizon (sky / fog / water) matches
// exactly whichever path the frame took.
export const GLSL_GRADE = `
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
