// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

export type VdpVersion = "1.0.0" | "2.0.0" | "3.0.0";

export type BrakeResourceType = "WINDOW" | "ASSESSMENT" | "EVENT" | "ADVISORY";

export interface CurrentUnitContext {
  readonly schemaVersion: 1;
  readonly contractVersion: "1.0.0";
  readonly source: "CURRENT_RUN_PROVISIONING_JOURNAL";
  readonly testUnit: {
    readonly systemUid: string;
    readonly unitRole: "VALIDATION";
    readonly userFacingRole: "Test Vehicle";
  };
  readonly productionUnit: {
    readonly systemUid: string;
    readonly unitRole: "PRODUCTION";
    readonly userFacingRole: "Production Vehicle";
  };
}

export function validateCurrentUnitContext(value: unknown): CurrentUnitContext {
  const context = closedRecord(
    value,
    ["contractVersion", "productionUnit", "schemaVersion", "source", "testUnit"],
    "current Unit context",
  );
  const testUnit = closedRecord(context.testUnit, ["systemUid", "unitRole", "userFacingRole"], "Test Vehicle");
  const productionUnit = closedRecord(
    context.productionUnit,
    ["systemUid", "unitRole", "userFacingRole"],
    "Production Vehicle",
  );
  if (
    context.schemaVersion !== 1 || context.contractVersion !== "1.0.0" ||
    context.source !== "CURRENT_RUN_PROVISIONING_JOURNAL" ||
    testUnit.unitRole !== "VALIDATION" || testUnit.userFacingRole !== "Test Vehicle" ||
    productionUnit.unitRole !== "PRODUCTION" || productionUnit.userFacingRole !== "Production Vehicle" ||
    !systemUid(testUnit.systemUid) || !systemUid(productionUnit.systemUid) ||
    testUnit.systemUid === productionUnit.systemUid
  ) throw new TypeError("current Unit context has an invalid closed value");
  return value as CurrentUnitContext;
}

export interface ReleaseCandidateFixture {
  readonly source: "FIXTURE_NON_LIVE";
  readonly candidateId: string;
  readonly serviceId: "BRAKE_HEALTH";
  readonly serviceVersion: VdpVersion;
  readonly compatibleVdp: readonly VdpVersion[];
  readonly permissions: {
    readonly read: readonly string[];
    readonly actuate: readonly string[];
  };
  readonly quota: {
    readonly cpuDmips: number;
    readonly memoryMiB: number;
  };
  readonly state: "PREPARED_FIXTURE";
}

export type VehicleDataState =
  | { readonly kind: "EMPTY"; readonly source: "FIXTURE_NON_LIVE" }
  | { readonly kind: "DISCONNECTED"; readonly source: "FIXTURE_NON_LIVE" }
  | {
      readonly kind: "REPRESENTATIVE";
      readonly source: "FIXTURE_NON_LIVE";
      readonly vdpVersion: VdpVersion;
      readonly values: Readonly<Record<string, number>>;
    };

export type ServiceLogFixture =
  | {
      readonly kind: "UNAVAILABLE";
      readonly source: "FIXTURE_NON_LIVE";
      readonly explanation: string;
    }
  | {
      readonly kind: "EMPTY";
      readonly source: "FIXTURE_NON_LIVE";
      readonly explanation: string;
    };

const RELEASE_KEYS = [
  "candidateId",
  "compatibleVdp",
  "permissions",
  "quota",
  "serviceId",
  "serviceVersion",
  "source",
  "state",
] as const;

export function validateReleaseCandidate(
  value: unknown,
): ReleaseCandidateFixture {
  const record = closedRecord(value, RELEASE_KEYS, "release candidate");
  if (
    record.source !== "FIXTURE_NON_LIVE" ||
    record.serviceId !== "BRAKE_HEALTH" ||
    !isVdpVersion(record.serviceVersion) ||
    record.state !== "PREPARED_FIXTURE" ||
    typeof record.candidateId !== "string" ||
    !Array.isArray(record.compatibleVdp) ||
    !record.compatibleVdp.every(isVdpVersion)
  ) {
    throw new TypeError("release candidate has an invalid closed value");
  }
  const permissions = closedRecord(
    record.permissions,
    ["actuate", "read"],
    "permissions",
  );
  const quota = closedRecord(
    record.quota,
    ["cpuDmips", "memoryMiB"],
    "quota",
  );
  if (
    !stringArray(permissions.read) ||
    !stringArray(permissions.actuate) ||
    !positiveNumber(quota.cpuDmips) ||
    !positiveNumber(quota.memoryMiB)
  ) {
    throw new TypeError("release candidate metadata is invalid");
  }
  return value as ReleaseCandidateFixture;
}

export function validateVehicleDataState(value: unknown): VehicleDataState {
  const base = closedRecord(
    value,
    ["kind", "source", "values", "vdpVersion"],
    "vehicle data",
    true,
  );
  if (base.source !== "FIXTURE_NON_LIVE") {
    throw new TypeError("vehicle data source must be fixture-only");
  }
  if (base.kind === "EMPTY" || base.kind === "DISCONNECTED") {
    if (Object.keys(base).length !== 2) {
      throw new TypeError("empty vehicle state contains unexpected fields");
    }
    return value as VehicleDataState;
  }
  if (
    base.kind !== "REPRESENTATIVE" ||
    !isVdpVersion(base.vdpVersion) ||
    !numberRecord(base.values)
  ) {
    throw new TypeError("representative vehicle state is invalid");
  }
  return value as VehicleDataState;
}

function isVdpVersion(value: unknown): value is VdpVersion {
  return value === "1.0.0" || value === "2.0.0" || value === "3.0.0";
}

function closedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  optionalKeys = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new TypeError(`${label} contains an unexpected field`);
  }
  if (!optionalKeys && allowedKeys.some((key) => !(key in record))) {
    throw new TypeError(`${label} is missing a required field`);
  }
  return record;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function numberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )
  );
}

function systemUid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
