#!/usr/bin/env python3
"""tools/pack_city.py -- pack data/toronto.json into the binary sidecar data/toronto.bin.

The JSON extract is the authoring format: readable, diffable, and what build_city.py and
match_osm.py write. It is a poor *transport* format. At the full-city extent it is 11.8 MB of
text, 3.3 MB over the wire once the server gzips it, and JSON.parse has to allocate ~493,000
two-element arrays before the first frame can start.

The sidecar carries exactly the same information with the geometry moved into typed arrays:

    magic  'TOR2'          4 bytes
    uint32 headerLen
    header JSON (utf8)     meta, terrain shape, string dictionaries, block table
    blocks                 4-byte aligned typed-array payloads

Coordinates are centimetres. The first point of every ring is stored absolutely as int32; the
rest are int16 deltas from the previous point, with an escape (-32768, -32768) that pulls the
next absolute pair out of a side channel for the handful of segments longer than 327 m.

Run it after any change to the JSON:

    python3 tools/pack_city.py

zero dependencies, like everything else in tools/.
"""

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'data', 'toronto.json')
DST = os.path.join(ROOT, 'data', 'toronto.bin')

MAGIC = b'TOR2'
ESC = -32768
I16_MIN = -32767
I16_MAX = 32767


class Blocks:
    """Accumulates typed-array payloads and the table that describes them."""

    def __init__(self):
        self.table = {}
        self.parts = []
        self.offset = 0

    def add(self, name, fmt, values):
        code = {'i8': 'b', 'u8': 'B', 'i16': 'h', 'u16': 'H', 'i32': 'i', 'f32': 'f'}[fmt]
        blob = struct.pack('<%d%s' % (len(values), code), *values)
        pad = (-self.offset) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.offset += pad
        self.table[name] = {'type': fmt, 'off': self.offset, 'len': len(values)}
        self.parts.append(blob)
        self.offset += len(blob)

    def payload(self):
        return b''.join(self.parts)


def encode_rings(blocks, prefix, rings):
    """Ring lengths, absolute origins and int16 deltas for one class of geometry."""
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
    blocks.add(prefix + '.ringLen', 'i32', ring_len)
    blocks.add(prefix + '.origin', 'i32', origin)
    blocks.add(prefix + '.delta', 'i16', delta)
    blocks.add(prefix + '.esc', 'i32', esc)
    return len(esc) // 2


def dictionary(values):
    """Stable string dictionary: sorted, so the file is byte-reproducible."""
    table = sorted({v for v in values if isinstance(v, str) and v})
    index = {v: i for i, v in enumerate(table)}
    return table, index


