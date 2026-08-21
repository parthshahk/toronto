#!/usr/bin/env python3
"""Build the Toronto downtown dataset the renderer loads.

Inputs  (data/raw/):
  massing2025/...shp|.dbf   City of Toronto "3D Massing 2025" (Open Government Licence - Toronto)
  osm_infra.json            OpenStreetMap via Overpass  (c) OpenStreetMap contributors, ODbL

Output (data/):
  toronto.json   terrain heightfield + buildings + street network, in LOCAL METRES

Coordinate system: X = east, Y = up, Z = south. Right-handed, matching the engine's yaw
convention (yaw 0 faces +Z). Origin is the bbox centre.

Web Mercator inflates horizontal distance by 1/cos(lat); every coordinate is multiplied by
cos(lat0) to become true metres.
"""
import json, math, os, struct
from collections import defaultdict

R = 6378137.0
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'data', 'raw')
SHP = os.path.join(RAW, 'massing2025', '3DMassingShapefile_2025_WGS84')

# Expanded 2026-08-20: roughly 2x on the north/east/west sides, and stretched south to take in
# the whole Toronto Islands chain (Hanlan's/Centre/Ward's, south shore at 43.6116) and Billy
# Bishop airport, with a margin of open lake beyond. 6.8 x 6.4 km, about 43 km2.
BBOX = dict(west=-79.4290, east=-79.3450, south=43.6060, north=43.6640)

# SURF_ELEV uses 0.0 for "missing" and 130.1 as a fill value; real downtown ground is 74.6-105 m MSL.
ELEV_MIN, ELEV_MAX = 74.0, 115.0
TERRAIN_CELL = 25.0            # metres per heightfield cell

# OSM highway -> (carriageway width m, class). Widths are per-direction-inclusive roadway width.
ROAD_CLASS = {
    'motorway': (22.0, 'motorway'), 'motorway_link': (9.0, 'motorway'),
    'trunk': (18.0, 'major'), 'trunk_link': (8.0, 'major'),
    'primary': (16.0, 'major'), 'primary_link': (7.0, 'major'),
    'secondary': (14.0, 'major'), 'secondary_link': (7.0, 'major'),
    'tertiary': (12.0, 'minor'), 'tertiary_link': (6.5, 'minor'),
    'residential': (10.0, 'minor'), 'unclassified': (10.0, 'minor'),
    'living_street': (8.0, 'minor'), 'service': (6.0, 'service'),
    'pedestrian': (9.0, 'pedestrian'), 'footway': (3.0, 'foot'),
    'path': (2.5, 'foot'), 'steps': (2.5, 'foot'), 'cycleway': (3.0, 'foot'),
    'corridor': (2.5, 'foot'), 'track': (4.0, 'service'),
}


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


class Proj:
    def __init__(self, bbox):
        self.lon0 = (bbox['west'] + bbox['east']) / 2
        self.lat0 = (bbox['south'] + bbox['north']) / 2
        self.ox, self.oy = merc(self.lon0, self.lat0)
        self.k = math.cos(math.radians(self.lat0))

    def xy(self, mx, my):
        """Mercator metres -> local metres. Z is SOUTH, so north (+y) becomes -z."""
        return (mx - self.ox) * self.k, -(my - self.oy) * self.k

    def lonlat(self, lon, lat):
        return self.xy(*merc(lon, lat))


# ---------------------------------------------------------------- shapefile / dbf

def read_dbf(path, indices, names):
    out = {}
    with open(path, 'rb') as f:
        hd = f.read(32)
        nrec = struct.unpack('<i', hd[4:8])[0]
        hlen = struct.unpack('<H', hd[8:10])[0]
        rlen = struct.unpack('<H', hd[10:12])[0]
        fields, off = [], 0
        while True:
            fd = f.read(32)
            if not fd or fd[0] == 0x0D:
                break
            fields.append((fd[0:11].split(b'\0')[0].decode('latin-1'), off, fd[16]))
            off += fd[16]
        want = {n: (o, l) for n, o, l in fields if n in names}
        for idx in sorted(indices):
            if idx >= nrec:
                continue
            f.seek(hlen + idx * rlen)
            rec = f.read(rlen)
            d = {}
            for nm, (o, l) in want.items():
                s = rec[1 + o:1 + o + l].decode('latin-1').strip()
                try:
                    d[nm] = float(s)
                except ValueError:
                    d[nm] = s
            out[idx] = d
    return out


