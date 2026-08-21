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
| Commerce Court West | 239 m | 240 m |
| Scotia Plaza | 275 m | 277 m |
| First Canadian Place | 290 m | 287 m |
| TD Bank Tower | 223 m | 226 m |
| Rogers Centre | 86 m | 88 m |

The street grid matters as much as the towers. Toronto's core is rotated about 17° west of true
north, and that rotation is what makes it *feel* like Toronto: **Bay 162.5°, Yonge 162.8°,
University 160.6°**, with **King 73.8°** and **Queen 73.9°** perpendicular to within 1.3°.

**4,654 buildings** with real footprints and heights · **7,926 streets** with real names and widths ·
real terrain, from the lakeshore climbing 30 m up to Queen · **730 surveyed facade colours**.

## What's in it

Roughly **7 million vertices in 18 draw calls**, covering Spadina to Yonge/Jarvis and Queen St W
down to the water — 3.1 × 2.2 km.

- **51.6 km of streetcar track** with catenary poles and overhead wire, embedded flush in the asphalt
- **53.5 km of walkways**, 46,809 road markings, 1,471 crosswalks, 246 km of kerb
- **~3,500 pedestrians**, 1,612 parked cars, 2,062 street lamps, 982 street trees
- **4,082 building entrances**, 918 shopfronts, 9,717 balcony bands
- Rooftop plant, tower-crown signage, construction cranes, the rail corridor, the harbourfront quays

Roads that pass under the rail corridor genuinely duck beneath it. The walkable network is
**99.6% connected across 373 km**, with zero cliffs and zero holes — you can set off in any
direction and keep going.

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
```

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
