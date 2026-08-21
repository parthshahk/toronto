# TORONTO — Engineering Contract (NORMATIVE)

A geometrically accurate, free-roam recreation of downtown Toronto. Zero dependencies, WebGL2,
no build step. **Accuracy first, visuals second, gameplay never (for now).**

Area: Spadina/The Well (W) to Yonge/Jarvis (E), Queen St W (N) to Lake Ontario (S).
3,142 m east-west x 2,226 m north-south. Financial District, Entertainment District, King West,
Harbourfront, Rogers Centre, CN Tower.

> **BINDING.** Export names and signatures below are normative — modules are written in parallel
> against them. Extra private helpers are fine; changing the public surface is not.

## 0. Art direction — "blue-hour massing model"

Not photoreal. Photorealism is an *asset* problem and we have zero assets; attempting it lands in
uncanny valley. Instead: **accurate massing, restrained real materials, dusk light.**

- Time is fixed near **blue hour** (~20:45 in June): sun just below the horizon, sky deep
  cyan-to-indigo overhead grading to warm orange at the western horizon.
- Towers are lit **from within** — window grids with per-cell lit/unlit variation carry the image.
- Streets are **wet**: strong specular and screen-space reflections of the towers and sky.
- The lake is dark, glassy, and reflects the skyline.
- Palette is cool and desaturated apart from the warm interior light and sodium street lamps.
- The goal: someone who knows King & Bay should recognise it instantly from silhouette alone.

## 1. Coordinate system and data

`data/toronto.json` (3.1 MB) is produced by `tools/build_city.py` from:
- **City of Toronto Open Data — 3D Massing 2025** (Open Government Licence – Toronto): buildings.
- **OpenStreetMap contributors (ODbL)**: streets, rail, water, parks, parking, piers.
Attribution for BOTH is mandatory and must appear in the UI and the README.

**World axes: X = east, Y = up, Z = south.** Right-handed. Origin at the bbox centre
(-79.38850, 43.64400). All units are TRUE METRES (Web Mercator's 1/cos(lat) inflation is already
divided out at build time — do not re-apply it).

```jsonc
{
  "meta": { "origin": {lon,lat}, "bbox": {...}, "extent": {x,z}, "lake_msl": 74.6, "sources": [...] },
  "terrain": { "nx":126, "nz":90, "cell":25.0, "h":[...] },   // metres above lake datum, row-major, +z south
  "buildings": [ { "h":<height m>, "y":<terrain base m>, "r":[ ring, ...] } ],  // ring = [[x,z],...]
  "roads":  [ { "c":"motorway|major|minor|service|pedestrian|foot", "w":<m>, "n":"<name>",
                "b":<bridge 0|1>, "tun":<tunnel 0|1>, "p":[[x,z],...] } ],
  "areas":  [ { "k":"water|park|grass|parking|pier", "p":[[x,z],...] } ],
  "rails":  [ { "k":"rail|tram|light_rail|subway", "p":[[x,z],...] } ]
}
```

**Ring winding warning:** ESRI shapefiles wind outer rings clockwise and holes counter-clockwise.
The build step negates Y (north) into +Z (south), which **mirrors the plane and reverses winding**.
Do not assume a winding — compute the signed area of each ring and treat the largest-|area| ring as
the outer boundary, the rest as holes. Emit triangles wound counter-clockwise when viewed from
outside/above, because the renderer culls back faces.

**Known data defects (handle, do not "fix" upstream):**
- The CN Tower reads **443 m** — the dataset models it to the SkyPod and omits the antenna mast.
  `city.js` must add the mast (to 553 m total) as a special case, located near local (114, -159).
- ~25% of buildings had no usable `SURF_ELEV`; terrain is already interpolated and smoothed, so use
  `terrain` for ground height everywhere and `building.y` for a building's base.
- Some footprints are stacked massing slabs for one real building. Do not merge them; overlapping
  extrusions are expected and correct.

## 2. Vertex format (12 floats)

```
[ px,py,pz,  nx,ny,nz,  r,g,b,  emissive, tintable, rough ]
```
`VERT_FLOATS = 12`; `aMat` = vec3(emissive, tintable, rough) at attribute location 3.
`rough`: 0 = mirror, 1 = matte. `MeshBuilder.color(r,g,b, emissive=0, tintable=0, rough=0.85)`.