def read_buildings(proj, bbox):
    x0, y0 = merc(bbox['west'], bbox['south'])
    x1, y1 = merc(bbox['east'], bbox['north'])
    print('  reading 210 MB .shp ...', flush=True)
    with open(SHP + '.shp', 'rb') as f:
        buf = f.read()
    pos, i, hits = 100, 0, []
    n = len(buf)
    while pos < n:
        clen = struct.unpack_from('>i', buf, pos + 4)[0] * 2
        c = pos + 8
        if struct.unpack_from('<i', buf, c)[0] in (5, 15, 25):
            bx0, by0, bx1, by1 = struct.unpack_from('<4d', buf, c + 4)
            if not (bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1):
                nparts, npts = struct.unpack_from('<2i', buf, c + 36)
                parts = struct.unpack_from(f'<{nparts}i', buf, c + 44)
                co = struct.unpack_from(f'<{npts*2}d', buf, c + 44 + nparts * 4)
                rings = []
                for p in range(nparts):
                    a = parts[p]
                    b = parts[p + 1] if p + 1 < nparts else npts
                    ring = [proj.xy(co[j * 2], co[j * 2 + 1]) for j in range(a, b)]
                    if len(ring) >= 4:
                        rings.append(ring)
                if rings:
                    hits.append((i, rings))
        pos = c + clen
        i += 1
    print(f'  {i} records scanned, {len(hits)} in bbox', flush=True)
    attrs = read_dbf(SHP + '.dbf', {j for j, _ in hits},
                     {'AVG_HEIGHT', 'MAX_HEIGHT', 'SURF_ELEV', 'HEIGHT_SRC'})
    return hits, attrs


# ---------------------------------------------------------------- terrain

