# Stop visit investigations

Open **Stop visits**, choose an Indianapolis local date, route and stop, then
click **Investigate**. Stops with collected predictions appear first. After the
first study, destination labels become available as an optional direction filter.
The screen uses imported D1 history and the archived R2 reference snapshot. It
does not initiate an import or change the daily import setting.

Select a candidate visit to inspect:

- A north-up geographic plot of route geometry, the stop and observed vehicle
  positions, with heading and a distance scale. Playback steps through actual
  captures; it does not create intermediate observations. There is no street
  basemap, and gaps longer than 150 seconds are not joined.
- Prediction revisions: capture time on the horizontal axis and displayed
  arrival clock time on the vertical axis. Blue is `horaire`, dashed gray is
  nonzero `horaireApplicable`, and green marks the inferred proximity interval.
  These field interpretations remain provisional.
- Competing and flagged prediction series, status codes, original French fields
  and source object keys. Inspect these before accepting an association.
- A saved review: unreviewed, accept association, reject association or uncertain,
  plus a note. Accept requires choosing a series. Reviews never change source data.

## Method `proximity-v1`

Positions are grouped by vehicle. A route/destination change or gap greater than
150 seconds starts a new trace. Invalid coordinates and vehicle IDs are omitted.
A candidate requires an observation within 60 m of the stop, or a straight line
between successive observations within 40 m, with both endpoints within 600 m
and implied speed at most 35 m/s. Overlapping hits form a single candidate.

Candidates receive at most **medium** confidence. Medium requires observed
approach and departure beyond 100 m, no implausible position jump, no more than
eight minutes near the stop, all evidence marked visible, route geometry within
100 m, movement within 45 degrees of the closest route segment (either
orientation), and reported approach heading within 60 degrees of movement.
Other candidates remain visible with low confidence and explicit reasons.

The proximity interval normally runs from the capture preceding the first
within-60-m observation to that observation. A two-position crossing uses the
capture interval and an interpolated closest-point estimate. These times use
capture timestamps; GPS measurement age is unknown. Passing near a stop does not
establish boarding, a door opening, service at that stop, or an exact arrival.

Prediction series are grouped by route, stop, raw destination key/label and
`idHoraire`. IDs are not assumed to identify a vehicle or a unique trip across
days. For each visit, the most recent series observation in the preceding
45 minutes is considered. Provisional eligibility requires an equal normalized
destination label, `etatPassage=0`, `etatHoraire=1`, an unambiguous local clock,
and a predicted time within a broad plus/minus 20 minutes of the visit estimate.
Flagged or out-of-window series remain inspectable. Only one eligible series
for one medium-confidence visit produces `matched`; competing associations
produce `ambiguous`, and low-confidence/missing evidence produces
`insufficient_evidence`. `matched` remains provisional, not ground truth.

There are **no accuracy scores or independent predictions in this release**.
The time-window eligibility rule can exclude very wrong forecasts and bias an
accuracy score. Do not calculate network accuracy from these automatic matches.
The next step is to review representative visits, establish trustworthy trip
associations independently of forecast error, and then define evaluation metrics.

Clock values are interpreted against the selected study date only for this
investigation. Repeated or nonexistent daylight-saving hours remain unresolved;
raw clock values are retained. A midnight value is not assigned to an adjacent
service day by guesswork. The reference snapshot is the latest at/before the
day's start, falling back to the first available during that day with a warning.
Missing earlier reference data or changes between reference hashes during the
day reduce confidence. Version changes may include unrelated reference content;
this precaution does not claim the chosen route changed.

## Storage, SQL and limits

Migration `0003_stop_visits.sql` adds derived visits, separate annotations and
`analysis_stop_visits`. Repeating an investigation replaces that study's derived
rows in one D1 batch. Stable IDs preserve reviews while evidence remains stable.
It does not update automatically after imports; click Investigate to refresh.

A study is identified by method version, date, route, stop and direction filter.
The same physical visit can appear in several studies, so restrict SQL to one
`study_id` before counting visits. Saved annotations are review opinions, not
validated API semantics. Reviews for visits no longer generated are retained
separately but are absent from the joined analysis view.

For example, use the existing SQL editor and CSV export:

```sql
SELECT study_id, study_date, route_id, stop_id, vehicle_id,
       arrival_start, arrival_end, confidence, classification,
       review_decision, review_note
FROM analysis_stop_visits
ORDER BY generated_at DESC, arrival_start
LIMIT 100;
```

The screen limits each investigation to one route, stop and day; 20,000 vehicle
rows, 10,000 prediction rows, 10,000 geometry segments and 200 candidate visits.
Exceeding a limit fails explicitly. Optional direction filtering can reduce visit
count but does not bypass observation-row limits. The SQL/CSV limits are unchanged.
All data routes use the dashboard's existing authentication and mutation-origin
checks. No external map service or new credentials are required.

## Validation

`npm run check` passes 44 unit and 11 integration tests, type checking and both
Worker builds. Tests cover uncertainty, competing/shared series, hidden/stationary
vehicles, sparse traces, GPS jumps, flagged predictions, daylight-saving clocks,
real local R2/D1 bindings, saved reviews and dashboard DOM interactions.

A read-only check against the previously validated November 3 archive for route
8C / stop 277210 processed 1,132 vehicle observations and 2,548 prediction rows.
It found 30 proximity candidates: 24 low/insufficient evidence, five
medium/ambiguous and one medium/provisionally matched. These counts validate
execution against real shapes, not arrival accuracy or completeness. Review the
actual evidence before using any association. Visual browser QA was unavailable;
DOM tests do not establish layout quality in a full browser.

Apply all D1 migrations before deploying the analytics Worker. Existing import
controls, collector configuration, Access policy and secrets need no changes.
