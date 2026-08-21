// src/render/text.js — legible text in the world: the layout engine that turns a string into
// textured quads in a caller-supplied MeshBuilder, and the level-of-detail distances the
// renderer fades a run over.
//
// WHY THIS EXISTS. From the air the city is right. On foot it is not, and the reason is that a
// street is mostly WORDS: the fascia over a door, the blade at the corner, the number beside it.
// Everything downstream of this file — 6,870 surveyed unit names, 209 named streets, 6,370 house
// numbers — is unusable without a way to draw a letter, and the engine had none: the vertex
// format carried no texture coordinate and the only samplers in the renderer were the shadow
// atlas, the G-buffer and the post chain.
//
// The glyph atlas itself is render/font.js. Its API is re-exported here so that this file is
// the single import point for text: a caller asks render/text.js for a font AND for the quads.
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

export { createFontAtlas, getFont, releaseFont, forgetFont } from './font.js';

/* ---------------------------------------------------------------- constants */

const EPS = 1e-9;
// The cut marker fitText appends when a name will not fit even at the shrink floor. It is in
// the atlas charset, so it always has a glyph.
const ELLIPSIS = '…';

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
// stage, and the numbers the renderer fades over; they are exported from one place so the geometry
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

/* ------------------------------------------------------------ small helpers */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
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
