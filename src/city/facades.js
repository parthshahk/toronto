// src/city/facades.js — STREET LEVEL. What a building does where it meets the pavement:
// entrances (revolving, double, shopfront, service), shopfronts with their bulkheads, mullions,
// fascias and lit interiors, awnings, entrance canopies, and appendGroundFloor(), the composite
// that picks and places the lot for one frontage.
//
// CONTRACT.md §6.2. The (u, v, d) frame, yaw, the materials, the LOD contract, the "the wall at
// d = 0 is solid and cannot be cut" rule and the two vertex invariants are documented once, in
// ./facadekit.js. Read that first.
//
// Nothing here creates a Mesh and nothing here reads data/toronto.json — city.js decides WHERE
// these go, this file decides WHAT they look like. Each export returns the number of vertices it
// appended.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import {
  AWNING_COLS, BAY_TARGET, BULKHEAD_H, DOOR_H, FACADE_LOD, F_BOT, F_ENDS, F_LEFT, F_OUT,
  F_RIGHT, F_SHELL, F_TOP, LEAF_W, MAT_GLASS, MAT_GLASS_LIT, MAT_INTERIOR, MAT_METAL_DARK,
  MAT_METAL_PALE, MAT_SIGN_LIT, MAT_STEEL, MAT_VALANCE, MULLION_D, MULLION_W, RECESS_D, SKIN,
  TAU, applyHost, applyMat, drumArc, drumCap, frameAt, fx, fz, lodOf, planeBoth, quad, readHost,
  rect, rngOf, slab, tri3, vcount,
} from './facadekit.js';

// A door leaf: the leaf panel, its glazing standing proud of it (an opaque renderer cannot see
// glass set BEHIND a frame, so the frame is the plate and the pane sits in front of it, which
// leaves the frame reading as a 90 mm margin all round), and a pull bar. 18 verts.
export function doorLeaf(mb, F, u0, u1, v0, v1, d, glassMat) {
  if (u1 - u0 < 0.24 || v1 - v0 < 0.6) return;
  applyMat(mb, MAT_METAL_DARK);
  rect(mb, F, u0, u1, v0, v1, d);
  applyMat(mb, glassMat);
  rect(mb, F, u0 + 0.09, u1 - 0.09, v0 + 0.13, v1 - 0.10, d + 0.026);
  applyMat(mb, MAT_METAL_PALE);
  rect(mb, F, u0 + 0.11, u1 - 0.11, v0 + 0.99, v0 + 1.07, d + 0.058);
}

// The surround: two jambs and a head, all projecting `proj` out of the wall so the opening they
// frame reads as a reveal rather than a decal. The jambs' inward faces and the head's underside
// ARE the reveal. The jambs run the full height so the head needs no end caps, and BOTH sides of
// each jamb are emitted — the outer one is what you see walking along the wall, and leaving it
// off puts a culled hole in the portal at exactly the angle a pedestrian approaches it from.
// 54 verts.
export function surround(mb, F, host, hw, h, proj, jambW) {
  applyHost(mb, host, 1.06, 0.50);
  slab(mb, F, -hw - jambW, -hw, 0, h + 0.18, SKIN, proj, F_OUT | F_RIGHT | F_LEFT);
  slab(mb, F, hw, hw + jambW, 0, h + 0.18, SKIN, proj, F_OUT | F_LEFT | F_RIGHT);
  slab(mb, F, -hw, hw, h, h + 0.18, SKIN, proj, F_OUT | F_BOT | F_TOP);
}

// The threshold: a shallow step carrying the doorway out onto the sidewalk. Sunk 20 mm so it
// never floats over a terrain that is sampled somewhere else. 24 verts.
function threshold(mb, F, host, hw, proj) {
  applyHost(mb, host, 0.88, 0.72);
  slab(mb, F, -hw - 0.20, hw + 0.20, -0.02, 0.055, -0.05, proj + 0.22, F_OUT | F_TOP | F_ENDS);
}

