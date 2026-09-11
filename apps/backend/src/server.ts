// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BrakeDataHttp, type CurrentUnitContextInput, type QueryReadiness } from "./brake-data-http.js";
import { BrakeDataStore } from "./brake-data-store.js";
import { applyMigrations, loadMigrations, MigrationError, validateDatabaseSchema, validateDatabaseSchemaReadOnly } from "./migrations.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const CONTAINER_HOST = "0.0.0.0";
export type RuntimeMode = "native" | "container";
export const ADMIN_SOCKET_PATH = "/run/brake-health-cloud/admin.sock";
export const CONTAINER_ADMIN_SOCKET_PATH = "/tmp/demo-backend/admin.sock";

export type ReadinessReason =
  | "READY" | "DATABASE_UNAVAILABLE" | "MIGRATION_FAILED" | "UNKNOWN_NEWER_SCHEMA";

export interface BackendOptions {
  readonly databasePath?: string;
  readonly host?: typeof LOOPBACK_HOST;
  readonly runtimeMode?: RuntimeMode;
  readonly migrationsDirectory?: string;
  readonly currentUnitContext?: CurrentUnitContextInput;
  readonly adminSocketPath?: string;
  readonly cleanupHmacKey?: Uint8Array;
  readonly now?: () => string;
  readonly port?: number;
}

export interface BackendApplication {
  readonly adminSocketPath: string | null;
  readonly databasePath: string;
  readonly host: typeof LOOPBACK_HOST | typeof CONTAINER_HOST;
  readonly port: number;
  readonly readiness: () => {
    readonly ready: boolean;
    readonly reason: ReadinessReason;
    readonly schemaVersion: number | null;
  };
  readonly queryReadiness: () => QueryReadiness;
  readonly shutdown: () => Promise<void>;
}

interface MutableReadiness {
  ready: boolean;
  reason: ReadinessReason;
  schemaVersion: number | null;
}

