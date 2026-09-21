const assert = require('node:assert/strict');

async function checkQuestionNavigation(page) {
  const enforce = process.env.AF_QUESTION_NAV_ASSERT === '1';
  const emit = data => page.evaluate(data => {
    window.dispatchEvent(new MessageEvent('message', { data }));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, data);
  await emit({ type: 'session.bound', agentId: 'nav-main', conversationId: 'nav', reset: true });
  await page.evaluate(() => {
    window.flowTextReads = 0;
    window.offPageFlowTextReads = 0;
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: 'nav-' + i, runId: 'run-' + i, type: i % 2 === 0 ? 'user' : 'assistant', phase: 'final',
      get text() { if (i % 2) { window.flowTextReads++; if (i < 200) window.offPageFlowTextReads++; } return 'Message ' + i; }
    }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'conversation.history', agentId: 'nav-main', history: { conversationId: 'nav', messages } } }));
  });
  await page.waitForSelector('[data-id="nav-999"]');
  await page.waitForTimeout(250);
  await page.locator('#question-button').click();
  const items = page.locator('#question-list .question-item:not(.question-page)');
  const report = { initialQuestionNodes: await items.count() };
  await page.evaluate(() => { window.firstQuestionNode = document.querySelector('#question-list .question-item:not(.question-page)'); });
  await page.keyboard.press('Escape');
  await page.locator('#question-button').click();
  report.reusedQuestionNode = await page.evaluate(() => window.firstQuestionNode === document.querySelector('#question-list .question-item:not(.question-page)'));
  await page.locator('#question-list .question-copy').first().click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text: 'Message 0' });
  assert.equal(await page.locator('#question-menu').isVisible(), true);
  await items.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#question-list .question-copy').first().evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text: 'Message 0' });
  await page.keyboard.press('ArrowLeft');
  assert.equal(await items.first().evaluate(el => el === document.activeElement), true);
  await items.first().click();
  report.oldQuestionMounted = await page.locator('[data-id="nav-0"]').count() === 1;
  if (enforce) {
    assert.equal(report.initialQuestionNodes, 100);
    assert.equal(report.reusedQuestionNode, true);
    assert.equal(report.oldQuestionMounted, true, 'Selecting an older question must load its transcript page');
    assert.equal(await page.locator('[data-id="nav-0"]').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#timeline .message').count(), 200);
    await page.locator('#question-button').click();
    await page.locator('[data-question-page="next"]').click();
    assert.equal(await items.count(), 100);
    assert.match(await items.first().textContent(), /Message 200$/);
    await page.locator('[data-question-page="previous"]').click();
    assert.match(await items.first().textContent(), /Message 0$/);
    await page.locator('[data-question-page="next"]').click();
    await items.first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await items.nth(1).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-id="nav-202"]').evaluate(el => el === document.activeElement), true);
  }
  await page.evaluate(() => { window.flowTextReads = 0; window.offPageFlowTextReads = 0; });
  for (let i = 0; i < 5; i++) {
    await emit({ type: 'run.activity', id: 'new-activity-' + i, category: 'tool', phase: 'completed', text: 'Activity ' + i });
    await page.waitForTimeout(80);
  }
  report.activityFlowTextReads = await page.evaluate(() => window.flowTextReads);
  report.offPageFlowTextReads = await page.evaluate(() => window.offPageFlowTextReads);
  // The visible transcript may legitimately read its own texts; old, off-page
  // assistant bodies should not all be revisited for each appended activity.
  if (enforce) assert.equal(report.offPageFlowTextReads, 0);
  console.log(JSON.stringify(report));
  if (enforce) {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator('#question-button').click();
    for (let i = 0; i < 3; i++) await page.locator('[data-question-page="next"]').click();
    assert.match(await items.last().textContent(), /Message 998$/);
    assert.equal(await page.locator('[data-question-page="next"]').isDisabled(), true);
    await items.last().click();
    assert.equal(await page.locator('[data-id="nav-998"]').evaluate(el => el === document.activeElement), true);
    await emit({ type: 'chat.human-decision', text: 'Question 501' });
    await page.locator('#question-button').click();
    await page.locator('[data-question-page="next"]').click();
    assert.equal(await items.count(), 1, 'The final partial page contains only its remaining question');
    assert.equal(await items.first().textContent(), 'Question 501');
    await items.first().click();
    assert.equal(await page.locator('.message-jump-target').last().textContent().then(text => text.includes('Question 501')), true);
    const original = '  질문 원문\n두 번째 줄 <tag> & **내용**  ';
    await emit({ type: 'chat.started', id: 'copy-original', text: original, attachments: [], submission: { taskMode: 'direct', businessMode: 'normal', guidance: 'INTERNAL GUIDANCE' } });
    await page.locator('#question-button').click();
    const copy = page.locator('.question-row').filter({ has: page.locator('[data-question-id="copy-original"]') }).locator('.question-copy');
    await copy.click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text: original });
    const bounds = await copy.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
    await page.keyboard.press('Escape');
    await emit({ type: 'session.bound', agentId: 'nav-main', conversationId: 'attachment-nav', reset: true });
    await emit({ type: 'conversation.history', agentId: 'nav-main', history: { conversationId: 'attachment-nav', messages: [{ type: 'user', runId: 'attachment-run', id: 'copy-attachment', text: '', attachments: [{ name: 'document.md', path: '/fixture/document.md' }] }] } });
    await page.locator('#question-button').click();
    assert.equal(await page.locator('.question-row').filter({ has: page.locator('[data-question-id="copy-attachment"]') }).locator('.question-copy').isDisabled(), true);
    await page.keyboard.press('Escape');
    await emit({ type: 'conversation.cleared', conversationId: 'new-nav' });
    await page.locator('#question-button').click();
    assert.equal(await items.count(), 0);
    assert.equal(await page.locator('.question-page').count(), 0);
    await page.keyboard.press('Escape');
  }
}
module.exports = { checkQuestionNavigation };
