import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';

const { ChatSessionController } = await importTypeScript('src/modules/chat/session-controller.ts');

function fixture(status) {
  const observed = { errors: [], finals: [], running: [], cancellations: 0, submissions: 0 };
  const runtime = {
    async submit() { observed.submissions++; return { agentId: 'main-test', runId: 'run-test' }; },
    async updates(a, r, cursor) { return { cursor: cursor + 1, updates: [] }; },
    status,
    async result() { return { status: 'completed', text: 'finished' }; },
    async cancel() { observed.cancellations++; }
  };
  const events = {
    onBound() {}, onProgress() {}, onActivity() {},
    onRunningChanged(value) { observed.running.push(value); },
    onError(value) { observed.errors.push(value); },
    onAssistantText(text, channel) { if (channel === 'final') observed.finals.push(text); }
  };
  return { runtime, events, observed };
}

function accelerate(t) {
  // Advance only the poll delay, retaining async boundaries and production defaults.
  t.mock.method(globalThis, 'setTimeout', (callback) => { queueMicrotask(callback); return 0; });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('stop freezes late text and questions while preserving usage, diagnostics and activity settlement', async () => {
  const pendingUpdates = deferred(), reading = deferred();
  const text = [], deltas = [], questions = [], activities = [], usage = [];
  const f = fixture(async () => ({ status: 'cancelled' }));
  f.runtime.updates = async () => {
    reading.resolve();
    return pendingUpdates.promise;
  };
  f.runtime.result = async () => ({ status: 'cancelled', text: 'late final' });
  Object.assign(f.events, {
    onAssistantText: value => text.push(value), onAssistantDelta: value => deltas.push(value),
    onInterviewQuestion: value => questions.push(value), onActivity: value => activities.push(value),
    onUsage: value => usage.push(value)
  });
  const controller = new ChatSessionController(f.runtime, f.events, undefined, { pollIntervalMs: 0 });
  const send = controller.send('work', [], {});
  await reading.promise;
  await controller.cancel();
  pendingUpdates.resolve({ cursor: 6, updates: [
    { kind: 'delta', stream: 'final', id: 'late', text: 'late delta' },
    { kind: 'commentary', text: 'late commentary' },
    { kind: 'interviewQuestion', question: { id: 'late-question' } },
    { kind: 'activity', id: 'late-start', category: 'tool', phase: 'started', text: 'late tool' },
    { kind: 'activity', id: 'old', category: 'tool', phase: 'completed', text: 'settled tool' },
    { kind: 'usage', usedTokens: 42, contextWindowTokens: 100 }
  ] });
  await send;
  assert.deepEqual(text, []);
  assert.deepEqual(deltas, []);
  assert.deepEqual(questions, []);
  assert.deepEqual(activities.map(value => value.id), ['run-test:old']);
  assert.deepEqual(usage, [42]);
  assert.equal(f.observed.errors.length, 1);
  assert.match(f.observed.errors[0], /cancelled/);
  assert.equal(f.observed.cancellations, 1);
});

test('a stop during the terminal result read freezes completion text without hiding real failures', async () => {
  for (const status of ['completed', 'failed']) {
    const pendingResult = deferred(), reading = deferred();
    const f = fixture(async () => ({ status }));
    f.runtime.result = async () => { reading.resolve(); return pendingResult.promise; };
    const controller = new ChatSessionController(f.runtime, f.events, undefined, { pollIntervalMs: 0 });
    const send = controller.send('work', [], {});
    await reading.promise;
    await controller.cancel();
    pendingResult.resolve({ status, text: 'late result', ...(status === 'failed' ? { error: { code: 'provider_failed', message: 'real failure' } } : {}) });
    await send;
    assert.equal(f.observed.finals.some(text => text.includes('late result')), false);
    if (status === 'failed') assert.match(f.observed.errors[0], /provider_failed: real failure/);
    else assert.deepEqual(f.observed.errors, []);
  }
});

test('failed cancellation restores streaming and exposes its error', async () => {
  const pendingUpdates = deferred(), reading = deferred(), deltas = [];
  const f = fixture(async () => ({ status: 'completed' }));
  f.runtime.updates = async () => { reading.resolve(); return pendingUpdates.promise; };
  f.runtime.cancel = async () => { throw new Error('stop transport failed'); };
  f.events.onAssistantDelta = value => deltas.push(value.text);
  const controller = new ChatSessionController(f.runtime, f.events, undefined, { pollIntervalMs: 0 });
  const send = controller.send('work', [], {});
  await reading.promise;
  await controller.cancel();
  pendingUpdates.resolve({ cursor: 1, updates: [{ kind: 'delta', stream: 'final', id: 'normal', text: 'still live' }] });
  await send;
  assert.deepEqual(deltas, ['still live']);
  assert.deepEqual(f.observed.errors, ['stop transport failed']);
  assert.deepEqual(f.observed.finals, ['finished']);
});

test('default observation survives more than 7200 cycles and delivers the terminal result', async t => {
  accelerate(t);
  let cycles = 0;
  const f = fixture(async () => ({ status: cycles > 7200 ? 'completed' : 'running' }));
  f.runtime.updates = async (a, r, cursor) => { cycles++; return { cursor: cursor + 1, updates: [] }; };
  const controller = new ChatSessionController(f.runtime, f.events);
  await controller.send('long work', [], {});
  assert.ok(cycles > 7200);
  assert.deepEqual(f.observed.errors, []);
  assert.deepEqual(f.observed.finals, ['finished']);
  assert.deepEqual(f.observed.running, [true, false]);
  assert.equal(f.observed.cancellations, 0);
  assert.equal(f.observed.submissions, 1);
});

test('disposal stops unbounded observation without cancelling the runtime', async t => {
  accelerate(t);
  let controller, polls = 0;
  const f = fixture(async () => {
    if (++polls === 3) controller.dispose();
    return { status: 'running' };
  });
  controller = new ChatSessionController(f.runtime, f.events);
  await controller.send('work', [], {});
  assert.equal(polls, 3);
  assert.equal(f.observed.cancellations, 0);
  assert.deepEqual(f.observed.finals, []);
});

test('query failure preserves accepted identity and never fabricates completion or cancellation', async () => {
  const f = fixture(async () => { throw new Error('status transport unavailable'); });
  const controller = new ChatSessionController(f.runtime, f.events);
  await controller.send('work', [], {});
  assert.deepEqual(f.observed.errors, ['status transport unavailable']);
  assert.equal(controller.runId, 'run-test');
  assert.equal(f.observed.submissions, 1);
  assert.equal(f.observed.cancellations, 0);
  assert.deepEqual(f.observed.finals, []);
});

test('cancelled run settles an unfinished context compaction instead of leaving it spinning', async t => {
  accelerate(t);
  const activities = [];
  const f = fixture(async () => ({ status: 'cancelled' }));
  f.events.onActivity = activity => activities.push(activity);
  f.runtime.result = async () => ({ status: 'cancelled', text: '' });
  let delivered = false;
  f.runtime.updates = async (a, r, cursor) => {
    if (delivered) return { cursor, updates: [] };
    delivered = true;
    return { cursor: cursor + 1, updates: [
      { kind: 'activity', id: 'compact-1', category: 'tool', phase: 'started', text: 'Compacting context', title: 'Context compaction' },
      { kind: 'activity', id: 'cmd-1', category: 'command', phase: 'started', text: 'ls' },
      { kind: 'activity', id: 'cmd-1', category: 'command', phase: 'completed', text: 'ls' }
    ] };
  };
  const controller = new ChatSessionController(f.runtime, f.events);
  await controller.send('work', [], {});
  const settled = activities.slice(3);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].id, 'run-test:compact-1');
  assert.equal(settled[0].phase, 'failed');
  assert.equal(settled[0].text, 'Context compaction interrupted');
});

test('activity details reach the webview with the protocol kind, not the update discriminant', async t => {
  accelerate(t);
  const activities = [];
  const f = fixture(async () => ({ status: 'completed' }));
  f.events.onActivity = activity => activities.push(activity);
  let delivered = false;
  f.runtime.updates = async (a, r, cursor) => {
    if (delivered) return { cursor, updates: [] };
    delivered = true;
    return { cursor: cursor + 1, updates: [
      { kind: 'activity', id: 'read-1', category: 'tool', phase: 'completed', text: 'claude/Read', activityKind: 'read', target: 'src/a.py', lineStart: 3, lineEnd: 9 },
      { kind: 'activity', id: 'cmd-1', category: 'command', phase: 'completed', text: 'ls' }
    ] };
  };
  const controller = new ChatSessionController(f.runtime, f.events);
  await controller.send('work', [], {});
  assert.deepEqual(activities.slice(0, 2), [
    { id: 'run-test:read-1', category: 'tool', phase: 'completed', text: 'claude/Read', kind: 'read', target: 'src/a.py', lineStart: 3, lineEnd: 9 },
    { id: 'run-test:cmd-1', category: 'command', phase: 'completed', text: 'ls' }
  ]);
});
