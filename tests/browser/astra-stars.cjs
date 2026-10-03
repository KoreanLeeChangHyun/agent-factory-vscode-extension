const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkAstraStars(page) {
  const emit = async value => {
    await page.evaluate(value => window.postMessage(value, '*'), value);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const capability = { model: true, reasoning: true, fast: true };
  await emit({ type: 'host.initialize', panelId: 'star-preview', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'models.list', models: ['gpt-6-astra', 'gpt-5.6-sol'] });
  await page.locator('#model-button').click();
  await page.locator('select[data-role="main"][data-field="model"]').selectOption('gpt-6-astra');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('');
  assert.equal(await page.locator('.astra-stars').isVisible(), true);
  assert.equal(await page.locator('.astra-stars').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.astra-stars').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
  const artifacts = path.resolve(__dirname, '../../../docs/artifact/astra-stars');
  fs.mkdirSync(artifacts, { recursive: true });
  for (const width of [795, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const shots = [];
    for (const time of [0, 1800]) {
      await page.locator('.astra-star').evaluateAll((stars, time) => {
        for (const star of stars) for (const animation of star.getAnimations()) {
          animation.pause(); animation.currentTime = time;
        }
      }, time);
      shots.push(await page.locator('.composer').screenshot({ path: path.join(artifacts, `stars-${width}-${time}.png`), animations: 'allow' }));
    }
    assert.equal(shots[0].equals(shots[1]), false, 'Stars must visibly twinkle');
    assert.equal(await page.locator('.composer').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  }
  await page.setViewportSize({ width: 795, height: 740 });
  await page.locator('#prompt').click();
  await page.keyboard.type('A clear space for your next idea.');
  assert.equal(await page.locator('#prompt').inputValue(), 'A clear space for your next idea.');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.astra-stars')).opacity) < .15);
  await page.locator('.composer').screenshot({ path: path.join(artifacts, 'typing.png') });
  await page.locator('#prompt').fill('');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.astra-star').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--vscode-foreground', '#303743');
    document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
    document.documentElement.style.setProperty('--vscode-editorWidget-background', '#f4f5f8');
  });
  await page.locator('.composer').screenshot({ path: path.join(artifacts, 'light-reduced-motion.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await page.locator('.astra-stars').isVisible(), false);
  await page.emulateMedia({ forcedColors: 'none' });
  await page.locator('#model-button').click();
  await page.locator('select[data-role="main"][data-field="model"]').selectOption('gpt-5.6-sol');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.astra-stars').isVisible(), false);
}
module.exports = { checkAstraStars };
