// src/main.js — boot, the free-roam camera, the loop and the 2D HUD for TORONTO.
//
// CONTRACT.md §3.3. FREE ROAM ONLY: no gameplay, no vehicles, no NPCs, no weapons. Two movement
// modes — WALK (eye at 1.7 m, gravity, terrain following, collision against real footprints) and
// FLY (6-DOF, no collision, speed scaling with altitude, for skyline views).
//
// World axes: X = east, Y = up, Z = south. Right-handed, TRUE METRES.
// Yaw follows math.js: forward = (sin yaw, 0, cos yaw), so yaw 0 faces +Z = SOUTH and a compass
// bearing (0 = north, 90 = east) is simply `PI - yaw`.
//
// BOTH CONTROL LAYOUTS ARE LIVE AT ONCE. input.js aliases the arrow keys and the right-hand
// cluster onto the canonical WASD codes, so every query below is written once against the
// canonical code and both layouts work. This is a hard user requirement — do not "simplify" it
// by reading physical codes.

import { createGL } from './gl.js';
import { Camera, Renderer } from './render.js';
import { loadCity } from './city.js';
import { Input } from './input.js';
import { clamp, damp, angleWrap, PI, RAD2DEG } from './math.js';

/* ================================================================ tunables == */

const EYE_HEIGHT = 1.7;          // metres, CONTRACT §3.3
// Deliberately NOT realistic. Real walking (1.4 m/s) crosses this 3.1 km map in 37 minutes,
// which makes exploring the city a chore. These are 'readable but brisk' speeds, and the whole
// lot is scaled live by player.speedMult (mouse wheel).
const WALK_SPEED = 7.0;          // m/s
const RUN_SPEED = 22.0;          // m/s — crosses downtown in ~2.5 min
const GRAVITY = 19.0;            // m/s^2 — a touch brisker than real, so drops do not float
const JUMP_SPEED = 7.4;          // m/s
const STEP_UP = 0.55;            // kerb / step tolerance, metres
const STEP_DOWN = 0.65;          // stay glued to the ground over this much drop
const BODY_RADIUS = 0.42;        // collision circle against building footprints
const WADE_FLOOR = -0.35;        // never sink to the lake bed; wade at the harbour edge instead

const FLY_SPEED = 85.0;          // m/s at street level
const FLY_ALT_SCALE = 1 / 95;    // speed multiplier gains 1 per 95 m of altitude above ground
const FLY_MAX_MULT = 9.0;
const FLY_BOOST = 4.5;

const LOOK_SENS = 0.0021;        // radians per mouse pixel
// Horizontal look is inverted by user preference: moving the mouse right turns the camera left.
// Flip these to +1 / -1 to swap either axis back.
const LOOK_INVERT_X = -1;
const LOOK_INVERT_Y = 1;
const MAX_PITCH = 1.5533;        // 89 degrees
const GROUND_ACCEL = 18.0;       // damp lambda — snappier to match the higher top speed
const AIR_ACCEL = 3.4;
const FLY_ACCEL = 9.0;

// Live speed dial so movement can be tuned without touching code: mouse wheel, or [ and ].
const SPEED_MULT_MIN = 0.15;
const SPEED_MULT_MAX = 12.0;

const FOV_BASE = 1.05;           // 60 degrees vertical
const FOV_BOOST = 1.16;

const WORLD_MARGIN = 320;        // metres of slack outside the mapped extent
const CEILING = 2400;            // metres — well clear of the 553 m CN Tower
const FLOOR = -60;

// --- near plane ------------------------------------------------------------------------------
// Depth resolution in a fixed-point buffer is 2^-24 * z^2 / near (see the Camera constructor in
// render.js for the full algebra), so the near plane is the whole of the daytime flicker on
// distant massing: at 0.3 m two surfaces have to be 20 cm apart at a kilometre before the depth
// test can reliably tell them apart, and 79 cm apart at two.
//
// The ceiling on the near plane is simply what the eye can get close to, so measure that instead
// of guessing one number for the whole city:
//   * height above the terrain. Looking straight down at MAX_PITCH the pavement is exactly
//     EYE_HEIGHT away and nothing can be nearer, so this is the shortest a downward ray gets.
//   * distance to the closest building footprint. Walking, collision already guarantees
//     BODY_RADIUS; flying there is no collision at all, so it is probed. The probe ladder runs
//     OUTWARD and stops at the first radius that hits, which makes the common case — open sky,
//     open water, the middle of a carriageway — four grid queries that all miss. Measured at
//     0.35 us over the lake, 0.65 us mid-street and 1.05 us pressed against a facade, against a
//     16.7 ms frame.
// Both are conservative: the probe is a 2-D footprint test, so a camera 200 m above a rooftop
// still reports the tower under it as "close" and keeps its near plane short. Whatever the two
// bounds say, only NEAR_SAFETY of it is taken, so a surface that is genuinely visible never
// crosses the plane.
//
// Worth, measured from the harbour at 15:20 by sweeping the depth mapping a fixed number of
// quantisation steps and counting the pixels whose winner flips: 12,103 at a flat 0.3 down to
// 6,018 here (-50%), and the summed flip magnitude 433,042 down to 226,565. What is left is
// surfaces that are EXACTLY coplanar — the stacked massing slabs the dataset carries for a
// single real building — and no amount of depth precision separates those; at a near plane of
// 24 m, 130x finer than anything shippable, the residual is unchanged.
const NEAR_MIN = 0.30;           // never shorter than the camera shipped with
const NEAR_MAX = 1.60;           // and never longer than the soffit of an elevated deck
const NEAR_SAFETY = 0.55;        // fraction of the measured clearance the plane may take
const NEAR_PROBE = [0.9, 1.8, 3.6, 7.2];   // footprint probe radii, ascending, metres

