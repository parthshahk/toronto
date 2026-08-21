// src/city/report.js — the console summary of a completed load.
//
// CONTRACT.md §8.2, §9.4 and Amendment 11.1. Moved out of city.js unchanged. One function, and
// the only place in the tree that formats a number for a person to read. Every value it prints
// comes off the stats object city/stats.js created; nothing here measures anything itself.

import { VERT_FLOATS } from '../core/vertex.js';
import { TILE_SIZE } from '../tiles.js';
import { harbourStats } from '../world/water.js';
import { UNDER_CLEAR } from '../world/grade.js';
import { VERTEX_CAP } from './lod.js';

/**
 * Print the load's summary to the console, once.
 *
 * Everything here is a NUMBER the audits measured, not an impression: CONTRACT §8.2 and §9.4 say
 * "report each as a number", and this is where those numbers surface for a human. The caller owns
 * the once-only flag, because a city object may be asked to log at more than one point in a boot.
 *
 * `extent` and `harbour` are passed in rather than read off `stats` because they are not
 * measurements: extent is the file's own bbox (data/schema.js readExtent) and harbour is the
 * surveyed water model, whose own counters world/water.js exposes through harbourStats(). When
 * this function lived inside loadCity() both were closure variables; they are arguments now.
 */
function logCitySummary(stats, tiles, grid, extent, harbour) {
  if (typeof console === 'undefined' || !console.log) return;
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
    'walkability) held as ' +
    (stats.chunkVerts * VERT_FLOATS * 4 / 1048576).toFixed(1) + ' MB of ' +
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
    Math.round(WK.metres).toLocaleString() + ' walkable m in the largest component (' +
    (WK.fractionDry * 100).toFixed(2) + '% of everything reachable without a boat: ' +
    WK.marineIslands + ' components holding ' + Math.round(WK.marineMetres).toLocaleString() +
    ' m are across open water), ' +
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
  // THE WORLD BOUNDARY. CONTRACT §9.1's counter, §9.3's cost and §9.4's proof, in that order.
  const ED = stats.edge;
  console.log('[city] dangling ends: ' + ED.danglingBefore + ' of ' + ED.termini +
    ' way ends were dangling inside the map (' + ED.atBuilding + ' end at a building, ' +
    ED.atBoundary + ' at the world edge and are continued by the surround); ' + ED.welded +
    ' welded, ' + ED.connected + ' extended to a way (' + ED.spliced +
    ' nodes spliced into the ways they met), ' + ED.capped +
    ' given a designed terminus (' + ED.culDeSacs + ' turning heads, ' + ED.barriers +
    ' barrier lines, ' + ED.bufferStops + ' buffer stops), ' + ED.subwayEnds +
    ' concourse ends left to the PATH walls; ' + ED.danglingAfter + ' left, ' +
    ED.terminiAfter + ' way ends remain in total');
  const SR = stats.surround;
  console.log('[city] surround: ' + Math.round(SR.fringe) + ' m fringe on ' + SR.spokes +
    ' spokes (' + SR.waterSpokes + ' open water), ' + SR.rings + ' rings, ' + SR.streets +
    ' streets over ' + Math.round(SR.streetMetres).toLocaleString() + ' m, ' + SR.blocks +
    ' blocks in ' + SR.tiles + ' tiles, ' + SR.registered +
    ' masses registered for collision; ' + SR.verts.toLocaleString() +
    ' vertices built + ' + SR.apronVerts.toLocaleString() + ' in the apron, generated in ' +
    SR.ms.toFixed(1) + ' ms (ends ' + ED.ms.toFixed(1) + ' ms); soft limit at +' +
    Math.round(SR.softX - extent.x / 2) + ' m over ' + Math.round(SR.softEase) +
    ' m of easing, drawn world out to +' + Math.round(SR.reach / 1000) + ' km');
  const HZ = stats.horizon;
  console.log('[city] horizon: ' + HZ.rays.toLocaleString() + ' rays from the soft limit to ' +
    'the edge of the drawn world, nearest ' + Math.round(HZ.minEdgeDistance).toLocaleString() +
    ' m; worst airlight ' + (HZ.worst * 100).toFixed(2) + '% (' +
    (HZ.worstAt ? HZ.worstAt.preset + ' at ' + HZ.worstAt.alt + ' m, ' +
      HZ.worstAt.len.toLocaleString() + ' m sightline' : 'n/a') + '), ' + HZ.fails +
    ' below the ' + (HZ.pass * 100).toFixed(0) + '% threshold');
  const HB = harbour ? harbourStats(harbour) : null;
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
export { logCitySummary };
