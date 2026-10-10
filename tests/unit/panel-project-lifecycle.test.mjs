import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { importTypeScript } from "../support/import-typescript.mjs";

const require = createRequire(import.meta.url);
const source = await build({ entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"] });
const disposable = () => ({ dispose() {} });
const vscode = { ViewColumn: { Active: -1 }, ExtensionMode: { Development: 2 },
  Disposable: class { constructor(action) { this.action = action; } dispose() { this.action?.(); } },
  RelativePattern: class {}, Uri: { file(fsPath) { return { fsPath }; } },
  window: { createWebviewPanel(_type, title) { return panel(title); } },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/projects/A" } }],
    createFileSystemWatcher() { return { dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }; },
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; } } };
const module = { exports: {} };
runInNewContext(source.outputFiles[0].text, { module, exports: module.exports, Buffer, URL, structuredClone, console, process,
  setTimeout, clearTimeout, global: { Date }, require: name => name === "vscode" ? vscode : require(name) });
const { ChatPanelManager } = module.exports;
const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function panel(title = "Main") {
  const closed = new Set();
  const view = { title, notices: [], disposed: false, reveals: 0,
    dispose() { this.disposed = true; for (const callback of [...closed]) callback(); }, reveal() { this.reveals++; },
    onDidDispose(callback) { closed.add(callback); return { dispose() { closed.delete(callback); } }; }, onDidChangeViewState: disposable,
    webview: { onDidReceiveMessage: disposable, async postMessage(message) { this.owner.notices.push(message); return true; } } };
  view.webview.owner = view;
  return view;
}
function managed(root = "/projects/A", agentId = "same-main", panelId = root ?? "rootless") {
  const view = panel(); view.webview.owner = view;
  return { state: { panelId, title: "Main", role: "main", agentId, conversationId: "conversation-current", ...(root ? { projectRoot: root } : {}) },
    panel: view, pendingMessageIds: new Set(), controller: { running: false, queueLength: 0 }, disposed: false };
}
function fixture(connect) {
  const storage = new Map();
  const memento = { get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
    async update(key, value) { if (value === undefined) storage.delete(key); else storage.set(key, structuredClone(value)); } };
  const context = { globalState: memento, workspaceState: memento, subscriptions: [], extensionUri: vscode.Uri.file("/extension") };
  const manager = new ChatPanelManager(context, { async render() { return "<html>Fixture</html>"; } }, () => [], connect ?? (async () => ({ available: false, diagnostic: "Fixture runtime unavailable" })));
  manager.scheduleAgentList = () => {};
  manager.notifyAgents = () => {};
  manager.sendAgentList = async () => {};
  manager.tabLoading = () => false;
  manager.tabIcon = () => ({});
  manager.broadcastCompanion = () => {};
  manager.webviewOptions = () => ({});
  return { manager, storage, context };
}

test("project binding survives serialization and rejects relative or malformed roots", () => {
  const state = restoreChatState(JSON.parse(JSON.stringify(managed("/projects/B").state)));
  assert.equal(state.projectRoot, "/projects/B");
  for (const projectRoot of ["relative/project", "", "/project\u0000bad", 12]) assert.equal(restoreChatState({ projectRoot }).projectRoot, undefined);
});

test("a new draft keeps the project selected at creation before its first runtime connection", async () => {
  const calls = [];
  const f = fixture(async root => { calls.push(root); return { available: true, client: {} }; });
  let draft;
  f.manager.attach = async (_panel, state) => { draft = managed(null); draft.state = state; draft.controller = undefined; };
  const previous = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/projects/A" } }];
    await f.manager.openDraft();
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/projects/B" } }, { uri: { fsPath: "/projects/A" } }];
    await f.manager.createController(draft);
    assert.equal(draft.state.projectRoot, "/projects/A");
    assert.deepEqual(calls, ["/projects/A"]);
    draft.controller.dispose();
  } finally { vscode.workspace.workspaceFolders = previous; }
});

