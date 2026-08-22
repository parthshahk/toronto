# Architecture

Reference for working on the code. The [README](README.md) covers what the project is.

## Coordinate system

**X = east, Y = up, Z = south.** Right-handed, true metres. Origin at the centre of the data
extent — currently **(-79.38550, 43.67150)**, and **read from `meta.origin`, never assumed**: the
extent has now moved twice, and both times everything that hard-coded the old centre broke
silently. The Old Toronto expansion moved it 4.06 km north of the 43 km² centre and 121 m east of
the original downtown one; `app/controls.js`'s viewpoint table is the one place that legitimately
holds local metres, and it carries the lon/lat of every entry beside it so the next move is
arithmetic. Yaw 0 faces **+Z**, increasing toward **+X**, so
`forward = (sin yaw, 0, cos yaw)` and `right = cross(forward, up)` — at yaw 0 that is **-X**.

Source data is EPSG:3857 (Web Mercator), which inflates horizontal distance by `1/cos(latitude)` —
**38% at Toronto's latitude**. The build divides it out. Skip that step and every building is a
third too wide for its height.

## Scale

Every number below is measured at the extent named, on an M1 Pro, in a real tab.

| | downtown (43 km²) | Old Toronto (252 km²) |
|---|---:|---:|
| extent | 6.77 × 6.46 km | **17.31 × 14.58 km** |
| massing records / built | 18,604 / 18,312 | **181,426 / 180,601** |
| road ways | 20,403 | **94,643** |
| rail ways | — | 2,287 |
| tiles of 625 m | 272 | **1,085** (579 populated) |
| world vertices | 34,482,234 | **203,393,211** |
| vertices per km² | 802 k | **806 k** |
| block faces / ground-floor units | 48,299 / 70,755 | **484,300 / 653,976** |
| surveyed units | 7,029 | 20,530 |
| surveyed nodes offered / placed | 21,974 / 13,416 | **76,187 / 43,406** |
| props / people | 113,169 / 10,654 | **471,100 / 65,709** |
| walkable network | 1,218 km, 94.57% largest | **7,573 km, 98.83% largest** |
| groundY range above lake | 0 → 39.6 m | **−14.0 → 120.5 m** |
| `data/toronto.json` | 13.5 MB | **79.9 MB** |
| `data/toronto.bin` | 4.10 MB | **26.05 MB** (12.6 MB gz) |
| `data/city/` total | 4.26 MB in 30 files | **27.01 MB in 167 files** |
| bytes before the first frame | 4.3 MB | **27.9 MB** (sidecar path; see below) |
| time to the first interactive frame | 2.27 s | **27 s** |
| fps, default viewpoint | 95–106 | **83** median (12.0 ms), p95 72.6 ms |
| fps, street level | 95–106 | **112–147** median, p95 64–66 ms |
| draw calls | — | 253 street level, 417 at the lake viewpoint |
| resident vertices | — | 10.9–11.2 M against an 11.0 M cap |
| peak JS heap | 379–406 MB | **1.7–2.0 GB** against a 4 GB limit |

Detail density per km² is the number that matters for "same quality at ten times the buildings":
block faces 1,123 → 1,918, ground-floor units 1,646 → 2,590, people 248 → 260, vertices 802 k →
806 k. Three went **up**, one held. Two went down and both are properties of the *survey*, not of
the code: props 2,632 → 1,866 (downtown genuinely has more street furniture per km² than
Riverdale), and surveyed units 163 → 81 (OSM's premises coverage is dense downtown and thin in the
neighbourhoods — 61.1% of offered nodes were placed downtown against 57.0% here, so the placement
rate barely moved; there are simply fewer offered per km²).

## Data pipeline

`tools/` has no Python dependencies; the ESRI shapefile and dBASE parsers are written from scratch.

    data/raw/  ──build_city.py──▶  data/toronto.json  ──match_osm.py──▶  (enriched in place)
                                            │
                                   pack_city.py──┬─▶  data/city/       (what the browser streams)
                                                 └─▶  data/toronto.bin (the fallback)

Source files go in `data/raw/` (gitignored, ~400 MB):

