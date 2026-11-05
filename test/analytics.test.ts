import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vehicleRows,predictionRows,delay} from '../src/analytics/normalize';
import {defaultState,dailyDue,nextDaily,startJob,validateSettings} from '../src/analytics/importer';
const capture={key:'raw/v1/vehicles/test.json',scheduled_at:1000,requested_at:38000,stop_id:123};
test('provisional translations preserve raw values and flag uncertainty',()=>{
  const v={id:12,numeroEquipement:'0012',localisation:{lat:41,lng:-85,cap:359},conduite:{idLigne:7,vitesse:816,avanceRetard:'1h+ late'},tauxRemplissage:0,vehiculeLoad:null,estAffichable:false};
  const row=vehicleRows({vehicule:[v]},capture)[0]!;
  assert.equal(row.values[3],38000);assert.equal(row.values[5],'0012');assert.equal(row.values[13],null);assert.equal(row.values[14],60);assert.equal(row.values[17],null);
  assert.deepEqual(JSON.parse(row.values.at(-1) as string),v);assert((row.values.at(-2) as string).includes('raw_speed_outlier'));
  assert.deepEqual(delay('on time'),[null,null]);assert.deepEqual(delay('2 min early'),[-2,null]);
  const p={idHoraire:45,horaire:20948,horaireApplicable:0,etatHoraire:0,etatPassage:1};
  const rows=predictionRows({listeHoraires:[{idLigne:7,destination:[{libelle:' A  B ',libelleHexa:'1234',horaires:[p,p]}]}]},capture);
  assert.equal(rows[0]!.values[6],' A  B ');assert.equal(rows[0]!.values[11],null);assert.equal(rows[0]!.values[14],null);
  assert((rows[0]!.values[15] as string).includes('struck_through'));assert.notEqual(rows[0]!.path,rows[1]!.path);
  assert.deepEqual(vehicleRows({vehicule:[]},capture),[]);assert.throws(()=>vehicleRows({error:'bad'},capture));
});
test('daily imports default off; schedule validation and start/resume are stable',()=>{
  const state=defaultState(),now=Date.parse('2026-11-03T09:00:00Z');
  assert.equal(dailyDue(state,now),false);assert.equal(nextDaily(state,now),null);
  startJob(state,now);const id=state.job!.id;startJob(state,now);assert.equal(state.job!.id,id);
  state.job!.status='stopped';state.job!.attempt=2;startJob(state,now+1000);assert.equal(state.job!.attempt,2);assert.equal(state.job!.id,id);
  assert.throws(()=>validateSettings({daily_enabled:true,daily_time:'25:00'}));
});
test('local schedules survive spring gaps, fall repeats, midnight, and delayed ticks',()=>{
  const s=defaultState();s.settings={daily_enabled:true,daily_time:'02:30',timezone:'America/Indiana/Indianapolis'};
  // March 8, 2026 jumps directly from 01:59 to 03:00: catch up at 03:00.
  assert.equal(dailyDue(s,Date.parse('2026-03-08T06:59:00Z')),false);
  assert.equal(dailyDue(s,Date.parse('2026-03-08T07:00:00Z')),true);
  s.settings.daily_time='01:30';
  assert.equal(dailyDue(s,Date.parse('2026-11-01T05:30:00Z')),true);
  s.last_daily_date='2026-11-01';assert.equal(dailyDue(s,Date.parse('2026-11-01T06:30:00Z')),false);
  s.settings.daily_time='03:00';s.last_daily_date='2026-11-02';
  assert.equal(dailyDue(s,Date.parse('2026-11-03T08:20:00Z')),true);
  assert.equal(dailyDue(s,Date.parse('2026-11-03T05:00:00Z')),false);
  assert.equal(nextDaily(s,Date.parse('2026-11-03T05:00:00Z')),Date.parse('2026-11-03T08:00:00Z'));
});
