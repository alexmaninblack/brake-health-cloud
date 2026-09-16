<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current-Test demo scenario reset

The existing owner-only Unix admin socket exposes POST `/api/v1/brake/admin/demo-reset`; the public TCP server does not. Demo Control invokes the fixed private admin client, not a browser-selected URL or command. Request: `{schemaVersion:1,unitSystemUid,commandId}`.

A fresh (15-second) native service poll binds the command to Unit, release, serviceId, subjectId, instanceIndex, instanceId and producerEpoch. One pending command is allowed; execution expires after 60 seconds and history is bounded to 32. Poll and acknowledgement use fixed `/api/v1/brake/demo-control/poll` and `/ack` routes; browser-origin calls are refused. This reuses the private local demo trust boundary and is not production remote-management authentication.

Backend schema 4 persists command/producer records. Completion requires a matching CLEAR request and Gateway CLEARED status, not merely HTTP acceptance. A late valid acknowledgement can reconcile expiry without authorizing new execution. GET `/api/v1/brake/units/<uid>/demo-reset` is read-only. Cleanup includes the new records and preserves foreign Unit data.

Tests establish local storage, identity, idempotency, expiry and proof validation. They do not establish live service or vehicle qualification.