const ATTRIB_A = 'Buildings: City of Toronto Open Data (3D Massing 2025)';
const ATTRIB_B = '© OpenStreetMap contributors, ODbL';

// Renderer presets, cheapest last. `E` steps up, `Q` steps down.
const QUALITY_PRESETS = [
  { name: 'Ultra', q: { shadows: 'high', ssao: true, ssr: true, bloom: true, clouds: true, fxaa: true } },
  { name: 'High', q: { shadows: 'high', ssao: true, ssr: false, bloom: true, clouds: true, fxaa: true } },
  { name: 'Medium', q: { shadows: 'low', ssao: false, ssr: false, bloom: true, clouds: true, fxaa: true } },
  { name: 'Low', q: { shadows: 'off', ssao: false, ssr: false, bloom: true, clouds: false, fxaa: false } },
  { name: 'Minimal', q: { shadows: 'off', ssao: false, ssr: false, bloom: false, clouds: false, fxaa: false } },
];

// Places worth standing. Local metres, and a compass bearing rather than a raw yaw because that is
// how the coordinates were checked against the real street grid. Positions are re-grounded and
// pushed out of any footprint on arrival, so they cannot strand the camera inside a wall.
const VIEWPOINTS = [
  // THE START: out over the Inner Harbour in fly mode, looking north at the skyline. This is the
  // postcard angle -- the CN Tower against the Financial District with the water in front -- and it
  // shows what the project is in one frame. 'R' returns here.
  { name: 'The skyline from the lake', x: 300, y: 300, z: 1520, bearing: 350, pitch: -7, mode: 'fly' },
  { name: 'Over the harbour', x: 330, y: 340, z: 1180, bearing: 349, pitch: -9, mode: 'fly' },
  { name: 'Front St W at The Well', x: -628.4, z: 212.1, bearing: 70, pitch: 6, mode: 'walk' },
  { name: 'Front St W at Simcoe', x: 300, z: -90, bearing: 79, pitch: 5, mode: 'walk' },
  { name: 'Bay St at Wellington', x: 708.9, z: -371, bearing: 343, pitch: 24, mode: 'walk' },
  { name: 'King St W at Bay', x: 652.8, z: -515, bearing: 253, pitch: 12, mode: 'walk' },
  { name: 'Bremner Blvd, CN Tower', x: 169, z: 241.7, bearing: 340, pitch: 34, mode: 'walk' },
  { name: 'Harbourfront, York Quay', x: 455, z: 512, bearing: 333, pitch: 15, mode: 'walk' },
];

/* ================================================================== shell === */

const NOOP = () => {};

function getShell() {
  const w = (typeof window !== 'undefined') ? window : null;
  const s = w ? (w.VH_SHELL || null) : null;
  const bind = (name, fallback) => {
    if (s && typeof s[name] === 'function') {
      return (...args) => {
        try { return s[name](...args); } catch (e) { console.warn('[shell] ' + name + ' threw', e); }
        return undefined;
      };
    }
    return fallback;
  };
  return {
    setProgress: bind('setProgress', NOOP),
    hideLoading: bind('hideLoading', NOOP),
    showTitle: bind('showTitle', NOOP),
    hideTitle: bind('hideTitle', NOOP),
    onStart: bind('onStart', NOOP),
    showError: bind('showError', (msg, detail) => {
      console.error('[toronto] ' + msg + (detail ? '\n' + detail : ''));
    }),
  };
}

const SHELL = getShell();

// Yield to the browser. A bare requestAnimationFrame NEVER fires in a background tab, which would
// hang the boot forever, so it is raced against a timer and whichever wins resolves.
function nextFrame(timeoutMs = 12) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      try { window.requestAnimationFrame(fin); } catch (e) { /* fall through to the timer */ }
    }
    setTimeout(fin, timeoutMs);
  });
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function fin(v, dflt = 0) {
  return Number.isFinite(v) ? v : dflt;
}

/* ================================================================== state === */

const G = {
  ready: false,
  started: false,
  running: false,
  gl: null,
  canvas: null,
  hud: null,
  ctx: null,
  renderer: null,
  camera: null,
  city: null,
  input: null,
  player: null,
  viewpoints: VIEWPOINTS,
  quality: 0,
  timeOfDay: 0,        // index into TIME_PRESETS; 0 = Afternoon, the default look
  fps: 0,
  dt: 0,
  frames: 0,
  showHelp: false,
  showDebug: false,
  dpr: 1,
  cssW: 1,
  cssH: 1,
};

const player = {
  mode: 'fly',
  x: 0, y: 0, z: 0,          // y is the EYE height in BOTH modes — no conversion at the toggle
  vx: 0, vy: 0, vz: 0,
  yaw: 0, pitch: 0,
  grounded: false,
  speed: 0,
  warped: false,             // set by a teleport so the speed estimator skips that frame
  fov: FOV_BASE,
  viewpoint: 0,
  street: '',
};
G.player = player;

if (typeof window !== 'undefined') window.G = G;

/* ============================================================ geo helpers == */

// Inverse of city.js's projector: local metres -> lon/lat, for the HUD readout. Web Mercator with
// the build step's cos(lat0) scale divided out (CONTRACT §1).
function makeUnprojector(origin) {
  const R = 6378137.0;
  const d2r = PI / 180;
  const lat0 = (origin && Number.isFinite(origin.lat)) ? origin.lat : 43.644;
  const lon0 = (origin && Number.isFinite(origin.lon)) ? origin.lon : -79.3885;
  let k = Math.cos(lat0 * d2r);
  if (!(Math.abs(k) > 1e-6)) k = 1;
  const mx0 = R * lon0 * d2r;
  const my0 = R * Math.log(Math.tan(PI / 4 + (lat0 * d2r) / 2));
  return (x, z) => {
    const mx = mx0 + x / k;
    const my = my0 - z / k;
    const lon = mx / (R * d2r);
    const lat = (2 * Math.atan(Math.exp(my / R)) - PI / 2) / d2r;
    return [lon, lat];
  };
}

