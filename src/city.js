// src/city.js — the LOADER. It orchestrates the build; it no longer contains it.
//
// CONTRACT.md §1, §3.1 and Amendment 11.1. Zero dependencies. World axes: X = east, Y = up,
// Z = south, true metres.
//
// WHAT THIS FILE IS NOW
// ---------------------
// loadCity() is a pipeline, and every stage of it lives in a module of its own. This file holds
// the ORDER those stages run in and the state they hand each other, and nothing else: no geometry
// is emitted here, no tunable is defined here, and no policy is decided here. Read top to bottom
// it is a description of how a city is built.
//
//   world/terrain.js      the height field, its padding, and the lake
//   world/water.js        the surveyed harbour, which carves the terrain to the real shoreline
//   world/termini.js      dangling ends, resolved on the raw polylines BEFORE anything reads them
//   world/grade.js        the grade solve: which way passes over which, and by how much
//   city/prep.js          where every building is, up front; what it is made of, on demand
//   city/coplanar.js      who owns a shared surface, resolved a building at a time, on demand
//   world/roads.js        the prepared road records and their spatial indices
//   world/junctions.js    the intersection graph
//   world/context.js      the one context object every detail pass reads
//   world/walk.js         the walkability audit (CONTRACT §8.2)
//   world/areas.js        parks, lots and piers, and the per-city budgets over them
//   world/surround.js     the edge of the world (CONTRACT §9.3)
//   city/tileindex.js     which tile owns which feature
//   city/tilebuild.js     the per-tile generator: everything a tile is made of, in stage order
//   city/queries.js       the runtime surface: buildingAt, collide, confine, streetNameAt
//
// The load is TWO things rather than one. Everything topological runs once, up front, and
// produces no vertices at all; everything geometric is deferred to tiles.js, which builds a tile
// the first time the camera needs it and throws the geometry away when it has been out of range
// long enough.
//
// PLAN SPACE, everywhere in this tree: (u, v) = (x, -z), u east and v NORTH. That is the ordinary
// maths convention, so "counter-clockwise = positive signed area" holds without any mental
// gymnastics, and a plan-CCW polygon emitted as 3D triangles with x = u, z = -v comes out with a
// +Y normal — which is what the roof caps and every ground ribbon need, because the renderer culls
// back faces.
//
// RING WINDING. ESRI winds outer rings clockwise and holes counter-clockwise; the build step
// negated north into +Z, which mirrors the plane and flips that. Nothing anywhere assumes either:
// each ring's signed area is measured, the largest |area| ring of a record is the outer boundary,
// rings that share its sign are separate parts (islands) and rings of the opposite sign are holes.
//
// THE VERTEX FORMAT is core/vertex.js's, and only core/vertex.js's; `tintable` is deliberately 0
// on all static city geometry — the uTint path is for dynamic meshes, and a tinted city is a bug.
//
// THE LIGHTING PROFILE (the 7th material channel) tells the renderer HOW a surface lights up after
// dark; it is not a colour and not a brightness. 0 envelope · 1 office · 2 residential · 3 retail
// · 4 parking · 5 civic, from `building.t` in the data. Profile 0 means the surface has NO windows
// at all — stadium shells, the CN Tower, every roof cap — and nothing in the tree may give a
// profile-0 surface facade-hint emissive, so the shader can never paint an office grid onto the
// Rogers Centre dome.
//
// TIME OF DAY (CONTRACT §7). Nothing in this tree bakes light. A surface carries an albedo, a
// roughness and a profile; a surface is emissive only if it is a real light source; and the
// renderer alone decides when an emitter is on.

// CORE. The GL wrapper, the small shared predicates, and the cooperative scheduler that keeps a
// multi-second build from freezing the tab (CONTRACT §3.1).
import { Mesh, MeshBuilder } from './core/gl.js';
import { isNum } from './core/util.js';
import { clamp } from './core/math.js';
import { now, frame, yieldCount, resetYields } from './core/async.js';

// PURE GEOMETRY, and THE DATA. Ring predicates live in geom/; what the file's fields are called,
// and getting it off the network and decoded, live in data/.
import { makePart, toPlan, planArea } from './geom/ring.js';
import { makeProjector, readExtent, featureList, readPois } from './data/schema.js';
import { fetchCity } from './data/load.js';

