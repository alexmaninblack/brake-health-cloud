// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {request} from "node:http";
import {parseBrakeMessage, canonicalize, sha256Hex} from "../../../out/backend/brake-data-contract.js";
import {BrakeDataStore} from "../../../out/backend/brake-data-store.js";
import {applyMigrations, loadMigrations, validateDatabaseSchema} from "../../../out/backend/migrations.js";
import {startBackend} from "../../../out/backend/server.js";

const names = ["brake-telemetry-window-chunk", "brake-telemetry-window-completion", "brake-health-assessment", "brake-health-event", "brake-advisory-fact"];
const migrations = loadMigrations(fileURLToPath(new URL("../../../migrations", import.meta.url)));
const now = "2026-09-11T12:00:00.000Z";
const parse = value => parseBrakeMessage(JSON.stringify(value));
function fixture(index = 0) {
  const value = JSON.parse(readFileSync(new URL(`./fixtures/${names[index]}.v2.valid.json`, import.meta.url)));
  delete value.$comment;
  return value;
}
function legacy(index) {
  const value = fixture(index);
  delete value.serviceInstance;
  value.schemaVersion = 1; value.contractVersion = "1.0.0"; value.serviceVersion = "3.0.0";
  // Synthetic legacy fixture values, never emitted by a new producer.
  value.serviceArtifactSha256 = "1".repeat(64);
  if (index === 2) value.modelArtifactSha256 = "2".repeat(64);
  return value;
}
function withStore(callback) {
  const db = new DatabaseSync(":memory:");
  try {applyMigrations(db, migrations, now); callback(new BrakeDataStore(db), db);}
  finally {db.close();}
}

test("all native products accept monotonic release 18 without fabricated artifact fields", () => withStore((store, db) => {
  for (let index = 0; index < names.length; index++) {
    const value = fixture(index), parsed = parse(value);
    const first = store.ingest(parsed, now), again = store.ingest(parsed, "2026-09-11T12:01:00.000Z");
    assert.equal(first.httpStatus, 201); assert.equal(again.httpStatus, 200);
    assert.equal(first.acknowledgement.receiptId, again.acknowledgement.receiptId);
    assert.equal(first.acknowledgement.receivedAt, again.acknowledgement.receivedAt);
    assert.equal(again.acknowledgement.schemaVersion, 1);
    const row = db.prepare("SELECT canonical_message FROM messages WHERE message_type=?").get(value.messageType);
    assert.equal(row.canonical_message, canonicalize(value));
    assert.equal(Object.hasOwn(JSON.parse(row.canonical_message), "serviceArtifactSha256"), false);
  }
  const window = store.query("WINDOW", fixture().unitSystemUid, 10, null).items[0];
  assert.equal(window.messageSchemaVersion, 2);
  assert.equal(canonicalize(window.serviceInstance), canonicalize(fixture().serviceInstance));
  assert.equal(Object.hasOwn(window, "serviceArtifactSha256"), false);
  for (const table of ["windows", "assessments", "condition_events"]) {
    const row = db.prepare(`SELECT service_artifact_sha256, service_instance_json FROM ${table}`).get();
    assert.equal(row.service_artifact_sha256, null);
    assert.equal(row.service_instance_json, canonicalize(fixture().serviceInstance));
  }
}));