test("restoring a Main panel uses its saved project and never reuses a foreign namesake", async () => {
  const calls = [], attached = [];
  const f = fixture(async root => { calls.push(root); return { available: true, client: { async listSessions() { return [{ agentId: "same-main" }]; } } }; });
  const foreign = managed("/projects/A"), restored = panel();
  f.manager.panels.set(foreign.state.panelId, foreign);
  f.manager.attach = async (_panel, state) => { attached.push(state); };
  await f.manager.revive(restored, managed("/projects/B").state);
  assert.equal(restored.disposed, false);
  assert.equal(foreign.panel.reveals, 0);
  assert.equal(attached[0].projectRoot, "/projects/B");
  assert.deepEqual(calls, ["/projects/B"]);
});

test("Host project bindings restore Main and Child panels when the Webview snapshot omits the root", async () => {
  const calls = [], attached = [], f = fixture(async root => { calls.push(root); return { available: true, client: { async listSessions() { return [{ agentId: "same-main" }]; } } }; });
  f.manager.attach = async (_panel, state) => { attached.push(state); };
  for (const role of ["main", "work"]) {
    const state = { ...managed("/projects/B").state, panelId: `restored-${role}`, role };
    delete state.projectRoot;
    f.storage.set(`agentFactory.panel.project.${state.panelId}`, "/projects/B");
    await f.manager.revive(panel(), JSON.parse(JSON.stringify(state)));
    assert.equal(attached.at(-1).projectRoot, "/projects/B", role);
  }
  assert.deepEqual(calls, ["/projects/B"]);
});

test("legacy panels without Host metadata recover a unique project from recorded session identity", async () => {
  const previous = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = ["/projects/A", "/projects/B"].map(fsPath => ({ uri: { fsPath } }));
    const f = fixture(async root => ({ available: true, client: { async listSessions() {
      return root === "/projects/B" ? [{ agentId: "same-main", conversationId: "conversation-current" }] : [];
    } } }));
    let restored;
    f.manager.attach = async (_panel, state) => { restored = state; };
    const state = { ...managed(null).state, panelId: "legacy-unbound" }, view = panel();
    await f.manager.revive(view, state);
    assert.equal(view.disposed, false);
    assert.equal(restored.projectRoot, "/projects/B");
  } finally { vscode.workspace.workspaceFolders = previous; }
});

test("legacy project recovery uses the recorded conversation to distinguish namesakes and refuses ambiguity", async () => {
  const previous = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = ["/projects/A", "/projects/B"].map(fsPath => ({ uri: { fsPath } }));
    const f = fixture(async root => ({ available: true, client: { async listSessions() {
      return [{ agentId: "same-main", conversationId: root === "/projects/B" ? "conversation-current" : "another-conversation" }];
    } } }));
    let restored;
    f.manager.attach = async (_panel, state) => { restored = state; };
    const state = { ...managed(null).state, panelId: "legacy-namesake" };
    await f.manager.revive(panel(), state);
    assert.equal(restored.projectRoot, "/projects/B");
    delete state.conversationId;
    await assert.rejects(f.manager.revive(panel(), { ...state, panelId: "ambiguous-panel" }), /project.*ambiguous/i);
  } finally { vscode.workspace.workspaceFolders = previous; }
});

test("an unavailable project lookup cannot authorize rebinding an old panel", async () => {
  const previous = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = ["/projects/A", "/projects/B"].map(fsPath => ({ uri: { fsPath } }));
    const f = fixture(async root => root === "/projects/A" ? { available: false, diagnostic: "Offline" } : {
      available: true, client: { async listSessions() { return [{ agentId: "same-main", conversationId: "conversation-current" }]; } }
    });
    let attached = false;
    f.manager.attach = async () => { attached = true; };
    const view = panel();
    await assert.rejects(f.manager.revive(view, managed(null).state), /lookup is unavailable/i);
    assert.equal(attached, false);
    assert.equal(view.disposed, false);
  } finally { vscode.workspace.workspaceFolders = previous; }
});

