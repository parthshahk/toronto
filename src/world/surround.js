// src/world/surround.js — the edge of the world, and the city that would be past it.
//
// CONTRACT.md §9.3 and Amendment 11.1. Moved out of city.js unchanged, INCLUDING the fact that
// the synthesised city is currently switched off — see SUR_ENABLED below and the comment above it.
//
// The extract is a rectangular cut out of a much larger city, and nothing here may know that
// rectangle's dimensions: every number below derives from meta.extent and from the data inside it.
// Three concentric bands:
//
//   1. the DATA, out to extent/2 — surveyed, unchanged;
//   2. the FRINGE, SUR_FRINGE metres further — the terrain grid is padded by edge replication so
//      the ground, its normals and groundY simply continue. When SUR_ENABLED is on, the street
//      network continues along the bearings the real streets arrive on and generic massing fills
//      the blocks at the height and density measured just inside the boundary, thinning outward.
//   3. the APRON, HAZE_REACH metres further still — ground and water only, four rings of very
//      large quads and no features at all.
//
// This module is the PLAN: it measures the character of the strip just inside the boundary
// (edgeProfile), then lays out the streets and blocks the fringe would carry (buildSurround).
// world/fringe.js emits the geometry, world/limits.js stops the player and audits the horizon.

import { clamp, lerp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { now } from '../core/async.js';
import { EPS, ringPlanArea } from './ground.js';

/* ================================================ the world boundary (§9) == */
//
// CONTRACT §9.1 and §9.3. Two separate problems that share one answer.
//
// DANGLING ENDS (§9.1). An OSM way ends where a mapper stopped work, not where the street stops.
// Welding every road, footway and railway vertex by position and counting incidences finds every
// end that is not a junction; resolveTermini() then either connects it to what it was obviously
// meant to reach or gives it a designed terminus — a turning head, a barrier, a buffer stop. It
// runs BEFORE solveGrade(), on the raw polylines, so the street graph, the walkability audit, the
// junction table and the ribbons all see one corrected topology and none of them can disagree.
//
// THE EDGE OF THE WORLD (§9.3). The extract is a rectangular cut out of a much larger city, and
// nothing in the design may know that rectangle's dimensions. Everything below derives from
// meta.extent and from the data inside it, in three concentric bands:
//
//   1. the DATA, out to extent/2 — surveyed, unchanged;
//   2. the FRINGE, SUR_FRINGE metres further — synthesised city. The terrain grid is padded by
//      edge replication so the ground, its normals and groundY simply continue; the street
//      network continues along the bearings the real streets arrive on; generic massing fills
//      the blocks at the height and density measured just inside the boundary, thinning outward;
//   3. the APRON, HAZE_REACH metres further still — ground and water only, four rings of very
//      large quads, no features at all. This is what guarantees §9.4's "no viewpoint from which
//      the world visibly ends": see auditHorizon().
//
// The player is stopped by a soft limit inside band 2, so the last thing they can reach is still
// city and the apron is only ever something seen from a distance.

// Depth of the synthesised fringe. Scaled to the map so a small extract gets a proportionate
// surround and the full city does not pay for a 40 km ring of invention, then clamped: under
// ~700 m the fringe reads as a token strip, over ~1.8 km it costs terrain grid for nothing that
// is not already deep in haze.
const SUR_FRINGE_FRAC = 0.19;
const SUR_FRINGE_MIN = 700;
const SUR_FRINGE_MAX = 1800;

// How far the flat apron reaches beyond the fringe. This is an ATMOSPHERIC distance, not a map
// dimension, so it is a constant in metres and stays one at any extent: it is the sightline at
// which render.js's fog closes completely. Its three terms (haze deck, aerial perspective and
// the quadratic horizon closer, the last of which is not scaled by the sun) put a ground plane at
// 13 km at 98.5-100% airlight at every one of the four time presets and every altitude the
// camera can reach — measured, not asserted; auditHorizon() re-derives it every load.
// The synthesised city beyond the survey is OFF. It was built to satisfy an earlier reading of
// "make the boundary definitive", but the user's actual requirement is narrower: no dangling
// roads, and the road may simply END where the city ends -- just don't extend it far. Inventing
// 185 km of streets and 1,147 blocks of massing past the data produced a grey sprawl, visible
// radial spokes at the corners, and an apron so large it read as a plate. Terminating cleanly at
// the data edge is both what was asked for and what looks right.
//
// What remains: the terrain still pads a short way past the survey so the ground does not end at
// a visible cut, and fog closes it out. No invented streets, blocks or masses.
const SUR_ENABLED = false;
// Was 13000 -- a 13 km flat apron. That is the "lot of grey land". Now just far enough that the
// ground reaches the fog and stops being legible before it stops existing.
const HAZE_REACH = 2600;

// Where the player is stopped, measured outward from the data extent. Deliberately a fraction of
// the fringe and then capped at 300 m, because main.js's own WORLD_MARGIN backstop is 320 m: the
// soft limit has to bite BEFORE that hard clamp or the ease never runs. Everything past it —
// SUR_FRINGE - SOFT_OUT of synthesised city, then 13 km of apron — exists only to be looked at.
const SOFT_OUT_FRAC = 0.25;
const SOFT_OUT_MAX = 300;
const SOFT_EASE = 150;             // metres of deceleration before the limit

// Fringe street lattice. Spoke pitch is measured from the real network at the boundary (see
// edgeProfile) and clamped into this band; rings step outward by the local pitch, growing by
// SUR_RING_GROW each time so blocks get bigger and detail thins with distance, exactly as §9.3
// asks. SUR_RING_MAX caps how many rings any edge can produce.
const SUR_PITCH_MIN = 62;
const SUR_PITCH_MAX = 165;
const SUR_RING_GROW = 0.34;
const SUR_RING_MAX = 12;
const SUR_ROAD_W = { arterial: 15.0, street: 9.5 };
const SUR_ROAD_SEG = 55.0;         // resampling step: the padded ground is smooth, so this is
                                   // three times the surveyed ROAD_MAX_SEG and costs a third
const SUR_SETBACK = 5.2;           // block face to street kerb
const SUR_MASS_MIN = 16.0;         // no synthesised footprint narrower than this
const SUR_MASS_MAX = 46.0;         // ...nor wider: past this it reads as one megastructure
const SUR_MASS_AREA = 2400;        // target footprint area, used to split a big block
const SUR_MASS_CAP = 6;            // ...and the most masses one block may be split into
const SUR_H_MIN = 6.0;
const SUR_H_DECAY = 620;           // metres over which the fringe's storey count halves
const SUR_COVER_DECAY = 900;       // ...and over which its built fraction does
const SUR_H_JITTER = 0.55;         // +/- fraction of the local mean, hashed on world position
const SUR_TALL_P = 0.045;          // fraction of fringe masses that are a district's outliers
const SUR_TALL_MAX = 5.0;          // ...and the most they may exceed the local mean by
const SUR_FADE_IN = 0.55;          // fraction of the fringe depth at which the blocks start to
                                   // thin toward nothing, so the invented city has no last row
// How far out a fringe street runs, as a fraction of the fringe depth, by its rank: one local
// street in four, then one in two, then the rest. Arterials always run the full depth.
const SUR_ROAD_KEEP = [0.95, 0.66, 0.42];
const SUR_RING_KEEP = 0.70;        // ...and the last ring street, so none crosses open country

// The strip just inside the boundary that the fringe copies its character from, and how finely
// that strip is sampled around the perimeter.
const EDGE_PROFILE_DEPTH = 420;
const EDGE_PROFILE_PITCH = 150;
const EDGE_BAND = 45;              // a way ending this close to the boundary is a cut, not an end

// The riprap band that clads every land/water meeting in the surround (CONTRACT §9.2).
const BANK_TOP = 1.05;             // stone crest above the water plane
const BANK_TOE = -1.30;            // ...and how far under it the toe reaches
const BANK_LIFT = 0.06;            // proud of the ground it clads, so the two never fight
/* ============================= the synthesised surround (CONTRACT §9.3) ==== */
//
// Beyond the surveyed rectangle the city has to keep going, and it has to keep going in the
// pattern of whatever district it is leaving. Everything below is measured out of the data at the
// boundary and nothing is hard-coded to this bounding box.
//
// The fringe is built as four EDGE STRIPS and four CORNER WEDGES, each with its own local frame:
//
//   * an edge strip carries SPOKES — parallel outward streets, one per real street that crosses
//     the boundary there plus fill where the survey leaves a gap wider than the local block. They
//     all share one bearing, the length-weighted mean of the real crossing streets, so the fringe
//     grid is the district's grid and two spokes can never converge and cross;
//   * a corner wedge carries a fan of spokes sweeping the ninety degrees between two edges;
//   * RINGS run across the spokes at the local block pitch, each further out than the last by
//     SUR_RING_GROW, so blocks get bigger and the fringe thins with distance;
//   * a CELL between two spokes and two rings is a block. Its massing height and its built
//     fraction are the area-weighted mean of the real buildings in the strip just inside the
//     boundary, decayed outward, jittered by a hash of WORLD POSITION.
//
// Water is decided by the terrain, which harbour.js has carved to the surveyed shoreline and
// padTerrain has replicated outward: a spoke whose base is wet carries nothing, and a spoke dies
// at the first ring that goes wet. That is what keeps the surround from inventing a city on Lake
// Ontario, and it needs no knowledge whatever of where Toronto's shore happens to run.

function edgeFrames(extent) {
  const EX = extent.x / 2, EZ = extent.z / 2;
  return [
    // name, origin, along-boundary tangent, outward normal, length
    { nm: 'N', ox: -EX, oz: -EZ, sx: 1, sz: 0, nx: 0, nz: -1, len: 2 * EX },
    { nm: 'E', ox: EX, oz: -EZ, sx: 0, sz: 1, nx: 1, nz: 0, len: 2 * EZ },
    { nm: 'S', ox: EX, oz: EZ, sx: -1, sz: 0, nx: 0, nz: 1, len: 2 * EX },
    { nm: 'W', ox: -EX, oz: EZ, sx: 0, sz: -1, nx: -1, nz: 0, len: 2 * EZ },
  ];
}

/**
 * Which edge a point inside the rectangle belongs to, and where on it.
 * Returns [edgeIndex, s along the edge, depth inward from it].
 */
function edgeOf(edges, extent, x, z) {
  const EX = extent.x / 2, EZ = extent.z / 2;
  const d = [z + EZ, EX - x, EZ - z, x + EX];      // N, E, S, W
  let best = 0;
  for (let i = 1; i < 4; i++) if (d[i] < d[best]) best = i;
  const e = edges[best];
  const s = (x - e.ox) * e.sx + (z - e.oz) * e.sz;
  return [best, s, d[best]];
}

/**
 * Measure the district just inside each boundary: how dense its street grid is, which way its
 * streets run, how tall and how closely packed its buildings are, and where it is water.
 */
function edgeProfile(edges, extent, roadsRaw, buildingsRaw, landAt) {
  const prof = [];
  for (let e = 0; e < 4; e++) {
    const n = Math.max(2, Math.round(edges[e].len / EDGE_PROFILE_PITCH));
    prof.push({
      n,
      step: edges[e].len / n,
      road: new Float64Array(n),
      area: new Float64Array(n),
      hSum: new Float64Array(n),
      bearX: 0, bearZ: 0, bearW: 0,
      pitch: SUR_PITCH_MAX,
      h: new Float64Array(n),
      cover: new Float64Array(n),
      wet: new Uint8Array(n),
      cross: [],
    });
  }
  const bin = (e, s) => clamp(Math.floor(s / prof[e].step), 0, prof[e].n - 1);

  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.c !== 'motorway' && r.c !== 'major' && r.c !== 'minor' && r.c !== 'service') continue;
    if (r.tun === 1) continue;
    const p = r.p;
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k];
      if (!isNum(a[0]) || !isNum(b[0])) continue;
      const mx = (a[0] + b[0]) * 0.5, mz = (a[1] + b[1]) * 0.5;
      const q = edgeOf(edges, extent, mx, mz);
      if (q[2] > EDGE_PROFILE_DEPTH || q[1] < 0 || q[1] > edges[q[0]].len) continue;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz);
      if (!(l > 0.5)) continue;
      const P = prof[q[0]];
      P.road[bin(q[0], q[1])] += l;
      // Bearing: only the streets that genuinely cross the boundary say anything about which way
      // the grid runs outward. One parallel to it says nothing and must not dilute the mean.
      const E2 = edges[q[0]];
      let ux = dx / l, uz = dz / l;
      const dot = ux * E2.nx + uz * E2.nz;
      if (Math.abs(dot) < 0.5) continue;
      if (dot < 0) { ux = -ux; uz = -uz; }
      const w = l * (r.c === 'motorway' || r.c === 'major' ? 2.2 : 1);
      P.bearX += ux * w; P.bearZ += uz * w; P.bearW += w;
    }
  }

  for (let i = 0; i < buildingsRaw.length; i++) {
    const b = buildingsRaw[i];
    if (!b || !Array.isArray(b.r) || !b.r.length) continue;
    const h = isNum(b.h) ? b.h : 0;
    if (h < 2) continue;
    const ring = b.r[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let cx = 0, cz = 0, m = 0;
    for (let k = 0; k < ring.length; k++) {
      if (!isNum(ring[k][0])) continue;
      cx += ring[k][0]; cz += ring[k][1]; m++;
    }
    if (!m) continue;
    cx /= m; cz /= m;
    const q = edgeOf(edges, extent, cx, cz);
    if (q[2] > EDGE_PROFILE_DEPTH || q[1] < 0 || q[1] > edges[q[0]].len) continue;
    const a = ringPlanArea(ring);
    if (!(a > 4)) continue;
    const P = prof[q[0]];
    const k = bin(q[0], q[1]);
    P.area[k] += a;
    P.hSum[k] += a * h;
  }

  // Reduce to the numbers the fringe actually uses, then blur them along the boundary so the
  // synthesised city changes character gradually instead of block by block.
  for (let e = 0; e < 4; e++) {
    const P = prof[e];
    const boxArea = P.step * EDGE_PROFILE_DEPTH;
    let roadTotal = 0;
    for (let k = 0; k < P.n; k++) {
      roadTotal += P.road[k];
      P.h[k] = P.area[k] > 1 ? P.hSum[k] / P.area[k] : 0;
      P.cover[k] = clamp(P.area[k] / Math.max(boxArea, 1), 0, 0.62);
    }
    // A lattice of spacing p puts 2/p metres of street on every square metre of ground.
    const density = roadTotal / Math.max(boxArea * P.n, 1);
    P.pitch = clamp(density > 1e-6 ? 2 / density : SUR_PITCH_MAX, SUR_PITCH_MIN, SUR_PITCH_MAX);
    const bl = (a) => {
      const t = new Float64Array(a.length);
      for (let k = 0; k < a.length; k++) {
        const lo = a[Math.max(0, k - 1)], hi = a[Math.min(a.length - 1, k + 1)];
        t[k] = (lo + a[k] * 2 + hi) * 0.25;
      }
      a.set(t);
    };
    bl(P.h); bl(P.h); bl(P.cover); bl(P.cover);
    const E2 = edges[e];
    let bx = P.bearX, bz = P.bearZ;
    const bl2 = Math.hypot(bx, bz);
    if (bl2 > 1e-6 && P.bearW > 40) { bx /= bl2; bz /= bl2; } else { bx = E2.nx; bz = E2.nz; }
    // Never further than 45 degrees off the normal: past that the "outward" street is really a
    // boundary-parallel one and the strip would shear into slivers.
    const dot = clamp(bx * E2.nx + bz * E2.nz, -1, 1);
    if (dot < Math.SQRT1_2) {
      const side = bx * E2.sx + bz * E2.sz;
      const k = side >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2;
      bx = E2.nx * Math.SQRT1_2 + E2.sx * k;
      bz = E2.nz * Math.SQRT1_2 + E2.sz * k;
    }
    P.dirX = bx; P.dirZ = bz;
    for (let k = 0; k < P.n; k++) {
      const s = (k + 0.5) * P.step;
      const x = E2.ox + E2.sx * s + E2.nx * 6;
      const z = E2.oz + E2.sz * s + E2.nz * 6;
      P.wet[k] = landAt(x, z) ? 0 : 1;
    }
  }
  return prof;
}

