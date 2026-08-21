// src/city/queries.js — what the game asks the city about a point.
//
// CONTRACT.md §3.1 and Amendment 11.1. Moved out of city.js unchanged. This is the runtime query
// surface — the part of the city object that the camera, the player and the HUD call every frame,
// long after the geometry has been built:
//
//   buildingAt(x, z)          the footprint record under a point, via the uniform-grid broadphase.
//   collide(x, z, r, feetY)   circle-vs-footprint resolution. `feetY` is what makes an underpass
//                             walkable: a footprint is a flat 2-D obstacle only for someone at
//                             the same level as it.
//   limitFrac / confine       the soft world limit (CONTRACT §9.3): how far into the deceleration
//                             band a point is, and easing the camera to a halt at the edge.
//   streetNameAt(x, z)        the nearest named carriageway, for the HUD.
//
// Collision reads `parts`, which is prepared for EVERY building at load and never evicted: the
// player must not be able to walk through a tower merely because its geometry is not resident.

import { clamp } from '../core/math.js';
import { isNum } from '../core/util.js';
import { closestOnRing, partContains } from '../geom/ring.js';
import { makeGridIndex } from '../data/index.js';
import { EPS } from '../world/ground.js';
import { PASSAGE_HEAD, PASS_HEAD, UNDER_CLEAR, WAY_SUB } from '../world/grade.js';
import { limitAxis } from '../world/limits.js';

/**
 * Build the runtime query surface over one finished load.
 *
 * @param {object} W the world the load produced: the footprint index, the grade field, the
 *   natural ground sampler, the soft limits, the extent and the raw road records.
 * @returns {{buildingAt: Function, collide: Function, limitFrac: Function, confine: Function,
 *   streetNameAt: Function}}
 */
