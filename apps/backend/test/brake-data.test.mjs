// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalize, parseBrakeMessage, parseJsonRejectDuplicates, sha256Hex,
} from "../../../out/backend/brake-data-contract.js";
import { BrakeDataStore } from "../../../out/backend/brake-data-store.js";
import { applyMigrations, loadMigrations } from "../../../out/backend/migrations.js";
import { startBackend } from "../../../out/backend/server.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const TEST_UID = "test-system-20260829";
const PRODUCTION_UID = "production-system-20260829";
const SOURCE_EVENT = "4cba2d80-c04a-4d24-9f03-f4a85d56da13";
const ASSESSMENT = "59e854e8-596b-568b-8a18-12c44fb3a88c";
const NOW = "2026-08-29T12:00:01.000Z";

test("RFC8785 edge vectors and duplicate JSON keys are deterministic", () => {
  const unicode = parseJsonRejectDuplicates('{"€":"Euro Sign","\\r":"Carriage Return","דּ":"Hebrew Letter Dalet With Dagesh","1":"One","😀":"Emoji: Grinning Face","":"Control","ö":"Latin Small Letter O With Diaeresis"}');
  assert.equal(canonicalize(unicode), '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
  assert.equal(canonicalize(parseJsonRejectDuplicates("[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001]")), "[333333333.3333333,1e+30,4.5,0.002,1e-27]");
  assert.throws(() => parseJsonRejectDuplicates('{"unitSystemUid":"one","unitSystemUid":"two"}'), /duplicate JSON key/);
  assert.throws(() => parseJsonRejectDuplicates("true\u00a0"), /suffix/);
  assert.throws(() => canonicalize("\ud800"), /valid Unicode/);
});

test("conflicts quarantine without replacement and original receipt persists over restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-data-restart-"));
  const path = join(directory, "restart.db");
  try {
    let database = new DatabaseSync(path);
    applyMigrations(database, loadMigrations(migrationsDirectory), NOW);
    let store = new BrakeDataStore(database);
    const original = chunk(0);
    const accepted = store.ingest(parse(original), NOW);
    database.close();

    database = new DatabaseSync(path);
    store = new BrakeDataStore(database);
    const retry = store.ingest(parse(original), "2026-08-29T13:00:00.000Z");
    assert.equal(retry.httpStatus, 200);
    assert.equal(retry.acknowledgement.receiptId, accepted.acknowledgement.receiptId);
    const changedContent = structuredClone(original);
    changedContent.content.samples[0].brakePedalPercent = 61;
    const conflict = store.ingest(parse(digest(changedContent)), "2026-08-29T13:00:01.000Z");
    assert.equal(conflict.httpStatus, 409);
    const summary = store.recordSet([PRODUCTION_UID, TEST_UID].sort());
    assert.equal(summary.counts.messages, 1);
    assert.equal(summary.counts.quarantine, 1);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction, busy-writer and unavailable failures never leave partial data", () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-data-failure-"));
  const path = join(directory, "failure.db");
  try {
    const database = new DatabaseSync(path);
    applyMigrations(database, loadMigrations(migrationsDirectory), NOW);
    const store = new BrakeDataStore(database);
    database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => store.ingest(parse(advisory()), NOW), /injected/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
    database.exec("DROP TRIGGER fail_receipt");

    const competitor = new DatabaseSync(path);
    competitor.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    database.exec("PRAGMA busy_timeout = 0");
    assert.throws(() => store.ingest(parse(advisory()), NOW), /locked/);
    competitor.exec("ROLLBACK");
    competitor.close();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
    database.close();
    assert.throws(() => store.ingest(parse(advisory()), NOW));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact Unit identity isolates equal event IDs and start mismatch stays non-terminal", () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, loadMigrations(migrationsDirectory), NOW);
  const store = new BrakeDataStore(database);
  const testChunk = chunk(0);
  const productionChunk = digest({ ...testChunk, unitSystemUid: PRODUCTION_UID, unitRole: "PRODUCTION" });
  store.ingest(parse(testChunk), NOW);
  store.ingest(parse(productionChunk), NOW);
  assert.equal(store.query("WINDOW", TEST_UID, 50, null).items.length, 1);
  assert.equal(store.query("WINDOW", PRODUCTION_UID, 50, null).items.length, 1);
  const one = chunk(1);
  const badCompletion = completion(testChunk, one);
  badCompletion.content.windowStartTimestamp = "2026-08-29T12:00:00.010Z";
  store.ingest(parse(digest(badCompletion)), "2026-08-29T12:00:02.000Z");
  const projection = store.query("WINDOW", TEST_UID, 50, null).items[0];
  assert.equal(projection.projectionState, "QUARANTINED");
  assert.equal(projection.terminalState, null);
  database.close();
});

