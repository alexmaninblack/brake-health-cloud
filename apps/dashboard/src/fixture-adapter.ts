// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import {
  RELEASE_CANDIDATES,
  SERVICE_LOG_FIXTURES,
  VEHICLE_DATA_FIXTURES,
} from "@brake-health/test-support";

/**
 * This adapter is deliberately synchronous and fixture-only. A later packet
 * owns every backend, helper and cloud integration seam.
 */
export function readDashboardFixtures() {
  return {
    releaseCandidates: RELEASE_CANDIDATES,
    serviceLogs: SERVICE_LOG_FIXTURES,
    vehicleData: VEHICLE_DATA_FIXTURES,
  } as const;
}
