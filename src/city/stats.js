// src/city/stats.js — the measurement surface, and the console summary that reads it.
//
// CONTRACT.md §8.2, §9.4 and Amendment 11.1. Moved out of city.js unchanged. Every pass in the
// tree writes into one of these objects; tools/harness.mjs and tools/fingerprint.mjs read it, and
// the acceptance tests in CONTRACT §8.2 and §9.4 are numbers in here rather than impressions.
//
// makeCityStats() is a FACTORY rather than a literal because a tile rebuilt after eviction runs
// the same emitters a second time, and counting its props and its paint quads again would turn
// the audit into a function of how much flying the player did. A rebuild gets a scrap instance
// and the real numbers stay the numbers from the first time the tile was built.

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
    // WHERE THE LOAD SPENT ITS TIME, one entry per named phase, in milliseconds. Excluded from
    // the fingerprint by name (every key ending in `Ms` is), because a wall clock is the one part
    // of a build that cannot reproduce. See makePhaseTimer() below.
    phaseMs: {},
    // Facade audit: how many buildings each material family and lighting profile claimed, and
    // how many took a surveyed OSM colour rather than a hashed one.
    materials: {}, profiles: [0, 0, 0, 0, 0, 0], surveyedColour: 0,
    // Accuracy invariants the harness re-checks every run.
    landmarkHeights: {}, gridDeg: 0,
    // THE SURVEYED FURNITURE (data/toronto.json pois[]). `placed` is how many of the 21,974
    // surveyed nodes became geometry, `refused` how many were rejected by the same placement
    // rules the procedural pass obeys (inside a footprint, on a carriageway, under a deck, on
    // top of something already there), and `fallback` how many items the procedural pass still
    // had to invent because the survey is silent there.
    survey: { total: 0, placed: 0, refused: 0, crossings: 0, crossingNodes: 0,
      crossingsAtJunction: 0, crossingsOffRoad: 0, fallback: 0, suppressed: 0,
      signalsAdded: 0, byKind: {} },
    // Street-detail audit (CONTRACT §6.3 / §6.4).
    props: {}, facades: {
      groundFloors: 0, shopfronts: 0, balconyBands: 0, cornices: 0, stringCourses: 0,
      fireEscapes: 0, loadingDocks: 0, parapets: 0,
      // THE BLOCK-FACE AND UNIT MODEL. `faces` is how many street-facing elevations were treated
      // (it used to be one per building, capped at 24 m); `frontageM` the metres of frontage
      // those cover; `units` the shopfronts built and `unitsSurveyed` how many of them are a
      // real surveyed premises rather than plausible filler; `unitsMatched` / `unitsAvailable`
      // how much of the survey the geometry actually managed to place.
      faces: 0, multiFace: 0, frontageM: 0, frontageMBefore: 0, units: 0, unitsSurveyed: 0,
      unitsRetail: 0,
      unitsAvailable: 0, unitsMatched: 0, unitsMerged: 0, buildingsSurveyed: 0, corners: 0,
      fixtures: 0, doors: 0, noDoor: 0,
      // Storey model: how many buildings took their floor-to-floor from the surveyed level
      // count, and how many had to fall back because the count implied an impossible storey.
      levelsFromData: 0, levelsDerived: 0, levelsRejected: 0, roofForms: 0,
      // Signage, from text.js: fascia name runs and the glyphs in them, how many had to shrink
      // or ellipsise to fit the board, the house numbers, and the street blades.
      textRuns: 0, textGlyphs: 0, textShrunk: 0, textEllipsised: 0, textNumbers: 0,
      textBlades: 0,
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
      metres: 0, largest: 0, fraction: 0, fractionDry: 0, components: 0, islands: 0,
      islandMetres: 0, marineIslands: 0, marineMetres: 0, landCells: 0,
      worstIslands: [], worstCliffs: [], cliffs: 0, cliffWorst: 0, samples: 0,
      stitched: 0, stitchMetres: 0, steps: 0, flights: 0, blockedMetres: 0, severedMetres: 0,
      groundHoles: 0, groundMin: 0, groundMax: 0, subNetMetres: 0, subComponents: 0,
    },
    // DANGLING ENDS (CONTRACT §9.1). `danglingBefore` counts every welded way-end inside the map
    // that is neither a junction nor a door; `danglingAfter` must be zero, and everything in
    // between says how each one was resolved.
    edge: {
      termini: 0, terminiAfter: 0, danglingBefore: 0, danglingAfter: 0,
      atBuilding: 0, atBoundary: 0, welded: 0, connected: 0, spliced: 0, subwayEnds: 0,
      capped: 0, culDeSacs: 0, barriers: 0, bufferStops: 0, crossings: 0,
      culBuilt: 0, barriersBuilt: 0, buffersBuilt: 0, ms: 0,
    },
    // THE SYNTHESISED SURROUND (CONTRACT §9.3).
    surround: {
      spokes: 0, waterSpokes: 0, rings: 0, streets: 0, streetMetres: 0, blocks: 0, masses: 0,
      registered: 0, tiles: 0, verts: 0, apronVerts: 0, ms: 0, fringe: 0, reach: 0,
      bankCells: 0, bankMetres: 0,
      pitch: [], height: [], softX: 0, softZ: 0, softEase: 0, edgeX: 0, edgeZ: 0,
    },
    // THE HORIZON PROOF (CONTRACT §9.4). Every ray from the soft limit to the edge of the drawn
    // world, at every altitude and every time preset, measured against render.js's own fog.
    horizon: {
      rays: 0, fails: 0, worst: 1, worstAt: null, minEdgeDistance: 0, pass: 0,
      worldX: [0, 0], worldZ: [0, 0],
    },
    propsInFootprint: 0, propsOnRoad: 0,
    // Luminaires currently registered with the renderer's clustered local-light rig. Grows as
    // detail tiles stream in; see noteLight() and flushLights().
    lights: 0,
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
      inFootprint: 0, onCarriageway: 0, sunk: 0, worstSunk: 0, worstSunkAt: null,
    },
  };
}

/**
 * A wall clock over the named phases of a load.
 *
 * The loader calls `at(name)` after each phase; the time since the previous call is added to
 * `stats.phaseMs[name]`. `skip()` restarts the clock without attributing anything, which is what
 * a cooperative yield wants — the frame the browser took back is not the phase's cost. Entries
 * accumulate, so a phase that runs in several pieces (or once per tile) totals correctly.
 *
 * This is a MEASUREMENT, not a control: nothing in the tree branches on it, and the whole map is
 * excluded from tools/fingerprint.mjs by the `Ms` suffix rule.
 */
function makePhaseTimer(stats, clock) {
  const now = typeof clock === 'function' ? clock : () => Date.now();
  const into = stats.phaseMs;
  let last = now();
  return {
    at(name) {
      const t = now();
      into[name] = (into[name] || 0) + (t - last);
      last = t;
    },
    skip() { last = now(); },
    /** Attribute an externally measured span, for a phase that times itself. */
    add(name, ms) { into[name] = (into[name] || 0) + ms; },
  };
}

export { makeCityStats, makePhaseTimer };
