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
let configuredMode;
const configUpdates = [];
const clipboardWrites = [];
const externalOpens = [];
const vscode = {
  ViewColumn: { Active: -1 },
  env: {
    clipboard: { async writeText(text) { clipboardWrites.push(text); } },
    async openExternal(uri) { externalOpens.push(uri.value); return true; }
  },
  Uri: { parse(value) { return { value }; } },
  ConfigurationTarget: { Global: 1 },
  window: {},
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


test("inline execution mode selection supports bound idle sessions but not active runs", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "main" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  await manager.handleMessage(managed, { type: "execution.select", mode: "danger-full-access" });
  assert.equal(managed.executionMode, "danger-full-access");
  assert.deepEqual(configUpdates.at(-1), ["executionMode", "danger-full-access", 1]);
  assert.equal(posted.at(-1).mode, "danger-full-access");
  managed.state.agentId = "existing-main";
  await manager.handleMessage(managed, { type: "execution.select", mode: "workspace-write" });
  assert.equal(managed.executionMode, "workspace-write");
  delete managed.state.agentId;
  managed.controller = { running: true };
  await manager.handleMessage(managed, { type: "execution.select", mode: "bypass" });
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
  await manager.handleMessage(managed, { type: "execution.select", mode: "bypass" });
  assert.equal(managed.executionMode, "bypass");
  assert.deepEqual(configUpdates.at(-1), ["executionMode", "bypass", 1]);
  assert.equal(posted.at(-1).mode, "bypass");
  managed.state.agentId = "existing-main";
  await manager.handleMessage(managed, { type: "execution.select", mode: "workspace-write" });
  assert.equal(managed.executionMode, "workspace-write");
});

test("execution selection rejects invalid modes and ignores non-Main panels", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = {
    state: { role: "verification", agentId: "existing-main" },
    executionMode: "workspace-write",
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  await manager.handleMessage(managed, { type: "execution.select", mode: "bypass" });
  assert.equal(managed.executionMode, "workspace-write");
  assert.equal(managed.executionModeExplicit, undefined);
  await manager.handleMessage(managed, { type: "execution.select", mode: "unsafe" });
  assert.equal(posted.at(-1).level, "error");
});


test("execution reference copy accepts a bounded ID and rejects non-ID clipboard payloads", async () => {
  const notices = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = { panel: { webview: { async postMessage(message) { notices.push(message); return true; } } } };
  await manager.handleMessage(managed, { type: "reference.copy", id: "run-123" });
  assert.equal(clipboardWrites.at(-1), "run-123");
  const before = clipboardWrites.length;
  for (const id of ["../path", "text with spaces", "x".repeat(129), "<script>", ""]) {
    await manager.handleMessage(managed, { type: "reference.copy", id });
  }
  assert.equal(clipboardWrites.length, before);
  assert.equal(notices.length, 5);
});

test("validated web links open through VS Code", async () => {
  const notices = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = { panel: { webview: { async postMessage(message) { notices.push(message); return true; } } } };
  await manager.handleMessage(managed, { type: "link.open", href: "https://example.com/docs" });
  assert.equal(externalOpens.at(-1), "https://example.com/docs");
  assert.equal(notices.length, 0);
  await manager.handleMessage(managed, { type: "link.open", href: "javascript:alert(1)" });
  assert.equal(externalOpens.length, 1);
  assert.equal(notices.at(-1).level, "error");
});

test("sidebar catalog merges runtime sessions with saved names and reuses an open panel", async () => {
  const storage = new Map();
  const posted = [], revealed = [];
  const context = { workspaceState: {
    get(key) { return storage.get(key); },
    async update(key, value) { storage.set(key, value); }
  } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({
    available: true, client: { async listSessions() {
      return [{ agentId: "main-existing", sessionId: "session-one" }, { agentId: "main-remote", sessionId: "session-two" }];
    } }
  }));
  const state = { panelId: "draft-id", title: "My agent", role: "main", agentId: "main-existing" };
  const managed = { state, controller: { running: false }, panel: {
    reveal(...args) { revealed.push(args); },
    webview: { async postMessage(message) { posted.push(message); } }
  } };
  manager.panels.set(state.panelId, managed);
  await manager.renameSidebarAgent(state, "Renamed agent");
  assert.equal(managed.panel.title, "Renamed agent");
  assert.equal(posted.at(-1).type, "chat.renamed");
  let catalog = await manager.sidebarAgents();
  assert.equal(catalog.length, 2);
  assert.equal(catalog.find(agent => agent.state.agentId === "main-existing").state.title, "Renamed agent");
  await manager.openSidebarAgent(catalog[0].state);
  assert.equal(revealed.length, 1);
  manager.panels.clear();
  catalog = await manager.sidebarAgents();
  assert.equal(catalog.find(agent => agent.state.agentId === "main-existing").state.title, "Renamed agent");
  assert.equal(catalog.find(agent => agent.state.agentId === "main-existing").state.panelId, "draft-id");
});

test("opening a saved sidebar chat preserves its identity and group key over composer defaults", async () => {
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const state = { panelId: "saved-panel", agentId: "main-saved", title: "Saved name", role: "main" };
  let attached;
  manager.composerPreferences = () => ({ panelId: "fresh-default", title: "Main Agent", model: "preferred-model" });
  manager.webviewOptions = () => ({});
  manager.attach = async (_panel, value) => { attached = value; };
  vscode.window.createWebviewPanel = () => ({});
  await manager.openSidebarAgent(state);
  assert.equal(attached.panelId, "saved-panel");
  assert.equal(attached.agentId, "main-saved");
  assert.equal(attached.title, "Saved name");
  assert.equal(attached.model, "preferred-model");
});
