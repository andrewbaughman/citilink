import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inferVisits,associate,predictionSeries,clockEpoch,type Vehicle,type Prediction} from '../src/analytics/visits';
const stop={latitude:41,longitude:-85},at=Date.parse('2026-11-03T15:00:00Z');
const geometry=[[{latitude:40.99,longitude:-85},{latitude:41.01,longitude:-85}]];
function point(offset:number,index:number,vehicle=42):Vehicle {return {latitude:41+offset/111320,longitude:-85,vehicle_id:vehicle,route_id:9,destination_raw:'Terminal',observed_at:at+index*60000,heading_raw:0,is_visible:1,source_key:'source-'+index,raw_json:'{}'};}
function predictions(id=1,seconds=36120):Prediction[] {return [0,1].map(index=>({observed_at:at+index*60000,route_id:9,stop_id:123,destination_raw:'Terminal',destination_key_raw:'destination',prediction_id:id,predicted_seconds_raw:seconds,scheduled_seconds_raw:36120,etat_horaire:1,etat_passage:0,source_key:'prediction-'+index,raw_json:'{}'}));}
test('proximity window is bounded by observations and never presented as confirmed arrival',()=>{
  const visits=inferVisits([-220,-120,10,140,250].map((m,i)=>point(m,i)),stop,geometry,'study');
  assert.equal(visits.length,1);assert.equal(visits[0]!.arrival_start,at+60000);assert.equal(visits[0]!.arrival_end,at+120000);assert.equal(visits[0]!.confidence,'medium');
  assert(visits[0]!.estimated_at>=visits[0]!.arrival_start&&visits[0]!.estimated_at<=visits[0]!.arrival_end);
  const associated=associate(visits,predictionSeries(predictions()),'2026-11-03');assert.equal(associated[0]!.classification,'matched');
});
test('long gaps, stationary traces, hidden readings, and position jumps do not become trusted visits',()=>{
  const gap=[point(-200,0),point(200,5)];assert.equal(inferVisits(gap,stop,geometry,'gap').length,0);
  const stationary=Array.from({length:12},(_,i)=>point(5,i));assert(inferVisits(stationary,stop,geometry,'stationary').every(v=>v.confidence==='low'));
  const hidden=[point(-200,0),{...point(0,1),is_visible:0},point(200,2)];assert.equal(inferVisits(hidden,stop,geometry,'hidden')[0]!.confidence,'low');
  const jump=[point(-5000,0),point(0,1),point(5000,2)];assert.equal(inferVisits(jump,stop,geometry,'jump')[0]!.confidence,'low');
});
test('competing series and shared series stay ambiguous instead of choosing the smallest error',()=>{
  const trace=[point(-200,0),point(0,1),point(200,2)];
  const visits=inferVisits(trace,stop,geometry,'study');
  const competing=predictionSeries([...predictions(1),...predictions(2,36200)]);associate(visits,competing,'2026-11-03');assert.equal(visits[0]!.classification,'ambiguous');
  const shared=inferVisits([...trace,...trace.map(p=>({...p,vehicle_id:43}))],stop,geometry,'shared');associate(shared,predictionSeries(predictions()),'2026-11-03');assert(shared.every(v=>v.classification==='ambiguous'));
});
test('flagged and very wrong predictions stay inspectable but are not automatic matches',()=>{
  const visits=inferVisits([point(-200,0),point(0,1),point(200,2)],stop,geometry,'study');
  const rows=[...predictions(1,44000),...predictions(2).map(p=>({...p,etat_passage:1}))];
  associate(visits,predictionSeries(rows),'2026-11-03');assert.equal(visits[0]!.candidates.length,2);assert(visits[0]!.candidates.every(c=>!c.eligible));assert.notEqual(visits[0]!.classification,'matched');
});
test('candidate clock resolution does not invent times during DST gaps or repeats',()=>{
  assert.equal(clockEpoch('2026-03-08',2.5*3600,at),null);assert.equal(clockEpoch('2026-11-01',1.5*3600,at),null);
  assert.equal(clockEpoch('2026-11-03',10*3600,at),at);assert.equal(clockEpoch('2026-11-03',null,at),null);
});