test("five frozen message families validate with exact content digests", () => {
  const first = chunk(0);
  const second = chunk(1);
  const messages = [first, completion(first, second), assessment(), event(), advisory()];
  assert.deepEqual(messages.map((value) => parseBrakeMessage(JSON.stringify(value)).messageType), [
    "WINDOW_CHUNK", "WINDOW_COMPLETION", "BRAKE_HEALTH_ASSESSMENT", "BRAKE_HEALTH_EVENT", "BRAKE_ADVISORY_FACT",
  ]);
  assert.equal(advisory().contentSha256, "56500a4db40505e7a1c03ba37830f03b9a406cb54db8e1a81790f907431e703a");
  assert.throws(
    () => parseBrakeMessage(JSON.stringify({ ...advisory(), contentSha256: "0".repeat(64) })),
    /contentSha256/,
  );
});

test("durable store withholds pre-start chunks, reaches terminal, correlates provenance and cleans atomically", () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, loadMigrations(migrationsDirectory), NOW);
  const store = new BrakeDataStore(database);
  const zero = chunk(0);
  const later = chunk(1);

  const laterAck = store.ingest(parse(later), NOW);
  assert.equal(laterAck.httpStatus, 201);
  assert.deepEqual(store.query("WINDOW", TEST_UID, 50, null).items, []);

  store.ingest(parse(completion(zero, later)), "2026-08-29T12:00:02.000Z");
  assert.equal(store.query("WINDOW", TEST_UID, 50, null).items[0].projectionState, "PARTIAL");
  const accepted = store.ingest(parse(zero), "2026-08-29T12:00:03.000Z");
  assert.equal(accepted.httpStatus, 201);
  const retry = store.ingest(parse(zero), "2026-08-29T12:59:59.000Z");
  assert.equal(retry.httpStatus, 200);
  assert.equal(retry.acknowledgement.receiptId, accepted.acknowledgement.receiptId);
  assert.equal(store.query("WINDOW", TEST_UID, 50, null).items[0].projectionState, "TERMINAL");

  store.ingest(parse(event()), "2026-08-29T12:00:04.000Z");
  let eventItem = store.query("EVENT", TEST_UID, 50, null).items[0];
  assert.equal(eventItem.vdpProvenanceState, "PENDING_ASSESSMENT_CORRELATION");
  assert.equal(eventItem.vdpContractVersion, null);
  store.ingest(parse(assessment()), "2026-08-29T12:00:05.000Z");
  eventItem = store.query("EVENT", TEST_UID, 50, null).items[0];
  assert.equal(eventItem.vdpProvenanceState, "CORRELATED_ASSESSMENT");
  assert.equal(eventItem.vdpContractVersion, "2.0.0");
  store.ingest(parse(advisory()), "2026-08-29T12:00:06.000Z");

  const historic = digest({ ...advisory(), unitSystemUid: "historic-system", unitRole: "PRODUCTION" });
  store.ingest(parse(historic), "2026-08-29T12:00:07.000Z");

  const selector = [PRODUCTION_UID, TEST_UID].sort();
  const complementBefore = store.recordSet(selector, false).sha256;
  const preview = store.recordSet(selector);
  assert.deepEqual(preview.counts, { messages: 6, windows: 1, assessments: 1, events: 1, advisories: 1, quarantine: 0 });
  const result = store.deleteMatching(selector, preview.sha256);
  assert.equal(result.stale, false);
  assert.deepEqual(result.remaining, { messages: 0, windows: 0, assessments: 0, events: 0, advisories: 0, quarantine: 0 });
  assert.equal(result.nonmatchingSha256, complementBefore);
  assert.equal(store.query("ADVISORY", "historic-system", 50, null).items.length, 1);
  database.close();
});

