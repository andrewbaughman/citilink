import { URL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/collector';
import { MAX_BODY_BYTES, readBody, sha256 } from '../src/archive';
import { bodies, plan, rig } from './helpers';

function vehicleOnly() {
  const p=plan();for(const d of Object.values(p.datasets) as any[])d.enabled=false;
  p.datasets.vehicles.enabled=true;return p;
}
test('all uploaded successful JSON samples are saved byte-for-byte, irrespective of MIME type',async()=>{
  const names:Record<string,string>={'/topo/vehicules':'topo_vehicules.json','/topo/refresh':'topo_refresh.json','/iv/message':'iv_message.json','/config/version':'config_version.json','/topo':'topo.json'};
  for(const [path,name] of Object.entries(names)) {
    const p=plan();for(const [id,d] of Object.entries(p.datasets) as [string,any][]){d.enabled=id!=='stop_predictions';d.schedule={interval_minutes:1,phase_minute:0};}
    p.datasets.full_topology.triggers.min_gap_minutes=1;
    const r=rig(p), bytes=readFileSync(new URL('../api-discovery/raw/'+name,import.meta.url));
    const upstream = r.io.fetch;
    r.io.fetch=async(url,init)=>url.includes('/restWS'+path+'?')?new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}}):upstream(url,init);
    await r.engine.tick(r.now());
    const records=[...r.bucket.values].filter(([key])=>key.startsWith('raw/') && key.endsWith('.json'));
    assert(records.some(([,v])=>Buffer.from(v).equals(bytes)),name);
    for(const [key,value] of r.bucket.values) { assert(key.endsWith('.json'));assert.doesNotThrow(()=>JSON.parse(Buffer.from(value).toString())); }
  }
});
test('sequential pacing and duplicate scheduled delivery do not issue extra requests',async()=>{
  const r=rig();const slot=r.now();await r.engine.tick(slot);
  assert.equal(r.calls.length,3); // vehicles, refresh, bootstrap topology
  for(let i=1;i<r.calls.length;i++)assert(r.calls[i]!.at-r.calls[i-1]!.at>=1000);
  assert.equal((await r.engine.tick(slot)).status,'duplicate');
  assert.equal(r.calls.length,3);
});
test('HTML and binary/partial bodies are retained in valid JSON diagnostics',async()=>{
  const r=rig(vehicleOnly());
  const original=Buffer.from('<html>upstream error</html>');
  r.io.fetch=async url=>{r.calls.push({url,at:r.now()});return new Response(original,{status:502});};
  await r.engine.tick(r.now());
  const diagnostics=[...r.bucket.values.keys()].filter(k=>k.startsWith('diagnostics/'));
  assert.equal(diagnostics.length,2);
  for(const key of diagnostics) assert.deepEqual(Buffer.from(r.bucket.json(key).body_base64,'base64'),original);
  const s=await r.engine.status();assert.equal(s.datasets.vehicles && (s.datasets.vehicles as any).last_success_slot,undefined);
});
test('stream read errors preserve captured bytes and never mark a partial body complete',async()=>{
  const body = new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([0,255,12]));},pull(c){c.error(Error('broken'));}});
  const result=await readBody(new Response(body));
  assert.equal(result.complete,false);assert.equal(result.error,'body_stream_failed');assert.deepEqual([...result.bytes],[0,255,12]);
});
test('response-size safeguard is explicit, retaining only a labeled partial body',async()=>{
  const result=await readBody(new Response(new Uint8Array(MAX_BODY_BYTES+1)));
  assert.equal(result.complete,false);assert.equal(result.error,'response_size_limit_exceeded');assert.equal(result.bytes.length,MAX_BODY_BYTES);
});
test('429 pauses all upstream requests, survives restart, and allows only a recovery probe',async()=>{
  const r=rig();r.io.fetch=async url=>{r.calls.push({url,at:r.now()});return new Response('{"error":"rate limited"}',{status:429,headers:{'Retry-After':'600'}});};
  const slot=r.now();await r.engine.tick(slot);assert.equal(r.calls.length,1);
  r.advance(60000);const restarted=new Engine(r.store,r.bucket,r.raw,r.io);await restarted.tick(slot+60000);
  assert.equal(r.calls.length,1);assert((await restarted.status()).cooldown_until>r.now());
  r.setTime(slot+601000);
  r.io.fetch=async url=>{r.calls.push({url,at:r.now()});return new Response('{}',{status:500});};
  await restarted.tick(slot+600000);assert.equal(r.calls.length,2);
  assert((await restarted.status()).cooldown_until>r.now());
});
test('hard daily budget counts failures and prevents a retry over the cap',async()=>{
  const p=vehicleOnly();p.global.max_requests_per_utc_day=1440;p.global.reserved_essential_requests_per_utc_day=1440;
  const r=rig(p);await r.engine.status();const state=r.store.state();state.budget.total=1439;await r.store.put('state',state);
  const restarted=new Engine(r.store,r.bucket,p,r.io);
  r.io.fetch=async url=>{r.calls.push({url,at:r.now()});return new Response('{}',{status:500});};
  await restarted.tick(r.now());assert.equal(r.calls.length,1);assert.equal((await restarted.status()).budget.total,1440);
});
test('essential reservation prevents optional work consuming protected request capacity',async()=>{
  const p=vehicleOnly();p.datasets.vehicles.schedule.interval_minutes=60;
  const stops=p.datasets.stop_predictions;stops.enabled=true;stops.schedule={interval_minutes:1,phase_minute:0};stops.selection={mode:'fixed',stop_ids:[123],max_stops_per_cycle:1};
  p.global.max_requests_per_utc_day=1464;p.global.reserved_essential_requests_per_utc_day=24;stops.max_requests_per_utc_day=1440;
  const r=rig(p);await r.engine.status();const state=r.store.state();state.roster=[123];state.budget.total=1440;state.budget.optional=1440;await r.store.put('state',state);
  await new Engine(r.store,r.bucket,p,r.io).tick(r.now());assert.equal(r.calls.length,1);assert(r.calls[0]!.url.includes('/vehicules'));
});
test('actual UTC-day rollover resets budgets but retains request-start spacing',async()=>{
  const r=rig(vehicleOnly());r.setTime(Date.UTC(2026,9,31,23,59,59,500));await r.engine.tick(r.now());
  assert.equal((await r.engine.status()).budget.total,1);
  r.advance(500);await r.engine.tick(r.now());
  assert.equal((await r.engine.status()).budget.day,'2026-11-01');assert.equal((await r.engine.status()).budget.total,1);
  assert(r.calls[1]!.at-r.calls[0]!.at>=1000);
});
test('overlapping invocations have one collector and no unmetered duplicate fetch',async()=>{
  const r=rig(vehicleOnly());let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  r.io.fetch=async url=>{r.calls.push({url,at:r.now()});await blocked;return new Response(bodies['/topo/vehicules']);};
  const tick=r.engine.tick(r.now());
  while(!r.calls.length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await r.engine.tick(r.now())).status,'busy');release();await tick;assert.equal(r.calls.length,1);
});
test('fixed and rotating prediction panels use the archived roster and remain bounded',async()=>{
  for(const mode of ['fixed','round_robin']){
    const p=plan();for(const [id,d] of Object.entries(p.datasets) as [string,any][]){d.schedule={interval_minutes:1,phase_minute:0};d.enabled=['vehicles','full_topology','stop_predictions'].includes(id);}
    p.datasets.full_topology.triggers.min_gap_minutes=1;
    p.datasets.stop_predictions.enabled=true;p.datasets.stop_predictions.selection={mode,stop_ids:mode==='fixed'?[123]:[],max_stops_per_cycle:1};
    const r=rig(p);await r.engine.tick(r.now());
    const stopCalls=r.calls.filter(c=>c.url.includes('/horaires/pta/'));assert.equal(stopCalls.length,1);assert(stopCalls[0]!.url.includes('/123?'));
    const manifest=r.bucket.json((await r.engine.status()).last_manifest!);assert(manifest.roster_reference.startsWith('raw/v1/full_topology'));assert.deepEqual(manifest.selected_stops,[123]);
    if(mode==='round_robin'){r.setTime(Date.UTC(2026,9,31,12,1));await r.engine.tick(r.now());assert(r.calls.some(c=>c.url.includes('/456?')));}
  }
});
test('R2 failure stops upstream work and keeps health degraded until storage and observations recover',async()=>{
  const r=rig();await r.engine.status();r.bucket.fail=k=>k.startsWith('raw/');
  await r.engine.tick(r.now());assert.equal(r.calls.length,1);assert.equal((await r.engine.status()).healthy,false);
  r.bucket.fail=()=>true;r.advance(60000);await r.engine.tick(r.now());assert.equal(r.calls.length,1);
});
test('failed manifest remains recoverable after restart, without refetching its historical observations',async()=>{
  const r=rig(vehicleOnly());await r.engine.status();r.bucket.fail=k=>k.startsWith('runs/');
  const slot=r.now();await r.engine.tick(slot);assert.equal(r.calls.length,1);assert(r.store.state().active_run);
  r.bucket.fail=()=>false;r.advance(60000);
  const restarted=new Engine(r.store,r.bucket,r.raw,r.io);await restarted.tick(slot+60000);
  assert.equal(r.calls.length,2);assert.equal([...r.bucket.values.keys()].filter(k=>k.startsWith('raw/')).length,2);
  const manifests=[...r.bucket.values.keys()].filter(k=>k.startsWith('runs/'));assert.equal(manifests.length,2);
});
test('transient config-archive failure recovers on the next tick',async()=>{
  const r=rig(vehicleOnly());r.bucket.fail=k=>k.startsWith('config/');await r.engine.tick(r.now());assert.equal(r.calls.length,0);
  r.bucket.fail=()=>false;r.advance(60000);await r.engine.tick(r.now());assert.equal(r.calls.length,1);
});
test('health uses dataset cadence and recovers only after the configured good windows',async()=>{
  const p=vehicleOnly();p.datasets.vehicles.schedule.interval_minutes=5;
  const r=rig(p);await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,true);
  r.advance(4*60000); // refresh heartbeat without making another five-minute observation
  await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,true);
  r.advance(4*60000);await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,false);
  r.setTime(Date.UTC(2026,9,31,12,10));await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,false);
  r.setTime(Date.UTC(2026,9,31,12,15));await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,true);
});
test('disabled datasets are omitted from health failures and stale invocations are never backfilled',async()=>{
  const p=vehicleOnly(),r=rig(p);await r.engine.tick(r.now());assert.equal((await r.engine.status()).healthy,true);
  r.advance(5*60000);await r.engine.tick(r.now()-180000);assert.equal(r.calls.length,1);
  const s=await r.engine.status();assert.equal(s.healthy,false);assert.deepEqual(s.reasons,['vehicles_unhealthy']);
});
test('object checksums match the unchanged JSON payload',async()=>{
  const r=rig(vehicleOnly());await r.engine.tick(r.now());const s=await r.engine.status();
  const a=r.bucket.json(s.last_manifest!).attempts[0];
  assert.equal(a.body_sha256,await sha256(bodies['/topo/vehicules']!));assert.equal(a.body_sha256,a.object_sha256);
});
test('re-enabling a dataset uses its new first-due deadline, not an old observation',async()=>{
 const p=vehicleOnly(),r=rig(p);await r.engine.tick(r.now());
 p.datasets.vehicles.enabled=false;r.advance(3600000);
 await new Engine(r.store,r.bucket,p,r.io).tick(r.now());
 p.datasets.vehicles.enabled=true;p.datasets.vehicles.schedule={interval_minutes:60,phase_minute:30};
 const restarted=new Engine(r.store,r.bucket,p,r.io);const s=await restarted.status();
 const vehicles=s.datasets.vehicles as any;
 assert.equal(vehicles.warming_up,true);assert.equal(vehicles.incident,false);assert(vehicles.deadline>r.now());
});
