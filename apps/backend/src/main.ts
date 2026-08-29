// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { ADMIN_SOCKET_PATH, LOOPBACK_HOST, startBackend } from "./server.js";

export async function main(): Promise<void> {
  const application = await startBackend({
    adminSocketPath: ADMIN_SOCKET_PATH,
    host: LOOPBACK_HOST,
    port: 4300,
  });
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