// THE WORLD. The ground and everything laid on it: the height field and the lake, the grade
// solve, the street network and its junctions, the ground-cover areas, the walkability audit,
// the dangling-end resolution and the edge of the world.
import {
  ROAD_Y, DUP_STAGGER, GRASS_Y, PARK_Y, LOT_Y, PATH_Y, WATER_Y, MARK_LIFT, GUTTER_LIFT,
} from './world/ground.js';
import { makeTerrain, padTerrain, terrainNormals, emitWaterMesh } from './world/terrain.js';
import { solveGrade } from './world/grade.js';
import { buildRoadRecords } from './world/roads.js';
import { buildJunctionGraph } from './world/junctions.js';
import { RAIL_PROUD, TRACK_SLAB_Y } from './world/rail.js';
import { prepareAreas } from './world/areas.js';
import { noteProp, noteLight, makeDetailContext } from './world/context.js';
import { walkAudit } from './world/walk.js';
import { resolveTermini } from './world/termini.js';
import {
  SUR_ENABLED, SUR_FRINGE_FRAC, SUR_FRINGE_MIN, SUR_FRINGE_MAX, HAZE_REACH, buildSurround,
} from './world/surround.js';
import { forEachSurroundMass, emitSurroundApron } from './world/fringe.js';
import { makeLimits, auditHorizon } from './world/limits.js';
import { ribbonAudit, setAudit } from './world/audit.js';

// HARBOURFRONT AND THE ISLANDS (CONTRACT §8.3). The surveyed shoreline, the quay wall and
// everything on the water are built by world/water.js, world/quay.js and world/islands.js;
// city.js only calls into them, at the points marked "harbourfront" below.
import { buildHarbour, carveHarbourTerrain, harbourDeckY } from './world/water.js';
import { appendHarbour } from './world/quay.js';
import { islandStats } from './world/islands.js';

// THE CITY. Materials, the building prep and the coplanar resolution, the per-tile generator and
// the tile assignment, the level-of-detail budget, the stats surface and the runtime queries.
import { MESH_CLASSES, LAST_OPAQUE_CLASS, SIGN_CLASS } from './city/materials.js';
import { prepareBuildings } from './city/prep.js';
import { makeCoplanarResolver } from './city/coplanar.js';
import { resetFacadeAudit } from './city/facadekit.js';
import {
  FAR_RANGE, FAR_DROP, FAR_FLOOR, FAR_NEAR, farRangeAt, S_FAR, S_MASS,
  MASS_RANGE, MASS_DROP, DETAIL_RANGE, DETAIL_DROP, SIGN_RANGE, SIGN_DROP,
  VERTEX_CAP,
  TILE_BUDGET_MS, TILE_EVICT_MS, CityTiles, makeBuilders, deliverCapture, S_DETAIL,
} from './city/lod.js';
import { makeTileBuilder } from './city/tilebuild.js';
import { indexTiles, initTileFeatures } from './city/tileindex.js';
import { makeQuerySurface } from './city/queries.js';
import { makeCityStats, makePhaseTimer } from './city/stats.js';
import { logCitySummary } from './city/report.js';

// SIGNAGE. The glyph atlas, shared with the renderer, which binds the same texture.
import { getFont } from './render/text.js';

// SPATIAL TILING. The city is one merged mesh per material class PER TILE, built on demand and
// thrown away when it goes out of range. See tiles.js for why, and for the level-of-detail stages.
import { TILE_SIZE, makeTileGrid } from './tiles.js';

