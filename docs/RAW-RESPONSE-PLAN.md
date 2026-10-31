# Simplified Citilink plan: individual JSON responses

## Goal and scope

Build a low-maintenance historical archive of Citilink's public API. Save every response in a `.json` file. Preserve valid JSON response bytes exactly as retrieved, with separate acquisition metadata. Preserve unexpected non-JSON or incomplete responses losslessly inside JSON diagnostic records. Later analysis, prediction evaluation, reliability reports, and accessibility services can read the archive.

This design has been implemented and deployed. See [DEPLOYMENT.md](DEPLOYMENT.md) for verified live collection, archive integrity, and monitoring results. Endpoint descriptions began with the uploaded project's reverse-engineered documentation; all five enabled feeds have now returned and archived valid live JSON. Acceptable expansion beyond the conservative polling plan still needs confirmation with the source operator.

## Small architecture

| Component | Responsibility |
| --- | --- |
| One Cloudflare Worker | A one-minute Cron Trigger starts collection; HTTP routes serve a read-only status page and health endpoint |
| One Durable Object in that Worker deployment | Coordinates sequential requests and persists scheduling, request budgets, cooldowns, and recent health |
| One private R2 bucket | Stores individual JSON responses, JSON diagnostics, run manifests, and configuration snapshots |
| One external uptime monitor | Checks collection freshness and sends interruption/recovery emails, including when Cloudflare is unreachable |

Use a SQLite-backed Durable Object for new deployments; its small operational state fits the included storage allowance. The Durable Object coordinates the outbound requests so overlapping invocations cannot create parallel collectors or reset budgets. Its storage holds operational state, not parsed bus observations. All infrastructure is managed; there are no servers or database migrations.

Leave Queues, distributed collectors, a second monitor Worker, Cloudflare email delivery, a configuration-editing dashboard, and custom analytics out of the first version. The external monitor handles email delivery and incident deduplication. Store each valid JSON API response as its own unchanged `.json` file, with acquisition metadata in a separate JSON manifest. Every stored response file, including diagnostics, is valid JSON.

## Conservative retrieval defaults

API base: `https://swiv.citilink.cadavl.com/SWIV/CITILINK/proxy/restWS`.

| Dataset | Endpoint | Default cadence | Base requests/day |
| --- | --- | --- | ---: |
| Vehicle positions | `/topo/vehicules` | Every minute | 1,440 |
| Topology/detour updates | `/topo/refresh` | Every minute | 1,440 |
| Service messages | `/iv/message` | Every five minutes | 288 |
| Configuration version | `/config/version` | Every five minutes | 288 |
| Full routes and stops | `/topo` | Hourly | 24 |
| Stop predictions | `/horaires/pta/{idPointArret}` | Disabled | 0 |
| **Total** | | | **3,480** |

Full topology also refreshes at bootstrap, after version changes, and on collection resume. Coalesce overlapping triggers and enforce a ten-minute minimum gap. Exceptional requests and retries count toward budgets but are not included in the base total.

The fleet endpoint returns all available buses in one request. Preserve every returned vehicle and field, including vehicles the map would hide. Store topology updates as separate raw responses; do not merge them into a reconstructed network.

If useful, enable a fixed panel of up to ten stops every five minutes. This adds 2,880 requests/day, for approximately 6,360 total before retries and exceptional refreshes. Alternatively, rotate a small panel across known stops and display the full sweep duration. Do not enable all-stop minute polling or automatically increase coverage. The sample's 751 stops would otherwise require about 1.08 million requests/day.

Run all day. Empty fleets, empty predictions, nulls, and unchanged responses can be legitimate data. Store and schedule in UTC; display Fort Wayne service dates using `America/Indiana/Indianapolis`.

Departure-navigation crawling is deferred. If added later, it needs an explicit configurable plan and a small request cap under the same global safeguards.

## One configuration file

Use a version-controlled `capture-plan.json`, deployed with the Worker. [capture-plan.json](../capture-plan.json) supplies the conservative starting settings. Edit that file and redeploy to change retrieval plans without editing collector code. No runtime configuration editor is needed initially.

| Per-dataset setting | Purpose |
| --- | --- |
| `enabled` | Turn retrieval on or off |
| `schedule.interval_minutes` | Independent cadence in whole minutes, minimum one |
| `schedule.phase_minute` | Stagger collection within that interval |
| `selection` | An unfiltered network response, an explicit stop list, or a bounded rotating stop panel |
| `tier` / `priority` | Essential/optional budget classification and dispatch order |
| `max_requests_per_utc_day` | Optional additional dataset limit, including retries |
| `timeout_seconds` / `max_start_lag_seconds` / `retry` | Overrides for timeout, stale-work deadline, and bounded retries |
| `triggers` | Full-topology bootstrap/version/resume refreshes and minimum spacing |
| `health` | Required status, freshness grace, coverage target, and failure/recovery thresholds |

