const assert = require('node:assert/strict');

// Task panel: the revision-limit decision view and the dispatch order of brief cards.
async function checkRevisionLimit(page) {
  const language = async value => {
    if (!await page.locator('#status-settings').isVisible()) await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-general').click();
    await page.locator('#ui-language').selectOption(value);
    await page.locator('#status-settings-button').click();
  };
  const post = (agents, workflows) => page.evaluate(({ agents, workflows }) => window.postMessage({ type: 'agents.list', agents, workflows }, '*'), { agents, workflows });
  const last = () => page.evaluate(() => window.sentMessages.at(-1));
  await language('ko');

  const longId = 'finding-with-a-very-long-identifier-that-must-stay-on-one-line-0001';
  const pause = { code: 'revision_limit_reached', revisionCount: 3, maxRevisions: 3, pendingFindingIds: [longId, 'finding-2'],
    findings: [{ id: longId, path: 'src/panel/decision-view.ts', problem: 'The label still reads "Close" after the third revision and wraps across several lines in a narrow panel.' }] };
  const limited = { kind: 'work-verification-loop', loopId: 'loop-limit', workAgentId: 'limit-worker', verificationAgentId: 'limit-verifier',
    taskMode: 'work-verification', status: 'needs-human-decision', dispatchedAt: '2026-10-03T10:00:00Z', pause,
    workflow: { id: 'brief-limit', title: 'Rename the close label', index: 0, tasks: [
      { id: 'task-limit', title: 'Rename the close label', description: 'Rename it.', workAgentId: 'limit-worker', workRunId: 'limit-run', workStatus: 'completed',
        verificationAgentId: 'limit-verifier', verificationRunId: 'limit-verify-run', verificationStatus: 'blocked' }] } };
  await post([], [limited]);
  const flow = page.locator('#run-stage-list [data-flow-id="brief-limit"]');
  const view = flow.locator('.task-flow-decision');
  await view.waitFor();
  assert.equal(await flow.locator('.task-flow-single .task-flow-state').textContent(), '결정 대기');
  assert.equal(await view.locator('.task-flow-decision-title').textContent(), '수정 상한 도달');
  assert.equal(await view.locator('.task-flow-decision-revisions').textContent(), '수정 3/3회 사용');
  assert.equal(await view.locator('.task-flow-decision-count').textContent(), '남은 지적 2건');
  assert.deepEqual(await view.locator('.task-flow-decision-finding-id').allTextContents(), [longId, 'finding-2']);
  assert.deepEqual(await view.locator('.task-flow-decision-finding-path').allTextContents(), ['src/panel/decision-view.ts']);
  assert.equal(await view.locator('.task-flow-decision-finding-problem').count(), 1, 'A finding without a recorded summary shows its identifier only');
  // Exactly two actions, visible without expanding the card.
  assert.deepEqual(await view.locator('button').allTextContents(), ['계속', '중지']);
  assert.equal(await flow.locator('.task-flow-single').getAttribute('open'), null);
  assert.equal(await view.getByRole('button', { name: 'Rename the close label · 계속', exact: true }).getAttribute('title'), '수정 3회를 추가해 계속');
  assert.equal(await view.getByRole('button', { name: 'Rename the close label · 중지', exact: true }).getAttribute('title'), '이 작업 흐름을 종료');

  // Optional evidence for a Human review of the view; nothing is written unless a path is given.
  if (process.env.REVISION_LIMIT_SCREENSHOT) await page.locator('#run-details').screenshot({ path: process.env.REVISION_LIMIT_SCREENSHOT });
  // Restrained colour: the view uses the neutral widget border, not a status colour, and identifiers never wrap.
  const style = await view.evaluate(el => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--vscode-widget-border, #555)';
    el.append(probe);
    const neutral = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(el).borderTopColor, neutral, id: getComputedStyle(el.querySelector('.task-flow-decision-finding-id')).whiteSpace };
  });
  assert.equal(style.border, style.neutral);
  assert.equal(style.id, 'nowrap');
  for (const size of [{ width: 320, height: 800 }, { width: 465, height: 556 }, { width: 721, height: 402 }]) {
    await page.setViewportSize(size);
    assert.ok(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `The decision view fits ${size.width}px`);
    const id = view.locator('.task-flow-decision-finding-id').first();
    assert.ok(await id.evaluate(el => el.getBoundingClientRect().height < 24), 'The long identifier stays on one line');
    for (const button of await view.locator('button').all()) {
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1,
        `Both actions are on screen at ${size.width}x${size.height}`);
    }
  }
  await page.setViewportSize({ width: 900, height: 800 });

  // Continue: one message, both actions locked until the host answers.
  await view.locator('button[data-decision="continue"]').click();
  assert.deepEqual(await last(), { type: 'workflow.decision', workAgentId: 'limit-worker', loopId: 'loop-limit', decision: 'continue' });
  assert.deepEqual(await view.locator('button').evaluateAll(buttons => buttons.map(button => button.disabled)), [true, true]);
  const sent = await page.evaluate(() => window.sentMessages.length);
  await view.locator('button[data-decision="stop"]').click({ force: true });
  assert.equal(await page.evaluate(() => window.sentMessages.length), sent, 'A locked view sends nothing more');
  // A refresh of the same stop keeps the lock; a failed command offers both actions again.
  await post([], [limited]);
  assert.deepEqual(await view.locator('button').evaluateAll(buttons => buttons.map(button => button.disabled)), [true, true]);
  await page.evaluate(() => window.postMessage({ type: 'host.notice', level: 'error', text: 'Error: Loop is not stopped on its revision limit' }, '*'));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-flow-id="brief-limit"] .task-flow-decision button')].every(button => !button.disabled));
  await view.locator('button[data-decision="stop"]').click();
  assert.deepEqual(await last(), { type: 'workflow.decision', workAgentId: 'limit-worker', loopId: 'loop-limit', decision: 'stop' });

  // The host's answer ends the view: a resumed loop shows its running revision instead.
  const resumed = { ...limited, status: 'active', pause: null, workflow: { ...limited.workflow, tasks: [
    { ...limited.workflow.tasks[0], workRunId: 'limit-run-4', workStatus: 'running', verificationStatus: 'pending' }] } };
  await post([], [resumed]);
  await page.waitForFunction(() => !document.querySelector('[data-flow-id="brief-limit"] .task-flow-decision'));
  assert.equal(await flow.locator('.task-flow-single .task-flow-state').textContent(), '진행 중');
  // Without the structured pause (a runtime that does not advertise it) the stop stays a plain blocked card.
  await post([], [{ ...limited, pause: undefined }]);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="brief-limit"] .task-flow-state')?.textContent === '결정 대기');
  assert.equal(await view.count(), 0);
  assert.equal(await flow.locator('.task-flow-decision-action').count(), 0);

  await language('en');
  await post([], [limited]);
  await view.waitFor();
  assert.deepEqual(await view.locator('button').allTextContents(), ['Continue', 'Stop']);
  assert.equal(await view.locator('.task-flow-decision-revisions').textContent(), 'Revisions used: 3 of 3');
  assert.equal(await view.getByRole('button', { name: 'Rename the close label · Continue', exact: true }).getAttribute('title'), 'Continue with 3 more revisions');
  await language('ko');

  // A task list stopped on its second task names that task; the view sits with the flow summary.
  const listed = { kind: 'work-verification-loop', loopId: 'loop-listed', workAgentId: 'listed-worker', verificationAgentId: 'listed-verifier',
    taskMode: 'work-verification', status: 'needs-human-decision', dispatchedAt: '2026-10-03T10:00:01Z', pause: { ...pause, pendingFindingIds: ['finding-9'], findings: [] },
    workflow: { id: 'listed-flow', title: 'Two fixes', index: 1, tasks: [
      { id: 'listed-1', title: 'First fix', workRunId: 'listed-run-1', workStatus: 'completed', verificationRunId: 'listed-verify-1', verificationStatus: 'completed' },
      { id: 'listed-2', title: 'Second fix', workRunId: 'listed-run-2', workStatus: 'completed', verificationRunId: 'listed-verify-2', verificationStatus: 'blocked' }] } };
  await post([], [listed]);
  const listedView = page.locator('#run-stage-list [data-flow-id="listed-flow"] > .task-flow-decision');
  await listedView.waitFor();
  assert.equal(await listedView.getAttribute('aria-label'), 'Second fix · 수정 상한 도달');
  assert.deepEqual(await listedView.locator('button').allTextContents(), ['계속', '중지']);
  assert.equal(await listedView.locator('.task-flow-decision-findings li').count(), 1);
  await post([], [{ ...limited, status: 'cancelled', pause: null, workflow: { ...limited.workflow, tasks: [{ ...limited.workflow.tasks[0], verificationStatus: 'cancelled' }] } },
    { ...listed, status: 'cancelled', pause: null, workflow: { ...listed.workflow, tasks: listed.workflow.tasks.map(task => ({ ...task, verificationStatus: task.verificationStatus === 'blocked' ? 'cancelled' : task.verificationStatus })) } }]);
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="brief-limit"] .task-flow-state')?.textContent === '취소');
  assert.equal(await flow.locator('.task-flow-decision').count(), 0, 'Cancelled workflow no longer asks for a decision');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="listed-flow"]').count(), 1, 'Cancelled rows remain in the list');
  // Dispatch ordering is a separate fixture, isolated from retained cancellation history.
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ botVisible: false })));
  await page.reload();
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'order-fixture', role: 'main', runtimeAvailable: true }, '*'));

  // Brief cards keep the order in which they were dispatched while their runs report in any order.
  const brief = (name, dispatchedAt, updatedAt, status = 'running') => ({ agentId: 'order-' + name, runId: 'order-run-' + name, role: 'work', status, dispatchedAt, updatedAt,
    taskBinding: { workflowId: 'brief-order-' + name, workflowTitle: 'Brief ' + name, taskId: 'task-order-' + name, title: 'Brief ' + name, description: 'Do ' + name } });
  const order = () => page.locator('#run-stage-list .task-flow').evaluateAll(flows => flows.map(flow => flow.dataset.flowId));
  const expected = ['brief-order-a', 'brief-order-b', 'brief-order-c'];
  const dispatched = { a: '2026-10-03T11:00:01Z', b: '2026-10-03T11:00:02Z', c: '2026-10-03T11:00:03Z' };
  // The host lists child sessions newest update first.
  for (const [index, updates] of [['c', 'b', 'a'], ['a', 'c', 'b'], ['b', 'a', 'c'], ['a', 'b', 'c']].entries()) {
    await post(updates.map((name, position) => brief(name, dispatched[name], `2026-10-03T12:0${index}:0${9 - position}Z`)), []);
    await page.waitForFunction(count => document.querySelectorAll('#run-stage-list .task-flow').length === count, 3);
    await page.waitForFunction(stamp => JSON.stringify(window.saved?.childAgents || []).includes(stamp), `2026-10-03T12:0${index}:09Z`);
    assert.deepEqual(await order(), expected, 'update order ' + updates.join(''));
  }
}

module.exports = { checkRevisionLimit };
