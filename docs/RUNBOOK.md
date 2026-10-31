# Operations runbook

## First deployment

1. Use Node 24+, `npm ci`, then `npm run check`.
2. Configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` securely. The token must be authorized for Workers scripts, R2 storage, and any first-time workers.dev subdomain setup in the chosen account. Use an existing paid/free Workers account; the scripts do not purchase a plan or create an account.
3. In a restricted cloud execution environment, allow `api.cloudflare.com` for deployment and `swiv.citilink.cadavl.com` for direct API diagnostics. GitHub management operations additionally need `api.github.com`; Git reads/writes use the platform's existing proxy. Allow the exact generated workers.dev hostname once known to verify the deployment from that environment. GitHub-hosted runners have their own network context.
4. Run `npm run deploy`. Alternatively set GitHub repository secrets `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `STATUS_TOKEN` and dispatch **Deploy collector**. Use a persistent random status secret of at least 24 characters. Optional `HEALTH_TOKEN` is separate from dashboard access.
5. The idempotent provisioner creates/reuses private R2 bucket `citilink-history` and ensures workers.dev is configured. Wrangler registers the SQLite Durable Object migration, Worker, and one-minute cron. Resources and stored data are not deleted during redeployment.
6. Open the printed workers.dev origin. Username is `citilink`; use the generated password from ignored `deployment.local.json` or the supplied `STATUS_TOKEN`. Password values are never printed by tooling. Keep the file private and out of Git.
7. Allow for cron propagation, then confirm last-tick, per-dataset archive timestamps, manifests, and response downloads. Initial warming up is not healthy. The dashboard is accessible once authenticated, even during an upstream incident.
8. Confirm the API still works without cookies and validate the independently polled topology-refresh behavior against current source behavior. The uploaded snapshots are fixtures, not current live observations.

## Monitoring without a custom domain

Use a dedicated independent monitor with email notifications for `/healthz`. One-minute polling is recommended; a free tier may be slower. If `HEALTH_TOKEN` is set, send it as `Authorization: Bearer <token>` in a header, never a URL query. The JSON status has no raw archive references. A 503 means stale, warming, or degraded collection; 200 means required datasets and heartbeat pass freshness checks.

A built-in GitHub fallback requires no new application code: set repository variable `COLLECTOR_URL` to the deployed HTTPS origin, and optional secret `HEALTH_TOKEN`. **Collector health** then runs every 15 minutes. Enable owner email notifications for Actions failures and recoveries using GitHub notification settings; verify both deliveries, since preferences may suppress them. Scheduling is best effort and can be delayed or disabled by GitHub repository inactivity policies. Private-repository runner minutes may incur charges; do not assume this is free. A missing URL leaves the fallback dormant, not active monitoring.

For an acceptance test, simulate an interruption in a staging/local deployment or intentionally pause the production cron briefly, then restore it. Never stress the upstream API to test alerts. Confirm a failure email and a later recovery email from the selected monitor. No delivered notification means alerts are not verified.

## Normal operation

The capture plan is deployed code configuration. Every response and run is immutable by unique ID; complete upstream JSON is saved byte-for-byte, with a separate manifest. Diagnostics are JSON containing lossless base64 of available bytes. The bucket stays private. There is no data-processing or compression job to maintain.

The coordinator keeps one current state record and only twenty recent run references. Archive history remains in R2, not in operational state. Pacing and budgets persist before requests are sent. One in-flight request is enforced inside the single coordinator.

Monitor both recent archives and remaining budget, not just the last process invocation. A 429 cooldown or exhausted budget deliberately prevents more requests and can degrade health; this protects the source without hiding missing observations.

## Change a retrieval plan

