const assert = require('node:assert/strict');
const fs = require('node:fs');

async function checkRenderingThroughput(page) {
  const enforce = process.env.AF_THROUGHPUT_ASSERT === '1';
  const timeline = Array.from({ length: 10000 }, (_, i) => i < 9990
    ? { type: 'assistant', phase: 'final', id: 'history-' + i, text: 'History ' + i }
    : { type: 'activity', category: 'command', phase: 'started', id: 'activity-' + i, text: 'echo ready', output: 'ready' });
  await page.evaluate(timeline => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline, autoScroll: false })), timeline);
  await page.reload();
  await page.waitForSelector('[data-id="activity-9999"]');
  await page.waitForTimeout(200);
  const report = { scenario: '10,000 retained messages; 100 updates in one burst; 3 seconds of typing', vscodeHostMeasured: false };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    window.perfRenders = 0;
    window.perfHistoryScans = 0;
    const timeline = document.getElementById('timeline');
    const setAttribute = timeline.setAttribute;
    timeline.setAttribute = function (name, value) {
      if (name === 'aria-busy') window.perfRenders++;
      return setAttribute.call(this, name, value);
    };
    const find = Array.prototype.find;
    Array.prototype.find = function (...args) {
      if (this.length >= 10000) window.perfHistoryScans++;
      return find.apply(this, args);
    };
    window.emitPerfActivity = (id, text) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'run.activity', id, category: 'command', phase: 'completed', text: 'echo ready', output: text
    } }));
  });
  report.burstHandlerMs = await page.evaluate(() => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) window.emitPerfActivity('activity-9999', 'update-' + i);
    return performance.now() - start;
  });
  await settle();
  report.burstRenders = await page.evaluate(() => window.perfRenders);
  report.fullHistoryFindCalls = await page.evaluate(() => window.perfHistoryScans);
  assert.match(await page.locator('[data-id="activity-9999"]').textContent(), /update-99/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.perfRenders = 0;
    for (let i = 0; i < 100; i++) window.emitPerfActivity('activity-9999', 'hidden-' + i);
  });
  await settle();
  report.hiddenRenders = await page.evaluate(() => window.perfRenders);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await settle();
  assert.match(await page.locator('[data-id="activity-9999"]').textContent(), /hidden-99/);

  // Simulate delayed language loading while an activity's old DOM is replaced.
  await page.evaluate(() => {
    window.pendingHighlights = [];
    const original = window.agentFactorySyntaxHighlighter;
    window.agentFactorySyntaxHighlighter = { ...original, highlight(code, ...args) {
      if (code.startsWith('echo delayed-')) return new Promise(resolve => window.pendingHighlights.push(resolve));
      return original.highlight(code, ...args);
    } };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.activity', id: 'delayed', category: 'command', phase: 'started', text: 'echo delayed-old' } }));
  });
  await settle();
  await page.evaluate(() => {
    window.oldCode = document.querySelector('[data-id="delayed"] .syntax-code');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.activity', id: 'delayed', category: 'command', phase: 'completed', text: 'echo delayed-new' } }));
  });
  await settle();
  await page.evaluate(async () => {
    window.pendingHighlights[0]([[{ content: 'OBSOLETE', color: '#abcdef' }]]);
    window.pendingHighlights[1]([[{ content: 'LATEST', color: '#abcdef' }]]);
    await Promise.resolve();
  });
  report.staleHighlightWritten = await page.evaluate(() => window.oldCode.textContent === 'OBSOLETE');
  assert.equal(await page.locator('[data-id="delayed"] .syntax-code').textContent(), 'LATEST');

  // A closed settings panel should stop receiving preview DOM writes.
  await page.locator('#status-settings-button').click();
  await page.locator('#status-settings-close').click();
  await page.evaluate(() => {
    window.previewWrites = 0;
    new MutationObserver(records => { window.previewWrites += records.length; }).observe(document.getElementById('status-catalog'), { childList: true, subtree: true });
    for (let i = 0; i < 20; i++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'context.usage', usedTokens: 100 + i, contextWindowTokens: 1000 } }));
  });
  report.closedPreviewWrites = await page.evaluate(() => window.previewWrites);
  await page.locator('#status-settings-button').click();
  assert.match(await page.locator('[data-preview-id="contextUsed"]').textContent(), /119/, 'Reopening settings displays the latest usage');
  await page.locator('#status-settings-close').click();
  await page.waitForTimeout(200);
  await page.clock.install();
  await page.evaluate(() => { window.measurePersistence = true; window.persistenceCalls = 0; });
  for (let i = 0; i < 30; i++) {
    await page.locator('#prompt').evaluate((input, i) => { input.value = 'draft-' + i; input.dispatchEvent(new Event('input', { bubbles: true })); }, i);
    await page.clock.runFor(100);
  }
  await page.clock.runFor(200);
  report.typingSaves = await page.evaluate(() => window.persistenceCalls);
  assert.equal(await page.evaluate(() => window.saved.draft), 'draft-29');
  const beforeBlur = await page.evaluate(() => window.persistenceCalls);
  await page.evaluate(() => { for (let i = 0; i < 5; i++) document.getElementById('prompt').dispatchEvent(new Event('blur')); });
  report.duplicateBlurSaves = await page.evaluate(before => window.persistenceCalls - before, beforeBlur);
  for (const trigger of ['visibilitychange', 'pagehide', 'blur']) {
    await page.locator('#prompt').evaluate((input, trigger) => { input.value = trigger + '-latest'; input.dispatchEvent(new Event('input', { bubbles: true })); }, trigger);
    await page.evaluate(trigger => {
      if (trigger === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event(trigger));
      } else if (trigger === 'pagehide') window.dispatchEvent(new Event(trigger));
      else document.getElementById('prompt').dispatchEvent(new Event(trigger));
    }, trigger);
    assert.equal(await page.evaluate(() => window.saved.draft), trigger + '-latest');
  }
  if (enforce) {
    assert.equal(report.burstRenders, 1);
    assert.equal(report.fullHistoryFindCalls, 0);
    assert.equal(report.hiddenRenders, 0);
    assert.equal(report.staleHighlightWritten, false);
    assert.equal(report.closedPreviewWrites, 0);
    assert.ok(report.typingSaves <= 4);
    assert.equal(report.duplicateBlurSaves, 0);
    await checkIndexAndPersistence(page);
  }
  if (process.env.AF_THROUGHPUT_REPORT) fs.writeFileSync(process.env.AF_THROUGHPUT_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

async function checkIndexAndPersistence(page) {
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  for (const reset of [
    { type: 'session.bound', agentId: 'index-test', conversationId: 'index-1', reset: true },
    { type: 'conversation.cleared', conversationId: 'index-2' }
  ]) {
    await emit(reset);
    await emit({ type: 'run.activity', id: 'activity-9999', category: 'command', phase: 'started', text: 'echo fresh', output: 'initial' });
    await page.clock.runFor(60);
    assert.equal(await page.locator('#timeline .message').count(), 1, 'An index must not reuse a prior conversation event');
    await page.evaluate(() => { window.persistedBeforeUpdate = window.saved; });
    await emit({ type: 'run.activity', id: 'activity-9999', category: 'command', phase: 'completed', text: 'echo fresh', output: 'final' });
    assert.equal(await page.evaluate(() => window.saved.timeline[0].output), 'initial', 'Pending updates cannot mutate the saved snapshot');
    await page.clock.runFor(60);
    assert.equal(await page.evaluate(() => window.saved.timeline[0].output), 'final');
    assert.equal(await page.evaluate(() => window.persistedBeforeUpdate.timeline[0].output), 'initial');
    assert.equal(await page.locator('#timeline .message').count(), 1);
  }
  for (const [id, output] of [['read-first', 'one'], ['read-next', 'two'], ['read-next', 'three']]) {
    await emit({ type: 'run.activity', id, category: 'command', phase: 'completed', text: 'cat result.md', title: 'Read run result', output });
  }
  await page.clock.runFor(60);
  assert.equal(await page.locator('[data-id="read-next"]').count(), 0, 'Adjacent reads retain the original card identity');
  assert.equal(await page.evaluate(() => window.saved.timeline.at(-1).output), 'three');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.clock.runFor(100);
  await emit({ type: 'run.activity', id: 'activity-9999', category: 'command', phase: 'completed', text: 'echo restored', output: 'after reload' });
  await page.clock.runFor(60);
  assert.equal(await page.locator('[data-id="activity-9999"]').count(), 1, 'Restored activity updates use the saved ID');
  assert.match(await page.locator('[data-id="activity-9999"]').textContent(), /after reload/);
  assert.equal(await page.locator('#prompt').inputValue(), 'blur-latest', 'Immediate lifecycle flush restores the latest draft');
}
module.exports = { checkRenderingThroughput };
