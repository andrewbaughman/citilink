import { test } from 'node:test';
import bindings from 'gtfs-realtime-bindings';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';

const token='local-integration-test-secret';
const auth={Authorization:'Bearer '+token};
const files={
 '/topo/vehicules':'topo_vehicules.json', '/topo/refresh':'topo_refresh.json',
 '/iv/message':'iv_message.json', '/config/version':'config_version.json', '/topo':'topo.json',
};
test('compiled Worker runs against real local SQLite Durable Object and R2 bindings',async t=>{
 const upstreamCalls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:'citilink-history', modules:true, scriptPath:'dist/index.js', compatibilityDate:'2026-10-01',
  durableObjects:{COORDINATOR:{className:'Collector',useSQLite:true}},r2Buckets:['ARCHIVE'],
  bindings:{STATUS_TOKEN:token},
  outboundService:async request=>{
   const url=new URL(request.url);assert.equal(url.hostname,'swiv.citilink.cadavl.com');
   const endpoint=url.pathname.split('/restWS')[1];if(endpoint.startsWith('/horaires/pta/'))files[endpoint]='horaires_pta_273438.json';assert(endpoint in files,'unexpected endpoint '+endpoint);
   upstreamCalls.push(url.href);
   return new MFResponse(readFileSync(new URL('../api-discovery/raw/'+files[endpoint],import.meta.url)),{headers:{'Content-Type':'application/octet-stream'}});
  },
 }));
 t.after(()=>mf.dispose());
 assert.equal((await mf.dispatchFetch('https://collector.test/gtfs-rt/vehicle-positions.pb')).status,503);
 const before=await mf.dispatchFetch('https://collector.test/healthz');assert.equal(before.status,503);
 assert.equal((await mf.dispatchFetch('https://collector.test/')).status,401);
 const ns=await mf.getDurableObjectNamespace('COORDINATOR');
 const coordinator=ns.get(ns.idFromName('citilink-global-v1'));
 const slot=Math.floor(Date.now()/60000)*60000;
 const result=await coordinator.tick(slot);assert.equal(result.status,'finished');assert(upstreamCalls.length>=3);
 const statusResponse=await mf.dispatchFetch('https://collector.test/api/status',{headers:auth});assert.equal(statusResponse.status,200);
 const status=await statusResponse.json();assert(status.datasets.vehicles.last_success_slot);assert.equal(status.roster_count,751);assert.equal(status.datasets.vehicles.cadence_seconds,30);assert(status.next_alarm_at>Date.now()-1000);
 const manifestResponse=await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(status.last_manifest),{headers:auth});
 assert.equal(manifestResponse.status,200);assert.equal(manifestResponse.headers.get('content-type'),'application/json');
 const manifest=await manifestResponse.json();assert(manifest.attempts.length>=3);
 for(const a of manifest.attempts){
  assert(a.object_key.endsWith('.json'));assert.equal(a.storage_representation,'upstream_json');assert.equal(a.ok,true);
  const response=await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(a.object_key),{headers:auth});
  assert.equal(response.status,200);
  const source=readFileSync(new URL('../api-discovery/raw/'+files[new URL(a.url).pathname.split('/restWS')[1]],import.meta.url));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),source);
 }
 const feedCalls=upstreamCalls.length;
 for(const path of ['vehicle-positions','service-alerts']) {
  const response=await mf.dispatchFetch('https://collector.test/gtfs-rt/'+path+'.pb');
  const source=status.datasets[path==='vehicle-positions'?'vehicles':'service_messages'];
  // Message collection is due only in its configured five-minute phase.
  if(!source.last_observed_at){assert.equal(response.status,503);continue;}
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('content-type'),'application/x-protobuf');
  const feed=bindings.transit_realtime.FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
  assert.equal(feed.header.gtfsRealtimeVersion,'2.0');assert.equal(feed.header.incrementality,0);
  assert.equal(Number(feed.header.timestamp),Math.floor(source.last_observed_at/1000));
  const head=await mf.dispatchFetch('https://collector.test/gtfs-rt/'+path+'.pb',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
 }
 const publicStatus=await (await mf.dispatchFetch('https://collector.test/gtfs-rt/status.json')).json();
 assert.equal(publicStatus.trip_updates.supported,false);assert(!JSON.stringify(publicStatus).includes('last_object'));
 assert.equal(upstreamCalls.length,feedCalls,'Public feeds must not poll Citilink');
 const count=upstreamCalls.length;assert.equal((await coordinator.tick(slot)).status,'duplicate');assert.equal(upstreamCalls.length,count);
 const health=await mf.dispatchFetch('https://collector.test/healthz');assert.equal(health.status,status.healthy?200:503);
 const minimal=await health.json();assert(!('roster' in minimal));assert(!('last_manifest' in minimal));
 const basic={'Authorization':'Basic '+Buffer.from('citilink:'+token).toString('base64')};
 const page=await mf.dispatchFetch('https://collector.test/',{headers:basic});assert.equal(page.status,200);assert((await page.text()).includes('Request budget'));
 assert.equal((await mf.dispatchFetch('https://collector.test/api/archive?key=raw/../secrets.json',{headers:auth})).status,400);
 assert.equal((await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(status.last_manifest))).status,401);
 assert.equal((await mf.dispatchFetch('https://collector.test/tick',{method:'POST',headers:auth})).status,405);
});

