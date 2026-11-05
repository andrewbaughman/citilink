# Citilink analysis, importer, and dashboard plan

Status: agreed plan; implementation has not started.

## Goal and scope

Provide a simple, open-ended starting point for analyzing the JSON history in the `citilink-history` R2 bucket, entirely within Cloudflare. Keep the original JSON in R2, load useful structured observations into D1, and provide a Worker-hosted dashboard with exploratory queries, CSV export, and a read-only SQL editor.

All routine import operations must be controllable through the dashboard. Start with daily freshness and manual catch-up. Avoid continuous streaming, spreadsheet integration, a separate analytics platform, or unnecessary orchestration infrastructure in the first version.

D1 is the proposed starting database, subject to validating record counts, storage growth, and query performance in phase 1. If that validation shows it is unsuitable, review the choice with the owner before proceeding.

## Agreed order

1. Validate one day together with the owner to understand and agree on the interpretation of the data.
2. Build the importer.
3. Build the dashboard.

Do not proceed from validation to implementation until the findings have been reviewed with the owner and the interpretation and table structure are agreed. Do not automatically launch a full backfill or enable daily imports.

## 1. Validate one day together

Choose a representative, completed day with the owner. Read the required R2 files directly; downloading the entire bucket is unnecessary.

Work through representative vehicle observations, stop predictions, topology/reference data, and collection manifests. Inspect records together, explain field meanings and uncertainty, and try a few useful queries.

The sample inspection so far found:

- Vehicle observations include location, route ID, speed, destination, upstream reported early/late status, and occupancy fields.
- Stop predictions contain nested lists of routes, destinations, prediction IDs, time values, and status codes.
- Topology includes routes, stops, and geometry.
- Collection manifests record request/capture timestamps, success status, selected stops, and links to source objects.
- The inspected collection configuration schedules vehicles every minute and stop predictions every two minutes for four selected stops. Validate configuration changes over the chosen period.
- An older prediction sample was empty while recent samples contained predictions. A successful empty response must remain distinguishable from a collection failure.
- Verify the meanings of `horaire`, `horaireApplicable`, and status codes before deriving arrival accuracy. Preserve original values while meanings are uncertain.
- Upstream reported vehicle lateness is not independently measured arrival punctuality.
- Unavailable occupancy values must not silently become zero.

Validation tasks:

- Confirm timestamp semantics, units, timezone handling, identifiers, nested array expansion, and reference joins.
- Examine retries, empty results, failures, missing collection periods, and repeated observations.
- Establish safe row identities and deduplication rules.
- Try initial summaries such as reported delay by route/hour, vehicle history, prediction revisions, and collection coverage.
- Measure records per day, estimate full-history size and growth, and check representative D1 query performance.
- Review findings, limitations, example results, and a proposed schema with the owner before phase 2.

Keep capture timestamps in UTC; display local dates/times using `America/Indiana/Indianapolis`, including daylight-saving changes. Agree explicitly on local-day versus UTC-day boundaries.

## 2. Build one resumable importer

Use the same import process for historical backfill, on-demand updates, and scheduled daily updates.

### Discovery and loading

- Discover completed collection manifests in R2 and process eligible source objects not yet imported.
- Initial backfill loads all existing eligible history.
- Later runs load newly collected or previously missed objects and retry failures.
- Preserve source R2 keys and capture metadata for traceability.
- Keep original JSON and large route geometry in R2.
- Do not change or interrupt collection into R2.

### Proposed tables

Finalize these during phase 1:

| Table | Contents |
| --- | --- |
| `vehicle_observations` | One vehicle per capture: location, route, destination, speed, reported delay, occupancy |
| `stop_predictions` | One prediction per capture: stop, route, destination, prediction ID, original time/status values |
| `routes` / `stops` | Reference names and identifiers, retaining source version where needed |
| `collection_results` | Collection time, dataset, success/failure, and successful empty responses |
| `imported_objects` | Import bookkeeping and source R2 keys |

Preserve original values wherever upstream semantics are uncertain.

### Reliability and simplicity

- Track imports by source R2 object key.
- Mark an object complete only after its required database writes succeed.
- Use unique row keys so an interruption or retry cannot create duplicates.
- Process small, resumable batches and persist progress.
- Allow only one active import; scheduled and manual triggers must not create concurrent duplicate work.
- Stop safely after the current batch and resume later.
- Surface errors and allow failed objects to be retried.
- Begin without a separate queue or orchestration service; introduce one only if demonstrated execution requirements make it necessary.

### Dashboard-controlled importing

| Control | Behavior |
| --- | --- |
| Daily imports: On/Off | Enable or disable automatic daily imports |
| Daily import time | Choose the daily run time, displayed in the owner's local timezone |
| Import missing data | Import everything collected so far that is not yet in the database, including the initial historical backfill |
| Stop import | Stop after the current batch; retain progress for a later resume |

Daily imports start **disabled**. The owner runs the initial backfill and enables the schedule through the dashboard when ready.

Disabling daily imports prevents future scheduled runs; it does not interrupt an active import. Stop import handles an active run separately. Neither control affects collection into R2.

The daily trigger should run after the previous local day ends, at the owner's selected time, and use the same missing-data importer to catch up on outstanding history.

Show import progress, active/stopped/failed/completed state, errors, last successful import, and next scheduled run. Controls and schedule settings must persist across page reloads and Worker restarts.

## 3. Build the dashboard

Keep the dashboard a flexible starting point for analysis, rather than a large set of fixed reports.

### Overview

- Available date range and observation counts.
- Collection coverage and gaps.
- Import status, progress, and errors.
- Last successful import and next scheduled run.
- All daily schedule and manual import controls described above.

### Explore

- Date, route, vehicle, and stop filters as appropriate.
- Results table.
- A small set of editable starter queries.
- CSV export.

Suggested starter queries:

- Reported delay by route and hour.
- A vehicle's observation and movement history.
- Changes to a particular stop prediction over successive captures.
- Collection gaps, failures, and empty responses.

### Read-only SQL editor

- Editable analytical SQL over the analysis tables.
- Schema browser and useful column descriptions, including known limitations.
- Results table.
- CSV export of query results.

Enforce read-only access in the backend:

- Accept a single validated read-only query.
- Reject writes, schema changes, and administrative commands.
- Keep import bookkeeping out of the analytical query interface.
- Apply query execution and result-size limits.
- Keep database credentials on the server.

Protect the dashboard with Cloudflare Access.

### CSV behavior

Export the full query result within an explicit export limit, rather than silently exporting only the visible table page. Clearly indicate when preview results or exports are capped.

## Completion and rollout checks

- Importing the same history twice creates no duplicate observations.
- An interrupted or stopped import resumes safely.
- Failed source objects can be retried without duplicating successful writes.
- Scheduled and manual imports cannot conflict.
- Successful empty responses remain distinguishable from failures.
- Disabling daily imports persists and prevents scheduled runs.
- Stopping an import preserves progress and leaves collection into R2 running.
- Local schedule handling works across daylight-saving changes.
- SQL cannot modify data or access private import bookkeeping.
- CSV results match the query, and any limits are clearly shown.
- The owner reviews the one-day validation before importer implementation.
- The full historical backfill starts through the dashboard.
- Daily imports remain disabled until the owner enables them.

## Immediate next step

Carry out the one-day validation collaboratively with the owner. This document saves the plan; it does not authorize skipping that review or beginning automated imports.
