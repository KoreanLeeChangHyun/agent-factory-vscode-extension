import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importTypeScript } from "../support/import-typescript.mjs";
import { runUiInNewContext as runInNewContext } from "../support/ui-localization.mjs";
import { readChatSource } from "../support/chat-source.mjs";

test("the light Work profile is accepted and explained to Main only when configured", async () => {
  const { parseAgentModels } = await importTypeScript("src/common/types/agent-models.ts");
  const { delegatedModelGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  const models = { work: { model: "gpt-5.6-sol", reasoningEffort: "high", fast: false }, workLight: { model: "gpt-5.6-luna", reasoningEffort: "low", fast: true } };
  assert.deepEqual(parseAgentModels(models), models);
  assert.equal(parseAgentModels({ planner: {} }), undefined);
  const guidance = delegatedModelGuidance(models);
  assert.match(guidance, /workLight/);
  assert.match(guidance, /never pass a profile name such as light or heavy as a model/);
  assert.match(guidance, /--work-fast \(or --no-work-fast\)/);
  assert.match(guidance, /Fast is the Codex service tier and is independent from reasoning effort/);
  assert.doesNotMatch(delegatedModelGuidance({ work: models.work }), /Work profiles/);
});

test("orchestrator mode sends the brief guidance, not the contract workflow", async () => {
  const { orchestratorGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  assert.match(orchestratorGuidance, /Goal .*Scope .*Done .*Report/s);
  assert.match(orchestratorGuidance, /Do not write a task-list JSON, run announce-tasks/);
  assert.doesNotMatch(orchestratorGuidance, /taskFlow|requestHash|contract object/);
});

test("guidance names --work-profile only for a runtime that advertises it", async () => {
  const { delegatedModelGuidance, orchestratorGuidance, orchestratorModeGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  const models = { work: { model: "gpt-5.6-sol", reasoningEffort: "high" }, workLight: { model: "gpt-5.6-luna", reasoningEffort: "low" } };
  assert.equal(orchestratorModeGuidance(false), orchestratorGuidance);
  assert.doesNotMatch(orchestratorModeGuidance(false), /--work-profile/);
  assert.doesNotMatch(delegatedModelGuidance(models), /--work-profile/);
  assert.doesNotMatch(delegatedModelGuidance(models, false), /--work-profile/);
  const orchestrator = orchestratorModeGuidance(true);
  assert.match(orchestrator, /--work-profile work or --work-profile workLight matching the profile you chose/);
  assert.match(orchestrator, /--work-profile work on the one retry after a failed workLight attempt/);
  assert.match(orchestrator, /selects no model/);
  // The agreed brief route is unchanged around the added sentence.
  assert.equal(orchestrator.replace(/ Also pass --work-profile[^.]*\./, ""), orchestratorGuidance);
  const delegated = delegatedModelGuidance(models, true);
  assert.match(delegated, /--work-profile work or --work-profile workLight on the same loop\.py start, and --work-profile work on that retry/);
  // Without the light profile there is no profile choice to record in this block.
  assert.doesNotMatch(delegatedModelGuidance({ work: models.work }, true), /--work-profile/);
});

test("guidance names the per-class failure actions only for a runtime that reports failureClass", async () => {
  // Human decision 2026-10-03: guidance only; the runtime still never re-dispatches Work.
  const { orchestratorGuidance, orchestratorModeGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const older of [orchestratorGuidance, orchestratorModeGuidance(false), orchestratorModeGuidance(true), orchestratorModeGuidance(true, false)]) {
    assert.doesNotMatch(older, /failureClass/);
  }
  const guided = orchestratorModeGuidance(false, true);
  for (const action of [
    /contract - the runtime's automatic receipt recovery already ran, so report a run that still ended failed/,
    /transient - run loop\.py reconcile, read the status once more, then decide/,
    /environment - stop and report the cause to the Human/,
    /human - pass the decision to the Human/,
    /provider - report the provider's message and do not dispatch again unless the Human asks/,
    /The one retry of a failed workLight attempt with the work profile applies only when its failureClass is contract or absent/
  ]) assert.match(guided, action);
  // The agreed brief route is unchanged around the added sentences, with or without the profile flag.
  const added = / A stopped loop reports failureClass;.*contract or absent\./;
  assert.equal(guided.replace(added, ""), orchestratorGuidance);
  assert.equal(orchestratorModeGuidance(true, true).replace(added, ""), orchestratorModeGuidance(true));
});

test("the dispatch asks the runtime before telling Main to pass --work-profile", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const events = { onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {}, onError() {} };
  const models = { work: { model: "gpt-5.6-sol" }, workLight: { model: "gpt-5.6-sol" } };
  const dispatch = async (capabilities, execution) => {
    const sent = [], probes = [];
    const controller = new ChatSessionController({
      async activeRun() {},
      async send(agentId, text) { sent.push(text); return { agentId, runId: "run-one" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status: "completed" }; },
      async result() { return { status: "completed", text: "done" }; },
      ...(capabilities ? { async capabilities(...args) { probes.push(args); return capabilities(); } } : {})
    }, events, "main-existing", { pollIntervalMs: 0 });
    await controller.send("request", [], execution);
    assert.equal(sent.length, 1, "the request is dispatched whatever the probe reports");
    return { text: sent[0], probes };
  };
  const supported = () => ({ submit: { workProfile: true }, send: { workProfile: true } });
  const orchestrate = { taskMode: "orchestrate", model: "main-model", agentModels: models };

  const advertised = await dispatch(supported, orchestrate);
  assert.match(advertised.text, /\[Orchestrator mode\][\s\S]*--work-profile work or --work-profile workLight matching the profile you chose/);
  assert.match(advertised.text, /\[Delegated agent model settings[\s\S]*--work-profile work on that retry/);
  assert.deepEqual(advertised.probes, [["main-existing", "main-model"]]);

  // An older runtime, a failed probe and a client without the probe never receive the unknown flag.
  for (const capabilities of [
    () => ({ submit: {}, send: {} }),
    () => ({ submit: { workProfile: "yes" }, send: {} }),
    () => { throw new Error("capabilities unavailable"); },
    undefined
  ]) {
    const older = await dispatch(capabilities, orchestrate);
    assert.match(older.text, /\[Orchestrator mode\]/);
    assert.doesNotMatch(older.text, /--work-profile/);
  }

  // The per-class failure actions follow their own advertised capability, independent of the profile flag.
  assert.doesNotMatch(advertised.text, /failureClass/);
  const classified = await dispatch(() => ({ submit: { failureClass: true }, send: { failureClass: true } }), orchestrate);
  assert.match(classified.text, /\[Orchestrator mode\][\s\S]*transient - run loop\.py reconcile, read the status once more, then decide/);
  assert.doesNotMatch(classified.text, /--work-profile/);
  const both = await dispatch(() => ({ submit: { workProfile: true, failureClass: true }, send: {} }), orchestrate);
  assert.match(both.text, /--work-profile work or --work-profile workLight matching the profile you chose/);
  assert.match(both.text, /failureClass is contract or absent/);
  assert.doesNotMatch(both.text, /--workspace-file/);
  // Work isolation off (the default) keeps the shared checkout even on a runtime that supports Work Units.
  const isolating = () => ({ submit: { taskWorkspaces: true, workIsolation: true }, send: {} });
  assert.doesNotMatch((await dispatch(isolating, orchestrate)).text, /--workspace-file|Work isolation/);
  assert.doesNotMatch((await dispatch(isolating, { ...orchestrate, workIsolation: false })).text, /--workspace-file|Work isolation/);
  const isolated = await dispatch(isolating, { ...orchestrate, workIsolation: true });
  assert.match(isolated.text, /Work isolation ON[\s\S]*every brief or task pass loop\.py start --workspace-file/);
  assert.match(isolated.text, /research, questions and other read-only Work: \{"mode":"read-only"\}/);
  assert.match(isolated.text, /Shared mode is unavailable while isolation is on/);
  assert.match(isolated.text, /nested repositories[\s\S]*one task per repository/);
  assert.match(isolated.text, /current branch/);
  assert.match(isolated.text, /Conflicts never wait for the Human[\s\S]*integration_preserved/);
  assert.match(isolated.text, /Do not retrofit any accepted loop or run/);
  assert.match((await dispatch(() => ({ submit: { taskWorkspaces: true }, send: {} }), { ...orchestrate, workIsolation: true })).text, /does not support it[\s\S]*report this limitation/);
  assert.doesNotMatch((await dispatch(isolating, { taskMode: "direct", workIsolation: true })).text, /--workspace-file|Work isolation/);
  for (const capabilities of [() => ({ submit: { failureClass: "yes" }, send: {} }), () => { throw new Error("capabilities unavailable"); }, undefined]) {
    assert.doesNotMatch((await dispatch(capabilities, orchestrate)).text, /failureClass/);
  }
  assert.doesNotMatch((await dispatch(() => ({ submit: { failureClass: true }, send: {} }), { taskMode: "work", agentModels: models })).text, /failureClass/);

  // Human-selected workflows carry it through the delegated model settings.
  const workflow = await dispatch(supported, { taskMode: "work", agentModels: models });
  assert.match(workflow.text, /--work-profile work or --work-profile workLight on the same loop\.py start/);
  assert.doesNotMatch(workflow.text, /\[Orchestrator mode\]/);

  // Direct mode delegates nothing and does not probe.
  const direct = await dispatch(supported, { taskMode: "direct", agentModels: models });
  assert.doesNotMatch(direct.text, /--work-profile/);
  assert.deepEqual(direct.probes, []);
});

test("the client reports the advertised capability and each run's recorded profile", async t => {
  const home = await mkdtemp(join(tmpdir(), "af-work-profile-home-"));
  const root = await mkdtemp(join(tmpdir(), "af-work-profile-"));
  const previousHome = process.env.AGENT_FACTORY_HOME;
  process.env.AGENT_FACTORY_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.AGENT_FACTORY_HOME; else process.env.AGENT_FACTORY_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const { parseWorkProfile } = await importTypeScript("src/common/types/agent-models.ts");
  assert.deepEqual(["work", "workLight", "light", "", undefined, true].map(parseWorkProfile), ["work", "workLight", undefined, undefined, undefined, undefined]);

  const flags = { model: true, reasoning: true, fast: false, goal: true };
  const capable = new AgentFactoryClient("/unused/exec.py", root);
  capable.command = async () => ({ kind: "execution-capabilities", schemaVersion: "0.1.0",
    submit: { ...flags, workProfile: true, failureClass: true }, send: { ...flags, workProfile: true, failureClass: true } });
  assert.equal((await capable.capabilities()).submit.workProfile, true);
  assert.equal((await capable.capabilities()).submit.failureClass, true);
  const older = new AgentFactoryClient("/unused/older-exec.py", root);
  older.command = async () => ({ kind: "execution-capabilities", schemaVersion: "0.1.0", submit: flags, send: flags });
  assert.equal((await older.capabilities()).submit.workProfile, undefined);
  assert.equal((await older.capabilities()).submit.failureClass, undefined);

  const agents = join(home, "projects", "project-" + createHash("sha256").update(root).digest("hex").slice(0, 32), "agents");
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const events = join(agents, "main-parent/runs/run-current/events.jsonl");
  await mkdir(dirname(events), { recursive: true });
  const state = join(agents, "work-hidden/runs/run-child/state.json");
  await mkdir(dirname(state), { recursive: true });
  const settings = { model: "gpt-same", reasoningEffort: "high" };
  await writeFile(events, JSON.stringify({ type: "item.completed", item: { type: "command_execution",
    command: `python3 skills/agent/scripts/exec.py result --project-root '${root}' --agent work-hidden --run-id run-child` } }));
  const child = async document => {
    await writeFile(state, JSON.stringify({ status: "running", executionOptions: settings, ...document }));
    const sessions = await client.listChildSessions("main-parent", "run-current");
    assert.equal(sessions.length, 1);
    assert.deepEqual([sessions[0].agentId, sessions[0].runId, sessions[0].model, sessions[0].reasoningEffort], ["work-hidden", "run-child", "gpt-same", "high"]);
    return sessions[0];
  };
  assert.equal((await child({ workProfile: "workLight", padding: 1 })).workProfile, "workLight");
  assert.equal((await child({ workProfile: "work", padding: 22 })).workProfile, "work");
  // Older runs and malformed values stay unrecorded so the panel never invents an assignment.
  assert.equal("workProfile" in await child({ padding: 333 }), false);
  assert.equal("workProfile" in await child({ workProfile: "light", padding: 4444 }), false);
  // Step counts and the activity line come only from the run's own record and must be consistent.
  const progressed = await child({ planProgress: { completed: 2, total: 7 }, activity: "  Editing the panel  ", padding: 55555 });
  assert.deepEqual(progressed.planProgress, { completed: 2, total: 7 });
  assert.equal(progressed.activity, "Editing the panel");
  for (const [planProgress, padding] of [[{ completed: 8, total: 7 }, 6], [{ completed: 1, total: 0 }, 77], [{ completed: "2", total: 7 }, 888]]) {
    assert.equal("planProgress" in await child({ planProgress, padding }), false);
  }
});

test("the task panel shows the recorded profile and never infers one for unrecorded runs", async () => {
  const script = await readChatSource();
  const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end));
  const source = between("  function recordedWorkProfile(", "  function createSingleTaskFlowCard(")
    + between("  function extractTaskFlows(", "  function liveTaskStatus(");
  const same = { model: "gpt-same", reasoningEffort: "high" };
  const panel = (agentModels, childAgents, workflows = []) => {
    const context = { state: { agentModels, childAgents, workflows, taskFlows: [] }, taskFlowSnapshot: undefined,
      indexedTimeline: () => ({ flows: new Map(), flowRevision: 0 }), acceptedTaskAgent: () => true };
    runInNewContext(source, context);
    return { profile: task => runInNewContext("workProfileForTask(task)", { ...context, task }),
      flows: () => JSON.parse(JSON.stringify(runInNewContext("currentTaskFlows()", context))) };
  };
  const agent = extra => ({ agentId: "work-one", runId: "run-one", role: "work", status: "running", ...same, ...extra });
  const task = { agentId: "work-one", runId: "run-one" };
  const identical = { work: same, workLight: same };

  // Identical settings cannot tell the profiles apart; the record decides.
  assert.equal(panel(identical, [agent({ workProfile: "workLight" })]).profile(task), "workLight");
  assert.equal(panel(identical, [agent({ workProfile: "work" })]).profile(task), "work");
  // The record also holds after settings change to point the other way.
  const distinct = { work: { model: "gpt-expert", reasoningEffort: "high" }, workLight: same };
  assert.equal(panel(distinct, [agent({ workProfile: "work" })]).profile(task), "work");
  assert.equal(panel({ work: same, workLight: { model: "gpt-worker" } }, [agent({ workProfile: "workLight" })]).profile(task), "workLight");

  // No record (Human decision 2026-10-03): nothing is inferred, whatever the model settings match.
  assert.equal(panel(identical, [agent({})]).profile(task), undefined);
  assert.equal(panel(distinct, [agent({})]).profile(task), undefined, "settings that match only workLight are not a record");
  assert.equal(panel({ work: same, workLight: { model: "gpt-worker" } }, [agent({})]).profile(task), undefined, "nor settings that match only work");
  assert.equal(panel(distinct, [agent({ workProfile: "light" })]).profile(task), undefined, "an unknown value is not a record");
  assert.equal(panel(distinct, []).profile(task), undefined);
  assert.doesNotMatch(source.slice(0, source.indexOf("  function extractTaskFlows(")), /agentModels|reasoningEffort/, "the panel no longer reads model settings");

  // The loop's record reaches its Work stage, not Verification, and applies when the run carries none.
  const loop = extra => ({ kind: "work-verification-loop", loopId: "loop-one", workAgentId: "work-one", verificationAgentId: "verify-one",
    taskMode: "work-verification", status: "active", ...extra, workflow: { id: "flow-one", title: "Flow", tasks: [
      { id: "task-one", title: "Task", description: "Do it", workRunId: "run-one", workStatus: "running", verificationStatus: "pending" }] } });
  const recorded = panel(identical, [], [loop({ workProfile: "workLight" })]);
  const stages = recorded.flows()[0].tasks;
  assert.deepEqual(stages.map(stage => [stage.sessionRole, stage.workProfile]), [["work", "workLight"], ["verification", undefined]]);
  assert.equal(recorded.profile(stages[0]), "workLight");
  const unrecorded = panel(identical, [], [loop({})]);
  assert.equal("workProfile" in unrecorded.flows()[0].tasks[0], false);
  assert.equal(unrecorded.profile(unrecorded.flows()[0].tasks[0]), undefined);
  // A run-level record is carried into the runtime-accepted task as well.
  const bound = panel(identical, [agent({ workProfile: "workLight", taskBinding: { workflowId: "flow-two", workflowTitle: "Flow", taskId: "task-two", title: "Task", description: "Do it" } })]);
  assert.equal(bound.flows()[0].tasks[0].workProfile, "workLight");
  assert.equal(bound.profile(bound.flows()[0].tasks[0]), "workLight");
});

test("the Work isolation flag reaches only a runtime that advertises it", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const events = { onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {}, onError() {} };
  const dispatch = async (capabilities, execution) => {
    const sent = [];
    const controller = new ChatSessionController({
      async activeRun() {},
      async send(agentId, text, options) { sent.push(options); return { agentId, runId: "run-one" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status: "completed" }; },
      async result() { return { status: "completed", text: "done" }; },
      async capabilities() { return capabilities; }
    }, events, "main-existing", { pollIntervalMs: 0 });
    await controller.send("request", [], execution);
    return sent[0];
  };
  const orchestrate = { taskMode: "orchestrate", model: "main-model" };
  assert.equal((await dispatch({ submit: { workIsolation: true }, send: {} }, { ...orchestrate, workIsolation: true })).workIsolation, true);
  assert.equal((await dispatch({ submit: { workIsolation: true }, send: {} }, { ...orchestrate, workIsolation: false })).workIsolation, false);
  assert.equal("workIsolation" in (await dispatch({ submit: {}, send: {} }, { ...orchestrate, workIsolation: true })), false);
  assert.equal("workIsolation" in (await dispatch({ submit: { workIsolation: true }, send: {} }, orchestrate)), false);
});

test("the Work isolation toggle maps to the runtime flag and validates on the protocol", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "workIsolation.set", value: true }), { type: "workIsolation.set", value: true });
  assert.equal(parseClientMessage({ type: "workIsolation.set", value: "on" }), undefined);
  const send = { type: "chat.send", id: "message-one", text: "hello", attachments: [], execution: { fast: false, goal: false } };
  assert.equal(parseClientMessage({ ...send, execution: { ...send.execution, workIsolation: true } }).execution.workIsolation, true);
  assert.equal("workIsolation" in parseClientMessage(send).execution, false);
  assert.equal(parseClientMessage({ ...send, execution: { ...send.execution, workIsolation: "yes" } }), undefined);
  const source = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /--work-isolation", execution\.workIsolation \? "on" : "off"/);
});
