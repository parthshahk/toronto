// src/world/termini.js — no dangling ends: every way terminates deliberately.
//
// CONTRACT.md §9.1 and Amendment 11.1. Moved out of city.js unchanged.
//
// An OSM way ends where a mapper stopped work, not where the street stops. Welding every road,
// footway and railway vertex by position and counting incidences finds every end that is not a
// junction; resolveTermini() then either connects it to what it was obviously meant to reach or
// gives it a designed terminus — a turning head, a barrier, a buffer stop.
//
// IT RUNS BEFORE solveGrade(), on the raw polylines, so the street graph, the walkability audit,
// the junction table and the ribbons all see ONE corrected topology and none of them can
// disagree about where the network joins up. Nothing downstream may correct the topology again.
//
// A way that ends within EDGE_BAND of the world boundary is not ending, it is leaving: it gets no
// terminus at all, because the ground keeps going and fog closes it out.

import { clamp, TAU } from '../core/math.js';
import { isNum } from '../core/util.js';
import { segIntersects } from '../geom/triangulate.js';
import { makeGridIndex } from '../data/index.js';
import { now } from '../core/async.js';
import { appendBollard } from '../props/index.js';
import { M, setMat } from '../city/materials.js';
import { EPS, CURB, ROAD_Y, ROAD_CLASS_OK, WALK_CLASS, boxAA } from './ground.js';
import { RAIL_BED, WAY_GRADE, WAY_OVER, WAY_SUB, WAY_UNDER, classifyWay } from './grade.js';
import { makeNodeSet } from './weld.js';
import { noteProp } from './context.js';
import { EDGE_BAND } from './surround.js';

// Terminus resolution.
const TERM_WELD = 1.40;            // two ends this close were meant to be one node
const TERM_REACH = 20.0;           // ...and this is how far an end may be extended to reach a way
const TERM_SIDE = 9.0;             // maximum sideways offset of the point it is extended to
const TERM_AHEAD = 0.12;           // cos of the widest angle "ahead" may mean
const TERM_BLIND = 7.0;            // an end may also connect to something beside it this close
const TERM_BUILDING = 3.6;         // an end this close to a facade is a door, not a dangling way
const TERM_LAYER = 1;              // largest layer difference two ways may be connected across
const CUL_MIN_W = 4.2;             // narrower than this gets a barrier, not a turning head
const CUL_R_MIN = 6.4;
const CUL_SEG = 16;                // segments round a turning head
const BUFFER_W = 2.9;              // rail buffer stop
const BUFFER_H = 1.05;
/* ================================================== termini (CONTRACT §9.1) == */
//
// "A way that simply stops in mid-air, mid-block or mid-pavement is a BUG regardless of what OSM
// says." This is the pass that makes that true.
//
// Every road, footway and railway vertex in the extract is welded by position, exactly as
// solveGrade() welds them a moment later, and every incidence is counted. A vertex at the END of
// a way with exactly one incidence is a TERMINUS. It is legitimate only if it is one of:
//
//   * a junction        — impossible by construction, that is what degree >= 2 means;
//   * a building        — a driveway into a garage, a service road into a loading bay, a footway
//                         into a lobby. Measured against the real footprint edges, not guessed;
//   * the world edge    — the extract is a rectangular cut, so a way that reaches the boundary is
//                         not ending, it is leaving. buildSurround() continues it outward;
//   * a designed end    — a turning head, a barrier line or a buffer stop, which is what this
//                         pass BUILDS for everything left over.
//
// Anything else is resolved first: two ends a metre apart are welded, and an end that points at
// another way within TERM_REACH is extended to meet it — with the meeting point spliced into the
// TARGET way as well, because two polylines that merely cross do not share a node and the weld
// that the whole street graph is built on would never see the connection.
//
// It runs on the raw polylines BEFORE solveGrade(), so the grade solve, the walkability audit,
// the junction table, the ribbons and the street-name index all read one corrected topology.

