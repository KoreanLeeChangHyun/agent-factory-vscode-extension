"use strict";

const assert = require("node:assert/strict");
const { execFile: execFileCallback } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const vscode = require("vscode");

const execFile = promisify(execFileCallback);

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
  const {
    createWorkUnitTransitionRunner,
    discoverWorkUnitManager,
  } = require(
    join(extension.extensionPath, "src", "kanbanManager"),
  );
  const {
    FIXTURE_ID,
    createReadyKanbanFixture,
  } = require(join(extension.extensionPath, "test", "helpers", "kanbanFixture"));
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

  const fixtureRoot = await mkdtemp(join(tmpdir(), "kanban-vscode-e2e-"));
  try {
    await execFile(
      "git",
      ["clone", "--quiet", "--shared", join(extension.extensionPath, ".."), fixtureRoot],
      { shell: false },
    );
    const manager = await discoverWorkUnitManager();
    await createReadyKanbanFixture({
      managerPath: manager.path,
      projectRoot: fixtureRoot,
    });
    const transition = createWorkUnitTransitionRunner();
    await transition({
      projectRoot: fixtureRoot,
      workUnitId: FIXTURE_ID,
      targetStatus: "backlog",
    });
    const moved = await readKanbanSnapshot(fixtureRoot);
    assert.equal(
      moved.columns.find(({ id }) => id === "backlog").cards.some(
        ({ id }) => id === FIXTURE_ID,
      ),
      true,
      "actual manager transition is reflected in the authoritative board",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

module.exports = { run };
