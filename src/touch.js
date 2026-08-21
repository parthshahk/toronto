// src/touch.js — multi-touch camera, on-screen controls and the walk-mode thumbstick.
//
// The interaction model is Google Maps / Google Earth, because that is the one every phone user
// already knows:
//
//   one finger drag    PAN. The ground point under the finger stays under the finger.
//   two finger pinch   ZOOM = camera height, toward the point between the fingers.
//   two finger twist   HEADING, about the point between the fingers.
//   two finger drag    TILT (pitch), when both fingers travel roughly parallel and vertically.
//   double tap         one zoom step in, toward the tapped point.
//   two finger tap     one zoom step out.
//
// WHY THE PAN IS A RAYCAST AND NOT A PIXEL SCALE. A metres-per-pixel factor is wrong at every
// altitude and every tilt at once: the ground under the top of the screen is many times further
// away than the ground under the bottom, so a constant factor makes the map slide under the
// finger and the whole thing feels floaty. Instead the finger is projected through the camera
// onto the ground plane, and the camera translation is SOLVED so that the world point picked when
// the finger went down lands back under the finger. Because a horizontal translation moves the
// eye without changing its height or the ray directions, that solve is exact and self-correcting:
//
//     pick(screen, eye + T) = pick(screen, eye) + T      for horizontal T
//
// so every move event re-solves from the ORIGINAL anchor and any error from a clamp is paid back
// on the next event rather than accumulating. MEASURED residual drift of the tracked ground point,
// over drags of 160-370 px delivered in 2 to 40 events, from 60 m to 300 m of altitude and -7 to
// -56 degrees of tilt, against anchors 97 m to 1.6 km away: worst case 1.1e-13 m. That is float64
// round-off on a camera that moved 1.1 km; there is no drift to measure.
//
// DESKTOP IS UNTOUCHED. Every handler here returns immediately unless the event's pointerType is
// 'touch' or 'pen', so a mouse never reaches this module, and nothing here is installed at all on
// a machine that reports no touch points and a fine pointer. Hybrids (a touchscreen laptop) get
// BOTH: keyboard, mouse and pointer lock keep working exactly as before, and touch is added.

import { clamp, damp, angleWrap, angleDiff } from './math.js';

/* ================================================================ tunables == */

const TAP_MS = 320;              // a press longer than this is a drag, never a tap
const TAP_SLOP = 16;             // px a tap may travel and still count as a tap
const TWO_TAP_MS = 460;          // both fingers of a two-finger tap must be down and up inside this
const DOUBLE_TAP_MS = 330;
const DOUBLE_TAP_SLOP = 48;

// Two-finger gesture commit. The first of these thresholds to be crossed wins and the gesture is
// LOCKED for as long as the two fingers stay down: a pinch that drifts into a twist half way
// through feels broken, so it is simply not allowed to happen.
const PINCH_COMMIT = 26;         // px of change in finger separation
const TWIST_COMMIT = 0.14;       // rad of change in finger angle (8 degrees)
const TILT_COMMIT = 24;          // px of parallel vertical travel of the midpoint
const TILT_PARALLEL = 0.55;      // min dot() of the two fingers' unit travel to read as parallel
const TILT_VERTICAL = 1.15;      // and the midpoint must travel this much more vertically than not

const TILT_RATE = 0.0030;        // rad of pitch per px of midpoint travel
const PITCH_STEP = 0.10;         // max rad of pitch change per event — also eases a hybrid camera
const YAW_STEP = 0.35;           // max rad of heading change per event
const PINCH_STEP_MIN = 0.5;      // clamp on one event's zoom ratio, so a dropped frame cannot
const PINCH_STEP_MAX = 2.0;      // teleport the camera

// Camera envelope. Pitch never reaches the horizon (there is no ground point under the finger up
// there) and never quite reaches straight down (the yaw becomes meaningless).
const PITCH_MIN = -1.5359;       // -88 degrees
const PITCH_MAX = -0.0436;       // -2.5 degrees
const MIN_AGL = 4.5;             // metres above the terrain the camera may never go below
const MAX_ALT = 2300;            // metres — below main.js's CEILING, still frames the whole city

// Ray/plane picking.
const MIN_DOWN = 0.045;          // a pick ray is forced at least this far downward, so a finger
                                 // near the horizon still resolves to a finite ground point
// Absurdity guard on the ray parameter. It is deliberately LONGER than any pick the camera
// envelope can produce — MIN_DOWN and MAX_ALT bound a plane hit at 2300 / 0.045 = 51.1 km — so
// the pan solve is never capped and therefore stays exactly translation-equivariant. Capping a
// pick that a pinch then scales would slide the camera sideways every event; the pinch is rate
// limited on its horizontal travel instead, which costs nothing and stays exact.
const PICK_MAX = 60000;
const PLANE_GAP = 1.5;           // the picked plane is always at least this far below the eye

// Inertia. damp() is the frame-rate-independent exponential from math.js, so a flick decays over
// the same wall-clock time at 30 fps and at 120.
const PAN_DECAY = 4.2;
const PAN_STOP = 0.6;            // m/s below which the glide is finished
const SPIN_DECAY = 5.5;
const SPIN_STOP = 0.02;          // rad/s
// Release velocity is measured over a WINDOW of samples rather than differenced between the last
// two events. Touch runtimes deliver bursts — several moves stamped inside the same millisecond,
// especially on Android — and a last-pair difference divided by ~0 launches the camera into
// orbit. A window is immune: a burst that spans no time simply reports no velocity.
const FLICK_WINDOW = 110;        // ms of history kept
const FLICK_MIN_DT = 0.012;      // s the window must span before a velocity is believed
const FLICK_IDLE = 0.11;         // s of stillness before a release that kills the flick

const ZOOM_LAMBDA = 9.5;         // step-zoom animation rate
const ZOOM_IN = 0.55;            // double tap: 45% closer
const ZOOM_OUT = 1 / 0.55;

const LOOK_SENS = 1.35;          // walk mode: touch pixels -> mouse pixels for the look drag
const STICK_R = 56;              // walk mode: thumbstick travel, px
const STICK_DEAD = 6;

const NORTH_LAMBDA = 4.5;        // compass reset easing

/* ================================================================ on-screen == */

const BTN_R = 26;                // 52 px targets — Apple HIG minimum is 44
const BTN_GAP = 12;
const BTN_MARGIN = 22;

// Buttons per movement mode. `code` is a canonical input.js key code driven while the button is
// held; `act` is a one-shot action taken on press.
const BUTTONS_MAP = [
  { id: 'north', label: 'N', act: 'north' },
  { id: 'walk', label: 'WALK', act: 'walk' },
  { id: 'time', label: 'TIME', act: 'time' },
  { id: 'gfx', label: 'GFX', act: 'gfx' },
  { id: 'help', label: '?', act: 'help' },
];
const BUTTONS_WALK = [
  { id: 'map', label: 'MAP', act: 'map' },
  { id: 'run', label: 'RUN', act: 'run' },
  { id: 'jump', label: 'JUMP', code: 'Space' },
  { id: 'time', label: 'TIME', act: 'time' },
  { id: 'gfx', label: 'GFX', act: 'gfx' },
  { id: 'help', label: '?', act: 'help' },
];