Material guide: glass 0.06 · polished stone 0.25 · wet asphalt 0.18 · dry concrete 0.90 ·
sidewalk 0.85 · water 0.03 · steel 0.15 · brick 0.92 · foliage 0.95.

## 3. Modules

| File | Role | Depends on |
|---|---|---|
| `src/math.js` | vec3/mat4/rng — **unchanged, already correct** | — |
| `src/gl.js` | GL, Shader, Mesh, MeshBuilder — extend to 12 floats | — |
| `src/render.js` | Camera, Renderer, all shaders, CSM, SSAO, post | math, gl |
| `src/input.js` | keyboard/mouse/pointer-lock — **keep the left-handed KEY_ALIAS layer** | — |
| `src/city.js` | `data/toronto.json` -> meshes, terrain sampling, collision | math, gl |
| `src/main.js` | boot, free-roam camera, loop | everything |
| `index.html` | shell, loading, attribution | — |

### 3.1 `src/city.js`

```js
export async function loadCity(gl, url = './data/toronto.json', onProgress);
```
Returns:
```js
{
  meta, extent, terrain,
  meshes: { terrain, buildings, glass, roads, sidewalks, water, rails, props },
  groundY(x, z),                 // bilinear terrain sample, metres
  buildingAt(x, z),              // -> building or null (uniform-grid broadphase)
  collide(x, z, r),              // -> {x, z, hit} circle-vs-footprint resolution
  streetNameAt(x, z),            // -> nearest road name within ~25 m, for the HUD
  stats,                         // {buildings, verts, roads, tris}
}
```
Requirements:
- **Ear-clipping triangulation** with hole support for roofs (and for water/park/parking areas).
  Must handle the ~5,110 rings without hanging; guard against degenerate/self-intersecting rings.
- Buildings extrude from `y` to `y + h`. Walls get per-face normals, roofs get flat caps.
- **Facade materials** assigned by height and footprint area, with a deterministic hash for
  variation: >150 m -> curtain-wall glass; 40-150 m -> mixed glass/stone; <40 m -> masonry/concrete.
  Hand-assign the known landmarks by proximity to their real coordinates: TD Centre towers matte
  black steel, Royal Bank Plaza gold-tinted glass, First Canadian Place white marble, Scotia Plaza
  red granite, Commerce Court West silver, CN Tower concrete.
- **Window grids are procedural in the shader**, not geometry — the renderer needs a per-building
  seed and a "storey height" it can derive from world Y. `city.js` only needs to emit correct
  emissive/rough/material channels so the shader can do the rest.
- Roads become ribbon meshes from their polylines: mitred joins, correct width, slightly crowned,
  laid on the terrain surface with a small y offset. Bridges (`b:1`) sit above terrain; tunnels
  (`tun:1`) are skipped. Sidewalks are generated as parallel ribbons offset from major/minor roads.
- Total static geometry should land under ~3M vertices, merged into as few meshes as possible
  (one per material class). Log the counts once.
- Loading must be **incremental** — report progress and yield so the loading bar animates.

### 3.2 `src/render.js` — the visual bar

Keep and DO NOT regress: the hue-preserving peak rolloff in `vhFilmic`, the halo-weighted bloom
attenuation `b *= mix(1.0, 0.22, saturate(sceneLum))`, and the three-tier bloom fallback.

Add, in priority order:
1. **Cascaded shadow maps** — 3 cascades, 2048², PCF, texel-snapped, blended at boundaries.
2. **SSAO** — depth attachment becomes a depth TEXTURE; half-res, 16 samples, bilateral blur,
   applied to ambient only.
3. **GGX specular + Fresnel** driven by the `rough` channel.
4. **Screen-space reflections** for wet roads and the lake — this is the signature of the look.
   Ray-march the depth buffer, fade on ray length and screen edge, fall back to a sky-colour
   approximation on miss.
5. **Procedural window grids** on glass facades: derive storey lines from world Y and bay lines from
   the horizontal tangent, produce per-cell lit/unlit with warm colour jitter. Blue hour means
   ~55-70% lit.
6. **Sky**: blue-hour gradient, scattered cloud, first stars, no sun disc (sun is below horizon).
7. **Height fog** so the street grid sits in haze and towers rise clear of it.
8. **Post**: bloom (existing) + anamorphic horizontal streak, split-tone grade, grain, subtle
   chromatic aberration.

`renderer.quality = { shadows, ssao, ssr, bloom, clouds }`, each independently disable-able and each
degrading cleanly. Nothing may block boot.

