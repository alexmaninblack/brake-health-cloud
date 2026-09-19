-- SPDX-FileCopyrightText: 2026 maninblack
-- SPDX-License-Identifier: Apache-2.0
-- Additive observation tables; old product bytes and receipts stay unchanged.
CREATE TABLE function_observations (id INTEGER PRIMARY KEY, system_uid TEXT NOT NULL, binding TEXT NOT NULL, generation INTEGER NOT NULL, sequence INTEGER NOT NULL, message_key TEXT NOT NULL UNIQUE, message_digest TEXT NOT NULL, content_digest TEXT NOT NULL, canonical TEXT, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, UNIQUE(system_uid,binding,generation,sequence)) STRICT;
CREATE INDEX function_observations_order ON function_observations(system_uid,binding,generation DESC,sequence DESC);
CREATE TABLE function_observation_conflicts (message_key TEXT NOT NULL, message_digest TEXT NOT NULL, system_uid TEXT NOT NULL, PRIMARY KEY(message_key,message_digest)) STRICT;

