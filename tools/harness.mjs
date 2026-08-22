// tools/harness.mjs — headless verification harness for src/city.js.
//
//   node tools/harness.mjs            full report
//   node tools/harness.mjs --quiet    summary only
//
// Runs the real loadCity() against the real data/toronto.json with a stub WebGL2 context that
// captures every uploaded vertex buffer, then audits the geometry: per-mesh vertex counts, NaN,
// unit normals, the profile-0 emissive rule, prop centres against building footprints, marking
// height above the asphalt, and the invariants that must never regress (nothing skipped, landmark
// heights, the CN Tower tip, the street-grid rotation).
//
// EXPECTATIONS ARE DERIVED, NOT TYPED IN. This file went stale twice — once when the map grew to
// 43 km2 and again at Old Toronto — because it asserted absolute counts ("4,654 buildings",
// "7,926 road ways", "75 building passages", "2,500-4,000 people") that are properties of the
// EXTENT, not of the code. Every such expectation now comes out of the extract or out of the
// city object itself: conservation ("built + skipped == the records in the file"), densities
// (passages per thousand ways, people per kilometre of walkable route, vertices per km2) and
// positions read from city.cnTower rather than from a remembered coordinate. What stays a
// literal is only what is genuinely absolute: a surveyed height, a rotation in degrees, and the
// zero-tolerance rules — no NaN, no inward facades, no route running off the side of a wall.
//
// Zero dependencies, like everything else here.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');

/* ------------------------------------------------------------------ stubs -- */

globalThis.requestAnimationFrame = (fn) => setImmediate(() => fn(0));
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
}

globalThis.fetch = async (url) => {
  const path = resolve(ROOT, String(url).replace(/^\.\//, ''));
  const buf = readFileSync(path);
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    body: null,
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
};

// Stub WebGL2: every Mesh upload lands in `uploads`, in creation order.
const uploads = [];
let nextId = 1;
const glStub = new Proxy({
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  FLOAT: 0x1406,
  createVertexArray: () => ({ id: nextId++ }),
  createBuffer: () => ({ id: nextId++ }),
  bindVertexArray: () => {},
  bindBuffer: () => {},
  // COPY. Real gl.bufferData copies immediately; the tile builder recycles one MeshBuilder per
  // material class across every tile, so holding the subarray would alias the next tile's data.
  bufferData: (_t, data) => {
    uploads.push(data instanceof Float32Array ? new Float32Array(data) : new Float32Array(0));
  },
  enableVertexAttribArray: () => {},
  vertexAttribPointer: () => {},
  deleteVertexArray: () => {},
  deleteBuffer: () => {},
}, {
  get(t, k) { return k in t ? t[k] : (() => {}); },
});

/* ------------------------------------------------------------------ audit -- */

const { VERT_FLOATS: VF } = await import(resolve(ROOT, 'src/core/vertex.js'));

function auditMesh(name, data) {
  const n = (data.length / VF) | 0;
  const out = {
    name, verts: n, tris: (n / 3) | 0, nan: 0, badNormal: 0, badEmissive: 0,
    tinted: 0, minY: Infinity, maxY: -Infinity, emitters: 0,
  };
  for (let i = 0; i < data.length; i += VF) {
    for (let k = 0; k < VF; k++) if (!Number.isFinite(data[i + k])) { out.nan++; break; }
    const nx = data[i + 3], ny = data[i + 4], nz = data[i + 5];
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(Math.abs(l - 1) < 1e-3)) out.badNormal++;
    const e = data[i + 9], pf = data[i + 12];
    if (pf === 0 && e > 1e-6 && e < 0.5) out.badEmissive++;
    if (e >= 0.5) out.emitters++;
    if (data[i + 10] !== 0) out.tinted++;
    const y = data[i + 1];
    if (y < out.minY) out.minY = y;
    if (y > out.maxY) out.maxY = y;
  }
  if (!n) { out.minY = 0; out.maxY = 0; }
  return out;
}

function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : '0%'; }
function fmt(n) { return n.toLocaleString('en-US'); }

/* -------------------------------------------------------------------- run -- */

const { loadCity } = await import(resolve(ROOT, 'src/city.js'));

