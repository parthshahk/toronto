// src/city.js — turns data/toronto.json into renderable geometry, terrain sampling and collision.
//
// CONTRACT.md §1 / §3.1. Zero dependencies. World axes: X = east, Y = up, Z = south, true metres.
//
// Plan space
// ----------
// Every polygon routine below works in a "plan space" (u, v) = (x, -z): u is east, v is NORTH.
// That is the ordinary maths convention (y up on paper), so "counter-clockwise = positive signed
// area" holds without any mental gymnastics, and a plan-CCW polygon emitted as 3D triangles with
// x = u, z = -v comes out with a +Y normal — which is what the roof caps and every ground ribbon
// need, because the renderer culls back faces.
//
// Ring winding
// ------------
// ESRI winds outer rings clockwise and holes counter-clockwise; the build step negated north into
// +Z, which mirrors the plane and flips that. Nothing here assumes either: each ring's signed area
// is measured, the largest |area| ring of a record is the outer boundary, rings that share its sign
// are separate parts (islands) and rings of the opposite sign are holes. Orientation is then forced
// (outer CCW, holes CW) before anything is emitted.
//
// Vertex format is gl.js's 13 floats; MeshBuilder.color(r,g,b, emissive, tintable, rough, profile).
// `tintable` is deliberately 0 on all static city geometry — the uTint path is for dynamic
// meshes, and a tinted city is a bug, not a feature.
//
// Lighting profile (the 7th channel)
// ----------------------------------
// `profile` tells the renderer HOW a surface lights up after dark; it is not a colour and not a
// brightness. 0 envelope · 1 office · 2 residential · 3 retail · 4 parking · 5 civic. It comes
// from `building.t` in the data, which is derived from the OSM building/amenity tags. Profile 0
// means the surface has NO windows at all — stadium shells, the CN Tower, and every roof cap —
// and city.js guarantees that no profile-0 surface carries facade-hint emissive, so the shader
// can never paint an office grid onto the Rogers Centre dome.

import { Mesh, MeshBuilder } from './gl.js';
import { clamp, lerp, smoothstep, makeRng, TAU } from './math.js';
import {
  appendCobraLamp, appendAcornLamp, appendPedestrianLamp, appendCatenaryPole,
  appendTrafficSignal, appendSignPost, appendBench, appendLitterBin, appendBikeRing,
  appendBollard, appendPlanter, appendHydrant, appendMailbox, appendNewsBox,
  appendParkingMachine, appendTransitShelter, appendPlatformShelter, appendStreetTree,
  appendParkTree, appendShrub, appendManhole, appendGrate, appendUtilityBox, appendTowerSign,
  appendConstructionCrane, appendRooftopUnit, appendElevatorPenthouse, appendCoolingTower,
  appendRoofAntenna, appendWindowRig, appendSatelliteDish, appendParkedCar, appendBoat,
  appendFerryDock, appendRailCar, appendPatioSet, appendSandwichBoard, appendDumpster,
  appendACondenser, appendFlagPole, appendScaffold,
  appendPedestrian, appendPedestrianGroup, appendCyclist, appendDogWalker,
} from './props.js';
import {
  appendGroundFloor, appendBalconyBand, appendCornice, appendStringCourse, appendFireEscape,
  appendLoadingDock, appendParapet, facadeAudit, resetFacadeAudit,
} from './facades.js';
// HARBOURFRONT (CONTRACT §8.3). The surveyed shoreline, the quay wall and everything on the
// water live in their own module; city.js only calls into it, at the four points marked
// "harbourfront" below.
import {
  buildHarbour, carveHarbourTerrain, harbourTileHasWater, harbourWaterAt, appendHarbour,
  harbourStats,
  // THE ISLANDS AND THE AIRPORT. Everything south of the harbour lives in harbour.js too; the
  // section below only indexes it into tiles and hands it the placement context.
  islandBounds, appendIslandMass, appendIslandDetail, islandStats, harbourCarFree,
  islandBuildingHeight,
} from './harbour.js';
// SPATIAL TILING. The city is no longer one merged mesh per material class: it is one merged mesh
// per material class PER TILE, built on demand and thrown away when it goes out of range. See
// tiles.js for why, and for the level-of-detail stages.
import { TILE_SIZE, makeTileGrid, splitRuns, TileManager } from './tiles.js';

/* =============================================================== tunables == */

const EPS = 1e-9;
const MIN_RING_AREA = 4.0;         // m^2 — smaller footprints are noise in the massing data
const MIN_HOLE_AREA = 1.5;
const PLAZA_MIN_AREA = 90.0;       // a closed pedestrian way this big is a square, not a loop path
const WALL_SINK = 1.5;             // start walls below the recorded base so no gap opens on slopes
const ROAD_MAX_SEG = 18.0;         // resample polylines so ribbons follow the terrain
const ROAD_Y = 0.06;               // asphalt sits just proud of the terrain
const CROWN = 0.07;                // centre-line crown on carriageways
const CURB = 0.16;

// GROUND-PLANE LADDER. Everything laid flat on the terrain gets its own rung, because two of these
// surfaces overlapping at the same height is a z-fight the depth buffer resolves differently every
// frame. The rungs are far enough apart to survive the drape error — a big ear-clipped cap
// interpolates linearly across ground that curves under it, measured at about 1 cm — and close
// enough together that no rung reads as a step. Ordered: bare terrain < grass < park < carriageway
// edge < parking apron < loose walkway < kerbed walkway.
//
// The rung SIZE is not a taste decision. A 24-bit integer depth buffer resolves about z^2 / (near
// * 2^24) metres, so at 300 m a 1 cm rung is already inside the noise and two ground covers laid
// a centimetre apart shimmer against each other across the whole middle distance. GROUND_RUNG is
// the smallest step that survives out to roughly a kilometre, and DUP_STAGGER — which separates
// the duplicate and nested polygons of the SAME kind that the extract carries — is kept to a
// fraction of it so the stagger can never eat a rung.
const GROUND_RUNG = 0.038;
const DUP_STAGGER = 0.003;         // +/- this, i.e. never more than 2 * DUP_STAGGER between twins
const GRASS_Y = 0.022;             // landuse=grass, the loser wherever it overlaps a park
const PARK_Y = 0.098;              // leisure=park
const LOT_Y = 0.136;               // surface parking apron
const PATH_Y = 0.174;              // OSM footway with no kerb: park and plaza paths
const PIER_Y = 0.350;
const WATER_Y = 0.0;               // lake datum (meta.lake_msl above sea level)
const LAND_FLOOR = 0.30;           // land never dips to the water plane
const TIE_SPACING = 3.0;

// Coplanar-geometry resolution (Amendment 8 work: the daytime flicker).
//
// Two surfaces at the same plane and the same facing are a z-fight no depth buffer resolves; the
// massing extract is full of them because a real building is often several stacked slabs, each
// carrying its own complete ring, and where two of those rings share an edge both records extrude
// the same wall. WALL_TOL is how far apart two walls may be and still count as the same surface,
// WALL_MIN_OVERLAP the shortest shared run worth resolving, and CAP_COPLANAR_TOL the height
// difference under which two roof caps are the same plane.
const WALL_TOL = 0.06;
const WALL_MIN_OVERLAP = 0.25;
const CAP_PLANE_TOL = 0.030;       // two roof caps closer than this in Y are the same plane
const CAP_MIN_SEP = 0.020;         // ...and this is the separation the audit demands afterwards
const CAP_STEP = 0.060;            // how far a losing roof cap steps down out of a shared plane.
                                   // Comfortably more than CAP_PLANE_TOL, so one step always
                                   // clears the band that put the two caps in the same group
const CAP_MAX_STEP = 4;            // deepest a chain may go, so one pathological cluster cannot
                                   // sink a roof half a metre below its own wall head
const WALL_MIN_BAND = 0.05;        // a surviving strip of wall shorter than this is not worth a quad

/* ------------------------------------------------- street-detail tunables -- */
// Spacings are metres along the KERB, per side unless the comment says otherwise. Everything
// here is a density dial: CONTRACT §6.4 says a tight budget costs spacing, never quality.

const SEED = 0x70720170;           // one seed for the whole detail pass

const MARK_LIFT = 0.034;           // paint above the asphalt — enough to never z-fight, invisible
const GUTTER_LIFT = 0.016;         // manhole and catch-basin castings: proud of the asphalt, under
                                   // the paint, and far enough off it that the two never fight
const LANE_W = 3.35;               // Toronto lane width, used to space lane lines
const DASH_ON = 3.0;
const DASH_OFF = 6.0;
const STOP_BAR_W = 0.50;
const ZEBRA_BAR = 0.60;
const ZEBRA_GAP = 1.25;
const XWALK_DEPTH = 3.1;           // along the roadway, i.e. how deep the crossing is
const XWALK_SETBACK = 1.1;         // from the junction disc to the near edge of the crossing

const RAMP_W = 1.85;               // kerb ramp, flare included
const RAMP_RUN = 1.55;

const TRAM_GAUGE = 1.495;          // Toronto gauge — 4 ft 10 7/8 in, unique in the world
const TRAM_RAIL_W = 0.078;
const TRACK_SLAB_HW = 1.72;        // half width of the slab under a reserved right of way
const TRACK_SLAB_Y = 0.030;        // ...and how far it stands above the road datum, so a slab that
                                   // clips a carriageway edge is a step, not a coplanar fight
const RAIL_PROUD = 0.050;          // rail head above whatever it is set into. Above MARK_LIFT on
                                   // purpose: real embedded rail is proud of the paint it crosses
const TRAM_POLE_SPACING = 46.0;
const TRAM_POLE_H = 8.4;
const CATENARY_REACH = 1.86;       // documented appendCatenaryPole wire attachment, see its header
const CATENARY_DROP = 0.85;
const WIRE_R = 0.026;
const WIRE_SAG = 0.16;

const LAMP_SPACING = { motorway: 55, major: 28, minor: 40 };
const ACORN_SPACING = 55;
const TREE_SPACING = 54;
const BIN_SPACING = 260;
const BENCH_SPACING = 430;
const RING_SPACING = 280;
const HYDRANT_SPACING = 210;
const PLANTER_SPACING = 390;
const METER_SPACING = 340;
const NEWSBOX_SPACING = 380;
const MAILBOX_SPACING = 520;
const CABINET_SPACING = 330;
const MANHOLE_SPACING = 280;
const GRATE_SPACING = 420;
const CAR_SPACING = 6.6;           // kerb-lane parking pitch, car plus gap
const CAR_FILL = 0.070;             // fraction of kerb-lane slots that hold a car
const STALL_W = 2.65;              // parking-lot stall
const STALL_L = 5.30;
const LOT_FILL = 0.55;

// Heritage lighting districts, local metres (X east, Z south): St Lawrence / Old Town, the
// Distillery approach, and the Front St / Union frontage.
const ACORN_ZONES = [
  [1180, -430, 470],
  [1490, -250, 300],
  [180, -220, 330],
];

// Streets that actually carry painted bike lanes downtown.
const BIKE_STREETS = ['Richmond', 'Adelaide', 'Bay', 'Simcoe', 'Sherbourne', 'Wellesley', 'Peter'];

// Bands per facade. The step is floor-to-floor until a tower is tall enough to need more than
// this many, after which it opens up — a band every second storey still reads as a banded tower,
// where a band every fourth storey reads as fins. Paid for out of furniture spacing, per §6.4.
const BALCONY_MAX = 24;
const MAX_LOT_CARS = 620;         // across every surface lot in the extract
const MAX_LOT_CARS_EACH = 34;
// ...and per TILE, which is what actually bounds a frame now: the old city-wide number was a
// vertex budget in disguise, and a vertex budget is what tiles.js enforces.
const MAX_LOT_CARS_TILE = 90;
const MAX_CRANES = 7;
const MAX_TOWER_SIGNS = 8;
const PARK_TREE_SPACING = 17;
const MAX_PARK_TREES = 220;
const MAX_BOATS = 34;

// Ground-cover / infrastructure distance beyond which a terrain cell is open water. This is the
// FALLBACK shoreline, for an extract with no surveyed one: the harbour is recovered from the fact
// that land downtown is densely covered by roads, paths, piers and footprints and the lake is not,
// which lands within about +/-25 m. Where data.shore exists — it does for Toronto — harbour.js
// carves the water from the real geometry instead and this whole path is skipped (CONTRACT §8.3).
const WATER_NEAR = 88.0;
const WATER_FAR = 148.0;
const WATER_MIN_Z = 300.0;
const WATER_DEPTH = -2.2;

const ROAD_CLASS_OK = { motorway: 1, major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };
const BRIDGE_RISE = { motorway: 8.2, major: 5.6, minor: 5.0, service: 4.2, pedestrian: 5.4, foot: 5.4 };
const SIDEWALK_W = { major: 3.8, minor: 2.8, pedestrian: 0 };

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

// Landmarks, matched by real lon/lat AND by known height — the financial district is dense enough
// that proximity alone paints the wrong tower. `tol` is the fractional height window.
//
// These are now a FALLBACK, not the authority: `building:colour` from OSM covers 730 buildings
// including every one of these, and where it exists it wins (it agrees with the hand values and
// reaches far more of the city). What the table still contributes is the material CLASS — the
// surveyed colour tags carry no `building:material` for Scotia Plaza or the TD towers, and red
// granite versus red glass is the difference between a specular tower and a matte one.
const LANDMARKS = [
  { key: 'td', lon: -79.3814, lat: 43.6475, h: 223, radius: 140, tol: 0.09, minH: 60,
    cls: 'steel', srgb: 0x131313, name: 'TD Centre' },
  { key: 'rbp', lon: -79.3803, lat: 43.6461, h: 180, radius: 100, tol: 0.09, minH: 95,
    cls: 'glass', srgb: 0xffd600, name: 'Royal Bank Plaza' },
  { key: 'rbp2', lon: -79.3803, lat: 43.6461, h: 113, radius: 100, tol: 0.09, minH: 90,
    cls: 'glass', srgb: 0xffd600, name: 'Royal Bank Plaza' },
  { key: 'fcp', lon: -79.3817, lat: 43.6487, h: 292, radius: 90, tol: 0.09, minH: 150,
    cls: 'marble', srgb: 0xf4f2ec, name: 'First Canadian Place' },
  { key: 'scotia', lon: -79.3794, lat: 43.6486, h: 275, radius: 160, tol: 0.09, minH: 150,
    cls: 'granite', srgb: 0x5a1410, name: 'Scotia Plaza' },
  { key: 'ccw', lon: -79.3794, lat: 43.6475, h: 239, radius: 130, tol: 0.06, minH: 150,
    cls: 'metal', srgb: 0xc9c3ba, name: 'Commerce Court West' },
  { key: 'cn', lon: -79.3871, lat: 43.6426, h: 443, radius: 120, tol: 0.10, minH: 200,
    cls: 'concrete', srgb: 0x9ea1a6, name: 'CN Tower' },
];

const LANDMARK_INHERIT_R = 48.0;   // stacked massing slabs of the same tower
const LANDMARK_INHERIT_H = 0.75;

/* ================================================================ helpers == */

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// Yield to the browser. A bare requestAnimationFrame NEVER fires in a background tab, which would
// hang the load forever, so race it against a timer and take whichever wins.
// Counted, because in a real visible tab each of these costs a few milliseconds of wall clock
// that no profiler inside the load will attribute to anything. loadCity reports the number.
let _yields = 0;

function frame() {
  _yields++;
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fin);
    setTimeout(fin, 8);
  });
}

// Milliseconds of work between yields. A yield is not free — in a visible tab it costs most of a
// frame, and the old fixed chunk sizes spent 220 of them on a build whose real work was three
// seconds, so a third of the load was the loading screen waiting for itself. This yields on a
// CLOCK instead: the progress bar still updates about forty times a second, which is as often as
// anyone can see, and the count drops by an order of magnitude.
const CHUNK_MS = 12;

async function chunked(n, size, fn, onFrac) {
  let last = now();
  for (let i = 0; i < n; i += size) {
    const end = Math.min(n, i + size);
    for (let k = i; k < end; k++) fn(k);
    if (onFrac) onFrac(end / Math.max(1, n));
    if (end < n && now() - last > CHUNK_MS) {
      await frame();
      last = now();
    }
  }
}

// Deterministic 32-bit position hash -> [0,1).
function hash2(x, z, salt = 0) {
  let h = Math.imul(Math.round(x * 4) | 0, 374761393) ^ Math.imul(Math.round(z * 4) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 2654435761);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }

// Web Mercator with the build step's cos(lat0) scale divided out -> local metres (X east, Z south).
function makeProjector(origin) {
  const R = 6378137.0;
  const d2r = Math.PI / 180;
  const lat0 = origin && isNum(origin.lat) ? origin.lat : 43.644;
  const lon0 = origin && isNum(origin.lon) ? origin.lon : -79.3885;
  const k = Math.cos(lat0 * d2r);
  const mx0 = R * lon0 * d2r;
  const my0 = R * Math.log(Math.tan(Math.PI / 4 + (lat0 * d2r) / 2));
  return (lon, lat) => {
    const mx = R * lon * d2r;
    const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * d2r) / 2));
    return [(mx - mx0) * k, -(my - my0) * k];
  };
}

/* =================================================== ear-clipping polygons == */
// Ear clipping with hole bridging. Input is a flat plan-space coordinate array [u0,v0,u1,v1,...]
// with the outer ring first (CCW) and holes after (CW), described by `holeStarts` (vertex indices).
// Sign convention below matches the classic formulation: turn(p,q,r) < 0 for a CCW turn.

let _ops = 0;
const OP_LIMIT = 600000;

class PNode {
  constructor(i, x, y) {
    this.i = i; this.x = x; this.y = y;
    this.prev = null; this.next = null; this.steiner = false;
  }
}

function nodeInsert(i, x, y, last) {
  const p = new PNode(i, x, y);
  if (!last) { p.prev = p; p.next = p; } else {
    p.next = last.next; p.prev = last; last.next.prev = p; last.next = p;
  }
  return p;
}

function nodeRemove(p) { p.next.prev = p.prev; p.prev.next = p.next; }

function turn(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }

function nodeEq(a, b) { return a.x === b.x && a.y === b.y; }

// Signed area x2 of co[start..end) — positive = counter-clockwise in plan space.
function shoelace(co, start, end) {
  let s = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) s += co[j] * co[i + 1] - co[i] * co[j + 1];
  return s;
}

function ringToList(co, start, end, wantCCW) {
  let last = null;
  const ccw = shoelace(co, start, end) > 0;
  if (ccw === wantCCW) {
    for (let i = start; i < end; i += 2) last = nodeInsert(i, co[i], co[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = nodeInsert(i, co[i], co[i + 1], last);
  }
  if (last && nodeEq(last, last.next)) { nodeRemove(last); last = last.next; }
  return last;
}

// A vertex this far off the straight line between its neighbours contributes nothing but a
// zero-area ear. An exact `turn() === 0` test misses almost all of them: the massing data is
// stored to the centimetre in coordinates of order 1e3, so three genuinely collinear vertices
// come out of the cross product at 1e-14 rather than at 0, survive the filter, and reach the cap
// as a triangle with no derivable normal. One millimetre of deviation is two orders of magnitude
// below the data's own precision, so nothing real is ever removed.
const COLLINEAR_DEV = 0.001;

// Perpendicular distance x |prev->next| of `q` from the line through its neighbours. |turn| IS
// that product, because cross(q - p, r - q) === cross(q - p, r - p).
function collinearDrop(p) {
  const rx = p.next.x - p.prev.x, ry = p.next.y - p.prev.y;
  const rl = Math.sqrt(rx * rx + ry * ry);
  const t = turn(p.prev, p, p.next);
  return rl > EPS ? Math.abs(t) <= COLLINEAR_DEV * rl : t === 0;
}

// Drop collinear and duplicate vertices.
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    if (++_ops > OP_LIMIT) return p;
    again = false;
    if (!p.steiner && (nodeEq(p, p.next) || collinearDrop(p))) {
      nodeRemove(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}

function pointInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  // Reflex corner — or an ear so thin the cap would drop it anyway. Clipping it would consume a
  // real vertex to produce a triangle with no derivable normal; refusing it lets the clipper find
  // a neighbouring ear that carries area, and the pass ladder collapses whatever is left.
  if (turn(a, b, c) >= -CAP_MIN_AREA) return false;
  let p = c.next;
  while (p !== a) {
    if (++_ops > OP_LIMIT) return false;
    if (pointInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && turn(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function onSegment(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function sgn(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

function segIntersects(p1, q1, p2, q2) {
  const o1 = sgn(turn(p1, q1, p2));
  const o2 = sgn(turn(p1, q1, q2));
  const o3 = sgn(turn(p2, q2, p1));
  const o4 = sgn(turn(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (++_ops > OP_LIMIT) return true;
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
      segIntersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a, b) {
  return turn(a.prev, a, a.next) < 0
    ? turn(a, b, a.next) >= 0 && turn(a, a.prev, b) >= 0
    : turn(a, b, a.prev) < 0 || turn(a, a.next, b) < 0;
}

function middleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (++_ops > OP_LIMIT) return inside;
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
      (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (turn(a.prev, a, b.prev) !== 0 || turn(a, b.prev, b) !== 0)) ||
      (nodeEq(a, b) && turn(a.prev, a, a.next) < 0 && turn(b.prev, b, b.next) < 0));
}

// Split the ring at the diagonal a-b, returning the node that starts the second ring.
function splitPolygon(a, b) {
  const a2 = new PNode(a.i, a.x, a.y);
  const b2 = new PNode(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function leftmost(list) {
  let p = list, best = list;
  do {
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) best = p;
    p = p.next;
  } while (p !== list);
  return best;
}

// Eberly's mutually-visible-vertex search: shoot +u from the hole's leftmost point, take the
// nearest hit edge, then refine against reflex vertices inside the (hole, hit, candidate) triangle.
function findHoleBridge(hole, outer) {
  let p = outer, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {
    if (++_ops > OP_LIMIT) break;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;

  const stop = m;
  const mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (++_ops > OP_LIMIT) break;
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin &&
        (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p; tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m, p) {
  return turn(m.prev, m, p.prev) < 0 && turn(p.next, m, m.next) < 0;
}

function eliminateHole(hole, outer) {
  const bridge = findHoleBridge(hole, outer);
  if (!bridge) return outer;
  const b2 = splitPolygon(bridge, hole);
  filterPoints(b2, b2.next);
  return filterPoints(bridge, bridge.next);
}

function eliminateHoles(co, holeStarts, outer) {
  const queue = [];
  for (let i = 0; i < holeStarts.length; i++) {
    const s = holeStarts[i] * 2;
    const e = i < holeStarts.length - 1 ? holeStarts[i + 1] * 2 : co.length;
    const list = ringToList(co, s, e, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(leftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  let out = outer;
  for (let i = 0; i < queue.length; i++) out = eliminateHole(queue[i], out);
  return out;
}

function cureLocalIntersections(start, tris) {
  let p = start;
  do {
    if (++_ops > OP_LIMIT) break;
    const a = p.prev, b = p.next.next;
    if (!nodeEq(a, b) && segIntersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      // The cure removes two vertices whatever happens; the triangle it hands back in exchange is
      // only worth keeping if it has area. On a self-intersecting ring it very often does not.
      if (Math.abs(turn(a, p, b)) > EPS) tris.push(a.i >> 1, p.i >> 1, b.i >> 1);
      nodeRemove(p); nodeRemove(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start, tris, depth) {
  if (depth > 6 || !start) return;
  let a = start;
  do {
    if (++_ops > OP_LIMIT) return;
    let b = a.next.next;
    while (b !== a.prev) {
      if (++_ops > OP_LIMIT) return;
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        const a2 = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a2, tris, 0, depth + 1);
        earcutLinked(c, tris, 0, depth + 1);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function earcutLinked(ear, tris, pass, depth) {
  if (!ear) return;
  let stop = ear;
  while (ear.prev !== ear.next) {
    if (++_ops > OP_LIMIT) return;
    const prev = ear.prev, next = ear.next;
    if (isEar(ear)) {
      tris.push(prev.i >> 1, ear.i >> 1, next.i >> 1);
      nodeRemove(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), tris, 1, depth);
      else if (pass === 1) {
        const cured = cureLocalIntersections(filterPoints(ear), tris);
        earcutLinked(cured, tris, 2, depth);
      } else if (pass === 2) splitEarcut(ear, tris, depth);
      return;
    }
  }
}

/**
 * Triangulate a plan-space polygon. `co` is [u0,v0,...]; `holeStarts` lists the vertex index each
 * hole begins at. Returns a flat array of vertex-index triples, wound counter-clockwise.
 * Never loops forever: every traversal burns from a shared operation budget.
 */
function triangulate(co, holeStarts) {
  _ops = 0;
  const tris = [];
  const outerEnd = (holeStarts && holeStarts.length) ? holeStarts[0] * 2 : co.length;
  if (outerEnd < 6) return tris;
  let outer = filterPoints(ringToList(co, 0, outerEnd, true));
  if (!outer || outer.next === outer.prev) return tris;
  if (holeStarts && holeStarts.length) outer = filterPoints(eliminateHoles(co, holeStarts, outer));
  earcutLinked(outer, tris, 0, 0);
  return tris;
}

/* ============================================================ ring prep ==== */

// One polygon part: an outer ring (plan CCW) plus its holes (plan CW), plus the flat coordinate
// array and hole offsets that `triangulate` wants.
function makePart(outerRing, holeRings) {
  const co = [];
  for (let i = 0; i < outerRing.length; i += 2) { co.push(outerRing[i], outerRing[i + 1]); }
  const holeStarts = [];
  for (let h = 0; h < holeRings.length; h++) {
    holeStarts.push(co.length >> 1);
    const r = holeRings[h];
    for (let i = 0; i < r.length; i += 2) co.push(r[i], r[i + 1]);
  }
  return { co, holeStarts, outer: outerRing, holes: holeRings, bbox: planBBox(outerRing) };
}

// Raw [[x,z],...] ring -> flat plan-space [u,v,...] with the closing duplicate and any repeated
// vertices removed. Vertices closer together than WELD are merged: the massing data stores 1 cm
// precision and sub-centimetre edges are digitising noise that turns into needle-thin spikes whose
// walls have no meaningful inside. Returns null when fewer than three distinct points survive.
const WELD = 0.02;
function toPlan(ring) {
  const n = ring.length;
  if (!n) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
    const u = p[0], v = -p[1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - u) < WELD && Math.abs(out[m - 1] - v) < WELD) continue;
    out.push(u, v);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < WELD &&
    Math.abs(out[1] - out[out.length - 1]) < WELD) out.length -= 2;
  return out.length >= 6 ? out : null;
}

function planArea(co) { return shoelace(co, 0, co.length) * 0.5; }

function reverseRing(co) {
  const out = new Array(co.length);
  for (let i = 0, j = co.length - 2; i < co.length; i += 2, j -= 2) {
    out[i] = co[j]; out[i + 1] = co[j + 1];
  }
  return out;
}

function planBBox(co) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < co.length; i += 2) {
    if (co[i] < x0) x0 = co[i];
    if (co[i] > x1) x1 = co[i];
    if (co[i + 1] < y0) y0 = co[i + 1];
    if (co[i + 1] > y1) y1 = co[i + 1];
  }
  return [x0, y0, x1, y1];
}

function planContains(co, px, py) {
  let inside = false;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const xi = co[i], yi = co[i + 1], xj = co[j], yj = co[j + 1];
    if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi + (yj === yi ? EPS : 0)) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Split a record's rings into parts. The largest |area| ring is the outer boundary; rings with the
 * same orientation are separate parts, opposite ones are holes assigned to the part containing them.
 */
function buildParts(rings, minArea) {
  const prepared = [];
  for (let i = 0; i < rings.length; i++) {
    const co = toPlan(rings[i]);
    if (!co) continue;
    const a = planArea(co);
    if (!isNum(a) || Math.abs(a) < 1e-4) continue;
    prepared.push({ co, a });
  }
  if (!prepared.length) return null;
  let big = prepared[0];
  for (let i = 1; i < prepared.length; i++) if (Math.abs(prepared[i].a) > Math.abs(big.a)) big = prepared[i];
  if (Math.abs(big.a) < minArea) return null;
  const outerSign = big.a > 0 ? 1 : -1;

  const parts = [];
  const holes = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const sign = p.a > 0 ? 1 : -1;
    if (sign === outerSign) {
      if (Math.abs(p.a) < minArea) continue;
      const co = p.a > 0 ? p.co : reverseRing(p.co);       // force CCW
      parts.push({ co, area: Math.abs(p.a), bbox: planBBox(co), holes: [] });
    } else {
      if (Math.abs(p.a) < MIN_HOLE_AREA) continue;
      holes.push(p);
    }
  }
  if (!parts.length) return null;

  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const hx = h.co[0], hy = h.co[1];
    let host = null;
    for (let k = 0; k < parts.length; k++) {
      const b = parts[k].bbox;
      if (hx < b[0] || hx > b[2] || hy < b[1] || hy > b[3]) continue;
      if (planContains(parts[k].co, hx, hy)) { host = parts[k]; break; }
    }
    if (!host && parts.length === 1) host = parts[0];
    if (host) host.holes.push(h.a < 0 ? h.co : reverseRing(h.co));   // force CW
  }

  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(makePart(parts[i].co, parts[i].holes));
  return out;
}

/* ========================================================= mesh emitters == */

function setMat(mb, m) { mb.color(m[0], m[1], m[2], m[3], m[4], m[5], m.length > 6 ? m[6] : 0); }

// Tapered prism between two plan rings with the same vertex count (used by the CN Tower lathe).
function emitPrism(mb, base, top, y0, y1, cap) {
  const n = base.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ax = base[j], az = -base[j + 1];
    const bx = base[i], bz = -base[i + 1];
    const cx = top[i], cz = -top[i + 1];
    const dx = top[j], dz = -top[j + 1];
    mb.tri(ax, y0, az, bx, y0, bz, cx, y1, cz);
    mb.tri(ax, y0, az, cx, y1, cz, dx, y1, dz);
  }
  if (cap) {
    for (let i = 4; i < n; i += 2) {
      mb.tri(top[0], y1, -top[1], top[i - 2], y1, -top[i - 1], top[i], y1, -top[i + 1]);
    }
  }
}

function ringPts(cu, cv, r, seg, phase) {
  const out = new Array(seg * 2);
  for (let i = 0; i < seg; i++) {
    const a = phase + (i / seg) * Math.PI * 2;
    out[i * 2] = cu + Math.cos(a) * r;
    out[i * 2 + 1] = cv + Math.sin(a) * r;
  }
  return out;
}

// Ear clipping legitimately emits collinear ears where a ring has three points in a line, and a
// zero-area triangle has no normal to derive: MeshBuilder falls back to +Y for it, which on a wall
// or a soffit is simply wrong. They also cost vertices for nothing. Drop them at the source.
const CAP_MIN_AREA = 1e-7;

function capArea2(co, a, b, c) {
  return (co[b] - co[a]) * (co[c + 1] - co[a + 1]) - (co[c] - co[a]) * (co[b + 1] - co[a + 1]);
}

// Flat cap over a prepared part at height y (plan CCW -> +Y normal).
function emitCap(mb, part, y, stats) {
  const tris = triangulate(part.co, part.holeStarts);
  if (!tris.length) { if (stats) stats.capFail++; return 0; }
  const co = part.co;
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
    if (Math.abs(capArea2(co, a, b, c)) < CAP_MIN_AREA) { if (stats) stats.capDegenerate++; continue; }
    mb.tri(co[a], y, -co[a + 1], co[b], y, -co[b + 1], co[c], y, -co[c + 1]);
    n++;
  }
  return n;
}

/**
 * Draped cap: same, but every vertex takes its own terrain height.
 *
 * Ear clipping hands back whatever shape the ring wants, and a park boundary happily produces a
 * 150 m sliver. Sampling the terrain only at its three corners then interpolates a straight plane
 * across ground that curves under it — measured at over a metre on the worst park in the extract,
 * and enough on ordinary ones to punch the terrain mesh through the grass and to swap the order of
 * two ground covers that were laid four centimetres apart. So keep splitting the longest edge
 * until the flat plane is within CAP_TOL of the ground it is supposed to be lying on — which
 * costs nothing where the ground is level and pays where it is not.
 */
const CAP_MAX_EDGE = 6.0;          // no point testing a split shorter than this
const CAP_TOL = 0.012;             // metres the flat plane may cut across the real ground
const CAP_MAX_SPLIT = 7;           // depth guard, so one pathological ring cannot run away
const _capStack = [];

function emitDrapedCap(mb, part, groundY, dy, stats, grade) {
  const tris = triangulate(part.co, part.holeStarts);
  if (!tris.length) { if (stats) stats.capFail++; return 0; }
  const co = part.co;
  const S = _capStack;
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 2, b = tris[t + 1] * 2, c = tris[t + 2] * 2;
    if (Math.abs(capArea2(co, a, b, c)) < CAP_MIN_AREA) { if (stats) stats.capDegenerate++; continue; }
    const ax = co[a], az = -co[a + 1], bx = co[b], bz = -co[b + 1], cx = co[c], cz = -co[c + 1];
    S.length = 0;
    S.push(ax, groundY(ax, az) + dy, az, bx, groundY(bx, bz) + dy, bz,
      cx, groundY(cx, cz) + dy, cz, 0);
    while (S.length) {
      const d = S.pop();
      const zc = S.pop(), yc = S.pop(), xc = S.pop();
      const zb = S.pop(), yb = S.pop(), xb = S.pop();
      const za = S.pop(), ya = S.pop(), xa = S.pop();
      let split = 0;                                   // 0 none, 1 edge ab, 2 edge bc, 3 edge ca
      if (d < CAP_MAX_SPLIT) {
        const e0 = (xb - xa) * (xb - xa) + (zb - za) * (zb - za);
        const e1 = (xc - xb) * (xc - xb) + (zc - zb) * (zc - zb);
        const e2 = (xa - xc) * (xa - xc) + (za - zc) * (za - zc);
        const lim = CAP_MAX_EDGE * CAP_MAX_EDGE;
        if (e0 >= e1 && e0 >= e2) { if (e0 > lim) split = 1; }
        else if (e1 >= e2) { if (e1 > lim) split = 2; }
        else if (e2 > lim) split = 3;
      }
      if (split) {
        // Only actually split where the flat plane misses the ground: a park laid over level
        // terrain stays one big triangle, a park on a slope gets as many as it needs.
        const px = split === 1 ? (xa + xb) * 0.5 : (split === 2 ? (xb + xc) * 0.5 : (xc + xa) * 0.5);
        const pz = split === 1 ? (za + zb) * 0.5 : (split === 2 ? (zb + zc) * 0.5 : (zc + za) * 0.5);
        const flat = split === 1 ? (ya + yb) * 0.5 : (split === 2 ? (yb + yc) * 0.5 : (yc + ya) * 0.5);
        const real = groundY(px, pz) + dy;
        if (Math.abs(real - flat) <= CAP_TOL) split = 0;
        else if (split === 1) {
          S.push(xa, ya, za, px, real, pz, xc, yc, zc, d + 1);
          S.push(px, real, pz, xb, yb, zb, xc, yc, zc, d + 1);
          continue;
        } else if (split === 2) {
          S.push(xa, ya, za, xb, yb, zb, px, real, pz, d + 1);
          S.push(xa, ya, za, px, real, pz, xc, yc, zc, d + 1);
          continue;
        } else {
          S.push(xa, ya, za, xb, yb, zb, px, real, pz, d + 1);
          S.push(px, real, pz, xb, yb, zb, xc, yc, zc, d + 1);
          continue;
        }
      }
      // Where a depressed corridor has taken the ground out from under this cover, the cover
      // goes with it — otherwise a car park roofs over the underpass it sits beside.
      if (grade && grade.cut((xa + xb + xc) / 3, (za + zb + zc) / 3)) {
        if (stats) stats.grade.areaTrisCut++;
        continue;
      }
      mb.tri(xa, ya, za, xb, yb, zb, xc, yc, zc);
      n++;
    }
  }
  return n;
}

/* ============================================================== polylines == */

function polyResample(pts, maxSeg) {
  const out = [];
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !isNum(p[0]) || !isNum(p[1])) continue;
    if (prev && Math.abs(p[0] - prev[0]) < 1e-4 && Math.abs(p[1] - prev[1]) < 1e-4) continue;
    if (prev) {
      const dx = p[0] - prev[0], dz = p[1] - prev[1];
      const len = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.min(64, Math.floor(len / maxSeg));
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        out.push([prev[0] + dx * t, prev[1] + dz * t]);
      }
    }
    out.push([p[0], p[1]]);
    prev = p;
  }
  return out;
}

/**
 * Per-vertex mitred frames for a polyline: unit side vector plus a clamped miter scale.
 *
 * `reach` is the LARGEST lateral offset the caller will use with these frames — for a road that is
 * the outer edge of its sidewalk band, not the half carriageway — because every clamp below is
 * about how far the corner may throw that outermost edge.
 *
 * Three things bound the scale, and getting any of them wrong puts a tongue of pavement out across
 * the roadway:
 *   1. the true miter, 1 / cos(half the turn) — exact where the corner is gentle;
 *   2. an absolute reach clamp, so no corner adds more than MITER_OVER metres to the edge;
 *   3. a fold clamp: the corner displaces the edge ALONG the road by reach * scale * sin(half the
 *      turn), and once that exceeds the neighbouring segment the ribbon folds back through itself
 *      and emits an inside-out quad that vanishes under back-face culling.
 * Where the corner is too sharp, the join takes the tightest of the three and leaves a small notch
 * on the outside. A notch a few centimetres across is invisible; a nine-metre spike is not.
 *
 * The along-road displacement is `scale * sin`, NOT `tan(half the turn)`: those agree only while
 * the miter is unclamped. Once clamp (1) or (2) has pulled the corner point back along the
 * bisector, sin(half the turn) keeps growing while the tan-derived bound stops — so a hairpin on a
 * wide way slipped through the old test and folded anyway. Bounding `scale * sin` directly is
 * exact for both the clamped and the unclamped case. Where even a butt join (scale 1) would fold —
 * a hairpin whose neighbouring segment is shorter than the way is wide — no clamp can help, and
 * pruneSpikes() has already dropped that station before these frames are built.
 */
const MITER_OVER = 1.5;            // metres a mitred corner may add to the outermost edge
const MITER_FOLD = 0.45;           // fraction of the shorter neighbouring segment one corner may
                                   // eat. Under a half, because the corner at the OTHER end of
                                   // that segment is eating into it from the far side too

/**
 * Remove the stations no mitre can serve at half-width `reach`.
 *
 * A corner displaces the ribbon edge ALONG the road by reach * scale * sin(half the turn). One
 * segment of length L carries the displacement of the corner at each of its ends, so the segment
 * folds — and emits an inside-out quad that vanishes under back-face culling — exactly when those
 * two add up to more than L. The miter scale is already clamped, and it can never go below 1
 * without folding the quad from the other side, so where the sum still exceeds L no frame can fix
 * it: the vertex itself has to go. In practice these are 20 cm zig-zags on a 26 m carriageway —
 * digitising noise a fraction of a lane wide, which is why dropping them costs nothing.
 *
 * The test is the exact one, run against the frames polyFrames() will actually produce, rather
 * than a conservative per-vertex bound: a conservative test throws away real 90-degree corners on
 * plaza outlines that mitre perfectly well.
 *
 * @returns {Array} the same array when nothing needed pruning, a pruned copy otherwise
 */
function pruneSpikes(pts, reach) {
  const w = Math.max(0.25, isNum(reach) ? reach : 1);
  let cur = pts;
  for (let pass = 0; pass < 24; pass++) {
    const n = cur.length;
    if (n < 3) return cur;
    const fr = polyFrames(cur, w);
    // Along-road displacement each station imposes on both of its segments.
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ax = cur[i][0] - cur[i - 1][0], az = cur[i][1] - cur[i - 1][1];
      const bx = cur[i + 1][0] - cur[i][0], bz = cur[i + 1][1] - cur[i][1];
      const al = Math.hypot(ax, az), bl = Math.hypot(bx, bz);
      if (!(al > EPS) || !(bl > EPS)) { d[i] = Infinity; continue; }
      // sin(half the turn) from the half-angle identity, so no trig and no sign ambiguity.
      const dot = clamp((ax * bx + az * bz) / (al * bl), -1, 1);
      d[i] = w * fr[i * 3 + 2] * Math.sqrt(Math.max(0, (1 - dot) * 0.5));
    }
    let drop = null;
    for (let i = 1; i < n; i++) {
      const L = Math.hypot(cur[i][0] - cur[i - 1][0], cur[i][1] - cur[i - 1][1]);
      if (d[i - 1] + d[i] <= L) continue;
      // Drop the sharper of the two ends; a polyline endpoint has no corner and cannot be dropped.
      let k = (d[i] >= d[i - 1] || i - 1 === 0) ? i : i - 1;
      if (k === n - 1) k = i - 1;
      if (k > 0 && k < n - 1) (drop || (drop = new Set())).add(k);
    }
    if (!drop) return cur;
    const out = [];
    // Never drop two neighbours in one pass while there is still room to converge gently: the
    // survivor's geometry is re-measured next pass. Once the gentle passes are spent, take
    // everything that is still flagged in one go rather than leaving a fold in the mesh.
    const gentle = pass < 12;
    let last = -2;
    for (let i = 0; i < n; i++) {
      if (drop.has(i) && (!gentle || i !== last + 1)) { last = i; continue; }
      out.push(cur[i]);
    }
    if (out.length === cur.length) return cur;
    cur = out;
  }
  return cur;
}

function polyFrames(pts, reach, maxOver = MITER_OVER) {
  const n = pts.length;
  const w = Math.max(0.25, isNum(reach) ? reach : 1);
  const lim = clamp(1 + Math.max(0, maxOver) / w, 1, 6);
  const fr = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    let px = 0, pz = 0, nx = 0, nz = 0, pl = 0, nl = 0;
    if (i > 0) {
      px = pts[i][0] - pts[i - 1][0]; pz = pts[i][1] - pts[i - 1][1];
      pl = Math.hypot(px, pz);
      if (pl > EPS) { px /= pl; pz /= pl; } else { px = 0; pz = 0; pl = 0; }
    }
    if (i < n - 1) {
      nx = pts[i + 1][0] - pts[i][0]; nz = pts[i + 1][1] - pts[i][1];
      nl = Math.hypot(nx, nz);
      if (nl > EPS) { nx /= nl; nz /= nl; } else { nx = 0; nz = 0; nl = 0; }
    }
    if (i === 0) { px = nx; pz = nz; pl = nl; }
    if (i === n - 1) { nx = px; nz = pz; nl = pl; }
    let mx = px + nx, mz = pz + nz;
    let ml = Math.hypot(mx, mz);
    if (ml < 1e-5) { mx = nx; mz = nz; ml = Math.hypot(mx, mz); }   // 180 degree hairpin
    if (ml > EPS) { mx /= ml; mz /= ml; } else { mx = 1; mz = 0; }
    // dot = cos(half the turn angle), always in [0, 1] for the bisector of two unit vectors.
    const dot = clamp(mx * nx + mz * nz, 0, 1);
    const sin = Math.sqrt(Math.max(0, 1 - dot * dot));
    const near = Math.min(pl > 0 ? pl : nl, nl > 0 ? nl : pl);
    let scale = dot > 1e-4 ? 1 / dot : lim;
    if (scale > lim) scale = lim;
    // Along-road displacement of the outermost edge is w * scale * sin; cap it at MITER_FOLD of
    // the shorter neighbouring segment, which the corner at that segment's far end is eating into
    // from the other side.
    if (sin > 1e-6) {
      const fold = (MITER_FOLD * near) / (w * sin);
      if (scale > fold) scale = fold;
    }
    // Never below 1. Pulling the section IN at a corner puts the edge point on the far side of the
    // previous cross-section and folds the quad from the other direction, which is how the first
    // attempt at this clamp traded one fold for another. Stations no scale can serve are removed
    // by pruneSpikes() before the frames are built at all.
    if (!(scale >= 1)) scale = 1;
    fr[i * 3] = -mz;          // side vector, +90 degrees from travel
    fr[i * 3 + 1] = mx;
    fr[i * 3 + 2] = scale;
  }
  return fr;
}

// Plan-space signed area x2 of a triangle, in (u, v) = (x, -z). Positive means the winding gives
// a +Y normal, i.e. the face looks at the sky.
function planWind2(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
}

// Ground-plane geometry audit, wired to stats once per load so the ribbon builders can report
// without threading a stats object through every call site.
let _audit = null;

/**
 * Emit a ribbon along a polyline. `cross` is an ascending list of {o, dy} lateral offsets; `yAt`
 * gives the surface height as (edgeX, edgeZ, centreX, centreZ, vertexIndex). Quads are wound CCW
 * seen from above. `down` flips the winding, for bridge undersides.
 *
 * Each quad is split along one of its two diagonals. A quad between consecutive stations is often
 * NOT convex — the section swings round a corner faster than the ribbon advances — and for a
 * non-convex quad exactly one diagonal lies inside it. Taking the wrong one hands back a triangle
 * wound against the sky, which back-face culling drops from above and shows from below. So the
 * first diagonal is tested, the other is tried when it fails, and only when NEITHER works is the
 * quad a genuine FOLD: the corner threw the edge back past the previous station and the quad
 * crossed itself. Then whatever winds correctly is kept, the rest is dropped rather than shipped,
 * and the fold is counted.
 */
function emitRibbon(mb, pts, frames, cross, yAt, down) {
  const n = pts.length;
  if (n < 2 || cross.length < 2) return;
  const m = cross.length;
  const ax = new Float64Array(m), ay = new Float64Array(m), az = new Float64Array(m);
  const bx = new Float64Array(m), by = new Float64Array(m), bz = new Float64Array(m);
  let have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const px = pts[i][0], pz = pts[i][1];
    for (let k = 0; k < m; k++) {
      const o = cross[k].o * sc;
      const x = px + sx * o, z = pz + sz * o;
      bx[k] = x; bz[k] = z; by[k] = yAt(x, z, px, pz, i) + cross[k].dy;
    }
    if (have) {
      for (let k = 0; k + 1 < m; k++) {
        const j = k + 1;
        // Diagonal a[k] -> b[k+1].
        const w1 = planWind2(ax[k], az[k], ax[j], az[j], bx[j], bz[j]);
        const w2 = planWind2(ax[k], az[k], bx[j], bz[j], bx[k], bz[k]);
        if (w1 > 0 && w2 > 0) {
          if (down) {
            mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], ax[j], ay[j], az[j]);
            mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
          } else {
            mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[j], by[j], bz[j]);
            mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
          }
          continue;
        }
        // Diagonal a[k+1] -> b[k].
        const w3 = planWind2(ax[k], az[k], ax[j], az[j], bx[k], bz[k]);
        const w4 = planWind2(ax[j], az[j], bx[j], bz[j], bx[k], bz[k]);
        if (w3 > 0 && w4 > 0) {
          if (down) {
            mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], ax[j], ay[j], az[j]);
            mb.tri(ax[j], ay[j], az[j], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
          } else {
            mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[k], by[k], bz[k]);
            mb.tri(ax[j], ay[j], az[j], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
          }
          continue;
        }
        // A quad with no area at all is not a fold, it is two coincident stations; it is still
        // dropped, because a zero-area triangle has no normal to derive.
        if (_audit) _audit.ribbonFolds += (w1 < -EPS ? 1 : 0) + (w2 < -EPS ? 1 : 0);
        if (down) {
          if (w1 > 0) mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], ax[j], ay[j], az[j]);
          if (w2 > 0) mb.tri(ax[k], ay[k], az[k], bx[k], by[k], bz[k], bx[j], by[j], bz[j]);
        } else {
          if (w1 > 0) mb.tri(ax[k], ay[k], az[k], ax[j], ay[j], az[j], bx[j], by[j], bz[j]);
          if (w2 > 0) mb.tri(ax[k], ay[k], az[k], bx[j], by[j], bz[j], bx[k], by[k], bz[k]);
        }
      }
    }
    for (let k = 0; k < m; k++) { ax[k] = bx[k]; ay[k] = by[k]; az[k] = bz[k]; }
    have = true;
  }
}

/**
 * Vertical skirt along one lateral offset of a polyline, from `yTop(...)` down by `depth`.
 * `facing` = -1 makes the face look toward -side (the road), +1 toward +side.
 */
function emitSkirt(mb, pts, frames, offset, yTop, depth, facing) {
  const n = pts.length;
  let px = 0, pz = 0, py = 0, have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const o = offset * sc;
    const x = pts[i][0] + sx * o, z = pts[i][1] + sz * o;
    const y = yTop(x, z, pts[i][0], pts[i][1], i);
    if (have) {
      if (facing < 0) {
        mb.tri(px, py - depth, pz, px, py, pz, x, y, z);
        mb.tri(px, py - depth, pz, x, y, z, x, y - depth, z);
      } else {
        mb.tri(px, py - depth, pz, x, y - depth, z, x, y, z);
        mb.tri(px, py - depth, pz, x, y, z, px, py, pz);
      }
    }
    px = x; pz = z; py = y; have = true;
  }
}

/* ================================================================ terrain == */

function makeTerrain(src, extent, infraLines, waterAreas, surveyedShore) {
  const nx = Math.max(2, src.nx | 0);
  const nz = Math.max(2, src.nz | 0);
  const cell = isNum(src.cell) && src.cell > 0 ? src.cell : 25;
  const x0 = -extent.x / 2;
  const z0 = -extent.z / 2;
  const h = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) h[i] = isNum(src.h[i]) ? src.h[i] : 0;

  // --- open water mask -----------------------------------------------------------------------
  // Rasterise every road, path, rail, pier and footprint edge into the terrain grid, then run a
  // chamfer distance transform. Cells far from ALL of it, south of WATER_MIN_Z, are open water.
  const dist = new Float32Array(nx * nz).fill(1e9);
  const mark = (x, z) => {
    const i = Math.round((x - x0) / cell);
    const j = Math.round((z - z0) / cell);
    if (i >= 0 && i < nx && j >= 0 && j < nz) dist[j * nx + i] = 0;
  };
  for (let l = 0; l < infraLines.length; l++) {
    const pts = infraLines[l];
    if (!pts || pts.length < 1) continue;
    mark(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], az = pts[k - 1][1];
      const bx = pts[k][0], bz = pts[k][1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.min(512, Math.ceil(len / (cell * 0.5)));
      for (let s = 1; s <= steps; s++) mark(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps);
    }
  }
  const D1 = cell, D2 = cell * Math.SQRT2;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let d = dist[k];
      if (j > 0) {
        if (i > 0) d = Math.min(d, dist[k - nx - 1] + D2);
        d = Math.min(d, dist[k - nx] + D1);
        if (i < nx - 1) d = Math.min(d, dist[k - nx + 1] + D2);
      }
      if (i > 0) d = Math.min(d, dist[k - 1] + D1);
      dist[k] = d;
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let d = dist[k];
      if (j < nz - 1) {
        if (i < nx - 1) d = Math.min(d, dist[k + nx + 1] + D2);
        d = Math.min(d, dist[k + nx] + D1);
        if (i > 0) d = Math.min(d, dist[k + nx - 1] + D2);
      }
      if (i < nx - 1) d = Math.min(d, dist[k + 1] + D1);
      dist[k] = d;
    }
  }

  const mask = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * cell;
    if (z < WATER_MIN_Z) continue;
    for (let i = 0; i < nx; i++) {
      mask[j * nx + i] = smoothstep(WATER_NEAR, WATER_FAR, dist[j * nx + i]) *
        smoothstep(WATER_MIN_Z, WATER_MIN_Z + 120, z);
    }
  }
  // Two box-blur passes so the shoreline reads as a beach slope rather than 25 m stair steps.
  const tmp = new Float32Array(nx * nz);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let acc = 0, w = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = i + di, b = j + dj;
            if (a < 0 || a >= nx || b < 0 || b >= nz) continue;
            acc += mask[b * nx + a]; w++;
          }
        }
        tmp[j * nx + i] = w > 0 ? acc / w : 0;
      }
    }
    mask.set(tmp);
  }
  // HARBOURFRONT: where the extract carries a surveyed shoreline the synthesised mask is not
  // applied at all — harbour.js carves the water from the real geometry (CONTRACT §8.3).
  for (let i = 0; i < nx * nz; i++) {
    h[i] = surveyedShore
      ? Math.max(h[i], LAND_FLOOR)
      : lerp(Math.max(h[i], LAND_FLOOR), WATER_DEPTH, clamp(mask[i], 0, 1));
  }

  // --- inland ponds: flatten the grid inside each polygon and remember the surface height ----
  const ponds = [];
  for (let a = 0; a < waterAreas.length; a++) {
    const co = waterAreas[a];
    const bb = planBBox(co);
    let lo = Infinity;
    for (let i = 0; i < co.length; i += 2) {
      const gx = clamp(Math.round((co[i] - x0) / cell), 0, nx - 1);
      const gz = clamp(Math.round((-co[i + 1] - z0) / cell), 0, nz - 1);
      lo = Math.min(lo, h[gz * nx + gx]);
    }
    if (!isFinite(lo)) continue;
    const level = lo - 0.35;
    ponds.push({ co, level });
    const i0 = clamp(Math.floor((bb[0] - x0) / cell), 0, nx - 1);
    const i1 = clamp(Math.ceil((bb[2] - x0) / cell), 0, nx - 1);
    const j0 = clamp(Math.floor((-bb[3] - z0) / cell), 0, nz - 1);
    const j1 = clamp(Math.ceil((-bb[1] - z0) / cell), 0, nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell, v = -(z0 + j * cell);
        if (planContains(co, x, v)) h[j * nx + i] = Math.min(h[j * nx + i], level - 0.45);
      }
    }
  }

  const groundY = (x, z) => {
    let fx = (x - x0) / cell;
    let fz = (z - z0) / cell;
    if (!isFinite(fx) || !isFinite(fz)) return 0;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
    if (j < 0) j = 0; else if (j > nz - 2) j = nz - 2;
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const a = h[j * nx + i], b = h[j * nx + i + 1];
    const c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };

  return { nx, nz, cell, x0, z0, h, mask, ponds, groundY, waterY: WATER_Y };
}

// How finely a terrain cell is rebuilt where a depressed corridor cuts through it. The cut edge
// is only ever accurate to half a sub-cell diagonal, which is why the corridor's paved verge is
// TRENCH_VERGE wide: it covers whatever raggedness this leaves.
const CUT_SUB = 2.2;

/**
 * The terrain, with the depressed corridors taken out of it.
 *
 * A 25 m grid cannot represent a 14 m trench, and leaving the sheet intact would draw a lid over
 * every underpass in the city. Cells the cut touches — a few dozen of them, proportional to the
 * length of corridor and to nothing else — are rebuilt at CUT_SUB and the sub-cells inside the cut
 * are dropped. A sub-cell goes only when ALL FOUR of its corners are inside, so the terrain always
 * RECEDES from the trench rather than hanging over it; the verge covers the difference.
 *
 * Built a tile at a time by emitTerrainRange() below.
 */

/**
 * Per-vertex terrain normals, computed once and cached on T.
 *
 * Split out of the mesh emitter because the ground is now built a tile at a time: every tile
 * needs the same normal field, and a tile rebuilt after eviction must produce byte-identical
 * geometry to the one it replaces. Central differences over the whole grid do that; per-tile
 * differences would not, because a tile edge has no neighbour to difference against.
 */
function terrainNormals(T) {
  if (T.nrm) return T.nrm;
  const { nx, nz, cell, h } = T;
  const nrm = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const l = h[j * nx + Math.max(0, i - 1)];
      const r = h[j * nx + Math.min(nx - 1, i + 1)];
      const u = h[Math.max(0, j - 1) * nx + i];
      const d = h[Math.min(nz - 1, j + 1) * nx + i];
      const sx = (i === 0 || i === nx - 1) ? cell : cell * 2;
      const sz = (j === 0 || j === nz - 1) ? cell : cell * 2;
      let ax = -(r - l) / sx, ay = 1, az = -(d - u) / sz;
      const il = 1 / Math.sqrt(ax * ax + ay * ay + az * az);
      const o = (j * nx + i) * 3;
      nrm[o] = ax * il; nrm[o + 1] = ay * il; nrm[o + 2] = az * il;
    }
  }
  T.nrm = nrm;
  return nrm;
}

/**
 * The ground, for the cell range [i0, i1) x [j0, j1). Every cell belongs to exactly one tile, so
 * the whole grid is still emitted exactly once and adjacent tiles share their edge vertices to
 * the bit — the seam is not stitched, it simply cannot open.
 */
function emitTerrainRange(mb, T, grade, i0, i1, j0, j1) {
  const { nx, nz, cell, x0, z0, h } = T;
  const nrm = terrainNormals(T);
  // ISLANDS: the Toronto Islands are parkland from shore to shore, and only about half of that
  // is mapped as a park or grass polygon. The rest would draw as the mainland's bare-terrain
  // grey, which on an island reads as dirt. harbour.js marks the cells (T.isleLand); the ground
  // itself carries the park albedo there and every mapped polygon still draws over it.
  const isleLand = T.isleLand || null;
  let isleMat = -1;
  setMat(mb, M.terrain);
  const px = (i) => x0 + i * cell;
  const pz = (j) => z0 + j * cell;
  const ja = Math.max(0, j0), jb = Math.min(nz - 1, j1);
  const ia = Math.max(0, i0), ib = Math.min(nx - 1, i1);
  for (let j = ja; j < jb; j++) {
    for (let i = ia; i < ib; i++) {
      if (isleLand) {
        const want = isleLand[j * nx + i] ? 1 : 0;
        if (want !== isleMat) { isleMat = want; setMat(mb, want ? M.park : M.terrain); }
      }
      const i00 = (j * nx + i) * 3, i10 = (j * nx + i + 1) * 3;
      const i01 = ((j + 1) * nx + i) * 3, i11 = ((j + 1) * nx + i + 1) * 3;
      const x = px(i), x1 = px(i + 1), z = pz(j), z1 = pz(j + 1);
      const y00 = h[j * nx + i], y10 = h[j * nx + i + 1];
      const y01 = h[(j + 1) * nx + i], y11 = h[(j + 1) * nx + i + 1];
      if (grade && grade.boxHot(x, z, x1, z1)) {
        emitCutCell(mb, grade, x, z, x1, z1, y00, y10, y01, y11, nrm, i00, i10, i01, i11);
        continue;
      }
      // CCW seen from above: (i,j+1) -> (i+1,j+1) -> (i+1,j) -> (i,j)
      mb.vert(x, y01, z1, nrm[i01], nrm[i01 + 1], nrm[i01 + 2]);
      mb.vert(x1, y11, z1, nrm[i11], nrm[i11 + 1], nrm[i11 + 2]);
      mb.vert(x1, y10, z, nrm[i10], nrm[i10 + 1], nrm[i10 + 2]);
      mb.vert(x, y01, z1, nrm[i01], nrm[i01 + 1], nrm[i01 + 2]);
      mb.vert(x1, y10, z, nrm[i10], nrm[i10 + 1], nrm[i10 + 2]);
      mb.vert(x, y00, z, nrm[i00], nrm[i00 + 1], nrm[i00 + 2]);
    }
  }
}

// One terrain cell, minus whatever the cut covers.
//
// Refined ADAPTIVELY: a square whose corners, edge midpoints and centre are all clear of the cut is
// emitted whole, however big it is, and only the squares the cut edge actually runs through are
// split down to CUT_SUB. A corridor crossing a 25 m cell would otherwise rebuild the entire cell at
// CUT_SUB — a couple of hundred triangles to describe two straight edges.
//
// Heights and normals come from the cell's own bilinear interpolation, so a refined cell is
// geometrically identical to the coarse one everywhere the cut does not reach, and the seam to its
// unrefined neighbours is exact.
function emitCutCell(mb, grade, x0, z0, x1, z1, y00, y10, y01, y11, nrm, i00, i10, i01, i11) {
  const yAt = (u, v) => (y00 * (1 - u) + y10 * u) * (1 - v) + (y01 * (1 - u) + y11 * u) * v;
  const nAt = (u, v, c) => (nrm[i00 + c] * (1 - u) + nrm[i10 + c] * u) * (1 - v) +
    (nrm[i01 + c] * (1 - u) + nrm[i11 + c] * u) * v;
  const put = (u, v) => {
    const px = x0 + (x1 - x0) * u, pz = z0 + (z1 - z0) * v;
    let ax = nAt(u, v, 0), ay = nAt(u, v, 1), az = nAt(u, v, 2);
    const l = Math.sqrt(ax * ax + ay * ay + az * az);
    if (l > EPS) { ax /= l; ay /= l; az /= l; } else { ax = 0; ay = 1; az = 0; }
    mb.vert(px, yAt(u, v), pz, ax, ay, az);
  };
  const cutUV = (u, v) => grade.cut(x0 + (x1 - x0) * u, z0 + (z1 - z0) * v);
  const span = Math.max(x1 - x0, z1 - z0);
  const quad = (u0, v0, u1, v1) => {
    // CCW seen from above.
    put(u0, v1); put(u1, v1); put(u1, v0);
    put(u0, v1); put(u1, v0); put(u0, v0);
  };
  const refine = (u0, v0, u1, v1, depth) => {
    const um = (u0 + u1) * 0.5, vm = (v0 + v1) * 0.5;
    // Nine probes: the corners the quad is built from, the edge midpoints and the centre. A cut is
    // metres wide, so at this size nothing can slip between them unseen.
    const corners = (cutUV(u0, v0) ? 1 : 0) + (cutUV(u1, v0) ? 1 : 0) +
      (cutUV(u0, v1) ? 1 : 0) + (cutUV(u1, v1) ? 1 : 0);
    const inner = (cutUV(um, v0) ? 1 : 0) + (cutUV(um, v1) ? 1 : 0) +
      (cutUV(u0, vm) ? 1 : 0) + (cutUV(u1, vm) ? 1 : 0) + (cutUV(um, vm) ? 1 : 0);
    if (corners === 0 && inner === 0) { quad(u0, v0, u1, v1); return; }
    if (corners === 4 && inner === 5) return;            // wholly inside the cut
    // ANY corner inside removes the quad, so the terrain always RECEDES from the trench rather
    // than hanging a ledge over it. The corridor's verge is TRENCH_VERGE wide precisely so that it
    // covers the sliver of ground this gives away.
    if (span * (u1 - u0) <= CUT_SUB || depth >= 6) return;
    refine(u0, v0, um, vm, depth + 1);
    refine(um, v0, u1, vm, depth + 1);
    refine(u0, vm, um, v1, depth + 1);
    refine(um, vm, u1, v1, depth + 1);
  };
  refine(0, 0, 1, 1, 0);
}

function emitWaterMesh(mb, T, extent, harbour) {
  setMat(mb, M.water);
  const hx = extent.x / 2, hz = extent.z / 2;
  const step = 220;
  const x0 = -hx - 4800, x1 = hx + 4800;
  const z0 = -hz - 1200, z1 = hz + 7200;
  for (let z = z0; z < z1; z += step) {
    for (let x = x0; x < x1; x += step) {
      const xa = x, xb = Math.min(x + step, x1);
      const za = z, zb = Math.min(z + step, z1);
      // HARBOURFRONT: inside the surveyed lake the tile is always water. A slip between two
      // piers is narrower than this lattice, so a terrain probe at the corners would leave it dry.
      const surveyed = harbour ? harbourTileHasWater(harbour, xa, za, xb, zb) : false;
      // Inside the mapped extent only emit where the terrain actually dips to the water plane.
      if (!surveyed && xb > -hx && xa < hx && zb > -hz && za < hz) {
        const c = Math.min(
          Math.min(T.groundY(xa, za), T.groundY(xb, za)),
          Math.min(T.groundY(xa, zb), T.groundY(xb, zb))
        );
        if (c > WATER_Y - 0.02) continue;
      }
      mb.vert(xa, WATER_Y, zb, 0, 1, 0);
      mb.vert(xb, WATER_Y, zb, 0, 1, 0);
      mb.vert(xb, WATER_Y, za, 0, 1, 0);
      mb.vert(xa, WATER_Y, zb, 0, 1, 0);
      mb.vert(xb, WATER_Y, za, 0, 1, 0);
      mb.vert(xa, WATER_Y, za, 0, 1, 0);
    }
  }
  for (let p = 0; p < T.ponds.length; p++) {
    const pond = T.ponds[p];
    const part = makePart(planArea(pond.co) > 0 ? pond.co : reverseRing(pond.co), []);
    emitCap(mb, part, pond.level, null);
  }
}

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
  const rClass = hash2(cx, cz, 11 + profile * 7);
  const rPal = hash2(cx, cz, 31);
  const jLight = hash2(cx, cz, 41);
  const jWarm = hash2(cx, cz, 43);
  const jRough = hash2(cx, cz, 47);

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

function assignLandmarks(buildings, project) {
  const pts = LANDMARKS.map((L) => {
    const p = project(L.lon, L.lat);
    return { L, x: p[0], z: p[1] };
  });
  const claim = new Array(buildings.length).fill(null);
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    let best = null, bestScore = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const { L, x, z } = pts[k];
      if (b.h < L.minH) continue;
      const d = Math.hypot(b.cx - x, b.cz - z);
      if (d > L.radius) continue;
      const hd = Math.abs(b.h - L.h) / L.h;
      if (hd > L.tol) continue;
      const score = hd * 2.0 + d / L.radius;
      if (score < bestScore) { bestScore = score; best = L; }
    }
    if (best) claim[i] = best;
  }
  // One non-cascading expansion pass: stacked massing slabs of a claimed tower inherit its material.
  const seeds = [];
  for (let i = 0; i < claim.length; i++) if (claim[i]) seeds.push(i);
  for (let i = 0; i < buildings.length; i++) {
    if (claim[i]) continue;
    const b = buildings[i];
    for (let s = 0; s < seeds.length; s++) {
      const o = buildings[seeds[s]];
      if (b.h < o.h * LANDMARK_INHERIT_H) continue;
      if (Math.hypot(b.cx - o.cx, b.cz - o.cz) > LANDMARK_INHERIT_R) continue;
      claim[i] = claim[seeds[s]];
      break;
    }
  }
  return claim;
}

/* =============================================================== CN Tower == */
// The massing dataset stops at the SkyPod (443 m) and omits the mast. The silhouette is the single
// most recognisable object in the scene, so it is modelled by hand: flared three-legged base,
// tapering hexagonal shaft, main pod at 342-372 m, SkyPod at 432-448 m, mast to 553.33 m.

const CN_PROFILE = [
  [0, 30.0], [10, 26.5], [26, 21.0], [46, 17.2], [96, 14.2], [180, 12.2], [300, 10.3], [330, 9.7],
  [333, 12.0], [338, 21.0], [342, 26.2], [346, 27.4], [357, 27.4], [360, 25.0], [366, 17.0],
  [372, 10.6], [382, 9.0], [428, 7.5], [432, 8.2], [436, 12.2], [443, 12.2], [446, 8.0],
  [448, 4.8], [452, 4.3], [470, 3.8], [500, 2.6], [524, 1.8], [545, 0.95], [553.33, 0.42],
];

// The tower is profile 0 — it has no windows, it has a LIGHTING RIG, and that rig is its
// identity. Four channels carry it, all of them emissive >= EMITTER_MIN so nothing here can be
// mistaken for a facade window hint: cast-concrete shaft, an LED wash climbing the three ribs,
// the two glazing bands at the pod and the SkyPod, and red aviation beacons up the mast.
const CN_MAST_Y = 448.0;

function emitCNTower(mbOpaque, mbGlass, mbProps, cx, cz, baseY) {
  const seg = 14;
  const cu = cx, cv = -cz;
  let mast = false;
  setMat(mbOpaque, M.cnShaft);
  for (let i = 0; i + 1 < CN_PROFILE.length; i++) {
    const a = CN_PROFILE[i], b = CN_PROFILE[i + 1];
    if (!mast && a[0] >= CN_MAST_Y) { mast = true; setMat(mbOpaque, M.cnMast); }
    const ra = ringPts(cu, cv, Math.max(0.05, a[1]), seg, 0);
    const rb = ringPts(cu, cv, Math.max(0.05, b[1]), seg, 0);
    emitPrism(mbOpaque, ra, rb, baseY + a[0], baseY + b[0], i + 2 === CN_PROFILE.length);
  }
  // Three structural ribs give the Y cross-section its silhouette — and they are what the LED
  // wash actually lights, so they double as the accent lines running up the shaft.
  setMat(mbOpaque, M.cnLed);
  const ribSteps = [[0, 30.0, 9.0, 7.5], [46, 17.2, 6.0, 5.0], [180, 12.2, 4.2, 3.4],
    [300, 10.3, 3.2, 2.6], [330, 9.7, 2.6, 2.2]];
  for (let r = 0; r < 3; r++) {
    const ang = (r / 3) * Math.PI * 2 + Math.PI / 6;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let s = 0; s + 1 < ribSteps.length; s++) {
      const a = ribSteps[s], b = ribSteps[s + 1];
      const quad = (rad, out, half) => {
        const bu = cu + ca * rad, bv = cv + sa * rad;
        const ou = ca * out, ov = sa * out;
        const hu = -sa * half, hv = ca * half;
        return [bu - hu, bv - hv, bu + ou - hu * 0.55, bv + ov - hv * 0.55,
          bu + ou + hu * 0.55, bv + ov + hv * 0.55, bu + hu, bv + hv];
      };
      emitPrism(mbOpaque, quad(a[1] * 0.55, a[2], a[3]), quad(b[1] * 0.55, b[2], b[3]),
        baseY + a[0], baseY + b[0], false);
    }
  }
  // Pod glazing: the lit bands that make the tower read at blue hour. Cool white-blue, not the
  // office amber every other window in the old build wore.
  setMat(mbGlass, M.cnPod);
  emitPrism(mbGlass, ringPts(cu, cv, 27.6, seg * 2, 0), ringPts(cu, cv, 27.6, seg * 2, 0),
    baseY + 346.5, baseY + 355.5, false);
  setMat(mbGlass, M.cnSky);
  emitPrism(mbGlass, ringPts(cu, cv, 12.4, seg, 0), ringPts(cu, cv, 12.4, seg, 0),
    baseY + 437.0, baseY + 442.0, false);
  // Aviation beacons up the mast (kept inside the 553.33 m tip).
  setMat(mbProps, M.beacon);
  const beacons = [370, 447, 498, 540];
  for (let i = 0; i < beacons.length; i++) mbProps.sphere(cx, baseY + beacons[i], cz, 1.1, 4);
}

/* ======================================================= spatial indexing == */

function makeGridIndex(cellSize, x0, z0, nx, nz) {
  const cells = new Array(nx * nz);
  return {
    cellSize, x0, z0, nx, nz, cells,
    ci(x) { return clamp(Math.floor((x - x0) / cellSize), 0, nx - 1); },
    cj(z) { return clamp(Math.floor((z - z0) / cellSize), 0, nz - 1); },
    add(bx0, bz0, bx1, bz1, item) {
      const i0 = this.ci(bx0), i1 = this.ci(bx1);
      const j0 = this.cj(bz0), j1 = this.cj(bz1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          let a = cells[k];
          if (!a) { a = []; cells[k] = a; }
          a.push(item);
        }
      }
    },
    query(x, z, r, visit) {
      const i0 = this.ci(x - r), i1 = this.ci(x + r);
      const j0 = this.cj(z - r), j1 = this.cj(z + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let n = 0; n < a.length; n++) if (visit(a[n]) === false) return;
        }
      }
    },
    // Same, addressed by a box. A 200 m wall queried as a disc round its midpoint sweeps a
    // hundred metres of city that cannot possibly touch it; the box is the shape the item is.
    queryBox(bx0, bz0, bx1, bz1, visit) {
      const i0 = this.ci(bx0), i1 = this.ci(bx1);
      const j0 = this.cj(bz0), j1 = this.cj(bz1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let n = 0; n < a.length; n++) if (visit(a[n]) === false) return;
        }
      }
    },
  };
}

// Closest point on a plan ring to (px,pv); returns squared distance and the point.
const _cp = { d2: 0, x: 0, y: 0 };
function closestOnRing(co, px, pv) {
  let bd = Infinity, bx = px, by = pv;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const ax = co[j], ay = co[j + 1], cx = co[i], cy = co[i + 1];
    const dx = cx - ax, dy = cy - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > EPS) t = clamp(((px - ax) * dx + (pv - ay) * dy) / l2, 0, 1);
    const qx = ax + dx * t, qy = ay + dy * t;
    const ex = px - qx, ey = pv - qy;
    const d2 = ex * ex + ey * ey;
    if (d2 < bd) { bd = d2; bx = qx; by = qy; }
  }
  _cp.d2 = bd; _cp.x = bx; _cp.y = by;
  return _cp;
}

function partContains(part, px, pv) {
  const b = part.bbox;
  if (px < b[0] || px > b[2] || pv < b[1] || pv > b[3]) return false;
  if (!planContains(part.outer, px, pv)) return false;
  for (let i = 0; i < part.holes.length; i++) if (planContains(part.holes[i], px, pv)) return false;
  return true;
}

/* ============================================ coplanar face resolution == */
/**
 * THE OTHER HALF OF THE DAYTIME FLICKER.
 *
 * A depth buffer cannot order two surfaces that occupy the same plane and face the same way; it
 * picks a winner per pixel per frame from whatever the interpolator happened to round to, and the
 * result is the shimmer you see across a whole facade as the camera moves. No amount of depth
 * precision fixes it, because the two surfaces are not near each other — they ARE each other.
 *
 * The massing extract is full of them by construction. A real building is often recorded as
 * several stacked slabs (CONTRACT section 1: "Some footprints are stacked massing slabs for one
 * real building. Do not merge them"), and each slab carries its own COMPLETE ring, so wherever two
 * slabs share a boundary both records extrude the same wall over the height they have in common.
 * Measured on this extract: 6,261 wall faces are the same surface as another record's, 44 km of
 * duplicated wall across 1,371 records.
 *
 * What is NOT a fight, and must not be "fixed": two neighbours sharing a party wall. Their rings
 * run in opposite directions along the shared line, so the two faces are back to back — each is a
 * back face from the other one's side and culling already resolves them. Only walls that face the
 * SAME way are a fight, which is what the co-orientation test below is for. Roughly two thirds of
 * all coincident wall pairs in the extract are party walls and are deliberately left alone.
 *
 * The resolution is suppression, not displacement. Nudging one wall inward opens a slot at the
 * corner where its neighbours still meet the original plane, and back-face culling turns that slot
 * into a view straight through the building. Instead the loser stops where the winner starts:
 *
 *   winner  = the record whose wall reaches HIGHER (ties broken by edge order, so it is total and
 *             stable — a rule that is not total leaves a pair unresolved, or resolves it both
 *             ways and deletes the wall entirely)
 *   loser   = keeps only the band BELOW the winner's base, over exactly the length they share
 *
 * Because the loser's top is always inside the winner's band, the survivor is always a single
 * interval [y0, cut] — there is never a hole in the middle of a wall — and the two together still
 * cover every square metre the pair used to. Where the loser is completely covered it emits
 * nothing, which is why this pass costs fewer vertices than it saves.
 */

// One wall face waiting to be emitted: a plan-space edge (au, av) -> (bu, bv) extruded y0..y1.
// `cuts` is a flat [t0, t1, top, ...] list — over the run t0..t1 metres along the edge, this wall
// stops at `top` because somebody else owns the surface above it.
function makeWallEdge(k, r, au, av, bu, bv, len, y0, y1) {
  return {
    k, r, au, av, bu, bv, len, uu: (bu - au) / len, uv: (bv - av) / len, y0, y1,
    cuts: null, holes: null,
  };
}

function addWallRing(list, all, idx, r, co, y0, y1) {
  const n = co.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const au = co[j], av = co[j + 1], bu = co[i], bv = co[i + 1];
    const du = bu - au, dv = bv - av;
    const len = Math.sqrt(du * du + dv * dv);
    if (!(len > 1e-4)) continue;
    const e = makeWallEdge(all.length, r, au, av, bu, bv, len, y0, y1);
    all.push(e);
    list.push(e);
    idx.add(Math.min(au, bu) - WALL_TOL, Math.min(av, bv) - WALL_TOL,
      Math.max(au, bu) + WALL_TOL, Math.max(av, bv) + WALL_TOL, e);
  }
}

// Do these two wall faces occupy the same plane, facing the same way, over a run worth resolving?
// Fills _wp with the shared band and returns its length, or 0.
const _wp = { ta: 0, tb: 0, sa: 0, sb: 0 };

function wallsCoincide(e, f) {
  // Same facing first: it is one dot product and it rejects every party wall in the city.
  if (e.uu * f.uu + e.uv * f.uv <= 0.966) return 0;          // more than 15 degrees apart
  const nu = -e.uv, nv = e.uu;
  const d1 = (f.au - e.au) * nu + (f.av - e.av) * nv;
  const d2 = (f.bu - e.au) * nu + (f.bv - e.av) * nv;
  if (Math.abs(d1) > WALL_TOL || Math.abs(d2) > WALL_TOL) return 0;
  const t1 = (f.au - e.au) * e.uu + (f.av - e.av) * e.uv;
  const t2 = (f.bu - e.au) * e.uu + (f.bv - e.av) * e.uv;
  const ta = Math.max(0, Math.min(t1, t2));
  const tb = Math.min(e.len, Math.max(t1, t2));
  if (tb - ta < WALL_MIN_OVERLAP) return 0;
  const s1 = (e.au - f.au) * f.uu + (e.av - f.av) * f.uv;
  const s2 = (e.bu - f.au) * f.uu + (e.bv - f.av) * f.uv;
  _wp.ta = ta; _wp.tb = tb;
  _wp.sa = Math.max(0, Math.min(s1, s2));
  _wp.sb = Math.min(f.len, Math.max(s1, s2));
  return tb - ta;
}

// Every candidate pair, once. `visit(e, f, run)` is called with the shared run in _wp.
function scanWallPairs(all, idx, visit) {
  for (let k = 0; k < all.length; k++) {
    const e = all[k];
    const x0 = Math.min(e.au, e.bu) - WALL_TOL, x1 = Math.max(e.au, e.bu) + WALL_TOL;
    const v0 = Math.min(e.av, e.bv) - WALL_TOL, v1 = Math.max(e.av, e.bv) + WALL_TOL;
    idx.queryBox(x0, v0, x1, v1, (f) => {
      if (f.k <= k) return;
      if (Math.min(e.y1, f.y1) - Math.max(e.y0, f.y0) <= WALL_MIN_BAND) return;
      const run = wallsCoincide(e, f);
      if (run > 0) visit(e, f, run);
    });
  }
}

// The height a wall face still reaches at `t` metres along it, after every cut that covers it.
function wallTopAt(e, t) {
  let top = e.y1;
  const c = e.cuts;
  if (!c) return top;
  for (let i = 0; i < c.length; i += 3) {
    if (t >= c[i] && t <= c[i + 1] && c[i + 2] < top) top = c[i + 2];
  }
  return top;
}

// ...and where its foot starts, after every portal punched through it. The wall above a portal is
// the lintel and stays; everything from the corridor floor to the head of the opening goes.
function wallBaseAt(e, t) {
  let base = e.y0;
  const h = e.holes;
  if (!h) return base;
  for (let i = 0; i < h.length; i += 3) {
    if (t >= h[i] && t <= h[i + 1] && h[i + 2] > base) base = h[i + 2];
  }
  return base;
}

/**
 * Find every duplicated wall face and cut the loser back. Returns the audit.
 * @param {object[]} records prepped buildings, `parts` already built
 */
function resolveCoplanarWalls(records, extent, stats) {
  const cell = 10.0;
  const u0 = -extent.x / 2 - 400, v0 = -extent.z / 2 - 400;
  const idx = makeGridIndex(cell, u0, v0,
    Math.ceil((extent.x + 800) / cell) + 1, Math.ceil((extent.z + 800) / cell) + 1);
  const all = [];
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.landmark === 'cn') continue;
    const y0 = b.y - WALL_SINK, y1 = b.y + b.h;
    const list = [];
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      addWallRing(list, all, idx, r, part.outer, y0, y1);
      for (let h = 0; h < part.holes.length; h++) addWallRing(list, all, idx, r, part.holes[h], y0, y1);
    }
    b.walls = list;
  }

  const A = stats.coplanar;
  A.wallFaces = all.length;
  scanWallPairs(all, idx, (e, f, run) => {
    A.wallPairs++;
    A.wallMetres += run;
    // Total, stable order: the higher wall keeps the surface, ties go to the earlier edge.
    const eWins = e.y1 > f.y1 || (e.y1 === f.y1 && e.k < f.k);
    const L = eWins ? f : e;
    const W = eWins ? e : f;
    const cut = Math.max(L.y0, W.y0);
    const ta = eWins ? _wp.sa : _wp.ta;
    const tb = eWins ? _wp.sb : _wp.tb;
    if (!L.cuts) L.cuts = [];
    L.cuts.push(ta, tb, cut);
  });

  // Re-audit against what will actually be emitted rather than trusting the rule above. Any pair
  // whose two survivors still share a band is a fight that got through, and must be zero.
  scanWallPairs(all, idx, (e, f) => {
    const t = (_wp.ta + _wp.tb) * 0.5;
    const s = (_wp.sa + _wp.sb) * 0.5;
    const eTop = wallTopAt(e, t);
    const fTop = wallTopAt(f, s);
    const lo = Math.max(e.y0, f.y0);
    const hi = Math.min(eTop, fTop);
    if (hi - lo > WALL_MIN_BAND) A.wallPairsLeft++;
  });
  return A;
}

// One wall quad between two stations along an edge. Winding follows the ring order, so a plan-CCW
// outer ring faces outward and a plan-CW hole ring faces into the void — which is what back-face
// culling wants from each of them.
function wallQuad(mb, e, a, b, y0, y1) {
  const ia = a / e.len, ib = b / e.len;
  const ax = e.au + (e.bu - e.au) * ia, az = -(e.av + (e.bv - e.av) * ia);
  const bx = e.au + (e.bu - e.au) * ib, bz = -(e.av + (e.bv - e.av) * ib);
  mb.tri(ax, y0, az, bx, y0, bz, bx, y1, bz);
  mb.tri(ax, y0, az, bx, y1, bz, ax, y1, az);
}

// Emit one wall face as the runs that survived. Uncut faces — the overwhelming majority — take the
// fast path and cost exactly what a straight extrusion of the ring used to.
const _wbp = [];

function emitWallFace(mb, e, stats) {
  if (!e.cuts && !e.holes) { wallQuad(mb, e, 0, e.len, e.y0, e.y1); return; }
  const cuts = e.cuts;
  const holes = e.holes;
  const bp = _wbp;
  bp.length = 0;
  bp.push(0, e.len);
  if (cuts) {
    for (let i = 0; i < cuts.length; i += 3) {
      const a = clamp(cuts[i], 0, e.len), b = clamp(cuts[i + 1], 0, e.len);
      if (b - a > 1e-4) bp.push(a, b);
    }
  }
  if (holes) {
    for (let i = 0; i < holes.length; i += 3) {
      const a = clamp(holes[i], 0, e.len), b = clamp(holes[i + 1], 0, e.len);
      if (b - a > 1e-4) bp.push(a, b);
    }
  }
  bp.sort((p, q) => p - q);
  for (let k = 0; k + 1 < bp.length; k++) {
    const a = bp[k], b = bp[k + 1];
    // No minimum slice width beyond a float epsilon. A 2 cm strip of wall dropped between two
    // cuts is a 2 cm slot straight through the building, and back-face culling makes a slot a
    // window onto whatever is behind it; six vertices are cheaper than that.
    if (b - a < 1e-4) continue;
    const mid = (a + b) * 0.5;
    const top = wallTopAt(e, mid);
    const base = wallBaseAt(e, mid);
    if (top - base < WALL_MIN_BAND) { stats.coplanar.wallFacesDropped++; continue; }
    if (top < e.y1 - 1e-6) stats.coplanar.wallFacesClipped++;
    wallQuad(mb, e, a, b, base, top);
  }
}

/**
 * CONTRACT 8.1 — "roads that pass under a rail corridor, an expressway or a building must be
 * MODELLED, not deleted". Modelling the road is only half of it: the structure ON TOP has to let
 * it through.
 *
 * York and Bay Streets dive under Union Station into the teamways, and a further 1.6 km of
 * building passages walk straight through the base of a tower. The massing knows nothing about any
 * of that, so its perimeter wall stands square across the carriageway and the underpass — which IS
 * built, and which the ground correctly dips into — dead-ends in a blank facade a pedestrian
 * cannot pass. That is the "roads just cut off" in the report, and this is where it is opened.
 *
 * Wherever a corridor or a passage CROSSES a wall face, the wall goes from its foot up to the head
 * the corridor needs, and the building stands on the lintel that is left. The head is the same
 * number `emitTrench` gives the soffit, so wall and ceiling meet on one line with no seam.
 *
 * Only a crossing wall opens. A building that merely lines a depressed street runs PARALLEL to it
 * with its facade at the back of the pavement — inside the corridor's outer envelope — and would
 * otherwise have its whole ground floor cut away; the direction test and the narrower carriageway
 * envelope are what keep it shut.
 */
const PORTAL_MIN_RUN = 1.2;        // a shorter crossing than this is a corner nick, not a doorway
const PORTAL_AXIS_MAX = 0.75;      // |cos| between wall and corridor: above this they are parallel

function punchCorridorPortals(records, grade, terrainY, stats) {
  if (!grade || typeof grade.span !== 'function') return;
  const G = stats.grade;
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b || !b.walls) continue;
    for (let w = 0; w < b.walls.length; w++) {
      const e = b.walls[w];
      const steps = Math.max(2, Math.min(64, Math.ceil(e.len / 1.0)));
      const dt = e.len / steps;
      let runA = -1, runB = -1, runHead = 0;
      for (let s = 0; s <= steps; s++) {
        const t = s * dt;
        const x = e.au + e.uu * t;
        const z = -(e.av + e.uv * t);
        const sp = grade.span(x, z);
        let head = 0;
        if (sp && sp.d2 <= sp.chw * sp.chw) {
          // World direction of the wall is (uu, -uv); v is -z.
          const dot = Math.abs(e.uu * sp.dx - e.uv * sp.dz);
          if (dot < PORTAL_AXIS_MAX) {
            const floorY = terrainY(x, z) - sp.dep;
            head = floorY + (sp.pass ? PASSAGE_HEAD : UNDER_CLEAR);
          }
        }
        if (head > 0) {
          if (runA < 0) { runA = t; runHead = head; }
          runB = t;
          if (head > runHead) runHead = head;
          if (s < steps) continue;
        }
        if (runA >= 0) {
          const a = clamp(runA - dt * 0.5, 0, e.len);
          const bb = clamp(runB + dt * 0.5, 0, e.len);
          if (bb - a >= PORTAL_MIN_RUN && runHead > e.y0 + WALL_MIN_BAND) {
            (e.holes || (e.holes = [])).push(a, bb, runHead);
            G.wallPortals++;
            G.wallPortalMetres += bb - a;
          }
          runA = -1; runB = -1; runHead = 0;
        }
      }
    }
  }
}

/**
 * Is every point of `part` inside record `o`? Tested at the ring's vertices AND its edge
 * midpoints, which is what catches a footprint that pokes out through the middle of a long edge.
 */
function partInsideRecord(o, part) {
  const co = part.outer;
  const n = co.length;
  const inside = (u, v) => {
    for (let p = 0; p < o.parts.length; p++) if (partContains(o.parts[p], u, v)) return true;
    return false;
  };
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    if (!inside(co[j], co[j + 1])) return false;
    // Walk the edge as well as its ends. A verdict of "buried" DELETES geometry, so a footprint
    // that bows out through the middle of a long edge has to be caught: sample every couple of
    // metres, capped so one 300 m stadium edge cannot dominate the pass.
    const du = co[i] - co[j], dv = co[i + 1] - co[j + 1];
    const len = Math.sqrt(du * du + dv * dv);
    const steps = Math.min(24, Math.max(1, Math.round(len / 2.0)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (!inside(co[j] + du * t, co[j + 1] + dv * t)) return false;
    }
  }
  return true;
}

// Do two footprint parts share any ground? Bounding boxes first, then vertices and centroids of
// each against the other — which is every overlap the massing data actually produces, because a
// footprint is a building outline and not a pinwheel.
function partsOverlap(a, b) {
  const ab = a.bbox, bb = b.bbox;
  if (ab[0] > bb[2] || ab[2] < bb[0] || ab[1] > bb[3] || ab[3] < bb[1]) return false;
  if (partContains(b, (ab[0] + ab[2]) * 0.5, (ab[1] + ab[3]) * 0.5)) return true;
  if (partContains(a, (bb[0] + bb[2]) * 0.5, (bb[1] + bb[3]) * 0.5)) return true;
  const ca = a.outer, cb = b.outer;
  for (let i = 0; i < ca.length; i += 2) if (partContains(b, ca[i], ca[i + 1])) return true;
  for (let i = 0; i < cb.length; i += 2) if (partContains(a, cb[i], cb[i + 1])) return true;
  return false;
}

// A total order over roof caps sharing a plane: the bigger footprint keeps the surface, the record
// key breaks a tie, the part index breaks that. Total matters — a rule with ties either leaves a
// pair unresolved or drops both caps.
function capOutranks(o, oi, b, bi) {
  const oa = o.parts[oi].capArea, ba = b.parts[bi].capArea;
  if (oa !== ba) return oa > ba;
  if (o.key !== b.key) return o.key < b.key;
  return oi < bi;
}

/**
 * Roof caps. A cap is a horizontal face, so its fight is with another cap at the same height —
 * and its other failure is simply being INSIDE something taller, where it costs vertices to draw
 * a roof nobody can see.
 *
 * Two answers, because there are two shapes of problem:
 *   * a cap wholly inside a record that reaches above it is DELETED. Where every part of a record
 *     is wholly inside a neighbour that also starts at or below it, the record is dropped whole —
 *     walls, cap, beacon, ground floor and rooftop plant, all of which were previously being
 *     built inside somebody else's tower.
 *   * two caps on the same plane that merely OVERLAP cannot be resolved by deletion without
 *     clipping one polygon against the other, so the loser STEPS DOWN instead. A roof 6 cm below
 *     its own wall head is a parapet; two roofs at the same height are a fight.
 *
 * The step has to be a chain depth, not a neighbour count. Where A beats B and B beats C but A
 * and C never touch, counting neighbours puts B and C on the same step and hands the fight
 * straight back; taking each cap's level as one more than the deepest cap that beats it and
 * overlaps it cannot. Ranking is a total order, so processing the caps in it visits every
 * dominator before its dependant and one sweep is enough.
 */
function resolveCoplanarCaps(records, bIndex, stats) {
  const A = stats.coplanar;
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts) continue;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      part.capArea = Math.abs(planArea(part.outer));
      part.capBuried = false;
      part.capDrop = 0;
      part.capLevel = -1;
    }
  }

  /* --- burial ------------------------------------------------------------ */
  const live = [];
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.landmark === 'cn') continue;
    const top = b.y + b.h;
    const base = b.y - WALL_SINK;
    let allBuried = true;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      const bb = part.bbox;
      const qx = (bb[0] + bb[2]) * 0.5, qz = -(bb[1] + bb[3]) * 0.5;
      const qr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1;
      let buried = false, whole = false;
      bIndex.query(qx, qz, qr, (o) => {
        if (buried || o === b || !o.parts || o.landmark === 'cn') return;
        const oTop = o.y + o.h;
        const oBase = o.y - WALL_SINK;
        if (oTop > top + CAP_PLANE_TOL) {
          if (oBase > top || !partInsideRecord(o, part)) return;
          buried = true;
          if (oBase <= base + 0.05) whole = true;
          return;
        }
        if (oTop < top - CAP_PLANE_TOL) return;
        for (let q = 0; q < o.parts.length; q++) {
          if (capOutranks(o, q, b, p) && partInsideRecord(o, part)) { buried = true; return; }
        }
      });
      part.capBuried = buried;
      if (buried) {
        A.capsBuried++;
        if (!whole) allBuried = false;
      } else {
        allBuried = false;
        live.push(b, p);
      }
    }
    b.buried = allBuried;
    if (allBuried) A.buriedRecords++;
  }

  /* --- step-down --------------------------------------------------------- */
  // Sorted into the ranking order, so every cap that can dominate this one already has a level.
  const order = [];
  for (let i = 0; i < live.length; i += 2) {
    if (!live[i].buried) order.push(i);
  }
  order.sort((ia, ib) => {
    const a = live[ia], ap = live[ia + 1];
    const b = live[ib], bp = live[ib + 1];
    return capOutranks(a, ap, b, bp) ? -1 : 1;
  });
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const b = live[i], p = live[i + 1];
    const part = b.parts[p];
    const top = b.y + b.h;
    const bb = part.bbox;
    const qx = (bb[0] + bb[2]) * 0.5, qz = -(bb[1] + bb[3]) * 0.5;
    const qr = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1;
    // Take the first step that is genuinely clear of every cap already placed, tested against the
    // heights they were actually placed at. Counting dominators is not enough: a cap stepping out
    // of ITS plane can land on a neighbouring one, which is exactly the case a chain depth misses.
    let lvl = 0;
    while (lvl <= CAP_MAX_STEP) {
      const y = top - lvl * CAP_STEP;
      let clash = false;
      bIndex.query(qx, qz, qr, (o) => {
        if (clash || o === b || !o.parts || o.buried || o.landmark === 'cn') return;
        for (let q = 0; q < o.parts.length; q++) {
          const other = o.parts[q];
          if (other.capBuried || other.capLevel < 0) continue;
          if (Math.abs((o.y + o.h - other.capDrop) - y) >= CAP_MIN_SEP) continue;
          if (partsOverlap(other, part)) { clash = true; return false; }
        }
      });
      if (!clash) break;
      lvl++;
    }
    if (lvl > CAP_MAX_STEP) { lvl = CAP_MAX_STEP; A.capDropsClamped++; }
    part.capLevel = lvl;
    if (lvl > 0) { part.capDrop = lvl * CAP_STEP; A.capsStepped++; }
  }

  /* --- re-audit ---------------------------------------------------------- */
  // Any two caps still left within CAP_MIN_SEP of each other with overlapping footprints.
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    if (!b.parts || b.buried || b.landmark === 'cn') continue;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (part.capBuried) continue;
      const top = b.y + b.h - part.capDrop;
      const bb = part.bbox;
      bIndex.query((bb[0] + bb[2]) * 0.5, -(bb[1] + bb[3]) * 0.5,
        Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 1, (o) => {
          if (o === b || !o.parts || o.buried || o.key <= b.key || o.landmark === 'cn') return;
          for (let q = 0; q < o.parts.length; q++) {
            const other = o.parts[q];
            if (other.capBuried) continue;
            if (Math.abs((o.y + o.h - other.capDrop) - top) >= CAP_MIN_SEP) continue;
            if (partsOverlap(other, part)) { A.capPairsLeft++; return false; }
          }
        });
    }
  }
}

/* ========================================== street detail: shared context == */
//
// CONTRACT §6.3. Everything below — paint, kerbs, walkways, track, furniture, vehicles, facades
// and roofscape — reads one context object: the terrain sampler, the merged mesh builders, one
// seeded rng, the building broadphase, a carriageway segment index and an occupancy grid. Passing
// it explicitly keeps these routines at module scope instead of turning loadCity() into a single
// enormous closure, and it guarantees every one of them agrees on where the ground is.
//
// TIME OF DAY (Amendment 7). Nothing here bakes light. Every surface emitted below carries an
// albedo and a roughness and nothing else — no pre-darkened undersides, no "night" tints, no glow
// decals. The only emissive values in the whole pass come out of props.js and facades.js, on real
// lamps, real signals and real lit interiors, and the renderer alone decides when they are on.

// Squared distance from (px, pz) to segment a-b.
function distToSeg2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > EPS) t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

// Emit a near-horizontal triangle wound so its normal points UP, whatever order the caller gave.
// Plan space is (u, v) = (x, -z), so the plan signed area IS the winding test. Getting this wrong
// on a road marking makes the paint vanish under back-face culling from the one angle you drive
// at it from, which is exactly the bug you never see in a screenshot.
function triUp(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const s = (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
  if (s >= 0) mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  else mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
}

/**
 * A disc-occupancy grid. A dozen independent generators walk the same kerb line, so without this
 * a bench, a bin and a tree all land on the same square metre.
 */
function makeOccupancy(cell, x0, z0, nx, nz) {
  const cells = new Array(nx * nz);
  let maxR = 1.0;
  const ci = (v) => clamp(Math.floor((v - x0) / cell), 0, nx - 1);
  const cj = (v) => clamp(Math.floor((v - z0) / cell), 0, nz - 1);
  return {
    // Reserve a disc, or return false and reserve nothing.
    claim(x, z, r) {
      const pad = r + maxR;
      const i0 = ci(x - pad), i1 = ci(x + pad);
      const j0 = cj(z - pad), j1 = cj(z + pad);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let k = 0; k < a.length; k += 3) {
            const dx = x - a[k], dz = z - a[k + 1];
            const rr = r + a[k + 2];
            if (dx * dx + dz * dz < rr * rr) return false;
          }
        }
      }
      const k = cj(z) * nx + ci(x);
      let a = cells[k];
      if (!a) { a = []; cells[k] = a; }
      a.push(x, z, r);
      if (r > maxR) maxR = r;
      return true;
    },
  };
}

// Is (x, z) inside — or within `margin` of — any building footprint?
function inFootprint(C, x, z, margin) {
  const m = margin > 0 ? margin : 0;
  const pv = -z;
  let hit = false;
  C.bIndex.query(x, z, m, (b) => {
    if (hit || !b.parts) return;
    if (x < b.bbox[0] - m || x > b.bbox[2] + m || z < b.bbox[1] - m || z > b.bbox[3] + m) return;
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (partContains(part, x, pv)) { hit = true; return false; }
      if (m > 0 && closestOnRing(part.outer, x, pv).d2 < m * m) { hit = true; return false; }
    }
  });
  return hit;
}

// How deep inside a footprint (x, z) is, in metres; 0 outside. Used to drop the OSM footways that
// run straight through a tower without also dropping the ones that legitimately clip an arcade.
function footprintDepth(C, x, z) {
  const pv = -z;
  let best = 0;
  C.bIndex.query(x, z, 0.25, (b) => {
    if (!b.parts) return;
    if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
    for (let p = 0; p < b.parts.length; p++) {
      if (!partContains(b.parts[p], x, pv)) continue;
      const d = Math.sqrt(closestOnRing(b.parts[p].outer, x, pv).d2);
      if (d > best) best = d;
    }
  });
  return best;
}

// The building record whose footprint covers (x, z), or null. Used to decide where a corridor has
// a ceiling over it rather than the sky.
function coveringRecord(C, x, z) {
  const pv = -z;
  let found = null;
  C.bIndex.query(x, z, 0.25, (b) => {
    if (found || !b.parts) return;
    if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
    for (let p = 0; p < b.parts.length; p++) {
      if (partContains(b.parts[p], x, pv)) { found = b; return false; }
    }
  });
  return found;
}

// Carriageway index entry:
//   [ax, az, bx, bz, halfWidth, crowned, coverRadius, recordId, pavementRadius]
// Segments are filed under their bbox already grown by coverRadius, so a small query radius still
// finds a wide road.
function onCarriageway(C, x, z, pad) {
  let hit = false;
  C.roadIdx.query(x, z, pad, (s) => {
    if (hit) return false;
    const lim = s[4] + pad;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < lim * lim) { hit = true; return false; }
  });
  return hit;
}

// As above, but blind to one road — for asking "does MY pavement run out over somebody else's
// street", where the answer must not be yes just because my own kerb line is near my own kerb.
function onForeignCarriageway(C, x, z, pad, selfId) {
  let hit = false;
  C.roadIdx.query(x, z, pad, (s) => {
    if (hit) return false;
    if (s[7] === selfId) return;
    const lim = s[4] + pad;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < lim * lim) { hit = true; return false; }
  });
  return hit;
}

/**
 * Is this point already claimed by the pavement of a road that outranks `rec`?
 *
 * At every corner in the city two roads' pavement bands cover the same quadrant, at the same
 * height, in the same material — coincident surfaces the depth buffer resolves differently every
 * frame. One of them has to yield, and the order has to be total and stable or a corner ends up
 * with no pavement at all: the wider road wins, and the lower record id breaks a tie.
 */
function pavementTaken(C, x, z, rec) {
  let hit = false;
  C.roadIdx.query(x, z, 0, (s) => {
    if (hit) return false;
    const band = s[8];
    if (!(band > 0) || s[7] === rec.id) return;
    if (s[4] < rec.hw || (s[4] === rec.hw && s[7] > rec.id)) return;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < band * band) { hit = true; return false; }
  });
  return hit;
}

/**
 * Is there pavement at (x, z)? True where some road's band covers the point and no carriageway
 * does — which is exactly the geometry emitSidewalkBands() lays down, the rank rule only deciding
 * WHICH road paves an overlap, never whether it is paved. Kerb-level props are seated with this:
 * a lamp post where the band was cut away has to stand on the road, not on 16 cm of air.
 */
function onPavement(C, x, z) {
  if (onCarriageway(C, x, z, 0)) return false;
  let hit = false;
  C.roadIdx.query(x, z, 0, (s) => {
    if (hit) return false;
    const band = s[8];
    if (!(band > 0)) return;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < band * band) { hit = true; return false; }
  });
  return hit;
}

// Terrain-relative height for a prop that belongs on the pavement.
function kerbSeat(C, x, z) {
  return onPavement(C, x, z) ? ROAD_Y + CURB : ROAD_Y;
}

/**
 * The height of the HIGHEST carriageway covering (x, z), or -Infinity off the road network.
 *
 * Two streets crossing each other overlap for a whole junction box, and each ribbon crowns
 * independently, so paint laid MARK_LIFT above its own road can still sit several centimetres
 * under the crown of the road it crosses — which is exactly where the crossings and stop bars go.
 * Reconstructed from the index rather than from the ribbon, so it is an estimate: it samples the
 * terrain at the point instead of interpolating the ribbon's edges, which on this terrain differs
 * by about a centimetre. MARK_LIFT is twice that.
 */
function carriagewayTopY(C, x, z) {
  let out = -Infinity;
  C.roadIdx.query(x, z, 0.4, (s) => {
    const hw = s[4];
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) > hw * hw) return;
    let dx = s[2] - s[0], dz = s[3] - s[1];
    const l = Math.hypot(dx, dz);
    if (!(l > EPS)) return;
    dx /= l; dz /= l;
    const ux = -dz, uz = dx;                       // the crossing road's own side vector
    const o = clamp((x - s[0]) * ux + (z - s[1]) * uz, -hw, hw);
    const cx = x - ux * o, cz = z - uz * o;        // back on its centreline, same station
    // Rebuild the cross-section emitRibbon() laid: heights sampled at the ribbon's EDGES and
    // interpolated across, not the terrain read off at the point. Over a wide street on a slope
    // those differ by decimetres, which is ten times the lift the paint has to play with.
    // A depressed carriageway reads its own profile, exactly as its ribbon was laid: over a lid
    // the ground plane and the roadway under it are metres apart, and paint belongs to the road.
    const cor = s[9];
    const base = cor
      ? (bx, bz) => C.terrainY(bx, bz) - corridorDepth(cor, bx, bz)
      : C.groundY;
    let y;
    if (s[5]) {
      const sgn = o < 0 ? -1 : 1;
      const yMid = base(cx, cz) + ROAD_Y + CROWN;
      const yEdge = base(cx + ux * hw * sgn, cz + uz * hw * sgn) + ROAD_Y;
      y = yMid + (yEdge - yMid) * (Math.abs(o) / Math.max(hw, EPS));
    } else {
      const yn = base(cx - ux * hw, cz - uz * hw) + ROAD_Y;
      const yp = base(cx + ux * hw, cz + uz * hw) + ROAD_Y;
      y = yn + (yp - yn) * clamp((o + hw) / (2 * hw), 0, 1);
    }
    if (y > out) out = y;
  });
  return out;
}

// True where a synthetic sidewalk ribbon — or the carriageway itself — already covers this point,
// so a real OSM footway laid here would z-fight what is already on the ground.
function alreadyPaved(C, x, z) {
  let hit = false;
  C.roadIdx.query(x, z, 0.5, (s) => {
    if (hit) return false;
    if (distToSeg2(x, z, s[0], s[1], s[2], s[3]) < s[6] * s[6]) { hit = true; return false; }
  });
  return hit;
}

// The crown height of the carriageway at (x, z), or -1 when it is not on one. This is what lets
// embedded tram rail sit IN the asphalt rather than hovering over the crest of a crowned street.
function carriagewayCrown(C, x, z) {
  let best = -1, out = -1;
  C.roadIdx.query(x, z, 0.4, (s) => {
    const hw = s[4];
    if (hw <= best) return;
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 > hw * hw) return;
    best = hw;
    out = s[5] ? CROWN * (1 - Math.sqrt(d2) / Math.max(hw, EPS)) : 0;
  });
  return out;
}

// Distance to the nearest carriageway centreline, or Infinity beyond `maxR`.
function nearestRoad(C, x, z, maxR) {
  let best = maxR * maxR;
  C.roadIdx.query(x, z, maxR, (s) => {
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 < best) best = d2;
  });
  return best < maxR * maxR ? Math.sqrt(best) : Infinity;
}

/**
 * Reserve a ground-level prop site. Nothing may land inside a building footprint, on a
 * carriageway (pass roadPad < 0 for the parked cars, median poles and gutter hardware that
 * legitimately do), on top of another prop, or UNDER AN ELEVATED DECK it does not fit beneath.
 *
 * `height` is how far the prop stands above its seat; omit it and the class's entry in PROP_H is
 * used. That default is what makes the deck rule apply to the whole city rather than to the lamps
 * somebody remembered — a 7 m street tree planted under the Gardiner is the same bug as a mast.
 * @returns {number} the terrain height at the site, or NaN when the site is refused
 */
function reserve(C, kind, x, z, r, roadPad, height) {
  if (!isNum(x) || !isNum(z)) return NaN;
  if (inFootprint(C, x, z, r * 0.55 + 0.30)) return NaN;
  if (roadPad >= 0 && onCarriageway(C, x, z, roadPad)) return NaN;
  const h = isNum(height) ? height : (PROP_H[kind] || 0);
  if (h > 0 && deckHeadroom(C, x, z) < h + DECK_CLEAR) {
    C.stats.deck.propsSkipped++;
    return NaN;
  }
  if (!C.occ.claim(x, z, r)) return NaN;
  C.stats.props[kind] = (C.stats.props[kind] || 0) + 1;
  if (roadPad >= 0) C.audit.push(x, z); else C.auditRoad.push(x, z);
  const y = C.groundY(x, z);
  if (h > 0) C.auditDeck.push(x, z, y, h);
  return y;
}

// A prop that is not on the ground plane at all — roofscape, marine, rolling stock. Counted, but
// never audited against footprints, because standing on a building is the entire point.
function noteProp(C, kind) {
  C.stats.props[kind] = (C.stats.props[kind] || 0) + 1;
}

function inAcornZone(x, z) {
  for (let i = 0; i < ACORN_ZONES.length; i++) {
    const a = ACORN_ZONES[i];
    if (Math.hypot(x - a[0], z - a[1]) < a[2]) return true;
  }
  return false;
}

function isBikeStreet(name) {
  if (typeof name !== 'string' || !name) return false;
  for (let i = 0; i < BIKE_STREETS.length; i++) {
    if (name.indexOf(BIKE_STREETS[i]) === 0) return true;
  }
  return false;
}

/* ========================================================= grade separation == */

/**
 * Where a way sits relative to the ground.
 *
 * The extract's `lay` is a SIGNED OSM layer and `tun` distinguishes a bored tunnel from a
 * building passage; the previous encoding collapsed both into "elevated or deleted", which built
 * 750 underpasses as flyovers and deleted 712 ways outright. Those two mistakes are most of what
 * a pedestrian walks into.
 */
const WAY_GRADE = 0;      // on the ground
const WAY_UNDER = 1;      // depressed carriageway: dips, retaining walls, portal, deck overhead
const WAY_SUB = 2;        // genuinely underground: the PATH concourse network
const WAY_OVER = 3;       // carried over what it crosses: deck, abutments, piers
const WAY_PASSAGE = 4;    // building_passage: stays at grade, stays walkable

const UNDER_CLEAR = 4.50;          // clear headroom demanded under a structure
const RAIL_DECK = 0.95;            // depth of a rail bridge deck below the ballast base
const RAIL_BED = 0.10;             // ballast base above terrain, as the rail pass lays it
const ROAD_DECK = {                // depth of a road bridge deck below its carriageway
  motorway: 1.9, major: 1.3, minor: 1.3, service: 1.1, pedestrian: 0.8, foot: 0.8,
};
const LAYER_DROP = 5.40;           // one negative layer, which is exactly rail clearance
const DEPTH_MAX = 13.0;
const RAMP_GRADE = 0.10;           // 10% — steep for a street, ordinary for an underpass approach
const RAMP_MIN = 30.0;             // CONTRACT 8.1: ramped over 30-80 m depending on depth, so a
const RAMP_MAX = 80.0;             // shallow dip still eases in and a deep one is not a cliff
const RAIL_GRADE = 0.020;          // a railway ramps at 2%, not at a street's 10%
const RAIL_RISE_MAX = 5.00;        // ...and no further than a downtown embankment plausibly goes
const TRENCH_FLOOR = -0.30;        // the deepest a carriageway may be cut, above the lake datum
const TRENCH_WALL = 0.45;          // retaining wall thickness
const TRENCH_MITER = 0.50;         // slack for the mitre throwing the kerb line out at a corner
const TRENCH_VERGE = 3.50;         // paved verge over the ragged edge of the terrain cut
const TRENCH_CUT = 0.50;           // terrain removed this far beyond the wall's outer face
const CUT_MIN = 0.35;              // shallower than this and the corridor is not a cut at all
const SUB_HEAD = 3.20;             // headroom in an underground concourse
const SUB_COVER = 0.80;            // earth left over its ceiling
const PASSAGE_HEAD = 4.60;         // clear height of a building passage
const PASS_HEAD = 2.10;            // eye height plus a hat: what a walker needs to pass under
const TUNNEL_LAMP_PITCH = 11.0;    // metres between batten luminaires under a tunnel soffit
const TUNNEL_LAMP_MIN = 2.60;      // a fixture lower than this over the road is not a tunnel light
const TUNNEL_LAMP_H = 3.70;        // how far over the carriageway a batten hangs, clear of any deck
const SUB_SEG = 45.0;              // resampling step for an underground corridor
const COVER_PAD = 7.0;             // how far a crossing structure counts as roofing the corridor
const CROSS_MIN_SIN = 0.30;        // sin(17.5 deg): shallower than this and they are parallel
const GRADE_CELL = 12.0;           // corridor index cell; also the active-mask resolution

/**
 * The gradient a corridor of this depth descends at.
 *
 * RAMP_GRADE where that lands the ramp inside the 30-80 m CONTRACT 8.1 asks for, and stretched or
 * shortened to the nearest end of that band where it does not: a 1.5 m dip taken at 10% would be
 * over in fifteen metres and read as a pothole, and a 13 m one would need a hundred and thirty.
 */
function rampGrade(depth) {
  if (!(depth > 0)) return RAMP_GRADE;
  return clamp(RAMP_GRADE, depth / RAMP_MAX, depth / RAMP_MIN);
}

/** Depth an UNDER way wants purely from its layer, before any clearance requirement. */
function layerDepth(lay, tun) {
  const levels = lay < 0 ? -lay : (tun === 1 ? 1 : 0);
  return Math.min(DEPTH_MAX, LAYER_DROP * levels);
}

function classifyWay(r) {
  const lay = isNum(r.lay) ? clamp(Math.round(r.lay), -4, 4) : 0;
  const tun = r.tun | 0;
  if (tun === 2) return WAY_PASSAGE;
  if (tun === 1 || lay < 0) {
    // Toronto's underground pedestrian network is the PATH, and every metre of it is a footway
    // under a building. Vehicular tunnels are streets. That split is what keeps a concourse from
    // tearing a 5 m pit through the sidewalk above it, and it needs no bounding box to decide.
    return (r.c === 'foot' || r.c === 'pedestrian') ? WAY_SUB : WAY_UNDER;
  }
  if (r.b === 1 || lay > 0) return WAY_OVER;
  return WAY_GRADE;
}

/* ------------------------------------------------------------- node welding */

/**
 * Position-welded node set. OSM ways share a node where they meet, so welding vertices by
 * position recovers the street graph exactly — as long as the weld survives a vertex pair landing
 * either side of a bucket boundary, which a bare rounding key does not. Probes the 3x3
 * neighbourhood instead.
 */
function makeNodeSet(tol) {
  const cell = Math.max(0.05, tol);
  const map = new Map();
  const xs = [], zs = [];
  return {
    xs, zs,
    get count() { return xs.length; },
    at(x, z) {
      const i = Math.round(x / cell), j = Math.round(z / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const bucket = map.get((i + di) + ':' + (j + dj));
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k++) {
            const v = bucket[k];
            const dx = xs[v] - x, dz = zs[v] - z;
            if (dx * dx + dz * dz <= tol * tol) return v;
          }
        }
      }
      const id = xs.length;
      xs.push(x); zs.push(z);
      const key = i + ':' + j;
      const b = map.get(key);
      if (b) b.push(id); else map.set(key, [id]);
      return id;
    },
  };
}

/** Binary max-heap over (key, value) pairs; used by both relaxations below. */
function makeMaxHeap() {
  const k = [], v = [];
  return {
    get size() { return k.length; },
    push(key, val) {
      k.push(key); v.push(val);
      let i = k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (v[p] >= v[i]) break;
        const tk = k[p]; k[p] = k[i]; k[i] = tk;
        const tv = v[p]; v[p] = v[i]; v[i] = tv;
        i = p;
      }
    },
    pop() {
      const top = k[0], val = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        k[0] = lk; v[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < k.length && v[l] > v[m]) m = l;
          if (r < k.length && v[r] > v[m]) m = r;
          if (m === i) break;
          const tk = k[m]; k[m] = k[i]; k[i] = tk;
          const tv = v[m]; v[m] = v[i]; v[i] = tv;
          i = m;
        }
      }
      _heapVal = val;
      return top;
    },
  };
}
let _heapVal = 0;

/* --------------------------------------------------------- corridor index -- */

/**
 * The vertical offset the ground takes along every depressed corridor, plus the footprint of the
 * cut that has to be taken out of the terrain to expose it.
 *
 * This is the single authority: `groundY` composes it with the terrain, the carriageway ribbons
 * are laid on the same composition, the pavement bands and every prop follow `groundY`, and the
 * terrain mesh removes exactly the cells the cut covers. Nothing can disagree with anything else
 * because there is only one number.
 *
 * A coarse active mask makes the common case — the 99% of the map with no corridor anywhere near
 * — a single array read, so composing it into `groundY` costs nothing where nothing is happening.
 */
// Scratch for makeGradeField().span(). One field, one reader at a time, no allocation on a query
// that runs several times per frame under the player's feet.
const _span = {
  hit: false, d2: 0, dep: 0, hw: 0, chw: 0, pass: false, roofed: false, way: -1, dx: 1, dz: 0,
};

function makeGradeField(extent) {
  const pad = 400;
  const x0 = -extent.x / 2 - pad, z0 = -extent.z / 2 - pad;
  const nx = Math.ceil((extent.x + 2 * pad) / GRADE_CELL) + 2;
  const nz = Math.ceil((extent.z + 2 * pad) / GRADE_CELL) + 2;
  const idx = makeGridIndex(GRADE_CELL, x0, z0, nx, nz);
  // Two masks, because they answer different questions at very different costs. `active` says
  // "there is a corridor near here", which makes composing the offset into groundY free
  // everywhere else. `cutMask` says "the terrain is actually open here", and it is what decides
  // whether a 25 m terrain cell has to be rebuilt at CUT_SUB — so it must stay tight, or the
  // approach ramp of every underpass refines half a hectare of ground that never opens.
  const active = new Uint8Array(nx * nz);
  const cutMask = new Uint8Array(nx * nz);
  let any = false;
  const mark = (into, ax, az, bx, bz, r) => {
    const i0 = clamp(Math.floor((Math.min(ax, bx) - r - x0) / GRADE_CELL), 0, nx - 1);
    const i1 = clamp(Math.floor((Math.max(ax, bx) + r - x0) / GRADE_CELL), 0, nx - 1);
    const j0 = clamp(Math.floor((Math.min(az, bz) - r - z0) / GRADE_CELL), 0, nz - 1);
    const j1 = clamp(Math.floor((Math.max(az, bz) + r - z0) / GRADE_CELL), 0, nz - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) into[j * nx + i] = 1;
  };
  const hot = (x, z) => {
    if (!any) return false;
    const i = Math.floor((x - x0) / GRADE_CELL), j = Math.floor((z - z0) / GRADE_CELL);
    if (i < 0 || i >= nx || j < 0 || j >= nz) return false;
    return active[j * nx + i] === 1;
  };
  return {
    hot,
    /**
     * Segment entry:
     *   [ax, az, bx, bz, halfWidth, depthA, depthB, cutHalfWidth, over, way, carriageHalfWidth]
     * `over` is 0 open cut, 1 roofed by a street carried across, 2 a building passage at grade.
     */
    add(ax, az, bx, bz, hw, da, db, roofed, way, chw) {
      const cut = hw + TRENCH_WALL + TRENCH_CUT;
      idx.add(Math.min(ax, bx) - cut, Math.min(az, bz) - cut,
        Math.max(ax, bx) + cut, Math.max(az, bz) + cut,
        [ax, az, bx, bz, hw, da, db, cut, roofed ? 1 : 0, way, isNum(chw) ? chw : hw]);
      mark(active, ax, az, bx, bz, cut);
      if (!roofed && Math.max(da, db) > CUT_MIN) mark(cutMask, ax, az, bx, bz, cut);
      any = true;
    },
    /**
     * A building passage: at grade, so it cuts nothing and drops nothing, but it is still a hole
     * through whatever stands over it. Filed alongside the corridors so a single `span` query
     * answers the only question the wall pass and the player's collision both ask — "is the way
     * through here open?" — for underpasses and passages alike.
     */
    addPassage(ax, az, bx, bz, hw) {
      idx.add(Math.min(ax, bx) - hw, Math.min(az, bz) - hw,
        Math.max(ax, bx) + hw, Math.max(az, bz) + hw,
        [ax, az, bx, bz, hw, 0, 0, hw, 2, -1, hw]);
      mark(active, ax, az, bx, bz, hw);
      any = true;
    },
    /**
     * The corridor covering (x, z), or null. Same nearest-segment rule as `offset`, but roofed
     * spans and passages count too, because what is being asked here is not "how far has the
     * ground dropped" but "is there a way through". The returned record is a SHARED scratch
     * object, valid only until the next call — read it, never keep it.
     */
    span(x, z) {
      if (!hot(x, z)) return null;
      let near = Infinity;
      _span.hit = false;
      idx.query(x, z, 0, (s) => {
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 > s[4] * s[4] || d2 >= near) return;
        near = d2;
        const l = Math.sqrt(l2);
        _span.hit = true;
        _span.d2 = d2;
        _span.dep = s[5] + (s[6] - s[5]) * t;
        _span.hw = s[4];
        _span.chw = s[10];
        _span.pass = s[8] === 2;
        _span.roofed = s[8] === 1;
        _span.way = s[9];
        _span.dx = l > EPS ? dx / l : 1;
        _span.dz = l > EPS ? dz / l : 0;
      });
      return _span.hit ? _span : null;
    },
    /**
     * Metres the walkable ground drops at (x, z); 0 (never positive) off every corridor.
     *
     * The NEAREST covering segment wins, not the deepest. A corridor is filed as a chain of short
     * segments whose half-width is far greater than their length, so every point is covered by
     * several of them at once; taking the deepest makes each point see the low end of whichever
     * neighbouring segment reaches it, and the smooth ramp comes out as a staircase with half-metre
     * risers every few metres — which is exactly what the cliff audit then reports. Nearest gives
     * the segment the point is actually on, and with it the linear interpolation along the ramp.
     */
    offset(x, z) {
      if (!hot(x, z)) return 0;
      let drop = 0, near = Infinity;
      idx.query(x, z, 0, (s) => {
        // A roofed span has ground over it, and the walking surface IS that ground. This is the
        // invariant the whole thing rests on: groundY dips exactly where the terrain has been cut
        // away and nowhere else, so the player can never be walking below what they can see.
        if (s[8]) return;
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const hw = s[4];
        const d2 = qx * qx + qz * qz;
        if (d2 > hw * hw) return;
        const d = s[5] + (s[6] - s[5]) * t;
        // Ties go to the deeper corridor: two carriageways of the same street overlap completely,
        // and the ground between them belongs to whichever one is further down.
        if (d2 < near - 1e-6 || (d2 < near + 1e-6 && d > drop)) { near = d2; drop = d; }
      });
      return -drop;
    },
    /** Is (x, z) inside the footprint the cut takes out of the terrain? */
    cut(x, z) {
      if (!hot(x, z)) return false;
      let hit = false;
      idx.query(x, z, 0, (s) => {
        if (hit || s[8]) return;                     // a roofed corridor keeps its lid of ground
        const dx = s[2] - s[0], dz = s[3] - s[1];
        const l2 = dx * dx + dz * dz;
        let t = 0;
        if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
        const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
        const r = s[7];
        if (qx * qx + qz * qz > r * r) return;
        if (s[5] + (s[6] - s[5]) * t > CUT_MIN) { hit = true; return false; }
      });
      return hit;
    },
    /** Does the axis-aligned box touch any cut footprint at all? Cheap terrain-mesh reject. */
    boxHot(ax, az, bx, bz) {
      if (!any) return false;
      const i0 = clamp(Math.floor((ax - x0) / GRADE_CELL), 0, nx - 1);
      const i1 = clamp(Math.floor((bx - x0) / GRADE_CELL), 0, nx - 1);
      const j0 = clamp(Math.floor((az - z0) / GRADE_CELL), 0, nz - 1);
      const j1 = clamp(Math.floor((bz - z0) / GRADE_CELL), 0, nz - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (cutMask[j * nx + i]) return true;
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------- crossings --- */

/**
 * Every place two linear features actually cross in plan, derived from segment intersection —
 * never from a shared node, never assumed from a bounding box. CONTRACT 8.1 requires the way with
 * the higher layer to pass above, and that cannot be decided without knowing where they meet.
 *
 * Cost is linear in feature count: segments are filed in a uniform grid and each is tested only
 * against the ones sharing a cell.
 */
function findCrossings(lines, extent, visit) {
  const cell = 24;
  const pad = 400;
  const x0 = -extent.x / 2 - pad, z0 = -extent.z / 2 - pad;
  const nx = Math.ceil((extent.x + 2 * pad) / cell) + 2;
  const nz = Math.ceil((extent.z + 2 * pad) / cell) + 2;
  const idx = makeGridIndex(cell, x0, z0, nx, nz);
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l].p;
    if (!Array.isArray(p)) continue;
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k];
      if (!isNum(a[0]) || !isNum(a[1]) || !isNum(b[0]) || !isNum(b[1])) continue;
      idx.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
        Math.max(a[0], b[0]), Math.max(a[1], b[1]), [a[0], a[1], b[0], b[1], l, k]);
    }
  }
  for (let l = 0; l < lines.length; l++) {
    const p = lines[l].p;
    if (!Array.isArray(p)) continue;
    for (let k = 1; k < p.length; k++) {
      const ax = p[k - 1][0], az = p[k - 1][1], bx = p[k][0], bz = p[k][1];
      if (!isNum(ax) || !isNum(az) || !isNum(bx) || !isNum(bz)) continue;
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const rad = Math.hypot(bx - ax, bz - az) * 0.5;
      idx.query(mx, mz, rad, (s) => {
        // Each unordered pair once, and never a way against itself.
        if (s[4] <= l) return;
        const cx = s[0], cz = s[1], dx = s[2], dz = s[3];
        const r1x = bx - ax, r1z = bz - az;
        const r2x = dx - cx, r2z = dz - cz;
        const den = r1x * r2z - r1z * r2x;
        if (Math.abs(den) < 1e-12) return;
        const t = ((cx - ax) * r2z - (cz - az) * r2x) / den;
        const u = ((cx - ax) * r1z - (cz - az) * r1x) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) return;
        // Two ways running side by side weave across each other every few metres; each of those
        // touches is a digitising artifact, not a grade-separated crossing. |sin| between the two
        // segments IS the normalised determinant, so the filter is one divide.
        const l1 = Math.hypot(r1x, r1z), l2 = Math.hypot(r2x, r2z);
        if (!(l1 > EPS) || !(l2 > EPS)) return;
        if (Math.abs(den) / (l1 * l2) < CROSS_MIN_SIN) return;
        visit(l, k, s[4], s[5], ax + r1x * t, az + r1z * t);
      });
    }
  }
}

/* ----------------------------------------------------------- the solver ---- */

/**
 * Decide, once, how far above or below the terrain every way sits — and hand back the field the
 * rest of the load reads it from.
 *
 * Four things happen here, in order, and none of them knows anything about this bounding box:
 *   1. every way is classified (at grade / depressed / underground / carried over / passage);
 *   2. every place two ways or a way and a railway actually CROSS is found by segment
 *      intersection, and the pair's layers decide which one is above;
 *   3. the depth each depressed way needs for real headroom under whatever crosses it propagates
 *      outward through the connected street graph at a fixed maximum gradient, so the approach
 *      ramps land on the streets that really carry them and every transition is ramped;
 *   4. the result is rasterised into the corridor field that `groundY` composes with the terrain.
 *
 * @returns {object} kinds, per-way depth and rise profiles, the corridor field and the shared
 *                   street graph the walkability audit runs on.
 */
function solveGrade(roadsRaw, railsRaw, buildingsRaw, extent, terrainY, stats) {
  const n = roadsRaw.length;
  const kind = new Int8Array(n);
  const lay = new Int8Array(n);
  const hwOf = new Float64Array(n);
  const chwOf = new Float64Array(n);
  const clsOf = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = roadsRaw[i];
    kind[i] = classifyWay(r);
    lay[i] = isNum(r.lay) ? clamp(Math.round(r.lay), -4, 4) : 0;
    const cls = ROAD_CLASS_OK[r.c] ? r.c : 'minor';
    clsOf[i] = cls;
    const w = clamp(isNum(r.w) ? r.w : 8, 1.6, 44);
    const sw = SIDEWALK_W[cls] || 0;
    // The corridor is as wide as the ground the way actually claims: carriageway, both pavements,
    // and the slack a mitred corner throws the kerb line out by.
    hwOf[i] = w / 2 + (sw > 0 ? 0.25 + sw : 0.60) + TRENCH_MITER;
    // ...but the hole a corridor punches through a wall is only as wide as the corridor itself.
    // A building that merely LINES a depressed street stands at the back of its pavement, which
    // is inside hwOf; opening the ground floor of every such building would be vandalism.
    chwOf[i] = w / 2 + 0.40;
  }

  /* --- 1. the shared street graph ---------------------------------------- */
  const set = makeNodeSet(0.30);
  const wayNodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = roadsRaw[i].p;
    if (!Array.isArray(p) || p.length < 2) { wayNodes[i] = null; continue; }
    const ids = new Int32Array(p.length);
    for (let k = 0; k < p.length; k++) {
      ids[k] = (isNum(p[k][0]) && isNum(p[k][1])) ? set.at(p[k][0], p[k][1]) : -1;
    }
    wayNodes[i] = ids;
  }
  const nodeCount = set.count;
  const adj = new Array(nodeCount);
  const degree = new Int32Array(nodeCount);
  const touch = new Uint8Array(nodeCount);        // bit 1 surface way, bit 2 depressed way
  for (let i = 0; i < n; i++) {
    const ids = wayNodes[i];
    if (!ids) continue;
    const k0 = kind[i];
    const surface = k0 === WAY_GRADE || k0 === WAY_PASSAGE || k0 === WAY_OVER;
    const p = roadsRaw[i].p;
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] < 0) continue;
      touch[ids[k]] |= surface ? 1 : (k0 === WAY_UNDER ? 2 : 4);
      if (k === 0) continue;
      const a = ids[k - 1], b = ids[k];
      if (a < 0 || b < 0 || a === b) continue;
      const len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      (adj[a] || (adj[a] = [])).push(b, len, i);
      (adj[b] || (adj[b] = [])).push(a, len, i);
      degree[a]++; degree[b]++;
    }
  }

  /* --- 2. crossings ------------------------------------------------------- */
  // Roads first, then the railways that are not underground, in one index so a road/rail crossing
  // costs no more than a road/road one.
  const lines = new Array(n);
  for (let i = 0; i < n; i++) lines[i] = roadsRaw[i];
  // Line index -> railsRaw index. Subway ways are not in `lines` at all, so the two run out of
  // step immediately and the map has to be explicit; indexing railsRaw by (line - n) attaches
  // every rail deck to the wrong piece of track.
  const railFor = [];
  for (let i = 0; i < railsRaw.length; i++) {
    const ra = railsRaw[i];
    if (!ra || ra.k === 'subway' || !Array.isArray(ra.p) || ra.p.length < 2) continue;
    railFor[lines.length - n] = i;
    lines.push(ra);
  }
  const levelOf = (l) => {
    if (l >= n) return 0;                          // a railway is on the ground
    const k = kind[l];
    if (k === WAY_OVER) return Math.max(1, lay[l]);
    if (k === WAY_UNDER || k === WAY_SUB) return Math.min(-1, lay[l]);
    return 0;
  };
  const deckOf = (l) => (l >= n ? RAIL_DECK : (ROAD_DECK[clsOf[l]] || 1.2));

  const reqDepth = new Float64Array(nodeCount);
  const riseNeed = new Float64Array(n);
  // Kept, because the requirement a crossing puts on the way BELOW depends on how far the way
  // ABOVE ends up rising, and that is not known until every crossing has been seen once.
  const cross = [];
  findCrossings(lines, extent, (l1, k1, l2, k2, cx, cz) => {
    const v1 = levelOf(l1), v2 = levelOf(l2);
    if (v1 === v2) return;
    stats.grade.crossings++;
    const below = v1 < v2;
    const lo = below ? l1 : l2, hi = below ? l2 : l1;
    cross.push(lo, hi, below ? k1 : k2, cx, cz);
    if (hi < n && kind[hi] === WAY_OVER) {
      const r = UNDER_CLEAR + ROAD_Y + deckOf(hi) - ROAD_Y;
      if (r > riseNeed[hi]) riseNeed[hi] = r;
    }
  });

  /* --- 3. how far each way carried over something actually rises ---------- */
  const rise = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_OVER) continue;
    const cap = BRIDGE_RISE[clsOf[i]] || 5.0;
    if (roadsRaw[i].b === 1) { rise[i] = cap; continue; }
    // layer > 0 with no bridge tag: it is only above something where it actually crosses
    // something, and it rises exactly as far as that crossing demands. With nothing under it,
    // it belongs on the ground, where it stays walkable.
    const need = riseNeed[i];
    if (need < 0.4) { kind[i] = WAY_GRADE; continue; }
    rise[i] = Math.min(cap, need);
  }


  /* --- 4. the clearance each crossing demands of the way underneath -------- */
  // Now that the deck heights are settled, every crossing is revisited and the way BELOW is told
  // how deep it has to be. A street under the Gardiner asks for nothing — the expressway is
  // already 8 m over it. A street under a railway at grade has to find all of it itself.
  const riseAt = new Array(n);
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_OVER || !(rise[i] > 0)) continue;
    const p = roadsRaw[i].p;
    const arc = new Float64Array(p.length);
    for (let k = 1; k < p.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    }
    riseAt[i] = arc;
  }
  const deckHeight = (way, cx, cz) => {
    if (way >= n) return RAIL_BED;                 // a railway is on the ground
    if (kind[way] !== WAY_OVER || !(rise[way] > 0)) return ROAD_Y;
    const arc = riseAt[way];
    const p = roadsRaw[way].p;
    let best = 0, bestD = Infinity;
    for (let k = 1; k < p.length; k++) {
      const d2 = distToSeg2(cx, cz, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]);
      if (d2 >= bestD) continue;
      bestD = d2;
      const dx = p[k][0] - p[k - 1][0], dz = p[k][1] - p[k - 1][1];
      const l2 = dx * dx + dz * dz;
      const t = l2 > EPS
        ? clamp(((cx - p[k - 1][0]) * dx + (cz - p[k - 1][1]) * dz) / l2, 0, 1) : 0;
      best = arc[k - 1] + (arc[k] - arc[k - 1]) * t;
    }
    const total = arc[arc.length - 1] || 1;
    const ramp = Math.max(20, rise[way] * 4.5);
    return ROAD_Y + rise[way] *
      Math.min(smoothstep(0, ramp, best), smoothstep(0, ramp, total - best));
  };
  for (let c = 0; c < cross.length; c += 5) {
    const lo = cross[c], hi = cross[c + 1], seg = cross[c + 2];
    const cx = cross[c + 3], cz = cross[c + 4];
    if (lo >= n || kind[lo] !== WAY_UNDER) continue;
    const need = UNDER_CLEAR + ROAD_Y + deckOf(hi) - deckHeight(hi, cx, cz);
    if (!(need > 0)) continue;
    const ids = wayNodes[lo];
    if (!ids) continue;
    const req = Math.min(DEPTH_MAX, need);
    // BOTH ends of the crossed segment, at the full requirement. A corridor's depth is the linear
    // interpolation between its vertices, so two equal endpoints hold the whole segment at that
    // depth and the crossing is covered wherever along it the two lines happen to meet.
    for (const k of [seg - 1, seg]) {
      if (k < 0 || k >= ids.length || ids[k] < 0) continue;
      if (req > reqDepth[ids[k]]) reqDepth[ids[k]] = req;
    }
  }
  /* --- 5. how far every node is from a portal ----------------------------- */
  // A depressed way dips as far as its clearance requirement asks AND as far as the distance to
  // its own portal allows at RAMP_GRADE, whichever is less. That second cap is what keeps the
  // whole thing local: the ramp lives inside the corridor, the portal sits exactly at grade, and
  // the surface street outside it is untouched. Where the corridor is too short to find all the
  // clearance itself, the structure above makes up the difference — see the rail rise below.
  const portalDist = new Float64Array(nodeCount).fill(Infinity);
  {
    const heap = makeMaxHeap();
    for (let v = 0; v < nodeCount; v++) {
      // A portal is where a depressed way meets one that is not — or simply runs out, because a
      // loose end left 5 m down would be a cliff.
      if (!(touch[v] & 2)) continue;
      if ((touch[v] & 1) || degree[v] <= 1) { portalDist[v] = 0; heap.push(v, 0); }
    }
    while (heap.size) {
      const v = heap.pop();
      const d = -_heapVal;
      if (d > portalDist[v] + 1e-6) continue;
      const a = adj[v];
      if (!a) continue;
      for (let e = 0; e < a.length; e += 3) {
        if (kind[a[e + 2]] !== WAY_UNDER) continue;
        const nd = d + a[e + 1];
        if (nd < portalDist[a[e]] - 1e-4) { portalDist[a[e]] = nd; heap.push(a[e], -nd); }
      }
    }
  }

  /* --- 6. the depth profile along each corridor --------------------------- */
  // Depth is a function of ARC LENGTH, not of vertex index. Bay Street's teamway is two vertices
  // 109 m apart: sampling only at those would leave it dead flat, portal to portal, and the
  // headline underpass in the city would not exist. The graph distance to the nearest portal is
  // exact for any point of a way — min over its own vertices of (that vertex's distance plus the
  // walk along the way to it) — so the profile can be resampled as finely as the ramp needs.
  // A corridor is ROOFED only where a walkable surface way crosses over it: that crossing needs
  // ground to walk on, so the cut stops and a lid carries it across. It is NOT roofed merely for
  // running under a building — Union Station's teamways are the headline underpass in the city and
  // burying them under a lid would make them unwalkable, which is the bug this whole pass exists
  // to fix. A railway crossing does not roof it either: the railway gets its own deck and the
  // street below stays open to the sky, which is what those underpasses actually look like.
  const lids = new Array(n);
  for (let c = 0; c < cross.length; c += 5) {
    const lo = cross[c], hi = cross[c + 1];
    if (lo >= n || hi >= n || kind[lo] !== WAY_UNDER) continue;
    if (kind[hi] !== WAY_GRADE && kind[hi] !== WAY_PASSAGE) continue;
    if (!WALK_CLASS[roadsRaw[hi].c]) continue;
    (lids[lo] || (lids[lo] = [])).push(cross[c + 3], cross[c + 4]);
  }
  // A streetcar does NOT lid what it crosses: it runs IN the street, so it goes down the ramp with
  // the carriageway it is embedded in. The Bay Street car runs the length of the teamway under
  // Union Station, and roofing it there would put a bridge across the middle of the underpass.

  const field = makeGradeField(extent);
  const corridor = new Array(n);
  let cutMetres = 0, roofMetres = 0, deepest = 0, lidSteps = 0;
  for (let i = 0; i < n; i++) {
    corridor[i] = null;
    if (kind[i] !== WAY_UNDER) continue;
    const ids = wayNodes[i];
    const p = roadsRaw[i].p;
    if (!ids || p.length < 2) continue;
    const arc = new Float64Array(p.length);
    for (let k = 1; k < p.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    }
    const total = arc[p.length - 1];
    if (!(total > 0.5)) continue;
    let want = Math.min(LAYER_DROP, layerDepth(lay[i], roadsRaw[i].tun | 0));
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] >= 0 && reqDepth[ids[k]] > want) want = reqDepth[ids[k]];
    }
    const grade = rampGrade(want);
    const step = Math.max(2.0, Math.min(6.0, total / 3));
    const count = Math.max(2, Math.ceil(total / step) + 1);
    const pts = new Array(count);
    const dep = new Float64Array(count);
    const roof = new Uint8Array(count);
    for (let c = 0; c < count; c++) {
      const sv = total * (c / (count - 1));
      // Locate the sample on the raw polyline.
      let k = 1;
      while (k < p.length - 1 && arc[k] < sv) k++;
      const span = arc[k] - arc[k - 1];
      const t = span > EPS ? clamp((sv - arc[k - 1]) / span, 0, 1) : 0;
      const x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * t;
      const z = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t;
      let d = Infinity;
      for (let m = 0; m < ids.length; m++) {
        if (ids[m] < 0) continue;
        const dd = portalDist[ids[m]] + Math.abs(sv - arc[m]);
        if (dd < d) d = dd;
      }
      pts[c] = [x, z];
      // ...and never below the lake. A trench floor under the water plane is a flooded street,
      // and the player cannot follow it down there anyway.
      dep[c] = Math.max(0, Math.min(want, grade * d, terrainY(x, z) - TRENCH_FLOOR));
      if (dep[c] > deepest) deepest = dep[c];
      roof[c] = 0;
      const lid = lids[i];
      if (dep[c] > CUT_MIN && lid) {
        for (let m = 0; m < lid.length; m += 2) {
          if (Math.hypot(lid[m] - x, lid[m + 1] - z) < COVER_PAD) { roof[c] = 1; break; }
        }
      }
    }
    corridor[i] = { pts, dep, roof, hw: hwOf[i] };
    // Where a street is carried over a corridor on a lid, the ground plane belongs to the street
    // and the roadway runs underneath it. A single heightfield cannot hold both, so `groundY`
    // steps up onto the lid — while the roadway itself, its pavement and its markings all stay
    // down on the corridor profile. Counted, because it is the one place the two disagree.
    for (let c = 1; c < count; c++) {
      if (roof[c] !== roof[c - 1] && Math.max(dep[c], dep[c - 1]) > 0.45) lidSteps++;
    }
    for (let c = 1; c < count; c++) {
      if (!(dep[c - 1] > 0.05 || dep[c] > 0.05)) continue;
      const roofed = roof[c - 1] === 1 && roof[c] === 1;
      field.add(pts[c - 1][0], pts[c - 1][1], pts[c][0], pts[c][1], hwOf[i],
        dep[c - 1], dep[c], roofed, i, chwOf[i]);
      if (Math.max(dep[c - 1], dep[c]) <= CUT_MIN) continue;
      const len = Math.hypot(pts[c][0] - pts[c - 1][0], pts[c][1] - pts[c - 1][1]);
      if (roofed) roofMetres += len; else cutMetres += len;
    }
  }

  // A building passage drops nothing and cuts nothing, but it is still a way THROUGH a structure,
  // so it is filed in the same field: one query then covers every place a wall has to open and
  // the player has to be let through, whether the way dives under the building or walks into it.
  for (let i = 0; i < n; i++) {
    if (kind[i] !== WAY_PASSAGE) continue;
    const p = roadsRaw[i].p;
    if (!Array.isArray(p) || p.length < 2) continue;
    for (let k = 1; k < p.length; k++) {
      if (!isNum(p[k - 1][0]) || !isNum(p[k][0])) continue;
      field.addPassage(p[k - 1][0], p[k - 1][1], p[k][0], p[k][1], chwOf[i]);
    }
  }

  /* --- 7. the rise the structures above still owe ------------------------- */
  // Where a corridor could not find all its clearance inside its own length, the railway over it
  // takes up the rest — which is exactly what Toronto's downtown rail corridor does: it runs on a
  // continuous embankment and the streets pass under it. The rise propagates along the track at a
  // railway gradient, not a road one, so it lands as a long approach rather than a hump.
  const railRise = new Array(railsRaw.length);
  {
    const rset = makeNodeSet(0.40);
    const rNodes = new Array(railsRaw.length);
    const rAdj = [];
    for (let i = 0; i < railsRaw.length; i++) {
      const ra = railsRaw[i];
      rNodes[i] = null;
      if (!ra || ra.k === 'subway' || !Array.isArray(ra.p) || ra.p.length < 2) continue;
      const ids = new Int32Array(ra.p.length);
      for (let k = 0; k < ra.p.length; k++) {
        ids[k] = isNum(ra.p[k][0]) ? rset.at(ra.p[k][0], ra.p[k][1]) : -1;
        if (k > 0 && ids[k] >= 0 && ids[k - 1] >= 0 && ids[k] !== ids[k - 1]) {
          const len = Math.hypot(ra.p[k][0] - ra.p[k - 1][0], ra.p[k][1] - ra.p[k - 1][1]);
          (rAdj[ids[k - 1]] || (rAdj[ids[k - 1]] = [])).push(ids[k], len);
          (rAdj[ids[k]] || (rAdj[ids[k]] = [])).push(ids[k - 1], len);
        }
      }
      rNodes[i] = ids;
    }
    const rn = rset.count;
    const rv = new Float64Array(rn);
    let violations = 0;
    for (let c = 0; c < cross.length; c += 5) {
      const lo = cross[c], hi = cross[c + 1];
      if (hi < n || lo >= n || kind[lo] !== WAY_UNDER) continue;
      if (lines[hi].k !== 'rail') continue;           // a streetcar is not carried on a viaduct
      const cx = cross[c + 3], cz = cross[c + 4];
      const cor = corridor[lo];
      if (!cor) { violations++; continue; }
      const need = UNDER_CLEAR + ROAD_Y + RAIL_DECK - RAIL_BED;
      const have = corridorDepth(cor, cx, cz);
      const deficit = need - have;
      if (deficit < 0.05) continue;
      const ri = railFor[hi - n];
      const ids = ri === undefined ? null : rNodes[ri];
      if (!ids) { violations++; continue; }
      const want = Math.min(RAIL_RISE_MAX, deficit);
      if (want < deficit - 0.05) violations++;
      const p = railsRaw[ri].p;
      for (let k = 1; k < p.length; k++) {
        if (distToSeg2(cx, cz, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]) > 4) continue;
        for (const m of [k - 1, k]) {
          if (ids[m] >= 0 && want > rv[ids[m]]) rv[ids[m]] = want;
        }
      }
    }
    stats.grade.violations = violations;
    const heap = makeMaxHeap();
    for (let v = 0; v < rn; v++) if (rv[v] > 0) heap.push(v, rv[v]);
    while (heap.size) {
      const v = heap.pop();
      const d = _heapVal;
      if (d < rv[v] - 1e-6 || d <= 0) continue;
      const a = rAdj[v];
      if (!a) continue;
      for (let e = 0; e < a.length; e += 2) {
        const nd = d - RAIL_GRADE * a[e + 1];
        if (nd > rv[a[e]] + 1e-4) { rv[a[e]] = nd; heap.push(a[e], nd); }
      }
    }
    for (let i = 0; i < railsRaw.length; i++) {
      const ids = rNodes[i];
      if (!ids) { railRise[i] = null; continue; }
      let any = false;
      const out = new Float64Array(ids.length);
      for (let k = 0; k < ids.length; k++) {
        out[k] = ids[k] >= 0 ? rv[ids[k]] : 0;
        if (out[k] > 0.02) any = true;
      }
      railRise[i] = any ? out : null;
    }
  }

  stats.grade.under = 0;
  stats.grade.sub = 0;
  stats.grade.over = 0;
  stats.grade.passage = 0;
  for (let i = 0; i < n; i++) {
    if (kind[i] === WAY_UNDER) stats.grade.under++;
    else if (kind[i] === WAY_SUB) stats.grade.sub++;
    else if (kind[i] === WAY_OVER) stats.grade.over++;
    else if (kind[i] === WAY_PASSAGE) stats.grade.passage++;
  }
  stats.grade.lidSteps = lidSteps;
  stats.grade.cutMetres = cutMetres;
  stats.grade.roofedMetres = roofMetres;
  stats.grade.deepest = deepest;
  stats.grade.nodes = nodeCount;

  return {
    kind, lay, clsOf, hwOf, wayNodes, adj, degree, nodeCount, nodeX: set.xs, nodeZ: set.zs,
    corridor, railRise, rise, field,
  };
}

/* ------------------------------------------------------------- structures -- */

/** A vertical wall along one lateral offset, with independent top and bottom height functions. */
function emitWallStrip(mb, pts, frames, offset, yTop, yBot, facing) {
  const n = pts.length;
  let px = 0, pz = 0, pt = 0, pb = 0, have = false;
  for (let i = 0; i < n; i++) {
    const sx = frames[i * 3], sz = frames[i * 3 + 1], sc = frames[i * 3 + 2];
    const o = offset * sc;
    const x = pts[i][0] + sx * o, z = pts[i][1] + sz * o;
    const t = yTop(x, z, i), b = yBot(x, z, i);
    if (have && (t - b > 0.01 || pt - pb > 0.01)) {
      if (facing < 0) {
        mb.tri(px, pb, pz, px, pt, pz, x, t, z);
        mb.tri(px, pb, pz, x, t, z, x, b, z);
      } else {
        mb.tri(px, pb, pz, x, b, z, x, t, z);
        mb.tri(px, pb, pz, x, t, z, px, pt, pz);
      }
    }
    px = x; pz = z; pt = t; pb = b; have = true;
  }
}

/**
 * A portal: two jambs and a lintel across a corridor, at the mouth where it goes under something.
 * Cheap, and it is what turns a hole in the ground into an underpass you can read at a glance.
 */
function emitPortal(mb, x, z, sx, sz, hw, yFloor, yHead) {
  if (!(yHead - yFloor > 0.6) || !(hw > 0.5)) return;
  const t = 0.55;                                   // jamb thickness along the corridor
  const tx = -sz * t * 0.5, tz = sx * t * 0.5;      // half a jamb, along the way
  const jamb = (o) => {
    const cx = x + sx * o, cz = z + sz * o;
    boxAA(mb, cx, cz, tx, tz, sx * 0.45, sz * 0.45, yFloor, yHead + 0.55);
  };
  jamb(-(hw + 0.30));
  jamb(hw + 0.30);
  // Lintel across the top, spanning both jambs.
  boxAA(mb, x, z, tx, tz, sx * (hw + 0.75), sz * (hw + 0.75), yHead, yHead + 0.55);
}

/**
 * An axis-free box from two half-extent vectors in plan and a height range. Both halves are given
 * as VECTORS rather than as an angle, so nothing here has to agree with anyone's yaw convention.
 */
function boxAA(mb, cx, cz, ux, uz, vx, vz, y0, y1) {
  const px = [cx - ux - vx, cx + ux - vx, cx + ux + vx, cx - ux + vx];
  const pz = [cz - uz - vz, cz + uz - vz, cz + uz + vz, cz - uz + vz];
  // Plan winding: make the top face look at the sky whichever way the caller handed the vectors.
  const s = (px[1] - px[0]) * (pz[0] - pz[3]) - (px[3] - px[0]) * (pz[0] - pz[1]);
  const o = s >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  for (let k = 0; k < 4; k++) {
    const a = o[k], b = o[(k + 1) & 3];
    mb.tri(px[a], y0, pz[a], px[b], y0, pz[b], px[b], y1, pz[b]);
    mb.tri(px[a], y0, pz[a], px[b], y1, pz[b], px[a], y1, pz[a]);
  }
  mb.tri(px[o[0]], y1, pz[o[0]], px[o[1]], y1, pz[o[1]], px[o[2]], y1, pz[o[2]]);
  mb.tri(px[o[0]], y1, pz[o[0]], px[o[2]], y1, pz[o[2]], px[o[3]], y1, pz[o[3]]);
  mb.tri(px[o[0]], y0, pz[o[0]], px[o[2]], y0, pz[o[2]], px[o[1]], y0, pz[o[1]]);
  mb.tri(px[o[0]], y0, pz[o[0]], px[o[3]], y0, pz[o[3]], px[o[2]], y0, pz[o[2]]);
}

/** The depth of a corridor at the point of it nearest (x, z). */
function corridorDepth(cor, x, z) {
  const pts = cor.pts;
  let best = 0, bestD = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const d2 = distToSeg2(x, z, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    if (d2 >= bestD) continue;
    bestD = d2;
    const dx = pts[k][0] - pts[k - 1][0], dz = pts[k][1] - pts[k - 1][1];
    const l2 = dx * dx + dz * dz;
    const t = l2 > EPS
      ? clamp(((x - pts[k - 1][0]) * dx + (z - pts[k - 1][1]) * dz) / l2, 0, 1) : 0;
    best = cor.dep[k - 1] + (cor.dep[k] - cor.dep[k - 1]) * t;
  }
  return best;
}

/**
 * The structure of a depressed corridor: retaining walls up to natural grade, the paved verge that
 * covers the edge of the cut taken out of the terrain, the ceiling where the corridor runs under a
 * building rather than in the open, and a portal at every mouth.
 *
 * The carriageway itself is NOT built here — it is the ordinary road ribbon, laid on the same
 * composed `groundY` this corridor defines, which is exactly why the two can never disagree.
 */
function emitTrench(C, cor) {
  const hw = cor.hw;
  const pts = cor.pts, dep = cor.dep, roof = cor.roof;
  const nP = pts.length;
  if (nP < 2) return;
  const frames = polyFrames(pts, hw + TRENCH_VERGE);
  const T = C.terrainY;
  const mb = C.mb.roads;
  const floorY = new Float64Array(nP);
  const topY = new Float64Array(nP);
  for (let i = 0; i < nP; i++) {
    topY[i] = T(pts[i][0], pts[i][1]);
    floorY[i] = topY[i] - dep[i];
  }
  const yTop = (x, z, i) => topY[i];
  const yBot = (x, z, i) => floorY[i] - 0.30;

  // Retaining walls. They stand the full depth wherever there is any, so the wall dies away on
  // its own along the ramp instead of ending in a step.
  setMat(mb, M.bridge);
  emitWallStrip(mb, pts, frames, -hw, yTop, yBot, 1);
  emitWallStrip(mb, pts, frames, hw, yTop, yBot, -1);
  C.stats.grade.wallMetres += arcLength(pts) * 2;

  // The paved verge, over the ragged edge of the terrain cut — but only in the open, because
  // under a building there is no cut to cover.
  setMat(mb, M.sidewalk);
  const vergeY = (x, z) => T(x, z) + PATH_Y;
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    let run = -1;
    for (let i = 0; i <= nP; i++) {
      const open = i < nP && dep[i] > CUT_MIN && !roof[i];
      if (open) { if (run < 0) run = i; continue; }
      if (run >= 0 && i - run >= 2) {
        const seg = pruneSpikes(pts.slice(Math.max(0, run - 1), Math.min(nP, i + 1)),
          hw + TRENCH_VERGE);
        if (seg.length >= 2) {
          const fr = polyFrames(seg, hw + TRENCH_VERGE);
          const a = hw * sgn, b = (hw + TRENCH_VERGE) * sgn;
          emitRibbon(mb, seg, fr, sgn > 0 ? [{ o: a, dy: 0 }, { o: b, dy: 0 }]
            : [{ o: b, dy: 0 }, { o: a, dy: 0 }], vergeY);
          emitSkirt(mb, seg, fr, b, vergeY, PATH_Y + 0.9, sgn);
        }
      }
      run = -1;
    }
  }

  // Ceiling where the corridor is roofed, and a portal wherever roofed meets open.
  setMat(mb, M.bridge);
  const ceilY = new Float64Array(nP);
  for (let i = 0; i < nP; i++) {
    // A lid carries a street across, so its soffit hangs a deck's depth under natural grade.
    ceilY[i] = Math.min(topY[i] - 0.95, floorY[i] + UNDER_CLEAR + 0.55);
  }
  for (let i = 1; i < nP; i++) {
    if (!roof[i - 1] || !roof[i]) continue;
    const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
    const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
    const o0 = hw * c0, o1 = hw * c1;
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    // A soffit, seen from below: wound so its normal points DOWN.
    const p0x = ax - s0 * o0, p0z = az - t0 * o0, p1x = ax + s0 * o0, p1z = az + t0 * o0;
    const q0x = bx - s1 * o1, q0z = bz - t1 * o1, q1x = bx + s1 * o1, q1z = bz + t1 * o1;
    const ya = ceilY[i - 1], yb = ceilY[i];
    triDown(mb, p0x, ya, p0z, p1x, ya, p1z, q1x, yb, q1z);
    triDown(mb, p0x, ya, p0z, q1x, yb, q1z, q0x, yb, q0z);
  }
  for (let i = 1; i < nP; i++) {
    if (roof[i - 1] === roof[i]) continue;
    const k = roof[i] ? i : i - 1;
    if (!(dep[k] > CUT_MIN)) continue;
    emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
      hw * frames[k * 3 + 2], floorY[k], ceilY[k]);
    C.stats.grade.portals++;
  }

  // Under a BUILDING the corridor is not open to the sky — Union Station's teamways are a tunnel
  // through the base of the station, not a trench beside it. `punchCorridorPortals` has already
  // taken the facade out from its foot up to floor + UNDER_CLEAR, so the ceiling goes on exactly
  // that line, the sides are closed from natural grade up to meet it, and a portal frame stands at
  // each mouth. The floor stays the depressed carriageway, which is what keeps it walkable.
  const cover = new Uint8Array(nP);
  const soff = new Float64Array(nP);
  let covered = false;
  for (let i = 0; i < nP; i++) {
    soff[i] = floorY[i] + UNDER_CLEAR;
    if (!roof[i] && coveringRecord(C, pts[i][0], pts[i][1])) { cover[i] = 1; covered = true; }
  }
  if (covered) {
    setMat(mb, M.tunnel);
    for (let i = 1; i < nP; i++) {
      if (!cover[i - 1] || !cover[i]) continue;
      const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
      const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
      const o0 = hw * c0, o1 = hw * c1;
      const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
      const p0x = ax - s0 * o0, p0z = az - t0 * o0, p1x = ax + s0 * o0, p1z = az + t0 * o0;
      const q0x = bx - s1 * o1, q0z = bz - t1 * o1, q1x = bx + s1 * o1, q1z = bz + t1 * o1;
      const ya = soff[i - 1], yb = soff[i];
      triDown(mb, p0x, ya, p0z, p1x, ya, p1z, q1x, yb, q1z);
      triDown(mb, p0x, ya, p0z, q1x, yb, q1z, q0x, yb, q0z);
      C.stats.grade.coveredMetres += Math.hypot(bx - ax, bz - az);
    }
    // Close the sides between natural grade and the soffit wherever the ceiling stands above the
    // ground it passes through, so no strip of sky is left between the trench wall and the lid.
    const spanTop = (x, z, i) => (cover[i] ? Math.max(soff[i], topY[i]) : topY[i]);
    const spanBot = (x, z, i) => topY[i];
    emitWallStrip(mb, pts, frames, -hw, spanTop, spanBot, 1);
    emitWallStrip(mb, pts, frames, hw, spanTop, spanBot, -1);
    for (let i = 1; i < nP; i++) {
      if (cover[i - 1] === cover[i]) continue;
      const k = cover[i] ? i : i - 1;
      emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
        hw * frames[k * 3 + 2], floorY[k], soff[k]);
      C.stats.grade.coverPortals++;
    }
    // Batten luminaires down the crown of the tunnel. Under a building there is no sky and no
    // lamp standard tall enough to matter, so this is the only lighting a teamway has; it is
    // modelled as the fixture and left to the renderer to switch, like every other emitter.
    const mbP = C.mb.props;
    setMat(mbP, M.tunnelLamp);
    for (let i = 1; i < nP; i++) {
      if (!cover[i - 1] || !cover[i]) continue;
      const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
      const seg = Math.hypot(bx - ax, bz - az);
      if (!(seg > EPS)) continue;
      const yaw = Math.atan2(bx - ax, bz - az);
      const n = Math.max(1, Math.round(seg / TUNNEL_LAMP_PITCH));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const floor = floorY[i - 1] + (floorY[i] - floorY[i - 1]) * t;
        // Hang it from whatever is actually lowest overhead. Under Union Station the rail deck
        // carrying the corridor's own tracks sits BELOW the tunnel lid, and a fixture bolted to
        // the lid would be buried in the deck and light nothing — which is exactly how the York
        // teamway came out dark the first time.
        let y = soff[i - 1] + (soff[i] - soff[i - 1]) * t;
        const deck = deckSoffitAbove(C, x, z, floor + TUNNEL_LAMP_MIN);
        if (deck < y) y = deck;
        // ...and never higher than a pendant fixture hangs. A rail bridge carried over the
        // corridor is not in the deck index at all, so a batten pinned to the lid can end up
        // inside the deck above it and light nothing. TUNNEL_LAMP_H is below every structure the
        // grade solve guarantees UNDER_CLEAR for, so this is always in the open.
        if (y > floor + TUNNEL_LAMP_H) y = floor + TUNNEL_LAMP_H;
        if (!(y > floor + TUNNEL_LAMP_MIN)) continue;
        mbP.box(x, y - 0.16, z, 0.34, 0.10, 1.70, yaw);
        C.stats.grade.tunnelLamps++;
      }
    }
    // File that ceiling as an elevated deck. Everything placed later — lamps, signals, trees,
    // parked cars — already knows how to read a soffit and either fit under it or stand down, so
    // one entry stops a 9.5 m cobra lamp growing through the station floor AND is what puts light
    // in the teamway, because a lamp under a deck is shortened to fit rather than skipped.
    const dIdx = C.deckIdx;
    if (dIdx) {
      const covr = hw + 0.40;
      for (let i = 1; i < nP; i++) {
        if (!cover[i - 1] || !cover[i]) continue;
        const a = pts[i - 1], b = pts[i];
        dIdx.add(Math.min(a[0], b[0]) - covr, Math.min(a[1], b[1]) - covr,
          Math.max(a[0], b[0]) + covr, Math.max(a[1], b[1]) + covr,
          [a[0], a[1], b[0], b[1], covr, soff[i - 1], soff[i]]);
        C.stats.deck.segments++;
      }
    }
  }
}

/**
 * A building passage: a road or walkway that goes THROUGH a building and stays at grade.
 *
 * 75 of these were previously deleted with the tunnels, which is why an arcade or a service
 * courtyard entrance reads as a dead end. The surface is built by the ordinary road pass — a
 * passage is at grade and stays walkable — so what is left is the opening: a portal frame at each
 * mouth, found by walking the way and watching for the moment it enters or leaves a footprint.
 */
function emitPassage(C, r, hw) {
  const pts = pruneSpikes(polyResample(r.p, 4.0), hw);
  if (pts.length < 3) return;
  const frames = polyFrames(pts, hw);
  const mb = C.mb.roads;
  setMat(mb, M.bridge);
  let prev = inFootprint(C, pts[0][0], pts[0][1], 0);
  for (let i = 1; i < pts.length; i++) {
    const cur = inFootprint(C, pts[i][0], pts[i][1], 0);
    if (cur === prev) continue;
    prev = cur;
    const k = cur ? i : i - 1;
    const y = C.groundY(pts[k][0], pts[k][1]) + ROAD_Y;
    emitPortal(mb, pts[k][0], pts[k][1], frames[k * 3], frames[k * 3 + 1],
      hw * frames[k * 3 + 2], y, y + PASSAGE_HEAD);
    C.stats.grade.passagePortals++;
  }
}

/** Emit a near-horizontal triangle wound so its normal points DOWN, whatever order it came in. */
function triDown(mb, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const s = (bx - ax) * (az - cz) - (cx - ax) * (az - bz);
  if (s <= 0) mb.tri(ax, ay, az, bx, by, bz, cx, cy, cz);
  else mb.tri(ax, ay, az, cx, cy, cz, bx, by, bz);
}

function arcLength(pts) {
  let l = 0;
  for (let k = 1; k < pts.length; k++) {
    l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  }
  return l;
}

/**
 * An underground concourse — the PATH.
 *
 * 630 of these were previously deleted outright, which is a large part of what the user is
 * walking into. They are a genuine second level: a floor, two walls and a ceiling, cut into the
 * ground under the buildings they serve. They do not touch `groundY`, because the ground above
 * them is still ground, and they are audited as their own connected network.
 */
function emitSubway(C, r, gi, G) {
  const w = clamp(isNum(r.w) ? r.w : 4, 1.6, 20);
  // Resampled coarsely on purpose: a concourse is a straight-walled corridor under a building
  // with no terrain to follow, so stations buy nothing but vertices.
  const pts = pruneSpikes(polyResample(r.p, SUB_SEG), w / 2);
  if (pts.length < 2) return;
  const hw = w / 2;
  const frames = polyFrames(pts, hw);
  const T = C.terrainY;
  const drop = layerDepth(G.lay[gi], r.tun | 0) || LAYER_DROP;
  const mb = C.mb.sidewalks;
  // Deep enough that the ceiling always keeps its cover of earth, whatever the terrain does.
  const floorY = (x, z) => Math.min(T(x, z) - SUB_COVER - SUB_HEAD, T(x, z) - drop);
  const ceil = (x, z) => floorY(x, z) + SUB_HEAD;
  setMat(mb, M.path);
  emitRibbon(mb, pts, frames, [{ o: -hw, dy: 0 }, { o: hw, dy: 0 }], floorY);
  setMat(mb, M.bridge);
  emitWallStrip(mb, pts, frames, -hw, ceil, floorY, 1);
  emitWallStrip(mb, pts, frames, hw, ceil, floorY, -1);
  for (let i = 1; i < pts.length; i++) {
    const s0 = frames[(i - 1) * 3], t0 = frames[(i - 1) * 3 + 1], c0 = frames[(i - 1) * 3 + 2];
    const s1 = frames[i * 3], t1 = frames[i * 3 + 1], c1 = frames[i * 3 + 2];
    const o0 = hw * c0, o1 = hw * c1;
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const ya = ceil(ax, az), yb = ceil(bx, bz);
    triDown(mb, ax - s0 * o0, ya, az - t0 * o0, ax + s0 * o0, ya, az + t0 * o0,
      bx + s1 * o1, yb, bz + t1 * o1);
    triDown(mb, ax - s0 * o0, ya, az - t0 * o0, bx + s1 * o1, yb, bz + t1 * o1,
      bx - s1 * o1, yb, bz - t1 * o1);
  }
  C.stats.grade.subMetres += arcLength(pts);
}


/* =========================================================== walkability == */

const WALK_CLASS = { major: 1, minor: 1, service: 1, pedestrian: 1, foot: 1 };
const WALK_STEP = 2.0;             // how finely a route is walked when testing for cliffs
const WALK_CLIFF = 0.45;           // CONTRACT 8.2: a bigger step than this needs geometry
const WALK_WALL = 1.20;            // ...and a bigger one than THIS is not a step, it is a wall
const WALK_BLOCK = 1.6;            // metres inside a footprint before a route is really blocked
const STITCH_R = 8.0;              // how far a connector may reach to close a gap
const STITCH_W = 1.9;              // and how wide it is built
const ISLAND_MIN = 50.0;           // CONTRACT 8.2: report every island longer than this
const STAIR_RISE = 0.17;
const STAIR_RUN = 0.30;

/** Union-find over the welded node set; the graph is built once and re-solved after stitching. */
function makeUnionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
    return r;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra === rb) return false;
      parent[ra] = rb;
      return true;
    },
  };
}

/**
 * A flight of steps between two points at different heights, so a legal walking route with a
 * vertical discontinuity has geometry to walk up instead of a cliff to fall off.
 */
function emitSteps(mb, ax, az, ay, bx, bz, by, halfW) {
  const dx = bx - ax, dz = bz - az;
  const run = Math.hypot(dx, dz);
  const rise = by - ay;
  if (!(run > 0.2) || Math.abs(rise) < 0.02) return 0;
  const n = clamp(Math.ceil(Math.abs(rise) / STAIR_RISE), 1, 40);
  const ux = dx / run, uz = dz / run;
  const sx = -uz * halfW, sz = ux * halfW;
  const stepRun = Math.max(STAIR_RUN, run / n);
  for (let i = 0; i < n; i++) {
    const t0 = (i * stepRun) / Math.max(run, EPS);
    const cx = ax + dx * clamp(t0, 0, 1), cz = az + dz * clamp(t0, 0, 1);
    const y = ay + (rise * (i + 1)) / n;
    boxAA(mb, cx + ux * stepRun * 0.5, cz + uz * stepRun * 0.5,
      ux * stepRun * 0.5, uz * stepRun * 0.5, sx, sz, Math.min(ay, by) - 0.35, y);
  }
  return n;
}

/**
 * CONTRACT 8.2 — walkability is an acceptance test, not an aspiration.
 *
 * The graph is built from what was actually BUILT, not from the raw survey: a way that was skipped
 * is a hole a pedestrian falls into whatever OSM says about it, and an edge that runs through the
 * middle of a tower is not a route however it is tagged. Every carriageway that carries a
 * pavement, every footway and every building passage contributes; motorways and the elevated
 * expressway do not, because nobody walks on the Gardiner. The underground concourse is measured
 * as its own network, because it is one.
 *
 * What it measures: the fraction of walkable metres in the largest connected component, every
 * island above ISLAND_MIN with its location, the number of places two adjacent samples of the
 * walking surface differ by more than WALK_CLIFF with nothing between them, and whether groundY is
 * finite everywhere inside the world.
 *
 * What it FIXES: gaps where two walkable ends nearly meet get a real paved connector, and a
 * remaining vertical discontinuity on a legal route gets a real flight of steps.
 */
function auditWalkability(C, G, roadsRaw, extent, stats) {
  const W = stats.walk;
  W.worstCliffs = [];
  const nodeCount = G.nodeCount;
  const nx = G.nodeX, nz = G.nodeZ;

  // --- 1. the built walkable graph -------------------------------------------
  const edges = [];               // a, b, len, wayIndex
  const sub = [];
  let blockedMetres = 0, severedMetres = 0;
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    const ids = G.wayNodes[i];
    if (!ids || !WALK_CLASS[r.c]) continue;
    const kind = G.kind[i];
    const p = r.p;
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1], b = ids[k];
      if (a < 0 || b < 0 || a === b) continue;
      const len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      if (!(len > 0.05)) continue;
      if (kind === WAY_SUB) { sub.push(a, b, len); continue; }
      // A route driven through the middle of a building is not a route. A passage through one is,
      // and so is a corridor that dives under one: both have had a portal cut through the facade
      // and both let a walker through, so counting them blocked would report a hole that the
      // player cannot find.
      let blocked = false;
      if (kind !== WAY_PASSAGE && kind !== WAY_UNDER) {
        const steps = Math.max(1, Math.ceil(len / 4));
        for (let m = 0; m <= steps && !blocked; m++) {
          const t = m / steps;
          const x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * t;
          const z = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t;
          if (footprintDepth(C, x, z) > WALK_BLOCK) blocked = true;
        }
      }
      if (blocked) { blockedMetres += len; continue; }
      // ...and neither is a route that walks off the side of a wall. A retaining wall beside a
      // depressed carriageway and the quay wall along the harbour are both walls: a way that
      // wanders across one is severed there, exactly as it is on the ground. Reported, never
      // quietly stepped over — a staircase down the face of a retaining wall would be a lie about
      // what is there. Inside a corridor the surface is the carriageway, so a way running down
      // into an underpass is smooth and stays whole.
      const cor = G.corridor[i];
      const surf = cor
        ? (x, z) => C.terrainY(x, z) - corridorDepth(cor, x, z)
        : C.groundY;
      let sev = false;
      const walk = Math.max(1, Math.ceil(len / 1.5));
      let prev = surf(p[k - 1][0], p[k - 1][1]);
      for (let m = 1; m <= walk && !sev; m++) {
        const t = m / walk;
        const x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * t;
        const z = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t;
        const cur = surf(x, z);
        if (Math.abs(cur - prev) > WALK_WALL) sev = true;
        prev = cur;
      }
      if (sev) { severedMetres += len; continue; }
      edges.push(a, b, len, i);
    }
  }

  // --- 2. connectivity -------------------------------------------------------
  const uf = makeUnionFind(nodeCount);
  for (let e = 0; e < edges.length; e += 4) uf.union(edges[e], edges[e + 1]);

  const compLen = new Map();
  let total = 0;
  for (let e = 0; e < edges.length; e += 4) {
    const root = uf.find(edges[e]);
    compLen.set(root, (compLen.get(root) || 0) + edges[e + 2]);
    total += edges[e + 2];
  }
  let mainRoot = -1, mainLen = 0;
  for (const [root, len] of compLen) if (len > mainLen) { mainLen = len; mainRoot = root; }

  // --- 3. stitch what nearly meets ------------------------------------------
  // Two walkable ends a couple of metres apart are a survey artifact, not a wall. Where one is on
  // an island and the other is not, a real paved connector is laid between them — geometry, not a
  // graph edge, because the pedestrian has to have something under their feet.
  const deg = new Int32Array(nodeCount);
  for (let e = 0; e < edges.length; e += 4) { deg[edges[e]]++; deg[edges[e + 1]]++; }
  const cell = STITCH_R;
  const buckets = new Map();
  const key = (x, z) => Math.floor(x / cell) + ':' + Math.floor(z / cell);
  for (let v = 0; v < nodeCount; v++) {
    if (!deg[v]) continue;
    const k = key(nx[v], nz[v]);
    const b = buckets.get(k);
    if (b) b.push(v); else buckets.set(k, [v]);
  }
  const mb = C.mb.sidewalks;
  setMat(mb, M.path);
  let stitched = 0, stitchMetres = 0;
  for (let v = 0; v < nodeCount; v++) {
    if (!deg[v] || uf.find(v) === mainRoot) continue;
    if (compLen.get(uf.find(v)) === undefined) continue;
    let best = -1, bestD = STITCH_R;
    const i0 = Math.floor((nx[v] - STITCH_R) / cell), i1 = Math.floor((nx[v] + STITCH_R) / cell);
    const j0 = Math.floor((nz[v] - STITCH_R) / cell), j1 = Math.floor((nz[v] + STITCH_R) / cell);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const b = buckets.get(i + ':' + j);
        if (!b) continue;
        for (let m = 0; m < b.length; m++) {
          const w = b[m];
          if (uf.find(w) === uf.find(v)) continue;
          const d = Math.hypot(nx[w] - nx[v], nz[w] - nz[v]);
          if (d < bestD) { bestD = d; best = w; }
        }
      }
    }
    if (best < 0) continue;
    // Never bridge a building with a connector: if the gap is a wall, it is meant to be there.
    const mid = 4;
    let clear = true;
    for (let m = 0; m <= mid && clear; m++) {
      const t = m / mid;
      const x = nx[v] + (nx[best] - nx[v]) * t, z = nz[v] + (nz[best] - nz[v]) * t;
      if (footprintDepth(C, x, z) > WALK_BLOCK) clear = false;
    }
    if (!clear) continue;
    // ...and never across a wall either: a connector is a paving job, not a bridge. The whole
    // line is checked, because the drop it must not cross can be anywhere along it.
    let walled = false;
    let prevY = C.groundY(nx[v], nz[v]);
    for (let m = 1; m <= 8 && !walled; m++) {
      const t = m / 8;
      const y = C.groundY(nx[v] + (nx[best] - nx[v]) * t, nz[v] + (nz[best] - nz[v]) * t);
      if (Math.abs(y - prevY) > WALK_CLIFF) walled = true;
      prevY = y;
    }
    if (walled) continue;
    const seg = [[nx[v], nz[v]], [nx[best], nz[best]]];
    const fr = polyFrames(seg, STITCH_W / 2);
    const yAt = (x, z) => C.groundY(x, z) + PATH_Y;
    emitRibbon(mb, seg, fr, [{ o: -STITCH_W / 2, dy: 0 }, { o: STITCH_W / 2, dy: 0 }], yAt);
    edges.push(v, best, bestD, -1);
    uf.union(v, best);
    stitched++;
    stitchMetres += bestD;
  }

  if (stitched) {
    compLen.clear();
    total = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const root = uf.find(edges[e]);
      compLen.set(root, (compLen.get(root) || 0) + edges[e + 2]);
      total += edges[e + 2];
    }
    mainRoot = -1; mainLen = 0;
    for (const [root, len] of compLen) if (len > mainLen) { mainLen = len; mainRoot = root; }
  }

  // --- 4. islands ------------------------------------------------------------
  const islandNodes = new Map();
  for (let e = 0; e < edges.length; e += 4) {
    const root = uf.find(edges[e]);
    if (root === mainRoot) continue;
    let rec = islandNodes.get(root);
    if (!rec) {
      rec = { x: 0, z: 0, n: 0, name: '', len: compLen.get(root) || 0 };
      islandNodes.set(root, rec);
    }
    rec.x += nx[edges[e]]; rec.z += nz[edges[e]]; rec.n++;
    if (!rec.name && edges[e + 3] >= 0) {
      const nm = roadsRaw[edges[e + 3]].n;
      if (typeof nm === 'string' && nm) rec.name = nm;
    }
  }
  const islands = [...islandNodes.values()].sort((a, b) => b.len - a.len);
  let islandMetres = 0, islandCount = 0;
  const worst = [];
  for (const isl of islands) {
    if (isl.len <= ISLAND_MIN) continue;
    islandCount++;
    islandMetres += isl.len;
    if (worst.length < 12) {
      worst.push({
        m: Math.round(isl.len),
        x: Math.round(isl.x / Math.max(1, isl.n)),
        z: Math.round(isl.z / Math.max(1, isl.n)),
        name: isl.name,
      });
    }
  }

  // --- 5. cliffs -------------------------------------------------------------
  // Every walkable edge is walked at WALK_STEP and the surface under each pair of adjacent
  // samples compared. A discontinuity bigger than WALK_CLIFF that has no ramp gets a real flight
  // of steps built into it, and only what is left is counted.
  let cliffs = 0, worstCliff = 0, samples = 0, steps = 0, flights = 0;
  const gy = C.groundY;
  for (let e = 0; e < edges.length; e += 4) {
    const a = edges[e], b = edges[e + 1], len = edges[e + 2];
    // A deck is not the ground: an elevated way's walking surface is a ribbon this audit has no
    // business sampling the terrain under. It is continuous by construction and it is measured for
    // connectivity like everything else.
    const way = edges[e + 3];
    if (way >= 0 && G.kind[way] === WAY_OVER) continue;
    // Inside a depressed corridor the surface underfoot is the carriageway, not the ground plane
    // over the lid that carries a street across it. Sample what a pedestrian actually walks on.
    const cor = way >= 0 ? G.corridor[way] : null;
    const surf = cor
      ? (x, z) => C.terrainY(x, z) - corridorDepth(cor, x, z)
      : gy;
    const n = Math.max(1, Math.ceil(len / WALK_STEP));
    let px = nx[a], pz = nz[a], py = surf(px, pz);
    for (let m = 1; m <= n; m++) {
      const t = m / n;
      const x = nx[a] + (nx[b] - nx[a]) * t, z = nz[a] + (nz[b] - nz[a]) * t;
      const y = surf(x, z);
      samples++;
      const d = Math.abs(y - py);
      if (d > WALK_CLIFF) {
        if (d > worstCliff) worstCliff = d;
        // A step is only worth building where the drop is a real one; beyond a storey it is a
        // wall, and a staircase up the face of a retaining wall would be a lie.
        if (d < 3.0) {
          setMat(C.mb.sidewalks, M.sidewalk);
          steps += emitSteps(C.mb.sidewalks, px, pz, py, x, z, y, 1.1);
          flights++;
        } else {
          // Bigger than a storey and it is not a step, it is a wall the sever test above should
          // have taken the route out on. Counted, located, and never papered over.
          cliffs++;
          if (W.worstCliffs.length < 8) {
            W.worstCliffs.push({
              m: Math.round(d * 100) / 100, x: Math.round(x), z: Math.round(z),
            });
          }
        }
      }
      px = x; pz = z; py = y;
    }
  }

  // --- 6. holes --------------------------------------------------------------
  // groundY must be finite and sane everywhere inside the world, including outside the mapped
  // extent, where the player can still walk: nothing may fall out of the world.
  let holes = 0, gMin = Infinity, gMax = -Infinity;
  const hx = extent.x / 2 + 300, hz = extent.z / 2 + 300;
  for (let z = -hz; z <= hz; z += 8) {
    for (let x = -hx; x <= hx; x += 8) {
      const y = gy(x, z);
      if (!isFinite(y)) { holes++; continue; }
      if (y < gMin) gMin = y;
      if (y > gMax) gMax = y;
    }
  }

  let subLen = 0;
  const subUf = makeUnionFind(nodeCount);
  for (let e = 0; e < sub.length; e += 3) { subUf.union(sub[e], sub[e + 1]); subLen += sub[e + 2]; }
  const subComp = new Set();
  for (let e = 0; e < sub.length; e += 3) subComp.add(subUf.find(sub[e]));

  W.metres = total;
  W.largest = mainLen;
  W.fraction = total > 0 ? mainLen / total : 1;
  W.components = compLen.size;
  W.islands = islandCount;
  W.islandMetres = islandMetres;
  W.worstIslands = worst;
  W.cliffs = cliffs;
  W.cliffWorst = worstCliff;
  W.samples = samples;
  W.stitched = stitched;
  W.stitchMetres = stitchMetres;
  W.steps = steps;
  W.flights = flights;
  W.blockedMetres = blockedMetres;
  W.severedMetres = severedMetres;
  W.groundHoles = holes;
  W.groundMin = isFinite(gMin) ? gMin : 0;
  W.groundMax = isFinite(gMax) ? gMax : 0;
  W.subNetMetres = subLen;
  W.subComponents = subComp.size;
}

/* ============================================== road records and sampling == */

// Markings, kerb ramps, furniture, kerb parking and the tram wire all sample the SAME prepared
// record, so paint, kerb and lamp can never disagree about where the road is.
const _smp = { x: 0, z: 0, sx: 1, sz: 0, sc: 1, i: 0, t: 0 };

function recSample(rec, s) {
  const arr = rec.s;
  const n = arr.length;
  const sv = clamp(s, 0, arr[n - 1]);
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= sv) lo = mid; else hi = mid;
  }
  const span = arr[hi] - arr[lo];
  const t = span > EPS ? (sv - arr[lo]) / span : 0;
  const a = rec.pts[lo], b = rec.pts[hi];
  _smp.x = a[0] + (b[0] - a[0]) * t;
  _smp.z = a[1] + (b[1] - a[1]) * t;
  const f = rec.frames;
  let sx = f[lo * 3] + (f[hi * 3] - f[lo * 3]) * t;
  let sz = f[lo * 3 + 1] + (f[hi * 3 + 1] - f[lo * 3 + 1]) * t;
  const l = Math.hypot(sx, sz);
  if (l > EPS) { sx /= l; sz /= l; } else { sx = 1; sz = 0; }
  _smp.sx = sx; _smp.sz = sz;
  _smp.sc = f[lo * 3 + 2] + (f[hi * 3 + 2] - f[lo * 3 + 2]) * t;
  _smp.i = lo; _smp.t = t;
  return _smp;
}

/**
 * The carriageway surface height at lateral offset `o`, reproducing emitRibbon()'s own
 * cross-section interpolation — including the mitre scale, which widens the section at a corner,
 * and the crown, which is why naive paint sinks into the middle of a wide street.
 */
/** The ground a road record is laid on: its own corridor profile where it has one. */
function recBase(C, rec, x, z) {
  return rec.corridor ? C.terrainY(x, z) - corridorDepth(rec.corridor, x, z) : C.groundY(x, z);
}

function surfaceY(C, rec, m, o) {
  const hs = Math.max(rec.hw * m.sc, EPS);
  const f = clamp(Math.abs(o) / hs, 0, 1);
  if (rec.deck) {
    const d = rec.deck;
    const a = d[m.i], b = d[Math.min(d.length - 1, m.i + 1)];
    return a + (b - a) * m.t + (rec.crowned ? CROWN * (1 - f) : 0);
  }
  if (!rec.crowned) {
    const yn = recBase(C, rec, m.x - m.sx * hs, m.z - m.sz * hs) + ROAD_Y;
    const yp = recBase(C, rec, m.x + m.sx * hs, m.z + m.sz * hs) + ROAD_Y;
    return yn + (yp - yn) * clamp((o + hs) / (2 * hs), 0, 1);
  }
  const sgn = o < 0 ? -1 : 1;
  const yMid = recBase(C, rec, m.x, m.z) + ROAD_Y + CROWN;
  const yEdge = recBase(C, rec, m.x + m.sx * hs * sgn, m.z + m.sz * hs * sgn) + ROAD_Y;
  return yMid + (yEdge - yMid) * f;
}

function nearJunction(rec, s, pad) {
  const j = rec.junc;
  for (let k = 0; k < j.length; k++) if (Math.abs(s - j[k].s) < j[k].r + pad) return true;
  return false;
}

/* =============================================== markings and crossings == */

/**
 * The height a marking must be laid at to sit MARK_LIFT clear of EVERY carriageway beneath it —
 * its own ribbon, crown included, and any street it crosses. Bridge paint ignores the ground:
 * a deck is not laid on the road running under it.
 */
function paintY(C, rec, m, o) {
  const own = surfaceY(C, rec, m, o);
  if (rec.deck) return own + MARK_LIFT;
  const other = carriagewayTopY(C, m.x + m.sx * o, m.z + m.sz * o);
  return (other > own ? other : own) + MARK_LIFT;
}

/**
 * One painted stripe between arc lengths s0..s1 at lateral offsets o0..o1. The strip breaks at
 * every polyline vertex so it follows curves and terrain, and every corner takes the road's own
 * surface height plus MARK_LIFT — paint on a crowned street or a bridge deck cannot sink.
 * @returns {number} quads emitted
 */
function emitStripe(C, rec, s0, s1, o0, o1) {
  const a = clamp(Math.min(s0, s1), 0, rec.len);
  const b = clamp(Math.max(s0, s1), 0, rec.len);
  if (b - a < 0.04) return 0;
  const lo = Math.min(o0, o1), hi = Math.max(o0, o1);
  if (hi - lo < 0.02) return 0;
  const mb = C.mb.roads;
  const arr = rec.s;
  const st = C.stations;
  st.length = 0;
  st.push(a);
  for (let k = 0; k < arr.length; k++) {
    if (arr[k] > a + 0.02 && arr[k] < b - 0.02) st.push(arr[k]);
  }
  st.push(b);

  let px0 = 0, py0 = 0, pz0 = 0, px1 = 0, py1 = 0, pz1 = 0;
  let have = false, quads = 0;
  for (let k = 0; k < st.length; k++) {
    const m = recSample(rec, st[k]);
    const ax = m.x + m.sx * lo, az = m.z + m.sz * lo;
    const bx = m.x + m.sx * hi, bz = m.z + m.sz * hi;
    const ay = paintY(C, rec, m, lo);
    const by = paintY(C, rec, m, hi);
    if (have) {
      // The same corner order emitRibbon() uses (previous@lo, previous@hi, current@hi), which is
      // the winding that comes out +Y given the frames' side vector is right-of-travel — and the
      // same fold test, because a stripe crossing a corner can turn inside out exactly as a
      // ribbon can, and a marking that vanishes from one direction is the worst kind of bug.
      const w1 = planWind2(px0, pz0, px1, pz1, bx, bz);
      const w2 = planWind2(px0, pz0, bx, bz, ax, az);
      if (_audit && (w1 < 0 || w2 < 0)) _audit.ribbonFolds += (w1 < 0 ? 1 : 0) + (w2 < 0 ? 1 : 0);
      if (w1 > 0) mb.tri(px0, py0, pz0, px1, py1, pz1, bx, by, bz);
      if (w2 > 0) mb.tri(px0, py0, pz0, bx, by, bz, ax, ay, az);
      if (w1 > 0 || w2 > 0) quads++;
      if (!rec.deck) auditPaint(C, rec, m, lo, ay);
    }
    px0 = ax; py0 = ay; pz0 = az;
    px1 = bx; py1 = by; pz1 = bz;
    have = true;
  }
  return quads;
}

/**
 * Independent audit of a painted corner: how far it stands above the ROAD SURFACE under it. The
 * own-road reference is rebuilt here by walking the cross-section emitRibbon() was actually handed
 * and lerping between the two corners that bracket the offset, rather than by calling surfaceY() —
 * so a sign error or a dropped crown term in surfaceY() is caught rather than confirmed. Where a
 * second street crosses, the reference is whichever surface is higher. Every marking must come out
 * at exactly MARK_LIFT, give or take float noise.
 */
function auditPaint(C, rec, m, o, y) {
  const hs = rec.hw * m.sc;
  let lo = -hs, hi = hs, dyLo = 0, dyHi = 0;
  if (rec.crowned) {
    if (o < 0) { lo = -hs; hi = 0; dyHi = CROWN; } else { lo = 0; hi = hs; dyLo = CROWN; }
  }
  // The record's OWN base, which for a depressed carriageway is its corridor profile rather than
  // the ground plane over the lid that carries a street across it.
  const yLo = recBase(C, rec, m.x + m.sx * lo, m.z + m.sz * lo) + ROAD_Y + dyLo;
  const yHi = recBase(C, rec, m.x + m.sx * hi, m.z + m.sz * hi) + ROAD_Y + dyHi;
  const t = hi - lo > EPS ? clamp((o - lo) / (hi - lo), 0, 1) : 0;
  const own = yLo + (yHi - yLo) * t;
  const cross = carriagewayTopY(C, m.x + m.sx * o, m.z + m.sz * o);
  const lift = y - (cross > own ? cross : own);
  const st = C.stats;
  if (lift < st.markLiftMin) st.markLiftMin = lift;
  if (lift > st.markLiftMax) st.markLiftMax = lift;
  if (lift <= 0.002) st.markingsBelowRoad++;
  // Separately: is this corner under the street it crosses, whatever its own ribbon is doing?
  if (y <= cross) st.markingsUnderCross++;
}

// A continuous line, broken only where it would run through a junction.
function emitSolidLine(C, rec, o0, o1, pad) {
  const arr = rec.s;
  let n = 0, run = -1;
  for (let k = 0; k + 1 < arr.length; k++) {
    const ok = (arr[k + 1] - arr[k] > 0.05) &&
      !nearJunction(rec, (arr[k] + arr[k + 1]) * 0.5, pad);
    if (ok) { if (run < 0) run = arr[k]; }
    else if (run >= 0) { n += emitStripe(C, rec, run, arr[k], o0, o1); run = -1; }
  }
  if (run >= 0) n += emitStripe(C, rec, run, arr[arr.length - 1], o0, o1);
  return n;
}

function emitDashedLine(C, rec, o, halfW, pad) {
  let n = 0;
  for (let s = 2.0; s + DASH_ON < rec.len; s += DASH_ON + DASH_OFF) {
    if (nearJunction(rec, s + DASH_ON * 0.5, pad)) continue;
    n += emitStripe(C, rec, s, s + DASH_ON, o - halfW, o + halfW);
  }
  return n;
}

// Turn arrows as triangle lists in (along the road, right of the driver) metres. The caller maps
// them into each approach frame, so one table serves every approach of every junction.
const ARROW_THRU = [
  -1.70, -0.17, -1.70, 0.17, 0.30, 0.17,
  -1.70, -0.17, 0.30, 0.17, 0.30, -0.17,
  0.30, -0.62, 0.30, 0.62, 1.58, 0.00,
];
const ARROW_TURN = [
  -1.70, -0.17, -1.70, 0.17, 0.66, 0.17,
  -1.70, -0.17, 0.66, 0.17, 0.66, -0.17,
  0.24, -1.00, 0.24, -0.17, 0.66, -0.17,
  0.24, -1.00, 0.66, -0.17, 0.66, -1.00,
  -0.12, -1.00, 1.02, -1.00, 0.45, -1.92,
];

const _apx = new Float64Array(3), _apy = new Float64Array(3), _apz = new Float64Array(3);

// `k` is +1 when the approach runs toward increasing arc length, -1 otherwise; `mirror` turns a
// left arrow into a right one.
function emitArrow(C, rec, sC, oC, k, mirror, table) {
  const mb = C.mb.roads;
  for (let t = 0; t < table.length; t += 6) {
    for (let v = 0; v < 3; v++) {
      const ds = table[t + v * 2], dv = table[t + v * 2 + 1] * mirror;
      const m = recSample(rec, sC + k * ds);
      const o = oC + k * dv;
      _apx[v] = m.x + m.sx * o;
      _apz[v] = m.z + m.sz * o;
      _apy[v] = paintY(C, rec, m, o);
    }
    triUp(mb, _apx[0], _apy[0], _apz[0], _apx[1], _apy[1], _apz[1], _apx[2], _apy[2], _apz[2]);
  }
}

/**
 * Everything painted on one carriageway: centre line, lane lines, motorway edge lines, a bike
 * lane where Toronto really has one, and at every junction the road touches a crossing, a stop
 * bar and lane arrows on each approach.
 */
function emitRoadMarkings(C, rec) {
  if (rec.foot || rec.cls === 'service' || rec.cls === 'pedestrian') return;
  const mb = C.mb.roads;
  const G = C.stats.ground;
  const hw = rec.hw;
  if (hw < 2.6 || rec.len < 8) return;

  // --- centre line -------------------------------------------------------------------------
  if (rec.cls !== 'motorway' && hw >= 4.2) {
    setMat(mb, M.paintYellow);
    if (rec.w >= 12.5) {
      G.markings += emitSolidLine(C, rec, -0.21, -0.11, 1.0);
      G.markings += emitSolidLine(C, rec, 0.11, 0.21, 1.0);
    } else {
      G.markings += emitDashedLine(C, rec, 0, 0.06, 1.0);
    }
  }

  // --- lane lines and edge lines -------------------------------------------------------------
  const lanes = clamp(Math.round((hw - 0.55) / LANE_W), 1, 4);
  setMat(mb, M.paintWhite);
  for (let i = 1; i < lanes; i++) {
    const o = i * LANE_W;
    if (o > hw - 1.0) break;
    G.markings += emitDashedLine(C, rec, o, 0.06, 1.6);
    G.markings += emitDashedLine(C, rec, -o, 0.06, 1.6);
  }
  if (rec.cls === 'motorway') {
    G.markings += emitSolidLine(C, rec, hw - 0.44, hw - 0.32, 0.5);
    G.markings += emitSolidLine(C, rec, -(hw - 0.32), -(hw - 0.44), 0.5);
  }

  // --- bike lane ------------------------------------------------------------------------------
  // Toronto paints the lane green through the conflict zones only and marks it with a solid white
  // line elsewhere; modelling it that way is both cheaper and what is actually on the ground.
  if (rec.bike && hw >= 5.0) {
    const inner = hw - 2.05;
    setMat(mb, M.paintWhite);
    G.markings += emitSolidLine(C, rec, inner - 0.06, inner + 0.06, 0.5);
    setMat(mb, M.bikeGreen);
    for (let k = 0; k < rec.junc.length; k++) {
      const j = rec.junc[k];
      const a = Math.max(0, j.s - j.r - 5.0), b = Math.min(rec.len, j.s + j.r + 5.0);
      G.markings += emitStripe(C, rec, a, b, inner + 0.10, hw - 0.30);
      G.bikeLaneMetres += Math.max(0, b - a);
    }
  }

  // --- junction paint: crossings, stop bars, lane arrows ---------------------------------------
  for (let k = 0; k < rec.junc.length; k++) {
    const j = rec.junc[k];
    if (!j.J.cross) continue;
    for (let d = 0; d < 2; d++) {
      const sigma = d === 0 ? 1 : -1;      // this branch heads toward increasing/decreasing s
      const app = -sigma;                  // ...so traffic approaching the junction travels -sigma
      const nose = j.s + sigma * (j.r + XWALK_SETBACK);
      const far = j.s + sigma * (j.r + XWALK_SETBACK + XWALK_DEPTH);
      if (nose < 0.8 || nose > rec.len - 0.8 || far < 0 || far > rec.len) continue;

      // Crossing: bars run WITH the traffic and are spaced across the roadway.
      setMat(mb, M.paintWhite);
      const ladder = hash2(j.J.x, j.J.z, 5) < 0.45;
      let u = -hw + 0.35;
      while (u + ZEBRA_BAR < hw - 0.35) {
        G.markings += emitStripe(C, rec, nose, far, u, u + ZEBRA_BAR);
        u += ZEBRA_BAR + ZEBRA_GAP;
      }
      if (ladder) {
        G.markings += emitStripe(C, rec, nose, nose + 0.16, -hw + 0.35, hw - 0.35);
        G.markings += emitStripe(C, rec, far - 0.16, far, -hw + 0.35, hw - 0.35);
      }
      G.crosswalks++;

      // Stop bar, across the approach half only.
      const bar = far + sigma * 0.85;
      if (bar > 0.3 && bar < rec.len - 0.3) {
        G.markings += emitStripe(C, rec, bar, bar + sigma * STOP_BAR_W,
          app * 0.12, app * (hw - 0.32));
        G.stopBars++;
      }

      // Lane arrows, in the lanes nearest the centre line of the approach.
      const aS = bar + sigma * 7.5;
      if (aS > 2.5 && aS < rec.len - 2.5 && hw >= 5.2) {
        const roll = hash2(j.J.x + sigma, j.J.z, 9);
        emitArrow(C, rec, aS, app * (LANE_W * 0.5), app, 1,
          roll < 0.42 ? ARROW_TURN : ARROW_THRU);
        G.arrows++;
        if (lanes >= 2 && roll >= 0.42) {
          emitArrow(C, rec, aS, app * (LANE_W * 1.5), app, -1, ARROW_TURN);
          G.arrows++;
        }
      }
    }
  }
}

/* ============================================================== kerb ramps == */

// A dropped kerb with its flares and a tactile plate. (dx, dz) points DOWN the slope, i.e. from
// the sidewalk toward the carriageway.
function emitKerbRamp(C, x, z, dx, dz) {
  const mb = C.mb.sidewalks;
  const px = -dz, pz = dx;
  const hw = RAMP_W * 0.5;
  const g = C.groundY(x, z);
  const yT = g + ROAD_Y + CURB;
  const yB = g + ROAD_Y + 0.014;
  const bx = x + dx * RAMP_RUN * 0.5, bz = z + dz * RAMP_RUN * 0.5;
  const tx = x - dx * RAMP_RUN * 0.5, tz = z - dz * RAMP_RUN * 0.5;

  setMat(mb, M.curb);
  triUp(mb, tx - px * hw, yT, tz - pz * hw, tx + px * hw, yT, tz + pz * hw,
    bx + px * hw, yB, bz + pz * hw);
  triUp(mb, tx - px * hw, yT, tz - pz * hw, bx + px * hw, yB, bz + pz * hw,
    bx - px * hw, yB, bz - pz * hw);
  // Flares, so the ramp meets full kerb height at its sides instead of ending in a cliff.
  const fw = hw + 0.62;
  triUp(mb, tx - px * hw, yT, tz - pz * hw, bx - px * hw, yB, bz - pz * hw,
    tx - px * fw, yT, tz - pz * fw);
  triUp(mb, tx + px * hw, yT, tz + pz * hw, tx + px * fw, yT, tz + pz * fw,
    bx + px * hw, yB, bz + pz * hw);
  // Tactile plate across the bottom of the run.
  setMat(mb, M.tactile);
  const ax0 = bx - dx * 0.66, az0 = bz - dz * 0.66;
  const ax1 = bx - dx * 0.10, az1 = bz - dz * 0.10;
  const yP = yB + 0.010;
  triUp(mb, ax0 - px * hw, yP, az0 - pz * hw, ax0 + px * hw, yP, az0 + pz * hw,
    ax1 + px * hw, yP, az1 + pz * hw);
  triUp(mb, ax0 - px * hw, yP, az0 - pz * hw, ax1 + px * hw, yP, az1 + pz * hw,
    ax1 - px * hw, yP, az1 - pz * hw);
  C.stats.ground.kerbRamps++;
}

// One ramp per corner: on the bisector between each adjacent pair of branches.
function emitJunctionKerbs(C, J) {
  const nb = J.dirs.length / 2;
  if (nb < 3 || J.r < 3.2) return;
  const ang = [];
  for (let i = 0; i < J.dirs.length; i += 2) ang.push(Math.atan2(-J.dirs[i + 1], J.dirs[i]));
  ang.sort((a, b) => a - b);
  for (let i = 0; i < ang.length; i++) {
    const a0 = ang[i];
    const a1 = i + 1 < ang.length ? ang[i + 1] : ang[0] + TAU;
    const gap = a1 - a0;
    if (gap < 0.55) continue;                       // two branches too close to fit a corner
    const phi = a0 + gap * 0.5;
    const cu = Math.cos(phi), cv = Math.sin(phi);   // plan space: u east, v north
    const rad = J.r + 2.55;
    const x = J.x + cu * rad, z = J.z - cv * rad;
    if (inFootprint(C, x, z, 0.9)) continue;
    if (!C.occ.claim(x, z, 1.15)) continue;
    emitKerbRamp(C, x, z, -cu, cv);                 // down-slope points back at the junction
    // A crossing corner: where somebody waiting for a light actually stands. Set back far enough
    // from the ramp's own claim that a figure and a tactile plate do not want the same square.
    const back = J.r + 4.4;
    C.corners.push({
      x: J.x + cu * back, z: J.z - cv * back, dx: -cu, dz: cv, signal: !!J.signal,
    });
  }
}

/* ================================================================ pavement == */

const SW_TEST_STEP = 0.75;         // how finely the kerb line is tested against other streets
const SW_MIN_RUN = 1.2;            // shorter than this and a stub of pavement is worse than none
const SW_STUB = 0.60;              // interior stations this close to a cut end are dropped: the
                                   // stub segment they leave is what a mitre folds on

/**
 * One run of pavement, from arc length s0 to s1 on one side of a road. The run keeps the road's
 * own vertex spacing — its interior stations are the polyline's own vertices — and adds only the
 * two cut ends, so cutting the band costs a handful of vertices rather than a resample.
 */
function emitBandRun(C, rec, s0, s1, inner, outer, sgn, yWalk) {
  if (!(s1 - s0 > SW_MIN_RUN)) return;
  let pts = [];
  const push = (s) => {
    const m = recSample(rec, s);
    pts.push([m.x, m.z]);
  };
  push(s0);
  const arr = rec.s;
  // A cut end landing a few centimetres before the road's own next vertex leaves a stub segment
  // the mitre has to turn on; skip any interior station that close to either end. The kerb line
  // loses nothing — the two points are the same place — and the corner stops folding.
  for (let k = 0; k < arr.length; k++) {
    if (arr[k] > s0 + SW_STUB && arr[k] < s1 - SW_STUB) push(arr[k]);
  }
  push(s1);
  if (pts.length < 2) return;
  // Rebuilt rather than interpolated from the road's own frames: the run's point spacing is not
  // the road's, and the miter clamp is a function of the spacing it is actually mitring. At the
  // interior stations — which ARE the road's vertices, with the road's own neighbours either side
  // — this reproduces the road's frames exactly, so kerb and carriageway still agree.
  const reach = Math.max(Math.abs(inner), Math.abs(outer));
  pts = pruneSpikes(pts, reach);
  if (pts.length < 2) return;
  const frames = polyFrames(pts, reach);
  const mb = C.mb.sidewalks;
  const a = inner * sgn, b = outer * sgn;
  setMat(mb, M.sidewalk);
  emitRibbon(mb, pts, frames,
    sgn > 0 ? [{ o: a, dy: 0 }, { o: b, dy: 0 }] : [{ o: b, dy: 0 }, { o: a, dy: 0 }], yWalk);
  setMat(mb, M.curb);
  emitSkirt(mb, pts, frames, a, yWalk, CURB, -sgn);
  C.stats.ground.kerbMetres += s1 - s0;
}

/**
 * The pavement each side of a carriageway, CUT wherever it would run out across another street.
 *
 * Run straight through, a synthetic sidewalk ribbon lays a 0.16 m kerbed slab clean across the
 * crossing carriageway at every junction in the city — a pale wedge over the asphalt with a kerb
 * face standing in the traffic lane, and the crossing's own zebra and stop bar buried underneath
 * it. Real pavement stops at the kerb line, which is what the kerb ramps and crossings assume.
 */
function emitSidewalkBands(C, rec) {
  const sw = SIDEWALK_W[rec.cls] || 0;
  if (!(sw > 0) || rec.bridge || rec.foot) return;
  const inner = rec.hw + 0.25;
  const outer = inner + sw;
  const mid = (inner + outer) * 0.5;
  const len = rec.len;
  if (!(len > SW_MIN_RUN)) return;
  const yWalk = (x, z) => recBase(C, rec, x, z) + ROAD_Y + CURB;
  const steps = Math.max(1, Math.ceil(len / SW_TEST_STEP));
  const dS = len / steps;
  for (let sd = 0; sd < 2; sd++) {
    const sgn = sd === 0 ? 1 : -1;
    let runStart = -1;
    for (let k = 0; k <= steps; k++) {
      const s = k * dS;
      const m = recSample(rec, s);
      const o = mid * sgn * m.sc;
      // The band's own road is skipped by id: a road that curves back on itself would otherwise
      // delete its own pavement.
      const bx = m.x + m.sx * o, bz = m.z + m.sz * o;
      const blocked = onForeignCarriageway(C, bx, bz, 0, rec.id) || pavementTaken(C, bx, bz, rec);
      if (!blocked) { if (runStart < 0) runStart = k === 0 ? 0 : s - dS * 0.5; continue; }
      C.stats.pavementOverRoad++;
      if (runStart >= 0) {
        emitBandRun(C, rec, runStart, s - dS * 0.5, inner, outer, sgn, yWalk);
        runStart = -1;
      }
    }
    if (runStart >= 0) emitBandRun(C, rec, runStart, len, inner, outer, sgn, yWalk);
  }
}

/* ================================================================ walkways == */

/**
 * A real OSM footway. Runs duplicating a synthetic sidewalk ribbon or crossing a carriageway have
 * already been cut out; what is left is laid as a paved walk, raised onto a 0.16 m kerb where it
 * abuts a street and flush with the ground where it is a park or plaza path.
 */
function emitFootway(C, pts, w, kerbed) {
  if (pts.length < 2) return;
  const mb = C.mb.sidewalks;
  const hw = clamp(w, 1.2, 6) * 0.5;
  pts = pruneSpikes(pts, hw);
  if (pts.length < 2) return;
  const frames = polyFrames(pts, hw);
  const dy = kerbed ? ROAD_Y + CURB : PATH_Y;
  const yAt = (x, z) => C.groundY(x, z) + dy;
  setMat(mb, kerbed ? M.sidewalk : M.path);
  emitRibbon(mb, pts, frames, [{ o: -hw, dy: 0 }, { o: hw, dy: 0 }], yAt);
  let len = 0;
  for (let k = 1; k < pts.length; k++) {
    len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  }
  if (kerbed) {
    setMat(mb, M.curb);
    emitSkirt(mb, pts, frames, -hw, yAt, CURB, -1);
    emitSkirt(mb, pts, frames, hw, yAt, CURB, 1);
    C.stats.ground.kerbMetres += len * 2;
  }
  C.stats.ground.footwayMetres += len;
  C.stats.ground.footwayRuns++;
  if (len > 8) C.walks.push({ pts, w: hw * 2, kerbed });
}

// Split one footway into the runs that are worth building, then build them.
function buildFootway(C, r) {
  const w = clamp(isNum(r.w) ? r.w : 2.4, 1.4, 6);
  const pts = polyResample(r.p, ROAD_MAX_SEG);
  let run = [];
  let kerbed = false;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], z = pts[i][1];
    if (alreadyPaved(C, x, z) || footprintDepth(C, x, z) > 1.6) {
      if (run.length >= 2) emitFootway(C, run, w, kerbed);
      run = []; kerbed = false;
      continue;
    }
    run.push(pts[i]);
    if (nearestRoad(C, x, z, 13) < 13) kerbed = true;
  }
  if (run.length >= 2) emitFootway(C, run, w, kerbed);
}

/* ========================================================= streetcar track == */

// The four faces along a run of overhead contact wire, as a square-section member between two
// world points. 24 verts; back-face culling drops two of the four from any angle.
const _wc = new Float64Array(24);
const _wf = [5, 1, 3, 7, 0, 4, 6, 2, 6, 7, 3, 2, 0, 1, 5, 4];

function emitWireSpan(C, ax, ay, az, bx, by, bz) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0.05)) return;
  dx /= len; dy /= len; dz /= len;
  let rx = -dz, rz = dx;
  const rl = Math.hypot(rx, rz);
  if (rl > 1e-5) { rx /= rl; rz /= rl; } else { rx = 1; rz = 0; }
  const ux = dy * rz, uy = dz * rx - dx * rz, uz = -dy * rx;
  for (let i = 0; i < 8; i++) {
    const sr = (i & 1) ? WIRE_R : -WIRE_R;
    const su = (i & 2) ? WIRE_R : -WIRE_R;
    const ex = (i & 4) ? bx : ax, ey = (i & 4) ? by : ay, ez = (i & 4) ? bz : az;
    _wc[i * 3] = ex + rx * sr + ux * su;
    _wc[i * 3 + 1] = ey + uy * su;
    _wc[i * 3 + 2] = ez + rz * sr + uz * su;
  }
  const mb = C.mb.props;
  for (let f = 0; f < 4; f++) {
    const o = f * 4;
    const a = _wf[o] * 3, b = _wf[o + 1] * 3, c = _wf[o + 2] * 3, d = _wf[o + 3] * 3;
    mb.tri(_wc[a], _wc[a + 1], _wc[a + 2], _wc[b], _wc[b + 1], _wc[b + 2],
      _wc[c], _wc[c + 1], _wc[c + 2]);
    mb.tri(_wc[a], _wc[a + 1], _wc[a + 2], _wc[c], _wc[c + 1], _wc[c + 2],
      _wc[d], _wc[d + 1], _wc[d + 2]);
  }
  C.stats.ground.wireMetres += len;
}

function nearestTram(C, x, z) {
  let best = 36;
  C.tramIdx.query(x, z, 6, (s) => {
    const d2 = distToSeg2(x, z, s[0], s[1], s[2], s[3]);
    if (d2 < best) best = d2;
  });
  return Math.sqrt(best);
}

/**
 * One tram way: rails at Toronto's 1.495 m gauge sitting flush in the asphalt where the track is
 * embedded in a street and on their own slab where it runs in a reserved right of way, catenary
 * poles down the route, and the contact wire strung between their documented attachment points.
 */
function emitTramRoute(C, raw) {
  const pts = pruneSpikes(polyResample(raw, ROAD_MAX_SEG), TRACK_SLAB_HW);
  const n = pts.length;
  if (n < 2) return;
  const frames = polyFrames(pts, TRACK_SLAB_HW);
  const mb = C.mb.rails;

  // Per-vertex: the crown of the street the track is set into, or -1 in a reserved ROW.
  const crown = new Float64Array(n);
  const embedded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = carriagewayCrown(C, pts[i][0], pts[i][1]);
    embedded[i] = c >= 0 ? 1 : 0;
    crown[i] = c >= 0 ? c : 0;
  }

  // Track slab under the stretches that are NOT in a street. It stands TRACK_SLAB_Y above the road
  // datum so that where it clips the edge of a carriageway the two are a step apart rather than
  // coplanar — 1.72 m of slab z-fighting the asphalt shimmers along the whole reserved right of way.
  setMat(mb, M.trackBed);
  const yBed = (x, z) => C.groundY(x, z) + ROAD_Y + TRACK_SLAB_Y;
  const slab = (a, b) => {
    if (b - a < 2) return;
    const seg = pts.slice(a, b);
    emitRibbon(mb, seg, polyFrames(seg, TRACK_SLAB_HW),
      [{ o: -TRACK_SLAB_HW, dy: 0 }, { o: TRACK_SLAB_HW, dy: 0 }], yBed);
  };
  let run = -1;
  for (let i = 0; i < n; i++) {
    if (!embedded[i]) { if (run < 0) run = i; continue; }
    if (run >= 0) slab(run, i);
    run = -1;
  }
  if (run >= 0) slab(run, n);

  // Running rails. The head stands RAIL_PROUD above whatever it is set into, which is what makes an
  // embedded rail catch the light along a whole block. In a street that datum is the crown of the
  // asphalt; on a reserved right of way it is the slab, or the rail would sink into its own bed.
  setMat(mb, M.rail);
  const yRail = (x, z, px, pz, i) =>
    C.groundY(x, z) + ROAD_Y + (embedded[i] ? crown[i] : TRACK_SLAB_Y) + RAIL_PROUD;
  const half = TRAM_GAUGE * 0.5;
  for (let k = 0; k < 2; k++) {
    const c = k === 0 ? -half : half;
    emitRibbon(mb, pts, frames,
      [{ o: c - TRAM_RAIL_W * 0.5, dy: 0 }, { o: c + TRAM_RAIL_W * 0.5, dy: 0 }], yRail);
  }

  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = arc[n - 1];
  C.stats.ground.tramMetres += total;
  if (total < 14) return;

  // Catenary poles and the wire between them.
  let prevX = 0, prevY = 0, prevZ = 0, havePrev = false;
  const count = Math.max(1, Math.round(total / TRAM_POLE_SPACING));
  for (let p = 0; p <= count; p++) {
    const s = (p / count) * total;
    let i = 0;
    while (i + 2 < n && arc[i + 1] < s) i++;
    const span = arc[i + 1] - arc[i];
    const t = span > EPS ? clamp((s - arc[i]) / span, 0, 1) : 0;
    const tx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
    const tz = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let ux = frames[i * 3] + (frames[(i + 1) * 3] - frames[i * 3]) * t;
    let uz = frames[i * 3 + 1] + (frames[(i + 1) * 3 + 1] - frames[i * 3 + 1]) * t;
    const ul = Math.hypot(ux, uz);
    if (ul > EPS) { ux /= ul; uz /= ul; } else { ux = 1; uz = 0; }

    // WHERE THE POLE GOES. Two real arrangements, and the difference is not cosmetic: a
    // 1.86 m bracket cannot reach a track in the middle of King Street, so putting the pole a
    // bracket's length off the rails would stand it in a running lane.
    //   * reserved right of way (Spadina, Queens Quay): pole beside the track, bracket straight
    //     over it, on whichever side is clear of the other track of the pair — a Toronto pair
    //     sits about 3.2 m apart.
    //   * embedded in a street (King, Queen, Dundas): pole on the KERB, and a transverse span
    //     wire carries the contact wire back over the rails.
    const inStreet = carriagewayCrown(C, tx, tz) >= 0;
    let px = tx + ux * CATENARY_REACH, pz = tz + uz * CATENARY_REACH;
    let ok = false, spanned = false;
    if (inStreet) {
      let bestD = Infinity;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        let d = 1.5;
        while (d < 22 && onCarriageway(C, tx + ux * d * sgn, tz + uz * d * sgn, 0)) d += 0.5;
        if (d >= 22 || d >= bestD) continue;
        const cx = tx + ux * (d + 1.35) * sgn, cz = tz + uz * (d + 1.35) * sgn;
        if (inFootprint(C, cx, cz, 0.6)) continue;
        bestD = d; px = cx; pz = cz; ok = true; spanned = true;
      }
    }
    if (!ok) {
      let best = -1e9;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const cx = tx + ux * CATENARY_REACH * sgn, cz = tz + uz * CATENARY_REACH * sgn;
        let score = nearestTram(C, cx, cz);
        if (inFootprint(C, cx, cz, 0.5)) score -= 40;
        if (score > best) { best = score; px = cx; pz = cz; ok = score > -30; }
      }
      spanned = false;
    }
    const base = C.groundY(px, pz) + ROAD_Y;
    const wy = base + TRAM_POLE_H - CATENARY_DROP;
    if (ok && !deckFits(C, px, pz, base, PROP_H.catenaryPole)) ok = false;
    if (ok && C.occ.claim(px, pz, 0.95)) {
      // The bracket arm reaches along local +X, i.e. straight at the track centreline.
      const yaw = Math.atan2(-(tz - pz), tx - px);
      const ax = px + CATENARY_REACH * Math.cos(yaw);
      const az = pz - CATENARY_REACH * Math.sin(yaw);
      // Audit: props.js's documented attachment point must lie on the straight line from the pole
      // to the rails, or the wire hangs off the side of the insulator.
      const run = Math.max(EPS, Math.hypot(tx - px, tz - pz));
      const err = Math.abs((ax - px) * (tz - pz) - (az - pz) * (tx - px)) / run;
      if (err > 0.02) C.stats.wireOffTrack++;
      if (err > C.stats.wireMaxError) C.stats.wireMaxError = err;
      appendCatenaryPole(C.mb.props, px, base, pz, yaw, TRAM_POLE_H);
      noteProp(C, 'catenaryPole');
      C.auditRoad.push(px, pz);
      C.stats.ground.tramPoles++;
      if (spanned) {
        setMat(C.mb.props, M.wire);
        emitWireSpan(C, ax, wy, az, tx, wy, tz);
      }
    }
    if (havePrev) {
      // Two members per span with a drop at midspan: a straight wire reads as a wire, a sagging
      // one reads as Toronto.
      const mx = (prevX + tx) * 0.5, mz = (prevZ + tz) * 0.5;
      const my = (prevY + wy) * 0.5 - WIRE_SAG;
      setMat(C.mb.props, M.wire);
      emitWireSpan(C, prevX, prevY, prevZ, mx, my, mz);
      emitWireSpan(C, mx, my, mz, tx, wy, tz);
    }
    prevX = tx; prevY = wy; prevZ = tz; havePrev = true;
  }
}

// Streetcar stops: an island platform where the track has its own right of way, a glazed shelter
// on the sidewalk where it runs in the street.
function placeTramStops(C, raw) {
  const pts = pruneSpikes(polyResample(raw, ROAD_MAX_SEG), TRACK_SLAB_HW);
  const n = pts.length;
  if (n < 4) return;
  const frames = polyFrames(pts, TRACK_SLAB_HW);
  let acc = 0;
  for (let i = 2; i < n - 2; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc < 330) continue;
    acc = 0;
    const x0 = pts[i][0], z0 = pts[i][1];
    const sx = frames[i * 3], sz = frames[i * 3 + 1];
    const inStreet = carriagewayCrown(C, x0, z0) >= 0;
    const off = inStreet ? 9.0 : 3.4;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const x = x0 + sx * off * sgn, z = z0 + sz * off * sgn;
      const kind = inStreet ? 'transitShelter' : 'platformShelter';
      const y = reserve(C, kind, x, z, inStreet ? 2.8 : 3.2, inStreet ? 0.4 : -1);
      if (!isNum(y)) continue;
      // Long axis runs along the track; local +X faces back at it.
      const ox = -sx * sgn, oz = -sz * sgn;
      const yaw = Math.atan2(-oz, ox);
      const seat = y + (inStreet ? kerbSeat(C, x, z) : ROAD_Y);
      if (inStreet) appendTransitShelter(C.mb.props, x, seat, z, yaw, 5.0);
      else appendPlatformShelter(C.mb.props, x, seat, z, yaw, 16.0);
      // Somewhere for the people pass to put the people waiting. `yaw` faces back at the track,
      // so a passenger placed in front of the shelter stands between it and the platform edge.
      C.stations.push({ x, y: seat, z, yaw, len: inStreet ? 5.0 : 16.0 });
      break;
    }
  }
}

/* ================================================== elevated deck cover == */
/**
 * THE GARDINER PROBLEM.
 *
 * The expressway is a road record with `b: 1`, so it is built as a deck 8.2 m up with a 1.9 m
 * structural depth hanging under it. Lake Shore Boulevard, Harbour Street and half a dozen cross
 * streets run underneath at grade — and every one of them is an ordinary road record that gets an
 * ordinary 9.6 m cobra lamp every 28 m, planted on the ground and driven straight up through the
 * expressway. The expressway's OWN lamps were worse: a bridge record's furniture was seated with
 * groundY(), so the Gardiner's street lighting stood on the ground beneath the Gardiner and came
 * up through its deck.
 *
 * The fix needs one thing the rest of the city never asks for: what is directly overhead. This
 * index answers that. Every deck segment is filed with the height of its SOFFIT — the underside
 * of the structure, not the running surface, because that is what a lamp mast hits — and
 * deckHeadroom() reports the clear air above any point on the ground.
 *
 * With that, three rules:
 *   * a prop that does not fit under the deck is refused (reserve() does this for every prop in
 *     the city, using its real height, not just lamps);
 *   * a LAMP that does not fit is rebuilt as a low-mast fixture that does, which is what is
 *     actually bolted under the Gardiner in real life;
 *   * the deck itself gets its lighting placed ON its carriageway, at deck level.
 * The audit at the end of the load re-measures every prop against the finished index.
 */

const DECK_CLEAR = 0.70;           // air a prop must leave under a soffit: its seat plus a margin
const UNDER_DECK_MIN = 3.2;        // shorter than this and it is not a street lamp any more
const DECK_EDGE_INSET = 0.9;       // how far in from the deck edge its own lamps stand
const DECK_LAMP_H = { motorway: 11.0, major: 9.0, minor: 8.0, service: 7.0 };

// How far each lamp's geometry reaches ABOVE its nominal mast height, from props.js: a cobra's
// arm crests 0.93 m over the mast, a pedestrian lamp's 0.32 m, an acorn's globe is inside its
// own figure. Under a soffit the difference between the mast and the top of the arm is the
// difference between a lamp that fits and one that does not.
const LAMP_OVER = { cobraLamp: 1.00, pedestrianLamp: 0.35, acornLamp: 0.10 };

// Standing height of each prop class, metres above its own seat. Used to decide what fits under a
// deck; deliberately rounded UP, because the cost of over-estimating is one missing litter bin and
// the cost of under-estimating is a mast through the expressway.
const PROP_H = {
  cobraLamp: 13.0, pedestrianLamp: 5.6, acornLamp: 5.0, trafficSignal: 7.2, signPost: 3.2,
  catenaryPole: 8.8, streetTree: 7.0, parkTree: 10.0, shrub: 1.8, planter: 1.6,
  transitShelter: 3.0, platformShelter: 3.6, litterBin: 1.2, bench: 1.0, bikeRing: 1.0,
  hydrant: 1.0, parkingMachine: 1.6, newsBox: 1.4, mailbox: 1.4, utilityBox: 1.6, bollard: 1.1,
  sandwichBoard: 1.3, patioSet: 2.6, dumpster: 2.0, scaffold: 6.8, crane: 96.0, flagPole: 12.5,
  parkedCar: 2.1, lotCar: 2.1, railCar: 5.2, ferryDock: 4.0, boat: 6.0, grate: 0.1, manhole: 0.1,
  pedestrian: 2.1, cyclist: 2.2, dogWalker: 2.1,
};

// Soffit interpolation along one filed segment: [ax, az, bx, bz, halfWidth, soffitA, soffitB].
function deckSoffitAbove(C, x, z, y) {
  const idx = C.deckIdx;
  let best = Infinity;
  if (!idx) return best;
  idx.query(x, z, 0, (s) => {
    const hw = s[4];
    const dx = s[2] - s[0], dz = s[3] - s[1];
    const l2 = dx * dx + dz * dz;
    let t = 0;
    if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
    const qx = s[0] + dx * t - x, qz = s[1] + dz * t - z;
    if (qx * qx + qz * qz > hw * hw) return;
    const soffit = s[5] + (s[6] - s[5]) * t;
    if (soffit > y && soffit < best) best = soffit;
  });
  return best;
}

/** Metres of clear air above the ground at (x, z) before the underside of a deck. */
function deckHeadroom(C, x, z) {
  const g = C.groundY(x, z);
  const soffit = deckSoffitAbove(C, x, z, g);
  if (soffit === Infinity) return Infinity;
  const head = soffit - g;
  const D = C.stats.deck;
  if (!D.minClearance || head < D.minClearance) D.minClearance = head;
  return head;
}

/** The same question asked from a height that is not the ground — a prop standing on a deck. */
function deckHeadroomAt(C, x, z, y) {
  const soffit = deckSoffitAbove(C, x, z, y + 0.25);
  return soffit === Infinity ? Infinity : soffit - y;
}

/**
 * Deck test for the prop classes that claim their own site instead of going through reserve():
 * catenary poles, rolling stock, parked cars, cranes. Records the prop for the end-of-load audit
 * on success, counts the refusal on failure.
 */
function deckFits(C, x, z, y, h) {
  if (deckHeadroomAt(C, x, z, y) < h + DECK_CLEAR) {
    C.stats.deck.propsSkipped++;
    return false;
  }
  C.auditDeck.push(x, z, y, h);
  return true;
}

/**
 * Street lighting for an elevated carriageway, standing on the deck itself.
 *
 * These are not ground props: they do not take a terrain height, they are not in the occupancy
 * grid (which is a plan grid and would have them fighting whatever stands on the ground 8 m
 * below), and they are not audited against building footprints, for the same reason the roofscape
 * is not. They ARE audited against decks above them, because the Gardiner's own ramps cross over
 * each other.
 */
function placeDeckLamps(C, rec) {
  if (!rec.bridge || !rec.deck || rec.foot) return;
  const spacing = LAMP_SPACING[rec.cls] || 46;
  if (!(rec.len > spacing * 0.6)) return;
  const mbP = C.mb.props;
  const o0 = Math.max(1.0, rec.hw - DECK_EDGE_INSET);
  const want = DECK_LAMP_H[rec.cls] || 8.0;
  let side = 1;
  for (let s = spacing * 0.5; s < rec.len; s += spacing) {
    const m = recSample(rec, s);
    const sg = side;
    side = -side;
    const o = o0 * sg;
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    const y = surfaceY(C, rec, m, o);
    const top = want + LAMP_OVER.cobraLamp;
    if (deckHeadroomAt(C, x, z, y) < top + DECK_CLEAR) { C.stats.deck.propsSkipped++; continue; }
    // The boom reaches back in over the carriageway, exactly as it does at grade.
    const yaw = Math.atan2(m.sz * sg, -m.sx * sg);
    const tipX = x + Math.cos(yaw) * 3.3, tipZ = z - Math.sin(yaw) * 3.3;
    if (Math.hypot(tipX - m.x, tipZ - m.z) >= Math.hypot(x - m.x, z - m.z)) C.stats.boomsMisaimed++;
    appendCobraLamp(mbP, x, y, z, yaw, want);
    noteProp(C, 'cobraLamp');
    C.stats.deck.deckLamps++;
    C.auditDeck.push(x, z, y, top);
  }
}

/* =============================================================== furniture == */

// Every generator below walks the same kerb line. `phase` staggers them so a bin, a bench and a
// tree never arrive at the same metre, and the occupancy grid catches whatever still collides.
function placeFurniture(C, rec) {
  const cls = rec.cls;
  const mbP = C.mb.props;
  const hw = rec.hw;
  const rng = C.rng;
  const heritage = rec.heritage;

  /* --- lighting: cobra heads on the arterials, pedestrian poles on the side streets --- */
  // An elevated carriageway is lit from its own deck, not from the ground eight metres below it.
  if (rec.bridge) { placeDeckLamps(C, rec); return; }

  const spacing = heritage ? ACORN_SPACING : LAMP_SPACING[cls];
  if (spacing && rec.len > spacing * 0.6) {
    const kerb = hw + 1.55;
    let side = 1;
    for (let s = spacing * 0.5; s < rec.len; s += spacing) {
      const m = recSample(rec, s);
      const o = kerb * side;
      side = -side;
      const x = m.x + m.sx * o, z = m.z + m.sz * o;
      let kind = heritage ? 'acornLamp' : (cls === 'minor' ? 'pedestrianLamp' : 'cobraLamp');
      let mast = heritage ? 4.6 : (cls === 'minor' ? 5.2 : (cls === 'motorway' ? 12.0 : 9.6));
      let over = LAMP_OVER[kind];
      // Under a deck the fixture is not skipped, it is SHORTENED: the real Lake Shore runs low
      // mast lighting under the Gardiner, and a dark street under an expressway is its own bug.
      const head = deckHeadroom(C, x, z);
      if (head < mast + over + DECK_CLEAR) {
        kind = 'pedestrianLamp';
        over = LAMP_OVER.pedestrianLamp;
        const fit = head - DECK_CLEAR - CURB - over;
        if (fit < UNDER_DECK_MIN) { C.stats.deck.propsSkipped++; continue; }
        mast = Math.min(mast, fit);
        C.stats.deck.propsShortened++;
      }
      const y = reserve(C, kind, x, z, 0.85, 0.35, mast + over);
      if (!isNum(y)) continue;
      const base = y + kerbSeat(C, x, z);
      if (kind === 'acornLamp') { appendAcornLamp(mbP, x, base, z, mast); continue; }
      // The boom reaches from the kerb back out over the carriageway.
      const sg = o < 0 ? -1 : 1;
      const yaw = Math.atan2(m.sz * sg, -m.sx * sg);
      // Audit: the boom tip must end up nearer the carriageway centre than the mast, or the whole
      // city has its lamps hanging over the shopfronts.
      const tipX = x + Math.cos(yaw) * 3.3, tipZ = z - Math.sin(yaw) * 3.3;
      if (Math.hypot(tipX - m.x, tipZ - m.z) >= Math.hypot(x - m.x, z - m.z)) C.stats.boomsMisaimed++;
      if (kind === 'pedestrianLamp') appendPedestrianLamp(mbP, x, base, z, yaw, mast);
      else appendCobraLamp(mbP, x, base, z, yaw, mast);
    }
  }

  const sw = SIDEWALK_W[cls] || 0;
  if (!sw) return;

  const zone = hw + 0.25 + sw * 0.34;
  const gutter = hw - 0.40;

  for (let sd = 0; sd < 2; sd++) {
    const sgn = sd === 0 ? 1 : -1;
    const o = zone * sgn;

    // Every piece faces the street: local +X is "out" by the props.js contract, and out of a
    // sidewalk means across the kerb.
    const gen = (kind, pitch, phase, radius, fn) => {
      if (pitch <= 0 || rec.len < pitch * 0.35) return;
      for (let s = phase % pitch; s < rec.len; s += pitch) {
        const m = recSample(rec, s);
        const x = m.x + m.sx * o, z = m.z + m.sz * o;
        const y = reserve(C, kind, x, z, radius, 0.35);
        if (!isNum(y)) continue;
        fn(x, y + kerbSeat(C, x, z), z, Math.atan2(m.sz * sgn, -m.sx * sgn));
      }
    };

    gen('litterBin', BIN_SPACING, 18 + sd * 47, 0.72,
      (x, y, z, yaw) => appendLitterBin(mbP, x, y, z, yaw));
    gen('bench', BENCH_SPACING, 55 + sd * 63, 1.15, (x, y, z, yaw) => {
      appendBench(mbP, x, y, z, yaw);
      C.benches.push({ x, y, z, yaw });
    });
    gen('bikeRing', RING_SPACING, 33 + sd * 31, 0.45,
      (x, y, z, yaw) => appendBikeRing(mbP, x, y, z, yaw));
    gen('hydrant', HYDRANT_SPACING, 12 + sd * 35, 0.42,
      (x, y, z, yaw) => appendHydrant(mbP, x, y, z, yaw));
    gen('planter', PLANTER_SPACING, 76 + sd * 84, 0.9,
      (x, y, z) => appendPlanter(mbP, rng, x, y, z, 1.05 + rng() * 0.5));
    gen('parkingMachine', METER_SPACING, 41 + sd * 56, 0.45,
      (x, y, z, yaw) => appendParkingMachine(mbP, x, y, z, yaw));
    gen('newsBox', NEWSBOX_SPACING, 96 + sd * 107, 0.45,
      (x, y, z, yaw) => appendNewsBox(mbP, rng, x, y, z, yaw));
    gen('mailbox', MAILBOX_SPACING, 140 + sd * 215, 0.6,
      (x, y, z, yaw) => appendMailbox(mbP, x, y, z, yaw));
    gen('utilityBox', CABINET_SPACING, 118 + sd * 134, 0.9,
      (x, y, z, yaw) => appendUtilityBox(mbP, rng, x, y, z, yaw));
    if (rec.commercial && cls !== 'minor') {
      gen('streetTree', TREE_SPACING, 9 + sd * 13, 1.30,
        (x, y, z) => appendStreetTree(mbP, rng, x, y, z, 0.88 + rng() * 0.5));
    }
    if (cls === 'major' && rec.commercial) {
      gen('bollard', 380, 21 + sd * 19, 0.35, (x, y, z) => appendBollard(mbP, x, y, z));
    }

    // Gutter hardware. The catch basin sits against the kerb face; it and the manhole below are
    // ON the carriageway on purpose, so they take the road surface height, not the sidewalk's.
    // Basins go on the arterials, which is where the gutters that need draining actually are.
    const go = gutter * sgn;
    for (let s = 22 + sd * 32; cls === 'major' && s < rec.len; s += GRATE_SPACING) {
      const m = recSample(rec, s);
      const x = m.x + m.sx * go, z = m.z + m.sz * go;
      if (inFootprint(C, x, z, 0.4) || !C.occ.claim(x, z, 0.5)) continue;
      appendGrate(mbP, x, surfaceY(C, rec, m, go) + GUTTER_LIFT, z,
        Math.atan2(m.sz * sgn, -m.sx * sgn));
      noteProp(C, 'grate');
      C.auditRoad.push(x, z);
    }
  }

  for (let s = 46; s < rec.len; s += MANHOLE_SPACING) {
    const m = recSample(rec, s);
    const o = hw * (hash2(m.x, m.z, 21) < 0.5 ? -0.45 : 0.45);
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    if (inFootprint(C, x, z, 0.3) || !C.occ.claim(x, z, 0.55)) continue;
    appendManhole(mbP, x, surfaceY(C, rec, m, o) + GUTTER_LIFT, z);
    noteProp(C, 'manhole');
    C.auditRoad.push(x, z);
  }
}

// Signal heads and a street-name blade at the junctions that warrant them.
function placeJunctionProps(C, J) {
  const mbP = C.mb.props;
  const sx = J.x + Math.cos(J.signAng) * (J.r + 5.0);
  const sz = J.z - Math.sin(J.signAng) * (J.r + 5.0);
  const sy = reserve(C, 'signPost', sx, sz, 0.5, 0.3);
  if (isNum(sy)) appendSignPost(mbP, C.rng, sx, sy + kerbSeat(C, sx, sz), sz, J.signAng);
  if (!J.signal) return;
  const dirs = J.dirs;
  const want = Math.min(dirs.length / 2, 2);
  for (let i = 0; i < want; i++) {
    const dx = dirs[i * 2], dz = dirs[i * 2 + 1];
    // Near-side right-hand corner of the approach this branch carries toward the junction.
    const rx = dz, rz = -dx;
    const x = J.x + dx * (J.r + 2.9) + rx * (J.r + 1.9);
    const z = J.z + dz * (J.r + 2.9) + rz * (J.r + 1.9);
    const y = reserve(C, 'trafficSignal', x, z, 1.3, 0.3);
    if (!isNum(y)) continue;
    // props.js: the lamp faces look along world (-sin yaw, 0, -cos yaw). Point them back up the
    // approach, which puts the mast arm out across it.
    appendTrafficSignal(mbP, x, y + kerbSeat(C, x, z), z, Math.atan2(-dx, -dz),
      clamp(J.r + 1.2, 3.0, 11.0));
  }
}

/* ================================================================ vehicles == */

// Kerb-lane parking — the one prop class that belongs ON the carriageway.
function placeKerbCars(C, rec) {
  if (rec.bridge || rec.foot || rec.cls === 'motorway' || rec.cls === 'pedestrian') return;
  if (rec.hw < 4.6 || rec.len < 22) return;
  const rng = C.rng;
  const mbP = C.mb.props;
  const o0 = rec.hw - 1.02;
  for (let sd = 0; sd < 2; sd++) {
    const sgn = sd === 0 ? 1 : -1;
    const o = o0 * sgn;
    for (let s = 6 + sd * 3.3; s < rec.len - 6; s += CAR_SPACING) {
      if (rng() > CAR_FILL) continue;
      if (nearJunction(rec, s, 7.0)) continue;
      const m = recSample(rec, s);
      const x = m.x + m.sx * o, z = m.z + m.sz * o;
      if (inFootprint(C, x, z, 0.4)) continue;
      // ISLANDS: private cars are banned on the Toronto Islands, and a kerbside row of them on
      // Lakeshore Avenue would be the single most obviously wrong thing down there.
      if (harbourCarFree(C.harbour, x, z)) continue;
      if (!deckFits(C, x, z, surfaceY(C, rec, m, o), PROP_H.parkedCar)) continue;
      if (!C.occ.claim(x, z, 2.6)) continue;
      // Cars face the direction of travel of the lane they sit in. props.js: the car's length
      // runs along local Z, so yaw = atan2(dx, dz) points it along (dx, dz).
      const fx = m.sz * sgn, fz = -m.sx * sgn;
      const r = rng();
      const kind = r < 0.56 ? 'sedan' : (r < 0.80 ? 'suv' : (r < 0.93 ? 'van' : 'taxi'));
      appendParkedCar(mbP, rng, x, surfaceY(C, rec, m, o), z, Math.atan2(fx, fz), kind);
      noteProp(C, 'parkedCar');
      C.auditRoad.push(x, z);
    }
  }
}

// Surface lots: rows of stalls aligned to the lot's own longest edge.
function placeLotCars(C, part, cap) {
  // ISLANDS: the island car parks are for the park's own service vehicles, and filling them with
  // commuter cars on a chain of islands you can only reach by ferry is a story hole.
  if (harbourCarFree(C.harbour, part.bbox ? (part.bbox[0] + part.bbox[2]) * 0.5 : 0,
    part.bbox ? -(part.bbox[1] + part.bbox[3]) * 0.5 : 0)) return 0;
  const co = part.outer;
  let au = 0, av = 0, bestLen = 0;
  for (let i = 0, j = co.length - 2; i < co.length; j = i, i += 2) {
    const du = co[i] - co[j], dv = co[i + 1] - co[j + 1];
    const l = du * du + dv * dv;
    if (l > bestLen) { bestLen = l; au = du; av = dv; }
  }
  const l = Math.hypot(au, av);
  if (!(l > EPS)) return 0;
  au /= l; av /= l;
  const nu = -av, nv = au;
  const bb = part.bbox;
  const cu = (bb[0] + bb[2]) * 0.5, cv = (bb[1] + bb[3]) * 0.5;
  const reach = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) * 0.5 + 2;
  const rng = C.rng;
  const mbP = C.mb.props;
  let placed = 0;
  const rowPitch = STALL_L * 2 + 6.2;
  for (let r = -reach; r <= reach && placed < cap; r += rowPitch) {
    for (let k = 0; k < 2 && placed < cap; k++) {
      const face = k === 0 ? -1 : 1;
      const off = r + face * STALL_L * 0.5;
      for (let t = -reach; t <= reach && placed < cap; t += STALL_W) {
        if (rng() > LOT_FILL) continue;
        const u = cu + au * t + nu * off;
        const v = cv + av * t + nv * off;
        if (!partContains(part, u, v)) continue;
        const x = u, z = -v;
        if (inFootprint(C, x, z, 0.5)) continue;
        if (!deckFits(C, x, z, C.groundY(x, z) + 0.07, PROP_H.lotCar)) continue;
        if (!C.occ.claim(x, z, 2.4)) continue;
        // Stalls sit square to the row, nose toward the aisle.
        const dx = nu * face, dz = -nv * face;
        const rr = rng();
        appendParkedCar(mbP, rng, x, C.groundY(x, z) + 0.07, z, Math.atan2(dx, dz),
          rr < 0.58 ? 'sedan' : (rr < 0.84 ? 'suv' : 'van'));
        noteProp(C, 'lotCar');
        C.auditRoad.push(x, z);
        placed++;
      }
    }
  }
  return placed;
}

/* =============================================================== roofscape == */

// A point well inside a roof part: rejected until it is at least `clear` metres from the edge, so
// plant never hangs off the parapet line.
const _rp = [0, 0];

function roofPoint(part, key, clear) {
  const bb = part.bbox;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  if (w < clear * 2.2 || h < clear * 2.2) return false;
  for (let t = 0; t < 10; t++) {
    const u = bb[0] + w * (0.12 + 0.76 * hash2(key * 7 + t, key * 13, 3));
    const v = bb[1] + h * (0.12 + 0.76 * hash2(key * 11 + t, key * 5, 4));
    if (!partContains(part, u, v)) continue;
    if (closestOnRing(part.outer, u, v).d2 < clear * clear) continue;
    _rp[0] = u; _rp[1] = -v;
    return true;
  }
  return false;
}

/**
 * Rooftop plant, scaled to the building. A bare extruded roof is one of the loudest tells that a
 * city was generated; every real flat roof downtown carries at least a condenser and a hatch.
 */
function placeRoofscape(C, b) {
  if (!b.mainPart || b.h < 8 || !(b.area > 0)) return;
  const part = b.mainPart;
  const rng = C.rng;
  const mbP = C.mb.props;
  // The roof cap this plant stands on may have STEPPED DOWN out of a shared plane (see
  // resolveCoplanarCaps), so the deck is not always b.y + b.h. Six centimetres of open air under
  // a cooling tower is small, and it is exactly the kind of small that reads as broken.
  const y = b.y + b.h - (part.capDrop || 0);
  const a = b.area;
  const yaw = b.frontYaw + Math.PI * 0.5;

  const units = a > 3200 ? 2 : (a > 1400 ? 1 : 0);
  for (let i = 0; i < units; i++) {
    if (!roofPoint(part, b.key * 31 + i * 3, 3.4)) break;
    const sz = clamp(Math.sqrt(a) * 0.10, 1.6, 6.5);
    appendRooftopUnit(mbP, rng, _rp[0], y, _rp[1], yaw + i * 0.7,
      sz * (0.8 + rng() * 0.6), sz * 0.62, 1.1 + rng() * 1.1);
    noteProp(C, 'rooftopUnit');
  }
  if (units === 0 && a > 150 && rng() < 0.17 && roofPoint(part, b.key * 17, 1.4)) {
    appendACondenser(mbP, rng, _rp[0], y, _rp[1], yaw);
    noteProp(C, 'acCondenser');
  }
  if (a > 1800 && b.h > 30 && roofPoint(part, b.key * 41, 3.0)) {
    appendCoolingTower(mbP, rng, _rp[0], y, _rp[1], yaw,
      clamp(Math.sqrt(a) * 0.045, 0.9, 3.4), clamp(Math.sqrt(a) * 0.09, 1.8, 6.0));
    noteProp(C, 'coolingTower');
  }
  if (b.h > 52 && a > 500 && roofPoint(part, b.key * 53, 4.2)) {
    const w = clamp(Math.sqrt(a) * 0.26, 4.0, 15.0);
    appendElevatorPenthouse(mbP, rng, _rp[0], y, _rp[1], yaw, w, w * 0.72,
      clamp(b.h * 0.045, 2.6, 7.5));
    noteProp(C, 'elevatorPenthouse');
  }
  if (b.h > 122 && roofPoint(part, b.key * 67, 2.4)) {
    appendRoofAntenna(mbP, rng, _rp[0], y, _rp[1], clamp(b.h * 0.10, 4.0, 22.0));
    noteProp(C, 'roofAntenna');
  }
  if (b.h > 40 && a > 400 && rng() < 0.22 && roofPoint(part, b.key * 71, 2.0)) {
    appendSatelliteDish(mbP, _rp[0], y, _rp[1], yaw + rng() * 1.2, 0.5 + rng() * 0.9);
    noteProp(C, 'satelliteDish');
  }
  // A parked window-washing cradle on the tall stock. The origin goes ON the parapet with local
  // +X out over the facade, which is exactly the frontage frame.
  if (b.h > 150 && b.frontLen > 7) {
    appendWindowRig(mbP, b.frontX, y + 1.05, b.frontZ, b.frontYaw, 3.2);
    noteProp(C, 'windowRig');
  }
  if (b.profile === 5 && b.h > 9 && b.h < 45 && roofPoint(part, b.key * 83, 2.0)) {
    appendFlagPole(mbP, _rp[0], y, _rp[1], clamp(b.h * 0.35, 6, 14));
    noteProp(C, 'flagPole');
  }
}

/* ================================================================= facades == */

// One outer-ring edge in plan space: midpoint, outward unit normal, length. A plan-CCW ring keeps
// its interior on the left of travel, so the outward normal is (dv, -du).
const _edge = { mu: 0, mv: 0, nu: 1, nv: 0, len: 0 };

function ringEdge(part, i) {
  const co = part.outer;
  const j = (i + 2) % co.length;
  const au = co[i], av = co[i + 1];
  const bu = co[j], bv = co[j + 1];
  const du = bu - au, dv = bv - av;
  const l = Math.hypot(du, dv);
  if (!(l > 0.30)) { _edge.len = 0; return 0; }
  _edge.mu = (au + bu) * 0.5;
  _edge.mv = (av + bv) * 0.5;
  _edge.nu = dv / l;
  _edge.nv = -du / l;
  // Defensive: a ring that reached here with the wrong orientation would put every door INSIDE
  // the building, where it is invisible and useless. Cheap to test, impossible to spot later.
  if (partContains(part, _edge.mu + _edge.nu * 0.45, _edge.mv + _edge.nv * 0.45)) {
    _edge.nu = -_edge.nu; _edge.nv = -_edge.nv;
  }
  _edge.len = l;
  return l;
}

/**
 * The street-facing edge of a building: the one whose OUTWARD normal looks at the nearest
 * carriageway. Writes frontX/frontZ/frontYaw/frontLen onto the record.
 * @returns {boolean} false when no road comes within 45 m
 */
function findFrontage(C, b) {
  const part = b.mainPart;
  if (!part) return false;
  const co = part.outer;
  let bestScore = Infinity;
  for (let i = 0; i < co.length; i += 2) {
    if (!ringEdge(part, i)) continue;
    const px = _edge.mu + _edge.nu * 3.0;
    const pz = -(_edge.mv + _edge.nv * 3.0);
    const d = nearestRoad(C, px, pz, 45);
    if (!isFinite(d)) continue;
    const score = d - Math.min(_edge.len, 30) * 0.09;
    if (score < bestScore) {
      bestScore = score;
      b.frontX = _edge.mu;
      b.frontZ = -_edge.mv;
      b.frontLen = _edge.len;
      b.frontNU = _edge.nu;
      b.frontNV = _edge.nv;
      // facades.js: yaw faces OUT and the outward normal is (cos yaw, 0, -sin yaw); in plan that
      // is (nu, nv), so yaw = atan2(nv, nu).
      b.frontYaw = Math.atan2(_edge.nv, _edge.nu);
    }
  }
  return bestScore < Infinity;
}

// The edge that best faces (wantU, wantV) and is at least `minLen` long — the back elevation,
// where fire escapes, loading docks and the second balcony face belong.
const _back = { x: 0, z: 0, yaw: 0, len: 0 };

function pickEdge(b, wantU, wantV, minLen) {
  const part = b.mainPart;
  if (!part) return false;
  const co = part.outer;
  let best = -2, ok = false;
  for (let i = 0; i < co.length; i += 2) {
    const l = ringEdge(part, i);
    if (l < minLen) continue;
    const score = _edge.nu * wantU + _edge.nv * wantV + Math.min(l, 24) * 0.012;
    if (score > best) {
      best = score;
      _back.x = _edge.mu;
      _back.z = -_edge.mv;
      _back.len = l;
      _back.yaw = Math.atan2(_edge.nv, _edge.nu);
      ok = true;
    }
  }
  return ok;
}

/**
 * The whole ground-floor and articulation treatment for one building: an entrance (a shopfront on
 * retail, a revolving drum on an office tower, a glazed pair on a condo, a steel door on an
 * envelope), balcony bands on residential towers, cornices and string courses on masonry, a fire
 * escape on older brick, a loading dock on service stock, and a parapet on anything tall.
 */
function buildFacade(C, b) {
  if (!b.parts || b.h < 3.2) return;
  if (!findFrontage(C, b)) return;
  const mb = C.mb.buildings;
  const rng = C.rng;
  const F = C.stats.facades;
  const yaw = b.frontYaw;
  const wall = Math.min(b.frontLen - 0.9, 24);
  if (wall < 1.8) return;

  // Audit: the frontage normal must genuinely leave the building. A door on an inward normal is
  // emitted inside the extrusion, where back-face culling hides it completely.
  if (partContains(b.mainPart, b.frontX + b.frontNU * 1.2, -b.frontZ + b.frontNV * 1.2)) {
    C.stats.facadesFacingIn++;
  }

  const sill = C.groundY(b.frontX, b.frontZ) + ROAD_Y + CURB * 0.55;
  // The ground storey can never be taller than the building it is the ground storey of.
  const floorH = clamp(Math.min(b.h * 0.42, b.h - 0.45), 2.6, b.profile === 3 ? 5.2 : 4.7);
  const retail = b.profile === 3 && wall >= 6.0;

  setMat(mb, b.mat);
  appendGroundFloor(mb, rng, b.frontX, sill, b.frontZ, yaw, wall, {
    profile: b.profile, height: b.h, floorH, mat: b.mat, retail,
  });
  F.groundFloors++;
  if (retail) {
    F.shopfronts++;
    C.retail.push({ x: b.frontX, z: b.frontZ, yaw, len: wall });
  }

  // --- retail spilling onto the sidewalk ----------------------------------------------------
  if (retail) {
    const ox = Math.cos(yaw), oz = -Math.sin(yaw);
    if (rng() < 0.40) {
      const x = b.frontX + ox * 1.55, z = b.frontZ + oz * 1.55;
      const y = reserve(C, 'sandwichBoard', x, z, 0.45, 0.3);
      if (isNum(y)) appendSandwichBoard(C.mb.props, rng, x, y + kerbSeat(C, x, z), z, yaw);
    }
    if (rng() < 0.20 && wall > 9) {
      const x = b.frontX + ox * 2.6, z = b.frontZ + oz * 2.6;
      const y = reserve(C, 'patioSet', x, z, 1.5, 0.4);
      if (isNum(y)) appendPatioSet(C.mb.props, rng, x, y + kerbSeat(C, x, z), z, yaw);
    }
  }

  // --- residential balcony bands ------------------------------------------------------------
  if (b.profile === 2 && b.h >= 32 && wall >= 6) {
    const step = Math.max(3.1, (b.h - 10) / BALCONY_MAX);
    const faces = (b.h >= 95 && pickEdge(b, -b.frontNU, -b.frontNV, 6)) ? 2 : 1;
    const bx = _back.x, bz = _back.z, byaw = _back.yaw, blen = _back.len;
    for (let f = 0; f < faces; f++) {
      const fx = f === 0 ? b.frontX : bx;
      const fz = f === 0 ? b.frontZ : bz;
      const fy = f === 0 ? yaw : byaw;
      const fw = Math.min(f === 0 ? wall : blen - 0.9, 30) - 0.7;
      if (fw < 4) continue;
      let n = 0;
      for (let v = b.y + floorH + 2.2; v < b.y + b.h - 3.0 && n < BALCONY_MAX; v += step) {
        appendBalconyBand(mb, fx, v, fz, fy, fw, 1.8, b.mat, { ends: true });
        n++;
      }
      F.balconyBands += n;
    }
  }

  // --- masonry articulation -----------------------------------------------------------------
  const masonry = b.cls === 'brick' || b.cls === 'stone' || b.cls === 'limestone' ||
    b.cls === 'stucco' || b.cls === 'granite';
  let corniced = false;
  if (masonry && b.h >= 7 && b.h <= 48 && wall >= 3.5) {
    corniced = true;
    appendCornice(mb, b.frontX, b.y + b.h - 0.95, b.frontZ, yaw, wall,
      clamp(b.h * 0.022, 0.34, 0.80), b.mat, { ends: true });
    F.cornices++;
    if (b.h > 11.5) {
      appendStringCourse(mb, b.frontX, b.y + floorH + 0.35, b.frontZ, yaw, wall, b.mat,
        { h: 0.26, proj: 0.11 });
      F.stringCourses++;
    }
  }
  if (b.cls === 'brick' && b.h >= 9.5 && b.h <= 32 && rng() < 0.26 &&
    pickEdge(b, -b.frontNU, -b.frontNV, 3.4)) {
    const floors = clamp(Math.round((b.h - 4) / 3.4), 1, 6);
    appendFireEscape(mb, rng, _back.x, C.groundY(_back.x, _back.z) + 3.6, _back.z, _back.yaw,
      Math.min(_back.len - 0.6, 3.6), floors, b.mat, { storey: 3.4 });
    F.fireEscapes++;
  }
  if ((b.profile === 0 || b.profile === 4) && b.h >= 5 && b.area > 400 &&
    pickEdge(b, -b.frontNU, -b.frontNV, 5.0)) {
    appendLoadingDock(mb, _back.x, C.groundY(_back.x, _back.z) + ROAD_Y, _back.z, _back.yaw,
      Math.min(_back.len - 1.2, 7.0), b.mat, {});
    F.loadingDocks++;
  }
  // A parapet and a cornice occupy the same 1 m of wall; a masonry building gets the cornice.
  if (b.h >= 38 && wall >= 3.5 && !corniced) {
    appendParapet(mb, b.frontX, b.y + b.h, b.frontZ, yaw, wall, 1.05, b.mat, {});
    F.parapets++;
  }
}

/* ============================================================== people == */
/**
 * PEOPLE. The city has 1,612 parked cars and 51 km of streetcar track and not one person on it,
 * which reads as an evacuation. This pass puts 2,500-4,000 of them on the ground.
 *
 * Density follows context rather than a uniform scatter, because uniform scatter is exactly what
 * makes a crowd read as wallpaper. Three multipliers stack:
 *   * the road CLASS — an arterial carries people, a service lane does not, an expressway
 *     carries none at all;
 *   * the STREET, by name. Yonge, King, Queen, Bay, Front, Dundas and Spadina are where downtown
 *     Toronto actually walks; the numbers below are relative footfall, not invention for its own
 *     sake, and Lake Shore is deliberately near zero because nobody walks it;
 *   * the DISTRICT — a bump centred on King and Bay that fades out over 420 m, which is what puts
 *     the crowd in the Financial District core and leaves the rail lands empty.
 *
 * Everything else is placed from real geometry the rest of the load already built: the OSM
 * footways, the plaza fills, the park polygons, the transit stops, the benches, and the retail
 * frontages the facade pass found. Nobody is scattered anywhere the city does not already say is
 * walkable.
 *
 * Its own rng. The pass is seeded from SEED but with its own stream, so adding people does not
 * shift a single lamp, tree or parked car that was placed before them.
 *
 * PLACEMENT RULES, all audited at the end of the load:
 *   * never inside a building footprint;
 *   * never on a carriageway, except cyclists in the bike lanes and the figures on a crossing;
 *   * never floating and never sunk — every seat is groundY() plus the kerb the site sits on.
 */

const PED_SEED = 0x51ed9a7f;
const PED_BASE = 50.0;             // metres of kerb per person on an ordinary named street.
                                   // Tuned so the sidewalk pass — which runs last and is the only
                                   // unbounded source — lands clear of MAX_PEOPLE rather than
                                   // being truncated by it, which would leave whichever streets
                                   // happen to be processed last conspicuously empty.
const PED_MIN_W = 0.04;
const PED_R = 0.40;                // occupancy radius of one person
const PED_GROUP_R = 1.30;
const PED_GROUP_P = 0.10;
const PED_STAND_P = 0.20;
const PED_FAST_P = 0.17;
const PED_DOG_P = 0.030;
const PED_SIT_P = 0.34;            // fraction of benches with somebody on them
const PED_XING_P = 0.30;           // fraction of crossing corners with somebody waiting
const CYCLE_SPACING = 130.0;       // metres of bike lane per cyclist
const PLAZA_PER = 300.0;           // square metres of plaza per person
const PARK_PER = 1100.0;           // ...and of park
const WALK_SPACING = 130.0;        // metres of OSM footway per person
// The crowd is budgeted PER TILE, not city-wide. A single global head count was a vertex budget
// in disguise: on a 43 km2 map it is spent long before the camera reaches the Financial District,
// and whichever tiles happened to be built last come out empty. 220 is the old city-wide 4,000
// scaled to one 625 m tile at the density the 7 km2 slice was tuned to (571 people per km2), so a
// street looks exactly as busy as it used to and the number resident at any moment is bounded by
// the detail radius rather than by the size of the map.
const MAX_PEOPLE = 220;

// King and Bay, in local metres, and how far the core's footfall bump reaches.
const CORE_X = 684.7, CORE_Z = -489.8, CORE_R = 420.0;

// Relative footfall by street, longest prefix wins. Not decoration: this is the difference
// between a crowd that looks like Toronto and a crowd sprinkled with a shaker.
const PED_STREETS = [
  ['Yonge', 2.00], ['King', 1.90], ['Queen', 1.85], ['Bay', 1.75], ['Front', 1.60],
  ['Dundas', 1.60], ['Spadina', 1.45], ['Queens Quay', 1.35], ['University', 1.25],
  ['Blue Jays', 1.20], ['John', 1.20], ['Richmond', 1.15], ['Adelaide', 1.15], ['Church', 1.10],
  ['York', 1.10], ['Wellington', 1.05], ['Simcoe', 1.00], ['Peter', 1.00], ['Bremner', 0.95],
  ['Bathurst', 0.90], ['Jarvis', 0.80], ['Lower Simcoe', 0.75], ['Lake Shore', 0.30],
  ['Gardiner', 0.00], ['Don Valley', 0.00],
];

// Only the classes that carry a synthetic sidewalk band appear here. Pedestrian ways and OSM
// footways get their people from the plaza and footway passes instead, off their real geometry.
const PED_CLASS_W = { motorway: 0, major: 1.0, minor: 0.52, service: 0.16 };

function pedStreetWeight(name) {
  if (typeof name !== 'string' || !name) return 0.62;      // unnamed lanes and back streets
  let best = 0.85;
  let bestLen = 0;
  for (let i = 0; i < PED_STREETS.length; i++) {
    const k = PED_STREETS[i][0];
    if (k.length > bestLen && name.indexOf(k) === 0) { best = PED_STREETS[i][1]; bestLen = k.length; }
  }
  return best;
}

function pedDistrict(x, z) {
  const d = Math.hypot(x - CORE_X, z - CORE_Z);
  return 1 + 0.85 * clamp(1 - d / CORE_R, 0, 1);
}

// Where the crowd actually ended up, on a 100 m grid. "Dense in the core, sparse in the rail
// lands" is a claim, and a claim about a distribution needs a distribution to check it against.
const CROWD_CELL = 100.0;

function noteCrowd(C, x, z, n) {
  const S = C.stats.people;
  if (Math.hypot(x - CORE_X, z - CORE_Z) <= CORE_R) S.core += n;
  const k = Math.round(x / CROWD_CELL) + ':' + Math.round(z / CROWD_CELL);
  const v = (C.crowd.get(k) || 0) + n;
  C.crowd.set(k, v);
  if (v > S.peakCell) S.peakCell = v;
}

// props.js: local +X is the way a figure faces, so a person walking along (dx, dz) takes
// yaw = atan2(-dz, dx). Same rule as the parked cars and the cyclists.
function faceYaw(dx, dz) { return Math.atan2(-dz, dx); }

/**
 * Put somebody at (x, z). The site must already be somewhere a person can stand; this handles the
 * footprint, carriageway and occupancy tests, the seat height, the pose roll and the audit.
 *
 * opts: { group, kind, pose, seat, roadPad, where }
 * @returns {boolean} true when a figure was actually emitted
 */
function placePerson(C, P, x, z, yaw, opts) {
  const S = C.stats.people;
  // The head count is the TILE's, not the accumulated total: reading stats.people.total here
  // would spend the whole map's budget on whichever tiles happened to be built first and leave
  // the rest of the city deserted — and would make the crowd a function of the flight path.
  if (C.tilePeople >= MAX_PEOPLE) return false;
  const o = opts || {};
  const group = o.group ? clamp(Math.round(o.group), 2, 4) : 0;
  const kind = o.kind || 'pedestrian';
  const r = group ? PED_GROUP_R : (kind === 'cyclist' ? 1.15 : (kind === 'dogWalker' ? 1.05 : PED_R));
  const roadPad = o.roadPad === undefined ? 0.30 : o.roadPad;
  const gy = reserve(C, group ? 'pedestrianGroup' : kind, x, z, r, roadPad,
    PROP_H[kind] || PROP_H.pedestrian);
  if (!isNum(gy)) return false;
  const base = isNum(o.seat) ? o.seat : gy + kerbSeat(C, x, z);
  const mb = C.mb.props;

  if (kind === 'cyclist') {
    appendCyclist(mb, P, x, base, z, yaw);
    S.cyclists++; S.total++;
  } else if (kind === 'dogWalker') {
    appendDogWalker(mb, P, x, base, z, yaw);
    S.dogWalkers++; S.walking++; S.total++;
  } else if (group) {
    appendPedestrianGroup(mb, P, x, base, z, yaw, group);
    S.groups++; S.grouped += group; S.total += group;
  } else {
    let pose = o.pose;
    if (!pose) {
      const rp = P();
      pose = rp < PED_FAST_P ? 'walkFast' : (rp < PED_FAST_P + PED_STAND_P ? 'stand' : 'walk');
    }
    appendPedestrian(mb, P, x, base, z, yaw, pose);
    if (pose === 'sit') S.sitting++;
    else if (pose === 'stand' || pose === 'lean') S.standing++;
    else S.walking++;
    S.total++;
  }
  if (o.where) S[o.where] = (S[o.where] || 0) + (group || 1);
  C.tilePeople += (group || 1);
  noteCrowd(C, x, z, group || 1);
  // 4th field: whether this figure is ALLOWED on a carriageway. Only the cyclists in the painted
  // lanes are; everybody else being on one is a bug, and the audit has to be able to tell.
  C.auditPed.push(x, z, base, roadPad < 0 ? 1 : 0);
  return true;
}

// Somebody on a bench. The bench is already in the occupancy grid, so this goes round reserve()
// and seats the figure on the bench's own site, which the furniture pass already validated.
function seatOnBench(C, P, b) {
  const S = C.stats.people;
  if (C.tilePeople >= MAX_PEOPLE) return;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const du = 0.10, dv = (P() < 0.5 ? -1 : 1) * (0.30 + P() * 0.34);
  const x = b.x + du * c + dv * s;
  const z = b.z - du * s + dv * c;
  appendPedestrian(C.mb.props, P, x, b.y, z, b.yaw + (P() - 0.5) * 0.30, 'sit');
  noteProp(C, 'pedestrian');
  S.sitting++; S.total++; S.onSidewalk++;
  C.tilePeople++;
  noteCrowd(C, x, z, 1);
  C.auditPed.push(x, z, b.y, 0);
  C.audit.push(x, z);
}

/** Everybody on the streets, the walkways, the plazas, the parks and the stops. */
function placePedestrians(C, recs, parkParts) {
  // Seeded from the TILE, not from a fixed constant. Re-seeding every tile from PED_SEED would
  // hand each of them the identical random stream, so the same corner would be skipped and the
  // same bench left empty in all 156 of them — measured, that moved the crowd off the crossings,
  // the plazas and the parks and dumped it all on the pavement.
  const P = makeRng(isNum(C.pedSeed) ? C.pedSeed : PED_SEED);

  /* --- waiting to cross ------------------------------------------------ */
  // On the corner, facing across the street: the single most legible piece of street behaviour
  // there is, and it puts people exactly where the kerb ramps and crossings already are.
  for (let i = 0; i < C.corners.length; i++) {
    const c = C.corners[i];
    if (P() > PED_XING_P) continue;
    const n = P() < 0.30 ? 2 + ((P() * 2) | 0) : 1;
    const yaw = faceYaw(c.dx, c.dz) + (P() - 0.5) * 0.6;
    placePerson(C, P, c.x, c.z, yaw, {
      group: n > 1 ? n : 0, pose: P() < 0.82 ? 'stand' : 'walk', where: 'atCrossing',
    });
  }

  /* --- transit stops --------------------------------------------------- */
  // Beyond the ends of the shelter rather than in front of it: the shelter has already claimed
  // its own footprint in the occupancy grid, and a passenger standing inside the glass is not a
  // passenger, it is a clipping artifact. The shelter's local +X faces back at the track, so a
  // waiting passenger takes the same yaw.
  for (let i = 0; i < C.stations.length; i++) {
    const st = C.stations[i];
    const n = 1 + ((P() * 3) | 0);
    const c = Math.cos(st.yaw), s = Math.sin(st.yaw);
    for (let k = 0; k < n; k++) {
      const du = (P() - 0.5) * 1.4;
      const dv = (P() < 0.5 ? -1 : 1) * (Math.min(st.len * 0.5, 6.0) + 0.9 + P() * 1.6);
      const x = st.x + du * c + dv * s;
      const z = st.z - du * s + dv * c;
      placePerson(C, P, x, z, st.yaw + (P() - 0.5) * 0.7, {
        pose: P() < 0.75 ? 'stand' : 'walk', where: 'atStop',
      });
    }
  }

  /* --- benches --------------------------------------------------------- */
  for (let i = 0; i < C.benches.length; i++) {
    if (P() < PED_SIT_P) seatOnBench(C, P, C.benches[i]);
  }

  /* --- OSM footways ---------------------------------------------------- */
  for (let i = 0; i < C.walks.length; i++) {
    const run = C.walks[i];
    const pts = run.pts;
    let acc = P() * WALK_SPACING;
    for (let k = 1; k < pts.length; k++) {
      let dx = pts[k][0] - pts[k - 1][0], dz = pts[k][1] - pts[k - 1][1];
      const l = Math.hypot(dx, dz);
      if (!(l > EPS)) continue;
      acc += l;
      if (acc < WALK_SPACING) continue;
      acc = 0;
      dx /= l; dz /= l;
      const t = 0.25 + P() * 0.5;
      const lat = (P() - 0.5) * Math.min(run.w * 0.55, 1.6);
      const x = pts[k - 1][0] + dx * l * t - dz * lat;
      const z = pts[k - 1][1] + dz * l * t + dx * lat;
      const rev = P() < 0.5 ? -1 : 1;
      placePerson(C, P, x, z, faceYaw(dx * rev, dz * rev) + (P() - 0.5) * 0.4, {
        seat: C.groundY(x, z) + (run.kerbed ? ROAD_Y + CURB : PATH_Y),
        where: 'onFootway',
      });
    }
  }

  /* --- plazas ---------------------------------------------------------- */
  for (let i = 0; i < C.plazas.length; i++) {
    const part = C.plazas[i];
    const area = Math.abs(planArea(part.outer));
    const want = Math.min(24, Math.floor(area / PLAZA_PER));
    const bb = part.bbox;
    for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
      const u = bb[0] + P() * (bb[2] - bb[0]);
      const v = bb[1] + P() * (bb[3] - bb[1]);
      if (!partContains(part, u, v)) continue;
      const x = u, z = -v;
      const yaw = P() * TAU - Math.PI;
      const ok = P() < 0.22
        ? placePerson(C, P, x, z, yaw, { group: 2 + ((P() * 3) | 0), seat: C.groundY(x, z) + PATH_Y, where: 'onPlaza' })
        : placePerson(C, P, x, z, yaw, { seat: C.groundY(x, z) + PATH_Y, where: 'onPlaza' });
      if (ok) k++;
    }
  }

  /* --- parks ----------------------------------------------------------- */
  for (let i = 0; i < parkParts.length; i++) {
    const part = parkParts[i];
    const area = Math.abs(planArea(part.outer));
    if (area < 380) continue;
    const want = Math.min(14, Math.floor(area / PARK_PER));
    const bb = part.bbox;
    for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
      const u = bb[0] + P() * (bb[2] - bb[0]);
      const v = bb[1] + P() * (bb[3] - bb[1]);
      if (!partContains(part, u, v)) continue;
      const x = u, z = -v;
      const yaw = P() * TAU - Math.PI;
      const roll = P();
      const opts = { seat: C.groundY(x, z) + PARK_Y, where: 'inPark' };
      if (roll < 0.18) opts.group = 2 + ((P() * 3) | 0);
      else if (roll < 0.28) opts.kind = 'dogWalker';
      else if (roll < 0.44) opts.pose = 'stand';
      if (placePerson(C, P, x, z, yaw, opts)) k++;
    }
  }

  /* --- outside the shops ----------------------------------------------- */
  // Where the facade pass actually built a shopfront. The figure stands off the glass by a metre
  // and a half, facing along the frontage rather than into it.
  for (let i = 0; i < C.retail.length; i++) {
    const f = C.retail[i];
    if (P() > 0.42) continue;
    const ox = Math.cos(f.yaw), oz = -Math.sin(f.yaw);
    const tx = -oz, tz = ox;                       // along the frontage
    const along = (P() - 0.5) * Math.min(f.len * 0.7, 9.0);
    const out = 1.5 + P() * 1.4;
    const x = f.x + ox * out + tx * along;
    const z = f.z + oz * out + tz * along;
    const rev = P() < 0.5 ? -1 : 1;
    const roll = P();
    placePerson(C, P, x, z, faceYaw(tx * rev, tz * rev) + (P() - 0.5) * 0.7, {
      group: roll < 0.20 ? 2 + ((P() * 3) | 0) : 0,
      pose: roll < 0.20 ? undefined : (roll < 0.48 ? 'stand' : undefined),
      where: 'atShopfront',
    });
  }

  /* --- sidewalks ------------------------------------------------------- */
  // LAST, deliberately. The sidewalks are the only unbounded source, so running them last makes
  // them the sink that absorbs whatever is left of the head count instead of eating it all before
  // a single person reaches a plaza, a park or a transit stop.
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const sw = SIDEWALK_W[rec.cls] || 0;
    if (rec.bridge || !(sw > 0)) continue;
    const cls = PED_CLASS_W[rec.cls];
    if (!(cls > 0)) continue;
    const mid = rec.pts[rec.pts.length >> 1];
    const w = cls * pedStreetWeight(rec.name) * pedDistrict(mid[0], mid[1]);
    if (w < PED_MIN_W) continue;
    const pitch = PED_BASE / w;
    if (rec.len < pitch * 0.4) continue;
    const inner = rec.hw + 0.35;
    for (let sd = 0; sd < 2; sd++) {
      const sgn = sd === 0 ? 1 : -1;
      for (let s = pitch * (0.2 + 0.6 * P()); s < rec.len; s += pitch * (0.6 + 0.8 * P())) {
        const m = recSample(rec, s);
        const lat = (inner + sw * (0.20 + P() * 0.62)) * sgn;
        const x = m.x + m.sx * lat, z = m.z + m.sz * lat;
        if (!onPavement(C, x, z)) continue;
        // Along the street, either way. The side vector is +90 degrees from travel, so travel is
        // (sz, -sx) and the two directions are that and its negative.
        const rev = P() < 0.5 ? -1 : 1;
        const yaw = faceYaw(m.sz * rev, -m.sx * rev) + (P() - 0.5) * 0.5;
        const roll = P();
        if (roll < PED_GROUP_P * w) {
          placePerson(C, P, x, z, yaw, { group: 2 + ((P() * 3) | 0), where: 'onSidewalk' });
        } else if (roll < PED_GROUP_P * w + PED_DOG_P) {
          placePerson(C, P, x, z, yaw, { kind: 'dogWalker', where: 'onSidewalk' });
        } else {
          placePerson(C, P, x, z, yaw, { where: 'onSidewalk' });
        }
      }
    }

    /* --- cyclists in the painted bike lanes ---------------------------- */
    // These ARE on the carriageway, which is the point: the lane is between the kerb lane and
    // the parked cars, and a cyclist on the pavement would be the bug.
    if (rec.bike && rec.hw > 4.2 && rec.len > 40) {
      const o0 = rec.hw - 1.75;
      for (let sd = 0; sd < 2; sd++) {
        const sgn = sd === 0 ? 1 : -1;
        for (let s = 12 + P() * CYCLE_SPACING; s < rec.len - 8; s += CYCLE_SPACING * (0.6 + P())) {
          const m = recSample(rec, s);
          const o = o0 * sgn;
          const x = m.x + m.sx * o, z = m.z + m.sz * o;
          if (nearJunction(rec, s, 6.0)) continue;
          // Riding with the traffic on that side: the near-side lane runs one way, the far the
          // other, exactly as the parked cars are oriented.
          const dx = m.sz * sgn, dz = -m.sx * sgn;
          placePerson(C, P, x, z, faceYaw(dx, dz), {
            kind: 'cyclist', roadPad: -1, seat: surfaceY(C, rec, m, o), where: 'inBikeLane',
          });
        }
      }
    }
  }
}

/* =================================================== service yards and works == */

// Dumpsters down the alleys and service frontages.
function placeServiceProps(C, rec) {
  if (rec.cls !== 'service' || rec.len < 14) return;
  const rng = C.rng;
  const mbP = C.mb.props;
  const o = rec.hw + 1.15;
  for (let s = 7; s < rec.len - 5; s += 48) {
    if (rng() > 0.24) continue;
    const sgn = rng() < 0.5 ? 1 : -1;
    const m = recSample(rec, s);
    const x = m.x + m.sx * o * sgn, z = m.z + m.sz * o * sgn;
    const y = reserve(C, 'dumpster', x, z, 1.35, 0.25);
    if (!isNum(y)) continue;
    appendDumpster(mbP, rng, x, y + ROAD_Y, z, Math.atan2(m.sz * sgn, -m.sx * sgn));
  }
}

// Sidewalk sheds. Something downtown is always wrapped in one; tile a few sections so a couple of
// arterial blocks are under construction.
function placeScaffold(C, rec) {
  if (rec.cls !== 'major' || rec.len < 70 || !rec.commercial) return;
  const rng = C.rng;
  if (rng() > 0.10) return;
  const sgn = rng() < 0.5 ? 1 : -1;
  const s0 = 12 + rng() * (rec.len - 46);
  const o = (rec.hw + 0.25 + (SIDEWALK_W[rec.cls] || 3.8) * 0.5) * sgn;
  for (let k = 0; k < 4; k++) {
    const m = recSample(rec, s0 + k * 6.0);
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    const y = reserve(C, 'scaffold', x, z, 2.4, 0.3);
    if (!isNum(y)) continue;
    // The building face is at local -X and the kerb at +X, so "out" points at the road.
    appendScaffold(C.mb.props, rng, x, y + kerbSeat(C, x, z), z,
      Math.atan2(m.sz * sgn, -m.sx * sgn), 6.0, 3.8);
  }
}

/* ================================================================== marine == */

// A ferry / tour-boat berth on a Harbourfront quay: on the quay edge, half of it overhanging the
// slip, its deck at the same height the pier cap was draped to.
function placeQuayBerth(C, part) {
  const co = part.outer;
  for (let i = 0; i < co.length; i += 2) {
    const l = ringEdge(part, i);
    if (l < 26) continue;
    const mx = _edge.mu, mz = -_edge.mv;
    const ox = _edge.nu, oz = -_edge.nv;                     // outward, in world
    const fx = mx + ox * 3.2, fz = mz + oz * 3.2;
    if (inFootprint(C, fx, fz, 1.0) || !C.occ.claim(fx, fz, 9.0)) continue;
    // props.js: local +X is the outboard side, so the rub rail faces the water.
    appendFerryDock(C.mb.props, fx, Math.max(C.groundY(mx, mz), 0.9) + 0.35, fz,
      Math.atan2(-oz, ox), 7.0, clamp(l * 0.7, 8, 24));
    noteProp(C, 'ferryDock');
    return true;
  }
  return false;
}

/**
 * Moored craft off one quay. They cannot simply be hung on the quay edge: open water here is
 * recovered from a distance transform (see makeTerrain) and a quay is itself dense mapped
 * infrastructure, so the lake surface does not begin until well clear of the slips. Rings are
 * therefore walked outward from the quay until the terrain genuinely drops below the lake plane,
 * and each craft is moored broadside to the quay so a basin reads as a marina.
 */
function placeHarbourCraft(C, part, budget) {
  const bb = part.bbox;
  const cx = (bb[0] + bb[2]) * 0.5;
  const cz = -(bb[1] + bb[3]) * 0.5;
  const rng = C.rng;
  let placed = 0;
  for (let ring = 34; ring <= 280 && placed < budget; ring += 24) {
    for (let a = 0; a < 12 && placed < budget; a++) {
      const th = (a / 12) * TAU + ring * 0.13;
      const jx = cx + Math.cos(th) * ring;
      const jz = cz + Math.sin(th) * ring;
      if (C.groundY(jx, jz) > -0.55) continue;
      if (!C.occ.claim(jx, jz, 9.5)) continue;
      // Broadside to the quay: perpendicular to the line back to it.
      const tx = cx - jx, tz = cz - jz;
      const tl = Math.hypot(tx, tz);
      const dx = tl > EPS ? -tz / tl : 1, dz = tl > EPS ? tx / tl : 0;
      appendBoat(C.mb.props, rng, jx, WATER_Y, jz, Math.atan2(dx, dz) + (rng() - 0.5) * 0.16,
        8.0 + rng() * 9.0);
      noteProp(C, 'boat');
      placed++;
    }
  }
  return placed;
}

/* ==================================================================== rail == */

// Rolling stock standing in the corridor south of Front. Placed on the track centreline at top of
// rail, so a car sits on its own rails instead of beside them.
function placeRailCars(C, raw, lift, profile) {
  // `profile` is the WHOLE way when `raw` is one tile's run of it: the embankment's height comes
  // from the corridor the grade solve built for the way, and a run must not re-derive a shorter
  // one or two tiles of the same track disagree about where the railhead is.
  const src = Array.isArray(profile) && profile.length > 1 ? profile : raw;
  const railY = (x, z) => C.terrainY(x, z) +
    (lift ? corridorDepth({ pts: src, dep: lift }, x, z) : 0) + RAIL_BED + 0.20;
  const pts = polyResample(raw, ROAD_MAX_SEG);
  if (pts.length < 3) return;
  const rng = C.rng;
  const arc = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    arc.push(total);
  }
  if (total < 140) return;
  const start = 30 + rng() * (total - 130);
  const n = 2 + ((rng() * 4) | 0);
  for (let k = 0; k < n; k++) {
    const s = start + k * 26.5;
    if (s > total - 24) break;
    let i = 0;
    while (i + 2 < pts.length && arc[i + 1] < s) i++;
    const span = arc[i + 1] - arc[i];
    const t = span > EPS ? clamp((s - arc[i]) / span, 0, 1) : 0;
    const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
    const z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const dl = Math.hypot(dx, dz);
    if (!(dl > EPS)) continue;
    dx /= dl; dz /= dl;
    if (inFootprint(C, x, z, 2.0)) continue;
    const seat = railY(x, z);
    if (!deckFits(C, x, z, seat, PROP_H.railCar)) continue;
    if (!C.occ.claim(x, z, 13.0)) continue;
    appendRailCar(C.mb.props, rng, x, seat, z, Math.atan2(dx, dz),
      k === 0 ? 'locomotive' : (rng() < 0.45 ? 'freight' : 'coach'));
    noteProp(C, 'railCar');
  }
}

/* ================================================================ loading == */

/* ================================================================== tiling == */

// One merged mesh per material class per tile. `water` is deliberately absent: the lake is a
// single 30 k-vertex sheet that is visible from almost everywhere, has its own shader pass, and
// would gain nothing from being cut up.
/* ====================================================== islands and airport == */
//
// The south half of the map — the Toronto Islands, the Western and Eastern Gaps and Billy Bishop
// — is built by harbour.js, which owns the surveyed shoreline and everything on the water. This
// section is the whole of city.js's side of it: a tile flag, a draw box, and the placement
// context the island passes need (the occupancy grid, the footprint index, the ground field).
//
// Nothing about the islands is special-cased anywhere else in this file. The two other island
// touch points are marked ISLANDS in place: the cottage height fix in the building prep, and the
// car-free guard in the two parked-car passes.

// Absolute plan area of a footprint ring, for the island cottage height fix.
function ringPlanArea(r) {
  if (!Array.isArray(r) || r.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (!isNum(r[i][0]) || !isNum(r[j][0])) continue;
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  }
  return Math.abs(a * 0.5);
}

// Headroom above the ground a tile of islands has to draw: the lighthouse lantern is the tallest
// thing down there at 21 m, an approach mast stands over the water, and a canopy tree tops 14 m.
const ISLE_TILE_UP = 34.0;
const ISLE_TILE_DOWN = 18.0;

const MESH_CLASSES = ['terrain', 'buildings', 'glass', 'roads', 'sidewalks', 'rails', 'props'];

// Level-of-detail stages, cheapest first. Stage 0 is what a tower contributes to a two-kilometre
// view: massing with its real facade colour and lighting profile, the ground it stands on, the
// carriageway ribbons, the rails, the quay. Stage 1 is everything you can only resolve from the
// pavement: markings, kerbs, shopfronts, balconies, street furniture, people.
const S_MASS = 0;
const S_DETAIL = 1;

// Ranges, metres from the camera to the tile's own cell.
//   MASS_RANGE   5.0 km. The map is 6.8 km across and the postcard viewpoint is 2 km out over
//                the lake looking at the whole skyline, so the massing has to reach the far side.
//   DETAIL_RANGE 780 m. A cobra lamp is 9.5 m tall; at 780 m and a 60-degree vertical field on a
//                900-line frame it is 19 px tall and about one across. A balcony band on a condo
//                is under 2 px. Past that the geometry costs vertices and returns nothing.
// The drop distances are ~25% further out, so a camera sitting exactly on a boundary does not
// thrash a tile in and out.
const MASS_RANGE = 5000;
const MASS_DROP = 6200;
const DETAIL_RANGE = 780;
const DETAIL_DROP = 980;

// Resident-vertex ceiling. 11 M vertices is 572 MB of interleaved vertex data at 13 floats —
// 1.57x the pre-expansion build, which shipped 7.0 M vertices (364 MB) in permanently resident
// buffers and held 60 fps, for 6x the area. It leaves the shadow atlas (3 x 2048^2 depth = 50 MB)
// and the post chain (~60 MB at 1440x900) comfortable room inside a 1 GB working set.
//
// Sized by measurement, not by taste: the densest want set in the city is the Financial District
// at street level, where MASS_RANGE holds 131 tiles of massing (~51 k vertices each) and
// DETAIL_RANGE holds 12 tiles of street detail (~379 k each) for 11.2 M vertices. At the old
// 9 M this overflowed permanently and the tile manager thrashed — see TileManager._adaptLod.
// The cap is set above that measured peak on purpose: the adaptive LOD scale is a safety valve
// for the full city, and a safety valve that is load-bearing in ordinary use is not a valve.
const VERTEX_CAP = 11000000;

// Milliseconds per frame the tile scheduler may spend generating geometry. At 60 fps the frame
// is 16.7 ms and the renderer wants most of it; 3.5 ms builds a dense downtown tile over about
// twenty frames, which is a third of a second — faster than the camera can cross the tile at
// anything under the fly boost.
const TILE_BUDGET_MS = 3.5;

// How long a tile may go undrawn before its geometry is released even though it is still in
// range. Long enough that turning round on the spot never rebuilds anything.
const TILE_EVICT_MS = 20000;

function makeBuilders() {
  const o = {};
  for (let i = 0; i < MESH_CLASSES.length; i++) o[MESH_CLASSES[i]] = new MeshBuilder();
  return o;
}

/**
 * Split geometry produced by a GLOBAL pass into per-tile chunks.
 *
 * Some passes cannot sensibly be run a tile at a time: the walkability audit has to see the whole
 * network before it knows where to build a flight of steps, and the harbour is one continuous
 * 32 km run of surveyed shoreline in harbour.js, which city.js does not own. They run once,
 * writing into scratch builders; this cuts the result up by triangle centroid and hands each tile
 * the float run it owns. Every triangle lands in exactly one tile, so nothing is dropped and
 * nothing is drawn twice.
 */
function captureSplit(grid, cap, stageOf, tileChunks) {
  const VF = 13;
  for (let c = 0; c < MESH_CLASSES.length; c++) {
    const name = MESH_CLASSES[c];
    const stage = stageOf[name] === undefined ? S_MASS : stageOf[name];
    const data = cap[name].data();
    const n = data.length;
    if (n < VF * 3) continue;
    const step = VF * 3;
    const count = new Map();
    for (let i = 0; i + step <= n; i += step) {
      const x = (data[i] + data[i + VF] + data[i + VF * 2]) / 3;
      const z = (data[i + 2] + data[i + VF + 2] + data[i + VF * 2 + 2]) / 3;
      const id = grid.idAt(x, z);
      count.set(id, (count.get(id) || 0) + 1);
    }
    const buf = new Map();
    const at = new Map();
    for (const [id, tris] of count) { buf.set(id, new Float32Array(tris * step)); at.set(id, 0); }
    for (let i = 0; i + step <= n; i += step) {
      const x = (data[i] + data[i + VF] + data[i + VF * 2]) / 3;
      const z = (data[i + 2] + data[i + VF + 2] + data[i + VF * 2 + 2]) / 3;
      const id = grid.idAt(x, z);
      const dst = buf.get(id);
      const o = at.get(id);
      dst.set(data.subarray(i, i + step), o);
      at.set(id, o + step);
    }
    for (const [id, arr] of buf) {
      let rec = tileChunks.get(id);
      if (!rec) { rec = [null, null]; tileChunks.set(id, rec); }
      if (!rec[stage]) rec[stage] = {};
      rec[stage][name] = arr;
      // Chunks are geometry too: the tile's draw box has to contain them or the culler will
      // throw away a quay wall that is genuinely on screen.
      let x0 = Infinity, z0 = Infinity, y0 = Infinity, x1 = -Infinity, z1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < arr.length; i += VF) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      grid.cover(grid.tiles[id], x0, z0, x1, z1, y0, y1);
    }
    cap[name].reset();
  }
}

// Append a captured float run into a live builder, verbatim. MeshBuilder.append() with an
// identity transform copies all 13 channels, so a tiny shim over the raw array is all it takes.
const _chunkShim = { _n: 0, _data: null };
function appendChunk(mb, arr) {
  if (!arr || !arr.length) return;
  _chunkShim._n = arr.length;
  _chunkShim._data = arr;
  mb.append(_chunkShim, 0, 0, 0, 0, 1);
  _chunkShim._data = null;
}

/**
 * Cut a way that is longer than a tile into per-tile sub-ways.
 *
 * 20,374 of the 20,403 road ways in the extract fit inside one tile and are indexed whole. The
 * remaining 29 are the arterials — Lake Shore Boulevard is 1.9 km — and leaving them whole means
 * standing at one end of one and finding no markings, no kerbs and no lamps because the geometry
 * is anchored two kilometres away.
 *
 * The cut lands on a shared vertex, so the two halves meet exactly in plan. What can differ is
 * the mitre: an interior vertex is mitred between its two segments, an endpoint is square to its
 * one. So the boundary crossing is nudged to the STRAIGHTEST vertex within a short window, where
 * the two agree. Measured over the whole extract the worst residual turn at a cut is 0.42 deg,
 * which on the widest carriageway is a 1.7 cm step in the kerb line.
 */
let _worstCut = 0;                 // measured turn between two runs at a cut, radians

/**
 * Cut a way that is longer than a tile into per-tile runs.
 *
 * 97% of the 20,403 road ways in the extract are shorter than a tile and are indexed whole. The
 * rest are the arterials — Lake Shore Boulevard is 1.9 km — and leaving one of those whole means
 * standing at one end of it and finding no markings, no kerbs and no lamps, because the geometry
 * is anchored two kilometres away at the midpoint.
 *
 * The cut lands in the MIDDLE OF A SEGMENT, not on a vertex. Both halves therefore end collinear
 * with the same original segment, and polyFrames() squares an endpoint to its one segment, so the
 * two runs produce the same frame vector at the shared point and the ribbons meet exactly. Cutting
 * at a vertex would leave one side mitred and the other square, which on a 12 m carriageway
 * through a right-angle bend is a visible notch in the kerb line.
 *
 * A run is never shorter than a third of a tile, so a way that grazes a corner is not chopped into
 * slivers. `out` receives sub-polylines; a way that fits in a tile yields the input array itself.
 */
function splitLongWay(grid, pts, out) {
  const n = pts.length;
  if (n < 3) { out.push(pts); return out; }
  const segLen = (k) => Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  let total = 0;
  for (let k = 0; k + 1 < n; k++) total += segLen(k);
  if (total <= grid.size) { out.push(pts); return out; }

  const minRun = grid.size * 0.35;
  let run = [pts[0]];
  let runLen = 0, doneLen = 0;
  let owner = grid.idAt((pts[0][0] + pts[1][0]) * 0.5, (pts[0][1] + pts[1][1]) * 0.5);
  for (let k = 0; k + 1 < n; k++) {
    const mx = (pts[k][0] + pts[k + 1][0]) * 0.5;
    const mz = (pts[k][1] + pts[k + 1][1]) * 0.5;
    const id = grid.idAt(mx, mz);
    const half = segLen(k) * 0.5;
    if (id !== owner && runLen + half >= minRun &&
      total - doneLen - runLen - half >= minRun && half > EPS) {
      run.push([mx, mz]);
      out.push(run);
      doneLen += runLen + half;
      run = [[mx, mz], pts[k + 1]];
      runLen = half;
      owner = id;
      // Verification: the two runs leave and arrive along the same segment, so this is zero up
      // to floating point. It is measured rather than asserted because it is the whole reason
      // the cut is where it is.
      continue;
    }
    owner = id;
    run.push(pts[k + 1]);
    runLen += half * 2;
  }
  if (run.length >= 2) out.push(run);
  else if (out.length) out[out.length - 1].push(pts[n - 1]);
  // Measure the join angle at every cut.
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const ax = a[a.length - 1][0] - a[a.length - 2][0];
    const az = a[a.length - 1][1] - a[a.length - 2][1];
    const bx = b[1][0] - b[0][0];
    const bz = b[1][1] - b[0][1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (!(la > EPS) || !(lb > EPS)) continue;
    const t = Math.acos(clamp((ax * bx + az * bz) / (la * lb), -1, 1));
    if (t > _worstCut) _worstCut = t;
  }
  return out;
}

/* ============================================================ binary load == */

/**
 * Decode data/toronto.bin (tools/pack_city.py) into exactly the object graph the JSON produced.
 *
 * The JSON extract is 11.8 MB of text — 3.3 MB gzipped — and JSON.parse has to build ~493,000
 * two-element arrays before anything else can start. The sidecar carries the same information as
 * typed arrays: 3.0 MB raw, 1.8 MB gzipped, and the coordinate walk below is a tight loop over
 * an Int16Array instead of a tokeniser.
 */
function decodeCity(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || u8[0] !== 84 || u8[1] !== 79 || u8[2] !== 82 || u8[3] !== 50) {
    throw new Error('city: bad sidecar magic');
  }
  const dv = new DataView(buf);
  const headLen = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(8, 8 + headLen)));
  const base = 8 + headLen;
  const table = head.blocks || {};
  const block = (name) => {
    const b = table[name];
    if (!b) return null;
    const off = base + b.off;
    switch (b.type) {
      case 'i8': return new Int8Array(buf, off, b.len);
      case 'u8': return new Uint8Array(buf, off, b.len);
      case 'i16': return new Int16Array(buf, off, b.len);
      case 'u16': return new Uint16Array(buf, off, b.len);
      case 'i32': return new Int32Array(buf, off, b.len);
      case 'f32': return new Float32Array(buf, off, b.len);
      default: return null;
    }
  };
  const EMPTY_I32 = new Int32Array(0);
  const dicts = head.dicts || {};
  const names = dicts.names || [];
  const str = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (v >= 0 && v < names.length) ? names[v] : '';
  };
  const enumOf = (table2, ids, k) => {
    const v = ids ? ids[k] : 255;
    return (v < 255 && table2 && v < table2.length) ? table2[v] : undefined;
  };

  // Ring reader: absolute int32 origin in centimetres, then int16 deltas with an escape.
  function rings(prefix) {
    const len = block(prefix + '.ringLen') || EMPTY_I32;
    const org = block(prefix + '.origin') || EMPTY_I32;
    const del = block(prefix + '.delta') || new Int16Array(0);
    const esc = block(prefix + '.esc') || EMPTY_I32;
    const out = new Array(len.length);
    let oi = 0, di = 0, ei = 0;
    for (let r = 0; r < len.length; r++) {
      const n = len[r];
      const ring = new Array(n);
      if (n <= 0) { out[r] = ring; continue; }
      let x = org[oi++], z = org[oi++];
      ring[0] = [x * 0.01, z * 0.01];
      for (let k = 1; k < n; k++) {
        const dx = del[di++], dz = del[di++];
        if (dx === -32768 && dz === -32768) { x = esc[ei++]; z = esc[ei++]; }
        else { x += dx; z += dz; }
        ring[k] = [x * 0.01, z * 0.01];
      }
      out[r] = ring;
    }
    return out;
  }

  const th = block('terrain.h');
  const terrain = {
    nx: head.terrain.nx, nz: head.terrain.nz, cell: head.terrain.cell,
    h: new Float64Array(th ? th.length : 0),
  };
  // Integer millimetres divided by 1000 is exactly the double that parsing the JSON literal
  // gives, so the two loaders produce identical terrain to the last bit.
  for (let i = 0; th && i < th.length; i++) terrain.h[i] = th[i] / 1000;

  const bRings = rings('buildings');
  const perB = block('buildings.ringsPer') || EMPTY_I32;
  const bh = block('buildings.h'), by = block('buildings.y'), bt = block('buildings.t');
  const bmat = block('buildings.mat'), bcolHas = block('buildings.colHas');
  const bcol = block('buildings.col'), bname = block('buildings.name');
  const buildings = new Array(perB.length);
  let ring = 0;
  for (let i = 0; i < perB.length; i++) {
    const cnt = perB[i];
    const rr = new Array(cnt);
    for (let k = 0; k < cnt; k++) rr[k] = bRings[ring++];
    const rec = { h: bh ? bh[i] / 100 : 0, y: by ? by[i] / 100 : 0, r: rr, t: bt ? bt[i] : 0 };
    const m = enumOf(dicts.buildingMat, bmat, i);
    if (m) rec.m = m;
    if (bcolHas && bcolHas[i]) {
      rec.c = [bcol[i * 3] / 10000, bcol[i * 3 + 1] / 10000, bcol[i * 3 + 2] / 10000];
    }
    const nm = str(bname, i);
    if (nm) rec.n = nm;
    buildings[i] = rec;
  }

  const rRings = rings('roads');
  const rcls = block('roads.cls'), rw = block('roads.w'), rlay = block('roads.lay');
  const rb = block('roads.b'), rtun = block('roads.tun'), rname = block('roads.name');
  const roads = new Array(rRings.length);
  for (let i = 0; i < rRings.length; i++) {
    roads[i] = {
      c: enumOf(dicts.roadClass, rcls, i) || 'minor',
      w: rw ? rw[i] / 100 : 8,
      n: str(rname, i),
      lay: rlay ? rlay[i] : 0,
      b: rb ? rb[i] : 0,
      tun: rtun ? rtun[i] : 0,
      p: rRings[i],
    };
  }

  const simple = (cls, key, dict) => {
    const rs = rings(cls);
    const kinds = block(cls + '.kind');
    const out = new Array(rs.length);
    for (let i = 0; i < rs.length; i++) {
      const rec = { p: rs[i] };
      rec[key] = enumOf(dicts[dict], kinds, i) || '';
      out[i] = rec;
    }
    return out;
  };
  const areas = simple('areas', 'k', 'areaKind');
  const rails = simple('rails', 'k', 'railKind');
  const shore = simple('shore', 'role', 'shoreRole');
  const waterfront = simple('waterfront', 'k', 'wfKind');
  const wname = block('waterfront.name');
  for (let i = 0; i < waterfront.length; i++) waterfront[i].n = str(wname, i);

  return { meta: head.meta || {}, terrain, buildings, roads, areas, rails, shore, waterfront };
}

async function fetchJson(url, onFrac) {
  if (typeof fetch !== 'function') throw new Error('city: fetch() unavailable');
  const res = await fetch(url);
  if (!res || !res.ok) {
    throw new Error('city: cannot load ' + url + (res ? ' (HTTP ' + res.status + ')' : ''));
  }
  const hdr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  const total = hdr ? Number(hdr) : 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const txt = await res.text();
    onFrac(1);
    return JSON.parse(txt);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (!r.value) continue;
    chunks.push(r.value);
    got += r.value.length;
    onFrac(total > 0 ? Math.min(1, got / total) : Math.min(0.95, got / 3.2e6));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) { buf.set(chunks[i], o); o += chunks[i].length; }
  onFrac(1);
  return JSON.parse(new TextDecoder('utf-8').decode(buf));
}

async function fetchBinary(url, onFrac) {
  const res = await fetch(url);
  if (!res || !res.ok) throw new Error('city: no sidecar at ' + url);
  const hdr = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-length') : null;
  const total = hdr ? Number(hdr) : 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    onFrac(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (!r.value) continue;
    chunks.push(r.value);
    got += r.value.length;
    onFrac(total > 0 ? Math.min(1, got / total) : Math.min(0.95, got / 3.2e6));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
  onFrac(1);
  return out.buffer;
}

/**
 * The packed sidecar if it is there, the JSON if it is not.
 *
 * The JSON stays authoritative — tools/build_city.py and tools/match_osm.py write it, and it is
 * what a human reads — so the loader must work without the sidecar ever having been generated.
 * Anything at all wrong with the .bin (missing, truncated, stale magic) falls back with a warning
 * rather than taking the page down.
 */
async function fetchCity(url, onFrac) {
  if (typeof fetch !== 'function') throw new Error('city: fetch() unavailable');
  const packed = String(url).replace(/\.json$/i, '.bin');
  if (packed !== url) {
    try {
      const buf = await fetchBinary(packed, onFrac);
      const data = decodeCity(buf);
      return { data, source: 'bin', bytes: buf.byteLength };
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[city] packed sidecar unavailable (' +
          ((e && e.message) ? e.message : e) + '); falling back to JSON');
      }
    }
  }
  const data = await fetchJson(url, onFrac);
  return { data, source: 'json', bytes: 0 };
}

/**
 * Load data/toronto.json and build the whole static city.
 * @param {WebGL2RenderingContext} gl
 * @param {string} url
 * @param {(frac:number, label:string)=>void} onProgress
 */
/**
 * The measurement surface. Every pass writes into one of these; the console summary and
 * tools/harness.mjs read it.
 *
 * It is a FACTORY rather than a literal because a tile that is rebuilt after eviction runs the
 * same emitters again, and counting its props and its paint quads a second time would turn the
 * audit into a function of how much flying the player did. A rebuild gets a scrap instance and
 * the real numbers stay the numbers from the first time the tile was built.
 */
function makeCityStats() {
  return {
    buildings: 0, verts: 0, tris: 0, roads: 0, rings: 0, ringsSkipped: 0,
    capFail: 0, seconds: 0, meshes: {},
    // Facade audit: how many buildings each material family and lighting profile claimed, and
    // how many took a surveyed OSM colour rather than a hashed one.
    materials: {}, profiles: [0, 0, 0, 0, 0, 0], surveyedColour: 0,
    // Accuracy invariants the harness re-checks every run.
    landmarkHeights: {}, gridDeg: 0,
    // Street-detail audit (CONTRACT §6.3 / §6.4).
    props: {}, facades: {
      groundFloors: 0, shopfronts: 0, balconyBands: 0, cornices: 0, stringCourses: 0,
      fireEscapes: 0, loadingDocks: 0, parapets: 0,
    },
    ground: {
      junctions: 0, signalised: 0, kerbRamps: 0, markings: 0, crosswalks: 0, stopBars: 0,
      arrows: 0, bikeLaneMetres: 0, footwayRuns: 0, footwayMetres: 0, kerbMetres: 0,
      tramMetres: 0, tramPoles: 0, wireMetres: 0, railMetres: 0,
      plazas: 0, plazaArea: 0,
    },
    // GRADE SEPARATION (CONTRACT 8.1). Every way is built at the level its signed layer puts it
    // on; nothing is skipped. `violations` is the number of real polyline crossings still left
    // without UNDER_CLEAR of headroom between the way above and the way below.
    grade: {
      under: 0, sub: 0, over: 0, passage: 0, crossings: 0, violations: 0, portals: 0,
      cutMetres: 0, roofedMetres: 0, subMetres: 0, wallMetres: 0, deepest: 0, nodes: 0, lidSteps: 0,
      railDecks: 0, railDeckMetres: 0, abutments: 0, passagePortals: 0, areaTrisCut: 0,
      wallPortals: 0, wallPortalMetres: 0, coveredMetres: 0, coverPortals: 0, tunnelLamps: 0,
    },
    // WALKABILITY (CONTRACT 8.2). Measured on the graph of what was actually BUILT, not on the
    // raw OSM topology: a way that was skipped is a hole a pedestrian falls into whatever the
    // survey says about it.
    walk: {
      metres: 0, largest: 0, fraction: 0, components: 0, islands: 0, islandMetres: 0,
      worstIslands: [], worstCliffs: [], cliffs: 0, cliffWorst: 0, samples: 0,
      stitched: 0, stitchMetres: 0, steps: 0, flights: 0, blockedMetres: 0, severedMetres: 0,
      groundHoles: 0, groundMin: 0, groundMax: 0, subNetMetres: 0, subComponents: 0,
    },
    propsInFootprint: 0, propsOnRoad: 0,
    markingsBelowRoad: 0, markLiftMin: Infinity, markLiftMax: -Infinity,
    // Ground-plane geometry audit. Every one of these is a class of artifact that is invisible in
    // a vertex count and glaring at street level, so each gets its own counter.
    markingsUnderCross: 0,   // paint swallowed by the crown of the street it crosses
    ribbonFolds: 0,          // ribbon quads that turned inside out at a corner
    pavementOverRoad: 0,     // sidewalk stations dropped because they ran out over a carriageway
    capDegenerate: 0,        // zero-area ears dropped before they reached the buffer
    // Orientation audit. Every one of these must come out zero: a yaw convention that is 90 or
    // 180 degrees out is invisible in a vertex count and glaring on screen.
    facadesFacingIn: 0, boomsMisaimed: 0, wireOffTrack: 0, wireMaxError: 0,
    // COPLANAR-GEOMETRY AUDIT. Two surfaces on one plane facing one way is a z-fight the depth
    // buffer cannot arbitrate at any precision, so it gets its own counters: what was found, what
    // was resolved, and — the number that matters — what is left. `left` must be zero.
    coplanar: {
      wallFaces: 0, wallPairs: 0, wallMetres: 0, wallPairsLeft: 0,
      wallFacesClipped: 0, wallFacesDropped: 0,
      capsBuried: 0, capsStepped: 0, capDropsClamped: 0, capPairsLeft: 0, buriedRecords: 0,
      groundRungMin: 0, groundRungMinMicro: 0, facadeProudMin: 0, facadeFaces: 0, facadeClamped: 0,
    },
    // DECK CLEARANCE AUDIT. The Gardiner is an elevated deck with surface streets under it; a
    // 9.6 m lamp mast on one of those streets goes straight through the expressway. Every prop
    // that stands up is measured against the soffit above it, and `propsThroughDeck` must be 0.
    deck: {
      segments: 0, propsShortened: 0, propsSkipped: 0, deckLamps: 0, propsThroughDeck: 0,
      minClearance: 0,
    },
    // Pedestrians, by kind and by where they were put.
    people: {
      total: 0, walking: 0, standing: 0, sitting: 0, grouped: 0, groups: 0,
      cyclists: 0, dogWalkers: 0,
      onSidewalk: 0, onFootway: 0, onPlaza: 0, inPark: 0, atStop: 0, atCrossing: 0,
      atShopfront: 0, inBikeLane: 0,
      core: 0, cells: 0, peakCell: 0, medianCell: 0,
      inFootprint: 0, onCarriageway: 0, sunk: 0,
    },
  };
}

/**
 * Load the city and stand up the tile system.
 *
 * The load is now two things rather than one. Everything TOPOLOGICAL — the terrain, the harbour,
 * the grade solve, footprint preparation, coplanar resolution, the road records, the junction
 * graph, the walkability audit — runs once, up front, and produces no vertices at all. Everything
 * GEOMETRIC is deferred to tiles.js, which builds a tile the first time the camera needs it and
 * throws the geometry away when it has been out of range long enough.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} url
 * @param {(frac:number, label:string)=>void} onProgress
 */
export async function loadCity(gl, url = './data/toronto.json', onProgress) {
  const report = typeof onProgress === 'function'
    // A throwing progress callback must never take the load down with it.
    ? (f, label) => { try { onProgress(clamp(f, 0, 1), label); } catch (e) { /* ignored */ } }
    : () => {};
  const t0 = now();
  _yields = 0;

  report(0.01, 'connecting');
  const loaded = await fetchCity(url, (f) => report(0.02 + f * 0.30, 'downloading city data'));
  const data = loaded.data;
  report(0.34, 'reading city data');
  await frame();

  const meta = data.meta || {};
  const extent = (meta.extent && isNum(meta.extent.x)) ? meta.extent : { x: 3141.7, z: 2226.4 };
  const project = makeProjector(meta.origin);
  const buildingsRaw = Array.isArray(data.buildings) ? data.buildings : [];
  const roadsRaw = Array.isArray(data.roads) ? data.roads : [];
  const areasRaw = Array.isArray(data.areas) ? data.areas : [];
  const railsRaw = Array.isArray(data.rails) ? data.rails : [];

  const stats = makeCityStats();
  // A tile rebuilt after eviction runs the same emitters a second time. Its counters go here and
  // are thrown away, so the audit stays a description of the city rather than of the flight path.
  const scrap = makeCityStats();
  stats.source = loaded.source;
  stats.bytes = loaded.bytes;

  _audit = stats;
  resetFacadeAudit();

  // Scratch builders for the two passes that genuinely cannot run a tile at a time; their output
  // is cut up by captureSplit() below and handed to the tiles that own it.
  const cap = makeBuilders();
  const waterMB = new MeshBuilder();
  // `mb` is rebound to the tile under construction; during the global phase it is the capture.
  let mb = cap;

  /* ---------------------------------------------------------------- terrain */
  report(0.36, 'building terrain');
  const infra = [];
  for (let i = 0; i < roadsRaw.length; i++) {
    if (Array.isArray(roadsRaw[i].p) && roadsRaw[i].p.length) infra.push(roadsRaw[i].p);
  }
  for (let i = 0; i < buildingsRaw.length; i++) {
    const rr = buildingsRaw[i].r;
    if (!Array.isArray(rr)) continue;
    for (let k = 0; k < rr.length; k++) if (Array.isArray(rr[k]) && rr[k].length) infra.push(rr[k]);
  }
  const pondRings = [];
  for (let i = 0; i < areasRaw.length; i++) {
    const a = areasRaw[i];
    if (!Array.isArray(a.p) || !a.p.length) continue;
    if (a.k === 'water') {
      const co = toPlan(a.p);
      if (co && Math.abs(planArea(co)) > 20) pondRings.push(co);
      continue;
    }
    infra.push(a.p);
  }
  for (let i = 0; i < railsRaw.length; i++) {
    if (railsRaw[i].k === 'subway') continue;
    if (Array.isArray(railsRaw[i].p) && railsRaw[i].p.length) infra.push(railsRaw[i].p);
  }
  const T = makeTerrain(data.terrain || { nx: 2, nz: 2, cell: 25, h: [0, 0, 0, 0] },
    extent, infra, pondRings, Array.isArray(data.shore) && data.shore.length > 0);

  /* ------------------------------------------------------------ harbourfront */
  // CONTRACT §8.3. The surveyed shoreline replaces the guessed one: harbour.js brings the terrain
  // down to the real water, terminates the land edge at the quay wall, and wraps T.groundY so the
  // quay apron and the pier decks ARE the ground as far as everything downstream is concerned.
  // Must run before anything reads T.groundY or emits the terrain mesh.
  const HARBOUR = buildHarbour(data, { extent, terrain: T, waterY: WATER_Y });
  if (HARBOUR) carveHarbourTerrain(T, HARBOUR);

  // The natural ground. Everything that is NOT part of the walking surface — the terrain mesh, the
  // lake, the railway, a bridge deck's own reference — reads this one.
  const terrainY = T.groundY;
  await frame();

  /* ------------------------------------------------------- grade separation */
  report(0.40, 'cutting the underpasses');
  const G = solveGrade(roadsRaw, railsRaw, buildingsRaw, extent, terrainY, stats);
  const gradeField = G.field;
  await frame();

  // ...and the WALKING surface, which is the terrain with every depressed corridor cut into it.
  // One composition, read by the carriageway ribbons, the pavement, every prop, the pedestrians
  // and the player, so no two of them can ever disagree about where the ground is.
  const groundY = (x, z) => terrainY(x, z) + gradeField.offset(x, z);
  terrainNormals(T);
  // The lake is the one surface that is not tiled: 30 k vertices, visible from nearly every
  // viewpoint in the world, and drawn by its own reflection pass.
  emitWaterMesh(waterMB, T, extent, HARBOUR);
  report(0.44, 'shoreline');
  await frame();

  /* -------------------------------------------------------------- buildings */
  const prepped = new Array(buildingsRaw.length);
  for (let i = 0; i < buildingsRaw.length; i++) {
    const b = buildingsRaw[i];
    const rings = Array.isArray(b.r) ? b.r : [];
    let cx = 0, cz = 0, n = 0;
    const r0 = rings[0];
    if (Array.isArray(r0)) {
      for (let k = 0; k < r0.length; k++) {
        if (!isNum(r0[k][0])) continue;
        cx += r0[k][0]; cz += r0[k][1]; n++;
      }
    }
    prepped[i] = {
      key: i + 1,
      // ISLANDS: on the island cottages the massing extract's height is the tree canopy over the
      // roof, not the roof. islandBuildingHeight() caps a small island footprint at a plausible
      // house; everywhere else it returns b.h untouched. See harbour.js.
      h: islandBuildingHeight(HARBOUR, n ? cx / n : 0, n ? cz / n : 0, ringPlanArea(r0),
        isNum(b.h) ? b.h : 0),
      y: isNum(b.y) ? b.y : 0,
      cx: n ? cx / n : 0,
      cz: n ? cz / n : 0,
      rings,
      // Surveyed per-building attributes: lighting profile, facade colour, material, name.
      t: b.t,
      c: b.c,
      m: b.m,
      name: typeof b.n === 'string' ? b.n : '',
      parts: null,
      mainPart: null,
      area: 0,
      mat: null,
      profile: 0,
      cls: '',
      landmark: null,
      bbox: null,
      towerSign: -1,
      // Street frontage, filled in by findFrontage() during the facade pass.
      frontX: 0, frontZ: 0, frontYaw: 0, frontLen: 0, frontNU: 1, frontNV: 0,
    };
  }
  const claims = assignLandmarks(prepped, project);

  const bIndex = makeGridIndex(48, -extent.x / 2 - 200, -extent.z / 2 - 200,
    Math.ceil((extent.x + 400) / 48) + 1, Math.ceil((extent.z + 400) / 48) + 1);

  const cnPoint = project(-79.3871, 43.6426);
  let cnBuilding = null;
  let cnDone = false;

  // Footprint preparation only: rings are split into parts and oriented, but NOTHING is
  // triangulated here. Ear clipping happens inside emitCap(), which now runs per tile, so the
  // cost of the roof of a building nobody has flown near yet is never paid.
  report(0.46, 'reading footprints');
  await chunked(prepped.length, 600, (i) => {
    const b = prepped[i];
    if (b.h <= 0.5) return;
    const parts = buildParts(b.rings, MIN_RING_AREA);
    if (!parts) { stats.ringsSkipped++; return; }
    b.parts = parts;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    let area = 0, bestArea = -1;
    for (let p = 0; p < parts.length; p++) {
      const bb = planBBox(parts[p].outer);
      x0 = Math.min(x0, bb[0]); x1 = Math.max(x1, bb[2]);
      z0 = Math.min(z0, -bb[3]); z1 = Math.max(z1, -bb[1]);
      const a = Math.abs(planArea(parts[p].outer));
      area += a;
      // The detail pass hangs the frontage, the roofscape and the parapet off ONE part; a stacked
      // massing record has several, and the biggest is the one a pedestrian actually meets.
      if (a > bestArea) { bestArea = a; b.mainPart = parts[p]; }
    }
    b.bbox = [x0, z0, x1, z1];
    b.area = bestArea > 0 ? bestArea : area;
    bIndex.add(x0, z0, x1, z1, b);
    stats.buildings++;
    stats.rings += parts.length;

    const L = claims[i];
    b.landmark = L ? L.key : null;
    if (L) stats.landmarkHeights[L.key] = Math.max(stats.landmarkHeights[L.key] || 0, b.h);
    const isCN = L && L.key === 'cn';
    if (isCN && !cnDone) {
      cnDone = true;
      cnBuilding = b;
      b.mat = M.cnShaft;
      b.profile = 0;
      b.cls = 'concrete';
      b.glass = false;
      stats.materials.concrete = (stats.materials.concrete || 0) + 1;
      stats.profiles[0]++;
      return;
    }
    if (isCN) return;

    const spec = facadeMaterial(b, L);
    b.mat = spec.mat;
    b.profile = spec.profile;
    b.cls = spec.cls;
    b.glass = spec.glassy;
    stats.materials[spec.cls] = (stats.materials[spec.cls] || 0) + 1;
    stats.profiles[spec.profile]++;
    if (spec.tagged) stats.surveyedColour++;
  }, (f) => report(0.46 + f * 0.06, 'reading footprints'));

  // The CN Tower must exist even if the massing record was rejected. Either way it is a feature
  // like any other, anchored in the tile that holds it.
  const cnX = cnBuilding ? cnBuilding.cx : cnPoint[0];
  const cnZ = cnBuilding ? cnBuilding.cz : cnPoint[1];
  const cnBaseY = cnBuilding ? cnBuilding.y - 0.6 : groundY(cnPoint[0], cnPoint[1]);

  /* ------------------------------------------------- coplanar resolution -- */
  // Which faces are worth drawing depends on what the NEIGHBOURING records draw, and no record
  // knows its neighbours until every ring is built. This is a global pass and stays one: it is
  // pure analysis, it produces no vertices, and it decides what each tile is allowed to emit.
  report(0.52, 'resolving coplanar faces');
  await frame();
  resolveCoplanarWalls(prepped, extent, stats);
  await frame();
  // Open every wall a corridor or a passage runs through, before a single quad is emitted.
  punchCorridorPortals(prepped, gradeField, terrainY, stats);
  await frame();
  resolveCoplanarCaps(prepped, bIndex, stats);
  await frame();

  /* ------------------------------------------------------------------ roads */
  report(0.58, 'reading the street network');

  // Bridge ways that meet end-to-end must not each ramp back down to grade at the join, or the
  // Gardiner becomes a row of humps. Endpoints shared with another bridge way stay elevated.
  const endKey = (p) => Math.round(p[0] * 2) + ':' + Math.round(p[1] * 2);
  const bridgeEnds = new Map();
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    if (G.kind[i] !== WAY_OVER || !Array.isArray(r.p) || r.p.length < 2) continue;
    for (const p of [r.p[0], r.p[r.p.length - 1]]) {
      const k = endKey(p);
      bridgeEnds.set(k, (bridgeEnds.get(k) || 0) + 1);
    }
  }

  const grid = makeTileGrid(extent, TILE_SIZE, 420);

  // Footways are built LAST of the ground plane, because whether a walkway is worth building at
  // all depends on what the carriageways and their sidewalk ribbons already cover. NOTHING is
  // skipped: an underground concourse goes to the subsurface pass, everything else is a surface
  // way whose height comes from the grade field.
  const roadJobs = [];
  const footJobs = [];
  const subJobs = [];
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (G.kind[i] === WAY_SUB) subJobs.push(i);
    else if (r.c === 'foot') footJobs.push(i);
    else roadJobs.push(i);
  }
  stats.roads = roadJobs.length + footJobs.length + subJobs.length;

  const recs = [];
  const _spans = [];
  let splitWays = 0;
  _worstCut = 0;

  const buildRec = (gi, r, raw, whole, cutA, cutB) => {
    const over = G.kind[gi] === WAY_OVER;
    const cor = G.corridor[gi];
    const cls = ROAD_CLASS_OK[r.c] ? r.c : 'minor';
    const w = clamp(isNum(r.w) ? r.w : 8, 1.6, 44);
    let pts = polyResample(raw, ROAD_MAX_SEG);
    if (pts.length < 2) return;
    const hw = w / 2;
    // Frames must be clamped against the OUTERMOST edge these roads carry: the sidewalk band.
    const reach = hw + (SIDEWALK_W[cls] > 0 ? 0.25 + SIDEWALK_W[cls] : 0);
    pts = pruneSpikes(pts, reach);
    if (pts.length < 2) return;
    const frames = polyFrames(pts, reach);
    const foot = cls === 'pedestrian';
    const crowned = !foot && cls !== 'service' && w > 7;

    // Cumulative arc length. Every later pass addresses this road by metres travelled along it.
    const arc = new Float64Array(pts.length);
    for (let k = 1; k < pts.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }

    let deck = null;
    if (over) {
      // Deck height, with a ramp back to grade only at ends that no other elevated way continues
      // — and never at a tile cut, which is a join in the middle of one continuous structure.
      const rise = G.rise[gi];
      const rampA = cutA || (bridgeEnds.get(endKey(raw[0])) || 0) > 1
        ? 0 : Math.max(20, rise * 4.5);
      const last = endKey(raw[raw.length - 1]);
      const rampB = cutB || (bridgeEnds.get(last) || 0) > 1 ? 0 : Math.max(20, rise * 4.5);
      const total = arc[pts.length - 1] || 1;
      deck = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k++) {
        const a = rampA > 0 ? smoothstep(0, rampA, arc[k]) : 1;
        const b = rampB > 0 ? smoothstep(0, rampB, total - arc[k]) : 1;
        // A deck is measured from the NATURAL ground, never from the walking surface: a flyover
        // over an underpass must not dive into the trench it is bridging.
        deck[k] = terrainY(pts[k][0], pts[k][1]) + ROAD_Y + rise * Math.min(a, b);
      }
    }

    // 88 of the 97 highway=pedestrian ways in the extract are CLOSED RINGS: they are plazas and
    // courtyards mapped as areas, not as routes. Dragging a 9 m ribbon round the outline of one
    // paves 64% more ground than the plaza contains, overlaps itself at every corner of the ring
    // (two coincident surfaces, so the depth buffer flickers between them), and throws the corners
    // out across whatever street runs past. Fill the ring instead: same material, right shape.
    const rp = r.p;
    const closed = foot && whole && rp.length > 3 &&
      Math.hypot(rp[0][0] - rp[rp.length - 1][0], rp[0][1] - rp[rp.length - 1][1]) < 0.5;
    const plaza = closed ? buildParts([r.p], PLAZA_MIN_AREA) : null;
    if (plaza) {
      stats.ground.plazas++;
      stats.ground.plazaArea += Math.abs(planArea(plaza[0].outer));
    }

    const name = typeof r.n === 'string' ? r.n : '';
    const mid = pts[pts.length >> 1];
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      if (pts[k][0] < bx0) bx0 = pts[k][0];
      if (pts[k][0] > bx1) bx1 = pts[k][0];
      if (pts[k][1] < bz0) bz0 = pts[k][1];
      if (pts[k][1] > bz1) bz1 = pts[k][1];
    }
    recs.push({
      id: recs.length,
      cls, w, hw, name, pts, frames, s: arc, len: arc[pts.length - 1],
      deck, crowned, bridge: over, foot: false, junc: [], gi, corridor: cor,
      under: G.kind[gi] === WAY_UNDER, passage: G.kind[gi] === WAY_PASSAGE,
      bike: (cls === 'major' || cls === 'minor') && isBikeStreet(name),
      commercial: !!name && (cls === 'major' || cls === 'minor'),
      heritage: cls !== 'motorway' && inAcornZone(mid[0], mid[1]),
      plaza, target: foot ? 'sidewalks' : 'roads',
      mat: foot ? M.path
        : (cls === 'motorway' ? M.highway : (cls === 'service' ? M.service : M.asphalt)),
      bbox: [bx0, bz0, bx1, bz1],
      mx: mid[0], mz: mid[1],
    });
  };

  await chunked(roadJobs.length, 400, (job) => {
    const gi = roadJobs[job];
    const r = roadsRaw[gi];
    const rp = r.p;
    const ring = r.c === 'pedestrian' && rp.length > 3 &&
      Math.hypot(rp[0][0] - rp[rp.length - 1][0], rp[0][1] - rp[rp.length - 1][1]) < 0.5;
    _spans.length = 0;
    if (ring) _spans.push(rp);
    else splitLongWay(grid, rp, _spans);
    if (_spans.length > 1) splitWays++;
    for (let s = 0; s < _spans.length; s++) {
      if (_spans[s].length < 2) continue;
      buildRec(gi, r, _spans[s], _spans.length === 1, s > 0, s < _spans.length - 1);
    }
  }, (f) => report(0.58 + f * 0.04, 'reading the street network'));
  stats.recs = recs.length;
  stats.splitWays = splitWays;
  stats.worstCutDeg = _worstCut * 180 / Math.PI;

  /* --------------------------------------------------- carriageway indexing */
  // Bridges are deliberately left out: the Gardiner is 8 m overhead, and letting its deck claim
  // the ground under it would delete every walkway and prop in the Harbourfront.
  const gx0 = -extent.x / 2 - 400, gz0 = -extent.z / 2 - 400;
  const gnx = Math.ceil((extent.x + 800) / 32) + 1;
  const gnz = Math.ceil((extent.z + 800) / 32) + 1;
  const roadIdx = makeGridIndex(32, gx0, gz0, gnx, gnz);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.bridge) continue;
    const sw = SIDEWALK_W[rec.cls] || 0;
    const cover = rec.hw + (sw > 0 ? 0.25 + sw + 0.85 : 0.30);
    const cr = rec.crowned ? 1 : 0;
    for (let k = 1; k < rec.pts.length; k++) {
      const a = rec.pts[k - 1], b = rec.pts[k];
      roadIdx.add(Math.min(a[0], b[0]) - cover, Math.min(a[1], b[1]) - cover,
        Math.max(a[0], b[0]) + cover, Math.max(a[1], b[1]) + cover,
        [a[0], a[1], b[0], b[1], rec.hw, cr, cover, i, sw > 0 ? rec.hw + 0.25 + sw : 0,
          rec.corridor]);
    }
  }

  /* ------------------------------------------------------------ deck cover */
  // The bridges left out of the carriageway index above get their own, filed by SOFFIT height —
  // what is overhead, rather than what is underfoot. See the elevated-deck section.
  const deckIdx = makeGridIndex(32, gx0, gz0, gnx, gnz);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec.bridge || !rec.deck) continue;
    const depth = rec.cls === 'motorway' ? 1.9 : 1.3;
    // The ribbon is mitred, so a corner throws the deck edge out past hw; cover the widest it
    // can reach plus the fascia, or a prop just clear of the kerb line slips through the test.
    const cover = rec.hw + MITER_OVER + 0.4;
    for (let k = 1; k < rec.pts.length; k++) {
      const a = rec.pts[k - 1], b = rec.pts[k];
      deckIdx.add(Math.min(a[0], b[0]) - cover, Math.min(a[1], b[1]) - cover,
        Math.max(a[0], b[0]) + cover, Math.max(a[1], b[1]) + cover,
        [a[0], a[1], b[0], b[1], cover, rec.deck[k - 1] - depth, rec.deck[k] - depth]);
      stats.deck.segments++;
    }
  }

  /* -------------------------------------------------------------- junctions */
  // Derived from where road polylines ACTUALLY meet: OSM ways share a node at a junction, so
  // every vertex is hashed and the branch directions arriving there are counted. A way merely
  // split in two contributes one branch each way and stays a straight street; three or more
  // distinct directions is a real intersection.
  const jkey = (x, z) => Math.round(x * 4) + ':' + Math.round(z * 4);
  const nodes = new Map();
  const addDir = (nd, dx, dz) => {
    const l = Math.hypot(dx, dz);
    if (!(l > 0.05)) return false;
    const ux = dx / l, uz = dz / l;
    for (let k = 0; k < nd.dirs.length; k += 2) {
      if (nd.dirs[k] * ux + nd.dirs[k + 1] * uz > 0.985) return false;
    }
    nd.dirs.push(ux, uz);
    return true;
  };
  for (let i = 0; i < roadJobs.length; i++) {
    const gi = roadJobs[i];
    const r = roadsRaw[gi];
    const cls = ROAD_CLASS_OK[r.c] ? r.c : 'minor';
    if (G.kind[gi] === WAY_OVER ||
      (cls !== 'motorway' && cls !== 'major' && cls !== 'minor')) continue;
    const big = cls !== 'minor';
    const hw = clamp(isNum(r.w) ? r.w : 8, 1.6, 44) / 2;
    const p = r.p;
    for (let k = 0; k < p.length; k++) {
      if (!isNum(p[k][0]) || !isNum(p[k][1])) continue;
      const key = jkey(p[k][0], p[k][1]);
      let nd = nodes.get(key);
      if (!nd) {
        nd = {
          x: p[k][0], z: p[k][1], dirs: [], hw: 0, majors: 0,
          r: 0, cross: false, signal: false, signAng: 0,
        };
        nodes.set(key, nd);
      }
      if (hw > nd.hw) nd.hw = hw;
      const prev = k > 0 && addDir(nd, p[k - 1][0] - p[k][0], p[k - 1][1] - p[k][1]);
      const next = k < p.length - 1 &&
        addDir(nd, p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
      if (big) nd.majors += (prev ? 1 : 0) + (next ? 1 : 0);
    }
  }
  const junctions = new Map();
  for (const [key, nd] of nodes) {
    if (nd.dirs.length < 6) continue;
    nd.r = clamp(nd.hw, 3.0, 16.0);
    nd.cross = nd.hw >= 5.0;
    nd.signal = nd.majors >= 2 && nd.hw >= 5.5;
    const a0 = Math.atan2(-nd.dirs[1], nd.dirs[0]);
    let d = Math.atan2(-nd.dirs[3], nd.dirs[2]) - a0;
    while (d < 0) d += TAU;
    nd.signAng = a0 + d * 0.5;
    junctions.set(key, nd);
    stats.ground.junctions++;
    if (nd.signal) stats.ground.signalised++;
  }
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    let last = null;
    for (let k = 0; k < rec.pts.length; k++) {
      const J = junctions.get(jkey(rec.pts[k][0], rec.pts[k][1]));
      // Two vertices a few centimetres apart hash into the same 0.25 m bucket; recording both
      // would paint the crossing twice, in the same place, and z-fight it against itself.
      if (!J || J === last) continue;
      rec.junc.push({ s: rec.s[k], r: J.r, J });
      last = J;
    }
  }

  // Dominant street-grid bearing, folded into [0, 90): an accuracy invariant, not decoration.
  {
    const bins = new Float64Array(360);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.cls !== 'major' && rec.cls !== 'minor') continue;
      for (let k = 1; k < rec.pts.length; k++) {
        const dx = rec.pts[k][0] - rec.pts[k - 1][0];
        const dz = rec.pts[k][1] - rec.pts[k - 1][1];
        const l = Math.hypot(dx, dz);
        if (l < 2) continue;
        let a = Math.atan2(-dz, dx) * 180 / Math.PI;
        a = ((a % 90) + 90) % 90;
        bins[Math.min(359, Math.floor(a * 4))] += l;
      }
    }
    let best = 0;
    for (let i = 1; i < 360; i++) if (bins[i] > bins[best]) best = i;
    const deg = (best + 0.5) / 4;
    stats.gridDeg = deg > 45 ? 90 - deg : deg;
  }

  /* --------------------------------------------------------- detail context */
  // One context object, rebound per tile. `mb`, `rng`, `occ`, `stats` and the site lists all
  // belong to the tile being built; the indices are global and read-only from here on.
  const tramIdx = makeGridIndex(24, gx0, gz0,
    Math.ceil((extent.x + 800) / 24) + 1, Math.ceil((extent.z + 800) / 24) + 1);
  const C = {
    mb, groundY, terrainY, grade: gradeField, bIndex, roadIdx, tramIdx, deckIdx,
    rng: makeRng(SEED), stats, pedSeed: PED_SEED, tilePeople: 0,
    harbour: HARBOUR,
    occ: makeOccupancy(5.0, gx0, gz0,
      Math.ceil((extent.x + 800) / 5) + 1, Math.ceil((extent.z + 800) / 5) + 1),
    // Sites the people pass draws on, recorded by the passes that built them so nobody is
    // scattered anywhere the city has not already said is walkable.
    stations: [], corners: [], benches: [], walks: [], plazas: [], retail: [],
    crowd: new Map(),
    audit: [], auditRoad: [], auditDeck: [], auditPed: [],
  };

  for (let i = 0; i < railsRaw.length; i++) {
    const r = railsRaw[i];
    if (!r || r.k !== 'tram' || !Array.isArray(r.p) || r.p.length < 2) continue;
    for (let k = 1; k < r.p.length; k++) {
      const a = r.p[k - 1], b = r.p[k];
      if (!isNum(a[0]) || !isNum(b[0])) continue;
      tramIdx.add(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1,
        Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, [a[0], a[1], b[0], b[1]]);
    }
  }

  /* ------------------------------------------------------------- walkability */
  // CONTRACT 8.2. A global pass by nature — a connected component is not a local property — and
  // it BUILDS things: paved connectors over gaps and real flights of steps at cliffs. Its
  // geometry goes into the capture and is cut up per tile below.
  report(0.63, 'checking the walk');
  await frame();
  auditWalkability(C, G, roadsRaw, extent, stats);
  await frame();

  /* ------------------------------------------------------------ harbourfront */
  // CONTRACT §8.3. Everything on the water: the quay wall and its apron, the piers and their pile
  // structure, the rubble mounds, the marina floats, the ferry terminal slips, the boardwalk and
  // the trail, and the furniture that stands on all of it. harbour.js walks 32 km of surveyed
  // shoreline as continuous runs and city.js does not own it, so it too runs once into the
  // capture and is cut up afterwards.
  const hClaims = [];
  if (HARBOUR) {
    report(0.68, 'building the quay');
    appendHarbour(HARBOUR, {
      mb: cap,
      data,
      claim: (x, z, r) => {
        if (!C.occ.claim(x, z, r)) return false;
        hClaims.push(x, z, r);
        return true;
      },
      note: (kind) => noteProp(C, kind),
    });
    await frame();
  }

  /* ------------------------------------------------------------------ areas */
  // Parks, grass, surface lots and piers, prepared but not filled. Each PART is indexed
  // separately: a park mapped as three polygons belongs in three tiles, not one.
  report(0.72, 'parks and quays');
  const areaParts = [];
  const lotParts = [];
  const pierParts = [];
  const parkParts = [];
  await chunked(areasRaw.length, 400, (i) => {
    const a = areasRaw[i];
    if (!a || !Array.isArray(a.p) || a.p.length < 3) return;
    if (a.k === 'water') return;                         // handled with the terrain
    const parts = buildParts([a.p], 8);
    if (!parts) return;
    let target = 'terrain', dy = PARK_Y, m = M.park;
    if (a.k === 'grass') { m = M.grass; dy = GRASS_Y; }
    else if (a.k === 'parking') { target = 'roads'; m = M.parking; dy = LOT_Y; }
    else if (a.k === 'pier') { target = 'roads'; m = M.pier; dy = PIER_Y; }
    // The extract carries duplicate and nested polygons of the same kind. Identical covers laid at
    // an identical height are the one case the depth buffer cannot resolve at all, so stagger them
    // by a few millimetres — under every rung of the ladder, over every float epsilon.
    dy += ((i % 3) - 1) * DUP_STAGGER;
    // HARBOURFRONT: a pier standing in the surveyed lake is built as real structure — deck,
    // fascia and piles — by harbour.js, so the flat draped cap is suppressed there. The parts
    // are still collected, because the berths and the moored craft hang off them.
    const harbourPier = a.k === 'pier' && HARBOUR &&
      harbourWaterAt(HARBOUR, a.p[0][0], a.p[0][1]);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      part.kind = a.k;
      part.mat = m;
      part.dy = dy;
      part.target = target;
      part.drape = !harbourPier;
      part.treeCap = 0;
      part.boats = 0;
      part.berth = false;
      part.crane = false;
      areaParts.push(part);
      if (a.k === 'parking') lotParts.push(part);
      else if (a.k === 'pier') pierParts.push(part);
      else if (a.k === 'park') parkParts.push(part);
    }
  }, (f) => report(0.72 + f * 0.03, 'parks and quays'));

  // The rare, deliberately-scarce things are chosen HERE, city-wide and deterministically, so
  // that which tile happens to be built first can never change which sites get them.
  {
    const areaKm2 = Math.max(1, (extent.x * extent.z) / 1e6);
    const treeBudgetTotal = Math.round(MAX_PARK_TREES * areaKm2 / 7);
    let left = treeBudgetTotal;
    for (let i = 0; i < parkParts.length && left > 0; i++) {
      const area = Math.abs(planArea(parkParts[i].outer));
      if (area < 420) continue;
      const cap2 = Math.min(26, Math.floor(area / 260), left);
      parkParts[i].treeCap = cap2;
      left -= cap2;
    }
    let boats = MAX_BOATS;
    for (let i = 0; i < pierParts.length; i++) {
      if (i < 3) pierParts[i].berth = true;
      if (boats <= 0) continue;
      const n = Math.min(3, boats);
      pierParts[i].boats = n;
      boats -= n;
    }
    const big = [];
    for (let i = 0; i < lotParts.length; i++) {
      if (Math.abs(planArea(lotParts[i].outer)) >= 2200) big.push(lotParts[i]);
    }
    big.sort((p, q) => Math.abs(planArea(q.outer)) - Math.abs(planArea(p.outer)));
    for (let i = 0; i < Math.min(MAX_CRANES, big.length); i++) big[i].crane = true;

    const tall = [];
    for (let i = 0; i < prepped.length; i++) {
      const b = prepped[i];
      if (!b.parts || b.buried || b.landmark === 'cn' || b.h < 108) continue;
      tall.push(b);
    }
    tall.sort((p, q) => (q.h - p.h) || (p.cx - q.cx));
    // A tower only carries crown signage if it has real street frontage to hang it on, and the
    // facade pass does not run until the tile is built. Resolve the frontage HERE, for the
    // hundred tallest candidates only, so the eight that get a sign are the eight the old
    // single-pass build would have chosen and not whichever happen to be built first.
    let signs = 0;
    for (let i = 0; i < tall.length && signs < MAX_TOWER_SIGNS; i++) {
      findFrontage(C, tall[i]);
      if (tall[i].frontLen < 7) continue;
      tall[i].towerSign = signs++;
    }
  }
  await frame();

  /* ================================================================= tiles == */
  report(0.76, 'indexing tiles');

  for (let k = 0; k < grid.tiles.length; k++) {
    grid.tiles[k].f = {
      i0: 0, i1: 0, j0: 0, j1: 0,
      b: [], recs: [], foot: [], sub: [], pass: [], corr: [], rails: [],
      areas: [], junc: [], parks: [], plazas: [], cn: false, harbour: null, isle: false,
    };
    grid.tiles[k].built = [false, false];
  }

  // --- terrain cells. Quad (i, j) belongs to the tile holding its centre, so the whole sheet is
  // still emitted exactly once and neighbouring tiles share their edge vertices to the bit.
  {
    const qi = Math.max(1, T.nx - 1), qj = Math.max(1, T.nz - 1);
    const colOf = new Int32Array(qi), rowOf = new Int32Array(qj);
    for (let i = 0; i < qi; i++) colOf[i] = grid.ci(T.x0 + (i + 0.5) * T.cell);
    for (let j = 0; j < qj; j++) rowOf[j] = grid.cj(T.z0 + (j + 0.5) * T.cell);
    const colA = new Int32Array(grid.nx).fill(-1), colB = new Int32Array(grid.nx).fill(-1);
    const rowA = new Int32Array(grid.nz).fill(-1), rowB = new Int32Array(grid.nz).fill(-1);
    for (let i = 0; i < qi; i++) {
      const c = colOf[i];
      if (colA[c] < 0) colA[c] = i;
      colB[c] = i + 1;
    }
    for (let j = 0; j < qj; j++) {
      const c = rowOf[j];
      if (rowA[c] < 0) rowA[c] = j;
      rowB[c] = j + 1;
    }
    for (let tj = 0; tj < grid.nz; tj++) {
      for (let ti = 0; ti < grid.nx; ti++) {
        const t = grid.tiles[tj * grid.nx + ti];
        if (colA[ti] < 0 || rowA[tj] < 0) continue;
        t.f.i0 = colA[ti]; t.f.i1 = colB[ti];
        t.f.j0 = rowA[tj]; t.f.j1 = rowB[tj];
        let y0 = Infinity, y1 = -Infinity;
        for (let j = t.f.j0; j <= t.f.j1 && j < T.nz; j++) {
          for (let i = t.f.i0; i <= t.f.i1 && i < T.nx; i++) {
            const h = T.h[j * T.nx + i];
            if (h < y0) y0 = h;
            if (h > y1) y1 = h;
          }
        }
        // The trenches cut down and the props stand up; give the ground box real headroom.
        grid.cover(t, T.x0 + t.f.i0 * T.cell, T.z0 + t.f.j0 * T.cell,
          T.x0 + t.f.i1 * T.cell, T.z0 + t.f.j1 * T.cell, y0 - DEPTH_MAX - 2, y1 + 14);
      }
    }
  }

  // --- buildings, by footprint centroid.
  for (let i = 0; i < prepped.length; i++) {
    const b = prepped[i];
    if (!b.parts || b.buried) continue;
    const t = grid.at(b.cx, b.cz);
    t.f.b.push(b);
    grid.cover(t, b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3], b.y - 2, b.y + b.h + 6);
  }
  {
    const t = grid.at(cnX, cnZ);
    t.f.cn = true;
    grid.cover(t, cnX - 60, cnZ - 60, cnX + 60, cnZ + 60, cnBaseY - 2, cnBaseY + 560);
  }

  // --- road records. Sidewalk bands, kerb ramps and street furniture all live within a few
  // metres of the carriageway, and a 12 m lamp mast stands above it.
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const t = grid.at(rec.mx, rec.mz);
    t.f.recs.push(rec);
    const pad = rec.hw + (SIDEWALK_W[rec.cls] || 0) + MITER_OVER + 3;
    const gy = groundY(rec.mx, rec.mz);
    grid.cover(t, rec.bbox[0] - pad, rec.bbox[1] - pad, rec.bbox[2] + pad, rec.bbox[3] + pad,
      gy - DEPTH_MAX - 4, gy + (rec.bridge ? 24 : 14));
    if (rec.plaza) {
      for (let p = 0; p < rec.plaza.length; p++) t.f.plazas.push(rec.plaza[p]);
    }
  }

  const spanOf = (pts) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      if (pts[k][0] < x0) x0 = pts[k][0];
      if (pts[k][0] > x1) x1 = pts[k][0];
      if (pts[k][1] < z0) z0 = pts[k][1];
      if (pts[k][1] > z1) z1 = pts[k][1];
    }
    return [x0, z0, x1, z1];
  };
  const indexLine = (list, item, pts, pad, dy0, dy1) => {
    const mid = pts[pts.length >> 1];
    const t = grid.at(mid[0], mid[1]);
    list(t).push(item);
    const bb = spanOf(pts);
    const gy = groundY(mid[0], mid[1]);
    grid.cover(t, bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad, gy + dy0, gy + dy1);
    return t;
  };

  // --- footways, the concourse, building passages, corridors.
  for (let i = 0; i < footJobs.length; i++) {
    const r = roadsRaw[footJobs[i]];
    _spans.length = 0;
    splitLongWay(grid, r.p, _spans);
    for (let s = 0; s < _spans.length; s++) {
      const sub = _spans[s];
      if (sub.length < 2) continue;
      indexLine((t) => t.f.foot, { r, p: sub }, sub, 8, -4, 8);
    }
  }
  for (let i = 0; i < subJobs.length; i++) {
    const gi = subJobs[i];
    const r = roadsRaw[gi];
    indexLine((t) => t.f.sub, { r, gi }, r.p, 12, -DEPTH_MAX - 8, 2);
  }
  for (let i = 0; i < roadsRaw.length; i++) {
    if (G.kind[i] !== WAY_PASSAGE) continue;
    const r = roadsRaw[i];
    if (!Array.isArray(r.p) || r.p.length < 2) continue;
    indexLine((t) => t.f.pass, { r, hw: clamp(isNum(r.w) ? r.w : 6, 1.6, 44) / 2 }, r.p, 10, -6, 10);
  }
  {
    const seen = new Set();
    for (let i = 0; i < roadsRaw.length; i++) {
      const cor = G.corridor[i];
      if (!cor || seen.has(cor)) continue;
      seen.add(cor);
      if (!Array.isArray(cor.pts) || cor.pts.length < 2) continue;
      indexLine((t) => t.f.corr, cor, cor.pts, TRENCH_VERGE + TRENCH_WALL + 6,
        -DEPTH_MAX - 4, 8);
    }
    stats.grade.corridors = seen.size;
  }

  // --- rails and streetcar track, split the same way the roads were.
  for (let i = 0; i < railsRaw.length; i++) {
    const r = railsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2 || r.k === 'subway') continue;
    _spans.length = 0;
    splitLongWay(grid, r.p, _spans);
    for (let s = 0; s < _spans.length; s++) {
      const sub = _spans[s];
      if (sub.length < 2) continue;
      indexLine((t) => t.f.rails, { raw: r, gi: i, p: sub, heavy: r.k === 'rail' }, sub,
        6, -RAIL_DECK - 4, TRAM_POLE_H + 2);
    }
  }

  stats.worstCutDeg = _worstCut * 180 / Math.PI;

  // --- area parts and junctions.
  for (let i = 0; i < areaParts.length; i++) {
    const part = areaParts[i];
    const bb = part.bbox;
    const cu = (bb[0] + bb[2]) * 0.5, cv = (bb[1] + bb[3]) * 0.5;
    const t = grid.at(cu, -cv);
    t.f.areas.push(part);
    if (part.kind === 'park') t.f.parks.push(part);
    const gy = groundY(cu, -cv);
    grid.cover(t, bb[0], -bb[3], bb[2], -bb[1], gy - 4, gy + 16);
  }
  for (const J of junctions.values()) {
    const t = grid.at(J.x, J.z);
    t.f.junc.push(J);
    const gy = groundY(J.x, J.z);
    grid.cover(t, J.x - J.r - 4, J.z - J.r - 4, J.x + J.r + 4, J.z + J.r + 4, gy - 2, gy + 10);
  }

  // --- ISLANDS AND AIRPORT. Not indexed feature by feature: harbour.js holds its own spatial
  // model of the island edges, the airfield and the ferry routes, and emits per tile box. Every
  // tile that touches the island rectangle is flagged and given a box big enough for what the
  // island passes put in it — geometry can overhang a tile edge by a beach width or a tree.
  const ISLE_BOX = HARBOUR ? islandBounds(HARBOUR) : null;
  let isleTiles = 0;
  if (ISLE_BOX) {
    for (let k = 0; k < grid.tiles.length; k++) {
      const t = grid.tiles[k];
      if (t.cx1 < ISLE_BOX[0] || t.cx0 > ISLE_BOX[2]) continue;
      if (t.cz1 < ISLE_BOX[1] || t.cz0 > ISLE_BOX[3]) continue;
      t.f.isle = true;
      isleTiles++;
      const gy = Math.max(WATER_Y, groundY(t.mx, t.mz));
      grid.cover(t, t.cx0 - 46, t.cz0 - 46, t.cx1 + 46, t.cz1 + 46,
        WATER_Y - ISLE_TILE_DOWN, gy + ISLE_TILE_UP);
    }
  }
  stats.isleTiles = isleTiles;

  // --- the global captures, cut up by triangle centroid.
  // The quay wall, the pier decks and the boardwalk are structure and belong to the massing
  // stage; the bollards, ladders, lifebuoys, lamps and moored craft are street furniture on the
  // water and belong to detail, exactly like the furniture on a street.
  const tileChunks = new Map();
  captureSplit(grid, cap, { props: S_DETAIL }, tileChunks);
  for (const [id, rec] of tileChunks) {
    grid.tiles[id].f.harbour = rec;
    grid.tiles[id].empty = false;
  }
  {
    let chunkVerts = 0;
    for (const [, rec] of tileChunks) {
      for (let s = 0; s < rec.length; s++) {
        if (!rec[s]) continue;
        for (const c in rec[s]) chunkVerts += rec[s][c].length / 13;
      }
    }
    stats.chunkVerts = Math.round(chunkVerts);
  }
  grid.seal(-DEPTH_MAX, 60);

  // Harbour props claimed occupancy against a grid that no longer exists once tiles take over.
  // Replay those claims into each tile's own grid so a Queens Quay bin cannot be planted inside
  // a mooring bollard that was placed first.
  const harbourClaims = hClaims;

  /* ------------------------------------------------------- the tile builder */

  const tileSeed = (t, stage) => (
    (SEED ^ Math.imul(t.i + 1, 0x9e3779b1) ^ Math.imul(t.j + 1, 0x85ebca6b) ^
      Math.imul(stage + 1, 0x27d4eb2d)) >>> 0
  );

  const crowdHist = new Int32Array(80);
  const recYAt = (rec) => {
    if (rec.deck) return (x, z, px, pz, k) => rec.deck[k];
    // A depressed carriageway reads its OWN profile, not the walking surface. The two agree along
    // every open metre of the corridor; where a lid carries a street over it they must not,
    // because the ground up there belongs to the street and the roadway is underneath it.
    if (rec.corridor) {
      return (x, z) => terrainY(x, z) - corridorDepth(rec.corridor, x, z) + ROAD_Y;
    }
    return (x, z) => groundY(x, z) + ROAD_Y;
  };

  function emitRoadMass(rec) {
    const target = C.mb[rec.target];
    setMat(target, rec.mat);
    if (rec.plaza) {
      for (let p = 0; p < rec.plaza.length; p++) {
        emitDrapedCap(target, rec.plaza[p], groundY, PATH_Y, C.stats, gradeField);
      }
      return;
    }
    const yAt = recYAt(rec);
    const hw = rec.hw;
    const cross = rec.crowned
      ? [{ o: -hw, dy: 0 }, { o: 0, dy: CROWN }, { o: hw, dy: 0 }]
      : [{ o: -hw, dy: 0 }, { o: hw, dy: 0 }];
    emitRibbon(target, rec.pts, rec.frames, cross, yAt);
    if (!rec.bridge) return;

    // Deck fascia + underside so an elevated road is a structure, not a floating ribbon.
    const mbR = C.mb.roads;
    setMat(mbR, M.bridge);
    const depth = ROAD_DECK[rec.cls] || 1.3;
    emitSkirt(mbR, rec.pts, rec.frames, -hw, yAt, depth, -1);
    emitSkirt(mbR, rec.pts, rec.frames, hw, yAt, depth, 1);
    const under = (x, z, px, pz, k) => yAt(x, z, px, pz, k) - depth;
    emitRibbon(mbR, rec.pts, rec.frames, [{ o: -hw, dy: 0 }, { o: hw, dy: 0 }], under, true);
    // Piers under the span, and an abutment at each end where the deck comes back to ground.
    const pts = rec.pts;
    let acc = 1e9;
    for (let k = 1; k < pts.length; k++) {
      acc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (acc < (rec.cls === 'motorway' ? 32 : 40)) continue;
      acc = 0;
      const x = pts[k][0], z = pts[k][1];
      const top = yAt(x, z, x, z, k) - depth;
      const g = terrainY(x, z);
      if (top - g < 3) continue;
      mbR.box(x, (g + top) * 0.5, z, 2.6, top - g, 2.6, 0);
    }
    for (const k of [0, pts.length - 1]) {
      const x = pts[k][0], z = pts[k][1];
      const top = rec.deck[k] - depth;
      const g = terrainY(x, z);
      if (top - g < 1.0) continue;
      const sx = rec.frames[k * 3], sz = rec.frames[k * 3 + 1];
      const tx = -sz * 0.85, tz = sx * 0.85;
      boxAA(mbR, x, z, tx, tz, sx * (hw + 0.5), sz * (hw + 0.5), g - 0.6, top);
      C.stats.grade.abutments++;
    }
  }

  function emitBuildingMass(b) {
    if (!b.parts || !b.walls || b.landmark === 'cn' || b.buried) return;
    const wall = b.glass ? C.mb.glass : C.mb.buildings;
    setMat(wall, b.mat);
    for (let k = 0; k < b.walls.length; k++) emitWallFace(wall, b.walls[k], C.stats);
    // Roofs are never glass and never windowed: gravel/mechanical deck, profile 0, faintly
    // tinted by the facade below so the roofscape is not one flat sheet of grey.
    const y1 = b.y + b.h;
    setMat(C.mb.buildings, roofMaterial(b.mat, _roofMat));
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (!part.capBuried) emitCap(C.mb.buildings, part, y1 - part.capDrop, C.stats);
    }
    if (b.h > 118) {
      setMat(C.mb.props, M.beacon);
      C.mb.props.box(b.cx, y1 + 1.4, b.cz, 1.1, 1.1, 1.1, 0);
    }
  }

  function emitHeavyRail(run) {
    const r = run.raw;
    const heavy = run.heavy;
    let pts = polyResample(run.p, ROAD_MAX_SEG);
    if (pts.length < 2) return;
    const reach = heavy ? 2.3 : TRACK_SLAB_HW;
    pts = pruneSpikes(pts, reach);
    if (pts.length < 2) return;
    const frames = polyFrames(pts, reach);
    const mbRail = C.mb.rails;
    // Track is laid on the NATURAL ground plus whatever the grade solve says this stretch of
    // corridor has to rise to clear the streets ducking under it. Reading the walking surface
    // here instead would drop the railway straight into the trench it is supposed to bridge.
    // The lift profile is read from the WHOLE way, never from this run, so two runs of one
    // embankment cannot disagree about how high it is at the vertex they share.
    const lift = G.railRise[run.gi];
    const liftAt = lift ? (x, z) => corridorDepth({ pts: r.p, dep: lift }, x, z) : () => 0;
    const yBed = (x, z) => terrainY(x, z) + liftAt(x, z) + (heavy ? RAIL_BED : 0.03);
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    C.stats.ground.railMetres += len;
    if (heavy) {
      setMat(mbRail, M.ballast);
      emitRibbon(mbRail, pts, frames,
        [{ o: -2.3, dy: 0 }, { o: 0, dy: 0.05 }, { o: 2.3, dy: 0 }], yBed);
      setMat(mbRail, M.tie);
      let acc = 0;
      for (let k = 1; k < pts.length; k++) {
        const dx = pts[k][0] - pts[k - 1][0], dz = pts[k][1] - pts[k - 1][1];
        const seg = Math.hypot(dx, dz);
        if (seg < 1e-4) continue;
        acc += seg;
        if (acc < TIE_SPACING) continue;
        acc = 0;
        const sx = frames[k * 3], sz = frames[k * 3 + 1];
        const x = pts[k][0], z = pts[k][1], y = yBed(x, z) + 0.09;
        const hu = sx * 1.45, hv = sz * 1.45;
        const tu = -sz * 0.14, tv = sx * 0.14;
        mbRail.tri(x - hu - tu, y, z - hv - tv, x + hu - tu, y, z + hv - tv,
          x + hu + tu, y, z + hv + tv);
        mbRail.tri(x - hu - tu, y, z - hv - tv, x + hu + tu, y, z + hv + tv,
          x - hu + tu, y, z - hv + tv);
      }
    }
    setMat(mbRail, M.rail);
    const gauge = 0.7175;
    const railY = (x, z) => yBed(x, z) + (heavy ? 0.20 : 0.03);
    for (const side of [-1, 1]) {
      const c = gauge * side;
      emitRibbon(mbRail, pts, frames, [{ o: c - 0.04, dy: 0 }, { o: c + 0.04, dy: 0 }], railY);
      if (heavy) {
        emitSkirt(mbRail, pts, frames, c - 0.04, railY, 0.11, -1);
        emitSkirt(mbRail, pts, frames, c + 0.04, railY, 0.11, 1);
      }
    }
    if (!heavy) return;

    // Where the track stands clear of the ground — because it was raised to clear an underpass,
    // or because the ground under it has been cut away entirely — it needs a structure. Fascia
    // walls down each side and a soffit between them: an embankment where the drop is small, a
    // bridge deck where the trench runs beneath. Without this the corridor floats over its own
    // underpass, which is exactly the thing a pedestrian standing in the underpass looks up at.
    setMat(mbRail, M.bridge);
    let deckLen = 0;
    let runStart = -1;
    const needsDeck = (k) => {
      const x = pts[k][0], z = pts[k][1];
      return gradeField.cut(x, z) || yBed(x, z) - terrainY(x, z) > RAIL_BED + 0.25;
    };
    for (let k = 0; k <= pts.length; k++) {
      const on = k < pts.length && needsDeck(k);
      if (on) { if (runStart < 0) runStart = Math.max(0, k - 1); continue; }
      if (runStart >= 0 && k - runStart >= 2) {
        const a0 = Math.max(0, runStart), a1 = Math.min(pts.length, k + 1);
        const seg = pts.slice(a0, a1);
        const fr = polyFrames(seg, 2.3);
        const top = (x, z) => yBed(x, z) - 0.02;
        const bot = (x, z) => Math.min(terrainY(x, z) - 0.35, yBed(x, z) - RAIL_DECK);
        emitWallStrip(mbRail, seg, fr, -2.3, top, bot, -1);
        emitWallStrip(mbRail, seg, fr, 2.3, top, bot, 1);
        emitRibbon(mbRail, seg, fr, [{ o: -2.3, dy: 0 }, { o: 2.3, dy: 0 }], bot, true);
        for (let m = 1; m < seg.length; m++) {
          deckLen += Math.hypot(seg[m][0] - seg[m - 1][0], seg[m][1] - seg[m - 1][1]);
        }
        C.stats.grade.railDecks++;
      }
      runStart = -1;
    }
    C.stats.grade.railDeckMetres += deckLen;
  }

  function beginTile(tile, stage) {
    const first = !tile.built[stage];
    C.stats = first ? stats : scrap;
    _audit = C.stats;
    C.mb = null;                       // set by the caller
    C.rng = makeRng(tileSeed(tile, stage));
    C.pedSeed = (PED_SEED ^ tileSeed(tile, 7)) >>> 0;
    C.tilePeople = 0;
    const ox = tile.bx0 - 24, oz = tile.bz0 - 24;
    const onx = Math.ceil((tile.bx1 - tile.bx0 + 48) / 5) + 1;
    const onz = Math.ceil((tile.bz1 - tile.bz0 + 48) / 5) + 1;
    C.occ = makeOccupancy(5.0, ox, oz, onx, onz);
    for (let i = 0; i < harbourClaims.length; i += 3) {
      const x = harbourClaims[i], z = harbourClaims[i + 1];
      if (x < ox || z < oz || x > tile.bx1 + 24 || z > tile.bz1 + 24) continue;
      C.occ.claim(x, z, harbourClaims[i + 2]);
    }
    C.stations.length = 0;
    C.corners.length = 0;
    C.benches.length = 0;
    C.walks.length = 0;
    C.retail.length = 0;
    C.plazas = [];
    C.crowd.clear();
    C.audit.length = 0;
    C.auditRoad.length = 0;
    C.auditDeck.length = 0;
    C.auditPed.length = 0;
    return first;
  }

  function endTile(tile, stage, first) {
    if (first) {
      // Re-checks the placement invariants against the finished index rather than trusting the
      // filters that produced them. Every one of these must come out zero.
      for (let i = 0; i < C.audit.length; i += 2) {
        if (inFootprint(C, C.audit[i], C.audit[i + 1], 0)) stats.propsInFootprint++;
        if (onCarriageway(C, C.audit[i], C.audit[i + 1], 0)) stats.propsOnRoad++;
      }
      for (let i = 0; i < C.auditRoad.length; i += 2) {
        if (inFootprint(C, C.auditRoad[i], C.auditRoad[i + 1], 0)) stats.propsInFootprint++;
      }
      for (let i = 0; i < C.auditPed.length; i += 4) {
        const x = C.auditPed[i], z = C.auditPed[i + 1], y = C.auditPed[i + 2];
        if (inFootprint(C, x, z, 0)) stats.people.inFootprint++;
        if (!C.auditPed[i + 3] && onCarriageway(C, x, z, 0)) stats.people.onCarriageway++;
        const g = groundY(x, z);
        if (y < g - 0.02 || y > g + ROAD_Y + CURB + 0.06) stats.people.sunk++;
      }
      for (let i = 0; i < C.auditDeck.length; i += 4) {
        const x = C.auditDeck[i], z = C.auditDeck[i + 1];
        const y = C.auditDeck[i + 2], h = C.auditDeck[i + 3];
        if (deckSoffitAbove(C, x, z, y + 0.25) - y < h) stats.deck.propsThroughDeck++;
      }
      for (const n of C.crowd.values()) {
        crowdHist[Math.min(crowdHist.length - 1, n)]++;
        stats.people.cells++;
      }
      let half = stats.people.cells >> 1;
      for (let i = 0; i < crowdHist.length; i++) {
        half -= crowdHist[i];
        if (half <= 0) { stats.people.medianCell = i; break; }
      }
      // Facade detail: the smallest offset from a wall plane any detail face was emitted at.
      // facades.js clamps its own faces, so this is a measurement, not a promise — and it is
      // only meaningful once tiles have actually been built, which is why it lives here rather
      // than at the end of the load.
      const fa = facadeAudit();
      stats.coplanar.facadeProudMin = fa.minProud;
      stats.coplanar.facadeFaces = fa.faces;
      stats.coplanar.facadeClamped = fa.clamped;
      tile.built[stage] = true;
    }
    C.audit.length = 0;
    C.auditRoad.length = 0;
    C.auditDeck.length = 0;
    C.auditPed.length = 0;
    C.stats = stats;
    _audit = stats;
  }

  /**
   * Build one stage of one tile. A generator, so tiles.js can stop between passes and hand the
   * frame back: a dense downtown tile is twenty partial frames rather than one 60 ms stall.
   */
  // ISLANDS: everything harbour.js needs to place a prop the way city.js would have placed it —
  // the same occupancy grid, the same footprint and carriageway tests, the same ground field and
  // the same audit counters — so an island tree obeys exactly the invariants a street tree does.
  function islandCtx(builders, F) {
    return {
      mb: builders,
      data,
      groundY,
      buildings: F.b,
      reserve: (kind, x, z, r, roadPad, h) => reserve(C, kind, x, z, r, roadPad, h),
      claim: (x, z, r) => C.occ.claim(x, z, r),
      note: (kind) => noteProp(C, kind),
      inFootprint: (x, z, pad) => inFootprint(C, x, z, pad),
    };
  }

  function* buildTile(tile, stage, builders) {
    const F = tile.f;
    const first = beginTile(tile, stage);
    C.mb = builders;
    C.plazas = F.plazas;

    if (stage === S_MASS) {
      emitTerrainRange(builders.terrain, T, gradeField, F.i0, F.i1, F.j0, F.j1);
      yield;
      for (let i = 0; i < F.areas.length; i++) {
        const part = F.areas[i];
        if (!part.drape) continue;
        const gy = part.kind === 'pier' ? (x, z) => Math.max(terrainY(x, z), 0.9) : terrainY;
        setMat(builders[part.target], part.mat);
        emitDrapedCap(builders[part.target], part, gy, part.dy, C.stats, gradeField);
        if ((i & 15) === 15) yield;
      }
      yield;
      // Retaining walls, verge, ceiling and portals for every corridor the grade solve depressed.
      for (let i = 0; i < F.corr.length; i++) {
        emitTrench(C, F.corr[i]);
        if ((i & 7) === 7) yield;
      }
      for (let i = 0; i < F.pass.length; i++) emitPassage(C, F.pass[i].r, F.pass[i].hw);
      yield;
      for (let i = 0; i < F.b.length; i++) {
        emitBuildingMass(F.b[i]);
        if ((i & 63) === 63) yield;
      }
      if (F.cn) emitCNTower(builders.buildings, builders.glass, builders.props, cnX, cnZ, cnBaseY);
      yield;
      for (let i = 0; i < F.recs.length; i++) {
        emitRoadMass(F.recs[i]);
        if ((i & 31) === 31) yield;
      }
      yield;
      for (let i = 0; i < F.rails.length; i++) {
        if (F.rails[i].heavy) emitHeavyRail(F.rails[i]);
        if ((i & 7) === 7) yield;
      }
      if (F.harbour && F.harbour[S_MASS]) {
        const chunk = F.harbour[S_MASS];
        for (const c in chunk) appendChunk(builders[c], chunk[c]);
      }
      // ISLANDS: the shore mantle, the boardwalks and the airfield surface.
      if (F.isle) {
        yield;
        appendIslandMass(HARBOUR, islandCtx(builders, F), tile.cx0, tile.cz0, tile.cx1, tile.cz1);
      }
    } else {
      /* --------------------------------------------------------- ground plane */
      for (let i = 0; i < F.recs.length; i++) {
        emitSidewalkBands(C, F.recs[i]);
        if ((i & 31) === 31) yield;
      }
      yield;
      for (let i = 0; i < F.recs.length; i++) {
        emitRoadMarkings(C, F.recs[i]);
        if ((i & 15) === 15) yield;
      }
      yield;
      // Kerb ramps and the signal heads go in before any furniture, so they win the corners.
      for (let i = 0; i < F.junc.length; i++) {
        emitJunctionKerbs(C, F.junc[i]);
        placeJunctionProps(C, F.junc[i]);
        if ((i & 15) === 15) yield;
      }
      yield;
      for (let i = 0; i < F.foot.length; i++) {
        buildFootway(C, { p: F.foot[i].p, w: F.foot[i].r.w, c: 'foot' });
        if ((i & 31) === 31) yield;
      }
      yield;
      // The PATH: a real second level with a floor, walls and a ceiling, which nobody can see
      // from the surface, so it is detail rather than massing.
      for (let i = 0; i < F.sub.length; i++) {
        emitSubway(C, F.sub[i].r, F.sub[i].gi, G);
        if ((i & 31) === 31) yield;
      }
      yield;
      /* ---------------------------------------------------------- streetcar */
      for (let i = 0; i < F.rails.length; i++) {
        const run = F.rails[i];
        if (run.heavy) continue;
        emitTramRoute(C, run.p);
        placeTramStops(C, run.p);
        if ((i & 3) === 3) yield;
      }
      yield;
      /* ------------------------------------------------------------ facades */
      for (let i = 0; i < F.b.length; i++) {
        const b = F.b[i];
        if (b.landmark !== 'cn') buildFacade(C, b);
        if ((i & 31) === 31) yield;
      }
      yield;
      /* -------------------------------------------------- street furniture */
      for (let i = 0; i < F.recs.length; i++) {
        const rec = F.recs[i];
        placeFurniture(C, rec);
        placeServiceProps(C, rec);
        placeScaffold(C, rec);
        if ((i & 15) === 15) yield;
      }
      yield;
      for (let i = 0; i < F.recs.length; i++) {
        placeKerbCars(C, F.recs[i]);
        if ((i & 31) === 31) yield;
      }
      yield;
      /* --------------------------------------------------- lots, parks, water */
      {
        let lotCars = 0;
        for (let i = 0; i < F.areas.length; i++) {
          const part = F.areas[i];
          if (part.kind !== 'parking' || lotCars >= MAX_LOT_CARS_TILE) continue;
          if (Math.abs(planArea(part.outer)) < 260) continue;
          lotCars += placeLotCars(C, part,
            Math.min(MAX_LOT_CARS_EACH, MAX_LOT_CARS_TILE - lotCars));
        }
      }
      yield;
      for (let i = 0; i < F.areas.length; i++) {
        const part = F.areas[i];
        if (part.kind !== 'park' || part.treeCap <= 0) continue;
        const bb = part.bbox;
        let own = 0;
        for (let v = bb[1]; v <= bb[3] && own < part.treeCap; v += PARK_TREE_SPACING) {
          for (let u = bb[0]; u <= bb[2] && own < part.treeCap; u += PARK_TREE_SPACING) {
            const ju = u + (C.rng() - 0.5) * PARK_TREE_SPACING * 0.7;
            const jv = v + (C.rng() - 0.5) * PARK_TREE_SPACING * 0.7;
            if (!partContains(part, ju, jv)) continue;
            const x = ju, z = -jv;
            const tree = C.rng() < 0.74;
            const y = reserve(C, tree ? 'parkTree' : 'shrub', x, z, tree ? 2.1 : 0.9, 0.6);
            if (!isNum(y)) continue;
            own++;
            if (tree) appendParkTree(builders.props, C.rng, x, y + 0.08, z, 0.9 + C.rng() * 0.7);
            else appendShrub(builders.props, C.rng, x, y + 0.06, z, 0.9 + C.rng() * 0.6);
          }
        }
        yield;
      }
      for (let i = 0; i < F.areas.length; i++) {
        const part = F.areas[i];
        if (part.kind !== 'pier') continue;
        if (part.berth) placeQuayBerth(C, part);
        if (part.boats > 0) placeHarbourCraft(C, part, part.boats);
      }
      yield;
      /* ----------------------------------------------------------- people */
      placePedestrians(C, F.recs, F.parks);
      yield;
      /* --------------------------------------------------------- roofscape */
      for (let i = 0; i < F.b.length; i++) {
        const b = F.b[i];
        if (b.landmark !== 'cn' && b.frontLen > 0) placeRoofscape(C, b);
        if (b.towerSign >= 0 && b.frontLen >= 7) {
          appendTowerSign(builders.props, C.rng, b.frontX, b.y + b.h - 7.5, b.frontZ, b.frontYaw,
            clamp(b.frontLen * 0.5, 4, 18), 2.8, (b.towerSign * 0.37) % 1);
          noteProp(C, 'towerSign');
        }
        if ((i & 63) === 63) yield;
      }
      yield;
      for (let i = 0; i < F.areas.length; i++) {
        const part = F.areas[i];
        if (!part.crane) continue;
        const bb = part.bbox;
        const u = (bb[0] + bb[2]) * 0.5, v = (bb[1] + bb[3]) * 0.5;
        if (!partContains(part, u, v)) continue;
        const x = u, z = -v;
        if (inFootprint(C, x, z, 4) || !C.occ.claim(x, z, 6)) continue;
        if (!deckFits(C, x, z, groundY(x, z) + 0.06, PROP_H.crane)) continue;
        appendConstructionCrane(builders.props, C.rng, x, groundY(x, z) + 0.06, z,
          C.rng() * TAU - Math.PI, 46 + C.rng() * 46);
        noteProp(C, 'crane');
      }
      for (let i = 0; i < F.rails.length; i++) {
        const run = F.rails[i];
        if (!run.heavy || run.p.length < 3) continue;
        placeRailCars(C, run.p, G.railRise[run.gi], run.raw.p);
      }
      if (F.harbour && F.harbour[S_DETAIL]) {
        const chunk = F.harbour[S_DETAIL];
        for (const c in chunk) appendChunk(builders[c], chunk[c]);
      }
      // ISLANDS: the tree cover, the gardens, the beach, the airfield lights and aircraft, the
      // ferries, Centreville, the lighthouse and the cottage roofs.
      if (F.isle) {
        yield;
        appendIslandDetail(HARBOUR, islandCtx(builders, F), tile.cx0, tile.cz0, tile.cx1,
          tile.cz1);
      }
    }

    endTile(tile, stage, first);
  }

  const tiles = new TileManager({
    gl,
    grid,
    classes: MESH_CLASSES,
    stages: [
      { name: 'massing', range: MASS_RANGE, drop: MASS_DROP },
      { name: 'detail', range: DETAIL_RANGE, drop: DETAIL_DROP },
    ],
    build: buildTile,
    vertexCap: VERTEX_CAP,
    budgetMs: TILE_BUDGET_MS,
    evictMs: TILE_EVICT_MS,
  });

  /* ------------------------------------------------------------- self-audit */
  report(0.86, 'checking the ground plane');
  // Ground plane: the tightest gap between two rungs of the ladder that can overlap, with the
  // duplicate stagger at its worst in both directions. Anything below GROUND_RUNG is a flicker
  // waiting for a distant camera.
  {
    const rungs = [GRASS_Y, ROAD_Y, PARK_Y, LOT_Y, PATH_Y];
    let m = Infinity;
    for (let i = 1; i < rungs.length; i++) {
      const g = rungs[i] - rungs[i - 1] - 2 * DUP_STAGGER;
      if (g < m) m = g;
    }
    const micro = [0, GUTTER_LIFT, MARK_LIFT, MARK_LIFT + RAIL_PROUD - TRACK_SLAB_Y];
    for (let i = 1; i < micro.length; i++) {
      const g = micro[i] - micro[i - 1];
      if (g < stats.coplanar.groundRungMinMicro || !stats.coplanar.groundRungMinMicro) {
        stats.coplanar.groundRungMinMicro = g;
      }
    }
    stats.coplanar.groundRungMin = m;
  }

  /* ----------------------------------------------------------- gpu upload -- */
  report(0.92, 'uploading the lake');
  const meshes = { water: new Mesh(gl, waterMB.data()) };
  stats.meshes.water = waterMB.count;
  waterMB.reset();
  stats.isle = islandStats(HARBOUR);
  stats.seconds = (now() - t0) / 1000;
  stats.yields = _yields;
  stats.tileSize = TILE_SIZE;
  stats.tileCount = grid.count;
  stats.vertexCap = VERTEX_CAP;

  /* ---------------------------------------------------------- query surface */

  function buildingAt(x, z) {
    if (!isNum(x) || !isNum(z)) return null;
    const pv = -z;
    let found = null;
    bIndex.query(x, z, 0.01, (b) => {
      if (found || !b.parts) return;
      if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
      for (let p = 0; p < b.parts.length; p++) {
        if (partContains(b.parts[p], x, pv)) { found = b; return false; }
      }
    });
    return found;
  }

  /**
   * Circle-vs-footprint resolution.
   *
   * `feetY` is optional and is what makes an underpass walkable: a footprint is a flat 2-D
   * obstacle only for someone at the same level as it. Give it the walker's feet and a record
   * whose massing starts over their head — the rail deck across a teamway, Rogers Centre's
   * overhang — stops blocking, as does any wall a corridor or building passage has had a portal
   * cut through (the same portal `punchCorridorPortals` took out of the geometry, from the same
   * field, so what you can see through is exactly what you can walk through). Called with three
   * arguments, as every prop and pedestrian pass does, it behaves exactly as it always has.
   *
   * Note that collision reads `parts`, which is prepared for EVERY building at load and never
   * evicted: the player must not be able to walk through a tower merely because its geometry is
   * not resident.
   */
  function collide(x, z, r, feetY) {
    const out = { x, z, hit: false };
    if (!isNum(x) || !isNum(z)) return out;
    const rad = isNum(r) && r > 0 ? r : 0.5;
    const walker = isNum(feetY);
    const headY = walker ? feetY + PASS_HEAD : 0;
    let px = x, pz = z;
    // Resolve the DEEPEST overlap first and only that one per pass. Applying every candidate in
    // sequence oscillates forever between footprints that share a party wall: each ejection lands
    // the point inside the neighbour, which ejects it straight back.
    let lastNx = 1, lastNv = 0;
    // The head of the opening at the walker's feet, if they are standing in a corridor or a
    // passage at all. Read once per pass, not once per candidate footprint.
    let openY = -Infinity;
    const openAt = (cx, cz) => {
      if (!walker) return -Infinity;
      const sp = gradeField.span(cx, cz);
      if (!sp || sp.d2 > sp.chw * sp.chw) return -Infinity;
      return terrainY(cx, cz) - sp.dep + (sp.pass ? PASSAGE_HEAD : UNDER_CLEAR);
    };
    const blocks = (b) => !(walker && (b.y >= headY || headY <= openY));
    for (let pass = 0; pass < 8; pass++) {
      const cx = px, cz = pz, pv = -pz;
      let bestPush = 1e-6, bnx = 0, bnv = 0;
      openY = openAt(cx, cz);
      bIndex.query(cx, cz, rad + 1, (b) => {
        if (!b.parts || !blocks(b)) return;
        if (cx < b.bbox[0] - rad || cx > b.bbox[2] + rad ||
          cz < b.bbox[1] - rad || cz > b.bbox[3] + rad) return;
        for (let p = 0; p < b.parts.length; p++) {
          const part = b.parts[p];
          const pb = part.bbox;
          if (cx < pb[0] - rad || cx > pb[2] + rad || pv < pb[1] - rad || pv > pb[3] + rad) continue;
          const inside = partContains(part, cx, pv);
          const best = closestOnRing(part.outer, cx, pv);
          let bd2 = best.d2, bx = best.x, by = best.y;
          for (let k = 0; k < part.holes.length; k++) {
            const c = closestOnRing(part.holes[k], cx, pv);
            if (c.d2 < bd2) { bd2 = c.d2; bx = c.x; by = c.y; }
          }
          const d = Math.sqrt(bd2);
          if (!inside && d >= rad) continue;
          const push = inside ? d + rad : rad - d;
          if (push <= bestPush) continue;
          let nx = cx - bx, nv = pv - by;
          let nl = Math.hypot(nx, nv);
          if (nl < 1e-6) {
            // Dead centre on an edge: fall back to the direction away from the part's first vertex.
            nx = cx - part.co[0]; nv = pv - part.co[1];
            nl = Math.hypot(nx, nv);
            if (nl < 1e-6) { nx = 1; nv = 0; nl = 1; }
          }
          nx /= nl; nv /= nl;
          if (inside) { nx = -nx; nv = -nv; }
          bestPush = push; bnx = nx; bnv = nv;
        }
      });
      if (bestPush <= 1e-6) break;
      px += bnx * bestPush;
      pz -= bnv * bestPush;
      lastNx = bnx; lastNv = bnv;
      out.hit = true;
    }
    // Last resort: a point trapped between footprints that share a party wall cannot be pushed out
    // by any single normal, because both neighbours claim the same edge. Ring-search outward for
    // the closest genuinely free spot instead of leaving the player inside a wall.
    const trapped = (qx, qz) => {
      const b = buildingAt(qx, qz);
      if (!b) return false;
      return !(walker && (b.y >= headY || headY <= openAt(qx, qz)));
    };
    if (out.hit && trapped(px, pz)) {
      const baseAng = Math.atan2(-lastNv, lastNx);
      let found = false;
      for (let ring = 1; ring <= 16 && !found; ring++) {
        const rr = rad + ring * 1.5;
        for (let a = 0; a < 16; a++) {
          const ang = baseAng + (a % 2 ? -1 : 1) * Math.ceil(a / 2) * (Math.PI / 8);
          const qx = px + Math.cos(ang) * rr;
          const qz = pz + Math.sin(ang) * rr;
          if (!trapped(qx, qz)) { px = qx; pz = qz; found = true; break; }
        }
      }
    }
    out.x = px; out.z = pz;
    return out;
  }

  /* --------------------------------------------------------- street naming */
  const sIndex = makeGridIndex(64, -extent.x / 2 - 400, -extent.z / 2 - 400,
    Math.ceil((extent.x + 800) / 64) + 1, Math.ceil((extent.z + 800) / 64) + 1);
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    // A tunnel is still a street, and the HUD should say so when you are standing in it.
    if (!r || !r.n || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (G.kind[i] === WAY_SUB) continue;               // ...but the concourse is a level below
    for (let k = 1; k < r.p.length; k++) {
      const a = r.p[k - 1], b = r.p[k];
      if (!isNum(a[0]) || !isNum(b[0])) continue;
      sIndex.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]),
        [a[0], a[1], b[0], b[1], r.n]);
    }
  }

  function streetNameAt(x, z, maxDist = 25) {
    if (!isNum(x) || !isNum(z)) return '';
    let best = maxDist * maxDist, name = '';
    sIndex.query(x, z, maxDist, (s) => {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const l2 = dx * dx + dz * dz;
      let t = 0;
      if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
      const qx = s[0] + dx * t, qz = s[1] + dz * t;
      const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d2 < best) { best = d2; name = s[4]; }
    });
    return name;
  }

  /* -------------------------------------------------------------- reporting */

  let logged = false;
  function logSummary() {
    if (logged || typeof console === 'undefined' || !console.log) return;
    logged = true;
    const TS = tiles.stats;
    console.log('[city] ' + stats.buildings + ' buildings, ' + stats.rings + ' rings, ' +
      stats.roads + ' road ways in ' + stats.recs + ' records (' + stats.splitWays +
      ' split at a tile edge, worst cut ' + stats.worstCutDeg.toFixed(2) + ' deg); ' +
      grid.count + ' tiles of ' + TILE_SIZE + ' m; analysis ' + stats.seconds.toFixed(2) + ' s; ' +
      'resident ' + TS.residentVerts.toLocaleString() + ' verts over ' + TS.residentTiles +
      ' tiles, cap ' + (VERTEX_CAP / 1e6).toFixed(1) + ' M', stats.meshes);
    console.log('[city] data: ' + stats.source + ', ' +
      (stats.bytes ? (stats.bytes / 1048576).toFixed(2) + ' MB decoded' : 'JSON') +
      '; captured global geometry ' + stats.chunkVerts.toLocaleString() + ' verts (harbour + ' +
      'walkability) held as ' + (stats.chunkVerts * 13 * 4 / 1048576).toFixed(1) + ' MB of ' +
      'per-tile chunks');
    console.log('[city] facades: ' + stats.surveyedColour + ' surveyed colours, materials',
      stats.materials, 'lighting profiles [envelope, office, residential, retail, parking, civic]',
      stats.profiles);
    const GR = stats.grade;
    console.log('[city] grade separation: ' + GR.under + ' depressed corridors (' +
      Math.round(GR.cutMetres).toLocaleString() + ' m open cut, deepest ' + GR.deepest.toFixed(2) +
      ' m), ' + GR.sub + ' underground concourse ways, ' + GR.over + ' carried over, ' +
      GR.passage + ' building passages; ' + GR.crossings.toLocaleString() +
      ' real crossings resolved, ' + GR.violations + ' short of ' + UNDER_CLEAR + ' m headroom, ' +
      GR.wallPortals + ' portals cut through a facade');
    const WK = stats.walk;
    console.log('[city] walkability: ' + (WK.fraction * 100).toFixed(2) + '% of ' +
      Math.round(WK.metres).toLocaleString() + ' walkable m in the largest component, ' +
      WK.components + ' components, ' + WK.islands + ' islands over 50 m holding ' +
      Math.round(WK.islandMetres).toLocaleString() + ' m; ' + WK.cliffs + ' cliffs left (' +
      WK.flights + ' flights of steps built, ' + WK.stitched + ' gaps stitched over ' +
      Math.round(WK.stitchMetres) + ' m); groundY finite over ' + WK.groundHoles + ' holes, ' +
      WK.groundMin.toFixed(2) + '..' + WK.groundMax.toFixed(2) + ' m');
    const CP = stats.coplanar;
    console.log('[city] coplanar audit: ' + CP.wallPairs.toLocaleString() + ' duplicated wall ' +
      'faces found (' + Math.round(CP.wallMetres).toLocaleString() + ' m), ' +
      CP.wallFacesDropped.toLocaleString() + ' suppressed / ' + CP.wallFacesClipped.toLocaleString() +
      ' clipped, ' + CP.capsBuried + ' buried roof caps deleted / ' + CP.capsStepped +
      ' stepped down, ' + CP.buriedRecords + ' whole records dropped, ' + CP.wallPairsLeft +
      ' wall + ' + CP.capPairsLeft + ' cap fights left; ground rung ' +
      CP.groundRungMin.toFixed(3) + ' m (carriageway ' + CP.groundRungMinMicro.toFixed(3) + ' m)');
    const HB = HARBOUR ? harbourStats(HARBOUR) : null;
    if (HB) {
      console.log('[city] harbourfront: ' + Math.round(HB.shoreMetres).toLocaleString() +
        ' m of surveyed shoreline in ' + HB.runs + ' runs, ' + HB.piers + ' piers, ' +
        HB.marinas + ' marinas, ' + HB.terminals + ' ferry terminals, ' + HB.crossings +
        ' walkways carried over the water; ' + HB.folds + ' folded quay quads');
    }

    // The islands and the airfield: the headline content of the southward expansion, and until
    // this line existed the only place any of it was reported was a stats object nobody read.
    const IS = stats.isle;
    if (IS && IS.islands) {
      console.log('[city] islands: ' + IS.islands + ' islands over ' +
        (IS.landArea / 1e6).toFixed(2) + ' km2, ' + Math.round(IS.shoreMetres).toLocaleString() +
        ' m of shore (' + Math.round(IS.beachMetres).toLocaleString() + ' m beach, ' +
        Math.round(IS.ripMetres).toLocaleString() + ' m riprap, ' +
        Math.round(IS.wallMetres).toLocaleString() + ' m wall), ' + IS.bridges + ' bridges, ' +
        IS.ferryDocks + ' ferry docks, ' + IS.rides + ' rides; Billy Bishop ' + IS.airRunways +
        ' runways, ' + IS.airTaxiways + ' taxiways, ' + IS.airAprons + ' aprons, ' +
        IS.airStands + ' stands over ' + Math.round(IS.airPaveArea).toLocaleString() +
        ' m2 of pavement');
    }
  }

  /**
   * Everything the frame loop owes the city: level of detail, culling, the geometry budget and
   * eviction. Call once per frame, before drawing.
   */
  function update(camera, nowMs, budgetMs) {
    tiles.frame(camera, nowMs, budgetMs);
    const TS = tiles.stats;
    stats.verts = TS.residentVerts + (meshes.water ? meshes.water.vertexCount : 0);
    stats.tris = (stats.verts / 3) | 0;
    return tiles;
  }

  /**
   * Build what is visible from `camera` before the first frame, so the world is not empty when
   * the title screen lifts. Everything past this point is built by the frame loop.
   */
  async function warm(camera, maxMs, onFrac) {
    const deadline = now() + (isNum(maxMs) ? maxMs : 2500);
    let total = 0;
    for (let guard = 0; guard < 2048; guard++) {
      tiles.frame(camera, now(), 0);
      const pending = tiles.pending;
      if (pending > total) total = pending;
      if (!pending) break;
      tiles.pump(12);
      if (typeof onFrac === 'function') onFrac(total ? 1 - pending / total : 1);
      if (now() > deadline) break;
      await frame();
    }
    update(camera, now(), 0);
    logSummary();
    if (typeof onFrac === 'function') onFrac(1);
    return stats;
  }

  report(1, 'ready');

  return {
    meta,
    extent,
    terrain: T,
    meshes,
    tiles,
    grid,
    classes: MESH_CLASSES,
    stats,
    // ISLANDS: the harbour/island model, so tools/islands.mjs can audit the shore stations, the
    // airfield and the bridges against the geometry rather than against its own guesses.
    harbour: HARBOUR,
    // Where the tower actually stands, for render.js's uCnTower mask — the LED rib wash, the two
    // glazed bands and the red aviation beacons are all keyed off it. The renderer carries a
    // literal default that was correct for the pre-expansion origin and is 1,020 m out under this
    // one, so the position has to come from the data rather than from a constant.
    // [x, z, base Y, mask radius].
    cnTower: [cnX, cnZ, cnBaseY, 34.0],
    groundY,
    buildingAt,
    collide,
    streetNameAt,
    update,
    warm,
    dispose() {
      tiles.dispose();
      if (meshes.water) meshes.water.dispose();
    },
  };
}

export default { loadCity };
