// src/props.js — street furniture, lighting, vegetation and ground hardware.
//
// CONTRACT.md §6.1. Zero dependencies. World axes: X = east, Y = up, Z = south, true metres.
//
// Every export APPENDS into a MeshBuilder the caller owns; nothing here creates a Mesh, so the
// whole city still merges down to a handful of draw calls. Nothing here allocates per call either
// (all working storage is module-scope scratch) because these run in the tens of thousands.
//
// Orientation convention
// ----------------------
// `yaw` rotates the piece about +Y exactly the way MeshBuilder.box() does:
//     local +X  ->  world ( cos yaw, 0, -sin yaw)
//     local +Z  ->  world ( sin yaw, 0,  cos yaw)
// so a caller that wants a piece to point along a unit direction (dx, dz) uses
//     yaw = Math.atan2(-dz, dx)
// and a plan-space (u = x, v = -z) rotation by +yaw is counter-clockwise, i.e. the usual maths
// convention with north up on paper.
//
// LOCAL +X IS ALWAYS "OUT" OR "FRONT". A lamp's arm reaches along +X, a signal's mast arm reaches
// along +X, a bench/bin/mailbox faces +X. Long objects (bench, shelter, platform) run their length
// along local Z, centred on the origin. `(x, y, z)` is the piece's footprint centre at GROUND
// level — y is the top of the pavement, not the object's centre — so callers pass
// groundY(x, z) + kerb straight through.
//
// Vertex channels
// ---------------
// gl.js's 13 floats; MeshBuilder.color(r, g, b, emissive, tintable, rough, profile).
//   * `profile` is 0 (envelope) on absolutely everything here. Street furniture has no window grid
//     and the shader must never paint one onto a litter bin.
//   * because profile is 0, `emissive` may only ever be exactly 0 or >= 0.50 (city.js's
//     EMITTER_MIN). Anything in between is a facade window hint and would be a bug on a prop.
//     Lamp lenses, signal lenses and backlit ad panels are the only emitters below; every other
//     surface is exactly 0.
//   * `tintable` is 0 everywhere. The uTint path is for dynamic meshes.
//   * colours are linear-ish scene albedo in the same low-key range city.js uses for ground cover,
//     so props sit in the image instead of punching out of it.
//
// Silhouette first. These are read as dark shapes against a lit ground, so the outline gets the
// vertices and the surface detail does not.
//
// Winding: counter-clockwise seen from outside. The renderer culls back faces. Every triangle here
// goes through MeshBuilder.tri() or MeshBuilder.cylinder()/sphere(), so normals are derived from
// the winding and are always unit length; there is no hand-written normal to get wrong.

import { clamp, TAU } from './math.js';

/* =============================================================== materials = */
// [ r, g, b, emissive, tintable, rough, profile ]

const M = {
  // --- metals -------------------------------------------------------------
  poleGrey: [0.082, 0.085, 0.092, 0, 0, 0.42, 0],   // anodised aluminium mast
  poleDark: [0.040, 0.042, 0.047, 0, 0, 0.36, 0],   // heritage black cast iron
  galv: [0.115, 0.118, 0.126, 0, 0, 0.46, 0],       // hot-dip galvanised
  steel: [0.090, 0.093, 0.099, 0, 0, 0.28, 0],
  castIron: [0.050, 0.051, 0.055, 0, 0, 0.62, 0],
  lampBody: [0.096, 0.098, 0.103, 0, 0, 0.34, 0],   // LED head casing
  signalBody: [0.034, 0.037, 0.035, 0, 0, 0.44, 0], // signal heads are near-black

  // --- masonry, timber, plastics -----------------------------------------
  concrete: [0.120, 0.121, 0.125, 0, 0, 0.90, 0],
  granite: [0.088, 0.088, 0.093, 0, 0, 0.58, 0],
  woodSlat: [0.104, 0.074, 0.049, 0, 0, 0.84, 0],
  glass: [0.028, 0.036, 0.048, 0, 0, 0.07, 0],
  dark: [0.014, 0.015, 0.017, 0, 0, 0.68, 0],       // apertures, recesses, unlit lenses
  soil: [0.036, 0.030, 0.025, 0, 0, 0.94, 0],
  grateIron: [0.038, 0.039, 0.042, 0, 0, 0.56, 0],

  // --- painted furniture --------------------------------------------------
  postRed: [0.300, 0.036, 0.028, 0, 0, 0.55, 0],    // Canada Post
  hydBody: [0.330, 0.268, 0.052, 0, 0, 0.62, 0],    // hydrant yellow
  hydCap: [0.052, 0.108, 0.225, 0, 0, 0.62, 0],     // colour-coded bonnet
  binBody: [0.068, 0.071, 0.076, 0, 0, 0.55, 0],    // waste stream
  binRecycle: [0.036, 0.070, 0.094, 0, 0, 0.55, 0], // recycling stream
  binHood: [0.046, 0.048, 0.052, 0, 0, 0.44, 0],
  greenP: [0.038, 0.100, 0.055, 0, 0, 0.55, 0],
  signGreen: [0.028, 0.084, 0.050, 0, 0, 0.70, 0],  // street-name blade
  signWhite: [0.230, 0.233, 0.238, 0, 0, 0.72, 0],
  signRed: [0.250, 0.040, 0.034, 0, 0, 0.70, 0],
  cabGrey: [0.086, 0.088, 0.090, 0, 0, 0.72, 0],
  cabGreen: [0.048, 0.068, 0.052, 0, 0, 0.72, 0],
  cabBeige: [0.110, 0.104, 0.088, 0, 0, 0.74, 0],

  // --- vegetation ---------------------------------------------------------
  bark: [0.054, 0.045, 0.037, 0, 0, 0.92, 0],
  barkPale: [0.068, 0.060, 0.050, 0, 0, 0.92, 0],
  foliage: [0.033, 0.054, 0.035, 0, 0, 0.95, 0],
  foliageWarm: [0.044, 0.058, 0.031, 0, 0, 0.95, 0],
  foliageCool: [0.028, 0.050, 0.040, 0, 0, 0.95, 0],

  // --- emitters (emissive >= 0.50, see the header) ------------------------
  ledWhite: [1.000, 0.930, 0.780, 1.00, 0, 0.55, 0],
  sodium: [1.000, 0.600, 0.220, 1.00, 0, 0.58, 0],
  acornWarm: [1.000, 0.820, 0.520, 0.92, 0, 0.30, 0],
  sigRed: [1.000, 0.120, 0.080, 0.85, 0, 0.40, 0],
  sigAmber: [1.000, 0.520, 0.060, 0.85, 0, 0.40, 0],
  sigGreen: [0.180, 1.000, 0.420, 0.85, 0, 0.40, 0],
  sigHand: [1.000, 0.400, 0.100, 0.80, 0, 0.40, 0],
  adPanel: [0.880, 0.915, 1.000, 0.70, 0, 0.20, 0],
  screen: [0.280, 0.880, 0.540, 0.55, 0, 0.25, 0],

  // --- roofscape, vehicles, marine and works ------------------------------
  // Same rules as everything above: albedo + roughness only, profile 0, emissive 0 unless the
  // surface is a real lamp. Nothing here encodes a time of day.
  alum: [0.140, 0.143, 0.150, 0, 0, 0.40, 0],       // mill-finish aluminium panel
  galvPale: [0.148, 0.152, 0.160, 0, 0, 0.50, 0],   // new galvanised sheet
  craneYellow: [0.300, 0.232, 0.048, 0, 0, 0.70, 0],
  craneWhite: [0.205, 0.208, 0.212, 0, 0, 0.72, 0],
  rustRed: [0.148, 0.062, 0.042, 0, 0, 0.88, 0],
  plywood: [0.132, 0.098, 0.062, 0, 0, 0.90, 0],    // sidewalk hoarding ply
  timber: [0.116, 0.088, 0.060, 0, 0, 0.88, 0],     // quay decking
  carGlass: [0.020, 0.024, 0.030, 0, 0, 0.06, 0],
  tyre: [0.016, 0.016, 0.017, 0, 0, 0.90, 0],
  chrome: [0.145, 0.148, 0.154, 0, 0, 0.12, 0],
  lampRed: [0.180, 0.030, 0.026, 0, 0, 0.55, 0],    // UNLIT tail-lamp lens
  lampClear: [0.180, 0.176, 0.165, 0, 0, 0.30, 0],  // UNLIT head-lamp lens
  taxiOrange: [0.300, 0.170, 0.020, 0, 0, 0.60, 0],
  hullWhite: [0.215, 0.220, 0.226, 0, 0, 0.55, 0],
  hullNavy: [0.026, 0.034, 0.062, 0, 0, 0.50, 0],
  canvas: [0.180, 0.168, 0.148, 0, 0, 0.92, 0],
  canvasRed: [0.190, 0.052, 0.044, 0, 0, 0.92, 0],
  flagRed: [0.260, 0.036, 0.032, 0, 0, 0.90, 0],
  flagWhite: [0.235, 0.238, 0.242, 0, 0, 0.90, 0],
  binGreen: [0.040, 0.078, 0.048, 0, 0, 0.78, 0],
  binBlue: [0.032, 0.056, 0.092, 0, 0, 0.78, 0],
  railSilver: [0.128, 0.131, 0.136, 0, 0, 0.42, 0],
  railGreen: [0.030, 0.058, 0.040, 0, 0, 0.66, 0],
  railMaroon: [0.086, 0.030, 0.032, 0, 0, 0.66, 0],
  chalk: [0.070, 0.068, 0.064, 0, 0, 0.92, 0],

  // --- waterfront (CONTRACT §8.3) -----------------------------------------
  // Harbour hardware is a small, specific material set: cast iron that has been painted black
  // and re-painted for a century, hot-dip galvanised steel, creosoted timber, quarried armour
  // stone, and the one saturated colour on the whole quay — the lifebuoy.
  quayIron: [0.044, 0.045, 0.048, 0, 0, 0.58, 0],       // bollards, ladders, cast fittings
  quayTimber: [0.092, 0.066, 0.044, 0, 0, 0.88, 0],     // decking and fender timber
  pileTimber: [0.048, 0.036, 0.027, 0, 0, 0.92, 0],     // creosoted pile, dark and matte
  armourStone: [0.070, 0.069, 0.066, 0, 0, 0.94, 0],    // dolostone armour block
  floatDeck: [0.104, 0.106, 0.110, 0, 0, 0.72, 0],      // GRP / concrete floating dock
  lifeRing: [0.320, 0.108, 0.026, 0, 0, 0.74, 0],       // lifebuoy orange
  buoyYellow: [0.260, 0.196, 0.030, 0, 0, 0.66, 0],     // mooring buoy
  markerRed: [0.230, 0.036, 0.030, 0, 0, 0.68, 0],      // port-hand daymark
  markerGreen: [0.030, 0.130, 0.062, 0, 0, 0.68, 0],    // starboard-hand daymark

  // --- further emitters (emissive >= 0.50) --------------------------------
  beaconRed: [1.000, 0.090, 0.060, 0.90, 0, 0.40, 0],   // aviation obstruction light
  shedLamp: [1.000, 0.940, 0.820, 0.85, 0, 0.55, 0],    // under-deck lamp on a sidewalk shed
  navRed: [1.000, 0.140, 0.090, 0.80, 0, 0.35, 0],      // port-hand navigation light
  navGreen: [0.140, 1.000, 0.360, 0.80, 0, 0.35, 0],    // starboard-hand navigation light
  quayLamp: [1.000, 0.900, 0.740, 0.80, 0, 0.55, 0],    // lifebuoy-station lamp

  // --- the islands and the airfield (the south half of the map) ------------
  // The Toronto Islands are parkland and the airfield is mown grass and asphalt, so this set is
  // deliberately warmer and greener than the downtown palette above. Same rules throughout:
  // albedo and roughness only, profile 0, emissive 0 unless the surface is a real lamp.
  sandDry: [0.148, 0.132, 0.101, 0, 0, 0.95, 0],        // dry beach sand, backshore
  sandWet: [0.056, 0.050, 0.041, 0, 0, 0.58, 0],        // the swash zone, still wet
  duneGrass: [0.048, 0.058, 0.032, 0, 0, 0.96, 0],      // marram on the back of the beach
  hedgeLeaf: [0.024, 0.044, 0.026, 0, 0, 0.96, 0],      // clipped privet, denser than a canopy
  bloomWarm: [0.190, 0.086, 0.034, 0, 0, 0.94, 0],      // bedding plants, the one warm accent
  bloomCool: [0.078, 0.056, 0.140, 0, 0, 0.94, 0],
  bloomPale: [0.185, 0.176, 0.150, 0, 0, 0.94, 0],
  bedSoil: [0.030, 0.024, 0.019, 0, 0, 0.96, 0],        // turned bed, darker than path soil

  aircraftWhite: [0.228, 0.231, 0.238, 0, 0, 0.32, 0],  // painted airframe
  aircraftGrey: [0.116, 0.120, 0.127, 0, 0, 0.34, 0],   // unpainted panel, radome, nacelle
  aircraftTrim: [0.020, 0.031, 0.056, 0, 0, 0.30, 0],   // cheatline and fin
  cabinGlass: [0.015, 0.019, 0.025, 0, 0, 0.05, 0],
  propBlade: [0.024, 0.025, 0.027, 0, 0, 0.28, 0],
  hangarClad: [0.126, 0.129, 0.136, 0, 0, 0.50, 0],     // profiled steel sheet
  hangarDoor: [0.094, 0.096, 0.102, 0, 0, 0.46, 0],
  chainLink: [0.070, 0.073, 0.077, 0, 0, 0.62, 0],
  windsockFlag: [0.310, 0.140, 0.021, 0, 0, 0.92, 0],

  lightStone: [0.150, 0.147, 0.138, 0, 0, 0.86, 0],     // Gibraltar Point: limewashed rubble
  lightTrim: [0.118, 0.030, 0.026, 0, 0, 0.58, 0],
  ferryHull: [0.024, 0.038, 0.066, 0, 0, 0.42, 0],
  ferryHouse: [0.212, 0.215, 0.221, 0, 0, 0.54, 0],
  ferryDeck: [0.056, 0.058, 0.062, 0, 0, 0.74, 0],
  rideRed: [0.215, 0.038, 0.032, 0, 0, 0.62, 0],        // Centreville fairground paint
  rideCream: [0.205, 0.190, 0.150, 0, 0, 0.64, 0],
  rideGold: [0.190, 0.145, 0.038, 0, 0, 0.40, 0],
  shingle: [0.048, 0.044, 0.042, 0, 0, 0.92, 0],        // asphalt shingle on an island cottage
  boardRail: [0.086, 0.062, 0.041, 0, 0, 0.88, 0],      // boardwalk handrail timber

  // --- aeronautical and navigation emitters (emissive >= 0.50) ------------
  // Amendment 7: these are the only new light sources in the south half. A runway edge light, a
  // threshold bar and a lighthouse lantern are all genuine lamps; the renderer decides when.
  runwayEdge: [1.000, 0.958, 0.880, 0.95, 0, 0.34, 0],
  runwayGreen: [0.120, 1.000, 0.340, 0.92, 0, 0.34, 0], // threshold
  runwayRed: [1.000, 0.120, 0.088, 0.92, 0, 0.34, 0],   // runway end
  taxiBlue: [0.170, 0.350, 1.000, 0.85, 0, 0.34, 0],    // taxiway edge
  approachLamp: [1.000, 0.972, 0.930, 1.00, 0, 0.28, 0],
  lanternLight: [1.000, 0.902, 0.715, 1.00, 0, 0.18, 0],
};

const NEWSBOX_COLOURS = [
  [0.040, 0.062, 0.150, 0, 0, 0.60, 0],   // broadsheet blue
  [0.190, 0.150, 0.030, 0, 0, 0.60, 0],   // listings yellow
  [0.150, 0.030, 0.030, 0, 0, 0.60, 0],   // tabloid red
  [0.062, 0.064, 0.068, 0, 0, 0.60, 0],   // plain grey
];

const CABINET_COLOURS = [M.cabGrey, M.cabGreen, M.cabBeige, M.cabGrey];

// Parked-car bodywork. Deliberately low-key: a Toronto kerb is mostly white, silver, grey and
// black, with the occasional dark red or blue. Bright paint punches out of the image.
const CAR_COLOURS = [
  [0.210, 0.214, 0.220, 0, 0, 0.30, 0],   // white
  [0.126, 0.130, 0.136, 0, 0, 0.26, 0],   // silver
  [0.062, 0.064, 0.068, 0, 0, 0.28, 0],   // graphite
  [0.024, 0.025, 0.027, 0, 0, 0.24, 0],   // black
  [0.098, 0.032, 0.030, 0, 0, 0.28, 0],   // dark red
  [0.028, 0.040, 0.072, 0, 0, 0.28, 0],   // navy
  [0.040, 0.056, 0.048, 0, 0, 0.30, 0],   // dark green
];

const DUMPSTER_COLOURS = [M.binGreen, M.binBlue, M.rustRed, M.cabGreen];
const BOAT_HULLS = [M.hullWhite, M.hullNavy, M.hullWhite, M.granite];
const RAIL_LIVERY = [M.railSilver, M.railGreen, M.railMaroon];

// [ length, halfWidth, sillY, beltY, roofY, cabinZ0, cabinZ1, wheelR ] — see appendParkedCar.
const CAR_SEDAN = [4.52, 0.895, 0.30, 0.80, 1.44, -1.25, 0.45, 0.325];
const CAR_SUV = [4.78, 0.955, 0.35, 0.96, 1.80, -1.45, 0.72, 0.370];
const CAR_VAN = [5.36, 0.990, 0.37, 1.06, 2.24, -2.05, 0.80, 0.355];

/* ================================================================ scratch == */

const EPS = 1e-9;
const MAX_STA = 8;
const MAX_SIDES = 10;

const _C = new Float64Array(24);              // 8 world hull corners
const _L = new Float64Array(24);              // 8 local hull corners
const _RING = new Float64Array(MAX_STA * MAX_SIDES * 3);
const _STA = new Float64Array(MAX_STA * 3);
const _BR = new Float64Array(MAX_SIDES * 3);

// Hull corner index: bit0 = X (0 -> low, 1 -> high), bit1 = Y, bit2 = Z.
// Face vertex order lifted straight out of MeshBuilder.box() so the winding matches exactly.
const _FI = new Int32Array([
  5, 1, 3, 7,   // +X
  0, 4, 6, 2,   // -X
  6, 7, 3, 2,   // +Y
  0, 1, 5, 4,   // -Y
  4, 5, 7, 6,   // +Z
  1, 0, 2, 3,   // -Z
]);

// Face bitmask.
const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;
const F_SIDES = F_PX | F_NX | F_PZ | F_NZ;   // 51 — open top and bottom
const F_NOBOT = F_ALL & ~F_NY;               // 55 — everything but the underside
const F_PLATEX = F_PX | F_NX;                // 3  — a thin plate whose faces point along X
const F_PLATEZ = F_PZ | F_NZ;                // 48 — a thin plate whose faces point along Z
const F_BLADEX = F_PX | F_NX | F_PY | F_NY;  // 15 — plate plus its top and bottom edges
const F_BLADEZ = F_PZ | F_NZ | F_PY | F_NY;  // 60

/* ============================================================== utilities == */

function fin(v, d) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : d;
}

// fin() for an angle, plus a wrap into [-PI, PI]. In practice a yaw only ever arrives from
// Math.atan2 and the wrap is a no-op, but a caller-supplied angle above ~1e16 has lost every low
// bit to the exponent: (i / n) * TAU + yaw is then the SAME number for every i, which collapses
// each ring in mb.cylinder()/discY() to a single point and silently deletes the geometry.
function finAngle(v, d) {
  const a = (typeof v === 'number' && Number.isFinite(v)) ? v : d;
  if (a >= -Math.PI && a <= Math.PI) return a;
  const r = a % TAU;
  return r > Math.PI ? r - TAU : (r <= -Math.PI ? r + TAU : r);
}

// A guarded draw from the city's seeded rng. A non-function or a non-finite draw must never be
// allowed to reach a vertex — one NaN silently deletes the triangle it lands in.
function rnd(rng) {
  const v = typeof rng === 'function' ? rng() : Math.random();
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : (v >= 1 ? 0.99999994 : v);
}

function rr(rng, a, b) {
  return a + (b - a) * rnd(rng);
}

function pickOf(rng, arr) {
  const i = (rnd(rng) * arr.length) | 0;
  return arr[i < arr.length ? i : arr.length - 1];
}

// Deterministic [0,1) from a world position — lets signal phase and similar per-instance choices
// vary across the city without threading an rng through a contract signature that has none.
function hash2(x, z) {
  const a = Math.imul((((x * 64) | 0) ^ 0x27d4eb2d) | 0, 0x9e3779b1);
  const b = Math.imul((((z * 64) | 0) ^ 0x165667b1) | 0, 0x85ebca6b);
  let h = (a ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

function setMat(mb, m) {
  mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m[6]);
}

/* ======================================================== local primitives = */
// Everything below takes an origin (ox, oy, oz) plus a precomputed yaw cosine/sine (c, s) and
// works in the piece's local frame, which keeps the trigonometry to two calls per prop.

function corner(i, lx, ly, lz, ox, oy, oz, c, s) {
  const k = i * 3;
  _C[k] = ox + lx * c + lz * s;
  _C[k + 1] = oy + ly;
  _C[k + 2] = oz - lx * s + lz * c;
}

function hullOut(mb, faces) {
  for (let f = 0; f < 6; f++) {
    if ((faces & (1 << f)) === 0) continue;
    const o = f * 4;
    const a = _FI[o] * 3, b = _FI[o + 1] * 3, c = _FI[o + 2] * 3, d = _FI[o + 3] * 3;
    mb.tri(_C[a], _C[a + 1], _C[a + 2], _C[b], _C[b + 1], _C[b + 2], _C[c], _C[c + 1], _C[c + 2]);
    mb.tri(_C[a], _C[a + 1], _C[a + 2], _C[c], _C[c + 1], _C[c + 2], _C[d], _C[d + 1], _C[d + 2]);
  }
}

// Axis-aligned local box given by its local min/max corner. 6 verts per requested face.
function boxL(mb, ox, oy, oz, c, s, x0, y0, z0, x1, y1, z1, faces) {
  for (let i = 0; i < 8; i++) {
    corner(i, (i & 1) ? x1 : x0, (i & 2) ? y1 : y0, (i & 4) ? z1 : z0, ox, oy, oz, c, s);
  }
  hullOut(mb, faces);
}

// Vertical frustum: a bottom rectangle at y0 and a different top rectangle at y1.
function frustL(mb, ox, oy, oz, c, s, y0, y1,
  ax0, az0, ax1, az1, bx0, bz0, bx1, bz1, faces) {
  for (let i = 0; i < 8; i++) {
    const top = (i & 2) !== 0;
    const lx = (i & 1) ? (top ? bx1 : ax1) : (top ? bx0 : ax0);
    const lz = (i & 4) ? (top ? bz1 : az1) : (top ? bz0 : az0);
    corner(i, lx, top ? y1 : y0, lz, ox, oy, oz, c, s);
  }
  hullOut(mb, faces);
}

// Free-form topological cube: the caller fills _L through setL() using the same index bits.
function setL(i, x, y, z) {
  const k = i * 3;
  _L[k] = x; _L[k + 1] = y; _L[k + 2] = z;
}

function hullL(mb, ox, oy, oz, c, s, faces) {
  for (let i = 0; i < 8; i++) corner(i, _L[i * 3], _L[i * 3 + 1], _L[i * 3 + 2], ox, oy, oz, c, s);
  hullOut(mb, faces);
}

// Single local quads, in the same corner orders the box faces use, so the normal comes out along
// the named axis. 6 verts each.
function quadL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  const a0 = ox + ax * c + az * s, a1 = oy + ay, a2 = oz - ax * s + az * c;
  const b0 = ox + bx * c + bz * s, b1 = oy + by, b2 = oz - bx * s + bz * c;
  const c0 = ox + cx * c + cz * s, c1 = oy + cy, c2 = oz - cx * s + cz * c;
  const d0 = ox + dx * c + dz * s, d1 = oy + dy, d2 = oz - dx * s + dz * c;
  mb.tri(a0, a1, a2, b0, b1, b2, c0, c1, c2);
  mb.tri(a0, a1, a2, c0, c1, c2, d0, d1, d2);
}

function quadUp(mb, ox, oy, oz, c, s, x0, z0, x1, z1, y) {
  quadL(mb, ox, oy, oz, c, s, x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0);
}

function quadDown(mb, ox, oy, oz, c, s, x0, z0, x1, z1, y) {
  quadL(mb, ox, oy, oz, c, s, x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
}

function quadPX(mb, ox, oy, oz, c, s, x, y0, z0, y1, z1) {
  quadL(mb, ox, oy, oz, c, s, x, y0, z1, x, y0, z0, x, y1, z0, x, y1, z1);
}

function quadNX(mb, ox, oy, oz, c, s, x, y0, z0, y1, z1) {
  quadL(mb, ox, oy, oz, c, s, x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0);
}

function quadPZ(mb, ox, oy, oz, c, s, z, x0, y0, x1, y1) {
  quadL(mb, ox, oy, oz, c, s, x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
}

function quadNZ(mb, ox, oy, oz, c, s, z, x0, y0, x1, y1) {
  quadL(mb, ox, oy, oz, c, s, x1, y0, z, x0, y0, z, x0, y1, z, x1, y1, z);
}

// One triangle given in the piece's local frame. The yaw transform is a proper rotation, so a
// counter-clockwise local winding stays counter-clockwise in world space. 3 verts.
function triL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, cx, cy, cz) {
  mb.tri(
    ox + ax * c + az * s, oy + ay, oz - ax * s + az * c,
    ox + bx * c + bz * s, oy + by, oz - bx * s + bz * c,
    ox + cx * c + cz * s, oy + cy, oz - cx * s + cz * c);
}

// Flat disc standing in the piece's local Y-Z plane at local x, centred on (ly, lz). `out` = true
// faces local +X. This is the cheap readable wheel/disc: mb.cylinder() only spins about Y.
// 3 verts per segment.
function discX(mb, ox, oy, oz, c, s, lx, ly, lz, r, seg, out) {
  const n = Math.max(3, Math.min(seg | 0, MAX_SIDES));
  const rad = Math.max(1e-4, r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 1) / n) * TAU;
    const y0 = ly + rad * Math.cos(a0), z0 = lz + rad * Math.sin(a0);
    const y1 = ly + rad * Math.cos(a1), z1 = lz + rad * Math.sin(a1);
    if (out) triL(mb, ox, oy, oz, c, s, lx, ly, lz, lx, y0, z0, lx, y1, z1);
    else triL(mb, ox, oy, oz, c, s, lx, ly, lz, lx, y1, z1, lx, y0, z0);
  }
}