const t0 = Date.now();
let lastLabel = '';
const labels = [];
const city = await loadCity(glStub, './data/toronto.json', (f, label) => {
  if (label && label !== lastLabel) { lastLabel = label; labels.push(label); }
});
// loadCity() hands the two whole-world verification sweeps (CONTRACT §8.2's marine components and
// its groundY hole test) to a chore queue the frame loop drains a few milliseconds at a time.
// Nothing here draws a frame, so drain it in one go before reading any of its counters.
city.settle();
const wallMs = Date.now() - t0;

// The city is TILED: loadCity() emits only the lake, and every other vertex is built on demand
// by tiles.js. Build the whole map, every stage of every tile, so the audit sees the same
// geometry a player would eventually see — and release each tile as it is measured, so the
// harness does not have to hold 23 M vertices at once.
const perClass = new Map();
const feed = (name, data) => {
  let a = perClass.get(name);
  if (!a) { a = []; perClass.set(name, a); }
  a.push(data);
};
feed('water', uploads[0] || new Float32Array(0));
{
  const tiles = city.tiles;
  for (const t of tiles.grid.tiles) {
    for (let s = 0; s < t.st.length; s++) {
      if (t.st[s].state !== 0) continue;
      const before = uploads.length;
      const job = tiles._startJob(t, s);
      if (!job) continue;
      tiles._job = job;
      for (let g = 0; g < 500000; g++) if (job.it.next().done) break;
      tiles._finishJob(job);
      tiles._job = null;
      const created = Object.keys(t.st[s].meshes);
      for (let i = 0; i < created.length; i++) feed(created[i], uploads[before + i]);
      tiles._release(t, s);
      uploads.length = before;
    }
  }
}
const names = [...perClass.keys()];
const audits = [];
let total = 0;
for (let i = 0; i < names.length; i++) {
  const parts = perClass.get(names[i]);
  let n = 0;
  for (const p of parts) n += p ? p.length : 0;
  const merged = new Float32Array(n);
  let o = 0;
  for (const p of parts) { if (p) { merged.set(p, o); o += p.length; } }
  const a = auditMesh(names[i], merged);
  audits.push(a);
  total += a.verts;
}
perClass.clear();

const S = city.stats;
const P = S.props || {};

/* --------------------------------------------------- what the survey holds -- */

// The extract, read a second time through the SAME decoder the loader used, so every count below
// is what the file actually offered rather than what somebody remembered it offering. It is the
// only honest reference for "did the build keep everything?", and it costs a fraction of a second
// next to the build itself.
const { fetchCity } = await import(resolve(ROOT, 'src/data/load.js'));
const extract = (await fetchCity('./data/toronto.json', () => {})).data;
const DATA = {
  buildings: (extract.buildings || []).length,
  roads: (extract.roads || []).length,
  rails: (extract.rails || []).length,
  km2: ((city.extent && city.extent.x) || 0) * ((city.extent && city.extent.z) || 0) / 1e6,
};

/* ------------------------------------------------------- invariant checks -- */

const fails = [];
const warns = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const soft = (ok, msg) => { if (!ok) warns.push(msg); };

// CONSERVATION, not a count. Every massing record in the extract is either built or explicitly
// skipped; a record that quietly evaporates is the failure this is here to catch, and it stays
// true at any extent.
check(S.buildings + S.ringsSkipped === DATA.buildings,
  'building records lost: ' + fmt(S.buildings) + ' built + ' + fmt(S.ringsSkipped) +
  ' skipped != ' + fmt(DATA.buildings) + ' in the extract');
check(DATA.buildings > 0 && S.ringsSkipped / DATA.buildings < 0.05,
  fmt(S.ringsSkipped) + ' massing records skipped, ' + pct(S.ringsSkipped, DATA.buildings) +
  ' of the extract — over 5% means the footprint preparation is rejecting real buildings');
check(audits.every((a) => a.nan === 0), 'NaN in ' + audits.filter((a) => a.nan).map((a) => a.name).join(','));
check(audits.every((a) => a.badNormal === 0),
  'non-unit normals in ' + audits.filter((a) => a.badNormal).map((a) => a.name + ':' + a.badNormal).join(','));
check(audits.every((a) => a.badEmissive === 0),
  'profile-0 emissive in (0, 0.5) on ' + audits.filter((a) => a.badEmissive).map((a) => a.name + ':' + a.badEmissive).join(','));
