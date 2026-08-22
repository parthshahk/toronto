// src/city/prep.js — THE LAZY ANALYSIS STAGE for buildings.
//
// CONTRACT.md §3.1, §8.4 and Amendment 11.1. Geometry has streamed for a while: a tile is built
// the first time the camera needs it. The ANALYSIS in front of it did not, and footprint
// preparation was the largest single item in it — rings into oriented parts, the material and
// lighting profile, the storey model, the broadphase — run over every record in the city before
// a single frame was drawn. That is 90 ms over 18,604 downtown buildings and it is a property of
// BUILDING COUNT, so over the 181,448 buildings of the pre-1998 city it is nearly a second of
// somebody watching a loading bar.
//
// THE SPLIT IS BY WHEN, and the seam is "what does a record's answer depend on?".
//
//   PLACEMENT  runs over every record, once, up front, and does the only two things that are
//              genuinely whole-city: WHERE the record is (its centroid, which decides the tile
//              that will build it, and its raw ring bounding box, which sizes that tile's draw box
//              and files it in the reach index) and HOW TALL it is. No ring is oriented, no part
//              is allocated, no material is chosen, no record object is built. It is a min/max
//              scan and an integer bucket.
//   ready(i)   everything else, for ONE record, the first time anybody asks about it — which is
//              when the tile holding it is built, or when a neighbour's coplanar verdict reaches
//              across a party wall to it, or when the player walks into it.
//
// WHY A RECORD AND NOT A TILE. The obvious lazy unit is the tile, but the broadphase is queried
// by RADIUS from all over the city — a crown-sign candidate asking whether it is buried, a
// pedestrian's collision circle, a corridor asking what is overhead — and answering one of those
// by preparing 180 buildings would put most of the city back on the critical path through the
// side door. `reach` is a uniform grid over the RAW ring boxes holding record indices only, so
// "prepare everything that can overlap this box" is exact and costs what it actually needs.
//
// ORDER INDEPENDENCE (Amendment 8.4). Preparing records in camera order instead of file order
// changes the order they land in the broadphase, and two of the queries over it — "which record
// covers this point", "which record is under the player" — answer with the FIRST hit. So this
// index keeps every bucket sorted by record key, which is the order a single up-front pass
// produced and is a property of the file rather than of the flight path. Everything else the
// preparation writes is a sum, a maximum, or a field of the record itself, and none of those can
// see the order either.
//
// Plan space is (u, v) = (x, -z), as everywhere in this tree. Raw rings are (x, z).

import { isNum } from '../core/util.js';
import { chunked } from '../core/async.js';
import { buildParts, planArea, planBBox } from '../geom/ring.js';
import { makeGridIndex } from '../data/index.js';
import {
  readHouseNumber, readLevels, readName, readRoofShape, readUnits,
} from '../data/schema.js';
import { islandBuildingHeight, islandCapCandidate } from '../world/islands.js';
import { MIN_RING_AREA, ringPlanArea } from '../world/ground.js';
import { M, facadeMaterial } from './materials.js';
import { assignLandmarks } from './landmarks.js';
import { storeyModel } from './units.js';

// Broadphase cell, metres. Unchanged from the single-pass build it replaces: 48 m is about two
// city lots, so a collision circle touches one cell and a party-wall query four.
const B_CELL = 48;
// Reach index cell. Filed under the raw ring box rather than the prepared one, so a record in one
// extra cell costs one extra preparation and never a wrong answer. Measured at 48, 64 and 96 m:
// 48 wins, because the dangling-end probe queries it 3.6 m at a time and a coarse cell hands that
// query the whole block.
const R_CELL = 48;

/**
 * Insert into a uniform-grid broadphase KEEPING EACH BUCKET ORDERED by `key`.
 *
 * makeGridIndex() appends, which is right for a pass that runs once in file order and wrong for
 * one that runs in whatever order the camera asks. The queries that read the first hit rather
 * than all of them would then answer differently depending on where the player had been, so the
 * insertion point is searched for instead. Buckets hold a handful of records, and preparation is
 * once per record for the life of the load, so the search is not on any hot path.
 */
