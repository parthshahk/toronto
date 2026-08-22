// src/tilegrid.js — the tile grid itself: pure plan-space arithmetic, no GL, no residency.
//
// SPLIT OUT OF tiles.js, which had grown past the ~800-line ceiling CONTRACT Amendment 11 sets.
// The seam is the honest one: everything here is a pure function of a bounding box and a point,
// it allocates no GPU object and holds no mutable state, and it is what the DATA side needs —
// tools/pack_city.py reads TILE_SIZE out of this file to partition the city into exactly these
// cells, and src/data/stream.js reasons about the same ids. src/tiles.js keeps the manager that
// owns buffers, budgets and eviction, and re-exports every name it used to export, so nothing
// downstream changes.
//
// Zero dependencies.

const EPS = 1e-9;

// Tile edge, metres. Measured choice, not a guess:
//   * 25 m is the terrain sample pitch, so the edge must be a whole number of terrain cells or
//     the ground mesh cannot be split without either cracks or double-emitted cells. 625 = 25 x 25.
//   * bigger tiles mean fewer draw calls but a coarser detail radius: at 1000 m a pedestrian
//     standing anywhere loads 4 km2 of street furniture.
//   * smaller tiles mean tighter culling but more draw calls: at 384 m a 3.5 km view is ~190
//     tiles and, at three populated classes each, ~570 draw calls before any detail.
//   625 m puts a 3.5 km view at ~30 tiles and a street-level detail set at 4-9 tiles.
export const TILE_SIZE = 625;

/* ==================================================================== grid == */

/**
 * A fixed grid over the world. `margin` is how far outside the data extent tiles still exist,
 * so features that spill past the bounding box (the synthesised surround, a road that leaves
 * the extract) still land somewhere real.
 */
export function makeTileGrid(extent, size = TILE_SIZE, margin = 400) {
  const ex = (extent && Number.isFinite(extent.x)) ? extent.x : 3141.7;
  const ez = (extent && Number.isFinite(extent.z)) ? extent.z : 2226.4;
  const s = Math.max(50, size);
  const x0 = -ex / 2 - margin;
  const z0 = -ez / 2 - margin;
  const nx = Math.max(1, Math.ceil((ex + margin * 2) / s));
  const nz = Math.max(1, Math.ceil((ez + margin * 2) / s));
  const tiles = new Array(nx * nz);

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const id = j * nx + i;
      tiles[id] = {
        id, i, j,
        // Core cell: what the level-of-detail distance is measured against. Deliberately NOT the
        // draw box — a 1.9 km arterial anchored here must not drag the whole tile's street
        // furniture into range from the far end of the road.
        cx0: x0 + i * s, cz0: z0 + j * s,
        cx1: x0 + (i + 1) * s, cz1: z0 + (j + 1) * s,
        mx: x0 + (i + 0.5) * s, mz: z0 + (j + 0.5) * s,
        // Draw box: grown to contain every feature indexed here. Frustum culling uses this.
        bx0: Infinity, bz0: Infinity, by0: Infinity,
        bx1: -Infinity, bz1: -Infinity, by1: -Infinity,
        empty: true,
        st: null,          // per-stage cache, allocated by the manager
        dist: 0, visible: false, lastSeen: 0,
      };
    }
  }

  return {
    size: s, x0, z0, nx, nz, count: nx * nz, tiles,
    ci(x) {
      const i = Math.floor((x - x0) / s);
      return i < 0 ? 0 : (i >= nx ? nx - 1 : i);
    },
    cj(z) {
      const j = Math.floor((z - z0) / s);
      return j < 0 ? 0 : (j >= nz ? nz - 1 : j);
    },
    // The tile that OWNS this point.
    at(x, z) {
      const fx = Number.isFinite(x) ? x : 0;
      const fz = Number.isFinite(z) ? z : 0;
      return tiles[this.cj(fz) * nx + this.ci(fx)];
    },
    idAt(x, z) {
      const fx = Number.isFinite(x) ? x : 0;
      const fz = Number.isFinite(z) ? z : 0;
      return this.cj(fz) * nx + this.ci(fx);
    },
    // Grow a tile's draw box. Called once per indexed feature.
    cover(tile, x0b, z0b, x1b, z1b, y0b, y1b) {
      if (!tile) return;
      if (x0b < tile.bx0) tile.bx0 = x0b;
      if (z0b < tile.bz0) tile.bz0 = z0b;
      if (x1b > tile.bx1) tile.bx1 = x1b;
      if (z1b > tile.bz1) tile.bz1 = z1b;
      if (Number.isFinite(y0b) && y0b < tile.by0) tile.by0 = y0b;
      if (Number.isFinite(y1b) && y1b > tile.by1) tile.by1 = y1b;
      tile.empty = false;
    },
    // Every tile that has nothing indexed in it still needs a legal box, or the culler compares
    // against infinities and a NaN quietly makes it visible forever.
    seal(defaultY0, defaultY1) {
      for (let k = 0; k < tiles.length; k++) {
        const t = tiles[k];
        if (t.bx0 > t.bx1) { t.bx0 = t.cx0; t.bx1 = t.cx1; t.bz0 = t.cz0; t.bz1 = t.cz1; }
        if (!(t.by0 <= t.by1)) { t.by0 = defaultY0; t.by1 = defaultY1; }
        // Never let a box be thinner than the cell it sits in: a tile holding one flagpole is
        // still a square of ground.
        if (t.bx0 > t.cx0) t.bx0 = t.cx0;
        if (t.bz0 > t.cz0) t.bz0 = t.cz0;
        if (t.bx1 < t.cx1) t.bx1 = t.cx1;
        if (t.bz1 < t.cz1) t.bz1 = t.cz1;
      }
    },
  };
}