def build_terrain(samples, ext, cell, default=None):
    """Inverse-distance interpolation from trustworthy elevation samples, then smoothed."""
    nx = int(ext['x'] / cell) + 1
    nz = int(ext['z'] / cell) + 1
    hx, hz = ext['x'] / 2, ext['z'] / 2

    # bucket samples so lookup is local rather than O(n) per cell
    grid = defaultdict(list)
    G = 120.0
    for sx, sz, se in samples:
        grid[(int(sx // G), int(sz // G))].append((sx, sz, se))

    field = [0.0] * (nx * nz)
    for j in range(nz):
        wz = -hz + j * cell
        for i in range(nx):
            wx = -hx + i * cell
            gi, gj = int(wx // G), int(wz // G)
            near = []
            rad = 1
            while not near and rad <= 6:
                near = [s for di in range(-rad, rad + 1) for dj in range(-rad, rad + 1)
                        for s in grid.get((gi + di, gj + dj), ())]
                rad += 1
            if not near:
                # No sample in range: open water, or beyond the built-up edge. Fall back to the
                # datum rather than 0 m MSL, which would sink the cell ~74 m below lake level.
                field[j * nx + i] = default
                continue
            near.sort(key=lambda s: (s[0] - wx) ** 2 + (s[1] - wz) ** 2)
            num = den = 0.0
            for sx, sz, se in near[:8]:
                d2 = max(25.0, (sx - wx) ** 2 + (sz - wz) ** 2)
                w = 1.0 / d2
                num += se * w
                den += w
            field[j * nx + i] = num / den

    for _ in range(3):                                  # gaussian-ish smoothing passes
        nf = field[:]
        for j in range(nz):
            for i in range(nx):
                acc = w = 0.0
                for dj in (-1, 0, 1):
                    for di in (-1, 0, 1):
                        a, b = i + di, j + dj
                        if 0 <= a < nx and 0 <= b < nz:
                            k = 4.0 if di == 0 and dj == 0 else (2.0 if di == 0 or dj == 0 else 1.0)
                            acc += field[b * nx + a] * k
                            w += k
                nf[j * nx + i] = acc / w
        field = nf
    return nx, nz, field


def sample_terrain(field, nx, nz, ext, cell, x, z):
    fx = (x + ext['x'] / 2) / cell
    fz = (z + ext['z'] / 2) / cell
    i = max(0, min(nx - 2, int(fx)))
    j = max(0, min(nz - 2, int(fz)))
    tx, tz = fx - i, fz - j
    a = field[j * nx + i]; b = field[j * nx + i + 1]
    c = field[(j + 1) * nx + i]; d = field[(j + 1) * nx + i + 1]
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz


# ---------------------------------------------------------------- OSM

def read_osm(proj, bbox):
    path = os.path.join(RAW, 'osm_infra.json')
    data = json.load(open(path))
    roads, areas, rails = [], [], []
    for e in data['elements']:
        t = e.get('tags', {})
        geom = e.get('geometry')
        if not geom:
            continue
        pts = [proj.lonlat(g['lon'], g['lat']) for g in geom]
        if len(pts) < 2:
            continue
        if 'highway' in t:
            hw = t['highway']
            if hw not in ROAD_CLASS:
                continue
            w, cls = ROAD_CLASS[hw]
            if t.get('width'):
                try:
                    w = max(2.0, min(40.0, float(str(t['width']).split()[0])))
                except ValueError:
                    pass
            lanes = t.get('lanes')
            if lanes and cls in ('major', 'minor'):
                try:
                    w = max(w, float(lanes) * 3.3)
                except ValueError:
                    pass
            # `layer` is a SIGNED integer: negative means this way passes UNDER something.
            # Treating any non-zero layer as a bridge (the previous behaviour) elevated 750
            # underpasses -- including every road that dips beneath the rail corridor -- and
            # dropping tunnels outright deleted another 712 ways, leaving holes you could
            # walk into. Carry the real layer and let the geometry stage decide.
            try:
                layer = int(float(t.get('layer', 0) or 0))
            except ValueError:
                layer = 0
            layer = max(-4, min(4, layer))
            tunnel = t.get('tunnel', '')
            roads.append({
                'c': cls, 'w': round(w, 1),
                'n': t.get('name', ''),
                'lay': layer,
                'b': 1 if t.get('bridge') and t.get('bridge') != 'no' else 0,
                # 'building_passage' is a road running through a building, not a bore; it must
                # stay at grade and stay walkable.
                'tun': 2 if tunnel == 'building_passage' else (1 if tunnel and tunnel != 'no' else 0),
                'p': [[round(p[0], 2), round(p[1], 2)] for p in pts],
            })
        elif 'railway' in t and t['railway'] in ('rail', 'tram', 'light_rail', 'subway'):
            rails.append({'k': t['railway'],
                          'p': [[round(p[0], 2), round(p[1], 2)] for p in pts]})
        else:
            kind = None
            if t.get('natural') == 'water' or 'waterway' in t:
                kind = 'water'
            elif t.get('leisure') in ('park', 'garden'):
                kind = 'park'
            elif t.get('landuse') in ('grass', 'meadow', 'recreation_ground'):
                kind = 'grass'
            elif t.get('amenity') == 'parking':
                kind = 'parking'
            elif t.get('man_made') == 'pier':
                kind = 'pier'
            if kind and len(pts) >= 3:
                areas.append({'k': kind,
                              'p': [[round(p[0], 2), round(p[1], 2)] for p in pts]})
    return roads, areas, rails


# ---------------------------------------------------------------- main


def read_water(proj, bbox):
    """Real shoreline and the engineered harbour edge.

    Toronto's waterfront is not a natural shore -- it is quay walls, piers and breakwaters -- so
    those structures ARE the boundary. The Lake Ontario multipolygon supplies the water side.
    Previously the shoreline was synthesised by distance-transforming the road network, accurate
    to about +/-25 m; this replaces that guess with surveyed geometry.
    """
    path = os.path.join(RAW, 'osm_water.json')
    if not os.path.exists(path):
        return {'shore': [], 'edges': []}
    data = json.load(open(path))
    x0, y0 = merc(bbox['west'], bbox['south'])
    x1, y1 = merc(bbox['east'], bbox['north'])
    pad = 900.0 / proj.k          # keep a margin outside the frame so the water reads to the horizon

    def clip_keep(pts):
        return any(x0 - pad <= mx <= x1 + pad and y0 - pad <= my <= y1 + pad for mx, my in pts)

    shore, edges = [], []
    for e in data['elements']:
        t = e.get('tags', {})
        if e['type'] == 'relation' and t.get('name') == 'Lake Ontario':
            for m in e.get('members', []):
                g = m.get('geometry')
                if not g or len(g) < 2:
                    continue
                raw = [merc(q['lon'], q['lat']) for q in g]
                if not clip_keep(raw):
                    continue
                shore.append({
                    'role': m.get('role', 'outer'),
                    'p': [[round(v, 2) for v in proj.xy(mx, my)] for mx, my in raw],
                })
            continue
        g = e.get('geometry')
        if not g or len(g) < 2:
            continue
        kind = None
        if t.get('man_made') in ('pier', 'quay', 'breakwater', 'groyne'):
            kind = t['man_made']
        elif t.get('barrier') == 'retaining_wall':
            kind = 'retaining_wall'
        elif t.get('leisure') == 'marina':
            kind = 'marina'
        elif t.get('amenity') == 'ferry_terminal':
            kind = 'ferry_terminal'
        if not kind:
            continue
        raw = [merc(q['lon'], q['lat']) for q in g]
        if not clip_keep(raw):
            continue
        edges.append({
            'k': kind,
            'n': t.get('name', ''),
            'p': [[round(v, 2) for v in proj.xy(mx, my)] for mx, my in raw],
        })
    return {'shore': shore, 'edges': edges}


def main():
    proj = Proj(BBOX)
    x0, y0 = merc(BBOX['west'], BBOX['south'])
    x1, y1 = merc(BBOX['east'], BBOX['north'])
    ext = {'x': (x1 - x0) * proj.k, 'z': (y1 - y0) * proj.k}
    print(f'area {ext["x"]:.0f} m E-W x {ext["z"]:.0f} m N-S, origin '
          f'{proj.lon0:.5f},{proj.lat0:.5f}')

    print('buildings:')
    hits, attrs = read_buildings(proj, BBOX)

    # terrain from trustworthy samples only
    samples = []
    for idx, rings in hits:
        e = attrs.get(idx, {}).get('SURF_ELEV', 0.0)
        if isinstance(e, float) and ELEV_MIN < e < ELEV_MAX and abs(e - 130.1) > 0.05:
            r = rings[0]
            cx = sum(p[0] for p in r) / len(r)
            cz = sum(p[1] for p in r) / len(r)
            samples.append((cx, cz, e))
    lake = min(s[2] for s in samples)
    print(f'  {len(samples)} trustworthy elevation samples, lake datum {lake:.1f} m MSL')

    print('terrain:')
    nx, nz, field = build_terrain(samples, ext, TERRAIN_CELL, default=lake)
    field = [round(v - lake, 3) for v in field]         # relative to lake level
    print(f'  {nx}x{nz} grid @ {TERRAIN_CELL} m, range '
          f'{min(field):.1f}..{max(field):.1f} m above lake')

    buildings = []
    for idx, rings in hits:
        a = attrs.get(idx, {})
        h = max(a.get('AVG_HEIGHT') or 0.0, a.get('MAX_HEIGHT') or 0.0)
        if h <= 0.5:
            continue
        r = rings[0]
        cx = sum(p[0] for p in r) / len(r)
        cz = sum(p[1] for p in r) / len(r)
        base = sample_terrain(field, nx, nz, ext, TERRAIN_CELL, cx, cz)
        buildings.append({
            'h': round(h, 2),
            'y': round(base, 2),
            'r': [[[round(p[0], 2), round(p[1], 2)] for p in ring] for ring in rings],
        })

    print('osm:')
    roads, areas, rails = read_osm(proj, BBOX)
    water = read_water(proj, BBOX)
    print(f'  shoreline: {len(water["shore"])} ways, waterfront edges: {len(water["edges"])}')
    from collections import Counter as _C
    print(f'  road layers: {dict(sorted(_C(r["lay"] for r in roads).items()))}')
    print(f'  bridges {sum(1 for r in roads if r["b"])}, tunnels {sum(1 for r in roads if r["tun"] == 1)},'
          f' building passages {sum(1 for r in roads if r["tun"] == 2)}')
    print(f'  {len(roads)} road ways, {len(areas)} areas, {len(rails)} rail ways')

    out = {
        'meta': {
            'origin': {'lon': proj.lon0, 'lat': proj.lat0},
            'bbox': BBOX, 'extent': {'x': round(ext['x'], 1), 'z': round(ext['z'], 1)},
            'lake_msl': round(lake, 2),
            'axes': 'X=east, Y=up, Z=south (right-handed)',
            'sources': [
                'Buildings: City of Toronto Open Data, 3D Massing 2025 (Open Government Licence - Toronto)',
                'Streets/landuse: (c) OpenStreetMap contributors, ODbL',
            ],
        },
        'terrain': {'nx': nx, 'nz': nz, 'cell': TERRAIN_CELL, 'h': field},
        'buildings': buildings,
        'roads': roads,
        'areas': areas,
        'rails': rails,
        'shore': water['shore'],
        'waterfront': water['edges'],
    }
    dst = os.path.join(HERE, '..', 'data', 'toronto.json')
    with open(dst, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    hs = sorted(b['h'] for b in buildings)
    print(f'\n{len(buildings)} buildings | median {hs[len(hs)//2]:.0f} m, '
          f'p99 {hs[int(len(hs)*0.99)]:.0f} m, max {hs[-1]:.0f} m')
    print(f'wrote {dst}  ({os.path.getsize(dst)/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
