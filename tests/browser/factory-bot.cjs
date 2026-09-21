const assert = require('node:assert/strict');

async function checkFactoryBot(page) {
  const propMotion = await page.evaluate(() => {
    return [['coffee', '.bot-cup'], ['read', '.bot-book-page'], ['feed', '.bot-spoon']].map(([gesture, selector]) => {
      const probe = document.querySelector('#factory-bot').cloneNode(true);
      probe.removeAttribute('id'); probe.removeAttribute('hidden');
      probe.dataset.state = 'idle'; probe.dataset.gesture = gesture;
      probe.dataset.animations = 'true'; probe.style.opacity = '0'; document.body.append(probe);
      const part = probe.querySelector(selector);
      const animation = part.getAnimations()[0]; animation.pause();
      const at = time => { animation.currentTime = time; return getComputedStyle(part).transform; };
      const start = at(0), middle = at(2200), end = at(4000);
      probe.dataset.animations = 'false';
      const disabled = part.getAnimations().length;
      probe.dataset.state = 'working';
      const hiddenDuringWork = getComputedStyle(probe.querySelector('.bot-body')).display === 'none';
      probe.remove(); return { gesture, start, middle, end, disabled, hiddenDuringWork };
    });
  });
  for (const sample of propMotion) {
    assert.notEqual(sample.start, sample.middle, `${sample.gesture} moves its prop`);
    assert.equal(sample.start, sample.end, `${sample.gesture} returns smoothly for repetition`);
    assert.equal(sample.disabled, 0);
    assert.equal(sample.hiddenDuringWork, true);
  }
  // Verify rendered geometry changes continuously, independently of rotation.
  const curves = await page.evaluate(() => {
    const samples = [];
    for (const gesture of ['breathe', 'wave', 'stretch', 'dance', 'complete']) {
      const probe = document.querySelector('#factory-bot').cloneNode(true);
      probe.removeAttribute('id'); probe.removeAttribute('hidden');
      probe.dataset.state = gesture === 'complete' ? 'complete' : 'idle';
      probe.dataset.gesture = gesture; probe.dataset.animations = 'true';
      probe.style.opacity = '0'; document.body.append(probe);
      const shape = probe.querySelector('.bot-arm-right .bot-arm-shape');
      const flex = shape.getAnimations()[0];
      flex.pause();
      const duration = Number(flex.effect.getTiming().duration);
      const at = fraction => {
        flex.currentTime = duration * fraction;
        return getComputedStyle(shape).d;
      };
      const start = at(0), between = at(.09), bent = at(.5), end = at(1);
      const wavePoses = [.2, .32, .45, .57, .66, .78].map(at);
      probe.dataset.animations = 'false';
      const disabled = shape.getAnimations().length;
      samples.push({ gesture, start, between, bent, end, disabled, wavePoses });
      probe.remove();
    }
    return samples;
  });
  for (const sample of curves) {
    assert.notEqual(sample.start, sample.bent, `${sample.gesture} changes curvature`);
    assert.notEqual(sample.between, sample.start, 'Curvature interpolates from rest');
    assert.notEqual(sample.between, sample.bent, 'Curvature does not jump to the target');
    assert.equal(sample.end, sample.start, 'Curvature returns to rest');
    assert.equal(sample.disabled, 0, 'Animation preference disables morphing');
  }
  assert.equal(curves[1].bent, curves[2].bent, 'Waving keeps the arm extended');
  for (const sample of curves.filter(item => ['wave', 'complete'].includes(item.gesture))) {
    for (const pose of sample.wavePoses) {
      assert.equal(pose, curves[2].bent, `${sample.gesture} stays extended throughout the wave`);
    }
  }
  const wristMotion = await page.evaluate(() => {
    return ['wave', 'complete', 'cheerful'].map(mode => {
      const probe = document.querySelector('#factory-bot').cloneNode(true);
      probe.removeAttribute('id'); probe.removeAttribute('hidden');
      probe.dataset.state = mode === 'complete' ? 'complete' : 'idle';
      delete probe.dataset.gesture; delete probe.dataset.mood;
      if (mode === 'wave') probe.dataset.gesture = 'wave';
      if (mode === 'cheerful') probe.dataset.mood = 'cheerful';
      probe.dataset.animations = 'true'; probe.style.opacity = '0'; document.body.append(probe);
      const arm = probe.querySelector('.bot-arm-right');
      const hand = probe.querySelector('.bot-wave-hand');
      const animations = probe.getAnimations({ subtree: true });
      animations.forEach(animation => animation.pause());
      const duration = mode === 'wave' ? 4000 : 2400;
      const samples = [.3, .42, .54, .66].map(fraction => {
        animations.forEach(animation => { animation.currentTime = duration * fraction; });
        const origin = new DOMPoint(34, 34);
        const wrist = origin.matrixTransform(new DOMMatrix(getComputedStyle(hand).transform)
          .translate(-34, -34));
        return { arm: getComputedStyle(arm).transform, hand: getComputedStyle(hand).transform,
          opacity: getComputedStyle(hand).opacity, origin: getComputedStyle(hand).transformOrigin,
          wrist: [wrist.x, wrist.y] };
      });
      probe.dataset.animations = 'false';
      const disabled = hand.getAnimations().length;
      probe.remove(); return { mode, samples, disabled };
    });
  });
  for (const { mode, samples, disabled } of wristMotion) {
    assert.equal(new Set(samples.map(sample => sample.arm)).size, 1, `${mode}: raised shoulder stays still`);
    assert.equal(new Set(samples.map(sample => sample.hand)).size, 2, `${mode}: wrist waves both ways`);
    for (const sample of samples) {
      assert.equal(sample.opacity, '1');
      assert.equal(sample.origin, '34px 34px');
      assert.ok(Math.hypot(...sample.wrist) < .001, 'Wrist rotation preserves its attachment point');
    }
    assert.equal(disabled, 0);
  }
  const dance = await page.evaluate(() => {
    const probe = document.querySelector('#factory-bot').cloneNode(true);
    probe.removeAttribute('id'); probe.removeAttribute('hidden');
    probe.dataset.state = 'idle'; probe.dataset.gesture = 'dance';
    probe.dataset.animations = 'true'; probe.style.opacity = '0'; document.body.append(probe);
    const body = probe.querySelector('.bot-body');
    const arms = [...probe.querySelectorAll('.bot-arm')];
    const animations = probe.getAnimations({ subtree: true });
    animations.forEach(animation => animation.pause());
    const beats = [];
    let lowestClearance = Infinity;
    for (let time = 0; time <= 1600; time += 20) {
      animations.forEach(animation => { animation.currentTime = time; });
      // Sample every arm segment in body coordinates, including interpolated poses.
      for (const arm of arms) {
        const shape = arm.querySelector('.bot-arm-shape');
        const matrix = body.getCTM().inverse().multiply(shape.getCTM());
        for (let i = 0; i <= 10; i++) {
          const point = shape.getPointAtLength(shape.getTotalLength() * i / 10);
          lowestClearance = Math.min(lowestClearance, new DOMPoint(point.x, point.y).matrixTransform(matrix).y);
        }
      }
      if (time % 400 === 0) beats.push([body, ...arms].map(part => {
        const matrix = new DOMMatrix(getComputedStyle(part).transform);
        return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
      }));
    }
    const durations = [body, ...arms].map(part => getComputedStyle(part).animationDuration);
    probe.remove(); return { beats, lowestClearance, durations };
  });
  assert.ok(dance.lowestClearance >= 24, 'Dancing arms stay below the face throughout the cycle');
  assert.equal(new Set(dance.durations).size, 1, 'Body and arms share a beat');
  for (const index of [0, 2, 4]) {
    assert.ok(dance.beats[index].every(angle => Math.abs(angle) < .01), 'Dance passes through neutral on each half-cycle');
  }
  assert.ok(dance.beats[1][0] < 0 && dance.beats[3][0] > 0, 'Body alternates left and right');
  assert.ok(dance.beats[1][1] > dance.beats[3][1], 'Left arm accents the left beat');
  assert.ok(dance.beats[3][2] < dance.beats[1][2], 'Right arm accents the right beat');
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  // Sample actual rendered transforms at the gesture handoff, not just CSS names.
  const motion = await page.evaluate(() => {
    let probe;
    function freshProbe() {
      probe?.remove();
      probe = document.querySelector('#factory-bot').cloneNode(true);
      probe.removeAttribute('id');
      probe.removeAttribute('hidden');
      probe.dataset.state = 'idle';
      probe.dataset.animations = 'true';
      probe.style.opacity = '0';
      document.body.append(probe);
    }
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
      // Script-paused CSS animations can outlive a selector change. Isolate each pose.
      freshProbe();
      probe.dataset.gesture = gesture;
      samples.push({ gesture, start: offset(0), end: offset(7999) });
    }
    freshProbe();
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
  // The one-pixel sleeping movement remains animated, but changes at most
  // 30 times per two-second half-cycle instead of every display frame.
  const sleepMotion = await page.evaluate(() => {
    const probe = document.querySelector('#factory-bot').cloneNode(true);
    probe.removeAttribute('id'); probe.removeAttribute('hidden');
    probe.dataset.state = 'sleeping'; probe.dataset.animations = 'true';
    probe.style.opacity = '0'; document.body.append(probe);
    const body = probe.querySelector('.bot-body');
    const marks = probe.querySelector('.bot-sleep-marks');
    const animations = probe.getAnimations({ subtree: true });
    animations.forEach(a => a.pause());
    const positions = new Set();
    for (let time = 0; time <= 2000; time += 10) {
      animations.forEach(a => { a.currentTime = time; });
      positions.add(getComputedStyle(body).transform);
    }
    const result = { positions: positions.size,
      bodyTiming: getComputedStyle(body).animationTimingFunction,
      marksTiming: getComputedStyle(marks).animationTimingFunction,
      duration: getComputedStyle(body).animationDuration };
    probe.remove(); return result;
  });
  assert.ok(sleepMotion.positions > 1 && sleepMotion.positions <= 31, JSON.stringify(sleepMotion));
  assert.match(sleepMotion.bodyTiming, /steps\(30(?:, end)?\)/);
  assert.match(sleepMotion.marksTiming, /steps\(30(?:, end)?\)/);
  assert.equal(sleepMotion.duration, '4s');
  const bot = page.locator('#factory-bot');
  const state = () => bot.getAttribute('data-state');
  await emit({ type: 'host.initialize', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  assert.equal(await state(), 'idle');
  const menu = page.locator('#bot-menu');
  const localizedActions = await menu.evaluate(element => {
    const copy = element.cloneNode(true);
    return ['ko', 'en'].map(language => {
      window.AgentFactoryI18n.apply(copy, language);
      return { icons: copy.querySelectorAll('button > svg').length,
        labels: ['feed', 'play', 'sleep'].map(action => copy.querySelector(`[data-bot-action="${action}"] span`).textContent) };
    });
  });
  assert.deepEqual(localizedActions, [
    { icons: 4, labels: ['밥 주기', '놀아주기', '잠자기'] },
    { icons: 4, labels: ['Feed the bot', 'Play together', 'Sleep'] }
  ]);
  const sentBefore = await page.evaluate(() => window.sentMessages.length);
  for (const action of ['feed', 'play']) {
    await bot.click();
    assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.locator(`[data-bot-action="${action}"] svg[aria-hidden="true"]`).count(), 1);
    assert.ok((await menu.locator(`[data-bot-action="${action}"] span`).innerText()).trim());
    await menu.locator(`[data-bot-action="${action}"]`).click();
    const gesture = await bot.getAttribute('data-gesture');
    if (action === 'play') assert.ok(['dance', 'balance', 'stretch', 'wave', 'read'].includes(gesture));
    else assert.equal(gesture, action);
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
  assert.equal(await bot.getAttribute('data-gesture'), 'feed');
  assert.equal(await menu.isVisible(), false);
  await bot.click();
  await page.locator('#prompt').click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => window.sentMessages.length), sentBefore, 'Bot actions send no work requests');
  for (const [width, height] of [[360, 400], [360, 700], [795, 700]]) {
    await page.setViewportSize({ width, height });
    await bot.click();
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height);
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
  assert.equal(await menu.locator('[data-bot-action]:disabled').count(), 3);
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
  for (const [gesture, prop] of [['coffee', '.bot-cup'], ['read', '.bot-book'], ['feed', '.bot-meal']]) {
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
  await emit({ type: 'bots.updated', enabled: false });
  assert.equal(await bot.isVisible(), false);
  assert.equal(await page.locator('#bots-disabled').isChecked(), true);
  assert.equal(await page.locator('#bot-visible').isDisabled(), true);
  await emit({ type: 'bot.mood', mood: 'cheerful' });
  await emit({ type: 'run.state', running: true });
  await page.clock.fastForward(120000);
  assert.equal(await bot.isVisible(), false);
  assert.equal(await bot.getAttribute('data-mood'), null);
  assert.equal(await bot.evaluate(el => el.getAnimations({subtree:true}).length), 0);
  await emit({ type: 'bots.updated', enabled: true });
  assert.equal(await bot.isVisible(), true);
  assert.equal(await page.locator('#bot-visible').isDisabled(), false);
  await page.locator('#bots-disabled').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change')); });
  assert.equal(await bot.isVisible(), false);
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => m.type === 'bots.configure' && m.enabled === false)), true);
  await emit({ type: 'host.initialize', botsEnabled: false, runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  assert.equal(await bot.isVisible(), false, 'host preference survives initialization');

  await emit({ type: 'host.initialize', botsEnabled: true, runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'run.state', running: false });
  const careStress = await page.evaluate(() => {
    const bot = document.querySelector('#factory-bot');
    const menu = document.querySelector('#bot-menu');
    const start = { ...window.saved.botCare };
    const nodes = document.querySelectorAll('*').length;
    const pending = new Set();
    const set = window.setTimeout, clear = window.clearTimeout;
    window.setTimeout = function (callback, delay, ...args) {
      const id = set(callback, delay, ...args);
      if (callback.name === 'renderBotCare') pending.add(id);
      return id;
    };
    window.clearTimeout = function (id) { pending.delete(id); return clear(id); };
    let peakTimers = 0;
    const played = [];
    const random = Math.random;
    try {
      for (let index = 0; index < 200; index++) {
        Math.random = () => [0, .25, .5, .75, .999][Math.floor(index / 20) % 5];
        bot.click();
        peakTimers = Math.max(peakTimers, pending.size);
        menu.querySelector(`[data-bot-action="${index % 2 ? 'play' : 'feed'}"]`).click();
        if (index % 2) played.push(bot.dataset.gesture);
      }
      const after = { ...window.saved.botCare };
      const closedTimers = pending.size;
      bot.click();
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const hiddenTimers = pending.size;
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { start, after, peakTimers, closedTimers, hiddenTimers, played,
        bytes: new TextEncoder().encode(JSON.stringify(after)).length,
        addedNodes: document.querySelectorAll('*').length - nodes };
    } finally { window.setTimeout = set; window.clearTimeout = clear; Math.random = random; }
  });
  assert.deepEqual([...new Set(careStress.played)].sort(), ['balance', 'dance', 'read', 'stretch', 'wave']);
  assert.ok(careStress.played.every((activity, index, list) => index === 0 || activity !== list[index - 1]),
    'Play does not repeat its last activity, even with feeding in between');
  assert.equal(careStress.after.careCount, careStress.start.careCount + 200);
  assert.equal(careStress.after.fullness, 100);
  assert.equal(careStress.after.happiness, 100);
  assert.ok(careStress.after.energy >= 0 && careStress.after.energy <= 100);
  assert.equal(careStress.peakTimers, 1);
  assert.equal(careStress.closedTimers, 0);
  assert.equal(careStress.hiddenTimers, 0);
  assert.equal(careStress.addedNodes, 0);
  assert.ok(careStress.bytes < 256);
  console.log(`Bot care: 200 interactions, ${careStress.bytes} saved bytes, no added DOM nodes; care timers open/closed/hidden = 1/0/0.`);
  // Reopen the same panel from its serialized state; absence is restorative.
  await page.evaluate(() => {
    window.saved.botCare.updatedAt = Date.now() - 3600000;
    sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved));
  });
  await page.reload();
  await emit({ type: 'host.initialize', botsEnabled: true, runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await bot.click();
  assert.equal(await page.locator('#bot-fullness').evaluate(el => el.value), 100);
  assert.equal(await page.locator('#bot-energy').evaluate(el => el.value), 100);
  assert.match(await page.locator('#bot-care-growth').innerText(), new RegExp(String(careStress.after.careCount)));
  if (process.env.BOT_CARE_SCREENSHOT) await menu.screenshot({ path: process.env.BOT_CARE_SCREENSHOT });

}
module.exports = { checkFactoryBot };
