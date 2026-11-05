import { DurableObject } from 'cloudflare:workers';
import { ImportRepository, defaultState, startJob, step, addError, dailyDue, localClock, nextDaily, validateSettings, type ImportState } from './importer';

type Bindings = AnalyticsEnv & { IMPORT_TOKEN?:string };
export class ImportCoordinator extends DurableObject<Bindings> {
  private state:ImportState;
  private busy=false;
  private repo:ImportRepository;
  constructor(ctx:DurableObjectState,env:Bindings) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS importer_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
    const saved=ctx.storage.sql.exec<{value:string}>('SELECT value FROM importer_state WHERE id=1').toArray()[0];
    this.state=saved?JSON.parse(saved.value) as ImportState:defaultState();
    this.repo=new ImportRepository(env.DB,env.ARCHIVE);
  }
  private save() {
    this.ctx.storage.sql.exec('INSERT INTO importer_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',JSON.stringify(this.state));
  }
  async status() {
    const [totals,errors]=await Promise.all([this.repo.totals(),this.repo.errors()]);
    return {...this.state,batch_active:this.busy,next_scheduled_at:nextDaily(this.state,Date.now()),totals,errors};
  }
  async settings(value:unknown) {
    this.state.settings=validateSettings(value);this.save();return this.status();
  }
  async start() {
    startJob(this.state,Date.now());this.save();
    await this.ctx.storage.setAlarm(Date.now()+1000);
    return this.status();
  }
  async stop() {
    if(this.state.job?.status==='running') {
      this.state.job.stop_requested=true;this.state.job.status='stopped';this.save();
    }
    // Never abort an in-flight D1 write. The alarm observes stop at the batch boundary.
    return this.status();
  }
  async tick(at:number) {
    if(dailyDue(this.state,at)) {
      this.state.last_daily_date=localClock(at).date;
      startJob(this.state,Date.now());this.save();
    }
    // Cron also recovers a running job if an alarm was interrupted before it could rearm.
    if(this.state.job?.status==='running' && !this.busy)await this.ctx.storage.setAlarm(Date.now()+1000);
  }
  async alarm() {
    if(this.busy || this.state.job?.status!=='running')return;
    this.busy=true;
    const job=this.state.job;
    try {
      const started=Date.now();
      for(let batches=0;batches<10 && Date.now()-started<5000 && job.status==='running' && !job.stop_requested;batches++) {
        await step(job,this.repo);
        this.save();
      }
      if(job.stop_requested)job.status='stopped';
      if(job.status==='completed')this.state.last_success_at=Date.now();
    } catch(error) {
      addError(job,job.manifest??'manifest_scan',error);job.status='failed';
      console.error(JSON.stringify({event:'import_batch_failed',job_id:job.id}));
    } finally {
      this.save();this.busy=false;
      if(job.status==='running')await this.ctx.storage.setAlarm(Date.now()+1000);
    }
  }
}
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function authorized(request:Request,token:string) {
  const supplied=request.headers.get('Authorization');
  if(!supplied?.startsWith('Bearer '))return false;
  const enc=new TextEncoder();
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(supplied.slice(7))));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(token)));
  let different=0;for(let i=0;i<a.length;i++)different|=a[i]!^b[i]!;
  return different===0;
}
async function smallJson(request:Request) {
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw Error('Expected application/json');
  const reader=request.body?.getReader();if(!reader)throw Error('Missing JSON body');
  let length=0;const chunks:Uint8Array[]=[];
  for(;;) {const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>4096){await reader.cancel();throw Error('Settings body too large');}chunks.push(item.value);}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export default {
  async scheduled(event:ScheduledController,env:Bindings,ctx:ExecutionContext) {
    ctx.waitUntil(env.IMPORTER.getByName('citilink-history').tick(event.scheduledTime));
  },
  async fetch(request:Request,env:Bindings):Promise<Response> {
    if(!env.IMPORT_TOKEN || env.IMPORT_TOKEN.length<24)return response({error:'import_auth_not_configured'},503);
    if(!await authorized(request,env.IMPORT_TOKEN))return response({error:'unauthorized'},401);
    const url=new URL(request.url),importer=env.IMPORTER.getByName('citilink-history');
    try {
      if(url.pathname==='/api/imports' && request.method==='GET')return response(await importer.status());
      if(url.pathname==='/api/imports/start' && request.method==='POST')return response(await importer.start(),202);
      if(url.pathname==='/api/imports/stop' && request.method==='POST')return response(await importer.stop());
      if(url.pathname==='/api/imports/settings' && request.method==='PUT') {
        let settings;
        try {settings=validateSettings(await smallJson(request));}catch(error){return response({error:error instanceof Error?error.message:'Invalid settings'},400);}
        return response(await importer.settings(settings));
      }
      return response({error:'not_found'},404);
    } catch {return response({error:'import_service_unavailable'},503);}
  }
} satisfies ExportedHandler<Bindings>;
