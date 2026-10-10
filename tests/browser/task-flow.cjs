const assert = require('node:assert/strict');
async function checkWorkDecisionPlacement(page) {
  const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
  await post({ type: 'host.initialize', panelId: 'work-decision-panel', agentId: 'main-decision', role: 'main', runtimeAvailable: true });
  const internal = 'INTERNAL_WORKER_REPORT: lessons command denied\nChoose how to proceed.';
  const workflows = [1, 2].map(count => ({
    loopId: 'loop-question-' + count, workAgentId: 'worker-question-' + count,
    status: 'needs-human-decision', taskMode: 'work', workProfile: 'scribe',
    pendingDecision: { id: 'question-' + count, questionHash: 'hash-' + count, status: 'pending', question: internal },
    workflow: { id: 'flow-question-' + count, title: 'Document task ' + count, index: 0,
      tasks: Array.from({ length: count }, (_, index) => ({ id: 'task-' + index, title: 'Document step ' + index,
        description: 'Requested document update', workStatus: index === 0 ? 'blocked' : 'pending',
        ...(index === 0 ? { workRunId: 'run-question-' + count } : {}) })) }
  }));
  const check = async container => {
    for (const flow of workflows) {
      const card = page.locator(container + ' [data-flow-id="' + flow.workflow.id + '"]');
      await card.waitFor({ state: 'attached' });
      assert.ok(!(await card.textContent()).includes(internal), 'Internal reports never become card text');
      assert.equal(await card.locator('textarea, input, .task-flow-decision').count(), 0, 'Worker questions have no inline answer form');
      assert.equal(await card.locator('[data-status="blocked"]').count() > 0, true, 'The blocked task remains visible');
      assert.equal(await card.locator('.task-flow-open').count(), 1, 'The exact worker session remains accessible');
      assert.match(await card.textContent(), /Requested document update/);
    }
  };
  await post({ type: 'agents.list', agents: [], workflows });
  await check('#run-stage-list');
  workflows[0].pendingDecision.question += '\nUpdated internal detail.';
  await post({ type: 'agents.list', agents: [], workflows });
  await check('#run-stage-list');
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await check('#run-stage-list');
  for (const flow of workflows) flow.status = 'cancelled';
  await post({ type: 'agents.list', agents: [], workflows });
  await check('#task-history-list');
  assert.equal(await page.locator('#run-stage-list [data-flow-id^="flow-question-"]').count(), 0);
  assert.equal(await page.evaluate(() => window.sentMessages.some(message => ['workflow.answer', 'chat.send', 'task.stop'].includes(message.type))), false,
    'Displaying a decision does not answer it or start work');
}

