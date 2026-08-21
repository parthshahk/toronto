// tools/islands.mjs — verification harness for the south half of the map.
//
//   node tools/islands.mjs           full report
//   node tools/islands.mjs --quiet   the pass/fail lines only
//
// Runs the real loadCity() against the real data, builds every tile that touches the Toronto
// Islands and Billy Bishop, and audits what came out:
//
//   * island land area, and how much of it the geometry actually covers
//   * metres of beach, riprap and seawall, and that NO island shore is left as a raw edge
//   * that no island land sample sits below the lake plane, which is where water shows through
//   * tree, hedge, garden and cottage-roof counts
//   * that the airfield geometry lands on the surveyed aeroway centrelines rather than beside
//     them, and that the runway designators follow from the bearings
//   * that the island footpath network is connected and its bridges are decked above the water
//   * Amendment 7: every emissive vertex south of the harbour is a real light
//
// Zero dependencies, like everything else here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');

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

const uploads = [];
let nextId = 1;
const glStub = new Proxy({
  ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406,
  createVertexArray: () => ({ id: nextId++ }),
  createBuffer: () => ({ id: nextId++ }),
  bindVertexArray: () => {}, bindBuffer: () => {},
  bufferData: (_t, data) => {
    uploads.push(data instanceof Float32Array ? new Float32Array(data) : new Float32Array(0));
  },
  enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
  deleteBuffer: () => {}, deleteVertexArray: () => {}, drawArrays: () => {},
}, { get: (t, k) => (k in t ? t[k] : () => {}) });

const VF = 13;
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const say = (s) => { if (!QUIET) console.log(s); };
const fails = [];
const warns = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const soft = (ok, msg) => { if (!ok) warns.push(msg); };

/* -------------------------------------------------------------------- run -- */

const data = JSON.parse(readFileSync(resolve(ROOT, 'data/toronto.json'), 'utf8'));
const { loadCity } = await import(resolve(ROOT, 'src/city.js'));
const H = await import(resolve(ROOT, 'src/harbour.js'));

const t0 = Date.now();
const city = await loadCity(glStub, './data/toronto.json', () => {});
const loadMs = Date.now() - t0;
const S = city.stats;
const isle = S.isle;
check(!!isle, 'no island model was built');

const grid = city.tiles.grid;
const BOX = isle ? [-3000, -400, 3300, 3000] : null;

// Build every tile whose core cell touches the south half, keeping the vertices for the audit.
const kept = new Map();
let isleTiles = 0, isleVerts = 0, buildMs = 0, peakTile = 0, peakStage = '';
const sigs = new Map();
{
  const tb = Date.now();
  for (const t of grid.tiles) {
    if (!t.f || !t.f.isle) continue;
    isleTiles++;
    for (let s = 0; s < t.st.length; s++) {
      if (t.st[s].state !== 0) continue;
      const before = uploads.length;
      const job = city.tiles._startJob(t, s);
      if (!job) continue;
      city.tiles._job = job;
      for (let g = 0; g < 500000; g++) if (job.it.next().done) break;
      city.tiles._finishJob(job);
      city.tiles._job = null;
      const created = Object.keys(t.st[s].meshes);
      let tileVerts = 0;
      let sig = 0x811c9dc5;
      for (let i = 0; i < created.length; i++) {
        const buf = uploads[before + i];
        if (!buf) continue;
        isleVerts += buf.length / VF;
        tileVerts += buf.length / VF;
        let a = kept.get(created[i]);
        if (!a) { a = []; kept.set(created[i], a); }
        a.push(buf);
        // A cheap order-sensitive digest of the tile's geometry, for the determinism pass below.
        for (let k = 0; k < buf.length; k++) {
          sig = Math.imul(sig ^ (Math.round(buf[k] * 4096) | 0), 0x01000193) >>> 0;
        }
      }
      sigs.set(t.id * 4 + s, sig);
      if (tileVerts > peakTile) {
        peakTile = tileVerts;
        peakStage = 'tile ' + t.i + ',' + t.j + ' stage ' + s;
      }
      city.tiles._release(t, s);
      uploads.length = before;
    }
  }
  buildMs = Date.now() - tb;
}