let unproject = makeUnprojector(null);

// Compass bearing (0 = north, 90 = east) from the yaw convention in math.js.
function yawToBearing(yaw) {
  let b = (PI - yaw) * RAD2DEG;
  b %= 360;
  if (b < 0) b += 360;
  return b;
}

function bearingToYaw(bearingDeg) {
  return angleWrap(PI - bearingDeg * (PI / 180));
}

/* ============================================================== viewpoints == */

function goToViewpoint(index) {
  const n = VIEWPOINTS.length;
  const i = ((index % n) + n) % n;
  const v = VIEWPOINTS[i];
  player.viewpoint = i;
  player.mode = v.mode === 'fly' ? 'fly' : 'walk';
  player.yaw = bearingToYaw(v.bearing);
  player.pitch = clamp(v.pitch * (PI / 180), -MAX_PITCH, MAX_PITCH);
  player.vx = 0; player.vy = 0; player.vz = 0;
  player.grounded = false;
  player.speed = 0;
  player.speedMult = 1;
  player.warped = true;

  let x = v.x;
  let z = v.z;
  if (G.city && player.mode === 'walk') {
    const c = G.city.collide(x, z, BODY_RADIUS);
    if (Number.isFinite(c.x) && Number.isFinite(c.z)) { x = c.x; z = c.z; }
  }
  player.x = x;
  player.z = z;

  if (player.mode === 'fly') {
    player.y = fin(v.y, 300);
  } else {
    const g = G.city ? fin(G.city.groundY(x, z), 0) : 0;
    player.y = Math.max(g, WADE_FLOOR) + EYE_HEIGHT;
    player.grounded = true;
  }
  return v;
}

/* ================================================================ quality == */

/* ------------------------------------------------------------------ time of day */

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
const TIME_PRESETS = [
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

let TIME_DEFAULTS = null;      // snapshot of the renderer's own blue-hour values

function snapshotEnv(env) {
  const snap = {};
  for (const k of Object.keys(env)) {
    const v = env[k];
    snap[k] = (v && v.length !== undefined && typeof v !== 'string') ? Array.from(v) : v;
  }
  return snap;
}

function writeEnv(env, src) {
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

function applyTime(i) {
  const env = G.renderer.env;
  if (!TIME_DEFAULTS) TIME_DEFAULTS = snapshotEnv(env);
  G.timeOfDay = ((i % TIME_PRESETS.length) + TIME_PRESETS.length) % TIME_PRESETS.length;
  const p = TIME_PRESETS[G.timeOfDay];
  writeEnv(env, TIME_DEFAULTS);            // always start from a known state
  if (!p.useRendererDefaults) writeEnv(env, p);
  return p;
}


function applyQuality(index) {
  const n = QUALITY_PRESETS.length;
  const i = ((index % n) + n) % n;
  G.quality = i;
  const r = G.renderer;
  if (!r) return QUALITY_PRESETS[i].name;
  const q = QUALITY_PRESETS[i].q;
  r.quality.shadows = q.shadows;
  r.quality.ssao = q.ssao;
  r.quality.ssr = q.ssr;
  r.quality.bloom = q.bloom;
  r.quality.clouds = q.clouds;
  r.quality.fxaa = q.fxaa;
  if (r.bloom) r.bloom.enabled = q.bloom;
  return QUALITY_PRESETS[i].name;
}

/* ================================================================== sizing == */

function sizeCanvases() {
  const w = (typeof window !== 'undefined') ? window : null;
  const cssW = Math.max(1, Math.floor(w ? (w.innerWidth || 1) : 1));
  const cssH = Math.max(1, Math.floor(w ? (w.innerHeight || 1) : 1));
  const dpr = clamp(fin(w ? w.devicePixelRatio : 1, 1), 0.5, 2);   // capped at 2 by contract
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));

  G.cssW = cssW;
  G.cssH = cssH;
  G.dpr = dpr;

  if (G.canvas && (G.canvas.width !== bw || G.canvas.height !== bh)) {
    G.canvas.width = bw;
    G.canvas.height = bh;
  }
  if (G.hud && (G.hud.width !== bw || G.hud.height !== bh)) {
    G.hud.width = bw;
    G.hud.height = bh;
  }
  if (G.ctx) G.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (G.renderer) G.renderer.resize(bw, bh);
  if (G.camera) G.camera.aspect = bw / bh;
}

/* ================================================================ movement == */

function readLook(input, dt) {
  if (!G.started) {
    // Slow drift over the title screen: the city introduces itself before anyone touches a key.
    player.yaw = angleWrap(player.yaw + 0.011 * dt);
    return;
  }
  // Live speed dial on the mouse wheel. Multiplicative so it feels even across the range.
  // NOTE: Q/E and [ ] are already the quality preset — do not double-bind them here.
  const w = fin(input.wheel, 0);
  if (w !== 0) player.speedMult *= Math.exp(-w * 0.0016);
  player.speedMult = clamp(player.speedMult, SPEED_MULT_MIN, SPEED_MULT_MAX);

  const dx = fin(input.mouseDX, 0);
  const dy = fin(input.mouseDY, 0);
  if (dx !== 0) player.yaw = angleWrap(player.yaw + dx * LOOK_SENS * LOOK_INVERT_X);
  if (dy !== 0) player.pitch = clamp(player.pitch - dy * LOOK_SENS * LOOK_INVERT_Y, -MAX_PITCH, MAX_PITCH);
}

