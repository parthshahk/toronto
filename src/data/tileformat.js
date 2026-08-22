// src/data/tileformat.js — the binary of the STREAMED city: one payload per tile, one global block.
//
// tools/pack_city.py writes data/city/ as a manifest, a global block and a set of group files
// each holding a few tiles' payloads. This file turns those bytes back into exactly the records
// data/toronto.json holds — same fields, same units, same doubles. It knows nothing about
// residency, fetching or eviction; src/data/stream.js owns all of that.
//
// A TILE PAYLOAD is deliberately header-light. The monolithic sidecar can afford a JSON header
// naming every block, because there is one of it; a thousand tiles each carrying a JSON block
// table would spend more on headers than on geometry. So the block ORDER and TYPES live once, in
// the manifest, and a payload carries only one element count per block:
//
//   bytes  0..3    magic 'TORT'
//   bytes  4..5    uint16 version
//   bytes  6..7    uint16 block count (must equal the manifest's)
//   bytes  8..11   uint32 string count
//   bytes 12..15   uint32 string bytes, padded so the blocks start 4-byte aligned
//   then           uint32 lengths[blockCount], in manifest block order
//   then           the string dictionary: NUL-separated UTF-8, then padding
//   then           the blocks, in order, each 4-byte aligned
//
// Free-form strings — street names, house numbers, shop names — are per tile, because they are
// local: one dictionary for the whole city would be megabytes that have to arrive before the
// first frame. Enum vocabularies (road class, roof shape, shop category) are in the manifest,
// because they are tiny and a u8 id has to mean the same thing in every payload.
//
// FIXED POINT, AND WHY THE DECODER DIVIDES. Same rule as the monolithic sidecar: every scaled
// integer is DIVIDED by its scale, never multiplied by a reciprocal, so the double a field
// decodes to is the double the JSON literal parsed to. See data/schema.js.

import {
  SCALE_CM, SCALE_MM, SCALE_COLOR, TILE_MAGIC, GLOBAL_MAGIC, TILE_HEADER_OFFSET,
  SIDECAR_HEADER_OFFSET, ELEM_SIZE,
} from './schema.js';

const EMPTY_I32 = new Int32Array(0);
const EMPTY_I16 = new Int16Array(0);

/** A typed-array view of one block, or null. `off` is a byte offset into `buf`. */
function view(buf, type, off, len) {
  switch (type) {
    case 'i8': return new Int8Array(buf, off, len);
    case 'u8': return new Uint8Array(buf, off, len);
    case 'i16': return new Int16Array(buf, off, len);
    case 'u16': return new Uint16Array(buf, off, len);
    case 'i32': return new Int32Array(buf, off, len);
    case 'f32': return new Float32Array(buf, off, len);
    default: return null;
  }
}

/**
 * Ring reader: an absolute int32 origin in centimetres, then int16 deltas with an escape.
 *
 * DIVIDE, never multiply by 0.01. An integer count of centimetres divided by 100 is the
 * correctly-rounded double for that decimal, which is exactly what parsing "-387.21" gives;
 * multiplying by the inexact literal 0.01 lands one ulp away on about 7% of the city's vertices.
 *
 * @param {(name:string)=>(ArrayBufferView|null)} get block accessor
 * @param {string} prefix block-name prefix, e.g. 'buildings' or 'span.roads'
 */
export function readRings(get, prefix) {
  const len = get(prefix + '.ringLen') || EMPTY_I32;
  const org = get(prefix + '.origin') || EMPTY_I32;
  const del = get(prefix + '.delta') || EMPTY_I16;
  const esc = get(prefix + '.esc') || EMPTY_I32;
  const out = new Array(len.length);
  let oi = 0, di = 0, ei = 0;
  for (let r = 0; r < len.length; r++) {
    const n = len[r];
    const ring = new Array(n);
    if (n <= 0) { out[r] = ring; continue; }
    let x = org[oi++], z = org[oi++];
    ring[0] = [x / SCALE_CM, z / SCALE_CM];
    for (let k = 1; k < n; k++) {
      const dx = del[di++], dz = del[di++];
      if (dx === -32768 && dz === -32768) { x = esc[ei++]; z = esc[ei++]; }
      else { x += dx; z += dz; }
      ring[k] = [x / SCALE_CM, z / SCALE_CM];
    }
    out[r] = ring;
  }
  return out;
}

