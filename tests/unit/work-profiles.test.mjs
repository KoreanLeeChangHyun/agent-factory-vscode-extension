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
  assert.deepEqual(["work", "workLight", "explore", "scribe", "light", "", undefined, true].map(parseWorkProfile),
    ["work", "workLight", "explore", "scribe", undefined, undefined, undefined, undefined]);

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
  assert.equal((await child({ workProfile: "scribe", padding: 2222 })).workProfile, "scribe");
  // Older runs and malformed values stay unrecorded so the panel never invents an assignment.
  assert.equal("workProfile" in await child({ padding: 333 }), false);
  assert.equal("workProfile" in await child({ workProfile: "light", padding: 4444 }), false);
  // Step counts and the activity line come only from the run's own record and must be consistent.
  const progressed = await child({ planProgress: { completed: 2, total: 7 }, activity: "  Editing the panel  ", padding: 55555 });
  assert.deepEqual(progressed.planProgress, { completed: 2, total: 7 });
  assert.equal(progressed.activity, "Editing the panel");
  const times = { startedAt: "2026-10-05T10:00:00Z", finishedAt: "2026-10-05T10:05:32Z" };
  const timed = await child({ ...times, status: "completed" });
  assert.equal(timed.startedAt, times.startedAt);
  assert.equal(timed.finishedAt, times.finishedAt);
  const old = await child({ acceptedAt: times.startedAt, updatedAt: times.finishedAt });
  assert.equal(old.startedAt, undefined, "dispatch time is not execution start");
  assert.equal(old.finishedAt, undefined, "update time is not execution finish");
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
  assert.equal(panel(identical, [agent({ workProfile: "explore" })]).profile(task), "explore");
  assert.equal(panel(identical, [agent({ workProfile: "scribe" })]).profile(task), "scribe");
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