test("a draft opened without folders captures the first successfully connected project", async () => {
  const f = fixture(async () => ({ available: true, projectRoot: "/projects/B", client: {} })), target = managed(null);
  target.controller = undefined;
  await f.manager.createController(target);
  assert.equal(target.state.projectRoot, "/projects/B");
  assert.equal(f.storage.get(`agentFactory.panel.project.${target.state.panelId}`), "/projects/B");
  target.controller.dispose();
});

test("actual attachment persists the Host root and preserves newer delivery acknowledgements during legacy migration", async () => {
  const f = fixture(), state = { ...managed(null).state, panelId: "legacy-panel", agentSettingsVersion: 1 }, view = panel();
  const key = f.manager.deliveryStorageKey("agentFactory.background.", { ...state, projectRoot: "/projects/A" });
  f.storage.set("agentFactory.background.same-main", { "work/run": { state: "prepared" }, "another/run": "running" });
  f.storage.set(key, { "work/run": { state: "accepted", runId: "already-accepted" } });
  await f.manager.attach(view, state);
  assert.equal(f.storage.get("agentFactory.panel.project.legacy-panel"), "/projects/A");
  assert.equal(f.storage.get(key)["work/run"].state, "accepted");
  assert.equal(f.storage.get(key)["another/run"], "running");
  const previous = vscode.workspace.workspaceFolders;
  try {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/projects/B" } }];
    const calls = [], restarted = new ChatPanelManager(f.context, {}, () => [], async root => {
      calls.push(root); return { available: true, client: { async listSessions() { return [{ agentId: "same-main" }]; } } };
    });
    restarted.attach = async (_panel, restored) => { assert.equal(restored.projectRoot, "/projects/A"); };
    await restarted.revive(panel(), JSON.parse(JSON.stringify(state)));
    assert.deepEqual(calls, ["/projects/A"]);
  } finally { vscode.workspace.workspaceFolders = previous; view.dispose(); }
});

test("the production connection factory accepts an explicit project after folders reorder", async () => {
  const externals = new Set(["../infrastructure/vscode/chat-panel-manager", "../infrastructure/vscode/chat-template-renderer",
    "../infrastructure/agent-factory/plugin-locator", "../infrastructure/agent-factory/agent-client"]);
  const output = await build({ entryPoints: [new URL("../../src/core/container.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"],
    plugins: [{ name: "fixture-runtime", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => externals.has(args.path) ? { path: args.path, external: true } : undefined);
    } }] });
  const factoryModule = { exports: {} };
  const originalFolders = vscode.workspace.workspaceFolders, originalConfigurationListener = vscode.workspace.onDidChangeConfiguration;
  vscode.workspace.onDidChangeConfiguration = disposable;
  try {
    runInNewContext(output.outputFiles[0].text, { module: factoryModule, exports: factoryModule.exports, console, process,
      Buffer, URL, setTimeout, clearTimeout, require(name) {
        if (name === "vscode") return vscode;
        if (name.endsWith("/chat-panel-manager")) return { ChatPanelManager: class { constructor(_context, _templates, _status, connect) { this.connect = connect; } } };
        if (name.endsWith("/chat-template-renderer")) return { ChatTemplateRenderer: class {} };
        if (name.endsWith("/plugin-locator")) return { async locateAgentFactoryExec() { return { available: true, execPath: "/fixture/exec.py" }; } };
        if (name.endsWith("/agent-client")) return { AgentFactoryClient: class { constructor(_exec, root) { this.root = root; } async diagnose() { return { available: true }; } } };
        return require(name);
      } });
    const { chatPanels } = factoryModule.exports.createContainer({ subscriptions: [], extensionUri: vscode.Uri.file("/extension"), extension: { packageJSON: { version: "1.0.28" } } });
    const first = await chatPanels.connect("/projects/B");
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/projects/C" } }];
    const repeated = await chatPanels.connect("/projects/B");
    assert.equal(first.projectRoot, "/projects/B");
    assert.equal(first.client.root, "/projects/B");
    assert.equal(repeated.client, first.client);
    assert.equal((await chatPanels.connect()).client.root, "/projects/C");
  } finally { vscode.workspace.workspaceFolders = originalFolders; vscode.workspace.onDidChangeConfiguration = originalConfigurationListener; }
});

