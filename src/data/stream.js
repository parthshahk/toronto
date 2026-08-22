// src/data/stream.js — what city data is resident, what is on the wire, and what gets thrown away.
//
// data/tileformat.js turns bytes into records. THIS file decides which bytes to ask for, when,
// and how long to keep them. It is the data half of what src/tiles.js already does for geometry,
// and it deliberately borrows that file's policy rather than inventing a second one:
//
//   * work is done against a MILLISECOND BUDGET, pumped once per frame, so a group arriving
//     costs several partial frames instead of one long hitch;
//   * requests are ordered by distance, nearest first, and a small read-ahead reaches past the
//     range the builder is actually asking about so that walking towards a block does not stall;
//   * residency is released by LEAST RECENTLY WANTED, with the same grace period the geometry
//     eviction uses, plus a byte cap for the case where everything in range is too much.
//
// WHAT A TILE NEEDS. tools/pack_city.py gives every feature to exactly one tile and records the
// box containing everything that tile owns. A feature anchored just inside one cell can reach
// across the boundary, and a few features — the arterials, the rail corridors — are larger than
// a tile and live in the global block instead. So the rule for "can tile T be built" is:
//
//     every tile whose recorded box reaches into T's own cell must be decoded.
//
// That is a superset of every tile owning a feature with geometry inside T, which is what makes
// it safe; and because the boxes are tight (nothing bigger than a tile is in them at all) the
// set is T plus, at most, the ring of tiles around it. The scan radius is DERIVED from the boxes
// in the manifest, not assumed.
//
// Zero dependencies. Nothing here parses a byte or knows what a building looks like.

import { CITY_FORMAT, ELEM_SIZE } from './schema.js';
import { makeLayout, decodeTile, decodeGlobal } from './tileformat.js';

/* ---------------------------------------------------------------- residency states -- */

const ST_NONE = 0;      // nothing here; wanting it queues a group fetch
const ST_FETCH = 1;     // its group file is on the wire
const ST_RAW = 2;       // the group's bytes are resident; the payload has not been decoded yet
const ST_READY = 3;     // decoded, and features() can hand it over

// A tile the packer left out because it owns nothing at all. Frozen and shared: there are a lot
// of these over the lake and out in the margin, and every one of them is the same answer.
const EMPTY_TILE = Object.freeze({
  buildings: [], buildingIdx: new Int32Array(0),
  roads: [], roadIdx: new Int32Array(0),
  areas: [], areaIdx: new Int32Array(0),
  rails: [], railIdx: new Int32Array(0),
  pois: [], poiIdx: new Int32Array(0),
  bytes: 0,
});

// How many times a group file may fail to arrive before its tiles are written off as empty. One
// retry covers the dropped connection and the cold CDN edge; retrying a genuine 404 forever would
// be a request every frame for the rest of the session, so the second failure is final.
const FETCH_RETRIES = 1;

const EMPTY_MEMBERS = new Int32Array(0);

// How much heap one packed byte turns into once it is records. MEASURED over the whole downtown
// extract: 4.05 MB of payload decodes to 44.7 MB of live objects, because a ring vertex is a
// two-element JS array — an object header, a length and two boxed doubles for sixteen bytes of
// coordinate. It is the shape data/toronto.json produces and every builder downstream expects,
// so it is not a defect to fix here; it is the reason the byte cap is where it is, and the
// reason payloads are evicted at all rather than accumulating for the session.
export const DECODED_PER_PACKED = 11;

const clock = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

/** Fetch a URL as an ArrayBuffer. Replaceable so a test harness can read from disk instead. */
async function fetchBytes(url) {
  if (typeof fetch !== 'function') throw new Error('city: fetch() unavailable');
  const res = await fetch(url);
  if (!res || !res.ok) {
    throw new Error('city: cannot load ' + url + (res ? ' (HTTP ' + res.status + ')' : ''));
  }
  return res.arrayBuffer();
}

/** The directory holding the streamed city, derived from the path of data/toronto.json. */
export function cityDir(url, dir) {
  const s = String(url == null ? '' : url);
  const cut = s.lastIndexOf('/');
  return (cut >= 0 ? s.slice(0, cut + 1) : '') + dir + '/';
}

/* ============================================================================ stream == */

