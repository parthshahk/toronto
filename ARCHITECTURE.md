# Architecture

Reference for working on the code. The [README](README.md) covers what the project is.

## Coordinate system

**X = east, Y = up, Z = south.** Right-handed, true metres. Origin at the centre of the data
extent (-79.38850, 43.64400). Yaw 0 faces **+Z**, increasing toward **+X**, so
`forward = (sin yaw, 0, cos yaw)` and `right = cross(forward, up)` — at yaw 0 that is **-X**.

Source data is EPSG:3857 (Web Mercator), which inflates horizontal distance by `1/cos(latitude)` —
**38% at Toronto's latitude**. The build divides it out. Skip that step and every building is a
third too wide for its height.

## Data pipeline

`tools/` has no Python dependencies; the ESRI shapefile and dBASE parsers are written from scratch.

    data/raw/  ──build_city.py──▶  data/toronto.json  ──match_osm.py──▶  (enriched in place)

Source files go in `data/raw/` (gitignored, ~400 MB):

- `massing2025/` — [3D Massing 2025](https://open.toronto.ca/dataset/3d-massing/), shapefile, WGS84
- `osm_infra.json`, `osm_buildings.json`, `osm_water.json` — Overpass API extracts

`build_city.py` clips the 210 MB city-wide shapefile to the bounding box, reprojects, interpolates
terrain, and reads the OSM street/rail/water layers. `match_osm.py` matches OSM building polygons
onto massing footprints to attach typology, material and surveyed colour.

### `data/toronto.json`

```jsonc
meta      { origin{lon,lat}, bbox, extent{x,z}, lake_msl, sources[] }
terrain   { nx, nz, cell, h[] }        // metres above lake datum, row-major, +z south
buildings [ { h, y, r[[x,z]...],       // height, terrain base, rings (outer + holes)
              t, c[r,g,b], m, n } ]    // lighting profile, surveyed colour, material, name
roads     [ { c, w, n, lay, b, tun, p[[x,z]...] } ]
areas     [ { k, p } ]   rails [ { k, p } ]
shore     [ { role, p } ]              // clipped from the OSM Lake Ontario multipolygon
waterfront[ { k, n, p } ]              // pier | quay | breakwater | groyne | retaining_wall | …
```

**`lay` is a signed layer, and the sign is load-bearing.** Negative means the way passes *under*
something. Treating any non-zero layer as a bridge builds 750 underpasses as flyovers, and dropping
tunnels deletes another 630 ways — together, 18% of the street network.

**Ring winding cannot be assumed.** ESRI winds outer rings clockwise, but the build negates north
into +Z, which mirrors the plane and reverses winding. Compute each ring's signed area; the largest
|area| is the outer boundary, the rest are holes.

**Two documented data defects:** the massing dataset stops the CN Tower at the SkyPod (443 m), so
the mast to 553 m is modelled in `city.js`; and `SURF_ELEV` uses `0` for "missing" and `130.1` as a
fill value, so terrain is interpolated from the trustworthy 62% of samples.

## Vertex format

13 interleaved floats, non-indexed triangles, counter-clockwise front faces (back-face culling is on):

```
px py pz   nx ny nz   r g b   emissive  tintable  rough  profile
```

- `rough` — 0 mirror, 1 matte. Drives GGX specular and reflection strength.
- `profile` — the surface's night-lighting behaviour, **not** a colour:
  `0` envelope (no windows) · `1` office · `2` residential · `3` retail · `4` parking · `5` civic
- `emissive` — on profile 0 it must be exactly `0` or `≥ 0.50`; values between are reserved as
  facade window hints.

`MeshBuilder.color(r, g, b, emissive = 0, tintable = 0, rough = 0.85, profile = 0)`.

## Modules

| | |
|---|---|
| `math.js` | vec3, column-major mat4, seeded RNG |
| `gl.js` | context, `Shader`, `Mesh`, `MeshBuilder` |
| `render.js` | `Camera`, `Renderer`, all GLSL, CSM, SSAO, SSR, bloom |
| `city.js` | `toronto.json` → geometry, terrain, grade separation, collision, walkability |
| `props.js` | street furniture, vegetation, vehicles, pedestrians |
| `facades.js` | entrances, shopfronts, balconies, cornices |
| `harbour.js` | quay walls, piers, slips, waterfront walkways |
| `input.js` | keyboard/mouse/pointer-lock, dual-layout aliasing |
| `main.js` | boot, free-roam camera, time of day, loop |

Geometry is merged into one mesh per material class, which is why ~7M vertices draw in 18 calls.

## Two rules that are easy to break

**Time-of-day independence.** Geometry and materials only — never bake lighting, shadow or ambient
occlusion into vertex colour, and mark something emissive only if it is genuinely a light source.
The renderer decides *when* lamps are on. Model a shop interior as real geometry and it is daylit at
noon and glowing at midnight for free. Check every change at all four presets.

**Completeness over accuracy.** Where surveyed data exists, use it. Where it is missing or stops
mid-feature, synthesise something plausible — a believable invention beats a hole. A road may end
only at a junction, a designed terminus, or the world boundary. Land never simply becomes water.

## Scaling to the full city

This area is ~4,654 buildings; all of Toronto is ~428,000, so about 90×. Therefore: nothing
hard-coded to the bounding box (derive everything from `meta`), no O(n²) passes, and every
procedural hash seeded on **world position rather than array index**, so a building looks the same
whether or not its neighbours are loaded. That last one is what makes tiling possible.

The current JSON format will not survive the full city — it needs to become binary and tiled.

## Testing note

In a headless or background browser tab, **both `requestAnimationFrame` and `setTimeout` are
throttled** (a `setTimeout(8)` measured at ~973 ms). The city build yields ~220 times, so a naive
wait takes minutes. Override `requestAnimationFrame` to capture the callback and drive it in a loop
awaiting a *microtask*, not a timer.

When measuring frame stability, freeze `env.time` **before every frame** — otherwise animated
windows and reflections masquerade as z-fighting.