/** Squared distance from (px,pz) to segment ab, plus the closest point, into `out`. */
const _seg = { d2: 0, x: 0, z: 0, t: 0 };
function nearestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = 0;
  if (l2 > EPS) t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  const qx = ax + dx * t, qz = az + dz * t;
  _seg.x = qx; _seg.z = qz; _seg.t = t;
  _seg.d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
  return _seg;
}

/** A footprint index over the RAW rings, so the terminus pass can run before buildParts(). */
function makeFootprintProbe(buildingsRaw, extent) {
  const cell = 64;
  const x0 = -extent.x / 2 - 600, z0 = -extent.z / 2 - 600;
  const nx = Math.ceil((extent.x + 1200) / cell) + 1;
  const nz = Math.ceil((extent.z + 1200) / cell) + 1;
  const idx = makeGridIndex(cell, x0, z0, nx, nz);
  for (let i = 0; i < buildingsRaw.length; i++) {
    const b = buildingsRaw[i];
    if (!b || !Array.isArray(b.r) || !b.r.length || !(isNum(b.h) && b.h > 0.5)) continue;
    const ring = b.r[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      if (!isNum(p[0]) || !isNum(p[1])) continue;
      if (p[0] < bx0) bx0 = p[0];
      if (p[0] > bx1) bx1 = p[0];
      if (p[1] < bz0) bz0 = p[1];
      if (p[1] > bz1) bz1 = p[1];
    }
    if (!(bx0 <= bx1)) continue;
    idx.add(bx0, bz0, bx1, bz1, { r: b.r, bb: [bx0, bz0, bx1, bz1] });
  }
  return {
    /** Distance from a point to the nearest footprint edge, capped at `r`. */
    near(x, z, r) {
      let best = r * r;
      idx.query(x, z, r, (rec) => {
        const bb = rec.bb;
        if (x < bb[0] - r || x > bb[2] + r || z < bb[1] - r || z > bb[3] + r) return;
        for (let g = 0; g < rec.r.length; g++) {
          const ring = rec.r[g];
          if (!Array.isArray(ring) || ring.length < 3) continue;
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            const a = ring[j], c = ring[k];
            if (!isNum(a[0]) || !isNum(c[0])) continue;
            const d = nearestOnSeg(x, z, a[0], a[1], c[0], c[1]).d2;
            if (d < best) best = d;
          }
        }
      });
      return Math.sqrt(best);
    },
    /** Does the segment ab cut across any footprint edge? */
    blocks(ax, az, bx, bz) {
      const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      const r = Math.hypot(bx - ax, bz - az) * 0.5 + 1;
      let hit = false;
      idx.query(mx, mz, r, (rec) => {
        if (hit) return false;
        for (let g = 0; g < rec.r.length; g++) {
          const ring = rec.r[g];
          if (!Array.isArray(ring) || ring.length < 3) continue;
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            const p = ring[j], q = ring[k];
            if (!isNum(p[0]) || !isNum(q[0])) continue;
            // KNOWN DEFECT, DELIBERATELY PRESERVED BY THE MODULE REFACTOR (do not "fix" here
            // without owning the consequences). geom/triangulate.js's segIntersects takes NODES
            // and reads .x / .y; these are [x, z] ARRAYS, so every coordinate it reads is
            // undefined, every turn() is NaN, sgn(NaN) is 0 and every branch falls through —
            // blocks() therefore always returns false and this probe has never rejected a single
            // connector. Fixing it changes the terminus graph and the geometry that follows from
            // it, so it belongs to whoever owns world/grade.js, with a fresh fingerprint baseline.
            if (segIntersects([ax, az], [bx, bz], [p[0], p[1]], [q[0], q[1]])) { hit = true; return false; }
          }
        }
      });
      return hit;
    },
  };
}

// A way's terminus can only be connected to something on roughly its own level and of roughly its
// own kind: a footpath may join a street (they meet at a kerb), a railway may only join a railway,
// and the PATH concourse three storeys down joins nothing on the surface.
function termCompatible(a, b) {
  if (a.rail !== b.rail) return false;
  if ((a.k === WAY_SUB) !== (b.k === WAY_SUB)) return false;
  return Math.abs(a.lay - b.lay) <= TERM_LAYER;
}

