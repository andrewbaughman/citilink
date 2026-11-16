import bindings from 'gtfs-realtime-bindings';
import protobuf from 'protobufjs/minimal';
import reference from './static.json';
import {array, record, num, str} from '../analytics/normalize';
import {sha256} from '../archive';

export {reference};
export type FeedKind = 'vehicle-positions' | 'service-alerts';
export const MAX_AGE_MS = {'vehicle-positions':90_000, 'service-alerts':600_000, topology:7_200_000};
export interface Snapshot {observed_at:number; body:unknown}
export interface BuiltFeed {message:bindings.transit_realtime.IFeedMessage; omitted:number; unmapped_routes:number}
const rt=bindings.transit_realtime;
function header(at:number) {return {gtfsRealtimeVersion:'2.0',incrementality:rt.FeedHeader.Incrementality.FULL_DATASET,timestamp:Math.floor(at/1000)};}
export function fresh(at:unknown,now:number,maxAge:number):at is number {
  return typeof at==='number' && Number.isSafeInteger(at) && at>0 && at<=now+5_000 && now-at<=maxAge;
}
export function referenceValid(now:number) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:reference.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=(key:string)=>parts.find(p=>p.type===key)!.value;
  const date=part('year')+part('month')+part('day');
  return reference.info.feed_start_date<=date && date<=reference.info.feed_end_date;
}
// Exact, unambiguous short-code matches only. Vendor numeric IDs are never GTFS IDs.
export function routeMap(body:unknown):Map<number,string> {
  const codes=new Map<string,string>(Object.entries(reference.routes));
  const candidates=new Map<number,Set<string>>();
  for(const ce of array(record(body).topo)) for(const item of array(record(ce).ligne)) {
    const line=record(item),id=num(line.idLigne),code=str(line.mnemo)?.trim();
    if(id===null || !Number.isSafeInteger(id) || id<=0) continue;
    const routes=candidates.get(id)??new Set<string>();
    // Unknown or conflicting records invalidate this ID instead of selecting the last one.
    routes.add(code?codes.get(code)??'':'');candidates.set(id,routes);
  }
  return new Map([...candidates].filter(([,ids])=>ids.size===1 && !ids.has('')).map(([id,ids])=>[id,[...ids][0]!]));
}
export function vehicleFeed(snapshot:Snapshot,routes:Map<number,string>):BuiltFeed {
  const entities:bindings.transit_realtime.IFeedEntity[]=[],seen=new Set<number>();
  let omitted=0,unmapped=0;
  const rows=array(record(snapshot.body).vehicule).map(record);
  const counts=new Map<number,number>();
  for(const v of rows){const id=num(v.id);if(id!==null)counts.set(id,(counts.get(id)??0)+1);}
  for(const v of rows) {
    const id=num(v.id);
    if(v.estAffichable!==true || id===null || !Number.isSafeInteger(id) || id<=0 || counts.get(id)!==1 || seen.has(id)) {omitted++;continue;}
    const loc=v.localisation?record(v.localisation):{},drive=v.conduite?record(v.conduite):{};
    const lat=num(loc.lat),lon=num(loc.lng),bearing=num(loc.cap);
    if(lat===null || lon===null || Math.abs(lat)>90 || Math.abs(lon)>180 || (lat===0 && lon===0)) {omitted++;continue;}
    seen.add(id);
    const routeId=routes.get(num(drive.idLigne)??-1);
    if(!routeId)unmapped++;
    const position:bindings.transit_realtime.IPosition={latitude:lat,longitude:lon};
    if(bearing!==null && bearing>=0 && bearing<360)position.bearing=bearing;
    const label=str(v.numeroEquipement)?.trim();
    const vehicle:bindings.transit_realtime.IVehiclePosition={position,vehicle:{id:String(id),...(label?{label}:{})}};
    if(routeId)vehicle.trip={routeId};
    // No source GPS measurement timestamp, verified speed unit, trip identity or next-stop ID.
    entities.push({id:`vehicle-${id}`,vehicle});
  }
  entities.sort((a,b)=>a.id.localeCompare(b.id));
  return {message:{header:header(snapshot.observed_at),entity:entities},omitted,unmapped_routes:unmapped};
}
export async function alertFeed(snapshot:Snapshot,routes:Map<number,string>):Promise<BuiltFeed> {
  const entities=new Map<string,bindings.transit_realtime.IFeedEntity>();
  let omitted=0,unmapped=0;
  for(const item of array(snapshot.body)) {
    const message=record(item),text=str(message.message)?.trim();
    if(!text){omitted++;continue;}
    const lines=array(message.ligne),selectors:bindings.transit_realtime.IEntitySelector[]=[];
    for(const line of lines) {
      const routeId=routes.get(num(record(line).idLigne)??-1);
      if(routeId)selectors.push({agencyId:reference.agency_id,routeId});else unmapped++;
    }
    // A route-specific message with no known route must never become an agency-wide alert.
    if(lines.length && !selectors.length){omitted++;continue;}
    if(!lines.length)selectors.push({agencyId:reference.agency_id});
    const unique=[...new Map(selectors.map(s=>[s.routeId??'',s])).values()].sort((a,b)=>(a.routeId??'').localeCompare(b.routeId??''));
    const id='alert-'+await sha256(JSON.stringify([text,unique]));
    entities.set(id,{id,alert:{informedEntity:unique,cause:rt.Alert.Cause.UNKNOWN_CAUSE,effect:rt.Alert.Effect.UNKNOWN_EFFECT,
      headerText:{translation:[{text,language:'en'}]},descriptionText:{translation:[{text,language:'en'}]}}});
  }
  return {message:{header:header(snapshot.observed_at),entity:[...entities.values()].sort((a,b)=>a.id.localeCompare(b.id))},omitted,unmapped_routes:unmapped};
}
export function encode(message:bindings.transit_realtime.IFeedMessage):Uint8Array {
  const error=rt.FeedMessage.verify(message);if(error)throw Error('Invalid GTFS Realtime: '+error);
  // Use the Uint8Array writer explicitly. BufferWriter uses Node buffer internals
  // whose utf8Write length semantics differ in the Workers runtime.
  return rt.FeedMessage.encode(rt.FeedMessage.create(message),new protobuf.Writer()).finish();
}
