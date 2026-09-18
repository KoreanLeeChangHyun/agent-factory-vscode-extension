const assert = require('node:assert/strict');
async function checkAgentModels(page) {
  const emit = async value => { await page.evaluate(value => window.postMessage(value, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, reasoning: true, taskModes: ['direct', 'work', 'work-verification'] };
  await emit({ type: 'host.initialize', panelId: 'roles', role: 'main', title: 'Main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['main-model', 'work-model', 'verify-model'] });
  assert.equal(await page.locator('#reasoning-button').isVisible(), false);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu select[data-role]').count(), 6);
  for (const height of [900, 600]) {
    await page.setViewportSize({ width: 795, height });
    const layout = await page.locator('#model-menu').evaluate(element => ({
      scroll: element.scrollHeight, client: element.clientHeight,
      top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom
    }));
    assert.ok(layout.client > 0 && layout.scroll >= layout.client);
    assert.ok(layout.top >= 0 && layout.bottom <= height);
  }
  await page.locator('#model-menu select[data-role="work"][data-field="model"]').focus();
  const focus = await page.locator('#model-menu select[data-role="work"][data-field="model"]').evaluate(element => {
    const style = getComputedStyle(element);
    return { outline: style.outlineColor, border: style.borderTopColor };
  });
  assert.equal(focus.outline, 'rgb(0, 128, 232)');
  assert.equal(focus.border, 'rgb(0, 128, 232)');
  for (const [role, model, effort] of [['main', 'main-model', 'low'], ['work', 'work-model', 'high'], ['verification', 'verify-model', 'medium']]) {
    await page.locator(`#model-menu select[data-role="${role}"][data-field="model"]`).selectOption(model);
    await page.locator(`#model-menu select[data-role="${role}"][data-field="reasoningEffort"]`).selectOption(effort);
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
}
module.exports = { checkAgentModels };
