const assert = require('node:assert/strict');

async function checkMessageSubmission(page) {
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work', 'plan-work'] };
  await page.evaluate(capability => window.postMessage({ type: 'host.initialize', panelId: 'submission', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } }, '*'), capability);
  await page.waitForFunction(() => window.saved?.panelId === 'submission');
  assert.equal(await page.locator('[data-id="user"] .message-submission').count(), 0);
  assert.equal(await page.locator('[data-id="user"] details').count(), 0);
  await page.locator('#prompt').fill('Original design request');
  await page.locator('#submission-button').click();
  await page.locator('#submission-menu [data-workflow="design"]').click();
  const sent = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1));
  await page.locator('#pending-queue-toggle').click();
  assert.match(await page.locator('#pending-message-queue').innerText(), /Design/);
  const submission = { taskMode: 'direct', businessMode: 'design', goal: false, guidance: '\n\nExact app-added guidance <script>unsafe()</script>' };
  await page.evaluate(({ sent, submission }) => window.postMessage({ type: 'chat.started', id: sent.id, text: sent.text, attachments: [], submission }, '*'), { sent, submission });
  const message = page.locator(`[data-id="${sent.id}"]`);
  await message.waitFor();
  assert.equal(await message.locator('.message-submission').innerText(), 'Design');
  assert.match(await message.innerText(), /Original design request/);
  assert.equal(await message.locator('details').getAttribute('open'), null);
  await message.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await message.locator('details').evaluate(el => el.open), true);
  assert.equal(await message.locator('pre').textContent(), submission.guidance);
  assert.equal(await message.locator('script').count(), 0);
  for (const [id, metadata, expected] of [
    ['ordinary-submission', { taskMode: 'direct', businessMode: 'normal', goal: false }, ''],
    ['goal-submission', { taskMode: 'direct', businessMode: 'normal', goal: true }, 'Goal'],
    ['action-submission', { taskMode: 'plan-work', businessMode: 'normal', goal: false }, 'Plan → Work'],
    ['legacy-submission', undefined, '']
  ]) {
    await page.evaluate(({ id, metadata }) => window.postMessage({ type: 'chat.started', id, text: id, attachments: [], submission: metadata }, '*'), { id, metadata });
    const row = page.locator(`[data-id="${id}"]`);
    await row.waitFor();
    assert.equal(expected ? await row.locator('.message-submission').innerText() : await row.locator('.message-submission').count(), expected || 0);
    assert.equal(await row.locator('details').count(), 0);
  }
  const saved = await page.evaluate(() => window.saved);
  await page.evaluate(() => window.postMessage({ type: 'chat.started', id: 'compact-guidance', text: 'ordinary-submission', attachments: [], submission: { taskMode: 'direct', businessMode: 'normal', guidance: 'Delivered instructions' } }, '*'));
  const compact = page.locator('[data-id="compact-guidance"]');
  await compact.waitFor();
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const plainBox = await page.locator('[data-id="ordinary-submission"]').boundingBox();
    const compactBox = await compact.boundingBox();
    const toggleBox = await compact.locator('summary').boundingBox();
    assert.equal(compactBox.height, plainBox.height, 'Collapsed guidance must not add a row');
    assert.ok(toggleBox.y >= compactBox.y && toggleBox.y + toggleBox.height <= compactBox.y + compactBox.height);
    assert.ok(toggleBox.x + toggleBox.width <= compactBox.x + compactBox.width);
  }
  await compact.locator('summary').click();
  assert.equal(await compact.locator('pre').isVisible(), true);
  await compact.locator('summary').click();
  assert.equal(await compact.locator('pre').isVisible(), false);
  assert.deepEqual(saved.timeline.find(item => item.id === sent.id).submission, submission);
  await page.evaluate(saved => sessionStorage.setItem("submission-restoration-fixture", JSON.stringify(saved)), saved);
  await page.reload();
  await message.waitFor();
  assert.equal(await message.locator('.message-submission').innerText(), 'Design');
  assert.equal(await message.locator('pre').textContent(), submission.guidance);
  assert.equal(await message.locator('details').getAttribute('open'), null);
  assert.equal(await page.locator('[data-id="legacy-submission"] .message-submission').count(), 0);
}
module.exports = { checkMessageSubmission };

async function checkMessageLayout(page) {
  const text = ('작업·검증 루프를 실행해 주세요. 긴 요청과 첨부 설명이 다음 메시지와 겹치면 안 됩니다.\n').repeat(18);
  await page.evaluate(text => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline: [
    { type: 'user', id: 'layout-short', text: '이미지 아이콘을 확인해 주세요.' },
    { type: 'user', id: 'layout-long', text, submission: { taskMode: 'work-verification', guidance: text } },
    { type: 'assistant', id: 'layout-answer', phase: 'final', text: '확인 결과입니다.\n\n- Work 실행: `run-example`\n- 최종 판정: pass' }
  ] })), text);
  await page.reload();
  await page.locator('[data-id="layout-long"]').waitFor({ state: 'attached' });
  for (const width of [795, 360]) {
    await page.setViewportSize({ width, height: 420 });
    for (const open of [false, true, false]) {
      await page.locator('[data-id="layout-long"] details').evaluate((el, value) => { el.open = value; }, open);
      const collisions = await page.locator('#timeline > .message').evaluateAll(messages => messages.flatMap((message, index) => {
        const box = message.getBoundingClientRect();
        const content = message.querySelector('.message-content').getBoundingClientRect();
        const next = messages[index + 1]?.getBoundingClientRect();
        return content.bottom > box.bottom + 1 || (next && content.bottom > next.top + 1) ? [message.dataset.id] : [];
      }));
      assert.deepEqual(collisions, [], `Messages must retain their content height: width=${width}, expanded=${open}`);
    }
  }
}
module.exports.checkMessageLayout = checkMessageLayout;
