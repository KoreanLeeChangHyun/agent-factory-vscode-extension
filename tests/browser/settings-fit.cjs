const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkSettingsFit(page) {
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await page.locator('#status-settings-button').click();
  await page.locator('#ui-language').selectOption('ko');
  const roles = ['main', 'work', 'workLight', 'explore', 'scribe', 'verification'];
  const agentSettings = Object.fromEntries(roles.map(role => [role, { model: 'gpt-6-astra', reasoningEffort: 'medium', fastMode: true }]));
  await emit({ type: 'models.list', models: ['gpt-6-astra'] });
  await emit({ type: 'agent.defaults', settings: { global: {}, project: {}, projectAvailable: true, defaultSetId: 'codex', presets: [{ id: 'codex', scope: 'global', name: 'Codex', builtIn: true, isDefault: true, settings: agentSettings }] } });
  await emit({ type: 'providers.status', busy: false, versions: { codex: { cli: '0.159.2', plugin: '1.0.26', pluginCurrent: true }, claude: { cli: '2.1.285', plugin: '1.0.26', pluginCurrent: true } }, providers: [
    { id: 'codex', detected: true, path: '/home/user/.local/bin/codex', source: 'path' },
    { id: 'claude', detected: true, path: '/opt/claude/bin/claude', source: 'path' },
    { id: 'antigravity', detected: true, path: '/opt/antigravity/bin/agy', source: 'path' }
  ] });
  await emit({ type: 'providers.catalog', catalog: { factory: ['1.0.26'], cli: { codex: ['0.159.2'], claude: ['2.1.285'] }, errors: {} } });
  const now = Date.UTC(2026, 9, 5, 18, 9);
  await emit({ type: 'usage.accounts', accounts: Object.fromEntries(['codex', 'claude', 'antigravity-gemini', 'antigravity-claude-gpt'].map((id, index) => [id, {
    reportedAt: now, weeklyUsedPercent: 61 - index * 10, weeklyResetsAt: (now + 86400000) / 1000,
    ...(index ? { fiveHourUsedPercent: 10, fiveHourResetsAt: (now + 3600000) / 1000 } : {})
  }])) });
  const artifactDir = process.env.AF_RENDERING_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/settings-fit');
  fs.mkdirSync(artifactDir, { recursive: true });
  const measurements = [];
  for (const size of [{ width: 572, height: 550 }, { width: 465, height: 556 }, { width: 721, height: 402 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size);
    for (const tab of ['general', 'agents', 'providers', 'usage', 'bot', 'status', 'keyboard']) {
      await page.locator('#settings-tab-' + tab).click();
      if (tab === 'agents') assert.equal(await page.locator('#global-agent-settings [data-field="model"]').first().textContent(), 'gpt-6-astra');
      if (tab === 'providers') await emit({ type: 'providers.catalog', catalog: { factory: ['1.0.26'], cli: { codex: ['0.159.2'], claude: ['2.1.285'] }, errors: {} } });
      const panel = page.locator('#settings-panel-' + tab);
      const metrics = await panel.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight, width: node.clientWidth, contentWidth: node.scrollWidth,
        clippedControls: [...node.querySelectorAll('button,input,select,textarea')].filter(el => el.getClientRects().length && !el.closest('details:not([open])')).filter(el => {
          const box = el.getBoundingClientRect(), bounds = node.getBoundingClientRect();
          return box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1 || box.left < bounds.left - 1 || box.right > bounds.right + 1;
        }).map(el => el.id || el.className) }));
      measurements.push({ viewport: size, tab, ...metrics });
      if (!['status', 'keyboard'].includes(tab)) {
        await page.locator('#status-settings').screenshot({ path: path.join(artifactDir, `${tab}-${size.width}x${size.height}.png`) });
      }
    }
  }
  fs.writeFileSync(path.join(artifactDir, 'measurements.json'), JSON.stringify(measurements, null, 2));
  if (!process.env.AF_SETTINGS_MEASURE_ONLY) {
    for (const item of measurements.filter(item => !['status', 'keyboard'].includes(item.tab))) {
      assert.ok(item.content <= item.height + 1, JSON.stringify(item));
      assert.ok(item.contentWidth <= item.width + 1, JSON.stringify(item));
      assert.deepEqual(item.clippedControls, [], JSON.stringify(item));
    }
  }
}
module.exports = { checkSettingsFit };
