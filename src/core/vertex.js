// src/core/vertex.js — THE vertex format. One file, one definition.
//
// CONTRACT.md Amendment 11.2: the format has already changed three times (11 -> 12 -> 13 -> 14
// floats) and every change cost a hunt through the tree for bare strides. Nothing anywhere else
// may hard-code 14, or 13, or a byte offset into a vertex. Import from here. When the format
// changes next, this file and the shaders are the only things that have to know.
//
// VERTEX FORMAT (NORMATIVE, 14 floats, non-indexed triangles):
//
//   float  bytes  attribute  location  contents
//   -----  -----  ---------  --------  ---------------------------------------------------
//       0     12  aPos          0      px, py, pz          world metres
//       3     12  aNormal       1      nx, ny, nz          unit, outward
//       6     12  aColor        2      r, g, b             linear albedo (never lit, never AO'd)
//       9     16  aMat          3      emissive, tintable, rough, profile
//      13      4  aUv           4      PACKED texture coordinate — see below
//
// Winding: counter-clockwise = front face (the renderer culls BACK faces).
//
// aMat channels:
//   emissive  the surface is a light source in the real world. Never a "look" — CONTRACT §7.1.
//   tintable  responds to the renderer's uTint. 0 on all static city geometry.
//   rough     0 = mirror-smooth, 1 = fully matte.
//   profile   night-lighting behaviour of the surface, NOT a colour —
//               0 envelope    no windows at all: stadiums, domes, the CN Tower shaft, roofs
//               1 office      strict curtain-wall grid, warm + cool fluorescent, dark floors
//               2 residential scattered per-unit warm points, balcony spill, occasional TV blue
//               3 retail      bright lit ground floor, mostly dark above
//               4 parking     open horizontal deck strips, greenish
//               5 civic       small punched windows, mostly dark, warm
//
// WHY aUv IS ONE FLOAT AND NOT TWO. Text in the world (src/render/text.js) needs a texture
// coordinate into the runtime glyph atlas, and nothing else in the city needs one — every other
// surface is vertex-coloured or procedural. But the format is shared: the resident set runs at the
// tile manager's 11 M-vertex cap, so a vec2 UV would add 88 MB of vertex data and 15% of the vertex
// fetch bandwidth of the whole city to serve well under 1% of its vertices. One float halves
// that to 44 MB and 7.7%.
//
// The channel still carries a full [0,1]^2 coordinate: u and v are quantised to 12 bits each and
// packed as u * 4096 + v, which tops out at 2^24 - 1 and is therefore EXACT in a float32 (24-bit
// mantissa) — nothing is lost in the buffer, in the attribute fetch or in the highp decode. The
// only loss is the quantisation itself, 1/4095 of the atlas, which on the 1008 x 792 atlas
// text.js builds is a quarter of a texel at a glyph CORNER; the decode happens in the vertex stage
// and the varying interpolates the decoded vec2, so nothing accumulates across the quad.
//
// Decode with GLSL_UV below (vhUnpackUv), which is exported from here so the pack and the unpack
// can never drift apart. Vertices that never call MeshBuilder.uv() carry 0, which decodes to
// (0, 0) and is ignored by every shader that does not sample a texture.
//
// Zero dependencies. Nothing may be imported into this file — it is the root of the graph.

export const VERT_FLOATS = 14;
export const ATTR = { pos: 0, normal: 1, color: 2, mat: 3, uv: 4 };

/** Float index of the first component of each attribute within one vertex. */
export const VERT_OFFSET = { pos: 0, normal: 3, color: 6, mat: 9, uv: 13 };

/** Component count of each attribute. Must sum to VERT_FLOATS. */
export const VERT_SIZE = { pos: 3, normal: 3, color: 3, mat: 4, uv: 1 };

/** Bytes between the start of one vertex and the start of the next. */
export const VERT_STRIDE = VERT_FLOATS * 4;

// 12 bits per axis. UV_STEPS * UV_SCALE + UV_STEPS = 16,777,215 = 2^24 - 1, the largest integer
// a float32 represents exactly.
export const UV_STEPS = 4095;
export const UV_SCALE = 4096;

/** Quantise a [0,1]^2 texture coordinate into the single float aUv carries. */
export function packUv(u, v) {
  const uu = u <= 0 ? 0 : (u >= 1 ? UV_STEPS : Math.round(u * UV_STEPS));
  const vv = v <= 0 ? 0 : (v >= 1 ? UV_STEPS : Math.round(v * UV_STEPS));
  return uu * UV_SCALE + vv;
}

// The matching decode, for any shader that samples with aUv. Exact for every value packUv emits:
// the divide is by a power of two, so floor() lands on the integer u and the remainder is v.
export const GLSL_UV = [
  'vec2 vhUnpackUv(float p) {',
  '  float u = floor(p * (1.0 / ' + UV_SCALE.toFixed(1) + '));',
  '  return vec2(u, p - u * ' + UV_SCALE.toFixed(1) + ') * (1.0 / ' + UV_STEPS.toFixed(1) + ');',
  '}',
].join('\n');
