// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "node:http";

import { parseJsonRejectDuplicates } from "./brake-data-contract.js";
import type { CurrentUnitContext } from "./brake-data-http.js";
import { ADMIN_SOCKET_PATH, CONTAINER_ADMIN_SOCKET_PATH, LOOPBACK_HOST, startBackend, type BackendOptions } from "./server.js";

/** Existing composition root: only Demo Control supplies the owned file paths. */
export function backendOptionsFromArguments(args: readonly string[]): BackendOptions {
  const values = new Map<string, string>();
  const allowed = ["--port", "--database-path", "--admin-socket-path", "--context-path", "--migrations-directory", "--runtime-mode"];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(name) || values.has(name) || value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new TypeError("backend arguments require unique supported flags and nonempty values");
    }
    values.set(name, value);
  }
  const portText = values.get("--port") ?? "4300";
  const port = Number(portText);
  if (!/^[0-9]+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("backend port is invalid");
  }
  const contextPath = values.has("--context-path") ? resolve(values.get("--context-path")!) : undefined;
  const runtimeMode = values.get("--runtime-mode") ?? "native";
  if (runtimeMode !== "native" && runtimeMode !== "container") throw new TypeError("backend runtime mode is invalid");
  if (runtimeMode === "container" && (!values.has("--database-path") || !values.has("--context-path"))) {
    throw new TypeError("container runtime requires explicit persistent database and context paths");
  }
  return {
    host: LOOPBACK_HOST,
    runtimeMode,
    port,
    adminSocketPath: values.has("--admin-socket-path") ? resolve(values.get("--admin-socket-path")!) : ADMIN_SOCKET_PATH,
    ...(values.has("--database-path") ? { databasePath: resolve(values.get("--database-path")!) } : {}),
    ...(values.has("--migrations-directory") ? { migrationsDirectory: resolve(values.get("--migrations-directory")!) } : {}),
    ...(contextPath === undefined ? {} : {
      currentUnitContext: (): CurrentUnitContext | undefined => {
        try {
          const raw = readFileSync(contextPath, "utf8");
          if (Buffer.byteLength(raw, "utf8") > 4_096) return undefined;
          return parseJsonRejectDuplicates(raw) as unknown as CurrentUnitContext;
        } catch {
          return undefined;
        }
      },
    }),
  };
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--admin-operation") {
    if (args.length !== 2 || (args[1] !== "preview" && args[1] !== "execute")) {
      throw new TypeError("admin operation must be preview or execute");
    }
    const input = await readAdminInput();
    const result = await adminOperation(args[1], input);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.status >= 200 && result.status < 300 ? 0 : 1;
    return;
  }
  const application = await startBackend(backendOptionsFromArguments(args));
  process.stdout.write(
    `Brake Cloud data backend listening on ${application.host}:${application.port}\n`,
  );
  const stop = (): void => {
    void application.shutdown().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Private orchestration transport; the CLI never accepts a URL or HTTP method. */
export function adminOperation(operation: "preview" | "execute", body: string, socketPath = CONTAINER_ADMIN_SOCKET_PATH): Promise<{status: number; body: unknown}> {
  if (operation !== "preview" && operation !== "execute") throw new TypeError("admin operation is invalid");
  if (Buffer.byteLength(body, "utf8") > 4096) throw new TypeError("admin input is too large");
  parseJsonRejectDuplicates(body);
  const path = operation === "preview" ? "/api/v1/brake/admin/current-run/cleanup-preview" : "/api/v1/brake/admin/current-run/cleanup";
  return new Promise((resolveResult, reject) => {
    const connection = request({ socketPath, path, method: "POST", headers: {"content-type": "application/json", "content-length": String(Buffer.byteLength(body))} }, (response) => {
      let bytes = "";
      response.on("data", (chunk) => {
        bytes += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(bytes) > 16384) connection.destroy(new Error("admin response is too large"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolveResult({status: response.statusCode ?? 503, body: parseJsonRejectDuplicates(bytes)}); }
        catch { reject(new Error("admin response is invalid")); }
      });
    });
    connection.setTimeout(10000, () => connection.destroy(new Error("admin request timed out")));
    connection.on("error", reject);
    connection.end(body);
  });
}

function readAdminInput(): Promise<string> {
  return new Promise((resolveInput, reject) => {
    let body = "";
    process.stdin.on("data", (chunk) => {
      body += Buffer.from(chunk).toString("utf8");
      if (Buffer.byteLength(body) > 4096) { process.stdin.destroy(); reject(new Error("admin input is too large")); }
    });
    process.stdin.on("end", () => resolveInput(body));
    process.stdin.on("error", reject);
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
