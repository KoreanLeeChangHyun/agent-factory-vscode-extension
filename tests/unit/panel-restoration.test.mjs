import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createTypeScriptBuilder } from "../support/import-typescript.mjs";

const require = createRequire(import.meta.url);
const extensionRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const prepare = createTypeScriptBuilder({ format: "cjs", external: ["vscode"] });
const root = "/projects/A";
const saved = { panelId: "chat-one", title: "Main Agent", role: "main", projectRoot: root, agentId: "main-one" };

// A window with a restored layout: `tabs` mirrors VS Code tab groups, and panels fire their dispose listeners like VS Code.
async function fixture({ tabs = [], connect = async () => ({ available: false }) } = {}) {
  const created = [];
  const event = list => listener => { list.push(listener); return { dispose() {} }; };
  const panel = () => {
    const disposeListeners = [];
    const value = {
      active: false, visible: false, viewColumn: 1, title: "", reveals: [], disposed: false,
      webview: { onDidReceiveMessage: () => ({ dispose() {} }), async postMessage() { return true; } },
      onDidDispose: event(disposeListeners), onDidChangeViewState: () => ({ dispose() {} }),
      reveal(...args) { value.reveals.push(args); },
      dispose() { if (value.disposed) return; value.disposed = true; for (const listener of disposeListeners) listener(); }
    };
    return value;
  };
  const listeners = () => ({ dispose() {} });
  const vscode = {
    Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }) },
    ViewColumn: { Active: 1 },
    window: { tabGroups: { all: [{ tabs }] }, createWebviewPanel: () => { const value = panel(); created.push(value); return value; } },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: root } }],
      createFileSystemWatcher: () => ({ onDidChange: listeners, onDidCreate: listeners, onDidDelete: listeners, dispose() {} })
    }
  };
  const module = { exports: {} };
  runInNewContext(await prepare("src/infrastructure/vscode/chat-panel-manager.ts"), {
    module, exports: module.exports, Buffer, console, process, URL, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, global: { Date },
    require: name => name === "vscode" ? vscode : require(name)
  });
  const store = (map = new Map()) => ({ get: (key, fallback) => map.has(key) ? map.get(key) : fallback, async update(key, value) { map.set(key, value); } });
  const workspaceState = store(new Map([["agentFactory.sidebar.agents", [saved]], ["agentFactory.mainChat.lastPanel", saved.panelId]]));
  const manager = new module.exports.ChatPanelManager(
    { extensionUri: { fsPath: extensionRoot }, globalState: store(), workspaceState, subscriptions: [] },
    { localResourceRoots: [], render: async () => "<html></html>" }, () => [], connect
  );
  manager.tabIcon = () => ({ fsPath: "icon" });
  manager.webviewOptions = () => ({});
  return { manager, created, panel, live: () => [...manager.panels.values()].filter(managed => !managed.disposed) };
}

test("startup leaves a restored but not yet revived chat tab to VS Code instead of opening it again", async () => {
  const f = await fixture({ tabs: [{ label: "Main Agent", input: { viewType: "mainThreadWebview-agentFactory.mainChat" } }] });
  await f.manager.openStartup();
  assert.equal(f.created.length, 0, "startup must not create a second tab for the restored chat");

  // Revival happens when the Human shows the restored tab.
  const restored = f.panel();
  await f.manager.revive(restored, saved);
  assert.equal(restored.disposed, false);
  assert.deepEqual(f.live().map(managed => managed.panel), [restored]);
});

test("startup still opens the last chat when the layout holds no unrevived chat tab", async () => {
  const f = await fixture({ tabs: [{ label: "README.md", input: { uri: { fsPath: "/projects/A/README.md" } } },
    { label: "Archify", input: { viewType: "agentFactory.archify" } }] });
  await f.manager.openStartup();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.live().map(managed => managed.state.panelId), [saved.panelId]);
});

test("a restored tab and the startup tab racing for the same chat leave one bound tab", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ connect: async () => { await gate; return { available: true, client: { async listSessions() { return [{ agentId: saved.agentId }]; } } }; } });
  const restored = f.panel();
  // Revival passes its duplicate check, then waits on the runtime while startup binds the same chat.
  const reviving = f.manager.revive(restored, saved);
  await f.manager.openStartup();
  assert.equal(f.created.length, 1);
  const opened = f.created[0];
  release();
  await reviving;

  assert.equal(restored.disposed, true, "the later duplicate tab is closed");
  assert.equal(opened.reveals.length, 1, "the bound tab is brought forward instead");
  assert.deepEqual(f.live().map(managed => managed.panel), [opened]);
  assert.equal(f.manager.panels.get(saved.panelId)?.panel, opened, "closing the duplicate keeps the bound tab registered");
});

test("closing a stale duplicate never unregisters the tab that owns the chat", async () => {
  const f = await fixture();
  const owner = f.panel(), stale = f.panel();
  // Before this fix a second bind overwrote the registration and left the first tab live but untracked.
  await f.manager.revive(stale, saved);
  f.manager.panels.delete(saved.panelId);
  await f.manager.revive(owner, saved);
  stale.dispose();
  assert.equal(f.manager.panels.get(saved.panelId)?.panel, owner);
});
