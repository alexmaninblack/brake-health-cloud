// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export type UnitRole = "VALIDATION" | "PRODUCTION";
export type MessageType =
  | "WINDOW_CHUNK"
  | "WINDOW_COMPLETION"
  | "BRAKE_HEALTH_ASSESSMENT"
  | "BRAKE_HEALTH_EVENT"
  | "BRAKE_ADVISORY_FACT";
export type ChangedResource = "WINDOW" | "ASSESSMENT" | "EVENT" | "ADVISORY";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ParsedBrakeMessage {
  readonly value: Readonly<Record<string, JsonValue>>;
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly messageType: MessageType;
  readonly unitSystemUid: string;
  readonly unitRole: UnitRole;
  readonly messageIdentity: string;
  readonly messageKeySha256: string;
  readonly contentSha256: string;
  readonly canonicalMessage: string;
  readonly canonicalMessageSha256: string;
  readonly sourceTime: string;
  readonly sourceTimeNormalized: string;
  readonly changedResource: ChangedResource;
}

export class ContractError extends Error {
  public constructor(
    public readonly code: "PAYLOAD_TOO_LARGE" | "UNPROCESSABLE_MESSAGE",
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const COMMON_KEYS = [
  "schemaVersion",
  "contractVersion",
  "messageType",
  "unitSystemUid",
  "unitRole",
  "serviceVersion",
  "serviceArtifactSha256",
  "content",
  "contentSha256",
] as const;

export function parseBrakeMessage(raw: string): ParsedBrakeMessage {
  let parsed: JsonValue;
  try {
    parsed = parseJsonRejectDuplicates(raw);
  } catch (error) {
    throw new ContractError(
      "UNPROCESSABLE_MESSAGE",
      error instanceof Error ? error.message : "message is not valid JSON",
    );
  }
  const value = record(parsed, "message");
  const messageType = enumValue(
    value.messageType,
    [
      "WINDOW_CHUNK",
      "WINDOW_COMPLETION",
      "BRAKE_HEALTH_ASSESSMENT",
      "BRAKE_HEALTH_EVENT",
      "BRAKE_ADVISORY_FACT",
    ] as const,
    "messageType",
  );
  const topKeys = keysFor(messageType);
  closed(value, topKeys, "message");
  exact(value.schemaVersion, 1, "schemaVersion");
  exact(value.contractVersion, "1.0.0", "contractVersion");
  const unitSystemUid = patterned(value.unitSystemUid, BOUNDED_ID, "unitSystemUid");
  const unitRole = enumValue(value.unitRole, ["VALIDATION", "PRODUCTION"] as const, "unitRole");
  const serviceVersion = patterned(value.serviceVersion, SEMVER, "serviceVersion");
  patterned(value.serviceArtifactSha256, SHA256, "serviceArtifactSha256");
  const content = record(value.content, "content");
  const contentSha256 = patterned(value.contentSha256, SHA256, "contentSha256");
  const actualContentSha256 = sha256Hex(canonicalize(content));
  if (actualContentSha256 !== contentSha256) {
    invalid("contentSha256 does not match RFC8785 content bytes");
  }

  const details = validateSpecific(messageType, value, content, serviceVersion);
  const canonicalMessage = canonicalize(value);
  const maximum = messageType.startsWith("WINDOW_") ? 65_536 : 16_384;
  if (Buffer.byteLength(canonicalMessage, "utf8") > maximum) {
    throw new ContractError("PAYLOAD_TOO_LARGE", "canonical message exceeds its closed size bound");
  }
  const key = [unitSystemUid, messageType, ...details.keyParts] satisfies JsonValue[];
  return {
    value,
    content,
    messageType,
    unitSystemUid,
    unitRole,
    messageIdentity: details.identity,
    messageKeySha256: sha256Hex(canonicalize(key)),
    contentSha256,
    canonicalMessage,
    canonicalMessageSha256: sha256Hex(canonicalMessage),
    sourceTime: details.sourceTime,
    sourceTimeNormalized: normalizeRfc3339Instant(details.sourceTime),
    changedResource: details.resource,
  };
}

interface SpecificDetails {
  readonly identity: string;
  readonly keyParts: JsonValue[];
  readonly sourceTime: string;
  readonly resource: ChangedResource;
}

function validateSpecific(
  type: MessageType,
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
  serviceVersion: string,
): SpecificDetails {
  switch (type) {
    case "WINDOW_CHUNK":
      return validateChunk(value, content);
    case "WINDOW_COMPLETION":
      return validateCompletion(value, content);
    case "BRAKE_HEALTH_ASSESSMENT":
      return validateAssessment(value, content, serviceVersion);
    case "BRAKE_HEALTH_EVENT":
      return validateEvent(value, content, serviceVersion);
    case "BRAKE_ADVISORY_FACT":
      return validateAdvisory(value, content, serviceVersion);
  }
}

function validateChunk(
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
): SpecificDetails {
  exact(value.eventType, "HARD_BRAKING_EPISODE_V1", "eventType");
  const eventId = patterned(value.eventId, UUID4, "eventId");
  validateVdp(value);
  closed(content, ["chunkIndex", "firstSampleIndex", "sampleCount", "samples"], "chunk content");
  const chunkIndex = integer(content.chunkIndex, 0, 14, "chunkIndex");
  const firstSampleIndex = integer(content.firstSampleIndex, 0, 149, "firstSampleIndex");
  const sampleCount = integer(content.sampleCount, 1, 10, "sampleCount");
  const samples = array(content.samples, "samples");
  if (samples.length !== sampleCount) {
    invalid("sampleCount must equal samples length");
  }
  let firstTime = "";
  for (const [offset, item] of samples.entries()) {
    const sample = record(item, "sample");
    closed(sample, [
      "sampleIndex", "sourceTimestamp", "phase", "quality", "maxSourceAgeMs",
      "speedKph", "longitudinalAccelerationMps2", "lateralAccelerationMps2",
      "verticalAccelerationMps2", "acceleratorPedalPercent", "brakePedalPercent",
    ], "sample");
    exact(integer(sample.sampleIndex, 0, 149, "sampleIndex"), firstSampleIndex + offset, "sampleIndex order");
    const time = dateTime(sample.sourceTimestamp, "sourceTimestamp");
    if (offset === 0) {
      firstTime = time;
    }
    enumValue(sample.phase, ["PRE", "ACTIVE", "POST"] as const, "phase");
    exact(sample.quality, "VALID_COMPLETE_FRAME", "quality");
    integer(sample.maxSourceAgeMs, 0, 250, "maxSourceAgeMs");
    finiteRange(sample.speedKph, 0, 1000, "speedKph");
    finiteRange(sample.longitudinalAccelerationMps2, -100, 100, "longitudinalAccelerationMps2");
    finiteRange(sample.lateralAccelerationMps2, -100, 100, "lateralAccelerationMps2");
    finiteRange(sample.verticalAccelerationMps2, -100, 100, "verticalAccelerationMps2");
    integer(sample.acceleratorPedalPercent, 0, 100, "acceleratorPedalPercent");
    integer(sample.brakePedalPercent, 0, 100, "brakePedalPercent");
  }
  return {
    identity: `${eventId}:${chunkIndex}`,
    keyParts: [eventId, chunkIndex],
    sourceTime: firstTime,
    resource: "WINDOW",
  };
}

function validateCompletion(
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
): SpecificDetails {
  exact(value.eventType, "HARD_BRAKING_EPISODE_V1", "eventType");
  const eventId = patterned(value.eventId, UUID4, "eventId");
  validateVdp(value);
  closed(content, [
    "terminalState", "reasonCode", "triggerTimestamp", "windowStartTimestamp",
    "windowEndTimestamp", "phaseSampleCounts", "totalSamples", "totalChunks",
    "chunkContentSha256", "windowSha256",
  ], "completion content");
  enumValue(content.terminalState, [
    "COMPLETE", "TRUNCATED_MAX_DURATION", "INCOMPLETE_SOURCE_GAP",
    "ABORTED_SERVICE_STOP", "ABORTED_RESTART",
  ] as const, "terminalState");
  enumValue(content.reasonCode, [
    "NORMAL_CLEAR", "MAX_ACTIVE_DURATION", "SOURCE_GAP", "SERVICE_STOP", "SERVICE_RESTART",
  ] as const, "reasonCode");
  dateTime(content.triggerTimestamp, "triggerTimestamp");
  const start = dateTime(content.windowStartTimestamp, "windowStartTimestamp");
  dateTime(content.windowEndTimestamp, "windowEndTimestamp");
  const phases = phaseCounts(content.phaseSampleCounts);
  const totalSamples = integer(content.totalSamples, 1, 150, "totalSamples");
  const totalChunks = integer(content.totalChunks, 1, 15, "totalChunks");
  if (phases.PRE + phases.ACTIVE + phases.POST !== totalSamples) {
    invalid("phase sample counts must sum to totalSamples");
  }
  const digests = array(content.chunkContentSha256, "chunkContentSha256");
  if (digests.length !== totalChunks || new Set(digests).size !== digests.length) {
    invalid("chunk digest list must be unique and match totalChunks");
  }
  for (const digest of digests) {
    patterned(digest, SHA256, "chunkContentSha256 item");
  }
  patterned(content.windowSha256, SHA256, "windowSha256");
  return { identity: eventId, keyParts: [eventId], sourceTime: start, resource: "WINDOW" };
}

function validateAssessment(
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
  serviceVersion: string,
): SpecificDetails {
  if (serviceVersion !== "2.0.0" && serviceVersion !== "3.0.0") {
    invalid("assessment serviceVersion must be 2.0.0 or 3.0.0");
  }
  const assessmentId = patterned(value.assessmentId, UUID5, "assessmentId");
  patterned(value.sourceEventId, UUID4, "sourceEventId");
  validateVdp(value);
  validateModel(value);
  patterned(value.modelArtifactSha256, SHA256, "modelArtifactSha256");
  const assessedAt = dateTime(value.assessedAt, "assessedAt");
  closed(content, [
    "sourceWindowStartTimestamp", "sourceWindowEndTimestamp", "activeSampleCount",
    "straightActiveSampleCount", "features", "episodeLoadBps", "wearIndexBefore",
    "wearIncrement", "wearIndexAfter", "conditionScore", "previousBand", "currentBand", "quality",
  ], "assessment content");
  dateTime(content.sourceWindowStartTimestamp, "sourceWindowStartTimestamp");
  dateTime(content.sourceWindowEndTimestamp, "sourceWindowEndTimestamp");
  integer(content.activeSampleCount, 5, 100, "activeSampleCount");
  integer(content.straightActiveSampleCount, 5, 100, "straightActiveSampleCount");
  validateFeatures(record(content.features, "features"));
  integer(content.episodeLoadBps, 0, 10_000, "episodeLoadBps");
  integer(content.wearIndexBefore, 0, 100, "wearIndexBefore");
  integer(content.wearIncrement, 4, 10, "wearIncrement");
  integer(content.wearIndexAfter, 0, 100, "wearIndexAfter");
  integer(content.conditionScore, 0, 100, "conditionScore");
  band(content.previousBand, "previousBand");
  band(content.currentBand, "currentBand");
  exact(content.quality, "VALID_DEMO_SYNTHETIC", "quality");
  return { identity: assessmentId, keyParts: [assessmentId], sourceTime: assessedAt, resource: "ASSESSMENT" };
}

function validateEvent(
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
  serviceVersion: string,
): SpecificDetails {
  if (serviceVersion !== "2.0.0" && serviceVersion !== "3.0.0") {
    invalid("event serviceVersion must be 2.0.0 or 3.0.0");
  }
  const eventId = patterned(value.eventId, UUID5, "eventId");
  patterned(value.assessmentId, UUID5, "assessmentId");
  patterned(value.sourceEventId, UUID4, "sourceEventId");
  validateModel(value);
  closed(content, [
    "eventType", "reasonCode", "previousBand", "currentBand", "conditionScore", "effectiveAt", "quality",
  ], "event content");
  exact(content.eventType, "BRAKE_CONDITION_BAND_CHANGED", "eventType");
  exact(content.reasonCode, "SYNTHETIC_ACCUMULATED_STRESS_THRESHOLD", "reasonCode");
  band(content.previousBand, "previousBand");
  band(content.currentBand, "currentBand");
  integer(content.conditionScore, 0, 100, "conditionScore");
  const effectiveAt = dateTime(content.effectiveAt, "effectiveAt");
  exact(content.quality, "VALID_DEMO_SYNTHETIC", "quality");
  return { identity: eventId, keyParts: [eventId], sourceTime: effectiveAt, resource: "EVENT" };
}

function validateAdvisory(
  value: Readonly<Record<string, JsonValue>>,
  content: Readonly<Record<string, JsonValue>>,
  serviceVersion: string,
): SpecificDetails {
  exact(serviceVersion, "3.0.0", "advisory serviceVersion");
  validateVdp(value);
  const requestId = patterned(value.requestId, UUID, "requestId");
  patterned(value.producerEpoch, UUID, "producerEpoch");
  integer(value.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence");
  const gatewayState = enumValue(value.gatewayState, [
    "RECEIVED", "APPLIED", "CLEARED", "REJECTED", "EXPIRED", "FAILED",
  ] as const, "gatewayState");
  const recordedAt = dateTime(value.recordedAt, "recordedAt");
  closed(content, [
    "decisionId", "operation", "recommendation", "reasonCode", "issuedAt", "expiresAt",
    "gatewayReason", "gatewayObservedAt", "activeRecommendation", "activeReasonCode", "activeUntil",
  ], "advisory content", true);
  for (const required of [
    "decisionId", "operation", "reasonCode", "issuedAt", "expiresAt", "gatewayReason",
    "gatewayObservedAt", "activeRecommendation", "activeReasonCode", "activeUntil",
  ]) {
    if (!hasOwn(content, required)) invalid(`advisory content is missing ${required}`);
  }
  patterned(content.decisionId, BOUNDED_ID, "decisionId");
  const operation = enumValue(content.operation, ["SET", "CLEAR"] as const, "operation");
  if (operation === "SET") {
    exact(content.recommendation, "INSPECTION_RECOMMENDED", "recommendation");
    exact(content.reasonCode, "PREDICTED_BRAKE_DEGRADATION", "reasonCode");
  } else {
    if (hasOwn(content, "recommendation")) invalid("CLEAR must not contain recommendation");
    exact(content.reasonCode, "CONDITION_CLEARED", "reasonCode");
  }
  dateTime(content.issuedAt, "issuedAt");
  dateTime(content.expiresAt, "expiresAt");
  enumValue(content.gatewayReason, [
    "NONE", "UNAUTHORIZED_SOURCE", "UNAUTHORIZED_PATH", "INVALID_SCHEMA", "INVALID_VALUE",
    "STALE_REQUEST", "REPLAY_DETECTED", "SEQUENCE_ROLLBACK", "RATE_LIMITED",
    "QM_POLICY_DENIED", "INTERNAL_ERROR",
  ] as const, "gatewayReason");
  dateTime(content.gatewayObservedAt, "gatewayObservedAt");
  enumValue(content.activeRecommendation, ["NONE", "INSPECTION_RECOMMENDED"] as const, "activeRecommendation");
  enumValue(content.activeReasonCode, ["NONE", "PREDICTED_BRAKE_DEGRADATION"] as const, "activeReasonCode");
  if (content.activeUntil !== null) dateTime(content.activeUntil, "activeUntil");
  return {
    identity: `${requestId}:${gatewayState}`,
    keyParts: [requestId, gatewayState],
    sourceTime: recordedAt,
    resource: "ADVISORY",
  };
}

function keysFor(type: MessageType): readonly string[] {
  switch (type) {
    case "WINDOW_CHUNK":
    case "WINDOW_COMPLETION":
      return [...COMMON_KEYS, "eventType", "eventId", "vdpContractVersion", "vdpContractSha256"];
    case "BRAKE_HEALTH_ASSESSMENT":
      return [...COMMON_KEYS, "assessmentId", "sourceEventId", "vdpContractVersion", "vdpContractSha256", "modelId", "modelVersion", "modelArtifactSha256", "modelConfigSha256", "provenance", "assessedAt"];
    case "BRAKE_HEALTH_EVENT":
      return [...COMMON_KEYS, "eventId", "assessmentId", "sourceEventId", "modelId", "modelVersion", "modelConfigSha256", "provenance"];
    case "BRAKE_ADVISORY_FACT":
      return [...COMMON_KEYS, "vdpContractVersion", "vdpContractSha256", "requestId", "producerEpoch", "sequence", "gatewayState", "recordedAt"];
  }
}

function validateVdp(value: Readonly<Record<string, JsonValue>>): void {
  patterned(value.vdpContractVersion, SEMVER, "vdpContractVersion");
  patterned(value.vdpContractSha256, SHA256, "vdpContractSha256");
}

function validateModel(value: Readonly<Record<string, JsonValue>>): void {
  exact(value.modelId, "brake-condition-demo-v1", "modelId");
  exact(value.modelVersion, "1.0.0", "modelVersion");
  patterned(value.modelConfigSha256, SHA256, "modelConfigSha256");
  exact(value.provenance, "DEMO_SYNTHETIC", "provenance");
}

function validateFeatures(features: Readonly<Record<string, JsonValue>>): void {
  closed(features, [
    "peakDecelerationMps2", "peakDecelerationBps", "activeDurationSeconds",
    "activeDurationBps", "speedReductionKph", "speedReductionBps",
    "meanBrakeEffortPercent", "meanBrakeEffortBps", "wheelDispersionRatio", "wheelDispersionBps",
  ], "features");
  finiteRange(features.peakDecelerationMps2, 0, 100, "peakDecelerationMps2");
  integer(features.peakDecelerationBps, 0, 10_000, "peakDecelerationBps");
  finiteRange(features.activeDurationSeconds, 0, 10, "activeDurationSeconds");
  integer(features.activeDurationBps, 0, 10_000, "activeDurationBps");
  finiteRange(features.speedReductionKph, 0, 1000, "speedReductionKph");
  integer(features.speedReductionBps, 0, 10_000, "speedReductionBps");
  finiteRange(features.meanBrakeEffortPercent, 0, 100, "meanBrakeEffortPercent");
  integer(features.meanBrakeEffortBps, 0, 10_000, "meanBrakeEffortBps");
  finiteRange(features.wheelDispersionRatio, 0, 10, "wheelDispersionRatio");
  integer(features.wheelDispersionBps, 0, 10_000, "wheelDispersionBps");
}

function phaseCounts(value: JsonValue | undefined): { PRE: number; ACTIVE: number; POST: number } {
  const phases = record(value, "phaseSampleCounts");
  closed(phases, ["PRE", "ACTIVE", "POST"], "phaseSampleCounts");
  return {
    PRE: integer(phases.PRE, 0, 30, "PRE"),
    ACTIVE: integer(phases.ACTIVE, 0, 100, "ACTIVE"),
    POST: integer(phases.POST, 0, 20, "POST"),
  };
}

function band(value: JsonValue | undefined, label: string): string {
  return enumValue(value, ["GOOD", "MONITOR", "INSPECTION_RECOMMENDED"] as const, label);
}

export function canonicalize(value: JsonValue): string {
  if (typeof value === "string") validateUnicodeScalarString(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RFC8785 numbers must be finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      validateUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalize(value[key]!)}`;
    })
    .join(",")}}`;
}

export function normalizeRfc3339Instant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) invalid("date-time is not RFC3339");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = (match[7] ?? "").replace(/0+$/, "") || "0";
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 ||
      second > 59 || offsetHour > 23 || offsetMinute > 59) {
    invalid("date-time has an invalid calendar or offset field");
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
      local.getUTCDate() !== day || local.getUTCHours() !== hour ||
      local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) {
    invalid("date-time has an invalid calendar date");
  }
  const offsetDirection = match[9] === "-" ? -1 : 1;
  const offsetMilliseconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  const utc = new Date(local.getTime() - offsetMilliseconds);
  if (!Number.isFinite(utc.getTime())) invalid("date-time is outside the supported range");
  const shiftedMilliseconds = BigInt(utc.getTime()) + 1_000_000_000_000_000n;
  // The fixed-width shifted epoch sorts across UTC year boundaries. `!` sorts
  // before decimal digits, so .1 also sorts before a later .1001 instant.
  return `${shiftedMilliseconds.toString().padStart(16, "0")}.${fraction}!`;
}

