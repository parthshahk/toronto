// tools/scopecheck.mjs — the OTHER refactor safety net: free-variable detection.
//
//   node tools/scopecheck.mjs            list every identifier a module reads but never binds
//   node tools/scopecheck.mjs --quiet    print only the count and the verdict
//
// WHY THIS EXISTS. tools/fingerprint.mjs proves that the geometry a refactor emits is unchanged.
// It cannot prove that code which never runs headlessly is correct, and the module split found
// that gap the hard way: logCitySummary() was lifted out of loadCity()'s closure into
// city/report.js still reading two of that closure's variables, `extent` and `HARBOUR`. Both are
// free variables in the new file. Nothing catches that —
//
//   node --check    parses the file; an unresolved identifier is legal JavaScript until it runs
//   fingerprint     drives loadCity() and every tile stage, but never the summary
//   the browser     throws ReferenceError at the very end of a 70-second boot
//
// — so a one-line move can survive every automated check in the tree and still break the game.
// This scans for exactly that: an identifier that is READ in a module and is neither imported,
// nor declared, nor a parameter, nor a global.
//
// IT IS A SCANNER, NOT A PARSER. There is no dependency budget for a real JavaScript parser here,
// so this blanks comments, strings, template bodies and regex literals with a small state machine
// and then works on identifiers. That is sound in the direction that matters: bindings are
// collected generously (a missed binding form would be a false ALARM, which is visible and cheap)
// and reads are collected narrowly (property names after a dot, object keys and assignment targets
// are excluded). It is not sound in the other direction — a free variable that shares its name
// with a local somewhere else in the same file is invisible to it. Treat a clean run as evidence,
// not proof; treat a finding as real until you have read the line.
//
// Zero dependencies, like everything else here.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const QUIET = ARGV.indexOf('--quiet') >= 0;

/* ---------------------------------------------------------------- the tree -- */

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'raw') walk(p);
    } else if (/\.m?js$/.test(entry)) {
      files.push(p);
    }
  }
})(join(ROOT, 'src'));

/* --------------------------------------------------------------- blanking -- */

// Replace the CONTENTS of comments, template literals and regex literals with spaces, keeping
// line breaks so reported line numbers stay true. Quoted string contents are blanked too: a
// module specifier is read off the import statement before this runs, and nothing else in a
// string is an identifier read. Template SUBSTITUTIONS are kept, because ${x} really does read x.
function blank(src) {
  let out = '';
  let i = 0;
  let prev = '';                       // last significant character, to spot a regex literal
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"') {
      const quote = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) break;
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' '; i++; prev = 'x';
      continue;
    }
    if (c === '`') {
      out += ' '; i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; out += '  '; i += 2; continue; }
        if (src[i] === '}' && depth > 0) { depth--; out += ' '; i++; continue; }
        if (src[i] === '`' && depth === 0) break;
        out += depth > 0 ? src[i] : (src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      out += ' '; i++; prev = 'x';
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]/.test(prev)) {
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '[') { while (i < n && src[i] !== ']') { out += ' '; i++; } }
        if (src[i] === '/' || src[i] === '\n') break;
        out += ' '; i++;
      }
      out += ' '; i++; prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c;
    i++;
  }
  return out;
}

/* ---------------------------------------------------------------- globals -- */

