// src/render/shaders/lights.glsl.js -- the clustered local-light lookup and shading.
//
// The fragment half of the rig in render/lights.js: find the world-space cluster, walk its slot
// list, and accumulate diffuse and specular from every luminaire that reaches this fragment.
// The two grid constants come from lights.js so the CPU and the shader can never disagree
// about the shape of the tables.
// 
// No backticks -- see common.glsl.js.

import { LIGHT_GRID_N, LIGHT_SLOTS } from '../lights.js';

// --- LOCAL LIGHTS ------------------------------------------------------------------------------
// The street lamps, as actual lights. Until this existed the ONLY street lighting in the renderer
// was uStreetColor — one global uniform wash keyed on height above grade and multiplied by 0.30 on
// anything horizontal, which on 3%-reflectance asphalt at Night comes to about 0.002 linear. That
// is black. Every mast in the city carried a genuine emissive lens and lit nothing at all, because
// an emissive lens is a surface that is BRIGHT, not a surface that ILLUMINATES.
//
// So: real punctual lights, clustered in world space. See the LIGHT_* block at the top of this
// file for why the cluster grid is a 2-D world grid rather than a screen tiling.
//
// The rig is gated on nightFactor * (1 - daylight) at the point of use and NOTHING is baked:
// Afternoon multiplies it by exactly zero, Golden hour by 0.099, Blue hour by 0.86 and Night by
// 1.0, all of them read straight off the existing preset fields (CONTRACT Amendment 7).
//
// There are no shadow maps for these lights. A cascade set per lamp is out of the question at this
// count, and the alternative — omitting the lights — is what the previous build did. The reach is
// deliberately short (a windowed inverse square that is fully closed by ~32 m) and the cutoff term
// puts almost nothing above the head, so the leak is bounded to about a wall thickness: a lamp on
// the far side of a building lights a couple of metres of the near face and nothing else.
export const GLSL_LIGHTS = `
const int VH_LGRID = ${LIGHT_GRID_N};
const int VH_LSLOTS = ${LIGHT_SLOTS};

// Row 0 of uLightData: xyz = world position, w = influence radius.
// Row 1:               rgb = colour x power, w = cutoff (0 bare globe .. 1 full cutoff head).
uniform highp sampler2D uLightData;
// One texel per (cell, slot): the light index PLUS ONE, so 0 can mean "no more lights here".
uniform highp usampler2D uLightGrid;
uniform vec4 uLightWindow;   // xy = window origin in world XZ, z = 1 / cell size, w = master gain
uniform vec2 uLightRig;      // x = rig level, y = 1 when the tables are live

// Anisotropic GGX (Burley). Two roughnesses about an in-plane frame instead of one, which is what
// turns a lamp's reflection on a road from a round blob into the long smear you actually see.
float vhD_GGXAniso(float ndh, float tdh, float bdh, float ax, float ay) {
  float dx = tdh / max(ax, 1e-4);
  float dy = bdh / max(ay, 1e-4);
  float k = dx * dx + dy * dy + ndh * ndh;
  return 1.0 / max(VH_PI * ax * ay * k * k, 1e-7);
}

// The axis the sheen stretches along: the HORIZONTAL component of the view direction, projected
// into the surface. Asphalt is anisotropic because it is rolled, and it is rolled along the
// carriageway — which is the direction a pedestrian on that carriageway is almost always looking.
// Deriving the axis from the view rather than from a road tangent costs nothing (there are no
// tangents in this vertex format), is continuous everywhere, and degenerates gracefully: looking
// straight down at the road there IS no streak direction, and the fallback below is only ever
// reached within a twentieth of a degree of vertical, where the highlight is a round spot anyway.
vec3 vhAnisoAxis(vec3 N, vec3 V) {
  vec3 t = vec3(V.x, 0.0, V.z);
  t = t - N * dot(N, t);
  float l = length(t);
  if (l > 1e-3) return t / l;
  vec3 f = abs(N.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 t2 = f - N * dot(N, f);
  float l2 = length(t2);
  return l2 > 1e-4 ? t2 / l2 : vec3(1.0, 0.0, 0.0);
}

// Sum the lamps whose cluster cell this fragment falls in. 'aniso' is 0 for everything that is not
// a carriageway, and at 0 the anisotropic lobe below is the isotropic one to the bit.
void vhLocalLights(vec3 P, vec3 N, vec3 V, float ndv, float rough, float aniso,
                   out vec3 diffuse, out vec3 specular) {
  diffuse = vec3(0.0);
  specular = vec3(0.0);
  float rig = uLightRig.x;
  if (rig <= 0.002 || uLightRig.y < 0.5) return;

  // Which cluster cell. Two subtractions, a multiply and a floor — no projection, no frustum.
  vec2 g = (P.xz - uLightWindow.xy) * uLightWindow.z;
  if (g.x < 0.0 || g.y < 0.0) return;
  ivec2 c = ivec2(g);
  if (c.x >= VH_LGRID || c.y >= VH_LGRID) return;

  vec3 T = vhAnisoAxis(N, V);
  vec3 Bt = cross(N, T);
  float a = max(rough * rough, 0.0016);
  // Stretch the lobe along T and narrow it across, holding ax * ay — and therefore the lobe's
  // integral — constant, so anisotropy moves the highlight's SHAPE and never its energy.
  float k = 1.0 + clamp(aniso, 0.0, 1.0) * 2.6;
  float ax = clamp(a * k, 0.0016, 0.98);
  float ay = clamp(a / k, 0.0016, 0.98);
  float aIso = sqrt(max(ax * ay, 1e-8));
  float gain = max(uLightWindow.w, 0.0) * rig;
  int base = c.x * VH_LSLOTS;

  for (int s = 0; s < VH_LSLOTS; s++) {
    uint id = texelFetch(uLightGrid, ivec2(base + s, c.y), 0).r;
    if (id == 0u) break;                       // the cell's list is packed, so this is the end
    int li = int(id) - 1;
    vec4 lp = texelFetch(uLightData, ivec2(li, 0), 0);
    vec3 dv = lp.xyz - P;
    float d2 = dot(dv, dv);
    float r2 = max(lp.w * lp.w, 1e-4);
    if (d2 >= r2) continue;
    float d = sqrt(max(d2, 1e-8));
    vec3 L = dv / d;
    float ndl = dot(N, L);
    if (ndl <= 0.0) continue;

    vec4 lc = texelFetch(uLightData, ivec2(li, 1), 0);
    // Karis' windowed inverse square: physical falloff with a finite radius and no visible edge
    // where it ends. The +1 m^2 is the source's own size — without it a fragment that lands on
    // the lens itself returns infinity.
    float w = clamp(1.0 - d2 / r2, 0.0, 1.0);
    w *= w;
    // Luminaire distribution. A full-cutoff cobra head puts nothing above the horizontal and is
    // at full output a few degrees below it; a heritage globe is very nearly omnidirectional.
    // L points from the fragment TO the lamp, so dot(vec3(0,-1,0), -L) — how far below the lamp
    // this fragment sits, measured along the luminaire's own downward axis — is exactly L.y.
    float cut = mix(1.0, smoothstep(-0.34, 0.10, L.y), clamp(lc.w, 0.0, 1.0));
    float e = (w / (d2 + 1.0)) * cut * gain;
    if (e <= 1e-7) continue;

    diffuse += lc.rgb * (e * ndl);

    vec3 H = normalize(L + V);
    float ndh = clamp(dot(N, H), 0.0, 1.0);
    float vdh = clamp(dot(V, H), 0.0, 1.0);
    float D = vhD_GGXAniso(ndh, dot(T, H), dot(Bt, H), ax, ay);
    vec3 sp = lc.rgb * (e * ndl * D * vhV_Smith(ndv, ndl, aIso)) * vhF_Schlick(vec3(0.04), vdh);
    // One wet pixel lining a lamp up exactly must not return four figures of radiance and become
    // a firefly the bloom chain then smears across the frame.
    specular += min(sp, vec3(6.0));
  }
}

// --- the road surface --------------------------------------------------------------------------
// Value noise on WORLD XZ (CONTRACT §8.4: every procedural hash is keyed on world position, never
// on an index, so a tile looks the same whether or not its neighbours are resident).
float vhNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = vhHash21(i);
  float b = vhHash21(i + vec2(1.0, 0.0));
  float c = vhHash21(i + vec2(0.0, 1.0));
  float d = vhHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// How wet a patch of carriageway is, 0..1. Two octaves at 18 m and 5.5 m: standing water gathers
// in the crown's low side and along the gutter line in patches tens of metres long, and a road
// that is uniformly wet everywhere is exactly the varnished-sheet look this is here to kill.
// 'k' is env-level wetness; at k = 0 the smoothstep window sits entirely above the noise's range
// and this returns 0 for every fragment in the city.
float vhRoadWet(vec2 xz, float k) {
  float f = vhNoise2(xz * 0.0555) * 0.70 + vhNoise2(xz * 0.1820 + vec2(37.3, 11.7)) * 0.30;
  return smoothstep(1.0 - k, 1.02 - k * 0.35, clamp(f, 0.0, 1.0));
}
`;
