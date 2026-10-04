import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import { importTypeScript } from "../support/import-typescript.mjs";

const runtimeHome = await mkdtemp(join(tmpdir(), "af-workflow-decision-home-"));
process.env.AGENT_FACTORY_HOME = runtimeHome;
test.after(() => rm(runtimeHome, { recursive: true, force: true }));
const agentsRoot = root => join(runtimeHome, "projects", "project-" + createHash("sha256").update(root).digest("hex").slice(0, 32), "agents");

const PAUSE = { code: "revision_limit_reached", revisionCount: 3, maxRevisions: 3, pendingFindingIds: ["finding-1"], findings: [] };

/** A stopped loop owned by `main-owner`, with a fake loop.py that records each invocation. */
async function stoppedLoop(t, { createdAt = "2026-10-03T10:00:00Z", snapshot = {} } = {}) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-workflow-decision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root);
  const parent = join(directory, "main-owner", "runs", "run-parent", "state.json");
  await mkdir(dirname(parent), { recursive: true });
  const policy = { schemaVersion: 1, sandboxPolicy: { type: "workspace-write", writable_roots: [root] }, approvalPolicy: "never" };
  await writeFile(parent, JSON.stringify({ executionPolicy: policy }));
  const loopRoot = join(directory, "work-one", "loops", "loop-one");
  await mkdir(loopRoot, { recursive: true });
  await writeFile(join(loopRoot, "state.json"), JSON.stringify({ workflow: { id: "flow", tasks: [{ id: "task-one" }] }, status: "needs-human-decision", parentStatePath: parent,
    ...(createdAt ? { createdAt } : {}) }));
  const calls = join(root, "loop-calls.jsonl");
  const response = { workflow: { id: "flow", tasks: [{ id: "task-one" }] }, workAgentId: "work-one", kind: "work-verification-loop", loopId: "loop-one", status: "needs-human-decision", pause: PAUSE, ...snapshot };
  await writeFile(join(root, "loop.py"), [
    "import json, os, sys",
    `open(${JSON.stringify(calls)}, 'a').write(json.dumps({'argv': sys.argv[1:], 'parent': os.environ.get('AGENT_FACTORY_PARENT_STATE'), 'policy': json.loads(os.environ['AGENT_FACTORY_EXECUTION_POLICY'])}) + '\\n')`,
    `response = json.loads(${JSON.stringify(JSON.stringify(response))})`,
    "if sys.argv[1] == 'extend-revisions': response.update(status='active', pause=None)",
    "if sys.argv[1] in ('close', 'stop-task'): response.update(status='cancelled', pause=None)",
    "print(json.dumps(response))", ""].join("\n"));
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: runtimeHome, projectId: "project-test", agentsRoot: directory });
  const probes = [];
  client.capabilities = async agentId => { probes.push(agentId); return { submit: { revisionLimitPause: true }, send: {} }; };
  const recorded = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { client, root, parent, policy, recorded, probes, children: [{ agentId: "work-one", role: "work", status: "completed", runId: "run-one" }] };
}

test("workflow decision protocol accepts exactly continue and stop with bounded identities", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const request = { type: "workflow.decision", workAgentId: "worker", loopId: "loop-one", decision: "continue" };
  assert.deepEqual(parseClientMessage(request), request);
  assert.deepEqual(parseClientMessage({ ...request, decision: "stop", extra: "dropped" }), { ...request, decision: "stop" });
  // No third action: accepting the failed Verification is not a panel decision.
  for (const decision of ["finish", "skip", "accept", "", undefined, true]) assert.equal(parseClientMessage({ ...request, decision }), undefined, String(decision));
  assert.equal(parseClientMessage({ ...request, loopId: "../other" }), undefined);
  assert.equal(parseClientMessage({ ...request, workAgentId: undefined }), undefined);
});

