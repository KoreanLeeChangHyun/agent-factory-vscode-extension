const assert = require('node:assert/strict');
async function checkAgentModels(page) {
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, taskModes: ['direct', 'work', 'work-verification'] };
  await emit({ type: 'host.initialize', panelId: 'roles', role: 'main', title: 'Main', agentPermissions: { main: 'bypass', work: 'bypass', verification: 'danger-full-access' }, runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  await emit({ type: 'agent.defaults', settings: { effective: { work: { model: 'work-model', reasoningEffort: 'medium' }, verification: { model: 'verify-model', reasoningEffort: 'high' } }, sources: {} } });
  assert.equal(await page.locator('#reasoning-button').isVisible(), false);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu select[data-role]').count(), 3);
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.model), 'work-model');
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.reasoningEffort), 'medium');
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
    await page.locator(`#model-menu input[data-role="${role}"][data-field="reasoningEffort"]`).fill(String(["none", "low", "medium", "high", "xhigh", "max"].indexOf(effort)));
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
  assert.equal(await page.locator('#model-menu option[value=""]').count(), 0);
  assert.equal(await page.locator('#model-menu .agent-setting-reset').count(), 0);
  assert.equal(await page.locator('#model-menu .agent-setting-source').count(), 0);
  await emit({ type: 'agent.defaults', settings: { effective: { work: { model: 'different', reasoningEffort: 'none' } }, sources: {} } });
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.model), 'work-model');
  await emit({ type: 'models.list', models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] });
  await page.locator('#model-menu select[data-role="main"][data-field="model"]').selectOption('gpt-5.6-sol');
  await page.locator('#model-menu input[data-role="main"][data-field="reasoningEffort"]').fill('2');

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
    assert.ok(Math.abs(modelBox.width - rangeBox.width) < 1);
    const rows = await page.locator('#model-menu .agent-model-row').evaluateAll(rows => rows.map(row => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, width: r.width, height: r.height }; };
      return [rect(row.querySelector('select[data-field="model"]')), rect(row.querySelector('input[type="range"]'))];
    }));
    for (const [model, reasoning] of rows) {
      assert.ok(Math.abs(model.y - reasoning.y) < 1, 'Role controls must share a horizontal centerline');
    }
    await reasoning.fill('3');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'high');
    const slider = page.locator('.agent-reasoning-slider').first();
    assert.equal(await slider.locator('.agent-reasoning-ticks span').count(), 6);
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 3);
    await reasoning.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'medium');
    await reasoning.press('Home');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'none');
    assert.equal(await reasoning.getAttribute('aria-valuetext'), 'none');
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 0);
    await reasoning.press('End');
    assert.equal(await page.evaluate(() => window.saved.reasoning), 'max');
    assert.equal(await slider.locator('progress').evaluate(element => element.value), 5);
    assert.equal(await reasoning.evaluate(element => element.closest('.agent-reasoning-control').classList.contains('is-ultra')), true);
    assert.equal(await page.locator('.agent-reasoning-value').first().textContent(), 'ULTRA');
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'ultra-' + width + '.png') });
    await reasoning.fill('2');
    assert.equal(await reasoning.evaluate(element => element.closest('.agent-reasoning-control').classList.contains('is-ultra')), false);

  }
  assert.equal(await page.locator('[data-permission-role]').count(), 0);
  assert.equal(await page.locator('#model-menu [data-setting="permissions"]').count(), 0);
  // Project and global defaults are edited from the same panel through its scope selector.
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {}, effective: {}, sources: {}, projectAvailable: true } });
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'chat');
  assert.equal(await page.locator('#model-menu #agent-default-fields').count(), 0);
  await page.locator('#agent-default-scope').selectOption('project');
  assert.equal(await page.locator('#agent-default-scope').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#model-menu #agent-default-fields select').count(), 3);
  await page.locator('#agent-default-fields select').first().selectOption('gpt-6-astra');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'project', role: 'main', field: 'model', value: 'gpt-6-astra' });
  assert.equal(await page.locator('#agent-default-fields input[type=range]').count(), 3);
  await page.locator('#agent-default-fields input[data-role=work]').fill('5');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'project', role: 'work', field: 'reasoningEffort', value: 'xhigh' });
  await page.locator('#agent-default-scope').selectOption('global');
  await page.locator('#agent-default-fields input[data-role=verification]').fill('6');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'global', role: 'verification', field: 'reasoningEffort', value: 'max' });
  // A defaults update keeps the chosen scope instead of snapping back to chat rows.
  await emit({ type: 'agent.defaults', settings: { global: { verification: { reasoningEffort: 'max' } }, project: {}, effective: {}, sources: {}, projectAvailable: true } });
  assert.equal(await page.locator('#model-menu #agent-default-fields .agent-model-row').count(), 3);
  for (const width of [795, 566, 320]) {
    await page.setViewportSize({ width, height: 740 });
    assert.equal(await page.locator('#agent-scope-row > span').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length;
    }), 1, 'Scope label must remain on one line');
    for (const row of await page.locator('#agent-default-fields .agent-model-row').all()) {
      const model = await row.locator('select').boundingBox();
      const effort = await row.locator('input[type=range]').boundingBox();
      assert.ok(Math.abs(model.y + model.height / 2 - effort.y - effort.height / 2) < 1);
    }
    assert.equal(await page.locator('#model-menu').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const control = page.locator('#agent-default-fields select').first();
    assert.equal(await control.evaluate(el => getComputedStyle(el).height), '34px');
    assert.notEqual(await control.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    await page.locator('#model-menu').evaluate(el => { el.scrollTop = 0; });
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'defaults-' + width + '.png') });
  }
  await page.locator('#agent-default-scope').selectOption('chat');
  assert.equal(await page.locator('#model-menu select[data-role="main"][data-field="model"]').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#settings-tab-general').click();
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
  await page.locator('#status-settings-button').click();
  await emit({ type: 'run.state', running: true });
  assert.equal(await page.locator('#general-permissions select[data-setting="permissions"]').isDisabled(), true);
  await page.locator('#status-settings-close').click();
  assert.equal(await page.locator('#status-settings').isVisible(), false);
  assert.equal(await page.locator('#status-settings-button').evaluate(element => element === document.activeElement), true);
  await emit({ type: 'run.state', running: false });
  await checkModelVendorTabs(page, emit);
}