// Office towers: a revolving drum with vanes, flanked by a hinged leaf each side. 219 verts.
//
// The drum is set INTO the facade: its axis stands only 0.3 of a radius off the wall, so what
// projects is the front 215 degrees of it — a 1.2 m bulge, which a 3.8 m sidewalk can carry —
// and the arc is cut exactly where the cylinder meets the wall plane, so not one triangle is
// emitted inside the building. A full drum standing clear of the wall would project 2 m onto the
// pavement AND bury a third of itself in masonry.
function entRevolving(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 1.3, 3.6);
  const h = 3.05;
  const proj = 0.62;
  surround(mb, F, host, hw, h, proj, 0.26);
  threshold(mb, F, host, hw, proj);

  // A real revolving door is 1.7-2.4 m across; the radius follows the opening inside that.
  const r = clamp(hw * 0.42, 0.80, 1.15);
  const dc = r * 0.30;
  // Where the drum crosses SKIN rather than the wall plane itself, so not one vertex of the arc
  // lands coplanar with the extrusion it is set into.
  const cut = Math.acos(clamp((SKIN - dc) / r, -1, 1));
  const vTop = 2.42;
  applyMat(mb, MAT_GLASS_LIT);
  drumArc(mb, F, 0, dc, r, -0.02, vTop, -cut, cut, 7);
  applyMat(mb, MAT_METAL_PALE);
  drumCap(mb, F, 0, dc, r + 0.05, vTop + 0.02, -cut, cut, 7);

  // Three vanes on a random phase, so a row of towers does not line up. Any vane that would
  // swing back through the wall is shortened to stop at it.
  const phase = rng() * (TAU / 3);
  applyMat(mb, MAT_GLASS);
  for (let i = 0; i < 3; i++) {
    const a = phase + (i / 3) * TAU;
    const ca = Math.cos(a);
    let len = r - 0.05;
    if (ca < -1e-3 && dc + len * ca < SKIN) len = Math.max(0, (SKIN - dc) / ca);
    if (len < 0.12) continue;
    const ue = Math.sin(a) * len;
    const de = dc + ca * len;
    planeBoth(mb, F, 0, 0.10, dc, ue, 0.10, de, ue, vTop - 0.06, de, 0, vTop - 0.06, dc);
  }

  // Flanking leaves, hard against the jambs.
  const lw = Math.min(LEAF_W, Math.max(0.5, hw - r - 0.24));
  if (lw > 0.5) {
    doorLeaf(mb, F, -hw + 0.06, -hw + 0.06 + lw, 0.05, 0.05 + DOOR_H, 0.05, MAT_GLASS_LIT);
    doorLeaf(mb, F, hw - 0.06 - lw, hw - 0.06, 0.05, 0.05 + DOOR_H, 0.05, MAT_GLASS_LIT);
  }
  // Transom over the whole opening, above the drum.
  applyMat(mb, MAT_GLASS_LIT);
  rect(mb, F, -hw + 0.04, hw - 0.04, vTop + 0.12, h - 0.06, 0.03);
}

// Residential and civic lobbies: a glazed double door with sidelights and a transom. ~144 verts.
function entDouble(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.95, 2.6);
  const h = 2.86;
  const proj = 0.42;
  surround(mb, F, host, hw, h, proj, 0.22);
  threshold(mb, F, host, hw, proj);

  const lw = Math.min(LEAF_W, hw - 0.10);
  const side = Math.max(0, hw - 0.06 - lw);
  applyMat(mb, MAT_INTERIOR);
  rect(mb, F, -hw + 0.04, hw - 0.04, 0.05, h - 0.06, 0.02);
  doorLeaf(mb, F, -lw, 0, 0.05, 0.05 + DOOR_H, 0.06, MAT_GLASS_LIT);
  doorLeaf(mb, F, 0, lw, 0.05, 0.05 + DOOR_H, 0.06, MAT_GLASS_LIT);
  if (side > 0.18) {
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, -hw + 0.06, -hw + 0.06 + side, 0.05, 0.05 + DOOR_H, 0.06);
    rect(mb, F, hw - 0.06 - side, hw - 0.06, 0.05, 0.05 + DOOR_H, 0.06);
  }
  // Transom bar and light over the pair.
  applyMat(mb, MAT_METAL_DARK);
  slab(mb, F, -hw + 0.04, hw - 0.04, 0.05 + DOOR_H, 0.16 + DOOR_H, 0.03, 0.11, F_OUT | F_BOT);
  applyMat(mb, rng() < 0.5 ? MAT_VALANCE : MAT_GLASS_LIT);
  rect(mb, F, -hw + 0.06, hw - 0.06, 0.18 + DOOR_H, h - 0.08, 0.04);
}

