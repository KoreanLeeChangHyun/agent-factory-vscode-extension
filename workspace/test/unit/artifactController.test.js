"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createArtifactController,
  isArtifactSaveMessage,
} = require("../../src/artifactController");

function createHarness() {
  const sent = [];
  let handler;
  const panel = {
    webview: {
      onDidReceiveMessage(next) {
        handler = next;
        return { dispose() {} };
      },
      async postMessage(message) {
        sent.push(message);
        return true;
      },
    },
  };
  const watcher = {
    onDidChange() { return { dispose() {} }; },
    onDidCreate() { return { dispose() {} }; },
    onDidDelete() { return { dispose() {} }; },
    dispose() {},
  };
  const vscode = {
    RelativePattern: class RelativePattern {},
    workspace: { createFileSystemWatcher() { return watcher; } },
  };
  return { panel, sent, vscode, emit: (message) => handler(message) };
}

test("save message contract rejects extra keys and malformed identities", () => {
  const valid = {
    type: "artifact.saveItem",
    requestId: "save-1",
    artifactType: "intake",
    artifactId: "safe-intake",
    sectionId: "overview",
    itemId: "ITEM-001",
    documentVersion: "1.0.3",
    content: { value: "after" },
  };
  assert.equal(isArtifactSaveMessage(valid), true);
  assert.equal(isArtifactSaveMessage({ ...valid, command: "rm" }), false);
  assert.equal(isArtifactSaveMessage({ ...valid, artifactId: "../unsafe" }), false);
});

test("controller loads index and document then refreshes authoritatively after save", async () => {
  const harness = createHarness();
  const index = { schemaVersion: "1.0.0", artifacts: [], errors: [] };
  const document = {
    artifactType: "intake",
    id: "safe-intake",
    documentVersion: "1.0.3",
    sections: [],
  };
  let saves = 0;
  const controller = createArtifactController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    readIndex: async () => index,
    readDocument: async () => document,
    saveItem: async () => { saves += 1; },
  });

  await harness.emit({ type: "artifact.ready" });
  await harness.emit({
    type: "artifact.select",
    artifactType: "intake",
    artifactId: "safe-intake",
  });
  await harness.emit({
    type: "artifact.saveItem",
    requestId: "save-1",
    artifactType: "intake",
    artifactId: "safe-intake",
    sectionId: "overview",
    itemId: "ITEM-001",
    documentVersion: "1.0.3",
    content: { value: "after" },
  });

  assert.equal(saves, 1);
  assert.deepEqual(
    harness.sent.map(({ type }) => type),
    ["artifact.index", "artifact.document", "artifact.savePending", "artifact.document", "artifact.saveResult"],
  );
  controller.dispose();
});
