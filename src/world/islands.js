// src/world/islands.js — THE ISLAND MODEL: the surveyed rings, the classified shore runs, the
// ferry docks, and the public entry points city.js calls. Tunables, palette and the spatial
// indices are in ./islandkit.js.
//
//
// The south half of the map is the harbour, the Toronto Island chain and the airport that sits
// on the west end of it. It is a different place from the mainland waterfront and it is built
// differently.
//
// What the extract actually carries down here
// -------------------------------------------
//   shore[] role "inner"   17 closed rings once chained: 35.5 km of island shoreline, including
//                          every lagoon inlet. This is survey and it is exact.
//   areas[]                52 park, 208 grass, 58 pier, 10 parking polygons on the islands
//   roads[]                292 footways, 160 service roads, 14 pedestrian ways, 25 minor roads
//   buildings[]            323 records, from the ferry terminals to the Ward's Island cottages
//   waterfront[]           4 marinas, 85 piers, 13 breakwaters, 10 groynes, 2 ferry terminals
//
// What it does NOT carry, and where the rest comes from
// ----------------------------------------------------
//   * The land/water EDGE TREATMENT. A surveyed shoreline is a line, not a wall or a beach, and
//     Amendment 9.2 forbids land simply becoming water. Every metre of those 35.5 km is
//     classified here — beach, riprap or seawall — and given a real cross-section.
//   * AEROWAY. tools/build_city.py reads highway, railway, natural=water, leisure, landuse,
//     amenity and man_made; it has never read aeroway, so nothing of Billy Bishop's layout
//     survives into toronto.json but the buildings. The runways, taxiways, aprons, stopways,
//     stands and holding positions below are the OSM aeroway ways for YTZ, projected with the
//     same projection build_city.py uses (true metres, cos(lat0) applied) and frozen here at
//     authoring time. They are SURVEY, not invention: the task is explicit that the layout must
//     come from the aeroway tags rather than be made up, and this is the only route to them that
//     does not require regenerating data/toronto.bin.
//   * natural=beach and natural=sand, same story: read, projected, frozen.
//   * route=ferry, from the water extract. Five ways; their endpoints ARE the docks.
//   * attraction=*, the Centreville rides.
//
// Everything else down here is synthesised, and says so where it happens.
//
// Amendment 7 (time of day). The only emitters in the whole section are the airfield lights
// (runway edge, threshold, end, taxiway edge), the approach bars out over the water and the
// lighthouse lantern — every one a real light. Sand, grass, aircraft, ferries, hedges and
// boardwalks are geometry and albedo only.
//
// Amendment 8.4 (scaling). Nothing is keyed to this bounding box: the island model is built from
// whatever rings the extract contains, every index is a uniform grid, and every random choice is
// hashed on world position, so a tile of beach looks the same whether or not its neighbours were
// built. The emitters take a tile box and emit only what they own, which is the bounding-box
// predicate ARCHITECTURE.md asks for.


import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { EPS, bboxOf, hash01, planArea, polyLength, resample } from './waterkit.js';
import { BEACHES, FERRY_ROUTES, RIDES } from './islandplan.js';
import {
  AIR_APPROACH_BARS, AIR_APPROACH_STEP, BEACH_BACK, BEACH_BACK_MIN, BEACH_FACE, BEACH_FREE,
  BEACH_TOE, BEACH_TOE_DROP, EDGE_BEACH, EDGE_RIP, EDGE_WALL, HARD_NEAR, ISLE_GRID,
  ISLE_MIN_AREA, ISLE_REACH, ISLE_STATION, OPEN_LAKE, OPEN_STEP, RIP_BACK, RIP_FACE, RIP_FREE,
  RIP_TOE, RIP_TOE_DROP, WALL_BACK, WALL_FACE, WALL_FREE, WALL_TOE, WALL_TOE_DROP, addWay,
  boxHit, makeRingIndex, makeSegIndex, nearSeg, onIsland, pairs, ringAt, smoothLoop,
} from './islandkit.js';
import { waterAt } from './shoreline.js';
import { appendAirfield, buildAirport, placeAirfieldDetail, placeHangars } from './airfield.js';
import {
  appendIsleBoardwalks, appendIsleShores, placeCentreville, placeIslandGreen, placeIslandMarine,
  placeIslandRoofs, placeIslandSlipways, placeLighthouse, placeShoreProps,
} from './islanddetail.js';