// Retail: a recessed single or double leaf under a projecting surround, with a genuine interior
// plane at the back of the cavity. 102 verts. Returns the top of its head, so a shopfront can
// glaze the strip between the entry and its own transom line.
function entShopfront(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.6, 2.4);
  const h = clamp(2.55 + rng() * 0.25, 2.4, 2.9);
  const proj = RECESS_D;
  surround(mb, F, host, hw, h, proj, 0.18);
  // The floor of the recess, tiled out to the sidewalk.
  applyHost(mb, host, 0.80, 0.70);
  slab(mb, F, -hw, hw, -0.02, 0.045, -0.02, proj + 0.14, F_OUT | F_TOP);
  // Interior: the plane you actually see through the doors and over them.
  applyMat(mb, MAT_INTERIOR);
  rect(mb, F, -hw + 0.02, hw - 0.02, 0.045, h - 0.04, 0.03);
  const twin = hw > 1.05;
  const lw = twin ? Math.min(LEAF_W, hw - 0.10) : Math.min(1.05, hw * 2 - 0.14);
  if (twin) {
    doorLeaf(mb, F, -lw, 0, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
    doorLeaf(mb, F, 0, lw, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  } else {
    doorLeaf(mb, F, -lw * 0.5, lw * 0.5, 0.045, 0.045 + DOOR_H, 0.07, MAT_GLASS_LIT);
  }
  // A downlight in the soffit of the recess.
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.25, hw - 0.25, h - 0.09, h - 0.05, proj * 0.35, proj * 0.75, F_BOT);
  return h + 0.18;
}

// Envelope, industrial and rear elevations: a flush steel door in a pressed frame, one step, a
// bulkhead lamp over it. ~96 verts.
function entService(mb, F, rng, host, width) {
  const hw = clamp(width * 0.5, 0.5, 1.35);
  const h = 2.32;
  applyHost(mb, host, 0.92, 0.62);
  slab(mb, F, -hw - 0.13, -hw, 0, h + 0.13, SKIN, 0.14, F_OUT | F_RIGHT);
  slab(mb, F, hw, hw + 0.13, 0, h + 0.13, SKIN, 0.14, F_OUT | F_LEFT);
  slab(mb, F, -hw - 0.13, hw + 0.13, h, h + 0.13, SKIN, 0.14, F_OUT | F_BOT | F_TOP);
  applyHost(mb, host, 0.78, 0.72);
  slab(mb, F, -hw - 0.06, hw + 0.06, -0.02, 0.06, -0.03, 0.30, F_OUT | F_TOP | F_ENDS);
  // The leaf: painted steel, one vision panel, a kick plate.
  applyMat(mb, MAT_STEEL);
  rect(mb, F, -hw, hw, 0.05, h - 0.01, 0.045);
  applyMat(mb, MAT_GLASS);
  rect(mb, F, -hw * 0.45, hw * 0.45, h - 0.72, h - 0.20, 0.07);
  applyMat(mb, MAT_METAL_PALE);
  rect(mb, F, -hw + 0.06, hw - 0.06, 0.10, 0.34, 0.07);
  // Bulkhead lamp: a genuine emitter, on about two thirds of service doors.
  if (rng() < 0.66) {
    applyMat(mb, MAT_VALANCE);
    slab(mb, F, -0.16, 0.16, h + 0.20, h + 0.36, 0.06, 0.24, F_OUT | F_BOT | F_ENDS);
  }
}