Shared `defaults` supply timeout, retry, and health values; dataset overrides merge by field, including nested fields. Reject unknown fields and invalid values. Dataset IDs map to an audited endpoint registry; settings cannot introduce arbitrary URLs or hosts. Global concurrency, spacing, budgets, and cooldowns always apply.

For stop requests, support `fixed` selection with explicit unique IDs or `round_robin` selection from the latest valid topology with a persisted cursor. Both enforce `max_stops_per_cycle`. An enabled fixed selection must contain real stop IDs, and its list must fit its cap. Reject oversized lists rather than silently dropping IDs. An empty list never means all stops. For network endpoints, `selection.mode: all` means one unfiltered request, not one request per bus or stop.

Read a copy of archived topology only to discover and validate stop IDs. Preserve its original bytes. Retain the previous valid roster if discovery fails, flag degradation, and continue fleet collection. Record the roster reference and selected IDs in each stop cycle. Show round-robin batch cadence and full-roster sweep duration separately.

For example, slow messages by changing their interval from 5 to 15. Enable the optional prediction panel by setting `stop_predictions.enabled` to true and supplying up to ten real stop IDs. Pause it with `enabled: false`. No collector code changes are needed.

### Validate and record changes

Before deployment, validate selectors, positive bounds, interval/phase relationships, retries, and budgets. Show estimated base requests/day, headroom for retries/triggers, and the difference from the previous plan. Reject a baseline that cannot fit its global, optional, or dataset budget; never auto-raise a limit. Recompute estimates for roster changes and keep any extra work within existing caps.

Archive each validated non-secret plan once at `config/v1/<sha256>.json`. Include its hash in every manifest and on the status page. Configuration comes from the deployed file; no editable R2 pointer or separate configuration service is needed. If a plan cannot be validated or archived, send no upstream requests under it and report failure. Rollback redeploys the previous version.

Keep the Cloudflare Cron Trigger fixed at one minute. A dataset is due when `UTC epoch minute % interval_minutes == phase_minute`, with `0 <= phase_minute < interval_minutes`. Pace requests rather than launching them simultaneously. Local operating-hour rules and daylight-saving scheduling are outside the first version.

Each cycle pins its plan and selected roster. Changes apply to new cycles without backfilling skipped time. During deployment, finish or abort the bounded in-flight request, then apply the new plan before admitting more work; new safety restrictions apply to remaining requests. Disabling a dataset cancels unstarted work and excludes it from missing-data alerts.

## Protect the upstream API

Every request, including retries, redirects, bootstrap, and recovery probes, passes through the same coordinator:

- One request in flight, with at least one second between starts.
- A hard ceiling of 8,000 requests per UTC day. Reserve 4,000 for essential datasets; optional work can use at most the other 4,000. Essential work also counts toward the total ceiling.
- A ten-second timeout and at most two attempts per observation by default. Retries require remaining budget and must fit the observation deadline.
- No catch-up bursts. Expire unstarted observations more than 120 seconds after their slot by default and record the gap. A late response carries its actual retrieval time.
- Honor `Retry-After` globally on 429. Repeated network/5xx failures open a circuit breaker, initially pausing for five minutes and increasing up to an hour. Admit only one paced recovery probe after a pause; further failures extend it. A 429 cooldown starts immediately.
- Persist counters, cycle/in-flight ownership, and cooldowns across restarts. Reserve a request in durable state before sending it; ambiguous failures remain charged. UTC-day rollover does not reset continuous spacing.

Skip optional work first when budget is constrained. Missing required observations must remain visibly degraded and generate an alert; never silently increase traffic to satisfy coverage. Contact Citilink/the feed operator before expansion and ask about an authorized bulk predictions or GTFS-Realtime feed. These limits reduce load but do not establish upstream permission. Keep TLS verification on and do not reuse uploaded session cookies.

## Individual JSON files

Write each response directly to its own R2 object:

