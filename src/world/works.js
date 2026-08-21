// src/world/works.js — service yards and building works.
//
// CONTRACT.md §6.3 and Amendment 11.1. Moved out of city.js unchanged. Two passes, both of them
// what a walker actually meets on a downtown block and neither of them worth a module of its own
// anywhere else:
//
//   placeServiceProps()  dumpsters down the alleys and the service frontages.
//   placeScaffold()      sidewalk sheds. Something downtown is always wrapped in one, so a couple
//                        of arterial blocks are tiled with sections of it.

import { isNum } from '../core/util.js';
import { appendDumpster, appendScaffold } from '../props/index.js';
import { ROAD_Y, SIDEWALK_W } from './ground.js';
import { kerbSeat, reserve } from './context.js';
import { recSample } from './roads.js';

/* =================================================== service yards and works == */

// Dumpsters down the alleys and service frontages.
function placeServiceProps(C, rec) {
  if (rec.cls !== 'service' || rec.len < 14) return;
  const rng = C.rng;
  const mbP = C.mb.props;
  const o = rec.hw + 1.15;
  for (let s = 7; s < rec.len - 5; s += 48) {
    if (rng() > 0.24) continue;
    const sgn = rng() < 0.5 ? 1 : -1;
    const m = recSample(rec, s);
    const x = m.x + m.sx * o * sgn, z = m.z + m.sz * o * sgn;
    const y = reserve(C, 'dumpster', x, z, 1.35, 0.25);
    if (!isNum(y)) continue;
    appendDumpster(mbP, rng, x, y + ROAD_Y, z, Math.atan2(m.sz * sgn, -m.sx * sgn));
  }
}

// Sidewalk sheds. Something downtown is always wrapped in one; tile a few sections so a couple of
// arterial blocks are under construction.
function placeScaffold(C, rec) {
  if (rec.cls !== 'major' || rec.len < 70 || !rec.commercial) return;
  const rng = C.rng;
  if (rng() > 0.10) return;
  const sgn = rng() < 0.5 ? 1 : -1;
  const s0 = 12 + rng() * (rec.len - 46);
  const o = (rec.hw + 0.25 + (SIDEWALK_W[rec.cls] || 3.8) * 0.5) * sgn;
  for (let k = 0; k < 4; k++) {
    const m = recSample(rec, s0 + k * 6.0);
    const x = m.x + m.sx * o, z = m.z + m.sz * o;
    const y = reserve(C, 'scaffold', x, z, 2.4, 0.3);
    if (!isNum(y)) continue;
    // The building face is at local -X and the kerb at +X, so "out" points at the road.
    appendScaffold(C.mb.props, rng, x, y + kerbSeat(C, x, z), z,
      Math.atan2(m.sz * sgn, -m.sx * sgn), 6.0, 3.8);
  }
}

export { placeServiceProps, placeScaffold };
