// src/app/controls.js — the free-roam controllers: viewpoints, walk, fly and the camera.
//
// CONTRACT Amendment 11: lifted out of src/app/main.js unchanged. CONTRACT §3.3 and §5 —
// FREE ROAM ONLY, and the speeds, the inverted horizontal look and the live speed dial here are
// explicit USER PREFERENCES, not defaults to be corrected toward realism. Do not retune them.
//
// World axes: X = east, Y = up, Z = south. Right-handed, TRUE METRES.
// Yaw follows math.js: forward = (sin yaw, 0, cos yaw), so yaw 0 faces +Z = SOUTH and a compass
// bearing (0 = north, 90 = east) is simply PI - yaw.
//
// BOTH CONTROL LAYOUTS ARE LIVE AT ONCE. input.js aliases the arrow keys and the right-hand
// cluster onto the canonical WASD codes, so every query below is written once against the
// canonical code and both layouts work. This is a hard user requirement — do not "simplify" it
// by reading physical codes.
//
// Every entry point takes the app state `G` rather than closing over it, so nothing here is
// module-scope mutable state and the whole file can be driven by a test with a stub city. The one
// exception is WORLD_BOUNDS, which is scratch: written and read inside a single call, never
// carried between them.
//
// KEY COMMANDS ARE INTENTS, NOT EFFECTS. updatePlayer() maps a key to a call on `actions` and the
// app decides what that means, so the time presets, the quality ladder and the HUD flags stay out
// of the controller. The mapping order is load-bearing: look is read before the commands, the
// commands before the touch solve, and the touch solve before the integrators.

import { clamp, damp, angleWrap, PI, RAD2DEG } from '../core/math.js';
import { TIME_PRESETS } from './time.js';

function fin(v, dflt = 0) {
  return Number.isFinite(v) ? v : dflt;
}

/* ================================================================ tunables == */

export const EYE_HEIGHT = 1.7;          // metres, CONTRACT §3.3
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

export const FOV_BASE = 1.05;           // 60 degrees vertical
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

/* ============================================================== viewpoints == */

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
export const VIEWPOINTS = [
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

/* ================================================================== player == */

/**
 * A fresh free-roam player. `y` is the EYE height in BOTH modes, so the walk/fly toggle needs no
 * conversion. `speedMult` is deliberately absent here and seeded by the first goToViewpoint(),
 * exactly as it always has been.
 */
export function createPlayer() {
  return {
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
}

/* ============================================================ geo helpers == */

// Inverse of city.js's projector: local metres -> lon/lat, for the HUD readout. Web Mercator with
// the build step's cos(lat0) scale divided out (CONTRACT §1).
export function makeUnprojector(origin) {
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

// Compass bearing (0 = north, 90 = east) from the yaw convention in math.js.
export function yawToBearing(yaw) {
  let b = (PI - yaw) * RAD2DEG;
  b %= 360;
  if (b < 0) b += 360;
  return b;
}

export function bearingToYaw(bearingDeg) {
  return angleWrap(PI - bearingDeg * (PI / 180));
}

export function goToViewpoint(G, index) {
  const player = G.player;
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
export function setMovementMode(G, mode, x, z) {
  const player = G.player;
  const walk = mode === 'walk';
  player.mode = walk ? 'walk' : 'fly';
  player.vx = 0;
  player.vy = 0;
  player.vz = 0;
  player.grounded = false;
  if (!walk) return;

  const b = worldBounds(G, WORLD_BOUNDS);
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

/* ================================================================ movement == */

// The reachable world, in one place. Every clamp on the camera — the integrators here and the
// touch camera in touch.js — comes through this, so the boundary is a single definitive number
// that follows the extent as the city is expanded rather than a constant to be re-tuned.
const WORLD_BOUNDS = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

export function worldBounds(G, out) {
  const ex = (G.city && G.city.extent && Number.isFinite(G.city.extent.x)) ? G.city.extent.x : 3141.7;
  const ez = (G.city && G.city.extent && Number.isFinite(G.city.extent.z)) ? G.city.extent.z : 2226.4;
  out.minX = -ex / 2 - WORLD_MARGIN;
  out.maxX = ex / 2 + WORLD_MARGIN;
  out.minZ = -ez / 2 - WORLD_MARGIN;
  out.maxZ = ez / 2 + WORLD_MARGIN * 4;
  return out;
}

function readLook(G, input, dt) {
  const player = G.player;
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

function updateWalk(G, input, dt) {
  const player = G.player;
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

function updateFly(G, input, dt) {
  const player = G.player;
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

export function updatePlayer(G, input, dt, actions) {
  const player = G.player;
  if (!G.city) return;

  const prevX = player.x, prevY = player.y, prevZ = player.z;

  readLook(G, input, dt);

  if (G.started) {
    if (input.pressed('KeyF')) {
      player.mode = player.mode === 'walk' ? 'fly' : 'walk';
      player.vy = 0;
      player.grounded = false;
    }
    if (input.pressed('KeyH')) actions.toggleHelp();
    if (input.pressed('KeyT')) actions.nextTime();
    for (let i = 0; i < TIME_PRESETS.length; i++) {
      if (input.pressed('Digit' + (i + 1))) actions.setTime(i);
    }
    if (input.pressed('Backquote')) actions.toggleDebug();
    // A key on the quality dial is a deliberate choice and stops the adaptive step (see AUTO).
    if (input.pressed('KeyE')) actions.qualityUp();       // "up" = a richer preset
    if (input.pressed('KeyQ')) actions.qualityDown();
    if (input.pressed('KeyV')) goToViewpoint(G, player.viewpoint + 1);
    if (input.pressed('KeyR')) goToViewpoint(G, 0);
    if (input.pressed('Escape')) actions.releaseCursor(input);
  }

  // Touch gestures move the camera DIRECTLY (they are a solve, not a force), so they land before
  // the integrators and the ordinary velocity model carries on underneath them untouched. On a
  // machine that has never seen a finger this is one early return.
  if (G.touch) G.touch.update(dt);

  if (player.mode === 'fly') updateFly(G, input, dt);
  else updateWalk(G, input, dt);

  // Keep the world bounded: the data stops at the extent and flying past it is just void.
  const b = worldBounds(G, WORLD_BOUNDS);
  player.x = clamp(player.x, b.minX, b.maxX);
  player.z = clamp(player.z, b.minZ, b.maxZ);
  player.y = clamp(player.y, FLOOR, CEILING);

  // Last line of defence. A single NaN anywhere above would poison the matrices forever, so the
  // camera is put back on Front Street instead.
  if (!Number.isFinite(player.x + player.y + player.z + player.yaw + player.pitch +
      player.vx + player.vy + player.vz)) {
    console.warn('[toronto] non-finite player state — resetting to the start viewpoint');
    goToViewpoint(G, 0);
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
function cameraClearance(G) {
  const player = G.player;
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

function cameraNear(G) {
  const c = cameraClearance(G) * NEAR_SAFETY;
  if (!Number.isFinite(c)) return NEAR_MIN;
  return c < NEAR_MIN ? NEAR_MIN : (c > NEAR_MAX ? NEAR_MAX : c);
}

export function updateCamera(G, dt) {
  const player = G.player;
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
  const want = cameraNear(G);
  const cur = Number.isFinite(cam.near) ? cam.near : want;
  cam.near = want < cur ? want : damp(cur, want, 5, dt);

  cam.update();
}