export class CityStream {
  /**
   * @param {object} manifest data/city/manifest.json, already parsed
   * @param {object} global decodeGlobal() result
   * @param {string} base directory the group files live in, with a trailing slash
   * @param {object} [opts] { fetchBytes, maxInFlight, byteCap, evictMs }
   *
   * The READ-AHEAD is not a knob here: how far past the build range to fetch is a question about
   * camera distances, and src/tiles.js is what has those. It calls want() for everything inside
   * its own range plus its own `dataAhead`; this file only ever answers "yes, that one too".
   */
  constructor(manifest, global, base, opts) {
    const o = opts || {};
    this.manifest = manifest;
    this.global = global;
    this.base = base;
    this.layout = makeLayout(manifest);
    this._fetch = typeof o.fetchBytes === 'function' ? o.fetchBytes : fetchBytes;
    this.maxInFlight = Number.isFinite(o.maxInFlight) ? Math.max(1, o.maxInFlight | 0) : 6;
    // Ceiling on resident payload, counted in PACKED bytes because that is the number the
    // manifest knows. Decoded records are far larger — measured at DECODED_PER_PACKED — so read
    // this as "20 MB packed, about 220 MB of live objects".
    //
    // Set ABOVE the measured want set on purpose, exactly as VERTEX_CAP is: at the Old Toronto
    // extent, stage 0's 5 km build range plus the read-ahead is 299 tiles, about 13 MB packed.
    // A cap that the ordinary want set sits on top of is not a safety valve, it is a treadmill.
    this.byteCap = Number.isFinite(o.byteCap) ? o.byteCap : 20 * 1024 * 1024;
    this.evictMs = Number.isFinite(o.evictMs) ? o.evictMs : 12000;

    const g = manifest.grid || {};
    this.grid = {
      size: +g.size, x0: +g.x0, z0: +g.z0, nx: g.nx | 0, nz: g.nz | 0,
      count: (g.nx | 0) * (g.nz | 0),
    };
    const t = manifest.tiles || {};
    this.file = t.file || [];
    this.off = t.off || [];
    this.len = t.len || [];
    this.box = t.box || [];
    this.boxY = t.boxY || [];

    const n = this.grid.count;
    this._st = new Uint8Array(n);
    this._data = new Array(n).fill(null);
    this._want = new Float64Array(n);
    this._prio = new Float64Array(n).fill(Infinity);
    this._deps = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (!(this.len[i] > 0)) { this._st[i] = ST_READY; this._data[i] = EMPTY_TILE; }
    }

    // Which tiles ride in which group file, worked out ONCE. Every residency decision below —
    // starting a fetch, releasing a buffer, sweeping a stale group — needs this list, and
    // rescanning all n tiles for it every frame is the one O(tiles x groups) trap in the file.
    this._members = new Map();
    for (let i = 0; i < n; i++) {
      if (!(this.len[i] > 0)) continue;
      const g = this.file[i];
      if (!(g >= 0)) continue;
      let a = this._members.get(g);
      if (!a) { a = []; this._members.set(g, a); }
      a.push(i);
    }
    for (const [g, a] of this._members) this._members.set(g, new Int32Array(a));

    this._groups = new Map();       // group index -> { buf, pending } (pending = members ST_RAW)
    this._need = new Map();         // group index -> best (lowest) priority seen
    this._raw = [];                 // tile ids whose bytes are here but undecoded
    this._fails = new Map();        // group index -> failed fetches so far
    this._inFlight = 0;

    // How far past its own cell any tile's box reaches, and therefore how many rings of
    // neighbours a dependency scan has to look at. DERIVED, so a packer that one day keeps a
    // longer feature in a tile widens the scan instead of silently dropping geometry.
    let reach = 0;
    const s = this.grid.size;
    for (let i = 0; i < n; i++) {
      const cx0 = this.grid.x0 + (i % this.grid.nx) * s;
      const cz0 = this.grid.z0 + ((i / this.grid.nx) | 0) * s;
      const b = i * 4;
      const r = Math.max(cx0 - this.box[b] / 100, cz0 - this.box[b + 1] / 100,
        this.box[b + 2] / 100 - (cx0 + s), this.box[b + 3] / 100 - (cz0 + s));
      if (r > reach) reach = r;
    }
    this.reach = reach > 0 ? reach : 0;
    this.ring = Math.max(0, Math.ceil(this.reach / s));

