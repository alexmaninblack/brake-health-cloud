// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  applyMigrations,
  loadMigrations,
  MigrationError,
  readSchemaVersion,
  validateSchemaV2,
} from "../../../out/backend/migrations.js";
import {
  LOOPBACK_HOST,
  startBackend,
} from "../../../out/backend/server.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const deterministicNow = () => "2026-08-28T12:00:00.000Z";

test("fresh and repeat migration application is deterministic", () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-cloud-migration-"));
  const databasePath = join(directory, "repeat.db");
  try {
    const migrations = loadMigrations(migrationsDirectory);
    const first = new DatabaseSync(databasePath);
    assert.equal(applyMigrations(first, migrations, deterministicNow()), 2);
    first.close();

    const reopened = new DatabaseSync(databasePath);
    assert.equal(applyMigrations(reopened, migrations, deterministicNow()), 2);
    const row = reopened
      .prepare("SELECT COUNT(*) AS count FROM schema_version")
      .get();
    assert.equal(row.count, 2);
    assert.deepEqual(
      reopened.prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version").all().map((value) => ({ ...value })),
      [
        { version: 1, name: "initialize", applied_at: deterministicNow() },
        { version: 2, name: "brake_data", applied_at: deterministicNow() },
      ],
    );
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined);
    validateSchemaV2(reopened, migrations);
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("exact v2 readiness rejects schema, ledger and transactional probe defects", async () => {
  const migrations = loadMigrations(migrationsDirectory);
  const queryOnly = new DatabaseSync(":memory:");
  applyMigrations(queryOnly, migrations, deterministicNow());
  queryOnly.exec("PRAGMA query_only = ON");
  assert.throws(
    () => validateSchemaV2(queryOnly, migrations),
    (error) => error instanceof MigrationError && error.code === "SCHEMA_VALIDATION_FAILED",
  );
  queryOnly.close();

  for (const corruption of [
    "DROP INDEX idx_events_unit_order",
    "UPDATE schema_version SET name = 'wrong' WHERE version = 2",
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "brake-cloud-invalid-v2-"));
    const databasePath = join(directory, "invalid.db");
    const database = new DatabaseSync(databasePath);
    applyMigrations(database, migrations, deterministicNow());
    database.exec(corruption);
    database.close();
    const application = await startBackend({ databasePath, migrationsDirectory, now: deterministicNow });
    try {
      assert.deepEqual(application.readiness(), {
        ready: false,
        reason: "MIGRATION_FAILED",
        schemaVersion: null,
      });
      assert.equal((await getJson(application.port, "/health/ready")).status, 503);
    } finally {
      await application.shutdown();
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("v1-to-v2 failure after legacy ledger drop rolls the whole migration back", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = loadMigrations(migrationsDirectory);
  assert.equal(applyMigrations(database, migrations.slice(0, 1), deterministicNow()), 1);
  const failing = [migrations[0], { ...migrations[1], sql: `${migrations[1].sql}\nSELECT * FROM injected_missing_table;` }];
  assert.throws(() => applyMigrations(database, failing, deterministicNow()), /migration 002 failed/);
  assert.equal(readSchemaVersion(database), 1);
  assert.notEqual(database.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_version'").get(), undefined);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get(), undefined);
  database.close();
});

test("a failed forward migration rolls back only its transaction", () => {
  const database = new DatabaseSync(":memory:");
  const initialSql = readFileSync(
    join(migrationsDirectory, "001_initialize.sql"),
    "utf8",
  );
  const migrations = [
    { version: 1, name: "initialize", sql: initialSql },
    {
      version: 2,
      name: "must_rollback",
      sql: "CREATE TABLE rolled_back(value TEXT); INSERT INTO missing_table VALUES (1);",
    },
  ];
  assert.throws(
    () => applyMigrations(database, migrations, deterministicNow()),
    (error) =>
      error instanceof MigrationError && error.code === "MIGRATION_FAILED",
  );
  assert.equal(readSchemaVersion(database), 1);
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'")
    .get();
  assert.equal(table, undefined);
  database.close();
});

test("health endpoints are closed, ready and loopback-only", async (context) => {
  const application = await startBackend({
    migrationsDirectory,
    now: deterministicNow,
  });
  context.after(async () => application.shutdown());

  assert.equal(application.host, LOOPBACK_HOST);
  assert.deepEqual(application.readiness(), {
    ready: true,
    reason: "READY",
    schemaVersion: 2,
  });
  assert.deepEqual(await getJson(application.port, "/health/live"), {
    body: { status: "LIVE" },
    contentType: "application/json; charset=utf-8",
    status: 200,
  });
  assert.deepEqual(await getJson(application.port, "/health/ready"), {
    body: { ready: true, reason: "READY", schemaVersion: 2 },
    contentType: "application/json; charset=utf-8",
    status: 200,
  });
  assert.deepEqual(await getJson(application.port, "/not-an-api"), {
    body: {
      schemaVersion: 1,
      contractVersion: "1.0.0",
      errorCode: "NOT_FOUND",
      message: "route was not found",
      retryable: false,
    },
    contentType: "application/json; charset=utf-8",
    status: 404,
  });
  assert.equal(
    (await getJson(application.port, "/api/v1/brake/units/test-system/windows")).body.errorCode,
    "CURRENT_UNIT_CONTEXT_UNAVAILABLE",
  );
  await assert.rejects(
    startBackend({ host: "0.0.0.0" }),
    /backend host must be 127\.0\.0\.1/,
  );
});

test("an unknown newer schema blocks readiness but not liveness", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "brake-cloud-newer-"));
  const databasePath = join(directory, "newer.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA user_version = 3");
  database.close();
  const application = await startBackend({
    databasePath,
    migrationsDirectory,
    now: deterministicNow,
  });
  context.after(async () => {
    await application.shutdown();
    rmSync(directory, { force: true, recursive: true });
  });

  assert.deepEqual(application.readiness(), {
    ready: false,
    reason: "UNKNOWN_NEWER_SCHEMA",
    schemaVersion: null,
  });
  assert.equal((await getJson(application.port, "/health/live")).status, 200);
  assert.deepEqual(await getJson(application.port, "/health/ready"), {
    body: {
      ready: false,
      reason: "UNKNOWN_NEWER_SCHEMA",
      schemaVersion: null,
    },
    contentType: "application/json; charset=utf-8",
    status: 503,
  });
});

test("an unrecoverable runtime storage error fails readiness and all later data access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-cloud-storage-loss-"));
  const databasePath = join(directory, "storage.db");
  const application = await startBackend({
    databasePath,
    migrationsDirectory,
    now: deterministicNow,
    currentUnitContext: {
      schemaVersion: 1,
      contractVersion: "1.0.0",
      source: "CURRENT_RUN_PROVISIONING_JOURNAL",
      testUnit: { systemUid: "test-system", unitRole: "VALIDATION", userFacingRole: "Test Vehicle" },
      productionUnit: { systemUid: "production-system", unitRole: "PRODUCTION", userFacingRole: "Production Vehicle" },
    },
  });
  try {
    const corruptor = new DatabaseSync(databasePath);
    corruptor.exec("DROP TABLE windows");
    corruptor.close();

    const failed = await getJson(application.port, "/api/v1/brake/units/test-system/windows");
    assert.equal(failed.status, 503);
    assert.equal(failed.body.errorCode, "TEMPORARILY_UNAVAILABLE");
    assert.deepEqual(application.readiness(), {
      ready: false,
      reason: "DATABASE_UNAVAILABLE",
      schemaVersion: 2,
    });
    assert.deepEqual((await getJson(application.port, "/health/ready")).body, {
      ready: false,
      reason: "DATABASE_UNAVAILABLE",
      schemaVersion: 2,
    });
    assert.equal((await getJson(application.port, "/api/v1/brake/units/test-system/windows")).status, 503);
  } finally {
    await application.shutdown();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("shutdown removes the owned temporary database directory", async () => {
  const application = await startBackend({
    migrationsDirectory,
    now: deterministicNow,
  });
  const ownedDirectory = dirname(application.databasePath);
  assert.equal(existsSync(application.databasePath), true);
  await application.shutdown();
  assert.equal(existsSync(ownedDirectory), false);
  await application.shutdown();
});

function getJson(port, path) {
  return new Promise((resolvePromise, reject) => {
    const operation = request(
      { host: LOOPBACK_HOST, method: "GET", path, port },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolvePromise({
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              contentType: response.headers["content-type"],
              status: response.statusCode,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    operation.on("error", reject);
    operation.end();
  });
}
