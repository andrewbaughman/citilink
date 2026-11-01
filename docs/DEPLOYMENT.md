# Deployment status

## Saved and deployed

The complete implementation is on [GitHub main](https://github.com/andrewbaughman/citilink/tree/main). All 31 automated tests passed, including a compiled-Worker integration test using actual local SQLite Durable Object/R2 bindings. GitHub CI also passed.

Production resources created after R2 activation:

- Worker: `citilink-history` on **Workers Free**.
- Private R2 bucket: `citilink-history`, with no public access or deletion lifecycle enabled by the deployment tooling.
- SQLite-backed coordinator: `Collector`, binding `COORDINATOR`.
- Schedule: `* * * * *`.
- Origin: https://citilink-history.empty-mouse-f437.workers.dev
- Minimal health: https://citilink-history.empty-mouse-f437.workers.dev/healthz
- Authenticated dashboard/downloads: https://citilink-history.empty-mouse-f437.workers.dev/

No paid Workers plan was purchased. The unsupported custom CPU setting was removed so the Free plan enforces its own limits. Initial workers.dev propagation briefly returned 404; the site subsequently returned authenticated status successfully. The deployment verification script now tolerates brief propagation delays.

## Live validation passed

Live scheduled runs have begun saving vehicle positions, topology updates, and a full topology snapshot. Downloaded JSON objects were parsed and verified against their recorded SHA-256 checksums. The live stop roster has 750 IDs; it is discovered rather than hard-coded from the uploaded sample's 751 stops.

The initial five core datasets passed live freshness checks: vehicle positions, topology/detour updates, service messages, configuration version, and full topology. The health endpoint returned HTTP 200 with `status: ok`. The slower feeds completed their initial five-minute recovery windows rather than being marked healthy early.

`npm run verify:live` downloaded a stored response from each enabled dataset, parsed each as JSON, and matched its SHA-256 to recorded acquisition metadata. Observed payload sizes in that check were 15 bytes (empty nighttime fleet), 101,562 bytes (topology updates), 1,698 bytes (service messages), 53 bytes (version), and 2,246,718 bytes (full topology). Empty fleet responses are retained as valid observations. This short-run sample is not a full-day payload forecast.

Both browser-style Basic authentication and bearer authentication were checked against the deployed application. Unauthenticated archive access returned 401. The R2 API confirmed managed public access is disabled and there are no custom public bucket domains.

A full 24-hour pilot has not yet elapsed, and email inbox delivery has not been verified.

## Monitoring

The existing GitHub **Collector health** workflow is configured with this origin as its version-controlled default and runs every 15 minutes. A `COLLECTOR_URL` repository variable can override it, but is not required: this GitHub integration cannot edit repository variables. GitHub cron is best effort; its check interval is distinct from the collector's one-minute capture schedule.

Verified GitHub monitoring runs:

- [External production health check: passed](https://github.com/andrewbaughman/citilink/actions/runs/41251200013).
- [Intentional notification test: failed as designed](https://github.com/andrewbaughman/citilink/actions/runs/41251470793). The failure log explicitly identifies it as a notification test; production collection stayed running.
- [Normal recovery check: passed](https://github.com/andrewbaughman/citilink/actions/runs/41251633303).

GitHub Actions email depends on the owner's notification preferences. Subscription/preferences could not be inspected through this connection, and inbox delivery has not been verified. The workflow records failures independently of Cloudflare's management API. No separate monitor subscription or email service was purchased.

## Private dashboard access

Username: `citilink`. The password is `STATUS_TOKEN`, generated during deployment and retained only in ignored owner-only `deployment.local.json`, not in source or logs. The account owner can choose a known password by editing `STATUS_TOKEN` under **Workers & Pages > citilink-history > Settings > Variables and Secrets**, then deploying that secret change. Use the same chosen value securely in future CLI/CI deployments to avoid an unintended password rotation. The minimal health endpoint needs no password. Raw archives can also be browsed through the authenticated Cloudflare R2 console.

See [RUNBOOK.md](RUNBOOK.md) for configuration, incident handling, and private downloads. No custom domain is required.

## Four-stop campaign deployment — 2026-11-01 UTC

Worker version `f149e81f-4345-4a0a-905f-d619ce1c36c3` enables one permanent reference plus three monthly study stops, polled every two minutes. The core five feeds retain their schedules. The configured baseline is 6,360 source requests/day, under unchanged 8,000 overall and 4,000 prediction budgets.

Current November campaign: permanent **Central Station – Bay N**, with **Calhoun near Hawthorne, Calhoun near Packard, and Calhoun near Creighton** as the nominal northbound study corridor. December rotates to Northcrest southbound; January to New Haven westbound; the three-panel cycle repeats at UTC month boundaries. [Full campaign plan](CAMPAIGNS.md).

`npm run verify:campaign` downloaded the private receipt, immutable manifest, and original JSON response for every stop through the account's R2 API. It verified four HTTP-200 successes, one permanent/three study roles, valid JSON, and matching original-byte SHA-256 hashes. Responses currently contain empty upcoming-arrival lists; future service-hours data is needed to validate actual forecast/vehicle matching. The production health endpoint returned HTTP 200 with `status: ok` after activation.

All 30 unit tests and the compiled-Worker integration test passed. Tests include actual scheduled odd/even minute behavior, monthly boundaries/wrapping, invariant reference selection, current-ID changes, missing/wrong-route codes, and raw campaign metadata/receipt fidelity.

The owner's existing dashboard password was preserved. The local password had become stale; deployment tooling now detects this and preserves the remote value rather than uploading it. Administrative verification uses the existing authorized R2 account API and never extracts the remote password.
