import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {buildStopIndex,campaignAt,resolveCampaign} from '../src/selection';
import {validatePlan,estimatePlan} from '../src/plan';
import {deployedPlan,rig,bodies} from './helpers';
const raw=deployedPlan();
const selection=validatePlan(raw).datasets.stop_predictions.selection;
const topology=JSON.parse(readFileSync(new URL('../api-discovery/raw/topo.json',import.meta.url),'utf8'));
const index=buildStopIndex(topology);
test('eight-stop monthly plan preserves live vehicle cadence and fits budgets',()=>{
 const p=validatePlan(raw);assert.equal(estimatePlan(p).total,10680);assert.equal(estimatePlan(p).optional,5760);
 assert.equal(p.datasets.stop_predictions.schedule.interval_minutes,2);
 assert.equal(p.datasets.vehicles.schedule.interval_minutes,0.5);
 assert.equal(p.global.max_requests_per_utc_day,13000);
 assert.equal(p.datasets.stop_predictions.max_requests_per_utc_day,7000);
});
test('each campaign resolves eight distinct real stops with study route membership',()=>{
 for(const month of [10,11,12]){
  const chosen=resolveCampaign(selection,Date.UTC(2026,month,1),index);
  assert.equal(chosen.ids.length,8);assert.equal(new Set(chosen.ids).size,8);
  assert.deepEqual(chosen.context.stops.filter(s=>s.role==='permanent_reference').map(s=>s.code),['central-bay-N','792','123457','434','70']);
  assert(chosen.context.stops.filter(s=>s.role==='study').every(s=>s.routes.includes(chosen.context.route_mnemo)));
 }
});
test('monthly boundaries rotate only the study panel and wrap without maintenance',()=>{
 const november=resolveCampaign(selection,Date.UTC(2026,10,30,23,59),index);
 const december=resolveCampaign(selection,Date.UTC(2026,11,1),index);
 const february=resolveCampaign(selection,Date.UTC(2027,1,1),index);
 assert.equal(november.ids.slice(0,5).join(),december.ids.slice(0,5).join());assert.notDeepEqual(november.ids.slice(5),december.ids.slice(5));
 assert.deepEqual(november.ids,february.ids);assert.throws(()=>campaignAt(selection,Date.UTC(2026,9,31)),/not_started/);
});
test('stable codes survive numeric-ID changes; missing, ambiguous, and wrong-route stops fail closed',()=>{
 const original=resolveCampaign(selection,Date.UTC(2026,10,1),index);
 const updated=structuredClone(index);for(const entry of Object.values(updated))entry.id+=100000;
 assert.deepEqual(resolveCampaign(selection,Date.UTC(2026,10,1),updated).ids,original.ids.map(id=>id+100000));
 const missing=structuredClone(index);delete missing['1174'];assert.throws(()=>resolveCampaign(selection,Date.UTC(2026,10,1),missing),/unavailable/);
 const wrong=structuredClone(index);wrong['1174']!.routes=[];assert.throws(()=>resolveCampaign(selection,Date.UTC(2026,10,1),wrong),/membership/);
 const duplicate=buildStopIndex({topo:[{pointArret:[{stopCode:'x',idPointArret:1},{stopCode:'x',idPointArret:2}]}]});assert.equal(duplicate.x,undefined);
});
test('reject campaign collisions and extra requests',()=>{
 for(const change of [
  (p:any)=>p.datasets.stop_predictions.selection.campaigns[0].study_stop_codes.push('extra'),
  (p:any)=>p.datasets.stop_predictions.selection.campaigns[0].study_stop_codes[0]='central-bay-N',
  (p:any)=>p.datasets.stop_predictions.selection.starts_month='2026-13',
  (p:any)=>p.datasets.stop_predictions.selection.max_stops_per_cycle=5,
  (p:any)=>p.datasets.stop_predictions.selection.permanent_stop_codes.push('792'),
  (p:any)=>p.datasets.stop_predictions.selection.permanent_stop_codes=[],
  (p:any)=>p.datasets.stop_predictions.selection.campaigns[1].study_stop_codes[0]='434',
  (p:any)=>p.datasets.stop_predictions.selection.permanent_stop_code='central-bay-N',
  (p:any)=>p.datasets.stop_predictions.selection.permanent_stop_codes='792',
  (p:any)=>p.global.max_requests_per_utc_day=10000,
  (p:any)=>p.datasets.stop_predictions.max_requests_per_utc_day=5000,
 ]){const p=deployedPlan();change(p);assert.throws(()=>validatePlan(p));}
});
test('scheduled collection archives eight raw JSON responses and immutable campaign metadata',async()=>{
 const r=rig(raw);r.setTime(Date.UTC(2026,10,1,12,0));
 const source=r.io.fetch;
 r.io.fetch=async(url,init)=>{
  if(url.includes('/restWS/topo?')){r.calls.push({url,at:r.now()});return new Response(JSON.stringify(topology));}
  if(url.includes('/horaires/pta/')){r.calls.push({url,at:r.now()});return new Response('{"listeHoraires":[]}');}
  return source(url,init);
 };
 await r.engine.tick(r.now());
 assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,8);
 const receipt=r.bucket.json('indexes/v1/stop_predictions/latest.json');
 assert.equal(receipt.outcome.succeeded,8);assert.equal(receipt.selection_context.id,'calhoun-northbound');
 assert.equal(receipt.selection_context.stops[0].role,'permanent_reference');
 for(const a of receipt.attempts){assert.equal(a.ok,true);assert.equal(a.storage_representation,'upstream_json');assert(a.object_key.endsWith('.json'));assert.deepEqual(r.bucket.json(a.object_key),{listeHoraires:[]});}
 const manifest=r.bucket.json(receipt.manifest_key);assert.deepEqual(manifest.selection_context,receipt.selection_context);
 r.setTime(Date.UTC(2026,10,1,12,0,30));await r.engine.tick(r.now());assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,8);
 assert.equal(r.calls.filter(c=>c.url.includes('/topo/vehicules')).length,2);
 r.setTime(Date.UTC(2026,10,1,12,1));await r.engine.tick(r.now());assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,8);
 r.setTime(Date.UTC(2026,10,1,12,2));await r.engine.tick(r.now());assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,16);
});

test('legacy single permanent stop plans still resolve four stops',()=>{
 const legacy=deployedPlan();const s=legacy.datasets.stop_predictions.selection;
 delete s.permanent_stop_codes;s.permanent_stop_code='central-bay-N';s.max_stops_per_cycle=4;
 const p=validatePlan(legacy);assert.equal(resolveCampaign(p.datasets.stop_predictions.selection,Date.UTC(2026,10,1),index).ids.length,4);
});
test('missing permanent codes and aliased stop IDs fail visibly',()=>{
 const missing=structuredClone(index);delete missing['792'];assert.throws(()=>resolveCampaign(selection,Date.UTC(2026,10,1),missing),/unavailable/);
 const alias=structuredClone(index);alias['792']!.id=alias['434']!.id;assert.throws(()=>resolveCampaign(selection,Date.UTC(2026,10,1),alias),/distinct/);
});
