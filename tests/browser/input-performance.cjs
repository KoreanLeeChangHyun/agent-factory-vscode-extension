const assert = require('node:assert/strict');

async function checkInputPerformance(page) {
  await page.evaluate(() => {
    const capability = { taskModes: ['direct'], goal: true };
    window.postMessage({ type: 'host.initialize', role: 'main', panelId: 'typing', runtimeAvailable: true,
      capabilities: { submit: capability, send: capability } }, '*');
    for (let i = 0; i < 200; i++) window.postMessage({ type: 'chat.assistant', phase: 'final',
      text: 'Typing history ' + i + ' ' + 'abcdefgh '.repeat(900) }, '*');
  });
  await page.waitForFunction(() => document.querySelector('.message-assistant:last-child')?.textContent.includes('Typing history 199'));
  await page.waitForTimeout(200);
  await page.locator('#prompt').focus();
  const timing = await page.evaluate(() => {
    window.measurePersistence = true;
    window.persistenceCalls = 0;
    const input = document.querySelector('#prompt');
    const durations = [];
    for (let i = 0; i < 80; i++) {
      input.value += 'a';
      const start = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    return { events: 80, immediateSaves: window.persistenceCalls, medianMs: durations[40], p95Ms: durations[76] };
  });
  assert.equal(timing.immediateSaves, 0);
  await page.waitForFunction(() => window.persistenceCalls === 1);
  assert.equal(await page.evaluate(() => window.saved.draft), 'a'.repeat(80));
  timing.batchedSaves = await page.evaluate(() => window.persistenceCalls);
  timing.persistedBytes = await page.evaluate(() => window.persistenceBytes);

  // Blur flushes the latest draft and cancels the older scheduled save.
  await page.locator('#prompt').fill('복원할 초안');
  await page.locator('#prompt').evaluate(input => input.blur());
  assert.equal(await page.evaluate(() => window.saved.draft), '복원할 초안');
  const afterBlur = await page.evaluate(() => window.persistenceCalls);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.persistenceCalls), afterBlur);
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  assert.equal(await page.locator('#prompt').inputValue(), '복원할 초안');
  await page.evaluate(() => {
    const capability = { taskModes: ['direct'], goal: true };
    window.postMessage({ type: 'host.initialize', role: 'main', panelId: 'typing', runtimeAvailable: true,
      capabilities: { submit: capability, send: capability } }, '*');
  });
  await page.waitForFunction(() => !document.querySelector('#submission-button').hidden);

  // IME confirmation must not submit; normal Enter must submit the latest draft.
  await page.locator('#prompt').fill('한글 조합');
  const count = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').length);
  const before = await count();
  await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  assert.equal(await count(), before);
  await page.locator('#prompt').press('Enter');
  assert.equal(await count(), before + 1);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1).text), '한글 조합');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.saved.draft), '');
  await page.locator('#prompt').fill('탭 숨김 초안');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.saved.draft), '탭 숨김 초안');
  await page.locator('#prompt').fill('종료 직전 초안');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => window.saved.draft), '종료 직전 초안');
  console.log('Input persistence, restoration and IME checks passed: ' + JSON.stringify(timing));
}
module.exports = { checkInputPerformance };
