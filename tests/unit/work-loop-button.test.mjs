import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runUiInNewContext as runInNewContext } from "../support/ui-localization.mjs";
import test from "node:test";
import { readChatSource } from "../support/chat-source.mjs";

const script = await readChatSource();
const submit = script.slice(script.indexOf("  function submit("), script.indexOf("  function cancelRun("))
  // submit() resolves delegated model settings through these helpers.
  + script.slice(script.indexOf('  function agentSettingRole('), script.indexOf('  function createAgentSettingControl('));
const controls = script.slice(script.indexOf("  function updateSendButton()"), script.indexOf("  function updateRunControls()"));

function harness(overrides = {}, text = "오류 수정") {
  const sent = [];
  const notices = [];
  const context = {
    state: { role: "main", taskMode: "work", attachments: [], timeline: [], capabilities: {}, runtimeAvailable: true, ...overrides },
    taskModeNames: Object.fromEntries(["direct", "work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"].map(value => [value, value])),
    timeline: { scrollTop: 0, scrollHeight: 500 },
    inputFeedback: {}, prompt: { value: text, focus() {} }, nativeGoal: null,
    conversationClearing: false, conversationWorktree: undefined,
    currentCapabilities: () => ({ model: true, reasoning: true, fast: true, goal: true }),
    createId: () => "message-id", renderAll() {}, resizePrompt() {}, persist() {}, saveComposerSettings() {},
    summarizeChildAgents: () => ({ activeUnits: 0, workActive: 0, verificationActive: 0, totalCalled: 0 }),
    appendNotice: (level, text) => notices.push({ level, text }), vscode: { postMessage: message => sent.push(message) },
    workLoopButton: {}, sendButton: {}
  };
  runInNewContext(submit + controls, context);
  return { context, sent, notices, run: code => runInNewContext(code, context) };
}

test("mode submission preserves the draft, actual image reference and selected model", () => {
  const image = { id: "image-one", name: "input.png", kind: "image", uri: "file:///host/input.png", previewUri: "vscode-resource://input.png", mediaType: "image/png", size: 32 };
  const { context, sent, run } = harness({ model: "chosen-model", attachments: [image] });
  run("submit()");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "오류 수정");
  assert.equal(sent[0].execution.taskMode, "direct");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].attachments[0])), { id: "image-one", name: "input.png", kind: "image", uri: "file:///host/input.png", mediaType: "image/png", size: 32 });
  assert.equal(sent[0].execution.model, "chosen-model");
  assert.equal(context.state.pendingRequests[0].text, "오류 수정");
  assert.equal(context.state.pendingRequests[0].attachments[0].previewUri, "vscode-resource://input.png");
  assert.doesNotMatch(context.state.pendingRequests[0].text, /Work → Verification/);
  assert.equal(context.prompt.value, "");
  assert.equal(context.timeline.scrollTop, 500);
  assert.notEqual(context.state.autoScroll, true);
  run("submit()");
  assert.equal(sent.length, 1);
});

test("enabled mode never sends an empty message, even in an existing session", () => {
  const { sent, run } = harness({ agentId: "main-existing" }, "");
  run("submit()");
  assert.equal(sent.length, 0);
});

test("running sessions retain active UI identity and keep submitted drafts outside the transcript", () => {
  const { context, sent, run } = harness({ running: true, runStartedAt: 17, runProgress: "기존 작업", childAgents: [{ agentId: "work-active" }] });
  run("submit()");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "오류 수정");
  assert.equal(sent[0].execution.taskMode, "direct");
  assert.equal(context.state.timeline.length, 0);
  assert.equal(context.state.pendingRequests.length, 1);
  assert.equal(context.state.runStartedAt, 17);
  assert.equal(context.state.runProgress, "기존 작업");
  assert.equal(context.state.childAgents[0].agentId, "work-active");
});

