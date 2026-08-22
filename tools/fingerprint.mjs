// tools/fingerprint.mjs — the refactor safety net.
//
//   node tools/fingerprint.mjs             build the city, print a summary, write the baseline
//   node tools/fingerprint.mjs --check     build the city, compare against the baseline
//   node tools/fingerprint.mjs --check --strict   also fail on bit-exact (sub-quantum) drift
//   node tools/fingerprint.mjs --quiet     summary only, no per-mesh table
//   node tools/fingerprint.mjs --out FILE  write/read a different baseline file
//
// CONTRACT Amendment 11.3 requires the module refactor to be verified BY GEOMETRY HASH rather
// than by eye. This is that hash. It loads the real data through the real loadCity() against a
// stub WebGL2 context, drives tiles.js through every stage of every tile so that every vertex the
// map can ever produce passes through, and reduces the lot to a fingerprint that does not depend
// on the order anything was built in.
//
// ORDER INDEPENDENCE. Each vertex is hashed on its own and the hashes are SUMMED modulo 2^32.
// Addition is commutative and associative, so the fingerprint of a bucket is a function of the
// multiset of its vertices and nothing else: reordering tiles, reordering the emitters inside a
// tile, or splitting one module into six cannot move it. Summing (rather than xor-ing) also means
// duplicate vertices do not cancel in pairs, so a doubled triangle is still visible.
//
// THREE LEVELS, deliberately:
//   h1/h2  the QUANTISED hash — positions to 1 mm, normals to 1/4096, everything else to 1e-4.
//          This is the contract-level fingerprint: tight enough that no real geometry change
//          survives it, loose enough that re-associating a float expression does not trip it.
//          A mismatch here is a FAILURE.
//   hx     the BIT-EXACT hash over the raw float32 words. A pure code move should not disturb a
//          single bit, so this is the strongest possible proof; but it is stricter than the
//          contract asks for, so by default a difference here is reported and does not fail.
//          --strict promotes it to a failure.
//   agg    per-bucket float64 sums and extents. These have no quantisation cliff at all, so when
//          h1 differs they say whether the geometry actually moved or a value merely landed on
//          the far side of a 1 mm boundary. Compared with a relative tolerance.
//
// KNOWN BLIND SPOT — the signs mesh class. Lettering geometry (text.js) needs a font atlas, and
// the atlas is rasterised by a DOM canvas 2D context, which does not exist here. So headlessly
// facades.js emits no glyphs (stats facades.textGlyphs = 0) and the signs class stays empty. Any
// refactor of text.js or of the facade signage pass is NOT covered by this fingerprint and has to
// be checked in the browser. A stub rasteriser would be worse than the gap: its metrics would not
// be the browser's, so the baseline would record geometry the game never draws. The summary below
// prints a COVERAGE line whenever the signs class comes out empty, so this is never silent.
//
// The stats object is fingerprinted too, in full: every numeric counter, every landmark height,
// the walkability numbers, the tile counts, the units placed and the surveyed furniture by kind,
// flattened to dotted paths. Timing fields are excluded by name — see EXCLUDE — because they are
// the only part of the build that is genuinely not reproducible.
//
// Zero dependencies, like everything else here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.indexOf(f) >= 0;
const opt = (f, dflt) => {
  const i = ARGV.indexOf(f);
  return (i >= 0 && i + 1 < ARGV.length) ? ARGV[i + 1] : dflt;
};

const CHECK = has('--check');
const STRICT = has('--strict');
const QUIET = has('--quiet');
const DATA_URL = opt('--data', './data/toronto.json');
const OUT = resolve(ROOT, opt('--out', 'tools/fingerprint.baseline.json'));

const FORMAT = 3;              // bump when the fingerprint's own shape changes
const REL_TOL = 1e-9;          // relative tolerance for continuous aggregates and float stats
const MAX_DIFFS = 80;          // lines of difference printed before the rest is summarised

/* ------------------------------------------------------------------ stubs -- */

globalThis.requestAnimationFrame = (fn) => setImmediate(() => fn(0));
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
}

const dataFiles = new Map();

