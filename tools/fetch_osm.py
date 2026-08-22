#!/usr/bin/env python3
"""Fetch the OSM layers for the city extent, in tiles.

A single Overpass query over 252 km2 either times out or returns a few hundred MB. This walks a
grid of sub-boxes, retries each, and merges the elements de-duplicated by (type, id) -- features
straddling a sub-box boundary come back from both and must not be doubled.
"""
import json, os, sys, time, urllib.parse, urllib.request

# Several mirrors, rotated on failure. overpass-api.de rate-limits hard on a 12-box walk and a
# single bad stretch used to lose the whole run.
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
CACHE = 'data/raw/_fetch_cache'
BBOX = dict(west=-79.4930, east=-79.2780, south=43.6060, north=43.7370)

LAYERS = {
    'osm_infra': """
      way["highway"]({bb}); way["railway"]({bb}); way["natural"="water"]({bb});
      way["waterway"]({bb}); way["aeroway"]({bb}); way["barrier"]({bb});
      way["leisure"~"park|garden|pitch|playground|marina|golf_course|nature_reserve"]({bb});
      way["landuse"]({bb}); way["natural"~"beach|sand|wood|scrub|grassland|wetland"]({bb});
      way["man_made"~"pier|quay|breakwater|groyne|bridge"]({bb});
      way["amenity"~"parking|ferry_terminal"]({bb});
      relation["natural"="water"]({bb}); relation["leisure"="park"]({bb});
      relation["aeroway"="aerodrome"]({bb});
    """,
    'osm_buildings': """
      way["building"]({bb}); relation["building"]({bb});
    """,
    'osm_nodes': """
      node["shop"]({bb}); node["amenity"]({bb}); node["office"]({bb}); node["craft"]({bb});
      node["healthcare"]({bb}); node["tourism"]({bb}); node["historic"]({bb}); node["leisure"]({bb});
      node["entrance"]({bb}); node["addr:housenumber"]({bb}); node["advertising"]({bb});
      node["highway"~"crossing|street_lamp|traffic_signals|bus_stop|stop|give_way|turning_circle"]({bb});
      node["railway"~"tram_stop|subway_entrance|station|halt|level_crossing"]({bb});
      node["natural"="tree"]({bb}); node["emergency"="fire_hydrant"]({bb});
      node["man_made"~"surveillance|utility_pole|flagpole|street_cabinet"]({bb});
      node["barrier"~"bollard|gate|cycle_barrier"]({bb}); node["public_transport"]({bb});
    """,
}


# Overpass returns 406 Not Acceptable to urllib's default User-Agent. Identify properly, as the
# Overpass usage policy asks for anyway.
UA = 'toronto-citybuilder/1.0 (+https://github.com/parthshahk/toronto)'


def fetch(body, tries=10):
    data = urllib.parse.urlencode({'data': body}).encode()
    last = None
    for a in range(tries):
        url = ENDPOINTS[a % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=900) as r:
                d = json.loads(r.read().decode())
            # Overpass signals overload and timeouts as a VALID 200 carrying an empty result set,
            # sometimes with a 'remark'. That is indistinguishable from success unless you look:
            # 9 of 12 sub-boxes came back empty this way and the merged extract silently lost 96%
            # of its aeroway and 73% of its railway. Treat both as failures worth retrying.
            if d.get('remark'):
                raise RuntimeError('overpass remark: ' + str(d['remark'])[:120])
            if not d.get('elements'):
                raise RuntimeError('empty result set (overload, or a genuinely empty box)')
            return d
        except Exception as e:
            last = e
            wait = min(300, 25 * (a + 1))
            host = url.split('/')[2]
            print(f'      {host} failed ({type(e).__name__}); retry {a+1}/{tries} in {wait}s', flush=True)
            time.sleep(wait)
    if 'empty result set' in str(last):
        print('      every endpoint returned empty; accepting as genuinely empty', flush=True)
        return {'elements': []}
    raise RuntimeError(f'all endpoints failed: {last}')


def main():
    which = sys.argv[1:] or list(LAYERS)
    nx, nz = 4, 3
    for name in which:
        q = LAYERS[name]
        out, seen = [], set()
        print(f'{name}: {nx*nz} sub-boxes', flush=True)
        for i in range(nx):
            for j in range(nz):
                w = BBOX['west'] + (BBOX['east'] - BBOX['west']) * i / nx
                e = BBOX['west'] + (BBOX['east'] - BBOX['west']) * (i + 1) / nx
                s = BBOX['south'] + (BBOX['north'] - BBOX['south']) * j / nz
                n = BBOX['south'] + (BBOX['north'] - BBOX['south']) * (j + 1) / nz
                bb = f'{s},{w},{n},{e}'
                geom = 'out body;' if name == 'osm_nodes' else 'out body geom;'
                body = f'[out:json][timeout:600];({q.format(bb=bb)});{geom}'
                t0 = time.time()
                os.makedirs(CACHE, exist_ok=True)
                cf = f'{CACHE}/{name}_{i}_{j}.json'
                if os.path.exists(cf):
                    d = json.load(open(cf))
                    print(f'  [{i},{j}] cached', flush=True)
                else:
                    d = fetch(body)
                    json.dump(d, open(cf, 'w'))
                    time.sleep(12)  # be a good citizen; we were 429'd at 4 s
                new = 0
                for el in d['elements']:
                    k = (el['type'], el['id'])
                    if k in seen:
                        continue
                    seen.add(k)
                    out.append(el)
                    new += 1
                print(f'  [{i},{j}] {new:7d} new  ({len(out):8d} total, {time.time()-t0:5.1f}s)', flush=True)
        path = f'data/raw/{name}.json'
        json.dump({'elements': out}, open(path, 'w'))
        print(f'  -> {path}  {len(out)} elements\n', flush=True)


if __name__ == '__main__':
    main()
