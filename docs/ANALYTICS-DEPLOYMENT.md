# Production analytics workspace

URL: https://citilink-analytics.empty-mouse-f437.workers.dev

The analytics Worker, dedicated D1 database, and both schema migrations are
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