check(audits.every((a) => a.tinted === 0), 'tintable != 0 on static city geometry');
// The budget that matters is now RESIDENT vertices, not total vertices: the city is tiled and
// streamed, so `total` above is every vertex the whole 43 km2 map can produce and no frame ever
// holds more than tiles.js's cap. The cap is what has to hold.
check(S.vertexCap > 0 && S.vertexCap <= 12_000_000,
  'resident vertex cap is ' + fmt(S.vertexCap || 0) + ', expected <= 12M');
// ...and the whole-map total is a DENSITY too: it is every vertex 43 km2 of survey can produce,
// and it grows with the survey. Per km2 it does not, and per km2 is what says whether the detail
// level has quietly crept up.
soft(DATA.km2 > 0 && total / DATA.km2 <= 1_000_000,
  'whole-map geometry is ' + fmt(total) + ' vertices over ' + DATA.km2.toFixed(1) + ' km2 = ' +
  fmt(Math.round(total / Math.max(1e-6, DATA.km2))) + ' per km2');

// The CN Tower tip and the tallest landmarks must be untouched.
//
// The tower's PLACE is not an invariant — it is a local coordinate, and every extent change moves
// the origin under it. This used to sample the ground at a remembered (114.2, 159.0) with a
// +/-12 m tolerance wide enough to hide which building it had actually landed on, and it went
// wrong the moment the bbox centre moved. city.cnTower is the position the builder itself used
// and the renderer's uCnTower reads, so ask it: [x, z, baseY, radius]. What IS an invariant is
// CN_TIP, the surveyed mast height above the tower's own base slab, and that the tip is the
// highest thing in the world — so the check is exact, to the centimetre, rather than to 12 m.
const CN_TIP = 553.33;                                     // surveyed, and landmarks.js's profile
const maxY = Math.max(...audits.map((a) => a.maxY));
const cnTipY = (city.cnTower ? city.cnTower[2] : 0) + CN_TIP;
check(Math.abs(maxY - cnTipY) < 0.05,
  'CN Tower tip moved: max scene Y = ' + maxY.toFixed(2) + ', the mast tip stands at ' +
  cnTipY.toFixed(2) + ' (base ' + (city.cnTower ? city.cnTower[2].toFixed(2) : '?') + ' + ' +
  CN_TIP + ')');

const LM = S.landmarkHeights || {};
const EXPECT = { td: 223, rbp: 180, fcp: 292, scotia: 275, ccw: 239, cn: 443 };
for (const k of Object.keys(EXPECT)) {
  if (!(k in LM)) { warns.push('landmark ' + k + ' not matched'); continue; }
  soft(Math.abs(LM[k] - EXPECT[k]) / EXPECT[k] < 0.05,
    'landmark ' + k + ' height ' + LM[k].toFixed(1) + ' m, expected ~' + EXPECT[k]);
}

check(Math.abs((S.gridDeg || 0) - 17.5) < 1.5,
  'street grid rotation is ' + (S.gridDeg || 0).toFixed(2) + ' deg, expected 17.5 +/- 1.5');

check((S.propsInFootprint | 0) === 0, (S.propsInFootprint | 0) + ' prop centres inside a building footprint');
check((S.propsOnRoad | 0) === 0, (S.propsOnRoad | 0) + ' props on a carriageway');
check((S.markingsBelowRoad | 0) === 0, (S.markingsBelowRoad | 0) + ' markings at or below the asphalt');
check(S.markLiftMin > 0.002 && S.markLiftMax < 0.10,
  'marking lift band is ' + S.markLiftMin.toFixed(4) + '..' + S.markLiftMax.toFixed(4) + ' m');
check((S.facadesFacingIn | 0) === 0, (S.facadesFacingIn | 0) + ' facades facing into their own footprint');
check((S.boomsMisaimed | 0) === 0, (S.boomsMisaimed | 0) + ' lamp booms aimed away from the road');
check((S.wireOffTrack | 0) === 0, (S.wireOffTrack | 0) + ' catenary brackets not aimed at the track');

