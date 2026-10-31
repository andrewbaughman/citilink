# Deployment status

## Saved and verified on GitHub

The complete implementation and supplied reference project are on [GitHub main](https://github.com/andrewbaughman/citilink/tree/main). Initial implementation commit: [`a41901b`](https://github.com/andrewbaughman/citilink/commit/a41901b69d1597b1ac84ebb77935c679eaa09177).

All 25 automated tests passed (24 unit tests plus one compiled-Worker integration test), as did plan validation, type checking, and the production bundle. GitHub independently completed [Collector checks successfully](https://github.com/andrewbaughman/citilink/actions/runs/41249633978).

The integration test uses actual local workerd, SQLite Durable Objects, and R2 bindings with mocked upstream data. It verifies unchanged JSON bytes, manifests, authenticated dashboard/downloads, and duplicate-tick prevention. Unit tests cover pacing, daily budgets, cooldowns, configuration changes, restarts, diagnostics, and archival failure recovery. These tests are not evidence of live production collection.

## Current Cloudflare blocker

The newly published execution environment has Cloudflare credentials and network access. `npm run provision` successfully reached the Cloudflare API but bucket provisioning was rejected with:

```
HTTP 403 — Cloudflare code 10042:
Please enable R2 through the Cloudflare Dashboard.
```

Cloudflare requires an R2 subscription to be activated through its dashboard checkout flow before the API can create buckets. This is an account prerequisite, separate from the collector's code or custom-domain setup. See [Cloudflare's official R2 prerequisites](https://developers.cloudflare.com/r2/get-started/).

In the Cloudflare Dashboard, select **Storage & databases > R2 > Overview** and complete the R2 activation/checkout flow. R2 includes free monthly usage; metered usage beyond allowances may incur charges. No billing information was entered, subscription purchased, environment published, or Cloudflare resources created by the agent.

Once activation is complete, the existing authenticated environment can run `npm run deploy` to provision the private bucket, Worker, SQLite coordinator, cron, and workers.dev address. It then checks authenticated status and health endpoints. No custom domain is required.

## Collection and notifications

Production collection is not running yet. A live archive, scheduled observations, and notification delivery have not been verified.

The GitHub health-monitor fallback remains dormant until repository variable `COLLECTOR_URL` is set to the deployed origin. Its schedule is every 15 minutes, with best-effort execution and email delivery controlled by the owner's GitHub notification preferences. A dedicated one-minute external monitor remains the recommended alert path. See [RUNBOOK.md](RUNBOOK.md).
