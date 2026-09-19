const assert = require('node:assert/strict');
async function checkTaskFlow(page) {
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'flow', role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } }, '*'));
  const setAgents = async status => {
    await page.evaluate(status => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'work-one', runId: 'run-one', role: 'work', status }] }, '*'), status);
  };
  for (const status of ['completed', 'failed', 'cancelled']) {
    await setAgents(status);
    await page.waitForFunction(() => document.querySelector('#run-status').hidden);
    assert.equal(await page.locator('#run-status').isVisible(), false, 'Historical children must not keep the status visible');
  }
  assert.equal(await page.locator('#task-history-list .run-stage-id').textContent(), 'Task name not recorded');
  for (const status of ['queued', 'running', 'needs-human-decision']) {
    await setAgents(status);
    await page.waitForFunction(() => document.querySelector('#run-status').hidden);
    assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
  }
  await setAgents('running');
  assert.equal(await page.locator('#run-details').isVisible(), false, 'Runtime sessions alone cannot fabricate a task list');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 0);
  const flow = { id: 'flow-one', title: '화면 개선 작업', tasks: [
    { id: 'layout', title: '화면 수정', status: 'completed' },
    { id: 'behavior', title: '동작 연결', description: '클릭 시 작업을 요청하고 결과를 표시합니다.', status: 'running', agentId: 'work-one', runId: 'run-one' },
    { id: 'test', title: '테스트', status: 'pending' }
  ] };
  const send = async (snapshot, runId) => {
    await page.evaluate(({ snapshot, runId }) => window.postMessage({ type: 'chat.assistant', phase: 'commentary', runId,
      text: '정리한 작업입니다.\n```task-flow\n' + JSON.stringify(snapshot) + '\n```' }, '*'), { snapshot, runId });
    await page.waitForFunction(id => document.querySelector('#timeline .task-flow[data-flow-id="' + id + '"]'), snapshot.id);
  };
  await send(flow, 'main-one');
  assert.equal(await page.locator('#timeline .task-flow').count(), 1);
  assert.equal(await page.locator('#timeline code.language-task-flow').count(), 0);
  assert.equal(await page.locator('#run-status').isVisible(), true);
  assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'true');
  const panel = page.locator('#run-stage-list .task-flow[data-flow-id="flow-one"]');
  assert.deepEqual(await panel.locator('.task-flow-name').allTextContents(), ['화면 수정', '동작 연결', '테스트']);
  const originalViewport = page.viewportSize();
  for (const width of [800, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await panel.locator('.task-flow-step').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }));
    assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, 'Steps progress left to right');
    assert.ok(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1), 'Steps stay on one row');
    if (width === 320) {
      assert.ok(await panel.locator('.task-flow-list').evaluate(el => el.scrollWidth > el.clientWidth));
      assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Overflow stays inside the flow scroller');
    }
  }
  await page.setViewportSize(originalViewport);
  const active = panel.locator('[data-task-id="behavior"]');
  assert.equal(await active.getAttribute('aria-current'), 'step');
  await active.locator('summary').click();
  assert.equal(await active.locator('.task-flow-description div').textContent(), '클릭 시 작업을 요청하고 결과를 표시합니다.');
  await active.locator('summary').click();
  assert.equal(await active.evaluate(el => getComputedStyle(el, '::before').animationName), 'task-flow-forward');
  const stationary = panel.locator('[data-task-id="test"]');
  assert.equal(await stationary.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await active.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'work-one', runId: 'run-one', role: 'work', status: 'needs-human-decision' }] }, '*'));
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-task-id="behavior"]').dataset.status === 'blocked');
  assert.equal(await active.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  flow.tasks[1].status = 'completed';
  flow.tasks[2].status = 'verifying';
  await send(flow, 'main-two');
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-task-id="test"]').dataset.status === 'verifying');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 1, 'Update the same workflow instead of appending a duplicate');
  assert.equal(await page.locator('#timeline .task-flow').count(), 2, 'Conversation retains the earlier snapshot');
  assert.ok(await page.evaluate(() => window.saved.timeline.some(entry => entry.text?.includes('flow-one'))));
  for (const status of ['failed', 'blocked', 'cancelled', 'completed']) {
    flow.tasks[2].status = status;
    await send(flow, 'main-' + status);
    const container = status === 'blocked' ? '#run-stage-list' : '#task-history-list';
    await page.waitForFunction(({ container, status }) => document.querySelector(container + ' [data-task-id="test"]')?.dataset.status === status, { container, status });
    assert.equal(await page.locator(container + ' [data-task-id="test"]').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    assert.equal(await page.locator('#run-stage-list [data-flow-id="flow-one"]').count(), status === 'blocked' ? 1 : 0);
  }
  const malicious = { ...flow, id: 'unsafe-title', title: '<img src=x onerror=alert(1)>', tasks: [{ id: 'one', title: '<script>bad()</script>', status: 'pending', agentId: 'work-one', runId: 'run-one' }] };
  await send(malicious, 'main-safe');
  assert.equal(await page.locator('.task-flow img, .task-flow script').count(), 0);
  await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', runId: 'invalid', text: '```task-flow\n{"id":"broken","tasks":null}\n```' }, '*'));
  await page.waitForFunction(() => document.querySelector('#timeline code.language-task-flow'));
  assert.equal(await page.locator('[data-flow-id="broken"]').count(), 0);
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.locator('#run-stage-list .task-flow').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="flow-one"]'));
  assert.equal(await page.locator('#task-history-list [data-flow-id="flow-one"] .task-flow-step').count(), 3);
  assert.equal(await page.locator('#task-history-list [data-task-id="test"]').getAttribute('data-status'), 'completed');
  malicious.tasks[0].status = 'completed';
  await send(malicious, 'main-all-completed');
  await setAgents('completed');
  await page.waitForFunction(() => document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-details').isVisible(), false);
  assert.ok(await page.locator('#timeline .task-flow').count() > 0, 'Completed history remains available in chat');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#timeline .task-flow'));
  assert.equal(await page.locator('#run-status').isVisible(), false, 'Restoring completed history must not reopen status');
  const draft = { id: 'draft-only', title: 'Unsubmitted plan', tasks: [{ id: 'draft-task', title: 'Prepare change', status: 'pending' }] };
  await send(draft, 'draft-main');
  assert.equal(await page.locator('#run-status').isVisible(), false, 'A planned list alone is not a submitted workflow');
  assert.equal(await page.locator('#task-history-list [data-flow-id="draft-only"]').count(), 0);
  assert.equal(await page.locator('#timeline [data-flow-id="draft-only"]').count(), 1);
  draft.tasks[0].agentId = 'new-work';
  draft.tasks[0].runId = 'new-run';
  await send(draft, 'draft-bound');
  assert.equal(await page.locator('#run-status').isVisible(), false, 'Identifiers alone do not prove acceptance');
  await page.evaluate(() => { const el = document.querySelector('#timeline'); el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('#auto-scroll-state').dataset.state === 'following');
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'new-work', runId: 'new-run', role: 'work', status: 'accepted' }] }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-details').hidden);
  assert.equal(await page.locator('#run-stage-list [data-flow-id="draft-only"]').count(), 1, 'Acceptance automatically reveals the workflow');
  const atBottom = () => { const el = document.querySelector('#timeline'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 2; };
  await page.waitForFunction(atBottom);
  await page.locator('#run-status-toggle').click();
  await page.waitForFunction(atBottom);
  await page.locator('#run-status-toggle').click();
  await page.waitForFunction(atBottom);
  await page.locator('#auto-scroll-button').click();
  await page.evaluate(() => { document.querySelector('#timeline').scrollTop = 100; });
  await page.waitForFunction(() => document.querySelector('#timeline').scrollTop === 100);
  await page.locator('#run-status-toggle').click();
  await page.locator('#run-status-toggle').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#timeline').evaluate(el => el.scrollTop), 100, 'OFF preserves the reading position when status opens');
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'bound-work', runId: 'bound-run', role: 'work', status: 'running', taskBinding: {
    workflowId: 'runtime-contract', workflowTitle: '실제 제출한 작업', taskId: 'scroll-fix', title: '하단 스크롤 수정',
    description: '작업 현황을 펼치면 하단을 유지합니다.', completionCriteria: '접기와 펼치기 검사를 통과합니다.'
  } }] }, '*'));
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="runtime-contract"]'));
  const submitted = page.locator('#run-stage-list [data-flow-id="runtime-contract"]');
  assert.equal(await submitted.locator('.task-flow-name').textContent(), '하단 스크롤 수정');
  await submitted.locator('summary').click();
  assert.match(await submitted.locator('.task-flow-description div').textContent(), /작업 현황을 펼치면 하단을 유지합니다/);
  assert.match(await submitted.locator('.task-flow-description div').textContent(), /접기와 펼치기 검사를 통과합니다/);
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'bound-work', runId: 'bound-run', role: 'work', status: 'completed', taskBinding: {
    workflowId: 'runtime-contract', workflowTitle: '실제 제출한 작업', taskId: 'scroll-fix', title: '하단 스크롤 수정',
    description: '작업 현황을 펼치면 하단을 유지합니다.', completionCriteria: '접기와 펼치기 검사를 통과합니다.'
  } }], workflows: [] }, '*'));
  await page.waitForFunction(() => document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 0, 'Completed child must not resurrect a cached pending plan');
  assert.equal(await page.locator('#task-history-list .run-stage-id').textContent(), '하단 스크롤 수정');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#task-history-list .run-stage-id'));
  assert.equal(await page.locator('#run-status').isVisible(), false, 'Restored legacy pending metadata must not reopen an ended run');
  const engine = { kind: 'work-verification-loop', loopId: 'loop-engine', workAgentId: 'engine-worker', verificationAgentId: 'engine-verifier', taskMode: 'work-verification', status: 'active',
    workflow: { id: 'engine-flow', title: '전체 작업 흐름', tasks: [
      { id: 'first', workRunId: 'work-first', title: '첫 번째 수정', description: '첫 요청', completionCriteria: '검사 통과', workStatus: 'running', verificationStatus: 'pending' },
      { id: 'second', title: '두 번째 수정', description: '다음 요청', completionCriteria: '검사 통과', workStatus: 'pending', verificationStatus: 'pending' }
    ] } };
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  const graph = page.locator('#run-stage-list [data-flow-id="engine-flow"]');
  await graph.waitFor();
  assert.equal(await graph.locator('.task-flow-step').count(), 4, 'All work and verification phases appear immediately');
  assert.deepEqual(await graph.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.status)), ['running', 'pending', 'pending', 'pending']);
  const firstStage = graph.locator('.task-flow-step').first();
  assert.equal(await graph.locator('.task-flow-open').count(), 1, 'Unstarted stages have no session link');
  await firstStage.locator('.task-flow-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker' });

  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep', 'First active stage animates without an incoming connector');
  const positions = await firstStage.evaluate(el => {
    const animation = el.getAnimations().find(animation => animation.animationName === 'task-flow-active-sweep');
    animation.pause();
    animation.currentTime = 0;
    const start = getComputedStyle(el).backgroundPositionX;
    animation.currentTime = 1200;
    return [start, getComputedStyle(el).backgroundPositionX];
  });
  assert.notEqual(positions[0], positions[1], 'The highlight moves across the card');
  assert.equal(await graph.locator('.task-flow-step').nth(1).evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  engine.workflow.tasks[0].workStatus = 'completed';
  engine.workflow.tasks[0].verificationStatus = 'running';
  engine.workflow.tasks[0].verificationRunId = 'verify-first';
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="engine-flow"] [data-status="verifying"]'));
  assert.equal(await graph.locator('[aria-current="step"]').count(), 1);
  await graph.locator('[data-status="verifying"] .task-flow-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-verifier' });

  assert.equal(await graph.locator('[data-status="verifying"]').evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep');
  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'none', 'Completed stage stops animating');

  assert.equal(await graph.locator('.task-flow-step').count(), 4);
  engine.workflow.tasks[1].workAgentId = 'second-worker';
  engine.workflow.tasks[1].verificationAgentId = 'second-verifier';
  engine.workflow.tasks[1].workRunId = 'work-second';
  engine.workflow.tasks[1].verificationRunId = 'verify-second';
  engine.status = 'completed';
  for (const task of engine.workflow.tasks) { task.workStatus = 'completed'; task.verificationStatus = 'completed'; }
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="engine-flow"]'));
  assert.equal(await graph.count(), 0, 'Whole graph moves to history only after completion');
  await page.locator('#task-history > summary').click();
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open').first().click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker' });

  const historyButtons = page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open');
  await historyButtons.nth(2).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-worker' });
  await historyButtons.nth(3).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-verifier' });

  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'named-work', runId: 'named-run', role: 'work', status: 'completed', taskBinding: { title: '링크 검사 JSON 출력 추가' } },
    { agentId: 'named-verifier', runId: 'verify-run', role: 'verification', status: 'completed', taskBinding: { title: '링크 검사 JSON 출력 추가' } }
  ], workflows: [] }, '*'));
  await page.waitForFunction(() => document.querySelector('#task-history-list .run-stage-id')?.textContent === '링크 검사 JSON 출력 추가');
  assert.deepEqual(await page.locator('#task-history-list .run-stage-id').allTextContents(), ['링크 검사 JSON 출력 추가', '링크 검사 JSON 출력 추가']);
  assert.deepEqual(await page.locator('#agents-list .agent-id').allTextContents(), ['링크 검사 JSON 출력 추가', '링크 검사 JSON 출력 추가']);
  assert.match(await page.locator('#task-history-list .run-stage').first().getAttribute('title'), /named-work/);
  await page.screenshot({ path: '/tmp/af-task-flow.png' });
}
module.exports = { checkTaskFlow };
