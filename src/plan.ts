import type { Selection } from './selection';
export const ENDPOINTS = {
  vehicles: '/topo/vehicules',
  topology_updates: '/topo/refresh',
  service_messages: '/iv/message',
  config_version: '/config/version',
  full_topology: '/topo',
  stop_predictions: '/horaires/pta/',
} as const;
export type DatasetId = keyof typeof ENDPOINTS;
export const IDS = Object.keys(ENDPOINTS) as DatasetId[];
export const API_BASE = 'https://swiv.citilink.cadavl.com/SWIV/CITILINK/proxy/restWS';
export interface HealthPlan {
  grace_seconds: number;
  failed_windows_before_unhealthy: number;
  healthy_windows_before_recovery: number;
  required: boolean;
  minimum_coverage_percent: number;
  unchanged_body_advisory_minutes?: number;
}
export interface DatasetPlan {
  enabled: boolean;
  tier: 'essential' | 'optional';
  priority: number;
  schedule: { interval_minutes: number; phase_minute: number };
  selection: Selection;
  max_requests_per_utc_day?: number;
  timeout_seconds: number;
  max_start_lag_seconds: number;
  retry: { max_attempts: number; initial_backoff_seconds: number; max_backoff_seconds: number };
  health: HealthPlan;
  triggers?: { on_bootstrap: boolean; on_version_change: boolean; on_collection_resume: boolean; min_gap_minutes: number };
}
export interface Plan {
  schema_version: 1;
  global: {
    max_in_flight: 1;
    min_request_spacing_ms: number;
    max_requests_per_utc_day: number;
    reserved_essential_requests_per_utc_day: number;
    catch_up: false;
    honor_retry_after: true;
    circuit_breaker: { consecutive_failures: number; initial_pause_seconds: number; max_pause_seconds: number };
  };
  datasets: Record<DatasetId, DatasetPlan>;
}
function object(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(`${path}: expected object`);
  return v as Record<string, unknown>;
}
function fields(o: Record<string, unknown>, keys: string[], path: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw Error(`${path}: unknown field ${k}`);
}
function integer(v: unknown, min: number, max: number, path: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw Error(`${path}: integer ${min}..${max} required`);
  return v as number;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw Error(`${path}: boolean required`);
  return v;
}
export function validatePlan(raw: unknown): Plan {
  const r = object(raw, 'plan');
  fields(r, ['schema_version', 'global', 'defaults', 'datasets'], 'plan');
  if (r.schema_version !== 1) throw Error('Unsupported schema_version');
  const g = object(r.global, 'global');
  fields(g, ['max_in_flight','min_request_spacing_ms','max_requests_per_utc_day','reserved_essential_requests_per_utc_day','catch_up','honor_retry_after','circuit_breaker'], 'global');
  if (g.max_in_flight !== 1 || g.catch_up !== false || g.honor_retry_after !== true) throw Error('Require one in-flight request, no catch-up, and Retry-After compliance');
  integer(g.min_request_spacing_ms, 1000, 60000, 'spacing');
  const daily = integer(g.max_requests_per_utc_day, 1, 1000000, 'daily budget');
  integer(g.reserved_essential_requests_per_utc_day, 0, daily, 'reservation');
  const cb = object(g.circuit_breaker, 'circuit_breaker');
  fields(cb, ['consecutive_failures','initial_pause_seconds','max_pause_seconds'], 'circuit_breaker');
  integer(cb.consecutive_failures, 1, 100, 'failure threshold');
  integer(cb.initial_pause_seconds, 60, 86400, 'initial pause');
  integer(cb.max_pause_seconds, cb.initial_pause_seconds as number, 86400, 'maximum pause');
  const defaults = object(r.defaults, 'defaults');
  fields(defaults, ['timeout_seconds','max_start_lag_seconds','retry','health'], 'defaults');
  const input = object(r.datasets, 'datasets');
  fields(input, IDS, 'datasets');
  const datasets = {} as Record<DatasetId, DatasetPlan>;
  for (const id of IDS) {
    const d = object(input[id], id);
    fields(d, ['enabled','tier','priority','schedule','selection','max_requests_per_utc_day','timeout_seconds','max_start_lag_seconds','retry','health','triggers'], id);
    const schedule = object(d.schedule, `${id}.schedule`);
    fields(schedule, ['interval_minutes','phase_minute'], `${id}.schedule`);
    const interval = integer(schedule.interval_minutes, 1, 10080, `${id}.interval`);
    integer(schedule.phase_minute, 0, interval - 1, `${id}.phase`);
    bool(d.enabled, id);
    if (d.tier !== 'essential' && d.tier !== 'optional') throw Error(`${id}: invalid tier`);
    integer(d.priority, 0, 1000, `${id}.priority`);
    const selection = object(d.selection, `${id}.selection`);
    fields(selection, ['mode','stop_ids','max_stops_per_cycle','permanent_stop_code','starts_month','campaigns'], `${id}.selection`);
    if (id === 'stop_predictions') {
      if (!['fixed','round_robin','campaign'].includes(selection.mode as string)) throw Error('Stops require an explicit fixed or bounded rotating panel');
      const cap = integer(selection.max_stops_per_cycle, 1, 100, 'stop cap');
      if(selection.mode==='campaign'){
        if(cap!==4 || selection.stop_ids!==undefined)throw Error('Campaign requires four stops and uses stable codes');
        if(typeof selection.permanent_stop_code!=='string' || !/^[A-Za-z0-9_-]+$/.test(selection.permanent_stop_code))throw Error('Invalid permanent stop code');
        if(typeof selection.starts_month!=='string' || !/^20\d\d-(0[1-9]|1[0-2])$/.test(selection.starts_month))throw Error('Invalid campaign start month');
        if(!Array.isArray(selection.campaigns) || !selection.campaigns.length)throw Error('Campaign list required');
        const campaignIds=new Set<string>();
        for(const item of selection.campaigns){
          const c=object(item,'campaign');fields(c,['id','label','route_mnemo','direction','study_stop_codes'],'campaign');
          for(const k of ['id','label','route_mnemo','direction'])if(typeof c[k]!=='string' || !c[k])throw Error('Campaign metadata required');
          if(!/^[A-Za-z0-9_-]+$/.test(c.id as string) || campaignIds.has(c.id as string))throw Error('Campaign IDs must be unique');
          campaignIds.add(c.id as string);
          if(!Array.isArray(c.study_stop_codes) || c.study_stop_codes.length!==3 || c.study_stop_codes.some(v=>typeof v!=='string' || !/^[A-Za-z0-9_-]+$/.test(v)) || new Set([...c.study_stop_codes,selection.permanent_stop_code]).size!==4)throw Error('Campaign requires three unique study codes distinct from the permanent reference');
        }
      }else if(selection.campaigns!==undefined || selection.permanent_stop_code!==undefined || selection.starts_month!==undefined)throw Error('Campaign fields require campaign mode');
      const stops = selection.stop_ids;
      if (stops !== undefined && (!Array.isArray(stops) || stops.some(s => !Number.isSafeInteger(s) || s <= 0) || new Set(stops).size !== stops.length)) throw Error('Stop IDs must be unique positive integers');
      if (selection.mode === 'fixed' && (!Array.isArray(stops) || stops.length > cap || (d.enabled && !stops.length))) throw Error('Enabled fixed panel requires 1..cap explicit stop IDs');
      if (selection.mode === 'round_robin' && Array.isArray(stops) && stops.length) throw Error('Rotating selection uses the discovered roster, not stop_ids');
    } else if (selection.mode !== 'all' || selection.stop_ids !== undefined || selection.max_stops_per_cycle !== undefined || selection.campaigns !== undefined || selection.permanent_stop_code !== undefined || selection.starts_month !== undefined) throw Error(`${id}: requires one unfiltered request`);
    const retry = { ...object(defaults.retry,'default.retry'), ...object(d.retry ?? {},`${id}.retry`) };
    fields(retry, ['max_attempts','initial_backoff_seconds','max_backoff_seconds'], 'retry');
    integer(retry.max_attempts, 1, 3, 'attempts');
    integer(retry.initial_backoff_seconds, 1, 60, 'initial backoff');
    integer(retry.max_backoff_seconds, retry.initial_backoff_seconds as number, 120, 'max backoff');
    const health: Record<string,unknown> = { required: true, minimum_coverage_percent: 100, ...object(defaults.health,'default.health'), ...object(d.health ?? {},`${id}.health`) };
    fields(health, ['required','minimum_coverage_percent','grace_seconds','failed_windows_before_unhealthy','healthy_windows_before_recovery','unchanged_body_advisory_minutes'], 'health');
    bool(health.required, 'health.required');
    integer(health.grace_seconds, 0, 86400, 'grace');
    integer(health.failed_windows_before_unhealthy, 1, 100, 'failure windows');
    integer(health.healthy_windows_before_recovery, 1, 100, 'recovery windows');
    integer(health.minimum_coverage_percent, 1, 100, 'coverage');
    if (health.unchanged_body_advisory_minutes !== undefined) integer(health.unchanged_body_advisory_minutes, 1, 10080, 'unchanged advisory');
    const timeout = integer(d.timeout_seconds ?? defaults.timeout_seconds, 1, 30, 'timeout');
    const lag = integer(d.max_start_lag_seconds ?? defaults.max_start_lag_seconds, 1, 120, 'start lag');
    if (d.max_requests_per_utc_day !== undefined) integer(d.max_requests_per_utc_day, 1, 1000000, 'dataset budget');
    let triggers: DatasetPlan['triggers'];
    if (d.triggers !== undefined) {
      if (id !== 'full_topology') throw Error('Only full topology supports triggers');
      const t = object(d.triggers, 'triggers');
      fields(t, ['on_bootstrap','on_version_change','on_collection_resume','min_gap_minutes'], 'triggers');
      bool(t.on_bootstrap,'bootstrap'); bool(t.on_version_change,'version'); bool(t.on_collection_resume,'resume');
      integer(t.min_gap_minutes, 1, Math.min(1440,interval), 'trigger spacing');
      triggers = t as unknown as DatasetPlan['triggers'];
    }
    datasets[id] = { ...d, schedule, selection, retry, health, timeout_seconds: timeout, max_start_lag_seconds: lag, triggers } as unknown as DatasetPlan;
  }
  const plan = { schema_version: 1, global: g, datasets } as Plan;
  const estimates = estimatePlan(plan);
  if (estimates.total > daily) throw Error('Scheduled traffic exceeds global daily budget');
  if (estimates.optional > daily - plan.global.reserved_essential_requests_per_utc_day) throw Error('Optional traffic exceeds unreserved budget');
  for (const row of estimates.datasets) if (row.daily > (datasets[row.id].max_requests_per_utc_day ?? daily)) throw Error(`${row.id}: baseline exceeds its daily cap`);
  if (estimates.total * plan.global.min_request_spacing_ms > 86400000) throw Error('Schedule exceeds pacer capacity even at zero latency');
  return plan;
}
export function estimatePlan(plan: Plan) {
  let total = 0, optional = 0;
  const datasets = IDS.map(id => {
    const d = plan.datasets[id];
    const perCycle = id === 'stop_predictions' ? (d.selection.mode === 'fixed' ? d.selection.stop_ids!.length : d.selection.max_stops_per_cycle!) : 1;
    // Maximum scheduled windows in a UTC day, including intervals that do not divide 1440.
    const daily = d.enabled ? Math.ceil(1440 / d.schedule.interval_minutes) * perCycle : 0;
    total += daily;
    if (d.tier === 'optional') optional += daily;
    return { id, enabled: d.enabled, interval_minutes: d.schedule.interval_minutes, per_cycle: perCycle, daily };
  });
  return { total, optional, datasets, note: 'Base maximum per UTC day; retries and event-triggered captures spend remaining budget. Rotating stop estimates use the configured cap.' };
}
export function isDue(slot: number, d: DatasetPlan) {
  return Math.floor(slot / 60000) % d.schedule.interval_minutes === d.schedule.phase_minute;
}
export function nextSlot(now: number, d: DatasetPlan): number {
  const minute = Math.floor(now / 60000);
  const remainder = ((d.schedule.phase_minute - minute) % d.schedule.interval_minutes + d.schedule.interval_minutes) % d.schedule.interval_minutes;
  return (minute + remainder) * 60000;
}
export function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return;
  if (/^\d+$/.test(value.trim())) return Math.min(Number.MAX_SAFE_INTEGER, now + Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
