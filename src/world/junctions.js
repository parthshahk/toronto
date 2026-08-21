// src/world/junctions.js — the corners: dropped kerbs, tactile plates and the corner record.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged.
//
// An intersection is derived in the loader from where road polylines ACTUALLY meet — OSM ways
// share a node at a junction, so every vertex is hashed and the distinct branch directions
// arriving there are counted. What this module does with that is the ground-level half: a kerb
// ramp at every corner of a crossing, with its flares and a tactile plate, and a `corners` record
// the props passes later hang signals, blades and waiting pedestrians off.

import { clamp, TAU } from '../core/math.js';
import { partContains } from '../geom/ring.js';
import { makeGridIndex } from '../data/index.js';
import { isNum } from '../core/util.js';
import { appendTrafficSignal, appendSignPost } from '../props/index.js';
import { M, setMat, SIGN_CLASS } from '../city/materials.js';
import { ROAD_Y, CURB, ROAD_CLASS_OK, triUp } from './ground.js';
import { WAY_OVER } from './grade.js';
import { inAcornZone, inFootprint, kerbSeat, reserve } from './context.js';

const RAMP_W = 1.85;               // kerb ramp, flare included
const RAMP_RUN = 1.55;
/* ============================================================== kerb ramps == */

// A dropped kerb with its flares and a tactile plate. (dx, dz) points DOWN the slope, i.e. from
// the sidewalk toward the carriageway.
function emitKerbRamp(C, x, z, dx, dz) {
  const mb = C.mb.sidewalks;
  const px = -dz, pz = dx;
  const hw = RAMP_W * 0.5;
  const g = C.groundY(x, z);
  const yT = g + ROAD_Y + CURB;
  const yB = g + ROAD_Y + 0.014;
  const bx = x + dx * RAMP_RUN * 0.5, bz = z + dz * RAMP_RUN * 0.5;
  const tx = x - dx * RAMP_RUN * 0.5, tz = z - dz * RAMP_RUN * 0.5;

  setMat(mb, M.curb);
  triUp(mb, tx - px * hw, yT, tz - pz * hw, tx + px * hw, yT, tz + pz * hw,
    bx + px * hw, yB, bz + pz * hw);
  triUp(mb, tx - px * hw, yT, tz - pz * hw, bx + px * hw, yB, bz + pz * hw,
    bx - px * hw, yB, bz - pz * hw);
  // Flares, so the ramp meets full kerb height at its sides instead of ending in a cliff.
  const fw = hw + 0.62;
  triUp(mb, tx - px * hw, yT, tz - pz * hw, bx - px * hw, yB, bz - pz * hw,
    tx - px * fw, yT, tz - pz * fw);
  triUp(mb, tx + px * hw, yT, tz + pz * hw, tx + px * fw, yT, tz + pz * fw,
    bx + px * hw, yB, bz + pz * hw);
  // Tactile plate across the bottom of the run.
  setMat(mb, M.tactile);
  const ax0 = bx - dx * 0.66, az0 = bz - dz * 0.66;
  const ax1 = bx - dx * 0.10, az1 = bz - dz * 0.10;
  const yP = yB + 0.010;
  triUp(mb, ax0 - px * hw, yP, az0 - pz * hw, ax0 + px * hw, yP, az0 + pz * hw,
    ax1 + px * hw, yP, az1 + pz * hw);
  triUp(mb, ax0 - px * hw, yP, az0 - pz * hw, ax1 + px * hw, yP, az1 + pz * hw,
    ax1 - px * hw, yP, az1 - pz * hw);
  C.stats.ground.kerbRamps++;
}

