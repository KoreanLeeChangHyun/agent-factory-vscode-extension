import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({ entryPoints: [new URL("../../src/infrastructure/vscode/agent-sidebar.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] });

function harness(storage = new Map(), options = {}) {
  const commands = new Map(), inputs = [], picks = [], opened = [], renamed = [];
  const agents = options.agents ?? [{ state: { panelId: "draft-one", title: "First", role: "main" }, running: false },
    { state: { panelId: "second", agentId: "main-second", title: "Second" }, running: true }];
  let listener;
  const tree = { onDidChangeVisibility() { return { dispose() {} }; }, dispose() {} };
  const vscode = {
    DataTransferItem: class { constructor(value) { this.value = value; } },
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
    get: key => storage.get(key), async update(key, value) {
      const snapshot = structuredClone(value);
      if (options.update) await options.update(key, snapshot, storage);
      else storage.set(key, snapshot);
    }
  } }, panels);
  return { sidebar, agents, inputs, picks, opened, renamed, storage, tree, notify: () => listener?.(),
    run: (name, node) => commands.get(`agentFactory.sidebar.${name}`)(node) };
}

function agent(panelId) {
  return { state: { panelId, agentId: `main-${panelId}`, title: panelId }, running: false };
}

function agentIds(nodes) {
  return Array.from(nodes).filter(node => node.kind === "agent").map(node => node.agent.state.panelId);
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

test("drag and drop moves multiple agents, supports agent targets, persists and ungroups", async () => {
  const h = harness();
  await h.sidebar.refresh();
  const agents = h.sidebar.getChildren();
  h.inputs.push("Drag group");
  await h.run("newGroup");
  const group = h.sidebar.getChildren()[0];
  const transfer = new Map(), token = { isCancellationRequested: false };
  h.sidebar.handleDrag([agents[0]], transfer, token);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.equal(h.sidebar.getChildren(group).length, 1);
  h.sidebar.handleDrag([agents[1]], transfer, token);
  await h.sidebar.handleDrop(h.sidebar.getChildren(group)[0], transfer, token);
  assert.equal(h.sidebar.getChildren(group).length, 2);
  const restored = harness(h.storage);
  await restored.sidebar.refresh();
  assert.equal(restored.sidebar.getChildren(restored.sidebar.getChildren()[0]).length, 2);
  restored.sidebar.dispose();
  h.sidebar.handleDrag(h.sidebar.getChildren(group), transfer, token);
  await h.sidebar.handleDrop(undefined, transfer, token);
  assert.equal(h.sidebar.getChildren(group).length, 0);
  assert.equal(h.sidebar.getChildren().filter(node => node.kind === "agent").length, 2);
  h.sidebar.dispose();
});

test("agent targets insert before the row and multi-selection keeps displayed order", async () => {
  const h = harness(new Map(), { agents: [agent("a"), agent("b"), agent("c"), agent("d")] });
  await h.sidebar.refresh();
  const token = { isCancellationRequested: false };
  const transfer = new Map();
  let nodes = h.sidebar.getChildren();
  h.sidebar.handleDrag([nodes[3]], transfer, token);
  await h.sidebar.handleDrop(nodes[1], transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["a", "d", "b", "c"], "a later row can move upward");

  nodes = h.sidebar.getChildren();
  h.sidebar.handleDrag([nodes[0]], transfer, token);
  await h.sidebar.handleDrop(nodes[3], transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["d", "b", "a", "c"], "an earlier row can move downward before its target");

  nodes = h.sidebar.getChildren();
  h.sidebar.handleDrag([nodes[2], nodes[0]], transfer, token);
  await h.sidebar.handleDrop(nodes[1], transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["d", "a", "b", "c"], "payload order does not replace displayed order");
  h.sidebar.handleDrag(h.sidebar.getChildren().slice(0, 2), transfer, token);
  await h.sidebar.handleDrop(h.sidebar.getChildren()[1], transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["d", "a", "b", "c"], "a selected target is a no-op");

  h.sidebar.handleDrag([h.sidebar.getChildren()[0]], transfer, token);
  await h.sidebar.handleDrop(undefined, transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["a", "b", "c", "d"], "empty space appends to the root list");
  h.sidebar.dispose();
});

test("group drops and menu moves append while deleting a group moves its block to root end", async () => {
  const h = harness(new Map(), { agents: [agent("a"), agent("b"), agent("c"), agent("d")] });
  await h.sidebar.refresh();
  h.inputs.push("Group");
  await h.run("newGroup");
  const group = h.sidebar.getChildren()[0];
  const token = { isCancellationRequested: false }, transfer = new Map();
  let roots = h.sidebar.getChildren().filter(node => node.kind === "agent");
  h.sidebar.handleDrag([roots[1], roots[0]], transfer, token);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren(group)), ["a", "b"]);
  roots = h.sidebar.getChildren().filter(node => node.kind === "agent");
  h.sidebar.handleDrag([roots[0]], transfer, token);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren(group)), ["a", "b", "c"], "dropping on a group appends");

  h.picks.push(1);
  await h.run("move", h.sidebar.getChildren(group)[0]);
  assert.deepEqual(agentIds(h.sidebar.getChildren(group)), ["b", "c", "a"], "menu moves use the same destination-last rule");
  await h.run("deleteGroup", group);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["d", "b", "c", "a"]);
  h.sidebar.dispose();
});

