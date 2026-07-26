"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createKanbanController } = require("../../src/kanbanController");

function createHarness() {
  const sent = [];
  const disposals = [];
  let messageHandler;
  let watcherHandler;
  const watcher = {
    onDidChange(handler) {
      watcherHandler = handler;
      return { dispose() {} };
    },
    onDidCreate(handler) {
      watcherHandler = handler;
      return { dispose() {} };
    },
    onDidDelete(handler) {
      watcherHandler = handler;
      return { dispose() {} };
    },
    dispose() {
      disposals.push("watcher");
    },
  };
  const panel = {
    webview: {
      onDidReceiveMessage(handler) {
        messageHandler = handler;
        return { dispose() { disposals.push("messages"); } };
      },
      async postMessage(message) {
        sent.push(message);
        return true;
      },
    },
  };
  const vscode = {
    RelativePattern: class RelativePattern {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    workspace: {
      createFileSystemWatcher(pattern) {
        assert.equal(pattern.base, "/project");
        assert.equal(pattern.pattern, ".agent-factory/work-units/**/*.json");
        return watcher;
      },
    },
  };

  return {
    disposals,
    panel,
    sent,
    vscode,
    emitMessage(message) {
      return messageHandler(message);
    },
    emitWatch() {
      watcherHandler();
    },
  };
}

test("controller accepts only ready and refresh messages and emits snapshots", async () => {
  const harness = createHarness();
  let reads = 0;
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    debounceMs: 1,
    readSnapshot: async () => ({ schemaVersion: "1.0.0", sequence: ++reads }),
  });

  await harness.emitMessage({ type: "kanban.ready" });
  await harness.emitMessage({ type: "kanban.move", workUnitId: "unsafe" });
  await harness.emitMessage({ type: "kanban.refresh" });

  assert.equal(reads, 2);
  assert.deepEqual(
    harness.sent.map(({ type }) => type),
    ["kanban.snapshot", "kanban.snapshot"],
  );
  assert.equal(harness.sent[1].snapshot.sequence, 2);

  controller.dispose();
  assert.deepEqual(harness.disposals.sort(), ["messages", "watcher"]);
});

test("controller coalesces filesystem events into one authoritative refresh", async () => {
  const harness = createHarness();
  let reads = 0;
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    debounceMs: 5,
    readSnapshot: async () => ({ schemaVersion: "1.0.0", sequence: ++reads }),
  });

  harness.emitWatch();
  harness.emitWatch();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(reads, 1);
  assert.equal(harness.sent.length, 1);
  controller.dispose();
});
