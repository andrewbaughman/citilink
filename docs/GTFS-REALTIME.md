# Citilink GTFS Realtime feeds

The collector now serves two public, unofficial GTFS Realtime 2.0 protobuf feeds:

| Path on the collector origin | Contents | Source cadence | Maximum retrieval age |
| --- | --- | --- | --- |
| `/gtfs-rt/vehicle-positions.pb` | Displayable vehicles with coordinates, bearing, stable vendor vehicle ID, fleet label, and mapped GTFS route | 30 seconds | 90 seconds |
| `/gtfs-rt/service-alerts.pb` | Nonempty rider messages scoped to mapped routes or the agency | 5 minutes | 10 minutes |
| `/gtfs-rt/status.json` | Reference version, source freshness, and limitations | On request | Not applicable |

These paths become available after deploying the updated collector. They are not a separate Worker and require no new resources, secrets, or upstream requests. Dashboard and archive paths retain their authentication. Only converted feed fields and limited diagnostic metadata are public.

## Semantics

Feeds use `FULL_DATASET`; a successful empty upstream list produces a valid empty feed. Removed vehicles and messages disappear from the next complete snapshot. Failures, missing observations, expired GTFS references, disabled source datasets, malformed archives, and stale source data return HTTP 503 JSON, never a successful empty protobuf feed. Fresh previously successful captures can still be served during a transient collection failure, within the age limits above.

The new collector metadata records the request start time alongside each successfully archived object. Feed headers use this retrieval time in Unix seconds; serving a feed again does not advance its timestamp. Old collector state without this metadata is unavailable until new successful captures arrive. The topology reference must have been successfully retrieved within two hours. Status `ready` reports metadata freshness and reference dates; the actual feed response additionally checks archive availability, payload structure, and route mappings.

Vehicles require `estAffichable: true`, a unique positive integer vendor ID, and finite valid coordinates. Conflicting duplicate IDs are excluded. Entity IDs are `vehicle-<vendor ID>`; the vehicle descriptor uses that vendor ID, with `numeroEquipement` as its display label. Heading is included only in [0, 360). Unknown routes leave the vehicle position available without a trip descriptor. No GTFS trip ID, direction, stop sequence, next-stop ID, GPS measurement timestamp, speed, occupancy, or numeric delay is guessed. In particular, `tauxRemplissage: 0` can mean missing load information, and the speed unit is unconfirmed.

Route matching joins live topology `idLigne -> mnemo` to static `routes.txt route_short_name -> route_id`, requiring an exact unambiguous short-code match. Vendor IDs are never emitted as GTFS route IDs. Route-only trip descriptors in VehiclePositions do not identify a scheduled trip; consumers that require `trip_id` may not display these vehicles.

Alerts preserve the upstream text in English header and description translations. Content and sorted selectors determine a stable SHA-256 entity ID. No dates, cancellations, affected stops, severity, detour effect, or cause are inferred from free text. Empty messages are excluded; duplicate text with identical scope is collapsed. Agency-wide alerts require an explicitly empty upstream route list. A message scoped only to unknown routes is excluded; partially mapped messages retain their known route selectors. Unknown cause/effect enums express the available evidence.

HTTP responses include `application/x-protobuf`, CORS, ETag/conditional GET, Last-Modified, and omitted/unmapped counts in `X-GTFS-RT-Omitted` and `X-GTFS-RT-Unmapped-Routes`. `Cache-Control: no-store` ensures an intermediary cannot serve a successful cached response after the freshness cutoff. GET and HEAD are supported; HEAD returns the same status and headers without a body. Feed errors expose no private archive paths.

Fresh retrieval does not prove the source has updated an individual bus's GPS position: the API has no measurement timestamp. These feeds therefore cannot guarantee the GTFS recommendation that all individual vehicle measurements are recent. A service-hours pilot and an external GTFS Realtime semantic validator remain appropriate before distribution to journey planners.

## Static GTFS reference and the website mismatch

`src/realtime/static.json` was generated from the ZIP linked at <https://fwcitilink.com/gtfs/#gtfs> on November 16, 2026:

- ZIP version: `Updated: Mar 3, 2026, 10:19 AM`.
- Feed dates: March 2 through December 31, 2026; agency `50044`.
- SHA-256: `39fc7130d1dbf26ac091cc5639711a60fb1faed4e357abef01a722311cb244de`.
- Route coverage against the repository's captured API topology: 18 of 20 API route codes match. `7ANT` and `21` do not occur in this ZIP; no aliases are invented.

The analytics timetable is a **different September revision**, already present in the repository. It has `7ANT` and `21` but different route IDs from the older public ZIP. It is intentionally preserved for historical analysis. Realtime consumers must use the static reference named by the realtime status endpoint. Do not combine these realtime feeds with an arbitrary GTFS revision.

To update the realtime reference, download the intended official ZIP, inspect its version and changes, and run:

```sh
python scripts/prepare-realtime-gtfs.py /path/to/citilink.zip 'https://source-of-this-zip'
npm run check
```

Review the generated route codes, IDs, feed dates and hash, then deploy. The generator rejects missing/duplicate short names and oversized files. It does not alter the analytics snapshot. The reference is checked against the current date in the agency timezone and stops serving feeds outside its date range. Schedule a reference update before expiry; no automatic static-feed download occurs in the Worker.

## Why there is no Trip Updates feed yet

The vehicle API has no trip or block assignment. Prediction records have vendor schedule IDs and seconds-of-day, but no explicit service date or verified GTFS trip identity. The collector's prediction panel covers eight selected stops, not the whole network. Matching only on route, destination text, proximity, or a rounded delay could put predictions on the wrong trip, especially across branches and service-day boundaries.

A production Trip Updates feed requires validated trip matching against `trips.txt`, `stop_times.txt`, active calendars/exceptions and the agency service day, with explicit handling of ambiguity, loop stops, midnight and DST. The existing analytics schedule comparison labels its matches provisional. It is not used as an authoritative realtime assignment. `/gtfs-rt/status.json` explicitly reports Trip Updates as unsupported; there is no placeholder feed implying arrivals are available.

## Validate and deploy

```sh
npm ci
npm run check
# When ready to publish through the existing deployment workflow:
npm run deploy
```

The check includes protobuf round trips using MobilityData's bindings; validation of exact/ambiguous route mappings; hidden, malformed and duplicate vehicle exclusion; stable alert identity and removal; empty versus unavailable data; expired/future/stale observations; CORS, ETags and HEAD; and a bundled Worker test using real local Durable Object/R2 bindings. The runtime test also confirms feed requests make no upstream API calls. It uses captured API fixtures, not live Citilink polling. This is not an external semantic validator or a live deployment test.

Once deployed, wait for successful vehicle/message/topology captures and check each feed, plus the existing collection health. The feeds' freshness checks operate independently of collector health grace periods. Deployment or publication to an app directory is not performed by adding these files.
