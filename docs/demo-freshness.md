<!-- SPDX-FileCopyrightText: 2026 maninblack -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local-demo raw-window freshness budget

The local-demo raw-window validator accepts `maxSourceAgeMs` from 0 through
5000 ms, inclusive. This is the same bound as the service's
[telemetry-window profile](https://github.com/alexmaninblack/aosedge-sdv-demo/blob/main/contracts/brake-telemetry-window/brake-telemetry-window-profile.v1.json)
and [chunk schema](https://github.com/alexmaninblack/aosedge-sdv-demo/blob/main/contracts/brake-telemetry-window/brake-telemetry-window-chunk.schema.json).
Values above 5000 ms or negative ages are invalid.

Payload shape, native provenance, content hashes, durable acknowledgements and
retained-message identity keep their own validation rules. Previously valid
messages remain valid; mock records stay in the isolated mock store. This
raw-window ingestion bound is not a qualification claim for V2/V3 models or
driver Advisory behavior, nor a replacement for their own readiness rules.
