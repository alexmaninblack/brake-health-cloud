// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {backendOptionsFromArguments, adminOperation} from "../../../out/backend/main.js";
import {startBackend} from "../../../out/backend/server.js";

test("container mode is explicit and requires owned persistence/context", () => {
  assert.equal(backendOptionsFromArguments([]).runtimeMode, "native");
  assert.throws(() => backendOptionsFromArguments(["--runtime-mode", "public"]));
  assert.throws(() => backendOptionsFromArguments(["--host", "0.0.0.0"]));
  assert.throws(() => backendOptionsFromArguments(["--runtime-mode", "container"]));
  const options = backendOptionsFromArguments(["--runtime-mode", "container", "--database-path", "/data/brake-health.sqlite", "--context-path", "/run/demo-control/context/current-unit-context.json"]);
  assert.equal(options.runtimeMode, "container");
});

test("fixed admin client carries only scoped cleanup JSON over private Unix socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brake-admin-client-"));
  const app = await startBackend({databasePath: join(directory, "data.sqlite"), adminSocketPath: join(directory, "admin.sock"), currentUnitContext: {
    schemaVersion: 1, contractVersion: "1.0.0", source: "CURRENT_RUN_PROVISIONING_JOURNAL",
    testUnit: {systemUid: "current-test", unitRole: "VALIDATION", userFacingRole: "Test Vehicle"}
  }});
  try {
    const selector = {schemaVersion: 1, contractVersion: "1.0.0", systemUids: ["current-test"]};
    const preview = await adminOperation("preview", JSON.stringify(selector), app.adminSocketPath);
    assert.equal(preview.status, 200);
    assert.ok(preview.body.confirmationToken);
    assert.throws(() => adminOperation("shell", "{}", app.adminSocketPath));
    assert.throws(() => adminOperation("preview", " ".repeat(4097), app.adminSocketPath));
    const executed = await adminOperation("execute", JSON.stringify({...selector, confirmationToken: preview.body.confirmationToken}), app.adminSocketPath);
    assert.equal(executed.status, 200);
    const denied = await adminOperation("preview", JSON.stringify({...selector, systemUids: ["foreign"]}), app.adminSocketPath);
    assert.equal(denied.status, 400);
  } finally {await app.shutdown(); rmSync(directory, {recursive: true, force: true});}
});

test("backend image is pinned, nonroot and contains no fixture dashboard", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /node:26\.0\.0-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /\/health\/ready/);
  assert.doesNotMatch(dockerfile, /\/health\/context/);
  assert.doesNotMatch(dockerfile, /COPY --from=build .*dashboard/);
  const manifest = JSON.parse(readFileSync(new URL("../../../container-build.json", import.meta.url)));
  assert.equal(manifest.hostPublication, "127.0.0.1:18091:18091");
});
