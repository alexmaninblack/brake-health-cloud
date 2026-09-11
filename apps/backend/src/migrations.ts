// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class MigrationError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_MIGRATION_SET"
      | "MIGRATION_FAILED"
      | "SCHEMA_VALIDATION_FAILED"
      | "UNKNOWN_NEWER_SCHEMA",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export function loadMigrations(directory: string): readonly Migration[] {
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(name);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new MigrationError(
          "INVALID_MIGRATION_SET",
          "migration filename is invalid",
        );
      }
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        sql: readFileSync(join(directory, name), "utf8"),
      };
    });
  validateMigrationSet(migrations);
  return migrations;
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
  appliedAt: string,
): number {
  validateMigrationSet(migrations);
  const expectedVersion = migrations.length;
  const currentVersion = readSchemaVersion(database);
  if (currentVersion > expectedVersion) {
    throw new MigrationError(
      "UNKNOWN_NEWER_SCHEMA",
      "database schema is newer than this application",
    );
  }
  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (migration.version === 3 && migration.name === "native_service_provenance") {
        validateLegacyProjectionSource(database, migrations.slice(0, 2));
      }
      database.exec(migration.sql);
      const ledger = migrationLedger(database);
      database
        .prepare(
          `INSERT INTO ${ledger}(version, name, applied_at) VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, appliedAt);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      rollbackIfActive(database);
      throw new MigrationError(
        "MIGRATION_FAILED",
        `migration ${migration.version.toString().padStart(3, "0")} failed`,
        { cause: error },
      );
    }
  }
  return readSchemaVersion(database);
}

function rollbackIfActive(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // BEGIN itself may have failed because another serialized writer is active.
  }
}

function migrationLedger(database: DatabaseSync): "schema_migrations" | "schema_version" {
  const modern = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (modern !== undefined) {
    return "schema_version";
  }
  const legacy = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (legacy !== undefined) {
    return "schema_migrations";
  }
  throw new MigrationError(
    "INVALID_MIGRATION_SET",
    "migration did not provide a supported schema ledger",
  );
}

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  if (row === undefined || !Number.isSafeInteger(row.user_version)) {
    throw new MigrationError(
      "INVALID_MIGRATION_SET",
      "database schema version is invalid",
    );
  }
  return row.user_version;
}

export function validateDatabaseSchema(
  database: DatabaseSync,
  migrations: readonly Migration[],
): void {
  validateDatabaseSchemaInternal(database, migrations, true);
}

/** Recheck the packaged schema and integrity without writing to the source database. */
export function validateDatabaseSchemaReadOnly(
  database: DatabaseSync,
  migrations: readonly Migration[],
): void {
  validateDatabaseSchemaInternal(database, migrations, false);
}

function validateDatabaseSchemaInternal(
  database: DatabaseSync,
  migrations: readonly Migration[],
  probeWrites: boolean,
): void {
  try {
    if (migrations.length !== 3 || migrations[0]?.version !== 1 || migrations[0]?.name !== "initialize" ||
        migrations[1]?.version !== 2 || migrations[1]?.name !== "brake_data" || migrations[2]?.version !== 3 || migrations[2]?.name !== "native_service_provenance" || readSchemaVersion(database) !== 3) {
      throw new Error("application and database are not the exact v3 migration set");
    }
    const ledger = database
      .prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; name: string; applied_at: string }>;
    if (ledger.length !== 3 || ledger.some((row, index) =>
      row.version !== migrations[index]!.version || row.name !== migrations[index]!.name ||
      typeof row.applied_at !== "string" || row.applied_at.length === 0)) {
      throw new Error("schema_version ledger does not exactly match v3");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() !== undefined) {
      throw new Error("legacy migration ledger remains after v2 transition");
    }

    const reference = new DatabaseSync(":memory:");
    try {
      applyMigrations(reference, migrations, "1970-01-01T00:00:00.000Z");
      if (JSON.stringify(schemaManifest(database)) !== JSON.stringify(schemaManifest(reference))) {
        throw new Error("database schema does not exactly match packaged v3");
      }
    } finally {
      reference.close();
    }

    const integrity = database.prepare("PRAGMA integrity_check(1)").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("database integrity check failed");
    }
    if (probeWrites) probeReadWriteTransaction(database, ledger[1]!.applied_at);
  } catch (error) {
    if (error instanceof MigrationError && error.code === "SCHEMA_VALIDATION_FAILED") throw error;
    throw new MigrationError("SCHEMA_VALIDATION_FAILED", "database failed exact v3 readiness validation", { cause: error });
  }
}

/** Reject unknown legacy columns/objects before rebuilding any projection. */
function validateLegacyProjectionSource(database: DatabaseSync, legacy: readonly Migration[]): void {
  const reference = new DatabaseSync(":memory:");
  try {
    applyMigrations(reference, legacy, "1970-01-01T00:00:00.000Z");
    if (readSchemaVersion(database) !== 2 ||
        JSON.stringify(schemaManifest(database)) !== JSON.stringify(schemaManifest(reference))) {
      throw new Error("legacy database does not exactly match the packaged migration source");
    }
    const ledger = database.prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version").all() as Array<Record<string, unknown>>;
    if (ledger.length !== legacy.length || ledger.some((row, index) =>
      row.version !== legacy[index]!.version || row.name !== legacy[index]!.name ||
      typeof row.applied_at !== "string" || row.applied_at.length === 0)) {
      throw new Error("legacy migration ledger is not exact");
    }
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("legacy database contains inconsistent relationships");
    }
  } finally {reference.close();}
}

function schemaManifest(database: DatabaseSync): readonly Record<string, unknown>[] {
  return (database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master " +
      "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
}

function probeReadWriteTransaction(database: DatabaseSync, originalAppliedAt: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE schema_version SET applied_at = ? WHERE version = 2").run("__readiness_probe__");
    const probe = database.prepare("SELECT applied_at FROM schema_version WHERE version = 2").get() as
      | { applied_at: string }
      | undefined;
    if (probe?.applied_at !== "__readiness_probe__") throw new Error("transactional write/read probe failed");
    database.exec("ROLLBACK");
  } catch (error) {
    rollbackIfActive(database);
    throw error;
  }
  const restored = database.prepare("SELECT applied_at FROM schema_version WHERE version = 2").get() as
    | { applied_at: string }
    | undefined;
  if (restored?.applied_at !== originalAppliedAt) throw new Error("transactional probe rollback failed");
}

function validateMigrationSet(migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1 ||
      !/^[a-z0-9_]+$/.test(migration.name) ||
      migration.sql.trim().length === 0
    ) {
      throw new MigrationError(
        "INVALID_MIGRATION_SET",
        "migrations must be contiguous, named and non-empty",
      );
    }
  }
}
