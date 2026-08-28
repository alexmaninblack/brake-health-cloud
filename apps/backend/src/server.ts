// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applyMigrations,
  loadMigrations,
  MigrationError,
} from "./migrations.js";

export const LOOPBACK_HOST = "127.0.0.1";

export type ReadinessReason =
  | "READY"
  | "DATABASE_UNAVAILABLE"
  | "MIGRATION_FAILED"
  | "UNKNOWN_NEWER_SCHEMA";

export interface BackendOptions {
  readonly databasePath?: string;
  readonly host?: typeof LOOPBACK_HOST;
  readonly migrationsDirectory?: string;
  readonly now?: () => string;
  readonly port?: number;
}

export interface BackendApplication {
  readonly databasePath: string;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly readiness: () => {
    readonly ready: boolean;
    readonly reason: ReadinessReason;
    readonly schemaVersion: number | null;
  };
  readonly shutdown: () => Promise<void>;
}

interface MutableReadiness {
  ready: boolean;
  reason: ReadinessReason;
  schemaVersion: number | null;
}

export async function startBackend(
  options: BackendOptions = {},
): Promise<BackendApplication> {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new TypeError("backend host must be 127.0.0.1");
  }
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("backend port is invalid");
  }
  const ownedDirectory =
    options.databasePath === undefined
      ? mkdtempSync(join(tmpdir(), "brake-health-cloud-"))
      : undefined;
  const databasePath = options.databasePath ?? join(ownedDirectory!, "foundation.db");
  const migrationsDirectory =
    options.migrationsDirectory ?? resolve(process.cwd(), "migrations");
  const readiness: MutableReadiness = {
    ready: false,
    reason: "DATABASE_UNAVAILABLE",
    schemaVersion: null,
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    const schemaVersion = applyMigrations(
      database,
      loadMigrations(migrationsDirectory),
      (options.now ?? (() => new Date().toISOString()))(),
    );
    readiness.ready = true;
    readiness.reason = "READY";
    readiness.schemaVersion = schemaVersion;
  } catch (error) {
    database?.close();
    database = undefined;
    readiness.reason =
      error instanceof MigrationError && error.code === "UNKNOWN_NEWER_SCHEMA"
        ? "UNKNOWN_NEWER_SCHEMA"
        : error instanceof MigrationError
          ? "MIGRATION_FAILED"
          : "DATABASE_UNAVAILABLE";
  }

  const server = createHealthServer(readiness);
  await listen(server, host, requestedPort);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    database?.close();
    cleanup(ownedDirectory);
    throw new Error("backend listener address is unavailable");
  }
  let stopped = false;
  return {
    databasePath,
    host,
    port: address.port,
    readiness: () => ({ ...readiness }),
    shutdown: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await closeServer(server);
      database?.close();
      cleanup(ownedDirectory);
    },
  };
}

function createHealthServer(readiness: MutableReadiness): Server {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health/live") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "LIVE" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.statusCode = readiness.ready ? 200 : 503;
      response.end(
        JSON.stringify({
          ready: readiness.ready,
          reason: readiness.reason,
          schemaVersion: readiness.schemaVersion,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

function cleanup(directory: string | undefined): void {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
}