globalThis.fetch = async (url) => {
  const path = resolve(ROOT, String(url).replace(/^\.\//, ''));
  const buf = readFileSync(path);
  dataFiles.set(relative(ROOT, path), {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 32),
  });
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

// Stub WebGL2. Every Mesh upload lands in `uploads`, in creation order, COPIED: real
// gl.bufferData copies immediately, and the tile builder recycles one MeshBuilder per material
// class across every tile, so holding the subarray would alias the next tile's data.
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

/* ------------------------------------------------------------------- hash -- */

const { VERT_FLOATS: VF } = await import(resolve(ROOT, 'src/core/vertex.js'));

// Quantisation per vertex float. Index order is the vertex format:
//   0..2 position   3..5 normal   6..8 colour   9 emissive  10 tintable  11 rough
//   12 profile      13 packed uv
// Positions land on a 1 mm lattice; normals on 1/4096 (0.014 degrees); the material channels on
// 1e-4; profile and the packed uv are already integers and are taken as they are.
const SCALE = new Float64Array(VF);
for (let k = 0; k < VF; k++) SCALE[k] = 1e4;
SCALE[0] = SCALE[1] = SCALE[2] = 1e3;
SCALE[3] = SCALE[4] = SCALE[5] = 4096;
if (VF > 12) SCALE[12] = 1;
if (VF > 13) SCALE[13] = 1;

const QUANT_NOTE = 'pos 1e-3 m, normal 1/4096, material 1e-4, profile+uv exact';

function mix(h, x) {
  h = Math.imul(h ^ x, 0x5bd1e995);
  return h ^ (h >>> 13);
}
function mix2(h, x) {
  h = Math.imul(h ^ x, 0x27d4eb2d);
  return h ^ (h >>> 15);
}
function avalanche(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function newBucket(name) {
  return {
    name,
    verts: 0,
    h1: 0, h2: 0, hx: 0,
    nan: 0,
    sumX: 0, sumY: 0, sumZ: 0,
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };
}

/** Fold one uploaded vertex buffer into a bucket. Commutative in the buffers and in the verts. */
function fold(b, f32) {
  if (!f32 || !f32.length) return;
  const i32 = new Int32Array(f32.buffer, f32.byteOffset, f32.length);
  const n = (f32.length / VF) | 0;
  let s1 = b.h1, s2 = b.h2, sx = b.hx, nan = b.nan;
  let sX = b.sumX, sY = b.sumY, sZ = b.sumZ;
  let nX = b.minX, xX = b.maxX, nY = b.minY, xY = b.maxY, nZ = b.minZ, xZ = b.maxZ;
  for (let i = 0, o = 0; i < n; i++, o += VF) {
    let a = 0x9e3779b9 ^ VF;
    let c = 0x1b873593 ^ VF;
    let e = 0x7feb352d ^ VF;
    let bad = 0;
    for (let k = 0; k < VF; k++) {
      const v = f32[o + k];
      let q;
      if (v === v && v !== Infinity && v !== -Infinity) {
        q = Math.round(v * SCALE[k]) | 0;
      } else {
        q = 0x7f7f7f7f;
        bad = 1;
      }
      a = mix(a, q);
      c = mix2(c, q + Math.imul(k + 1, 0x9e3779b1));
      e = mix(e, i32[o + k]);
    }
    nan += bad;
    s1 = (s1 + avalanche(a)) >>> 0;
    s2 = (s2 + avalanche(c)) >>> 0;
    sx = (sx + avalanche(e)) >>> 0;
    const px = f32[o], py = f32[o + 1], pz = f32[o + 2];
    sX += px; sY += py; sZ += pz;
    if (px < nX) nX = px; if (px > xX) xX = px;
    if (py < nY) nY = py; if (py > xY) xY = py;
    if (pz < nZ) nZ = pz; if (pz > xZ) xZ = pz;
  }
  b.verts += n;
  b.h1 = s1; b.h2 = s2; b.hx = sx; b.nan = nan;
  b.sumX = sX; b.sumY = sY; b.sumZ = sZ;
  b.minX = nX; b.maxX = xX; b.minY = nY; b.maxY = xY; b.minZ = nZ; b.maxZ = xZ;
}

/** Sum bucket b into accumulator a. The whole point: this is associative and commutative. */
function accumulate(a, b) {
  a.verts += b.verts;
  a.h1 = (a.h1 + b.h1) >>> 0;
  a.h2 = (a.h2 + b.h2) >>> 0;
  a.hx = (a.hx + b.hx) >>> 0;
  a.nan += b.nan;
  a.sumX += b.sumX; a.sumY += b.sumY; a.sumZ += b.sumZ;
  if (b.minX < a.minX) a.minX = b.minX; if (b.maxX > a.maxX) a.maxX = b.maxX;
  if (b.minY < a.minY) a.minY = b.minY; if (b.maxY > a.maxY) a.maxY = b.maxY;
  if (b.minZ < a.minZ) a.minZ = b.minZ; if (b.maxZ > a.maxZ) a.maxZ = b.maxZ;
  return a;
}

const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

function emit(b) {
  const empty = b.verts === 0;
  return {
    verts: b.verts,
    tris: (b.verts / 3) | 0,
    h1: hex(b.h1),
    h2: hex(b.h2),
    hx: hex(b.hx),
    nan: b.nan,
    sumX: b.sumX, sumY: b.sumY, sumZ: b.sumZ,
    minX: empty ? 0 : b.minX, maxX: empty ? 0 : b.maxX,
    minY: empty ? 0 : b.minY, maxY: empty ? 0 : b.maxY,
    minZ: empty ? 0 : b.minZ, maxZ: empty ? 0 : b.maxZ,
  };
}

/* ------------------------------------------------------------------ stats -- */

// The build measures itself with a wall clock; those are the only fields that cannot reproduce.
// Everything else in stats is a description of the city and must be identical run to run.
const EXCLUDE = new Set(['seconds', 'ms', 'buildMs', 'lastBuildMs', 'yields']);
const isTimingKey = (k) => EXCLUDE.has(k) || /(^|[a-z])Ms$/.test(k);

function flatten(node, prefix, out) {
  if (node === null || node === undefined) { out[prefix] = null; return; }
  if (Array.isArray(node)) {
    out[prefix + '.length'] = node.length;
    for (let i = 0; i < node.length; i++) flatten(node[i], prefix + '.' + i, out);
    return;
  }
  const t = typeof node;
  if (t === 'number' || t === 'string' || t === 'boolean') {
    out[prefix] = (t === 'number' && !Number.isFinite(node)) ? String(node) : node;
    return;
  }
  if (t !== 'object') return;
  const keys = Object.keys(node).sort();
  for (const k of keys) {
    if (isTimingKey(k)) continue;
    flatten(node[k], prefix ? prefix + '.' + k : k, out);
  }
}

/** Canonical text for one flattened value, used only to give the stats block a single hash. */
function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1e6) / 1e6);
  }
  return String(v);
}

