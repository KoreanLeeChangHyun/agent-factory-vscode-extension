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
  const fourth = controller.send('fourth', [], {}, () => promoted.push('fourth'));
  assert.equal(controller.queueLength, 1);
  acceptance.resolve(); await Promise.all([first, second, third, fourth]);
  assert.deepEqual(promoted, ['first', 'second', 'third', 'fourth']);
  assert.equal(calls.length, 3);
  assert.match(calls[1].text, /대기 메시지 2 시작 ---\nthird/);
  assert.equal(calls[2].text, 'fourth');
  assert.equal(calls[1].options.goalMode, false);
  assert.equal(calls[1].options.model, 'original');
  assert.equal(calls[1].options.taskMode, 'work-verification');
  assert.equal(calls[1].options.executionMode, 'workspace-write');
  assert.equal(calls[1].images[0].path, '/tmp/original.png');
  assert.equal(controller.queueLength, 0);
});

test('decision-required pauses batching until an explicit answer is accepted', async () => {
  const terminal = deferred(), sent = [], promoted = [];
  const controller = new ChatSessionController(runtime({
    async send(agentId, text) { sent.push(text); return { agentId, runId: text === 'proposal' ? 'proposal' : 'next' }; },
    async status(_agentId, runId) { if (runId === 'proposal') await terminal.promise; return { status: 'completed' }; },
    async result(_agentId, runId) { return { status: runId === 'proposal' ? 'needs-human-decision' : 'completed', text: 'result' }; }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  const first = controller.send('proposal', [], { taskMode: 'work' });
  await tick();
  const second = controller.send('queued', [], {}, () => promoted.push('queued'));
  const third = controller.send('also queued', [], {}, () => promoted.push('also queued'));
  terminal.resolve(); await first;
  assert.equal(controller.queueLength, 2);
  assert.deepEqual(sent, ['proposal']);
  assert.deepEqual(promoted, []);
  assert.equal(controller.approveDecision('proposal', {}), true);
  await Promise.all([second, third]);
  assert.equal(sent.length, 3);
  assert.match(sent[1], /제안한 범위/);
  assert.match(sent[2], /대기 메시지 1 시작 ---\nqueued/);
  assert.match(sent[2], /대기 메시지 2 시작 ---\nalso queued/);
  assert.deepEqual(promoted, ['queued', 'also queued']);
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
  assert.equal(calls[0].text, 'ordinary');
  assert.equal(calls[1].execution.taskMode, 'work');
  assert.equal(calls[1].execution.businessMode, 'normal');
  assert.equal((calls[1].text.match(/Workflow guidance for this message only:/g) || []).length, 2);
  assert.match(calls[1].text, /Interview text[\s\S]*message only: interview[\s\S]*Design text[\s\S]*message only: design/);
  assert.doesNotMatch(calls[1].text, /message only: planning/);
  assert.match(calls[1].text, /docs\/processed\//);
  assert.match(calls[1].text, /index\.html/);
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
  assert.match(calls[0].text, /^Plan this feature\n\n\[Workflow guidance for this message only: planning\]/);
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
  assert.equal(calls[2].text, 'Implement later');
});

test('inspection decision continuation retains its original constraints', async () => {
  const calls = [], resumed = deferred();
  const controller = new ChatSessionController(runtime({
    async send(agentId, text, execution) {
      calls.push({ text, execution });
      if (calls.length === 2) resumed.resolve();
      return { agentId, runId: calls.length === 1 ? 'inspection' : 'answer' };
    },
    async result(_agentId, runId) {
      return { status: runId === 'inspection' ? 'needs-human-decision' : 'completed', text: 'Select target' };
    }
  }), events(), 'main-existing', { pollIntervalMs: 0 });
  await controller.send('Inspect', [], { taskMode: 'direct', inspectionOnly: true });
  assert.equal(controller.approveDecision('inspection', { taskMode: 'work', inspectionOnly: false, goalMode: true, goalObjective: 'Implement from UI' }), true);
  await resumed.promise;
  assert.equal(calls[1].execution.taskMode, 'direct');
  assert.equal(calls[1].execution.inspectionOnly, true);
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
