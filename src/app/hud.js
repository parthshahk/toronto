// src/app/hud.js — the 2D HUD: compass, readouts, attribution, help sheet and diagnostics.
//
// CONTRACT Amendment 11: lifted out of src/app/main.js unchanged. Drawn into its OWN canvas with
// its own backing store (see sizeCanvases() in main.js), which is why every coordinate here is in
// CSS pixels and none of it is scaled by the scene's device pixel ratio.
//
// EVERY ANCHOR IS MEASURED FROM THE SAFE BOX (G.safe), never from the edge of the glass, so the
// street name does not land under a camera housing and the mandatory attribution — which CONTRACT
// §1 does not allow to be clipped — does not land under a home indicator.
//
// drawHud() takes the app state rather than closing over it: it reads, and never writes, anything
// on G.

import { clamp } from '../core/math.js';
import { TIME_PRESETS } from './time.js';
import { QUALITY_PRESETS, VERT_BYTES } from './quality.js';
import { TOUCH_HELP_ROWS } from './touch.js';
import { yawToBearing } from './controls.js';

function fin(v, dflt = 0) {
  return Number.isFinite(v) ? v : dflt;
}

// Data attribution. CONTRACT §1: both sources are mandatory and must be visible in the UI.
const ATTRIB_A = 'Buildings: City of Toronto Open Data (3D Massing 2025)';
const ATTRIB_B = '© OpenStreetMap contributors, ODbL';

export const HUD = {
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

function drawCompass(ctx, player, cx, top, width) {
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

export const HELP_ROWS = [
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

function drawHelp(G, ctx, w, h) {
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

export function drawHud(G, input) {
  const player = G.player;
  const auto = G.auto;
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
  const street = (player.street || 'Old Toronto').toUpperCase();
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
  drawCompass(ctx, player, Math.round(cx), T - 6, compassW);

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
  if (auto.on) {
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
  const ll = G.unproject(player.x, player.z);
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
        '  auto ' + (auto.on ? 'rung ' + auto.rung + '/' + (auto.ladder.length - 1) +
          ' ' + auto.why + ' (' + auto.steps + ')' : auto.why),
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

  if (G.showHelp) drawHelp(G, ctx, w, h);
}