// The same disc standing in the piece's local X-Y plane at local z, centred on (lx, ly), drawn
// twice with opposite winding at EXACTLY the same z. That is the bicycle wheel: a car's wheels are
// only ever seen from the outboard side and get one facing each, but a bike is walked around, so a
// single-sided disc would vanish from the far kerb.
//
// The two faces are coincident on purpose. Separating them by even a few millimetres opens a rim
// gap, and a bicycle seen head-on then shows the BACK of its far wheel face through that slot.
// Coincident is safe here because the renderer culls back faces in every pass that draws this
// geometry, the shadow cascades included, so exactly one of the pair ever rasterises and there is
// nothing to z-fight. 6 verts per segment.
function discZ(mb, ox, oy, oz, c, s, lz, lx, ly, r, seg) {
  const n = Math.max(3, Math.min(seg | 0, MAX_SIDES));
  const rad = Math.max(1e-4, r);
  // Phase so that the first vertex lands at the BOTTOM of the circle. A six-sided wheel built
  // from angle zero rests on an edge instead of a vertex and the whole bicycle floats 13% of a
  // wheel radius — 4.5 cm — above the road. discX() gets this for free by driving its vertical
  // axis with the cosine; this one has to ask.
  const ph = -TAU * 0.25;
  for (let i = 0; i < n; i++) {
    const a0 = ph + (i / n) * TAU;
    const a1 = ph + ((i + 1) / n) * TAU;
    const x0 = lx + rad * Math.cos(a0), y0 = ly + rad * Math.sin(a0);
    const x1 = lx + rad * Math.cos(a1), y1 = ly + rad * Math.sin(a1);
    triL(mb, ox, oy, oz, c, s, lx, ly, lz, x0, y0, lz, x1, y1, lz);
    triL(mb, ox, oy, oz, c, s, lx, ly, lz, x1, y1, lz, x0, y0, lz);
  }
}

// Hue (in turns) -> a saturated sign-face colour, written into module scratch. Used only by
// appendTowerSign so a caller can ask for a specific brand hue without threading a colour array
// through the contract signature.
const _RGB = new Float64Array(3);

function hueRGB(h) {
  const t = h - Math.floor(h);
  const k = (t >= 0 && t < 1 ? t : 0) * 6;
  const i = Math.floor(k) % 6;
  const f = k - Math.floor(k);
  const S = 0.70;
  const p = 1 - S, q = 1 - S * f, u = 1 - S * (1 - f);
  if (i === 0) { _RGB[0] = 1; _RGB[1] = u; _RGB[2] = p; }
  else if (i === 1) { _RGB[0] = q; _RGB[1] = 1; _RGB[2] = p; }
  else if (i === 2) { _RGB[0] = p; _RGB[1] = 1; _RGB[2] = u; }
  else if (i === 3) { _RGB[0] = p; _RGB[1] = q; _RGB[2] = 1; }
  else if (i === 4) { _RGB[0] = u; _RGB[1] = p; _RGB[2] = 1; }
  else { _RGB[0] = 1; _RGB[1] = p; _RGB[2] = q; }
}

// Oriented rectangular member between two WORLD points. The width axis is horizontal and
// perpendicular to the member, the thickness axis completes a right-handed frame, so the same
// face table applies with +X = +width, +Y = +thickness, +Z = the B end cap, -Z = the A end cap.
function beam(mb, ax, ay, az, bx, by, bz, hw, ht, faces) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-5)) return;
  dx /= len; dy /= len; dz /= len;

  let rx = -dz, rz = dx;
  let rl = Math.sqrt(rx * rx + rz * rz);
  if (rl > 1e-5) { rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
  // u = cross(d, r) with r.y = 0; unit because d and r are unit and orthogonal.
  const ux = dy * rz;
  const uy = dz * rx - dx * rz;
  const uz = -dy * rx;

  for (let i = 0; i < 8; i++) {
    const sr = (i & 1) ? hw : -hw;
    const su = (i & 2) ? ht : -ht;
    const px = (i & 4) ? bx : ax;
    const py = (i & 4) ? by : ay;
    const pz = (i & 4) ? bz : az;
    const k = i * 3;
    _C[k] = px + rx * sr + ux * su;
    _C[k + 1] = py + uy * su;
    _C[k + 2] = pz + rz * sr + uz * su;
  }
  hullOut(mb, faces);
}

// Same, but the endpoints are given in the piece's local frame.
function beamL(mb, ox, oy, oz, c, s, ax, ay, az, bx, by, bz, hw, ht, faces) {
  beam(mb,
    ox + ax * c + az * s, oy + ay, oz - ax * s + az * c,
    ox + bx * c + bz * s, oy + by, oz - bx * s + bz * c,
    hw, ht, faces);
}

// Flat disc, `seg` triangles. up = true faces +Y, false faces -Y. 3 verts per segment.
function discY(mb, cx, cy, cz, r, seg, yaw, up) {
  const n = Math.max(3, seg | 0);
  const rad = Math.max(1e-4, r);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU - yaw;
    const a1 = ((i + 1) / n) * TAU - yaw;
    const x0 = cx + rad * Math.cos(a0), z0 = cz + rad * Math.sin(a0);
    const x1 = cx + rad * Math.cos(a1), z1 = cz + rad * Math.sin(a1);
    if (up) mb.tri(cx, cy, cz, x1, cy, z1, x0, cy, z0);
    else mb.tri(cx, cy, cz, x0, cy, z0, x1, cy, z1);
  }
}

// Sweep a `sides`-gon tube through stations laid out in the local XY plane (X out, Y up); the
// cross-section spans local Z. Stations share their rings, so the cost is sides*6 per SEGMENT
// rather than per station — this is what makes a smoothly curved lamp arm affordable.
// `sta` is [x, y, radius] per station.
function sweepL(mb, ox, oy, oz, c, s, sta, n, sides, capA, capB) {
  const ns = Math.max(2, Math.min(n | 0, MAX_STA));
  const sd = Math.max(3, Math.min(sides | 0, MAX_SIDES));

  for (let i = 0; i < ns; i++) {
    const i0 = i > 0 ? i - 1 : 0;
    const i1 = i < ns - 1 ? i + 1 : ns - 1;
    let tx = sta[i1 * 3] - sta[i0 * 3];
    let ty = sta[i1 * 3 + 1] - sta[i0 * 3 + 1];
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > EPS) { tx /= tl; ty /= tl; } else { tx = 1; ty = 0; }
    const px = sta[i * 3], py = sta[i * 3 + 1];
    const rad = Math.max(1e-4, sta[i * 3 + 2]);
    // Frame (a, b, d) with a = local +Z, b = cross(d, a) = (ty, -tx, 0); cross(a, b) = d, so the
    // ring order below comes out wound counter-clockwise seen from outside.
    for (let k = 0; k < sd; k++) {
      const th = (k / sd) * TAU;
      const cw = Math.cos(th), sw = Math.sin(th);
      const lx = px + rad * sw * ty;
      const ly = py - rad * sw * tx;
      const lz = rad * cw;
      const o = (i * sd + k) * 3;
      _RING[o] = ox + lx * c + lz * s;
      _RING[o + 1] = oy + ly;
      _RING[o + 2] = oz - lx * s + lz * c;
    }
  }

  for (let i = 0; i < ns - 1; i++) {
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = (i * sd + k) * 3;
      const b = (i * sd + k1) * 3;
      const cI = ((i + 1) * sd + k1) * 3;
      const d = ((i + 1) * sd + k) * 3;
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2]);
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2],
        _RING[d], _RING[d + 1], _RING[d + 2]);
    }
  }

  if (capB) {
    const i = ns - 1;
    const px = sta[i * 3], py = sta[i * 3 + 1];
    const wx = ox + px * c, wy = oy + py, wz = oz - px * s;
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = (i * sd + k) * 3, b = (i * sd + k1) * 3;
      mb.tri(wx, wy, wz, _RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2]);
    }
  }
  if (capA) {
    const px = sta[0], py = sta[1];
    const wx = ox + px * c, wy = oy + py, wz = oz - px * s;
    for (let k = 0; k < sd; k++) {
      const k1 = (k + 1) % sd;
      const a = k * 3, b = k1 * 3;
      mb.tri(wx, wy, wz, _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[a], _RING[a + 1], _RING[a + 2]);
    }
  }
}

// Torus lying in the XZ plane. segMajor * segMinor * 6 verts.
function torusY(mb, cx, cy, cz, bigR, smallR, segMajor, segMinor, yaw) {
  const nm = Math.max(3, Math.min(segMajor | 0, MAX_STA));
  const nn = Math.max(3, Math.min(segMinor | 0, MAX_SIDES));
  const R = Math.max(1e-3, bigR);
  const r = Math.max(1e-4, smallR);
  for (let i = 0; i < nm; i++) {
    const ph = (i / nm) * TAU - yaw;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    // a = outward radial, b = +Y, cross(a, b) = the major tangent, so the ring order matches.
    for (let k = 0; k < nn; k++) {
      const th = (k / nn) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const o = (i * nn + k) * 3;
      _RING[o] = cx + (R + r * ct) * cp;
      _RING[o + 1] = cy + r * st;
      _RING[o + 2] = cz + (R + r * ct) * sp;
    }
  }
  for (let i = 0; i < nm; i++) {
    const i1 = (i + 1) % nm;
    for (let k = 0; k < nn; k++) {
      const k1 = (k + 1) % nn;
      const a = (i * nn + k) * 3;
      const b = (i * nn + k1) * 3;
      const cI = (i1 * nn + k1) * 3;
      const d = (i1 * nn + k) * 3;
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[b], _RING[b + 1], _RING[b + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2]);
      mb.tri(_RING[a], _RING[a + 1], _RING[a + 2],
        _RING[cI], _RING[cI + 1], _RING[cI + 2],
        _RING[d], _RING[d + 1], _RING[d + 2]);
    }
  }
}

// One low-poly foliage clump: an irregular bipyramid. Overlapping several of these reads as a
// canopy far better than one sphere does, and at sides*6 verts it is affordable in the thousands.
function blob(mb, rng, cx, cy, cz, rx, ry, rz, sides) {
  const n = Math.max(4, Math.min(sides | 0, MAX_SIDES));
  const phase = rnd(rng) * TAU;
  const ax = Math.max(0.05, rx), ay = Math.max(0.05, ry), az = Math.max(0.05, rz);
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const j = 0.74 + 0.44 * rnd(rng);
    const k = i * 3;
    _BR[k] = cx + ax * j * Math.cos(a);
    _BR[k + 1] = cy + (rnd(rng) - 0.5) * ay * 0.28;
    _BR[k + 2] = cz + az * j * Math.sin(a);
  }
  const ty = cy + ay * (0.86 + 0.30 * rnd(rng));
  const by = cy - ay * (0.64 + 0.28 * rnd(rng));
  const tx = cx + (rnd(rng) - 0.5) * ax * 0.34;
  const tz = cz + (rnd(rng) - 0.5) * az * 0.34;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const m = ((i + 1) % n) * 3;
    mb.tri(tx, ty, tz, _BR[m], _BR[m + 1], _BR[m + 2], _BR[k], _BR[k + 1], _BR[k + 2]);
    mb.tri(cx, by, cz, _BR[k], _BR[k + 1], _BR[k + 2], _BR[m], _BR[m + 1], _BR[m + 2]);
  }
}

/* ================================================================ lighting = */

const _ARM = new Float64Array(MAX_STA * 3);

// The arm and head of one cobra fitting, hung off a mast top at local height `top`.
// Four stations make the boom read as a smooth curve rather than a straight diagonal, which is the
// single thing that separates a cobra head from a generic pole with a box on it.
function cobraArm(mb, ox, oy, oz, c, s, top) {
  _ARM[0] = 0.00; _ARM[1] = top - 0.06; _ARM[2] = 0.088;
  _ARM[3] = 0.62; _ARM[4] = top + 0.46; _ARM[5] = 0.079;
  _ARM[6] = 1.55; _ARM[7] = top + 0.82; _ARM[8] = 0.070;
  _ARM[9] = 2.40; _ARM[10] = top + 0.93; _ARM[11] = 0.062;
  setMat(mb, M.poleGrey);
  sweepL(mb, ox, oy, oz, c, s, _ARM, 4, 3, false, false);

  // Flat-bottomed LED head: deep at the back where it clamps the boom, tapering to the front.
  const lens = top + 0.70;
  setL(0, 2.28, lens, -0.220); setL(1, 3.36, lens, -0.155);
  setL(2, 2.28, top + 0.99, -0.220); setL(3, 3.36, top + 0.87, -0.155);
  setL(4, 2.28, lens, 0.220); setL(5, 3.36, lens, 0.155);
  setL(6, 2.28, top + 0.99, 0.220); setL(7, 3.36, top + 0.87, 0.155);
  setMat(mb, M.lampBody);
  hullL(mb, ox, oy, oz, c, s, F_NOBOT);

  // Emissive only on the underside — the casing must stay a dark shape against the sky.
  setMat(mb, M.ledWhite);
  quadDown(mb, ox, oy, oz, c, s, 2.33, -0.195, 3.31, 0.195, lens - 0.006);
}

// Arterial street lighting: tapered octagonal mast, curved boom, flat-bottomed LED head.
export function appendCobraLamp(mb, x, y, z, yaw, h = 9.5) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 9.5), 4.0, 16.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.12, pz, 0.168, 0.080, hh + 0.12, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.175, 0.175);
  cobraArm(mb, px, py, pz, c, s, hh);
}

// Median lighting: one mast, a boom to each carriageway.
export function appendTwinCobraLamp(mb, x, y, z, yaw, h = 11) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 11), 5.0, 18.0);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.12, pz, 0.192, 0.090, hh + 0.12, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.20, 0.20);
  cobraArm(mb, px, py, pz, Math.cos(a), Math.sin(a), hh);
  const b = a + Math.PI;
  cobraArm(mb, px, py, pz, Math.cos(b), Math.sin(b), hh);
}

// Heritage acorn: the St Lawrence / Distillery / Front St fitting. Base plinth, fluted post,
// ladder bar, faceted acorn globe. No yaw — it is radially symmetric by design.
export function appendAcornLamp(mb, x, y, z, h = 4.6) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const hh = clamp(fin(h, 4.6), 2.8, 8.0);
  const shaftTop = py + hh - 0.78;

  setMat(mb, M.poleDark);
  // Cast plinth — about 480 mm across, which is what these actually measure. A fatter one starts
  // to read as a bollard.
  mb.cylinder(px, py - 0.04, pz, 0.240, 0.196, 0.34, 6, 0, false);
  discY(mb, px, py + 0.30, pz, 0.196, 6, 0, true);
  // Fluted post: an 8-gon reads as fluting at any distance a pedestrian sees it from.
  mb.cylinder(px, py + 0.28, pz, 0.136, 0.068, hh - 1.06, 8, Math.PI / 8, false);
  // Ladder bar — a small crossbar, and one of the strongest silhouette cues on these poles.
  beamL(mb, px, shaftTop - 0.30, pz, 1, 0, -0.30, 0, 0, 0.30, 0, 0, 0.026, 0.021, F_ALL);

  // Faceted acorn globe: flare, belly, then the cap taper.
  setMat(mb, M.acornWarm);
  mb.cylinder(px, shaftTop, pz, 0.085, 0.215, 0.20, 6, 0, false);
  mb.cylinder(px, shaftTop + 0.20, pz, 0.215, 0.190, 0.24, 6, 0, false);
  setMat(mb, M.poleDark);
  mb.cylinder(px, shaftTop + 0.44, pz, 0.196, 0.052, 0.28, 6, 0, false);
}

// Pedestrian-scale pole with a short downlight arm, used on sidewalks and in squares.
export function appendPedestrianLamp(mb, x, y, z, yaw, h = 5.2) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 5.2), 2.6, 9.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleGrey);
  mb.cylinder(px, py - 0.04, pz, 0.140, 0.115, 0.30, 6, a, false);
  mb.cylinder(px, py + 0.26, pz, 0.098, 0.062, hh - 0.26, 6, a, false);
  mb.planeY(px, py + hh, pz, 0.14, 0.14);

  _ARM[0] = 0.00; _ARM[1] = hh - 0.06; _ARM[2] = 0.055;
  _ARM[3] = 0.34; _ARM[4] = hh + 0.20; _ARM[5] = 0.050;
  _ARM[6] = 0.66; _ARM[7] = hh + 0.28; _ARM[8] = 0.045;
  sweepL(mb, px, py, pz, c, s, _ARM, 3, 3, false, false);

  const lens = hh + 0.06;
  setL(0, 0.56, lens, -0.160); setL(1, 0.96, lens, -0.108);
  setL(2, 0.56, hh + 0.32, -0.160); setL(3, 0.96, hh + 0.25, -0.108);
  setL(4, 0.56, lens, 0.160); setL(5, 0.96, lens, 0.108);
  setL(6, 0.56, hh + 0.32, 0.160); setL(7, 0.96, hh + 0.25, 0.108);
  setMat(mb, M.lampBody);
  hullL(mb, px, py, pz, c, s, F_NOBOT);
  setMat(mb, M.sodium);
  quadDown(mb, px, py, pz, c, s, 0.60, -0.135, 0.92, 0.135, lens - 0.006);
}

// Streetcar overhead: pole, bracket arm over the track, tie strut and an insulator. The wire
// itself is drawn by city.js between consecutive poles, hanging off this insulator.
export function appendCatenaryPole(mb, x, y, z, yaw, h = 8.2) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const hh = clamp(fin(h, 8.2), 5.0, 13.0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleDark);
  mb.cylinder(px, py - 0.05, pz, 0.245, 0.205, 0.45, 6, a, false);
  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.40, pz, 0.150, 0.088, hh - 0.40, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + hh, pz, 0.16, 0.16);

  // Bracket arm out over the running rail, with a diagonal tie back to the pole.
  const armY = hh - 0.55;
  beamL(mb, px, py, pz, c, s, 0.10, armY, 0, 1.95, armY + 0.13, 0, 0.055, 0.055,
    F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0.09, armY - 0.82, 0, 1.52, armY + 0.09, 0, 0.038, 0.038,
    F_SIDES);

  // Insulator, hung under the arm end.
  //
  // WIRE ATTACHMENT POINT for city.js, in world metres:
  //     wx = x + 1.86 * cos(yaw)
  //     wy = y + h - 0.85                      (= h - 0.55 armY, - 0.30 insulator drop)
  //     wz = z - 1.86 * sin(yaw)
  // Run the contact wire between consecutive poles' attachment points and it lands on the
  // insulator's underside at both ends.
  setMat(mb, M.castIron);
  const ix = px + 1.86 * c, iz = pz - 1.86 * s;
  mb.cylinder(ix, py + armY - 0.30, iz, 0.052, 0.062, 0.19, 5, a, false);
}

// Signalised intersection: mast arm over the carriageway with two 3-lamp heads hung from it,
// a pedestrian head and a push button on the post.
// The arm reaches along local +X, i.e. world (cos yaw, 0, -sin yaw); the lamp faces look along
// local -Z, i.e. world (-sin yaw, 0, -cos yaw) — the arm direction turned 90 deg counter-clockwise
// in plan, which is where oncoming traffic sits.
export function appendTrafficSignal(mb, x, y, z, yaw, armLen) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(armLen, 7.5), 2.5, 13.0);
  const c = Math.cos(a), s = Math.sin(a);
  const poleTop = 6.40;

  setMat(mb, M.concrete);
  mb.cylinder(px, py - 0.06, pz, 0.300, 0.260, 0.52, 6, a, false);
  setMat(mb, M.poleGrey);
  mb.cylinder(px, py + 0.46, pz, 0.185, 0.125, poleTop - 0.46, 8, a + Math.PI / 8, false);
  mb.planeY(px, py + poleTop, pz, 0.19, 0.19);

  // Mast arm plus its tie strut.
  beamL(mb, px, py, pz, c, s, 0.10, poleTop - 0.10, 0, L, poleTop + 0.34, 0, 0.098, 0.098,
    F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0.10, poleTop - 1.45, 0, L * 0.42, poleTop + 0.08, 0,
    0.052, 0.052, F_SIDES);

  // Two hanging 3-lamp heads. One lamp lit, chosen per intersection so the city is not all red.
  const phase = (hash2(px, pz) * 3) | 0;
  const lit = phase === 0 ? M.sigRed : (phase === 1 ? M.sigGreen : M.sigAmber);
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? 0.44 : 0.82;
    const hx = L * t;
    const armY = poleTop - 0.10 + (poleTop + 0.34 - (poleTop - 0.10)) * t;
    const bt = armY - 0.10;
    const bb = bt - 0.30;
    setMat(mb, M.poleGrey);
    boxL(mb, px, py, pz, c, s, hx - 0.055, bb, -0.055, hx + 0.055, bt, 0.055, F_SIDES);
    // Head body: three lamp bays stacked vertically.
    const top = bb + 0.02;
    const bot = top - 1.02;
    setMat(mb, M.signalBody);
    boxL(mb, px, py, pz, c, s, hx - 0.17, bot, -0.185, hx + 0.17, top, 0.185, F_NOBOT);
    // Lenses on the -Z face; exactly one is a genuine emitter.
    const lz = -0.190;
    for (let k = 0; k < 3; k++) {
      const cy0 = bot + 0.10 + k * 0.31;
      setMat(mb, k === 2 - phase ? lit : M.dark);
      quadNZ(mb, px, py, pz, c, s, lz, hx - 0.115, cy0, hx + 0.115, cy0 + 0.22);
    }
  }

  // Pedestrian head on the post.
  setMat(mb, M.signalBody);
  boxL(mb, px, py, pz, c, s, -0.21, 2.42, -0.36, 0.21, 2.92, -0.14, F_ALL);
  setMat(mb, M.sigHand);
  quadNZ(mb, px, py, pz, c, s, -0.365, -0.17, 2.48, 0.17, 2.86);

  // Push button assembly at hand height.
  setMat(mb, M.poleGrey);
  boxL(mb, px, py, pz, c, s, -0.075, 1.00, -0.30, 0.075, 1.22, -0.16, F_NOBOT);
}

// Street-name blades plus a regulatory plate. rng picks the plate.
export function appendSignPost(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.galv);
  mb.cylinder(px, py - 0.05, pz, 0.048, 0.042, 3.00, 4, a + Math.PI / 4, false);
  discY(mb, px, py + 2.95, pz, 0.055, 4, a + Math.PI / 4, true);

  // Crossed blades, the way Toronto hangs a street name over each approach.
  setMat(mb, M.signGreen);
  boxL(mb, px, py, pz, c, s, -0.013, 2.55, -0.50, 0.013, 2.78, 0.50, F_BLADEX);
  boxL(mb, px, py, pz, c, s, -0.46, 2.28, -0.013, 0.46, 2.51, 0.013, F_BLADEZ);

  const roll = rnd(rng);
  if (roll < 0.72) {
    setMat(mb, roll < 0.34 ? M.signWhite : M.signRed);
    boxL(mb, px, py, pz, c, s, -0.011, 1.52, -0.21, 0.011, 2.02, 0.21, F_BLADEX);
  }
}

/* =============================================================== furniture = */

// Slatted street bench: length along local Z, seat facing +X.
export function appendBench(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  // Open end frames — a front leg and a back leg that carries on up into the backrest. A single
  // full-height end panel is cheaper but reads as a solid slab from any distance; the gap under
  // the seat is most of what makes this look like a bench.
  setMat(mb, M.castIron);
  for (let i = 0; i < 2; i++) {
    const zc = i === 0 ? -0.80 : 0.80;
    boxL(mb, px, py, pz, c, s, 0.13, 0.01, zc - 0.028, 0.29, 0.47, zc + 0.028, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -0.30, 0.01, zc - 0.028, -0.16, 0.92, zc + 0.028, F_NOBOT);
  }

  setMat(mb, M.woodSlat);
  for (let i = 0; i < 3; i++) {
    const x0 = -0.27 + i * 0.20;
    boxL(mb, px, py, pz, c, s, x0, 0.43, -0.87, x0 + 0.16, 0.48, 0.87, F_NOBOT);
  }
  for (let i = 0; i < 2; i++) {
    const y0 = 0.60 + i * 0.15;
    boxL(mb, px, py, pz, c, s, -0.29, y0, -0.87, -0.25, y0 + 0.12, 0.87, F_BLADEX);
  }
}

// Two-stream bin (waste + recycling) under one curved hood — the standard downtown unit.
export function appendLitterBin(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.binBody);
  boxL(mb, px, py, pz, c, s, -0.29, 0.00, -0.55, 0.29, 0.92, -0.02, F_NOBOT);
  setMat(mb, M.binRecycle);
  boxL(mb, px, py, pz, c, s, -0.29, 0.00, 0.02, 0.29, 0.92, 0.55, F_NOBOT);

  // Two-stage taper so the hood reads as curved rather than as a lid.
  setMat(mb, M.binHood);
  frustL(mb, px, py, pz, c, s, 0.92, 1.02,
    -0.31, -0.57, 0.31, 0.57, -0.29, -0.55, 0.29, 0.55, F_SIDES);
  frustL(mb, px, py, pz, c, s, 1.02, 1.13,
    -0.29, -0.55, 0.29, 0.55, -0.17, -0.46, 0.17, 0.46, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.28, 0.92, -0.015, 0.28, 1.16, 0.015, F_PLATEZ);

  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.294, 0.58, -0.46, 0.86, -0.10);
  quadPX(mb, px, py, pz, c, s, 0.294, 0.58, 0.10, 0.86, 0.46);
}

// Toronto's ring-and-post rack: a short post with a horizontal ring.
export function appendBikeRing(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);

  setMat(mb, M.galv);
  mb.cylinder(px, py - 0.04, pz, 0.056, 0.050, 0.90, 6, a, false);
  discY(mb, px, py + 0.86, pz, 0.050, 6, a, true);
  torusY(mb, px, py + 0.60, pz, 0.235, 0.028, 7, 3, a);
}

export function appendBollard(mb, x, y, z) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  setMat(mb, M.castIron);
  mb.cylinder(px, py - 0.04, pz, 0.098, 0.084, 0.99, 6, 0, false);
  discY(mb, px, py + 0.95, pz, 0.084, 6, 0, true);
}

// Precast planter with soil and a couple of shrub clumps. `s` scales the tub.
export function appendPlanter(mb, rng, x, y, z, s) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(s, 1.1), 0.5, 3.2);
  const hh = 0.60 * sc;

  setMat(mb, M.concrete);
  frustL(mb, px, py, pz, 1, 0, 0, hh,
    -0.40 * sc, -0.40 * sc, 0.40 * sc, 0.40 * sc,
    -0.48 * sc, -0.48 * sc, 0.48 * sc, 0.48 * sc, F_NOBOT);
  setMat(mb, M.soil);
  quadUp(mb, px, py, pz, 1, 0, -0.43 * sc, -0.43 * sc, 0.43 * sc, 0.43 * sc, hh + 0.02);

  setMat(mb, M.foliage);
  const n = rnd(rng) < 0.45 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const rad = rr(rng, 0.03, 0.26) * sc;
    // Vertical radius first, then a centre height under half of it: blob()'s lower apex reaches
    // 0.64..0.92 of the vertical radius, so this guarantees the clump beds into the soil instead
    // of hovering above it.
    const vy = rr(rng, 0.18, 0.28) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * rad, py + hh + vy * 0.40, pz + Math.sin(ang) * rad,
      rr(rng, 0.24, 0.36) * sc, vy, rr(rng, 0.24, 0.36) * sc, 5);
  }
}