function updateWalk(input, dt) {
  const city = G.city;
  const yaw = player.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);      // horizontal forward
  const rx = -Math.cos(yaw), rz = Math.sin(yaw);     // horizontal right

  let mf = 0, mr = 0;
  if (G.started) {
    mf = fin(input.axis('KeyS', 'KeyW'), 0);
    mr = fin(input.axis('KeyA', 'KeyD'), 0);
  }
  let wx = fx * mf + rx * mr;
  let wz = fz * mf + rz * mr;
  const wl = Math.hypot(wx, wz);
  if (wl > 1e-6) { wx /= wl; wz /= wl; } else { wx = 0; wz = 0; }

  const run = G.started && input.down('ShiftLeft');
  const target = Math.min(1, wl) * (run ? RUN_SPEED : WALK_SPEED) * player.speedMult;
  const lambda = player.grounded ? GROUND_ACCEL : AIR_ACCEL;
  player.vx = damp(player.vx, wx * target, lambda, dt);
  player.vz = damp(player.vz, wz * target, lambda, dt);

  if (G.started && player.grounded && input.pressed('Space')) {
    player.vy = JUMP_SPEED;
    player.grounded = false;
  }

  player.vy -= GRAVITY * dt;
  if (player.vy < -90) player.vy = -90;

  const oldX = player.x, oldZ = player.z;
  let nx = oldX + player.vx * dt;
  let nz = oldZ + player.vz * dt;

  // Circle-vs-footprint resolution against the real massing data. The feet go with it: a footprint
  // is only a wall to someone at its level, and without that a pedestrian is bounced out of every
  // underpass and building passage in the city by the structure carried OVER their head.
  const hit = city.collide(nx, nz, BODY_RADIUS, player.y - EYE_HEIGHT);
  if (Number.isFinite(hit.x) && Number.isFinite(hit.z)) { nx = hit.x; nz = hit.z; }

  // A step taller than the kerb tolerance is a wall: refuse the move rather than climbing it.
  const nextGround = Math.max(fin(city.groundY(nx, nz), 0), WADE_FLOOR);
  const feet = player.y - EYE_HEIGHT;
  if (player.grounded && nextGround - feet > STEP_UP) {
    nx = oldX;
    nz = oldZ;
  }

  player.x = nx;
  player.z = nz;
  player.y += player.vy * dt;

  // Recover the velocity actually achieved so sliding along a facade feels right instead of the
  // player pressing into it at full speed.
  if (dt > 1e-4) {
    player.vx = (player.x - oldX) / dt;
    player.vz = (player.z - oldZ) / dt;
  }

  const g = Math.max(fin(city.groundY(player.x, player.z), 0), WADE_FLOOR);
  const floor = g + EYE_HEIGHT;
  if (player.y <= floor) {
    player.y = floor;
    if (player.vy < 0) player.vy = 0;
    player.grounded = true;
  } else if (player.grounded && player.y - floor <= STEP_DOWN && player.vy <= 0) {
    player.y = floor;             // glue to the pavement over kerbs and shallow ramps
    player.vy = 0;
  } else {
    player.grounded = false;
  }
}

function updateFly(input, dt) {
  const yaw = player.yaw, pitch = player.pitch;
  const cp = Math.cos(pitch);
  const fx = Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = Math.cos(yaw) * cp;
  const rx = -Math.cos(yaw), rz = Math.sin(yaw);

  let mf = 0, mr = 0, mu = 0;
  if (G.started) {
    mf = fin(input.axis('KeyS', 'KeyW'), 0);
    mr = fin(input.axis('KeyA', 'KeyD'), 0);
    if (input.down('Space')) mu += 1;
    if (input.down('ControlLeft')) mu -= 1;
  }

  let dx = fx * mf + rx * mr;
  let dy = fy * mf + mu;
  let dz = fz * mf + rz * mr;
  const dl = Math.hypot(dx, dy, dz);
  if (dl > 1e-6) { dx /= dl; dy /= dl; dz /= dl; } else { dx = 0; dy = 0; dz = 0; }

  const ground = G.city ? fin(G.city.groundY(player.x, player.z), 0) : 0;
  const alt = Math.max(0, player.y - ground);
  let mult = clamp(1 + alt * FLY_ALT_SCALE, 1, FLY_MAX_MULT);
  if (G.started && input.down('ShiftLeft')) mult *= FLY_BOOST;
  const target = Math.min(1, dl) * FLY_SPEED * mult * player.speedMult;

  player.vx = damp(player.vx, dx * target, FLY_ACCEL, dt);
  player.vy = damp(player.vy, dy * target, FLY_ACCEL, dt);
  player.vz = damp(player.vz, dz * target, FLY_ACCEL, dt);

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.z += player.vz * dt;
  player.grounded = false;
}

