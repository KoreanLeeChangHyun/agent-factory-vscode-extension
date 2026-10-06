import assert from "node:assert/strict";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

test("agent deletion validates identity, acknowledgement and invalidates session caches", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/project");
  let agents = [{ agentId: "main-one", role: "main", sessionId: "native-one" }];
  const calls = [];
  client.command = async args => {
    calls.push(args);
    if (args[0] === "list") return { agents };
    agents = [];
    return { kind: "agent-deleted", agentId: "main-one", deletedRuns: [{ agentId: "main-one", runId: "run-one" }] };
  };
  assert.equal((await client.listSessions()).length, 1);
  await client.deleteAgent("main-one");
  assert.deepEqual(calls[1].slice(0, 5), ["delete-agent", "--project-root", "/project", "--agent", "main-one"]);
  assert.ok(calls[1].includes("human"));
  assert.equal((await client.listSessions()).length, 0);
  await assert.rejects(client.deleteAgent("../source"));
  assert.equal(calls.length, 3);
});

test("failed or mismatched agent deletion preserves cached sessions", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/project");
  client.command = async () => ({ agents: [{ agentId: "main-one", role: "main", sessionId: "native-one" }] });
  const before = await client.listSessions();
  client.command = async () => { throw new Error("Active execution must finish"); };
  await assert.rejects(client.deleteAgent("main-one"), /Active execution/);
  assert.deepEqual(await client.listSessions(), before);
  client.command = async () => ({ kind: "agent-deleted", agentId: "main-other" });
  await assert.rejects(client.deleteAgent("main-one"), /acknowledgement/);
  assert.deepEqual(await client.listSessions(), before);
});

const { createRequire } = await import("node:module");
const { runInNewContext } = await import("node:vm");
const { build } = await import("esbuild");
const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ["src/infrastructure/vscode/chat-panel-manager.ts"], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["vscode"] });
const module = { exports: {} };
const vscode = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }, window: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, process, Buffer, URL, structuredClone,
  setTimeout, clearTimeout, console, global: { Date }, require: name => name === "vscode" ? vscode : require(name) });

function host(client) {
  const selected = { panelId: "panel-one", title: "One", role: "main", agentId: "main-one" };
  const other = { panelId: "panel-other", title: "Other", role: "main", agentId: "main-other" };
  const storage = new Map([["agentFactory.sidebar.agents", [selected, other]], ["agentFactory.mainChat.lastPanel", "panel-one"]]);
  const manager = new module.exports.ChatPanelManager({ workspaceState: {
    get: key => storage.get(key), update: async (key, value) => storage.set(key, value)
  } }, {}, () => [], async () => ({ available: true, client }));
  manager.broadcast = async () => {};
  manager.sendAgentList = async () => {};
  return { manager, storage, selected, other };
}

test("Host closes all selected panels and removes saved references only after runtime success", async () => {
  const calls = [], closed = [];
  const h = host({ deleteAgent: async id => { calls.push(id); return { kind: "agent-deleted", agentId: id }; } });
  for (const [panelId, agentId] of [["panel-one", "main-one"], ["duplicate", "main-one"], ["panel-other", "main-other"]]) {
    h.manager.panels.set(panelId, { state: { panelId, agentId }, panel: { dispose: () => {
      closed.push(panelId); h.manager.panels.delete(panelId);
    } } });
  }
  await h.manager.deleteSidebarAgent(h.selected);
  assert.deepEqual(calls, ["main-one"]);
  assert.deepEqual(closed, ["panel-one", "duplicate"]);
  assert.deepEqual(Array.from(h.storage.get("agentFactory.sidebar.agents"), item => item.agentId), ["main-other"]);
  assert.equal(h.storage.get("agentFactory.mainChat.lastPanel"), undefined);
  await h.manager.rememberAgent(h.selected);
  assert.deepEqual(Array.from(h.storage.get("agentFactory.sidebar.agents"), item => item.agentId), ["main-other"], "Late callbacks cannot resurrect the deleted entry");
});

