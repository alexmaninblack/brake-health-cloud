// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const exactDependencies = {
  dependencies: {
    react: "19.2.8",
    "react-dom": "19.2.8",
  },
  devDependencies: {
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.6",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "@vitejs/plugin-react": "6.1.1",
    jsdom: "30.0.1",
    typescript: "7.0.2",
    vite: "8.2.2",
    vitest: "4.1.11",
  },
};

const failures = [];
function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

check(process.version === "v26.0.0", `Node must be v26.0.0, got ${process.version}`);
const npmVersion = command("npm", ["--version"]).trim();
check(npmVersion === "11.12.1", `npm must be 11.12.1, got ${npmVersion}`);

const manifest = json("package.json");
for (const [section, expected] of Object.entries(exactDependencies)) {
  check(
    JSON.stringify(manifest[section]) === JSON.stringify(expected),
    `${section} must contain only the frozen exact registry versions`,
  );
  for (const value of Object.values(manifest[section] ?? {})) {
    check(!String(value).startsWith("^") && !String(value).startsWith("~"), `${section} contains a version range`);
  }
}
check(manifest.engines?.node === "26.0.0", "Node engine must be exact");
check(manifest.engines?.npm === "11.12.1", "npm engine must be exact");

const lock = json("package-lock.json");
check(lock.lockfileVersion === 3, "package-lock.json must use lockfile v3");
check(lock.name === manifest.name && lock.version === manifest.version, "lockfile identity must match package.json");
for (const section of Object.keys(exactDependencies)) {
  check(
    JSON.stringify(lock.packages?.[""]?.[section]) ===
      JSON.stringify(exactDependencies[section]),
    `lockfile root ${section} must match package.json exactly`,
  );
}

const statusPaths = changedPaths();
for (const path of statusPaths) {
  check(isWritablePath(path), `changed path is outside the packet boundary: ${path}`);
}
check(!statusPaths.includes("LICENSE"), "the existing LICENSE must remain unchanged");

const tracked = command("git", ["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
for (const path of tracked) {
  check(!isGeneratedOrDeployment(path), `forbidden generated/deployment path is tracked: ${path}`);
  check(!isCredentialFilename(path), `credential-like file is tracked: ${path}`);
}

const inspectable = command("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean)
  .filter((path) => path !== "LICENSE" && path !== "package-lock.json");
const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
const secretPatterns = [
  ["AK", "IA"].join("") + "[0-9A-Z]{16}",
  privateKeyMarker,
  "(?:password|secret|token)\\s*[:=]\\s*['\"][^'\"]+['\"]",
];
for (const path of inspectable) {
  const text = readFileSync(path, "utf8");
  if (requiresSpdx(path)) {
    check(
      text.includes("SPDX-FileCopyrightText:") && text.includes("SPDX-License-Identifier:"),
      `SPDX header is missing: ${path}`,
    );
  }
  for (const pattern of secretPatterns) {
    check(!new RegExp(pattern, "i").test(text), `secret-like content found: ${path}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`quality: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("quality: exact toolchain, dependencies, boundary, licensing, secret-negative and artifact checks passed\n");
}

function command(executable, argumentsList) {
  return execFileSync(executable, argumentsList, {
    cwd: root,
    encoding: "utf8",
  });
}

function json(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function changedPaths() {
  return command("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

function isWritablePath(path) {
  return (
    [
      ".gitignore",
      ".npmrc",
      "CONTRIBUTING.md",
      "NOTICE",
      "README.md",
      "REUSE.toml",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "package-lock.json",
      "package.json",
      "tsconfig.json",
      "Dockerfile",
      ".dockerignore",
      "container-build.json",
    ].includes(path) ||
    path.startsWith("LICENSES/") ||
    path.startsWith("apps/backend/") ||
    path.startsWith("apps/dashboard/") ||
    path.startsWith("migrations/") ||
    path.startsWith("packages/contracts/") ||
    path.startsWith("packages/domain/") ||
    path.startsWith("packages/test-support/") ||
    path.startsWith("tests/") ||
    path.startsWith("tools/") ||
    /^tsconfig[^/]*\.json$/.test(path)
  );
}

function isGeneratedOrDeployment(path) {
  return (
    path.startsWith("deploy/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("out/") ||
    path.startsWith("coverage/") ||
    (path !== "Dockerfile" && /(^|\/)(Dockerfile|compose\.ya?ml)$/.test(path)) ||
    [".class", ".dll", ".dylib", ".exe", ".o", ".so", ".wasm"].includes(extname(path))
  );
}

function isCredentialFilename(path) {
  return (
    /(^|\/)\.env(?:\.|$)/.test(path) ||
    [".cer", ".crt", ".key", ".p12", ".pem", ".pfx"].includes(extname(path))
  );
}

function requiresSpdx(path) {
  return (
    path !== "REUSE.toml" &&
    !path.endsWith("package-lock.json") &&
    [
      "",
      ".css",
      ".html",
      ".js",
      ".json",
      ".md",
      ".mjs",
      ".sql",
      ".toml",
      ".ts",
      ".tsx",
      ".txt",
    ].includes(extname(path))
  );
}