function makeQuerySurface(W) {
  const { bIndex, gradeField, terrainY, LIMITS, extent, roadsRaw, G } = W;

  /* ---------------------------------------------------------- query surface */

  function buildingAt(x, z) {
    if (!isNum(x) || !isNum(z)) return null;
    const pv = -z;
    let found = null;
    bIndex.query(x, z, 0.01, (b) => {
      if (found || !b.parts) return;
      if (x < b.bbox[0] || x > b.bbox[2] || z < b.bbox[1] || z > b.bbox[3]) return;
      for (let p = 0; p < b.parts.length; p++) {
        if (partContains(b.parts[p], x, pv)) { found = b; return false; }
      }
    });
    return found;
  }

  /**
   * Circle-vs-footprint resolution.
   *
   * `feetY` is optional and is what makes an underpass walkable: a footprint is a flat 2-D
   * obstacle only for someone at the same level as it. Give it the walker's feet and a record
   * whose massing starts over their head — the rail deck across a teamway, Rogers Centre's
   * overhang — stops blocking, as does any wall a corridor or building passage has had a portal
   * cut through (the same portal `punchCorridorPortals` took out of the geometry, from the same
   * field, so what you can see through is exactly what you can walk through). Called with three
   * arguments, as every prop and pedestrian pass does, it behaves exactly as it always has.
   *
   * Note that collision reads `parts`, which is prepared for EVERY building at load and never
   * evicted: the player must not be able to walk through a tower merely because its geometry is
   * not resident.
   */
  function collide(x, z, r, feetY) {
    const out = { x, z, hit: false };
    if (!isNum(x) || !isNum(z)) return out;
    const rad = isNum(r) && r > 0 ? r : 0.5;
    const walker = isNum(feetY);
    const headY = walker ? feetY + PASS_HEAD : 0;
    let px = x, pz = z;
    // Resolve the DEEPEST overlap first and only that one per pass. Applying every candidate in
    // sequence oscillates forever between footprints that share a party wall: each ejection lands
    // the point inside the neighbour, which ejects it straight back.
    let lastNx = 1, lastNv = 0;
    // The head of the opening at the walker's feet, if they are standing in a corridor or a
    // passage at all. Read once per pass, not once per candidate footprint.
    let openY = -Infinity;
    const openAt = (cx, cz) => {
      if (!walker) return -Infinity;
      const sp = gradeField.span(cx, cz);
      if (!sp || sp.d2 > sp.chw * sp.chw) return -Infinity;
      return terrainY(cx, cz) - sp.dep + (sp.pass ? PASSAGE_HEAD : UNDER_CLEAR);
    };
    const blocks = (b) => !(walker && (b.y >= headY || headY <= openY));
    for (let pass = 0; pass < 8; pass++) {
      const cx = px, cz = pz, pv = -pz;
      let bestPush = 1e-6, bnx = 0, bnv = 0;
      openY = openAt(cx, cz);
      bIndex.query(cx, cz, rad + 1, (b) => {
        if (!b.parts || !blocks(b)) return;
        if (cx < b.bbox[0] - rad || cx > b.bbox[2] + rad ||
          cz < b.bbox[1] - rad || cz > b.bbox[3] + rad) return;
        for (let p = 0; p < b.parts.length; p++) {
          const part = b.parts[p];
          const pb = part.bbox;
          if (cx < pb[0] - rad || cx > pb[2] + rad || pv < pb[1] - rad || pv > pb[3] + rad) continue;
          const inside = partContains(part, cx, pv);
          const best = closestOnRing(part.outer, cx, pv);
          let bd2 = best.d2, bx = best.x, by = best.y;
          for (let k = 0; k < part.holes.length; k++) {
            const c = closestOnRing(part.holes[k], cx, pv);
            if (c.d2 < bd2) { bd2 = c.d2; bx = c.x; by = c.y; }
          }
          const d = Math.sqrt(bd2);
          if (!inside && d >= rad) continue;
          const push = inside ? d + rad : rad - d;
          if (push <= bestPush) continue;
          let nx = cx - bx, nv = pv - by;
          let nl = Math.hypot(nx, nv);
          if (nl < 1e-6) {
            // Dead centre on an edge: fall back to the direction away from the part's first vertex.
            nx = cx - part.co[0]; nv = pv - part.co[1];
            nl = Math.hypot(nx, nv);
            if (nl < 1e-6) { nx = 1; nv = 0; nl = 1; }
          }
          nx /= nl; nv /= nl;
          if (inside) { nx = -nx; nv = -nv; }
          bestPush = push; bnx = nx; bnv = nv;
        }
      });
      if (bestPush <= 1e-6) break;
      px += bnx * bestPush;
      pz -= bnv * bestPush;
      lastNx = bnx; lastNv = bnv;
      out.hit = true;
    }
    // Last resort: a point trapped between footprints that share a party wall cannot be pushed out
    // by any single normal, because both neighbours claim the same edge. Ring-search outward for
    // the closest genuinely free spot instead of leaving the player inside a wall.
    const trapped = (qx, qz) => {
      const b = buildingAt(qx, qz);
      if (!b) return false;
      return !(walker && (b.y >= headY || headY <= openAt(qx, qz)));
    };
    if (out.hit && trapped(px, pz)) {
      const baseAng = Math.atan2(-lastNv, lastNx);
      let found = false;
      for (let ring = 1; ring <= 16 && !found; ring++) {
        const rr = rad + ring * 1.5;
        for (let a = 0; a < 16; a++) {
          const ang = baseAng + (a % 2 ? -1 : 1) * Math.ceil(a / 2) * (Math.PI / 8);
          const qx = px + Math.cos(ang) * rr;
          const qz = pz + Math.sin(ang) * rr;
          if (!trapped(qx, qz)) { px = qx; pz = qz; found = true; break; }
        }
      }
    }
    // THE WORLD BOUNDARY (CONTRACT §9.3). A backstop, not the mechanism: what actually stops the
    // camera is confine(), which bleeds the OUTWARD component of its velocity to nothing over
    // SOFT_EASE metres so it coasts to a halt instead of striking a plane. This clamp exists so
    // that nothing else — a teleport, an ejection from a footprint, a recovery from NaN — can
    // leave anyone outside the world. Idempotent, so clamping a clamped point does nothing.
    if (px < -LIMITS.x) { px = -LIMITS.x; out.hit = true; }
    else if (px > LIMITS.x) { px = LIMITS.x; out.hit = true; }
    if (pz < -LIMITS.z) { pz = -LIMITS.z; out.hit = true; }
    else if (pz > LIMITS.z) { pz = LIMITS.z; out.hit = true; }
    out.x = px; out.z = pz;
    return out;
  }

  /* ---------------------------------------------------------- the soft limit */

  /**
   * How far into the deceleration band a point is: 0 anywhere the player is free, rising to 1 at
   * the limit itself. Read it for a HUD line, a vignette or a compass cue — this is the "if there
   * is a natural way to signal it, use that" half of CONTRACT §9.3.
   */
  function limitFrac(x, z) {
    if (!isNum(x) || !isNum(z)) return 0;
    const gx = limitAxis(x, LIMITS.x, LIMITS.ease);
    const gz = limitAxis(z, LIMITS.z, LIMITS.ease);
    return 1 - Math.min(gx, gz);
  }

  /**
   * Ease the camera to a halt at the world's soft limit.
   *
   * Call once per frame from the movement update, AFTER integrating position, with the player
   * object (anything carrying x, z and optionally vx, vz). Only the component of velocity trying
   * to LEAVE the world is scaled, and only inside the last SOFT_EASE metres, so motion along the
   * boundary and motion back inward are never touched and turning round is instant. Returns the
   * same 0..1 the band reads, for whatever the HUD wants to do with it.
   */
  function confine(p) {
    if (!p || !isNum(p.x) || !isNum(p.z)) return 0;
    const gx = limitAxis(p.x, LIMITS.x, LIMITS.ease);
    const gz = limitAxis(p.z, LIMITS.z, LIMITS.ease);
    if (gx < 1 && isNum(p.vx) && p.vx * p.x > 0) p.vx *= gx;
    if (gz < 1 && isNum(p.vz) && p.vz * p.z > 0) p.vz *= gz;
    if (p.x < -LIMITS.x) p.x = -LIMITS.x; else if (p.x > LIMITS.x) p.x = LIMITS.x;
    if (p.z < -LIMITS.z) p.z = -LIMITS.z; else if (p.z > LIMITS.z) p.z = LIMITS.z;
    return 1 - Math.min(gx, gz);
  }

  /* --------------------------------------------------------- street naming */
  const sIndex = makeGridIndex(64, -extent.x / 2 - 400, -extent.z / 2 - 400,
    Math.ceil((extent.x + 800) / 64) + 1, Math.ceil((extent.z + 800) / 64) + 1);
  for (let i = 0; i < roadsRaw.length; i++) {
    const r = roadsRaw[i];
    // A tunnel is still a street, and the HUD should say so when you are standing in it.
    if (!r || !r.n || !Array.isArray(r.p) || r.p.length < 2) continue;
    if (G.kind[i] === WAY_SUB) continue;               // ...but the concourse is a level below
    for (let k = 1; k < r.p.length; k++) {
      const a = r.p[k - 1], b = r.p[k];
      if (!isNum(a[0]) || !isNum(b[0])) continue;
      sIndex.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]),
        [a[0], a[1], b[0], b[1], r.n]);
    }
  }

  function streetNameAt(x, z, maxDist = 25) {
    if (!isNum(x) || !isNum(z)) return '';
    let best = maxDist * maxDist, name = '';
    sIndex.query(x, z, maxDist, (s) => {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const l2 = dx * dx + dz * dz;
      let t = 0;
      if (l2 > EPS) t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1);
      const qx = s[0] + dx * t, qz = s[1] + dz * t;
      const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d2 < best) { best = d2; name = s[4]; }
    });
    return name;
  }

  return { buildingAt, collide, limitFrac, confine, streetNameAt };
}

export { makeQuerySurface };
