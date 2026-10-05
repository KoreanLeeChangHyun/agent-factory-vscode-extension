import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
import { readChatSource, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";

const { ChatSessionController } = await importTypeScript('src/modules/chat/session-controller.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
const events = overrides => ({ onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {},
  onUsage() {}, onActivity() {}, onError() {}, ...overrides });

test('worktree actions use an allowlisted message and discard caller paths', () => {
  for (const type of ['worktree.merge', 'worktree.refresh']) {
    assert.deepEqual(parseClientMessage({ type, path: '/untrusted', agentId: 'other' }), { type });
  }
  const draft = { type: 'worktree.create', repository: '/repo', name: 'Task', base: 'main' };
  assert.deepEqual(parseClientMessage({ ...draft, path: '/untrusted', agentId: 'other' }), draft);
  for (const field of ['repository', 'name', 'base']) assert.equal(parseClientMessage({ ...draft, [field]: 123 }), undefined);
  assert.equal(parseClientMessage({ type: 'worktree.create' }), undefined);
  assert.equal(parseClientMessage({ type: 'worktree.delete' }), undefined);
});

test('new conversation binds once and sends wait for the worktree transition', async () => {
  let finish;
  const calls = [];
  const bound = [];
  const runtime = {
    worktree: async (agent, action) => { calls.push([agent, action]); return new Promise(resolve => { finish = () => resolve({ agentId: agent, workingDirectory: '/worktree' }); }); },
    send: async agent => { calls.push([agent, 'send']); return { agentId: agent, runId: 'run-1' }; },
    status: async () => ({ status: 'completed' }),
    result: async () => ({ status: 'completed', text: 'done' }),
    updates: async () => ({ cursor: 0, updates: [] })
  };
  const controller = new ChatSessionController(runtime, events({ onBound: id => bound.push(id) }), undefined, { pollIntervalMs: 0 });
  const creating = controller.changeWorktree('create', { changes: 'keep' });
  const sending = controller.send('edit here', [], { taskMode: 'direct' });
  assert.equal(calls.length, 1);
  await assert.rejects(controller.changeWorktree('merge'), /current run/);
  finish();
  await creating;
  await sending;
  assert.equal(bound.length, 1);
  assert.deepEqual(calls.map(call => call[1]), ['create', 'send']);
  assert.ok(calls.every(call => call[0] === bound[0]));
  controller.dispose();
});

test('failed creation retains an accepted session for status and retry', async () => {
  const bound = [];
  const controller = new ChatSessionController({ worktree: async (agentId, action) => {
    if (action === 'create') throw new Error('Git interrupted');
    return { agentId, workingDirectory: '/partial' };
  } }, events({ onBound: id => bound.push(id) }));
  await assert.rejects(controller.changeWorktree('create'), /Git interrupted/);
  assert.equal(bound.length, 1);
  controller.dispose();
});

test('worktree toolbar reflects queue, connection and unsupported state', async () => {
  const script = await readChatSource();
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {hidden:false, disabled:false, classList:{toggle(){}},setAttribute(){}});
    return nodes.get(id);
  };
  const context = {prompt: {}, t: key => key, updateSendButton(){}, document:{getElementById:node},state:{role:'main',running:false,queueCount:0},worktreeSupported:true,worktreeBusy:false,conversationWorktree:undefined,openSettingId:undefined,worktreeButton:node('worktree-button'),worktreeLocationDescription:()=>'/workspace',closeSettingMenu(){},deployAvailable:()=>false,renderDeploy(){}};
  runInNewContext(script.slice(script.indexOf('  function renderWorktree()'),script.indexOf('  function receiveUnitCreated(')),context);
  const render=()=>runInNewContext('renderWorktree()',context);
  render(); assert.equal(node('worktree-picker').hidden,false); assert.equal(node('worktree-create').disabled,false);
  context.state.queueCount=1; render(); assert.equal(node('worktree-create').disabled,true); assert.equal(node('worktree-refresh').disabled,false);
  context.state.queueCount=0; context.conversationWorktree={worktree:{phase:'active'}};render();assert.equal(node('worktree-create').hidden,true);assert.equal(node('worktree-merge').hidden,false);
  context.state.running=true;render();assert.equal(node('worktree-merge').disabled,true);
  context.conversationWorktree={worktree:{phase:'merged',workUnit:true,cleaned:false}};context.state.running=false;render();assert.equal(context.prompt.readOnly,true);assert.equal(node('worktree-merge').hidden,false);
  context.conversationWorktree.worktree.cleaned=true;render();assert.equal(node('worktree-merge').hidden,true);
  context.worktreeSupported=false;render();assert.equal(node('worktree-picker').hidden,true);
  context.deployAvailable=()=>true;render();assert.equal(node('worktree-picker').hidden,false);assert.equal(node('worktree-controls').hidden,true);
  context.state.role='work';render();assert.equal(node('worktree-picker').hidden,true);
});
