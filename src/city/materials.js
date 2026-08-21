// src/city/materials.js — THE material palette, and the rules that pick one for a facade.
//
// CONTRACT.md Amendment 11.1. Split out of city.js unchanged: every colour, every roughness and
// every threshold below is the value the city already renders with, and none of it may drift.
//
// Entry layout is [r, g, b, emissive, tintable, rough, profile]; a missing 7th entry means 0.
// Colours are LINEAR-ISH SCENE ALBEDO, never a lit colour — CONTRACT §7.1. The renderer owns
// exposure, the grade, and when an emitter is on. `tintable` is 0 on all static city geometry.
//
// Three things live here and nothing else does:
//   1. M           the palette itself, read by world/, city/ and the tile builders alike.
//   2. nightAlbedo the sRGB-tag -> scene-albedo remap that makes a surveyed building:colour
//                  usable at blue hour without blowing out or vanishing.
//   3. facadeMaterial / roofMaterial / pickClass — how a building record becomes a material.
//
// Depends on core only. Nothing here knows about tiles, meshes or the loader.

import { clamp, lerp, smoothstep } from '../core/math.js';
import { isNum, hashPos } from '../core/util.js';

/* ============================================================== materials == */
// Colours are linear-ish scene albedo; the renderer owns exposure and grade. Ground cover stays
// cool and desaturated (CONTRACT §0); the FACADES do not — see the palette section below.
// Entry layout: [r, g, b, emissive, tintable, rough, profile]. A missing 7th entry means 0.

const M = {
  terrain: [0.050, 0.052, 0.058, 0, 0, 0.93],
  grass: [0.036, 0.058, 0.040, 0, 0, 0.95],
  park: [0.032, 0.052, 0.037, 0, 0, 0.95],
  asphalt: [0.028, 0.030, 0.036, 0, 0, 0.18],
  highway: [0.024, 0.026, 0.032, 0, 0, 0.16],
  service: [0.032, 0.033, 0.038, 0, 0, 0.26],
  parking: [0.034, 0.035, 0.040, 0, 0, 0.24],
  sidewalk: [0.078, 0.080, 0.088, 0, 0, 0.72],
  path: [0.066, 0.067, 0.073, 0, 0, 0.78],
  curb: [0.062, 0.063, 0.070, 0, 0, 0.70],
  pier: [0.062, 0.052, 0.044, 0, 0, 0.80],
  water: [0.008, 0.014, 0.024, 0, 0, 0.03],
  ballast: [0.052, 0.050, 0.048, 0, 0, 0.95],
  // Broken armour stone. Darker and rougher than the terrain it clads, wet at the toe, and the
  // one material every synthesised land/water edge in the world is finished in.
  riprap: [0.044, 0.044, 0.047, 0, 0, 0.88],
  tie: [0.040, 0.034, 0.030, 0, 0, 0.90],
  rail: [0.105, 0.108, 0.115, 0, 0, 0.25],
  roof: [0.046, 0.047, 0.050, 0, 0, 0.90],
  bridge: [0.072, 0.073, 0.076, 0, 0, 0.55],
  // Teamway liner. A road tunnel under a building is finished in white glazed tile or painted
  // concrete for exactly one reason — to give the light something to come back off — so its
  // reflectance is genuinely several times a bridge girder's. A physical constant, not a
  // brightening: it reads as pale concrete at noon and is what makes the tunnel legible at night.
  tunnel: [0.150, 0.152, 0.150, 0, 0, 0.66],
  // Batten luminaire under a tunnel soffit. A real lamp, so the renderer owns when it is lit.
  tunnelLamp: [1.00, 0.93, 0.78, 1.0, 0, 0.55],
  beacon: [1.00, 0.16, 0.10, 1.0, 0, 0.60],

  // --- ground plane: paint, kerb hardware, track ---------------------------
  // Paint is a physical constant like everything else: a bright matte albedo, never an emitter.
  // Thermoplastic sits well above the asphalt it is laid on but nowhere near a lamp.
  paintWhite: [0.168, 0.170, 0.172, 0, 0, 0.78],
  paintYellow: [0.196, 0.146, 0.036, 0, 0, 0.78],
  bikeGreen: [0.030, 0.078, 0.048, 0, 0, 0.70],
  tactile: [0.152, 0.118, 0.036, 0, 0, 0.88],
  trackBed: [0.036, 0.038, 0.043, 0, 0, 0.44],
  wire: [0.058, 0.052, 0.046, 0, 0, 0.38],

  // --- CN Tower ------------------------------------------------------------
  // Profile 0 throughout: the tower has no window grid, it has a lighting rig. Every emissive
  // value here is >= EMITTER_MIN so it can never be mistaken for a facade window hint.
  cnShaft: [0.128, 0.131, 0.137, 0, 0, 0.78, 0],   // pale cool cast concrete
  cnMast: [0.052, 0.055, 0.061, 0, 0, 0.40, 0],    // painted steel antenna mast
  cnLed: [0.120, 0.190, 0.550, 0.62, 0, 0.55, 0],  // LED wash washing up the three ribs
  cnPod: [0.340, 0.440, 0.720, 0.92, 0, 0.09, 0],  // main pod glazing band, 346-356 m
  cnSky: [0.600, 0.690, 0.920, 0.96, 0, 0.09, 0],  // SkyPod band, 437-442 m
};

