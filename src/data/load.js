// src/data/load.js — get the city off the network and into the object graph the builders want.
//
// THREE paths to the same records, in the order they are tried:
//
//   data/city/         THE STREAMED CITY: a manifest and a global block at boot, then one group
//                      file at a time as tiles are built. Opt in with { stream: true }; the
//                      caller gets a CityStream back and drives it (see data/stream.js).
//   data/toronto.bin   the monolithic sidecar (tools/pack_city.py), decoded here.
//   data/toronto.json  parsed by the platform.
//
// The JSON stays AUTHORITATIVE — build_city.py, match_osm.py and attach_pois.py write it, and it
// is what a human reads — so this must work when neither binary has ever been generated. Anything
// at all wrong with either (missing, truncated, stale magic, a manifest describing a different
// grid) falls back with a warning rather than taking the page down.
//
// All three decodes agree to the last bit. Every scaled integer is DIVIDED by its scale, never
// multiplied by a reciprocal, so the double a packed field decodes to is the same double the JSON
// literal parses to. See data/schema.js for why that matters and for what every field means.
//
// Zero dependencies. Nothing here draws, allocates a mesh or knows what a building looks like.

import {
  SIDECAR_MAGIC, SIDECAR_HEADER_OFFSET, SCALE_CM, SCALE_MM, SCALE_COLOR, CITY_DIR,
} from './schema.js';
import { readRings } from './tileformat.js';
import { CityStream } from './stream.js';

/**
 * Decode data/toronto.bin (tools/pack_city.py) into exactly the object graph the JSON produced.
 *
 * The JSON extract is 11.8 MB of text — 3.3 MB gzipped — and JSON.parse has to build ~493,000
 * two-element arrays before anything else can start. The sidecar carries the same information as
 * typed arrays: 3.0 MB raw, 1.8 MB gzipped, and the coordinate walk below is a tight loop over
 * an Int16Array instead of a tokeniser.
 */
