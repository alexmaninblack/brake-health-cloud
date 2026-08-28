// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import type {
  ReleaseCandidateFixture,
  ServiceLogFixture,
  VehicleDataState,
} from "@brake-health/contracts";

export const FIXTURE_INSTANT = "2026-08-28T12:00:00.000Z";

export const RELEASE_CANDIDATES: readonly ReleaseCandidateFixture[] = [
  {
    source: "FIXTURE_NON_LIVE",
    candidateId: "brake-health-v1-fixture",
    serviceId: "BRAKE_HEALTH",
    serviceVersion: "1.0.0",
    compatibleVdp: ["1.0.0", "2.0.0", "3.0.0"],
    permissions: {
      read: ["Vehicle.Speed", "Vehicle.Chassis.Brake.PedalPosition"],
      actuate: [],
    },
    quota: { cpuDmips: 120, memoryMiB: 64 },
    state: "PREPARED_FIXTURE",
  },
  {
    source: "FIXTURE_NON_LIVE",
    candidateId: "brake-health-v2-fixture",
    serviceId: "BRAKE_HEALTH",
    serviceVersion: "2.0.0",
    compatibleVdp: ["2.0.0", "3.0.0"],
    permissions: {
      read: [
        "Vehicle.Speed",
        "Vehicle.Chassis.Brake.PedalPosition",
        "Vehicle.Chassis.Axle.Row1.Wheel.Left.Speed",
      ],
      actuate: [],
    },
    quota: { cpuDmips: 150, memoryMiB: 80 },
    state: "PREPARED_FIXTURE",
  },
  {
    source: "FIXTURE_NON_LIVE",
    candidateId: "brake-health-v3-fixture",
    serviceId: "BRAKE_HEALTH",
    serviceVersion: "3.0.0",
    compatibleVdp: ["3.0.0"],
    permissions: {
      read: [
        "Vehicle.Speed",
        "Vehicle.Chassis.Brake.PedalPosition",
        "Vehicle.Chassis.Axle.Row1.Wheel.Left.Speed",
      ],
      actuate: ["Vehicle.OEM.BrakeHealth.Advisory.Request"],
    },
    quota: { cpuDmips: 180, memoryMiB: 96 },
    state: "PREPARED_FIXTURE",
  },
] as const;

export const VEHICLE_DATA_FIXTURES: readonly VehicleDataState[] = [
  { kind: "EMPTY", source: "FIXTURE_NON_LIVE" },
  { kind: "DISCONNECTED", source: "FIXTURE_NON_LIVE" },
  {
    kind: "REPRESENTATIVE",
    source: "FIXTURE_NON_LIVE",
    vdpVersion: "1.0.0",
    values: { "Vehicle.Speed": 42.5 },
  },
  {
    kind: "REPRESENTATIVE",
    source: "FIXTURE_NON_LIVE",
    vdpVersion: "2.0.0",
    values: {
      "Vehicle.Speed": 42.5,
      "Vehicle.Chassis.Axle.Row1.Wheel.Left.Speed": 42.1,
    },
  },
  {
    kind: "REPRESENTATIVE",
    source: "FIXTURE_NON_LIVE",
    vdpVersion: "3.0.0",
    values: {
      "Vehicle.Speed": 42.5,
      "Vehicle.Chassis.Axle.Row1.Wheel.Left.Speed": 42.1,
      "Vehicle.CarlaSimulation.ChaosWheel.Row1.Left.LongitudinalSlip": 0.08,
    },
  },
] as const;

export const SERVICE_LOG_FIXTURES: readonly ServiceLogFixture[] = [
  {
    kind: "UNAVAILABLE",
    source: "FIXTURE_NON_LIVE",
    explanation: "AosEdge/AosCloud log delivery is not connected in this fixture.",
  },
  {
    kind: "EMPTY",
    source: "FIXTURE_NON_LIVE",
    explanation: "No authoritative service log records are present.",
  },
] as const;

export function deterministicId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("sequence must be a positive safe integer");
  }
  return `fixture-${sequence.toString().padStart(4, "0")}`;
}