function updatePlayer(input, dt) {
  if (!G.city) return;

  const prevX = player.x, prevY = player.y, prevZ = player.z;

  readLook(input, dt);

  if (G.started) {
    if (input.pressed('KeyF')) {
      player.mode = player.mode === 'walk' ? 'fly' : 'walk';
      player.vy = 0;
      player.grounded = false;
    }
    if (input.pressed('KeyH')) G.showHelp = !G.showHelp;
    if (input.pressed('KeyT')) applyTime(G.timeOfDay + 1);
    for (let i = 0; i < TIME_PRESETS.length; i++) {
      if (input.pressed('Digit' + (i + 1))) applyTime(i);
    }
    if (input.pressed('Backquote')) G.showDebug = !G.showDebug;
    if (input.pressed('KeyE')) applyQuality(G.quality - 1);   // "up" = a richer preset
    if (input.pressed('KeyQ')) applyQuality(G.quality + 1);
    if (input.pressed('KeyV')) goToViewpoint(player.viewpoint + 1);
    if (input.pressed('KeyR')) goToViewpoint(0);
    if (input.pressed('Escape')) input.exitLock();
  }

  if (player.mode === 'fly') updateFly(input, dt);
  else updateWalk(input, dt);

  // Keep the world bounded: the data stops at the extent and flying past it is just void.
  const ex = G.city.extent && Number.isFinite(G.city.extent.x) ? G.city.extent.x : 3141.7;
  const ez = G.city.extent && Number.isFinite(G.city.extent.z) ? G.city.extent.z : 2226.4;
  player.x = clamp(player.x, -ex / 2 - WORLD_MARGIN, ex / 2 + WORLD_MARGIN);
  player.z = clamp(player.z, -ez / 2 - WORLD_MARGIN, ez / 2 + WORLD_MARGIN * 4);
  player.y = clamp(player.y, FLOOR, CEILING);

  // Last line of defence. A single NaN anywhere above would poison the matrices forever, so the
  // camera is put back on Front Street instead.
  if (!Number.isFinite(player.x + player.y + player.z + player.yaw + player.pitch +
      player.vx + player.vy + player.vz)) {
    console.warn('[toronto] non-finite player state — resetting to the start viewpoint');
    goToViewpoint(0);
    return;
  }

  if (player.warped) {
    // A teleport is not motion: sampling it would report thousands of km/h for a second.
    player.warped = false;
    player.speed = 0;
  } else if (dt > 1e-4) {
    const inst = Math.hypot(player.x - prevX, player.y - prevY, player.z - prevZ) / dt;
    player.speed = damp(player.speed, Math.min(inst, 3000), 8, dt);
  }
  player.street = G.city.streetNameAt(player.x, player.z, 26) || '';
}

// Metres of empty space around the eye, conservatively. See the NEAR_* block for why this is
// measured rather than assumed, and why a 2-D footprint probe is the right kind of wrong.
function cameraClearance() {
  const city = G.city;
  if (!city) return NEAR_MIN;
  const x = player.x, z = player.z;
  if (!Number.isFinite(x + z + player.y)) return NEAR_MIN;

  let clear = NEAR_PROBE[NEAR_PROBE.length - 1];
  for (let i = 0; i < NEAR_PROBE.length; i++) {
    const c = city.collide(x, z, NEAR_PROBE[i]);
    // `hit` is set when a footprint lies inside the probe radius, so the first radius that hits
    // brackets the wall between it and the last one that missed. Take the pessimistic end.
    if (c && c.hit) { clear = i === 0 ? BODY_RADIUS : NEAR_PROBE[i - 1]; break; }
  }

  const above = player.y - fin(city.groundY(x, z), 0);
  if (Number.isFinite(above) && above < clear) clear = above;
  return clear > 0 ? clear : 0;
}

function cameraNear() {
  const c = cameraClearance() * NEAR_SAFETY;
  if (!Number.isFinite(c)) return NEAR_MIN;
  return c < NEAR_MIN ? NEAR_MIN : (c > NEAR_MAX ? NEAR_MAX : c);
}

function updateCamera(dt) {
  const cam = G.camera;
  const yaw = player.yaw, pitch = player.pitch;
  const cp = Math.cos(pitch);
  const fx = Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = Math.cos(yaw) * cp;

  const boost = (G.started && player.mode === 'fly' && G.input && G.input.down('ShiftLeft'));
  player.fov = damp(player.fov, boost ? FOV_BOOST : FOV_BASE, 4, dt);

  cam.pos[0] = player.x;
  cam.pos[1] = player.y;
  cam.pos[2] = player.z;
  cam.target[0] = player.x + fx;
  cam.target[1] = player.y + fy;
  cam.target[2] = player.z + fz;
  cam.fov = player.fov;

  // Near plane. Shortening is a SAFETY move — the eye just got close to something — so it lands
  // this frame; lengthening is only a precision gain, so it eases in and the depth quantisation
  // never steps in one frame. Nothing on screen moves either way: a perspective matrix's x and y
  // scales do not involve the near plane, only its z mapping does.
  const want = cameraNear();
  const cur = Number.isFinite(cam.near) ? cam.near : want;
  cam.near = want < cur ? want : damp(cur, want, 5, dt);

  cam.update();
}

/* ===================================================================== HUD == */

const HUD = {
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  sans: '"Helvetica Neue", Inter, -apple-system, "Segoe UI", system-ui, sans-serif',
  text: 'rgba(219, 232, 240, 0.92)',
  dim: 'rgba(150, 172, 188, 0.82)',
  faint: 'rgba(130, 152, 168, 0.55)',
  cyan: 'rgba(133, 194, 212, 0.92)',
  warm: 'rgba(205, 133, 85, 0.92)',
  rule: 'rgba(200, 220, 232, 0.20)',
};

function setFont(ctx, px, family, weight, spacing) {
  ctx.font = (weight ? weight + ' ' : '') + px + 'px ' + family;
  // letterSpacing is Chrome 99+/Safari 17.4+; assigning it elsewhere is an inert no-op.
  ctx.letterSpacing = spacing || '0px';
}

function hudRule(ctx, x, y, w) {
  ctx.fillStyle = HUD.rule;
  ctx.fillRect(x, y, w, 1);
}

