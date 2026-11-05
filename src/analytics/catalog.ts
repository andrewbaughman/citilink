import {TABLES} from './queries';
import {localClock} from './importer';
const notes:Record<string,string>={
  source_key:'Original JSON object in R2. Separate capture times remain separate observations.',
  observed_at:'Request time in UTC epoch milliseconds; not the GPS measurement time.',
  scheduled_at:'Collector scheduled time in UTC epoch milliseconds.',
  requested_at:'Collector request time in UTC epoch milliseconds.',
  completed_at:'Collector response completion in UTC epoch milliseconds.',
  finished_at:'Run completion time in UTC epoch milliseconds.',
  vehicle_id:'id: internal vehicle identifier, distinct from fleet number.',
  fleet_number:'numeroEquipement: fleet/equipment number. Stored as text.',
  route_id:'idLigne: route identifier. Join using the relevant reference version.',
  latitude:'localisation.lat: latitude.',longitude:'localisation.lng: longitude.',
  heading_raw:'localisation.cap: heading/bearing, observed 0–359.',
  speed_raw:'vitesse: raw speed. Unit is unconfirmed; outliers are flagged.',
  destination_raw:'destination / libelle: original destination text, including whitespace.',
  destination_key_raw:'libelleHexa: provider destination key; includes a route prefix in samples.',
  reported_delay_text:'avanceRetard: upstream reported schedule adherence, not an independently measured arrival.',
  reported_delay_minutes:'Parsed ordinary numeric delay, negative for early. Excludes categorical on time and censored 1h+ late.',
  reported_delay_lower_bound_minutes:'Lower bound for censored values such as 1h+ late.',
  is_visible:'estAffichable: display flag, not an in-service flag. Default vehicle summaries use 1.',
  occupancy_raw:'tauxRemplissage: original fill percentage, including unavailable zeros.',
  occupancy_percent:'Reported occupancy percentage; null when display availability is missing.',
  quality_flags_json:'Interpretation and data-quality flags. Original values are retained.',
  raw_json:'Original French record. The complete response remains in R2.',
  stop_id:'idPointArret: stop identifier.',
  prediction_id:'idHoraire: schedule-entry identifier, not a vehicle/trip ID.',
  predicted_seconds_raw:'horaire: vendor predicted/displayed clock seconds. Not always a live prediction.',
  scheduled_seconds_raw:'horaireApplicable: original scheduled clock seconds; zero means unavailable in vendor UI.',
  scheduled_seconds:'Nullable alias of scheduled_seconds_raw; zero becomes null.',
  etat_horaire:'etatHoraire: schedule status. Vendor gives 0 a special display; operational enum is unconfirmed.',
  etat_passage:'etatPassage: passage status. Vendor strikes through 1 and hides predicted time for 2.',
  service_date:'Unresolved. Clock times are not automatically assigned to the capture date.',
  reference_hash:'Content version. References are not interchangeable across historical dates.',
  metadata_json:'Original reference metadata; full route geometry remains in R2.',
  name:'Original public-facing route or stop name.',short_code:'mnemo: short route code.',code:'stopCode: stop code.',
  ok:'1 for successful collection, including successful empty responses; 0 for failures.',
  http_status:'Upstream HTTP response status, when available.',error:'Recorded collection error, if any.',
  outcomes_json:'Per-dataset expected/succeeded counts and skipped reasons for each run.',
  selection_json:'Stop-study selection context for the capture run.',plan_hash:'Archived capture configuration version.',run_id:'Collector run identifier.',row_path:'Stable path inside the source JSON record.'
};
export async function schema(db:D1Database) {
  return Promise.all(TABLES.map(async name=>({name,description:{analysis_vehicles:'Completed vehicle observations',analysis_predictions:'Completed stop prediction observations',analysis_routes:'Versioned route references',analysis_stops:'Versioned stop references',analysis_reference_captures:'Reference versions and capture timestamps for historical joins',analysis_collections:'Collection outcomes, including empty responses',analysis_runs:'Run-level expected coverage and skipped reasons'}[name],columns:(await db.prepare(`PRAGMA table_info(${name})`).all<{name:string;type:string}>()).results.map(c=>({name:c.name,type:c.type,description:notes[c.name]??''}))})));
}
function midnight(date:string):number {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Use dates in YYYY-MM-DD form');
  const nominal=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0,10)!==date)throw Error('Invalid date');
  let at=nominal+5*3600000;
  for(let i=0;i<3;i++) {
    const c=localClock(at),wall=Date.parse(c.date+'T00:00:00Z')+c.minute*60000;
    at+=nominal-wall;
  }
  return at;
}
export function dateRange(from:string,to:string):[number,number] {
  const start=midnight(from),last=Date.parse(to+'T00:00:00Z');midnight(to);
  const end=midnight(new Date(last+86400000).toISOString().slice(0,10));
  if(end<=start)throw Error('End date must be on or after start date');
  return [start,end];
}
export const STARTERS=[
  {id:'vehicles',name:'Vehicle observations',description:'Positions and reported state. Visible vehicles by default.'},
  {id:'delay',name:'Reported delay by route',description:'Upstream categories and numeric reports; not measured arrival punctuality.'},
  {id:'predictions',name:'Prediction revisions',description:'Changes to displayed clock times. Departure dates remain unresolved.'},
  {id:'coverage',name:'Collection coverage',description:'Expected versus successful captures, including empty responses and skips.'},
  {id:'quality',name:'Flagged vehicle readings',description:'Raw speed outliers and invalid coordinates; original values are retained.'}
] as const;
export function starter(params:URLSearchParams):string {
  const id=params.get('name')??'vehicles';
  let time='1=1';
  if(params.get('from') || params.get('to')) {
    if(!params.get('from') || !params.get('to'))throw Error('Choose both dates');
    const [a,b]=dateRange(params.get('from')!,params.get('to')!);time=`scheduled_at >= ${a} AND scheduled_at < ${b}`;
  }
  const filters=[time];
  for(const field of ['route_id','vehicle_id','stop_id'])if(params.get(field)) {
    const value=params.get(field)!;if(!/^\d{1,12}$/.test(value) || Number(value)<=0)throw Error('Use positive numeric IDs');
    if((field==='vehicle_id' && ['vehicles','delay','quality'].includes(id)) || (field==='stop_id' && id==='predictions') || (field==='route_id' && id!=='coverage'))filters.push(`${field} = ${Number(value)}`);
  }
  if(id!=='coverage' && id!=='predictions' && params.get('all_vehicles')!=='true')filters.push('is_visible = 1');
  const where=filters.join('\n  AND ');
  if(id==='vehicles')return `SELECT observed_at, vehicle_id, fleet_number, route_id, destination_raw, latitude, longitude, reported_delay_text, occupancy_percent, is_visible\nFROM analysis_vehicles\nWHERE ${where}\nORDER BY observed_at DESC`;
  if(id==='delay')return `SELECT route_id, COUNT(*) AS observations,\n  SUM(CASE WHEN reported_delay_text = 'on time' THEN 1 ELSE 0 END) AS reported_on_time,\n  COUNT(reported_delay_minutes) AS numeric_delay_reports,\n  ROUND(AVG(reported_delay_minutes), 2) AS mean_numeric_reported_minutes\nFROM analysis_vehicles\nWHERE ${where}\nGROUP BY route_id\nORDER BY observations DESC`;
  if(id==='predictions')return `SELECT observed_at, stop_id, route_id, destination_raw, prediction_id,\n  predicted_seconds_raw, scheduled_seconds, etat_horaire, etat_passage,\n  predicted_seconds_raw - LAG(predicted_seconds_raw) OVER (\n    PARTITION BY stop_id, route_id, destination_key_raw, prediction_id\n    ORDER BY observed_at\n  ) AS revision_seconds\nFROM analysis_predictions\nWHERE ${where}\nORDER BY observed_at DESC`;
  if(id==='quality')return `SELECT observed_at, vehicle_id, route_id, speed_raw, latitude, longitude, quality_flags_json\nFROM analysis_vehicles\nWHERE ${where}\n  AND (quality_flags_json LIKE '%outlier%' OR quality_flags_json LIKE '%invalid_coordinates%')\nORDER BY observed_at DESC`;
  if(id==='coverage')return `SELECT entry.key AS dataset,\n  SUM(json_extract(entry.value, '$.expected')) AS expected,\n  SUM(json_extract(entry.value, '$.succeeded')) AS succeeded\nFROM analysis_runs AS runs, json_each(runs.outcomes_json) AS entry\nWHERE ${time}\nGROUP BY entry.key\nORDER BY entry.key`;
  throw Error('Unknown starter query');
}
