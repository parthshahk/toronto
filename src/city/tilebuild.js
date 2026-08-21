// src/city/tilebuild.js — the per-tile generator: everything a tile is made of, in stage order.
//
// CONTRACT.md §6.4, §8.4 and Amendment 11.1. Moved out of city.js unchanged. This is the one
// place in the tree that knows the ORDER geometry is emitted in, and it is deliberately the only
// one: every builder it calls is a pure function of (MeshBuilder, feature, context), so a tile
// can be built at any time, in any order, and twice with the same result.
//
// THE THREE STAGES (see city/lod.js):
//   S_MASS    what a tower contributes to a two-kilometre view: massing with its real facade
//             colour and lighting profile, the ground it stands on, carriageways, rails, quay.
//   S_DETAIL  everything you can only resolve from the pavement: markings, kerbs, shopfronts,
//             balconies, street furniture, vehicles, people.
//   S_SIGNS   the glyph quads for shop names and house numbers, drawn in their own blended pass.
//
// buildTile is a GENERATOR: it yields between features so the tile scheduler can hand the frame
// back, which turns a dense downtown tile into twenty partial frames rather than one 60 ms stall.
//
// Determinism (CONTRACT §8.4): every seeded stream is keyed on the TILE and the stage, never on
// how much of the city happened to be resident, so the geometry a tile produces is a function of
// the tile alone. A rebuilt tile's counters go to `scrap` so the audit stays a description of the
// city rather than of the flight path.

import { clamp, makeRng, TAU } from '../core/math.js';
import { isNum } from '../core/util.js';
import { partContains, planArea } from '../geom/ring.js';
import { polyResample, pruneSpikes, polyFrames, emitSkirt } from '../geom/ribbon.js';
import { emitCap, emitDrapedCap } from '../geom/extrude.js';
import {
  appendTowerSign, appendConstructionCrane, appendPitchedRoof, appendParkTree, appendShrub,
} from '../props/index.js';
import { facadeAudit } from './facadekit.js';
import { appendIslandDetail, appendIslandMass } from '../world/islands.js';
import { M, setMat, roofMat } from './materials.js';
import { emitCNTower } from './landmarks.js';
import { emitWallFace } from './buildings.js';
import { buildFacade, buildSignage } from './frontage.js';
import { placeRoofscape, roofShapeOf, roofBox, roofRise, ROOF_BOX } from './roofs.js';
import {
  S_MASS, S_DETAIL, S_SIGNS, appendChunk, surroundVerts, PARK_TREE_SPACING,
} from './lod.js';
import { emitRibbon, setAudit } from '../world/audit.js';
import {
  SEED, PED_SEED, ROAD_Y, ROAD_MAX_SEG, CROWN, CURB, PATH_Y, TIE_SPACING, boxAA,
} from '../world/ground.js';
import { emitTerrainRange } from '../world/terrain.js';
import { RAIL_BED, RAIL_DECK, ROAD_DECK, corridorDepth } from '../world/grade.js';
import { emitWallStrip, emitTrench, emitPassage, emitSubway } from '../world/trench.js';
import {
  PROP_H, deckFits, deckSoffitAbove, inFootprint, makeOccupancy, noteProp, onCarriageway, reserve,
} from '../world/context.js';
import { emitSidewalkBands, buildFootway } from '../world/roads.js';
import { emitRoadMarkings } from '../world/markings.js';
import { emitJunctionKerbs, placeJunctionProps } from '../world/junctions.js';
import { TRACK_SLAB_HW, emitTramRoute, placeTramStops } from '../world/rail.js';
import { placeFurniture } from '../world/furniture.js';
import { placeSurveyedFurniture, placeSurveyedCrossings } from '../world/surveyed.js';
import {
  MAX_LOT_CARS_EACH, MAX_LOT_CARS_TILE, placeKerbCars, placeLotCars, placeRailCars,
} from '../world/vehicles.js';
import { placeServiceProps, placeScaffold } from '../world/works.js';
import { placeQuayBerth, placeHarbourCraft } from '../world/marine.js';
import { placePedestrians } from '../world/people.js';
import { emitCulDeSac, emitTerminusBarrier, emitBufferStop } from '../world/termini.js';
import { emitSurroundStreet, emitSurroundBlock, emitFringeBank } from '../world/fringe.js';

/**
 * Build the per-tile generator over one finished load.
 *
 * @param {object} W everything the load produced that a tile needs: the street-detail context,
 *   the grade solve, the harbour, the terrain, the CN Tower's real position, the raw data, the
 *   ground samplers, the harbour's occupancy claims, the road records and the two stats objects.
 * @returns {GeneratorFunction} build(tile, stage, builders)
 */