// COARSE: the opening as two flat faces — the surround's outward plane in the host's own stone,
// and the glazing (or the steel leaf) inside it. Every style draws exactly ONE random value, the
// same as its FULL counterpart, so a caller sharing one rng stream across a tile gets the same
// stream whichever level it asked for. 12 verts against 96-219.
//
// Nothing projects. At the range COARSE is for, the 0.42-0.72 m reveal these builders model is
// under a pixel deep, and a flat panel at SKIN cannot self-shadow, cannot z-fight and cannot
// leave a back-facing hole where a one-sided slab used to be. Returns the head height, as
// entShopfront does, so appendShopfront can glaze above it. 12 verts against 108-222.
function entCoarse(mb, F, rng, host, width, style, base) {
  // Drawn first and unconditionally, exactly as every FULL style draws exactly one value. The
  // shopfront style is the one that USES it — its head height is random — so taking it here
  // keeps both the stream and the head line identical between levels.
  const rv = rng();
  const d0 = isNum(base) ? Math.max(base, SKIN) : SKIN;
  let hw, h, j, glass;
  if (style === 'revolving') {
    hw = clamp(width * 0.5, 1.3, 3.6); h = 3.05; j = 0.26; glass = MAT_GLASS_LIT;
  } else if (style === 'shopfront') {
    hw = clamp(width * 0.5, 0.6, 2.4); h = clamp(2.55 + rv * 0.25, 2.4, 2.9);
    j = 0.18; glass = MAT_INTERIOR;
  } else if (style === 'service') {
    hw = clamp(width * 0.5, 0.5, 1.35); h = 2.32; j = 0.13; glass = MAT_STEEL;
  } else {
    hw = clamp(width * 0.5, 0.95, 2.6); h = 2.86; j = 0.22; glass = MAT_GLASS_LIT;
  }
  applyHost(mb, host, 1.06, 0.50);
  rect(mb, F, -hw - j, hw + j, 0, h + 0.18, d0);
  applyMat(mb, glass);
  rect(mb, F, -hw, hw, 0.05, h - 0.05, d0 + 0.02);
  return h + 0.18;
}

/**
 * A building entrance. `yaw` faces out of the facade; (x, y, z) is the wall point at the CENTRE
 * of the opening, at sidewalk level. `width` is the clear opening — the surround projects and
 * extends ~0.2 m beyond it each side.
 *
 * style: 'revolving' office tower drum + flanking leaves (~213 verts)
 *        'double'    glazed residential/civic lobby pair (~144 verts)
 *        'shopfront' recessed retail entry with an interior plane (~132 verts)
 *        'service'   flush steel door, step and bulkhead lamp (~96 verts)
 *
 * opts: { lod } — FACADE_LOD.COARSE flattens every style to 12 verts. See the LOD block above.
 *
 * @param {MeshBuilder} mb
 * @param {function} rng seeded 0..1 generator; a deterministic positional fallback is used if absent
 * @param {number[]} [mat] host wall material [r,g,b,emissive,tintable,rough,profile]
 * @param {object} [opts]
 * @returns {number} vertices appended
 */
export function appendEntrance(mb, rng, x, y, z, yaw, width, style, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = clamp(isNum(width) ? width : 2.2, 1.0, 8.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 7);
  const host = readHost(mb, mat);
  if (lodOf(opts) === FACADE_LOD.COARSE) entCoarse(mb, F, R, host, w, style);
  else if (style === 'revolving') entRevolving(mb, F, R, host, w);
  else if (style === 'shopfront') entShopfront(mb, F, R, host, w);
  else if (style === 'service') entService(mb, F, R, host, w);
  else entDouble(mb, F, R, host, w);
  return vcount(mb) - before;
}

/**
 * A retail ground floor: stall riser, pilasters, full-height glazing in bays, a lit valance, a
 * fascia sign band and one recessed entry. This is the single biggest win for street-level
 * believability, and it is what goes on every profile-3 frontage.
 *
 * (x, y, z) is the wall point at the CENTRE of the frontage, at sidewalk level. `height` is the
 * shopfront zone, floor to the top of the fascia — typically 4.2-5.6 m.
 *
 * opts: { door: boolean (default true), sign: boolean, lit: boolean, bay: number, lod }
 * Cost: ~62 verts per bay plus ~66 fixed, ~200 for a 12 m three-bay frontage with a door.
 * At FACADE_LOD.COARSE: 18-36 verts whatever the frontage, because the bays go away.
 *
 * @returns {number} vertices appended
 */
