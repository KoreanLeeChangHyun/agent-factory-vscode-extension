const assert = require('node:assert/strict');

// Uses the real chat template/CSS and the existing fixture's VS Code state bridge.
// Exported separately so Main can also run this focused check in its browser fixture.
async function checkStatusCustomizationLayout(page) {
  const originalViewport = page.viewportSize();
  const originalItems = await page.evaluate(() => window.saved.statusItems ??
    Array.from(document.querySelectorAll('#status-bar [data-item-id]'), element => element.dataset.itemId));
  const settings = page.locator('#status-settings');
  const button = page.locator('#status-settings-button');
  const layout = () => page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return { composer: rect('.composer-region'), footer: rect('.status-footer') };
  });
  const sameLayout = (actual, expected) => {
    for (const element of ['composer', 'footer']) {
      for (const dimension of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(actual[element][dimension] - expected[element][dimension]) <= 1,
          `${element} ${dimension} must remain stable when customization opens/closes`);
      }
    }
  };
  const setItems = async items => {
    await page.evaluate(items => window.postMessage({ type: 'status.updated', items }, '*'), items);
    await page.waitForFunction(items => JSON.stringify(window.saved.statusItems) === JSON.stringify(items), items);
  };
  try {
    for (const width of [420, 900]) {
      await page.setViewportSize({ width, height: 740 });
      await setItems(['status', 'agents', 'project', 'branch', 'context', 'queue']);
      assert.equal(await settings.isHidden(), true);
      const before = await layout();
      await button.click();
      const box = await settings.boundingBox();
      assert.ok(box && box.height > 200, 'Catalog must be usable, not squeezed into the footer track');
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.ok(box.y >= 0 && box.y + box.height <= before.footer.y + 1, 'Overlay must fit above the footer');
      sameLayout(await layout(), before);
      const appearance = await settings.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          scrollable: element.scrollHeight > element.clientHeight && ['auto', 'scroll'].includes(style.overflowY),
          background: style.backgroundColor
        };
      });
      assert.ok(appearance.scrollable, 'All catalog rows must be reachable by scrolling');
      assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)', 'Overlay must have an opaque themed surface');
      // Hit testing detects a panel painted behind the composer even when its box is correct.
      const firstCheckbox = settings.locator('input[type="checkbox"]').first();
      assert.equal(await firstCheckbox.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
      }), true);
      const source = settings.locator('[data-item-id="agents"]');
      const target = settings.locator('[data-item-id="status"]');
      await source.dragTo(target, { targetPosition: { x: 12, y: 4 } });
      await page.waitForFunction(() => window.saved.statusItems[0] === 'agents');
      assert.deepEqual(await page.evaluate(() => window.saved.statusItems.slice(0, 2)), ['agents', 'status']);
      await settings.locator('[data-item-id="goalBudget"] input').scrollIntoViewIfNeeded();
      await settings.locator('[data-item-id="goalBudget"] input').check();
      assert.ok(await page.evaluate(() => window.saved.statusItems.includes('goalBudget')));
      await page.keyboard.press('Escape');
      assert.equal(await settings.isHidden(), true);
      assert.equal(await button.evaluate(element => document.activeElement === element), true);
      sameLayout(await layout(), before);
    }
  } finally {
    if (await settings.isVisible()) await page.locator('#status-settings-close').click();
    await setItems(originalItems);
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}

module.exports = { checkStatusCustomizationLayout };
