const assert = require('node:assert/strict');
async function checkWorkUnits(page) {
  const emit = async value => { await page.evaluate(v => window.postMessage(v, '*'), value); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const capability = { model: true, taskModes: ['direct'], worktrees: true };
  await emit({ type: 'host.initialize', panelId: 'units', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  await emit({ type: 'worktree.updated', supported: true });
  await page.locator('#status-settings-button').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#status-settings-close').click();
  await page.locator('#worktree-button').click();
  assert.ok(await page.evaluate(() => window.sentMessages.some(m => m.type === 'worktree.repositories')));
  await emit({ type: 'worktree.repositories', repositories: [{ path: '/projects/one', branches: ['main'], defaultBranch: 'main' }, { path: '/projects/two', branches: ['main'], defaultBranch: 'main' }] });
  assert.equal(await page.locator('#worktree-repositories button').count(), 2);
  const fs = require('node:fs'); const path = require('node:path');
  const output = path.resolve(__dirname, '../../../docs/artifact/worktree-menu'); fs.mkdirSync(output, { recursive: true });
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
  assert.equal(await page.locator('#unit-create-dialog').isVisible(), true);
  assert.equal(await page.locator('#unit-name').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#unit-create-dialog input').count(), 1);
  assert.equal(await page.locator('#unit-create-dialog textarea').count(), 0);
  assert.equal(await page.locator('#unit-base').inputValue(), 'main');
  await page.locator('#unit-name').fill('My task');
  for (const width of [795, 566, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const rect = await page.locator('#unit-create-dialog').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= 740);
    assert.equal(await page.locator('#unit-create-dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.locator('#unit-create-dialog').screenshot({ path: path.join(output, `create-${width}.png`) });
    for (const id of ['unit-repository', 'unit-base']) {
      const select = page.locator('#' + id);
      assert.equal(await select.evaluate(el => getComputedStyle(el).appearance), 'base-select');
      await select.click();
      assert.equal(await select.evaluate(el => el.matches(':open')), true);
      const picker = await select.evaluate(el => {
        const style = getComputedStyle(el, '::picker(select)');
        return { radius: style.borderRadius, padding: style.paddingTop, width: parseFloat(style.width), controlWidth: el.getBoundingClientRect().width };
      });
      assert.equal(picker.radius, '8px');
      assert.equal(picker.padding, '5px');
      assert.ok(Math.abs(picker.width - picker.controlWidth) < 2);
      await page.screenshot({ path: path.join(output, `${id}-open-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#unit-create-dialog').isVisible(), true);
      assert.equal(await select.evaluate(el => el.matches(':open')), false);
    }

  }
  await page.locator('#unit-repository').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#unit-repository').inputValue(), '/projects/one');
  await page.locator('#unit-repository').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#unit-repository').inputValue(), '/projects/two');
  await page.locator('#unit-create-submit').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#unit-create-dialog').evaluate(el => el.contains(document.activeElement)), true);
  await page.locator('#unit-create-submit').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'worktree.create', repository: '/projects/two', name: 'My task', base: 'main' });
  assert.equal(await page.locator('#unit-create-submit').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#unit-create-dialog').isVisible(), true);
  await emit({ type: 'worktree.created', error: 'Branch collision' });
  assert.equal(await page.locator('#unit-name').inputValue(), 'My task');
  assert.equal(await page.locator('#unit-create-error').textContent(), 'Branch collision');
  await page.locator('#unit-create-submit').click();
  await emit({ type: 'worktree.created', created: true });
  assert.equal(await page.locator('#unit-create-dialog').isVisible(), false);
  await page.waitForFunction(() => document.activeElement === document.getElementById('worktree-button'));
  await page.locator('#worktree-button').click();
  await page.locator('#worktree-repositories button').first().click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#unit-create-dialog').isVisible(), false);
  await emit({ type: 'composer.prefill', text: 'Reviewed context' });
  assert.equal(await page.locator('#prompt').inputValue(), 'Reviewed context');
  await emit({ type: 'worktree.updated', supported: true, value: { worktree: { workUnit: true, phase: 'merged', cleaned: true }, workingDirectory: '/projects/two' } });
  assert.equal(await page.locator('#prompt').evaluate(el => el.readOnly), true);
  await page.locator('#worktree-button').click();
  assert.equal(await page.locator('#worktree-merge').isVisible(), false);
}
module.exports = { checkWorkUnits };
