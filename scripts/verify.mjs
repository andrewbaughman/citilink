import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicFetch } from './cloudflare.mjs';
try {
 const local=existsSync('deployment.local.json')?JSON.parse(readFileSync('deployment.local.json','utf8')):{};
 const source=process.env.COLLECTOR_URL || local.url;
 const token=process.env.STATUS_TOKEN || local.status_token;
 if(!source || !token)throw Error('Provide COLLECTOR_URL and STATUS_TOKEN securely, or use ignored deployment.local.json.');
 const url=new URL(source);
 if(url.protocol!=='https:' || url.username || url.password)throw Error('Verification requires an HTTPS origin without URL credentials.');
 const headers={Authorization:'Bearer '+token};
 const healthResponse=await publicFetch(url.origin+'/healthz',{headers:process.env.HEALTH_TOKEN?{Authorization:'Bearer '+process.env.HEALTH_TOKEN}:{}});
 const health=await healthResponse.json();
 if(!healthResponse.ok || health.status!=='ok')throw Error('Collection is not healthy: '+(health.reasons ?? []).join(', '));
 const response=await publicFetch(url.origin+'/api/status',{headers});
 if(!response.ok)throw Error('Authenticated status failed (HTTP '+response.status+').');
 const status=await response.json();
 if(!status.healthy || Date.now()-status.last_tick>180000)throw Error('Collection heartbeat or required dataset freshness failed.');
 let verified=0;
 for(const [id,stats] of Object.entries(status.datasets)){
  if(!stats.enabled)continue;
  if(!stats.last_object || !stats.last_hash)throw Error('No archived response for '+id);
  const object=await publicFetch(url.origin+'/api/archive?key='+encodeURIComponent(stats.last_object),{headers});
  if(!object.ok)throw Error('Archive download failed for '+id);
  const bytes=Buffer.from(await object.arrayBuffer());
  JSON.parse(bytes.toString('utf8'));
  if(createHash('sha256').update(bytes).digest('hex')!==stats.last_hash)throw Error('Archive checksum mismatch for '+id);
  console.log(JSON.stringify({dataset:id,json_valid:true,checksum_verified:true,bytes:bytes.length,last_archived_at:stats.last_archived_at}));
  verified++;
 }
 console.log(`Verified healthy collection and ${verified} enabled datasets with private JSON downloads and SHA-256 checks.`);
}catch(error){console.error(error.message);process.exitCode=1;}
