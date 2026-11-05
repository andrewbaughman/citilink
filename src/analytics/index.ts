import { DurableObject } from 'cloudflare:workers';
import { ImportRepository, defaultState, startJob, step, addError, dailyDue, localClock, nextDaily, validateSettings, type ImportState } from './importer';
import {authenticate,bodyText,tokenMatches,sessionCookie,clearCookie,type AuthEnv} from './auth';
import {query,csv,PREVIEW_LIMIT,EXPORT_LIMIT} from './queries';
import {schema,starter,STARTERS} from './catalog';
import {visitOptions,investigate,annotate} from './visits';
import visitsJs from './ui/visits.js.txt';
import dashboard from './ui/dashboard.html';
import dashboardCss from './ui/dashboard.css';
import dashboardJs from './ui/dashboard.js.txt';

type Bindings = AnalyticsEnv & AuthEnv;
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
async function jsonBody(request:Request,limit=65536):Promise<unknown> {
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw Error('Expected application/json');
  return JSON.parse(await bodyText(request,limit)) as unknown;
}
const pageHeaders={
  'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy':'no-referrer',
};
function login(failed=false) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Citilink</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main class="login"><section class="card"><div class="brand"><span class="brand-mark">C<span>↗</span></span><span>Citilink<small>DATA WORKSPACE</small></span></div><h1>Your data workspace.</h1><p class="muted">Sign in to explore the archive and manage imports.</p>${failed?'<p role="alert">The password was not accepted. Try again.</p>':''}<form method="post" action="/login"><label for="password">Administrator password<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="4096"></label><button class="primary" type="submit">Sign in →</button></form><p class="fineprint">Access is private. Your original files stay in R2.</p></section></main></body></html>`,{status:failed?401:200,headers:pageHeaders});
}
export default {
  async scheduled(event:ScheduledController,env:Bindings,ctx:ExecutionContext) {
    ctx.waitUntil(env.IMPORTER.getByName('citilink-history').tick(event.scheduledTime));
  },
  async fetch(request:Request,env:Bindings):Promise<Response> {
    const url=new URL(request.url);
    if(request.method==='GET' && url.pathname==='/assets/dashboard.css')return new Response(dashboardCss,{headers:{'Content-Type':'text/css;charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
    if(request.method==='GET' && url.pathname==='/assets/dashboard.js')return new Response(dashboardJs,{headers:{'Content-Type':'application/javascript;charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
    if(request.method==='GET' && url.pathname==='/assets/visits.js')return new Response(visitsJs,{headers:{'Content-Type':'application/javascript;charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
    if(!env.IMPORT_TOKEN || env.IMPORT_TOKEN.length<24)return response({error:'import_auth_not_configured'},503);
    if(url.pathname==='/login' && request.method==='POST') {
      if(request.headers.get('Origin')!==url.origin)return response({error:'origin_not_allowed'},403);
      try {
        const form=new URLSearchParams(await bodyText(request,8192)),password=form.get('password')??'';
        if(!await tokenMatches(password,env.IMPORT_TOKEN))return login(true);
        return new Response(null,{status:303,headers:{'Location':'/','Set-Cookie':await sessionCookie(env.IMPORT_TOKEN),'Cache-Control':'no-store'}});
      }catch{return login(true);}
    }
    const identity=await authenticate(request,env);
    if(!identity)return url.pathname==='/' && request.method==='GET'?login():response({error:'unauthorized'},401);
    if(!['GET','HEAD'].includes(request.method) && identity!=='bearer' && request.headers.get('Origin')!==url.origin)return response({error:'origin_not_allowed'},403);
    const importer=env.IMPORTER.getByName('citilink-history');
    try {
      if(url.pathname==='/' && request.method==='GET')return new Response(dashboard,{headers:pageHeaders});
      if(url.pathname==='/logout' && request.method==='POST')return new Response(null,{status:303,headers:{'Location':identity==='access'?`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`:'/','Set-Cookie':clearCookie(),'Cache-Control':'no-store'}});
      if(url.pathname==='/api/imports' && request.method==='GET')return response(await importer.status());
      if(url.pathname==='/api/imports/start' && request.method==='POST')return response(await importer.start(),202);
      if(url.pathname==='/api/imports/stop' && request.method==='POST')return response(await importer.stop());
      if(url.pathname==='/api/imports/settings' && request.method==='PUT') {
        let settings;
        try {settings=validateSettings(await jsonBody(request,4096));}catch(error){return response({error:error instanceof Error?error.message:'Invalid settings'},400);}
        return response(await importer.settings(settings));
      }
      if(url.pathname==='/api/analysis/schema' && request.method==='GET')return response({tables:await schema(env.DB),starters:STARTERS});
      if(url.pathname==='/api/visits/options' && request.method==='GET') {
        try{return response(await visitOptions(env.DB,url.searchParams.get('date')??undefined));}catch(error){return response({error:error instanceof Error?error.message:'Options unavailable'},400);}
      }
      if(url.pathname==='/api/visits/investigate' && request.method==='POST') {
        try{return response(await investigate(env.DB,env.ARCHIVE,await jsonBody(request)));}catch(error){return response({error:error instanceof Error?error.message:'Study failed'},400);}
      }
      if(url.pathname==='/api/visits/annotation' && request.method==='PUT') {
        try{return response(await annotate(env.DB,await jsonBody(request)));}catch(error){return response({error:error instanceof Error?error.message:'Save failed'},400);}
      }
      if(url.pathname==='/api/analysis/starter' && request.method==='GET') {
        try{return response({sql:starter(url.searchParams)});}catch(error){return response({error:error instanceof Error?error.message:'Invalid filters'},400);}
      }
      if(['/api/analysis/query','/api/analysis/export'].includes(url.pathname) && request.method==='POST') {
        try {
          const value=await jsonBody(request);
          if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Expected a SQL query');
          const exporting=url.pathname.endsWith('/export');
          const result=await query(env.DB,(value as {sql?:unknown}).sql,exporting?EXPORT_LIMIT:PREVIEW_LIMIT);
          if(!exporting)return response(result);
          return new Response(csv(result.columns,result.rows),{headers:{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="citilink-query.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Result-Truncated':String(result.truncated),'X-Result-Rows':String(result.rows.length),'X-Export-Row-Limit':String(EXPORT_LIMIT)}});
        }catch(error){return response({error:error instanceof Error?error.message.slice(0,500):'Query failed'},400);}
      }
      return response({error:'not_found'},404);
    } catch {return response({error:'import_service_unavailable'},503);}
  }
} satisfies ExportedHandler<Bindings>;
