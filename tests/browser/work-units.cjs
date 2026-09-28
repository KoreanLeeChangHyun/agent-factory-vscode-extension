const assert = require('node:assert/strict');
async function checkWorkUnits(page) {
  const emit = async value => { await page.evaluate(v => window.postMessage(v, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, taskModes: ['direct'], worktrees: true };
  await emit({ type: 'host.initialize', panelId: 'units', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'worktree.updated', supported: true });
  await page.locator('#worktree-button').click();
  assert.ok(await page.evaluate(() => window.sentMessages.some(m => m.type === 'worktree.repositories')));
  await emit({ type: 'worktree.repositories', repositories: [{ path: '/projects/one', branches: ['main'], defaultBranch: 'main' }, { path: '/projects/two', branches: ['main'], defaultBranch: 'main' }] });
  assert.equal(await page.locator('#worktree-repositories button').count(), 2);
  const fs = require('node:fs'); const path = require('node:path');
  const output = path.resolve(__dirname, '../../out/worktree-menu'); fs.mkdirSync(output, { recursive: true });
  for (const width of [795, 380]) {
    await page.setViewportSize({ width, height: 740 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const icon = await page.locator('#worktree-button').boundingBox();
    const menu = await page.locator('#worktree-menu').boundingBox();
    const expectedLeft = Math.max(8, Math.min(icon.x + icon.width - menu.width, width - menu.width - 8));
    assert.ok(Math.abs(menu.x - expectedLeft) < 2, JSON.stringify({ icon, menu }));
    assert.ok(Math.abs(icon.y - (menu.y + menu.height) - 8) < 2);
    assert.ok(menu.x >= 8 && menu.x + menu.width <= width - 8 && menu.y >= 0);
    assert.equal(await page.locator('#worktree-create').isVisible(), false);
    assert.equal(await page.locator('#worktree-summary').isVisible(), false);
    await page.locator('#worktree-menu').screenshot({ path: path.join(output, `menu-${width}.png`) });
  }
  await page.locator('#worktree-repositories button').nth(1).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'worktree.create', repository: '/projects/two' });
  await emit({ type: 'composer.prefill', text: 'Reviewed context' });
  assert.equal(await page.locator('#prompt').inputValue(), 'Reviewed context');
  await emit({ type: 'worktree.updated', supported: true, value: { worktree: { workUnit: true, phase: 'merged', cleaned: true }, workingDirectory: '/projects/two' } });
  assert.equal(await page.locator('#prompt').evaluate(el => el.readOnly), true);
  await page.locator('#worktree-button').click();
  assert.equal(await page.locator('#worktree-merge').isVisible(), false);
}
module.exports = { checkWorkUnits };