test("sessions without a runtime do not send", () => {
  const { sent, run } = harness({ runtimeAvailable: false });
  run("submit()");
  assert.equal(sent.length, 0);
});

test("sessions without capabilities do not send", () => {
  const { sent, run } = harness({ capabilities: null });
  run("submit()");
  assert.equal(sent.length, 0);
});

test("disabled mode and child sessions preserve the original request", () => {
  for (const state of [{ workLoopMode: false }, { role: "work" }, { role: "verification" }]) {
    const { sent, run } = harness(state);
    run("submit()");
    assert.equal(sent[0].text, "오류 수정");
  }
});

test("mode click opens choices without submitting or granting approval", () => {
  const handler = script.match(/submissionButton\.addEventListener\("click", function \(\) \{([^}]+)\}\);/)[1];
  const calls = [];
  runInNewContext(handler, { openSetting: setting => calls.push(setting) });
  assert.deepEqual(calls, ["submission"]);
});

test("six actions snapshot each queued submission independently", () => {
  const { context, sent, run } = harness({ running: true });
  for (const taskMode of ["work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"]) {
    context.state.taskMode = taskMode;
    context.prompt.value = "동일 요청";
    run(`submit(${JSON.stringify(taskMode)})`);
  }
  context.state.taskMode = "direct";
  assert.deepEqual(sent.map(message => message.execution.taskMode), ["work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"]);
  assert.ok(sent.every(message => message.text === "동일 요청"));
});

test("attachment-only loop requests show attachment names without injected instructions", () => {
  const { context, sent, run } = harness({ attachments: [{ name: "input.txt" }] }, "");
  run("submit()");
  assert.equal(context.state.timeline.length, 0);
  assert.equal(context.state.pendingRequests[0].attachments[0].name, "input.txt");
  assert.equal(sent[0].text, "");
  assert.equal(sent[0].execution.taskMode, "direct");
});

test("action menu sends supported drafts without persisting a selection during execution", () => {
  function element() {
    return { children: [], dataset: {}, handlers: {}, classList: { add() {} },
      setAttribute() {}, append(...children) { this.children.push(...children); },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelector() { return this; }, replaceChildren() { this.children = []; } };
  }
  const names = { verification: "Verification", plan: "Plan", work: "Work", "plan-work": "Plan · Work", "work-verification": "Work · Verification", "plan-work-verification": "Plan · Work · Verification" };
  const menu = element();
  const calls = [];
  const context = {
    state: { taskMode: "work", running: true, runtimeAvailable: true }, taskModeNames: names,
    settingOptions: { task: Object.keys(names), business: [] }, businessModeNames: { interview: "Interview", contract: "Contract" }, menu,
    document: { createElement: element, createElementNS: element },
    currentCapabilities: () => ({ taskModes: ["verification", "work", "work-verification"] }),
    submit(action) { calls.push(action); },
    handleSettingMenuKeydown() {}, updateModeControls() {}, renderStatusBar() {},
    persist() { calls.push("persist"); }, saveComposerSettings() { calls.push("save"); }, closeSettingMenu() {}
  };
  const renderer = script.slice(script.indexOf("  function renderSubmissionMenu("), script.indexOf("  function handleSettingMenuKeydown("));
  const shortcutCatalog = script.slice(script.indexOf("  const submitShortcut ="), script.indexOf("  const legacyShortcuts ="));
  Object.assign(context, { t: key => key, shortcuts: {}, shortcutLabel: String, shortcutAria: String });
  runInNewContext(shortcutCatalog + renderer + '\nrenderSettingMenu("task", menu);', context);
  const actionOptions = () => menu.children.flatMap(group => group.children.filter(item => item.dataset.action));
  const options = actionOptions().filter(item => item.dataset.goal !== "true");
  assert.deepEqual(options.map(item => item.dataset.action), ["direct", "direct", "direct", "direct", "direct", "work", "work-verification", "direct"]);
  assert.deepEqual(options.map(item => item.dataset.workflow), ["planning", "interview", "migration", "lessons", "contract", "normal", "normal", "pipeline"]);
  assert.ok(options.every(item => !item.disabled));
  options.find(item => item.dataset.action === "work").handlers.click();
  assert.equal(context.state.taskMode, "work");
  assert.equal(context.state.running, true);
  assert.deepEqual(calls, ["work"]);
  context.currentCapabilities = () => ({ taskModes: ["direct", "work"] });
  runInNewContext('renderSettingMenu("task", menu);', context);
  assert.equal(actionOptions().find(item => item.dataset.action === "work-verification").disabled, true);

});


