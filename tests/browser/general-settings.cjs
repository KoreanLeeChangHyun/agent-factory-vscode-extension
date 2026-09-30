const assert = require('node:assert/strict');

async function checkGeneralSettings(page) {
  // Scope follows its inheritance order and opens on the project default.
  assert.deepEqual(await page.locator('#agent-default-scope option').evaluateAll(options => options.map(option => option.value)), ['global', 'project', 'chat']);
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'project');
  await page.evaluate(() => window.postMessage({ type: 'agent.defaults', settings: { global: {}, effective: {}, sources: {}, projectAvailable: false } }, '*'));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'global');
  assert.equal(await page.locator('#agent-default-scope option[value="project"]').evaluate(option => option.disabled), true);
  await page.locator('#status-settings-button').click();
  assert.equal(await page.locator('#status-settings [data-settings-tab="agents"]').count(), 0);
  assert.equal(await page.locator('#settings-panel-general').isVisible(), true);
  const language = page.locator('#ui-language');
  // Compare command bodies, excluding the localized Ran/Running prefix.
  assert.ok(await page.locator('.bash-command-text > .syntax-code').count() > 0);
  const sourceText = () => page.locator('.message-user, .message-assistant .markdown-body, .bash-command-text > .syntax-code, .terminal-command-output, .git-diff-source').allTextContents();
  const originalConversation = await sourceText();
  await page.locator('#prompt').fill('Settings 원문 유지');
  await language.selectOption('ko');
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  assert.equal(await page.locator('#settings-tab-general').textContent(), '일반');
  assert.equal(await page.locator('#settings-tab-status').textContent(), '상태바');
  assert.equal(await page.locator('#general-permissions .agent-permissions-heading strong').textContent(), '실행 권한');
  await page.locator('[data-setting="permissions"]').selectOption('workspace-write');
  assert.match(await page.locator('#agent-permissions-description').textContent(), /작업 공간/);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'execution.select').at(-1).mode), 'workspace-write');
  const height = (await page.locator('#status-settings').boundingBox()).height;
  for (const tab of ['status', 'bot', 'keyboard', 'general']) {
    await page.locator('#settings-tab-' + tab).click();
    assert.equal((await page.locator('#status-settings').boundingBox()).height, height);
  }
  assert.deepEqual(await sourceText(), originalConversation);
  assert.equal(await page.locator('#prompt').inputValue(), 'Settings 원문 유지');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  await page.locator('#status-settings-button').click();
  assert.equal(await language.inputValue(), 'ko');
  await language.selectOption('en');
  assert.equal(await page.locator('#settings-tab-general').textContent(), 'General');
  await page.evaluate(() => { document.documentElement.dataset.hostLanguage = 'ko-KR'; });
  await language.selectOption('auto');
  assert.equal(await page.locator('#settings-tab-general').textContent(), '일반');
  await page.evaluate(() => { document.documentElement.dataset.hostLanguage = 'en'; });
  await language.selectOption('en');
  await language.selectOption('auto');
  assert.equal(await page.locator('#settings-tab-general').textContent(), 'General');
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 640 });
    assert.equal(await page.locator('#status-settings').evaluate(e => e.scrollWidth > e.clientWidth), false);
    assert.equal(await page.locator('#settings-panel-general').evaluate(e => e.scrollWidth > e.clientWidth), false);
    const permissionBox = await page.locator('#general-permissions select').boundingBox();
    const languageBox = await language.boundingBox();
    assert.ok(Math.abs(permissionBox.x - languageBox.x) < 1);
    assert.ok(Math.abs(permissionBox.width - languageBox.width) < 1);
  }
  await page.locator('#status-settings-close').click();
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu [data-setting="permissions"]').count(), 0);
}
module.exports = { checkGeneralSettings };
