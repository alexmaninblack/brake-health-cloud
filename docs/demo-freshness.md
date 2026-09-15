<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local-demo raw-window freshness budget

On 15 September 2026 the operator approved a 5000-ms maximum source age for
the current Brake V1 real-data trial. The backend raw-window validator accepts
the same nonnegative age bound as the service and Solution chunk schemas.
Values above 5000 ms or negative ages remain invalid. Payload shape, native
provenance, content hashes, durable acknowledgements and retained-message
identity are unchanged. Previously valid messages remain valid; mock records
remain in the isolated mock store. This change makes no V2/V3 model or Advisory
qualification claim.