export function appendShopfront(mb, rng, x, y, z, yaw, width, height, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.6) return 0;
  const H = clamp(isNum(height) ? height : 4.6, 2.8, 8.0);
  const o = opts || {};
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 13);
  const host = readHost(mb, mat);

  // Draw every random value up front and in a fixed order, so a branch never shifts the stream.
  const rBays = R();
  const rDoor = R();
  const rSign = R();
  const rLitSign = R();

  const hw = w * 0.5;
  const signH = clamp(H * 0.17, 0.52, 0.95);
  const headH = 0.12;
  const glazTop = H - signH - headH;
  const glazBot = BULKHEAD_H;
  if (glazTop - glazBot < 0.9) return 0;

  const target = isNum(o.bay) ? clamp(o.bay, 1.8, 6.0) : BAY_TARGET * lerp(0.9, 1.12, rBays);
  const nBays = clamp(Math.round(w / target), 1, 12);
  const pitch = w / nBays;
  const wantDoor = o.door !== false && w >= 3.2 && pitch >= 1.5;
  const doorBay = wantDoor ? Math.min(nBays - 1, Math.floor(rDoor * nBays)) : -1;
  const wantSign = o.sign !== false && rSign < 0.92;
  const signLit = o.lit !== undefined ? !!o.lit : rLitSign < 0.48;

  // --- COARSE ---------------------------------------------------------------------------------
  // Four flat bands and, where the full version would recess an entry, one dark panel: riser,
  // glazing, head, fascia. The bay rhythm is what goes — at 0.15 m a mullion is a pixel at 117 m
  // and pure aliasing past that — but the DATUM lines survive, and those are what a shopfront
  // reads as from across a block. Same materials, same sign, same lit/unlit decision, and the
  // same number of draws off the rng: the entry consumes one exactly when the full path's
  // entShopfront would have.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 0.74, 0.70);
    rect(mb, F, -hw, hw, 0, glazBot, SKIN);
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, -hw, hw, glazBot, glazTop, SKIN + 0.015);
    applyHost(mb, host, 0.92, 0.60);
    rect(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN);
    if (wantSign) {
      if (signLit) applyMat(mb, MAT_SIGN_LIT); else applyHost(mb, host, 0.58, 0.55);
      rect(mb, F, -hw, hw, H - signH, H, SKIN);
    }
    if (doorBay >= 0) {
      const uc = -hw + (doorBay + 0.5) * pitch;
      const clear = pitch - MULLION_W * 1.2;
      const dF = frameAt(fx(F, uc, 0), F.y, fz(F, uc, 0), F.yaw);
      // In front of the glazing band, because the entry is no longer a cavity that could be
      // seen INTO — flat geometry has to be layered, and 0.03 m is under a tenth of a pixel at
      // the range this level is for while being ten times the depth buffer's resolution there.
      entCoarse(mb, dF, R, host, clear, 'shopfront', SKIN + 0.03);
    }
    return vcount(mb) - before;
  }

  // --- stall riser, split around the entry so the recess floor is not blocked ---------------
  applyHost(mb, host, 0.74, 0.70);
  if (doorBay < 0) {
    slab(mb, F, -hw, hw, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP);
  } else {
    const dL = -hw + doorBay * pitch;
    const dR = dL + pitch;
    if (dL + hw > 0.12) slab(mb, F, -hw, dL, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP | F_RIGHT);
    if (hw - dR > 0.12) slab(mb, F, dR, hw, 0, BULKHEAD_H, SKIN, 0.10, F_OUT | F_TOP | F_LEFT);
  }

  // --- pilasters at every bay line, deepened where they frame the entry ----------------------
  for (let i = 0; i <= nBays; i++) {
    const uc = -hw + i * pitch;
    const isDoorJamb = doorBay >= 0 && (i === doorBay || i === doorBay + 1);
    const proj = isDoorJamb ? RECESS_D : MULLION_D;
    const half = (i === 0 || i === nBays) ? MULLION_W * 1.3 : MULLION_W * 0.5;
    const u0 = (i === 0) ? uc : uc - half;
    const u1 = (i === nBays) ? uc : uc + half;
    applyHost(mb, host, i === 0 || i === nBays ? 1.0 : 0.86, 0.55);
    slab(mb, F, u0, u1, 0, glazTop + 0.06, SKIN, proj, F_OUT | F_LEFT | F_RIGHT);
  }

  // --- glazing, one pane per bay, with the transom bar that gives a shopfront its datum -------
  // The bar is what stops a 3 x 3.3 m sheet of glass reading as a hole: it sits at door-head
  // height, which is the line every real shopfront on Queen West shares.
  const transom = glazTop - glazBot > 2.6 ? glazBot + (glazTop - glazBot) * 0.72 : 0;
  for (let i = 0; i < nBays; i++) {
    if (i === doorBay) continue;
    const u0 = -hw + i * pitch + MULLION_W * 0.6;
    const u1 = -hw + (i + 1) * pitch - MULLION_W * 0.6;
    applyMat(mb, MAT_GLASS_LIT);
    rect(mb, F, u0, u1, glazBot, glazTop, 0.05);
    if (transom > 0) {
      applyMat(mb, MAT_METAL_DARK);
      rect(mb, F, u0, u1, transom - 0.045, transom + 0.045, 0.085);
    }
  }

  // --- head, concealed valance strip, fascia sign -------------------------------------------
  applyHost(mb, host, 0.92, 0.60);
  slab(mb, F, -hw, hw, glazTop, glazTop + headH, SKIN, 0.16, F_OUT | F_BOT);
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.2, hw - 0.2, glazTop - 0.03, glazTop + 0.01, 0.07, 0.15, F_BOT);
  if (wantSign) {
    if (signLit) applyMat(mb, MAT_SIGN_LIT); else applyHost(mb, host, 0.58, 0.55);
    slab(mb, F, -hw, hw, H - signH, H, SKIN, 0.21, F_OUT | F_TOP | F_BOT);
  }

  // --- the entry, and the transom that glazes the gap between its head and the head band ------
  if (doorBay >= 0) {
    const uc = -hw + (doorBay + 0.5) * pitch;
    const clear = pitch - MULLION_W * 1.2;
    const dF = frameAt(fx(F, uc, 0), F.y, fz(F, uc, 0), F.yaw);
    const headTop = entShopfront(mb, dF, R, host, clear);
    if (glazTop - headTop > 0.15) {
      applyMat(mb, MAT_GLASS_LIT);
      rect(mb, F, uc - clear * 0.5, uc + clear * 0.5, headTop, glazTop, 0.05);
    }
  }
  return vcount(mb) - before;
}

