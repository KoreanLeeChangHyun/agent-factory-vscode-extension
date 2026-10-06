import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createTypeScriptBuilder } from "../support/import-typescript.mjs";

const require = createRequire(import.meta.url);
const extensionRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const vscodeUri = { file: value => ({ fsPath: value }), joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }) };

// Share immutable bundle text only; each load keeps a fresh VM and mock state.
const prepare = createTypeScriptBuilder({ format: "cjs", external: ["vscode"] });
async function load(entry, vscode) {
  const source = await prepare(`src/infrastructure/vscode/${entry}`);
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports, Buffer, console, process, URL, setTimeout, clearTimeout, global: { Date },
    require: name => name === "vscode" ? vscode : require(name)
  });
  return module.exports;
}

async function temporary(t, beforeRemove = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "af-tab-icons-"));
  t.after(async () => {
    await beforeRemove();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("tab icons are copied to version-independent storage and refreshed when the bundle changes", async t => {
  const { prepareTabIcons, TAB_ICON_FILES } = await load("tab-icons.ts", { Uri: vscodeUri });
  const root = await temporary(t);
  const bundle = join(root, "agent-factory-main-chat-1.0.24");
  await cp(join(extensionRoot, "static/images"), join(bundle, "static/images"), { recursive: true, filter: source => !source.includes("companion") });
  const storage = join(root, "globalStorage");

  const stable = await prepareTabIcons({ fsPath: bundle }, { fsPath: storage });
  assert.equal(stable.fsPath, join(storage, "tab-icons"));
  assert.deepEqual([...TAB_ICON_FILES], ["agent-factory.png", ...[0, 1, 2, 3, 4, 5].map(frame => `loading-squares-${frame}.svg`)]);
  for (const name of TAB_ICON_FILES) {
    assert.deepEqual(await readFile(join(stable.fsPath, name)), await readFile(join(bundle, "static/images", name)));
  }

  const before = (await stat(join(stable.fsPath, "agent-factory.png"))).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  await prepareTabIcons({ fsPath: bundle }, { fsPath: storage });
  assert.equal((await stat(join(stable.fsPath, "agent-factory.png"))).mtimeMs, before);

  await writeFile(join(bundle, "static/images/loading-squares-0.svg"), "<svg/>");
  await prepareTabIcons({ fsPath: bundle }, { fsPath: storage });
  assert.equal(await readFile(join(stable.fsPath, "loading-squares-0.svg"), "utf8"), "<svg/>");
});

test("tab icons fall back to the bundled folder when storage is unavailable", async t => {
  const { prepareTabIcons } = await load("tab-icons.ts", { Uri: vscodeUri });
  const root = await temporary(t);
  assert.equal((await prepareTabIcons({ fsPath: extensionRoot }, undefined)).fsPath, join(extensionRoot, "static/images"));
  await writeFile(join(root, "file"), "");
  assert.equal((await prepareTabIcons({ fsPath: extensionRoot }, { fsPath: join(root, "file") })).fsPath, join(extensionRoot, "static/images"));
});

test("tab loading combines the Main run with every durable active child run", async () => {
  const { shouldShowTabLoading } = await load("running-title.ts", {});
  assert.equal(shouldShowTabLoading(true, []), true, "a standalone Main run loads");
  assert.equal(shouldShowTabLoading(false, [{ status: "running" }]), true, "running Work loads while Main is idle");
  assert.equal(shouldShowTabLoading(false, [{ status: "verifying" }]), true, "verifying child loads while Main is idle");
  assert.equal(shouldShowTabLoading(false, [{ status: "running" }, { status: "completed" }]), true,
    "one terminal child cannot clear another active child");
  for (const status of ["completed", "failed", "cancelled", "needs-human-decision"]) {
    assert.equal(shouldShowTabLoading(false, [{ status }]), false, `${status} is not loading`);
  }
  assert.equal(shouldShowTabLoading(false, [{ status: "completed" }, { status: "failed" }, { status: "cancelled" }]), false,
    "the final terminal child clears loading");
});

test("revived chat tabs and running frames use stable icons that survive extension updates", async t => {
  let manager;
  const storage = await temporary(t, async () => {
    manager?.dispose();
    await manager?.tabIconPreparation;
  });
  const listeners = () => ({ dispose() {} });
  const panels = [];
  const panel = () => {
    const created = {
      active: false, visible: false, iconPath: undefined, title: "",
      webview: { onDidReceiveMessage: listeners, async postMessage() { return true; } },
      onDidDispose: listeners, onDidChangeViewState: listeners, dispose() {}, reveal() {}
    };
    panels.push(created);
    return created;
  };
  const vscode = {
    Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    Uri: vscodeUri, ViewColumn: { Active: 1 },
    window: { createWebviewPanel: panel },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }), name: "Icon test", workspaceFolders: [],
      createFileSystemWatcher: () => ({ onDidChange: listeners, onDidCreate: listeners, onDidDelete: listeners, dispose() {} })
    }
  };
  const { ChatPanelManager } = await load("chat-panel-manager.ts", vscode);
  manager = new ChatPanelManager(
    { extensionUri: { fsPath: extensionRoot }, globalStorageUri: { fsPath: storage }, globalState: { get: (_key, fallback) => fallback, async update() {} }, subscriptions: [] },
    { localResourceRoots: [], render: async () => "<html></html>" }, () => [],
    async () => ({ available: false, diagnostic: "Runtime unavailable in fixture" })
  );
  const stable = join(storage, "tab-icons");

  const restored = panel();
  await manager.revive(restored, { panelId: "restored", title: "깃", role: "main" });
  await manager.tabIconPreparation;
  assert.equal(restored.iconPath.fsPath, join(stable, "agent-factory.png"));

  await manager.openDraft();
  const created = panels.at(-1);
  assert.equal(created.iconPath.fsPath, join(stable, "agent-factory.png"));
  const managed = [...manager.panels.values()].find(candidate => candidate.panel === created);
  managed.runningTitle.refresh();
  assert.equal(created.iconPath.fsPath, join(stable, "loading-squares-0.svg"));
  managed.runningTitle.setRunning(false);
  assert.equal(created.iconPath.fsPath, join(stable, "agent-factory.png"));
  for (const name of ["agent-factory.png", "loading-squares-0.svg"]) await stat(join(stable, name));
});