export const TOUCH_HELP_ROWS = [
  ['Pan', 'One finger drag'],
  ['Height', 'Pinch'],
  ['  a step in / out', '2 taps · 2-finger tap'],
  ['Heading', 'Twist two fingers'],
  ['Tilt', 'Two fingers up / down'],
  ['Face north', 'N'],
  ['Walk / map', 'WALK · MAP'],
  ['  look', 'Drag the right side'],
  ['  move', 'Thumbstick, left'],
  ['Time of day', 'TIME'],
  ['Quality', 'GFX'],
  ['Help', '?'],
];

/* ================================================================= helpers == */

function fin(v, d) {
  return Number.isFinite(v) ? v : d;
}

function setFont(ctx, px, family, weight, spacing) {
  ctx.font = (weight ? weight + ' ' : '') + px + 'px ' + family;
  ctx.letterSpacing = spacing || '0px';
}

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

/**
 * What kind of pointing device is this? Reported honestly rather than sniffed from the user
 * agent, and the three answers are kept apart because they need different treatment:
 *   touch    the browser can deliver touch points at all -> install the gesture layer
 *   coarse   the PRIMARY pointer is a finger -> a phone or tablet: no pointer lock, on-screen UI
 *   fine     a mouse or trackpad is also present -> a hybrid: keep every desktop control live
 */
export function detectPointer() {
  const nav = (typeof navigator !== 'undefined') ? navigator : null;
  const win = (typeof window !== 'undefined') ? window : null;
  const maxTouchPoints = nav && Number.isFinite(nav.maxTouchPoints) ? nav.maxTouchPoints : 0;
  let coarse = false;
  let fine = false;
  if (win && typeof win.matchMedia === 'function') {
    try {
      coarse = !!win.matchMedia('(pointer: coarse)').matches;
      fine = !!win.matchMedia('(pointer: fine)').matches;
    } catch (e) { /* ancient browser: fall back to the touch-point count alone */ }
  }
  // `ontouchstart` on its own is not evidence: desktop Chrome exposes it whether or not a
  // digitizer exists, and treating that as a touch device would put a phone UI on a tower. It is
  // only consulted as a fallback for a genuinely coarse-pointered device too old to report
  // maxTouchPoints (Safari before iOS 13).
  const hasTouchEvents = !!(win && 'ontouchstart' in win);
  const touch = maxTouchPoints > 0 || (coarse && hasTouchEvents);
  return {
    touch,
    coarse,
    fine,
    maxTouchPoints,
    // A phone or a tablet: touch is the only way in, so the UI has to carry its own controls.
    primary: touch && coarse && !fine,
    // A touchscreen laptop: both, and NEITHER may be disabled to enable the other.
    hybrid: touch && fine,
  };
}

/* =================================================================== class == */

export class TouchControls {
  /**
   * @param {object} o
   *   canvas      the WebGL canvas (event target; its touch-action is forced to none)
   *   hud         the 2D HUD canvas, so its touch-action can be forced too
   *   input       the Input instance, for the walk-mode stick / look / buttons
   *   player      the live player state object from main.js (mutated in place)
   *   readView    (out) => void, fills {w, h, aspect, fov} in CSS pixels, and optionally
   *               out.safe = {top, right, bottom, left} — the safe-area insets, so no control
   *               is laid out under a notch, a rounded corner or a home indicator
   *   groundY     (x, z) => metres
   *   readBounds  (out) => void, fills {minX, maxX, minZ, maxZ}
   *   isActive    () => boolean, false while the title screen is up
   *   hooks       { mode(), setMode(m), help(), setHelp(b) }
   */
  constructor(o) {
    const opts = o || {};
    this.canvas = opts.canvas || null;
    this.hud = opts.hud || null;
    this.input = opts.input || null;
    this.player = opts.player || null;
    this._readView = typeof opts.readView === 'function' ? opts.readView : null;
    this._groundY = typeof opts.groundY === 'function' ? opts.groundY : null;
    this._readBounds = typeof opts.readBounds === 'function' ? opts.readBounds : null;
    this._isActive = typeof opts.isActive === 'function' ? opts.isActive : (() => true);
    this.hooks = opts.hooks || {};

    this.caps = detectPointer();
    this.enabled = false;         // set by attach()
    this.seen = false;            // a real touch has happened at least once
    this.lastTouchMs = -1e9;

    this._view = { w: 1, h: 1, aspect: 1, fov: 1.05, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
    this._bounds = { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 };
    this._rect = { left: 0, top: 0, width: 1, height: 1 };

    this.pointers = new Map();
    this._order = [];             // pointer ids in the order they went down

    // one-finger pan
    this._pan = null;             // { id, planeY, ax, az }
    // two-finger gesture, applied once per frame (see _onMove)
    this._two = null;             // { ia, ib, kind, planeY, ax, ay, az, d0, a0, mx0, my0, ... }
    this._twoDirty = false;

    // gesture bookkeeping for taps
    this._g = { n: 0, maxN: 0, t0: 0, moved: 0, kind: '' };
    this._lastTapMs = -1e9;
    this._lastTapX = 0;
    this._lastTapY = 0;

    // inertia. _hist is a flat [t, x, z, yaw] ring over the last FLICK_WINDOW ms.
    this._vx = 0;
    this._vz = 0;
    this._spin = 0;
    this._spinX = 0;
    this._spinZ = 0;
    this._hist = [];
    this._lastMoveMs = -1e9;

    // step-zoom animation
    this._zoom = null;            // { ax, ay, az, remain }
    // compass reset
    this._northT = 0;             // rad target, only live while _northOn
    this._northOn = false;

    this._run = false;
    this._stickId = -1;
    this._stick = { ox: 0, oy: 0, x: 0, y: 0, on: false };
    this._lookId = -1;

    this.buttons = [];
    this._btnMode = '';
    this._hint = 0;               // seconds the intro hint has been up

    this._tmpDir = [0, -1, 0];
    this._tmpHit = [0, 0, 0];
    this._pivot = [0, 0, 0];
    this._pivotX = 0;
    this._pivotZ = 0;
  }

  /* -------------------------------------------------------------- lifecycle */

  /** Install the listeners. Safe to call on a machine with no touch at all — it does nothing. */
  attach() {
    if (this.enabled) return this;
    const c = this.canvas;
    if (!c || typeof c.addEventListener !== 'function') return this;
    if (!this.caps.touch) return this;      // pure mouse machine: nothing to install
    this.enabled = true;

    // touch-action is NOT an inherited property, so the `touch-action: none` on html/body in
    // index.html does not reach the canvas: without this the browser scrolls, rubber-bands,
    // pull-to-refreshes and double-tap-zooms the page out from under every gesture below.
    const kill = (el) => {
      if (!el || !el.style) return;
      el.style.touchAction = 'none';
      el.style.webkitUserSelect = 'none';
      el.style.userSelect = 'none';
      el.style.webkitTouchCallout = 'none';
      el.style.webkitTapHighlightColor = 'rgba(0,0,0,0)';
    };
    kill(c);
    kill(this.hud);

    const opt = { passive: false };
    c.addEventListener('pointerdown', (e) => this._onDown(e), opt);
    c.addEventListener('pointermove', (e) => this._onMove(e), opt);
    c.addEventListener('pointerup', (e) => this._onUp(e, false), opt);
    c.addEventListener('pointercancel', (e) => this._onUp(e, true), opt);
    c.addEventListener('lostpointercapture', (e) => this._onUp(e, true), opt);

    // Belt and braces for iOS versions that honour touch-action late, and for the proprietary
    // Safari gesture events, which are how a two-finger pinch zooms the PAGE.
    c.addEventListener('touchmove', (e) => {
      if (this.pointers.size > 0 && e.cancelable) e.preventDefault();
    }, opt);
    const noGesture = (e) => {
      if (e && e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
    };
    c.addEventListener('gesturestart', noGesture, opt);
    c.addEventListener('gesturechange', noGesture, opt);
    c.addEventListener('gestureend', noGesture, opt);
    // Only a double TAP is swallowed here. A mouse double-click is a live desktop control
    // (it toggles the cursor) and must reach its own handler untouched.
    c.addEventListener('dblclick', (e) => { if (this.recentTouch(1200)) noGesture(e); }, opt);

    if (typeof window !== 'undefined') {
      const refresh = () => this._syncRect();
      window.addEventListener('resize', refresh);
      window.addEventListener('orientationchange', refresh);
      window.addEventListener('blur', () => this.reset());
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.reset();
      });
    }
    this._syncRect();
    return this;
  }