test("workflow selections snapshot queued user text independently of task route", () => {
  const { context, sent, run } = harness({ running: true });
  for (const businessMode of ["interview", "planning", "design", "normal"]) {
    context.state.businessMode = businessMode;
    context.prompt.value = "Original request";
    run(`submit("direct", "${businessMode}")`);
  }
  context.state.businessMode = "design";
  assert.deepEqual(sent.map(message => message.execution.businessMode), ["interview", "planning", "design", "normal"]);
  assert.ok(sent.every(message => message.text === "Original request" && message.execution.taskMode === "direct"));
});


test("Verification snapshots inspection selection and suppresses Goal continuation", () => {
  const { context, sent, run } = harness({ taskMode: "verification", goalMode: true });
  context.nativeGoal = { objective: "Old implementation goal" };
  run('submit("verification")');
  context.state.taskMode = "work";
  assert.equal(sent[0].execution.taskMode, "verification");
  assert.equal(sent[0].execution.goal, false);
  assert.equal(sent[0].execution.goalObjective, undefined);
});


test("Goal snapshots the current composer, replaces an existing objective and resets for the next request", () => {
  for (const text of ["New goal", "x".repeat(4000)]) {
    const { context, sent, run } = harness({ goalMode: true }, text);
    context.nativeGoal = { objective: "Stale goal" };
    run('submit("direct", "normal", true)');
    assert.equal(sent[0].execution.goal, true);
    assert.equal(sent[0].execution.goalObjective, text);
    assert.equal(context.state.pendingRequests[0].execution.goalObjective, text);
    context.prompt.value = "Follow-up";
    run("submit()");
    assert.equal(sent[1].execution.goal, false);
    assert.equal(sent[1].execution.goalObjective, undefined);
  }
});

test("blank Goal drafts are preserved with an actionable error even with an existing goal", () => {
  for (const text of ["", "   "]) {
    for (const attachments of [[], [{ id: "image", kind: "image", name: "image.png" }]]) {
      const { context, sent, notices, run } = harness({ goalMode: true, attachments }, text);
      context.nativeGoal = { objective: "Stale goal" };
      run('submit("direct", "normal", true)');
      assert.equal(sent.length, 0);
      assert.equal(context.prompt.value, text);
      assert.equal(context.state.attachments, attachments);
      assert.equal(context.state.goalMode, true);
      assert.equal(context.inputFeedback.hidden, false);
      assert.match(context.inputFeedback.textContent, /goal|target/);
    }
  }
});

test("Goal is excluded for child roles, Verification and unsupported runtimes", () => {
  for (const state of [{ role: "work" }, { role: "verification" }, { taskMode: "verification" }, { unsupported: true }]) {
    const { context, sent, run } = harness({ goalMode: true, ...state });
    if (state.unsupported) context.currentCapabilities = () => ({ goal: false });
    run(state.taskMode === "verification" ? 'submit("verification")' : "submit()");
    assert.equal(sent[0].execution.goal, false);
    assert.equal(sent[0].execution.goalObjective, undefined);
  }
});

