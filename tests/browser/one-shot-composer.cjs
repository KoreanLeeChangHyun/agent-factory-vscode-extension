const assert = require('node:assert/strict');
async function checkOneShotComposer(page) {
  const actions = ['work', 'work-verification'];
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', ...actions] };
  await page.evaluate(capability => window.postMessage({ type: 'host.initialize', panelId: 'one-shot', role: 'main', runtimeAvailable: true, fastMode: true, capabilities: { submit: capability, send: capability } }, '*'), capability);
  await page.waitForFunction(() => document.querySelector('#fast-mode-button').getAttribute('aria-pressed') === 'true');
  const alignment = await page.locator('#submission-button').evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const icon = button.querySelector('svg').getBoundingClientRect();
    return {
      x: icon.x + icon.width / 2 - bounds.x - bounds.width / 2,
      y: icon.y + icon.height / 2 - bounds.y - bounds.height / 2
    };
  });
  assert.ok(Math.abs(alignment.x) < 0.5 && Math.abs(alignment.y) < 0.5, JSON.stringify(alignment));
  const last = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1));
  const count = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').length);
  await page.locator('#prompt').fill('   ');
  const before = await count();
  await page.locator('#send-button').click();
  assert.equal(await count(), before);
  assert.match(await page.locator('#input-feedback').innerText(), /target and desired result/);
  assert.equal(await page.locator('#prompt').inputValue(), '   ');
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu select[data-role]').count(), 3);
  await page.keyboard.press('Escape');
  for (const [action, workflow, goal] of [
    ['direct', 'interview', false],
    ['direct', 'migration', false],
    ['direct', 'lessons', false],
    ['direct', 'contract', false],
    ...actions.map(x => [x, 'normal', false])
  ]) {
    await page.locator('#prompt').fill('Current draft');
    const n = await count();
    await page.locator('#submission-button').click();
    assert.equal(await count(), n);
    await page.locator(`#submission-menu [data-action="${action}"][data-workflow="${workflow}"][data-goal="${goal}"]`).click();
    assert.equal((await last()).execution.taskMode, action);
    assert.equal((await last()).execution.businessMode, workflow);
    assert.equal((await last()).execution.goal, goal);
    assert.equal(await page.locator('#prompt').inputValue(), '');
  }
  assert.equal(await page.locator('#goal-mode-button').count(), 0);
  const sendGoal = async () => {
    await page.locator('#submission-button').click();
    await page.locator('#submission-menu [data-goal="true"]').click();
  };
  await page.locator('#prompt').fill('Goal draft');
  const beforeGoal = await count();
  await sendGoal();
  assert.equal(await count(), beforeGoal + 1);
  assert.equal((await last()).execution.taskMode, 'direct');
  assert.equal((await last()).execution.goal, true);
  assert.equal((await last()).execution.goalObjective, 'Goal draft');
  for (const draft of ['   ', 'x'.repeat(4001)]) {
    await page.locator('#prompt').fill(draft);
    const beforeInvalid = await count();
    await sendGoal();
    assert.equal(await count(), beforeInvalid);
    assert.equal(await page.locator('#prompt').inputValue(), draft);
    assert.equal(await page.locator('#input-feedback').isVisible(), true);
  }
  await page.locator('#prompt').fill('x'.repeat(4000));
  await sendGoal();
  assert.equal((await last()).execution.goal, true);
  assert.equal((await last()).execution.goalObjective.length, 4000);
  await page.locator('#prompt').fill('Next ordinary input');
  await page.locator('#prompt').press('Enter');
  assert.equal((await last()).execution.taskMode, 'direct');
  assert.equal((await last()).execution.businessMode, 'normal');
  assert.equal((await last()).execution.goal, false);
  await page.locator('#submission-button').click();
  const first = page.locator('#submission-menu [role="menuitem"]').first();
  await first.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#submission-menu [role="menuitem"]').nth(1).evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#submission-button').evaluate(e => e === document.activeElement), true);
  for (const [action, workflow] of [
    ['direct', 'interview'], ['direct', 'migration'], ['direct', 'lessons']
  ]) {
    await page.locator('#prompt').fill('   ');
    const beforeEmpty = await count();
    await page.locator('#submission-button').click();
    await page.locator(`#submission-menu [data-action="${action}"][data-workflow="${workflow}"]`).click();
    assert.equal(await count(), beforeEmpty + 1, `${action}/${workflow} submits a contextual request`);
    assert.ok((await last()).text.trim());
    assert.equal((await last()).execution.businessMode, workflow);
    assert.equal((await last()).execution.taskMode, action);
    assert.equal(await page.locator('#prompt').inputValue(), '');
    assert.equal(await page.locator('#input-feedback').isVisible(), false);
  }
  await page.evaluate(() => {
    window.postMessage({ type: 'run.state', running: false }, '*');
    window.postMessage({ type: 'agents.list', agents: [{ agentId: 'work-background', runId: 'run-background', role: 'work', status: 'running', taskBinding: {
      workflowId: 'background-flow', workflowTitle: 'Background workflow',
      taskId: 'background-task', title: 'Background task', description: 'Continue the accepted task'
    } }] }, '*');
  });
  await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-status').isVisible(), true);
  await page.locator('#prompt').fill('A question while work continues');
  await page.locator('#prompt').press('Enter');
  assert.equal((await last()).execution.taskMode, 'direct');
  await page.evaluate(capability => window.postMessage({ type: 'capabilities.updated', capabilities: { submit: {...capability, goal:false,taskModes:['direct','work']},send:capability } }, '*'), capability);
  await page.locator('#submission-button').click();
  assert.equal(await page.locator('#submission-menu [data-goal="true"]').isDisabled(), true);
  assert.equal(await page.locator('#submission-menu [data-action="work-verification"]').isDisabled(), true);
  await page.screenshot({path:'/tmp/af-unified-composer.png'});
}
async function checkDocumentSubmissions(page) {
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct'] };
  await page.evaluate(capability => window.postMessage({ type: 'host.initialize', panelId: 'documents', role: 'main', runtimeAvailable: true, fastMode: true, capabilities: { submit: capability, send: capability } }, '*'), capability);
  await page.waitForFunction(() => document.querySelector('#fast-mode-button').getAttribute('aria-pressed') === 'true');
  const messages = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send'));
  await page.locator('#submission-button').click();
  assert.deepEqual(await page.locator('#submission-options [data-workflow]').evaluateAll(items => items.slice(0, 2).map(item => item.dataset.workflow)), ['planning', 'interview']);
  await page.keyboard.press('Escape');
  for (const workflow of ['planning', 'interview', 'migration', 'lessons']) {
    for (const draft of ['', '   ', 'Use only the selected document']) {
      await page.locator('#prompt').fill(draft);
      const before = (await messages()).length;
      await page.locator('#submission-button').click();
      await page.locator(`#submission-menu [data-workflow="${workflow}"]`).click();
      const sent = await messages();
      assert.equal(sent.length, before + 1);
      assert.equal(sent.at(-1).execution.businessMode, workflow);
      assert.equal(sent.at(-1).execution.taskMode, 'direct');
      assert.equal(sent.at(-1).execution.goal, false);
      assert.ok(sent.at(-1).text.trim());
      if (draft.trim()) assert.equal(sent.at(-1).text, draft);
      assert.equal(await page.locator('#input-feedback').isVisible(), false);
    }
    const attachment = { id: `document-${workflow}`, name: 'notes.txt', kind: 'file', uri: 'file:///test/notes.txt' };
    await page.evaluate(attachment => window.postMessage({ type: 'attachments.add', attachments: [attachment] }, '*'), attachment);
    await page.waitForFunction(id => window.saved.attachments.some(a => a.id === id), attachment.id);
    await page.locator('#submission-button').click();
    await page.locator(`#submission-menu [data-workflow="${workflow}"]`).click();
    assert.equal((await messages()).at(-1).attachments[0].uri, attachment.uri);
    assert.equal((await messages()).at(-1).execution.businessMode, workflow);
  }
  const before = (await messages()).length;
  await page.locator('#prompt').press('Enter');
  assert.equal((await messages()).length, before, 'Ordinary empty submission remains blocked');
  await page.locator('#prompt').fill('Next ordinary request');
  await page.locator('#prompt').press('Enter');
  assert.equal((await messages()).at(-1).execution.businessMode, 'normal');
}
module.exports = { checkOneShotComposer, checkDocumentSubmissions };
