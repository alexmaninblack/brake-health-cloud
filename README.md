<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Brake Health Cloud Foundation

This repository contains the source-only foundation for the Brake Health
backend and Function Dashboard. It is intentionally limited to loopback health
endpoints, forward-only SQLite migration state and deterministic UI fixtures.

The Dashboard provides the `Release Candidates`, `Vehicle Data` and `Service
Logs` views. Every displayed record is clearly marked non-live. There is no
Brake Cloud ingestion, acknowledgement, query, SSE, retention, cleanup,
signing, publication, AosCloud, vehicle or container adapter in this increment.

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
