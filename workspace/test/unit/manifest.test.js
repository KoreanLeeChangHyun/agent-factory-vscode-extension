"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
);
const extensionSource = readFileSync(
  join(__dirname, "..", "..", "src", "extension.js"),
  "utf8",
);

test("manifest exposes the approved extension identity and command", () => {
  assert.equal(manifest.name, "agent-factory-workspace");
  assert.equal(manifest.publisher, "agent-factory");
  assert.equal(manifest.engines.vscode, "^1.129.0");
  assert.equal(manifest.main, "./src/extension.js");
  assert.deepEqual(manifest.activationEvents, [
    "onCommand:agentFactoryWorkspace.open",
  ]);
  assert.deepEqual(manifest.contributes.commands, [
    {
      command: "agentFactoryWorkspace.open",
      title: "Agent Factory: Open Workspace",
    },
  ]);
});

test("extension host owns a constrained Webview boundary", () => {
  assert.match(extensionSource, /enableScripts: true/);
  assert.match(extensionSource, /localResourceRoots: \[\]/);
  assert.match(extensionSource, /retainContextWhenHidden: false/);
  assert.match(extensionSource, /randomBytes\(18\)/);
});
