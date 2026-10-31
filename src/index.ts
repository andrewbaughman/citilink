import { DurableObject } from 'cloudflare:workers';
import rawPlan from '../capture-plan.json';
import { Engine } from './collector';
import { dashboard } from './dashboard';
export interface Env {
  COORDINATOR: DurableObjectNamespace<Collector>;
  ARCHIVE: R2Bucket;
  STATUS_TOKEN?: string;
  HEALTH_TOKEN?: string;
}
const json = (value: unknown, status=200) => new Response(JSON.stringify(value,null,2),{ status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'} });
export class Collector extends DurableObject<Env> {
  private engine: Engine;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    this.engine=new Engine(ctx.storage,env.ARCHIVE,rawPlan);
  }
  tick(scheduledTime: number) { return this.engine.tick(scheduledTime); }
  async status(): Promise<string> { return JSON.stringify(await this.engine.status()); }
}
async function matches(value: string, expected: string) {
  const encode=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(value)),crypto.subtle.digest('SHA-256',encode.encode(expected))]);
  let different=0;
  const x=new Uint8Array(a),y=new Uint8Array(b);
  for(let i=0;i<x.length;i++) different |= x[i]! ^ y[i]!;
  return different===0;
}
async function authenticate(request: Request, token: string) {
  const header=request.headers.get('authorization') ?? '';
  if(header.startsWith('Bearer ')) return matches(header.slice(7),token);
  if(header.startsWith('Basic ')) {
    try { const decoded=atob(header.slice(6)); return decoded.startsWith('citilink:') && matches(decoded.slice(9),token); }
    catch { return false; }
  }
  return false;
}
function stub(env: Env) { return env.COORDINATOR.get(env.COORDINATOR.idFromName('citilink-global-v1')); }
export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(stub(env).tick(event.scheduledTime));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url=new URL(request.url);
    if(request.method!=='GET' && request.method!=='HEAD') return json({error:'method_not_allowed'},405);
    try {
      if(url.pathname==='/healthz') {
        if(env.HEALTH_TOKEN && !await authenticate(request,env.HEALTH_TOKEN)) return json({error:'unauthorized'},401);
        const status=JSON.parse(await stub(env).status()) as Awaited<ReturnType<Engine['status']>>;
        return json({ status:status.healthy?'ok':'degraded', checked_at:status.now, last_collector_tick:status.last_tick ?? null, reasons:status.reasons },status.healthy?200:503);
      }
      if(!env.STATUS_TOKEN) return json({error:'status_auth_not_configured'},503);
      if(!await authenticate(request,env.STATUS_TOKEN)) return new Response('Authentication required. Username: citilink.',{status:401,headers:{'WWW-Authenticate':'Basic realm="Citilink archive", charset="UTF-8"','Cache-Control':'no-store'}});
      if(url.pathname==='/') return new Response(dashboard,{headers:{
        'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy':'no-referrer',
      }});
      if(url.pathname==='/api/status') return json(JSON.parse(await stub(env).status()));
      if(url.pathname==='/api/plan') return json(rawPlan);
      if(url.pathname==='/api/archive') {
        const key=url.searchParams.get('key') ?? '';
        if(!/^(raw|diagnostics|runs|config|operations)\/[A-Za-z0-9_./-]+\.json$/.test(key) || key.includes('..') || key.length>512) return json({error:'invalid_object_key'},400);
        const object=await env.ARCHIVE.get(key);
        if(!object) return json({error:'not_found'},404);
        return new Response(request.method==='HEAD'?null:object.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="${key.split('/').at(-1)}"`}});
      }
      return json({error:'not_found'},404);
    } catch { return json({error:'service_unavailable'},503); }
  },
} satisfies ExportedHandler<Env>;
