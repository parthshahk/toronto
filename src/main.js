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
import { TouchControls, TOUCH_HELP_ROWS, detectPointer } from './touch.js';
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

// Backing-store resolution. 2 on the desktop by contract. A phone reports 3 with a GPU a small
// fraction the size, and 3x on a 6-inch panel is 2.25x the pixels of 2x for a difference nobody
// can resolve at arm's length — so a TOUCH-PRIMARY device (a phone or tablet, never a desktop and
// never a touchscreen laptop) caps lower and spends the pixels on frame rate instead.
//
// The whole of this is fill rate: the deferred-ish pipeline here writes the scene target, an SSAO
// pass, an SSR pass, three bloom levels and an FXAA resolve, so every backing-store pixel is
// touched six to ten times. 375 x 812 at the device's own DPR 3 is 2.74 Mpix — MORE than a
// 1440 x 900 desktop window at DPR 1 — on a GPU with a tenth the bandwidth. At 1.5 it is 685 k.
const DPR_CAP = 2;              // desktop and hybrid, by contract — unchanged
const DPR_CAP_TABLET = 1.75;
const DPR_CAP_PHONE = 1.5;
const DPR_CAP_PHONE_LOW = 1.25;
const DPR_MIN = 0.8;            // the adaptive floor; below this the city stops reading as geometry
// The 2D HUD is text and hairlines and costs microseconds, so it is NOT dropped with the scene:
// the two canvases carry different backing stores, and the type stays crisp on a 3x panel while
// the city renders at 1.5x underneath it. This is the single biggest legibility win on a phone.
const HUD_DPR_CAP = 2.5;
let dprCap = DPR_CAP;
let dprScale = 1;               // adaptive multiplier on dprCap; 1 = the device's full share

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
const Q_ULTRA = 0, Q_HIGH = 1, Q_MEDIUM = 2, Q_LOW = 3, Q_MINIMAL = 4;

/* ================================================================= device == */

// WHAT KIND OF MACHINE IS THIS, and what should it open on? Nothing here is a user-agent sniff:
// every input is a capability the browser reports about itself, so a device nobody has heard of
// still lands somewhere sensible, and a desktop cannot be mistaken for a phone by a string.
//
//   pointer     src/touch.js's detectPointer() — coarse/fine/touch, reported honestly
//   viewport    the CSS pixel size. A 6.1-inch phone is 390 x 844; an iPad is 1024 x 1366
//   deviceMemory     GiB, Chromium only, quantised to 0.25/0.5/1/2/4/8
//   hardwareConcurrency   logical cores; Safari reports it, and a phone reports its big cores
//
// The three classes want genuinely different things, so they are kept apart rather than scaled
// off one number:
//   desktop   everything as it was. A touchscreen laptop is a DESKTOP: it has a real GPU, and
//             capping its resolution because a digitizer exists would be a straight regression.
//   tablet    a large coarse-pointer screen. Real GPU budget, but a mobile memory ceiling.
//   phone     small, coarse, and the GPU is a fraction of a laptop's with no fan behind it.
const DEVICE_PROFILES = {
  desktop: {
    dprCap: DPR_CAP,
    startQuality: Q_ULTRA, bestQuality: Q_ULTRA,
    tiles: null,                 // the contract's tuning, untouched
    shadowDistance: 0,           // 0 = leave the renderer's own value alone
  },
  tablet: {
    dprCap: DPR_CAP_TABLET,
    startQuality: Q_MEDIUM, bestQuality: Q_HIGH,
    tiles: { massScale: 0.70, detailScale: 0.55, vertexCap: 8.0e6, budgetMs: 3.0 },
    shadowDistance: 1700,
  },
  phone: {
    dprCap: DPR_CAP_PHONE,
    startQuality: Q_MEDIUM, bestQuality: Q_HIGH,
    tiles: { massScale: 0.52, detailScale: 0.38, vertexCap: 6.0e6, budgetMs: 2.4 },
    shadowDistance: 1250,
  },
  phoneLow: {
    dprCap: DPR_CAP_PHONE_LOW,
    startQuality: Q_LOW, bestQuality: Q_MEDIUM,
    tiles: { massScale: 0.40, detailScale: 0.30, vertexCap: 3.6e6, budgetMs: 1.9 },
    shadowDistance: 950,
  },
};

// A resident vertex is 12 floats = 48 bytes of VBO (CONTRACT §2), so the caps above are a MEMORY
// budget first and a speed one second — the frame cost is driven by the tiles inside the frustum,
// not by the ones sitting in the buffer behind the camera. 11 M vertices is 528 MB of buffer
// objects, several times what a mobile browser hands one tab before it kills it; 6 M is 288 MB
// and 3.6 M is 173 MB, on top of ~50-80 MB of render targets and shadow maps.
const VERT_BYTES = 48;

// WHY THE RANGES ARE CUT SO MUCH FURTHER THAN THE CAP IS. tiles.js's level-of-detail valve gives
// up the MOST DETAILED stage first, all the way to its floor, before massing surrenders a metre —
// which is right for a desktop, where the silhouette is the thing. Measured downtown, a 625 m
// tile is ~65 k vertices of massing and ~420 k of street detail, so a cap that massing alone can
// fill leaves detail pinned at its 0.12 floor: a 62 m radius of street furniture, which is a
// pedestrian walking through an empty model of Toronto. The massing range is therefore set so
// massing FITS with room to spare, and the detail range buys back what is left.
//
// A 296 m detail radius is not a grudging compromise on a phone, either. A 9.5 m cobra lamp at
// 500 m subtends 9 px on a 375 px screen at DPR 1.5; at 250 m it is 18 px. Past ~300 m the street
// furniture is costing 420 k vertices a tile to render something under a centimetre wide.

function deviceProfile(caps) {
  const nav = (typeof navigator !== 'undefined') ? navigator : null;
  const win = (typeof window !== 'undefined') ? window : null;
  const vw = Math.max(1, fin(win ? win.innerWidth : 1280, 1280));
  const vh = Math.max(1, fin(win ? win.innerHeight : 800, 800));
  const longSide = Math.max(vw, vh);
  const mem = (nav && Number.isFinite(nav.deviceMemory)) ? nav.deviceMemory : 0;
  const cores = (nav && Number.isFinite(nav.hardwareConcurrency)) ? nav.hardwareConcurrency : 0;

  // `primary` is coarse-pointer AND no mouse: a phone or a tablet. A hybrid keeps the desktop
  // profile because it has the hardware for it — touch is added to that machine, not substituted.
  let key = 'desktop';
  if (caps && caps.primary) {
    // A phone in landscape is still a phone, so the LONG side decides. 950 px sits above every
    // phone in landscape (a Pro Max is 932) and below every tablet (an iPad mini is 1024).
    if (longSide < 950) {
      // Both signals are optional and both are quantised, so either one alone is enough to say
      // "small". Unknown on both (older iOS Safari) means the middle profile, which the adaptive
      // step then corrects within a few seconds from real frame times.
      const weak = (mem > 0 && mem <= 3) || (cores > 0 && cores <= 4);
      key = weak ? 'phoneLow' : 'phone';
    } else {
      key = 'tablet';
    }
  }
  const p = DEVICE_PROFILES[key];
  return {
    key,
    caps: caps || null,
    dprCap: p.dprCap,
    startQuality: p.startQuality,
    bestQuality: p.bestQuality,
    tiles: p.tiles,
    shadowDistance: p.shadowDistance,
    mem, cores, vw, vh,
    // Only a touch-primary device gets the resolution and geometry cuts; everything else is
    // exactly the machine the contract was tuned on.
    mobile: key !== 'desktop',
  };
}