1. Edit `capture-plan.json`: enable/cadence/phase, priority, selection, optional dataset cap, timeout/retry override, and health thresholds are independent per dataset.
2. Run `npm run plan`; compare with a previous plan if useful. Review the changed daily volume and headroom. Defaults remain one request in flight, at least one-second spacing, and an 8,000/day cap including retries. A dataset cannot bypass global safety controls.
3. For stop predictions, use an explicit fixed panel or a capped rotating roster. Obtain stop IDs from authenticated status or an archived topology. Unknown IDs are rejected at collection time; an empty list is not all stops. Stop polling remains off until explicitly enabled.
4. Run `npm run check`, commit, push, and deploy. There is no automatic production deployment on push. Each new configuration is archived once with its SHA-256.
5. Confirm the active plan hash and new next-due times. Old missed slots are not replayed. Runtime config is not editable through the public site.

Some intervals are upper-bound estimates per UTC day because they do not divide 24 hours. Event-triggered full topology and retries consume the same daily headroom. A pending topology refresh is coalesced and waits out minimum spacing.

## Download and verify a response

Use the dashboard's recent-manifest links, then download its referenced object using the object-key form. All downloads require dashboard authentication. An authenticated script can use the same bearer status token in a header, never the query string. Compare SHA-256 to `body_sha256`/`object_sha256` in the attempt manifest. For normal responses these hashes are identical.

A diagnostic's `body_base64` decodes to original available response bytes. Its object hash covers the JSON diagnostic, whereas its body hash covers those decoded bytes. A partial/oversize body is marked incomplete and is never counted as a good observation. No parser can reconstruct uncaptured bytes.

## Troubleshooting

- **Cloudflare authentication unavailable:** provisioning exits before creating resources; it does not open login or use temporary accounts. A GitHub token does not establish Cloudflare access. Configure credentials securely, not in source or chat.
- **Network policy denial:** add the exact required hostname through environment settings and apply the configuration. Saving a draft does not apply it. Do not bypass the proxy, unset it, or disable TLS checks. Account and runtime credentials are separate from domain allowlists.
- **Upstream 429 / repeated failures:** inspect cooldown and errors. Leave backoff in place; do not catch up. Contact the feed operator before raising traffic.
- **Budget exhausted:** skip optional work first. Inspect retries/plan volume, not just successful observations. Request reservations after an interrupted call remain charged conservatively. Counters reset by actual UTC day, not scheduled slot.
- **R2 failure:** health fails; collection stops after the first failed raw write. A failed manifest remains in durable state for recovery. Next ticks retry storage before retrieving more data. Already uploaded but unregistered response objects may be orphaned under the run prefix; retain them. An unsaved response is lost, and a refetch cannot recover its original point in time.
- **Restart mid-run:** durable ownership keeps a three-minute recovery lease so an older request cannot be duplicated immediately. Interrupted slots are recorded instead of replayed. There is no queue backlog.
- **No cron / stale heartbeat:** inspect Worker trigger configuration and deployment logs. Initial cron propagation can take up to 15 minutes. Monitor checks do not trigger upstream collection.
- **Unexpected JSON structure:** the original JSON is still archived. Health marks the dataset degraded; investigate current API behavior before changing narrow structural validators. Do not replace errors with empty successful data.
- **Bad configuration / temporary config-upload failure:** no requests are sent under an unarchived plan. Fix/redeploy malformed settings; transient configuration archive failures retry on later ticks.
- **Status authentication missing:** dashboard returns 503 instead of exposing private archive data. Health and collection remain separate. Reapply a strong `STATUS_TOKEN` securely.

## Rollback and retention

Revert the source/config commit and run the checked deployment flow again, or use an appropriate previous Wrangler version deployment after verifying bindings/migrations. Preserve the SQLite class and migration history. Do not delete/recreate the coordinator to clear rate limits. Do not delete the bucket as a rollback technique.

Retention is indefinite. No lifecycle deletion is configured. Any future retention reduction sacrifices the historical record and should be a deliberate policy change. Keep logs small and avoid full payload logging. Check spend periodically and update pinned dependencies with tests.

## Custom domain later

Add a Cloudflare Worker custom-domain route once the domain exists. The workers.dev origin and Basic authentication already work without it. Cloudflare Access can later replace/supplement dashboard authentication; keep the minimal monitor endpoint independently reachable and keep raw R2 access private.
