import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { importTypeScript } from "../support/import-typescript.mjs";

const require = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"]
});
let configuredMode;
const configUpdates = [];
const clipboardWrites = [];
const externalOpens = [];
const editorOpens = [];
const textOpens = [];
let saveDestination;
const saveDialogs = [];
const fileCopies = [];
const textEditor = { revealRange() {} };
const vscode = {
  ViewColumn: { Active: -1 },
  env: {
    clipboard: { async writeText(text) { clipboardWrites.push(text); } },
    async openExternal(uri) { externalOpens.push(uri.value); return true; }
  },
  Uri: { parse(value) { return { value }; }, file(fsPath) { return { fsPath }; } },
  commands: { async executeCommand(...args) { editorOpens.push(args); } },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Selection: class { constructor(start, end) { this.start = start; this.end = end; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
  ConfigurationTarget: { Global: 1 },
  window: { async showSaveDialog(options) { saveDialogs.push(options); return saveDestination; }, async showTextDocument() { return textEditor; } },
  workspace: { fs: { async copy(...args) { fileCopies.push(args); } }, async openTextDocument(uri) { textOpens.push(uri); return {}; }, getConfiguration() { return {
    get(_key, fallback) { return configuredMode ?? fallback; },
    async update(...args) { configUpdates.push(args); }
  }; } }
};
const module = { exports: {} };
const diagnostics = [];
runInNewContext(output.outputFiles[0].text, {
  module, exports: module.exports, Buffer, URL, structuredClone,
  console: { ...console, warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args) },
  process, setTimeout, clearTimeout,
  global: { Date },
  require: name => name === "vscode" ? vscode : require(name)
});

test("default branch notice does not hold chat submissions until dismissal", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-notice-"));
  const originalNotice = vscode.window.showInformationMessage;
  let dismiss, timer;
  const notice = new Promise(resolve => { dismiss = resolve; });
  const stored = new Map(), sent = [];
  let notices = 0;
  try {
    execFileSync("git", ["init", "-b", "main", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    vscode.window.showInformationMessage = () => { notices++; return notice; };
    const manager = new module.exports.ChatPanelManager({ globalState: {
      get(key) { return stored.get(key); }, async update(key, value) { stored.set(key, value); }
    } }, {}, () => [], async () => ({ available: false }));
    manager.refreshWorktree = async () => {};
    manager.sendChat = async (_managed, text) => { sent.push(text); };
    const managed = {
      state: { role: "main", agentId: "main-notice" }, worktree: { workingDirectory: root },
      panel: { webview: { async postMessage() { return true; } } }
    };
    const sends = ["first", "second"].map(text => manager.handleMessage(managed, {
      type: "chat.send", id: text, text, attachments: [], execution: { fast: false, goal: false }
    }));
    await Promise.race([Promise.all(sends), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Submissions waited for notice dismissal")), 2000);
    })]);
    assert.deepEqual(sent, ["first", "second"]);
    assert.equal(notices, 1);
    assert.equal([...stored.values()][0].shown, true);
  } finally {
    clearTimeout(timer);
    dismiss();
    vscode.window.showInformationMessage = originalNotice;
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation transition finishes while the completion notification remains open", async () => {
  const posted = [];
  let resetCount = 0;
  let refreshCount = 0;
  let dismissNotification;
  const notification = new Promise(resolve => { dismissNotification = resolve; });
  vscode.window.showInformationMessage = () => notification;
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({
    available: true, client: { async listChildSessions() { return []; }, async capabilities() { return { submit: {}, send: {} }; } }
  }));
  manager.ensureController = async () => {};
  manager.rememberAgent = async () => {};
  manager.scheduleAgentList = () => { refreshCount++; };
  const managed = {
    state: { role: "main", agentId: "main-test" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    controller: { async resetConversation() {
      return { conversationId: `conversation-${++resetCount}` };
    } }
  };
  try {
    const transition = manager.transitionConversation(managed);
    // Drain the reset's asynchronous work without dismissing its notification.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(managed.sessionTransition, undefined);
    await transition;
    await manager.transitionConversation(managed);
    assert.equal(resetCount, 2);
    assert.equal(refreshCount, 2);
    assert.deepEqual(posted.map(message => message.type), ["conversation.clearing", "conversation.cleared", "capabilities.updated", "conversation.clearing", "conversation.clearing", "conversation.cleared", "capabilities.updated", "conversation.clearing"]);
  } finally {
    dismissNotification();
    delete vscode.window.showInformationMessage;
  }
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
      approveDecision(runId, execution, language) { calls.push({ runId, execution, language }); return runId === "current-run"; }
    }
  };
  await manager.handleMessage(managed, { type: "decision.approve", runId: "current-run", language: "en" });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { runId: "current-run", execution: { verifiedWorkRunId: "work-run" }, language: "en" });
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
    panel: { webview: { async postMessage() { return true; } } },
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
  const agentPermissions = { main: "bypass", work: "workspace-write", verification: "danger-full-access" };
  await manager.sendChat(managed, "role override", [], { ...execution, agentPermissions });
  assert.equal(calls.at(-1).executionMode, "bypass");
  assert.deepEqual(calls.at(-1).agentPermissions, agentPermissions);
});

test("conversation clear publishes its boundary before a racing chat is promoted", async () => {
  let releaseBoundary;
  const boundaryReady = new Promise(resolve => { releaseBoundary = resolve; });
  const posted = [];
  // chat.send refreshes worktree state first; report no runtime instead of failing that probe.
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: false }));
  manager.clearConversation = async managed => {
    await boundaryReady;
    managed.state.conversationId = "conversation-new";
    await manager.post(managed.panel, { type: "conversation.cleared", conversationId: "conversation-new" });
  };
  const submission = { taskMode: "direct", businessMode: "normal", goal: false };
  const managed = {
    state: { role: "main", panelId: "panel" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    imageAttachments: new Map(),
    controller: {
      async send(_text, _attachments, _execution, onStarted) { onStarted(submission); }
    }
  };

  const clearing = manager.handleMessage(managed, { type: "conversation.clear" });
  const sending = manager.handleMessage(managed, {
    type: "chat.send", id: "racing-message", text: "new request", attachments: [],
    execution: { taskMode: "direct", businessMode: "normal", fast: false, goal: false }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted.map(message => message.type), ["conversation.clearing"]);
  assert.equal(managed.pendingMessageIds.has("racing-message"), true);

  releaseBoundary();
  await Promise.all([clearing, sending]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted.map(message => message.type), ["conversation.clearing", "conversation.cleared", "conversation.clearing", "chat.started"]);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[3])), {
    type: "chat.started", id: "racing-message", text: "new request", attachments: [], submission
  });
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

test("image and other file links use the registered editor while line links retain text navigation", async () => {
  const notices = [];
  const manager = new module.exports.ChatPanelManager({ extensionUri: { fsPath: '/workspace' } }, {}, () => [], async () => { throw new Error('not used'); });
  const managed = { panel: { webview: { async postMessage(message) { notices.push(message); return true; } } } };
  const before = textOpens.length;
  for (const [href, expected] of [
    ['/home/deus/workspace/agent-factory/docs/artifact/evidence/extension-out/astra-stars/stars-795-0.png', '/home/deus/workspace/agent-factory/docs/artifact/evidence/extension-out/astra-stars/stars-795-0.png'],
    ['file:///tmp/star%20preview.PNG', '/tmp/star preview.PNG'],
    ['./out/preview.webp', '/workspace/out/preview.webp'],
    ['/tmp/report.pdf', '/tmp/report.pdf'],
    ['/tmp/readme.md', '/tmp/readme.md']
  ]) {
    await manager.handleMessage(managed, { type: 'link.open', href });
    assert.deepEqual(JSON.parse(JSON.stringify(editorOpens.at(-1))), ['vscode.open', { fsPath: expected }, { preview: true }]);
  }
  assert.equal(textOpens.length, before, 'Binary links must never use openTextDocument');
  const opensBeforeLine = editorOpens.length;
  await manager.handleMessage(managed, { type: 'link.open', href: '/workspace/app.ts:12:3' });
  assert.equal(editorOpens.length, opensBeforeLine);
  assert.equal(textOpens.at(-1).fsPath, '/workspace/app.ts');
  assert.deepEqual(JSON.parse(JSON.stringify(textEditor.selection.start)), { line: 11, character: 2 });
  assert.equal(notices.length, 0);
});

test("child panels cannot switch identities to a Main session", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => {
    throw new Error("non-Main session selection must not connect");
  });
  const managed = {
    state: { role: "work", agentId: "work-exact" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  await manager.handleMessage(managed, { type: "session.select", agentId: "main-other" });
  assert.equal(managed.state.agentId, "work-exact");
  assert.equal(posted.at(-1).level, "warning");
});

test("session selection and restoration reuse an already bound panel", async () => {
  const reveals = [], disposed = [];
  const manager = new module.exports.ChatPanelManager({ globalState: { get() {} } }, {}, () => [], async () => {
    throw new Error("duplicate panel must not connect");
  });
  const existing = {
    state: { panelId: "panel-existing", role: "main", agentId: "main-exact" },
    panel: { reveal(...args) { reveals.push(args); } }
  };
  manager.panels.set("panel-existing", existing);
  const selecting = {
    state: { panelId: "panel-other", role: "main" },
    panel: { webview: { async postMessage() { return true; } } }
  };
  manager.panels.set("panel-other", selecting);
  await manager.handleMessage(selecting, { type: "session.select", agentId: "main-exact" });
  assert.equal(selecting.state.agentId, undefined);
  const revived = { viewColumn: 2, dispose() { disposed.push(true); } };
  await manager.revive(revived, { panelId: "restored-duplicate", role: "main", agentId: "main-exact" });
  assert.equal(reveals.length, 2);
  assert.deepEqual(disposed, [true]);
});

test("session transitions serialize concurrent selection and chat sends", async () => {
  const posted = [], sent = [];
  let releaseSessions;
  const gate = new Promise(resolve => { releaseSessions = resolve; });
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({
    available: true,
    client: { async listSessions() { return gate; } }
  }));
  const managed = {
    state: { panelId: "panel-one", role: "main" },
    controller: { running: false, async send(text) { sent.push(text); } },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  const selecting = manager.handleMessage(managed, { type: "session.select", agentId: "main-one" });
  await new Promise(resolve => setImmediate(resolve));
  await manager.handleMessage(managed, { type: "session.select", agentId: "main-two" });
  const sending = manager.handleMessage(managed, {
    type: "chat.send", id: "message-one", text: "must not cross sessions", attachments: [],
    execution: { fast: false, goal: false }
  });
  assert.equal(posted.filter(message => message.level === "warning").length, 1);
  assert.deepEqual(sent, []);
  releaseSessions([]);
  await Promise.all([selecting, sending]);
  assert.deepEqual(sent, ["must not cross sessions"]);
});