// One closed run of island shore: a resampled loop with an outward (water-side) normal, a mitre,
// the classification and the mantle cross-section at every station.
function buildIsleRun(ring, field) {
  const raw = resample(ring, ISLE_STATION);
  // resample() keeps the ring's duplicated last point; the run is a LOOP, so drop it and let the
  // indices wrap. A loop has no ends, which is what stops a seam opening at the ring's start.
  let n = raw.length;
  if (n > 3 && Math.hypot(raw[0][0] - raw[n - 1][0], raw[0][1] - raw[n - 1][1]) < 0.25) n--;
  if (n < 8) return null;
  const run = {
    n,
    x: new Float64Array(n), z: new Float64Array(n),
    nx: new Float64Array(n), nz: new Float64Array(n),
    mx: new Float64Array(n), mz: new Float64Array(n),
    g: new Float64Array(n), e: new Float64Array(n),
    bw: new Float64Array(n), fw: new Float64Array(n), tw: new Float64Array(n),
    fr: new Float64Array(n), td: new Float64Array(n),
    bk: new Float64Array(n), to: new Float64Array(n), te: new Float64Array(n),
    kind: new Uint8Array(n), open: new Float32Array(n), hard: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) { run.x[i] = raw[i][0]; run.z[i] = raw[i][1]; }

  const sx = new Float64Array(n), sz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = (i + 1) % n;
    let tx = run.x[b] - run.x[a], tz = run.z[b] - run.z[a];
    const l = Math.hypot(tx, tz);
    if (l > EPS) { tx /= l; tz /= l; } else { tx = 1; tz = 0; }
    sx[i] = tx; sz[i] = tz;
    run.nx[i] = -tz; run.nz[i] = tx;
  }
  // Which side is the water? One vote per sampled station, majority wins, exactly as the mainland
  // runs do it: a single ambiguous station at a slip mouth cannot flip a whole island.
  let vote = 0;
  const stride = Math.max(1, Math.floor(n / 96));
  for (let i = 0; i < n; i += stride) {
    const a = waterAt(field, run.x[i] + run.nx[i] * 5, run.z[i] + run.nz[i] * 5);
    const b = waterAt(field, run.x[i] - run.nx[i] * 5, run.z[i] - run.nz[i] * 5);
    if (a && !b) vote++;
    else if (b && !a) vote--;
  }
  if (vote < 0) {
    for (let i = 0; i < n; i++) { run.nx[i] = -run.nx[i]; run.nz[i] = -run.nz[i]; }
  }
  const flip = vote < 0 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, b = i;
    let ax = -sz[a] * flip, az = sx[a] * flip;
    let bx = -sz[b] * flip, bz = sx[b] * flip;
    let mx = ax + bx, mz = az + bz;
    const l2 = mx * mx + mz * mz;
    if (l2 > 1e-6) {
      mx = mx * 2 / l2; mz = mz * 2 / l2;
      const ml = Math.hypot(mx, mz);
      if (ml > 2.4) { mx = mx * 2.4 / ml; mz = mz * 2.4 / ml; }
    } else { mx = run.nx[i]; mz = run.nz[i]; }
    run.mx[i] = mx; run.mz[i] = mz;
  }
  return run;
}

// How far the open water runs out along the station normal. Anything at OPEN_LAKE is a lake
// shore and gets sand; a lagoon bank hits the far side within a few tens of metres.
function openWater(field, x, z, nx, nz) {
  let t = OPEN_STEP;
  for (; t <= OPEN_LAKE; t += OPEN_STEP) {
    if (!waterAt(field, x + nx * t, z + nz * t)) return t - OPEN_STEP;
  }
  return OPEN_LAKE;
}