### 3.3 `src/main.js` — free roam only

No gameplay. No vehicles, weapons, missions, NPCs.
- **Walk mode**: eye at 1.7 m, gravity, terrain following, collision against buildings.
- **Fly mode**: 6-DOF, no collision, speed scaling — for looking at the skyline.
- `F` toggles walk/fly. Mouse look via pointer lock. Shift boosts.
- **Both control layouts stay live** (WASD *and* arrows + right-hand cluster) — the user is
  left-handed and this is a hard requirement, see `input.js` KEY_ALIAS.
- Minimal HUD: current street name, compass, coordinates, speed, fps. A help overlay on `H`.
- Data attribution visible in the UI.

## 4. Definition of done

- Boots with zero console errors, loads `toronto.json`, renders the city.
- 60 fps at 1440x900 on an M-series Mac with shadows+SSAO+SSR on.
- You can walk from The Well east along Front St, past the CN Tower and Rogers Centre, into the
  Financial District, and recognise every block.
- No NaN in camera or player position. No falling through terrain.

## 5. Amendment — user preferences (HARD REQUIREMENTS, never regress)

These are explicit user preferences, not defaults to be "corrected" toward realism.

1. **Movement is deliberately fast.** Real pedestrian speed crosses this 3.1 km map in 37 minutes,
   which makes free roam a chore. Current values in `src/main.js`:
   `WALK_SPEED = 7.0`, `RUN_SPEED = 22.0`, `FLY_SPEED = 85.0`, `FLY_BOOST = 4.5`,
   with `GROUND_ACCEL = 18.0` so it feels responsive rather than floaty.
   Do NOT restore realistic speeds.

2. **`player.speedMult` is a live speed dial** — mouse wheel, or `[` / `]` (which alias to Q/E for
   the left-handed layout). Clamped to `SPEED_MULT_MIN..SPEED_MULT_MAX` (0.15..12). Multiplicative
   so it feels even across the range. Show the current value in the HUD.

3. **Horizontal mouse look is INVERTED** by user preference: moving the mouse right turns the camera
   left. Implemented as `LOOK_INVERT_X = -1` applied to the yaw delta. `LOOK_INVERT_Y = 1`
   (vertical is normal). Keep both as named constants so either axis can be flipped in one place.

4. **The left-handed control layout stays live alongside WASD** — see `src/input.js` KEY_ALIAS.
   Any new binding added anywhere must also get a right-hand alias in that table.

## 6. Amendment — STREET-LEVEL DETAIL PASS

The silhouette and massing are good. The ground plane is not: roads are flat ribbons, there is no
street furniture, and buildings meet the pavement with no entrance, canopy or storefront. This pass
adds the detail you actually see while walking. Accuracy still rules — place from real OSM geometry
wherever it exists rather than scattering procedurally.

### 6.1 New module `src/props.js` — street furniture geometry

Pure geometry builders. Each APPENDS into an existing MeshBuilder (never creates a Mesh) so the
whole city stays a handful of draw calls. All take `(mb, ...)`. `rng` is the city's seeded rng.

```js
// Lighting — Toronto downtown uses several distinct types; get the silhouettes right.
export function appendCobraLamp(mb, x, y, z, yaw, h = 9.5);   // arterial: tapered mast + curved arm + LED head
export function appendTwinCobraLamp(mb, x, y, z, yaw, h = 11); // median: two arms
export function appendAcornLamp(mb, x, y, z, h = 4.6);         // heritage districts: fluted post + acorn globe
export function appendPedestrianLamp(mb, x, y, z, yaw, h = 5.2);
export function appendCatenaryPole(mb, x, y, z, yaw, h = 8.2); // streetcar overhead: pole + bracket arm
export function appendTrafficSignal(mb, x, y, z, yaw, armLen); // mast arm + 3-lamp heads + pedestrian head
export function appendSignPost(mb, rng, x, y, z, yaw);         // street-name blades, one-way, no-parking

// Furniture
export function appendBench(mb, x, y, z, yaw);
export function appendLitterBin(mb, x, y, z, yaw);             // Astral-style two-stream bin
export function appendBikeRing(mb, x, y, z, yaw);              // Toronto's ring-and-post rack
export function appendBollard(mb, x, y, z);
export function appendPlanter(mb, rng, x, y, z, s);
export function appendHydrant(mb, x, y, z, yaw);
export function appendMailbox(mb, x, y, z, yaw);               // Canada Post red
export function appendNewsBox(mb, rng, x, y, z, yaw);
export function appendParkingMachine(mb, x, y, z, yaw);
export function appendTransitShelter(mb, x, y, z, yaw, len);   // glazed shelter + ad panel
export function appendPlatformShelter(mb, x, y, z, yaw, len);  // streetcar island platform

// Vegetation
export function appendStreetTree(mb, rng, x, y, z, scale);     // trunk + canopy + tree-pit grate
export function appendParkTree(mb, rng, x, y, z, scale);
export function appendShrub(mb, rng, x, y, z, scale);

// Utility
export function appendManhole(mb, x, y, z);
export function appendGrate(mb, x, y, z, yaw);
export function appendUtilityBox(mb, rng, x, y, z, yaw);
```

