// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseJsonRejectDuplicates } from "./brake-data-contract.js";
import type { CurrentUnitContext } from "./brake-data-http.js";
import { ADMIN_SOCKET_PATH, LOOPBACK_HOST, startBackend, type BackendOptions } from "./server.js";

/** Existing composition root: only Demo Control supplies the owned file paths. */
export function backendOptionsFromArguments(args: readonly string[]): BackendOptions {
  const values = new Map<string, string>();
  const allowed = ["--port", "--database-path", "--admin-socket-path", "--context-path", "--migrations-directory"];
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
  return {
    host: LOOPBACK_HOST,
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
  const application = await startBackend(backendOptionsFromArguments(process.argv.slice(2)));
  process.stdout.write(
    `Brake Cloud data backend listening on ${application.host}:${application.port}\n`,
  );
  const stop = (): void => {
    void application.shutdown().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
