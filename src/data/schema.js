// src/data/schema.js — THE shape of data/toronto.json and data/toronto.bin, in one place.
//
// CONTRACT.md Amendment 11.2: new surveyed fields land here, not in whichever consumer noticed
// them first. `units`, `pois`, `lv`, `hn` and `rs` were added in one session and were promptly
// re-parsed — with slightly different validity rules — in three places. Everything that reads a
// raw record now reads it through this file.
//
// Nothing here builds geometry, allocates a mesh or knows what Toronto looks like. It knows what
// a field is called, what it means, what units it is in and what counts as a usable value.
//
// ============================================================================================
// COORDINATES
// ============================================================================================
// World axes: X = east, Y = up, Z = south. Right-handed. Origin at the bbox centre
// (meta.origin). ALL UNITS ARE TRUE METRES — Web Mercator's 1/cos(lat) inflation is already
// divided out at build time by tools/build_city.py, and must not be re-applied. Terrain heights
// are metres above the lake datum (meta.lake_msl above sea level).
//
// ============================================================================================
// data/toronto.json  (tools/build_city.py -> match_osm.py -> attach_pois.py)
// ============================================================================================
//
//   meta      { origin:{lon,lat}, bbox, extent:{x,z}, lake_msl, sources[] }
//   terrain   { nx, nz, cell, h[] }        metres above lake datum, row-major, +z south
//
//   buildings[]
//     h   number   height in metres above `y`
//     y   number   terrain base in metres
//     r   ring[]   footprint rings, ring = [[x,z], ...]. Largest |area| ring is the outer
//                  boundary; same-sign rings are separate parts, opposite-sign rings are holes.
//                  Winding is NOT fixed — see geom/ring.js.
//     t   0..5     LIGHTING PROFILE, from the OSM building/amenity tags. See core/vertex.js.
//     m   string   facade material key, when surveyed
//     c   [r,g,b]  surveyed facade colour, linear 0..1
//     n   string   building name
//     hn  string   house number on the street frontage
//     lv  number   SURVEYED STOREY COUNT, 1..200. Beats deriving storeys from height.
//     rs  string   roof shape ('gabled', 'hipped', 'flat', ...)
//     u   unit[]   THE PREMISES ON THE FRONTAGE, in order along it:
//                    c  category ('shop', 'amenity', ...)
//                    v  tag value ('bakery', 'cafe', ...)
//                    s  index of the footprint SEGMENT the unit sits on
//                    t  parameter 0..1 along that segment
//                    n  name        b  brand        h  house number      o  1 if hours known
//
//   roads[]
//     c   string   class: motorway | major | minor | service | pedestrian | foot
//     w   number   carriageway width, metres
//     n   string   street name
//     lay -4..4    SIGNED LAYER. Negative means the way passes UNDER something.
//     b   0|1      1 only for a genuine bridge=yes
//     tun 0|1|2    1 = real tunnel/underpass, 2 = building_passage (at grade, stays walkable)
//     p   [[x,z]]  polyline
//
//   areas[]       { k: water|park|grass|parking|pier, p: [[x,z], ...] }
//   rails[]       { k: rail|tram|light_rail|subway,   p: [[x,z], ...] }
//   shore[]       { role: string, p: [[x,z], ...] }   Lake Ontario multipolygon, clipped
//   waterfront[]  { k: pier|quay|breakwater|groyne|retaining_wall|marina|ferry_terminal,
//                   n: name, p: [[x,z], ...] }
//   pois[]        { k: kind, x, z, n: name }          standalone surveyed OSM nodes, local metres
//
// ============================================================================================
// data/toronto.bin  (tools/pack_city.py) — the packed sidecar
// ============================================================================================
// Same information, decoded by data/load.js into an IDENTICAL object graph. Layout:
//
//   bytes 0..3   magic 'TOR2'
//   bytes 4..7   uint32 LE header length
//   then         the JSON header: { meta, terrain:{nx,nz,cell}, dicts:{...}, blocks:{...} }
//   then         the typed-array blocks, at header.blocks[name].off from the end of the header
//
// FIXED POINT, AND WHY THE DECODER DIVIDES. Every scaled integer below is decoded by DIVIDING by
// its scale, never by multiplying by the reciprocal. An integer count of centimetres divided by
// 100 is the correctly-rounded double for that decimal — exactly what parsing "-387.21" gives —
// whereas multiplying by the inexact literal 0.01 lands one ulp away on about 7% of the city's
// vertices. The sidecar's whole promise is that which loader ran cannot be told from the geometry.

/** Magic bytes at the head of data/toronto.bin: 'T', 'O', 'R', '2'. */
export const SIDECAR_MAGIC = [84, 79, 82, 50];

/** Bytes before the JSON header: 4 of magic plus a uint32 header length. */
export const SIDECAR_HEADER_OFFSET = 8;

