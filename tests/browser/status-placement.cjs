const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
        return !progress.hidden && (running ? progress.dataset.feedback === 'awaiting' : progress.dataset.feedback === 'ended');
      }, running);
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        return { progress: box('#agent-progress'), label: box('#run-status-label'), composer: box('.composer'), workflow: box('#run-status-toggle'), history: box('#workflow-history'), topline: box('.composer-topline'), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      measurements.push({ width, running, ...geometry });
      await page.locator('.composer-region').screenshot({ path: path.join(artifacts, `status-placement-${process.env.STATUS_PLACEMENT_BASELINE ? 'before' : 'after'}-${width}-${running ? 'running' : 'ended'}.png`) });
      if (process.env.STATUS_PLACEMENT_BASELINE) continue;
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.progress.bottom <= geometry.composer.y + 1, 'Status must stay above the composer border');
      assert.ok(geometry.composer.y - geometry.progress.bottom <= 6, 'Status must sit close to the composer');
      assert.ok(geometry.progress.right <= geometry.workflow.x + 1, 'Progress and task controls must not overlap');
      assert.ok(geometry.label.height >= 12 && geometry.label.width > 0, 'Status text must remain visible');
      assert.ok(Math.abs(geometry.progress.y - geometry.workflow.y) <= 2, 'Status and task controls share one row');
      if (running) runningTop = geometry.composer.y;
      else assert.ok(Math.abs(geometry.composer.y - runningTop) <= 1, 'Completion must not shift the composer');
      assert.equal(await page.locator('#model-label').textContent(), 'gpt-6-astra · 높음');
      assert.equal(await page.locator('#run-status-label').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'The status label must fit without clipping');
      assert.ok(await page.locator('.astra-star').count() > 0);
    }
    if (!process.env.STATUS_PLACEMENT_BASELINE) {
      await page.locator('#run-status-toggle').click();
      assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#agent-progress').isVisible(), true);
      await page.locator('#run-status-toggle').click();
      assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#run-status-label').textContent(), '실행 종료');
    }
  }
  fs.writeFileSync(path.join(artifacts, `status-placement-${process.env.STATUS_PLACEMENT_BASELINE ? 'before' : 'after'}.json`), JSON.stringify(measurements, null, 2));
  console.log('Status placement: running/ended at 320, 465 and 795px checked.');
}
module.exports = { checkStatusPlacement };
