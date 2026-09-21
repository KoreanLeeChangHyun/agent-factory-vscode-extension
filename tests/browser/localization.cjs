const assert = require('node:assert/strict');

async function checkLocalization(page) {
  const emit = async value => {
    await page.evaluate(value => {
      window.dispatchEvent(new MessageEvent('message', { data: value }));
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, value);
  };
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work', 'plan', 'verification', 'plan-work', 'work-verification', 'plan-work-verification'] };
  const initialize = { type: 'host.initialize', panelId: 'localized', title: 'Default', projectName: 'Work', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability }, executionMode: 'danger-full-access', statusItems: ['status', 'project', 'runtime', 'model', 'reasoning', 'fast', 'queue', 'context', 'weekly', 'execution'] };
  await emit(initialize);
  await emit({ type: 'models.list', models: ['Default', 'gpt-6-astra', 'main-model'] });
  await emit({ type: 'context.usage', usedTokens: 250, contextWindowTokens: 1000, weeklyUsedPercent: 25 });
  await page.locator('#status-settings-button').click();
  const language = page.locator('#ui-language');
  const select = async value => {
    if (!await page.locator('#status-settings').isVisible()) await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-general').click();
    await language.selectOption(value);
  };
  await select('ko');
  assert.equal(await page.locator('#status-settings #conversation-clear-button').count(), 0);
  assert.equal(await page.locator('.composer-actions #conversation-clear-button').getAttribute('aria-label'), '대화 초기화');
  assert.match(await page.locator('#status-bar').innerText(), /런타임 온라인/);
  assert.match(await page.locator('#status-bar').innerText(), /모델 기본값/);
  assert.match(await page.locator('#status-bar').innerText(), /추론 기본값/);
  assert.match(await page.locator('#status-bar').innerText(), /컨텍스트 잔여/);
  assert.equal(await page.locator('#status-bar [data-item-id="project"]').textContent(), 'Work');
  await page.locator('#settings-tab-status').click();
  assert.match(await page.locator('.status-preview[data-preview-id="runtime"]').textContent(), /런타임 온라인/);
  assert.match(await page.locator('#status-bar [data-item-id="runtime"]').getAttribute('aria-label'), /이동/);
  await page.locator('#status-settings-close').click();
  await emit({ type: 'run.activity', id: 'web-search-card', category: 'tool', phase: 'started', title: '웹 검색', text: 'Agent Factory search query' });
  const webSearch = page.locator('.message-activity-tool').filter({ hasText: 'Agent Factory search query' });
  assert.equal(await webSearch.count(), 1);
  assert.match(await webSearch.innerText(), /웹 검색/);
  await emit({ type: 'run.activity', id: 'web-search-card', category: 'tool', phase: 'completed', title: '웹 검색', text: 'Agent Factory search query' });
  assert.equal(await webSearch.count(), 1);
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu select[data-role="main"] option[value=""]').textContent(), '기본값');
  assert.equal(await page.locator('#model-menu select[data-role="main"] option[value="Default"]').textContent(), 'Default');
  await page.locator('#model-menu select[data-role="main"]').selectOption('gpt-6-astra');
  assert.match(await page.locator('#model-menu input[data-role="main"]').getAttribute('aria-label'), /메인 추론/);
  await page.locator('#model-menu .agent-settings-close').click();
  await page.locator('#prompt').fill('Default Settings 원문 {0}');
  await emit({ type: 'chat.assistant', text: 'Settings Runtime online Default', phase: 'final', runId: 'source-run' });
  await emit({ type: 'decision.pending', runId: 'source-run' });
  assert.equal(await page.locator('.decision-actions').count(), 0);
  await emit({ type: 'decision.pending', runId: 'source-run', canApprove: false });
  assert.equal(await page.locator('.decision-actions').count(), 0);
  await emit({ type: 'decision.pending', runId: 'source-run', canApprove: true });
  const approve = page.locator('.decision-actions').getByRole('button', { name: '제안대로 진행', exact: true });
  assert.equal(await approve.count(), 1);
  assert.equal(await page.locator('.decision-actions button').count(), 1);
  assert.equal(await approve.isEnabled(), true);
  assert.equal(await approve.textContent(), '제안대로 진행');
  await approve.click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'decision.approve').at(-1)), { type: 'decision.approve', runId: 'source-run' });
  assert.match(await page.locator('#auto-scroll-button').getAttribute('title'), /자동 스크롤/);
  await emit({ type: 'attachments.add', attachments: [{ id: 'opaque', kind: 'file', name: 'Default.txt', uri: 'file:///tmp/Default.txt' }] });
  assert.equal(await page.locator('#attachment-list button').last().getAttribute('aria-label'), 'Default.txt · 첨부 제거');
  await emit({ type: 'run.progress', text: 'Starting Main Agent', localization: { text: { key: 'ui.starting.main.agent', values: [] } } });
  await emit({ type: 'host.notice', level: 'info', text: 'Started a new conversation. Historical run records were retained.', localization: { text: { key: 'ui.started.a.new.conversation.historical.run.records.were.retained', values: [] } } });
  assert.match(await page.locator('.message-notice').last().innerText(), /새 대화를 시작/);
  const original = await page.locator('.message-assistant').last().innerText();
  // The command wrapper also contains a localized execution-status prefix.
  const command = await page.locator('[data-id="short"] .bash-command-text > .syntax-code').textContent();
  const output = await page.locator('[data-id="short"] .terminal-command-output').first().textContent();
  await select('en');
  assert.equal(await page.locator('#prompt').inputValue(), 'Default Settings 원문 {0}');
  assert.match(await page.locator('.message-assistant').last().innerText(), /Settings Runtime online Default/);
  assert.match(original, /Settings Runtime online Default/);
  assert.equal(await page.locator('[data-id="short"] .bash-command-text > .syntax-code').textContent(), command);
  assert.equal(await page.locator('[data-id="short"] .terminal-command-output').first().textContent(), output);
  assert.match(await page.locator('.message-notice').last().innerText(), /Started a new conversation/);
  assert.match(await page.locator('#status-bar').innerText(), /gpt-6-astra/);
  await page.evaluate(() => { document.documentElement.dataset.hostLanguage = 'ko-KR'; });
  await select('auto');
  assert.equal(await page.locator('#settings-tab-general').textContent(), '일반');
  await select('ko');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  assert.match(await page.locator('.message-notice').last().innerText(), /새 대화를 시작/);
  assert.equal(await page.locator('#prompt').inputValue(), 'Default Settings 원문 {0}');
  await select('en');
  await page.evaluate(() => { document.documentElement.dataset.hostLanguage = 'fr'; });
  await select('auto');
  assert.equal(await page.locator('#settings-tab-general').textContent(), 'General');
}
module.exports = { checkLocalization };

async function checkGalleryLocalization(page) {
  const base = new URL(page.url()).origin;
  await page.goto(base + '/gallery?lang=ko');
  assert.equal(await page.locator('h1').textContent(), '로딩 애니메이션');
  assert.equal(await page.locator('#motion-toggle').textContent(), '일시 중지');
  await page.locator('#motion-toggle').click();
  assert.equal(await page.locator('#motion-toggle').textContent(), '재개');
  await page.locator('#motion-replay').click();
  assert.equal(await page.locator('#motion-toggle').textContent(), '일시 중지');
  assert.equal(await page.locator('.agent-count').first().textContent(), '작업 2 · 검증 1');
  await page.goto(base + '/gallery?lang=fr');
  assert.equal(await page.locator('h1').textContent(), 'Loading Animations');
  assert.equal(await page.locator('#motion-toggle').textContent(), 'Pause');
}
module.exports.checkGalleryLocalization = checkGalleryLocalization;