/* ------------------------------------------------------------------- model */

/**
 * Read the islands, the airfield and the ferry routes out of the extract and the baked survey.
 * Pure: no geometry, no mutation. Called from buildHarbour() once the water field exists.
 */
export function buildIslands(H, data, innerChains) {
  const rect = H.rect;
  const T = H.terrain;
  const wY = H.waterY;

  /* --- 1. the island rings ------------------------------------------------------------- */
  const rings = [];
  let landArea = 0, shoreMetres = 0;
  for (let i = 0; i < innerChains.length; i++) {
    const ch = innerChains[i];
    if (!Array.isArray(ch) || ch.length < 4) continue;
    const ar = Math.abs(planArea(ch));
    if (ar < ISLE_MIN_AREA) continue;
    const bb = bboxOf(ch);
    if (!boxHit(bb, rect[0], rect[1], rect[2], rect[3])) continue;
    rings.push({ p: ch, bbox: bb, area: ar });
    landArea += ar;
    shoreMetres += polyLength(ch);
  }
  const isle = {
    rings, runs: [], index: null, bbox: [Infinity, Infinity, -Infinity, -Infinity],
    beaches: [], beachIdx: null, air: null, docks: [], rides: [], bridges: [],
    landArea, shoreMetres, waterY: wY,
    stats: {
      islands: rings.length, landArea, shoreMetres,
      beachMetres: 0, ripMetres: 0, wallMetres: 0, stations: 0,
      airRunways: 0, airTaxiways: 0, airAprons: 0, airStands: 0, airPaveArea: 0,
      ferryDocks: 0, rides: 0, bridges: 0, flattened: 0,
    },
  };
  if (!rings.length) return isle;
  for (let i = 0; i < rings.length; i++) {
    const bb = rings[i].bbox;
    if (bb[0] < isle.bbox[0]) isle.bbox[0] = bb[0];
    if (bb[1] < isle.bbox[1]) isle.bbox[1] = bb[1];
    if (bb[2] > isle.bbox[2]) isle.bbox[2] = bb[2];
    if (bb[3] > isle.bbox[3]) isle.bbox[3] = bb[3];
  }
  const IB = isle.bbox;
  const irect = [IB[0] - 120, IB[1] - 120, IB[2] + 120, IB[3] + 120];

  /* --- 2. what makes an edge ENGINEERED rather than natural ---------------------------- */
  // A surveyed structure, a paved road or a building close to the water means somebody has
  // already hardened that edge, and a beach there would be an invention contradicting the
  // survey. Footways are deliberately NOT in here: the island trails run along the top of the
  // beaches and hardening under them would pave the whole south shore.
  const hard = makeSegIndex(irect, 26.0, HARD_NEAR + 2);
  const front = Array.isArray(data && data.waterfront) ? data.waterfront : [];
  for (let i = 0; i < front.length; i++) {
    const w = front[i];
    if (!w || !Array.isArray(w.p) || w.p.length < 2) continue;
    if (w.k === 'breakwater' || w.k === 'groyne') continue;      // offshore, not an island edge
    if (!boxHit(bboxOf(w.p), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, w.p, 1, false);
  }
  const roads = Array.isArray(data && data.roads) ? data.roads : [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.c === 'foot') continue;
    if (!boxHit(bboxOf(r.p), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, r.p, 2, false);
  }
  const blds = Array.isArray(data && data.buildings) ? data.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const r0 = blds[i] && Array.isArray(blds[i].r) ? blds[i].r[0] : null;
    if (!Array.isArray(r0) || r0.length < 3) continue;
    if (!boxHit(bboxOf(r0), irect[0], irect[1], irect[2], irect[3])) continue;
    addWay(hard, r0, 3, true);
  }

  /* --- 3. the surveyed beaches --------------------------------------------------------- */
  for (let i = 0; i < BEACHES.length; i++) {
    const p = pairs(BEACHES[i][1]);
    if (p.length < 4) continue;
    isle.beaches.push({ name: BEACHES[i][0], p, bbox: bboxOf(p) });
  }
  isle.beachIdx = makeRingIndex(isle.beaches, irect, 64);

  /* --- 4. the runs, and what every metre of shore IS ----------------------------------- */
  for (let i = 0; i < rings.length; i++) {
    const run = buildIsleRun(rings[i].p, H.field);
    if (run) isle.runs.push(run);
  }
  for (let r = 0; r < isle.runs.length; r++) {
    const run = isle.runs[r];
    const n = run.n;
    isle.stats.stations += n;
    for (let i = 0; i < n; i++) {
      const x = run.x[i], z = run.z[i];
      const h = nearSeg(hard, x, z);
      run.hard[i] = h ? h.d : 999;
      run.open[i] = openWater(H.field, x, z, run.nx[i], run.nz[i]);
      const onBeach = ringAt(isle.beachIdx, x, z, 9.0) >= 0;
      run.kind[i] = onBeach ? EDGE_BEACH
        : (run.hard[i] < HARD_NEAR ? EDGE_WALL
          : (run.open[i] >= OPEN_LAKE ? EDGE_BEACH : EDGE_RIP));
    }
    // Median filter round the loop: a single station that happens to sit under a jetty must not
    // punch a two-metre seawall through fifty metres of sand.
    const src = run.kind.slice();
    for (let i = 0; i < n; i++) {
      let c0 = 0, c1 = 0, c2 = 0;
      for (let k = -3; k <= 3; k++) {
        const v = src[(i + k + n * 4) % n];
        if (v === EDGE_RIP) c0++; else if (v === EDGE_BEACH) c1++; else c2++;
      }
      run.kind[i] = c2 >= c1 && c2 >= c0 ? EDGE_WALL : (c1 >= c0 ? EDGE_BEACH : EDGE_RIP);
    }
    // The cross-section. The PROFILE is continuous even where the classification is not: the
    // five offsets are smoothed along the run, so a beach tapers into a seawall over a few
    // stations instead of leaving a hole at the join. Only the MATERIAL changes abruptly, which
    // is what a real transition looks like.
    for (let i = 0; i < n; i++) {
      const k = run.kind[i];
      if (k === EDGE_BEACH) {
        // Beach width wanders on a 60 m scale, hashed on world position so it is the same beach
        // whichever tile asks.
        const hx = Math.round(run.x[i] / 60) * 60, hz = Math.round(run.z[i] / 60) * 60;
        run.bw[i] = BEACH_BACK_MIN + (BEACH_BACK - BEACH_BACK_MIN) * hash01(hx, hz);
        run.fw[i] = BEACH_FACE * (0.72 + 0.5 * hash01(hz, hx));
        run.tw[i] = BEACH_TOE;
        run.fr[i] = BEACH_FREE;
        run.td[i] = BEACH_TOE_DROP;
      } else if (k === EDGE_WALL) {
        run.bw[i] = WALL_BACK; run.fw[i] = WALL_FACE; run.tw[i] = WALL_TOE;
        run.fr[i] = WALL_FREE; run.td[i] = WALL_TOE_DROP;
      } else {
        run.bw[i] = RIP_BACK; run.fw[i] = RIP_FACE; run.tw[i] = RIP_TOE;
        run.fr[i] = RIP_FREE; run.td[i] = RIP_TOE_DROP;
      }
    }
    smoothLoop(run.bw, n, 3, 2);
    smoothLoop(run.fw, n, 3, 2);
    smoothLoop(run.tw, n, 3, 2);
    smoothLoop(run.fr, n, 2, 2);
    smoothLoop(run.td, n, 2, 2);
    for (let i = 0; i < n; i++) {
      const seg = Math.hypot(run.x[(i + 1) % n] - run.x[i], run.z[(i + 1) % n] - run.z[i]);
      if (run.kind[i] === EDGE_BEACH) isle.stats.beachMetres += seg;
      else if (run.kind[i] === EDGE_WALL) isle.stats.wallMetres += seg;
      else isle.stats.ripMetres += seg;
    }
  }
  isle.index = makeIsleIndex(isle.runs, irect);

  /* --- 5. Billy Bishop ----------------------------------------------------------------- */
  isle.hard = hard;
  isle.air = buildAirport(T, wY, H.field);
  // Report what the airfield actually is. These counters were declared and never written, so
  // every log line and every doc that quoted them said Billy Bishop had no runways, no taxiways
  // and no pavement while the geometry was being built and drawn perfectly well.
  if (isle.air) {
    const A = isle.air;
    for (let i = 0; i < A.ways.length; i++) {
      const w = A.ways[i];
      if (w.kind === 'runway') isle.stats.airRunways++;
      else if (w.kind === 'taxiway') isle.stats.airTaxiways++;
      isle.stats.airPaveArea += w.len * w.hw * 2;
    }
    for (let i = 0; i < A.aprons.length; i++) isle.stats.airPaveArea += A.aprons[i].area;
    isle.stats.airAprons = A.aprons.length;
    isle.stats.airStands = A.stands.length;
  }

  /* --- 6. the ferry docks -------------------------------------------------------------- */
  isle.docks = buildFerryDocks(H, isle);

  /* --- 7. Centreville ------------------------------------------------------------------ */
  for (let i = 0; i < RIDES.length; i++) {
    const p = pairs(RIDES[i][2]);
    if (p.length < 2) continue;
    const bb = bboxOf(p);
    const w = bb[2] - bb[0], d = bb[3] - bb[1];
    if (w < 3 && d < 3) continue;
    isle.rides.push({
      type: RIDES[i][0], name: RIDES[i][1], p, bbox: bb,
      cx: (bb[0] + bb[2]) * 0.5, cz: (bb[1] + bb[3]) * 0.5,
      w: Math.max(6, w + 4), d: Math.max(6, d + 4),
    });
  }
  isle.stats.rides = isle.rides.length;

  /* --- 8. the bridges between the islands ---------------------------------------------- */
  // Amendment 9.1: every path must lead somewhere, and on the islands the paths cross open
  // water. The extract tags the crossings (bridge=yes over the lagoons); they are collected here
  // so the audit can prove each one is decked, railed and walkable.
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || !r.b || !Array.isArray(r.p) || r.p.length < 2) continue;
    const bb = bboxOf(r.p);
    if (!boxHit(bb, IB[0] - 40, IB[1] - 40, IB[2] + 40, IB[3] + 40)) continue;
    let wet = false;
    for (let k = 1; k < r.p.length && !wet; k++) {
      const mx = (r.p[k - 1][0] + r.p[k][0]) * 0.5, mz = (r.p[k - 1][1] + r.p[k][1]) * 0.5;
      if (waterAt(H.field, mx, mz)) wet = true;
    }
    if (!wet) continue;
    isle.bridges.push({ p: r.p, w: isNum(r.w) ? r.w : 3, name: r.n || '', bbox: bb });
  }
  isle.stats.bridges = isle.bridges.length;
  return isle;
}