test("HTTP queries enforce current Unit scope and admin token errors preserve rows", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "brake-data-http-"));
  const socketPath = join(directory, "admin.sock");
  let clock = NOW;
  const application = await startBackend({
    adminSocketPath: socketPath,
    databasePath: join(directory, "data.db"),
    migrationsDirectory,
    cleanupHmacKey: Buffer.alloc(32, 7),
    currentUnitContext: currentContext(),
    now: () => clock,
  });
  context.after(async () => {
    await application.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  assert.equal((await http(application.port, "GET", `/api/v1/brake/units/${TEST_UID}/windows`)).status, 200);
  assert.equal((await http(application.port, "GET", "/api/v1/brake/units/not-current/windows")).status, 404);
  assert.equal((await http(application.port, "GET", `/api/v1/brake/units/${TEST_UID}/windows?cursor=bad`)).status, 400);
  assert.equal((await http(application.port, "POST", "/api/v1/brake/messages", "{duplicate:")).body.errorCode, "UNPROCESSABLE_MESSAGE");
  assert.equal((await http(application.port, "POST", "/api/v1/brake/messages", " ".repeat(131_073))).body.errorCode, "PAYLOAD_TOO_LARGE");

  const ingest = await http(application.port, "POST", "/api/v1/brake/messages", JSON.stringify(advisory()));
  assert.equal(ingest.status, 201);
  const secondAdvisory = digest({
    ...advisory(), requestId: "26223957-cdc3-57d4-af7d-74f78016ca0e", recordedAt: "2026-08-29T12:00:01.700Z",
  });
  assert.equal((await http(application.port, "POST", "/api/v1/brake/messages", JSON.stringify(secondAdvisory))).status, 201);
  const firstPage = await http(application.port, "GET", `/api/v1/brake/units/${TEST_UID}/advisories?limit=1`);
  assert.equal(firstPage.body.items.length, 1);
  assert.equal(firstPage.body.items[0].message.requestId, secondAdvisory.requestId);
  assert.equal(typeof firstPage.body.nextCursor, "string");
  const secondPage = await http(application.port, "GET", `/api/v1/brake/units/${TEST_UID}/advisories?limit=1&cursor=${firstPage.body.nextCursor}`);
  assert.equal(secondPage.body.items[0].message.requestId, advisory().requestId);
  assert.equal(
    (await http(application.port, "GET", `/api/v1/brake/units/${PRODUCTION_UID}/advisories?cursor=${firstPage.body.nextCursor}`)).body.errorCode,
    "INVALID_CURSOR",
  );

  const stream = openSse(application.port, TEST_UID);
  await stream.ready;
  assert.equal((await http(application.port, "POST", "/api/v1/brake/messages", JSON.stringify(event()))).status, 201);
  const wireEvent = await stream.event;
  assert.match(wireEvent, /^id: 1\nevent: brake-data-changed\ndata: /m);
  const sseData = JSON.parse(wireEvent.match(/data: (.+)\n/)[1]);
  assert.deepEqual(sseData.changedResources, ["EVENT"]);
  assert.equal("items" in sseData, false);
  const selector = [PRODUCTION_UID, TEST_UID].sort();
  const preview = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.contractVersion, "1.0.0");
  assert.ok(preview.body.confirmationToken.length <= 1024);
  const tooLong = "x".repeat(1025);
  const oversizedToken = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector, confirmationToken: tooLong,
  });
  assert.equal(oversizedToken.body.errorCode, "PREVIEW_TOKEN_EXPIRED");
  const exactLimit = "x".repeat(1024);
  assert.equal((await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector, confirmationToken: exactLimit,
  })).body.errorCode, "PREVIEW_TOKEN_EXPIRED");
  const unsorted = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: [...selector].reverse(),
  });
  assert.equal(unsorted.body.errorCode, "INVALID_REQUEST");
  for (const systemUids of [[], [selector[0]], [selector[0], selector[1], "third"], [selector[0], selector[0]]]) {
    const invalid = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids,
    });
    assert.equal(invalid.body.errorCode, "INVALID_REQUEST");
  }
  const forbiddenSelector = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector, demoRunId: "not-accepted",
  });
  assert.equal(forbiddenSelector.body.errorCode, "INVALID_REQUEST");
  const duplicateKeyAdmin = await requestJson(
    { socketPath, method: "POST", path: "/api/v1/brake/admin/current-run/cleanup-preview" },
    `{"schemaVersion":1,"schemaVersion":1,"contractVersion":"1.0.0","systemUids":${JSON.stringify(selector)}}`,
  );
  assert.equal(duplicateKeyAdmin.body.errorCode, "INVALID_REQUEST");
  const bad = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
    confirmationToken: corruptToken(preview.body.confirmationToken),
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.errorCode, "PREVIEW_TOKEN_EXPIRED");
  assert.equal((await http(application.port, "GET", `/api/v1/brake/units/${TEST_UID}/advisories`)).body.items.length, 2);
  clock = "2026-08-29T12:01:02.000Z";
  const expired = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
    confirmationToken: preview.body.confirmationToken,
  });
  assert.equal(expired.body.errorCode, "PREVIEW_TOKEN_EXPIRED");
  const stalePreview = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
  });
  assert.equal((await http(application.port, "POST", "/api/v1/brake/messages", JSON.stringify(assessment()))).status, 201);
  const stale = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
    confirmationToken: stalePreview.body.confirmationToken,
  });
  assert.equal(stale.body.errorCode, "PREVIEW_STALE");
  const currentPreview = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
  });
  const cleanup = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
    schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
    confirmationToken: currentPreview.body.confirmationToken,
  });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.remainingMatchingRecordCounts.messages, 0);
});

