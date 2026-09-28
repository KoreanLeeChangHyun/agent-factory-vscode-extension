import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const release of [false, true]) test(`bot host availability in ${release ? 'release' : 'local'} build`, async () => {
  const bundle = await build({ entryPoints: ['src/infrastructure/vscode/chat-panel-manager.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], define: { __AF_RELEASE__: String(release) }, absWorkingDir: new URL('../..', import.meta.url).pathname });
  const host = { exports: {} };
  let writes = 0;
  const settings = new Map();
  const vscode = { workspace: { getConfiguration: () => ({ get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback, update: async (key, value) => { writes++; settings.set(key, value); } }) }, ConfigurationTarget: { Global: 1 } };
  runInNewContext(bundle.outputFiles[0].text, { module: host, exports: host.exports, require: name => name === 'vscode' ? vscode : require(name), process, Buffer, URL, setTimeout, clearTimeout, console, global: { Date } });
  const saved = new Map();
  const manager = new host.exports.ChatPanelManager({ globalState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => { writes++; saved.set(key, value); } } }, {}, () => [], async () => ({ available: false }));
  assert.equal(manager.botsEnabled(), true);
  await manager.saveBots(true);
  assert.equal(writes, 1);
  settings.set('factoryBotPrompt', null);
  settings.set('botPrompt', 'legacy factory identity');
  assert.equal(manager.botCharacter(), release ? 'factory' : 'lumi');
  assert.equal(manager.botPrompt(), release ? 'legacy factory identity' : '');
  settings.set('botCharacter', 'factory');
  assert.equal(manager.botPrompt(), 'legacy factory identity');
  settings.set('factoryBotPrompt', '');
  assert.equal(manager.botPrompt(), '', 'Explicit reset must not restore the legacy prompt');
  settings.set('factoryBotPrompt', 'factory only');
  settings.set('lumiPrompt', 'lumi only');
  settings.set('botCharacter', 'lumi');
  assert.equal(manager.botPrompt(), release ? 'factory only' : 'lumi only');
  manager.post = async () => {};
  await manager.handleMessage({ panel: {} }, { type: 'bot.prompt.save', requestId: 'explicit-factory', character: 'factory', prompt: 'updated factory only' });
  assert.equal(settings.get('factoryBotPrompt'), 'updated factory only');
  assert.equal(settings.get('lumiPrompt'), 'lumi only');

  saved.set('agentFactory.companion.v1', { action: 'sleep', emotion: 'sleepy', lastInteractionAt: Date.now() - 70000, careCount: 3 });
  let atConversationStart;
  await manager.handleMessage({ panel: {}, lunaBot: { talk: async () => {
    atConversationStart = saved.get('agentFactory.companion.v1');
    return 'Awake';
  } } }, { type: 'bot.talk', requestId: 'wake-on-talk', text: 'Wake up' });
  assert.ok(atConversationStart, 'Conversation was invoked');
  if (!release) {
    assert.equal(atConversationStart.action, 'call');
    assert.ok(Date.now() - atConversationStart.lastInteractionAt < 1000);
    assert.equal(atConversationStart.careCount, 3, 'Talking does not award care points');
  }
  const character = release ? 'factory' : 'lumi';
  const key = 'agentFactory.botConversation.v1.' + character;
  assert.equal(saved.get(key).length, 2);
  let receivedHistory;
  const restored = new host.exports.ChatPanelManager(manager.context, {}, () => [], async () => ({ available: false }));
  restored.post = async () => {};
  await restored.handleMessage({ panel: {}, lunaBot: { lastEmotion: 'happy', talk: async (_text, _prompt, _model, history) => {
    receivedHistory = history;
    return 'I remember';
  } } }, { type: 'bot.talk', requestId: 'continued', text: 'Remember?' });
  assert.equal(receivedHistory[0].content, 'Wake up');
  assert.equal(receivedHistory[1].content, 'Awake');
  assert.equal(saved.get(key).length, 4, 'Restored host appends to persisted conversation');
  await restored.handleMessage({ panel: {}, lunaBot: { talk: async () => { throw Error('offline'); } } }, { type: 'bot.talk', requestId: 'failed', text: 'Failed turn' });
  assert.equal(saved.get(key).length, 4, 'Failure does not create a conversation turn');
  const lengths = [];
  await Promise.all(['one', 'two'].map(id => restored.handleMessage({ panel: {}, lunaBot: {
    talk: async (_text, _prompt, _model, history) => { lengths.push(history.length); return id; }
  } }, { type: 'bot.talk', requestId: id, text: id })));
  assert.deepEqual(lengths, [4, 6], 'Concurrent panels are serialized without losing turns');
  const cancelled = { panel: {}, disposed: false, lunaBot: { talk: async () => { cancelled.disposed = true; return 'late'; } } };
  await restored.handleMessage(cancelled, { type: 'bot.talk', requestId: 'closed', text: 'Do not save' });
  assert.equal(saved.get(key).length, 8, 'Closed panels cannot append stale replies');
  if (!release) {
    settings.set('botCharacter', 'factory');
    await restored.handleMessage({ panel: {}, lunaBot: { talk: async (_text, _prompt, _model, history) => {
      receivedHistory = history; return 'Factory';
    } } }, { type: 'bot.talk', requestId: 'factory', text: 'Separate' });
    assert.equal(receivedHistory.length, 0, 'Characters never receive each other’s history');
    assert.equal(saved.get(key).length, 8);
  }
  if (release) {
    const beforeInteraction = writes;
    await manager.handleMessage({ disposed: false }, { type: 'bot.interact', action: 'pet' });
    assert.equal(writes, beforeInteraction, 'Release ignores interactions without changing local care state');
  }
});
