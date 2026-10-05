import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { importTypeScript } from '../support/import-typescript.mjs';

const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
const { normalizeGeneralSettings, shouldNotify } = await importTypeScript('src/common/types/general-settings.ts');
const require = createRequire(import.meta.url);
const output = await build({ entryPoints: ['src/infrastructure/vscode/chat-panel-manager.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'] });
function fixture(initial = {}) {
  const notices = [], global = new Map(Object.entries(initial)), workspace = new Map();
  const vscode = { window: { state: { focused: true }, showInformationMessage: (...args) => { notices.push(args); return new Promise(() => {}); }, showErrorMessage: (...args) => { notices.push(args); return new Promise(() => {}); } }, workspace: {} };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'vscode' ? vscode : require(name), console, process, Buffer, setTimeout, clearTimeout, global: { Date } });
  const store = map => ({ get: (key, fallback) => map.has(key) ? map.get(key) : fallback, update: async (key, value) => { map.set(key, value); } });
  const context = { globalState: store(global), workspaceState: store(workspace) };
  const manager = new module.exports.ChatPanelManager(context, {}, () => [], async () => ({ available: false }));
  const messages = [];
  const panel = { active: false, webview: { postMessage: async message => { messages.push(message); return true; } } };
  const managed = { panel, state: { panelId: 'main', title: 'Example', role: 'main' } };
  manager.panels.set('main', managed);
  return { manager, managed, messages, context, global, workspace, notices, vscode };
}

test('defaults and strict setting validation preserve permissions boundaries', () => {
  const defaults = normalizeGeneralSettings({ startup: 'invalid', notifySound: 'yes', notifyFailed: false });
  assert.equal(defaults.startup, 'restore');
  assert.equal(defaults.notifySound, false);
  assert.equal(defaults.notifyFailed, false);
  for (const [key, value] of [['startup', 'new'], ['notifySound', true]]) assert.ok(parseClientMessage({ type: 'general.set', key, value }));
  for (const [key, value] of [['startup', 'bad'], ['notifySound', 'yes'], ['executionMode', 'bypass'], ['__proto__', true]]) assert.equal(parseClientMessage({ type: 'general.set', key, value }), undefined);
  assert.equal(shouldNotify(normalizeGeneralSettings(), 'completed', true), false);
  assert.equal(shouldNotify(normalizeGeneralSettings(), 'completed', false), true);
  assert.equal(shouldNotify(defaults, 'failed', false), false);
});

test('concurrent preference updates persist together, broadcast, and survive manager recreation', async () => {
  const f = fixture();
  const second = [];
  f.manager.panels.set('second', { panel: { webview: { postMessage: async m => second.push(m) } } });
  await Promise.all([
    f.manager.handleMessage(f.managed, { type: 'general.set', key: 'startup', value: 'new' }),
    f.manager.handleMessage(f.managed, { type: 'general.set', key: 'notifyCompleted', value: false })
  ]);
  const saved = f.global.get('agentFactory.general.v1');
  assert.equal(saved.startup, 'new'); assert.equal(saved.notifyCompleted, false);
  assert.equal(second.at(-1).settings.notifyCompleted, false);
  assert.equal(fixture({ 'agentFactory.general.v1': saved }).manager.generalSettings().startup, 'new');
});

test('failed persistence restores acknowledged settings with an error', async () => {
  const f = fixture();
  f.context.globalState.update = async () => { throw Error('save failed'); };
  await f.manager.handleMessage(f.managed, { type: 'general.set', key: 'notifySound', value: true });
  assert.match(f.messages.at(-1).error, /save failed/);
  assert.equal(f.messages.at(-1).settings.notifySound, false);
});

test('notifications respect focus, category, deduplication and sound without awaiting dismissal', () => {
  const f = fixture();
  f.manager.notifyRun(f.managed, 'completed', 'run-1');
  f.manager.notifyRun(f.managed, 'completed', 'run-1');
  assert.equal(f.notices.length, 1);
  assert.equal(f.messages.length, 0, 'sound is off by default');
  f.managed.panel.active = true;
  f.manager.notifyRun(f.managed, 'failed', 'run-2');
  assert.equal(f.notices.length, 1);
  f.vscode.window.state.focused = false;
  f.manager.notifyRun(f.managed, 'decision', 'run-3');
  assert.equal(f.notices.length, 2, 'another application counts as background');
  f.global.set('agentFactory.general.v1', { notifySound: true, notifyCompleted: false });
  f.manager.notifyRun(f.managed, 'completed', 'run-4');
  assert.equal(f.notices.length, 2);
  f.manager.notifyRun(f.managed, 'failed', 'run-4');
  assert.equal(f.notices.length, 3);
  assert.equal(f.messages.at(-1).type, 'notification.sound');
  f.managed.disposed = true;
  f.manager.notifyRun(f.managed, 'failed', 'run-5');
  assert.equal(f.notices.length, 3);
});

test('startup restores last selected chat once and leaves saved history intact for new-chat mode', async () => {
  const f = fixture();
  const saved = [{ panelId: 'one', title: 'One' }, { panelId: 'two', title: 'Two' }];
  f.workspace.set('agentFactory.sidebar.agents', saved);
  f.workspace.set('agentFactory.mainChat.lastPanel', 'one');
  const opened = [];
  f.manager.openSidebarAgent = async state => opened.push(state.panelId);
  await f.manager.openStartup(); await f.manager.openStartup();
  assert.deepEqual(opened, ['one']);
  const fresh = fixture({ 'agentFactory.general.v1': { startup: 'new' } });
  fresh.workspace.set('agentFactory.sidebar.agents', saved);
  fresh.manager.openDraft = async () => opened.push('new');
  await fresh.manager.openStartup();
  assert.deepEqual(opened, ['one', 'new']);
  assert.equal(fresh.workspace.get('agentFactory.sidebar.agents'), saved);
  const manual = fixture(); manual.manager.startupHandled = true;
  manual.manager.openDraft = async () => assert.fail('must not duplicate a manually opened chat');
  await manual.manager.openStartup();
});

test('controller status and decision callbacks deliver the corresponding notifications', async () => {
  const f = fixture();
  f.manager.connectRuntime = async () => ({ available: true, client: {} });
  f.manager.scheduleAgentList = () => {};
  f.manager.broadcastCompanion = () => {};
  await f.manager.createController(f.managed);
  const controller = f.managed.controller;
  controller.currentRunId = 'run-live';
  controller.events.onStatusObserved('running');
  controller.events.onStatusObserved('completed');
  controller.events.onStatusObserved('completed');
  assert.equal(f.notices.length, 1);
  controller.currentRunId = 'run-failed';
  controller.events.onStatusObserved('failed');
  controller.events.onDecision('run-decision', false);
  controller.events.onDecision(null);
  controller.events.onInterviewQuestion({ id: 'q1' }, 'run-question');
  assert.equal(f.notices.length, 4);
  assert.ok(f.messages.some(message => message.type === 'run.observed' && message.status === 'failed'));
  assert.ok(f.messages.some(message => message.type === 'decision.pending' && message.runId === 'run-decision'));
});
