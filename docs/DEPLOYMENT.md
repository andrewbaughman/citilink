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

## Live validation in progress

Live scheduled runs have begun saving vehicle positions, topology updates, and a full topology snapshot. Downloaded JSON objects were parsed and verified against their recorded SHA-256 checksums. The live stop roster has 750 IDs; it is discovered rather than hard-coded from the uploaded sample's 751 stops.

The slower message/version datasets are still completing their initial scheduled/recovery cycles. Collection is not declared fully healthy until all required datasets pass `/healthz`. A 24-hour pilot and delivered email are not yet verified.

## Monitoring

The existing GitHub **Collector health** workflow is configured with this origin as its version-controlled default and runs every 15 minutes. A `COLLECTOR_URL` repository variable can override it, but is not required: this GitHub integration cannot edit repository variables. GitHub cron is best effort; its check interval is distinct from the collector's one-minute capture schedule.

GitHub Actions notification email depends on the owner's notification preferences. Subscription/preferences could not be inspected through this connection, and inbox delivery has not been verified. The workflow can still record and expose failed health checks independently of Cloudflare's management API. No separate monitor subscription or email service was purchased.

## Private dashboard access

Username: `citilink`. The password is `STATUS_TOKEN`, generated during deployment and retained only in ignored owner-only `deployment.local.json`, not in source or logs. The account owner can choose a known password by editing `STATUS_TOKEN` under **Workers & Pages > citilink-history > Settings > Variables and Secrets**, then deploying that secret change. Use the same chosen value securely in future CLI/CI deployments to avoid an unintended password rotation. The minimal health endpoint needs no password. Raw archives can also be browsed through the authenticated Cloudflare R2 console.

See [RUNBOOK.md](RUNBOOK.md) for configuration, incident handling, and private downloads. No custom domain is required.
