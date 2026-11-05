# One-day analysis validation: November 3, 2026

Status: findings ready for owner review. No importer or dashboard has been implemented, no production database has been created, and no daily imports have been enabled.

## Scope and owner decisions

The owner selected November 3 and a focus on data quality and coverage. The window is midnight-to-midnight in America/Indiana/Indianapolis: 2026-11-03 05:00 UTC through, but excluding, 2026-11-04 05:00 UTC. R2 folder dates are UTC, so this local day spans two UTC dates.

The owner agreed to retain every vehicle observation and default performance summaries to visible vehicles, with a control to include hidden vehicles.

Read-only validation inventoried the entire window, checked all 1,440 collection manifests, and examined the vehicle and stop-prediction bodies. Identical bodies were reused by ETag while retaining every source capture separately. All three distinct full-topology bodies were inspected. Service-message and topology-update coverage was checked through metadata and manifests; their individual contents were not analyzed in depth. Original R2 objects and collection were unchanged.

## Collection coverage

| Dataset | Expected | Successful |
| --- | ---: | ---: |
| vehicles | 1,440 | 1,440 |
| topology_updates | 1,440 | 1,440 |
| stop_predictions | 2,880 | 2,880 |
| service_messages | 288 | 288 |
| config_version | 288 | 288 |
| full_topology | 24 | 24 |

All 6,360 expected collections succeeded. There were no failed attempts, retries, skips, duplicate scheduled capture slots, or missing referenced raw objects. Every run completed with the same capture-plan hash. All successful attempts were marked complete, valid JSON, and structurally valid by the collector. Recorded captured-byte counts matched R2 object sizes. This is a metadata consistency check, not an independent revalidation of every original byte against its SHA-256.

Vehicles have exactly one file per minute. Stop predictions have exactly one file per selected stop every two minutes: 720 captures each for stops 277210, 277252, 277525, and 277719. These counts measure collection coverage, not whether the upstream system reported every bus or every departure.

Requests began 34.478–43.198 seconds after their scheduled minute, with a median of 36.944 seconds. Keep scheduled, requested, and completed timestamps separately. No checked request fell outside the selected local day.

## Vehicle observations

- 16,644 observations across 22 distinct observed vehicle IDs.
- 5,775 observations marked hidden; 10,869 marked visible.
- 5,775 observations lacked displayed occupancy. These were exactly the hidden observations; a raw occupancy zero on these records must not become a measured 0% in normalized analysis.
- No repeated vehicle ID within a capture, unmatched route ID, missing coordinate, or invalid coordinate range was found. Coordinates also fell within a broad Fort Wayne bounding box.
- 502 successful snapshots contained an empty fleet list.

Empty fleet lists occurred from 00:00 through 05:25 and from 21:04 through 23:59 local time. Every minute from 05:26 through 21:03 had a nonempty fleet list. This pattern is consistent with overnight inactivity; it does not independently establish the published service hours. Empty successful captures belong in coverage records.

The payload has no separate GPS measurement timestamp. Collection timestamps establish when a response was obtained, not the precise age of each position.

### Values requiring care

The raw speed range was 0–816. Five observations exceeded 100 in the raw unit; one visible vehicle observation at the 17:14 scheduled capture had raw speed 816 (vehicle ID 2003, fleet number 2664). The unit remains unconfirmed. Preserve raw speed and flag outliers; do not label it mph or km/h or use it as a trusted speed metric yet.

Reported delay is text, including ordinary values such as "8 min late", "on time", and a censored value "1h+ late". Preserve the text. Ordinary numeric values can be parsed with provenance; "1h+ late" is a lower bound, not an exact 60 minutes. "On time" is an upstream category, not proof of exact zero delay. These are reported vehicle states, not independently measured stop-arrival punctuality.

## Stop predictions

- 9,079 prediction observations from 2,880 captures; 0 empty responses.
- 0 duplicate keys using capture time, stop, route, raw destination, and prediction ID.
- 0 unmatched route IDs and 0 observations at unknown stops.
- 0 observations with horaireApplicable = 0.

The four stops are Calhoun near Hawthorne (277210), Calhoun near Packard (277252), Calhoun near Creighton (277525), and Central Station–Bay N (277719). This prediction sample covers those selected stops, not the whole network.

### Field interpretation

The vendor JavaScript archived in api-discovery/raw/scripts_topologie.min.js converts horaire and horaireApplicable from seconds into a clock display. It labels them predicted and scheduled respectively; horaireApplicable = 0 displays as unavailable. Store original seconds and derive a nullable scheduled value rather than treating zero as midnight.