  /** True if a finger was on the glass within `ms`. main.js uses it to skip pointer lock. */
  recentTouch(ms) {
    if (!this.seen) return false;
    const w = Number.isFinite(ms) ? ms : 900;
    return (this._now() - this.lastTouchMs) < w;
  }

  /** Is the touch UI carrying the interaction? Drives the HUD's hints and the reticle. */
  get showUi() {
    return this.enabled && (this.caps.primary || this.seen);
  }

  /** Drop every gesture and every velocity. A cancelled touch must never leave the camera moving. */
  reset() {
    this.pointers.clear();
    this._order.length = 0;
    this._pan = null;
    this._two = null;
    this._twoDirty = false;
    this._g.n = 0;
    this._g.maxN = 0;
    this._g.kind = '';
    this._vx = 0;
    this._vz = 0;
    this._spin = 0;
    this._hist.length = 0;
    this._northOn = false;
    this._zoom = null;
    this._stickId = -1;
    this._lookId = -1;
    this._stick.on = false;
    this._run = false;
    for (let i = 0; i < this.buttons.length; i++) this.buttons[i].down = false;
    if (this.input) {
      this.input.setTouchStick(0, 0, false);
      this.input.setVirtual('Space', false);
      this.input.setVirtual('ShiftLeft', false);
    }
  }

  /* ------------------------------------------------------------- per frame */

  /**
   * Inertia, the step-zoom animation and the compass reset. Called once per frame from
   * main.js BEFORE the walk/fly integrators, so the ordinary movement code still owns velocity.
   */
  update(dt) {
    if (!this.enabled) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (!this.seen && !this.caps.primary) return;   // a desktop nobody has touched: nothing to do
    if (!this._isActive()) return;
    this._syncView();

    // The opening hint fades on its own even if the screen is never touched.
    if (this._hint < 30) this._hint += dt;
    if (!this.seen) return;

    const p = this.player;
    if (!p) return;

    // --- the pending two-finger transform, once, with both fingers up to date ----------------
    if (this._two && this._twoDirty) {
      this._twoDirty = false;
      this._applyTwo();
    }

    // --- step zoom (double tap / two-finger tap) -------------------------------------------
    const z = this._zoom;
    if (z) {
      const k = 1 - Math.exp(-ZOOM_LAMBDA * dt);
      const step = z.remain * k;
      z.remain -= step;
      this._dolly(Math.exp(step), z.ax, z.ay, z.az);
      if (Math.abs(z.remain) < 1e-3) this._zoom = null;
    }

    // --- pan inertia ------------------------------------------------------------------------
    // Only ever between gestures. While a finger is down the camera is SOLVED from the finger,
    // and adding a velocity on top of that solve would make the ground crawl under a thumb that
    // is holding still.
    const gliding = !this._pan && !this._two;
    if (gliding && (this._vx !== 0 || this._vz !== 0)) {
      p.x += this._vx * dt;
      p.z += this._vz * dt;
      this._vx = damp(this._vx, 0, PAN_DECAY, dt);
      this._vz = damp(this._vz, 0, PAN_DECAY, dt);
      if (Math.hypot(this._vx, this._vz) < PAN_STOP) { this._vx = 0; this._vz = 0; }
      this._clampWorld();
      this._clampAlt();
    }

    // --- twist inertia ----------------------------------------------------------------------
    if (gliding && this._spin !== 0) {
      this._rotateAbout(this._spinX, this._spinZ, this._spin * dt);
      this._spin = damp(this._spin, 0, SPIN_DECAY, dt);
      if (Math.abs(this._spin) < SPIN_STOP) this._spin = 0;
      this._clampWorld();
    }

    // --- compass reset ----------------------------------------------------------------------
    if (this._northOn) {
      const d = angleDiff(p.yaw, this._northT);
      if (Math.abs(d) < 0.0015) {
        this._rotateAbout(this._pivotX, this._pivotZ, d);
        this._northOn = false;
      } else {
        this._rotateAbout(this._pivotX, this._pivotZ, d * (1 - Math.exp(-NORTH_LAMBDA * dt)));
      }
      this._clampWorld();
    }

    if (!Number.isFinite(p.x + p.y + p.z + p.yaw + p.pitch)) {
      // main.js has its own last line of defence, but a gesture must not be the thing that
      // hands it a NaN. Undo everything this module is holding and let the frame continue.
      this.reset();
      this._zoom = null;
    }
  }

  /* ------------------------------------------------------------ projection */

  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  _syncView() {
    if (this._readView) this._readView(this._view);
    const v = this._view;
    if (!(v.w > 0)) v.w = 1;
    if (!(v.h > 0)) v.h = 1;
    if (!(v.aspect > 0)) v.aspect = v.w / v.h;
    if (!(v.fov > 0.05)) v.fov = 1.05;
    // The insets are advisory and a host that never fills them in must still get a sane layout,
    // so they are sanitised here rather than trusted. Half the viewport is the absurdity guard.
    let s = v.safe;
    if (!s) { s = { top: 0, right: 0, bottom: 0, left: 0 }; v.safe = s; }
    s.top = clamp(fin(s.top, 0), 0, v.h * 0.5);
    s.bottom = clamp(fin(s.bottom, 0), 0, v.h * 0.5);
    s.left = clamp(fin(s.left, 0), 0, v.w * 0.5);
    s.right = clamp(fin(s.right, 0), 0, v.w * 0.5);
  }

