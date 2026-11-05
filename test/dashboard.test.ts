import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {URL} from 'node:url';
import {readOnlySql,csv} from '../src/analytics/queries';
import {dateRange,starter,STARTERS} from '../src/analytics/catalog';
import {sessionCookie,validSession,tokenMatches} from '../src/analytics/auth';

test('read-only editor accepts joins, CTEs, aggregates, JSON, windows, and harmless text',()=>{
  for(const sql of [
    'SELECT route_id, COUNT(*) FROM analysis_vehicles GROUP BY route_id',
    'WITH x AS (SELECT * FROM analysis_predictions) SELECT * FROM x',
    'SELECT v.vehicle_id FROM analysis_vehicles v JOIN analysis_routes r ON v.route_id=r.route_id',
    'SELECT LAG(predicted_seconds_raw) OVER (PARTITION BY stop_id ORDER BY observed_at) FROM analysis_predictions',
    'SELECT LAG(vehicle_id) OVER (ORDER BY observed_at), SUM(vehicle_id) OVER () FROM analysis_vehicles',
    "SELECT 'OVER (ORDER BY x)' AS literal FROM analysis_vehicles",
    "SELECT json_extract(raw_json, '$.vitesse'), 'DROP TABLE imported_objects;' FROM analysis_vehicles",
    'SELECT * FROM analysis_vehicles UNION ALL SELECT * FROM analysis_vehicles',
    'SELECT * FROM json_each((SELECT raw_json FROM analysis_predictions LIMIT 1))',
    '/* comment */ SELECT 1;'
  ])assert.doesNotThrow(()=>readOnlySql(sql),sql);
});
test('server rejects writes, hidden data, multiple statements, recursion, and scope tricks',()=>{
  for(const sql of [
    'DELETE FROM vehicle_observations', 'UPDATE imported_objects SET status=\'complete\'',
    'PRAGMA query_only=OFF', 'ATTACH DATABASE \'x\' AS other',
    'SELECT 1; DELETE FROM vehicle_observations', 'SELECT 1; SELECT 2',
    'SELECT * FROM imported_objects', 'SELECT * FROM sqlite_master',
    'SELECT * FROM main.analysis_vehicles', 'SELECT * FROM pragma_table_info(\'imported_objects\')',
    'SELECT load_extension(\'x\')', 'SELECT readfile(\'x\')',
    'WITH x AS (DELETE FROM vehicle_observations RETURNING *) SELECT * FROM x',
    'WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT 1 FROM x) SELECT * FROM x',
    'WITH x AS (SELECT 1 UNION ALL SELECT 1 FROM x) SELECT * FROM x',
    'SELECT * FROM imported_objects WHERE EXISTS (WITH imported_objects AS (SELECT 1) SELECT 1)',
    'SELECT * FROM (SELECT * FROM imported_objects)',
    'WITH good AS (SELECT * FROM imported_objects) SELECT * FROM good',
    'SELECT randomblob(1000000000)'
  ])assert.throws(()=>readOnlySql(sql),sql);
});
test('CSV preserves quoting, Unicode, nulls and numbers while escaping spreadsheet formulas',()=>{
  const text=csv(['name','text'],[['Café','a,"b"\nc'],[null,-2],[' =HYPERLINK("bad")','@formula']]);
  assert(text.startsWith('\uFEFF'));assert(text.includes('"a,""b""\nc"'));assert(text.includes('"","-2"'));assert(text.includes('"\' =HYPERLINK'));assert(text.includes('"\'@formula"'));
});
test('starter date ranges use Indianapolis days, including 23/25-hour days',()=>{
  const fall=dateRange('2026-11-01','2026-11-01'),spring=dateRange('2026-03-08','2026-03-08');
  assert.equal(fall[1]-fall[0],25*3600000);assert.equal(spring[1]-spring[0],23*3600000);
  assert.deepEqual(dateRange('2026-11-03','2026-11-03'),[Date.parse('2026-11-03T05:00:00Z'),Date.parse('2026-11-04T05:00:00Z')]);
  assert.throws(()=>dateRange('2026-02-30','2026-03-01'));
  assert.throws(()=>starter(new URLSearchParams({route_id:'1 OR 1=1'})));
  for(const s of STARTERS)assert.doesNotThrow(()=>readOnlySql(starter(new URLSearchParams({name:s.id,from:'2026-11-03',to:'2026-11-03'}))));
  assert(starter(new URLSearchParams()).includes('is_visible = 1'));
  assert(!starter(new URLSearchParams({all_vehicles:'true'})).includes('is_visible = 1'));
});
test('browser sessions are signed, expire, rotate with the secret, and keep credentials HttpOnly',async()=>{
  const token='test-only-password-with-at-least-24-chars',now=Date.now(),cookie=await sessionCookie(token,now);
  const request=new Request('https://analytics.test/',{headers:{Cookie:cookie.split(';')[0]!}});
  assert(cookie.includes('HttpOnly; Secure; SameSite=Strict'));assert(await validSession(request,token,now));
  assert.equal(await validSession(request,token,now+9*3600000),false);assert.equal(await validSession(request,token+'changed',now),false);
  assert.equal(await tokenMatches(token,token),true);assert.equal(await tokenMatches(token+'!',token),false);
});
test('dashboard client parses as JavaScript',()=>{
  assert.doesNotThrow(()=>new Script(readFileSync(new URL('../src/analytics/ui/dashboard.js.txt',import.meta.url),'utf8')));
});