Status combinations observed in this day (etatHoraire, etatPassage):

- (1, 0): 8,986 observations.
- (1, 1): 3 observations.
- (0, 0): 90 observations.

The archived vendor code strikes through etatPassage = 1 and suppresses the predicted display for etatPassage = 2. The existing OpenAPI note attributing strike-through to 2 is inconsistent with that code. Preserve both status fields and expose their observed UI meanings; the full upstream enum and operational meaning are not independently confirmed. Flagged entries should remain queryable and distinguishable from normal displayed predictions.

There were also 90 observations with etatHoraire = 0. The archived vendor code gives these clock values a special rectangular display; its exact upstream operational meaning remains unconfirmed. Preserve this distinction rather than treating every row as the same kind of real-time prediction.

Repeated unchanged schedules overnight are valid captures, not duplicate imports. Predictions can stay at their scheduled value for many captures before being revised. A repeated prediction ID is useful for following revisions within stop/route/destination context; it is not a vehicle or trip identifier and must not be a globally unique row key.

Destination labels differ in whitespace, for example "Central Station  - Bay A" and "Central Station - Bay A". A cleaned display label is useful, but preserve the original label and libelleHexa; do not merge prediction records simply because their cleaned labels match.

### Midnight and service-date handling

At the 23:58 local capture, stop 277210 returned horaire = horaireApplicable = 20948 (05:49:08), with a different prediction ID from the morning captured at the start of the day. This strongly indicates the next morning's upcoming departure. Assigning every clock time to the capture's calendar date would put that departure on the wrong day.

Keep capture date/time separate from time-of-day fields. Any inferred service date needs an explicit rule and provenance; leave it unresolved where ambiguous. The payload does not provide an explicit departure date. Prediction disappearance alone does not prove an actual arrival.

## Reference data and storage

All three distinct full-topology snapshots contained 20 routes and 750 stops. Route ID/name mappings and stop records were unchanged between those three snapshots. All checked observation IDs join to this reference data. The 24 hourly topology files contained only three distinct bodies; keep versioned references rather than reimporting repeated geometry.

The whole window contains 7,800 objects totaling 209.06 MiB, including manifests. Topology snapshots and updates dominate the raw size; retain their full JSON in R2.

A temporary local SQLite experiment storing both observation tables, collection results, repeated source-key strings, and basic indexes occupied 6.33 MiB. That is roughly 190 MiB per 30 equivalent days or 2.26 GiB per 365 equivalent days, before reference tables, full run metadata, importer bookkeeping, and future schema changes. These are extrapolations from one weekday, not measured long-term growth.

