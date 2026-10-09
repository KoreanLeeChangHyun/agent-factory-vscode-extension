const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkTaskAnimation(page) {
  const enforce = process.env.AF_TASK_ANIMATION_ASSERT !== '0';
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 800, height: 740 });
  await emit({ type: 'host.initialize', panelId: 'animation-panel', agentId: 'animation-main', role: 'main', runtimeAvailable: true, botsEnabled: false, companionAvailable: false });
  let agents = ['first', 'second', 'third'].map((id, index) => ({ agentId: 'worker-' + id, runId: 'run-' + id,
    role: 'work', status: 'running', workProfile: index === 1 ? 'scribe' : 'work', model: 'gpt-6.1-sol',
    progressKey: ['ui.context.compaction.started', 'flow.activity.reasoning', 'ui.finalizing.response'][index],
    taskBinding: { workflowId: 'animation-flow', workflowTitle: '동시 작업 애니메이션', taskId: id, title: '작업 ' + id, description: '실제 실행 상태 표시' } }));
  let flow = { id: 'animation-flow', title: '동시 작업 애니메이션', tasks: agents.map(agent => ({ id: agent.taskBinding.taskId,
    title: agent.taskBinding.title, status: 'running', agentId: agent.agentId, runId: agent.runId })) };
  const announce = () => emit({ type: 'chat.assistant', runId: 'animation-main-run', phase: 'commentary', text: '```task-flow\n' + JSON.stringify(flow) + '\n```' });
  const refresh = async () => { await emit({ type: 'agents.list', agents }); await paint(); };
  await refresh();
  await announce();
  await paint();
  const rows = page.locator('#run-stage-list [data-flow-id="animation-flow"] [data-task-id]');
  assert.equal(await rows.count(), 3);
  const sample = () => page.evaluate(() => Array.from(document.querySelectorAll('#run-stage-list [data-flow-id="animation-flow"] [data-task-id]'), row => {
    const pulse = row.querySelector('.task-flow-state > .run-status-pulse');
    const model = row.querySelector('.task-flow-model');
    const animations = element => element ? element.getAnimations({ subtree: true }).filter(animation => animation.effect.target === element).map(animation => ({ name: animation.animationName,
      pseudo: animation.effect.pseudoElement || '', time: animation.currentTime, state: animation.playState })) : [];
    return { id: row.dataset.taskId, pulse: !!pulse, observed: row.querySelector('.task-flow-state').dataset.observedStatus,
      core: pulse ? getComputedStyle(pulse).transform : '', ring: pulse ? getComputedStyle(pulse, '::before').opacity : '',
      modelPosition: getComputedStyle(model).backgroundPosition, animations: [...animations(pulse).map(a => ({ ...a, kind: 'pulse' })), ...animations(model).map(a => ({ ...a, kind: 'model' })), ...animations(row).map(a => ({ ...a, kind: 'row' }))] };
  }));
  const initial = await sample();
  await page.waitForTimeout(260);
  const moving = await sample();
  for (const item of moving) {
    assert.equal(item.pulse, true, item.id + ' has the same actual-running indicator regardless of row position or progress phase');
    assert.ok(item.animations.some(a => a.name === 'run-status-dot-breathe'));
    assert.equal(item.animations.filter(a => a.name === 'run-status-dot-ripple').length, 2);
    const before = initial.find(a => a.id === item.id);
    assert.notEqual(item.core, before.core, 'Native pulse transform moves over time');
    assert.notEqual(item.ring, before.ring, 'Native ring opacity moves over time');
    assert.notEqual(item.modelPosition, before.modelPosition, 'Model scan moves over time');
  }
  const regressions = [];
  const continuity = async (before, scenario) => {
    const after = await sample();
    for (const row of before) {
      const next = after.find(item => item.id === row.id);
      assert.ok(next, 'Task remains present during ' + scenario);
      for (const animation of row.animations) {
        const current = next.animations.find(item => item.kind === animation.kind && item.name === animation.name && item.pseudo === animation.pseudo);
        assert.ok(current, 'Existing animation remains active during ' + scenario);
        if (current.time < animation.time - 2) regressions.push({ scenario, task: row.id, kind: animation.kind, pseudo: animation.pseudo, before: animation.time, after: current.time });
      }
    }
  };
  for (let index = 0; index < 6; index++) {
    const before = await sample();
    agents = agents.map((agent, i) => ({ ...agent, progressKey: i === 0 ? index % 2 ? 'ui.context.compaction.started' : 'flow.activity.reasoning' : agent.progressKey,
      updatedAt: 'snapshot-' + index }));
    await refresh();
    await continuity(before, 'progress-' + index);
    await page.waitForTimeout(100);
  }
  const beforeOrder = await sample();
  flow = { ...flow, tasks: [flow.tasks[1], flow.tasks[2], flow.tasks[0]] };
  await announce();
  await paint();
  assert.deepEqual(await rows.evaluateAll(items => items.map(row => row.dataset.taskId)), ['second', 'third', 'first']);
  await continuity(beforeOrder, 'reorder');
  const artifactDir = process.env.AF_TASK_ANIMATION_ARTIFACT_DIR;
  if (artifactDir) {
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, (enforce ? 'after' : 'before') + '-running.png') });
  }
  // A lifecycle stop and a new run are genuine changes, rather than a continuation of old animation time.
  agents[0] = { ...agents[0], status: 'queued' };
  await refresh();
  assert.equal((await sample()).find(row => row.id === 'first').pulse, false);
  agents[0] = { ...agents[0], status: 'running', runId: 'run-first-revision' };
  await refresh();
  const restarted = (await sample()).find(row => row.id === 'first');
  assert.equal(restarted.pulse, true);
  assert.ok(restarted.animations.every(animation => animation.time < 120), 'A new run gets its own animation phase');
  agents[0] = { ...agents[0], status: 'needs-human-decision' };
  await refresh();
  assert.equal((await sample()).find(row => row.id === 'first').pulse, false);

  // An active workflow is not proof that a particular completed or mismatched run is still executing.
  const engine = { loopId: 'animation-engine', status: 'active', taskMode: 'work', workAgentId: 'worker-first',
    workflow: { id: 'animation-engine-flow', title: '실행 관측 확인', tasks: [{ id: 'engine-task', title: '워크플로 단계', workStatus: 'running', workRunId: 'run-first-revision' }] } };
  agents[0] = { ...agents[0], status: 'completed' };
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  const engineState = page.locator('#run-stage-list [data-flow-id="animation-engine-flow"] .task-flow-state');
  const terminalPulse = await engineState.locator('.run-status-pulse').count();
  if (enforce) assert.equal(terminalPulse, 0, 'A matching terminal run must not acquire a fake active pulse from workflow status');
  agents[0] = { ...agents[0], status: 'running', runId: 'different-current-run' };
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  assert.equal(await engineState.locator('.run-status-pulse').count(), 0, 'Another run of the same agent does not animate this task');
  agents[0] = { ...agents[0], runId: 'run-first-revision' };
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  assert.equal(await engineState.locator('.run-status-pulse').count(), 1, 'A matching observed running run supplies the pulse');

  // Reproduce the supplied still image's first static dot and two animated rows with explicit run bindings.
  await emit({ type: 'host.initialize', panelId: 'animation-panel', agentId: 'animation-main', role: 'main', runtimeAvailable: true,
    resetConversation: true, botsEnabled: false, companionAvailable: false });
  engine.workflow.tasks = agents.map((agent, index) => ({ id: 'mixed-' + index, title: '관측 작업 ' + (index + 1), workStatus: 'running',
    workAgentId: agent.agentId, workRunId: index === 0 ? 'unobserved-run' : agent.runId, workModel: agent.model, workProfile: agent.workProfile }));
  agents = agents.map(agent => ({ ...agent, taskBinding: undefined }));
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  const mixed = page.locator('#run-stage-list [data-flow-id="animation-engine-flow"]');
  assert.deepEqual(await mixed.locator('.task-flow-state').evaluateAll(nodes => nodes.map(node => !!node.querySelector('.run-status-pulse'))), [false, true, true]);
  assert.equal(await mixed.locator('.task-flow-model').first().getAttribute('data-running'), 'false', 'A static status also has no invented model scan');
  if (artifactDir && enforce) await mixed.screenshot({ path: path.join(artifactDir, 'missing-run-static.png') });
  engine.workflow.tasks[0].workRunId = agents[0].runId;
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  assert.deepEqual(await mixed.locator('.task-flow-state').evaluateAll(nodes => nodes.map(node => !!node.querySelector('.run-status-pulse'))), [true, true, true]);

  // Hidden document CSS pauses the same clocks, including across a row refresh.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await paint();
  const pausedTimes = () => mixed.evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.animationName === 'run-status-dot-breathe').map(a => ({ time: a.currentTime, state: a.playState })));
  const paused = await pausedTimes();
  assert.ok(paused.length === 3 && paused.every(a => a.state === 'paused'));
  await page.waitForTimeout(120);
  agents[0] = { ...agents[0], progressKey: 'flow.activity.reasoning' };
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  const pausedAfter = await pausedTimes();
  const pausedContinuous = pausedAfter.every((a, index) => a.state === 'paused' && Math.abs(a.time - paused[index].time) <= 2);
  if (enforce) assert.ok(pausedContinuous, 'Paused clocks survive a refresh without advancing');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await paint();
  await page.waitForTimeout(160);
  assert.ok((await pausedTimes()).every((a, index) => a.state === 'running' && a.time > paused[index].time + 100));

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await paint();
  assert.equal(await mixed.evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'Reduced motion provides a static alternative');
  assert.equal(await mixed.locator('.run-status-pulse').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await mixed.locator('.run-status-pulse').first().evaluate(node => getComputedStyle(node, '::before').content), 'none');
  await emit({ type: 'agents.list', agents, workflows: [engine] });
  await paint();
  assert.equal(await mixed.locator('.run-status-pulse').count(), 3, 'Static active statuses still have meaningful dots');
  if (artifactDir && enforce) await page.screenshot({ path: path.join(artifactDir, 'reduced-motion.png') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const theme of ['dark', 'light']) for (const width of [320, 795]) {
    await page.setViewportSize({ width, height: 740 });
    await page.evaluate(theme => {
      const light = theme === 'light', root = document.documentElement;
      document.body.className = 'vscode-' + theme;
      for (const name of ['foreground', 'editor-foreground', 'terminal-foreground']) root.style.setProperty('--vscode-' + name, light ? '#333333' : '#d4d4d4');
      for (const name of ['editor-background', 'terminal-background']) root.style.setProperty('--vscode-' + name, light ? '#ffffff' : '#1e1e1e');
      root.style.setProperty('--vscode-editorWidget-background', light ? '#f3f3f3' : '#252526');
      root.style.setProperty('--vscode-descriptionForeground', light ? '#555555' : '#aaaaaa');
      root.style.setProperty('--vscode-textLink-foreground', light ? '#005fb8' : '#3794ff');
      root.style.colorScheme = light ? 'light' : 'dark';
    }, theme);
    await paint();
    const before = await pausedTimes();
    await page.waitForTimeout(100);
    const after = await pausedTimes();
    assert.ok(after.every((a, i) => a.time > before[i].time + 60), 'Every actual-running task moves in ' + theme + '/' + width);
    assert.equal(await mixed.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Task rows fit the panel width');
    if (artifactDir && enforce) await page.screenshot({ path: path.join(artifactDir, 'running-' + theme + '-' + width + '.png') });
  }
  const report = { initial, moving, animationResetCount: regressions.length, regressions, terminalPulse, pausedContinuous, actualTimeSampling: true };
  if (process.env.AF_TASK_ANIMATION_REPORT) fs.writeFileSync(process.env.AF_TASK_ANIMATION_REPORT, JSON.stringify(report, null, 2));
  console.log('Task animation own check: ' + JSON.stringify({ animationResetCount: regressions.length, terminalPulse, movingTasks: moving.length, samples: 6, reordered: true, reducedMotion: true }));
  if (enforce) assert.deepEqual(regressions, [], 'Status refresh and task order changes preserve the native animation clock');
}
module.exports = { checkTaskAnimation };
