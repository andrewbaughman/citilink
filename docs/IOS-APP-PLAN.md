# Citilink iOS app implementation plan

Status: ready for implementation; documentation only.
Date: November 12, 2026.
Repository baseline reviewed: `8e8e6ce616ba05cb14657d3aa52524be3d9688f7`.

## 1. Product direction

Build a small native iPhone app answering “Where are the buses, relative to me?”

The approved direction is a single map with a compact selection card. The four-screen concept added too much navigation. Keep bus, route, and stop interactions on the map.

Required in v1:

- A map with pan and zoom.
- Every returned bus with a valid latest coordinate, subject only to an explicit user route filter.
- A continuously aging “time since acquired” label.
- The rider’s location.
- Bus stops.
- Bus route geometry and a simple route filter.

Defer saved items, alerts screens, journey planning, fares, walking directions, arrival predictions, headway calculations, accounts, push notifications, and background tracking. These are not prerequisites for the requested tracker.

## 2. Use the public API already documented here

Use [api-discovery/openapi.json](../api-discovery/openapi.json) as the integration contract, checked against the captured responses. The specification is reverse engineered, so tolerate optional fields and verify behavior before shipping. This plan does not claim that a new live API test has been performed.

Base URL:

```text
https://swiv.citilink.cadavl.com/SWIV/CITILINK/proxy/restWS
```

The documentation reports anonymous, read-only access without cookies, API keys, or a referer. Use native `URLSession` HTTPS requests directly. The browser prototype’s local CORS proxy is unnecessary for a native iOS client. No new server, GTFS ingestion, database, or Cloudflare deployment is required for v1.

| Endpoint | Purpose | Proposed foreground cadence |
| --- | --- | --- |
| `GET /topo` | Complete routes, geometry, stops, and deviation geometry | Startup when cache is absent or invalid; reload on version change or recovery |
| `GET /topo/vehicules` | Complete latest fleet snapshot | Immediately on activation, then approximately every 10 seconds |
| `GET /topo/refresh` | Detour references, supplemental geometry/stops, changed stop associations | After initial topology, then approximately every 15 seconds |
| `GET /config/version` | Per-center topology version marker | At startup and approximately every 60 seconds |

Those polling intervals follow the observed web-client defaults in the repository, not a guaranteed upstream service level. Make them configuration constants and revise if live verification or upstream guidance requires it.

Do not call `/horaires/pta/...`, `/horaires/horaire/...`, or `/iv/message` in v1. The requested experience does not need them.

Integration details:

- JSON bodies are documented as `application/octet-stream`. Check HTTP status, then decode the body with `JSONDecoder`; do not reject valid JSON because of the MIME type.
- Use unfiltered requests and filter locally. The optional `lignes` parameter has fragile base64 encoding and documented malformed-input failures; it is unnecessary for this fleet size.
- `_tmp` is an optional cache buster, not an acquisition timestamp. For fleet requests, bypass local response caching; use the documented cache buster if live checks show an intervening stale cache.
- Unknown JSON fields should not break decoding. Distinguish a valid empty array from a missing or malformed response envelope.
- The existing history collector and analytics deployment are separate tools. Do not use their private archives, authenticated dashboards, or `STATUS_TOKEN` as the app’s live data source.

## 3. Single-screen interface

Use the system map style, SF Symbols, system text sizes, and route colors from the API. Start centered on the Fort Wayne network, using cached topology bounds when available.

```text
┌───────────────────────────────────┐
│ [ All routes ▾ ]      [ Recenter ] │
│                                   │
│            MAP                    │
│   route lines · stops · buses      │
│           my location             │
│                                   │
│                      [ Fit buses ]│
├───────────────────────────────────┤
│ Bus data acquired 12s ago          │
│ 20 buses · All routes              │
└───────────────────────────────────┘
```

The lower panel expands only enough to show the current selection. Allow it to grow or scroll for larger accessibility text.

### Default map

- Show all valid fleet positions as bus-shaped markers, with a short route label where readable.
- Color markers to match their route; use a neutral fallback for unknown route assignments.
- Show route lines at restrained opacity. Show stop circles when zoomed in; all stops remain available through route/stop search in the route picker’s search field.
- Show the rider as the standard blue location dot with accuracy indication.
- Keep the fleet acquisition age visible even when nothing is selected.
- “Fit buses” fits the currently filtered fleet. Disable it when there are no positions.
- Panning and zooming remain under the rider’s control. Polling must never reset the camera.

### Tap a bus

The compact card shows route name, destination, fleet number when available, and “Data acquired 12s ago.” Highlight its route without hiding the other buses. A close action clears selection.