// COPLANAR GEOMETRY. Two surfaces on one plane facing one way is the half of the daytime flicker
// that no depth precision can fix, so what matters is not how many were found but how many are
// left. Both must be zero, and the two minimum separations must clear their thresholds.
const CP = S.coplanar || {};
check((CP.wallPairsLeft | 0) === 0, (CP.wallPairsLeft | 0) + ' coplanar wall pairs left unresolved');
check((CP.capPairsLeft | 0) === 0, (CP.capPairsLeft | 0) + ' coplanar roof cap pairs left unresolved');
check(CP.wallPairs > 0, 'coplanar detector found nothing at all: it is not running');
check(CP.facadeProudMin >= 0.030,
  'facade detail sits ' + (CP.facadeProudMin || 0).toFixed(4) + ' m off the wall, needs >= 0.030');
check(CP.groundRungMin >= 0.030,
  'ground-cover rungs are ' + (CP.groundRungMin || 0).toFixed(4) + ' m apart, needs >= 0.030');
check(CP.groundRungMinMicro >= 0.012,
  'carriageway layers are ' + (CP.groundRungMinMicro || 0).toFixed(4) + ' m apart, needs >= 0.012');

// ELEVATED DECKS. The Gardiner runs over surface streets; nothing standing on those streets may
// reach through its soffit, and the expressway itself must be lit from its own deck.
const DK = S.deck || {};
check((DK.propsThroughDeck | 0) === 0,
  (DK.propsThroughDeck | 0) + ' props intersecting an elevated deck');
check((DK.segments | 0) > 0, 'no elevated deck segments indexed: the deck test is not running');
check((DK.deckLamps | 0) > 0, 'no lamps on the elevated carriageways');

// GRADE SEPARATION (CONTRACT 8.1). Nothing may be skipped, the signed layer decides who passes
// above, and the clearance under a crossing is measured, not assumed.
const GR = S.grade || {};
check(S.roads === DATA.roads,
  'road ways built is ' + fmt(S.roads) + ' of the ' + fmt(DATA.roads) +
  ' in the extract — nothing may be skipped');
check((GR.under | 0) >= 40, 'only ' + (GR.under | 0) + ' depressed corridors: layer < 0 is not being built');
check((GR.sub | 0) >= 700,
  'only ' + (GR.sub | 0) + ' underground concourse ways built: the layer < 0 concourse is missing');
// Passages are ARCADES — a rare feature of a dense street network, so what holds across extents is
// their rate, not their number. Downtown alone gave 9.5 per thousand ways; the whole pre-1998 city
// gives 6.4, because the Victorian fabric outside the core has fewer of them per street. A rate
// outside this band means the passage classifier has either stopped running or gone greedy.
const passPerK = (GR.passage | 0) / Math.max(1, DATA.roads / 1000);
check(passPerK >= 2 && passPerK <= 20,
  (GR.passage | 0) + ' building passages over ' + fmt(DATA.roads) + ' ways = ' +
  passPerK.toFixed(1) + ' per thousand, wanted 2-20');
check((GR.crossings | 0) > 3000, 'crossing detection found only ' + (GR.crossings | 0) + ' crossings');
// ...and the last absolute count in this file that was really a property of the extent. A
// headroom violation is a residue of crossing resolution, so it scales with the number of
// crossings — 2 in 7,505 downtown is 0.27 per thousand, and the same correct resolver over 9.8x
// the network would have tripped a flat "<= 8". It is a DEFECT rate, so the band is tight: a
// quarter of a percent of crossings, and never fewer than the two the resolver cannot currently
// win at any extent.
const violCap = Math.max(2, Math.round((GR.crossings | 0) * 0.0025));
check((GR.violations | 0) <= violCap,
  (GR.violations | 0) + ' of ' + fmt(GR.crossings | 0) + ' crossings still short of 4.5 m ' +
  'headroom, over the ' + violCap + ' allowed (0.25% of crossings)');
check(GR.deepest > 4.5 && GR.deepest < 8,
  'deepest carriageway cut is ' + (GR.deepest || 0).toFixed(2) + ' m, wanted 4.5-8');
check((GR.portals | 0) > 0 && (GR.railDecks | 0) > 0,
  'no portals (' + (GR.portals | 0) + ') or rail decks (' + (GR.railDecks | 0) + ') built');