/** Where the real streets cross one boundary edge, as positions along it. */
function edgeCrossings(edges, extent, roadsRaw, e) {
  const E2 = edges[e];
  const out = [];
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    if (!r || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.c !== 'motorway' && r.c !== 'major' && r.c !== 'minor' && r.c !== 'service') continue;
    const p = r.p;
    for (const k of [0, p.length - 1]) {
      const q = edgeOf(edges, extent, p[k][0], p[k][1]);
      if (q[0] !== e || q[2] > EDGE_BAND || q[1] < 0 || q[1] > E2.len) continue;
      const j = k === 0 ? 1 : p.length - 2;
      const dx = p[k][0] - p[j][0], dz = p[k][1] - p[j][1];
      const l = Math.hypot(dx, dz);
      if (!(l > 1)) continue;
      if ((dx / l) * E2.nx + (dz / l) * E2.nz < 0.25) continue;
      out.push({ s: q[1], big: r.c === 'motorway' || r.c === 'major' });
    }
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

/**
 * Build the whole surround: the spokes, the rings, the streets they make and the blocks between
 * them. Pure analysis and a few thousand small records; no vertices are produced here.
 */
function buildSurround(opts) {
  const t0 = now();
  const extent = opts.extent;
  const F = opts.fringe;
  const landAt = opts.landAt;
  const terrainY = opts.terrainY;
  const stats = opts.stats;
  const S = stats.surround;
  const edges = edgeFrames(extent);
  const prof = edgeProfile(edges, extent, opts.roadsRaw, opts.buildingsRaw, landAt);

  const roads = [];
  const blocks = [];
  const strips = [];

  const ringsFor = (pitch) => {
    const t = [0];
    let step = pitch;
    for (let r = 0; r < SUR_RING_MAX && t[t.length - 1] < F; r++) {
      t.push(t[t.length - 1] + step);
      step *= 1 + SUR_RING_GROW;
    }
    return t;
  };

  // --- edge strips -----------------------------------------------------------
  for (let e = 0; e < 4; e++) {
    const E2 = edges[e];
    const P = prof[e];
    const pitch = P.pitch;
    const ring = ringsFor(pitch);
    const seeds = edgeCrossings(edges, extent, opts.roadsRaw, e);
    // Real crossings first, deduped, then fill so no block is wider than 1.55 pitches.
    const sPos = [];
    const big = [];
    for (let i = 0; i < seeds.length; i++) {
      if (sPos.length && seeds[i].s - sPos[sPos.length - 1] < pitch * 0.42) {
        if (seeds[i].big) big[big.length - 1] = true;
        continue;
      }
      sPos.push(seeds[i].s);
      big.push(seeds[i].big);
    }
    if (!sPos.length) { sPos.push(pitch * 0.5); big.push(false); }
    const fill = [];
    const fillBig = [];
    const put = (s, b) => { fill.push(s); fillBig.push(b); };
    if (sPos[0] > pitch * 0.6) {
      const n = Math.ceil(sPos[0] / pitch);
      for (let k = 1; k <= n - 1; k++) put(sPos[0] * (k / n), false);
    }
    for (let i = 0; i < sPos.length; i++) {
      put(sPos[i], big[i]);
      const next = i + 1 < sPos.length ? sPos[i + 1] : E2.len;
      const gap = next - sPos[i];
      if (gap > pitch * 1.55) {
        const n = Math.round(gap / pitch);
        for (let k = 1; k < n; k++) put(sPos[i] + gap * (k / n), false);
      }
    }
    const spokes = [];
    for (let i = 0; i < fill.length; i++) {
      const s = fill[i];
      if (s < -1 || s > E2.len + 1) continue;
      const bx = E2.ox + E2.sx * s, bz = E2.oz + E2.sz * s;
      const k = clamp(Math.floor(s / P.step), 0, P.n - 1);
      // How far this spoke reaches before it runs into the lake.
      let alive = 0;
      for (let r = 1; r < ring.length; r++) {
        const x = bx + P.dirX * ring[r], z = bz + P.dirZ * ring[r];
        if (!landAt(x, z)) break;
        alive = r;
      }
      if (!landAt(bx + P.dirX * 4, bz + P.dirZ * 4)) alive = 0;
      spokes.push({
        x: bx, z: bz, dx: P.dirX, dz: P.dirZ, alive,
        h: P.h[k], cover: P.cover[k], big: fillBig[i],
      });
      if (!alive) S.waterSpokes++;
    }
    strips.push({ kind: 'edge', spokes, ring, pitch, e });
    S.spokes += spokes.length;
  }

  // --- corner wedges ---------------------------------------------------------
  // The ninety degrees between two edges, as a fan from the corner point. Its radius runs a
  // little past the fringe depth so the diagonal is covered rather than notched.
  for (let c = 0; c < 4; c++) {
    const A = edges[c], B = edges[(c + 1) & 3];
    const cx = A.ox + A.sx * A.len, cz = A.oz + A.sz * A.len;
    const pitch = (prof[c].pitch + prof[(c + 1) & 3].pitch) * 0.5;
    const ring = ringsFor(pitch);
    const R = ring[ring.length - 1];
    const a0 = Math.atan2(A.nz, A.nx);
    const nSp = clamp(Math.round((Math.PI * 0.5 * R * 0.55) / pitch), 3, 26);
    const kA = clamp(prof[c].n - 1, 0, prof[c].n - 1);
    const spokes = [];
    for (let i = 0; i <= nSp; i++) {
      const a = a0 + (Math.PI * 0.5) * (i / nSp);
      const dx = Math.cos(a), dz = Math.sin(a);
      let alive = 0;
      for (let r = 1; r < ring.length; r++) {
        if (!landAt(cx + dx * ring[r], cz + dz * ring[r])) break;
        alive = r;
      }
      if (!landAt(cx + dx * 4, cz + dz * 4)) alive = 0;
      const t = i / nSp;
      spokes.push({
        x: cx, z: cz, dx, dz, alive,
        h: lerp(prof[c].h[kA], prof[(c + 1) & 3].h[0], t),
        cover: lerp(prof[c].cover[kA], prof[(c + 1) & 3].cover[0], t),
        big: false,
      });
      if (!alive) S.waterSpokes++;
    }
    strips.push({ kind: 'corner', spokes, ring, pitch, e: -1 });
    S.spokes += spokes.length;
  }

  // --- streets and blocks ------------------------------------------------------
  const pointAt = (sp, t) => [sp.x + sp.dx * t, sp.z + sp.dz * t];
  for (let g = 0; g < strips.length; g++) {
    const st = strips[g];
    const ring = st.ring;
    S.rings = Math.max(S.rings, ring.length - 1);
    // Radial streets — and they thin outward with the blocks. A street grid that keeps its full
    // density past the last building draws a lattice of empty roads across open country, which
    // reads as stranger than a hard edge would. What survives furthest is what survives furthest
    // in a real city: the arterials, then one local street in four, then one in two, then all.
    const rankReach = (i, sp) => {
      if (sp.big) return 1.0;
      if (i % 4 === 0) return SUR_ROAD_KEEP[0];
      if (i % 2 === 0) return SUR_ROAD_KEEP[1];
      return SUR_ROAD_KEEP[2];
    };
    const liveAt = [];
    for (let i = 0; i < st.spokes.length; i++) {
      const sp = st.spokes[i];
      const cap = F * rankReach(i, sp);
      let live = 0;
      while (live + 1 <= sp.alive && ring[live + 1] <= cap + EPS) live++;
      liveAt.push(live);
    }
    for (let i = 0; i < st.spokes.length; i++) {
      const sp = st.spokes[i];
      if (liveAt[i] < 1) continue;
      const end = ring[liveAt[i]];
      const pts = [];
      const n = Math.max(2, Math.ceil(end / SUR_ROAD_SEG) + 1);
      for (let k = 0; k < n; k++) pts.push(pointAt(sp, (end * k) / (n - 1)));
      roads.push({ p: pts, w: sp.big ? SUR_ROAD_W.arterial : SUR_ROAD_W.street, t: 0 });
    }
    // Ring streets: one polyline per ring through every spoke still alive at it.
    for (let r = 1; r < ring.length; r++) {
      if (ring[r] > F * SUR_RING_KEEP) break;
      let run = [];
      for (let i = 0; i < st.spokes.length; i++) {
        if (liveAt[i] >= r) { run.push(pointAt(st.spokes[i], ring[r])); continue; }
        if (run.length > 1) roads.push({ p: run, w: SUR_ROAD_W.street, t: ring[r] });
        run = [];
      }
      if (run.length > 1) roads.push({ p: run, w: SUR_ROAD_W.street, t: ring[r] });
    }
    // Blocks.
    for (let i = 0; i + 1 < st.spokes.length; i++) {
      const a = st.spokes[i], b = st.spokes[i + 1];
      const live = Math.min(a.alive, b.alive);
      for (let r = 0; r + 1 <= live; r++) {
        const t0r = ring[r], t1r = ring[r + 1];
        const A = pointAt(a, t0r), B = pointAt(b, t0r);
        const Cc = pointAt(b, t1r), D = pointAt(a, t1r);
        const mid = [(A[0] + B[0] + Cc[0] + D[0]) * 0.25, (A[1] + B[1] + Cc[1] + D[1]) * 0.25];
        if (!landAt(mid[0], mid[1])) continue;
        const tMid = (t0r + t1r) * 0.5;
        const hMean = (a.h + b.h) * 0.5;
        const cover = (a.cover + b.cover) * 0.5;
        blocks.push({
          co: [A, B, Cc, D],
          mx: mid[0], mz: mid[1],
          t: tMid,
          fringe: F,
          h: hMean,
          cover,
          streetHW: SUR_ROAD_W.street * 0.5,
        });
      }
    }
  }

  S.blocks = blocks.length;
  S.streets = roads.length;
  let m = 0;
  for (let i = 0; i < roads.length; i++) {
    const p = roads[i].p;
    for (let k = 1; k < p.length; k++) m += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
  }
  S.streetMetres = m;
  S.fringe = F;
  S.ms = now() - t0;
  return { roads, blocks, prof, edges };
}

export {
  SUR_ENABLED, SUR_FRINGE_FRAC, SUR_FRINGE_MIN, SUR_FRINGE_MAX, HAZE_REACH,
  SOFT_OUT_FRAC, SOFT_OUT_MAX, SOFT_EASE, EDGE_BAND,
  SUR_ROAD_SEG, SUR_ROAD_W, SUR_SETBACK, SUR_MASS_MIN, SUR_MASS_MAX, SUR_MASS_CAP,
  SUR_H_MIN, SUR_H_DECAY, SUR_COVER_DECAY, SUR_H_JITTER, SUR_TALL_P, SUR_TALL_MAX, SUR_FADE_IN,
  BANK_TOP, BANK_TOE, BANK_LIFT,
  buildSurround,
};