async function checkTaskFlow(page, { panelOnly = false } = {}) {
  const checkHeaderPulse = async running => {
    const pulse = page.locator('#run-status-toggle .run-status-pulse');
    assert.equal(await page.locator('#run-status').evaluate(el => el.classList.contains('is-running')), running);
    assert.equal(await pulse.getAttribute('aria-hidden'), 'true');
    const originalClass = await page.locator('body').getAttribute('class');
    for (const [theme, progress, focus, neutral, foreground, expected, linkOverride] of [
      ['vscode-light', '#005fb8', '#007acc', '#616161', '#333333', 'rgb(0, 95, 184)'],
      ['vscode-dark', '#0e70c0', '#007fd4', '#999999', '#dddddd', 'rgb(14, 112, 192)'],
      ['vscode-high-contrast', '#00ffff', '#f38518', '#ffffff', '#ffffff', 'rgb(0, 255, 255)'],
      ['vscode-high-contrast-light', '#005a9e', '#0f4a85', '#292929', '#292929', 'rgb(0, 90, 158)'],
      ['vscode-dark', null, '#007fd4', '#999999', '#dddddd', 'rgb(0, 127, 212)'],
      ['vscode-dark', null, null, '#999999', '#dddddd', 'rgb(0, 128, 232)'],
      ['vscode-dark', '#ff8000', '#ff8000', '#999999', '#dddddd', 'rgb(255, 128, 0)', null],
    ]) {
      const link = linkOverride === null ? null : theme.includes("light") ? "#005fb8" : "#3794ff";
      const saved = await page.evaluate(({ theme, progress, focus, neutral, foreground, link }) => {
        const root = document.documentElement;
        const names = ['--vscode-progressBar-background', '--vscode-focusBorder', '--vscode-descriptionForeground', '--vscode-foreground', '--vscode-textLink-foreground'];
        const saved = names.map(name => [name, root.style.getPropertyValue(name)]);
        document.body.className = theme;
        names.forEach((name, i) => {
          const value = [progress, focus, neutral, foreground, link][i];
          // `initial` makes the variable invalid even when the fixture stylesheet defines it, so the CSS fallback is exercised.
          root.style.setProperty(name, value === null ? 'initial' : value);
        });
        return saved;
      }, { theme, progress, focus, neutral, foreground, link });
      try {
        const colors = await page.locator('#run-status').evaluate(el => {
          const probe = document.createElement('span');
          probe.style.background = 'var(--vscode-descriptionForeground)';
          el.append(probe);
          const colors = {
            pulse: getComputedStyle(el.querySelector('.run-status-toggle .run-status-pulse')).backgroundColor,
            neutral: getComputedStyle(probe).backgroundColor,
            copy: getComputedStyle(document.querySelector('#agent-progress .run-status-copy')).color,
            label: getComputedStyle(document.querySelector('#agent-progress .run-status-label')).color,
            meta: getComputedStyle(document.querySelector('#agent-progress .run-status-meta')).color,
            loadingPulse: getComputedStyle(document.querySelector('#agent-progress .run-status-pulse')).backgroundColor,
          };
          probe.remove();
          return colors;
        });
        const textColor = link === null ? 'rgb(0, 128, 232)' : theme.includes("light") ? 'rgb(0, 95, 184)' : 'rgb(55, 148, 255)';
        // The header dot shares the link blue of the rows' running dot; the progress bar colour is only a fallback.
        assert.equal(colors.pulse, running ? (link === null ? expected : textColor) : colors.neutral, theme + ' dot reflects execution state');
        assert.deepEqual([colors.loadingPulse, colors.copy, colors.label, colors.meta],
          [textColor, textColor, textColor, textColor], theme + ' loading dot, text and elapsed time stay blue');
      } finally {
        await page.evaluate(saved => saved.forEach(([name, value]) => value ? document.documentElement.style.setProperty(name, value) : document.documentElement.style.removeProperty(name)), saved);
        await page.locator('body').evaluate((el, value) => value === null ? el.removeAttribute('class') : el.setAttribute('class', value), originalClass);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await pulse.evaluate(el => getComputedStyle(el).animationName), 'none');
    if (running) assert.equal(await page.locator('#run-status-label').evaluate(el => getComputedStyle(el).color),
      await page.locator('#agent-progress .run-status-pulse').evaluate(el => getComputedStyle(el).backgroundColor), 'Reduced motion preserves the loading colour');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  };
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'flow', role: 'main', runtimeAvailable: true,
    agentModels: { work: { model: 'gpt-expert', reasoningEffort: 'high' }, workLight: { model: 'gpt-worker', reasoningEffort: 'low' } },
    capabilities: { submit: {}, send: {} } }, '*'));
  const setAgents = async status => {
    await page.evaluate(status => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'work-one', runId: 'run-one', role: 'work', status }] }, '*'), status);
  };
  for (const status of ['completed', 'failed', 'cancelled']) {
    await setAgents(status);
    await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
    assert.equal(await page.locator('#run-status').isVisible(), true, 'Empty workflow status stays available');
  }
  assert.equal(await page.locator('#task-history-list .run-stage-id').textContent(), 'Task name not recorded');
  for (const status of ['queued', 'running', 'needs-human-decision']) {
    await setAgents(status);
    await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
    assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
  }
  await setAgents('running');
  assert.equal(await page.locator('#run-details').isVisible(), false, 'Runtime sessions alone cannot fabricate a task list');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 0);
  const flow = { id: 'flow-one', title: '화면 개선 작업', tasks: [
    { id: 'layout', title: '화면 수정', status: 'pending' },
    { id: 'behavior', title: '동작 연결', description: '클릭 시 작업을 요청하고 결과를 표시합니다.', status: 'running', agentId: 'work-one', runId: 'run-one' },
    { id: 'test', title: '테스트', status: 'pending' }
  ] };
  const send = async (snapshot, runId) => {
    const before = await page.locator("#timeline .message-assistant").count();
    await page.evaluate(({ snapshot, runId }) => window.postMessage({ type: 'chat.assistant', phase: 'commentary', runId,
      text: '정리한 작업입니다.\n```task-flow\n' + JSON.stringify(snapshot) + '\n```' }, '*'), { snapshot, runId });
    await page.waitForFunction(count => document.querySelectorAll("#timeline .message-assistant").length > count, before);
    await page.waitForFunction(id => document.querySelector('#timeline .task-flow[data-flow-id="' + id + '"]'), snapshot.id);
  };
  await send(flow, 'main-one');
  assert.equal(await page.locator('#timeline .task-flow').count(), 1);
  assert.equal(await page.locator('#timeline code.language-task-flow').count(), 0);
  assert.equal(await page.locator('#run-status').isVisible(), true);
  assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'true');
  await checkHeaderPulse(true);
  const panel = page.locator('#run-stage-list .task-flow[data-flow-id="flow-one"]');
  assert.deepEqual(await panel.locator('.task-flow-name').allTextContents(), ['화면 수정', '동작 연결', '테스트']);
  assert.deepEqual(await panel.locator('.task-flow-name').evaluateAll(items => items.map(item => item.title)),
    ['화면 수정', '동작 연결', '테스트'], 'A clipped task title remains available on hover');
  const originalViewport = page.viewportSize();
  for (const width of [800, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await panel.locator('.task-flow-step').evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }));
    assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y, 'Tasks form a vertical list');
    assert.ok(boxes.every(box => Math.abs(box.x - boxes[0].x) < 1), 'Task rows share one left edge');
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'The task list uses its panel width without horizontal overflow');
    const tracks = await panel.locator('summary.task-flow-row').evaluateAll(rows => rows.map(row =>
      ['.task-flow-name', '.task-flow-agent', '.task-flow-model', '.task-flow-state'].map(selector => row.querySelector(selector).getBoundingClientRect().x)));
    assert.ok(tracks.every(cells => cells.every((x, i) => Math.abs(x - tracks[0][i]) < 1)), 'Multi-task rows use shared identity columns');
    assert.equal(await panel.locator('.task-flow-disclosure[open]').count(), 0, 'Task details start collapsed');
    assert.ok((await panel.locator('.task-flow-state').evaluateAll(items => items.map(item => item.getBoundingClientRect().width))).every(width => width > 0),
      'Every compact row keeps its status visible');
    assert.deepEqual(await panel.locator('.task-flow-disclosure > summary').evaluateAll(rows => rows.map(row =>
      Array.from(row.children).slice(0, 4).map(child => child.className))),
      Array(3).fill(['task-flow-name', 'task-flow-assignment task-flow-agent', 'task-flow-model', 'task-flow-state']),
      'Every row reads task, assigned role, captured model, then status');
  }
  await page.setViewportSize(originalViewport);
  await page.evaluate(() => { document.getElementById('companion-dock').hidden = false; });
  assert.equal(await page.locator('.composer-status-column').evaluate(el => getComputedStyle(el).paddingRight), '0px',
    'Companion clearance must not narrow the task panel');
  const [detailsWidth, columnWidth] = await Promise.all([
    page.locator('#run-details').evaluate(el => el.getBoundingClientRect().width),
    page.locator('.composer-status-column').evaluate(el => el.getBoundingClientRect().width)
  ]);
  assert.ok(Math.abs(detailsWidth - columnWidth) < 1, 'Expanded task details use the full status-column width');
  await page.evaluate(() => { document.getElementById('companion-dock').hidden = true; });
  const active = panel.locator('[data-task-id="behavior"]');
  const stationary = panel.locator('[data-task-id="test"]');
  assert.equal(await active.getAttribute('aria-current'), 'step');
  assert.equal(await active.getAttribute('data-worker-active'), 'true');
  const [activeColor, stationaryColor] = await Promise.all([
    active.locator('.task-flow-state > .run-status-pulse').evaluate(el => getComputedStyle(el).backgroundColor),
    stationary.locator('.task-flow-state').evaluate(el => getComputedStyle(el, '::before').backgroundColor)
  ]);
  assert.notEqual(activeColor, stationaryColor, 'Active workflow state uses the theme accent');
  // The running row's dot animates exactly like the header's dot; a stationary row keeps its plain dot.
  assert.deepEqual(await active.locator('.task-flow-state > .run-status-pulse').evaluate(el => [getComputedStyle(el).animationName,
    getComputedStyle(el, '::before').animationName, getComputedStyle(el, '::after').animationName, el.getAttribute('aria-hidden'),
    getComputedStyle(el.parentElement, '::before').display]),
    ['run-status-dot-breathe', 'run-status-dot-ripple', 'run-status-dot-ripple', 'true', 'none'], 'Running row dot breathes and radiates rings');
  assert.equal(await stationary.locator('.task-flow-state > .run-status-pulse').count(), 0, 'Stationary row dot does not animate');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await active.locator('.task-flow-state > .run-status-pulse').evaluate(el => [getComputedStyle(el).animationName,
    getComputedStyle(el, '::before').content]), ['none', 'none'], 'Reduced motion stills the running row dot');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('#timeline [data-task-id="behavior"] .task-flow-state').evaluate(el => {
    const probe = document.createElement('span'); probe.style.color = 'var(--vscode-descriptionForeground)'; el.append(probe);
    const neutral = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(el).color === neutral;
  }), true, 'A historical snapshot remains visually inactive');
  const activeDisclosure = active.locator('.task-flow-disclosure');
  await activeDisclosure.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await activeDisclosure.getAttribute('open'), '');
  assert.equal(await active.locator('.task-flow-description div').textContent(), '클릭 시 작업을 요청하고 결과를 표시합니다.');
  assert.equal(await active.evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep');
  assert.equal(await stationary.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await active.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'work-one', runId: 'run-one', role: 'work', status: 'needs-human-decision' }] }, '*'));
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-task-id="behavior"]').dataset.status === 'blocked');
  assert.equal(await activeDisclosure.getAttribute('open'), '', 'Expanded state survives a live status update');
  assert.equal(await active.evaluate(el => getComputedStyle(el).animationName), 'none');
  await checkHeaderPulse(false);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').classList.contains('is-running'));
  await checkHeaderPulse(false);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').classList.contains('is-running'));
  await checkHeaderPulse(false);
  flow.tasks[0].status = 'completed';
  flow.tasks[1].status = 'completed';
  flow.tasks[2].status = 'verifying';
  await send(flow, 'main-two');
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-task-id="test"]').dataset.status === 'verifying');
  assert.equal(await page.locator('#run-stage-list :is([data-task-id="layout"], [data-task-id="behavior"])').count(), 2,
    'Completed stages remain in their active workflow while Verification is still running');
  assert.equal(await page.locator('#task-history-list [data-flow-id="flow-one"] :is([data-task-id="layout"], [data-task-id="behavior"])').count(), 2, 'Completed tasks are kept in Task history');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 1, 'Update the same workflow instead of appending a duplicate');
  assert.equal(await page.locator('#timeline .task-flow').count(), 2, 'Conversation retains the earlier snapshot');
  assert.ok(await page.evaluate(() => window.saved.timeline.some(entry => entry.text?.includes('flow-one'))));
  for (const status of ['failed', 'blocked', 'cancelled', 'completed']) {
    flow.tasks[2].status = status;
    await send(flow, 'main-' + status);
    const container = status === 'blocked' ? '#run-stage-list' : '#task-history-list';
    await page.waitForFunction(({ container, status }) => document.querySelector(container + ' [data-task-id="test"]')?.dataset.status === status, { container, status });
    assert.equal(await page.locator(container + ' [data-task-id="test"]').evaluate(el => getComputedStyle(el).animationName), 'none');
    await checkHeaderPulse(false);
    assert.equal(await page.locator('#run-stage-list [data-flow-id="flow-one"]').count(), status === 'blocked' ? 1 : 0,
      'Only an unfinished task keeps its workflow in the task list');
  }
  const malicious = { ...flow, id: 'unsafe-title', title: '<img src=x onerror=alert(1)>', tasks: [{ id: 'one', title: '<script>bad()</script>', status: 'pending', agentId: 'work-one', runId: 'run-one' }] };
  await send(malicious, 'main-safe');
  assert.equal(await page.locator('.task-flow img, .task-flow script').count(), 0);
  await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', runId: 'invalid', text: '```task-flow\n{"id":"broken","tasks":null}\n```' }, '*'));
  await page.waitForFunction(() => document.querySelector('#timeline code.language-task-flow'));
  assert.equal(await page.locator('[data-flow-id="broken"]').count(), 0);
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.locator('#run-stage-list .task-flow').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="flow-one"]'));
  assert.equal(await page.locator('#task-history-list [data-flow-id="flow-one"] .task-flow-step').count(), 3);
  assert.equal(await page.locator('#task-history-list [data-task-id="test"]').getAttribute('data-status'), 'completed');
  malicious.tasks[0].status = 'completed';
  await send(malicious, 'main-all-completed');
  await setAgents('completed');
  await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-details').isVisible(), true);
  assert.ok(await page.locator('#timeline .task-flow').count() > 0, 'Completed history remains available in chat');
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#timeline .task-flow'));
  assert.equal(await page.locator('#run-status').isVisible(), true, 'Completed history keeps workflow controls available');
  const draft = { id: 'draft-only', title: 'Unsubmitted plan', tasks: [{ id: 'draft-task', title: 'Prepare change', status: 'pending' }] };
  await send(draft, 'draft-main');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="draft-only"]').count(), 0, 'A planned list alone is not a submitted workflow');
  assert.equal(await page.locator('#task-history-list [data-flow-id="draft-only"]').count(), 0);
  assert.equal(await page.locator('#timeline [data-flow-id="draft-only"]').count(), 1);
  draft.tasks[0].agentId = 'new-work';
  draft.tasks[0].runId = 'new-run';
  await send(draft, 'draft-bound');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="draft-only"]').count(), 0, 'Identifiers alone do not prove acceptance');
  await page.evaluate(() => { const el = document.querySelector('#timeline'); el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('#auto-scroll-state').dataset.state === 'following');
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'new-work', runId: 'new-run', role: 'work', status: 'accepted' }] }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-details').hidden);
  await checkHeaderPulse(false);
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
  assert.equal(await submitted.locator('.task-flow-single-title').textContent(), '하단 스크롤 수정');
  await submitted.locator('summary').click();
  assert.match(await submitted.locator('.task-flow-description div').textContent(), /작업 현황을 펼치면 하단을 유지합니다/);
  assert.match(await submitted.locator('.task-flow-description div').textContent(), /접기와 펼치기 검사를 통과합니다/);
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'bound-work', runId: 'bound-run', role: 'work', status: 'completed', taskBinding: {
    workflowId: 'runtime-contract', workflowTitle: '실제 제출한 작업', taskId: 'scroll-fix', title: '하단 스크롤 수정',
    description: '작업 현황을 펼치면 하단을 유지합니다.', completionCriteria: '접기와 펼치기 검사를 통과합니다.'
  } }], workflows: [] }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="runtime-contract"] .task-flow-single')?.dataset.status === 'completed');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="runtime-contract"]').count(), 0, 'A completed task leaves the task list');
  assert.equal(await page.locator('#task-history-list [data-flow-id="runtime-contract"] .task-flow-single-title').textContent(), '하단 스크롤 수정');
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="runtime-contract"]'));
  assert.equal(await page.locator('#run-status').isVisible(), true, 'Workflow controls remain available for ended runs');
  // Select the locale explicitly before checking translated summaries.
  if (!await page.locator('#status-settings').isVisible()) await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#status-settings-button').click();
  const single = { kind: 'work-verification-loop', loopId: 'loop-single', workAgentId: 'single-expert', taskMode: 'work', status: 'active',
    workflow: { id: 'single-flow', title: 'Site accessibility and SEO review', tasks: [
      { id: 'single-task', title: 'Site accessibility and SEO review', description: 'Review the site.', workAgentId: 'single-expert',
        workRunId: 'single-run', workStatus: 'running', verificationStatus: 'pending' }
    ] } };
  await page.evaluate(single => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'running', model: 'gpt-expert', reasoningEffort: 'high' }
  ], workflows: [single] }, '*'), single);
  const singleCard = page.locator('#run-stage-list [data-flow-id="single-flow"] .task-flow-single');
  await singleCard.waitFor();
  assert.equal(await singleCard.getAttribute('data-worker-active'), 'true');
  assert.equal(await singleCard.evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep');
  assert.equal(await singleCard.locator('.task-flow-single-title').textContent(), single.workflow.title);
  assert.equal((await singleCard.textContent()).split(single.workflow.title).length - 1, 1, 'The single task title appears once in its card');
  assert.equal(await singleCard.locator('.task-flow-state').textContent(), '진행 중');
  // No recorded profile: neither badge is marked and the card says so, although the model matches the Expert setting.
  const unrecorded = ['역할 미제공'];
  assert.deepEqual(await singleCard.locator('.task-flow-assignment').allTextContents(), unrecorded);
  assert.equal(await singleCard.locator('.task-flow-assignment[data-assigned="true"]').count(), 0);
  await singleCard.locator(':scope > summary').click();
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '기록 없음 · 세션 열기');
  await page.evaluate(single => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'running', model: 'gpt-worker', reasoningEffort: 'low', workProfile: 'workLight' }
  ], workflows: [single] }, '*'), single);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="single-flow"] .task-flow-assignment')?.textContent === '작업자');
  assert.deepEqual(await singleCard.locator('.task-flow-assignment').allTextContents(), ['작업자']);
  assert.equal(await singleCard.getAttribute('open'), '', 'The single card stays expanded when assignment data refreshes');
  // Only the record decides: these settings match the other profile each time.
  const assignment = async (agent, snapshot, first) => {
    await page.evaluate(({ agent, snapshot }) => window.postMessage({ type: 'agents.list', agents: [
      { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'running', ...agent }
    ], workflows: [snapshot] }, '*'), { agent, snapshot });
    await page.waitForFunction(first => document.querySelector('[data-flow-id="single-flow"] .task-flow-assignment')?.textContent === first, first);
    return singleCard.locator('.task-flow-assignment').allTextContents();
  };
  assert.deepEqual(await assignment({ model: 'gpt-worker', reasoningEffort: 'low', workProfile: 'work' }, single, '전문가'), ['전문가']);
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '전문가 세션 열기');
  assert.deepEqual(await assignment({ model: 'gpt-expert', reasoningEffort: 'high', workProfile: 'workLight' }, single, '작업자'), ['작업자']);
  assert.deepEqual(await assignment({ model: 'gpt-worker', reasoningEffort: 'low' }, single, '역할 미제공'), unrecorded,
    'An unrecorded run is never inferred from model settings');
  assert.equal(await singleCard.locator('.task-flow-assignment[data-unrecorded="true"]').textContent(), '역할 미제공');
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '기록 없음 · 세션 열기');
  assert.deepEqual(await assignment({ model: 'gpt-expert', reasoningEffort: 'high' }, { ...single, workProfile: 'workLight' }, '작업자'), ['작업자'],
    'The loop record applies when the run carries none');
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '작업자 세션 열기');
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await singleCard.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'The compact card fits a narrow viewport');
  await page.setViewportSize({ width: 900, height: 800 });
  single.status = 'completed';
  single.workflow.tasks[0].workStatus = 'completed';
  await page.evaluate(single => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'completed', model: 'gpt-worker', reasoningEffort: 'low' }
  ], workflows: [single] }, '*'), single);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="single-flow"] .task-flow-single')?.dataset.status === 'completed');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="single-flow"]').count(), 0, 'A completed single task leaves the task list');
  const engine = { kind: 'work-verification-loop', loopId: 'loop-engine', workAgentId: 'engine-worker', verificationAgentId: 'engine-verifier', workProfile: 'work', taskMode: 'work-verification', status: 'active',
    workflow: { id: 'engine-flow', title: '전체 작업 흐름', tasks: [
      { id: 'first', workRunId: 'work-first', title: '첫 번째 수정', description: '첫 요청', completionCriteria: '검사 통과', workStatus: 'running', verificationStatus: 'pending' },
      { id: 'second', title: '두 번째 수정', description: '다음 요청', completionCriteria: '검사 통과', workStatus: 'pending', verificationStatus: 'pending' }
    ] } };
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  const graph = page.locator('#run-stage-list [data-flow-id="engine-flow"]');
  await graph.waitFor();
  // Each task is one row: Work and Verification share it in their own columns from the start.
  assert.equal(await graph.locator('.task-flow-step').count(), 2, 'Each task appears once with its work and verification columns');
  assert.deepEqual(await graph.locator('.task-flow-agent').evaluateAll(tags => tags.map(tag => tag.dataset.stage)), ['work', 'verification', 'work', 'verification'],
    'Every task row shows its worker and verifier columns immediately');
  assert.equal(await graph.locator('.task-flow-total').textContent(), '작업 2개', 'Verification stages do not increase the task count');
  // The header carries the title and counts, so the panel has no separate heading row.
  assert.equal(await page.locator('#run-details .run-details-heading, #run-details-summary').count(), 0, 'The panel has no separate heading row');
  assert.match(await page.locator('#run-status-agents').textContent(), /작업 2개$/, 'Header counts only in-progress tasks, not the completed single task');
  assert.match(await page.locator('#run-status-toggle').getAttribute('aria-label'), /^작업 흐름 · .*작업 2개$/, 'Header accessible name carries the counts');
  assert.deepEqual(await graph.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(), ['작업자 미배정', '전문가 1명'],
    'The recorded Expert profile labels the multi-task card without counting Verification');
  assert.equal(await graph.locator('[data-summary-status="running"]').textContent(), '진행 중 1개');
  assert.equal(await graph.locator('[data-summary-status="pending"]').textContent(), '대기 1개');
  assert.deepEqual(await graph.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.status)), ['running', 'pending']);
  const firstStage = graph.locator('.task-flow-step').first();
  assert.equal(await graph.locator('.task-flow-open').count(), 1, 'Unstarted stages have no session link');
  await firstStage.locator('.task-flow-disclosure > summary').click();
  assert.equal(await firstStage.locator('.task-flow-open').textContent(), '전문가 세션 열기');
  await firstStage.locator('.task-flow-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker', runId: 'work-first' });

  assert.equal(await firstStage.getAttribute('data-worker-active'), 'false');
  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'none', 'Workflow status alone does not imply worker activity');
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'engine-worker', runId: 'work-first', role: 'work', status: 'running' }
  ], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="engine-flow"] [data-task-id="first"]')?.dataset.workerActive === 'true');
  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep', 'The exact running worker animates its stage');
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
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'engine-verifier', runId: 'verify-first', role: 'verification', status: 'running' }
  ], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="engine-flow"] [data-status="verifying"]'));
  assert.equal(await graph.locator('[data-summary-status="verifying"]').textContent(), '검증 중 1개');
  await checkHeaderPulse(true);
  assert.equal(await graph.locator('[data-summary-status="completed"]').count(), 0, 'Work completion alone is not whole-task completion; hide zero counts');
  assert.equal(await graph.locator('.task-flow-current').textContent(), '현재 수행 작업: 첫 번째 수정 (검증 중)');
  assert.equal(await graph.locator('[aria-current="step"]').count(), 1);
  await graph.locator('[data-status="verifying"] .task-flow-disclosure').evaluate(el => { el.open = true; });
  await graph.locator('[data-status="verifying"] .task-flow-open[title="engine-verifier"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-verifier', runId: 'verify-first' });

  assert.equal(await graph.locator('[data-status="verifying"]').evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep');
  // The row stays; the loading scan moves from the finished Work model to the running Verification model.
  assert.deepEqual(await firstStage.locator('.task-flow-model').evaluateAll(models => models.map(model => [model.dataset.stage, model.dataset.running])),
    [['work', 'false'], ['verification', 'true']], 'Completed stage stops animating');

  assert.equal(await graph.locator('.task-flow-step').count(), 2);
  engine.workflow.tasks[0].verificationStatus = 'completed';
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="engine-flow"] [data-task-id="first"]')?.dataset.status === 'completed');
  assert.equal(await graph.locator('.task-flow-step').count(), 2,
    'A completed stage remains detailed while a later stage keeps its workflow active');
  assert.equal(await graph.locator('[data-summary-status="completed"]').textContent(), '완료 1개');
  assert.match(await page.locator('#run-status-agents').textContent(), /작업 2개$/,
    'The active-workflow header counts all logical tasks, including completed stages');
  for (const status of ['completed', 'failed', 'cancelled', 'runtime-error']) {
    const ended = { ...engine, status };
    await page.evaluate(snapshot => window.postMessage({ type: 'agents.list', agents: [], workflows: [snapshot] }, '*'), ended);
    await page.waitForFunction(() => !document.querySelector('#run-stage-list [data-flow-id="engine-flow"]'));
    assert.equal(await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-step').count(), 2,
      `${status} workflows retain their pending stage snapshots in Task history`);
    assert.doesNotMatch(await page.locator('#run-status-agents').textContent(), /작업 2개/,
      'Terminal workflows are excluded from the active task count');
  }
  // A reconnect with an active snapshot restores the whole workflow, including its completed stage.
  await page.evaluate(snapshot => window.postMessage({ type: 'agents.list', agents: [], workflows: [snapshot] }, '*'), engine);
  await graph.waitFor();
  assert.equal(await graph.locator('.task-flow-step').count(), 2);
  if (panelOnly) return;
  engine.workflow.tasks[1].workAgentId = 'second-worker';
  engine.workflow.tasks[1].verificationAgentId = 'second-verifier';
  engine.workflow.tasks[1].workRunId = 'work-second';
  engine.workflow.tasks[1].verificationRunId = 'verify-second';
  engine.status = 'completed';
  for (const task of engine.workflow.tasks) { task.workStatus = 'completed'; task.verificationStatus = 'completed'; }
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="engine-flow"]'));
  assert.equal(await graph.count(), 0, 'A completed graph leaves the in-progress panel for Task history');
  await page.setViewportSize({ width: 900, height: 800 });
  const sentBeforeHistory = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length);
  assert.equal(await page.locator('#submission-menu #task-history').count(), 0);
  assert.equal(await page.locator('#task-history > summary').isVisible(), true);
  await page.locator('#task-history > summary').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#task-history-list').classList.contains('is-flyout'));
  for (const width of [320, 465, 721, 900]) {
    await page.setViewportSize({ width, height: 556 });
    await page.waitForTimeout(100);
    const compact = await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact'));
    if (compact && !await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-open'))) await page.locator('#workflow-history-toggle').click();
    if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
    await page.waitForFunction(() => document.querySelector('#task-history-list').style.width === Math.min(440, innerWidth - 16) + 'px');
    const bounds = await page.locator('#task-history-list').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 556, JSON.stringify(bounds));
    // Both tabs share one frame: switching to contracts neither moves nor resizes the list.
    await page.locator('#history-tab-contracts').click();
    assert.deepEqual(Object.values(await page.locator('#task-history-list').boundingBox()).map(Math.round), Object.values(bounds).map(Math.round), 'Contracts and task history share one frame');
    await page.locator('#history-tab-tasks').click();
    const toggle = await page.locator('#run-status-toggle').boundingBox();
    const actions = await page.locator('#workflow-history').boundingBox();
    assert.ok(toggle.x + toggle.width <= actions.x + 1, 'Workflow and history do not overlap');
    assert.ok(Math.abs(toggle.y - actions.y) < 2, 'Actions remain on the workflow line');
    if (process.env.AF_HISTORY_ARTIFACT_DIR) await page.screenshot({path: require('node:path').join(process.env.AF_HISTORY_ARTIFACT_DIR, 'history-' + width + '.png')});
  }
  await page.setViewportSize({width: 900, height: 800});
  await page.locator('#task-history > summary').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#task-history-list').isVisible(), false);
  await page.locator('#task-history > summary').click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length), sentBeforeHistory);
  const historyEntry = page.locator('.task-history-disclosure[data-history-id="engine-flow"]');
  assert.equal(await historyEntry.count(), 1, 'One history row represents the whole workflow');
  // Opening history asks for the project's briefs; other conversations' briefs join read-only, this one's stay local.
  assert.ok(await page.evaluate(() => window.sentMessages.some(message => message.type === 'project.tasks.request')));
  await page.evaluate(() => window.postMessage({ type: 'project.tasks', entries: [
    { id: 'brief-other', title: 'Other conversation brief', status: 'completed', mainAgentId: 'main-other', contract: { id: 'WC-9', version: 2 },
      tasks: [{ id: 'task-a', title: 'Task A', description: 'Requested change', workStatus: 'completed' }] },
    { id: 'engine-flow', title: 'Duplicate of a local flow', status: 'completed', mainAgentId: 'main-other', tasks: [] }] }, '*'));
  const projectEntry = page.locator('#task-history-panel .project-history-entry[data-history-id="brief-other"]');
  await projectEntry.waitFor();
  assert.equal(await projectEntry.locator('.task-history-count').textContent(), 'WC-9 v2');
  assert.equal(await projectEntry.locator('.task-history-state').getAttribute('data-status'), 'completed', 'Status uses the panel\'s dot, not the label');
  assert.equal(await page.locator('#task-history-panel .project-history-entry').count(), 1, 'A local flow is not repeated from project records');
  assert.equal(await historyEntry.count(), 1);
  assert.equal(await historyEntry.locator('.task-history-disclosure').count(), 0, 'Individual stages are not history entries');
  assert.equal(await historyEntry.locator('.task-flow').isVisible(), false, 'History details start collapsed');
  await historyEntry.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await historyEntry.locator('.task-flow').isVisible(), true);
  assert.equal(await historyEntry.locator('.task-flow-list').evaluate(el => getComputedStyle(el).gridAutoFlow), 'row', 'Expanded history uses the task panel row list');
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-disclosure').first().locator(':scope > summary').click();
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open').first().click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker', runId: 'work-first' });

  const historyButtons = page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open');
  // The second task's one row opens both of its sessions.
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-disclosure').nth(1).locator(':scope > summary').click();
  await historyButtons.nth(2).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-worker', runId: 'work-second' });
  await historyButtons.nth(3).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-verifier', runId: 'verify-second' });
  await page.locator('#task-history > summary').click();
  assert.equal(await page.locator('#task-history-list').isVisible(), false);

  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'named-work', runId: 'named-run', role: 'work', status: 'completed', taskBinding: { title: '링크 검사 JSON 출력 추가' } },
    { agentId: 'named-verifier', runId: 'verify-run', role: 'verification', status: 'completed', taskBinding: { title: '링크 검사 JSON 출력 추가' } }
  ], workflows: [] }, '*'));
  await page.waitForFunction(() => document.querySelector('#task-history-list .run-stage-id')?.textContent === '링크 검사 JSON 출력 추가');
  assert.deepEqual(await page.locator('#task-history-list .run-stage-id').allTextContents(), ['링크 검사 JSON 출력 추가', '링크 검사 JSON 출력 추가']);
  assert.deepEqual(await page.locator('#agents-list .agent-id').allTextContents(), ['링크 검사 JSON 출력 추가', '링크 검사 JSON 출력 추가']);
  assert.match(await page.locator('#task-history-list .run-stage').first().getAttribute('title'), /named-work/);
  const mixed = { kind: 'work-verification-loop', loopId: 'loop-mixed', workAgentId: 'expert-one',
    taskMode: 'work', status: 'active', workflow: { id: 'mixed-flow', title: '역할 혼합 작업', index: 0, tasks: [
      { id: 'expert-task', title: '전문가 작업', workAgentId: 'expert-one', workRunId: 'expert-run', workStatus: 'running', verificationStatus: 'pending' },
      { id: 'worker-task', title: '작업자 작업', workAgentId: 'worker-one', workRunId: 'worker-run', workStatus: 'pending', verificationStatus: 'pending' }
    ] } };
  await page.evaluate(mixed => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'expert-one', runId: 'expert-run', role: 'work', status: 'running', workProfile: 'work' },
    { agentId: 'worker-one', runId: 'worker-run', role: 'work', status: 'accepted', workProfile: 'workLight' }
  ], workflows: [mixed] }, '*'), mixed);
  const mixedFlow = page.locator('#run-stage-list [data-flow-id="mixed-flow"]');
  await mixedFlow.waitFor();
  assert.deepEqual(await mixedFlow.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(),
    ['작업자 1명', '전문가 1명'], 'A multi-task card can report both recorded profiles');
  await mixedFlow.locator('[data-task-id="expert-task"] .task-flow-disclosure > summary').click();
  await mixedFlow.locator('[data-task-id="worker-task"] .task-flow-disclosure > summary').click();
  assert.deepEqual(await mixedFlow.locator('.task-flow-open').allTextContents(), ['전문가 세션 열기', '작업자 세션 열기']);
  const six = { kind: 'work-verification-loop', loopId: 'loop-six', workAgentId: 'shared-worker',
    taskMode: 'work', status: 'active', workflow: { id: 'six-flow', title: '같은 작업자의 여섯 작업', index: 1,
      tasks: Array.from({ length: 6 }, (_, index) => ({ id: 'task-' + (index + 1), title: '작업 ' + (index + 1),
        description: '작업별 요청', completionCriteria: '작업별 완료 기준', workAgentId: 'shared-worker',
        workStatus: index === 0 ? 'completed' : index === 1 ? 'running' : 'pending',
        ...(index < 2 ? { workRunId: 'shared-run-' + (index + 1) } : {}) })) } };
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  // An active workflow retains all six stages, including the completed first task.
  const sixSteps = page.locator('#run-stage-list [data-flow-id="six-flow"] .task-flow-step');
  const sixHistory = page.locator('#task-history-list [data-flow-id="six-flow"]');
  await page.waitForFunction(() => document.querySelectorAll('#run-stage-list [data-flow-id="six-flow"] .task-flow-step').length === 6);
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.taskId)),
    ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']);
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.runId || null)),
    ['shared-run-1', 'shared-run-2', null, null, null, null]);
  assert.equal(await sixHistory.locator('[data-task-id="task-1"]').getAttribute('data-status'), 'completed', 'The completed task is also available in Task history');
  assert.equal(await page.locator('[data-flow-id="six-flow"] [aria-current="step"]').count(), 1);
  const sixFlow = page.locator('#run-stage-list [data-flow-id="six-flow"]');
  assert.equal(await sixFlow.locator('.task-flow-disclosure[open]').count(), 0, 'Multiple tasks remain compact by default');
  assert.equal(await sixFlow.locator('.task-flow-list').evaluate(el => getComputedStyle(el).gridAutoFlow), 'row');
  assert.equal(await sixFlow.locator('.task-flow-total').textContent(), '작업 6개');
  assert.deepEqual(await sixFlow.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(),
    ['작업자 미배정', '전문가 미배정', '기록 없음 1명']);
  assert.equal(await sixFlow.locator('[data-summary-status="pending"]').textContent(), '대기 4개');
  assert.equal(await sixFlow.locator('[data-summary-status="completed"]').textContent(), '완료 1개');
  assert.equal(await sixFlow.locator('.task-flow-current').textContent(), '현재 수행 작업: 작업 2 (진행 중)');
  assert.equal(await sixFlow.locator('.task-flow-current').getAttribute('aria-live'), 'polite');
  six.status = 'runtime-error';
  six.workflow.tasks[1].workStatus = 'failed';
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="six-flow"] [data-task-id="task-2"]')?.dataset.status === 'failed');
  assert.equal(await sixFlow.count(), 0, 'A terminal workflow leaves the active list even with pending stages');
  await page.locator('#task-history > summary').click();
  await sixHistory.locator('xpath=..').locator(':scope > summary').click();
  await sixHistory.getByRole('button', { name: '실패한 작업 흐름 종료', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), {
    type: 'workflow.close', workAgentId: 'shared-worker', loopId: 'loop-six'
  });
  await page.locator('#task-history > summary').click();
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [], workflows: [] }, '*'));
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  const recordedWorkflows = await page.evaluate(() => window.saved.workflows);
  await page.reload();
  // A reopened chat receives authoritative loop records from Host; stale engine cache is not revived.
  await page.evaluate(workflows => window.postMessage({ type: 'agents.list', agents: [], workflows, workflowsComplete: true }, '*'), recordedWorkflows);
  await sixHistory.waitFor({ state: 'attached' });
  assert.equal(await sixSteps.count(), 0, 'Reload does not revive a terminal workflow from its pending stages');
  assert.deepEqual(await sixHistory.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.status)), ['completed', 'failed', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(await page.locator('[data-flow-id="six-flow"] [aria-current="step"]').count(), 0);
  assert.equal(await sixHistory.locator('[data-summary-status="failed"]').textContent(), '실패 1개');
  assert.equal(await sixHistory.locator('.task-flow-current').textContent(), '현재 수행 중인 작업 없음');
  assert.equal(await page.locator('#task-history-list [data-flow-id="engine-flow"]').count(), 1,
    'Accepted completed history survives empty discovery and reload');
  assert.deepEqual(await sixHistory.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.runId || null)), ['shared-run-1', 'shared-run-2', null, null, null, null]);
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('en');
  assert.equal(await sixHistory.locator('.task-flow-total').textContent(), '6 tasks');
  assert.deepEqual(await sixHistory.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(),
    ['Worker unassigned', 'Expert unassigned', 'No record: 1']);
  assert.equal(await sixHistory.locator('[data-summary-status="failed"]').textContent(), 'Failed: 1');
  assert.equal(await sixHistory.locator('.task-flow-current').textContent(), 'No task currently running');
  six.status = 'needs-human-decision';
  six.workflow.tasks[1].workStatus = 'blocked';
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="six-flow"] [data-summary-status="blocked"]')?.textContent === 'Blocked: 1');
  assert.equal(await sixFlow.locator('[data-summary-status="failed"]').count(), 0);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await sixFlow.locator('.task-flow-summary').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await sixSteps.count(), 6, 'A decision-required workflow returns with all its stages');
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  six.status = 'completed';
  six.workflow.index = 5;
  for (let index = 0; index < six.workflow.tasks.length; index += 1) {
    six.workflow.tasks[index].workStatus = 'completed';
    six.workflow.tasks[index].workRunId = 'shared-run-' + (index + 1);
  }
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="six-flow"]'));
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  const completedWorkflows = await page.evaluate(() => window.saved.workflows);
  await page.reload();
  await page.evaluate(workflows => window.postMessage({ type: 'agents.list', agents: [], workflows, workflowsComplete: true }, '*'), completedWorkflows);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="six-flow"]'));
  const completedSix = page.locator('#task-history-list [data-flow-id="six-flow"]');
  assert.equal(await page.locator('.task-history-entries > li > [data-history-id="six-flow"]').count(), 1,
    'A workflow with six tasks occupies exactly one top-level history row');
  assert.equal(await page.locator('[data-history-id="six-flow"] > summary .task-history-name').textContent(), six.workflow.title);
  assert.equal(await completedSix.locator('.task-flow-total').textContent(), '6 tasks');
  assert.deepEqual(await completedSix.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(),
    ['Worker unassigned', 'Expert unassigned', 'No record: 1']);
  assert.equal(await completedSix.locator('[data-summary-status="completed"]').textContent(), 'Completed: 6');
  assert.equal(await completedSix.locator('[data-summary-status="pending"]').count(), 0);
  assert.equal(await completedSix.locator('.task-flow-open').count(), 6);
  assert.deepEqual(await completedSix.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.runId)),
    Array.from({ length: 6 }, (_, index) => 'shared-run-' + (index + 1)));
  assert.equal(await page.locator('#run-stage-list [data-flow-id="six-flow"]').count(), 0,
    'Restored completed tasks stay in Task history only, without resuming execution');
  six.status = 'cancelled';
  six.workflow.tasks[1].workStatus = 'failed';
  six.workflow.tasks.slice(2).forEach(task => { task.workStatus = 'cancelled'; });
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="six-flow"] [data-summary-status="failed"]').textContent === 'Failed: 1');
  assert.equal(await completedSix.getByRole('button', { name: 'Close failed workflow', exact: true }).count(), 0);
  assert.equal(await completedSix.locator('[data-summary-status="cancelled"]').textContent(), 'Cancelled: 4');
  const layoutViewport = page.viewportSize();
  for (const size of [{width:795,height:900},{width:320,height:900},{width:360,height:900},{width:465,height:556},{width:721,height:402}]) {
    await page.setViewportSize(size);
    for (const bot of [false,true]) for (const running of [false,true]) {
      await page.evaluate(({bot,running}) => {
        window.dispatchEvent(new MessageEvent('message',{data:{type:'run.state',running}}));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'bots.updated', enabled: bot, botCharacter: 'lumi', localCompanionAvailable: true } }));
        document.querySelector('#run-status').hidden = false;
      },{bot,running});
      if (await page.locator('#run-status-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#run-status-toggle').click();
      // The companion floats at its stored point (see companion.cjs) and reserves no header or panel space.
      if (bot) await page.waitForFunction(() => !document.querySelector('#companion-dock').hidden && document.querySelector('#companion-dock').dataset.moved === 'true');
      await page.waitForTimeout(100);
      const boxes = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x:r.x,right:r.right,bottom:r.bottom,y:r.y}; };
        return {bot:box('#factory-bot'),flow:box('#run-status-toggle'),progress:box('#agent-progress'),composer:box('.composer'),history:box('#workflow-history'),feedback:document.querySelector('#agent-progress').dataset.feedback,headerWidth:document.querySelector('#run-status').style.getPropertyValue('--workflow-header-width'),dock:box('.agent-progress-dock')};
      });
      if (bot) {
        assert.ok(boxes.bot.x >= 0 && boxes.bot.right <= size.width,'Bot fits viewport');
        // The workflow header keeps the composer's right edge; the companion reserves no room beside it.
        assert.ok(Math.abs(boxes.history.right - boxes.composer.right) <= 2, 'Workflow header stays right-aligned with the composer '+JSON.stringify({size,running,boxes}));
      }
      if(running) {
        assert.ok(boxes.progress.right <= boxes.flow.x+1 || boxes.progress.bottom <= boxes.flow.y+1,'Loading stays left of or above workflow '+JSON.stringify({size,bot,running,boxes}));
        assert.ok(Math.abs(boxes.progress.x-boxes.composer.x)<=1,'Loading stays at left edge');
      }
      assert.ok(boxes.flow.x>=0 && boxes.flow.right<=size.width,'Workflow fits with and without bot');
      await page.locator('#run-status-toggle').click();
      await page.locator('#run-status-toggle').click();
      if(bot) {
        await page.locator('#factory-bot').click();
        assert.equal(await page.locator('#bot-menu').isVisible(),true);
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize(layoutViewport);
  console.log('Rightmost bot: all bot/loading combinations and interactions passed at five viewport sizes.');

}
async function checkTaskStop(page) {
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'stop', role: 'main', runtimeAvailable: true,
    capabilities: { submit: {}, send: {} } }, '*'));
  const make = (id, status = 'running') => ({ kind: 'work-verification-loop', loopId: 'loop-' + id, workAgentId: 'work-' + id,
    verificationAgentId: 'verify-' + id, taskMode: 'work-verification', status: 'active',
    workflow: { id: 'flow-' + id, title: 'Task ' + id, tasks: [{ id: 'task-' + id, title: 'Task ' + id,
      workStatus: status, verificationStatus: 'pending', workRunId: 'run-' + id }] } });
  const one = make('one'); const two = make('two'); const multi = make('multi');
  multi.workflow.tasks.push({ id: 'task-other', title: 'Other', workStatus: 'pending', verificationStatus: 'pending' });
  const publish = async workflows => page.evaluate(workflows => window.postMessage({ type: 'agents.list', agents: [], workflows }, '*'), workflows);
  await publish([one, two, multi]);
  const card = id => page.locator('#run-stage-list [data-flow-id="flow-' + id + '"]');
  const stop = id => card(id).locator('.task-flow-stop').first();
  await stop('one').waitFor();
  assert.equal(await stop('one').isEnabled(), true);
  assert.equal(await stop('multi').isDisabled(), true, 'Multi-task Loop never offers whole-engine cancellation');
  assert.match(await stop('multi').getAttribute('title'), /multi-task|여러 작업/);
  await stop('one').click();
  assert.equal(await stop('one').isDisabled(), true);
  assert.equal(await stop('two').isEnabled(), true, 'Other item remains available');
  await stop('one').evaluate(button => button.click());
  const messages = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'task.stop'));
  assert.deepEqual(messages, [{ type: 'task.stop', workflowId: 'flow-one', taskId: 'task-one', workAgentId: 'work-one', loopId: 'loop-one' }]);
  await page.evaluate(() => window.postMessage({ type: 'task.stop.result', workflowId: 'flow-one', taskId: 'task-one', error: 'fixture cancellation failed' }, '*'));
  await card('one').locator('[role="alert"]').waitFor();
  assert.equal(await stop('one').isEnabled(), true, 'Failure permits an exact-target retry');
  await stop('one').click();
  one.workflow.tasks[0].workStatus = 'completed';
  one.workflow.tasks[0].verificationStatus = 'running';
  one.workflow.tasks[0].verificationRunId = 'verify-run-one';
  await publish([one]);
  assert.equal(await stop('one').isDisabled(), true, 'Pending survives refresh and stage changes');
  await page.evaluate(() => window.postMessage({ type: 'task.stop.result', workflowId: 'flow-one', taskId: 'task-one', error: 'retry failure' }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-stage-list [data-flow-id="flow-one"] .task-flow-stop').disabled);
  assert.equal(await stop('one').isEnabled(), true, 'Verification stage can stop its engine');
  for (const status of ['pending', 'blocked']) {
    one.workflow.tasks[0].workStatus = status; one.workflow.tasks[0].verificationStatus = 'pending';
    await publish([one]);
    await page.waitForFunction(status => document.querySelector('#run-stage-list [data-flow-id="flow-one"] .task-flow-single')?.dataset.status === status, status);
    assert.equal(await stop('one').isEnabled(), true, status + ' engine task is stoppable');
  }
  for (const status of ['completed', 'failed', 'cancelled']) {
    one.status = status; one.workflow.tasks[0].workStatus = status; one.workflow.tasks[0].verificationStatus = status;
    await publish([one]);
    // An ended task leaves the in-progress list and is kept in Task history.
    await page.waitForFunction(status => document.querySelector('#task-history-list [data-flow-id="flow-one"] .task-flow-single')?.dataset.status === status, status);
    assert.equal(await card('one').count(), 0, status + ' task leaves the task list');
    assert.equal(await page.locator('#task-history-list [data-flow-id="flow-one"] .task-flow-stop').count(), 0);
  }
  assert.equal(await stop('two').isEnabled(), true);
  for (const size of [{ width: 465, height: 556 }, { width: 721, height: 402 }]) {
    await page.setViewportSize(size);
    assert.equal(await stop('two').isVisible(), true);
    assert.equal(await card('two').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  }
  // A legacy direct task sends the exact run; no Main run.cancel message is produced.
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [{ agentId: 'direct-worker', runId: 'direct-run', role: 'work', status: 'running',
    taskBinding: { workflowId: 'direct-flow', workflowTitle: 'Direct', taskId: 'direct-task', title: 'Direct', description: 'Direct' } }] }, '*'));
  const direct = page.locator('#run-stage-list [data-flow-id="direct-flow"] .task-flow-stop');
  await direct.waitFor(); await direct.click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'task.stop', workflowId: 'direct-flow', taskId: 'direct-task', agentId: 'direct-worker', runId: 'direct-run' });
  assert.equal(await page.evaluate(() => window.sentMessages.some(message => message.type === 'run.cancel')), false);
}
module.exports = { checkTaskFlow, checkTaskStop, checkWorkDecisionPlacement };

