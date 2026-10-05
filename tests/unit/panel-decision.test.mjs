import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
  assert.equal(storage.get("agentFactory.background.main-one")["work-one/run-one"], "delivery-error:completed");
  assert.equal(posted.at(-1).type, "host.notice");
  assert.equal(posted.at(-1).level, "error");
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
  assert.equal(storage.get('agentFactory.background.main-child')['work-child/run-child'], 'completed');
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
    assert.equal(manager.newChatPreferences().agentSettingsSet,'Second');
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
