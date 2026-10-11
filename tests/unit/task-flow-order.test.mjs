import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readChatSource, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";

const script = await readChatSource();
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end));
const source = between("  function recordedWorkProfile(", "  function createSingleTaskFlowCard(")
  + between("  function extractTaskFlows(", "  function liveTaskStatus(");

function panel(state, announced = []) {
  const context = { state: { taskFlows: [], childAgents: [], workflows: [], ...state }, taskFlowSnapshot: undefined,
    indexedTimeline: () => ({ flows: new Map(announced.map(flow => [flow.id, flow])), flowRevision: 0 }),
    acceptedTaskAgent: agent => Boolean(agent.runId), t: key => key };
  runInNewContext(source, context);
  return {
    context,
    flows: () => JSON.parse(JSON.stringify(runInNewContext("taskFlowSnapshot = undefined; currentTaskFlows()", context))),
    ids() { return this.flows().map(flow => flow.id); }
  };
}

const brief = (name, dispatchedAt, extra = {}) => ({ agentId: "work-" + name, runId: "run-" + name, role: "work", status: "running",
  updatedAt: dispatchedAt, ...(dispatchedAt ? { dispatchedAt } : {}), ...extra,
  taskBinding: { workflowId: "brief-" + name, workflowTitle: "Brief " + name, taskId: "task-" + name, title: "Brief " + name, description: "Do " + name } });
const loop = (name, extra = {}) => ({ kind: "work-verification-loop", loopId: "loop-" + name, workAgentId: "work-" + name, taskMode: "work", status: "active", ...extra,
  workflow: { id: "brief-" + name, title: "Brief " + name, index: 0, tasks: [
    { id: "task-" + name, title: "Brief " + name, description: "Do " + name, workRunId: "run-" + name, workStatus: "running", verificationStatus: "pending" }] } });
// The host sorts child sessions by `updatedAt`, newest first; that list is what the webview receives.
const hostOrder = agents => agents.slice().sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));

test("task cards keep their dispatch order while runs update", () => {
  const agents = [brief("b", "2026-10-03T10:00:02Z"), brief("a", "2026-10-03T10:00:01Z"), brief("c", "2026-10-03T10:00:03Z")];
  const view = panel({ childAgents: hostOrder(agents) });
  const expected = ["brief-a", "brief-b", "brief-c"];
  assert.deepEqual(view.ids(), expected, "oldest dispatch first");
  // Every permutation of activity: whichever run reported last, the cards do not move.
  const stamps = ["2026-10-03T11:00:00Z", "2026-10-03T11:00:01Z", "2026-10-03T11:00:02Z"];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const updated = agents.map((agent, index) => ({ ...agent, updatedAt: stamps[order[index]], status: index === order[0] ? "completed" : "running" }));
    view.context.state.childAgents = hostOrder(updated);
    assert.deepEqual(view.ids(), expected, "updatedAt order " + order.join(""));
  }
  // The pre-change behavior followed the host order; without dispatch times that is all the panel has.
  const untimed = panel({ childAgents: hostOrder(agents.map(({ dispatchedAt, ...agent }) => agent)) });
  assert.deepEqual(untimed.ids(), ["brief-a", "brief-b", "brief-c"]);
  assert.equal(untimed.flows().some(flow => "dispatchedAt" in flow), false, "no time is invented");
});

test("a loop's start time orders its card across revisions and equal times break by identifier", () => {
  const first = { ...brief("x", "2026-10-03T10:00:05Z"), updatedAt: "2026-10-03T10:00:05Z" };
  const second = brief("y", "2026-10-03T10:00:06Z");
  const workflows = [loop("x", { dispatchedAt: "2026-10-03T10:00:04Z" }), loop("y", { dispatchedAt: "2026-10-03T10:00:06Z" })];
  const view = panel({ childAgents: hostOrder([first, second]), workflows });
  assert.deepEqual(view.ids(), ["brief-x", "brief-y"]);
  // A revision gives the first loop a newer run: its latest acceptance is now after the second card's dispatch.
  const revised = { ...first, runId: "run-x-revision", dispatchedAt: "2026-10-03T10:30:00Z", updatedAt: "2026-10-03T10:30:00Z" };
  view.context.state.childAgents = hostOrder([revised, second]);
  assert.deepEqual(view.ids(), ["brief-x", "brief-y"], "the loop start, not the latest run, places the card");
  assert.equal(view.flows()[0].dispatchedAt, "2026-10-03T10:00:04Z");
  // Without the loop snapshot the same revision would move the card: the run time is only the fallback.
  view.context.state.workflows = [];
  assert.deepEqual(view.ids(), ["brief-y", "brief-x"]);

  const same = "2026-10-03T10:00:00Z";
  for (const agents of [[brief("m", same), brief("k", same), brief("z", same)], [brief("z", same), brief("m", same), brief("k", same)]]) {
    assert.deepEqual(panel({ childAgents: agents }).ids(), ["brief-k", "brief-m", "brief-z"], "stable tie-break");
  }
  // Malformed times are ignored instead of being compared as text.
  assert.equal("dispatchedAt" in panel({ childAgents: [brief("bad", "yesterday")] }).flows()[0], false);
});