async function checkTaskDismiss(page) {
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ ...window.saved, botVisible: false })));
  await page.reload();
  const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
  await post({ type: 'host.initialize', panelId: 'delete-history', agentId: 'main-delete', role: 'main', runtimeAvailable: true });
  const workflow = { loopId: 'loop-delete', workAgentId: 'worker-delete', taskMode: 'work', status: 'completed',
    workflow: { id: 'flow-delete', title: 'Task history fixture', index: 1, tasks: [
      { id: 'selected', title: 'Selected task', workStatus: 'completed', workRunId: 'selected-run' },
      { id: 'other', title: 'Other task', workStatus: 'completed', workRunId: 'other-run' }
    ] } };
  await post({ type: 'agents.list', agents: [], workflows: [workflow] });
  if (await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact'))) await page.locator('#workflow-history-toggle').click();
  if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
  const group = page.locator('[data-history-id="flow-delete"]');
  await group.locator(':scope > summary').click();
  const selected = group.locator('[data-task-id="selected"]');
  const trash = () => selected.locator('.task-flow-dismiss');
  await trash().waitFor();
  assert.equal(await group.locator(':scope > summary > .task-flow-dismiss').count(), 0, 'No bulk deletion of a shared workflow');
  assert.match(await trash().getAttribute('aria-label'), /^Selected task · (?:Delete|삭제)$/);
  assert.equal(await trash().locator('svg[aria-hidden="true"]').count(), 1);
  assert.equal(await selected.locator('.task-flow-stop').count(), 0, 'Ended task offers trash in the stop slot');
  const originalClass = await page.locator('body').getAttribute('class');
  for (const theme of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
    await page.locator('body').evaluate((el, theme) => { el.className = theme; }, theme);
    assert.equal(await trash().isVisible(), true, theme);
    const geometry = await trash().boundingBox();
    assert.ok(geometry.width > 0 && geometry.height > 0);
  }
  await page.locator('body').evaluate((el, value) => { el.className = value || ''; }, originalClass);
  await trash().focus();
  assert.equal(await trash().evaluate(el => el === document.activeElement), true, 'Trash is keyboard accessible');
  await trash().click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'task.delete', workflowId: 'flow-delete', taskId: 'selected' });
  assert.equal(await selected.count(), 1, 'No optimistic deletion');
  assert.equal(await trash().isDisabled(), true);
  await post({ type: 'task.delete.result', mainAgentId: 'main-delete', workflowId: 'flow-delete', taskId: 'selected', error: 'Filesystem denied' });
  assert.equal(await selected.count(), 1, 'Storage failure preserves history');
  assert.equal(await trash().isDisabled(), false, 'Failure permits retry');
  await trash().click();
  await post({ type: 'task.delete.result', mainAgentId: 'main-delete', workflowId: 'flow-delete', taskId: 'selected' });
  await selected.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-task-id="other"]').count(), 1, 'Other task remains');
  const saved = await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); return window.saved; });
  assert.deepEqual(saved.workflows[0].workflow.tasks.map(task => task.id), ['other']);
  assert.equal((saved.dismissedTasks || []).length, 0, 'Storage deletion creates no UI tombstone');
  await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)), saved);
  await page.reload();
  assert.equal(await page.locator('[data-task-id="selected"]').count(), 0, 'Reload does not restore deleted history');
  await post({ type: 'host.initialize', panelId: 'delete-history', agentId: 'main-delete', role: 'main', runtimeAvailable: true });
  await post({ type: 'agents.list', agents: [], workflows: saved.workflows, workflowsComplete: true });
  assert.equal(await page.locator('[data-task-id="other"]').count(), 1);
  await post({ type: 'project.tasks', entries: [{ id: 'project-brief', mainAgentId: 'main-other', title: 'Another conversation', status: 'completed',
    tasks: [{ id: 'project-task', title: 'Project task', workStatus: 'completed' }] }] });
  if (await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact'))) await page.locator('#workflow-history-toggle').click();
  if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
  const project = page.locator('[data-history-id="project-brief"]');
  await project.locator(':scope > summary').click();
  await project.locator('.task-flow-dismiss').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'task.delete', mainAgentId: 'main-other', workflowId: 'project-brief', taskId: 'project-task' });
  await post({ type: 'task.delete.result', mainAgentId: 'main-other', workflowId: 'project-brief', taskId: 'project-task' });
  await project.waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-task-id="other"]').count(), 1, 'Project deletion keeps this conversation');
  // A closed window still has the old cache. It must wait for actual disk data.
  await page.evaluate(stale => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ ...window.saved, workflows: [stale],
    taskFlows: [null, { id: stale.workflow.id, title: stale.workflow.title, tasks: stale.workflow.tasks.map(task => ({ ...task, status: task.workStatus })), engine: true, loopId: stale.loopId }] })), workflow);
  await page.reload();
  assert.equal(await page.locator('[data-task-id="selected"]').count(), 0, 'A new window ignores stale Loop cache');
  await post({ type: 'agents.list', agents: [], workflows: [], workflowsComplete: true });
  assert.equal(await page.locator('[data-task-id="selected"]').count(), 0, 'Fresh runtime absence is authoritative');
}
module.exports.checkTaskDismiss = checkTaskDismiss;


