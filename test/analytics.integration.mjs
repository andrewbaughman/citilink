import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Script,createContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
import {ImportRepository,defaultState,startJob,step} from '../src/analytics/importer.ts';

const token='local-only-analytics-integration-secret';
const headers={Authorization:'Bearer '+token};
function withAssets(options) {
  const manifest=options.workers[0].config.manifest;
  for(const file of readdirSync('dist/analytics').filter(f=>/\.(html|css|txt)$/.test(f)))manifest.modules['dist/analytics/'+file]={type:'text',contents:readFileSync('dist/analytics/'+file,'utf8')};
  return options;
}
async function rig(t,bindings={IMPORT_TOKEN:token},outboundService) {
  const mf=new Miniflare(withAssets(convertV4MiniflareOptions({name:'citilink-analytics',modules:true,scriptPath:'dist/analytics/index.js',compatibilityDate:'2026-10-30',durableObjects:{IMPORTER:{className:'ImportCoordinator',useSQLite:true}},r2Buckets:['ARCHIVE'],d1Databases:['DB'],bindings,...(outboundService?{outboundService}:{})})));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  // D1 exec accepts one SQL statement per line.
  const schema=readdirSync(new URL('../migrations/analytics/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort().map(f=>readFileSync(new URL('../migrations/analytics/'+f,import.meta.url),'utf8')).join('\n').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean).map(s=>s+';').join('\n');
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
  withAssets(options);
  options.resourcePersistencePath=directory;
  let mf=new Miniflare(options);
  t.after(async()=>{await mf.dispose();rmSync(directory,{recursive:true,force:true});});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARCHIVE');
  const schema=readdirSync(new URL('../migrations/analytics/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort().map(f=>readFileSync(new URL('../migrations/analytics/'+f,import.meta.url),'utf8')).join('\n').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean).map(s=>s+';').join('\n');await db.exec(schema);
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
test('dashboard signs in with an HttpOnly session and rejects cross-origin mutations',async t=>{
  const {mf}=await rig(t);
  const signIn=await mf.dispatchFetch('https://analytics.test/');assert.equal(signIn.status,200);assert((await signIn.text()).includes('name="password"'));
  assert.equal((await mf.dispatchFetch('https://analytics.test/api/analysis/schema')).status,401);
  const login=await mf.dispatchFetch('https://analytics.test/login',{method:'POST',headers:{Origin:'https://analytics.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:token}).toString(),redirect:'manual'});
  assert.equal(login.status,303);const cookie=login.headers.get('Set-Cookie');assert(cookie.includes('HttpOnly'));assert(cookie.includes('SameSite=Strict'));
  const session={Cookie:cookie.split(';')[0]};
  const page=await mf.dispatchFetch('https://analytics.test/',{headers:session});assert.equal(page.status,200);assert((await page.text()).includes('Export query CSV'));assert(!page.headers.get('Content-Security-Policy').includes('unsafe-inline'));
  assert.equal((await mf.dispatchFetch('https://analytics.test/assets/dashboard.js')).status,200);
  const schema=await (await mf.dispatchFetch('https://analytics.test/api/analysis/schema',{headers:session})).json();assert.equal(schema.tables.length,8);assert(schema.tables.find(t=>t.name==='analysis_vehicles').columns.find(c=>c.name==='speed_raw').description.includes('unconfirmed'));
  assert.equal((await mf.dispatchFetch('https://analytics.test/api/imports/start',{method:'POST',headers:{...session,Origin:'https://other.test'}})).status,403);
  const saved=await mf.dispatchFetch('https://analytics.test/api/imports/settings',{method:'PUT',headers:{...session,Origin:'https://analytics.test','Content-Type':'application/json'},body:JSON.stringify({daily_enabled:false,daily_time:'05:30'})});assert.equal(saved.status,200);
  const logout=await mf.dispatchFetch('https://analytics.test/logout',{method:'POST',headers:{...session,Origin:'https://analytics.test'},redirect:'manual'});assert.equal(logout.status,303);assert(logout.headers.get('Set-Cookie').includes('Max-Age=0'));
  const fakeJwt=await mf.dispatchFetch('https://analytics.test/api/analysis/schema',{headers:{'Cf-Access-Jwt-Assertion':'fake'}});assert.equal(fakeJwt.status,401);
});
test('read-only query API and CSV enforce independent caps without exposing bookkeeping or permitting writes',async t=>{
  const {mf,db}=await rig(t);
  await db.prepare("INSERT INTO imported_objects(object_key,dataset,scheduled_at,requested_at,status,row_count) VALUES('test-source','vehicles',1793682000000,1793682037000,'complete',10005)").run();
  await db.prepare("WITH RECURSIVE seq(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10005) INSERT INTO vehicle_observations(source_key,row_path,scheduled_at,observed_at,vehicle_id,route_id,is_visible,quality_flags_json,raw_json) SELECT 'test-source',CAST(n AS TEXT),1793682000000,1793682037000,n,9,1,'[]','{}' FROM seq").run();
  const post=(path,sql)=>mf.dispatchFetch('https://analytics.test'+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({sql})});
  const sql='SELECT vehicle_id, observed_at FROM analysis_vehicles ORDER BY vehicle_id';
  const preview=await post('/api/analysis/query',sql);assert.equal(preview.status,200);const result=await preview.json();assert.equal(result.rows.length,500);assert.equal(result.truncated,true);assert.deepEqual(result.columns,['vehicle_id','observed_at']);
  const exported=await post('/api/analysis/export',sql);assert.equal(exported.status,200);assert.equal(exported.headers.get('X-Result-Truncated'),'true');assert.equal(exported.headers.get('X-Result-Rows'),'10000');const contents=await exported.text();assert.equal(contents.trim().split('\r\n').length,10001);assert(contents.includes('"10000"'));
  const short=await post('/api/analysis/export','SELECT COUNT(*) AS observations FROM analysis_vehicles');assert.equal(short.headers.get('X-Result-Truncated'),'false');assert((await short.text()).includes('10005'));
  const revision=await post('/api/analysis/query','WITH sample AS (SELECT vehicle_id FROM analysis_vehicles LIMIT 3) SELECT vehicle_id, LAG(vehicle_id) OVER (ORDER BY vehicle_id) AS prior FROM sample');assert.equal(revision.status,200,await revision.clone().text());assert.equal((await revision.json()).rows.length,3);
  for(const invalid of ['DELETE FROM vehicle_observations','SELECT * FROM imported_objects','SELECT 1; UPDATE imported_objects SET status=\'pending\'','SELECT * FROM pragma_table_info(\'imported_objects\')'])assert.equal((await post('/api/analysis/query',invalid)).status,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM vehicle_observations').first()).n,10005);
  for(const name of ['vehicles','delay','predictions','coverage','quality']) {
    const generated=await (await mf.dispatchFetch('https://analytics.test/api/analysis/starter?name='+name+'&from=2026-11-03&to=2026-11-03',{headers})).json();
    const response=await post('/api/analysis/query',generated.sql);assert.equal(response.status,200,await response.clone().text());
  }
});
test('dashboard DOM connects filters, SQL results, CSV, schedule, and import controls to the Worker',async t=>{
  const {mf,db}=await rig(t);
  await db.prepare("INSERT INTO imported_objects(object_key,dataset,scheduled_at,requested_at,status,row_count) VALUES('ui-source','vehicles',1793682000000,1793682037000,'complete',1)").run();
  await db.prepare("INSERT INTO vehicle_observations(source_key,row_path,scheduled_at,observed_at,vehicle_id,route_id,is_visible,quality_flags_json,raw_json) VALUES('ui-source','0',1793682000000,1793682037000,42,9,1,'[]','{}')").run();
  const html=await (await mf.dispatchFetch('https://analytics.test/',{headers})).text();
  const {document,window}=parseHTML(html),$=id=>document.getElementById(id);
  // Linkedom omits the browser's select.value setter and default first selection.
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{get(){return Array.from(this.querySelectorAll('option')).find(o=>o.hasAttribute('selected'))?.value??this.querySelector('option')?.value??'';},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);}});
  let downloaded,refreshTick;
  const errors=[];
  const context=createContext({document,console,Intl,Date,URLSearchParams,location:{assign:url=>errors.push('Unexpected redirect: '+url)},URL:{createObjectURL:blob=>{downloaded=blob;return 'blob:test';},revokeObjectURL:()=>{}},setTimeout,setInterval:fn=>{refreshTick=fn;return 1;},fetch:(path,options={})=>mf.dispatchFetch('https://analytics.test'+path,{...options,headers:{...options.headers,...headers}})});
  const client=await (await mf.dispatchFetch('https://analytics.test/assets/dashboard.js')).text();new Script(client).runInContext(context);
  async function until(predicate) {for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('UI did not reach expected state: '+$('notice').textContent+' / '+$('query-error').textContent);}
  await until(()=>$('starter-select').children.length===5 && $('sql-input').value.includes('1793682000000'));
  assert.equal($('vehicle-count').textContent,'1');assert.equal($('daily-enabled').checked,false);assert.equal($('schema-list').children.length,8);
  document.querySelector('[data-view="explore"]').click();assert.equal($('workspace').hidden,false);assert.equal($('explore-filters').hidden,false);
  $('run-query').click();await until(()=>$('result-count').textContent==='1');assert.equal($('export-csv').disabled,false);
  $('sql-input').value="SELECT '<img src=x onerror=alert(1)>' AS label FROM analysis_vehicles";$('sql-input').dispatchEvent(new window.Event('input'));assert.equal($('export-csv').disabled,true);
  $('run-query').click();await until(()=>$('results').textContent.includes('<img src=x'));
  assert.equal($('results').querySelector('img'),null);
  $('export-csv').click();await until(()=>downloaded!==undefined);assert((await downloaded.text()).includes('<img src=x'));
  $('daily-enabled').checked=true;$('daily-enabled').dispatchEvent(new window.Event('input'));$('refresh-status').click();await new Promise(resolve=>setTimeout(resolve,50));assert.equal($('daily-enabled').checked,true,'refresh must preserve unsaved settings');
  $('daily-time').value='04:15';$('schedule-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await until(()=>$('notice').textContent.includes('schedule saved'));
  assert.equal((await (await mf.dispatchFetch('https://analytics.test/api/imports',{headers})).json()).settings.daily_enabled,true);
  $('start-import').click();await until(()=>$('job-state').textContent==='Importing');$('stop-import').click();await until(()=>$('job-state').textContent==='Paused');assert($('start-import').textContent.includes('Resume'));
  document.querySelector('[data-view="sql"]').click();assert.equal($('explore-filters').hidden,true);assert.deepEqual(errors,[]);
});
test('Cloudflare Access identity requires a valid signature, audience, issuer, and expiry',async t=>{
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
  const {mf}=await rig(t,{IMPORT_TOKEN:token,ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test-audience'},async request=>{
    assert.equal(request.url,'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs');return new MFResponse(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
  });
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  function jwt(overrides={}) {
    const message=encode({alg:'RS256',kid:'test-key'})+'.'+encode({iss:'https://test-team.cloudflareaccess.com',aud:['test-audience'],exp:Math.floor(Date.now()/1000)+600,...overrides});
    return message+'.'+sign('RSA-SHA256',Buffer.from(message),privateKey).toString('base64url');
  }
  const access={'Cf-Access-Jwt-Assertion':jwt()};
  const page=await mf.dispatchFetch('https://analytics.test/',{headers:access});assert.equal(page.status,200);assert((await page.text()).includes('SQL editor'));
  for(const invalid of [jwt({aud:['different']}),jwt({iss:'https://other.cloudflareaccess.com'}),jwt({exp:1}),jwt().replace(/\.[^.]+$/,'.invalid')]) {
    assert.equal((await mf.dispatchFetch('https://analytics.test/api/analysis/schema',{headers:{'Cf-Access-Jwt-Assertion':invalid}})).status,401);
  }
  assert.equal((await mf.dispatchFetch('https://analytics.test/api/imports/stop',{method:'POST',headers:{...access,Origin:'https://other.test'}})).status,403);
  const logout=await mf.dispatchFetch('https://analytics.test/logout',{method:'POST',headers:{...access,Origin:'https://analytics.test'},redirect:'manual'});assert.equal(logout.headers.get('Location'),'https://test-team.cloudflareaccess.com/cdn-cgi/access/logout');
});
test('stop visits investigate real bindings, draw evidence, and persist owner review without touching sources',async t=>{
  const {mf,db,bucket,repo}=await rig(t),at=Date.parse('2026-11-03T15:00:00Z');
  const topology={topo:[{ligne:[{idLigne:9,nomCommercial:'Study route',mnemo:'9',itineraire:[{troncons:[{debut:{lat:40.99,lng:-85},fin:{lat:41.01,lng:-85}}]}]}],pointArret:[{idPointArret:123,name:'Study stop',nomCommercial:'Study stop',stopCode:'S',localisation:{lat:41,lng:-85},infoLigneSwiv:[{idLigne:9}]}]}]};
  const key='raw/v1/full_topology/study.json';await bucket.put(key,JSON.stringify(topology));const manifest=await seed(bucket,[]);await repo.manifest(manifest);await repo.attempt(manifest,attempt(key,'full_topology','top'));
  for(let i=0;i<3;i++) {
    const key='raw/v1/vehicles/study-'+i+'.json';await bucket.put(key,JSON.stringify({vehicule:[{...vehicle,localisation:{lat:41+(i-1)*200/111320,lng:-85,cap:0},conduite:{idLigne:9,destination:'Terminal',vitesse:5,avanceRetard:'on time'}}]}));await repo.attempt(manifest,{...attempt(key,'vehicles','v'+i),scheduled_at:at+i*60000,requested_at:at+i*60000,completed_at:at+i*60000+100});
    if(i<2){const pkey='raw/v1/stop_predictions/study-'+i+'.json';await bucket.put(pkey,JSON.stringify({listeHoraires:[{idLigne:9,destination:[{libelle:'Terminal',libelleHexa:'key',horaires:[{idHoraire:11,horaire:36120,horaireApplicable:36120,etatHoraire:1,etatPassage:0}]}]}]}));await repo.attempt(manifest,{...attempt(pkey,'stop_predictions','p'+i),scheduled_at:at+i*60000,requested_at:at+i*60000,completed_at:at+i*60000+100});}
  }
  const post=(path,body,method='POST')=>mf.dispatchFetch('https://analytics.test'+path,{method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const opts=await (await mf.dispatchFetch('https://analytics.test/api/visits/options',{headers})).json();assert.equal(opts.date,'2026-11-03');assert.deepEqual(opts.stops[0].route_ids,[9]);
  const response=await post('/api/visits/investigate',{date:'2026-11-03',route_id:9,stop_id:123});assert.equal(response.status,200,await response.clone().text());const study=await response.json();assert.equal(study.visits.length,1);assert.equal(study.visits[0].classification,'matched');assert.equal(study.geometry.length,1);
  const visit=study.visits[0],note={visit_id:visit.id,prediction_key:visit.matched_key,decision:'accept',note:'Reviewed the original French fields.'};assert.equal((await post('/api/visits/annotation',note,'PUT')).status,200);
  assert.equal((await post('/api/visits/annotation',{...note,prediction_key:'not-a-candidate'},'PUT')).status,400);
  const repeat=await (await post('/api/visits/investigate',{date:'2026-11-03',route_id:9,stop_id:123})).json();assert.equal(repeat.annotations[0].note,note.note);assert.equal((await db.prepare('SELECT COUNT(*) n FROM inferred_stop_visits').first()).n,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM vehicle_observations').first()).n,3);
  const {document,window}=parseHTML(await (await mf.dispatchFetch('https://analytics.test/',{headers})).text()),$=id=>document.getElementById(id);
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{get(){return Array.from(this.querySelectorAll('option')).find(o=>o.hasAttribute('selected'))?.value??this.querySelector('option')?.value??'';},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);}});
  const context=createContext({document,console,Intl,Date,URLSearchParams,location:{assign:()=>{}},URL,setTimeout,setInterval:()=>1,clearInterval:()=>{},fetch:(path,options={})=>mf.dispatchFetch('https://analytics.test'+path,{...options,headers:{...options.headers,...headers}})});
  for(const file of ['dashboard','visits'])new Script(await (await mf.dispatchFetch('https://analytics.test/assets/'+file+'.js')).text()).runInContext(context);
  async function until(test){for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Visit UI failed: '+$('visit-message').textContent);}
  document.querySelector('[data-view="visits"]').click();await until(()=>$('visit-stop').children.length===1);assert.equal($('workspace').hidden,true);
  $('visit-form').dispatchEvent(new window.Event('submit',{cancelable:true}));await until(()=>$('visit-map').querySelectorAll('circle').length>0);
  assert($('visit-chart').querySelectorAll('circle').length>0);assert($('visit-evidence').textContent.includes('horaireApplicable'));
  $('visit-note').value='Saved through the investigation screen.';$('visit-notes').dispatchEvent(new window.Event('submit',{cancelable:true}));await until(()=>$('visit-note-status').textContent==='Review saved.');
  assert.equal((await db.prepare('SELECT note FROM visit_annotations WHERE visit_id=?').bind(visit.id).first()).note,'Saved through the investigation screen.');
});