```
raw/v1/vehicles/2026/11/01/12/00/<attempt-id>.json
raw/v1/topology_updates/2026/11/01/12/00/<attempt-id>.json
raw/v1/stop_predictions/2026/11/01/12/03/273438/<attempt-id>.json
diagnostics/v1/vehicles/2026/11/01/12/00/<attempt-id>.json
runs/v1/2026/11/01/12/00/<run-id>.json
config/v1/<plan-sha256>.json
```

Every response file uses the `.json` extension and R2 `Content-Type: application/json`. Validate a copy of the body as UTF-8 JSON regardless of the upstream MIME type; the supplied project reports JSON served as `application/octet-stream`. For complete valid JSON, write the original bytes directly: no reserialization, filtering, newline normalization, packaging, or collector-added compression. This also applies to valid JSON error responses with non-2xx HTTP status. Acquisition metadata stays in the separate manifest, not inside the upstream JSON.

An HTML error, malformed JSON, binary content, or incomplete body cannot simultaneously remain an unchanged standalone body and become valid JSON. Preserve these exceptions in a JSON diagnostic record under `diagnostics/`, containing the observed status/headers, error, completeness, original byte length/checksum, and `body_base64`. Base64 preserves every captured byte losslessly. Mark `storage_representation: base64_diagnostic` in the manifest and record checksums for both the original captured body and the stored diagnostic file; normal records use `storage_representation: upstream_json`. Never count a diagnostic envelope as a valid upstream JSON observation. A failure before receiving a response has a JSON error record but no invented response body.

Each normal response is directly downloadable and inspectable as JSON. Fetch may perform transport decoding, so this is an application-response archive rather than a packet capture; record decoding notes and do not assume upstream Content-Length matches stored bytes.

Use unique attempt IDs so retries cannot overwrite earlier observations. Preserve duplicate responses and error responses using the JSON rules above. Retain any available partial bytes only in a JSON diagnostic explicitly marked incomplete. Bound memory use and report oversize failures instead of silently truncating responses.

Write one JSON manifest per cycle, containing:

- Run ID, collector version, configuration hash, scheduled slot, and expected dataset/stop requests.
- Each attempt's dataset, URL, safe request headers, actual start/completion times, HTTP status, and safe response headers.
- Raw object key, byte length, SHA-256, completeness, structural-validation result, and transport/archive errors.
- Stop roster/selected IDs when relevant, skipped work with reasons, and final outcome.

Exclude authentication/session secrets from header metadata and mark redactions. Valid JSON response bodies remain unchanged; exceptional bodies are preserved losslessly in diagnostic JSON. Use audited host/path allowlists, no Worker caching, unconditional GETs, and the client's timestamp cache-buster. Capture caching indicators when present; retrieval success does not prove source freshness. Do not automatically follow unexpected-host redirects.

After attempts finish, write the manifest, then update coordinator health. A run is complete only after the required bodies and manifest are saved. If R2 fails, report the error through coordinator state and retain prior successful timestamps. A later fetch cannot recover an unsaved past observation. R2 does not atomically commit bodies and manifests together: interrupted runs can leave orphan bodies, which are retained and can be located by run prefix. Avoid a separate reconciliation pipeline initially.

Keep the bucket private and retain the archive indefinitely by default. There are no compaction, extraction, conversion, or automatic-deletion jobs. Independent backup/export can be added later if stronger disaster protection is needed.

## Status and email alerts

Serve a small read-only status page from the same Worker. Show the active plan, last tick, per-dataset enabled state/cadence/next slot, last successful archive, recent errors, selected-stop coverage, daily budget, cooldowns, skipped windows, and latest manifest/object references for authenticated inspection.

The initial workers.dev dashboard uses built-in HTTP Basic authentication (username `citilink`, password from `STATUS_TOKEN`), with bearer authentication for scripts. It fails closed if that secret is absent. Add Cloudflare Access later when a suitable domain is available. Expose a separate minimal `/healthz` endpoint to the external monitor, using a dedicated read-only token if supported. Do not expose raw bucket listing, bodies, secrets, or control endpoints publicly.

Evaluate freshness at request time; never return a stale stored `healthy: true`. Return 503 when the collector heartbeat is more than three minutes old, coordination/configuration/archival failures are unresolved, or an enabled required dataset is unhealthy. Return 200 only when these checks pass.

A dataset is unhealthy when either:

- The current time exceeds `last successful scheduled slot + interval + grace`.
- Its configured number of scheduled windows fail, default three.

Count only complete, structurally valid archived responses as healthy, while preserving invalid responses too. With the default 120-second grace, one-minute feeds become stale after three minutes, five-minute feeds after seven, and hourly topology after 62. At startup, allow until each first due slot plus grace and display warming up; full topology has an immediate bootstrap trigger. Disabled datasets are excluded. In the example, enabling stop predictions makes their coverage required, with a 95% target.

