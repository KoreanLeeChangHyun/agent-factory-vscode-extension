const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkHistoryControls(page) {
  const enforce = process.env.AF_HISTORY_CONTROLS_ASSERT !== '0';
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fixture = { agentId: 'history-ui-agent', conversationId: 'history-ui-conversation', autoScroll: false, botsEnabled: false, historyNextBefore: 'earlier-boundary', timeline: Array.from({ length: 401 }, (_, i) => ({ type: 'assistant', phase: 'final', id: 'history-ui-' + i, runId: 'history-run-' + i, text: 'Retained message ' + i })) };
  const themes = {
    dark: ['#d4d4d4', '#1e1e1e', '#252526', '#454545', '#3a3a3a', '#007acc', 'dark'],
    light: ['#333333', '#ffffff', '#f3f3f3', '#cccccc', '#e5e5e5', '#005fb8', 'light'],
    'high-contrast': ['#ffffff', '#000000', '#000000', '#ffffff', '#333333', '#ffff00', 'dark'],
    'high-contrast-light': ['#000000', '#ffffff', '#ffffff', '#000000', '#cccccc', '#0000ff', 'light']
  };
  const report = [];
  for (const [theme, colors] of Object.entries(themes)) {
    for (const width of [320, 795]) {
      await page.setViewportSize({ width, height: 740 });
      await page.evaluate(value => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(value)), fixture);
      await page.goto(new URL('/?lang=ko', page.url()).href);
      await page.waitForSelector('[data-id="history-ui-400"]');
      await page.evaluate(({ theme, colors }) => {
        document.body.className = 'vscode-' + theme;
        const root = document.documentElement;
        ['foreground', 'editor-foreground', 'terminal-foreground'].forEach(name => root.style.setProperty('--vscode-' + name, colors[0]));
        ['editor-background', 'terminal-background'].forEach(name => root.style.setProperty('--vscode-' + name, colors[1]));
        root.style.setProperty('--vscode-editorWidget-background', colors[2]);
        root.style.setProperty('--vscode-panel-border', colors[3]);
        root.style.setProperty('--vscode-toolbar-hoverBackground', colors[4]);
        root.style.setProperty('--vscode-focusBorder', colors[5]);
        root.style.colorScheme = colors[6];
      }, { theme, colors });
      await settle();
      const previous = page.locator('.history-pages button').first();
      const next = page.locator('.history-pages button').last();
      const older = page.locator('.history-older');
      assert.equal(await previous.textContent(), '이전 메시지');
      assert.equal(await next.textContent(), '다음 메시지');
      assert.equal(await older.textContent(), '이전 대화 불러오기');
      assert.equal(await next.isDisabled(), true);
      await page.mouse.move(width - 2, 738);
      const measured = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('.history-pages button, .history-older')];
        return buttons.map(button => {
          const style = getComputedStyle(button), box = button.getBoundingClientRect();
          return { text: button.textContent, width: box.width, height: box.height, x: box.x, right: box.right, background: style.backgroundColor, color: style.color, borderRadius: style.borderRadius, opacity: style.opacity };
        });
      });
      if (enforce) {
        for (const [i, button] of measured.entries()) {
          assert.ok(button.height >= 28 && button.height <= 36);
          assert.ok(button.width < 240, 'History controls fit their content instead of stretching into a bar');
          assert.ok(button.x >= 0 && button.right <= width, 'Controls stay inside the narrow viewport');
          assert.ok(parseFloat(button.borderRadius) >= 6);
          assert.equal(button.background, rgb(colors[2]));
          assert.equal(button.color, rgb(colors[0]));
          if (i !== 1) assert.ok(contrast(button.color, button.background) >= 4.5);
        }
        assert.equal(measured[1].opacity, '0.5');
        await page.keyboard.press('Tab');
        await previous.focus();
        assert.equal(await previous.evaluate(button => getComputedStyle(button).outlineWidth), '2px');
        await previous.hover();
        assert.equal(await previous.evaluate(button => getComputedStyle(button).backgroundColor), rgb(colors[4]));
      }
      await page.mouse.move(width - 2, 738);
      await page.evaluate(() => document.activeElement.blur());
      const artifactDir = process.env.AF_HISTORY_CONTROLS_ARTIFACT_DIR;
      if (artifactDir && ['dark', 'light'].includes(theme) && (enforce || theme === 'dark' && width === 795)) {
        fs.mkdirSync(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, (enforce ? 'after' : 'before') + '-' + theme + '-' + width + '.png') });
      }
      await next.evaluate(button => button.click());
      assert.equal(await page.locator('#timeline .message').last().getAttribute('data-id'), 'history-ui-400', 'Disabled next does not navigate');
      await previous.click();
      await settle();
      assert.equal(await page.locator('#timeline .message').last().getAttribute('data-id'), 'history-ui-200');
      await previous.click();
      await settle();
      assert.equal(await previous.isDisabled(), true);
      assert.equal(await page.locator('#timeline .message').first().getAttribute('data-id'), 'history-ui-0', 'The earliest retained message remains reachable');
      await next.click();
      await next.click();
      await settle();
      assert.equal(await page.locator('#timeline .message').last().getAttribute('data-id'), 'history-ui-400');
      await older.click();
      assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'history.request').at(-1)), { type: 'history.request', before: 'earlier-boundary' });
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'conversation.history', agentId: 'history-ui-agent', history: { conversationId: 'history-ui-conversation', messages: [{ type: 'assistant', phase: 'final', id: 'history-ui-earlier', runId: 'history-run-earlier', text: 'Earlier provider content preserved' }] } } })));
      await page.waitForSelector('[data-id="history-ui-earlier"]');
      assert.equal(await older.isVisible(), false, 'Only an exhausted provider cursor hides the load control');
      await page.waitForFunction(() => window.saved.historyNextBefore === undefined);
      const retained = await page.evaluate(async () => {
        const seen = new Map();
        do {
          for (const node of document.querySelectorAll('#timeline .message')) seen.set(node.dataset.id, node.querySelector('.message-content').textContent.trim());
          const next = document.querySelector('.history-pages button:last-child');
          if (next.disabled) break;
          next.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        } while (true);
        return Object.fromEntries(seen);
      });
      assert.equal(Object.keys(retained).length, 402, 'Every retained and newly loaded message remains reachable');
      for (let i = 0; i < 401; i++) assert.equal(retained['history-ui-' + i], 'Retained message ' + i);
      assert.equal(retained['history-ui-earlier'], 'Earlier provider content preserved');
      report.push({ theme, width, buttons: measured, navigationAndLoading: 'passed' });
    }
  }
  if (process.env.AF_HISTORY_CONTROLS_REPORT) fs.writeFileSync(process.env.AF_HISTORY_CONTROLS_REPORT, JSON.stringify(report, null, 2));
  console.log('History controls own checks passed: ' + JSON.stringify(report.map(({ theme, width, buttons }) => ({ theme, width, buttonWidths: buttons.map(button => button.width), backgrounds: buttons.map(button => button.background) }))));
}

function rgb(hex) { return 'rgb(' + hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ') + ')'; }
function contrast(foreground, background) {
  const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
module.exports = { checkHistoryControls };