- `massing2025/` — [3D Massing 2025](https://open.toronto.ca/dataset/3d-massing/), shapefile, WGS84
- `osm_infra.json`, `osm_buildings.json`, `osm_nodes.json`, `osm_water.json` — Overpass extracts,
  fetched by `tools/fetch_osm.py`

**The extract is `-79.4930..-79.2780, 43.6060..43.7370`** — 17.31 x 14.58 km, 252.5 km², the
pre-1998 City of Toronto with the south edge held at 43.6060 so the Islands keep their margin of
open lake. One Overpass query over that area either times out or returns a few hundred megabytes,
so `fetch_osm.py` walks a 4x3 grid of sub-boxes, caches each, and merges de-duplicated by
`(type, id)`. It treats an empty result set as a FAILURE worth retrying: Overpass signals overload
as a valid 200 carrying no elements, and nine of twelve sub-boxes once came back that way and the
merged extract silently lost 96% of its aeroway and 73% of its railway.

`build_city.py` clips the 210 MB city-wide shapefile to the bounding box, reprojects, interpolates
terrain, and reads the OSM street/rail/water layers. **`ELEV_MAX` is a property of the extent, not
of the dataset**: `SURF_ELEV` samples outside `ELEV_MIN..ELEV_MAX` are discarded as junk, and a
cell with no sample left falls back to the lake datum. Downtown ground runs 74.6-105 m MSL and the
ceiling stood at 115, which was right for 43 km² and threw away 70% of the samples at 252 km² —
every one north of Davenport — flattening the northern half of the city to lake level and deleting
the Davenport escarpment. It is 200 m now: 99.99% of real ground, and still rejecting the 18
records whose `SURF_ELEV` is plainly a roof (up to 314.5 m). The heightfield is 693 x 584 at 25 m,
0-120.6 m above a 74.49 m lake datum. `match_osm.py` matches OSM building polygons
onto massing footprints to attach typology, material and surveyed colour. `attach_pois.py` reads
the OSM **node** extract and attaches the shop units, house numbers, storey counts and roof shapes
to buildings, and the standalone street furniture to `pois[]`. `pack_city.py` packs the result into
the binary sidecar the loader actually reads.

    python3 tools/build_city.py
    python3 tools/match_osm.py
    python3 tools/attach_pois.py
    python3 tools/pack_city.py
    npm run build:city     # all four, in order
    npm run pack:city      # just the sidecar, after hand-editing the JSON

`attach_pois.py` needs `data/raw/osm_nodes.json`. Without it the ground floor and the street
furniture are entirely synthesised and **nothing warns** — see the sidecar note below.

### `data/city/` — the streamed city

Geometry has streamed a tile at a time since the 43 km² expansion, but the **records** it was
built from do not: one file, fetched and parsed in full before the first frame — **26.05 MB and
about 550 MB of live objects at the Old Toronto extent**. So `pack_city.py` also partitions the
city into **the renderer's own tile grid** and writes one payload per tile:

    manifest.json   the grid, the extent, the block table, the enum vocabularies, and per tile:
                    which group file it is in, its byte range there, and the box containing
                    everything it owns
    global.bin      terrain height field, lake shore, waterfront structures, and the ~98 features
                    LARGER than a tile. Fetched once, at boot.
    gNNNN.bin       a 2×2 block of tiles' payloads, concatenated

**The grid is not invented twice.** `pack_city.py` reads `TILE_SIZE` out of `src/tilegrid.js`, the
fringe rule out of `src/world/surround.js` and the margin pad off the one `makeTileGrid(extent,
TILE_SIZE, SUR_FRINGE + 420)` call in `src/city.js`, and repeats `makeTileGrid()`'s arithmetic on
the same doubles. It refuses to run rather than guess if any of the three has moved — which is
exactly what happened when the 108-module split carried that call out of `world/roads.js`. `CityStream.matchesGrid()` refuses a manifest whose grid does not
match the one the app built, so a drift is a loud fallback rather than a city in the wrong place.

**Ownership is exclusive.** A feature belongs to the one tile holding its anchor — the mean of a
building's first ring, a way's middle vertex, a node's own position, exactly what
`city/tileindex.js` computes — and that tile's recorded box grows to contain the whole feature.
Nothing is clipped and nothing is duplicated. A feature *larger* than a tile has no tile that can
honestly own it, so it goes in `global.bin`. Every record carries its index in the original JSON
array: `pack_city.py --verify` reassembles the whole city from the parts and proves it is
`data/toronto.json` array for array, with **max numeric error 0** over every field.

`src/data/tileformat.js` decodes the bytes; `src/data/stream.js` decides which to ask for and when.
Its policy is deliberately the geometry policy, not a second one: a millisecond budget pumped once
per frame, requests ordered nearest-first, a 700 m read-ahead past stage 0's *build* range, and
release by least-recently-wanted on the same clock and grace period `TileManager._evict()` uses.
`src/tiles.js` primes every tile's draw box from the manifest the moment the stream is attached —
without it a tile with no features indexed is `empty`, is never queued, never asks for its data,
and so never stops being empty.

Measured at both extents. The Old Toronto column is what `pack_city.py` actually wrote, not a
projection:

| | downtown 43 km² | Old Toronto 252 km² |
|---|---|---|
| tiles | 272 (all populated) | 1,085 (579 populated) |
| manifest + global, at boot | **210 KB**, 2 requests | **1.05 MB** (630 KB gz), 2 requests |
| one-file sidecar, for comparison | 4.10 MB | 26.05 MB (12.6 MB gz) |
| total payload | 4.26 MB in 30 files | 27.01 MB in 167 files |
| tile payload | — | min 0.3 KB, median 42.2 KB, max 130.8 KB |
| payloads read to build one tile | — | avg 8.05, p95 9, max 9 |

### The streamed city is written but NOT WIRED UP

**As of this writing the app does not use `data/city/` at all.** `openCity()` exists,
`CityStream` is complete, `TileManager.setDataSource()` is complete, and `pack_city.py --verify`
proves the tiles reassemble into `data/toronto.json` array for array with max numeric error 0 —
but nothing in the tree calls `fetchCity(url, cb, { stream: true })` and nothing calls
`setDataSource()`. `src/city.js`'s `loadCity()` calls `fetchCity(url, report)` with no options, so
the sidecar path is taken every time, and `featureList(data, 'buildings')` would return `[]` for a
streamed object anyway — `city.js` has no consumer for one. Two things have to happen together:
`loadCity` must ask for the stream, and every `featureList` / `readPois` call site must learn to
pull per tile instead of walking a whole array up front. The console line on a healthy boot today
reads `[city] data: bin, 26.05 MB decoded`; when this is done it will name the tile source.

Decoded records cost about **11× their packed size** — a ring vertex is a two-element JS array —
which is why payloads are evicted at all and why `byteCap` is 20 MB packed rather than a round
number. Splitting massing from detail into separate files was measured and rejected: detail
(units, POIs, name dictionaries) is only 24% of a payload, which does not pay for doubling the
file count.

### `data/toronto.bin`

Still written, and still the **fallback**: anything at all wrong with `data/city/` — missing,
truncated, a stale format tag, a manifest describing a different grid — falls back to the sidecar
with a console warning, and a missing sidecar falls back to the JSON. All three decode to the same
doubles.

The JSON is the **authoring** format — readable, diffable, what the Python writes. It is a poor
transport format: **79.9 MB** of text at the Old Toronto extent, and `JSON.parse` has to allocate
several million two-element arrays before the first frame can start. The sidecar carries exactly the same information as typed
arrays:

    magic 'TOR2' · uint32 headerLen · header JSON · 4-byte-aligned typed-array blocks

Coordinates are centimetres: the first point of a ring absolute as `int32`, the rest `int16`
deltas, with an escape pair for the 41 segments longer than 327 m. Terrain is `int32`
millimetres, heights and widths `int32` centimetres, surveyed colours `int32` ten-thousandths —
integer units chosen so that dividing reproduces **exactly** the double the JSON literal parses
to. Float32 would not: 22.7 m becomes 22.700000762939453, which is enough to move a building
across one of `pickClass`'s height thresholds.

Measured: **79.9 MB → 26.05 MB raw (12.6 MB gzipped)**, and a tokeniser replaced by a tight loop
over an `Int16Array`. `city.js` falls back to the JSON with a console warning if the sidecar is
missing or stale, so the app runs from a fresh `build_city.py` without it. The console line on a
healthy boot reads `[city] data: bin, 26.05 MB decoded` — if it says `falling back to JSON`, re-run
`python3 tools/pack_city.py`. **26 MB before the first frame is the reason `data/city/` exists and
the reason wiring it up is the top open item.**

The sidecar carries the surveyed **unit** and **POI** blocks as well as the geometry: a
`buildings.unitsPer` run-length array plus parallel `units.*` blocks (category enum, value
dictionary, segment index, the position along that segment as `u16` thousandths, and dictionary
indices for name, brand and house number), and `pois.x/z` as `int32` centimetres against a kind
enum and a name dictionary. **A stale `toronto.bin` is silently wrong rather than broken:** it
decodes cleanly and simply reports zero surveyed units, zero POIs and zero real storey counts, so
the city builds with an entirely synthesised ground floor and nothing warns. If
`stats.facades.unitsSurveyed` and `stats.survey.total` come back 0, the sidecar predates
`attach_pois.py`. Browsers also cache it aggressively — a hard reload is part of testing a
regenerated sidecar.

### `data/toronto.json`

```jsonc
meta      { origin{lon,lat}, bbox, extent{x,z}, lake_msl, sources[] }
terrain   { nx, nz, cell, h[] }        // metres above lake datum, row-major, +z south
buildings [ { h, y, r[[x,z]...],       // height, terrain base, rings (outer + holes)
              t, c[r,g,b], m, n,       // lighting profile, surveyed colour, material, name
              hn, lv, rs,              // house number, REAL storey count, roof shape
              u[ { c, v, s, t, n, b, h, o } ] } ]   // the units on its frontage — see below
roads     [ { c, w, n, lay, b, tun, p[[x,z]...] } ]
areas     [ { k, p } ]   rails [ { k, p } ]
shore     [ { role, p } ]              // clipped from the OSM Lake Ontario multipolygon
waterfront[ { k, n, p } ]              // pier | quay | breakwater | groyne | retaining_wall | …
pois      [ { k, x, z, n } ]           // standalone surveyed nodes, in LOCAL METRES
```

**`buildings[].u` is the ground floor.** Each unit is a real surveyed premises: `c` the category
key (`shop`/`amenity`/`office`/`healthcare`/`craft`/`tourism`/`leisure`/`historic`), `v` its value
(`cafe`, `clothes`, `bank`, `hairdresser`, …), `s` the index of the footprint ring **segment** it
sits on and `t` its parameter `0..1` along that segment, `n` its name, `b` its brand, `h` its house
number, `o` whether it has opening hours. Units arrive ordered along the frontage, which is what
lets `city.js` lay a block face out as a run of premises rather than as one repeated shopfront.

**`pois[]` is the street furniture**, already projected to local metres by `tools/attach_pois.py`:
21,974 nodes — 8,032 trees, 3,717 crossings, 2,000 bike parking, 1,862 benches, 1,403 lamps, 1,142
hydrants, 842 bins, 573 signals, plus stops, postboxes, bike share, bollards, fountains and
billboards. These were the whole reason the ground plane used to be invented: the first three
Overpass extracts contained only ways and relations, and in OSM almost everything that makes a
street recognisable is a **node**.

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
288 records read over 12 m. `islandBuildingHeight()` in `world/islands.js` caps a small island footprint
at a plausible house, hashed on world position; everywhere else it returns `b.h` untouched.

**`build_city.py` does not read every tag the map needs.** It takes `highway`, `railway`,
`natural=water`, `leisure`, `landuse`, `amenity` and `man_made`; `aeroway`, `natural=beach`,
`natural=sand`, `route=ferry` and `attraction` all fall on the floor, which leaves Billy Bishop as
a handful of buildings on bare ground. Those five layers are read out of `data/raw/`, projected
with the same `Proj`, and frozen as literal tables in `world/islandplan.js` — the same treatment as the CN
Tower's mast, and the only route to them that does not mean regenerating `toronto.bin`.

## Vertex format

14 interleaved floats, non-indexed triangles, counter-clockwise front faces (back-face culling is on):

```
px py pz   nx ny nz   r g b   emissive  tintable  rough  profile  uv
```

- `rough` — 0 mirror, 1 matte. Drives GGX specular and reflection strength.
- `profile` — the surface's night-lighting behaviour, **not** a colour:
  `0` envelope (no windows) · `1` office · `2` residential · `3` retail · `4` parking · `5` civic
- `emissive` — on profile 0 it must be exactly `0` or `≥ 0.50`; values between are reserved as
  facade window hints.
- `uv` — the glyph atlas coordinate, two 12-bit fields packed into one float and written through
  `MeshBuilder.uv()`. Only text quads use it; every other vertex leaves it at 0. `profile = 6`
  marks a vertex as a glyph, which is why the sign class is drawn by its own program rather than
  by the scene shader.

`MeshBuilder.color(r, g, b, emissive = 0, tintable = 0, rough = 0.85, profile = 0)`.

## Modules

112 ES modules, no build step, no dependencies. Every import is relative and carries its `.js`
extension, so the browser resolves the graph exactly as Node does.

**The rule that keeps it workable: dependencies point one way.**

```
core  <-  geom / data  <-  world / city / props  <-  tiles.js, city.js  <-  app
render  <-  core
```

`core/` imports nothing. `render/` reaches down into `core/` and nowhere else — it never sees the
data schema, a road record or a building. Builders in `world/`, `city/` and `props/` are pure
functions over a MeshBuilder, a feature and a context; they hold no module-level mutable state, so
tiles build independently and in any order, which is what makes the geometry deterministic. **The
graph has no cycles.**

Determinism is *enforced*, not assumed: `props/kit.js`'s `rnd()` throws a `TypeError` when a caller
passes no rng rather than falling back to `Math.random()`, which is the one way a build could come
out different twice running — nothing crashes, nothing is logged, a handful of props simply move,
and the fingerprint fails intermittently instead of repeatably. A builder with no rng to thread
uses `hash2(x, z)`, seeded on world position; `city/facadekit.js`'s `rngOf()` does the same for a
facade. The only `Math.random()` in the tree is in `core/math.js`, for runtime gameplay, and no
city builder may reach it.

Two kinds of edge cross a layer boundary. One is inherent; the other is a seam in the
wrong place, recorded here rather than papered over:

- **six builders import `render/text.js`** — `city/lod.js`, `city/unitfronts.js`, `city.js`,
  `props/lighting.js`, `props/furniture.js` and `props/structures.js`, for the glyph run layout
  and the text LOD distances. Lettering is geometry a builder emits, but it needs the atlas the
  renderer owns. `render/text.js` and `render/font.js` import *nothing at all*, so this points at
  a leaf and cannot become a cycle.
- **three builders import `tiles.js`** — `world/roads.js` and `city/report.js` for `TILE_SIZE` and
  `makeTileGrid`, `city/lod.js` for `TileManager`, which it subclasses. This one really is an
  upward edge: the tile grid is a spatial primitive that would sit more honestly next to
  `data/index.js`, and `city/lod.js` is an orchestration module filed under `city/` that belongs
  beside `tiles.js`. Moving either is a pure code move and the fingerprint would prove it.

**Target: no file over ~800 lines.** Past that a file is holding more than one responsibility. Two
are over today; both are called out under *Files that are still too big*.

Two definitions are deliberately singular and must stay that way:

- **the vertex format** — `core/vertex.js`, nothing else. It has already changed three times
  (11 → 12 → 13 → 14 floats); the next change must touch that file and the shaders, and nothing
  else. No module hard-codes a stride, a float count or a byte offset into a vertex, with one
  known exception: `app/quality.js` carries `VERT_BYTES = 48`, left over from the 12-float format
  and now 8 bytes short. It is read only by the HUD's resident-memory readout and one console
  line, so it costs nothing but a wrong number — 11 M resident vertices is 616 MB of VBO, not the
  528 MB the comment beside it claims. The fix is `VERT_BYTES = VERT_STRIDE` off `core/vertex.js`;
  it is left alone here only because this pass was a move and changing a displayed number is not.
- **the data schema** — `data/schema.js`, nothing else. Field names (`u`, `lv`, `hn`, `rs`,
  `pois`) are read there once, turned into named properties on the prepared record, and every
  consumer downstream reads the property rather than the raw field.

### `core/` — depends on nothing

| | |
|---|---|
| `core/vertex.js` | **THE vertex format**: `VERT_FLOATS`, `ATTR`, offsets, `packUv`, `GLSL_UV` |
| `core/gl.js` | context creation, `Shader`, `Mesh`, `DynamicMesh`, `MeshBuilder` |
| `core/math.js` | scalar helpers, seeded RNG, angles, vec3 and a column-major mat4 |
| `core/util.js` | the shared predicates and the position hashes |
| `core/async.js` | cooperative scheduling: `now`, `frame`, `chunked`, the yield counter |

### `data/` — the file on disk

| | |
|---|---|
| `data/schema.js` | **THE shape of `toronto.json` / `toronto.bin` / `data/city/`**, in one place |
| `data/load.js` | open the streamed city, or decode the packed binary, or fall back to the JSON |
| `data/tileformat.js` | the bytes of one tile payload and of `global.bin`, decoded to records |
| `data/stream.js` | what is resident, what is on the wire, what is thrown away |
| `data/index.js` | the uniform-grid broadphase, and per-tile assignment of long ways |

### `geom/` — plan-space geometry

| | |
|---|---|
| `geom/ring.js` | signed area, winding, point-in-polygon, ring repair |
| `geom/triangulate.js` | ear clipping with hole bridging |
| `geom/ribbon.js` | polyline to ribbon: resampling, spike pruning, mitred frames |
| `geom/extrude.js` | footprints to solids: tapered prisms, flat caps, draped caps |

### `world/` — the ground and everything on it

| | |
|---|---|
| `world/ground.js` | the ground plane's datum ladder and the tolerances everyone shares |
| `world/terrain.js` | the height field: build, pad, sample, the cut, and the lake |
| `world/grade.js` | grade separation: which way passes over which, and by how much |
| `world/weld.js` | the position-welded node set and the priority queue the grade solve runs on |
| `world/trench.js` | retaining walls, verges, portals, ceilings, concourses |
| `world/roads.js` | the prepared road record, its sidewalk bands and the surveyed footways |
| `world/markings.js` | the paint: lane lines, crossings, stop bars, arrows, bike lanes |
| `world/junctions.js` | the corners: dropped kerbs, tactile plates, the corner record |
| `world/rail.js` | the streetcar: embedded track, overhead wire, poles and stops |
| `world/context.js` | the street-detail context `C` — every question a placement pass may ask of a point |
| `world/furniture.js` | the procedural street furniture pass: what goes along a kerb line |
| `world/surveyed.js` | the OSM node extract, placed where it really is, suppressing the procedural pass |
| `world/people.js`, `world/vehicles.js`, `world/marine.js`, `world/works.js` | who is on the pavement; what is parked; what is moored; service yards and works |
| `world/areas.js` | parks, grass, surface lots and piers, and the per-city budgets over them |
| `world/walk.js` | the walkability graph and the audit that is an acceptance test |
| `world/termini.js` | no dangling ends: every way terminates deliberately |
| `world/surround.js`, `world/fringe.js`, `world/limits.js` | the edge of the world: the plan, its geometry, the soft limit and the horizon audit |
| `world/audit.js` | the ground-plane geometry audit, bound to the live stats once per load |
| `world/waterkit.js` | tunables, materials and helpers shared by the harbourfront and the islands |
| `world/water.js` | `buildHarbour()`, `carveHarbourTerrain()` and the harbour queries |
| `world/shoreline.js` | chaining the surveyed shore ways into a usable shoreline |
| `world/quay.js` | the harbour geometry: quay walls, piers, mounds, marinas, walkways |
| `world/islandplan.js`, `world/islandkit.js` | the frozen island survey, and the tunables over it |
| `world/islands.js` | the island model: rings, shore runs, ferry docks, the public API |
| `world/islandterrain.js`, `world/islanddetail.js` | carving the island edge; what it is made of at eye level |
| `world/airfield.js` | Billy Bishop: pavement, markings, lighting, fencing, aircraft, plant |

### `city/` — buildings

| | |
|---|---|
| `city/materials.js` | the material palette, the surveyed-colour remap, and how a building picks one |
| `city/prep.js` | placing every record up front, and preparing one on demand: parts, material, storey model, broadphase |
| `city/buildings.js` | the wall faces and the wall emitter |
| `city/coplanar.js` | who owns a shared surface — walls, portals and roof caps — a record at a time |
| `city/landmarks.js` | the named towers, and the CN Tower, which is modelled by hand |
| `city/units.js` | the block-face model: every street-facing edge, subdivided into premises |
| `city/unitkinds.js` | the surveyed unit taxonomy: OSM premises tag to kind to style |
| `city/unitfronts.js` | one addressed unit's frontage: glazing, fascia, shutter, doorway, sign |
| `city/frontage.js` | building the block face the unit model laid out |
| `city/facadekit.js` | the `(u, v, d)` frame, materials, LOD and the coplanar audit every facade builder uses |
| `city/facades.js` | street level: entrances, shopfronts, awnings, canopies, ground floors |
| `city/articulation.js` | above street level: balconies, cornices, string courses, parapets, fire escapes |
| `city/roofs.js` | roof form from the surveyed tag, and the plant standing on the deck |
| `city/lod.js` | the city's tile manager, its level-of-detail stages and its vertex budget |
| `city/tileindex.js` | which tile owns which feature, and the cut-up of the two global passes |
| `city/tilebuild.js` | the per-tile generator: everything a tile is made of, in stage order |
| `city/queries.js` | the runtime surface: `buildingAt`, `collide`, `confine`, `streetNameAt` |
| `city/stats.js`, `city/report.js` | the measurement surface, and the console summary that reads it |

### `props/` — one module per domain, over one shared kit

| | |
|---|---|
| `props/kit.js`, `props/materials.js` | the shared drawing kit and the prop palette |
| `props/index.js` | the barrel and **the prop registry** — a new prop is a file plus one entry here |
| `props/lighting.js` | cobra heads, acorns, pedestrian lamps, signals, sign posts, utility poles |
| `props/furniture.js` | seating, waste, cycle parking, bollards, shelters, meters, hardware |
| `props/vegetation.js` | street trees in pits, park trees, shrubs, beach grass |
| `props/vehicles.js` | parked cars, vans, SUVs and rail stock |
| `props/people.js` | pedestrians, cyclists, dog walkers, and the poses behind them |
| `props/marine.js` | pleasure craft, ferries, docks, bollards, ladders, buoys, the lighthouse |
| `props/structures.js` | tower cranes, scaffolding, fencing, signage, subway entrances, rides |
| `props/rooftop.js` | rooftop plant and the tower crown: signage, condensers, antennae, penthouses |
| `props/airfield.js` | runway and taxiway lighting, approach bars, windsocks, hangars, aircraft, GSE |

### `render/` — depends on `core/` and nothing else

| | |
|---|---|
| `render/renderer.js` | the `Renderer`: frame orchestration, the draw API, tracked GL state |
| `render/camera.js` | the `Camera` and every matrix the frame and the post chain derive from it |
| `render/programs.js` | every GLSL program, built once; each optional one degrades on its own |
| `render/env.js` | the lighting environment and every uniform derived from it |
| `render/uniforms.js` | the once-per-frame uniform block for each geometry program |
| `render/targets.js` | the offscreen render targets and their three-tier fallback |
| `render/shadows.js` | cascaded shadow maps: the atlas, the cascade fit, the depth pass |
| `render/lights.js` | the clustered local-light rig |
| `render/post.js` | the post chain order, the resolve and the composite |
| `render/ssao.js`, `render/ssr.js`, `render/bloom.js` | the individual post passes |
| `render/util.js` | the render layer leaf: guards, the blend enum, the identity matrix, `mixin` |
| `render/font.js` | the SDF glyph atlas, rasterised at boot from a system font with Canvas 2D |
| `render/text.js` | the run layout that turns a string into quads, and the text LOD distances |
| `render/shaders/*.glsl.js` | the GLSL itself, composed by interpolation from one shared `common` |

### orchestration and `app/`

| | |
|---|---|
| `city.js` | **the loader.** `toronto.bin` → the pipeline above, in order, and the object the game holds |
| `tiles.js` | the spatial grid, the LOD stages, the build scheduler and the eviction cache |
| `app/main.js` | boot, the shared state `G`, and the frame loop |
| `app/controls.js` | the free-roam controllers: viewpoints, walk, fly, the camera and the key commands |
| `app/input.js` | keyboard / mouse / pointer-lock / gamepad / touch state, and the dual-layout aliasing |
| `app/touch.js` | the Maps-style multi-touch camera, on-screen controls, the walk-mode thumbstick |
| `app/hud.js` | the 2D HUD: compass, readouts, attribution, help sheet, diagnostics |
| `app/time.js` | the four time-of-day presets and the environment writer |
| `app/quality.js` | the device profile, the quality presets and the adaptive step |
| `index.html` | shell, loading and title screens, attribution, the import map, the safe-area probe |

`index.html` carries a version-stamped **import map** covering every module. It exists so a
cache-busting query string can be applied without editing 108 import statements; when you change
any module, bump `V` in every URL there and in the entry `<script src>` — they must all match.

Geometry is merged into one mesh per material class **per tile** — see below.

## Two rules that are easy to break

**Time-of-day independence.** Geometry and materials only — never bake lighting, shadow or ambient
occlusion into vertex colour, and mark something emissive only if it is genuinely a light source.
The renderer decides *when* lamps are on. Model a shop interior as real geometry and it is daylit at
noon and glowing at midnight for free. Check every change at all four presets.

**Completeness over accuracy.** Where surveyed data exists, use it. Where it is missing or stops
mid-feature, synthesise something plausible — a believable invention beats a hole. A road may end
only at a junction, a designed terminus, or the world boundary. Land never simply becomes water.

**Nothing in the renderer may hold a world coordinate as a literal.** `src/render/` has no access to
`meta.origin`, so any constant it carries in local metres is silently wrong the moment the extract
is rebuilt around a different centre. There is exactly one such uniform, `uCnTower` — the xz axis
of the mask that carries the CN Tower's LED rib wash, its two glazed bands and the red beacons up
the mast — and the expansion moved the origin 1,020 m out from under it, which put the whole
lighting rig over open water and left the most recognisable object in the scene an unlit concrete
shaft at blue hour and night. `city.js` now exports `city.cnTower` from the same position it
extrudes the tower at, and `app/main.js` writes it into `env.cnTower` *and* into `TIME_DEFAULTS`, which
is snapshotted before the city loads and would otherwise put the stale literal straight back on the
next preset change. If a second such constant is ever added, it needs the same treatment.

## Sight lines

The extract is 6.8 × 6.5 km and the player can fly to 2,400 m, so the renderer has to hold up over
roughly 3× the sight lines it was tuned for.

**Near plane 0.30–1.60 m, driven per frame from measured clearance.** For a fixed-point depth
buffer the quantisation step is `2^-24 · z² / near · (1 − near/far)`, so precision is set by the
near plane and almost nothing else — at 0.3 m it is 0.2 m of depth resolution at a kilometre,
wider than the gap between the stacked massing slabs the dataset carries for one real building.
`app/main.js` probes the clearance around the eye and lengthens the plane when it can; shortening
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

## Touch

`app/touch.js` adds a Google-Maps-style camera on phones and tablets. One finger pans, two pinch for
height, twist for heading and sweep for tilt; a double tap zooms in a step and a two-finger tap out.
Nothing is installed unless the device reports touch points, and every handler returns immediately
unless `pointerType` is `touch` or `pen` — a mouse never reaches the module, and a touchscreen
laptop keeps the keyboard, the mouse, pointer lock and the left-handed alias layer in full.

**The pan is a raycast, not a pixel scale.** A metres-per-pixel factor is wrong at every altitude
and every tilt simultaneously, because the ground under the top of the screen is many times further
away than the ground under the bottom. Instead the finger is projected onto the ground plane and the
camera translation is *solved* so the world point picked at touch-down lands back under the finger.
A horizontal translation changes neither the eye height nor the ray directions, so

    pick(screen, eye + T) = pick(screen, eye) + T        for horizontal T

which makes the solve exact in one step and self-correcting: every move event re-solves from the
original anchor, so an event lost to a clamp is paid back on the next one instead of accumulating.
Against its own picking function the solve closes to float64 round-off (1.1 × 10⁻¹³ m), but that
only proves the module agrees with itself. The figure worth quoting is the **end-to-end** one:
unproject the finger through the renderer's own `camera.invViewProj` — the matrix the frame was
actually drawn with — before and after the drag, and measure how far the tracked ground point has
slipped on screen. Over drags of 160–370 px delivered in 2 to 40 events, at 45–300 m of altitude
and −43° to −75° of tilt: **1–11 mm**. The worst case found is **0.95 m**, at 800 m altitude and
−8° of tilt, against an anchor 1.4 km away, in a two-event drag that moved the camera 3.4 km; it is
not drift in the solve but the altitude clamp changing the eye height underneath it, and the next
event pays it back. touch.js's own pick and the render matrix agree to within 36 mm throughout, so
the finger really is over the ground point that is drawn beneath it.

Pinch is a dolly about the ground point between the fingers, so that point holds its screen position
while altitude scales; twist rotates about the same point; tilt slides the camera along its own
bearing so the ground point at the centre of the screen stays put and altitude does not change.
Pitch is clamped to −88°…−2.5°, altitude to 4.5 m above terrain and 2,300 m, and the camera to the
same world bounds the keyboard uses (`worldBounds()` in `app/main.js`, derived from `meta.extent`).

**Two-finger work is batched to the frame.** A browser delivers multi-touch moves *one pointer at a
time*, so acting on each event in turn acts on a pair where one finger has moved and the other has
not — and half a finger of travel looks exactly like a twist. Classification also scores travel
since the gesture started rather than the last delta, and suppresses pinch and twist in proportion
to how parallel the two fingers' travel is, because two fingers moving the same way are a
translation whatever the residual separation says. Without those three things a tilt commits as a
twist and throws the camera kilometres.

Release velocity is measured over a 110 ms window, never differenced between the last two events:
touch runtimes deliver bursts stamped inside the same millisecond, and dividing by ~0 launches the
camera. A burst that spans no time simply reports no velocity.

**The title screen teaches whichever controls exist.** `index.html` carries both tables — keys and
gestures — and `shell.setInputMode('keyboard' | 'touch' | 'both')` picks one. The inline shell makes
a first guess before the module graph has loaded so a phone is never briefly shown a keyboard, and
`app/main.js` overrides it with `detectPointer()`. A hybrid gets **both**, because on that machine both
really are live.

**On-screen controls.** A phone has no `T`, no `Q`/`E` and no `H`, so the buttons sit in the lower
right and change with the movement mode: five in map mode (face north, walk, time of day, quality,
help) and six in walk mode, where *face north* gives way to *map*, *run* and *jump*. They are 52 px
circles on a 64 px pitch — past Apple's 44 px minimum on both counts — and they fold from a column
into a row when a landscape phone is too short for a stack. Layout is taken inside the safe-area
insets, read off the zero-size `#safe` probe in `index.html` whose padding is `env(safe-area-inset-*)`,
since those four numbers are reachable no other way from script; a 59 px notch moves the column in by
exactly 59 px and a 34 px home indicator lifts it by exactly 34. They exist only where `showUi` is
true; a desktop draws none of them and installs no listeners at all.

## Device profile, resolution and the adaptive step

`app/main.js` classifies the machine once at boot from what the browser reports about itself — pointer
type and touch points via `detectPointer()`, the viewport's long side, `deviceMemory` and
`hardwareConcurrency` where they exist. No user-agent string is consulted. There are four profiles:

| profile | when | scene DPR | opens on | ceiling | massing / detail | vertex cap |
|---|---|---|---|---|---|---|
| `desktop` | anything with a mouse, **hybrids included** | 2 | Ultra | Ultra | 5,000 / 780 m | 11 M |
| `tablet` | coarse pointer, long side ≥ 950 px | 1.75 | Medium | High | 3,500 / 429 m | 8 M |
| `phone` | coarse pointer, long side < 950 px | 1.5 | Medium | High | 2,600 / 296 m | 6 M |
| `phoneLow` | as `phone`, with ≤ 3 GB or ≤ 4 cores | 1.25 | Low | Medium | 2,000 / 234 m | 3.6 M |

A touchscreen laptop is a **desktop**: it has the GPU for it, and capping its resolution because a
digitizer exists would be a straight regression.

**The two canvases carry different backing stores.** The scene renders at the profile's cap; the 2D
HUD renders at up to 2.5× whatever the panel offers. Post-processing touches every scene pixel six
to ten times, so 375 × 812 at a phone's native DPR 3 is 2.74 Mpix — more than a 1440 × 900 desktop
window at DPR 1 — on a GPU with a tenth the bandwidth. Canvas text costs microseconds, so it keeps
the pixels the city gives up.

**The vertex cap is a memory budget first.** A vertex is 12 floats = 48 bytes, so the desktop's 11 M
is 528 MB of buffer objects; 6 M is 288 MB and 3.6 M is 173 MB, on top of ~50–80 MB of render
targets. The tile ranges are cut much harder than the cap alone would suggest because `tiles.js`'s
level-of-detail valve surrenders the **most detailed** stage first, all the way to its 0.12 floor,
before massing gives up a metre. Measured downtown, a 625 m tile is ~65 k vertices of massing and
~420 k of street detail, so a cap that massing alone can fill pins detail at a 62 m radius — a
pedestrian walking through an empty model of Toronto. The massing range is therefore set so massing
*fits* and the detail range buys back what is left. A 296 m detail radius is also honest on its own
terms: a 9.5 m cobra lamp at 500 m subtends 9 px on a 375 px screen at DPR 1.5. Every knob is set on
the `TileManager` **instance**; `tiles.js` and `city.js` are not touched.

**The starting preset is a hypothesis, and frame times settle it.** Two phones reporting the same
numbers differ by 4× in fill rate, and the same phone differs by 2× between cold and warm. So the
profile only picks a rung on a ladder, and an adaptive step walks it: the quality presets from the
profile's ceiling down to Minimal, then two resolution rungs at 0.82× and 0.68× of the cap —
resolution goes last, because a soft image is a worse trade than no SSAO until nothing else is left.

The judged statistic is the **60th percentile of the last 150 frames**, not the mean: a tile build
costs a few milliseconds on the frame it lands and a collection costs more, and neither is a reason
to throw away shadows. Below 34 fps it steps down; above 55 fps it steps up. It cannot oscillate,
for three independent reasons:

1. **A wide deadband.** 29.2 ms down, 18.0 ms up. Anything between never moves.
2. **Asymmetric dwell.** 2 s before a second step down, 9 s of unbroken headroom before any step up.
   Stepping down is a rescue; stepping up is a luxury.
3. **Regret is permanent.** A step up that is undone within 12 s strikes that rung off for the
   session, and the search never climbs past a struck-off rung. Every rung gets at most one probe,
   so the number of changes in a session is bounded — this is a search that terminates, not a
   control loop that can hunt.

A hidden tab is never judged (its frame times are a throttle, not the GPU), samples are dropped for
1.2 s after any change while targets rebuild, and the raw — unclamped — frame delta is used so a
tab-switch stall cannot be mistaken for load. Touching `Q`, `E` or the **GFX** button hands control
back to the user for the rest of the session; the HUD says `AUTO` next to the preset name while the
step is live, so it never moves the picture silently.

Measured live, desktop profile, 1440 × 900, seven rungs, by injecting a 33 ms busy-wait into every
frame and then removing it. Under load the controller walked **rung 0 → 6 in six single steps**,
one per dwell, Ultra → High → Medium → Low → Minimal → 0.82× → 0.68×, and stopped at the bottom
reporting `floor`. With the load gone and the 60th percentile back at 8.4 ms it held rung 6 for
**seventeen consecutive judgements — about 10 s — before taking one step up**, then held rung 5 for
another nine judgements without moving again. No rung was visited twice in either direction and the
struck-off set stayed empty. On the phone profile the same controller opened at Medium, measured
8.4 ms, stepped up once to High and stopped: `steps = 1`. Down is a rescue and is quick; up is a
luxury and is rate-limited to one rung per 9 s of unbroken headroom.

**The cheapest preset was the most expensive one.** `core/gl.js` asks for `antialias: true`, so the
default framebuffer is 4× multisampled (`SAMPLES = 4`). Every preset that runs the post chain draws
one full-screen composite quad into it and nothing else — but *Minimal* used to disable the chain
outright and shade the whole city into that MSAA surface. Measured in foreground Chrome on an M1
Pro, 3248 × 1500, 447 draws: Minimal direct **16.3 ms / 61 fps**, Minimal through the offscreen
target plus one composite **8.7 ms / 115 fps**, Low **8.8 ms / 114 fps**. The ladder's bottom rung
was 1.87× the rung above it. `render/targets.js` now keeps the offscreen path whenever it is supported, even
with every effect off; the in-shader-grade fallback for a GPU with no renderable offscreen format is
untouched. Minimal gives up the default framebuffer's free MSAA — it has FXAA off anyway — and its
grade now matches the rest of the ladder to within 1% of mean luminance instead of running 6% hot.

**Safe areas.** `index.html` carries a zero-size `#safe` probe whose padding *is*
`env(safe-area-inset-*)`; reading its computed padding is the only way to get those four numbers
into script. Every HUD anchor, the on-screen buttons and the thumbstick are measured from the safe
box rather than the glass, so nothing lands under a notch, a rounded corner or a home indicator. On
a device with no insets all four read 0 and the layout collapses back to exactly the desktop one.

## The ground floor

From the air the city is right; on foot it used to be filler, and the reason was that the extract
had no nodes in it. It does now, and the ground storey is built from what the survey actually says
is there.

**Block faces, not buildings.** `city.js` finds each building's street-facing frontages, then lays
them out as a run of **units** — the premises between two party walls — rather than repeating one
shopfront along the wall. Where `buildings[].u` has surveyed premises for that frontage, they are
placed at their real `s`/`t` position along the ring and in their real order; the gaps between them
are filled with a synthesised unit whose trade is hashed on **world position**, so a block builds
identically whether or not its neighbours are loaded. `city/unitfronts.js` turns each unit into glazing, a
bulkhead, a sign band, a recessed or flush entry, an awning and a shutter box, all chosen by trade
from one frozen `STYLES` table.

**Lettering is a separate LOD stage.** A 250 mm shop name is a smear past 150 m, so the glyphs are
stage 2 (`SIGN_RANGE`), built after massing and detail and dropped first. The signage pass re-runs
the same layout with `textOnly`, and because every appearance decision inside `appendUnitFront` is
hashed on world position it lands on exactly the fascias the detail stage built. Glyph quads are
not an opaque material class — the renderer draws them with its own program through `drawText()`,
which `CityTiles.forEachMesh` flushes behind the last opaque class.

**Names are real or generic, never invented.** A surveyed unit is lettered with its actual name
(6,805 of them carry one). An unsurveyed unit gets an all-caps generic trade word — `BAKERY`,
`HARDWARE`, `DRY CLEANING` — from `TRADE_WORDS`. Nothing ever fabricates a proper noun, so a sign
you can read is a sign you can trust. **Measured over the whole map: 70,755 units built over
485,728 m of frontage, of which 7,029 are surveyed — 9.9% of all units, or 30.8% of the 22,805
that trade.** The other 90% is deliberate, plausible filler per Amendment 9.

Storey heights come from `buildings[].lv` where the survey has it (4,305 buildings), derived from
total height otherwise (14,006), and **rejected** where the tag implies an impossible floor-to-floor
(2,462) — the levels tag was lifted by matching an OSM polygon to a massing record within 34 m and
that match is sometimes the building next door.

## Local lights

Street lamps used to be geometry and nothing else. `render/lights.js` has carried a clustered forward
light rig the whole time and no caller ever registered anything with it, so `lightStats.registered`
sat at **0** and the only light in a night frame was the sky: the road measured RGB (1, 1, 2) —
luma 0.006 — while the shopfronts above it glowed. Walking Queen Street at 23:30 read as a power
cut.

`city.js` now records every luminaire it places at its **lens** — never at the foot of the mast,
which would light the mast — through `noteLight()`, and `update()` hands the accumulated set to
`renderer.setLights()` on the frames where a tile actually added one. Registrations are keyed on
quantised world position, so a tile that is evicted and rebuilt does not grow the list and the set
is identical whichever order the tiles arrived in. `city.lights` exposes it for the harness.

Whole map: **32,537 luminaires** — 23,723 shopfront spills, 6,039 pedestrian poles, 2,555 cobra
heads, 220 heritage acorns. The renderer culls, ranks and clusters them and uploads at most 512 a
frame; the CPU cost of the gather is 0.6–1.2 ms.

Two placement bugs fell out of wiring this up, both invisible until the lamps actually emitted:

- **`LAMP_SPACING` had no `pedestrian` entry**, so every pedestrianised street in the city — the
  Distillery lanes, the Queens Quay promenade, the squares and mews — got no luminaire at all.
- Worse, `reserve()` refuses any site that lands **on a carriageway**, and a pedestrianised way is
  still a carriageway *record*. Even after adding the pitch, every post along one was refused by
  the test meant to keep masts out of traffic. Pedestrian ways now pass `roadPad = -1`, the same
  convention the other props that legitimately stand on a roadway use.

Together those took acorn lamps from 92 to 216 and pedestrian poles from 4,720 to 5,243, and the
ground on Trinity Street at night from luma 0.006 to 0.131. The Distillery was also outside every
`ACORN_ZONE`, which is why the one quarter downtown that is lit entirely by heritage globes had
none; it has a zone now.

Measured on Queen West at Night, sampling the carriageway every metre along the street: **under a
lamp, luma 0.151 mean and 0.591 peak; between lamps, 0.081 mean and 0.040 floor** — a 1.9× mean
ratio and a 15× peak-to-floor, with the road warm (RGB 42, 36, 20) under sodium and neutral between.

Amendment 7 holds: the rig uploads **0** lights at Afternoon, 512 from Golden hour on. Nothing in
`city.js` decides *when* a lamp is lit — it says only that a luminaire exists at a point.

## Tiling and level of detail

At 252 km² the city is **203 M vertices** (805,523 per km², essentially the 43 km² density held at
six times the area). As eight merged buffers that would be roughly 10 GB of vertex data. So
geometry is partitioned and streamed: **1,085 tiles of 625 m**, an 11 M resident-vertex ceiling,
and eviction by least-recently-drawn.

**The load is three phases, split by WHEN rather than by what.** Measured on an M1 Pro against
both extents:

| phase | what | 43 km² | 252 km² |
|---|---|---|---|
| before the first frame | the ground and the topology every later stage reads: terrain and lake, the surveyed harbour, the dangling-end resolution, the grade solve, the *placement* of every building, the road records, the junction graph, the tile index | **0.79 s** | **24.3 s** |
| | of which: termini 8.4 s · grade 5.3 s · roads 2.6 s · junctions 1.8 s · tile index 1.7 s · footprint placement 1.7 s · harbour 1.3 s · terrain 0.8 s | | |
| when a tile is built | all geometry, and the analysis that is a property of one record and its neighbours: preparing that tile's footprints, the coplanar wall resolution, the corridor portals, the roof-cap verdicts | budgeted, 3.5 ms/frame | same |
| after the first frame | the chore queue: the sweep that prepares the footprints no tile asked for, the walkability audit (§8.2), the quay wall and everything on the water (§8.3), and the sweep that finishes the coplanar analysis | 1.5 s at ~2 ms/frame | 3.3 s at ~2 ms/frame |

**The first row is the open problem.** Footprint preparation and the coplanar solve *were* made
lazy for this expansion, and they cost 1.7 s and 5 ms respectively — the split works. Everything
else in that row is still a whole-city pass in front of the first frame, and it scales with record
count: 24.3 s of analysis plus the 26 MB sidecar fetch and parse puts the first interactive frame
at **27 s**, against 2.27 s downtown. The five items above are what is left to make lazy or
incremental, in cost order.

The middle phase is the one that changed most recently. Coplanar resolution used to be three
whole-city passes in front of the player — 418 ms here, four seconds projected over the pre-1998
city — and every one of its questions is answered by geometry that *touches* the record asking it:
a wall can only fight a wall within 6 cm of it, a cap can only fight a cap whose footprint overlaps
it. So `city/coplanar.js` answers one record when a tile wants it and pulls in whatever neighbours
the answer depends on. Two rules used to lean on global iteration order and were rewritten so they
no longer can: wall-edge keys are **composed** (`record key × stride + ordinal`) rather than
counted, and the cap step-down is stated as "a cap's level is a function of the levels of the
higher-ranked caps that overlap it" rather than as a rank-ordered sweep. Both induce exactly the
order the whole-city pass had, and the geometry fingerprint is bit-identical across the change.

The third phase exists because two passes are genuinely global and neither is needed before a first
frame. The walkability audit measures the whole network — a connected component is not a local
property — and the only thing it *changes* is a handful of local repairs (58 paved connectors, 237
flights of steps over this extract). The quay walks 32 km of surveyed shoreline as continuous runs
that no tile owns. Both run as interruptible generators, write into a capture of their own rather
than into the tile under construction, and hand their geometry over through
`city/lod.js deliverCapture()` when they finish: the capture is cut up by tile exactly as the
up-front one was, and any tile that was already standing is invalidated so the scheduler generates
it again on the next frame. Worst measured slice in the queue: 16 ms, once.

**Tiles are 625 m square** — 25 terrain cells exactly, so the ground mesh splits on cell boundaries
and adjacent tiles share their edge vertices to the bit. Bigger tiles mean fewer draw calls and a
coarser detail radius; smaller mean tighter culling and more draw calls. At 625 m a 3.5 km view is
about 30 tiles and street-level detail is 4–9 of them.

**Two meshes are not tiled**, for the same reason: the lake and the ground apron are on screen from
every viewpoint there is, and streaming them would cost more than keeping them. The lake is a
`city.meshes` entry the frame loop draws itself; the apron is registered with
`TileManager.setStatic('terrain', mesh)`, which draws it first within its material class and takes
its vertices out of the resident cap so the LOD valve still accounts for it.

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

**The facade builders build at two levels**, selected through the `lod` field of the `opts` object every
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
network before it knows where to build a flight of steps, and the *mainland* half of the harbour model (`world/water.js` and `world/quay.js`)
walks 32 km of surveyed shoreline as continuous runs. Both run once into scratch builders;
`captureSplit` then cuts the result up by triangle centroid and hands each tile the float run it
owns. That costs 2.6 M vertices (128 MB) of CPU-side chunks held for rebuild. The proper fix is a
bounding-box predicate in `world/quay.js` — the same change the full city needs anyway, and the island
half of the model is already written that way: `appendIslandMass` and `appendIslandDetail` take
the tile's core cell and emit only the strips, stripes, trees and lights whose anchor falls inside
it, off a spatial model built once.

## The south half: the islands and Billy Bishop

The extract's south edge is 3.44 km² of island in twenty-two rings, 36.5 km of surveyed shore, an
airport, and the two shipping channels either side of the harbour. It is a different place from
the mainland waterfront and `world/islands.js` builds it differently.

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

## The world boundary

The extract is a rectangular cut out of a much larger city, and until this pass its edge read as
exactly that: roads amputated at the bounding box, ground that stopped, and 1,446 way-ends inside
the map that stopped in mid-block because a mapper stopped work. Everything below derives from
`meta.extent` and from the data inside it — nothing knows the rectangle's dimensions — so it stays
correct as the extract grows.

**No dangling ends.** `resolveTermini()` in `city.js` welds every road, footway and railway vertex
by position and counts incidences. A way-end with one incidence is a terminus; it is legitimate
only if it meets a building (measured against real footprint edges), or reaches the boundary band,
where the surround continues it. Everything else is resolved, in order: ends a metre apart are
welded together; an end pointing at another compatible way within 20 m is extended to meet it *and*
the meeting point is spliced into that way, because two polylines that merely touch share no node
and the whole street graph is built on the weld; two ways at the same level that cross with no
shared node get the intersection spliced into both. What survives gets a designed terminus — a
cul-de-sac turning head with a kerb ring, a bollard barrier across an alley or a footpath, or a
buffer stop on a siding. It runs **before** `solveGrade()`, on the raw polylines, so the grade
solve, the junction table, the walkability audit, the ribbons and the street-name index all read
one corrected topology.

Measured at the Old Toronto extent: 17,186 way-ends, of which 10,313 were dangling inside the map
(6,260 end at a building, 613 at the world edge). 12 welded, 5,263 extended to a way, 3,629 nodes
spliced, 4,954 given a designed terminus (3,795 turning heads, 1,143 barrier lines, 16 buffer
stops), 38 PATH concourse ends left to the concourse walls. **0 left.** It is the most expensive
single item in the up-front analysis at 8.4 s.

**Walkability** (§8.2) is audited on the corrected topology and reported as permanent counters:
**7,572.7 km** of walkable metres in 464 components, the largest holding **98.83%** — which clears
the 97% bar outright, where the 43 km² extract held 94.57% and needed the explanation below. The
share rose because the map now contains far more contiguous mainland relative to the water: the
marine exceptions are the same places and the same lengths, but they are a much smaller fraction of
a seven-thousand-kilometre network. 86 components holding 63,207 m are **marine**: separated from
the mainland by water with no bridge, found by flooding the land cells rather than by any
hard-coded list. The largest is 44,366 m of path on the Toronto Islands, which you genuinely do
reach by ferry; Bayview Avenue's severed lengths beyond the Don are the next. Discount those
deliberate, explained exceptions and the largest component holds **99.66%**
(`walk.fractionDry`). Both numbers are kept, because the raw one
is what the contract asks for and the dry one is what it means. `fractionDry` is also what the
harness asserts against the 97% bar: a flat threshold over everything fails for being *right* about
the geography, which is how it came to read 94.55% and mean nothing.

Also counted: 74,573 flights of steps built into drops between 0.45 m and 3 m, 126 gaps stitched
over 653 m, 25,299 m severed as walls, and **0 cliffs left** out of 3,967,609 samples (the 43 km²
extract left 2), the worst surviving
discontinuity being 2.03 m. Anything over a storey is a wall, not a step, so it is counted and
located rather than papered over with a staircase up a retaining wall — but nothing over a storey
survives, and that is now an argument rather than an observation.

**The two passes sample the same stations.** The sever test (which takes a route out of the graph
when the surface under it drops more than `WALK_WALL` = 1.20 m) and the cliff test (which counts
what is left) ask the same question of the same edge, so they must never be able to disagree about
it — and they used to. The sever pass walked the *raw* polyline every 1.5 m while the cliff pass
walks the *welded* segment every `WALK_STEP` = 2 m, so a ground feature narrower than either
spacing could fall between one pass's stations and land on the other's. It did: a 1 m sliver of a
river-crossing ground pad, standing 18.6 m proud of the bed of the Lower Don, was straddled by the
sever pass and hit by the cliff pass, and came out as two 18.63 m "cliffs" at (2557, −2674) and
(2557, −2672) on a route the sever pass had every reason to have removed. The sever pass now walks
the welded segment with exactly `SEVER_REFINE` = 2 times the cliff pass's station count, which
makes every cliff station a sever station as well: two adjacent cliff stations differing by *d*
have two sever intervals between them summing to at least *d*, so one of them is at least *d*/2.
Any drop the cliff pass could call a wall is at least `WALK_CLIFF_WALL` = 3 m, so the sever pass
sees at least 1.50 m across one of its own intervals, clear of the 1.20 m it severs on. The route
comes out first by arithmetic, and the margin only widens if either constant rises.

**Three bands.** Past the survey the world continues in three concentric bands, all sized from the
extent:

1. the **data**, out to `extent/2`;
2. the **fringe**, `SUR_FRINGE` (≈1,230 m here) further. `padTerrain()` grows the terrain grid
   outward by edge replication — after the harbour carve, never before, or the replicated border
   would extrude dry land across the open lake — so the ground, its normals, `groundY` and the
   tiling all simply continue. On top of it `buildSurround()` lays a synthesised street grid and
   generic massing;
3. the **apron**, 13 km further still: ground and water only, four rings of very large quads over
   the extruded height field, ~17 k vertices, always resident, never culled.

**The fringe** is measured out of the boundary strip rather than invented. Each edge gets spokes —
outward streets, one per real street that crosses the boundary there plus fill where the survey
leaves a gap wider than the local block — all sharing one bearing, the length-weighted mean of the
real crossing streets, so the fringe grid is the district's grid and two spokes can never converge
and cross. Corners get a fan sweeping the ninety degrees between two edges. Rings run across the
spokes at the local block pitch (recovered from street density: a lattice of spacing *p* puts *2/p*
metres of street on every square metre), each further out than the last, so blocks grow and detail
thins with distance. A cell between two spokes and two rings is a block; its massing height and
built fraction are the area-weighted mean of the real buildings just inside the boundary, decayed
outward, tapered to nothing over the last 45% of the fringe so the invented city has no last row,
and hashed on world position for everything else. Land and water are decided by the terrain alone,
which is why the same code puts a city north of Bloor and open lake south of the Islands without
being told which is which. A surveyed footprint always wins: the extract clips at the bounding box
rather than at the building, so real footprints spill up to 112 m into the fringe, and no mass is
ever invented on top of one. Every land/water meeting in the surround is clad in riprap found by
marching squares over the terrain, so §9.2 holds out there too.

Cost: 226 k vertices of fringe over 78 tiles (≈2.9 k a tile against a real tile's 51 k), 17 k of
apron, 2 k of riprap, and 55 ms of analysis. The fringe is indexed into tiles like any other
feature and is subject to the same culling, the same LOD stages, the same vertex cap and the same
eviction — it is not a special case anywhere in the renderer.

**The soft limit** stops the player 300 m outside the data, with several hundred metres of
synthesised city still ahead of them and 13 km of drawn world beyond that. `city.confine(player)`
scales the *outward* component of the camera's velocity to zero over the last 150 m, so it coasts
to a halt rather than striking a plane; motion along the boundary and motion back inward are never
touched, so turning round is instant. `city.limitFrac(x, z)` rises 0 → 1 across the same band for a
HUD cue. `city.collide()` also clamps to the limit as an idempotent backstop, so no teleport, no
ejection from a footprint and no recovery from NaN can put anyone outside the world.

**Whether the world visibly ends** (§9.4). The drawn world is a rectangle, so along any bearing
from any viewpoint there is exactly one distance at which it stops — computable in closed form.
`auditHorizon()` casts 6,240 rays from the whole perimeter of the soft limit, at five altitudes up
to the 2,400 m ceiling and 24 bearings, and evaluates the renderer's own fog model (faithfully
duplicated for audit, deliberately, so it fails loudly if either drifts) at all four time presets.

**It passed at 43 km² and it does not pass at 252 km².** Downtown: nearest world edge 13,907 m,
worst airlight 99.15%, 0 rays below the 97% threshold. Old Toronto: **nearest world edge 4,089 m,
worst airlight 7.8% (Night, 1,200 m, 4,242 m sightline), 2,852 of 6,240 rays below the threshold.**

The cause is not the expansion, it is a constant the expansion exposed. `HAZE_REACH` — the flat
apron past the fringe — was cut from 13,000 m to **2,600 m** when the synthesised surround was
removed, on the reasoning that the fog closes a ground plane well before 13 km so the rest of the
apron was just a grey plate. That reasoning holds for a sightline *along the ground* from low
altitude. It does not hold from 1,200 m up near a corner of a 17.3 km map, where the geometry of
the rectangle puts the far edge only 4 km away and the fog has not closed. Raising `HAZE_REACH`
brings the plate back; scaling it with the extent, or closing the fog harder with altitude, are the
two candidate fixes. **Neither is done, and the audit is left failing rather than quietly
re-thresholded.**

**What the surround does not do.** `padTerrain()` continues the ground by *edge replication*, so
beyond the survey every height is the boundary height held constant outward: the north edge is a
plateau at whatever the last surveyed row was (up to 120.54 m now that the elevation ceiling is
right), the south is lake bed at −14.00 m, and no synthesised terrain relief exists anywhere. That is deliberate — it is what makes `groundY` continuous with no
seam and no hole, verified over 491,401 samples across the full 35 × 35 km drawn world with **zero
non-finite results** — but it has a visible consequence. Fly to the land edge of the soft limit in
daylight and look outward and you get a dead-flat plain running to the horizon, bright with
airlight and empty — the synthesised streets and massing that used to fill that band are switched
off (`SUR_ENABLED = false`). Nothing *ends*: there is no boundary line, no polygon edge, no discontinuity, and the
plain is fully hazed long before the world stops. But it reads as open country rather than as more
city, and a player who flies to the corner will know they have left the map. Over water — the whole
southern half of the perimeter — the same construction is exactly right, and the lake horizon is
seamless. Deepening the fringe (`SUR_FRINGE_FRAC`) or giving the surround synthesised relief is the
obvious next move; both cost generation time and vertices, and neither is done.

## Scaling to the full city

This area is ~18,600 buildings; all of Toronto is ~428,000, so about 23×. Therefore: nothing
hard-coded to the bounding box (derive everything from `meta`), no O(n²) passes, and every
procedural hash seeded on **world position rather than array index**, so a building looks the same
whether or not its neighbours are loaded.

Tiling makes that rule load-bearing rather than aspirational. Each tile seeds its own RNG from its
grid coordinates, its own occupancy grid, its own pedestrian budget — nothing accumulates across
tiles, so a tile built alone is byte-identical to the same tile built last. **Verified:** building
the whole map in grid order, in reverse grid order and in a shuffled order produces identical
geometry in every material class, props included — bit-exact, with nothing prepared in advance, so
the lazy footprint preparation is covered by it too. The only differences across the three runs are
in the float64 running totals the audit keeps (metres of kerb, of tram wire, of duplicated wall),
which are summed in tile order and agree to 7 × 10⁻¹⁴ relative.

**Footprint preparation is per tile.** It used to be the single biggest item in front of the first
frame and the only one whose cost was a property of *building count*: every record in the city
turned into oriented parts, given a material and a lighting profile, run through the storey model
and filed in the broadphase, all before anything was drawn. `city/prep.js` splits it in two by
*when*:

* **placement**, over every record, once, up front. Its first ring's centroid — which decides the
  tile that will build it, the landmark match and the island height cap — its height, and the box
  of its raw rings, which sizes that tile's draw box and files it in a reach index. Three typed
  arrays and an integer bucket per record. No record object is allocated, no ring is oriented, no
  material is chosen.
* **preparation**, one record at a time, the first time anything asks about it: when its tile is
  built, when a neighbour's coplanar verdict reaches across a party wall, when the player walks
  into it, or — for everything the flight path never went near — from the chore queue behind the
  first frame, so the audit counters stay a description of the survey.

The broadphase prepares whatever a query reaches before answering it, and the reach index is over
the **raw ring boxes**, so "prepare everything that can overlap this disc" is a handful of records
rather than a whole tile. Two consequences had to be handled explicitly. First, preparing records
in camera order instead of file order changes the order they land in the broadphase, and two
queries over it answer with the *first* hit; so every bucket is kept sorted by record key, which is
the order a single up-front pass produced and a property of the file rather than of the flight
path. Second, the crown-sign ranking — the tallest few towers with real street frontage — is a
global decision, and it is now taken over the placement arrays and walked in that order, so a
record is prepared only when the walk actually reaches it: a couple of dozen records instead of all
of them.

**What the up-front phase still costs, and why.** The whole-city analysis was 2.48 s here and
projected to ~20 s over Old Toronto; moving the coplanar resolution into the tile build, and the
walkability audit and the quay into the chore queue, took it to 1.04 s; making footprint
preparation per-tile and cutting the constant factors below took it to **0.79 s**. Every figure in
the table below is the best of six runs on the same machine; the run-to-run spread is about 8%, so
read them as a shape rather than as a stopwatch. What is left, and how each term grows:

| pass | here | grows with | why it is still up front |
|---|---|---|---|
| surveyed harbour | 234 ms | shoreline length, and ~90 ms of it is the Islands and the airfield, which are a fixed size | `groundY` is composed out of it, and the grade solve, the terrain carve and every ground query read `groundY` |
| dangling ends (`world/termini.js`) | 190 ms | way count | it MUTATES the raw polylines, and the grade solve, the junction table, the ribbons and the street-name index are all built from them; correcting the topology later would leave two of them disagreeing, and repairing a way end after a neighbouring tile had already built it would make geometry a function of the flight path |
| grade solve | 133 ms | crossings | **the seam argument.** A road ducking under the rail corridor has to line up when its two ends are in different tiles, and the only thing that guarantees that is one solve over one graph — the portal-distance propagation that sets a corridor's depth runs over the whole street graph, so it cannot be sharded. It is O(crossings), not O(buildings) |
| road records, junctions | 87 ms | way count | a record's tile is decided by the midpoint of its *resampled* polyline, so deferring the resample would move records between tiles and change what each tile hashes |
| tile index | 45 ms | feature count | a tile cannot be built before it knows what is in it |
| building placement | 35 ms | **building count** | something has to read every record once to know which tile owns it. This is the irreducible residue of a monolithic data file, and it disappears when the streamed per-tile format lands: the packer already assigns every feature to a tile, so placement becomes a property of the bytes that arrive |

Several terms were made cheaper rather than lazier, and each is exactly equivalent rather than
approximate:

* `world/weld.js`'s position-welded node set — built twice by the terminus pass and a third time by
  the grade solve, about 4.5 M bucket lookups over this extract — is an open-addressed table keyed
  on the `(i, j)` pair rather than a `Map` on a composed integer. The probe order is preserved
  exactly, because two nodes can each be within tolerance of a query without being within tolerance
  of each other and the answer therefore depends on the order the nine buckets are visited.
* The water field carries a **per-column northern horizon**. `waterAt()` casts its ray north, so a
  query north of every shore segment in its column is land without any arithmetic; that already
  short-circuits 42% of the lake-bed carve on a waterfront extract, and over a map that reaches
  8 km inland it is nearly all of it. The same horizon rejects a whole way in `collectCrossings()`
  before it is resampled at four metres.
* `findCrossings()` tests the two ways' **layers before** the intersection arithmetic instead of
  after it. The solver only wants pairs whose layers differ, and in a street network essentially
  every pair is two ways on the ground.
* Both segment indices — `findCrossings()`'s and the terminus pass's — hold an **ordinal into a
  flat table** rather than an array literal per segment. That is 88 k short-lived arrays here and
  half a million over Old Toronto, whose only effect was to hand the collector the street network
  twice.
* The street-name index is built on the **first question**, not before the first frame: its only
  reader is the HUD line, and nothing asks it until a player is standing somewhere.

Projected over the pre-1998 city (17.3 × 14.6 km, ~181,000 buildings, ~950 tiles) by scaling each
term by its own driver, the up-front phase lands near **3.6 s** against ~5 s before, and the shape
of it has changed: building count now contributes about 0.35 s instead of ~0.95 s, and everything
else is the road network. Termini and the grade solve are more than half of what remains, and both
are global by argument rather than by accident — so the honest statement is that time to a first
frame is now flat in *building* count and still linear in *way* count.

The work did not vanish; it moved into the tile builds, where it is bounded by the camera's range
instead of by the map. Building everything visible from the opening viewpoint went from 1.03 s to
1.18 s, and that 150 ms is the footprint preparation for the 213 tiles it touches. That number does
not grow with the city — a bigger map does not put more tiles in front of you — which is the whole
point of the move.

## Testing note

In a headless or background browser tab, **both `requestAnimationFrame` and `setTimeout` are
throttled** (a `setTimeout(8)` measured at ~973 ms). Override `requestAnimationFrame` to capture the
callback and drive it in a loop awaiting a *microtask*, not a timer. Install that override **before
the page's modules run** — reload with it in place rather than patching a running page. Chrome does
not fire `rAF` at all while `document.hidden`, so a loop that has already registered its next frame
through the real `rAF` is stopped dead and no shim installed afterwards can restart it; there is no
handle on the callback to call by hand. The city half of the frame can always be driven directly —
`city.update(camera, t, budgetMs)` is exactly what the loop calls — which is enough to exercise tile
builds, the chore queue and every counter, but it draws nothing.

The load yields 18 times now, not 363: `chunked()` yields on a **clock** (12 ms of work between
yields) rather than on a fixed chunk size. A yield costs most of a frame in a visible tab, and the
old fixed sizes spent a third of the load waiting for the loading screen to repaint itself.

`gl.finish()` does not reliably serialise on ANGLE/Metal — frame timings taken around it come back
at 3,000 fps. Read one pixel with `gl.readPixels` instead; that forces the pipeline through.

When measuring frame stability, freeze `env.time` **before every frame** — otherwise animated
windows and reflections masquerade as z-fighting.

Synthetic multi-touch must be dispatched **one pointer per event**, the way a browser does it, with
a frame driven between rounds. Moving both fingers inside a single event is a test that cannot fail
and a gesture classifier that will.

`EXT_disjoint_timer_query_webgl2` is **not** a way round a background tab. The extension is present
and the queries return, but the numbers are scheduling noise: the same unchanged frame, measured
three times in a row in a hidden tab, read 41.7, 8.9 and 43.3 ms, and the result did not move when
the backing store was varied over a 9× range in pixels. Absolute frame times need a foreground tab;
a background tab is good for state, layout and geometry, and nothing else.

HUD overlap is **measured, not eyeballed**: wrap `ctx.fillText` for one frame, record each string's
box from `measureText` (honouring `textAlign` and the actual ascent/descent), and test every pair
for intersection plus every box against the safe rectangle. Compass cardinals are the one exempt
pair — they are 45° apart by construction. The same pass checks the on-screen buttons against every
string and against the safe box.

Safe-area insets can be exercised without a notched device by setting `--sat`/`--sar`/`--sab`/`--sal`
on `:root`: that drives the `#safe` probe the canvas HUD reads *and* the CSS padding on the shell
overlays, so both paths are tested at once.

## The safety nets

Five checks run without a browser. Between them they cover the geometry, the invariants, the module
graph and the shaders; none of them covers the frame, which is why the last step is always to boot
the thing.

| | | |
|---|---|---|
| `npm run check` | `node --check` on every module | catches a syntax error |
| `npm run fingerprint:check` | `tools/fingerprint.mjs` | catches **changed geometry** |
| `node tools/harness.mjs` | `tools/harness.mjs` | catches a **broken invariant** — see below |
| `npm run scope` | `tools/scopecheck.mjs` | catches a **free variable** left behind by a move |
| `npm run shaders:check` | `tools/shadercheck.mjs` | catches a changed program or an unwritten uniform |

**The fingerprint** builds the real city against a stub GL context, drives `tiles.js` through every
stage of every tile, and reduces every emitted vertex to an order-independent hash — each vertex is
hashed alone and the hashes are summed, so re-ordering tiles, re-ordering emitters inside a tile or
splitting one module into six cannot move the number. **203,393,211 vertices**, plus 462 stats
fields, plus every landmark height. It is the proof that a refactor was a move and not a rewrite.

**The baseline is pinned to a data file hash** (`data/toronto.bin`, its byte length and its
SHA-256), so rebuilding the extract invalidates it on purpose rather than by accident. Regenerate
it with `node tools/fingerprint.mjs` **only** after the change to the data is the agreed change —
never to make a failure go away. The right order when the extent moves is: run `--check --strict`
against the *old* data first to prove the code did not alter geometry, then rebuild, then
regenerate. That was done for this expansion: `--check --strict` passed bit-exact on the 4,294,940-
byte downtown sidecar (h1=77f49458, 34,482,234 vertices) before the new baseline was written.

It has two blind spots, both structural:

- **the signs class.** Lettering needs the Canvas 2D font atlas, which does not exist headlessly,
  so `facades.textGlyphs` is 0 and the `signs` bucket is empty. The summary prints a COVERAGE line
  whenever that happens, so it is never silent — but any change to `render/text.js`, `render/font.js`
  or the facade signage pass has to be checked in the browser. In a real tab that pass is alive:
  a settled street-level camera at King and Bay reports 1,749 text runs and 18,639 glyphs from the
  tiles resident around it, and `facades.textBlades` — the geometry the glyphs sit on, which *is*
  fingerprinted — went 1,805 → 12,526 across the expansion.
- **the completion path.** The tool calls `loadCity()` and then walks the tiles itself; it never
  calls `warm()`, so the console summary at the end of a boot never runs under it.

**The scope check** exists because of that second blind spot. Splitting `city.js` moved
`logCitySummary()` out of `loadCity()`'s closure into `city/report.js` still reading two of that
closure's variables, `extent` and `HARBOUR`. `node --check` passes — an unresolved identifier is
legal JavaScript until the line runs — the fingerprint passes, and the browser throws a
`ReferenceError` at the end of a 70-second boot. `tools/scopecheck.mjs` scans every module for an
identifier that is read but never imported, declared, taken as a parameter or global. It is a
scanner and not a parser: bindings are collected generously and reads narrowly, so a finding is
worth reading the line for and a clean run is evidence rather than proof.

**The harness** (`node tools/harness.mjs`) is the fifth, and it answers a different question. The
fingerprint asks *did anything move*; the harness asks *is what we built correct* — no NaN, no
non-unit normals, no prop inside a footprint, no marking under the asphalt, no route running off
the side of a wall, the surveyed landmark heights, the street-grid rotation. It exits non-zero on
any of those.

Its expectations are **derived, not typed in**, because it went stale twice — once when the map
grew to 43 km² and again at Old Toronto — by asserting absolute counts (*4,654 buildings*, *7,926
road ways*, *75 building passages*, *2,500–4,000 people*) that are properties of the **extent**,
not of the code. Every such expectation now comes out of the extract or out of the `city` object
itself: conservation (`built + skipped == the records in the file`), densities (passages per
thousand ways, people per kilometre of walkable route, vertices per km²) and positions read from
`city.cnTower` rather than from a remembered coordinate. What stays a literal is only what is
genuinely absolute — a surveyed height, a rotation in degrees, and the zero-tolerance rules. If you
find yourself editing a number in `harness.mjs` to make it pass, that number was the wrong shape.

## Files that are still too big

Two modules are over the ~800-line ceiling. Both are known and neither is a good split today:

- **`app/touch.js`, 1,350 lines.** One gesture classifier. Pan, two-finger pinch/rotate/tilt, the
  walk-mode thumbstick and the on-screen buttons all share one pointer table and one state machine,
  and the correctness of the whole thing is in the transitions between them. Splitting it by
  gesture would put that state machine across three files and buy nothing.
- **`render/renderer.js`, 874 lines.** Already the residue of a much larger file: shadows, lights,
  post, targets, uniforms, programs and env are each their own module and install their methods on
  `Renderer.prototype` through the `mixin` in `render/util.js`. What is left is the frame itself
  plus the tracked GL state, which is one object with one lifetime.
