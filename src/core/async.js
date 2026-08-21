// src/core/async.js — cooperative scheduling for a build that must not freeze the tab.
//
// CONTRACT.md §3.1: "Loading must be incremental — report progress and yield so the loading bar
// animates." Three primitives, moved out of city.js unchanged, and used by every long pass in
// the tree. Depends on nothing; sits at the root of the graph beside vertex.js and math.js.
//
// The yield counter is module state on purpose: it is a diagnostic that spans a whole load, and
// threading it through every await would put scheduling plumbing into geometry signatures. It is
// reset once per load by the loader and read once at the end.

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// Yield to the browser. A bare requestAnimationFrame NEVER fires in a background tab, which would
// hang the load forever, so race it against a timer and take whichever wins.
// Counted, because in a real visible tab each of these costs a few milliseconds of wall clock
// that no profiler inside the load will attribute to anything. loadCity reports the number.
let _yields = 0;

function frame() {
  _yields++;
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fin);
    setTimeout(fin, 8);
  });
}

// Milliseconds of work between yields. A yield is not free — in a visible tab it costs most of a
// frame, and the old fixed chunk sizes spent 220 of them on a build whose real work was three
// seconds, so a third of the load was the loading screen waiting for itself. This yields on a
// CLOCK instead: the progress bar still updates about forty times a second, which is as often as
// anyone can see, and the count drops by an order of magnitude.
const CHUNK_MS = 12;

async function chunked(n, size, fn, onFrac) {
  let last = now();
  for (let i = 0; i < n; i += size) {
    const end = Math.min(n, i + size);
    for (let k = i; k < end; k++) fn(k);
    if (onFrac) onFrac(end / Math.max(1, n));
    if (end < n && now() - last > CHUNK_MS) {
      await frame();
      last = now();
    }
  }
}

/** How many times frame() has yielded since the last resetYields(). */
export function yieldCount() {
  return _yields;
}

/** Zero the yield counter. Called once at the start of a load. */
export function resetYields() {
  _yields = 0;
}

export { now, frame, chunked };