/**
 * Find, weld, connect and cap every dangling end in the extract.
 *
 * MUTATES the raw polylines. Returns the list of designed termini that still have to be BUILT —
 * turning heads, barrier lines and buffer stops — for the tile builder to emit.
 */
function resolveTermini(roadsRaw, railsRaw, buildingsRaw, extent, stats) {
  const E = stats.edge;
  const t0 = now();
  const EX = extent.x / 2, EZ = extent.z / 2;
  const probe = makeFootprintProbe(buildingsRaw, extent);

  // --- 1. every ground-level linear feature, in one list ---------------------
  const feats = [];
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    feats.push({
      raw: r, rail: false, k: classifyWay(r),
      lay: isNum(r.lay) ? clamp(Math.round(r.lay), -4, 4) : 0,
      cls: ROAD_CLASS_OK[r.c] ? r.c : 'minor',
      w: clamp(isNum(r.w) ? r.w : 8, 1.6, 44),
      splice: null,
    });
  }
  for (let i = 0; i < railsRaw.length; i++) {
    const r = railsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    feats.push({
      raw: r, rail: true, k: r.k === 'subway' ? WAY_SUB : WAY_GRADE, lay: 0,
      cls: r.k === 'rail' ? 'heavy' : 'tram', w: r.k === 'rail' ? 4.6 : 3.4, splice: null,
    });
  }

  // --- 2. weld and count incidences ------------------------------------------
  const weld = () => {
    const set = makeNodeSet(0.30);
    const deg = [];
    for (let f = 0; f < feats.length; f++) {
      const p = feats[f].raw.p;
      const ids = new Int32Array(p.length);
      for (let k = 0; k < p.length; k++) {
        ids[k] = (isNum(p[k][0]) && isNum(p[k][1])) ? set.at(p[k][0], p[k][1]) : -1;
      }
      feats[f].ids = ids;
    }
    for (let f = 0; f < feats.length; f++) {
      const ids = feats[f].ids;
      for (let k = 1; k < ids.length; k++) {
        const a = ids[k - 1], b = ids[k];
        if (a < 0 || b < 0 || a === b) continue;
        deg[a] = (deg[a] || 0) + 1;
        deg[b] = (deg[b] || 0) + 1;
      }
    }
    return { set, deg };
  };

  let deg = weld().deg;

  const collect = () => {
    const out = [];
    for (let f = 0; f < feats.length; f++) {
      const F = feats[f];
      const p = F.raw.p;
      const ids = F.ids;
      for (const end of [0, 1]) {
        const k = end ? ids.length - 1 : 0;
        const v = ids[k];
        if (v < 0 || (deg[v] || 0) !== 1) continue;
        const j = end ? k - 1 : k + 1;
        let dx = p[k][0] - p[j][0], dz = p[k][1] - p[j][1];
        const l = Math.hypot(dx, dz);
        if (l > EPS) { dx /= l; dz /= l; } else { dx = 1; dz = 0; }
        out.push({ f, F, end, k, v, x: p[k][0], z: p[k][1], dx, dz });
      }
    }
    return out;
  };

  let term = collect();
  E.termini = term.length;

  const atBoundary = (x, z) => (Math.abs(x) > EX - EDGE_BAND || Math.abs(z) > EZ - EDGE_BAND);
  let dangling = 0, atB = 0, atEdge = 0;
  for (let i = 0; i < term.length; i++) {
    const t = term[i];
    if (atBoundary(t.x, t.z)) { atEdge++; continue; }
    if (probe.near(t.x, t.z, TERM_BUILDING) < TERM_BUILDING) { atB++; continue; }
    dangling++;
  }
  E.danglingBefore = dangling;
  E.atBuilding = atB;
  E.atBoundary = atEdge;

  // --- 3. weld ends that were meant to be one node ---------------------------
  // A pair of ends a metre apart is digitising slop, not a gap. Move BOTH to their midpoint so
  // the 0.30 m weld the whole street graph runs on actually catches them.
  {
    const cellW = Math.max(TERM_WELD, 0.5);
    const buckets = new Map();
    for (let i = 0; i < term.length; i++) {
      const t = term[i];
      if (atBoundary(t.x, t.z)) continue;
      const key = Math.floor(t.x / cellW) + ':' + Math.floor(t.z / cellW);
      const b = buckets.get(key);
      if (b) b.push(i); else buckets.set(key, [i]);
    }
    const done = new Uint8Array(term.length);
    for (let i = 0; i < term.length; i++) {
      if (done[i]) continue;
      const t = term[i];
      if (atBoundary(t.x, t.z)) continue;
      const bi = Math.floor(t.x / cellW), bj = Math.floor(t.z / cellW);
      let best = -1, bestD = TERM_WELD;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const b = buckets.get((bi + di) + ':' + (bj + dj));
          if (!b) continue;
          for (let m = 0; m < b.length; m++) {
            const o = b[m];
            if (o === i || done[o] || term[o].f === t.f) continue;
            const d = Math.hypot(term[o].x - t.x, term[o].z - t.z);
            if (d > 0.30 && d < bestD) { bestD = d; best = o; }
          }
        }
      }
      if (best < 0) continue;
      const u = term[best];
      const mx = (t.x + u.x) * 0.5, mz = (t.z + u.z) * 0.5;
      t.F.raw.p[t.k] = [mx, mz];
      u.F.raw.p[u.k] = [mx, mz];
      t.x = mx; t.z = mz; u.x = mx; u.z = mz;
      done[i] = 1; done[best] = 1;
      E.welded++;
    }
  }

  // --- 4. extend what points at something --------------------------------------
  // Index every segment of every feature, then, for each surviving end, take the nearest
  // compatible point that is either ahead of it or close beside it, extend the way to that point
  // and splice the same point into the way it lands on.
  //
  // Splices are resolved BY GEOMETRY, never by a remembered vertex index: extending one way and
  // splicing into another both change the indices of everything after them, and a stale index
  // silently inserts a node in the wrong segment — a way that folds back on itself, which the
  // ribbon builder then reports as a fold and drops.
  const gx0 = -EX - 500, gz0 = -EZ - 500;
  const idxNX = Math.ceil((extent.x + 1000) / 28) + 1;
  const idxNZ = Math.ceil((extent.z + 1000) / 28) + 1;
  const buildSegIdx = () => {
    const idx = makeGridIndex(28, gx0, gz0, idxNX, idxNZ);
    for (let f = 0; f < feats.length; f++) {
      const p = feats[f].raw.p;
      for (let k = 1; k < p.length; k++) {
        const a = p[k - 1], b = p[k];
        if (!isNum(a[0]) || !isNum(b[0])) continue;
        idx.add(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1,
          Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1,
          [f, a[0], a[1], b[0], b[1]]);
      }
    }
    return idx;
  };
  // Insert a point into the segment of `p` it actually lies on. Returns true if it went in.
  const spliceInto = (p, x, z) => {
    let bd = 0.35 * 0.35, bk = -1;
    for (let k = 1; k < p.length; k++) {
      const d = nearestOnSeg(x, z, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]).d2;
      if (d < bd) { bd = d; bk = k; }
    }
    if (bk < 0) return false;
    if (Math.hypot(p[bk - 1][0] - x, p[bk - 1][1] - z) < 0.25) return false;
    if (Math.hypot(p[bk][0] - x, p[bk][1] - z) < 0.25) return false;
    p.splice(bk, 0, [x, z]);
    return true;
  };

  let segIdx = buildSegIdx();
  const spliceAt = new Map();      // feature index -> [[x, z], ...]
  for (let i = 0; i < term.length; i++) {
    const t = term[i];
    if (atBoundary(t.x, t.z)) continue;
    if (probe.near(t.x, t.z, TERM_BUILDING) < TERM_BUILDING) continue;
    let bestD = TERM_REACH, bestF = -1, bx = 0, bz = 0;
    segIdx.query(t.x, t.z, TERM_REACH, (rec) => {
      const of = rec[0];
      if (of === t.f) return;
      const O = feats[of];
      if (!termCompatible(t.F, O)) return;
      const s = nearestOnSeg(t.x, t.z, rec[1], rec[2], rec[3], rec[4]);
      const d = Math.sqrt(s.d2);
      if (d >= bestD || d < 1e-4) return;
      // Ahead, or close enough beside that the gap is obviously a survey artifact.
      const ux = (s.x - t.x) / d, uz = (s.z - t.z) / d;
      const ahead = ux * t.dx + uz * t.dz;
      if (ahead < TERM_AHEAD && d > TERM_BLIND) return;
      if (ahead >= TERM_AHEAD) {
        const side = Math.abs(ux * -t.dz + uz * t.dx) * d;
        if (side > TERM_SIDE) return;
      }
      bestD = d; bestF = of; bx = s.x; bz = s.z;
    });
    if (bestF < 0) continue;
    if (probe.blocks(t.x, t.z, bx, bz)) continue;
    // Extend this way to the meeting point...
    if (t.end) t.F.raw.p.push([bx, bz]);
    else t.F.raw.p.unshift([bx, bz]);
    // ...and record the same point for insertion into the way it lands on, so the two really
    // share a node rather than merely touching.
    const list = spliceAt.get(bestF);
    if (list) list.push([bx, bz]);
    else spliceAt.set(bestF, [[bx, bz]]);
    t.connected = true;
    E.connected++;
  }
  for (const [f, list] of spliceAt) {
    for (let m = 0; m < list.length; m++) {
      if (spliceInto(feats[f].raw.p, list[m][0], list[m][1])) E.spliced++;
    }
  }

  // --- 4b. crossings that share no node ---------------------------------------
  // The other half of the same survey artifact: two ways at the same level that cross on the
  // ground but were never given a shared node. Nothing dangles, and yet the graph the whole
  // walkability audit is built on says the two are unconnected — which on a park path crossing
  // another park path is simply false. Splice the intersection into both.
  //
  // Each crossing is tested in exactly ONE cell, the one that contains the intersection, which
  // is what makes a dedup table unnecessary: over 88,000 segments the table was most of the cost
  // of this pass and none of its value.
  {
    segIdx = buildSegIdx();
    const cells = segIdx.cells;
    const nxi = segIdx.nx;
    const pend = new Map();
    const level = (F) => (F.k === WAY_OVER ? Math.max(1, F.lay)
      : (F.k === WAY_UNDER || F.k === WAY_SUB ? Math.min(-1, F.lay) : 0));
    for (let c = 0; c < cells.length; c++) {
      const arr = cells[c];
      if (!arr || arr.length < 2) continue;
      const ci = c % nxi, cj = (c / nxi) | 0;
      for (let a = 0; a < arr.length; a++) {
        const ra = arr[a];
        const A = feats[ra[0]];
        if (A.rail || !WALK_CLASS[A.cls]) continue;
        for (let b = a + 1; b < arr.length; b++) {
          const rb = arr[b];
          if (ra[0] === rb[0]) continue;
          const B = feats[rb[0]];
          if (B.rail || !WALK_CLASS[B.cls]) continue;
          if (level(A) !== level(B)) continue;
          const d = (ra[3] - ra[1]) * (rb[4] - rb[2]) - (ra[4] - ra[2]) * (rb[3] - rb[1]);
          if (Math.abs(d) < 1e-9) continue;
          const t = ((rb[1] - ra[1]) * (rb[4] - rb[2]) - (rb[2] - ra[2]) * (rb[3] - rb[1])) / d;
          const u = ((rb[1] - ra[1]) * (ra[4] - ra[2]) - (rb[2] - ra[2]) * (ra[3] - ra[1])) / d;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const cxp = ra[1] + (ra[3] - ra[1]) * t, czp = ra[2] + (ra[4] - ra[2]) * t;
          if (segIdx.ci(cxp) !== ci || segIdx.cj(czp) !== cj) continue;
          // Already sharing a node there? Then the weld has it and nothing is missing.
          if (Math.hypot(ra[1] - cxp, ra[2] - czp) < 0.9) continue;
          if (Math.hypot(ra[3] - cxp, ra[4] - czp) < 0.9) continue;
          if (Math.hypot(rb[1] - cxp, rb[2] - czp) < 0.9) continue;
          if (Math.hypot(rb[3] - cxp, rb[4] - czp) < 0.9) continue;
          for (const f of [ra[0], rb[0]]) {
            const list = pend.get(f);
            if (list) list.push([cxp, czp]);
            else pend.set(f, [[cxp, czp]]);
          }
          E.crossings++;
        }
      }
    }
    for (const [f, list] of pend) {
      for (let m = 0; m < list.length; m++) {
        if (spliceInto(feats[f].raw.p, list[m][0], list[m][1])) E.spliced++;
      }
    }
  }

  // --- 5. what is left gets a designed terminus --------------------------------
  deg = weld().deg;
  term = collect();

  const caps = [];
  let left = 0;
  for (let i = 0; i < term.length; i++) {
    const t = term[i];
    if (atBoundary(t.x, t.z)) continue;
    if (probe.near(t.x, t.z, TERM_BUILDING) < TERM_BUILDING) continue;
    left++;
    // A concourse way is three storeys underground inside a building; its end is a door in a
    // wall the subway pass already builds, and a turning circle down there would be nonsense.
    if (t.F.k === WAY_SUB) { E.subwayEnds++; continue; }
    let kind;
    if (t.F.rail) kind = 'buffer';
    else if (t.F.cls === 'foot' || t.F.cls === 'pedestrian' || t.F.w < CUL_MIN_W) kind = 'barrier';
    else kind = 'cul';
    caps.push({
      kind, x: t.x, z: t.z, dx: t.dx, dz: t.dz,
      w: t.F.w, cls: t.F.cls, heavy: t.F.rail && t.F.cls === 'heavy',
    });
    if (kind === 'cul') E.culDeSacs++;
    else if (kind === 'barrier') E.barriers++;
    else E.bufferStops++;
  }
  E.capped = caps.length;
  E.danglingAfter = left - caps.length - E.subwayEnds;
  E.terminiAfter = term.length;
  E.ms = now() - t0;
  return caps;
}

