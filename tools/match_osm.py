#!/usr/bin/env python3
"""Attach OSM building identity to each massing footprint.

The massing dataset has accurate geometry but NO semantics -- it cannot tell a stadium from an
office tower, which is why a uniform window shader ended up on the Rogers Centre. OSM has the
semantics (type, name, material, colour, levels) but sloppier geometry. Match them and keep both.

Output: data/toronto.json gains per-building  t (lighting profile), c (facade colour), n (name).
"""
import json, math, os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'data', 'raw')
R = 6378137.0

# Lighting profiles. The whole point: a building's TYPE decides how it lights up at night.
P_NONE, P_OFFICE, P_RESI, P_RETAIL, P_PARKING, P_CIVIC = 0, 1, 2, 3, 4, 5

TYPE_PROFILE = {
    'office': P_OFFICE, 'commercial': P_OFFICE, 'government': P_OFFICE,
    'apartments': P_RESI, 'residential': P_RESI, 'hotel': P_RESI, 'house': P_RESI,
    'detached': P_RESI, 'semidetached_house': P_RESI, 'terrace': P_RESI, 'dormitory': P_RESI,
    'retail': P_RETAIL, 'supermarket': P_RETAIL, 'kiosk': P_RETAIL,
    'garage': P_PARKING, 'garages': P_PARKING, 'parking': P_PARKING, 'carport': P_PARKING,
    'church': P_CIVIC, 'cathedral': P_CIVIC, 'chapel': P_CIVIC, 'civic': P_CIVIC,
    'school': P_CIVIC, 'university': P_CIVIC, 'college': P_CIVIC, 'hospital': P_CIVIC,
    'train_station': P_CIVIC, 'museum': P_CIVIC, 'public': P_CIVIC,
    'industrial': P_NONE, 'warehouse': P_NONE, 'roof': P_NONE, 'shed': P_NONE,
    'service': P_NONE, 'greenhouse': P_NONE,
}
# Anything with these tags is an envelope, never a window grid.
NO_WINDOWS_TAGS = {'leisure': {'stadium', 'sports_centre', 'arena'},
                   'amenity': {'theatre', 'convention_centre', 'place_of_worship'},
                   'tourism': {'attraction', 'aquarium', 'museum'},
                   'building': {'stadium', 'roof', 'industrial', 'warehouse', 'shed', 'service'}}

NAMED_COLOURS = {
    'red': '#8b2f2f', 'darkred': '#5a1f1f', 'brown': '#6b4a34', 'beige': '#d8c9ad',
    'black': '#141414', 'grey': '#7d7d7d', 'gray': '#7d7d7d', 'white': '#e8e8e6',
    'silver': '#b8bcc0', 'gold': '#c9a227', 'green': '#3f6b4f', 'blue': '#3c5a8a',
    'yellow': '#c8b06a', 'orange': '#b5713a', 'tan': '#c8ab84', 'cream': '#e4dac2',
    'sandstone': '#cbb591', 'limestone': '#d5cbb4', 'concrete': '#9a9a95',
}


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def hex_to_rgb(h):
    h = h.strip()
    if not h:
        return None
    if not h.startswith('#'):
        h = NAMED_COLOURS.get(h.lower(), '')
        if not h:
            return None
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        return [round(int(h[i:i+2], 16) / 255.0, 4) for i in (0, 2, 4)]
    except ValueError:
        return None


def poly_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * z1 - x1 * z0
    return a * 0.5