function hashOfMap(map) {
  const h = createHash('sha256');
  for (const k of Object.keys(map).sort()) h.update(k + '=' + canon(map[k]) + '\n');
  return h.digest('hex').slice(0, 16);
}

/* -------------------------------------------------------------------- run -- */

const fmt = (n) => Number(n).toLocaleString('en-US');

const { loadCity } = await import(resolve(ROOT, 'src/city.js'));

const wall0 = Date.now();
const city = await loadCity(glStub, DATA_URL, () => {});
// THE DEFERRED AUDITS. loadCity() now hands the two whole-world verification sweeps (CONTRACT
// §8.2's marine components and its groundY hole test) to a chore queue the frame loop drains a
// couple of milliseconds at a time. Nothing here draws a frame, so drain it in one go — the
// fingerprint must cover every counter the city produces, whenever it produces it.
city.settle();
const S = city.stats;

// The two meshes loadCity uploads itself: the lake and the surround apron. Neither is tiled,
// because both are on screen from every viewpoint there is. They arrive in the order stats.meshes
// records them; the vertex counts are cross-checked so a reordering cannot silently mislabel one.
const buckets = new Map();
const bucketFor = (name) => {
  let b = buckets.get(name);
  if (!b) { b = newBucket(name); buckets.set(name, b); }
  return b;
};