// Hydrant: barrel, shoulder flange, bonnet and two side outlets. The outlets read from the far
// side of a street even when the barrel does not.
export function appendHydrant(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.hydBody);
  mb.cylinder(px, py - 0.03, pz, 0.135, 0.110, 0.59, 6, a, false);
  mb.cylinder(px, py + 0.56, pz, 0.152, 0.126, 0.09, 6, a, false);
  // Side outlets.
  beamL(mb, px, py, pz, c, s, 0, 0.42, 0.085, 0, 0.42, 0.225, 0.052, 0.052, F_SIDES | F_PZ);
  beamL(mb, px, py, pz, c, s, 0, 0.42, -0.085, 0, 0.42, -0.225, 0.052, 0.052, F_SIDES | F_NZ);

  setMat(mb, M.hydCap);
  mb.cylinder(px, py + 0.65, pz, 0.128, 0.072, 0.17, 6, a, false);
  discY(mb, px, py + 0.82, pz, 0.072, 6, a, true);
}

// Canada Post street letter box.
export function appendMailbox(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.22, 0.00, -0.24, 0.22, 0.14, 0.24, F_NOBOT);
  setMat(mb, M.postRed);
  boxL(mb, px, py, pz, c, s, -0.25, 0.14, -0.31, 0.25, 1.00, 0.31, F_SIDES);
  frustL(mb, px, py, pz, c, s, 1.00, 1.20,
    -0.25, -0.31, 0.25, 0.31, -0.15, -0.23, 0.17, 0.23, F_NOBOT);
  // Pull flap and slot.
  boxL(mb, px, py, pz, c, s, 0.25, 0.78, -0.22, 0.30, 0.86, 0.22, F_PX | F_PY);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.253, 0.86, -0.20, 0.95, 0.20);
}

// Newspaper / listings vending box. rng picks the livery.
export function appendNewsBox(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.16, 0.00, -0.16, 0.16, 0.22, 0.16, F_SIDES);
  setMat(mb, pickOf(rng, NEWSBOX_COLOURS));
  boxL(mb, px, py, pz, c, s, -0.23, 0.22, -0.21, 0.23, 0.98, 0.21, F_NOBOT);
  // Hood, sloping down toward the front.
  setL(0, -0.23, 0.98, -0.21); setL(1, 0.23, 0.98, -0.21);
  setL(2, -0.23, 1.22, -0.21); setL(3, 0.23, 1.06, -0.21);
  setL(4, -0.23, 0.98, 0.21); setL(5, 0.23, 0.98, 0.21);
  setL(6, -0.23, 1.22, 0.21); setL(7, 0.23, 1.06, 0.21);
  hullL(mb, px, py, pz, c, s, F_NOBOT);

  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, 0.233, 0.54, -0.17, 0.94, 0.17);
}

// Pay-and-display machine: slim column, keypad head, solar cap.
export function appendParkingMachine(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.15, 0.00, -0.21, 0.15, 0.10, 0.21, F_NOBOT);
  setMat(mb, M.cabGrey);
  frustL(mb, px, py, pz, c, s, 0.10, 1.05,
    -0.12, -0.17, 0.12, 0.17, -0.11, -0.155, 0.11, 0.155, F_SIDES);
  boxL(mb, px, py, pz, c, s, -0.16, 1.05, -0.22, 0.16, 1.62, 0.22, F_NOBOT);
  setMat(mb, M.screen);
  quadPX(mb, px, py, pz, c, s, 0.163, 1.20, -0.16, 1.46, 0.16);
  setMat(mb, M.greenP);
  quadPX(mb, px, py, pz, c, s, 0.163, 1.49, -0.13, 1.59, 0.13);
  // Solar cap, tilted up toward the south.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, -0.14, 1.64, 0, 0.20, 1.75, 0, 0.20, 0.014, F_BLADEX);
}

// Glazed transit shelter with a backlit end panel. Length runs along local Z, opening at +X.
export function appendTransitShelter(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(len, 4.6), 2.4, 9.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.steel);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? 0.74 : -0.74;
    const cz = (i & 2) ? hl - 0.07 : -(hl - 0.07);
    boxL(mb, px, py, pz, c, s, cx - 0.045, 0.00, cz - 0.045, cx + 0.045, 2.42, cz + 0.045,
      F_SIDES);
  }
  // Back header rail.
  boxL(mb, px, py, pz, c, s, -0.80, 2.28, -hl, -0.68, 2.40, hl, F_SIDES);

  setMat(mb, M.glass);
  boxL(mb, px, py, pz, c, s, -0.757, 0.28, -(hl - 0.10), -0.727, 2.28, hl - 0.10, F_PLATEX);
  boxL(mb, px, py, pz, c, s, -0.72, 0.28, hl - 0.085, 0.70, 2.28, hl - 0.055, F_PLATEZ);

  // Backlit advertising panel closing the other end.
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.70, 0.22, -(hl - 0.02), 0.70, 2.34, -(hl - 0.17), F_NOBOT);
  setMat(mb, M.adPanel);
  quadNZ(mb, px, py, pz, c, s, -(hl - 0.016), -0.62, 0.34, 0.62, 2.22);
  quadPZ(mb, px, py, pz, c, s, -(hl - 0.156), -0.62, 0.34, 0.62, 2.22);

  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.95, 2.42, -(hl + 0.18), 0.95, 2.57, hl + 0.18, F_ALL);
}

// Streetcar island platform: raised slab, tactile edge, light canopy and a back rail.
export function appendPlatformShelter(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const L = clamp(fin(len, 12.0), 4.0, 40.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -1.35, 0.00, -hl, 1.35, 0.19, hl, F_NOBOT);
  setMat(mb, M.granite);
  quadUp(mb, px, py, pz, c, s, 1.03, -hl, 1.33, hl, 0.192);
  quadUp(mb, px, py, pz, c, s, -1.33, -hl, -1.03, hl, 0.192);

  setMat(mb, M.steel);
  const chl = Math.min(hl - 0.30, 3.0);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? 0.55 : -0.55;
    const cz = (i & 2) ? chl : -chl;
    boxL(mb, px, py, pz, c, s, cx - 0.042, 0.19, cz - 0.042, cx + 0.042, 2.56, cz + 0.042,
      F_SIDES);
  }
  boxL(mb, px, py, pz, c, s, -1.15, 2.56, -(chl + 0.35), 1.15, 2.72, chl + 0.35, F_ALL);

  setMat(mb, M.glass);
  boxL(mb, px, py, pz, c, s, -0.50, 0.19, -(chl + 0.02), 1.10, 1.95, -(chl - 0.01), F_PLATEZ);

  // Back rail along the track side.
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -1.28, 0.95, -hl, -1.20, 1.03, hl, F_SIDES);
  for (let i = 0; i < 2; i++) {
    const cz = i === 0 ? -hl * 0.5 : hl * 0.5;
    boxL(mb, px, py, pz, c, s, -1.27, 0.19, cz - 0.032, -1.21, 1.03, cz + 0.032, F_SIDES);
  }
}

/* ============================================================== vegetation = */

// Tree-pit grate: a shallow granite bevel down to a cast grate flush with the sidewalk.
function treePit(mb, px, py, pz, c, s, r) {
  const o = r * 1.24;
  setMat(mb, M.granite);
  quadL(mb, px, py, pz, c, s, -o, 0.03, o, o, 0.03, o, r, 0.00, r, -r, 0.00, r);
  quadL(mb, px, py, pz, c, s, o, 0.03, o, o, 0.03, -o, r, 0.00, -r, r, 0.00, r);
  quadL(mb, px, py, pz, c, s, o, 0.03, -o, -o, 0.03, -o, -r, 0.00, -r, r, 0.00, -r);
  quadL(mb, px, py, pz, c, s, -o, 0.03, -o, -o, 0.03, o, -r, 0.00, r, -r, 0.00, -r);
  setMat(mb, M.grateIron);
  quadUp(mb, px, py, pz, c, s, -r, -r, r, r, 0.005);
}

// Irregular two-section trunk. Returns nothing; the caller places the canopy above it.
function trunk(mb, rng, px, py, pz, r0, r1, r2, h0, h1) {
  const lean = rr(rng, -0.055, 0.055);
  const lz = rr(rng, -0.055, 0.055);
  setMat(mb, rnd(rng) < 0.35 ? M.barkPale : M.bark);
  mb.cylinder(px, py - 0.05, pz, r0, r1, h0 + 0.05, 5, rr(rng, 0, TAU), false);
  mb.cylinder(px + lean, py + h0, pz + lz, r1 * 1.02, r2, h1, 5, rr(rng, 0, TAU), false);
}

// Street tree in a pit: grate, slightly irregular trunk, canopy of overlapping clumps.
export function appendStreetTree(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.45, 2.6);
  const a = rr(rng, 0, TAU);

  treePit(mb, px, py, pz, Math.cos(a), Math.sin(a), 0.62 * sc);

  const h0 = 1.35 * sc, h1 = 1.55 * sc;
  trunk(mb, rng, px, py, pz, 0.20 * sc, 0.132 * sc, 0.086 * sc, h0, h1);

  const cy = py + h0 + h1;
  const rad = 1.30 * sc;
  const leaf = rnd(rng) < 0.4 ? M.foliageWarm : (rnd(rng) < 0.5 ? M.foliageCool : M.foliage);
  setMat(mb, leaf);
  blob(mb, rng, px, cy + 0.30 * sc, pz, rad, 0.92 * sc, rad, 6);
  for (let i = 0; i < 3; i++) {
    const ang = a + (i / 3) * TAU + rr(rng, -0.4, 0.4);
    const off = rr(rng, 0.45, 0.85) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, cy + rr(rng, -0.15, 0.55) * sc, pz + Math.sin(ang) * off,
      rr(rng, 0.62, 0.95) * sc, rr(rng, 0.52, 0.78) * sc, rr(rng, 0.62, 0.95) * sc, 6);
  }
}

// Park tree: no pit, taller, branching, a fuller canopy.
export function appendParkTree(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.45, 3.2);
  const a = rr(rng, 0, TAU);

  const h0 = 1.70 * sc, h1 = 2.10 * sc;
  trunk(mb, rng, px, py, pz, 0.28 * sc, 0.185 * sc, 0.115 * sc, h0, h1);

  const forkY = py + h0 + h1 * 0.55;
  for (let i = 0; i < 2; i++) {
    const ang = a + i * Math.PI + rr(rng, -0.5, 0.5);
    beam(mb,
      px, forkY, pz,
      px + Math.cos(ang) * 0.85 * sc, forkY + rr(rng, 0.85, 1.35) * sc,
      pz + Math.sin(ang) * 0.85 * sc,
      0.055 * sc, 0.055 * sc, F_SIDES);
  }

  // Canopy: the centre clump is deliberately NOT much bigger than the satellites, otherwise it
  // swallows them and the tree reads as one smooth cone instead of a lumpy crown.
  const cy = py + h0 + h1 + 0.35 * sc;
  const rad = 1.42 * sc;
  const leaf = rnd(rng) < 0.45 ? M.foliageWarm : (rnd(rng) < 0.5 ? M.foliageCool : M.foliage);
  setMat(mb, leaf);
  blob(mb, rng, px, cy + 0.30 * sc, pz, rad, 1.10 * sc, rad, 6);
  for (let i = 0; i < 4; i++) {
    const ang = a + (i / 4) * TAU + rr(rng, -0.40, 0.40);
    const off = rr(rng, 0.85, 1.50) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, cy + rr(rng, -0.55, 0.75) * sc, pz + Math.sin(ang) * off,
      rr(rng, 0.95, 1.45) * sc, rr(rng, 0.70, 1.10) * sc, rr(rng, 0.95, 1.45) * sc, 6);
  }
}

export function appendShrub(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.3, 3.0);
  setMat(mb, rnd(rng) < 0.5 ? M.foliage : M.foliageCool);
  const n = rnd(rng) < 0.5 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const off = rr(rng, 0.0, 0.30) * sc;
    // See appendPlanter: centre height is derived from the vertical radius so the clump always
    // beds into the ground rather than floating over it.
    const vy = rr(rng, 0.30, 0.46) * sc;
    blob(mb, rng,
      px + Math.cos(ang) * off, py + vy * 0.42, pz + Math.sin(ang) * off,
      rr(rng, 0.34, 0.52) * sc, vy, rr(rng, 0.34, 0.52) * sc, 5);
  }
}

/* ================================================================= utility = */

export function appendManhole(mb, x, y, z) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  // Two stacked discs: the seating ring and the cover proper. Both sit clear of the carriageway
  // plane so they cannot z-fight with the road ribbon the caller placed them on.
  setMat(mb, M.castIron);
  discY(mb, px, py + 0.014, pz, 0.415, 8, 0, true);
  setMat(mb, M.grateIron);
  discY(mb, px, py + 0.030, pz, 0.355, 10, 0.3, true);
}

// Kerbside catch basin. Long axis along local Z, against the kerb at -X.
export function appendGrate(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.32, -0.03, -0.42, 0.32, 0.025, 0.42, F_NOBOT);
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -0.26, -0.36, 0.26, 0.36, 0.004);
  setMat(mb, M.grateIron);
  for (let i = 0; i < 3; i++) {
    const z0 = -0.30 + i * 0.20;
    quadUp(mb, px, py, pz, c, s, -0.26, z0, 0.26, z0 + 0.10, 0.028);
  }
}

// Traffic controller / telecom cabinet on its pad. rng varies size and livery.
export function appendUtilityBox(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = fin(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const w = rr(rng, 0.44, 0.62);
  const d = rr(rng, 0.28, 0.38);
  const hh = rr(rng, 1.05, 1.40);

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -w - 0.08, 0.00, -d - 0.08, w + 0.08, 0.09, d + 0.08, F_NOBOT);
  setMat(mb, pickOf(rng, CABINET_COLOURS));
  frustL(mb, px, py, pz, c, s, 0.09, hh,
    -w, -d, w, d, -w + 0.015, -d + 0.012, w - 0.015, d - 0.012, F_SIDES);
  boxL(mb, px, py, pz, c, s, -w - 0.04, hh, -d - 0.04, w + 0.04, hh + 0.075, d + 0.04, F_ALL);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, w - 0.008, 0.18, -d + 0.06, hh - 0.10, d - 0.06);
}

/* =============================================================== roofscape = */
// Everything from here down follows the same rules as the street furniture above: local +X is
// out/front, long objects run their length along local Z, (x, y, z) is the footprint centre at the
// surface the piece stands on, every numeric argument goes through fin() plus a clamp, and every
// rng draw goes through rnd(). profile is 0 and tintable is 0 on every vertex; emissive is 0
// except on the four genuine light sources below (tower-sign faces, crane beacon, antenna beacon,
// sidewalk-shed lamps), which the renderer switches with time of day.
//
// FACE MASKS FOR beam()/beamL(): beam builds its hull in a frame where the mask's "X" bits are the
// width axis, the "Y" bits the thickness axis and the "Z" bits the two END CAPS. A member that
// must be closed along its length therefore uses F_BLADEX (its four long faces); F_SIDES on a beam
// would leave the thickness faces open. boxL/frustL/hullL are in true local axes and keep the
// ordinary meaning.

// Illuminated corporate signage on a tower crown — the bank logos that identify the Financial
// District skyline from anywhere in the city. Channel letters standing proud of a dark raceway:
// bright acrylic faces, dark returns, so the piece reads as a dark band by day and a row of
// glowing letters at night with no special-casing.
//
// (x, y, z) is the centre of the sign's bottom edge at the level the letters stand on. The sign
// faces local +X (out from the parapet) and its width runs along local Z. `w` is the overall
// width, `h` the cap height of the letters, `hue` a hue in turns (0 red, 1/3 green, 2/3 blue).
export function appendTowerSign(mb, rng, x, y, z, yaw, w, h, hue) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 8), 1.6, 44.0);
  const H = clamp(fin(h, 2.4), 0.5, 12.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;
  const depth = clamp(H * 0.16, 0.10, 0.45);

  // Backing raceway. Genuinely dark paint, not a darkened "night" tint.
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, -0.17, -H * 0.10, -hw - 0.10, 0.00, H * 1.10, hw + 0.10, F_ALL);

  // Standoffs back to the parapet.
  setMat(mb, M.steel);
  for (let i = 0; i < 2; i++) {
    const sy = H * (i === 0 ? 0.22 : 0.78);
    beamL(mb, px, py, pz, c, s, -0.52, sy, 0, -0.17, sy, 0, 0.055, 0.055, F_BLADEX);
  }

  // Channel letters. The count follows the width so the letterform proportion stays sane.
  const n = (clamp(Math.round(W / 1.45), 2, 5)) | 0;
  const pitch = W / n;
  hueRGB(fin(hue, 0.58));
  for (let i = 0; i < n; i++) {
    const cz = -hw + pitch * (i + 0.5);
    const lw = pitch * (0.34 + 0.14 * rnd(rng));
    const lh = H * (0.74 + 0.26 * rnd(rng));
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, 0.00, 0.0, cz - lw, depth, lh, cz + lw,
      F_PX | F_PY | F_NY | F_PZ | F_NZ);
    mb.color(_RGB[0], _RGB[1], _RGB[2], 0.90, 0, 0.35, 0);
    quadPX(mb, px, py, pz, c, s, depth + 0.004,
      0.018, cz - lw + 0.018, lh - 0.018, cz + lw - 0.018);
  }
}

// Tower crane. Toronto runs more of these than any other city on the continent and a skyline
// without them is simply wrong. The lattice is simplified to four chords plus tie collars, but
// every part that carries the silhouette is here: slewing unit, operator cab, A-frame, hammerhead
// jib on three tapering chords, counter-jib with its counterweight slab, trolley, hoist rope,
// hook block and the red obstruction light at the apex.
//
// (x, y, z) is the base centre at ground level and `h` the height to the slewing ring. The jib
// reaches along local +X, the counter-jib along local -X.
export function appendConstructionCrane(mb, rng, x, y, z, yaw, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const H = clamp(fin(h, 62), 16.0, 150.0);
  const c = Math.cos(a), s = Math.sin(a);

  const sm = clamp(H * 0.030, 1.5, 2.6);        // mast face width
  const hm = sm * 0.5;
  const cr = clamp(sm * 0.055, 0.07, 0.16);     // chord half-thickness
  const jib = clamp(H * 0.78, 15.0, 70.0);
  const cj = clamp(jib * 0.30, 5.0, 20.0);
  const jibY = H + 1.55;
  const apexY = jibY + clamp(jib * 0.16, 3.0, 9.0);

  // Ballast pad.
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -sm * 1.30, -0.30, -sm * 1.30, sm * 1.30, 0.34, sm * 1.30, F_SIDES);

  // Mast: four corner chords plus tie collars. Real diagonals would cost four times as much and
  // at any distance a crane is actually seen from, the collars carry the same read.
  setMat(mb, M.craneYellow);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? hm : -hm;
    const cz = (i & 2) ? hm : -hm;
    boxL(mb, px, py, pz, c, s, cx - cr, 0.0, cz - cr, cx + cr, H, cz + cr, F_SIDES);
  }
  setMat(mb, M.galv);
  for (let i = 0; i < 3; i++) {
    const cy = H * (0.24 + 0.25 * i);
    boxL(mb, px, py, pz, c, s, -hm - cr, cy, -hm - cr, hm + cr, cy + 0.17, hm + cr, F_SIDES);
  }

  // Slewing ring.
  setMat(mb, M.craneYellow);
  mb.cylinder(px, py + H, pz, hm * 1.26, hm * 1.04, 0.92, 6, a, false);

  // Machinery house on the counter-jib, operator cab under the jib root.
  setMat(mb, M.craneWhite);
  boxL(mb, px, py, pz, c, s, -cj * 0.88, jibY - 0.35, -sm * 0.50,
    -cj * 0.24, jibY + 1.45, sm * 0.50, F_NOBOT);
  boxL(mb, px, py, pz, c, s, hm + 0.10, H + 0.92, -sm * 0.62,
    hm + 1.95, H + 3.15, sm * 0.08, F_NOBOT);
  setMat(mb, M.glass);
  quadPX(mb, px, py, pz, c, s, hm + 1.955, H + 1.30, -sm * 0.55, H + 2.95, sm * 0.02);

  // A-frame over the slewing unit.
  setMat(mb, M.craneYellow);
  for (let i = 0; i < 2; i++) {
    const lz = (i === 0 ? -1 : 1) * hm * 0.78;
    beamL(mb, px, py, pz, c, s, -0.18, jibY + 0.10, lz, 0.0, apexY, 0.0, 0.10, 0.10, F_BLADEX);
  }

  // Hammerhead jib: one top chord and two bottom chords, all tapering to the tip, plus a web post.
  // Three chords is what makes it read as a triangular-section boom rather than a stick.
  const tipT = 0.055;
  setL(0, hm * 0.70, jibY + 0.52, -0.11); setL(1, jib, jibY + 0.30, -tipT);
  setL(2, hm * 0.70, jibY + 0.76, -0.11); setL(3, jib, jibY + 0.42, -tipT);
  setL(4, hm * 0.70, jibY + 0.52, 0.11); setL(5, jib, jibY + 0.30, tipT);
  setL(6, hm * 0.70, jibY + 0.76, 0.11); setL(7, jib, jibY + 0.42, tipT);
  hullL(mb, px, py, pz, c, s, F_BLADEZ);
  for (let i = 0; i < 2; i++) {
    const bz = (i === 0 ? -1 : 1) * sm * 0.36;
    setL(0, hm * 0.70, jibY - 0.50, bz - 0.10); setL(1, jib * 0.99, jibY + 0.12, bz - tipT);
    setL(2, hm * 0.70, jibY - 0.26, bz - 0.10); setL(3, jib * 0.99, jibY + 0.24, bz - tipT);
    setL(4, hm * 0.70, jibY - 0.50, bz + 0.10); setL(5, jib * 0.99, jibY + 0.12, bz + tipT);
    setL(6, hm * 0.70, jibY - 0.26, bz + 0.10); setL(7, jib * 0.99, jibY + 0.24, bz + tipT);
    hullL(mb, px, py, pz, c, s, F_BLADEZ);
  }
  beamL(mb, px, py, pz, c, s,
    jib * 0.46, jibY + 0.60, 0, jib * 0.46, jibY - 0.22, 0, 0.06, 0.06, F_BLADEX);

  // Counter-jib and its counterweight slab.
  for (let i = 0; i < 2; i++) {
    const cy = jibY + (i === 0 ? 0.52 : -0.42);
    boxL(mb, px, py, pz, c, s, -cj, cy, -sm * 0.30, -hm * 0.70, cy + 0.22, sm * 0.30, F_BLADEZ);
  }
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -cj - 0.55, jibY - 1.45, -sm * 0.56,
    -cj + 0.35, jibY + 0.55, sm * 0.56, F_ALL);

  // Pendant ties from the A-frame apex.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, 0, apexY, 0, jib * 0.64, jibY + 0.70, 0, 0.055, 0.055, F_BLADEX);
  beamL(mb, px, py, pz, c, s, 0, apexY, 0, -cj * 0.86, jibY + 0.62, 0, 0.055, 0.055, F_BLADEX);

  // Trolley, hoist rope and hook block.
  const tx = jib * (0.34 + 0.50 * rnd(rng));
  const hookY = H * (0.22 + 0.52 * rnd(rng));
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, tx - 0.55, jibY - 0.92, -0.32, tx + 0.55, jibY - 0.34, 0.32, F_NOBOT);
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, tx, jibY - 0.92, 0, tx, hookY, 0, 0.035, 0.035, F_BLADEX);
  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, tx - 0.26, hookY - 0.78, -0.22, tx + 0.26, hookY, 0.22, F_NOBOT);

  // Aviation obstruction light at the apex — a real lamp, so the renderer owns when it is on.
  setMat(mb, M.beaconRed);
  mb.cylinder(px, py + apexY, pz, 0.105, 0.085, 0.22, 4, a, false);
  discY(mb, px, py + apexY + 0.22, pz, 0.085, 4, a, true);
}

// Rooftop HVAC plant: curb, casing, condenser fan wells with grilles, an intake hood and a
// refrigerant riser. `w` is the plan size along local Z, `d` the depth along local X, `h` the
// casing height above the roof.
export function appendRooftopUnit(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3.4), 0.9, 16.0);
  const D = clamp(fin(d, 2.0), 0.7, 12.0);
  const H = clamp(fin(h, 1.5), 0.5, 5.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hd - 0.10, 0.0, -hw - 0.10, hd + 0.10, 0.22, hw + 0.10, F_SIDES);

  setMat(mb, rnd(rng) < 0.55 ? M.galvPale : M.alum);
  boxL(mb, px, py, pz, c, s, -hd, 0.18, -hw, hd, 0.18 + H, hw, F_NOBOT);

  // Bolted access panels, standing proud of the casing so the sun rakes their edges.
  setMat(mb, M.alum);
  quadPX(mb, px, py, pz, c, s, hd + 0.012, 0.30, -hw * 0.90, 0.18 + H * 0.86, -hw * 0.06);
  quadPX(mb, px, py, pz, c, s, hd + 0.012, 0.30, hw * 0.06, 0.18 + H * 0.86, hw * 0.90);

  // Condenser fan wells.
  const nf = (clamp(Math.round(W / 2.4), 1, 3)) | 0;
  const fr = Math.min(hd * 0.72, (W / nf) * 0.34);
  const topY = py + 0.18 + H;
  for (let i = 0; i < nf; i++) {
    const lz = W * ((i + 0.5) / nf - 0.5);
    const wx = px + lz * s, wz = pz + lz * c;
    // The grille closes the cowl at ITS OWN rim height: a fixed height would leave the cowl's
    // inner wall visible over the grille from any raised viewpoint.
    const fh = 0.26 + 0.10 * rnd(rng);
    setMat(mb, M.galv);
    mb.cylinder(wx, topY, wz, fr, fr * 0.94, fh, 6, a, false);
    setMat(mb, M.grateIron);
    discY(mb, wx, topY + fh, wz, fr * 0.94, 6, a, true);
  }

  // Intake hood on the back face, one refrigerant riser up the side.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, -hd - 0.34, 0.18 + H * 0.30, -hw * 0.42,
    -hd + 0.02, 0.18 + H * 0.92, hw * 0.42, F_NOBOT);
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, hd + 0.08, 0.24, -hw * 0.96, hd + 0.08, 0.24 + H * 0.70, -hw * 0.96,
    0.045, 0.045, F_BLADEX);
}

