import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"],
  plugins: [{
    name: "theme-reader-boundary",
    setup(build) {
      build.onResolve({ filter: /\/cli-theme$/ }, () => ({ path: "cli-theme", namespace: "theme-test" }));
      build.onResolve({ filter: /\/github\/deploy-workflows$/ }, () => ({ path: "deploy-workflows", namespace: "theme-test" }));
      build.onLoad({ filter: /.*/, namespace: "theme-test" }, args => ({ contents: args.path === "deploy-workflows"
        ? `export class DeployError extends Error { constructor(code, message) { super(message); this.code = code; } }
           export async function deployRunStatus(...args) { return globalThis.__deployRunStatus({ DeployError, Error, SyntaxError }, ...args); }
           export async function dispatchDeploy() { return { id: 7, url: "https://github.test/run/7", workflow: "Release", status: "queued" }; }
           export async function detectDeployTarget() { throw new DeployError("not-github", "not GitHub"); }
           export async function setupDeploySecret() {}`
        : "export async function readCliTheme() { return globalThis.__readTheme(); }", loader: "js" }));
    }
  }]
});

function event() {
  const listeners = new Set();
  return {
    listen(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    async fire(value) { await Promise.all([...listeners].map(fn => fn(value))); },
    clear() { listeners.clear(); }
  };
}

function memento() {
  const values = new Map();
  return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, async update(key, value) { values.set(key, value); }, keys: () => [...values.keys()] };
}

async function flush() {
  // Event callbacks intentionally launch refresh promises without returning them.
  await new Promise(resolve => setImmediate(resolve));
}

async function fixture(t, connectRuntime = async () => ({ available: false, diagnostic: "Runtime unavailable in fixture" })) {
  const messages = [];
  const operations = [];
  const timers = new Map();
  let nextTimer = 1;
  let selection = { name: "dracula" };
  let readTheme = async () => selection;
  let reads = 0;
  const receive = event();
  const dispose = event();
  const view = event();
  const change = event();
  const create = event();
  const remove = event();
  const watcher = {
    pattern: undefined, disposed: false,
    onDidChange: change.listen, onDidCreate: create.listen, onDidDelete: remove.listen,
    dispose() { this.disposed = true; change.clear(); create.clear(); remove.clear(); }
  };
  const panel = {
    active: true, visible: true,
    webview: {
      onDidReceiveMessage: receive.listen,
      async postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); operations.push(message.type); return true; }
    },
    onDidDispose: dispose.listen, onDidChangeViewState: view.listen,
    dispose() { void dispose.fire(); }, reveal() {}
  };
  const vscode = {
    Disposable: class { constructor(fn) { this.fn = fn; } dispose() { const fn = this.fn; this.fn = undefined; fn?.(); } },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    Uri: { file: value => ({ fsPath: value }), joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }) },
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => panel },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      name: "Theme test", workspaceFolders: [],
      createFileSystemWatcher(pattern) { watcher.pattern = pattern; return watcher; }
    }
  };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, Buffer, console, AbortController, structuredClone, setInterval, clearInterval,
    process: { env: { CODEX_HOME: "/isolated/theme-test-home" } },
    require: name => name === "vscode" ? vscode : require(name),
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    __readTheme() { reads++; return readTheme(); },
    __deployRunStatus: (...args) => deployRunStatus(...args)
  });
  let deployRunStatus = async () => { throw new Error("deploy status is not configured"); };
  const manager = new module.exports.ChatPanelManager(
    { extensionUri: { fsPath: "/extension" }, globalStorageUri: { fsPath: "/isolated/theme-test-storage" }, globalState: memento(), workspaceState: memento() },
    { localResourceRoots: [], render: async () => "<html></html>" }, () => [],
    async () => { operations.push("connectRuntime"); return connectRuntime(); }
  );
  await manager.openDraft();
  t.after(() => manager.dispose());
  const themes = () => messages.filter(message => message.type === "syntax.theme");
  return {
    manager, panel, watcher, messages, operations, themes,
    reads: () => reads,
    select(value) { selection = value; },
    deferRead(fn) { readTheme = fn; },
    deployStatus(fn) { deployRunStatus = fn; },
    async fireTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
      await flush();
    },
    ready: () => receive.fire({ type: "client.ready" }),
    receive: message => receive.fire(message),
    async viewState(active) { panel.active = active; panel.visible = active; await view.fire({ webviewPanel: panel }); await flush(); },
    async watch(kind, file = "config.toml") { await ({ change, create, remove })[kind].fire({ fsPath: "/isolated/theme-test-home/" + file }); },
    async debounce() {
      for (const [id, timer] of [...timers]) if (timer.delay === 150) { timers.delete(id); timer.fn(); }
      await flush();
    }
  };
}

