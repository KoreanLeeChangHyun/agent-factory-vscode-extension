const assert = require('node:assert/strict');
const fs = require('node:fs');

async function checkLongHistory(page) {
  await page.evaluate(() => {
    const timeline = Array.from({ length: 10000 }, (_, i) => ({
      type: 'assistant', phase: 'final', id: 'long-' + i,
      text: 'History ' + i + ' 한글 <raw> ' + 'retained content '.repeat(20)
    }));
    sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline }));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#timeline .message').length === 200);
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const before = await session.send('Runtime.getHeapUsage');
  const result = await page.evaluate(() => {
    const times = [];
    const seen = new Set();
    // Walk every retained page: check exact contents, not only DOM counts.
    for (let end = 10000; end > 0; end -= 200) {
      const nodes = [...document.querySelectorAll('#timeline .message')];
      if (nodes.length !== 200) throw Error('Unbounded/missing page');
      nodes.forEach((node, j) => {
        const i = end - 200 + j;
        const expected = 'History ' + i + ' 한글 <raw> ' + 'retained content '.repeat(20);
        if (node.dataset.id !== 'long-' + i || !node.textContent.includes(expected.trim())) throw Error('Lost content ' + i);
        seen.add(node.dataset.id);
      });
      if (end > 200) {
        const start = performance.now();
        document.querySelector('.history-pages button').click();
        times.push(performance.now() - start);
      }
    }
    for (let i = 0; i < 49; i++) document.querySelector('.history-pages button:last-child').click();
    times.sort((a, b) => a - b);
    return { messagesChecked: seen.size, pagesChecked: 50, medianNavigationMs: times[24], p95NavigationMs: times[46] };
  });
  assert.equal(result.messagesChecked, 10000);
  await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'New final preserved' }, '*'));
  await page.waitForFunction(() => document.querySelector('.message-assistant:last-child')?.textContent.includes('New final preserved'));
  await page.waitForTimeout(200);
  await session.send('HeapProfiler.collectGarbage');
  result.heapBefore = before.usedSize;
  result.heapAfter = (await session.send('Runtime.getHeapUsage')).usedSize;
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.message-assistant:last-child')?.textContent.includes('New final preserved'));
  assert.equal(await page.locator('#timeline .message').count(), 200);
  result.reopenedLatest200 = true;
  if (process.env.AF_LONG_HISTORY_REPORT) fs.writeFileSync(process.env.AF_LONG_HISTORY_REPORT, JSON.stringify(result, null, 2));
  console.log('Long history browser checks passed: ' + JSON.stringify(result));
}
module.exports = { checkLongHistory };