test("legacy layouts adopt catalog order, retain unknown entries and append new sessions", async () => {
  const storage = new Map([["agentFactory.sidebar.groups", {
    groups: [], assignments: {}
  }]]);
  const h = harness(storage, { agents: [agent("a"), agent("b")] });
  await h.sidebar.refresh();
  assert.deepEqual(storage.get("agentFactory.sidebar.groups").order, ["a", "b"]);
  h.agents.unshift(agent("new"));
  await h.sidebar.refresh();
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["a", "b", "new"]);
  h.sidebar.dispose();

  const saved = storage.get("agentFactory.sidebar.groups");
  saved.order.splice(1, 0, "temporarily-missing");
  storage.set("agentFactory.sidebar.groups", saved);
  const restored = harness(storage, { agents: [agent("a"), agent("b"), agent("new"), agent("later")] });
  await restored.sidebar.refresh();
  assert.deepEqual(agentIds(restored.sidebar.getChildren()), ["a", "b", "new", "later"]);
  assert.deepEqual(storage.get("agentFactory.sidebar.groups").order, ["a", "temporarily-missing", "b", "new", "later"]);
  restored.sidebar.dispose();
});

test("drag and drop ignores cancellation, foreign payloads and stale targets", async () => {
  const h = harness(), other = harness();
  await h.sidebar.refresh();
  await other.sidebar.refresh();
  h.inputs.push("Target");
  await h.run("newGroup");
  const group = h.sidebar.getChildren()[0], agent = h.sidebar.getChildren()[1];
  const transfer = new Map(), token = { isCancellationRequested: false };
  h.sidebar.handleDrag([group], transfer, token);
  assert.equal(transfer.size, 1);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.equal(h.sidebar.getChildren()[0].group.id, group.group.id);
  transfer.clear();
  other.sidebar.handleDrag(other.sidebar.getChildren(), transfer, token);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.equal(h.sidebar.getChildren(group).length, 0);
  h.sidebar.handleDrag([agent], transfer, token);
  await h.sidebar.handleDrop(group, transfer, { isCancellationRequested: true });
  assert.equal(h.sidebar.getChildren(group).length, 0);
  h.sidebar.handleDrag([agent], transfer, token);
  const [removed] = h.agents.splice(h.agents.findIndex(entry => entry.state.panelId === agent.agent.state.panelId), 1);
  await h.sidebar.refresh();
  await h.sidebar.handleDrop(group, transfer, token);
  assert.equal(h.sidebar.getChildren(group).length, 0);
  h.agents.push(removed);
  await h.sidebar.refresh();
  await h.run("deleteGroup", group);
  await h.sidebar.handleDrop(group, transfer, token);
  assert.equal(h.sidebar.getChildren().length, 2);
  h.sidebar.dispose();
  other.sidebar.dispose();
});

test("dragging directories reorders them, preserves members, and persists the order", async () => {
  const h = harness();
  await h.sidebar.refresh();
  for (const name of ["One", "Two", "Three"]) {
    h.inputs.push(name);
    await h.run("newGroup");
  }
  const [one, two, three] = h.sidebar.getChildren();
  const transfer = new Map(), token = { isCancellationRequested: false };
  h.sidebar.handleDrag([h.sidebar.getChildren()[3]], transfer, token);
  await h.sidebar.handleDrop(one, transfer, token);
  h.sidebar.handleDrag([three], transfer, token);
  await h.sidebar.handleDrop(one, transfer, token);
  assert.deepEqual(Array.from(h.sidebar.getChildren().filter(node => node.kind === "group"), node => node.group.name),
    ["Three", "One", "Two"]);
  assert.equal(h.sidebar.getChildren(one).length, 1);
  const restored = harness(h.storage);
  await restored.sidebar.refresh();
  assert.deepEqual(Array.from(restored.sidebar.getChildren().filter(node => node.kind === "group"), node => node.group.name),
    ["Three", "One", "Two"]);
  assert.equal(restored.sidebar.getChildren(restored.sidebar.getChildren()[1]).length, 1);
  restored.sidebar.dispose();
  h.sidebar.handleDrag([three], transfer, token);
  await h.sidebar.handleDrop(undefined, transfer, token);
  assert.deepEqual(Array.from(h.sidebar.getChildren().filter(node => node.kind === "group"), node => node.group.name),
    ["One", "Two", "Three"]);
  h.sidebar.dispose();
});