test("client.ready sends theme before attempting unavailable runtime and resends after webview reload", async t => {
  const host = await fixture(t);
  assert.equal(host.themes().length, 0);
  await host.ready();
  assert.deepEqual(host.themes()[0], { type: "syntax.theme", selection: { name: "dracula" } });
  assert.ok(host.operations.indexOf("syntax.theme") < host.operations.indexOf("connectRuntime"));
  assert.equal(host.messages.find(message => message.type === "host.initialize").runtimeAvailable, false);
  await host.ready();
  assert.equal(host.themes().length, 2);
});

test("new drafts do not inherit identity or execution state from legacy composer preferences", async t => {
  const host = await fixture(t);
  await host.manager.context.globalState.update("agentFactory.mainChat.composerPreferences", {
    panelId: "old-panel", agentId: "main-running", conversationId: "old-conversation",
    role: "verification", title: "Running chat", contextUsedTokens: 900,
    verifiedWorkRunId: "run-old", capturedRun: {agentId: "main-running", runId: "run-old", parentAgentId: "parent"},
    model: "claude-old", reasoning: "high", fastMode: true,
    agentPermissions: {main: "workspace-write"}
  });
  const preferences = host.manager.newChatPreferences();
  assert.equal(preferences.agentId, undefined);
  assert.equal(preferences.panelId, undefined);
  await host.manager.openDraft();
  await host.manager.openDraft();
  const drafts = [...host.manager.panels.values()].slice(-2).map(panel => panel.state);
  assert.equal(drafts.length, 2);
  assert.notEqual(drafts[0].panelId, drafts[1].panelId);
  for (const draft of drafts) {
    assert.equal(draft.agentId, undefined);
    assert.equal(draft.conversationId, undefined);
    assert.equal(draft.capturedRun, undefined);
    assert.equal(draft.verifiedWorkRunId, undefined);
    assert.equal(draft.contextUsedTokens, undefined);
    assert.equal(draft.role, "main");
    assert.equal(draft.title, "Main Agent");
    assert.equal(draft.agentPermissions.main, "workspace-write");
  }
  const managed = [...host.manager.panels.values()].at(-1);
  await host.receive({type: "composer.settings", model: "claude-opus-5-5", reasoning: "high", fastMode: false, goalMode: false,
    agentSettingsScope: "chat", agentSettingsSet: "Default"});
  assert.equal(managed.state.model, "claude-opus-5-5");
  const saved = host.manager.context.workspaceState.get("agentFactory.sidebar.agents").find(state => state.panelId === managed.state.panelId);
  assert.equal(saved.model, "claude-opus-5-5");
  assert.equal(saved.reasoning, "high");
  await host.ready();
  assert.equal(host.messages.filter(message => message.type === "host.initialize").at(-1).model, "claude-opus-5-5");
});

test("client.ready still initializes the chat when runtime probes fail and reports each failure", async t => {
  const client = {
    async capabilities() { throw new Error("Capability probe failed"); },
    async listSessions() { throw new Error("Session list failed"); }
  };
  const host = await fixture(t, async () => ({ available: true, client }));
  host.manager.panels.values().next().value.state.agentId = "main-restored";
  await host.ready();
  const initialize = host.messages.find(message => message.type === "host.initialize");
  assert.ok(initialize, "the webview receives host.initialize");
  assert.equal(initialize.runtimeAvailable, true);
  assert.equal(initialize.capabilities, undefined);
  assert.equal(initialize.resetConversation, false);
  const notices = host.messages.filter(message => message.type === "host.notice" && message.level === "error").map(message => message.text);
  assert.ok(notices.some(text => /Capability probe failed$/.test(text)));
  assert.ok(notices.some(text => /Session list failed$/.test(text)));
});

