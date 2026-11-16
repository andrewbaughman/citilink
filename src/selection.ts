export interface Campaign {
  id: string;
  label: string;
  route_mnemo: string;
  direction: string;
  study_stop_codes: string[];
}
export interface Selection {
  mode: 'all' | 'fixed' | 'round_robin' | 'campaign';
  stop_ids?: number[];
  max_stops_per_cycle?: number;
  permanent_stop_code?: string;
  permanent_stop_codes?: string[];
  starts_month?: string;
  campaigns?: Campaign[];
}
export interface StopEntry { id: number; name: string; routes: string[] }
export type StopIndex = Record<string,StopEntry>;
export function buildStopIndex(value: unknown): StopIndex {
  const index: StopIndex = {}, ambiguous=new Set<string>();
  const centres=(value as {topo?: {ligne?: {idLigne:number;mnemo:string}[];pointArret?: {stopCode?:string;idPointArret:number;nomCommercial:string;infoLigneSwiv?:{idLigne:number}[]}[]}[]})?.topo ?? [];
  for(const ce of centres){
    const routes=new Map((ce.ligne ?? []).map(l=>[l.idLigne,l.mnemo]));
    for(const s of ce.pointArret ?? []){
      const code=s.stopCode?.trim();
      if(!code || !Number.isSafeInteger(s.idPointArret) || s.idPointArret<=0)continue;
      if(index[code] && index[code]!.id!==s.idPointArret){ambiguous.add(code);continue;}
      index[code]={id:s.idPointArret,name:s.nomCommercial,routes:[...new Set((s.infoLigneSwiv ?? []).map(r=>routes.get(r.idLigne)).filter((r):r is string=>!!r))]};
    }
  }
  for(const code of ambiguous)delete index[code];
  return index;
}
export function campaignAt(selection:Selection,slot:number) {
  const start=selection.starts_month!;
  const startMonth=Number(start.slice(0,4))*12+Number(start.slice(5,7))-1;
  const date=new Date(slot),month=date.getUTCFullYear()*12+date.getUTCMonth();
  if(month<startMonth)throw Error('campaign_not_started');
  const campaign=selection.campaigns![(month-startMonth)%selection.campaigns!.length]!;
  return {campaign,month:date.toISOString().slice(0,7)};
}
export function permanentStopCodes(selection:Selection):string[] {
  return selection.permanent_stop_codes ?? (selection.permanent_stop_code ? [selection.permanent_stop_code] : []);
}
export function resolveCampaign(selection:Selection,slot:number,index:StopIndex) {
  const {campaign,month}=campaignAt(selection,slot);
  const permanent=permanentStopCodes(selection);
  const codes=[...permanent,...campaign.study_stop_codes];
  const stops=codes.map((code,i)=>{
    const stop=index[code];
    if(!stop)throw Error('campaign_stop_code_unavailable');
    if(i>=permanent.length && !stop.routes.includes(campaign.route_mnemo))throw Error('campaign_route_membership_changed');
    return {code,...stop,role:i<permanent.length?'permanent_reference':'study'};
  });
  if(stops.length!==selection.max_stops_per_cycle || new Set(stops.map(s=>s.id)).size!==codes.length)throw Error('campaign_requires_distinct_stops');
  return {ids:stops.map(s=>s.id),context:{id:campaign.id,label:campaign.label,utc_month:month,route_mnemo:campaign.route_mnemo,direction:campaign.direction,stops}};
}
