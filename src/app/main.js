// src/app/main.js — boot and the frame loop for TORONTO.
//
// CONTRACT.md §3.3 and Amendment 11. This file owns three things and nothing else: the shared app
// state G, the boot sequence, and the frame loop. Everything that used to live here has moved out
// and is imported back:
//
//   ./controls.js  the free-roam controllers, the viewpoints, the camera and the key commands
//   ./hud.js       the 2D HUD
//   ./time.js      the time-of-day presets
//   ./quality.js   the device profile, the quality presets and the adaptive step
//   ./input.js     keyboard / mouse / pointer lock, and the left-handed KEY_ALIAS layer
//   ./touch.js     the multi-touch camera and the on-screen controls
//
// FREE ROAM ONLY: no gameplay, no vehicles, no NPCs, no weapons.
// World axes: X = east, Y = up, Z = south. Right-handed, TRUE METRES.

import { createGL } from '../core/gl.js';
import { Camera, Renderer } from '../render/renderer.js';
import { loadCity } from '../city.js';
import { Input } from './input.js';
import { TouchControls, detectPointer } from './touch.js';
import { clamp } from '../core/math.js';
import { TimeOfDay } from './time.js';
import {
  VIEWPOINTS, FOV_BASE, createPlayer, makeUnprojector,
  goToViewpoint, setMovementMode, updatePlayer, updateCamera, worldBounds,
} from './controls.js';
import { drawHud } from './hud.js';
import {
  QUALITY_PRESETS, DPR_CAP, DPR_MIN, HUD_DPR_CAP, VERT_BYTES,
  deviceProfile, writeQuality, nextQualityIndex, applyDeviceTileBudget, AutoQuality,
} from './quality.js';

/* ========================================================== backing store == */

// Backing-store resolution. The per-device caps and the reasoning behind them live in
// ./quality.js; `dprCap` is this machine's share of them and `dprScale` the adaptive
// controller's multiplier on top of that, and sizeCanvases() is the only place either is read.
let dprCap = DPR_CAP;
let dprScale = 1;               // adaptive multiplier on dprCap; 1 = the device's full share

/* ================================================================= device == */

// WHAT KIND OF MACHINE IS THIS? ./quality.js answers from capabilities the browser reports about
// itself — never a user-agent string — and hands back the backing-store cap, the opening and the
// best quality preset, the tile budget and the shadow distance for this class of device. boot()
// re-reads it once touch.js has reported the real pointer; the null here is the pre-boot default.

let DEVICE = deviceProfile(null);

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
  // Inverse of city.js's projector, for the HUD's lat/lon readout. Re-seated in boot()
  // from the city's own origin; this one is the documented default.
  unproject: makeUnprojector(null),
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

const player = createPlayer();
G.player = player;

if (typeof window !== 'undefined') window.G = G;

/* ================================================================ quality == */

/* ------------------------------------------------------------------ time of day */

// The presets themselves live in ./time.js. TimeOfDay holds the snapshot of the renderer's
// own blue-hour environment, so it has to be constructed once and kept — see the CN Tower
// correction in boot(), which has to reach into that snapshot as well as the live env.
const TIME = new TimeOfDay();

function applyTime(i) {
  const p = TIME.apply(G.renderer.env, i);
  G.timeOfDay = TIME.index;
  return p;
}

/* ------------------------------------------------------------------- presets */

function applyQuality(index, manual) {
  const n = QUALITY_PRESETS.length;
  const i = ((index % n) + n) % n;
  G.quality = i;
  // A deliberate press is the end of the argument: the adaptive step stops second-guessing the
  // user for the rest of the session. It says so in the HUD, so this is never a silent change.
  if (manual) AUTO.stop('manual');
  return writeQuality(G.renderer, i);
}

/**
 * The on-screen GFX button. A phone has no Q/E pair to hold, so one button steps DOWN through the
 * presets and wraps back to the richest one this device is allowed to run — cycling a phone up
 * into Ultra, where screen-space reflections cost more than the rest of the frame put together,
 * would only be a hole the next two taps have to climb out of.
 */
function cycleQuality() {
  return applyQuality(nextQualityIndex(G.quality, DEVICE.bestQuality), true);
}

/* --------------------------------------------------------- adaptive quality */