// WALKABILITY (CONTRACT 8.2) — an acceptance test, not an aspiration.
const WK = S.walk || {};
// MEASURED OVER WHAT A WALKER CAN REACH ON FOOT. Some of Toronto is genuinely on the far side of
// open water: the Toronto Islands carry 44 km of path and Billy Bishop another 2 km, and you get
// to both by ferry. Counting them as unreachable fragments of the street network measures Lake
// Ontario, not the city, and a flat threshold over everything therefore fails for being right
// about the geography — which is how this check came to read 94.55% and mean nothing.
//
// walk.js already separates the two, by flooding the terrain from the main network and asking
// which components no dry path reaches: `fractionDry` is the acceptance test, over land you can
// walk to, and `fraction` over the lot is kept as an eyeball. The check that the split is honest
// is that the flood ran at all and that the two agree in the only direction they can.
check((WK.landCells | 0) > 0, 'the marine/land flood did not run: every island counts as dry');
check(WK.fractionDry >= WK.fraction - 1e-9,
  'fractionDry ' + (WK.fractionDry || 0).toFixed(4) + ' is below fraction ' +
  (WK.fraction || 0).toFixed(4) + ': the marine split is inverted');
check(WK.fractionDry >= 0.97,
  'largest walkable component holds ' + ((WK.fractionDry || 0) * 100).toFixed(2) + '% of the ' +
  Math.round((WK.metres || 0) - (WK.marineMetres || 0)) + ' m reachable on foot, needs >= 97%');
soft(WK.fraction >= 0.90,
  'including the ' + Math.round(WK.marineMetres || 0) + ' m only a ferry reaches, the largest ' +
  'component holds ' + ((WK.fraction || 0) * 100).toFixed(2) + '%');
check((WK.cliffs | 0) === 0,
  (WK.cliffs | 0) + ' walkable cliffs over 0.45 m with no ramp or step: ' +
  (WK.worstCliffs || []).map((c) => c.m + ' m at (' + c.x + ', ' + c.z + ')').join('; '));
check((WK.groundHoles | 0) === 0, (WK.groundHoles | 0) + ' points where groundY is not finite');
check(WK.groundMin > -60 && WK.groundMax < 400,
  'groundY ranges ' + (WK.groundMin || 0).toFixed(1) + '..' + (WK.groundMax || 0).toFixed(1) + ' m');
check((WK.samples | 0) > 50000, 'the cliff audit only took ' + (WK.samples | 0) + ' samples');
// ...and the islands, likewise, only the ones a walker should have been able to reach. Their
// number scales with the extent; what does not is how much of the walkable network they hold.
const dryIslandM = Math.max(0, (WK.islandMetres || 0) - (WK.marineMetres || 0));
soft(dryIslandM <= 0.01 * Math.max(1, WK.metres || 0),
  ((WK.islands | 0) - (WK.marineIslands | 0)) + ' dry walkable islands over 50 m holding ' +
  Math.round(dryIslandM) + ' m, ' + pct(dryIslandM, WK.metres || 0) + ' of the network');

// PEOPLE.
const PE = S.people || {};
check((PE.inFootprint | 0) === 0, (PE.inFootprint | 0) + ' people inside a building footprint');
check((PE.onCarriageway | 0) === 0, (PE.onCarriageway | 0) + ' people on a carriageway');
check((PE.sunk | 0) === 0, (PE.sunk | 0) + ' people sunk into or floating over the ground');
// A CROWD IS A DENSITY. The population is placed along the walking surface, so it scales with the
// walking surface and an absolute band goes stale with the extent — as "2,500-4,000" did. What
// must hold is that the streets are neither empty nor a mob.
const perKmWalk = (PE.total | 0) / Math.max(1e-6, (WK.metres || 0) / 1000);
check(perKmWalk >= 3 && perKmWalk <= 25,
  'population is ' + fmt(PE.total || 0) + ' over ' + fmt(Math.round((WK.metres || 0) / 1000)) +
  ' km of walkable route = ' + perKmWalk.toFixed(1) + ' per km, wanted 3-25');
check((PE.cyclists | 0) > 0 && (PE.groups | 0) > 0 && (PE.sitting | 0) > 0,
  'the crowd is missing a kind: ' + PE.cyclists + ' cyclists, ' + PE.groups + ' groups, ' +
  PE.sitting + ' seated');
