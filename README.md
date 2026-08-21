# Downtown Toronto

A geometrically accurate, free-roam recreation of downtown Toronto that runs in a browser tab.

**Zero dependencies. No build step. No engine.** The renderer, the city builder, the shaders and the
data pipeline are all hand-written WebGL2 and ES modules.

```bash
python3 -m http.server 8123
open http://localhost:8123
```

## What makes it accurate

This is not an impression of Toronto — it is built from surveyed open data.

| | |
|---|---|
| Buildings | **4,654** real footprints with real heights |
| Coverage | Spadina to Yonge/Jarvis, Queen St W to the lake — 3,142 × 2,226 m |
| Terrain | Real grade, 0.7–29.6 m above lake datum |
| Streets | **7,926** ways with names, classes and widths |
| Facade colours | **730** buildings with surveyed colours, 33 distinct |
| Named buildings | **1,701** |

Heights validate against the real thing:

| Landmark | Real | Rendered |
|---|---|---|
| Commerce Court West | 239 m | 240 (+0.3%) |
| Scotia Plaza | 275 m | 277 (+0.7%) |
| First Canadian Place | 290 m | 287 (−0.9%) |
| TD Bank Tower | 223 m | 226 (+1.3%) |
| Rogers Centre | 86 m | 88 (+2.5%) |

And so does the street grid. Toronto's core is rotated ~17° west of true north, which is what makes
it feel like Toronto and not a generic grid: **Bay 162.5°, Yonge 162.8°, University 160.6°**, with
**King 73.8°** and **Queen 73.9°** perpendicular to within 1.3°.

## Data sources

Attribution is required and appears in the UI.

- **Buildings** — City of Toronto Open Data, [3D Massing 2025](https://open.toronto.ca/dataset/3d-massing/),
  Open Government Licence – Toronto.
- **Streets, rail, water, parks, building typology, facade colours** — © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright).

`tools/build_city.py` clips the 210 MB city-wide massing shapefile to the bounding box and reprojects
it; `tools/match_osm.py` attaches OSM identity to each footprint. Neither needs any Python packages —
the ESRI shapefile and dBASE parsers are written from scratch.

Three data defects worth knowing about, all handled rather than hidden:
- Web Mercator inflates horizontal distance by `1/cos(lat)` — **38%** at Toronto's latitude. Divided
  out at build time, or every building would be a third too wide for its height.
- `SURF_ELEV` uses `0` for "missing" and `130.1` as a fill value. Terrain is interpolated from the
  trustworthy 62% of samples.
- The massing dataset stops the CN Tower at the SkyPod (443 m). The mast to 553 m is hand-modelled.
- The dataset has no shoreline polygon, so the water's edge is inferred from where roads, paths and
  buildings stop — accurate to roughly ±25 m. It is the one part of the map not taken from data.

## Art direction

Not photorealism. Photorealism is an asset problem, and this project has no assets — everything is
generated. Attempting it lands in uncanny valley. Instead the geometry carries the image: accurate
massing, restrained real materials, and light doing the work.

Buildings light up according to what they actually are. OSM typology drives a per-building lighting
profile, so an office tower shows a strict curtain-wall grid, a condo shows scattered individual
units and balcony spill, retail lights only its ground floor, and a stadium dome gets no windows at
all. Rogers Centre, Scotiabank Arena and Roy Thomson Hall are envelopes, not office blocks.

## Controls

Both layouts are live at once — nothing is rebound, pick either or mix them.

| Action | Right-handed | Left-handed |
|---|---|---|
| Move | `W A S D` | `↑ ← ↓ →` |
| Look | Mouse (horizontal inverted) | Mouse |
| Run / boost | `Shift` | `R-Shift` |
| Up / jump | `Space` | `/` or `Num 0` |
| Down | `L-Ctrl` | `R-Ctrl` |
| Walk / fly | `F` | `.` |
| Speed dial | Wheel | Wheel |
| Time of day | `T` | `;` |
| Jump to a time | `1` – `4` | `Num 1 3 7 9` |
| Quality − / + | `Q` `E` | `[` `]` |
| Next viewpoint | `V` | `'` |
| Help | `H` | `-` |

## Layout

```
index.html          shell, loading, attribution
src/math.js         vec3, column-major mat4, seeded RNG
src/gl.js           GL context, Shader, Mesh, MeshBuilder (13-float vertices)
src/render.js       Camera, Renderer, all shaders, CSM, SSAO, SSR, bloom
src/city.js         toronto.json -> geometry, terrain, collision
src/props.js        street furniture geometry
src/facades.js      building ground-floor and articulation
src/input.js        keyboard/mouse/pointer-lock, dual-layout aliasing
src/main.js         boot, free-roam camera, time of day, loop
tools/              the data pipeline (Python, no dependencies)
data/toronto.json   the built city
legacy/             an earlier unrelated project, kept only until it is safe to delete
```

The vertex format is 13 interleaved floats:
`pos3, normal3, colour3, emissive, tintable, rough, profile` — where `profile` is the building's
night-lighting behaviour and `rough` drives the specular response.

## Requirements

WebGL2 — Chrome, Edge, Firefox or Safari 15+, hardware acceleration on. Must be served over HTTP
(ES modules do not load from `file://`).