test("continue authorizes three more revisions and stop closes the loop, each as the Human bound to the parent run", async t => {
  const { REVISION_LIMIT_EXTENSION } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.equal(REVISION_LIMIT_EXTENSION, 3);
  const human = evidence => ["--project-root", null, "--runtime-home", runtimeHome, "--project-id", "project-test", "--work-agent", "work-one", "--loop-id", "loop-one",
    "--actor", "human", "--authorization-reference", "chat:main-owner:workflow:loop-one", "--decision-evidence", evidence];
  for (const [decision, command, evidence, extra, status] of [
    ["continue", "extend-revisions", "Human selected Continue at the revision limit (3 more revisions)", ["--additional", "3"], "active"],
    ["stop", "close", "Human selected Stop at the revision limit", [], "cancelled"]]) {
    const fixture = await stoppedLoop(t);
    // Only the Main conversation that started the loop can decide; nothing runs for another one.
    await assert.rejects(fixture.client.decideRevisionLimit("main-other", "work-one", "loop-one", decision), /does not belong/);
    assert.deepEqual(await fixture.recorded(), []);
    const snapshot = await fixture.client.decideRevisionLimit("main-owner", "work-one", "loop-one", decision);
    const expected = human(evidence); expected[1] = fixture.root;
    assert.deepEqual(await fixture.recorded(), [{ argv: [command, ...expected, ...extra], parent: fixture.parent, policy: fixture.policy }], decision);
    assert.equal(snapshot.status, status);
    assert.deepEqual([snapshot.parentAgentId, snapshot.parentRunId], ["main-owner", "run-parent"]);
  }
  // The existing failed-workflow close keeps its own evidence.
  const fixture = await stoppedLoop(t);
  await fixture.client.closeWorkflow("main-owner", "work-one", "loop-one");
  const [closed] = await fixture.recorded();
  assert.equal(closed.argv[0], "close");
  assert.equal(closed.argv[closed.argv.indexOf("--decision-evidence") + 1], "Human selected Close failed workflow");
  assert.equal(closed.argv.includes("--additional"), false);
});

test("the pause reaches the panel only from a runtime that advertises it; the loop start is the dispatch time", async t => {
  const advertised = await stoppedLoop(t);
  const [snapshot] = await advertised.client.advanceWorkflows("main-owner", advertised.children, false);
  assert.deepEqual(snapshot.pause, PAUSE);
  assert.deepEqual(advertised.probes, ["main-owner"], "the conversation's own cached probe");
  assert.equal(snapshot.dispatchedAt, "2026-10-03T10:00:00Z", "an older runtime's snapshot has no createdAt; the loop state does");
  assert.equal((await advertised.recorded())[0].argv[0], "status", "a panel refresh never advances the loop");

  for (const capabilities of [async () => ({ submit: {}, send: { revisionLimitPause: true } }), async () => { throw new Error("probe failed"); }]) {
    const older = await stoppedLoop(t);
    older.client.capabilities = capabilities;
    const [withheld] = await older.client.advanceWorkflows("main-owner", older.children, false);
    assert.equal("pause" in withheld, false, "without the capability today's text message stays the only notice");
    assert.equal(withheld.status, "needs-human-decision");
  }

  // The runtime's own createdAt wins; a loop with neither value gets no dispatch time.
  const current = await stoppedLoop(t, { snapshot: { createdAt: "2026-10-03T09:59:59Z" } });
  assert.equal((await current.client.advanceWorkflows("main-owner", current.children, false))[0].dispatchedAt, "2026-10-03T09:59:59Z");
  const untimed = await stoppedLoop(t, { createdAt: null });
  assert.equal("dispatchedAt" in (await untimed.client.advanceWorkflows("main-owner", untimed.children, false))[0], false);
  // An active loop carries no pause, so no capability probe is spent on it.
  const active = await stoppedLoop(t, { snapshot: { status: "active", pause: null } });
  assert.equal((await active.client.advanceWorkflows("main-owner", active.children, false))[0].pause, null);
  assert.deepEqual(active.probes, []);
});

test("child sessions carry their run's acceptance time and keep the list order other views use", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-dispatch-time-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(agentsRoot(root), "work-timed", "runs");
  await mkdir(join(runs, "run-a"), { recursive: true });
  await mkdir(join(runs, "run-b"), { recursive: true });
  await writeFile(join(runs, "run-a", "state.json"), JSON.stringify({ status: "completed", acceptedAt: "2026-10-03T10:00:00Z", updatedAt: "2026-10-03T10:05:00Z" }));
  await writeFile(join(runs, "run-b", "state.json"), JSON.stringify({ status: "running", updatedAt: "2026-10-03T10:06:00Z" }));
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: runtimeHome, projectId: "project-test", agentsRoot: agentsRoot(root) });
  assert.equal((await client.latestRunInfo("work-timed", "run-a")).dispatchedAt, "2026-10-03T10:00:00Z");
  assert.equal("dispatchedAt" in await client.latestRunInfo("work-timed", "run-b"), false, "a run state without the field adds none");
  const source = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /\.\.\.\(latest\.dispatchedAt \? \{ dispatchedAt: latest\.dispatchedAt \} : \{\}\)/);
  assert.match(source, /return agents\.sort\(\(left, right\) => \(right\.updatedAt \?\? ""\)\.localeCompare\(left\.updatedAt \?\? ""\)\);/,
    "the child-session list stays sorted by updatedAt for the other views");
});