function drawCompass(ctx, cx, top, width) {
  const bearing = yawToBearing(player.yaw);
  const half = width / 2;
  const span = 70;                       // degrees visible either side of centre
  const pxPerDeg = half / span;
  const baseY = top + 20;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const cards = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  for (let deg = 0; deg < 360; deg += 5) {
    let d = deg - bearing;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (Math.abs(d) > span) continue;
    const x = cx + d * pxPerDeg;
    const edge = 1 - Math.abs(d) / span;
    const a = clamp(edge * edge * 1.5, 0, 1);
    const major = (deg % 45) === 0;
    const mid = (deg % 15) === 0;
    const h = major ? 9 : (mid ? 6 : 3.5);
    ctx.fillStyle = major ? 'rgba(160, 205, 222, ' + (0.85 * a).toFixed(3) + ')'
      : 'rgba(180, 200, 214, ' + (0.42 * a).toFixed(3) + ')';
    ctx.fillRect(Math.round(x), baseY - h, 1, h);
    if (major) {
      setFont(ctx, 10, HUD.mono, '500', '0.14em');
      ctx.fillStyle = 'rgba(214, 232, 242, ' + (0.9 * a).toFixed(3) + ')';
      ctx.fillText(cards[(deg / 45) | 0], x, baseY + 12);
    }
  }

  // Centre index + numeric bearing.
  ctx.fillStyle = HUD.warm;
  ctx.fillRect(Math.round(cx), baseY - 13, 1, 13);
  setFont(ctx, 11, HUD.mono, '500', '0.1em');
  ctx.fillStyle = HUD.text;
  // Round first, then wrap: 359.7 must read 000, not 360.
  const shown = Math.round(bearing) % 360;
  ctx.fillText(String(shown).padStart(3, '0') + '°', cx, top + 46);
  ctx.restore();
}

function drawReticle(ctx, cx, cy) {
  ctx.save();
  ctx.fillStyle = 'rgba(219, 232, 240, 0.55)';
  ctx.fillRect(Math.round(cx) - 4, Math.round(cy), 3, 1);
  ctx.fillRect(Math.round(cx) + 2, Math.round(cy), 3, 1);
  ctx.fillRect(Math.round(cx), Math.round(cy) - 4, 1, 3);
  ctx.fillRect(Math.round(cx), Math.round(cy) + 2, 1, 3);
  ctx.restore();
}

const HELP_ROWS = [
  ['Move', 'W A S D', '↑ ← ↓ →'],
  ['Look', 'Mouse', 'Mouse'],
  ['Speed dial', 'Wheel', 'Wheel'],
  ['Time of day', 'T', ';'],
  ['  jump to a time', '1 - 4', 'Num 1 3 7 9'],
  ['Run / boost', 'Shift', 'R-Shift'],
  ['Jump / ascend', 'Space', '/  Num0'],
  ['Descend', 'L-Ctrl', 'R-Ctrl'],
  ['Walk / fly', 'F', '.'],
  ['Quality  -  /  +', 'Q   E', '[   ]'],
  ['Next viewpoint', 'V', '\''],
  ['Back to the start', 'R', ','],
  ['Help', 'H', '-'],
  ['Diagnostics', '`', 'End'],
  ['Release mouse', 'Esc', 'Backspace'],
];

