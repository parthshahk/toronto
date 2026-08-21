// src/core/util.js — the small shared predicates and the position hashes.
//
// Everything here is stateless, allocation-free and depends on nothing. It sits at the bottom of
// the graph beside vertex.js and math.js: geom, world, city and props may all import it, and it
// may import nothing back.
//
// POSITION HASHING. CONTRACT §8.4 requires every procedural choice to be keyed on a WORLD
// POSITION, never on an array index, so a building looks the same whether or not its neighbours
// were loaded and a tile builds the same geometry in any order. Two distinct mixers are in use
// and they are NOT interchangeable — each one's exact arithmetic is baked into the geometry the
// city currently emits, so they are both kept, verbatim, and merely given one home:
//
//   hashPos(x, z, salt)   quantises to 1/4 m and takes a salt, so one position can drive many
//                         independent choices. Used by the building, frontage and surround passes.
//   hashCell(x, z, q)     quantises to 1/q m with no salt; callers separate their draws by
//                         offsetting the position instead. q = 64 for street props, q = 32 for
//                         the harbour.
//
// Both return [0, 1). Both are pure functions of their arguments and of nothing else.

/** True for a real, finite JS number. Rejects NaN, the infinities, strings and null. */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Sign of v as -1, 0 or +1. Zero and -0 both give 0. */
export function sgn(v) {
  return v > 0 ? 1 : (v < 0 ? -1 : 0);
}

/**
 * Deterministic [0, 1) from a world position and a salt. Quantum 1/4 metre: two points closer
 * together than that hash alike, which is what makes a footprint's choices stable under the
 * sub-millimetre drift of a re-associated coordinate expression.
 */
export function hashPos(x, z, salt = 0) {
  let h = Math.imul(Math.round(x * 4) | 0, 374761393) ^ Math.imul(Math.round(z * 4) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 2654435761);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Deterministic [0, 1) from a world position quantised to 1/q metre. Lets signal phase, canopy
 * lean and similar per-instance choices vary across the city without threading an rng through a
 * contract signature that has none.
 */
export function hashCell(x, z, q) {
  const a = Math.imul((((x * q) | 0) ^ 0x27d4eb2d) | 0, 0x9e3779b1);
  const b = Math.imul((((z * q) | 0) ^ 0x165667b1) | 0, 0x85ebca6b);
  let h = (a ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}