No route-detail navigation is required. A heading indicator may use `localisation.cap`; omit it when invalid. Do not animate projected movement between polls or imply that a stopped marker is a verified current GPS fix.

### Tap a stop

Show the stop name, public stop code when available, and serving route labels. Selecting a route chip applies the same map filter as the route picker.

No stop-detail screen, arrival countdown, or guessed stop order is required.

### Select a route

Open a lightweight searchable sheet from “All routes.” Search route names and stop names/codes using the loaded topology. A stop search result selects and centers that stop on the map.

- Route selection filters buses, stops, and route lines to the selected API line.
- “All routes” restores the full network.
- Preserve distinct `idLigne` variants even when their public route numbers match; show their full public names.
- Selecting a filter may explicitly fit its geometry once. Subsequent updates preserve the camera.

## 4. Acquisition time: precise and honest

**The documented vehicle payload has no GPS capture timestamp.** The raw and readable fleet captures contain coordinates and trip information, but no per-vehicle or fleet acquisition time from the source.

For v1, “acquired” means **the instant the app finishes receiving a successful, decodable fleet response**.

- Store a local `receivedAt` with the accepted fleet snapshot.
- Always show “Bus data acquired 12s ago” in the compact status area.
- Selected buses inherit the receipt time of the snapshot containing them.
- Provide a small information affordance with: “Acquired means received by this app. Citilink does not provide the age of the underlying GPS position in this feed.”
- A new successful response resets receipt age even if coordinates are identical. This means fresh retrieval, not verified fresh GPS.
- Timeouts, decode errors, and failed HTTP responses never reset receipt age.
- Update the age label locally every second while foregrounded, without extra API calls.
- Measure elapsed time with a monotonic clock during a session; preserve wall-clock receipt time for cache restoration. If the device clock makes a restored age unreliable, show “Acquisition time unavailable.”
- If the API later supplies a confirmed source timestamp, add a distinct “Position reported … ago” label; do not silently change the meaning of receipt age.

Proposed receipt-age states, configurable after live testing:

| Receipt age | Presentation |
| --- | --- |
| Under 30 seconds | Ordinary “Acquired … ago” text; no assertion of GPS freshness |
| 30–120 seconds | Amber indicator and “Updates delayed” |
| Over 120 seconds, or offline | Muted markers and “Showing last received positions,” retaining the age |

A successful response containing an old GPS fix cannot be detected from this contract. Record that limitation in app help and release verification.

## 5. Data mapping and correctness rules

| App model | API source | Identity and use |
| --- | --- | --- |
| Route | `topo[].ligne[]` | Center plus `idLigne`; public names, `mnemo`, `couleur`, itineraries |
| Stop | `topo[].pointArret[]` | Center plus `idPointArret`; name, coordinates, stop code, serving lines |
| Segment | Itinerary/deviation `troncons[]` | Center plus `idTroncon`; start/end coordinates |
| Vehicle | `vehicule[]` | `id`; coordinates, heading, fleet number, trip assignment |
| Fleet snapshot | Entire accepted vehicle response | Vehicles plus local receipt metadata |
| Topology version | `version[]` | `libelleCE` and opaque `valeur` |

### Vehicles and “all buses”

The captures include vehicles with `estAffichable: false`. The specification describes this as a map visibility flag; it does not establish a reliable service-status meaning for every false value.

For this app, honor the requested “all buses” behavior: include every returned vehicle with valid coordinates, including false values. Preserve the flag in the model. Render those vehicles with a muted/outlined marker and show “Service status unknown” in their card; do not describe them as confirmed passenger service, deadheading, or out of service. Missing flags receive the same unknown treatment. This policy can be revised explicitly later.

- Use `id` for stable marker identity; `numeroEquipement` is a display label.
- Join `conduite.idLigne` to the current route catalog.
- Retain buses with missing/unknown route assignments using neutral markers.
- Validate finite latitude/longitude and geographic ranges. Never replace invalid positions with zero coordinates.
- Count invalid/unavailable positions separately; do not invent map locations.
- Treat an accepted response as a complete snapshot: replace/update current vehicles by ID and remove IDs absent from that response.
- On request failure, preserve the previous snapshot with its aging labels.
- If a selected vehicle disappears from a successful snapshot, say “Bus no longer reported” and clear its highlight. An empty successful fleet is “No buses reported,” not proof that service has ended.
- Preserve destination text as supplied, trimming whitespace. Do not infer inbound/outbound solely from route number.
- Omit speed and time-to-next-stop calculations: the documented units of `vitesse` and `estimationTemps` are not confirmed.

### Routes, stops, and detours