// CONTRACT 8.4. Build the same tiles again in the opposite order and compare the digests. If any
// hash were seeded on an array index, on a shared RNG stream or on a counter that survives a
// tile, the second pass would differ — which is exactly the failure tiling makes invisible until
// a player walks back the way they came.
let reordered = 0, drifted = 0;
{
  const order = grid.tiles.filter((t) => t.f && t.f.isle).reverse();
  for (const t of order) {
    for (let s = t.st.length - 1; s >= 0; s--) {
      if (t.st[s].state !== 0) continue;
      const before = uploads.length;
      const job = city.tiles._startJob(t, s);
      if (!job) continue;
      city.tiles._job = job;
      for (let g = 0; g < 500000; g++) if (job.it.next().done) break;
      city.tiles._finishJob(job);
      city.tiles._job = null;
      let sig = 0x811c9dc5;
      const created = Object.keys(t.st[s].meshes);
      for (let i = 0; i < created.length; i++) {
        const buf = uploads[before + i];
        if (!buf) continue;
        for (let k = 0; k < buf.length; k++) {
          sig = Math.imul(sig ^ (Math.round(buf[k] * 4096) | 0), 0x01000193) >>> 0;
        }
      }
      reordered++;
      if (sigs.get(t.id * 4 + s) !== sig) drifted++;
      city.tiles._release(t, s);
      uploads.length = before;
    }
  }
}

say('--- south half ------------------------------------------------------------');
say('  load ' + loadMs + ' ms   ' + isleTiles + ' island tiles built in ' + buildMs + ' ms   ' +
  fmt(Math.round(isleVerts)) + ' vertices');
say('  per tile: mean ' + fmt(Math.round(isleVerts / Math.max(1, isleTiles))) + ', peak ' +
  fmt(Math.round(peakTile)) + ' (' + peakStage + ')');
check(peakTile < 900000, 'the heaviest island tile is ' + fmt(Math.round(peakTile)) +
  ' vertices; the resident cap is 9 M across roughly thirty tiles');
say('  rebuilt ' + reordered + ' tile-stages in reverse order, ' + drifted +
  ' produced different geometry');
check(drifted === 0, drifted + ' island tile-stages are not build-order independent');

/* -------------------------------------------------------------- the islands -- */

const km2 = (m) => (m / 1e6).toFixed(3) + ' km2';
if (isle) {
  say('');
  say('--- islands ---------------------------------------------------------------');
  say('  ' + isle.islands + ' islands, ' + km2(isle.landArea) + ' of land, ' +
    fmt(Math.round(isle.shoreMetres)) + ' m of surveyed shore in ' + fmt(isle.stations) +
    ' stations');
  say('  edge treatment: ' + fmt(Math.round(isle.beachMetres)) + ' m beach, ' +
    fmt(Math.round(isle.ripMetres)) + ' m riprap, ' + fmt(Math.round(isle.wallMetres)) +
    ' m seawall');
  const treated = isle.beachMetres + isle.ripMetres + isle.wallMetres;
  check(Math.abs(treated - isle.shoreMetres) < 1.0,
    'shore metres unaccounted for: ' + Math.round(isle.shoreMetres - treated) + ' m');
  check(isle.islands >= 12, 'only ' + isle.islands + ' islands found, expected the whole chain');
  check(isle.landArea > 3.0e6, 'island land area is only ' + km2(isle.landArea));
}

/* --------------------------------------------------- land above the lake -- */
// Every island land sample must have a finite ground ABOVE the lake plane. Anywhere it does not,
// the lake is drawn straight through the island (emitWaterMesh keys on the ground dipping below
// the datum) and the player stands underwater on dry land.

const rings = [];
{
  const key = (p) => p[0].toFixed(2) + '|' + p[1].toFixed(2);
  const pool = data.shore.filter((w) => w.role === 'inner').map((w) => w.p.slice());
  const used = new Uint8Array(pool.length);
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let ch = pool[i], grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < pool.length; j++) {
        if (used[j]) continue;
        const q = pool[j];
        if (key(q[0]) === key(ch[ch.length - 1])) { ch = ch.concat(q.slice(1)); used[j] = 1; grew = true; }
        else if (key(q[q.length - 1]) === key(ch[0])) { ch = q.slice(0, -1).concat(ch); used[j] = 1; grew = true; }
        else if (key(q[q.length - 1]) === key(ch[ch.length - 1])) { ch = ch.concat(q.slice(0, -1).reverse()); used[j] = 1; grew = true; }
        else if (key(q[0]) === key(ch[0])) { ch = q.slice(1).reverse().concat(ch); used[j] = 1; grew = true; }
      }
    }
    if (ch.length > 3) rings.push(ch);
  }
}
const bboxOf = (p) => {
  let a = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of p) {
    if (q[0] < a[0]) a[0] = q[0];
    if (q[1] < a[1]) a[1] = q[1];
    if (q[0] > a[2]) a[2] = q[0];
    if (q[1] > a[3]) a[3] = q[1];
  }
  return a;
};
const ringBoxes = rings.map(bboxOf);
const inRing = (p, x, z) => {
  let hit = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > z) === (p[j][1] > z)) continue;
    const t = (z - p[i][1]) / (p[j][1] - p[i][1]);
    if (x < p[i][0] + (p[j][0] - p[i][0]) * t) hit = !hit;
  }
  return hit;
};
const onLand = (x, z) => {
  for (let i = 0; i < rings.length; i++) {
    const b = ringBoxes[i];
    if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
    if (inRing(rings[i], x, z)) return true;
  }
  return false;
};

