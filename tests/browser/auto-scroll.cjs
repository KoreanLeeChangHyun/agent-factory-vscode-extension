const assert = require('node:assert/strict');

async function checkAutoScroll(page) {
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async message => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
    await settle();
  };
  const toggle = page.locator('#auto-scroll-button');
  await emit({ type: 'chat.assistant', text: Array.from({ length: 60 }, (_, i) => 'Reading line ' + i).join('\n\n') });
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
  await toggle.click();
  await settle();
  const bottom = await page.locator('#timeline').evaluate(element => {
    window.scrollWrites = 0;
    window.readingNode = element.querySelector('.message');
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { window.scrollWrites++; descriptor.set.call(this, value); }
    });
    return { top: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop };
  });
  assert.ok(bottom.top > 0 && Math.abs(bottom.gap) <= 1);
  await toggle.click();
  await settle();
  assert.equal(await page.locator('#timeline').evaluate(element => element.scrollTop), bottom.top, 'OFF at bottom must not jump');
  await emit({ type: 'chat.assistant', text: 'New content while OFF' });
  await emit({ type: 'chat.started', id: 'scroll-queued-input', text: 'Accepted queued input', attachments: [] });
  assert.equal(await page.evaluate(() => window.scrollWrites), 0, 'OFF must not write transcript scrollTop');
  assert.equal(await page.evaluate(() => window.readingNode === document.querySelector('#timeline .message')), true, 'Unchanged reading DOM must remain mounted');
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 150; window.scrollWrites = 0; });
  await settle();
  await emit({ type: 'run.activity', id: 'scroll-stream', category: 'command', phase: 'started', text: 'echo progress', output: 'first' });
  await emit({ type: 'run.activity', id: 'scroll-stream', category: 'command', phase: 'completed', text: 'echo progress', output: 'first\nsecond\nthird' });
  await emit({ type: 'agents.list', agents: [] });
  assert.equal(await page.locator('#timeline').evaluate(element => element.scrollTop), 150);
  assert.equal(await page.evaluate(() => window.scrollWrites), 0);
  await emit({ type: 'host.initialize', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  for (const method of ['Enter', 'button']) {
    await page.locator('#prompt').fill('Send while automatic scrolling is OFF: ' + method);
    await page.locator('#timeline').evaluate(element => { element.scrollTop = 150; window.scrollWrites = 0; });
    await settle();
    const sendsBefore = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length);
    if (method === 'Enter') await page.locator('#prompt').press('Enter');
    else await page.locator('#send-button').click();
    await settle();
    assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length), sendsBefore + 1);
    assert.ok(await page.locator('#timeline').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1), 'Sending while OFF must reveal the bottom');
    assert.equal(await page.evaluate(() => window.scrollWrites), 1, 'Sending while OFF must scroll once');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.saved.autoScroll), false);
    await page.evaluate(() => { window.scrollWrites = 0; });
    const sent = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1));
    await emit({ type: 'chat.started', id: sent.id, text: sent.text, attachments: [] });
    assert.ok(await page.locator('#timeline').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop <= 1), 'Acceptance reveals the newly inserted request');
    assert.equal(await page.evaluate(() => window.scrollWrites), 1, 'Local submission acceptance scrolls once');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => { window.scrollWrites = 0; });
    await emit({ type: 'chat.started', id: sent.id, text: sent.text, attachments: [] });
    assert.equal(await page.evaluate(() => window.scrollWrites), 0, 'Replayed acceptance must not jump again');
    await emit({ type: 'chat.assistant', text: 'Streaming after send\n\nMore content' });
    await emit({ type: 'run.activity', id: 'after-send-' + method, category: 'command', phase: 'started', text: 'echo progress', output: 'first' });
    assert.equal(await page.evaluate(() => window.scrollWrites), 0, 'Streaming after acceptance keeps automatic scrolling OFF');
  }
  await toggle.click();
  await settle();
  assert.ok(await page.locator('#timeline').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1));
  const indicator = page.locator('#auto-scroll-state');
  assert.equal(await indicator.getAttribute('data-state'), 'following');
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 150; });
  await settle();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await indicator.getAttribute('data-state'), 'paused');
  const originalViewport = page.viewportSize();
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 740 });
    await settle();
    const jump = await page.locator('#jump-to-bottom').boundingBox();
    const bot = await page.locator('#factory-bot').boundingBox();
    assert.ok(jump && bot);
    assert.ok(Math.abs(jump.x + jump.width / 2 - bot.x - bot.width / 2) <= 1, 'Jump button must align above the bot');
    assert.ok(jump.y + jump.height + 6 <= bot.y, 'Jump button must not overlap the bot');
  }
  await page.setViewportSize(originalViewport);
  await settle();
  await emit({ type: 'chat.assistant', text: 'New response while reading older content' });
  assert.equal(await page.locator('#timeline').evaluate(element => element.scrollTop), 150);
  await page.locator('#jump-to-bottom').click();
  await settle();
  assert.equal(await indicator.getAttribute('data-state'), 'following');
  await emit({ type: 'chat.assistant', text: 'Following again\n\nMore content' });
  await page.waitForFunction(() => {
    const element = document.querySelector('#timeline');
    return Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1;
  }, undefined, { timeout: 2000 });
  await toggle.click();
  assert.equal(await indicator.isVisible(), false);
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 150; });
  await settle();
  await page.locator('#jump-to-bottom').click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await indicator.isVisible(), false);
}

module.exports = { checkAutoScroll };