/**
 * Load the city and stand up the tile system.
 *
 * THE LOAD IS THREE THINGS, not one, and the split is by WHEN rather than by what.
 *
 *   before the first frame   the ground and the topology every later stage reads: the height
 *                            field and the lake, the surveyed harbour, the dangling-end
 *                            resolution, the grade solve, WHERE every building is, the road
 *                            records, the junction graph, and the tile index. No vertices, and
 *                            nothing here that a tile could have answered for itself.
 *   when a tile is built     everything geometric, and the analysis that is a property of one
 *                            record and its neighbours: what that record is made of (city/prep.js
 *                            — rings into parts, material, storey model, broadphase), who owns a
 *                            shared wall, which roof caps are buried, where a corridor opens a
 *                            portal (city/coplanar.js).
 *   after the first frame    the chore queue, drained a couple of milliseconds a frame: the sweep
 *                            that prepares the records no tile ever asked for, the walkability
 *                            audit (CONTRACT §8.2), the quay wall and everything on the water
 *                            (§8.3), and the sweep that finishes the coplanar analysis. Each is an
 *                            interruptible generator; the two that emit geometry hand it to their
 *                            tiles when they finish and rebuild whatever was already standing.
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
  resetYields();

  report(0.01, 'connecting');
  const loaded = await fetchCity(url, (f) => report(0.02 + f * 0.30, 'downloading city data'));
  const data = loaded.data;
  report(0.34, 'reading city data');
  await frame();

  const meta = data.meta || {};
  const extent = readExtent(meta);
  const project = makeProjector(meta.origin);
  const buildingsRaw = featureList(data, 'buildings');
  const roadsRaw = featureList(data, 'roads');
  const areasRaw = featureList(data, 'areas');
  const railsRaw = featureList(data, 'rails');
  // SURVEYED NODES, in local metres. Filtered once by the schema so every pass downstream can
  // assume a finite position and a kind string.
  const poisRaw = readPois(data);

  const stats = makeCityStats();
  // A tile rebuilt after eviction runs the same emitters a second time. Its counters go here and
  // are thrown away, so the audit stays a description of the city rather than of the flight path.
  const scrap = makeCityStats();
  stats.source = loaded.source;
  stats.bytes = loaded.bytes;

  setAudit(stats);
  resetFacadeAudit();

  // WHERE THE TIME GOES. One entry per named phase, in milliseconds, on stats.phaseMs. Purely a
  // measurement: nothing branches on it, and the fingerprint excludes every `...Ms` key because a
  // wall clock cannot reproduce. `P.skip()` after a cooperative yield keeps the frame the browser
  // took back out of the next phase's total.
  const P = makePhaseTimer(stats, now);

  // Scratch builders for the two passes that genuinely cannot run a tile at a time; their output
  // is cut up by captureSplit() below and handed to the tiles that own it.
  const cap = makeBuilders();
  const waterMB = new MeshBuilder();
  // `mb` is rebound to the tile under construction; during the global phase it is the capture.
  let mb = cap;

  /* ---------------------------------------------------------------- terrain */
  report(0.36, 'building terrain');
  // THE SURVEYED SHORELINE decides how much of this there is to do. `infra` is the input to
  // makeTerrain's FALLBACK water mask — the one that recovers the harbour from the fact that land
  // is densely built on and the lake is not — and where data.shore exists, which it does for
  // Toronto, that mask is never built and the list is never read (CONTRACT §8.3). Collecting it
  // regardless meant walking every road, every ring of every building and every rail line before
  // the first frame to fill an array nothing looked at; at 181 k buildings that is seconds of the
  // critical path spent on a code path the city does not take. The pond rings are read either
  // way, so that loop stays.
  const surveyedShore = Array.isArray(data.shore) && data.shore.length > 0;
  const infra = [];
  if (!surveyedShore) {
    for (let i = 0; i < roadsRaw.length; i++) {
      if (Array.isArray(roadsRaw[i].p) && roadsRaw[i].p.length) infra.push(roadsRaw[i].p);
    }
    for (let i = 0; i < buildingsRaw.length; i++) {
      const rr = buildingsRaw[i].r;
      if (!Array.isArray(rr)) continue;
      for (let k = 0; k < rr.length; k++) {
        if (Array.isArray(rr[k]) && rr[k].length) infra.push(rr[k]);
      }
    }
    for (let i = 0; i < railsRaw.length; i++) {
      if (railsRaw[i].k === 'subway') continue;
      if (Array.isArray(railsRaw[i].p) && railsRaw[i].p.length) infra.push(railsRaw[i].p);
    }
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
    if (!surveyedShore) infra.push(a.p);
  }
  const T = makeTerrain(data.terrain || { nx: 2, nz: 2, cell: 25, h: [0, 0, 0, 0] },
    extent, infra, pondRings, surveyedShore);
  P.at('terrain');

  /* ------------------------------------------------------------ harbourfront */
  // CONTRACT §8.3. The surveyed shoreline replaces the guessed one: harbour.js brings the terrain
  // down to the real water, terminates the land edge at the quay wall, and wraps T.groundY so the
  // quay apron and the pier decks ARE the ground as far as everything downstream is concerned.
  // Must run before anything reads T.groundY or emits the terrain mesh.
  const HARBOUR = buildHarbour(data, { extent, terrain: T, waterY: WATER_Y });
  if (HARBOUR) carveHarbourTerrain(T, HARBOUR);
  P.at('harbour');

  /* --------------------------------------------------------- world boundary */
  // CONTRACT §9.3. The ground has to keep going past the survey, so the grid does. AFTER the
  // harbour carve, never before: replication copies whatever the boundary row says, and before
  // the carve every boundary row says "land" — which east and west of the harbour would extrude
  // a wall of dry ground straight across the open lake.
  const SUR_FRINGE = clamp(Math.min(extent.x, extent.z) * SUR_FRINGE_FRAC,
    SUR_FRINGE_MIN, SUR_FRINGE_MAX);
  padTerrain(T, SUR_FRINGE);
  // The bare padded height field, before the harbour wraps its decks round it again. The
  // land/water questions the surround and the walkability audit ask are about the GROUND, and a
  // quay apron or a pier deck is neither; reading them through the wrapper also costs a
  // deck-index query per sample, which over a hundred thousand samples is seconds rather than
  // milliseconds.
  const rawTerrainY = T.groundY;
  if (HARBOUR) {
    // groundY was rebuilt over the padded grid, so the quay/pier deck field has to be wrapped
    // round the new one or the harbour would go back to being terrain.
    HARBOUR.baseGroundY = rawTerrainY;
    T.groundY = (x, z) => {
      const g = rawTerrainY(x, z);
      const d = harbourDeckY(HARBOUR, x, z);
      return d > g ? d : g;
    };
  }
  const LIMITS = makeLimits(extent, SUR_FRINGE);
  stats.surround.fringe = SUR_FRINGE;
  stats.surround.reach = HAZE_REACH;
  stats.surround.softX = LIMITS.x;
  stats.surround.softZ = LIMITS.z;
  stats.surround.softEase = LIMITS.ease;
  stats.surround.edgeX = T.x0 + (T.nx - 1) * T.cell + HAZE_REACH;
  stats.surround.edgeZ = T.z0 + (T.nz - 1) * T.cell + HAZE_REACH;

  // The natural ground. Everything that is NOT part of the walking surface — the terrain mesh, the
  // lake, the railway, a bridge deck's own reference — reads this one.
  const terrainY = T.groundY;
  P.at('boundary');
  await frame();
  P.skip();

  /* ------------------------------------------------- tile grid and placement */
  // The grid exists BEFORE anything is prepared, because what a record's preparation is scheduled
  // against is the tile that will build it. It reaches past the data far enough to hold the whole
  // synthesised fringe and the padded terrain under it, or a surround feature would be indexed
  // into an edge tile whose draw box then swells to cover a kilometre of nothing.
  //
  // PLACEMENT ONLY — where every record is, how tall it is, and which tile will build it — and it
  // runs HERE, ahead of the dangling-end pass, because the ring-box index it leaves behind is what
  // that pass asks "is this way end stopping at a facade?". Everything else about a record is a
  // property of that record and is done when something first asks: when its tile is built, when a
  // neighbour's coplanar verdict reaches across a party wall, or when the player walks into it.
  // See city/prep.js.
  const grid = makeTileGrid(extent, TILE_SIZE, SUR_FRINGE + 420);
  initTileFeatures(grid);
  const { prepped, bIndex, cnRec, cnX, cnZ, prep } = await prepareBuildings({
    buildingsRaw, HARBOUR, SUR_FRINGE, extent, grid, project, report, stats,
  });
  P.at('footprints');
  await frame();
  P.skip();

  /* ------------------------------------------------------------- dangling ends */
  // CONTRACT §9.1, and it runs HERE for a reason: it mutates the raw polylines, and everything
  // after this line — the grade solve, the junction table, the walkability audit, the ribbons,
  // the street-name index — is built from them. Correcting the topology anywhere later would
  // leave two of those disagreeing about where the network joins up.
  report(0.40, 'closing the dangling ends');
  const termCaps = resolveTermini(roadsRaw, railsRaw, prep.rawNear, extent, stats);
  P.at('termini');
  await frame();
  P.skip();

  /* ------------------------------------------------------- grade separation */
  report(0.42, 'cutting the underpasses');
  const G = solveGrade(roadsRaw, railsRaw, extent, terrainY, stats);
  const gradeField = G.field;
  P.at('grade');
  await frame();
  P.skip();

  // ...and the WALKING surface, which is the terrain with every depressed corridor cut into it.
  // One composition, read by the carriageway ribbons, the pavement, every prop, the pedestrians
  // and the player, so no two of them can ever disagree about where the ground is.
  const groundY = (x, z) => terrainY(x, z) + gradeField.offset(x, z);
  // Where the tower's base slab sits. Taken off the record where the massing extract has one and
  // off the walking surface where it does not, which is why it waits for the grade solve.
  const cnBaseY = cnRec ? cnRec.y - 0.6 : groundY(cnX, cnZ);
  terrainNormals(T);
  // The lake is the one surface that is not tiled: 30 k vertices, visible from nearly every
  // viewpoint in the world, and drawn by its own reflection pass.
  emitWaterMesh(waterMB, T, extent, HARBOUR, HAZE_REACH);
  P.at('lake');
  report(0.44, 'shoreline');
  await frame();
  P.skip();

  /* ------------------------------------------------- coplanar resolution -- */
  // Which faces are worth drawing depends on what the NEIGHBOURING records draw — but ONLY on the
  // neighbours, and only on the ones close enough to touch. That is why this is no longer a
  // whole-city pass in front of the first frame: the resolver answers one record at a time, when
  // the tile holding it is built, and pulls in whatever neighbours that record's answer depends
  // on. What is left over — the audit totals, and the records that are buried and therefore in no
  // tile at all — is swept up by the chore queue afterwards. See city/coplanar.js.
  const COP = makeCoplanarResolver({
    extent, bIndex, stats, grade: gradeField, terrainY,
  });
  P.at('coplanar');

  /* ------------------------------------------------------------------ roads */

  const {
    recs, roadIdx, deckIdx, roadJobs, footJobs, subJobs, gx0, gz0, worstCut,
  } = await buildRoadRecords({
    roadsRaw, data, extent, terrainY, G, grid, report, stats,
  });
  P.at('roads');

  /* -------------------------------------------------------------- junctions */

  const { junctions, realFoot } = buildJunctionGraph({
    roadsRaw, roadJobs, recs, G, extent, gx0, gz0, poisRaw, bIndex, stats,
  });
  P.at('junctions');

  /* --------------------------------------------------------- detail context */
  const C = makeDetailContext({
    mb, groundY, terrainY, gradeField, bIndex, roadIdx, deckIdx, extent, gx0, gz0,
    poisRaw, railsRaw, recs, stats, font: getFont(gl), surWalk: LIMITS.out + 120,
    harbour: HARBOUR, rawY: rawTerrainY, realFoot,
  });
  P.at('context');

  // THE GLOBAL OCCUPANCY GRID, held by name. C.occ is rebound to the tile under construction once
  // tiles start building, and the quay pass below now runs BETWEEN tile builds; a harbour bollard
  // must claim its site on the grid the whole harbour shares, not on whichever tile happened to be
  // half-built when the chore was resumed.
  const worldOcc = C.occ;
  // Every site the harbour furniture reserves, as flat [x, z, r] triples. The quay pass fills it
  // from the chore queue; each tile replays whatever falls inside it into its own occupancy grid,
  // so a Queens Quay bin cannot be planted inside a mooring bollard that was placed first.
  const hClaims = [];

  /* ------------------------------------------------------------------ areas */

  const areaParts = await prepareAreas({
    areasRaw, prep, C, HARBOUR, cap, extent, report, buriedOf: COP.isBuried,
  });
  P.at('areas');

  /* ------------------------------------------------------ synthesised surround */
  // CONTRACT §9.3. Measured out of the boundary strip and generated ONCE, as a few thousand small
  // records; the tiles build the geometry from them on demand exactly as they do for surveyed
  // features. Land and water are decided by the terrain alone, which is why the same code puts a
  // city north of Bloor and open lake south of the Islands without being told which is which.
  report(0.74, 'building the surround');
  const landAt = (x, z) => {
    const y = terrainY(x, z);
    return isNum(y) && y > WATER_Y + 0.20;
  };
  const SUR = SUR_ENABLED
    ? buildSurround({ extent, fringe: SUR_FRINGE, landAt, terrainY, roadsRaw, buildingsRaw, stats })
    : { roads: [], blocks: [], strips: [] };
  P.at('surround');
  // Everything the player can physically reach is a real obstacle. The reachable band is thin —
  // the soft limit is SOFT_OUT past the data and a body radius past that — so only the first few
  // rings are registered, and they are registered from the SAME pure enumeration the geometry
  // pass uses, so what you walk into is exactly what you can see.
  {
    const reach = LIMITS.out + 90;
    for (let i = 0; i < SUR.blocks.length; i++) {
      const blk = SUR.blocks[i];
      if (blk.t > reach) continue;
      forEachSurroundMass(blk, terrainY, (ring, g, h) => {
        const part = makePart(ring, []);
        const bb = part.bbox;
        const rec = {
          parts: [part], bbox: [bb[0], -bb[3], bb[2], -bb[1]], y: g - 1.6, h, surround: true,
        };
        bIndex.add(rec.bbox[0], rec.bbox[1], rec.bbox[2], rec.bbox[3], rec);
        stats.surround.registered++;
      }, realFoot);
    }
  }
  await frame();

  /* ================================================================= tiles == */

  P.skip();
  await indexTiles({
    G, HARBOUR, SUR, T, areaParts, cap, cnBaseY, cnX, cnZ, footJobs, grid, groundY,
    junctions, poisRaw, railsRaw, recs, report, roadsRaw, stats, subJobs,
    termCaps, terrainY, worstCut,
  });
  P.at('indexTiles');

  /* ------------------------------------------------------- the tile builder */

  // Harbour props claimed occupancy against a grid that no longer exists once tiles take over.
  // `harbourClaims` replays those claims into each tile's own grid so a Queens Quay bin cannot be
  // planted inside a mooring bollard that was placed first.
  const buildTile = makeTileBuilder({
    C, COP, G, HARBOUR, T, cnBaseY, cnX, cnZ, data, extent, gradeField, groundY,
    harbourClaims: hClaims, prep, recs, scrap, stats, terrainY,
  });

  const tiles = new CityTiles({
    gl,
    grid,
    // The cone the want set is built against. Measured at street level: the defaults were wide
    // enough that 65 tiles of massing stood resident for the ~20 that were on screen.
    viewMarginFrac: 0.30,
    viewMarginMin: 350,
    omniRadius: 900,
    classes: MESH_CLASSES,
    signClass: SIGN_CLASS,
    lastOpaque: LAST_OPAQUE_CLASS,
    stages: [
      // The far tier serves an ANNULUS. Inside FAR_NEAR the massing stage draws over it, so a
      // resident far tile there is geometry that is suppressed every frame it exists.
      { name: 'far', range: FAR_RANGE, drop: FAR_DROP, floor: FAR_FLOOR, near: FAR_NEAR,
        supersededBy: S_MASS },
      { name: 'massing', range: MASS_RANGE, drop: MASS_DROP },
      { name: 'detail', range: DETAIL_RANGE, drop: DETAIL_DROP },
      { name: 'signs', range: SIGN_RANGE, drop: SIGN_DROP },
    ],
    build: buildTile,
    vertexCap: VERTEX_CAP,
    budgetMs: TILE_BUDGET_MS,
    evictMs: TILE_EVICT_MS,
  });

  /* --------------------------------------------------------- deferred audits */
  // WHAT THE FIRST FRAME DOES NOT NEED. CONTRACT §8.2 and §9.4 are acceptance tests: they measure
  // the world, they never change it, and no vertex anywhere depends on their result. They are
  // also the two passes in the load whose cost is an AREA rather than a network — a 20 m land
  // lattice and an 8 m hole lattice over the whole map — so they are exactly the wrong thing to
  // put in front of a player waiting for a first frame.
  //
  // Each entry is a generator that yields often enough to be interruptible. update() advances the
  // head of the queue for a couple of milliseconds per frame, the way tiles.js spends a frame
  // budget on geometry; settle() runs the lot in one go, which is what the headless tools want.
  // The console summary waits for the queue so the numbers it prints are the finished ones.
  const chores = [];
  const CHORE_MS = 2.0;
  // Scratch builder sets for the two deferred passes that emit geometry. They write here rather
  // than into C.mb, which by now belongs to whichever tile is under construction.
  const quayCap = makeBuilders();
  const walkCap = makeBuilders();

  /**
   * Generate again every tile that overlaps a set of [x, z, r] claims.
   *
   * A deferred pass that RESERVES ground — the harbour furniture does — changes what the
   * procedural furniture pass is allowed to put there. Tiles built before those reservations
   * existed were right about everything except that, so they are dropped and rebuilt; the
   * scheduler re-queues them next frame like any other empty stage. Nothing is standing yet when
   * the chores are drained in one go, which is the case the geometry fingerprint measures.
   */
  function rebuildNear(claims) {
    if (!claims.length) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < claims.length; i += 3) {
      const r = claims[i + 2];
      if (claims[i] - r < x0) x0 = claims[i] - r;
      if (claims[i] + r > x1) x1 = claims[i] + r;
      if (claims[i + 1] - r < z0) z0 = claims[i + 1] - r;
      if (claims[i + 1] + r > z1) z1 = claims[i + 1] + r;
    }
    for (let k = 0; k < grid.tiles.length; k++) {
      const t = grid.tiles[k];
      if (t.cx1 < x0 || t.cx0 > x1 || t.cz1 < z0 || t.cz0 > z1) continue;
      tiles.invalidate(t);
    }
  }

  // CONTRACT §8.2, ENTIRELY OFF THE CRITICAL PATH. The walkable graph is global — a connected
  // component is not a local property — so it cannot be sharded per tile; but nothing about it is
  // needed before a first frame either. It measures the world, and the only thing it CHANGES is
  // two kinds of local repair: a paved connector across a survey gap, and a flight of steps at a
  // cliff. Those go into a capture of its own and are handed to their tiles the moment the solve
  // finishes (deliverCapture), which rebuilds the handful that were already standing.
  /* ------------------------------------------------------------ harbourfront */
  // CONTRACT §8.3. Everything on the water: the quay wall and its apron, the piers and their pile
  // structure, the rubble mounds, the marina floats, the ferry terminal slips, the boardwalk and
  // the trail, and the furniture that stands on all of it.
  //
  // world/quay.js walks 32 km of surveyed shoreline as continuous runs, which no tile owns, so
  // this is the other pass that genuinely cannot be sharded — and, like the walkability audit, it
  // is not something a first frame needs. It runs from the chore queue as an interruptible
  // generator; when it finishes, the geometry is cut up per tile and the tiles that were already
  // standing anywhere near the water are generated again, because a Queens Quay bin cannot be
  // planted inside a mooring bollard whose claim had not been made yet.
  if (HARBOUR) {
    chores.push((function* buildQuay() {
      yield* appendHarbour(HARBOUR, {
        mb: quayCap,
        data,
        claim: (x, z, r) => {
          if (!worldOcc.claim(x, z, r)) return false;
          hClaims.push(x, z, r);
          return true;
        },
        note: (kind) => noteProp(C, kind),
        light: (kind, x, y, z) => noteLight(C, kind, x, y, z),
      });
      yield* deliverCapture({ grid, tiles, cap: quayCap, stageOf: { props: S_DETAIL }, stats });
      rebuildNear(hClaims);
    })());
  }

  // WHAT THE TILES DID NOT ASK FOR — the buildings first, then their coplanar verdicts.
  //
  // Footprint preparation happens when the tile holding a record is built, so what the player can
  // see is always prepared; but the audit's building, material and storey counters are meant to
  // describe the SURVEY rather than the flight path, and the coplanar sweep needs a record array
  // with no holes in it. Both finish the rest of the city from the chore queue, a tile at a time,
  // behind the first frame — which is also how a record that is buried, and therefore indexed
  // into no tile at all, still gets its verdict.
  chores.push(prep.sweep());
  chores.push(COP.sweep(prepped));

  // THE WALKABILITY SOLVE IS STREET DETAIL, NOT MASSING. Everything it emits — dropped kerbs,
  // flights of steps, the connectors that close a gap between two pavements — is pavement-scale
  // and invisible past a couple of hundred metres. It used to default into the massing stage,
  // which meant it was built out to the full massing radius: measured at 11.8 M vertices over
  // the map, 34% of all massing geometry, none of it resolvable where most of it stood. Moving
  // it to the detail stage is the single largest saving in the build.
  chores.push(walkAudit({
    C, G, roadsRaw, extent, stats, mb: walkCap,
    deliver: (mb) => deliverCapture({
      grid, tiles, cap: mb, stageOf: {}, defaultStage: S_DETAIL, stats,
    }),
  }));

  /**
   * Advance the head of the chore queue for a couple of milliseconds.
   *
   * THE AUDIT BINDINGS ARE SAVED AND RESTORED around the slice. A chore runs BETWEEN tile builds,
   * and a tile build that has been suspended mid-generator has left `C.stats` and the ribbon audit
   * pointing at the scrap counters of a rebuild. A chore is never a rebuild, so its counters
   * belong to the real stats object; and the suspended build's binding has to come back untouched
   * or the rest of that tile would be counted twice.
   */
  function pumpChores(ms) {
    if (!chores.length) return;
    const t0c = now();
    const until = t0c + (isNum(ms) && ms > 0 ? ms : CHORE_MS);
    const heldStats = C.stats;
    const heldAudit = ribbonAudit();
    C.stats = stats;
    setAudit(stats);
    while (chores.length) {
      if (chores[0].next().done) { chores.shift(); continue; }
      if (now() >= until) break;
    }
    C.stats = heldStats;
    setAudit(heldAudit);
    P.add('deferred', now() - t0c);
    if (!chores.length) choresDone();
  }

  /** Run every outstanding deferred audit to completion, synchronously. */
  function settle() {
    const t0c = now();
    const heldStats = C.stats;
    const heldAudit = ribbonAudit();
    C.stats = stats;
    setAudit(stats);
    while (chores.length) {
      if (chores[0].next().done) chores.shift();
    }
    C.stats = heldStats;
    setAudit(heldAudit);
    P.add('deferred', now() - t0c);
    choresDone();
    return stats;
  }

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

  // THE APRON (CONTRACT §9.3/§9.4). The only other piece of geometry in the world that is not
  // tiled, for the same reason the lake is not: it is on screen from every viewpoint there is,
  // and it is cheap enough that streaming it would cost more than keeping it.
  {
    const apron = new MeshBuilder();
    emitSurroundApron(apron, T, HAZE_REACH);
    stats.surround.apronVerts = apron.count;
    stats.meshes.apron = apron.count;
    tiles.setStatic('terrain', new Mesh(gl, apron.data()));
    apron.reset();
  }

  // CONTRACT §9.4: prove that the world never visibly ends, from the whole perimeter of the soft
  // limit, at five altitudes, along twenty-four bearings, at all four time presets.
  auditHorizon(T, LIMITS, HAZE_REACH, groundY, stats);
  P.at('horizon');

  stats.isle = islandStats(HARBOUR);
  stats.seconds = (now() - t0) / 1000;
  stats.yields = yieldCount();
  stats.tileSize = TILE_SIZE;
  stats.tileCount = grid.count;
  stats.vertexCap = VERTEX_CAP;


  /* ---------------------------------------------------------- query surface */

  const { buildingAt, collide, limitFrac, confine, streetNameAt } = makeQuerySurface({
    bIndex, gradeField, terrainY, LIMITS, extent, roadsRaw, G,
  });
  P.at('queries');

  /* -------------------------------------------------------------- reporting */

  let logged = false;
  let logWanted = false;
  function logSummary() {
    if (logged) return;
    // The summary reports the walkability audit, and the audit is still running. Printing half of
    // it and never correcting it would be worse than printing it a second later.
    if (chores.length) { logWanted = true; return; }
    logged = true;
    logCitySummary(stats, tiles, grid, extent, HARBOUR);
  }

  /** Called once the chore queue empties, however it was drained. */
  function choresDone() {
    if (logWanted) logSummary();
  }

  /**
   * Everything the frame loop owes the city: level of detail, culling, the geometry budget and
   * eviction. Call once per frame, before drawing.
   */
  function update(camera, nowMs, budgetMs) {
    // The far tier's radius follows eye height — see farRangeAt(). Written straight onto the
    // stage because range() and drop() read it every frame anyway, and the adaptive valve's
    // scale multiplies whatever is there.
    {
      const st = tiles.stages[S_FAR];
      const r = farRangeAt(camera && camera.pos ? camera.pos[1] : 0);
      if (st && r !== st.range) { st.range = r; st.drop = Math.round(r * 1.15); }
    }
    tiles.frame(camera, nowMs, budgetMs);
    // The deferred audits get their slice AFTER the geometry: a tile the player is looking at is
    // worth more than a counter nobody has asked for yet.
    pumpChores(CHORE_MS);
    flushLights();
    const TS = tiles.stats;
    stats.verts = TS.residentVerts + (meshes.water ? meshes.water.vertexCount : 0);
    stats.tris = (stats.verts / 3) | 0;
    return tiles;
  }

  /**
   * Hand the accumulated luminaires to the renderer's clustered rig.
   *
   * Lamps are placed by the DETAIL stage, which builds lazily per tile, so the set grows as the
   * player walks. setLights() REPLACES the whole registration and rebuilds its broadphase, which
   * is O(n) over a few thousand entries — cheap, but not something to do every frame, so this only
   * runs on the frames where a tile actually added a lamp. Registrations are deduplicated on world
   * position (noteLight), so a tile that is evicted and rebuilt does not grow the list, and the
   * total is bounded by the number of luminaires in the city.
   *
   * The renderer is resolved exactly the way the signage pass resolves it, so a build with no
   * renderer attached still produces the identical city — just without local lights.
   */
  function flushLights() {
    if (!C.lampsDirty) return;
    const r = tiles._signRenderer ? tiles._signRenderer() : null;
    if (!r || typeof r.setLights !== 'function') return;
    C.lampsDirty = false;
    stats.lights = r.setLights(C.lampList);
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
    // Every luminaire this build has placed, at its LENS, in the shape render.js setLights() takes.
    // update() registers it automatically; it is exposed so the harness can audit lamp coverage
    // without a GL context and so a caller driving its own renderer can register it by hand.
    lights: C.lampList,
    groundY,
    buildingAt,
    collide,
    streetNameAt,
    // THE WORLD BOUNDARY (CONTRACT §9.3). `bounds` is every number the edge of the world is made
    // of; `confine` is the soft limit; `limitFrac` is how close to it you are.
    bounds: {
      extentX: extent.x / 2, extentZ: extent.z / 2,
      x: LIMITS.x, z: LIMITS.z, ease: LIMITS.ease, out: LIMITS.out,
      fringe: SUR_FRINGE, reach: HAZE_REACH,
      edgeX: stats.surround.edgeX, edgeZ: stats.surround.edgeZ,
    },
    confine,
    limitFrac,
    update,
    warm,
    // Drain the deferred audits in one go. The frame loop does this a couple of milliseconds at a
    // time through update(); a headless caller that never draws a frame calls this instead.
    settle,
    dispose() {
      tiles.dispose();
      if (meshes.water) meshes.water.dispose();
    },
  };
}

export default { loadCity };
