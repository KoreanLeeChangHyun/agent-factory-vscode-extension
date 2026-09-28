import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
const result = await build({ entryPoints: ['src/modules/chat/companion.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: new URL('../..', import.meta.url).pathname });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date });
const { restoreCompanion, interactCompanion } = module.exports;
test('restored shared state preserves emotion and sleep clock across tabs', () => {
  const initial = restoreCompanion(null, 100000);
  const pet = interactCompanion(initial, 'pet', 100001);
  assert.equal(restoreCompanion(JSON.parse(JSON.stringify(pet)), 100002).emotion, 'love');
  assert.equal(restoreCompanion(pet, 100002).lastInteractionAt, 100001);
  assert.equal(pet.careCount, 1);
  assert.equal(initial.careCount, 0);
});
test('calling a sleeping companion startles it, then subsequent calls greet', () => {
  const asleep = interactCompanion(restoreCompanion(null, 100000), 'sleep', 100000);
  const awake = interactCompanion(asleep, 'call', 100010);
  assert.equal(awake.emotion, 'surprised');
  assert.equal(interactCompanion(awake, 'call', 100020).emotion, 'happy');
  assert.equal(interactCompanion(awake, 'call', 200020).emotion, 'surprised');
});
test('care transitions clamp stats and serialized consecutive actions retain both changes', () => {
  let state = restoreCompanion(null, 100000);
  for (let i = 0; i < 30; i++) state = interactCompanion(state, 'play', 100001 + i);
  state = interactCompanion(state, 'feed', 100040);
  assert.equal(state.energy, 0); assert.equal(state.happiness, 100);
  assert.equal(state.fullness, 100); assert.equal(state.careCount, 31);
  assert.equal(interactCompanion(state, 'praise', 100050).emotion, 'shy');
});
test('corrupt persisted state is bounded and invalid clocks cannot prevent sleep', () => {
  const state = restoreCompanion({ energy: -10, happiness: Infinity, fullness: 120, lastInteractionAt: 1e20, emotion: 'script', reactionUntil: 1e20 }, 100000);
  assert.equal(state.energy, 0); assert.equal(state.happiness, 80);
  assert.equal(state.fullness, 100); assert.equal(state.lastInteractionAt, 100000);
  assert.equal(state.emotion, 'calm'); assert.equal(state.reactionUntil, 106000);
});

test('host serializes interactions, broadcasts one state to two panels and restores it after restart', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const bundle = await build({ entryPoints: ['src/infrastructure/vscode/chat-panel-manager.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], absWorkingDir: new URL('../..', import.meta.url).pathname });
  const host = { exports: {} };
  const vscode = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  runInNewContext(bundle.outputFiles[0].text, { module: host, exports: host.exports, require: name => name === 'vscode' ? vscode : require(name), process, Buffer, URL, setTimeout, clearTimeout, console, global: { Date } });
  const values = new Map();
  const globalState = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => { await new Promise(r => setTimeout(r, 2)); values.set(key, value); } };
  const create = () => new host.exports.ChatPanelManager({ globalState }, {}, () => [], async () => ({ available: false }));
  const manager = create();
  const received = [[], []];
  const panels = received.map((messages, index) => ({ state: { panelId: String(index) }, botContext: index ? 'working' : 'idle', panel: { webview: { postMessage: async m => { messages.push(m); return true; } } } }));
  panels.forEach((panel, index) => manager.panels.set(String(index), panel));
  await Promise.all([
    manager.handleMessage(panels[0], { type: 'bot.interact', action: 'pet' }),
    manager.handleMessage(panels[1], { type: 'bot.interact', action: 'praise' })
  ]);
  assert.equal(values.get('agentFactory.companion.v1').careCount, 2);
  for (const messages of received) {
    assert.equal(messages.at(-1).companion.emotion, 'shy');
    assert.equal(messages.at(-1).working, 1);
  }
  assert.equal(create().companionState().careCount, 2);
});
