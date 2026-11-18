# Production analytics workspace

URL: https://citilink-analytics.empty-mouse-f437.workers.dev

The analytics Worker, dedicated D1 database, and all three schema migrations are
deployed. Cloudflare Access protects this dashboard hostname with an email-code
identity provider and an owner-only reusable allow policy. Other Workers and the
existing R2 collector have no new Access policies.

- D1 database: `citilink-analytics` (`de0aad33-fd19-49af-bf68-eabbf7029882`).
- Access application: `7562e79a-5028-4999-a9c0-f146283d699a`.
- Reusable owner policy: `7d3e72cf-6685-4143-8ff5-d8a344a13211`.
- Team hostname and application audience are tracked in `wrangler.analytics.jsonc`.
- The administrator/API secret is retained as a Cloudflare Worker secret and is
  not stored in source. Access protection also applies to API requests; a Worker
  bearer token alone does not bypass the Access gate.

Sign in with the approved Cloudflare account email and its emailed code. Then
click **Import missing data** to start the initial historical backfill. Daily
imports were left disabled and no backfill was started during deployment. You
can enable the daily schedule, set its local time, and stop/resume imports from
the dashboard.

Verification covered the deployed dashboard, password-session authentication,
schema, read-only SQL, write rejection, CSV, and import settings before the
Access gate was enabled. After enabling Access, the dashboard and analysis/import
API paths were verified to redirect unauthenticated visitors to the team's
sign-in page. The reusable policy was read back and confirmed to allow only the
approved owner email. The owner completes the actual email-code sign-in.

## Stop visits release — November 5, 2026

Merged [PR #2](https://github.com/andrewbaughman/citilink/pull/2), commit
`470bc3d5c8f92171be9ba5c530a44e45fbb76075`, is deployed to the same analytics
Worker. Migration `0003_stop_visits.sql` was applied successfully before the
Worker deployment. Production version is `b84e5475-ff15-4050-949c-5c362a7d101d`
(100% traffic), deployed at 6:11 p.m. Indianapolis time.

Open **Stop visits**, choose a local date, route and stop, and click
**Investigate**. Results are generated on demand from imported history. Reviews
and inferred visits are available through `analysis_stop_visits` in the SQL
editor and its CSV export. See [STOP-VISITS.md](STOP-VISITS.md) for methodology.

Release checks confirmed the merged source matches the tested PR, the analytics
dry-run build passes, all three migrations are recorded, and the two new tables
and joined analysis view exist. The active Worker version and expected bindings,
including the retained secret binding, were read back. The dashboard, new visits
API paths/assets and existing analysis/import paths redirect unauthenticated
requests to Cloudflare Access. The owner-only policy remains intact.

The collector and import settings were not changed, and no manual import or
investigation was started during release. Signed-in production interaction still
requires the owner's email-code login; no automated authenticated browser review
was performed. The PR's 55 tests and GitHub checks passed before release.

## GTFS comparison release — November 16, 2026

Merged PRs #3 and #4 (`8ab2cec192bafcec36fb49db7a1ee8f131ca3975`)
are deployed with the existing live GPS frequency feature preserved. The GPS
feature was present in production version `c16ead3f-5c26-4f2b-b851-1cc6e2506438`
but absent from main; its source was recovered from that version's source map
and text modules, then integrated without changing its calculation or controls.
Preservation source commit: `3d7a841`.

Production version `6e2ea09e-7adc-48ce-ba02-123f08f93081` serves 100% of traffic,
deployed at 11:46 a.m. Indianapolis time. Deployment ID:
`8b5d889e-af70-4f61-8de5-23eeb2968270`.

On Overview, click **Compare departure times** in **Schedule vs. predictions**,
or open https://citilink-analytics.empty-mouse-f437.workers.dev/#comparison .

Release checks passed all 47 unit and 12 integration tests, type checking,
capture-plan validation and both Worker builds. A subsequent focused runtime/DOM
check verified the comparison, overview entry, direct URL, and retained GPS
endpoint and UI. Cloudflare readback verified the active version at 100%, the
new comparison modules/endpoint and overview button, and the GPS feature. Existing
DB, R2, Durable Object, Access variables and secret bindings were retained.

External checks through the configured proxy verified that the dashboard,
comparison JavaScript/API and GPS endpoint return 302 to the existing Cloudflare
Access sign-in hostname. Signed-in production browser interaction was not
performed. No imports or investigations were initiated; collector configuration,
private history and import schedules were not changed. No schema migration was
needed.