def main():
    if not os.path.exists(SRC):
        sys.stderr.write('pack_city: %s not found; run build_city.py first\n' % SRC)
        return 1
    with open(SRC, 'r', encoding='utf-8') as fh:
        data = json.load(fh)

    blocks = Blocks()
    header = {
        'format': 'TOR2',
        'meta': data.get('meta', {}),
        'counts': {},
        'dicts': {},
        'blocks': None,
    }

    terrain = data.get('terrain') or {'nx': 2, 'nz': 2, 'cell': 25.0, 'h': [0, 0, 0, 0]}
    header['terrain'] = {
        'nx': int(terrain.get('nx', 2)),
        'nz': int(terrain.get('nz', 2)),
        'cell': float(terrain.get('cell', 25.0)),
    }
    # Millimetres, as int32. build_city.py writes terrain to 3 decimals and dividing an integer
    # count of millimetres by 1000 lands on exactly the double that parsing "39.587" gives, so the
    # sidecar reproduces the JSON bit for bit. Centimetres would be 5 mm out, which is small but
    # shifts every ground-plane vertex in the city off the geometry the JSON path produces.
    blocks.add('terrain.h', 'i32', [int(round(v * 1000.0)) for v in terrain.get('h', [])])

    names, name_index = dictionary(
        [b.get('n') for b in data.get('buildings', [])] +
        [r.get('n') for r in data.get('roads', [])] +
        [w.get('n') for w in data.get('waterfront', [])]
    )
    header['dicts']['names'] = names

    def name_ids(items):
        return [name_index.get(it.get('n'), -1) if isinstance(it.get('n'), str) else -1
                for it in items]

    def enum_block(items, key, block, default=''):
        table, index = dictionary([it.get(key) for it in items])
        blocks.add(block, 'u8', [index.get(it.get(key), 255) for it in items])
        return table

    escapes = 0

    # ------------------------------------------------------------------ buildings
    buildings = data.get('buildings', [])
    header['counts']['buildings'] = len(buildings)
    rings = []
    rings_per = []
    for b in buildings:
        rr = b.get('r') or []
        rings_per.append(len(rr))
        rings.extend(rr)
    blocks.add('buildings.ringsPer', 'i32', rings_per)
    escapes += encode_rings(blocks, 'buildings', rings)
    # Centimetres, not float32: a height of 22.7 m becomes 22.700000762939453 in float32, which
    # is enough to move a building across one of pickClass()'s height thresholds.
    blocks.add('buildings.h', 'i32', [int(round(float(b.get('h', 0.0)) * 100.0)) for b in buildings])
    blocks.add('buildings.y', 'i32', [int(round(float(b.get('y', 0.0)) * 100.0)) for b in buildings])
    blocks.add('buildings.t', 'u8', [int(b.get('t', 0)) & 255 for b in buildings])
    header['dicts']['buildingMat'] = enum_block(buildings, 'm', 'buildings.mat')
    # Surveyed facade colour, in ten-thousandths. match_osm.py writes 4 decimals; quantising to
    # 8 bits would round-trip through a different sRGB value and shift the albedo.
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

    # ---------------------------------------------------------------------- roads
    roads = data.get('roads', [])
    header['counts']['roads'] = len(roads)
    escapes += encode_rings(blocks, 'roads', [r.get('p') or [] for r in roads])
    header['dicts']['roadClass'] = enum_block(roads, 'c', 'roads.cls')
    blocks.add('roads.w', 'i32', [int(round(float(r.get('w', 8.0)) * 100.0)) for r in roads])
    blocks.add('roads.lay', 'i8', [max(-4, min(4, int(r.get('lay', 0)))) for r in roads])
    blocks.add('roads.b', 'u8', [int(r.get('b', 0)) & 255 for r in roads])
    blocks.add('roads.tun', 'u8', [int(r.get('tun', 0)) & 255 for r in roads])
    blocks.add('roads.name', 'i32', name_ids(roads))

    # --------------------------------------------------------- areas, rails, water
    for cls, key, dic in (('areas', 'k', 'areaKind'),
                          ('rails', 'k', 'railKind'),
                          ('shore', 'role', 'shoreRole'),
                          ('waterfront', 'k', 'wfKind')):
        items = data.get(cls, [])
        header['counts'][cls] = len(items)
        escapes += encode_rings(blocks, cls, [it.get('p') or [] for it in items])
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

    src_size = os.path.getsize(SRC)
    dst_size = os.path.getsize(DST)
    print('pack_city: %s -> %s' % (os.path.relpath(SRC, ROOT), os.path.relpath(DST, ROOT)))
    print('  %s buildings, %s roads, %s areas, %s rails, %s shore, %s waterfront, %d escapes'
          % (header['counts']['buildings'], header['counts']['roads'], header['counts']['areas'],
             header['counts']['rails'], header['counts']['shore'],
             header['counts']['waterfront'], escapes))
    print('  header %.1f KB, payload %.1f MB' % (len(head) / 1024.0,
                                                 blocks.offset / 1048576.0))
    print('  %.2f MB -> %.2f MB (%.0f%% of the JSON)'
          % (src_size / 1048576.0, dst_size / 1048576.0, 100.0 * dst_size / max(1, src_size)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