test("a saved agent preset is not reported as failed when the follow-up capability refresh fails", async t => {
  const client = {
    async capabilities() { throw new Error("Capability probe failed"); },
    async listSessions() { return []; }
  };
  const host = await fixture(t, async () => ({ available: true, client }));
  await host.ready();
  await host.receive({ type: "agent.preset.field", scope: "global", name: "Agent Factory · Codex", role: "main", field: "reasoningEffort", value: "high" });
  const result = host.messages.filter(message => message.type === "agent.preset.field.result").at(-1);
  assert.ok(result, "the preset field save is answered");
  assert.equal(result.error, undefined);
});

test("config and custom-theme watcher events refresh selection, debounce bursts and deduplicate unchanged values", async t => {
  const host = await fixture(t);
  assert.equal(host.watcher.pattern.baseUri.fsPath, "/isolated/theme-test-home");
  assert.equal(host.watcher.pattern.pattern, "{config.toml,themes/*.tmTheme}");
  await host.ready();
  const beforeReads = host.reads();
  await host.watch("change");
  await host.watch("change");
  await host.debounce();
  assert.equal(host.reads(), beforeReads + 1);
  assert.equal(host.themes().length, 1);
  const custom = { name: "custom", theme: { name: "custom", settings: [{ settings: { foreground: "#123456" } }] } };
  host.select(custom);
  await host.watch("create", "themes/custom.tmTheme");
  await host.debounce();
  assert.deepEqual(host.themes().at(-1).selection, custom);
  host.select({ ...custom, theme: { ...custom.theme, settings: [{ settings: { foreground: "#abcdef" } }] } });
  await host.watch("change", "themes/custom.tmTheme");
  await host.debounce();
  assert.equal(host.themes().at(-1).selection.theme.settings[0].settings.foreground, "#abcdef");
  host.select({ name: "custom" });
  await host.watch("remove", "themes/custom.tmTheme");
  await host.debounce();
  assert.deepEqual(host.themes().at(-1).selection, { name: "custom" });
});

test("reactivation refreshes persisted theme even when watcher notification was missed", async t => {
  const host = await fixture(t);
  await host.ready();
  await host.viewState(false);
  host.select({ name: "nord" });
  assert.equal(host.themes().length, 1);
  await host.viewState(true);
  assert.deepEqual(host.themes().at(-1).selection, { name: "nord" });
  await host.viewState(true);
  assert.equal(host.themes().length, 2);
});

test("disposing cancels queued watcher refreshes and discards in-flight theme reads", async t => {
  const host = await fixture(t);
  await host.ready();
  let resolveRead;
  host.deferRead(() => new Promise(resolve => { resolveRead = resolve; }));
  await host.watch("change");
  await host.debounce();
  assert.equal(typeof resolveRead, "function");
  await host.watch("change");
  const beforeReads = host.reads();
  host.manager.dispose();
  resolveRead({ name: "nord" });
  await host.debounce();
  await host.watch("change");
  await host.debounce();
  assert.equal(host.watcher.disposed, true);
  assert.equal(host.reads(), beforeReads);
  assert.equal(host.themes().length, 1);
});

test("client.ready sends host.initialize and starts refreshes when a preparation step fails", async t => {
  const host = await fixture(t, async () => { throw new Error("Runtime lookup failed"); });
  host.deferRead(async () => { throw new Error("Theme read failed"); });
  host.manager.sendModelList = async () => { throw new Error("Model list failed"); };
  const managed = host.manager.panels.values().next().value;
  await host.ready();
  const initialize = host.messages.find(message => message.type === "host.initialize");
  assert.ok(initialize, "the webview receives host.initialize");
  assert.equal(initialize.runtimeAvailable, false);
  const notices = host.messages.filter(message => message.type === "host.notice" && message.level === "error").map(message => message.text);
  assert.ok(notices.some(text => /Theme read failed$/.test(text)));
  assert.ok(notices.some(text => /Runtime lookup failed$/.test(text)));
  assert.ok(notices.some(text => /Model list failed$/.test(text)));
  assert.equal(managed.branchRefreshStarted, true, "branch refresh starts after a failed later step");
});