Budget: a lamp under ~90 verts, a tree under ~260, small items under ~60. These are placed in the
thousands.

### 6.2 New module `src/facades.js` — building ground-floor and articulation

```js
export function appendEntrance(mb, rng, x, y, z, yaw, width, style);
//   style: 'revolving' | 'double' | 'shopfront' | 'service'
export function appendCanopy(mb, rng, x, y, z, yaw, width, depth);
export function appendShopfront(mb, rng, x, y, z, yaw, width, height);   // glazing + bulkhead + sign band
export function appendAwning(mb, rng, x, y, z, yaw, width, depth);
export function appendBalconyBand(mb, x, y, z, yaw, width, depth);        // glass-rail condo balcony
export function appendCornice(mb, x, y, z, yaw, width, depth);
export function appendStringCourse(mb, x, y, z, yaw, width);
export function appendFireEscape(mb, rng, x, y, z, yaw, width, floors);
export function appendLoadingDock(mb, x, y, z, yaw, width);
export function appendParapet(mb, x, y, z, yaw, width, h);
```

Requirements:
- **Entrances**: every building gets at least one, on its street-facing facade, sized and styled by
  the building's lighting profile — offices get revolving doors + a canopy, residential gets a
  glazed lobby, retail gets a shopfront, envelope/industrial gets a service door.
- **Ground-floor storefronts** along retail frontages: glazing, a bulkhead, a sign band, recessed
  entries. This is the single biggest win for street-level believability.
- **Balconies** on residential towers. The projecting glass balcony is THE Toronto condo signature
  and its absence is very visible. Band them per floor with realistic depth (~1.8 m).
- **Cornices and string courses** on heritage/masonry stock; **fire escapes** on older brick.

### 6.3 `src/city.js` — ground plane and placement

- **Roadway markings**: lane lines, centre lines (double-yellow on arterials), stop bars, zebra and
  ladder crosswalks at intersections, turn arrows, painted bike lanes (Toronto has them on Richmond,
  Adelaide, Bay, Simcoe), and box-junction hatching where appropriate.
- **Kerbs** with proper height (~0.15 m), kerb ramps at every corner, and tactile plates.
- **Sidewalks from real data**: the OSM extract contains **4,941 `highway=footway` ways** that are
  currently unused. Build them as real walkways with kerbs, not just wide road ribbons.
- **STREETCAR TRACKS**: the extract has **209 `railway=tram` ways**. Toronto's streetcar network on
  King, Queen, Spadina, Bathurst, Queens Quay and Dundas is a defining visual feature — embedded
  rails flush in the asphalt, with catenary poles and overhead wire. Wire can be a thin line of
  geometry; it reads at distance and is unmistakably Toronto.
- **Rail corridor**: the `railway=rail` ways south of Front need ballast, sleepers and rails.
- **Placement rules**: lamps every ~28 m along arterials alternating sides; traffic signals at
  intersections of major roads; transit shelters near tram stops; bins/benches/bike rings at
  intervals on sidewalks; street trees in pits along commercial streets; hydrants every ~70 m.
  All seeded and deterministic. Nothing may be placed inside a building footprint or on a
  carriageway.
- Feed everything through `props.js` and `facades.js`; do not reinvent geometry in `city.js`.

### 6.4 Budget and performance

- Total static geometry may rise to ~6M vertices. Keep the merged-mesh-per-material-class structure
  so draw calls stay in the low tens. Log the counts.
- Generation must still complete in a few seconds with incremental progress.
- If the budget is at risk, drop prop DENSITY (spacing) before dropping prop QUALITY — sparse good
  lamps beat dense bad ones.

