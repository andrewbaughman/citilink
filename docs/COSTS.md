# Monthly cost and ways to save

## Working budget

For the default 3,480 upstream requests/day and approximately 6 GB of new JSON/month:

| Component | Expected initial monthly charge | Assumption |
| --- | ---: | --- |
| Workers Paid | $5 | Account-level minimum; includes this small workload's expected Worker usage |
| Single SQLite-backed Durable Object | $0 extra | Fits the Paid plan's included requests, duration, and operational storage |
| R2 response/manifest writes and ordinary reads | $0 | Approximately 148,000 writes/month; low-volume health/status/download usage |
| R2 Standard storage | $0 initially | Starts empty; included 10 GB-month allowance is available |
| External email monitor | $0 if a suitable free plan is available; budget up to $10 if paid | Vendor and interval not selected; this is an allowance, not a verified quote |
| **Initial total** | **Approximately $5/month, or $5–$15 allowing for monitoring** | Excludes tax and any new domain registration |

This is an estimate, not a measured bill or spending cap. Existing account usage consumes the same included allowances. If Workers Paid is already enabled and has spare capacity, do not count a second $5 subscription for this service: incremental starting cost could be near $0. Conversely, unrelated workloads may leave fewer included resources available.

## Basis in published pricing

Checked Cloudflare's official documentation source on 2026-10-31:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Paid has a $5/account/month minimum, 10 million inbound requests and 30 million CPU milliseconds/month included. Upstream fetches are not separately billed as inbound Worker requests. Actual CPU/limits still need profiling.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): Paid includes one million requests, 400,000 GB-seconds/month, and substantial SQLite row allowances plus 5 GB-month of SQLite storage. There is no separate per-object subscription. A single 128 MB coordinator active for an entire 30-day month is approximately 332,000 GB-seconds, below the included duration allocation if not shared with other objects. Requests should be around 86,400/month for minute collection ticks and minute health checks, plus dashboard use; small bounded state is far below storage allowances. Use one SQLite-backed coordinator, not a legacy key-value namespace or separate object per stop.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard includes 10 GB-month storage, one million Class A operations/month, and ten million Class B operations/month. Additional storage is $0.015/GB-month, writes $4.50/million Class A operations, and reads $0.36/million Class B operations. Direct R2 egress is free. Operations/storage have billing-unit rounding, so do not extrapolate tiny overages as perfectly prorated charges.

Current documentation source was retrieved from Cloudflare's public `cloudflare/cloudflare-docs` repository, `production` branch. Rates, included usage, and runtime limits can change. No external-monitor vendor price has been verified or selected. Some free monitoring plans have slower intervals than one minute; verify check interval and email features before choosing.

## Traffic, storage, and retention

Default 30-day file counts, before retries or exceptional topology refreshes:

- 3,480 API responses/day × 30 = **104,400 response JSON files**.
- One manifest/minute × 43,200 minutes = **43,200 manifest JSON files**.
- Total approximately **147,600 R2 writes/month**, with very few configuration snapshots. A diagnostic JSON file replaces a normal response file for exceptional content; it does not also require a binary object.

Sample-based payload projection:

| Dataset | Uploaded response size | Files/month | New payload GB/month |
| --- | ---: | ---: | ---: |
| Vehicles | 7,335 bytes | 43,200 | 0.317 |
| Topology refresh | 87,745 bytes | 43,200 | 3.791 |
| Messages | 979 bytes | 8,640 | 0.008 |
| Version | 53 bytes | 8,640 | <0.001 |
| Full topology | 1,974,216 bytes | 720 | 1.421 |
| **Response total** | | **104,400** | **5.538** |

Allow approximately **6 GB/month** after manifests and a modest allowance for extra work. This is a sample-based planning value, not an upper bound: larger payloads, verbose metadata, diagnostics, and retries can increase it. Sizes above use decimal GB; actual billable measurements may differ slightly. One 24-hour pilot should replace these estimates with measured bytes and operations.