  _syncRect() {
    const c = this.canvas;
    if (!c || typeof c.getBoundingClientRect !== 'function') return;
    const r = c.getBoundingClientRect();
    this._rect.left = fin(r.left, 0);
    this._rect.top = fin(r.top, 0);
    this._rect.width = r.width > 0 ? r.width : 1;
    this._rect.height = r.height > 0 ? r.height : 1;
  }

  /** Event coordinates -> HUD-space CSS pixels, the space the overlay is laid out in. */
  _local(e, out) {
    const r = this._rect;
    const v = this._view;
    out.x = (fin(e.clientX, 0) - r.left) * (v.w / r.width);
    out.y = (fin(e.clientY, 0) - r.top) * (v.h / r.height);
    return out;
  }

  /**
   * Screen point -> world ray, forced to point downward by at least MIN_DOWN so it always meets
   * the ground plane. Forcing keeps the ray's compass bearing and only steepens it, so a drag
   * near the horizon still pans the right way, just a long way.
   */
  _ray(sx, sy) {
    const p = this.player;
    const v = this._view;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const sy0 = Math.sin(p.yaw), cy0 = Math.cos(p.yaw);
    // Camera basis. right = cross(forward, worldUp) is pitch-independent; up = cross(right, fwd).
    const fx = sy0 * cp, fy = sp, fz = cy0 * cp;
    const rx = -cy0, rz = sy0;
    const ux = -sy0 * sp, uy = cp, uz = -cy0 * sp;

    const th = Math.tan(clamp(v.fov, 0.2, 2.6) * 0.5);
    const ax = (2 * sx / v.w - 1) * th * v.aspect;
    const ay = (1 - 2 * sy / v.h) * th;

    let dx = fx + rx * ax + ux * ay;
    let dy = fy + uy * ay;
    let dz = fz + rz * ax + uz * ay;
    const l = Math.hypot(dx, dy, dz);
    const out = this._tmpDir;
    if (!(l > 1e-9)) { out[0] = 0; out[1] = -1; out[2] = 0; return out; }
    dx /= l; dy /= l; dz /= l;

    if (dy > -MIN_DOWN) {
      const hl = Math.hypot(dx, dz);
      if (!(hl > 1e-9)) { out[0] = 0; out[1] = -1; out[2] = 0; return out; }
      const s = Math.sqrt(Math.max(0, 1 - MIN_DOWN * MIN_DOWN)) / hl;
      dx *= s; dz *= s; dy = -MIN_DOWN;
    }
    out[0] = dx; out[1] = dy; out[2] = dz;
    return out;
  }

  /**
   * Where the ray through (sx, sy) meets the horizontal plane at planeY, capped at tCap metres.
   * BOTH the cap and the plane depend only on the ray direction and the EYE HEIGHT, never on the
   * eye's horizontal position, which is exactly what makes the pan solve below exact.
   */
  _pick(sx, sy, planeY, tCap, out) {
    const p = this.player;
    const d = this._ray(sx, sy);
    let t = (planeY - p.y) / d[1];        // d[1] <= -MIN_DOWN, never zero
    if (!(t > 0)) t = 0;
    const cap = Number.isFinite(tCap) && tCap > 0 ? Math.min(tCap, PICK_MAX) : PICK_MAX;
    if (t > cap) t = cap;
    out[0] = p.x + d[0] * t;
    out[1] = p.y + d[1] * t;
    out[2] = p.z + d[2] * t;
    return out;
  }

  /** The plane a gesture works against: the terrain under the camera, always below the eye. */
  _planeFor() {
    const p = this.player;
    let g = this._groundY ? this._groundY(p.x, p.z) : 0;
    g = fin(g, 0);
    const lid = p.y - PLANE_GAP;
    return g > lid ? lid : g;
  }

  /** Horizontal distance the two-finger anchor is allowed to sit at, frozen per gesture. */
  _anchorCap() {
    const p = this.player;
    const alt = Math.max(1, p.y - this._planeFor());
    return clamp(alt * 8, 250, 3500);
  }

  /* -------------------------------------------------------------- movement */

  _clampWorld() {
    const p = this.player;
    if (this._readBounds) this._readBounds(this._bounds);
    const b = this._bounds;
    p.x = clamp(fin(p.x, 0), b.minX, b.maxX);
    p.z = clamp(fin(p.z, 0), b.minZ, b.maxZ);
  }

  _clampAlt() {
    const p = this.player;
    const g = fin(this._groundY ? this._groundY(p.x, p.z) : 0, 0);
    const minY = g + MIN_AGL;
    if (!(p.y > minY)) p.y = minY;
    if (p.y > MAX_ALT) p.y = MAX_ALT;
  }

  /** Solve the horizontal translation that puts the world point (ax, az) back under (sx, sy). */
  _panSolve(ax, az, sx, sy, planeY, tCap) {
    const p = this.player;
    const hit = this._pick(sx, sy, planeY, tCap, this._tmpHit);
    let dx = ax - hit[0];
    let dz = az - hit[2];
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    // Rate limit. It never fires on a real drag; when it does — a huge event gap, a finger
    // arriving from off-screen — the next event solves from the same anchor and the remainder is
    // paid back, so the world point still ends up under the finger.
    const alt = Math.max(1, p.y - planeY);
    const lim = Math.max(150, alt * 3.5);
    const l = Math.hypot(dx, dz);
    if (l > lim && l > 1e-9) { const s = lim / l; dx *= s; dz *= s; }
    p.x += dx;
    p.z += dz;
    this._clampWorld();
    this._track();
  }

  /** Record where the camera is, for the release velocity. */
  _track() {
    const p = this.player;
    const now = this._now();
    this._lastMoveMs = now;
    const h = this._hist;
    h.push(now, p.x, p.z, p.yaw);
    while (h.length > 4 && now - h[0] > FLICK_WINDOW) h.splice(0, 4);
  }

  /** Metres/second and radians/second over the sample window, or null if it spans no time. */
  _releaseVelocity() {
    const h = this._hist;
    const n = h.length;
    if (n < 8) return null;
    const dt = (h[n - 4] - h[0]) * 0.001;
    if (!(dt >= FLICK_MIN_DT)) return null;
    const p = this.player;
    // Cap by altitude: a flick may glide, it may not launch. v / PAN_DECAY is the glide length,
    // so this is a couple of screenfuls at any height.
    const vmax = 8 * (Math.abs(p.y - this._planeFor()) + 25);
    let vx = (h[n - 3] - h[1]) / dt;
    let vz = (h[n - 2] - h[2]) / dt;
    const sp = Math.hypot(vx, vz);
    if (sp > vmax && sp > 1e-6) { const s = vmax / sp; vx *= s; vz *= s; }
    let spin = angleWrap(h[n - 1] - h[3]) / dt;
    spin = clamp(spin, -8, 8);
    return { vx, vz, spin };
  }

