// src/world/walk.js — the walkable graph, and the audit that is an acceptance test.
//
// CONTRACT.md §8.2 and §9.4, and Amendment 11.1. Moved out of city.js unchanged. "Mostly
// connected" is a fail: this pass builds a graph from the carriageways, footways and crossings
// and reports, as permanent counters, the three things a player would otherwise find for us —
//
//   CONNECTIVITY  the largest connected component's share of walkable metres, and the size and
//                 location of every disconnected island above ISLAND_MIN metres. Islands that are
//                 only separated by a gap shorter than STITCH_R get a real connector built.
//   NO CLIFFS     no two adjacent walkable samples differing by more than WALK_CLIFF without
//                 ramp or step geometry between them; where one is found, steps are emitted.
//   NO HOLES      groundY finite everywhere inside the world bounds.
//
// It emits geometry only where it finds a defect worth fixing — a stitch ribbon or a flight of
// steps — so a clean city costs it no vertices at all.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { polyFrames } from '../geom/ribbon.js';
import { M, setMat } from '../city/materials.js';
import { EPS, PATH_Y, WATER_Y, WALK_CLASS, boxAA } from './ground.js';
import { WAY_OVER, WAY_SUB, WAY_UNDER, WAY_PASSAGE, corridorDepth } from './grade.js';
import { footprintDepth } from './context.js';
import { emitRibbon } from './audit.js';

/* =========================================================== walkability == */

