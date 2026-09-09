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
The owned backend-only Docker recipe is prepared by engineering and consumed
by Demo Control; it deliberately does not ship the fixture Dashboard.

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
remains the native default; tests may select port 0. Native host exposure is
fixed to `127.0.0.1`; no arbitrary bind-address flag exists. Explicit
`--runtime-mode container` uses the container-internal wildcard interface so
Docker can forward loopback-published ports. Without an explicit database path, the
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
`POST /api/v1/brake/admin/current-run/cleanup`. Their `systemUids` selector is
either the exact current Test UID (also when Production is present), or the
exact sorted full current-context list for the dual-role engineering flow.
Production-only, empty, duplicate, wildcard, foreign and other partial
selectors are rejected. Confirmation-token, expiry, row-set digest,
transaction and nonmatching-data preservation semantics are unchanged.

Preview and execute return `nonmatchingRecordCounts`, using the same six
counters as matching records: `messages`, `windows`, `assessments`, `events`,
`advisories` and `quarantine`. Preview counts are observations, not part of the
confirmation token; changes to unrelated records do not make a Test preview
stale. Execute returns transactional post-cleanup counts alongside the
unchanged nonmatching digest. A successful Test cleanup does not mean the
whole store is empty: both `remainingMatchingRecordCounts` and
`nonmatchingRecordCounts` must be all zero for that conclusion. Preserve the
volume if nonmatching data remains.

For Retire, Demo Control retains the retiring UID context until scoped cleanup
has confirmed zero matching records, then clears only the retired scope;
peer context and its backend owner remain when still required. The cleanup
operation itself does not mutate context or stop a process. Clearing context
is not data deletion. A new cycle cannot query an
earlier Unit's records merely because the database still exists.

## Commands

### Prebuilt container input for Demo Control

`Dockerfile` pins the official Node 26.0.0 Linux ARM64 image by immutable
digest; `npm ci` uses the existing lock and exact npm 11.12.1. Only the real
compiled backend, migrations and notices enter the final image, with no npm
runtime dependency, frontend fixtures, credentials or operational data.
`container-build.json` is the source recipe inventory, **not** proof of a
built or qualified image. Engineering preparation runs:

```text
docker build --platform linux/arm64 --iidfile <owned-image-id-file> /path/to/brake-health-cloud
```

Demo Control records the resulting local `sha256:...` image ID in its artifact
catalog. It generates the Compose deployment with these exact inputs:

| Input | Value |
| --- | --- |
| Container / network | `aosedge-demo-brake-cloud` / `aosedge-demo-brake-cloud-v1` |
| Named volume | `aosedge_demo_brake_cloud_v1:/data` |
| Published ingestion/health port | `127.0.0.1:18091:18091` |
| Context | Dedicated owned directory mounted read-only at `/run/demo-control/context` |
| Context filename | `current-unit-context.json`, reread after atomic replacement |
| Persistent database | `/data/brake-health.sqlite`, owned by the nonroot `node` user |
| Private admin socket | `/tmp/demo-backend/admin.sock`, never host-published |
| Restart | `unless-stopped` |
| Startup | `docker compose up --detach --no-build --pull never --wait` |

The image entrypoint is `node /app/out/backend/main.js`; its default args are:

```text
--runtime-mode container --port 18091
--database-path /data/brake-health.sqlite
--admin-socket-path /tmp/demo-backend/admin.sock
--context-path /run/demo-control/context/current-unit-context.json
--migrations-directory /app/migrations
```

The native default stays loopback. The container mode is not a safe native
bind override: Demo Control must enforce the Docker/network boundary and
loopback-only publication. No host network, Docker socket, protected credential
or broad filesystem mount is required. Container health checks only
`/health/ready`; `/health/context` can be unavailable before Provision without
blocking backend process/storage startup. Port 18081/the live function UI is a
later frontend integration; do not serve the fixture UI as live data.

Scoped cleanup uses the existing entrypoint, not a public admin route:

```text
docker exec --interactive aosedge-demo-brake-cloud node /app/out/backend/main.js --admin-operation preview
docker exec --interactive aosedge-demo-brake-cloud node /app/out/backend/main.js --admin-operation execute
```

Demo Control supplies the accepted bounded cleanup JSON on stdin and captures
`{"status":HTTP_STATUS,"body":RESPONSE}` privately. Preview requires
`schemaVersion: 1`, `contractVersion: "1.0.0"` and an accepted exact current
`systemUids` scope as defined above; execute additionally requires the returned
`confirmationToken`.
The CLI accepts no caller-selected URL, method or socket path. Never put the
confirmation token in shell arguments or operational logs. Normal stop retains
the volume; Retire must reconcile scoped cleanup before any owned volume
removal. The private Unix socket is not mounted from macOS.

This source increment was tested using ephemeral native listeners/databases,
not Docker. Image assembly, container startup/restart, port isolation and QEMU
guest routes remain actual qualification steps before any E2E claim.

### Native development

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