/* ------------------------------------------------------- terminus geometry -- */

/**
 * A cul-de-sac head: the paved bulb a dead-end street actually ends in, with a kerb ring round
 * everything except the mouth the street arrives through.
 */
function emitCulDeSac(C, capRec) {
  const hw = Math.max(capRec.w * 0.5, 1.6);
  const r = Math.max(CUL_R_MIN, hw + 2.2);
  // Centred so the bulb's rear extreme sits one half-width BEHIND the street's last vertex: the
  // ribbon's square end is then completely inside the bulb and there is no notch between them.
  // The two surfaces overlap over that half-width, deliberately — they are the same material at
  // the same rung, so the overlap is invisible, where a gap would be a hole in the pavement. The
  // carriageway's crown keeps the ribbon proud of the bulb along its centre line anyway.
  const cx = capRec.x + capRec.dx * (r - hw);
  const cz = capRec.z + capRec.dz * (r - hw);
  const g = C.groundY(cx, cz);
  if (!isNum(g)) return;
  const mbR = C.mb.roads;
  setMat(mbR, M.asphalt);
  const yAt = (x, z) => C.groundY(x, z) + ROAD_Y;
  // The bulb, as a fan of triangles laid on the ground so it follows the crown of the street.
  const px = new Float64Array(CUL_SEG + 1), pz = new Float64Array(CUL_SEG + 1);
  const py = new Float64Array(CUL_SEG + 1);
  for (let i = 0; i <= CUL_SEG; i++) {
    const a = (i / CUL_SEG) * TAU;
    px[i] = cx + Math.cos(a) * r;
    pz[i] = cz + Math.sin(a) * r;
    py[i] = yAt(px[i], pz[i]);
  }
  const cy = yAt(cx, cz);
  for (let i = 0; i < CUL_SEG; i++) {
    const j = i + 1;
    mbR.tri(cx, cy, cz, px[j], py[j], pz[j], px[i], py[i], pz[i]);
  }
  // Kerb ring, opened where the carriageway comes in so the street and the bulb are one surface.
  setMat(mbR, M.curb);
  const back = -capRec.dx, backZ = -capRec.dz;
  for (let i = 0; i < CUL_SEG; i++) {
    const a0 = (i / CUL_SEG) * TAU, a1 = ((i + 1) / CUL_SEG) * TAU;
    const mx = Math.cos((a0 + a1) * 0.5), mz = Math.sin((a0 + a1) * 0.5);
    if (mx * back + mz * backZ > 0.62) continue;          // the mouth
    const x0 = cx + Math.cos(a0) * r, z0 = cz + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r, z1 = cz + Math.sin(a1) * r;
    const o0 = cx + Math.cos(a0) * (r + 0.34), q0 = cz + Math.sin(a0) * (r + 0.34);
    const o1 = cx + Math.cos(a1) * (r + 0.34), q1 = cz + Math.sin(a1) * (r + 0.34);
    const y0 = yAt(x0, z0) + CURB, y1 = yAt(x1, z1) + CURB;
    // Kerb face, looking IN at the carriageway (the outward radial is the back of it).
    mbR.tri(x0, y0 - CURB, z0, x1, y1, z1, x0, y0, z0);
    mbR.tri(x0, y0 - CURB, z0, x1, y1 - CURB, z1, x1, y1, z1);
    // ...and its top, facing the sky.
    mbR.tri(x0, y0, z0, o1, y1, q1, o0, y0, q0);
    mbR.tri(x0, y0, z0, x1, y1, z1, o1, y1, q1);
  }
  C.stats.edge.culBuilt++;
}