  /**
   * Scale the camera position about a world anchor: the anchor keeps its screen position, so a
   * pinch zooms toward the point between the fingers and nothing else moves under them.
   * `limit` rate-limits the HORIZONTAL travel, which is the only thing that can get silly — the
   * ground point under two fingers held near the horizon at 2 km up is genuinely tens of km away,
   * and 5% of that in one event is a teleport. Limiting the ratio rather than the translation
   * keeps the dolly a pure dolly, so the anchor stays put on screen either way.
   */
  _dolly(sWant, ax, ay, az, limit) {
    const p = this.player;
    let s = clamp(fin(sWant, 1), 0.02, 50);
    if (limit) {
      const dH = Math.hypot(p.x - ax, p.z - az);
      if (dH > 1e-6) {
        const room = Math.max(80, (p.y - ay) * 1.4) / dH;
        s = clamp(s, 1 - room, 1 + room);
      }
    }
    const rise = p.y - ay;
    if (Math.abs(rise) > 1e-3) {
      const g = fin(this._groundY ? this._groundY(p.x, p.z) : 0, 0);
      const want = clamp(ay + rise * s, g + MIN_AGL, MAX_ALT);
      s = (want - ay) / rise;
      if (!Number.isFinite(s) || s <= 0) return;
    }
    p.x = ax + (p.x - ax) * s;
    p.y = ay + (p.y - ay) * s;
    p.z = az + (p.z - az) * s;
    this._clampWorld();
    this._clampAlt();
  }

  /** Rotate the camera about the vertical axis through (ax, az); the pivot stays put on screen. */
  _rotateAbout(ax, az, a) {
    if (!Number.isFinite(a) || a === 0) return;
    const p = this.player;
    const ca = Math.cos(a), sa = Math.sin(a);
    const dx = p.x - ax, dz = p.z - az;
    p.x = ax + dx * ca + dz * sa;
    p.z = az - dx * sa + dz * ca;
    p.yaw = angleWrap(p.yaw + a);
  }

  /**
   * Tilt. The ground point at the middle of the screen is held while the pitch changes, which is
   * pure trigonometry: its horizontal distance is altitude / tan(-pitch), so the camera simply
   * slides along its own bearing by the difference. Altitude is untouched, which keeps "pinch =
   * height" the only control that changes it.
   */
  _tilt(dPitch) {
    const p = this.player;
    const planeY = this._planeFor();
    const alt = Math.max(1, p.y - planeY);
    const cap = clamp(alt * 8, 250, 3500);
    const reach = (pitch) => {
      const t = Math.tan(-pitch);
      if (!(t > 1e-4)) return cap;
      return Math.min(alt / t, cap);
    };
    const before = reach(p.pitch);
    let want = clamp(p.pitch + dPitch, PITCH_MIN, PITCH_MAX);
    want = clamp(want, p.pitch - PITCH_STEP, p.pitch + PITCH_STEP);
    if (want === p.pitch) return;
    const after = reach(want);
    p.pitch = want;
    const d = before - after;
    p.x += Math.sin(p.yaw) * d;
    p.z += Math.cos(p.yaw) * d;
    this._clampWorld();
    this._clampAlt();
  }

  /** The ground point at the centre of the screen — the pivot for the compass reset. */
  _centrePivot() {
    const v = this._view;
    const planeY = this._planeFor();
    const hit = this._pick(v.w * 0.5, v.h * 0.5, planeY, this._anchorCap(), this._pivot);
    this._pivotX = hit[0];
    this._pivotZ = hit[2];
  }

  _stepZoom(sx, sy, ratio) {
    const planeY = this._planeFor();
    const hit = this._pick(sx, sy, planeY, this._anchorCap(), this._tmpHit);
    this._zoom = { ax: hit[0], ay: hit[1], az: hit[2], remain: Math.log(ratio) };
    this._vx = 0;
    this._vz = 0;
  }

  /* ---------------------------------------------------------------- events */

  _isTouch(e) {
    const t = e && e.pointerType;
    // A mouse NEVER reaches this module. Pen is treated as a finger — on a tablet it is one.
    if (t === undefined) return this.caps.primary;    // very old Pointer Events shim
    return t === 'touch' || t === 'pen';
  }

  _onDown(e) {
    if (!this._isTouch(e)) return;
    this.seen = true;
    this.lastTouchMs = this._now();
    if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
    try {
      if (this.canvas && typeof this.canvas.setPointerCapture === 'function') {
        this.canvas.setPointerCapture(e.pointerId);
      }
    } catch (err) { /* capture is a nicety; the window-level up still lands */ }

    if (!this._isActive()) return;
    this._syncRect();
    this._syncView();
    const pt = {
      id: e.pointerId, x: 0, y: 0, sx: 0, sy: 0,
      t0: this.lastTouchMs, moved: 0, kind: '', counted: false, btn: null,
    };
    this._local(e, pt);
    pt.sx = pt.x;
    pt.sy = pt.y;

    // The help sheet is modal: any touch anywhere dismisses it and goes no further.
    if (this.hooks.help && this.hooks.help()) {
      if (this.hooks.setHelp) this.hooks.setHelp(false);
      pt.kind = 'dead';
      this.pointers.set(pt.id, pt);
      this._order.push(pt.id);
      return;
    }

    const btn = this._hitButton(pt.x, pt.y);
    if (btn) {
      pt.kind = 'button';
      pt.btn = btn;
      btn.down = true;
      this._press(btn);
      this.pointers.set(pt.id, pt);
      this._order.push(pt.id);
      return;
    }

    const walking = this._mode() === 'walk';
    if (walking) {
      const v = this._view;
      if (this._stickId < 0 && pt.x < v.w * 0.46 && pt.y > v.h * 0.34) {
        pt.kind = 'stick';
        this._stickId = pt.id;
        this._stick.ox = pt.x;
        this._stick.oy = pt.y;
        this._stick.x = 0;
        this._stick.y = 0;
        this._stick.on = true;
      } else if (this._lookId < 0) {
        pt.kind = 'look';
        this._lookId = pt.id;
      } else {
        pt.kind = 'dead';
      }
    } else {
      pt.kind = 'cam';
    }

    this.pointers.set(pt.id, pt);
    this._order.push(pt.id);

    // Gesture bookkeeping, for taps. Buttons never take part: holding JUMP and dragging with the
    // other thumb is one gesture, not two.
    if (this._g.n === 0) {
      this._g.maxN = 0;
      this._g.moved = 0;
      this._g.t0 = pt.t0;
      this._g.kind = '';
    }
    this._g.n++;
    pt.counted = true;
    if (this._g.n > this._g.maxN) this._g.maxN = this._g.n;

    if (pt.kind === 'cam') {
      this._stopInertia();
      this._restartCamera();
    }
  }

