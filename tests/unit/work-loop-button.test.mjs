import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
const submit = script.slice(script.indexOf("  function submit("), script.indexOf("  function cancelRun()"));
const controls = script.slice(script.indexOf("  function updateSendButton()"), script.indexOf("  function updateRunControls()"));

function harness(overrides = {}, text = "오류 수정") {
  const sent = [];
  const context = {
    state: { role: "main", taskMode: "work", attachments: [], timeline: [], capabilities: {}, runtimeAvailable: true, ...overrides },
    timeline: { scrollTop: 0, scrollHeight: 500 },
    prompt: { value: text }, goalObjective: { value: "" }, nativeGoal: null,
    currentCapabilities: () => ({ model: true, reasoning: true, fast: true, goal: true }),
    createId: () => "message-id", renderAll() {}, resizePrompt() {}, persist() {},
    summarizeChildAgents: () => ({ activeUnits: 0, workActive: 0, verificationActive: 0, totalCalled: 0 }),
    appendNotice() {}, vscode: { postMessage: message => sent.push(message) },
    workLoopButton: {}, sendButton: {}
  };
  runInNewContext(submit + controls, context);
  return { context, sent, run: code => runInNewContext(code, context) };
}

test("mode submission preserves the draft, actual image reference and selected model", () => {
  const image = { id: "image-one", name: "input.png", kind: "image", uri: "file:///host/input.png", previewUri: "vscode-resource://input.png", mediaType: "image/png", size: 32 };
  const { context, sent, run } = harness({ model: "chosen-model", attachments: [image] });
  run("submit()");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "오류 수정");
  assert.equal(sent[0].execution.taskMode, "work");
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
  assert.equal(sent[0].execution.taskMode, "work");
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
  const handler = script.match(/workLoopButton\.addEventListener\("click", function \(\) \{([\s\S]*?)\n  \}\);/)[1];
  const calls = [];
  runInNewContext(handler, { openSetting: setting => calls.push(setting) });
  assert.deepEqual(calls, ["task"]);
});

test("four modes snapshot each queued submission independently", () => {
  const { context, sent, run } = harness({ running: true });
  for (const taskMode of ["direct", "work", "work-verification", "plan-work-verification"]) {
    context.state.taskMode = taskMode;
    context.prompt.value = "동일 요청";
    run("submit()");
  }
  context.state.taskMode = "direct";
  assert.deepEqual(sent.map(message => message.execution.taskMode), ["direct", "work", "work-verification", "plan-work-verification"]);
  assert.ok(sent.every(message => message.text === "동일 요청"));
});

test("attachment-only loop requests show attachment names without injected instructions", () => {
  const { context, sent, run } = harness({ attachments: [{ name: "input.txt" }] }, "");
  run("submit()");
  assert.equal(context.state.timeline.length, 0);
  assert.equal(context.state.pendingRequests[0].attachments[0].name, "input.txt");
  assert.equal(sent[0].text, "");
  assert.equal(sent[0].execution.taskMode, "work");
});

test("mode menu explains standalone Verification and displays supported choices and persists a supported next-task selection during execution", () => {
  function element() {
    return { children: [], dataset: {}, handlers: {}, classList: { add() {} },
      setAttribute() {}, append(...children) { this.children.push(...children); },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      replaceChildren() { this.children = []; } };
  }
  const names = { verification: "Verification", direct: "Direct", work: "Work", "work-verification": "Work · Verification", "plan-work-verification": "Plan · Work · Verification" };
  const menu = element();
  const calls = [];
  const context = {
    state: { taskMode: "work", running: true }, taskModeNames: names,
    settingOptions: { task: Object.keys(names) }, menu,
    document: { createElement: element, createElementNS: element },
    currentCapabilities: () => ({ taskModes: ["direct", "work", "work-verification"] }),
    handleSettingMenuKeydown() {}, updateModeControls() {}, renderStatusBar() {},
    persist() { calls.push("persist"); }, saveComposerSettings() { calls.push("save"); }, closeSettingMenu() {}
  };
  const renderer = script.slice(script.indexOf("  function renderSettingMenu("), script.indexOf("  function handleSettingMenuKeydown("));
  runInNewContext(renderer + '\nrenderSettingMenu("task", menu);', context);
  assert.equal(menu.children[0].textContent, "Verification checks existing work and reports findings without making changes.");
  const options = menu.children.filter(item => item.dataset.value);
  assert.equal(options.length, 5);
  assert.equal(options[0].disabled, false);
  assert.equal(options[4].disabled, true);
  assert.equal(options[1].disabled, false);
  options[0].handlers.click();
  assert.equal(context.state.taskMode, "verification");
  assert.equal(context.state.running, true);
  assert.deepEqual(calls, ["persist", "save"]);
  context.currentCapabilities = () => ({ taskModes: ["work"] });
  runInNewContext('renderSettingMenu("task", menu);', context);
  assert.equal(menu.children.find(item => item.dataset.value === "verification").disabled, true);
});


test("workflow selections snapshot queued user text independently of task route", () => {
  const { context, sent, run } = harness({ running: true });
  for (const businessMode of ["interview", "planning", "design", "normal"]) {
    context.state.businessMode = businessMode;
    context.prompt.value = "Original request";
    run("submit()");
  }
  context.state.businessMode = "design";
  assert.deepEqual(sent.map(message => message.execution.businessMode), ["interview", "planning", "design", "normal"]);
  assert.ok(sent.every(message => message.text === "Original request" && message.execution.taskMode === "work"));
});


test("Verification snapshots inspection selection and suppresses Goal continuation", () => {
  const { context, sent, run } = harness({ taskMode: "verification", goalMode: true });
  context.goalObjective.value = "Old implementation goal";
  run("submit()");
  context.state.taskMode = "work";
  assert.equal(sent[0].execution.taskMode, "verification");
  assert.equal(sent[0].execution.goal, false);
  assert.equal(sent[0].execution.goalObjective, undefined);
});