/** `table[id]` when the id is a real entry, undefined otherwise. 255 is "not set". */
function enumOf(table, ids, k) {
  const v = ids ? ids[k] : 255;
  return (v < 255 && table && v < table.length) ? table[v] : undefined;
}

/* ============================================================== the layout == */

/**
 * Everything about the format that is the same for every tile, worked out once.
 *
 * `blocks` is the manifest's own block table, so the decoder reads the layout out of the file it
 * is decoding rather than carrying a second copy that can drift from the packer's.
 */
export function makeLayout(manifest) {
  const raw = Array.isArray(manifest && manifest.blocks) ? manifest.blocks : [];
  const names = new Array(raw.length);
  const types = new Array(raw.length);
  const index = new Map();
  for (let i = 0; i < raw.length; i++) {
    names[i] = String(raw[i][0]);
    types[i] = String(raw[i][1]);
    index.set(names[i], i);
  }
  const en = (manifest && manifest.enums) || {};
  return {
    names, types, index, count: raw.length,
    enums: {
      buildingMat: en.buildingMat || [],
      roofShape: en.roofShape || [],
      unitCategory: en.unitCategory || [],
      unitValues: en.unitValues || [],
      roadClass: en.roadClass || [],
      areaKind: en.areaKind || [],
      railKind: en.railKind || [],
      wfKind: en.wfKind || [],
      poiKind: en.poiKind || [],
    },
  };
}

/* ============================================================ record builders */

function buildBuildings(get, str, enums) {
  const idx = get('buildings.idx') || EMPTY_I32;
  const rings = readRings(get, 'buildings');
  const perB = get('buildings.ringsPer') || EMPTY_I32;
  const bh = get('buildings.h'), by = get('buildings.y'), bt = get('buildings.t');
  const bmat = get('buildings.mat'), bcolHas = get('buildings.colHas');
  const bcol = get('buildings.col'), bname = get('buildings.name');
  const bhn = get('buildings.hnum'), blv = get('buildings.levels');
  const broof = get('buildings.roof'), bUnitsPer = get('buildings.unitsPer');
  const uCat = get('units.cat'), uVal = get('units.val'), uSeg = get('units.seg');
  const uT = get('units.t'), uName = get('units.name'), uBrand = get('units.brand');
  const uHouse = get('units.house'), uHours = get('units.hours');
  const uvals = enums.unitValues;

  const out = new Array(idx.length);
  let ring = 0;
  let unit = 0;
  for (let i = 0; i < idx.length; i++) {
    const cnt = perB[i];
    const rr = new Array(cnt);
    for (let k = 0; k < cnt; k++) rr[k] = rings[ring++];
    const rec = {
      h: bh ? bh[i] / SCALE_CM : 0, y: by ? by[i] / SCALE_CM : 0, r: rr, t: bt ? bt[i] : 0,
    };
    const m = enumOf(enums.buildingMat, bmat, i);
    if (m) rec.m = m;
    if (bcolHas && bcolHas[i]) {
      rec.c = [bcol[i * 3] / SCALE_COLOR, bcol[i * 3 + 1] / SCALE_COLOR,
        bcol[i * 3 + 2] / SCALE_COLOR];
    }
    const nm = str(bname, i);
    if (nm) rec.n = nm;
    const hn = str(bhn, i);
    if (hn) rec.hn = hn;
    if (blv && blv[i]) rec.lv = blv[i];
    const rs = enumOf(enums.roofShape, broof, i);
    if (rs) rec.rs = rs;
    const nu = bUnitsPer ? bUnitsPer[i] : 0;
    if (nu > 0) {
      const us = new Array(nu);
      for (let k = 0; k < nu; k++, unit++) {
        const vi = uVal ? uVal[unit] : -1;
        const u = {
          c: enumOf(enums.unitCategory, uCat, unit) || 'shop',
          v: (vi >= 0 && vi < uvals.length) ? uvals[vi] : '',
          s: uSeg ? uSeg[unit] : 0,
          // Thousandths: attach_pois.py writes t to three decimals, so an integer count of them
          // divided by 1000 is exactly the double parsing "0.253" gives.
          t: uT ? uT[unit] / SCALE_MM : 0,
        };
        const un = str(uName, unit);
        if (un) u.n = un;
        const ub = str(uBrand, unit);
        if (ub) u.b = ub;
        const uh = str(uHouse, unit);
        if (uh) u.h = uh;
        if (uHours && uHours[unit]) u.o = 1;
        us[k] = u;
      }
      rec.u = us;
    }
    out[i] = rec;
  }
  return { items: out, idx };
}

