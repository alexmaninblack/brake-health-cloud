// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoots = [
  "apps/backend/src",
  "apps/dashboard/src",
  "packages/contracts/src",
  "packages/domain/src",
  "packages/test-support/src",
] as const;

describe("architecture boundaries", () => {
  it("permits only public package edges between source layers", () => {
    const violations: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(join(root, sourceRoot))) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          if (specifier.startsWith(".")) {
            const target = resolve(file, "..", specifier);
            if (!target.startsWith(join(root, sourceRoot))) {
              violations.push(`${relative(root, file)} -> ${specifier}`);
            }
            continue;
          }
          if (!allowedImport(sourceRoot, specifier)) {
            violations.push(`${relative(root, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains no real browser network, cloud or publication adapter", () => {
    const violations: string[] = [];
    const forbiddenCode = [
      /\bfetch\s*\(/,
      /\bnew\s+WebSocket\b/,
      /\bnew\s+EventSource\b/,
      /\bXMLHttpRequest\b/,
      /\baxios\b/,
      /child_process/,
    ];
    for (const sourceRoot of sourceRoots.filter((path) => path !== "apps/backend/src")) {
      for (const file of sourceFiles(join(root, sourceRoot))) {
        const source = readFileSync(file, "utf8");
        if (forbiddenCode.some((pattern) => pattern.test(source))) {
          violations.push(relative(root, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no deployment, credential, Presenter-source or generated tree", () => {
    const paths = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(
      paths.filter(
        (path) =>
          path.startsWith("deploy/") ||
          path.startsWith("out/") ||
          /(^|\/)(Dockerfile|compose\.ya?ml)$/.test(path) ||
          /(^|\/)\.env(?:\.|$)/.test(path) ||
          /\.(?:crt|key|p12|pem|pfx)$/.test(path),
      ),
    ).toEqual([]);
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(join(root, sourceRoot))) {
        expect(readFileSync(file, "utf8")).not.toMatch(
          /aosedge-demo-interaction-mockup|Presenter UI source/,
        );
      }
    }
  });

  it("pins all default listener configuration to loopback", () => {
    const backend = readFileSync(join(root, "apps/backend/src/server.ts"), "utf8");
    const dashboard = readFileSync(
      join(root, "apps/dashboard/vite.config.ts"),
      "utf8",
    );
    const development = readFileSync(join(root, "tools/dev.mjs"), "utf8");
    expect(backend).toContain('LOOPBACK_HOST = "127.0.0.1"');
    expect(dashboard.match(/host: "127\.0\.0\.1"/g)).toHaveLength(2);
    expect(development).toContain('LOOPBACK_HOST = "127.0.0.1"');
    expect(`${backend}\n${dashboard}\n${development}`).not.toMatch(
      /(?:0\.0\.0\.0|::0|host:\s*true)/,
    );
  });
});

function allowedImport(sourceRoot: (typeof sourceRoots)[number], specifier: string): boolean {
  if (sourceRoot === "apps/backend/src") {
    return specifier.startsWith("node:");
  }
  if (sourceRoot === "apps/dashboard/src") {
    return (
      specifier === "react" ||
      specifier === "react-dom/client" ||
      specifier === "@brake-health/contracts" ||
      specifier === "@brake-health/domain" ||
      specifier === "@brake-health/test-support"
    );
  }
  if (sourceRoot === "packages/test-support/src") {
    return specifier === "@brake-health/contracts" || specifier === "vitest";
  }
  return specifier === "vitest";
}

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function sourceFiles(directory: string): readonly string[] {
  return allFiles(directory).filter((file) => [".ts", ".tsx"].includes(extname(file)));
}

function allFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...allFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