/**
 * A fabric awning over a shopfront bay: sloped top, valance, gores at each end. (x, y, z) is the
 * wall point at the TOP fixing; the front bar sits `depth` out and 0.55 m lower.
 * opts: { ends: boolean (default true), lod }
 * Cost: 30 verts, 12 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendAwning(mb, rng, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.8) return 0;
  const dp = clamp(isNum(depth) ? depth : 1.3, 0.5, 3.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 17);
  const o = opts || {};
  const hw = w * 0.5;
  const drop = clamp(dp * 0.42, 0.22, 0.75);
  const val = 0.30;
  const col = AWNING_COLS[Math.min(AWNING_COLS.length - 1, (R() * AWNING_COLS.length) | 0)];
  const rough = 0.90;

  // COARSE: the sloped sheet and its underside. The valance and the end gores are 0.3 m and
  // 0.1 m2 of fabric — under a pixel at the range this level is for — but the awning's own
  // colour and the shade it throws on the shopfront behind it are the whole point of it, and
  // both of those are carried by these two faces.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
    quad(mb, F, -hw, -drop, dp, hw, -drop, dp, hw, 0, SKIN, -hw, 0, SKIN);
    mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
    quad(mb, F, -hw, 0, SKIN, hw, 0, SKIN, hw, -drop, dp, -hw, -drop, dp);
    return vcount(mb) - before;
  }

  mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
  // Top surface, wall high, front bar low. Wound so the normal points up and out.
  quad(mb, F, -hw, -drop, dp, hw, -drop, dp, hw, 0, SKIN, -hw, 0, SKIN);
  // Underside — a shade darker, because the whole reason an awning reads is its shadow.
  mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
  quad(mb, F, -hw, 0, SKIN, hw, 0, SKIN, hw, -drop, dp, -hw, -drop, dp);
  // Valance hanging off the front bar, front and back.
  mb.color(col[0], col[1], col[2], 0, 0, rough, 0);
  rect(mb, F, -hw, hw, -drop - val, -drop, dp);
  mb.color(col[0] * 0.45, col[1] * 0.45, col[2] * 0.45, 0, 0, rough, 0);
  quad(mb, F, hw, -drop - val, dp - 0.02, -hw, -drop - val, dp - 0.02, -hw, -drop, dp - 0.02, hw, -drop, dp - 0.02);
  // End gores.
  if (o.ends !== false) {
    mb.color(col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, 0, 0, rough, 0);
    tri3(mb, F, hw, 0, SKIN, hw, -drop, dp, hw, -drop - val, dp);
    tri3(mb, F, -hw, 0, SKIN, -hw, -drop - val, dp, -hw, -drop, dp);
  }
  return vcount(mb) - before;
}

/**
 * A rigid entrance canopy: a cantilevered slab with a lit soffit, hung on two tie rods.
 * (x, y, z) is the wall point at the canopy's UNDERSIDE.
 * opts: { rods: boolean (default true), lod }
 * Cost: 60 verts, 72 with a third tie rod. 30 at FACADE_LOD.COARSE.
 * @returns {number} vertices appended
 */