async function checkModelVendorTabs(page, emit) {
  // Vendor tabs group the catalog; a vendor served by several CLIs names each route.
  await page.locator('#model-button').click();
  await emit({ type: 'models.list', models: ['gpt-5.6-sol', 'claude-opus-5-5', 'antigravity/claude-sonnet-4-6', 'gemini-3.8-flash', 'antigravity/gpt-oss-120b-medium'] });
  const row = page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  const model = row.locator('select[data-field="model"]');
  const tabs = row.locator('.model-vendor-tab');
  const visible = () => model.evaluate(el => [...el.options].filter(o => !o.hidden && !o.parentElement.hidden).map(o => o.value));
  assert.deepEqual(await tabs.allTextContents(), ['OpenAI', 'Anthropic', 'Google']);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await visible(), ['gpt-5.6-sol', 'antigravity/gpt-oss-120b-medium']);
  await tabs.nth(1).click();
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await visible(), ['claude-opus-5-5', 'antigravity/claude-sonnet-4-6']);
  assert.deepEqual(await model.evaluate(el => [...el.querySelectorAll('optgroup')].filter(g => !g.hidden).map(g => g.label)), ['Claude Code', 'Antigravity']);
  assert.equal(await model.locator('option[value="antigravity/claude-sonnet-4-6"]').textContent(), 'claude-sonnet-4-6 · Antigravity');
  await model.selectOption('antigravity/claude-sonnet-4-6');
  // A tab click opens the native picker; close it as a click outside would.
  await model.evaluate(el => el.blur());
  await page.mouse.click(1, 1);
  await page.locator('#model-button').click();
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', 'The selected model reopens on its vendor tab');
  await tabs.nth(2).click();
  assert.deepEqual(await visible(), ['gemini-3.8-flash']);
  // The tabs share the 16px line above the select, so rows keep their height.
  const [tabBox, selectBox] = [await row.locator('.model-vendor-tabs').boundingBox(), await model.boundingBox()];
  assert.ok(tabBox.y + tabBox.height <= selectBox.y + 1 && tabBox.height <= 17, JSON.stringify([tabBox, selectBox]));
  await page.mouse.click(1, 1);
  if (await page.locator('#model-menu').isVisible()) await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Route check');
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1).execution.model), 'antigravity/claude-sonnet-4-6');
  // A started conversation keeps its provider: other routes stay visible but cannot be chosen.
  const capability = { model: true, reasoning: true, taskModes: ['direct'] };
  await emit({ type: 'session.bound', agentId: 'main-roles' });
  await emit({ type: 'capabilities.updated', capabilities: { submit: capability, send: { ...capability, sessionProvider: 'antigravity' } } });
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  await row.locator('.model-vendor-tab').nth(1).click();
  const disabled = await model.evaluate(el => Object.fromEntries([...el.options].map(o => [o.value, o.disabled])));
  assert.deepEqual(disabled, { 'gpt-5.6-sol': true, 'antigravity/gpt-oss-120b-medium': false, 'claude-opus-5-5': true,
    'antigravity/claude-sonnet-4-6': false, 'gemini-3.8-flash': false });
  // Close the picker the tab click opened so the screenshots show the resting layout.
  await page.mouse.click(1, 1);
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = path.resolve(__dirname, '../../out/agent-settings');
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    assert.equal(await page.locator('#model-menu').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    // Every vendor name stays readable at both widths.
    const fit = await row.locator('.model-vendor-tab').evaluateAll(tabs => tabs.map(tab => [tab.textContent, tab.scrollWidth, tab.clientWidth, tab.parentElement.clientWidth]));
    assert.ok(fit.every(([, scroll, client]) => scroll <= client), JSON.stringify([width, fit]));
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'vendor-tabs-' + width + '.png') });
  }
  await page.keyboard.press('Escape');
}
module.exports = { checkAgentModels };
