# Analytics importer

Step 2 of the analysis plan. A separate `citilink-analytics` Worker imports the
existing archive into D1. Its settings and progress live in a SQLite Durable
Object dedicated to coordinating this archive's imports. It only lists and reads
R2; the collector Worker and its configuration remain unchanged.

Daily imports start **disabled**. The dashboard uses the API below
for every routine operation. No production backfill or schedule is enabled by
building or testing this code.

## Import behavior

- **Import missing data** starts a scan of `runs/v1/` and imports completed
  collection manifests and their successful source captures. A new run includes
  manifest objects uploaded by the time that run starts.
- The initial scan backfills history. Later runs use the same logic and skip
  completed manifests and source objects. Rescanning from the beginning also
  catches older manifests that arrive late and retries previous failures.
- A stopped or failed active scan resumes from its saved position on Start.
  Once a scan completes, Start begins a fresh missing-data scan. New objects
  beyond the active scan's snapshot are picked up in the next scan.
- Exactly one import job runs per archive. Repeated Start requests return the
  existing running job. Each batch processes one source capture; an alarm runs
  up to ten batches within a five-second budget, checking Stop between batches.
  Progress is saved after each batch. Cron recovers interrupted running jobs.
- Stop finishes the current source capture, saves progress, and stops before
  the next batch. `batch_active` indicates an in-flight batch. Stop does not
  disable the daily schedule; disabling the schedule does not stop an active job.
- Individual source errors are recorded and the scan continues. A scan with
  errors finishes as `completed_with_errors`; a later scan retries incomplete
  manifests. Infrastructure failures leave a resumable `failed` job.
- D1 writes use source object + nested row path as their stable identity.
  Interrupted chunks replay without duplicate rows. A source is marked complete
  only after its writes finish. Query `analysis_vehicles`,
  `analysis_predictions`, `analysis_routes`, and `analysis_stops` to avoid partial
  imports. Repeated payloads at different capture times remain separate records.
- Reference versions deduplicate by content hash. Route geometry stays in R2;
  searchable route/stop metadata is stored in D1. Each imported reference capture
  retains its `reference_hash` and capture timestamps, so later queries can pick
  the reference version appropriate to an observation rather than the last
  version imported during a backfill.
- All datasets retain collection outcomes and source pointers. Vehicles, stop
  predictions, and full-topology references are flattened. Service messages,
  configuration payloads, and topology-update payloads remain available in R2.
  Skips and expected/succeeded counts are preserved in `collection_runs.outcomes_json`.

## Data interpretation

UTC scheduled, requested, and completed timestamps remain distinct. Observation
time is the request time, not a claimed GPS measurement time. Original French
records are retained in `raw_json` and/or the original R2 object; interpretation
version 1 is recorded per source object.

Raw speed has no assumed unit. Extreme raw speed values are flagged without
being changed. Missing occupancy stays null in the normalized percentage while
the raw value is retained. Visibility is a display flag, not an in-service flag.
Starter performance summaries should default to `is_visible=1`, as agreed.
Ordinary reported delay text can be parsed into signed minutes; `on time` stays
a category and `1h+ late` is stored as a lower bound.

Predictions retain both original status codes, destination text/key, prediction
ID, and clock-second values. A scheduled zero gets a nullable normalized alias.
Vendor display states are flagged. `service_date` deliberately stays null until
an explicit date-resolution rule is agreed. Full source records allow later
translation corrections; completed imports are not silently reinterpreted on
every run. A future interpretation change should include an explicit migration
or reprocessing operation.

## Dashboard API

All routes require `Authorization: Bearer <IMPORT_TOKEN>`. Configure a secret of
at least 24 characters; requests fail closed without it. Do not put this secret
in a public browser bundle. The dashboard's server-side authentication layer
mediates access; see ANALYTICS-DASHBOARD.md.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/imports` | Persisted settings/job, active batch, next schedule, totals, and errors |
| POST | `/api/imports/start` | Start missing-data scan or resume stopped/failed scan |
| POST | `/api/imports/stop` | Stop at the current source-capture boundary |
| PUT | `/api/imports/settings` | Save `daily_enabled`, `daily_time` (`HH:mm`), optional fixed timezone |

Example settings body:

```json
{"daily_enabled":false,"daily_time":"03:00","timezone":"America/Indiana/Indianapolis"}
```

The Worker checks the schedule each minute in Indianapolis time. It runs at
most once per local date, catches up on a delayed tick, runs at the first valid
time after a spring clock gap, and does not run twice during a fall clock repeat.
Enabling a schedule after today's selected time causes a catch-up on the next
tick. A daily trigger during an active manual job shares that job. Alarms may
continue an active job independently of whether daily scheduling is enabled.

Status progress counters describe the current scan; `totals` reflects completed
source objects in D1. A hard interruption between a D1 commit and the progress
checkpoint can undercount that scan's counters; it cannot duplicate imported
observations. No percentage is reported before discovery establishes a total.

## Provisioning and release

The current production setup is recorded in ANALYTICS-DEPLOYMENT.md. For a new
environment, before a production release:

1. Create the dedicated `citilink-analytics` D1 database and put its actual ID in
   `wrangler.analytics.jsonc`.
2. Apply the migration with the repository's pinned Wrangler:
   `npx wrangler d1 migrations apply citilink-analytics --remote --config wrangler.analytics.jsonc`.
3. Set `IMPORT_TOKEN` through the deployment's protected secret mechanism, and
   deploy with `npx wrangler deploy --config wrangler.analytics.jsonc`.
4. Verify authenticated status reports daily imports disabled. Starting a full
   backfill and enabling daily imports remain dashboard-controlled actions.

The production Worker compatibility date is `2026-10-30`, the newest supported
date in the project's pinned local test runtime. No dependencies were upgraded.
The dashboard, SQL editor, CSV export, and Access integration are documented in
ANALYTICS-DASHBOARD.md. Hosted D1 throughput remains to be measured before a full backfill.

## Verification

`npm run check` includes both Workers' dry-run builds, existing collector checks,
normalization and daylight-saving tests, and integration tests using actual
local R2, D1, and SQLite Durable Object bindings. The integration tests cover
repeat imports, successful empty responses, recorded upstream failures, missing
sources retried later, late-arriving older manifests, interrupted D1 batches,
reference deduplication, authenticated controls, alarm-driven importing, and
settings persistence across a complete runtime restart.
