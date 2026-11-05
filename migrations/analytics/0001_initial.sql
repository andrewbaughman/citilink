PRAGMA foreign_keys = ON;

CREATE TABLE imported_objects (
  object_key TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  requested_at INTEGER,
  completed_at INTEGER,
  imported_at INTEGER,
  row_count INTEGER,
  reference_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','error')),
  error TEXT,
  interpretation_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE collection_runs (
  manifest_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  finished_at INTEGER,
  plan_hash TEXT,
  outcomes_json TEXT NOT NULL,
  selection_json TEXT,
  imported_at INTEGER
);
CREATE TABLE collection_results (
  manifest_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  stop_id INTEGER,
  scheduled_at INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  source_key TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(manifest_key,attempt_id)
);
CREATE INDEX collection_dataset_time ON collection_results(dataset,scheduled_at);
CREATE TABLE vehicle_observations (
  source_key TEXT NOT NULL REFERENCES imported_objects(object_key),
  row_path TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  vehicle_id INTEGER,
  fleet_number TEXT,
  route_id INTEGER,
  latitude REAL,
  longitude REAL,
  heading_raw REAL,
  speed_raw REAL,
  destination_raw TEXT,
  reported_delay_text TEXT,
  reported_delay_minutes REAL,
  reported_delay_lower_bound_minutes REAL,
  is_visible INTEGER,
  occupancy_raw REAL,
  occupancy_percent REAL,
  quality_flags_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(source_key,row_path)
);
CREATE INDEX vehicle_route_time ON vehicle_observations(route_id,observed_at);
CREATE INDEX vehicle_id_time ON vehicle_observations(vehicle_id,observed_at);
CREATE TABLE stop_predictions (
  source_key TEXT NOT NULL REFERENCES imported_objects(object_key),
  row_path TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stop_id INTEGER NOT NULL,
  route_id INTEGER,
  destination_raw TEXT,
  destination_key_raw TEXT,
  prediction_id INTEGER,
  predicted_seconds_raw INTEGER,
  scheduled_seconds_raw INTEGER,
  scheduled_seconds INTEGER,
  etat_horaire INTEGER,
  etat_passage INTEGER,
  service_date TEXT,
  quality_flags_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(source_key,row_path)
);
CREATE INDEX prediction_stop_time ON stop_predictions(stop_id,observed_at);
CREATE INDEX prediction_revision ON stop_predictions(stop_id,route_id,prediction_id,observed_at);
CREATE TABLE reference_versions (
  content_hash TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE routes (
  reference_hash TEXT NOT NULL,
  route_id INTEGER NOT NULL,
  name TEXT,
  short_code TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(reference_hash,route_id)
);
CREATE TABLE stops (
  reference_hash TEXT NOT NULL,
  stop_id INTEGER NOT NULL,
  code TEXT,
  name TEXT,
  latitude REAL,
  longitude REAL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(reference_hash,stop_id)
);
-- Partial object writes are invisible to the dashboard until the object completes.
CREATE VIEW analysis_vehicles AS
 SELECT v.* FROM vehicle_observations v JOIN imported_objects i ON i.object_key=v.source_key WHERE i.status='complete';
CREATE VIEW analysis_predictions AS
 SELECT p.* FROM stop_predictions p JOIN imported_objects i ON i.object_key=p.source_key WHERE i.status='complete';
CREATE VIEW analysis_routes AS
 SELECT r.* FROM routes r JOIN reference_versions v ON v.content_hash=r.reference_hash;
CREATE VIEW analysis_stops AS
 SELECT s.* FROM stops s JOIN reference_versions v ON v.content_hash=s.reference_hash;
