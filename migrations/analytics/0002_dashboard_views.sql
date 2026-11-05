-- Public analysis surface: no import bookkeeping or request headers.
CREATE VIEW analysis_collections AS
 SELECT dataset,stop_id,scheduled_at,requested_at,completed_at,ok,http_status,error,source_key
 FROM collection_results;
CREATE VIEW analysis_runs AS
 SELECT run_id,scheduled_at,finished_at,plan_hash,outcomes_json,selection_json
 FROM collection_runs;
CREATE VIEW analysis_reference_captures AS
 SELECT object_key AS source_key,reference_hash,scheduled_at,requested_at AS observed_at
 FROM imported_objects WHERE dataset='full_topology' AND status='complete';
