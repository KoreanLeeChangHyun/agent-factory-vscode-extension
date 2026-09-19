const assert = require('node:assert/strict');
async function checkAgentModels(page) {
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, taskModes: ['direct', 'work', 'work-verification'] };
  await emit({ type: 'host.initialize', panelId: 'roles', role: 'main', title: 'Main', agentPermissions: { main: 'bypass', work: 'bypass', verification: 'danger-full-access' }, runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  assert.equal(await page.locator('#reasoning-button').isVisible(), false);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu select[data-role]').count(), 3);
  for (const height of [900, 600]) {
    await page.setViewportSize({ width: 795, height });
    const layout = await page.locator('#model-menu').evaluate(element => ({
      scroll: element.scrollHeight, client: element.clientHeight,
      top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom
    }));
    assert.ok(layout.client > 0 && layout.scroll >= layout.client);
    assert.ok(layout.top >= 0 && layout.bottom <= height);
  }
  for (const select of await page.locator('#model-menu select:visible').all()) {
    await select.evaluate(element => element.blur());
    const idleBorder = await select.evaluate(element => getComputedStyle(element).borderTopColor);
    await select.focus();
    const focus = await select.evaluate(element => {
      const style = getComputedStyle(element);
      return { outline: style.outlineStyle, border: style.borderTopColor };
    });
    assert.equal(focus.outline, 'none');
    assert.equal(focus.border, idleBorder);
  }
  for (const [role, model, effort] of [['main', 'main-model', 'low'], ['work', 'work-model', 'high'], ['verification', 'verify-model', 'medium']]) {
    await page.locator(`#model-menu select[data-role="${role}"][data-field="model"]`).selectOption(model);
    await page.locator(`#model-menu input[data-role="${role}"][data-field="reasoningEffort"]`).fill(String(["", "none", "low", "medium", "high", "xhigh", "max"].indexOf(effort)));
  }
  const saved = await page.evaluate(() => window.saved);
  assert.equal(saved.model, 'main-model');
  assert.equal(saved.agentModels.work.reasoningEffort, 'high');
  assert.equal(saved.agentModels.verification.model, 'verify-model');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Do the task');
  await page.locator('#prompt').press('Enter');
  const sent = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1));
  assert.equal(sent.execution.model, 'main-model');
  assert.equal(sent.execution.reasoningEffort, 'low');
  assert.deepEqual(sent.execution.agentModels, saved.agentModels);
  await page.locator('#model-button').click();
  await page.locator('#model-menu select[data-role="work"][data-field="model"]').selectOption('');
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.model), undefined);
  assert.equal(sent.execution.agentModels.work.model, 'work-model');
  await emit({ type: 'models.list', models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] });
  await page.locator('#model-menu select[data-role="main"][data-field="model"]').selectOption('gpt-5.6-sol');
  await page.locator('#model-menu input[data-role="main"][data-field="reasoningEffort"]').fill('3');
  await page.locator('#model-menu select[data-role="verification"][data-field="model"]').selectOption('');
  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = path.resolve(__dirname, '../../out/agent-settings');
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const layout = await page.locator('#model-menu').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overflow: element.scrollWidth > element.clientWidth + 1 };
    });
    assert.ok(layout.left >= 0 && layout.right <= width && layout.top >= 0 && layout.bottom <= 740, JSON.stringify(layout));
    assert.equal(layout.overflow, false);
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'settings-' + width + '.png') });
    const reasoning = page.locator('#model-menu input[data-role="main"][data-field="reasoningEffort"]');
    assert.equal(await reasoning.getAttribute('aria-valuetext'), 'medium');
    const modelBox = await page.locator('#model-menu select[data-role="main"]').boundingBox();
    const rangeBox = await reasoning.boundingBox();
    const permissionsBox = await page.locator('[data-setting="permissions"]').boundingBox();
    assert.ok(Math.abs(modelBox.width - rangeBox.width) < 1);
    assert.ok(Math.abs(modelBox.width - permissionsBox.width) < 1);
    if (width > 480) assert.ok(Math.abs(permissionsBox.x - modelBox.x) < 1);
    const rows = await page.locator('.agent-model-row').evaluateAll(rows => rows.map(row => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, width: r.width, height: r.height }; };
      return [rect(row.querySelector('select[data-field="model"]')), rect(row.querySelector('input[type="range"]'))];
    }));
    for (const [model, reasoning] of rows) {
      assert.ok(Math.abs(model.y - reasoning.y) < 1, 'Role controls must share a horizontal centerline');
    }
    await reasoning.fill('4');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'high');
    const slider = page.locator('.agent-reasoning-slider').first();
    assert.equal(await slider.locator('.agent-reasoning-ticks span').count(), 7);
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 4);
    await reasoning.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'medium');
    await reasoning.press('Home');
    assert.equal(await page.evaluate(() => window.saved.reasoning), '');
    assert.equal(await reasoning.getAttribute('aria-valuetext'), 'Default');
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 0);
    await reasoning.press('End');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'max');
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 6);
    assert.equal(await reasoning.evaluate(element => element.closest('.agent-reasoning-control').classList.contains('is-ultra')), true);
    assert.equal(await page.locator('.agent-reasoning-value').first().textContent(), 'ULTRA');
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'ultra-' + width + '.png') });
    await reasoning.fill('3');
    assert.equal(await reasoning.evaluate(element => element.closest('.agent-reasoning-control').classList.contains('is-ultra')), false);

  }
  assert.equal(await page.locator('[data-permission-role]').count(), 0);
  const common = page.locator('[data-setting="permissions"]');
  await common.selectOption('bypass');
  assert.equal(await page.locator('#agent-permissions-description').isVisible(), false);
  assert.equal(await page.getByText('Disable sandbox restrictions and approval prompts.', { exact: true }).count(), 0);
  await common.selectOption('workspace-write');
  assert.equal(await page.locator('#agent-permissions-description').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Shared permission snapshot');
  await page.locator('#prompt').press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1).execution.agentPermissions), { main: 'workspace-write', work: 'workspace-write', verification: 'workspace-write' });
  assert.equal(await page.evaluate(() => window.saved.agentPermissions), undefined);
  await page.locator('#model-button').click();
  await emit({ type: 'run.state', running: true });
  assert.equal(await page.locator('#model-menu select[data-setting="permissions"]').isDisabled(), true);
  await page.getByRole('button', { name: 'Close agent settings', exact: true }).click();
  assert.equal(await page.locator('#model-menu').isVisible(), false);
  assert.equal(await page.locator('#model-button').evaluate(element => element === document.activeElement), true);
}
module.exports = { checkAgentModels };
