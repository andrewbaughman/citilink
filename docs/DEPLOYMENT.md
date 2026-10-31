# Deployment status

## Saved and deployed

The complete implementation is on [GitHub main](https://github.com/andrewbaughman/citilink/tree/main). All 25 automated tests passed, including a compiled-Worker integration test using actual local SQLite Durable Object/R2 bindings. GitHub CI also passed.

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

All five enabled datasets passed live freshness checks: vehicle positions, topology/detour updates, service messages, configuration version, and full topology. The health endpoint returned HTTP 200 with `status: ok`. The slower feeds completed their initial five-minute recovery windows rather than being marked healthy early.

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
