import assert from 'node:assert/strict';
import { runUiInNewContext as runInNewContext } from '../support/ui-localization.mjs';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
import { readChatSource } from "../support/chat-source.mjs";

const { ChatSessionController } = await importTypeScript('src/modules/chat/session-controller.ts');
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

test('inference occupancy reaches the experiment callback separately from display usage', async () => {
  const observed = [], displayed = [];
  const observation = { usedTokens: 80, contextWindowTokens: 100, observedAt: '2026-10-07T18:00:00Z',
    sessionId: 'a', turnId: 'turn', source: 'thread/tokenUsage/updated', estimated: true, providerVersion: null };
  let delivered = false;
  const controller = new ChatSessionController(runtime({
    async updates() {
      if (delivered) return { cursor: 2, updates: [] };
      delivered = true;
      return { cursor: 2, updates: [{ kind: 'contextObservation', observation },
        { kind: 'usage', usedTokens: 70, contextWindowTokens: 100 }] };
    }
  }), events({ onContextObservation: (...args) => observed.push(args), onUsage: (...args) => displayed.push(args) }),
  'main-existing', { pollIntervalMs: 0 });
  await controller.send('message', [], {});
  assert.deepEqual(observed, [[observation, 'message']]);
  assert.equal(displayed[0][0], 70);
});

test('opt-in handoff switches only at a send boundary and preserves the stable queue owner', async () => {
  const calls = [], prepared = [];
  const controller = new ChatSessionController(runtime({
    async handoff(agent, action, payload) {
      calls.push({ agent, action, payload });
      return { state: { owner: 'A', epoch: 2, preparation: { status: 'ready', slot: 'B' } }, preparationSnapshot: { cursor: 4 } };
    },
    async send(agent, text) { calls.push({ agent, action: 'send', text }); return { agentId: agent, runId: 'next' }; }
  }), events({ onHandoffPreparation: status => prepared.push(status) }), 'main-experiment',
  { pollIntervalMs: 0, handoffExperiment: true });
  await controller.send('exact next input', [], { model: 'fixed-model', fast: false });
  assert.deepEqual(calls.map(call => call.action), ['status', 'event', 'status', 'switch', 'send', 'status', 'event']);
  assert.ok(calls.every(call => call.agent === 'main-experiment'));
  assert.deepEqual(calls[3].payload, { slot: 'A', epoch: 2 });
  assert.deepEqual(calls[1].payload.original, { text: 'exact next input', attachments: [], execution: { model: 'fixed-model', fast: false } });
  assert.equal(calls[6].payload.id, calls[1].payload.id);
  assert.equal(calls[6].payload.operation, 'processed');
  assert.equal(prepared.length, 1);
});

test('stale preparation leaves A in charge and ordinary chats never call the handoff API', async () => {
  for (const enabled of [true, false]) {
    const calls = [];
    const controller = new ChatSessionController(runtime({
      async handoff(_agent, action) {
        calls.push(action);
        if (action === 'switch') throw new Error('handoff_invalid: stale cursor');
        return { state: { owner: 'A', epoch: 0, preparation: { status: 'ready', slot: 'B' } }, preparationSnapshot: {} };
      },
      async send(agentId) { calls.push('send'); return { agentId, runId: 'next' }; }
    }), events(), 'main-experiment', { pollIntervalMs: 0, handoffExperiment: enabled });
    await controller.send('preserved input', [], {});
    assert.deepEqual(calls, enabled ? ['status', 'event', 'status', 'switch', 'send', 'status', 'event'] : ['send']);
  }
});