// The island edge index. Same shape as the mainland shore index, over LOOPS: segment i runs from
// station i to station (i + 1) % n.
function makeIsleIndex(runs, rect) {
  const x0 = rect[0] - ISLE_REACH * 2, z0 = rect[1] - ISLE_REACH * 2;
  const nx = Math.max(1, Math.ceil((rect[2] - rect[0] + ISLE_REACH * 4) / ISLE_GRID));
  const nz = Math.max(1, Math.ceil((rect[3] - rect[1] + ISLE_REACH * 4) / ISLE_GRID));
  const cells = new Array(nx * nz);
  let count = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    for (let i = 0; i < run.n; i++) {
      const j = (i + 1) % run.n;
      const ax = run.x[i], az = run.z[i], bx = run.x[j], bz = run.z[j];
      const i0 = clamp(Math.floor((Math.min(ax, bx) - ISLE_REACH - x0) / ISLE_GRID), 0, nx - 1);
      const i1 = clamp(Math.floor((Math.max(ax, bx) + ISLE_REACH - x0) / ISLE_GRID), 0, nx - 1);
      const j0 = clamp(Math.floor((Math.min(az, bz) - ISLE_REACH - z0) / ISLE_GRID), 0, nz - 1);
      const j1 = clamp(Math.floor((Math.max(az, bz) + ISLE_REACH - z0) / ISLE_GRID), 0, nz - 1);
      for (let b = j0; b <= j1; b++) {
        for (let a = i0; a <= i1; a++) {
          const c = b * nx + a;
          if (!cells[c]) cells[c] = [];
          cells[c].push(r, i);
          count++;
        }
      }
    }
  }
  return { x0, z0, nx, nz, cells, count };
}


