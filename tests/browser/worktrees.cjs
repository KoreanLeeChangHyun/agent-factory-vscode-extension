const assert = require('node:assert/strict');

exports.checkWorktrees = async function (page) {
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'trees', role: 'main', runtimeAvailable: true, running: false, statusItems: ['agents', 'project', 'branch'] }, '*'));
  const value = { agentId: 'main-one', workspaceRoot: '/workspace', workingDirectory: '/isolated/one',
    branch: 'feature-one', dirty: false, available: true, conflicts: [],
    worktree: { id: 'one', path: '/isolated/one', branch: 'feature-one', targetBranch: 'main', phase: 'active' } };
  await page.evaluate(() => window.postMessage({ type: 'worktree.updated', supported: true }, '*'));
  assert.equal(await page.locator('#submission-button').getAttribute('title'), 'Agent Factory');
  assert.equal(await page.locator('.composer-actions #worktree-picker').count(), 0);
  assert.equal(await page.locator('#agents-menu #worktree-picker').count(), 1);
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [] }, '*'));
  await page.locator('#status-bar [data-item-id=agents]').click();
  assert.equal(await page.locator('#submission-menu #worktree-controls').count(), 0);
  for (const [width, height] of [[795, 900], [375, 800], [465, 556], [721, 402]]) {
    await page.setViewportSize({ width, height });
    const button = await page.locator('#worktree-button').boundingBox();
    const icon = await page.locator('#worktree-button > svg').boundingBox();
    assert.equal(await page.locator('#worktree-button').innerText(), '');
    assert.ok(await page.locator('#worktree-button').getAttribute('aria-label'));
    assert.equal(button.width, 30); assert.equal(button.height, 30);
    assert.ok(Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2) < 1);
    assert.ok(Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2) < 1);
    assert.ok(button.x >= 0 && button.x + button.width <= width && button.y >= 0 && button.y + button.height <= height);
    for (const selector of ['#prompt', '#send-button']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height, selector);
    }
    await page.locator('#worktree-button').focus();
    await page.keyboard.press('Enter');
    assert.ok(await page.locator('#worktree-refresh').isVisible());
    const menu = await page.locator('#worktree-menu').boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= width && menu.y >= 0 && menu.y + menu.height <= height, JSON.stringify(menu));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#worktree-menu').isVisible(), false);
    assert.equal(await page.locator('#agents-menu').isVisible(), true);
  }
  await page.setViewportSize({ width: 795, height: 900 });
  await page.locator('#prompt').fill('Preserve this draft');
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  await page.evaluate(() => window.postMessage({ type: 'worktree.repositories', repositories: [{ path: '/workspace', branches: ['main'], defaultBranch: 'main' }] }, '*'));
  await page.locator('#worktree-repositories button').click();
  await page.locator('#unit-name').fill('Task');
  await page.locator('#unit-create-submit').click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve this draft');
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'worktree.create', repository: '/workspace', name: 'Task', base: 'main' });
  await page.evaluate(() => window.postMessage({ type: 'worktree.created' }, '*'));
  await page.waitForFunction(() => !document.querySelector('#unit-create-dialog').open);
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
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  await page.locator('#worktree-merge').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.merge');
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, conflicts: ['file.txt'], worktree: { ...value.worktree, phase: 'conflict' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#status-bar [data-item-id=project]').title.includes('file.txt'));
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  assert.equal(await page.locator('#worktree-merge').isVisible(), true);
  await page.evaluate(value => window.postMessage({ type: 'worktree.updated', value: { ...value, workingDirectory: '/workspace', branch: 'main', worktree: { ...value.worktree, phase: 'merged' } } }, '*'), value);
  await page.waitForFunction(() => document.querySelector('#status-bar [data-item-id=project]').title.includes('/workspace'));
  assert.equal(await page.locator('#worktree-create').getAttribute('hidden'), '');
  assert.match(await page.locator('#status-bar [data-item-id=project]').getAttribute('title'), /\/workspace.*main/);
  assert.equal(await page.locator('#status-bar [data-item-id=project]').innerText(), 'Home');
  await page.setViewportSize({ width: 375, height: 800 });
  assert.ok(await page.locator('#worktree-refresh').isVisible());
  const bounds = await page.locator('#worktree-menu').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375, JSON.stringify(bounds));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  assert.equal(await page.locator('#worktree-button').getAttribute('aria-expanded'), 'false');
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  await page.evaluate(() => window.postMessage({ type: 'queue.updated', count: 1 }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-create').disabled);
  await page.locator('#worktree-refresh').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'worktree.refresh');
  await page.evaluate(() => window.postMessage({ type: 'worktree.updated', supported: false }, '*'));
  await page.waitForFunction(() => document.querySelector('#worktree-picker').hidden);
  assert.equal(await page.locator('#worktree-button').isVisible(), false);
  await checkDeploy(page);
  await page.locator('#worktree-button').click();
  await page.locator('#status-bar [data-item-id=agents]').click();
  assert.equal(await page.locator('#agents-menu').isVisible(), false);
  assert.equal(await page.locator('#worktree-menu').isVisible(), false);
  assert.equal(await page.locator('#worktree-button').getAttribute('aria-expanded'), 'false');
};

