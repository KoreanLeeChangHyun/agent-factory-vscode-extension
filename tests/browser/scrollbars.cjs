const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkScrollbars(page) {
  const artifactDir = path.resolve(__dirname, '../../../docs/artifact/evidence/hidden-scrollbars');
  fs.mkdirSync(artifactDir, { recursive: true });
  const hiddenScrollbar = async locator => {
    const style = await locator.evaluate(node => ({
      width: getComputedStyle(node).scrollbarWidth,
      gutter: getComputedStyle(node).scrollbarGutter,
      webkit: getComputedStyle(node, '::-webkit-scrollbar').display
    }));
    assert.deepEqual(style, { width: 'none', gutter: 'auto', webkit: 'none' });
  };
  for (const size of [{ width: 795, height: 600 }, { width: 320, height: 420 }]) {
    await page.setViewportSize(size);
    await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-keyboard').click();
    const panel = page.locator('#settings-panel-keyboard');
    await hiddenScrollbar(panel);
    assert.ok(await panel.evaluate(node => node.scrollHeight > node.clientHeight));
    await panel.evaluate(node => { node.scrollTop = 0; });
    await panel.hover();
    await page.mouse.wheel(0, 180);
    await page.waitForFunction(() => document.querySelector('#settings-panel-keyboard').scrollTop > 0);
    await panel.screenshot({ path: path.join(artifactDir, `settings-${size.width}.png`) });
    await page.keyboard.press('Escape');

    const prompt = page.locator('#prompt');
    await prompt.fill(Array.from({ length: 80 }, (_, i) => `Message line ${i}`).join('\n'));
    await hiddenScrollbar(prompt);
    await prompt.press('Control+Home');
    const start = await prompt.evaluate(node => ({ top: node.scrollTop, caret: node.selectionStart }));
    assert.equal(start.caret, 0);
    await prompt.press('Control+End');
    assert.ok(await prompt.evaluate((node, top) => node.scrollTop > top && node.selectionStart === node.value.length, start.top), 'Caret navigation still scrolls the input');
    await prompt.fill('');
  }

  await page.setViewportSize({ width: 795, height: 600 });
  // Exercise real diff styles with long output in both dimensions.
  await page.locator('#timeline').evaluate(node => {
    const details = document.createElement('details');
    details.className = 'git-diff-preview'; details.open = true;
    const summary = document.createElement('summary'); summary.textContent = 'Long output';
    const pre = document.createElement('pre'); pre.id = 'scrollbar-output-fixture';
    const code = document.createElement('code');
    code.textContent = Array.from({ length: 100 }, () => 'long output '.repeat(100)).join('\n');
    pre.append(code); details.append(summary, pre); node.replaceChildren(details);
    const spacer = document.createElement('div'); spacer.style.cssText = 'min-height:2000px;flex-shrink:0';
    node.append(spacer); node.scrollTop = 0;
  });
  const output = page.locator('#scrollbar-output-fixture');
  await hiddenScrollbar(output);
  await output.hover();
  await page.mouse.wheel(200, 160);
  await page.waitForFunction(() => {
    const node = document.querySelector('#scrollbar-output-fixture');
    return node.scrollTop > 0 && node.scrollLeft > 0;
  });
  const timeline = page.locator('#timeline');
  assert.deepEqual(await timeline.evaluate(node => ({ width: getComputedStyle(node).scrollbarWidth, gutter: getComputedStyle(node).scrollbarGutter })), { width: 'thin', gutter: 'stable' });
  assert.notEqual(await timeline.evaluate(node => getComputedStyle(node, '::-webkit-scrollbar').display), 'none');
  const bounds = await timeline.boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + bounds.height - 10);
  await page.mouse.wheel(0, 200);
  await page.waitForFunction(() => document.querySelector('#timeline').scrollTop > 0);
  await page.screenshot({ path: path.join(artifactDir, 'timeline-and-output.png') });

  // Include hidden menus and future scroll containers: only the transcript opts out.
  const visibleBars = await page.locator('body *').evaluateAll(nodes => nodes.filter(node => node.id !== 'timeline' && /auto|scroll/.test(getComputedStyle(node).overflowX + getComputedStyle(node).overflowY) && getComputedStyle(node).scrollbarWidth !== 'none').map(node => node.id || node.className));
  assert.deepEqual(visibleBars, []);
}
module.exports = { checkScrollbars };