/* --------------------------------------------------------------- the airfield */

/**
 * The ferry docks. The five route=ferry ways END at them, so each endpoint is snapped to the
 * nearest metre of surveyed edge — island or mainland — and a dock is built there facing the
 * water. Brute force over the stations rather than an index: ten endpoints against thirteen
 * thousand stations is nothing, and it cannot miss the way a bounded query can.
 */
function buildFerryDocks(H, isle) {
  const docks = [];
  const put = (px, pz, name) => {
    let best = Infinity, run = null, at = 0, kindIsle = false;
    for (let r = 0; r < isle.runs.length; r++) {
      const q = isle.runs[r];
      for (let i = 0; i < q.n; i++) {
        const d = (q.x[i] - px) * (q.x[i] - px) + (q.z[i] - pz) * (q.z[i] - pz);
        if (d < best) { best = d; run = q; at = i; kindIsle = true; }
      }
    }
    for (let r = 0; r < H.runs.length; r++) {
      const q = H.runs[r];
      for (let i = 0; i < q.n; i++) {
        const d = (q.x[i] - px) * (q.x[i] - px) + (q.z[i] - pz) * (q.z[i] - pz);
        if (d < best) { best = d; run = q; at = i; kindIsle = false; }
      }
    }
    if (!run || best > 240 * 240) return;
    const x = run.x[at], z = run.z[at];
    for (let k = 0; k < docks.length; k++) {
      if (Math.hypot(docks[k].x - x, docks[k].z - z) < 38) return;
    }
    docks.push({ x, z, nx: run.nx[at], nz: run.nz[at], run, at, isle: kindIsle, name });
  };
  for (let i = 0; i < FERRY_ROUTES.length; i++) {
    const p = pairs(FERRY_ROUTES[i][1]);
    if (p.length < 2) continue;
    put(p[0][0], p[0][1], FERRY_ROUTES[i][0]);
    put(p[p.length - 1][0], p[p.length - 1][1], FERRY_ROUTES[i][0]);
  }
  isle.stats.ferryDocks = docks.length;
  return docks;
}