test("a backend restart invalidates the process-local cleanup preview token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-data-token-restart-"));
  const databasePath = join(directory, "restart.db");
  const socketPath = join(directory, "admin.sock");
  const selector = [PRODUCTION_UID, TEST_UID].sort();
  let application;
  try {
    application = await startBackend({
      adminSocketPath: socketPath, databasePath, migrationsDirectory,
      cleanupHmacKey: Buffer.alloc(32, 1), currentUnitContext: currentContext(), now: () => NOW,
    });
    const preview = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup-preview", {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
    });
    await application.shutdown();
    application = await startBackend({
      adminSocketPath: socketPath, databasePath, migrationsDirectory,
      cleanupHmacKey: Buffer.alloc(32, 2), currentUnitContext: currentContext(), now: () => NOW,
    });
    const result = await unix(socketPath, "/api/v1/brake/admin/current-run/cleanup", {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids: selector,
      confirmationToken: preview.body.confirmationToken,
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.errorCode, "PREVIEW_TOKEN_EXPIRED");
  } finally {
    await application?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

function base(messageType, serviceVersion = "1.0.0") {
  return {
    schemaVersion: 1, contractVersion: "1.0.0", messageType,
    unitSystemUid: TEST_UID, unitRole: "VALIDATION", serviceVersion,
    serviceArtifactSha256: serviceVersion === "2.0.0" ? "3".repeat(64) : "1".repeat(64),
  };
}

function chunk(index) {
  const content = {
    chunkIndex: index, firstSampleIndex: index, sampleCount: 1,
    samples: [{
      sampleIndex: index, sourceTimestamp: `2026-08-29T12:00:00.${index}00Z`,
      phase: index === 0 ? "PRE" : "ACTIVE", quality: "VALID_COMPLETE_FRAME", maxSourceAgeMs: 20,
      speedKph: 42 - index, longitudinalAccelerationMps2: index === 0 ? 0.1 : -3,
      lateralAccelerationMps2: 0, verticalAccelerationMps2: 0,
      acceleratorPedalPercent: 0, brakePedalPercent: 60,
    }],
  };
  return digest({
    ...base("WINDOW_CHUNK"), eventType: "HARD_BRAKING_EPISODE_V1", eventId: SOURCE_EVENT,
    vdpContractVersion: "1.0.0", vdpContractSha256: "2".repeat(64), content,
  });
}

function completion(zero, later) {
  const digests = [zero.contentSha256, later.contentSha256];
  const windowSha256 = createHash("sha256").update(Buffer.from(digests[0], "hex")).update(Buffer.from(digests[1], "hex")).digest("hex");
  return digest({
    ...base("WINDOW_COMPLETION"), eventType: "HARD_BRAKING_EPISODE_V1", eventId: SOURCE_EVENT,
    vdpContractVersion: "1.0.0", vdpContractSha256: "2".repeat(64),
    content: {
      terminalState: "ABORTED_SERVICE_STOP", reasonCode: "SERVICE_STOP",
      triggerTimestamp: "2026-08-29T12:00:00.100Z", windowStartTimestamp: "2026-08-29T12:00:00.000Z",
      windowEndTimestamp: "2026-08-29T12:00:00.100Z", phaseSampleCounts: { PRE: 1, ACTIVE: 1, POST: 0 },
      totalSamples: 2, totalChunks: 2, chunkContentSha256: digests, windowSha256,
    },
  });
}

function assessment() {
  return digest({
    ...base("BRAKE_HEALTH_ASSESSMENT", "2.0.0"), assessmentId: ASSESSMENT, sourceEventId: SOURCE_EVENT,
    vdpContractVersion: "2.0.0", vdpContractSha256: "2".repeat(64), modelId: "brake-condition-demo-v1",
    modelVersion: "1.0.0", modelArtifactSha256: "5".repeat(64), modelConfigSha256: "4".repeat(64),
    provenance: "DEMO_SYNTHETIC", assessedAt: "2026-08-29T12:00:00.600Z",
    content: {
      sourceWindowStartTimestamp: "2026-08-29T12:00:00.000Z", sourceWindowEndTimestamp: "2026-08-29T12:00:00.500Z",
      activeSampleCount: 30, straightActiveSampleCount: 30,
      features: { peakDecelerationMps2: 6.4, peakDecelerationBps: 8000, activeDurationSeconds: 3, activeDurationBps: 6000, speedReductionKph: 32, speedReductionBps: 8000, meanBrakeEffortPercent: 75, meanBrakeEffortBps: 5000, wheelDispersionRatio: 0.09, wheelDispersionBps: 6000 },
      episodeLoadBps: 6750, wearIndexBefore: 54, wearIncrement: 8, wearIndexAfter: 62,
      conditionScore: 38, previousBand: "MONITOR", currentBand: "INSPECTION_RECOMMENDED", quality: "VALID_DEMO_SYNTHETIC",
    },
  });
}

function event() {
  return digest({
    ...base("BRAKE_HEALTH_EVENT", "2.0.0"), eventId: "6b471c10-7ad6-530b-b5f4-d4b9f9107a8b",
    assessmentId: ASSESSMENT, sourceEventId: SOURCE_EVENT, modelId: "brake-condition-demo-v1", modelVersion: "1.0.0",
    modelConfigSha256: "4".repeat(64), provenance: "DEMO_SYNTHETIC",
    content: { eventType: "BRAKE_CONDITION_BAND_CHANGED", reasonCode: "SYNTHETIC_ACCUMULATED_STRESS_THRESHOLD", previousBand: "MONITOR", currentBand: "INSPECTION_RECOMMENDED", conditionScore: 38, effectiveAt: "2026-08-29T12:00:00.500Z", quality: "VALID_DEMO_SYNTHETIC" },
  });
}

function advisory() {
  return digest({
    ...base("BRAKE_ADVISORY_FACT", "3.0.0"), vdpContractVersion: "3.0.0", vdpContractSha256: "2".repeat(64),
    requestId: "16223957-cdc3-57d4-af7d-74f78016ca0e", producerEpoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: 1, gatewayState: "APPLIED", recordedAt: "2026-08-29T12:00:00.700Z",
    content: { decisionId: ASSESSMENT, operation: "SET", recommendation: "INSPECTION_RECOMMENDED", reasonCode: "PREDICTED_BRAKE_DEGRADATION", issuedAt: "2026-08-22T12:00:00.600Z", expiresAt: "2026-08-22T12:00:30.600Z", gatewayReason: "NONE", gatewayObservedAt: "2026-08-22T12:00:00.650Z", activeRecommendation: "INSPECTION_RECOMMENDED", activeReasonCode: "PREDICTED_BRAKE_DEGRADATION", activeUntil: "2026-08-22T12:00:30.600Z" },
  });
}

function digest(message) {
  return { ...message, contentSha256: sha256Hex(canonicalize(message.content)) };
}

function parse(message) {
  return parseBrakeMessage(JSON.stringify(message));
}

function currentContext() {
  return {
    schemaVersion: 1, contractVersion: "1.0.0", source: "CURRENT_RUN_PROVISIONING_JOURNAL",
    testUnit: { systemUid: TEST_UID, unitRole: "VALIDATION", userFacingRole: "Test Vehicle" },
    productionUnit: { systemUid: PRODUCTION_UID, unitRole: "PRODUCTION", userFacingRole: "Production Vehicle" },
  };
}

function http(port, method, path, body) {
  return requestJson({ host: "127.0.0.1", port, method, path }, body);
}

function unix(socketPath, path, body) {
  return requestJson({ socketPath, method: "POST", path }, JSON.stringify(body));
}

function requestJson(options, body) {
  return new Promise((resolvePromise, reject) => {
    const operation = request({ ...options, agent: false, headers: body === undefined ? {} : { "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolvePromise({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    operation.on("error", reject);
    if (body !== undefined) operation.write(body);
    operation.end();
  });
}

function corruptToken(value) {
  const parts = value.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  return parts.join(".");
}

function openSse(port, systemUid) {
  let readyResolve;
  let eventResolve;
  let rejectPromise;
  const ready = new Promise((resolvePromise, reject) => { readyResolve = resolvePromise; rejectPromise = reject; });
  const eventPromise = new Promise((resolvePromise, reject) => { eventResolve = resolvePromise; rejectPromise = reject; });
  const operation = request({ host: "127.0.0.1", port, method: "GET", path: `/api/v1/brake/stream?systemUid=${systemUid}` });
  operation.on("response", (response) => {
    readyResolve();
    let body = "";
    response.on("data", (chunkValue) => {
      body += chunkValue.toString("utf8");
      const marker = body.indexOf("id: ");
      if (marker >= 0 && body.includes("\n\n", marker)) {
        eventResolve(body.slice(marker, body.indexOf("\n\n", marker) + 2));
        response.destroy();
      }
    });
    response.on("error", rejectPromise);
  });
  operation.on("error", rejectPromise);
  operation.end();
  return { ready, event: eventPromise };
}
