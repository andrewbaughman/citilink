# Data workspace

The analytics Worker now serves the dashboard at `/`. It includes the importer
from step 2; all routine import operations are available in the interface.

## Interface

- **Overview:** observation counts, imported date range, last successful import,
  upcoming schedule, dataset totals, and import progress/errors.
- **Imports:** Import missing data, Stop/Resume, daily enable/disable, and a
  local-time daily schedule. Changes persist after Save schedule. Daily imports
  remain disabled by default. Importing continues after closing the page.
- **Explore data:** editable starters for vehicle history, reported delay,
  prediction revisions, collection coverage, and flagged readings. Date filters
  use Indianapolis days, including daylight-saving changes. Optional route,
  vehicle, and stop IDs narrow the applicable queries. Visible vehicles are the
  default, with a checkbox to include hidden vehicles.
- **SQL editor:** custom read-only queries with a schema browser and field
  descriptions that preserve the provisional French API interpretation. Results
  are scrollable tables; Ctrl/Command + Enter runs the query.
- **Stop visits:** investigate one local day, route and stop, with optional
  destination filtering. Replay observed vehicle positions, inspect prediction
  revisions and original French fields, and save association reviews. See
  [STOP-VISITS.md](STOP-VISITS.md) for methodology and limits.
- **CSV:** reruns the successful query with a larger limit than the preview.
  Editing the query disables export until it is run again. The interface reports
  export caps explicitly. Importing new data between preview and export can
  change the result; this is not a fixed database snapshot.

## Read-only query surface

The server parses one statement, validates its SELECT tree and CTE scopes,
checks table/function access, serializes the validated tree, and checks the
SQLite execution plan before running it. It does not execute the original
unvalidated SQL text. Writes, administrative statements, schema-qualified data
sources, multiple statements, recursive queries, and import bookkeeping are
rejected. The editor supports joins, aggregates, JSON/date functions, ordinary
CTEs, subqueries, and window functions within the supported SQLite parser syntax.
Unknown extension functions are not permitted. Parsing errors are shown in the
results area rather than treated as empty results.

The eight analysis views are:

| View | Contents |
| --- | --- |
| `analysis_vehicles` | Completed vehicle observations; default summaries use `is_visible=1` |
| `analysis_predictions` | Completed stop predictions, original clock values, and status codes |
| `analysis_routes` | Completed route reference versions |
| `analysis_stops` | Completed stop reference versions |
| `analysis_reference_captures` | Reference hashes and original capture times for historical joins |
| `analysis_collections` | Collection results, including successful empty responses and failures |
| `analysis_runs` | Expected/succeeded coverage, skipped reasons, and study selection context |
| `analysis_stop_visits` | Generated candidate visits, evidence, method version and owner reviews |

For historical reference joins, select the reference capture at or before the
observation time, then join its hash to the route or stop version. Do not choose
the most recently imported version solely because a backfill imported it last.
The schema browser describes field units and uncertainty. Full geometry and
original source responses remain in R2.

### Limits

- SQL input: 20 KB, one statement.
- Preview: 500 rows.
- CSV: 10,000 rows; separate 8 MiB output limit.
- At most 100 result columns and 8 MiB of result data.
- Queries remain subject to D1's 30-second execution limit and platform limits.
- Preview and CSV responses explicitly identify row truncation; oversized byte
  results fail with a message rather than silently truncating cells.

CSV quotes values, preserves Unicode, and escapes formula-like text for
spreadsheet applications. Numeric values remain numeric. Requests and responses
are not cached.

## Authentication

The existing `IMPORT_TOKEN` is also the administrator sign-in password. It is
never embedded in the browser bundle. Sign-in creates an eight-hour HMAC-signed,
HttpOnly, Secure, SameSite=Strict cookie. State-changing browser requests require
a matching Origin. Bearer-authenticated API clients remain supported.

For Cloudflare Access sign-in, configure the app's team hostname and audience
in the analytics Worker's tracked deployment configuration:

```json
"vars": {
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "your-access-application-audience"
}
```

The Worker verifies Access JWT signatures against the team's certificates and
checks issuer, audience, and expiry. A bare identity header does not grant
access. The Access application's allow policy should restrict visitors to the
owner or intended users. Provisioning that account policy is a deployment step;
this change does not create access grants. Access users sign out through the
Access logout endpoint. Password sessions are invalidated when IMPORT_TOKEN is
rotated. `IMPORT_TOKEN` remains required for the administrator/API fallback.

## Local development and release

Apply migrations to local storage, then run `npm run dev:analytics`. Local
bindings are separate from production; the UI starts with empty history unless
local archive data has been supplied. Set the local secret through an ignored
`.dev.vars` file or the project's supported secret mechanism.

For a new environment, production setup requires the dedicated D1 ID in
`wrangler.analytics.jsonc`, **all three** SQL migrations, and `IMPORT_TOKEN`. Configure
the intended Access policy before sharing the dashboard URL. The existing
collector's deployment script remains unchanged; deploy the analytics Worker
with its explicit config. No import starts merely from deploying it.

`npm run check` covers type checking, both Worker builds, existing collector
checks, SQL validation, CSV escaping, daylight-saving date filters, cookie
signing, authenticated HTTP routes, Access signature verification, result/export
caps, and dashboard DOM interactions against the local Worker. A visual browser
review was unavailable in the build session; DOM checks do not verify visual
layout or native browser download behavior.

The current live URL and completed setup are recorded in
[ANALYTICS-DEPLOYMENT.md](ANALYTICS-DEPLOYMENT.md).