test("only a Main chat's click reaches the runtime decision and its result refreshes the panel", async () => {
  const require = createRequire(import.meta.url);
  const output = await build({
    entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"]
  });
  const vscode = { ViewColumn: { Active: -1 }, Uri: { parse: value => ({ value }), file: fsPath => ({ fsPath }) }, ConfigurationTarget: { Global: 1 },
    window: {}, env: {}, commands: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, async update() {} }) } };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, Buffer, URL, console, process, setTimeout, clearTimeout,
    global: { Date }, require: name => name === "vscode" ? vscode : require(name) });
  const decisions = [];
  const children = [{ agentId: "work-one", role: "work", status: "running", runId: "run-two" }];
  let client = {
    async decideRevisionLimit(...args) { decisions.push(args); return { loopId: "loop-one", status: args[3] === "continue" ? "active" : "cancelled" }; },
    async listChildSessions() { return children; }
  };
  const manager = new module.exports.ChatPanelManager({ globalState: { get() {}, async update() {} } }, {}, () => [], async () => ({ available: true, client }));
  const panel = role => {
    const posted = [];
    return { posted, managed: { state: { role, agentId: role + "-one" }, panel: { webview: { async postMessage(message) { posted.push(message); return true; } } } } };
  };
  const message = decision => ({ type: "workflow.decision", workAgentId: "work-one", loopId: "loop-one", decision });

  const main = panel("main");
  await manager.handleMessage(main.managed, message("continue"));
  await manager.handleMessage(main.managed, message("stop"));
  assert.deepEqual(decisions, [["main-one", "work-one", "loop-one", "continue"], ["main-one", "work-one", "loop-one", "stop"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(main.posted)), [
    { type: "agents.list", agents: children, workflows: [{ loopId: "loop-one", status: "active" }] },
    { type: "agents.list", agents: children, workflows: [{ loopId: "loop-one", status: "cancelled" }] }]);

  // A Work or Verification chat cannot decide for the Human's Main conversation.
  for (const role of ["work", "verification"]) {
    const child = panel(role);
    await manager.handleMessage(child.managed, message("continue"));
    assert.deepEqual(child.posted, []);
  }
  assert.equal(decisions.length, 2);

  const stopMessage = { type: "task.stop", workflowId: "flow", taskId: "task-one", workAgentId: "work-one", loopId: "loop-one" };
  let release;
  let stops = 0;
  client = { async stopTask(owner, target) { stops++; assert.equal(owner, "main-one"); assert.equal(target.taskId, "task-one");
    await new Promise(resolve => { release = resolve; }); return { loopId: "loop-one", status: "cancelled" }; }, async listChildSessions() { return children; } };
  const stopping = manager.handleMessage(main.managed, stopMessage);
  await new Promise(resolve => setImmediate(resolve));
  await manager.handleMessage(main.managed, stopMessage);
  assert.equal(stops, 1, "duplicate clicks share the pending stop");
  release(); await stopping;
  assert.equal(main.posted.at(-1).type, "task.stop.result");
  client = { async stopTask() { throw new Error("fixture cancellation failed"); } };
  await manager.handleMessage(main.managed, stopMessage);
  assert.match(main.posted.at(-1).error, /fixture cancellation failed/);
  for (const role of ["work", "verification"]) await manager.handleMessage(panel(role).managed, stopMessage);

  // A runtime client without the command, or a failed command, reports the error and decides nothing.
  client = { async listChildSessions() { return children; } };
  const older = panel("main");
  await manager.handleMessage(older.managed, message("continue"));
  assert.equal(older.posted.length, 1);
  assert.deepEqual([older.posted[0].type, older.posted[0].level], ["host.notice", "error"]);
  assert.match(older.posted[0].text, /unavailable in this runtime/);
  client = { async decideRevisionLimit() { throw new Error("Loop is not stopped on its revision limit"); }, async listChildSessions() { return children; } };
  const failed = panel("main");
  await manager.handleMessage(failed.managed, message("stop"));
  assert.deepEqual([failed.posted[0].level, failed.posted[0].text], ["error", "Error: Loop is not stopped on its revision limit"]);
});


