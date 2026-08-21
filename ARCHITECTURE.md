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

**Three documented data defects:** the massing dataset stops the CN Tower at the SkyPod (443 m), so
the mast to 553 m is modelled in `city.js`; `SURF_ELEV` uses `0` for "missing" and `130.1` as a
fill value, so terrain is interpolated from the trustworthy 62% of samples; and on the islands
`max(AVG_HEIGHT, MAX_HEIGHT)` returns the tree canopy over a cottage rather than its roof — the
median height on Ward's and Algonquin comes out at 19.9 m on a 100 m² footprint, and 225 of the
288 records read over 12 m. `islandBuildingHeight()` in `harbour.js` caps a small island footprint
at a plausible house, hashed on world position; everywhere else it returns `b.h` untouched.

**`build_city.py` does not read every tag the map needs.** It takes `highway`, `railway`,
`natural=water`, `leisure`, `landuse`, `amenity` and `man_made`; `aeroway`, `natural=beach`,
`natural=sand`, `route=ferry` and `attraction` all fall on the floor, which leaves Billy Bishop as
a handful of buildings on bare ground. Those five layers are read out of `data/raw/`, projected
with the same `Proj`, and frozen as literal tables in `harbour.js` — the same treatment as the CN
Tower's mast, and the only route to them that does not mean regenerating `toronto.bin`.

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
| `facades.js` | entrances, shopfronts, balconies, cornices — at two levels of detail |
| `harbour.js` | quay walls, piers, slips, waterfront walkways, the islands, Billy Bishop |
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

**Nothing in the renderer may hold a world coordinate as a literal.** `render.js` has no access to
`meta.origin`, so any constant it carries in local metres is silently wrong the moment the extract
is rebuilt around a different centre. There is exactly one such uniform, `uCnTower` — the xz axis
of the mask that carries the CN Tower's LED rib wash, its two glazed bands and the red beacons up
the mast — and the expansion moved the origin 1,020 m out from under it, which put the whole
lighting rig over open water and left the most recognisable object in the scene an unlit concrete
shaft at blue hour and night. `city.js` now exports `city.cnTower` from the same position it
extrudes the tower at, and `main.js` writes it into `env.cnTower` *and* into `TIME_DEFAULTS`, which
is snapshotted before the city loads and would otherwise put the stale literal straight back on the
next preset change. If a second such constant is ever added, it needs the same treatment.

## Sight lines

The extract is 6.8 × 6.5 km and the player can fly to 2,400 m, so the renderer has to hold up over
roughly 3× the sight lines it was tuned for.

**Near plane 0.30–1.60 m, driven per frame from measured clearance.** For a fixed-point depth
buffer the quantisation step is `2^-24 · z² / near · (1 − near/far)`, so precision is set by the
near plane and almost nothing else — at 0.3 m it is 0.2 m of depth resolution at a kilometre,
wider than the gap between the stacked massing slabs the dataset carries for one real building.
`main.js` probes the clearance around the eye and lengthens the plane when it can; shortening
lands the same frame (safety), lengthening eases in (precision only).

**Far plane 18,600 m.** Set by visibility, not precision: the algebra above says raising it from
5,600 costs 0.008% of the depth resolution. 18,493 m is the longest sightline the world admits —
the ceiling above one corner of the camera clamp to the far corner of the lake sheet — and the
plane is that plus 100. Measured from that viewpoint, a 16,000 m plane still cuts the water with a
worst-row difference of 14.8/765 and a 9,000 m plane 97.1/765.

**Fog is three terms** (`vhFogAmount`): an exponential *haze deck* with a 48–120 m scale height, so
the street grid sits in haze and the towers rise clear of it; *aerial perspective*, extinction per
metre of sightline from a Koschmieder visual range of 40 km, multiplied by `env.daylight` because
airlight is scattered sunlight and there is none of it after sunset; and a quadratic *horizon
closer* past 3 km that is not daylight-scaled, because a horizon has to shut at night too. Total
airlight from the 300 m start viewpoint at Afternoon: 7.6% at 1 km, 20.5% at 3 km, 49.4% at 6 km,
88.9% at 10 km, 100% at 16 km. Blue hour and Night sit *below* that curve past 3 km — distant lit
windows come through, which is what a city across a lake actually looks like at midnight.

Once the air is opaque the haze colour converges to what the sky shader would have drawn in that
direction, over the same 3–13 km window the fog cap opens over. Without it the far edge of the
lake sheet reads as a seam against the sky from altitude — measured at 49.8/765 across six
scanlines, now 18.9 and monotonic.