test("concurrent panels atomically claim one session identity", async () => {
  let releaseSessions;
  const gate = new Promise(resolve => { releaseSessions = resolve; });
  const storage = new Map(), reveals = [], reconnected = [];
  const context = {
    workspaceState: {
      get(key) { return storage.get(key); },
      async update(key, value) { storage.set(key, value); }
    }
  };
  const client = {
    async listSessions() { return gate; },
    async capabilities() { return { submit: {}, send: {} }; },
    async goal() { return { goal: null }; }
  };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: true, client }));
  manager.reconnectController = async managed => { reconnected.push(managed.state.panelId); };
  const panels = ["one", "two"].map(panelId => ({
    state: { panelId, role: "main" },
    controller: { running: false, dispose() {} },
    panel: {
      reveal() { reveals.push(panelId); },
      webview: { async postMessage() { return true; } }
    }
  }));
  for (const managed of panels) manager.panels.set(managed.state.panelId, managed);

  const selections = panels.map(managed => manager.handleMessage(managed, {
    type: "session.select", agentId: "main-shared"
  }));
  await new Promise(resolve => setImmediate(resolve));
  releaseSessions([{ agentId: "main-shared" }]);
  await Promise.all(selections);

  assert.equal(panels.filter(managed => managed.state.agentId === "main-shared").length, 1);
  assert.equal(reconnected.length, 1);
  assert.equal(reveals.length, 1);
});

test("disposing during session persistence prevents controller recreation", async () => {
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  let reconnects = 0, capabilities = 0, goals = 0;
  const context = { workspaceState: {
    get() { return []; },
    async update() { writeStarted(); await writeGate; }
  } };
  const client = {
    async listSessions() { return [{ agentId: "main-target" }]; },
    async capabilities() { capabilities += 1; return { submit: {}, send: {} }; },
    async goal() { goals += 1; return { goal: null }; }
  };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: true, client }));
  manager.reconnectController = async () => { reconnects += 1; };
  const managed = {
    state: { panelId: "closing", role: "main" },
    controller: { running: false, dispose() {} },
    panel: { webview: { async postMessage() { return true; } } }
  };
  manager.panels.set("closing", managed);

  const selecting = manager.handleMessage(managed, { type: "session.select", agentId: "main-target" });
  await started;
  managed.disposed = true;
  releaseWrite();
  await selecting;

  assert.equal(reconnects, 0);
  assert.equal(capabilities, 0);
  assert.equal(goals, 0);
  let disposedConnects = 0;
  const disposedManager = new module.exports.ChatPanelManager({}, {}, () => [], async () => {
    disposedConnects += 1;
    return { available: true, client };
  });
  await disposedManager.ensureController({ disposed: true });
  assert.equal(disposedConnects, 0);
});

test("sidebar session writes serialize read-modify-write updates", async () => {
  const storage = new Map(), releases = [];
  const context = { workspaceState: {
    get(key) { return storage.get(key); },
    async update(key, value) {
      await new Promise(resolve => releases.push(resolve));
      storage.set(key, value);
    }
  } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => {
    throw new Error("not used");
  });
  const first = manager.rememberAgent({ panelId: "one", title: "One", role: "main" });
  const second = manager.rememberAgent({ panelId: "two", title: "Two", role: "main" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(storage.get("agentFactory.sidebar.agents"), state => state.panelId), ["one", "two"]);
});

test("opening and updating saved sidebar chats preserves their order across reload", async () => {
  const key = "agentFactory.sidebar.agents";
  const storage = new Map([[key, [
    { panelId: "one", title: "One", role: "main" },
    { panelId: "two", title: "Two", role: "main", agentId: "main-two" },
    { panelId: "three", title: "Three", role: "main" }
  ]]]);
  const context = { workspaceState: {
    get: key => storage.get(key),
    async update(key, value) { storage.set(key, value); }
  } };
  const createManager = () => new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: false }));
  const manager = createManager();
  manager.composerPreferences = () => ({});
  manager.webviewOptions = () => ({});
  manager.attach = async (_panel, state) => manager.rememberAgent(state);
  const originalCreate = vscode.window.createWebviewPanel;
  vscode.window.createWebviewPanel = () => ({});
  try {
    for (const index of [0, 1, 0]) {
      await manager.openSidebarAgent((await manager.sidebarAgents())[index].state);
      assert.deepEqual(Array.from(await manager.sidebarAgents(), entry => entry.state.panelId), ["one", "two", "three"]);
    }
    await manager.renameSidebarAgent((await manager.sidebarAgents())[1].state, "Renamed");
    // A newly bound runtime identity updates the draft's existing slot.
    await manager.rememberAgent({ panelId: "one", title: "One", role: "main", agentId: "main-one" });
    await manager.rememberAgent({ panelId: "four", title: "Four", role: "main" });
    const restored = await createManager().sidebarAgents();
    assert.deepEqual(Array.from(restored, entry => entry.state.panelId), ["one", "two", "three", "four"]);
    assert.equal(restored[1].state.title, "Renamed");
    assert.equal(restored[0].state.agentId, "main-one");
    // Duplicate runtime identities are still coalesced without moving the entry.
    storage.get(key).push({ panelId: "duplicate", title: "Duplicate", role: "main", agentId: "main-two" });
    await manager.rememberAgent({ panelId: "two", title: "Updated", role: "main", agentId: "main-two" });
    assert.deepEqual(Array.from(await manager.sidebarAgents(), entry => entry.state.panelId), ["one", "two", "three", "four"]);
  } finally {
    vscode.window.createWebviewPanel = originalCreate;
  }
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

test("stop on an unbound idle panel reconciles state without repeated notices", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not needed"); });
  const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } } };
  for (let i = 0; i < 3; i++) await manager.handleMessage(managed, { type: "run.cancel" });
  assert.equal(posted.length, 3);
  for (const message of posted) assert.deepEqual(JSON.parse(JSON.stringify(message)), { type: "run.state", running: false });
});

test("Host rejects a provider-changing composer payload for a bound conversation", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({ globalState: { get() {}, async update() {} } }, {}, () => [], async () => ({
    available: true,
    client: { async capabilities() { return { submit: { model: true, reasoning: true }, send: { model: true, reasoning: true, sessionProvider: "claude" } }; } }
  }));
  const managed = {
    state: { panelId: "provider-bound", role: "main", agentId: "main-bound", model: "claude-opus-5-5", reasoning: "medium" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  await manager.handleMessage(managed, {
    type: "composer.settings", model: "gpt-6-astra", reasoning: "high", fastMode: false, goalMode: false
  });
  assert.equal(managed.state.model, "claude-opus-5-5");
  assert.equal(managed.state.reasoning, "medium");
  assert.match(posted.at(-1).text, /current model provider|현재 모델 공급자/);
});

test("Host rejects a provider-changing saved set before applying it", async () => {
  const posted = [], writes = [];
  const stored = new Map([["agentFactory.agentPresets.chat.v2", {"preset-provider-bound": [{ name: "Other provider", settings: { main: { model: "gpt-6-astra", reasoningEffort: "high" } } }]}]]);
  const memory = { get(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; }, async update(...args) { writes.push(args); stored.set(args[0], args[1]); } };
  const manager = new module.exports.ChatPanelManager({ globalState: memory, workspaceState: memory }, {}, () => [], async () => ({
    available: true,
    client: { async capabilities() { return { submit: { model: true, reasoning: true }, send: { model: true, reasoning: true, sessionProvider: "claude" } }; } }
  }));
  const managed = {
    state: { panelId: "preset-provider-bound", role: "main", agentId: "main-bound", model: "claude-opus-5-5", reasoning: "medium" },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  await manager.handleMessage(managed, { type: "agent.preset", action: "apply", scope: "chat", name: "Other provider" });
  assert.equal(managed.state.model, "claude-opus-5-5");
  assert.equal(writes.length, 0, "An incompatible set is rejected before any preset/configuration write");
  assert.equal(posted.at(-1).type, "agent.preset.result");
  assert.match(posted.at(-1).error, /bound to a model provider|모델 공급자에 바인딩/);
});

test("status customization serializes rapid edits, broadcasts saved empty selection and restores on failure", async () => {
  let items = ['project'];
  let fail = false;
  const writes = [], posted = [[], []];
  const original = vscode.workspace.getConfiguration;
  const manager = new module.exports.ChatPanelManager({}, {}, () => items, async () => { throw new Error('not needed'); });
  const panels = posted.map(messages => ({ webview: { async postMessage(message) { messages.push(message); } } }));
  manager.panels.set('one', { panel: panels[0] });
  manager.panels.set('two', { panel: panels[1] });
  vscode.workspace.getConfiguration = () => ({ async update(key, value, scope) {
    if (fail) throw new Error('settings read-only');
    await Promise.resolve();
    items = value;
    writes.push({ key, value: [...value], scope });
    await manager.refreshStatusItems();
  } });
  try {
    await Promise.all([
      manager.saveStatusItems(panels[0], ['weekly', 'project']),
      manager.saveStatusItems(panels[0], [])
    ]);
    assert.deepEqual(writes.map(write => write.value), [['weekly', 'project'], []]);
    assert.ok(writes.every(write => write.key === 'statusItems' && write.scope === vscode.ConfigurationTarget.Global));
    for (const messages of posted) assert.deepEqual(messages.at(-1).items, []);
    // New/revived views read the same configuration callback, independent of cached UI state.
    assert.deepEqual(manager.statusItems(), []);
    fail = true;
    await manager.saveStatusItems(panels[0], ['runtime']);
    assert.deepEqual(posted[0].at(-1).items, []);
    assert.ok(posted[0].some(message => message.type === 'host.notice' && message.level === 'warning'));
    fail = false;
    await manager.saveStatusItems(panels[1], ['branch']);
    for (const messages of posted) assert.deepEqual(messages.at(-1).items, ['branch']);
  } finally {
    vscode.workspace.getConfiguration = original;
  }
});


test("background completion wakes Main once, waits for conversation, and survives reload", async () => {
  const storage = new Map([["agentFactory.background.main-one", {}]]);
  const context = { workspaceState: { get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); } } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: false }));
  const calls = [];
  const managed = { state: { agentId: "main-one", role: "main" }, controller: {
    running: false,
    async send(text, attachments, execution, accepted) { calls.push({ text, execution }); accepted(); }
  } };
  const child = { agentId: "work-one", runId: "run-one", parentRunId: "parent-one", role: "work", status: "running", taskMode: "work-verification" };
  await manager.continueBackgroundWork(managed, [child]);
  assert.equal(calls.length, 0);
  child.status = "completed";
  managed.controller.running = true;
  await manager.continueBackgroundWork(managed, [child]);
  assert.equal(calls.length, 0, "Questions in progress take priority");
  managed.controller.running = false;
  managed.controller.conversationResetBlockedReason = "Human decision pending";
  await manager.continueBackgroundWork(managed, [child]);
  assert.equal(calls.length, 0, "Background updates must not approve pending decisions");
  managed.controller.conversationResetBlockedReason = undefined;
  await manager.continueBackgroundWork(managed, [child]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].execution.taskMode, "direct");
  assert.match(calls[0].text, /"taskMode":"work-verification"/);
  assert.match(calls[0].text, /run-one/);
  assert.match(calls[0].text, /do not reconcile or advance the loop/);
  assert.match(calls[0].text, /review implementation or rerun tests/);
  const restored = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: false }));
  await restored.continueBackgroundWork(managed, [child]);
  assert.equal(calls.length, 1);
  await restored.continueBackgroundWork(managed, [{ ...child, runId: "run-two", status: "failed" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /do not automatically grant approval or retry failed work/);
});

