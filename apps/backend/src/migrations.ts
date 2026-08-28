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
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, appliedAt);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new MigrationError(
        "MIGRATION_FAILED",
        `migration ${migration.version.toString().padStart(3, "0")} failed`,
        { cause: error },
      );
    }
  }
  return readSchemaVersion(database);
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
