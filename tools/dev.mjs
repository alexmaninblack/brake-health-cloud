// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const root = fileURLToPath(new URL("..", import.meta.url));
const argumentsFromUser = process.argv.slice(2);
const viteArguments = [];

for (let index = 0; index < argumentsFromUser.length; index += 1) {
  const argument = argumentsFromUser[index];
  if (argument === "--host") {
    const host = argumentsFromUser[index + 1];
    if (host !== LOOPBACK_HOST) {
      throw new TypeError("development host must be 127.0.0.1");
    }
    index += 1;
  } else if (argument?.startsWith("--host=")) {
    if (argument.slice("--host=".length) !== LOOPBACK_HOST) {
      throw new TypeError("development host must be 127.0.0.1");
    }
  } else if (argument !== undefined) {
    viteArguments.push(argument);
  }
}

const compilation = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "-p",
    "apps/backend/tsconfig.build.json",
    "--pretty",
    "false",
  ],
  { cwd: root, stdio: "inherit" },
);
if (compilation.status !== 0) {
  process.exitCode = compilation.status ?? 1;
} else {
  const children = [
    spawn(process.execPath, ["out/backend/main.js"], {
      cwd: root,
      stdio: "inherit",
    }),
    spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--config",
        "apps/dashboard/vite.config.ts",
        "--host",
        LOOPBACK_HOST,
        ...viteArguments,
      ],
      { cwd: root, stdio: "inherit" },
    ),
  ];

  let stopping = false;
  function stop(exitCode = 0) {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exitCode = exitCode;
  }

  for (const child of children) {
    child.once("error", () => stop(1));
    child.once("exit", (code, signal) => {
      if (!stopping) {
        stop(signal === null && code === 0 ? 0 : 1);
      }
    });
  }
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
}