- Build a segment index from all base route itineraries and deviation geometry.
- Render each segment or contiguous chain separately. Never connect unrelated itinerary variants or disconnected segments with a straight line.
- Resolve stop-to-route membership from `infoLigneSwiv[].idLigne`.
- The topology does not establish a complete ordered stop sequence for each direction. Do not sort by distance and present that as travel order.
- Apply `objetsSuppl` geometry/stops before resolving refresh references.
- Merge partial stop updates by ID, preserving coordinates and names when absent.
- Use `tronconsDevies` for bypassed segments and `tronconsDeviation` for replacement geometry. Show bypassed sections dashed and replacement sections prominently.
- Verify refresh clearing/replacement semantics against the captured frontend before implementing the reducer. Replaying the same refresh must not duplicate stops or detour lines; a cleared detour must disappear.
- For unresolved segment IDs, retain the last coherent route rendering, indicate route updates are unavailable, and schedule one coalesced full reload. Never fabricate geometry or loop on reload.
- Treat a version value as opaque: compare equality, not assumed numeric ordering.
- Commit a new topology and its version together only after successful decoding and index building. If a version changes during loading, coalesce a follow-up reload.

## 6. Native implementation structure

Target iOS 17+ initially, using SwiftUI, MapKit, Core Location, and Foundation. This is a planning default that can be lowered if device requirements warrant it.

Place future app code under `ios/Citilink/`, keeping the existing collector and web examples intact.

```text
ios/
  Citilink.xcodeproj
  Citilink/
    App/                 app entry, environment, configuration
    Models/              SWIV DTOs and normalized map models
    Networking/          SWIVClient, request scheduler, errors
    Data/                TransitRepository, topology reducer, JSON cache
    Location/            LocationService
    Map/                 map view, annotations, route overlays
    Components/          selection card, route picker, freshness label
  CitilinkTests/
  CitilinkUITests/
```

Keep the architecture small:

- `SWIVClient`: typed endpoint functions using async/await and an injectable `URLSession`.
- `TransitRepository`: actor owning snapshots, route/stop indexes, cache, and refresh coordination.
- `MapViewModel`: main-actor observable state for selection, filter, camera intent, receipt age, and errors.
- `LocationService`: main-actor Core Location wrapper.
- SwiftUI views render state and send explicit user actions.

Use SwiftUI’s iOS 17 map APIs first. If dense annotations or overlay rendering fail the full-capture performance check, use an `MKMapView` wrapper with annotation reuse/clustering behind the same model. Choose based on a measured prototype.

Persist topology, version, and cache schema version atomically as JSON in Application Support. Retain the last fleet snapshot in memory for foreground/network interruptions; do not persist bus positions in v1. Show cached routes/stops immediately on later launches while loading the live fleet. No SQLite, SwiftData, or external dependency is necessary.

## 7. Lifecycle, networking, and location

- Create one polling coordinator for the app. Foreground activation performs a coalesced immediate fleet refresh and checks topology/version as needed.
- Cancel polling when the app becomes inactive/backgrounded. Do not request background execution or background location.
- Serialize upstream requests with at least one second between starts, coalesce duplicates, and never overlap cycles to catch up missed timer ticks. Due times are approximate; prioritize fleet requests.
- Use a finite timeout (initially 15 seconds). Bound retries through the same scheduler.
- On 429, honor `Retry-After` and pause all endpoint requests. On transient failures, use exponential backoff with jitter, initially 15 seconds up to five minutes; manual refresh cannot bypass it.
- Treat permanent client errors as endpoint/configuration failures rather than an aggressive retry loop.
- Keep topology and fleet errors independent: fleet markers can appear with fallback route labels if topology fails, and cached topology remains useful if fleet loading fails.
- Never apply an older canceled response over a newer generation of state.
- Permit one coalesced manual refresh from the status card, subject to rate-limit backoff.
- Request When In Use location permission when the rider first taps recenter. Include a clear usage description.
- Denied/restricted permission leaves the Fort Wayne map fully usable. Offer a Settings link only when relevant.
- Support approximate location and its accuracy radius. Show last known user location as such when it ages.
- Pan gestures end camera following. Data refreshes never restore following without user action.
- Keep user coordinates on device; they are unnecessary in requests to these fleet/topology endpoints.

## 8. Implementation sequence and completion gates

### Milestone 1 — API contract and fixtures

- [ ] Create the iOS project and typed DTOs for the four required endpoints.
- [ ] Decode the full raw topology/fleet captures and create small, complete fixtures for edge cases.
- [ ] Account for optional/null fields, unknown IDs, false visibility flags, and wrong MIME types.
- [ ] Confirm anonymous HTTPS access from a normal iOS simulator/device during a small foreground smoke test.

