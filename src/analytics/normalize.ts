// English aliases are provisional. Original French records remain in raw_json and R2.
export type RecordValue = Record<string, unknown>;
export type Cell = string | number | null;
export function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a JSON object');
  return value as RecordValue;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('Expected a JSON array');
  return value;
}
const optional = (value: unknown): RecordValue => value == null ? {} : record(value);
export const num = (v: unknown): number | null => typeof v==='number' && Number.isFinite(v) ? v : null;
export const str = (v: unknown): string | null => typeof v==='string' ? v : null;
const bool = (v: unknown): number | null => typeof v==='boolean' ? Number(v) : null;
export interface Capture { key: string; scheduled_at: number; requested_at: number; stop_id?: number }
export interface Row { path: string; values: Cell[] }
export function delay(value: unknown): [number|null,number|null] {
  if (typeof value!=='string') return [null,null];
  const m=/^(\d+) min (late|early)$/.exec(value);
  if(m) return [Number(m[1])*(m[2]==='early'?-1:1),null];
  // 'on time' is a category; '1h+ late' is censored, not an exact value.
  return [null,value==='1h+ late'?60:null];
}
export function vehicleRows(body: unknown,c:Capture): Row[] {
  return array(record(body).vehicule).map((value,i)=>{
    const v=record(value),l=optional(v.localisation),d=optional(v.conduite);
    const flags=['speed_unit_unconfirmed','position_measurement_time_unknown'];
    const lat=num(l.lat),lng=num(l.lng),speed=num(d.vitesse),load=num(v.tauxRemplissage);
    if(lat===null || lng===null || Math.abs(lat)>90 || Math.abs(lng)>180) flags.push('invalid_coordinates');
    if(speed!==null && (speed<0 || speed>100)) flags.push('raw_speed_outlier');
    const available=typeof v.vehiculeLoad==='string';
    if(!available) flags.push('occupancy_unavailable');
    if(load!==null && (load<0 || load>100)) flags.push('occupancy_out_of_range');
    const [minutes,lower]=delay(d.avanceRetard);
    const path=`vehicule/${i}`;
    return {path,values:[c.key,path,c.scheduled_at,c.requested_at,num(v.id),str(v.numeroEquipement),num(d.idLigne),lat,lng,num(l.cap),speed,str(d.destination),str(d.avanceRetard),minutes,lower,bool(v.estAffichable),load,available && load!==null && load>=0 && load<=100 ? load:null,JSON.stringify(flags),JSON.stringify(v)]};
  });
}
export function predictionRows(body: unknown,c:Capture): Row[] {
  if(!Number.isSafeInteger(c.stop_id) || c.stop_id!<=0) throw Error('Prediction capture has no valid stop ID');
  return array(record(body).listeHoraires).flatMap((li,i)=>{
    const line=record(li);
    return array(line.destination).flatMap((de,j)=>{
      const destination=record(de);
      return array(destination.horaires).map((entry,k)=>{
        const h=record(entry),scheduled=num(h.horaireApplicable),status=num(h.etatPassage),state=num(h.etatHoraire);
        const flags=['service_date_unresolved'];
        if(status===1) flags.push('vendor_display_struck_through');
        else if(status===2) flags.push('vendor_prediction_hidden');
        else if(status!==0) flags.push('unknown_passage_status');
        if(state===0) flags.push('vendor_special_schedule_display');
        else if(state!==1) flags.push('unknown_schedule_status');
        const path=`listeHoraires/${i}/destination/${j}/horaires/${k}`;
        return {path,values:[c.key,path,c.scheduled_at,c.requested_at,c.stop_id!,num(line.idLigne),str(destination.libelle),str(destination.libelleHexa),num(h.idHoraire),num(h.horaire),scheduled,scheduled===0?null:scheduled,state,status,null,JSON.stringify(flags),JSON.stringify(h)]};
      });
    });
  });
}
