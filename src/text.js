// src/text.js — legible text in the world: a signed-distance-field glyph atlas rasterised at
// boot with Canvas 2D, and a layout engine that turns a string into quads in a caller-supplied
// MeshBuilder.
//
// WHY THIS EXISTS. From the air the city is right. On foot it is not, and the reason is that a
// street is mostly WORDS: the fascia over a door, the blade at the corner, the number beside it.
// Everything downstream of this file — 6,870 surveyed unit names, 209 named streets, 6,370 house
// numbers — is unusable without a way to draw a letter, and the engine had none: the vertex
// format carried no texture coordinate and the only samplers in the renderer were the shadow
// atlas, the G-buffer and the post chain.
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
// TIME-OF-DAY INDEPENDENCE (CONTRACT Amendment 7). This file emits GEOMETRY and MATERIAL, never
// light. A sign face carries an albedo, a roughness and an emissive FLAG; the renderer decides
// when a lit fascia is actually on. Nothing here bakes a shadow, an occlusion or a night colour.
//
// DETERMINISM. There is no random number in this file. A string always produces the same quads at
// the same world position, so a tile built alone is byte-identical to the same tile built last
// (the tiling contract in tiles.js).
//
// Zero dependencies. The vertex format's packed texture coordinate is written through
// MeshBuilder.uv(), so nothing here needs to know how it is encoded.

/* ---------------------------------------------------------------- constants */

const EPS = 1e-9;

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

/** Horizontal alignment of a run against its anchor. */
export const ALIGN = { LEFT: 0, CENTER: 1, RIGHT: 2 };

/**
 * Vertical placement of a run against its anchor.
 *   BASELINE the anchor is on the baseline (typographic origin)
 *   MIDDLE   the anchor is halfway up the CAP height — what a sign band wants
 *   TOP      the anchor is at the cap line
 *   BOTTOM   the anchor is at the descender line
 */
export const VALIGN = { BASELINE: 0, MIDDLE: 1, TOP: 2, BOTTOM: 3 };

// Lighting profile carried in aMat.w for a glyph quad. 0..5 are the facade classes the scene
// shader dispatches on (envelope, office, residential, retail, parking, civic); 6 says "this is
// a glyph, sample the atlas". The renderer draws text with its own program, so this is an
// identification channel rather than a branch — it exists so a text vertex that ends up in an
// ordinary material class is recognisable rather than mysterious.
export const TEXT_PROFILE = 6;

// LEVEL OF DETAIL, in metres. These are the numbers a caller should give TileManager for a text
// stage, and the numbers render.js fades over; they are exported from one place so the geometry
// and the fade cannot drift apart.
//
//   FADE_START  where a glyph starts losing opacity. A 0.25 m shop name on a 900-line frame at a
//               60 degree vertical field subtends 0.25/d radians against 859 px/rad, so it is
//               2.4 px of cap height at 90 m — the point where a word has stopped being read and
//               started being a smudge.
//   FADE_END    where it is gone. Well inside the 200 m the acceptance test asks for.
//   RANGE/DROP  the tile stage that carries the geometry. RANGE is past FADE_END so a run fades
//               out completely BEFORE its tile is allowed to drop it, and DROP is 25% past RANGE
//               so a camera sitting on the boundary does not thrash the tile.
export const TEXT_FADE_START = 90;
export const TEXT_FADE_END = 150;
export const TEXT_RANGE = 165;
export const TEXT_DROP = 210;

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

const ELLIPSIS = '…';
// The probe decides the em size: the tallest accented capital over the deepest descender is the
// worst case the cell has to hold, and the widest glyph is the worst case for the cell's width.
const PROBE_TALL = 'ÁÉÜQgjpqy|_';

/* ------------------------------------------------------------ small helpers */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

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
 * The atlas for this context, built on first use and shared by every caller. render.js binds it
 * and city.js lays text out with it; there is exactly one texture in the process either way.
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

/* ------------------------------------------------------------------ layout -- */

// A missing glyph is folded rather than dropped: strip the accent first (NFD leaves the base
// letter in front of a combining mark), and only then give up and draw a question mark. Losing
// the accent on one restaurant name is a much smaller lie than losing the name.
function glyphFor(font, cp) {
  const g = font.glyphs.get(cp);
  if (g) return g;
  const s = String.fromCodePoint(cp);
  if (typeof s.normalize === 'function') {
    const base = s.normalize('NFD').codePointAt(0);
    if (base !== cp) {
      const b = font.glyphs.get(base);
      if (b) return b;
    }
  }
  return font.glyphs.get(0x3f) || null;
}

