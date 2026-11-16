import {test} from 'node:test';
import {URL} from 'node:url';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import bindings from 'gtfs-realtime-bindings';
import {alertFeed,encode,fresh,referenceValid,routeMap,vehicleFeed} from '../src/realtime/feeds';
import {realtimeResponse,type RealtimeStatus,type RealtimeBucket} from '../src/realtime/http';
const read=(name:string)=>JSON.parse(readFileSync(new URL('../api-discovery/raw/'+name+'.json',import.meta.url),'utf8'));
const now=Date.UTC(2026,10,16,15);
const routes=routeMap(read('topo'));
const rt=bindings.transit_realtime;
test('exact GTFS route mappings reject renamed and ambiguous vendor IDs',()=>{
 assert.equal(routes.get(13753),'11');assert.equal(routes.get(13756),undefined);
 assert.equal(routeMap({topo:[{ligne:[{idLigne:1,mnemo:'1N'},{idLigne:1,mnemo:'1W'}]}]}).size,0);
 assert.equal(routeMap({topo:[{ligne:[{idLigne:1,mnemo:'1N'},{idLigne:1,mnemo:'unknown'}]}]}).size,0);
});
test('vehicle protobuf preserves IDs and coordinates without inventing trip, speed, occupancy or GPS time',()=>{
 const body=read('topo_vehicules');
 const built=vehicleFeed({observed_at:now,body},routes);
 const decoded=rt.FeedMessage.decode(encode(built.message));
 assert.equal(decoded.header.gtfsRealtimeVersion,'2.0');assert.equal(Number(decoded.header.timestamp),now/1000);
 assert.equal(decoded.header.incrementality,0);
 assert.equal(decoded.entity.length,body.vehicule.filter((v:any)=>v.estAffichable).length);
 for(const e of decoded.entity) {
  const v=body.vehicule.find((v:any)=>String(v.id)===e.vehicle!.vehicle!.id);
  assert.equal(e.id,'vehicle-'+v.id);assert.equal(e.vehicle!.vehicle!.label,v.numeroEquipement);
  assert(Math.abs(e.vehicle!.position!.latitude-v.localisation.lat)<0.00001);
  for(const key of ['timestamp','occupancyPercentage','currentStopSequence','stopId']) assert(!Object.hasOwn(e.vehicle!,key));
  assert(!Object.hasOwn(e.vehicle!.position!,'speed'));
  if(e.vehicle!.trip)assert(!Object.hasOwn(e.vehicle!.trip,'tripId'));
 }
 const hidden={id:1,estAffichable:false,localisation:{lat:41,lng:-85}};
 const invalid={...hidden,id:2,estAffichable:true,localisation:{lat:91,lng:-85}};
 const dup={...hidden,id:3,estAffichable:true};
 assert.equal(vehicleFeed({observed_at:now,body:{vehicule:[hidden,invalid,dup,dup]}},routes).message.entity!.length,0);
});
test('alerts have stable content IDs, route selectors and removal via FULL_DATASET',async()=>{
 const messages=read('iv_message');
 const a=await alertFeed({observed_at:now,body:messages},routes);
 const b=await alertFeed({observed_at:now+1000,body:[...messages].reverse()},routes);
 assert.deepEqual(a.message.entity!.map(e=>e.id),b.message.entity!.map(e=>e.id));
 const decoded=rt.FeedMessage.decode(encode(a.message));
 assert(decoded.entity.length>0);
 for(const e of decoded.entity) {
  assert(e.alert!.headerText!.translation![0]!.text);
  assert.equal(e.alert!.informedEntity![0]!.routeId,'42');
  assert.equal(e.alert!.activePeriod!.length,0);
 }
 const agency=await alertFeed({observed_at:now,body:[{ligne:[],message:'System notice'}]},routes);
 assert.equal(agency.message.entity![0]!.alert!.informedEntity![0]!.agencyId,'50044');
 assert.equal((await alertFeed({observed_at:now,body:[]},routes)).message.entity!.length,0);
 assert.equal((await alertFeed({observed_at:now,body:[{ligne:[{idLigne:999}],message:'Unknown route'}]},routes)).message.entity!.length,0);
});
test('freshness and GTFS validity reject stale, missing, future and expired inputs',()=>{
 assert(fresh(now-90000,now,90000));assert(!fresh(now-90001,now,90000));
 assert(!fresh(undefined,now,90000));assert(!fresh(now+5001,now,90000));
 assert(referenceValid(now));assert(!referenceValid(Date.UTC(2027,0,2)));
});
function rig() {
 const sources=new Map<string,unknown>([['topology',read('topo')],['vehicles',read('topo_vehicules')],['alerts',read('iv_message')]]);
 const status:RealtimeStatus={datasets:{full_topology:{enabled:true,last_object:'topology',last_observed_at:now},vehicles:{enabled:true,last_object:'vehicles',last_observed_at:now},service_messages:{enabled:true,last_object:'alerts',last_observed_at:now}}};
 const bucket:RealtimeBucket={get:async key=>{
  if(!sources.has(key))return null;
  const body=JSON.stringify(sources.get(key));return {size:body.length,body:new Response(body).body!};
 }};
 const get=(path:string,init?:RequestInit)=>realtimeResponse(new Request('https://test'+path,init),bucket,status,now);
 return {status,sources,get};
}
test('HTTP feeds decode, support ETags and HEAD, and fail closed without exposing archive metadata',async()=>{
 const r=rig();
 const response=await r.get('/gtfs-rt/vehicle-positions.pb');assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'application/x-protobuf');
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),'*');
 assert(rt.FeedMessage.decode(new Uint8Array(await response.arrayBuffer())).entity.length);
 assert.equal((await r.get('/gtfs-rt/vehicle-positions.pb',{headers:{'if-none-match':response.headers.get('etag')!}})).status,304);
 assert.equal((await r.get('/gtfs-rt/vehicle-positions.pb',{method:'HEAD'})).body,null);
 assert.equal((await r.get('/gtfs-rt/service-alerts.pb')).status,200);
 r.status.datasets.vehicles!.last_observed_at=now-90001;
 assert.equal((await r.get('/gtfs-rt/vehicle-positions.pb')).status,503);
 const state=await (await r.get('/gtfs-rt/status.json')).json() as any;
 assert.equal(state.feeds['vehicle-positions'].ready,false);assert(!JSON.stringify(state).includes('last_object'));
 assert.equal(state.trip_updates.supported,false);
 r.status.datasets.full_topology!.last_observed_at=now-7200001;
 assert.equal((await r.get('/gtfs-rt/service-alerts.pb')).status,503);
});
test('empty successful datasets are valid feeds; missing and malformed archive objects are unavailable',async()=>{
 const r=rig();r.sources.set('vehicles',{vehicule:[]});
 const response=await r.get('/gtfs-rt/vehicle-positions.pb');assert.equal(response.status,200);
 assert.equal(rt.FeedMessage.decode(new Uint8Array(await response.arrayBuffer())).entity.length,0);
 r.sources.delete('vehicles');assert.equal((await r.get('/gtfs-rt/vehicle-positions.pb')).status,503);
 r.sources.set('vehicles',{oops:[]});assert.equal((await r.get('/gtfs-rt/vehicle-positions.pb')).status,503);
 r.status.datasets.service_messages!.enabled=false;assert.equal((await r.get('/gtfs-rt/service-alerts.pb')).status,503);
 assert.equal((await r.get('/gtfs-rt/nope')).status,404);
});
