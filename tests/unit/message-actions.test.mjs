import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runUiInNewContext as runInNewContext } from '../support/ui-localization.mjs';
import test from 'node:test';
import { readChatSource } from "../support/chat-source.mjs";

const script = await readChatSource();
const submitSource = script.slice(script.indexOf('  function submit('), script.indexOf('  function cancelRun('))
  // submit() resolves delegated model settings through these helpers.
  + script.slice(script.indexOf('  function agentSettingRole('), script.indexOf('  function createAgentSettingControl('));
const actions = ['work', 'plan', 'verification', 'plan-work', 'work-verification', 'plan-work-verification'];

for (const action of actions) for (const goalEnabled of [false, true]) {
  test(`${action} captures explicit Goal=${goalEnabled} once; ordinary send remains direct`, () => {
    const sent = [];
    const context = {
      state: { role: 'main', taskMode: 'work-verification', businessMode: 'interview', attachments: [], capabilities: {}, runtimeAvailable: true, goalMode: true },
      taskModeNames: Object.fromEntries(['direct', ...actions].map(value => [value, value])),
      inputFeedback: {}, prompt: { value: 'Current draft', focus() {} }, timeline: {}, followLatest: false,
      conversationClearing: false, conversationWorktree: undefined,
      currentCapabilities: () => ({ goal: true }), createId: () => String(sent.length),
      appendNotice() { throw Error('Unexpected notice'); }, saveComposerSettings() {}, renderAll() {}, resizePrompt() {}, persist() {},
      vscode: { postMessage(message) { sent.push(message); } }
    };
    context.state.attachments = [{ id: 'file', kind: 'file', name: 'example.ts', uri: 'file:///project/example.ts' }];
    runInNewContext(submitSource + `\nsubmit(${JSON.stringify(action)}, "normal", ${goalEnabled});`, context);
    assert.equal(sent[0].execution.taskMode, action);
    assert.equal(sent[0].execution.businessMode, 'normal');
    assert.equal(sent[0].execution.goal, goalEnabled && action !== 'verification');
    assert.equal(sent[0].execution.goalObjective, goalEnabled && action !== 'verification' ? 'Current draft' : undefined);
    assert.equal(sent[0].attachments[0].id, 'file');
    assert.equal(context.prompt.value, '');
    // A stale saved toggle must not influence the next ordinary send.
    context.prompt.value = 'Next ordinary input';
    runInNewContext('submit();', context);
    assert.equal(sent[1].execution.taskMode, 'direct');
    assert.equal(sent[1].execution.goal, false);
    assert.equal(context.state.pendingRequests[0].execution.taskMode, action);
  });
}

test('composer has exactly six send actions and action choices send immediately', () => {
  const values = script.match(/task: (\[[^\n]+\]),/)[1];
  assert.deepEqual(JSON.parse(values), actions);
  assert.match(script, /closeSettingMenu\(false\);\s+submit\(action, workflow, goal\);/);
  const persistence = script.slice(script.indexOf('  function persist('));
  assert.doesNotMatch(persistence, /taskMode: state.taskMode/);
});

for (const action of ['direct', ...actions]) {
  test(`${action} rejects blank input but preserves attachment-only requests`, () => {
    const sent = [];
    const context = {
      state: { role: 'main', attachments: [], capabilities: {}, runtimeAvailable: true, goalMode: false },
      taskModeNames: Object.fromEntries(['direct', ...actions].map(value => [value, value])),
      inputFeedback: {}, prompt: { value: '   ', focus() {} }, timeline: {}, followLatest: false,
      conversationClearing: false, conversationWorktree: undefined,
      currentCapabilities: () => ({ goal: true }), createId: () => 'attachment-only',
      appendNotice() { throw Error('Unexpected notice'); }, saveComposerSettings() {}, renderAll() {}, resizePrompt() {}, persist() {},
      vscode: { postMessage(message) { sent.push(message); } }
    };
    runInNewContext(submitSource + `\nsubmit(${JSON.stringify(action)});`, context);
    const contextual = action === 'work' || action === 'work-verification';
    assert.equal(sent.length, contextual ? 1 : 0);
    assert.equal(context.prompt.value, contextual ? '' : '   ');
    assert.equal(context.inputFeedback.hidden, contextual);
    context.state.attachments = [{ id: 'image', kind: 'image', name: 'example.png', uri: 'file:///project/example.png' }];
    runInNewContext(`submit(${JSON.stringify(action)});`, context);
    assert.equal(sent.length, contextual ? 2 : 1);
    assert.equal(sent.at(-1).text, contextual ? sent[0].text : '');
    assert.equal(sent.at(-1).execution.taskMode, action);
    assert.equal(sent.at(-1).attachments[0].id, 'image');
  });
}


test('stop request gives synchronous feedback, stays running, and coalesces repeats', () => {
  const events = [];
  const context = {
    state: { running: true },
    vscode: { postMessage(message) { events.push(message.type); } },
    renderRunStatus() { events.push('render'); },
    renderStatusBar() {},
  };
  const cancel = script.slice(script.indexOf('  function cancelRun('), script.indexOf('  function isDuplicateCancellation('));
  runInNewContext(cancel + ';cancelRun();cancelRun();', context);
  assert.deepEqual(events, ['run.cancel', 'render']);
  assert.equal(context.state.running, true);
  assert.equal(context.state.cancellationRequested, true);
  context.state.running = false;
  runInNewContext(cancel + ';cancelRun();', context);
  assert.equal(events.length, 2);
});

test('the visible stop button does not pass its click event as a cancellation retry', () => {
  assert.match(script, /runStopButton\.addEventListener\("click", \(\) => cancelRun\(\)\)/);
  assert.doesNotMatch(script, /runStopButton\.addEventListener\("click", cancelRun\)/);
});

test('host termination clears stop feedback and errors allow a retry', () => {
  const context = {
    state: { running: true, cancellationRequested: true },
    message: { running: false },
    botOutcome: undefined,
    clearTimeout() {}, dropLivePreviews() {}, updateRunControls() {},
    scheduleTimelineRender() {}, renderStatusBar() {}, persist() {},
    renderRunStatus() {}, renderFactoryBot() {}, appendNotice() {},
  };
  const terminal = script.slice(script.indexOf('      case "run.state":'), script.indexOf('      case "chat.rejected":'));
  runInNewContext('switch ("run.state") {' + terminal + '}', context);
  assert.equal(context.state.running, false);
  assert.equal(context.state.cancellationRequested, false);
  context.state.running = true;
  context.state.cancellationRequested = true;
  context.message = { level: 'error', text: 'cancel failed' };
  const notice = script.slice(script.indexOf('      case "host.notice":'), script.indexOf('      case "status.updated":'));
  runInNewContext('switch ("host.notice") {' + notice + '}', context);
  assert.equal(context.state.running, true);
  assert.equal(context.state.cancellationRequested, false);
});
