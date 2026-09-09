<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Brake Health Cloud

This repository contains the Brake Health backend and the source-only Function
Dashboard. The backend provides loopback health, durable SQLite ingestion,
acknowledgement, current-Unit REST queries, notification-only SSE and scoped
cleanup over a separate local Unix socket.

The Dashboard provides the `Release Candidates`, `Vehicle Data` and `Service
Logs` views. Its displayed records remain deterministic non-live fixtures; the
Dashboard is not yet wired to the backend. Signing, publication, AosCloud,
vehicle orchestration and container deployment are not owned by this backend.

## Studio P1 lifecycle and Test scope

The existing backend entrypoint accepts these explicit Demo Control inputs:

```text
node out/backend/main.js --port 4300 \
  --database-path /owned/runtime/brake/data.db \
  --admin-socket-path /owned/runtime/brake/admin.sock \
  --context-path /owned/runtime/brake/current-unit-context.json \
  --migrations-directory /path/to/brake-health-cloud/migrations
```

The paths above are placeholders, not additional operator preparation steps.
Demo Control owns the directories, process and persistent context. Port 4300
remains the default; tests may select port 0. Host exposure is fixed to
`127.0.0.1`. No flags can widen it. Without an explicit database path, the
development API retains its disposable temporary-database behavior; a demo
must supply its owned persistent path. Park/Resume keeps that database.

The context is a bounded JSON file, read on demand without restarting the
backend or exposing a new mutating HTTP endpoint:

```json
{
  "schemaVersion": 1,
  "contractVersion": "1.0.0",
  "source": "CURRENT_RUN_PROVISIONING_JOURNAL",
  "testUnit": {
    "systemUid": "current-test-system-uid",
    "unitRole": "VALIDATION",
    "userFacingRole": "Test Vehicle"
  }
}
```

The existing engineering flow may additionally supply a distinct
`productionUnit` with `unitRole: "PRODUCTION"` and
`userFacingRole: "Production Vehicle"`. It must be absent, not null, in the
Test-only flow. A Production-only, malformed, missing or unreadable context is
not a usable query scope. There is no last-known-Unit fallback or Cloud lookup.
Programmatic composition may supply the same document or a trusted provider
callback as `startBackend({ currentUnitContext })`.

Process/storage readiness is deliberately independent from vehicle context:

| Read | Success | Context not yet bound |
| --- | --- | --- |
| `GET /health/live` | `200 {"status":"LIVE"}` | Still live |
| `GET /health/ready` | `200 {"ready":true,"reason":"READY","schemaVersion":2}` | Still storage-ready |
| `GET /health/context` | `200 {"ready":true,"reason":"READY","systemUids":["current-test-system-uid"]}` | `503 {"ready":false,"reason":"CURRENT_UNIT_CONTEXT_UNAVAILABLE","systemUids":[]}` |

Unavailable storage makes query-context readiness false with reason
`TEMPORARILY_UNAVAILABLE`. Neither health endpoint proves that a vehicle
service is installed/running or that a product result exists. Requests for a
non-current UID return `404 UNIT_NOT_CURRENT`; missing context yields
`503 CURRENT_UNIT_CONTEXT_UNAVAILABLE`. Losing or changing context also closes
obsolete SSE subscriptions before further notifications are emitted.

The two existing admin routes remain available **only** on the mode-0600 Unix
socket: `POST /api/v1/brake/admin/current-run/cleanup-preview` and
`POST /api/v1/brake/admin/current-run/cleanup`. Their selector is the exact
sorted `systemUids` list from the injected context: one Test UID, or both UIDs
for the dual-role engineering flow. Empty, duplicate, wildcard, foreign and
partial selectors are rejected. Confirmation-token, expiry, row-set digest,
transaction and nonmatching-data preservation semantics are unchanged.

For Retire, Demo Control retains the retiring UID context until scoped cleanup
has confirmed zero matching records, then clears the context and stops the
process. Clearing context is not data deletion. A new cycle cannot query an
earlier Unit's records merely because the database still exists.

## Commands

The supported toolchain is exactly Node 26.0.0 and npm 11.12.1.

```text
npm ci
npm run typecheck
npm run test
npm run build
npm run dev -- --host 127.0.0.1
```

Development listeners reject non-loopback hosts. Builds write only to the
ignored `out/` directory, tests use temporary SQLite databases, and committed
source contains no operational data or credentials.
