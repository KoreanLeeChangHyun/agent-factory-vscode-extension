const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The status line above the composer starts on the prompt text edge, sits just above the composer,
// and clears on its own once a run ends with nothing left to do.
async function checkStatusPlacement(page) {
  const artifacts = path.resolve(__dirname, '../../../docs/artifact/preview/maestro-screen-draft');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({
    panelId: 'placement', role: 'main', uiLanguage: 'ko', model: 'gpt-6-astra', reasoning: 'high', draft: '', timeline: []
  })));
  await page.goto(new URL('/?lang=ko', page.url()).href);
  const measurements = [];
  for (const width of [320, 465, 795]) {
    await page.setViewportSize({ width, height: 740 });
    let runningTop;
    for (const running of [true, false]) {
      await page.evaluate(running => window.postMessage({ type: 'run.state', running }, '*'), running);
      await page.waitForFunction(running => {
        const progress = document.getElementById('agent-progress');
        return !progress.hidden && progress.dataset.feedback === (running ? 'awaiting' : 'ended');
      }, running);
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const prompt = document.getElementById('prompt');
        return { progress: box('#agent-progress'), dot: box('#agent-progress .run-status-pulse'), label: box('#run-status-label'), composer: box('.composer'), model: box('#model-label'),
          promptText: prompt.getBoundingClientRect().left + parseFloat(getComputedStyle(prompt).paddingLeft), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      measurements.push({ width, running, ...geometry });
      if (process.env.STATUS_PLACEMENT_SCREENSHOTS) await page.locator('.composer-region').screenshot({ path: path.join(artifacts, `status-placement-after-${width}-${running ? 'running' : 'ended'}.png`) });
      const context = JSON.stringify({ width, running, geometry });
      assert.equal(geometry.overflow, false);
      assert.ok(Math.abs(geometry.dot.x - geometry.promptText) <= 1, 'Status dot starts on the prompt text edge ' + context);
      assert.ok(Math.abs(geometry.model.x - geometry.promptText) <= 1.5, 'Model control text shares that edge ' + context);
      assert.ok(geometry.progress.bottom <= geometry.composer.y + 1, 'Status must stay above the composer border');
      assert.ok(geometry.composer.y - geometry.progress.bottom <= 6, 'Status must sit close to the composer');
      assert.ok(Math.abs((geometry.dot.y + geometry.dot.height / 2) - (geometry.label.y + geometry.label.height / 2)) <= 1, 'Dot and text share one line ' + context);
      assert.ok(geometry.label.height >= 12 && geometry.label.width > 0, 'Status text must remain visible');
      if (running) runningTop = geometry.composer.y;
      else assert.ok(Math.abs(geometry.composer.y - runningTop) <= 1, 'Completion must not shift the composer');
      assert.equal(await page.locator('#model-label').textContent(), 'gpt-6-astra · 높음');
      assert.equal(await page.locator('#run-status-label').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'The status label must fit without clipping');
    }
    assert.equal(await page.locator('#run-status-label').textContent(), '실행 종료');
    await page.waitForFunction(() => document.getElementById('agent-progress').hidden, null, { timeout: 6000 });
    const idle = await page.evaluate(() => ({ topline: document.querySelector('.composer-topline').getBoundingClientRect().height, composer: document.querySelector('.composer').getBoundingClientRect().y }));
    assert.equal(idle.topline, 0, 'Idle composer has no empty status row at ' + width);
    if (process.env.STATUS_PLACEMENT_SCREENSHOTS) await page.locator('.composer-region').screenshot({ path: path.join(artifacts, `status-placement-after-${width}-idle.png`) });
  }
  // A reopened webview restores no stale run outcome.
  await page.reload();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#agent-progress').isVisible(), false, 'Reopening shows no previous run outcome');
  if (process.env.STATUS_PLACEMENT_SCREENSHOTS) fs.writeFileSync(path.join(artifacts, 'status-placement-after.json'), JSON.stringify(measurements, null, 2));
  console.log('Status placement: running/ended/idle at 320, 465 and 795px and reopen checked.');
}
module.exports = { checkStatusPlacement };