// The boxy machine room that caps every tower: solid walls, applied louvre panels, a roof-access
// door, a hatch curb and a vent stub. `w` is the plan size along local Z, `d` along local X,
// `h` the wall height above the roof.
export function appendElevatorPenthouse(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 8.0), 1.8, 34.0);
  const D = clamp(fin(d, 6.0), 1.8, 34.0);
  const H = clamp(fin(h, 4.2), 1.4, 14.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, rnd(rng) < 0.5 ? M.concrete : M.alum);
  boxL(mb, px, py, pz, c, s, -hd, 0.0, -hw, hd, H, hw, F_NOBOT);

  // Coping slab, slightly oversailing.
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hd - 0.12, H, -hw - 0.12, hd + 0.12, H + 0.26, hw + 0.12, F_ALL);

  // Louvre panels: a dark backing applied to the wall with blades proud of it, so the sun rakes
  // them at golden hour instead of a flat painted rectangle.
  const ly0 = H * 0.46, ly1 = H * 0.88;
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, hd + 0.010, ly0, -hw * 0.52, ly1, hw * 0.52);
  quadNZ(mb, px, py, pz, c, s, -hw - 0.010, -hd * 0.52, ly0, hd * 0.52, ly1);
  setMat(mb, M.galv);
  for (let i = 0; i < 3; i++) {
    const by = ly0 + (ly1 - ly0) * (0.14 + 0.32 * i);
    quadPX(mb, px, py, pz, c, s, hd + 0.038, by, -hw * 0.52, by + (ly1 - ly0) * 0.16, hw * 0.52);
  }

  // Roof-access door in its surround.
  const doorH = Math.min(2.24, H * 0.80);
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, hd - 0.02, 0.0, -0.62, hd + 0.09, doorH, 0.62, F_SIDES);
  setMat(mb, M.dark);
  quadPX(mb, px, py, pz, c, s, hd + 0.095, 0.04, -0.52, doorH - 0.06, 0.52);

  // Hatch curb and vent stub on the roof.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, -hd * 0.55, H + 0.26, -hw * 0.30,
    -hd * 0.10, H + 0.62, hw * 0.16, F_NOBOT);
  boxL(mb, px, py, pz, c, s, hd * 0.22, H + 0.26, -hw * 0.42,
    hd * 0.52, H + 0.95, -hw * 0.12, F_NOBOT);
}

// Induced-draught cooling tower — the octagonal drum with a recessed louvre band and a fan cowl
// that sits on half the older office stock downtown. `r` is the shell radius, `h` the overall
// height including the cowl.
export function appendCoolingTower(mb, rng, x, y, z, yaw, r, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const R = clamp(fin(r, 1.6), 0.5, 9.0);
  const H = clamp(fin(h, 3.2), 1.0, 14.0);

  const baseH = H * 0.16;
  const louvreH = H * 0.24;
  const shellH = H * 0.34;
  const deckH = H * 0.12;
  const cowlH = Math.max(0.12, H * 0.14) * (0.85 + 0.30 * rnd(rng));

  // The basin tapers straight into the louvre drum's radius. A wider basin rim would leave an
  // uncapped annular ledge that you can see down into from any raised viewpoint.
  setMat(mb, M.concrete);
  mb.cylinder(px, py, pz, R * 1.06, R * 0.97, baseH, 8, a, false);

  // The louvre band is a genuinely recessed drum between two wider rings, not a painted stripe.
  setMat(mb, M.dark);
  mb.cylinder(px, py + baseH, pz, R * 0.97, R * 0.97, louvreH, 8, a, false);

  setMat(mb, rnd(rng) < 0.5 ? M.galvPale : M.alum);
  mb.cylinder(px, py + baseH + louvreH, pz, R, R * 0.98, shellH, 8, a, false);

  const deckY = py + baseH + louvreH + shellH;
  mb.cylinder(px, deckY, pz, R * 0.98, R * 0.86, deckH, 8, a, false);
  setMat(mb, M.galv);
  mb.cylinder(px, deckY + deckH, pz, R * 0.82, R * 0.74, cowlH, 8, a, false);
  setMat(mb, M.grateIron);
  discY(mb, px, deckY + deckH + cowlH, pz, R * 0.74, 8, a, true);
}

// Rooftop mast: stepped tapering pole, three guy wires off the step, a pair of panel antennas on
// a cross-arm, and a red aviation beacon at the top.
export function appendRoofAntenna(mb, rng, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 9.0), 1.5, 44.0);
  const a = rnd(rng) * TAU;
  const c = Math.cos(a), s = Math.sin(a);
  const stepY = H * 0.46;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -0.52, -0.05, -0.52, 0.52, 0.20, 0.52, F_NOBOT);

  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.18, pz, 0.135, 0.098, stepY - 0.18, 5, a, false);
  mb.cylinder(px, py + stepY, pz, 0.086, 0.042, H - stepY, 5, a, false);

  // Guy wires from the step down to roof anchors.
  setMat(mb, M.steel);
  const gr = H * 0.34;
  for (let i = 0; i < 3; i++) {
    const g = (i / 3) * TAU;
    beamL(mb, px, py, pz, c, s, 0, stepY, 0,
      Math.cos(g) * gr, 0.20, Math.sin(g) * gr, 0.022, 0.022, F_BLADEX);
  }

  // Cross-arm with two panel antennas.
  const armY = H * 0.74;
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, -0.62, armY, 0, 0.62, armY, 0, 0.038, 0.038, F_BLADEX);
  setMat(mb, M.craneWhite);
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? -0.66 : 0.50;
    boxL(mb, px, py, pz, c, s, cx, armY - 0.44, -0.075, cx + 0.16, armY + 0.44, 0.075, F_SIDES);
  }

  setMat(mb, M.beaconRed);
  mb.cylinder(px, py + H, pz, 0.075, 0.060, 0.17, 5, a, false);
  discY(mb, px, py + H + 0.17, pz, 0.060, 5, a, true);
}

// Window-washing davit and cradle parked at a tower parapet. Put the origin ON the parapet top
// with local +X pointing OUT over the facade; the cradle then hangs clear of the wall. `w` is the
// cradle length, which runs along local Z.
export function appendWindowRig(mb, x, y, z, yaw, w) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3.0), 1.2, 7.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;

  // Track on the parapet.
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -0.70, 0.0, -hw - 0.35, -0.24, 0.22, hw + 0.35, F_NOBOT);

  // Two davit posts with jib arms reaching out over the edge.
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw;
    setMat(mb, M.galv);
    boxL(mb, px, py, pz, c, s, -0.58, 0.22, cz - 0.075, -0.36, 1.32, cz + 0.075, F_SIDES);
    setMat(mb, M.steel);
    beamL(mb, px, py, pz, c, s, -0.52, 1.28, cz, 1.40, 0.96, cz, 0.055, 0.055, F_BLADEX);
  }

  // Winch housing.
  setMat(mb, M.craneWhite);
  boxL(mb, px, py, pz, c, s, -0.66, 0.22, -0.30, -0.28, 0.72, 0.30, F_NOBOT);

  // Suspension ropes down to the cradle.
  const topY = 0.96, cradleTop = -1.55;
  setMat(mb, M.steel);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw;
    beamL(mb, px, py, pz, c, s, 1.38, topY, cz, 1.38, cradleTop, cz, 0.022, 0.022, F_BLADEX);
  }

  // Cradle: a CLOSED tub with a separate top rail. An open-topped box would be see-through from
  // above under back-face culling, and above is the one angle this prop is ever viewed from.
  setMat(mb, M.galvPale);
  boxL(mb, px, py, pz, c, s, 1.02, cradleTop - 1.05, -hw - 0.14,
    1.74, cradleTop - 0.30, hw + 0.14, F_ALL);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, 1.00, cradleTop - 0.09, -hw - 0.17,
    1.76, cradleTop, hw + 0.17, F_ALL);
}

// Ballasted satellite dish. Faces local +X at a fixed elevation, which is roughly where a Toronto
// downlink actually points. `r` is the dish radius.
export function appendSatelliteDish(mb, x, y, z, yaw, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const R = clamp(fin(r, 0.65), 0.20, 3.2);
  const c = Math.cos(a), s = Math.sin(a);

  const postH = 0.30 + 0.40 * R;
  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -R * 0.62, 0.0, -R * 0.62, R * 0.62, 0.16, R * 0.62, F_NOBOT);
  setMat(mb, M.galv);
  mb.cylinder(px, py + 0.12, pz, R * 0.15, R * 0.11, postH, 6, a, false);
  setMat(mb, M.steel);
  boxL(mb, px, py, pz, c, s, -0.06, postH - 0.02, -R * 0.20,
    0.10, postH + R * 0.30, R * 0.20, F_SIDES);

  // Rim plane: axis = (cos e, sin e, 0), in-plane up u = (-sin e, cos e, 0), side v = local +Z.
  // (u, v, axis) is right-handed, so walking the rim from u toward v is CCW seen from the front.
  const e = 0.58;
  const ce = Math.cos(e), se = Math.sin(e);
  const cx0 = 0.06, cy0 = postH + R * 0.55;
  const dep = R * 0.34;
  // The bowl apex sits behind the rim and the back shell BEHIND THE BOWL — putting the back
  // between the bowl and the rim would make the two surfaces swap places along the axis, so the
  // dish would be seen from the front through its own back face.
  const ax = cx0 - dep * ce, ay = cy0 - dep * se;
  const bk = dep + R * 0.06;
  const bx = cx0 - bk * ce, by = cy0 - bk * se;

  setMat(mb, M.craneWhite);
  const seg = 8;
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * TAU, t1 = ((i + 1) / seg) * TAU;
    const k0 = Math.cos(t0), m0 = Math.sin(t0);
    const k1 = Math.cos(t1), m1 = Math.sin(t1);
    const p0x = cx0 - R * k0 * se, p0y = cy0 + R * k0 * ce, p0z = R * m0;
    const p1x = cx0 - R * k1 * se, p1y = cy0 + R * k1 * ce, p1z = R * m1;
    triL(mb, px, py, pz, c, s, ax, ay, 0, p0x, p0y, p0z, p1x, p1y, p1z);
    triL(mb, px, py, pz, c, s, bx, by, 0, p1x, p1y, p1z, p0x, p0y, p0z);
  }

  // Feed arm from the bottom rim up to the focus, LNB on the end.
  const fx = cx0 + R * 0.72 * ce, fy = cy0 + R * 0.72 * se;
  const rbx = cx0 + R * se, rby = cy0 - R * ce;
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, rbx, rby, 0, fx, fy, 0, 0.030, 0.030, F_BLADEX);
  setMat(mb, M.dark);
  boxL(mb, px, py, pz, c, s, fx - 0.09, fy - 0.09, -0.07, fx + 0.11, fy + 0.09, 0.07, F_ALL);
}

/* ================================================================ vehicles = */

// Parked car. Static geometry, no AI, and nothing emissive — a parked car's lamps are OFF, so the
// renderer is free to light it as an ordinary painted object at any hour.
//
// ORIENTATION: the car's LENGTH runs along local Z (front at +Z) and its width along local X,
// which matches this module's "long objects run along local Z" rule. To park it along a kerb whose
// unit direction is (dx, dz):
//     yaw = Math.atan2(-dz, dx) + Math.PI / 2       (equivalently Math.atan2(dx, dz))
// which points the car along (dx, dz) and puts local +X on its outboard side.
//
// `kind` is 'sedan' | 'suv' | 'van' | 'taxi'; anything else falls back to 'sedan'.
export function appendParkedCar(mb, rng, x, y, z, yaw, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  const isTaxi = kind === 'taxi';
  const K = kind === 'suv' ? CAR_SUV : (kind === 'van' ? CAR_VAN : CAR_SEDAN);
  const hl = K[0] * 0.5, hw = K[1];
  const sill = K[2], belt = K[3], roof = K[4];
  const cz0 = K[5], cz1 = K[6], wr = K[7];
  const body = isTaxi ? M.craneWhite : pickOf(rng, CAR_COLOURS);

  // Lower body: one hull with a plan taper toward the nose. Five faces — a kerbside car's
  // underside is never seen and these are placed in the thousands.
  setMat(mb, body);
  setL(0, -hw * 0.94, sill, -hl); setL(1, hw * 0.94, sill, -hl);
  setL(2, -hw, belt, -hl); setL(3, hw, belt, -hl);
  setL(4, -hw * 0.88, sill, hl); setL(5, hw * 0.88, sill, hl);
  setL(6, -hw * 0.96, belt, hl); setL(7, hw * 0.96, belt, hl);
  hullL(mb, px, py, pz, c, s, F_NOBOT);

  // Greenhouse: the same hull drawn twice — glass on the four sides, body colour on the roof.
  const cw = hw * 0.93;
  const rake = (roof - belt) * 0.42;
  setL(0, -cw, belt, cz0); setL(1, cw, belt, cz0);
  setL(2, -cw * 0.80, roof, cz0 + rake); setL(3, cw * 0.80, roof, cz0 + rake);
  setL(4, -cw, belt, cz1); setL(5, cw, belt, cz1);
  setL(6, -cw * 0.80, roof, cz1 - rake * 1.5); setL(7, cw * 0.80, roof, cz1 - rake * 1.5);
  setMat(mb, M.carGlass);
  hullL(mb, px, py, pz, c, s, F_SIDES);
  setMat(mb, body);
  hullL(mb, px, py, pz, c, s, F_PY);

  // Wheels: outward-facing discs just proud of the flanks.
  setMat(mb, M.tyre);
  const wz = hl - wr - 0.24;
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const lz = (i & 2) ? wz : -wz;
    discX(mb, px, py, pz, c, s, side * (hw + 0.006), wr, lz, wr, 6, side > 0);
  }

  // Lamp lenses — colour only. A parked car is dark.
  setMat(mb, M.lampClear);
  quadPZ(mb, px, py, pz, c, s, hl + 0.004, -hw * 0.84, sill + 0.18, hw * 0.84, sill + 0.34);
  setMat(mb, M.lampRed);
  quadNZ(mb, px, py, pz, c, s, -hl - 0.004, -hw * 0.86, sill + 0.20, hw * 0.86, sill + 0.38);

  if (isTaxi) {
    setMat(mb, M.taxiOrange);
    boxL(mb, px, py, pz, c, s, -0.30, roof, cz1 * 0.35 - 0.24,
      0.30, roof + 0.24, cz1 * 0.35 + 0.24, F_NOBOT);
  }
}

/* ================================================================== marine = */

// Pleasure craft moored at a Harbourfront quay. Origin is the hull centre AT THE WATERLINE, the
// hull length running along local Z with the bow at +Z. `len` is the overall length.
export function appendBoat(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 9.0), 3.5, 42.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;
  const bw = L * 0.155;
  const fb = L * 0.075;
  const draft = L * 0.045;

  // Hull, then its deck as the same corners in a different material.
  setL(0, -bw * 0.72, -draft, -hl); setL(1, bw * 0.72, -draft, -hl);
  setL(2, -bw, fb, -hl); setL(3, bw, fb, -hl);
  setL(4, -bw * 0.20, -draft * 0.72, hl); setL(5, bw * 0.20, -draft * 0.72, hl);
  setL(6, -bw * 0.34, fb + L * 0.022, hl); setL(7, bw * 0.34, fb + L * 0.022, hl);
  setMat(mb, pickOf(rng, BOAT_HULLS));
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setMat(mb, M.timber);
  hullL(mb, px, py, pz, c, s, F_PY);

  // Cockpit well, recessed into the deck.
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -bw * 0.62, -hl * 0.86, bw * 0.62, -hl * 0.18, fb - 0.03);

  // Deckhouse: vertical sides so the side glazing sits flush, raked ends fore and aft. The
  // windscreen is the hull's own +Z face in glass, not a decal.
  const xw = bw * 0.70;
  const cz0 = -hl * 0.14, cz1 = hl * 0.62;
  const ch = fb + L * 0.085;
  const rakeA = L * 0.020, rakeF = L * 0.095;
  setL(0, -xw, fb, cz0); setL(1, xw, fb, cz0);
  setL(2, -xw, ch, cz0 + rakeA); setL(3, xw, ch, cz0 + rakeA);
  setL(4, -xw, fb, cz1); setL(5, xw, fb, cz1);
  setL(6, -xw, ch, cz1 - rakeF); setL(7, xw, ch, cz1 - rakeF);
  setMat(mb, M.hullWhite);
  hullL(mb, px, py, pz, c, s, F_PX | F_NX | F_PY | F_NZ);
  setMat(mb, M.carGlass);
  hullL(mb, px, py, pz, c, s, F_PZ);
  quadPX(mb, px, py, pz, c, s, xw + 0.006,
    fb + L * 0.020, cz0 + L * 0.05, ch - L * 0.014, cz1 - rakeF - L * 0.02);
  quadNX(mb, px, py, pz, c, s, -xw - 0.006,
    fb + L * 0.020, cz0 + L * 0.05, ch - L * 0.014, cz1 - rakeF - L * 0.02);

  // Guard rails along the sheer.
  setMat(mb, M.chrome);
  for (let i = 0; i < 2; i++) {
    const sx = (i === 0 ? -1 : 1) * bw * 0.92;
    boxL(mb, px, py, pz, c, s, sx - 0.028, fb + L * 0.055, -hl * 0.94,
      sx + 0.028, fb + L * 0.055 + 0.056, hl * 0.80, F_BLADEX);
  }

  // Some carry a mast; the rest get a short radar post.
  setMat(mb, M.galvPale);
  if (rnd(rng) < 0.42) {
    const mz = cz1 * 0.20;
    mb.cylinder(px + mz * s, py + ch, pz + mz * c, L * 0.020, L * 0.011, L * 0.72, 4, a, false);
    beamL(mb, px, py, pz, c, s, 0, ch + L * 0.10, mz, 0, ch + L * 0.16, mz - L * 0.34,
      0.040, 0.040, F_BLADEX);
  } else {
    const mz = cz1 * 0.35;
    mb.cylinder(px + mz * s, py + ch, pz + mz * c, L * 0.016, L * 0.010, L * 0.13, 4, a, false);
  }
}

// Ferry / tour-boat dock: timber deck on driven piles, a rub rail on the outboard side, a
// handrail on the landward side and a hinged apron. `w` is the width (along local X), `len` the
// length (along local Z). Tile several of these along a long quay rather than stretching one.
export function appendFerryDock(mb, x, y, z, yaw, w, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6.0), 2.0, 26.0);
  const L = clamp(fin(len, 18.0), 4.0, 64.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hl = L * 0.5;

  setMat(mb, M.timber);
  boxL(mb, px, py, pz, c, s, -hw, -0.34, -hl, hw, 0.0, hl, F_NOBOT);

  // Driven piles, standing proud of the deck the way they do on the real quays.
  setMat(mb, M.bark);
  const np = (clamp(Math.round(L / 10), 1, 3)) | 0;
  for (let i = 0; i < np; i++) {
    const lz = L * ((i + 0.5) / np - 0.5) * 0.92;
    for (let k = 0; k < 2; k++) {
      const cx = (k === 0 ? -1 : 1) * (hw - 0.18);
      boxL(mb, px, py, pz, c, s, cx - 0.16, -1.90, lz - 0.16, cx + 0.16, 0.92, lz + 0.16,
        F_NOBOT);
    }
  }

  // Rub rail outboard, handrail landward.
  setMat(mb, M.tyre);
  boxL(mb, px, py, pz, c, s, hw - 0.02, -0.30, -hl, hw + 0.16, -0.02, hl, F_BLADEX);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -hw + 0.06, 0.96, -hl, -hw + 0.16, 1.04, hl, F_BLADEX);

  // Hinged apron out to the berth.
  setMat(mb, M.grateIron);
  setL(0, hw, 0.0, -hl * 0.34); setL(1, hw + W * 0.28, -0.22, -hl * 0.34);
  setL(2, hw, 0.07, -hl * 0.34); setL(3, hw + W * 0.28, -0.15, -hl * 0.34);
  setL(4, hw, 0.0, hl * 0.34); setL(5, hw + W * 0.28, -0.22, hl * 0.34);
  setL(6, hw, 0.07, hl * 0.34); setL(7, hw + W * 0.28, -0.15, hl * 0.34);
  hullL(mb, px, py, pz, c, s, F_NOBOT);
}

/* ==================================================================== rail = */

// One bogie: side frame plus four wheels, centred on local z = zc. 84 verts.
function bogie(mb, ox, oy, oz, c, s, zc) {
  setMat(mb, M.dark);
  boxL(mb, ox, oy, oz, c, s, -0.98, 0.42, zc - 1.08, 0.98, 1.02, zc + 1.08, F_SIDES);
  setMat(mb, M.grateIron);
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const wz = zc + ((i & 2) ? 0.94 : -0.94);
    discX(mb, ox, oy, oz, c, s, side * 1.02, 0.46, wz, 0.46, 5, side > 0);
  }
}

// Rolling stock for the corridor south of Front. Origin is the track centre at TOP OF RAIL and
// the car's length runs along local Z (see appendParkedCar for the alignment formula).
// `kind` is 'coach' | 'locomotive' | 'freight'; anything else falls back to 'coach'.
export function appendRailCar(mb, rng, x, y, z, yaw, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const k = (kind === 'locomotive' || kind === 'freight') ? kind : 'coach';
  const L = k === 'locomotive' ? 21.0 : (k === 'freight' ? 18.5 : 25.0);
  const hl = L * 0.5;
  const bz = hl - 3.4;

  bogie(mb, px, py, pz, c, s, -bz);
  bogie(mb, px, py, pz, c, s, bz);

  if (k === 'locomotive') {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.46, 0.98, -hl, 1.46, 1.34, hl, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.20, 0.44, -3.0, 1.20, 1.00, 3.0, F_SIDES);

    setMat(mb, pickOf(rng, RAIL_LIVERY));
    boxL(mb, px, py, pz, c, s, -1.34, 1.34, -hl + 0.5, 1.34, 3.52, hl - 7.4, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.34, 1.34, hl - 2.2, 1.34, 2.95, hl - 0.5, F_NOBOT);
    boxL(mb, px, py, pz, c, s, -1.42, 1.34, hl - 7.4, 1.42, 4.05, hl - 2.2, F_NOBOT);

    setMat(mb, M.carGlass);
    quadPX(mb, px, py, pz, c, s, 1.425, 2.85, hl - 6.9, 3.85, hl - 2.9);
    quadNX(mb, px, py, pz, c, s, -1.425, 2.85, hl - 6.9, 3.85, hl - 2.9);
    quadPZ(mb, px, py, pz, c, s, hl - 2.195, -1.16, 2.85, 1.16, 3.80);

    setMat(mb, M.grateIron);
    quadPX(mb, px, py, pz, c, s, 1.345, 2.10, -hl + 1.4, 3.30, -hl + 5.2);
    quadNX(mb, px, py, pz, c, s, -1.345, 2.10, -hl + 1.4, 3.30, -hl + 5.2);

    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -0.42, 3.52, -hl + 3.2, 0.42, 4.02, -hl + 4.1, F_NOBOT);
    setMat(mb, M.lampClear);
    quadNZ(mb, px, py, pz, c, s, -hl + 0.496, -0.34, 2.55, 0.34, 2.92);
  } else if (k === 'freight') {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.44, 0.98, -hl, 1.44, 1.30, hl, F_SIDES);
    setMat(mb, rnd(rng) < 0.5 ? M.rustRed : M.railMaroon);
    boxL(mb, px, py, pz, c, s, -1.56, 1.30, -hl, 1.56, 4.28, hl, F_SIDES);
    frustL(mb, px, py, pz, c, s, 4.28, 4.56,
      -1.56, -hl, 1.56, hl, -1.20, -hl + 0.30, 1.20, hl - 0.30, F_NOBOT);

    // Side ribs, as real proud strips rather than painted lines.
    setMat(mb, M.grateIron);
    for (let i = 0; i < 4; i++) {
      const rz = -hl + L * (0.14 + 0.24 * i);
      quadPX(mb, px, py, pz, c, s, 1.585, 1.36, rz - 0.09, 4.22, rz + 0.09);
      quadNX(mb, px, py, pz, c, s, -1.585, 1.36, rz - 0.09, 4.22, rz + 0.09);
    }
    setMat(mb, M.dark);
    quadPX(mb, px, py, pz, c, s, 1.575, 1.40, -1.85, 3.90, 1.85);
    quadNX(mb, px, py, pz, c, s, -1.575, 1.40, -1.85, 3.90, 1.85);
  } else {
    setMat(mb, M.dark);
    boxL(mb, px, py, pz, c, s, -1.42, 1.02, -hl + 0.2, 1.42, 1.28, hl - 0.2, F_SIDES);
    setMat(mb, pickOf(rng, RAIL_LIVERY));
    frustL(mb, px, py, pz, c, s, 1.28, 3.60,
      -1.44, -hl, 1.44, hl, -1.52, -hl, 1.52, hl, F_SIDES);
    frustL(mb, px, py, pz, c, s, 3.60, 4.22,
      -1.52, -hl, 1.52, hl, -0.98, -hl + 0.34, 0.98, hl - 0.34, F_NOBOT);

    setMat(mb, M.carGlass);
    quadPX(mb, px, py, pz, c, s, 1.525, 2.35, -hl + 1.6, 3.32, hl - 1.6);
    quadNX(mb, px, py, pz, c, s, -1.525, 2.35, -hl + 1.6, 3.32, hl - 1.6);
    quadPZ(mb, px, py, pz, c, s, hl + 0.004, -1.10, 2.35, 1.10, 3.30);
    quadNZ(mb, px, py, pz, c, s, -hl - 0.004, -1.10, 2.35, 1.10, 3.30);

    setMat(mb, M.dark);
    quadPX(mb, px, py, pz, c, s, 1.520, 1.34, -hl + 0.5, 3.30, -hl + 1.4);
    quadNX(mb, px, py, pz, c, s, -1.520, 1.34, hl - 1.4, 3.30, hl - 0.5);

    setMat(mb, M.galvPale);
    for (let i = 0; i < 2; i++) {
      const rz = (i === 0 ? -1 : 1) * hl * 0.42;
      boxL(mb, px, py, pz, c, s, -0.82, 4.22, rz - 1.05, 0.82, 4.52, rz + 1.05, F_NOBOT);
    }
  }
}

/* ==================================================== street-level extras = */