function buildRoads(get, str, enums, prefix) {
  const idx = get(prefix + '.idx') || EMPTY_I32;
  const rings = readRings(get, prefix);
  const rcls = get(prefix + '.cls'), rw = get(prefix + '.w'), rlay = get(prefix + '.lay');
  const rb = get(prefix + '.b'), rtun = get(prefix + '.tun'), rname = get(prefix + '.name');
  const out = new Array(rings.length);
  for (let i = 0; i < rings.length; i++) {
    out[i] = {
      c: enumOf(enums.roadClass, rcls, i) || 'minor',
      w: rw ? rw[i] / SCALE_CM : 8,
      n: str(rname, i),
      lay: rlay ? rlay[i] : 0,
      b: rb ? rb[i] : 0,
      tun: rtun ? rtun[i] : 0,
      p: rings[i],
    };
  }
  return { items: out, idx };
}

function buildKinded(get, prefix, key, table, str) {
  const idx = get(prefix + '.idx') || EMPTY_I32;
  const rings = readRings(get, prefix);
  const kinds = get(prefix + '.kind');
  const names = str ? get(prefix + '.name') : null;
  const out = new Array(rings.length);
  for (let i = 0; i < rings.length; i++) {
    const rec = { p: rings[i] };
    rec[key] = enumOf(table, kinds, i) || '';
    if (str) rec.n = str(names, i);
    out[i] = rec;
  }
  return { items: out, idx };
}

function buildPois(get, str, enums) {
  const idx = get('pois.idx') || EMPTY_I32;
  const pKind = get('pois.kind'), pX = get('pois.x'), pZ = get('pois.z');
  const pName = get('pois.name');
  const n = pX ? pX.length : 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    // Whole centimetres, which is the two decimals attach_pois.py rounds a node to, so x / 100
    // is exactly the double the JSON literal parses to.
    const rec = {
      k: enumOf(enums.poiKind, pKind, i) || '',
      x: pX[i] / SCALE_CM,
      z: pZ ? pZ[i] / SCALE_CM : 0,
    };
    const nm = str(pName, i);
    if (nm) rec.n = nm;
    out[i] = rec;
  }
  return { items: out, idx };
}

/* ================================================================ one tile == */

/**
 * Decode one tile payload.
 *
 * @param {ArrayBuffer} buf the buffer the payload lives in (usually a whole group file)
 * @param {number} base byte offset of the payload's magic; must be a multiple of 4
 * @param {object} layout makeLayout(manifest)
 * @returns {object} { buildings, buildingIdx, roads, roadIdx, areas, areaIdx, rails, railIdx,
 *                     pois, poiIdx, bytes } — records identical in shape to data/toronto.json,
 *                     each `*Idx` giving the record's index in the JSON array it came from.
 */