test("Child panels inherit the parent's project and connection despite workspace reordering", async () => {
  const f = fixture(), parent = managed("/projects/B"), foreign = managed("/projects/A", "same-work"), attached = [];
  const client = { async childRun() { return { agentId: "same-work", runId: "run-work", role: "work", status: "completed" }; } };
  parent.runtimeClient = client;
  f.manager.panels.set(foreign.state.panelId, foreign);
  f.manager.attach = async (_panel, state, runtimeClient) => { attached.push({ state, runtimeClient }); };
  await f.manager.openChildAgent(parent, "same-work", "run-work");
  assert.equal(foreign.panel.reveals, 0);
  assert.equal(attached[0].state.projectRoot, "/projects/B");
  assert.equal(attached[0].runtimeClient, client);
});

test("sidebar deletion targets the saved project and preserves foreign sessions with the same agent ID", async () => {
  const calls = [];
  const f = fixture(async root => ({ available: true, client: { async deleteAgent(agent) { calls.push([root, agent]); }, async listProjectTasks() { return []; } } }));
  const foreign = managed("/projects/A"), target = managed("/projects/B");
  f.storage.set("agentFactory.sidebar.agents", [foreign.state, target.state]);
  f.manager.panels.set(foreign.state.panelId, foreign);
  f.manager.panels.set(target.state.panelId, target);
  const deleted = await f.manager.deleteSidebarAgent(target.state);
  assert.deepEqual(calls, [["/projects/B", "same-main"]]);
  assert.deepEqual([...deleted], [target.state.panelId]);
  assert.equal(foreign.panel.disposed, false);
  assert.equal(target.panel.disposed, true);
  assert.equal(f.manager.removedChat(foreign.state), false);
  assert.equal(f.storage.get("agentFactory.sidebar.agents").length, 1);
  assert.deepEqual(foreign.panel.notices, []);
});

test("a stale Resume list cannot rebind a session already deleted in the same project", async () => {
  const f = fixture(async () => ({ available: true, client: {
    async deleteAgent() {}, async listProjectTasks() { return []; },
    async listSessions() { return [{ agentId: "same-main", conversationId: "old-conversation" }]; },
    async capabilities() { return { submit: { worktrees: false } }; }, async goal() { return {}; }
  } }));
  const deleted = managed("/projects/B"), draft = managed("/projects/B", "draft", "new-panel");
  delete draft.state.agentId;
  draft.controller.dispose = () => {};
  f.manager.reconnectController = async () => {};
  f.manager.restoreConversationHistory = async () => {};
  f.storage.set("agentFactory.sidebar.agents", [deleted.state]);
  await f.manager.deleteSidebarAgent(deleted.state);
  await f.manager.selectSession(draft, "same-main");
  assert.equal(draft.state.agentId, undefined);
  assert.equal(f.storage.get("agentFactory.sidebar.agents").length, 0);
});

test("task deletion updates different runtime instances of the same project, excluding foreign projects", async () => {
  const f = fixture(), target = managed("/projects/B"), sibling = managed("/projects/B", "another-main", "sibling"), foreign = managed("/projects/A");
  target.runtimeClient = { async deleteTask() {} };
  sibling.runtimeClient = {};
  foreign.runtimeClient = {};
  for (const value of [target, sibling, foreign]) f.manager.panels.set(value.state.panelId, value);
  await f.manager.handleMessage(target, { type: "task.delete", workflowId: "same-flow", taskId: "same-task" });
  assert.equal(sibling.panel.notices.filter(value => value.type === "task.delete.result").length, 1);
  assert.equal(foreign.panel.notices.length, 0);
});

test("a delayed deletion failure cannot appear in a different selected conversation", async () => {
  const gate = deferred(), f = fixture(), target = managed();
  target.runtimeClient = { deleteTask() { return gate.promise; } };
  const pending = f.manager.handleMessage(target, { type: "task.delete", workflowId: "flow", taskId: "task" });
  await tick();
  target.state = { ...target.state, agentId: "new-main", conversationId: "new-conversation" };
  gate.reject(new Error("Old task deletion refused"));
  await pending;
  assert.deepEqual(target.panel.notices, []);
});