export function decodeCity(buf) {
  const u8 = new Uint8Array(buf);
  const bad = u8.length < SIDECAR_HEADER_OFFSET ||
    u8[0] !== SIDECAR_MAGIC[0] || u8[1] !== SIDECAR_MAGIC[1] ||
    u8[2] !== SIDECAR_MAGIC[2] || u8[3] !== SIDECAR_MAGIC[3];
  if (bad) throw new Error('city: bad sidecar magic');
  const dv = new DataView(buf);
  const headLen = dv.getUint32(SIDECAR_MAGIC.length, true);
  const head = JSON.parse(new TextDecoder('utf-8')
    .decode(u8.subarray(SIDECAR_HEADER_OFFSET, SIDECAR_HEADER_OFFSET + headLen)));
  const base = SIDECAR_HEADER_OFFSET + headLen;
  const table = head.blocks || {};
  const block = (name) => {
    const b = table[name];
    if (!b) return null;
    const off = base + b.off;
    switch (b.type) {
      case 'i8': return new Int8Array(buf, off, b.len);
      case 'u8': return new Uint8Array(buf, off, b.len);
      case 'i16': return new Int16Array(buf, off, b.len);
      case 'u16': return new Uint16Array(buf, off, b.len);
      case 'i32': return new Int32Array(buf, off, b.len);
      case 'f32': return new Float32Array(buf, off, b.len);
      default: return null;
    }
  };
  const EMPTY_I32 = new Int32Array(0);
  const dicts = head.dicts || {};
  const names = dicts.names || [];
  const str = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (v >= 0 && v < names.length) ? names[v] : '';
  };
  const enumOf = (table2, ids, k) => {
    const v = ids ? ids[k] : 255;
    return (v < 255 && table2 && v < table2.length) ? table2[v] : undefined;
  };

  // Ring reader: absolute int32 origin in centimetres, then int16 deltas with an escape. Shared
  // with the streamed format, which encodes rings identically — see data/tileformat.js for the
  // note on why the decoder DIVIDES by 100 rather than multiplying by 0.01.
  const rings = (prefix) => readRings(block, prefix);

  const th = block('terrain.h');
  const terrain = {
    nx: head.terrain.nx, nz: head.terrain.nz, cell: head.terrain.cell,
    h: new Float64Array(th ? th.length : 0),
  };
  // Integer millimetres divided by 1000 is exactly the double that parsing the JSON literal
  // gives, so the two loaders produce identical terrain to the last bit.
  for (let i = 0; th && i < th.length; i++) terrain.h[i] = th[i] / SCALE_MM;

  const bRings = rings('buildings');
  const perB = block('buildings.ringsPer') || EMPTY_I32;
  const bh = block('buildings.h'), by = block('buildings.y'), bt = block('buildings.t');
  const bmat = block('buildings.mat'), bcolHas = block('buildings.colHas');
  const bcol = block('buildings.col'), bname = block('buildings.name');

  // THE SURVEYED GROUND FLOOR. House number, storey count, roof shape, and the units on the
  // frontage. Written by tools/pack_city.py; every value here decodes to exactly the double or
  // the string the JSON path produces, so which of the two loaded the city cannot be told from
  // the geometry (see the exact-decode note in pack_city.py).
  const hnums = dicts.houseNumbers || [];
  const hstr = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (v >= 0 && v < hnums.length) ? hnums[v] : '';
  };
  const unames = dicts.unitNames || [];
  const ustr = (ids, k) => {
    const v = ids ? ids[k] : -1;
    return (v >= 0 && v < unames.length) ? unames[v] : '';
  };
  const uvals = dicts.unitValues || [];
  const bhn = block('buildings.hnum'), blv = block('buildings.levels');
  const broof = block('buildings.roof'), bUnitsPer = block('buildings.unitsPer');
  const uCat = block('units.cat'), uVal = block('units.val'), uSeg = block('units.seg');
  const uT = block('units.t'), uName = block('units.name'), uBrand = block('units.brand');
  const uHouse = block('units.house'), uHours = block('units.hours');

  const buildings = new Array(perB.length);
  let ring = 0;
  let unit = 0;
  for (let i = 0; i < perB.length; i++) {
    const cnt = perB[i];
    const rr = new Array(cnt);
    for (let k = 0; k < cnt; k++) rr[k] = bRings[ring++];
    const rec = { h: bh ? bh[i] / SCALE_CM : 0, y: by ? by[i] / SCALE_CM : 0, r: rr, t: bt ? bt[i] : 0 };
    const m = enumOf(dicts.buildingMat, bmat, i);
    if (m) rec.m = m;
    if (bcolHas && bcolHas[i]) {
      rec.c = [bcol[i * 3] / SCALE_COLOR, bcol[i * 3 + 1] / SCALE_COLOR,
        bcol[i * 3 + 2] / SCALE_COLOR];
    }
    const nm = str(bname, i);
    if (nm) rec.n = nm;
    const hn = hstr(bhn, i);
    if (hn) rec.hn = hn;
    if (blv && blv[i]) rec.lv = blv[i];
    const rs = enumOf(dicts.roofShape, broof, i);
    if (rs) rec.rs = rs;
    const nu = bUnitsPer ? bUnitsPer[i] : 0;
    if (nu > 0) {
      const us = new Array(nu);
      for (let k = 0; k < nu; k++, unit++) {
        const vi = uVal ? uVal[unit] : -1;
        const u = {
          c: enumOf(dicts.unitCategory, uCat, unit) || 'shop',
          v: (vi >= 0 && vi < uvals.length) ? uvals[vi] : '',
          s: uSeg ? uSeg[unit] : 0,
          // Thousandths: attach_pois.py writes t to three decimals, so an integer count of them
          // divided by 1000 is exactly the double parsing "0.253" gives.
          t: uT ? uT[unit] / SCALE_MM : 0,
        };
        const un = ustr(uName, unit);
        if (un) u.n = un;
        const ub = ustr(uBrand, unit);
        if (ub) u.b = ub;
        const uh = hstr(uHouse, unit);
        if (uh) u.h = uh;
        if (uHours && uHours[unit]) u.o = 1;
        us[k] = u;
      }
      rec.u = us;
    }
    buildings[i] = rec;
  }

  const rRings = rings('roads');
  const rcls = block('roads.cls'), rw = block('roads.w'), rlay = block('roads.lay');
  const rb = block('roads.b'), rtun = block('roads.tun'), rname = block('roads.name');
  const roads = new Array(rRings.length);
  for (let i = 0; i < rRings.length; i++) {
    roads[i] = {
      c: enumOf(dicts.roadClass, rcls, i) || 'minor',
      w: rw ? rw[i] / SCALE_CM : 8,
      n: str(rname, i),
      lay: rlay ? rlay[i] : 0,
      b: rb ? rb[i] : 0,
      tun: rtun ? rtun[i] : 0,
      p: rRings[i],
    };
  }

  const simple = (cls, key, dict) => {
    const rs = rings(cls);
    const kinds = block(cls + '.kind');
    const out = new Array(rs.length);
    for (let i = 0; i < rs.length; i++) {
      const rec = { p: rs[i] };
      rec[key] = enumOf(dicts[dict], kinds, i) || '';
      out[i] = rec;
    }
    return out;
  };
  const areas = simple('areas', 'k', 'areaKind');
  const rails = simple('rails', 'k', 'railKind');
  const shore = simple('shore', 'role', 'shoreRole');
  const waterfront = simple('waterfront', 'k', 'wfKind');
  const wname = block('waterfront.name');
  for (let i = 0; i < waterfront.length; i++) waterfront[i].n = str(wname, i);

  // STANDALONE SURVEYED NODES. Whole centimetres, which is the two decimals attach_pois.py
  // rounds them to, so x / 100 is exactly the double the JSON literal parses to.
  const pKind = block('pois.kind'), pX = block('pois.x'), pZ = block('pois.z');
  const pName = block('pois.name');
  const pnames = dicts.poiNames || [];
  const nPoi = pX ? pX.length : 0;
  const pois = new Array(nPoi);
  for (let i = 0; i < nPoi; i++) {
    const rec = {
      k: enumOf(dicts.poiKind, pKind, i) || '',
      x: pX[i] / SCALE_CM,
      z: pZ ? pZ[i] / SCALE_CM : 0,
    };
    const v = pName ? pName[i] : -1;
    if (v >= 0 && v < pnames.length) rec.n = pnames[v];
    pois[i] = rec;
  }

  return {
    meta: head.meta || {}, terrain, buildings, roads, areas, rails, shore, waterfront, pois,
  };
}

