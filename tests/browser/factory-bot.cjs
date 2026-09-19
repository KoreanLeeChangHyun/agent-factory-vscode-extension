const assert = require('node:assert/strict');

async function checkFactoryBot(page) {
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const bot = page.locator('#factory-bot');
  const state = () => bot.getAttribute('data-state');
  await emit({ type: 'host.initialize', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  assert.equal(await state(), 'idle');
  await emit({ type: 'bot.mood', mood: 'curious' });
  assert.equal(await bot.getAttribute('data-mood'), 'curious');
  assert.match(await bot.getAttribute('title'), /Luna/);
  await emit({ type: 'bot.mood', mood: '<script>' });
  assert.equal(await bot.getAttribute('data-mood'), '');
  await emit({ type: 'bot.mood', unavailable: true });
  assert.match(await bot.getAttribute('title'), /Luna unavailable/);
  await emit({ type: 'run.state', running: true });
  assert.equal(await state(), 'working');
  await emit({ type: 'decision.pending', runId: 'bot-decision' });
  assert.equal(await state(), 'waiting');
  await emit({ type: 'run.state', running: false });
  assert.equal(await state(), 'waiting');
  await emit({ type: 'decision.pending', runId: null });
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'run.observed', status: 'completed' });
  assert.equal(await state(), 'working', 'Do not celebrate before the run has stopped');
  await emit({ type: 'run.state', running: false });
  assert.equal(await state(), 'complete');
  await page.waitForFunction(() => document.querySelector('#factory-bot').dataset.state === 'idle');
  for (const status of ['failed', 'cancelled']) {
    await emit({ type: 'run.state', running: true });
    await emit({ type: 'run.observed', status });
    await emit({ type: 'run.state', running: false });
    assert.notEqual(await state(), 'complete');
  }
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'run.observed', status: 'completed' });
  await emit({ type: 'host.notice', level: 'error', text: 'Result could not be read' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await state(), 'error');
  await emit({ type: 'run.state', running: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animations = await bot.locator('*').evaluateAll(elements => elements.map(el => getComputedStyle(el).animationName));
  assert.ok(animations.every(name => name === 'none'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 700 });
    const box = await bot.boundingBox();
    const composer = await page.locator('.composer').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    assert.ok(box.y + box.height <= composer.y + 5);
  }
  await page.clock.install();
  await emit({ type: 'run.state', running: false });
  const firstGesture = await bot.getAttribute('data-gesture');
  await page.clock.fastForward(8000);
  assert.notEqual(await bot.getAttribute('data-gesture'), firstGesture, 'Idle gestures rotate without a repeated pose');
  for (const [gesture, prop] of [['coffee', '.bot-cup'], ['read', '.bot-book']]) {
    await bot.evaluate((element, gesture) => { element.dataset.gesture = gesture; }, gesture);
    assert.equal(await bot.locator(prop).evaluate(el => getComputedStyle(el).display), 'inline');
  }
  await bot.dispatchEvent('pointerenter');
  await page.clock.fastForward(45000);
  assert.equal(await state(), 'drowsy');
  assert.equal(await bot.getAttribute('data-gesture'), null);
  await page.clock.fastForward(15000);
  assert.equal(await state(), 'sleeping');
  await emit({ type: 'bot.mood', mood: 'cheerful' });
  assert.equal(await state(), 'sleeping', 'Luna expressions must not wake the sleeping bot');
  await bot.dispatchEvent('pointerenter');
  assert.equal(await state(), 'idle');
  await page.clock.fastForward(60000);
  assert.equal(await state(), 'sleeping');
  await page.locator('#prompt').dispatchEvent('input');
  assert.equal(await state(), 'idle');
  await page.clock.fastForward(60000);
  await emit({ type: 'run.state', running: true });
  assert.equal(await state(), 'working');
  await page.clock.fastForward(120000);
  assert.equal(await state(), 'working');
  await emit({ type: 'decision.pending', runId: 'sleep-decision' });
  await page.clock.fastForward(120000);
  assert.equal(await state(), 'waiting');
  await emit({ type: 'decision.pending', runId: null });
  await emit({ type: 'host.initialize', runtimeAvailable: false, capabilities: { submit: {}, send: {} } });
  assert.equal(await state(), 'offline');
}
module.exports = { checkFactoryBot };