  _onMove(e) {
    if (!this._isTouch(e)) return;
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    this.lastTouchMs = this._now();
    if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
    if (!this._isActive()) return;
    this._syncView();

    const px = pt.x, py = pt.y;
    this._local(e, pt);
    const travel = Math.hypot(pt.x - pt.sx, pt.y - pt.sy);
    if (travel > pt.moved) pt.moved = travel;
    if (travel > this._g.moved) this._g.moved = travel;

    if (pt.kind === 'look') {
      const dx = pt.x - px;
      const dy = pt.y - py;
      if (this.input && typeof this.input.addLookDelta === 'function') {
        this.input.addLookDelta(dx * LOOK_SENS, dy * LOOK_SENS);
      }
      return;
    }
    if (pt.kind === 'stick') {
      let dx = pt.x - this._stick.ox;
      let dy = pt.y - this._stick.oy;
      const l = Math.hypot(dx, dy);
      if (l > STICK_R && l > 1e-6) { const s = STICK_R / l; dx *= s; dy *= s; }
      this._stick.x = dx;
      this._stick.y = dy;
      const mag = Math.hypot(dx, dy);
      if (mag > STICK_DEAD) {
        const k = Math.min(1, (mag - STICK_DEAD) / (STICK_R - STICK_DEAD)) / mag;
        if (this.input) this.input.setTouchStick(dx * k, -dy * k, true);
      } else if (this.input) {
        this.input.setTouchStick(0, 0, true);
      }
      return;
    }
    if (pt.kind !== 'cam') return;

    // TWO-FINGER WORK IS BATCHED TO THE FRAME. A browser delivers multi-touch moves ONE POINTER
    // AT A TIME, so acting on each event in turn means acting on a pair where one finger has
    // moved and the other has not — and half a finger of travel looks exactly like a twist. That
    // is not a synthetic-event artifact; it is how real hardware reports, and it made a
    // two-finger tilt commit as a twist and throw the camera four kilometres. Waiting for the
    // frame gives both fingers their current position before anything is decided, which is also
    // the only moment the result could be shown.
    if (this._two) this._twoDirty = true;
    else if (this._pan && this._pan.id === pt.id) {
      // The finger is driving a pan now, so a spin carried over from a twist it was part of is
      // over. Without this, lifting one finger and dragging with the other would keep rotating.
      this._spin = 0;
      this._panSolve(this._pan.ax, this._pan.az, pt.x, pt.y, this._pan.planeY, PICK_MAX);
      this._clampAlt();
    }
  }

