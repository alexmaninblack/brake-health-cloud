// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { LOOPBACK_HOST, startBackend } from "./server.js";

export async function main(): Promise<void> {
  const application = await startBackend({ host: LOOPBACK_HOST, port: 4300 });
  process.stdout.write(
    `Brake Cloud foundation listening on ${application.host}:${application.port}\n`,
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
