const assert = require('node:assert/strict');
const fs = require('node:fs');

async function checkRenderingPerformance(page) {
  const enforce = process.env.AF_RENDERING_ASSERT === '1';
  const output = Array.from({ length: 600 }, (_, i) => '\x1b[31mline ' + i + '\x1b[0m plain\n').join('');
  const timeline = Array.from({ length: 200 }, (_, i) => i < 180
    ? { id: 'perf-' + i, type: 'assistant', phase: 'final', text: 'History ' + i + ' text '.repeat(300) }
    : { id: 'perf-' + i, type: 'activity', category: 'command', phase: 'completed', text: 'echo ' + i, output });
  await page.evaluate(timeline => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({
    timeline, autoScroll: false, statusItems: ['status', 'agents', 'context', 'project']
  })), timeline);
  await page.reload();
  await page.waitForSelector('[data-id="perf-199"]');
  await page.waitForTimeout(200);
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const report = { scenario: 'Chromium, 200 messages (20 ANSI outputs of 600 lines), 30 activity updates and 100 usage updates', vscodeHostMeasured: false };
  report.initialNodes = await page.locator('#timeline *').count();
  report.initialOutputSpans = await page.locator('.terminal-command-output span').count();
  await page.evaluate(() => {
    window.perfCounts = { managed: 0, serializedCharacters: 0, ansi: 0 };
    const stringify = JSON.stringify;
    JSON.stringify = function (...args) {
      const result = stringify.apply(this, args);
      window.perfCounts.serializedCharacters += result?.length || 0;
      return result;
    };
    const managed = window.agentFactoryExecutionReferences.managedCommand;
    window.agentFactoryExecutionReferences = { ...window.agentFactoryExecutionReferences, managedCommand: function (...args) {
      window.perfCounts.managed++;
      return managed.apply(this, args);
    } };
    const ansi = window.agentFactoryAnsi.render;
    window.agentFactoryAnsi = { render: function (...args) { window.perfCounts.ansi++; return ansi.apply(this, args); } };
    window.perfStableMessage = document.querySelector('[data-id="perf-180"]');
  });
  const before = await metrics();
  report.updateWallMs = await page.evaluate(async output => {
    const start = performance.now();
    for (let i = 0; i < 30; i++) {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.activity', id: 'perf-199', category: 'command', phase: 'completed', text: 'echo 199', output: output + i } }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return performance.now() - start;
  }, output);
  const after = await metrics();
  report.updateTaskMs = (after.TaskDuration - before.TaskDuration) * 1000;
  report.updateLayouts = after.LayoutCount - before.LayoutCount;
  Object.assign(report, await page.evaluate(() => window.perfCounts));
  assert.equal(await page.evaluate(() => window.perfStableMessage === document.querySelector('[data-id="perf-180"]')), true);
  await page.evaluate(() => {
    window.perfStatus = document.querySelector('[data-item-id="status"]');
    window.perfStatus.focus();
    window.perfBotMutations = 0;
    new MutationObserver(records => { window.perfBotMutations += records.length; }).observe(document.querySelector('#factory-bot'), { attributes: true });
    for (let i = 0; i < 100; i++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'context.usage', usedTokens: 1000 + i, contextWindowTokens: 10000 } }));
  });
  report.statusNodeRetained = await page.evaluate(() => window.perfStatus === document.querySelector('[data-item-id="status"]') && document.activeElement === window.perfStatus);
  Object.assign(report, await checkStreamingPreview(page, session, metrics));
  report.usageBotMutations = await page.evaluate(() => window.perfBotMutations);
  const details = page.locator('[data-id="perf-199"] .terminal-output-details');
  report.closedOutputNodes = await details.locator('pre').count();
  await details.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-id="perf-199"] details pre')?.textContent.endsWith('29'));
  assert.equal(await details.locator('pre').textContent(), output.replace(/\x1b\[[0-9;]*m/g, '') + '29');
  assert.ok(await details.locator('pre span[style]').count() > 0);
  await page.clock.install();
  await page.evaluate(() => {
    window.perfGestureTicks = 0;
    const timeout = window.setTimeout;
    window.setTimeout = function (callback, delay, ...args) {
      return timeout(function () { if (delay === 8000) window.perfGestureTicks++; callback(...args); }, delay);
    };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'host.initialize', runtimeAvailable: true, botsEnabled: true, capabilities: { submit: {}, send: {} } } }));
    document.querySelector('#bot-visible').checked = false;
    document.querySelector('#bot-visible').dispatchEvent(new Event('change'));
  });
  await page.clock.fastForward(16000);
  report.hiddenBotGestureTicks = await page.evaluate(() => window.perfGestureTicks);
  if (enforce) {
    assert.equal(report.closedOutputNodes, 0, 'Closed details must defer full output creation');
    assert.equal(report.statusNodeRetained, true, 'Usage updates preserve unrelated status DOM and focus');
    assert.equal(report.usageBotMutations, 0, 'Usage updates do not render the bot');
    assert.equal(report.hiddenBotGestureTicks, 0, 'Hidden bots do not schedule gestures');
    assert.ok(report.managed <= 30, 'Only changed commands are analyzed');
    assert.ok(report.initialOutputSpans < 2000, 'Previews have bounded ANSI DOM');
    assert.ok(report.serializedCharacters < 10000, 'Render keys do not serialize unchanged message bodies');
    assert.equal(report.streamStableHistory, true, 'Streaming previews leave history DOM untouched');
    assert.equal(report.streamPreviewRetained, true, 'Streaming previews update one element in place');
    await checkBotLifecycle(page);
  }
  if (process.env.AF_RENDERING_REPORT) fs.writeFileSync(process.env.AF_RENDERING_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await session.detach();
}

