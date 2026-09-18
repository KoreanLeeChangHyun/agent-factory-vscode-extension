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
