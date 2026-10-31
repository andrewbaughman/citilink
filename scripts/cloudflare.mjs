import { readFileSync } from 'node:fs';
import { fetch, EnvHttpProxyAgent } from 'undici';
const dispatcher=new EnvHttpProxyAgent();
export const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
export function credentials() {
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!account || !token)throw Error('Cloudflare provisioning blocked: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not configured. No interactive login or temporary account will be used.');
 if(!/^[a-f0-9]{32}$/i.test(account))throw Error('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID.');
 return {account,token};
}
export async function api(path,init={}) {
 const {token}=credentials();
 const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
  ...init,dispatcher,signal:AbortSignal.timeout(30000),
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...init.headers},
 });
 let data;try{data=await response.json();}catch{throw Error('Cloudflare API unavailable (HTTP '+response.status+'); check network policy.');}
 if(!response.ok || !data.success)throw Error('Cloudflare API failed (HTTP '+response.status+'): '+(data.errors ?? []).map(e=>`${e.code}: ${e.message}`).join('; '));
 return data.result;
}
export async function provision() {
 const {account}=credentials();
 const buckets=await api(`/accounts/${account}/r2/buckets`);
 const bucket=config.r2_buckets[0].bucket_name;
 if(!(buckets.buckets ?? []).some(b=>b.name===bucket)) {
  await api(`/accounts/${account}/r2/buckets`,{method:'POST',body:JSON.stringify({name:bucket})});
  console.log('Created private R2 bucket:',bucket);
 }else console.log('Reusing R2 bucket:',bucket);
 let subdomain=(await api(`/accounts/${account}/workers/subdomain`))?.subdomain;
 if(!subdomain){
  subdomain='citilink-'+account.slice(0,8);
  await api(`/accounts/${account}/workers/subdomain`,{method:'PUT',body:JSON.stringify({subdomain})});
 }
 return {bucket,worker_name:config.name,url:`https://${config.name}.${subdomain}.workers.dev`};
}
export async function publicFetch(url,options={}) {return fetch(url,{...options,dispatcher,signal:AbortSignal.timeout(15000)});}
