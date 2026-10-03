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
  assert.equal(await page.locator('#question-button').evaluate(el => el === document.activeElement), true);
  await page.locator('#question-button').click();
  assert.equal(await page.locator('#question-tab-questions').getAttribute('aria-selected'), 'true', 'The integrated entry always opens on user questions');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this draft');
  assert.equal(await page.locator('#timeline').textContent(), before);
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => ['chat.send', 'run.cancel', 'conversation.clear'].includes(m.type))), false);
  assert.equal(await page.locator('#submission-menu #conversation-history-list').count(), 0, 'Submission menu no longer duplicates conversation history');
  console.log('Integrated history tabs: keyboard navigation, archived read, pagination, focus return and current draft preservation passed.');
}
module.exports = { checkConversationHistory };
