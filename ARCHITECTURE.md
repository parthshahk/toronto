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
| `city.js` | `toronto.bin` → analysis, per-tile geometry, grade separation, collision, walkability, the world boundary |
| `tiles.js` | the spatial grid, the LOD stages, the build scheduler and the eviction cache |
| `props.js` | street furniture, vegetation, vehicles, pedestrians |
| `facades.js` | entrances, shopfronts, balconies, cornices — at two levels of detail |
| `harbour.js` | quay walls, piers, slips, waterfront walkways, the islands, Billy Bishop |
| `input.js` | keyboard/mouse/pointer-lock, dual-layout aliasing, the touch feeds |
| `touch.js` | the Maps-style multi-touch camera, on-screen controls, the walk-mode thumbstick |
| `main.js` | boot, free-roam camera, time of day, loop, the device profile and the adaptive quality step |
| `index.html` | shell, loading and title screens, attribution, the safe-area probe |

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

## Touch

`touch.js` adds a Google-Maps-style camera on phones and tablets. One finger pans, two pinch for
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
same world bounds the keyboard uses (`worldBounds()` in `main.js`, derived from `meta.extent`).

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
`main.js` overrides it with `detectPointer()`. A hybrid gets **both**, because on that machine both
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

`main.js` classifies the machine once at boot from what the browser reports about itself — pointer
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

**The cheapest preset was the most expensive one.** `gl.js` asks for `antialias: true`, so the
default framebuffer is 4× multisampled (`SAMPLES = 4`). Every preset that runs the post chain draws
one full-screen composite quad into it and nothing else — but *Minimal* used to disable the chain
outright and shade the whole city into that MSAA surface. Measured in foreground Chrome on an M1
Pro, 3248 × 1500, 447 draws: Minimal direct **16.3 ms / 61 fps**, Minimal through the offscreen
target plus one composite **8.7 ms / 115 fps**, Low **8.8 ms / 114 fps**. The ladder's bottom rung
was 1.87× the rung above it. `render.js` now keeps the offscreen path whenever it is supported, even
with every effect off; the in-shader-grade fallback for a GPU with no renderable offscreen format is
untouched. Minimal gives up the default framebuffer's free MSAA — it has FXAA off anyway — and its
grade now matches the rest of the ladder to within 1% of mean luminance instead of running 6% hot.

**Safe areas.** `index.html` carries a zero-size `#safe` probe whose padding *is*
`env(safe-area-inset-*)`; reading its computed padding is the only way to get those four numbers
into script. Every HUD anchor, the on-screen buttons and the thumbstick are measured from the safe
box rather than the glass, so nothing lands under a notch, a rounded corner or a home indicator. On
a device with no insets all four read 0 and the layout collapses back to exactly the desktop one.

## Tiling and level of detail

At 43 km² the city is 26.6 M vertices. As eight merged buffers that is 1.35 GB of vertex data, four
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

Measured: 3,086 way-ends, of which 1,446 were dangling inside the map. 1 welded, 791 extended,
603 nodes spliced, 75 crossings closed, 628 given a designed terminus (407 turning heads, 212
barrier lines, 9 buffer stops), 20 PATH concourse ends left to the concourse walls. **0 left.**

**Walkability** (§8.2) is audited on the corrected topology and reported as permanent counters:
1,217.6 km of walkable metres in 203 components, the largest holding **94.55%**. That is under the
97% bar, and the reason is the lake, not the network. 68 of the 93 islands over 50 m — 59,760 m of
the 63,945 m adrift — are **marine**: separated from the mainland by water with no bridge, found by
flooding the land cells rather than by any hard-coded list. The largest is 44,392 m of path on the
Toronto Islands, which you genuinely do reach by ferry; Bayview Avenue's severed lengths beyond the
Don are the next. Discount those deliberate, explained exceptions and the largest component holds
**99.43%** (`walk.fractionDry`), which clears the bar. Both numbers are kept, because the raw one
is what the contract asks for and the dry one is what it means.

Also counted: 226 flights of steps built into drops between 0.45 m and 3 m, 59 gaps stitched over
294 m, and **2 cliffs left** out of 637,108 samples — both the same 18.63 m drop, at (2557, −2674)
and (2557, −2672), where the Bayview Cycle Path runs along the lip of the Don channel and two
samples fall to the river bed. Anything over a storey is a wall, not a step, so it is counted and
located rather than papered over with a staircase up a retaining wall.

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

**Proof that the world never visibly ends** (§9.4). The drawn world is a rectangle, so along any
bearing from any viewpoint there is exactly one distance at which it stops — computable in closed
form. `auditHorizon()` casts 6,240 rays from the whole perimeter of the soft limit, at five
altitudes up to the 2,400 m ceiling and 24 bearings, and evaluates `render.js`'s own fog model
(faithfully duplicated for audit, deliberately, so it fails loudly if either drifts) at all four
time presets. Nearest world edge 13,907 m; **worst airlight 99.15%** (Night, 2,400 m, 14.1 km
sightline); **0 rays below the 97% threshold**. Confirmed against the framebuffer: at 2,400 m
looking outward the strongest horizontal edge anywhere in the frame is 0.008–0.020 (and lies in the
HUD overlay), against 0.098–0.132 for the same measure looking inward over the real city.

**What the surround does not do.** `padTerrain()` continues the ground by *edge replication*, so
beyond the survey every height is the boundary height held constant outward: the whole north-west
quadrant is a plateau at exactly 39.59 m, the south is lake bed at −14.00 m, and no synthesised
terrain relief exists anywhere. That is deliberate — it is what makes `groundY` continuous with no
seam and no hole, verified over 491,401 samples across the full 35 × 35 km drawn world with **zero
non-finite results** — but it has a visible consequence. Fly to the land edge of the soft limit in
daylight and look outward and you get roughly 1.2 km of synthesised streets and massing, and then a
dead-flat plain running to the horizon, bright with airlight and empty apart from the occasional
spoke road. Nothing *ends*: there is no boundary line, no polygon edge, no discontinuity, and the
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