// One ramp per corner: on the bisector between each adjacent pair of branches.
function emitJunctionKerbs(C, J) {
  const nb = J.dirs.length / 2;
  if (nb < 3 || J.r < 3.2) return;
  const ang = [];
  for (let i = 0; i < J.dirs.length; i += 2) ang.push(Math.atan2(-J.dirs[i + 1], J.dirs[i]));
  ang.sort((a, b) => a - b);
  for (let i = 0; i < ang.length; i++) {
    const a0 = ang[i];
    const a1 = i + 1 < ang.length ? ang[i + 1] : ang[0] + TAU;
    const gap = a1 - a0;
    if (gap < 0.55) continue;                       // two branches too close to fit a corner
    const phi = a0 + gap * 0.5;
    const cu = Math.cos(phi), cv = Math.sin(phi);   // plan space: u east, v north
    const rad = J.r + 2.55;
    const x = J.x + cu * rad, z = J.z - cv * rad;
    if (inFootprint(C, x, z, 0.9)) continue;
    if (!C.occ.claim(x, z, 1.15)) continue;
    emitKerbRamp(C, x, z, -cu, cv);                 // down-slope points back at the junction
    // A crossing corner: where somebody waiting for a light actually stands. Set back far enough
    // from the ramp's own claim that a figure and a tactile plate do not want the same square.
    const back = J.r + 4.4;
    C.corners.push({
      x: J.x + cu * back, z: J.z - cv * back, dx: -cu, dz: cv, signal: !!J.signal,
    });
  }
}

// A street name as a BLADE carries it. Toronto abbreviates on the sign — QUEEN ST W, not Queen
// Street West — and the abbreviation is what makes a 900 mm plate legible from the far kerb.
const BLADE_ABBREV = [
  [/\bStreet\b/gi, 'ST'], [/\bAvenue\b/gi, 'AVE'], [/\bRoad\b/gi, 'RD'],
  [/\bBoulevard\b/gi, 'BLVD'], [/\bDrive\b/gi, 'DR'], [/\bCrescent\b/gi, 'CRES'],
  [/\bPlace\b/gi, 'PL'], [/\bCourt\b/gi, 'CRT'], [/\bTerrace\b/gi, 'TERR'],
  [/\bParkway\b/gi, 'PKWY'], [/\bSquare\b/gi, 'SQ'], [/\bTrail\b/gi, 'TR'],
  [/\bLane\b/gi, 'LANE'], [/\bCircle\b/gi, 'CIR'], [/\bGardens\b/gi, 'GDNS'],
  [/\bHeights\b/gi, 'HTS'], [/\bQuay\b/gi, 'QUAY'],
  [/\bWest\b/gi, 'W'], [/\bEast\b/gi, 'E'], [/\bNorth\b/gi, 'N'], [/\bSouth\b/gi, 'S'],
  [/\bSaint\b/gi, 'ST'],
];

function bladeText(name) {
  if (typeof name !== 'string' || !name) return '';
  let s = name;
  for (let i = 0; i < BLADE_ABBREV.length; i++) s = s.replace(BLADE_ABBREV[i][0], BLADE_ABBREV[i][1]);
  s = s.replace(/\s+/g, ' ').trim().toUpperCase();
  return s.length > 22 ? s.slice(0, 22) : s;
}

// Signal heads and a street-name blade at the junctions that warrant them.
function placeJunctionProps(C, J) {
  const mbP = C.mb.props;
  const sx = J.x + Math.cos(J.signAng) * (J.r + 5.0);
  const sz = J.z - Math.sin(J.signAng) * (J.r + 5.0);
  const sy = reserve(C, 'signPost', sx, sz, 0.5, 0.3);
  if (isNum(sy)) {
    // THE BLADES. This is what makes a corner identifiable: white plate, blue legend, the name
    // abbreviated the way the real ones are, sized to the name it carries.
    const a = bladeText(J.names[0] || '');
    const b = bladeText(J.names[1] || '');
    appendSignPost(mbP, C.rng, sx, sy + kerbSeat(C, sx, sz), sz, J.signAng, {
      a, b, font: C.font, textMb: C.mb[SIGN_CLASS], heritage: inAcornZone(J.x, J.z),
    });
    if (a) C.stats.facades.textBlades++;
    if (b) C.stats.facades.textBlades++;
  }
  if (!J.signal) return;
  const dirs = J.dirs;
  const want = Math.min(dirs.length / 2, 2);
  for (let i = 0; i < want; i++) {
    const dx = dirs[i * 2], dz = dirs[i * 2 + 1];
    // Near-side right-hand corner of the approach this branch carries toward the junction.
    const rx = dz, rz = -dx;
    const x = J.x + dx * (J.r + 2.9) + rx * (J.r + 1.9);
    const z = J.z + dz * (J.r + 2.9) + rz * (J.r + 1.9);
    const y = reserve(C, 'trafficSignal', x, z, 1.3, 0.3);
    if (!isNum(y)) continue;
    // props.js: the lamp faces look along world (-sin yaw, 0, -cos yaw). Point them back up the
    // approach, which puts the mast arm out across it.
    appendTrafficSignal(mbP, x, y + kerbSeat(C, x, z), z, Math.atan2(-dx, -dz),
      clamp(J.r + 1.2, 3.0, 11.0));
  }
}


