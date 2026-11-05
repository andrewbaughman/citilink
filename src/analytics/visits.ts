import {dateRange} from './catalog';
import {readJson,type ArchiveReader} from './importer';
import {array,record,num,str} from './normalize';

export const METHOD='proximity-v1';
export interface Point {latitude:number;longitude:number}
export interface Vehicle extends Point {
  observed_at:number;vehicle_id:number;route_id:number;destination_raw:string|null;
  heading_raw:number|null;is_visible:number|null;source_key:string;raw_json:string;
}
export interface Prediction {
  observed_at:number;route_id:number;stop_id:number;destination_raw:string|null;
  destination_key_raw:string|null;prediction_id:number;predicted_seconds_raw:number|null;
  scheduled_seconds_raw:number|null;etat_horaire:number|null;etat_passage:number|null;
  source_key:string;raw_json:string;
}
export interface Series {key:string;destination:string|null;prediction_id:number;rows:Prediction[]}
export interface Candidate {key:string;eligible:boolean;reasons:string[]}
export interface Visit {
  id:string;vehicle_id:number;destination:string|null;arrival_start:number;arrival_end:number;
  estimated_at:number;confidence:'medium'|'low';classification:'matched'|'ambiguous'|'insufficient_evidence';
  reasons:string[];positions:Vehicle[];candidates:Candidate[];matched_key:string|null;closest_m:number;
}
const label=(s:string|null)=>s?.trim().replace(/\s+/g,' ').toLowerCase()??'';
function xy(p:Point,origin:Point):[number,number] {return [(p.longitude-origin.longitude)*111320*Math.cos(origin.latitude*Math.PI/180),(p.latitude-origin.latitude)*111320];}
export function distance(a:Point,b:Point) {const [x,y]=xy(a,b);return Math.hypot(x,y);}
function closest(a:Point,b:Point,target:Point) {
  const [ax,ay]=xy(a,target),[bx,by]=xy(b,target),dx=bx-ax,dy=by-ay;
  const fraction=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
  return {distance:Math.hypot(ax+fraction*dx,ay+fraction*dy),fraction};
}
function bearing(a:Point,b:Point) {const [x,y]=xy(b,a);return (Math.atan2(x,y)*180/Math.PI+360)%360;}
const angle=(a:number,b:number)=>Math.abs(((a-b+540)%360)-180);
export function clockEpoch(date:string,seconds:number|null,near:number):number|null {
  if(seconds===null || seconds<0 || seconds>=172800)return null;
  // Resolve only for this candidate visit, not as an authoritative service date.
  // Reject repeated autumn hours and missing spring hours rather than guessing.
  const nominal=Date.parse(date+'T00:00:00Z')+seconds*1000,candidates:number[]=[];
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Indiana/Indianapolis',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const expected=new Date(nominal).toISOString().slice(0,19);
  for(const offset of [4,5]) {
    const at=nominal+offset*3600000,p=format.formatToParts(at),v=(key:string)=>p.find(x=>x.type===key)!.value;
    if(`${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}:${v('second')}`===expected)candidates.push(at);
  }
  if(candidates.length!==1)return null;
  return candidates.sort((a,b)=>Math.abs(a-near)-Math.abs(b-near))[0]!;
}
export function predictionSeries(rows:Prediction[]):Series[] {
  const groups=new Map<string,Series>();
  for(const row of rows) {
    const key=JSON.stringify([row.route_id,row.stop_id,row.destination_key_raw??row.destination_raw,row.prediction_id]);
    if(!groups.has(key))groups.set(key,{key,destination:row.destination_raw,prediction_id:row.prediction_id,rows:[]});
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()].map(s=>({...s,rows:s.rows.sort((a,b)=>a.observed_at-b.observed_at)}));
}
export function inferVisits(positions:Vehicle[],stop:Point,geometry:Point[][],studyId:string):Visit[] {
  const groups=new Map<number,Vehicle[]>(),visits:Visit[]=[];
  const road=geometry.flatMap(line=>line.slice(1).map((b,i)=>({a:line[i]!,b}))).map(s=>({...s,distance:closest(s.a,s.b,stop).distance})).sort((a,b)=>a.distance-b.distance)[0];
  for(const p of positions)if(Number.isSafeInteger(p.vehicle_id)&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180) {
    if(!groups.has(p.vehicle_id))groups.set(p.vehicle_id,[]);groups.get(p.vehicle_id)!.push(p);
  }
  for(const rows of groups.values()) {
    rows.sort((a,b)=>a.observed_at-b.observed_at);
    const traces:Vehicle[][]=[];
    for(const row of rows) {
      const last=traces.at(-1)?.at(-1);
      if(!last || row.observed_at-last.observed_at>150000 || row.route_id!==last.route_id || label(row.destination_raw)!==label(last.destination_raw))traces.push([]);
      if(last?.observed_at!==row.observed_at)traces.at(-1)!.push(row);
    }
    for(const trace of traces) {
      const hits:{lo:number;hi:number}[]=[];
      for(let i=0;i<trace.length;i++) {
        if(distance(trace[i]!,stop)<=60)hits.push({lo:i,hi:i});
        if(i>0) {
          const a=trace[i-1]!,b=trace[i]!,dt=(b.observed_at-a.observed_at)/1000;
          if(dt>0 && distance(a,b)/dt<=35 && Math.max(distance(a,stop),distance(b,stop))<=600 && closest(a,b,stop).distance<=40)hits.push({lo:i-1,hi:i});
        }
      }
      hits.sort((a,b)=>a.lo-b.lo);
      const clusters:{lo:number;hi:number}[]=[];
      for(const hit of hits) {
        const last=clusters.at(-1);
        if(last && hit.lo<=last.hi){last.hi=Math.max(last.hi,hit.hi);}else clusters.push({...hit});
      }
      for(const cluster of clusters) {
        let lo=cluster.lo,hi=cluster.hi;
        if(lo>0 && distance(trace[lo]!,stop)<=100)lo--;
        if(hi<trace.length-1 && distance(trace[hi]!,stop)<=100)hi++;
        const evidence=trace.slice(lo,hi+1),first=evidence[0]!,last=evidence.at(-1)!;
        const near=evidence.map(p=>({p,d:distance(p,stop)})).sort((a,b)=>a.d-b.d)[0]!;
        const reasons:string[]=[];
        if(evidence.slice(1).some((p,i)=>distance(evidence[i]!,p)/((p.observed_at-evidence[i]!.observed_at)/1000)>35))reasons.push('A position jump implies an implausible speed.');
        const bracket=distance(first,stop)>100 && distance(last,stop)>100 && evidence.length>=2;
        if(!bracket)reasons.push('Approach and departure are not both observed beyond 100 m.');
        if(last.observed_at-first.observed_at>8*60000)reasons.push('Vehicle remained near the stop for more than eight minutes.');
        if(evidence.some(p=>p.is_visible!==1))reasons.push('Evidence includes a vehicle hidden by the upstream system.');
        if(!road || closest(road.a,road.b,stop).distance>100)reasons.push('No nearby route geometry confirms this corridor.');
        else {
          const travel=bearing(first,last),roadAngle=bearing(road.a,road.b);
          if(Math.min(angle(travel,roadAngle),angle(travel,(roadAngle+180)%360))>45)reasons.push('Movement is not aligned with the nearby route segment.');
        }
        if(first.heading_raw===null || angle(first.heading_raw,bearing(first,last))>60)reasons.push('Reported heading does not confirm the approach direction.');
        let start=first.observed_at,end=last.observed_at,estimate=(start+end)/2;
        // The first near-stop observation bounds proximity entry, not passenger boarding.
        const inside=evidence.findIndex(p=>distance(p,stop)<=60);
        if(inside>0){start=evidence[inside-1]!.observed_at;end=evidence[inside]!.observed_at;estimate=(start+end)/2;}
        else if(evidence.length===2){const crossing=closest(first,last,stop);estimate=start+(end-start)*crossing.fraction;}
        const confidence=reasons.length?'low':'medium';
        visits.push({id:`${METHOD}:${studyId}:${first.vehicle_id}:${first.observed_at}`,vehicle_id:first.vehicle_id,destination:first.destination_raw,arrival_start:start,arrival_end:end,estimated_at:estimate,confidence,classification:'insufficient_evidence',reasons,positions:evidence,candidates:[],matched_key:null,closest_m:Math.round(Math.min(near.d,...evidence.slice(1).map((p,i)=>closest(evidence[i]!,p,stop).distance)))});
      }
    }
  }
  return visits.sort((a,b)=>a.arrival_start-b.arrival_start);
}
export function associate(visits:Visit[],series:Series[],date:string):Visit[] {
  for(const visit of visits) {
    for(const s of series) {
      const before=s.rows.filter(p=>p.observed_at<=visit.arrival_end && p.observed_at>=visit.arrival_start-45*60000).at(-1);
      if(!before)continue;
      const at=clockEpoch(date,before.predicted_seconds_raw,visit.estimated_at);
      const reasons=[];
      if(at===null)reasons.push('Clock date is unresolved or falls in a repeated/missing daylight-saving hour.');
      else if(Math.abs(at-visit.estimated_at)>20*60000)reasons.push('Outside the broad ±20-minute candidate time window.');
      if(!label(visit.destination) || label(s.destination)!==label(visit.destination))reasons.push('Destination labels do not agree.');
      if(before.etat_passage!==0 || before.etat_horaire!==1)reasons.push('Vendor status is flagged or not fully understood.');
      visit.candidates.push({key:s.key,eligible:reasons.length===0,reasons});
    }
  }
  const usage=new Map<string,number>();
  for(const v of visits)for(const c of v.candidates.filter(c=>c.eligible))usage.set(c.key,(usage.get(c.key)??0)+1);
  for(const visit of visits) {
    const eligible=visit.candidates.filter(c=>c.eligible);
    if(visit.confidence==='low' || !visit.candidates.length)visit.classification='insufficient_evidence';
    else if(eligible.length===1 && usage.get(eligible[0]!.key)===1){visit.classification='matched';visit.matched_key=eligible[0]!.key;}
    else visit.classification='ambiguous';
    if(!visit.candidates.length)visit.reasons.push('No prediction series was captured in the 45-minute lookback before this visit.');
    if(eligible.some(c=>(usage.get(c.key)??0)>1))visit.reasons.push('A prediction series is also a candidate for another vehicle visit.');
  }
  return visits;
}

