// tools/rebase_islandplan.mjs — move src/world/islandplan.js into the current world frame.
//
//   node tools/rebase_islandplan.mjs --from <lon>,<lat> [--check]
//
// islandplan.js holds SURVEY frozen in world metres: the Billy Bishop aeroway layout, the island
// beaches, the ferry routes, the Centreville rides and the Gibraltar Point lighthouse. World
// metres are only meaningful relative to an ORIGIN, and build_city.py derives the origin from the
// centre of its BBOX — so expanding the extract MOVES the origin and silently invalidates every
// number in that file. It did: the Old Toronto expansion moved the origin 4,062 m north, and the
// Billy Bishop runway went with it, out into open harbour where nobody could find it.
//
// The transform is exact, not a fudge. Each point is inverse-projected through the projector of
// the frame it was baked in, recovering the lon/lat it came from, then forward-projected through
// the current one. Round-tripping a point through both directions of the same projector is
// checked below and must come back within a millimetre.
//
// Every table has the same shape: a flat [x, z, x, z, ...] array as the LAST element of each
// entry, plus LIGHTHOUSE, which is a bare pair. Comments live between the export blocks and are
// preserved — only the array literals are rewritten.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FILE = resolve(ROOT, 'src/world/islandplan.js');
const CHECK = process.argv.includes('--check');

const fromArg = (() => {
  const i = process.argv.indexOf('--from');
  if (i < 0 || !process.argv[i + 1]) return null;
  const [lon, lat] = process.argv[i + 1].split(',').map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
})();

const R = 6378137.0;
const D = Math.PI / 180;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2));

function frame(origin) {
  const k = Math.cos(origin.lat * D);
  const ox = R * origin.lon * D;
  const oy = mercY(origin.lat);
  return {
    fwd: (lon, lat) => [(R * lon * D - ox) * k, -(mercY(lat) - oy) * k],
    inv: (x, z) => {
      const mx = x / k + ox;
      const my = oy - z / k;
      return [mx / (R * D), (2 * (Math.atan(Math.exp(my / R)) - Math.PI / 4)) / D];
    },
  };
}

// The live origin, straight out of the packed manifest — the one thing that decides the frame.
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'data/city/manifest.json'), 'utf8'));
const toOrigin = manifest.meta.origin;
const fromOrigin = fromArg || toOrigin;

const A = frame(fromOrigin);
const B = frame(toOrigin);

// The round trip must be exact, or nothing below can be trusted.
{
  const [lon, lat] = A.inv(-1234.5, 6789.0);
  const [x, z] = A.fwd(lon, lat);
  const err = Math.hypot(x - -1234.5, z - 6789.0);
  if (err > 1e-3) throw new Error(`projector round trip is off by ${err} m`);
}

const move = (x, z) => {
  const [lon, lat] = A.inv(x, z);
  const [nx, nz] = B.fwd(lon, lat);
  return [Math.round(nx * 10) / 10, Math.round(nz * 10) / 10];
};

const plan = await import(FILE);
const TABLES = ['AERO_RUNWAY', 'AERO_TAXIWAY', 'AERO_APRON', 'AERO_STOPWAY', 'AERO_STAND',
  'AERO_HOLD', 'BEACHES', 'FERRY_ROUTES', 'RIDES', 'AERO_HANGAR'];

function flatMoved(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [x, z] = move(flat[i], flat[i + 1]);
    out.push(x, z);
  }
  return out;
}

