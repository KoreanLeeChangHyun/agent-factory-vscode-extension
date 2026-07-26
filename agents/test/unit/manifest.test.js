"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
);
const icon = readFileSync(
  join(__dirname, "..", "..", "media", "agent-factory.svg"),
  "utf8",
);

test("manifest contributes one native launcher with editor commands", () => {
  assert.equal(manifest.name, "agent-factory-agents");
  assert.equal(manifest.publisher, "agent-factory");
  assert.equal(manifest.engines.vscode, "^1.129.0");
  assert.equal(manifest.main, "./src/extension.js");
  assert.deepEqual(manifest.activationEvents, [
    "onView:agentFactoryAgents.launcher",
    "onCommand:agentFactoryAgents.open",
  ]);
  assert.deepEqual(manifest.contributes.viewsContainers.activitybar, [
    {
      id: "agentFactoryAgents",
      title: "Agent Factory",
      icon: "media/agent-factory.svg",
    },
  ]);
  assert.deepEqual(manifest.contributes.views.agentFactoryAgents, [
    {
      id: "agentFactoryAgents.launcher",
      name: "Agent Factory",
    },
  ]);
  assert.deepEqual(manifest.contributes.commands, [
    {
      command: "agentFactoryAgents.open",
      title: "Agent Factory: Open Agents",
    },
  ]);
  assert.deepEqual(manifest.contributes.viewsWelcome, [
    {
      view: "agentFactoryAgents.launcher",
      contents:
        "Open Agent Factory tools in the editor area.\n" +
        "[Open Agents](command:agentFactoryAgents.open)\n" +
        "[Open Workspace](command:agentFactoryWorkspace.open)",
    },
  ]);

  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /agentFactoryAgents\.explorer/);
  assert.doesNotMatch(serialized, /agentFactoryAgents\.chat/);
  assert.doesNotMatch(serialized, /"type":"webview"/);
});

test("Activity Bar icon is a monochrome 24px SVG asset", () => {
  assert.match(icon, /<svg[^>]+viewBox="0 0 24 24"/);
  assert.match(icon, /aria-hidden="true"/);
  assert.doesNotMatch(icon, /<(?:image|text)\b/);
  assert.doesNotMatch(icon, /#[0-9a-f]{3,8}/i);
});

test("manifest packages the pinned linux-x64 Codex payload without a web dependency", () => {
  assert.equal(
    manifest.dependencies["@openai/codex-linux-x64"],
    "npm:@openai/codex@0.145.0-linux-x64",
  );
  assert.equal(manifest.devDependencies["@vscode/vsce"], "3.9.2");
  assert.equal(
    manifest.scripts["package:linux-x64"],
    "vsce package --allow-missing-repository --target linux-x64 --out dist/agent-factory-agents-linux-x64.vsix",
  );
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.doesNotMatch(JSON.stringify(manifest), /\.\.\/web/);
});
