// src/input.js — keyboard / mouse / pointer-lock / gamepad state for Vice Heights.
// Edge-triggered pressed/released sets are valid for exactly one frame; call endFrame()
// at the very END of the game loop. Zero dependencies by contract.

// --- tuning -----------------------------------------------------------------
const MOUSE_CLAMP = 260;        // reject absurd single-event deltas (browser hiccups / lock warmup)
const STICK_DEAD = 0.18;        // radial dead zone for analog sticks
const STICK_KEY_THRESHOLD = 0.5;// stick past this also lights up the matching WASD code
const TRIGGER_THRESHOLD = 0.4;  // analog trigger -> button
const PAD_LOOK_SPEED = 1150;    // right-stick look, "pixels" of mouse delta per second at full tilt
const MAX_POLL_DT = 0.1;        // clamp gamepad look integration if the tab stalled

// Keys we swallow so the page never scrolls, tabs away, or opens quick-find.
const PREVENT = new Set([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash',
  'Backspace', 'Home', 'End', 'Delete', 'PageUp', 'PageDown', 'Quote',
  // right-hand cluster (lefty layout) — '/' and "'" open quick-find in Firefox, and the
  // numpad/bracket keys must not leak through to the page either.
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Comma', 'Period',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7',
  'Numpad8', 'Numpad9', 'NumpadDecimal', 'NumpadEnter', 'NumpadAdd',
]);

// ---------------------------------------------------------------------------
// Left-handed / arrow-key layout.
//
// A left-handed player mouses with the LEFT hand and keyboards with the RIGHT, so it is not enough
// to alias the arrow keys for movement — every action key has to be reachable from the arrow
// cluster too. Each right-side key below also reports as its canonical WASD-layout code, so every
// consumer (player.js, main.js, the HUD) keeps querying one code and both layouts just work.
// Nothing is rebound or lost: the original left-hand bindings remain active at the same time.
const KEY_ALIAS = {
  // movement
  ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD',
  Numpad8: 'KeyW', Numpad2: 'KeyS', Numpad4: 'KeyA', Numpad6: 'KeyD',
  // sprint / handbrake / jump
  ShiftRight: 'ShiftLeft',
  Slash: 'Space', Numpad0: 'Space',
  // interact
  Period: 'KeyF', NumpadDecimal: 'KeyF', NumpadEnter: 'KeyF',
  Comma: 'KeyR', NumpadAdd: 'KeyR',
  // weapons
  BracketLeft: 'KeyQ', BracketRight: 'KeyE',
  Numpad1: 'Digit1', Numpad3: 'Digit2', Numpad7: 'Digit3', Numpad9: 'Digit4', Numpad5: 'Digit5',
  // stance
  ControlRight: 'ControlLeft',   // crouch
  // view / world
  Semicolon: 'KeyT',      // cycle time of day
  Quote: 'KeyV',          // cycle camera
  Backslash: 'KeyC',      // horn
  Equal: 'KeyM',          // radio
  Minus: 'KeyH',          // help
  // nav cluster, right above the arrow keys — the shell/debug keys live on the far LEFT of the
  // board (Esc, backtick), so the arrow hand needs its own reach for them.
  Delete: 'KeyP',         // cinematic camera
  Backspace: 'Escape',    // pause
  End: 'Backquote',       // debug overlay
};

// Standard-mapping gamepad buttons -> synthetic key codes the rest of the game already understands.
// Every button additionally reports as 'Pad<N>' so raw button queries are possible.
const PAD_BUTTON_CODES = [
  'Space',      // 0  A / cross      — jump / handbrake
  'KeyF',       // 1  B / circle     — enter/exit vehicle
  'KeyR',       // 2  X / square     — reload
  'KeyC',       // 3  Y / triangle   — horn
  'KeyQ',       // 4  LB             — prev weapon
  'KeyE',       // 5  RB             — next weapon
  'Mouse1',     // 6  LT             — aim
  'Mouse0',     // 7  RT             — fire
  'Tab',        // 8  back/select    — big map
  'Escape',     // 9  start          — pause
  'ShiftLeft',  // 10 L3             — sprint
  'KeyV',       // 11 R3             — cycle camera
  'ArrowUp',    // 12 dpad up
  'ArrowDown',  // 13 dpad down
  'ArrowLeft',  // 14 dpad left
  'ArrowRight', // 15 dpad right
  'KeyM',       // 16 home/guide     — radio
];

