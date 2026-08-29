// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  deterministicId,
  CURRENT_UNIT_CONTEXT,
  RELEASE_CANDIDATES,
  SERVICE_LOG_FIXTURES,
  VEHICLE_DATA_FIXTURES,
} from "./index";

describe("deterministic test support", () => {
  it("owns fixed IDs and the full fixture-only state set", () => {
    expect(deterministicId(7)).toBe("fixture-0007");
    expect(RELEASE_CANDIDATES.map(({ serviceVersion }) => serviceVersion)).toEqual([
      "1.0.0",
      "2.0.0",
      "3.0.0",
    ]);
    expect(VEHICLE_DATA_FIXTURES.map(({ kind }) => kind)).toEqual([
      "EMPTY",
      "DISCONNECTED",
      "REPRESENTATIVE",
      "REPRESENTATIVE",
      "REPRESENTATIVE",
    ]);
    expect(SERVICE_LOG_FIXTURES.map(({ kind }) => kind)).toEqual([
      "UNAVAILABLE",
      "EMPTY",
    ]);
    expect(CURRENT_UNIT_CONTEXT.testUnit.userFacingRole).toBe("Test Vehicle");
    expect(CURRENT_UNIT_CONTEXT.testUnit.unitRole).toBe("VALIDATION");
  });
});
