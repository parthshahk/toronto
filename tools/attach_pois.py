#!/usr/bin/env python3
"""Attach OSM feature NODES to the city, so the ground floor is real rather than invented.

The first three Overpass extracts contained only ways and relations. In OSM the things that make a
street recognisable -- the shops, their names, the entrances, the trees, the lamps, the crossings --
are overwhelmingly NODES, so none of them were present. Buildings were accurate and their bottoms
were fiction.

This reads data/raw/osm_nodes.json and writes two things into data/toronto.json:

  buildings[].u : the retail/commercial UNITS on that building, each with a real name, kind, brand
                  and house number, and its position along the building's own frontage. This is
                  what turns "a random awning" into "the actual shop that is there".
  pois[]        : standalone surveyed features in local metres -- trees, lamps, benches, hydrants,
                  crossings, signals, transit stops, bike parking -- so street furniture can stand
                  where it really stands instead of on a fixed pitch.

It also lifts tags the building matcher was dropping: addr:housenumber, building:levels (real
storey counts, rather than deriving them from total height) and roof:shape.
"""
import json, math, os
from collections import Counter, defaultdict

R = 6378137.0
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'data', 'raw')

# Nodes that belong ON a building frontage (a unit), rather than standing in the street.
UNIT_KEYS = ('shop', 'amenity', 'office', 'healthcare', 'craft', 'tourism', 'leisure', 'historic')
# amenity values that are street furniture, not premises
STREET_AMENITY = {
    'bench', 'bicycle_parking', 'waste_basket', 'post_box', 'bicycle_rental', 'recycling',
    'drinking_water', 'fountain', 'shelter', 'telephone', 'clock', 'parking_entrance',
    'charging_station', 'car_sharing', 'taxi', 'vending_machine', 'atm', 'parking_space',
    'motorcycle_parking', 'bbq', 'toilets', 'water_point', 'letter_box',
}
# Standalone furniture we want to place from the survey.
FURNITURE = {
    'natural=tree': 'tree',
    'highway=street_lamp': 'lamp',
    'highway=crossing': 'crossing',
    'highway=traffic_signals': 'signal',
    'highway=bus_stop': 'busstop',
    'railway=tram_stop': 'tramstop',
    'railway=subway_entrance': 'subway',
    'emergency=fire_hydrant': 'hydrant',
    'amenity=bench': 'bench',
    'amenity=bicycle_parking': 'bikepark',
    'amenity=waste_basket': 'bin',
    'amenity=post_box': 'postbox',
    'amenity=bicycle_rental': 'bikeshare',
    'amenity=recycling': 'recycling',
    'amenity=drinking_water': 'water',
    'amenity=fountain': 'fountain',
    'barrier=bollard': 'bollard',
    'man_made=utility_pole': 'pole',
    'man_made=flagpole': 'flagpole',
    'man_made=street_cabinet': 'cabinet',
    'advertising=billboard': 'billboard',
    'advertising=column': 'adcolumn',
}


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def seg_dist(px, pz, ax, az, bx, bz):
    """Distance from a point to a segment, plus the parameter along it."""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    if L2 < 1e-9:
        return math.hypot(px - ax, pz - az), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz)), t


