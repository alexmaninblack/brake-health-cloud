-- SPDX-FileCopyrightText: 2026 maninblack
-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
