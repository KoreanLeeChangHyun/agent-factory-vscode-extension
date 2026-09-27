import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
const indexSource = source.slice(source.indexOf('  function indexedTimeline()'), source.indexOf('  function upsertActivity('));
const body = source.slice(source.indexOf('  function canAnswerInterview('), source.indexOf('  function renderInterviewChoices('));
function setup(timeline) {
  const state = { timeline, runtimeAvailable: true, running: false, pendingRequests: [] };
  const context = vm.createContext({ state, timelineIndexes: new WeakMap(), taskFlowParseCache: new WeakMap(), nextTimelineIndex: 0,
    extractTaskFlows: () => ({ flows: [] }) });
  vm.runInContext(indexSource + body, context);
  return { state, answer: context.canAnswerInterview };
}

test('only the latest unanswered conversation turn permits a choice', () => {
  const old = { type: 'assistant', phase: 'final' };
  const current = { type: 'assistant', phase: 'final' };
  const { state, answer } = setup([old, { type: 'user' }, current, { type: 'activity' }, { type: 'assistant', phase: 'commentary' }]);
  assert.equal(answer(old), false);
  assert.equal(answer(current), true);
  current.choiceAnswer = '1';
  assert.equal(answer(current), false);
  delete current.choiceAnswer;
  for (const [key, value] of [['running', true], ['pendingRequests', [{}]], ['runtimeAvailable', false]]) {
    const previous = state[key];
    state[key] = value;
    assert.equal(answer(current), false);
    state[key] = previous;
  }
  state.timeline.push({ type: 'user' });
  assert.equal(answer(current), false);
  state.timeline = [];
  assert.equal(answer(current), false);
});

test('rendering 200 choices does not inspect 10,000 older turns', () => {
  const current = { type: 'assistant', phase: 'final' };
  const timeline = Array.from({ length: 10000 }, () => ({ type: 'notice' }));
  timeline.push(current);
  const { answer } = setup(timeline);
  assert.equal(answer(current), true);
  Object.defineProperty(timeline, 0, { get() { throw Error('Older history unnecessarily read'); } });
  for (let i = 0; i < 200; i++) assert.equal(answer(current), true);
});
