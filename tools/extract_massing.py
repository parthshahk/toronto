#!/usr/bin/env python3
"""Clip Toronto's 3D Massing shapefile to a bbox and emit local-metric building footprints.

No dependencies: parses ESRI PolygonZ (.shp) and dBASE (.dbf) directly.

Geometry arrives in EPSG:3857 (Web Mercator, metres). Mercator inflates horizontal distance by
1/cos(lat) -- 38% at Toronto's latitude -- so coordinates are scaled by cos(lat0) to become TRUE
metres. Without that, every building is a third too wide for its height.

World axes: X = east, Y = up, Z = south (right-handed, matching the engine's yaw convention).
"""
import json, math, os, struct, sys

R = 6378137.0
BASE = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw', 'massing2025',
                    '3DMassingShapefile_2025_WGS84')

# Financial District + Entertainment District + King West + Harbourfront + The Well
BBOX = dict(west=-79.4080, east=-79.3690, south=43.6340, north=43.6540)


def merc(lon, lat):
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def read_dbf_numeric(path, wanted_indices, field_names):
    """Read only the requested record indices; return {index: {field: value}}."""
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
            name = fd[0:11].split(b'\0')[0].decode('latin-1')
            flen = fd[16]
            fields.append((name, off, flen))
            off += flen
        want = {n: (o, l) for n, o, l in fields if n in field_names}
        for idx in sorted(wanted_indices):
            if idx >= nrec:
                continue
            f.seek(hlen + idx * rlen)
            rec = f.read(rlen)
            d = {}
            for name, (o, l) in want.items():
                raw = rec[1 + o:1 + o + l].decode('latin-1').strip()
                try:
                    d[name] = float(raw)
                except ValueError:
                    d[name] = raw
            out[idx] = d
    return out


def main():
    x0, y0 = merc(BBOX['west'], BBOX['south'])
    x1, y1 = merc(BBOX['east'], BBOX['north'])
    lat0 = (BBOX['south'] + BBOX['north']) / 2
    lon0 = (BBOX['west'] + BBOX['east']) / 2
    ox, oy = merc(lon0, lat0)
    k = math.cos(math.radians(lat0))          # Mercator -> true metres

    print(f'bbox merc x {x0:.0f}..{x1:.0f}  y {y0:.0f}..{y1:.0f}')
    print(f'origin lon/lat {lon0:.5f},{lat0:.5f}  scale k={k:.5f}')
    print(f'area {(x1-x0)*k:.0f} m E-W  x  {(y1-y0)*k:.0f} m N-S')

    print('reading .shp ...', flush=True)
    with open(BASE + '.shp', 'rb') as f:
        buf = f.read()
    print(f'  {len(buf)/1e6:.0f} MB in memory', flush=True)

    pos, rec_i, hits = 100, 0, []
    n = len(buf)
    while pos < n:
        # record header: number (BE), content length in 16-bit words (BE)
        clen = struct.unpack_from('>i', buf, pos + 4)[0] * 2
        cstart = pos + 8
        shp_type = struct.unpack_from('<i', buf, cstart)[0]
        if shp_type in (5, 15, 25):            # Polygon / PolygonZ / PolygonM
            bx0, by0, bx1, by1 = struct.unpack_from('<4d', buf, cstart + 4)
            if not (bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1):
                nparts, npts = struct.unpack_from('<2i', buf, cstart + 36)
                parts = struct.unpack_from(f'<{nparts}i', buf, cstart + 44)
                pofs = cstart + 44 + nparts * 4
                coords = struct.unpack_from(f'<{npts*2}d', buf, pofs)
                rings = []
                for pi in range(nparts):
                    a = parts[pi]
                    b = parts[pi + 1] if pi + 1 < nparts else npts
                    ring = [(round((coords[j*2] - ox) * k, 3),
                             round((coords[j*2+1] - oy) * k, 3)) for j in range(a, b)]
                    if len(ring) >= 4:
                        rings.append(ring)
                if rings:
                    hits.append((rec_i, rings))
        pos = cstart + clen
        rec_i += 1
        if rec_i % 100000 == 0:
            print(f'  scanned {rec_i} records, {len(hits)} in bbox', flush=True)

    print(f'scanned {rec_i} records total -> {len(hits)} in bbox', flush=True)

    attrs = read_dbf_numeric(BASE + '.dbf', {i for i, _ in hits},
                             {'AVG_HEIGHT', 'MAX_HEIGHT', 'HEIGHT_MSL', 'SURF_ELEV', 'HEIGHT_SRC'})

    buildings, skipped = [], 0
    elevs = []
    for idx, rings in hits:
        a = attrs.get(idx, {})
        h = a.get('AVG_HEIGHT') or 0.0
        mx = a.get('MAX_HEIGHT') or 0.0
        h = max(h, mx)
        if not h or h <= 0.5:
            skipped += 1
            continue
        elev = a.get('SURF_ELEV') or 0.0
        elevs.append(elev)
        buildings.append({
            'h': round(h, 2),
            'e': round(elev, 2),
            'src': a.get('HEIGHT_SRC', ''),
            'rings': [[[p[0], p[1]] for p in r] for r in rings],
        })

    base_elev = min(elevs) if elevs else 0.0
    for b in buildings:
        b['e'] = round(b['e'] - base_elev, 2)      # ground elevation relative to lowest point

    out = {
        'origin': {'lon': lon0, 'lat': lat0},
        'bbox': BBOX,
        'scale_k': k,
        'base_elev_msl': round(base_elev, 2),
        'extent_m': {'x': round((x1 - x0) * k, 1), 'z': round((y1 - y0) * k, 1)},
        'count': len(buildings),
        'buildings': buildings,
    }
    dst = os.path.join(os.path.dirname(__file__), '..', 'data', 'toronto_buildings.json')
    with open(dst, 'w') as f:
        json.dump(out, f, separators=(',', ':'))

    hs = sorted(b['h'] for b in buildings)
    print(f'\nkept {len(buildings)} buildings ({skipped} skipped for zero height)')
    print(f'  height  median {hs[len(hs)//2]:.1f} m   p90 {hs[int(len(hs)*0.9)]:.1f} m   max {hs[-1]:.1f} m')
    print(f'  ground elevation range {min(b["e"] for b in buildings):.1f}..{max(b["e"] for b in buildings):.1f} m')
    print(f'  total rings {sum(len(b["rings"]) for b in buildings)}')
    print(f'  wrote {dst} ({os.path.getsize(dst)/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
