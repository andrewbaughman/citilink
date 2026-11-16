import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeServices,comparePrediction,type ComparisonPrediction} from '../src/analytics/comparison';
const p:ComparisonPrediction={observed_at:Date.parse('2026-11-16T16:00:00Z'),stop_id:277210,route_id:13863,stop_code:'1174',route_code:'8C',destination_raw:'Central Station - Bay A',destination_key_raw:'x',prediction_id:8307976,predicted_seconds_raw:40609,scheduled_seconds_raw:40748,etat_horaire:1,etat_passage:0,source_key:'test'};
test('GTFS comparison matches by schedule and preserves differences and estimated timepoints',()=>{
 const row=comparePrediction(p,'2026-11-16');
 assert.equal(row.match_status,'schedule_candidate');assert.equal(row.gtfs_seconds,40740);assert.equal(row.schedule_difference_seconds,8);assert.equal(row.prediction_difference_seconds,-131);assert.equal(row.api_adjustment_seconds,-139);assert.equal(row.timepoint,'0');
 // A very bad prediction still associates with the same timetable candidate.
 assert.equal(comparePrediction({...p,predicted_seconds_raw:44000},'2026-11-16').gtfs_trip_id,row.gtfs_trip_id);
});
test('calendar service, holiday exceptions and unsupported feed dates',()=>{
 assert(activeServices('2026-11-16').has('Service_Period-Weekday'));
 assert(activeServices('2026-11-21').has('Service_Period-Sa'));
 assert.equal(activeServices('2026-11-22').size,0);
 assert.equal(activeServices('2026-11-27').size,0);
 assert.equal(comparePrediction(p,'2027-01-01').match_status,'outside_feed_dates');
 assert.equal(comparePrediction(p,'2026-11-22').match_status,'no_schedule_match');
 assert.throws(()=>activeServices('2026-02-30'));
});
test('missing schedules, unknown stops/routes, flags and date ambiguity stay visible',()=>{
 assert.equal(comparePrediction({...p,scheduled_seconds_raw:0},'2026-11-16').match_status,'missing_api_schedule');
 assert.equal(comparePrediction({...p,stop_code:null},'2026-11-16').match_status,'missing_reference');
 assert.equal(comparePrediction({...p,stop_code:'unknown'},'2026-11-16').match_status,'no_schedule_match');
 assert.equal(comparePrediction({...p,etat_passage:1},'2026-11-16').status_flag,true);
 const wrongDate=comparePrediction({...p,observed_at:Date.parse('2026-11-17T04:58:00Z')},'2026-11-16');
 assert.equal(wrongDate.match_status,'outside_selected_service_date');
 assert.equal(comparePrediction({...p,predicted_seconds_raw:86399},'2026-11-16').prediction_difference_seconds,null);
});
