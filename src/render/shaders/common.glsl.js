// src/render/shaders/common.glsl.js -- GLSL shared by EVERY stage.
//
// Hashes and value noise, the octahedral normal packing the material target uses, the blue-hour
// and daylight sky models, height fog with its aerial-perspective and horizon terms, the GGX
// lobe, and the albedo model that turns a baked blue-hour colour back into a reflectance.
// 
// Composed into a program by string interpolation, so a change here reaches the scene, sky,
// water, text and post passes at once -- which is the point: the scene and water shaders
// reflect the SAME sky function the sky shader draws.
// 
// NEVER put a backtick inside this GLSL, or inside a comment in it. It lives in a template
// literal and a stray backtick terminates the string.

// Everything shared between stages: hashes, the octahedral normal packing used by the material
// buffer, the blue-hour sky model (the scene and water shaders reflect the SAME function the sky
// shader draws, so a glass tower reflects exactly the sky above it), height fog, the GGX lobe and
// the shared filmic grade.
export const GLSL_COMMON = `
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
