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
  const {
    readArtifactDocument,
    readArtifactIndex,
  } = require(join(extension.extensionPath, "src", "artifactReader"));
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
  assert.equal((html.match(/data-kanban-column-toggle="/g) || []).length, 0);
  assert.equal(
    (html.match(/data-kanban-visibility-toggle(?:\s|>)/g) || []).length,
    1,
  );
  assert.doesNotMatch(html, /data-kanban-board-selector/);
  assert.doesNotMatch(html, /data-kanban-updated/);
  assert.doesNotMatch(html, /data-kanban-refresh/);
  assert.doesNotMatch(html, /data-kanban-filter/);
  assert.match(html, /kanbanOpen/);
  assert.match(html, /kanbanBoard\.hidden = !open/);
  assert.match(html, /scrollbar-width:\s*none/);
  assert.match(html, /kanban\.snapshot/);
  assert.deepEqual(
    (html.match(/data-tab-id="(?:dashboard|editor|kanban|context)"/g) || [])
      .map((entry) => entry.match(/"([^"]+)"/)[1]),
    ["dashboard", "editor", "kanban", "context"],
  );
  assert.match(html, /data-editor-artifacts/);
  assert.match(html, /artifact\.saveItem/);

  const artifactIndex = await readArtifactIndex(
    join(extension.extensionPath, ".."),
  );
  assert.ok(
    artifactIndex.artifacts.some(
      ({ artifactType, id }) =>
        artifactType === "intake" && id === "agent-factory-workspace-editor",
    ),
    "canonical Editor Intake is discoverable",
  );
  const editorIntake = await readArtifactDocument(
    join(extension.extensionPath, ".."),
    "intake",
    "agent-factory-workspace-editor",
  );
  assert.ok(editorIntake.sections.length > 0);
  assert.equal(editorIntake.preview.metadata.artifactType, "intake");

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