test("initial background discovery does not replay historical completed work", async () => {
  const storage = new Map();
  const manager = new module.exports.ChatPanelManager({ workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, value); }
  } }, {}, () => [], async () => ({ available: false }));
  let sends = 0;
  await manager.continueBackgroundWork({ state: { agentId: "main-old" }, controller: { async send() { sends++; } } },
    [{ agentId: "work-old", runId: "run-old", status: "completed", taskMode: "work" }]);
  assert.equal(sends, 0);
});

test("uncertain background acceptance is surfaced without automatic retry storms", async () => {
  const storage = new Map([["agentFactory.background.main-one", {}]]), posted = [];
  const manager = new module.exports.ChatPanelManager({ workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
  } }, {}, () => [], async () => ({ available: false }));
  let sends = 0;
  const managed = { state: { agentId: "main-one" }, panel: { webview: { async postMessage(message) { posted.push(message); } } },
    controller: { async send() { sends++; } } };
  const child = { agentId: "work-one", runId: "run-one", status: "completed", taskMode: "work" };
  await manager.continueBackgroundWork(managed, [child]);
  await new Promise(resolve => setImmediate(resolve));
  await manager.continueBackgroundWork(managed, [child]);
  assert.equal(sends, 1);
  assert.equal(storage.get("agentFactory.background.main-one")["work-one/run-one"].state, "prepared");
  assert.equal(posted.at(-1).type, "host.notice");
  assert.equal(posted.at(-1).level, "error");
});

test("real controller fallback reconciles failed or lost acceptance across restored panels", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const mode of ["before-send", "before-acceptance", "lost-ack", "after-acceptance", "permanent"]) {
    const key = "agentFactory.background.main-fallback";
    const storage = new Map([[key, {}]]), calls = [], notices = [], rawErrors = [], lookups = [];
    const context = { workspaceState: { get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); } } };
    let fail = true, acceptedRun;
    const runtime = {
      async activeRun() { if (mode === "before-send" && fail) throw new Error("Discovery unavailable"); },
      async dispatchAcceptance(agentId, id) { lookups.push(id); return acceptedRun && { agentId, runId: acceptedRun }; },
      async send(agentId, text, execution) {
        calls.push({ text, id: execution.deliveryId });
        if (fail && mode === "permanent") throw Object.assign(new Error("Invalid request"), { code: "request_invalid" });
        if (fail && mode === "before-acceptance") throw new Error("Connection unavailable");
        acceptedRun = "report-run";
        if (fail && mode === "lost-ack") throw new Error("Lost acknowledgement");
        return { agentId, runId: acceptedRun };
      },
      async updates() { if (fail && mode === "after-acceptance") throw new Error("Observation unavailable"); return { cursor: 0, updates: [] }; },
      async status() { return { status: "completed" }; },
      async result() { return { status: "completed", text: "Reported" }; }
    };
    const controller = () => new ChatSessionController(runtime, {
      onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onAssistantText() {}, onUsage() {},
      onError(message) { rawErrors.push(message); }
    }, "main-fallback", { pollIntervalMs: 0 });
    const managed = { state: { agentId: "main-fallback" }, controller: controller(),
      panel: { webview: { async postMessage(message) { notices.push(message); } } } };
    const child = { agentId: "work", runId: "child-run", status: "completed", taskMode: "work" };
    const manager = () => new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: true, client: runtime }));
    const first = manager();
    await first.continueBackgroundWork(managed, [child]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(managed.backgroundContinuation, false, mode + ": failure releases host ownership");
    assert.equal(managed.controller.queueLength, 0, "Durable delivery must not also be retained in controller queue");
    assert.deepEqual(rawErrors, [], "Structured errors belong to the delivery owner");
    const initial = storage.get(key)["work/child-run"];
    assert.ok(initial.dispatchId?.startsWith("dispatch-"), "Intent persists a stable runtime dispatch identity");
    assert.notEqual(initial.state, "completed", "Failure is not a delivered report");
    fail = false;
    managed.controller = controller();
    const restored = manager();
    await restored.continueBackgroundWork(managed, [{ ...child, updatedAt: "changed since attempt" }]);
    await new Promise(resolve => setImmediate(resolve));
    await restored.continueBackgroundWork(managed, [child]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, mode === "before-acceptance" ? 2 : 1, mode);
    if (calls.length === 2) assert.deepEqual(calls[0], calls[1], "Retry preserves request bytes and ID");
    assert.equal(storage.get(key)["work/child-run"].state, mode === "permanent" ? "blocked" : "accepted");
    assert.equal(lookups.length, ["before-send", "before-acceptance", "lost-ack"].includes(mode) ? 2 : 1,
      "The initial event also checks durable acceptance before submitting");
    assert.ok(notices.some(message => message.level === "error"));
  }
});

test("fallback lookup loss and legacy unidentified failures never authorize another submission", async () => {
  for (const mode of ["unavailable", "unsupported", "lookup-loss", "legacy"]) {
    const key = "agentFactory.background.main-uncertain";
    const stored = mode === "legacy" ? "delivery-error:completed" : {
      identity: "captured", state: "prepared", dispatchId: "dispatch-child-captured", message: "original bytes"
    };
    const storage = new Map([[key, { "work/run": stored }]]), notices = [];
    let sends = 0;
    const context = { workspaceState: { get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); } } };
    const connect = async () => ({ available: mode !== "unavailable", client: mode === "unsupported" ? {} : {
      async dispatchAcceptance() { throw new Error("Observation unavailable"); }
    } });
    const managed = { state: { agentId: "main-uncertain" }, controller: { async send() { sends++; } },
      panel: { webview: { async postMessage(message) { notices.push(message); } } } };
    const child = { agentId: "work", runId: "run", status: "completed", taskMode: "work" };
    for (let restore = 0; restore < 2; restore++) {
      const manager = new module.exports.ChatPanelManager(context, {}, () => [], connect);
      await manager.continueBackgroundWork(managed, [child]);
    }
    assert.equal(sends, 0, mode);
    if (mode !== "legacy") {
      assert.equal(storage.get(key)["work/run"].state, "prepared");
      assert.equal(storage.get(key)["work/run"].dispatchId, stored.dispatchId);
      assert.equal(managed.backgroundContinuation, false);
    }
    assert.equal(notices.length, mode === "lookup-loss" ? 1 : 0);
  }
});

 test("question copy preserves original multiline text through the host clipboard", async () => {
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("not used"); });
  const managed = { panel: { webview: { async postMessage() { return true; } } } };
  const text = "  질문 원문\n두 번째 줄 <tag> & **내용**  ";
  await manager.handleMessage(managed, { type: "message.copy", text });
  assert.equal(clipboardWrites.at(-1), text);
  const before = clipboardWrites.length;
  for (const text of [null, ""]) await manager.handleMessage(managed, { type: "message.copy", text });
  assert.equal(clipboardWrites.length, before);
  const longText = "x".repeat(100001);
  await manager.handleMessage(managed, { type: "message.copy", text: longText });
  assert.equal(clipboardWrites.at(-1), longText);
});

 test("archive links offer binary save, preserve cancellation and avoid editor fallback", async () => {
  const notices = [];
  const manager = new module.exports.ChatPanelManager({ extensionUri: { fsPath: '/workspace' } }, {}, () => [], async () => { throw new Error('not used'); });
  const managed = { panel: { webview: { async postMessage(message) { notices.push(message); return true; } } } };
  const editorsBefore = editorOpens.length, textsBefore = textOpens.length;
  saveDestination = { scheme: 'vscode-local', authority: '', path: '/Downloads/icons.zip' };
  for (const href of ['/workspace/out/icons.zip', 'file:///tmp/icon%20set.ZIP', './out/icons.tar.gz']) {
    await manager.handleMessage(managed, { type: 'link.open', href });
    assert.equal(fileCopies.at(-1)[1], saveDestination);
    assert.equal(fileCopies.at(-1)[2].overwrite, true);
  }
  assert.equal(saveDialogs.at(-1).defaultUri.fsPath, '/workspace/out/icons.tar.gz');
  const copiesBefore = fileCopies.length;
  saveDestination = undefined;
  await manager.handleMessage(managed, { type: 'link.open', href: '/workspace/out/icons.zip' });
  assert.equal(fileCopies.length, copiesBefore, 'Cancelling must not copy or open the archive');
  assert.equal(editorOpens.length, editorsBefore);
  assert.equal(textOpens.length, textsBefore);
  assert.equal(notices.length, 0);
});

test("task-assigned workers stay under the engine instead of legacy continuation", async () => {
  const agents = ['loop-owner', 'default-verifier', 'second-worker', 'second-verifier', 'legacy-worker']
    .map(agentId => ({ agentId, runId: 'run-one', status: 'completed', role: 'work' }));
  const workflows = [{ workAgentId: 'loop-owner', verificationAgentId: 'default-verifier', workflow: {
    tasks: [{ workAgentId: 'second-worker', verificationAgentId: 'second-verifier' }]
  } }];
  let listCalls = 0, workflowCalls = 0, observedDrive;
  const sharedClient = {
    async listChildSessions() { listCalls++; await new Promise(resolve => setImmediate(resolve)); return agents; },
    async advanceWorkflows(_agentId, _agents, drive) { workflowCalls++; observedDrive = drive; return workflows; }
  };
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: sharedClient }));
  let legacy;
  manager.scheduleAgentList = () => {};
  manager.reportWorkflowResults = async () => {};
  manager.continueBackgroundWork = async (_managed, children) => { legacy = children; };
  const messages = [];
  const panels = [1, 2].map(() => ({ state: { agentId: 'main-test' }, panel: { visible: true, webview: {
    async postMessage(message) { messages.push(message); return true; }
  } } }));
  await Promise.all(panels.map(panel => manager.sendAgentList(panel)));
  assert.equal(listCalls, 1, 'Equivalent panel refreshes must share one child lookup');
  assert.equal(workflowCalls, 1, 'Equivalent panel refreshes must share one workflow observation');
  assert.equal(observedDrive, false, 'UI refresh observes workflows without driving the engine');
  assert.deepEqual(legacy.map(agent => agent.agentId), ['legacy-worker']);
  assert.deepEqual(messages.map(message => message.type), ['agents.list', 'agents.list']);

  let isolatedCalls = 0;
  const clients = [1, 2].map(() => ({
    async listChildSessions() { isolatedCalls++; await new Promise(resolve => setImmediate(resolve)); return []; },
    async advanceWorkflows() { return []; }
  }));
  let connection = 0;
  const isolated = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: clients[connection++] }));
  isolated.scheduleAgentList = () => {};
  await Promise.all([1, 2].map(() => isolated.sendAgentList({ state: { agentId: 'main-test' }, panel: { webview: {
    async postMessage() { return true; }
  } } })));
  assert.equal(isolatedCalls, 2, 'Distinct runtime clients/projects must not share a lookup');
});