{
  const STEP = 8;
  let land = 0, sunk = 0, nan = 0, worst = 0, worstAt = null;
  const box = bboxOf([].concat(...ringBoxes.map((b) => [[b[0], b[1]], [b[2], b[3]]])));
  for (let z = box[1]; z <= box[3]; z += STEP) {
    for (let x = box[0]; x <= box[2]; x += STEP) {
      if (!onLand(x, z)) continue;
      land++;
      const g = city.groundY(x, z);
      if (!Number.isFinite(g)) { nan++; continue; }
      if (g < 0.02) {
        sunk++;
        if (0.02 - g > worst) { worst = 0.02 - g; worstAt = [Math.round(x), Math.round(z)]; }
      }
    }
  }
  const area = land * STEP * STEP;
  say('');
  say('--- the ground under the islands -----------------------------------------');
  say('  ' + fmt(land) + ' land samples at ' + STEP + ' m (' + km2(area) + '), ' +
    sunk + ' below the lake plane, ' + nan + ' not finite');
  check(nan === 0, nan + ' island land samples have no finite ground');
  check(sunk / Math.max(1, land) < 0.004,
    fmt(sunk) + ' of ' + fmt(land) + ' island land samples sit below the lake plane (worst ' +
    worst.toFixed(2) + ' m at ' + (worstAt ? worstAt.join(', ') : '-') + ')');
}

/* ---------------------------------------------------- a geometry probe --- */
// A coarse hash of every ground-class vertex in the south half, so a check can ask "is there
// geometry here, spanning this height?" rather than trusting the emitter's own bookkeeping.

const GCELL = 4.0;
const gHash = new Map();
{
  for (const [name, parts] of kept) {
    if (name !== 'terrain' && name !== 'sidewalks' && name !== 'roads') continue;
    for (const buf of parts) {
      for (let i = 0; i < buf.length; i += VF) {
        const x = buf[i], y = buf[i + 1], z = buf[i + 2];
        const k = Math.floor(x / GCELL) + ',' + Math.floor(z / GCELL);
        let a = gHash.get(k);
        if (!a) { a = []; gHash.set(k, a); }
        a.push(x, y, z);
      }
    }
  }
}
function spans(x, z, lo, hi) {
  let low = false, high = false;
  const ci = Math.floor(x / GCELL), cj = Math.floor(z / GCELL);
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const arr = gHash.get((ci + a) + ',' + (cj + b));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const dx = arr[i] - x, dz = arr[i + 2] - z;
        if (dx * dx + dz * dz > 4.0) continue;
        if (arr[i + 1] <= lo + 0.30) low = true;
        if (arr[i + 1] >= hi - 0.30) high = true;
        if (low && high) return true;
      }
    }
  }
  return low && high;
}

/* ---------------------------------------------------------- the shore edge -- */
// No island shore may be a raw polygon edge. Across every station the surface has to be
// continuous: the mantle must meet the island ground on the land side, run down through the
// water line, and meet the lake bed on the water side, with no step at either join.

