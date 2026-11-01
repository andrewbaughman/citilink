import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { credentials, provision, publicFetch, api, config } from './cloudflare.mjs';
try {
 credentials();
 const previous=existsSync('deployment.local.json')?JSON.parse(readFileSync('deployment.local.json','utf8')):{};
 const {account}=credentials();
 let hasRemoteSecret=false;
 try { const settings=await api(`/accounts/${account}/workers/scripts/${config.name}/settings`);hasRemoteSecret=settings.bindings?.some(b=>b.name==='STATUS_TOKEN') ?? false; }
 catch(error){if(!error.message.includes('10007'))throw error;}
 let password=process.env.STATUS_TOKEN || previous.status_token;
 let uploadPassword=Boolean(process.env.STATUS_TOKEN);
 if(!hasRemoteSecret && !password){password=randomBytes(32).toString('hex');uploadPassword=true;}
 if(!hasRemoteSecret)uploadPassword=true;
 if(password && password.length<24)throw Error('STATUS_TOKEN must contain at least 24 characters.');
 const deployment=await provision();
 // This ignored owner-only file is the only local record of the dashboard password.
 writeFileSync('deployment.local.json',JSON.stringify({...deployment,username:'citilink',status_token:password},null,2)+'\n',{mode:0o600});
 const temporary=mkdtempSync(join(tmpdir(),'citilink-secrets-'));
 try {
  const secrets={};
  if(uploadPassword)secrets.STATUS_TOKEN=password;
  if(process.env.HEALTH_TOKEN)secrets.HEALTH_TOKEN=process.env.HEALTH_TOKEN;
  const secretPath=join(temporary,'secrets.json');
  writeFileSync(secretPath,JSON.stringify(secrets),{mode:0o600});
  const args=Object.keys(secrets).length?['deploy','--secrets-file',secretPath]:['deploy'];
  const result=spawnSync('node_modules/.bin/wrangler',args,{stdio:'inherit',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(result.error || result.status!==0)throw Error('Worker deployment failed. Existing R2 objects are preserved.');
 }finally{rmSync(temporary,{recursive:true,force:true});}
 let status;
 // Newly created workers.dev routes can briefly return 404 during propagation.
 for(let attempt=0;attempt<6;attempt++){
  status=await publicFetch(deployment.url+'/api/status',{headers:{Authorization:'Bearer '+password}});
  if(status.status===200)break;
  await status.body?.cancel();
  if(![404,502,503].includes(status.status))break;
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(status.status===401 && hasRemoteSecret && !uploadPassword)console.log('Existing dashboard password preserved; local credential is stale. Use Cloudflare/R2 account access for administrative verification.');
 else if(status.status!==200)throw Error('Deployed Worker did not pass authenticated status verification (HTTP '+status.status+').');
 await status.body?.cancel();
 const health=await publicFetch(deployment.url+'/healthz',{headers:process.env.HEALTH_TOKEN?{Authorization:'Bearer '+process.env.HEALTH_TOKEN}:{}});
 if(![200,503].includes(health.status))throw Error('Health endpoint did not return its expected status.');
 const payload=await health.json();
 console.log('Deployed:',deployment.url);
 console.log('Dashboard login: username citilink; existing remote password is preserved unless STATUS_TOKEN explicitly supplies a replacement. Passwords are never printed.');
 console.log('Collection:',payload.status==='ok'?'healthy':'waiting for scheduled observations; inspect dashboard. New Cron Triggers may take up to 15 minutes to propagate.');
 console.log('External monitoring: the repository workflow checks the configured origin every 15 minutes.');
}catch(error){console.error(error.message);process.exitCode=1;}
