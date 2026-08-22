// src/world/weld.js — the two structures the grade solve and the terminus pass are built on.
//
// CONTRACT.md §8.1, §9.1 and Amendment 11.1. Moved out of city.js unchanged. Neither of these
// knows anything about Toronto, roads or geometry; they are here rather than in core/ because
// they exist to serve one question — how the street graph joins up — and both of the passes that
// ask it live in world/.
//
//   makeNodeSet(tol)  a POSITION-WELDED node set. OSM ways share a node where they meet, so
//                     welding vertices by position recovers the street graph exactly, as long as
//                     the weld survives a vertex pair landing either side of a bucket boundary.
//   makeMaxHeap()     the priority queue the grade solve settles its corridors with.
//
// The heap's `pop` reports the popped priority through _heapVal rather than allocating a pair for
// it: the solve pops tens of thousands of times and this is the inner loop. Written and read
// within one call, and never carried between them.

/* ------------------------------------------------------------- node welding */

/**
 * Position-welded node set. OSM ways share a node where they meet, so welding vertices by
 * position recovers the street graph exactly — as long as the weld survives a vertex pair landing
 * either side of a bucket boundary, which a bare rounding key does not. Probes the 3x3
 * neighbourhood instead.
 */
// THE BUCKET TABLE IS OPEN-ADDRESSED, not a Map, and that is a measurement rather than a taste.
//
// Welding is the single most expensive thing in the load that is not geometry: the terminus pass
// welds the whole network twice and the grade solve welds it again, each weld probes nine buckets
// per vertex, and over 43 km2 that is about 4.5 million bucket lookups — 147 ms of a 1.06 s load,
// and six times that over the pre-1998 city. A Map keyed on a composed integer was already the
// second version of this (the first was keyed on a string and paid a number-to-string conversion
// per probe); a flat table keyed on the (i, j) pair with linear probing is the third, and costs an
// integer multiply and an array read where the Map cost a hash of a float64.
//
// THE ORDER OF THE PROBE IS PART OF THE ANSWER and is preserved exactly. Two nodes may each be
// within `tol` of a query without being within `tol` of each other, so which one a query returns
// depends on the order the nine buckets are visited (dj outer, di inner) and on the order members
// were added within a bucket. Members are therefore chained in INSERTION order through `next`, and
// the bucket walk is unchanged — the node ids this hands back are the ids the Map handed back, and
// the geometry fingerprint says so.
const EMPTY = 0;
const FILLED = 1;

function makeNodeSet(tol) {
  const cell = Math.max(0.05, tol);
  const tol2 = tol * tol;
  const xs = [], zs = [];
  // Node id -> the next node in the same bucket, or -1. Grown alongside xs.
  const next = [];

  // The open-addressed bucket table. `head`/`tail` are node ids; `ki`/`kj` the bucket's integer
  // coordinates; `state` whether the slot is in use. Sized in powers of two so the probe mask is
  // an AND, and grown when it passes half full.
  let cap = 1024;
  let mask = cap - 1;
  let used = 0;
  let state = new Uint8Array(cap);
  let ki = new Int32Array(cap);
  let kj = new Int32Array(cap);
  let head = new Int32Array(cap);
  let tail = new Int32Array(cap);

  const hash = (i, j) => (Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b)) >>> 0;

  /** The slot holding bucket (i, j), or the empty slot it would go in. Always terminates. */
  function slotOf(i, j) {
    let s = hash(i, j) & mask;
    for (;;) {
      if (state[s] === EMPTY) return s;
      if (ki[s] === i && kj[s] === j) return s;
      s = (s + 1) & mask;
    }
  }

  function grow() {
    const oldState = state, oldKi = ki, oldKj = kj, oldHead = head, oldTail = tail;
    cap <<= 1;
    mask = cap - 1;
    state = new Uint8Array(cap);
    ki = new Int32Array(cap);
    kj = new Int32Array(cap);
    head = new Int32Array(cap);
    tail = new Int32Array(cap);
    for (let s = 0; s < oldState.length; s++) {
      if (oldState[s] !== FILLED) continue;
      const t = slotOf(oldKi[s], oldKj[s]);
      state[t] = FILLED;
      ki[t] = oldKi[s];
      kj[t] = oldKj[s];
      head[t] = oldHead[s];
      tail[t] = oldTail[s];
    }
  }

  return {
    xs, zs,
    get count() { return xs.length; },
    at(x, z) {
      const i = Math.round(x / cell), j = Math.round(z / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const s = slotOf(i + di, j + dj);
          if (state[s] !== FILLED) continue;
          for (let v = head[s]; v >= 0; v = next[v]) {
            const dx = xs[v] - x, dz = zs[v] - z;
            if (dx * dx + dz * dz <= tol2) return v;
          }
        }
      }
      const id = xs.length;
      xs.push(x); zs.push(z); next.push(-1);
      const s = slotOf(i, j);
      if (state[s] === FILLED) {
        next[tail[s]] = id;
        tail[s] = id;
      } else {
        state[s] = FILLED;
        ki[s] = i;
        kj[s] = j;
        head[s] = id;
        tail[s] = id;
        used++;
        if (used * 2 > cap) grow();
      }
      return id;
    },
  };
}

/** Binary max-heap over (key, value) pairs; used by both relaxations below. */
function makeMaxHeap() {
  const k = [], v = [];
  return {
    get size() { return k.length; },
    push(key, val) {
      k.push(key); v.push(val);
      let i = k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (v[p] >= v[i]) break;
        const tk = k[p]; k[p] = k[i]; k[i] = tk;
        const tv = v[p]; v[p] = v[i]; v[i] = tv;
        i = p;
      }
    },
    pop() {
      const top = k[0], val = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        k[0] = lk; v[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < k.length && v[l] > v[m]) m = l;
          if (r < k.length && v[r] > v[m]) m = r;
          if (m === i) break;
          const tk = k[m]; k[m] = k[i]; k[i] = tk;
          const tv = v[m]; v[m] = v[i]; v[i] = tv;
          i = m;
        }
      }
      _heapVal = val;
      return top;
    },
  };
}
let _heapVal = 0;

/** The priority of the entry the last pop() returned. */
function heapValue() {
  return _heapVal;
}

export { makeNodeSet, makeMaxHeap, heapValue };