**Four cascades, 2048² each, in one 8192×2048 depth atlas.** Every cascade is fitted to the
bounding sphere of its frustum slice and snapped to its own texel grid, which makes one texel 0.91
screen pixels at the slice's far edge whatever the split — so the split buys sharpness in absolute
metres near the camera, not at the far edge, and it is therefore an absolute distance (110 m, a
Toronto block face) rather than a fraction of the reach. Everything after it is geometric out to
the reach, which is the series that minimises the worst texel-to-pixel step.

| reach | cascade far distances (m) | metres per texel | worst step |
|---|---|---|---|
| 2,200 m (Blue hour, Night) | 110 · 299 · 810 · 2,200 | 0.129 · 0.332 · 0.900 · 2.444 | 2.71× |
| 2,860 m (Afternoon) | 110 · 326 · 965 · 2,860 | 0.129 · 0.363 · 1.077 · 3.189 | 2.96× |

`renderer.shadowStats` reports the fit every frame, so the table above is read back rather than
derived on paper.

**The window lattice folds with distance, not with contrast.** Cells double as they approach a
pixel, exactly like a mip level, and crossfade between the two nearest levels; they stay fully
lit-or-unlit, so they still punch through the tonemap instead of averaging into khaki. The fold
holds every cell at two pixels or more, which for an office lattice first bites at 1.0–1.4 km —
street level and the whole detail radius run the unfolded lattice. Verified at the far corner of
the extract, not just downtown: at 5.5 km the lattice crawls *less* than the building silhouettes
around it do.

## Tiling and level of detail

At 43 km² the city is 26.0 M vertices. As eight merged buffers that is 1.35 GB of vertex data, four
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
| 0 massing | terrain, area covers, trenches, building walls and roofs, road and rail ribbons, bridges, the quay, the island shore mantle, the airfield surface | 5.0 km |
| 1 detail | markings, kerbs, walkways, the concourse, streetcar track and wire, facades, furniture, cars, people, roofscape, island planting, airfield lights, ferries | 780 m |

Stage 1 is *additive* — the detail is geometry proud of massing that already exists — so crossing
the boundary fades detail in rather than changing a silhouette. 780 m is where a 9.5 m lamp mast is
19 px tall and one across on a 900-line frame, and a balcony band is under two.

**`facades.js` builds at two levels**, selected through the `lod` field of the `opts` object every
builder already takes: `FACADE_LOD.FULL` (the default, and byte-identical to what the module
emitted before LOD existed) and `FACADE_LOD.COARSE`, which keeps the silhouette, the materials and
the random choices and drops the internal articulation — 1.7× cheaper on a parapet that was
already one slab, 8.8× on a shopfront, 18.5× on a revolving-door lobby. `facadeLodFor(dist)` maps
range to level; the switch lands at 484 m, where the smallest thing FULL keeps that COARSE drops is
one pixel wide. Both levels draw the same number of values off the shared RNG in the same order, so
a tile that builds its frontages coarse places exactly the same lamps, trees and parked cars after
them as one that builds them full.

**Builds are generators** pumped against a 3.5 ms-per-frame budget, so a dense downtown tile costs
twenty partial frames instead of one 60 ms stall.

**Eviction is LRU against an 11 M-vertex cap** (572 MB at 13 floats), and the cap is sized above
the worst want set in the city rather than below it. The densest view anywhere is the Financial
District at street level, where 131 tiles of massing (~51 k vertices each) and 12 of detail
(~379 k each) come to 11.2 M. At the 9 M this started as, that view overflowed permanently, and a
cap cannot be enforced by throwing away geometry that is still wanted: the builder rebuilt what
eviction had just taken, every frame, for as long as the camera stood there. Measured standing
still at King and Bay: **210 builds and 210 evictions per 200 frames**, 131 M vertices evicted and
13,219 buffer uploads, with 23 tiles permanently unbuilt.

So the want set itself has to shrink, and `TileManager._adaptLod` is what shrinks it. Each stage
carries a scale on its range; when the resident total runs over the cap the most detailed stage
that still has room gives up radius, and the tile eviction then removes is genuinely out of range
and is not queued again. It relaxes back the same way, coarsest stage first, and a per-stage
ceiling remembers the scale that last overflowed *here, at this cap* so relaxing cannot walk
straight back into the overflow it just escaped — the ceiling is forgiven when the camera moves
half a tile, when the cap changes, or when the resident total falls below 0.6× cap.

