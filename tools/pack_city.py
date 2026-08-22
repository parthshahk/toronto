#!/usr/bin/env python3
"""tools/pack_city.py -- pack data/toronto.json for transport.

Two outputs, from one read of the authoring JSON:

  data/city/                 THE STREAMED CITY. One compact binary per tile of the renderer's own
                             tile grid, grouped into files, plus a small manifest and one global
                             block for the things that genuinely are not local.
  data/toronto.bin           the monolithic sidecar, unchanged. Still written by default so the
                             loader has something to fall back to that is not tens of MB of text.
                             --no-mono skips it.

WHY PER TILE. At the Old Toronto extent the monolithic sidecar is ~34 MB, ~19 MB gzipped, and
every byte of it has to arrive and be parsed before the first frame. The geometry is already
streamed a tile at a time; the DATA it is built from was not. Now it is: the browser fetches the
manifest (tens of KB), the global block, and then only the tiles it is standing near.

THE GRID IS NOT INVENTED HERE. It is read out of the JavaScript that owns it -- TILE_SIZE from
src/tilegrid.js, the fringe from src/world/surround.js and the margin pad from src/world/roads.js --
and the same six lines of arithmetic makeTileGrid() runs are repeated below on the same IEEE-754
doubles. The manifest carries the resulting grid, and src/data/stream.js refuses a manifest whose
grid does not match the one the app built, so a drift between the two is a loud fallback rather
than a city with holes in it.

OWNERSHIP.

  * A feature smaller than a tile belongs to exactly ONE tile -- the one holding its anchor,
    computed the same way src/city/tileindex.js computes it (the mean of a building's first ring,
    the middle vertex of a way, a node's own position). That tile's recorded box grows to contain
    the whole feature. Nothing is clipped and nothing is duplicated.
  * A feature LARGER than a tile has no tile that can honestly own it -- Lake Shore Boulevard is
    1.9 km of one record, and the geometry tiler cuts it into per-tile runs at build time. Those
    hundred-odd arterials, rail corridors and big parks go in the global block instead, with the
    lake shore, the waterfront structures and the terrain height field.

Either way a feature appears exactly once in the whole output, and it carries its index in the
original JSON array, so reassembling every tile plus the global block reproduces data/toronto.json
array for array, in order. --verify proves it.

EXACT DECODE. Every scaled integer is chosen so that dividing it by its scale reproduces the exact
double the JSON literal parsed to -- centimetres for coordinates, millimetres for terrain and the
unit parameter, ten-thousandths for colour. --verify reports the maximum error, which is 0.

Run it after any change to the JSON:

    python3 tools/pack_city.py
    python3 tools/pack_city.py --verify

zero dependencies, like everything else in tools/.
"""

import json
import math
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'data', 'toronto.json')
DST = os.path.join(ROOT, 'data', 'toronto.bin')
CITY_DIR = os.path.join(ROOT, 'data', 'city')

MAGIC = b'TOR2'
GLOBAL_MAGIC = b'TORG'
TILE_MAGIC = b'TORT'
TILE_VERSION = 1
ESC = -32768
I16_MIN = -32767
I16_MAX = 32767

# Tiles per group-file edge. A group is GROUP_EDGE x GROUP_EDGE tiles in one request.
#
# 1 is one file per tile: the fewest wasted bytes and the most requests. 4 is a 2.5 km block --
# few requests, and half a megabyte fetched to stand on one street corner. 2 is a 1.25 km block,
# comfortably inside the massing range, so the three siblings that arrive with a tile are very
# nearly always wanted within seconds of it: the request count drops fourfold and almost nothing
# fetched goes unused.
GROUP_EDGE = 2

ELEM_SIZE = {'i8': 1, 'u8': 1, 'i16': 2, 'u16': 2, 'i32': 4, 'f32': 4}
ELEM_CODE = {'i8': 'b', 'u8': 'B', 'i16': 'h', 'u16': 'H', 'i32': 'i', 'f32': 'f'}

# THE PER-TILE BLOCK TABLE, in payload order. Written verbatim into the manifest, so the decoder
# in src/data/load.js reads the layout out of the file rather than carrying a second copy of it.
# A tile payload stores one element count per entry, in this order, and then the blocks.
TILE_BLOCKS = [
    ('buildings.idx', 'i32'), ('buildings.ringsPer', 'i32'), ('buildings.ringLen', 'i32'),
    ('buildings.origin', 'i32'), ('buildings.delta', 'i16'), ('buildings.esc', 'i32'),
    ('buildings.h', 'i32'), ('buildings.y', 'i32'), ('buildings.t', 'u8'),
    ('buildings.mat', 'u8'), ('buildings.colHas', 'u8'), ('buildings.col', 'i32'),
    ('buildings.name', 'i32'), ('buildings.hnum', 'i32'), ('buildings.levels', 'u8'),
    ('buildings.roof', 'u8'), ('buildings.unitsPer', 'i32'),
    ('units.cat', 'u8'), ('units.val', 'i32'), ('units.seg', 'i32'), ('units.t', 'u16'),
    ('units.name', 'i32'), ('units.brand', 'i32'), ('units.house', 'i32'), ('units.hours', 'u8'),
    ('roads.idx', 'i32'), ('roads.ringLen', 'i32'), ('roads.origin', 'i32'),
    ('roads.delta', 'i16'), ('roads.esc', 'i32'), ('roads.cls', 'u8'), ('roads.w', 'i32'),
    ('roads.lay', 'i8'), ('roads.b', 'u8'), ('roads.tun', 'u8'), ('roads.name', 'i32'),
    ('areas.idx', 'i32'), ('areas.ringLen', 'i32'), ('areas.origin', 'i32'),
    ('areas.delta', 'i16'), ('areas.esc', 'i32'), ('areas.kind', 'u8'),
    ('rails.idx', 'i32'), ('rails.ringLen', 'i32'), ('rails.origin', 'i32'),
    ('rails.delta', 'i16'), ('rails.esc', 'i32'), ('rails.kind', 'u8'),
    ('pois.idx', 'i32'), ('pois.kind', 'u8'), ('pois.x', 'i32'), ('pois.z', 'i32'),
    ('pois.name', 'i32'),
]

# The classes a tile can own. `waterfront` and `shore` are not among them: buildHarbour() consumes
# both whole, for the whole extent, so there is no tile that could usefully hold a part of either.
TILED_LINE_CLASSES = ('roads', 'areas', 'rails')

