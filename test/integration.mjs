import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';

const token='local-integration-test-secret';
const auth={Authorization:'Bearer '+token};
const files={
 '/topo/vehicules':'topo_vehicules.json', '/topo/refresh':'topo_refresh.json',
 '/iv/message':'iv_message.json', '/config/version':'config_version.json', '/topo':'topo.json',
};
test('compiled Worker runs against real local SQLite Durable Object and R2 bindings',async t=>{
 const upstreamCalls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:'citilink-history', modules:true, scriptPath:'dist/index.js', compatibilityDate:'2026-10-01',
  durableObjects:{COORDINATOR:{className:'Collector',useSQLite:true}},r2Buckets:['ARCHIVE'],
  bindings:{STATUS_TOKEN:token},
  outboundService:async request=>{
   const url=new URL(request.url);assert.equal(url.hostname,'swiv.citilink.cadavl.com');
   const endpoint=url.pathname.split('/restWS')[1];assert(endpoint in files,'unexpected endpoint '+endpoint);
   upstreamCalls.push(url.href);
   return new MFResponse(readFileSync(new URL('../api-discovery/raw/'+files[endpoint],import.meta.url)),{headers:{'Content-Type':'application/octet-stream'}});
  },
 }));
 t.after(()=>mf.dispose());
 const before=await mf.dispatchFetch('https://collector.test/healthz');assert.equal(before.status,503);
 assert.equal((await mf.dispatchFetch('https://collector.test/')).status,401);
 const ns=await mf.getDurableObjectNamespace('COORDINATOR');
 const coordinator=ns.get(ns.idFromName('citilink-global-v1'));
 const slot=Math.floor(Date.now()/60000)*60000;
 const result=await coordinator.tick(slot);assert.equal(result.status,'finished');assert(upstreamCalls.length>=3);
 const statusResponse=await mf.dispatchFetch('https://collector.test/api/status',{headers:auth});assert.equal(statusResponse.status,200);
 const status=await statusResponse.json();assert(status.datasets.vehicles.last_success_slot);assert.equal(status.roster_count,751);
 const manifestResponse=await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(status.last_manifest),{headers:auth});
 assert.equal(manifestResponse.status,200);assert.equal(manifestResponse.headers.get('content-type'),'application/json');
 const manifest=await manifestResponse.json();assert(manifest.attempts.length>=3);
 for(const a of manifest.attempts){
  assert(a.object_key.endsWith('.json'));assert.equal(a.storage_representation,'upstream_json');assert.equal(a.ok,true);
  const response=await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(a.object_key),{headers:auth});
  assert.equal(response.status,200);
  const source=readFileSync(new URL('../api-discovery/raw/'+files[new URL(a.url).pathname.split('/restWS')[1]],import.meta.url));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),source);
 }
 const count=upstreamCalls.length;assert.equal((await coordinator.tick(slot)).status,'duplicate');assert.equal(upstreamCalls.length,count);
 const health=await mf.dispatchFetch('https://collector.test/healthz');assert.equal(health.status,status.healthy?200:503);
 const minimal=await health.json();assert(!('roster' in minimal));assert(!('last_manifest' in minimal));
 const basic={'Authorization':'Basic '+Buffer.from('citilink:'+token).toString('base64')};
 const page=await mf.dispatchFetch('https://collector.test/',{headers:basic});assert.equal(page.status,200);assert((await page.text()).includes('Request budget'));
 assert.equal((await mf.dispatchFetch('https://collector.test/api/archive?key=raw/../secrets.json',{headers:auth})).status,400);
 assert.equal((await mf.dispatchFetch('https://collector.test/api/archive?key='+encodeURIComponent(status.last_manifest))).status,401);
 assert.equal((await mf.dispatchFetch('https://collector.test/tick',{method:'POST',headers:auth})).status,405);
});