    this.stats = {
      requests: 0, bytesFetched: 0, groupsResident: 0, tilesReady: 0, decoded: 0,
      decodeMs: 0, evicted: 0, residentBytes: 0, peakResidentBytes: 0, stalls: 0,
    };
  }

  /**
   * Fetch the manifest and the global block. Throws if either is missing or unusable, which is
   * how the caller knows to fall back to the monolithic sidecar.
   */
  static async open(url, onFrac, opts) {
    const o = opts || {};
    const dir = cityDir(url, o.dir || 'city');
    const get = typeof o.fetchBytes === 'function' ? o.fetchBytes : fetchBytes;
    const report = typeof onFrac === 'function' ? onFrac : () => {};
    const mBuf = await get(dir + 'manifest.json');
    const manifest = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(mBuf)));
    if (!manifest || manifest.format !== CITY_FORMAT) {
      throw new Error('city: manifest is not ' + CITY_FORMAT);
    }
    if (!manifest.grid || !Array.isArray(manifest.blocks) || !manifest.tiles) {
      throw new Error('city: manifest is missing the grid, the block table or the tile table');
    }
    for (let i = 0; i < manifest.blocks.length; i++) {
      const type = manifest.blocks[i][1];
      if (!ELEM_SIZE[type]) throw new Error('city: manifest block type ' + type + ' is unknown');
    }
    report(0.25);
    const layout = makeLayout(manifest);
    const gname = (manifest.global && manifest.global.file) || 'global.bin';
    const gBuf = await get(dir + gname);
    const global = decodeGlobal(gBuf, layout);
    report(1);
    const stream = new CityStream(manifest, global, dir, opts);
    stream.stats.requests = 2;
    stream.stats.bytesFetched = mBuf.byteLength + gBuf.byteLength;
    stream.bootBytes = stream.stats.bytesFetched;
    return stream;
  }

  /* ------------------------------------------------------------------ the grid -- */

  /**
   * Does the manifest describe the grid the app actually built? A mismatch means the data was
   * packed against a different TILE_SIZE, extent or margin, and every tile id would be wrong —
   * so the caller falls back rather than rendering a city that is subtly in the wrong place.
   */
  matchesGrid(grid) {
    if (!grid) return false;
    const g = this.grid;
    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
    return g.nx === (grid.nx | 0) && g.nz === (grid.nz | 0) &&
      near(g.size, grid.size) && near(g.x0, grid.x0) && near(g.z0, grid.z0);
  }

  /**
   * The box containing everything tile `id` owns, in metres — [x0, z0, x1, z1, y0, y1] — or null
   * when the tile owns nothing at all.
   *
   * This is what lets a streamed grid be USEFUL before a single payload has arrived: the culler
   * and the level-of-detail distance both work off a tile's draw box, and until the features are
   * in hand the manifest is the only thing that knows where they reach. src/tiles.js primes every
   * tile from this the moment the stream is attached.
   */
  bounds(id) {
    if (!(id >= 0) || id >= this.grid.count || !(this.len[id] > 0)) return null;
    const b = id * 4;
    const y = id * 2;
    const hasY = this.boxY.length >= y + 2 && this.boxY[y] <= this.boxY[y + 1];
    return [
      this.box[b] / 100, this.box[b + 1] / 100, this.box[b + 2] / 100, this.box[b + 3] / 100,
      hasY ? this.boxY[y] / 100 : NaN, hasY ? this.boxY[y + 1] / 100 : NaN,
    ];
  }

  /**
   * Every tile that must be decoded before tile `id` can be built: itself, plus any neighbour
   * whose box reaches into its cell. Computed once per tile and kept.
   */
  deps(id) {
    let got = this._deps[id];
    if (got) return got;
    const { nx, nz, size, x0, z0 } = this.grid;
    const i = id % nx, j = (id / nx) | 0;
    const cx0 = x0 + i * size, cz0 = z0 + j * size;
    const cx1 = cx0 + size, cz1 = cz0 + size;
    const out = [];
    const r = this.ring;
    for (let dj = -r; dj <= r; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) continue;
      for (let di = -r; di <= r; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const u = jj * nx + ii;
        if (!(this.len[u] > 0)) continue;
        const b = u * 4;
        if (this.box[b] / 100 <= cx1 && this.box[b + 2] / 100 >= cx0 &&
          this.box[b + 1] / 100 <= cz1 && this.box[b + 3] / 100 >= cz0) out.push(u);
      }
    }
    got = new Int32Array(out);
    this._deps[id] = got;
    return got;
  }

  /* ---------------------------------------------------------------- wanting it -- */

  /** True when every payload tile `id` needs is decoded and features() will not block. */
  ready(id) {
    const d = this.deps(id);
    for (let k = 0; k < d.length; k++) if (this._st[d[k]] !== ST_READY) return false;
    return true;
  }

  /**
   * Say that tile `id` is wanted, at `dist` metres from the camera. Stamps the tile and every
   * payload it depends on, and queues whatever is missing. Cheap enough to call for every tile
   * in range, every frame; the work happens in pump().
   */
  want(id, nowMs, dist) {
    const d = this.deps(id);
    const prio = Number.isFinite(dist) ? dist : 0;
    for (let k = 0; k < d.length; k++) {
      const u = d[k];
      this._want[u] = nowMs;
      if (prio < this._prio[u]) this._prio[u] = prio;
      if (this._st[u] !== ST_NONE) continue;
      const g = this.file[u];
      if (g < 0) continue;
      // The group's bytes may still be resident from a sibling that has not been decoded yet, in
      // which case this is a decode away rather than a round trip away.
      if (this._groups.has(g)) { this._setRaw(u); continue; }
      if ((this._fails.get(g) || 0) > FETCH_RETRIES) continue;
      const had = this._need.get(g);
      if (had === undefined || prio < had) this._need.set(g, prio);
    }
  }

  /** The group's bytes are here; queue this tile for decoding and hold the buffer until it is. */
  _setRaw(id) {
    const g = this._groups.get(this.file[id]);
    if (!g) return;
    this._st[id] = ST_RAW;
    g.pending++;
    this._raw.push(id);
  }

  /**
   * Spend up to `budgetMs` getting wanted payloads ready: start the nearest missing group files,
   * then decode whatever has already arrived, nearest first.
   *
   * @returns {number} milliseconds actually spent decoding.
   */
  pump(budgetMs) {
    this._issue();
    const budget = Number.isFinite(budgetMs) ? budgetMs : 2;
    if (budget <= 0 || !this._raw.length) return 0;
    const t0 = clock();
    // Nearest first: the tile the camera is standing on is worth more than one at the horizon.
    this._raw.sort((a, b) => this._prio[a] - this._prio[b]);
    let spent = 0;
    while (this._raw.length && spent < budget) {
      const id = this._raw.shift();
      if (this._st[id] !== ST_RAW) continue;
      this._decode(id);
      spent = clock() - t0;
    }
    this.stats.decodeMs += spent;
    return spent;
  }

  _issue() {
    if (!this._need.size || this._inFlight >= this.maxInFlight) return;
    const order = [];
    for (const [g, prio] of this._need) order.push([g, prio]);
    order.sort((a, b) => a[1] - b[1]);
    for (let k = 0; k < order.length && this._inFlight < this.maxInFlight; k++) {
      const g = order[k][0];
      this._need.delete(g);
      this._start(g);
    }
  }

  _start(g) {
    const name = (this.manifest.files || [])[g];
    const all = this._members.get(g);
    if (!name || !all) return;
    const members = [];
    for (let k = 0; k < all.length; k++) {
      if (this._st[all[k]] === ST_NONE) { this._st[all[k]] = ST_FETCH; members.push(all[k]); }
    }
    if (!members.length) return;
    this._inFlight++;
    this.stats.requests++;
    this._fetch(this.base + name).then((buf) => {
      this._inFlight--;
      this.stats.bytesFetched += buf.byteLength;
      this._groups.set(g, { buf, pending: 0 });
      this.stats.groupsResident = this._groups.size;
      this.stats.residentBytes += buf.byteLength;
      for (let k = 0; k < members.length; k++) {
        const id = members[k];
        // A tile freed while its group was still on the wire is back at ST_NONE and stays there;
        // it costs a decode, not a round trip, if anything wants it again.
        if (this._st[id] === ST_FETCH) { this._st[id] = ST_NONE; this._setRaw(id); }
      }
      if (this._groups.get(g).pending <= 0) this._drop(g);
    }).catch((err) => {
      this._inFlight--;
      const fails = (this._fails.get(g) || 0) + 1;
      this._fails.set(g, fails);
      // A group that will not load must not be retried every frame forever, and it must not take
      // the page down either. One retry, then its tiles are written off as empty and the rest of
      // the city carries on.
      const dead = fails > FETCH_RETRIES;
      for (let k = 0; k < members.length; k++) {
        if (this._st[members[k]] !== ST_FETCH) continue;
        if (dead) { this._st[members[k]] = ST_READY; this._data[members[k]] = EMPTY_TILE; }
        else this._st[members[k]] = ST_NONE;
      }
      this.stats.stalls++;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[city] tile group ' + name + ' failed (' +
          ((err && err.message) ? err.message : err) + '); ' +
          (dead ? 'those tiles stay empty' : 'it will be tried once more'));
      }
    });
  }

  /** Let go of one group's raw bytes. Every member of it must already be decoded or forgotten. */
  _drop(g) {
    const rec = this._groups.get(g);
    if (!rec) return;
    this.stats.residentBytes -= rec.buf.byteLength;
    this._groups.delete(g);
    this.stats.groupsResident = this._groups.size;
  }

  _decode(id) {
    const g = this._groups.get(this.file[id]);
    if (!g) { this._st[id] = ST_NONE; return; }
    try {
      this._data[id] = decodeTile(g.buf, this.off[id], this.layout);
      this._st[id] = ST_READY;
      this.stats.decoded++;
      this.stats.residentBytes += this.len[id];
    } catch (err) {
      this._data[id] = EMPTY_TILE;
      this._st[id] = ST_READY;
      this.stats.stalls++;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[city] tile ' + id + ' would not decode (' +
          ((err && err.message) ? err.message : err) + '); it stays empty');
      }
    }
    g.pending--;
    // The group's bytes exist only to be decoded out of. Once every tile in it has been, the
    // raw buffer is dead weight — several hundred KB of it per group.
    if (g.pending <= 0) this._drop(this.file[id]);
    if (this.stats.residentBytes > this.stats.peakResidentBytes) {
      this.stats.peakResidentBytes = this.stats.residentBytes;
    }
  }

  /**
   * The records tile `id` owns, or null if they are not resident yet. Shapes are identical to
   * data/toronto.json; each `*Idx` gives the record's index in the array it came from, so a
   * caller that needs stable identity across tiles has it.
   */
  features(id) {
    return this._st[id] === ST_READY ? this._data[id] : null;
  }

  /** Roughly how much heap the resident records occupy, for a HUD that wants a real number. */
  get recordBytes() { return this.stats.residentBytes * DECODED_PER_PACKED; }

  /* ------------------------------------------------------------------ eviction -- */

  /**
   * Release payloads that have not been wanted for `evictMs`, then, if the resident total is
   * still over the byte cap, the least recently wanted until it is not.
   *
   * Deliberately the same two rules, in the same order, that TileManager._evict() uses on
   * geometry — and driven by the same clock and the same grace period, so a tile's data and its
   * meshes come and go together instead of one thrashing against the other.
   */
  sweep(nowMs, evictMs) {
    const grace = Number.isFinite(evictMs) ? evictMs : this.evictMs;
    const n = this.grid.count;
    let freed = 0;
    for (let i = 0; i < n; i++) {
      if (this._st[i] !== ST_READY || this._data[i] === EMPTY_TILE) continue;
      if (nowMs - this._want[i] <= grace) continue;
      freed += this._free(i);
    }
    if (this.stats.residentBytes > this.byteCap) {
      const live = [];
      for (let i = 0; i < n; i++) {
        if (this._st[i] === ST_READY && this._data[i] !== EMPTY_TILE) live.push(i);
      }
      live.sort((a, b) => this._want[a] - this._want[b]);
      for (let k = 0; k < live.length && this.stats.residentBytes > this.byteCap; k++) {
        freed += this._free(live[k]);
      }
    }
    // Group buffers whose remaining tiles nobody has asked about in a while go too, or a group
    // fetched for one tile at the edge of the read-ahead would hold its bytes forever.
    const stale = [];
    for (const [g, rec] of this._groups) {
      if (rec.pending > 0) {
        const all = this._members.get(g);
        let live = false;
        for (let k = 0; k < all.length && !live; k++) {
          if (this._st[all[k]] === ST_RAW && nowMs - this._want[all[k]] <= grace) live = true;
        }
        if (live) continue;
      }
      stale.push(g);
    }
    for (let k = 0; k < stale.length; k++) {
      const all = this._members.get(stale[k]) || EMPTY_MEMBERS;
      for (let i = 0; i < all.length; i++) {
        if (this._st[all[i]] === ST_RAW) this._st[all[i]] = ST_NONE;
      }
      this._drop(stale[k]);
    }
    let ready = 0;
    for (let i = 0; i < n; i++) if (this._st[i] === ST_READY) ready++;
    this.stats.tilesReady = ready;
    return freed;
  }

  /**
   * Give one decoded payload back.
   *
   * Deliberately all the way back to ST_NONE, even when the group's raw bytes happen to still be
   * resident for a sibling. Dropping only as far as "decode me again" looks like a saving and is
   * a treadmill: pump() decodes it on the very next frame because the bytes are right there, the
   * next sweep finds it just as stale and frees it again, and a tile nobody has looked at in
   * twelve seconds costs a decode every frame for as long as its neighbour stays in range.
   * want() picks the cheap path back up — if the buffer is still there it re-queues a decode
   * rather than a request.
   */
  _free(id) {
    const bytes = this.len[id] | 0;
    this._data[id] = null;
    this._prio[id] = Infinity;
    this._st[id] = ST_NONE;
    this.stats.residentBytes -= bytes;
    this.stats.evicted++;
    return bytes;
  }

  /**
   * Give every payload back and forget every group buffer.
   *
   * A full reset, so the record of which group files would not load goes too — the next attempt
   * gets a clean slate rather than inheriting a 404 from before whatever prompted the reset.
   */
  dispose() {
    const n = this.grid.count;
    for (let i = 0; i < n; i++) {
      if (this.len[i] > 0) { this._st[i] = ST_NONE; this._data[i] = null; }
      this._prio[i] = Infinity;
    }
    this._groups.clear();
    this._need.clear();
    this._fails.clear();
    this._raw.length = 0;
    this.stats.residentBytes = 0;
    this.stats.groupsResident = 0;
  }

  /* ------------------------------------------------------------------ assemble -- */

  /**
   * Every tile, fetched and merged back into the whole-city object graph the monolithic sidecar
   * produces — records in their original array order, because each one carries the index it had.
   *
   * This is not what the game uses; it is the proof that the partition is lossless, and the path
   * a caller can take when it genuinely needs the whole city at once.
   */
  async assemble(onFrac) {
    const report = typeof onFrac === 'function' ? onFrac : () => {};
    const c = this.manifest.counts || {};
    const out = {
      meta: this.manifest.meta || {},
      terrain: this.global.terrain,
      buildings: new Array(c.buildings | 0),
      roads: new Array(c.roads | 0),
      areas: new Array(c.areas | 0),
      rails: new Array(c.rails | 0),
      shore: this.global.shore,
      waterfront: this.global.waterfront,
      pois: new Array(c.pois | 0),
    };
    const span = this.global.spanning;
    const place = (dst, items, idx) => {
      for (let k = 0; k < items.length; k++) dst[idx[k]] = items[k];
    };
    place(out.roads, span.roads, span.roadIdx);
    place(out.areas, span.areas, span.areaIdx);
    place(out.rails, span.rails, span.railIdx);

    const files = this.manifest.files || [];
    for (let g = 0; g < files.length; g++) {
      const buf = await this._fetch(this.base + files[g]);
      this.stats.requests++;
      this.stats.bytesFetched += buf.byteLength;
      const all = this._members.get(g) || EMPTY_MEMBERS;
      for (let k = 0; k < all.length; k++) {
        const i = all[k];
        const t = decodeTile(buf, this.off[i], this.layout);
        place(out.buildings, t.buildings, t.buildingIdx);
        place(out.roads, t.roads, t.roadIdx);
        place(out.areas, t.areas, t.areaIdx);
        place(out.rails, t.rails, t.railIdx);
        place(out.pois, t.pois, t.poiIdx);
        this.stats.decoded++;
      }
      report((g + 1) / Math.max(1, files.length));
    }
    return out;
  }
}

export default { CityStream, cityDir };
