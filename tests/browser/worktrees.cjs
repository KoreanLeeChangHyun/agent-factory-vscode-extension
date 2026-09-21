const assert = require('node:assert/strict');

exports.checkWorktrees = async function (page) {
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'trees', role: 'main', runtimeAvailable: true, running: false, statusItems: ['project', 'branch'] }, '*'));
  const value = { agentId: 'main-one', workspaceRoot: '/workspace', workingDirectory: '/isolated/one',
    branch: 'feature-one', dirty: false, available: true, conflicts: [],
    worktree: { id: 'one', path: '/isolated/one', branch: 'feature-one', targetBranch: 'main', phase: 'active' } };
  await page.evaluate(() => window.postMessage({ type: 'worktree.updated', supported: true }, '*'));
  assert.equal(await page.locator('#submission-button').getAttribute('title'), 'Agent Factory');
  await page.locator('#prompt').fill('Preserve this draft');
  await page.locator('#submission-button').click();
  await page.locator('#worktree-create').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve this draft');
  assert.equal(await page.locator('#submission-menu').isVisible(), false);
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.create');
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', supported: true, value }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#worktree-merge').hidden === false);
  assert.equal(await page.locator('#worktree-create').isVisible(), false);
  assert.equal(await page.locator('#status-bar [data-item-id=project]').innerText(), 'Tree');
  assert.match(await page.locator('#status-bar [data-item-id=project]').getAttribute('title'), /\/isolated\/one.*feature-one/);
  assert.equal(await page.locator('#worktree-location').count(), 0);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-merge').disabled);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.locator('#submission-button').click();
  await page.locator('#worktree-merge').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.merge');
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, conflicts: ['file.txt'], worktree: { ...value.worktree, phase: 'conflict' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#status-bar [data-item-id=project]').title.includes('file.txt'));
  await page.locator('#submission-button').click();
  assert.equal(await page.locator('#worktree-merge').isVisible(), true);
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, workingDirectory: '/workspace', branch: 'main', worktree: { ...value.worktree, phase: 'merged' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#worktree-create').hidden === false);
  assert.match(await page.locator('#status-bar [data-item-id=project]').getAttribute('title'), /\/workspace.*main/);
  assert.equal(await page.locator('#status-bar [data-item-id=project]').innerText(), 'Home');
  await page.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page.locator('#worktree-create').isVisible());
};