// ============================================================================================
// data/city/  (tools/pack_city.py) — THE STREAMED CITY
// ============================================================================================
// The same information again, cut up so the browser fetches only what it is standing near. At
// the Old Toronto extent the monolithic sidecar is ~34 MB and every byte of it has to arrive and
// be parsed before the first frame; this is a few tens of KB before the first frame and a group
// file at a time after it.
//
//   manifest.json   the grid, the extent, the meta block, the per-tile block table, the enum
//                   vocabularies, and per tile: which group file it is in, its byte range there,
//                   and the box that contains everything it owns.
//   global.bin      the terrain height field, the lake shore, the waterfront structures, and the
//                   features larger than one tile. Fetched once, at boot.
//   gNNNN.bin       a group of GROUP_EDGE x GROUP_EDGE tiles' payloads, concatenated.
//
// OWNERSHIP. A feature belongs to exactly ONE tile — the one holding its anchor, computed the
// same way city/tileindex.js computes it — and that tile's box grows to contain the whole
// feature. Nothing is clipped and nothing is duplicated: reassembling every tile plus the global
// block reproduces data/toronto.json array for array. A feature LARGER than a tile has no tile
// that can honestly own it, so it goes in the global block with the shore and the terrain.
//
// The payload layout is in data/tileformat.js, which is the only file that reads these bytes.

/** Magic bytes at the head of a per-tile payload: 'T', 'O', 'R', 'T'. */
export const TILE_MAGIC = [84, 79, 82, 84];

/** Magic bytes at the head of data/city/global.bin: 'T', 'O', 'R', 'G'. */
export const GLOBAL_MAGIC = [84, 79, 82, 71];

/** Bytes in a tile payload before its uint32 block-length table. */
export const TILE_HEADER_OFFSET = 16;

/** The `format` string a manifest must carry to be usable. */
export const CITY_FORMAT = 'TORT1';

/** Directory holding the streamed city, beside data/toronto.json. */
export const CITY_DIR = 'city';

/** Bytes per element of each block type the packer emits. */
export const ELEM_SIZE = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, f32: 4 };

/** Fixed-point scales used by the sidecar. Divide by these; never multiply by their reciprocal. */
export const SCALE_CM = 100;        // building h/y, road w, ring coordinates, poi x/z
export const SCALE_MM = 1000;       // terrain heights, and unit parameter t (thousandths)
export const SCALE_COLOR = 10000;   // surveyed facade colour channels

/** Extent used when meta carries none. Never a limit — only a fallback for a malformed file. */
export const DEFAULT_EXTENT = { x: 3141.7, z: 2226.4 };

/** Projection origin used when meta carries none: the centre of the original downtown slice. */
export const DEFAULT_ORIGIN = { lon: -79.3885, lat: 43.644 };

/** Widest storey count a surveyed `lv` may claim before it is treated as a typo. */
export const MAX_SURVEYED_LEVELS = 200;

/** True for a real, finite number. Local so this module depends on nothing. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* ------------------------------------------------------------------ top level -- */

/** A named feature array off the decoded file, or an empty array when it is absent. */
export function featureList(data, key) {
  const a = data ? data[key] : null;
  return Array.isArray(a) ? a : [];
}

/** The file's extent, falling back to DEFAULT_EXTENT for a file that carries none. */
export function readExtent(meta) {
  return (meta && meta.extent && num(meta.extent.x)) ? meta.extent : DEFAULT_EXTENT;
}

/**
 * Web Mercator with the build step's cos(lat0) scale divided out -> local metres
 * (X east, Z south). Returns project(lon, lat) -> [x, z].
 */
export function makeProjector(origin) {
  const R = 6378137.0;
  const d2r = Math.PI / 180;
  const lat0 = origin && num(origin.lat) ? origin.lat : DEFAULT_ORIGIN.lat;
  const lon0 = origin && num(origin.lon) ? origin.lon : DEFAULT_ORIGIN.lon;
  const k = Math.cos(lat0 * d2r);
  const mx0 = R * lon0 * d2r;
  const my0 = R * Math.log(Math.tan(Math.PI / 4 + (lat0 * d2r) / 2));
  return (lon, lat) => {
    const mx = R * lon * d2r;
    const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * d2r) / 2));
    return [(mx - mx0) * k, -(my - my0) * k];
  };
}

/* ------------------------------------------------------------------ buildings -- */

/** Surveyed building name, or ''. */
export function readName(b) {
  return typeof b.n === 'string' ? b.n : '';
}

/** House number on the street frontage, or ''. */
export function readHouseNumber(b) {
  return typeof b.hn === 'string' ? b.hn : '';
}

/** Surveyed storey count, or 0 when absent or outside 1..MAX_SURVEYED_LEVELS. */
export function readLevels(b) {
  return (typeof b.lv === 'number' && b.lv >= 1 && b.lv <= MAX_SURVEYED_LEVELS) ? (b.lv | 0) : 0;
}

/** Surveyed roof shape key, or ''. */
export function readRoofShape(b) {
  return typeof b.rs === 'string' ? b.rs : '';
}

/** The premises on this building's frontage, in order along it, or null when none are surveyed. */
export function readUnits(b) {
  return Array.isArray(b.u) ? b.u : null;
}

/* ----------------------------------------------------------------------- pois -- */

/**
 * Is this standalone node usable? A poi needs a kind string and a finite position; anything else
 * is a partial record the extract should not have emitted, and every pass downstream is written
 * assuming this filter already ran.
 */
export function isUsablePoi(q) {
  return !!q && typeof q.k === 'string' && num(q.x) && num(q.z);
}

/** Every usable standalone node in the file, in file order. */
export function readPois(data) {
  const src = featureList(data, 'pois');
  const out = [];
  for (let i = 0; i < src.length; i++) if (isUsablePoi(src[i])) out.push(src[i]);
  return out;
}
