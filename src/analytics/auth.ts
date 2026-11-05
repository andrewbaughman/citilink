export interface AuthEnv {IMPORT_TOKEN?:string;ACCESS_TEAM_DOMAIN?:string;ACCESS_AUD?:string}
const COOKIE='__Host-citilink_analytics';
const enc=new TextEncoder();
function encode(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
function decode(value:string):Uint8Array {return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
async function hmac(token:string) {return crypto.subtle.importKey('raw',enc.encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function tokenMatches(value:string,expected:string):Promise<boolean> {
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(expected)));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]!^b[i]!;return diff===0;
}
export async function sessionCookie(token:string,now=Date.now()):Promise<string> {
  const payload=encode(enc.encode(JSON.stringify({expires:now+8*3600000,nonce:crypto.randomUUID()})));
  const signature=encode(new Uint8Array(await crypto.subtle.sign('HMAC',await hmac(token),enc.encode(payload))));
  return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`;
}
export const clearCookie=()=>`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export async function validSession(request:Request,token:string,now=Date.now()):Promise<boolean> {
  try {
    const cookie=request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    if(!cookie || cookie.length>2048)return false;
    const [payload,signature,...extra]=cookie.split('.');if(!payload || !signature || extra.length)return false;
    if(!await crypto.subtle.verify('HMAC',await hmac(token),decode(signature),enc.encode(payload)))return false;
    const value=JSON.parse(new TextDecoder().decode(decode(payload))) as {expires?:unknown};
    return typeof value.expires==='number' && value.expires>now && value.expires<=now+8*3600000;
  }catch{return false;}
}
async function accessIdentity(request:Request,env:AuthEnv):Promise<boolean> {
  if(!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)return false;
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN))return false;
  const jwt=request.headers.get('Cf-Access-Jwt-Assertion');if(!jwt || jwt.length>16000)return false;
  try {
    const [header,payload,signature,...extra]=jwt.split('.');if(!header || !payload || !signature || extra.length)return false;
    const h=JSON.parse(new TextDecoder().decode(decode(header))) as {alg?:string;kid?:string};
    const p=JSON.parse(new TextDecoder().decode(decode(payload))) as {iss?:string;aud?:string|string[];exp?:number;nbf?:number};
    const issuer='https://'+env.ACCESS_TEAM_DOMAIN,now=Date.now()/1000;
    if(h.alg!=='RS256' || !h.kid || p.iss!==issuer || typeof p.exp!=='number' || p.exp<=now || (p.nbf!==undefined && p.nbf>now+60))return false;
    if(!(Array.isArray(p.aud)?p.aud:[p.aud]).includes(env.ACCESS_AUD))return false;
    const keyRequest=new Request(issuer+'/cdn-cgi/access/certs');
    let response=await caches.default.match(keyRequest);
    if(!response) {
      const upstream=await fetch(keyRequest);if(!upstream.ok)return false;
      response=new Response(upstream.body,{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=300'}});
      await caches.default.put(keyRequest,response.clone());
    }
    const jwks=await response.json<{keys:(JsonWebKey&{kid?:string})[]}>();
    const jwk=jwks.keys.find(k=>k.kid===h.kid && k.kty==='RSA');if(!jwk)return false;
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(signature),enc.encode(header+'.'+payload));
  }catch{return false;}
}
export async function authenticate(request:Request,env:AuthEnv):Promise<'bearer'|'session'|'access'|null> {
  const value=request.headers.get('Authorization');
  if(env.IMPORT_TOKEN && value?.startsWith('Bearer ') && await tokenMatches(value.slice(7),env.IMPORT_TOKEN))return 'bearer';
  if(env.IMPORT_TOKEN && await validSession(request,env.IMPORT_TOKEN))return 'session';
  if(await accessIdentity(request,env))return 'access';
  return null;
}
export async function bodyText(request:Request,limit=65536):Promise<string> {
  const reader=request.body?.getReader();if(!reader)return '';
  let length=0;const chunks:Uint8Array[]=[];
  for(;;){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>limit){await reader.cancel();throw Error('Request body is too large');}chunks.push(item.value);}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return new TextDecoder().decode(bytes);
}
