const assert = require('node:assert/strict');
const fs = require('node:fs');
const { checkAutoScroll } = require('./auto-scroll.cjs');

async function checkUiEfficiency(page) {
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const history = Array.from({ length: 1000 }, (_, i) => ({ id: 'efficiency-' + i, type: 'assistant', phase: 'final', text: 'History ' + i + '\n\n' + 'Full retained text '.repeat(60) }));
  await page.evaluate(timeline => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline, autoScroll: false, botsEnabled: false })), history);
  await page.reload();
  await page.waitForSelector('[data-id="efficiency-999"]');
  await settle();
  await page.locator('#timeline').evaluate(element => { element.scrollTop = 150; });
  await settle();
  const report = await page.evaluate(() => {
    const timeline = document.getElementById('timeline');
    const reads = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
    for (const name of Object.keys(reads)) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
      Object.defineProperty(timeline, name, { configurable: true,
        get() { reads[name]++; return descriptor.get.call(this); },
        ...(descriptor.set ? { set(value) { descriptor.set.call(this, value); } } : {}) });
    }
    const observer = new MutationObserver(() => {});
    for (const id of ['auto-scroll-button', 'auto-scroll-state', 'jump-to-bottom']) observer.observe(document.getElementById(id), { attributes: true, subtree: true });
    for (let i = 0; i < 20; i++) timeline.dispatchEvent(new Event('scroll'));
    const mutations = observer.takeRecords().length;
    observer.disconnect();
    for (const name of Object.keys(reads)) delete timeline[name];
    window.efficiencyHistoryNode = document.querySelector('[data-id="efficiency-999"]');
    return { scenario: '1000 retained messages, 20 unchanged scroll events, 40 streaming fragments, 10 structured command updates', vscodeHostMeasured: false, scrollReads: reads, unchangedScrollMutations: mutations };
  });
  const chunk = 'Streaming **complete text** with `code`.\n\n';
  for (let i = 0; i < 40; i++) {
    await emit({ type: 'chat.delta', runId: 'efficiency-stream', stream: 'final', id: 'efficiency-block', text: chunk });
    await settle();
  }
  assert.equal(await page.evaluate(() => window.efficiencyHistoryNode === document.querySelector('[data-id="efficiency-999"]')), true);
  assert.equal(await page.locator('.message-final:last-of-type .message-content').textContent(), 'Streaming complete text with code.\n'.repeat(40));
  assert.equal(await page.locator('#timeline').evaluate(element => element.scrollTop), 150, 'Streaming while OFF preserves the reading position');
  assert.equal(await page.evaluate(() => window.saved.timeline.filter(event => event.id.startsWith('efficiency-')).length), 1000, 'All history remains retained');
  await page.evaluate(() => {
    window.efficiencyRuntimeCalls = 0;
    const references = window.agentFactoryExecutionReferences;
    window.agentFactoryExecutionReferences = { ...references, runtimeScripts(output) {
      if (typeof output === 'string' && output.includes('efficiency-measurement')) window.efficiencyRuntimeCalls++;
      return references.runtimeScripts(output);
    } };
  });
  for (let i = 0; i < 10; i++) {
    await emit({ type: 'run.activity', id: 'efficiency-command', category: 'command', phase: 'completed', text: 'echo structured-result', output: JSON.stringify({ operation: { schemaVersion: 1, provider: 'agent-factory', script: 'exec.py', action: 'status' }, marker: 'efficiency-measurement', value: i }) });
    await settle();
    assert.equal(await page.locator('[data-id="efficiency-command"] .managed-agent-card').count(), 1);
  }
  report.structuredRuntimeCalls = await page.evaluate(() => window.efficiencyRuntimeCalls);
  // Keep the interaction fixture below the existing page boundary so appends
  // do not evict its first message while it checks DOM retention.
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline: [], autoScroll: false, botsEnabled: false })));
  await page.reload();
  await page.waitForSelector('#auto-scroll-button');
  await settle();
  // Existing interaction coverage includes OFF, upward wheel intent,
  // resize while paused/following, disclosures, sending and jump-to-bottom.
  await checkAutoScroll(page);
  report.streamingAndScrollChecks = 'passed';
  if (process.env.AF_UI_EFFICIENCY_ASSERT !== '0') {
    assert.deepEqual(report.scrollReads, { scrollHeight: 20, clientHeight: 20, scrollTop: 20 });
    assert.equal(report.unchangedScrollMutations, 0, 'Unchanged scroll controls need no attribute writes');
    assert.equal(report.structuredRuntimeCalls, 10, 'Each changed structured output is analyzed once by card selection');
  }
  if (process.env.AF_UI_EFFICIENCY_REPORT) fs.writeFileSync(process.env.AF_UI_EFFICIENCY_REPORT, JSON.stringify(report, null, 2));
  console.log('UI efficiency own checks: ' + JSON.stringify(report));
}

module.exports = { checkUiEfficiency };
