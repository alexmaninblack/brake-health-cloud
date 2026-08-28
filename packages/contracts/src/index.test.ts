// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateReleaseCandidate,
  validateVehicleDataState,
} from "./index";

describe("closed fixture contracts", () => {
  it("accepts a complete release candidate and rejects unknown fields", () => {
    const candidate = {
      candidateId: "candidate-1",
      compatibleVdp: ["1.0.0"],
      permissions: { actuate: [], read: ["Vehicle.Speed"] },
      quota: { cpuDmips: 100, memoryMiB: 64 },
      serviceId: "BRAKE_HEALTH",
      serviceVersion: "1.0.0",
      source: "FIXTURE_NON_LIVE",
      state: "PREPARED_FIXTURE",
    };
    expect(validateReleaseCandidate(candidate)).toBe(candidate);
    expect(() =>
      validateReleaseCandidate({ ...candidate, published: true }),
    ).toThrow(/unexpected field/);
  });

  it("keeps empty and representative vehicle shapes closed", () => {
    expect(
      validateVehicleDataState({ kind: "EMPTY", source: "FIXTURE_NON_LIVE" }),
    ).toEqual({ kind: "EMPTY", source: "FIXTURE_NON_LIVE" });
    expect(() =>
      validateVehicleDataState({
        kind: "DISCONNECTED",
        persisted: true,
        source: "FIXTURE_NON_LIVE",
      }),
    ).toThrow(/unexpected field/);
    expect(
      validateVehicleDataState({
        kind: "REPRESENTATIVE",
        source: "FIXTURE_NON_LIVE",
        values: { "Vehicle.Speed": 12 },
        vdpVersion: "3.0.0",
      }),
    ).toHaveProperty("vdpVersion", "3.0.0");
  });
});
