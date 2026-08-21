# Downtown Toronto

**[▶ Open the live map](https://parthshahk.github.io/toronto/)**

A geometrically accurate, free-roam recreation of downtown Toronto that runs in a browser tab.
Zero dependencies, no build step, no engine — the renderer, the city builder and the data pipeline
are all written from scratch.

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
| TD Bank Tower | 223 m | 218 m |
| Royal Bank Plaza, south | 180 m | 175 m |
| Rogers Centre | 86 m | 88 m |

The street grid matters as much as the towers. Toronto's core is rotated about 17° west of true
north, and that rotation is what makes it *feel* like Toronto: **Bay 162.5°, Yonge 162.7°,
University 160.5°**, with **King 74.1°** and **Queen 74.1°** square to them within 1.6°.
Length-weighted over every segment of each street in the extract.

**18,312 buildings** with real footprints and heights · **20,403 streets** with real names and
widths · real terrain, from the lakeshore climbing 40 m to the north · **1,514 surveyed facade
colours**.

## What's in it

**43 km²** — 6.77 × 6.46 km, from Dufferin east to the Don, Dupont south across the harbour to take
in the whole Toronto Islands chain and Billy Bishop airport.

- **108 km of streetcar track** with 2,414 catenary poles and 117 km of overhead wire, embedded
  flush in the asphalt
- **176 km of walkways**, 122,868 road markings, 4,163 crosswalks, 641 km of kerb, 4,203 kerb ramps
- **10,636 pedestrians**, 3,163 parked cars, 2,728 cobra lamps, 1,995 street trees
- **15,960 modelled ground floors**, 4,308 shopfronts, 22,501 balcony bands
- **The Toronto Islands** — 3.44 km² of land across 16 islands, the lagoons and marinas, 10 km of
  beach, Centreville, and all 8 ferry docks
- **Billy Bishop** — 2 runways, 35 taxiways, 3 aprons, 13 stands, 243,000 m² of pavement
- The rail corridor, the harbourfront quay walls, rooftop plant, the Don channel retaining walls

Roads that pass under the rail corridor genuinely duck beneath it: 77 depressed corridors, 364 ways
carried over, 131 building passages, 7,486 crossings resolved. `groundY` is finite everywhere —
**zero holes** — and the walkable network runs to 1,218 km.

## The edge of the map

No road stops in mid-air. Every way-end is either a junction, a door, or a designed terminus, and
the count is a permanent stat: of 3,086 way-ends, 1,446 were dangling; 791 were extended to what
they were meant to reach, 603 nodes were spliced, 628 got a turning head, a barrier or a buffer
stop. **Zero left.**

Past the surveyed rectangle the city keeps going — about 1.2 km of synthesised streets and massing
that copy the bearing, block pitch, height and density of whatever district they are leaving, then
13 km of ground and water to the horizon. You are stopped 300 m outside the data by a soft limit
that eases your outward speed to zero over the last 150 m, so you coast to a halt rather than
hitting a wall, with invented city still ahead of you and the drawn world running 14 km further.

A 6,240-ray audit fires from the whole perimeter of that limit, at five altitudes and 24 bearings
at all four times of day, and evaluates the renderer's own fog: nearest world edge 13,907 m, worst
airlight 99.15%, **zero rays under the 97% threshold**. The world never visibly ends. It is not
uniformly *interesting*, though — the surround has no synthesised terrain relief, so past the
fringe on the landward side you get a flat hazed plain rather than more city. Over the lake, which
is most of the perimeter, it is seamless.

## How it runs

43 km² is 26 million vertices. Nothing that size fits in one buffer, so the city is cut into
**156 tiles of 625 m** and built on demand, cheapest first: stage 0 is massing — the silhouette,
the ground, the carriageways — out to 5 km, and stage 1 is everything you can only resolve from
the pavement — markings, kerbs, shopfronts, balconies, furniture, people — out to 780 m. Builds
run as generators against a 3.5 ms-per-frame budget, so a dense downtown tile costs twenty partial
frames instead of one long stall, and geometry is evicted least-recently-wanted against an 11 M
vertex ceiling.

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

Under the hood: cascaded shadow maps, SSAO, GGX specular, screen-space reflections, bloom, and
procedural window grids that drop to coarser levels with distance so the skyline never aliases.

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

## Running it

Any static server. ES modules don't load from `file://`.

```bash
python3 -m http.server 8123
open http://localhost:8123
```

Needs WebGL2 — Chrome, Edge, Firefox or Safari 15+, hardware acceleration on.

## Rebuilding the city data

`data/toronto.json` is committed, so you only need this to change the area or refresh the source.

```bash
python3 tools/build_city.py    # clip + reproject the massing shapefile, read OSM
python3 tools/match_osm.py     # attach typology, materials and facade colours
python3 tools/pack_city.py     # pack the binary sidecar the loader actually reads
```

Or `npm run build:city`, which runs all three in order. `data/toronto.json` is the authoring
format; `data/toronto.bin` is the packed sidecar — both ship, and the loader falls back to the
JSON with a console warning if the sidecar is missing or stale.

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
