// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { type JsonValue, normalizeRfc3339Instant } from "./brake-data-contract.js";

export interface WindowChunkFact {
  readonly chunkIndex: number;
  readonly contentSha256: string;
  readonly content: Readonly<Record<string, JsonValue>>;
}

export interface WindowCompletionFact {
  readonly contentSha256: string;
  readonly content: Readonly<Record<string, JsonValue>>;
}

export interface WindowProjection {
  readonly projectionState: "GROWING" | "PARTIAL" | "TERMINAL" | "QUARANTINED";
  readonly deliveryState: "RECEIVING" | "DELAYED" | "DURABLY_RECEIVED" | "CONFLICT";
  readonly terminalState: string | null;
  readonly receivedChunkCount: number;
  readonly expectedChunkCount: number | null;
  readonly receivedSampleCount: number;
  readonly phaseSampleCounts: { readonly PRE: number; readonly ACTIVE: number; readonly POST: number };
  readonly windowStartTimestamp: string;
  readonly completionContentSha256: string | null;
  readonly windowSha256: string | null;
  readonly inconsistencyReason: string | null;
}

export function reconstructWindow(
  chunks: readonly WindowChunkFact[],
  completion: WindowCompletionFact | null,
): WindowProjection | null {
  const ordered = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const chunkZero = ordered.find(({ chunkIndex }) => chunkIndex === 0);
  const zeroStart = chunkZero === undefined ? null : firstSampleTimestamp(chunkZero.content);
  const completionStart = completion === null
    ? null
    : stringField(completion.content, "windowStartTimestamp");
  if (zeroStart === null && completionStart === null) {
    return null;
  }

  const counts = countSamples(ordered);
  const base = {
    receivedChunkCount: ordered.length,
    receivedSampleCount: counts.total,
    phaseSampleCounts: counts.phases,
    windowStartTimestamp: zeroStart ?? completionStart!,
    completionContentSha256: completion?.contentSha256 ?? null,
  };
  if (zeroStart !== null && completionStart !== null &&
      normalizeRfc3339Instant(zeroStart) !== normalizeRfc3339Instant(completionStart)) {
    return quarantined(base, completion, "AUTHORITATIVE_START_MISMATCH");
  }
  if (completion === null) {
    return {
      ...base,
      projectionState: "GROWING",
      deliveryState: "RECEIVING",
      terminalState: null,
      expectedChunkCount: null,
      windowSha256: null,
      inconsistencyReason: null,
    };
  }

  const expected = numberField(completion.content, "totalChunks");
  const expectedSamples = numberField(completion.content, "totalSamples");
  const expectedDigests = stringArray(completion.content, "chunkContentSha256");
  const expectedPhases = phaseCounts(completion.content.phaseSampleCounts);
  const impossibleChunk = ordered.some(({ chunkIndex, content }) => {
    const firstSampleIndex = numberField(content, "firstSampleIndex");
    const samples = content.samples;
    return chunkIndex < 0 || chunkIndex >= expected || firstSampleIndex < 0 ||
      !Array.isArray(samples) || firstSampleIndex >= expectedSamples ||
      firstSampleIndex + samples.length > expectedSamples;
  });
  if (impossibleChunk) {
    return quarantined(base, completion, "COMBINED_WINDOW_INCONSISTENT");
  }
  const completeIndexSet =
    ordered.length === expected &&
    ordered.every(({ chunkIndex }, index) => chunkIndex === index);
  if (!completeIndexSet) {
    if (ordered.length >= expected) {
      return quarantined(base, completion, "COMBINED_WINDOW_INCONSISTENT");
    }
    return {
      ...base,
      projectionState: "PARTIAL",
      deliveryState: "DELAYED",
      terminalState: null,
      expectedChunkCount: expected,
      windowSha256: null,
      inconsistencyReason: null,
    };
  }

  const actualDigests = ordered.map(({ contentSha256 }) => contentSha256);
  const expectedWindow = stringField(completion.content, "windowSha256");
  const actualWindow = hashChunkDigests(actualDigests);
  const terminalState = stringField(completion.content, "terminalState");
  const reasonCode = stringField(completion.content, "reasonCode");
  const consistent =
    actualDigests.every((digest, index) => digest === expectedDigests[index]) &&
    counts.total === expectedSamples &&
    counts.phases.PRE === expectedPhases.PRE &&
    counts.phases.ACTIVE === expectedPhases.ACTIVE &&
    counts.phases.POST === expectedPhases.POST &&
    actualWindow === expectedWindow &&
    samplesAreContiguous(ordered) &&
    terminalReasonMatches(terminalState, reasonCode);
  if (!consistent) {
    return quarantined(base, completion, "COMBINED_WINDOW_INCONSISTENT");
  }
  return {
    ...base,
    projectionState: "TERMINAL",
    deliveryState: "DURABLY_RECEIVED",
    terminalState,
    expectedChunkCount: expected,
    windowSha256: expectedWindow,
    inconsistencyReason: null,
  };
}