const globalNames = Object.keys(S.meshes || {});
if (uploads.length !== globalNames.length) {
  throw new Error('fingerprint: loadCity uploaded ' + uploads.length + ' meshes but stats.meshes ' +
    'names ' + globalNames.length + ' (' + globalNames.join(', ') + ')');
}
for (let i = 0; i < globalNames.length; i++) {
  let name = globalNames[i];
  const got = (uploads[i].length / VF) | 0;
  if (S.meshes[name] !== got) {
    // Order drifted: recover the name by vertex count instead of trusting position.
    const byCount = globalNames.filter((n) => S.meshes[n] === got);
    if (byCount.length !== 1) {
      throw new Error('fingerprint: global mesh ' + i + ' has ' + got + ' verts, matching ' +
        byCount.length + ' entries of stats.meshes');
    }
    name = byCount[0];
  }
  fold(bucketFor('global:' + name), uploads[i]);
}
uploads.length = 0;

// THE WHOLE MAP. loadCity emits only the lake and the apron; every other vertex is built on
// demand by tiles.js. Drive every stage of every tile to completion so the fingerprint covers all
// 43 km2, and release each one as it is folded in so this never holds the whole map at once.
let jobs = 0;
let maxSteps = 0;
{
  const tiles = city.tiles;
  const GUARD = 8_000_000;
  for (const t of tiles.grid.tiles) {
    for (let s = 0; s < t.st.length; s++) {
      if (t.st[s].state !== 0) continue;
      const before = uploads.length;
      const job = tiles._startJob(t, s);
      if (!job) throw new Error('fingerprint: tile ' + t.i + ',' + t.j + ' stage ' + s + ' threw');
      tiles._job = job;
      let steps = 0;
      while (steps < GUARD) { steps++; if (job.it.next().done) break; }
      if (steps >= GUARD) {
        throw new Error('fingerprint: tile ' + t.i + ',' + t.j + ' stage ' + s +
          ' did not finish in ' + GUARD + ' steps');
      }
      if (steps > maxSteps) maxSteps = steps;
      tiles._finishJob(job);
      tiles._job = null;
      jobs++;
      const created = Object.keys(t.st[s].meshes);
      if (uploads.length - before !== created.length) {
        throw new Error('fingerprint: tile ' + t.i + ',' + t.j + ' stage ' + s + ' uploaded ' +
          (uploads.length - before) + ' buffers for ' + created.length + ' meshes');
      }
      for (let i = 0; i < created.length; i++) {
        fold(bucketFor(created[i] + '@' + s), uploads[before + i]);
      }
      tiles._release(t, s);
      uploads.length = before;
    }
  }
}
const wallMs = Date.now() - wall0;

// Per material class, summed across every stage and every tile. Order-independent by
// construction, so this survives any change to how the map is partitioned.
const classes = new Map();
for (const [name, b] of buckets) {
  const cls = name.indexOf('global:') === 0 ? name : name.slice(0, name.lastIndexOf('@'));
  accumulate(classes.get(cls) || classes.set(cls, newBucket(cls)).get(cls), b);
}
const world = newBucket('WORLD');
for (const b of buckets.values()) accumulate(world, b);

const meshes = {};
for (const k of [...classes.keys()].sort()) meshes[k] = emit(classes.get(k));
const bucketOut = {};
for (const k of [...buckets.keys()].sort()) bucketOut[k] = emit(buckets.get(k));

const statMap = {};
flatten(S, '', statMap);

