import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const output = await build({ entryPoints: [new URL('../../src/modules/chat/session-controller.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { ChatSessionController } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function events(extra = {}) {
  return { onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {}, onError() {}, ...extra };
}
function runtime(extra = {}) {
  return {
    async activeRun() {},
    async send(agentId, text) { return { agentId, runId: text }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: 'completed' }; },
    async result() { return { status: 'completed', text: 'done' }; },
    ...extra
  };
}

test('queue promotes only accepted requests and preserves FIFO snapshots and active identity', async () => {
  const terminal = deferred(), acceptance = deferred();
  const calls = [], promoted = [], cancelled = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options, images) {
      calls.push({ text, options, images });
      if (text.startsWith('second')) await acceptance.promise;
      return { agentId, runId: text.startsWith('second') ? 'second' : text };
    },
    async status(_agentId, runId) { if (runId === 'first') await terminal.promise; return { status: 'completed' }; },
    async cancel(...args) { cancelled.push(args); }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}, () => promoted.push('first'));
  await tick();
  const options = { taskMode: 'work-verification', model: 'original', reasoningEffort: 'high', fast: true, goalMode: true, goalObjective: 'objective', executionMode: 'workspace-write' };
  const image = { id: 'image', kind: 'image', name: 'input.png', uri: 'file:///tmp/original.png', mediaType: 'image/png' };
  const second = controller.send('second', [image], options, () => promoted.push('second'));
  const third = controller.send('third', [], { taskMode: 'direct' }, () => promoted.push('third'));
  options.model = 'changed'; image.uri = 'file:///tmp/changed.png';
  assert.equal(controller.runId, 'first');
  assert.equal(controller.queueLength, 2);
  assert.deepEqual(promoted, ['first']);
  assert.deepEqual(cancelled, []);
  terminal.resolve(); await tick();
  assert.deepEqual(promoted, ['first']);
  acceptance.resolve(); await Promise.all([first, second, third]);
  assert.deepEqual(promoted, ['first', 'second', 'third']);
  assert.equal(calls[1].options.model, 'original');
  assert.equal(calls[1].options.taskMode, 'work-verification');
  assert.equal(calls[1].options.executionMode, 'workspace-write');
  assert.equal(calls[1].images[0].path, '/tmp/original.png');
  assert.equal(controller.queueLength, 0);
});

test('decision-required pauses FIFO until an explicit answer is accepted', async () => {
  const terminal = deferred(), sent = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { sent.push(text); return { agentId, runId: text === 'proposal' ? 'proposal' : 'next' }; },
    async status(_agentId, runId) { if (runId === 'proposal') await terminal.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'proposal' ? 'needs-human-decision' : 'completed', text: 'result' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('proposal', [], { taskMode: 'work' });
  await tick();
  const second = controller.send('queued', [], {}, () => promoted.push('queued'));
  terminal.resolve(); await first;
  assert.equal(controller.queueLength, 1);
  assert.deepEqual(sent, ['proposal']);
  assert.deepEqual(promoted, []);
  assert.equal(controller.approveDecision('proposal', {}), true);
  await second;
  assert.equal(sent.length, 3);
  assert.match(sent[1], /제안한 범위/);
  assert.equal(sent[2], 'queued');
  assert.deepEqual(promoted, ['queued']);
});

test('polling loss preserves the current run and cannot dispatch queued input before reconnect completes', async () => {
  const broken = deferred(), recovered = deferred(), calls = [], promoted = [];
  let disconnected = true;
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { calls.push(text); return { agentId, runId: text }; },
    async updates(_agentId, runId) {
      if (runId === 'first') {
        if (disconnected) { await broken.promise; throw new Error('connection lost'); }
        await recovered.promise;
      }
      return { cursor: 0, updates: [] };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {});
  await tick();
  const second = controller.send('second', [], {}, () => promoted.push('second'));
  broken.resolve(); await first;
  assert.equal(controller.runId, 'first');
  assert.equal(controller.queueLength, 1);
  assert.deepEqual(calls, ['first']);
  disconnected = false;
  await controller.reconnect();
  assert.deepEqual(promoted, []);
  recovered.resolve(); await second;
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(promoted, ['second']);
});

test('explicit stop targets only the current run and preserves queued requests', async () => {
  const stopped = deferred(), cancelled = [], sent = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { sent.push(text); return { agentId, runId: text }; },
    async status(_agentId, runId) { if (runId === 'first') await stopped.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'first' ? 'cancelled' : 'completed', text: '' }; },
    async cancel(...args) { cancelled.push(args); stopped.resolve(); }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}); await tick();
  const second = controller.send('second', [], {});
  assert.deepEqual(cancelled, []);
  await controller.cancel(); await Promise.all([first, second]);
  assert.deepEqual(cancelled, [['main-existing', 'first']]);
  assert.deepEqual(sent, ['first', 'second']);
});

test('webview acceptance replay promotes exactly once and preserves queued image previews', async () => {
  const script = await readFile(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
  const handler = script.slice(script.indexOf('      case "chat.started":'), script.indexOf('      case "queue.updated":'));
  const context = {
    state: { pendingRequests: [{ id: 'one', attachments: [{ name: 'input.png', previewUri: 'safe-preview' }] }], timeline: [] },
    message: { type: 'chat.started', id: 'one', text: 'request', attachments: [] },
    summarizeChildAgents: () => ({}), renderAll() {}, persist() {}
  };
  for (let i = 0; i < 2; i++) runInNewContext(`switch (message.type) { ${handler} }`, context);
  assert.equal(context.state.timeline.length, 1);
  assert.equal(context.state.timeline[0].attachments[0].previewUri, 'safe-preview');
  assert.equal(context.state.pendingRequests.length, 0);
});

test('known failure drains FIFO while an unacknowledged dispatch is never automatically repeated', async () => {
  const terminal = deferred(), sent = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) {
      sent.push(text);
      if (text === 'unacknowledged') throw new Error('acceptance response lost');
      return { agentId, runId: text };
    },
    async status(_agentId, runId) { if (runId === 'failed') await terminal.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'failed' ? 'failed' : 'completed', text: '' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('failed', [], {}); await tick();
  const second = controller.send('unacknowledged', [], {}, () => promoted.push('unacknowledged'));
  const third = controller.send('third', [], {}, () => promoted.push('third'));
  terminal.resolve(); await Promise.all([first, second]);
  assert.deepEqual(sent, ['failed', 'unacknowledged']);
  assert.equal(controller.queueLength, 1);
  assert.deepEqual(promoted, []);
  await controller.reconnect(); await third;
  assert.deepEqual(sent, ['failed', 'unacknowledged', 'third']);
  assert.deepEqual(promoted, ['third']);
});

test('input during Goal reopen acceptance waits for the accepted Goal run to finish', async () => {
  const acceptance = deferred(), terminal = deferred(), sent = [];
  const controller = new ChatSessionController(runtime({
    async goal() { return acceptance.promise; },
    async send(agentId, text) { sent.push(text); return { agentId, runId: text }; },
    async status(_agentId, runId) { if (runId === 'goal-run') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const goal = controller.controlGoal('reopen');
  const queued = controller.send('queued', [], {});
  assert.equal(controller.queueLength, 1);
  assert.deepEqual(sent, []);
  acceptance.resolve({ accepted: { agentId: 'main-existing', runId: 'goal-run' } }); await tick();
  assert.equal(controller.runId, 'goal-run');
  assert.deepEqual(sent, []);
  terminal.resolve(); await Promise.all([goal, queued]);
  assert.deepEqual(sent, ['queued']);
});