// Everything a module here may legitimately read without binding it: the language, the browser
// surface the renderer and the HUD use, and the Node surface the tools use.
const GLOBALS = new Set((`
  Array ArrayBuffer BigInt BigInt64Array BigUint64Array Boolean DataView Date Error EvalError
  Float32Array Float64Array Function Infinity Int16Array Int32Array Int8Array Intl JSON Map Math
  NaN Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer
  String Symbol SyntaxError TypeError URIError Uint16Array Uint32Array Uint8Array
  Uint8ClampedArray WeakMap WeakSet decodeURI decodeURIComponent encodeURI encodeURIComponent
  globalThis isFinite isNaN parseFloat parseInt queueMicrotask structuredClone undefined
  AbortController Blob CustomEvent Element Event EventTarget File FileReader Headers Image
  ImageData KeyboardEvent MouseEvent OffscreenCanvas PointerEvent Request Response TextDecoder
  TextEncoder TouchEvent URL URLSearchParams WebGL2RenderingContext WebGLRenderingContext
  WheelEvent cancelAnimationFrame clearInterval clearTimeout devicePixelRatio document fetch
  history innerHeight innerWidth localStorage location matchMedia navigator performance
  requestAnimationFrame screen sessionStorage setInterval setTimeout window console
  Buffer __dirname __filename exports module process require
  arguments async await break case catch class const continue debugger default delete do else
  export extends finally for from function get if import in instanceof let new of return set
  static super switch this throw try typeof var void while with yield
  false null true
`).trim().split(/\s+/));

/* ----------------------------------------------------------------- the scan -- */

const findings = [];
let scanned = 0;

for (const file of files) {
  let src = blank(readFileSync(file, 'utf8'));
  const bound = new Set();
  const addAll = (text) => {
    for (const m of String(text).matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(m[0]);
  };

  // import bindings, then blank the statement so its names are not counted as reads
  src = src.replace(/\bimport\s+([\s\S]*?)\s+from\s*['"\s]/g, (whole, clause) => {
    addAll(clause.replace(/\b\w+\s+as\s+/g, ''));
    return whole.replace(/[^\n]/g, ' ');
  });
  // re-exports name OTHER modules' bindings; they are neither reads nor bindings here
  src = src.replace(/\bexport\s*(?:\*(?:\s*as\s+[A-Za-z_$][\w$]*)?|\{[\s\S]*?\})\s*from\s*['"\s]/g,
    (whole) => whole.replace(/[^\n]/g, ' '));

  // Declarations: take the whole binding pattern, drop object-pattern keys. A destructuring
  // pattern is matched bracket-first, because `const {\n  a, b,\n} = W;` is the house style for
  // the context objects and a line-terminated match would see only the brace.
  const decl = /\b(?:const|let|var)\s+(\{[\s\S]*?\}|\[[\s\S]*?\]|[^=;\n]*)/g;
  for (const m of src.matchAll(decl)) addAll(m[1].replace(/:\s*/g, ' '));
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([\s\S]*?)\)/g)) {
    if (m[1]) bound.add(m[1]);
    addAll(m[2]);
  }
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) addAll(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]);
  // method shorthand, on a class body or an object literal
  const method = /(?:^|[\n{,;])\s*(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  for (const m of src.matchAll(method)) { bound.add(m[1]); addAll(m[2]); }

  // NOT reads: object-literal keys, labels, and anything being assigned to
  const notRead = new Set();
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) notRead.add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=[^=]/g)) notRead.add(m[1]);

  const seen = new Map();
  for (const m of src.matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)/g)) {
    const id = m[2];
    if (GLOBALS.has(id) || bound.has(id) || notRead.has(id) || seen.has(id)) continue;
    seen.set(id, src.slice(0, m.index).split('\n').length);
  }
  for (const [id, line] of seen) findings.push({ file: relative(ROOT, file), line, id });
  scanned++;
}

/* ------------------------------------------------------------------ report -- */

console.log('\n=== scope check ==========================================================');
if (!QUIET) {
  for (const f of findings) {
    console.log('  ' + (f.file + ':' + f.line).padEnd(40) + 'reads unbound  ' + f.id);
  }
  if (findings.length) console.log('');
}
if (findings.length === 0) {
  console.log('  PASS  ' + scanned + ' modules, every identifier read is imported, declared, ' +
    'a parameter or a global');
} else {
  console.log('  FAIL  ' + findings.length + ' unbound identifier' +
    (findings.length === 1 ? '' : 's') + ' over ' + scanned + ' modules');
  console.log('        Each one is a ReferenceError the moment that line runs. If a name here is ' +
    'genuinely\n        global, add it to GLOBALS in this file; otherwise it is a variable the ' +
    'move left behind.');
}
process.exit(findings.length ? 1 : 0);