exports.checkDeploy = checkDeploy;

async function checkDeploy(page) {
  const workflow = { id: 7, name: 'Joint release', path: '.github/workflows/release.yml', missingSecrets: [], inputs: [
    { name: 'version', type: 'string', description: 'Release version', required: false, suggestion: '1.0.21' }] };
  const post = message => page.evaluate(value => window.postMessage(value, '*'), message);
  await post({ type: 'deploy.targets', target: { repository: 'owner/repo', ref: 'main', workflows: [{ ...workflow, missingSecrets: ['RELEASE_TOKEN'] }] } });
  await page.waitForFunction(() => !document.querySelector('#worktree-picker').hidden);
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  assert.ok(await page.evaluate(() => window.sentMessages.slice(-3).some(message => message.type === 'deploy.detect')), 'opening the menu refreshes pipelines');
  await post({ type: 'deploy.targets', target: { repository: 'owner/repo', ref: 'main', workflows: [{ ...workflow, missingSecrets: ['RELEASE_TOKEN'] }] } });
  assert.ok(await page.locator('#deploy-workflows [data-deploy-secret]').isVisible());
  assert.ok(await page.locator('#deploy-workflows button:not([data-deploy-secret])').isDisabled(), 'deploy waits for the token');
  await page.locator('#deploy-workflows [data-deploy-secret]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'deploy.token', secret: 'RELEASE_TOKEN' });
  await post({ type: 'deploy.targets', target: { repository: 'owner/repo', ref: 'main', workflows: [workflow] } });
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  await post({ type: 'deploy.targets', target: { repository: 'owner/repo', ref: 'main', workflows: [workflow] } });
  await page.waitForFunction(() => document.querySelector('#deploy-summary').textContent === 'owner/repo · main');
  await page.locator('#deploy-workflows button').click();
  assert.ok(await page.locator('#deploy-dialog').isVisible());
  assert.match(await page.locator('#deploy-target').innerText(), /owner\/repo/);
  const version = page.locator('[data-deploy-input="version"]');
  assert.equal(await version.inputValue(), '1.0.21');
  await version.fill('next');
  await page.locator('#deploy-submit').click();
  assert.ok(await page.locator('#deploy-error').isVisible());
  await version.fill('1.0.21');
  await page.locator('#deploy-submit').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'deploy.run', workflowId: 7, inputs: { version: '1.0.21' } }, 'one confirmation dispatches');
  await post({ type: 'deploy.status', repository: 'owner/repo', run: { id: 2, url: 'https://github.com/owner/repo/actions/runs/2', workflow: 'Joint release', status: 'queued' } });
  await page.waitForFunction(() => !document.querySelector('#deploy-dialog').open);
  if (!await page.locator('#agents-menu').isVisible()) await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#worktree-button').click();
  assert.match(await page.locator('#deploy-run-link').innerText(), /Joint release/);
  assert.ok(await page.locator('#deploy-workflows button').isDisabled(), 'one deployment at a time');
  await page.keyboard.press('Escape');
}