export function decodeTile(buf, base, layout) {
  const u8 = new Uint8Array(buf);
  if (base < 0 || base + TILE_HEADER_OFFSET > u8.length ||
    u8[base] !== TILE_MAGIC[0] || u8[base + 1] !== TILE_MAGIC[1] ||
    u8[base + 2] !== TILE_MAGIC[2] || u8[base + 3] !== TILE_MAGIC[3]) {
    throw new Error('city: bad tile magic at ' + base);
  }
  const dv = new DataView(buf);
  const nBlocks = dv.getUint16(base + 6, true);
  if (nBlocks !== layout.count) {
    throw new Error('city: tile has ' + nBlocks + ' blocks, manifest says ' + layout.count);
  }
  const nStrings = dv.getUint32(base + 8, true);
  const strBytes = dv.getUint32(base + 12, true);

  const lens = new Uint32Array(buf, base + TILE_HEADER_OFFSET, nBlocks);
  let cursor = base + TILE_HEADER_OFFSET + nBlocks * 4;
  let strings = null;
  if (nStrings > 0 && strBytes > 0) {
    const text = new TextDecoder('utf-8').decode(u8.subarray(cursor, cursor + strBytes));
    strings = text.split('\0');
    if (strings.length > nStrings) strings.length = nStrings;
  }
  cursor += strBytes;

  const blocks = new Map();
  for (let i = 0; i < nBlocks; i++) {
    const n = lens[i];
    if (!n) continue;
    cursor += (-cursor) & 3;
    const type = layout.types[i];
    blocks.set(layout.names[i], view(buf, type, cursor, n));
    cursor += n * ELEM_SIZE[type];
  }
  const get = (name) => blocks.get(name) || null;
  const str = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (strings && v >= 0 && v < strings.length) ? strings[v] : '';
  };

  const b = buildBuildings(get, str, layout.enums);
  const r = buildRoads(get, str, layout.enums, 'roads');
  const a = buildKinded(get, 'areas', 'k', layout.enums.areaKind, null);
  const l = buildKinded(get, 'rails', 'k', layout.enums.railKind, null);
  const q = buildPois(get, str, layout.enums);
  return {
    buildings: b.items, buildingIdx: b.idx,
    roads: r.items, roadIdx: r.idx,
    areas: a.items, areaIdx: a.idx,
    rails: l.items, railIdx: l.idx,
    pois: q.items, poiIdx: q.idx,
    bytes: cursor - base,
  };
}

/* ============================================================= global block = */

/**
 * Decode data/city/global.bin: the terrain height field, the lake shore, the waterfront
 * structures, and the hundred-odd features that are larger than a tile.
 *
 * Terrain arrives delta-coded in millimetres. Integer addition is exact and the result is still
 * DIVIDED by 1000, so every sample is the same double the JSON literal parsed to — the delta is
 * a transport trick, not a quantisation.
 */
export function decodeGlobal(buf, layout) {
  const u8 = new Uint8Array(buf);
  if (u8.length < SIDECAR_HEADER_OFFSET ||
    u8[0] !== GLOBAL_MAGIC[0] || u8[1] !== GLOBAL_MAGIC[1] ||
    u8[2] !== GLOBAL_MAGIC[2] || u8[3] !== GLOBAL_MAGIC[3]) {
    throw new Error('city: bad global magic');
  }
  const dv = new DataView(buf);
  const headLen = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder('utf-8')
    .decode(u8.subarray(SIDECAR_HEADER_OFFSET, SIDECAR_HEADER_OFFSET + headLen)));
  const base = SIDECAR_HEADER_OFFSET + headLen;
  const table = head.blocks || {};
  const get = (name) => {
    const b = table[name];
    return b ? view(buf, b.type, base + b.off, b.len) : null;
  };
  const names = head.names || [];
  const str = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (v >= 0 && v < names.length) ? names[v] : '';
  };

  const shape = head.terrain || { nx: 2, nz: 2, cell: 25, n: 0 };
  const d = get('terrain.d') || EMPTY_I16;
  const te = get('terrain.esc') || EMPTY_I32;
  const h = new Float64Array(d.length);
  let prev = 0, ei = 0;
  for (let i = 0; i < d.length; i++) {
    const step = d[i];
    if (step === -32768) prev = te[ei++];
    else prev += step;
    h[i] = prev / SCALE_MM;
  }
  const terrain = { nx: shape.nx, nz: shape.nz, cell: shape.cell, h };

  const shoreRole = head.shoreRole || [];
  const shore = buildKinded(get, 'shore', 'role', shoreRole, null);
  const waterfront = buildKinded(get, 'waterfront', 'k', layout.enums.wfKind, str);
  const spanRoads = buildRoads(get, str, layout.enums, 'span.roads');
  const spanAreas = buildKinded(get, 'span.areas', 'k', layout.enums.areaKind, null);
  const spanRails = buildKinded(get, 'span.rails', 'k', layout.enums.railKind, null);

  return {
    terrain,
    shore: shore.items,
    waterfront: waterfront.items,
    waterfrontIdx: waterfront.idx,
    spanning: {
      roads: spanRoads.items, roadIdx: spanRoads.idx,
      areas: spanAreas.items, areaIdx: spanAreas.idx,
      rails: spanRails.items, railIdx: spanRails.idx,
    },
  };
}

export default { readRings, makeLayout, decodeTile, decodeGlobal };