/* ------------------------------------------------------------------- carve */

function makeIsleCtx(H, ctx) {
  return {
    mb: ctx.mb,
    data: ctx.data || null,
    H,
    groundY: typeof ctx.groundY === 'function' ? ctx.groundY : () => H.waterY,
    reserve: typeof ctx.reserve === 'function' ? ctx.reserve : () => NaN,
    claim: typeof ctx.claim === 'function' ? ctx.claim : () => true,
    note: typeof ctx.note === 'function' ? ctx.note : () => {},
    inFootprint: typeof ctx.inFootprint === 'function' ? ctx.inFootprint : () => false,
    buildings: Array.isArray(ctx.buildings) ? ctx.buildings : [],
  };
}

/** The rectangle the island work can put geometry in, so city.js can size the tile boxes. */
export function islandBounds(H) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length) return null;
  const b = isle.bbox.slice();
  if (isle.air) {
    const a = isle.air.bbox;
    if (a[0] < b[0]) b[0] = a[0];
    if (a[1] < b[1]) b[1] = a[1];
    if (a[2] > b[2]) b[2] = a[2];
    if (a[3] > b[3]) b[3] = a[3];
  }
  const pad = Math.max(BEACH_BACK, BEACH_FACE + BEACH_TOE) + AIR_APPROACH_STEP * AIR_APPROACH_BARS;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Private cars are banned on the Toronto Islands. Nothing may park one there. */
