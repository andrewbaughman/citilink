# Deployment status

Implementation and local validation completed on 2026-10-31. This is not evidence of a live Cloudflare deployment.

Verified in the development environment:

- Git access to `andrewbaughman/citilink` through the existing HTTPS Git proxy.
- Plan validation: 3,480 base requests/day, stop predictions disabled, shared global traffic safeguards.
- TypeScript check and production Worker bundle.
- Deterministic unit tests of raw JSON fidelity, JSON diagnostics, request budgets/spacing, backoff, restarts, independent schedules, bounded stop panels, and archival failure recovery.
- Compiled Worker integration test using actual local workerd, SQLite Durable Objects, and R2 bindings; verifies uploaded JSON bytes, manifests, Basic/bearer authentication, downloads, and duplicate-tick prevention.

Cloudflare provisioning was attempted with `npm run provision` and stopped at credential preflight: neither `CLOUDFLARE_ACCOUNT_ID` nor `CLOUDFLARE_API_TOKEN` was available. `wrangler whoami` independently reported no authenticated login. No Cloudflare connector or local Wrangler credential configuration was available. No Cloudflare resources were created and no production API collection is running from this implementation.

The execution environment also restricts network access. A new environment draft records the Cloudflare credential/account requirements and custom hosts `api.cloudflare.com`, `api.github.com`, and `swiv.citilink.cadavl.com`. Draft persistence does not provide credential values, activate network changes, or deploy a service. It was saved but not published by the agent. The generated workers.dev hostname must be allowed for deployment verification once it is known.

Email monitoring is not active or delivery-tested. The dedicated monitor and GitHub fallback both need a deployed origin; GitHub email delivery additionally depends on notification preferences. The fallback remains dormant until repository variable `COLLECTOR_URL` is set.

A custom domain is not required for any of the implemented collection, dashboard, or health routes. Once authenticated Cloudflare access is supplied through secure settings and network changes are applied, `npm run deploy` is the entry point for provisioning, deployment, and endpoint verification. See [RUNBOOK.md](RUNBOOK.md).
