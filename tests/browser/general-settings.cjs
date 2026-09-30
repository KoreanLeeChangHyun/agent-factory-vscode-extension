const assert = require('node:assert/strict');

async function checkGeneralSettings(page) {
  // Scope follows the copy flow and opens on the project default.
  assert.deepEqual(await page.locator('#agent-default-scope option').evaluateAll(options => options.map(option => option.value)), ['global', 'project', 'chat']);
  assert.equal(await page.locator('#agent-default-scope').inputValue(), 'project');
  await page.evaluate(() => window.postMessage({ type: 'agent.defaults', settings: { global: {}, project: {}, projectAvailable: false } }, '*'));
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
  assert.equal(await page.locator('#settings-tab-providers').textContent(), '공급자');
  assert.equal(await page.locator('#settings-tab-status').textContent(), '상태바');
  assert.equal(await page.locator('#general-permissions .agent-permissions-heading strong').textContent(), '실행 권한');
  await page.locator('[data-setting="permissions"]').selectOption('workspace-write');
  assert.match(await page.locator('#agent-permissions-description').textContent(), /작업 공간/);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'execution.select').at(-1).mode), 'workspace-write');
  const height = (await page.locator('#status-settings').boundingBox()).height;
  for (const tab of ['status', 'bot', 'keyboard', 'providers', 'general']) {
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
  await page.locator('#settings-tab-providers').click();
  assert.equal(await page.locator('#settings-panel-providers').isVisible(), true);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'providers.versions.request').length), 1);
  await page.evaluate(() => window.postMessage({ type: 'providers.status', busy: false, errors: { claude: 'marketplace offline' }, versions: { codex: { cli: '0.159.2', plugin: '1.0.21', pluginCurrent: true }, claude: { cli: '2.1.285', plugin: '1.0.20', pluginCurrent: false } }, providers: [
    { id: 'codex', detected: true, path: '/home/user/.local/bin/codex', source: 'path', configuredPath: 'C:/stale/codex.exe', configuredInvalid: true },
    { id: 'claude', detected: true, path: '/opt/claude/bin/claude', source: 'configured', configuredPath: '/opt/claude/bin/claude', configuredInvalid: false },
    { id: 'antigravity', detected: false, configuredPath: '/missing/agy', configuredInvalid: true }
  ] }, '*'));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(await page.locator('#provider-settings .provider-name').allTextContents(), ['Codex', 'Claude Code', 'Antigravity']);
  assert.deepEqual(await page.locator('#provider-settings .provider-row:visible .provider-name').allTextContents(), ['Codex', 'Claude Code']);
  assert.deepEqual(await page.locator('#provider-settings .provider-state').allTextContents(), ['Detected · Auto', 'Detected · Manual']);
  assert.equal(await page.locator('[data-provider-control="codex:input"]').inputValue(), '/home/user/.local/bin/codex');
  assert.equal(await page.locator('[data-provider-control="codex:clear"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#provider-settings .provider-row:visible .provider-error').count(), 1);
  assert.doesNotMatch(await page.locator('#provider-settings .provider-row:visible').allTextContents().then(texts => texts.join('\n')), /saved path cannot be executed|stale\/codex/);
  assert.equal(await page.locator('[data-provider-control="claude:input"]').inputValue(), '/opt/claude/bin/claude');
  assert.deepEqual(await page.locator('#provider-settings .provider-version').allTextContents(), ['CLI 0.159.2 · Plugin 1.0.21', 'CLI 2.1.285 · Plugin 1.0.20']);
  assert.deepEqual(await page.locator('#provider-settings .provider-update-state').allTextContents(), ['Up to date', 'Update required']);
  assert.match(await page.locator('#provider-settings .provider-error').allTextContents().then(texts => texts.join('\n')), /marketplace offline[\s\S]*saved path cannot be executed|saved path cannot be executed[\s\S]*marketplace offline/);
  assert.equal(await page.locator('[data-provider-control="antigravity:input"]').inputValue(), '/missing/agy');
  assert.equal(await page.locator('#provider-settings .provider-error').allTextContents().then(texts => texts.join('\n')).then(text => text.includes('/missing/agy')), false);
  assert.equal(await page.locator('#provider-settings [data-provider-control="update-mode"]').count(), 0);
  assert.equal(await page.locator('#provider-settings [data-provider-control="detect"]').count(), 0);
  assert.equal(await page.locator('#provider-settings [data-provider-control="update-now"]').count(), 1);
  await page.locator('[data-provider-control="update-now"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'providers.update' });
  assert.equal(await page.locator('.provider-version-install').count(), 0);
  assert.equal(await page.locator('[data-provider-control="antigravity:install-version-input"]').count(), 0);
  const versionInput = page.locator('[data-provider-control="codex:install-version-input"]');
  const versionInstall = page.locator('[data-provider-control="codex:install-version"]');
  const claudeVersionInput = page.locator('[data-provider-control="claude:install-version-input"]');
  assert.equal(await versionInput.getAttribute('aria-label'), 'Agent Factory plugin version for Codex');
  assert.equal(await versionInstall.isDisabled(), true);
  await versionInput.fill('1.0.20');
  assert.equal(await versionInstall.isDisabled(), false);
  assert.equal(await claudeVersionInput.inputValue(), '');
  await versionInstall.click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'providers.update', provider: 'codex', version: '1.0.20' });
  await claudeVersionInput.fill('1.0.19');
  await page.locator('[data-provider-control="claude:install-version"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'providers.update', provider: 'claude', version: '1.0.19' });
  await page.locator('.provider-missing summary').click();
  assert.equal(await page.locator('[data-provider-control="antigravity:input"]').isVisible(), true);
  await page.locator('[data-provider-control="antigravity:pick"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'providers.pick', provider: 'antigravity' });
  const agyInput = page.locator('[data-provider-control="antigravity:input"]');
  assert.equal(await agyInput.inputValue(), '/missing/agy');
  await agyInput.fill('/opt/agy/bin/agy');
  await agyInput.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'providers.configure').at(-1)),
    { type: 'providers.configure', provider: 'antigravity', path: '/opt/agy/bin/agy' });
  await page.locator('[data-provider-control="claude:clear"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'providers.configure').at(-1)),
    { type: 'providers.configure', provider: 'claude', path: '' });
  await page.locator('#settings-tab-general').click();
  for (const width of [360, 568, 795]) {
    await page.setViewportSize({ width, height: 640 });
    assert.equal(await page.locator('#status-settings').evaluate(e => e.scrollWidth > e.clientWidth), false);
    assert.equal(await page.locator('#settings-panel-general').evaluate(e => e.scrollWidth > e.clientWidth), false);
    const permissionBox = await page.locator('#general-permissions select').boundingBox();
    const languageBox = await language.boundingBox();
    assert.ok(Math.abs(permissionBox.x - languageBox.x) < 1);
    assert.ok(Math.abs(permissionBox.width - languageBox.width) < 1);
    await page.locator('#settings-tab-providers').click();
    assert.equal(await page.locator('#settings-panel-providers').evaluate(e => e.scrollWidth > e.clientWidth), false);
    const pathBox = await page.locator('[data-provider-control="codex:input"]').boundingBox();
    const pickBox = await page.locator('[data-provider-control="codex:pick"]').boundingBox();
    const autoBox = await page.locator('[data-provider-control="codex:clear"]').boundingBox();
    assert.ok(pathBox && pickBox && autoBox);
    assert.ok(Math.abs(pathBox.y - pickBox.y) < 2 && Math.abs(pathBox.y - autoBox.y) < 2);
    await page.locator('#settings-tab-general').click();
  }
  await page.locator('#status-settings-close').click();
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu [data-setting="permissions"]').count(), 0);
}
module.exports = { checkGeneralSettings };