test("announced task lists keep their announced order ahead of dispatched cards", () => {
  const task = (id, extra = {}) => ({ id, title: "Task " + id, status: "pending", ...extra });
  const announced = [{ id: "plan-late", title: "Plan late", tasks: [task("l1")] }, { id: "plan-early", title: "Plan early", tasks: [task("e1")] }];
  // The announced lists run through loops that started in the opposite order, beside two briefs.
  const engine = (id, taskId, dispatchedAt) => ({ kind: "work-verification-loop", loopId: "loop-" + id, workAgentId: "work-" + id, taskMode: "work", status: "active", dispatchedAt,
    workflow: { id, title: "Plan", index: 0, tasks: [{ id: taskId, title: "Task " + taskId, workRunId: "run-" + id, workStatus: "running", verificationStatus: "pending" }] } });
  const view = panel({
    childAgents: hostOrder([brief("n", "2026-10-03T09:00:02Z"), brief("o", "2026-10-03T09:00:01Z")]),
    workflows: [engine("plan-late", "l1", "2026-10-03T08:00:09Z"), engine("plan-early", "e1", "2026-10-03T08:00:01Z")]
  }, announced);
  assert.deepEqual(view.ids(), ["plan-late", "plan-early", "brief-o", "brief-n"]);
  assert.equal(view.flows().slice(0, 2).some(flow => "dispatchedAt" in flow), false, "announced flows are not re-ordered by time");
  // The engine snapshot still replaces the announced flow's tasks in place.
  assert.equal(view.flows()[0].engine, true);
});

test("a restored panel orders saved cards the same way without live agents", () => {
  const live = panel({ childAgents: hostOrder([brief("q", "2026-10-03T10:00:02Z"), brief("p", "2026-10-03T10:00:01Z")]) });
  const saved = live.flows();
  assert.deepEqual(saved.map(flow => flow.dispatchedAt), ["2026-10-03T10:00:01Z", "2026-10-03T10:00:02Z"]);
  for (const taskFlows of [saved, saved.slice().reverse()]) {
    assert.deepEqual(panel({ taskFlows }).ids(), ["brief-p", "brief-q"]);
  }
  // Cards saved before dispatch times existed stay where they were saved.
  const legacy = saved.slice().reverse().map(({ dispatchedAt, ...flow }) => flow);
  assert.deepEqual(panel({ taskFlows: legacy }).ids(), ["brief-q", "brief-p"]);
});

test("a revision-limit pause reaches the flow only as the runtime's structured stop", () => {
  const pause = { code: "revision_limit_reached", revisionCount: 3, maxRevisions: 3, pendingFindingIds: ["finding-1", "finding-2"],
    findings: [{ id: "finding-1", path: "src/a.ts", problem: "Wrong label" }] };
  const stopped = extra => loop("s", { taskMode: "work-verification", verificationAgentId: "verify-s", status: "needs-human-decision", pause, ...extra });
  const flow = panel({ workflows: [stopped()] }).flows()[0];
  assert.deepEqual(flow.pause, { taskId: "task-s", revisionCount: 3, maxRevisions: 3, findings: [
    { id: "finding-1", path: "src/a.ts", problem: "Wrong label" }, { id: "finding-2", path: "", problem: "" }] });
  assert.deepEqual([flow.loopId, flow.workAgentId], ["loop-s", "work-s"]);
  // No structured pause (older runtime, or the host withheld it without the capability): today's text message only.
  for (const snapshot of [stopped({ pause: undefined }), stopped({ pause: null }), stopped({ pause: { ...pause, code: "other" } }),
    stopped({ status: "active" }), stopped({ status: "cancelled" }), stopped({ loopId: "../loop" })]) {
    assert.equal("pause" in panel({ workflows: [snapshot] }).flows()[0], false);
  }
  // A loop persisted without counters still shows its identifiers.
  const sparse = panel({ workflows: [stopped({ pause: { code: "revision_limit_reached", pendingFindingIds: ["finding-9"] } })] }).flows()[0].pause;
  assert.deepEqual(sparse.findings, [{ id: "finding-9", path: "", problem: "" }]);
  assert.equal("revisionCount" in sparse, false);
});

test("the decision view offers exactly continue and stop and both sides add the same three revisions", async () => {
  const view = between("  function createRevisionLimitDecision(", "  function releaseWorkflowDecisions(");
  assert.deepEqual([...view.matchAll(/for \(const decision of (\[[^\]]+\])\)/g)].map(match => JSON.parse(match[1])), [["continue", "stop"]]);
  assert.match(view, /type: "workflow\.decision", workAgentId: flow\.workAgentId, loopId: flow\.loopId, decision \}/);
  assert.doesNotMatch(view, /skip|finish/i, "accepting a failed Verification stays an explicit runtime command");
  assert.match(script, /const decision = live && flow\.pause && state\.role === "main";/, "only a live Main panel offers the decision");
  const client = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
  assert.equal(script.match(/const REVISION_LIMIT_EXTENSION = (\d+);/)[1], "3");
  assert.equal(client.match(/export const REVISION_LIMIT_EXTENSION = (\d+);/)[1], "3");
  const localization = await readFile(new URL("../../static/js/localization.js", import.meta.url), "utf8");
  assert.match(localization, /"flow\.decision\.continue": \{"en":"Continue", "ko":"계속"\}/);
  assert.match(localization, /"flow\.decision\.stop": \{"en":"Stop", "ko":"중지"\}/);
  for (const key of ["title", "revisions", "revisions.used", "findings", "continue.detail", "stop.detail"]) {
    assert.match(localization, new RegExp(`"flow\\.decision\\.${key.replace(".", "\\.")}": \\{"en":"[^"]+", "ko":"[^"]+"\\}`), key);
  }
});