function addSorted(idx, bx0, bz0, bx1, bz1, item, key) {
  const i0 = idx.ci(bx0), i1 = idx.ci(bx1);
  const j0 = idx.cj(bz0), j1 = idx.cj(bz1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * idx.nx + i;
      let a = idx.cells[c];
      if (!a) { a = []; idx.cells[c] = a; }
      let p = a.length;
      while (p > 0) {
        const k = a[p - 1].key;
        if (isNum(k) && k > key) p--; else break;
      }
      if (p === a.length) a.push(item); else a.splice(p, 0, item);
    }
  }
}

/**
 * Prepare the city's buildings LAZILY.
 *
 * Runs the whole-city placement pass, then hands back the record array (filled in on demand), the
 * broadphase that fills it in, and the handle the tile builder and the chore queue drive.
 *
 * @param {object} W the raw building list, the tile grid, and everything a record's attributes
 *   depend on.
 * @returns {Promise<object>} { prepped, bIndex, cnRec, cnX, cnZ, prep }
 */
async function prepareBuildings(W) {
  const { buildingsRaw, HARBOUR, SUR_FRINGE, extent, grid, project, report, stats } = W;

  const n = buildingsRaw.length;
  const prepped = new Array(n);
  // WHERE EVERY RECORD IS, in typed arrays rather than in n objects: the centroid of its first
  // ring (which the landmark match, the island height cap and the tile assignment all read), its
  // height after the island cap, and the tile that will build it.
  const cxA = new Float64Array(n);
  const czA = new Float64Array(n);
  const hA = new Float64Array(n);
  const tileA = new Int32Array(n);
  const state = new Uint8Array(n);          // 0 untouched, 1 prepared, 2 prepared and filed
  // The FIRST RING's box, [x0, z0, x1, z1] per record. Not the record's full extent: a stacked
  // massing slab's other rings are deliberately outside it, and the dangling-end probe's answer
  // depends on that. Kept because that probe asks about it tens of thousands of times and
  // recomputing it per question was measurably more expensive than the index it replaced.
  const fb = new Float64Array(n * 4);

  // Wide enough to hold the reachable part of the synthesised fringe as well as the survey: a
  // fringe mass indexed outside these bounds would be clamped into a boundary cell, and that cell
  // would then be queried by everything along the whole edge of the map.
  const B_PAD = 200 + SUR_FRINGE;
  const idx = makeGridIndex(B_CELL, -extent.x / 2 - B_PAD, -extent.z / 2 - B_PAD,
    Math.ceil((extent.x + B_PAD * 2) / B_CELL) + 1,
    Math.ceil((extent.z + B_PAD * 2) / B_CELL) + 1);
  // The reach index: raw ring boxes, holding record indices. This is what turns "prepare
  // everything that could overlap this query" into a handful of records rather than a tile.
  const reach = makeGridIndex(R_CELL, -extent.x / 2 - B_PAD, -extent.z / 2 - B_PAD,
    Math.ceil((extent.x + B_PAD * 2) / R_CELL) + 1,
    Math.ceil((extent.z + B_PAD * 2) / R_CELL) + 1);

  /* ------------------------------------------------------------ placement -- */

  report(0.37, 'placing footprints');
  await chunked(n, 1500, (i) => {
    const b = buildingsRaw[i];
    const rings = Array.isArray(b.r) ? b.r : [];
    const r0 = rings[0];
    // ONE PASS OVER THE FIRST RING for three answers: the CENTROID, which decides the tile, the
    // landmark match and the island height cap; the FIRST-RING BOX, which is the shape the
    // dangling-end probe rejects candidates on; and the start of the raw ring box. The centroid is
    // summed in file order under the same guard the single-pass build used, so the arithmetic is
    // identical to the float.
    //
    // 18,312 records carry 18,503 rings between them — all but a per cent of them are a single
    // ring — so for nearly every record this loop is the whole scan.
    let cx = 0, cz = 0, m = 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    if (Array.isArray(r0) && r0.length >= 3) {
      for (let k = 0; k < r0.length; k++) {
        const p = r0[k];
        if (isNum(p[0])) { cx += p[0]; cz += p[1]; m++; }
        if (!isNum(p[0]) || !isNum(p[1])) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < z0) z0 = p[1];
        if (p[1] > z1) z1 = p[1];
      }
    } else if (Array.isArray(r0)) {
      for (let k = 0; k < r0.length; k++) {
        if (!isNum(r0[k][0])) continue;
        cx += r0[k][0]; cz += r0[k][1]; m++;
      }
    }
    cxA[i] = m ? cx / m : 0;
    czA[i] = m ? cz / m : 0;
    fb[i * 4] = x0; fb[i * 4 + 1] = z0; fb[i * 4 + 2] = x1; fb[i * 4 + 3] = z1;
    const h0 = isNum(b.h) ? b.h : 0;
    // The island cap needs the ring's AREA, and a shoelace over every ring in the city is real
    // money to answer "no" for everything that is not a cottage on Ward's Island. Ask the cheap
    // half of the question first; islandBuildingHeight() returns `h` untouched in every case
    // islandCapCandidate() rejects.
    hA[i] = islandCapCandidate(HARBOUR, cxA[i], czA[i], h0)
      ? islandBuildingHeight(HARBOUR, cxA[i], czA[i], ringPlanArea(r0), h0) : h0;
    tileA[i] = grid.idAt(cxA[i], czA[i]);
    if (!(hA[i] > 0.5)) return;
    // The RAW ring box, over EVERY ring. It contains the prepared one — preparation only drops
    // rings below MIN_RING_AREA, which can shrink the box and never grow it — so it is a safe
    // draw box and a safe reach box.
    for (let k = 1; k < rings.length; k++) {
      const rg = rings[k];
      if (!Array.isArray(rg)) continue;
      for (let q = 0; q < rg.length; q++) {
        const p = rg[q];
        if (!isNum(p[0]) || !isNum(p[1])) continue;
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < z0) z0 = p[1];
        if (p[1] > z1) z1 = p[1];
      }
    }
    if (!(x0 <= x1)) return;
    reach.add(x0, z0, x1, z1, i);
    const y = isNum(b.y) ? b.y : 0;
    grid.cover(grid.tiles[tileA[i]], x0, z0, x1, z1, y - 2, y + hA[i] + 6);
  }, (f) => report(0.37 + f * 0.02, 'placing footprints'));

  // The tile membership lists, by counting sort: which records each tile will file when it is
  // built, in file order, which is the order the single-pass build filed them in.
  const tiles = grid.count;
  const start = new Int32Array(tiles + 1);
  for (let i = 0; i < n; i++) start[tileA[i] + 1]++;
  for (let t = 0; t < tiles; t++) start[t + 1] += start[t];
  const member = new Int32Array(n);
  {
    const fill = start.slice(0, tiles);
    for (let i = 0; i < n; i++) member[fill[tileA[i]]++] = i;
  }

  const claims = assignLandmarks(n, hA, cxA, czA, project);

  /* ------------------------------------------------------ per-record prep -- */

  /**
   * Everything about ONE record that is not where it is: rings into oriented parts, the material
   * and lighting profile, the storey model, the landmark claim, and the broadphase entry.
   *
   * Idempotent and independent of when it runs. Nothing here queries the broadphase, so it can be
   * called from inside a broadphase query without re-entering.
   */
  function ready(i) {
    if (state[i]) return prepped[i];
    state[i] = 1;
    const b = buildingsRaw[i];
    const rings = Array.isArray(b.r) ? b.r : [];
    const rec = {
      key: i + 1,
      // ISLANDS: on the island cottages the massing extract's height is the tree canopy over the
      // roof, not the roof. islandBuildingHeight() caps a small island footprint at a plausible
      // house; everywhere else it returns b.h untouched. Resolved by the placement pass, because
      // the tile a record belongs to has to know how tall it is before it is built.
      h: hA[i],
      y: isNum(b.y) ? b.y : 0,
      cx: cxA[i],
      cz: czA[i],
      rings,
      // Surveyed per-building attributes: lighting profile, facade colour, material, name.
      t: b.t,
      c: b.c,
      m: b.m,
      name: readName(b),
      // THE SURVEYED GROUND FLOOR. `units` are the premises OSM has on this building's frontage,
      // in order along it, each carrying the footprint SEGMENT and the parameter along it that
      // says where it really is; `hn` its street number; `lv` its real storey count; `roof` its
      // roof shape. Everything the block-face model below builds comes off these four.
      units: readUnits(b),
      hn: readHouseNumber(b),
      lv: readLevels(b),
      roof: readRoofShape(b),
      // Storey model, resolved once by storeyModel(): levels, floor-to-floor, ground storey.
      levels: 0, storeyH: 0, groundH: 0, levelsFromData: false,
      parts: null,
      mainPart: null,
      area: 0,
      mat: null,
      profile: 0,
      cls: '',
      landmark: null,
      bbox: null,
      towerSign: -1,
      // THE COPLANAR VERDICTS, filled in by city/coplanar.js when a tile first asks for this
      // record: its wall faces with their cuts and portals, and whether the whole record is
      // inside something taller and should not be drawn at all. Declared here so the shape of a
      // record is one thing you can read in one place, and so nothing anywhere sees `undefined`.
      walls: null, wallsNear: false, wallsCut: false, capsDone: false, coplanarDone: false,
      buried: false,
      // Street frontage, filled in by findFrontage() during the facade pass.
      frontX: 0, frontZ: 0, frontYaw: 0, frontLen: 0, frontNU: 1, frontNV: 0,
    };
    prepped[i] = rec;
    if (rec.h <= 0.5) return rec;

    // Footprint preparation only: rings are split into parts and oriented, but NOTHING is
    // triangulated here. Ear clipping happens inside emitCap(), which runs per tile, so the
    // cost of the roof of a building nobody has flown near yet is never paid.
    const parts = buildParts(rings, MIN_RING_AREA);
    if (!parts) { stats.ringsSkipped++; return rec; }
    rec.parts = parts;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    let area = 0, bestArea = -1;
    for (let p = 0; p < parts.length; p++) {
      const bb = planBBox(parts[p].outer);
      x0 = Math.min(x0, bb[0]); x1 = Math.max(x1, bb[2]);
      z0 = Math.min(z0, -bb[3]); z1 = Math.max(z1, -bb[1]);
      const a = Math.abs(planArea(parts[p].outer));
      area += a;
      // THE CAP RANK, settled here rather than in the resolver. Which of two coplanar roof caps
      // keeps the surface is decided by footprint area, and city/coplanar.js compares records that
      // may never have been resolved — so the number both sides of that comparison read has to
      // exist the moment a record does. The rest of the cap state starts at "undecided".
      parts[p].capArea = a;
      parts[p].capBuried = false;
      parts[p].capDrop = 0;
      parts[p].capLevel = -1;
      // The detail pass hangs the frontage, the roofscape and the parapet off ONE part; a stacked
      // massing record has several, and the biggest is the one a pedestrian actually meets.
      if (a > bestArea) { bestArea = a; rec.mainPart = parts[p]; }
    }
    rec.bbox = [x0, z0, x1, z1];
    rec.area = bestArea > 0 ? bestArea : area;
    addSorted(idx, x0, z0, x1, z1, rec, rec.key);
    stats.buildings++;
    stats.rings += parts.length;

    const L = claims[i];
    rec.landmark = L ? L.key : null;
    if (L) stats.landmarkHeights[L.key] = Math.max(stats.landmarkHeights[L.key] || 0, rec.h);
    if (L && L.key === 'cn') {
      rec.mat = M.cnShaft;
      rec.profile = 0;
      rec.cls = 'concrete';
      rec.glass = false;
      stats.materials.concrete = (stats.materials.concrete || 0) + 1;
      stats.profiles[0]++;
      return rec;
    }

    const spec = facadeMaterial(rec, L);
    rec.mat = spec.mat;
    rec.profile = spec.profile;
    rec.cls = spec.cls;
    rec.glass = spec.glassy;
    stats.materials[spec.cls] = (stats.materials[spec.cls] || 0) + 1;
    stats.profiles[spec.profile]++;
    if (spec.tagged) stats.surveyedColour++;
    // The storey model, resolved ONCE here rather than per tile: it is a property of the
    // building, every pass that lays anything out vertically reads it, and it is also where the
    // surveyed level count gets accepted or rejected.
    storeyModel(rec);
    const FA = stats.facades;
    if (rec.levelsFromData) FA.levelsFromData++;
    else {
      FA.levelsDerived++;
      if (rec.lv > 0) FA.levelsRejected++;
    }
    return rec;
  }

  /** Prepare every record whose raw ring box can overlap this box. Exact, and no wider. */
  function ensureBox(x0, z0, x1, z1) {
    reach.queryBox(x0, z0, x1, z1, (i) => { if (!state[i]) ready(i); });
  }

  /**
   * Enumerate the RAW records whose ring box can reach a disc, preparing none of them.
   *
   * The dangling-end pass (world/termini.js) needs to know whether a way end stops at a facade,
   * and it runs before any record has been prepared and asks the question 3.6 m at a time. It
   * used to build a second whole-city footprint index of its own to answer it — a pass over every
   * building in the city, in front of the first frame, for a few thousand queries with a 3.6 m
   * radius. This is the same enumeration off the index the placement pass already built.
   *
   * The candidate set is a SUPERSET of that index's: it is filed under the box of every ring
   * rather than of the first one, and it is the caller that applies the exact test.
   */
  function rawNear(x, z, r, visit) {
    reach.query(x, z, r, (i) => visit(buildingsRaw[i], fb, i * 4));
  }

  /**
   * Prepare the records this tile will build, and file them on it.
   *
   * Called by the tile builder before anything reads `t.f.b`. Members are walked in file order,
   * so `t.f.b` holds exactly what the single-pass build put there, in the same order.
   */
  function ensureTile(id) {
    const t = grid.tiles[id];
    if (!t || !t.f) return;
    for (let k = start[id]; k < start[id + 1]; k++) {
      const i = member[k];
      if (state[i] === 2) continue;
      const rec = ready(i);
      state[i] = 2;
      if (rec.parts) t.f.b.push(rec);
    }
  }

  /**
   * Prepare and file the whole city, a tile at a time, yielding between tiles.
   *
   * Nothing the player can see depends on this — every tile prepares itself — but two things that
   * measure the city do: the coplanar sweep needs a record array with no holes in it, and the
   * console audit's building, material and storey counters are a description of the survey rather
   * than of the flight path. It is a chore, drained a couple of milliseconds a frame behind the
   * first frame, exactly like the walkability audit.
   */
  function* sweep() {
    for (let id = 0; id < tiles; id++) {
      if (start[id] === start[id + 1]) continue;
      ensureTile(id);
      yield;
    }
    for (let i = 0; i < n; i++) if (!state[i]) ready(i);
  }

  /**
   * The broadphase, which prepares whatever a query reaches before answering it.
   *
   * Same surface as makeGridIndex: `add` (the synthesised surround registers its masses here),
   * `query` by disc and `queryBox`.
   */
  const bIndex = {
    add(x0, z0, x1, z1, item) {
      addSorted(idx, x0, z0, x1, z1, item, isNum(item.key) ? item.key : Infinity);
    },
    query(x, z, r, visit) {
      ensureBox(x - r, z - r, x + r, z + r);
      idx.query(x, z, r, visit);
    },
    queryBox(x0, z0, x1, z1, visit) {
      ensureBox(x0, z0, x1, z1);
      idx.queryBox(x0, z0, x1, z1, visit);
    },
  };

  /* ------------------------------------------------------------ CN Tower -- */
  // The tower's own record has to be found now rather than when its tile is built: the renderer's
  // lighting mask, the time presets and the tile that carries the hand-modelled mast all need to
  // know where it stands before the first frame. It is ONE record, prepared out of turn.
  //
  // The CN Tower must exist even if the massing record was rejected. Either way it is a feature
  // like any other, anchored in the tile that holds it; `cnRec` is null when the record was
  // rejected, and the loader takes the base off the ground there instead.
  const cnPoint = project(-79.3871, 43.6426);
  let cnRec = null;
  for (let i = 0; i < n && !cnRec; i++) {
    const L = claims[i];
    if (!L || L.key !== 'cn') continue;
    const rec = ready(i);
    if (rec.parts) cnRec = rec;
  }
  const cnX = cnRec ? cnRec.cx : cnPoint[0];
  const cnZ = cnRec ? cnRec.cz : cnPoint[1];

  return {
    prepped,
    bIndex,
    cnRec,
    cnX,
    cnZ,
    prep: {
      count: n,
      heightOf: (i) => hA[i],
      centreXOf: (i) => cxA[i],
      centreZOf: (i) => czA[i],
      ready,
      ensureBox,
      ensureTile,
      rawNear,
      sweep,
    },
  };
}

export { prepareBuildings };
