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

test("manifest contributes one native Activity Bar container and two views", () => {
  assert.equal(manifest.name, "agent-factory-agents");
  assert.equal(manifest.publisher, "agent-factory");
  assert.equal(manifest.engines.vscode, "^1.129.0");
  assert.equal(manifest.main, "./src/extension.js");
  assert.deepEqual(manifest.activationEvents, [
    "onView:agentFactoryAgents.explorer",
    "onView:agentFactoryAgents.chat",
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
      id: "agentFactoryAgents.explorer",
      name: "Explorer",
    },
    {
      id: "agentFactoryAgents.chat",
      name: "Agents",
      type: "webview",
    },
  ]);
});

test("Activity Bar icon is a monochrome 24px SVG asset", () => {
  assert.match(icon, /<svg[^>]+viewBox="0 0 24 24"/);
  assert.match(icon, /aria-hidden="true"/);
  assert.doesNotMatch(icon, /<(?:image|text)\b/);
  assert.doesNotMatch(icon, /#[0-9a-f]{3,8}/i);
});