test("ordinary submission ignores stale Goal selection and native Goal updates", () => {
  const { context, sent, run } = harness({ goalMode: true });
  run('submit()');
  assert.equal(sent[0].execution.goal, false);
  context.message = { goal: { objective: "Current goal" } };
  context.renderGoal = () => {};
  context.updateModeControls = () => {};
  run(script.slice(script.indexOf('      case "goal.updated":') + '      case "goal.updated":'.length, script.indexOf('      case "capabilities.updated":')).replace(/break;\s*$/, ""));
  context.prompt.value = "Follow-up";
  run('submit()');
  assert.equal(sent[1].execution.goal, false);
});

test("host derives the objective from chat text and rejects blank goals before dispatch", async () => {
  const { transform } = await import("esbuild");
  const hostSource = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  const method = hostSource.slice(hostSource.indexOf("  private async sendChat("), hostSource.indexOf("  private async mutateImages("));
  const { code } = await transform(method.replace("private async sendChat(", "async function sendChat("), { loader: "ts" });
  const sendChat = runInNewContext(code + "\nsendChat;", { taskExecution: () => ({}) });
  const calls = [];
  let isolation = false;
  const host = { context: {}, async ensureController() {}, async post() {}, workIsolation: () => isolation };
  const managed = {
    state: { role: "main", panelId: "panel" },
    controller: { async send(text, attachments, execution, onStarted) { calls.push(execution); onStarted(); } }
  };
  const send = (text, execution) => sendChat.call(host, managed, text, [], execution, "id", "workspace-write", false);
  await send(" Current composer goal ", { goal: true, goalObjective: "Stale hidden objective" });
  assert.equal(calls[0].goalObjective, "Current composer goal");
  // Main carries the project's Work isolation toggle: the message's value, else the stored one.
  assert.equal(calls[0].workIsolation, false);
  await assert.rejects(send("", { goal: true, goalObjective: "Stale hidden objective" }), /goal|목표/i);
  assert.equal(calls.length, 1);
  await send("x".repeat(4001), { goal: true, goalObjective: "Stale hidden objective" });
  assert.equal(calls[1].goalObjective.length, 4001);
  await send("Inspect", { goal: true, taskMode: "verification", goalObjective: "Stale" });
  assert.equal(calls[2].goalMode, false);
  assert.equal(calls[2].goalObjective, undefined);
  managed.state.role = "work";
  await send("Child message", { goal: true, goalObjective: "Stale" });
  assert.equal(calls[3].goalMode, false);
  assert.equal(calls[3].goalObjective, undefined);
  assert.equal("workIsolation" in calls[3], false);
  managed.state.role = "main";
  isolation = true;
  await send("Isolated", { goal: false });
  assert.equal(calls[4].workIsolation, true);
  await send("Explicitly shared", { goal: false, workIsolation: false });
  assert.equal(calls[5].workIsolation, false);
});

test("ordinary sends follow the orchestrator switch while menu actions keep their route", () => {
  const capabilities = { taskModes: ["orchestrate", "direct", "work"], goal: true, fast: true };
  for (const [orchestrateMode, taskModes, action, expected] of [
    [true, capabilities.taskModes, "direct", "orchestrate"],
    [false, capabilities.taskModes, "direct", "direct"],
    [true, ["direct", "work"], "direct", "direct"],
    [true, capabilities.taskModes, "work", "work"]
  ]) {
    const { context, sent, run } = harness({ orchestrateMode });
    context.currentCapabilities = () => ({ ...capabilities, taskModes });
    run(`submit("${action}")`);
    assert.equal(sent[0].execution.taskMode, expected);
  }
});

test("contract actions can use conversation context while ordinary sends still need input", () => {
  for (const [action, workflow] of [["direct", "contract"], ["work", "normal"], ["work-verification", "normal"]]) {
    const { sent, run } = harness({}, "   ");
    run(`submit("${action}", "${workflow}")`);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes("contract"));
    assert.equal(sent[0].execution.taskMode, action);
    assert.equal(sent[0].execution.businessMode, workflow);
  }
});