// Exercise both feeds on every run, independently of collector scheduling and wall-clock dates.
test('bundled realtime HTTP handlers encode alerts and vehicles in the Workers runtime',async t=>{
 const {build}=await import('esbuild');
 const now=Date.UTC(2026,10,16,15);
 const compiled=await build({
  stdin:{contents:`import {realtimeResponse} from './src/realtime/http';
   export default {fetch(request,env){return realtimeResponse(request,env.ARCHIVE,env.SOURCE_STATUS,${now});}};`,resolveDir:process.cwd()},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',
 });
 const source=(key)=>({enabled:true,last_object:key,last_observed_at:now});
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:'realtime-regression',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-01',r2Buckets:['ARCHIVE'],
  bindings:{SOURCE_STATUS:{datasets:{full_topology:source('topology'),vehicles:source('vehicles'),service_messages:source('messages')}}},
  outboundService:()=>{throw Error('Feed handlers must not access the network');},
 }));
 t.after(()=>mf.dispose());
 const bucket=await mf.getR2Bucket('ARCHIVE');
 const raw=(name)=>readFileSync(new URL('../api-discovery/raw/'+name+'.json',import.meta.url),'utf8');
 await bucket.put('topology',raw('topo'));
 await bucket.put('vehicles',raw('topo_vehicules'));
 const messages=JSON.parse(raw('iv_message'));
 // Cover varying string byte lengths, including multibyte text and strings > protobuf's buffer threshold.
 const unicode='Citilink – détour 🚌 '.repeat(50);
 messages.push({ligne:[],message:unicode});
 await bucket.put('messages',JSON.stringify(messages));
 for(const path of ['vehicle-positions','service-alerts']) {
  const response=await mf.dispatchFetch('https://feeds.test/gtfs-rt/'+path+'.pb');
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('content-type'),'application/x-protobuf');
  const feed=bindings.transit_realtime.FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
  assert(feed.entity.length>0);assert.equal(Number(feed.header.timestamp),now/1000);
  if(path==='service-alerts') {
   const texts=feed.entity.map(e=>e.alert.headerText.translation[0].text);
   assert(texts.includes('Route 4P diverted. Stop Broyles W corner will not be served.'));
   assert(texts.includes(unicode.trim()));
  }
 }
 await bucket.put('messages','[]');
 const empty=await mf.dispatchFetch('https://feeds.test/gtfs-rt/service-alerts.pb');
 assert.equal(empty.status,200);
 assert.equal(bindings.transit_realtime.FeedMessage.decode(new Uint8Array(await empty.arrayBuffer())).entity.length,0);
});
