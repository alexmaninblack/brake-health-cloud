-- SPDX-FileCopyrightText: 2026 maninblack
-- SPDX-License-Identifier: Apache-2.0

-- Forward-only projection migration. Messages, receipts and legacy provenance
-- remain unchanged. The migration runner owns one atomic transaction.

CREATE TABLE windows_native (
  wire_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (wire_schema_version IN (1, 2)),
  service_instance_json TEXT,
  id INTEGER PRIMARY KEY,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  unit_role TEXT NOT NULL CHECK (unit_role IN ('VALIDATION', 'PRODUCTION')),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT CHECK (
    length(service_artifact_sha256) = 64 AND service_artifact_sha256 = lower(service_artifact_sha256)
      AND service_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  vdp_contract_version TEXT NOT NULL,
  vdp_contract_sha256 TEXT NOT NULL CHECK (
    length(vdp_contract_sha256) = 64 AND vdp_contract_sha256 = lower(vdp_contract_sha256)
      AND vdp_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
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
  completion_content_sha256 TEXT CHECK (
    completion_content_sha256 IS NULL OR (
      length(completion_content_sha256) = 64
        AND completion_content_sha256 = lower(completion_content_sha256)
        AND completion_content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  window_sha256 TEXT CHECK (
    window_sha256 IS NULL OR (
      length(window_sha256) = 64 AND window_sha256 = lower(window_sha256)
        AND window_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_backend_received_at TEXT NOT NULL,
  UNIQUE(unit_system_uid, event_id),
  CHECK (
    (wire_schema_version = 1 AND service_artifact_sha256 IS NOT NULL AND service_instance_json IS NULL)
    OR (wire_schema_version = 2 AND service_artifact_sha256 IS NULL AND service_instance_json IS NOT NULL
      AND json_valid(service_instance_json) AND json_type(service_instance_json) = 'object')
  )
) STRICT;

INSERT INTO windows_native (id, unit_system_uid, event_id, unit_role, service_version, service_artifact_sha256, vdp_contract_version, vdp_contract_sha256, delivery_state, projection_state, terminal_state, received_chunk_count, expected_chunk_count, received_sample_count, phase_pre_count, phase_active_count, phase_post_count, window_start_timestamp, window_start_timestamp_normalized, completion_content_sha256, window_sha256, last_backend_received_at)
SELECT id, unit_system_uid, event_id, unit_role, service_version, service_artifact_sha256, vdp_contract_version, vdp_contract_sha256, delivery_state, projection_state, terminal_state, received_chunk_count, expected_chunk_count, received_sample_count, phase_pre_count, phase_active_count, phase_post_count, window_start_timestamp, window_start_timestamp_normalized, completion_content_sha256, window_sha256, last_backend_received_at FROM windows;
DROP TABLE windows;
ALTER TABLE windows_native RENAME TO windows;
CREATE INDEX idx_windows_unit_order
  ON windows(unit_system_uid, window_start_timestamp_normalized DESC, event_id DESC);

CREATE TABLE assessments_native (
  wire_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (wire_schema_version IN (1, 2)),
  service_instance_json TEXT,
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  assessed_at_normalized TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 = lower(content_sha256)
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT CHECK (
    length(service_artifact_sha256) = 64 AND service_artifact_sha256 = lower(service_artifact_sha256)
      AND service_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  vdp_contract_version TEXT NOT NULL,
  vdp_contract_sha256 TEXT NOT NULL CHECK (
    length(vdp_contract_sha256) = 64 AND vdp_contract_sha256 = lower(vdp_contract_sha256)
      AND vdp_contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_config_sha256 TEXT NOT NULL CHECK (
    length(model_config_sha256) = 64 AND model_config_sha256 = lower(model_config_sha256)
      AND model_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE(unit_system_uid, assessment_id),
  CHECK (
    (wire_schema_version = 1 AND service_artifact_sha256 IS NOT NULL AND service_instance_json IS NULL)
    OR (wire_schema_version = 2 AND service_artifact_sha256 IS NULL AND service_instance_json IS NOT NULL
      AND json_valid(service_instance_json) AND json_type(service_instance_json) = 'object')
  )
) STRICT;

INSERT INTO assessments_native (message_id, unit_system_uid, assessment_id, source_event_id, assessed_at, assessed_at_normalized, content_sha256, service_version, service_artifact_sha256, vdp_contract_version, vdp_contract_sha256, model_id, model_version, model_config_sha256)
SELECT message_id, unit_system_uid, assessment_id, source_event_id, assessed_at, assessed_at_normalized, content_sha256, service_version, service_artifact_sha256, vdp_contract_version, vdp_contract_sha256, model_id, model_version, model_config_sha256 FROM assessments;
DROP TABLE assessments;
ALTER TABLE assessments_native RENAME TO assessments;
CREATE INDEX idx_assessments_unit_order
  ON assessments(unit_system_uid, assessed_at_normalized DESC, assessment_id DESC);

CREATE TABLE condition_events_native (
  wire_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (wire_schema_version IN (1, 2)),
  service_instance_json TEXT,
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  unit_system_uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  effective_at_normalized TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 = lower(content_sha256)
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  service_version TEXT NOT NULL,
  service_artifact_sha256 TEXT CHECK (
    length(service_artifact_sha256) = 64 AND service_artifact_sha256 = lower(service_artifact_sha256)
      AND service_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_config_sha256 TEXT NOT NULL CHECK (
    length(model_config_sha256) = 64 AND model_config_sha256 = lower(model_config_sha256)
      AND model_config_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE(unit_system_uid, event_id),
  CHECK (
    (wire_schema_version = 1 AND service_artifact_sha256 IS NOT NULL AND service_instance_json IS NULL)
    OR (wire_schema_version = 2 AND service_artifact_sha256 IS NULL AND service_instance_json IS NOT NULL
      AND json_valid(service_instance_json) AND json_type(service_instance_json) = 'object')
  )
) STRICT;

INSERT INTO condition_events_native (message_id, unit_system_uid, event_id, assessment_id, source_event_id, effective_at, effective_at_normalized, content_sha256, service_version, service_artifact_sha256, model_id, model_version, model_config_sha256)
SELECT message_id, unit_system_uid, event_id, assessment_id, source_event_id, effective_at, effective_at_normalized, content_sha256, service_version, service_artifact_sha256, model_id, model_version, model_config_sha256 FROM condition_events;
DROP TABLE condition_events;
ALTER TABLE condition_events_native RENAME TO condition_events;
CREATE INDEX idx_events_unit_order
  ON condition_events(unit_system_uid, effective_at_normalized DESC, event_id DESC);
