import {dateRange} from './catalog';
import {localClock} from './importer';

export const GPS_ROW_LIMIT=50000;
export interface GpsRow {
  vehicle_id:number|null; route_id:number|null; observed_at:number;
  latitude:number|null; longitude:number|null; is_visible:number|null;
}
export const median=(values:number[]):number|null=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[i]!:(sorted[i-1]!+sorted[i]!)/2;
};
function valid(row:GpsRow) {
  return row.is_visible===1 && row.latitude!==null && row.longitude!==null &&
    Number.isFinite(row.latitude) && Number.isFinite(row.longitude) &&
    Math.abs(row.latitude)<=90 && Math.abs(row.longitude)<=180;
}
function meters(a:GpsRow,b:GpsRow) {
  const radians=Math.PI/180,dlat=(b.latitude!-a.latitude!)*radians,dlon=(b.longitude!-a.longitude!)*radians;
  const h=Math.sin(dlat/2)**2+Math.cos(a.latitude!*radians)*Math.cos(b.latitude!*radians)*Math.sin(dlon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
/** Request times measure feed visibility, never GPS fix times. */
export function estimateGps(rows:GpsRow[],truncated=false) {
  const times=[...new Set(rows.map(r=>r.observed_at))].sort((a,b)=>a-b);
  const pollSeconds=median(times.slice(1).map((at,i)=>(at-times[i]!)/1000));
  // Break traces at missed captures, route changes, hidden/invalid readings, or duplicate times.
  const gapLimit=Math.min(300,Math.max(30,(pollSeconds??60)*2.5));
  const groups=new Map<number,GpsRow[]>();
  for(const row of rows)if(row.vehicle_id!==null && Number.isSafeInteger(row.vehicle_id)) {
    if(!groups.has(row.vehicle_id))groups.set(row.vehicle_id,[]);
    groups.get(row.vehicle_id)!.push(row);
  }
  let excluded=0;
  const intervals:number[]=[];
  const vehicles=[...groups].map(([vehicle_id,points])=>{
    points.sort((a,b)=>a.observed_at-b.observed_at);
    const timeCounts=new Map<number,number>();
    for(const point of points)timeCounts.set(point.observed_at,(timeCounts.get(point.observed_at)??0)+1);
    let pairs=0,changes=0,lastChange:number|null=null;
    const changeIntervals:number[]=[];
    for(let i=1;i<points.length;i++) {
      const a=points[i-1]!,b=points[i]!,seconds=(b.observed_at-a.observed_at)/1000;
      if(!valid(a)||!valid(b)||timeCounts.get(a.observed_at)!>1||timeCounts.get(b.observed_at)!>1||seconds<=0||seconds>gapLimit||a.route_id!==b.route_id) {
        lastChange=null;excluded++;continue;
      }
      const distance=meters(a,b);
      // Suppress implausible jumps (>40 m/s) as well as sub-10 m jitter.
      if(distance/seconds>40){lastChange=null;excluded++;continue;}
      pairs++;
      if(distance>=10) {
        changes++;
        if(lastChange!==null)changeIntervals.push((b.observed_at-lastChange)/1000);
        lastChange=b.observed_at;
      }
    }
    intervals.push(...changeIntervals);
    return {vehicle_id,observations:points.length,pairs,changes,change_percent:pairs?100*changes/pairs:null,change_seconds:median(changeIntervals)};
  }).sort((a,b)=>b.changes-a.changes||a.vehicle_id-b.vehicle_id);
  const pairs=vehicles.reduce((n,v)=>n+v.pairs,0),changes=vehicles.reduce((n,v)=>n+v.changes,0);
  const changedPercent=pairs?100*changes/pairs:null;
  let recommendation:'insufficient'|'faster_helpful'|'no_clear_need'='insufficient';
  let note='Not enough evidence to decide whether faster polling is needed. Choose an imported day with moving buses, or import more history.';
  if(truncated)note='This sample reached the 50,000-record limit. Narrow to a route or vehicle before deciding whether faster polling is needed.';
  else if(pollSeconds!==null && pairs>=20 && changes>=5) {
    if(changedPercent!>=50) {
      recommendation='faster_helpful';
      note=`Faster polling may help: positions change in ${Math.round(changedPercent!)}% of comparable pairs at a median ${Math.round(pollSeconds)}-second collection interval. Updates may occur between polls. A short, rate-limit-compliant trial at a shorter interval would resolve more detail.`;
    }else {
      recommendation='no_clear_need';
      note='No clear need for faster polling from this sample. Many readings repeat or move less than 10 m. Stopped buses, rounded coordinates and caching can mask updates, so this does not prove the current polling interval captures every GPS fix.';
    }
  }
  return {poll_seconds:pollSeconds,change_seconds:median(intervals),change_percent:changedPercent,pairs,changes,excluded_pairs:excluded,observations:rows.length,vehicle_count:vehicles.length,
    first_at:times[0]??null,last_at:times.at(-1)??null,gap_limit_seconds:gapLimit,truncated,recommendation,note,vehicles,
    method:'Polling interval is the median spacing of distinct vehicle-bearing request times in this sample; empty responses and failed or unimported captures are not represented. Visible buses; adjacent valid positions at least 10 m apart count as changes. Duplicate times, route changes, long gaps and implausible jumps break comparisons. The median time between detected changes includes stops and repeats. No GPS fix timestamp is available: this estimates observed feed changes, not the true GPS update rate. Faster polling does not make buses report more often.'};
}
export async function gpsFrequency(db:D1Database,params:URLSearchParams) {
  let date=params.get('date');
  if(!date) {
    const latest=await db.prepare('SELECT MAX(observed_at) AS at FROM analysis_vehicles').first<{at:number|null}>();
    date=localClock(latest?.at??Date.now()).date;
  }
  const [start,end]=dateRange(date,date),filters=['observed_at >= ?','observed_at < ?'],bindings:number[]=[start,end];
  for(const field of ['route_id','vehicle_id'])if(params.get(field)) {
    const value=params.get(field)!;
    if(!/^\d{1,12}$/.test(value)||Number(value)<=0)throw Error('Use positive numeric IDs');
    filters.push(`${field} = ?`);bindings.push(Number(value));
  }
  // Bounds apply before analysis; unfinished imports remain hidden by the analysis view.
  const result=await db.prepare(`SELECT vehicle_id,route_id,observed_at,latitude,longitude,is_visible FROM analysis_vehicles WHERE ${filters.join(' AND ')} ORDER BY observed_at DESC,vehicle_id LIMIT ?`).bind(...bindings,GPS_ROW_LIMIT+1).all<GpsRow>();
  return {date,...estimateGps(result.results.slice(0,GPS_ROW_LIMIT),result.results.length>GPS_ROW_LIMIT)};
}

