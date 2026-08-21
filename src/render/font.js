// src/render/font.js — the signed-distance-field glyph atlas, rasterised at boot with Canvas 2D.
//
// One texture per WebGL context, built on first use and shared by everything that draws a
// letter: render/text.js lays runs out against it and the renderer binds it for the text pass.
//
// WHY SDF AND NOT AN ALPHA MASK. Signage is read at wildly different distances. The same fascia
// is 4 m from the eye when you walk under it and 90 m away down the block, which is a 22x range
// in texel footprint; a straight alpha mask is soft at one end of that and aliased to pieces at
// the other, and there is no single rasterisation size that serves both. A distance field is
// resolution-independent by construction: one 34-texel glyph reconstructs a crisp edge at any
// magnification, and the SAME value carries the analytic coverage that antialiases it under
// minification. It also gives the renderer a cheap dilation term, which is what keeps a shop name
// legible as a shape after its strokes have fallen below one pixel.
//
// WHY NO FONT FILE. Zero dependencies, no build step (CONTRACT §0). The browser already has a
// font engine and a rasteriser; Canvas 2D is a browser API, not a dependency. The atlas is built
// once at boot from a system font stack, costs 0.78 MB of R8 texture (1.04 MB with its three mip
// levels), and ships as nothing at all.
//
// Zero dependencies. Returns null on any platform without a 2-D canvas — text then simply does
// not exist and nothing else in the engine changes, which is the "nothing may block boot" rule.

/* ---------------------------------------------------------------- constants */

// The distance transform's "no source here" sentinel, and the hull's open bounds.
//
// FAR is 1e6 rather than the 1e20 the textbook writes, for a numerical reason: the transform
// works on SQUARED distances, the largest one a 72 x 72 cell can hold is 2 * 72^2 = 10,368, and
// the parabola intersection adds q^2 to it. 1e6 dominates every real distance by two orders of
// magnitude AND keeps 1e6 + q^2 exact in a float64; 1e20 + 5184 rounds straight back to 1e20, so
// every pair of saturated samples ties at exactly the same value and the lower-envelope hull is
// comparing numbers that have lost their difference. Infinity is worse still — it makes the
// intersection 0/0.
const FAR = 1e6;
const HULL_LO = -1e30;
const HULL_HI = 1e30;

// The atlas. 1024 px square of R8 is one megabyte, the cell is the largest that lets 154 glyphs
// fit in a single texture, and PAD is the quiet border around each glyph: it has to exceed SPREAD
// so one distance field cannot bleed into its neighbour's, because the atlas is transformed as a
// single image rather than cell by cell (which is 154 separate transforms and 154 readbacks).
const ATLAS_SIZE = 1024;
const CELL = 72;
const PAD = 8;
const SPREAD = 6;
// How far past the ink the quad reaches, and therefore how far past it the distance field has to
// be right: the spread itself, plus a texel so bilinear filtering at the quad's edge never
// samples an untransformed texel.
const WINDOW = SPREAD + 2;

// A system stack, in signage order: a grotesque with a large x-height and unambiguous digits.
// No webfont, no file, no network.
const FAMILY = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", ' +
  'system-ui, sans-serif';
const WEIGHT = '700';

// ASCII 0x20-0x7E, then the punctuation and accents that are actually on Toronto shopfronts:
// typographic quotes and dashes (Queen's, Pusateri's), the ellipsis the fitter needs, degree and
// currency marks, and the French and Portuguese accents on a few hundred restaurant names.
const ASCII = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
})();
const EXTRA = '¢£°±–—‘’“”…•' +
  'àáâäåçèéêëìíîï' +
  'ñòóôöùúûüÿ' +
  'ÀÁÂÄÅÇÈÉÊËÌÍÎÏ' +
  'ÑÒÓÔÖÙÚÛÜ';
const CHARSET = ASCII + EXTRA;
// The probe decides the em size: the tallest accented capital over the deepest descender is the
// worst case the cell has to hold, and the widest glyph is the worst case for the cell's width.
const PROBE_TALL = 'ÁÉÜQgjpqy|_';

/* ------------------------------------------------------------ small helpers */

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

/* -------------------------------------------------------- distance transform */