test("native identity, revision, version and forbidden provenance fail closed for every family", () => {
  for (let index = 0; index < names.length; index++) {
    const original = fixture(index);
    const mutations = [
      m => {delete m.serviceInstance;}, m => {m.serviceInstance = null;},
      m => {m.contractVersion = "1.0.0";}, m => {m.schemaVersion = 3;},
      m => {m.serviceArtifactSha256 = null;}, m => {m.serviceArtifactSha256 = "0".repeat(64);},
      m => {m.modelArtifactSha256 = "0".repeat(64);}, m => {m.unitSystemUid = "bad\n";},
      ...["serviceId", "subjectId", "instanceId"].flatMap(key => [
        m => {delete m.serviceInstance[key];}, m => {m.serviceInstance[key] = "";},
        m => {m.serviceInstance[key] = "../x";}, m => {m.serviceInstance[key] = "x".repeat(129);},
        m => {m.serviceInstance[key] = "x\n";},
      ]),
      ...[-1, 0.1, "0", null, Number.MAX_SAFE_INTEGER + 1].map(value => m => {m.serviceInstance.instanceIndex = value;}),
      ...["01.0.0", "1.0", "1.0.0-dev", "1.0.0+build", "1.0.0\n", "1".repeat(33) + ".0.0"].map(value => m => {m.serviceVersion = value;}),
      m => {m.serviceInstance.extra = true;}, m => {m.contentSha256 = "0".repeat(64);},
    ];
    for (const mutate of mutations) {const candidate = structuredClone(original); mutate(candidate); assert.throws(() => parse(candidate));}
    if (index >= 2) assert.throws(() => parse({...legacy(index), serviceVersion: "18.0.0"}), /serviceVersion/);
  }
});

test("same key with changed native identity is quarantined, never treated as a new receipt", () => withStore((store, db) => {
  const original = fixture(4), accepted = store.ingest(parse(original), now);
  for (const key of ["serviceId", "subjectId", "instanceIndex", "instanceId"]) {
    const changed = structuredClone(original);
    changed.serviceInstance[key] = key === "instanceIndex" ? 1 : "different";
    assert.equal(store.ingest(parse(changed), now).httpStatus, 409);
  }
  assert.equal(store.ingest(parse(legacy(4)), now).httpStatus, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
  assert.equal(db.prepare("SELECT receipt_id FROM receipts").get().receipt_id, accepted.acknowledgement.receiptId);
  assert.equal(db.prepare("SELECT canonical_message FROM messages").get().canonical_message, canonicalize(original));
}));

test("assessment/event joins require the same revision and complete native identity", () => {
  for (const mismatch of [null, "serviceId", "subjectId", "instanceIndex", "instanceId", "serviceVersion", "legacy"]) withStore(store => {
    const assessment = fixture(2), event = mismatch === "legacy" ? legacy(3) : fixture(3);
    event.assessmentId = assessment.assessmentId; event.sourceEventId = assessment.sourceEventId;
    event.modelConfigSha256 = assessment.modelConfigSha256;
    if (mismatch === "serviceVersion") event.serviceVersion = "19.0.0";
    else if (mismatch && mismatch !== "legacy") event.serviceInstance[mismatch] = mismatch === "instanceIndex" ? 1 : "another";
    store.ingest(parse(event), now);
    assert.equal(store.query("EVENT", event.unitSystemUid, 10, null).items[0].vdpProvenanceState, "PENDING_ASSESSMENT_CORRELATION");
    store.ingest(parse(assessment), now);
    const observed = store.query("EVENT", event.unitSystemUid, 10, null).items[0];
    assert.equal(observed.vdpProvenanceState, mismatch ? "PENDING_ASSESSMENT_CORRELATION" : "CORRELATED_ASSESSMENT");
    assert.equal(observed.vdpContractSha256, mismatch ? null : assessment.vdpContractSha256);
  });
});

test("window chunks and completion cannot mix native identities or wire revisions", () => {
  for (const mismatch of ["instanceId", "subjectId", "serviceId", "instanceIndex", "revision"]) withStore((store, db) => {
    const first = fixture(), next = structuredClone(first);
    next.content.chunkIndex = 1; next.content.firstSampleIndex = 10;
    next.content.samples = next.content.samples.map((s, i) => ({...s, sampleIndex: 10 + i}));
    next.content.sampleCount = next.content.samples.length;
    if (mismatch === "revision") {
      next.schemaVersion = 1; next.contractVersion = "1.0.0"; delete next.serviceInstance;
      next.serviceArtifactSha256 = "1".repeat(64);
    } else next.serviceInstance[mismatch] = mismatch === "instanceIndex" ? 1 : "another";
    next.contentSha256 = sha256Hex(canonicalize(next.content));
    store.ingest(parse(first), now); store.ingest(parse(next), now);
    const observed = store.query("WINDOW", first.unitSystemUid, 10, null).items[0];
    assert.equal(observed.projectionState, "QUARANTINED");
    assert.equal(db.prepare("SELECT reason_code FROM quarantine").get().reason_code, "WINDOW_IDENTITY_METADATA_MISMATCH");
  });
});

test("forward migration preserves all legacy rows and receipts, and failure rolls back atomically", () => withStore((source, sourceDb) => {
  const legacyMessages = names.map((_, index) => legacy(index));
  for (const value of legacyMessages) source.ingest(parse(value), now);
  const oldDb = new DatabaseSync(":memory:");
  try {
    applyMigrations(oldDb, migrations.slice(0, 2), now);
    const tables = ["messages", "receipts", "window_chunks", "window_completions", "windows", "assessments", "condition_events", "advisory_facts", "quarantine"];
    const snapshots = [];
    for (const table of tables) {
      const columns = oldDb.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
      const rows = sourceDb.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all();
      const insert = oldDb.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...columns.map(c => row[c]));
      snapshots.push({table, columns, rows});
    }
    const failing = [...migrations.slice(0, 2), {...migrations[2], sql: migrations[2].sql + "\nSELECT * FROM injected_failure;"}];
    assert.throws(() => applyMigrations(oldDb, failing, now), /migration 003 failed/);
    assert.equal(oldDb.prepare("PRAGMA user_version").get().user_version, 2);
    const checkOriginal = () => {for (const {table, columns, rows} of snapshots) assert.deepEqual(oldDb.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all(), rows);};
    checkOriginal();
    assert.equal(applyMigrations(oldDb, migrations, now), 3);
    validateDatabaseSchema(oldDb, migrations); checkOriginal();
    assert.deepEqual(oldDb.prepare("PRAGMA foreign_key_check").all(), []);
    const migrated = new BrakeDataStore(oldDb);
    for (const message of legacyMessages) assert.equal(migrated.ingest(parse(message), now).httpStatus, 200);
    checkOriginal();
    assert.equal(migrated.ingest(parse(fixture(4)), now).httpStatus, 409);
  } finally {oldDb.close();}
}));