test("agent refresh waits from completion and backs off for idle or hidden panels", async t => {
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: {
    async listChildSessions() { await new Promise(resolve => setTimeout(resolve, 20)); return []; },
    async advanceWorkflows() { return []; }
  } }));
  const managed = { state: { agentId: 'main-refresh', role: 'main' }, panel: { visible: true, webview: {
    async postMessage() { return true; }
  } } };
  let ageAfterSlowRefresh;
  manager.scheduleAgentList = panel => { ageAfterSlowRefresh = Date.now() - panel.lastAgentRefreshAt; };
  await manager.sendAgentList(managed);
  assert.ok(ageAfterSlowRefresh < 25, 'A slow refresh must anchor its next delay at completion');

  delete manager.scheduleAgentList;
  t.after(() => { if (managed.agentRefreshTimer) clearTimeout(managed.agentRefreshTimer); });
  managed.lastAgentRefreshAt = Date.now();
  manager.scheduleAgentList(managed);
  assert.ok(managed.agentRefreshTimer._idleTimeout >= 4990 && managed.agentRefreshTimer._idleTimeout <= 5000);
  clearTimeout(managed.agentRefreshTimer);
  managed.agentRefreshTimer = undefined;
  managed.panel.visible = false;
  manager.scheduleAgentList(managed);
  assert.ok(managed.agentRefreshTimer._idleTimeout >= 14990 && managed.agentRefreshTimer._idleTimeout <= 15000);
  clearTimeout(managed.agentRefreshTimer);
  managed.agentRefreshTimer = undefined;
  managed.controller = { running: true };
  manager.scheduleAgentList(managed);
  assert.ok(managed.agentRefreshTimer._idleTimeout >= 1990 && managed.agentRefreshTimer._idleTimeout <= 2000);
  clearTimeout(managed.agentRefreshTimer);
});

test("concurrent panels claim each terminal workflow delivery once and retry recorded errors", async () => {
  const storage = new Map(), sends = [];
  const context = { workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
  } };
  const workflow = { loopId: 'loop-terminal', status: 'completed', workAgentId: 'work-terminal' };
  const client = { async listChildSessions() { await new Promise(resolve => setImmediate(resolve)); return []; },
    async dispatchAcceptance() { return null; },
    async result() { return { status: "completed", text: "Delivered report" }; },
    async advanceWorkflows() { return [workflow]; } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: true, client }));
  manager.scheduleAgentList = () => {};
  manager.continueBackgroundWork = async () => {};
  let fail = true;
  const panels = [1, 2].map(index => ({ state: { agentId: 'main-terminal' }, panel: { webview: {
    async postMessage() { return true; }
  } }, controller: { runId: "report-run", async send(_text, _attachments, _execution, accepted) {
    sends.push(index);
    if (fail) throw new Error('delivery failed');
    accepted();
  } } }));
  await Promise.all(panels.map(panel => manager.sendAgentList(panel)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.length, 1, 'Concurrent panels must make one terminal workflow delivery attempt');
  assert.equal(storage.get('agentFactory.workflowResults.main-terminal')['loop-terminal'].state, 'prepared');
  const identity = storage.get('agentFactory.workflowResults.main-terminal')['loop-terminal'].dispatchId;

  fail = false;
  await manager.sendAgentList(panels[1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.length, 2, 'A recorded delivery error must remain retryable');
  assert.equal(storage.get('agentFactory.workflowResults.main-terminal')['loop-terminal'].state, 'completed');
  assert.equal(storage.get('agentFactory.workflowResults.main-terminal')['loop-terminal'].dispatchId, identity,
    'Lost acknowledgement reuses its recorded dispatch identity');
});

function reportFixture() {
  const storage = new Map(), calls = [], notices = [];
  const context = { workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
  } };
  const flow = { loopId: "loop-report-recovery", status: "completed", latestWorkRunId: "work-original" };
  const connect = async () => ({ available: true, client: {
    async dispatchAcceptance() { return null; },
    async result() { return { status: "completed", text: "Reported exact result" }; }
  } });
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], connect);
  const managed = { state: { agentId: "main-report-recovery" }, panel: { webview: {
    async postMessage(message) { notices.push(message); return true; }
  } }, controller: { runId: "run-report", async send(text, _attachments, execution, accepted) {
    calls.push({ text, id: execution.deliveryId }); accepted();
  } } };
  const key = "agentFactory.workflowResults.main-report-recovery";
  const identity = JSON.stringify([flow.loopId, flow.status, flow.latestWorkRunId, undefined, undefined, undefined, undefined]);
  const legacyId = "report-" + createHash("sha256").update(identity).digest("hex").slice(0, 32) + "-1";
  const seed = (state, extra = {}) => storage.set(key, { [flow.loopId]: {
    identity, state, dispatchId: legacyId, message: "Preserve the original report bytes", attempt: 1, ...extra
  } });
  const deliver = async () => {
    await manager.reportWorkflowResults(managed, [flow]);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { storage, calls, notices, context, connect, flow, manager, managed, key, legacyId, seed, deliver };
}

test("terminal child status changes deliver once each, including out-of-order replay", async () => {
  const storage = new Map([["agentFactory.background.main-status", {}]]), calls = [], accepted = new Map();
  const context = { workspaceState: { get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); } } };
  const client = { async dispatchAcceptance(_agent, id) { return accepted.get(id); } };
  const connect = async () => ({ available: true, client });
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], connect);
  const managed = { state: { agentId: "main-status" }, controller: { runId: "report-status", async send(text, _images, execution, started) {
    calls.push(JSON.parse(text.split("\n")[1]).status); accepted.set(execution.deliveryId, { runId: this.runId }); started();
  } } };
  const child = { agentId: "work-status", runId: "run-status", status: "needs-human-decision", taskMode: "work", role: "work" };
  await manager.continueBackgroundWork(managed, [child]); await new Promise(resolve => setImmediate(resolve));
  await manager.continueBackgroundWork(managed, [{ ...child, status: "cancelled" }]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["needs-human-decision", "cancelled"]);
  const restored = new module.exports.ChatPanelManager(context, {}, () => [], connect);
  await restored.continueBackgroundWork(managed, [child]);
  await restored.continueBackgroundWork(managed, [{ ...child, status: "cancelled" }]);
  assert.equal(calls.length, 2);
});

const lifecycleActions = [
  { type: "task.stop", workflowId: "flow-late", taskId: "task-late", agentId: "work-late", runId: "run-late" },
  { type: "workflow.close", workAgentId: "work-late", loopId: "loop-late" },
  { type: "workflow.answer", workAgentId: "work-late", loopId: "loop-late", decisionId: "decision-late", questionHash: "a".repeat(64), answer: "Continue" },
  { type: "workflow.decision", workAgentId: "work-late", loopId: "loop-late", decision: "stop" }
];

test("late workflow actions never target or update a switched conversation", async () => {
  for (const message of lifecycleActions) for (const phase of ["connect", "result", "children", "error"]) {
    const f = reportFixture(); const actions = [], posted = [];
    let release, reached;
    const waiting = new Promise(resolve => { reached = resolve; });
    const wait = () => { reached(); return new Promise(resolve => { release = resolve; }); };
    const action = async agent => {
      actions.push(agent);
      if (phase === "result" || phase === "error") await wait();
      if (phase === "error") throw new Error("old conversation failure");
      return { loopId: "loop-late", status: "cancelled" };
    };
    const client = { stopTask: action, closeWorkflow: action, answerWorkflow: action, decideRevisionLimit: action,
      async listChildSessions() { if (phase === "children") await wait(); return []; } };
    f.manager.connectRuntime = async () => { if (phase === "connect") await wait(); return { available: true, client }; };
    f.manager.post = async (_panel, msg) => { posted.push(msg); };
    const pending = f.manager.handleMessage(f.managed, message);
    await waiting;
    f.managed.state.agentId = "main-switched";
    f.managed.state.conversationId = "conversation-switched";
    release(); await pending;
    assert.deepEqual(actions, phase === "connect" ? [] : ["main-report-recovery"], `${message.type}/${phase}`);
    assert.deepEqual(posted, [], `${message.type}/${phase}: old state/error must not reach the new chat`);
  }
});

test("identical rapid workflow actions invoke the runtime once and remain retryable after failure", async () => {
  for (const message of lifecycleActions.slice(1)) {
    const f = reportFixture(); let release, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const action = async () => { calls++; await gate; return { status: "cancelled" }; };
    const client = { closeWorkflow: action, answerWorkflow: action, decideRevisionLimit: action, async listChildSessions() { return []; } };
    f.manager.connectRuntime = async () => ({ available: true, client });
    const first = f.manager.handleMessage(f.managed, message), second = f.manager.handleMessage(f.managed, message);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, message.type);
    release(); await Promise.all([first, second]);
    client.closeWorkflow = client.answerWorkflow = client.decideRevisionLimit = async () => { calls++; throw new Error("transient failure"); };
    await f.manager.handleMessage(f.managed, message);
    await f.manager.handleMessage(f.managed, message);
    assert.equal(calls, 3, "A finished or failed attempt must release its in-flight identity");
  }
});

test("late report failures remain with their original conversation", async () => {
  for (const delivery of ["workflow", "child"]) {
    const f = reportFixture(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    if (delivery === "workflow") {
      f.manager.connectRuntime = async () => ({ available: true, client: { async dispatchAcceptance() { return undefined; },
        async result() { await gate; throw new Error("old report result unavailable"); } } });
      await f.deliver();
    } else {
      f.storage.set(`agentFactory.background.${f.managed.state.agentId}`, {});
      f.managed.controller.send = async () => { await gate; throw new Error("old child report transport failure"); };
      await f.manager.continueBackgroundWork(f.managed, [{ agentId: "work-late", runId: "run-late", role: "work", status: "completed", taskMode: "work" }]);
    }
    f.managed.state.agentId = "main-switched";
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.notices, [], delivery);
  }
});

test("panel runtime stays bound when the workspace starts returning another project's client", async () => {
  const f = reportFixture(), calls = [];
  const client = id => ({ async listChildSessions() { calls.push(id); return []; }, async advanceWorkflows() { return []; },
    async listProjectTasks() { calls.push(`${id}:history`); return []; },
    async deleteTask() { calls.push(`${id}:delete`); } });
  f.managed.runtimeClient = client("original-project");
  f.manager.connectRuntime = async () => ({ available: true, client: client("other-project") });
  f.manager.scheduleAgentList = () => {};
  await f.manager.sendAgentList(f.managed);
  await f.manager.handleMessage(f.managed, { type: "project.tasks.request" });
  const foreignNotices = [];
  f.manager.panels.set("original", f.managed);
  f.manager.panels.set("foreign", { state: { agentId: f.managed.state.agentId }, runtimeClient: client("other-project"),
    panel: { webview: { async postMessage(message) { foreignNotices.push(message); } } } });
  f.manager.sendAgentList = async () => {};
  await f.manager.handleMessage(f.managed, { type: "task.delete", workflowId: "flow-original", taskId: "task-original" });
  assert.deepEqual(calls, ["original-project", "original-project:history", "original-project:delete"]);
  assert.deepEqual(foreignNotices, [], "Deleting one project's history cannot invalidate another project's cache");
});

