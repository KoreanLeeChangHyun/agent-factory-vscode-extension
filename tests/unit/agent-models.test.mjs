import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
async function moduleAt(path) {
  const result = await build({ entryPoints: [path], bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { parseClientMessage } = await moduleAt('src/protocol/validator.ts');
const { restoreChatState } = await moduleAt('src/modules/chat/chat-state.ts');
const settings = { work: { model: 'worker-model', reasoningEffort: 'high' }, verification: { model: 'review-model', reasoningEffort: 'medium' } };
test('role settings survive protocol and restoration independently of Main', () => {
  const message = { type: 'composer.settings', model: 'main-model', reasoning: 'low', agentModels: settings, fastMode: false, goalMode: false };
  assert.deepEqual(parseClientMessage(message).agentModels, settings);
  assert.deepEqual(restoreChatState(message).agentModels, settings);
  const send = { type: 'chat.send', id: 'one', text: 'task', attachments: [], execution: { model: 'main-model', agentModels: settings, fast: false, goal: false } };
  assert.deepEqual(parseClientMessage(send).execution.agentModels, settings);
  assert.equal(parseClientMessage(send).execution.model, 'main-model');
  for (const bad of [{ other: {} }, { work: { model: 'bad\n--argument' } }, { verification: { reasoningEffort: 'invalid' } }, { work: { extra: true } }, { work: { reasoningEffort: ['high'] } }]) {
    assert.equal(parseClientMessage({ ...send, execution: { ...send.execution, agentModels: bad } }), undefined);
  }
});
