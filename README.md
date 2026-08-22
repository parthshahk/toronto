# Old Toronto

**[▶ Open the live map](https://parthshahk.github.io/toronto/)**

A geometrically accurate, free-roam recreation of the pre-1998 City of Toronto — 252 km² of it —
that runs in a browser tab. Zero dependencies, no build step, no engine: the renderer, the city
builder and the data pipeline are all written from scratch.

You start over the Inner Harbour looking north at the skyline. Fly in, land anywhere, and walk.

---

## It's the real city

Not an impression of Toronto — built from surveyed open data, and checked against the real thing.

| Landmark | Actual | Here |
|---|---:|---:|
| CN Tower (with mast) | 553 m | 559 m |
| Commerce Court West | 239 m | 239 m |
| Scotia Plaza | 275 m | 277 m |
| First Canadian Place | 298 m | 287 m |
| TD Bank Tower | 223 m | 226 m |
| Royal Bank Plaza, south | 180 m | 175 m |
| Rogers Centre | 86 m | 88 m |

The street grid matters as much as the towers. Toronto's core is rotated about 17° west of true
north, and that rotation is what makes it *feel* like Toronto: **Bay 162.5°, Yonge 162.7°,
University 160.5°**, with **King 74.1°** and **Queen 74.1°** square to them within 1.6°.
Length-weighted over every segment of each street in the extract.

**180,601 buildings** with real footprints and heights (of 181,426 records; 825 are below the
minimum footprint area and are dropped) · **94,643 streets** with real names and widths · real
terrain, from the lakeshore climbing **120 m** to the Eglinton edge, with the Davenport escarpment
— the old Lake Iroquois shoreline — where it actually is · **3,706 surveyed facade colours** ·
**18,684 real storey counts**.

## The shops are the real shops

The thing that makes a street recognisable on foot is not its massing, it is its **ground floor** —
and OSM keeps almost all of that in *nodes*, which the first extracts did not fetch. They do now:
**24,188 surveyed premises on 9,881 buildings**, each with the ring segment and the position along
it where it actually sits, in the order they actually run down the block.

So the block faces are laid out as a row of real premises — Sanagan's Meat Locker on Baldwin, Foot
Locker on Yonge — with their names lettered on the fascia at legible size, drawn from a signed-
distance-field glyph atlas rasterised at boot from a system font. **19,222 of those premises carry
a real name.**

Where the survey is silent the frontage is still filled, because a hole is worse than a guess — but
it is filled with an all-caps *generic trade word*: `BAKERY`, `HARDWARE`, `DRY CLEANING`. **Nothing
ever invents a proper noun.** A name you can read is a name you can trust. Honestly: **3.1% of all
units are surveyed, 14.8% of the ones that trade** — the rest is deliberate, plausible filler. That
share fell as the map grew, and not because anything was given up: OSM's premises survey is dense
downtown and thin in the neighbourhoods, so ten times the frontage came with under three times the
surveyed names.

## What's in it

**252 km²** — 17.31 × 14.58 km: the whole **pre-1998 City of Toronto**, from the Humber east to
Victoria Park, Eglinton south across the harbour to take in the whole Toronto Islands chain and
Billy Bishop airport. High Park, Casa Loma, Queen's Park, the Annex, Riverdale, the Danforth,
Leslieville and the Beaches are all inside it.

- **258 km of streetcar track** with 5,613 catenary poles and 278 km of overhead wire, embedded
  flush in the asphalt
- **879 km of walkways**, 741,413 road markings, 29,674 crosswalks, 4,410 km of kerb,
  28,364 kerb ramps
- **65,709 pedestrians**, 26,250 parked cars, 29,989 street trees, 10,318 cobra lamps
- **484,300 modelled block faces** carrying **653,976 ground-floor units** over 3,993 km of
  frontage — 103,380 shopfronts, 253,843 doors, 47,020 balcony bands, 10,061 fire escapes
- **76,187 surveyed street-furniture nodes** — trees, benches, hydrants, bins, lamps, crossings,
  transit stops, postboxes, bike parking — placed where OSM says they are, not scattered
- **The Toronto Islands** — 3.44 km² of land across 22 islands, the lagoons and marinas, 10 km of
  beach, Centreville, and all the ferry docks
- **Billy Bishop** — 2 runways, 35 taxiways, 3 aprons, 13 stands, 243,000 m² of pavement
- The rail corridor, the harbourfront quay walls, rooftop plant, the Don channel retaining walls

Roads that pass under the rail corridor genuinely duck beneath it: 209 depressed corridors, 1,095
ways carried over, 284 building passages, 14,745 crossings resolved. `groundY` is finite everywhere
— **zero holes**, over a range of 134.5 m — and the walkable network runs to 7,573 km.

## The edge of the map

No road stops in mid-air. Every way-end is either a junction, a door, or a designed terminus, and
the count is a permanent stat: of 17,186 way-ends, 10,313 were dangling; 5,263 were extended to
what they were meant to reach, 3,629 nodes were spliced, 4,954 got a turning head, a barrier or a
buffer stop, 6,260 end at a building. **Zero left.**

The city **ends at the data**. There are no synthesised streets and no invented massing past the
survey — that was tried and removed, because 185 km of invented street read as grey sprawl with
visible radial spokes at the corners. What is left is a 1.8 km fringe of padded terrain so the
ground does not end at a visible cut, then a flat apron 2.6 km further. You are stopped 300 m
outside the data by a soft limit that eases your outward speed to zero over the last 150 m, so you
coast to a halt rather than hitting a wall.

A 6,240-ray audit fires from the whole perimeter of that limit, at five altitudes and 24 bearings
at all four times of day, and evaluates the renderer's own fog. **It does not pass at this extent:
nearest world edge 4,089 m, worst airlight 7.8%, and 2,852 of 6,240 rays fall under the 97%
threshold.** The apron is a fixed 2.6 km ring, chosen when the map was 6.8 km across; at 17.3 km
the camera can get high enough and far enough out that the ground plane stops before the fog has
closed it, and from altitude near the northern edge you can see the world end. Over the lake, which
is a third of the perimeter, it is still seamless. This is a known open item, not a claim.

## How it runs

252 km² is 203 million vertices. Nothing that size fits in one buffer, so the city is cut into
**1,085 tiles of 625 m** and built on demand, cheapest first: stage 0 is massing — the silhouette,
the ground, the carriageways — out to 5 km; stage 1 is everything you can only resolve from the
pavement — markings, kerbs, shopfronts, balconies, furniture, people — out to 780 m; and stage 2
is the lettering on the fascias, out to 165 m, because a 250 mm shop name is a smear past that.
Builds run as generators against a 3.5 ms-per-frame budget, so a dense downtown tile costs twenty
partial frames instead of one long stall, and geometry is evicted least-recently-wanted against an
11 M vertex ceiling.

**Level of detail is for distance only.** The block you are standing on is built exactly as it was
before tiling existed — same facade colours, same window grids, same street furniture. What LOD
takes away is a kilometre out, where a balcony band is under two pixels.

Every procedural choice is seeded on **world position**, never on array index, so a building looks
identical whether or not its neighbours happen to be loaded. That is what makes a tile that builds
alone byte-identical to the same tile built last — and it is what the full city will need.

## Light

Four times of day — afternoon, golden hour, blue hour, night — share one set of geometry and
materials. Nothing is baked: no lighting painted into vertex colours, no ambient occlusion in the
albedo, and a surface is emissive only if it is genuinely a lamp. So the same city reads correctly
at 15:20 and at midnight, and a wet road reflects the towers at night while showing painted
markings at noon.

Buildings light up according to what they actually are. OSM typology drives a per-building profile,
so an office tower shows a strict curtain-wall grid, a condo shows scattered individual units and
balcony spill, retail lights only its ground floor, and a stadium dome gets no windows at all.

**The lamps are real lights.** 56,678 pole and deck luminaires — cobra heads, pedestrian poles,
heritage acorns, quay lamps and the ones under the decks and in the tunnels — plus the spill out of
every lit shopfront, are registered at their lens with a clustered forward light rig that ranks and uploads the 512 nearest each frame. Measured on Queen West at night, the
carriageway reads luma 0.15 under a lamp against 0.08 between them, warm under sodium and neutral
in the gaps. At noon the rig uploads exactly zero: `city.js` says only that a luminaire *exists*
somewhere, and the renderer alone decides when it is on.

Under the hood: cascaded shadow maps, SSAO, GGX specular, screen-space reflections, bloom, an
anisotropic wet-road model with world-space puddles, and procedural window grids that drop to
coarser levels with distance so the skyline never aliases.

## Controls

Both layouts are live at once — use either, or mix them.

| | Right-handed | Left-handed |
|---|---|---|
| Move | `W A S D` | `↑ ← ↓ →` |
| Look | Mouse | Mouse |
| Run / boost | `Shift` | `R-Shift` |
| Up / jump | `Space` | `/` |
| Down | `L-Ctrl` | `R-Ctrl` |
| Walk / fly | `F` | `.` |
| Speed dial | Wheel | Wheel |
| Time of day | `T` | `;` |
| Viewpoints | `V` | `'` |
| Back to start | `R` | `,` |
| Help | `H` | `-` |

Double-click toggles the mouse cursor on and off, in both directions.

### On a phone or tablet

Touch controls are the Google Maps ones, because that is the set every phone user already knows.
The map camera is the default; `WALK` drops you to eye level and `MAP` lifts you back out.

| | Gesture |
|---|---|
| Pan | One finger drag — the ground stays under your finger |
| Height | Pinch, or double tap in / two-finger tap out |
| Heading | Twist two fingers |
| Tilt | Two fingers up or down |
| Walk: look | Drag the right of the screen |
| Walk: move | Thumbstick, bottom left |

Six 52 px buttons sit down the side — face north, walk/map, run, jump, time of day, quality and
help — and fold into a row on a landscape phone. The page itself never scrolls, bounces or
zooms: `touch-action: none` and `overscroll-behavior: none` all the way down, and every gesture
event is consumed.

Nothing touch-related is installed on a machine with no touch points, and every handler ignores a
mouse, so a desktop keeps exactly the input it had. A touchscreen laptop gets **both** at once.
The renderer picks its own quality and resolution on a phone and then re-picks it from measured
frame times — see [ARCHITECTURE.md](ARCHITECTURE.md#device-profile-resolution-and-the-adaptive-step).

## What is not finished

Honest list, all measured at the real extent:

- **Boot is 27 s**, against 2.3 s downtown. Two causes, both whole-city work in front of the first
  frame: the 26 MB sidecar is fetched and parsed up front (see above), and the analysis phases that
  were never made lazy — terminus resolution 8.4 s, the grade solve 5.3 s, road records 2.6 s, the
  junction graph 1.8 s, tile indexing 1.7 s — total 24 s. Footprint preparation and the coplanar
  solve *were* made lazy and now cost 1.7 s and 5 ms.
- **Peak heap is 1.7–2.0 GB**, against 379–406 MB downtown, against a 4 GB browser limit. About
  800 MB of it is the captured harbour and walkability geometry, held as per-tile float chunks.
- **The horizon audit fails** — 2,852 of 6,240 rays, see above.
- Three audit counters are non-zero at this scale: 2 facades facing into their own footprint (the
  same 2 as downtown), 1 coplanar roof-cap pair left unresolved of 153,647 found, and 4 people of
  65,709 sunk into or floating over the ground.

## Running it

Any static server. ES modules don't load from `file://`.

```bash
python3 -m http.server 8123
open http://localhost:8123
```

Needs WebGL2 — Chrome, Edge, Firefox or Safari 15+, hardware acceleration on.

## Checks

Four, all headless, all zero-dependency. Run them before and after any change to the engine.

```bash
npm run check              # node --check on every module
npm run fingerprint:check  # 203 M vertices hashed order-independently — did the city move?
npm run scope              # any identifier read but never bound (a move left a variable behind)
npm run shaders:check      # every GLSL program, and every uniform the draw path writes
```

The fingerprint is the important one: it builds the real city against a stub GL context and
reduces every vertex the map can emit to one hash, so a refactor can be proved to be a move rather
than a rewrite. What none of them cover is the frame itself — boot it and look.

## Rebuilding the city data

`data/toronto.json` is committed, so you only need this to change the area or refresh the source.

```bash
python3 tools/build_city.py    # clip + reproject the massing shapefile, read OSM ways
python3 tools/match_osm.py     # attach typology, materials and facade colours
python3 tools/attach_pois.py   # attach OSM NODES: shop units, street furniture, storeys
python3 tools/pack_city.py     # pack data/city/ (streamed) and data/toronto.bin (fallback)
```

`data/toronto.json` is the authoring format. `pack_city.py` turns it into **`data/city/`** — one
compact binary per tile of the renderer's own grid, grouped a few to a file, plus a small manifest
and one global block for the terrain, the shore and the features larger than a tile. The browser
would fetch the manifest and the global block at boot (1.05 MB, 630 KB gzipped) and then only the
tiles it is standing near, so nothing waits on the far side of the city to render the near side.
All three formats ship and decode to the same doubles — `pack_city.py --verify` reassembles the
whole city from the tiles and proves it is the JSON array for array, **max numeric error 0** — and
anything wrong with `data/city/` falls back to `data/toronto.bin`, and a missing sidecar falls back
to the JSON, each with a console warning.

**The app does not stream the records yet.** `data/city/` is written, verified and complete, and
`src/data/stream.js` and `src/data/tileformat.js` decode and schedule it, but nothing calls
`fetchCity(..., { stream: true })` or `TileManager.setDataSource()`, so today's boot still pulls
the whole 26.05 MB sidecar and parses it before the first frame. Wiring that up is the open item
that matters most — see ARCHITECTURE.md.

Note that a sidecar packed before `attach_pois.py` existed is **not** detected as stale: it decodes
cleanly and simply has no shop units and no street furniture in it, so the city comes up with an
entirely invented ground floor and nothing complains. Re-run `pack_city.py` after any change to the
JSON, and hard-reload the browser — these files cache aggressively.

The pipeline has no Python dependencies — the ESRI shapefile and dBASE parsers are written from
scratch. `tools/build_city.py` expects the source data in `data/raw/` (gitignored, ~400 MB); the
links are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Data

- **Buildings** — City of Toronto Open Data,
  [3D Massing 2025](https://open.toronto.ca/dataset/3d-massing/), Open Government Licence – Toronto
- **Streets, rail, water, typology, facade colours** — © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright)

Attribution appears in the app itself.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the coordinate system, data schema, vertex format and
module layout.
