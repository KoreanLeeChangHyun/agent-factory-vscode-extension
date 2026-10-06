import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatSource, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";

const source = await readChatSource();
const indexSource = source.slice(source.indexOf('  function indexedTimeline()'), source.indexOf('  function upsertActivity('));
const aggregation = source.slice(source.indexOf('  function validTaskFlowId('), source.indexOf('  function liveTaskStatus('));

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

const activeSelection = source.slice(source.indexOf('  function displayTaskFlows()'), source.indexOf('  // A logical task has ended'));
test('only terminal workflow states leave the active workflow panel', () => {
  const context = { state: { childAgents: [] }, currentTaskFlows: () => [], acceptedTaskAgent: () => true };
  runInNewContext(activeSelection + '\nglobalThis.display = displayTaskFlows; globalThis.ended = workflowEnded;', context);
  for (const status of ['completed', 'failed', 'cancelled', 'runtime-error']) {
    assert.equal(context.ended({ engine: true, engineStatus: status }), true, status);
  }
  for (const status of ['active', 'needs-human-decision', undefined]) {
    assert.equal(context.ended({ engine: true, engineStatus: status }), false, String(status));
  }
  assert.equal(context.ended({ engine: false, engineStatus: 'completed' }), false, 'direct cards follow their exact run state');
  context.currentTaskFlows = () => [{ id: 'accepted', tasks: [{ agentId: 'work', runId: 'run', status: 'pending' }] },
    { id: 'draft', tasks: [{ agentId: 'draft-work', runId: 'draft-run', status: 'pending' }] }];
  context.state.childAgents = [{ agentId: 'work', runId: 'run', status: 'accepted' }];
  assert.deepEqual(Array.from(context.display(), flow => flow.id), ['accepted'],
    'a restored accepted workflow is shown, while identifiers alone do not activate a draft');
});

const dismissal = source.slice(source.indexOf('  function taskDismissKey('), source.indexOf('  function taskStopKey('));
const stage = (id, run = 'run-one', extra = {}) => ({ id, title: id, agentId: 'worker', runId: run, status: 'running', ...extra });
const flow = (id, tasks, extra = {}) => ({ id, tasks, ...extra });
function dismissView(state) {
  const sent = [];
  const context = { state, t: key => key, renders: 0, saves: 0, sent,
    taskDeletesPending: new Set(), taskFlowSnapshot: undefined,
    validTaskFlowId: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    vscode: { postMessage: message => sent.push(message) }, runStageList: { dataset: {} },
    renderWorkLoopPanel() { context.renders++; }, persist() { context.saves++; },
    document: { getElementById() { return { dataset: {} }; }, createElement() { return { append() {}, setAttribute() {}, addEventListener(_name, handler) { this.click = handler; } }; },
      createElementNS() { return { append() {}, setAttribute() {} }; } } };
  runInNewContext(dismissal, context);
  return context;
}

test('task delete waits for storage acknowledgement and leaves the row on failure', () => {
  const flows = [flow('one', [stage('same')]), flow('two', [stage('same')])];
  const state = { agentId: 'main-one', role: 'main', childAgents: [], taskFlows: flows, workflows: [], timeline: [] };
  const before = JSON.stringify(state);
  const ctx = dismissView(state);
  const click = { preventDefault() {}, stopPropagation() {} };
  const button = ctx.createTaskDismiss(flows[0], flows[0].tasks);
  button.click(click); button.click(click);
  assert.equal(ctx.sent.length, 1, 'duplicate clicks do not delete twice');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sent[0])), { type: 'task.delete', workflowId: 'one', taskId: 'same' });
  assert.equal(JSON.stringify(state), before, 'request does not optimistically hide history');
  ctx.finishTaskDelete({ mainAgentId: 'main-one', workflowId: 'one', taskId: 'same', error: 'storage denied' });
  assert.equal(JSON.stringify(state), before);
  assert.equal(ctx.saves, 0, 'failure is not persisted as deletion');
  const retry = ctx.createTaskDismiss(flows[0], flows[0].tasks);
  assert.equal(retry.disabled, false);
  retry.click(click);
  ctx.finishTaskDelete({ mainAgentId: 'main-one', workflowId: 'one', taskId: 'same' });
  assert.deepEqual(Array.from(state.taskFlows, item => item.id), ['two']);
  assert.equal(ctx.saves, 1);
});

