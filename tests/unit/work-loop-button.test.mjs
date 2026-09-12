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
    state: { role: "main", workLoopMode: true, attachments: [], timeline: [], capabilities: {}, runtimeAvailable: true, ...overrides },
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

test("loop button sends explicit delegation with the draft, attachments and selected model", () => {
  const { context, sent, run } = harness({ model: "chosen-model", attachments: [{ name: "input.txt" }] });
  run("submit()");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^오류 수정\n\n작업·검증 루프/);
  assert.match(sent[0].text, /Work → Verification/);
  assert.match(sent[0].text, /실패하면 같은 Work에서 수정한 뒤 재검증/);
  assert.equal(sent[0].attachments[0].name, "input.txt");
  assert.equal(sent[0].execution.model, "chosen-model");
  assert.equal(context.state.timeline[0].text, "오류 수정");
  assert.doesNotMatch(context.state.timeline[0].text, /Work → Verification/);
  assert.equal(context.prompt.value, "");
  run("submit()");
  assert.equal(sent.length, 1);
});

test("enabled mode never sends an empty message, even in an existing session", () => {
  const { sent, run } = harness({ agentId: "main-existing" }, "");
  run("submit()");
  assert.equal(sent.length, 0);
});

test("running or disconnected sessions do not send", () => {
  for (const state of [{ running: true }, { runtimeAvailable: false }, { capabilities: null }]) {
    const { sent, run } = harness(state);
    run("submit()");
    assert.equal(sent.length, 0);
  }
});

test("disabled mode and child sessions preserve the original request", () => {
  for (const state of [{ workLoopMode: false }, { role: "work" }, { role: "verification" }]) {
    const { sent, run } = harness(state);
    run("submit()");
    assert.equal(sent[0].text, "오류 수정");
  }
});

test("icon click toggles mode without submitting and keeps its setting", () => {
  const handler = script.match(/workLoopButton\.addEventListener\("click", function \(\) \{([\s\S]*?)\n  \}\);/)[1];
  const toggle = script.slice(script.indexOf("  function toggleMode(key)"), script.indexOf("  function currentCapabilities()"));
  const calls = [];
  const context = {
    state: { workLoopMode: false },
    updateModeControls() {}, renderStatusBar() {}, persist() {},
    saveComposerSettings() { calls.push(context.state.workLoopMode); }
  };
  runInNewContext(toggle + handler, context);
  assert.equal(context.state.workLoopMode, true);
  runInNewContext(handler, context);
  assert.equal(context.state.workLoopMode, false);
  assert.deepEqual(calls, [true, false]);
});

test("attachment-only loop requests show attachment names without injected instructions", () => {
  const { context, sent, run } = harness({ attachments: [{ name: "input.txt" }] }, "");
  run("submit()");
  assert.equal(context.state.timeline[0].text, "첨부: input.txt");
  assert.match(sent[0].text, /Work → Verification/);
});
