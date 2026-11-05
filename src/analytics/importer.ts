import { array, record, num, str, vehicleRows, predictionRows, type Capture, type Cell, type RecordValue } from './normalize';

export interface ArchiveReader {
  list(options: {prefix:string;limit:number;startAfter?:string}): Promise<{objects:{key:string;uploaded:Date}[];truncated:boolean}>;
  get(key:string): Promise<{size:number;text():Promise<string>}|null>;
}
const MAX_BYTES=8*1024*1024;
export async function readJson(bucket:ArchiveReader,key:string):Promise<unknown> {
  const object=await bucket.get(key);
  if(!object) throw Error(`Source object missing: ${key}`);
  if(object.size>MAX_BYTES) throw Error('Source object exceeds 8 MiB limit');
  return JSON.parse(await object.text());
}
function requiredNumber(v:unknown,name:string):number { const n=num(v);if(n===null)throw Error(`Missing numeric ${name}`);return n; }
function requiredString(v:unknown,name:string):string { const s=str(v);if(!s)throw Error(`Missing ${name}`);return s; }
const placeholders=(n:number)=>Array(n).fill('?').join(',');
const vehicleColumns='source_key,row_path,scheduled_at,observed_at,vehicle_id,fleet_number,route_id,latitude,longitude,heading_raw,speed_raw,destination_raw,reported_delay_text,reported_delay_minutes,reported_delay_lower_bound_minutes,is_visible,occupancy_raw,occupancy_percent,quality_flags_json,raw_json';
const predictionColumns='source_key,row_path,scheduled_at,observed_at,stop_id,route_id,destination_raw,destination_key_raw,prediction_id,predicted_seconds_raw,scheduled_seconds_raw,scheduled_seconds,etat_horaire,etat_passage,service_date,quality_flags_json,raw_json';