{
  const M = city.harbour && city.harbour.isle ? city.harbour.isle : null;
  let stations = 0, noGround = 0, inner = 0, mid = 0, outer = 0;
  let wIn = 0, wMid = 0, wOut = 0, atIn = null, atMid = null, atOut = null;
  if (M) {
    for (const run of M.runs) {
      for (let i = 0; i < run.n; i += 3) {
        stations++;
        const x = run.x[i], z = run.z[i], nx = run.nx[i], nz = run.nz[i];
        const at = (t) => city.groundY(x + nx * t, z + nz * t);
        const shore = at(0);
        if (!Number.isFinite(shore) || shore < 0.05) { noGround++; continue; }
        // The join to the island ground, sampled tight: 0.7 m either side of the cover edge, so
        // a natural slope reads as a slope and only a genuine discontinuity trips it.
        const a = at(-run.bw[i] - 0.35), b = at(-run.bw[i] + 0.35);
        const dIn = Math.abs(a - b);
        if (dIn > 0.45) { inner++; if (dIn > wIn) { wIn = dIn; atIn = [Math.round(x), Math.round(z)]; } }
        // Across the LAND side of the mantle, which is the part you stand on. Seaward of the
        // shore line the profile is designed to be steep — an island seawall is a vertical face
        // by definition, and the lake bed beyond it is carved at 0.9 m per metre on purpose —
        // so the test stops at the water's edge.
        let prev = null, dm = 0;
        for (let t = -run.bw[i] + 0.4; t <= 0; t += 1.0) {
          const g = at(t);
          if (!Number.isFinite(g)) { dm = 99; break; }
          if (prev !== null) dm = Math.max(dm, Math.abs(g - prev));
          prev = g;
        }
        if (dm > 0.85) { mid++; if (dm > wMid) { wMid = dm; atMid = [Math.round(x), Math.round(z)]; } }
        // The gap between the toe and the carved lake bed. Reported, not failed: it is a metre
        // or more under water, every mainland quay wall has the same gap at its foot, and the toe
        // skirt closes the mesh across it. What would be a bug is the gap with NO skirt.
        const c = at(run.fw[i] + run.tw[i]), d = at(run.fw[i] + run.tw[i] + 1.6);
        const dOut = Math.abs(c - d);
        if (dOut > 0.65) { outer++; if (dOut > wOut) { wOut = dOut; atOut = [Math.round(x), Math.round(z)]; } }
      }
    }
    const pc = (n) => (n / Math.max(1, stations) * 100).toFixed(1) + '%';
    say('');
    say('--- the island water line ------------------------------------------------');
    say('  ' + fmt(stations) + ' stations sampled at 18 m');
    say('    ' + noGround + ' with no surface at the water line');
    say('    ' + inner + ' (' + pc(inner) + ') step into the island ground over 0.45 m, worst ' +
      wIn.toFixed(2) + ' m' + (atIn ? ' at ' + atIn.join(', ') : ''));
    say('    ' + mid + ' (' + pc(mid) + ') step on the land side of the mantle over 0.85 m, worst ' +
      wMid.toFixed(2) + ' m' + (atMid ? ' at ' + atMid.join(', ') : ''));
    say('    ' + outer + ' (' + pc(outer) + ') have the toe standing over the carved bed, worst ' +
      wOut.toFixed(2) + ' m' + (atOut ? ' at ' + atOut.join(', ') : '') + ' — skirted, see below');
    say('    skirts emitted: ' + fmt((S.props || {}).bankSkirt || 0) + ' at the bank, ' +
      fmt((S.props || {}).toeSkirt || 0) + ' at the toe');
    check(noGround === 0, noGround + ' island shore stations have no surface at the water line');
    // Amendment 9.2 does not forbid a level change; it forbids a RAW one. Where the cover runs
    // out of room before the ground comes back up the mantle stands proud of it, and that face
    // has to be closed by real geometry — an earth bank. Tested against the vertices, not
    // assumed: for every station that steps, look for terrain-class geometry within two metres
    // that spans the drop.
    let unspanned = 0, spanTested = 0;
    for (const run of M.runs) {
      for (let i = 0; i < run.n; i += 3) {
        const x = run.x[i], z = run.z[i], nx = run.nx[i], nz = run.nz[i];
        const at = (t) => city.groundY(x + nx * t, z + nz * t);
        // Only the case that can actually be a hole: the mantle's own edge standing proud of the
        // ground beyond it. Where the ground is the higher of the two the mantle dives under it
        // and there is nothing to see.
        const hi = run.e[i] - 0.14, lo = at(-run.bw[i] - 0.35);
        if (!(hi - lo > 0.45)) continue;
        spanTested++;
        const px = x - nx * run.bw[i], pz = z - nz * run.bw[i];
        if (!spans(px, pz, lo, hi)) {
          unspanned++;
          if (!QUIET && unspanned <= 6) {
            say('      unspanned bank at (' + Math.round(x) + ', ' + Math.round(z) + ') edge (' +
              Math.round(px) + ', ' + Math.round(pz) + ')  ground ' + lo.toFixed(2) + ' -> ' +
              hi.toFixed(2) + '  bw ' + run.bw[i].toFixed(1) + '  e ' + run.e[i].toFixed(2) +
              '  te ' + run.te[i].toFixed(2));
          }
        }
      }
    }
    say('    of those, ' + unspanned + ' of ' + spanTested +
      ' are not closed by a bank face in the geometry');
    check(unspanned === 0, unspanned + ' island shore banks are a raw edge with no face on them');
    check(mid / Math.max(1, stations) < 0.03,
      pc(mid) + ' of island shore stations have a step on the land side (worst ' +
      wMid.toFixed(2) + ' m' + (atMid ? ' at ' + atMid.join(', ') : '') + ')');
    check(((S.props || {}).toeSkirt || 0) > outer * 0.9,
      'only ' + fmt((S.props || {}).toeSkirt || 0) + ' toe skirts for ' + fmt(outer * 3) +
      ' stations whose toe stands over the bed; the mesh is open under the water');
  } else {
    warns.push('harbour model not exposed; the water-line audit could not run');
  }
}