export function appendCanopy(mb, rng, x, y, z, yaw, width, depth, mat, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 0.8) return 0;
  const dp = clamp(isNum(depth) ? depth : 2.0, 0.6, 5.0);
  const before = vcount(mb);
  const F = frameAt(x, y, z, yaw);
  const R = rngOf(rng, x, z, 19);
  const o = opts || {};
  const host = readHost(mb, mat);
  const hw = w * 0.5;
  const t = clamp(dp * 0.11, 0.16, 0.34);

  // COARSE: one closed slab. The 70 mm tie rods and the strip light in the soffit are the two
  // things that go; the projecting deck, which is the whole silhouette and the whole shadow, is
  // exactly what it was. The rng is drawn under precisely the same condition as below, so the
  // stream does not move.
  if (lodOf(o) === FACADE_LOD.COARSE) {
    applyHost(mb, host, 1.02, 0.55);
    slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_SHELL);
    if (o.rods !== false && dp > 0.9 && w > 6.0) R();
    return vcount(mb) - before;
  }

  applyHost(mb, host, 1.02, 0.55);
  slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_SHELL & ~F_BOT);
  // Soffit: a separate darker plate so the underside reads as shade even with SSAO off.
  applyHost(mb, host, 0.42, 0.70);
  slab(mb, F, -hw, hw, 0, t, SKIN, dp, F_BOT);
  // Downlights in the soffit.
  applyMat(mb, MAT_VALANCE);
  slab(mb, F, -hw + 0.35, hw - 0.35, -0.012, 0.002, dp * 0.30, dp * 0.72, F_BOT);
  // Tie rods back to the wall, unless the caller wants a bare cantilever. A wide canopy carries
  // a third rod on the centre line about half the time — enough to break up a row of identical
  // entrances without changing what any of them is.
  if (o.rods !== false && dp > 0.9) {
    applyMat(mb, MAT_METAL_PALE);
    const rise = clamp(dp * 0.85, 0.8, 2.2);
    const ur = Math.max(0.2, hw - 0.30);
    const mid = w > 6.0 && R() < 0.5;
    for (let i = 0; i < 3; i++) {
      if (i === 2 && !mid) continue;
      const u = i === 0 ? -ur : (i === 1 ? ur : 0);
      planeBoth(mb, F,
        u - 0.035, t, dp - 0.14,
        u + 0.035, t, dp - 0.14,
        u + 0.035, t + rise, 0.04,
        u - 0.035, t + rise, 0.04);
    }
  }
  return vcount(mb) - before;
}

/**
 * The entrance style a building's lighting profile calls for (CONTRACT.md §6.2).
 *   0 envelope -> service   1 office -> revolving (double if it is too small for a drum)
 *   2 residential -> double 3 retail -> shopfront 4 parking -> service 5 civic -> double
 * @param {number} profile city.js lighting profile 0-5
 * @param {number} height building height in metres
 * @returns {string} 'revolving' | 'double' | 'shopfront' | 'service'
 */
