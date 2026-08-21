// src/data/index.js — spatial indexing and tile assignment.
//
// TWO STRUCTURES, DIFFERENT JOBS.
//
// makeGridIndex() is the UNIFORM-GRID BROADPHASE. CONTRACT §8.4 requires generation cost to stay
// roughly linear in feature count all the way to the full ~428,000-building city, which rules out
// every O(n^2) pass over buildings or roads. Anything that needs "what is near here" — footprint
// collision, carriageway lookup, deck soffits, tram stops, surveyed nodes — bins its features
// into one of these once and queries by disc or by box.
//
// splitLongWay() is TILE ASSIGNMENT for linear features: a way longer than a tile is cut into
// per-tile runs so its geometry is anchored where it actually is, rather than two kilometres away
// at its midpoint. The tile GRID itself, and the manager that builds and evicts tiles, live in
// src/tiles.js; this only decides which parts of a way belong where.
//
// Both are pure: no module-level mutable state, nothing carried between calls.

import { clamp } from '../core/math.js';

const EPS = 1e-9;

export function makeGridIndex(cellSize, x0, z0, nx, nz) {
  const cells = new Array(nx * nz);
  return {
    cellSize, x0, z0, nx, nz, cells,
    ci(x) { return clamp(Math.floor((x - x0) / cellSize), 0, nx - 1); },
    cj(z) { return clamp(Math.floor((z - z0) / cellSize), 0, nz - 1); },
    add(bx0, bz0, bx1, bz1, item) {
      const i0 = this.ci(bx0), i1 = this.ci(bx1);
      const j0 = this.cj(bz0), j1 = this.cj(bz1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          let a = cells[k];
          if (!a) { a = []; cells[k] = a; }
          a.push(item);
        }
      }
    },
    query(x, z, r, visit) {
      const i0 = this.ci(x - r), i1 = this.ci(x + r);
      const j0 = this.cj(z - r), j1 = this.cj(z + r);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let n = 0; n < a.length; n++) if (visit(a[n]) === false) return;
        }
      }
    },
    // Same, addressed by a box. A 200 m wall queried as a disc round its midpoint sweeps a
    // hundred metres of city that cannot possibly touch it; the box is the shape the item is.
    queryBox(bx0, bz0, bx1, bz1, visit) {
      const i0 = this.ci(bx0), i1 = this.ci(bx1);
      const j0 = this.cj(bz0), j1 = this.cj(bz1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells[j * nx + i];
          if (!a) continue;
          for (let n = 0; n < a.length; n++) if (visit(a[n]) === false) return;
        }
      }
    },
  };
}

/**
 * Cut a way that is longer than a tile into per-tile runs.
 *
 * 97% of the 20,403 road ways in the extract are shorter than a tile and are indexed whole. The
 * rest are the arterials — Lake Shore Boulevard is 1.9 km — and leaving one of those whole means
 * standing at one end of it and finding no markings, no kerbs and no lamps, because the geometry
 * is anchored two kilometres away at the midpoint.
 *
 * The cut lands in the MIDDLE OF A SEGMENT, not on a vertex. Both halves therefore end collinear
 * with the same original segment, and polyFrames() squares an endpoint to its one segment, so the
 * two runs produce the same frame vector at the shared point and the ribbons meet exactly. Cutting
 * at a vertex would leave one side mitred and the other square, which on a 12 m carriageway
 * through a right-angle bend is a visible notch in the kerb line.
 *
 * A run is never shorter than a third of a tile, so a way that grazes a corner is not chopped into
 * slivers. `out` receives sub-polylines; a way that fits in a tile yields the input array itself.
 *
 * @returns {number} the WORST join turn measured at any cut this call made, in radians, or 0 when
 * nothing was cut. Measured rather than asserted because it is the whole reason the cut is where
 * it is; returned rather than accumulated into module state so this stays a pure function.
 */
export function splitLongWay(grid, pts, out) {
  const n = pts.length;
  if (n < 3) { out.push(pts); return 0; }
  const segLen = (k) => Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  let total = 0;
  for (let k = 0; k + 1 < n; k++) total += segLen(k);
  if (total <= grid.size) { out.push(pts); return 0; }

  const minRun = grid.size * 0.35;
  let run = [pts[0]];
  let runLen = 0, doneLen = 0;
  let owner = grid.idAt((pts[0][0] + pts[1][0]) * 0.5, (pts[0][1] + pts[1][1]) * 0.5);
  for (let k = 0; k + 1 < n; k++) {
    const mx = (pts[k][0] + pts[k + 1][0]) * 0.5;
    const mz = (pts[k][1] + pts[k + 1][1]) * 0.5;
    const id = grid.idAt(mx, mz);
    const half = segLen(k) * 0.5;
    if (id !== owner && runLen + half >= minRun &&
      total - doneLen - runLen - half >= minRun && half > EPS) {
      run.push([mx, mz]);
      out.push(run);
      doneLen += runLen + half;
      run = [[mx, mz], pts[k + 1]];
      runLen = half;
      owner = id;
      // Verification: the two runs leave and arrive along the same segment, so this is zero up
      // to floating point. It is measured rather than asserted because it is the whole reason
      // the cut is where it is.
      continue;
    }
    owner = id;
    run.push(pts[k + 1]);
    runLen += half * 2;
  }
  if (run.length >= 2) out.push(run);
  else if (out.length) out[out.length - 1].push(pts[n - 1]);
  // Measure the join angle at every cut.
  let worst = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const ax = a[a.length - 1][0] - a[a.length - 2][0];
    const az = a[a.length - 1][1] - a[a.length - 2][1];
    const bx = b[1][0] - b[0][0];
    const bz = b[1][1] - b[0][1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (!(la > EPS) || !(lb > EPS)) continue;
    const t = Math.acos(clamp((ax * bx + az * bz) / (la * lb), -1, 1));
    if (t > worst) worst = t;
  }
  return worst;
}
