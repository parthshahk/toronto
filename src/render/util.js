// src/render/util.js -- the render layer leaf: guards, the blend enum and the identity matrix.
//
// Everything here is imported by the other render modules and imports nothing but core/math.
// It exists so that renderer.js, shadows.js, lights.js, targets.js and the post passes can
// share these without any of them importing each other, which is what keeps the render layer
// acyclic (CONTRACT Amendment 11.2).

import { mat4 } from '../core/math.js';

// Blend modes tracked by the renderer.
export const BLEND_ALPHA = 1;
export const BLEND_MULTIPLY = 2;

// A neutral tint, and the vec3 fallback for any camera-derived uniform whose source is not
// finite yet. Never written to.
export const WHITE = new Float32Array([1, 1, 1]);

// The 4x4 identity, handed to uModel for anything drawn in world space.
export const IDENTITY = mat4();

// Message text out of anything throwable, without ever throwing itself.
export function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return (err.message ? err.message : String(err));
}

export function numOr(v, lo, hi, dflt) {
  if (!Number.isFinite(v)) return dflt;
  return v < lo ? lo : (v > hi ? hi : v);
}

export function boolOr(v, dflt) {
  if (v === true) return true;
  if (v === false) return false;
  return dflt;
}

export function isArrayLike(v) {
  return v !== null && typeof v === 'object' && typeof v.length === 'number' && v.length >= 4;
}

// Install a group of methods onto a prototype.
//
// The Renderer is one object with one lifetime, but its responsibilities are not one file: the
// cascade fit, the light rig, the offscreen targets and the post passes each own a module and
// hand their methods back as a plain object of shorthand methods. defineProperty rather than
// Object.assign, so they land NON-ENUMERABLE exactly as a method written inside the class body
// would, and nothing that walks an instance can tell the difference.
export function mixin(proto, ...groups) {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const keys = Object.keys(g);
    for (let k = 0; k < keys.length; k++) {
      Object.defineProperty(proto, keys[k], {
        value: g[keys[k]], writable: true, enumerable: false, configurable: true,
      });
    }
  }
  return proto;
}