def point_in(pts, x, z):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, zi = pts[i]
        xj, zj = pts[j]
        if (zi > z) != (zj > z):
            xint = (xj - xi) * (z - zi) / ((zj - zi) or 1e-12) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def main():
    city_path = os.path.join(HERE, '..', 'data', 'toronto.json')
    city = json.load(open(city_path))
    meta = city['meta']
    o = meta['origin']
    ox, oy = merc(o['lon'], o['lat'])
    k = math.cos(math.radians(o['lat']))

    def local(lon, lat):
        x, y = merc(lon, lat)
        return (x - ox) * k, -(y - oy) * k

    osm = json.load(open(os.path.join(RAW, 'osm_buildings.json')))
    feats = []
    for e in osm['elements']:
        g = e.get('geometry')
        if not g or len(g) < 3:
            continue
        t = e.get('tags', {})
        pts = [local(p['lon'], p['lat']) for p in g]
        area = abs(poly_area(pts))
        if area < 12:
            continue
        xs = [p[0] for p in pts]; zs = [p[1] for p in pts]
        feats.append({
            'pts': pts, 'area': area, 'tags': t,
            'bb': (min(xs), min(zs), max(xs), max(zs)),
        })
    print(f'{len(feats)} OSM building polygons')

    # spatial hash for the containment query
    G = 100.0
    grid = {}
    for i, f in enumerate(feats):
        x0, z0, x1, z1 = f['bb']
        for gx in range(int(x0 // G), int(x1 // G) + 1):
            for gz in range(int(z0 // G), int(z1 // G) + 1):
                grid.setdefault((gx, gz), []).append(i)

    def classify(t):
        for key, vals in NO_WINDOWS_TAGS.items():
            if t.get(key) in vals:
                return P_NONE
        b = t.get('building', 'yes')
        # OSM leaves building=construction on towers for years after they top out, and the eventual
        # use is recorded in construction=*. Treating it as an envelope put six windowless slabs up
        # to 232 m in the skyline (Canada House, and the Yonge/Queen towers) -- blank tombstones
        # next to fully lit neighbours. Resolve through construction=*, and fall through to the
        # height rule when even that is unknown. An envelope must be a POSITIVE claim.
        if b == 'construction':
            b = t.get('construction', '') or ''
        if b in TYPE_PROFILE:
            return TYPE_PROFILE[b]
        if t.get('office'):
            return P_OFFICE
        if t.get('shop'):
            return P_RETAIL
        return None            # unknown -> decide by height later

    stats = Counter()
    matched = 0
    # This pass is re-runnable: drop any profile a previous run wrote so a reclassification can
    # actually take effect and the height fallback below still sees the unmatched buildings.
    for b in city['buildings']:
        b.pop('t', None)
    for b in city['buildings']:
        ring = b['r'][0]
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        cand = grid.get((int(cx // G), int(cz // G)), ())
        best = None
        for i in cand:
            f = feats[i]
            x0, z0, x1, z1 = f['bb']
            if cx < x0 or cx > x1 or cz < z0 or cz > z1:
                continue
            if point_in(f['pts'], cx, cz):
                # prefer the SMALLEST containing polygon: the most specific description
                if best is None or f['area'] < best['area']:
                    best = f
        if best is None:
            continue
        matched += 1
        t = best['tags']
        prof = classify(t)
        if prof is not None:
            b['t'] = prof
        col = hex_to_rgb(t.get('building:colour', '')) or hex_to_rgb(t.get('colour', ''))
        if col:
            b['c'] = col
        mat = t.get('building:material')
        if mat:
            b['m'] = mat
        nm = t.get('name')
        if nm:
            b['n'] = nm
        stats[t.get('building', 'yes')] += 1

    # Height-based fallback for anything OSM did not describe.
    for b in city['buildings']:
        if 't' not in b:
            h = b['h']
            b['t'] = P_OFFICE if h >= 55 else (P_RESI if h >= 22 else P_RETAIL)
            stats['(inferred)'] += 1

    prof_counts = Counter(b['t'] for b in city['buildings'])
    names = {'0 none/envelope': P_NONE, '1 office': P_OFFICE, '2 residential': P_RESI,
             '3 retail': P_RETAIL, '4 parking': P_PARKING, '5 civic': P_CIVIC}
    print(f'matched {matched}/{len(city["buildings"])} massing footprints to an OSM polygon')
    print(f'  with a real facade colour: {sum(1 for b in city["buildings"] if "c" in b)}')
    print(f'  with a name:               {sum(1 for b in city["buildings"] if "n" in b)}')
    print('\nlighting profiles:')
    for label, p in names.items():
        print(f'  {label:<18} {prof_counts.get(p, 0)}')

    json.dump(city, open(city_path, 'w'), separators=(',', ':'))
    print(f'\nrewrote {city_path} ({os.path.getsize(city_path)/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
