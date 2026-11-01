import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { Engine, type IO, type Store } from '../src/collector';
import type { Bucket } from '../src/archive';
export function deployedPlan() { return JSON.parse(readFileSync(new URL('../capture-plan.json',import.meta.url),'utf8')); }
// Isolate legacy core-feed tests; deployedPlan() returns the actual campaign configuration.
export function plan() {
 const p=deployedPlan();
 p.datasets.stop_predictions.enabled=false;
 p.datasets.stop_predictions.schedule={interval_minutes:5,phase_minute:3};
 p.datasets.stop_predictions.selection={mode:'fixed',stop_ids:[],max_stops_per_cycle:10};
 return p;
}
export class MemoryStore implements Store {
  values=new Map<string,unknown>();
  async get<T>(key:string):Promise<T|undefined> { return structuredClone(this.values.get(key)) as T|undefined; }
  async put(key:string,value:unknown) { this.values.set(key,structuredClone(value)); }
  // Tests inspect durable state to simulate quota boundaries and abrupt restarts.
  state(): any { return structuredClone(this.values.get('state')); }
}
export class MemoryBucket implements Bucket {
  values=new Map<string,Uint8Array>();
  fail: (key:string)=>boolean = () => false;
  async put(key:string,value:string|ArrayBuffer|Uint8Array) {
    if(this.fail(key)) throw Error('R2 unavailable');
    this.values.set(key,typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value));
  }
  json(key:string) { return JSON.parse(new TextDecoder().decode(this.values.get(key)!)); }
}
export const bodies:Record<string,string> = {
  '/topo/vehicules':' {"vehicule": [ ]}\n',
  '/topo/refresh':'{"update": []}',
  '/iv/message':'[]',
  '/config/version':'{"version":[{"libelleCE":"CITILINK","valeur":1}]}',
  '/topo':'{"topo":[{"pointArret":[{"idPointArret":123},{"idPointArret":456}]}]}',
  '/horaires/pta/123':'{"listeHoraires":[]}',
  '/horaires/pta/456':'{"listeHoraires":[]}',
};
export function rig(raw=plan()) {
  let at=Date.UTC(2026,9,31,12,0);
  const store=new MemoryStore(),bucket=new MemoryBucket();
  const calls:{url:string;at:number}[]=[];
  const io:IO={now:()=>at,sleep:async ms=>{at+=ms;},fetch:async url=>{
    calls.push({url,at});
    const path=new URL(url).pathname.split('/restWS')[1]!;
    if(!(path in bodies)) throw Error('Unexpected upstream URL: '+path);
    return new Response(bodies[path],{headers:{'Content-Type':'application/octet-stream'}});
  }};
  return {store,bucket,io,calls,raw,engine:new Engine(store,bucket,raw,io),now:()=>at,setTime:(n:number)=>{at=n;},advance:(n:number)=>{at+=n;}};
}