test('experiment persists queued originals while A is active and acknowledges the same ID after delivery', async () => {
  const terminal = deferred(), recorded = [], sent = [];
  const controller = new ChatSessionController(runtime({
    async handoff(_agent, action, payload) {
      if (action === 'event') recorded.push(payload);
      return { state: { owner: 'A', epoch: 0, preparation: null }, preparationSnapshot: {} };
    },
    async send(agentId, text) { sent.push(text); return { agentId, runId: text }; },
    async status(_agent, runId) { if (runId === 'first') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-experiment', { pollIntervalMs: 0, handoffExperiment: true });
  const first = controller.send('first', [], {});
  await tick();
  const second = controller.send('queued approval change', [], { fast: false });
  await tick();
  const original = recorded.find(item => item.original?.text === 'queued approval change');
  assert.ok(original);
  assert.deepEqual(sent, ['first']);
  terminal.resolve();
  await Promise.all([first, second]);
  assert.equal(recorded.filter(item => item.kind === 'pending-input' && item.id === original.id).length, 1);
  assert.equal(recorded.filter(item => item.operation === 'processed' && item.id === original.id).length, 1);
  assert.deepEqual(sent, ['first', 'queued approval change']);
});

test('queue promotes only accepted requests and batches snapshots and active identity', async () => {
  const terminal = deferred(), acceptance = deferred();
  const calls = [], promoted = [], cancelled = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options, images) {
      calls.push({ text, options, images });
      if (text.includes('second')) await acceptance.promise;
      return { agentId, runId: text.includes('second') ? 'second' : text };
    },
    async status(_agentId, runId) { if (runId === 'first') await terminal.promise; return { status: 'completed' }; },
    async cancel(...args) { cancelled.push(args); }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}, () => promoted.push('first'));
  await tick();
  const options = { taskMode: 'work-verification', model: 'original', reasoningEffort: 'high', fast: true, goalMode: true, goalObjective: 'objective', executionMode: 'workspace-write' };
  const image = { id: 'image', kind: 'image', name: 'input.png', uri: 'file:///tmp/original.png', mediaType: 'image/png' };
  const second = controller.send('second', [image], options, () => promoted.push('second'));
  const third = controller.send('third', [], { taskMode: 'direct', executionMode: 'bypass' }, () => promoted.push('third'));
  options.model = 'changed'; image.uri = 'file:///tmp/changed.png';
  assert.equal(controller.runId, 'first');
  assert.equal(controller.queueLength, 2);
  assert.deepEqual(promoted, ['first']);
  assert.deepEqual(cancelled, []);
  terminal.resolve(); await tick();
  assert.deepEqual(promoted, ['first']);
  const fourth = controller.send('fourth', [], { executionMode: 'bypass' }, () => promoted.push('fourth'));
  assert.equal(controller.queueLength, 2);
  acceptance.resolve(); await Promise.all([first, second, third, fourth]);
  assert.deepEqual(promoted, ['first', 'second', 'third', 'fourth']);
  assert.equal(calls.length, 3);
  assert.match(calls[1].text, /^second\n/);
  assert.match(calls[2].text, /third/);
  assert.match(calls[2].text, /fourth/);
  assert.equal(calls[1].options.goalMode, true);
  assert.equal(calls[1].options.model, 'original');
  assert.equal(calls[1].options.taskMode, 'work-verification');
  assert.equal(calls[1].options.executionMode, 'workspace-write');
  assert.equal(calls[1].images[0].path, '/tmp/original.png');
  assert.equal(controller.queueLength, 0);
});

test('decision-required pauses batching until an explicit answer is accepted', async () => {
  const terminal = deferred(), sent = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { sent.push(text); return { agentId, runId: text.startsWith('proposal') ? 'proposal' : 'next' }; },
    async status(_agentId, runId) { if (runId === 'proposal') await terminal.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'proposal' ? 'needs-human-decision' : 'completed', text: 'result', decisionKind: runId === 'proposal' ? 'approval' : undefined }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('proposal', [], { taskMode: 'work' });
  await tick();
  const second = controller.send('queued', [], {}, () => promoted.push('queued'));
  const third = controller.send('also queued', [], {}, () => promoted.push('also queued'));
  terminal.resolve(); await first;
  assert.equal(controller.queueLength, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^proposal\n/);
  assert.deepEqual(promoted, []);
  assert.equal(controller.approveDecision('proposal', {}, 'ko'), true);
  await Promise.all([second, third]);
  assert.equal(sent.length, 3);
  assert.match(sent[1], /제안한 범위/);
  assert.match(sent[2], /대기 메시지 1 시작 ---\nqueued/);
  assert.match(sent[2], /대기 메시지 2 시작 ---\nalso queued/);
  assert.deepEqual(promoted, ['queued', 'also queued']);
});

test('reconnect restores the latest pending decision before conversation reset', async () => {
  const decisions = [];
  const controller = new ChatSessionController(runtime({
    async pendingDecision() { return { runId: 'question' }; }
  }), { ...events(), onDecision: (...args) => decisions.push(args) }, 'main-existing', { pollIntervalMs: 0 });
  await controller.reconnect();
  assert.deepEqual(decisions, [['question', false]]);
  assert.ok(controller.conversationResetBlockedReason);
  assert.equal(controller.approveDecision('question', {}), false);
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

test('late cancellation rejection cannot reset or block the next queued run cancellation', async () => {
  const firstTerminal = deferred(), secondUpdates = deferred(), secondReading = deferred();
  const firstCancel = deferred(), secondCancel = deferred();
  const cancelled = [], errors = [], output = [];
  const controller = new ChatSessionController(runtime({
    async updates(_agent, runId) {
      if (runId === 'second') { secondReading.resolve(); return secondUpdates.promise; }
      return { cursor: 0, updates: [] };
    },
    async status(_agent, runId) { if (runId === 'first') await firstTerminal.promise; return { status: 'cancelled' }; },
    async result() { return { status: 'cancelled', text: 'late answer' }; },
    async cancel(_agent, runId) {
      cancelled.push(runId);
      const gate = runId === 'first' ? firstCancel : secondCancel;
      const error = await gate.promise;
      if (error) throw error;
    }
  }), events({ onError: text => errors.push(text), onAssistantText: text => output.push(text),
    onAssistantDelta: delta => output.push(delta.text) }), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}); await tick();
  const second = controller.send('second', [], {});
  const stopFirst = controller.cancel();
  const duplicateStop = controller.cancel();
  assert.deepEqual(cancelled, ['first']);
  firstTerminal.resolve();
  await secondReading.promise;
  const stopSecond = controller.cancel();
  assert.deepEqual(cancelled, ['first', 'second']);
  firstCancel.resolve(new Error('old stop transport failed'));
  await Promise.all([stopFirst, duplicateStop]);
  secondUpdates.resolve({ cursor: 1, updates: [{ kind: 'delta', stream: 'final', id: 'late', text: 'late second delta' }] });
  await Promise.all([first, second]);
  secondCancel.resolve(); await stopSecond;
  assert.equal(errors.some(text => text.includes('old stop')), false);
  assert.deepEqual(output, []);
  assert.equal(errors.length, 2);
  assert.equal(controller.running, false);
});

test('repeated stop retries cancellation and a terminal refusal still drains the queue', async () => {
  const stopped = deferred(), cancelled = [], sent = [], errors = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { sent.push(text); return { agentId, runId: text }; },
    async status(_agentId, runId) { if (runId === 'first') await stopped.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'first' ? 'cancelled' : 'completed', text: '' }; },
    async cancel(...args) {
      cancelled.push(args);
      if (cancelled.length === 2) { stopped.resolve(); throw new Error('run_terminal: run is already terminal'); }
    }
  }), events({ onError(text) { errors.push(text); } }), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}); await tick();
  const second = controller.send('second', [], {});
  await controller.cancel();
  assert.equal(controller.queueLength, 1);
  await controller.cancel(); await Promise.all([first, second]);
  assert.deepEqual(cancelled, [['main-existing', 'first'], ['main-existing', 'first']]);
  assert.deepEqual(sent, ['first', 'second']);
  assert.equal(errors.some(text => /terminal/.test(text)), false);
});

