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
    assert.equal(applyMigrations(first, migrations, deterministicNow()), 1);
    first.close();

    const reopened = new DatabaseSync(databasePath);
    assert.equal(applyMigrations(reopened, migrations, deterministicNow()), 1);
    const row = reopened
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get();
    assert.equal(row.count, 1);
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
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
    schemaVersion: 1,
  });
  assert.deepEqual(await getJson(application.port, "/health/live"), {
    body: { status: "LIVE" },
    contentType: "application/json; charset=utf-8",
    status: 200,
  });
  assert.deepEqual(await getJson(application.port, "/health/ready"), {
    body: { ready: true, reason: "READY", schemaVersion: 1 },
    contentType: "application/json; charset=utf-8",
    status: 200,
  });
  assert.deepEqual(await getJson(application.port, "/not-an-api"), {
    body: { error: "NOT_FOUND" },
    contentType: "application/json; charset=utf-8",
    status: 404,
  });
  await assert.rejects(
    startBackend({ host: "0.0.0.0" }),
    /backend host must be 127\.0\.0\.1/,
  );
});

test("an unknown newer schema blocks readiness but not liveness", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "brake-cloud-newer-"));
  const databasePath = join(directory, "newer.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA user_version = 2");
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
