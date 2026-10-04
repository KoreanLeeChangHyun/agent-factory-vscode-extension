const assert = require('node:assert/strict');

async function checkComposerRendering(page) {
  const viewport = page.viewportSize();
  const geometry = () => page.evaluate(() => Object.fromEntries(
    ['#prompt', '.composer', '#timeline', '#notes-panel'].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return [selector, { y: rect.y, height: rect.height }];
    })
  ));
  await page.locator('#notes-toggle').click();
  for (const width of [360, 820, 1280]) {
    await page.setViewportSize({ width, height: 974 });
    const empty = await geometry();
    await page.locator('#prompt').fill('한 줄 입력');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await geometry(), empty, 'One-line drafts retain default heights');
    await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
    await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
    assert.deepEqual(await geometry(), empty, 'Compact run status must not shrink the transcript or notes');
    const status = await page.locator('#run-status-toggle').boundingBox();
    assert.ok(status.height > 0 && status.y + status.height <= empty['.composer'].y, 'Status remains above the composer');
    await page.locator('#prompt').fill('first\nsecond\nthird');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height > height, empty['#prompt'].height);
    assert.ok((await geometry())['#prompt'].height > empty['#prompt'].height, 'Multiline drafts still grow');
    await page.locator('#prompt').fill('');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height === height, empty['#prompt'].height);
    await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
    // The Main workflow header stays visible; completion hides only the loading indicator.
    await page.waitForFunction(() => document.querySelector('#agent-progress').hidden);
    assert.deepEqual(await geometry(), empty, 'Clearing and completing restores the same geometry');
  }
  await page.locator('#notes-close').click();
  await page.setViewportSize({ width: 721, height: 402 });
  const restingTimelinePadding = await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom);
  await page.evaluate(() => {
    document.querySelector('#companion-dock').hidden = false;
    document.querySelector('#factory-bot').hidden = false;
  });
  assert.equal(await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom), restingTimelinePadding,
    'Floating bot does not reserve transcript clearance');
  await page.evaluate(() => {
    document.querySelector('#companion-dock').hidden = true;
    document.querySelector('#factory-bot').hidden = true;
  });
  await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'Latest visible transcript line' }, '*'));
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
  // The Main workflow header is always shown, so its transcript clearance is already in place before loading starts.
  assert.equal(await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom), restingTimelinePadding,
    'Compact loading status keeps the header clearance');
  await page.evaluate(() => { const timeline = document.querySelector('#timeline'); timeline.scrollTop = timeline.scrollHeight; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const latestMessage = await page.locator('.message-assistant').last().boundingBox();
  const compactStatus = await page.locator('#run-status-toggle').boundingBox();
  assert.ok(latestMessage.y + latestMessage.height <= compactStatus.y,
    'Latest chat message stays above the compact loading status');
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.setViewportSize(viewport);
  const pendingRequests = Array.from({ length: 100 }, (_, i) => ({
    id: 'queued-' + i, text: 'Queued ' + i, attachments: [], rejected: i === 0,
    execution: { taskMode: 'direct', businessMode: 'normal', model: 'test-model', fast: false }
  }));
  await page.evaluate(pendingRequests => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ pendingRequests, timeline: [] })), pendingRequests);
  await page.reload();
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const queue = page.locator('#pending-message-queue');
  assert.equal(await queue.locator('*').count(), 0, 'Collapsed queues defer content creation');
  await page.locator('#pending-queue-toggle').click();
  assert.match(await queue.textContent(), /Queued 99/);
  const recover = queue.locator('[data-queue-recover]');
  assert.equal(await recover.isEnabled(), true);
  await page.evaluate(() => {
    window.originalQueueChild = document.querySelector('#pending-message-queue').firstChild;
    window.queueWrites = 0;
    new MutationObserver(records => { window.queueWrites += records.length; }).observe(document.querySelector('#pending-message-queue'), { childList: true, subtree: true });
  });
  for (let i = 0; i < 20; i++) {
    await page.locator('#prompt').fill('draft ' + i);
    await settle();
  }
  assert.equal(await recover.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.queueWrites), 0, 'Typing must not rebuild queued content');
  assert.equal(await page.evaluate(() => window.originalQueueChild === document.querySelector('#pending-message-queue').firstChild), true);
  await page.evaluate(() => {
    window.retainedRecover = document.querySelector('[data-queue-recover]');
  });
  await emit({ type: 'chat.rejected', id: 'queued-99' });
  assert.equal(await queue.locator('[data-queue-recover]').count(), 2);
  assert.equal(await page.evaluate(() => window.retainedRecover === document.querySelector('[data-queue-recover]')), true);
  await page.locator('#prompt').fill('   ');
  await settle();
  assert.equal(await recover.first().isEnabled(), true, 'Whitespace permits recovery');
  await recover.first().focus();
  await emit({ type: 'run.state', running: true });
  assert.equal(await page.evaluate(() => document.activeElement === window.retainedRecover), true, 'Run updates retain recovery focus');
  await recover.first().click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Queued 0');
  assert.equal(await queue.locator('[data-queue-recover]').count(), 1);
  await page.locator('#pending-queue-toggle').click();
  assert.equal(await queue.locator('*').count(), 0);
  await emit({ type: 'chat.rejected', id: 'queued-1' });
  assert.equal(await queue.locator('*').count(), 0, 'Hidden queue updates remain lazy');
  await page.locator('#pending-queue-toggle').click();
  assert.equal(await queue.locator('[data-queue-recover]').first().isDisabled(), true, 'Reopening reflects latest rejection and draft');
  await emit({ type: 'run.state', running: true });
  await page.locator('#prompt').fill('');
  await settle();
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /Stop/i);
  await page.locator('#prompt').fill('next');
  await settle();
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /queue/i);
  await emit({ type: 'run.state', running: false });
  await emit({ type: 'goal.updated', goal: { status: 'active', objective: 'Test goal' } });
  assert.equal(await page.locator('#goal-send-icon').isVisible(), true);
  assert.equal(await page.locator('#send-icon').isVisible(), false);
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /Goal active/);
  await emit({ type: 'run.state', running: true });
  await page.locator('#prompt').fill('');
  await settle();
  assert.equal(await page.locator('#stop-icon').isVisible(), true);
  assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
  await page.locator('#prompt').fill('next');
  await settle();
  assert.equal(await page.locator('#goal-send-icon').isVisible(), true);
  for (const status of ['paused', 'complete', 'blocked']) {
    await emit({ type: 'goal.updated', goal: { status } });
    assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
    assert.equal(await page.locator('#send-icon').isVisible(), true);
  }
  await emit({ type: 'goal.updated', goal: { status: 'active' }, error: 'Unavailable' });
  assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
  await emit({ type: 'goal.updated', goal: null });
  await emit({ type: 'run.state', running: false });
  console.log('Composer rendering: 100 queued messages, 20 input frames, 0 queue child mutations; lazy queue, recovery and send/stop controls passed.');
}
module.exports = { checkComposerRendering };