// 300 fragments (~25 KB of Markdown with code) against 200 history messages, one fragment per frame.
async function checkStreamingPreview(page, session, metrics) {
  const chunk = 'Streaming **markdown** with `code` and a [link](https://example.com).\n\n```js\nconst value = 1;\n```\n\n';
  const before = await metrics();
  const wall = await page.evaluate(async chunk => {
    window.perfStableMessage = document.querySelector('[data-id="perf-180"]');
    const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const start = performance.now();
    post({ type: 'chat.delta', runId: 'perf-run', stream: 'final', id: 'perf-block', text: chunk });
    await frame();
    window.perfPreview = document.querySelector('.message-final:last-of-type');
    for (let i = 1; i < 300; i++) {
      post({ type: 'chat.delta', runId: 'perf-run', stream: 'final', id: 'perf-block', text: chunk });
      await frame();
    }
    return performance.now() - start;
  }, chunk);
  const after = await metrics();
  const retained = await page.evaluate(() => ({
    stable: window.perfStableMessage === document.querySelector('[data-id="perf-180"]'),
    preview: Boolean(window.perfPreview) && window.perfPreview.isConnected && window.perfPreview.querySelectorAll('pre').length === 300
  }));
  return { streamWallMs: wall, streamTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    streamStableHistory: retained.stable, streamPreviewRetained: retained.preview };
}

async function checkBotLifecycle(page) {
  const setControl = (id, checked) => page.evaluate(({ id, checked }) => {
    const input = document.getElementById(id);
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
  }, { id, checked });
  const wake = () => page.locator('#prompt').dispatchEvent('input', { bubbles: true });
  const ticks = () => page.evaluate(() => window.perfGestureTicks);
  const bot = page.locator('#factory-bot');
  await setControl('bot-visible', true);
  await wake();
  const resumed = await ticks();
  await page.clock.runFor(8100);
  assert.ok(await ticks() > resumed, 'Showing the bot resumes gestures');
  for (const constraint of ['animations', 'reducedMotion', 'hiddenTab']) {
    await wake();
    if (constraint === 'animations') await setControl('bot-animations', false);
    if (constraint === 'reducedMotion') {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => !document.querySelector('#factory-bot').hasAttribute('data-gesture'));
    }
    if (constraint === 'hiddenTab') await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = await ticks();
    await page.clock.runFor(16000);
    assert.equal(await ticks(), before, constraint + ' must stop gesture timers');
    if (constraint === 'animations') await setControl('bot-animations', true);
    if (constraint === 'reducedMotion') await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (constraint === 'hiddenTab') await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wake();
    await page.clock.runFor(8100);
    assert.ok(await ticks() > before, constraint + ' resumes gestures when cleared');
  }
  await wake();
  await page.clock.runFor(40000);
  await wake();
  // Ordinary typing extends the deadline without rewriting bot attributes.
  const mutations = await page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(document.querySelector('#factory-bot'), { attributes: true });
    for (let i = 0; i < 80; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      document.querySelector('#prompt').dispatchEvent(new Event('input', { bubbles: true }));
    }
    await Promise.resolve();
    observer.disconnect();
    return count;
  });
  assert.equal(mutations, 0, 'Typing in idle state does not rerender the bot');
  await page.clock.runFor(10000);
  assert.equal(await bot.getAttribute('data-state'), 'idle', 'Typing extends the idle deadline');
  await page.clock.runFor(36000);
  assert.equal(await bot.getAttribute('data-state'), 'drowsy');
  await page.clock.runFor(15000);
  assert.equal(await bot.getAttribute('data-state'), 'sleeping');
  await wake();
  assert.equal(await bot.getAttribute('data-state'), 'idle', 'Typing wakes the sleeping bot');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(61000);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await bot.getAttribute('data-state'), 'sleeping', 'Returning to a tab uses elapsed idle time');
  await bot.dispatchEvent('click');
  assert.equal(await bot.getAttribute('data-state'), 'idle');
}
module.exports = { checkRenderingPerformance };
