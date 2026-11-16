"""Generate the realtime route reference without replacing the historical analytics timetable.
Usage: python scripts/prepare-realtime-gtfs.py <GTFS ZIP> [source URL]
"""
import csv, hashlib, io, json, pathlib, sys, zipfile
raw = pathlib.Path(sys.argv[1]).read_bytes()
if len(raw) > 16 * 1024 * 1024: raise ValueError('GTFS exceeds 16 MiB')
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    def table(name):
        if z.getinfo(name + '.txt').file_size > 16 * 1024 * 1024: raise ValueError('Table too large')
        return list(csv.DictReader(io.TextIOWrapper(z.open(name + '.txt'), encoding='utf-8-sig')))
    agencies, routes, info = table('agency'), table('routes'), table('feed_info')[0]
    if len(agencies) != 1: raise ValueError('Expected one agency')
    mapping = {}
    for r in routes:
        code = r['route_short_name'].strip()
        if not code or code in mapping: raise ValueError('Missing or duplicate route short name')
        mapping[code] = r['route_id']
    data = dict(sha256=hashlib.sha256(raw).hexdigest(), source_url=sys.argv[2] if len(sys.argv)>2 else 'https://fwcitilink.com/gtfs/#gtfs',
                agency_id=agencies[0]['agency_id'], timezone=agencies[0]['agency_timezone'], info=info, routes=mapping)
path = pathlib.Path(__file__).resolve().parents[1] / 'src/realtime/static.json'
path.write_text(json.dumps(data, indent=2) + '\n')
print('Prepared realtime reference:', len(mapping), 'routes;', info['feed_version'])