# Enum tables that live in the manifest rather than in each tile, so a u8 id means the same thing
# in every payload. (json array, key on the record, manifest name).
ENUM_U8 = (
    ('buildings', 'm', 'buildingMat'),
    ('buildings', 'rs', 'roofShape'),
    ('roads', 'c', 'roadClass'),
    ('areas', 'k', 'areaKind'),
    ('rails', 'k', 'railKind'),
    ('waterfront', 'k', 'wfKind'),
    ('pois', 'k', 'poiKind'),
)


# ------------------------------------------------------------------ the grid --

def read_js(path, pattern, what):
    """Pull one numeric constant out of a JavaScript source file, or die saying which."""
    full = os.path.join(ROOT, path)
    try:
        with open(full, 'r', encoding='utf-8') as fh:
            text = fh.read()
    except OSError as err:
        raise SystemExit('pack_city: cannot read %s (%s)' % (path, err))
    match = re.search(pattern, text)
    if not match:
        raise SystemExit('pack_city: cannot find %s in %s -- the tile grid is defined there and '
                         'must not be guessed at here' % (what, path))
    return float(match.group(1))


def grid_constants():
    """TILE_SIZE, the surround fringe rule and the margin pad, from the modules that own them."""
    return {
        'size': read_js('src/tilegrid.js', r'export const TILE_SIZE\s*=\s*([0-9.]+)', 'TILE_SIZE'),
        'fringe_frac': read_js('src/world/surround.js',
                               r'const SUR_FRINGE_FRAC\s*=\s*([0-9.]+)', 'SUR_FRINGE_FRAC'),
        'fringe_min': read_js('src/world/surround.js',
                              r'const SUR_FRINGE_MIN\s*=\s*([0-9.]+)', 'SUR_FRINGE_MIN'),
        'fringe_max': read_js('src/world/surround.js',
                              r'const SUR_FRINGE_MAX\s*=\s*([0-9.]+)', 'SUR_FRINGE_MAX'),
        'margin_pad': read_js(
            'src/city.js',
            r'makeTileGrid\(extent,\s*TILE_SIZE,\s*SUR_FRINGE\s*\+\s*([0-9.]+)\)',
            'the makeTileGrid margin'),
    }


class Grid(object):
    """The same grid makeTileGrid() builds, on the same doubles. Owns nothing but arithmetic."""

    def __init__(self, extent, const):
        ex = float(extent.get('x', 3141.7))
        ez = float(extent.get('z', 2226.4))
        fringe = min(max(min(ex, ez) * const['fringe_frac'], const['fringe_min']),
                     const['fringe_max'])
        margin = fringe + const['margin_pad']
        self.size = max(50.0, const['size'])
        self.margin = margin
        self.x0 = -ex / 2 - margin
        self.z0 = -ez / 2 - margin
        self.nx = max(1, int(math.ceil((ex + margin * 2) / self.size)))
        self.nz = max(1, int(math.ceil((ez + margin * 2) / self.size)))
        self.count = self.nx * self.nz

    def ci(self, x):
        i = int(math.floor((x - self.x0) / self.size))
        return 0 if i < 0 else (self.nx - 1 if i >= self.nx else i)

    def cj(self, z):
        j = int(math.floor((z - self.z0) / self.size))
        return 0 if j < 0 else (self.nz - 1 if j >= self.nz else j)

    def id_at(self, x, z):
        fx = x if isinstance(x, (int, float)) and math.isfinite(x) else 0.0
        fz = z if isinstance(z, (int, float)) and math.isfinite(z) else 0.0
        return self.cj(fz) * self.nx + self.ci(fx)

    def cell(self, tid):
        i = tid % self.nx
        j = tid // self.nx
        return (self.x0 + i * self.size, self.z0 + j * self.size,
                self.x0 + (i + 1) * self.size, self.z0 + (j + 1) * self.size)


# ---------------------------------------------------------------- primitives --

class Blocks(object):
    """Accumulates typed-array payloads and the JSON table that describes them."""

    def __init__(self):
        self.table = {}
        self.parts = []
        self.offset = 0

    def add(self, name, fmt, values):
        blob = struct.pack('<%d%s' % (len(values), ELEM_CODE[fmt]), *values)
        pad = (-self.offset) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.offset += pad
        self.table[name] = {'type': fmt, 'off': self.offset, 'len': len(values)}
        self.parts.append(blob)
        self.offset += len(blob)

    def payload(self):
        return b''.join(self.parts)


def encode_rings(rings):
    """Ring lengths, absolute int32 cm origins and int16 cm deltas, with an escape channel.

    The first point of a ring is absolute; the rest are deltas from the previous point, with
    (-32768, -32768) meaning "the next absolute pair is in `esc`", for the handful of segments
    longer than 327 m.
    """
    ring_len = []
    origin = []
    delta = []
    esc = []
    for ring in rings:
        pts = [p for p in ring if len(p) >= 2]
        ring_len.append(len(pts))
        if not pts:
            continue
        px = int(round(pts[0][0] * 100.0))
        pz = int(round(pts[0][1] * 100.0))
        origin.append(px)
        origin.append(pz)
        for p in pts[1:]:
            x = int(round(p[0] * 100.0))
            z = int(round(p[1] * 100.0))
            dx = x - px
            dz = z - pz
            if dx < I16_MIN or dx > I16_MAX or dz < I16_MIN or dz > I16_MAX:
                delta.append(ESC)
                delta.append(ESC)
                esc.append(x)
                esc.append(z)
            else:
                delta.append(dx)
                delta.append(dz)
            px = x
            pz = z
    return ring_len, origin, delta, esc


def dictionary(values):
    """Stable string dictionary: sorted, so the file is byte-reproducible."""
    table = sorted({v for v in values if isinstance(v, str) and v})
    index = {v: i for i, v in enumerate(table)}
    return table, index


def as_str(v):
    return v if isinstance(v, str) and v else None


def grow(box, points):
    for p in points:
        if len(p) < 2:
            continue
        x, z = p[0], p[1]
        if x < box[0]:
            box[0] = x
        if z < box[1]:
            box[1] = z
        if x > box[2]:
            box[2] = x
        if z > box[3]:
            box[3] = z


def span_of(points):
    """Width and depth of a point list, in metres. (0, 0) for an empty one."""
    box = [math.inf, math.inf, -math.inf, -math.inf]
    grow(box, points)
    if box[0] > box[2]:
        return 0.0, 0.0
    return box[2] - box[0], box[3] - box[1]


class Strings(object):
    """A string dictionary, interned in first-seen order. One per tile; one for the global block."""

    def __init__(self):
        self.table = []
        self.index = {}

    def id(self, v):
        s = as_str(v)
        if s is None:
            return -1
        got = self.index.get(s)
        if got is None:
            got = len(self.table)
            self.table.append(s)
            self.index[s] = got
        return got

    def blob(self):
        return b'\0'.join(s.encode('utf-8') for s in self.table)


