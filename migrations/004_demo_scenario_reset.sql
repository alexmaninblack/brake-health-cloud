-- SPDX-FileCopyrightText: 2026 maninblack
-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE demo_reset_producers (system_uid TEXT PRIMARY KEY, binding TEXT NOT NULL, last_seen INTEGER NOT NULL) STRICT;
CREATE TABLE demo_reset_commands (command_id TEXT PRIMARY KEY, system_uid TEXT NOT NULL, binding TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL, result TEXT) STRICT;