/**
 * Build the intersection graph from where road polylines ACTUALLY meet.
 *
 * OSM ways share a node at a junction, so every vertex is hashed and the distinct branch
 * directions arriving there are counted: a way merely split in two contributes one branch each
 * way and stays a straight street, while three or more distinct directions is a real
 * intersection. Where the survey carries a traffic signal it wins over the branch-count rule,
 * because 573 surveyed nodes KNOW which junctions are signalised and a rule of thumb only guesses.
 *
 * Also records each junction on the road records that reach it, measures the dominant street-grid
 * bearing (an accuracy invariant, not decoration), and returns the surveyed-footprint predicate
 * every later pass uses to tell a real building from a synthesised one.
 *
 * @returns {{junctions: Map, realFoot: Function}}
 */
function buildJunctionGraph(W) {
  const { roadsRaw, roadJobs, recs, G, extent, gx0, gz0, poisRaw, bIndex, stats } = W;

  // Derived from where road polylines ACTUALLY meet: OSM ways share a node at a junction, so
  // every vertex is hashed and the branch directions arriving there are counted. A way merely
  // split in two contributes one branch each way and stays a straight street; three or more
  // distinct directions is a real intersection.
  const jkey = (x, z) => Math.round(x * 4) + ':' + Math.round(z * 4);
  const nodes = new Map();
  const addDir = (nd, dx, dz) => {
    const l = Math.hypot(dx, dz);
    if (!(l > 0.05)) return false;
    const ux = dx / l, uz = dz / l;
    for (let k = 0; k < nd.dirs.length; k += 2) {
      if (nd.dirs[k] * ux + nd.dirs[k + 1] * uz > 0.985) return false;
    }
    nd.dirs.push(ux, uz);
    return true;
  };
  for (let i = 0; i < roadJobs.length; i++) {
    const gi = roadJobs[i];
    const r = roadsRaw[gi];
    const cls = ROAD_CLASS_OK[r.c] ? r.c : 'minor';
    if (G.kind[gi] === WAY_OVER ||
      (cls !== 'motorway' && cls !== 'major' && cls !== 'minor')) continue;
    const big = cls !== 'minor';
    const hw = clamp(isNum(r.w) ? r.w : 8, 1.6, 44) / 2;
    const p = r.p;
    for (let k = 0; k < p.length; k++) {
      if (!isNum(p[k][0]) || !isNum(p[k][1])) continue;
      const key = jkey(p[k][0], p[k][1]);
      let nd = nodes.get(key);
      if (!nd) {
        nd = {
          x: p[k][0], z: p[k][1], dirs: [], hw: 0, majors: 0,
          r: 0, cross: false, signal: false, signAng: 0,
          // The street names that meet here, longest carriageway first: what goes on the blades.
          names: [], surveyed: false,
        };
        nodes.set(key, nd);
      }
      if (hw > nd.hw) nd.hw = hw;
      const prev = k > 0 && addDir(nd, p[k - 1][0] - p[k][0], p[k - 1][1] - p[k][1]);
      const next = k < p.length - 1 &&
        addDir(nd, p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
      if (big) nd.majors += (prev ? 1 : 0) + (next ? 1 : 0);
    }
  }
  // Where the survey has a traffic signal, index it: which junctions are signalised is a fact
  // 573 surveyed nodes know and a rule of thumb over branch counts only guesses.
  const sigIdx = makeGridIndex(40, gx0, gz0,
    Math.ceil((extent.x + 800) / 40) + 1, Math.ceil((extent.z + 800) / 40) + 1);
  for (let i = 0; i < poisRaw.length; i++) {
    const q = poisRaw[i];
    if (q.k === 'signal') sigIdx.add(q.x, q.z, q.x, q.z, q);
  }
  const junctions = new Map();
  for (const [key, nd] of nodes) {
    if (nd.dirs.length < 6) continue;
    nd.r = clamp(nd.hw, 3.0, 16.0);
    nd.cross = nd.hw >= 5.0;
    nd.signal = nd.majors >= 2 && nd.hw >= 5.5;
    {
      const reach = nd.r + 14;
      const r2 = reach * reach;
      let found = false;
      sigIdx.query(nd.x, nd.z, reach, (q) => {
        if (found) return;
        const dx = q.x - nd.x, dz = q.z - nd.z;
        if (dx * dx + dz * dz < r2) { found = true; return false; }
      });
      if (found) {
        if (!nd.signal) stats.survey.signalsAdded++;
        nd.signal = true;
        nd.surveyed = true;
      }
    }
    const a0 = Math.atan2(-nd.dirs[1], nd.dirs[0]);
    let d = Math.atan2(-nd.dirs[3], nd.dirs[2]) - a0;
    while (d < 0) d += TAU;
    nd.signAng = a0 + d * 0.5;
    junctions.set(key, nd);
    stats.ground.junctions++;
    if (nd.signal) stats.ground.signalised++;
  }
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    let last = null;
    for (let k = 0; k < rec.pts.length; k++) {
      const J = junctions.get(jkey(rec.pts[k][0], rec.pts[k][1]));
      // Two vertices a few centimetres apart hash into the same 0.25 m bucket; recording both
      // would paint the crossing twice, in the same place, and z-fight it against itself.
      if (!J || J === last) continue;
      rec.junc.push({ s: rec.s[k], r: J.r, J });
      // A blade carries the name of the street it hangs over, so the junction has to know which
      // named carriageways reach it. Distinct names only; a way split in two contributes once.
      if (rec.name && J.names.length < 4 && J.names.indexOf(rec.name) < 0) J.names.push(rec.name);
      last = J;
    }
  }

  // Dominant street-grid bearing, folded into [0, 90): an accuracy invariant, not decoration.
  {
    const bins = new Float64Array(360);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.cls !== 'major' && rec.cls !== 'minor') continue;
      for (let k = 1; k < rec.pts.length; k++) {
        const dx = rec.pts[k][0] - rec.pts[k - 1][0];
        const dz = rec.pts[k][1] - rec.pts[k - 1][1];
        const l = Math.hypot(dx, dz);
        if (l < 2) continue;
        let a = Math.atan2(-dz, dx) * 180 / Math.PI;
        a = ((a % 90) + 90) % 90;
        bins[Math.min(359, Math.floor(a * 4))] += l;
      }
    }
    let best = 0;
    for (let i = 1; i < 360; i++) if (bins[i] > bins[best]) best = i;
    const deg = (best + 0.5) / 4;
    stats.gridDeg = deg > 45 ? 90 - deg : deg;
  }

  // Is a SURVEYED footprint here? Deliberately blind to the synthesised masses already in the
  // index, so the predicate answers the same question however many of them have been added.
  const realFoot = (x, z) => {
    if (!isNum(x) || !isNum(z)) return false;
    const pv = -z;
    let hit = false;
    bIndex.query(x, z, 0.5, (b) => {
      if (hit || b.surround || !b.parts) return;
      if (x < b.bbox[0] - 0.5 || x > b.bbox[2] + 0.5 ||
        z < b.bbox[1] - 0.5 || z > b.bbox[3] + 0.5) return;
      for (let p = 0; p < b.parts.length; p++) {
        if (partContains(b.parts[p], x, pv)) { hit = true; return false; }
      }
    });
    return hit;
  };

  return { junctions, realFoot };
}

export {
  buildJunctionGraph, emitKerbRamp, emitJunctionKerbs, bladeText, placeJunctionProps,
};