test('confirmed deletion removes both stages and stale snapshots, keeps Main prose and other tasks', () => {
  const stages = [stage('work', 'run-one', { taskId: 'same', sessionRole: 'work' }),
    stage('verify', 'run-verify', { taskId: 'same', sessionRole: 'verification' }), stage('other')];
  const original = flow('workflow', stages);
  const state = { agentId: 'main-one', taskFlows: [original],
    workflows: [{ loopId: 'loop', workflow: { id: 'workflow', tasks: [{ id: 'same' }, { id: 'other' }] } }],
    childAgents: [{ taskBinding: { workflowId: 'workflow', taskId: 'same' } }, { taskBinding: { workflowId: 'workflow', taskId: 'other' } }],
    timeline: [{ type: 'assistant', text: 'Main prose\n```task-flow\n' + JSON.stringify(original) + '\n```\n' }],
    projectTasks: [{ id: 'workflow', mainAgentId: 'main-two', tasks: [{ id: 'same' }] }] };
  const ctx = dismissView(state);
  ctx.finishTaskDelete({ mainAgentId: 'main-one', workflowId: 'workflow', taskId: 'same' });
  assert.deepEqual(Array.from(state.taskFlows[0].tasks, item => item.id), ['other']);
  assert.deepEqual(Array.from(state.workflows[0].workflow.tasks, item => item.id), ['other']);
  assert.equal(state.childAgents.length, 1);
  assert.ok(state.timeline[0].text.startsWith('Main prose\n'));
  assert.deepEqual(JSON.parse(state.timeline[0].text.split('```task-flow\n')[1].split('\n```')[0]).tasks.map(task => task.id), ['other']);
  assert.equal(state.projectTasks[0].tasks.length, 1, 'another conversation is preserved');
  assert.equal(original.tasks.length, 3, 'caller snapshot is not mutated');
  const restored = dismissView(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(Array.from(restored.state.taskFlows[0].tasks, task => task.id), ['other']);
  state.dismissedTasks = ['legacy-ui-hide'];
  assert.equal(ctx.visibleTaskFlows([original])[0].tasks.length, 3, 'legacy hides never replace physical deletion');
});

const slotSource = source.slice(source.indexOf('  function liveTaskStatus('), source.indexOf('  function summarizeTaskFlow('))
  + source.slice(source.indexOf('  function taskDismissKey('), source.indexOf('  function finishTaskStop('))
  + source.slice(source.indexOf('  function workflowEnded('), source.indexOf('  // A logical task has ended'));
function slotView(state) {
  const element = tag => ({ tag, className: '', dataset: {}, attributes: {}, children: [],
    get childElementCount() { return this.children.length; },
    append(...children) { this.children.push(...children); }, setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(_name, handler) { this.click = handler; } });
  const sent = [];
  const context = { state, t: key => key, persist() {}, renderWorkLoopPanel() {}, vscode: { postMessage: message => sent.push(message) },
    taskStopsPending: new Set(), taskStopErrors: new Map(), taskDeletesPending: new Set(), validTaskFlowId: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), document: { createElement: element, createElementNS: (_ns, tag) => element(tag) } };
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
  state.childAgents[0].status = 'cancelled';
  assert.deepEqual(slot({ id: 'flow', engine: true, engineStatus: 'cancelled' }, [task('pending')]).buttons, ['task-flow-dismiss'],
    'An ended driver does not keep a never-started stage active');
  state.childAgents[0].status = 'running';
  assert.deepEqual(slot({ id: 'flow', engine: true, engineStatus: 'cancelled' }, [task('pending')]).buttons, ['task-flow-stop task-flow-icon-button'],
    'A live owner remains protected even when the driver ended');
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
