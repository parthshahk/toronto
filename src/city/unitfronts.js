// src/city/unitfronts.js — ONE ADDRESSED UNIT'S FRONTAGE: the glazing, fascia, shutter, doorway,
// wall fixtures and house number that make a surveyed premises read as what it is.
//
// CONTRACT.md §6.2, extended for the surveyed unit data. The (u, v, d) frame, yaw, the materials,
// the LOD contract and the two vertex invariants are documented once, in ./facadekit.js.
//
// The TAXONOMY — which OSM tag becomes which kind, and what that kind looks like — is in
// ./unitkinds.js. This file is handed a style and draws it, so a bank reads as a bank and the
// chemist two doors down does not.
//
// THE BLOCK-FACE MODEL — which units land on which wall, in which order, at what width — is not
// here. That is city.js's job (and CONTRACT Amendment 11.1's city/units.js); this file is handed a
// width and a kind and draws one frontage. Each export returns the number of vertices it appended.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { ALIGN, VALIGN, appendText } from '../render/text.js';
import {
  DOOR_H, FACADE_LOD, F_BOT, F_ENDS, F_LEFT, F_OUT, F_RIGHT, F_SHELL, F_TOP, LEAF_W,
  MAT_GLASS_LIT, MAT_INTERIOR, MAT_METAL_DARK, MAT_METAL_PALE, MAT_RUBBER, MAT_SHUTTER,
  MAT_SIGN_LIT, MAT_STEEL, MAT_VALANCE, MIN_EXT, MULLION_D, MULLION_W, RECESS_D, SKIN,
  applyHost, applyMat, fallbackRng, frameAt, fx, fz, lodOf, readHost, rect, rngOf, slab, vcount,
} from './facadekit.js';
import { appendAwning, doorLeaf, surround } from './facades.js';
import {
  FASCIA_COLS, MAT_BOARD, MAT_GLASS_BRIGHT, MAT_SHUTTER_BOX, MAT_STONE_DARK, strHash, unitStyle,
} from './unitkinds.js';

// A rolling shutter. Open, it is the housing box over the head — which is what you actually see
// on a Toronto shopfront during the day, and what its absence gives away. Closed, it is the
// slatted curtain over the whole opening. 18 verts open, 30 closed.
export function appendSecurityShutter(mb, x, y, z, yaw, width, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.8) return 0;
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const o = opts || {};
  const hw = w * 0.5;
  const h = clamp(isNum(height) ? height : 3.0, 0.6, 8.0);
  applyMat(mb, MAT_SHUTTER_BOX);
  slab(mb, F, -hw, hw, h, h + 0.30, SKIN, 0.26, F_OUT | F_TOP | F_BOT | F_ENDS);
  if (o.closed) {
    applyMat(mb, MAT_SHUTTER);
    rect(mb, F, -hw + 0.03, hw - 0.03, 0.04, h, 0.14);
    applyMat(mb, MAT_METAL_DARK);
    for (let k = 0; k < 2; k++) {
      const u = k === 0 ? -hw : hw - 0.06;
      slab(mb, F, u, u + 0.06, 0, h + 0.30, SKIN, 0.19, F_OUT | F_ENDS);
    }
  }
  return vcount(mb) - before;
}