# -------------------------------------------------------------- assignment ----

def building_anchor(b):
    """The mean of the FIRST ring -- exactly what city/buildings.js computes for cx, cz."""
    rings = b.get('r') or []
    r0 = rings[0] if rings else None
    if not isinstance(r0, list):
        return 0.0, 0.0
    cx = cz = 0.0
    n = 0
    for p in r0:
        if len(p) < 2 or not isinstance(p[0], (int, float)):
            continue
        cx += p[0]
        cz += p[1]
        n += 1
    return (cx / n, cz / n) if n else (0.0, 0.0)


def line_anchor(pts):
    """The middle vertex -- exactly what tileindex.js indexLine() and roads.js anchor a way by."""
    if not pts:
        return 0.0, 0.0
    p = pts[len(pts) >> 1]
    return (p[0], p[1]) if len(p) >= 2 else (0.0, 0.0)


class Bucket(object):
    """Everything one tile owns, plus the box that contains all of it."""

    __slots__ = ('buildings', 'roads', 'areas', 'rails', 'pois', 'box')

    def __init__(self):
        self.buildings = []
        self.roads = []
        self.areas = []
        self.rails = []
        self.pois = []
        self.box = [math.inf, math.inf, -math.inf, -math.inf]

    def empty(self):
        return not (self.buildings or self.roads or self.areas or self.rails or self.pois)


def assign(data, grid):
    """File every feature into the one tile that owns it, or into the global set if it spans more
    than a tile. Returns (buckets, spanning) where `spanning` is {class: [index, ...]}."""
    buckets = [Bucket() for _ in range(grid.count)]
    spanning = {cls: [] for cls in TILED_LINE_CLASSES}

    for i, b in enumerate(data.get('buildings', [])):
        cx, cz = building_anchor(b)
        t = buckets[grid.id_at(cx, cz)]
        t.buildings.append(i)
        for ring in (b.get('r') or []):
            if isinstance(ring, list):
                grow(t.box, ring)

    for cls in TILED_LINE_CLASSES:
        for i, it in enumerate(data.get(cls, [])):
            pts = it.get('p') or []
            w, d = span_of(pts)
            if w > grid.size or d > grid.size:
                spanning[cls].append(i)
                continue
            ax, az = line_anchor(pts)
            t = buckets[grid.id_at(ax, az)]
            getattr(t, cls).append(i)
            grow(t.box, pts)

    for i, q in enumerate(data.get('pois', [])):
        x = q.get('x', 0.0)
        z = q.get('z', 0.0)
        t = buckets[grid.id_at(x, z)]
        t.pois.append(i)
        grow(t.box, [[x, z]])

    # A tile that owns nothing still needs a legal box; its own cell is the honest answer and it
    # keeps the dependency arithmetic in stream.js free of infinities.
    for tid, t in enumerate(buckets):
        if t.box[0] > t.box[2]:
            t.box[0], t.box[1], t.box[2], t.box[3] = grid.cell(tid)
    return buckets, spanning


def vertical_bounds(data, grid, buckets):
    """The y range of every tile: its ground, plus the tops of the buildings it owns.

    The renderer culls and measures level-of-detail distance against a tile's box, and a streamed
    grid has to have that box before it has any features -- otherwise the first frame culls
    against a guess. x and z come out of the assignment above; this is the third axis.

    Ground comes from the terrain height field, sampled over the cell the tile covers, so a tile
    that owns nothing at all still gets an honest box rather than a slab at y = 0. Buildings then
    push the top up. Nothing else is included: props and street furniture are generated at build
    time and the renderer's own cover() grows the box for them when they appear.
    """
    terrain = data.get('terrain') or {}
    field = terrain.get('h') or []
    tnx = int(terrain.get('nx', 0))
    tnz = int(terrain.get('nz', 0))
    tcell = float(terrain.get('cell', 25.0)) or 25.0
    ext = (data.get('meta') or {}).get('extent') or {}
    hx = float(ext.get('x', 0.0)) / 2.0
    hz = float(ext.get('z', 0.0)) / 2.0
    have = tnx > 0 and tnz > 0 and len(field) >= tnx * tnz

    def clamp(v, lo, hi):
        return lo if v < lo else (hi if v > hi else v)

    out = []
    for tid in range(grid.count):
        cx0, cz0, cx1, cz1 = grid.cell(tid)
        lo = math.inf
        hi = -math.inf
        if have:
            i0 = clamp(int(math.floor((cx0 + hx) / tcell)), 0, tnx - 1)
            i1 = clamp(int(math.ceil((cx1 + hx) / tcell)), 0, tnx - 1)
            j0 = clamp(int(math.floor((cz0 + hz) / tcell)), 0, tnz - 1)
            j1 = clamp(int(math.ceil((cz1 + hz) / tcell)), 0, tnz - 1)
            for j in range(j0, j1 + 1):
                row = j * tnx
                for i in range(i0, i1 + 1):
                    v = field[row + i]
                    if v < lo:
                        lo = v
                    if v > hi:
                        hi = v
        for bi in buckets[tid].buildings:
            b = data['buildings'][bi]
            y = float(b.get('y', 0.0))
            top = y + float(b.get('h', 0.0))
            if y < lo:
                lo = y
            if top > hi:
                hi = top
        if lo > hi:
            lo = hi = 0.0
        out.append((lo, hi))
    return out


def dependency_stats(grid, buckets):
    """How many payloads a build of one tile needs resident. Measured, not asserted."""
    live = []
    for tid in range(grid.count):
        if buckets[tid].empty():
            continue
        cx0, cz0, cx1, cz1 = grid.cell(tid)
        n = 0
        for u in range(grid.count):
            if buckets[u].empty():
                continue
            b = buckets[u].box
            if b[0] <= cx1 and b[2] >= cx0 and b[1] <= cz1 and b[3] >= cz0:
                n += 1
        live.append(n)
    if not live:
        return {'avg': 0.0, 'max': 0, 'p95': 0}
    order = sorted(live)
    return {'avg': sum(live) / float(len(live)), 'max': order[-1],
            'p95': order[max(0, int(len(order) * 0.95) - 1)]}


# --------------------------------------------------------------- emitters -----
#
# One per feature class, shared by the tile payloads and the global spanning set. Each takes a
# list of indices into the JSON array and calls put(name, fmt, values) in block order.