## 7. Amendment — TIME-OF-DAY INDEPENDENCE (binding on all detail work)

The city has four time presets (Afternoon, Golden hour, Blue hour, Night) and more may be added.
**All detail must be time-of-day agnostic and must look natural at every one of them.**

### 7.1 The rule

Detail contributes **geometry and material properties only**. It must never bake a lighting
assumption. Concretely:

- **Never bake light into vertex colour.** No pre-darkened "shadow" tints, no pre-brightened
  "sunlit" faces, no warm colour added to a surface because it "looks better at night". The
  albedo is what the surface reflects; the renderer decides how it is lit.
- **Never bake ambient occlusion into albedo.** Contact darkening is the renderer's job (SSAO).
- **Emissive is a LAMP, not a look.** A surface gets `emissive > 0` only if it is genuinely a light
  source in the real world: a lamp head, a lit sign, an illuminated shopfront interior, a beacon.
  A wall is never emissive to "make it read better in the dark".
- **Every emitter must respond to time of day.** Street lamps, shop interiors, signage and window
  light are OFF at midday, ramping on through golden hour and full at night. The renderer owns this
  via the daylight/nightFactor terms; detail authors only mark WHAT is an emitter, never WHEN.
- **Roughness and colour are physical constants.** They do not change with time of day.

### 7.2 Consequences for placement

- Geometry that only makes sense at night (a pool of light painted on the pavement, a glow decal)
  is forbidden. Model the lamp; let the renderer light the ground.
- Interiors visible through ground-floor glazing should be modelled as real geometry (a floor, a
  back wall, a counter) with an emissive ceiling fixture — so the shop is dark in the day with
  daylight falling in, and glows at night. That reads correctly at all four times for free.
- Anything with a strong directional look (awning shadows, canopy undersides) must rely on real
  geometry so the sun and CSM produce the shading naturally.

### 7.3 Verification requirement

Any pass that adds detail MUST be checked at **all four time presets** before it is called done.
Cycle `applyTime(0..3)` and confirm:
  - no surface is emissive at midday that should not be (street lamps dark, shop interiors lit only
    by daylight, no glowing windows),
  - no surface is invisible at night that should be readable,
  - no colour or roughness changes between presets,
  - the transition between presets is plausible — nothing pops on or off unnaturally.
Report measured numbers per preset, not impressions.

## 8. Amendment — ROAD CONTINUITY, HARBOURFRONT, AND SCALING TO THE FULL CITY

### 8.1 The street network must be continuous and walkable

The current area is a TEST SLICE. The user will extend this to all of Toronto later, so nothing may
be hand-tuned to this bounding box.

A pedestrian must be able to walk the entire network without hitting a gap, a cliff, or a hole.
Roads that pass under a rail corridor, an expressway or a building must be MODELLED, not deleted.

`data/toronto.json` roads now carry (fixed this session — the previous encoding was wrong):
- `lay`  signed layer, -4..4. **Negative means the way passes UNDER something.**
         Distribution: -3:8, -2:69, -1:669, 0:6987, +1:144, +2:20, +3:29
- `b`    1 only for a genuine `bridge=yes` (151 ways; was wrongly 955)
- `tun`  1 = real tunnel/underpass (630 ways, previously DELETED, leaving holes)
         2 = `building_passage` — a road through a building, stays at grade and stays walkable (75)

Requirements:
- Underpasses (`lay < 0`) are DEPRESSED roadways: the carriageway dips, with retaining walls, a
  portal where it passes beneath the structure above, and the rail/road deck carried over it.
- Tunnels are built with portals and an interior; at minimum the walking surface must be continuous
  through them. Never skip a way outright.
- Bridges (`b === 1`, `lay > 0`) rise over what they cross, with abutments and piers.
- Grade separation must be CONSISTENT: where two ways cross, the one with the higher `lay` passes
  above. Vertical transitions must be ramped over a realistic distance, never a step.

### 8.2 Walkability is an acceptance test, not an aspiration

Build a walkable graph from the carriageways, footways and crossings and verify:
- **Connectivity**: the largest connected component contains at least 97% of walkable metres.
  Report the size and location of every disconnected island above 50 m.
- **No cliffs**: no adjacent walkable surface samples differing by more than 0.45 m without ramp or
  step geometry between them.
- **No holes**: `groundY` must be defined and finite everywhere inside the world bounds, and the
  player must never be able to fall out of the world.
- Report these as permanent stats counters.

### 8.3 Harbourfront

