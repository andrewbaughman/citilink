"""Build the versioned dashboard timetable: python scripts/prepare-gtfs.py [ZIP path or HTTPS URL]."""
import argparse, csv, datetime, hashlib, io, json, pathlib, urllib.request, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('source',nargs='?',default=str(root/'src/analytics/gtfs/source.zip'))
parser.add_argument('--allow-older',action='store_true',help='Explicitly replace the snapshot with an older feed for historical analysis')
args=parser.parse_args()
source=args.source
if source.startswith('https://'):
    with urllib.request.urlopen(source, timeout=30) as response:
        raw = response.read(16*1024*1024+1)
    if len(raw)>16*1024*1024: raise ValueError('GTFS exceeds 16 MiB')
else: raw = pathlib.Path(source).read_bytes()
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    def read(name):
        info=z.getinfo(name+'.txt')
        if info.file_size>16*1024*1024: raise ValueError('GTFS table exceeds 16 MiB')
        return list(csv.DictReader(io.TextIOWrapper(z.open(info),encoding='utf-8-sig')))
    routes={r['route_id']:r['route_short_name'] for r in read('routes')}
    trips=read('trips'); index={t['trip_id']:i for i,t in enumerate(trips)}
    stops={s['stop_id']:s['stop_name'] for s in read('stops')}
    calls={}
    def seconds(value):
        h,m,s=map(int,value.split(':')); return h*3600+m*60+s
    for s in read('stop_times'):
        t=trips[index[s['trip_id']]]
        key=json.dumps([s['stop_id'],routes[t['route_id']]],separators=(',',':'))
        calls.setdefault(key,[]).append([index[s['trip_id']],seconds(s['departure_time']),s.get('timepoint',''),int(s['stop_sequence'])])
    data=dict(source_url='https://fwcitilink.com/gtfs/#gtfs',sha256=hashlib.sha256(raw).hexdigest(),info=read('feed_info')[0],timezone=read('agency')[0]['agency_timezone'],calendar=read('calendar'),exceptions=read('calendar_dates'),stops=stops,trips=[[t['trip_id'],t['service_id'],t['direction_id']] for t in trips],calls=calls)
    if data['timezone']!='America/Indiana/Indianapolis': raise ValueError('Unexpected agency timezone')
existing=root/'src/analytics/gtfs/timetable.json'
if existing.exists() and not args.allow_older:
    old=json.loads(existing.read_text())
    def version_date(info):
        try: return datetime.datetime.strptime(info['feed_version'].removeprefix('Updated: '),'%b %d, %Y, %I:%M %p')
        except (ValueError,KeyError): return None
    before,after=version_date(old['info']),version_date(data['info'])
    if before and after and after<before: raise ValueError('Refusing an older feed revision. Use --allow-older only for an intentional historical replacement.')
(root/'src/analytics/gtfs/timetable.json').write_text(json.dumps(data,separators=(',',':'))+'\n')
(root/'src/analytics/gtfs/source.zip').write_bytes(raw)
print('Prepared',len(trips),'trips;',sum(map(len,calls.values())),'stop calls;',data['info']['feed_version'])