/* ------------------------------------------------------------- the airport -- */

{
  const R = 6378137.0, lon0 = -79.387, lat0 = 43.635;
  const merc = (lon, lat) => [R * (lon * Math.PI / 180),
    R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2))];
  const [ox, oy] = merc(lon0, lat0);
  const k = Math.cos(lat0 * Math.PI / 180);
  const xy = (lon, lat) => {
    const [mx, my] = merc(lon, lat);
    return [(mx - ox) * k, -(my - oy) * k];
  };
  // The aeroway ways, straight from the raw OSM extract, projected here independently of the
  // baked table in harbour.js. If the two disagree the airfield is not built on the survey.
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(resolve(ROOT, 'data/raw/osm_infra.json'), 'utf8'));
  } catch (e) { raw = null; }
  const A = city.harbour && city.harbour.isle ? city.harbour.isle.air : null;
  say('');
  say('--- Billy Bishop ---------------------------------------------------------');
  if (A) {
    const rw = A.ways.filter((w) => w.kind === 'runway');
    const tw = A.ways.filter((w) => w.kind === 'taxiway');
    say('  plane at ' + A.y.toFixed(2) + ' m, ' + rw.length + ' runways, ' + tw.length +
      ' taxiways, ' + A.aprons.length + ' aprons, ' + A.stands.length + ' stands, ' +
      A.holds.length + ' holding positions, ' + A.fence.length + ' fence runs');
    for (const r of A.runways) {
      say('    runway ' + r.ref + '  ' + r.len.toFixed(0) + ' m  thresholds ' +
        r.thresh.map((t) => t.label + ' at (' + t.x.toFixed(0) + ', ' + t.z.toFixed(0) + ')').join(' / '));
    }
    check(rw.length === 2, 'expected the two surveyed runways, found ' + rw.length);
    const r08 = A.runways.find((r) => r.ref === '08/26');
    check(!!r08 && Math.abs(r08.len - 1215) < 12,
      'runway 08/26 is ' + (r08 ? r08.len.toFixed(0) : '?') + ' m, the survey says 1215');
    if (r08) {
      const west = r08.thresh.reduce((a, b) => (a.x < b.x ? a : b));
      check(west.label === '08', 'the west threshold of 08/26 is labelled ' + west.label +
        '; you land westbound on 26, so the west end must read 08');
    }
    if (raw) {
      let pts = 0, off = 0, worst = 0, worstAt = null;
      for (const e of raw.elements) {
        const t = e.tags || {};
        if (t.aeroway !== 'runway' && t.aeroway !== 'taxiway' && t.aeroway !== 'apron') continue;
        const g = e.geometry || [];
        for (const q of g) {
          const [x, z] = xy(q.lon, q.lat);
          if (x < -1600 || x > 100 || z < 40 || z > 1560) continue;
          pts++;
          // The point must be ON the pavement the emitter built, i.e. inside the airfield the
          // model reports. Half a metre of slack for the 0.1 m rounding in the baked table.
          const g2 = city.groundY(x, z);
          const paved = Math.abs(g2 - (A.y + 0.21)) < 0.6 || Math.abs(g2 - A.y) < 0.6;
          if (!paved) {
            off++;
            const d = Math.abs(g2 - A.y);
            if (d > worst) { worst = d; worstAt = [Math.round(x), Math.round(z)]; }
          }
        }
      }
      say('  ' + fmt(pts) + ' surveyed aeroway points checked against the built airfield, ' +
        off + ' not on it');
      check(off / Math.max(1, pts) < 0.02,
        off + ' of ' + pts + ' surveyed aeroway points are not on the built airfield (worst ' +
        worst.toFixed(2) + ' m at ' + (worstAt ? worstAt.join(', ') : '-') + ')');
    } else {
      warns.push('data/raw/osm_infra.json missing; the aeroway cross-check was skipped');
    }
  } else {
    fails.push('no airport model was built');
  }
}

/* --------------------------------------------------------------- the props -- */

