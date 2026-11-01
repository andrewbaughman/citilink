import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePlan, retryAfter, validatePlan } from '../src/plan';
import { plan } from './helpers';
test('disabled-prediction fixture is 3480/day; legacy ten-stop panel is 6360/day',()=>{
  const p=plan();assert.equal(estimatePlan(validatePlan(p)).total,3480);
  p.datasets.stop_predictions.enabled=true;p.datasets.stop_predictions.selection.stop_ids=Array.from({length:10},(_,i)=>i+1);
  assert.equal(estimatePlan(validatePlan(p)).total,6360);
});
test('rejects unknown settings, implicit all-stop scans, invalid phases, and unsafe global settings',()=>{
  for(const change of [
    (p:any)=>p.datasets.vehicles.schedul={},
    (p:any)=>p.datasets.stop_predictions.selection.mode='all',
    (p:any)=>p.datasets.vehicles.schedule.phase_minute=1,
    (p:any)=>p.global.max_in_flight=2,
    (p:any)=>p.global.min_request_spacing_ms=0,
    (p:any)=>p.global.catch_up=true,
    (p:any)=>p.global.honor_retry_after=false,
    (p:any)=>p.datasets.stop_predictions.enabled=true,
    (p:any)=>p.global.max_requests_per_utc_day=3000,
  ]) {const p=plan();change(p);assert.throws(()=>validatePlan(p));}
});
test('changing one cadence inherits unrelated defaults and preserves other schedules',()=>{
  const p=plan();p.datasets.service_messages.schedule.interval_minutes=15;p.datasets.service_messages.timeout_seconds=2;
  const normalized=validatePlan(p);assert.equal(normalized.datasets.vehicles.schedule.interval_minutes,1);
  assert.equal(normalized.datasets.service_messages.timeout_seconds,2);assert.equal(normalized.datasets.service_messages.retry.max_attempts,2);
});
test('optional traffic cannot consume reserved essential headroom',()=>{
  const p=plan();p.global.reserved_essential_requests_per_utc_day=7999;
  p.datasets.stop_predictions.enabled=true;p.datasets.stop_predictions.selection.stop_ids=[123];assert.throws(()=>validatePlan(p),/unreserved/);
});
test('Retry-After accepts seconds/date, rejects junk, and remains finite for huge delays',()=>{
  const now=Date.UTC(2026,9,31);assert.equal(retryAfter('120',now),now+120000);
  assert.equal(retryAfter(new Date(now+60000).toUTCString(),now),now+60000);
  assert.equal(retryAfter('nonsense',now),undefined);assert(Number.isFinite(retryAfter('9'.repeat(400),now)));
});

test('topology event spacing must not exceed its configured polling interval',()=>{
 const p=plan();p.datasets.full_topology.schedule.interval_minutes=5;p.datasets.full_topology.schedule.phase_minute=0;
 assert.throws(()=>validatePlan(p),/trigger spacing/);
});
