import timetable from './gtfs/timetable.json';
import {dateRange} from './catalog';
import {clockEpoch} from './visits';

export const GTFS_INFO={...timetable.info,sha256:timetable.sha256,source_url:timetable.source_url,timezone:timetable.timezone};
const calls=timetable.calls as Record<string,(number|string)[][]>;
export interface ComparisonPrediction {
  observed_at:number;stop_id:number;route_id:number;destination_raw:string|null;destination_key_raw:string|null;
  prediction_id:number|null;predicted_seconds_raw:number|null;scheduled_seconds_raw:number|null;
  etat_horaire:number|null;etat_passage:number|null;source_key:string;
  stop_code:string|null;route_code:string|null;
}
export function activeServices(date:string):Set<string> {
  dateRange(date,date);
  const compact=date.replaceAll('-',''),day=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date(date+'T12:00:00Z').getUTCDay()]!;
  const active=new Set(timetable.calendar.filter(c=>c.start_date<=compact && compact<=c.end_date && (c as Record<string,string>)[day]==='1').map(c=>c.service_id));
  for(const e of timetable.exceptions)if(e.date===compact){if(e.exception_type==='1')active.add(e.service_id);else active.delete(e.service_id);}
  return active;
}
export function comparePrediction(p:ComparisonPrediction,date:string,active=activeServices(date),epochs=new Map<number,number|null>()) {
  const scheduled=p.scheduled_seconds_raw && p.scheduled_seconds_raw>0?p.scheduled_seconds_raw:null;
  const base={...p,service_date:date,gtfs_seconds:null as number|null,gtfs_trip_id:null as string|null,timepoint:null as string|null,direction_id:null as string|null,schedule_difference_seconds:null as number|null,prediction_difference_seconds:null as number|null,api_adjustment_seconds:null as number|null,match_status:'unmatched',status_flag:p.etat_horaire!==1||p.etat_passage!==0};
  if(scheduled!==null && p.predicted_seconds_raw!==null && Math.abs(p.predicted_seconds_raw-scheduled)<43200)base.api_adjustment_seconds=p.predicted_seconds_raw-scheduled;
  const compact=date.replaceAll('-','');
  if(compact<timetable.info.feed_start_date || compact>timetable.info.feed_end_date)return {...base,match_status:'outside_feed_dates'};
  if(!p.stop_code || !p.route_code)return {...base,match_status:'missing_reference'};
  if(!scheduled)return {...base,match_status:'missing_api_schedule'};
  const entries=calls[JSON.stringify([p.stop_code,p.route_code])]??[];
  // Match on scheduled time only. Never choose a trip by the predicted time/error.
  const candidates=entries.filter(c=>active.has(timetable.trips[Number(c[0])]![1]!) && Math.abs(Number(c[1])-scheduled)<=60);
  if(candidates.length!==1)return {...base,match_status:candidates.length?'ambiguous':'no_schedule_match'};
  const c=candidates[0]!,seconds=Number(c[1]),trip=timetable.trips[Number(c[0])]!;
  if(!epochs.has(seconds))epochs.set(seconds,clockEpoch(date,seconds,p.observed_at));
  const epoch=epochs.get(seconds)!;
  if(epoch===null)return {...base,match_status:'unresolved_clock'};
  // Explicit service date; exclude captures implausibly far from this stop call.
  if(p.observed_at<epoch-86400000 || p.observed_at>epoch+6*3600000)return {...base,match_status:'outside_selected_service_date'};
  return {...base,gtfs_seconds:seconds,gtfs_trip_id:trip[0]!,direction_id:trip[2]!,timepoint:String(c[2]),schedule_difference_seconds:scheduled-seconds,prediction_difference_seconds:p.predicted_seconds_raw!==null && Math.abs(p.predicted_seconds_raw-seconds)<43200?p.predicted_seconds_raw-seconds:null,match_status:'schedule_candidate'};
}
export async function comparison(db:D1Database,params:URLSearchParams) {
  const date=params.get('date')??'',serviceDate=params.get('service_date')??date;
  const [start,end]=dateRange(date,date),active=activeServices(serviceDate);
  const route=params.get('route_id')??'',stop=params.get('stop_id')??'';
  if(!/^\d{1,12}$/.test(route)||Number(route)<=0||!/^\d{1,12}$/.test(stop)||Number(stop)<=0)throw Error('Choose a route and stop');
  const rows=(await db.prepare(`SELECT p.observed_at,p.stop_id,p.route_id,p.destination_raw,p.destination_key_raw,p.prediction_id,
    p.predicted_seconds_raw,p.scheduled_seconds_raw,p.etat_horaire,p.etat_passage,p.source_key,
    s.code AS stop_code,r.short_code AS route_code
    FROM analysis_predictions p
    LEFT JOIN analysis_reference_captures ref ON ref.source_key=(SELECT source_key FROM analysis_reference_captures WHERE observed_at<=p.observed_at ORDER BY observed_at DESC,source_key DESC LIMIT 1)
    LEFT JOIN analysis_stops s ON s.reference_hash=ref.reference_hash AND s.stop_id=p.stop_id
    LEFT JOIN analysis_routes r ON r.reference_hash=ref.reference_hash AND r.route_id=p.route_id
    WHERE p.route_id=? AND p.stop_id=? AND p.observed_at>=? AND p.observed_at<?
    ORDER BY p.observed_at,p.source_key,p.row_path LIMIT 10001`).bind(Number(route),Number(stop),start,end).all<ComparisonPrediction>()).results;
  if(rows.length>10000)throw Error('More than 10,000 observations. Choose another day or stop. No partial comparison was returned.');
  const epochs=new Map<number,number|null>();
  const compared=rows.map(p=>comparePrediction(p,serviceDate,active,epochs));
  return {date,service_date:serviceDate,feed:GTFS_INFO,rows:compared,limit:10000,disclaimer:'Differences from GTFS are not accuracy scores. Matches are provisional schedule candidates, not verified trip identities. All captures and flagged/unmatched entries are retained. GTFS service date is selected explicitly; API clock fields have no date. Matching uses route, stop and API scheduled time within 60 seconds, never the prediction.'};
}