test("task stop validates exclusive bindings and cancels only owned direct runs", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const target = { workflowId: "flow", taskId: "task-one", agentId: "work-one", runId: "run-one" };
  assert.deepEqual(parseClientMessage({ type: "task.stop", ...target }), { type: "task.stop", ...target });
  for (const override of [{ runId: undefined }, { taskId: "../bad" }, { loopId: "loop-one" }, { workAgentId: "work-one" }]) {
    assert.equal(parseClientMessage({ type: "task.stop", ...target, ...override }), undefined);
  }
  const client = new AgentFactoryClient("/unused/exec.py", "/unused");
  const children = ["one", "two"].map(id => ({ agentId: "work-" + id, runId: "run-" + id, status: "running", role: "work",
    taskBinding: { workflowId: "flow", taskId: "task-" + id } }));
  client.listChildSessions = async () => children;
  client.refreshWorkflows = async () => [];
  const calls = [];
  client.cancel = async (...args) => calls.push(args);
  await client.stopTask("main-owner", target);
  assert.deepEqual(calls, [["work-one", "run-one"]]);
  for (const override of [{ runId: "other" }, { taskId: "task-two" }, { workflowId: "other" }]) {
    await assert.rejects(client.stopTask("main-owner", { ...target, ...override }), /does not belong/);
  }
  client.refreshWorkflows = async () => [{ workflow: { id: "flow" }, loopId: "loop-one" }];
  await assert.rejects(client.stopTask("main-owner", target), /exact Loop binding/);
  assert.equal(calls.length, 1);
});

test("task stop binds the Loop to this Main and refuses multi-task scope", async t => {
  const fixture = await stoppedLoop(t);
  fixture.client.listChildSessions = async () => fixture.children;
  const target = { workflowId: "flow", taskId: "task-one", workAgentId: "work-one", loopId: "loop-one" };
  const stopped = await fixture.client.stopTask("main-owner", target);
  assert.equal(stopped.status, "cancelled");
  const calls = await fixture.recorded();
  assert.equal(calls.at(-1).argv[0], "stop-task");
  assert.equal(calls.at(-1).argv[calls.at(-1).argv.indexOf("--task-id") + 1], "task-one");
  assert.equal(calls.at(-1).parent, fixture.parent);
  await assert.rejects(fixture.client.stopTask("other-main", target), /does not belong/);
  fixture.client.refreshWorkflows = async () => [{ ...target, workflow: { id: "flow", tasks: [{ id: "task-one" }, { id: "other" }] } }];
  await assert.rejects(fixture.client.stopTask("main-owner", target), /multi-task/);
  assert.equal((await fixture.recorded()).filter(call => call.argv[0] === "stop-task").length, 1);
});


test("workflow stage identity uses only its own captured run, including historical stages", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused", "/fixture");
  const calls = [];
  client.latestRunInfo = async (agent, run) => {
    calls.push([agent, run]);
    return run === "run-old" ? { model: "captured-old", workProfile: "workLight" }
      : run === "verify-old" ? { model: "captured-verifier" } : { status: "unknown" };
  };
  const snapshot = { workAgentId: "worker", verificationAgentId: "verifier", workflow: { tasks: [
    { workRunId: "run-old", verificationRunId: "verify-old" }, {}, { workRunId: "run-missing" }
  ] } };
  await client.presentWorkflow(snapshot, {}, "main", "parent");
  assert.deepEqual(calls, [["worker", "run-old"], ["worker", "run-missing"], ["verifier", "verify-old"]]);
  assert.deepEqual(snapshot.workflow.tasks, [
    { workRunId: "run-old", verificationRunId: "verify-old", workModel: "captured-old", verificationModel: "captured-verifier", workProfile: "workLight" },
    {}, { workRunId: "run-missing" }
  ]);
});
