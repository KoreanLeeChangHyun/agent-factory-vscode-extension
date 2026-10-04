const assert = require('node:assert/strict');

async function checkHistoryIndex(page) {
  const emit = data => page.evaluate(data => {
    window.dispatchEvent(new MessageEvent('message', { data }));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, data);
  await emit({ type: 'session.bound', agentId: 'index-main', conversationId: 'index-conversation', reset: true });
  await page.evaluate(() => {
    window.historyTypeReads = 0;
    const messages = Array.from({ length: 10000 }, (_, i) => {
      const type = i === 0 ? 'user' : 'assistant';
      return { id: 'history-' + i, runId: 'run-' + i, text: 'History ' + i,
        phase: i <= 1 ? 'final' : 'commentary',
        get type() { window.historyTypeReads++; return type; } };
    });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'conversation.history', agentId: 'index-main',
      history: { conversationId: 'index-conversation', messages } } }));
  });
  await page.waitForSelector('[data-id="history-9999"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.historyTypeReads = 0; });
  for (let i = 0; i < 5; i++) await emit({ type: 'decision.pending', runId: null });
  const reads = await page.evaluate(() => window.historyTypeReads);
  if (process.env.AF_HISTORY_INDEX_ASSERT === '1') assert.ok(reads < 20000, 'Visible refreshes must not rescan 10,000 historical messages per item');
  console.log(JSON.stringify({ scenario: '10,000 messages, five visible refreshes, last final before 9,998 commentary messages', historyTypeReads: reads }));
  const questions = page.locator('#question-list .question-item');
  await page.locator('#question-button').click();
  assert.equal(await questions.count(), 1);
  await page.keyboard.press('Escape');
  await emit({ type: 'chat.human-decision', text: 'New question' });
  await page.locator('#question-button').click();
  assert.equal(await questions.count(), 2);
  assert.match(await questions.last().textContent(), /New question/);
  await page.keyboard.press('Escape');
  await emit({ type: 'conversation.cleared', conversationId: 'fresh' });
  await page.locator('#question-button').click();
  assert.equal(await questions.count(), 0, 'Clearing a conversation invalidates the question index');
  await page.keyboard.press('Escape');
  // The same session re-initializes with its own agent and conversation; omitting them now starts a new session.
  await emit({ type: 'host.initialize', agentId: 'index-main', conversationId: 'fresh', runtimeAvailable: true, botsEnabled: false, capabilities: { submit: { taskModes: ['direct'] }, send: { taskModes: ['direct'] } } });
  const question = '**Question [1/2]:** Choose a place\n\n| Option | Place |\n|---|---|\n| 1 | Home |\n| 2 | Office |';
  await emit({ type: 'chat.assistant', phase: 'final', text: question });
  await emit({ type: 'chat.assistant', phase: 'commentary', text: 'Additional explanation' });
  assert.equal(await page.locator('.interview-choice:not(:disabled)').count(), 2, 'Commentary does not replace the latest conversational turn');
  await emit({ type: 'chat.human-decision', text: 'New user turn' });
  assert.equal(await page.locator('.interview-choice:not(:disabled)').count(), 0, 'A new user turn disables old choices');
  await emit({ type: 'chat.assistant', phase: 'final', text: question.replace('[1/2]', '[2/2]') });
  assert.equal(await page.locator('.interview-choice:not(:disabled)').count(), 2);
  await emit({ type: 'conversation.history', agentId: 'index-main', history: { conversationId: 'fresh', messages: [
    { id: 'older-user', type: 'user', text: 'Earlier question', runId: 'earlier-run' }
  ] } });
  assert.equal(await page.locator('.interview-choice:not(:disabled)').count(), 2, 'Prepending older history preserves the latest turn');
  await page.locator('#question-button').click();
  assert.equal(await questions.count(), 2);
  assert.match(await questions.first().textContent(), /Earlier question/);
  await page.keyboard.press('Escape');
}
module.exports = { checkHistoryIndex };
