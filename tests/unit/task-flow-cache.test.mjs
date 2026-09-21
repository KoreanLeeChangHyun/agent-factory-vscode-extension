import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
const aggregation = source.slice(source.indexOf('  function currentTaskFlows() {'), source.indexOf('  function liveTaskStatus('));

test('task-flow aggregation reuses unchanged histories and invalidates all input replacements', () => {
  let parses = 0;
  const state = { timeline: Array.from({ length: 10000 }, (_, id) => ({ type: 'assistant', text: String(id) })), taskFlows: [], childAgents: [], workflows: [] };
  const context = { state, taskFlowParseCache: new WeakMap(), extractTaskFlows(text) { parses++; return { flows: [{ id: 'flow', title: text, tasks: [] }] }; }, acceptedTaskAgent: () => true, t: () => 'Verification' };
  runInNewContext('let taskFlowSnapshot;\n' + aggregation + '\nglobalThis.getFlows = currentTaskFlows;', context);
  const original = context.getFlows();
  assert.equal(original[0].title, '9999');
  assert.equal(parses, 10000);
  // No iteration or parsing is needed when a timer renders unchanged state.
  state.timeline[Symbol.iterator] = () => { throw new Error('Unexpected history traversal'); };
  for (let i = 0; i < 100; i++) assert.equal(context.getFlows(), original);
  delete state.timeline[Symbol.iterator];
  state.timeline.push({ type: 'assistant', text: 'new' });
  assert.equal(context.getFlows()[0].title, 'new');
  assert.equal(parses, 10001);
  let previous = context.getFlows();
  for (const key of ['taskFlows', 'childAgents', 'workflows']) {
    state[key] = [];
    const next = context.getFlows(); assert.notEqual(next, previous); previous = next;
  }
  context.t = () => '검증';
  assert.notEqual(context.getFlows(), previous);
  state.timeline = [];
  assert.equal(context.getFlows().length, 0);
});