const fp = {
  format: FORMAT,
  quantisation: QUANT_NOTE,
  vertFloats: VF,
  data: Object.fromEntries([...dataFiles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  world: emit(world),
  jobs,
  meshes,
  buckets: bucketOut,
  statsHash: hashOfMap(statMap),
  stats: statMap,
};

/* ---------------------------------------------------------------- compare -- */

function relEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const d = Math.abs(a - b);
  const s = Math.max(Math.abs(a), Math.abs(b));
  return d <= REL_TOL * (s || 1);
}

function compare(base, now) {
  const hard = [];
  const soft = [];
  const note = (list, msg) => list.push(msg);

  if (base.format !== now.format) {
    note(hard, 'baseline format ' + base.format + ' != ' + now.format +
      ' — regenerate the baseline, this file cannot be compared');
    return { hard, soft };
  }
  if (base.vertFloats !== now.vertFloats) {
    note(hard, 'VERT_FLOATS ' + base.vertFloats + ' -> ' + now.vertFloats);
  }
  if (base.quantisation !== now.quantisation) {
    note(hard, 'quantisation changed: ' + base.quantisation + ' -> ' + now.quantisation);
  }

  const bd = base.data || {};
  const nd = now.data || {};
  for (const k of new Set([...Object.keys(bd), ...Object.keys(nd)])) {
    const a = bd[k], b = nd[k];
    if (!a || !b) { note(hard, 'data file ' + k + (a ? ' no longer read' : ' newly read')); continue; }
    if (a.sha256 !== b.sha256 || a.bytes !== b.bytes) {
      note(hard, 'DATA CHANGED: ' + k + ' ' + a.bytes + 'b/' + a.sha256 + ' -> ' +
        b.bytes + 'b/' + b.sha256 + ' — the baseline describes different input');
    }
  }

  if (base.jobs !== now.jobs) note(hard, 'tile jobs built ' + base.jobs + ' -> ' + now.jobs);

  const EXACT = ['verts', 'tris', 'h1', 'h2', 'nan'];
  const CONT = ['sumX', 'sumY', 'sumZ', 'minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'];
  const cmpMesh = (label, a, b) => {
    if (!a) { note(hard, label + ': new, ' + fmt(b.verts) + ' verts'); return; }
    if (!b) { note(hard, label + ': GONE, was ' + fmt(a.verts) + ' verts'); return; }
    for (const f of EXACT) {
      if (a[f] !== b[f]) note(hard, label + '.' + f + ' ' + a[f] + ' -> ' + b[f]);
    }
    if (a.hx !== b.hx) {
      note(soft, label + '.hx ' + a.hx + ' -> ' + b.hx + ' (bit-exact drift, quantised hash ' +
        (a.h1 === b.h1 && a.h2 === b.h2 ? 'still matches' : 'ALSO differs') + ')');
    }
    for (const f of CONT) {
      if (!relEqual(a[f], b[f])) {
        note(hard, label + '.' + f + ' ' + a[f] + ' -> ' + b[f]);
      }
    }
  };

  cmpMesh('world', base.world, now.world);
  for (const k of new Set([...Object.keys(base.meshes || {}), ...Object.keys(now.meshes || {})])) {
    cmpMesh('mesh ' + k, (base.meshes || {})[k], (now.meshes || {})[k]);
  }
  for (const k of new Set([...Object.keys(base.buckets || {}), ...Object.keys(now.buckets || {})])) {
    cmpMesh('bucket ' + k, (base.buckets || {})[k], (now.buckets || {})[k]);
  }

  const bs = base.stats || {};
  const ns = now.stats || {};
  for (const k of [...new Set([...Object.keys(bs), ...Object.keys(ns)])].sort()) {
    const a = bs[k], b = ns[k];
    if (!(k in bs)) { note(hard, 'stats.' + k + ': new, = ' + canon(b)); continue; }
    if (!(k in ns)) { note(hard, 'stats.' + k + ': GONE, was ' + canon(a)); continue; }
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number' &&
      !Number.isInteger(a) && !Number.isInteger(b) && relEqual(a, b)) continue;
    note(hard, 'stats.' + k + ' ' + canon(a) + ' -> ' + canon(b));
  }
  return { hard, soft };
}

/* ----------------------------------------------------------------- report -- */

const P = S.props || {};
let propTotal = 0;
for (const k of Object.keys(P)) propTotal += P[k];
const SV = S.survey || {};
const WK = S.walk || {};
const FA = S.facades || {};