// Cafe patio: square bistro table, two chairs and, most of the time, a parasol. Toronto's patio
// season is short and extremely visible while it lasts.
export function appendPatioSet(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.castIron);
  mb.cylinder(px, py, pz, 0.22, 0.055, 0.70, 5, a, false);
  setMat(mb, M.granite);
  boxL(mb, px, py, pz, c, s, -0.36, 0.70, -0.36, 0.36, 0.745, 0.36, F_NOBOT);

  // Two chairs across the table.
  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? 1 : -1;
    const cx = dir * 0.72;
    setMat(mb, M.castIron);
    frustL(mb, px, py, pz, c, s, 0.0, 0.44,
      cx - 0.19, -0.19, cx + 0.19, 0.19, cx - 0.14, -0.14, cx + 0.14, 0.14, F_SIDES);
    setMat(mb, M.woodSlat);
    boxL(mb, px, py, pz, c, s, cx - 0.22, 0.44, -0.22, cx + 0.22, 0.485, 0.22, F_NOBOT);
    const bx = cx + dir * 0.20;
    setL(0, bx - 0.02, 0.485, -0.20); setL(1, bx + 0.02, 0.485, -0.20);
    setL(2, bx + dir * 0.10 - 0.02, 0.90, -0.20); setL(3, bx + dir * 0.10 + 0.02, 0.90, -0.20);
    setL(4, bx - 0.02, 0.485, 0.20); setL(5, bx + 0.02, 0.485, 0.20);
    setL(6, bx + dir * 0.10 - 0.02, 0.90, 0.20); setL(7, bx + dir * 0.10 + 0.02, 0.90, 0.20);
    hullL(mb, px, py, pz, c, s, F_PLATEX);
  }

  if (rnd(rng) < 0.65) {
    setMat(mb, M.galvPale);
    mb.cylinder(px, py + 0.70, pz, 0.032, 0.026, 1.66, 5, a, false);
    setMat(mb, rnd(rng) < 0.5 ? M.canvas : M.canvasRed);
    const rimY = py + 2.02;
    mb.cylinder(px, rimY, pz, 1.18, 0.05, 0.34, 6, a, false);
    discY(mb, px, rimY, pz, 1.18, 6, a, false);
  }
}

// A-frame sandwich board outside a shop. The chalk face is the panel's own outer face, so it
// catches light exactly like the board it is.
export function appendSandwichBoard(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hh = 0.86 + 0.16 * rnd(rng);
  const spread = 0.24 + 0.06 * rnd(rng);
  const hw = 0.28 + 0.05 * rnd(rng);

  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? 1 : -1;
    const x0 = dir * spread;
    setL(0, x0 - 0.014, 0.0, -hw); setL(1, x0 + 0.014, 0.0, -hw);
    setL(2, -0.014, hh, -hw); setL(3, 0.014, hh, -hw);
    setL(4, x0 - 0.014, 0.0, hw); setL(5, x0 + 0.014, 0.0, hw);
    setL(6, -0.014, hh, hw); setL(7, 0.014, hh, hw);
    const outer = dir > 0 ? F_PX : F_NX;
    setMat(mb, M.dark);
    hullL(mb, px, py, pz, c, s, F_ALL & ~outer);
    setMat(mb, M.chalk);
    hullL(mb, px, py, pz, c, s, outer);
  }
  setMat(mb, M.castIron);
  boxL(mb, px, py, pz, c, s, -0.05, hh - 0.02, -hw, 0.05, hh + 0.05, hw, F_NOBOT);
}

// Service-area dumpster: tapered body, rib band, two sloped lids, fork pockets and castors.
export function appendDumpster(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = 0.86 + 0.30 * rnd(rng);
  const hh = 1.06 + 0.22 * rnd(rng);

  setMat(mb, pickOf(rng, DUMPSTER_COLOURS));
  frustL(mb, px, py, pz, c, s, 0.18, hh,
    -0.56, -hl * 0.90, 0.56, hl * 0.90, -0.68, -hl, 0.68, hl, F_SIDES);
  setMat(mb, M.dark);
  quadUp(mb, px, py, pz, c, s, -0.66, -hl + 0.02, 0.66, hl - 0.02, hh - 0.06);

  setMat(mb, M.grateIron);
  boxL(mb, px, py, pz, c, s, -0.63, hh * 0.52, -hl * 0.96, 0.63, hh * 0.52 + 0.07, hl * 0.96,
    F_SIDES);

  // Two lids, hinged at the back and sloping toward the front.
  setMat(mb, M.binHood);
  for (let i = 0; i < 2; i++) {
    const z0 = i === 0 ? -hl : 0.01;
    const z1 = i === 0 ? -0.01 : hl;
    setL(0, -0.70, hh + 0.10, z0); setL(1, 0.70, hh - 0.02, z0);
    setL(2, -0.70, hh + 0.16, z0); setL(3, 0.70, hh + 0.04, z0);
    setL(4, -0.70, hh + 0.10, z1); setL(5, 0.70, hh - 0.02, z1);
    setL(6, -0.70, hh + 0.16, z1); setL(7, 0.70, hh + 0.04, z1);
    hullL(mb, px, py, pz, c, s, F_NOBOT);
  }

  setMat(mb, M.dark);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hl * 0.46;
    boxL(mb, px, py, pz, c, s, -0.60, 0.18, cz - 0.13, 0.60, 0.34, cz + 0.13, F_BLADEZ);
  }

  setMat(mb, M.tyre);
  for (let i = 0; i < 4; i++) {
    const side = (i & 1) ? 1 : -1;
    const cz = (i & 2) ? hl * 0.74 : -hl * 0.74;
    discX(mb, px, py, pz, c, s, side * 0.50, 0.11, cz, 0.11, 5, side > 0);
  }
}

// Split-system condenser for low-rise roofs and rear yards. Small, boring, everywhere.
export function appendACondenser(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = 0.40 + 0.10 * rnd(rng);
  const hd = 0.34 + 0.07 * rnd(rng);
  const hh = 0.78 + 0.22 * rnd(rng);

  // Anti-vibration rails.
  setMat(mb, M.tyre);
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * hw * 0.72;
    boxL(mb, px, py, pz, c, s, -hd, 0.0, cz - 0.06, hd, 0.09, cz + 0.06, F_BLADEZ);
  }

  setMat(mb, rnd(rng) < 0.6 ? M.galvPale : M.cabBeige);
  boxL(mb, px, py, pz, c, s, -hd, 0.09, -hw, hd, hh, hw, F_NOBOT);

  // Coil louvres applied to the three closed faces.
  setMat(mb, M.grateIron);
  quadNX(mb, px, py, pz, c, s, -hd - 0.006, 0.16, -hw + 0.05, hh - 0.10, hw - 0.05);
  quadPZ(mb, px, py, pz, c, s, hw + 0.006, -hd + 0.05, 0.16, hd - 0.05, hh - 0.10);
  quadNZ(mb, px, py, pz, c, s, -hw - 0.006, -hd + 0.05, 0.16, hd - 0.05, hh - 0.10);

  // Fan cowl and guard.
  const fr = Math.min(hd, hw);
  setMat(mb, M.galv);
  mb.cylinder(px, py + hh, pz, fr * 0.86, fr * 0.80, 0.10, 6, a, false);
  setMat(mb, M.dark);
  discY(mb, px, py + hh + 0.10, pz, fr * 0.78, 6, a, true);

  // Line set back into the wall.
  setMat(mb, M.steel);
  beamL(mb, px, py, pz, c, s, -hd - 0.02, hh * 0.62, hw * 0.55,
    -hd - 0.34, hh * 0.62, hw * 0.55, 0.036, 0.036, F_BLADEX);
}

// Flagpole with a wind-blown flag. There is no yaw argument by contract, so the fly direction
// comes from a position hash — a row of poles then reads as one wind rather than a comb.
export function appendFlagPole(mb, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 11.0), 2.5, 32.0);
  const a = hash2(px, pz) * TAU;
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.granite);
  mb.cylinder(px, py - 0.04, pz, 0.34, 0.30, 0.42, 6, a, false);
  discY(mb, px, py + 0.38, pz, 0.30, 6, a, true);

  setMat(mb, M.alum);
  mb.cylinder(px, py + 0.36, pz, 0.115, 0.052, H - 0.36, 6, a, false);
  // The finial tip keeps a small non-zero radius on purpose: mb.cylinder() emits two triangles per
  // segment regardless, so rTop = 0 would collapse one of each pair into a degenerate.
  mb.cylinder(px, py + H, pz, 0.072, 0.010, 0.16, 5, a, false);

  // Flag: three chord segments with a running wave and a little droop toward the fly.
  const fh = clamp(H * 0.19, 0.5, 2.6);
  const fl = fh * 2.0;
  const topY = H - fh * 0.24;
  const t = 0.012;
  for (let i = 0; i < 3; i++) {
    const x0 = fl * (i / 3), x1 = fl * ((i + 1) / 3);
    const w0 = Math.sin(i * 1.9) * fh * 0.13;
    const w1 = Math.sin((i + 1) * 1.9) * fh * 0.13;
    const d0 = -fh * 0.05 * i, d1 = -fh * 0.05 * (i + 1);
    setL(0, x0, topY - fh + d0, w0 - t); setL(1, x1, topY - fh + d1, w1 - t);
    setL(2, x0, topY + d0, w0 - t); setL(3, x1, topY + d1, w1 - t);
    setL(4, x0, topY - fh + d0, w0 + t); setL(5, x1, topY - fh + d1, w1 + t);
    setL(6, x0, topY + d0, w0 + t); setL(7, x1, topY + d1, w1 + t);
    setMat(mb, i === 1 ? M.flagWhite : M.flagRed);
    hullL(mb, px, py, pz, c, s, F_PLATEZ);
  }
}

// Sidewalk scaffold / hoarding — the covered walkway that wraps half of downtown at any given
// moment. Length along local Z, the building face at local -X, the kerb side at local +X. Tile
// several sections along a long frontage.
//
// The under-deck lamps are REAL fixtures: they are the reason a sidewalk shed is not pitch black
// at night, and the renderer decides when they are on.
export function appendScaffold(mb, rng, x, y, z, yaw, w, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6.0), 1.5, 12.0);
  const H = clamp(fin(h, 3.6), 2.4, 8.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = W * 0.5;
  const dx = 1.20;

  // Standards and ledgers.
  setMat(mb, M.galv);
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) ? dx : -dx;
    const cz = (i & 2) ? hl - 0.22 : -(hl - 0.22);
    boxL(mb, px, py, pz, c, s, cx - 0.055, 0.0, cz - 0.055, cx + 0.055, H, cz + 0.055, F_SIDES);
  }
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? -dx : dx;
    boxL(mb, px, py, pz, c, s, cx - 0.05, H - 0.34, -hl, cx + 0.05, H - 0.24, hl, F_BLADEX);
  }
  setMat(mb, M.galvPale);
  beamL(mb, px, py, pz, c, s, dx, 0.10, -(hl - 0.22), dx, H - 0.30, hl - 0.22,
    0.040, 0.040, F_BLADEX);

  // Deck. Both faces matter — the underside is what a pedestrian actually walks beneath.
  setMat(mb, M.plywood);
  boxL(mb, px, py, pz, c, s, -dx - 0.32, H, -hl - 0.16, dx + 0.32, H + 0.14, hl + 0.16, F_ALL);
  boxL(mb, px, py, pz, c, s, dx + 0.30, H + 0.14, -hl - 0.16, dx + 0.34, H + 0.62, hl + 0.16,
    F_PLATEX);
  boxL(mb, px, py, pz, c, s, -dx - 0.06, 0.0, -hl - 0.10, -dx - 0.02, H * 0.62, hl + 0.10,
    F_PLATEX);

  // Two under-deck lamps.
  const lz = hl * 0.48;
  for (let i = 0; i < 2; i++) {
    const cz = (i === 0 ? -1 : 1) * lz;
    setMat(mb, M.lampBody);
    boxL(mb, px, py, pz, c, s, -0.16, H - 0.16, cz - 0.34, 0.16, H - 0.02, cz + 0.34, F_SIDES);
    setMat(mb, M.shedLamp);
    quadDown(mb, px, py, pz, c, s, -0.13, cz - 0.30, 0.13, cz + 0.30, H - 0.165);
  }

  if (rnd(rng) < 0.5) {
    setMat(mb, M.signRed);
    quadPX(mb, px, py, pz, c, s, dx + 0.345, H + 0.24, -0.55, H + 0.52, 0.55);
  }
}

/* ============================================================= pedestrians = */
//
// The city has 1,612 parked cars and, until now, nobody standing next to one. People are what
// make a street read as a street. These are seen mostly at 10-60 m and in the hundreds, so
// SILHOUETTE and VARIETY do all the work: nobody resolves a face at 30 m, and everybody notices
// when the crowd is one mannequin cloned four hundred times.
//
// So the geometry is deliberately blunt — flat-sided hulls, no curves, no hands, no features —
// and every knob that changes the READ is rolled per instance from the city's seeded rng:
// stature, build, skin, hair, hat, coat, shirt, trousers or dress, bag, and, for the walking
// poses, the stride phase.
//
// Poses are STATIC GEOMETRY, never animation. 'walk' is one frame of a gait frozen into the mesh:
// the leading leg forward, the OPPOSITE arm forward, the trailing heel lifted off the pavement.
// The phase is drawn from the rng, so consecutive people along a pavement are caught at different
// points of the stride and the row reads as movement rather than as a rank of statues.
//
// Orientation follows the module contract exactly: local +X is the FRONT, so a person built at
// yaw faces world (cos yaw, 0, -sin yaw), and (x, y, z) is the footprint centre at GROUND level —
// the soles land on y, never above or below it.
//
// AMENDMENT 7: a person is NEVER a light source. Every surface in this section is emissive 0,
// tintable 0, profile 0, with albedo and roughness only. No baked shading, no darkened
// undersides, no warm tint "so they read at night". The renderer lights the crowd exactly as it
// lights the pavement, and nothing here knows which of the four times of day is showing.
//
// Vertex cost, measured over 400 seeds: 174 for a standing, walking or leaning person, plus 30
// for a bag or backpack on the 36% that carry one; 210 seated; 294 for a cyclist including the
// bicycle; 366 for a dog walker including the dog and the lead.

// Skin. Eight steps across the real range, all the way dark, because a downtown Toronto crowd is
// not eight shades of beige. Values sit in this module's low-key albedo range (a white sign is
// 0.23 here), and the roughness is a physical constant like every other one in the file.
const PED_SKIN = [
  [0.198, 0.143, 0.108, 0, 0, 0.72, 0],
  [0.176, 0.124, 0.091, 0, 0, 0.72, 0],
  [0.152, 0.103, 0.073, 0, 0, 0.72, 0],
  [0.128, 0.085, 0.058, 0, 0, 0.72, 0],
  [0.101, 0.065, 0.043, 0, 0, 0.72, 0],
  [0.074, 0.046, 0.030, 0, 0, 0.72, 0],
  [0.050, 0.030, 0.020, 0, 0, 0.72, 0],
  [0.033, 0.020, 0.014, 0, 0, 0.72, 0],
];

const PED_HAIR = [
  [0.016, 0.014, 0.013, 0, 0, 0.86, 0],   // black
  [0.026, 0.020, 0.017, 0, 0, 0.86, 0],   // near-black
  [0.030, 0.022, 0.016, 0, 0, 0.86, 0],   // dark brown
  [0.052, 0.036, 0.023, 0, 0, 0.86, 0],   // brown
  [0.076, 0.043, 0.021, 0, 0, 0.86, 0],   // auburn
  [0.124, 0.098, 0.052, 0, 0, 0.86, 0],   // fair
  [0.086, 0.086, 0.088, 0, 0, 0.86, 0],   // grey
  [0.164, 0.165, 0.168, 0, 0, 0.86, 0],   // white
];

// Toques, caps and hoods. A hat is drawn as the head volume itself — a colour swap plus a couple
// of centimetres of extra crown — so it costs nothing at all.
const PED_HAT = [
  [0.020, 0.021, 0.024, 0, 0, 0.88, 0],
  [0.028, 0.048, 0.088, 0, 0, 0.88, 0],
  [0.150, 0.036, 0.032, 0, 0, 0.88, 0],
  [0.042, 0.078, 0.052, 0, 0, 0.88, 0],
  [0.112, 0.108, 0.096, 0, 0, 0.88, 0],
  [0.056, 0.058, 0.062, 0, 0, 0.88, 0],
];

// Outerwear. Broader and a little more chromatic than the parked-car palette on purpose: cars
// punching out of the image is a bug, a crowd of grey people is a morgue.
const PED_COAT = [
  [0.022, 0.023, 0.026, 0, 0, 0.86, 0],   // black
  [0.046, 0.047, 0.051, 0, 0, 0.86, 0],   // charcoal
  [0.088, 0.089, 0.093, 0, 0, 0.86, 0],   // mid grey
  [0.026, 0.036, 0.070, 0, 0, 0.86, 0],   // navy
  [0.048, 0.068, 0.104, 0, 0, 0.86, 0],   // denim
  [0.060, 0.066, 0.038, 0, 0, 0.86, 0],   // olive
  [0.030, 0.058, 0.038, 0, 0, 0.86, 0],   // forest
  [0.150, 0.116, 0.070, 0, 0, 0.86, 0],   // camel
  [0.170, 0.156, 0.128, 0, 0, 0.86, 0],   // beige
  [0.205, 0.198, 0.180, 0, 0, 0.86, 0],   // cream
  [0.104, 0.030, 0.038, 0, 0, 0.86, 0],   // burgundy
  [0.215, 0.046, 0.038, 0, 0, 0.86, 0],   // red
  [0.170, 0.078, 0.032, 0, 0, 0.86, 0],   // rust
  [0.190, 0.148, 0.040, 0, 0, 0.86, 0],   // mustard
  [0.030, 0.086, 0.090, 0, 0, 0.86, 0],   // teal
  [0.070, 0.040, 0.098, 0, 0, 0.86, 0],   // purple
  [0.205, 0.116, 0.126, 0, 0, 0.86, 0],   // pink
  [0.072, 0.050, 0.034, 0, 0, 0.86, 0],   // brown
];

// The chest plane is a second garment, not a highlight — see figureTorso().
const PED_SHIRT = [
  [0.222, 0.226, 0.230, 0, 0, 0.88, 0],
  [0.128, 0.156, 0.196, 0, 0, 0.88, 0],
  [0.104, 0.106, 0.110, 0, 0, 0.88, 0],
  [0.026, 0.027, 0.030, 0, 0, 0.88, 0],
  [0.190, 0.048, 0.042, 0, 0, 0.88, 0],
  [0.048, 0.104, 0.062, 0, 0, 0.88, 0],
  [0.205, 0.180, 0.058, 0, 0, 0.88, 0],
  [0.210, 0.104, 0.034, 0, 0, 0.88, 0],
  [0.034, 0.044, 0.078, 0, 0, 0.88, 0],
  [0.128, 0.110, 0.170, 0, 0, 0.88, 0],
  [0.040, 0.110, 0.112, 0, 0, 0.88, 0],
  [0.212, 0.130, 0.140, 0, 0, 0.88, 0],
];

const PED_TROUSER = [
  [0.042, 0.056, 0.086, 0, 0, 0.90, 0],   // indigo denim
  [0.078, 0.096, 0.128, 0, 0, 0.90, 0],   // washed denim
  [0.024, 0.025, 0.028, 0, 0, 0.90, 0],   // black
  [0.050, 0.051, 0.055, 0, 0, 0.90, 0],   // charcoal
  [0.092, 0.093, 0.097, 0, 0, 0.90, 0],   // grey
  [0.134, 0.118, 0.082, 0, 0, 0.90, 0],   // khaki
  [0.156, 0.150, 0.134, 0, 0, 0.90, 0],   // stone
  [0.058, 0.062, 0.038, 0, 0, 0.90, 0],   // olive
  [0.066, 0.048, 0.032, 0, 0, 0.90, 0],   // brown
  [0.030, 0.038, 0.062, 0, 0, 0.90, 0],   // navy
];

// Dresses and skirts. Used as the whole torso hull, which flares below the waist, with bare legs
// under it — so the garment colour has to stand on its own rather than sit under a coat.
const PED_SKIRT = [
  [0.024, 0.025, 0.029, 0, 0, 0.88, 0],
  [0.032, 0.040, 0.074, 0, 0, 0.88, 0],
  [0.180, 0.042, 0.048, 0, 0, 0.88, 0],
  [0.052, 0.096, 0.066, 0, 0, 0.88, 0],
  [0.150, 0.132, 0.100, 0, 0, 0.88, 0],
  [0.108, 0.070, 0.130, 0, 0, 0.88, 0],
  [0.196, 0.176, 0.088, 0, 0, 0.88, 0],
  [0.086, 0.088, 0.092, 0, 0, 0.88, 0],
];

const PED_BAG = [
  [0.020, 0.021, 0.023, 0, 0, 0.80, 0],
  [0.062, 0.042, 0.026, 0, 0, 0.80, 0],
  [0.028, 0.036, 0.062, 0, 0, 0.80, 0],
  [0.070, 0.074, 0.048, 0, 0, 0.80, 0],
  [0.148, 0.038, 0.034, 0, 0, 0.80, 0],
  [0.088, 0.090, 0.094, 0, 0, 0.80, 0],
];

// Helmet shells are painted plastic: same rules, just smoother than wool.
const PED_HELMET = [
  [0.205, 0.208, 0.214, 0, 0, 0.34, 0],
  [0.026, 0.027, 0.030, 0, 0, 0.34, 0],
  [0.200, 0.048, 0.038, 0, 0, 0.34, 0],
  [0.036, 0.058, 0.120, 0, 0, 0.34, 0],
  [0.150, 0.180, 0.048, 0, 0, 0.34, 0],
];

const BIKE_FRAME = [
  [0.024, 0.025, 0.028, 0, 0, 0.32, 0],
  [0.130, 0.133, 0.138, 0, 0, 0.26, 0],
  [0.160, 0.040, 0.036, 0, 0, 0.30, 0],
  [0.030, 0.052, 0.100, 0, 0, 0.30, 0],
  [0.046, 0.096, 0.078, 0, 0, 0.30, 0],
  [0.170, 0.140, 0.048, 0, 0, 0.30, 0],
];

const DOG_COAT = [
  [0.026, 0.024, 0.022, 0, 0, 0.92, 0],   // black
  [0.058, 0.040, 0.026, 0, 0, 0.92, 0],   // brown
  [0.128, 0.092, 0.048, 0, 0, 0.92, 0],   // golden
  [0.178, 0.170, 0.152, 0, 0, 0.92, 0],   // cream
  [0.092, 0.090, 0.086, 0, 0, 0.92, 0],   // grey
  [0.070, 0.054, 0.040, 0, 0, 0.92, 0],   // brindle
];

// One person's whole appearance and pose, in module scratch. Nothing here allocates: the four
// public builders roll into this object and the private body routines read it back.
//
// Heights are fractions of the figure's own stature `h`, so a 1.55 m person is a small adult and
// not a scaled-down giant. hipY/hemY/shY are absolute local metres once a pose has been chosen.
const _F = {
  h: 1.75, bw: 1.0, flare: 1.0, hatted: false,
  skin: PED_SKIN[0], hair: PED_HAIR[0], coat: PED_COAT[0], chest: PED_SHIRT[0],
  leg: PED_TROUSER[0], acc: null, accBack: false, accSide: 1, hemF: 0.46,
  hipX: 0, hipY: 0.9625, hemY: 0.805, shY: 1.4315,
  lean: 0, swing: 0, reach: 0, handY: 0.8225,
};

// Roll one person. `allowBag` false is for riders and dog walkers, whose hands are busy.
function rollFigure(rng, allowBag) {
  _F.h = rr(rng, 1.55, 1.95);
  _F.bw = rr(rng, 0.88, 1.16);
  _F.skin = pickOf(rng, PED_SKIN);
  _F.hatted = rnd(rng) < 0.26;
  _F.hair = _F.hatted ? pickOf(rng, PED_HAT) : pickOf(rng, PED_HAIR);
  const dress = rnd(rng) < 0.17;
  _F.flare = dress ? rr(rng, 1.10, 1.36) : 1.0;
  _F.coat = dress ? pickOf(rng, PED_SKIRT) : pickOf(rng, PED_COAT);
  _F.chest = pickOf(rng, PED_SHIRT);
  _F.leg = dress ? _F.skin : pickOf(rng, PED_TROUSER);
  _F.hemF = dress ? rr(rng, 0.34, 0.46) : rr(rng, 0.38, 0.52);
  const roll = rnd(rng);
  const wants = allowBag !== false;
  _F.accBack = wants && roll < 0.17;
  _F.acc = (wants && roll < 0.36) ? pickOf(rng, PED_BAG) : null;
  _F.accSide = rnd(rng) < 0.5 ? 1 : -1;
}

// The body leans as a shear about the hips: nothing below the hip moves, the shoulders move by
// `lean`, and the head extrapolates past them. Every part that hangs off the spine places itself
// through this, so a leaning figure stays assembled. The divide is guarded: a pose that collapses
// shY onto hipY would otherwise send the whole upper body to infinity.
function shearAt(y) {
  const d = _F.shY - _F.hipY;
  return _F.hipX + _F.lean * ((y - _F.hipY) / (Math.abs(d) > EPS ? d : 1));
}

