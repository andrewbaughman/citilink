# Stop-prediction campaigns

The deployed plan polls **four stops every two minutes**, all day: one permanent reference and three study stops. It adds 2,880 base API requests/day, for approximately **6,360/day overall**. Retries and event-triggered topology refreshes consume the existing 8,000/day overall and 4,000/day prediction limits. Neither limit was raised.

## Permanent reference

**Central Station – Bay N**, stop code `central-bay-N`. The current topology associates it with routes 2-Georgetown and 2-Time Corners. This is a continuing reference at a transfer hub, not a control that can eliminate route-specific or seasonal effects.

## Monthly study panels

Campaigns change automatically at **UTC calendar-month boundaries**. The sequence starts November 2026 and repeats every three months. The permanent stop never rotates.

| UTC campaign month | Route / nominal direction | Three study stops in intended travel order |
| --- | --- | --- |
| November, February, May, August | 8-Calhoun / Southtown (`8C`), northbound | Calhoun near Hawthorne (`1174`); Calhoun near Packard (`844`); Calhoun near Creighton (`1183`) |
| December, March, June, September | 1-Northcrest (`1N`), southbound | Parnell @ Ridgewood (`302`); Parnell @ Charlotte (`1055`); Parnell @ State (`419`) |
| January, April, July, October | 10-New Haven (`10NH`), westbound | Lincoln Hwy at Wayne Motel (WB) (`v6m8`); New Haven @ Meyer (`234`); New Haven @ Lumbard (`198`) |

The first Calhoun panel spans roughly 3.5 km from Hawthorne to Creighton, with an intermediate observation at Packard. Spacing provides more separation than immediately adjacent stops. No exact scheduled running time is assumed.

Panels were selected from live topology and route memberships, with nominal direction inferred from stop names and curbside coordinates. The API topology does not provide an authoritative ordered trip/stop sequence. The first service-week pilot should check forecast destinations, route variants, and vehicle progression before treating those labels as validated trip matching. All forecasts returned by each stop endpoint, including other served routes, are preserved without filtering.

## Configurable and reproducible

Edit `datasets.stop_predictions.selection` in `capture-plan.json`:

- `permanent_stop_code`: the reference held across campaigns.
- `starts_month`: the UTC starting month (`YYYY-MM`).
- `campaigns`: the ordered repeating sequence; each entry has an ID, label, route mnemonic, nominal direction, and exactly three distinct study stop codes.
- `max_stops_per_cycle`: four for this design.

The independent dataset schedule is two minutes, phase zero. Configuration validation rejects duplicate/reference collisions and over-budget schedules. Disabling the dataset still pauses all prediction requests.

Numeric `idPointArret` values are **resolved from topology**, not fixed in configuration. Stable stop codes keep the intended locations when numeric IDs change. Each study code must still belong to its configured route mnemonic; unavailable, ambiguous, or reassigned codes fail visibly rather than silently switching locations. The permanent reference remains tied to its code. Codes themselves can still change, so missing-code alerts require a deliberate plan update.

On upgrade, an already archived full topology builds the lookup without extra Citilink traffic. Subsequent full-topology captures refresh it. Each immutable run manifest records the campaign ID, UTC month, route/direction label, roles, stable codes, resolved numeric IDs, and topology reference. Monthly selection is based on the scheduled observation slot, so a delayed execution remains attributable to its original campaign.

A private convenience receipt at `indexes/v1/stop_predictions/latest.json` points to the latest prediction run and its responses. It is updated every prediction cycle; historical manifests and raw response files are never overwritten. This adds about 21,600 R2 metadata writes/month, still comfortably inside the included operation allowance at this workload.

## Verification and pilot limits

```sh
npm run verify:campaign
```

This uses the authorized Cloudflare account/R2 API, not the dashboard password. It checks receipt recency, one permanent/three study roles, manifest consistency, four successful JSON responses, and original-body/object SHA-256 checksums. It does not trigger Citilink requests and never reads or replaces the dashboard secret.

The first production batch successfully archived all four responses with HTTP 200 and matching checksums. At verification time they contained empty `listeHoraires` arrays. Those are valid observations, not evidence that actual forecasts or bus/departure matching have already been validated. Observe service hours during the first-week pilot; minute-level vehicle sampling still limits arrival-time precision. Collection continues through the month, and each corridor is revisited quarterly to help interpret seasonal differences.