async function checkTaskRows(page, { durationOnly = false, activityOnly = false } = {}) {
  const fs = require('node:fs'), path = require('node:path');
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'row-fixture', agentId: 'row-main', role: 'main', runtimeAvailable: true,
    agentModels: { work: { model: 'composer-expert' }, workLight: { model: 'composer-worker' } }, capabilities: { submit: {}, send: {} } }, '*'));
  const longTitle = 'Task title ' + 'with a long name '.repeat(18);
  const longModel = 'captured-model-' + 'long-provider-model-'.repeat(5);
  const make = (id, profile, model) => ({ agentId: 'agent-' + id, runId: 'run-' + id, role: 'work', status: 'running', workProfile: profile, model,
    taskBinding: { workflowId: 'row-' + id, workflowTitle: 'Task ' + id, taskId: 'task-' + id, title: id === 'worker' ? longTitle : 'Expert task', description: (id === 'worker' ? longTitle : 'Expert task') + '\nFull request' } });
  let agents = [{ ...make('worker', 'workLight', longModel), activity: 'Reading the panel code before editing', progressKey: 'flow.activity.reasoning', planProgress: { completed: 2, total: 7 } },
    make('expert', 'work', 'captured-expert'),
    { ...make('done', 'work', 'short'), status: 'completed' }];
  const publish = async (workflows = []) => page.evaluate(({ agents, workflows }) => window.postMessage({ type: 'agents.list', agents, workflows }, '*'), { agents, workflows });
  await publish();
  // Ended rows live in Task history; the others stay in the task panel.
  const row = id => page.locator(':is(#run-stage-list, #task-history-list) [data-flow-id="row-' + id + '"] .task-flow-single');
  const worker = row('worker'), expert = row('expert');
  await worker.waitFor();
  assert.equal(await worker.locator('.task-flow-agent').textContent(), 'Worker');
  assert.equal(await expert.locator('.task-flow-agent').textContent(), 'Expert');
  // Each recorded role tag has its own hue on the text and a softer tint on the border.
  const tagStyles = await Promise.all([worker, expert].map(row => row.locator('.task-flow-agent').evaluate(el =>
    ({ role: el.dataset.agentRole, color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor }))));
  assert.deepEqual(tagStyles.map(s => s.role), ['worker', 'expert'], 'Role tags record the dispatched profile');
  assert.notEqual(tagStyles[0].color, tagStyles[1].color, 'Expert and worker tags use different text colours');
  assert.notEqual(tagStyles[0].border, tagStyles[1].border, 'Expert and worker tags use different border tints');
  assert.equal(await worker.locator('.task-flow-model').textContent(), longModel);
  assert.equal(await expert.locator('.task-flow-model').textContent(), 'captured-expert');
  assert.equal(await worker.locator('.task-flow-single-title').getAttribute('title'), longTitle);
  assert.equal(await worker.locator('.task-flow-model').getAttribute('title'), longModel);
  assert.deepEqual(await worker.locator(':scope > summary').evaluate(el => Array.from(el.children).map(child => child.className)),
    ['task-flow-single-title', 'task-flow-assignment task-flow-agent', 'task-flow-model', 'task-flow-state', 'task-flow-activity', 'task-flow-progress', 'task-flow-stop-controls', 'task-flow-session']);
  // The second-line icon sits under the stop/delete action and opens this run's session.
  const iconGeometry = await worker.locator(':scope > summary').evaluate(el => {
    const action = el.querySelector('.task-flow-stop-controls').getBoundingClientRect(), icon = el.querySelector('.task-flow-session').getBoundingClientRect();
    return { below: icon.y >= action.bottom - 1, aligned: Math.abs(icon.right - action.right) < 2, size: [Math.round(icon.width), Math.round(icon.height)] };
  });
  assert.ok(iconGeometry.below && iconGeometry.aligned, 'Session icon sits under the stop/delete action ' + JSON.stringify(iconGeometry));
  assert.equal(await worker.locator('.task-flow-session svg').count(), 1);
  await worker.locator('.task-flow-session').focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'agent-worker', runId: 'run-worker' });
  assert.equal(await worker.getAttribute('open'), null, 'The icon opens the session without toggling the row');
  // Second line: the current provider phase, independent of commentary and other runs.
  assert.equal(await worker.locator('.task-flow-activity').textContent(), 'Reasoning');
  for (const [key, label] of [['ui.running.command', 'Running command'], ['ui.analyzing.results', 'Analyzing results'], ['flow.activity.reasoning', 'Reasoning']]) {
    agents[0].progressKey = key;
    await publish();
    await page.waitForFunction(label => document.querySelector('[data-flow-id="row-worker"] .task-flow-activity')?.textContent === label, label);
    assert.equal(await expert.locator('.task-flow-activity').textContent(), 'Working', 'Other runs keep their own phase');
  }
  agents[2].progressKey = 'flow.activity.reasoning';
  await publish();
  assert.equal(await row('done').locator('.task-flow-activity').textContent(), 'Completed', 'Terminal state overrides stale phases');
  assert.equal(await worker.locator('.task-flow-progress').textContent(), '2/7');
  assert.equal(await worker.locator('.task-flow-progress').getAttribute('aria-label'), '2 of 7 steps done');
  // Missing timing and to-do records stay explicitly unrecorded.
  // Without an event record, show a neutral working state.
  assert.equal(await expert.locator('.task-flow-activity').textContent(), 'Working');
  assert.equal(await expert.locator('.task-flow-progress').textContent(), '—', 'A running task without time records shows a dash');
  assert.equal(await row('done').locator('.task-flow-progress').textContent(), '—', 'A completed task without time records shows a dash');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="row-done"]').count(), 0, 'The completed row is listed in Task history only');
  if (activityOnly) {
    await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-general').click();
    await page.locator('#ui-language').selectOption('ko');
    await page.locator('#status-settings-close').click();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-worker"] .task-flow-activity')?.textContent === '추론 중');
    for (const [key, text] of [['ui.running.command', '명령 실행 중'], ['ui.analyzing.results', '결과 분석 중']]) {
      agents[0].progressKey = key;
      await publish();
      await page.waitForFunction(text => document.querySelector('[data-flow-id="row-worker"] .task-flow-activity')?.textContent === text, text);
    }
    for (const width of [1200, 465, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const bounds = await worker.locator('.task-flow-activity').evaluate(el => {
        const r = el.getBoundingClientRect(), title = el.parentElement.querySelector('.task-flow-single-title').getBoundingClientRect();
        return { below: r.y >= title.bottom - 1, inside: r.x >= 0 && r.right <= innerWidth, text: el.textContent };
      });
      assert.deepEqual(bounds, { below: true, inside: true, text: '결과 분석 중' });
      if (process.env.AF_TASK_ROW_ARTIFACT) await page.locator('#run-stage-list').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'activity-' + width + '.png') });
    }
    agents[0].status = 'needs-human-decision';
    await publish();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-worker"] .task-flow-activity')?.textContent !== '결과 분석 중');
    assert.equal(await worker.locator('.task-flow-activity').textContent(), '사용자 결정 필요');
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
    await page.reload();
    assert.equal(await worker.locator('.task-flow-activity').textContent(), '사용자 결정 필요');
    return;
  }
  const start = '2026-10-05T10:00:00.000Z';
  for (const [seconds, expected] of [[0, '0s'], [32, '32s'], [59.999, '59s'], [60, '1m'], [359, '5m'], [3599, '59m'], [3600, '1h'], [4320, '1.2h']]) {
    agents[2] = { ...agents[2], startedAt: start, finishedAt: new Date(Date.parse(start) + seconds * 1000).toISOString() };
    await publish();
    await page.waitForFunction(expected => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === expected, expected);
    assert.match(await row('done').locator('.task-flow-progress').getAttribute('title'), new RegExp('Duration: ' + seconds + 's'));
  }
  // Failure/cancellation stop at their recorded finish; malformed or absent end never grows forever.
  for (const status of ['failed', 'cancelled', 'needs-human-decision']) {
    agents[2] = { ...agents[2], status };
    await publish();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === '1.2h');
  }
  for (const finish of [undefined, 'invalid', '2026-10-05T09:00:00Z']) {
    agents[2] = { ...agents[2], status: 'completed', finishedAt: finish };
    await publish();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === '—');
  }
  agents[1] = { ...agents[1], startedAt: new Date(Date.now() - 32000).toISOString() };
  agents[2] = { ...agents[2], finishedAt: '2026-10-05T11:12:00.000Z' };
  await publish();
  await page.waitForFunction(() => document.querySelector('[data-flow-id="row-expert"] .task-flow-progress')?.textContent === '32s');
  await expert.locator('.task-flow-progress').evaluate(el => { window.durationNode = el; });
  await page.waitForFunction(() => window.durationNode.textContent !== '32s');
  assert.equal(await expert.locator('.task-flow-progress').evaluate(el => el === window.durationNode), true, 'Timer updates in place');
  assert.equal(await row('done').locator('.task-flow-progress').textContent(), '1.2h', 'Finished duration stays fixed');
  if (durationOnly) {
    await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-general').click();
    await page.locator('#ui-language').selectOption('ko');
    await page.locator('#status-settings-close').click();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === '1.2시간');
    assert.match(await row('done').locator('.task-flow-progress').getAttribute('aria-label'), /소요: 4320초/);
    for (const [seconds, expected] of [[32, '32초'], [300, '5분'], [3600, '1시간'], [4320, '1.2시간']]) {
      agents[2] = { ...agents[2], finishedAt: new Date(Date.parse(start) + seconds * 1000).toISOString() };
      await publish();
      await page.waitForFunction(expected => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === expected, expected);
    }
    // History is explicitly opened, as in the user's screenshot.
    if (await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact'))) await page.locator('#workflow-history-toggle').click();
    if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
    await page.locator('#history-tab-tasks').click();
    for (const width of [795, 441, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact') && !el.classList.contains('is-open'))) await page.locator('#workflow-history-toggle').click();
      if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
      await page.locator('#task-history-panel').waitFor({ state: 'visible' });
      const geometry = await row('done').locator(':scope > summary').evaluate(el => {
        const text = el.querySelector('.task-flow-progress'), r = text.getBoundingClientRect(), row = el.getBoundingClientRect();
        return { text: text.textContent, fits: text.scrollWidth <= text.clientWidth + 1,
          inside: r.width > 0 && r.x >= row.x && r.right <= row.right && row.right <= innerWidth,
          nowrap: getComputedStyle(text).whiteSpace === 'nowrap' };
      });
      assert.ok(geometry.fits && geometry.inside && geometry.nowrap, JSON.stringify({ width, geometry }));
      if (process.env.AF_TASK_ROW_ARTIFACT) {
        await page.locator('#task-history-panel').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'duration-ko-' + width + '.png') });
      }
    }
    // Restored exact-run records retain the frozen duration.
    await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-flow-id="row-done"] .task-flow-progress')?.textContent === '1.2시간');
    return;
  }
  const lines = await worker.locator(':scope > summary').evaluate(el => {
    const box = selector => el.querySelector(selector).getBoundingClientRect();
    const title = box('.task-flow-single-title'), activity = box('.task-flow-activity'), state = box('.task-flow-state'), steps = box('.task-flow-progress');
    const model = el.querySelector('.task-flow-model');
    return { activityBelow: activity.y >= title.bottom - 1, stepsBelow: steps.y >= state.bottom - 1,
      scan: model.dataset.running === 'true' && getComputedStyle(model).animationName };
  });
  assert.ok(lines.activityBelow && lines.stepsBelow, 'Activity and steps form the second line ' + JSON.stringify(lines));
  assert.equal(lines.scan, 'run-status-text-scan', "A running stage's model uses Main's loading scan");
  for (const [width, height] of [[1200, 900], [795, 900], [465, 556], [721, 402], [320, 800]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      document.getElementById('companion-dock').hidden = false;
      document.getElementById('factory-bot').hidden = false;
      document.getElementById('pending-queue-toggle').hidden = false;
      document.getElementById('pending-queue-label').textContent = 'Queued 1';
    });
    await page.waitForFunction(() => { const r = document.querySelector('#factory-bot').getBoundingClientRect(); return r.width > 0 && r.x >= 0 && r.right <= innerWidth; });
    const geometry = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width }; };
      return { column: rect('.composer-status-column'), panel: rect('#run-details'), bot: rect('#companion-dock'),
        header: rect('#run-status'),
        top: rect('.composer-topline'), queue: rect('#pending-queue-toggle'), composer: rect('.composer'), toggle: rect('#run-status-toggle'), rows: Array.from(document.querySelectorAll('#run-stage-list .task-flow-single')).map(el => {
          const r = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
          const buttons = Array.from(el.querySelectorAll('summary button')).map(b => b.getBoundingClientRect());
          return { right: r.right, parentRight: parent.right, overflow: el.scrollWidth > el.clientWidth + 1,
            buttonsInside: buttons.every(b => b.x >= r.x && b.right <= r.right && b.width > 0),
            overlap: buttons.some((b, i) => buttons.slice(i + 1).some(c => b.x < c.right && c.x < b.right && b.y < c.bottom && c.y < b.bottom)) };
        }) };
    });
    assert.ok(Math.abs(geometry.panel.right - geometry.column.right) <= 1, width + ' panel fills the parent with queue and bot shown');
    assert.ok(Math.abs(geometry.panel.width - geometry.column.width) <= 1);
    // The bot floats: no empty band between panel and composer, and the header keeps the right edge.
    assert.ok(geometry.composer.y - geometry.panel.bottom <= 44, width + ' no reserved gap above the composer ' + JSON.stringify([geometry.panel, geometry.composer]));
    assert.ok(Math.abs(geometry.header.right - geometry.composer.right) <= 2, width + ' header stays right-aligned ' + JSON.stringify([geometry.header, geometry.composer]));
    assert.ok(geometry.column.right <= width, width + ' header counts never widen the composer column');
    assert.ok(await page.locator('#run-status-agents').evaluate(el => getComputedStyle(el).whiteSpace === 'nowrap' && getComputedStyle(el).textOverflow === 'ellipsis'), 'Header counts truncate on one line');
    assert.ok(geometry.bot.x >= 0 && geometry.bot.right <= width, 'Absolute bot stays inside the webview');
    assert.equal(await page.locator('#companion-layer').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.ok(geometry.queue.right <= width && geometry.queue.bottom <= height, 'Queue remains inside the webview');
    assert.ok(geometry.rows.every(r => Math.abs(r.right - r.parentRight) <= 1 && !r.overflow && r.buttonsInside && !r.overlap), width + ' rows and controls fit');
    const columns = await page.locator('#run-stage-list summary.task-flow-row').evaluateAll(rows => rows.map(row =>
      ['.task-flow-single-title', '.task-flow-agent', '.task-flow-model', '.task-flow-state', '.task-flow-stop-controls'].map(selector => {
        const el = row.querySelector(selector), r = el.getBoundingClientRect();
        return { x: r.x, right: r.right, width: r.width };
      })));
    for (const cells of columns) for (const [index, cell] of cells.entries()) {
      assert.ok(Math.abs(cell.x - columns[0][index].x) < 1, width + ' shared column ' + index);
      assert.ok(cell.width > 0 && cell.right <= width, width + ' visible column ' + index);
    }
    assert.equal(await row('done').locator('.task-flow-stop').count(), 0, 'Completed row reserves the absent stop slot');
    const stopGeometry = await worker.evaluate(el => {
      const stop = el.querySelector('.task-flow-stop'), state = el.querySelector('.task-flow-state');
      const s = stop.getBoundingClientRect(), t = state.getBoundingClientRect();
      // Wide rows keep the action on the status line; narrow rows put it on the title line.
      const title = el.querySelector('.task-flow-single-title').getBoundingClientRect();
      const centre = s.y + s.height / 2;
      return { sameLine: window.innerWidth > 560 ? Math.abs(centre - (t.y + t.height / 2)) < 4 : Math.abs(centre - (title.y + title.height / 2)) < 6, text: stop.textContent, opacity: getComputedStyle(stop).opacity,
        size: [Math.round(s.width), Math.round(s.height)], dismiss: el.querySelectorAll('.task-flow-dismiss').length,
        modelWidth: el.querySelector('.task-flow-model').getBoundingClientRect().width, titleColor: getComputedStyle(el.querySelector('.task-flow-single-title')).color,
        foreground: (() => { const probe = document.createElement('span'); probe.style.color = 'var(--vscode-foreground)'; el.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })() };
    });
    assert.equal(stopGeometry.sameLine, true, width + ' stop shares the status line');
    assert.equal(stopGeometry.text, '', 'Stop is an icon without visible text');
    assert.equal(stopGeometry.opacity, '1', 'Stop stays visible on running rows');
    assert.deepEqual(stopGeometry.size, [22, 16], 'Stop keeps the shared icon button size');
    assert.equal(stopGeometry.dismiss, 0, 'Running rows never offer delete');
    assert.equal(stopGeometry.titleColor, stopGeometry.foreground, 'Running title keeps the foreground colour');
    if (width >= 795) assert.ok(stopGeometry.modelWidth <= 16 * 11 * 0.7, width + ' model column is capped');
    if (process.env.AF_TASK_ROW_ARTIFACT) {
      await page.locator('.composer-region').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'rows-' + width + '.png') });
      fs.writeFileSync(path.join(process.env.AF_TASK_ROW_ARTIFACT, 'geometry-' + width + '.json'), JSON.stringify(geometry, null, 2));
      if ([1200, 465].includes(width)) for (const [theme, vars] of [
        ['vscode-light', { '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#717171', '--vscode-editor-background': '#ffffff', '--vscode-input-background': '#ffffff', '--vscode-input-border': '#cecece' }],
        ['vscode-dark', { '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-editor-background': '#1f1f1f', '--vscode-input-background': '#313131', '--vscode-input-border': '#3c3c3c' }],
        ['vscode-high-contrast', { '--vscode-foreground': '#ffffff', '--vscode-descriptionForeground': '#ffffff', '--vscode-editor-background': '#000000', '--vscode-input-background': '#000000', '--vscode-input-border': '#6fc3df' }]]) {
        const saved = await page.evaluate(({ theme, vars }) => {
          const root = document.documentElement, saved = [document.body.className, Object.keys(vars).map(name => [name, root.style.getPropertyValue(name)])];
          document.body.className = theme;
          for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
          return saved;
        }, { theme, vars });
        await page.locator('.composer-region').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'polish-' + theme + '-' + width + '.png') });
        await page.evaluate(([className, entries]) => { document.body.className = className;
          for (const [name, value] of entries) value ? document.documentElement.style.setProperty(name, value) : document.documentElement.style.removeProperty(name); }, saved);
      }
    }
  }
  // Main's feedback has a readable row above the open header and returns to the dock when closed.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.state', running: true } })));
  await page.locator('#agent-progress').waitFor();
  const placement = () => page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, mid: r.y + r.height / 2, width: r.width }; };
    const parent = document.querySelector('#agent-progress').parentElement;
    return { parent: parent.id || parent.className, progress: box('#agent-progress'), toggle: box('#run-status-toggle'), panel: box('#run-details'), composer: box('.composer') };
  });
  for (const [width, height] of [[1200, 900], [465, 556], [320, 800]]) {
    await page.setViewportSize({ width, height });
    const open = await placement();
    assert.equal(open.parent, 'run-status', width + ' open panel hosts the indicator');
    assert.ok(open.progress.width > 0 && Math.abs(open.progress.x - open.panel.x) <= 6, width + ' indicator starts at the panel left ' + JSON.stringify(open));
    assert.ok(open.progress.bottom <= open.panel.y + 1, width + ' indicator sits above the panel body');
    assert.ok(open.progress.bottom <= open.toggle.y + 1, width + ' feedback stays above the header controls');
    assert.ok(open.progress.right <= open.panel.right + 1, width + ' feedback fits the panel width');
    if (process.env.AF_TASK_ROW_ARTIFACT) await page.locator('.composer-region').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'progress-open-' + width + '.png') });
  }
  await page.locator('#run-status-toggle').click();
  const closed = await placement();
  assert.equal(closed.parent, 'agent-progress-dock', 'Closed panel returns the indicator to the composer dock');
  assert.ok(Math.abs(closed.progress.x - closed.composer.x) <= 1 && closed.progress.bottom <= closed.composer.y + 1, 'Closed placement stays at the composer left edge');
  await page.locator('#run-status-toggle').click();
  assert.equal((await placement()).parent, 'run-status');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.state', running: false } })));
  // Expert and worker tags are plain labels: not buttons, not focusable, no hover change.
  for (const row of [worker, expert]) {
    const tag = row.locator('.task-flow-agent');
    assert.equal(await tag.evaluate(el => el.tagName), 'SPAN');
    const before = await tag.evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).cursor]);
    await tag.hover();
    assert.deepEqual(await tag.evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).cursor]), before, 'Role tag has no hover effect');
    assert.notEqual(before[1], 'pointer');
  }
  assert.equal(await worker.locator(':scope > summary').getAttribute('aria-expanded'), 'false');
  await worker.locator(':scope > summary').focus();
  await page.keyboard.press('Space');
  assert.equal(await worker.getAttribute('open'), '');
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="row-worker"] .task-flow-single > summary').getAttribute('aria-expanded') === 'true');
  assert.equal(await worker.locator('.task-flow-stop').getAttribute('aria-label'), longTitle + ' · Stop', 'Stop icon keeps its accessible name');
  assert.equal(await worker.locator('.task-flow-stop').getAttribute('title'), longTitle + ' · Stop');
  await worker.locator('.task-flow-stop').click();
  assert.equal(await worker.getAttribute('open'), '', 'Stop is independent from disclosure');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'task.stop', workflowId: 'row-worker', taskId: 'task-worker', agentId: 'agent-worker', runId: 'run-worker' });
  await page.evaluate(() => window.postMessage({ type: 'task.stop.result', workflowId: 'row-worker', taskId: 'task-worker', error: 'fixture error' }, '*'));
  await worker.locator('[role="alert"]').waitFor();
  assert.equal(await worker.locator('.task-flow-stop').isEnabled(), true);
  // One workflow with a running and a stopped task: delete appears only on the stopped one, in the slot stop used.
  const mixed = (id, status) => ({ agentId: 'agent-' + id, runId: 'run-' + id, role: 'work', status, workProfile: 'workLight', model: 'mixed-model',
    taskBinding: { workflowId: 'row-mixed', workflowTitle: 'Mixed', taskId: 'task-' + id, title: 'Mixed ' + id, description: 'Full request' } });
  agents = [...agents, mixed('live', 'running'), mixed('stopped', 'cancelled')];
  await publish();
  const mixedRow = id => page.locator('#run-stage-list [data-flow-id="row-mixed"] [data-task-id="task-' + id + '"]');
  await mixedRow('stopped').locator('.task-flow-dismiss').waitFor();
  assert.equal(await mixedRow('stopped').locator('.task-flow-stop').count(), 0, 'A stopped task offers delete in place of stop');
  assert.equal(await mixedRow('live').locator('.task-flow-dismiss').count(), 0, 'A running task never offers delete');
  await page.mouse.move(0, 0);
  const slot = await page.evaluate(() => {
    const box = selector => { const el = document.querySelector('#run-stage-list [data-flow-id="row-mixed"] ' + selector), r = el.getBoundingClientRect();
      return { right: r.right, size: [Math.round(r.width), Math.round(r.height)], opacity: getComputedStyle(el).opacity }; };
    return { stop: box('[data-task-id="task-live"] .task-flow-stop'), dismiss: box('[data-task-id="task-stopped"] .task-flow-dismiss') };
  });
  assert.deepEqual(slot.dismiss.size, slot.stop.size, 'Delete matches the stop icon button');
  assert.ok(Math.abs(slot.dismiss.right - slot.stop.right) < 1, 'Delete occupies the slot stop used');
  assert.equal(slot.dismiss.opacity, '1', 'Delete stays visible without hover once it is the only action');
  assert.equal(await mixedRow('stopped').locator('.task-flow-dismiss').getAttribute('aria-label'), 'Mixed stopped · Delete', 'The icon keeps its accessible name');
  const before = await page.evaluate(() => window.sentMessages.length);
  await mixedRow('stopped').locator('.task-flow-dismiss').focus();
  await page.keyboard.press('Enter');
  assert.equal(await mixedRow('stopped').count(), 1, 'The row stays present until Host confirms deletion');
  const deletion = await page.evaluate(() => window.sentMessages.at(-1));
  assert.deepEqual(deletion, { type: 'task.delete', workflowId: 'row-mixed', taskId: 'task-stopped' });
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { ...deletion, type: 'task.delete.result', mainAgentId: 'row-main' });
  agents = agents.filter(agent => agent.taskBinding?.workflowId !== deletion.workflowId || agent.taskBinding?.taskId !== deletion.taskId);
  assert.equal(await mixedRow('stopped').count(), 0);
  assert.equal(await page.evaluate(() => window.sentMessages.length), before + 1, 'Deletion sends exactly its Host request and no execution control');
  await publish();
  assert.equal(await mixedRow('stopped').count(), 0, 'Removed row remains hidden on refresh');
  assert.equal(await mixedRow('live').count(), 1, 'The running task stays listed');
  assert.equal(await worker.getAttribute('open'), '', 'Other disclosure remains open');
  agents = [{ ...agents[0], runId: 'different-run', model: 'wrong-run-model', workProfile: 'work' }];
  const workflow = { loopId: 'loop-original', workAgentId: 'agent-worker', taskMode: 'work-verification', status: 'active', workflow: { id: 'row-worker', title: 'Bound original', tasks: [
    { id: 'task-worker', title: longTitle, workRunId: 'run-worker', workStatus: 'running', verificationStatus: 'pending' }
  ] } };
  await publish([workflow]);
  await page.waitForFunction(() => document.querySelector('#run-stage-list .task-flow-model')?.textContent === 'Model unavailable');
  assert.equal(await worker.locator('.task-flow-agent[data-stage="work"]').textContent(), 'Role unavailable', 'Another run never supplies the profile');
  assert.equal(await worker.locator('.task-flow-model[data-stage="work"]').textContent(), 'Model unavailable', 'Another run never supplies the model');
  workflow.workflow.tasks[0].workStatus = 'completed';
  workflow.workflow.tasks[0].verificationStatus = 'running';
  workflow.workflow.tasks[0].verificationRunId = 'verify-run';
  workflow.verificationAgentId = 'agent-verifier';
  agents = [{ agentId: 'agent-verifier', runId: 'verify-run', role: 'verification', status: 'running', model: 'captured-verifier',
    activity: 'Running the task panel browser checks', planProgress: { completed: 3, total: 5 } }];
  await publish([workflow]);
  await page.waitForFunction(() => document.querySelector('#run-stage-list .task-flow-model[data-stage="verification"]')?.textContent === 'captured-verifier');
  assert.equal(await worker.locator('.task-flow-agent[data-stage="verification"]').textContent(), 'Verification');
  assert.equal(await worker.locator('.task-flow-model[data-stage="verification"]').getAttribute('data-running'), 'true', 'The running stage model carries the loading scan');
  assert.equal(await worker.locator('.task-flow-progress').textContent(), '3/5', 'Steps follow the stage now running');
  if (process.env.AF_TASK_ROW_ARTIFACT) {
    for (const width of [1200, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.locator('#run-details').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'work-verify-' + width + '.png'), animations: 'disabled' });
    }
  }
  await worker.locator('.task-flow-agent[data-stage="verification"]').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'agent-verifier', runId: 'verify-run' });
  workflow.workflow.tasks[0].workRunId = undefined;
  workflow.workflow.tasks[0].workStatus = 'pending';
  delete workflow.workAgentId;
  await publish([workflow]);
  await page.waitForFunction(() => document.querySelector('#run-stage-list .task-flow-agent')?.textContent === 'Unassigned');
  assert.equal(await worker.locator('button.task-flow-agent[data-stage="work"]').count(), 0, 'Unassigned rows cannot fabricate a chat');
  assert.equal(await worker.locator('.task-flow-model[data-stage="work"]').textContent(), '—', 'A stage without a run shows a dimmed dash');
  // The task's historical run display survives unrelated Main/default settings and tab restoration.
  await page.setViewportSize({ width: 795, height: 900 });
  const initialize = async capturedRun => page.evaluate(capturedRun => window.postMessage({ type: 'host.initialize',
    panelId: 'child-fixture', agentId: capturedRun.agentId, role: capturedRun.agentId === 'agent-verifier' ? 'verification' : 'work',
    runtimeAvailable: true, model: 'next-send-main-setting', reasoning: 'high', agentSettingsScope: 'chat', capturedRun,
    statusItems: ['model'], capabilities: { submit: { model: true }, send: { model: true } } }, '*'), capturedRun);
  for (const capturedRun of [
    { parentAgentId: 'main-owner', agentId: 'agent-worker', runId: 'run-worker', model: longModel, workProfile: 'workLight' },
    { parentAgentId: 'main-owner', agentId: 'agent-expert', runId: 'run-expert', model: 'captured-expert', workProfile: 'work' },
    { parentAgentId: 'main-owner', agentId: 'agent-verifier', runId: 'verify-run' }
  ]) {
    await initialize(capturedRun);
    const expected = capturedRun.model || 'Model unavailable';
    await page.waitForFunction(expected => document.querySelector('#model-label').textContent === expected, expected);
    assert.match(await page.locator('#model-button').getAttribute('title'), new RegExp(capturedRun.runId));
    assert.ok((await page.locator('[data-item-id="model"]').textContent()).includes(expected));
    await page.evaluate(() => window.postMessage({ type: 'agent.defaults', settings: { global: { main: { model: 'changed-global-main' }, work: { model: 'changed-work-profile' } } } }, '*'));
    assert.equal(await page.locator('#model-label').textContent(), expected);
    await page.locator('#model-button').click();
    assert.ok((await page.locator('.agent-captured-run').textContent()).includes(capturedRun.runId));
    assert.equal(await page.locator('#model-menu > .agent-model-row .agent-model-name').textContent(), 'Next message');
    assert.equal(await page.locator('#model-menu > .agent-model-row button[data-field="model"]').evaluate(button => button.value), 'next-send-main-setting');
    await page.keyboard.press('Escape');
    const saved = await page.evaluate(() => window.saved);
    assert.deepEqual(saved.capturedRun, capturedRun);
    await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)), saved);
    await page.reload();
    await page.waitForFunction(expected => document.querySelector('#model-label').textContent === expected, expected);
    await initialize(capturedRun);
    if (capturedRun.agentId === 'agent-worker') {
      const older = { ...capturedRun, runId: 'run-historical', model: 'historical-worker' };
      await page.evaluate(capturedRun => window.postMessage({ type: 'agent.run.selected', capturedRun }, '*'), older);
      await page.waitForFunction(() => document.querySelector('#model-label').textContent === 'historical-worker' && window.saved.capturedRun?.runId === 'run-historical');
      assert.equal(await page.evaluate(() => window.saved.model), 'next-send-main-setting');
      assert.equal(await page.evaluate(() => window.saved.capturedRun.runId), 'run-historical');
      await page.evaluate(() => window.postMessage({ type: 'agent.run.selected', capturedRun: { parentAgentId: 'main-owner', agentId: 'other-agent', runId: 'run-wrong', model: 'wrong-model' } }, '*'));
      await page.waitForFunction(() => !window.saved.capturedRun);
    }
  }
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length), 0);
}
module.exports.checkTaskRows = checkTaskRows;