// Torso, arms and head: 36 + 60 + 30 = 126 verts.
//
// The coat is five faces of one hull and the chest is the sixth, drawn in a second garment
// colour. That is the front cue the eye needs at 30 m, and because the two passes are different
// FACES of the same hull rather than an overlay, there is no plane to z-fight. The head repeats
// the trick: hair (or hat) on four faces, a skin face on +X.
//
// The torso is CLOSED, all six faces, and the sleeves are closed at the wrist. Those eighteen
// verts are not decoration: a coat hem sits at 0.7-1.0 m and a cuff at 0.8 m, and both are reachable
// from a low fly camera, which with back-face culling would look straight through the figure. The
// head's neck and the sleeve and leg tops need no such face — they are buried inside the closed
// torso — and the soles need none either, because they lie on the pavement mesh.
function figureTorso(mb, px, py, pz, c, s) {
  const H = _F.h, bw = _F.bw;
  const shZ = 0.118 * H * bw, shX = 0.062 * H * bw;
  const hpZ = 0.098 * H * bw * _F.flare, hpX = 0.058 * H * bw * _F.flare;
  const bx = shearAt(_F.hemY), tx = shearAt(_F.shY);

  setL(0, bx - hpX, _F.hemY, -hpZ); setL(1, bx + hpX, _F.hemY, -hpZ);
  setL(2, tx - shX, _F.shY, -shZ);  setL(3, tx + shX, _F.shY, -shZ);
  setL(4, bx - hpX, _F.hemY, hpZ);  setL(5, bx + hpX, _F.hemY, hpZ);
  setL(6, tx - shX, _F.shY, shZ);   setL(7, tx + shX, _F.shY, shZ);
  setMat(mb, _F.coat);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PX);
  setMat(mb, _F.chest);
  hullL(mb, px, py, pz, c, s, F_PX);

  // Arms. The shoulder end is tucked wholly inside the torso — narrower in Z than the shoulder
  // and 2 cm below its top — so the open top of each sleeve can never be seen from above, and
  // the sleeve splays outboard as it drops, which is how a coat actually hangs. The splay is
  // measured, not guessed: the hand ends up 0.26 m off the midline, putting a 1.75 m figure at
  // 0.52 m across the arms against a real adult's 0.50-0.55.
  const aY = _F.shY - 0.020 * H;
  const ax = shearAt(aY);
  const aw = 0.046 * H * bw;
  const hx = tx + _F.reach;
  setMat(mb, _F.coat);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const hxs = hx + sg * _F.swing;
    const z0 = sg > 0 ? shZ * 0.44 : -shZ * 0.96;
    const z1 = sg > 0 ? shZ * 0.96 : -shZ * 0.44;
    const w0 = sg > 0 ? shZ * 0.80 : -shZ * 1.24;
    const w1 = sg > 0 ? shZ * 1.24 : -shZ * 0.80;
    setL(0, hxs - aw * 0.84, _F.handY, w0); setL(1, hxs + aw * 0.84, _F.handY, w0);
    setL(2, ax - aw, aY, z0);               setL(3, ax + aw, aY, z0);
    setL(4, hxs - aw * 0.84, _F.handY, w1); setL(5, hxs + aw * 0.84, _F.handY, w1);
    setL(6, ax - aw, aY, z1);               setL(7, ax + aw, aY, z1);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_NY);
  }

  // Head. The bottom of the hull is the neck and sits BELOW the top of the torso, so there is
  // never a gap at the collar and the open underside is buried. A hat is the same hull, two
  // centimetres taller and a little wider, in a hat colour — free.
  const nbY = _F.shY - 0.030 * H;
  const crY = _F.shY + (_F.hatted ? 0.196 : 0.182) * H;
  const nX = 0.034 * H, nZ = 0.036 * H;
  const kX = (_F.hatted ? 0.056 : 0.052) * H, kZ = (_F.hatted ? 0.049 : 0.045) * H;
  const nx = shearAt(nbY), cx = shearAt(crY);
  setL(0, nx - nX, nbY, -nZ); setL(1, nx + nX, nbY, -nZ);
  setL(2, cx - kX, crY, -kZ); setL(3, cx + kX, crY, -kZ);
  setL(4, nx - nX, nbY, nZ);  setL(5, nx + nX, nbY, nZ);
  setL(6, cx - kX, crY, kZ);  setL(7, cx + kX, crY, kZ);
  setMat(mb, _F.hair);
  hullL(mb, px, py, pz, c, s, F_NOBOT & ~F_PX);
  setMat(mb, _F.skin);
  hullL(mb, px, py, pz, c, s, F_PX);
}

// Standing/walking legs, 48 verts. Each leg is one hull from the hip down to the sole, and the
// sole rectangle is longer in X than the thigh, which puts a foot on the end of the leg for
// nothing. `stride` splits the pair fore and aft, `ahead` shifts both feet forward (a figure
// leaning back on a wall), `cross` pulls them toward the midline.
//
// BOTH SOLES STAY FLAT ON THE GROUND. The obvious way to draw a toe-off is to lift the trailing
// heel, and it is wrong: a 5 cm heel lift is a third of a pixel of gait at 30 m, but it opens a
// 5 x 12 cm slot under the foot that the pavement no longer covers, and at 10 m, from behind, that
// is a couple of hundred pixels of daylight straight through the figure. The trailing foot instead
// stretches its toe and pulls in its heel, which is what toe-off actually looks like in profile,
// costs nothing, and keeps the sole exactly on the ground where the pavement seals it.
function figureLegs(mb, px, py, pz, c, s, stride, ahead, cross) {
  const H = _F.h, bw = _F.bw;
  const lz = 0.050 * H * bw, lw = 0.040 * H * bw;
  const tx = 0.048 * H * bw;
  const fw = 0.034 * H * bw;
  const roll = Math.min(1, Math.abs(stride) / (0.10 * H));
  setMat(mb, _F.leg);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const back = sg * stride < 0 ? roll : 0;
    const heel = (0.058 - 0.026 * back) * H;
    const toe = (0.092 + 0.030 * back) * H;
    const fx = ahead + sg * stride;
    const fz = sg * (lz - cross);
    const hz = sg * lz;
    setL(0, fx - heel, 0, fz - fw); setL(1, fx + toe, 0, fz - fw);
    setL(2, _F.hipX - tx, _F.hipY, hz - lw); setL(3, _F.hipX + tx, _F.hipY, hz - lw);
    setL(4, fx - heel, 0, fz + fw); setL(5, fx + toe, 0, fz + fw);
    setL(6, _F.hipX - tx, _F.hipY, hz + lw); setL(7, _F.hipX + tx, _F.hipY, hz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
}

// Seated legs: one lap block plus two shins, 84 verts. Two separate thighs would cost 24 more and
// read identically at 10 m, which is as close as anyone ever gets to a bench.
function figureSeatLegs(mb, px, py, pz, c, s, ph) {
  const H = _F.h, bw = _F.bw;
  const seatY = _F.hipY;
  const th = 0.118 * H;
  const kx = _F.hipX + 0.245 * H;
  const lz = 0.050 * H * bw, lw = 0.040 * H * bw;
  setMat(mb, _F.leg);
  boxL(mb, px, py, pz, c, s,
    _F.hipX - 0.062 * H, seatY - th, -0.105 * H * bw,
    kx, seatY, 0.105 * H * bw, F_ALL);
  const fx = kx + 0.020 * H + 0.030 * H * ph;
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const cz = sg * lz;
    const fo = sg * 0.018 * H * ph;
    const ky = seatY - th * 0.45;
    setL(0, fx - 0.058 * H + fo, 0, cz - lw * 0.88);
    setL(1, fx + 0.090 * H + fo, 0, cz - lw * 0.88);
    setL(2, kx - 0.092 * H, ky, cz - lw);
    setL(3, kx - 0.006 * H, ky, cz - lw);
    setL(4, fx - 0.058 * H + fo, 0, cz + lw * 0.88);
    setL(5, fx + 0.090 * H + fo, 0, cz + lw * 0.88);
    setL(6, kx - 0.092 * H, ky, cz + lw);
    setL(7, kx - 0.006 * H, ky, cz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
}

// Bag or backpack, 30 verts either way. Both bury one face in the coat and close the other five:
// the backpack its front, the shoulder bag its inboard side. The bag is carried high, above the
// highest possible hem and well inside the torso's plan, so the buried face stays buried for every
// build, every hem length and every stride — an arm swings, a torso does not.
function figureAccessory(mb, px, py, pz, c, s) {
  if (!_F.acc) return;
  const H = _F.h, bw = _F.bw;
  setMat(mb, _F.acc);
  if (_F.accBack) {
    const y0 = _F.hipY + 0.055 * H, y1 = _F.shY - 0.035 * H;
    const b0 = shearAt(y0) - 0.050 * H * bw, b1 = shearAt(y1) - 0.050 * H * bw;
    const d = 0.082 * H, w = 0.080 * H * bw;
    setL(0, b0 - d * 0.88, y0, -w * 0.88); setL(1, b0, y0, -w * 0.88);
    setL(2, b1 - d, y1, -w);               setL(3, b1, y1, -w);
    setL(4, b0 - d * 0.88, y0, w * 0.88);  setL(5, b0, y0, w * 0.88);
    setL(6, b1 - d, y1, w);                setL(7, b1, y1, w);
    hullL(mb, px, py, pz, c, s, F_ALL & ~F_PX);
  } else {
    const sg = _F.accSide;
    const y0 = _F.hipY - 0.020 * H, y1 = _F.hipY + 0.145 * H;
    const b0 = shearAt(y0), b1 = shearAt(y1);
    const zi = 0.080 * H * bw, zo = 0.165 * H * bw;
    const z0 = sg > 0 ? zi : -zo;
    const z1 = sg > 0 ? zo : -zi;
    setL(0, b0 - 0.044 * H, y0, z0); setL(1, b0 + 0.044 * H, y0, z0);
    setL(2, b1 - 0.046 * H, y1, z0); setL(3, b1 + 0.046 * H, y1, z0);
    setL(4, b0 - 0.044 * H, y0, z1); setL(5, b0 + 0.044 * H, y0, z1);
    setL(6, b1 - 0.046 * H, y1, z1); setL(7, b1 + 0.046 * H, y1, z1);
    hullL(mb, px, py, pz, c, s, F_ALL & ~(sg > 0 ? F_NZ : F_PZ));
  }
}

// An upright figure in one of the four standing poses. `ph` is the gait phase in [-1, 1]: at +1
// the +Z leg is fully forward, at -1 fully back, and near 0 the figure is caught mid-stance.
function uprightFigure(mb, px, py, pz, c, s, pose, ph) {
  const H = _F.h;
  let stride, swing, lean, ahead, cross;
  if (pose === 'walk') {
    stride = 0.150 * H * ph; swing = -0.115 * H * ph;
    lean = 0.014 * H; ahead = 0; cross = 0;
  } else if (pose === 'walkFast') {
    stride = 0.225 * H * ph; swing = -0.185 * H * ph;
    lean = 0.034 * H; ahead = 0.010 * H; cross = 0;
  } else if (pose === 'lean') {
    stride = 0.030 * H * ph; swing = 0.014 * H;
    lean = -0.052 * H; ahead = 0.105 * H; cross = 0.030 * H;
  } else {
    stride = 0.022 * H * ph; swing = 0.012 * H * ph;
    lean = 0; ahead = 0; cross = 0;
  }
  _F.hipX = 0;
  _F.hipY = 0.550 * H;
  _F.hemY = _F.hemF * H;
  _F.shY = 0.818 * H;
  _F.lean = lean;
  _F.swing = swing;
  _F.reach = 0;
  _F.handY = 0.470 * H;
  figureLegs(mb, px, py, pz, c, s, stride, ahead, cross);
  figureTorso(mb, px, py, pz, c, s);
  figureAccessory(mb, px, py, pz, c, s);
}

// One person. `pose` is 'stand' | 'walk' | 'walkFast' | 'sit' | 'lean'; anything else stands.
// 174 verts upright plus 30 for a bag, 210 seated.
export function appendPedestrian(mb, rng, x, y, z, yaw, pose) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  rollFigure(rng, pose !== 'sit');
  const ph = rr(rng, -1, 1);

  if (pose === 'sit') {
    const H = _F.h;
    _F.hipX = -0.175 * H;
    _F.hipY = 0.255 * H;
    _F.hemY = _F.hipY - 0.005 * H;
    _F.shY = _F.hipY + 0.352 * H;
    _F.lean = 0.030 * H;
    _F.swing = 0.012 * H * ph;
    _F.reach = 0.150 * H;
    _F.handY = _F.hipY + 0.045 * H;
    figureSeatLegs(mb, px, py, pz, c, s, ph);
    figureTorso(mb, px, py, pz, c, s);
    return;
  }

  const p = (pose === 'walk' || pose === 'walkFast' || pose === 'lean') ? pose : 'stand';
  uprightFigure(mb, px, py, pz, c, s, p, ph);
}

// Two to four people loosely clustered on one spot: a knot outside a bar, a family at a corner,
// colleagues waiting for a light. Roughly half the groups are walking together and face the same
// way; the rest are standing and turned in toward each other, which is what makes a knot of
// people read as a conversation instead of a queue.
export function appendPedestrianGroup(mb, rng, x, y, z, yaw, n) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const k = clamp(Math.round(fin(n, 3)), 2, 4);
  const moving = rnd(rng) < 0.55;
  const base = (rnd(rng) * TAU) - Math.PI;

  for (let i = 0; i < k; i++) {
    const ang = base + (i / k) * TAU + rr(rng, -0.42, 0.42);
    const rad = rr(rng, 0.40, 0.95);
    const ox = Math.cos(ang) * rad, oz = Math.sin(ang) * rad;
    // Local offset -> world, using the same rotation every other piece in this module uses.
    const wx = px + ox * c + oz * s;
    const wz = pz - ox * s + oz * c;
    // Facing the group centre means pointing along (-ox, -oz), i.e. local yaw atan2(oz, -ox).
    const face = moving ? rr(rng, -0.26, 0.26) : Math.atan2(oz, -ox) + rr(rng, -0.30, 0.30);
    let pose;
    if (moving) pose = rnd(rng) < 0.24 ? 'walkFast' : 'walk';
    else pose = rnd(rng) < 0.14 ? 'lean' : 'stand';
    appendPedestrian(mb, rng, wx, py, wz, a + face, pose);
  }
}

// A cyclist and the bicycle under them, 294 verts. Local +X is the direction of travel, so a
// caller places one exactly like a car: yaw = Math.atan2(-dz, dx) for a lane running (dx, dz).
//
// The bike is drawn in units of the rider's own stature (bs = h / 1.75) so a small rider is not
// perched on a full-size frame. Wheels are filled discs at six segments, matching the parked-car
// wheels they will be seen next to.
//
// The frame is three tubes — fork, down tube, seat stay — plus the bar, each a two-sided card
// with no thickness across the bike. A real 3 cm tube is a third of a pixel at 20 m, and giving
// it thickness with only its two side faces drawn would leave the ends open: a bicycle seen
// head-on would show the inside of its own frame. Zero thickness cannot. The top tube and the
// chain stay are deliberately absent — the rider's legs and torso fill the first, the rear wheel
// covers the second — and the saddle is absent too, because the rider's hips are already there.
export function appendCyclist(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  rollFigure(rng, false);
  const H = _F.h;
  const bs = H / 1.75;
  if (rnd(rng) < 0.62) { _F.hair = pickOf(rng, PED_HELMET); _F.hatted = true; }

  const R = 0.335 * bs;
  const rear = -0.535 * bs, front = 0.535 * bs;
  const bbx = -0.065 * bs, bby = 0.268 * bs;
  const sadx = -0.395 * bs, sady = 0.875 * bs;
  const barx = 0.415 * bs, bary = 0.985 * bs;

  setMat(mb, M.tyre);
  discZ(mb, px, py, pz, c, s, 0, rear, R, R, 6);
  discZ(mb, px, py, pz, c, s, 0, front, R, R, 6);

  setMat(mb, pickOf(rng, BIKE_FRAME));
  beamL(mb, px, py, pz, c, s, front, R, 0, 0.445 * bs, 0.955 * bs, 0,
    0, 0.021 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, bbx, bby, 0, 0.455 * bs, 0.800 * bs, 0,
    0, 0.023 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, rear, R, 0, sadx, sady - 0.030 * bs, 0,
    0, 0.020 * bs, F_PLATEX);
  beamL(mb, px, py, pz, c, s, barx, bary, -0.215 * bs, barx, bary, 0.215 * bs,
    0, 0.017 * bs, F_PLATEX);

  // Rider. The hips sit on the saddle at 0.50 of stature, which is where a saddle belongs, and
  // the torso shears forward to put the hands on the bars.
  _F.hipX = sadx;
  _F.hipY = 0.500 * H;
  _F.hemY = _F.hipY - 0.030 * H;
  _F.shY = _F.hipY + 0.320 * H;
  _F.lean = 0.240 * H;
  _F.swing = 0;
  _F.reach = barx - (_F.hipX + _F.lean);
  _F.handY = bary;

  // Legs: hip to pedal, one hull each, cranks horizontal. The two come out at noticeably
  // different lengths and the pair reads as one leg straight and one folded.
  const crank = 0.170 * bs;
  setMat(mb, _F.leg);
  for (let i = 0; i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const fx = bbx + sg * crank;
    const pzl = sg * 0.082 * bs;
    const hz = sg * 0.050 * H * _F.bw;
    const lw = 0.040 * H * _F.bw, fw = 0.034 * H * _F.bw, tw = 0.048 * H * _F.bw;
    setL(0, fx - 0.055 * H, bby, pzl - fw); setL(1, fx + 0.085 * H, bby, pzl - fw);
    setL(2, _F.hipX - tw, _F.hipY, hz - lw); setL(3, _F.hipX + tw, _F.hipY, hz - lw);
    setL(4, fx - 0.055 * H, bby, pzl + fw); setL(5, fx + 0.085 * H, bby, pzl + fw);
    setL(6, _F.hipX - tw, _F.hipY, hz + lw); setL(7, _F.hipX + tw, _F.hipY, hz + lw);
    hullL(mb, px, py, pz, c, s, F_SIDES);
  }
  figureTorso(mb, px, py, pz, c, s);
}

// A dog on a lead. Local +X is the muzzle, (x, y, z) is on the pavement. 180 verts. The barrel
// and the head are closed volumes: a dog's belly is only half a metre up and its underside is an
// ordinary thing to see from a low camera or across a kerb.
function dogFigure(mb, rng, px, py, pz, a, sc) {
  const c = Math.cos(a), s = Math.sin(a);
  const gait = rr(rng, -1, 1);
  setMat(mb, pickOf(rng, DOG_COAT));

  // Barrel: deeper at the shoulder than at the loin, which is the whole silhouette of a dog.
  setL(0, -0.340 * sc, 0.285 * sc, -0.100 * sc); setL(1, 0.200 * sc, 0.265 * sc, -0.108 * sc);
  setL(2, -0.340 * sc, 0.500 * sc, -0.092 * sc); setL(3, 0.200 * sc, 0.545 * sc, -0.108 * sc);
  setL(4, -0.340 * sc, 0.285 * sc, 0.100 * sc);  setL(5, 0.200 * sc, 0.265 * sc, 0.108 * sc);
  setL(6, -0.340 * sc, 0.500 * sc, 0.092 * sc);  setL(7, 0.200 * sc, 0.545 * sc, 0.108 * sc);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Neck and head as one wedge, rooted inside the chest.
  setL(0, 0.160 * sc, 0.430 * sc, -0.070 * sc); setL(1, 0.470 * sc, 0.455 * sc, -0.055 * sc);
  setL(2, 0.160 * sc, 0.665 * sc, -0.076 * sc); setL(3, 0.470 * sc, 0.600 * sc, -0.058 * sc);
  setL(4, 0.160 * sc, 0.430 * sc, 0.070 * sc);  setL(5, 0.470 * sc, 0.455 * sc, 0.055 * sc);
  setL(6, 0.160 * sc, 0.665 * sc, 0.076 * sc);  setL(7, 0.470 * sc, 0.600 * sc, 0.058 * sc);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Four legs, diagonal pairs offset so the animal is trotting rather than standing to attention.
  for (let i = 0; i < 4; i++) {
    const fr = (i & 2) === 0;
    const sg = (i & 1) ? 1 : -1;
    const bx = fr ? 0.145 * sc : -0.255 * sc;
    const sw = (fr ? 1 : -1) * sg * 0.055 * sc * gait;
    boxL(mb, px, py, pz, c, s,
      bx + sw - 0.030 * sc, 0, sg * 0.062 * sc - 0.024 * sc,
      bx + sw + 0.030 * sc, 0.320 * sc, sg * 0.062 * sc + 0.024 * sc, F_SIDES);
  }

  beamL(mb, px, py, pz, c, s, -0.330 * sc, 0.495 * sc, 0, -0.500 * sc, 0.660 * sc, 0,
    0, 0.019 * sc, F_PLATEX);
}

// Somebody walking a dog: 366 verts all in. The lead is a real member from the walker's hand to
// the dog's collar, which is what makes the pair read as one prop instead of two.
export function appendDogWalker(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const side = rnd(rng) < 0.5 ? 1 : -1;

  rollFigure(rng, false);
  const ph = rr(rng, -1, 1);
  uprightFigure(mb, px, py, pz, c, s, rnd(rng) < 0.78 ? 'walk' : 'stand', ph);

  const H = _F.h;
  const sc = rr(rng, 0.72, 1.18);
  const dx = rr(rng, 0.68, 1.05);
  const dz = side * rr(rng, 0.42, 0.78);
  const dyaw = rr(rng, -0.35, 0.35) - side * 0.16;

  dogFigure(mb, rng, px + dx * c + dz * s, py, pz - dx * s + dz * c, a + dyaw, sc);

  // Lead: the walker's hand on the dog's side, to the collar at the top of the dog's neck. The
  // dog's own yaw offset is applied in the walker's local frame so both ends land on real
  // geometry however the dog is angled.
  const shZ = 0.118 * H * _F.bw;
  const hx = shearAt(_F.shY) + side * _F.swing;
  const hz = side * shZ * 1.02;
  const cx = dx + 0.300 * sc * Math.cos(dyaw);
  const cz = dz - 0.300 * sc * Math.sin(dyaw);
  setMat(mb, M.dark);
  beamL(mb, px, py, pz, c, s, hx, _F.handY - 0.010 * H, hz, cx, 0.640 * sc, cz,
    0, 0.010, F_PLATEX);
}

/* ============================================================= waterfront == */
//
// CONTRACT §8.3. Hardware for an ENGINEERED edge: the quay wall is the land/water boundary, so
// everything here is bolted to a coping stone, driven into the lake bed, or floating on it.
//
// Convention as everywhere else in this file: (x, y, z) is the footprint centre at the level the
// piece STANDS on — coping top for quay hardware, water level for anything afloat — local +X is
// out over the water, and long pieces run along local Z.
//
// Amendment 7: only genuine light sources are emitters. The lifebuoy-station lamp and the
// navigation lights below are real lamps and carry emissive >= EMITTER_MIN; the ring, the
// daymarks and the buoys are painted steel and plastic and carry exactly zero.

// A ring of `seg` beams in the local X-Y plane (i.e. standing upright, facing along local Z),
// centred on (cx, cy) at local depth cz. 24 verts per segment.
function ringXY(mb, ox, oy, oz, c, s, cx, cy, cz, R, r, seg) {
  const n = Math.max(4, seg | 0);
  const rad = Math.max(1e-3, R);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
    beamL(mb, ox, oy, oz, c, s,
      cx + rad * Math.cos(a0), cy + rad * Math.sin(a0), cz,
      cx + rad * Math.cos(a1), cy + rad * Math.sin(a1), cz, r, r, F_ALL);
  }
}

/**
 * Mooring bollard: the cast-iron mushroom head on a bolted base plate that lines every metre of
 * working quay in the harbour. Origin is the coping top; the piece is radially symmetric, so
 * `yaw` only turns the base plate.
 */
export function appendMooringBollard(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.quayIron);
  boxL(mb, px, py, pz, c, s, -0.23, -0.02, -0.23, 0.23, 0.055, 0.23, F_NOBOT);
  mb.cylinder(px, py + 0.05, pz, 0.155, 0.118, 0.40, 8, a, false);
  mb.cylinder(px, py + 0.45, pz, 0.118, 0.185, 0.11, 8, a, false);
  mb.cylinder(px, py + 0.56, pz, 0.185, 0.150, 0.055, 8, a, false);
  discY(mb, px, py + 0.615, pz, 0.150, 8, a, true);
}

/**
 * Recessed steel access ladder down the quay face. Origin is the coping top at the wall line,
 * local +X out over the water; `drop` is how far below the coping the stringers run, which the
 * caller takes from the water level so the bottom rung is always submerged.
 */
export function appendQuayLadder(mb, x, y, z, yaw, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const d = clamp(fin(drop, 2.4), 0.8, 8.0);

  setMat(mb, M.galv);
  // Stringers, standing 0.85 m proud of the coping as a grab handle.
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * 0.23;
    boxL(mb, px, py, pz, c, s, 0.055, -d, lz - 0.035, 0.125, 0.85, lz + 0.035, F_SIDES);
  }
  const n = Math.max(2, Math.round(d / 0.34));
  for (let i = 0; i <= n; i++) {
    const ry = 0.10 - (i / n) * (d + 0.10);
    beamL(mb, px, py, pz, c, s, 0.06, ry, -0.23, 0.06, ry, 0.23, 0.026, 0.026, F_SIDES);
  }
  // Grab bar across the two stringers, over the coping.
  beamL(mb, px, py, pz, c, s, 0.09, 0.85, -0.23, 0.09, 0.85, 0.23, 0.030, 0.030, F_SIDES);
}

/**
 * Lifebuoy station: post, backboard, ring and the small lamp that lights it. The lamp is the only
 * emitter — a real light on a real pole, so it is dark at midday and on at night like every other
 * lamp in the city.
 */
export function appendLifebuoyStation(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.poleDark);
  mb.cylinder(px, py - 0.04, pz, 0.062, 0.052, 2.28, 6, a, false);
  setMat(mb, M.signRed);
  boxL(mb, px, py, pz, c, s, -0.030, 0.86, -0.42, 0.010, 1.74, 0.42, F_BLADEX);
  setMat(mb, M.lifeRing);
  ringXY(mb, px, py, pz, c, s, 0.10, 1.30, 0.0, 0.335, 0.058, 9);
  setMat(mb, M.canvas);
  beamL(mb, px, py, pz, c, s, 0.10, 1.63, 0.0, 0.10, 1.30, 0.34, 0.014, 0.014, F_ALL);

  setMat(mb, M.lampBody);
  boxL(mb, px, py, pz, c, s, -0.09, 2.24, -0.11, 0.16, 2.36, 0.11, F_NOBOT);
  setMat(mb, M.quayLamp);
  quadDown(mb, px, py, pz, c, s, -0.07, -0.09, 0.14, 0.09, 2.239);
}

/**
 * Tubular guard rail: posts every ~2 m with a top rail and a knee rail, running `len` metres along
 * local Z and centred on the origin. Used on pier edges, gangway landings and the marina docks —
 * NOT along the open quay, which in Toronto has bollards and nothing else.
 */
export function appendQuayRailing(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = clamp(fin(len, 6.0), 1.2, 90.0);
  const hl = L * 0.5;
  const n = Math.max(2, Math.round(L / 2.1));

  setMat(mb, M.galv);
  for (let i = 0; i <= n; i++) {
    const lz = -hl + (i / n) * L;
    boxL(mb, px, py, pz, c, s, -0.032, 0.0, lz - 0.032, 0.032, 1.06, lz + 0.032, F_SIDES);
  }
  beamL(mb, px, py, pz, c, s, 0, 1.06, -hl, 0, 1.06, hl, 0.030, 0.030, F_ALL);
  beamL(mb, px, py, pz, c, s, 0, 0.55, -hl, 0, 0.55, hl, 0.022, 0.022, F_ALL);
}

/**
 * Backless timber bench on stone plinths — the Harbourfront promenade seat. Long axis along
 * local Z, and it faces local +X only in the sense that the plinths are set in from the ends.
 */
export function appendTimberBench(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = rr(rng, 1.70, 2.30);
  const hl = L * 0.5;

  setMat(mb, M.granite);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (hl - 0.34);
    boxL(mb, px, py, pz, c, s, -0.24, 0.0, lz - 0.10, 0.24, 0.40, lz + 0.10, F_NOBOT);
  }
  setMat(mb, M.quayTimber);
  for (let i = 0; i < 3; i++) {
    const x0 = -0.255 + i * 0.175;
    boxL(mb, px, py, pz, c, s, x0, 0.40, -hl, x0 + 0.145, 0.455, hl, F_NOBOT);
  }
}