Storage is retained and accumulates. R2 charges for average daily peak stored volume across the month; the following table uses the end-of-period retained volume for a simple approximate monthly run rate:

| Retained history | Approximate retained volume | Storage charge at that volume | Cloudflare total including $5 Workers |
| --- | ---: | ---: | ---: |
| First month | 6 GB | $0 | About $5/month |
| One year | 72 GB | About $0.93/month | About $6/month |
| Five years | 360 GB | About $5.25/month | About $10/month |

Formula before billing rounding: `max(retained GB - 10, 0) × $0.015` per month. The actual month's average charge is slightly lower than the end-of-month run rate when data is being added throughout that month. At 6 GB/month from an empty bucket, storage should remain within the included allowance for the first two months on an average-volume basis, then start adding pennies. Optional ten-stop prediction sampling adds 86,400 JSON files/month; at the single uploaded 833-byte example it adds about 0.072 GB/month, but real stop responses vary.

## Best ways to reduce cost

1. **Use available allowances and a free email monitor.** An existing Workers Paid subscription is shared; a second subscription is unnecessary. Free external monitoring is the largest potential saving after the fixed Worker fee. Accept a slower monitor check interval only if the longer outage-notification delay is acceptable. Keep the collector's acquisition schedule independent of the monitor's check interval.
2. **Consider Workers Free after profiling.** SQLite-backed Durable Objects are available on Free. If all runtime/CPU/daily quotas pass realistic tests, and R2 remains within its allowances, the initial Cloudflare bill could be near $0. This is not yet verified. Free quota exhaustion rejects operations and can interrupt capture; Paid is a small fixed cost for more headroom. Do not remove pacing, health, or durable accounting just to save $5.
3. **Reduce static/context polling before vehicle sampling.** Changing topology refresh from every minute to every five minutes saves about 3.03 GB of new payload/month. Changing full topology from hourly to daily, while retaining coalesced version-triggered refreshes, saves about another 1.36 GB/month before extra triggers. Combined, these changes reduce the sample response projection from 5.54 GB to approximately 1.14 GB/month, plus manifests and triggers. They also reduce baseline API traffic from 3,480 to 2,305 requests/day. They sacrifice detail about short-lived topology changes, and require confirmation of the refresh/version endpoint semantics. Do not change the defaults automatically; these are configurable options. Vehicles can remain at one-minute cadence.
4. **Keep metadata/state/logs bounded.** Write one manifest per cycle, retain only current/recent coordinator state, avoid full-payload logging, and have health checks read compact coordinator state rather than listing the archive. Keep historical response JSON and manifests in R2. At this scale, more elaborate write batching would add maintenance without reducing an already included operation charge.
5. **Choose a retention limit only if history can be discarded.** R2 lifecycle deletion can cap storage, but conflicts with the goal of building a long-term historical record. Default remains indefinite retention; no deletion rule has been enabled. Likewise, deduplication is not part of this design because every retrieved observation should have its own response file.

Keep R2 Standard initially. Infrequent Access has no free allowance, higher operation charges, retrieval fees, and transition/minimum-duration costs; it is not an obvious saving for a small archive of tiny JSON files. Revisit only at a much larger measured retained volume.

No compression, packaged files, database, or new collector service is needed for any of the recommended options. Small storage reductions will not eliminate the $5 Paid minimum: at current volume, simplicity, reliable collection, and restrained upstream load matter more than saving pennies on storage. Start with the conservative schedule and free monitoring if suitable, then use measured bills to decide whether any tradeoff is worthwhile.

## Implemented monitoring fallback

The repository also includes an optional GitHub Actions monitor at a 15-minute cadence. It is disabled by an absent `COLLECTOR_URL` repository variable until deployment. GitHub-hosted cron is best effort, not a one-minute uptime service. Approximately 2,880 scheduled checks/month can consume runner minutes; private-repository Actions quotas/rates must be checked before enabling. Public-repository standard hosted runners may be free. GitHub email notification preferences and delivery must be tested. No external monitor subscription or billing plan has been purchased.
