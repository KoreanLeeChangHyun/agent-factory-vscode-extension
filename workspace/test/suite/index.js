"use strict";

const assert = require("node:assert/strict");
const { join } = require("node:path");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension(
    "agent-factory.agent-factory-workspace",
  );
  assert.ok(extension, "development extension is discoverable");
  await extension.activate();

  const { readKanbanSnapshot } = require(
    join(extension.extensionPath, "src", "kanbanReader"),
  );
  const { createWebviewHtml } = require(
    join(extension.extensionPath, "src", "webviewShell"),
  );
  const snapshot = await readKanbanSnapshot(join(extension.extensionPath, ".."));
  assert.deepEqual(
    snapshot.columns.map(({ id }) => id),
    ["backlog", "ready", "working", "review", "done", "blocked"],
  );
  assert.equal(snapshot.errors.length, 0);
  assert.ok(
    snapshot.columns.some(({ cards }) => cards.length > 0),
    "canonical Work Unit cards are projected",
  );

  const html = createWebviewHtml({
    cspSource: "vscode-webview://e2e",
    nonce: "e2e-nonce",
  });
  assert.equal((html.match(/data-kanban-column="/g) || []).length, 6);
  assert.match(html, /data-kanban-filter/);
  assert.match(html, /kanban\.snapshot/);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("agentFactoryWorkspace.open"));

  await vscode.commands.executeCommand("agentFactoryWorkspace.open");
}

module.exports = { run };