{
  const P = S.props || {};
  const pick = (k) => P[k] || 0;
  say('');
  say('--- what stands on the islands -------------------------------------------');
  say('  vegetation   ' + fmt(pick('islandTree')) + ' canopy trees, ' + fmt(pick('islandHedge')) +
    ' hedgerows, ' + fmt(pick('islandBed')) + ' beds, ' + fmt(pick('islandShrub')) + ' shrubs');
  say('  the shore    ' + fmt(pick('beachGrass')) + ' marram, ' + fmt(pick('armourStone')) +
    ' armour stones, ' + fmt(pick('picnicTable')) + ' picnic tables, ' +
    fmt(pick('lifeguardChair')) + ' lifeguard chairs');
  say('  the airfield ' + fmt(pick('runwayLight')) + ' runway lights, ' + fmt(pick('taxiLight')) +
    ' taxiway lights, ' + fmt(pick('approachMast')) + ' approach bars, ' +
    fmt(pick('airportFence')) + ' fence runs, ' + fmt(pick('airliner')) + ' airliners, ' +
    fmt(pick('lightPlane')) + ' light aircraft, ' + fmt(pick('windsock')) + ' windsock');
  say('  the water    ' + fmt(pick('ferryDock')) + ' ferry docks, ' + fmt(pick('islandFerry')) +
    ' ferries, ' + fmt(pick('slipway')) + ' slipways');
  say('  the village  ' + fmt(pick('islandRoof')) + ' pitched cottage roofs, ' +
    fmt(pick('ridePad')) + ' fairground rides, ' + fmt(pick('hangar')) + ' hangars, ' +
    fmt(pick('lighthouse')) + ' lighthouse');
  check(pick('islandTree') > 1200, 'only ' + pick('islandTree') +
    ' island trees; the islands are the greenest place on the map');
  check(pick('islandRoof') > 120, 'only ' + pick('islandRoof') + ' cottages got a pitched roof');
  check(pick('runwayLight') > 40, 'only ' + pick('runwayLight') + ' runway lights');
  check(pick('approachMast') > 6, 'only ' + pick('approachMast') + ' approach bars');
  check(pick('lighthouse') === 1, 'the Gibraltar Point lighthouse was not built');
  check(pick('ferryDock') >= 4, 'only ' + pick('ferryDock') + ' ferry docks');
  check(pick('beachGrass') > 300, 'only ' + pick('beachGrass') + ' tufts of marram on 10 km of beach');
  check(pick('airportFence') > 200, 'the airport perimeter fence is only ' +
    pick('airportFence') + ' runs long');
}

/* --------------------------------------------------- the village and the cars -- */
// Two things that would be instantly wrong: six-storey cottages, and parked cars on a chain of
// islands you can only reach by ferry.

{
  const hs = [];
  for (const b of data.buildings) {
    const r = b.r && b.r[0];
    if (!Array.isArray(r) || r.length < 3) continue;
    let cx = 0, cz = 0;
    for (const q of r) { cx += q[0]; cz += q[1]; }
    cx /= r.length; cz /= r.length;
    if (cx < 1900 || cx > 3100 || cz < 80 || cz > 1200) continue;   // Ward's and Algonquin
    if (!onLand(cx, cz)) continue;
    hs.push(H.islandBuildingHeight(city.harbour, cx, cz,
      Math.abs(r.reduce((a, _, i) => a + r[i][0] * r[(i + 1) % r.length][1] -
        r[(i + 1) % r.length][0] * r[i][1], 0) / 2), b.h));
  }
  hs.sort((a, b) => a - b);
  const q = (f) => (hs.length ? hs[Math.floor(f * (hs.length - 1))] : 0);
  say('');
  say('--- the island village ---------------------------------------------------');
  say('  ' + fmt(hs.length) + ' cottages on Ward\'s and Algonquin, heights p10/p50/p90/max ' +
    q(0.1).toFixed(1) + ' / ' + q(0.5).toFixed(1) + ' / ' + q(0.9).toFixed(1) + ' / ' +
    (hs.length ? hs[hs.length - 1].toFixed(1) : '0') + ' m');
  check(q(0.5) < 9.0, 'the median island cottage is ' + q(0.5).toFixed(1) +
    ' m tall; these are one-and-a-half storey houses');

  // Parked cars, straight out of the geometry: a car body is the only thing down there with a
  // windscreen material, so count prop vertices that carry it inside the island rings.
  let cars = 0;
  const seen = new Set();
  for (const [name, parts] of kept) {
    if (name !== 'props') continue;
    for (const buf of parts) {
      for (let i = 0; i < buf.length; i += VF) {
        const r = buf[i + 6], g = buf[i + 7], b = buf[i + 8];
        if (Math.abs(r - 0.020) > 0.002 || Math.abs(g - 0.024) > 0.002 ||
          Math.abs(b - 0.030) > 0.002) continue;
        const x = buf[i], z = buf[i + 2];
        if (!onLand(x, z)) continue;
        const k = Math.round(x / 4) + ',' + Math.round(z / 4);
        if (seen.has(k)) continue;
        seen.add(k);
        cars++;
      }
    }
  }
  say('  ' + cars + ' parked cars on island land (private cars are banned on the islands)');
  check(cars <= 2, cars + ' parked cars on the Toronto Islands');
}

