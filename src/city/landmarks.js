// src/city/landmarks.js — the named towers, and the one building modelled by hand.
//
// CONTRACT.md §1 and Amendment 11.1. Two things live here, both moved out of city.js verbatim:
//
//   1. THE LANDMARK TABLE and the claim pass that matches a massing record to it. The table is a
//      FALLBACK for the material class; a surveyed `building:colour` still wins over it.
//   2. THE CN TOWER. The massing dataset stops at the SkyPod (443 m) and omits the antenna mast,
//      so the silhouette that everyone recognises has to be modelled: flared three-legged base,
//      tapering hexagonal shaft, pod, SkyPod and mast to 553.33 m.
//
// No lighting assumption is baked anywhere (CONTRACT §7.1): the tower's lighting rig is emissive
// because it is a real lighting rig, at emissive >= EMITTER_MIN so nothing can mistake it for a
// facade window hint, and the renderer owns when it is on.

import { setMat, M } from './materials.js';
import { emitPrism, ringPts } from '../geom/extrude.js';

// Landmarks, matched by real lon/lat AND by known height — the financial district is dense enough
// that proximity alone paints the wrong tower. `tol` is the fractional height window.
//
// These are now a FALLBACK, not the authority: `building:colour` from OSM covers 730 buildings
// including every one of these, and where it exists it wins (it agrees with the hand values and
// reaches far more of the city). What the table still contributes is the material CLASS — the
// surveyed colour tags carry no `building:material` for Scotia Plaza or the TD towers, and red
// granite versus red glass is the difference between a specular tower and a matte one.
const LANDMARKS = [
  { key: 'td', lon: -79.3814, lat: 43.6475, h: 223, radius: 140, tol: 0.09, minH: 60,
    cls: 'steel', srgb: 0x131313, name: 'TD Centre' },
  { key: 'rbp', lon: -79.3803, lat: 43.6461, h: 180, radius: 100, tol: 0.09, minH: 95,
    cls: 'glass', srgb: 0xffd600, name: 'Royal Bank Plaza' },
  { key: 'rbp2', lon: -79.3803, lat: 43.6461, h: 113, radius: 100, tol: 0.09, minH: 90,
    cls: 'glass', srgb: 0xffd600, name: 'Royal Bank Plaza' },
  { key: 'fcp', lon: -79.3817, lat: 43.6487, h: 292, radius: 90, tol: 0.09, minH: 150,
    cls: 'marble', srgb: 0xf4f2ec, name: 'First Canadian Place' },
  { key: 'scotia', lon: -79.3794, lat: 43.6486, h: 275, radius: 160, tol: 0.09, minH: 150,
    cls: 'granite', srgb: 0x5a1410, name: 'Scotia Plaza' },
  { key: 'ccw', lon: -79.3794, lat: 43.6475, h: 239, radius: 130, tol: 0.06, minH: 150,
    cls: 'metal', srgb: 0xc9c3ba, name: 'Commerce Court West' },
  { key: 'cn', lon: -79.3871, lat: 43.6426, h: 443, radius: 120, tol: 0.10, minH: 200,
    cls: 'concrete', srgb: 0x9ea1a6, name: 'CN Tower' },
];

const LANDMARK_INHERIT_R = 48.0;   // stacked massing slabs of the same tower
const LANDMARK_INHERIT_H = 0.75;
function assignLandmarks(buildings, project) {
  const pts = LANDMARKS.map((L) => {
    const p = project(L.lon, L.lat);
    return { L, x: p[0], z: p[1] };
  });
  const claim = new Array(buildings.length).fill(null);
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    let best = null, bestScore = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const { L, x, z } = pts[k];
      if (b.h < L.minH) continue;
      const d = Math.hypot(b.cx - x, b.cz - z);
      if (d > L.radius) continue;
      const hd = Math.abs(b.h - L.h) / L.h;
      if (hd > L.tol) continue;
      const score = hd * 2.0 + d / L.radius;
      if (score < bestScore) { bestScore = score; best = L; }
    }
    if (best) claim[i] = best;
  }
  // One non-cascading expansion pass: stacked massing slabs of a claimed tower inherit its material.
  const seeds = [];
  for (let i = 0; i < claim.length; i++) if (claim[i]) seeds.push(i);
  for (let i = 0; i < buildings.length; i++) {
    if (claim[i]) continue;
    const b = buildings[i];
    for (let s = 0; s < seeds.length; s++) {
      const o = buildings[seeds[s]];
      if (b.h < o.h * LANDMARK_INHERIT_H) continue;
      if (Math.hypot(b.cx - o.cx, b.cz - o.cz) > LANDMARK_INHERIT_R) continue;
      claim[i] = claim[seeds[s]];
      break;
    }
  }
  return claim;
}

