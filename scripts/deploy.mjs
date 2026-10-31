import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { credentials, provision, publicFetch } from './cloudflare.mjs';
try {
 credentials();
 const previous=existsSync('deployment.local.json')?JSON.parse(readFileSync('deployment.local.json','utf8')):{};
 const password=process.env.STATUS_TOKEN || previous.status_token || (process.env.CI ? undefined : randomBytes(32).toString('hex'));
 if(!password || password.length<24)throw Error('STATUS_TOKEN must contain at least 24 characters. Local deployments generate one; CI must use a persistent repository secret.');
 const deployment=await provision();
 // This ignored owner-only file is the only local record of the dashboard password.
 writeFileSync('deployment.local.json',JSON.stringify({...deployment,username:'citilink',status_token:password},null,2)+'\n',{mode:0o600});
 const temporary=mkdtempSync(join(tmpdir(),'citilink-secrets-'));
 try {
  const secrets={STATUS_TOKEN:password};
  if(process.env.HEALTH_TOKEN)secrets.HEALTH_TOKEN=process.env.HEALTH_TOKEN;
  const secretPath=join(temporary,'secrets.json');
  writeFileSync(secretPath,JSON.stringify(secrets),{mode:0o600});
  const result=spawnSync('node_modules/.bin/wrangler',['deploy','--secrets-file',secretPath],{stdio:'inherit',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(result.error || result.status!==0)throw Error('Worker deployment failed. Existing R2 objects are preserved.');
 }finally{rmSync(temporary,{recursive:true,force:true});}
 const status=await publicFetch(deployment.url+'/api/status',{headers:{Authorization:'Bearer '+password}});
 if(status.status!==200)throw Error('Deployed Worker did not pass authenticated status verification (HTTP '+status.status+').');
 const health=await publicFetch(deployment.url+'/healthz',{headers:process.env.HEALTH_TOKEN?{Authorization:'Bearer '+process.env.HEALTH_TOKEN}:{}});
 if(![200,503].includes(health.status))throw Error('Health endpoint did not return its expected status.');
 const payload=await health.json();
 console.log('Deployed:',deployment.url);
 console.log('Dashboard login: username citilink; password is in ignored deployment.local.json (never printed).');
 console.log('Collection:',payload.status==='ok'?'healthy':'waiting for scheduled observations; inspect dashboard. New Cron Triggers may take up to 15 minutes to propagate.');
 console.log('External monitoring is separate: set GitHub repository variable COLLECTOR_URL to this URL for the supplied 15-minute fallback, or configure a dedicated one-minute monitor.');
}catch(error){console.error(error.message);process.exitCode=1;}