// Emit an array literal in the file's own style: two-space indent, wrapped near 100 columns,
// trailing ".0" dropped the way JSON.stringify does.
function lit(v, indent) {
  // Single quotes, to match the file this writes back into. No name in the survey contains one.
  if (typeof v === 'string') {
    if (v.indexOf("'") >= 0) throw new Error('name contains a single quote: ' + v);
    return "'" + v + "'";
  }
  if (typeof v === 'number') return String(v);
  const parts = v.map((e) => lit(e, indent + '  '));
  const oneLine = '[' + parts.join(',') + ']';
  if (indent.length + oneLine.length <= 98 || v.every((e) => typeof e === 'number')) {
    if (indent.length + oneLine.length <= 98) return oneLine;
    // A long flat run of numbers: wrap it.
    const lines = [];
    let cur = '';
    for (const p of parts) {
      const add = cur ? cur + ',' + p : p;
      if (indent.length + 2 + add.length > 96) { lines.push(cur); cur = p; } else { cur = add; }
    }
    if (cur) lines.push(cur);
    return '[' + lines.join(',\n' + indent + '  ') + ']';
  }
  return '[\n' + indent + '  ' + parts.join(',\n' + indent + '  ') + ',\n' + indent + ']';
}

let src = readFileSync(FILE, 'utf8');
let changed = 0;
let maxShift = 0;

function replaceBlock(name, text) {
  const m = new RegExp('export const ' + name + '\\s*=\\s*').exec(src);
  if (!m) throw new Error('missing export ' + name);
  // exec() gives .index and the matched text — there is no .end. Reading one used to make
  // start `undefined`, which turned slice(0, start) into the WHOLE file and every "replacement"
  // into an append; eleven tables doubled the file eleven times.
  const start = m.index + m[0].length;
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  src = src.slice(0, start) + text + src.slice(j + 1);
}

for (const name of TABLES) {
  const table = plan[name];
  const next = table.map((entry) => {
    const out = entry.slice();
    const last = out.length - 1;
    if (!Array.isArray(out[last])) throw new Error(name + ': last element is not a coordinate run');
    for (let i = 0; i + 1 < out[last].length; i += 2) {
      const d = Math.hypot(...move(out[last][i], out[last][i + 1])) ;
      if (d > maxShift) maxShift = d;
    }
    out[last] = flatMoved(out[last]);
    return out;
  });
  replaceBlock(name, lit(next, ''));
  changed += table.length;
}
{
  const [x, z] = move(plan.LIGHTHOUSE[0], plan.LIGHTHOUSE[1]);
  replaceBlock('LIGHTHOUSE', `[${x}, ${z}]`);
}

// Record the frame these numbers are in, so the guard in tools/harness.mjs can catch the next
// origin move instead of leaving it to be noticed as a missing runway.
const r6 = (v) => Number(v.toFixed(6));
const stamp = `export const PLAN_ORIGIN = { lon: ${r6(toOrigin.lon)}, lat: ${r6(toOrigin.lat)} };`;
if (/export const PLAN_ORIGIN[^;]*;/.test(src)) {
  src = src.replace(/export const PLAN_ORIGIN[^;]*;/, stamp);
} else {
  src = src.replace(/export const MAG_DECL/,
    '// THE FRAME THESE NUMBERS ARE IN. World metres mean nothing without it, and build_city.py\n'
    + '// derives the origin from the centre of its BBOX — so growing the extract moves the origin\n'
    + '// and invalidates every coordinate in this file. tools/harness.mjs asserts this against the\n'
    + '// live manifest; when it fails, run tools/rebase_islandplan.mjs --from <old lon,lat>.\n'
    + stamp + '\n\nexport const MAG_DECL');
}

// A replacement can only ever shrink or modestly grow this file. Anything else means the
// splice went wrong, and writing it would destroy the survey.
if (!CHECK && src.length > readFileSync(FILE, 'utf8').length * 1.5) {
  throw new Error('rebase produced a file 50% larger than the original — refusing to write');
}

if (CHECK) {
  console.log(`from ${fromOrigin.lon},${fromOrigin.lat} -> ${toOrigin.lon},${toOrigin.lat}`);
  console.log(`${changed} entries would move; furthest resulting point ${maxShift.toFixed(0)} m from origin`);
} else {
  writeFileSync(FILE, src);
  console.log(`rebased ${changed} entries from ${fromOrigin.lon},${fromOrigin.lat} `
    + `to ${toOrigin.lon},${toOrigin.lat}`);
}