function makeTileBuilder(W) {
  const {
    C, G, HARBOUR, T, cnBaseY, cnX, cnZ, data, extent, gradeField, groundY,
    harbourClaims, recs, scrap, stats, terrainY,
  } = W;

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
    setMat(C.mb.buildings, roofMat(b.mat));
    for (let p = 0; p < b.parts.length; p++) {
      const part = b.parts[p];
      if (!part.capBuried) emitCap(C.mb.buildings, part, y1 - part.capDrop, C.stats);
    }
    // A REAL ROOF SHAPE where the survey has one. 286 buildings carry a roof:shape that is not
    // flat, and until now every one of them rendered as a flat lid — which on the house stock
    // north of Queen and on the island cottages is the single loudest tell that the city was
    // generated. The pitched form stands ON the flat cap rather than replacing it, so the
    // triangulation the massing pass already did stays valid and there is no seam.
    if (roofShapeOf(b) && roofBox(b.mainPart)) {
      const rise = roofRise(b, ROOF_BOX);
      appendPitchedRoof(C.mb.buildings, ROOF_BOX.cx, y1 - (b.mainPart.capDrop || 0), ROOF_BOX.cz,
        ROOF_BOX.yaw, ROOF_BOX.w, ROOF_BOX.d, rise, roofShapeOf(b), roofMat(b.mat));
      C.stats.facades.roofForms++;
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
    setAudit(C.stats);
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
        const dy = y - g;
        if (dy < -0.02 || dy > ROAD_Y + CURB + 0.06) {
          stats.people.sunk++;
          if (Math.abs(dy) > Math.abs(stats.people.worstSunk)) {
            stats.people.worstSunk = dy;
            stats.people.worstSunkAt = [Math.round(x), Math.round(z)];
          }
        }
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
    setAudit(stats);
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

    if (stage === S_SIGNS) {
      /* ---------------------------------------------------------------- signage */
      // The shortest-range stage: shop names and house numbers, and nothing else. See S_SIGNS.
      for (let i = 0; i < F.b.length; i++) {
        buildSignage(C, F.b[i]);
        if ((i & 31) === 31) yield;
      }
      endTile(tile, stage, first);
      return;
    }

    if (stage === S_MASS) {
      emitTerrainRange(builders.terrain, T, gradeField, F.i0, F.i1, F.j0, F.j1);
      // CONTRACT §9.2: the synthesised ground never simply becomes water.
      emitFringeBank(C, T, F.i0, F.i1, F.j0, F.j1, extent);
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
      // THE WORLD BOUNDARY. A designed terminus is part of the street it ends, and the fringe is
      // massing and the ground plane, so both belong to stage 0: they have to exist as soon as
      // the tile does, or the world would still visibly stop until the detail stage caught up.
      if (F.caps.length || F.sroads.length || F.sblocks.length) {
        yield;
        const v0 = surroundVerts(builders);
        for (let i = 0; i < F.caps.length; i++) {
          const capRec = F.caps[i];
          if (capRec.kind === 'cul') emitCulDeSac(C, capRec);
          else if (capRec.kind === 'buffer') emitBufferStop(C, capRec, 0);
        }
        for (let i = 0; i < F.sroads.length; i++) {
          emitSurroundStreet(C, F.sroads[i]);
          if ((i & 15) === 15) yield;
        }
        yield;
        for (let i = 0; i < F.sblocks.length; i++) {
          emitSurroundBlock(C, F.sblocks[i]);
          if ((i & 15) === 15) yield;
        }
        if (first) C.stats.surround.verts += surroundVerts(builders) - v0;
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
      // Mid-block crossings from the survey. Before the junction pass, because emitStripe()
      // borrows C.stations as scratch and the transit stops that list holds are pushed later.
      placeSurveyedCrossings(C, F.pois);
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
      /* --------------------------------------------- surveyed furniture --- */
      // 21,974 real positions, placed BEFORE the procedural pass so they claim their own sites
      // and the fixed-pitch pass fills only what the survey leaves.
      placeSurveyedFurniture(C, F.pois);
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
      // THE WORLD BOUNDARY: the bollard lines that close an alley or a footpath. Street
      // furniture, so it belongs to the detail stage exactly as every other bollard does.
      for (let i = 0; i < F.caps.length; i++) {
        if (F.caps[i].kind === 'barrier') emitTerminusBarrier(C, F.caps[i]);
      }
    }

    endTile(tile, stage, first);
  }

  return buildTile;
}

export { makeTileBuilder };
