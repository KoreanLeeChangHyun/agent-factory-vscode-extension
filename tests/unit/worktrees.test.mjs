import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';

const { ChatSessionController } = await importTypeScript('src/modules/chat/session-controller.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
const events = overrides => ({ onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {},
  onUsage() {}, onActivity() {}, onError() {}, ...overrides });

test('worktree actions use an allowlisted message and discard caller paths', () => {
  for (const type of ['worktree.create', 'worktree.merge', 'worktree.refresh']) {
    assert.deepEqual(parseClientMessage({ type, path: '/untrusted', agentId: 'other' }), { type });
  }
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