Budget skips, circuit-breaker pauses, and timeouts count as missed windows. Empty valid lists do not. Unchanged fleet bodies can be a stale-source advisory during expected service, but do not by themselves prove an outage. Upstream freshness may be unknown without source timestamps.

Latch an incident until affected datasets recover for the configured number of healthy windows, default two. Configure the external monitor to check every minute and email on confirmed failure and recovery, with limited reminders. It owns recipient addresses, delivery, and incident deduplication; the Worker supplies health and diagnostic detail. Exact email timing also depends on the monitor's confirmation settings. Test interruption and recovery email before relying on it.

One external monitor is intentional: Cloudflare-only monitoring cannot reliably alert during a broad Cloudflare outage. No separate custom email system is needed. An optional GitHub Actions fallback is included at a 15-minute, best-effort cadence and remains dormant until its deployed origin is configured. It is not equivalent to the recommended one-minute dedicated monitor; email delivery must be tested. See [RUNBOOK.md](RUNBOOK.md).

## Expected monthly cost

Budget approximately **$5/month for Cloudflare initially**, plus any paid external monitoring. At sample-sized responses and a rounded **6 GB of new JSON per month**, retaining a year of history brings Cloudflare to roughly **$6/month**. Allow **$5–$15/month total** as a planning range if the external monitor costs up to $10/month; that monitoring allowance is a budget assumption, not a verified vendor quote. A free monitor can keep the starting total near $5, but its supported check interval/email features must be verified.

The default 30-day volume is approximately 104,400 response files and 43,200 manifests, or 147,600 R2 writes before retries/exceptional refreshes. This is below R2 Standard's included one million Class A operations/month. Small status/download read volumes should fit its included ten million Class B operations/month. Storage includes ten GB-month/month; excess Standard storage is $0.015/GB-month. These allowances are shared at account level, not reserved for this project.

Workers Paid starts at $5/account/month. The collector and single small coordinator are expected to fit its included compute, request, and operational-storage allowances. There is no additional flat monthly fee per Worker or per Durable Object. Use the SQLite backend for new coordinator classes, bound state growth, and verify actual usage during the pilot. If the account already pays for Workers and has spare allowances, the incremental starting cost may be close to $0.

See [COSTS.md](COSTS.md) for current published rates, sample calculations, retention growth, cost-reduction options, and assumptions. No automatic deletion or slower collection has been enabled to achieve this estimate. Published prices were checked against Cloudflare's official documentation source on 2026-10-31; pricing and actual payloads can change.

Maintenance should mainly be occasional dependency updates, spend checks, and investigating source/API changes or incidents. Raw JSON archival tolerates new fields, but an undocumented API can still change access, endpoints, or structure. Limit parsing to discovery, version comparison, and health checks; do not add a transit database or analytics framework.

## Implementation and acceptance

1. Implement the Worker/coordinator, private bucket binding, and plan validation. No queues or email-sending infrastructure are required.
2. Verify unchanged JSON bytes/checksums against the uploaded samples. Verify non-JSON, empty, binary, malformed, and incomplete responses round-trip exactly through JSON diagnostics. Every stored response file must parse as JSON. Confirm no collector-added packaging/compression.
3. Verify schedules, selectors, disabling, rollback, and cadence-aware health. Test overlap, restarts, UTC-day rollover, retry accounting, budget exhaustion, and 429 cooldown without exceeding limits.
4. Confirm live API behavior from the deployed Worker, including whether topology refresh supports independent polling. If not, retain full snapshots and document limitations before claiming complete topology-change coverage.
5. Simulate failed body/manifest writes, coordinator failure, and a stalled collector. Confirm health failure and delivered incident/recovery emails, including when the health endpoint is unreachable.
6. Run a 24-hour conservative pilot, reconcile expected slots with manifests, inspect JSON responses, and measure traffic/storage/cost. Provide a short runbook for deploy/rollback, configuration edits, downloads, and incidents.

See [DEPLOYMENT.md](DEPLOYMENT.md) for current implementation and deployment evidence. Scheduled production collection and archive integrity have been verified. Monitor failure and recovery were tested through GitHub Actions; inbox delivery remains dependent on owner notification settings and has not been verified. A full 24-hour pilot is still pending. Minute sampling cannot reconstruct every bus movement or prove actual arrivals; later prediction/reliability work must validate source semantics and schedule availability.