// Emissive below this is a facade "there are windows here" hint; at or above it the surface is a
// genuine emitter (lamp, beacon, LED band). Profile-0 geometry may only ever use 0 or >= this.
const EMITTER_MIN = 0.50;

// Facade interior-spill hint per lighting profile. Envelopes get exactly zero — that is the whole
// point of profile 0 — and nothing here comes anywhere near EMITTER_MIN.
const PROFILE_EMIS = [0.0, 0.095, 0.070, 0.060, 0.030, 0.040];

// An envelope never gets smooth enough for a renderer to read it as glazing.
const ENVELOPE_MIN_ROUGH = 0.28;
/* ========================================================= mesh emitters == */

function setMat(mb, m) { mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m.length > 6 ? m[6] : 0); }
/* ============================================================== buildings == */

// The old assignment gave every facade one cold grey-blue and one warm window grid, which is
// exactly why the skyline read as procedurally generated wallpaper. What replaces it:
//
//   1. `building:colour` from OSM (730 buildings, 33 distinct values) is REAL surveyed data and
//      beats every heuristic. Royal Bank Plaza really is #ffd600 gold; Scotia Plaza really is a
//      near-black red; First Canadian Place really is white; the TD towers really are black.
//   2. `building:material` picks the material CLASS — its lightness, how much of the tag's
//      saturation survives, and above all its roughness, which is what the eye actually uses to
//      tell brick from curtain wall.
//   3. Everything else falls back to a family chosen from a hash of position AND height AND
//      lighting profile, so neighbours differ and a 40-storey condo never draws warehouse brick.
//
// Tag colours arrive as sRGB. Scene albedo here is linear-ish and deliberately dark — the
// renderer owns exposure at blue hour — so a tag can never be used raw: #ffffff at albedo 1.0
// blows out to a white slab and #290000 at albedo 0.02 disappears into the night. nightAlbedo()
// keeps the tag's HUE (taken from the linear channel ratios, which is where hue actually lives)
// and remaps its LIGHTNESS (taken from perceptual sRGB luma, which is what the surveyor saw)
// into the narrow band the blue-hour grade can show.

const NIGHT_FLOOR = 0.021;      // a black facade still catches skylight; nothing is ever void
const NIGHT_SPAN = 0.225;       // pure white lands near 0.25 — luminous pale grey, not blown out
const NIGHT_GAMMA = 0.80;       // mild lift so dark saturated tags keep their identity
const CHROMA_PEDESTAL = 0.10;   // no channel ever reaches zero; a dead channel reads as a filter
// Blue-hour cast, applied only in proportion to how NEUTRAL a colour ended up. Deliberately
// slight: the renderer's ambient is already strongly blue (0.146, 0.188, 0.268), so a heavy cast
// here double-counts the sky and, worse, cancels the warm tilt of a surveyed limestone or
// champagne-metal tag. Its only job is to keep a dead-neutral grey from reading as studio grey.
const COOL_R = 0.980, COOL_G = 0.996, COOL_B = 1.028;

