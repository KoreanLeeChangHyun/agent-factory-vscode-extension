const assert = require('node:assert/strict');
exports.checkCompanion = async function (page, { careOnly = false } = {}) {
  const snapshot = { emotion: 'calm', action: 'call', reactionUntil: 0, lastInteractionAt: Date.now(), fullness: 80, happiness: 80, energy: 80, careCount: 0, updatedAt: Date.now() };
  const send = (companion, working = 0) => page.evaluate(({ companion, working }) => window.postMessage({ type: 'bot.companion', companion, working }, '*'), { companion, working });
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'companion-test', runtimeAvailable: true, running: false, botsEnabled: true, botPrompt: 'Lumi default personality', botDefaultPrompt: 'Lumi default personality', statusItems: [] }, '*'));
  await page.evaluate(() => window.postMessage({ type: 'models.list', models: ['gpt-6-sol', 'claude-sonnet-5', 'gemini-test'] }, '*'));
  await page.waitForFunction(() => !!document.querySelector('#bot-model option[value="gpt-6-sol"]'));
  assert.equal(await page.locator('#bot-model option[value="gemini-test"]').count(), 0);
  await page.locator('#bot-model').evaluate(el => { el.value = 'gpt-6-sol'; el.dispatchEvent(new Event('change')); });
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.model.save').at(-1).model), 'gpt-6-sol');
  await page.evaluate(() => window.postMessage({ type: 'bot.model.saved', model: 'gpt-6-sol' }, '*'));
  await page.waitForFunction(() => !document.querySelector('#bot-model').disabled);
  assert.equal(await page.locator('#bot-model').inputValue(), 'gpt-6-sol');
  await page.evaluate(() => window.postMessage({ type: 'bot.model.saved', model: '', failed: true }, '*'));
  await page.waitForFunction(() => document.querySelector('#bot-model').value === '');
  assert.match(await page.locator('#bot-model-status').textContent(), /Could not save/);
  await page.waitForFunction(() => document.querySelector('#bot-prompt').value === 'Lumi default personality');
  assert.equal(await page.locator('#bot-prompt-save').isDisabled(), true, 'Displayed default is already saved');
  const checkCareActions = async label => {
    for (const action of ['feed', 'play', 'sleep']) {
      const before = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').length);
      await page.locator('#factory-bot').click();
      await page.locator('[data-bot-action="' + action + '"]').click();
      assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').length), before + 1, label + ': ' + action);
      assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').at(-1).action), action);
      assert.equal(await page.locator('#bot-menu').isVisible(), false);
      if (action === 'play') {
        await page.evaluate(() => { const request = window.sentMessages.filter(m => m.type === 'bot.talk').at(-1); window.dispatchEvent(new MessageEvent('message', { data: { type: 'bot.reply', requestId: request.requestId, text: 'First quiz question', emotion: 'playful' } })); });
        await page.locator('#bot-speech-close').click();
      }

    }
  };
  await checkCareActions('Before the first snapshot, without petting');
  for (const [age, mode] of [[47000, 'drowsy'], [70000, 'sleeping']]) {
    await send({ ...snapshot, lastInteractionAt: Date.now() - age });
    await page.waitForFunction(mode => document.querySelector('#factory-bot').dataset.state === mode, mode);
    await checkCareActions(mode + ', without petting');
  }
  await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'factory', localCompanionAvailable: true }, '*'));
  await page.waitForFunction(() => !document.querySelector('#factory-bot').classList.contains('sd-companion'));
  await page.locator('#factory-bot').click();
  await page.locator('[data-bot-action="feed"]').click();
  assert.equal(await page.locator('#factory-bot').getAttribute('data-gesture'), 'feed', 'Sleeping Factory Bot can eat without being petted');
  for (const [action, gesture] of [['pet', 'shy'], ['praise', 'bow'], ['call', 'wave']]) {
    await page.locator('#factory-bot').click();
    assert.equal(await page.locator('.companion-actions button:visible').count(), 6);
    await page.locator('[data-companion-action="' + action + '"]').click();
    assert.equal(await page.locator('#factory-bot').getAttribute('data-gesture'), gesture);
  }

  await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'lumi', localCompanionAvailable: true }, '*'));
  await page.waitForFunction(() => document.querySelector('#factory-bot').classList.contains('sd-companion'));
  await checkCareActions('After character switch, without a snapshot or petting');
  if (careOnly) return;
  await send(snapshot);
  await page.locator('#factory-bot').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-tab-bot').textContent(), 'Bot');
  assert.equal(await page.locator('#bot-current-character').textContent(), 'Current character: Lumi');
  assert.equal(await page.locator('#bot-prompt').getAttribute('aria-label'), 'Lumi prompt');
  assert.equal(await page.locator('#bot-menu strong').textContent(), 'Care for Lumi');
  assert.equal(await page.locator('#bot-talk').getAttribute('aria-label'), 'Talk to Lumi');
  assert.match(await page.locator('#bot-talk-shortcut-row dt').textContent(), /Lumi/);
  assert.match(await page.locator('#factory-bot').getAttribute('aria-label'), /Lumi/);
  assert.equal(await page.locator('.companion-sprite').getAttribute('data-sheet'), 'idle');
  const idleHeight = await page.locator('.companion-sprite').evaluate(el => parseFloat(el.style.backgroundSize) / 1254 * 604);
  assert.ok(Math.abs(idleHeight - 64) < .1);
  for (const [age, frame] of [[2820, '1'], [4780, '2'], [5210, '3']]) {
    await send({ ...snapshot, lastInteractionAt: Date.now() - age });
    await page.waitForFunction(frame => document.querySelector('.companion-sprite').dataset.frame === frame, frame);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send({ ...snapshot, lastInteractionAt: Date.now() - 2820 });
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.frame === '0');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.companion-sprite').getAttribute('data-frame'), '0', 'Reduced motion keeps the open-eye frame');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await send(snapshot);

  const stableViewport = page.viewportSize();
  const geometry = () => page.evaluate(() => ['#timeline', '.composer', '.composer-status-column', '#companion-dock'].map(selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  for (const width of [815, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const beforeSwitch = await geometry();
    await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'factory', localCompanionAvailable: true, botPrompt: '' }, '*'));
    await page.waitForFunction(() => !document.querySelector('#factory-bot').classList.contains('sd-companion'));
    assert.deepEqual(await geometry(), beforeSwitch, 'Factory Bot keeps conversation and composer geometry at width ' + width);
    await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'lumi', localCompanionAvailable: true, botPrompt: '' }, '*'));
    await page.waitForFunction(() => document.querySelector('#factory-bot').classList.contains('sd-companion'));
    await checkCareActions('After switching back, before receiving a snapshot');
    await send(snapshot);
    assert.deepEqual(await geometry(), beforeSwitch, 'Switching back to Lumi preserves geometry at width ' + width);
  }
  await page.setViewportSize(stableViewport);
  await page.locator('#bot-prompt').evaluate(el => { el.value = 'Lumi draft'; el.dispatchEvent(new Event('input')); });
  await page.locator('#bot-character').evaluate(el => { el.value = 'factory'; el.dispatchEvent(new Event('change')); });
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.character.save').at(-1).character), 'factory');
  await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'factory', localCompanionAvailable: true, botPrompt: 'Factory identity' }, '*'));
  await page.waitForFunction(() => document.querySelector('#bot-prompt').value === 'Factory identity');
  assert.equal(await page.locator('.companion-sprite').isVisible(), false);
  assert.equal(await page.locator('#bot-prompt').getAttribute('aria-label'), 'Factory Bot prompt');
  await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'lumi', localCompanionAvailable: true, botPrompt: '' }, '*'));
  await page.waitForFunction(() => document.querySelector('#bot-prompt').value === 'Lumi draft');
  await page.locator('#bot-prompt-save').evaluate(el => el.click());
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.prompt.save').at(-1).character), 'lumi');
  await page.evaluate(() => { const m = window.sentMessages.filter(m => m.type === 'bot.prompt.save').at(-1); window.postMessage({ type: 'bot.prompt.saved', requestId: m.requestId, prompt: m.prompt }, '*'); });
  await send(snapshot);
  await page.evaluate(() => window.postMessage({ type: 'bots.updated', enabled: true, botCharacter: 'lumi', localCompanionAvailable: true, botPrompt: 'Lumi draft', botDefaultPrompt: 'Lumi default personality' }, '*'));
  await page.locator('#bot-prompt-reset').evaluate(el => el.click());
  assert.equal(await page.locator('#bot-prompt').inputValue(), 'Lumi default personality', 'Reset shows the actual default instead of an empty field');
  await page.locator('#bot-prompt-save').evaluate(el => el.click());
  await page.evaluate(() => { const m = window.sentMessages.filter(m => m.type === 'bot.prompt.save').at(-1); window.postMessage({ type: 'bot.prompt.saved', requestId: m.requestId, prompt: m.prompt }, '*'); });
  await page.waitForFunction(() => document.querySelector('#bot-prompt-save').disabled);
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 600 });
  await page.locator('#submission-button').click();
  const menuCoversBot = await page.evaluate(() => {
    const bot = document.querySelector('#factory-bot').getBoundingClientRect();
    const menu = document.querySelector('#submission-menu');
    const rect = menu.getBoundingClientRect();
    const left = Math.max(bot.left, rect.left), right = Math.min(bot.right, rect.right);
    const top = Math.max(bot.top, rect.top), bottom = Math.min(bot.bottom, rect.bottom);
    return right > left && bottom > top && menu.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  });
  assert.equal(menuCoversBot, true, 'Open submission menu covers the mascot and receives pointer input');
  await page.screenshot({ path: '/tmp/companion-menu-layer.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize(originalViewport);
  await page.setViewportSize({ width: 568, height: 548 });
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-bot').click();
  await page.evaluate(() => window.postMessage({ type: 'models.list', models: Array.from({ length: 16 }, (_, i) => 'gpt-test-' + i) }, '*'));
  await page.waitForFunction(() => document.querySelector('#bot-model').options.length === 17);
  for (const id of ['bot-character', 'bot-model']) {
    const select = page.locator('#' + id);
    await select.click();
    const alignment = await select.evaluate(el => {
      const control = el.getBoundingClientRect();
      const option = [...el.options].find(option => !option.hidden).getBoundingClientRect();
      return { controlX: control.x, controlWidth: control.width, optionX: option.x, optionWidth: option.width };
    });
    assert.ok(Math.abs(alignment.optionX - alignment.controlX - 6) < 2, id + ' list aligns with its control');
    const inset = alignment.controlWidth - alignment.optionWidth;
    assert.ok(inset >= 10 && inset <= 30, id + ' list matches its control width including scrollbar');
    await page.screenshot({ path: '/tmp/' + id + '-aligned.png' });
    await page.keyboard.press('Escape');
  }

  await page.screenshot({ path: '/tmp/bot-settings-compact.png' });
  assert.equal(await page.locator('#settings-panel-bot').evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'Bot settings fit the reported viewport without scrolling');
  const saveBox = await page.locator('#bot-prompt-save').boundingBox();
  assert.ok(saveBox.y + saveBox.height < 548, 'Save action remains inside the viewport');
  await page.screenshot({ path: '/tmp/bot-settings-compact.png' });
  await page.setViewportSize({ width: 360, height: 548 });
  assert.equal(await page.locator('#settings-panel-bot').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Narrow settings do not overflow horizontally');
  await page.locator('#bot-prompt-reset').scrollIntoViewIfNeeded();
  const narrowReset = await page.locator('#bot-prompt-reset').boundingBox();
  assert.ok(narrowReset.y + narrowReset.height < 548);
  await page.locator('#status-settings-close').click();
  await page.setViewportSize(originalViewport);
  const callsBefore = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').length);
  await page.locator('#factory-bot').click();
  await page.locator('#factory-bot').click();
  await page.locator('#factory-bot').click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').length), callsBefore, 'Menu clicks do not trigger reactions');
  assert.notEqual(await page.locator('#factory-bot').getAttribute('data-reacting'), 'true');
  await page.locator('[data-companion-action="pet"]').click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').at(-1).action), 'pet');
  await send({ ...snapshot, emotion: 'love', action: 'pet', reactionUntil: Date.now() + 2000 });
  await page.waitForFunction(() => document.querySelector('#factory-bot').dataset.emotion === 'love');
  assert.equal(await page.locator('.companion-sprite').getAttribute('data-sheet'), 'emotions');
  assert.equal(await page.locator('#companion-reaction').isVisible(), true);
  const reactionBox = await page.locator('#companion-reaction').boundingBox();
  const characterBox = await page.locator('#factory-bot').boundingBox();
  assert.ok(reactionBox.y + reactionBox.height <= characterBox.y - 7, 'Care reaction appears above character');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.companion-sprite').evaluate(el => el.getAnimations().length), 0);
  await send({ ...snapshot, emotion: 'shy', action: 'praise', reactionUntil: Date.now() + 1000 }, 2);
  await page.waitForFunction(() => document.querySelector('#factory-bot').dataset.state === 'working');
  assert.match(await page.locator('#companion-reaction').textContent(), /working/);
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.motion === 'working');
  assert.match(await page.locator('#factory-bot').getAttribute('aria-label'), /2/);
  await send({ ...snapshot, lastInteractionAt: Date.now() - 70000 });
  await page.waitForFunction(() => document.querySelector('#factory-bot').dataset.emotion === 'sleepy');
  await page.locator('#factory-bot').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#bot-menu').isVisible(), true);
  await page.locator('[data-companion-action="praise"]').click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').at(-1).action), 'praise');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await send(snapshot, 1);
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.motion === 'working');
  const frame = await page.locator('.companion-sprite').getAttribute('data-frame');
  await page.waitForFunction(frame => document.querySelector('.companion-sprite').dataset.frame !== frame, frame);
  await send({ ...snapshot, action: 'feed', emotion: 'happy', lastInteractionAt: Date.now(), reactionUntil: Date.now() + 1600 }, 1);
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.motion === 'eating');
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.frame === '1');
  await page.locator('#factory-bot').screenshot({ path: '/tmp/companion-eating.png' });
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.motion === 'working');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('.companion-sprite').dataset.frame === '0');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.companion-sprite').getAttribute('data-frame'), '0');
  await send(snapshot);
  const loaded = await page.locator('.companion-sprite').evaluate(async el => {
    const url = el.dataset.source.slice(5, -2);
    const img = new Image(); img.src = url; await img.decode(); return img.naturalWidth;
  });
  assert.ok(loaded > 1000);
  await send({ ...snapshot, emotion: 'shy', action: 'praise', reactionUntil: Date.now() + 5000 });
  await page.waitForFunction(() => document.querySelector('#factory-bot').dataset.emotion === 'shy');
  const crop = await page.locator('.companion-sprite').evaluate(el => ({
    width: parseFloat(el.style.width), height: parseFloat(el.style.height),
    size: parseFloat(el.style.backgroundSize), y: parseFloat(el.style.backgroundPosition.split(' ')[1])
  }));
  // A neighboring row begins at y=812; the shy frame must end at y=810.
  assert.ok(Math.abs(crop.width / crop.height - 313.5 / 396) < .001);
  const scale = crop.size / 1254;
  assert.ok(Math.abs(scale * 360 - idleHeight) < .1, "Idle and reaction characters have the same height");
  assert.ok(Math.abs((-crop.y + crop.height) / scale - 810) < .1);
  await page.waitForFunction(() => !!document.querySelector('.companion-sprite').dataset.smoothed);
  await page.locator('#factory-bot').screenshot({ path: '/tmp/agent-factory-companion-crop.png' });
  const raster = await page.locator('.companion-sprite').evaluate(el => ({
    pixels: Number(el.dataset.smoothed), expected: Math.round(parseFloat(el.style.backgroundSize) * devicePixelRatio),
    background: el.style.backgroundImage
  }));
  assert.equal(raster.pixels, raster.expected, 'Raster matches physical screen resolution');
  assert.ok(raster.background.startsWith('url("data:image/png;'), 'High-quality raster is displayed');
  await page.locator('.companion-sprite').evaluate(el => { el.style.backgroundImage = el.dataset.source; });
  await page.locator('#factory-bot').screenshot({ path: '/tmp/agent-factory-companion-before.png' });
  await page.locator('.companion-sprite').evaluate((el, background) => { el.style.backgroundImage = background; }, raster.background);

  await page.locator('#factory-bot').click();
  const buttonStyle = await page.locator('[data-companion-action="praise"]').evaluate(el => ({
    background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth
  }));
  assert.equal(buttonStyle.border, '0px');
  assert.equal(await page.locator('.companion-actions button').count(), 6);
  await page.locator('#bot-menu').screenshot({ path: '/tmp/agent-factory-care-menu.png' });
  assert.equal(await page.locator('#bot-talk-hint, .bot-talk-shortcut').count(), 0);

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  for (const width of [795, 360]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#companion-size').count(), 0);
    const boxes = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
      return { bot:box('#factory-bot'), dock:box('#companion-dock'), composer:box('.composer'), status:box('.composer-status-column'), timeline:box('.timeline-region') };
    });
    assert.ok(boxes.status.right <= boxes.dock.x, 'Status and bot are side by side');
    assert.ok(Math.abs(boxes.bot.bottom - boxes.composer.y) <= 1, 'Feet sit on input border');
    assert.ok(boxes.timeline.bottom <= boxes.dock.y + 1, 'Bot never overlays the transcript');
    assert.ok(boxes.bot.x >= 0 && boxes.bot.right <= width, 'Bot remains inside narrow window');
  }
  await page.screenshot({ path: '/tmp/agent-factory-companion.png' });
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', botsEnabled: false, botsAvailable: false, runtimeAvailable: true }, '*'));
  await page.waitForFunction(() => document.querySelector('#companion-dock').hidden);
  assert.equal(await page.locator('#settings-tab-bot').isVisible(), false);
  const before = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.talk').length);
  await page.locator('#prompt').fill('Release bot must stay disabled');
  await page.locator('#prompt').press('Control+Shift+Enter');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.talk').length), before);

  await page.evaluate(() => window.postMessage({ type: 'host.initialize', botsEnabled: true, botsAvailable: true, companionAvailable: false, runtimeAvailable: true }, '*'));
  await page.waitForFunction(() => !document.querySelector('#factory-bot').classList.contains('sd-companion'));
  assert.equal(await page.locator('#factory-bot > svg').isVisible(), true, 'Release keeps the vector Factory Bot');
  assert.equal(await page.locator('.companion-sprite').isVisible(), false);
  assert.equal(await page.locator('#settings-tab-bot').textContent(), 'Bot');
  assert.equal(await page.locator('#bot-current-character').textContent(), 'Current character: Factory Bot');
  assert.equal(await page.locator('#bot-menu strong').textContent(), 'Care for Factory Bot');
  assert.equal(await page.locator('#bot-talk').getAttribute('aria-label'), 'Talk to Factory Bot');
  assert.match(await page.locator('#bot-talk-shortcut-row dt').textContent(), /Factory Bot/);
  await send(snapshot, 2);
  assert.equal(await page.locator('#factory-bot').getAttribute('class'), 'factory-bot');
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.locator('#factory-bot').click();
  assert.equal(await page.locator('[data-companion-action="pet"]').isVisible(), false);
  assert.equal(await page.locator('[data-bot-action="feed"]').isVisible(), true);
  assert.equal(await page.locator('[data-bot-action="feed"]').isEnabled(), true);
  await page.locator('[data-bot-action="feed"]').click();
  assert.equal(await page.locator('#factory-bot').getAttribute('data-gesture'), 'feed');
  await page.locator('#factory-bot').screenshot({ path: '/tmp/release-factory-bot.png' });

};