/* =============================================================== CN Tower == */
// The massing dataset stops at the SkyPod (443 m) and omits the mast. The silhouette is the single
// most recognisable object in the scene, so it is modelled by hand: flared three-legged base,
// tapering hexagonal shaft, main pod at 342-372 m, SkyPod at 432-448 m, mast to 553.33 m.

const CN_PROFILE = [
  [0, 30.0], [10, 26.5], [26, 21.0], [46, 17.2], [96, 14.2], [180, 12.2], [300, 10.3], [330, 9.7],
  [333, 12.0], [338, 21.0], [342, 26.2], [346, 27.4], [357, 27.4], [360, 25.0], [366, 17.0],
  [372, 10.6], [382, 9.0], [428, 7.5], [432, 8.2], [436, 12.2], [443, 12.2], [446, 8.0],
  [448, 4.8], [452, 4.3], [470, 3.8], [500, 2.6], [524, 1.8], [545, 0.95], [553.33, 0.42],
];

// The tower is profile 0 — it has no windows, it has a LIGHTING RIG, and that rig is its
// identity. Four channels carry it, all of them emissive >= EMITTER_MIN so nothing here can be
// mistaken for a facade window hint: cast-concrete shaft, an LED wash climbing the three ribs,
// the two glazing bands at the pod and the SkyPod, and red aviation beacons up the mast.
const CN_MAST_Y = 448.0;

function emitCNTower(mbOpaque, mbGlass, mbProps, cx, cz, baseY) {
  const seg = 14;
  const cu = cx, cv = -cz;
  let mast = false;
  setMat(mbOpaque, M.cnShaft);
  for (let i = 0; i + 1 < CN_PROFILE.length; i++) {
    const a = CN_PROFILE[i], b = CN_PROFILE[i + 1];
    if (!mast && a[0] >= CN_MAST_Y) { mast = true; setMat(mbOpaque, M.cnMast); }
    const ra = ringPts(cu, cv, Math.max(0.05, a[1]), seg, 0);
    const rb = ringPts(cu, cv, Math.max(0.05, b[1]), seg, 0);
    emitPrism(mbOpaque, ra, rb, baseY + a[0], baseY + b[0], i + 2 === CN_PROFILE.length);
  }
  // Three structural ribs give the Y cross-section its silhouette — and they are what the LED
  // wash actually lights, so they double as the accent lines running up the shaft.
  setMat(mbOpaque, M.cnLed);
  const ribSteps = [[0, 30.0, 9.0, 7.5], [46, 17.2, 6.0, 5.0], [180, 12.2, 4.2, 3.4],
    [300, 10.3, 3.2, 2.6], [330, 9.7, 2.6, 2.2]];
  for (let r = 0; r < 3; r++) {
    const ang = (r / 3) * Math.PI * 2 + Math.PI / 6;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let s = 0; s + 1 < ribSteps.length; s++) {
      const a = ribSteps[s], b = ribSteps[s + 1];
      const quad = (rad, out, half) => {
        const bu = cu + ca * rad, bv = cv + sa * rad;
        const ou = ca * out, ov = sa * out;
        const hu = -sa * half, hv = ca * half;
        return [bu - hu, bv - hv, bu + ou - hu * 0.55, bv + ov - hv * 0.55,
          bu + ou + hu * 0.55, bv + ov + hv * 0.55, bu + hu, bv + hv];
      };
      emitPrism(mbOpaque, quad(a[1] * 0.55, a[2], a[3]), quad(b[1] * 0.55, b[2], b[3]),
        baseY + a[0], baseY + b[0], false);
    }
  }
  // Pod glazing: the lit bands that make the tower read at blue hour. Cool white-blue, not the
  // office amber every other window in the old build wore.
  setMat(mbGlass, M.cnPod);
  emitPrism(mbGlass, ringPts(cu, cv, 27.6, seg * 2, 0), ringPts(cu, cv, 27.6, seg * 2, 0),
    baseY + 346.5, baseY + 355.5, false);
  setMat(mbGlass, M.cnSky);
  emitPrism(mbGlass, ringPts(cu, cv, 12.4, seg, 0), ringPts(cu, cv, 12.4, seg, 0),
    baseY + 437.0, baseY + 442.0, false);
  // Aviation beacons up the mast (kept inside the 553.33 m tip).
  setMat(mbProps, M.beacon);
  const beacons = [370, 447, 498, 540];
  for (let i = 0; i < beacons.length; i++) mbProps.sphere(cx, baseY + beacons[i], cz, 1.1, 4);
}

export { LANDMARKS, assignLandmarks, emitCNTower };