function validateUnicodeScalarString(value: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new ContractError("UNPROCESSABLE_MESSAGE", "RFC8785 strings and property names must contain valid Unicode scalar values");
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseJsonRejectDuplicates(raw: string): JsonValue {
  return new JsonReader(raw).parse();
}

class JsonReader {
  private index = 0;
  public constructor(private readonly source: string) {}

  public parse(): JsonValue {
    this.space();
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new SyntaxError("unexpected JSON suffix");
    return value;
  }

  private value(): JsonValue {
    const character = this.source[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number();
  }

  private object(): { [key: string]: JsonValue } {
    this.index++;
    const result = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();
    this.space();
    if (this.source[this.index] === "}") { this.index++; return result; }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"') throw new SyntaxError("object key must be a string");
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.space();
      if (this.source[this.index++] !== ":") throw new SyntaxError("object key requires a value");
      this.space();
      result[key] = this.value();
      this.space();
      const next = this.source[this.index++];
      if (next === "}") return result;
      if (next !== ",") throw new SyntaxError("object entries require a comma");
    }
  }

  private array(): JsonValue[] {
    this.index++;
    const result: JsonValue[] = [];
    this.space();
    if (this.source[this.index] === "]") { this.index++; return result; }
    while (true) {
      this.space();
      result.push(this.value());
      this.space();
      const next = this.source[this.index++];
      if (next === "]") return result;
      if (next !== ",") throw new SyntaxError("array entries require a comma");
    }
  }

  private string(): string {
    const start = this.index;
    this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (!escaped && code === 34) {
        this.index++;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (!escaped && code < 32) throw new SyntaxError("unescaped control character in JSON string");
      if (!escaped && code === 92) escaped = true;
      else escaped = false;
      this.index++;
    }
    throw new SyntaxError("unterminated JSON string");
  }

  private number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.index;
    const result = match.exec(this.source);
    if (result === null) throw new SyntaxError("invalid JSON value");
    this.index = match.lastIndex;
    const value = Number(result[0]);
    if (!Number.isFinite(value)) throw new SyntaxError("JSON number is outside the finite range");
    return value;
  }

  private space(): void {
    while (/[ \t\r\n]/.test(this.source[this.index] ?? "")) this.index++;
  }
}

