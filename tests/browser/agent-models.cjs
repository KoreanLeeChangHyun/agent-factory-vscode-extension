const assert = require('node:assert/strict');
async function chooseModel(row, value) {
  const control = row.locator('button[data-field="model"]');
  await control.click();
  await row.locator(`.model-picker-option[data-value="${value}"]`).click();
}
async function checkFastSetting(page) {
  await page.goto(new URL('/?lang=ko', page.url()).href);
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, fast: true, taskModes: ['direct'] };
  const initialize = { type: 'host.initialize', panelId: 'fast-setting', role: 'main', title: 'Main', model: 'main-model', reasoning: 'medium', fastMode: true, agentFastModes: {main:{'main-model':true}}, runtimeAvailable: true, capabilities: { submit: capability, send: capability } };
  await emit(initialize);
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {
    main: { model: 'gpt-6-astra', reasoningEffort: 'medium', fast: false },
    work: { model: 'gpt-6-astra', reasoningEffort: 'medium', fast: true },
    workLight: { model: 'gpt-6-astra', reasoningEffort: 'low', fast: false },
    verification: { model: 'gpt-6-astra', reasoningEffort: 'high', fast: true },
    fastByRoleModel: { main: {'gpt-6-astra': false}, work: {'gpt-6-astra': true}, workLight: {'gpt-6-astra': false}, verification: {'gpt-6-astra': true} }
  }, projectAvailable: true } });
  assert.equal(await page.locator('#fast-mode-button').isVisible(), false, 'Fast has no duplicate composer control');
  await page.locator('#model-button').click();
  await page.locator('#agent-default-scope').selectOption('chat');
  const fast = page.locator('#model-menu button[data-role="main"][data-field="fast"]');
  assert.equal(await page.locator('#model-menu > #agent-fast-setting').count(), 0);
  assert.equal(await page.locator('#model-menu .agent-settings-columns > span').last().textContent(), '빠른 모드');
  assert.equal(await fast.getAttribute('aria-pressed'), 'true');
  assert.equal(await fast.getAttribute('aria-label'), '조율자 빠른 모드 켜짐');
  assert.equal(await fast.locator('span').textContent(), '켜짐');
  const scopeBefore = await page.locator('#agent-default-scope').inputValue();
  const defaultsBefore = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'agent.defaults.save' || message.type === 'agent.preset.field').length);
  await fast.click();
  assert.equal(await fast.getAttribute('aria-pressed'), 'false');
  assert.equal(await fast.getAttribute('aria-label'), '조율자 빠른 모드 꺼짐');
  assert.equal(await fast.locator('span').textContent(), '꺼짐');
  assert.equal(await page.locator('#agent-default-scope').inputValue(), scopeBefore, 'Fast is independent of the selected defaults scope');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'agent.defaults.save' || message.type === 'agent.preset.field').length), defaultsBefore);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'composer.settings').at(-1).fastMode), false);
  await page.keyboard.press('Escape');
  await page.locator('#model-button').click();
  const reopenedFast = page.locator('#model-menu button[data-role="main"][data-field="fast"]');
  assert.equal(await reopenedFast.getAttribute('aria-pressed'), 'false', 'Closing and reopening settings preserves Fast');
  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = process.env.AF_MODEL_SETTINGS_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/model-settings-copy-20261004');
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const size of [{ width: 465, height: 556 }, { width: 721, height: 402 }]) {
    await page.setViewportSize(size);
    await reopenedFast.scrollIntoViewIfNeeded();
    const layout = await page.locator('#model-menu').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, horizontalOverflow: element.scrollWidth > element.clientWidth + 1 };
    });
    assert.ok(layout.left >= 0 && layout.right <= size.width && layout.top >= 0 && layout.bottom <= size.height, JSON.stringify({ size, layout }));
    assert.ok(Math.abs(layout.width - (size.width <= 560 ? size.width - 24 : 560)) < 1, JSON.stringify({ size, layout }));
    assert.equal(layout.horizontalOverflow, false, JSON.stringify({ size, layout }));
    assert.equal(await reopenedFast.isVisible(), true);
    const stateLabel = await reopenedFast.locator('span').evaluate(element => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      wraps: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
    }));
    assert.deepEqual(stateLabel, { whiteSpace: 'nowrap', wraps: false }, JSON.stringify({ size, stateLabel }));
    const rowLayout = await page.locator('#model-menu .agent-model-row[data-agent-role="main"]').evaluate(row => {
      const box = selector => { const rect = row.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centerY: rect.top + rect.height / 2 }; };
      return { model: box('button[data-field="model"]'), reasoning: box('input[data-field="reasoningEffort"]'), fast: box('button[data-field="fast"]') };
    });
    assert.ok(Math.abs(rowLayout.model.centerY - rowLayout.reasoning.centerY) < 2, JSON.stringify({ size, rowLayout }));
    assert.ok(rowLayout.model.right <= rowLayout.reasoning.left, JSON.stringify({ size, rowLayout }));
    // Fast shares the row when space permits; the compact layout keeps it by the role label.
    assert.ok(Math.abs(rowLayout.reasoning.centerY - rowLayout.fast.centerY) < 2 || rowLayout.fast.bottom <= rowLayout.reasoning.top, JSON.stringify({ size, rowLayout }));
    for (const control of await page.locator('#model-menu .agent-model-row :is(button[data-field="model"], input, button[data-field="fast"])').all()) {
      await control.scrollIntoViewIfNeeded();
      assert.equal(await control.isVisible(), true, JSON.stringify({ size, control: await control.getAttribute('data-field') }));
    }
    await page.locator('#model-menu').evaluate(element => { element.scrollTop = 0; });
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, `fast-ko-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 795, height: 900 });
  await emit(initialize);
  assert.equal(await page.locator('#model-menu button[data-role="main"][data-field="fast"]').getAttribute('aria-pressed'), 'true', 'Host restoration reapplies the session Fast state');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Fast capture');
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1).execution.fast), true);
}

async function checkAgentModels(page) {
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, fast: true, taskModes: ['direct', 'work', 'work-verification'] };
  await emit({ type: 'host.initialize', panelId: 'roles', role: 'main', title: 'Main', model: 'main-model', reasoning: 'medium', fastMode: false, agentModels: { work: { model: 'work-model', reasoningEffort: 'medium', fast: false }, verification: { model: 'verify-model', reasoningEffort: 'high', fast: true } }, agentPermissions: { main: 'bypass', work: 'bypass', verification: 'danger-full-access' }, runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {}, projectAvailable: true } });
  assert.equal(await page.locator('#reasoning-button').isVisible(), false);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'chat');
  assert.equal(await page.locator('#agent-fast-setting').isVisible(), false);
  await page.locator('#agent-default-scope').selectOption('chat');
  const mainFast = page.locator('#model-menu button[data-role="main"][data-field="fast"]');
  assert.equal(await mainFast.getAttribute('aria-pressed'), 'false');
  await mainFast.click();
  assert.equal(await mainFast.getAttribute('aria-pressed'), 'true');
  assert.equal(await mainFast.locator('span').textContent(), 'On');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'composer.settings').at(-1).fastMode), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fast-mode-button').isVisible(), false, 'Fast no longer has a duplicate composer control');
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu button[data-role="main"][data-field="fast"]').getAttribute('aria-pressed'), 'true', 'Closing settings preserves the session Fast state');
  assert.deepEqual(await page.locator('#model-menu > .agent-model-row').evaluateAll(rows => rows.map(row => row.dataset.agentRole)), ['main', 'work', 'workLight', 'verification']);
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.model), 'work-model');
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.reasoningEffort), 'medium');
  assert.equal(await page.locator('#model-menu button[data-field="fast"]').count(), 4);
  await page.locator('#model-menu button[data-role="work"][data-field="fast"]').click();
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.fast), true);
  assert.equal(await page.locator('#model-menu button[data-role="verification"][data-field="fast"]').getAttribute('aria-pressed'), 'true');
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
    await chooseModel(page.locator(`#model-menu .agent-model-row[data-agent-role="${role}"]`), model);
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
  assert.equal(sent.execution.fast, true);
  assert.deepEqual(sent.execution.agentModels, saved.agentModels);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu .model-picker-option[data-value=""]').count(), 0);
  assert.equal(await page.locator('#model-menu .agent-setting-reset').count(), 0);
  assert.equal(await page.locator('#model-menu .agent-setting-source').count(), 0);
  await emit({ type: 'agent.defaults', settings: { global: {}, project: { work: { model: 'different', reasoningEffort: 'none' } }, projectAvailable: true } });
  assert.equal(await page.evaluate(() => window.saved.agentModels.work.model), 'work-model');
  await emit({ type: 'models.list', models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] });
  await chooseModel(page.locator('#model-menu .agent-model-row[data-agent-role="main"]'), 'gpt-5.6-sol');
  await page.locator('#model-menu input[data-role="main"][data-field="reasoningEffort"]').fill('2');

  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = process.env.AF_MODEL_SETTINGS_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/model-settings-copy-20261004');
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
    const modelBox = await page.locator('#model-menu button[data-role="main"][data-field="model"]').boundingBox();
    const rangeBox = await reasoning.boundingBox();
    assert.ok(modelBox.width >= rangeBox.width, JSON.stringify({ width, modelBox, rangeBox }));
    const rows = await page.locator('#model-menu .agent-model-row').evaluateAll(rows => rows.map(row => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, width: r.width, height: r.height }; };
      return [rect(row.querySelector('button[data-field="model"]')), rect(row.querySelector('input[type="range"]'))];
    }));
    for (const [model, reasoning] of rows) {
      assert.ok(Math.abs(model.y - reasoning.y) < 1, 'Role model and reasoning controls share a horizontal centerline at every width');
      assert.ok(model.x + model.width <= reasoning.x + 1, 'Role controls must not overlap');
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
  // Project editing cannot change the current chat; global editing belongs to full settings.
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {
    main: { model: 'gpt-6-astra', reasoningEffort: 'medium', fast: false },
    work: { model: 'gpt-6-astra', reasoningEffort: 'medium', fast: true },
    workLight: { model: 'gpt-6-astra', reasoningEffort: 'low', fast: false },
    verification: { model: 'gpt-6-astra', reasoningEffort: 'high', fast: true },
    fastByRoleModel: { main: {'gpt-6-astra': false}, work: {'gpt-6-astra': true}, workLight: {'gpt-6-astra': false}, verification: {'gpt-6-astra': true} }
  }, projectAvailable: true } });
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'chat');
  assert.equal(await page.locator('#model-menu #agent-default-fields').count(), 0);
  await page.locator('#agent-default-scope').selectOption('project');
  assert.equal(await page.locator('#agent-default-scope').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#model-menu #agent-default-fields button[data-field=model]').count(), 4);
  await chooseModel(page.locator('#agent-default-fields .agent-model-row').first(), 'gpt-6-astra');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'project', role: 'main', field: 'model', value: 'gpt-6-astra' });
  assert.equal(await page.locator('#agent-default-fields input[type=range]').count(), 4);
  await page.locator('#agent-default-fields input[data-role=work]').fill('4');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'project', role: 'work', field: 'reasoningEffort', value: 'xhigh' });
  const projectFast = page.locator('#agent-default-fields button[data-role=work][data-field=fast]');
  assert.equal(await projectFast.getAttribute('aria-pressed'), 'true', 'Work restores its own Fast value for the shared model');
  await projectFast.click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.fast').at(-1)), { type: 'agent.defaults.fast', scope: 'project', role: 'work', model: 'gpt-6-astra', value: false });
  assert.equal(await page.locator('#agent-default-fields button[data-role=verification][data-field=fast]').getAttribute('aria-pressed'), 'true', 'Verification remains independent on the same model');
  const chatSettingsBeforeParents = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'composer.settings').at(-1));
  await page.locator('#status-settings-button').evaluate(element => element.click());
  await page.locator('#settings-tab-agents').click();
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'global');
  await page.locator('#agent-default-fields input[data-role=verification]').fill('5');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'global', role: 'verification', field: 'reasoningEffort', value: 'max' });
  // A defaults update keeps the chosen scope instead of snapping back to chat rows.
  await emit({ type: 'agent.defaults', settings: { global: { verification: { reasoningEffort: 'max' } }, project: {}, projectAvailable: true } });
  assert.equal(await page.locator('#global-agent-settings #agent-default-fields .agent-model-row').count(), 4);
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'composer.settings').at(-1)), chatSettingsBeforeParents);
  await page.locator('#status-settings-close').click();
  await page.locator('#model-button').click();
  await page.locator('#agent-default-scope').selectOption('project');
  for (const width of [795, 566, 320]) {
    await page.setViewportSize({ width, height: 740 });
    // The scope selector and saved-set picker share the heading row with the close button.
    const [picker, scope, close] = await Promise.all(['#agent-preset-picker', '#agent-default-scope', '.agent-settings-close'].map(s => page.locator('#model-menu ' + s).boundingBox()));
    for (const box of [scope, close]) assert.ok(Math.abs(box.y + box.height / 2 - picker.y - picker.height / 2) < 2, JSON.stringify([width, picker, box]));
    assert.ok(scope.x + scope.width <= picker.x && picker.x + picker.width <= close.x, JSON.stringify([width, scope, picker, close]));
    assert.equal(await page.locator('#model-menu').getByText('우선순위', { exact: false }).count(), 0);
    for (const row of await page.locator('#agent-default-fields .agent-model-row').all()) {
      const model = await row.locator('button[data-field=model]').boundingBox();
      const effort = await row.locator('input[type=range]').boundingBox();
      assert.ok(model.x + model.width <= effort.x + 1, JSON.stringify([width, model, effort]));
      assert.ok(Math.abs(model.y + model.height / 2 - effort.y - effort.height / 2) < 1, JSON.stringify([width, model, effort]));
    }
    assert.equal(await page.locator('#model-menu').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const control = page.locator('#agent-default-fields button[data-field=model]').first();
    assert.equal(await control.evaluate(el => getComputedStyle(el).height), '34px');
    assert.notEqual(await control.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    await page.locator('#model-menu').evaluate(el => { el.scrollTop = 0; });
    await page.locator('#model-menu').screenshot({ path: path.join(artifactDir, 'defaults-' + width + '.png') });
  }
  await page.locator('#agent-default-scope').selectOption('chat');
  assert.equal(await page.locator('#model-menu button[data-role="main"][data-field="model"]').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#status-settings-button').evaluate(element => element.click());
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
  await page.locator('#status-settings-button').evaluate(element => element.click());
  await emit({ type: 'run.state', running: true });
  assert.equal(await page.locator('#general-permissions select[data-setting="permissions"]').isDisabled(), true);
  await page.locator('#status-settings-close').click();
  assert.equal(await page.locator('#status-settings').isVisible(), false);
  assert.equal(await page.locator('#status-settings-button').evaluate(element => element === document.activeElement), true);
  await emit({ type: 'run.state', running: false });
  await checkModelVendorTabs(page, emit);
}

async function checkModelVendorTabs(page, emit) {
  const freshCapability = { model: true, reasoning: true, taskModes: ['direct'] };
  await emit({ type: 'host.initialize', panelId: 'roles', role: 'main', title: 'Main', model: 'gpt-5.6-sol', reasoning: 'medium', agentFastModes: {main:{'gpt-5.6-sol':true,'gpt-6-astra':false},work:{'gpt-5.6-sol':false},workLight:{'gpt-5.6-sol':false},verification:{'gpt-5.6-sol':true}}, agentSettingsScope: 'chat', agentSettingsSet: 'Default', resetConversation: true, runtimeAvailable: true, capabilities: { submit: freshCapability, send: freshCapability } });
  await page.locator('#model-button').click();
  await page.locator('#agent-default-scope').selectOption('chat');
  await emit({ type: 'models.list', models: ['gpt-5.6-sol', 'gpt-6-astra', 'claude-opus-5-5', 'antigravity/claude-sonnet-4-6', 'gemini-3.8-flash', 'antigravity/gpt-oss-120b-medium'] });
  const row = page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  const model = row.locator('button[data-field="model"]');
  await model.click();
  const popupBox = await row.locator('.model-picker-popup').boundingBox();
  const modelBox = await model.boundingBox();
  const menuBox = await page.locator('#model-menu').boundingBox();
  assert.ok(popupBox.y + popupBox.height <= modelBox.y - 3, JSON.stringify({popupBox, modelBox}));
  assert.ok(popupBox.y < menuBox.y, 'The upward fixed picker escapes the settings panel overflow layer');
  assert.ok(popupBox.y >= 0 && popupBox.x >= 0, JSON.stringify(popupBox));
  const tabs = row.locator('.model-vendor-tab');
  const visible = () => row.locator('.model-picker-option').evaluateAll(options => options.map(option => option.dataset.value));
  assert.deepEqual(await tabs.allTextContents(), ['OpenAI', 'Anthropic', 'Google']);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await visible(), ['gpt-5.6-sol', 'gpt-6-astra', 'antigravity/gpt-oss-120b-medium']);
  assert.equal(await row.locator('button[data-field="fast"]').count(), 1, 'Codex rows expose Fast');
  assert.equal(await model.getAttribute('aria-expanded'), 'true');
  assert.match(await row.locator('.model-picker-popup').textContent(), /OpenAI/);
  await tabs.nth(1).click();
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await visible(), ['claude-opus-5-5', 'antigravity/claude-sonnet-4-6']);
  assert.equal(await row.locator('.model-picker-option[data-value="antigravity/claude-sonnet-4-6"]').textContent(), 'claude-sonnet-4-6 · Antigravity');
  await row.locator('.model-picker-option[data-value="antigravity/claude-sonnet-4-6"]').click();
  assert.equal(await row.locator('button[data-field="fast"]').count(), 0, 'Non-Codex rows omit Fast');
  assert.equal(await row.locator('input[data-field="reasoningEffort"]').inputValue(), '2', 'Changing provider preserves reasoning');
  await model.click();
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', 'The selected model reopens on its vendor tab');
  await tabs.nth(1).press('ArrowRight');
  assert.deepEqual(await visible(), ['gemini-3.8-flash']);
  assert.equal(await tabs.nth(2).evaluate(element => element === document.activeElement), true, 'Arrow keys move between provider tabs');
  await page.keyboard.press('Escape');
  assert.equal(await model.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Route check');
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1).execution.model), 'antigravity/claude-sonnet-4-6');
  const capability = { model: true, reasoning: true, taskModes: ['direct'] };
  await emit({ type: 'session.bound', agentId: 'main-roles' });
  await emit({ type: 'capabilities.updated', capabilities: { submit: capability, send: { ...capability, sessionProvider: 'antigravity' } } });
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  await model.click();
  const disabled = {};
  for (const index of [0, 1, 2]) {
    if (!await tabs.nth(index).isDisabled()) await tabs.nth(index).click();
    Object.assign(disabled, await row.locator('.model-picker-option').evaluateAll(options => Object.fromEntries(options.map(option => [option.dataset.value, option.disabled]))));
  }
  assert.deepEqual(disabled, { 'gpt-5.6-sol': true, 'gpt-6-astra': true, 'antigravity/gpt-oss-120b-medium': false, 'claude-opus-5-5': true,
    'antigravity/claude-sonnet-4-6': false, 'gemini-3.8-flash': false });
  await page.keyboard.press('Escape');
  await emit({ type: 'host.initialize', panelId: 'role-fast-support', role: 'main', title: 'Main', model: 'claude-opus-5-5', reasoning: 'medium',
    agentModels: {work: {model: 'gpt-5.6-sol', reasoningEffort: 'medium', fast: true}, workLight: {model: 'claude-opus-5-5', reasoningEffort: 'low'}, verification: {model: 'gpt-6-astra', reasoningEffort: 'high', fast: false}},
    agentFastModes: {main:{'gpt-5.6-sol':true,'gpt-6-astra':false},work:{'gpt-5.6-sol':false},workLight:{'gpt-5.6-sol':false},verification:{'gpt-5.6-sol':true}}, resetConversation: true, runtimeAvailable: true,
    capabilities: { submit: {...freshCapability, fast: false}, send: {...freshCapability, fast: false} } });
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  assert.equal(await page.locator('.agent-model-row[data-agent-role=main] button[data-field=fast]').count(), 0, 'Claude Main omits Fast');
  assert.equal(await page.locator('.agent-model-row[data-agent-role=work] button[data-field=fast]').count(), 1, 'Codex Work keeps its own Fast control');
  assert.equal(await page.locator('.agent-model-row[data-agent-role=workLight] button[data-field=fast]').count(), 0, 'Claude light Work omits Fast');
  assert.equal(await page.locator('.agent-model-row[data-agent-role=verification] button[data-field=fast]').count(), 1, 'Codex Verification keeps its own Fast control');
  await page.setViewportSize({width:795,height:900});
  const measuredHeights = async () => page.locator('#model-menu .agent-model-row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  const mixedHeights = await measuredHeights();
  assert.equal(new Set(mixedHeights.map(value => value.toFixed(2))).size, 1, 'Rows with and without Fast have the same measured height');
  const workFast = page.locator('.agent-model-row[data-agent-role=work] button[data-field=fast]');
  await workFast.click();
  const toggledHeights = await measuredHeights();
  assert.deepEqual(toggledHeights.map(value => value.toFixed(2)), mixedHeights.map(value => value.toFixed(2)), 'Fast On/Off does not change row height');
  await page.keyboard.press('Escape');
  await emit({ type: 'host.initialize', panelId: 'fast-models', role: 'main', title: 'Main', model: 'gpt-5.6-sol', reasoning: 'medium',
    agentModels: {work: {model: 'gpt-5.6-sol', reasoningEffort: 'medium', fast: false}, workLight: {model: 'gpt-5.6-sol', reasoningEffort: 'low', fast: false}, verification: {model: 'gpt-5.6-sol', reasoningEffort: 'high', fast: false}},
    agentFastModes: {main:{'gpt-5.6-sol':true,'gpt-6-astra':false},work:{'gpt-5.6-sol':false,'gpt-6-astra':true},workLight:{'gpt-5.6-sol':false},verification:{'gpt-5.6-sol':true}}, resetConversation: true, runtimeAvailable: true, capabilities: { submit: {...freshCapability, fast: true}, send: {...freshCapability, fast: true} } });
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  const fast = row.locator('button[data-field=fast]');
  assert.equal(await fast.getAttribute('aria-pressed'), 'true');
  await chooseModel(row, 'gpt-6-astra');
  assert.equal(await fast.getAttribute('aria-pressed'), 'false', 'Switching models restores that model\'s Fast value');
  await chooseModel(row, 'gpt-5.6-sol');
  assert.equal(await fast.getAttribute('aria-pressed'), 'true', 'Returning to a model restores its independent Fast value');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Model Fast request');
  await page.locator('#prompt').press('Enter');
  const request = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1));
  assert.equal(request.execution.fast, true);
  assert.equal(request.execution.agentModels.work.fast, false, 'Work keeps its own Fast value for the same model');
  assert.equal(request.execution.agentModels.workLight.fast, false, 'Light Work keeps its own Fast value for the same model');
  assert.equal(request.execution.agentModels.verification.fast, true, 'Verification keeps its own Fast value for the same model');
  await page.locator('#model-button').click();
  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = process.env.AF_MODEL_SETTINGS_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/model-settings-copy-20261004');
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    assert.equal(await page.locator('#model-menu').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const scrollBeforePicker = await page.locator('#model-menu').evaluate(el => el.scrollHeight);
    await model.click();
    assert.equal(await page.locator('#model-menu').evaluate(el => el.scrollHeight), scrollBeforePicker, 'Opening the fixed picker must not enlarge the settings scroll area');
    const fit = await row.locator('.model-vendor-tab').evaluateAll(tabs => tabs.map(tab => [tab.textContent, tab.scrollWidth, tab.clientWidth, tab.parentElement.clientWidth]));
    assert.ok(fit.every(([, scroll, client]) => scroll <= client + 1), JSON.stringify([width, fit]));
    await page.screenshot({ path: path.join(artifactDir, 'vendor-tabs-' + width + '.png') });
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Escape');
}

