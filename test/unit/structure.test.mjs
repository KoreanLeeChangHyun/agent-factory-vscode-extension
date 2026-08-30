import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../../templates/chat.html", import.meta.url), "utf8");

test("extension runs in the workspace extension host", function () {
  assert.deepEqual(packageJson.extensionKind, ["workspace"]);
  assert.equal(packageJson.main, "./dist/extension.js");
});

test("chat is restored as an editor webview panel", function () {
  assert.ok(packageJson.activationEvents.includes("onWebviewPanel:agentFactory.mainChat"));
});

test("main chat can be added from the editor tab context menu", function () {
  const items = packageJson.contributes.menus["editor/title/context"];
  assert.ok(items.some(function (item) {
    return item.command === "agentFactory.mainChat.open";
  }));
});

test("an active main chat exposes an add button in the editor title", function () {
  const items = packageJson.contributes.menus["editor/title"];
  const add = items.find(function (item) {
    return item.command === "agentFactory.mainChat.open";
  });
  assert.equal(add.when, "activeWebviewPanelId == agentFactory.mainChat");
  const command = packageJson.contributes.commands.find(function (item) {
    return item.command === "agentFactory.mainChat.open";
  });
  assert.equal(command.icon, "$(add)");
});

test("an active main chat can be renamed from the tab context menu", function () {
  const items = packageJson.contributes.menus["editor/title/context"];
  const rename = items.find(function (item) {
    return item.command === "agentFactory.mainChat.rename";
  });
  assert.equal(rename.when, "activeWebviewPanelId == agentFactory.mainChat");
});

test("chat template uses external static assets and a nonce CSP", function () {
  assert.match(template, /Content-Security-Policy/);
  assert.match(template, /script-src 'nonce-\{\{nonce\}\}'/);
  assert.match(template, /src="\{\{scriptUri\}\}"/);
  assert.match(template, /src="\{\{iconUri\}\}"/);
  assert.match(template, /href="\{\{styleUri\}\}"/);
  assert.doesNotMatch(template, /<style[ >]/);
});

test("composer exposes model, Fast, and Goal controls", function () {
  assert.match(template, /id="model-reasoning-button"/);
  assert.match(template, /id="fast-mode-button"/);
  assert.match(template, /id="goal-mode-button"/);
});

test("status bar includes active Work and Verification counts", function () {
  const defaults = packageJson.contributes.configuration.properties[
    "agentFactory.mainChat.statusItems"
  ].default;
  assert.ok(defaults.includes("agents"));
});
