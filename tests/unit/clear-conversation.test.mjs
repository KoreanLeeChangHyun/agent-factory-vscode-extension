import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const script = await readFile(new URL('static/js/chat.js', root), 'utf8');
const protocol = await readFile(new URL('src/protocol/messages.ts', root), 'utf8');
const validator = await readFile(new URL('src/protocol/validator.ts', root), 'utf8');

test('clear conversation is exposed through command and validated webview protocol', () => {
  assert.ok(packageJson.activationEvents.includes('onCommand:agentFactory.mainChat.clearConversation'));
  assert.ok(packageJson.contributes.commands.some(command => command.command === 'agentFactory.mainChat.clearConversation'));
  assert.match(protocol, /type: "conversation\.clear"/);
  assert.match(validator, /"conversation\.clear"/);
  assert.match(script, /postMessage\(\{ type: "conversation\.clear" \}\)/);
});

test('host initialization behavior clears a stale Webview boundary before applying usage', () => {
  const handler = script.slice(
    script.indexOf('      case "host.initialize":'),
    script.indexOf('      case "syntax.theme":')
  );
  const resetHelper = script.slice(
    script.indexOf('  function resetConversationState()'),
    script.indexOf('  function renderSubmissionMenu(')
  );
  const state = {
    conversationId: 'conversation-old', timeline: [{ type: 'assistant', text: 'old' }],
    pendingRequests: [{ id: 'pending' }], startedMessageIds: ['old-message'],
    contextUsedTokens: 50, contextWindowTokens: 100, weeklyUsedPercent: 20,
    workUnits: {}, childAgents: [{ agentId: 'work-old' }], agentId: 'main-agent'
  };
  const message = {
    type: 'host.initialize', panelId: 'panel', title: 'Main', role: 'main', projectName: 'project',
    runtimeAvailable: true, conversationId: 'conversation-new', resetConversation: false,
    capabilities: { send: {} }, running: false, fastMode: false, queueCount: 0,
    contextUsedTokens: 90, contextWindowTokens: 100, weeklyUsedPercent: 40,
    statusItems: []
  };
  const context = {
    state, message, document: { body: { dataset: {} } },
    currentCapabilities: () => ({}), appendNotice() {}, safeCount: value => value,
    safeCountOrUndefined: value => value, safePercentOrUndefined: value => value,
    normalizeModel: value => value, normalizeSettingValue: value => value,
    normalizeStatusItems: value => value, updateModeControls() {}, renderTimeline() {},
    renderStatusBar() {}, renderStatusCatalog() {}, updateRunControls() {}, persist() {},
    vscode: { postMessage() {} }, settingOptions: { reasoning: [] }, Date
  };
  runInNewContext(`let nativeGoal = { status: 'active' }; let goalError = 'old'; let followLatest = false;\n${resetHelper}\nswitch (message.type) {\n${handler}\n}`, context);
  assert.equal(state.conversationId, 'conversation-new');
  assert.equal(state.timeline.length, 0);
  assert.equal(state.pendingRequests.length, 0);
  assert.equal(state.startedMessageIds.length, 0);
  assert.equal(state.contextUsedTokens, undefined);
  assert.equal(state.contextWindowTokens, undefined);
  assert.equal(state.weeklyUsedPercent, undefined);
  assert.equal(state.childAgents.length, 0);
});

test('matching conversation boundary retains history and accepts current usage', () => {
  const handler = script.slice(script.indexOf('      case "host.initialize":'), script.indexOf('      case "syntax.theme":'));
  const resetHelper = script.slice(script.indexOf('  function resetConversationState()'), script.indexOf('  function renderSubmissionMenu('));
  const state = { conversationId: 'conversation-current', timeline: [{ type: 'assistant', text: 'current' }], pendingRequests: [], startedMessageIds: [], workUnits: {}, childAgents: [] };
  const message = { type: 'host.initialize', panelId: 'panel', title: 'Main', role: 'main', projectName: 'project', runtimeAvailable: true, conversationId: 'conversation-current', resetConversation: false, capabilities: { send: {} }, running: false, fastMode: false, queueCount: 0, contextUsedTokens: 25, contextWindowTokens: 100, weeklyUsedPercent: 10, statusItems: [] };
  const context = { state, message, document: { body: { dataset: {} } }, currentCapabilities: () => ({}), appendNotice() {}, safeCount: value => value, safeCountOrUndefined: value => value, safePercentOrUndefined: value => value, normalizeModel: value => value, normalizeSettingValue: value => value, normalizeStatusItems: value => value, updateModeControls() {}, renderTimeline() {}, renderStatusBar() {}, renderStatusCatalog() {}, updateRunControls() {}, persist() {}, vscode: { postMessage() {} }, settingOptions: { reasoning: [] }, Date };
  runInNewContext(`let nativeGoal = null; let goalError; let followLatest = true;\n${resetHelper}\nswitch (message.type) {\n${handler}\n}`, context);
  assert.equal(state.timeline.length, 1);
  assert.equal(state.contextUsedTokens, 25);
  assert.equal(state.contextWindowTokens, 100);
  assert.equal(state.weeklyUsedPercent, 10);
});

test('clear boundary retains a racing optimistic request for chat.started promotion', () => {
  const handler = script.slice(
    script.indexOf('      case "conversation.cleared":'),
    script.indexOf('      case "sessions.open":')
  );
  const resetHelper = script.slice(
    script.indexOf('  function resetConversationState()'),
    script.indexOf('  function renderSubmissionMenu(')
  );
  const pending = { id: 'racing-message', text: 'new request', attachments: [{ name: 'input.png', previewUri: 'safe-preview' }] };
  const state = {
    conversationId: 'conversation-old', timeline: [{ type: 'assistant', text: 'old' }],
    pendingRequests: [pending], startedMessageIds: ['old-message'],
    contextUsedTokens: 50, contextWindowTokens: 100, weeklyUsedPercent: 20,
    workUnits: {}, childAgents: [{ agentId: 'work-old' }]
  };
  const context = {
    state, message: { type: 'conversation.cleared', conversationId: 'conversation-new' },
    renderAll() {}, persist() {}
  };
  runInNewContext(`let nativeGoal = { status: 'active' }; let goalError = 'old'; let followLatest = false;\n${resetHelper}\nswitch (message.type) {\n${handler}\n}`, context);
  assert.equal(state.conversationId, 'conversation-new');
  assert.equal(state.timeline.length, 0);
  assert.deepEqual(state.pendingRequests, [pending]);
});