def emit_buildings(data, idx, strings, enums, put):
    blds = [data['buildings'][i] for i in idx]
    rings = []
    rings_per = []
    units = []
    units_per = []
    for b in blds:
        rr = b.get('r') or []
        rings_per.append(len(rr))
        rings.extend(rr)
        uu = b.get('u') or []
        units_per.append(len(uu))
        units.extend(uu)
    rl, org, dlt, esc = encode_rings(rings)
    put('buildings.idx', 'i32', idx)
    put('buildings.ringsPer', 'i32', rings_per)
    put('buildings.ringLen', 'i32', rl)
    put('buildings.origin', 'i32', org)
    put('buildings.delta', 'i16', dlt)
    put('buildings.esc', 'i32', esc)
    put('buildings.h', 'i32', [int(round(float(b.get('h', 0.0)) * 100.0)) for b in blds])
    put('buildings.y', 'i32', [int(round(float(b.get('y', 0.0)) * 100.0)) for b in blds])
    put('buildings.t', 'u8', [int(b.get('t', 0)) & 255 for b in blds])
    put('buildings.mat', 'u8',
        [enums['buildingMat'].get(as_str(b.get('m')), 255) for b in blds])
    col = []
    has = []
    for b in blds:
        c = b.get('c')
        if isinstance(c, list) and len(c) >= 3:
            has.append(1)
            for k in range(3):
                col.append(max(0, min(10000, int(round(float(c[k]) * 10000.0)))))
        else:
            has.append(0)
            col.extend((0, 0, 0))
    put('buildings.colHas', 'u8', has)
    put('buildings.col', 'i32', col)
    put('buildings.name', 'i32', [strings.id(b.get('n')) for b in blds])
    put('buildings.hnum', 'i32', [strings.id(b.get('hn')) for b in blds])
    put('buildings.levels', 'u8', [max(0, min(255, int(b.get('lv', 0) or 0))) for b in blds])
    put('buildings.roof', 'u8', [enums['roofShape'].get(as_str(b.get('rs')), 255) for b in blds])
    put('buildings.unitsPer', 'i32', units_per)

    put('units.cat', 'u8', [enums['unitCategory'].get(as_str(u.get('c')), 255) for u in units])
    put('units.val', 'i32', [enums['unitValues'].get(as_str(u.get('v')), -1) for u in units])
    put('units.seg', 'i32', [int(u.get('s', 0)) for u in units])
    put('units.t', 'u16',
        [max(0, min(65535, int(round(float(u.get('t', 0.0)) * 1000.0)))) for u in units])
    put('units.name', 'i32', [strings.id(u.get('n')) for u in units])
    put('units.brand', 'i32', [strings.id(u.get('b')) for u in units])
    put('units.house', 'i32', [strings.id(u.get('h')) for u in units])
    put('units.hours', 'u8', [1 if u.get('o') else 0 for u in units])


def emit_roads(data, idx, strings, enums, put, prefix='roads'):
    roads = [data['roads'][i] for i in idx]
    rl, org, dlt, esc = encode_rings([r.get('p') or [] for r in roads])
    put(prefix + '.idx', 'i32', idx)
    put(prefix + '.ringLen', 'i32', rl)
    put(prefix + '.origin', 'i32', org)
    put(prefix + '.delta', 'i16', dlt)
    put(prefix + '.esc', 'i32', esc)
    put(prefix + '.cls', 'u8', [enums['roadClass'].get(as_str(r.get('c')), 255) for r in roads])
    put(prefix + '.w', 'i32', [int(round(float(r.get('w', 8.0)) * 100.0)) for r in roads])
    put(prefix + '.lay', 'i8', [max(-4, min(4, int(r.get('lay', 0)))) for r in roads])
    put(prefix + '.b', 'u8', [int(r.get('b', 0)) & 255 for r in roads])
    put(prefix + '.tun', 'u8', [int(r.get('tun', 0)) & 255 for r in roads])
    put(prefix + '.name', 'i32', [strings.id(r.get('n')) for r in roads])


def emit_rings_kind(data, cls, idx, enums, dic, key, put, prefix=None, strings=None):
    """areas, rails, shore, waterfront: rings plus one enum, and a name on the waterfront."""
    pre = prefix or cls
    items = [data[cls][i] for i in idx]
    rl, org, dlt, esc = encode_rings([it.get('p') or [] for it in items])
    put(pre + '.idx', 'i32', idx)
    put(pre + '.ringLen', 'i32', rl)
    put(pre + '.origin', 'i32', org)
    put(pre + '.delta', 'i16', dlt)
    put(pre + '.esc', 'i32', esc)
    put(pre + '.kind', 'u8', [enums[dic].get(as_str(it.get(key)), 255) for it in items])
    if strings is not None:
        put(pre + '.name', 'i32', [strings.id(it.get('n')) for it in items])


def emit_pois(data, idx, strings, enums, put):
    pois = [data['pois'][i] for i in idx]
    put('pois.idx', 'i32', idx)
    put('pois.kind', 'u8', [enums['poiKind'].get(as_str(q.get('k')), 255) for q in pois])
    put('pois.x', 'i32', [int(round(float(q.get('x', 0.0)) * 100.0)) for q in pois])
    put('pois.z', 'i32', [int(round(float(q.get('z', 0.0)) * 100.0)) for q in pois])
    put('pois.name', 'i32', [strings.id(q.get('n')) for q in pois])


# ------------------------------------------------------------ tile payloads ---

def pack_tile(data, bucket, enums):
    """One tile's payload: a fixed binary header, its own string dictionary, then the blocks."""
    strings = Strings()
    out = {}
    types = dict(TILE_BLOCKS)

    def put(name, fmt, values):
        if types.get(name) != fmt:
            raise SystemExit('pack_city: block %s emitted as %s, TILE_BLOCKS says %s'
                             % (name, fmt, types.get(name)))
        out[name] = values

    emit_buildings(data, bucket.buildings, strings, enums, put)
    emit_roads(data, bucket.roads, strings, enums, put)
    emit_rings_kind(data, 'areas', bucket.areas, enums, 'areaKind', 'k', put)
    emit_rings_kind(data, 'rails', bucket.rails, enums, 'railKind', 'k', put)
    emit_pois(data, bucket.pois, strings, enums, put)

    lens = []
    body = []
    blob = strings.blob()
    head_len = 16 + 4 * len(TILE_BLOCKS)
    offset = head_len + len(blob)
    pad = (-offset) % 4
    if pad:
        blob += b'\0' * pad
        offset += pad
    for name, fmt in TILE_BLOCKS:
        vals = out.get(name, ())
        lens.append(len(vals))
        if not vals:
            continue
        gap = (-offset) % 4
        if gap:
            body.append(b'\0' * gap)
            offset += gap
        chunk = struct.pack('<%d%s' % (len(vals), ELEM_CODE[fmt]), *vals)
        body.append(chunk)
        offset += len(chunk)

    head = TILE_MAGIC + struct.pack('<HHII', TILE_VERSION, len(TILE_BLOCKS),
                                    len(strings.table), len(blob))
    head += struct.pack('<%dI' % len(lens), *lens)
    if len(head) != head_len:
        raise SystemExit('pack_city: tile header is %d bytes, expected %d' % (len(head), head_len))
    return head + blob + b''.join(body)