export async function reference(db:D1Database,date:string) {
  const [start,end]=dateRange(date,date);
  const before=await db.prepare('SELECT * FROM analysis_reference_captures WHERE observed_at<=? ORDER BY observed_at DESC LIMIT 1').bind(start).first<{source_key:string;reference_hash:string;observed_at:number}>();
  const ref=before??await db.prepare('SELECT * FROM analysis_reference_captures WHERE observed_at<? ORDER BY observed_at ASC LIMIT 1').bind(end).first<{source_key:string;reference_hash:string;observed_at:number}>();
  return {ref,lookahead:!before&&!!ref};
}
export async function visitOptions(db:D1Database,date?:string) {
  const last=await db.prepare('SELECT MAX(observed_at) AS at FROM analysis_vehicles').first<{at:number|null}>();
  if(!date && last?.at) {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Indiana/Indianapolis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(last.at);
    date=['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');
  }
  if(!date)return {date:null,routes:[],stops:[],warning:'Import vehicle and reference history first.'};
  const {ref,lookahead}=await reference(db,date);
  if(!ref)return {date,routes:[],stops:[],warning:'No reference snapshot is available for this date.'};
  const routes=(await db.prepare('SELECT route_id,name,short_code FROM analysis_routes WHERE reference_hash=? ORDER BY name').bind(ref.reference_hash).all()).results;
  const stops=(await db.prepare('SELECT stop_id,code,name,latitude,longitude,metadata_json FROM analysis_stops WHERE reference_hash=? ORDER BY name').bind(ref.reference_hash).all<{stop_id:number;metadata_json:string}>()).results.map(s=>{
    const metadata=record(JSON.parse(s.metadata_json));return {...s,metadata_json:undefined,route_ids:Array.isArray(metadata.infoLigneSwiv)?metadata.infoLigneSwiv.map(x=>num(record(x).idLigne)).filter(x=>x!==null):[]};
  });
  const predictions=(await db.prepare('SELECT DISTINCT stop_id FROM analysis_predictions WHERE scheduled_at>=? AND scheduled_at<?').bind(...dateRange(date,date)).all<{stop_id:number}>()).results.map(s=>s.stop_id);
  return {date,routes,stops,prediction_stop_ids:predictions,reference:ref,warning:lookahead?'Using the first snapshot captured during this day; earlier topology is unavailable.':null};
}
export async function investigate(db:D1Database,archive:ArchiveReader,input:unknown) {
  const p=record(input),date=str(p.date);if(!date)throw Error('Choose a date');
  const [start,end]=dateRange(date,date),route=num(p.route_id),stopId=num(p.stop_id),direction=str(p.direction);
  if(!route || !Number.isSafeInteger(route) || !stopId || !Number.isSafeInteger(stopId))throw Error('Choose a route and stop');
  const {ref,lookahead}=await reference(db,date);if(!ref)throw Error('No reference snapshot available. Import reference history first.');
  const stop=await db.prepare('SELECT * FROM analysis_stops WHERE reference_hash=? AND stop_id=?').bind(ref.reference_hash,stopId).first<Point&{name:string;metadata_json:string}>();
  if(!stop || !Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude))throw Error('Stop coordinates unavailable');
  const stopRoutes=record(JSON.parse(stop.metadata_json)).infoLigneSwiv;
  if(!Array.isArray(stopRoutes) || !stopRoutes.some(x=>num(record(x).idLigne)===route))throw Error('This stop is not associated with the selected route in the reference snapshot');
  const warnings:string[]=[];if(lookahead)warnings.push('Reference snapshot is from after the beginning of this day.');
  const otherRefs=await db.prepare('SELECT COUNT(DISTINCT reference_hash) n FROM analysis_reference_captures WHERE observed_at>=? AND observed_at<?').bind(start,end).first<{n:number}>();
  if((otherRefs?.n??0)>1)warnings.push('Reference geometry changed during this day; the study uses one snapshot and visit confidence is reduced.');
  const body=record(await readJson(archive,ref.source_key)),geometry:Point[][]=[];
  for(const c of array(body.topo))for(const line of array(record(c).ligne))if(num(record(line).idLigne)===route) {
    for(const itinerary of array(record(line).itineraire??[]))for(const segment of array(record(itinerary).troncons??[])) {
      const a=record(record(segment).debut),b=record(record(segment).fin);
      if(num(a.lat)!==null&&num(a.lng)!==null&&num(b.lat)!==null&&num(b.lng)!==null)geometry.push([{latitude:Number(a.lat),longitude:Number(a.lng)},{latitude:Number(b.lat),longitude:Number(b.lng)}]);
    }
  }
  if(geometry.length>10000)throw Error('Route geometry exceeds this screen’s 10,000-segment limit');
  const vehicles=(await db.prepare('SELECT observed_at,vehicle_id,route_id,destination_raw,latitude,longitude,heading_raw,is_visible,source_key,raw_json FROM analysis_vehicles WHERE route_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at LIMIT 20001').bind(route,start-15*60000,end+15*60000).all<Vehicle>()).results;
  const predictions=(await db.prepare('SELECT observed_at,route_id,stop_id,destination_raw,destination_key_raw,prediction_id,predicted_seconds_raw,scheduled_seconds_raw,etat_horaire,etat_passage,source_key,raw_json FROM analysis_predictions WHERE route_id=? AND stop_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at LIMIT 10001').bind(route,stopId,start-45*60000,end+15*60000).all<Prediction>()).results;
  if(vehicles.length>20000 || predictions.length>10000)throw Error('Study exceeds the observation limit. This screen supports one route, one stop, and one day at a time.');
  const directions=[...new Set(vehicles.map(v=>v.destination_raw).filter((s):s is string=>!!s))].sort();
  const filtered=vehicles.filter(v=>!direction || v.destination_raw===direction);
  const idInput=JSON.stringify([METHOD,date,route,stopId,direction??'']);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(idInput))),x=>x.toString(16).padStart(2,'0')).join('');
  const series=predictionSeries(predictions);
  let visits=inferVisits(filtered,stop,geometry,hash).filter(v=>v.estimated_at>=start&&v.estimated_at<end);
  if(warnings.length)for(const v of visits){v.confidence='low';v.reasons.push(...warnings);}
  visits=associate(visits,series,date);
  if(visits.length>200)throw Error('More than 200 candidate visits. Choose a direction to narrow the study.');
  const statements=[db.prepare('DELETE FROM inferred_stop_visits WHERE study_id=?').bind(hash),...visits.map(v=>db.prepare('INSERT INTO inferred_stop_visits(id,study_id,study_date,route_id,stop_id,vehicle_id,destination,arrival_start,arrival_end,estimated_at,confidence,classification,method_version,evidence_json,generated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(v.id,hash,date,route,stopId,v.vehicle_id,v.destination,v.arrival_start,v.arrival_end,v.estimated_at,v.confidence,v.classification,METHOD,JSON.stringify(v),Date.now()))];
  await db.batch(statements);
  const annotations=(await db.prepare('SELECT a.* FROM visit_annotations a JOIN inferred_stop_visits v ON v.id=a.visit_id WHERE v.study_id=?').bind(hash).all()).results;
  return {study_id:hash,date,route_id:route,stop_id:stopId,stop,reference:ref,geometry,directions,visits,series,movement:filtered.map(({raw_json,...p})=>p),annotations,warnings,method:METHOD,limits:{near_stop_m:60,crossing_m:40,max_gap_seconds:150,candidate_window_minutes:20,lookback_minutes:45},disclaimer:'Proximity-based candidate visits and prediction associations are provisional, not confirmed passenger-service arrivals. No accuracy score is computed.'};
}
export async function annotate(db:D1Database,input:unknown) {
  const p=record(input),id=str(p.visit_id),note=str(p.note),decision=str(p.decision),key=str(p.prediction_key);
  if(!id || id.length>250 || note===null || note.length>3000 || !['unreviewed','accept','reject','uncertain'].includes(decision??''))throw Error('Invalid annotation');
  const visit=await db.prepare('SELECT evidence_json FROM inferred_stop_visits WHERE id=?').bind(id).first<{evidence_json:string}>();if(!visit)throw Error('Visit is no longer in the latest study. Reload it first.');
  const evidence=JSON.parse(visit.evidence_json) as Visit;
  if(key && !evidence.candidates.some(c=>c.key===key))throw Error('Choose a candidate prediction from this visit');
  if(decision==='accept'&&!key)throw Error('Choose a prediction series before accepting an association');
  const updated=Date.now();await db.prepare('INSERT INTO visit_annotations(visit_id,decision,prediction_key,note,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(visit_id) DO UPDATE SET decision=excluded.decision,prediction_key=excluded.prediction_key,note=excluded.note,updated_at=excluded.updated_at').bind(id,decision,key,note,updated).run();
  return {visit_id:id,decision,prediction_key:key,note,updated_at:updated};
}