async function fetchJson(url, onFrac) {
  if (typeof fetch !== 'function') throw new Error('city: fetch() unavailable');
  const res = await fetch(url);
  if (!res || !res.ok) {
    throw new Error('city: cannot load ' + url + (res ? ' (HTTP ' + res.status + ')' : ''));
  }
  const hdr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  const total = hdr ? Number(hdr) : 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const txt = await res.text();
    onFrac(1);
    return JSON.parse(txt);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (!r.value) continue;
    chunks.push(r.value);
    got += r.value.length;
    onFrac(total > 0 ? Math.min(1, got / total) : Math.min(0.95, got / 3.2e6));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) { buf.set(chunks[i], o); o += chunks[i].length; }
  onFrac(1);
  return JSON.parse(new TextDecoder('utf-8').decode(buf));
}

async function fetchBinary(url, onFrac) {
  const res = await fetch(url);
  if (!res || !res.ok) throw new Error('city: no sidecar at ' + url);
  const hdr = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-length') : null;
  const total = hdr ? Number(hdr) : 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    onFrac(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (!r.value) continue;
    chunks.push(r.value);
    got += r.value.length;
    onFrac(total > 0 ? Math.min(1, got / total) : Math.min(0.95, got / 3.2e6));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
  onFrac(1);
  return out.buffer;
}

/**
 * Open the streamed city: the manifest and the global block, and nothing else.
 *
 * What comes back is the part of the city that is NOT local to a tile — the terrain height
 * field, the lake shore, the waterfront structures, and the hundred-odd features larger than one
 * tile — together with the live `stream` that everything else arrives through. At the Old
 * Toronto extent that is tens of KB instead of ~19 MB before the first frame.
 *
 * THE CALLER MUST CHECK THE GRID. The manifest's tile ids only mean anything against the grid
 * they were packed for, so once the extent is known and makeTileGrid() has run, call
 * `stream.matchesGrid(grid)` and fall back to fetchCity() if it says no.
 *
 * Throws if the manifest is missing or unusable; that is the signal to fall back.
 */
export async function openCity(url, onFrac, opts) {
  const stream = await CityStream.open(url, onFrac, Object.assign({ dir: CITY_DIR }, opts || {}));
  const g = stream.global;
  return {
    stream,
    source: 'tiles',
    bytes: stream.bootBytes,
    data: {
      // A marker, not decoration: a consumer written against the monolithic graph would find
      // `buildings` missing and quietly build an empty city, so anything that can be handed this
      // object has to be able to tell that the rest of it arrives later.
      streamed: true,
      meta: stream.manifest.meta || {},
      terrain: g.terrain,
      shore: g.shore,
      waterfront: g.waterfront,
      spanning: g.spanning,
    },
  };
}

/**
 * The packed sidecar if it is there, the JSON if it is not — and the streamed city first, when
 * the caller asks for it with `{ stream: true }` and is prepared to drive one.
 *
 * The JSON stays authoritative — tools/build_city.py and tools/match_osm.py write it, and it is
 * what a human reads — so the loader must work without either binary ever having been generated.
 * Anything at all wrong with them (missing, truncated, stale magic, an unreadable manifest) falls
 * back with a warning rather than taking the page down.
 */
export async function fetchCity(url, onFrac, opts) {
  if (typeof fetch !== 'function') throw new Error('city: fetch() unavailable');
  const o = opts || {};
  if (o.stream) {
    try {
      return await openCity(url, onFrac, o);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[city] streamed city unavailable (' +
          ((e && e.message) ? e.message : e) + '); falling back to the whole-file sidecar');
      }
    }
  }
  const packed = String(url).replace(/\.json$/i, '.bin');
  if (packed !== url) {
    try {
      const buf = await fetchBinary(packed, onFrac);
      const data = decodeCity(buf);
      return { data, source: 'bin', bytes: buf.byteLength };
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[city] packed sidecar unavailable (' +
          ((e && e.message) ? e.message : e) + '); falling back to JSON');
      }
    }
  }
  const data = await fetchJson(url, onFrac);
  return { data, source: 'json', bytes: 0 };
}
