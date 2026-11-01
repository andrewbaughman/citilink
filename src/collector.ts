import { buildStopIndex, resolveCampaign, type StopIndex } from './selection';
import { IDS, estimatePlan, isDue, nextSlot, retryAfter, validatePlan, type DatasetId, type DatasetPlan, type Plan } from './plan';
import { base64, jsonOptions, parseJson, pathFor, readBody, safeHeaders, sha256, stopRoster, structurallyValid, upstreamUrl, type Bucket } from './archive';

export interface Store { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<unknown> }
export interface IO { now(): number; sleep(ms: number): Promise<void>; fetch(url: string, init: RequestInit): Promise<Response> }
export const liveIO: IO = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve,ms)), fetch: (url,init) => fetch(url,init) };
interface Stats {
  enabled: boolean; first_due: number; last_due?: number; last_success_slot?: number; last_archived_at?: number;
  failures: number; successes: number; incident: boolean; last_error?: string; last_object?: string;
  coverage?: number; observations: number; last_hash?: string; unchanged_since?: number;
}
export interface Attempt {
  dataset: DatasetId; stop_id?: number; attempt_id: string; attempt: number;
  scheduled_at: number; requested_at: number; completed_at: number; archived_at?: number;
  url: string; request_headers: Record<string,string>; response_headers: Record<string,string>;
  http_status: number | null; complete: boolean; valid_json: boolean; structurally_valid: boolean;
  captured_bytes: number; body_sha256: string; object_sha256?: string; object_key?: string;
  storage_representation: 'upstream_json' | 'base64_diagnostic'; ok: boolean; retryable: boolean; error?: string;
}
interface Outcome { expected: number; succeeded: number; skipped: string[] }
interface Run {
  run_id: string; slot: number; started_at: number; plan_hash: string; lease_until: number;
  expected: Partial<Record<DatasetId, number>>; selected_stops: number[]; roster_reference?: string;
  selection_context?: ReturnType<typeof resolveCampaign>['context'];
  attempts: Attempt[]; outcomes: Partial<Record<DatasetId,Outcome>>;
}
interface State {
  version: 1; activated_at: number; plan_hash: string; last_tick?: number; last_handled_slot?: number;
  config_error?: string; archive_error?: string; runtime_error?: string;
  budget: { day: string; total: number; optional: number; datasets: Partial<Record<DatasetId,number>> };
  last_request_at?: number; source_failures: number; cooldown_until: number; pause_seconds: number;
  stop_index?: StopIndex; roster: number[]; roster_reference?: string; discovery_error?: string; cursor: number;
  source_version?: string; topology_pending: boolean; last_topology_at?: number;
  datasets: Record<DatasetId,Stats>; active_run?: Run; last_manifest?: string; recent_runs: { slot: number; key: string; status: string }[];
}
const VERSION = '1.0.0';
const slotOf = (at: number) => Math.floor(at/60000)*60000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0,10);
export class Engine {
  private state!: State;
  private plan!: Plan;
  private hash = '';
  private loading?: Promise<void>;
  private busy = false;
  constructor(private store: Store, private bucket: Bucket, private rawPlan: unknown, private io: IO = liveIO) {}
  private save() { return this.store.put('state', this.state); }
  private async load() {
    this.loading ??= this.initialize();
    return this.loading;
  }
  private async initialize() {
    this.state = await this.store.get<State>('state') ?? {
      version: 1, activated_at: this.io.now(), plan_hash: '',
      budget: { day: dayOf(this.io.now()), total: 0, optional: 0, datasets: {} },
      source_failures: 0, cooldown_until: 0, pause_seconds: 0, roster: [], cursor: 0,
      topology_pending: false, datasets: {} as Record<DatasetId,Stats>, recent_runs: [],
    };
    if (this.state.version !== 1) throw Error('Unsupported coordinator state');
    try {
      this.plan = validatePlan(this.rawPlan);
      this.hash = await sha256(JSON.stringify(this.rawPlan));
      if (this.hash !== this.state.plan_hash) {
        await this.bucket.put(`config/v1/${this.hash}.json`, JSON.stringify(this.rawPlan,null,2), jsonOptions);
        this.state.plan_hash = this.hash;
        this.state.activated_at = this.io.now();
        for (const id of IDS) {
          const prior = this.state.datasets[id];
          this.state.datasets[id] = { ...prior, enabled: this.plan.datasets[id].enabled, first_due: nextSlot(this.io.now(),this.plan.datasets[id]), last_success_slot: prior?.enabled === false ? undefined : prior?.last_success_slot, failures: 0, successes: 0, incident: false, observations: prior?.observations ?? 0 };
          if (id === 'full_topology' && prior?.enabled === false && this.plan.datasets[id].enabled && this.plan.datasets[id].triggers?.on_bootstrap) this.state.topology_pending = true;
        }
        // No scheduled-data backfill or R2 config pointer. New deployment owns this revision.
      }
      if(this.plan.datasets.stop_predictions.enabled && this.plan.datasets.stop_predictions.selection.mode==='campaign' && !this.state.stop_index){
        try{
          const object=this.state.roster_reference && this.bucket.get ? await this.bucket.get(this.state.roster_reference) : null;
          if(object)this.state.stop_index=buildStopIndex(JSON.parse(await object.text()));
        }catch{this.state.discovery_error='archived_topology_index_unavailable';}
        if(!this.state.stop_index)this.state.topology_pending=true;
      }
      this.state.config_error = undefined;
    } catch (error) {
      this.state.config_error = (error as Error).message;
    }
    await this.save();
  }
  async tick(scheduledTime: number) {
    if (this.busy) return { status: 'busy' };
    this.busy = true;
    try {
      await this.load();
      if (this.state.config_error) await this.initialize();
      const now = this.io.now(), slot = slotOf(scheduledTime);
      const previousTick = this.state.last_tick;
      this.state.last_tick = now;
      if (this.state.config_error) { await this.save(); return { status: 'invalid_config' }; }
      if (!Number.isFinite(scheduledTime) || slot > slotOf(now)) throw Error('Invalid scheduled time');
      if (this.state.active_run) {
        if (this.state.active_run.lease_until > now && !this.state.archive_error) { await this.save(); return { status: 'recovering_inflight' }; }
        // A crashed invocation's reserved requests remain charged. Never replay them.
        for (const id of Object.keys(this.state.active_run.expected) as DatasetId[]) {
          const o = this.state.active_run.outcomes[id] ??= { expected: this.state.active_run.expected[id]!, succeeded: 0, skipped: [] };
          o.skipped.push('previous_invocation_interrupted');
        }
        await this.finish(this.state.active_run, 'interrupted');
        if (this.state.active_run) return { status: 'archive_unavailable' };
      }
      if (slot <= (this.state.last_handled_slot ?? -1)) { await this.save(); return { status:'duplicate' }; }
      if (this.state.archive_error) {
        // Prove storage recovered before retrieving more irreplaceable observations.
        try {
          await this.bucket.put(`operations/recovery/${pathFor(now)}/${crypto.randomUUID()}.json`, JSON.stringify({ recovered_at: now }),jsonOptions);
          this.state.archive_error = undefined;
        } catch { await this.save(); return { status: 'archive_unavailable' }; }
      }
      if (previousTick !== undefined && now-previousTick > 180000 && this.plan.datasets.full_topology.triggers?.on_collection_resume) this.state.topology_pending = true;
      const run: Run = {
        run_id: crypto.randomUUID(), slot, started_at: now, plan_hash: this.hash, lease_until: now+180000,
        expected: {}, selected_stops: [], roster_reference: this.state.roster_reference, attempts: [], outcomes: {},
      };
      const due = IDS.filter(id => {
        const d = this.plan.datasets[id];
        if (!d.enabled) return false;
        let wanted = isDue(slot,d);
        if (id === 'full_topology') {
          wanted ||= !!(d.triggers?.on_bootstrap && this.state.last_topology_at === undefined) || this.state.topology_pending;
          if (wanted && this.state.last_topology_at !== undefined && now-this.state.last_topology_at < (d.triggers?.min_gap_minutes ?? 0)*60000) {
            this.state.topology_pending = true; return false;
          }
        }
        return wanted;
      }).sort((a,b) => Number(this.plan.datasets[a].tier === 'optional')-Number(this.plan.datasets[b].tier === 'optional') || this.plan.datasets[b].priority-this.plan.datasets[a].priority);
      // Prepare stop selection after any due full topology runs, so bootstrap can discover IDs.
      for (const id of due) run.expected[id] = id === 'stop_predictions' ? this.plan.datasets[id].selection.max_stops_per_cycle! : 1;
      this.state.last_handled_slot = slot;
      this.state.active_run = run;
      await this.save();
      for (const id of due) {
        const d = this.plan.datasets[id];
        let targets: (number | undefined)[] = [undefined];
        let selectionError: string | undefined;
        if (id === 'stop_predictions') {
          if(d.selection.mode==='campaign'){
            try{
              const selected=resolveCampaign(d.selection,slot,this.state.stop_index ?? {});
              targets=selected.ids;run.selection_context=selected.context;
            }catch(error){targets=[];selectionError=(error as Error).message;}
          } else if (d.selection.mode === 'fixed') {
            targets = [...d.selection.stop_ids!];
            if (targets.some(s => !this.state.roster.includes(s!))) selectionError = 'unknown_stop_or_roster_unavailable';
          } else {
            const cap = Math.min(d.selection.max_stops_per_cycle!,this.state.roster.length);
            targets = Array.from({length:cap},(_,i) => this.state.roster[(this.state.cursor+i)%this.state.roster.length]);
            if (!cap) selectionError = 'roster_unavailable';
            this.state.cursor = (this.state.cursor+cap)%Math.max(1,this.state.roster.length);
          }
          run.selected_stops = targets.filter((x): x is number => x !== undefined);
          run.roster_reference = this.state.roster_reference;
        }
        const expected = targets.length || d.selection.max_stops_per_cycle || 1;
        run.expected[id] = expected;
        const outcome: Outcome = run.outcomes[id] = { expected, succeeded: 0, skipped: [] };
        if (selectionError) { outcome.skipped.push(selectionError); await this.save(); continue; }
        for (const stop of targets) {
          let success = false;
          for (let attempt=1;attempt<=d.retry.max_attempts;attempt++) {
            const reason = await this.admit(id,run.slot,d);
            if (reason) { outcome.skipped.push(reason); break; }
            const result = await this.capture(id,run,attempt,stop);
            run.attempts.push(result);
            if (result.ok) {
              outcome.succeeded++; success = true;
              const stats = this.state.datasets[id];
              stats.last_object = result.object_key;
              if (stats.last_hash !== result.body_sha256) stats.unchanged_since = result.requested_at;
              stats.last_hash = result.body_sha256;
              stats.observations++;
            }
            await this.save();
            if (success || !result.retryable || this.state.archive_error) break;
            const delay = Math.min(d.retry.max_backoff_seconds,d.retry.initial_backoff_seconds*2**(attempt-1))*1000;
            if (attempt < d.retry.max_attempts && this.io.now()+delay <= run.slot+d.max_start_lag_seconds*1000) await this.io.sleep(delay);
          }
          if (this.state.archive_error) { outcome.skipped.push('archive_unavailable'); break; }
        }
        await this.save();
        if (this.state.archive_error) break;
      }
      for (const id of due) if (!run.outcomes[id]) run.outcomes[id] = { expected:run.expected[id]!, succeeded:0, skipped:['archive_unavailable'] };
      await this.finish(run, 'finished');
      return { status: this.state.archive_error ? 'archive_unavailable' : 'finished', manifest: this.state.last_manifest };
    } catch {
      if (this.state) { this.state.runtime_error = 'collector_invocation_failed'; await this.save(); }
      throw Error('Collector invocation failed; check authenticated status');
    } finally { this.busy = false; }
  }
  private async admit(id: DatasetId, slot: number, d: DatasetPlan): Promise<string | undefined> {
    let now = this.io.now();
    if (now > slot+d.max_start_lag_seconds*1000) return 'observation_deadline_passed';
    if (this.state.cooldown_until > now) return 'upstream_cooldown';
    const gap = this.plan.global.min_request_spacing_ms-(now-(this.state.last_request_at ?? -Infinity));
    if (gap>0) await this.io.sleep(gap);
    now = this.io.now();
    if (now > slot+d.max_start_lag_seconds*1000) return 'observation_deadline_passed';
    if (dayOf(now) !== this.state.budget.day) this.state.budget = {day:dayOf(now),total:0,optional:0,datasets:{}};
    const b = this.state.budget, g = this.plan.global;
    if (b.total >= g.max_requests_per_utc_day) return 'daily_budget_exhausted';
    if (d.tier === 'optional' && b.optional >= g.max_requests_per_utc_day-g.reserved_essential_requests_per_utc_day) return 'essential_budget_reserved';
    if ((b.datasets[id] ?? 0) >= (d.max_requests_per_utc_day ?? Infinity)) return 'dataset_budget_exhausted';
    b.total++;
    if (d.tier === 'optional') b.optional++;
    b.datasets[id] = (b.datasets[id] ?? 0)+1;
    this.state.last_request_at = now;
    await this.save(); // Reserve before the network request, not after it succeeds.
  }
  private async capture(id: DatasetId, run: Run, number: number, stopId?: number): Promise<Attempt> {
    const started = this.io.now(), url = upstreamUrl(id,started,stopId);
    const attemptId = crypto.randomUUID();
    const requestHeaders = { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'CitilinkHistoryCollector/1.0 (+https://github.com/andrewbaughman/citilink)' };
    let response: Response | undefined;
    let bytes: Uint8Array = new Uint8Array();
    let complete = false, error: string | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),this.plan.datasets[id].timeout_seconds*1000);
    try {
      response = await this.io.fetch(url, { method:'GET', headers:requestHeaders, redirect:'manual', cache:'no-store', signal:controller.signal });
      const body = await readBody(response);
      bytes = body.bytes; complete = body.complete; error = body.error;
    } catch { error = controller.signal.aborted ? 'upstream_timeout' : 'upstream_fetch_failed'; }
    finally { clearTimeout(timer); }
    const parsed = parseJson(bytes);
    const shape = parsed.valid && structurallyValid(id,parsed.value);
    const sourceOK = !!response?.ok && complete && parsed.valid && shape;
    const recoveringFromPause = this.state.cooldown_until > 0;
    error ??= !complete ? 'incomplete_response' : !response?.ok ? `upstream_http_${response?.status ?? 'missing'}` : !parsed.valid ? 'invalid_json' : !shape ? 'unexpected_response_structure' : undefined;
    const result: Attempt = {
      dataset:id, stop_id:stopId, attempt_id:attemptId, attempt:number, scheduled_at:run.slot,
      requested_at:started, completed_at:this.io.now(), url, request_headers:requestHeaders,
      response_headers:response ? safeHeaders(response.headers) : {}, http_status:response?.status ?? null,
      complete, valid_json:parsed.valid, structurally_valid:shape, captured_bytes:bytes.length,
      body_sha256:await sha256(bytes), storage_representation:complete && parsed.valid ? 'upstream_json':'base64_diagnostic',
      ok:false, retryable:!response || response.status >= 500 || response.status === 408 || response.status === 429 || !complete, error,
    };
    const key = `${result.storage_representation === 'upstream_json' ? 'raw':'diagnostics'}/v1/${id}/${pathFor(run.slot)}/${run.run_id}/${stopId === undefined ? '':`${stopId}/`}${attemptId}.json`;
    const stored = result.storage_representation === 'upstream_json' ? bytes : new TextEncoder().encode(JSON.stringify({
      schema_version:1, dataset:id, scheduled_at:run.slot, requested_at:started, completed_at:result.completed_at,
      url, http_status:result.http_status, response_headers:result.response_headers, complete,
      captured_bytes:bytes.length, body_sha256:result.body_sha256, body_base64:base64(bytes), error,
      representation:'lossless_base64_diagnostic',
    }));
    try {
      await this.bucket.put(key,stored,jsonOptions);
      result.object_key = key; result.object_sha256 = await sha256(stored); result.archived_at = this.io.now(); result.ok = sourceOK;
    } catch { result.error = 'archive_write_failed'; result.retryable = false; this.state.archive_error = 'response_archive_write_failed'; }
    if (sourceOK) {
      this.state.source_failures=0; this.state.cooldown_until=0; this.state.pause_seconds=0;
      if (result.ok && id === 'full_topology') {
        const roster = stopRoster(parsed.value);
        if (roster.length) { this.state.roster=roster; this.state.roster_reference=key; this.state.stop_index=buildStopIndex(parsed.value); this.state.discovery_error=undefined; }
        else this.state.discovery_error='no_valid_stops_in_topology';
        this.state.last_topology_at=started; this.state.topology_pending=false;
      }
      if (result.ok && id === 'config_version') {
        const version = JSON.stringify(parsed.value);
        if (this.state.source_version !== undefined && version !== this.state.source_version && this.plan.datasets.full_topology.triggers?.on_version_change) this.state.topology_pending=true;
        this.state.source_version=version;
      }
    } else {
      this.state.source_failures++;
      const cb = this.plan.global.circuit_breaker;
      if (this.state.source_failures >= cb.consecutive_failures || recoveringFromPause) {
        this.state.pause_seconds=Math.min(cb.max_pause_seconds,Math.max(cb.initial_pause_seconds,this.state.pause_seconds*2));
        this.state.cooldown_until=this.io.now()+this.state.pause_seconds*1000;
      }
      if (response?.status === 429) {
        const until = retryAfter(response.headers.get('retry-after'),this.io.now()) ?? this.io.now()+cb.initial_pause_seconds*1000;
        this.state.cooldown_until=Math.max(this.state.cooldown_until,until);
      }
    }
    return result;
  }
  private async finish(run: Run, reason: string) {
    const finished = this.io.now();
    const key = `runs/v1/${pathFor(run.slot)}/${run.run_id}.json`;
    try {
      await this.bucket.put(key,JSON.stringify({ schema_version:1, collector_version:VERSION, ...run, finished_at:finished, completion_reason:reason, archive_error:this.state.archive_error ?? null },null,2),jsonOptions);
      if(run.expected.stop_predictions){
        await this.bucket.put('indexes/v1/stop_predictions/latest.json',JSON.stringify({schema_version:1,run_id:run.run_id,scheduled_at:run.slot,finished_at:finished,manifest_key:key,plan_hash:run.plan_hash,selection_context:run.selection_context,selected_stop_ids:run.selected_stops,outcome:run.outcomes.stop_predictions,attempts:run.attempts.filter(a=>a.dataset==='stop_predictions')},null,2),jsonOptions);
      }
      this.state.last_manifest=key;
      for (const id of Object.keys(run.expected) as DatasetId[]) {
        const d = this.plan.datasets[id], stats = this.state.datasets[id];
        const outcome = run.outcomes[id];
        const coverage = outcome ? 100*outcome.succeeded/outcome.expected : 0;
        stats.coverage=coverage; stats.last_due=run.slot;
        if (coverage >= d.health.minimum_coverage_percent && !this.state.archive_error && reason === 'finished') {
          stats.last_success_slot=run.slot; stats.last_archived_at=finished; stats.failures=0; stats.successes++;
          stats.last_error=undefined;
          if (stats.successes >= d.health.healthy_windows_before_recovery) stats.incident=false;
        } else {
          stats.failures++; stats.successes=0;
          stats.last_error=outcome?.skipped[0] ?? run.attempts.filter(a => a.dataset===id && !a.ok).at(-1)?.error ?? reason;
          if (stats.failures>=d.health.failed_windows_before_unhealthy) stats.incident=true;
        }
      }
      const degraded = Object.entries(run.outcomes).some(([id,o]) => o.succeeded/o.expected*100 < this.plan.datasets[id as DatasetId].health.minimum_coverage_percent);
      this.state.recent_runs.unshift({slot:run.slot,key,status:reason === 'finished' && degraded ? 'degraded' : reason}); this.state.recent_runs=this.state.recent_runs.slice(0,20);
      this.state.runtime_error=undefined;
      this.state.active_run=undefined;
    } catch { this.state.archive_error='run_metadata_archive_write_failed'; }
    await this.save();
  }
  async status() {
    await this.load();
    const now = this.io.now(), reasons: string[] = [];
    let changed=false;
    if (this.state.config_error) reasons.push('configuration_unavailable');
    if (this.state.archive_error) reasons.push('archive_unavailable');
    if (this.state.runtime_error) reasons.push('collector_error');
    if (this.state.last_tick === undefined || now-this.state.last_tick > 180000) reasons.push('collector_heartbeat_stale');
    const datasets: Record<string,unknown> = {};
    if (!this.state.config_error) for (const id of IDS) {
      const d = this.plan.datasets[id], stats=this.state.datasets[id];
      const deadline=stats.last_success_slot===undefined ? stats.first_due+d.health.grace_seconds*1000 : stats.last_success_slot+(d.schedule.interval_minutes*60+d.health.grace_seconds)*1000;
      const stale=d.enabled && now>deadline;
      if (stale && !stats.incident) { stats.incident=true; stats.successes=0; changed=true; }
      const healthy=!d.enabled || (!stale && !stats.incident);
      if (d.enabled && d.health.required && !healthy) reasons.push(`${id}_unhealthy`);
      else if (d.enabled && d.health.required && stats.last_success_slot===undefined) reasons.push(`${id}_warming_up`);
      datasets[id]={ ...stats, enabled:d.enabled, required:d.health.required, tier:d.tier, cadence_minutes:d.schedule.interval_minutes,
        next_due_at:nextSlot(now+60000,d), deadline, healthy, warming_up:d.enabled && stats.last_success_slot===undefined && !stale,
        unchanged_body_advisory:!!(d.enabled && d.health.unchanged_body_advisory_minutes && stats.unchanged_since && now-stats.unchanged_since>d.health.unchanged_body_advisory_minutes*60000),
      };
    }
    if (changed) await this.save();
    return {
      healthy:reasons.length===0, reasons, now, version:VERSION, plan_hash:this.state.plan_hash,
      activated_at:this.state.activated_at, last_tick:this.state.last_tick, datasets,
      budget:this.state.budget.day===dayOf(now) ? this.state.budget : {day:dayOf(now),total:0,optional:0,datasets:{}},
      daily_limit:this.plan?.global.max_requests_per_utc_day, cooldown_until:this.state.cooldown_until,
      errors:{configuration:this.state.config_error,archive:this.state.archive_error,runtime:this.state.runtime_error,discovery:this.state.discovery_error},
      roster_count:this.state.roster.length, roster_reference:this.state.roster_reference,
      roster:this.state.roster, active_run:this.state.active_run ? {slot:this.state.active_run.slot,lease_until:this.state.active_run.lease_until}:undefined,
      last_manifest:this.state.last_manifest,recent_runs:this.state.recent_runs, estimate:this.plan ? estimatePlan(this.plan):undefined,
    };
  }
}
