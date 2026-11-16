# GTFS schedule comparison

On the dashboard overview, use the prominent **Schedule vs. predictions** card
and click **Compare departure times**. The **Schedule vs. predictions** tab
opens the same screen. Bookmark the dashboard URL with `#comparison` to open it
directly. Choose a capture date,
GTFS service date, route and stop. The service date is explicit: late-night API
responses can describe tomorrow’s departures. History must already be imported.
This screen does not fetch the upstream API, start imports, or change schedules.

The table compares GTFS `departure_time`, API `horaireApplicable`, and API
`horaire`. Signed differences are seconds: positive means later than the stated
baseline. Zero API scheduled time means unavailable. `timepoint=0` is estimated;
`timepoint=1` is an exact timetable timepoint, not evidence of an actual departure.
Vendor status codes remain visible; suppressed predictions are hidden in the
chart and table display but raw values remain in CSV for inspection.

The latest observation per raw API entry is the default; Show every capture
reveals revisions. Neither entry counts nor repeated captures count independent
bus trips. Click an entry for its revision chart. The table previews 500 rows;
CSV includes all captures up to the 10,000-observation day/route/stop limit. Larger
studies fail explicitly. No actual departure accuracy score is computed.

## Matching and dates

For each capture, route and stop identifiers use the latest completed topology
at or before that capture (never a future reference). API route mnemonic maps to
GTFS route_short_name, and API stop code maps to GTFS stop_id. Applicable calendar
service and calendar_dates exceptions are evaluated on the selected service day.
Exactly one stop call must lie within 60 seconds of the API's nonzero scheduled
time. Predicted times never select the candidate. Multiple calls are ambiguous;
missing references, unmatched schedules and flagged observations stay visible.
Destination labels and trip IDs are not assumed equivalent across the feeds;
a unique scheduled-time candidate is still provisional, not a verified trip.

Clock conversion rejects repeated/missing daylight-saving hours. A capture must
be within 24 hours before or 6 hours after the selected GTFS stop call; otherwise
its service date stays unresolved. These are explicit plausibility bounds, not
automatic service-date inference. Differences crossing 12 hours are unresolved,
not normalized silently across midnight. GTFS hours beyond 24 are preserved.

## Feed provenance and refresh

The bundled source ZIP is the user's supplied Citilink feed, with its declared
version, date range, agency timezone and SHA-256 displayed in results. Its
published source is https://fwcitilink.com/gtfs/#gtfs . Declared feed dates do not
prove that this exact September revision was published for every earlier date.
Use a historically appropriate snapshot for historical analysis.

Rebuild the compact timetable from a downloaded ZIP:

```sh
python scripts/prepare-gtfs.py /path/to/citilink.zip
npm run check
```

The command also accepts a direct HTTPS ZIP URL. Use the current download link
from Citilink's page, not the HTML page URL. It validates the expected timezone,
limits downloaded input and table sizes, and updates the bundled source ZIP and
generated timetable together. Review the feed changes before releasing the
analytics Worker. There is no silent background replacement; deploying a new
snapshot changes comparisons, while collected API history remains untouched.
No database migration or collector configuration change is needed.

As checked November 16, 2026, the source page links to a feed whose declared
version is March 3, older than the supplied September 1 snapshot. The refresh
command rejects older recognized revision dates by default. Use `--allow-older`
only when intentionally selecting an older snapshot for historical analysis.
