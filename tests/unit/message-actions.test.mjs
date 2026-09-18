import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
const submitSource = script.slice(script.indexOf('  function submit('), script.indexOf('  function cancelRun()'));
const actions = ['work', 'plan', 'verification', 'plan-work', 'work-verification', 'plan-work-verification'];

for (const action of actions) {
  test(`${action} sends current draft once; ordinary send remains direct`, () => {
    const sent = [];
    const context = {
      state: { role: 'main', taskMode: 'work-verification', businessMode: 'interview', attachments: [], capabilities: {}, runtimeAvailable: true, goalMode: true },
      taskModeNames: Object.fromEntries(['direct', ...actions].map(value => [value, value])),
      inputFeedback: {}, prompt: { value: 'Current draft', focus() {} }, timeline: {}, followLatest: false,
      currentCapabilities: () => ({ goal: true }), createId: () => String(sent.length),
      appendNotice() { throw Error('Unexpected notice'); }, saveComposerSettings() {}, renderAll() {}, resizePrompt() {}, persist() {},
      vscode: { postMessage(message) { sent.push(message); } }
    };
    context.state.attachments = [{ id: 'file', kind: 'file', name: 'example.ts', uri: 'file:///project/example.ts' }];
    runInNewContext(submitSource + `\nsubmit(${JSON.stringify(action)});`, context);
    assert.equal(sent[0].execution.taskMode, action);
    assert.equal(sent[0].execution.businessMode, 'normal');
    assert.equal(sent[0].execution.goal, false);
    assert.equal(sent[0].attachments[0].id, 'file');
    assert.equal(context.prompt.value, '');
    assert.equal(context.state.goalMode, false);
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
  const persistence = script.slice(script.indexOf('  function persist()'));
  assert.doesNotMatch(persistence, /taskMode: state.taskMode/);
});
