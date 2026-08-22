// tools/lodprobe.mjs — measures what the LOD valve ACTUALLY does at fly-mode viewpoints.
//
//   node tools/lodprobe.mjs
//
// Boots the real city headlessly, parks the real Camera at a set of viewpoints, runs the tile
// scheduler until it settles, and reports the numbers that decide what the player sees:
// resident vertices against the cap, the per-stage LOD scale, the EFFECTIVE build radius each
// stage ended up with, and how far the built massing actually reaches. Diagnostic only —
// it never writes geometry and never asserts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

globalThis.requestAnimationFrame = (fn) => setImmediate(() => fn(0));
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
}
globalThis.fetch = async (url) => {
  const path = resolve(ROOT, String(url).replace(/^\.\//, ''));
  const buf = readFileSync(path);
  return {
    ok: true, status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    body: null,
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
};
let nextId = 1;
const glStub = new Proxy({
  ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406,
  createVertexArray: () => ({ id: nextId++ }),
  createBuffer: () => ({ id: nextId++ }),
  bufferData: () => {},
}, { get(t, k) { return k in t ? t[k] : (() => {}); } });

const { loadCity } = await import(resolve(ROOT, 'src/city.js'));
const { Camera } = await import(resolve(ROOT, 'src/render/camera.js'));

process.stdout.write('booting city...\n');
const city = await loadCity(glStub, './data/toronto.json', () => {});
if (city.settle) city.settle();

const tiles = city.tiles || city.update(new Camera(), 0);
const grid = tiles.grid;
const stageNames = tiles.stages.map((s) => s.name);

const cam = new Camera();
cam.aspect = 16 / 9;
cam.fov = 1.05;
cam.near = 1.0;

function park(x, y, z, bearing, pitch) {
  const yaw = bearing * Math.PI / 180, pit = pitch * Math.PI / 180;
  cam.pos[0] = x; cam.pos[1] = y; cam.pos[2] = z;
  const cp = Math.cos(pit);
  cam.target[0] = x + Math.sin(yaw) * cp * 100;
  cam.target[1] = y + Math.sin(pit) * 100;
  cam.target[2] = z + Math.cos(yaw) * cp * 100;
  cam.update();
}

// Run until the scheduler stops having anything to do (or we run out of patience).
// SETTLED means the queue is drained AND the adaptive valve has stopped moving. The valve walks
// one stage and 0.02 of a scale per frame, so a squeezed want set takes hundreds of frames to
// climb back — draining the queue is nowhere near the steady state.
// One clock across the whole run, jumped past the eviction grace before each viewpoint so the
// previous viewpoint's tiles are actually retired. Without the jump a measurement inherits
// whatever the last one built and the numbers wander.
let CLOCK = 0;
function settle(maxFrames = 3000) {
  CLOCK += 60000;
  let t = CLOCK, f = 0, quiet = 0;
  let last = tiles._lod.join(',');
  for (; f < maxFrames; f++) {
    t += 16.7;
    CLOCK = t;
    city.update(cam, t, 60);   // generous budget: we want the SETTLED state, not the ramp
    const now = tiles._lod.join(',');
    const idle = !tiles._job && tiles._queue.length === 0;
    quiet = (idle && now === last) ? quiet + 1 : 0;
    last = now;
    if (quiet >= 90) break;
  }
  return f;
}

function report(label) {
  const S = tiles.stats;
  const cap = tiles._cap ? tiles._cap() : tiles.vertexCap;
  // How far each stage's geometry actually reaches, measured off built tiles.
  const reach = tiles.stages.map(() => 0);
  const ready = tiles.stages.map(() => 0);
  const vsum = tiles.stages.map(() => 0);
  const px = cam.pos[0], pz = cam.pos[2];
  for (const t of grid.tiles) {
    if (!t.st) continue;
    for (let s = 0; s < t.st.length; s++) {
      if (t.st[s].state !== 2) continue;      // STATE_READY
      ready[s]++;
      vsum[s] += t.st[s].verts;
      const cx = (t.cx0 + t.cx1) * 0.5, cz = (t.cz0 + t.cz1) * 0.5;
      const d = Math.hypot(cx - px, cz - pz);
      if (d > reach[s]) reach[s] = d;
    }
  }
  console.log(`\n### ${label}`);
  console.log(`  resident ${(S.residentVerts / 1e6).toFixed(2)} M / cap ${(cap / 1e6).toFixed(1)} M`
    + `   (${((S.residentVerts / cap) * 100).toFixed(0)}% full)`);
  console.log(`  shrinks ${S.lodShrinks}  relaxes ${S.lodRelaxes}  visibleTiles ${S.visibleTiles}`);
  for (let s = 0; s < tiles.stages.length; s++) {
    const scale = tiles._lod[s];
    const nominal = tiles.stages[s].range;
    console.log(`  ${stageNames[s].padEnd(7)} lod ${scale.toFixed(2)}  `
      + `range ${Math.round(nominal * scale)} m of ${nominal} m   `
      + `ready ${String(ready[s]).padStart(4)} tiles  reach ${String(Math.round(reach[s])).padStart(5)} m  `
      + `${(vsum[s] / 1e6).toFixed(2)} M verts (${(vsum[s] / Math.max(1, ready[s]) / 1000).toFixed(0)} k/tile)`);
  }
}

// Per-class breakdown of the heaviest resident tile at each stage — what the budget is spent ON.
function breakdown(stageIdx, label) {
  let best = null;
  for (const t of grid.tiles) {
    if (!t.st || !t.st[stageIdx] || t.st[stageIdx].state !== 2) continue;
    if (!best || t.st[stageIdx].verts > best.st[stageIdx].verts) best = t;
  }
  if (!best) { console.log(`  (no resident ${label} tile)`); return; }
  const rec = best.st[stageIdx];
  const rows = [];
  for (const c in rec.meshes) {
    const m = rec.meshes[c];
    if (m && m.vertexCount > 0) rows.push([c, m.vertexCount]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log(`  heaviest ${label} tile = ${(rec.verts / 1000).toFixed(0)} k verts:`);
  for (const [c, n] of rows.slice(0, 12)) {
    console.log(`      ${c.padEnd(12)} ${String(Math.round(n / 1000)).padStart(4)} k  `
      + `${((n / rec.verts) * 100).toFixed(0).padStart(3)}%`);
  }
}

const VIEWS = [
  ['skyline from the lake (the default view)', 179.2, 300, 518.3, 350, -7],
  ['high over downtown, 900 m', 0, 900, 0, 0, -25],
  ['very high, 2000 m, looking north', 0, 2000, 3000, 0, -20],
  ['street level, Financial District', 0, 2, 0, 0, 0],
];

for (const [label, x, y, z, b, p] of VIEWS) {
  park(x, y, z, b, p);
  const f = settle();
  report(`${label}  [settled in ${f} frames]`);
}

park(0, 2, 0, 0, 0);
settle();
console.log('\n### where the vertices go (street level)');
breakdown(0, 'massing');
breakdown(1, 'detail');