// Felzenszwalb & Huttenlocher's exact O(n) 1-D squared distance transform: the lower envelope of
// the parabolas rooted at each sample. `f` is the source row, `d` the result, `v` and `z` the
// hull scratch. Every value in `f` must be FINITE (that is what FAR is for) or the parabola
// intersection below is 0/0.
function edt1d(f, d, v, z, n) {
  v[0] = 0;
  z[0] = HULL_LO;
  z[1] = HULL_HI;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let p = v[k];
    let s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
    while (s <= z[k]) {
      k--;
      p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = HULL_HI;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

// The separable 2-D transform: columns, then rows. `grid` is squared distances, in place.
function edt2d(grid, w, h, f, d, v, z) {
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
}

/**
 * One glyph cell: alpha coverage -> signed distance, positive INSIDE, in texels, clamped to
 * +/- SPREAD and encoded to a byte with 0.5 on the outline. Reads the cell out of the atlas-sized
 * `alpha`, writes it back into the atlas-sized `out`, and returns the ink bounding box (or null
 * for a blank cell) so the caller gets it without a second scan.
 *
 * The alpha is not thresholded to a hard mask first. A pixel the rasteriser reports as 0.7
 * covered has its outline about 0.2 of a texel inside it, so seeding the transform with that
 * fractional offset (rather than with 0) recovers sub-texel precision from a rasterisation done
 * at one texel per texel. That is what makes a 34-texel glyph reconstruct cleanly at 40x
 * magnification without supersampling the raster, which would cost nine times the pixels and
 * nine times the transform.
 *
 * WHY PER CELL AND NOT PER ATLAS. The result is identical either way — every pixel within SPREAD
 * of ink lies inside its own cell, because the quiet border is wider than the spread — but the
 * transform is separable and its first pass walks COLUMNS. Striding a 1008-texel-wide image
 * column by column misses cache on every read; a 72 x 72 window is 40 KB of scratch and stays
 * resident across both passes. It is also what makes the ink-box windowing below possible at all,
 * which is where the real saving is.
 */
function cellSdf(alpha, out, W, cx, cy, scratch) {
  // Pass 1: the ink box. It decides the quad the caller emits AND the window the transform runs
  // over, so it has to come first.
  let x0 = CELL;
  let y0 = CELL;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < CELL; y++) {
    const src = (cy + y) * W + cx;
    for (let x = 0; x < CELL; x++) {
      if (alpha[src + x] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) return null;

  // Pass 2: the window. Only pixels within SPREAD of ink carry a distance the shader can use —
  // everything further out saturates to the same byte, which is the byte the zero fill already
  // put there. So the transform runs over the ink box grown by the quad's own margin, not over
  // the whole cell. Every pixel in the window has its nearest ink INSIDE the window (the box
  // contains all of it) and its nearest gap inside it too (the window is strictly larger than the
  // box), so the result is exact, not an approximation. A capital at this em is about 34 x 34 of
  // a 72 x 72 cell, so the window is roughly half the pixels — and measured on the real 154-glyph
  // atlas the transform stage came down to about half its cost, which is the single biggest term
  // in the boot cost of the whole font.
  const wx0 = Math.max(0, x0 - WINDOW);
  const wy0 = Math.max(0, y0 - WINDOW);
  const wx1 = Math.min(CELL - 1, x1 + WINDOW);
  const wy1 = Math.min(CELL - 1, y1 + WINDOW);
  const ww = wx1 - wx0 + 1;
  const wh = wy1 - wy0 + 1;

  const outer = scratch.outer;
  const inner = scratch.inner;
  for (let y = 0; y < wh; y++) {
    const src = (cy + wy0 + y) * W + cx + wx0;
    const dst = y * ww;
    for (let x = 0; x < ww; x++) {
      const a = alpha[src + x] * (1 / 255);
      const i = dst + x;
      if (a <= 0) {
        outer[i] = FAR;
        inner[i] = 0;
      } else if (a >= 1) {
        outer[i] = 0;
        inner[i] = FAR;
      } else {
        const dd = 0.5 - a;
        outer[i] = dd > 0 ? dd * dd : 0;
        inner[i] = dd < 0 ? dd * dd : 0;
      }
    }
  }

  edt2d(outer, ww, wh, scratch.f, scratch.d, scratch.v, scratch.z);
  edt2d(inner, ww, wh, scratch.f, scratch.d, scratch.v, scratch.z);

  const k = 255 / (2 * SPREAD);
  for (let y = 0; y < wh; y++) {
    const src = y * ww;
    const dst = (cy + wy0 + y) * W + cx + wx0;
    for (let x = 0; x < ww; x++) {
      const i = src + x;
      const sd = Math.sqrt(inner[i]) - Math.sqrt(outer[i]);
      const b = Math.round(127.5 + sd * k);
      out[dst + x] = b < 0 ? 0 : (b > 255 ? 255 : b);
    }
  }
  return [x0, y0, x1, y1];
}

function makeSdfScratch() {
  const n = CELL * CELL;   // the window never exceeds the cell
  return {
    outer: new Float64Array(n),
    inner: new Float64Array(n),
    f: new Float64Array(CELL),
    d: new Float64Array(CELL),
    v: new Int32Array(CELL),
    z: new Float64Array(CELL + 1),
  };
}

/* ------------------------------------------------------------- atlas build -- */

function makeCanvas(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function metricsOf(ctx, str) {
  const m = ctx.measureText(str);
  return {
    w: m.width,
    a: numOr(m.actualBoundingBoxAscent, 0),
    d: numOr(m.actualBoundingBoxDescent, 0),
  };
}

/**
 * Rasterise the glyph atlas and upload it. Returns a Font, or null on any platform where a 2-D
 * canvas is not available — text then simply does not exist and nothing else in the engine
 * changes, which is the "nothing may block boot" rule.
 *
 * opts: { family, weight, charset, tracking }
 */
export function createFontAtlas(gl, opts) {
  const o = opts || {};
  const family = typeof o.family === 'string' && o.family ? o.family : FAMILY;
  const weight = typeof o.weight === 'string' && o.weight ? o.weight : WEIGHT;
  const charset = typeof o.charset === 'string' && o.charset ? o.charset : CHARSET;

  const chars = Array.from(charset);
  const cols = Math.max(1, Math.floor(ATLAS_SIZE / CELL));
  const rows = Math.max(1, Math.ceil(chars.length / cols));
  const usedH = Math.min(ATLAS_SIZE, rows * CELL);
  if (rows * CELL > ATLAS_SIZE) return null;

  const canvas = makeCanvas(cols * CELL, usedH);
  if (!canvas) return null;
  let ctx = null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
  } catch (err) {
    ctx = null;
  }
  if (!ctx) return null;

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

  // --- size the em so the worst glyph fits inside the cell's quiet border -----
  const REF = 200;
  ctx.font = weight + ' ' + REF + 'px ' + family;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const tall = metricsOf(ctx, PROBE_TALL);
  let ascent = tall.a / REF;
  let descent = tall.d / REF;
  if (!(ascent > 0)) ascent = 0.8;
  if (!(descent > 0)) descent = 0.22;

  const advRef = new Float64Array(chars.length);
  let widest = 0;
  let inkWidest = 0;
  for (let i = 0; i < chars.length; i++) {
    const m = ctx.measureText(chars[i]);
    advRef[i] = m.width / REF;
    if (advRef[i] > widest) widest = advRef[i];
    // Ink can overhang the advance box (kerned punctuation, the tail of a Q), so the cell is
    // sized against whichever of the two is worse.
    const span = (numOr(m.actualBoundingBoxLeft, 0) + numOr(m.actualBoundingBoxRight, m.width))
      / REF;
    if (span > inkWidest) inkWidest = span;
  }
  const inner = CELL - 2 * PAD;
  const need = Math.max(widest, inkWidest, ascent + descent, 0.5);
  const em = Math.max(8, Math.floor(inner / need));

  ctx.font = weight + ' ' + em + 'px ' + family;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Cap height, measured rather than assumed: it is what a caller means by "letters 250 mm tall",
  // and it is the number the renderer's size fade needs in texels.
  const capM = metricsOf(ctx, 'H');
  const capEm = (capM.a > 0 ? capM.a : em * 0.716) / em;

  const ascentPx = Math.round(ascent * em);
  const baseY = PAD + ascentPx;

  const glyphs = new Map();
  const cellOf = [];
  for (let i = 0; i < chars.length; i++) {
    const cx = (i % cols) * CELL;
    const cy = Math.floor(i / cols) * CELL;
    cellOf.push([cx, cy]);
    ctx.fillText(chars[i], cx + PAD, cy + baseY);
  }

  // --- one readback, then one transform per cell -----------------------------
  const W = canvas.width;
  const H = canvas.height;
  let img = null;
  try {
    img = ctx.getImageData(0, 0, W, H);
  } catch (err) {
    return null;
  }
  const src = img.data;
  const alpha = new Uint8Array(W * H);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = src[j];

  const tRaster = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

  // Byte 0 is "SPREAD texels outside the glyph", which is exactly right for a cell nobody drew
  // into and for the unused tail of the last row, so the zero fill IS the correct background.
  const sdf = new Uint8Array(W * H);
  const scratch = makeSdfScratch();
  const grow = WINDOW - 1;
  let inked = 0;
  for (let i = 0; i < chars.length; i++) {
    const cx = cellOf[i][0];
    const cy = cellOf[i][1];
    const box = cellSdf(alpha, sdf, W, cx, cy, scratch);
    const rec = { adv: advRef[i], blank: box === null };
    if (!rec.blank) {
      inked++;
      let x0 = box[0];
      let y0 = box[1];
      let x1 = box[2];
      let y1 = box[3];
      x0 = Math.max(0, x0 - grow);
      y0 = Math.max(0, y0 - grow);
      x1 = Math.min(CELL - 1, x1 + grow);
      y1 = Math.min(CELL - 1, y1 + grow);
      const px0 = cx + x0;
      const py0 = cy + y0;
      const px1 = cx + x1 + 1;
      const py1 = cy + y1 + 1;
      // Quad corners in EM units relative to the pen origin (on the baseline, at the left edge
      // of the advance box). Y is up, so the image's top row is the larger Y.
      rec.x0 = (x0 - PAD) / em;
      rec.x1 = (x1 + 1 - PAD) / em;
      rec.y1 = (baseY - y0) / em;
      rec.y0 = (baseY - y1 - 1) / em;
      rec.u0 = px0 / W;
      rec.u1 = px1 / W;
      rec.v0 = py0 / H;
      rec.v1 = py1 / H;
    }
    glyphs.set(chars[i].codePointAt(0), rec);
  }

  const tSdf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

  // --- upload ----------------------------------------------------------------
  let texture = null;
  try {
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, sdf);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Three mip levels, no more. Averaging a distance field is well behaved, and at 1/8 scale a
    // glyph is under half a pixel of cap height and the renderer has already faded it out; but
    // past level 3 the 8 texels of quiet border stop separating one cell from the next, and a
    // level nobody can see is not worth a neighbour's ink bleeding into it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch (err) {
    if (texture) {
      try { gl.deleteTexture(texture); } catch (e) { /* teardown is best effort */ }
    }
    return null;
  }

  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

  const font = {
    gl,
    texture,
    width: W,
    height: H,
    cell: CELL,
    em,
    spread: SPREAD,
    // The texel span the stored 0..1 value covers: (s - 0.5) * sdfRange is a distance in TEXELS.
    sdfRange: 2 * SPREAD,
    cap: capEm,
    // Cap height in atlas texels — the renderer divides it by the glyph's texel footprint per
    // screen pixel to get its on-screen cap height, which is what the size fade is keyed on.
    capTexels: capEm * em,
    ascent,
    descent,
    lineHeight: ascent + descent + 0.12,
    tracking: numOr(o.tracking, 0),
    glyphs,
    glyphCount: chars.length,
    inkedCount: inked,
    buildMs: t1 - t0,
    // Where the boot cost went: measuring + rasterising the 154 cells, the distance transform
    // and the ink boxes, then the texture upload and its mip chain.
    rasterMs: tRaster - t0,
    sdfMs: tSdf - tRaster,
    uploadMs: t1 - tSdf,
    bytes: W * H,
    stats: { runs: 0, glyphs: 0, verts: 0, shrunk: 0, ellipsised: 0 },
    dispose() {
      if (this.texture) {
        try { this.gl.deleteTexture(this.texture); } catch (e) { /* best effort */ }
        this.texture = null;
      }
      this.glyphs.clear();
    },
  };
  return font;
}

/* ------------------------------------------------------------------ per-gl -- */

const _fonts = (typeof WeakMap === 'function') ? new WeakMap() : null;

/**
 * The atlas for this context, built on first use and shared by every caller. The renderer binds
 * it and the facade pass lays text out with it; there is one texture in the process either way.
 * Returns null if the atlas could not be built — every caller must handle that.
 */
export function getFont(gl, opts) {
  if (!gl) return null;
  if (_fonts && _fonts.has(gl)) return _fonts.get(gl);
  let font = null;
  try {
    font = createFontAtlas(gl, opts);
  } catch (err) {
    font = null;
  }
  if (_fonts) _fonts.set(gl, font);
  return font;
}

/** Forget the cached atlas AND delete its texture. Teardown. */
export function releaseFont(gl) {
  if (!gl || !_fonts || !_fonts.has(gl)) return;
  const font = _fonts.get(gl);
  if (font) font.dispose();
  _fonts.delete(gl);
}

/**
 * Drop the cached atlas WITHOUT deleting its texture. This is the context-loss path: the texture
 * object died with the old context and deleting it through the new one is invalid, so the handle
 * is abandoned and the next getFont() rasterises a fresh atlas.
 */
export function forgetFont(gl) {
  if (!gl || !_fonts || !_fonts.has(gl)) return;
  const font = _fonts.get(gl);
  if (font) font.texture = null;
  _fonts.delete(gl);
}