test("project history failure arriving after deletion cannot replace the refreshed history", async () => {
  const f = reportFixture();
  let reject;
  f.managed.runtimeClient = { listProjectTasks() { return new Promise((_resolve, fail) => { reject = fail; }); } };
  const pending = f.manager.handleMessage(f.managed, { type: "project.tasks.request" });
  await new Promise(resolve => setImmediate(resolve));
  f.manager.taskHistoryRevision++;
  reject(new Error("Old history read failed"));
  await pending;
  assert.deepEqual(f.notices, []);
});

test("worker questions reach Main once with their identity and conversation-only clarification guidance", async () => {
  const f = reportFixture();
  f.flow.status = "needs-human-decision";
  f.flow.pendingDecision = { id: "decision-one", questionHash: "captured-question", status: "pending",
    question: "Internal bookkeeping failed; a concrete choice must be identified before asking." };
  await f.deliver();
  await f.deliver();
  assert.equal(f.calls.length, 1, "Polling must not repeat a delivered question");
  const payload = JSON.parse(f.calls[0].text.split("\n")[1]);
  assert.deepEqual(payload.pendingDecision, f.flow.pendingDecision);
  assert.equal(payload.loopId, f.flow.loopId);
  assert.match(f.calls[0].text, /In the Main conversation, summarize the blocker/);
  assert.match(f.calls[0].text, /without inventing an approval request/);
  assert.match(f.calls[0].text, /only after it is received/);
  assert.equal(f.notices.length, 0, "The internal question is not emitted as a raw host notice");
});

test("generated report IDs satisfy the real plugin CLI validator, including boundary characters", async () => {
  const f = reportFixture();
  await f.deliver();
  const { DISPATCH_ID } = await importTypeScript("src/common/types/agent-runtime.ts");
  const ids = [f.calls[0].id, f.legacyId, "dispatch-a:b", "dispatch-" + "a".repeat(128),
    "dispatch-" + "a".repeat(129), "dispatch-", "dispatch-a/", "dispatch-a\n"];
  const plugin = new URL("../../../plugin/scripts/exec.py", import.meta.url).pathname;
  const actual = JSON.parse(execFileSync("python3", ["-B", "-c",
    "import json,runpy,sys; cli=runpy.run_path(sys.argv[1]); print(json.dumps([bool(cli['DISPATCH_ID'].fullmatch(v)) for v in json.loads(sys.argv[2])]))",
    plugin, JSON.stringify(ids)], { encoding: "utf8" }));
  assert.deepEqual(actual, [true, false, true, true, false, false, false, false]);
  assert.deepEqual(ids.map(id => DISPATCH_ID.test(id)), actual);
});

test("unaccepted legacy reports migrate once without replacing their message, attempt or Work", async () => {
  const f = reportFixture(); f.seed("prepared");
  await f.deliver(); await f.deliver();
  assert.deepEqual(f.calls, [{ text: "Preserve the original report bytes", id: "dispatch-" + f.legacyId }]);
  const saved = f.storage.get(f.key)[f.flow.loopId];
  assert.equal(saved.state, "completed"); assert.equal(saved.attempt, 1);
  assert.equal(JSON.parse(saved.identity)[2], "work-original");
});

test("accepted legacy reports are observed without rewriting their dispatch identity", async () => {
  const f = reportFixture(); f.seed("accepted", { runId: "run-existing" });
  await f.deliver();
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].dispatchId, f.legacyId);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "completed");
});

test("unrecognized malformed reports are blocked once across restored panels", async () => {
  const f = reportFixture(); f.seed("prepared", { dispatchId: "report-unrecognized" });
  await f.deliver(); await f.deliver();
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], f.connect);
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 1);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "blocked");
});

test("real controller routes structured permanent rejection to durable report state exactly once", async () => {
  const f = reportFixture();
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const rejection = Object.assign(new Error("dispatch identifier was used with a different immutable tuple"), { code: "dispatch_id_collision" });
  const rawErrors = [];
  f.managed.controller = new ChatSessionController({
    async send(_agent, _message, execution) { f.calls.push(execution.deliveryId); throw rejection; }
  }, { onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onAssistantText() {},
    onError(message) { rawErrors.push(message); }
  }, f.managed.state.agentId);
  await f.deliver(); await f.deliver();
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], f.connect);
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  assert.equal(f.calls.length, 1); assert.equal(f.notices.length, 1);
  assert.deepEqual(rawErrors, []);
  assert.equal(f.managed.controller.running, false);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "blocked");
});

test("ambiguous report failures retain the key and suppress duplicate error notices", async () => {
  const f = reportFixture();
  f.managed.controller.send = async (_text, _images, execution) => {
    f.calls.push(execution.deliveryId); throw new Error("Connection lost before acknowledgement");
  };
  await f.deliver(); await f.deliver();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0], f.calls[1]);
  assert.equal(f.notices.length, 1);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "prepared");
});

test("diagnostic refreshes do not repeat reports, but a new result or decision does", async () => {
  const f = reportFixture();
  f.flow.controlPlaneError = { code: "task_target_busy", message: "old diagnostic" };
  await f.deliver();
  f.flow.controlPlaneError = { message: "refreshed diagnostic", code: "task_target_busy" };
  f.flow.terminalReason = { code: "work-completed", message: "different wording" };
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], f.connect);
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  assert.equal(f.calls.length, 1);
  f.flow.latestWorkRunId = "new-work";
  await f.deliver();
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].id, f.calls[1].id);
  f.flow.status = "needs-human-decision";
  f.flow.pendingDecision = { id: "decision-new", questionHash: "question-one", status: "pending" };
  await f.deliver();
  f.flow.pendingDecision = { status: "pending", questionHash: "question-one", id: "decision-new" };
  await f.deliver();
  assert.equal(f.calls.length, 3);
  f.flow.pendingDecision.questionHash = "question-two";
  await f.deliver();
  assert.equal(f.calls.length, 4);
});

test("cancelled, empty and failed Main reports stop automatic retry across restoration", async () => {
  for (const result of [{ status: "cancelled", text: "" }, { status: "failed", text: "partial", error: { code: "provider_failed" } },
    { status: "completed", text: "" }]) {
    const f = reportFixture();
    f.manager.connectRuntime = async () => ({ available: true, client: { async result() { return result; } } });
    await f.deliver(); await f.deliver();
    const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], f.connect);
    await restored.reportWorkflowResults(f.managed, [f.flow]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "failed");
  }
  const f = reportFixture(); f.seed("failed", { runId: "cancelled-legacy" });
  await f.deliver();
  assert.equal(f.calls.length, 0, "Legacy failed attempts must not start a new numbered report");
});

test("lost report ACK is recovered by observing acceptance without replaying Main output", async () => {
  const f = reportFixture();
  f.managed.controller.send = async (_text, _images, execution) => {
    f.calls.push(execution.deliveryId); throw new Error("ACK lost after runtime acceptance");
  };
  await f.deliver();
  const lookups = [], results = [];
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], async () => ({ available: true, client: {
    async dispatchAcceptance(agentId, id) { lookups.push([agentId, id]); return { agentId, runId: "accepted-report" }; },
    async result(agentId, runId) { results.push([agentId, runId]); return { status: "completed", text: "already delivered" }; }
  } }));
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(lookups, [[f.managed.state.agentId, f.calls[0]]]);
  assert.deepEqual(results, [[f.managed.state.agentId, "accepted-report"]]);
  assert.equal(f.storage.get(f.key)[f.flow.loopId].state, "completed");
});

test("successful conversation reset suppresses old workflows and children while new completion still arrives", async () => {
  const f = reportFixture();
  f.manager.ensureController = async () => {};
  f.manager.rememberAgent = async () => {};
  f.manager.scheduleAgentList = () => {};
  f.managed.controller.resetConversation = async () => ({ conversationId: "conversation-new" });
  f.manager.connectRuntime = async () => ({ available: true, client: {
    async listChildSessions() { return []; }, async capabilities() { return {}; },
    async result() { return { status: "completed", text: "delivered" }; }
  } });
  f.managed.state.conversationId = "conversation-old";
  f.flow.parentConversationId = "conversation-old";
  await f.manager.transitionConversation(f.managed);
  assert.equal(f.managed.state.conversationId, "conversation-new");
  await f.deliver();
  f.storage.set(`agentFactory.background.${f.managed.state.agentId}`, {});
  await f.manager.continueBackgroundWork(f.managed, [{ agentId: "work-old", runId: "run-old", taskMode: "work",
    status: "completed", role: "work", parentConversationId: "conversation-old", currentConversation: false }]);
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], f.connect);
  await restored.reportWorkflowResults(f.managed, [f.flow]);
  assert.equal(f.calls.length, 0, "Reset must not inject the old completion into the new conversation");
  f.flow.parentConversationId = "conversation-new"; f.flow.latestWorkRunId = "new-work";
  await f.deliver(); await f.deliver();
  assert.equal(f.calls.length, 1);
});

test("stale workflow refresh cannot deliver after reset or task history deletion", async () => {
  for (const change of ["reset", "delete"]) {
    const f = reportFixture();
    let release;
    f.manager.scheduleAgentList = () => {};
    f.manager.connectRuntime = async () => ({ available: true, client: {
      async listChildSessions() { await new Promise(resolve => { release = resolve; }); return []; },
      async advanceWorkflows() { return [f.flow]; }
    } });
    const refresh = f.manager.sendAgentList(f.managed);
    await new Promise(resolve => setImmediate(resolve));
    if (change === "reset") f.managed.state.conversationId = "conversation-new";
    else f.manager.taskHistoryRevision++;
    release(); await refresh;
    assert.equal(f.calls.length, 0, change);
    assert.equal(f.storage.has(f.key), false);
  }
});

test("deleting a task blocks new reports and invalidates an already prepared intent", async () => {
  const f = reportFixture();
  f.flow.workflow = { id: "flow-delete", tasks: [{ id: "task-delete" }] };
  const deletingKey = `${f.managed.state.agentId}/flow-delete/task-delete`;
  f.manager.taskDeletesPending.add(deletingKey);
  await f.deliver();
  assert.equal(f.calls.length, 0);
  f.manager.taskDeletesPending.delete(deletingKey);
  let release;
  const update = f.context.workspaceState.update;
  f.context.workspaceState.update = async (...args) => { await new Promise(resolve => { release = resolve; }); return update(...args); };
  const preparing = f.manager.reportWorkflowResults(f.managed, [f.flow]);
  await new Promise(resolve => setImmediate(resolve));
  f.manager.taskDeletesPending.add(deletingKey);
  f.manager.taskHistoryRevision++;
  release(); await preparing;
  assert.equal(f.calls.length, 0, "No controller send after a deletion races with durable intent storage");
});

test("simultaneous terminal workflows retain both durable acknowledgements", async () => {
  const f = reportFixture();
  const update = f.context.workspaceState.update;
  f.context.workspaceState.update = async (...args) => { await new Promise(resolve => setImmediate(resolve)); return update(...args); };
  const other = { ...f.managed, controller: { ...f.managed.controller } };
  const flow2 = { ...f.flow, loopId: "loop-other", latestWorkRunId: "work-other" };
  await Promise.all([f.manager.reportWorkflowResults(f.managed, [f.flow]), f.manager.reportWorkflowResults(other, [flow2])]);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Object.values(f.storage.get(f.key)).map(value => value.state), ["completed", "completed"]);
  await f.manager.reportWorkflowResults(f.managed, [f.flow, flow2]);
  assert.equal(f.calls.length, 2);
});