module.exports.checkTaskFlowStates = async function (page) {
  const post = data => page.evaluate(data => new Promise(resolve => {
    window.postMessage(data, '*');
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }), data);
  await post({ type: 'host.initialize', panelId: 'state-test', agentId: 'main-state', role: 'main', runtimeAvailable: true, running: false, uiLanguage: 'ko' });
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#status-settings-close').click();
  const toggle = page.locator('#run-status-toggle');
  await toggle.waitFor({ state: 'visible' });
  assert.equal(await toggle.isEnabled(), true);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.match(await page.locator('#run-stage-list').textContent(), /작업 없음/);
  await page.screenshot({ path: require('node:path').join(process.env.AF_RENDERING_ARTIFACT_DIR || require('node:path').resolve(__dirname, '../../../docs/artifact/evidence/ui-overlay-dnd'), 'empty-expanded-ko.png') });
  await toggle.click();
  const snapshot = { loopId: 'state-loop', workAgentId: 'state-work', status: 'active', taskMode: 'work', workProfile: 'work', workflow: {
    id: 'state-flow', title: 'Fixture state flow', tasks: [{ id: 'state-task', title: 'Fixture task', workStatus: 'running', workAgentId: 'state-work', workRunId: 'state-run' }] } };
  const publish = async status => {
    snapshot.status = ['completed', 'failed', 'cancelled'].includes(status) ? status : status === 'blocked' ? 'needs-human-decision' : 'active';
    snapshot.workflow.tasks[0].workStatus = status;
    await post({ type: 'agents.list', agents: [], workflows: [snapshot] });
    await post({ type: 'agents.list', agents: [{ agentId: 'state-work', runId: 'state-run', role: 'work', status: status === 'blocked' ? 'needs-human-decision' : status, workProfile: 'work', model: 'gpt-fixture' }] });
  };
  await publish('running');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'refresh respects explicit collapsed choice');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('#run-status').classList.contains('is-running'));
  assert.deepEqual(await page.locator('#run-status-toggle .run-status-pulse').evaluate(el => [getComputedStyle(el).animationName,
    getComputedStyle(el, '::before').animationName, getComputedStyle(el, '::after').animationName]),
    ['run-status-dot-breathe', 'run-status-dot-ripple', 'run-status-dot-ripple'], 'A running workflow dot breathes and radiates rings');
  snapshot.status = 'needs-human-decision';
  await post({ type: 'agents.list', workflows: [snapshot], agents: [{ agentId: 'state-work', runId: 'state-run', role: 'work', status: 'running' }] });
  await page.waitForFunction(() => !document.querySelector('#run-status').classList.contains('is-running'));
  assert.equal(await page.locator('#run-stage-list .task-flow-single').evaluate(el => getComputedStyle(el).animationName), 'none', 'paused loop suppresses stale running child motion');
  assert.equal(await page.locator('#run-stage-list .task-flow-state').textContent(), '결정 대기', 'Observed loop decision overrides stale running display for its current task');
  snapshot.status = 'active';
  delete snapshot.workflow.tasks[0].workRunId;
  await post({ type: 'agents.list', workflows: [snapshot], agents: [] });
  assert.equal(await page.locator('#run-status').evaluate(el => el.classList.contains('is-running')), false, 'unassigned run does not pulse');
  snapshot.workflow.tasks[0].workRunId = 'state-run';
  await publish('running');
  for (const status of ['pending', 'blocked', 'completed', 'failed', 'cancelled']) {
    await publish(status);
    await page.waitForFunction(() => !document.querySelector('#run-status').classList.contains('is-running'));
    assert.deepEqual(await page.locator('#run-status-toggle .run-status-pulse').evaluate(el => [getComputedStyle(el).animationName,
      getComputedStyle(el, '::before').content, getComputedStyle(el, '::after').content]), ['none', 'none', 'none'], status + ' dot stays still');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const container = ['completed', 'failed', 'cancelled'].includes(status) ? '#task-history-list' : '#run-stage-list';
    assert.equal(await page.locator(container + ' [data-task-id="state-task"]').count(), 1, status + ' remains visible');
    assert.doesNotMatch(await page.locator(container).textContent(), /작업 없음/);
    await toggle.click(); await toggle.click();
  }
  const originalTasks = snapshot.workflow.tasks;
  snapshot.workflow.tasks = Array.from({ length: 10 }, (_, i) => ({ ...originalTasks[0], id: 'retained-' + i, title: 'Retained completed task ' + i, workStatus: 'completed' }));
  await publish('completed');
  const openHistory = async () => {
    if (await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-compact') && !el.classList.contains('is-open'))) await page.locator('#workflow-history-toggle').click();
    if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
  };
  for (const size of [{ width: 465, height: 556 }, { width: 721, height: 402 }, { width: 320, height: 500 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await openHistory();
    const entry = page.locator('.task-history-disclosure[data-history-id="state-flow"]');
    if (!await entry.evaluate(el => el.open)) await entry.locator(':scope > summary').click();
    const composer = await page.locator('.composer').boundingBox();
    assert.ok(composer.y >= 0 && composer.y + composer.height <= size.height, 'retained tasks leave the whole composer inside the viewport');
    const historyScroll = await page.locator('#task-history-list').evaluate(el => Array.from([el, ...el.querySelectorAll('*')]).filter(item => item.scrollHeight > item.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(item).overflowY)).map(item => item.id || item.className));
    assert.ok(historyScroll.length, 'all retained tasks are available by scrolling');
    await page.locator('#task-history > summary').click();
    await page.locator('#prompt').fill('Expanded history input');
    await page.locator('#prompt').click();
    assert.equal(await page.locator('#prompt').evaluate(el => el === document.activeElement), true);
  }
  snapshot.workflow.tasks = originalTasks;
  await publish('completed');
  await post({ type: 'run.state', running: true });
  assert.equal(await page.locator('.composer').evaluate(el => el.classList.contains('is-progressing')), false, 'preparing Main has no pulse until its observed running status');
  const mainMotion = () => page.locator('#agent-progress').evaluate(el => {
    const pulse = el.querySelector('.run-status-pulse');
    return { pulse: getComputedStyle(pulse).animationName, ring: getComputedStyle(pulse, '::before').animationName,
      lateRing: getComputedStyle(pulse, '::after').animationName, label: getComputedStyle(el.querySelector('.run-status-label')).animationName,
      rings: getComputedStyle(pulse, '::before').content !== 'none' };
  });
  assert.deepEqual(await mainMotion(), { pulse: 'none', ring: 'none', lateRing: 'none', label: 'none', rings: false }, 'Preparing Main indicator stays still');
  const idleBox = await page.locator('#agent-progress').boundingBox();
  await post({ type: 'run.observed', status: 'running' });
  await page.waitForFunction(() => document.querySelector('.composer').classList.contains('is-progressing'));
  assert.equal(await page.locator('#run-status').evaluate(el => el.classList.contains('is-running')), false, 'Main progress does not pulse completed child workflow');
  assert.deepEqual(await mainMotion(), { pulse: 'run-status-dot-breathe', ring: 'run-status-dot-ripple', lateRing: 'run-status-dot-ripple',
    label: 'run-status-text-scan', rings: true }, 'Running Main shows ripple rings, a breathing dot and a running text shimmer');
  assert.equal((await page.locator('#agent-progress').boundingBox()).height, idleBox.height, 'Indicator motion does not change the row height');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await mainMotion(), { pulse: 'none', ring: 'none', lateRing: 'none', label: 'none', rings: false }, 'Reduced motion stops the Main indicator');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const status of ['accepted', 'queued', 'starting', 'needs-human-decision', 'completed', 'failed', 'cancelled']) {
    await post({ type: 'run.observed', status });
    await page.waitForFunction(() => !document.querySelector('.composer').classList.contains('is-progressing'));
    assert.deepEqual(await mainMotion(), { pulse: 'none', ring: 'none', lateRing: 'none', label: 'none', rings: false }, status + ' Main indicator stays still');
  }
  await post({ type: 'run.observed', status: 'running' });
  await page.waitForFunction(() => document.querySelector('.composer').classList.contains('is-progressing'));
  await post({ type: 'decision.pending', runId: 'decision-fixture', canApprove: false });
  await page.waitForFunction(() => !document.querySelector('.composer').classList.contains('is-progressing'));
  await post({ type: 'decision.pending' });
  await post({ type: 'run.state', running: false });
  await publish('running');
  await page.waitForFunction(() => document.querySelector('#run-status').classList.contains('is-running'));
  assert.equal(await page.locator('.composer').evaluate(el => el.classList.contains('is-progressing')), false, 'child progress does not pulse idle Main composer');
  assert.equal(await page.locator('#run-stage-list .task-flow-dismiss').count(), 0, 'A running task offers stop, never delete');
  await publish('cancelled');
  await openHistory();
  await page.locator('#task-history-list .task-flow-dismiss').click();
  const deleted = await page.evaluate(() => window.sentMessages.at(-1));
  await post({ ...deleted, type: 'task.delete.result', mainAgentId: 'main-state' });
  await page.waitForFunction(() => !document.querySelector('#task-history-list [data-task-id="state-task"]'));
  await page.waitForFunction(() => !document.querySelector('#run-stage-list .task-flow'));
  assert.match(await page.locator('#run-stage-list').textContent(), /작업 없음/);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#run-status').evaluate(el => el.classList.contains('is-running')), false);
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => ['task.stop', 'workflow.close', 'run.cancel'].includes(m.type))), false);
  const saved = await page.evaluate(() => window.saved);
  await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)), saved);
  await page.reload();
  await toggle.waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'empty expanded choice is restored');
  assert.match(await page.locator('#run-stage-list').textContent(), /작업 없음/);
  await toggle.click(); await toggle.click();
};