test("archiving hides agents across refresh and reload while preserving records and groups", async () => {
  const storage = new Map();
  const h = harness(storage);
  await h.sidebar.refresh();
  const first = h.sidebar.getChildren()[0];
  h.inputs.push('Preserved group');
  await h.run('newGroup');
  h.picks.push(1);
  await h.run('move', first);
  await h.run('archive', first);
  const group = h.sidebar.getChildren()[0];
  assert.equal(h.sidebar.getChildren(group).length, 0);
  assert.equal(h.agents.length, 2, 'Underlying agents are retained');
  await h.sidebar.refresh();
  assert.equal(h.sidebar.getChildren(group).length, 0);
  h.sidebar.dispose();
  const restored = harness(storage);
  await restored.sidebar.refresh();
  assert.equal(restored.sidebar.getChildren(restored.sidebar.getChildren()[0]).length, 0);
  await restored.run('restore');
  assert.equal(storage.get('agentFactory.sidebar.archived').length, 1);
  restored.picks.push(0);
  await restored.run('restore');
  assert.equal(restored.sidebar.getChildren(restored.sidebar.getChildren()[0])[0].agent.state.panelId, 'draft-one');
  assert.equal(storage.get('agentFactory.sidebar.archived').length, 0);
  restored.sidebar.dispose();
});

test("archive restore keeps the saved position while visible agents are reordered", async () => {
  const h = harness(new Map(), { agents: [agent("a"), agent("b"), agent("c")] });
  await h.sidebar.refresh();
  await h.run("archive", h.sidebar.getChildren()[1]);
  const transfer = new Map(), token = { isCancellationRequested: false };
  h.sidebar.handleDrag([h.sidebar.getChildren()[1]], transfer, token);
  await h.sidebar.handleDrop(h.sidebar.getChildren()[0], transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["c", "a"]);
  h.picks.push(0);
  await h.run("restore");
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["c", "a", "b"]);
  h.sidebar.dispose();
});

test("archiving a running agent does not stop it and matches its runtime identity", async () => {
  const h = harness();
  await h.sidebar.refresh();
  const running = h.sidebar.getChildren()[1];
  await Promise.all([h.run('archive', running), h.run('archive', running)]);
  assert.equal(h.storage.get('agentFactory.sidebar.archived').length, 1);
  assert.equal(h.agents[1].running, true);
  h.agents[1].state.panelId = 'restored-panel';
  await h.sidebar.refresh();
  assert.deepEqual(Array.from(h.sidebar.getChildren(), node => node.agent.state.panelId), ['draft-one']);
  h.picks.push(0);
  await h.run('restore');
  assert.equal(h.sidebar.getChildren().length, 2);
  assert.equal(h.agents[1].running, true);
  h.sidebar.dispose();
});

test("archive storage failures leave the agent visible and allow retry", async () => {
  const h = harness();
  await h.sidebar.refresh();
  const agent = h.sidebar.getChildren()[0];
  const set = h.storage.set;
  h.storage.set = () => { throw new Error('storage unavailable'); };
  await assert.rejects(h.run('archive', agent), /storage unavailable/);
  assert.equal(h.sidebar.getChildren().length, 2);
  h.storage.set = set;
  await h.run('archive', agent);
  assert.equal(h.sidebar.getChildren().length, 1);
  h.sidebar.dispose();
});

test("layout writes are serialized and preserve the newest snapshot", async () => {
  let active = 0, maximum = 0;
  const snapshots = [];
  const h = harness(new Map(), { update: async (key, value, storage) => {
    if (key !== "agentFactory.sidebar.groups") {
      storage.set(key, value);
      return;
    }
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    snapshots.push(value);
    storage.set(key, value);
    active -= 1;
  } });
  await h.sidebar.refresh();
  snapshots.length = 0;
  h.inputs.push("One", "Two");
  await Promise.all([h.run("newGroup"), h.run("newGroup")]);
  assert.equal(maximum, 1);
  assert.deepEqual(snapshots.map(snapshot => snapshot.groups.map(group => group.name)), [["One"], ["One", "Two"]]);
  assert.deepEqual(h.storage.get("agentFactory.sidebar.groups").groups.map(group => group.name), ["One", "Two"]);
  h.sidebar.dispose();
});

test("layout storage failures keep the in-memory order and a later mutation retries it", async () => {
  let fail = false;
  const h = harness(new Map(), { agents: [agent("a"), agent("b"), agent("c")], update: async (key, value, storage) => {
    if (key === "agentFactory.sidebar.groups" && fail) {
      fail = false;
      throw new Error("layout unavailable");
    }
    storage.set(key, value);
  } });
  await h.sidebar.refresh();
  const transfer = new Map(), token = { isCancellationRequested: false };
  fail = true;
  h.sidebar.handleDrag([h.sidebar.getChildren()[2]], transfer, token);
  await assert.rejects(h.sidebar.handleDrop(h.sidebar.getChildren()[0], transfer, token), /layout unavailable/);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["c", "a", "b"], "failed persistence does not roll back the screen");

  h.sidebar.handleDrag([h.sidebar.getChildren()[1]], transfer, token);
  await h.sidebar.handleDrop(undefined, transfer, token);
  assert.deepEqual(agentIds(h.sidebar.getChildren()), ["c", "b", "a"]);
  assert.deepEqual(h.storage.get("agentFactory.sidebar.groups").order, ["c", "b", "a"]);
  h.sidebar.dispose();
});