The shoreline was previously SYNTHESISED by distance-transforming the road network (~±25 m). That
guess is now replaced by surveyed data:
- `shore`: 13 ways clipped from the OpenStreetMap **Lake Ontario** multipolygon relation.
- `waterfront`: 173 engineered edge structures — `pier`, `quay`, `breakwater`, `groyne`,
  `retaining_wall`, `marina`, `ferry_terminal`.

Toronto's harbourfront is entirely engineered, so the quay wall IS the land/water boundary:
- Build a real quay wall along the shoreline with a vertical face, a coping edge and water meeting
  it cleanly — no interpolated terrain sloping into the lake, no z-fighting at the waterline.
- Queens Quay, the Martin Goodman Trail and the boardwalk are major public walkways and must be
  continuous and correct.
- Piers, slips and marinas are real geometry. Water fills the slips between them.
- The transition from paving to quay edge to water must read cleanly at every time of day.

### 8.4 Scaling to the full city (design constraint NOW, delivery later)

Full Toronto is ~428,000 building records against the 4,654 here — roughly 90x. Therefore:
- Nothing may be hard-coded to the current bounding box. All extents, origins and grid sizes derive
  from `meta`.
- Generation cost must stay roughly linear in feature count. No O(n^2) passes over buildings or
  roads; keep using the uniform-grid broadphase.
- The data format must remain streamable/tileable. Do not add anything that requires the whole city
  in memory at once to make sense.
- Prefer per-tile determinism: a seeded hash keyed on WORLD POSITION, never on array index, so a
  building looks the same whether or not its neighbours were loaded.

## 9. Amendment — COMPLETENESS OVER ACCURACY (overrides earlier priority)

> "i just dont want broken roads and stuff. if data not present we can sacrifice the accuracy and
>  you can finish it up, but completeness is a must. imagine a video game where a road suddenly ends
>  or suddenly becomes water - thats not good. we need to have clear boundaries everywhere"

This **reverses the earlier priority**. Sections 0 and 8 said accuracy first. From here:

**COMPLETENESS IS MANDATORY. ACCURACY IS BEST-EFFORT.**

Where surveyed data exists, use it — accuracy is still the goal and must not be casually discarded.
Where data is missing, contradictory, or stops mid-feature, **SYNTHESISE something plausible**.
A believable invention always beats a hole. Never leave a gap because the data ran out.

### 9.1 No dangling geometry

Every linear feature must terminate DELIBERATELY. A road, footway, rail or walkway may end only at:
- a junction with another feature,
- a designed terminus (cul-de-sac head, turning circle, barrier, gate, buffer stop, building), or
- the world boundary, handled per 9.3.

A way that simply stops in mid-air, mid-block or mid-pavement is a BUG regardless of what OSM says.
OSM ways routinely end where a mapper stopped work; those are data artifacts, not real terminations.
Detect every dangling endpoint and resolve it: extend to the nearest compatible feature and connect,
or cap it with a plausible terminus.

### 9.2 No abrupt surface transitions

Land must never simply become water, and no surface may end at a vertical drop the player can see
past. Every land/water meeting needs a real edge: quay wall, beach, riprap, retaining wall, railing
or barrier. Same for any level change: ramp, steps, wall or fence — never a raw polygon edge.

### 9.3 The world needs a designed boundary

The playable area is currently a rectangular slice of a larger city, and its edge must not read as
"the world stopped". Beyond the data extent, generate a **synthesised surround**:
- continue the street grid outward in a plausible pattern,
- populate it with generic massing consistent with the adjacent district's character,
- reduce detail with distance (no props or facades needed far out), and
- fade it into atmospheric haze so there is no hard line.
Then stop the player with a soft, explained limit well inside the visual edge — never a place where
they can see or reach nothing.

This surround must be cheap and must scale: it is procedural filler, not data, and it must not slow
generation meaningfully or blow the vertex budget.

### 9.4 Acceptance test

The bar is a player's, not a surveyor's: **walk or fly anywhere in the world and never encounter a
break.** Specifically, all of these must hold:
- 100% of walkable metres reachable, or every exception explained and deliberate.
- Zero dangling endpoints, reported as a permanent counter.
- Zero raw polygon edges visible at any land/water or level transition.
- No viewpoint inside the playable area from which the world visibly ends.
- `groundY` finite everywhere; the player can never fall out of the world.

Report each as a number. "Mostly connected" is a fail.