/**
 * One armour block from the rubble mound: an irregular quarried lump. `s` is its nominal size in
 * metres. The shape is seeded on WORLD POSITION (CONTRACT §8.4) so a given rock is the same rock
 * whether or not its neighbours were built, but an rng may be passed to jitter it further.
 */
export function appendWaveRock(mb, rng, x, y, z, s) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(s, 1.2), 0.25, 6.0);
  const h0 = hash2(px, pz);
  const a = h0 * TAU;
  const c = Math.cos(a), sn = Math.sin(a);
  const j = (i) => 0.62 + 0.42 * hash2(px + i * 7.13, pz - i * 4.31);

  setMat(mb, M.armourStone);
  const hy = sc * (0.42 + 0.26 * h0);
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? 1 : -1, sy = (i & 2) ? 1 : -1, sz = (i & 4) ? 1 : -1;
    // The top face is pulled in so the block reads as a quarried wedge rather than a crate.
    const shrink = sy > 0 ? 0.62 : 1.0;
    setL(i, sx * sc * 0.5 * j(i) * shrink, sy > 0 ? hy : -sc * 0.30,
      sz * sc * 0.5 * j(i + 4) * shrink);
  }
  hullL(mb, px, py, pz, c, sn, F_NOBOT);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Aluminium gangway from a fixed quay down to a floating dock. Origin is the quay-side hinge at
 * deck level, local +X runs out to the float, `len` is the span and `drop` how far the far end
 * sits below the origin.
 */
export function appendGangway(mb, x, y, z, yaw, len, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const L = clamp(fin(len, 7.0), 2.0, 24.0);
  const d = clamp(fin(drop, 1.4), 0.0, 6.0);
  const hw = 0.62;

  setMat(mb, M.grateIron);
  setL(0, 0, -0.10, -hw); setL(1, L, -0.10 - d, -hw);
  setL(2, 0, 0.02, -hw); setL(3, L, 0.02 - d, -hw);
  setL(4, 0, -0.10, hw); setL(5, L, -0.10 - d, hw);
  setL(6, 0, 0.02, hw); setL(7, L, 0.02 - d, hw);
  hullL(mb, px, py, pz, c, s, F_ALL);

  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * hw;
    beamL(mb, px, py, pz, c, s, 0.10, 1.00, lz, L - 0.10, 1.00 - d, lz, 0.028, 0.028, F_ALL);
    const n = Math.max(2, Math.round(L / 2.0));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      beamL(mb, px, py, pz, c, s, 0.10 + t * (L - 0.20), 0.02 - t * d, lz,
        0.10 + t * (L - 0.20), 1.00 - t * d, lz, 0.026, 0.026, F_SIDES);
    }
  }
}

/**
 * Channel marker on a driven pile: daymark board, and a navigation light that is a REAL light —
 * the only emitter out on the water. `green` picks the starboard-hand colours over port-hand.
 */
export function appendNavMarker(mb, x, y, z, h, green) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 3.4), 1.6, 9.0);
  const a = hash2(px, pz) * TAU;
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.pileTimber);
  mb.cylinder(px, py - 1.60, pz, 0.135, 0.115, H + 1.60, 6, a, false);
  setMat(mb, green ? M.markerGreen : M.markerRed);
  boxL(mb, px, py, pz, c, s, -0.02, H - 0.86, -0.30, 0.02, H - 0.16, 0.30, F_BLADEX);
  setMat(mb, M.galv);
  boxL(mb, px, py, pz, c, s, -0.075, H - 0.06, -0.075, 0.075, H + 0.14, 0.075, F_NOBOT);
  setMat(mb, green ? M.navGreen : M.navRed);
  boxL(mb, px, py, pz, c, s, -0.055, H + 0.14, -0.055, 0.055, H + 0.30, 0.055, F_NOBOT);
}

/**
 * Mooring buoy riding on the water. Origin is the water surface; the body floats about half out.
 */
export function appendMooringBuoy(mb, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const rad = clamp(fin(r, 0.42), 0.15, 1.6);
  const a = hash2(px + 11.7, pz - 3.9) * TAU;

  setMat(mb, M.buoyYellow);
  mb.cylinder(px, py - rad * 0.55, pz, rad * 0.72, rad, rad * 0.85, 7, a, false);
  mb.cylinder(px, py + rad * 0.30, pz, rad, rad * 0.34, rad * 0.42, 7, a, false);
  discY(mb, px, py + rad * 0.72, pz, rad * 0.34, 7, a, true);
  setMat(mb, M.quayIron);
  ringXY(mb, px, py, pz, Math.cos(a), Math.sin(a), 0, rad * 0.95, 0, rad * 0.20, 0.030, 6);
}

/**
 * Pile dolphin: the bound cluster of timber piles that takes the berthing load at a slip mouth or
 * a ferry terminal. Origin is the water surface, `r` the cluster radius.
 */
export function appendDolphin(mb, rng, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const rad = clamp(fin(r, 0.85), 0.35, 3.0);
  const n = rad > 1.1 ? 7 : 5;
  const a0 = hash2(px, pz) * TAU;
  const top = 2.35 + 0.9 * hash2(px - 5.5, pz + 2.2);

  setMat(mb, M.pileTimber);
  for (let i = 0; i < n; i++) {
    const th = a0 + (i / n) * TAU;
    const rr0 = i === 0 && n === 7 ? 0 : rad;
    const cx = px + Math.cos(th) * rr0, cz = pz + Math.sin(th) * rr0;
    // Piles are driven splayed: the head leans in, so the cluster is a cone, not a fence.
    mb.cylinder(cx, py - 2.60, cz, 0.175, 0.150, top + 2.60, 5, th, false);
  }
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const by = py + top - 0.30 - k * 0.75;
    torusY(mb, px, by, pz, rad + 0.17, 0.052, 8, 3, a0);
  }
  if (typeof rng === 'function') rnd(rng);
}

/* ================================================ islands, airfield, ferry = */
//
// The south half of the map — the Toronto Islands, Billy Bishop and the harbour gaps — is a
// different place from downtown and needs its own vocabulary: mature parkland trees rather than
// street trees in pits, hedgerows and bedding, beach grass, boardwalk rails, the amusement park,
// the lighthouse, aircraft, and the ferries that are the only way onto the islands.
//
// Amendment 7 still governs. The ONLY emitters below are genuine light sources: runway edge,
// threshold and end lights, taxiway edge lights, the approach bars out over the Western Gap, and
// the lighthouse lantern. Aircraft, hangars, hedges, sand and boats carry emissive 0.

// Trunk plus a two-stage taper, taller and thicker than the street version. Shared by every
// island tree species.
function boughs(mb, rng, px, py, pz, sc, a, spread, rise, n) {
  setMat(mb, rnd(rng) < 0.4 ? M.barkPale : M.bark);
  for (let i = 0; i < n; i++) {
    const ang = a + (i / n) * TAU + rr(rng, -0.42, 0.42);
    beam(mb, px, py, pz,
      px + Math.cos(ang) * spread * sc, py + rise * sc, pz + Math.sin(ang) * spread * sc,
      0.062 * sc, 0.062 * sc, F_SIDES);
  }
}

/**
 * Mature parkland tree. `species`: 0 broadleaf (maple, oak — round crown), 1 cottonwood (tall,
 * narrow, the island shelterbelts), 2 weeping willow (short bole, wide drooping crown).
 *
 * Bigger than appendParkTree and built for DISTANCE: these carry the islands' silhouette from
 * two kilometres out, so the crown gets the vertices and the bole does not.
 */
export function appendCanopyTree(mb, rng, x, y, z, scale, species) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.5, 3.4);
  const sp = ((fin(species, 0) | 0) % 3 + 3) % 3;
  const a = rr(rng, 0, TAU);
  const leaf = rnd(rng) < 0.42 ? M.foliageWarm : (rnd(rng) < 0.52 ? M.foliageCool : M.foliage);

  if (sp === 1) {
    // Cottonwood / Lombardy poplar: a column. One tall bole and a narrow stack of clumps.
    const h0 = 3.2 * sc, h1 = 4.4 * sc;
    trunk(mb, rng, px, py, pz, 0.26 * sc, 0.19 * sc, 0.10 * sc, h0, h1);
    setMat(mb, leaf);
    for (let i = 0; i < 3; i++) {
      const cy = py + h0 + h1 * (0.18 + i * 0.34);
      const r = (1.05 - i * 0.22) * sc;
      blob(mb, rng, px + rr(rng, -0.22, 0.22) * sc, cy, pz + rr(rng, -0.22, 0.22) * sc,
        r, 1.35 * sc, r, 7);
    }
    return;
  }
  if (sp === 2) {
    // Willow: a short heavy bole, then a wide crown whose clumps hang BELOW their attachment so
    // the canopy sweeps down toward the water it always stands beside.
    const h0 = 1.55 * sc, h1 = 1.30 * sc;
    trunk(mb, rng, px, py, pz, 0.42 * sc, 0.30 * sc, 0.20 * sc, h0, h1);
    boughs(mb, rng, px, py + h0 + h1 * 0.6, pz, sc, a, 1.05, 0.95, 3);
    setMat(mb, leaf);
    const cy = py + h0 + h1 + 0.55 * sc;
    blob(mb, rng, px, cy, pz, 1.65 * sc, 1.05 * sc, 1.65 * sc, 8);
    for (let i = 0; i < 4; i++) {
      const ang = a + (i / 4) * TAU + rr(rng, -0.35, 0.35);
      const off = rr(rng, 1.20, 1.95) * sc;
      blob(mb, rng, px + Math.cos(ang) * off, cy - rr(rng, 0.55, 1.15) * sc,
        pz + Math.sin(ang) * off,
        rr(rng, 0.85, 1.25) * sc, rr(rng, 0.95, 1.45) * sc, rr(rng, 0.85, 1.25) * sc, 7);
    }
    return;
  }
  // Broadleaf: the default island canopy.
  const h0 = 2.35 * sc, h1 = 2.55 * sc;
  trunk(mb, rng, px, py, pz, 0.40 * sc, 0.27 * sc, 0.165 * sc, h0, h1);
  boughs(mb, rng, px, py + h0 + h1 * 0.55, pz, sc, a, 1.15, 1.25, 2);
  setMat(mb, leaf);
  const cy = py + h0 + h1 + 0.60 * sc;
  blob(mb, rng, px, cy + 0.35 * sc, pz, 1.95 * sc, 1.40 * sc, 1.95 * sc, 8);
  for (let i = 0; i < 3; i++) {
    const ang = a + (i / 3) * TAU + rr(rng, -0.40, 0.40);
    const off = rr(rng, 1.10, 1.85) * sc;
    blob(mb, rng, px + Math.cos(ang) * off, cy + rr(rng, -0.45, 0.85) * sc,
      pz + Math.sin(ang) * off,
      rr(rng, 1.05, 1.60) * sc, rr(rng, 0.80, 1.25) * sc, rr(rng, 1.05, 1.60) * sc, 7);
  }
}

/**
 * A run of clipped hedge along local Z. Built as a chain of overlapping lobes rather than one
 * long box, because a hedge read end-on is a silhouette of bumps and a box is a wall.
 * `len` is the run length, `h` the trimmed height, `w` the width.
 */
export function appendHedgeRun(mb, rng, x, y, z, yaw, len, h, w) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 6), 0.6, 90);
  const H = clamp(fin(h, 1.35), 0.4, 3.4);
  const W = clamp(fin(w, 0.85), 0.25, 3.0);
  const c = Math.cos(a), s = Math.sin(a);
  const n = Math.max(1, Math.round(L / Math.max(0.9, W * 1.35)));

  setMat(mb, M.hedgeLeaf);
  for (let i = 0; i < n; i++) {
    const lz = -L * 0.5 + L * ((i + 0.5) / n);
    const bx = px + lz * s, bz = pz + lz * c;
    const jitter = 0.88 + 0.24 * hash2(bx, bz);
    blob(mb, rng, bx, py + H * 0.52 * jitter, bz,
      W * 0.55, H * 0.54 * jitter, L / n * 0.78, 6);
  }
}

/** A planted bed: turned soil, a low kerb of edging brick, and clumps of bedding in three hues. */
export function appendFlowerBed(mb, rng, x, y, z, yaw, w, d) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 3), 0.5, 26);
  const D = clamp(fin(d, 2), 0.5, 26);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.granite);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, 0.11, hd, F_NOBOT);
  setMat(mb, M.bedSoil);
  quadUp(mb, px, py, pz, c, s, -hw + 0.10, -hd + 0.10, hw - 0.10, hd - 0.10, 0.14);

  const n = clamp(Math.round(W * D * 0.55), 2, 18);
  for (let i = 0; i < n; i++) {
    const lx = rr(rng, -hw + 0.22, hw - 0.22);
    const lz = rr(rng, -hd + 0.22, hd - 0.22);
    const bx = px + lx * c + lz * s, bz = pz - lx * s + lz * c;
    const u = rnd(rng);
    setMat(mb, u < 0.42 ? M.bloomWarm : (u < 0.72 ? M.bloomCool : M.bloomPale));
    blob(mb, rng, bx, py + 0.24, bz, 0.30, 0.16, 0.30, 5);
  }
}

/** Marram tuft on the back of a beach. Cheap: three flat blades, no stem. */
export function appendBeachGrass(mb, rng, x, y, z, scale) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const sc = clamp(fin(scale, 1), 0.3, 3.0);
  setMat(mb, M.duneGrass);
  const n = rnd(rng) < 0.5 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const ang = rr(rng, 0, TAU);
    const lean = rr(rng, 0.18, 0.46) * sc;
    beam(mb, px, py, pz,
      px + Math.cos(ang) * lean, py + rr(rng, 0.44, 0.86) * sc, pz + Math.sin(ang) * lean,
      0.085 * sc, 0.012, F_PLATEZ | F_PX | F_NX);
  }
}

/** Timber picnic table with attached benches. Long axis along local Z. */
export function appendPicnicTable(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = rr(rng, 0.85, 1.05);

  setMat(mb, M.woodSlat);
  boxL(mb, px, py, pz, c, s, -0.38, 0.71, -hl, 0.38, 0.76, hl, F_NOBOT);
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * 0.62;
    boxL(mb, px, py, pz, c, s, sx - 0.14, 0.43, -hl, sx + 0.14, 0.475, hl, F_NOBOT);
  }
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const lz = (k === 0 ? -1 : 1) * (hl - 0.22);
    beamL(mb, px, py, pz, c, s, -0.76, 0.0, lz, 0.34, 0.72, lz, 0.035, 0.035, F_ALL);
    beamL(mb, px, py, pz, c, s, 0.76, 0.0, lz, -0.34, 0.72, lz, 0.035, 0.035, F_ALL);
  }
}

/** Lifeguard chair: a tall timber seat on splayed legs, facing local +X (out to the water). */
export function appendLifeguardChair(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.woodSlat);
  for (let i = 0; i < 4; i++) {
    const sx = (i & 1) ? 0.42 : -0.42, sz = (i & 2) ? 0.42 : -0.42;
    beamL(mb, px, py, pz, c, s, sx * 1.55, 0, sz * 1.55, sx, 1.72, sz, 0.045, 0.045, F_ALL);
  }
  boxL(mb, px, py, pz, c, s, -0.46, 1.72, -0.46, 0.46, 1.80, 0.46, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.50, 1.80, -0.46, -0.42, 2.52, 0.46, F_NOBOT);
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const sz = (k === 0 ? -1 : 1) * 0.46;
    beamL(mb, px, py, pz, c, s, -0.46, 2.18, sz, 0.46, 2.18, sz, 0.026, 0.026, F_ALL);
  }
}

/**
 * Gibraltar Point Lighthouse: a tapered hexagonal rubble tower, a gallery, and a lantern that IS
 * a light (Amendment 7 — a navigation light is a real emitter). `h` is the tower height to the
 * gallery floor.
 */
export function appendLighthouse(mb, x, y, z, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const H = clamp(fin(h, 15.0), 5.0, 42.0);
  const a = hash2(px, pz) * TAU;

  setMat(mb, M.lightStone);
  mb.cylinder(px, py - 0.30, pz, 3.05, 2.72, 1.10, 6, a, false);
  mb.cylinder(px, py + 0.80, pz, 2.72, 1.62, H - 0.80, 6, a, false);
  // Gallery: a corbelled deck ring, then the balustrade.
  setMat(mb, M.granite);
  mb.cylinder(px, py + H, pz, 1.72, 2.16, 0.42, 6, a, false);
  discY(mb, px, py + H + 0.42, pz, 2.16, 6, a, true);
  setMat(mb, M.lightTrim);
  mb.cylinder(px, py + H + 0.42, pz, 2.10, 2.10, 0.86, 6, a, false);
  // Lantern room: a glazed drum under a conical cap, with the light inside it.
  setMat(mb, M.galv);
  mb.cylinder(px, py + H + 1.28, pz, 1.44, 1.44, 0.16, 6, a, false);
  setMat(mb, M.lanternLight);
  mb.cylinder(px, py + H + 1.44, pz, 1.30, 1.30, 1.70, 6, a, false);
  setMat(mb, M.lightTrim);
  mb.cylinder(px, py + H + 3.14, pz, 1.52, 0.10, 1.15, 6, a, false);
  mb.cylinder(px, py + H + 4.29, pz, 0.06, 0.03, 0.85, 4, a, false);
}

/**
 * One airfield light on its frangible base. `kind`: 0 runway edge (white), 1 threshold (green),
 * 2 runway end (red), 3 taxiway edge (blue). Genuine emitters, all four.
 */
export function appendRunwayLight(mb, x, y, z, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const k = (fin(kind, 0) | 0);
  const lens = k === 1 ? M.runwayGreen : (k === 2 ? M.runwayRed
    : (k === 3 ? M.taxiBlue : M.runwayEdge));

  setMat(mb, M.galv);
  mb.cylinder(px, py, pz, 0.115, 0.075, 0.20, 4, 0.4, false);
  setMat(mb, lens);
  mb.cylinder(px, py + 0.20, pz, 0.085, 0.070, 0.135, 4, 0.4, false);
  discY(mb, px, py + 0.335, pz, 0.070, 4, 0.4, true);
}

/**
 * One bar of the approach lighting system, out over the water off a runway threshold. A frangible
 * lattice mast carrying a crossbar of five lamps, at the height the bar has to be to stay level
 * with the runway as the ground falls away under it.
 */
export function appendApproachMast(mb, x, y, z, yaw, h, lamps) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const H = clamp(fin(h, 3.0), 0.6, 22.0);
  const n = clamp(fin(lamps, 5) | 0, 1, 9);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.galv);
  mb.cylinder(px, py - 1.2, pz, 0.16, 0.11, H + 1.2, 5, a, false);
  boxL(mb, px, py, pz, c, s, -0.07, H, -(n * 0.72) * 0.5, 0.07, H + 0.11, (n * 0.72) * 0.5,
    F_NOBOT);
  setMat(mb, M.approachLamp);
  for (let i = 0; i < n; i++) {
    const lz = (n === 1) ? 0 : (-(n - 1) * 0.36 + i * 0.72);
    boxL(mb, px, py, pz, c, s, -0.11, H + 0.11, lz - 0.13, 0.11, H + 0.36, lz + 0.13, F_NOBOT);
  }
}

/** Windsock on a mast. The sock hangs off local +X and tapers away from the mast. */
export function appendWindsock(mb, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);

  setMat(mb, M.galv);
  mb.cylinder(px, py, pz, 0.13, 0.085, 6.4, 6, a, false);
  boxL(mb, px, py, pz, c, s, -0.05, 6.20, -0.05, 0.72, 6.30, 0.05, F_NOBOT);
  ringXY(mb, px, py, pz, c, s, 0.72, 5.90, 0, 0.42, 0.030, 6);
  // Five bands: three orange, two white, tapering to the tail.
  for (let i = 0; i < 5; i++) {
    const x0 = 0.72 + i * 0.62, x1 = x0 + 0.62;
    const r0 = 0.42 - i * 0.055, r1 = 0.42 - (i + 1) * 0.055;
    setMat(mb, (i & 1) ? M.flagWhite : M.windsockFlag);
    setL(0, x0, 5.90 - r0, -r0); setL(1, x1, 5.90 - r1, -r1);
    setL(2, x0, 5.90 + r0, -r0); setL(3, x1, 5.90 + r1, -r1);
    setL(4, x0, 5.90 - r0, r0); setL(5, x1, 5.90 - r1, r1);
    setL(6, x0, 5.90 + r0, r0); setL(7, x1, 5.90 + r1, r1);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_PY | F_NY);
  }
}

/**
 * Aircraft hangar: a portal-framed steel shed with a shallow curved roof and a full-width sliding
 * door on local -X. `w` is the door span, `d` the depth, `h` the eaves height.
 */
export function appendHangar(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 34), 6, 140);
  const D = clamp(fin(d, 30), 6, 140);
  const H = clamp(fin(h, 9.5), 3.5, 26);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;
  const rise = clamp(H * 0.30, 1.2, 5.0);

  // Walls to the eaves, open at the top so the roof can arch over them.
  setMat(mb, M.hangarClad);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, H, hd, F_PX | F_PZ | F_NZ);
  // Curved roof, as a fan of quads across local Z with the crown over the middle.
  const seg = 6;
  const roofY = (t) => H + rise * Math.sin(Math.PI * clamp(t, 0, 1));
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const z0 = -hd + D * t0, z1 = -hd + D * t1;
    quadL(mb, px, py, pz, c, s,
      -hw, roofY(t1), z1, hw, roofY(t1), z1, hw, roofY(t0), z0, -hw, roofY(t0), z0);
  }
  // Gable infill above the eaves at each end.
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * hw;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const z0 = -hd + D * t0, z1 = -hd + D * t1;
      if (k === 0) {
        quadL(mb, px, py, pz, c, s, sx, H, z0, sx, H, z1, sx, roofY(t1), z1, sx, roofY(t0), z0);
      } else {
        quadL(mb, px, py, pz, c, s, sx, H, z1, sx, H, z0, sx, roofY(t0), z0, sx, roofY(t1), z1);
      }
    }
  }
  // The door: a sliding leaf set, recessed a little so the head beam reads.
  setMat(mb, M.hangarDoor);
  const dh = H * 0.86;
  quadNX(mb, px, py, pz, c, s, -hw + 0.14, 0.0, -hd + 0.35, dh, hd - 0.35);
  setMat(mb, M.hangarClad);
  quadNX(mb, px, py, pz, c, s, -hw, 0.0, -hd, H, -hd + 0.35);
  quadNX(mb, px, py, pz, c, s, -hw, 0.0, hd - 0.35, H, hd);
  quadNX(mb, px, py, pz, c, s, -hw, dh, -hd, H, hd);
  // Door leaf joints, and the track above them.
  setMat(mb, M.galv);
  const leaves = Math.max(2, Math.round(W / 9));
  for (let i = 1; i < leaves; i++) {
    const lz = -hd + 0.35 + (D - 0.70) * (i / leaves);
    boxL(mb, px, py, pz, c, s, -hw + 0.10, 0.0, lz - 0.055, -hw + 0.18, dh, lz + 0.055,
      F_NX | F_PZ | F_NZ);
  }
  boxL(mb, px, py, pz, c, s, -hw + 0.02, dh, -hd, -hw + 0.24, dh + 0.24, hd, F_NOBOT);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Regional turboprop on the apron — the aircraft Billy Bishop is known for. High wing, T-tail,
 * two nacelles with six-blade props. `len` is the fuselage length; the span follows from it.
 * Origin is the nose-wheel contact point at the pavement, nose along local +X.
 */
