import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {config} from './cloudflare.mjs';
const plan=JSON.parse(readFileSync('capture-plan.json','utf8'));
const selection=plan.datasets.stop_predictions.selection;
const permanent=selection.permanent_stop_codes??[selection.permanent_stop_code];
const expected=selection.max_stops_per_cycle;
const planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const directory=mkdtempSync(join(tmpdir(),'citilink-campaign-'));
function download(key,name){
 const path=join(directory,name);
 const r=spawnSync('node_modules/.bin/wrangler',['r2','object','get',config.r2_buckets[0].bucket_name+'/'+key,'--remote','--file',path],{encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 if(r.status!==0)throw Error('Private R2 download failed for '+name+'. Check account access and whether a scheduled campaign has completed.');
 return readFileSync(path);
}
try{
 const receipt=JSON.parse(download('indexes/v1/stop_predictions/latest.json','receipt.json'));
 if(Date.now()-receipt.scheduled_at>360000 || receipt.scheduled_at>Date.now())throw Error('Campaign receipt is stale or future-dated.');
 if(receipt.plan_hash!==planHash)throw Error('Latest campaign is not using the configured capture plan yet.');
 if(receipt.outcome.expected!==expected || receipt.outcome.succeeded!==expected)throw Error('Campaign did not successfully archive every configured stop.');
 const manifest=JSON.parse(download(receipt.manifest_key,'manifest.json'));
 if(JSON.stringify(manifest.selection_context)!==JSON.stringify(receipt.selection_context))throw Error('Manifest/campaign context mismatch.');
 const context=receipt.selection_context;
 if(context.stops.length!==expected || context.stops.filter(s=>s.role==='permanent_reference').length!==permanent.length || context.stops.filter(s=>s.role==='study').length!==3)throw Error('Invalid campaign roles.');
 if(!permanent.every(code=>context.stops.some(s=>s.code===code && s.role==='permanent_reference')) || new Set(context.stops.map(s=>s.id)).size!==expected)throw Error('Permanent panel or distinct stop IDs do not match configuration.');
 for(const stop of context.stops){
  const a=receipt.attempts.find(a=>a.stop_id===stop.id && a.ok);
  if(!a || !a.complete || !a.valid_json || a.storage_representation!=='upstream_json')throw Error('Missing complete upstream JSON for stop '+stop.code);
  const body=download(a.object_key,'stop-'+stop.code+'.json');
  const parsed=JSON.parse(body.toString('utf8'));
  const hash=createHash('sha256').update(body).digest('hex');
  if(hash!==a.body_sha256 || hash!==a.object_sha256)throw Error('Checksum mismatch for stop '+stop.code);
  if(!Array.isArray(parsed.listeHoraires))throw Error('Unexpected prediction response');
  console.log(JSON.stringify({code:stop.code,name:stop.name,role:stop.role,http:a.http_status,bytes:body.length,forecast_groups:parsed.listeHoraires.length,checksum_verified:true}));
 }
 console.log('Verified campaign '+context.id+' ('+context.utc_month+'), '+permanent.length+' permanent references and three study stops.');
} catch(error){console.error(error.message);process.exitCode=1;}
finally{rmSync(directory,{recursive:true,force:true});}
