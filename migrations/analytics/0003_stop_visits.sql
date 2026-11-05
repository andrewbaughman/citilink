CREATE TABLE inferred_stop_visits (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL, study_date TEXT NOT NULL,
  route_id INTEGER NOT NULL, stop_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
  destination TEXT, arrival_start INTEGER NOT NULL, arrival_end INTEGER NOT NULL,
  estimated_at INTEGER NOT NULL, confidence TEXT NOT NULL, classification TEXT NOT NULL,
  method_version TEXT NOT NULL, evidence_json TEXT NOT NULL, generated_at INTEGER NOT NULL
);
CREATE INDEX visits_study ON inferred_stop_visits(study_id,arrival_start);
CREATE TABLE visit_annotations (
  visit_id TEXT PRIMARY KEY, decision TEXT NOT NULL, prediction_key TEXT,
  note TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE VIEW analysis_stop_visits AS
 SELECT v.*,a.decision AS review_decision,a.prediction_key AS reviewed_prediction_key,
 a.note AS review_note,a.updated_at AS reviewed_at
 FROM inferred_stop_visits v LEFT JOIN visit_annotations a ON a.visit_id=v.id;