/** A barrier line: the bollards and the kerb an alley or a footpath actually ends at. */
function emitTerminusBarrier(C, capRec) {
  const hw = clamp(capRec.w * 0.5, 0.9, 5.0);
  const x = capRec.x + capRec.dx * 0.9, z = capRec.z + capRec.dz * 0.9;
  const g = C.groundY(x, z);
  if (!isNum(g)) return;
  const sx = -capRec.dz, sz = capRec.dx;
  const n = clamp(Math.round(hw / 0.85) * 2 + 1, 3, 9);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const bx = x + sx * hw * t * 0.86, bz = z + sz * hw * t * 0.86;
    const by = C.groundY(bx, bz);
    if (!isNum(by)) continue;
    appendBollard(C.mb.props, bx, by + ROAD_Y, bz);
    noteProp(C, 'bollard');
  }
  C.stats.edge.barriersBuilt++;
}

/** A buffer stop: the sleeper-built block a siding really ends at. */
function emitBufferStop(C, capRec, liftAt) {
  const x = capRec.x + capRec.dx * 1.1, z = capRec.z + capRec.dz * 1.1;
  const g = C.terrainY(x, z) + (isNum(liftAt) ? liftAt : 0) + (capRec.heavy ? RAIL_BED : 0.03);
  if (!isNum(g)) return;
  const mb = C.mb.rails;
  const sx = -capRec.dz * (BUFFER_W * 0.5), sz = capRec.dx * (BUFFER_W * 0.5);
  setMat(mb, M.tie);
  boxAA(mb, x, z, capRec.dx * 0.55, capRec.dz * 0.55, sx, sz, g - 0.10, g + BUFFER_H * 0.55);
  setMat(mb, M.rail);
  boxAA(mb, x - capRec.dx * 0.12, z - capRec.dz * 0.12, capRec.dx * 0.16, capRec.dz * 0.16,
    sx * 0.92, sz * 0.92, g + BUFFER_H * 0.55, g + BUFFER_H);
  C.stats.edge.buffersBuilt++;
}

export { CUL_R_MIN, resolveTermini, emitCulDeSac, emitTerminusBarrier, emitBufferStop };
