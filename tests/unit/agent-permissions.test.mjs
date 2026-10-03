import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
const { parseAgentPermissions } = await importTypeScript('src/common/types/agent-permissions.ts');
const { restoreChatState } = await importTypeScript('src/modules/chat/chat-state.ts');
const { executionPolicyArguments } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
test('role overrides reject unknown modes and preserve omitted inheritance', () => {
  assert.deepEqual(parseAgentPermissions({ main: 'bypass', verification: 'workspace-write' }), { main: 'bypass', verification: 'workspace-write' });
  assert.deepEqual(parseAgentPermissions({}), {});
  for (const input of [null, [], { worker: 'bypass' }, { main: 'root' }, { work: 1 }]) assert.equal(parseAgentPermissions(input), undefined);
});
test('role permissions survive panel restoration', () => {
  const result = restoreChatState({ panelId: 'permissions', title: 'Main', agentPermissions: { work: 'workspace-write' } });
  assert.deepEqual(result.agentPermissions, { work: 'workspace-write' });
});
test('Main permission modes map to sandbox and Human approval separately', () => {
  assert.deepEqual(executionPolicyArguments('bypass'), ['--sandbox', 'danger-full-access', '--approval-policy', 'never', '--human-approval-policy', 'bypass']);
  assert.deepEqual(executionPolicyArguments('workspace-write'), ['--sandbox', 'workspace-write', '--approval-policy', 'never', '--human-approval-policy', 'required']);
});