function srgb8(v) { return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }

function srgbToLinear(c) {
  const v = c <= 0 ? 0 : (c >= 1 ? 1 : c);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// sRGB 0..1 -> scene albedo. `level` scales the lightness band per material, `chroma` compresses
// the tag's saturation (OSM tags lean on CSS colour names, and 'firebrick' is far more saturated
// than any brick that was ever fired).
function nightAlbedo(sr, sg, sb, level, chroma, out) {
  const lr = srgbToLinear(sr), lg = srgbToLinear(sg), lb = srgbToLinear(sb);
  const p = clamp(0.2126 * sr + 0.7152 * sg + 0.0722 * sb, 0, 1);
  const L = NIGHT_FLOOR + NIGHT_SPAN * level * Math.pow(p, NIGHT_GAMMA);
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  let dr = 1, dg = 1, db = 1;
  if (lum > 1e-6) { const k = 1 / lum; dr = lr * k; dg = lg * k; db = lb * k; }
  dr = CHROMA_PEDESTAL + (1 - CHROMA_PEDESTAL) * Math.max(1 + (dr - 1) * chroma, 0);
  dg = CHROMA_PEDESTAL + (1 - CHROMA_PEDESTAL) * Math.max(1 + (dg - 1) * chroma, 0);
  db = CHROMA_PEDESTAL + (1 - CHROMA_PEDESTAL) * Math.max(1 + (db - 1) * chroma, 0);
  const spread = Math.max(Math.abs(dr - 1), Math.abs(dg - 1), Math.abs(db - 1));
  const neutral = clamp(1 - spread * 2.4, 0, 1);
  const o = out || [0, 0, 0];
  o[0] = L * dr * (1 + (COOL_R - 1) * neutral);
  o[1] = L * dg * (1 + (COOL_G - 1) * neutral);
  o[2] = L * db * (1 + (COOL_B - 1) * neutral);
  return o;
}

// Material classes. `rough` is load-bearing: the specular response is what separates glass from
// brick long before the colour does (CONTRACT §2 material guide).
// `spread` is the fractional per-building jitter on roughness. Curtain wall gets the widest one
// because real curtain wall genuinely ranges from mirror to fritted, and that variation is what
// stops a row of towers reflecting the sky in perfect lockstep.
const MCLASS = {
  glass: { level: 0.72, chroma: 0.80, rough: 0.078, spread: 0.40, glassy: true },
  steel: { level: 0.62, chroma: 0.55, rough: 0.14, spread: 0.25, glassy: true },
  metal: { level: 0.74, chroma: 0.60, rough: 0.16, spread: 0.22, glassy: false },
  granite: { level: 0.76, chroma: 0.55, rough: 0.25, spread: 0.16, glassy: false },
  marble: { level: 0.94, chroma: 0.40, rough: 0.22, spread: 0.16, glassy: false },
  stone: { level: 0.78, chroma: 0.55, rough: 0.26, spread: 0.14, glassy: false },
  limestone: { level: 0.86, chroma: 0.50, rough: 0.30, spread: 0.14, glassy: false },
  stucco: { level: 0.74, chroma: 0.50, rough: 0.86, spread: 0.10, glassy: false },
  concrete: { level: 0.68, chroma: 0.38, rough: 0.88, spread: 0.10, glassy: false },
  brick: { level: 0.78, chroma: 0.46, rough: 0.92, spread: 0.08, glassy: false },
  wood: { level: 0.70, chroma: 0.60, rough: 0.90, spread: 0.10, glassy: false },
};

// OSM building:material -> class. Everything the dataset actually contains is covered; the rest
// are the spellings that turn up in OSM generally.
const MAT_ALIAS = {
  brick: 'brick', bricks: 'brick', brick_block: 'brick', brickwork: 'brick',
  glass: 'glass', glass_facade: 'glass', mirror: 'glass', glass_block: 'glass',
  stone: 'stone', masonry: 'stone', sandstone: 'stone', tile: 'stone', tiles: 'stone',
  limestone: 'limestone', granite: 'granite', marble: 'marble',
  concrete: 'concrete', cement: 'concrete', precast_concrete: 'concrete',
  reinforced_concrete: 'concrete', block: 'concrete',
  metal: 'metal', aluminium: 'metal', aluminum: 'metal', copper: 'metal',
  zinc: 'metal', tin: 'metal', steel: 'steel',
  stucco: 'stucco', plaster: 'stucco', render: 'stucco', cladding: 'stucco',
  panel: 'stucco', vinyl_siding: 'stucco', plastic: 'stucco',
  wood: 'wood', timber: 'wood',
};

// Daylight-appearance palettes in sRGB. These are what a Torontonian would describe the building
// as; nightAlbedo() does the translation into the blue-hour band.
const PAL = {
  // Red and buff brick — the Victorian/warehouse stock that carries King West, the Fashion
  // District and Old Town, and the single warmest thing missing from the skyline before this.
  brick: [0x8b4433, 0x7c392c, 0x9a5238, 0xa2604a, 0xb0714f, 0x6d3a33,
    0x8c5a48, 0x96422f, 0xc0a479, 0xb59a70, 0xa98d68],
  stone: [0xd6cab1, 0xcdc0a6, 0xc4b9a4, 0xbdb3a0, 0xd2c7ae, 0xb5a892, 0xa9a39a],
  limestone: [0xdcd0b8, 0xd4c8ae, 0xcabfa8, 0xe0d6c0, 0xd8cdb2],
  granite: [0x8a7f7a, 0x6f6a68, 0x9a8d84, 0x5e5a58],
  marble: [0xe6e2da, 0xdedad2, 0xeae7e0],
  concrete: [0xa3a3a1, 0x969699, 0x9b958b, 0x8a8a8e, 0x7d7c79, 0xafaba3, 0x8f9296],
  // Curtain-wall families Toronto actually uses: blue-green and teal (most of the condo stock),
  // steel blue, bronze, charcoal, and the odd near-clear silver.
  glass: [0x2f4c53, 0x35565d, 0x3a606c, 0x4d6a63, 0x3f5a4c,
    0x2b4560, 0x3f6080, 0x4a6a86, 0x5b6f7c,
    0x5c4a34, 0x6a5638, 0x2c3238, 0x3a424a, 0x76838d],
  metal: [0xb4b6b8, 0xc0b6a2, 0x9aa0a6, 0xa8a49f, 0x8d9296],
  steel: [0x2a2c2e, 0x35383a, 0x232527],
  stucco: [0xd8d2c4, 0xcfc9bb, 0xc2b9a6, 0xdad6cc, 0xb9b7ae, 0xcdbfa8],
  wood: [0x7a5a3c, 0x8a6a46, 0x6a4c34],
};

// Weighted toward the glass families for condo stock: 9 of 14 glass entries are blue-green,
// teal or steel-blue, which is what the newer towers overwhelmingly are.
const GLASS_COOL = 9;

// Districts whose low-rise stock is heavily red brick, in local metres (X east, Z south).
// King West / Fashion District, Old Town / St Lawrence, and the Queen West strip.
const BRICK_BELTS = [
  [-760, -60, 640],
  [1280, -450, 540],
  [-640, -540, 430],
];

function brickBias(x, z) {
  let best = 0;
  for (let i = 0; i < BRICK_BELTS.length; i++) {
    const b = BRICK_BELTS[i];
    const d = Math.hypot(x - b[0], z - b[1]) / b[2];
    const w = 1 - smoothstep(0.5, 1.0, d);
    if (w > best) best = w;
  }
  return best;
}

// Family choice for the ~85% of buildings with no surveyed material. Keyed on the lighting
// profile as well as height, so a residential slab and an office block of the same size draw
// from different stock.
function pickClass(profile, h, bias, r) {
  if (profile === 4) return r < 0.86 ? 'concrete' : 'metal';
  if (profile === 0) return r < 0.60 ? 'concrete' : 'stone';
  if (profile === 5) return r < 0.46 ? 'limestone' : (r < 0.74 ? 'stone' : 'concrete');
  if (h >= 130) return r < 0.80 ? 'glass' : (r < 0.92 ? 'metal' : 'stone');
  if (h >= 60) {
    if (profile === 2) return r < 0.66 ? 'glass' : (r < 0.84 ? 'concrete' : 'brick');
    return r < 0.58 ? 'glass' : (r < 0.78 ? 'stone' : 'concrete');
  }
  if (h >= 26) {
    const b = 0.24 + bias * 0.34;
    if (r < b) return 'brick';
    if (profile === 2) return r < b + 0.30 ? 'glass' : (r < b + 0.54 ? 'concrete' : 'stucco');
    if (profile === 1) return r < b + 0.26 ? 'glass' : (r < b + 0.54 ? 'stone' : 'concrete');
    return r < b + 0.22 ? 'glass' : (r < b + 0.52 ? 'concrete' : 'stucco');
  }
  const b = 0.38 + bias * 0.34;
  if (r < b) return 'brick';
  if (r < b + 0.20) return 'stucco';
  if (r < b + 0.38) return 'concrete';
  if (r < b + 0.50) return 'stone';
  return 'glass';
}

const _fc = [0, 0, 0];
const _roofMat = [0, 0, 0, 0, 0, 0, 0];

/**
 * Full facade material for one building.
 * @param {{h:number, y:number, cx:number, cz:number, t:*, c:*, m:*}} b prepped building record
 * @param {object|null} L matched landmark, or null
 * @returns {{mat:number[], glassy:boolean, profile:number, cls:string, tagged:boolean}}
 *   `mat` is [r, g, b, emissive, tintable, rough, profile], ready for setMat().
 */
function facadeMaterial(b, L) {
  const h = b.h, cx = b.cx, cz = b.cz;
  let profile = (typeof b.t === 'number' && b.t >= 0 && b.t <= 5) ? (b.t | 0) : -1;
  if (profile < 0) profile = h >= 55 ? 1 : (h >= 12 ? 3 : 5);   // untagged: infer, never envelope

  // Position + profile pick the family; HEIGHT enters through pickClass() as a real input rather
  // than as hash entropy. That matters because one real tower is often several stacked massing
  // slabs of differing heights sharing a centroid — folding height into the palette hash would
  // draw each slab from a different colour and stripe the tower.
  const rClass = hashPos(cx, cz, 11 + profile * 7);
  const rPal = hashPos(cx, cz, 31);
  const jLight = hashPos(cx, cz, 41);
  const jWarm = hashPos(cx, cz, 43);
  const jRough = hashPos(cx, cz, 47);

  // --- class: surveyed material, then the landmark table, then the hash -------
  let cls = null;
  if (typeof b.m === 'string') cls = MAT_ALIAS[b.m.toLowerCase()] || null;
  if (!cls && L && L.cls) cls = L.cls;
  if (!cls || !MCLASS[cls]) cls = pickClass(profile, h, brickBias(cx, cz), rClass);
  const spec = MCLASS[cls];

  // --- colour: surveyed tag, then the landmark table, then the family palette -
  let sr, sg, sb, tagged = false;
  const c = b.c;
  if (Array.isArray(c) && c.length >= 3 && isNum(c[0]) && isNum(c[1]) && isNum(c[2])) {
    sr = clamp(c[0], 0, 1); sg = clamp(c[1], 0, 1); sb = clamp(c[2], 0, 1);
    tagged = true;
  } else if (L && isNum(L.srgb)) {
    const t = srgb8(L.srgb);
    sr = t[0]; sg = t[1]; sb = t[2];
    tagged = true;
  } else {
    const list = PAL[cls] || PAL.concrete;
    // Condo glass leans hard into the cool families; office glass may take any of them.
    const span = (cls === 'glass' && profile === 2) ? GLASS_COOL : list.length;
    const t = srgb8(list[Math.min(list.length - 1, (rPal * span) | 0)]);
    sr = t[0]; sg = t[1]; sb = t[2];
  }

  // Per-building variation. Surveyed colours get a whisper of it so 107 identical firebrick tags
  // do not paint 107 identical walls; invented ones get enough to break up a block.
  const vLight = tagged ? lerp(0.94, 1.06, jLight) : lerp(0.84, 1.16, jLight);
  const vWarm = tagged ? lerp(0.985, 1.015, jWarm) : lerp(0.95, 1.05, jWarm);
  const invWarm = 1 / Math.max(vWarm, 1e-3);
  sr = clamp(sr * vLight * vWarm, 0, 1);
  sg = clamp(sg * vLight, 0, 1);
  sb = clamp(sb * vLight * invWarm, 0, 1);

  nightAlbedo(sr, sg, sb, spec.level, spec.chroma, _fc);
  let rough = clamp(spec.rough * lerp(1 - spec.spread, 1 + spec.spread, jRough), 0.05, 0.98);
  let glassy = spec.glassy;
  // Envelope guard. A stadium shell, a church or a concert hall has no window grid, and the
  // renderer is entitled to infer "curtain wall" from smoothness alone. Two profile-0 buildings
  // in the dataset carry building:material=glass, so hold every envelope above the smoothness
  // the shader treats as glazing — an envelope may never be mistaken for a lit facade.
  if (profile === 0) {
    rough = clamp(rough, ENVELOPE_MIN_ROUGH, 0.98);
    glassy = false;
  }
  return {
    mat: [_fc[0], _fc[1], _fc[2], PROFILE_EMIS[profile], 0, rough, profile],
    glassy,
    profile,
    cls,
    tagged,
  };
}

// Roofs are gravel, ballast and mechanical plant: dark, matte, and PROFILE 0 without exception.
// A roof that emits window light is the single loudest tell that a city was generated rather
// than built, and it is why the old build looked like it was made of lamps.
function roofMaterial(facade, out) {
  const rm = M.roof;
  const o = out || [0, 0, 0, 0, 0, 0, 0];
  o[0] = rm[0] + facade[0] * 0.10;
  o[1] = rm[1] + facade[1] * 0.10;
  o[2] = rm[2] + facade[2] * 0.10;
  o[3] = 0; o[4] = 0; o[5] = rm[5]; o[6] = 0;
  return o;
}


/**
 * The roof material for `facade`, in the module's own scratch array. Every caller in the tree
 * used one shared scratch already — this is that scratch, kept private, so nothing outside has
 * to know it exists. Write-then-read within one call, exactly as before.
 */
function roofMat(facade) {
  return roofMaterial(facade, _roofMat);
}

// Material classes, in draw order. 'signs' is LAST and is not an opaque class at all: it holds
// the glyph quads text.js lays out, which render.js draws in its own blended decal pass after
// everything else has written depth. See CityTiles below for how it reaches that pass.
const MESH_CLASSES = ['terrain', 'buildings', 'glass', 'roads', 'sidewalks', 'rails', 'props',
  'signs'];
// The last OPAQUE class — the one a draw loop walking the classes in order finishes on, and
// therefore the point at which the signage pass has to run.
const LAST_OPAQUE_CLASS = 'props';
const SIGN_CLASS = 'signs';

export {
  MESH_CLASSES, LAST_OPAQUE_CLASS, SIGN_CLASS,
  M, EMITTER_MIN, PROFILE_EMIS, ENVELOPE_MIN_ROUGH,
  setMat, nightAlbedo, MCLASS, PAL, pickClass, facadeMaterial, roofMaterial, roofMat,
};
