import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
const { restoreChatState } = await importTypeScript('src/modules/chat/chat-state.ts');
const settings = { work: { model: 'worker-model', reasoningEffort: 'high', fast: true }, verification: { model: 'review-model', reasoningEffort: 'medium', fast: false } };
test('role settings survive protocol and restoration independently of Main', () => {
  const modelFastModes = {'main-model': false, 'worker-model': true};
  const message = { type: 'composer.settings', model: 'main-model', reasoning: 'low', agentModels: settings, modelFastModes, fastMode: false, goalMode: false };
  assert.deepEqual(parseClientMessage(message).agentModels, settings);
  assert.deepEqual(parseClientMessage(message).modelFastModes, modelFastModes);
  assert.deepEqual(restoreChatState(message).agentModels, settings);
  assert.deepEqual(restoreChatState(message).modelFastModes, modelFastModes);
  const send = { type: 'chat.send', id: 'one', text: 'task', attachments: [], execution: { model: 'main-model', agentModels: settings, fast: false, goal: false } };
  assert.deepEqual(parseClientMessage(send).execution.agentModels, settings);
  assert.equal(parseClientMessage(send).execution.model, 'main-model');
  for (const bad of [{ other: {} }, { work: { model: 'bad\n--argument' } }, { verification: { reasoningEffort: 'invalid' } }, { work: { extra: true } }, { work: { reasoningEffort: ['high'] } }, { work: { fast: 'yes' } }]) {
    assert.equal(parseClientMessage({ ...send, execution: { ...send.execution, agentModels: bad } }), undefined);
  }
  for (const bad of [{'bad\nmodel': true}, {'main-model': 'yes'}, []]) {
    assert.equal(parseClientMessage({...message, modelFastModes: bad}), undefined);
  }
});
