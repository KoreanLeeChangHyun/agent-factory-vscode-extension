const assert = require('node:assert/strict');
const path = require('node:path');
// Control center: the kanban's five working columns, the card summary, rework of an ended task, the supervision
// report and provider handoff. Runs on the /center fixture page served by chat-rendering.cjs.
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

  // Supervision report: one request per click; verdicts in the order the reader acts, codes in words.
  const supervision = page.locator('#maestro-supervision');
  assert.equal(await supervision.textContent(), '감독 보고');
  await supervision.click();
  assert.equal((await sent('supervision.request')).length, 1);
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-view'), 'supervision');
  assert.match(await page.locator('#maestro-detail').textContent(), /확인 중…/);
  const verdict = (loopId, taskId, title, verdict, state, reasons, extra = {}) => ({ loopId, taskId, title, verdict, state, reasons, elapsedSeconds: 7200, idleSeconds: 3900, nextAction: 'runtime text', ...extra });
  await post({ type: 'supervision.report', report: { observedAt: at(0), settings: { delayMinutes: 20, stuckMinutes: 60 }, alerts: [], errors: ['TypeError: one unreadable loop'], verdicts: [
    verdict('loop-flow-run', 'task-run', 'Running task', 'normal', 'running', [], { idleSeconds: 30 }),
    verdict('loop-flow-old', 'task-x', 'Stopped task', 'stuck', 'blocked', ['loop-stopped:environment:failed']),
    verdict('loop-flow-check', 'task-check', 'Checked task', 'delayed', 'running', ['repeated-error:dispatch_failedx3']),
    verdict('loop-flow-decide', 'task-decide', 'Decision task', 'decision-needed', 'waiting-decision', ['decision-pending'], { decisionId: 'decision-1' })] } });
  const items = page.locator('.maestro-supervision-item');
  assert.deepEqual(await items.evaluateAll(values => values.map(value => value.dataset.verdict)), ['decision-needed', 'stuck', 'delayed', 'normal']);
  assert.deepEqual(await page.locator('.maestro-supervision-counts .maestro-state').allTextContents(), ['결정 필요 1', '정체 1', '지연 1', '정상 진행 1']);
  assert.match(await items.nth(1).textContent(), /정체.*막힘 · 경과 2시간 · 활동 없음 1.1시간 · 실행 정지 \(environment · failed\)/);
  assert.match(await items.nth(2).textContent(), /같은 오류 3회 반복 \(dispatch_failed\)/);
  assert.equal(await items.nth(0).locator('.maestro-freshness').getAttribute('title'), 'runtime text', 'The runtime next action stays available');
  assert.match(await page.locator('#maestro-detail').textContent(), /읽지 못한 기록TypeError: one unreadable loop/);
  // Decision needed: answered in the task's Main conversation, where the existing decision card lives.
  await items.nth(0).getByRole('button', { name: '결정 응답 열기' }).click();
  assert.deepEqual((await sent('project.task.open')).at(-1), { type: 'project.task.open', workflowId: 'flow-decide', taskId: 'task-decide', target: 'chat' });
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-supervision.png') });
  await page.getByRole('button', { name: '다시 확인' }).click();
  assert.equal((await sent('supervision.request')).length, 2);
  await post({ type: 'supervision.report', error: 'operation_records.py unavailable' });
  assert.match(await page.locator('#maestro-detail [role="alert"]').textContent(), /감독 보고를 읽지 못했습니다: operation_records.py unavailable/);
  assert.equal(await items.count(), 4, 'A failed refresh keeps the last report');
  // A verdict title opens its task.
  await items.nth(3).locator('.maestro-supervision-title').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'), 'task-run');

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
  await page.locator('#maestro-command-input').fill('테스트도 함께 확인하십시오.');
  await page.locator('#maestro-detail .maestro-command-form button[type="submit"]').first().click();
  request = (await sent('worker.command')).at(-1);
  assert.equal(request.agentId, 'worker-run');
  assert.equal(request.loopId, 'loop-flow-run');
  assert.equal(request.rework, undefined);
  await post({ type: 'worker.result', action: 'worker.command', agentId: 'worker-run', commandId: request.commandId, result: { mode: 'addition', loopId: 'loop-flow-run', runId: 'run-worker-run' } });
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-worker-message.png') });

  // Provider handoff: a detected model other than the current one, a reason, then loop.py handoff through the host.
  const handoff = page.locator('#maestro-detail [data-handoff-worker="worker-run"]');
  assert.equal(await handoff.textContent(), '공급자 이관');
  await handoff.click();
  assert.equal((await sent('handoff.models.request')).length, 1);
  assert.match(await page.locator('#maestro-handoff-model').textContent(), /감지된 모델 확인 중/);
  await post({ type: 'handoff.models', models: [{ id: 'model-worker-run', provider: 'codex' }, { id: 'claude-opus-5-5', provider: 'claude' }, { id: 'gpt-6-luna', provider: 'codex' }] });
  assert.deepEqual(await page.locator('#maestro-handoff-model option').allTextContents(), ['claude-opus-5-5 · claude', 'gpt-6-luna · codex'], 'The current model is not offered');
  assert.deepEqual(await page.locator('#maestro-handoff-task option').allTextContents(), ['Running task · 실행 중'], 'Only this worker\'s unfinished loop can move');
  const handoffSend = page.locator('.maestro-handoff-form button[type="submit"]');
  await handoffSend.click();
  assert.equal((await sent('worker.handoff')).length, 0, 'A reason is required');
  await page.locator('#maestro-handoff-model').selectOption('claude-opus-5-5');
  await page.locator('#maestro-handoff-reason').fill('공급자 한도 소진');
  await handoffSend.click();
  assert.deepEqual((await sent('worker.handoff')).at(-1), { type: 'worker.handoff', agentId: 'worker-run', loopId: 'loop-flow-run', toModel: 'claude-opus-5-5', reason: '공급자 한도 소진' });
  assert.equal(await page.locator('#maestro-detail [data-handoff-worker="worker-run"]').textContent(), '이관 중…');
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-handoff-form.png') });
  // A refusal is shown on the worker; success closes the form and the recorded handoff appears after the refresh.
  await post({ type: 'worker.result', action: 'worker.handoff', agentId: 'worker-run', error: 'Answer or close the pending decision before a handoff', code: 'decision_pending' });
  assert.match(await page.locator('.maestro-worker-notice').textContent(), /실패: Answer or close the pending decision/);
  assert.equal(await page.locator('#maestro-handoff-reason').inputValue(), '공급자 한도 소진', 'The typed reason survives a refusal');
  await handoffSend.click();
  await post({ type: 'worker.result', action: 'worker.handoff', agentId: 'worker-run', result: { id: 'handoff-1', toAgentId: 'work-handoff-1' } });
  assert.equal(await page.locator('.maestro-handoff-form').count(), 0);
  const handedOff = entries.map(entry => entry.id !== 'flow-run' ? entry : { ...entry, handoffs: [{ id: 'handoff-1', taskId: 'task-run', fromAgentId: 'worker-run', toAgentId: 'work-handoff-1',
    fromProvider: 'codex', toProvider: 'claude', fromModel: 'model-worker-run', toModel: 'claude-opus-5-5', reason: '공급자 한도 소진', actor: 'human', createdAt: at(0) }] });
  await post({ type: 'project.tasks', entries: handedOff });
  const record = page.locator('.maestro-handoffs [data-handoff-id="handoff-1"]');
  assert.match(await record.textContent(), /내보냄.*사용자.*model-worker-run · codex → claude-opus-5-5 · claude.*Running task · worker-run → work-handoff-1.*공급자 한도 소진/);
  if (process.env.CONTROL_SCREENS_EVIDENCE) await page.screenshot({ path: path.join(process.env.CONTROL_SCREENS_EVIDENCE, 'after-fixture-handoff-record.png') });
  // A worker with only ended tasks has nothing to move.
  await page.locator('[data-select-worker="worker-done"]').click();
  assert.equal(await page.locator('#maestro-detail [data-handoff-worker="worker-done"]').isDisabled(), true);
  assert.deepEqual(errors, []);
  await page.close();
}
module.exports = { checkControlScreens };