def main():
    path = os.path.join(HERE, '..', 'data', 'toronto.json')
    city = json.load(open(path))
    o = city['meta']['origin']
    ox, oy = merc(o['lon'], o['lat'])
    k = math.cos(math.radians(o['lat']))

    def local(lon, lat):
        x, y = merc(lon, lat)
        return (x - ox) * k, -(y - oy) * k

    ext = city['meta']['extent']
    hx, hz = ext['x'] / 2 + 400, ext['z'] / 2 + 400

    nodes = json.load(open(os.path.join(RAW, 'osm_nodes.json')))['elements']
    print(f'{len(nodes)} nodes read')

    # ---- index building frontage segments into a grid --------------------------------------
    B = city['buildings']
    grid = defaultdict(list)
    G = 40.0
    for bi, b in enumerate(B):
        ring = b['r'][0]
        for i in range(len(ring)):
            ax, az = ring[i]
            bx, bz = ring[(i + 1) % len(ring)]
            if abs(ax - bx) < 1e-6 and abs(az - bz) < 1e-6:
                continue
            lo_x, hi_x = (ax, bx) if ax < bx else (bx, ax)
            lo_z, hi_z = (az, bz) if az < bz else (bz, az)
            for gx in range(int(lo_x // G), int(hi_x // G) + 1):
                for gz in range(int(lo_z // G), int(hi_z // G) + 1):
                    grid[(gx, gz)].append((bi, i, ax, az, bx, bz))

    def nearest_frontage(x, z, limit=26.0):
        best = None
        bd = limit
        gx0, gz0 = int(x // G), int(z // G)
        for gx in range(gx0 - 1, gx0 + 2):
            for gz in range(gz0 - 1, gz0 + 2):
                for (bi, si, ax, az, bx, bz) in grid.get((gx, gz), ()):
                    d, t = seg_dist(x, z, ax, az, bx, bz)
                    if d < bd:
                        bd = d
                        best = (bi, si, t, d)
        return best

    units_by_b = defaultdict(list)
    pois = []
    stats = Counter()
    skipped_outside = 0

    for n in nodes:
        t = n.get('tags') or {}
        if not t:
            continue
        x, z = local(n['lon'], n['lat'])
        if abs(x) > hx or abs(z) > hz:
            skipped_outside += 1
            continue

        # --- street furniture -------------------------------------------------------------
        kind = None
        for key in ('natural', 'highway', 'railway', 'emergency', 'barrier', 'man_made', 'advertising'):
            v = t.get(key)
            if v and f'{key}={v}' in FURNITURE:
                kind = FURNITURE[f'{key}={v}']
                break
        if kind is None and t.get('amenity') in STREET_AMENITY:
            kind = FURNITURE.get(f"amenity={t['amenity']}")
        if kind:
            rec = {'k': kind, 'x': round(x, 2), 'z': round(z, 2)}
            if t.get('name'):
                rec['n'] = t['name'][:48]
            pois.append(rec)
            stats[kind] += 1
            continue

        # --- premises: a unit on a building frontage --------------------------------------
        cat = None
        for key in UNIT_KEYS:
            if t.get(key):
                cat = (key, t[key])
                break
        if cat is None:
            continue
        hit = nearest_frontage(x, z)
        if hit is None:
            continue
        bi, si, tt, d = hit
        u = {'c': cat[0], 'v': cat[1][:28], 's': si, 't': round(tt, 3)}
        if t.get('name'):
            u['n'] = t['name'][:48]
        if t.get('brand'):
            u['b'] = t['brand'][:32]
        if t.get('addr:housenumber'):
            u['h'] = t['addr:housenumber'][:12]
        if t.get('opening_hours'):
            u['o'] = 1
        units_by_b[bi].append(u)
        stats['unit:' + cat[0]] += 1

    # ---- lift tags the building matcher dropped ---------------------------------------------
    osmb = json.load(open(os.path.join(RAW, 'osm_buildings.json')))['elements']
    poly = []
    for e in osmb:
        g = e.get('geometry')
        if not g or len(g) < 3:
            continue
        tg = e.get('tags', {})
        if not (tg.get('addr:housenumber') or tg.get('building:levels') or tg.get('roof:shape')):
            continue
        xs = [local(p['lon'], p['lat']) for p in g]
        cx = sum(p[0] for p in xs) / len(xs)
        cz = sum(p[1] for p in xs) / len(xs)
        poly.append((cx, cz, tg))
    pg = defaultdict(list)
    for i, (cx, cz, tg) in enumerate(poly):
        pg[(int(cx // 60), int(cz // 60))].append(i)

    lifted = Counter()
    for bi, b in enumerate(B):
        ring = b['r'][0]
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        best = None
        bd = 34.0
        gx0, gz0 = int(cx // 60), int(cz // 60)
        for gx in range(gx0 - 1, gx0 + 2):
            for gz in range(gz0 - 1, gz0 + 2):
                for i in pg.get((gx, gz), ()):
                    px, pz, tg = poly[i]
                    d = math.hypot(px - cx, pz - cz)
                    if d < bd:
                        bd = d
                        best = tg
        if not best:
            continue
        if best.get('addr:housenumber'):
            b['hn'] = best['addr:housenumber'][:12]
            lifted['housenumber'] += 1
        lv = best.get('building:levels')
        if lv:
            try:
                b['lv'] = max(1, min(120, int(float(lv))))
                lifted['levels'] += 1
            except ValueError:
                pass
        rs = best.get('roof:shape')
        if rs:
            b['rs'] = rs[:16]
            lifted['roof'] += 1

    for bi, us in units_by_b.items():
        us.sort(key=lambda u: (u['s'], u['t']))
        B[bi]['u'] = us[:24]

    city['pois'] = pois
    json.dump(city, open(path, 'w'), separators=(',', ':'))

    nunits = sum(len(v) for v in units_by_b.values())
    print(f'\nunits attached to frontages : {nunits} across {len(units_by_b)} buildings')
    print(f'  named units                : {sum(1 for v in units_by_b.values() for u in v if "n" in u)}')
    print(f'  with a house number        : {sum(1 for v in units_by_b.values() for u in v if "h" in u)}')
    print(f'standalone POIs              : {len(pois)}')
    print(f'  outside the extent (dropped): {skipped_outside}')
    print(f'\nlifted from building polygons: {dict(lifted)}')
    print('\ntop furniture kinds:')
    for kk, vv in stats.most_common(12):
        print(f'  {kk:<24} {vv}')
    print(f'\nwrote {path}  ({os.path.getsize(path)/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
