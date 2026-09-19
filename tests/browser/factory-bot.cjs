const assert = require('node:assert/strict');

async function checkFactoryBot(page) {
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  // Sample actual rendered transforms at the gesture handoff, not just CSS names.
  const motion = await page.evaluate(() => {
    const probe = document.querySelector('#factory-bot').cloneNode(true);
    probe.removeAttribute('id');
    probe.removeAttribute('hidden');
    probe.dataset.state = 'idle';
    probe.dataset.animations = 'true';
    probe.style.opacity = '0';
    document.body.append(probe);
    const parts = ['.bot-body', '.bot-arm-left', '.bot-arm-right', '.bot-eyes'];
    function offset(time) {
      for (const animation of probe.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
      return Math.max(...parts.map(selector => {
        const matrix = new DOMMatrix(getComputedStyle(probe.querySelector(selector)).transform);
        return Math.max(Math.abs(matrix.a - 1), Math.abs(matrix.b), Math.abs(matrix.c),
          Math.abs(matrix.d - 1), Math.abs(matrix.e), Math.abs(matrix.f));
      }));
    }
    const samples = [];
    for (const gesture of ['breathe', 'stretch', 'coffee', 'read', 'bow', 'look', 'balance', 'wave', 'shy', 'dance']) {
      probe.dataset.gesture = gesture;
      samples.push({ gesture, start: offset(0), end: offset(7999) });
    }
    delete probe.dataset.gesture;
    probe.dataset.state = 'complete';
    samples.push({ gesture: 'complete', start: offset(0), end: offset(2399) });
    // Completion's breathing body is independent; check its waving arm separately.
    const arm = probe.querySelector('.bot-arm-right');
    samples[samples.length - 1].end = Math.abs(new DOMMatrix(getComputedStyle(arm).transform).b);
    probe.remove();
    return samples;
  });
  for (const sample of motion) {
    assert.ok(sample.start < .01 && sample.end < .01, `${sample.gesture} should enter and leave near neutral: ${JSON.stringify(sample)}`);
  }
  const bot = page.locator('#factory-bot');
  const state = () => bot.getAttribute('data-state');
  await emit({ type: 'host.initialize', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  assert.equal(await state(), 'idle');
  const menu = page.locator('#bot-menu');
  const sentBefore = await page.evaluate(() => window.sentMessages.length);
  for (const action of ['wave', 'dance', 'stretch']) {
    await bot.click();
    assert.equal(await menu.isVisible(), true);
    await menu.locator(`[data-bot-action="${action}"]`).click();
    assert.equal(await bot.getAttribute('data-gesture'), action);
    assert.equal(await menu.isVisible(), false);
  }
  await bot.click();
  await menu.locator('[data-bot-action="sleep"]').click();
  assert.equal(await state(), 'sleeping');
  await bot.click();
  assert.equal(await state(), 'idle');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await bot.evaluate(el => el === document.activeElement), true);
  await bot.press('Enter');
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('Enter');
  assert.equal(await bot.getAttribute('data-gesture'), 'wave');
  assert.equal(await menu.isVisible(), false);
  await bot.click();
  await page.locator('#prompt').click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => window.sentMessages.length), sentBefore, 'Bot actions send no work requests');
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 700 });
    await bot.click();
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0);
    await page.keyboard.press('Escape');
  }

  await emit({ type: 'bot.mood', mood: 'curious' });
  assert.equal(await bot.getAttribute('data-mood'), 'curious');
  assert.match(await bot.getAttribute('title'), /Luna/);
  await emit({ type: 'bot.mood', mood: '<script>' });
  assert.equal(await bot.getAttribute('data-mood'), '');
  await emit({ type: 'bot.mood', unavailable: true });
  assert.match(await bot.getAttribute('title'), /Luna unavailable/);
  await emit({ type: 'run.state', running: true });
  assert.equal(await state(), 'working');
  await bot.click();
  assert.equal(await menu.locator('button:disabled').count(), 4);
  await page.keyboard.press('Escape');
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
    for (const expanded of [false, true]) {
      await page.locator('#run-details').evaluate((el, expanded) => { el.hidden = !expanded; }, expanded);
      const box = await bot.boundingBox();
      const composer = await page.locator('.composer').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.ok(box.y + box.height <= composer.y + 5, 'Bot stays above the composer even with expanded details');
      if (expanded) {
        const details = await page.locator('#run-details').boundingBox();
        assert.ok(box.y < details.y + details.height, 'Bot overlaps details without adding a spacer');
        const inFront = await bot.evaluate((el, details) => {
          const box = el.getBoundingClientRect();
          const x = box.x + box.width / 2;
          const y = (Math.max(box.top, details.y) + Math.min(box.bottom, details.y + details.height)) / 2;
          return el.contains(document.elementFromPoint(x, y));
        }, details);
        assert.ok(inFront, 'Bot is painted in front of the overlapping workflow panel');
      }
    }
    await page.locator('#run-details').evaluate(el => { el.hidden = true; });
  }
  await page.clock.install();
  assert.equal(await bot.evaluate(el => el.tagName), 'BUTTON');
  await bot.click();
  assert.equal(await state(), 'working', 'Clicking must preserve the active task state');
  assert.equal(await bot.getAttribute('data-reacting'), 'true');
  assert.equal(await bot.locator('svg').evaluate(el => getComputedStyle(el).animationName), 'bot-click');
  await page.clock.fastForward(400);
  await bot.click();
  await page.clock.fastForward(400);
  assert.equal(await bot.getAttribute('data-reacting'), 'true', 'Repeated clicks renew the response');
  await page.clock.fastForward(300);
  assert.equal(await bot.getAttribute('data-reacting'), null);
  for (const key of ['Enter', 'Space']) {
    await bot.focus();
    await bot.press(key);
    assert.equal(await bot.getAttribute('data-reacting'), 'true', 'Keyboard activation responds');
    await page.clock.fastForward(700);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bot.click();
  assert.equal(await bot.locator('svg').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.notEqual(await bot.locator('svg').evaluate(el => getComputedStyle(el).filter), 'none', 'Reduced motion retains static feedback');
  await page.clock.fastForward(700);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await emit({ type: 'run.state', running: false });
  const movePointer = async (roll, x = 0) => page.evaluate(({ roll, x }) => {
    const random = Math.random;
    Math.random = () => roll;
    try { document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: x, clientY: 0 })); }
    finally { Math.random = random; }
  }, { roll, x });
  await movePointer(0.9);
  assert.equal(await bot.getAttribute('data-glance'), null, 'A probability miss stays idle');
  await movePointer(0);
  assert.equal(await bot.getAttribute('data-glance'), null, 'Repeated events cannot bypass a miss cooldown');
  await page.clock.fastForward(12000);
  await movePointer(0);
  assert.equal(await bot.getAttribute('data-glance'), 'true');
  const left = await bot.evaluate(el => parseFloat(el.style.getPropertyValue('--bot-glance-x')));
  assert.ok(left < 0, 'Eyes look toward the pointer on the left');
  await page.clock.fastForward(1500);
  assert.equal(await bot.getAttribute('data-glance'), null, 'Glance ends automatically');
  await movePointer(0);
  assert.equal(await bot.getAttribute('data-glance'), null, 'Successful glances also have a cooldown');
  await page.clock.fastForward(10500);
  await movePointer(0, 1000);
  assert.ok(await bot.evaluate(el => parseFloat(el.style.getPropertyValue('--bot-glance-x'))) > 0);
  await emit({ type: 'run.state', running: true });
  assert.equal(await bot.getAttribute('data-glance'), null, 'Work interrupts the glance');
  await page.clock.fastForward(12000);
  await movePointer(0);
  assert.equal(await bot.getAttribute('data-glance'), null, 'Working does not react');
  await emit({ type: 'run.state', running: false });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await movePointer(0);
  assert.equal(await bot.getAttribute('data-glance'), null, 'Reduced motion disables glances');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bot.dispatchEvent('pointerenter');
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
  await bot.dispatchEvent('click');
  assert.equal(await state(), 'idle', 'Click wakes the sleeping bot');
  assert.equal(await bot.getAttribute('data-reacting'), 'true');
  await page.clock.fastForward(700);
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