export function appendAirliner(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 32.8), 12, 60);
  const c = Math.cos(a), s = Math.sin(a);
  const r = L * 0.041;                 // fuselage radius
  const fy = L * 0.098;                // fuselage centreline above the pavement
  const span = L * 0.87;

  // Fuselage: four hull sections along local X, nose at +X.
  const sect = (x0, x1, r0, r1, y0, y1, mat) => {
    setMat(mb, mat);
    setL(0, x0, y0 - r0, -r0); setL(1, x1, y1 - r1, -r1);
    setL(2, x0, y0 + r0, -r0 * 0.92); setL(3, x1, y1 + r1, -r1 * 0.92);
    setL(4, x0, y0 - r0, r0); setL(5, x1, y1 - r1, r1);
    setL(6, x0, y0 + r0, r0 * 0.92); setL(7, x1, y1 + r1, r1 * 0.92);
    hullL(mb, px, py, pz, c, s, F_SIDES | F_PY | F_NY);
  };
  sect(L * 0.44, L * 0.50, r * 0.78, r * 0.20, fy, fy + r * 0.16, M.aircraftGrey);   // radome
  sect(L * 0.20, L * 0.44, r, r * 0.78, fy, fy, M.aircraftWhite);
  sect(-L * 0.20, L * 0.20, r, r, fy, fy, M.aircraftWhite);
  sect(-L * 0.42, -L * 0.20, r * 0.86, r, fy + r * 0.10, fy, M.aircraftWhite);
  sect(-L * 0.50, -L * 0.42, r * 0.20, r * 0.86, fy + r * 0.55, fy + r * 0.10, M.aircraftWhite);

  // Cheatline and cabin windows: one dark band each side, flush with the skin.
  setMat(mb, M.cabinGlass);
  quadPZ(mb, px, py, pz, c, s, r * 0.995, -L * 0.20, fy + r * 0.30, L * 0.34, fy + r * 0.56);
  quadNZ(mb, px, py, pz, c, s, -r * 0.995, -L * 0.20, fy + r * 0.30, L * 0.34, fy + r * 0.56);
  quadPZ(mb, px, py, pz, c, s, r * 0.72, L * 0.36, fy + r * 0.34, L * 0.45, fy + r * 0.70);
  quadNZ(mb, px, py, pz, c, s, -r * 0.72, L * 0.36, fy + r * 0.34, L * 0.45, fy + r * 0.70);
  setMat(mb, M.aircraftTrim);
  quadPZ(mb, px, py, pz, c, s, r * 1.0, -L * 0.46, fy - r * 0.26, L * 0.44, fy - r * 0.10);
  quadNZ(mb, px, py, pz, c, s, -r * 1.0, -L * 0.46, fy - r * 0.26, L * 0.44, fy - r * 0.10);

  // High wing, one hull per side: swept a touch, tapered, with dihedral.
  const wy = fy + r * 0.86;
  setMat(mb, M.aircraftWhite);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const tipZ = sg * span * 0.5;
    setL(0, L * 0.10, wy - r * 0.13, 0); setL(1, -L * 0.10, wy - r * 0.13, 0);
    setL(2, L * 0.10, wy + r * 0.13, 0); setL(3, -L * 0.10, wy + r * 0.13, 0);
    setL(4, L * 0.055, wy + r * 0.22, tipZ); setL(5, -L * 0.035, wy + r * 0.22, tipZ);
    setL(6, L * 0.055, wy + r * 0.36, tipZ); setL(7, -L * 0.035, wy + r * 0.36, tipZ);
    hullL(mb, px, py, pz, c, s, k === 0 ? (F_ALL & ~F_PZ) : (F_ALL & ~F_NZ));
  }

  // Nacelles, spinners and props.
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const nz = sg * span * 0.175;
    setMat(mb, M.aircraftGrey);
    setL(0, -L * 0.13, wy - r * 0.46, nz - r * 0.34); setL(1, L * 0.16, wy - r * 0.30, nz - r * 0.30);
    setL(2, -L * 0.13, wy + r * 0.16, nz - r * 0.34); setL(3, L * 0.16, wy + r * 0.22, nz - r * 0.30);
    setL(4, -L * 0.13, wy - r * 0.46, nz + r * 0.34); setL(5, L * 0.16, wy - r * 0.30, nz + r * 0.30);
    setL(6, -L * 0.13, wy + r * 0.16, nz + r * 0.34); setL(7, L * 0.16, wy + r * 0.22, nz + r * 0.30);
    hullL(mb, px, py, pz, c, s, F_ALL);
    const sx = L * 0.16, sy = wy - r * 0.04;
    setMat(mb, M.aircraftTrim);
    for (let i = 0; i < 3; i++) {
      const th = hash2(px + nz, pz + i) * TAU + (i / 3) * TAU;
      const bl = span * 0.115;
      setMat(mb, M.propBlade);
      beamL(mb, px, py, pz, c, s,
        sx + 0.10, sy, nz,
        sx + 0.10, sy + Math.cos(th) * bl, nz + Math.sin(th) * bl, 0.055, 0.16, F_ALL);
      beamL(mb, px, py, pz, c, s,
        sx + 0.10, sy, nz,
        sx + 0.10, sy - Math.cos(th) * bl, nz - Math.sin(th) * bl, 0.055, 0.16, F_ALL);
    }
    setMat(mb, M.aircraftGrey);
    setL(0, sx, sy - r * 0.24, nz - r * 0.24); setL(1, sx + L * 0.030, sy - r * 0.05, nz - r * 0.05);
    setL(2, sx, sy + r * 0.24, nz - r * 0.24); setL(3, sx + L * 0.030, sy + r * 0.05, nz - r * 0.05);
    setL(4, sx, sy - r * 0.24, nz + r * 0.24); setL(5, sx + L * 0.030, sy - r * 0.05, nz + r * 0.05);
    setL(6, sx, sy + r * 0.24, nz + r * 0.24); setL(7, sx + L * 0.030, sy + r * 0.05, nz + r * 0.05);
    hullL(mb, px, py, pz, c, s, F_ALL);
  }

  // T-tail: fin off the tail cone, stabiliser across the top of it.
  const finTop = fy + r * 0.55 + L * 0.235;
  setMat(mb, M.aircraftTrim);
  setL(0, -L * 0.30, fy + r * 0.55, -r * 0.14); setL(1, -L * 0.47, fy + r * 0.55, -r * 0.14);
  setL(2, -L * 0.40, finTop, -r * 0.08); setL(3, -L * 0.49, finTop, -r * 0.08);
  setL(4, -L * 0.30, fy + r * 0.55, r * 0.14); setL(5, -L * 0.47, fy + r * 0.55, r * 0.14);
  setL(6, -L * 0.40, finTop, r * 0.08); setL(7, -L * 0.49, finTop, r * 0.08);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.aircraftWhite);
  setL(0, -L * 0.385, finTop, 0); setL(1, -L * 0.495, finTop, 0);
  setL(2, -L * 0.385, finTop + r * 0.16, 0); setL(3, -L * 0.495, finTop + r * 0.16, 0);
  setL(4, -L * 0.405, finTop + r * 0.03, span * 0.145); setL(5, -L * 0.485, finTop + r * 0.03, span * 0.145);
  setL(6, -L * 0.405, finTop + r * 0.15, span * 0.145); setL(7, -L * 0.485, finTop + r * 0.15, span * 0.145);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setL(4, -L * 0.405, finTop + r * 0.03, -span * 0.145); setL(5, -L * 0.485, finTop + r * 0.03, -span * 0.145);
  setL(6, -L * 0.405, finTop + r * 0.15, -span * 0.145); setL(7, -L * 0.485, finTop + r * 0.15, -span * 0.145);
  hullL(mb, px, py, pz, c, s, F_ALL);

  // Undercarriage: nose leg at the origin, main legs in the nacelles.
  setMat(mb, M.chrome);
  mb.cylinder(px + L * 0.40 * c, py + 0.30, pz - L * 0.40 * s, 0.075, 0.075, fy - r - 0.30, 4, a,
    false);
  setMat(mb, M.tyre);
  discZ(mb, px + L * 0.40 * c, py, pz - L * 0.40 * s, c, s, 0, 0, 0.30, 0.30, 6);
  for (let k = 0; k < 2; k++) {
    const nz = (k === 0 ? -1 : 1) * span * 0.175;
    const gx = -L * 0.02;
    setMat(mb, M.chrome);
    beamL(mb, px, py, pz, c, s, gx, wy - r * 0.40, nz, gx, 0.42, nz, 0.075, 0.075, F_ALL);
    setMat(mb, M.tyre);
    for (let w = 0; w < 2; w++) {
      const wz = nz + (w ? 0.30 : -0.30);
      discZ(mb, px + gx * c + wz * s, py, pz - gx * s + wz * c, c, s, 0, 0, 0.42, 0.42, 6);
    }
  }
  if (typeof rng === 'function') rnd(rng);
}

/** Single-engine light aircraft on the general-aviation apron. Nose along local +X. */
export function appendLightPlane(mb, rng, x, y, z, yaw) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const c = Math.cos(a), s = Math.sin(a);
  const fy = 1.02;

  setMat(mb, M.aircraftWhite);
  setL(0, 2.10, fy - 0.52, -0.52); setL(1, -1.30, fy - 0.46, -0.44);
  setL(2, 2.10, fy + 0.52, -0.46); setL(3, -1.30, fy + 0.46, -0.40);
  setL(4, 2.10, fy - 0.52, 0.52); setL(5, -1.30, fy - 0.46, 0.44);
  setL(6, 2.10, fy + 0.52, 0.46); setL(7, -1.30, fy + 0.46, 0.40);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setL(0, -1.30, fy - 0.46, -0.44); setL(1, -4.05, fy - 0.02, -0.13);
  setL(2, -1.30, fy + 0.46, -0.40); setL(3, -4.05, fy + 0.30, -0.13);
  setL(4, -1.30, fy - 0.46, 0.44); setL(5, -4.05, fy - 0.02, 0.13);
  setL(6, -1.30, fy + 0.46, 0.40); setL(7, -4.05, fy + 0.30, 0.13);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.cabinGlass);
  quadPZ(mb, px, py, pz, c, s, 0.525, 0.30, fy + 0.02, 1.70, fy + 0.50);
  quadNZ(mb, px, py, pz, c, s, -0.525, 0.30, fy + 0.02, 1.70, fy + 0.50);
  quadPX(mb, px, py, pz, c, s, 2.11, fy + 0.05, -0.42, fy + 0.50, 0.42);

  // High wing with struts.
  setMat(mb, M.aircraftWhite);
  setL(0, 1.20, fy + 0.52, -5.50); setL(1, 0.10, fy + 0.52, -5.50);
  setL(2, 1.20, fy + 0.68, -5.50); setL(3, 0.10, fy + 0.68, -5.50);
  setL(4, 1.35, fy + 0.52, 5.50); setL(5, 0.05, fy + 0.52, 5.50);
  setL(6, 1.35, fy + 0.68, 5.50); setL(7, 0.05, fy + 0.68, 5.50);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.chrome);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    beamL(mb, px, py, pz, c, s, 0.40, fy - 0.42, sg * 0.42, 0.55, fy + 0.52, sg * 2.60,
      0.035, 0.035, F_ALL);
  }
  // Fin and tailplane.
  setMat(mb, M.aircraftTrim);
  setL(0, -3.10, fy + 0.28, -0.06); setL(1, -4.05, fy + 0.30, -0.06);
  setL(2, -3.60, fy + 1.55, -0.05); setL(3, -4.12, fy + 1.55, -0.05);
  setL(4, -3.10, fy + 0.28, 0.06); setL(5, -4.05, fy + 0.30, 0.06);
  setL(6, -3.60, fy + 1.55, 0.05); setL(7, -4.12, fy + 1.55, 0.05);
  hullL(mb, px, py, pz, c, s, F_ALL);
  setMat(mb, M.aircraftWhite);
  boxL(mb, px, py, pz, c, s, -3.95, fy + 0.24, -1.70, -3.25, fy + 0.32, 1.70, F_ALL);
  // Spinner, prop and gear.
  setMat(mb, M.aircraftTrim);
  mb.cylinder(px + 2.10 * c, py + fy, pz - 2.10 * s, 0.22, 0.06, 0.34, 5, a, false);
  setMat(mb, M.propBlade);
  const th = hash2(px, pz) * TAU;
  for (let i = 0; i < 2; i++) {
    const b = th + i * Math.PI;
    beamL(mb, px, py, pz, c, s, 2.26, fy, 0, 2.26, fy + Math.cos(b) * 0.92,
      Math.sin(b) * 0.92, 0.048, 0.11, F_ALL);
  }
  setMat(mb, M.chrome);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    beamL(mb, px, py, pz, c, s, 0.35, fy - 0.48, 0, 0.35, 0.26, sg * 1.15, 0.045, 0.045, F_ALL);
  }
  setMat(mb, M.tyre);
  for (let k = 0; k < 2; k++) {
    const wz = (k === 0 ? -1 : 1) * 1.15;
    discZ(mb, px + 0.35 * c + wz * s, py, pz - 0.35 * s + wz * c, c, s, 0, 0, 0.26, 0.26, 6);
  }
  discZ(mb, px + 2.02 * c, py, pz - 2.02 * s, c, s, 0, 0, 0.20, 0.20, 5);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * Chain-link perimeter fence along local Z: posts, a top rail, and the mesh as a single thin
 * plate. `len` is the run, `h` the height. Long runs should be tiled rather than stretched.
 */
export function appendChainFence(mb, x, y, z, yaw, len, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 12), 0.5, 120);
  const H = clamp(fin(h, 2.4), 0.6, 5.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.chainLink);
  boxL(mb, px, py, pz, c, s, -0.018, 0.06, -hl, 0.018, H - 0.10, hl, F_PLATEX);
  boxL(mb, px, py, pz, c, s, -0.028, H - 0.10, -hl, 0.028, H - 0.042, hl, F_NOBOT);
  setMat(mb, M.galv);
  const n = Math.max(1, Math.round(L / 3.0));
  for (let i = 0; i <= n; i++) {
    const lz = -hl + L * (i / n);
    mb.cylinder(px + lz * s, py, pz + lz * c, 0.048, 0.044, H, 4, a, false);
  }
  // Three strands of barbed wire on an outward-canted arm, which is what makes it read as an
  // airfield boundary rather than a garden fence.
  for (let i = 0; i < 3; i++) {
    boxL(mb, px, py, pz, c, s, 0.06 + i * 0.085, H - 0.02 + i * 0.085, -hl,
      0.078 + i * 0.085, H + 0.0 + i * 0.085, hl, F_PLATEX);
  }
}

/**
 * The island ferry. Double-ended, an open car deck forward, a passenger house amidships and a
 * wheelhouse at each end — the shape of the Ongiara and the Sam McBride. Origin is the waterline
 * at the hull centre, bow along local +Z.
 */
export function appendIslandFerry(mb, rng, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 45), 14, 90);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5, bw = L * 0.185, draft = L * 0.048, fb = L * 0.075;

  // Hull: a box amidships raked in at both ends, because she is double-ended.
  setMat(mb, M.ferryHull);
  setL(0, -bw * 0.62, -draft, -hl); setL(1, bw * 0.62, -draft, -hl);
  setL(2, -bw * 0.80, fb, -hl); setL(3, bw * 0.80, fb, -hl);
  setL(4, -bw * 0.62, -draft, -hl * 0.62); setL(5, bw * 0.62, -draft, -hl * 0.62);
  setL(6, -bw, fb, -hl * 0.62); setL(7, bw, fb, -hl * 0.62);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setL(0, -bw * 0.62, -draft, -hl * 0.62); setL(1, bw * 0.62, -draft, -hl * 0.62);
  setL(2, -bw, fb, -hl * 0.62); setL(3, bw, fb, -hl * 0.62);
  setL(4, -bw * 0.62, -draft, hl * 0.62); setL(5, bw * 0.62, -draft, hl * 0.62);
  setL(6, -bw, fb, hl * 0.62); setL(7, bw, fb, hl * 0.62);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);
  setL(0, -bw * 0.62, -draft, hl * 0.62); setL(1, bw * 0.62, -draft, hl * 0.62);
  setL(2, -bw, fb, hl * 0.62); setL(3, bw, fb, hl * 0.62);
  setL(4, -bw * 0.62, -draft, hl); setL(5, bw * 0.62, -draft, hl);
  setL(6, -bw * 0.80, fb, hl); setL(7, bw * 0.80, fb, hl);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_PY);

  // Main deck, then the passenger house on it.
  setMat(mb, M.ferryDeck);
  quadUp(mb, px, py, pz, c, s, -bw, -hl, bw, hl, fb);
  const hy = fb + L * 0.072;
  setMat(mb, M.ferryHouse);
  boxL(mb, px, py, pz, c, s, -bw * 0.78, fb, -hl * 0.50, bw * 0.78, hy, hl * 0.30, F_NOBOT);
  setMat(mb, M.cabinGlass);
  quadPX(mb, px, py, pz, c, s, bw * 0.785, fb + L * 0.020, -hl * 0.46, hy - L * 0.014, hl * 0.26);
  quadNX(mb, px, py, pz, c, s, -bw * 0.785, fb + L * 0.020, -hl * 0.46, hy - L * 0.014, hl * 0.26);
  // Upper deck over the house, with a rail round it.
  setMat(mb, M.ferryDeck);
  boxL(mb, px, py, pz, c, s, -bw * 0.82, hy, -hl * 0.54, bw * 0.82, hy + L * 0.006, hl * 0.34,
    F_NOBOT);
  setMat(mb, M.galv);
  for (let k = 0; k < 2; k++) {
    const sx = (k === 0 ? -1 : 1) * bw * 0.80;
    boxL(mb, px, py, pz, c, s, sx - 0.03, hy + L * 0.006, -hl * 0.54,
      sx + 0.03, hy + L * 0.026, hl * 0.34, F_BLADEX);
    boxL(mb, px, py, pz, c, s, sx - 0.03, fb + L * 0.020, -hl, sx + 0.03, fb + L * 0.040, hl,
      F_BLADEX);
  }
  // A wheelhouse at each end and a single funnel.
  setMat(mb, M.ferryHouse);
  for (let k = 0; k < 2; k++) {
    const sg = k === 0 ? -1 : 1;
    const wz = sg * hl * 0.44;
    boxL(mb, px, py, pz, c, s, -bw * 0.34, hy + L * 0.006, wz - L * 0.038,
      bw * 0.34, hy + L * 0.058, wz + L * 0.038, F_NOBOT);
    setMat(mb, M.cabinGlass);
    quadPZ(mb, px, py, pz, c, s, wz + L * 0.0385, -bw * 0.30, hy + L * 0.024,
      bw * 0.30, hy + L * 0.050);
    quadNZ(mb, px, py, pz, c, s, wz - L * 0.0385, -bw * 0.30, hy + L * 0.024,
      bw * 0.30, hy + L * 0.050);
    setMat(mb, M.ferryHouse);
  }
  setMat(mb, M.ferryHull);
  mb.cylinder(px, py + hy + L * 0.006, pz, L * 0.026, L * 0.022, L * 0.075, 6, a, false);
  if (typeof rng === 'function') rnd(rng);
}

/**
 * The Centreville carousel: a raised timber platform, a centre pole, a twelve-sided canopy with
 * a scalloped valance, and a ring of mounts on brass poles. `r` is the platform radius.
 */
export function appendCarousel(mb, rng, x, y, z, r) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const R = clamp(fin(r, 9.0), 2.5, 20.0);
  const a = hash2(px, pz) * TAU;

  setMat(mb, M.granite);
  mb.cylinder(px, py, pz, R + 0.55, R + 0.55, 0.34, 12, a, false);
  discY(mb, px, py + 0.34, pz, R + 0.55, 12, a, true);
  setMat(mb, M.woodSlat);
  mb.cylinder(px, py + 0.34, pz, R, R, 0.22, 12, a, false);
  discY(mb, px, py + 0.56, pz, R, 12, a, true);

  setMat(mb, M.rideGold);
  mb.cylinder(px, py + 0.56, pz, R * 0.085, R * 0.070, R * 0.70, 8, a, false);
  // Canopy: a cone from the hub out to the eaves, with a red valance hanging off the rim.
  setMat(mb, M.rideRed);
  mb.cylinder(px, py + 0.56 + R * 0.52, pz, R * 1.02, R * 0.14, R * 0.30, 12, a, false);
  setMat(mb, M.rideCream);
  mb.cylinder(px, py + 0.56 + R * 0.40, pz, R * 1.05, R * 1.02, R * 0.12, 12, a, false);
  discY(mb, px, py + 0.56 + R * 0.40, pz, R * 1.05, 12, a, false);

  // Mounts: two rings of horses, each a body block on a brass pole.
  for (let ring = 0; ring < 2; ring++) {
    const rr0 = R * (ring === 0 ? 0.52 : 0.82);
    const n = ring === 0 ? 8 : 12;
    for (let i = 0; i < n; i++) {
      const th = a + (i / n) * TAU + (ring ? 0.26 : 0);
      const cx = px + Math.cos(th) * rr0, cz = pz + Math.sin(th) * rr0;
      const bob = 0.20 + 0.34 * hash2(cx, cz);
      setMat(mb, M.rideGold);
      mb.cylinder(cx, py + 0.56, cz, 0.038, 0.038, R * 0.40, 4, th, false);
      const c2 = Math.cos(th), s2 = Math.sin(th);
      setMat(mb, rnd(rng) < 0.5 ? M.rideCream : M.rideRed);
      boxL(mb, cx, py + 0.56 + bob, cz, c2, s2, -0.62, 0.42, -0.20, 0.62, 0.96, 0.20, F_NOBOT);
      boxL(mb, cx, py + 0.56 + bob, cz, c2, s2, 0.36, 0.86, -0.14, 0.74, 1.38, 0.14, F_NOBOT);
    }
  }
}

/**
 * Generic fairground ride structure, for the Centreville attractions the extract names but does
 * not describe: a fenced pad, a machinery house, and a frame whose shape follows `kind`
 * (0 flat ride, 1 track ride, 2 water ride).
 */
export function appendRidePad(mb, rng, x, y, z, yaw, w, d, kind) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 10), 2, 70);
  const D = clamp(fin(d, 10), 2, 70);
  const k = (fin(kind, 0) | 0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5, hd = D * 0.5;

  setMat(mb, M.concrete);
  boxL(mb, px, py, pz, c, s, -hw, 0, -hd, hw, 0.12, hd, F_NOBOT);
  // Perimeter rail.
  setMat(mb, M.railGreen);
  for (let side = 0; side < 4; side++) {
    const along = side < 2 ? hw : hd;
    const off = side < 2 ? hd : hw;
    const sg = (side & 1) ? 1 : -1;
    for (let i = 0; i < 2; i++) {
      const yy = 0.42 + i * 0.46;
      if (side < 2) {
        boxL(mb, px, py, pz, c, s, -along, yy, sg * off - 0.03, along, yy + 0.06, sg * off + 0.03,
          F_NOBOT);
      } else {
        boxL(mb, px, py, pz, c, s, sg * off - 0.03, yy, -along, sg * off + 0.03, yy + 0.06, along,
          F_NOBOT);
      }
    }
  }
  // Machinery / ticket house in one corner.
  setMat(mb, M.rideCream);
  boxL(mb, px, py, pz, c, s, hw - Math.min(3.4, W * 0.34), 0.12, hd - Math.min(2.8, D * 0.30),
    hw - 0.35, 2.85, hd - 0.35, F_NOBOT);
  setMat(mb, M.rideRed);
  boxL(mb, px, py, pz, c, s, hw - Math.min(3.6, W * 0.36), 2.85, hd - Math.min(3.0, D * 0.32),
    hw - 0.20, 3.10, hd - 0.20, F_NOBOT);

  if (k === 1) {
    // Track ride: a raised loop on trestles, cut into eight chords round the pad.
    setMat(mb, M.galv);
    const rx = hw * 0.72, rz = hd * 0.72;
    for (let i = 0; i < 8; i++) {
      const t0 = (i / 8) * TAU, t1 = ((i + 1) / 8) * TAU;
      const y0 = 1.20 + 1.35 * (0.5 + 0.5 * Math.sin(t0 * 2));
      const y1 = 1.20 + 1.35 * (0.5 + 0.5 * Math.sin(t1 * 2));
      beamL(mb, px, py, pz, c, s, Math.cos(t0) * rx, y0, Math.sin(t0) * rz,
        Math.cos(t1) * rx, y1, Math.sin(t1) * rz, 0.42, 0.09, F_ALL);
      beamL(mb, px, py, pz, c, s, Math.cos(t0) * rx, 0.12, Math.sin(t0) * rz,
        Math.cos(t0) * rx, y0, Math.sin(t0) * rz, 0.09, 0.09, F_ALL);
    }
  } else if (k === 2) {
    // Water ride: a flume trough on piers, running the length of the pad and back.
    setMat(mb, M.rideCream);
    for (let lane = 0; lane < 2; lane++) {
      const lz = (lane === 0 ? -1 : 1) * hd * 0.45;
      beamL(mb, px, py, pz, c, s, -hw * 0.86, 1.35 + lane * 1.6, lz,
        hw * 0.86, 1.35 + (1 - lane) * 1.6, lz, 0.85, 0.20, F_ALL);
      setMat(mb, M.galv);
      for (let i = 0; i < 4; i++) {
        const lx = -hw * 0.80 + hw * 1.60 * (i / 3);
        beamL(mb, px, py, pz, c, s, lx, 0.12, lz, lx, 1.35 + 1.6 * (lane ? i / 3 : 1 - i / 3), lz,
          0.11, 0.11, F_ALL);
      }
      setMat(mb, M.rideCream);
    }
  } else {
    // Flat ride: a central hub and a canopy of swept arms.
    setMat(mb, M.rideGold);
    const hr = Math.min(hw, hd) * 0.80;
    mb.cylinder(px, py + 0.12, pz, hr * 0.20, hr * 0.14, 3.30, 8, a, false);
    setMat(mb, M.rideRed);
    for (let i = 0; i < 6; i++) {
      const th = a + (i / 6) * TAU;
      beamL(mb, px, py, pz, c, s, 0, 3.10, 0,
        Math.cos(th - a) * hr, 2.35, Math.sin(th - a) * hr, 0.16, 0.10, F_ALL);
    }
  }
  if (typeof rng === 'function') rnd(rng);
}

/** Timber handrail along a boardwalk. Runs along local Z; posts every ~2 m. */
export function appendTimberRail(mb, x, y, z, yaw, len) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const L = clamp(fin(len, 8), 0.6, 80);
  const c = Math.cos(a), s = Math.sin(a);
  const hl = L * 0.5;

  setMat(mb, M.boardRail);
  boxL(mb, px, py, pz, c, s, -0.045, 0.94, -hl, 0.045, 1.02, hl, F_NOBOT);
  boxL(mb, px, py, pz, c, s, -0.035, 0.50, -hl, 0.035, 0.56, hl, F_NOBOT);
  const n = Math.max(1, Math.round(L / 2.0));
  for (let i = 0; i <= n; i++) {
    const lz = -hl + L * (i / n);
    boxL(mb, px, py, pz, c, s, -0.055, 0.0, lz - 0.055, 0.055, 0.94, lz + 0.055, F_NOBOT);
  }
}

/**
 * Gable roof for an island cottage. The massing extract has no roof pitch, and the Ward's and
 * Algonquin houses are all pitched; without this every one of them is a flat-topped box.
 * `w` runs along local X, `d` along local Z, and the ridge runs along local Z.
 */
export function appendGableRoof(mb, rng, x, y, z, yaw, w, d, h) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 7), 1.5, 26);
  const D = clamp(fin(d, 9), 1.5, 34);
  const H = clamp(fin(h, 2.2), 0.5, 7.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5 + 0.32, hd = D * 0.5 + 0.32;

  setMat(mb, M.shingle);
  // Two pitches meeting at a ridge over local x = 0.
  quadL(mb, px, py, pz, c, s, -hw, 0, hd, 0, H, hd, 0, H, -hd, -hw, 0, -hd);
  quadL(mb, px, py, pz, c, s, 0, H, hd, hw, 0, hd, hw, 0, -hd, 0, H, -hd);
  // Gable ends, and a fascia band so the eaves are not a paper edge.
  triL(mb, px, py, pz, c, s, -hw, 0, hd, hw, 0, hd, 0, H, hd);
  triL(mb, px, py, pz, c, s, hw, 0, -hd, -hw, 0, -hd, 0, H, -hd);
  setMat(mb, M.chalk);
  boxL(mb, px, py, pz, c, s, -hw, -0.22, -hd, hw, 0.0, hd, F_SIDES);
  if (typeof rng === 'function') rnd(rng);
}

/** Concrete boat slipway running down into the water. Local +X is down the slope. */
export function appendSlipway(mb, x, y, z, yaw, w, len, drop) {
  const px = fin(x, 0), py = fin(y, 0), pz = fin(z, 0);
  const a = finAngle(yaw, 0);
  const W = clamp(fin(w, 6), 1.5, 30);
  const L = clamp(fin(len, 12), 2, 60);
  const dr = clamp(fin(drop, 1.6), 0.2, 6.0);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = W * 0.5;

  setMat(mb, M.concrete);
  setL(0, 0, -0.35, -hw); setL(1, L, -0.35 - dr, -hw);
  setL(2, 0, 0.0, -hw); setL(3, L, -dr, -hw);
  setL(4, 0, -0.35, hw); setL(5, L, -0.35 - dr, hw);
  setL(6, 0, 0.0, hw); setL(7, L, -dr, hw);
  hullL(mb, px, py, pz, c, s, F_ALL & ~F_NX);
  setMat(mb, M.granite);
  for (let k = 0; k < 2; k++) {
    const sz = (k === 0 ? -1 : 1) * hw;
    setL(0, 0, 0.0, sz - 0.14); setL(1, L, -dr, sz - 0.14);
    setL(2, 0, 0.22, sz - 0.14); setL(3, L, 0.22 - dr, sz - 0.14);
    setL(4, 0, 0.0, sz + 0.14); setL(5, L, -dr, sz + 0.14);
    setL(6, 0, 0.22, sz + 0.14); setL(7, L, 0.22 - dr, sz + 0.14);
    hullL(mb, px, py, pz, c, s, F_NOBOT);
  }
}