// ...and that it is WEIGHTED, not sprinkled. The old form — "over 9% of the crowd in the core" —
// was really a statement about how much of the map the core was, and 420 m around King and Bay
// is 8% of downtown but 1.3% of Old Toronto, so the same correct crowd fails it. The weighting
// itself shows in the spread between the busiest 100 m cell and the median one, which no change
// of extent touches, and the core simply has to be populated.
soft((PE.core | 0) > 0 && (PE.peakCell | 0) >= 3 * Math.max(1, PE.medianCell | 0),
  'the crowd is flat: peak cell ' + (PE.peakCell | 0) + ' against a median of ' +
  (PE.medianCell | 0) + ', ' + fmt(PE.core | 0) + ' in the Financial District core');

// Amendment 7: the CITY BUILDERS must contain no notion of time of day at all — the renderer owns
// WHEN a lamp is on. Detail may only ever mark WHAT is an emitter.
//
// city.js used to be the whole build, so scanning that one file covered it. It is now a loader
// over src/world/ and src/city/, so the scan walks those directories too; anything less would let
// a time-of-day branch land in a builder unnoticed. src/render/ is deliberately NOT scanned — the
// renderer is exactly the thing that is allowed to know what time it is.
const timeScan = [resolve(ROOT, 'src/city.js')];
for (const dir of ['src/world', 'src/city']) {
  for (const name of readdirSync(resolve(ROOT, dir))) {
    if (name.endsWith('.js')) timeScan.push(resolve(ROOT, dir, name));
  }
}
for (const path of timeScan) {
  const srcText = readFileSync(path, 'utf8');
  const rel = relative(ROOT, path);
  for (const word of ['daylight', 'nightFactor', 'TIME_PRESET', 'applyTime']) {
    check(srcText.indexOf(word) < 0, rel + ' references ' + word + ': detail must be time-agnostic');
  }
}

// Every emitter in the scene, so it can be eyeballed against "is this a real light source?".
const emitters = new Map();
for (let i = 0; i < names.length; i++) {
  const data = uploads[i] || new Float32Array(0);
  for (let k = 0; k < data.length; k += VF) {
    const e = data[k + 9];
    if (e < 0.5) continue;
    const key = names[i] + ' e=' + e.toFixed(2) + ' rgb=' +
      data[k + 6].toFixed(2) + ',' + data[k + 7].toFixed(2) + ',' + data[k + 8].toFixed(2);
    emitters.set(key, (emitters.get(key) || 0) + 1);
  }
}

/* ----------------------------------------------------------------- report -- */

