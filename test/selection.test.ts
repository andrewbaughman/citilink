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
test('four-stop monthly plan fits daily budgets',()=>{
 const p=validatePlan(raw);assert.equal(estimatePlan(p).total,6360);assert.equal(estimatePlan(p).optional,2880);
 assert.equal(p.datasets.stop_predictions.schedule.interval_minutes,2);
});
test('each campaign resolves four distinct real stops with study route membership',()=>{
 for(const month of [10,11,12]){
  const chosen=resolveCampaign(selection,Date.UTC(2026,month,1),index);
  assert.equal(chosen.ids.length,4);assert.equal(new Set(chosen.ids).size,4);
  assert.equal(chosen.context.stops[0]!.code,'central-bay-N');
  assert(chosen.context.stops.slice(1).every(s=>s.routes.includes(chosen.context.route_mnemo)));
 }
});
test('monthly boundaries rotate only the study panel and wrap without maintenance',()=>{
 const november=resolveCampaign(selection,Date.UTC(2026,10,30,23,59),index);
 const december=resolveCampaign(selection,Date.UTC(2026,11,1),index);
 const february=resolveCampaign(selection,Date.UTC(2027,1,1),index);
 assert.equal(november.ids[0],december.ids[0]);assert.notDeepEqual(november.ids.slice(1),december.ids.slice(1));
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
 ]){const p=deployedPlan();change(p);assert.throws(()=>validatePlan(p));}
});
test('scheduled collection archives four raw JSON responses and immutable campaign metadata',async()=>{
 const r=rig(raw);r.setTime(Date.UTC(2026,10,1,12,0));
 const source=r.io.fetch;
 r.io.fetch=async(url,init)=>{
  if(url.includes('/restWS/topo?')){r.calls.push({url,at:r.now()});return new Response(JSON.stringify(topology));}
  if(url.includes('/horaires/pta/')){r.calls.push({url,at:r.now()});return new Response('{"listeHoraires":[]}');}
  return source(url,init);
 };
 await r.engine.tick(r.now());
 assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,4);
 const receipt=r.bucket.json('indexes/v1/stop_predictions/latest.json');
 assert.equal(receipt.outcome.succeeded,4);assert.equal(receipt.selection_context.id,'calhoun-northbound');
 assert.equal(receipt.selection_context.stops[0].role,'permanent_reference');
 for(const a of receipt.attempts){assert.equal(a.ok,true);assert.equal(a.storage_representation,'upstream_json');assert(a.object_key.endsWith('.json'));assert.deepEqual(r.bucket.json(a.object_key),{listeHoraires:[]});}
 const manifest=r.bucket.json(receipt.manifest_key);assert.deepEqual(manifest.selection_context,receipt.selection_context);
 r.setTime(Date.UTC(2026,10,1,12,1));await r.engine.tick(r.now());assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,4);
 r.setTime(Date.UTC(2026,10,1,12,2));await r.engine.tick(r.now());assert.equal(r.calls.filter(c=>c.url.includes('/horaires/pta/')).length,8);
});