// Analog stick -> axis() pairs. Key: 'neg|pos'.
const STICK_AXIS_PAIRS = new Map([
  ['KeyA|KeyD', 'x'],
  ['ArrowLeft|ArrowRight', 'x'],
  ['KeyS|KeyW', 'y'],
  ['ArrowDown|ArrowUp', 'y'],
]);

function isTextTarget(t) {
  if (!t || t === window || t === document || t === document.body) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function deadzone(v) {
  const a = Math.abs(v);
  if (!(a > STICK_DEAD)) return 0;
  // rescale so the usable range is a clean 0..1 with no dead-zone step
  const s = (a - STICK_DEAD) / (1 - STICK_DEAD);
  return v < 0 ? -s : s;
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas || null;

    this.enabled = true;
    this.locked = false;

    this._held = new Set();
    this._physical = new Set();   // raw event codes actually down, before aliasing
    this._pressed = new Set();
    this._released = new Set();
    // gamepad-derived state, kept apart so a real keyup can never strand it
    this._padHeld = new Set();     // buttons + dpad, participate in down/pressed/released
    this._stickHeld = new Set();   // stick-as-WASD, feeds down() but NOT axis() (axis stays analog)

    this._mouseDX = 0;
    this._mouseDY = 0;
    this._wheel = 0;
    this._mouseButtons = 0;

    // analog gamepad state
    this.padConnected = false;
    this._padIndex = -1;
    this._padX = 0;
    this._padY = 0;
    this._padRX = 0;
    this._padRY = 0;
    this._padLT = 0;
    this._padRT = 0;
    this._lastPoll = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

    this._bind();
  }

  // --- public API -----------------------------------------------------------

  down(code) {
    if (!this.enabled) return false;
    return this._held.has(code) || this._padHeld.has(code) || this._stickHeld.has(code);
  }

  pressed(code) {
    if (!this.enabled) return false;
    return this._pressed.has(code);
  }

  released(code) {
    if (!this.enabled) return false;
    return this._released.has(code);
  }

  axis(negCode, posCode) {
    if (!this.enabled) return 0;
    let v = 0;
    if (this._held.has(posCode) || this._padHeld.has(posCode)) v += 1;
    if (this._held.has(negCode) || this._padHeld.has(negCode)) v -= 1;
    const pad = this._stickAxis(negCode, posCode);
    if (v === 0) return pad;
    if (pad !== 0 && Math.abs(pad) > Math.abs(v) && (pad < 0) === (v < 0)) return pad;
    return v;
  }

  get mouseDX() { return this.enabled ? this._mouseDX : 0; }
  get mouseDY() { return this.enabled ? this._mouseDY : 0; }
  get wheel() { return this.enabled ? this._wheel : 0; }

  requestLock() {
    const c = this.canvas;
    if (!c || typeof c.requestPointerLock !== 'function') return;
    if (typeof document !== 'undefined' && document.pointerLockElement === c) return;
    try {
      // unadjustedMovement gives raw deltas on Chromium; Firefox/Safari ignore the dict.
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const q = c.requestPointerLock();
            if (q && typeof q.catch === 'function') q.catch(() => {});
          } catch (e) { /* Safari rejects outside a user gesture — ignore */ }
        });
      }
    } catch (e) {
      try {
        const q = c.requestPointerLock();
        if (q && typeof q.catch === 'function') q.catch(() => {});
      } catch (e2) { /* ignore */ }
    }
  }

  exitLock() {
    try {
      if (typeof document !== 'undefined' && document.pointerLockElement &&
          typeof document.exitPointerLock === 'function') {
        document.exitPointerLock();
      }
    } catch (e) { /* ignore */ }
  }

  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this._mouseDX = 0;
    this._mouseDY = 0;
    this._wheel = 0;
    // Poll after clearing so gamepad edges/deltas are visible for the whole of the next frame.
    this._pollGamepad();
  }

  // --- internals ------------------------------------------------------------

  _stickAxis(negCode, posCode) {
    const which = STICK_AXIS_PAIRS.get(negCode + '|' + posCode);
    if (which === 'x') return this._padX;
    if (which === 'y') return -this._padY;   // stick up is negative, +Y here means "forward"
    const flipped = STICK_AXIS_PAIRS.get(posCode + '|' + negCode);
    if (flipped === 'x') return -this._padX;
    if (flipped === 'y') return this._padY;
    return 0;
  }

  // A physical key and its alias both feed the SAME canonical code, so track the raw physical
  // codes separately and derive held-state from them. Otherwise holding W and ArrowUp together and
  // releasing either one would stop the player dead.
  _keyDown(code) {
    this._physical.add(code);
    this._setHeld(code, true);
    const alias = KEY_ALIAS[code];
    if (alias !== undefined) this._setHeld(alias, true);
  }

  _keyUp(code) {
    this._physical.delete(code);
    if (!this._sourceHeld(code)) this._setHeld(code, false);
    const alias = KEY_ALIAS[code];
    if (alias !== undefined && !this._sourceHeld(alias)) this._setHeld(alias, false);
  }

  // Is any still-pressed physical key driving this canonical code?
  _sourceHeld(canonical) {
    if (this._physical.has(canonical)) return true;
    for (const k in KEY_ALIAS) {
      if (KEY_ALIAS[k] === canonical && this._physical.has(k)) return true;
    }
    return false;
  }

  _setHeld(code, on) {
    if (on) {
      if (this._held.has(code)) return;
      this._held.add(code);
      if (!this._padHeld.has(code) && !this._stickHeld.has(code)) this._pressed.add(code);
    } else {
      if (!this._held.has(code)) return;
      this._held.delete(code);
      if (!this._padHeld.has(code) && !this._stickHeld.has(code)) this._released.add(code);
    }
  }

  _clearAll() {
    // Emit releases for anything currently down so listeners relying on released() stay balanced,
    // then wipe every held set — the player must never get stuck sprinting after an alt-tab.
    for (const code of this._held) this._released.add(code);
    for (const code of this._padHeld) if (!this._held.has(code)) this._released.add(code);
    for (const code of this._stickHeld) if (!this._held.has(code)) this._released.add(code);
    this._held.clear();
    this._physical.clear();
    this._padHeld.clear();
    this._stickHeld.clear();
    this._mouseButtons = 0;
    this._mouseDX = 0;
    this._mouseDY = 0;
    this._padX = 0;
    this._padY = 0;
    this._padRX = 0;
    this._padRY = 0;
    this._padLT = 0;
    this._padRT = 0;
  }

  _bind() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const canvas = this.canvas;

    window.addEventListener('keydown', (e) => {
      if (isTextTarget(e.target)) return;
      const code = e.code || e.key;
      if (!code) return;
      if (PREVENT.has(code) && !e.ctrlKey && !e.metaKey && typeof e.preventDefault === 'function') {
        e.preventDefault();
      }
      if (e.repeat) return;
      this._keyDown(code);
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
      if (isTextTarget(e.target)) return;
      const code = e.code || e.key;
      if (!code) return;
      if (PREVENT.has(code) && typeof e.preventDefault === 'function') e.preventDefault();
      this._keyUp(code);
    }, { passive: false });

    const mouseTarget = canvas || window;

    mouseTarget.addEventListener('mousedown', (e) => {
      if (isTextTarget(e.target)) return;
      const b = e.button | 0;
      if (b > 2) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this._mouseButtons |= (1 << b);
      this._keyDown('Mouse' + b);
    }, { passive: false });

    // mouseup on window so releasing outside the canvas still counts.
    window.addEventListener('mouseup', (e) => {
      const b = e.button | 0;
      if (b > 2) return;
      this._mouseButtons &= ~(1 << b);
      this._keyUp('Mouse' + b);
    });

    window.addEventListener('mousemove', (e) => {
      // Only look when locked, or while dragging — otherwise a stray cursor move snaps the camera.
      if (!this.locked && this._mouseButtons === 0) return;
      let dx = e.movementX;
      let dy = e.movementY;
      if (typeof dx !== 'number' || !isFinite(dx)) dx = 0;
      if (typeof dy !== 'number' || !isFinite(dy)) dy = 0;
      if (dx > MOUSE_CLAMP) dx = MOUSE_CLAMP; else if (dx < -MOUSE_CLAMP) dx = -MOUSE_CLAMP;
      if (dy > MOUSE_CLAMP) dy = MOUSE_CLAMP; else if (dy < -MOUSE_CLAMP) dy = -MOUSE_CLAMP;
      this._mouseDX += dx;
      this._mouseDY += dy;
    });

    mouseTarget.addEventListener('wheel', (e) => {
      if (typeof e.preventDefault === 'function' && e.cancelable) e.preventDefault();
      let d = e.deltaY;
      if (typeof d !== 'number' || !isFinite(d)) d = 0;
      if (e.deltaMode === 1) d *= 16;        // lines
      else if (e.deltaMode === 2) d *= 400;  // pages
      this._wheel += d;
    }, { passive: false });

    mouseTarget.addEventListener('contextmenu', (e) => {
      if (typeof e.preventDefault === 'function') e.preventDefault();
    });

    document.addEventListener('pointerlockchange', () => {
      const wasLocked = this.locked;
      this.locked = !!(canvas ? document.pointerLockElement === canvas : document.pointerLockElement);
      if (wasLocked && !this.locked) this._clearAll();
      this._mouseDX = 0;
      this._mouseDY = 0;
    });

    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
    });

    window.addEventListener('blur', () => this._clearAll());

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._clearAll();
    });

    window.addEventListener('gamepadconnected', (e) => {
      const gp = e && e.gamepad;
      this._padIndex = gp && typeof gp.index === 'number' ? gp.index : -1;
      this.padConnected = true;
    });

    window.addEventListener('gamepaddisconnected', () => {
      this._padIndex = -1;
      this.padConnected = false;
      this._clearPad();
    });
  }

  _clearPad() {
    for (const code of this._padHeld) if (!this._held.has(code)) this._released.add(code);
    for (const code of this._stickHeld) if (!this._held.has(code)) this._released.add(code);
    this._padHeld.clear();
    this._stickHeld.clear();
    this._padX = 0;
    this._padY = 0;
    this._padRX = 0;
    this._padRY = 0;
    this._padLT = 0;
    this._padRT = 0;
  }

  _pollGamepad() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
    let dt = now - this._lastPoll;
    this._lastPoll = now;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_POLL_DT) dt = MAX_POLL_DT;

    let pads = null;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        pads = navigator.getGamepads();
      }
    } catch (e) {
      pads = null;
    }
    if (!pads || !pads.length) {
      if (this.padConnected) { this.padConnected = false; this._clearPad(); }
      return;
    }

    let gp = null;
    if (this._padIndex >= 0 && this._padIndex < pads.length && pads[this._padIndex]) {
      gp = pads[this._padIndex];
    }
    if (!gp || !gp.connected) {
      gp = null;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) { gp = p; this._padIndex = i; break; }
      }
    }
    if (!gp) {
      if (this.padConnected) { this.padConnected = false; this._clearPad(); }
      return;
    }
    this.padConnected = true;

    const ax = gp.axes || [];
    const btns = gp.buttons || [];

    // --- sticks
    const rawX = typeof ax[0] === 'number' && isFinite(ax[0]) ? ax[0] : 0;
    const rawY = typeof ax[1] === 'number' && isFinite(ax[1]) ? ax[1] : 0;
    const rawRX = typeof ax[2] === 'number' && isFinite(ax[2]) ? ax[2] : 0;
    const rawRY = typeof ax[3] === 'number' && isFinite(ax[3]) ? ax[3] : 0;

    // radial dead zone on the movement stick keeps diagonals honest
    const mag = Math.sqrt(rawX * rawX + rawY * rawY);
    if (mag > STICK_DEAD) {
      const scaled = Math.min(1, (mag - STICK_DEAD) / (1 - STICK_DEAD));
      const inv = scaled / mag;   // mag > STICK_DEAD > 0, safe
      this._padX = rawX * inv;
      this._padY = rawY * inv;
    } else {
      this._padX = 0;
      this._padY = 0;
    }
    this._padRX = deadzone(rawRX);
    this._padRY = deadzone(rawRY);

    // right stick drives the same accumulator the mouse does (quadratic for fine aim)
    if (this._padRX !== 0 || this._padRY !== 0) {
      const sx = this._padRX * Math.abs(this._padRX);
      const sy = this._padRY * Math.abs(this._padRY);
      this._mouseDX += sx * PAD_LOOK_SPEED * dt;
      this._mouseDY += sy * PAD_LOOK_SPEED * dt;
    }

    // stick-as-WASD so plain down('KeyW') checks still work on a pad
    this._syncSynthetic(this._stickHeld, 'KeyD', this._padX > STICK_KEY_THRESHOLD);
    this._syncSynthetic(this._stickHeld, 'KeyA', this._padX < -STICK_KEY_THRESHOLD);
    this._syncSynthetic(this._stickHeld, 'KeyW', this._padY < -STICK_KEY_THRESHOLD);
    this._syncSynthetic(this._stickHeld, 'KeyS', this._padY > STICK_KEY_THRESHOLD);

    // --- buttons
    const n = Math.min(btns.length, 20);
    for (let i = 0; i < n; i++) {
      const b = btns[i];
      let on = false;
      let val = 0;
      if (b && typeof b === 'object') {
        val = typeof b.value === 'number' && isFinite(b.value) ? b.value : 0;
        on = !!b.pressed || val > TRIGGER_THRESHOLD;
      } else if (typeof b === 'number') {
        val = b;
        on = b > TRIGGER_THRESHOLD;
      }
      if (i === 6) this._padLT = val;
      if (i === 7) this._padRT = val;
      this._syncSynthetic(this._padHeld, 'Pad' + i, on);
      const code = PAD_BUTTON_CODES[i];
      if (code) this._syncSynthetic(this._padHeld, code, on);
    }

    // Some pads report triggers as axes 4/5 (-1 released .. +1 pulled) instead of buttons.
    if (btns.length <= 6) {
      const lt = typeof ax[4] === 'number' && isFinite(ax[4]) ? (ax[4] + 1) * 0.5 : 0;
      const rt = typeof ax[5] === 'number' && isFinite(ax[5]) ? (ax[5] + 1) * 0.5 : 0;
      this._padLT = lt;
      this._padRT = rt;
      this._syncSynthetic(this._padHeld, 'Mouse1', lt > TRIGGER_THRESHOLD);
      this._syncSynthetic(this._padHeld, 'Mouse0', rt > TRIGGER_THRESHOLD);
    }
  }

  _syncSynthetic(set, code, on) {
    const was = set.has(code);
    if (on === was) return;
    if (on) {
      set.add(code);
      if (!this._held.has(code)) this._pressed.add(code);
    } else {
      set.delete(code);
      const stillOther = (set === this._padHeld ? this._stickHeld : this._padHeld).has(code);
      if (!this._held.has(code) && !stillOther) this._released.add(code);
    }
  }
}