test("Host failure and active queued work preserve saved entries and panels", async () => {
  const h = host({ deleteAgent: async () => { throw new Error("Shared reference prevents deletion"); } });
  const panel = { state: h.selected, panel: { dispose() { throw new Error("must remain open"); } } };
  h.manager.panels.set("panel-one", panel);
  await assert.rejects(h.manager.deleteSidebarAgent(h.selected), /Shared reference/);
  assert.equal(h.storage.get("agentFactory.sidebar.agents").length, 2);
  panel.controller = { running: true };
  await assert.rejects(h.manager.deleteSidebarAgent(h.selected), /active|finish/i);
  assert.equal(h.manager.panels.size, 1);
});

test("unsent drafts are removed locally and stale serialized deleted sessions cannot revive", async () => {
  let deletes = 0;
  const h = host({ deleteAgent: async () => { deletes++; }, listSessions: async () => [] });
  const draft = { panelId: "draft", title: "Draft", role: "main" };
  await h.manager.rememberAgent(draft);
  await h.manager.deleteSidebarAgent(draft);
  assert.equal(deletes, 0);
  assert.equal(h.storage.get("agentFactory.sidebar.agents").length, 2);
  let attached = false, disposed = false;
  h.manager.attach = async () => { attached = true; };
  h.manager.newChatPreferences = () => ({});
  await h.manager.revive({ dispose() { disposed = true; } }, h.selected);
  assert.equal(attached, false);
  assert.equal(disposed, true);
});

test("fresh Host filters missing bound sessions and serialized deleted drafts stay removed", async () => {
  const h = host({ listSessions: async () => [] });
  assert.equal((await h.manager.sidebarAgents()).length, 0, "A stale saved session cannot substitute for a runtime session");
  const draft = { panelId: "draft-deleted", title: "Draft", role: "main" };
  await h.manager.rememberAgent(draft);
  await h.manager.deleteSidebarAgent(draft);
  h.manager.deletedPanels.clear();
  let restored = false;
  h.manager.attach = async () => { restored = true; };
  h.manager.newChatPreferences = () => ({});
  await h.manager.revive({ dispose() {} }, draft);
  assert.equal(restored, false, "The persisted UI marker protects drafts with no runtime identity");
});

test("real Host client removes only the selected agent and fresh clients see physical absence", async t => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const base = await mkdtemp(join(tmpdir(), "af-agent-delete-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project"), home = join(base, "home");
  await mkdir(project);
  const script = new URL("../../../plugin/scripts/exec.py", import.meta.url).pathname;
  const { stdout } = await promisify(execFile)("python3", [script, "init", "--project-root", project, "--runtime-home", home]);
  const binding = JSON.parse(stdout);
  const store = async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const agentId of ["main-delete", "main-keep"]) {
    await store(join(binding.agentsRoot, agentId, "session.json"), { agentId, role: "main", sessionId: null, projectRoot: project });
    await store(join(binding.agentsRoot, agentId, "runs", "run-" + agentId, "state.json"), { agentId, runId: "run-" + agentId, role: "main", status: "completed" });
    await store(join(binding.agentsRoot, agentId, "runs", "run-" + agentId, "events.jsonl"), agentId);
  }
  await store(join(project, "source.txt"), "keep project source");
  const client = () => {
    const value = new AgentFactoryClient(script, project);
    value.location = async () => binding;
    return value;
  };
  const original = client();
  assert.equal((await original.listSessions()).length, 2);
  await original.deleteAgent("main-delete");
  await assert.rejects(readFile(join(binding.agentsRoot, "main-delete", "session.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(binding.agentsRoot, "main-delete", "runs", "run-main-delete", "events.jsonl")), { code: "ENOENT" });
  assert.equal(await readFile(join(binding.agentsRoot, "main-keep", "runs", "run-main-keep", "events.jsonl"), "utf8"), "main-keep");
  assert.equal(await readFile(join(project, "source.txt"), "utf8"), "keep project source");
  for (const fresh of [original, client()]) assert.deepEqual((await fresh.listSessions()).map(item => item.agentId), ["main-keep"]);
});