// Status presentation uses only owned fixtures, including real lifecycle and selected Verification stages.
module.exports.checkTaskStatusBadges = async function (page) {
  const fs = require('node:fs'), path = require('node:path');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ botVisible: false })));
  await page.reload();
  const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
  await post({ type: 'host.initialize', panelId: 'badge-fixture', role: 'main', runtimeAvailable: true });
  const language = async value => {
    await page.locator('#status-settings-button').click();
    await page.locator('#settings-tab-general').click();
    await page.locator('#ui-language').selectOption(value);
    await page.locator('#status-settings-close').click();
  };
  const statuses = ['accepted', 'queued', 'starting', 'running', 'needs-human-decision', 'completed', 'failed', 'cancelled', 'cancelling'];
  const names = {
    en: ['Accepted', 'Queued', 'Preparing', 'In progress', 'Awaiting decision', 'Completed', 'Failed', 'Cancelled', 'Stopping'],
    ko: ['접수됨', '큐 대기', '준비 중', '진행 중', '결정 대기', '완료', '실패', '취소', '중지 중']
  };
  let agents = statuses.map((status, i) => ({ agentId: 'badge-agent-' + i, runId: 'badge-run-' + i,
    role: 'work', workProfile: i % 2 ? 'work' : 'workLight', model: 'captured-model-' + i, status,
    taskBinding: { workflowId: 'badge-flow-' + i, workflowTitle: 'Fixture ' + i, taskId: 'badge-task-' + i,
      title: 'Long task ' + 'name '.repeat(35), description: 'Recorded request ' + i } }));
  const workflows = [
    { loopId: 'badge-loop-wait', taskMode: 'work', status: 'active', workflow: { id: 'badge-wait', title: 'Waiting task', tasks: [
      { id: 'badge-pending', title: 'Unassigned waiting task', workStatus: 'pending' },
      { id: 'badge-blocked', title: 'Blocked task', workStatus: 'blocked' }
    ] } },
    { loopId: 'badge-loop-verify', taskMode: 'work-verification', status: 'active', workAgentId: 'badge-work', verificationAgentId: 'badge-verifier', workflow: {
      id: 'badge-verify', title: 'Selected verification', tasks: [{ id: 'badge-verify-task', title: 'Verification fixture',
        workStatus: 'completed', workRunId: 'badge-work-run', verificationStatus: 'running', verificationRunId: 'badge-verify-run' }] } }
  ];
  agents.push({ agentId: 'badge-verifier', runId: 'badge-verify-run', role: 'verification', model: 'verify-model', status: 'running' });
  const publish = () => post({ type: 'agents.list', agents, workflows });
  await publish();
  // Ended children (completed, failed, cancelled) are listed in Task history; the others in the task panel.
  const badge = i => page.locator(':is(#run-stage-list, #task-history-list) [data-flow-id="badge-flow-' + i + '"] .task-flow-state');
  await badge(0).waitFor();
  const waiting = page.locator('#run-stage-list [data-flow-id="badge-wait"]');
  const verification = page.locator('#run-stage-list [data-flow-id="badge-verify"]');
  await badge(3).locator('..').focus();
  await page.keyboard.press('Enter');
  for (const [i, status] of statuses.entries()) {
    assert.equal(await badge(i).locator('../..').evaluate(el => getComputedStyle(el).animationName),
      status === 'running' ? 'task-flow-active-sweep' : 'none', 'Only the exact running child pulses: ' + status);
  }
  const originalRequests = JSON.stringify({ agents, workflows });
  for (const locale of ['ko', 'en']) {
    await language(locale);
    assert.deepEqual(await Promise.all(statuses.map((_, i) => badge(i).textContent())), names[locale]);
    assert.equal(await waiting.locator('[data-task-id="badge-pending"] .task-flow-state').textContent(), locale === 'ko' ? '대기' : 'Pending');
    assert.equal(await waiting.locator('[data-task-id="badge-blocked"] .task-flow-state').textContent(), locale === 'ko' ? '막힘' : 'Blocked');
    assert.equal(await verification.locator('.task-flow-state').textContent(), locale === 'ko' ? '검증 중' : 'Verifying');
    assert.equal(await waiting.locator('[data-task-id="badge-pending"] button.task-flow-agent').count(), 0);
    // A stage whose run has not started shows a dimmed dash; the tooltip still names the missing model.
    assert.equal(await waiting.locator('[data-task-id="badge-pending"] .task-flow-model').textContent(), '—');
    assert.equal(await waiting.locator('[data-task-id="badge-pending"] .task-flow-model').getAttribute('title'), locale === 'ko' ? '모델 미제공' : 'Model unavailable');
    assert.equal(await waiting.locator('[data-task-id="badge-pending"] .task-flow-model').getAttribute('data-waiting'), 'true');
    for (const [theme, foreground, background] of [['vscode-light', '#333333', '#ffffff'], ['vscode-dark', '#dddddd', '#1e1e1e'],
      ['vscode-high-contrast', '#ffffff', '#000000'], ['vscode-high-contrast-light', '#292929', '#ffffff']]) {
      await page.evaluate(({ theme, foreground, background }) => {
        document.body.className = theme;
        document.documentElement.style.setProperty('--vscode-foreground', foreground);
        document.documentElement.style.setProperty('--vscode-editor-background', background);
        document.documentElement.style.setProperty('--vscode-editor-foreground', foreground);
        document.documentElement.style.setProperty('--vscode-descriptionForeground', theme.includes('light') ? '#616161' : '#999999');
        document.documentElement.style.setProperty('--vscode-editorWidget-background', theme.includes('light') ? '#f3f3f3' : '#252526');
        document.documentElement.style.setProperty('--vscode-panel-border', theme.includes('light') ? '#d0d0d0' : '#454545');
      }, { theme, foreground, background });
      for (const [width, height] of [[1200, 900], [795, 900], [465, 556], [721, 402], [320, 800]]) {
        await page.setViewportSize({ width, height });
        const geometry = await page.locator('#run-stage-list summary.task-flow-row').evaluateAll(rows => rows.map(row => {
          const r = row.getBoundingClientRect();
          const cells = ['.task-flow-single-title, .task-flow-name', '.task-flow-agent', '.task-flow-model', '.task-flow-state', '.task-flow-stop-controls'];
          const positions = cells.map(selector => { const el = row.querySelector(selector), b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width }; });
          const badge = row.querySelector('.task-flow-state'), b = badge.getBoundingClientRect(), style = getComputedStyle(badge);
          const probe = document.createElement('span'); probe.style.color = 'var(--vscode-foreground)'; row.append(probe); const foreground = getComputedStyle(probe).color; probe.remove();
          const range = document.createRange(); range.selectNodeContents(badge);
          const textFits = Array.from(range.getClientRects()).every(t => t.x >= b.x && t.right <= b.right + 1 && t.y >= b.y && t.bottom <= b.bottom + 1);
          return { group: row.closest('.task-flow').classList.contains('task-flow-single-container') ? 'single' : row.closest('.task-flow').dataset.flowId, positions, fits: row.scrollWidth <= row.clientWidth + 1 && positions.every(p => p.width > 0 && p.x >= r.x && p.right <= r.right + 1),
            readable: style.color === foreground && Number.parseFloat(style.fontSize) >= 11 && style.whiteSpace === 'nowrap', color: style.color, fontSize: style.fontSize,
            dot: (dot => dot.content !== 'none' && Number.parseFloat(dot.width) > 0 && dot.backgroundColor !== 'rgba(0, 0, 0, 0)')(getComputedStyle(badge, '::before')),
            unboxed: style.borderTopStyle === 'none' && style.backgroundColor === 'rgba(0, 0, 0, 0)', textFits };
        }));
        assert.ok(geometry.every(g => g.fits && g.readable && g.dot && g.unboxed && g.textFits), locale + ' ' + theme + ' ' + width + ' dot-and-text statuses fit rows ' + JSON.stringify(geometry));
        for (const g of geometry) for (const [i, p] of g.positions.entries()) {
          const first = geometry[0].positions[i];
          // Content-sized actions end on one shared edge; every other track starts on one shared edge.
          assert.ok(i === 4 ? Math.abs(p.right - first.right) < 1 : Math.abs(p.x - first.x) < 1, 'Shared tracks stay aligned across all task rows ' + width + ' ' + i + ' ' + g.group + JSON.stringify([p, first]));
        }
        assert.ok(geometry.every(g => g.positions[3].right <= g.positions[4].x || g.positions[3].bottom <= g.positions[4].y || g.positions[4].bottom <= g.positions[3].y), 'Status never overlaps controls');
        // Narrow rows: title and the stop/delete action share the first line; status and role follow, the model beneath the role.
        if (width === 320) assert.ok(geometry.every(g => g.positions[0].bottom <= g.positions[3].y + 1 &&
          g.positions[4].y < g.positions[0].bottom && g.positions[0].y < g.positions[4].bottom && g.positions[0].right <= g.positions[4].x + 1 &&
          Math.abs(g.positions[1].y - g.positions[3].y) < 4 && g.positions[1].bottom <= g.positions[2].y + 1),
          'Narrow rows keep title and action first, then status and role above the model ' + JSON.stringify(geometry.map(g => g.positions)));
        assert.ok(await page.locator('#run-details').evaluate(el => Math.abs(el.getBoundingClientRect().width - el.parentElement.getBoundingClientRect().width) < 1), 'Full panel width');
        // Compare settled frames: the composer's border-color transition otherwise reports an interpolated value.
        const frames = await page.evaluate(() => [document.querySelector('#run-details'), document.querySelector('.composer')].map(el => {
          el.style.transition = 'none'; const s = getComputedStyle(el);
          const frame = [s.borderTopColor, s.borderTopWidth, s.borderTopStyle, s.borderTopLeftRadius, s.borderBottomRightRadius, s.backgroundColor].join(' ');
          el.style.removeProperty('transition'); return frame;
        }));
        assert.equal(frames[0], frames[1], theme + ' ' + width + ' task panel frame matches the composer frame');
        if (process.env.AF_TASK_ROW_ARTIFACT && locale === 'ko' && [1200, 320].includes(width)) {
          await page.locator('.composer-region').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'border-' + theme + '-' + width + '.png') });
        }
        if (process.env.AF_TASK_ROW_ARTIFACT && locale === 'ko' && [1200, 465].includes(width) && ['vscode-light', 'vscode-dark'].includes(theme)) {
          await page.locator('#run-details').screenshot({ path: path.join(process.env.AF_TASK_ROW_ARTIFACT, 'badges-' + theme + '-' + width + '.png') });
          fs.writeFileSync(path.join(process.env.AF_TASK_ROW_ARTIFACT, 'badges-' + theme + '-' + width + '.json'), JSON.stringify(geometry, null, 2));
        }
      }
    }
    assert.match(await badge(5).getAttribute('title'), locale === 'ko' ? /Work.*독립 Verification 통과를 뜻하지/ : /Work.*does not mean independent Verification passed/);
    assert.equal(await badge(5).getAttribute('role'), 'status');
    assert.equal(await badge(5).getAttribute('aria-live'), 'polite');
    assert.ok((await badge(5).getAttribute('aria-label')).includes(await badge(5).getAttribute('title')));
    assert.notEqual(await badge(5).evaluate(el => getComputedStyle(el, '::before').backgroundColor), await badge(6).evaluate(el => getComputedStyle(el, '::before').backgroundColor));
  }
  assert.equal(JSON.stringify({ agents, workflows }), originalRequests, 'Rendering never mutates run fixtures');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="badge-flow-3"] details').getAttribute('open'), '');
  agents[3].status = 'completed'; await publish();
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="badge-flow-3"] .task-flow-state')?.dataset.observedStatus === 'completed');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="badge-flow-3"] details').getAttribute('open'), '', 'Disclosure survives status transitions');
  assert.equal(await page.locator('#run-stage-list [data-flow-id="badge-flow-3"] details').evaluate(el => getComputedStyle(el).animationName), 'none');
  workflows[1].workflow.tasks[0].verificationStatus = 'completed'; agents.at(-1).status = 'completed'; await publish();
  await page.waitForFunction(() => document.querySelector('#run-stage-list [data-flow-id="badge-verify"] .task-flow-state')?.textContent === 'Verification ended');
  assert.match(await verification.locator('.task-flow-state').getAttribute('title'), /recorded result/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok((await page.locator('#run-stage-list .task-flow-single').evaluateAll(items => items.map(el => getComputedStyle(el).animationName))).every(name => name === 'none'));
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => ['task.stop', 'workflow.close', 'run.cancel', 'chat.send'].includes(m.type))), false);
};
