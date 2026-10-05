import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatSource, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";

const source = await readChatSource();
const indexSource = source.slice(source.indexOf('  function indexedTimeline()'), source.indexOf('  function upsertActivity('));
const aggregation = source.slice(source.indexOf('  function currentTaskFlows() {'), source.indexOf('  function liveTaskStatus('));

test('task-flow aggregation reuses unchanged histories and invalidates all input replacements', () => {
  let parses = 0;
  const state = { timeline: Array.from({ length: 10000 }, (_, id) => ({ type: 'assistant', text: String(id) })), taskFlows: [], childAgents: [], workflows: [] };
  const context = { state, taskFlowParseCache: new WeakMap(), timelineIndexes: new WeakMap(), nextTimelineIndex: 0, extractTaskFlows(text) { parses++; return { flows: [{ id: 'flow', title: text, tasks: [] }] }; }, acceptedTaskAgent: () => true, t: () => 'Verification' };
  runInNewContext('let taskFlowSnapshot;\n' + indexSource + aggregation + '\nglobalThis.getFlows = currentTaskFlows;', context);
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

const dismissal = source.slice(source.indexOf('  function taskDismissKey('), source.indexOf('  function taskStopKey('));
const stage = (id, run = 'run-one', extra = {}) => ({ id, title: id, agentId: 'worker', runId: run, status: 'running', ...extra });
const flow = (id, tasks, extra = {}) => ({ id, tasks, ...extra });
function dismissView(state) {
  const context = { state, t: key => key, renders: 0, saves: 0,
    renderWorkLoopPanel() { context.renders++; }, persist() { context.saves++; },
    document: { createElement() { return { append() {}, setAttribute() {}, addEventListener(_name, handler) { this.click = handler; } }; },
      createElementNS() { return { append() {}, setAttribute() {} }; } } };
  runInNewContext(dismissal, context);
  return context;
}

test('dismissal changes only the selected list entry and persists without runtime messages', () => {
  const flows = [flow('one', [stage('same')]), flow('two', [stage('same')])];
  const state = { role: 'main', childAgents: [{ agentId: 'worker', runId: 'run-one', status: 'running' }], taskFlows: flows };
  const before = JSON.stringify(state);
  const ctx = dismissView(state);
  const button = ctx.createTaskDismiss(flows[0], flows[0].tasks);
  button.click({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(Array.from(ctx.visibleTaskFlows(flows), item => item.id), ['two']);
  assert.equal(ctx.renders, 1); assert.equal(ctx.saves, 1);
  const { dismissedTasks, ...untouched } = state;
  assert.equal(JSON.stringify(untouched), before, 'run state, task data and other entries are preserved');
  button.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(state.dismissedTasks.length, 1, 'duplicate clicks are idempotent');
  const restored = dismissView(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(Array.from(restored.visibleTaskFlows(flows), item => item.id), ['two']);
  const completed = flows.map(item => ({ ...item, tasks: item.tasks.map(task => ({ ...task, status: 'completed' })) }));
  assert.deepEqual(Array.from(restored.visibleTaskFlows(completed), item => item.id), ['two']);
  assert.deepEqual(Array.from(restored.visibleTaskFlows([flow('one', [stage('same', 'new-run')])]), item => item.id), ['one']);
});

test('loop dismissal survives revisions while preserving other tasks and separate loops', () => {
  const tasks = [stage('work-stage', 'run-one', { taskId: 'same', sessionRole: 'work' }),
    stage('verify-stage', 'verify-one', { taskId: 'same', sessionRole: 'verification' }), stage('other')];
  const original = flow('workflow', tasks, { loopId: 'loop-one', workAgentId: 'worker', pause: { taskId: 'same' } });
  const ctx = dismissView({ dismissedTasks: [] });
  ctx.state.dismissedTasks = [ctx.taskDismissKey(original, tasks.slice(0, 2))];
  const revised = { ...original, tasks: tasks.map(task => ({ ...task, runId: 'revision-two', status: 'completed' })) };
  const visible = ctx.visibleTaskFlows([revised]);
  assert.deepEqual(Array.from(visible[0].tasks, task => task.id), ['other']);
  assert.equal(visible[0].originalTaskCount, 2, 'hiding a task must not enable unsupported per-task Loop stop');
  assert.equal(visible[0].pause, undefined, 'a hidden task does not keep its decision controls visible');
  assert.equal(ctx.visibleTaskFlows([{ ...revised, loopId: 'loop-two' }])[0].tasks.length, 3);
  assert.equal(ctx.visibleTaskFlows([{ ...revised, id: 'other-workflow' }])[0].tasks.length, 3);
  assert.equal(original.tasks.length, 3, 'source history retains both stages');
});

const slotSource = source.slice(source.indexOf('  function liveTaskStatus('), source.indexOf('  function summarizeTaskFlow('))
  + source.slice(source.indexOf('  function taskDismissKey('), source.indexOf('  function finishTaskStop('));
function slotView(state) {
  const element = tag => ({ tag, className: '', dataset: {}, attributes: {}, children: [],
    get childElementCount() { return this.children.length; },
    append(...children) { this.children.push(...children); }, setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(_name, handler) { this.click = handler; } });
  const sent = [];
  const context = { state, t: key => key, persist() {}, renderWorkLoopPanel() {}, vscode: { postMessage: message => sent.push(message) },
    taskStopsPending: new Set(), taskStopErrors: new Map(), document: { createElement: element, createElementNS: (_ns, tag) => element(tag) } };
  runInNewContext(slotSource, context);
  const slot = (flow, stages, rowStages) => {
    const row = element('summary');
    flow = { tasks: stages, ...flow };
    context.appendTaskAction(row, flow, stages, true, rowStages);
    const controls = row.children[0];
    return { row, controls, buttons: controls ? controls.children.filter(child => child.tag === 'button').map(button => button.className) : [] };
  };
  return { context, sent, slot };
}

test('stop and delete share one slot: active tasks offer only stop, ended tasks only delete', () => {
  const state = { role: 'main', childAgents: [{ agentId: 'worker', runId: 'run-one', role: 'work', status: 'running' }] };
  const { context, sent, slot } = slotView(state);
  const task = status => ({ id: 'task', title: 'Task', agentId: 'worker', runId: 'run-one', status });
  for (const status of ['pending', 'running', 'verifying', 'blocked']) {
    if (status === 'blocked') state.childAgents[0].status = 'needs-human-decision';
    const view = slot({ id: 'flow' }, [task(status)]);
    assert.deepEqual(view.buttons, ['task-flow-stop task-flow-icon-button'], status + ' task shows only stop');
    assert.equal(view.controls.className, 'task-flow-stop-controls');
  }
  for (const status of ['completed', 'failed', 'cancelled']) {
    state.childAgents[0].status = status;
    assert.deepEqual(slot({ id: 'flow' }, [task(status)]).buttons, ['task-flow-dismiss'], status + ' task shows only delete');
  }
  state.childAgents[0].status = 'cancelling';
  assert.deepEqual(slot({ id: 'flow' }, [task('running')]).buttons, ['task-flow-stop task-flow-icon-button'], 'cancelling keeps stop');
  state.childAgents[0].status = 'cancelled';
  assert.deepEqual(slot({ id: 'flow', engine: true, stopPending: true }, [task('cancelled')]).buttons, ['task-flow-stop task-flow-icon-button'],
    'a pending Loop stop keeps stop until the Loop ends');
  context.taskStopsPending.add('flow/task');
  const inFlight = slot({ id: 'flow' }, [task('completed')]);
  assert.deepEqual(inFlight.buttons, ['task-flow-stop task-flow-icon-button'], 'an unanswered stop request keeps stop');
  assert.equal(inFlight.controls.children[0].disabled, true);
  context.taskStopsPending.clear();
  context.taskStopErrors.set('flow/task', 'fixture failure');
  const failed = slot({ id: 'flow' }, [task('cancelled')]);
  assert.deepEqual(failed.buttons, ['task-flow-dismiss']);
  assert.equal(failed.row.children.at(-1).attributes.role, 'alert', 'stop errors stay visible on their own line below the row');
  assert.equal(failed.row.children.at(-1).className, 'task-flow-stop-error');
  assert.deepEqual(sent, [], 'rendering sends no execution control');
  state.role = 'worker';
  assert.equal(slot({ id: 'flow' }, [task('cancelled')]).controls, undefined, 'only Main gets task actions');
});

test('a stage row never offers delete while another stage of its task is active', () => {
  const state = { role: 'main', childAgents: [{ agentId: 'verifier', runId: 'verify-one', role: 'verification', status: 'running' }] };
  const { slot } = slotView(state);
  const work = { id: 'work', taskId: 'task', title: 'Task', sessionRole: 'work', sessionAgentId: 'worker', sessionRunId: 'run-one', status: 'completed' };
  const verify = { id: 'verify', taskId: 'task', title: 'Task', sessionRole: 'verification', sessionAgentId: 'verifier', sessionRunId: 'verify-one', status: 'verifying' };
  const flow = { id: 'flow', engine: true, engineStatus: 'active', tasks: [work, verify] };
  assert.equal(slot(flow, [work, verify], [work]).controls, undefined, 'finished Work stage of a verifying task has no delete');
  assert.deepEqual(slot(flow, [work, verify], [verify]).buttons, ['task-flow-stop task-flow-icon-button']);
  assert.deepEqual(slot(flow, [work, verify]).buttons, ['task-flow-stop task-flow-icon-button'], 'single-task summary shows stop');
  verify.status = 'completed';
  state.childAgents[0].status = 'completed';
  assert.deepEqual(slot(flow, [work, verify], [work]).buttons, ['task-flow-dismiss']);
  assert.deepEqual(slot(flow, [work, verify]).buttons, ['task-flow-dismiss'], 'single-task summary shows delete once ended');
});

const badgeSource = source.slice(source.indexOf('  function createTaskStatus('), source.indexOf('  function createSingleTaskFlowCard('));
test('status badges preserve runtime data and distinguish exact lifecycle, waiting and Verification outcomes', () => {
  const state = { childAgents: [] };
  const context = { state, t: key => key, acceptedTaskAgent: () => true,
    document: { createElement() { return { dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }; } } };
  runInNewContext(badgeSource, context);
  const task = { title: 'Fixture', sessionAgentId: 'worker', sessionRunId: 'run-one', sessionRole: 'work', status: 'pending' };
  for (const observed of ['accepted', 'queued', 'starting', 'cancelling']) {
    state.childAgents = [{ agentId: 'worker', runId: 'run-one', status: observed }];
    const before = JSON.stringify({ state, task });
    const label = context.createTaskStatus(task, {}, 'pending', true);
    assert.equal(label.textContent, 'flow.display.' + observed);
    assert.equal(label.dataset.observedStatus, observed);
    assert.equal(label.attributes.role, 'status');
    assert.equal(JSON.stringify({ state, task }), before);
  }
  state.childAgents = [{ agentId: 'worker', runId: 'different-run', status: 'starting' }];
  assert.equal(context.createTaskStatus(task, {}, 'pending', true).textContent, 'flow.status.pending', 'Another run cannot supply lifecycle');
  state.childAgents = [];
  assert.equal(context.createTaskStatus({ status: 'pending' }, {}, 'pending', true).textContent, 'flow.status.pending', 'Unassigned waiting is not fabricated preparation');
  assert.equal(context.createTaskStatus(task, {}, 'completed', true).title, 'flow.status.detail.completed', 'Work completion is not a verification pass');
  const verify = { ...task, sessionRole: 'verification' };
  assert.equal(context.createTaskStatus(verify, {}, 'completed', true).textContent, 'flow.display.verification.completed');
  assert.equal(context.createTaskStatus(verify, {}, 'completed', true).title, 'flow.status.detail.verification.completed');
  assert.equal(context.createTaskStatus(task, {}, 'blocked', true).textContent, 'flow.status.blocked');
  assert.equal(context.createTaskStatus(task, { engineStatus: 'needs-human-decision' }, 'blocked', true).textContent, 'flow.display.needs-human-decision');
  assert.equal(context.createTaskStatus({ ...task, id: 'current' }, { engineStatus: 'needs-human-decision', decisionTaskId: 'current' }, 'running', true).textContent, 'flow.display.needs-human-decision');
  assert.equal(context.createTaskStatus({ ...task, id: 'later' }, { engineStatus: 'needs-human-decision', decisionTaskId: 'current' }, 'pending', true).textContent, 'flow.status.pending', 'A different task does not inherit the loop decision');
  assert.equal(context.createTaskStatus({ ...task, id: 'current' }, { engineStatus: 'needs-human-decision', decisionTaskId: 'current' }, 'completed', true).textContent, 'flow.status.completed', 'A finished Work does not inherit a later decision');
  state.childAgents = [{ agentId: 'worker', runId: 'run-one', status: 'needs-human-decision' }];
  assert.equal(context.createTaskStatus(task, {}, 'blocked', true).textContent, 'flow.display.needs-human-decision');
  assert.equal(context.createTaskStatus(task, {}, 'running', false).textContent, 'flow.status.running', 'Historical rendering is unchanged');
});
