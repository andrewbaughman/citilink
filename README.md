# Citilink history collector

A small Cloudflare service that archives Fort Wayne Citilink's public API as individual JSON files. It records what the API returns rather than inserting parsed bus data into a database.

- **One Worker**, a **SQLite-backed Durable Object**, and a **private R2 bucket**.
- Fleet positions and detour updates every minute; messages/version every five minutes; full topology hourly and on coalesced change/resume events.
- **3,480 base API requests/day**. Stop predictions are disabled by default.
- A shared one-request-at-a-time pacer, one-second minimum spacing, durable daily budgets, timeouts, bounded retries, and global rate-limit backoff.
- An authenticated dashboard, raw JSON downloads, configuration history, and a freshness-aware `/healthz` endpoint.
- A `workers.dev` address with built-in dashboard authentication; **no custom domain required**.

## Live service

- [Collection health](https://citilink-history.empty-mouse-f437.workers.dev/healthz): minimal machine-readable health; no password required.
- [Private archive dashboard](https://citilink-history.empty-mouse-f437.workers.dev/): HTTP Basic username `citilink`; password is the Worker's `STATUS_TOKEN` secret.
- Cloudflare resources: Worker `citilink-history`, private R2 bucket `citilink-history`, and the SQLite coordinator.

The Worker runs every minute on Workers Free. Live vehicle, detour, and topology JSON has been archived and checksum-verified. The initial five-minute feed cycles are being validated. A generated dashboard password is kept outside Git; see the [runbook](docs/RUNBOOK.md) for choosing your own in Cloudflare. All raw files remain private.

## Run locally

Requires Node 24 or newer (CI uses Node 24).

```sh
npm ci
npm run check
```

`check` validates the capture plan, checks types, runs deterministic failure/restart tests, builds the Worker, and runs it in Miniflare with real local Durable Object/R2 bindings and mocked upstream data. Tests do not poll Citilink or create Cloudflare resources.

For interactive local development, create an ignored `.dev.vars` file containing a local `STATUS_TOKEN` of at least 24 characters, then:

```sh
npm run dev
```

The local dashboard uses HTTP Basic authentication: username `citilink`, password `STATUS_TOKEN`. `wrangler dev --test-scheduled` provides its local scheduled-event testing endpoint; it is not exposed by the deployed application. Triggering local collection accesses the real public API, so keep it occasional and respect the plan's limits.

## Configure retrieval

Edit [capture-plan.json](capture-plan.json), then run:

```sh
npm run plan
# Optional: compare with a previously saved plan
npm run plan -- capture-plan.json /path/to/previous-plan.json
```

Every dataset has its own enable flag, interval/phase, priority, selector, health policy, and optional timeout/retry/budget overrides. Global limits cannot be bypassed by a dataset. Unsupported or over-budget plans are rejected. Fixed stop panels need explicit IDs from the archived topology; empty lists never mean all stops. Configuration changes take effect on deployment, not through the public website.

See the [configuration/design reference](docs/RAW-RESPONSE-PLAN.md).

## Deploy

The provisioner requires `CLOUDFLARE_ACCOUNT_ID` and a securely configured `CLOUDFLARE_API_TOKEN` scoped to the selected account with Workers Scripts Edit and Workers R2 Storage Edit (and any account-level workers.dev registration permission required for a new account). Supply these through your environment's secure settings or GitHub Actions secrets, never a committed file or chat.

```sh
npm run deploy
```

This runs all checks, reuses or creates the private `citilink-history` bucket, ensures an account workers.dev subdomain exists, deploys the Worker with its secret and one-minute cron, and checks the deployed authenticated status/health routes. It never creates a temporary Cloudflare account or opens an interactive login.

A local deployment generates a dashboard password when none is supplied and saves it only in ignored `deployment.local.json` with owner-only file permissions. On subsequent deployments it reuses the password. It never prints the password. In CI, set a persistent `STATUS_TOKEN` repository secret as well as the two Cloudflare secrets. The **Deploy collector** workflow is manually dispatchable; pushing a commit runs checks but does not automatically deploy.

The script distinguishes an accessible deployment from healthy collection: scheduled collection may still be warming up, and a new Cron Trigger can take up to 15 minutes to propagate. Confirm actual objects and successful dataset observations before calling it live. [Deployment/runbook](docs/RUNBOOK.md).

## Storage

Complete valid JSON responses are saved **unchanged** as `.json` files with `Content-Type: application/json`, regardless of the API's declared MIME type. Each attempt has its own object; repeated identical responses and JSON HTTP errors are preserved. Separate cycle manifests record actual fetch times, scheduled slots, status, checksum, coverage, errors, selected stops, and the capture-plan hash.

HTML, malformed JSON, binary content, empty bodies, and interrupted streams are represented as JSON diagnostics containing a lossless base64 copy of available bytes. They never masquerade as healthy upstream JSON. The size safeguard is 8 MiB per response; oversize responses retain only the captured prefix, explicitly marked incomplete. No compression, combined response archives, or transit database is involved. The coordinator stores scheduling and health metadata only.

```
raw/v1/vehicles/YYYY/MM/DD/HH/mm/<run-id>/<attempt-id>.json
raw/v1/stop_predictions/YYYY/MM/DD/HH/mm/<run-id>/<stop-id>/<attempt-id>.json
diagnostics/v1/<dataset>/YYYY/MM/DD/HH/mm/<run-id>/<attempt-id>.json
runs/v1/YYYY/MM/DD/HH/mm/<run-id>.json
config/v1/<sha256>.json
```

The default is indefinite retention. No bucket-public-access setting or deletion lifecycle is enabled by the deployment tooling.

## Monitoring and email

A dedicated external uptime monitor should check the HTTPS `/healthz` endpoint and email on failure/recovery. Unlike the collector's dashboard, this does not depend on the Cloudflare management API. The default health response is public but contains no bus data or archive keys. An optional `HEALTH_TOKEN` restricts it with a separate bearer token.

An independent **Collector health** GitHub Actions workflow is included as a fallback. It checks the deployed origin every **15 minutes**; the repository variable `COLLECTOR_URL` can optionally override the version-controlled default. Set its optional `HEALTH_TOKEN` secret if used. Failure/recovery email delivery depends on the owner's GitHub Actions notification preferences and must be tested; the workflow alone does not prove email delivery. GitHub cron can be delayed, so this is not equivalent to a dedicated one-minute monitor. Public/private repository Actions quotas and charges differ. The workflow now contains the deployed workers.dev origin as its default; a repository `COLLECTOR_URL` variable can override it. No repository-variable API permission is required.

## Cost and current limitations

The current deployment uses **Workers Free**, with no paid plan purchased. Initial usage is expected to fit Cloudflare's free quotas; R2 storage grows with retention. Workers Paid remains an optional $5/account/month upgrade for extra headroom. Uploaded samples project about **6 GB of new JSON/month**, approximately 148,000 R2 writes/month, and around **$1/month of storage at a year's retained volume**. [Detailed estimates and savings](docs/COSTS.md).

The implementation is saved on GitHub, all 25 automated tests passed, and the Worker/private bucket/minute schedule are deployed. R2 activation is complete. Live collection has started; validation of the five-minute datasets and the configured monitoring workflow is in progress. Notification delivery remains dependent on GitHub email settings and has not been confirmed in an inbox. See [deployment status](docs/DEPLOYMENT.md) for current evidence.

The uploaded discovery material and browser examples are preserved in [api-discovery](api-discovery), [poc](poc), and [webapp](webapp). They are reference tools, not production collector dependencies. Original project notes are in [docs/reference-project.md](docs/reference-project.md). Uploaded cookies and Git metadata were deliberately excluded.