test("revived Main tabs restore and poll aggregate child loading from durable status", async t => {
  let manager;
  const storage = await temporary(t, async () => {
    manager?.dispose();
    await manager?.tabIconPreparation;
  });
  const listeners = () => ({ dispose() {} });
  const created = {
    active: false, visible: false, iconPath: undefined, title: "",
    webview: { onDidReceiveMessage: listeners, async postMessage() { return true; } },
    onDidDispose: listeners, onDidChangeViewState: listeners, dispose() {}, reveal() {}
  };
  const vscode = {
    Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } },
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    Uri: vscodeUri, ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => created },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }), name: "Child loading test", workspaceFolders: [],
      createFileSystemWatcher: () => ({ onDidChange: listeners, onDidCreate: listeners, onDidDelete: listeners, dispose() {} })
    }
  };
  let children = [
    { agentId: "work-one", runId: "run-one", role: "work", status: "running" },
    { agentId: "verify-two", runId: "run-two", role: "verification", status: "running" }
  ];
  const client = {
    async listSessions() { return [{ agentId: "main-parent" }]; },
    async listChildSessions() { return children; },
    async advanceWorkflows() { return undefined; }
  };
  const { ChatPanelManager } = await load("chat-panel-manager.ts", vscode);
  manager = new ChatPanelManager(
    { extensionUri: { fsPath: extensionRoot }, globalStorageUri: { fsPath: storage }, globalState: { get: (_key, fallback) => fallback, async update() {} }, subscriptions: [] },
    { localResourceRoots: [], render: async () => "<html></html>" }, () => [], async () => ({ available: true, client })
  );
  await manager.revive(created, { panelId: "restored-child", title: "Main", role: "main", agentId: "main-parent" });
  const managed = manager.panels.get("restored-child");

  await manager.sendAgentList(managed);
  assert.match(created.iconPath.fsPath, /loading-squares-\d\.svg$/, "restore reads active child state");

  children = [
    { ...children[0], status: "completed" },
    children[1]
  ];
  await manager.sendAgentList(managed);
  assert.match(created.iconPath.fsPath, /loading-squares-\d\.svg$/, "one completion preserves the other active child");

  children = [
    { ...children[0], status: "completed" },
    { ...children[1], status: "failed" }
  ];
  await manager.sendAgentList(managed);
  assert.match(created.iconPath.fsPath, /agent-factory\.png$/, "the last terminal child clears loading");

  children = [{ ...children[1], status: "needs-human-decision" }];
  await manager.sendAgentList(managed);
  assert.match(created.iconPath.fsPath, /agent-factory\.png$/, "input waiting stays idle");
});