test("Explorer and Scribe are offered to Main only by a runtime that enforces them", async () => {
  // Human decision 2026-10-06: only the orchestrator dispatches agents; Explorer stays read-only, Scribe writes only docs/.
  const { ChatSessionController, orchestratorModeGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  const restricted = orchestratorModeGuidance(true, false, true);
  assert.match(restricted, /--work-profile explore for research, web search and code exploration that change nothing/);
  assert.match(restricted, /--work-profile scribe for changes confined to the project's docs\//);
  assert.match(restricted, /a failed explore run is reported, not retried with write access\. Only you dispatch agents\./);
  // Without the recorded profile flag there is nothing to choose, and the base guidance is unchanged.
  assert.equal(orchestratorModeGuidance(false, false, true), orchestratorModeGuidance(false));
  assert.match(restricted, /record the answer with loop\.py review --actor human --decision accepted\|changes-requested\|discarded/);
  assert.match(restricted, /give scribe the read-only workspace plan \(the shared checkout\), never a code plan/);
  assert.match(restricted, /prepare rule candidates with lessons\.py candidate/);
  assert.equal(restricted.replace(/ Two more profiles keep agents[^\]]*?approval of that draft\./, ""), orchestratorModeGuidance(true));
  const events = { onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {}, onError() {} };
  const dispatch = async capabilities => {
    const sent = [];
    const controller = new ChatSessionController({
      async activeRun() {},
      async send(agentId, text) { sent.push(text); return { agentId, runId: "run-one" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status: "completed" }; },
      async result() { return { status: "completed", text: "done" }; },
      async capabilities() { return capabilities; }
    }, events, "main-existing", { pollIntervalMs: 0 });
    await controller.send("request", [], { taskMode: "orchestrate", model: "main-model" });
    return sent[0];
  };
  assert.match(await dispatch({ submit: { workProfile: true, restrictedWorkProfiles: true }, send: {} }), /--work-profile scribe/);
  for (const submit of [{ workProfile: true }, { restrictedWorkProfiles: true }, { workProfile: true, restrictedWorkProfiles: "yes" }]) {
    assert.doesNotMatch(await dispatch({ submit, send: {} }), /explore|scribe/);
  }
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

test("Explorer and Scribe have their own model settings, falling back to the Worker", async () => {
  // Human request 2026-10-06: dedicated Explorer/Scribe model settings.
  const { parseAgentModels, parseAgentFastModes } = await importTypeScript("src/common/types/agent-models.ts");
  const { AGENT_ROLES, AGENT_ROLE_FALLBACK } = await importTypeScript("src/core/config/agent-settings.ts");
  const { factoryAgentPresets } = await importTypeScript("src/infrastructure/agent-factory/provider-defaults.ts");
  const models = { explore: { model: "claude-haiku-4-5-20251001", reasoningEffort: "low" }, scribe: { model: "claude-sonnet-5-5" } };
  assert.deepEqual(parseAgentModels(models), models);
  assert.deepEqual(parseAgentFastModes({ explore: { "gpt-6-luna": true } }), { explore: { "gpt-6-luna": true } });
  assert.equal(parseAgentModels({ explorer: {} }), undefined);
  assert.ok(AGENT_ROLES.includes("explore") && AGENT_ROLES.includes("scribe"));
  assert.deepEqual([AGENT_ROLE_FALLBACK.explore, AGENT_ROLE_FALLBACK.scribe], ["workLight", "workLight"]);
  for (const preset of factoryAgentPresets()) {
    assert.deepEqual([preset.settings.explore.model, preset.settings.scribe.model], [preset.settings.workLight.model, preset.settings.workLight.model], preset.id);
  }
  const script = await readChatSource();
  const start = script.indexOf("  // Optional Work profiles start from another role's settings");
  const section = script.slice(start, script.indexOf("  function createAgentSettingControl(", start));
  const context = { state: { role: "main", agentModels: { work: { model: "gpt-expert", reasoningEffort: "high" }, workLight: { model: "gpt-worker", reasoningEffort: "low" }, scribe: { reasoningEffort: "medium" } } },
    agentFastMode: () => false, modelRoute: () => "claude" };
  runInNewContext(section, context);
  const delegated = runInNewContext("effectiveDelegatedModels()", context);
  assert.deepEqual([delegated.explore.model, delegated.explore.reasoningEffort], ["gpt-worker", "low"]);
  assert.deepEqual([delegated.scribe.model, delegated.scribe.reasoningEffort], ["gpt-worker", "medium"]);
});

test("the periodic documents check is due only after its interval and validates on the protocol", async () => {
  const { docsAuditDue } = await importTypeScript("src/common/types/docs-audit.ts");
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(docsAuditDue(undefined, Date.now()), false);
  assert.equal(docsAuditDue({ interval: "off", lastRunAt: 0 }, 10 * day), false);
  assert.equal(docsAuditDue({ interval: "daily" }, 10 * day), false, "an interval without a start time never fires");
  assert.equal(docsAuditDue({ interval: "daily", lastRunAt: 0 }, day - 1), false);
  assert.equal(docsAuditDue({ interval: "daily", lastRunAt: 0 }, day), true);
  assert.equal(docsAuditDue({ interval: "weekly", lastRunAt: 0 }, 6 * day), false);
  assert.equal(docsAuditDue({ interval: "hourly", lastRunAt: 0 }, 100 * day), false);
  assert.deepEqual(parseClientMessage({ type: "docsAudit.set", interval: "weekly" }), { type: "docsAudit.set", interval: "weekly" });
  assert.equal(parseClientMessage({ type: "docsAudit.set", interval: "hourly" }), undefined);
  assert.deepEqual(parseClientMessage({ type: "docsAudit.started" }), { type: "docsAudit.started" });
  const script = await readChatSource();
  assert.match(script, /submit\("orchestrate", "normal", false, t\("docs\.audit\.request"\)\)/, "a check always goes through the orchestrator");
});

test("a completed Scribe loop shows its draft review decision in the task status", async () => {
  const script = await readChatSource();
  const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end));
  const context = {};
  runInNewContext(between("  function draftReview(", "  function revisionLimitPause("), context);
  const review = snapshot => runInNewContext("draftReview(snapshot)", { ...context, snapshot });
  assert.deepEqual(JSON.parse(JSON.stringify(review({ status: "completed", draftReview: { status: "pending", paths: ["docs/a.md", 3] } }))),
    { status: "pending", paths: ["docs/a.md"] });
  assert.equal(review({ status: "active", draftReview: { status: "pending", paths: [] } }), undefined);
  assert.equal(review({ status: "completed", draftReview: { status: "merged" } }), undefined);
  assert.equal(review({ status: "completed" }), undefined);
  assert.match(script, /label\.textContent = t\("flow\.review\." \+ review\.status\)/);
});