const WALK_STEP = 2.0;             // how finely a route is walked when testing for cliffs
const WALK_CLIFF = 0.45;           // CONTRACT 8.2: a bigger step than this needs geometry
const WALK_WALL = 1.20;            // ...and a bigger one than THIS is not a step, it is a wall
const WALK_BLOCK = 1.6;            // metres inside a footprint before a route is really blocked
const STITCH_R = 8.0;              // how far a connector may reach to close a gap
const STITCH_W = 1.9;              // and how wide it is built
const ISLAND_MIN = 50.0;           // CONTRACT 8.2: report every island longer than this
const MARINE_CELL = 20.0;          // cell size of the land-connectivity flood behind "marine"
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
      // ...and a bridge is not blocked either: its deck is carried OVER whatever it crosses, so
      // measuring the footprints underneath it asks the wrong question entirely.
      let blocked = false;
      if (kind !== WAY_PASSAGE && kind !== WAY_UNDER && kind !== WAY_OVER) {
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
      //
      // AN ELEVATED WAY IS EXEMPT, for exactly the reason the cliff pass below already gives:
      // "a deck is not the ground". Its walking surface is a ribbon carried on abutments and
      // piers, continuous by construction, and the terrain it is sampled against is the river or
      // the rail cut it is bridging. Testing it against the ground severed every long bridge in
      // the extract and detached everything on the far side — measured at 26.8 km of walkable
      // street east of the Don Valley reported as an unreachable island, which is not what a
      // pedestrian standing on Queen Street East finds.
      const cor = G.corridor[i];
      const surf = cor
        ? (x, z) => C.terrainY(x, z) - corridorDepth(cor, x, z)
        : C.groundY;
      let sev = false;
      const walk = kind === WAY_OVER ? 0 : Math.max(1, Math.ceil(len / 1.5));
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
      rec = { root, x: 0, z: 0, n: 0, name: '', len: compLen.get(root) || 0, marine: false };
      islandNodes.set(root, rec);
    }
    rec.x += nx[edges[e]]; rec.z += nz[edges[e]]; rec.n++;
    if (!rec.name && edges[e + 3] >= 0) {
      const nm = roadsRaw[edges[e + 3]].n;
      if (typeof nm === 'string' && nm) rec.name = nm;
    }
  }
  const islands = [...islandNodes.values()].sort((a, b) => b.len - a.len);

  // MARINE COMPONENTS. Some islands are islands. The Toronto Islands carry 44 km of walkable
  // path and no bridge to the mainland — you take the ferry — so counting them as an unreachable
  // fragment of the street network measures Lake Ontario, not the city. A component is marine
  // when the shortest line from it to the main network crosses open water, which is decided by
  // the terrain and needs no knowledge of where any particular island is.
  //
  // Both fractions are reported: `fraction` over everything, and `fractionDry` over everything a
  // walker could reach without a boat. CONTRACT §9.4 asks for exceptions to be explained, and
  // this is the explanation, measured rather than asserted.
  {
    // Which land you can WALK to, decided by the ground itself: an 8-connected flood over the
    // terrain, seeded from every node of the main network, that may only step on cells standing
    // above the water plane. A component none of whose nodes is reached by that flood is on the
    // far side of open water, and the only way there is a boat.
    //
    // This is a question about land, not about distance, which is why it gets the Toronto Islands
    // right without being told they exist: Ward's Island is 156 m from the nearest mainland node
    // and Hanlan's Point is 2.5 km from it, and both are equally unreachable on foot.
    const gi = Math.max(2, Math.round(extent.x / MARINE_CELL) + 3);
    const gj = Math.max(2, Math.round(extent.z / MARINE_CELL) + 3);
    const ox = -extent.x / 2 - MARINE_CELL, oz = -extent.z / 2 - MARINE_CELL;
    const land = new Uint8Array(gi * gj);
    for (let j = 0; j < gj; j++) {
      const z = oz + (j + 0.5) * MARINE_CELL;
      for (let i = 0; i < gi; i++) {
        const y = C.rawY(ox + (i + 0.5) * MARINE_CELL, z);
        if (isNum(y) && y > WATER_Y + 0.2) land[j * gi + i] = 1;
      }
    }
    const cellOf = (x, z) => {
      const i = Math.floor((x - ox) / MARINE_CELL), j = Math.floor((z - oz) / MARINE_CELL);
      if (i < 0 || i >= gi || j < 0 || j >= gj) return -1;
      return j * gi + i;
    };
    const seen = new Uint8Array(gi * gj);
    const queue = new Int32Array(gi * gj);
    let head = 0, tail = 0;
    for (let e = 0; e < edges.length; e += 4) {
      if (uf.find(edges[e]) !== mainRoot) continue;
      for (const v of [edges[e], edges[e + 1]]) {
        const k = cellOf(nx[v], nz[v]);
        if (k < 0 || seen[k] || !land[k]) continue;
        seen[k] = 1;
        queue[tail++] = k;
      }
    }
    while (head < tail) {
      const k = queue[head++];
      const i = k % gi, j = (k / gi) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const a = i + di, b = j + dj;
          if (a < 0 || a >= gi || b < 0 || b >= gj) continue;
          const m = b * gi + a;
          if (seen[m] || !land[m]) continue;
          seen[m] = 1;
          queue[tail++] = m;
        }
      }
    }
    const islNodes = new Map();
    for (let e = 0; e < edges.length; e += 4) {
      const root = uf.find(edges[e]);
      if (root === mainRoot) continue;
      const b = islNodes.get(root);
      if (b) b.push(edges[e], edges[e + 1]);
      else islNodes.set(root, [edges[e], edges[e + 1]]);
    }
    for (const isl of islands) {
      if (isl.len <= ISLAND_MIN || !isl.n) continue;
      const mine = islNodes.get(isl.root) || [];
      let onMainland = false;
      for (let m = 0; m < mine.length && !onMainland; m++) {
        const k = cellOf(nx[mine[m]], nz[mine[m]]);
        if (k >= 0 && seen[k]) onMainland = true;
      }
      isl.marine = !onMainland;
    }
    W.landCells = tail;
  }

  let islandMetres = 0, islandCount = 0, marineMetres = 0, marineCount = 0;
  const worst = [];
  for (const isl of islands) {
    if (isl.len <= ISLAND_MIN) continue;
    islandCount++;
    islandMetres += isl.len;
    if (isl.marine) { marineCount++; marineMetres += isl.len; }
    if (worst.length < 12) {
      worst.push({
        m: Math.round(isl.len),
        x: Math.round(isl.x / Math.max(1, isl.n)),
        z: Math.round(isl.z / Math.max(1, isl.n)),
        name: isl.name,
        marine: !!isl.marine,
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
  W.marineIslands = marineCount;
  W.marineMetres = marineMetres;
  W.fractionDry = total - marineMetres > 0 ? mainLen / (total - marineMetres) : 1;
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

export { auditWalkability };
