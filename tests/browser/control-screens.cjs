const assert = require('node:assert/strict');
const path = require('node:path');
// Control center: the kanban's five working columns, the card summary, rework of an ended task and the kept places
// for supervision report and provider handoff. Runs on the /center fixture page served by chat-rendering.cjs.
async function checkControlScreens(chatPage) {
  const page = await chatPage.context().browser().newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.saved = {}; window.sentMessages = [];
    window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => { window.saved = value; }, postMessage: message => window.sentMessages.push(message) });
  });
  await page.goto(new URL('/center?lang=ko', chatPage.url()).href);
  const post = message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message);
  const sent = type => page.evaluate(type => window.sentMessages.filter(value => value.type === type), type);
  const now = Date.now(), at = minutes => new Date(now - minutes * 60_000).toISOString();
  const work = (agentId, status, extra = {}) => ({ role: 'work', agentId, runId: 'run-' + agentId, status, model: 'model-' + agentId, startedAt: at(12), updatedAt: at(2), ...extra });
  const flow = (id, agentId, status, task) => ({ id, title: id, mainAgentId: 'main-a', loopId: 'loop-' + id, workAgentId: agentId, status, updatedAt: at(1), tasks: [task] });
  const entries = [
    flow('flow-wait', 'worker-wait', 'active', { id: 'task-wait', title: 'Waiting task', workStatus: 'pending', workAgentId: 'worker-wait' }),
    flow('flow-run', 'worker-run', 'active', { id: 'task-run', title: 'Running task', description: '# Brief: connect the board\nmore', workStatus: 'running', workAgentId: 'worker-run', runs: [work('worker-run', 'running')] }),
    flow('flow-check', 'worker-check', 'active', { id: 'task-check', title: 'Checked task', workStatus: 'completed', verificationStatus: 'running', workAgentId: 'worker-check', verificationAgentId: 'verifier-a',
      runs: [work('worker-check', 'completed', { receipt: { outcome: 'completed' } }), { role: 'verification', agentId: 'verifier-a', runId: 'run-v', status: 'running', startedAt: at(3) }] }),
    flow('flow-decide', 'worker-decide', 'needs-human-decision', { id: 'task-decide', title: 'Decision task', workStatus: 'blocked', workAgentId: 'worker-decide', runs: [work('worker-decide', 'needs-human-decision')] }),
    flow('flow-done', 'worker-done', 'completed', { id: 'task-done', title: 'Done task', description: '# Brief: Fix the empty state\n\n## Goal\nShow it', workStatus: 'completed', verificationDisposition: 'not-requested', verificationStatus: 'pending', workAgentId: 'worker-done',
      runs: [work('worker-done', 'completed', { finishedAt: at(5), receipt: { outcome: 'completed' }, result: { availability: 'recorded', summary: '사용자님, 빈 상태 문구를 고쳤습니다. 테스트도 통과했습니다.' } })] }),
    // The same worker ended this task earlier and now runs another one: a rework must wait.
    flow('flow-busy-old', 'worker-run', 'completed', { id: 'task-busy-old', title: 'Earlier task of a busy worker', workStatus: 'completed', workAgentId: 'worker-run',
      runs: [work('worker-run', 'completed', { runId: 'run-old', receipt: { outcome: 'completed' } })] })];
  await post({ type: 'project.tasks', entries });

  // Kept places: visible, focusable and inert until their commands exist.
  const supervision = page.locator('#maestro-supervision');
  assert.equal(await supervision.getAttribute('aria-disabled'), 'true');
  assert.equal(await supervision.textContent(), '감독 보고');
  assert.match(await supervision.getAttribute('title'), /연결되면/);
  await supervision.click({ force: true });

  // Kanban: waiting, running, check, decision, completed, then ended; each task in exactly one column.
  await page.locator('#maestro-tasks-view').click();
  assert.deepEqual(await page.locator('.maestro-column').evaluateAll(columns => columns.map(column => column.dataset.column)), ['waiting', 'running', 'verifying', 'decision', 'completed', 'ended']);
  const column = id => page.locator('.maestro-column[data-column="' + id + '"] .maestro-card').evaluateAll(cards => cards.map(card => card.dataset.centerTask));
  assert.deepEqual(await column('waiting'), ['flow-wait/task-wait']);
  assert.deepEqual(await column('running'), ['flow-run/task-run']);
  assert.deepEqual(await column('verifying'), ['flow-check/task-check'], 'Ended work under Verification is in the check column, not with running work');
  assert.deepEqual(await column('decision'), ['flow-decide/task-decide']);
  assert.deepEqual((await column('completed')).sort(), ['flow-busy-old/task-busy-old', 'flow-done/task-done']);
  assert.equal(await page.locator('.maestro-column[data-column="verifying"] .maestro-column-title').textContent(), '검사1');
  assert.equal(await page.locator('.maestro-column[data-column="verifying"] .maestro-state').first().getAttribute('data-status'), 'verifying');
  // State is text plus a small dot; columns and cards keep one neutral border.
  const borders = await page.locator('.maestro-card').evaluateAll(cards => [...new Set(cards.map(card => getComputedStyle(card).borderTopColor))]);
  assert.equal(borders.length, 1, 'No status-coloured card borders');

  // Card click: request, progress and result summary first.
  await page.locator('[data-center-task="flow-done/task-done"]').click();
  const summary = page.locator('#maestro-detail .maestro-summary');
  assert.deepEqual(await summary.locator('dt').allTextContents(), ['요청', '진행', '결과']);
  assert.equal(await summary.locator('dd').nth(0).textContent(), 'Brief: Fix the empty state');
  assert.match(await summary.locator('dd').nth(1).textContent(), /^작업 완료 · 검사 요청되지 않음 · /);
  assert.equal(await summary.locator('dd').nth(2).textContent(), '빈 상태 문구를 고쳤습니다.');
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-task-detail.png') });

  // Rework: a new task in the same worker's session, linked to this ended task; the field keeps line breaks.
  const input = page.locator('#maestro-rework-input');
  assert.match(await page.locator('.maestro-rework .maestro-command-target').textContent(), /worker-done 세션의 새 작업/);
  await input.fill('빈 상태 문구를\n두 줄로 나누십시오.');
  await page.locator('.maestro-rework button[type="submit"]').click();
  let request = (await sent('worker.command')).at(-1);
  assert.deepEqual({ ...request, commandId: undefined }, { type: 'worker.command', agentId: 'worker-done', text: '빈 상태 문구를\n두 줄로 나누십시오.', commandId: undefined, rework: { workflowId: 'flow-done', taskId: 'task-done' } });
  assert.equal(await page.locator('.maestro-rework button[type="submit"]').isDisabled(), true, 'One send at a time');
  await post({ type: 'worker.result', action: 'worker.command', agentId: 'worker-done', commandId: request.commandId, result: { mode: 'task', loopId: 'loop-rework', rework: { workflowId: 'flow-done', taskId: 'task-done' } } });
  const history = page.locator('.maestro-rework .maestro-command');
  assert.equal(await history.count(), 1);
  assert.match(await history.textContent(), /재작업.*사용자.*접수됨/);
  assert.match(await history.textContent(), /loop-rework/);
  assert.equal(await input.inputValue(), '', 'The sent rework clears only its own field');
  // A refused rework keeps the text and shows why.
  await input.fill('다시');
  await page.locator('.maestro-rework button[type="submit"]').click();
  request = (await sent('worker.command')).at(-1);
  await post({ type: 'worker.result', action: 'worker.command', agentId: 'worker-done', commandId: request.commandId, error: 'The worker is running another task', code: 'worker_rework_busy' });
  assert.match(await history.first().textContent(), /전송 실패: The worker is running another task/);
  assert.equal(await input.inputValue(), '다시');
  // The worker's own detail lists the rework among its commands as well.
  await post({ type: 'project.tasks', entries });
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-rework.png') });

  // Busy worker: rework of its earlier task waits; running and checked tasks offer no rework at all.
  await page.locator('[data-center-task="flow-busy-old/task-busy-old"]').click();
  assert.equal(await page.locator('#maestro-rework-input').isDisabled(), true);
  assert.match(await page.locator('.maestro-rework .maestro-command-target').textContent(), /실행 중입니다/);
  for (const task of ['flow-run/task-run', 'flow-check/task-check']) {
    await page.locator('[data-center-task="' + task + '"]').click();
    assert.equal(await page.locator('.maestro-rework').count(), 0, task + ' is not ended');
  }

  // Direct message to a running worker: an addition bound to its exact loop and run.
  await page.locator('#maestro-workers-view').click();
  await page.locator('[data-select-worker="worker-run"]').click();
  const handoff = page.locator('#maestro-detail [data-pending-command="provider-switch"]');
  assert.equal(await handoff.getAttribute('aria-disabled'), 'true');
  await handoff.click({ force: true });
  await page.locator('#maestro-command-input').fill('테스트도 함께 확인하십시오.');
  await page.locator('#maestro-detail .maestro-command-form button[type="submit"]').first().click();
  request = (await sent('worker.command')).at(-1);
  assert.equal(request.agentId, 'worker-run');
  assert.equal(request.loopId, 'loop-flow-run');
  assert.equal(request.rework, undefined);
  await post({ type: 'worker.result', action: 'worker.command', agentId: 'worker-run', commandId: request.commandId, result: { mode: 'addition', loopId: 'loop-flow-run', runId: 'run-worker-run' } });
  // Kept places never send anything.
  assert.deepEqual((await page.evaluate(() => window.sentMessages)).filter(value => !['client.ready', 'worker.command', 'project.tasks.request'].includes(value.type)), []);
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-worker-message.png') });
  assert.deepEqual(errors, []);
  await page.close();
}
module.exports = { checkControlScreens };