test("migration refuses unknown legacy columns before a rebuild can discard them", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrations(db, migrations.slice(0, 2), now);
    db.exec("ALTER TABLE windows ADD COLUMN unexpected_history TEXT");
    assert.throws(() => applyMigrations(db, migrations, now), /migration 003 failed/);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.ok(db.prepare("PRAGMA table_info(windows)").all().some(row => row.name === "unexpected_history"));
  } finally {db.close();}
});

test("HTTP native ingestion keeps ACK v1 while the mixed query envelope is explicitly v2", async () => {
  const message = fixture(4), context = {
    schemaVersion: 1, contractVersion: "1.0.0", source: "CURRENT_RUN_PROVISIONING_JOURNAL",
    testUnit: {systemUid: message.unitSystemUid, unitRole: "VALIDATION", userFacingRole: "Test Vehicle"},
  };
  const app = await startBackend({currentUnitContext: context, now: () => now});
  const call = (path, body) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${app.port}${path}`, {
      method: body ? "POST" : "GET", headers: body ? {"content-type": "application/json"} : {},
    }, response => {
      let bytes = ""; response.setEncoding("utf8"); response.on("data", chunk => {bytes += chunk;});
      response.on("end", () => {try {resolve({status: response.statusCode, body: JSON.parse(bytes)});} catch (error) {reject(error);}});
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const ack = await call("/api/v1/brake/messages", message);
    assert.equal(ack.status, 201); assert.equal(ack.body.schemaVersion, 1);
    const result = await call(`/api/v1/brake/units/${message.unitSystemUid}/advisories`);
    assert.equal(result.status, 200); assert.equal(result.body.schemaVersion, 2);
    assert.equal(result.body.contractVersion, "2.0.0");
    assert.equal(canonicalize(result.body.items[0].message), canonicalize(message));
  } finally {await app.shutdown();}
});