function drawHelp(ctx, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(5, 9, 16, 0.90)';
  ctx.fillRect(0, 0, w, h);

  const panelW = Math.min(560, w - 56);
  const rowH = 21;
  const panelH = HELP_ROWS.length * rowH + 118;
  const x = Math.round((w - panelW) / 2);
  const y = Math.round((h - panelH) / 2);

  ctx.fillStyle = 'rgba(9, 16, 27, 0.92)';
  ctx.fillRect(x, y, panelW, panelH);
  ctx.strokeStyle = 'rgba(133, 194, 212, 0.38)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, panelW, panelH);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  setFont(ctx, 12, HUD.mono, '500', '0.28em');
  ctx.fillStyle = HUD.cyan;
  ctx.fillText('CONTROLS', x + 26, y + 38);

  ctx.textAlign = 'right';
  setFont(ctx, 9.5, HUD.mono, '500', '0.18em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText('BOTH LAYOUTS LIVE', x + panelW - 26, y + 38);

  hudRule(ctx, x + 26, y + 50, panelW - 52);

  let ry = y + 74;
  for (let i = 0; i < HELP_ROWS.length; i++) {
    const r = HELP_ROWS[i];
    ctx.textAlign = 'left';
    setFont(ctx, 12, HUD.sans, '300', '0.02em');
    ctx.fillStyle = HUD.text;
    ctx.fillText(r[0], x + 26, ry);

    ctx.textAlign = 'right';
    setFont(ctx, 11.5, HUD.mono, '500', '0.06em');
    ctx.fillStyle = HUD.cyan;
    ctx.fillText(r[1], x + panelW - 132, ry);
    ctx.fillStyle = HUD.warm;
    ctx.fillText(r[2], x + panelW - 26, ry);
    ry += rowH;
  }

  hudRule(ctx, x + 26, ry - 12, panelW - 52);
  ctx.textAlign = 'left';
  setFont(ctx, 9.5, HUD.mono, '400', '0.16em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText('H CLOSES THIS', x + 26, ry + 12);
  ctx.restore();
}

function drawHud(input) {
  const ctx = G.ctx;
  if (!ctx) return;
  const w = G.cssW, h = G.cssH;
  ctx.clearRect(0, 0, w, h);
  if (!G.started || !G.city) return;

  const M = 24;
  ctx.textBaseline = 'alphabetic';

  /* ---- top left: where you are ---- */
  ctx.textAlign = 'left';
  setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(player.mode === 'fly' ? 'FLY' : 'ON FOOT', M, M + 2);

  const street = player.street || 'Downtown Toronto';
  setFont(ctx, 19, HUD.sans, '200', '0.09em');
  ctx.fillStyle = HUD.text;
  ctx.fillText(street.toUpperCase(), M, M + 26);
  const nameW = Math.max(150, Math.min(360, ctx.measureText(street.toUpperCase()).width));
  hudRule(ctx, M, M + 34, nameW);

  /* ---- top centre: compass ---- */
  drawCompass(ctx, Math.round(w / 2), M - 6, Math.min(460, Math.max(220, w * 0.36)));

  /* ---- top right: frame rate + quality ---- */
  ctx.textAlign = 'right';
  setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText('QUALITY', w - M, M + 2);
  setFont(ctx, 13, HUD.mono, '500', '0.1em');
  ctx.fillStyle = HUD.cyan;
  ctx.fillText(QUALITY_PRESETS[G.quality].name.toUpperCase(), w - M, M + 22);
  const tp = TIME_PRESETS[G.timeOfDay];
  setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(tp.name.toUpperCase() + '  ' + tp.clock, w - M, M + 40);
  setFont(ctx, 11, HUD.mono, '400', '0.1em');
  ctx.fillStyle = HUD.dim;
  ctx.fillText(G.fps.toFixed(0) + ' FPS', w - M, M + 58);
  // Live speed dial (mouse wheel / [ ]). Only worth showing once it is off the default.
  const sm = fin(player.speedMult, 1);
  if (Math.abs(sm - 1) > 0.02) {
    ctx.fillStyle = HUD.cyan;
    ctx.fillText('SPEED x' + (sm >= 1 ? sm.toFixed(1) : sm.toFixed(2)), w - M, M + 76);
  }

  /* ---- bottom left: coordinates, altitude, speed ---- */
  const ll = unproject(player.x, player.z);
  const ground = fin(G.city.groundY(player.x, player.z), 0);
  const lines = [
    'X ' + (player.x >= 0 ? '+' : '') + player.x.toFixed(1) + '  Z ' +
      (player.z >= 0 ? '+' : '') + player.z.toFixed(1) + '  m',
    'LAT ' + ll[1].toFixed(5) + '  LON ' + ll[0].toFixed(5),
    'ALT ' + player.y.toFixed(1) + ' m  ·  AGL ' + Math.max(0, player.y - ground).toFixed(1) + ' m',
    'SPD ' + player.speed.toFixed(1) + ' m/s  ·  ' + (player.speed * 3.6).toFixed(0) + ' km/h',
  ];
  // Under ~720 px the two bottom blocks would collide, and the attribution is not allowed to be
  // clipped or overdrawn — so it moves to its own centred pair of lines and the readout moves up.
  const narrow = w < 720;
  ctx.textAlign = 'left';
  setFont(ctx, 11, HUD.mono, '400', '0.07em');
  let ly = h - M - (narrow ? 74 : 46);
  hudRule(ctx, M, ly - 16, 210);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0 ? HUD.text : HUD.dim;
    ctx.fillText(lines[i], M, ly);
    ly += 15;
  }

  /* ---- mandatory attribution ---- */
  setFont(ctx, 9.5, HUD.mono, '400', '0.1em');
  ctx.fillStyle = HUD.faint;
  if (narrow) {
    ctx.textAlign = 'center';
    ctx.fillText(ATTRIB_A, w / 2, h - M + 1);
    ctx.fillText('Streets: ' + ATTRIB_B, w / 2, h - M + 14);
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(ATTRIB_A, w - M, h - M - 13);
    ctx.fillText('Streets: ' + ATTRIB_B, w - M, h - M);
  }

  /* ---- centre: reticle, and the pointer-lock hint ---- */
  if (!G.showHelp) drawReticle(ctx, w / 2, h / 2);
  if (input && !input.locked) {
    ctx.textAlign = 'center';
    setFont(ctx, 10, HUD.mono, '500', '0.24em');
    ctx.fillStyle = HUD.warm;
    ctx.fillText('CLICK TO LOOK AROUND', w / 2, h - M - (narrow ? 104 : 26));
  }

  /* ---- diagnostics ---- */
  if (G.showDebug) {
    const st = G.renderer ? G.renderer.stats : null;
    const cs = G.city.stats || {};
    const q = G.renderer ? G.renderer._q : null;
    const inside = G.city.buildingAt(player.x, player.z);
    const dbg = [
      'draws ' + (st ? st.draws : 0) + '  tris ' + (st ? st.tris.toLocaleString() : 0) +
        '  shadow ' + (st ? st.shadowDraws : 0) + '  post ' + (st ? st.postPasses : 0),
      'city ' + (cs.buildings || 0) + ' bldgs  ' + (cs.roads || 0) + ' ways  ' +
        ((cs.verts || 0)).toLocaleString() + ' verts  ' + (cs.seconds || 0).toFixed(2) + ' s',
      q ? ('shadows ' + q.shadows + '  ssao ' + (q.ssao ? 'on' : 'off') + '  ssr ' +
        (q.ssr ? 'on' : 'off') + '  bloom ' + (q.bloom ? 'on' : 'off') + '  fxaa ' +
        (q.fxaa ? 'on' : 'off')) : 'renderer quality unavailable',
      'grounded ' + (player.grounded ? 'yes' : 'no') + '  inside footprint ' +
        (inside ? 'YES h=' + inside.h.toFixed(0) + ' m' : 'no') +
        '  dpr ' + G.dpr.toFixed(2) + '  ' + G.cssW + '×' + G.cssH,
    ];
    ctx.textAlign = 'left';
    setFont(ctx, 10, HUD.mono, '400', '0.04em');
    let dy = M + 62;
    for (let i = 0; i < dbg.length; i++) {
      ctx.fillStyle = HUD.faint;
      ctx.fillText(dbg[i], M, dy);
      dy += 14;
    }
  }

  if (G.showHelp) drawHelp(ctx, w, h);
}

/* ==================================================================== loop == */

let lastMs = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function renderScene() {
  const r = G.renderer;
  const m = G.city.meshes;
  r.beginFrame(G.camera);
  r.drawMesh(m.terrain);
  r.drawMesh(m.roads);
  r.drawMesh(m.sidewalks);
  r.drawMesh(m.rails);
  r.drawMesh(m.buildings);
  r.drawMesh(m.glass);
  r.drawMesh(m.props);
  r.drawWater(m.water, G.camera);
  r.endFrame();
}

function frame(tMs) {
  scheduleFrame();

  const t = Number.isFinite(tMs) ? tMs : nowMs();
  let dt = (t - lastMs) / 1000;
  lastMs = t;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  if (dt > 0.1) dt = 0.1;                 // a stalled tab must not teleport the camera
  G.dt = dt;
  G.frames++;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.4) {
    G.fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  const input = G.input;
  try {
    updatePlayer(input, dt);
    updateCamera(dt);

    if (!G.renderer.contextLost) {
      G.renderer.env.time = (G.renderer.env.time + dt) % 100000;
      renderScene();
    }
    drawHud(input);
  } catch (err) {
    G.running = false;
    console.error('[toronto] the frame loop threw', err);
    SHELL.showError('The render loop stopped.', (err && err.stack) ? err.stack : String(err));
    return;
  } finally {
    if (input) input.endFrame();
  }
}

let rafHandle = 0;
function scheduleFrame() {
  if (!G.running) return;
  const w = (typeof window !== 'undefined') ? window : null;
  if (w && typeof w.requestAnimationFrame === 'function') rafHandle = w.requestAnimationFrame(frame);
  else rafHandle = setTimeout(() => frame(nowMs()), 16);
}

/* ==================================================================== boot == */

async function boot() {
  SHELL.setProgress(0.01, 'starting');

  const doc = (typeof document !== 'undefined') ? document : null;
  if (!doc) throw new Error('no document — index.html must load src/main.js as a module');
  const canvas = doc.getElementById('gl');
  const hud = doc.getElementById('hud');
  if (!canvas || !hud) throw new Error('index.html is missing the #gl and/or #hud canvas');
  G.canvas = canvas;
  G.hud = hud;
  G.ctx = hud.getContext('2d');

  sizeCanvases();

  let gl;
  try {
    gl = createGL(canvas);
  } catch (err) {
    const e = new Error('This browser could not create a WebGL2 context.');
    e.stack = 'WebGL2 is required and is either unsupported or disabled here.\n' +
      'Original error: ' + ((err && err.message) ? err.message : String(err));
    throw e;
  }
  G.gl = gl;

  SHELL.setProgress(0.03, 'compiling shaders');
  await nextFrame();

  G.renderer = new Renderer(gl);
  G.camera = new Camera();
  G.input = new Input(canvas);
  applyQuality(0);
  applyTime(G.timeOfDay);
  sizeCanvases();

  // A context loss takes every VBO in the process with it, and the city's geometry can only be
  // rebuilt by re-reading 3 MB of JSON. Say so honestly: the renderer then surfaces a
  // "reload the page" panel through the shell instead of drawing an empty world.
  G.renderer.onContextRestored(() => false);

  SHELL.setProgress(0.05, 'loading city data');
  await nextFrame();

  G.city = await loadCity(gl, './data/toronto.json', (frac, label) => {
    SHELL.setProgress(0.05 + clamp(fin(frac, 0), 0, 1) * 0.93, label || 'building the city');
  });
  unproject = makeUnprojector(G.city.meta && G.city.meta.origin);

  // Towers, their glazing and the street furniture cast; the ground plane and the ribbons only
  // receive. `props` belongs in this list: it carries the 982 street trees, 2,062 lamps, 1,612
  // parked cars, 360 signals, 1,110 catenary poles and every shelter and planter in the city, and
  // at 15:20 with the sun 48 degrees up every one of those throws a hard shadow onto the pavement.
  // Leaving it out was most of why the daylight street read flat: measured at Bathurst & Queen the
  // carriageway came back 3.6 luma brighter and completely unbroken, with no tree or pole shadow
  // anywhere in the frame. Adding it newly shadows 3.4-5.3% of a sunlit street.
  //
  // It is safe for the benchmark. The shadow factor only ever scales the DIRECT key term, and at
  // blue hour and at night the key is a weak dusk fill that the props barely occlude: measured
  // per band at three vantages, blue hour moves at most 0.11 luma and night at most 0.16, against
  // the 3.6 the daylight roadway moves. Cost is one extra draw per cascade (~2.7 ms at 1440x900
  // on an M1 Pro, which leaves the frame well clear of the 60 fps floor in CONTRACT section 4).
  G.renderer.setShadowCasters([
    G.city.meshes.buildings, G.city.meshes.glass, G.city.meshes.props,
  ]);

  goToViewpoint(0);
  updateCamera(0.016);
  sizeCanvases();

  // One frame before the title screen appears, so the overlay sits over the real skyline.
  if (!G.renderer.contextLost) renderScene();

  SHELL.setProgress(1, 'ready');
  await nextFrame(20);

  G.ready = true;
  SHELL.hideLoading();
  SHELL.showTitle();

  SHELL.onStart(() => {
    if (G.started) return;
    G.started = true;
    // readLook() yaws the camera slowly while the title is up, which is the point — but after a
    // minute on the title screen that drift is tens of degrees and the composed opening shot
    // (Front St W looking east, CN Tower dead ahead — the CONTRACT §4 walk) is gone. Re-seat the
    // current viewpoint so the first frame of play is always the framing that was authored.
    goToViewpoint(player.viewpoint);
    updateCamera(0.016);
    SHELL.hideTitle();
    G.input.requestLock();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', sizeCanvases);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', sizeCanvases);
    }
  }
  // Re-acquire pointer lock after Esc without going back to the title screen.
  canvas.addEventListener('mousedown', () => {
    if (G.started && G.input && !G.input.locked) G.input.requestLock();
  });

  lastMs = nowMs();
  G.running = true;
  scheduleFrame();

  console.log('[toronto] ready — ' + G.city.stats.buildings + ' buildings, ' +
    G.city.stats.verts.toLocaleString() + ' vertices. window.G is live.');
}

boot().catch((err) => {
  G.running = false;
  console.error('[toronto] boot failed', err);
  const msg = (err && err.message) ? err.message : 'Toronto could not start.';
  const detail = (err && err.stack) ? err.stack : String(err);
  SHELL.showError(msg, detail);
});

export default G;
