// src/world/roads.js — the prepared road record, and the two surfaces hung off it.
//
// CONTRACT.md §3.1, §6.3 and Amendment 11.1. Moved out of city.js unchanged.
//
// THE RECORD. Markings, kerb ramps, furniture, kerb parking and the tram wire all address a road
// by METRES TRAVELLED ALONG IT and read the same prepared record through recSample(), so paint,
// kerb and lamp can never disagree about where the road is. recBase() and surfaceY() answer the
// other half of the question — how high the carriageway is at a given lateral offset, crown
// included, and what it is laid on.
//
// THE PAVEMENT. emitSidewalkBands() lays the synthetic footway either side of a carriageway,
// cutting it wherever another street, a building or an existing walkway already owns the ground.
//
// THE WALKWAYS. buildFootway() builds the surveyed OSM footways (CONTRACT §6.3), dropping only
// the runs that duplicate a sidewalk band this module already laid.

import { clamp, smoothstep } from '../core/math.js';
import { chunked } from '../core/async.js';
import { isNum, sgn } from '../core/util.js';
import { polyResample, pruneSpikes, polyFrames, emitSkirt, MITER_OVER } from '../geom/ribbon.js';
import { buildParts, planArea } from '../geom/ring.js';
import { makeGridIndex, splitLongWay } from '../data/index.js';
import { M, setMat } from '../city/materials.js';
import {
  EPS, ROAD_Y, ROAD_MAX_SEG, CROWN, CURB, PATH_Y, SIDEWALK_W, PLAZA_MIN_AREA, ROAD_CLASS_OK,
} from './ground.js';
import { corridorDepth, WAY_OVER, WAY_PASSAGE, WAY_SUB, WAY_UNDER } from './grade.js';
import {
  alreadyPaved, footprintDepth, nearestRoad, onForeignCarriageway, pavementTaken,
  inAcornZone, isBikeStreet,
} from './context.js';
import { emitRibbon } from './audit.js';

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


/**
 * Turn the raw road ways into the prepared RECORDS every later pass addresses a street through,
 * and build the two spatial indices over them.
 *
 * A way longer than a tile is cut into per-tile sub-ways here rather than left whole, so a street
 * two kilometres long still gets its markings, kerbs and lamps wherever you stand on it; the worst
 * residual turn at any cut is accumulated into `worstCut` for the stats line.
 *
 * The carriageway index deliberately LEAVES BRIDGES OUT — the Gardiner is 8 m overhead, and
 * letting its deck claim the ground under it would delete every walkway and prop in the
 * Harbourfront. Bridges get their own index, filed by SOFFIT height: what is overhead, rather
 * than what is underfoot.
 *
 * @param {object} W the raw ways, the grade solve, the tile grid, the extent and the natural
 *   ground sampler.
 * @returns {Promise<object>} the records, both indices, the job lists and the index origin every
 *   later grid in the load is aligned to.
 */
async function buildRoadRecords(W) {
  const { roadsRaw, data, extent, terrainY, G, grid, report, stats } = W;

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
  // Worst join turn measured at any tile cut this load makes, in radians. splitLongWay() returns
  // the turn it measured and this accumulates the maximum; the stats line reports it in degrees.
  const worstCut = { worst: 0 };

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
    else {
      const cut = splitLongWay(grid, rp, _spans);
      if (cut > worstCut.worst) worstCut.worst = cut;
    }
    if (_spans.length > 1) splitWays++;
    for (let s = 0; s < _spans.length; s++) {
      if (_spans[s].length < 2) continue;
      buildRec(gi, r, _spans[s], _spans.length === 1, s > 0, s < _spans.length - 1);
    }
  }, (f) => report(0.58 + f * 0.04, 'reading the street network'));
  stats.recs = recs.length;
  stats.splitWays = splitWays;
  stats.worstCutDeg = worstCut.worst * 180 / Math.PI;

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

  return {
    recs, roadIdx, deckIdx, roadJobs, footJobs, subJobs, gx0, gz0, worstCut,
  };
}

export {
  buildRoadRecords, recSample, recBase, surfaceY, nearJunction,
  emitBandRun, emitSidewalkBands, emitFootway, buildFootway,
};