test("closing a panel during reset preflight prevents the runtime reset", async () => {
  const gate = deferred(), f = fixture(), target = managed();
  let resets = 0;
  f.manager.ensureController = async () => {};
  target.runtimeClient = { listChildSessions() { return gate.promise; } };
  target.controller.resetConversation = async () => { resets++; return { conversationId: "new-conversation" }; };
  const pending = f.manager.clearConversation(target);
  await tick();
  target.disposed = true;
  gate.resolve([]);
  await pending;
  assert.equal(resets, 0);
  assert.equal(target.state.conversationId, "conversation-current");
});

test("background priming cannot erase a concurrently accepted delivery", async () => {
  const gate = deferred(), f = fixture(async () => ({ available: true, client: { listChildSessions() { return gate.promise; } } })), target = managed(null);
  f.manager.ensureController = async () => {};
  target.controller.send = async () => {};
  const key = "agentFactory.background.same-main";
  const pending = f.manager.sendChat(target, "Human input", [], { fast: false, goal: false }, "input-one");
  await tick();
  await f.manager.persistTerminalDeliveries(key, { "work/run": { state: "accepted", identity: "captured", dispatchId: "accepted-dispatch" } }, () => true);
  gate.resolve([{ agentId: "work", runId: "run", status: "completed" }]);
  await pending;
  assert.equal(f.storage.get(key)["work/run"].state, "accepted");
});

test("sidebar discovery and renaming keep identical agent IDs in separate projects", async () => {
  const f = fixture(async () => ({ available: true, client: { async listSessions() { return [{ agentId: "same-main" }]; } } }));
  const a = managed("/projects/A"), b = managed("/projects/B");
  f.storage.set("agentFactory.sidebar.agents", [a.state, b.state]);
  f.manager.panels.set(a.state.panelId, a);
  f.manager.panels.set(b.state.panelId, b);
  const entries = await f.manager.sidebarAgents();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.state.projectRoot).sort(), ["/projects/A", "/projects/B"]);
  await f.manager.renameSidebarAgent(b.state, "Only B");
  assert.equal(a.state.title, "Main");
  assert.equal(b.state.title, "Only B");
  assert.equal(f.storage.get("agentFactory.sidebar.agents").length, 2);
});

test("a project's deletion does not discard a pending history reply in another project", async () => {
  const gate = deferred(), f = fixture(), a = managed("/projects/A"), b = managed("/projects/B");
  a.runtimeClient = { async deleteTask() {} };
  b.runtimeClient = { listProjectTasks() { return gate.promise; } };
  for (const value of [a, b]) f.manager.panels.set(value.state.panelId, value);
  const pending = f.manager.handleMessage(b, { type: "project.tasks.request" });
  await tick();
  await f.manager.handleMessage(a, { type: "task.delete", workflowId: "flow", taskId: "task" });
  gate.resolve([{ id: "B-history" }]);
  await pending;
  assert.equal(b.panel.notices.find(value => value.type === "project.tasks")?.entries[0]?.id, "B-history");
});

test("matching workflow and stop actions in different projects execute independently", async () => {
  for (const type of ["task.stop", "workflow.close"]) {
    const gate = deferred(), f = fixture(), calls = [];
    const a = managed("/projects/A"), b = managed("/projects/B");
    for (const value of [a, b]) value.runtimeClient = { async listChildSessions() { return []; },
      async stopTask() { calls.push(value.state.projectRoot); await gate.promise; return {}; },
      async closeWorkflow() { calls.push(value.state.projectRoot); await gate.promise; return {}; } };
    const message = type === "task.stop" ? { type, workflowId: "flow", taskId: "task", agentId: "work", runId: "run" } : { type, workAgentId: "work", loopId: "loop" };
    const first = f.manager.handleMessage(a, message);
    await tick();
    const second = f.manager.handleMessage(b, message);
    await tick();
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["/projects/A", "/projects/B"], type);
  }
});

