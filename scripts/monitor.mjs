// No Cloudflare management credentials: this runs independently of its API.
const origin=process.env.COLLECTOR_URL;
if(!origin){console.error('COLLECTOR_URL is not configured; monitoring is not active.');process.exitCode=1;}
else {
 try {
  const url=new URL('/healthz',origin);
  if(url.protocol!=='https:')throw Error('Monitor requires HTTPS');
  const response=await fetch(url,{headers:{'Cache-Control':'no-cache',...(process.env.HEALTH_TOKEN?{Authorization:'Bearer '+process.env.HEALTH_TOKEN}:{})},signal:AbortSignal.timeout(20000)});
  const health=await response.json();
  if(!response.ok || health.status!=='ok' || !health.last_collector_tick || Date.now()-health.last_collector_tick>180000)throw Error('Collector is degraded: '+(health.reasons ?? ['unreachable']).join(', '));
  console.log('Collector heartbeat and required datasets are healthy.');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