// Code points of a string, as an array so slicing never splits a surrogate pair.
function points(str) {
  const out = [];
  for (const ch of String(str)) out.push(ch.codePointAt(0));
  return out;
}

function advanceOfPoints(font, cps, tracking) {
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const g = glyphFor(font, cps[i]);
    if (g) w += g.adv;
    if (i > 0) w += tracking;
  }
  return w;
}

/**
 * Advance width of a string in EM units. Multiply by (capHeight / font.cap) for metres.
 * No pair kerning: the layout and the measurement therefore agree exactly, which matters more
 * for fitting text to a fascia than the fraction of a millimetre kerning would move an 'AV'.
 */
export function textAdvance(font, str, tracking) {
  if (!font) return 0;
  return advanceOfPoints(font, points(str), numOr(tracking, font.tracking));
}

/** Width of a string in METRES at the given cap height. */
export function textWidth(font, str, capHeight, tracking) {
  if (!font) return 0;
  const cap = font.cap > EPS ? font.cap : 0.72;
  return textAdvance(font, str, tracking) * (numOr(capHeight, 1) / cap);
}

/**
 * Fit a string to a maximum width: shrink first, then ellipsise.
 *
 * A 28-character restaurant name on a 4 m fascia is the normal case, not the exception, and the
 * two failure modes are opposite. Shrinking alone makes the long names unreadable at the size the
 * short ones are comfortable at; truncating alone throws away the half of the name that is the
 * half you recognise. So: give up to `minScale` of the requested cap height (0.62 by default,
 * which is where a 250 mm sign is still a 155 mm sign and still reads), and only then cut, with
 * an ellipsis, at a whole glyph.
 *
 * Returns { text, cps, height, width, scale, shrunk, ellipsised } — width in METRES at the
 * returned height.
 */
export function fitText(font, str, capHeight, maxWidth, minScale, tracking) {
  const h0 = Math.max(numOr(capHeight, 1), EPS);
  const empty = { text: '', cps: [], height: h0, width: 0, scale: 1, shrunk: false, ellipsised: false };
  if (!font) return empty;
  const tr = numOr(tracking, font.tracking);
  const cps = points(str);
  if (!cps.length) return empty;

  const cap = font.cap > EPS ? font.cap : 0.72;
  const advEm = advanceOfPoints(font, cps, tr);
  let unit = h0 / cap;
  let width = advEm * unit;
  const limit = numOr(maxWidth, 0);
  if (!(limit > 0) || width <= limit) {
    return { text: String(str), cps, height: h0, width, scale: 1, shrunk: false, ellipsised: false };
  }

  const floor = clamp(numOr(minScale, 0.62), 0.15, 1);
  const scale = Math.max(limit / Math.max(width, EPS), floor);
  const h1 = h0 * scale;
  unit = h1 / cap;
  width = advEm * unit;
  if (width <= limit) {
    return { text: String(str), cps, height: h1, width, scale, shrunk: true, ellipsised: false };
  }

  // Still too wide at the floor: cut. The ellipsis always fits — its own advance is about a third
  // of an em — and at least one glyph always survives, so a run never silently disappears.
  const ellCp = points(ELLIPSIS);
  const ellW = advanceOfPoints(font, ellCp, tr) + tr;
  const room = limit / Math.max(unit, EPS) - ellW;
  let acc = 0;
  let cut = 0;
  for (let i = 0; i < cps.length; i++) {
    const g = glyphFor(font, cps[i]);
    const step = (g ? g.adv : 0) + (i > 0 ? tr : 0);
    if (acc + step > room) break;
    acc += step;
    cut = i + 1;
  }
  if (cut < 1) cut = 1;
  const kept = cps.slice(0, cut);
  const outCps = kept.concat(ellCp);
  return {
    text: kept.map((c) => String.fromCodePoint(c)).join('') + ELLIPSIS,
    cps: outCps,
    height: h1,
    width: advanceOfPoints(font, outCps, tr) * unit,
    scale,
    shrunk: true,
    ellipsised: true,
  };
}

/* ------------------------------------------------------------------ emission */

const _R = new Float64Array(3);
const _U = new Float64Array(3);
const _N = new Float64Array(3);