// A wall-mounted fixture: the ATM, vending machine, payphone or plaque the survey found on a
// frontage. These are premises in OSM and street furniture in life, so they get an object on the
// wall rather than a shopfront. 12-42 verts.
export function appendWallFixture(mb, rng, x, y, z, yaw, kind, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 53);
  const host = readHost(mb, mat);
  const r0 = R();
  if (lodOf(opts) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.72, 0.62);
    rect(mb, F, -0.42, 0.42, 0.05, 1.90, SKIN);
    return vcount(mb) - before;
  }
  if (kind === 'atm') {
    applyHost(mb, host, 0.66, 0.42);
    slab(mb, F, -0.46, 0.46, 0.22, 2.15, SKIN, 0.22, F_OUT | F_TOP | F_BOT | F_ENDS);
    applyMat(mb, MAT_METAL_DARK);
    rect(mb, F, -0.34, 0.34, 0.95, 1.62, 0.235);
    applyMat(mb, MAT_VALANCE);
    slab(mb, F, -0.40, 0.40, 2.15, 2.30, 0.06, 0.26, F_OUT | F_BOT | F_ENDS);
  } else if (kind === 'telephone') {
    applyMat(mb, MAT_METAL_PALE);
    slab(mb, F, -0.32, 0.32, 0.95, 1.95, SKIN, 0.30, F_SHELL);
    applyMat(mb, MAT_METAL_DARK);
    rect(mb, F, -0.24, 0.24, 1.15, 1.72, 0.315);
  } else {
    // Vending machine, locker bank, notice board: a cabinet with a lit face.
    const w = 0.46 + r0 * 0.22;
    applyMat(mb, MAT_METAL_DARK);
    slab(mb, F, -w, w, 0.03, 1.86, SKIN, 0.62, F_SHELL);
    applyMat(mb, MAT_GLASS_BRIGHT);
    rect(mb, F, -w + 0.07, w - 0.07, 0.36, 1.70, 0.635);
  }
  return vcount(mb) - before;
}

// A vehicle opening: the parking entrance or loading door the survey marks with
// amenity=parking_entrance / loading_dock. A coiling door in a concrete surround, with the
// headroom bar every Toronto garage has. ~78 verts.
export function appendVehicleDoor(mb, rng, x, y, z, yaw, width, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.8) return 0;
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 59);
  const host = readHost(mb, mat);
  const o = opts || {};
  const r0 = R();
  const hw = Math.min(w, 7.2) * 0.5;
  const h = clamp(isNum(height) ? height * 0.62 : 3.1, 2.4, 4.6);
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.86, 0.62);
    rect(mb, F, -hw - 0.20, hw + 0.20, 0, h + 0.34, SKIN);
    applyMat(mb, MAT_SHUTTER);
    rect(mb, F, -hw, hw, 0.05, h, SKIN + 0.02);
    return vcount(mb) - before;
  }
  applyHost(mb, host, 0.90, 0.58);
  slab(mb, F, -hw - 0.22, -hw, 0, h + 0.34, SKIN, 0.20, F_OUT | F_ENDS);
  slab(mb, F, hw, hw + 0.22, 0, h + 0.34, SKIN, 0.20, F_OUT | F_ENDS);
  slab(mb, F, -hw - 0.22, hw + 0.22, h, h + 0.34, SKIN, 0.20, F_OUT | F_TOP | F_BOT);
  applyMat(mb, MAT_SHUTTER);
  rect(mb, F, -hw, hw, 0.04, h - 0.02, 0.09);
  // Headroom bar on two chains, and a bulkhead lamp over the opening.
  applyMat(mb, MAT_METAL_DARK);
  slab(mb, F, -hw, hw, h - 0.34, h - 0.22, 0.24, 0.32, F_OUT | F_TOP | F_BOT | F_ENDS);
  applyMat(mb, MAT_RUBBER);
  for (let k = 0; k < 2; k++) {
    const u = k === 0 ? -hw - 0.14 : hw + 0.02;
    slab(mb, F, u, u + 0.12, 0, 0.62, 0.05, 0.20, F_SHELL);
  }
  if (r0 < 0.8) {
    applyMat(mb, MAT_VALANCE);
    slab(mb, F, -0.22, 0.22, h + 0.38, h + 0.52, 0.06, 0.24, F_OUT | F_BOT | F_ENDS);
  }
  return vcount(mb) - before;
}

