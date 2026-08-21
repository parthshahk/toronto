// src/world/audit.js — the ground-plane geometry audit, bound once per load.
//
// geom/ribbon.js is pure and takes the audit object as its last argument. Binding it to the live
// stats object is the loader's job, and this module is the single place that happens — which is
// why every ribbon call site in world/ still reads plainly. Moved out of city.js unchanged.
//
// The binding is module state, deliberately and unavoidably: it is a per-LOAD wiring, not a
// per-call argument, and threading a stats object through every ribbon emitter in the tree was
// exactly what this replaced. setAudit() is called once at the start of a load and again when a
// tile rebuild wants its counters sent to the scrap heap instead.

import { emitRibbon as emitRibbonGeom } from '../geom/ribbon.js';

// Ground-plane geometry audit, wired to stats once per load so the ribbon builders can report
// without threading a stats object through every call site. geom/ribbon.js is pure and takes the
// audit object as its last argument; binding it to the live stats is city.js's job, and this thin
// wrapper is the single place that happens — which is why every call below still reads plainly.
let _audit = null;

function emitRibbon(mb, pts, frames, cross, yAt, down) {
  return emitRibbonGeom(mb, pts, frames, cross, yAt, down, _audit);
}

/** Point every ribbon emitter's audit at `a` (a stats object, or null for none). */
export function setAudit(a) {
  _audit = a;
}

/** The currently bound audit object, for the few emitters that count their own defects. */
export function ribbonAudit() {
  return _audit;
}

export { emitRibbon };