function record(value: JsonValue | undefined, label: string): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Readonly<Record<string, JsonValue>>;
}

function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value as JsonValue[];
}

function closed(
  value: Readonly<Record<string, JsonValue>>,
  allowed: readonly string[],
  label: string,
  optional = false,
): void {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key))) invalid(`${label} contains an unexpected field`);
  if (!optional && allowed.some((key) => !hasOwn(value, key))) invalid(`${label} is missing a required field`);
}

function patterned(value: JsonValue | undefined, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${label} is invalid`);
  return value as string;
}

function dateTime(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") invalid(`${label} is not a date-time`);
  try {
    normalizeRfc3339Instant(value as string);
  } catch {
    invalid(`${label} is not a date-time`);
  }
  return value as string;
}

function integer(value: JsonValue | undefined, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its integer bound`);
  }
  return value as number;
}

function finiteRange(value: JsonValue | undefined, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its numeric bound`);
  }
  return value as number;
}

function enumValue<const T extends readonly string[]>(
  value: JsonValue | undefined,
  accepted: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !accepted.includes(value)) invalid(`${label} has a closed invalid value`);
  return value as T[number];
}

function exact(value: JsonValue | undefined | number, expected: JsonValue | number, label: string): void {
  if (value !== expected) invalid(`${label} has an invalid value`);
}

function invalid(message: string): never {
  throw new ContractError("UNPROCESSABLE_MESSAGE", message);
}

function hasOwn(value: Readonly<Record<string, JsonValue>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