Representative coverage, visibility, route, trajectory, and prediction-revision SQL queries executed successfully in local SQLite. These checks validate the table shape and SQL approach; they are not hosted D1 performance benchmarks. Hosted D1 import/query performance remains to be checked during implementation. D1 remains a reasonable starting choice based on the observed scale; Cloudflare currently documents a 10 GB database maximum on Workers Paid and 500 MB on Free (https://developers.cloudflare.com/d1/platform/limits/).

Two examples executed against the temporary validation schema (final column names remain subject to review):

```sql
-- Coverage from collection attempts, including empty successful captures.
SELECT dataset, COUNT(*) AS attempts, SUM(ok) AS successes
FROM collection_results
GROUP BY dataset;

-- Observation counts using the agreed default visibility filter.
SELECT route_id, COUNT(*) AS observation_count
FROM vehicle_observations
WHERE visible = 1
GROUP BY route_id;
```

## Proposed table interpretation for review

| Table | Grain and important fields |
| --- | --- |
| collection_results | One collection attempt/outcome: dataset, optional stop, scheduled/requested/completed UTC timestamps, success, source object, row count, quality flags. Include successful empty captures. |
| vehicle_observations | One vehicle in one source capture: vehicle/fleet IDs, route, position, heading, raw speed, reported delay text and qualified derived values, visibility, raw and nullable normalized occupancy. |
| stop_predictions | One nested prediction in one source capture: stop/route, original destination/key, prediction ID, raw clock seconds and statuses, optional inferred service date with provenance. |
| routes / stops | Versioned reference IDs, names, and needed scalar metadata; full geometry stays in R2. |
| imported_objects | Phase 2 bookkeeping for source-key completion and resumable imports. |

Use a source object identity plus a deterministic nested row path for repeatable observation keys. Natural IDs can be checked for unexpected duplicates, but do not deduplicate separate capture times or use content hash to collapse repeated observations. Reference versions can be deduplicated separately.

## Review before step 2

Confirmed with the owner: retain all vehicle observations and default summaries to visible vehicles.

Proposed remaining rules: preserve and flag questionable measurements, keep empty captures as successful collections, preserve raw prediction statuses/clock fields, distinguish reported delay from actual arrival punctuality, and avoid silently assigning ambiguous departure dates. Raw fields remain available to the SQL editor and CSV exports.

The next step is to review these interpretations with the owner and agree on the schema. Only then build the importer, followed by the dashboard. Daily imports remain disabled until enabled from the dashboard.


## Priority review: French API field translations

The owner's main remaining validation interest is translating the French API fields accurately. Complete this review together before importer implementation. Distinguish the literal French meaning from the provider's operational semantics; numeric enum meanings and units cannot be established by translation alone.

| API field | English interpretation | Evidence and remaining uncertainty |
| --- | --- | --- |
| vehicule | Vehicle | Array of vehicle observations. |
| localisation.lat / lng | Latitude / longitude | Coordinate values and use in map rendering support this interpretation. |
| localisation.cap | Heading / bearing | French navigation term; observed values 0–359 support degrees. |
| conduite | Driving/operating state | Contains route assignment, destination, speed, reported delay, and next-stop information; not a driver identity. |
| idLigne | Route/line ID | Joins to the topology's route records. |
| vitesse | Speed | Translation is clear; the measurement unit is not confirmed. |
| avanceRetard | Ahead/behind schedule; reported schedule adherence | Values are already English strings such as "on time" and "8 min late"; not a separately measured arrival event. |
| arretSuiv | Next stop | Abbreviation of arrêt suivant. Contains a stop name and estimated-time field. |
| estimationTemps | Estimated time | The quantity's unit and exact reference point still need verification. |
| tauxRemplissage | Occupancy/fill percentage | Values were 0–100 and matched available percentage display strings. This is reported occupancy, not a passenger count. |
| estAffichable | Is displayable / should be displayed | A presentation flag. It must not be renamed "in service" without further evidence. |
| numeroEquipement | Equipment/fleet number | Preserve separately from the internal vehicle ID. |
| listeHoraires | List of times/schedule entries | Contains route/destination groups and upcoming displayed times. |
| idHoraire | Time/schedule-entry ID | Identifies an entry for navigation and revision tracking; not established as a trip or vehicle ID. |
| horaire | Time; vendor's predicted/displayed time | Archived vendor code labels its display as predicted and interprets the value as clock seconds. Not necessarily a newly calculated live prediction in every observation. |
| horaireApplicable | Applicable time; vendor's scheduled time | Literal translation alone is ambiguous. The archived vendor code labels it scheduled and renders zero as unavailable. |
| etatHoraire | Time/schedule status | Exact numeric enum remains unconfirmed. The archived UI decorates status 0 differently; do not rename this a real-time flag yet. |
| etatPassage | Passage/stop-call status | Exact numeric enum remains unconfirmed. Archived UI strikes through 1 and hides predicted time for 2. Do not infer actual arrival, departure, or cancellation solely from the English name. |
| libelle | Label / description | In destination objects, the displayed destination label. Preserve original whitespace alongside any cleaned display label. |
| libelleHexa | Hexadecimal label/key | Samples encode a route prefix as well as destination text; do not assume this is simply libelle encoded in hexadecimal. |
| existeSuivant / existePrecedent | A following / preceding entry exists | Pagination/navigation availability, not evidence of another vehicle. |
| modeManu | Manual mode | Likely manual schedule navigation in this UI context; exact provider semantics remain to be checked. |

### How to validate the remaining translations

1. Trace each field through the archived vendor JavaScript and compare its rendering with the archived JSON and topology joins.
2. Review concrete examples together, including status 0/1/2 handling, missing scheduled times, midnight rollover, and the difference between internal vehicle IDs and fleet numbers.
3. Keep original French field names in the data dictionary and raw source archive. Add English aliases only where their meanings are supported; record unresolved units and codes explicitly.
4. Treat the repository's reverse-engineered OpenAPI descriptions as working notes, not independent provider documentation. Correct the status-code note after the interpretation is agreed.

This prioritization does not authorize starting the importer before the owner has reviewed the field interpretation.