test('completed run refuses cancellation without losing its final answer or the next queued input', async () => {
  const terminal = deferred(), output = [], sent = [];
  const controller = new ChatSessionController(runtime({
    async send(agent, text) { sent.push(text); return { agentId: agent, runId: text }; },
    async status(_agent, run) { if (run === 'already-complete') await terminal.promise; return { status: 'completed' }; },
    async result(_agent, run) { return { status: 'completed', text: run + ' result' }; },
    async cancel() { terminal.resolve(); throw new Error('run_terminal: already terminal'); }
  }), events({ onAssistantText: text => output.push(text) }), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('already-complete', [], {}); await tick();
  const second = controller.send('queued-next', [], {});
  await controller.cancel(); await Promise.all([first, second]);
  assert.deepEqual(sent, ['already-complete', 'queued-next']);
  assert.deepEqual(output, ['already-complete result', 'queued-next result']);
});

test('conversation reset requires an idle controller and preserves the Agent binding', async () => {
  const resets = [];
  const controller = new ChatSessionController(runtime({
    async resetConversation(agentId) {
      resets.push(agentId);
      return { conversationId: 'conversation-new', startedAt: '2026-09-19T00:00:00Z' };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  assert.equal(controller.conversationResetBlockedReason, undefined);
  assert.deepEqual(await controller.resetConversation(), {
    conversationId: 'conversation-new', startedAt: '2026-09-19T00:00:00Z'
  });
  assert.deepEqual(resets, ['main-existing']);

  const terminal = deferred();
  const busy = new ChatSessionController(runtime({
    async send(agentId) { return { agentId, runId: 'active-run' }; },
    async status() { await terminal.promise; return { status: 'completed' }; },
    async resetConversation() { throw new Error('must not reach runtime'); }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const active = busy.send('active', [], {});
  await tick();
  assert.match(busy.conversationResetBlockedReason, /current run/i);
  await assert.rejects(() => busy.resetConversation(), /current run/i);
  terminal.resolve();
  await active;
});

test('conversation reset serializes sends and cannot overtake an accepting send', async () => {
  const reset = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async resetConversation() { calls.push('reset'); return reset.promise; },
    async send(agentId, text) { calls.push(`send:${text}`); return { agentId, runId: text }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const resetting = controller.resetConversation();
  const afterReset = controller.send('after-reset', [], {});
  await tick();
  assert.deepEqual(calls, ['reset']);
  reset.resolve({ conversationId: 'conversation-next', startedAt: '2026-09-19T00:00:00Z' });
  await Promise.all([resetting, afterReset]);
  assert.deepEqual(calls, ['reset', 'send:after-reset']);

  const acceptance = deferred();
  const accepting = new ChatSessionController(runtime({
    async send(agentId) { return acceptance.promise.then(() => ({ agentId, runId: 'accepted' })); },
    async resetConversation() { throw new Error('must not reach runtime'); }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const sending = accepting.send('accepting', [], {});
  assert.match(accepting.conversationResetBlockedReason, /current run/i);
  await assert.rejects(() => accepting.resetConversation(), /current run/i);
  acceptance.resolve();
  await sending;
});

test('webview acceptance replay promotes exactly once and preserves queued image previews', async () => {
  const script = await readChatSource();
  const handler = script.slice(script.indexOf('      case "chat.started":'), script.indexOf('      case "queue.updated":'));
  const submissionHelper = script.slice(script.indexOf('  function submissionFromExecution('), script.indexOf('  function renderSubmission('));
  const context = {
    state: { pendingRequests: [{ id: 'one', execution: { taskMode: 'plan-work', businessMode: 'design', goal: false }, attachments: [{ name: 'input.png', previewUri: 'safe-preview' }] }], timeline: [] },
    message: { type: 'chat.started', id: 'one', text: 'request', attachments: [] },
    openSettingId: undefined,
    summarizeChildAgents: () => ({}), renderAll() {}, persist() {},
    timeline: { scrollTop: 0, scrollHeight: 1000 }, updateAutoScrollControl() {}, updateJumpToBottom() {}
  };
  const replay = () => runInNewContext(`${submissionHelper}
switch (message.type) { ${handler} }`, context);
  replay();
  assert.equal(context.state.timeline[0].submission.taskMode, 'plan-work');
  assert.equal(context.state.timeline[0].submission.businessMode, 'design');
  assert.equal(context.state.timeline[0].submission.goal, false);
  assert.equal(context.state.timeline[0].submission.guidance, undefined);
  const submission = { taskMode: 'plan-work', businessMode: 'design', goal: false, guidance: 'Actual dispatched guidance' };
  context.message.submission = submission;
  replay();
  replay();
  assert.deepEqual(context.state.timeline[0].submission, submission);
  assert.equal(context.state.timeline[0].text, 'request');
  assert.equal(context.state.timeline.length, 1);
  assert.equal(context.state.timeline[0].attachments[0].previewUri, 'safe-preview');
  assert.equal(context.state.pendingRequests.length, 0);
});

test('known failure drains a batch while an unacknowledged dispatch is never automatically repeated', async () => {
  const terminal = deferred(), sent = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) {
      sent.push(text);
      if (text.includes('unacknowledged')) throw new Error('acceptance response lost');
      return { agentId, runId: text };
    },
    async status(_agentId, runId) { if (runId === 'failed') await terminal.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'failed' ? 'failed' : 'completed', text: '' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('failed', [], {}); await tick();
  const second = controller.send('unacknowledged', [], {}, () => promoted.push('unacknowledged'));
  const third = controller.send('third', [], {}, () => promoted.push('third'));
  terminal.resolve(); await Promise.all([first, second, third]);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /unacknowledged/);
  assert.match(sent[1], /third/);
  assert.equal(controller.queueLength, 0);
  assert.deepEqual(promoted, []);
  await controller.reconnect();
  assert.equal(sent.length, 2);
  assert.deepEqual(promoted, []);
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

test('batch permissions intersect explicit policies and never combine unknown inheritance with explicit authority', async () => {
  for (const [modes, expected] of [
    [['bypass', 'danger-full-access'], 'danger-full-access'],
    [['bypass', 'workspace-write'], 'workspace-write'],
    [['workspace-write', 'bypass'], 'workspace-write'],
    [[undefined, 'cli-default'], undefined],
    [[undefined, 'workspace-write'], 'rejected'],
    [['bypass', 'cli-default'], 'rejected']
  ]) {
    const terminal = deferred(), calls = [], promoted = [], errors = [];
    const controller = new ChatSessionController(runtime({
      async send(agentId, text, options) { calls.push({ text, options }); return { agentId, runId: calls.length === 1 ? 'active' : 'batch' }; },
      async status(_agentId, runId) { if (runId === 'active') await terminal.promise; return { status: 'completed' }; }
    }), events({ onError(error) { errors.push(error); } }), 'main-existing', { pollIntervalMs: 0 });
    const active = controller.send('active', [], {}); await tick();
    const first = controller.send('first', [], { executionMode: modes[0] }, () => promoted.push('first'));
    const second = controller.send('second', [], { executionMode: modes[1] }, () => promoted.push('second'));
    terminal.resolve(); await Promise.all([active, first, second]);
    if (expected === 'rejected') {
      assert.equal(calls.length, 1);
      assert.deepEqual(promoted, []);
      assert.match(errors[0], /inherited and explicit permissions/);
    } else {
      assert.equal(calls.length, 2);
      assert.equal(calls[1].options.executionMode, expected);
      assert.deepEqual(promoted, ['first', 'second']);
      assert.deepEqual(errors, []);
    }
    assert.equal(controller.queueLength, 0);
  }
});

test('batching cannot transfer a human actor or verification target between original requests', async () => {
  for (const field of ['actor', 'verifiedWorkRunId']) {
    const terminal = deferred(), calls = [], promoted = [], errors = [];
    const controller = new ChatSessionController(runtime({
      async send(agentId, text) { calls.push(text); return { agentId, runId: 'active' }; },
      async status() { await terminal.promise; return { status: 'completed' }; }
    }), events({ onError(error) { errors.push(error); } }), 'main-existing', { pollIntervalMs: 0 });
    const active = controller.send('active', [], {}); await tick();
    const first = controller.send('first', [], {}, () => promoted.push('first'));
    const second = controller.send('second', [], { [field]: field === 'actor' ? 'human' : 'verified-other' }, () => promoted.push('second'));
    terminal.resolve(); await Promise.all([active, first, second]);
    assert.deepEqual(calls, ['active']);
    assert.deepEqual(promoted, []);
    assert.match(errors[0], /execution owners or verification targets/);
  }
});

test('batch includes all prepared images and preserves attachment-only message boundaries', async () => {
  const terminal = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options, images) { calls.push({ text, options, images }); return { agentId, runId: calls.length === 1 ? 'active' : 'batch' }; },
    async status(_agentId, runId) { if (runId === 'active') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const active = controller.send('active', [], {}); await tick();
  const image = name => ({ id: name, name, kind: 'image', uri: `file:///tmp/${name}`, mediaType: 'image/png' });
  const options = { model: 'first-model', reasoningEffort: 'high', fast: true, goalMode: true, goalObjective: 'shared' };
  const first = controller.send('', [image('one.png')], options);
  const second = controller.send('second text', [image('two.png'), { id: 'file', kind: 'file', name: 'notes.md', uri: 'file:///tmp/notes.md' }], { ...options, model: 'later-model' });
  terminal.resolve(); await Promise.all([active, first, second]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].images.map(image => image.path), ['/tmp/one.png', '/tmp/two.png']);
  assert.match(calls[1].text, /대기 메시지 1 시작 ---[\s\S]*one\.png[\s\S]*대기 메시지 1 끝/);
  assert.match(calls[1].text, /대기 메시지 2 시작 ---\nsecond text[\s\S]*notes\.md/);
  assert.equal(calls[1].options.model, 'first-model');
  assert.equal(calls[1].options.goalMode, true);
  assert.equal(calls[1].options.goalObjective, 'shared');
});

test('discovery failure retains original batch members for a single later dispatch', async () => {
  const discovery = deferred(), calls = [], promoted = [];
  let firstDiscovery = true;
  const controller = new ChatSessionController(runtime({
    async activeRun() { if (firstDiscovery) { firstDiscovery = false; await discovery.promise; throw new Error('offline'); } },
    async send(agentId, text) { calls.push(text); return { agentId, runId: 'batch' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], {}, () => promoted.push('first'));
  const second = controller.send('second', [], {}, () => promoted.push('second'));
  discovery.resolve(); await tick();
  assert.equal(controller.queueLength, 2);
  assert.deepEqual(calls, []);
  assert.deepEqual(promoted, []);
  await controller.reconnect(); await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].indexOf('first') < calls[0].indexOf('second'));
  assert.deepEqual(promoted, ['first', 'second']);
});

test('batch drain waits for already received attachment preparation before taking its snapshot', async () => {
  const terminal = deferred(), preparation = deferred(), calls = [];
  let preparing = false;
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { calls.push(text); return { agentId, runId: calls.length === 1 ? 'active' : 'batch' }; },
    async status(_agentId, runId) { if (runId === 'active') await terminal.promise; return { status: 'completed' }; }
  }), events({ async onBeforeQueueDrain() { if (preparing) await preparation.promise; } }), 'main-existing', { pollIntervalMs: 0 });
  const active = controller.send('active', [], {}); await tick();
  const first = controller.send('ready', [], {});
  preparing = true;
  terminal.resolve(); await tick();
  assert.deepEqual(calls, ['active']);
  const second = controller.send('prepared image', [{ id: 'image', name: 'image.png', kind: 'image', uri: 'file:///tmp/image.png', mediaType: 'image/png' }], {});
  preparation.resolve(); await Promise.all([active, first, second]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /ready[\s\S]*prepared image/);
});


test('workflow guidance follows each queued snapshot and Normal preserves ordinary requests', async () => {
  const terminal = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, execution) {
      calls.push({ text, execution });
      return { agentId, runId: calls.length === 1 ? 'first' : 'batch' };
    },
    async status(_agentId, runId) {
      if (runId === 'first') await terminal.promise;
      return { status: 'completed' };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('ordinary', [], { taskMode: 'work', businessMode: 'normal' });
  await tick();
  const options = { taskMode: 'work', businessMode: 'interview' };
  const interview = controller.send('Interview text', [], options);
  const design = controller.send('Design text', [], { taskMode: 'work', businessMode: 'design' });
  options.businessMode = 'planning';
  terminal.resolve();
  await Promise.all([first, interview, design]);
  assert.match(calls[0].text, /^ordinary(?:\n|$)/);
  assert.equal(calls[1].execution.taskMode, 'work');
  assert.equal(calls[1].execution.businessMode, 'normal');
  assert.equal((calls[1].text.match(/Workflow guidance for this message only:/g) || []).length, 2);
  assert.match(calls[1].text, /Interview text[\s\S]*message only: interview[\s\S]*Design text[\s\S]*message only: design/);
  assert.doesNotMatch(calls[1].text, /message only: planning/);
  assert.match(calls[1].text, /Document skill's current document contract/);
  assert.match(calls[1].text, /non-authoritative Refined documents/);
  assert.match(calls[1].text, /canonical paths and package format/);
  assert.match(calls[1].text, /docs\/skills\//);
  assert.doesNotMatch(calls[1].text, /docs\/specification\/|index\.html|Write BOTH/);
  assert.match(calls[1].text, /SKILL\.md/);
});

test('new sessions receive Planning guidance while retaining original promotion callbacks', async () => {
  const calls = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async submit(agentId, text, execution) {
      calls.push({ text, execution });
      return { agentId, runId: 'new-run' };
    }
  }), events(), undefined, { pollIntervalMs: 0 });
  await controller.send('Plan this feature', [], { taskMode: 'work', businessMode: 'planning' }, () => promoted.push('Plan this feature'));
  assert.match(calls[0].text, /^Plan this feature[\s\S]*\[Workflow guidance for this message only: planning\]/);
  assert.equal(calls[0].execution.taskMode, 'work');
  assert.deepEqual(promoted, ['Plan this feature']);
});


test('inspection snapshots are dispatched separately from queued implementation', async () => {
  const terminal = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, execution) {
      calls.push({ text, execution });
      return { agentId, runId: calls.length === 1 ? 'first' : `run-${calls.length}` };
    },
    async status(_agentId, runId) {
      if (runId === 'first') await terminal.promise;
      return { status: 'completed' };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('first', [], { taskMode: 'work' });
  await tick();
  const inspection = { taskMode: 'direct', inspectionOnly: true, businessMode: 'design' };
  const second = controller.send('Inspect existing changes', [], inspection);
  const third = controller.send('Implement later', [], { taskMode: 'work' });
  inspection.inspectionOnly = false;
  terminal.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].execution.taskMode, 'direct');
  assert.match(calls[1].text, /^Inspect existing changes/);
  assert.match(calls[1].text, /standalone inspection by Main/);
  assert.match(calls[1].text, /Do not implement repairs/);
  assert.doesNotMatch(calls[1].text, /Workflow guidance|Implement later/);
  assert.equal(calls[2].execution.taskMode, 'work');
  assert.match(calls[2].text, /^Implement later\n/);
});

test('inspection decision continuation retains its captured settings over current composer settings', async () => {
  const calls = [], resumed = deferred();
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, execution) {
      calls.push({ text, execution });
      if (calls.length === 2) resumed.resolve();
      return { agentId, runId: calls.length === 1 ? 'inspection' : 'answer' };
    },
    async result(_agentId, runId) {
      return { status: runId === 'inspection' ? 'needs-human-decision' : 'completed', text: 'Approve inspection proposal', decisionKind: runId === 'inspection' ? 'approval' : undefined };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const original = { taskMode: 'direct', inspectionOnly: true, businessMode: 'design',
    agentModels: { work: { model: 'captured-worker' } }, agentPermissions: { work: 'workspace-write' } };
  await controller.send('Inspect', [], original);
  assert.equal(controller.approveDecision('inspection', { taskMode: 'work', inspectionOnly: false, businessMode: 'planning',
    agentModels: { work: { model: 'composer-worker' } }, agentPermissions: { work: 'danger-full-access' },
    goalMode: true, goalObjective: 'Implement from UI', model: 'current-main' }), true);
  await resumed.promise;
  assert.equal(calls[1].execution.taskMode, 'direct');
  assert.equal(calls[1].execution.inspectionOnly, true);
  assert.equal(calls[1].execution.businessMode, 'design');
  assert.deepEqual(calls[1].execution.agentModels, original.agentModels);
  assert.deepEqual(calls[1].execution.agentPermissions, original.agentPermissions);
  assert.equal(calls[1].execution.model, 'current-main');
  assert.equal(calls[1].execution.goalMode, false);
  assert.equal(Object.hasOwn(calls[1].execution, 'goalObjective'), false);
  assert.match(calls[1].text, /Do not implement repairs/);
});


test('inspection dispatch suppresses Goal for both new and existing sessions without mutating input', async () => {
  for (const agentId of [undefined, 'main-existing']) {
    const calls = [];
    const accept = async (id, text, execution) => {
      calls.push({ text, execution });
      return { agentId: id, runId: 'inspection' };
    };
    const controller = new ChatSessionController(runtime({ submit: accept, send: accept }), events(), agentId, { pollIntervalMs: 0 });
    const execution = { taskMode: 'direct', inspectionOnly: true, goalMode: true, goalObjective: 'Old implementation objective' };
    await controller.send('Inspect existing changes', [], execution);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].execution.goalMode, false);
    assert.equal(Object.hasOwn(calls[0].execution, 'goalObjective'), false);
    assert.equal(calls[0].execution.taskMode, 'direct');
    assert.equal(execution.goalMode, true);
    assert.equal(execution.goalObjective, 'Old implementation objective');
  }
});


test('controller forwards the composer objective independently of workflow and attachments', async () => {
  for (const agentId of [undefined, 'main-existing']) {
    const calls = [];
    const accept = async (id, text, execution) => {
      calls.push({ text, execution });
      return { agentId: id, runId: 'composer-goal' };
    };
    const controller = new ChatSessionController(runtime({ send: accept, submit: accept }), events(), agentId, { pollIntervalMs: 0 });
    await controller.send('Current composer goal', [{ kind: 'file', name: 'notes.txt', uri: 'file:///tmp/notes.txt' }], {
      goalMode: true, goalObjective: 'Current composer goal', businessMode: 'design'
    });
    assert.equal(calls[0].execution.goalObjective, 'Current composer goal');
    assert.equal(calls[0].execution.goalMode, true);
    assert.ok(calls[0].text.includes('Current composer goal'));
    assert.notEqual(calls[0].text, calls[0].execution.goalObjective);
    controller.dispose();
  }
});


test('all message actions retain queue identity and cannot merge across routes', async () => {
  const terminal = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, execution) { calls.push({ text, execution }); return { agentId, runId: text }; },
    async status(_agentId, runId) { if (runId === 'holding') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const holding = controller.send('holding', [], {});
  await tick();
  const actions = ['work', 'plan', 'verification', 'plan-work', 'work-verification', 'plan-work-verification', 'direct'];
  const pending = actions.map(taskMode => controller.send(taskMode, [], { taskMode }));
  terminal.resolve();
  await Promise.all([holding, ...pending]);
  assert.deepEqual(calls.slice(1).map(call => call.execution.taskMode), actions);
  assert.deepEqual(calls.slice(1).map(call => call.text.split('\n')[0]), actions);
});

test('direct requests omit delegated instructions while managed routes retain model overrides', async () => {
  const calls = [], accepted = [];
  const agentModels = { work: { model: 'worker-one' }, verification: { model: 'review-two' } };
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options) { calls.push({ text, options }); return { agentId, runId: String(calls.length) }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const modes = [undefined, 'direct', 'work', 'plan', 'verification', 'plan-work', 'work-verification', 'plan-work-verification'];
  for (const taskMode of modes) {
    await controller.send('Hello', [], { taskMode, agentModels }, value => accepted.push(value));
    const call = calls.at(-1), submission = accepted.at(-1);
    assert.deepEqual(call.options.agentModels, agentModels);
    if (!taskMode || taskMode === 'direct') {
      assert.equal(call.text, 'Hello');
      assert.equal(submission.guidance, '');
    } else {
      assert.match(call.text, /\[Delegated agent model settings for this request\]/);
      assert.ok(call.text.includes(JSON.stringify(agentModels)));
      assert.equal(call.text, 'Hello' + submission.guidance);
    }
  }
});

test('delegated role settings stay separate across queued dispatches and reach Main guidance', async () => {
  const calls = [], terminal = deferred();
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options) { calls.push({ text, options }); return { agentId, runId: String(calls.length) }; },
    async status(_agentId, runId) { if (runId === '1') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('active', [], {});
  await tick();
  const one = { work: { model: 'worker-one', reasoningEffort: 'high' } };
  const two = { verification: { model: 'review-two', reasoningEffort: 'low' } };
  const second = controller.send('second', [], { taskMode: 'work', agentModels: one });
  const third = controller.send('third', [], { taskMode: 'work', agentModels: two });
  terminal.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls.length, 3);
  assert.match(calls[1].text, /worker-one/);
  assert.doesNotMatch(calls[1].text, /review-two/);
  assert.match(calls[2].text, /review-two/);
  assert.match(calls[1].text, /--work-reasoning-effort/);
});


test('queued one-shot goals stay separate from ordinary sends and different goals', async () => {
  const terminal = deferred(), calls = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options) { calls.push({ text, options }); return { agentId, runId: calls.length === 1 ? 'active' : text }; },
    async status(_agentId, runId) { if (runId === 'active') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const active = controller.send('active', [], {}); await tick();
  const first = controller.send('goal one', [], { goalMode: true, goalObjective: 'one' });
  const second = controller.send('goal two', [], { goalMode: true, goalObjective: 'two' });
  const normal = controller.send('ordinary', [], { goalMode: false });
  terminal.resolve(); await Promise.all([active, first, second, normal]);
  assert.deepEqual(calls.map(call => call.text), ['active', 'goal one', 'goal two', 'ordinary']);
  assert.equal(calls[1].options.goalObjective, 'one');
  assert.equal(calls[2].options.goalObjective, 'two');
  assert.equal(calls[1].options.goalMode, true);
  assert.equal(calls[2].options.goalMode, true);
  assert.equal(calls[3].options.goalMode, false);
  assert.equal(calls[3].options.goalObjective, undefined);
});


test('accepted submission captures exact guidance and original per-message intent across a queued batch', async () => {
  const terminal = deferred(), calls = [], accepted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { calls.push(text); return { agentId, runId: calls.length === 1 ? 'first' : 'batch' }; },
    async status(_agentId, runId) { if (runId === 'first') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('ordinary', [], {}, value => accepted.push(value));
  await tick();
  const settings = { work: { model: 'worker-exact', reasoningEffort: 'high', fast: true } };
  const options = { taskMode: 'plan-work', businessMode: 'interview', agentModels: settings };
  const second = controller.send('Original interview', [{ id: 'file', kind: 'file', name: 'notes.md', uri: 'file:///tmp/notes.md' }], options, value => accepted.push(value));
  const third = controller.send('Original design', [], { taskMode: 'plan-work', businessMode: 'design', agentModels: settings }, value => accepted.push(value));
  options.businessMode = 'normal';
  terminal.resolve();
  await Promise.all([first, second, third]);
  const { runId, acceptedAt, ...firstIntent } = accepted[0];
  assert.deepEqual(firstIntent, { taskMode: 'direct', businessMode: 'normal', goal: false, guidance: '' });
  assert.equal(runId, 'first');
  assert.ok(Number.isFinite(Date.parse(acceptedAt)));
  assert.equal(accepted[1].businessMode, 'interview');
  assert.equal(accepted[2].businessMode, 'design');
  assert.equal(accepted[1].taskMode, 'plan-work');
  for (const submission of accepted.slice(1)) {
    assert.equal(submission.runId, 'batch', 'Every queued input keeps the accepted batch identity');
    assert.ok(Number.isFinite(Date.parse(submission.acceptedAt)));
    assert.match(submission.guidance, /worker-exact/);
    const common = submission.guidance.indexOf('\n\n[Conversation-based background workflow]');
    assert.ok(common > 0);
    assert.ok(calls[1].includes(submission.guidance.slice(0, common)));
    assert.ok(calls[1].startsWith(submission.guidance.slice(common)));
  }
  assert.equal(calls[1].split('[Delegated agent model settings for this request]').length - 1, 1);
  assert.equal(calls[1].split('worker-exact').length - 1, 1);
  assert.equal(calls[1].split('file:///tmp/notes.md').length - 1, 1);
  assert.equal(calls[1].split('[Workflow guidance for this message only:').length - 1, 2);
});

test('single dispatch acknowledges exact application suffix and effective Goal/Verification metadata', async () => {
  const calls = [], accepted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { calls.push(text); return { agentId, runId: 'run' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  await controller.send('  Original goal  ', [], { goalMode: true, goalObjective: 'Original goal', businessMode: 'planning', agentModels: { work: { model: 'test-model' } } }, value => accepted.push(value));
  assert.equal(calls[0], '  Original goal  ' + accepted[0].guidance);
  assert.equal(accepted[0].goal, true);
  await controller.send('Inspect', [], { taskMode: 'verification', businessMode: 'design', goalMode: true }, value => accepted.push(value));
  assert.equal(accepted[1].taskMode, 'verification');
  assert.equal(accepted[1].businessMode, 'normal');
  assert.equal(accepted[1].goal, false);
  assert.equal(calls[1], 'Inspect' + accepted[1].guidance);
});

test('role permissions stay captured and prevent queue merging', async () => {
  const calls = [], terminal = deferred();
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options) { calls.push({ text, options }); return { agentId, runId: String(calls.length) }; },
    async status(_agentId, runId) { if (runId === '1') await terminal.promise; return { status: 'completed' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('active', [], {});
  await tick();
  const one = { work: 'workspace-write' };
  const two = { work: 'bypass' };
  const second = controller.send('second', [], { taskMode: 'work', agentPermissions: one });
  const third = controller.send('third', [], { taskMode: 'work', agentPermissions: two });
  terminal.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls.length, 3);
  assert.match(calls[1].text, /workspace-write/);
  assert.deepEqual(calls[1].options.agentPermissions, one);
  assert.deepEqual(calls[2].options.agentPermissions, two);
  assert.match(calls[2].text, /bypass/);
  assert.match(calls[1].text, /--work-execution-mode/);
});


test('Main answers a new question with background identities after workflow acceptance', async () => {
  const calls = [];
  const children = [{ agentId: 'work-background', runId: 'work-run', role: 'work', status: 'running' },
    ...['completed', 'cancelled', 'failed'].map(status => ({ agentId: `past-${status}`, runId: 'past-run', role: 'work', status })),
    { agentId: 'old-decision', runId: 'old-run', role: 'work', status: 'needs-human-decision', currentConversation: false },
    { agentId: 'current-decision', runId: 'decision-run', role: 'work', status: 'needs-human-decision', currentConversation: true }];
  const controller = new ChatSessionController(runtime({
    async listChildSessions() { return children; },
    async send(agentId, text, execution) { calls.push({ text, execution }); return { agentId, runId: `main-${calls.length}` }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  await controller.send('Execute the agreed workflow', [], { taskMode: 'work' });
  assert.match(calls[0].text, /finish this Main turn promptly/);
  assert.equal(controller.running, false);
  await controller.send('What does this setting mean?', [], { taskMode: 'direct' });
  assert.equal(calls[1].execution.taskMode, 'direct');
  assert.match(calls[1].text, /work-background/);
  assert.match(calls[1].text, /without cancelling/);
  assert.match(calls[1].text, /current-decision/);
  assert.doesNotMatch(calls[1].text, /past-|old-decision/);
  children.splice(0, children.length, { agentId: 'done-history', role: 'work', status: 'completed' });
  await controller.send('Another question', [], { taskMode: 'direct' });
  assert.doesNotMatch(calls[2].text, /Background workflow status/);
});

for (const decisionKind of [undefined, 'clarification']) {
  test(`non-approval decision ${decisionKind} rejects approve and accepts direct answer`, async () => {
    const sent = [], decisions = [];
    const controller = new ChatSessionController(runtime({
      async send(agentId, text) { sent.push(text); return { agentId, runId: sent.length === 1 ? 'question' : 'answer' }; },
      async result(_agentId, runId) { return { status: runId === 'question' ? 'needs-human-decision' : 'completed', text: 'Which target?', decisionKind: runId === 'question' ? decisionKind : undefined }; }
    }), { ...events(), onDecision: (...args) => decisions.push(args) }, 'main-existing', { pollIntervalMs: 0 });
    await controller.send('Investigate', [], {});
    assert.equal(controller.approveDecision('question', {}), false);
    assert.equal(sent.length, 1);
    assert.deepEqual(decisions.at(-1), ['question', false]);
    await controller.send('Target A', [], {});
    assert.equal(sent.length, 2);
  });
}

test('reset refreshes uncertain Goal once, awaits recovery and keeps concurrent sends behind reset', async () => {
  const terminal = deferred();
  const calls = [];
  let resets = 0;
  const controller = new ChatSessionController(runtime({
    async resetConversation() {
      calls.push('reset');
      if (++resets === 1) throw new Error('goal_state_uncertain: Refresh or resolve the uncertain Goal state before clearing the conversation');
      return { conversationId: 'conversation-new', startedAt: 'now' };
    },
    async goal(agent, action) { calls.push(action); return { accepted: { agentId: agent, runId: 'refresh-run' } }; },
    async status(_agent, run) { if (run === 'refresh-run') await terminal.promise; return { status: 'completed' }; },
    async send(agentId, text) { calls.push('send'); return { agentId, runId: text }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const reset = controller.resetConversation();
  await tick();
  await assert.rejects(controller.resetConversation());
  const send = controller.send('next', [], {});
  await tick();
  assert.deepEqual(calls, ['reset', 'refresh']);
  terminal.resolve();
  assert.equal((await reset).conversationId, 'conversation-new');
  await send;
  assert.deepEqual(calls, ['reset', 'refresh', 'reset', 'send']);
});

test('reset preserves runtime refusal after refresh and does not retry unrelated failures', async () => {
  for (const failure of ['session_busy', 'transport disconnected', 'goal_state_uncertain']) {
    let resets = 0, refreshes = 0;
    const controller = new ChatSessionController(runtime({
      async resetConversation() { resets++; throw new Error(resets === 1 ? failure : 'goal_active'); },
      async goal() { refreshes++; return { goal: { status: 'active' } }; }
    }), events(), 'main-existing');
    await assert.rejects(controller.resetConversation(), new RegExp(failure === 'goal_state_uncertain' ? 'goal_active' : failure));
    assert.equal(refreshes, failure === 'goal_state_uncertain' ? 1 : 0);
    assert.equal(resets, failure === 'goal_state_uncertain' ? 2 : 1);
    assert.equal(controller.conversationResetBlockedReason, undefined);
  }
});


test('confirmation protocol validates request identities and retains legacy ready messages', async () => {
  const { importTypeScript } = await import('../support/import-typescript.mjs');
  const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
  for (const message of [{ type: 'client.ready' }, { type: 'client.ready', pendingMessageIds: ['first', 'second'] }, { type: 'chat.status', ids: ['first', 'second'] }]) {
    assert.deepEqual(parseClientMessage(message), message);
  }
  for (const value of [null, [null], [''], ['x'.repeat(129)], 'first']) {
    assert.equal(parseClientMessage({ type: 'chat.status', ids: value }), undefined);
    assert.equal(parseClientMessage({ type: 'client.ready', pendingMessageIds: value }), undefined);
  }
});


test('Maestro selection preserves originals and separates normal queued inputs without changing execution authority', async () => {
  const terminal = deferred(), calls = [], accepted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, options) { calls.push({agentId, text, options}); return {agentId, runId: String(calls.length)}; },
    async status(_agent, runId) { if (runId === '1') await terminal.promise; return {status: 'completed'}; }
  }), events(), 'same-main', {pollIntervalMs: 0});
  const first = controller.send('running original', [], {}); await tick();
  const settings = {taskMode: 'orchestrate', businessMode: 'maestro', model: 'designated-model', fast: false, executionMode: 'workspace-write', messageId: 'message-exact', receivedAt: '2026-10-07T20:00:00Z'};
  const second = controller.send('Maestro exact original', [], settings, value => accepted.push(value));
  const third = controller.send('normal later original', [], {...settings, businessMode: 'normal', messageId: 'message-next'}, value => accepted.push(value));
  settings.businessMode = 'normal'; terminal.resolve(); await Promise.all([first,second,third]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(value => value.agentId === 'same-main'));
  assert.match(calls[1].text, /Maestro exact original/);
  assert.match(calls[1].text, /Message reference: message-exact/);
  assert.equal(calls[1].options.taskMode, 'orchestrate');
  assert.equal(calls[1].options.model, 'designated-model');
  assert.equal(calls[1].options.executionMode, 'workspace-write');
  assert.equal(calls[1].options.fast, false);
  assert.equal(accepted[0].businessMode, 'maestro');
  assert.equal(accepted[1].businessMode, 'normal');
  assert.equal(controller.queueLength, 0);
});
