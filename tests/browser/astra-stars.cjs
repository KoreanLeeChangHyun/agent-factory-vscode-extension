const assert = require('node:assert/strict');

// The composer has no decorative starfield for any model; selecting an Astra model changes only the model label.
async function checkAstraStars(page) {
  const emit = async value => {
    await page.evaluate(value => window.postMessage(value, '*'), value);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const capability = { model: true, reasoning: true, fast: true };
  await emit({ type: 'host.initialize', panelId: 'star-preview', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['gpt-6-astra', 'gpt-5.6-sol'] });
  await page.locator('#model-button').click();
  const mainRow = page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  await mainRow.locator('button[data-field="model"]').click();
  await mainRow.locator('.model-picker-option[data-value="gpt-6-astra"]').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('model-label').textContent.startsWith('gpt-6-astra'));
  assert.equal(await page.locator('.astra-stars, .astra-star').count(), 0, 'No starfield markup');
  assert.equal(await page.locator('.prompt-surface').evaluate(node => node.classList.contains('is-astra')), false);
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const surfaces = await page.locator('.composer, .prompt-surface').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundImage));
    assert.deepEqual(surfaces, ['none', 'none'], 'Composer surfaces carry no decorative background at ' + width);
    assert.equal(await page.locator('.composer').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Composer controls stay inside the composer at ' + width);
  }
  await page.setViewportSize({ width: 795, height: 740 });
  await page.locator('#prompt').click();
  await page.keyboard.type('A clear space for your next idea.');
  assert.equal(await page.locator('#prompt').inputValue(), 'A clear space for your next idea.');
  await page.locator('#prompt').fill('');
}
module.exports = { checkAstraStars };
