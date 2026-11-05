import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {ImportRepository,defaultState,startJob,step} from '../src/analytics/importer.ts';

const token='local-only-analytics-integration-secret';
const headers={Authorization:'Bearer '+token};
async function rig(t,bindings={IMPORT_TOKEN:token}) {
  const mf=new Miniflare(convertV4MiniflareOptions({name:'citilink-analytics',modules:true,scriptPath:'dist/analytics/index.js',compatibilityDate:'2026-10-30',durableObjects:{IMPORTER:{className:'ImportCoordinator',useSQLite:true}},r2Buckets:['ARCHIVE'],d1Databases:['DB'],bindings}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  // D1 exec accepts one SQL statement per line.
  const schema=readFileSync(new URL('../migrations/analytics/0001_initial.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean).map(s=>s+';').join('\n');
  await db.exec(schema);
  return {mf,db,bucket,repo:new ImportRepository(db,bucket)};
}
const vehicle={id:42,numeroEquipement:'0042',localisation:{lat:41.1,lng:-85.1,cap:180},conduite:{idLigne:9,vitesse:10,avanceRetard:'3 min late'},tauxRemplissage:20,vehiculeLoad:'20%',estAffichable:true};
function attempt(key,dataset='vehicles',id='a1') {return {attempt_id:id,dataset,stop_id:dataset==='stop_predictions'?123:undefined,scheduled_at:1000,requested_at:38000,completed_at:39000,ok:true,object_key:key};}
async function seed(bucket,attempts,suffix='01') {
  const key=`runs/v1/2026/11/03/05/${suffix}/run.json`;
  await bucket.put(key,JSON.stringify({run_id:suffix,slot:1000,finished_at:40000,plan_hash:'test',outcomes:{vehicles:{expected:1,succeeded:1,skipped:[]}},attempts}));return key;
}
async function drain(state,repo) {
  for(let n=0;state.job.status==='running' && n<200;n++)await step(state.job,repo);
  assert.notEqual(state.job.status,'running','job must terminate');
}
test('real R2/D1 backfill is repeatable, records empty/failing collections, and retries missing sources',async t=>{
  const {db,bucket,repo}=await rig(t);
  const key='raw/v1/vehicles/one.json',empty='raw/v1/vehicles/empty.json',missing='raw/v1/stop_predictions/missing.json';
  await bucket.put(key,JSON.stringify({vehicule:[vehicle]}));await bucket.put(empty,JSON.stringify({vehicule:[]}));
  const failed={...attempt('diagnostics/v1/failure.json','vehicles','failed'),ok:false,error:'upstream_timeout'};
  await seed(bucket,[attempt(key),attempt(empty,'vehicles','empty'),failed,attempt(missing,'stop_predictions','missing')]);
  const state=defaultState();startJob(state,Date.now()+180000);await drain(state,repo);
  assert.equal(state.job.status,'completed_with_errors');assert.equal((await db.prepare('SELECT COUNT(*) n FROM analysis_vehicles').first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM collection_results').first()).n,4);
  assert.equal((await db.prepare('SELECT row_count FROM imported_objects WHERE object_key=?').bind(empty).first()).row_count,0);
  await bucket.put(missing,JSON.stringify({listeHoraires:[]}));
  startJob(state,Date.now()+180000);await drain(state,repo);assert.equal(state.job.status,'completed');
  const before=await repo.totals();startJob(state,Date.now()+180000);await drain(state,repo);assert.deepEqual(await repo.totals(),before);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM collection_results').first()).n,4);
  // Older keys arriving after a prior completed scan are discovered on the next run.
  await seed(bucket,[attempt(key)],'00');startJob(state,Date.now()+180000);await drain(state,repo);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM collection_runs WHERE imported_at IS NOT NULL').first()).n,2);
});
test('interrupted object batches stay hidden and replay without duplicates',async t=>{
  const {db,bucket,repo}=await rig(t);
  const key='raw/v1/vehicles/many.json';await bucket.put(key,JSON.stringify({vehicule:Array.from({length:30},(_,i)=>({...vehicle,id:i}))}));
  const manifest=await seed(bucket,[attempt(key)]);await repo.manifest(manifest);
  let batches=0;
  const interrupted=new ImportRepository({prepare:sql=>db.prepare(sql),batch:statements=>{if(++batches===2)throw Error('simulated interruption');return db.batch(statements);}},bucket);
  await assert.rejects(interrupted.attempt(manifest,attempt(key)),/interruption/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM vehicle_observations').first()).n,25);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM analysis_vehicles').first()).n,0);
  await new ImportRepository(db,bucket).attempt(manifest,attempt(key));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM analysis_vehicles').first()).n,30);
});
test('reference versions deduplicate independently from repeated observations',async t=>{
  const {db,bucket,repo}=await rig(t);
  const topology={topo:[{ligne:[{idLigne:9,nomCommercial:'Route',mnemo:'R',itineraire:[{geometry:'kept in R2'}]}],pointArret:[{idPointArret:123,stopCode:'abc',nomCommercial:'Stop',localisation:{lat:41,lng:-85}}]}]};
  const a='raw/v1/full_topology/a.json',b='raw/v1/full_topology/b.json';
  await bucket.put(a,JSON.stringify(topology));await bucket.put(b,JSON.stringify(topology));
  const manifest=await seed(bucket,[]);await repo.manifest(manifest);
  await repo.attempt(manifest,attempt(a,'full_topology','top1'));await repo.attempt(manifest,attempt(b,'full_topology','top2'));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM reference_versions').first()).n,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM imported_objects WHERE reference_hash IS NOT NULL AND status='complete'").first()).n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM stops').first()).n,1);
  const key='raw/v1/vehicles/a.json',key2='raw/v1/vehicles/b.json';
  for(const k of [key,key2])await bucket.put(k,JSON.stringify({vehicule:[vehicle]}));
  await repo.attempt(manifest,attempt(key,'vehicles','v1'));await repo.attempt(manifest,attempt(key2,'vehicles','v2'));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM analysis_vehicles').first()).n,2);
});
test('Worker controls require auth, default off, persist settings, and stop/resume one job',async t=>{
  const {mf}=await rig(t);
  assert.equal((await mf.dispatchFetch('https://analytics.test/api/imports')).status,401);
  const get=async()=> (await mf.dispatchFetch('https://analytics.test/api/imports',{headers})).json();
  assert.equal((await get()).settings.daily_enabled,false);
  const put=await mf.dispatchFetch('https://analytics.test/api/imports/settings',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({daily_enabled:true,daily_time:'04:15'})});
  assert.equal(put.status,200);assert.equal((await get()).settings.daily_time,'04:15');
  const start=()=>mf.dispatchFetch('https://analytics.test/api/imports/start',{method:'POST',headers});
  const first=await (await start()).json(),again=await (await start()).json();assert.equal(first.job.id,again.job.id);
  const stopped=await (await mf.dispatchFetch('https://analytics.test/api/imports/stop',{method:'POST',headers})).json();assert.equal(stopped.job.status,'stopped');
  assert.equal(stopped.settings.daily_enabled,true);
  const resumed=await (await start()).json();assert.equal(resumed.job.id,first.job.id);
  assert.equal((await mf.dispatchFetch('https://analytics.test/api/imports/settings',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:'{"daily_enabled":true,"daily_time":"99:00"}'})).status,400);
});
test('alarm imports in the Worker runtime and settings survive a complete runtime restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'citilink-import-test-'));
  const options=convertV4MiniflareOptions({name:'citilink-analytics',modules:true,scriptPath:'dist/analytics/index.js',compatibilityDate:'2026-10-30',durableObjects:{IMPORTER:{className:'ImportCoordinator',useSQLite:true}},r2Buckets:['ARCHIVE'],d1Databases:['DB'],bindings:{IMPORT_TOKEN:token},});
  options.resourcePersistencePath=directory;
  let mf=new Miniflare(options);
  t.after(async()=>{await mf.dispose();rmSync(directory,{recursive:true,force:true});});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  const schema=readFileSync(new URL('../migrations/analytics/0001_initial.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean).map(s=>s+';').join('\n');await db.exec(schema);
  const source='raw/v1/vehicles/runtime.json';await bucket.put(source,JSON.stringify({vehicule:[vehicle]}));await seed(bucket,[attempt(source)]);
  await mf.dispatchFetch('https://analytics.test/api/imports/settings',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({daily_enabled:false,daily_time:'04:45'})});
  await mf.dispatchFetch('https://analytics.test/api/imports/start',{method:'POST',headers});
  let status;
  for(let i=0;i<100;i++) {
    status=await (await mf.dispatchFetch('https://analytics.test/api/imports',{headers})).json();
    if(status.job.status==='completed')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(status.job.status,'completed');assert.equal((await db.prepare('SELECT COUNT(*) n FROM analysis_vehicles').first()).n,1);
  const jobId=status.job.id;await mf.dispose();mf=new Miniflare(options);
  const restored=await (await mf.dispatchFetch('https://analytics.test/api/imports',{headers})).json();
  assert.equal(restored.settings.daily_enabled,false);assert.equal(restored.settings.daily_time,'04:45');assert.equal(restored.job.id,jobId);assert.equal(restored.job.status,'completed');
});