let DEVICE = deviceProfile(null);

// Places worth standing. Local metres, and a compass bearing rather than a raw yaw because that is
// how the coordinates were checked against the real street grid. Positions are re-grounded and
// pushed out of any footprint on arrival, so they cannot strand the camera inside a wall.
//
// RE-PROJECTED for the expanded extent. These were authored against the old bounding box, whose
// origin was (-79.38850, 43.64400); the extract now originates at (-79.38700, 43.63500), which
// moves every local coordinate by (-120.9, -1002.0) m. The framings are unchanged — each one was
// carried back through the old projector to lon/lat and forward through the new one, and every
// walking viewpoint was re-checked against streetNameAt(): Front Street West, Bay Street, King
// Street West, Bremner Boulevard, Waterfront Recreational Trail. Left alone they land a kilometre
// out in the harbour.
const VIEWPOINTS = [
  // THE START: out over the Inner Harbour in fly mode, looking north at the skyline. This is the
  // postcard angle -- the CN Tower against the Financial District with the water in front -- and it
  // shows what the project is in one frame. 'R' returns here.
  { name: 'The skyline from the lake', x: 179.2, y: 300, z: 518.3, bearing: 350, pitch: -7, mode: 'fly' },
  { name: 'Over the harbour', x: 209.2, y: 340, z: 178.2, bearing: 349, pitch: -9, mode: 'fly' },
  { name: 'Front St W at The Well', x: -749.3, z: -789.8, bearing: 70, pitch: 6, mode: 'walk' },
  { name: 'Front St W at Simcoe', x: 179.2, z: -1092.0, bearing: 79, pitch: 5, mode: 'walk' },
  { name: 'Bay St at Wellington', x: 588.2, z: -1373.0, bearing: 343, pitch: 24, mode: 'walk' },
  { name: 'King St W at Bay', x: 532.0, z: -1517.0, bearing: 253, pitch: 12, mode: 'walk' },
  { name: 'Bremner Blvd, CN Tower', x: 48.2, z: -760.2, bearing: 340, pitch: 34, mode: 'walk' },
  { name: 'Harbourfront, York Quay', x: 334.2, z: -489.9, bearing: 333, pitch: 15, mode: 'walk' },
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
    setInputMode: bind('setInputMode', NOOP),
    safeInsets: bind('safeInsets', () => null),
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
  touch: null,
  player: null,
  viewpoints: VIEWPOINTS,
  quality: 0,
  cursorReleased: false,   // true once the cursor was released on purpose (dbl-click / Esc)
  timeOfDay: 0,        // index into TIME_PRESETS; 0 = Afternoon, the default look
  fps: 0,
  dt: 0,
  frames: 0,
  bootMs: 0,          // page load to the first interactive frame, filled in by boot()
  showHelp: false,
  showDebug: false,
  dpr: 1,             // GL backing-store scale
  hudDpr: 1,          // 2D HUD backing-store scale — deliberately allowed to be higher
  cssW: 1,
  cssH: 1,
  // Safe-area insets in CSS pixels, refreshed on every resize from the #safe probe in index.html.
  // Every HUD anchor is measured from these, not from the edge of the glass.
  safe: { top: 0, right: 0, bottom: 0, left: 0 },
  device: DEVICE,
  auto: null,         // the adaptive-quality controller, filled in by boot()
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

/**
 * Walk <-> fly. The on-screen WALK button carries a landing point with it: tapping it on a phone
 * puts the player on the pavement under the MIDDLE OF THE SCREEN — the place they were looking
 * at — instead of under a camera that may be a kilometre up and half a mile short. The `F` key
 * keeps its own long-standing behaviour (toggle in place, then fall) and does not come through
 * here.
 */
function setMovementMode(mode, x, z) {
  const walk = mode === 'walk';
  player.mode = walk ? 'walk' : 'fly';
  player.vx = 0;
  player.vy = 0;
  player.vz = 0;
  player.grounded = false;
  if (!walk) return;

  const b = worldBounds(WORLD_BOUNDS);
  let px = clamp(Number.isFinite(x) ? x : player.x, b.minX, b.maxX);
  let pz = clamp(Number.isFinite(z) ? z : player.z, b.minZ, b.maxZ);
  if (G.city) {
    const c = G.city.collide(px, pz, BODY_RADIUS);
    if (Number.isFinite(c.x) && Number.isFinite(c.z)) { px = c.x; pz = c.z; }
  }
  player.x = px;
  player.z = pz;
  const g = G.city ? Math.max(fin(G.city.groundY(px, pz), 0), WADE_FLOOR) : 0;
  player.y = g + EYE_HEIGHT;
  player.pitch = clamp(player.pitch, -0.5, 0.5);   // arriving nose-down at the pavement is grim
  player.grounded = true;
  player.warped = true;
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


function applyQuality(index, manual) {
  const n = QUALITY_PRESETS.length;
  const i = ((index % n) + n) % n;
  G.quality = i;
  const r = G.renderer;
  // A deliberate press is the end of the argument: the adaptive step stops second-guessing the
  // user for the rest of the session. It says so in the HUD, so this is never a silent change.
  if (manual) autoStop('manual');
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

/**
 * The on-screen GFX button. A phone has no Q/E pair to hold, so one button steps DOWN through the
 * presets and wraps back to the richest one this device is allowed to run — cycling a phone up
 * into Ultra, where screen-space reflections cost more than the rest of the frame put together,
 * would only be a hole the next two taps have to climb out of.
 */
function cycleQuality() {
  const last = QUALITY_PRESETS.length - 1;
  const best = clamp(fin(DEVICE.bestQuality, Q_ULTRA), 0, last);
  const next = G.quality >= last ? best : Math.max(best, G.quality + 1);
  return applyQuality(next, true);
}

/* --------------------------------------------------------- adaptive quality */

// MEASURE, THEN MOVE. A starting preset chosen from deviceMemory and a viewport size is a guess:
// two phones that report the same numbers can differ by 4x in fill rate, and the same phone
// differs by 2x between "just picked up" and "warm, in a case, at 20% battery". So the opening
// preset is only the first hypothesis and real frame times settle the argument.
//
// THE LADDER. One ordered list of rungs, richest first, so "step down" is always a single index
// and the controller cannot produce a combination nobody has looked at. The quality presets come
// first; resolution is given up only after every preset has been, because a soft image is a worse
// trade than no SSAO right up until the point where nothing else is left.
//
// WHY IT CANNOT OSCILLATE. Three independent brakes, any one of which would be enough:
//   1. A wide deadband. Down at 29 ms (34 fps), up at 18 ms (55 fps). A device sitting anywhere
//      between those two never moves at all.
//   2. Asymmetric dwell. 2 s must pass before a second step down; 9 s of unbroken headroom before
//      any step up. Stepping down is a rescue and should be quick; stepping up is a luxury.
//   3. REGRET IS PERMANENT. If a step up to rung r is followed by a step down within 12 s, rung r
//      is struck off for the session. Every rung therefore gets at most ONE probe, so the total
//      number of changes over a session is bounded by (rungs + probes) — it is not a control loop
//      that can hunt, it is a search that terminates.
//
// The judged statistic is the 60th percentile of the last 150 frames rather than the mean: a tile
// build costs a few milliseconds on the frame it lands and a garbage collection costs more, and
// neither is a reason to throw away shadows. A percentile ignores both; a mean does not.
const AUTO_TARGET_MS = 1000 / 60;         // a map wants 60; nothing here chases 120
const AUTO_DOWN_MS = AUTO_TARGET_MS * 1.75;   // 29.2 ms — below 34 fps, step down
const AUTO_UP_MS = AUTO_TARGET_MS * 1.08;     // 18.0 ms — above 55 fps, there is room
const AUTO_RING = 150;                    // frames judged at once: 2.5 s at 60 fps
const AUTO_MIN_SAMPLES = 90;              // and this many before any judgement at all
const AUTO_JUDGE_MS = 1000;               // wall time between judgements
const AUTO_HOLD_DOWN_MS = 2000;
const AUTO_HOLD_UP_MS = 9000;
const AUTO_SETTLE_MS = 1200;              // frames ignored after a change, while targets resize
const AUTO_REGRET_MS = 12000;             // a step up undone inside this window is never retried
const AUTO_SPIKE_MS = 250;                // a single frame longer than this is a stall, not load

// Resolution rungs appended below the cheapest preset, as scales on the device's DPR cap.
const AUTO_DPR_RUNGS = [0.82, 0.68];

const AUTO = {
  on: false,
  rung: 0,
  ladder: [],
  ring: new Float64Array(AUTO_RING),
  n: 0, i: 0,
  sort: new Float64Array(AUTO_RING),
  judgeAt: 0,
  changedAt: 0,
  downAt: 0,
  okSince: 0,          // wall time since which every judgement has had headroom
  blocked: null,       // Uint8Array — rungs a probe has already proved unreachable
  lastUpRung: -1,
  lastUpAt: -1e9,
  p60: 0,
  steps: 0,
  why: 'starting',
};
G.auto = AUTO;

function autoBuild(profile) {
  const best = clamp(fin(profile.bestQuality, Q_ULTRA), 0, QUALITY_PRESETS.length - 1);
  const ladder = [];
  for (let q = best; q < QUALITY_PRESETS.length; q++) ladder.push({ q, dpr: 1 });
  for (let i = 0; i < AUTO_DPR_RUNGS.length; i++) {
    ladder.push({ q: QUALITY_PRESETS.length - 1, dpr: AUTO_DPR_RUNGS[i] });
  }
  AUTO.ladder = ladder;
  AUTO.blocked = new Uint8Array(ladder.length);
  const start = clamp(fin(profile.startQuality, best), best, QUALITY_PRESETS.length - 1);
  AUTO.rung = clamp(start - best, 0, ladder.length - 1);
  AUTO.on = true;
  AUTO.why = 'measuring';
  autoReset(nowMs());
  return AUTO;
}

function autoReset(t) {
  AUTO.n = 0;
  AUTO.i = 0;
  AUTO.changedAt = t;
  AUTO.judgeAt = t + AUTO_JUDGE_MS;
  AUTO.okSince = 0;
}

function autoStop(why) {
  if (!AUTO.on) return;
  AUTO.on = false;
  AUTO.why = why || 'off';
}

/** Move to a ladder rung and put the renderer and the backing store where that rung says. */
function autoGoto(rung, t, why) {
  const r = clamp(rung | 0, 0, AUTO.ladder.length - 1);
  const spec = AUTO.ladder[r];
  if (!spec) return;
  AUTO.rung = r;
  AUTO.steps++;
  AUTO.why = why;
  applyQuality(spec.q, false);
  if (dprScale !== spec.dpr) {
    dprScale = spec.dpr;
    sizeCanvases();          // reallocates every render target: settle time is why it is last
  }
  autoReset(t);
}

/**
 * One frame of evidence. Called from the loop with the frame's wall-clock delta in seconds, and
 * cheap enough to be: a store into a ring, and once a second a 150-element sort.
 */
function autoSample(dt, t) {
  if (!AUTO.on || !G.started) return;
  const doc = (typeof document !== 'undefined') ? document : null;
  // A hidden tab does not run frames, it runs a throttle. Every number it produces is a lie about
  // the GPU, so the window is thrown away rather than judged.
  if (doc && doc.hidden) { autoReset(t); return; }
  const ms = dt * 1000;
  if (!(ms > 0) || ms > AUTO_SPIKE_MS) return;     // a stall, a tab switch, a teleport hitch
  if (t - AUTO.changedAt < AUTO_SETTLE_MS) return; // targets are still being rebuilt

  AUTO.ring[AUTO.i] = ms;
  AUTO.i = (AUTO.i + 1) % AUTO_RING;
  if (AUTO.n < AUTO_RING) AUTO.n++;

  if (t < AUTO.judgeAt) return;
  AUTO.judgeAt = t + AUTO_JUDGE_MS;
  if (AUTO.n < AUTO_MIN_SAMPLES) return;

  // 60th percentile: past the frame-to-frame noise, short of the tail that a build or a GC owns.
  const n = AUTO.n;
  const s = AUTO.sort;
  for (let k = 0; k < n; k++) s[k] = AUTO.ring[k];
  // Insertion sort. n is 150 and this runs once a second; a comparator-driven sort would allocate.
  for (let a = 1; a < n; a++) {
    const v = s[a];
    let b = a - 1;
    while (b >= 0 && s[b] > v) { s[b + 1] = s[b]; b--; }
    s[b + 1] = v;
  }
  const p60 = s[Math.min(n - 1, Math.floor(n * 0.6))];
  AUTO.p60 = p60;

  if (p60 > AUTO_DOWN_MS) {
    AUTO.okSince = 0;
    if (t - AUTO.downAt < AUTO_HOLD_DOWN_MS) return;
    // A step down that undoes a recent step up strikes that rung off for good.
    if (AUTO.lastUpRung >= 0 && (t - AUTO.lastUpAt) < AUTO_REGRET_MS) {
      AUTO.blocked[AUTO.lastUpRung] = 1;
      AUTO.lastUpRung = -1;
    }
    // A step down is a rescue and always takes the very next rung. `blocked` is not consulted:
    // it records "this rung did not hold up", which is a reason never to climb BACK to it, never
    // a reason to refuse relief on the way past.
    const next = AUTO.rung + 1;
    if (next >= AUTO.ladder.length) {
      AUTO.why = 'floor ' + p60.toFixed(1) + ' ms';
      return;                                     // nothing cheaper exists; stop trying
    }
    AUTO.downAt = t;
    autoGoto(next, t, 'down ' + p60.toFixed(1) + ' ms');
    return;
  }

  if (p60 < AUTO_UP_MS) {
    if (!AUTO.okSince) AUTO.okSince = t;
    if (t - AUTO.okSince < AUTO_HOLD_UP_MS) return;
    // Strictly one rung, and NEVER past a struck-off one. Skipping a blocked rung would climb to
    // something more expensive still, which is the opposite of what being told "that rung was
    // too much for this device" means.
    const next = AUTO.rung - 1;
    if (next < 0) { AUTO.why = 'best ' + p60.toFixed(1) + ' ms'; return; }
    if (AUTO.blocked[next]) { AUTO.why = 'capped at rung ' + AUTO.rung; return; }
    AUTO.lastUpRung = next;
    AUTO.lastUpAt = t;
    autoGoto(next, t, 'up ' + p60.toFixed(1) + ' ms');
    return;
  }

  // Inside the deadband: settled. Headroom has to be unbroken, so the up-timer restarts.
  AUTO.okSince = 0;
  AUTO.why = 'settled ' + p60.toFixed(1) + ' ms';
}

/**
 * Point the tile budget at this device. Everything here is a public knob on the TileManager
 * INSTANCE — src/tiles.js is not touched and neither is src/city.js, which owns the numbers the
 * contract was tuned to. Called once, before the warm pass, so a phone never builds 5 km of
 * massing only to evict it on the first frame.
 */
function applyDeviceTileBudget(profile) {
  const t = G.city ? G.city.tiles : null;
  const spec = profile ? profile.tiles : null;
  if (!t || !spec) return null;
  const before = {
    mass: t.stages[0] ? t.stages[0].range : 0,
    detail: t.stages[1] ? t.stages[1].range : 0,
    cap: t.vertexCap,
  };
  const scale = (s, k) => {
    if (!s || !(k > 0)) return;
    s.range *= k;
    s.drop *= k;
  };
  scale(t.stages[0], spec.massScale);
  scale(t.stages[1], spec.detailScale);
  if (spec.vertexCap > 0) t.vertexCap = spec.vertexCap;
  if (spec.budgetMs > 0) t.budgetMs = spec.budgetMs;
  if (G.renderer && profile.shadowDistance > 0) {
    // The cascades cannot usefully reach past the massing that feeds them, and three shadow
    // passes over geometry that is no longer resident is pure cost.
    G.renderer.shadow.distance = Math.min(G.renderer.shadow.distance, profile.shadowDistance);
  }
  return { before, after: { mass: t.stages[0].range, detail: t.stages[1].range, cap: t.vertexCap } };
}

/* ================================================================== sizing == */

// The safe-area insets, in CSS pixels. index.html carries a zero-size probe whose padding is
// env(safe-area-inset-*); reading its computed padding is the only way to get those four numbers
// into script. A browser without them, or a window with no notch, reports zeroes and every layout
// below collapses back to exactly what it was.
function readSafeInsets() {
  const s = G.safe;
  const raw = SHELL.safeInsets();
  const w = Math.max(1, G.cssW), h = Math.max(1, G.cssH);
  const get = (k) => (raw && Number.isFinite(raw[k]) && raw[k] > 0 ? raw[k] : 0);
  s.top = Math.min(get('top'), h * 0.3);
  s.bottom = Math.min(get('bottom'), h * 0.3);
  s.left = Math.min(get('left'), w * 0.3);
  s.right = Math.min(get('right'), w * 0.3);
  return s;
}

function sizeCanvases() {
  const w = (typeof window !== 'undefined') ? window : null;
  const cssW = Math.max(1, Math.floor(w ? (w.innerWidth || 1) : 1));
  const cssH = Math.max(1, Math.floor(w ? (w.innerHeight || 1) : 1));
  const raw = clamp(fin(w ? w.devicePixelRatio : 1, 1), 0.5, 4);
  // The scene's share: the device-class cap, then the adaptive controller's scale on top of it.
  const dpr = clamp(Math.min(raw, dprCap) * dprScale, DPR_MIN, dprCap);
  // The HUD's share: as sharp as the panel allows, because 2D text costs nothing. On a 3x phone
  // rendering the city at 1.5 this is the difference between crisp type and a blurred smear.
  const hudDpr = clamp(Math.min(raw, HUD_DPR_CAP), dpr, HUD_DPR_CAP);
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  const hw = Math.max(1, Math.round(cssW * hudDpr));
  const hh = Math.max(1, Math.round(cssH * hudDpr));

  G.cssW = cssW;
  G.cssH = cssH;
  G.dpr = dpr;
  G.hudDpr = hudDpr;
  readSafeInsets();

  if (G.canvas && (G.canvas.width !== bw || G.canvas.height !== bh)) {
    G.canvas.width = bw;
    G.canvas.height = bh;
  }
  if (G.hud && (G.hud.width !== hw || G.hud.height !== hh)) {
    G.hud.width = hw;
    G.hud.height = hh;
  }
  // Every HUD coordinate below is written in CSS pixels; the transform is the only place the
  // backing-store scale appears. Re-applied unconditionally because setting canvas.width resets
  // the 2D context state, and the HUD and the scene no longer share a scale.
  if (G.ctx) G.ctx.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
  if (G.renderer) G.renderer.resize(bw, bh);
  if (G.camera) G.camera.aspect = bw / bh;
  // touch.js re-reads the canvas rect on its own resize listener and again at the start of every
  // gesture, so nothing has to be poked at it from here.
}

/* ================================================================ movement == */

// The reachable world, in one place. Every clamp on the camera — the integrators here and the
// touch camera in touch.js — comes through this, so the boundary is a single definitive number
// that follows the extent as the city is expanded rather than a constant to be re-tuned.
const WORLD_BOUNDS = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

function worldBounds(out) {
  const ex = (G.city && G.city.extent && Number.isFinite(G.city.extent.x)) ? G.city.extent.x : 3141.7;
  const ez = (G.city && G.city.extent && Number.isFinite(G.city.extent.z)) ? G.city.extent.z : 2226.4;
  out.minX = -ex / 2 - WORLD_MARGIN;
  out.maxX = ex / 2 + WORLD_MARGIN;
  out.minZ = -ez / 2 - WORLD_MARGIN;
  out.maxZ = ez / 2 + WORLD_MARGIN * 4;
  return out;
}

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
    // A key on the quality dial is a deliberate choice and stops the adaptive step (see AUTO).
    if (input.pressed('KeyE')) applyQuality(G.quality - 1, true);   // "up" = a richer preset
    if (input.pressed('KeyQ')) applyQuality(G.quality + 1, true);
    if (input.pressed('KeyV')) goToViewpoint(player.viewpoint + 1);
    if (input.pressed('KeyR')) goToViewpoint(0);
    if (input.pressed('Escape')) { G.cursorReleased = true; input.exitLock(); }
  }

  // Touch gestures move the camera DIRECTLY (they are a solve, not a force), so they land before
  // the integrators and the ordinary velocity model carries on underneath them untouched. On a
  // machine that has never seen a finger this is one early return.
  if (G.touch) G.touch.update(dt);

  if (player.mode === 'fly') updateFly(input, dt);
  else updateWalk(input, dt);

  // Keep the world bounded: the data stops at the extent and flying past it is just void.
  const b = worldBounds(WORLD_BOUNDS);
  player.x = clamp(player.x, b.minX, b.maxX);
  player.z = clamp(player.z, b.minZ, b.maxZ);
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
  ['Cursor on / off', 'Double-click', 'Double-click'],
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

  // A phone has no keys to list. The touch table is the gestures instead, in the same panel.
  const onTouch = !!(G.touch && G.touch.showUi);
  const rows = onTouch ? TOUCH_HELP_ROWS : HELP_ROWS;
  const s = G.safe;
  const uw = w - s.left - s.right;
  const uh = h - s.top - s.bottom;
  // The panel is SOLVED to fit rather than laid out and hoped for: 16 keyboard rows at 21 px is
  // 454 px of table, and a phone on its side has 375 px of screen. Rather than scroll a modal
  // sheet with no scrollbar, the row pitch and the chrome shrink until the whole table fits the
  // safe box, with a floor low enough to stay legible at the HUD's own device pixel ratio.
  const panelW = Math.min(560, uw - 32);
  const chromeFull = 118;
  let rowH = 21;
  let chrome = chromeFull;
  const budget = uh - 24;
  if (rows.length * rowH + chrome > budget) {
    chrome = 86;
    rowH = clamp((budget - chrome) / rows.length, 14, 21);
  }
  const panelH = Math.min(budget, rows.length * rowH + chrome);
  const x = Math.round(s.left + (uw - panelW) / 2);
  const y = Math.round(s.top + (uh - panelH) / 2);
  const tight = chrome < chromeFull;
  const headY = tight ? 26 : 38;
  const ruleY = tight ? 36 : 50;
  const firstY = tight ? 56 : 74;

  ctx.fillStyle = 'rgba(9, 16, 27, 0.92)';
  ctx.fillRect(x, y, panelW, panelH);
  ctx.strokeStyle = 'rgba(133, 194, 212, 0.38)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, panelW, panelH);

  const pad = panelW < 380 ? 18 : 26;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  setFont(ctx, tight ? 10.5 : 12, HUD.mono, '500', '0.28em');
  ctx.fillStyle = HUD.cyan;
  ctx.fillText('CONTROLS', x + pad, y + headY);

  ctx.textAlign = 'right';
  setFont(ctx, 9.5, HUD.mono, '500', '0.18em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(onTouch ? 'TOUCH' : 'BOTH LAYOUTS LIVE', x + panelW - pad, y + headY);

  hudRule(ctx, x + pad, y + ruleY, panelW - pad * 2);

  const narrowHelp = panelW < 380;
  // Type scales with the row pitch so a squeezed table stays proportioned instead of leaving the
  // rows touching each other at full size.
  const labelPx = clamp(rowH * 0.57, 9.5, 12);
  const valuePx = clamp(rowH * (narrowHelp ? 0.48 : 0.55), 8.5, 11.5);
  // The right-hand value column: two columns for the keyboard table, one for the gestures.
  const col2 = Math.max(96, Math.min(132, panelW * 0.34));
  let ry = y + firstY;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    ctx.textAlign = 'left';
    setFont(ctx, labelPx, HUD.sans, '300', '0.02em');
    ctx.fillStyle = HUD.text;
    ctx.fillText(r[0], x + pad, ry);

    ctx.textAlign = 'right';
    setFont(ctx, valuePx, HUD.mono, '500', '0.06em');
    ctx.fillStyle = HUD.cyan;
    if (r.length > 2) {
      ctx.fillText(r[1], x + panelW - col2, ry);
      ctx.fillStyle = HUD.warm;
      ctx.fillText(r[2], x + panelW - pad, ry);
    } else {
      // One long value (a gesture, not a key) can be wider than the label leaves room for, so it
      // is fitted to what is actually free.
      ctx.fillText(fitText(ctx, r[1], panelW - pad * 2 - 118), x + panelW - pad, ry);
    }
    ry += rowH;
  }

  hudRule(ctx, x + pad, ry - rowH * 0.55, panelW - pad * 2);
  ctx.textAlign = 'left';
  setFont(ctx, 9.5, HUD.mono, '400', '0.16em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(onTouch ? 'TAP ANYWHERE TO CLOSE' : 'H CLOSES THIS', x + pad, ry + (tight ? 8 : 12));
  ctx.restore();
}

/**
 * Shorten a string until it fits `maxW`, with an ellipsis. The HUD has a fixed budget for the
 * street name and Toronto has "Waterfront Recreational Trail" in it; clipping a name against a
 * neighbouring readout is the one thing that makes a HUD look broken.
 */
function fitText(ctx, str, maxW) {
  if (!(maxW > 0)) return '';
  if (ctx.measureText(str).width <= maxW) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(str.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + '…' : '';
}

function drawHud(input) {
  const ctx = G.ctx;
  if (!ctx) return;
  const w = G.cssW, h = G.cssH;
  ctx.clearRect(0, 0, w, h);
  if (!G.started || !G.city) return;

  // EVERY ANCHOR IS MEASURED FROM THE SAFE BOX, not the glass. On a notched phone the four insets
  // are 47/0/34/0 in portrait and 0/47/21/47 in landscape, and a HUD that ignores them puts the
  // street name under the camera housing and the mandatory attribution — which is not allowed to
  // be clipped — under the home indicator. With no notch every inset is 0 and L/R/T/B collapse
  // back to exactly the M-based layout the desktop has always drawn.
  const s = G.safe;
  const M = 24;
  const L = M + s.left;
  const R = w - M - s.right;
  const T = M + s.top;
  const B = h - M - s.bottom;
  const cx = (s.left + (w - s.right)) * 0.5;
  const uw = w - s.left - s.right;
  const uh = h - s.top - s.bottom;
  // Under ~720 px the bottom blocks would collide and the attribution is not allowed to be
  // clipped, so it moves to its own centred pair of lines; the same threshold reflows the top.
  const narrow = w < 720;
  // A phone on its side is 375 px tall. There is no room for the second coordinate line there,
  // and the help sheet has to be built differently too.
  const short = uh < 470;
  ctx.textBaseline = 'alphabetic';

  /* ---- top left: where you are ---- */
  ctx.textAlign = 'left';
  setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(player.mode === 'fly' ? 'FLY' : 'ON FOOT', L, T + 2);

  // A phone is 375 px wide and the street name and the centred compass were drawn straight
  // through each other there. On a narrow screen the name goes BELOW the compass instead, a size
  // smaller; the wide layout is exactly as it was.
  const street = (player.street || 'Downtown Toronto').toUpperCase();
  const nameY = narrow ? T + 64 : T + 26;
  setFont(ctx, narrow ? 15 : 19, HUD.sans, '200', '0.09em');
  ctx.fillStyle = HUD.text;
  // The right half of this row belongs to the quality readout on a narrow screen, so the name is
  // measured and trimmed rather than allowed to run into it.
  const nameRoom = narrow ? Math.min(uw * 0.56, 226) : Math.min(uw - 240, 360);
  const shown = fitText(ctx, street, nameRoom);
  ctx.fillText(shown, L, nameY);
  const nameW = Math.max(150, Math.min(nameRoom, ctx.measureText(shown).width));
  hudRule(ctx, L, nameY + 8, nameW);

  /* ---- top centre: compass ---- */
  // Narrower on a phone: the readouts either side of it need the room more than the compass needs
  // the extra 35 degrees of arc.
  const compassW = narrow
    ? Math.max(168, Math.min(230, uw - 190))
    : Math.min(460, Math.max(220, uw * 0.36));
  drawCompass(ctx, Math.round(cx), T - 6, compassW);

  /* ---- top right: frame rate + quality ---- */
  // On a narrow screen this whole stack drops BELOW the compass — at 375 px the caption and the
  // preset name were overlapping the compass's east cardinal — and loses its caption, because
  // "MEDIUM · GOLDEN HOUR · 58 FPS" needs no explaining.
  ctx.textAlign = 'right';
  let ry = narrow ? T + 64 : T + 22;
  if (!narrow) {
    setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
    ctx.fillStyle = HUD.faint;
    ctx.fillText('QUALITY', R, T + 2);
  }
  setFont(ctx, 13, HUD.mono, '500', '0.1em');
  ctx.fillStyle = HUD.cyan;
  const qName = QUALITY_PRESETS[G.quality].name.toUpperCase();
  ctx.fillText(qName, R, ry);
  // The adaptive step is never allowed to move the picture without saying so.
  if (AUTO.on) {
    const qw = ctx.measureText(qName).width;
    setFont(ctx, 8.5, HUD.mono, '500', '0.2em');
    ctx.fillStyle = HUD.faint;
    ctx.fillText('AUTO', R - qw - 9, ry);
  }
  ry += 18;
  const tp = TIME_PRESETS[G.timeOfDay];
  setFont(ctx, 9.5, HUD.mono, '500', '0.24em');
  ctx.fillStyle = HUD.faint;
  ctx.fillText(tp.name.toUpperCase() + '  ' + tp.clock, R, ry);
  ry += 18;
  setFont(ctx, 11, HUD.mono, '400', '0.1em');
  ctx.fillStyle = HUD.dim;
  ctx.fillText(G.fps.toFixed(0) + ' FPS', R, ry);
  // Live speed dial (mouse wheel / [ ]). Only worth showing once it is off the default.
  const sm = fin(player.speedMult, 1);
  if (Math.abs(sm - 1) > 0.02) {
    ry += 18;
    ctx.fillStyle = HUD.cyan;
    ctx.fillText('SPEED x' + (sm >= 1 ? sm.toFixed(1) : sm.toFixed(2)), R, ry);
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
  // A landscape phone has 375 px of height and the on-screen buttons want the lower right of it.
  // Lat/lon is the line a map already tells you, so it is the one that goes.
  if (short) lines.splice(1, 1);
  ctx.textAlign = 'left';
  setFont(ctx, 11, HUD.mono, '400', '0.07em');
  let ly = B - (narrow ? 74 : 46) - (short ? -15 : 0);
  hudRule(ctx, L, ly - 16, 210);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0 ? HUD.text : HUD.dim;
    ctx.fillText(lines[i], L, ly);
    ly += 15;
  }

  /* ---- mandatory attribution ---- */
  // Not allowed to be clipped (CONTRACT §1), so on a narrow screen it is MEASURED and the type
  // shrunk until both lines fit inside the safe box. At 375 px the longer line is 352 px at 9.5,
  // which fits — but a landscape phone hands back 47 px of that to the notch on each side.
  setFont(ctx, 9.5, HUD.mono, '400', '0.1em');
  ctx.fillStyle = HUD.faint;
  if (narrow) {
    const room = uw - 16;
    const line2 = 'Streets: ' + ATTRIB_B;
    let apx = 9.5;
    const widest = () => Math.max(ctx.measureText(ATTRIB_A).width, ctx.measureText(line2).width);
    for (let guard = 0; guard < 6 && widest() > room; guard++) {
      apx = Math.max(6.5, apx * (room / widest()));
      setFont(ctx, apx, HUD.mono, '400', '0.1em');
    }
    ctx.textAlign = 'center';
    ctx.fillText(ATTRIB_A, cx, B - 11);
    ctx.fillText(line2, cx, B + 2);
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(ATTRIB_A, R, B - 13);
    ctx.fillText('Streets: ' + ATTRIB_B, R, B);
  }

  /* ---- centre: reticle, and the pointer-lock hint ---- */
  // Neither belongs on a phone: there is no cursor to lock and the map camera has no aim point.
  // The reticle stays on the TRUE centre of the viewport, not the centre of the safe box — it
  // marks where the camera is pointing, and the camera does not know about notches.
  const onTouch = !!(G.touch && G.touch.showUi);
  if (!G.showHelp && !(G.touch && G.touch.hideReticle())) drawReticle(ctx, w / 2, h / 2);
  if (input && !input.locked && !onTouch) {
    ctx.textAlign = 'center';
    setFont(ctx, 10, HUD.mono, '500', '0.24em');
    ctx.fillStyle = HUD.warm;
    ctx.fillText('CLICK TO LOOK AROUND', cx, B - (narrow ? 104 : 26));
  }

  /* ---- diagnostics ---- */
  if (G.showDebug) {
    const st = G.renderer ? G.renderer.stats : null;
    const cs = G.city.stats || {};
    const q = G.renderer ? G.renderer._q : null;
    const inside = G.city.buildingAt(player.x, player.z);
    const ts = G.city.tiles.stats;
    const dev = G.device;
    const dbg = [
      'draws ' + (st ? st.draws : 0) + '  tris ' + (st ? st.tris.toLocaleString() : 0) +
        '  shadow ' + (st ? st.shadowDraws : 0) + '  post ' + (st ? st.postPasses : 0),
      'city ' + (cs.buildings || 0) + ' bldgs  ' + (cs.roads || 0) + ' ways  ' +
        ((cs.verts || 0)).toLocaleString() + ' verts  ' + (cs.seconds || 0).toFixed(2) + ' s',
      'tiles ' + ts.residentTiles + ' resident / ' + ts.visibleTiles + ' drawn / ' +
        (cs.tileCount || 0) + '  queue ' + ts.queued + '  build ' +
        ts.lastBuildMs.toFixed(1) + ' ms  evicted ' + ts.evicted +
        ' (' + (ts.evictedVerts / 1e6).toFixed(1) + ' M verts)',
      'budget ' + (ts.residentVerts / 1e6).toFixed(2) + ' / ' +
        (G.city.tiles.vertexCap / 1e6).toFixed(1) + ' M verts  ≈ ' +
        Math.round(ts.residentVerts * VERT_BYTES / 1048576) + ' MB  lod ' +
        G.city.tiles.range(0).toFixed(0) + ' / ' + G.city.tiles.range(1).toFixed(0) + ' m',
      q ? ('shadows ' + q.shadows + '  ssao ' + (q.ssao ? 'on' : 'off') + '  ssr ' +
        (q.ssr ? 'on' : 'off') + '  bloom ' + (q.bloom ? 'on' : 'off') + '  fxaa ' +
        (q.fxaa ? 'on' : 'off')) : 'renderer quality unavailable',
      'device ' + dev.key + (dev.mem ? '  ' + dev.mem + ' GB' : '') +
        (dev.cores ? '  ' + dev.cores + ' cores' : '') +
        '  auto ' + (AUTO.on ? 'rung ' + AUTO.rung + '/' + (AUTO.ladder.length - 1) +
          ' ' + AUTO.why + ' (' + AUTO.steps + ')' : AUTO.why),
      'grounded ' + (player.grounded ? 'yes' : 'no') + '  inside footprint ' +
        (inside ? 'YES h=' + inside.h.toFixed(0) + ' m' : 'no') +
        '  dpr ' + G.dpr.toFixed(2) + '/' + G.hudDpr.toFixed(2) + '  ' + G.cssW + '×' + G.cssH +
        '  safe ' + s.top.toFixed(0) + '/' + s.right.toFixed(0) + '/' +
        s.bottom.toFixed(0) + '/' + s.left.toFixed(0),
    ];
    ctx.textAlign = 'left';
    setFont(ctx, 10, HUD.mono, '400', '0.04em');
    let dy = T + (narrow ? 128 : 62);
    for (let i = 0; i < dbg.length; i++) {
      ctx.fillStyle = HUD.faint;
      ctx.fillText(dbg[i], L, dy);
      dy += 14;
    }
  }

  /* ---- on-screen touch controls ---- */
  // Under the help sheet on purpose: while the sheet is up a tap anywhere closes it, so the
  // buttons would be dead targets.
  if (G.touch) G.touch.drawOverlay(ctx, w, h);

  if (G.showHelp) drawHelp(ctx, w, h);
}

/* ==================================================================== loop == */

let lastMs = 0;
let fpsAccum = 0;
let fpsFrames = 0;

// Material classes in draw order. Opaque ground first, then the vertical stuff, then the
// glazing: the same order the single merged meshes were drawn in, so the depth buffer sees the
// same sequence and nothing about z-fighting or early-z changes.
const DRAW_ORDER = ['terrain', 'roads', 'sidewalks', 'rails', 'buildings', 'glass', 'props'];

// Shadow casters, from the tiles inside the cascade's reach. Towers, their glazing and the
// street furniture cast; the ground plane and the ribbons only receive. `props` belongs in this
// list: it carries the street trees, lamps, parked cars, signals, catenary poles and every
// shelter and planter in the city, and in daylight every one of those throws a hard shadow onto
// the pavement. Leaving it out was most of why the daylight street read flat.
const CASTER_CLASSES = ['buildings', 'glass', 'props'];

const _drawMesh = (m) => G.renderer.drawMesh(m);

function renderScene() {
  const r = G.renderer;
  const city = G.city;
  // Whatever the cascades cover, plus a tile diagonal so a caster whose ORIGIN is outside the
  // range but whose geometry reaches in still casts.
  const shadowR = (r.shadow ? r.shadow.distance : 1250) + city.tiles.grid.size * 1.5;
  r.setShadowCasters(city.tiles.casters(shadowR, CASTER_CLASSES).slice());
  r.beginFrame(G.camera);
  for (let i = 0; i < DRAW_ORDER.length; i++) city.tiles.forEachMesh(DRAW_ORDER[i], _drawMesh);
  r.drawWater(city.meshes.water, G.camera);
  r.endFrame();
}

function frame(tMs) {
  scheduleFrame();

  const t = Number.isFinite(tMs) ? tMs : nowMs();
  let dt = (t - lastMs) / 1000;
  lastMs = t;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  // The UNCLAMPED delta, kept for the adaptive step: the clamp below turns every stall into
  // exactly 100 ms, and a controller that cannot tell a stall from a slow frame would step the
  // whole city down every time the tab came back from the background.
  const rawDt = dt;
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

  // Evidence for the adaptive step, taken from the raw wall-clock delta before anything else has
  // had a chance to stall the frame.
  autoSample(rawDt, t);

  const input = G.input;
  try {
    updatePlayer(input, dt);
    updateCamera(dt);

    // Level of detail, culling, the geometry budget and eviction, before anything is drawn.
    G.city.update(G.camera, t);

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

  // Classify the machine BEFORE the first sizeCanvases(), so a phone never allocates a 3x
  // backing store and then throws it away one line later.
  DEVICE = deviceProfile(detectPointer());
  G.device = DEVICE;
  dprCap = DEVICE.dprCap;
  dprScale = 1;
  // Which control table the title screen teaches. A touchscreen laptop gets both, because on that
  // machine both are live.
  SHELL.setInputMode(DEVICE.caps.primary ? 'touch' : (DEVICE.caps.hybrid ? 'both' : 'keyboard'));

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

  // Touch. The gesture layer only installs itself where touch points exist, and every one of its
  // handlers ignores a mouse, so a desktop keeps exactly the input it had. A TOUCH-PRIMARY device
  // (coarse pointer, no mouse) additionally gets the on-screen controls, a lower backing-store
  // resolution and a mid quality preset to start from — a phone GPU cannot open on Ultra.
  G.touch = new TouchControls({
    canvas,
    hud,
    input: G.input,
    player,
    readView: (out) => {
      out.w = G.cssW;
      out.h = G.cssH;
      out.aspect = (G.camera && G.camera.aspect > 0) ? G.camera.aspect : G.cssW / Math.max(1, G.cssH);
      out.fov = fin(player.fov, FOV_BASE);
      // The insets travel with the view so the on-screen buttons and the thumbstick lay
      // themselves out inside the safe box too, rather than under a home indicator.
      const s = out.safe || (out.safe = { top: 0, right: 0, bottom: 0, left: 0 });
      s.top = G.safe.top;
      s.right = G.safe.right;
      s.bottom = G.safe.bottom;
      s.left = G.safe.left;
    },
    groundY: (x, z) => (G.city ? fin(G.city.groundY(x, z), 0) : 0),
    readBounds: (out) => { worldBounds(out); },
    isActive: () => (G.started && G.ready && !!G.city),
    hooks: {
      mode: () => player.mode,
      setMode: (mode, x, z) => setMovementMode(mode, x, z),
      help: () => G.showHelp,
      setHelp: (on) => { G.showHelp = !!on; },
      // The two settings a phone cannot otherwise reach: there is no T key and no Q/E on a piece
      // of glass. Both are the same code path the keyboard drives.
      nextTime: () => applyTime(G.timeOfDay + 1),
      nextQuality: () => cycleQuality(),
    },
  }).attach();

  // The opening preset is the device profile's hypothesis; the adaptive step then measures the
  // real thing and moves. Both go through applyQuality(index, manual=false), so neither counts as
  // the user having made a choice.
  autoBuild(DEVICE);
  applyQuality(DEVICE.startQuality, false);
  applyTime(G.timeOfDay);
  sizeCanvases();

  // A context loss takes every VBO in the process with it, and the city's geometry can only be
  // rebuilt by re-reading 3 MB of JSON. Say so honestly: the renderer then surfaces a
  // "reload the page" panel through the shell instead of drawing an empty world.
  G.renderer.onContextRestored(() => false);

  SHELL.setProgress(0.05, 'loading city data');
  await nextFrame();

  G.city = await loadCity(gl, './data/toronto.json', (frac, label) => {
    SHELL.setProgress(0.05 + clamp(fin(frac, 0), 0, 1) * 0.72, label || 'building the city');
  });
  unproject = makeUnprojector(G.city.meta && G.city.meta.origin);

  // Point the tile budget at this device before anything is built. On a phone the resident
  // vertex cap is as much a memory limit as a speed one — 48 bytes a vertex, and 11 M of them is
  // half a gigabyte of buffer objects that a mobile browser will not hand one tab.
  const tileTune = applyDeviceTileBudget(DEVICE);
  if (tileTune) {
    console.log('[toronto] ' + DEVICE.key + ' tile budget: massing ' +
      tileTune.before.mass + ' -> ' + tileTune.after.mass.toFixed(0) + ' m, detail ' +
      tileTune.before.detail + ' -> ' + tileTune.after.detail.toFixed(0) + ' m, cap ' +
      (tileTune.before.cap / 1e6).toFixed(1) + ' -> ' + (tileTune.after.cap / 1e6).toFixed(1) +
      ' M verts (' + Math.round(tileTune.after.cap * VERT_BYTES / 1048576) + ' MB)');
  }

  // The CN Tower's lighting rig is masked to a 34 m cylinder around the tower's axis, and
  // render.js can only carry a literal for that. Point it at the tower this dataset actually
  // holds. TIME_DEFAULTS is snapshotted before the city loads, so it has to be corrected too or
  // the next preset change writes the stale position straight back.
  {
    const cn = G.city.cnTower;
    const env = G.renderer.env;
    if (cn && cn.length >= 4 && env && env.cnTower) {
      for (let i = 0; i < 4; i++) env.cnTower[i] = cn[i];
      if (TIME_DEFAULTS && TIME_DEFAULTS.cnTower) {
        for (let i = 0; i < 4; i++) TIME_DEFAULTS.cnTower[i] = cn[i];
      }
    }
  }

  goToViewpoint(0);
  updateCamera(0.016);
  sizeCanvases();

  // The camera has to exist before the tiles can: what gets built is a function of where the
  // player is standing. Everything outside this first ring arrives while the title screen is up
  // and, after that, a few milliseconds at a time inside the frame loop.
  await G.city.warm(G.camera, 2600, (f) => {
    SHELL.setProgress(0.77 + clamp(fin(f, 0), 0, 1) * 0.21, 'building the city around you');
  });
  G.city.update(G.camera, nowMs());

  // One frame before the title screen appears, so the overlay sits over the real skyline.
  if (!G.renderer.contextLost) renderScene();

  SHELL.setProgress(1, 'ready');
  await nextFrame(20);

  // Page load to the first interactive frame, measured from navigation start. Reported because
  // it is the number that actually changed when the city became tiled, and the only honest place
  // to take it is here, in the real page, in a visible tab.
  G.bootMs = nowMs();
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
    G.cursorReleased = false;
    // Pointer lock is meaningless on a touch screen: there is no cursor to capture, and asking
    // for it puts an "Esc to exit" banner over a phone that can never press Esc. A hybrid started
    // with the mouse still gets it.
    if (!(G.touch && (G.touch.caps.primary || G.touch.recentTouch(1500)))) G.input.requestLock();
  });

  if (typeof window !== 'undefined') {
    // A rotation changes both the pixel count and the safe-area insets, and it changes the frame
    // cost with them — so the adaptive step's struck-off rungs are forgiven and the search is
    // allowed to run again against the new workload.
    const onResize = () => {
      sizeCanvases();
      if (AUTO.on && AUTO.blocked) {
        AUTO.blocked.fill(0);
        AUTO.lastUpRung = -1;
        autoReset(nowMs());
      }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', onResize);
    }
  }
  // --- cursor capture ------------------------------------------------------------------------
  // DOUBLE-CLICK TOGGLES THE CURSOR. Mouse-look needs pointer lock, which hides the cursor, and the
  // only way out used to be Esc -- except this same handler then re-grabbed the lock on the very
  // next click anywhere, so the cursor came back for a moment and was immediately stolen again.
  // That reads as being trapped in aim mode.
  //
  // Now: double-click toggles capture in both directions, and once the cursor has been released
  // DELIBERATELY (double-click or Esc) a single click will not take it back. Single-click still
  // re-acquires after an incidental loss, e.g. an alt-tab, so the common case stays one click.
  let pendingLock = 0;
  const cancelPendingLock = () => {
    if (pendingLock) { clearTimeout(pendingLock); pendingLock = 0; }
  };

  canvas.addEventListener('mousedown', (e) => {
    if (!G.started || !G.input || G.input.locked) return;
    if (e && e.button !== 0) return;
    // A tap that leaked through as a compatibility mouse event is not a click for the cursor.
    if (G.touch && G.touch.recentTouch()) return;
    if (G.cursorReleased) return;            // released on purpose — leave the cursor alone
    cancelPendingLock();
    // Delay just past the double-click window, so the FIRST click of a double-click does not grab
    // the lock and leave the gesture fighting itself.
    pendingLock = setTimeout(() => {
      pendingLock = 0;
      if (G.started && G.input && !G.input.locked && !G.cursorReleased) G.input.requestLock();
    }, 260);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!G.started || !G.input) return;
    if (G.touch && G.touch.recentTouch()) return;    // a double TAP is a zoom, not a cursor toggle
    cancelPendingLock();
    if (G.input.locked) {
      G.cursorReleased = true;
      G.input.exitLock();
    } else {
      G.cursorReleased = false;
      G.input.requestLock();
    }
  });

  lastMs = nowMs();
  G.running = true;
  scheduleFrame();

  console.log('[toronto] ready in ' + (G.bootMs / 1000).toFixed(2) + ' s — ' +
    G.city.stats.buildings + ' buildings over ' + G.city.stats.tileCount + ' tiles, ' +
    G.city.stats.verts.toLocaleString() + ' vertices resident. window.G is live.');
  console.log('[toronto] device ' + DEVICE.key + ' — dpr ' + G.dpr.toFixed(2) + ' scene / ' +
    G.hudDpr.toFixed(2) + ' hud, opening on ' + QUALITY_PRESETS[G.quality].name +
    ', adaptive ladder of ' + AUTO.ladder.length + ' rungs' +
    (DEVICE.mem ? ', ' + DEVICE.mem + ' GB' : '') +
    (DEVICE.cores ? ', ' + DEVICE.cores + ' cores' : ''));
}

boot().catch((err) => {
  G.running = false;
  console.error('[toronto] boot failed', err);
  const msg = (err && err.message) ? err.message : 'Toronto could not start.';
  const detail = (err && err.stack) ? err.stack : String(err);
  SHELL.showError(msg, detail);
});

export default G;
