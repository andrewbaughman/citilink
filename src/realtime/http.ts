import {readBody, sha256} from '../archive';
import {alertFeed, encode, fresh, MAX_AGE_MS, reference, referenceValid, routeMap, vehicleFeed, type FeedKind, type Snapshot} from './feeds';

interface Source {enabled?:boolean; last_object?:string; last_observed_at?:number}
export interface RealtimeStatus {datasets:Record<string,Source>}
export interface RealtimeBucket {get(key:string):Promise<{size:number;body:ReadableStream<Uint8Array>}|null>}
const paths:Record<string,FeedKind>={'/gtfs-rt/vehicle-positions.pb':'vehicle-positions','/gtfs-rt/service-alerts.pb':'service-alerts'};
export function isRealtimePath(path:string) {return path.startsWith('/gtfs-rt/');}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}});
async function snapshot(bucket:RealtimeBucket,source:Source|undefined,now:number,age:number):Promise<Snapshot> {
  if(!source?.enabled || !source.last_object || !fresh(source.last_observed_at,now,age))throw Error('source_unavailable_or_stale');
  const object=await bucket.get(source.last_object);
  if(!object || object.size>8*1024*1024)throw Error('source_unavailable_or_oversize');
  const data=await readBody(new Response(object.body));
  if(!data.complete)throw Error('source_incomplete');
  return {observed_at:source.last_observed_at,body:JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(data.bytes))};
}
export async function realtimeResponse(request:Request,bucket:RealtimeBucket,status:RealtimeStatus,now=Date.now()):Promise<Response> {
  const url=new URL(request.url),kind=paths[url.pathname];
  if(url.pathname==='/gtfs-rt/status.json') {
    const topology=fresh(status.datasets.full_topology?.last_observed_at,now,MAX_AGE_MS.topology) && status.datasets.full_topology?.enabled===true;
    const valid=referenceValid(now);
    const feeds=Object.fromEntries((Object.values(paths)).map(k=>{
      const d=status.datasets[k==='vehicle-positions'?'vehicles':'service_messages'];
      return [k,{ready:valid && topology && d?.enabled===true && fresh(d.last_observed_at,now,MAX_AGE_MS[k]),observed_at:d?.last_observed_at??null,max_age_seconds:MAX_AGE_MS[k]/1000}];
    }));
    return json({reference,reference_valid:valid,topology_fresh:topology,feeds,trip_updates:{supported:false,reason:'No verified GTFS trip identity or dated predictions in the public API.'},limitations:['GPS measurement time unavailable; source retrieval time is used only in the feed header.','Route matches use exact GTFS short codes; unmapped vehicles have no trip descriptor.','Fresh collection cannot establish the age of individual source GPS positions.']});
  }
  if(!kind)return json({error:'not_found'},404);
  try {
    if(!referenceValid(now))throw Error('gtfs_reference_expired');
    const [topology,source]=await Promise.all([
      snapshot(bucket,status.datasets.full_topology,now,MAX_AGE_MS.topology),
      snapshot(bucket,status.datasets[kind==='vehicle-positions'?'vehicles':'service_messages'],now,MAX_AGE_MS[kind]),
    ]);
    const routes=routeMap(topology.body);
    if(!routes.size)throw Error('route_reference_unavailable');
    const built=kind==='vehicle-positions'?vehicleFeed(source,routes):await alertFeed(source,routes);
    const bytes=encode(built.message),etag='"'+await sha256(bytes)+'"';
    const headers={'Content-Type':'application/x-protobuf','Cache-Control':'no-store','ETag':etag,
      'Last-Modified':new Date(source.observed_at).toUTCString(),'Access-Control-Allow-Origin':'*',
      'Access-Control-Expose-Headers':'ETag, Last-Modified, X-GTFS-RT-Omitted, X-GTFS-RT-Unmapped-Routes',
      'X-Content-Type-Options':'nosniff','X-GTFS-RT-Omitted':String(built.omitted),'X-GTFS-RT-Unmapped-Routes':String(built.unmapped_routes)};
    if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers});
    return new Response(request.method==='HEAD'?null:bytes as BodyInit,{headers});
  } catch(error) {
    // Public diagnostics contain neither archive keys nor upstream response bodies.
    const known=error instanceof Error && ['source_unavailable_or_stale','gtfs_reference_expired','route_reference_unavailable'].includes(error.message)?error.message:'feed_unavailable';
    return json({error:known},503);
  }
}
