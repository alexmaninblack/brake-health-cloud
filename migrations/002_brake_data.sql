-- SPDX-FileCopyrightText: 2026 maninblack
-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

INSERT INTO schema_version(version, name, applied_at)
SELECT version, name, applied_at FROM schema_migrations;
DROP TABLE schema_migrations;

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  unit_system_uid TEXT NOT NULL,
  unit_role TEXT NOT NULL CHECK (unit_role IN ('VALIDATION', 'PRODUCTION')),
  message_type TEXT NOT NULL CHECK (message_type IN (
    'WINDOW_CHUNK', 'WINDOW_COMPLETION', 'BRAKE_HEALTH_ASSESSMENT',
    'BRAKE_HEALTH_EVENT', 'BRAKE_ADVISORY_FACT'
  )),
  message_identity TEXT NOT NULL,
  message_key_sha256 TEXT NOT NULL CHECK (
    length(message_key_sha256) = 64 AND message_key_sha256 = lower(message_key_sha256)
  ),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 = lower(content_sha256)
  ),
  canonical_message_sha256 TEXT NOT NULL CHECK (
    length(canonical_message_sha256) = 64 AND canonical_message_sha256 = lower(canonical_message_sha256)
  ),
  canonical_message TEXT NOT NULL,
  source_time TEXT NOT NULL,
  source_time_normalized TEXT NOT NULL,
  local_time TEXT,
  backend_received_at TEXT NOT NULL,
  UNIQUE(unit_system_uid, message_type, message_identity)
) STRICT;

CREATE TABLE receipts (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE window_chunks (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 14),
  first_sample_index INTEGER NOT NULL CHECK (first_sample_index BETWEEN 0 AND 149),
  sample_count INTEGER NOT NULL CHECK (sample_count BETWEEN 1 AND 10),
  phase_pre_count INTEGER NOT NULL CHECK (phase_pre_count BETWEEN 0 AND 10),
  phase_active_count INTEGER NOT NULL CHECK (phase_active_count BETWEEN 0 AND 10),
  phase_post_count INTEGER NOT NULL CHECK (phase_post_count BETWEEN 0 AND 10),
  first_sample_source_timestamp TEXT NOT NULL,
  first_sample_source_timestamp_normalized TEXT NOT NULL,
  content_json TEXT NOT NULL,
  UNIQUE(unit_system_uid, event_id, chunk_index)
) STRICT;

CREATE TABLE window_completions (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK (terminal_state IN (
    'COMPLETE', 'TRUNCATED_MAX_DURATION', 'INCOMPLETE_SOURCE_GAP',
    'ABORTED_SERVICE_STOP', 'ABORTED_RESTART'
  )),
  reason_code TEXT NOT NULL,
  trigger_timestamp TEXT NOT NULL,
  window_start_timestamp TEXT NOT NULL,
  window_start_timestamp_normalized TEXT NOT NULL,
  window_end_timestamp TEXT NOT NULL,
  phase_pre_count INTEGER NOT NULL,
  phase_active_count INTEGER NOT NULL,
  phase_post_count INTEGER NOT NULL,
  total_samples INTEGER NOT NULL CHECK (total_samples BETWEEN 1 AND 150),
  total_chunks INTEGER NOT NULL CHECK (total_chunks BETWEEN 1 AND 15),
  chunk_content_sha256_json TEXT NOT NULL,
  window_sha256 TEXT NOT NULL CHECK (length(window_sha256) = 64),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  UNIQUE(unit_system_uid, event_id)
) STRICT;

CREATE TABLE windows (
  id INTEGER PRIMARY KEY,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  unit_role TEXT NOT NULL CHECK (unit_role IN ('VALIDATION', 'PRODUCTION')),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT NOT NULL CHECK (length(service_artifact_sha256) = 64),
  vdp_contract_version TEXT NOT NULL,
  vdp_contract_sha256 TEXT NOT NULL CHECK (length(vdp_contract_sha256) = 64),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('RECEIVING', 'DELAYED', 'CONFLICT', 'DURABLY_RECEIVED')),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('GROWING', 'PARTIAL', 'TERMINAL', 'QUARANTINED')),
  terminal_state TEXT,
  received_chunk_count INTEGER NOT NULL,
  expected_chunk_count INTEGER,
  received_sample_count INTEGER NOT NULL,
  phase_pre_count INTEGER NOT NULL,
  phase_active_count INTEGER NOT NULL,
  phase_post_count INTEGER NOT NULL,
  window_start_timestamp TEXT NOT NULL,
  window_start_timestamp_normalized TEXT NOT NULL,
  completion_content_sha256 TEXT,
  window_sha256 TEXT,
  last_backend_received_at TEXT NOT NULL,
  UNIQUE(unit_system_uid, event_id)
) STRICT;

CREATE TABLE assessments (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  assessed_at_normalized TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT NOT NULL,
  vdp_contract_version TEXT NOT NULL,
  vdp_contract_sha256 TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_config_sha256 TEXT NOT NULL,
  UNIQUE(unit_system_uid, assessment_id)
) STRICT;

CREATE TABLE condition_events (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  effective_at_normalized TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_config_sha256 TEXT NOT NULL,
  UNIQUE(unit_system_uid, event_id)
) STRICT;

CREATE TABLE advisory_facts (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  request_id TEXT NOT NULL,
  gateway_state TEXT NOT NULL CHECK (gateway_state IN ('RECEIVED', 'APPLIED', 'CLEARED', 'REJECTED', 'EXPIRED', 'FAILED')),
  recorded_at TEXT NOT NULL,
  recorded_at_normalized TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  UNIQUE(unit_system_uid, request_id, gateway_state)
) STRICT;

CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY,
  unit_system_uid TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_identity TEXT NOT NULL,
  message_key_sha256 TEXT NOT NULL CHECK (length(message_key_sha256) = 64),
  attempted_content_sha256 TEXT NOT NULL CHECK (length(attempted_content_sha256) = 64),
  reason_code TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  attempted_canonical_message TEXT NOT NULL
) STRICT;

CREATE INDEX idx_messages_unit_received
  ON messages(unit_system_uid, backend_received_at DESC, id DESC);
CREATE INDEX idx_window_chunks_unit_event
  ON window_chunks(unit_system_uid, event_id, chunk_index);
CREATE INDEX idx_windows_unit_order
  ON windows(unit_system_uid, window_start_timestamp_normalized DESC, event_id DESC);
CREATE INDEX idx_assessments_unit_order
  ON assessments(unit_system_uid, assessed_at_normalized DESC, assessment_id DESC);
CREATE INDEX idx_events_unit_order
  ON condition_events(unit_system_uid, effective_at_normalized DESC, event_id DESC);
CREATE INDEX idx_advisories_unit_order
  ON advisory_facts(unit_system_uid, recorded_at_normalized DESC, request_id DESC, gateway_state DESC);
CREATE INDEX idx_quarantine_unit_key
  ON quarantine(unit_system_uid, message_key_sha256, quarantined_at DESC);