function normalise(out, x, y, z, fx, fy, fz) {
  const l = Math.sqrt(x * x + y * y + z * z);
  if (l > EPS) {
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
  } else {
    out[0] = fx;
    out[1] = fy;
    out[2] = fz;
  }
  return out;
}

/**
 * Append a string to `mb` as a run of textured quads.
 *
 * The run is placed on the plane spanned by a RIGHT vector and an UP vector through an ANCHOR,
 * which is how every real sign is specified: a fascia knows its own frontage direction and which
 * way is up, and nothing else. Neither vector need be unit length or exactly perpendicular; both
 * are normalised, and the face normal is right x up unless one is given.
 *
 * o = {
 *   x, y, z            anchor, world metres                             (required)
 *   rx, ry, rz         right vector along the reading direction          (default +X east)
 *   ux, uy, uz         up vector                                         (default +Y)
 *   nx, ny, nz         face normal; omit for right x up
 *   h                  CAP height in metres                              (default 0.25)
 *   align              ALIGN.LEFT | CENTER | RIGHT                       (default CENTER)
 *   vAlign             VALIGN.*                                          (default MIDDLE)
 *   maxWidth           metres; shrink then ellipsise to fit              (default none)
 *   minScale           how far h may shrink before cutting               (default 0.62)
 *   tracking           extra advance per gap, EM units                   (default font.tracking)
 *   lift               metres along the normal, off the surface behind   (default 0.012)
 *   r, g, b            linear albedo of the paint                        (default white)
 *   emissive           0 = painted board, > 0 = an internally lit sign   (default 0)
 *   tintable           1 = follows the renderer tint                     (default 0)
 *   rough              0 mirror .. 1 matte; enamel and vinyl are matte    (default 0.55)
 * }
 *
 * Returns { verts, glyphs, width, height, scale, shrunk, ellipsised, text }, where `width` is
 * the ADVANCE width in metres — what `maxWidth` is measured against. The quads themselves reach
 * about 0.15 em further at each end, because a distance field has to carry its own spread past
 * the ink; on a 4 m fascia that is 25 mm of overhang, which is inside the board the lettering
 * sits on. Size a sign band by the advance, not by the geometry.
 */
