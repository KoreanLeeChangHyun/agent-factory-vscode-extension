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
  await toggle.click();
  await settle();
  assert.ok(await page.locator('#timeline').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1));
  await emit({ type: 'chat.assistant', text: 'Following again\n\nMore content' });
  assert.ok(await page.locator('#timeline').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1));
}

module.exports = { checkAutoScroll };
