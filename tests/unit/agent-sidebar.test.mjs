import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({ entryPoints: [new URL("../../src/infrastructure/vscode/agent-sidebar.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });

function harness(storage = new Map()) {
  const commands = new Map(), inputs = [], picks = [], opened = [], renamed = [];
  const agents = [{ state: { panelId: "draft-one", title: "First", role: "main" }, running: false },
    { state: { panelId: "second", agentId: "main-second", title: "Second" }, running: true }];
  let listener;
  const tree = { onDidChangeVisibility() { return { dispose() {} }; }, dispose() {} };
  const vscode = {
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    window: { createTreeView() { return tree; }, async showInputBox() { return inputs.shift(); },
      async showQuickPick(items) { const index = picks.shift(); return index === undefined ? undefined : items[index]; },
      async showErrorMessage(message) { throw new Error(message); } },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return { dispose() { commands.delete(id); } }; } }
  };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, setTimeout, clearTimeout,
    require: name => name === "vscode" ? vscode : require(name) });
  const panels = { async sidebarAgents() { return agents; },
    onAgentsChanged(callback) { listener = callback; return { dispose() { listener = undefined; } }; },
    async openSidebarAgent(state) { opened.push(state); },
    async renameSidebarAgent(state, title) { renamed.push(title); agents.find(agent => agent.state.panelId === state.panelId).state.title = title; }
  };
  const sidebar = new module.exports.AgentSidebar({ workspaceState: {
    get: key => storage.get(key), async update(key, value) { storage.set(key, structuredClone(value)); }
  } }, panels);
  return { sidebar, agents, inputs, picks, opened, renamed, storage, tree, notify: () => listener?.(),
    run: (name, node) => commands.get(`agentFactory.sidebar.${name}`)(node) };
}

test("sidebar opens agents, renames them and displays running status", async () => {
  const h = harness();
  await h.sidebar.refresh();
  const [first, second] = h.sidebar.getChildren();
  assert.equal(h.sidebar.getTreeItem(second).iconPath.id, "loading~spin");
  await h.run("open", first);
  assert.equal(h.opened[0].panelId, "draft-one");
  h.inputs.push("Renamed");
  await h.run("rename", first);
  assert.equal(h.sidebar.getTreeItem(h.sidebar.getChildren()[0]).label, "Renamed");
  h.sidebar.dispose();
});

test("groups persist across reload and session binding; removing a group preserves its agents", async () => {
  const h = harness();
  await h.sidebar.refresh();
  const first = h.sidebar.getChildren()[0];
  h.inputs.push("Project A");
  await h.run("newGroup");
  h.picks.push(1);
  await h.run("move", first);
  let group = h.sidebar.getChildren()[0];
  assert.equal(h.sidebar.getChildren(group).length, 1);
  h.agents[0].state.agentId = "main-bound";
  await h.sidebar.refresh();
  assert.equal(h.sidebar.getChildren(group)[0].agent.state.agentId, "main-bound");
  h.inputs.push("Project B");
  await h.run("renameGroup", group);
  assert.equal(h.sidebar.getTreeItem(group).label, "Project B");
  h.sidebar.dispose();
  const restored = harness(h.storage);
  await restored.sidebar.refresh();
  group = restored.sidebar.getChildren()[0];
  assert.equal(group.group.name, "Project B");
  assert.equal(restored.sidebar.getChildren(group)[0].agent.state.panelId, "draft-one");
  await restored.run("deleteGroup", group);
  assert.equal(restored.sidebar.getChildren().length, 2);
  assert.ok(restored.sidebar.getChildren().every(node => node.kind === "agent"));
  restored.sidebar.dispose();
});

test("cancelled name and group prompts leave the layout intact", async () => {
  const h = harness();
  await h.sidebar.refresh();
  await h.run("newGroup");
  await h.run("rename", h.sidebar.getChildren()[0]);
  await h.run("move", h.sidebar.getChildren()[0]);
  assert.equal(h.sidebar.getChildren().length, 2);
  assert.equal(h.renamed.length, 0);
  h.sidebar.dispose();
});