# ------------------------------------------------------------------- global ---

def pack_global(data, enums, spanning):
    """Everything that is not local to a tile, in one file fetched once at boot.

    The terrain height field, because groundY() is asked about places nobody is standing; the
    lake shore and the waterfront structures, because buildHarbour() consumes both whole; and the
    hundred-odd features that are larger than a tile, because no tile can honestly own them.

    Terrain is delta-coded in millimetres along row-major order. Integer addition is exact and the
    decoder still divides by 1000, so `prev + d` reproduces the same double the JSON literal
    parsed to -- the delta is a transport trick, not a quantisation.
    """
    blocks = Blocks()
    strings = Strings()

    terrain = data.get('terrain') or {'nx': 2, 'nz': 2, 'cell': 25.0, 'h': [0, 0, 0, 0]}
    heights = terrain.get('h', [])
    delta = []
    esc = []
    prev = 0
    for v in heights:
        mm = int(round(float(v) * 1000.0))
        d = mm - prev
        if d < I16_MIN or d > I16_MAX:
            delta.append(ESC)
            esc.append(mm)
        else:
            delta.append(d)
        prev = mm
    blocks.add('terrain.d', 'i16', delta)
    blocks.add('terrain.esc', 'i32', esc)

    def put(name, fmt, values):
        blocks.add(name, fmt, values)

    shore = data.get('shore', [])
    roles, role_index = dictionary([it.get('role') for it in shore])
    emit_rings_kind(data, 'shore', list(range(len(shore))), {'shoreRole': role_index},
                    'shoreRole', 'role', put)
    emit_rings_kind(data, 'waterfront', list(range(len(data.get('waterfront', [])))), enums,
                    'wfKind', 'k', put, strings=strings)

    emit_roads(data, spanning['roads'], strings, enums, put, prefix='span.roads')
    emit_rings_kind(data, 'areas', spanning['areas'], enums, 'areaKind', 'k', put,
                    prefix='span.areas')
    emit_rings_kind(data, 'rails', spanning['rails'], enums, 'railKind', 'k', put,
                    prefix='span.rails')

    header = {
        'terrain': {'nx': int(terrain.get('nx', 2)), 'nz': int(terrain.get('nz', 2)),
                    'cell': float(terrain.get('cell', 25.0)), 'n': len(heights)},
        'shoreRole': roles,
        'names': strings.table,
        'blocks': blocks.table,
    }
    head = json.dumps(header, separators=(',', ':'), sort_keys=True).encode('utf-8')
    pad = (-(len(head) + 8)) % 4
    head += b' ' * pad
    return GLOBAL_MAGIC + struct.pack('<I', len(head)) + head + blocks.payload(), roles


# --------------------------------------------------------------- the writers --

def build_enums(data):
    """Every enum table, computed over the whole city so a u8 id means one thing everywhere."""
    enums = {}
    tables = {}
    for cls, key, name in ENUM_U8:
        table, index = dictionary([it.get(key) for it in data.get(cls, [])])
        if len(table) > 255:
            raise SystemExit('pack_city: enum %s has %d entries and no longer fits a u8'
                             % (name, len(table)))
        enums[name] = index
        tables[name] = table
    units = [u for b in data.get('buildings', []) for u in (b.get('u') or [])]
    cat_table, cat_index = dictionary([u.get('c') for u in units])
    if len(cat_table) > 255:
        raise SystemExit('pack_city: enum unitCategory has %d entries and no longer fits a u8'
                         % len(cat_table))
    enums['unitCategory'] = cat_index
    tables['unitCategory'] = cat_table
    val_table, val_index = dictionary([u.get('v') for u in units])
    enums['unitValues'] = val_index
    tables['unitValues'] = val_table
    return enums, tables


