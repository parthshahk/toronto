// src/app/quality.js — the device profile, the quality presets and the adaptive step.
//
// CONTRACT Amendment 11: lifted out of src/app/main.js unchanged. Nothing here reads or writes
// global state — the device profile is a pure function of what the browser reports about itself,
// writeQuality() takes the renderer it is to configure, and AutoQuality is an instance whose only
// contact with the rest of the app is the three hooks it is constructed with.

import { clamp } from '../core/math.js';

function fin(v, dflt = 0) {
  return Number.isFinite(v) ? v : dflt;
}

/* ============================================================ backing store == */

// Backing-store resolution. 2 on the desktop by contract. A phone reports 3 with a GPU a small
// fraction the size, and 3x on a 6-inch panel is 2.25x the pixels of 2x for a difference nobody
// can resolve at arm's length — so a TOUCH-PRIMARY device (a phone or tablet, never a desktop and
// never a touchscreen laptop) caps lower and spends the pixels on frame rate instead.
//
// The whole of this is fill rate: the deferred-ish pipeline here writes the scene target, an SSAO
// pass, an SSR pass, three bloom levels and an FXAA resolve, so every backing-store pixel is
// touched six to ten times. 375 x 812 at the device's own DPR 3 is 2.74 Mpix — MORE than a
// 1440 x 900 desktop window at DPR 1 — on a GPU with a tenth the bandwidth. At 1.5 it is 685 k.
export const DPR_CAP = 2;              // desktop and hybrid, by contract — unchanged
export const DPR_CAP_TABLET = 1.75;
export const DPR_CAP_PHONE = 1.5;
export const DPR_CAP_PHONE_LOW = 1.25;
export const DPR_MIN = 0.8;            // the adaptive floor; below this the city stops reading as geometry
// The 2D HUD is text and hairlines and costs microseconds, so it is NOT dropped with the scene:
// the two canvases carry different backing stores, and the type stays crisp on a 3x panel while
// the city renders at 1.5x underneath it. This is the single biggest legibility win on a phone.
export const HUD_DPR_CAP = 2.5;

/* ================================================================ presets == */

// Renderer presets, cheapest last. `E` steps up, `Q` steps down.
export const QUALITY_PRESETS = [
  { name: 'Ultra', q: { shadows: 'high', ssao: true, ssr: true, bloom: true, clouds: true, fxaa: true } },
  { name: 'High', q: { shadows: 'high', ssao: true, ssr: false, bloom: true, clouds: true, fxaa: true } },
  { name: 'Medium', q: { shadows: 'low', ssao: false, ssr: false, bloom: true, clouds: true, fxaa: true } },
  { name: 'Low', q: { shadows: 'off', ssao: false, ssr: false, bloom: true, clouds: false, fxaa: false } },
  { name: 'Minimal', q: { shadows: 'off', ssao: false, ssr: false, bloom: false, clouds: false, fxaa: false } },
];
export const Q_ULTRA = 0, Q_HIGH = 1, Q_MEDIUM = 2, Q_LOW = 3, Q_MINIMAL = 4;

/**
 * Put a renderer on a preset. The index is normalised, so stepping off either end wraps, and a
 * null renderer is not an error — boot names the preset before the renderer exists.
 */