test("out-of-order duplicate completions use runtime acceptance even after the local latest event changes", async () => {
  const f = reportFixture();
  const accepted = new Map();
  const client = { async dispatchAcceptance(_agent, id) { return accepted.get(id); },
    async result() { return { status: "completed", text: "report" }; } };
  const connect = async () => ({ available: true, client });
  f.manager.connectRuntime = connect;
  f.managed.controller.send = async (text, _images, execution, started) => {
    f.calls.push({ text, id: execution.deliveryId });
    accepted.set(execution.deliveryId, { runId: "report-" + f.calls.length });
    f.managed.controller.runId = "report-" + f.calls.length; started();
  };
  const original = { ...f.flow };
  await f.deliver();
  f.flow.latestWorkRunId = "new-work";
  await f.deliver();
  assert.equal(f.calls.length, 2);
  const restored = new module.exports.ChatPanelManager(f.context, {}, () => [], connect);
  await restored.reportWorkflowResults(f.managed, [{ ...original, controlPlaneError: { code: "stale-diagnostic" } }]);
  await restored.reportWorkflowResults(f.managed, [original]);
  assert.equal(f.calls.length, 2, "An old accepted event must be observed, never replayed through the controller");
  f.storage.clear();
  await restored.reportWorkflowResults(f.managed, [original]);
  assert.equal(f.calls.length, 2, "Runtime identity survives local Memento loss");
});

test("concurrent diagnostic variants claim the same completion event", async () => {
  const f = reportFixture();
  const other = { ...f.managed, controller: { ...f.managed.controller } };
  await Promise.all([
    f.manager.reportWorkflowResults(f.managed, [{ ...f.flow, controlPlaneError: { code: "busy", message: "first" } }]),
    f.manager.reportWorkflowResults(other, [{ ...f.flow, controlPlaneError: { message: "second", code: "busy" } }])
  ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

test("concurrent panels claim a legacy terminal child delivery once", async () => {
  const storage = new Map([['agentFactory.background.main-child', { 'work-child/run-child': 'running' }]]), sends = [];
  const context = { workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
  } };
  const child = { agentId: 'work-child', runId: 'run-child', role: 'work', status: 'completed', taskMode: 'work' };
  const client = { async listChildSessions() { await new Promise(resolve => setImmediate(resolve)); return [child]; } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: true, client }));
  manager.scheduleAgentList = () => {};
  const panels = [1, 2].map(index => ({ state: { agentId: 'main-child' }, panel: { webview: {
    async postMessage() { return true; }
  } }, controller: { conversationResetBlockedReason: undefined, async send(_text, _attachments, _execution, accepted) {
    sends.push(index); accepted();
  } } }));
  await Promise.all(panels.map(panel => manager.sendAgentList(panel)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends.length, 1, 'Concurrent panels must make one legacy child delivery attempt');
  assert.equal(storage.get('agentFactory.background.main-child')['work-child/run-child'].state, 'accepted');
});


test('six same-worker tasks reach the panel intact without legacy redispatch after reconnect', async () => {
  const workflow = { loopId: 'loop-six', workAgentId: 'shared-worker', taskMode: 'work', status: 'runtime-error',
    workflow: { id: 'six', title: 'Six tasks', index: 1, tasks: Array.from({ length: 6 }, (_, index) => ({
      id: `task-${index + 1}`, title: `Task ${index + 1}`, workAgentId: 'shared-worker',
      workStatus: index === 0 ? 'completed' : index === 1 ? 'failed' : 'pending',
      ...(index < 2 ? { workRunId: `run-${index + 1}` } : {}) })) } };
  const agents = [{ agentId: 'shared-worker', runId: 'run-2', role: 'work', status: 'failed' }];
  const messages = [], legacy = [];
  for (let reconnect = 0; reconnect < 2; reconnect += 1) {
    const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: {
      async listChildSessions() { return agents; }, async advanceWorkflows() { return [structuredClone(workflow)]; }
    } }));
    manager.scheduleAgentList = () => {};
    manager.reportWorkflowResults = async () => {};
    manager.continueBackgroundWork = async (_managed, children) => { legacy.push(...children); };
    await manager.sendAgentList({ state: { agentId: 'main-six' }, panel: { webview: {
      async postMessage(message) { messages.push(message); return true; }
    } } });
  }
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.type, 'agents.list');
    assert.deepEqual(message.workflows, [workflow]);
    assert.equal(message.workflows[0].workflow.tasks.length, 6);
  }
  assert.deepEqual(legacy, [], 'Failed loop tasks must not become legacy follow-up work');
});

test("engine terminal notification reports the bound outcome once without re-executing work", async () => {
  for (const [status, code] of [["completed", "work-completed"], ["completed", "pass"],
    ["runtime-error", "needs-human-decision"], ["runtime-error", "failed"], ["runtime-error", "cancelled"]]) {
    const storage = new Map(), calls = [];
    const manager = new module.exports.ChatPanelManager({ workspaceState: {
      get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
    } }, {}, () => [], async () => ({ available: true, client: {
      async result() { return { status: code === "failed" ? "failed" : "completed", text: "The exact outcome was reported" }; }
    } }));
    const managed = { state: { agentId: "main-report" }, controller: { runId: "report-run",
      async send(text, attachments, execution, accepted) { calls.push({ text, execution }); accepted(); }
    } };
    const flow = { loopId: "bound-loop", status, terminalReason: { code }, latestWorkRunId: "exact-work" };
    await manager.reportWorkflowResults(managed, [flow]);
    await new Promise(resolve => setImmediate(resolve));
    await manager.reportWorkflowResults(managed, [flow]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].execution.taskMode, "direct");
    assert.match(calls[0].text, /exact-work/);
    assert.match(calls[0].text, /Do not review implementation or rerun tests/);
    assert.match(calls[0].text, /Goal completion alone is not a pass/);
    assert.equal(JSON.parse(calls[0].text.split("\n")[1]).terminalReason.code, code);
  }
});

test('global bot setting disposes every companion and prevents inference while preserving chat controllers', async () => {
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error('not used'); });
  let disposed = 0, inferred = 0;
  const messages = [];
  const controller = { running: true };
  for (const id of ['main', 'work', 'verification']) {
    manager.panels.set(id, { controller, panel: { webview: { async postMessage(m) { messages.push(m); return true; } } },
      lunaBot: { dispose() { disposed++; }, react() { inferred++; } } });
  }
  configuredMode = false;
  try {
    for (const panel of manager.panels.values()) manager.reactBot(panel);
    assert.equal(inferred, 0);
    await manager.refreshBots();
    assert.equal(disposed, 3);
    assert.equal(messages.filter(m => m.type === 'bots.updated' && m.enabled === false).length, 3);
    for (const panel of manager.panels.values()) {
      assert.equal(panel.lunaBot, undefined);
      assert.equal(panel.controller, controller);
    }
    configuredMode = true;
    await manager.refreshBots();
    const panel = manager.panels.get('main');
    let lateReply;
    panel.lunaBot = { react(_context, publish) { inferred++; lateReply = publish; }, dispose() {} };
    manager.reactBot(panel);
    assert.equal(inferred, 1);
    configuredMode = false;
    lateReply('cheerful');
    assert.equal(messages.some(m => m.type === 'bot.mood'), false);
    await manager.handleMessage(panel, { type: 'bots.configure', enabled: false });
    assert.deepEqual(configUpdates.at(-1), ['botsEnabled', false, vscode.ConfigurationTarget.Global]);
  } finally { configuredMode = undefined; }
});

test('bot talk validates drafts, forwards only their text and reports failure without submitting work', async () => {
  const posted = [], seen = [];
  const manager = new module.exports.ChatPanelManager({ globalState: { get: (_key, fallback) => fallback, async update() {} } }, {}, () => [], async () => { throw Error('Must not connect task runtime'); });
  let enabled = true;
  manager.botsEnabled = () => enabled;
  const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    lunaBot: { async talk(text) { seen.push(text); if (text === 'fail') throw Error('auth'); return 'hello'; } } };
  for (const message of [{ type: 'bot.talk', text: 'x' }, { type: 'bot.talk', requestId: 'x', text: ' ' },
    { type: 'bot.talk', requestId: '<script>', text: 'x' }]) await manager.handleMessage(managed, message);
  assert.equal(seen.length, 0);
  posted.length = 0; // Invalid messages produce normal protocol notices, not bot replies.
  await manager.handleMessage(managed, { type: 'bot.talk', requestId: 'one', text: 'draft', history: ['not forwarded'] });
  assert.deepEqual(seen, ['draft']);
  assert.deepEqual(JSON.parse(JSON.stringify(posted.pop())), { type: 'bot.reply', requestId: 'one', text: 'hello' });
  await manager.handleMessage(managed, { type: 'bot.talk', requestId: 'two', text: 'fail' });
  assert.equal(posted.pop().failed, true);
  enabled = false;
  await manager.handleMessage(managed, { type: 'bot.talk', requestId: 'three', text: 'disabled' });
  assert.equal(seen.length, 2);
  assert.equal(posted.pop().failed, true);
  enabled = true;
  let finish;
  managed.lunaBot.talk = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.handleMessage(managed, { type: 'bot.talk', requestId: 'four', text: 'late' });
  await new Promise(resolve => setImmediate(resolve));
  managed.disposed = true; finish('late'); await pending;
  assert.equal(posted.length, 0);
});

test('bot prompt saves globally and is read fresh for subsequent talks; failed save retains config', async () => {
  const original = vscode.workspace.getConfiguration;
  const config = { botsEnabled: true, botCharacter: 'factory', factoryBotPrompt: 'initial' }, posts = [], calls = [], writes = [];
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => config[key] ?? fallback,
    async update(key, value, target) { if (value === 'reject') throw Error('save'); writes.push({ key, value, target }); config[key] = value; }
  });
  try {
    const manager = new module.exports.ChatPanelManager({ globalState: { get: (_key, fallback) => fallback, async update() {} } }, {}, () => [], async () => { throw Error('not used'); });
    const managed = { state: {}, panel: { webview: { async postMessage(message) { posts.push(message); return true; } } },
      lunaBot: { async talk(text, prompt) { calls.push({ text, prompt }); return 'ok'; } } };
    manager.panels.set('bot-prompt-test', managed);
    await manager.handleMessage(managed, { type: 'bot.prompt.save', requestId: 'save1', prompt: '친절하게\n답변하세요' });
    assert.equal(writes[0].target, vscode.ConfigurationTarget.Global);
    assert.equal(config.factoryBotPrompt, '친절하게\n답변하세요');
    assert.equal(posts.find(post => post.type === 'bots.updated').botPrompt, config.factoryBotPrompt);
    assert.equal(posts.at(-1).type, 'bot.prompt.saved');
    await manager.handleMessage(managed, { type: 'bot.talk', requestId: 'talk1', text: 'hello' });
    assert.deepEqual(calls[0], { text: 'hello', prompt: config.factoryBotPrompt });
    await manager.handleMessage(managed, { type: 'bot.prompt.save', requestId: 'save2', prompt: 'reject' });
    assert.equal(posts.at(-1).failed, true);
    assert.equal(config.factoryBotPrompt, '친절하게\n답변하세요');
    await manager.handleMessage(managed, { type: 'bot.prompt.save', requestId: 'save3', prompt: '' });
    assert.equal(config.factoryBotPrompt, '');
    await manager.handleMessage(managed, { type: 'bot.talk', requestId: 'talk2', text: 'next' });
    assert.match(calls[1].prompt, /Factory Bot/);
  } finally { vscode.workspace.getConfiguration = original; }
});