export function entranceStyleFor(profile, height) {
  const p = (isNum(profile) ? profile : -1) | 0;
  const h = isNum(height) ? height : 0;
  if (p === 3) return 'shopfront';
  if (p === 0 || p === 4) return 'service';
  if (p === 1) return h >= 34 ? 'revolving' : 'double';
  if (p === 2) return h >= 90 ? 'revolving' : 'double';
  if (p === 5) return 'double';
  return h >= 34 ? 'revolving' : 'double';
}

/**
 * The whole ground-floor treatment for one street-facing frontage, composed from the builders
 * above and sized by the building's lighting profile. This is what city.js calls per frontage;
 * everything it does can also be done piecemeal.
 *
 * (x, y, z) is the wall point at the CENTRE of the frontage, at sidewalk level; `width` is the
 * available frontage.
 *
 * opts: { profile, height (building height), floorH (ground storey, default 4.6),
 *         retail: force a shopfront, canopy: boolean, awning: boolean, lod }
 *
 * `opts` is passed through UNCHANGED to every builder this composes, so one `lod` on the way in
 * sets the level for the whole frontage. Both levels draw the same values off `rng` in the same
 * order, so a tile that builds its frontages COARSE places exactly the same lamps, trees and
 * parked cars afterwards as one that builds them FULL.
 *
 * Measured cost: 292 verts for retail (12 m frontage), 321 for an office tower, 200 for a condo
 * lobby, 96 for a service elevation — all inside the ~400 budget for one building.
 * At FACADE_LOD.COARSE: 48, 42, 42 and 12.
 * @returns {number} vertices appended
 */
export function appendGroundFloor(mb, rng, x, y, z, yaw, width, opts) {
  if (!mb || !isNum(x) || !isNum(y) || !isNum(z)) return 0;
  const w = isNum(width) ? width : 0;
  if (w < 1.2) return 0;
  const o = opts || {};
  const before = vcount(mb);
  const R = rngOf(rng, x, z, 29);
  const host = readHost(mb, o.mat);
  const profile = isNum(o.profile) ? (o.profile | 0) : 3;
  const bh = isNum(o.height) ? o.height : 20;
  const floorH = clamp(isNum(o.floorH) ? o.floorH : 4.6, 2.8, 8.0);
  let style = typeof o.style === 'string' ? o.style : entranceStyleFor(profile, bh);
  // A drum plus its flanking leaves needs about 4 m of wall. On a narrower frontage — a tower on
  // a corner sliver, or a side elevation — it would hang off both ends of the building, so the
  // lobby falls back to a glazed pair.
  if (style === 'revolving' && w < 4.2) style = 'double';
  const rAwn = R();

  if ((profile === 3 || o.retail) && w >= 4.0 && style !== 'service') {
    appendShopfront(mb, R, x, y, z, yaw, w, floorH, host, o);
    if (o.awning !== false && rAwn < 0.45) {
      const F = frameAt(x, y, z, yaw);
      const aw = Math.min(w * 0.42, 4.2);
      const uc = -w * 0.5 + aw * 0.5 + 0.2;
      appendAwning(mb, R, fx(F, uc, 0), y + floorH - clamp(floorH * 0.17, 0.52, 0.95) - 0.16,
        fz(F, uc, 0), yaw, aw, 1.25, host, o);
    }
    return vcount(mb) - before;
  }

  // The opening is sized by the frontage and then held inside it, surround included, so nothing
  // ever overhangs the end of the wall it was placed on.
  const raw = style === 'revolving' ? clamp(w * 0.30, 3.0, 5.4)
    : (style === 'service' ? clamp(w * 0.22, 1.1, 2.0) : clamp(w * 0.26, 1.9, 3.4));
  const doorW = Math.max(1.0, Math.min(raw, w - 0.7));
  appendEntrance(mb, R, x, y, z, yaw, doorW, style, host, o);
  if (o.canopy !== false && (style === 'revolving' || style === 'double') && w >= 4.0) {
    appendCanopy(mb, R, x, y + floorH * 0.78, z, yaw, Math.min(doorW + 1.5, w),
      style === 'revolving' ? 2.4 : 1.8, host, o);
  }
  return vcount(mb) - before;
}
