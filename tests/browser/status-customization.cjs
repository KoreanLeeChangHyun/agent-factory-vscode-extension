const assert = require('node:assert/strict');

// Uses the real chat template/CSS and the existing fixture's VS Code state bridge.
// Exported separately so Main can also run this focused check in its browser fixture.
async function checkStatusCustomizationLayout(page) {
  // The free-floating companion can rest over the status bar after a resize; this layout check is about the status settings only.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'bots.updated', enabled: false } })));
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
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'workUnits.summary', activeUnits: 0, totalCalled: 0 } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'goal.updated', goal: { status: 'active', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 1000 } } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'usage.accounts', accounts: {
      codex: { weeklyUsedPercent: 60, weeklyResetsAt: Date.now() / 1000 + 86400, reportedAt: Date.now() },
      claude: { fiveHourUsedPercent: 72, fiveHourResetsAt: Date.now() / 1000 + 3600, weeklyUsedPercent: 25, reportedAt: Date.now() }
    } } }));
  });
  try {
    for (const width of [420, 900]) {
      await page.setViewportSize({ width, height: 740 });
      await setItems(['status', 'agents', 'project', 'branch', 'context', 'queue']);
      assert.equal(await settings.isHidden(), true);
      const before = await layout();
      await button.click();
      await page.locator("#settings-tab-status").click();
      await settings.locator('#settings-panel-status').evaluate(element => { element.scrollTop = 0; });
      const box = await settings.boundingBox();
      assert.ok(box && box.height > 200, 'Catalog must be usable, not squeezed into the footer track');
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.ok(box.y >= 0 && box.y + box.height <= before.footer.y + 1, 'Overlay must fit above the footer');
      sameLayout(await layout(), before);
      const appearance = await settings.evaluate(element => {
        const style = getComputedStyle(element);
        const panel = element.querySelector('#settings-panel-status');
        return {
          scrollable: panel.scrollHeight > panel.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY),
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
      const down = settings.locator('[data-item-id="agents"] button').last();
      assert.equal(await down.locator('svg[aria-hidden="true"]').count(), 1);
      assert.equal((await down.textContent()).trim(), '');
      await down.focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.saved.statusItems.slice(0, 2)), ['status', 'agents']);
      assert.equal(await settings.locator('[data-item-id="agents"] button').last().evaluate(element => document.activeElement === element), true);
      assert.ok(await settings.locator('[data-item-id="agents"]').evaluate(element => element.getBoundingClientRect().height < 60), 'Selected rows must stay compact');
      await settings.locator('[data-item-id="goalBudget"] input').scrollIntoViewIfNeeded();
      assert.equal(await settings.locator('.status-settings-heading').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + 2, rect.y + rect.height / 2));
      }), true, 'Settings heading must stay visible while the content scrolls');
      assert.equal(await settings.locator('#settings-tab-bot').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, 'Settings tabs must stay clickable while the content scrolls');
      await settings.locator('[data-item-id="goalBudget"] input').check();
      assert.ok(await page.evaluate(() => window.saved.statusItems.includes('goalBudget')));
      await settings.locator('#settings-tab-usage').click();
      assert.equal(await settings.locator('.usage-group').count(), 4);
      assert.ok(await page.evaluate(() => window.sentMessages.some(message => message.type === 'usage.refresh')),
        'Opening settings asks the host for fresh Antigravity quota');
      assert.deepEqual(await settings.locator('.usage-meter').evaluateAll(elements => elements.map(element => element.value)), [40, 28, 75]);
      assert.equal(await settings.locator('.usage-limit[data-level="medium"]').count(), 2);
      assert.equal(await settings.locator('.usage-limit[data-level="healthy"]').count(), 1);
      assert.equal(await settings.locator('#account-usage').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1,
        'Providers stay in one scan-friendly column');
      const limitColumns = await settings.locator('.usage-group[data-provider="claude"] .usage-limits').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      assert.equal(limitColumns, width <= 480 ? 1 : 2, 'Limits adapt inside each provider card');
      assert.equal(await settings.locator('.usage-group[data-provider="claude"] .usage-group-heading > .usage-reported').count(), 1,
        'Last report time stays with the provider heading');
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

async function checkStatusAvailability(page) {
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const items = ['status', 'goalTokens', 'goalBudget', 'goalTime', 'contextUsed', 'weekly'];
  await emit({ type: 'host.initialize', runtimeAvailable: true, statusItems: items, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'goal.updated', goal: null });
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-status').click();
  const bar = page.locator('#status-bar');
  // Unavailable metrics leave the status bar; the settings list keeps them, marked unavailable.
  for (const id of items.slice(1)) {
    assert.equal(await bar.locator(`[data-item-id="${id}"]`).count(), 0);
    assert.equal(await page.locator(`#status-settings [data-item-id="${id}"]`).getAttribute('data-available'), 'false');
  }
  assert.equal(await page.getByText('Some metrics are unavailable', { exact: true }).count(), 0);
  await emit({ type: 'goal.updated', goal: { status: 'active', tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 500 } });
  for (const id of ['goalTokens', 'goalBudget', 'goalTime']) {
    assert.equal(await bar.locator(`[data-item-id="${id}"]`).count(), 1, 'Zero is a provided value');
    assert.equal(await page.locator(`#status-settings [data-item-id="${id}"]`).getAttribute('data-available'), 'true');
  }
  await emit({ type: 'goal.updated', goal: null });
  assert.equal(await bar.locator('[data-item-id="goalBudget"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.saved.statusItems), items, 'Hidden selections retain their saved order');
  await page.locator('#status-settings-close').click();
}
module.exports.checkStatusAvailability = checkStatusAvailability;