export async function startBackend(options: BackendOptions = {}): Promise<BackendApplication> {
  if (options.host !== undefined && options.host !== LOOPBACK_HOST) throw new TypeError("backend host must be 127.0.0.1");
  if (options.runtimeMode !== undefined && options.runtimeMode !== "native" && options.runtimeMode !== "container") {
    throw new TypeError("backend runtime mode is invalid");
  }
  const host = options.runtimeMode === "container" ? CONTAINER_HOST : LOOPBACK_HOST;
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("backend port is invalid");
  }
  const ownedDirectory = options.databasePath === undefined || options.adminSocketPath === undefined
    ? mkdtempSync(join(tmpdir(), "brake-health-cloud-"))
    : undefined;
  const databasePath = options.databasePath ?? join(ownedDirectory!, "foundation.db");
  const adminSocketPath = options.adminSocketPath ?? join(ownedDirectory!, "admin.sock");
  const migrationsDirectory = options.migrationsDirectory ?? resolve(process.cwd(), "migrations");
  const now = options.now ?? (() => new Date().toISOString());
  const readiness: MutableReadiness = { ready: false, reason: "DATABASE_UNAVAILABLE", schemaVersion: null };
  let database: DatabaseSync | undefined;
  let dataHttp: BrakeDataHttp | undefined;
  let mockDatabase: DatabaseSync | undefined;
  let mockHttp: BrakeDataHttp | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    const migrations = loadMigrations(migrationsDirectory);
    const schemaVersion = applyMigrations(database, migrations, now());
    validateDatabaseSchema(database, migrations);
    const validatedDatabase = database;
    dataHttp = new BrakeDataHttp(
      new BrakeDataStore(database, () => validateDatabaseSchemaReadOnly(validatedDatabase, migrations)), options.currentUnitContext, now, options.cleanupHmacKey,
      () => {
        readiness.ready = false;
        readiness.reason = "DATABASE_UNAVAILABLE";
        readiness.schemaVersion = schemaVersion;
        dataHttp?.closeStreams();
      },
    );
    readiness.ready = true;
    readiness.reason = "READY";
    readiness.schemaVersion = schemaVersion;
  } catch (error) {
    database?.close();
    database = undefined;
    readiness.reason = error instanceof MigrationError && error.code === "UNKNOWN_NEWER_SCHEMA"
      ? "UNKNOWN_NEWER_SCHEMA"
      : error instanceof MigrationError ? "MIGRATION_FAILED" : "DATABASE_UNAVAILABLE";
  }

  // Mock transport uses the same validator/store in a separate owned database.
  // Failure of this diagnostic surface never replaces normal product storage.
  if (readiness.ready) {
    try {
      mockDatabase = new DatabaseSync(databasePath + ".demo-mock");
      mockDatabase.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const migrations = loadMigrations(migrationsDirectory);
      applyMigrations(mockDatabase, migrations, now()); validateDatabaseSchema(mockDatabase, migrations);
      const db = mockDatabase;
      const testContext = () => {
        if (!dataHttp?.queryReadiness().ready) return undefined;
        const context = typeof options.currentUnitContext === "function" ? options.currentUnitContext() : options.currentUnitContext;
        if (!context?.testUnit) return undefined;
        return {schemaVersion: context.schemaVersion, contractVersion: context.contractVersion, source: context.source, testUnit: context.testUnit};
      };
      mockHttp = new BrakeDataHttp(new BrakeDataStore(db, () => validateDatabaseSchemaReadOnly(db, migrations)), testContext, now, undefined, undefined, true);
    } catch { mockDatabase?.close(); mockDatabase = undefined; }
  }
  const queryReadiness = (): QueryReadiness => dataHttp?.queryReadiness() ?? {
    ready: false, reason: "TEMPORARILY_UNAVAILABLE", systemUids: [],
  };
  const publicServer = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.url?.startsWith("/api/v1/brake/demo-mock/")) {
      if (mockHttp) void mockHttp.handlePublic(request, response);
      else json(response, 503, {source: "DEMO_MOCK", vehicleTelemetry: false, errorCode: "MOCK_STORAGE_UNAVAILABLE"});
    } else if (request.method === "GET" && request.url === "/health/live") {
      json(response, 200, { status: "LIVE" });
    } else if (request.method === "GET" && request.url === "/health/ready") {
      json(response, readiness.ready ? 200 : 503, {
        ready: readiness.ready, reason: readiness.reason, schemaVersion: readiness.schemaVersion,
      });
    } else if (request.method === "GET" && request.url === "/health/context") {
      const context = queryReadiness();
      json(response, context.ready ? 200 : 503, context);
    } else if (dataHttp !== undefined && readiness.ready) {
      void dataHttp.handlePublic(request, response);
    } else {
      json(response, 503, {
        schemaVersion: 1, contractVersion: "1.0.0", errorCode: "TEMPORARILY_UNAVAILABLE",
        message: "data service is temporarily unavailable", retryable: true,
      });
    }
  });
  await listenTcp(publicServer, host, requestedPort);
  let adminServer: Server | undefined;
  if (dataHttp !== undefined) {
    rmSync(adminSocketPath, { force: true });
    adminServer = createServer((request, response) => {
      if (request.url?.startsWith("/api/v1/brake/demo-mock/admin/")) {
        if (mockHttp) void mockHttp.handleAdmin(request, response);
        else json(response, 503, {errorCode: "MOCK_STORAGE_UNAVAILABLE"});
      } else void dataHttp!.handleAdmin(request, response);
    });
    try {
      await listenUnix(adminServer, adminSocketPath);
      chmodSync(adminSocketPath, 0o600);
    } catch (error) {
      await closeServer(publicServer);
      database!.close();
      cleanup(ownedDirectory);
      throw error;
    }
  }
  const address = publicServer.address();
  if (address === null || typeof address === "string") {
    await closeServer(publicServer);
    if (adminServer !== undefined) await closeServer(adminServer);
    database?.close();
    cleanup(ownedDirectory);
    throw new Error("backend listener address is unavailable");
  }
  let stopped = false;
  return {
    adminSocketPath: adminServer === undefined ? null : adminSocketPath,
    databasePath, host, port: address.port,
    readiness: () => ({ ...readiness }),
    queryReadiness,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      dataHttp?.closeStreams();
      mockHttp?.closeStreams();
      await closeServer(publicServer);
      if (adminServer !== undefined) await closeServer(adminServer);
      database?.close();
      mockDatabase?.close();
      if (options.adminSocketPath !== undefined) rmSync(options.adminSocketPath, { force: true });
      cleanup(ownedDirectory);
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function listenTcp(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
}

function cleanup(directory: string | undefined): void {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
}
