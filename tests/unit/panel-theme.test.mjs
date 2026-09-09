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
      build.onLoad({ filter: /.*/, namespace: "theme-test" }, () => ({ contents: "export async function readCliTheme() { return globalThis.__readTheme(); }", loader: "js" }));
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

async function flush() {
  // Event callbacks intentionally launch refresh promises without returning them.
  await new Promise(resolve => setImmediate(resolve));
}

async function fixture(t) {
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
      name: "Theme test", workspaceFolders: [],
      createFileSystemWatcher(pattern) { watcher.pattern = pattern; return watcher; }
    }
  };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, Buffer, console,
    process: { env: { CODEX_HOME: "/isolated/theme-test-home" } },
    require: name => name === "vscode" ? vscode : require(name),
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    __readTheme() { reads++; return readTheme(); }
  });
  const manager = new module.exports.ChatPanelManager(
    { extensionUri: { fsPath: "/extension" }, globalState: { get: () => undefined } },
    { localResourceRoots: [], render: async () => "<html></html>" }, () => [],
    async () => { operations.push("connectRuntime"); return { available: false, diagnostic: "Runtime unavailable in fixture" }; }
  );
  await manager.openDraft();
  t.after(() => manager.dispose());
  const themes = () => messages.filter(message => message.type === "syntax.theme");
  return {
    manager, panel, watcher, messages, operations, themes,
    reads: () => reads,
    select(value) { selection = value; },
    deferRead(fn) { readTheme = fn; },
    ready: () => receive.fire({ type: "client.ready" }),
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