test('clear progress covers slow preflight, blocks duplicates and ends on failure', async () => {
  const posted = [];
  let rejectPreflight;
  let attempts = 0;
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({}));
  manager.ensureController = () => {
    attempts++;
    return new Promise((_resolve, reject) => { rejectPreflight = reject; });
  };
  const managed = {
    state: { role: 'main', agentId: 'main-test' },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } }
  };
  const transition = manager.transitionConversation(managed);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted[0].type, 'conversation.clearing');
  assert.equal(posted[0].busy, true);
  const duplicate = manager.transitionConversation(managed);
  assert.equal(attempts, 1);
  rejectPreflight(new Error('preflight unavailable'));
  await Promise.all([transition, duplicate]);
  assert.ok(posted.some(message => message.level === 'error'));
  assert.equal(posted.at(-1).type, 'conversation.clearing');
  assert.equal(posted.at(-1).busy, false);
  assert.equal(managed.sessionTransition, undefined);
  assert.equal(managed.state.agentId, 'main-test');
});

test('queue resume reaches the controller and coalesces concurrent button requests', async () => {
  const posted = [];
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({}));
  const managed = {
    state: {}, panel: { webview: { async postMessage(message) { posted.push(message); } } },
    controller: { async reconnect() { calls++; await pending; } }
  };
  const first = manager.handleMessage(managed, { type: 'queue.resume' });
  await manager.handleMessage(managed, { type: 'queue.resume' });
  assert.equal(calls, 1);
  finish(); await first;
  assert.equal(posted.length, 0);
  await manager.handleMessage(managed, { type: 'queue.resume' });
  assert.equal(calls, 2);
});

test('queue resume failure is actionable and allows a subsequent retry', async () => {
  const posted = [];
  let calls = 0;
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({}));
  const managed = {
    state: {}, panel: { webview: { async postMessage(message) { posted.push(message); } } },
    controller: { async reconnect() { if (++calls === 1) throw new Error('fixture reconnect failure'); } }
  };
  await manager.handleMessage(managed, { type: 'queue.resume' });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].level, 'error');
  assert.match(posted[0].text, /Could not resume queued messages/);
  assert.doesNotMatch(posted[0].text, /fixture reconnect failure/);
  assert.equal(diagnostics.at(-1)[0], '[Agent Factory] Queue resume failed');
  assert.equal(diagnostics.at(-1)[1].message, 'fixture reconnect failure');
  await manager.handleMessage(managed, { type: 'queue.resume' });
  assert.equal(calls, 2);
  assert.equal(posted.length, 1);
  delete managed.controller;
  await manager.handleMessage(managed, { type: 'queue.resume' });
  assert.equal(posted.length, 2);
});

test('invalid chat requests log the operation without private payloads', async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({}));
  const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); } } } };
  await manager.handleMessage(managed, { type: 'chat.send', text: 'private text', password: 'private password' });
  assert.match(posted[0].text, /chat screen request could not be processed/);
  assert.equal(diagnostics.at(-1)[1].type, 'chat.send');
  assert.equal(diagnostics.at(-1)[1].reason, 'protocol-validation-failed');
  assert.doesNotMatch(JSON.stringify(diagnostics.at(-1)), /private text|private password/);
});


test("task role opens and focuses only its existing child chat without starting a session", async () => {
  const posted = [], created = [], attached = [], reveals = [], originalCreate = vscode.window.createWebviewPanel;
  const child = { agentId: "exact-worker", runId: "exact-run", role: "work", status: "running", model: "captured-worker", workProfile: "workLight" };
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({
    available: true, client: { async listChildSessions(id) { assert.equal(id, "main-owner"); return [child]; } }
  }));
  manager.newChatPreferences = () => ({ model: "different-main-setting" });
  manager.webviewOptions = () => ({});
  manager.attach = async (panel, state) => { attached.push(state); manager.panels.set(state.panelId, { panel, state }); };
  vscode.window.createWebviewPanel = (...args) => { created.push(args); return { webview: { async postMessage(message) { posted.push(message); } }, reveal(...args) { reveals.push(args); } }; };
  const main = { state: { role: "main", agentId: "main-owner" }, panel: { webview: { async postMessage(message) { posted.push(message); } } } };
  try {
    await manager.openChildAgent(main, "exact-worker");
    assert.equal(created.length, 1);
    assert.equal(attached[0].agentId, "exact-worker");
    assert.equal(attached[0].role, "work");
    assert.equal(attached[0].capturedRun.model, "captured-worker");
    assert.equal(attached[0].model, "different-main-setting");
    await manager.openChildAgent(main, "exact-worker");
    assert.equal(created.length, 1);
    assert.deepEqual(reveals, [[undefined, false]], "Existing tab receives focus");
    for (const id of ["main-owner", "other-worker"]) await manager.openChildAgent(main, id);
    assert.equal(created.length, 1);
    assert.equal(posted.filter(message => message.type === "host.notice").length, 2);
    assert.equal(posted.find(message => message.type === "agent.run.selected").capturedRun.runId, "exact-run");
  } finally { vscode.window.createWebviewPanel = originalCreate; }
});


test('role clicks retarget the same tab to an exact old run without changing send options', async () => {
  const posted = [], created = [], attached = [], reveals = [], originalCreate = vscode.window.createWebviewPanel;
  const runs = [
    { agentId: 'worker-one', runId: 'run-old', role: 'work', model: 'old-worker-model', workProfile: 'workLight' },
    { agentId: 'worker-one', runId: 'run-new', role: 'work', model: 'new-expert-model', workProfile: 'work' },
    { agentId: 'verifier-one', runId: 'run-v', role: 'verification' }
  ];
  const client = { async childRun(main, agent, run) {
    assert.equal(main, 'main-owner'); return runs.find(value => value.agentId === agent && value.runId === run);
  }, async submit() { assert.fail('Opening must not submit'); }, async send() { assert.fail('Opening must not send'); } };
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client }));
  manager.newChatPreferences = () => ({ model: 'next-send-setting' }); manager.webviewOptions = () => ({});
  manager.attach = async (panel, state) => { attached.push(state); manager.panels.set(state.panelId, { panel, state }); };
  vscode.window.createWebviewPanel = () => { created.push(1); return { webview: { async postMessage(value) { posted.push(value); } }, reveal() { reveals.push(1); } }; };
  const main = { state: { agentId: 'main-owner', role: 'main' }, panel: { webview: { async postMessage(value) { posted.push(value); } } } };
  try {
    await manager.handleMessage(main, { type: 'agent.open', agentId: 'worker-one', runId: 'run-new' });
    await manager.handleMessage(main, { type: 'agent.open', agentId: 'worker-one', runId: 'run-old' });
    assert.equal(created.length, 1); assert.equal(reveals.length, 1);
    const state = [...manager.panels.values()][0].state;
    assert.equal(state.capturedRun.runId, 'run-old'); assert.equal(state.capturedRun.model, 'old-worker-model');
    assert.equal(state.capturedRun.workProfile, 'workLight'); assert.equal(state.model, 'next-send-setting');
    await manager.handleMessage(main, { type: 'agent.open', agentId: 'verifier-one', runId: 'run-v' });
    assert.equal(attached[1].capturedRun.model, undefined);
    await manager.handleMessage(main, { type: 'agent.open', agentId: 'worker-one', runId: 'nonexistent' });
    assert.equal(created.length, 2); assert.equal(posted.at(-1).type, 'host.notice');
  } finally { vscode.window.createWebviewPanel = originalCreate; }
});


test('restoring an existing child tab rereads its historical run and rejects stale cache values', async () => {
  const posted = [], revealed = [], disposed = [];
  const capturedRun = { parentAgentId: 'main-owner', agentId: 'worker-one', runId: 'run-old', model: 'stale-cache' };
  let missing = false;
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: {
    async childRun(parent, agentId, runId) {
      assert.deepEqual([parent, agentId, runId], ['main-owner', 'worker-one', 'run-old']);
      return missing ? undefined : { agentId, runId, role: 'work', model: 'captured-old', workProfile: 'workLight' };
    }
  } }));
  manager.newChatPreferences = () => ({ model: 'changed-main' });
  const existing = { state: { panelId: 'existing', agentId: 'worker-one', role: 'work', model: 'next-send' },
    panel: { reveal() { revealed.push(1); }, webview: { async postMessage(value) { posted.push(value); } } } };
  manager.panels.set('existing', existing);
  const duplicate = { viewColumn: 1, dispose() { disposed.push(1); } };
  await manager.revive(duplicate, { panelId: 'restored', agentId: 'worker-one', role: 'work', capturedRun });
  assert.equal(existing.state.capturedRun.model, 'captured-old'); assert.equal(existing.state.model, 'next-send');
  assert.equal(posted.at(-1).capturedRun.runId, 'run-old');
  missing = true;
  await manager.revive(duplicate, { panelId: 'restored', agentId: 'worker-one', role: 'work', capturedRun });
  assert.equal(existing.state.capturedRun, undefined); assert.equal(posted.at(-1).capturedRun, undefined);
  assert.equal(manager.panels.size, 1); assert.equal(revealed.length, 2); assert.equal(disposed.length, 2);
});


