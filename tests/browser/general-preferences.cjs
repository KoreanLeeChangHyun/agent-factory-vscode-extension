const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkGeneralPreferences(page) {
  const settings = { startup: 'restore', notifyCompleted: true, notifyFailed: true, notifyDecision: true, notifyBackgroundOnly: true, notifySound: false };
  const emit = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await emit({ type: 'general.updated', settings });
  await page.locator('#status-settings-button').click();
  await page.locator('#ui-language').selectOption('ko');
  assert.equal(await page.locator('#general-startup').inputValue(), 'restore');
  await page.locator('#general-startup').selectOption('new');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'general.set').at(-1)), { type: 'general.set', key: 'startup', value: 'new' });
  for (const key of ['notifyCompleted', 'notifyFailed', 'notifyDecision', 'notifyBackgroundOnly', 'notifySound']) {
    const control = page.locator(`[data-general-setting="${key}"]`);
    assert.equal(await control.isChecked(), settings[key]);
    await control.focus(); await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'general.set').at(-1)), { type: 'general.set', key, value: !settings[key] });
  }
  await emit({ type: 'general.updated', settings, error: 'Save failed' });
  assert.equal(await page.locator('#general-startup').inputValue(), 'restore');
  assert.equal(await page.locator('[data-general-setting="notifySound"]').isChecked(), false);
  assert.equal(await page.locator('#general-settings-status').textContent(), 'Save failed');
  await emit({ type: 'general.updated', settings });
  assert.equal(await page.locator('#general-settings-status').isVisible(), false);
  assert.match(await page.locator('#docs-audit-description').textContent(), /읽기 전용/);
  const artifact = process.env.AF_RENDERING_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/general-settings');
  fs.mkdirSync(artifact, { recursive: true });
  for (const size of [{ width: 595, height: 637 }, { width: 360, height: 640 }, { width: 721, height: 402 }]) {
    await page.setViewportSize(size);
    const panel = page.locator('#settings-panel-general');
    assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const first = await page.locator('#ui-language').boundingBox();
    const startup = await page.locator('#general-startup').boundingBox();
    const permissions = await page.locator('[data-setting="permissions"]').boundingBox();
    assert.ok(first.y < startup.y && startup.y < permissions.y);
    assert.ok(Math.abs(first.x - startup.x) < 1 && Math.abs(first.x - permissions.x) < 1);
    const sound = page.locator('[data-general-setting="notifySound"]');
    await sound.focus();
    assert.equal(await sound.evaluate(el => el === document.activeElement), true);
    await panel.evaluate(el => { el.scrollTop = 0; });
    await page.locator('#status-settings').screenshot({ path: path.join(artifact, `general-${size.width}x${size.height}.png`) });
  }
  await page.locator('#ui-language').selectOption('en');
  assert.equal(await page.locator('.general-notifications legend').textContent(), 'Notifications');
  await page.reload();
  await emit({ type: 'host.initialize', panelId: 'general-restored', role: 'main', runtimeAvailable: false, generalSettings: { ...settings, startup: 'new', notifyFailed: false } });
  await page.locator('#status-settings-button').click();
  assert.equal(await page.locator('#general-startup').inputValue(), 'new');
  assert.equal(await page.locator('[data-general-setting="notifyFailed"]').isChecked(), false);
}
module.exports = { checkGeneralPreferences };