def write_city(data, grid, const, quiet=False):
    """data/city/: the manifest, the global block and the grouped tile payloads."""
    enums, tables = build_enums(data)
    buckets, spanning = assign(data, grid)

    gnx = int(math.ceil(grid.nx / float(GROUP_EDGE)))
    gnz = int(math.ceil(grid.nz / float(GROUP_EDGE)))
    group_of = [((tid // grid.nx) // GROUP_EDGE) * gnx + ((tid % grid.nx) // GROUP_EDGE)
                for tid in range(grid.count)]

    payloads = [b'' if buckets[t].empty() else pack_tile(data, buckets[t], enums)
                for t in range(grid.count)]

    if not os.path.isdir(CITY_DIR):
        os.makedirs(CITY_DIR)
    for stale in os.listdir(CITY_DIR):
        if stale.endswith('.bin') or stale == 'manifest.json':
            os.remove(os.path.join(CITY_DIR, stale))

    files = []
    offs = [0] * grid.count
    lens = [0] * grid.count
    file_of = [-1] * grid.count
    members_of = {}
    for t in range(grid.count):
        if payloads[t]:
            members_of.setdefault(group_of[t], []).append(t)
    for g in sorted(members_of):
        name = 'g%04d.bin' % g
        chunks = []
        cursor = 0
        for t in members_of[g]:
            offs[t] = cursor
            lens[t] = len(payloads[t])
            file_of[t] = len(files)
            chunks.append(payloads[t])
            cursor += len(payloads[t])
            pad = (-cursor) % 4
            if pad:
                chunks.append(b'\0' * pad)
                cursor += pad
        with open(os.path.join(CITY_DIR, name), 'wb') as fh:
            fh.write(b''.join(chunks))
        files.append({'f': name, 'bytes': cursor})

    global_blob, shore_roles = pack_global(data, enums, spanning)
    with open(os.path.join(CITY_DIR, 'global.bin'), 'wb') as fh:
        fh.write(global_blob)

    box = []
    for t in range(grid.count):
        for v in buckets[t].box:
            box.append(int(round(v * 100.0)))
    box_y = []
    for lo, hi in vertical_bounds(data, grid, buckets):
        box_y.append(int(math.floor(lo * 100.0)))
        box_y.append(int(math.ceil(hi * 100.0)))

    counts = {k: len(data.get(k, [])) for k in
              ('buildings', 'roads', 'areas', 'rails', 'shore', 'waterfront', 'pois')}
    counts['units'] = sum(len(b.get('u') or []) for b in data.get('buildings', []))
    counts['spanning'] = sum(len(v) for v in spanning.values())

    manifest = {
        'format': 'TORT1',
        'version': TILE_VERSION,
        'meta': data.get('meta', {}),
        'grid': {'size': grid.size, 'margin': grid.margin, 'x0': grid.x0, 'z0': grid.z0,
                 'nx': grid.nx, 'nz': grid.nz},
        'gridSource': {'tileSize': const['size'], 'fringeFrac': const['fringe_frac'],
                       'fringeMin': const['fringe_min'], 'fringeMax': const['fringe_max'],
                       'marginPad': const['margin_pad']},
        'counts': counts,
        'blocks': [[n, f] for n, f in TILE_BLOCKS],
        'enums': tables,
        'shoreRole': shore_roles,
        'global': {'file': 'global.bin', 'bytes': len(global_blob)},
        'groupEdge': GROUP_EDGE,
        'files': [f['f'] for f in files],
        'tiles': {'file': file_of, 'off': offs, 'len': lens, 'box': box, 'boxY': box_y},
    }
    text = json.dumps(manifest, separators=(',', ':'), sort_keys=True)
    with open(os.path.join(CITY_DIR, 'manifest.json'), 'w', encoding='utf-8') as fh:
        fh.write(text)

    live = [n for n in lens if n]
    total = sum(f['bytes'] for f in files)
    dep = dependency_stats(grid, buckets)
    if not quiet:
        ext = (data.get('meta') or {}).get('extent') or {}
        print('pack_city: data/city/ -- %d tiles (%d populated) in %d group files of %dx%d'
              % (grid.count, len(live), len(files), GROUP_EDGE, GROUP_EDGE))
        print('  grid %dx%d at %.0f m, margin %.3f m, extent %.1f x %.1f m'
              % (grid.nx, grid.nz, grid.size, grid.margin,
                 float(ext.get('x', 0)), float(ext.get('z', 0))))
        print('  manifest %.1f KB, global %.1f KB (%d spanning features), tiles %.2f MB'
              % (len(text.encode('utf-8')) / 1024.0, len(global_blob) / 1024.0,
                 counts['spanning'], total / 1048576.0))
        print('  tile payload  min %.1f KB  median %.1f KB  max %.1f KB'
              % (min(live) / 1024.0, sorted(live)[len(live) // 2] / 1024.0, max(live) / 1024.0))
        print('  payloads resident to build one tile: avg %.2f, p95 %d, max %d'
              % (dep['avg'], dep['p95'], dep['max']))
    return {'manifest': manifest, 'manifestBytes': len(text.encode('utf-8')),
            'globalBytes': len(global_blob), 'tileBytes': total, 'files': len(files),
            'populated': len(live), 'lens': lens, 'dep': dep, 'buckets': buckets,
            'spanning': spanning, 'enums': enums}


def write_mono(data):
    """data/toronto.bin: the monolithic sidecar, unchanged. The loader's second line of defence."""
    blocks = Blocks()
    header = {'format': 'TOR2', 'meta': data.get('meta', {}), 'counts': {}, 'dicts': {},
              'blocks': None}

    terrain = data.get('terrain') or {'nx': 2, 'nz': 2, 'cell': 25.0, 'h': [0, 0, 0, 0]}
    header['terrain'] = {'nx': int(terrain.get('nx', 2)), 'nz': int(terrain.get('nz', 2)),
                         'cell': float(terrain.get('cell', 25.0))}
    blocks.add('terrain.h', 'i32', [int(round(v * 1000.0)) for v in terrain.get('h', [])])

    names, name_index = dictionary(
        [b.get('n') for b in data.get('buildings', [])] +
        [r.get('n') for r in data.get('roads', [])] +
        [w.get('n') for w in data.get('waterfront', [])])
    header['dicts']['names'] = names

    def name_ids(items):
        return [name_index.get(it.get('n'), -1) if isinstance(it.get('n'), str) else -1
                for it in items]

    def enum_block(items, key, block):
        table, index = dictionary([it.get(key) for it in items])
        blocks.add(block, 'u8', [index.get(it.get(key), 255) for it in items])
        return table

    def rings_into(prefix, rings):
        rl, org, dlt, esc = encode_rings(rings)
        blocks.add(prefix + '.ringLen', 'i32', rl)
        blocks.add(prefix + '.origin', 'i32', org)
        blocks.add(prefix + '.delta', 'i16', dlt)
        blocks.add(prefix + '.esc', 'i32', esc)
        return len(esc) // 2

    escapes = 0
    buildings = data.get('buildings', [])
    header['counts']['buildings'] = len(buildings)
    rings = []
    rings_per = []
    for b in buildings:
        rr = b.get('r') or []
        rings_per.append(len(rr))
        rings.extend(rr)
    blocks.add('buildings.ringsPer', 'i32', rings_per)
    escapes += rings_into('buildings', rings)
    blocks.add('buildings.h', 'i32',
               [int(round(float(b.get('h', 0.0)) * 100.0)) for b in buildings])
    blocks.add('buildings.y', 'i32',
               [int(round(float(b.get('y', 0.0)) * 100.0)) for b in buildings])
    blocks.add('buildings.t', 'u8', [int(b.get('t', 0)) & 255 for b in buildings])
    header['dicts']['buildingMat'] = enum_block(buildings, 'm', 'buildings.mat')
    col = []
    has = []
    for b in buildings:
        c = b.get('c')
        if isinstance(c, list) and len(c) >= 3:
            has.append(1)
            for k in range(3):
                col.append(max(0, min(10000, int(round(float(c[k]) * 10000.0)))))
        else:
            has.append(0)
            col.extend((0, 0, 0))
    blocks.add('buildings.colHas', 'u8', has)
    blocks.add('buildings.col', 'i32', col)
    blocks.add('buildings.name', 'i32', name_ids(buildings))

    hnums, hnum_index = dictionary(
        [b.get('hn') for b in buildings] +
        [u.get('h') for b in buildings for u in (b.get('u') or [])])
    header['dicts']['houseNumbers'] = hnums
    blocks.add('buildings.hnum', 'i32',
               [hnum_index.get(b.get('hn'), -1) if isinstance(b.get('hn'), str) else -1
                for b in buildings])
    blocks.add('buildings.levels', 'u8',
               [max(0, min(255, int(b.get('lv', 0) or 0))) for b in buildings])
    header['dicts']['roofShape'] = enum_block(buildings, 'rs', 'buildings.roof')

    units = []
    units_per = []
    for b in buildings:
        uu = b.get('u') or []
        units_per.append(len(uu))
        units.extend(uu)
    header['counts']['units'] = len(units)
    blocks.add('buildings.unitsPer', 'i32', units_per)
    unit_names, unit_name_index = dictionary(
        [u.get('n') for u in units] + [u.get('b') for u in units])
    header['dicts']['unitNames'] = unit_names
    header['dicts']['unitCategory'] = enum_block(units, 'c', 'units.cat')
    unit_values, unit_value_index = dictionary([u.get('v') for u in units])
    header['dicts']['unitValues'] = unit_values
    blocks.add('units.val', 'i32', [unit_value_index.get(u.get('v'), -1) for u in units])
    blocks.add('units.seg', 'i32', [int(u.get('s', 0)) for u in units])
    blocks.add('units.t', 'u16',
               [max(0, min(65535, int(round(float(u.get('t', 0.0)) * 1000.0)))) for u in units])
    blocks.add('units.name', 'i32',
               [unit_name_index.get(u.get('n'), -1) if isinstance(u.get('n'), str) else -1
                for u in units])
    blocks.add('units.brand', 'i32',
               [unit_name_index.get(u.get('b'), -1) if isinstance(u.get('b'), str) else -1
                for u in units])
    blocks.add('units.house', 'i32',
               [hnum_index.get(u.get('h'), -1) if isinstance(u.get('h'), str) else -1
                for u in units])
    blocks.add('units.hours', 'u8', [1 if u.get('o') else 0 for u in units])

    pois = data.get('pois', [])
    header['counts']['pois'] = len(pois)
    header['dicts']['poiKind'] = enum_block(pois, 'k', 'pois.kind')
    blocks.add('pois.x', 'i32', [int(round(float(p.get('x', 0.0)) * 100.0)) for p in pois])
    blocks.add('pois.z', 'i32', [int(round(float(p.get('z', 0.0)) * 100.0)) for p in pois])
    poi_names, poi_name_index = dictionary([p.get('n') for p in pois])
    header['dicts']['poiNames'] = poi_names
    blocks.add('pois.name', 'i32',
               [poi_name_index.get(p.get('n'), -1) if isinstance(p.get('n'), str) else -1
                for p in pois])

    roads = data.get('roads', [])
    header['counts']['roads'] = len(roads)
    escapes += rings_into('roads', [r.get('p') or [] for r in roads])
    header['dicts']['roadClass'] = enum_block(roads, 'c', 'roads.cls')
    blocks.add('roads.w', 'i32', [int(round(float(r.get('w', 8.0)) * 100.0)) for r in roads])
    blocks.add('roads.lay', 'i8', [max(-4, min(4, int(r.get('lay', 0)))) for r in roads])
    blocks.add('roads.b', 'u8', [int(r.get('b', 0)) & 255 for r in roads])
    blocks.add('roads.tun', 'u8', [int(r.get('tun', 0)) & 255 for r in roads])
    blocks.add('roads.name', 'i32', name_ids(roads))

    for cls, key, dic in (('areas', 'k', 'areaKind'), ('rails', 'k', 'railKind'),
                          ('shore', 'role', 'shoreRole'), ('waterfront', 'k', 'wfKind')):
        items = data.get(cls, [])
        header['counts'][cls] = len(items)
        escapes += rings_into(cls, [it.get('p') or [] for it in items])
        header['dicts'][dic] = enum_block(items, key, cls + '.kind')
    blocks.add('waterfront.name', 'i32', name_ids(data.get('waterfront', [])))

    header['escapes'] = escapes
    header['blocks'] = blocks.table
    head = json.dumps(header, separators=(',', ':'), sort_keys=True).encode('utf-8')
    pad = (-(len(head) + 8)) % 4
    head += b' ' * pad
    with open(DST, 'wb') as fh:
        fh.write(MAGIC)
        fh.write(struct.pack('<I', len(head)))
        fh.write(head)
        fh.write(blocks.payload())
    return {'bytes': os.path.getsize(DST), 'header': len(head), 'escapes': escapes}


# ---------------------------------------------------------------------- main --

def main(argv):
    if not os.path.exists(SRC):
        sys.stderr.write('pack_city: %s not found; run build_city.py first\n' % SRC)
        return 1
    want_mono = '--no-mono' not in argv
    want_verify = '--verify' in argv
    with open(SRC, 'r', encoding='utf-8') as fh:
        data = json.load(fh)

    const = grid_constants()
    extent = (data.get('meta') or {}).get('extent') or {}
    grid = Grid(extent, const)

    report = write_city(data, grid, const)
    mono = write_mono(data) if want_mono else None

    src_size = os.path.getsize(SRC)
    streamed = report['tileBytes'] + report['globalBytes'] + report['manifestBytes']
    print('  %s: %.2f MB of JSON -> %.2f MB across %d files (%.0f%% of the JSON)'
          % (os.path.relpath(SRC, ROOT), src_size / 1048576.0, streamed / 1048576.0,
             report['files'] + 2, 100.0 * streamed / max(1, src_size)))
    if mono:
        print('  data/toronto.bin: %.2f MB (fallback, still written; --no-mono to skip)'
              % (mono['bytes'] / 1048576.0))

    if want_verify:
        worst = check_roundtrip(data, grid, report)
        print('  exact decode: max error %r over every numeric field in the city' % worst)
        if worst != 0:
            return 2
    return 0


# ------------------------------------------------------------------- verify ---

def read_blocks(raw, base, table, names):
    """Unpack a JSON-header block table (global.bin) into plain tuples."""
    out = {}
    for name in names:
        b = table.get(name)
        if not b:
            out[name] = ()
            continue
        off = base + b['off']
        n = b['len']
        out[name] = struct.unpack('<%d%s' % (n, ELEM_CODE[b['type']]),
                                  raw[off:off + n * ELEM_SIZE[b['type']]])
    return out


def rings_from(blk, prefix):
    """The ring reader, in Python, divided exactly as src/data/load.js divides."""
    rl = blk[prefix + '.ringLen']
    org = blk[prefix + '.origin']
    dlt = blk[prefix + '.delta']
    esc = blk[prefix + '.esc']
    out = []
    oi = di = ei = 0
    for n in rl:
        ring = []
        if n <= 0:
            out.append(ring)
            continue
        x = org[oi]
        z = org[oi + 1]
        oi += 2
        ring.append([x / 100.0, z / 100.0])
        for _ in range(n - 1):
            dx = dlt[di]
            dz = dlt[di + 1]
            di += 2
            if dx == ESC and dz == ESC:
                x = esc[ei]
                z = esc[ei + 1]
                ei += 2
            else:
                x += dx
                z += dz
            ring.append([x / 100.0, z / 100.0])
        out.append(ring)
    return out


def check_roundtrip(data, grid, report):
    """Decode every payload back and compare against the JSON. Returns the maximum error.

    Also proves the partition: every feature appears exactly once across the tiles and the global
    block, and its index is the index it had in the JSON array.
    """
    manifest = report['manifest']
    types = dict(TILE_BLOCKS)
    order = [n for n, _ in TILE_BLOCKS]
    enums = manifest['enums']
    worst = [0.0]
    seen = {k: [] for k in ('buildings', 'roads', 'areas', 'rails', 'pois')}

    def note(got, want):
        if not isinstance(want, (int, float)):
            return
        e = abs(got - want)
        if e > worst[0]:
            worst[0] = e

    def check_rings(rings, sources):
        for k, ring in enumerate(sources):
            g = rings[k]
            want = [p for p in ring if len(p) >= 2]
            if len(g) != len(want):
                raise SystemExit('pack_city: ring length mismatch (%d vs %d)' % (len(g), len(want)))
            for a, b in zip(g, want):
                note(a[0], b[0])
                note(a[1], b[1])

    def read_tile(tid):
        fi = manifest['tiles']['file'][tid]
        if fi < 0:
            return None
        with open(os.path.join(CITY_DIR, manifest['files'][fi]), 'rb') as fh:
            fh.seek(manifest['tiles']['off'][tid])
            raw = fh.read(manifest['tiles']['len'][tid])
        if raw[:4] != TILE_MAGIC:
            raise SystemExit('pack_city: tile %d has bad magic' % tid)
        ver, nblk, nstr, sbytes = struct.unpack('<HHII', raw[4:16])
        if ver != TILE_VERSION or nblk != len(order):
            raise SystemExit('pack_city: tile %d header mismatch' % tid)
        lens = struct.unpack('<%dI' % nblk, raw[16:16 + 4 * nblk])
        cursor = 16 + 4 * nblk
        strings = raw[cursor:cursor + sbytes].decode('utf-8').split('\0')[:nstr] if nstr else []
        cursor += sbytes
        out = {}
        for name, n in zip(order, lens):
            if not n:
                out[name] = ()
                continue
            cursor += (-cursor) % 4
            fmt = types[name]
            nbytes = n * ELEM_SIZE[fmt]
            out[name] = struct.unpack('<%d%s' % (n, ELEM_CODE[fmt]), raw[cursor:cursor + nbytes])
            cursor += nbytes
        return out, strings

    for tid in range(grid.count):
        got = read_tile(tid)
        if got is None:
            continue
        blk, strings = got

        idx = blk['buildings.idx']
        seen['buildings'].extend(idx)
        blds = [data['buildings'][i] for i in idx]
        check_rings(rings_from(blk, 'buildings'),
                    [r for b in blds for r in (b.get('r') or [])])
        for k, b in enumerate(blds):
            note(blk['buildings.h'][k] / 100.0, b.get('h'))
            note(blk['buildings.y'][k] / 100.0, b.get('y'))
            if blk['buildings.colHas'][k]:
                for c in range(3):
                    note(blk['buildings.col'][k * 3 + c] / 10000.0, b['c'][c])
            nid = blk['buildings.name'][k]
            if (strings[nid] if nid >= 0 else '') != (b.get('n') or ''):
                raise SystemExit('pack_city: building name mismatch at %d' % idx[k])
            hid = blk['buildings.hnum'][k]
            if (strings[hid] if hid >= 0 else '') != (b.get('hn') or ''):
                raise SystemExit('pack_city: house number mismatch at %d' % idx[k])
        for u, uu in enumerate(uu for b in blds for uu in (b.get('u') or [])):
            note(blk['units.t'][u] / 1000.0, uu.get('t'))
            vid = blk['units.val'][u]
            if (enums['unitValues'][vid] if vid >= 0 else '') != (uu.get('v') or ''):
                raise SystemExit('pack_city: unit value mismatch')
            nid = blk['units.name'][u]
            if (strings[nid] if nid >= 0 else '') != (uu.get('n') or ''):
                raise SystemExit('pack_city: unit name mismatch')

        for cls in TILED_LINE_CLASSES:
            ids = blk[cls + '.idx']
            seen[cls].extend(ids)
            items = [data[cls][i] for i in ids]
            check_rings(rings_from(blk, cls), [it.get('p') or [] for it in items])
            if cls == 'roads':
                for k, r in enumerate(items):
                    note(blk['roads.w'][k] / 100.0, r.get('w'))
                    nid = blk['roads.name'][k]
                    if (strings[nid] if nid >= 0 else '') != (r.get('n') or ''):
                        raise SystemExit('pack_city: road name mismatch at %d' % ids[k])

        pids = blk['pois.idx']
        seen['pois'].extend(pids)
        for k, i in enumerate(pids):
            q = data['pois'][i]
            note(blk['pois.x'][k] / 100.0, q.get('x'))
            note(blk['pois.z'][k] / 100.0, q.get('z'))

    # ---- the global block: terrain, shore, waterfront and the spanning features.
    with open(os.path.join(CITY_DIR, 'global.bin'), 'rb') as fh:
        raw = fh.read()
    hl = struct.unpack('<I', raw[4:8])[0]
    ghead = json.loads(raw[8:8 + hl].decode('utf-8'))
    base = 8 + hl
    gb = read_blocks(raw, base, ghead['blocks'], list(ghead['blocks'].keys()))

    prev = 0
    ei = 0
    src_h = (data.get('terrain') or {}).get('h', [])
    for k, d in enumerate(gb['terrain.d']):
        if d == ESC:
            prev = gb['terrain.esc'][ei]
            ei += 1
        else:
            prev += d
        note(prev / 1000.0, src_h[k])

    check_rings(rings_from(gb, 'shore'), [it.get('p') or [] for it in data.get('shore', [])])
    check_rings(rings_from(gb, 'waterfront'),
                [it.get('p') or [] for it in data.get('waterfront', [])])
    for cls, prefix in (('roads', 'span.roads'), ('areas', 'span.areas'), ('rails', 'span.rails')):
        ids = gb[prefix + '.idx']
        seen[cls].extend(ids)
        check_rings(rings_from(gb, prefix), [data[cls][i].get('p') or [] for i in ids])

    for cls, got in seen.items():
        want = len(data.get(cls, []))
        if sorted(got) != list(range(want)):
            raise SystemExit('pack_city: %s -- the partition is not exactly 0..%d (%d entries, '
                             '%d distinct)' % (cls, want - 1, len(got), len(set(got))))
    return worst[0]


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