Gate: the app can load real or fixture fleet data with route/stop indexes and correct local receipt metadata. No private collector credentials are involved.

### Milestone 2 — One working map

- [ ] Draw route geometry, stop markers, and every valid bus position.
- [ ] Add stable annotation updates and neutral fallbacks.
- [ ] Add recenter and fit-buses controls.
- [ ] Support foreground location permission and permission denial.
- [ ] Prove readable rendering and responsive interaction using the full capture.

Gate: all five requested features are visible, including a continuously aging acquisition label.

### Milestone 3 — Compact interactions

- [ ] Add bus and stop selection cards.
- [ ] Add the searchable route picker with an explicit All routes option.
- [ ] Highlight selection without unexpected camera changes.
- [ ] Make unknown service status and unavailable positions understandable.

Gate: a rider can find a bus, inspect its destination and acquisition age, select its route, and inspect a stop without leaving the map.

### Milestone 4 — Refresh and recovery

- [ ] Add foreground polling, cancellation, coalescing, timeouts, and backoff.
- [ ] Cache topology and reload on version change.
- [ ] Apply detours/supplemental geometry with idempotent refresh handling.
- [ ] Handle empty fleets, missing buses, malformed responses, and network loss.

Gate: failed requests preserve honest last-received data; successful snapshots reconcile correctly; a route detour can appear and clear without duplicated or invented geometry.

### Milestone 5 — Accessibility and delivery

- [ ] Support VoiceOver labels containing route, destination, and acquisition age.
- [ ] Provide an accessible list of the currently filtered buses from the status card so map precision is not required; keep it as a sheet, not a new navigation section.
- [ ] Support Dynamic Type, sufficient contrast, non-color selection/status cues, and at least 44-point touch targets.
- [ ] Check dark mode, Reduce Motion, permission changes, foreground/background transitions, and weak connectivity.
- [ ] Document build/run instructions and complete a device smoke test before a TestFlight build.

Gate: the app works without location permission and remains understandable when data is delayed or unavailable.

## 9. Focused verification

Use deterministic tests for behavior that could mislead a rider:

- Decode valid JSON served with octet-stream MIME type; distinguish empty data from malformed envelopes.
- Check fleet identity, additions/removals, unknown routes, invalid coordinates, and inclusion of false visibility flags.
- Verify receipt age resets only on accepted data, continues through failure, and never claims GPS capture age.
- Verify disconnected geometry stays disconnected and partial stop updates preserve existing fields.
- Replay detour updates, clear them, and verify supplemental geometry resolution/version reload behavior.
- With a fake clock and mock transport, confirm no overlapping polling, foreground cancellation, duplicate suppression, and global 429 backoff.
- UI-test bus selection, stop selection, filter/reset, location denial, and visible delayed/offline states.
- Profile the full captured topology (approximately 2 MB), rather than the abbreviated readable samples.

Several `api-discovery/samples/` files contain `_note` placeholders, omitted objects, or strings inside otherwise numeric arrays. Use them to understand the payload, not as a claim that every abbreviated example is production-shaped. Use [the full raw topology](../api-discovery/raw/topo.json) and full raw fleet for contract fixtures.

The existing Node checks remain relevant to future changes that touch the collector. This documentation-only change does not require deploying or modifying that service. Xcode builds and simulator/device tests belong to the implementation milestones and have not been run for this plan.

## 10. Remaining verification items

These do not require another design round; resolve them during implementation:

1. Check current endpoint availability and confirm behavior still matches the recorded contract.
2. Confirm the full refresh reducer’s detour-clearing semantics from the captured frontend and a controlled fixture before using detours as current geometry.
3. Verify the observed polling cadence is appropriate for native distribution; reassess shared caching only if user volume justifies a backend.
4. Confirm iOS 17+ device coverage before release.
5. If a reliable source acquisition timestamp becomes available, document its units/meaning and add a separate source-age label.

## Repository references

- [API specification](../api-discovery/openapi.json)
- [Full vehicle capture](../api-discovery/raw/topo_vehicules.json)
- [Readable topology sample](../api-discovery/samples/GET_topo.json)
- [Readable topology refresh sample](../api-discovery/samples/GET_topo_refresh.json)
- [Version sample](../api-discovery/samples/GET_config_version.json)
- [Existing browser API wrappers](../webapp/api.js)
- [Existing browser map behavior](../webapp/app.js)
- [Captured upstream frontend](../api-discovery/raw/scripts_topologie.min.js)
- [Original project goals](reference-project.md)

The original notes preferred proving a web app before a mobile app. This plan follows the current explicit request for an iOS app while reusing the documented public API and existing examples.