function quarantined(
  base: Pick<WindowProjection, "receivedChunkCount" | "receivedSampleCount" | "phaseSampleCounts" | "windowStartTimestamp" | "completionContentSha256">,
  completion: WindowCompletionFact | null,
  reason: string,
): WindowProjection {
  return {
    ...base,
    projectionState: "QUARANTINED",
    deliveryState: "CONFLICT",
    terminalState: null,
    expectedChunkCount:
      completion === null ? null : numberField(completion.content, "totalChunks"),
    windowSha256: null,
    inconsistencyReason: reason,
  };
}

function countSamples(chunks: readonly WindowChunkFact[]): {
  total: number;
  phases: { PRE: number; ACTIVE: number; POST: number };
} {
  const phases = { PRE: 0, ACTIVE: 0, POST: 0 };
  let total = 0;
  for (const chunk of chunks) {
    const samples = chunk.content.samples;
    if (!Array.isArray(samples)) continue;
    total += samples.length;
    for (const sampleValue of samples) {
      if (typeof sampleValue !== "object" || sampleValue === null || Array.isArray(sampleValue)) continue;
      const phase = sampleValue.phase;
      if (phase === "PRE" || phase === "ACTIVE" || phase === "POST") phases[phase]++;
    }
  }
  return { total, phases };
}

function samplesAreContiguous(chunks: readonly WindowChunkFact[]): boolean {
  let expected = 0;
  for (const chunk of chunks) {
    if (numberField(chunk.content, "firstSampleIndex") !== expected) return false;
    const samples = chunk.content.samples;
    if (!Array.isArray(samples)) return false;
    for (const sample of samples) {
      if (typeof sample !== "object" || sample === null || Array.isArray(sample)) return false;
      if (sample.sampleIndex !== expected) return false;
      expected++;
    }
  }
  return true;
}

function firstSampleTimestamp(content: Readonly<Record<string, JsonValue>>): string | null {
  const samples = content.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const first = samples[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return null;
  return typeof first.sourceTimestamp === "string" ? first.sourceTimestamp : null;
}

function terminalReasonMatches(terminal: string, reason: string): boolean {
  return (
    (terminal === "COMPLETE" && reason === "NORMAL_CLEAR") ||
    (terminal === "TRUNCATED_MAX_DURATION" && reason === "MAX_ACTIVE_DURATION") ||
    (terminal === "INCOMPLETE_SOURCE_GAP" && reason === "SOURCE_GAP") ||
    (terminal === "ABORTED_SERVICE_STOP" && reason === "SERVICE_STOP") ||
    (terminal === "ABORTED_RESTART" && reason === "SERVICE_RESTART")
  );
}

function hashChunkDigests(digests: readonly string[]): string {
  const hash = createHash("sha256");
  for (const digest of digests) hash.update(Buffer.from(digest, "hex"));
  return hash.digest("hex");
}

function stringField(value: Readonly<Record<string, JsonValue>>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new TypeError(`${name} is not a string`);
  return field;
}

function numberField(value: Readonly<Record<string, JsonValue>>, name: string): number {
  const field = value[name];
  if (typeof field !== "number") throw new TypeError(`${name} is not a number`);
  return field;
}

function stringArray(value: Readonly<Record<string, JsonValue>>, name: string): readonly string[] {
  const field = value[name];
  if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} is not a string array`);
  }
  return field as string[];
}

function phaseCounts(value: JsonValue | undefined): { PRE: number; ACTIVE: number; POST: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("phaseSampleCounts is invalid");
  }
  return {
    PRE: numberField(value, "PRE"),
    ACTIVE: numberField(value, "ACTIVE"),
    POST: numberField(value, "POST"),
  };
}