// The controller is ./quality.js's AutoQuality — measure, then move, and never oscillate; the
// reasoning lives with it. These three hooks are its ONLY contact with the app, which is why it
// can be driven by a test with three stubs and why nothing it does can surprise the loop.
const AUTO = new AutoQuality({
  // Neither the opening preset nor an adaptive step counts as the user having made a choice.
  applyQuality: (index) => applyQuality(index, false),
  setDprScale: (scale) => {
    if (dprScale !== scale) {
      dprScale = scale;
      sizeCanvases();        // reallocates every render target: settle time is why it is last
    }
  },
  isRunning: () => G.started,
});
G.auto = AUTO;

/* ================================================================= actions == */

// What a key MEANS, as opposed to what it is. controls.js maps the physical input and calls in
// here, so the controller never has to know about the quality ladder, the time presets or the
// HUD's flags — and the same handful of intents is what touch.js's on-screen buttons drive.
const ACTIONS = {
  toggleHelp: () => { G.showHelp = !G.showHelp; },
  toggleDebug: () => { G.showDebug = !G.showDebug; },
  nextTime: () => applyTime(G.timeOfDay + 1),
  setTime: (i) => applyTime(i),
  // "up" is a richer preset, which is a LOWER index. Both are deliberate presses and both stop
  // the adaptive step for the session.
  qualityUp: () => applyQuality(G.quality - 1, true),
  qualityDown: () => applyQuality(G.quality + 1, true),
  releaseCursor: (input) => { G.cursorReleased = true; input.exitLock(); },
};

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
  AUTO.sample(rawDt, t);

  const input = G.input;
  try {
    updatePlayer(G, input, dt, ACTIONS);
    updateCamera(G, dt);

    // Level of detail, culling, the geometry budget and eviction, before anything is drawn.
    G.city.update(G.camera, t);

    if (!G.renderer.contextLost) {
      G.renderer.env.time = (G.renderer.env.time + dt) % 100000;
      renderScene();
    }
    drawHud(G, input);
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
  if (!doc) throw new Error('no document — index.html must load src/app/main.js as a module');
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
    readBounds: (out) => { worldBounds(G, out); },
    isActive: () => (G.started && G.ready && !!G.city),
    hooks: {
      mode: () => player.mode,
      setMode: (mode, x, z) => setMovementMode(G, mode, x, z),
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
  AUTO.build(DEVICE, nowMs());
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
  G.unproject = makeUnprojector(G.city.meta && G.city.meta.origin);

  // Point the tile budget at this device before anything is built. On a phone the resident
  // vertex cap is as much a memory limit as a speed one — 48 bytes a vertex, and 11 M of them is
  // half a gigabyte of buffer objects that a mobile browser will not hand one tab.
  const tileTune = applyDeviceTileBudget(G.city, G.renderer, DEVICE);
  if (tileTune) {
    console.log('[toronto] ' + DEVICE.key + ' tile budget: massing ' +
      tileTune.before.mass + ' -> ' + tileTune.after.mass.toFixed(0) + ' m, detail ' +
      tileTune.before.detail + ' -> ' + tileTune.after.detail.toFixed(0) + ' m, cap ' +
      (tileTune.before.cap / 1e6).toFixed(1) + ' -> ' + (tileTune.after.cap / 1e6).toFixed(1) +
      ' M verts (' + Math.round(tileTune.after.cap * VERT_BYTES / 1048576) + ' MB)');
  }

  // The CN Tower's lighting rig is masked to a 34 m cylinder around the tower's axis, and
  // render.js can only carry a literal for that. Point it at the tower this dataset actually
  // holds. TIME.defaults is snapshotted before the city loads, so it has to be corrected too or
  // the next preset change writes the stale position straight back.
  {
    const cn = G.city.cnTower;
    const env = G.renderer.env;
    if (cn && cn.length >= 4 && env && env.cnTower) {
      for (let i = 0; i < 4; i++) env.cnTower[i] = cn[i];
      if (TIME.defaults && TIME.defaults.cnTower) {
        for (let i = 0; i < 4; i++) TIME.defaults.cnTower[i] = cn[i];
      }
    }
  }

  goToViewpoint(G, 0);
  updateCamera(G, 0.016);
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
    goToViewpoint(G, player.viewpoint);
    updateCamera(G, 0.016);
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
      AUTO.forgive(nowMs());
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