  _onUp(e, cancelled) {
    if (!this._isTouch(e)) return;
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    this.lastTouchMs = this._now();
    if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();

    // Forget the pointer BEFORE releasing capture: releasing fires lostpointercapture
    // synchronously, which lands right back here, and a second pass would decrement the gesture
    // count twice and end the gesture from underneath itself.
    this.pointers.delete(pt.id);
    const oi = this._order.indexOf(pt.id);
    if (oi >= 0) this._order.splice(oi, 1);
    try {
      if (this.canvas && typeof this.canvas.releasePointerCapture === 'function' &&
          this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch (err) { /* already gone */ }

    if (pt.kind === 'button') {
      if (pt.btn) {
        pt.btn.down = false;
        this._release(pt.btn);
      }
    } else if (pt.kind === 'stick') {
      this._stickId = -1;
      this._stick.on = false;
      if (this.input) this.input.setTouchStick(0, 0, false);
    } else if (pt.kind === 'look') {
      this._lookId = -1;
    } else if (pt.kind === 'cam') {
      const flick = !cancelled && this._flickable();
      this._endCamera(flick);
    }

    if (!pt.counted) return;
    this._g.n = Math.max(0, this._g.n - 1);
    if (this._g.n === 0) {
      if (!cancelled && pt.kind === 'cam') this._settleTaps(pt);
      this._g.maxN = 0;
      this._g.kind = '';
    }
  }

  /** A drag that stopped moving before the finger came up must not fling. */
  _flickable() {
    return (this._now() - this._lastMoveMs) * 0.001 < FLICK_IDLE;
  }

  _settleTaps(last) {
    const now = this._now();
    const dur = now - this._g.t0;
    if (this._mode() === 'walk') return;              // taps are not a walk-mode control
    if (this._g.kind === 'two') return;               // a committed pinch/twist/tilt is not a tap

    if (this._g.maxN === 1 && dur < TAP_MS && this._g.moved < TAP_SLOP) {
      const dx = last.sx - this._lastTapX;
      const dy = last.sy - this._lastTapY;
      if (now - this._lastTapMs < DOUBLE_TAP_MS && Math.hypot(dx, dy) < DOUBLE_TAP_SLOP) {
        this._stepZoom(last.sx, last.sy, ZOOM_IN);
        this._lastTapMs = -1e9;
        this._hint = 30;
      } else {
        this._lastTapMs = now;
        this._lastTapX = last.sx;
        this._lastTapY = last.sy;
      }
    } else if (this._g.maxN === 2 && dur < TWO_TAP_MS && this._g.moved < TAP_SLOP * 1.6) {
      const v = this._view;
      this._stepZoom(v.w * 0.5, v.h * 0.5, ZOOM_OUT);
      this._lastTapMs = -1e9;
      this._hint = 30;
    }
  }

  /* ------------------------------------------------------- camera gestures */

  /** A finger arriving stops everything the camera was still doing on its own. */
  _stopInertia() {
    this._vx = 0;
    this._vz = 0;
    this._spin = 0;
    this._northOn = false;
    this._zoom = null;      // a finger on the glass stops a step zoom dead, as it should
  }

  /**
   * (Re)build the pan / two-finger state from whichever camera pointers are down right now.
   * Velocities are deliberately NOT touched here: this also runs when one finger of a two-finger
   * gesture lifts, and a twist that ends with both fingers leaving a few milliseconds apart has
   * to keep its spin across that handover or rotational inertia could never fire at all.
   */
  _restartCamera() {
    const cams = [];
    for (let i = 0; i < this._order.length; i++) {
      const q = this.pointers.get(this._order[i]);
      if (q && q.kind === 'cam') cams.push(q);
    }
    this._pan = null;
    this._two = null;
    this._twoDirty = false;
    this._hist.length = 0;
    if (cams.length === 0) return;

    const planeY = this._planeFor();
    if (cams.length === 1) {
      const hit = this._pick(cams[0].x, cams[0].y, planeY, PICK_MAX, this._tmpHit);
      this._pan = { id: cams[0].id, planeY, ax: hit[0], az: hit[2] };
      this._lastMoveMs = this._now();
      return;
    }

    const a = cams[0], b = cams[1];
    const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
    const hit = this._pick(mx, my, planeY, PICK_MAX, this._tmpHit);
    this._two = {
      ia: a.id, ib: b.id,
      planeY,
      ax: hit[0], ay: hit[1], az: hit[2],
      d0: Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y)),
      a0: Math.atan2(b.y - a.y, b.x - a.x),
      mx0: mx, my0: my,
      d: Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y)),
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      mx, my,
      kind: '',
    };
    this._lastMoveMs = this._now();
  }

  _endCamera(flick) {
    const two = this._two;
    const rel = flick ? this._releaseVelocity() : null;
    this._vx = 0;
    this._vz = 0;
    if (two) this._spin = 0;             // a pinch or a tilt ending cancels any carried spin
    if (rel) {
      if (!two || two.kind !== 'tilt') { this._vx = rel.vx; this._vz = rel.vz; }
      if (two && two.kind === 'twist') {
        this._spin = rel.spin;
        this._spinX = two.ax;
        this._spinZ = two.az;
      }
    }
    if (!flick) { this._vx = 0; this._vz = 0; this._spin = 0; }
    this._pan = null;
    this._two = null;
    // A finger lifted off a two-finger gesture leaves the other one still down: hand it a fresh
    // anchor so the pan carries on from where it is instead of snapping. Nothing glides while a
    // finger is still on the glass, so any velocity kept here is inert until the last one leaves.
    this._restartCamera();
    if (this._pan || this._two) { this._vx = 0; this._vz = 0; }
  }

  /** One move event's worth of two-finger transform, applied to whichever kind is committed. */
  _applyTwo() {
    const two = this._two;
    if (!two) return;
    const a = this.pointers.get(two.ia);
    const b = this.pointers.get(two.ib);
    if (!a || !b) return;

    const d = Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y));
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;

    if (two.kind === '') {
      // Score each candidate against its own threshold and take the first past 1.0, scoring the
      // travel SINCE THE GESTURE STARTED rather than the last event's delta — accumulated travel
      // barely changes direction if one finger reports a frame late, an instantaneous delta
      // inverts.
      //
      // PARALLEL MOTION CANNOT BE A PINCH OR A TWIST. Two fingers moving the same way are a
      // translation of the pair; whatever separation or rotation the numbers show is residue
      // from the two fingers not being sampled at quite the same instant. Suppressing by
      // (1 - par) is smooth and costs a genuine pinch nothing: real pinches and twists move the
      // fingers in OPPOSITE directions, where par is near -1.
      const ax = a.x - a.sx, ay = a.y - a.sy;
      const bx = b.x - b.sx, by = b.y - b.sy;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const par = (la > 1e-3 && lb > 1e-3) ? (ax * bx + ay * by) / (la * lb) : 0;
      const solo = par > TILT_PARALLEL ? Math.max(0, 1 - par) : 1;

      const sPinch = solo * Math.abs(d - two.d0) / PINCH_COMMIT;
      const sTwist = solo * Math.abs(angleWrap(ang - two.a0)) / TWIST_COMMIT;
      let sTilt = 0;
      if (par > TILT_PARALLEL) {
        const dmy = my - two.my0, dmx = mx - two.mx0;
        if (Math.abs(dmy) > Math.abs(dmx) * TILT_VERTICAL) sTilt = Math.abs(dmy) / TILT_COMMIT;
      }
      const best = Math.max(sPinch, sTwist, sTilt);
      if (best >= 1) {
        two.kind = (best === sTilt) ? 'tilt' : (best === sTwist ? 'twist' : 'pinch');
        this._g.kind = 'two';
        this._hint = 30;
        if (two.kind === 'tilt') {
          this._vx = 0;
          this._vz = 0;
        }
      }
    }

    if (two.kind === 'pinch') {
      const s = clamp(two.d / d, PINCH_STEP_MIN, PINCH_STEP_MAX);
      this._dolly(s, two.ax, two.ay, two.az, true);
    } else if (two.kind === 'twist') {
      const da = clamp(angleWrap(ang - two.ang), -YAW_STEP, YAW_STEP);
      this._rotateAbout(two.ax, two.az, da);
      this._clampWorld();
      this._spinX = two.ax;
      this._spinZ = two.az;
    } else if (two.kind === 'tilt') {
      this._tilt(-TILT_RATE * (my - two.my));
    }

    // The midpoint stays glued to its ground point for everything except a tilt, where the
    // fingers are deliberately sweeping the screen and panning as well would fight the gesture.
    if (two.kind !== 'tilt') {
      this._panSolve(two.ax, two.az, mx, my, two.planeY, PICK_MAX);
    } else {
      this._track();
    }
    this._clampAlt();

    two.d = d;
    two.ang = ang;
    two.mx = mx;
    two.my = my;
  }

  /* --------------------------------------------------------------- buttons */

  _mode() {
    return (this.hooks.mode ? this.hooks.mode() : 'fly') === 'walk' ? 'walk' : 'fly';
  }

  _buttonSpec() {
    return this._mode() === 'walk' ? BUTTONS_WALK : BUTTONS_MAP;
  }

  _layout() {
    const mode = this._mode();
    if (mode !== this._btnMode) {
      const spec = this._buttonSpec();
      this.buttons = [];
      for (let i = 0; i < spec.length; i++) {
        const s = spec[i];
        this.buttons.push({
          id: s.id, label: s.label, act: s.act || '', code: s.code || '',
          cx: 0, cy: 0, r: BTN_R, down: false,
        });
      }
      this._btnMode = mode;
    }
    const v = this._view;
    const n = this.buttons.length;
    if (n === 0) return this.buttons;

    // The bottom-left readout and the mandatory attribution own the foot of the screen; the stack
    // sits above them, and folds into rows when a landscape phone is too short for a column.
    // Every anchor is measured from the SAFE edge, not the glass edge, so nothing lands under a
    // home indicator, a rounded corner or a landscape notch.
    const s = this._insets();
    const narrow = v.w < 720;
    const pitch = BTN_R * 2 + BTN_GAP;
    const right = v.w - s.right - BTN_MARGIN - BTN_R;
    const topLimit = s.top + 84;                       // the compass and the street name
    const bottom = v.h - s.bottom - (narrow ? 124 : 70);
    const need = n * pitch - BTN_GAP;
    if (bottom - need > topLimit) {
      for (let i = 0; i < n; i++) {
        const b = this.buttons[i];
        b.cx = right;
        b.cy = bottom - BTN_R - i * pitch;
      }
    } else {
      // Rows, filling right to left and stacking upward. `per` is measured rather than assumed:
      // six buttons in one row is 372 px, which a 375 px portrait screen does not have.
      const room = v.w - s.left - s.right - BTN_MARGIN * 2;
      const per = Math.max(1, Math.min(n, Math.floor((room + BTN_GAP) / pitch)));
      const base = v.h - s.bottom - BTN_MARGIN - BTN_R - (narrow ? 30 : 34);
      for (let i = 0; i < n; i++) {
        const b = this.buttons[i];
        b.cx = right - (i % per) * pitch;
        b.cy = base - Math.floor(i / per) * pitch;
      }
    }
    return this.buttons;
  }

  /** The safe-area insets, never trusted and never undefined. */
  _insets() {
    const s = this._view.safe;
    if (!s) return { top: 0, right: 0, bottom: 0, left: 0 };
    const v = this._view;
    return {
      top: clamp(fin(s.top, 0), 0, v.h * 0.5),
      right: clamp(fin(s.right, 0), 0, v.w * 0.5),
      bottom: clamp(fin(s.bottom, 0), 0, v.h * 0.5),
      left: clamp(fin(s.left, 0), 0, v.w * 0.5),
    };
  }

  _hitButton(x, y) {
    const list = this._layout();
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      // A generous square target around the drawn circle: fingers are not styluses.
      if (Math.abs(x - b.cx) <= b.r + 6 && Math.abs(y - b.cy) <= b.r + 6) return b;
    }
    return null;
  }

  _press(b) {
    if (b.code && this.input) this.input.setVirtual(b.code, true);
    if (!b.act) return;
    if (b.act === 'help') {
      if (this.hooks.setHelp && this.hooks.help) this.hooks.setHelp(!this.hooks.help());
    } else if (b.act === 'walk') {
      // Land where the camera was looking, not under the camera.
      this._centrePivot();
      const px = this._pivotX, pz = this._pivotZ;
      this.reset();
      if (this.hooks.setMode) this.hooks.setMode('walk', px, pz);
      this._hint = 0;
    } else if (b.act === 'map') {
      this.reset();
      if (this.hooks.setMode) this.hooks.setMode('fly');
      this._levelForMap();
      this._hint = 0;
    } else if (b.act === 'run') {
      this._run = !this._run;
      if (this.input) this.input.setVirtual('ShiftLeft', this._run);
    } else if (b.act === 'time') {
      if (this.hooks.nextTime) this.hooks.nextTime();
      this._hint = 30;
    } else if (b.act === 'gfx') {
      if (this.hooks.nextQuality) this.hooks.nextQuality();
      this._hint = 30;
    } else if (b.act === 'north') {
      this._centrePivot();
      this._northT = Math.PI;              // bearing 0: main.js's yawToBearing is PI - yaw
      this._northOn = true;
      this._spin = 0;
      this._hint = 30;
    }
  }

  _release(b) {
    if (b.code && this.input) this.input.setVirtual(b.code, false);
  }

  /** Leaving walk mode: lift off the pavement and look down, or the map camera starts underground. */
  _levelForMap() {
    const p = this.player;
    const g = fin(this._groundY ? this._groundY(p.x, p.z) : 0, 0);
    const want = g + 240;
    if (p.y < want) p.y = want;
    if (p.pitch > PITCH_MAX) p.pitch = -0.42;
    p.pitch = clamp(p.pitch, PITCH_MIN, PITCH_MAX);
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.grounded = false;
    p.warped = true;          // 240 m in one frame is a teleport, not 14,000 km/h
    this._clampAlt();
  }

  /* --------------------------------------------------------------- overlay */

  /** True when the crosshair would be meaningless — a map camera driven by fingers. */
  hideReticle() {
    return this.showUi && this._mode() !== 'walk';
  }

  /**
   * Drawn onto the HUD canvas from main.js's drawHud(), in CSS pixels. Geometry and colour only:
   * the same thin cyan-on-ink language as the rest of the HUD.
   */
  drawOverlay(ctx, w, h) {
    if (!this.showUi || !ctx) return;
    this._view.w = w;
    this._view.h = h;
    const list = this._layout();
    const walking = this._mode() === 'walk';

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const lit = b.down || (b.act === 'run' && this._run) || (b.act === 'north' && this._northOn);
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2);
      ctx.fillStyle = lit ? 'rgba(133, 194, 212, 0.30)' : 'rgba(9, 16, 27, 0.52)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = lit ? 'rgba(180, 226, 240, 0.85)' : 'rgba(200, 220, 232, 0.34)';
      ctx.stroke();
      const long = b.label.length > 2;
      setFont(ctx, long ? 10 : 13, MONO, '500', long ? '0.1em' : '0.14em');
      ctx.fillStyle = lit ? 'rgba(238, 248, 252, 0.98)' : 'rgba(207, 228, 238, 0.86)';
      // letterSpacing pads the right of the last glyph; nudge back so the label reads centred.
      ctx.fillText(b.label, b.cx - (long ? 0.6 : 1), b.cy + 0.5);
    }

    if (walking) this._drawStick(ctx, w, h);
    this._drawHint(ctx, w, h, walking);
    ctx.restore();
  }

  _drawStick(ctx, w, h) {
    const on = this._stick.on;
    const s = this._insets();
    const hx = s.left + 26 + STICK_R;
    const hy = h - s.bottom - (w < 720 ? 208 : 150) - STICK_R;
    const ox = on ? this._stick.ox : hx;
    const oy = on ? this._stick.oy : hy;

    ctx.beginPath();
    ctx.arc(ox, oy, STICK_R, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = on ? 'rgba(133, 194, 212, 0.55)' : 'rgba(200, 220, 232, 0.22)';
    ctx.stroke();

    const kx = ox + (on ? this._stick.x : 0);
    const ky = oy + (on ? this._stick.y : 0);
    ctx.beginPath();
    ctx.arc(kx, ky, 21, 0, Math.PI * 2);
    ctx.fillStyle = on ? 'rgba(133, 194, 212, 0.30)' : 'rgba(9, 16, 27, 0.42)';
    ctx.fill();
    ctx.strokeStyle = on ? 'rgba(180, 226, 240, 0.80)' : 'rgba(200, 220, 232, 0.30)';
    ctx.stroke();

    if (!on) {
      setFont(ctx, 8.5, MONO, '500', '0.2em');
      ctx.fillStyle = 'rgba(130, 152, 168, 0.62)';
      ctx.fillText('MOVE', ox, oy + STICK_R + 13);
    }
  }

  /**
   * The one-off "here is how this works" line, on two rows because a phone is 375 px wide and a
   * single row of this does not fit — it is measured and shrunk rather than trusted to.
   */
  _drawHint(ctx, w, h, walking) {
    const t = this._hint;
    if (t > 9.2) return;
    const a = t < 7.6 ? 1 : (9.2 - t) / 1.6;
    if (!(a > 0.02)) return;
    const lines = walking
      ? ['DRAG TO LOOK  ·  THUMBSTICK TO MOVE', 'MAP RETURNS TO THE MAP CAMERA']
      : ['DRAG TO PAN  ·  PINCH FOR HEIGHT', 'TWIST TO TURN  ·  TWO FINGERS TO TILT'];
    const s = this._insets();
    const room = w - s.left - s.right - 28;
    let px = 10;
    setFont(ctx, px, MONO, '500', '0.16em');
    for (let i = 0; i < lines.length; i++) {
      const width = ctx.measureText(lines[i]).width;
      if (width > room && width > 1) {
        px = Math.max(7, px * (room / width));
        setFont(ctx, px, MONO, '500', '0.16em');
      }
    }
    ctx.fillStyle = 'rgba(205, 133, 85, ' + (0.92 * a).toFixed(3) + ')';
    // Below the whole of the HUD's top block, measured rather than guessed: on a narrow screen
    // main.js drops the quality / time / frame-rate stack under the compass, and it reaches
    // T + 118 + a descender once the speed dial is showing. 176 clears that; 118 clears the wide
    // layout's own stack. Overlapping it was measured at 4.7 x 7 px against '60 FPS'.
    const top = s.top + (w < 720 ? 176 : 118);
    const cx = (s.left + (w - s.right)) * 0.5;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], cx, top + i * (px + 6));
  }
}

export default TouchControls;