export function writeQuality(renderer, index) {
  const n = QUALITY_PRESETS.length;
  const i = ((index % n) + n) % n;
  const r = renderer;
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
export function nextQualityIndex(current, bestQuality) {
  const last = QUALITY_PRESETS.length - 1;
  const best = clamp(fin(bestQuality, Q_ULTRA), 0, last);
  const next = current >= last ? best : Math.max(best, current + 1);
  return next;
}

/* ================================================================= device == */

// WHAT KIND OF MACHINE IS THIS, and what should it open on? Nothing here is a user-agent sniff:
// every input is a capability the browser reports about itself, so a device nobody has heard of
// still lands somewhere sensible, and a desktop cannot be mistaken for a phone by a string.
//
//   pointer     src/app/touch.js's detectPointer() — coarse/fine/touch, reported honestly
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
export const DEVICE_PROFILES = {
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
export const VERT_BYTES = 48;

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

export function deviceProfile(caps) {
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

/**
 * The adaptive-quality controller. One instance per app; `hooks` is how it reaches the rest of
 * the world, so nothing here touches global state and a test can drive it with three stubs:
 *   applyQuality(index)   put the renderer on that preset (never counts as a user choice)
 *   setDprScale(scale)    multiply the device DPR cap and resize the backing stores
 *   isRunning()           false while the title screen is up; no frame there is evidence
 */
export class AutoQuality {
  constructor(hooks) {
    this.hooks = hooks;
    this.on = false;
    this.rung = 0;
    this.ladder = [];
    this.ring = new Float64Array(AUTO_RING);
    this.n = 0; this.i = 0;
    this.sort = new Float64Array(AUTO_RING);
    this.judgeAt = 0;
    this.changedAt = 0;
    this.downAt = 0;
    this.okSince = 0;   // wall time since which every judgement has had headroom
    this.blocked = null;   // Uint8Array — rungs a probe has already proved unreachable
    this.lastUpRung = -1;
    this.lastUpAt = -1e9;
    this.p60 = 0;
    this.steps = 0;
    this.why = 'starting';
  }

  build(profile, t) {
    const best = clamp(fin(profile.bestQuality, Q_ULTRA), 0, QUALITY_PRESETS.length - 1);
    const ladder = [];
    for (let q = best; q < QUALITY_PRESETS.length; q++) ladder.push({ q, dpr: 1 });
    for (let i = 0; i < AUTO_DPR_RUNGS.length; i++) {
      ladder.push({ q: QUALITY_PRESETS.length - 1, dpr: AUTO_DPR_RUNGS[i] });
    }
    this.ladder = ladder;
    this.blocked = new Uint8Array(ladder.length);
    const start = clamp(fin(profile.startQuality, best), best, QUALITY_PRESETS.length - 1);
    this.rung = clamp(start - best, 0, ladder.length - 1);
    this.on = true;
    this.why = 'measuring';
    this.reset(t);
    return this;
  }

  reset(t) {
    this.n = 0;
    this.i = 0;
    this.changedAt = t;
    this.judgeAt = t + AUTO_JUDGE_MS;
    this.okSince = 0;
  }

  stop(why) {
    if (!this.on) return;
    this.on = false;
    this.why = why || 'off';
  }

  /** Move to a ladder rung and put the renderer and the backing store where that rung says. */
  gotoRung(rung, t, why) {
    const r = clamp(rung | 0, 0, this.ladder.length - 1);
    const spec = this.ladder[r];
    if (!spec) return;
    this.rung = r;
    this.steps++;
    this.why = why;
    this.hooks.applyQuality(spec.q);
    // Reallocates every render target when it moves: settle time is why it is last.
    this.hooks.setDprScale(spec.dpr);
    this.reset(t);
  }

  /**
   * One frame of evidence. Called from the loop with the frame's wall-clock delta in seconds, and
   * cheap enough to be: a store into a ring, and once a second a 150-element sort.
   */
  sample(dt, t) {
    if (!this.on || !this.hooks.isRunning()) return;
    const doc = (typeof document !== 'undefined') ? document : null;
    // A hidden tab does not run frames, it runs a throttle. Every number it produces is a lie about
    // the GPU, so the window is thrown away rather than judged.
    if (doc && doc.hidden) { this.reset(t); return; }
    const ms = dt * 1000;
    if (!(ms > 0) || ms > AUTO_SPIKE_MS) return;     // a stall, a tab switch, a teleport hitch
    if (t - this.changedAt < AUTO_SETTLE_MS) return; // targets are still being rebuilt

    this.ring[this.i] = ms;
    this.i = (this.i + 1) % AUTO_RING;
    if (this.n < AUTO_RING) this.n++;

    if (t < this.judgeAt) return;
    this.judgeAt = t + AUTO_JUDGE_MS;
    if (this.n < AUTO_MIN_SAMPLES) return;

    // 60th percentile: past the frame-to-frame noise, short of the tail that a build or a GC owns.
    const n = this.n;
    const s = this.sort;
    for (let k = 0; k < n; k++) s[k] = this.ring[k];
    // Insertion sort. n is 150 and this runs once a second; a comparator-driven sort would allocate.
    for (let a = 1; a < n; a++) {
      const v = s[a];
      let b = a - 1;
      while (b >= 0 && s[b] > v) { s[b + 1] = s[b]; b--; }
      s[b + 1] = v;
    }
    const p60 = s[Math.min(n - 1, Math.floor(n * 0.6))];
    this.p60 = p60;

    if (p60 > AUTO_DOWN_MS) {
      this.okSince = 0;
      if (t - this.downAt < AUTO_HOLD_DOWN_MS) return;
      // A step down that undoes a recent step up strikes that rung off for good.
      if (this.lastUpRung >= 0 && (t - this.lastUpAt) < AUTO_REGRET_MS) {
        this.blocked[this.lastUpRung] = 1;
        this.lastUpRung = -1;
      }
      // A step down is a rescue and always takes the very next rung. `blocked` is not consulted:
      // it records "this rung did not hold up", which is a reason never to climb BACK to it, never
      // a reason to refuse relief on the way past.
      const next = this.rung + 1;
      if (next >= this.ladder.length) {
        this.why = 'floor ' + p60.toFixed(1) + ' ms';
        return;                                     // nothing cheaper exists; stop trying
      }
      this.downAt = t;
      this.gotoRung(next, t, 'down ' + p60.toFixed(1) + ' ms');
      return;
    }

    if (p60 < AUTO_UP_MS) {
      if (!this.okSince) this.okSince = t;
      if (t - this.okSince < AUTO_HOLD_UP_MS) return;
      // Strictly one rung, and NEVER past a struck-off one. Skipping a blocked rung would climb to
      // something more expensive still, which is the opposite of what being told "that rung was
      // too much for this device" means.
      const next = this.rung - 1;
      if (next < 0) { this.why = 'best ' + p60.toFixed(1) + ' ms'; return; }
      if (this.blocked[next]) { this.why = 'capped at rung ' + this.rung; return; }
      this.lastUpRung = next;
      this.lastUpAt = t;
      this.gotoRung(next, t, 'up ' + p60.toFixed(1) + ' ms');
      return;
    }

    // Inside the deadband: settled. Headroom has to be unbroken, so the up-timer restarts.
    this.okSince = 0;
    this.why = 'settled ' + p60.toFixed(1) + ' ms';
  }

  /**
   * Forgive every struck-off rung and start the search again. A rotation changes the pixel count,
   * the safe-area insets and the frame cost with them, so a rung this device could not hold before
   * is not evidence about the workload it has now.
   */
  forgive(t) {
    if (!this.on || !this.blocked) return;
    this.blocked.fill(0);
    this.lastUpRung = -1;
    this.reset(t);
  }
}

/**
 * Point the tile budget at this device. Everything here is a public knob on the TileManager
 * INSTANCE — src/tiles.js is not touched and neither is src/city.js, which owns the numbers the
 * contract was tuned to. Called once, before the warm pass, so a phone never builds 5 km of
 * massing only to evict it on the first frame.
 */
export function applyDeviceTileBudget(city, renderer, profile) {
  const t = city ? city.tiles : null;
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
  if (renderer && profile.shadowDistance > 0) {
    // The cascades cannot usefully reach past the massing that feeds them, and three shadow
    // passes over geometry that is no longer resident is pure cost.
    renderer.shadow.distance = Math.min(renderer.shadow.distance, profile.shadowDistance);
  }
  return { before, after: { mass: t.stages[0].range, detail: t.stages[1].range, cap: t.vertexCap } };
}