test("session list and selection remain within the panel's project after workspace reordering", async () => {
  const calls = [], f = fixture(async root => { calls.push(root); return { available: true, client: {
    async listSessions() { return [{ agentId: "selected", conversationId: "conversation-selected" }]; },
    async capabilities() { return { submit: { worktrees: false } }; }, async goal() { return {}; } } }; });
  const target = managed("/projects/B"), foreign = managed("/projects/A", "selected");
  f.manager.panels.set(foreign.state.panelId, foreign);
  f.manager.ensureController = async () => {};
  f.manager.restoreConversationHistory = async () => {};
  f.manager.reconnectController = async () => {};
  target.controller.dispose = () => {};
  await f.manager.sendSessionList(target);
  await f.manager.selectSession(target, "selected");
  assert.equal(foreign.panel.reveals, 0);
  assert.equal(target.state.agentId, "selected");
  assert.deepEqual(calls, ["/projects/B", "/projects/B"]);
  assert.equal(target.panel.notices.filter(message => message.type === "host.notice").length, 0);
});

test("refreshed runtime clients for the same project share a pending completion claim", async () => {
  const gate = deferred(), f = fixture(), a = managed("/projects/B", "same-main", "first"), b = managed("/projects/B", "same-main", "second"), calls = [];
  for (const value of [a, b]) {
    value.runtimeClient = { async dispatchAcceptance() { return null; }, async result() { return { status: "completed", text: "Final" }; } };
    value.controller.runId = "report-run";
    value.controller.send = async (_text, _attachments, _execution, accepted) => { calls.push(value.state.panelId); await gate.promise; accepted(); };
  }
  const flow = { loopId: "loop", latestWorkRunId: "run", status: "completed", parentConversationId: "conversation-current" };
  await f.manager.reportWorkflowResults(a, [flow], a.runtimeClient);
  await tick();
  await f.manager.reportWorkflowResults(b, [flow], b.runtimeClient);
  await tick();
  gate.resolve();
  await tick();
  assert.deepEqual(calls, ["first"]);
});

test("a late reset result cannot replace the state of a disposed panel", async () => {
  const gate = deferred(), f = fixture(), target = managed();
  f.manager.ensureController = async () => {};
  target.runtimeClient = { async listChildSessions() { return []; } };
  target.controller.resetConversation = () => gate.promise;
  const pending = f.manager.clearConversation(target);
  await tick();
  target.disposed = true;
  gate.resolve({ conversationId: "orphaned-result" });
  await pending;
  assert.equal(target.state.conversationId, "conversation-current");
  assert.deepEqual(target.panel.notices, []);
});

test("late agent refresh failures stay outside a newly selected conversation", async () => {
  const gate = deferred(), f = fixture(), target = managed();
  target.runtimeClient = {};
  f.manager.sharedAgentRefresh = () => gate.promise;
  const pending = ChatPanelManager.prototype.sendAgentList.call(f.manager, target);
  await tick();
  target.state = { ...target.state, conversationId: "conversation-new" };
  gate.reject(new Error("Previous conversation refresh failed"));
  await pending;
  assert.deepEqual(target.panel.notices, []);
});

test("separate projects deliver matching completions once each and preserve replay suppression after reopening", async () => {
  const f = fixture(), a = managed("/projects/A"), b = managed("/projects/B"), calls = [];
  for (const value of [a, b]) {
    value.runtimeClient = { async dispatchAcceptance() { return null; }, async result() { return { status: "completed", text: "Final report" }; } };
    value.controller.runId = "run-report";
    value.controller.send = async (_text, _attachments, _execution, accepted) => { calls.push(value.state.projectRoot); accepted(); };
  }
  const flow = { loopId: "same-loop", latestWorkRunId: "same-run", status: "completed", parentConversationId: "conversation-current" };
  for (const value of [a, b]) { await f.manager.reportWorkflowResults(value, [flow]); await tick(); }
  assert.deepEqual(calls, ["/projects/A", "/projects/B"]);
  const reopened = new ChatPanelManager(f.context, {}, () => [], async () => ({ available: false }));
  for (const value of [a, b]) { await reopened.reportWorkflowResults(value, [flow]); await tick(); }
  assert.equal(calls.length, 2);
});