/* ------------------------------------------------- the island walk network -- */
// Every path must lead somewhere. The islands are reachable only by ferry, so they form their own
// components by design; what matters is that WITHIN the chain the network is one piece and that
// every bridge deck stands above the water it crosses.

{
  const nodes = new Map();
  const key = (x, z) => Math.round(x / 3) + ',' + Math.round(z / 3);
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const nodeAt = (x, z) => {
    const k = key(x, z);
    let id = nodes.get(k);
    if (id === undefined) { id = parent.length; parent.push(id); nodes.set(k, id); }
    return id;
  };
  const len = new Map();
  let total = 0;
  for (const r of data.roads) {
    if (!Array.isArray(r.p) || r.p.length < 2) continue;
    if (r.c === 'motorway') continue;
    let any = false;
    for (const q of r.p) if (onLand(q[0], q[1])) { any = true; break; }
    if (!any) continue;
    for (let i = 1; i < r.p.length; i++) {
      const a = nodeAt(r.p[i - 1][0], r.p[i - 1][1]);
      const b = nodeAt(r.p[i][0], r.p[i][1]);
      join(a, b);
      const l = Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
      total += l;
      len.set(a, (len.get(a) || 0) + l);
    }
  }
  const comp = new Map();
  for (const [, id] of nodes) {
    const r = find(id);
    comp.set(r, (comp.get(r) || 0) + (len.get(id) || 0));
  }
  // Where is each component? A disconnected island of path is only acceptable if it is
  // deliberate — the airfield behind its fence, a jetty, a private club — so report the location
  // of every one big enough to walk along.
  const at = new Map();
  for (const [k, id] of nodes) {
    const r = find(id);
    const [cx, cz] = k.split(',').map(Number);
    let b = at.get(r);
    if (!b) { b = [Infinity, Infinity, -Infinity, -Infinity]; at.set(r, b); }
    const x = cx * 3, z = cz * 3;
    if (x < b[0]) b[0] = x;
    if (z < b[1]) b[1] = z;
    if (x > b[2]) b[2] = x;
    if (z > b[3]) b[3] = z;
  }
  const ranked = [...comp.entries()].sort((a, b) => b[1] - a[1]);
  const sizes = ranked.map((e) => e[1]);
  const biggest = sizes[0] || 0;
  // Where each node is, so a stranded component can be located and its gap to the main network
  // measured. Anything airside is stranded ON PURPOSE — that is what the perimeter fence is.
  const pts = new Map();
  for (const [k, id] of nodes) {
    const r = find(id);
    let a = pts.get(r);
    if (!a) { a = []; pts.set(r, a); }
    const [cx, cz] = k.split(',').map(Number);
    a.push(cx * 3, cz * 3);
  }
  const A = city.harbour && city.harbour.isle ? city.harbour.isle.air : null;
  const airside = (x, z) => {
    if (!A) return false;
    for (const w of A.ways) {
      for (let i = 0; i < w.p.length; i++) {
        if (Math.hypot(w.p[i][0] - x, w.p[i][1] - z) < 230) return true;
      }
    }
    return false;
  };
  const main = pts.get(ranked[0][0]) || [];
  let stranded = 0, deliberate = 0;
  for (const [id, m] of ranked.slice(1)) {
    if (m < 50) continue;
    const b = at.get(id);
    const cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2;
    let gap = Infinity;
    const own = pts.get(id) || [];
    for (let i = 0; i < own.length; i += 2) {
      for (let j = 0; j < main.length; j += 2) {
        const d = Math.hypot(own[i] - main[j], own[i + 1] - main[j + 1]);
        if (d < gap) gap = d;
      }
    }
    const air = airside(cx, cz);
    if (air) deliberate += m; else stranded += m;
    say('    ' + Math.round(m) + ' m at (' + Math.round(cx) + ', ' + Math.round(cz) + '), ' +
      Math.round(b[2] - b[0]) + ' x ' + Math.round(b[3] - b[1]) + ' m, ' +
      (Number.isFinite(gap) ? Math.round(gap) + ' m from the main network' : 'isolated') +
      (air ? '  [airside, behind the fence]' : ''));
  }
  say('  ' + Math.round(deliberate) + ' m of that is airside and deliberate, ' +
    Math.round(stranded) + ' m is not');
  say('');
  say('--- the island paths -----------------------------------------------------');
  say('  ' + fmt(Math.round(total)) + ' m of island way in ' + sizes.length +
    ' components; the largest holds ' + (biggest / Math.max(1, total) * 100).toFixed(1) + '%');
  check((biggest + deliberate) / Math.max(1, total) > 0.95,
    'the island network is in pieces: the largest component plus the airside holds only ' +
    ((biggest + deliberate) / Math.max(1, total) * 100).toFixed(1) + '%');

  const M = city.harbour && city.harbour.isle ? city.harbour.isle : null;
  if (M) {
    let low = 0, worst = Infinity, worstAt = null;
    for (const b of M.bridges) {
      for (let i = 1; i < b.p.length; i++) {
        const mx = (b.p[i - 1][0] + b.p[i][0]) * 0.5, mz = (b.p[i - 1][1] + b.p[i][1]) * 0.5;
        const g = city.groundY(mx, mz);
        if (!Number.isFinite(g) || g < 0.35) {
          low++;
          if (g < worst) { worst = g; worstAt = [Math.round(mx), Math.round(mz)]; }
        }
      }
    }
    say('  ' + M.bridges.length + ' island bridges over water, ' + low +
      ' with a deck at or below the lake');
    check(low === 0, low + ' island bridge spans have a deck at or below the lake (worst ' +
      (Number.isFinite(worst) ? worst.toFixed(2) : '-') + ' m at ' +
      (worstAt ? worstAt.join(', ') : '-') + ')');
  }
}