test("new chats copy the designated set once and restore without source or default-selection propagation", async () => {
  const originalConfiguration = vscode.workspace.getConfiguration;
  const originalFolders = vscode.workspace.workspaceFolders;
  const originalCreate = vscode.window.createWebviewPanel;
  const entries = {};
  for (const role of ['main', 'work', 'workLight', 'verification']) {
    entries[`${role}.model`] = {globalValue: `global-${role}`, workspaceFolderValue: `project-${role}`};
    entries[`${role}.reasoningEffort`] = {globalValue: 'high', workspaceFolderValue: 'medium'};
  }
  entries.fastByRoleModel = {globalValue: {main: {'global-main': true}}, workspaceFolderValue: {work: {'project-work': true}}};
  const sourceSettings=Object.fromEntries(['main','work','workLight','verification'].map(role=>[role,{model:`project-${role}`,reasoningEffort:'medium'}]));
  sourceSettings.fastByRoleModel={work:{'project-work':true}};
  const library={sets:[{id:'chosen',name:'Chosen',settings:sourceSettings},{id:'second',name:'Second',settings:{...structuredClone(sourceSettings),main:{model:'other-main',reasoningEffort:'high'}}}],projectDefaults:{'/project':'chosen'},migratedProjects:['/project']};
  const context = {globalState: {get: (key, fallback) => key === 'agentFactory.agentSets.v3' ? library : key === 'agentFactory.mainChat.composerPreferences' ? {fastMode:true, agentFastModes:{main:{'old-main':true}}} : fallback}};
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({available:false}));
  const attached = [];
  manager.webviewOptions = () => ({});
  manager.attach = async (_panel, state) => { attached.push(JSON.parse(JSON.stringify(state))); };
  vscode.workspace.workspaceFolders = [{uri: {fsPath:'/project'}}];
  vscode.workspace.getConfiguration = () => ({inspect: key => entries[key]});
  vscode.window.createWebviewPanel = () => ({});
  try {
    await manager.openDraft();
    const first = attached[0];
    assert.equal(first.model,'project-main'); assert.equal(first.fastMode,false);
    assert.deepEqual(first.agentFastModes,{work:{'project-work':true}});
    entries['main.model'].globalValue = 'changed-global';
    assert.equal(manager.newChatPreferences().model,'project-main');
    library.sets[0].settings.main.model = 'changed-project';
    library.sets[0].settings.work.model = 'changed-worker';
    library.sets[0].settings.fastByRoleModel.work['project-work'] = false;
    await manager.openDraft();
    assert.equal(attached[1].model,'changed-project'); assert.equal(attached[1].agentModels.work.model,'changed-worker');
    assert.equal(first.agentModels.work.model,'project-work'); assert.equal(first.agentFastModes.work['project-work'],true);
    library.projectDefaults['/project']='second';
    assert.equal(manager.newChatPreferences().model,'other-main');
    assert.equal(manager.newChatPreferences().agentSettingsSet,'Chat');
    await manager.revive({},first);
    assert.equal(attached[2].model,'project-main'); assert.equal(attached[2].agentModels.work.model,'project-work');
    assert.equal(attached[2].agentFastModes.work['project-work'],true);
    const applied = manager.applyAgentSettings({...first,fastMode:true}, {main:{model:'project-main',reasoningEffort:'medium'}}, 'chat','Default');
    assert.equal(applied.fastMode,false); assert.deepEqual(JSON.parse(JSON.stringify(applied.agentFastModes)),{});
  } finally {
    vscode.workspace.getConfiguration = originalConfiguration; vscode.workspace.workspaceFolders = originalFolders;
    vscode.window.createWebviewPanel = originalCreate;
  }
});

test("the Work isolation toggle is stored per project, defaults off and reaches every open panel", async () => {
  const storage = new Map(), posted = [];
  const context = { workspaceState: { get(key) { return storage.get(key); }, async update(key, value) { storage.set(key, value); } } };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: false }));
  const panels = ["one", "two"].map(panelId => ({
    state: { panelId, role: "main" },
    panel: { webview: { async postMessage(message) { posted.push([panelId, message]); return true; } } }
  }));
  for (const managed of panels) manager.panels.set(managed.state.panelId, managed);
  assert.equal(manager.workIsolation(), false);
  await manager.handleMessage(panels[0], { type: "workIsolation.set", value: true });
  assert.equal(storage.get("agentFactory.mainChat.workIsolation"), true);
  assert.equal(manager.workIsolation(), true);
  assert.equal(JSON.stringify(posted), JSON.stringify([["two", { type: "workIsolation.updated", value: true }]]));
  await manager.handleMessage(panels[1], { type: "workIsolation.set", value: false });
  assert.equal(manager.workIsolation(), false);
});


test("chat confirmation replay covers every accepted batch member after completion without dispatch", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("status must not connect runtime"); });
  const started = ["first", "second"].map(id => ({ type: "chat.started", id, text: id, attachments: [], submission: { taskMode: "work", businessMode: "planning", goal: false } }));
  const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    startedMessages: started, pendingMessageIds: new Set(["third"]), controller: { running: false } };
  await manager.handleMessage(managed, { type: "chat.status", ids: ["first", "second", "third", "unknown", "first"] });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [...started, { type: "chat.pending", id: "third" }, { type: "chat.rejected", id: "unknown" }]);
  posted.length = 0;
  await manager.handleMessage(managed, { type: "chat.send", id: "first", text: "first", attachments: [], execution: { fast: false, goal: false } });
  assert.deepEqual(posted, [started[0]], "a recovered accepted identity replays acknowledgement only");
});

test("chat identity is reserved before slow preparation and preparation preserves arrival order", async () => {
  let release;
  const probe = new Promise(resolve => { release = resolve; });
  const posted = [], sent = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: false }));
  let probes = 0;
  manager.refreshWorktree = async () => { if (++probes === 1) await probe; };
  manager.warnDirectBranch = async () => {};
  manager.ensureSudoBroker = async () => {};
  manager.sendChat = async (_managed, text) => { sent.push(text); };
  const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } } };
  const send = id => manager.handleMessage(managed, { type: "chat.send", id, text: id, attachments: [], execution: { fast: false, goal: false } });
  const first = send("first"), second = send("second");
  assert.deepEqual([...managed.pendingMessageIds], ["first", "second"]);
  await send("first");
  await manager.handleMessage(managed, { type: "chat.status", ids: ["first", "second"] });
  assert.ok(posted.every(message => message.type === "chat.pending"));
  assert.deepEqual(sent, []);
  release(); await Promise.all([first, second]);
  assert.deepEqual(sent, ["first", "second"]);
});

test("preparation failure rejects the original identity and does not stop later submissions", async () => {
  for (const archived of [false, true]) {
    const posted = [], sent = [];
    const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: false }));
    let probes = 0;
    manager.refreshWorktree = async managed => {
      if (++probes === 1) {
        if (!archived) throw new Error("probe failed");
        managed.worktree = { worktree: { workUnit: "unit", phase: "merged" } };
      } else managed.worktree = undefined;
    };
    manager.warnDirectBranch = async () => {};
    manager.ensureSudoBroker = async () => {};
    manager.sendChat = async (_managed, text) => { sent.push(text); };
    const managed = { state: {}, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } } };
    const send = id => manager.handleMessage(managed, { type: "chat.send", id, text: id, attachments: [], execution: { fast: false, goal: false } });
    await Promise.all([send("failed"), send("next")]);
    assert.equal(managed.pendingMessageIds.has("failed"), false);
    assert.deepEqual(posted.filter(message => message.type === "chat.rejected").map(message => message.id), ["failed"]);
    assert.deepEqual(sent, ["next"]);
  }
});


test("accepted identities remain recoverable beyond the old replay window", async () => {
  const posted = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => { throw new Error("must not reconnect"); });
  manager.ensureController = async () => {};
  const managed = { state: { role: "work" }, imageAttachments: new Map(), pendingMessageIds: new Set(),
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    controller: { async send(_text, _attachments, _execution, started) { started({ taskMode: "direct", businessMode: "normal", goal: false }); } } };
  for (let index = 0; index < 201; index++) {
    await manager.sendChat(managed, `request ${index}`, [], { fast: false, goal: false }, `request-${index}`);
  }
  posted.length = 0;
  await manager.handleMessage(managed, { type: "chat.status", ids: ["request-0", "request-200"] });
  assert.deepEqual(posted.map(event => [event.type, event.id]), [["chat.started", "request-0"], ["chat.started", "request-200"]]);
});


test("named-set snapshots reject composer edits until explicitly detached to Chat", async () => {
  const manager = new module.exports.ChatPanelManager({globalState:{get(_key,fallback){return fallback;},async update(){}}}, {}, () => [], async () => ({available:false}));
  manager.rememberAgent = async () => {};
  const managed = {state:{panelId:'named-snapshot',role:'main',model:'gpt-6-astra',reasoning:'high',agentSettingsScope:'global',agentSettingsSet:'Super Factory',agentModels:{work:{model:'claude-fable-5-1',reasoningEffort:'high'}},fastMode:false},panel:{webview:{async postMessage(){return true;}}}};
  const message={type:'composer.settings',goalMode:false,model:'gpt-6-luna',reasoning:'low',agentModels:{work:{model:'gpt-6-luna'}},fastMode:true,agentSettingsScope:'global',agentSettingsSet:'Super Factory'};
  await manager.handleMessage(managed,message);
  assert.equal(managed.state.model,'gpt-6-astra');assert.equal(managed.state.reasoning,'high');
  assert.equal(managed.state.agentModels.work.model,'claude-fable-5-1');assert.equal(managed.state.fastMode,false);
  await manager.handleMessage(managed,{...message,agentSettingsScope:'chat',agentSettingsSet:'Chat'});
  assert.equal(managed.state.model,'gpt-6-luna');assert.equal(managed.state.agentSettingsScope,'chat');
  assert.equal(managed.state.agentSettingsSet,'Chat');assert.equal(managed.state.fastMode,true);
});

test("task history deletion waits for runtime success, broadcasts to panels, preserves stop and rejects wrong project owner", async () => {
  const posted = [], calls = [];
  let settle, fail;
  let pending = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const client = { deleteTask(...args) { calls.push(args); return pending; },
    async listProjectTasks() { return [{ id: "flow-project", mainAgentId: "main-other", tasks: [{ id: "project-task" }] }]; } };
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: true, client }));
  manager.post = async (_panel, message) => { posted.push(message); };
  manager.sendAgentList = async () => {};
  const managed = { state: { role: "main", agentId: "main-one" }, panel: {}, disposed: false };
  manager.panels.set("one", managed);
  manager.panels.set("two", { state: { role: "main", agentId: "main-other" }, panel: {}, disposed: false });
  const message = { type: "task.delete", workflowId: "flow-one", taskId: "task-one" };
  const deleting = manager.handleMessage(managed, message);
  await new Promise(resolve => setImmediate(resolve));
  await manager.handleMessage(managed, message);
  assert.deepEqual(calls, [["main-one", "flow-one", "task-one"]]);
  assert.equal(posted.length, 0, "No optimistic success acknowledgement");
  settle({ kind: "task-history-deleted" });
  await deleting;
  assert.equal(posted.filter(message => message.type === "task.delete.result" && !message.error).length, 2, "Every open panel drops its cache");
  posted.length = 0;
  pending = new Promise((resolve, reject) => { fail = reject; });
  const rejected = manager.handleMessage(managed, message);
  await new Promise(resolve => setImmediate(resolve));
  fail(new Error("Live worker owns the selected run"));
  await rejected;
  assert.equal(posted.filter(message => message.type === "task.delete.result" && !message.error).length, 0);
  assert.match(posted.find(message => message.type === "task.delete.result").error, /Live worker/);
  assert.equal(posted.find(message => message.type === "host.notice").level, "error");
  const before = calls.length;
  await manager.handleMessage(managed, { ...message, mainAgentId: "main-other" });
  assert.equal(calls.length, before, "An arbitrary project Main is rejected before storage mutation");
  pending = Promise.resolve({ kind: "task-history-deleted" });
  await manager.handleMessage(managed, { type: "task.delete", workflowId: "flow-project", taskId: "project-task", mainAgentId: "main-other" });
  assert.deepEqual(calls.at(-1), ["main-other", "flow-project", "project-task"]);
  await manager.handleMessage({ ...managed, state: { role: "work", agentId: "work-one" } }, message);
  assert.equal(calls.length, before + 1, "Worker panels cannot invoke Main history deletion");
});
