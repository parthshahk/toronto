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
function makeNodeSet(tol) {
  const cell = Math.max(0.05, tol);
  const map = new Map();
  const xs = [], zs = [];
  return {
    xs, zs,
    get count() { return xs.length; },
    at(x, z) {
      const i = Math.round(x / cell), j = Math.round(z / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const bucket = map.get((i + di) + ':' + (j + dj));
          if (bucket === undefined) continue;
          for (let k = 0; k < bucket.length; k++) {
            const v = bucket[k];
            const dx = xs[v] - x, dz = zs[v] - z;
            if (dx * dx + dz * dz <= tol * tol) return v;
          }
        }
      }
      const id = xs.length;
      xs.push(x); zs.push(z);
      const key = i + ':' + j;
      const b = map.get(key);
      if (b) b.push(id); else map.set(key, [id]);
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