/* ----------------------------------------------------- amendment 7: lights -- */
// Nothing this pass lays on the ground may emit: sand, riprap, seawall, runway asphalt, apron
// slab, paint and boardwalk are albedo and roughness only. Lights live in the props class, and
// every emissive colour there has to be bright enough to be an actual lamp. Buildings and glass
// are excluded: their emissive channel is the facade window hint, which is facades.js's business.

{
  const GROUND = ['terrain', 'roads', 'sidewalks', 'rails'];
  let groundEmissive = 0, groundVerts = 0, propEmissive = 0, propVerts = 0;
  const buckets = new Map();
  let dim = 0;
  for (const [name, parts] of kept) {
    const isGround = GROUND.indexOf(name) >= 0;
    if (!isGround && name !== 'props') continue;
    for (const buf of parts) {
      for (let i = 0; i < buf.length; i += VF) {
        const x = buf[i], z = buf[i + 2];
        if (x < BOX[0] || x > BOX[2] || z < BOX[1] || z > BOX[3]) continue;
        const e = buf[i + 9];
        if (isGround) {
          groundVerts++;
          if (e > 0.001) groundEmissive++;
          continue;
        }
        propVerts++;
        if (e <= 0.001) continue;
        propEmissive++;
        const r = buf[i + 6], g = buf[i + 7], b = buf[i + 8];
        if (Math.max(r, g, b) < 0.30) dim++;
        const kk = [r, g, b].map((v) => v.toFixed(2)).join('/');
        buckets.set(kk, (buckets.get(kk) || 0) + 1);
      }
    }
  }
  const list = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  say('');
  say('--- amendment 7 ----------------------------------------------------------');
  say('  ground classes: ' + fmt(groundVerts) + ' vertices in the south half, ' +
    groundEmissive + ' emissive');
  say('  props:          ' + fmt(propVerts) + ' vertices, ' + fmt(propEmissive) + ' emissive (' +
    (propEmissive / Math.max(1, propVerts) * 100).toFixed(2) + '%) in ' + list.length + ' colours');
  for (const [c, n] of list.slice(0, 6)) say('    ' + c + '  ' + fmt(n));
  check(groundEmissive === 0,
    groundEmissive + ' ground vertices in the south half are emissive; sand does not glow');
  check(dim === 0, dim + ' emissive prop vertices are too dim to be a lamp');
  check(propEmissive / Math.max(1, propVerts) < 0.06,
    (propEmissive / Math.max(1, propVerts) * 100).toFixed(2) +
    '% of south-half prop vertices are emissive');
}

/* ------------------------------------------------------------------ verdict -- */

console.log('');
console.log('--- verification ---------------------------------------------------------');
for (const w of warns) console.log('  WARN  ' + w);
for (const f of fails) console.log('  FAIL  ' + f);
if (!fails.length) console.log('  PASS  the south half is built, edged and lit');
process.exit(fails.length ? 1 : 0);