if (!QUIET) {
  console.log('\n=== city.js harness =======================================================');
  console.log('generation: ' + S.seconds.toFixed(2) + ' s reported, ' + (wallMs / 1000).toFixed(2) + ' s wall');
  console.log('stages: ' + labels.length + '  (' + labels.slice(0, 6).join(' -> ') + ' ...)');
  console.log('\n--- meshes ---------------------------------------------------------------');
  console.log('  mesh          verts        tris     emitters   share');
  for (const a of audits) {
    console.log('  ' + a.name.padEnd(12) + fmt(a.verts).padStart(10) + fmt(a.tris).padStart(12) +
      fmt(a.emitters).padStart(12) + pct(a.verts, total).padStart(9));
  }
  console.log('  ' + 'TOTAL'.padEnd(12) + fmt(total).padStart(10) + fmt((total / 3) | 0).padStart(12) +
    ''.padStart(12) +
    (fmt(Math.round(total / Math.max(1e-6, DATA.km2))) + '/km2').padStart(16));

  console.log('\n--- city -----------------------------------------------------------------');
  console.log('  extent ' + DATA.km2.toFixed(1) + ' km2, and the extract offered ' +
    fmt(DATA.buildings) + ' massing records / ' + fmt(DATA.roads) + ' road ways / ' +
    fmt(DATA.rails) + ' rail ways');
  console.log('  buildings ' + fmt(S.buildings) + ' (+' + fmt(S.ringsSkipped) + ' skipped)' +
    ' / rings ' + fmt(S.rings) + ' / road ways ' + fmt(S.roads) +
    ' / cap failures ' + S.capFail);
  console.log('  surveyed facade colours ' + S.surveyedColour +
    ' / profiles [env,off,res,ret,park,civ] ' + JSON.stringify(S.profiles));
  console.log('  street grid ' + (S.gridDeg || 0).toFixed(2) + ' deg');
  console.log('  landmark heights ' + JSON.stringify(LM));
  console.log('  marking lift above the ribbon: ' + S.markLiftMin.toFixed(4) + ' .. ' +
    S.markLiftMax.toFixed(4) + ' m   catenary bracket aim error max ' +
    (S.wireMaxError || 0).toFixed(5) + ' m');

  console.log('\n--- ground plane ---------------------------------------------------------');
  const G = S.ground || {};
  for (const k of Object.keys(G)) console.log('  ' + k.padEnd(24) + String(G[k]).padStart(12));

  console.log('\n--- props placed ---------------------------------------------------------');
  const keys = Object.keys(P).sort();
  let col = 0;
  let line = '  ';
  let propTotal = 0;
  for (const k of keys) {
    propTotal += P[k];
    line += (k + ' ' + fmt(P[k])).padEnd(26);
    if (++col % 3 === 0) { console.log(line); line = '  '; }
  }
  if (line.trim()) console.log(line);
  console.log('  ' + ('TOTAL PROPS ' + fmt(propTotal)));

  console.log('\n--- emitters (profile 0, emissive >= 0.50: real light sources only) -------');
  const elist = [...emitters.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of elist) console.log('  ' + k.padEnd(46) + fmt(v).padStart(9) + ' verts');

  console.log('\n--- coplanar faces -------------------------------------------------------');
  console.log('  wall faces ' + fmt(CP.wallFaces || 0) + ', duplicated pairs found ' +
    fmt(CP.wallPairs || 0) + ' over ' + fmt(Math.round(CP.wallMetres || 0)) + ' m');
  console.log('  resolved: ' + fmt(CP.wallFacesDropped || 0) + ' wall faces suppressed, ' +
    fmt(CP.wallFacesClipped || 0) + ' clipped, ' + fmt(CP.capsBuried || 0) +
    ' roof caps deleted, ' + fmt(CP.capsStepped || 0) + ' stepped down, ' +
    fmt(CP.buriedRecords || 0) + ' whole records dropped');
  console.log('  LEFT: ' + (CP.wallPairsLeft | 0) + ' wall + ' + (CP.capPairsLeft | 0) + ' cap');
  console.log('  minimum separations: ground cover ' + (CP.groundRungMin || 0).toFixed(3) +
    ' m, carriageway layers ' + (CP.groundRungMinMicro || 0).toFixed(3) +
    ' m, facade detail ' + (CP.facadeProudMin || 0).toFixed(3) + ' m proud of the wall (' +
    fmt(CP.facadeFaces || 0) + ' faces, ' + fmt(CP.facadeClamped || 0) + ' clamped)');

  console.log('\n--- elevated decks -------------------------------------------------------');
  console.log('  ' + fmt(DK.segments || 0) + ' deck segments indexed, lowest soffit clearance ' +
    (DK.minClearance || 0).toFixed(2) + ' m');
  console.log('  ' + fmt(DK.deckLamps || 0) + ' lamps on the deck carriageway, ' +
    fmt(DK.propsShortened || 0) + ' props shortened to fit under one, ' +
    fmt(DK.propsSkipped || 0) + ' refused');
  console.log('  props still intersecting a deck: ' + (DK.propsThroughDeck | 0));

  console.log('\n--- grade separation -----------------------------------------------------');
  console.log('  ' + (GR.under | 0) + ' depressed corridors, ' + Math.round(GR.cutMetres || 0) +
    ' m open cut / ' + Math.round(GR.roofedMetres || 0) + ' m lidded, deepest ' +
    (GR.deepest || 0).toFixed(2) + ' m, ' + Math.round(GR.wallMetres || 0) + ' m of retaining wall');
  console.log('  ' + (GR.sub | 0) + ' underground concourse ways (' +
    Math.round(GR.subMetres || 0) + ' m), ' + (GR.over | 0) + ' carried over (' +
    (GR.abutments | 0) + ' abutments), ' + (GR.passage | 0) + ' building passages (' +
    (GR.passagePortals | 0) + ' portals)');
  console.log('  ' + (GR.crossings | 0) + ' real polyline crossings resolved, ' +
    (GR.violations | 0) + ' short of headroom; ' + (GR.railDecks | 0) + ' rail decks over ' +
    Math.round(GR.railDeckMetres || 0) + ' m; ' + (GR.portals | 0) + ' portals');

  console.log('\n--- walkability ----------------------------------------------------------');
  console.log('  ' + ((WK.fractionDry || 0) * 100).toFixed(2) + '% of the ' +
    fmt(Math.round((WK.metres || 0) - (WK.marineMetres || 0))) + ' m reachable ON FOOT is in the ' +
    'largest of ' + (WK.components | 0) + ' components');
  console.log('  ' + ((WK.fraction || 0) * 100).toFixed(2) + '% of all ' +
    fmt(Math.round(WK.metres || 0)) + ' walkable m, the difference being the ' +
    fmt(Math.round(WK.marineMetres || 0)) + ' m on ' + (WK.marineIslands | 0) +
    ' components only a ferry reaches');
  console.log('  ' + (WK.islands | 0) + ' islands over 50 m holding ' +
    fmt(Math.round(WK.islandMetres || 0)) + ' m:');
  for (const i of WK.worstIslands || []) {
    console.log('      ' + String(i.m).padStart(5) + ' m at (' + i.x + ', ' + i.z + ')' +
      (i.name ? '  ' + i.name : '') + (i.marine ? '  [ferry only]' : ''));
  }
  console.log('  cliffs left ' + (WK.cliffs | 0) + ' over ' + fmt(WK.samples | 0) +
    ' samples; ' + (WK.flights | 0) + ' flights of steps built, ' + (WK.stitched | 0) +
    ' gaps stitched over ' + Math.round(WK.stitchMetres || 0) + ' m');
  console.log('  ' + Math.round(WK.blockedMetres || 0) + ' m runs through a building, ' +
    Math.round(WK.severedMetres || 0) + ' m severed by a wall');
  console.log('  groundY: ' + (WK.groundHoles | 0) + ' holes, range ' +
    (WK.groundMin || 0).toFixed(2) + ' .. ' + (WK.groundMax || 0).toFixed(2) + ' m');
  console.log('  underground concourse: ' + Math.round(WK.subNetMetres || 0) + ' m in ' +
    (WK.subComponents | 0) + ' components');

  console.log('\n--- people ---------------------------------------------------------------');
  console.log('  total ' + fmt(PE.total || 0) + '   walking ' + fmt(PE.walking || 0) +
    ' / standing ' + fmt(PE.standing || 0) + ' / seated ' + fmt(PE.sitting || 0));
  console.log('  ' + fmt(PE.groups || 0) + ' groups holding ' + fmt(PE.grouped || 0) +
    ' people, ' + fmt(PE.cyclists || 0) + ' cyclists, ' + fmt(PE.dogWalkers || 0) + ' dog walkers');
  console.log('  where: sidewalk ' + fmt(PE.onSidewalk || 0) + ', footway ' + fmt(PE.onFootway || 0) +
    ', plaza ' + fmt(PE.onPlaza || 0) + ', park ' + fmt(PE.inPark || 0) + ', stop ' +
    fmt(PE.atStop || 0) + ', crossing ' + fmt(PE.atCrossing || 0) + ', shopfront ' +
    fmt(PE.atShopfront || 0) + ', bike lane ' + fmt(PE.inBikeLane || 0));
  console.log('  distribution: ' + fmt(PE.core || 0) + ' in the Financial District core (' +
    pct(PE.core, PE.total) + ' of the crowd in 8% of the map), ' + fmt(PE.cells || 0) +
    ' populated 100 m cells, peak ' + (PE.peakCell | 0) + ', median ' + (PE.medianCell | 0));
  console.log('  audit: ' + (PE.inFootprint | 0) + ' in a footprint, ' + (PE.onCarriageway | 0) +
    ' on a carriageway, ' + (PE.sunk | 0) + ' sunk or floating');

  console.log('\n--- facades --------------------------------------------------------------');
  const F = S.facades || {};
  for (const k of Object.keys(F)) console.log('  ' + k.padEnd(24) + String(F[k]).padStart(12));
}

console.log('\n--- verification ---------------------------------------------------------');
if (!fails.length) console.log('  PASS  ' + fmt(total) + ' verts, 0 NaN, 0 bad normals, 0 profile-0 emissive violations');
for (const w of warns) console.log('  WARN  ' + w);
for (const f of fails) console.log('  FAIL  ' + f);
console.log('');

process.exit(fails.length ? 1 : 0);