test("control center opens the bound project window without revealing Main or changing draft settings", async () => {
  const f = fixture();
  const target = managed();
  target.state.maestroMode = true;
  target.state.model = "captured-model";
  target.state.draft = "Preserved draft";
  f.manager.panels.set(target.state.panelId, target);
  const original = structuredClone(target.state);
  const opens=[];
  f.manager.controlCenters={async open(root,selection){opens.push({root,selection});}};
  await f.manager.openControlCenter(target.state);
  assert.deepEqual(target.state, original);
  assert.equal(target.panel.reveals, 0);
  assert.equal(target.panel.notices.length, 0);
  assert.equal(opens[0].root,"/projects/A");
});

test("record navigation is bound to an existing task and cannot dispatch work", async () => {
  const f = fixture(), target = managed();
  f.manager.panels.set(target.state.panelId, target);
  const entry = {id:"flow-one",mainAgentId:"same-main",tasks:[{id:"task-one",runs:[{role:"work",agentId:"existing-work",runId:"run-exact"}]}]};
  f.manager.controlCenterRuntime = async () => ({available:true,client:{async listProjectTasks(){return [entry];}}});
  f.manager.sidebarAgents = async () => [{state:target.state}];
  let opened;
  f.manager.openChildAgent = async (owner,agentId,runId) => {opened={owner,agentId,runId};};
  await f.manager.handleMessage(target,{type:"project.task.open",workflowId:"flow-one",taskId:"task-one",target:"run"});
  assert.equal(opened.owner,target);
  assert.equal(opened.agentId,"existing-work");
  assert.equal(opened.runId,"run-exact");
  await assert.rejects(f.manager.handleMessage(target,{type:"project.task.open",workflowId:"foreign-flow",taskId:"task-one",target:"run"}),/no longer available/);
});

test("unavailable project refresh reports an error rather than clearing recorded tasks", async () => {
  const f = fixture(), target = managed();
  await f.manager.handleMessage(target,{type:"project.tasks.request"});
  const message=target.panel.notices.at(-1);
  assert.equal(message.type,"project.tasks");
  assert.match(message.error,/unavailable/);
});


test("original result navigation validates both recorded agent and run without opening Main", async () => {
  const f=fixture(), target=managed();f.manager.panels.set(target.state.panelId,target);
  const entry={id:"flow-result",tasks:[{id:"task-result",runs:[{role:"work",agentId:"worker-exact",runId:"run-result",result:{availability:"recorded"}}]}]};
  f.manager.controlCenterRuntime=async()=>({available:true,client:{async listProjectTasks(){return [entry];},async projectTaskRecords(){return [{name:"work · run-result · result.md",path:"/managed/worker-exact/run-result/result.md"}];}}});
  const oldOpen=vscode.workspace.openTextDocument, oldShow=vscode.window.showTextDocument;
  const opened=[];vscode.workspace.openTextDocument=async uri=>uri;vscode.window.showTextDocument=async document=>opened.push(document.fsPath);
  const request={type:"project.task.open",workflowId:"flow-result",taskId:"task-result",target:"result",agentId:"worker-exact",runId:"run-result"};
  try {
    await f.manager.handleMessage(target,request);assert.deepEqual(opened,["/managed/worker-exact/run-result/result.md"]);
    assert.equal(target.panel.reveals,0);
    await assert.rejects(f.manager.handleMessage(target,{...request,agentId:"other-worker"}),/unavailable/);
    await assert.rejects(f.manager.handleMessage(target,{...request,runId:"other-run"}),/unavailable/);
    entry.tasks[0].runs[0].result.availability="error";
    await assert.rejects(f.manager.handleMessage(target,request),/unavailable/);assert.equal(opened.length,1);
  } finally {vscode.workspace.openTextDocument=oldOpen;vscode.window.showTextDocument=oldShow;}
});