async function checkReasoningSlider(page) {
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, taskModes: ['direct', 'work', 'work-verification'] };
  await emit({ type: 'host.initialize', panelId: 'reasoning-slider', role: 'main', title: 'Main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {}, projectAvailable: true } });
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'chat');
  await page.locator('#agent-default-scope').selectOption('chat');

  const chatReasoning = page.locator('#model-menu input[data-role=main][data-field=reasoningEffort]');
  await chatReasoning.fill('2');
  const dragBox = await chatReasoning.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width * 0.4, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width - 1, dragBox.y + dragBox.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.saved.reasoning), 'max');
  assert.equal(await page.locator('#model-menu').isVisible(), true, 'Dragging the reasoning slider must keep its settings panel open');

  await page.locator('#agent-default-scope').selectOption('project');
  const projectReasoning = page.locator('#agent-default-fields input[data-role=main][data-field=reasoningEffort]');
  const savesBeforeInput = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').length);
  await projectReasoning.evaluate(element => {
    element.value = '4';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await projectReasoning.getAttribute('aria-valuetext'), 'xhigh');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').length), savesBeforeInput, 'Dragging must not save and re-render the slider mid-gesture');
  await projectReasoning.evaluate(element => element.dispatchEvent(new Event('change', { bubbles: true })));
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'agent.defaults.save').at(-1)), { type: 'agent.defaults.save', scope: 'project', role: 'main', field: 'reasoningEffort', value: 'xhigh' });
}

module.exports = { checkFastSetting, checkAgentModels, checkReasoningSlider };
