// src/render/shaders/facade.glsl.js -- procedural window grids on building facades.
//
// CONTRACT 3.2 item 5. Storey lines from world Y, bay lines from the horizontal tangent, and a
// per-cell lit/unlit decision with warm colour jitter, dispatched on the OSM-derived lighting
// profile carried in aMat.w (0 envelope, 1 office, 2 residential, 3 retail, 4 parking, 5 civic).
// 
// Composed into the scene pass only. No backticks -- see common.glsl.js.

// Procedural facade lighting — CONTRACT §3.2 item 5, and the single thing that makes 4,818 boxes
// read as Toronto rather than as boxes. Everything is derived from WORLD POSITION; there are no
// UVs anywhere in this project.
//
//   storey lines : world Y
//   bay lines    : distance along the facade's own horizontal tangent, T = normalize(up x N),
//                  which is stable for every vertical face and degenerate only on roofs (where
//                  the whole effect is masked out by `vertical`)
//   seed         : hashed from the facade PLANE (its normal and its offset from the origin) plus
//                  the building's lighting profile, so it is constant across one wall and
//                  different for the next building along — no per-building attribute is needed
//                  and no seam can appear mid-facade
//
// THE PROFILE IS THE POINT. data/toronto.json now carries an OSM-derived lighting profile per
// building in aMat.w, and a single office-window treatment applied to every vertical surface in
// the city — stadium domes included — is precisely what made the old build read as procedural:
//
//   0 ENVELOPE     no window grid AT ALL. Rogers Centre, Scotiabank Arena, Roy Thomson Hall,
//                  the CN Tower. Pure material shading; these are envelopes, not curtain walls.
//   1 OFFICE       strict curtain-wall grid, whole floors dark, warm white with a cool minority
//   2 RESIDENTIAL  individual suites: wide cells, LOW lit fraction, much warmer and far more
//                  varied per unit, balcony bands, blue TV flicker, dark vertical runs
//   3 RETAIL       a bright warm shopfront band at street level, dark above
//   4 PARKING      open horizontal deck slots, greenish-white strip lighting, mostly open air
//   5 CIVIC        small punched windows, mostly dark, tungsten — heritage stone character
export const GLSL_FACADE = `
// The widest a pane edge may be filtered, in CELLS. It is a clamp rather than the raw footprint
// because a filter wider than the pane itself takes the pane's peak with it, and a window that
// has lost its peak has stopped being interior light and started being a grey wall.
//
// 0.50, not 0.35. The crossfade in vhFacade below hands this function a FINE level whose cell
// footprint runs from VH_WIN_FOLD to 2 x VH_WIN_FOLD of a pixel, so the fine level's aa is
// 0.50-1.00 and the old clamp left it under-filtered over that whole span — including at the
// bottom of it, where the crossfade gives the fine level ALL of the weight. Cost of widening it:
// an office pane's peak coverage falls from 1.000 to 0.960 at the worst point, which is nothing
// next to what it buys in temporal stability at 2 km and beyond (see VH_WIN_FOLD).
const float VH_WIN_AA_MAX = 0.50;
// One evaluation of the facade lattice at ONE cell size. Returns rgb = emitted interior light,
// w = GLAZING coverage (1 inside a pane, 0 on a mullion, spandrel, slab or masonry wall) so the
// caller can keep panes smooth and roughen everything that is not glass.
//
// 'uvw' is (distance along the facade tangent, world Y) and 'aaWorld' is that pair's screen-space
// derivative in METRES. Both are computed by the caller in uniform control flow: fwidth() inside
// this function would be undefined for any 2x2 quad that straddles the "is this a wall?" test.
//
// 'hAbove' is metres above local grade — retail shopfronts and parking decks are placed by it.
vec4 vhFacadeCells(int prof, vec2 uvw, vec2 cellSz, vec2 off, float seed,
                   float lit, float time, vec2 aaWorld, float hAbove) {
  vec2 sz = max(cellSz, vec2(0.35));
  vec2 g = (uvw + off) / sz;
  vec2 aa = max(aaWorld / sz, vec2(1e-5));
  vec2 cell = floor(g);
  vec2 f = g - cell;
  vec2 e = min(aa, vec2(VH_WIN_AA_MAX));

  float r = vhHash21(cell + vec2(seed * 91.7, seed * 47.3));          // per cell
  float rf = vhHash21(vec2(cell.y * 0.5 + 3.0, seed * 137.3));        // per floor
  float rc = vhHash21(vec2(cell.x * 0.5 + 11.0, seed * 61.9));        // per vertical run
  float r2 = fract(r * 13.77);
  float r3 = fract(r * 5.91);

  // Pane rectangle inside the cell (x0, x1, y0, y1), the tint, whether the cell is lit at all,
  // its brightness, and any emitter that is NOT bounded by the pane (strip lights, balcony
  // spill, signage wash). Every profile fills these in its own way.
  vec4 win = vec4(0.11, 0.89, 0.20, 0.88);
  vec3 tint = vec3(1.0);
  vec3 extra = vec3(0.0);
  float on = 0.0;
  float level = 1.0;
  float glazed = 1.0;

  if (prof == 1) {
    // ---- OFFICE -------------------------------------------------------------------------
    // A strict curtain wall: uniform bays, a deep spandrel under every sill, and WHOLE FLOORS
    // dark because the cleaners have been and gone. Colour sits warm-white with a cool
    // fluorescent minority, and a floor tends to share one lamp type because one tenant fitted
    // it out — that floor-wide coherence is a large part of what makes an office read as an
    // office next to a condo.
    win = vec4(0.085, 0.915, 0.215, 0.885);
    float floorDark = step(0.26, rf);
    float bayDark = step(0.05, rc);
    on = step(r, lit) * floorDark * bayDark;
    level = 0.55 + 0.45 * r3;
    tint = vhLampTint(0.30 + 0.66 * pow(r2, 1.25));
    tint = mix(tint, vhLampTint(0.34 + 0.58 * rf), 0.50);
    // A thin line of corridor light survives on some dark floors — never a perfectly black band.
    extra = vec3(0.62, 0.66, 0.72) * (1.0 - floorDark) * step(0.55, rc) * 0.030;
  } else if (prof == 2) {
    // ---- RESIDENTIAL --------------------------------------------------------------------
    // A condo does not light like an office and must not look like one. Cells are a whole SUITE
    // wide, only a quarter to a third are lit, each one is a different warmth and brightness
    // because it is a different person's lamp, whole vertical runs are dark (service cores, the
    // unsold north face), and one in ten lit rooms is a television.
    float balconied = step(0.42, fract(seed * 3.19));
    win = mix(vec4(0.10, 0.90, 0.24, 0.90), vec4(0.055, 0.945, 0.42, 0.945), balconied);
    float runDark = step(0.17, rc);
    float floorDark = step(0.07, rf);
    on = step(r, lit) * runDark * floorDark;
    level = 0.26 + 0.90 * r3 * r3;
    tint = vhLampTint(0.015 + 0.44 * pow(r2, 0.72));
    // Television: a cold blue that breathes. Two detuned sines beat against each other, which
    // reads as cut-to-cut flicker rather than as a sine wave.
    float tv = step(0.895, fract(r * 31.7)) * on;
    float beat = 0.42 + 0.58 * abs(sin(time * 3.1 + r * 61.0) * sin(time * 1.37 + r * 17.0));
    tint = mix(tint, vec3(0.40, 0.58, 1.00), tv * 0.92);
    level *= mix(1.0, beat * 1.35, tv);
    // Balcony slab: a dim warm spill onto the concrete under a lit suite, and the slab edge
    // catching a little of it. This is the horizontal banding that says "condo" from 2 km.
    float slab = (1.0 - smoothstep(0.30, 0.40, f.y)) * balconied;
    extra = tint * on * level * slab * 0.16;
  } else if (prof == 3) {
    // ---- RETAIL -----------------------------------------------------------------------------
    // Bright warm shopfront at street level, dark above. The band is placed by height above LOCAL
    // grade, not world Y — downtown climbs 30 m from the lake and an absolute band would sit in
    // the sky at King & Bay and underground at the ferry docks.
    win = vec4(0.055, 0.945, 0.10, 0.86);
    float band = smoothstep(0.20, 1.10, hAbove) * (1.0 - smoothstep(4.4, 6.6, hAbove));
    // Above the shopfront: a tenth as many windows, dimmer. Not black — a mixed-use podium has
    // a stair core and the odd back office, and pure black slabs read as holes in the street.
    on = mix(step(r, lit * 0.13), step(r, lit), band);
    level = mix(0.30 + 0.30 * r3, 0.72 + 0.42 * r3, band);
    tint = vhLampTint(0.20 + 0.52 * r2);
    // Signage: one shopfront in eight runs a saturated sign, and that is where the only real
    // chroma at street level comes from.
    float neon = step(0.875, fract(r * 23.1)) * band;
    float sk = fract(r * 3.31);
    vec3 signCol = mix(vec3(1.00, 0.24, 0.28), vec3(0.34, 1.00, 0.70), smoothstep(0.28, 0.52, sk));
    signCol = mix(signCol, vec3(0.32, 0.62, 1.00), smoothstep(0.60, 0.84, sk));
    tint = mix(tint, signCol, neon * 0.85);
    // Light spilling out of the shopfront onto the sidewalk soffit above it.
    extra = tint * on * band * 0.10;
  } else if (prof == 4) {
    // ---- PARKING ----------------------------------------------------------------------------
    // Open decks: a continuous horizontal slot broken by a column every cell, not a grid of
    // windows. The slot is OPEN AIR, so it returns no glazing at all (w = 0) and the caller
    // roughens the whole surface as bare concrete. What you actually see at night is the
    // greenish-white strip fitting on the deck ceiling and a dim wash on the slab.
    glazed = 0.0;
    float slot = smoothstep(0.10 - e.x, 0.10 + e.x, f.x) * (1.0 - smoothstep(0.90 - e.x, 0.90 + e.x, f.x));
    slot *= smoothstep(0.20 - e.y, 0.20 + e.y, f.y) * (1.0 - smoothstep(0.82 - e.y, 0.82 + e.y, f.y));
    float deckOn = step(0.12, rf);
    float strip = smoothstep(0.68, 0.74, f.y) * (1.0 - smoothstep(0.79, 0.83, f.y));
    vec3 fluor = vec3(0.74, 0.96, 0.82);
    // The interior is a dark cavity with the fitting glowing in it, plus the fitting itself.
    extra = fluor * deckOn * (slot * 0.085 * (0.7 + 0.6 * rc) + strip * slot * 0.70);
    on = 0.0;
    tint = fluor;
    level = 0.0;
  } else if (prof == 5) {
    // ---- CIVIC ------------------------------------------------------------------------------
    // Heritage stone: small punched openings in a lot of wall, nearly all of them dark, and what
    // little is lit is tungsten. Union Station, St Lawrence Hall, the old bank halls.
    win = vec4(0.335, 0.665, 0.245, 0.700);
    on = step(r, lit) * step(0.30, rf);
    level = 0.32 + 0.46 * r3;
    tint = vhLampTint(0.02 + 0.20 * r2);
  }

  float px = smoothstep(win.x - e.x, win.x + e.x, f.x) * (1.0 - smoothstep(win.y - e.x, win.y + e.x, f.x));
  float py = smoothstep(win.z - e.y, win.z + e.y, f.y) * (1.0 - smoothstep(win.w - e.y, win.w + e.y, f.y));
  float pane = px * py * glazed;
  return vec4(tint * pane * on * level + extra, pane);
}

// Per-profile lattice geometry. Cell size, phase offset, lit fraction and the pane coverage a
// facade converges on once its cells fall below a pixel. Kept in one place so the LOD crossfade
// below is written once and every profile gets it.
void vhFacadeStyle(int prof, float seed, float baseLit,
                   out vec2 cellSz, out vec2 off, out float lit, out float meanPane) {
  float j1 = fract(seed * 7.31);
  float j2 = fract(seed * 3.77);
  // Office: 3.9 m floor-to-floor, ~3 m bays.
  cellSz = vec2(3.00 * (0.86 + 0.34 * j2), 3.92 * (0.95 + 0.13 * j1));
  lit = baseLit * 1.34;
  meanPane = 0.60;
  if (prof == 2) {
    // A condo suite is WIDE and its floors are SHORT — the opposite proportion to an office,
    // which is most of why the two silhouettes read differently before you see a single colour.
    cellSz = vec2(6.45 * (0.84 + 0.36 * j2), 3.06 * (0.96 + 0.10 * j1));
    lit = baseLit * 0.74;
    meanPane = 0.56;
  } else if (prof == 3) {
    cellSz = vec2(2.85 * (0.80 + 0.45 * j2), 4.45 * (0.92 + 0.18 * j1));
    lit = baseLit * 1.55;
    meanPane = 0.62;
  } else if (prof == 4) {
    cellSz = vec2(7.60 * (0.88 + 0.26 * j2), 3.10 * (0.95 + 0.12 * j1));
    lit = baseLit;
    meanPane = 0.0;
  } else if (prof == 5) {
    cellSz = vec2(4.55 * (0.86 + 0.30 * j2), 4.35 * (0.92 + 0.18 * j1));
    lit = baseLit * 0.40;
    meanPane = 0.20;
  }
  off = vec2(fract(seed * 5.17), fract(seed * 11.13)) * cellSz;
  lit = clamp(lit, 0.0, 1.0);
}

// Where the lattice folds, in CELLS PER PIXEL, and how many times it may.
//
// A cell is one pane plus one mullion — one period of the signal — so Nyquist puts the hard floor
// at 1.0 cells per pixel and any real reconstruction filter wants to be well under it. 0.50 holds
// every cell at two pixels or more. It was 0.62 (1.6 px), which is inside the range where the
// per-cell lit/unlit draw is still a random field at the sampling rate, and the crossfade spends
// half its weight on a level finer than that again.
//
// Nothing the player stands next to can be touched by this: the first fold happens where a cell
// first falls under two pixels, which for an office lattice with 2.6-3.6 m bays at 1440x900 is
// 1.0-1.4 km (it was 1.3-1.7 km at 0.62). Street level, and the whole of the detail-tile radius,
// is below lod 0 and runs the unfolded lattice exactly as before.
//
// MEASURED — the temporal CRAWL of a skyline region, i.e. the RMS change over a half-pixel camera
// yaw, reported against the same measurement on a 2x supersampled pair, which is the floor a 1x
// image can reach. Night, where the lattice is the only signal in the frame:
//
//                                    postcard, 2.2 km          far corner, 5.5 km
//     fold 0.62, filter 0.35        0.1088 / 0.0786  1.38     0.0387 / 0.0253  1.53
//     fold 0.50, filter 0.35        0.1040 / 0.0792  1.31     0.0392 / 0.0253  1.55
//     fold 0.50, filter 0.50        0.0994 / 0.0784  1.27     0.0360 / 0.0240  1.50
//
// And the far corner's residual is NOT the lattice. With the window light switched off entirely
// the same region measures 0.0116 / 0.0068 — a ratio of 1.71, worse than the lattice's — because
// what crawls at 5.5 km is the SILHOUETTE, one-pixel roof and wall edges, which is FXAA's problem
// and not the LOD's: with FXAA off the full-lattice figure is 0.0651 / 0.0375. The frequency LOD
// holds at six kilometres; it is the thing keeping that number as low as it is.
const float VH_WIN_FOLD = 0.50;

// How many times the lattice may fold. 4 is 16x cells — a 48 m office bay — which is reached at
// a facade footprint of 24 m per pixel, i.e. only on walls seen within a couple of degrees of
// edge-on. Past that the cell stops tracking and the pane filter carries it; letting it keep
// doubling instead would put one lit-or-unlit cell across a whole tower, which is worse than the
// aliasing it would be fixing.
const float VH_WIN_LOD_MAX = 4.0;

vec3 vhFacade(int prof, vec3 world, vec3 N, vec2 uvw, vec2 aaWorld, float baseLit,
              float time, float hAbove, out float glass) {
  float d = dot(world, N);
  float seed = vhHash31(vec3(floor(d * 0.31 + 0.5) + float(prof) * 19.0,
                             floor(N.x * 5.0 + 5.5), floor(N.z * 5.0 + 5.5)));

  vec2 cellSz, off;
  float lit, meanPane;
  vhFacadeStyle(prof, seed, baseLit, cellSz, off, lit, meanPane);

  // ---------------------------------------------------------------------------------------
  // DISTANCE LOD. Fading 'lit' toward its own mean turns the skyline into flat khaki slabs --
  // bloom and the filmic shoulder are non-linear, so the mean is not the appearance. But full
  // contrast at every distance makes every tower dissolve into sub-pixel speckle from across
  // the harbour, which is worse: the massing stops reading at all.
  //
  // So reduce the FREQUENCY, not the contrast. Cells double in size as they approach a pixel,
  // exactly like a mip level, and crossfade between the two nearest levels so nothing pops.
  // Cells stay fully lit-or-unlit, so they still punch through the tonemap and read as interior
  // light -- but they never fall below the sampling rate. This is also what real buildings look
  // like at 2 km: you see lit clusters and dark floors, not individual panes. Every profile
  // gets it, which matters most for the residential lattice: its cells are the largest, so it
  // is the last to fold, and a condo tower keeps its sparse scattered look furthest out.
  float perPixel = max(aaWorld.x / cellSz.x, aaWorld.y / cellSz.y);
  float lod = clamp(log2(max(perPixel, 1e-5) / VH_WIN_FOLD), 0.0, VH_WIN_LOD_MAX);
  float l0 = floor(lod);
  float t = lod - l0;
  float m0 = exp2(l0);

  vec4 a = vhFacadeCells(prof, uvw, cellSz * m0, off, seed, lit, time, aaWorld, hAbove);
  vec4 b = vhFacadeCells(prof, uvw, cellSz * (m0 * 2.0), off, seed, lit, time, aaWorld, hAbove);
  vec4 res = mix(a, b, t);

  glass = mix(res.w, meanPane, smoothstep(2.5, 4.0, lod));
  return res.rgb;
}

// --- CN Tower ------------------------------------------------------------------------------
// The single most recognisable object on the skyline, and it must not be lit like anything else
// in the city. The real tower carries a programmable LED wash that walks slowly through blues,
// violets and cold whites, lit restaurant and SkyPod glazing bands, and red aviation beacons up
// the mast. All of it is keyed off metres above the tower's own base, so it travels correctly
// whichever way the camera looks at it.
vec3 vhCnWash(float hUp, float time) {
  // A slow travelling gradient: the pattern climbs the shaft while the palette rotates.
  float w = fract(time * 0.026 - hUp * 0.0021);
  vec3 c = vec3(0.10, 0.34, 1.00);                                    // deep blue
  c = mix(c, vec3(0.58, 0.22, 1.00), smoothstep(0.00, 0.28, w));      // violet
  c = mix(c, vec3(0.16, 0.72, 1.00), smoothstep(0.26, 0.52, w));      // cyan
  c = mix(c, vec3(0.82, 0.90, 1.00), smoothstep(0.50, 0.74, w));      // cold white
  c = mix(c, vec3(0.10, 0.34, 1.00), smoothstep(0.72, 1.00, w));      // back to blue, seamlessly
  return c;
}

// One red aviation beacon: a soft band up and down the mast from its fitting, pulsing.
float vhCnBeacon(float hUp, float at, float rate, float time) {
  float band = 1.0 - smoothstep(0.0, 8.0, abs(hUp - at));
  float s = 0.5 + 0.5 * sin(time * rate + at * 0.37);
  float pulse = s * s;
  pulse *= pulse;
  pulse *= pulse;
  return band * (0.10 + 0.90 * pulse);
}
`;