test("a failed chat request is logged and shown instead of becoming an unhandled rejection", async t => {
  const host = await fixture(t);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = original; });
  await host.receive({ type: "agent.defaults.save", scope: "project", role: "work", field: "model", value: "claude-sonnet" });
  await host.receive({ type: "agent.defaults.fast", scope: "project", role: "work", model: "claude-sonnet", value: true });
  const notices = host.messages.filter(message => message.type === "host.notice" && message.level === "error").map(message => message.text);
  assert.deepEqual(notices, ["Manage agent settings through sets in Settings.", "Manage agent settings through sets in Settings."]);
  assert.equal(host.messages.filter(message => message.type === "agent.defaults").length, 2, "the stored values are still refreshed");
  assert.deepEqual(errors.map(([label, detail]) => [label, detail.type]), [
    ["[Agent Factory] Chat request failed", "agent.defaults.save"], ["[Agent Factory] Chat request failed", "agent.defaults.fast"]]);
  assert.ok(!JSON.stringify(errors).includes("claude-sonnet"), "the log carries the operation, not the request values");
});

test("client.ready and chat.send of one panel run in arrival order", async t => {
  let releaseRuntime;
  const runtime = new Promise(resolve => { releaseRuntime = resolve; });
  const host = await fixture(t, async () => { await runtime; return { available: false, diagnostic: "Runtime unavailable in fixture" }; });
  host.manager.refreshWorktree = async () => {};
  host.manager.warnDirectBranch = async () => {};
  let releaseSend = async () => {};
  host.manager.sendChat = async (_managed, text) => { await releaseSend(); host.operations.push("send:" + text); };
  const send = text => host.receive({ type: "chat.send", id: text, text, attachments: [], execution: { fast: false, goal: false } });
  const initialized = () => host.operations.filter(type => type === "host.initialize").length;
  const ready = host.ready();
  const during = send("during-ready");
  await flush();
  assert.ok(!host.operations.includes("send:during-ready"), "a send waits for the reload in progress");
  releaseRuntime();
  await Promise.all([ready, during]);
  assert.ok(host.operations.indexOf("host.initialize") < host.operations.indexOf("send:during-ready"));
  let release;
  releaseSend = () => new Promise(resolve => { release = resolve; });
  const before = send("before-ready");
  await flush();
  const reload = host.ready();
  await flush();
  assert.equal(initialized(), 1, "a reload waits for the earlier send");
  release();
  await Promise.all([before, reload]);
  assert.equal(initialized(), 2);
  assert.ok(host.operations.indexOf("send:before-ready") < host.operations.lastIndexOf("host.initialize"));
});

test("deploy status polling retries transient failures and stops on persistent or definitive ones", async t => {
  const host = await fixture(t);
  const managed = host.manager.panels.values().next().value;
  managed.deployTarget = { root: "/project", target: { repository: "owner/repo", ref: "main", workflows: [] } };
  const poll = async outcomes => {
    let calls = 0;
    // Errors come from the module realm, as gh failures do in the Host.
    host.deployStatus(async (realm, _root, _repository, run) => {
      const outcome = outcomes[calls++];
      if (outcome === "gh-missing") throw new realm.DeployError("gh-missing", "GitHub CLI (gh) is not installed.");
      if (outcome === "reset") throw new realm.Error("gh: connection reset");
      if (outcome === "syntax") throw new realm.SyntaxError("Unexpected token");
      return { ...run, ...outcome };
    });
    let done = false;
    const deploy = host.manager.runDeploy(managed, 1, {}).then(() => { done = true; });
    await flush();
    while (!done) await host.fireTimers(10_000);
    await deploy;
    return calls;
  };
  const failure = () => "reset";
  assert.equal(await poll([failure(), failure(), { status: "in_progress" }, failure(), { status: "completed", conclusion: "success" }]), 5);
  assert.equal(managed.deployPolling, false);
  assert.match(host.messages.filter(message => message.type === "host.notice").at(-1).text, /Release succeeded/);
  assert.equal(await poll([failure(), failure(), failure()]), 3);
  assert.equal(managed.deployPolling, false, "a new deployment is no longer blocked");
  assert.match(host.messages.filter(message => message.type === "host.notice").at(-1).text, /Stopped checking Release: gh: connection reset\. The run continues on GitHub: https:\/\/github\.test\/run\/7/);
  assert.equal(await poll([failure(), "gh-missing"]), 2, "a missing gh is not retried");
  assert.equal(await poll(["syntax"]), 1, "an unreadable response is not retried");
  assert.equal(managed.deployPolling, false);
});