export class ImportRepository {
  constructor(readonly db:D1Database,readonly archive:ArchiveReader) {}
  async writeRows(table:string,columns:string,rows:Cell[][]) {
    // One statement per row stays below D1's per-statement binding limit.
    for(let i=0;i<rows.length;i+=25) {
      await this.db.batch(rows.slice(i,i+25).map(values=>this.db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders(values.length)}) ON CONFLICT DO NOTHING`).bind(...values)));
    }
  }
  async completed(keys:string[]):Promise<Set<string>> {
    if(!keys.length)return new Set();
    const result=await this.db.prepare(`SELECT manifest_key FROM collection_runs WHERE imported_at IS NOT NULL AND manifest_key IN (${placeholders(keys.length)})`).bind(...keys).all<{manifest_key:string}>();
    return new Set(result.results.map(r=>r.manifest_key));
  }
  async manifest(key:string):Promise<RecordValue> {
    const m=record(await readJson(this.archive,key));
    requiredString(m.run_id,'run_id');requiredNumber(m.slot,'slot');requiredNumber(m.finished_at,'finished_at');array(m.attempts);record(m.outcomes);
    await this.db.prepare('INSERT INTO collection_runs(manifest_key,run_id,scheduled_at,finished_at,plan_hash,outcomes_json,selection_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(key,m.run_id,m.slot,num(m.finished_at),str(m.plan_hash),JSON.stringify(m.outcomes),JSON.stringify(m.selection_context??null)).run();
    return m;
  }
  async attempt(manifestKey:string,a:RecordValue):Promise<{imported:boolean;rows:number}> {
    const dataset=requiredString(a.dataset,'dataset'),attemptId=requiredString(a.attempt_id,'attempt_id');
    const scheduled=requiredNumber(a.scheduled_at,'scheduled_at'),requested=requiredNumber(a.requested_at,'requested_at'),completed=requiredNumber(a.completed_at,'completed_at');
    const key=str(a.object_key);
    await this.db.prepare('INSERT INTO collection_results(manifest_key,attempt_id,dataset,stop_id,scheduled_at,requested_at,completed_at,ok,http_status,error,source_key,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(manifestKey,attemptId,dataset,num(a.stop_id),scheduled,requested,completed,a.ok===true?1:0,num(a.http_status),str(a.error),key,JSON.stringify(a)).run();
    if(a.ok!==true)return {imported:false,rows:0};
    if(!key || !key.startsWith(`raw/v1/${dataset}/`) || key.includes('..'))throw Error('Invalid raw source key');
    const existing=await this.db.prepare('SELECT status,row_count FROM imported_objects WHERE object_key=?').bind(key).first<{status:string;row_count:number}>();
    if(existing?.status==='complete')return {imported:false,rows:0};
    await this.db.prepare("INSERT INTO imported_objects(object_key,dataset,scheduled_at,requested_at,completed_at,status) VALUES(?,?,?,?,?,'pending') ON CONFLICT(object_key) DO UPDATE SET status='pending',error=NULL")
      .bind(key,dataset,scheduled,requested,completed).run();
    try {
      const capture:Capture={key,scheduled_at:scheduled,requested_at:requested,stop_id:num(a.stop_id)??undefined};
      let count=0,referenceHash:string|null=null;
      if(dataset==='vehicles' || dataset==='stop_predictions') {
        const body=await readJson(this.archive,key);
        const rows=dataset==='vehicles'?vehicleRows(body,capture):predictionRows(body,capture);
        await this.writeRows(dataset==='vehicles'?'vehicle_observations':'stop_predictions',dataset==='vehicles'?vehicleColumns:predictionColumns,rows.map(r=>r.values));
        count=rows.length;
      } else if(dataset==='full_topology') {
        const reference=await this.references(key,str(a.object_sha256));count=reference.count;referenceHash=reference.hash;
      }
      // Other datasets retain their collection metadata and raw source pointer. No speculative flattening.
      await this.db.prepare("UPDATE imported_objects SET status='complete',imported_at=?,row_count=?,reference_hash=?,error=NULL WHERE object_key=?").bind(Date.now(),count,referenceHash,key).run();
      return {imported:true,rows:count};
    } catch(error) {
      await this.db.prepare("UPDATE imported_objects SET status='error',error=? WHERE object_key=?").bind(error instanceof Error?error.message.slice(0,500):'Import failed',key).run();
      throw error;
    }
  }
  private async references(key:string,hash:string|null):Promise<{count:number;hash:string}> {
    if(hash && await this.db.prepare('SELECT content_hash FROM reference_versions WHERE content_hash=?').bind(hash).first())return {count:0,hash};
    const body=await readJson(this.archive,key);
    if(!hash) {
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
      hash=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
    }
    const routes:Cell[][]=[],stops:Cell[][]=[];
    for(const centreValue of array(record(body).topo)) {
      const centre=record(centreValue);
      for(const routeValue of array(centre.ligne)) {
        const route=record(routeValue),{itineraire,...metadata}=route;
        routes.push([hash,requiredNumber(route.idLigne,'idLigne'),str(route.nomCommercial),str(route.mnemo),JSON.stringify(metadata)]);
      }
      for(const stopValue of array(centre.pointArret)) {
        const stop=record(stopValue),location=record(stop.localisation);
        stops.push([hash,requiredNumber(stop.idPointArret,'idPointArret'),str(stop.stopCode),str(stop.nomCommercial),num(location.lat),num(location.lng),JSON.stringify(stop)]);
      }
    }
    await this.writeRows('routes','reference_hash,route_id,name,short_code,metadata_json',routes);
    await this.writeRows('stops','reference_hash,stop_id,code,name,latitude,longitude,metadata_json',stops);
    await this.db.prepare('INSERT INTO reference_versions(content_hash,source_key,imported_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(hash,key,Date.now()).run();
    return {count:routes.length+stops.length,hash};
  }
  finishManifest(key:string) { return this.db.prepare('UPDATE collection_runs SET imported_at=? WHERE manifest_key=?').bind(Date.now(),key).run(); }
  async totals() {
    return (await this.db.prepare("SELECT dataset,COUNT(*) AS objects,SUM(row_count) AS rows,MIN(scheduled_at) AS earliest_at,MAX(scheduled_at) AS latest_at FROM imported_objects WHERE status='complete' GROUP BY dataset").all()).results;
  }
  async errors() { return (await this.db.prepare("SELECT object_key,dataset,error FROM imported_objects WHERE status='error' LIMIT 20").all()).results; }
}

export interface Settings { daily_enabled:boolean; daily_time:string; timezone:'America/Indiana/Indianapolis' }
export interface Job {
  id:string;status:'running'|'stopped'|'completed'|'completed_with_errors'|'failed';
  started_at:number;finished_at?:number;cutoff:number;after?:string;pending:string[];
  manifest?:string;attempt:number;manifest_failed:boolean;
  manifests_completed:number;objects_imported:number;rows_imported:number;errors:number;
  recent_errors:{key:string;message:string}[];
  stop_requested?:boolean;
}
export interface ImportState { settings:Settings;job?:Job;last_daily_date?:string;last_success_at?:number }
export const defaultState=():ImportState=>({settings:{daily_enabled:false,daily_time:'03:00',timezone:'America/Indiana/Indianapolis'}});
export function localClock(at:number) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Indiana/Indianapolis',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const field=(type:string)=>parts.find(p=>p.type===type)!.value;
  return {date:`${field('year')}-${field('month')}-${field('day')}`,minute:Number(field('hour'))*60+Number(field('minute'))};
}
export function dailyDue(state:ImportState,at:number):boolean {
  const c=localClock(at),[h,m]=state.settings.daily_time.split(':').map(Number);
  return state.settings.daily_enabled && c.date!==state.last_daily_date && c.minute>=h!*60+m!;
}
export function nextDaily(state:ImportState,at:number):number|null {
  if(!state.settings.daily_enabled)return null;
  for(let t=Math.floor(at/60000)*60000+60000;t<=at+27*3600000;t+=60000)if(dailyDue(state,t))return t;
  return null;
}
export function validateSettings(value:unknown):Settings {
  const v=record(value);
  if(typeof v.daily_enabled!=='boolean' || typeof v.daily_time!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.daily_time))throw Error('Expected daily_enabled and daily_time (HH:mm)');
  if(v.timezone!==undefined && v.timezone!=='America/Indiana/Indianapolis')throw Error('Unsupported timezone');
  return {daily_enabled:v.daily_enabled,daily_time:v.daily_time,timezone:'America/Indiana/Indianapolis'};
}
export function startJob(state:ImportState,now:number) {
  if(state.job?.status==='running')return;
  if(state.job && ['stopped','failed'].includes(state.job.status)) {state.job.status='running';state.job.stop_requested=false;delete state.job.finished_at;return;}
  state.job={id:crypto.randomUUID(),status:'running',started_at:now,cutoff:now,pending:[],attempt:0,manifest_failed:false,manifests_completed:0,objects_imported:0,rows_imported:0,errors:0,recent_errors:[]};
}
export function addError(job:Job,key:string,error:unknown) {
  job.errors++;job.recent_errors.push({key,message:error instanceof Error?error.message.slice(0,500):'Import failed'});job.recent_errors=job.recent_errors.slice(-20);
}

// One source object per batch. The coordinator checks stop requests at each boundary.
export async function step(job:Job,repo:ImportRepository):Promise<void> {
  if(!job.manifest) {
    if(!job.pending.length) {
      const page=await repo.archive.list({prefix:'runs/v1/',limit:20,startAfter:job.after});
      if(!page.objects.length) {job.status=job.errors?'completed_with_errors':'completed';job.finished_at=Date.now();return;}
      job.after=page.objects.at(-1)!.key;
      const eligible=page.objects.filter(o=>o.uploaded.getTime()<=job.cutoff).map(o=>o.key);
      const done=await repo.completed(eligible);job.pending=eligible.filter(k=>!done.has(k));
    }
    job.manifest=job.pending.shift();job.attempt=0;job.manifest_failed=false;
    if(!job.manifest)return;
  }
  const key=job.manifest;
  let manifest:RecordValue;
  try {manifest=await repo.manifest(key);} catch(error) {
    addError(job,key,error);delete job.manifest;return;
  }
  const attempts=array(manifest.attempts);
  if(job.attempt<attempts.length) {
    try {
      const a=record(attempts[job.attempt]);
      const result=await repo.attempt(key,a);if(result.imported){job.objects_imported++;job.rows_imported+=result.rows;}
    } catch(error) {addError(job,key,error);job.manifest_failed=true;}
    job.attempt++;
    return;
  }
  if(!job.manifest_failed){await repo.finishManifest(key);job.manifests_completed++;}
  delete job.manifest;
}
