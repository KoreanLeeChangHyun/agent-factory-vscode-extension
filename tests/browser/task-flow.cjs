const assert = require('node:assert/strict');
async function checkTaskFlow(page, { panelOnly = false } = {}) {
  const checkHeaderPulse = async running => {
    const pulse = page.locator('#run-status .run-status-pulse');
    assert.equal(await page.locator('#run-status').evaluate(el => el.classList.contains('is-running')), running);
    assert.equal(await pulse.getAttribute('aria-hidden'), 'true');
    const originalClass = await page.locator('body').getAttribute('class');
    for (const [theme, progress, focus, neutral, foreground, expected] of [
      ['vscode-light', '#005fb8', '#007acc', '#616161', '#333333', 'rgb(0, 95, 184)'],
      ['vscode-dark', '#0e70c0', '#007fd4', '#999999', '#dddddd', 'rgb(14, 112, 192)'],
      ['vscode-high-contrast', '#00ffff', '#f38518', '#ffffff', '#ffffff', 'rgb(0, 255, 255)'],
      ['vscode-high-contrast-light', '#005a9e', '#0f4a85', '#292929', '#292929', 'rgb(0, 90, 158)'],
      ['vscode-dark', null, '#007fd4', '#999999', '#dddddd', 'rgb(0, 127, 212)'],
      ['vscode-dark', null, null, '#999999', '#dddddd', 'rgb(0, 128, 232)'],
    ]) {
      const saved = await page.evaluate(({ theme, progress, focus, neutral, foreground }) => {
        const root = document.documentElement;
        const names = ['--vscode-progressBar-background', '--vscode-focusBorder', '--vscode-descriptionForeground', '--vscode-foreground'];
        const saved = names.map(name => [name, root.style.getPropertyValue(name)]);
        document.body.className = theme;
        names.forEach((name, i) => {
          const value = [progress, focus, neutral, foreground][i];
          if (value === null) root.style.removeProperty(name);
          else root.style.setProperty(name, value);
        });
        return saved;
      }, { theme, progress, focus, neutral, foreground });
      try {
        const colors = await page.locator('#run-status').evaluate(el => {
          const probe = document.createElement('span');
          probe.style.background = 'var(--vscode-descriptionForeground)';
          el.append(probe);
          const colors = {
            pulse: getComputedStyle(el.querySelector('.run-status-pulse')).backgroundColor,
            neutral: getComputedStyle(probe).backgroundColor,
            copy: getComputedStyle(el.querySelector('.run-status-copy')).color,
            label: getComputedStyle(el.querySelector('.run-status-label')).color,
            meta: getComputedStyle(el.querySelector('.run-status-meta')).color,
          };
          probe.remove();
          return colors;
        });
        assert.equal(colors.pulse, running ? expected : colors.neutral, theme + ' dot reflects execution state');
        const textColor = running ? expected : await page.evaluate(value => {
          const probe = document.createElement('span');
          probe.style.color = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }, foreground);
        assert.deepEqual([colors.copy, colors.label, colors.meta], [textColor, textColor, textColor], theme + ' text and elapsed time reflect execution state');
      } finally {
        await page.evaluate(saved => saved.forEach(([name, value]) => value ? document.documentElement.style.setProperty(name, value) : document.documentElement.style.removeProperty(name)), saved);
        await page.locator('body').evaluate((el, value) => value === null ? el.removeAttribute('class') : el.setAttribute('class', value), originalClass);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await pulse.evaluate(el => getComputedStyle(el).animationName), 'none');
    if (running) assert.equal(await page.locator('#run-status-label').evaluate(el => getComputedStyle(el).color),
      await pulse.evaluate(el => getComputedStyle(el).backgroundColor), 'Reduced motion preserves the active colour');
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
    assert.equal(await panel.locator('.task-flow-disclosure[open]').count(), 0, 'Task details start collapsed');
    assert.ok((await panel.locator('.task-flow-state').evaluateAll(items => items.map(item => item.getBoundingClientRect().width))).every(width => width > 0),
      'Every compact row keeps its status visible');
    assert.deepEqual(await panel.locator('.task-flow-disclosure > summary').evaluateAll(rows => rows.map(row => {
      const style = getComputedStyle(row);
      return style.gridTemplateColumns.split(' ').length;
    })), [4, 4, 4], 'Every summary keeps number, title, status, and disclosure indicator on one row');
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
    active.locator('.task-flow-state').evaluate(el => getComputedStyle(el).color),
    stationary.locator('.task-flow-state').evaluate(el => getComputedStyle(el).color)
  ]);
  assert.notEqual(activeColor, stationaryColor, 'Active workflow state uses the theme accent');
  assert.equal(await page.locator('#timeline [data-task-id="behavior"] .task-flow-state').evaluate(el => getComputedStyle(el).color), stationaryColor,
    'A historical snapshot remains visually inactive');
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
  await page.waitForFunction(() => document.querySelector('#run-status').classList.contains('is-running'));
  await checkHeaderPulse(true);
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').classList.contains('is-running'));
  await checkHeaderPulse(false);
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
    assert.equal(await page.locator(container + ' [data-task-id="test"]').evaluate(el => getComputedStyle(el).animationName), 'none');
    await checkHeaderPulse(false);
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
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
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
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
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
  await page.waitForFunction(() => document.querySelector('#run-status').hidden);
  assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#run-stage-list .task-flow').count(), 0, 'Completed child must not resurrect a cached pending plan');
  assert.equal(await page.locator('#task-history-list .run-stage-id').textContent(), '하단 스크롤 수정');
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#task-history-list .run-stage-id'));
  assert.equal(await page.locator('#run-status').isVisible(), false, 'Restored legacy pending metadata must not reopen an ended run');
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
  const unrecorded = ['작업자 미배정', '전문가 미배정', '기록 없음'];
  assert.deepEqual(await singleCard.locator('.task-flow-assignment').allTextContents(), unrecorded);
  assert.equal(await singleCard.locator('.task-flow-assignment[data-assigned="true"]').count(), 0);
  await singleCard.locator(':scope > summary').click();
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '기록 없음 · 세션 열기');
  await page.evaluate(single => window.postMessage({ type: 'agents.list', agents: [
    { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'running', model: 'gpt-worker', reasoningEffort: 'low', workProfile: 'workLight' }
  ], workflows: [single] }, '*'), single);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="single-flow"] .task-flow-assignment')?.textContent === '작업자 배정');
  assert.deepEqual(await singleCard.locator('.task-flow-assignment').allTextContents(), ['작업자 배정', '전문가 미배정']);
  assert.equal(await singleCard.getAttribute('open'), '', 'The single card stays expanded when assignment data refreshes');
  // Only the record decides: these settings match the other profile each time.
  const assignment = async (agent, snapshot, first) => {
    await page.evaluate(({ agent, snapshot }) => window.postMessage({ type: 'agents.list', agents: [
      { agentId: 'single-expert', runId: 'single-run', role: 'work', status: 'running', ...agent }
    ], workflows: [snapshot] }, '*'), { agent, snapshot });
    await page.waitForFunction(first => document.querySelector('[data-flow-id="single-flow"] .task-flow-assignment')?.textContent === first, first);
    return singleCard.locator('.task-flow-assignment').allTextContents();
  };
  assert.deepEqual(await assignment({ model: 'gpt-worker', reasoningEffort: 'low', workProfile: 'work' }, single, '작업자 미배정'), ['작업자 미배정', '전문가 배정']);
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '전문가 세션 열기');
  assert.deepEqual(await assignment({ model: 'gpt-expert', reasoningEffort: 'high', workProfile: 'workLight' }, single, '작업자 배정'), ['작업자 배정', '전문가 미배정']);
  assert.deepEqual(await assignment({ model: 'gpt-worker', reasoningEffort: 'low' }, single, '작업자 미배정'), unrecorded,
    'An unrecorded run is never inferred from model settings');
  assert.equal(await singleCard.locator('.task-flow-assignment[data-unrecorded="true"]').textContent(), '기록 없음');
  assert.equal(await singleCard.locator('.task-flow-open').textContent(), '기록 없음 · 세션 열기');
  assert.deepEqual(await assignment({ model: 'gpt-expert', reasoningEffort: 'high' }, { ...single, workProfile: 'workLight' }, '작업자 배정'), ['작업자 배정', '전문가 미배정'],
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
  await page.waitForFunction(() => !document.querySelector('#run-stage-list [data-flow-id="single-flow"]'));
  const engine = { kind: 'work-verification-loop', loopId: 'loop-engine', workAgentId: 'engine-worker', verificationAgentId: 'engine-verifier', workProfile: 'work', taskMode: 'work-verification', status: 'active',
    workflow: { id: 'engine-flow', title: '전체 작업 흐름', tasks: [
      { id: 'first', workRunId: 'work-first', title: '첫 번째 수정', description: '첫 요청', completionCriteria: '검사 통과', workStatus: 'running', verificationStatus: 'pending' },
      { id: 'second', title: '두 번째 수정', description: '다음 요청', completionCriteria: '검사 통과', workStatus: 'pending', verificationStatus: 'pending' }
    ] } };
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  const graph = page.locator('#run-stage-list [data-flow-id="engine-flow"]');
  await graph.waitFor();
  assert.equal(await graph.locator('.task-flow-step').count(), 4, 'All work and verification phases appear immediately');
  assert.equal(await graph.locator('.task-flow-total').textContent(), '작업 2개', 'Verification stages do not increase the task count');
  assert.equal(await page.locator('#run-details-summary').textContent(), '작업 2개');
  assert.deepEqual(await graph.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(), ['작업자 미배정', '전문가 1명'],
    'The recorded Expert profile labels the multi-task card without counting Verification');
  assert.equal(await graph.locator('[data-summary-status="running"]').textContent(), '진행 중 1개');
  assert.equal(await graph.locator('[data-summary-status="pending"]').textContent(), '대기 1개');
  assert.deepEqual(await graph.locator('.task-flow-step').evaluateAll(items => items.map(item => item.dataset.status)), ['running', 'pending', 'pending', 'pending']);
  const firstStage = graph.locator('.task-flow-step').first();
  assert.equal(await graph.locator('.task-flow-open').count(), 1, 'Unstarted stages have no session link');
  await firstStage.locator('.task-flow-disclosure > summary').click();
  assert.equal(await firstStage.locator('.task-flow-open').textContent(), '전문가 세션 열기');
  await firstStage.locator('.task-flow-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker' });

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
  await graph.locator('[data-status="verifying"] .task-flow-open').click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-verifier' });

  assert.equal(await graph.locator('[data-status="verifying"]').evaluate(el => getComputedStyle(el).animationName), 'task-flow-active-sweep');
  assert.equal(await firstStage.evaluate(el => getComputedStyle(el).animationName), 'none', 'Completed stage stops animating');

  assert.equal(await graph.locator('.task-flow-step').count(), 4);
  if (panelOnly) return;
  engine.workflow.tasks[1].workAgentId = 'second-worker';
  engine.workflow.tasks[1].verificationAgentId = 'second-verifier';
  engine.workflow.tasks[1].workRunId = 'work-second';
  engine.workflow.tasks[1].verificationRunId = 'verify-second';
  engine.status = 'completed';
  for (const task of engine.workflow.tasks) { task.workStatus = 'completed'; task.verificationStatus = 'completed'; }
  await page.evaluate(engine => window.postMessage({ type: 'agents.list', agents: [], workflows: [engine] }, '*'), engine);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="engine-flow"]'));
  assert.equal(await graph.count(), 0, 'Whole graph moves to history only after completion');
  assert.equal(await page.locator('#task-history > summary').isVisible(), false);
  await page.setViewportSize({ width: 900, height: 800 });
  const sentBeforeHistory = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length);
  await page.locator('#submission-button').click();
  await page.keyboard.press('End');
  assert.equal(await page.locator('#task-history > summary').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#task-history-list').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#task-history-list').classList.contains('is-flyout'));
  const menuBounds = await page.locator('#submission-menu').boundingBox();
  const historyBounds = await page.locator('#task-history-list').boundingBox();
  assert.ok(historyBounds.x + historyBounds.width < menuBounds.x, 'History opens beside the submission menu');
  assert.ok(historyBounds.x >= 0 && historyBounds.y >= 0);
  assert.ok(Math.abs(historyBounds.y - menuBounds.y) < 1, 'History and submission menu share the top edge');
  assert.ok(Math.abs(historyBounds.height - menuBounds.height) < 1, 'History matches the submission menu height');
  const historyViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForFunction(() => !document.querySelector('#task-history-list').classList.contains('is-flyout'));
  const narrowBounds = await page.locator('#task-history-list').boundingBox();
  assert.ok(narrowBounds.x >= 0 && narrowBounds.x + narrowBounds.width <= 320, 'Narrow layout stays within the viewport: ' + JSON.stringify(narrowBounds));
  await page.setViewportSize(historyViewport);
  await page.waitForFunction(() => document.querySelector('#task-history-list').classList.contains('is-flyout'));

  const restoredMenuBounds = await page.locator('#submission-menu').boundingBox();
  const restoredHistoryBounds = await page.locator('#task-history-list').boundingBox();
  assert.ok(Math.abs(restoredHistoryBounds.y - restoredMenuBounds.y) < 1);
  assert.ok(Math.abs(restoredHistoryBounds.height - restoredMenuBounds.height) < 1, 'Matching height survives viewport changes');

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#task-history-list').isVisible(), false);
  assert.equal(await page.locator('#submission-menu').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#submission-menu').isVisible(), false);
  await page.locator('#submission-button').click();
  await page.locator('#task-history > summary').click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length), sentBeforeHistory);
  const historyEntry = page.locator('.task-history-disclosure[data-history-id="engine-flow"]');
  assert.equal(await historyEntry.count(), 1, 'One history row represents the whole workflow');
  assert.equal(await historyEntry.locator('.task-history-disclosure').count(), 0, 'Individual stages are not history entries');
  assert.equal(await historyEntry.locator('.task-flow').isVisible(), false, 'History details start collapsed');
  await historyEntry.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await historyEntry.locator('.task-flow').isVisible(), true);
  assert.equal(await historyEntry.locator('.task-flow-list').evaluate(el => getComputedStyle(el).gridAutoFlow), 'column', 'Expanded history keeps the task flow layout');
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-disclosure').first().locator(':scope > summary').click();
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open').first().click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'engine-worker' });

  const historyButtons = page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-open');
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-disclosure').nth(2).locator(':scope > summary').click();
  await page.locator('#task-history-list [data-flow-id="engine-flow"] .task-flow-disclosure').nth(3).locator(':scope > summary').click();
  await historyButtons.nth(2).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-worker' });
  await historyButtons.nth(3).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'second-verifier' });
  await page.locator('#submission-button').click();
  assert.equal(await page.locator('#submission-menu').isVisible(), false);

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
  const sixSteps = page.locator('[data-flow-id="six-flow"] .task-flow-step');
  await page.waitForFunction(() => document.querySelectorAll('[data-flow-id="six-flow"] .task-flow-step').length === 6);
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.taskId)),
    ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']);
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.runId || null)),
    ['shared-run-1', 'shared-run-2', null, null, null, null]);
  assert.equal(await page.locator('[data-flow-id="six-flow"] [aria-current="step"]').count(), 1);
  const sixFlow = page.locator('[data-flow-id="six-flow"]');
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
  await page.waitForFunction(() => document.querySelector('[data-flow-id="six-flow"] [data-task-id="task-2"]').dataset.status === 'failed');
  await page.locator('[data-flow-id="six-flow"]').getByRole('button', { name: '실패한 작업 흐름 종료', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), {
    type: 'workflow.close', workAgentId: 'shared-worker', loopId: 'loop-six'
  });
  await page.evaluate(() => window.postMessage({ type: 'agents.list', agents: [], workflows: [] }, '*'));
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)); });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-flow-id="six-flow"] .task-flow-step').length === 6);
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.status)),
    ['completed', 'failed', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(await page.locator('[data-flow-id="six-flow"] [aria-current="step"]').count(), 0);
  assert.equal(await sixFlow.locator('[data-summary-status="failed"]').textContent(), '실패 1개');
  assert.equal(await sixFlow.locator('.task-flow-current').textContent(), '현재 수행 중인 작업 없음');
  assert.equal(await page.locator('#task-history-list [data-flow-id="engine-flow"]').count(), 1,
    'Accepted completed history survives empty discovery and reload');
  assert.deepEqual(await sixSteps.evaluateAll(items => items.map(item => item.dataset.runId || null)),
    ['shared-run-1', 'shared-run-2', null, null, null, null]);
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('en');
  assert.equal(await sixFlow.locator('.task-flow-total').textContent(), '6 tasks');
  assert.deepEqual(await sixFlow.locator('.task-flow-summary-assignments .task-flow-assignment').allTextContents(),
    ['Worker unassigned', 'Expert unassigned', 'No record: 1']);
  assert.equal(await sixFlow.locator('[data-summary-status="failed"]').textContent(), 'Failed: 1');
  assert.equal(await sixFlow.locator('.task-flow-current').textContent(), 'No task currently running');
  six.workflow.tasks[1].workStatus = 'blocked';
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('[data-flow-id="six-flow"] [data-summary-status="blocked"]').textContent === 'Blocked: 1');
  assert.equal(await sixFlow.locator('[data-summary-status="failed"]').count(), 0);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await sixFlow.locator('.task-flow-summary').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await sixSteps.count(), 6);
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
  await page.reload();
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
    'Restoring completed history must not resume the workflow');
  six.status = 'cancelled';
  six.workflow.tasks[1].workStatus = 'failed';
  six.workflow.tasks.slice(2).forEach(task => { task.workStatus = 'cancelled'; });
  await page.evaluate(six => window.postMessage({ type: 'agents.list', agents: [], workflows: [six] }, '*'), six);
  await page.waitForFunction(() => document.querySelector('#task-history-list [data-flow-id="six-flow"] [data-summary-status="failed"]').textContent === 'Failed: 1');
  assert.equal(await completedSix.getByRole('button', { name: 'Close failed workflow', exact: true }).count(), 0);
  assert.equal(await completedSix.locator('[data-summary-status="cancelled"]').textContent(), 'Cancelled: 4');
  await page.screenshot({ path: '/tmp/af-task-flow.png' });
}
module.exports = { checkTaskFlow };
