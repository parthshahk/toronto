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
                                            │
                                   pack_city.py──▶  data/toronto.bin   (what the browser loads)

Source files go in `data/raw/` (gitignored, ~400 MB):

- `massing2025/` — [3D Massing 2025](https://open.toronto.ca/dataset/3d-massing/), shapefile, WGS84
- `osm_infra.json`, `osm_buildings.json`, `osm_water.json` — Overpass API extracts

`build_city.py` clips the 210 MB city-wide shapefile to the bounding box, reprojects, interpolates
terrain, and reads the OSM street/rail/water layers. `match_osm.py` matches OSM building polygons
onto massing footprints to attach typology, material and surveyed colour. `pack_city.py` packs the
result into the binary sidecar the loader actually reads.

    npm run build:city     # all three, in order
    npm run pack:city      # just the sidecar, after hand-editing the JSON

### `data/toronto.bin`

The JSON is the **authoring** format — readable, diffable, what the Python writes. It is a poor
transport format: 11.8 MB of text, 3.3 MB gzipped, and `JSON.parse` has to allocate ~493,000
two-element arrays before the first frame can start. The sidecar carries exactly the same
information as typed arrays:

    magic 'TOR2' · uint32 headerLen · header JSON · 4-byte-aligned typed-array blocks

Coordinates are centimetres: the first point of a ring absolute as `int32`, the rest `int16`
deltas, with an escape pair for the 41 segments longer than 327 m. Terrain is `int32`
millimetres, heights and widths `int32` centimetres, surveyed colours `int32` ten-thousandths —
integer units chosen so that dividing reproduces **exactly** the double the JSON literal parses
to. Float32 would not: 22.7 m becomes 22.700000762939453, which is enough to move a building
across one of `pickClass`'s height thresholds.

Measured: 11.8 MB → 3.3 MB raw, 3.3 MB → 1.9 MB gzipped, and 61 ms of `JSON.parse` → 6 ms of
typed-array walk. `city.js` falls back to the JSON with a console warning if the sidecar is
missing or stale, so the app runs from a fresh `build_city.py` without it.

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
| `city.js` | `toronto.bin` → analysis, per-tile geometry, grade separation, collision, walkability |
| `tiles.js` | the spatial grid, the LOD stages, the build scheduler and the eviction cache |
| `props.js` | street furniture, vegetation, vehicles, pedestrians |
| `facades.js` | entrances, shopfronts, balconies, cornices |
| `harbour.js` | quay walls, piers, slips, waterfront walkways |
| `input.js` | keyboard/mouse/pointer-lock, dual-layout aliasing |
| `main.js` | boot, free-roam camera, time of day, loop |

Geometry is merged into one mesh per material class **per tile** — see below.

## Two rules that are easy to break

**Time-of-day independence.** Geometry and materials only — never bake lighting, shadow or ambient
occlusion into vertex colour, and mark something emissive only if it is genuinely a light source.
The renderer decides *when* lamps are on. Model a shop interior as real geometry and it is daylit at
noon and glowing at midnight for free. Check every change at all four presets.

**Completeness over accuracy.** Where surveyed data exists, use it. Where it is missing or stops
mid-feature, synthesise something plausible — a believable invention beats a hole. A road may end
only at a junction, a designed terminus, or the world boundary. Land never simply becomes water.

## Tiling and level of detail

At 43 km² the city is 23.6 M vertices. As eight merged buffers that is 1.2 GB of vertex data, four
seconds of blocking generation, a 2.0 GB heap and 33 fps, because the shadow pass redraws all of it
three times a frame. So geometry is partitioned and streamed.

**The load is two phases.** Everything topological runs once, up front, and emits no vertices at
all: terrain, harbour, the grade solve, footprint preparation, coplanar wall and cap resolution,
the road records, the junction graph, the walkability audit, the street-name index. Everything
geometric is deferred. Measured on an M1 Pro, that phase is 1.96 s.

**Tiles are 625 m square** — 25 terrain cells exactly, so the ground mesh splits on cell boundaries
and adjacent tiles share their edge vertices to the bit. Bigger tiles mean fewer draw calls and a
coarser detail radius; smaller mean tighter culling and more draw calls. At 625 m a 3.5 km view is
about 30 tiles and street-level detail is 4–9 of them.

**A feature is indexed into exactly one tile** — the one holding its anchor — and that tile's draw
box grows to contain it. Nothing is clipped and nothing is duplicated, so there is no seam to get
wrong. The 3% of ways longer than a tile are cut into runs first, and the cut lands **in the middle
of a segment**, never on a vertex: both halves then end collinear with the same original segment,
`polyFrames` squares an endpoint to its one segment, and the two runs produce the same frame vector
at the shared point. Measured join angle over the whole extract: 0.00°.

**Two stages, cheapest first.**

| | contents | range |
|---|---|---|
| 0 massing | terrain, area covers, trenches, building walls and roofs, road and rail ribbons, bridges, the quay | 5.0 km |
| 1 detail | markings, kerbs, walkways, the concourse, streetcar track and wire, facades, furniture, cars, people, roofscape | 780 m |

Stage 1 is *additive* — the detail is geometry proud of massing that already exists — so crossing
the boundary fades detail in rather than changing a silhouette. 780 m is where a 9.5 m lamp mast is
19 px tall and one across on a 900-line frame, and a balcony band is under two.

**Builds are generators** pumped against a 3.5 ms-per-frame budget, so a dense downtown tile costs
twenty partial frames instead of one 60 ms stall.

**Eviction is LRU against a 9 M-vertex cap** (468 MB at 13 floats). The cap is 1.29× the 7.0 M the
pre-expansion build held permanently resident at 60 fps, and leaves the shadow atlas and the post
chain room inside a 1 GB working set. Measured over a 1,400-frame circuit of the whole map: 2,846
tile builds, 2,698 evictions, 83 M vertices and 9,371 GL buffers released, resident 5.5–6.3 M
throughout, heap flat at 320–660 MB across the GC sawtooth.

**Two passes cannot be tiled and are captured instead.** The walkability audit has to see the whole
network before it knows where to build a flight of steps, and `harbour.js` walks 32 km of surveyed
shoreline as continuous runs. Both run once into scratch builders; `captureSplit` then cuts the
result up by triangle centroid and hands each tile the float run it owns. That costs 2.6 M vertices
(128 MB) of CPU-side chunks held for rebuild. The proper fix is a bounding-box predicate in
`harbour.js` — the same change the full city needs anyway.

## Scaling to the full city

This area is ~18,600 buildings; all of Toronto is ~428,000, so about 23×. Therefore: nothing
hard-coded to the bounding box (derive everything from `meta`), no O(n²) passes, and every
procedural hash seeded on **world position rather than array index**, so a building looks the same
whether or not its neighbours are loaded.

Tiling makes that rule load-bearing rather than aspirational. Each tile seeds its own RNG from its
grid coordinates, its own occupancy grid, its own pedestrian budget — nothing accumulates across
tiles, so a tile built alone is byte-identical to the same tile built last. **Verified:** building
the whole map in grid order and in reverse grid order produces identical geometry in every material
class, props included.

What still has to change for 428,000 buildings: the up-front analysis phase is O(features) with a
small constant but it is still O(all features), so at 23× it becomes ~45 s. Grade solving, coplanar
resolution and footprint preparation are all spatially local and can move into the tile prepare
step behind a margin wider than the biggest footprint; the walkability audit and the harbour need
to become tile-aware at source.

## Testing note

In a headless or background browser tab, **both `requestAnimationFrame` and `setTimeout` are
throttled** (a `setTimeout(8)` measured at ~973 ms). Override `requestAnimationFrame` to capture the
callback and drive it in a loop awaiting a *microtask*, not a timer.

The load yields 18 times now, not 363: `chunked()` yields on a **clock** (12 ms of work between
yields) rather than on a fixed chunk size. A yield costs most of a frame in a visible tab, and the
old fixed sizes spent a third of the load waiting for the loading screen to repaint itself.

`gl.finish()` does not reliably serialise on ANGLE/Metal — frame timings taken around it come back
at 3,000 fps. Read one pixel with `gl.readPixels` instead; that forces the pipeline through.

When measuring frame stability, freeze `env.time` **before every frame** — otherwise animated
windows and reflections masquerade as z-fighting.