The valve is a safety net for the full city, not a load-bearing part of ordinary use: at 11 M it
stays at 1.0 downtown and the detail radius is the full 780 m. Measured after the change, camera
still at King and Bay: **0 builds, 0 evictions, 0 uploads per 200 frames**, nothing pending,
resident 10.98 M. Squeezed artificially to a 6 M cap it converges instead of thrashing — 0 churn,
detail radius down to 94 m — and recovers when the cap is restored. Over an 8.6 km diagonal flown
at roughly 19× maximum fly speed: 234 builds, 61 evictions, 0 wanted stages evicted, a median
frame of 11.8 ms and one frame over 50 ms, which was the teleport. Parked out of range past the
20 s grace period, 6.83 M vertices and 224 GL buffers come back.

**Two passes cannot be tiled and are captured instead.** The walkability audit has to see the whole
network before it knows where to build a flight of steps, and the *mainland* half of `harbour.js`
walks 32 km of surveyed shoreline as continuous runs. Both run once into scratch builders;
`captureSplit` then cuts the result up by triangle centroid and hands each tile the float run it
owns. That costs 2.6 M vertices (128 MB) of CPU-side chunks held for rebuild. The proper fix is a
bounding-box predicate in `harbour.js` — the same change the full city needs anyway, and the island
half of the module is already written that way: `appendIslandMass` and `appendIslandDetail` take
the tile's core cell and emit only the strips, stripes, trees and lights whose anchor falls inside
it, off a spatial model built once.

## The south half: the islands and Billy Bishop

The extract's southern half is 3.44 km² of island in sixteen rings, 35.5 km of surveyed shore, an
airport, and the two shipping channels either side of the harbour. It is a different place from
the mainland waterfront and `harbour.js` builds it differently.

**A surveyed shoreline is a line, not an edge.** Amendment 9.2 forbids land simply becoming water,
so every one of those 35.5 km is classified — from the survey where the survey says something, by
inference where it does not — and given a real cross-section:

| | where | metres | profile |
|---|---|---|---|
| beach | inside a mapped `natural=beach`/`sand` polygon, or facing 900 m of open lake | 10,075 | dry sand, swash, a submerged toe |
| seawall | within 13 m of a mapped structure, road or building | 8,254 | a low vertical face, about a metre of freeboard |
| riprap | everything else, which is the lagoon and channel banks | 17,149 | a rubble slope |

The three share one six-knot cross-section and differ only in its five widths and in the materials
on the bands, so a beach can taper into a seawall over a few stations without leaving a hole where
the two meet; the classification is median-filtered round the loop and the widths are smoothed, so
one station under a jetty cannot punch a seawall through fifty metres of sand.

**The mantle is a cover as much as a look.** A 25 m terrain grid cannot hold a 30 m sand spit: the
grid reads below the lake between the surveyed line and the first land vertex, and water would
show straight through the island. Each station's cover therefore runs inland to exactly where the
ground comes back up to bank level (or to the middle of the strip where what it meets is the far
bank's cover), and where it runs out of room first, a bank face closes the drop. Measured over
53,747 samples of island land at 8 m: **3 below the lake plane, 0 without a finite ground.** Over
2,287 shore stations: 0 with no surface at the water line, 4 stepping into the island ground, and
every one of those closed by a face in the geometry rather than by assertion.

**The islands are parkland from shore to shore** and only about half of that is mapped as a park or
grass polygon, so `carveIslands` scanline-fills the rings into the terrain grid and the ground
carries the park albedo there — 885 ring points against 104 rows rather than twenty thousand cells
against 885 points. Every mapped polygon still draws over it.

**Billy Bishop is built from the aeroway survey**, not invented: 2 runways, 35 taxiways, 3 aprons,
2 stopways, 13 stands and 9 holding positions. The airfield is a plane at the median of the
surveyed ground under the pavement, and the terrain is graded to it with a 26 m blend. Which end
of a runway carries which designator follows from the bearing rather than from the point order —
the number painted at a threshold is the magnetic heading you fly when you land *on* it, so 08/26
reads 08 at the **west** end. Runway numerals are seven-segment, which is close to what an ICAO
numeral actually is: straight bars on a grid.

The perimeter fence is not the edge of the pavement — that would wrap every taxiway individually
and fence the grass off from itself. The pavement is rasterised at 8 m, dilated 74 m with a chamfer
distance transform, clipped to the land, and the contour of *that* traced by marching squares;
where the airfield runs out of island the contour follows the shoreline, which is where the real
fence goes. The same 74 m contour is what keeps trees and flower beds off the infield.

**Amendment 7 holds strictly down here.** Measured over the south half: 1.29 M ground-class
vertices, **0 emissive**; 3.5 M prop vertices, 0.8% emissive in 20 colours, every one of them a
runway edge, threshold, end or taxiway lamp, an approach bar or the lighthouse lantern.

`tools/islands.mjs` is the harness for all of it, and reports each number above from the real data
and the real geometry.

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