if (!QUIET) {
  console.log('\n=== geometry fingerprint ==================================================');
  console.log('  data     ' + [...dataFiles.entries()].map(([k, v]) =>
    k + ' ' + fmt(v.bytes) + 'b ' + v.sha256.slice(0, 12)).join('   '));
  console.log('  quantise ' + QUANT_NOTE + '   VERT_FLOATS ' + VF);
  console.log('  built    ' + fmt(jobs) + ' tile jobs, ' + (wallMs / 1000).toFixed(1) +
    ' s wall, longest job ' + fmt(maxSteps) + ' steps');
  console.log('\n  mesh                 verts         tris        h1        h2       bits');
  for (const k of Object.keys(meshes)) {
    const m = meshes[k];
    console.log('  ' + k.padEnd(16) + fmt(m.verts).padStart(12) + fmt(m.tris).padStart(13) +
      '  ' + m.h1 + '  ' + m.h2 + '  ' + m.hx);
  }
  const w = fp.world;
  console.log('  ' + 'WORLD'.padEnd(16) + fmt(w.verts).padStart(12) + fmt(w.tris).padStart(13) +
    '  ' + w.h1 + '  ' + w.h2 + '  ' + w.hx);
  const empties = (city.classes || []).filter((c) => !meshes[c] || meshes[c].verts === 0);
  if (empties.length) {
    console.log('\n  COVERAGE the ' + empties.join(', ') + ' class' +
      (empties.length > 1 ? 'es emit' : ' emits') + ' nothing headlessly and is not fingerprinted' +
      (empties.indexOf('signs') >= 0 ? ' (signs needs a canvas 2D font atlas)' : ''));
  }
  console.log('\n  stats    ' + Object.keys(statMap).length + ' fields, hash ' + fp.statsHash);
  console.log('  city     ' + fmt(S.buildings) + ' buildings, ' + fmt(S.roads) + ' road ways, ' +
    fmt(S.rings) + ' rings, ' + fmt(S.tileCount) + ' tiles');
  console.log('  detail   ' + fmt(FA.units || 0) + ' units (' + fmt(FA.unitsSurveyed || 0) +
    ' surveyed) over ' + fmt(FA.faces || 0) + ' block faces, ' + fmt(propTotal) + ' props, ' +
    fmt((S.people || {}).total || 0) + ' people');
  console.log('  survey   ' + fmt(SV.placed || 0) + ' of ' + fmt(SV.total || 0) +
    ' nodes placed, ' + fmt(SV.refused || 0) + ' refused, ' +
    Object.keys(SV.byKind || {}).length + ' kinds');
  console.log('  walk     ' + ((WK.fraction || 0) * 100).toFixed(2) + '% of ' +
    fmt(Math.round(WK.metres || 0)) + ' m in the largest of ' + (WK.components | 0) +
    ' components, ' + (WK.cliffs | 0) + ' cliffs');
  console.log('  landmark ' + JSON.stringify(S.landmarkHeights || {}));
}

if (!CHECK) {
  writeFileSync(OUT, JSON.stringify(fp, null, 1) + '\n');
  console.log('\n  wrote ' + relative(ROOT, OUT) + '  (' +
    fmt(readFileSync(OUT).length) + ' bytes)');
  console.log('  world fingerprint  h1=' + fp.world.h1 + ' h2=' + fp.world.h2 +
    ' bits=' + fp.world.hx + '  over ' + fmt(fp.world.verts) + ' vertices\n');
  process.exit(0);
}

if (!existsSync(OUT)) {
  console.error('\n  FAIL  no baseline at ' + relative(ROOT, OUT) +
    ' — run `npm run fingerprint` first\n');
  process.exit(2);
}

const base = JSON.parse(readFileSync(OUT, 'utf8'));
const { hard, soft } = compare(base, fp);

console.log('\n--- fingerprint check ----------------------------------------------------');
const show = (tag, list) => {
  for (let i = 0; i < list.length && i < MAX_DIFFS; i++) console.log('  ' + tag + '  ' + list[i]);
  if (list.length > MAX_DIFFS) {
    console.log('  ' + tag + '  ... and ' + (list.length - MAX_DIFFS) + ' more');
  }
};
show('DIFF', hard);
show('BITS', soft);

const failed = hard.length > 0 || (STRICT && soft.length > 0);
if (!failed && !soft.length) {
  console.log('  PASS  identical: ' + fmt(fp.world.verts) + ' vertices, h1=' + fp.world.h1 +
    ', h2=' + fp.world.h2 + ', bit-exact, ' + Object.keys(statMap).length + ' stats fields');
} else if (!failed) {
  console.log('  PASS  ' + fmt(fp.world.verts) + ' vertices match at 1 mm (h1=' + fp.world.h1 +
    '), ' + soft.length + ' bucket(s) differ below the quantum — rerun with --strict to fail on that');
} else {
  console.log('  FAIL  ' + hard.length + ' difference(s)' +
    (STRICT && soft.length ? ' and ' + soft.length + ' bit-exact drift(s)' : ''));
}
console.log('');
process.exit(failed ? 1 : 0);