/**
 * Cut a polyline into runs of consecutive segments that belong to the same tile, so a 1.9 km
 * arterial is not one indivisible lump of geometry anchored at its midpoint.
 *
 * A segment belongs to the tile holding its midpoint; a run is a maximal stretch of segments
 * with the same owner. The cut lands on a shared vertex, so the two runs meet exactly.
 * `visit(tileId, k0, k1)` gets the vertex range [k0, k1] (inclusive) of each run.
 */
export function splitRuns(grid, pts, visit) {
  const n = pts ? pts.length : 0;
  if (n < 2) return 0;
  let runs = 0;
  let k0 = 0;
  let owner = grid.idAt((pts[0][0] + pts[1][0]) * 0.5, (pts[0][1] + pts[1][1]) * 0.5);
  for (let k = 1; k < n - 1; k++) {
    const id = grid.idAt((pts[k][0] + pts[k + 1][0]) * 0.5, (pts[k][1] + pts[k + 1][1]) * 0.5);
    if (id === owner) continue;
    visit(owner, k0, k);
    runs++;
    k0 = k;
    owner = id;
  }
  visit(owner, k0, n - 1);
  return runs + 1;
}

/* ============================================================== frustum ==== */

// Six clip planes from a column-major view-projection matrix (Gribb & Hartmann), normalised so
// the plane test is a real signed distance and the box test can use the box's half-extent.
export function extractPlanes(m, out) {
  const p = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],   // left
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],   // right
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],   // bottom
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],   // top
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],  // near
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],  // far
  ];
  for (let i = 0; i < 6; i++) {
    const a = p[i][0], b = p[i][1], c = p[i][2];
    const l = Math.sqrt(a * a + b * b + c * c);
    const inv = l > EPS ? 1 / l : 0;
    out[i * 4] = a * inv;
    out[i * 4 + 1] = b * inv;
    out[i * 4 + 2] = c * inv;
    out[i * 4 + 3] = p[i][3] * inv;
  }
  return out;
}

export function boxOutside(pl, x0, y0, z0, x1, y1, z1) {
  for (let i = 0; i < 24; i += 4) {
    const a = pl[i], b = pl[i + 1], c = pl[i + 2], d = pl[i + 3];
    // Farthest corner along the plane normal. If even that is behind, the box is outside.
    const px = a >= 0 ? x1 : x0;
    const py = b >= 0 ? y1 : y0;
    const pz = c >= 0 ? z1 : z0;
    if (a * px + b * py + c * pz + d < 0) return true;
  }
  return false;
}

export function boxDist(px, py, pz, x0, y0, z0, x1, y1, z1) {
  const dx = px < x0 ? x0 - px : (px > x1 ? px - x1 : 0);
  const dy = py < y0 ? y0 - py : (py > y1 ? py - y1 : 0);
  const dz = pz < z0 ? z0 - pz : (pz > z1 ? pz - z1 : 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export default { TILE_SIZE, makeTileGrid, splitRuns, extractPlanes, boxOutside, boxDist };
