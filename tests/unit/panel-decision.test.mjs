import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"]
});
let selectedMode;
let configuredMode;
const configUpdates = [];
const vscode = {
  ConfigurationTarget: { Global: 1 },
  window: { async showQuickPick() { return selectedMode; } },
  workspace: { getConfiguration() { return {
    get(_key, fallback) { return configuredMode ?? fallback; },
    async update(...args) { configUpdates.push(args); }
  }; } }
};
const module = { exports: {} };
runInNewContext(output.outputFiles[0].text, {
  module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout,
  global: { Date },
  require: name => name === "vscode" ? vscode : require(name)
});

test("host sends approval only to current controller and rejects missing or stale decisions", async () => {
  const posted = [], calls = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => {
    throw new Error("Approval must use the existing controller");
  });
  const managed = {
    state: { role: "verification", verifiedWorkRunId: "work-run", model: "unsupported-model", fastMode: true },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    controller: {
      approveDecision(runId, execution) { calls.push({ runId, execution }); return runId === "current-run"; }
    }
  };
  await manager.handleMessage(managed, { type: "decision.approve", runId: "current-run" });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { runId: "current-run", execution: { verifiedWorkRunId: "work-run" } });
  assert.equal(posted.length, 0);
  await manager.handleMessage(managed, { type: "decision.approve", runId: "old-run" });
  assert.equal(posted.at(-2).type, "decision.pending");
  assert.equal(posted.at(-2).runId, null);
  assert.equal(posted.at(-1).level, "warning");
  managed.controller = undefined;
  await manager.handleMessage(managed, { type: "decision.approve", runId: "current-run" });
  assert.equal(calls.length, 2);
  assert.equal(posted.at(-1).level, "warning");
});


test("execution mode selection is explicit and supports bound idle sessions but not active runs", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "main" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  selectedMode = undefined;
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, undefined);
  selectedMode = { mode: "danger-full-access" };
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, "danger-full-access");
  assert.deepEqual(configUpdates.at(-1), ["executionMode", "danger-full-access", 1]);
  assert.equal(posted.at(-1).mode, "danger-full-access");
  managed.state.agentId = "existing-main";
  selectedMode = { mode: "workspace-write" };
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, "workspace-write");
  delete managed.state.agentId;
  managed.controller = { running: true };
  selectedMode = { mode: "bypass" };
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, "workspace-write");
});


test("new chat execution defaults to full access while configured restrictions are preserved", () => {
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  configuredMode = undefined;
  assert.equal(manager.defaultExecutionMode(), "danger-full-access");
  for (const mode of ["cli-default", "workspace-write", "danger-full-access", "bypass"]) {
    configuredMode = mode;
    assert.equal(manager.defaultExecutionMode(), mode);
  }
  configuredMode = undefined;
});

test("host forwards chosen execution mode for new and existing Main sessions", async () => {
  const calls = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "main" },
    controller: { async send(_text, _attachments, execution) { calls.push(execution); } }
  };
  const execution = { fast: false, goal: false };
  configuredMode = undefined;
  await manager.sendChat(managed, "task", [], execution);
  assert.equal(calls.at(-1).executionMode, "danger-full-access");
  for (const mode of ["cli-default", "workspace-write", "bypass"]) {
    configuredMode = mode;
    await manager.sendChat(managed, "task", [], execution);
    assert.equal(calls.at(-1).executionMode, mode);
  }
  configuredMode = undefined;
  managed.state.agentId = "existing-main";
  await manager.sendChat(managed, "follow up", [], execution);
  assert.equal(calls.at(-1).executionMode, undefined);
  managed.executionMode = "workspace-write";
  managed.executionModeExplicit = true;
  await manager.sendChat(managed, "follow up", [], execution);
  assert.equal(calls.at(-1).executionMode, "workspace-write");
});


test("bypass selection persists its alias and can change after session binding", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "main" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  selectedMode = { mode: "bypass" };
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, "bypass");
  assert.deepEqual(configUpdates.at(-1), ["executionMode", "bypass", 1]);
  assert.equal(posted.at(-1).mode, "bypass");
  managed.state.agentId = "existing-main";
  selectedMode = { mode: "workspace-write" };
  await manager.handleMessage(managed, { type: "execution.pick" });
  assert.equal(managed.executionMode, "workspace-write");
});

test("a run starting while the execution picker is open prevents the selection", async () => {
  let resolveChoice;
  selectedMode = new Promise(resolve => { resolveChoice = resolve; });
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "main", agentId: "existing-main" },
    executionMode: "workspace-write",
    controller: { running: false },
    panel: { webview: { async postMessage() { throw new Error("Selection must not apply"); } } }
  };
  const pending = manager.handleMessage(managed, { type: "execution.pick" });
  managed.controller.running = true;
  resolveChoice({ mode: "bypass" });
  await pending;
  assert.equal(managed.executionMode, "workspace-write");
  assert.equal(managed.executionModeExplicit, undefined);
  selectedMode = undefined;
});
