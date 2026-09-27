const assert = require('node:assert/strict');

exports.checkWorktrees = async function (page) {
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'trees', role: 'main', runtimeAvailable: true, running: false, statusItems: ['project', 'branch'] }, '*'));
  const value = { agentId: 'main-one', workspaceRoot: '/workspace', workingDirectory: '/isolated/one',
    branch: 'feature-one', dirty: false, available: true, conflicts: [],
    worktree: { id: 'one', path: '/isolated/one', branch: 'feature-one', targetBranch: 'main', phase: 'active' } };
  await page.evaluate(() => window.postMessage({ type: 'worktree.updated', supported: true }, '*'));
  assert.equal(await page.locator('#submission-button').getAttribute('title'), 'Agent Factory');
  assert.equal(await page.locator('#conversation-clear-button + #worktree-picker').count(), 1);
  assert.equal(await page.locator('#submission-menu #worktree-controls').count(), 0);
  for (const width of [795, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const button = await page.locator('#worktree-button').boundingBox();
    const icon = await page.locator('#worktree-button > svg').boundingBox();
    assert.equal(await page.locator('#worktree-button').innerText(), '');
    assert.ok(await page.locator('#worktree-button').getAttribute('aria-label'));
    assert.equal(button.width, 30); assert.equal(button.height, 30);
    assert.ok(Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2) < 1);
    assert.ok(Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2) < 1);
    const next = await page.locator('#question-button').boundingBox();
    assert.ok(next.y >= button.y + button.height || next.x >= button.x + button.width, 'neighbor does not overlap');
  }
  await page.setViewportSize({ width: 795, height: 900 });
  await page.locator('#prompt').fill('Preserve this draft');
  await page.locator('#worktree-button').click();
  await page.locator('#worktree-create').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve this draft');
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.create');
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', supported: true, value }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#worktree-merge').hidden === false);
  assert.equal(await page.locator('#worktree-create').isVisible(), false);
  assert.equal(await page.locator('#status-bar [data-item-id=project]').innerText(), 'Tree');
  assert.match(await page.locator('#status-bar [data-item-id=project]').getAttribute('title'), /\/isolated\/one.*feature-one/);
  assert.equal(await page.locator('#worktree-location').count(), 0);
  assert.match(await page.locator('#worktree-summary').innerText(), /feature-one/);
  assert.match(await page.locator('#worktree-button').getAttribute('class'), /is-connected/);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-merge').disabled);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.locator('#worktree-button').click();
  await page.locator('#worktree-merge').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.merge');
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, conflicts: ['file.txt'], worktree: { ...value.worktree, phase: 'conflict' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#status-bar [data-item-id=project]').title.includes('file.txt'));
  await page.locator('#worktree-button').click();
  assert.equal(await page.locator('#worktree-merge').isVisible(), true);
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, workingDirectory: '/workspace', branch: 'main', worktree: { ...value.worktree, phase: 'merged' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#worktree-create').hidden === false);
  assert.match(await page.locator('#status-bar [data-item-id=project]').getAttribute('title'), /\/workspace.*main/);
  assert.equal(await page.locator('#status-bar [data-item-id=project]').innerText(), 'Home');
  await page.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page.locator('#worktree-create').isVisible());
  const bounds = await page.locator('#worktree-menu').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375, JSON.stringify(bounds));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  assert.equal(await page.locator('#worktree-button').getAttribute('aria-expanded'), 'false');
  await page.locator('#worktree-button').click();
  await page.evaluate(() => window.postMessage({ type: 'queue.updated', count: 1 }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-create').disabled);
  await page.locator('#worktree-refresh').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.refresh');
  await page.evaluate(() => window.postMessage({ type: 'worktree.updated', supported: false }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-picker').hidden);
  assert.equal(await page.locator('#worktree-button').isVisible(), false);
};
