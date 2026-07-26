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

function snapshot(status = "ready", generatedAt = "2026-07-27T00:00:00Z") {
  const statuses = ["backlog", "ready", "working", "review", "done", "blocked"];
  return {
    schemaVersion: "1.0.0",
    generatedAt,
    columns: statuses.map((columnStatus) => ({
      id: columnStatus,
      cards:
        columnStatus === status
          ? [
              {
                id: "safe-work-unit",
                status,
                capabilities: [
                  { target: "backlog", allowed: status === "ready" },
                  { target: "blocked", allowed: status === "ready" },
                  { target: "working", allowed: false },
                ],
              },
            ]
          : [],
    })),
    errors: [],
  };
}

test("controller accepts ready and refresh messages while ignoring spoofed messages", async () => {
  const harness = createHarness();
  let reads = 0;
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    debounceMs: 1,
    readSnapshot: async () => ({ ...snapshot(), sequence: ++reads }),
    runTransition: async () => assert.fail("spoofed message must not execute"),
  });

  await harness.emitMessage({ type: "kanban.ready" });
  await harness.emitMessage({ type: "kanban.execute", command: "rm -rf" });
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

test("controller revalidates a current allowed transition and refreshes authoritatively", async () => {
  const harness = createHarness();
  const reads = [snapshot("ready"), snapshot("backlog", "2026-07-27T00:00:01Z")];
  const runs = [];
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    readSnapshot: async () => reads.shift(),
    runTransition: async (request) => {
      runs.push(request);
      return { valid: true };
    },
  });

  await harness.emitMessage({ type: "kanban.ready" });
  await harness.emitMessage({
    type: "kanban.transition",
    requestId: "transition-1",
    workUnitId: "safe-work-unit",
    fromStatus: "ready",
    targetStatus: "backlog",
    snapshotGeneratedAt: "2026-07-27T00:00:00Z",
  });

  assert.deepEqual(runs, [
    {
      projectRoot: "/project",
      workUnitId: "safe-work-unit",
      targetStatus: "backlog",
    },
  ]);
  assert.deepEqual(
    harness.sent.map(({ type }) => type),
    [
      "kanban.snapshot",
      "kanban.transitionPending",
      "kanban.snapshot",
      "kanban.transitionResult",
    ],
  );
  assert.equal(harness.sent.at(-1).ok, true);
  controller.dispose();
});

test("controller blocks stale, disallowed, malformed, and duplicate transitions before execution", async () => {
  const harness = createHarness();
  let release;
  let runs = 0;
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    readSnapshot: async () => snapshot(),
    runTransition: async () => {
      runs += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return { valid: true };
    },
  });
  await harness.emitMessage({ type: "kanban.ready" });

  const base = {
    type: "kanban.transition",
    requestId: "transition-1",
    workUnitId: "safe-work-unit",
    fromStatus: "ready",
    targetStatus: "backlog",
    snapshotGeneratedAt: "2026-07-27T00:00:00Z",
  };
  await harness.emitMessage({ ...base, requestId: "stale", snapshotGeneratedAt: "old" });
  await harness.emitMessage({ ...base, requestId: "disallowed", targetStatus: "working" });
  await harness.emitMessage({ ...base, requestId: "unsafe", workUnitId: "../escape" });
  const running = harness.emitMessage(base);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.emitMessage({ ...base, requestId: "duplicate" });

  assert.equal(runs, 1);
  assert.match(
    harness.sent.find((message) => message.requestId === "stale").error.message,
    /새로 고침/,
  );
  assert.match(
    harness.sent.find((message) => message.requestId === "disallowed").error.message,
    /허용되지/,
  );
  assert.equal(
    harness.sent.some((message) => message.requestId === "unsafe"),
    false,
  );
  assert.match(
    harness.sent.find((message) => message.requestId === "duplicate").error.message,
    /진행 중/,
  );

  release();
  await running;
  controller.dispose();
});

test("controller preserves authoritative state and reports sanitized manager failure", async () => {
  const harness = createHarness();
  const controller = createKanbanController({
    vscode: harness.vscode,
    panel: harness.panel,
    projectRoot: "/project",
    readSnapshot: async () => snapshot(),
    runTransition: async () => {
      throw Object.assign(new Error("manager failed\n<script>"), {
        code: "manager_failed",
      });
    },
  });
  await harness.emitMessage({ type: "kanban.ready" });
  await harness.emitMessage({
    type: "kanban.transition",
    requestId: "transition-failure",
    workUnitId: "safe-work-unit",
    fromStatus: "ready",
    targetStatus: "backlog",
    snapshotGeneratedAt: "2026-07-27T00:00:00Z",
  });

  const result = harness.sent.at(-1);
  assert.equal(result.type, "kanban.transitionResult");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "manager_failed");
  assert.doesNotMatch(result.error.message, /[\r\n<>]/);
  assert.equal(
    harness.sent.filter(({ type }) => type === "kanban.snapshot").length,
    2,
  );
  controller.dispose();
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