export function harbourCarFree(H, x, z) {
  const isle = H && H.isle;
  if (!isle || !isle.rings.length) return false;
  if (x < isle.bbox[0] || x > isle.bbox[2] || z < isle.bbox[1] || z > isle.bbox[3]) return false;
  return onIsland(isle, x, z);
}

/**
 * The island cottage height fix.
 *
 * A DATA DEFECT, in the same class as the CN Tower's missing mast. The massing dataset takes
 * h = max(AVG_HEIGHT, MAX_HEIGHT), and on the islands the LiDAR return over a cottage under
 * mature canopy is the canopy: the median height on Ward's and Algonquin comes out at 19.9 m on
 * a 100 m2 footprint, which is a six-storey tower on a garden shed's plot. 225 of the 288
 * records read over 12 m. Amendment 9 says a believable invention beats a wrong survey, so a
 * small island footprint is capped at a plausible cottage height, hashed on world position so it
 * is the same house every time.
 */
export function islandBuildingHeight(H, cx, cz, area, h) {
  const isle = H && H.isle;
  if (!isle || !isNum(h) || !isNum(area) || !isNum(cx) || !isNum(cz)) return h;
  if (area >= 600 || h <= 8) return h;
  if (cx < isle.bbox[0] || cx > isle.bbox[2] || cz < isle.bbox[1] || cz > isle.bbox[3]) return h;
  if (!onIsland(isle, cx, cz)) return h;
  const cap = 4.6 + area * 0.0075 + hash01(cx, cz) * 1.4;
  return h > cap ? cap : h;
}

/**
 * Island MASSING: the shore mantle, the boardwalks and the airfield surface. Emits only what the
 * tile box [x0, z0) x [x1, z1) owns, so this is the per-tile path ARCHITECTURE.md asks for and
 * nothing is captured, duplicated or clipped.
 */
export function appendIslandMass(H, ctx, x0, z0, x1, z1) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length || !ctx || !ctx.mb) return null;
  const c = makeIsleCtx(H, ctx);
  appendIsleShores(isle, c, x0, z0, x1, z1);
  appendIsleBoardwalks(isle, c, x0, z0, x1, z1);
  appendAirfield(isle, c, x0, z0, x1, z1);
  placeHangars(isle, c, x0, z0, x1, z1);
  return isle.stats;
}

/**
 * Island DETAIL: the tree cover, the gardens, the beach, the airfield lights and aircraft, the
 * ferries, Centreville, the lighthouse and the cottage roofs. Same tile-box contract.
 */
export function appendIslandDetail(H, ctx, x0, z0, x1, z1) {
  const isle = H && H.isle;
  if (!isle || !isle.runs.length || !ctx || !ctx.mb) return null;
  const c = makeIsleCtx(H, ctx);
  placeLighthouse(isle, c, x0, z0, x1, z1);
  placeIslandGreen(isle, c, x0, z0, x1, z1);
  placeShoreProps(isle, c, x0, z0, x1, z1);
  placeAirfieldDetail(isle, c, x0, z0, x1, z1);
  placeIslandMarine(isle, c, x0, z0, x1, z1);
  placeIslandSlipways(H, isle, c, x0, z0, x1, z1);
  placeCentreville(isle, c, x0, z0, x1, z1);
  placeIslandRoofs(isle, c, x0, z0, x1, z1);
  return isle.stats;
}

/** The island counters, for the console audit and the harness. */
export function islandStats(H) {
  const isle = H && H.isle;
  return isle ? isle.stats : null;
}
