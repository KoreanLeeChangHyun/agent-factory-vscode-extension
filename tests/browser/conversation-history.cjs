const assert = require('node:assert/strict');
async function checkConversationHistory(page) {
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await emit({ type: 'host.initialize', panelId: 'history-test', agentId: 'main-test', role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await page.locator('#prompt').fill('Keep this draft');
  const before = await page.locator('#timeline').textContent();
  await page.locator('#question-button').click();
  assert.equal(await page.locator('#question-tab-questions').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#question-panel-questions').isVisible(), true);
  await page.locator('#question-tab-questions').press('ArrowRight');
  assert.equal(await page.locator('#question-tab-history').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#question-panel-history').isVisible(), true);
  await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'conversations.request'));
  assert.equal(await page.locator('#conversation-history-list .history-empty').textContent(), 'Loading conversation history…');
  await emit({ type: 'conversations.list', error: 'fixture failure', conversations: [] });
  assert.match(await page.locator('#conversation-history-list .history-empty').textContent(), /fixture failure/);
  await emit({ type: 'conversations.list', conversations: [] });
  assert.equal(await page.locator('#conversation-history-list .history-empty').textContent(), 'No conversation history.');
  assert.ok(await page.locator('#conversation-history-list .history-empty').evaluate(el => el.getBoundingClientRect().height) > 0);
  await page.locator('#question-tab-history').press('ArrowLeft');
  assert.equal(await page.locator('#question-tab-questions').getAttribute('aria-selected'), 'true');
  await page.locator('#question-tab-questions').press('End');
  assert.equal(await page.locator('#question-tab-history').getAttribute('aria-selected'), 'true');
  await page.setViewportSize({ width: 320, height: 400 });
  await emit({ type: 'conversations.list', conversations: Array.from({ length: 40 }, (_, index) => ({
    conversationId: index === 0 ? null : 'conversation-' + index,
    startedAt: '2026-09-01T12:' + String(index).padStart(2, '0') + ':00Z', runCount: index + 2
  })) });
  const menuBounds = await page.locator('#question-menu').boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 320, 'Integrated panel stays inside a narrow viewport');
  assert.equal(await page.locator('#question-panel-history').evaluate(el => el.scrollHeight > el.clientHeight), true, 'History tab scrolls independently');
  await page.locator('.conversation-history-entry').first().click();
  assert.equal(await page.locator('#conversation-reader').isVisible(), true);
  const lastRead = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'conversation.read').at(-1));
  const request = await lastRead();
  assert.equal(request.conversationId, null);
  await emit({ type: 'conversation.read.result', requestId: 'stale', history: { messages: [{ type: 'user', text: 'STALE' }] } });
  assert.doesNotMatch(await page.locator('#conversation-reader-messages').textContent(), /STALE/);
  await emit({ type: 'conversation.read.result', requestId: request.requestId, history: { nextBefore: 'run-2', messages: [{ type: 'user', text: 'Previous question' }, { type: 'assistant', text: '**Previous answer**' }] } });
  assert.match(await page.locator('#conversation-reader-messages').textContent(), /Previous question.*Previous answer/);
  await page.locator('#conversation-reader-older').click();
  const older = await lastRead();
  assert.equal(older.before, 'run-2');
  await emit({ type: 'conversation.read.result', requestId: older.requestId, history: { messages: [{ type: 'user', text: 'First question' }] } });
  assert.match(await page.locator('#conversation-reader-messages').textContent(), /First question.*Previous question/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#conversation-reader').isVisible(), false);
  await page.waitForFunction(() => document.activeElement === document.getElementById('question-button'));
  assert.equal(await page.locator('#question-button').evaluate(el => el === document.activeElement), true);
  await page.locator('#question-button').click();
  assert.equal(await page.locator('#question-tab-questions').getAttribute('aria-selected'), 'true', 'The integrated entry always opens on user questions');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft');
  assert.equal(await page.locator('#timeline').textContent(), before);
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => ['chat.send', 'run.cancel', 'conversation.clear'].includes(m.type))), false);
  assert.equal(await page.locator('#submission-menu #conversation-history-list').count(), 0, 'Submission menu no longer duplicates conversation history');
  // Exercise restored classification through the real renderer, question index and archive reader.
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const root = path.resolve(__dirname, '../..');
  const compiled = await require('esbuild').build({ entryPoints: [path.join(root, 'src/infrastructure/agent-factory/history-presentation.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs' });
  const bundledModule = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module: bundledModule, exports: bundledModule.exports });
  const { historyPresentation } = bundledModule.exports;
  const manager = fs.readFileSync(path.join(root, 'src/infrastructure/vscode/chat-panel-manager.ts'), 'utf8');
  const template = manager.match(/const message = previous\?\.message \?\? (`\[Engine workflow result[\s\S]*?`);/)[1];
  const fixture = { flow: { loopId: 'loop-history', status: 'completed', latestWorkRunId: 'work-history' } };
  vm.runInNewContext(`notification = ${template};`, fixture);
  const raw = fixture.notification;
  const internal = { type: 'user', id: 'history-user-engine', runId: 'engine', ...historyPresentation(raw, 'direct', false) };
  const human = { type: 'user', id: 'history-user-human', runId: 'human', text: 'Actual restored question' };
  const quoted = { type: 'user', id: 'history-user-quoted', runId: 'quoted', ...historyPresentation('Explain this:\n' + raw, 'direct', false) };
  const answer = { type: 'assistant', id: 'history-result-engine', runId: 'engine', phase: 'final', text: 'Preserved Main result' };
  const history = { conversationId: 'restored-history', messages: [human, internal, answer, quoted] };
  for (const timeline of [[], [human, { ...internal, text: raw, submission: undefined }, answer, quoted]]) {
    await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)),
      { agentId: 'main-test', conversationId: history.conversationId, timeline });
    await page.reload();
    await emit({ type: 'host.initialize', panelId: 'history-test', agentId: 'main-test', conversationId: history.conversationId,
      role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
    await emit({ type: 'conversation.history', agentId: 'main-test', history });
    await page.waitForFunction(() => document.querySelector('#timeline [data-id="history-result-engine"]'));
    assert.equal(await page.locator('#timeline [data-id="history-user-engine"]').count(), 0, 'Internal notification has no user message body');
    assert.match(await page.locator('#timeline').textContent(), /Actual restored question.*Preserved Main result.*Explain this:/s);
    assert.equal(await page.locator('#timeline .message-user').count(), 2, 'Quoted notification remains user text');
    await page.locator('#question-button').click();
    assert.equal(await page.locator('#question-list .question-item').count(), 2);
    await page.locator('#question-tab-history').click();
    await emit({ type: 'conversations.list', conversations: [{ conversationId: history.conversationId, startedAt: '2026-10-06T17:00:00Z', runCount: 3 }] });
    await page.locator('.conversation-history-entry').click();
    const read = await lastRead();
    await emit({ type: 'conversation.read.result', requestId: read.requestId, history });
    assert.equal(await page.locator('#conversation-reader-messages article').count(), 3);
    assert.match(await page.locator('#conversation-reader-messages').textContent(), /Actual restored question.*Preserved Main result.*Explain this:/s);
    await page.keyboard.press('Escape');
    await emit({ type: 'conversation.history', agentId: 'main-test', history });
    assert.equal(await page.locator('#timeline .message-user').count(), 2, 'Repeated history is idempotent');
  }
  const child = { agentId: 'work-history', runId: 'work-run-history', role: 'work', status: 'completed' };
  const workflow = { loopId: 'loop-history', status: 'completed', taskMode: 'work', latestWorkRunId: child.runId,
    workAgentId: child.agentId, receiptPath: '/fixture/work-receipt.json' };
  const activity = { type: 'activity', id: 'history-work-result', runId: 'engine', category: 'command', phase: 'completed',
    text: 'python3 skills/agent/scripts/exec.py result --agent work-history --run-id work-run-history',
    output: JSON.stringify({ run: { ...child, taskMode: 'work', loopId: workflow.loopId, receiptPath: workflow.receiptPath } }) };
  await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)), {
    agentId: 'main-test', conversationId: history.conversationId, role: 'main',
    timeline: [human, activity, internal, answer], childAgents: [child], workflows: [workflow]
  });
  await page.reload();
  const card = page.locator('[data-id="history-work-result"] .managed-agent-card');
  await card.waitFor();
  const snapshot = async () => ({
    label: await card.locator('strong').first().textContent(),
    status: await card.locator('.managed-agent-status').textContent(),
    progress: await card.locator('.managed-agent-progress').textContent(),
    records: await card.locator('.managed-agent-disclosure').textContent(),
    identity: await card.locator('.managed-agent-identity').textContent()
  });
  const beforeReload = await snapshot();
  assert.match(beforeReload.status, /Completed.*No separate verification requested/i);
  assert.match(beforeReload.progress, /Get result.*processed/i);
  assert.match(beforeReload.records, /1$/);
  assert.match(beforeReload.identity, /work-history.*work-run-history/);
  await card.locator('.managed-agent-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(item => item.type === 'agent.open').at(-1)),
    { type: 'agent.open', agentId: child.agentId });
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await card.waitFor();
  assert.deepEqual(await snapshot(), beforeReload, 'Persisted card restores before any fresh runtime response');
  assert.deepEqual(await page.evaluate(() => window.saved.workflows), [workflow], 'Persisted loop and receipt identities survive reload');
  await emit({ type: 'host.initialize', panelId: 'history-test', agentId: 'main-test', conversationId: history.conversationId,
    role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'agents.list', agents: [child], workflows: [workflow] });
  await emit({ type: 'conversation.history', agentId: 'main-test', history });
  await card.waitFor();
  assert.deepEqual(await snapshot(), beforeReload, 'Completed card survives persisted state and history restoration');
  await card.locator('.managed-agent-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(item => item.type === 'agent.open').at(-1)),
    { type: 'agent.open', agentId: child.agentId });
  assert.deepEqual(await page.evaluate(() => window.saved.workflows), [workflow], 'Loop and receipt identities remain unchanged');
  assert.equal(await page.locator('#timeline [data-id="history-user-engine"]').count(), 0);
  assert.match(await page.locator('#timeline [data-id="history-result-engine"]').textContent(), /Preserved Main result/);
  console.log('History restoration and completed Work card reload: status, processed result, command count, chat target and loop/receipt identities passed.');
}
module.exports = { checkConversationHistory };