export function appendText(mb, font, str, o) {
  const none = {
    verts: 0, glyphs: 0, width: 0, height: 0, scale: 1,
    shrunk: false, ellipsised: false, text: '',
  };
  if (!mb || !font || !font.texture) return none;
  const opt = o || {};

  const h = Math.max(numOr(opt.h, 0.25), 1e-3);
  const tracking = numOr(opt.tracking, font.tracking);
  const fit = fitText(font, str, h, numOr(opt.maxWidth, 0), numOr(opt.minScale, 0.62), tracking);
  const cps = fit.cps;
  if (!cps.length) return none;

  const cap = font.cap > EPS ? font.cap : 0.72;
  const unit = fit.height / cap;                 // metres per EM
  const advEm = fit.width / Math.max(unit, EPS); // total advance, EM units

  normalise(_R, numOr(opt.rx, 1), numOr(opt.ry, 0), numOr(opt.rz, 0), 1, 0, 0);
  normalise(_U, numOr(opt.ux, 0), numOr(opt.uy, 1), numOr(opt.uz, 0), 0, 1, 0);
  if (Number.isFinite(opt.nx) || Number.isFinite(opt.ny) || Number.isFinite(opt.nz)) {
    normalise(_N, numOr(opt.nx, 0), numOr(opt.ny, 0), numOr(opt.nz, 1), 0, 0, 1);
  } else {
    normalise(
      _N,
      _R[1] * _U[2] - _R[2] * _U[1],
      _R[2] * _U[0] - _R[0] * _U[2],
      _R[0] * _U[1] - _R[1] * _U[0],
      0, 0, 1
    );
  }

  const align = opt.align | 0;
  let penEm = 0;
  if (align === ALIGN.CENTER) penEm = -advEm * 0.5;
  else if (align === ALIGN.RIGHT) penEm = -advEm;

  const vAlign = opt.vAlign === undefined ? VALIGN.MIDDLE : (opt.vAlign | 0);
  let baseEm = 0;
  if (vAlign === VALIGN.MIDDLE) baseEm = -cap * 0.5;
  else if (vAlign === VALIGN.TOP) baseEm = -cap;
  else if (vAlign === VALIGN.BOTTOM) baseEm = font.descent;

  const lift = numOr(opt.lift, 0.012);
  const ox = numOr(opt.x, 0) + _N[0] * lift;
  const oy = numOr(opt.y, 0) + _N[1] * lift;
  const oz = numOr(opt.z, 0) + _N[2] * lift;

  const rx = _R[0] * unit;
  const ry = _R[1] * unit;
  const rz = _R[2] * unit;
  const ux = _U[0] * unit;
  const uy = _U[1] * unit;
  const uz = _U[2] * unit;
  const nx = _N[0];
  const ny = _N[1];
  const nz = _N[2];

  // Save the builder's material state: appendText is a guest in someone else's mesh and must not
  // leave its colour or its texture coordinate behind for the next quad the caller emits.
  const sr = mb._r; const sg = mb._g; const sb = mb._b;
  const se = mb._e; const st = mb._t; const srg = mb._rg; const spf = mb._pf;
  const suv = mb._uv;

  mb.color(
    numOr(opt.r, 1), numOr(opt.g, 1), numOr(opt.b, 1),
    numOr(opt.emissive, 0), numOr(opt.tintable, 0), clamp(numOr(opt.rough, 0.55), 0.03, 1),
    TEXT_PROFILE
  );

  let verts = 0;
  let drawn = 0;
  for (let i = 0; i < cps.length; i++) {
    if (i > 0) penEm += tracking;
    const g = glyphFor(font, cps[i]);
    if (!g) continue;
    if (g.blank) {
      penEm += g.adv;
      continue;
    }
    const a0 = penEm + g.x0;
    const a1 = penEm + g.x1;
    const b0 = baseEm + g.y0;
    const b1 = baseEm + g.y1;

    // Corners, counter-clockwise seen from the +normal side: bottom-left, bottom-right,
    // top-right, top-left. The cross product of the first two edges is exactly +normal, which is
    // what the back-face cull expects.
    const blx = ox + rx * a0 + ux * b0;
    const bly = oy + ry * a0 + uy * b0;
    const blz = oz + rz * a0 + uz * b0;
    const brx = ox + rx * a1 + ux * b0;
    const bry = oy + ry * a1 + uy * b0;
    const brz = oz + rz * a1 + uz * b0;
    const trx = ox + rx * a1 + ux * b1;
    const try_ = oy + ry * a1 + uy * b1;
    const trz = oz + rz * a1 + uz * b1;
    const tlx = ox + rx * a0 + ux * b1;
    const tly = oy + ry * a0 + uy * b1;
    const tlz = oz + rz * a0 + uz * b1;

    mb.uv(g.u0, g.v1); mb.vert(blx, bly, blz, nx, ny, nz);
    mb.uv(g.u1, g.v1); mb.vert(brx, bry, brz, nx, ny, nz);
    mb.uv(g.u1, g.v0); mb.vert(trx, try_, trz, nx, ny, nz);
    mb.uv(g.u0, g.v1); mb.vert(blx, bly, blz, nx, ny, nz);
    mb.uv(g.u1, g.v0); mb.vert(trx, try_, trz, nx, ny, nz);
    mb.uv(g.u0, g.v0); mb.vert(tlx, tly, tlz, nx, ny, nz);

    verts += 6;
    drawn++;
    penEm += g.adv;
  }

  mb._r = sr; mb._g = sg; mb._b = sb;
  mb._e = se; mb._t = st; mb._rg = srg; mb._pf = spf;
  mb._uv = suv;

  const s = font.stats;
  s.runs++;
  s.glyphs += drawn;
  s.verts += verts;
  if (fit.shrunk) s.shrunk++;
  if (fit.ellipsised) s.ellipsised++;

  return {
    verts,
    glyphs: drawn,
    width: fit.width,
    height: fit.height,
    scale: fit.scale,
    shrunk: fit.shrunk,
    ellipsised: fit.ellipsised,
    text: fit.text,
  };
}

/**
 * Vertices a run will cost, without building it. Callers budgeting a tile can ask before they
 * commit; six per inked glyph, none for a space.
 */
export function textVertexCost(font, str) {
  if (!font) return 0;
  const cps = points(str);
  let n = 0;
  for (let i = 0; i < cps.length; i++) {
    const g = glyphFor(font, cps[i]);
    if (g && !g.blank) n += 6;
  }
  return n;
}
