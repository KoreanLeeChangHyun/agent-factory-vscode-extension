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