// The recessed retail entry, lean version: surround, reveal floor, interior plane, one or two
// leaves and a soffit downlight. Returns the head height so the caller can glaze above it.
function unitDoorRecess(mb, F, R, host, hw2, h, glass) {
  const hw = clamp(hw2, 0.55, 2.2);
  const proj = RECESS_D;
  surround(mb, F, host, hw, h, proj, 0.17);
  applyHost(mb, host, 0.80, 0.70);
  slab(mb, F, -hw, hw, -0.02, 0.045, -0.02, proj + 0.12, F_OUT | F_TOP);
  applyMat(mb, glass);
  rect(mb, F, -hw + 0.02, hw - 0.02, 0.045, h - 0.04, 0.03);
  const twin = hw > 1.02;
  const lw = twin ? Math.min(LEAF_W, hw - 0.10) : Math.min(1.02, hw * 2 - 0.14);
  if (twin) {
    doorLeaf(mb, F, -lw, 0, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
    doorLeaf(mb, F, 0, lw, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  } else {
    doorLeaf(mb, F, -lw * 0.5, lw * 0.5, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  }
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.22, hw - 0.22, h - 0.09, h - 0.05, proj * 0.35, proj * 0.75, F_BOT);
  return h + 0.18;
}

// The flush glazed entry: no reveal, a pressed frame and a leaf. Half the cost of the recess and
// the right answer for a bank, a clinic, a salon or a convenience store.
function unitDoorFlush(mb, F, host, hw2, h, glass, solid) {
  const hw = clamp(hw2, 0.48, 1.6);
  applyHost(mb, host, 1.02, 0.52);
  slab(mb, F, -hw - 0.13, hw + 0.13, h, h + 0.16, SKIN, 0.16, F_OUT | F_TOP | F_BOT);
  slab(mb, F, -hw - 0.13, -hw, 0, h, SKIN, 0.16, F_OUT | F_RIGHT);
  slab(mb, F, hw, hw + 0.13, 0, h, SKIN, 0.16, F_OUT | F_LEFT);
  applyMat(mb, glass);
  rect(mb, F, -hw, hw, 0.04, h - 0.02, 0.04);
  if (solid) doorLeaf(mb, F, -hw + 0.05, hw - 0.05, 0.05, 0.05 + DOOR_H, 0.10, MAT_STEEL);
  else doorLeaf(mb, F, -hw + 0.05, hw - 0.05, 0.05, 0.05 + DOOR_H, 0.10, MAT_GLASS_LIT);
  applyHost(mb, host, 0.86, 0.72);
  slab(mb, F, -hw - 0.17, hw + 0.17, -0.02, 0.05, -0.05, 0.24, F_OUT | F_TOP | F_ENDS);
  return h + 0.16;
}

// The fascia sign board. GEOMETRY ONLY — the lettering is a separate pass, because a glyph is a
// blended decal in render.js and must not land in an opaque material class, and because the two
// are built at different distances (see opts.textOnly on appendUnitFront).
function fasciaBoard(mb, F, host, hw, H, signH, st, brandCol, lit) {
  if (signH < 0.16) return;
  let cr, cg, cb;
  if (brandCol) { cr = brandCol[0]; cg = brandCol[1]; cb = brandCol[2]; }
  else if (lit) { cr = MAT_SIGN_LIT[0]; cg = MAT_SIGN_LIT[1]; cb = MAT_SIGN_LIT[2]; }
  else { cr = host[0] * 0.58; cg = host[1] * 0.58; cb = host[2] * 0.58; }
  mb.color(cr, cg, cb, lit ? 0.60 : 0, 0, lit ? 0.50 : 0.62, 0);
  slab(mb, F, -hw, hw, H - signH, H, SKIN, st.proj, F_OUT | F_TOP | F_BOT);
}

// ...and the shop's name across it.
function fasciaText(F, host, hw, H, signH, st, o, brandCol, lit) {
  if (signH < 0.16) return;
  if (!o.textMb || !o.font || !o.name || !(st.cap > 0)) return;
  let cr, cg, cb;
  if (brandCol) { cr = brandCol[0]; cg = brandCol[1]; cb = brandCol[2]; }
  else if (lit) { cr = MAT_SIGN_LIT[0]; cg = MAT_SIGN_LIT[1]; cb = MAT_SIGN_LIT[2]; }
  else { cr = host[0] * 0.58; cg = host[1] * 0.58; cb = host[2] * 0.58; }
  // Letters pale on a dark board, dark on a pale one. Luminance of the board decides, so a
  // brand colour never lands unreadable on its own fascia.
  const lum = cr * 0.30 + cg * 0.59 + cb * 0.11;
  const pale = lum < 0.10;
  const cap = Math.min(st.cap, signH * 0.62);
  const run = appendText(o.textMb, o.font, o.name, {
    x: fx(F, 0, st.proj + 0.012), y: F.y + H - signH * 0.5, z: fz(F, 0, st.proj + 0.012),
    rx: -F.s, ry: 0, rz: -F.c, ux: 0, uy: 1, uz: 0,
    nx: F.c, ny: 0, nz: -F.s,
    h: cap, align: ALIGN.CENTER, vAlign: VALIGN.MIDDLE,
    maxWidth: hw * 2 - 0.30, minScale: 0.52, lift: 0.010,
    r: pale ? 0.255 : 0.026, g: pale ? 0.252 : 0.024, b: pale ? 0.240 : 0.026,
    emissive: 0, rough: 0.55,
  });
  if (o.audit) {
    o.audit.textRuns++;
    o.audit.textGlyphs += run.glyphs;
    if (run.shrunk) o.audit.textShrunk++;
    if (run.ellipsised) o.audit.textEllipsised++;
  }
}

// The house number's enamel plate beside the door, and the digits on it. 6 verts plus the digits.
function numberPlate(mb, F, host, u) {
  applyHost(mb, host, 1.10, 0.55);
  rect(mb, F, u - 0.17, u + 0.17, 2.28, 2.58, 0.05);
}

function numberText(F, u, house, o) {
  if (!house || !o.textMb || !o.font) return;
  const run = appendText(o.textMb, o.font, house, {
    x: fx(F, u, 0.062), y: F.y + 2.43, z: fz(F, u, 0.062),
    rx: -F.s, ry: 0, rz: -F.c, ux: 0, uy: 1, uz: 0,
    nx: F.c, ny: 0, nz: -F.s,
    h: 0.135, align: ALIGN.CENTER, vAlign: VALIGN.MIDDLE,
    maxWidth: 0.30, minScale: 0.45, lift: 0.008,
    r: 0.030, g: 0.030, b: 0.032, emissive: 0, rough: 0.58,
  });
  if (o.audit) { o.audit.textNumbers++; o.audit.textGlyphs += run.glyphs; }
}

/**
 * ONE UNIT of a block face: the premises between two party walls, built from what the survey
 * says is actually there.
 *
 * (x, y, z) is the wall point at the CENTRE of the unit, at sidewalk level; `yaw` faces out;
 * `width` is the unit's frontage and `height` the ground storey, floor to the top of the fascia.
 *
 * opts: {
 *   kind      canonical kind from unitKindOf(); default 'goods'
 *   name      the shop's name, lettered on the fascia (needs font + textMb)
 *   house     its house number, lettered on a plate beside the door
 *   brand     a chain: its fascia takes a colour hashed from this string, and nothing else
 *   font      a text.js Font
 *   textMb    the MeshBuilder glyphs go into — NEVER the same one as `mb`
 *   endL/endR draw the party pilaster at that end (endL defaults true, endR false)
 *   textOnly  emit ONLY the lettering, into opts.textMb, and no geometry at all. The two passes
 *             take the same values off the position-seeded generator in the same order, so the
 *             sign lands on exactly the fascia the geometry pass built
 *   doorSide  -1 left, 0 centre, +1 right; default hashed
 *   awning    false to suppress the awning whatever the style says
 *   audit     optional counter object with the fields textRuns, textGlyphs, textShrunk,
 *             textEllipsised and textNumbers, incremented as the lettering is laid out
 *   lod       FACADE_LOD.*
 * }
 *
 * Measured cost at FULL: 132 verts for a 7 m food unit with a recessed door, 96 for a flush one,
 * 42 for a blank party wall. At FACADE_LOD.COARSE: 24-30 whatever the kind.
 * @returns {number} vertices appended
 */
export function appendUnitFront(mb, rng, x, y, z, yaw, width, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.1) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  // Position-seeded, always: a unit must look the same whether its tile was built first or last.
  const R = fallbackRng(x, z, 71);
  const host = readHost(mb, o.mat || mat);
  const kind = typeof o.kind === 'string' ? o.kind : 'goods';
  const st = unitStyle(kind);
  const H = clamp(isNum(height) ? height : 4.4, 2.6, 9.0);
  const hw = w * 0.5;

  // Every draw taken up front and in a fixed order, so a branch can never shift the stream.
  const rDoor = R();
  const rAwn = R();
  const rShut = R();
  const rBay = R();

  // TEXT-ONLY. The signage that hangs on this unit is built at a much shorter range than the
  // unit itself (a 250 mm shop name is a smear past 150 m), so it is a separate tile stage. Both
  // passes run this same function and take the same values off R in the same order, so the
  // lettering lands on exactly the fascia the geometry pass built — there is one source of truth
  // for where a sign is, not two that can drift.
  const textOnly = !!o.textOnly;

  // THE PARTY WALL, early and cheap: a plinth, a string of punched openings sized to the wall,
  // and nothing else. 30-48 verts against 240-400 for a shopfront.
  if (st.plain) {
    if (textOnly) return 0;
    applyHost(mb, host, 0.80, 0.72);
    slab(mb, F, -hw, hw, 0, Math.min(st.bulk, H * 0.22), SKIN, 0.07, F_OUT | F_TOP);
    const nw = clamp(Math.floor(w / 4.2), 0, 4);
    if (nw > 0 && H > 3.0) {
      const pitch = w / nw;
      const ww = Math.min(pitch * 0.45, 1.35);
      const v0 = clamp(H * 0.28, 0.9, 1.4);
      const v1 = Math.min(H - 0.55, v0 + 1.85);
      if (v1 - v0 > 0.4) {
        for (let i = 0; i < nw; i++) {
          const uc = -hw + (i + 0.5) * pitch;
          applyMat(mb, st.glass);
          rect(mb, F, uc - ww * 0.5, uc + ww * 0.5, v0, v1, SKIN + 0.01);
        }
      }
    }
    return vcount(mb) - before;
  }

  const signH = st.cap > 0 ? clamp(H * st.fasc, 0.34, 1.05) : 0;
  const headH = 0.12;
  const glazTop = H - signH - headH;
  const glazBot = Math.min(st.bulk, glazTop - 0.5);
  const brandCol = (typeof o.brand === 'string' && o.brand)
    ? FASCIA_COLS[strHash(o.brand) % FASCIA_COLS.length] : null;

  if (glazTop - glazBot < 0.55) {
    // No room for a shopfront at all: a blank panel with the fascia over it, which is what a
    // 2.6 m ground floor under a low roof actually is.
    const lit0 = R() < st.lit;
    if (textOnly) {
      fasciaText(F, host, hw, H, signH, st, o, brandCol, lit0);
      return 0;
    }
    applyHost(mb, host, 0.82, 0.72);
    rect(mb, F, -hw, hw, 0, Math.max(0.4, H - signH), SKIN);
    fasciaBoard(mb, F, host, hw, H, signH, st, brandCol, lit0);
    return vcount(mb) - before;
  }

  const glazHi = glazBot + (glazTop - glazBot) * clamp(st.glaz, 0, 1);
  const endL = o.endL !== false;
  const endR = !!o.endR;
  const pil = st.pil;
  const uL = endL ? -hw + pil * 2 : -hw;
  const uR = endR ? hw - pil * 2 : hw;
  const inner = uR - uL;

  // The entry: where along the unit, and how wide. Resolved BEFORE the level branches, so a
  // frontage built COARSE puts its door in exactly the place the FULL one does.
  const doorMode = st.door;
  const wantDoor = doorMode !== 'none' && inner >= 1.6;
  const doorW = wantDoor
    ? clamp(doorMode === 'vehicle' ? inner * 0.72 : inner * 0.26, 1.05,
      doorMode === 'vehicle' ? 6.4 : (doorMode === 'recess' ? 3.0 : 2.4))
    : 0;
  const side = isNum(o.doorSide) ? o.doorSide : (rDoor < 0.38 ? -1 : (rDoor < 0.76 ? 1 : 0));
  const margin = doorW * 0.5 + 0.12;
  let doorU = 0;
  if (wantDoor) {
    doorU = side === 0 ? (uL + uR) * 0.5
      : (side < 0 ? uL + margin : uR - margin);
    doorU = clamp(doorU, uL + margin, uR - margin);
  }
  const dL = wantDoor ? doorU - doorW * 0.5 : 0;
  const dR = wantDoor ? doorU + doorW * 0.5 : 0;

  // Draw #5 off R, in both modes and at the same point in the stream: whether the fascia is an
  // internally lit box or a painted board.
  const litSign = R() < st.lit;
  if (textOnly) {
    fasciaText(F, host, hw, H, signH, st, o, brandCol, litSign);
    if (wantDoor && o.house) {
      numberText(F, clamp(doorU + doorW * 0.5 + 0.28, uL + 0.18, uR - 0.18), o.house, o);
    }
    return 0;
  }

  /* --- COARSE ------------------------------------------------------------------------------
   * Four flat bands and, where the full version would put an entry, one dark panel. The bay
   * rhythm goes; the DATUM lines and the materials — which are what a shopfront reads as from
   * across a block, and what tells a bank from a cafe at that range — all survive. */
  if (lodOf(o) === FACADE_LOD.COARSE) {
    if (st.stone) applyMat(mb, MAT_STONE_DARK); else applyHost(mb, host, 0.74, 0.70);
    rect(mb, F, -hw, hw, 0, glazBot, SKIN);
    applyMat(mb, st.glass);
    rect(mb, F, uL, uR, glazBot, glazHi, SKIN + 0.015);
    if (glazTop - glazHi > MIN_EXT) {
      applyHost(mb, host, 0.88, 0.66);
      rect(mb, F, uL, uR, glazHi, glazTop, SKIN + 0.010);
    }
    applyHost(mb, host, 0.92, 0.60);
    rect(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN);
    if (signH > 0) {
      if (brandCol) {
        mb.color(brandCol[0], brandCol[1], brandCol[2], litSign ? 0.60 : 0, 0, 0.52, 0);
      } else if (litSign) applyMat(mb, MAT_SIGN_LIT);
      else applyHost(mb, host, 0.58, 0.55);
      rect(mb, F, -hw, hw, H - signH, H, SKIN);
    }
    if (wantDoor) {
      applyMat(mb, MAT_METAL_DARK);
      rect(mb, F, dL, dR, 0.02, Math.min(2.4, glazTop), SKIN + 0.03);
    }
    return vcount(mb) - before;
  }

  /* --- FULL -------------------------------------------------------------------------------- */

  // Party pilasters. Each unit owns its LEFT one; the last unit of a frontage closes the run.
  if (st.stone) applyMat(mb, MAT_STONE_DARK); else applyHost(mb, host, 1.00, 0.55);
  if (endL) slab(mb, F, -hw, uL, 0, glazTop + headH, SKIN, MULLION_D, F_OUT | F_ENDS);
  if (endR) slab(mb, F, uR, hw, 0, glazTop + headH, SKIN, MULLION_D, F_OUT | F_ENDS);

  // Stall riser, split around the entry so the reveal floor is not blocked.
  if (glazBot > 0.05) {
    if (st.stone) applyMat(mb, MAT_STONE_DARK); else applyHost(mb, host, 0.74, 0.70);
    if (!wantDoor) {
      slab(mb, F, uL, uR, 0, glazBot, SKIN, 0.10, F_OUT | F_TOP);
    } else {
      if (dL - uL > 0.12) slab(mb, F, uL, dL, 0, glazBot, SKIN, 0.10, F_OUT | F_TOP);
      if (uR - dR > 0.12) slab(mb, F, dR, uR, 0, glazBot, SKIN, 0.10, F_OUT | F_TOP);
    }
  }

  // Glazing, in bays, skipping the entry. The transom bar at door-head height is the datum every
  // real shopfront on Queen West shares.
  const target = st.bay * lerp(0.90, 1.14, rBay);
  const runs = wantDoor
    ? [[uL, dL], [dR, uR]]
    : [[uL, uR]];
  const transom = (glazHi - glazBot > 2.5) ? glazBot + (glazHi - glazBot) * 0.74 : 0;
  for (let s = 0; s < runs.length; s++) {
    const a = runs[s][0], b = runs[s][1];
    const span = b - a;
    if (span < 0.35) continue;
    const n = clamp(Math.round(span / target), 1, 8);
    const pitch = span / n;
    for (let i = 0; i < n; i++) {
      const u0 = a + i * pitch + (i === 0 ? 0.02 : MULLION_W * 0.6);
      const u1 = a + (i + 1) * pitch - (i === n - 1 ? 0.02 : MULLION_W * 0.6);
      if (u1 - u0 < 0.12) continue;
      applyMat(mb, st.glass);
      rect(mb, F, u0, u1, glazBot, glazHi, 0.05);
      if (glazTop - glazHi > MIN_EXT) {
        applyHost(mb, host, 0.88, 0.66);
        rect(mb, F, u0, u1, glazHi, glazTop, 0.05);
      }
      if (transom > 0) {
        applyMat(mb, MAT_METAL_DARK);
        rect(mb, F, u0, u1, transom - 0.045, transom + 0.045, 0.085);
      }
      if (i > 0) {
        applyMat(mb, MAT_METAL_DARK);
        slab(mb, F, u0 - MULLION_W, u0, glazBot, glazTop, 0.05, 0.11, F_OUT | F_ENDS);
      }
    }
  }

  // Head band and fascia.
  applyHost(mb, host, 0.92, 0.60);
  slab(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN, 0.16, F_OUT | F_BOT);
  fasciaBoard(mb, F, host, hw, H, signH, st, brandCol, litSign);

  // The entry itself, and the transom over it.
  let headTop = 0;
  if (wantDoor) {
    const dF = frameAt(fx(F, doorU, 0), F.y, fz(F, doorU, 0), F.yaw);
    const dh = clamp(2.52 + rDoor * 0.26, 2.4, Math.max(2.4, glazTop - 0.12));
    if (doorMode === 'vehicle') {
      appendVehicleDoor(mb, R, dF.x, dF.y, dF.z, dF.yaw, doorW, H, host, o);
      headTop = glazTop;
    } else if (doorMode === 'recess') {
      headTop = unitDoorRecess(mb, dF, R, host, doorW * 0.5, dh, st.glass);
    } else if (doorMode === 'lobby') {
      headTop = unitDoorFlush(mb, dF, host, doorW * 0.5, dh + 0.24, MAT_INTERIOR, false);
    } else {
      headTop = unitDoorFlush(mb, dF, host, doorW * 0.5, dh, st.glass, doorMode === 'solid');
    }
    if (glazTop - headTop > 0.15) {
      applyMat(mb, st.glass);
      rect(mb, F, dL, dR, headTop, glazTop, 0.05);
    }
  }

  // The house number, on the jamb the door opens beside.
  if (wantDoor && o.house) {
    numberPlate(mb, F, host, clamp(doorU + doorW * 0.5 + 0.28, uL + 0.18, uR - 0.18));
  }

  // Rolling shutter, and the awning.
  if (rShut < st.shut) {
    appendSecurityShutter(mb, fx(F, (uL + uR) * 0.5, 0), F.y, fz(F, (uL + uR) * 0.5, 0), F.yaw,
      Math.min(inner, 7.0), glazTop, host, { closed: kind === 'vacant' && rShut < st.shut * 0.5 });
  }
  if (o.awning !== false && rAwn < st.awn && inner > 2.4) {
    const aw = Math.min(inner - 0.2, 5.2);
    const uc = (uL + uR) * 0.5;
    appendAwning(mb, R, fx(F, uc, 0), F.y + glazTop - 0.10, fz(F, uc, 0), F.yaw, aw, 1.30,
      host, o);
  }
  // A vacant unit gets its leasing board across the glass, which is the single loudest signal
  // that a block is not doing well and is all over the real Queen West.
  if (kind === 'vacant') {
    applyMat(mb, MAT_BOARD);
    const bw = Math.min(inner * 0.42, 1.5);
    rect(mb, F, uL + 0.2, uL + 0.2 + bw, glazBot + 0.6, glazBot + 1.5, 0.09);
  }
  return vcount(mb) - before;
}

/**
 * A CORNER ENTRANCE: the splayed door across the angle where two street-facing elevations meet.
 * Every proper corner building in Toronto has one and this city had none, which is a large part
 * of why its intersections read as four blank quoins.
 *
 * (x, y, z) is the corner point of the footprint at sidewalk level; `yawA` and `yawB` are the
 * outward yaws of the two elevations that meet there. The splay stands PROUD of the corner
 * rather than being cut into it — the extrusion behind is solid and cannot be cut (see the
 * header) — so what it reads as is a chamfered entrance bay built onto the angle, which is
 * exactly what most of them are.
 *
 * opts: as appendUnitFront, plus { width } for the splay face (default 2.6 m).
 * Cost: ~150 verts at FULL, 18 at FACADE_LOD.COARSE. @returns {number} vertices appended
 */
export function appendCornerEntrance(mb, rng, x, y, z, yawA, yawB, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  if (!isNum(yawA) || !isNum(yawB)) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const host = readHost(mb, o.mat || mat);
  const H = clamp(isNum(height) ? height : 4.4, 2.6, 9.0);

  // The bisector of the two outward normals. Two nearly opposite elevations do not make a corner.
  const ax = Math.cos(yawA), az = -Math.sin(yawA);
  const bx = Math.cos(yawB), bz = -Math.sin(yawB);
  let nx = ax + bx, nz = az + bz;
  const l = Math.hypot(nx, nz);
  if (!(l > 0.35)) return 0;
  nx /= l; nz /= l;
  // The frame whose OUTWARD direction is the bisector. This file's convention is
  // outward = (cos yaw, 0, -sin yaw), so yaw = atan2(-nz, nx); getting the sign wrong here
  // mirrors the whole splay and every face on it ends up wound into the building.
  const yaw = Math.atan2(-nz, nx);
  const cw = clamp(isNum(o.width) ? o.width : 2.6, 1.4, 4.2);

  // Stand the splay face far enough out that its ENDS clear both walls: at half-angle t the end
  // at u = cw/2 pokes cw/2 * sin(t) through the wall it is nearest, so the face is pushed out by
  // that much plus a skin. Nothing is left buried and nothing is left floating.
  const cosT = clamp(nx * ax + nz * az, 0, 1);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const out = cw * 0.5 * sinT + 0.06;
  const px = x + nx * out, pz = z + nz * out;
  const F = frameAt(px, y, pz, yaw);

  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.96, 0.58);
    rect(mb, F, -cw * 0.5, cw * 0.5, 0, H, SKIN);
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, -cw * 0.5 + 0.16, cw * 0.5 - 0.16, 0.05, H - 0.9, SKIN + 0.02);
    return vcount(mb) - before;
  }

  const hw = cw * 0.5;
  // The two returns back to the walls, so the splay is a solid bay rather than a floating plate.
  applyHost(mb, host, 0.96, 0.58);
  slab(mb, F, -hw - 0.16, -hw, 0, H, -out - 0.4, SKIN, F_OUT | F_ENDS | F_TOP);
  slab(mb, F, hw, hw + 0.16, 0, H, -out - 0.4, SKIN, F_OUT | F_ENDS | F_TOP);
  // The head over the whole bay, and the soffit under it.
  slab(mb, F, -hw - 0.16, hw + 0.16, H - 0.34, H, -out - 0.4, SKIN + 0.02,
    F_OUT | F_TOP | F_BOT | F_ENDS);

  const st = unitStyle(typeof o.kind === 'string' ? o.kind : 'goods');
  const R = fallbackRng(px, pz, 83);
  const dh = clamp(2.56 + R() * 0.2, 2.4, H - 0.5);
  applyHost(mb, host, 0.74, 0.70);
  slab(mb, F, -hw, hw, 0, 0.30, SKIN, 0.09, F_OUT | F_TOP);
  unitDoorRecess(mb, F, R, host, Math.min(hw - 0.14, 1.15), dh, st.glass);
  if (H - 0.34 - dh - 0.18 > 0.12) {
    applyMat(mb, st.glass);
    rect(mb, F, -hw + 0.10, hw - 0.10, dh + 0.18, H - 0.34, 0.05);
  }
  return vcount(mb) - before;
}
