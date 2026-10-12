const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkConductorUI(page) {
  const row = (kind, id, payload, version = 1) => ({ key: kind + ':' + id, kind, version, payload });
  const state = [
    row('conductor', 'c1', { id: 'c1', ordinal: 1, status: 'running', slot: 'A', epoch: 1, usage: { usedTokens: 20, contextWindowTokens: 100 } }),
    row('conductor', 'c2', { id: 'c2', ordinal: 2, status: 'running', slot: 'B', epoch: 2, usage: null }),
    ...['r1', 'r2'].map((id, index) => row('request', id, { id, title: index ? 'Timeline task' : 'Composer task', conductorId: 'c' + (index + 1), chatId: 'test', status: 'running', version: 1, receivedAt: 1791828000 + index, firstResponseAt: 1791828001, finalAt: null })),
    ...['w1', 'w2'].map((id, index) => row('worker', id, { id, title: 'Question ' + (index + 1), requestId: 'r' + (index + 1), conductorId: 'c' + (index + 1), chatId: 'test', status: 'awaiting-answer', version: 1, waitReason: 'question' })),
    row('worker', 'w3', { id: 'w3', requestId: 'r1', conductorId: 'c1', title: 'Finished worker', status: 'completed', version: 1, result: { summary: 'Updated composer', changedPaths: ['static/js/chat.js'] } }),
    row('worker', 'w4', { id: 'w4', requestId: 'r2', conductorId: 'c2', title: 'Active worker', status: 'running', version: 1, domain: 'UI' }),
    ...['i1', 'i2'].map((id, index) => row('input', id, { inputId: id, clientMessageId: 'u' + (index + 1), requestId: 'r' + (index + 1), conductorId: 'c' + (index + 1), status: 'routed', acceptedAt: '2026-10-12T18:00:00Z' }))
  ];
  const chat = [
    { role: 'user', clientMessageId: 'u1', text: 'Composer request', inputId: 'i1' },
    { role: 'user', clientMessageId: 'u2', text: 'Timeline request', inputId: 'i2' },
    { role: 'assistant', messageKey: 'reply1', requestId: 'r1', conductorId: 'c1', text: 'Composer progress', final: false },
    { role: 'assistant', messageKey: 'reply2', requestId: 'r2', conductorId: 'c2', text: 'Timeline progress', final: false },
    { role: 'question', requestId: 'r1', conductorId: 'c1', delegationId: 'w1', question: 'worker', text: 'Question one', detail: { questionId: 'q1', taskId: 'task1', decisionKind: 'clarification', reason: 'Output format needed', decision: 'Choose format', impact: 'r1 only', options: [{ value: 'table', label: 'Table' }, { value: 'text', label: 'Text' }] } },
    { role: 'question', requestId: 'r2', conductorId: 'c2', delegationId: 'w2', question: 'worker', text: 'Question two', detail: { questionId: 'q2', taskId: 'task2', decisionKind: 'clarification', reason: 'Approval detail needed', impact: 'r2 only' } },
    { role: 'status', requestId: 'r1', conductorId: 'c1', delegationId: 'w3', status: 'completed' }
  ].map((payload, index) => ({ id: index + 1, kind: 'chat', key: 'message' + index, version: 1, payload: { at: 1791828000 + index, ...payload } }));
  const snapshot = { cursor: chat.length, state, chat };
  const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  async function sync() {
    const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work'] };
    await post({ type: 'host.initialize', panelId: 'conductor-ui-browser', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, model: 'fixture-conductor', agentModels: { work: { model: 'fixture-performer' } }, capabilities: { submit: capability, send: capability } });
    await post({ type: 'conductor.state', enabled: true, role: 'leader' });
    await post({ type: 'conductor.snapshot', snapshot });
  }
  const previousCount = await page.locator('.message').count();
  await sync();
  assert.equal(await page.locator('.conductor-thread').count(), 2);
  assert.equal(await page.locator('.conductor-task-band').count(), 7 + previousCount, 'existing fixture messages are retained and explicitly unassigned');
  assert.match(await page.locator('[data-item-id="status"]').innerText(), /Conductor instances 2/);
  assert.match(await page.locator('[data-item-id="agents"]').innerText(), /Active performers 1.*UI 1/);
  assert.match(await page.locator('[data-item-id="queue"]').innerText(), /Human decisions 2/);
  await page.locator('#conductor-filters button').nth(2).click();
  assert.equal(await page.locator('.conductor-question-card[data-pending="true"]').count(), 2);
  assert.equal(await page.locator('.conductor-question-card .interview-options tbody .interview-choice').count(), 2, 'worker choices remain numbered table controls');
  assert.equal(await page.locator('.message-user').count(), 0);
  await page.locator('.conductor-question-card input').nth(0).fill('Answer for first worker');
  await page.locator('.conductor-question-card button').nth(0).click();
  const answers = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'conductor.control' && message.action === 'answer-worker'));
  assert.equal(answers.at(-1).delegationId, 'w1'); assert.equal(answers.at(-1).text, 'Answer for first worker');
  assert.equal(answers.at(-1).expectedVersion, 1);
  await page.locator('.conductor-question-card button').nth(0).evaluate(button => { button.click(); button.click(); });
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'conductor.control' && message.action === 'answer-worker').length), 1, 'a repeated click cannot submit the same question version twice');
  assert.match(await page.locator('.conductor-question-metadata').nth(0).innerText(), /task1.*q1.*Output format needed.*r1 only/s);
  // A canonical update resolves only its own question, regardless of historical cards.
  await post({ type: 'conductor.feed', entries: [{ id: 8, ...row('worker', 'w1', { ...state.find(row => row.key === 'worker:w1').payload, status: 'running', waitReason: null, version: 2 }, 2), kind: 'state' }] });
  assert.equal(await page.locator('.conductor-question-card[data-pending="true"]').count(), 1);
  await post({ type: 'conductor.feed', entries: [{ id: 8, ...row('worker', 'w1', { ...state.find(row => row.key === 'worker:w1').payload }, 1), kind: 'state' }] });
  assert.equal(await page.locator('.conductor-question-card[data-pending="true"]').count(), 1, 'duplicate feed cannot reopen a resolved question');
  await page.locator('#conductor-target').selectOption('r2');
  assert.equal(await page.locator('.conductor-thread').count(), 1);
  assert.equal(await page.locator('.conductor-thread').getAttribute('data-task-id'), 'r2');
  await page.locator('#prompt').fill('Follow-up for timeline');
  const before = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length);
  await page.locator('#prompt').press('Enter');
  assert.equal(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').length), before, 'unintegrated Host targeting must not silently misroute');
  assert.equal(await page.locator('#prompt').inputValue(), 'Follow-up for timeline');
  assert.match(await page.locator('#input-feedback').innerText(), /Host routing update/);
  // The webview portion of the deferred Host contract: enable only when a patched Host advertises it.
  await post({ type: 'conductor.state', enabled: true, role: 'leader', targeting: true });
  await page.locator('#prompt').press('Enter');
  const followup = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1));
  assert.deepEqual(followup.conductorTarget, { relation: 'followup', requestId: 'r2' });
  assert.equal(followup.text, 'Follow-up for timeline');
  assert.equal(followup.execution.model, 'fixture-conductor');
  assert.equal(followup.execution.agentModels.work.model, 'fixture-performer');
  await page.locator('#conductor-target').selectOption('new');
  await page.locator('#prompt').fill('Independent request'); await page.locator('#prompt').press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1).conductorTarget), { relation: 'new' });
  await page.locator('#conductor-target').selectOption('r2');
  await page.locator('[data-item-id="context"]').click();
  assert.equal(await page.locator('#conductor-sessions li').count(), 2);
  assert.match(await page.locator('#conductor-sessions li').nth(0).innerText(), /Assigned area.*Conductor instance 1.*Handoff slot.*A/s);
  await page.locator('#conductor-sessions button').click();
  assert.match(await page.locator('[data-item-id="context"]').innerText(), /Unavailable/);
  await page.locator('#conductor-target').selectOption('r1');
  assert.match(await page.locator('[data-item-id="context"]').innerText(), /80.0%/);
  if (!(await page.locator('.conductor-worker-summary').evaluate(element => element.open))) await page.locator('.conductor-worker-summary > summary').click();
  await page.locator('.conductor-worker-result').scrollIntoViewIfNeeded();
  assert.match(await page.locator('.conductor-worker-result').innerText(), /Updated composer.*Changed paths/s);
  await page.locator('#conductor-filters button').nth(0).click();
  await page.locator('.conductor-thread[data-task-id="r1"] > summary').click();
  await page.waitForFunction(() => window.saved.conductorView?.collapsed.r1 === true);
  // Restore only view preferences. Runtime state comes from a fresh canonical snapshot.
  // The isolated sending fixture has no Host to acknowledge its two synthetic sends.
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ ...window.saved, pendingRequests: [] })));
  await page.reload(); await sync();
  assert.equal(await page.locator('#conductor-target').inputValue(), 'r1');
  assert.equal(await page.locator('.conductor-thread[data-task-id="r1"]').getAttribute('open'), null);
  assert.equal(await page.locator('.conductor-thread').count(), 2);
  await page.locator('#conductor-filters button').nth(0).click();
  await page.locator('.conductor-thread[data-task-id="r1"]').evaluate(element => { element.open = true; });
  const artifacts = path.resolve(__dirname, '../../../docs/artifact/evidence/chat-ui-conductor-20261012');
  fs.mkdirSync(artifacts, { recursive: true });
  for (const [name, width, height] of [['wide', 1100, 850], ['narrow', 465, 556]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal viewport overflow');
    assert.equal(await page.locator('#prompt').isVisible(), true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#status-bar .status-item')].every(node => { const rect = node.getBoundingClientRect(); return rect.bottom <= innerHeight && rect.right <= innerWidth; })), true, 'all configured status fields remain within the viewport');
    await page.screenshot({ path: path.join(artifacts, name + '.png') });
  }
  await page.goto(page.url().replace(/\?.*$/, '') + '?lang=ko'); await sync();
  assert.match(await page.locator('#conductor-filters').innerText(), /사용자 결정 대기/);
  assert.match(await page.locator('#conductor-models').innerText(), /지휘자 모델.*수행자 기본 모델/);
  for (const [theme, foreground, background, border] of [['light', '#202020', '#ffffff', '#cccccc'], ['high-contrast', '#ffffff', '#000000', '#ffffff']]) {
    await page.evaluate(({ theme, foreground, background, border }) => {
      document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
      document.body.classList.add(theme === 'light' ? 'vscode-light' : 'vscode-high-contrast');
      for (const name of ['foreground', 'editor-foreground', 'input-foreground']) document.documentElement.style.setProperty('--vscode-' + name, foreground);
      for (const name of ['editor-background', 'editorWidget-background', 'input-background']) document.documentElement.style.setProperty('--vscode-' + name, background);
      document.documentElement.style.setProperty('--vscode-panel-border', border);
      document.documentElement.style.setProperty('--vscode-descriptionForeground', foreground);
      document.documentElement.style.setProperty('--vscode-font-size', '18px');
    }, { theme, foreground, background, border });
    await page.setViewportSize({ width: 721, height: 402 });
    await page.screenshot({ path: path.join(artifacts, theme + '-short.png') });
    const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, sendBottom: document.querySelector('#send-button').getBoundingClientRect().bottom, height: innerHeight }));
    assert.ok(bounds.width <= bounds.viewport && bounds.sendBottom <= bounds.height, theme + ' keeps the send control accessible at a short viewport: ' + JSON.stringify(bounds));
  }
  await post({ type: 'conductor.state', enabled: true, role: 'leader', targeting: true });
  const question = 'Question [1/1]: Select output\n\n| Option | Decision | Advantages | Disadvantages |\n| --- | --- | --- | --- |\n| 1 | Table | Easy to compare | Wider |\n| 2 | Text | Compact | Less structured |';
  await post({ type: 'conductor.feed', entries: ['r1', 'r2'].map((requestId, index) => ({ id: 20 + index, kind: 'chat', key: 'choice-' + requestId, version: 3, payload: { role: 'question', requestId, conductorId: 'c' + (index + 1), question: 'conductor', text: question, at: 1791829000 + index } })) });
  assert.equal(await page.locator('.message[data-id^="cq-choice-"] .interview-choice:not([disabled])').count(), 4, 'strictly designated choice tables remain independently answerable per task');
  await page.locator('#conductor-target').selectOption('r1');
  await page.locator('#conductor-filters button').nth(0).click();
  await page.locator('.message[data-task-id="r2"] .interview-choice').nth(1).click();
  const choice = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1));
  assert.equal(choice.text, '2'); assert.deepEqual(choice.conductorTarget, { relation: 'followup', requestId: 'r2' });
  assert.equal(await page.locator('.message[data-id="cq-choice-r1"] .interview-choice:not([disabled])').count(), 2, 'answering another task does not disable this task');
  await page.setViewportSize({ width: 1100, height: 850 });
  // Internal prerequisites, capacity and repair waits never become a Human decision.
  await post({ type: 'conductor.feed', entries: [
    ...['dependency:r1', 'employment-limit', 'internal-recovery'].map((waitReason, index) => ({ id: 30 + index, ...row('worker', 'internal' + index, { id: 'internal' + index, requestId: 'r1', conductorId: 'c1', title: 'Internal wait', status: 'ready', waitReason, version: 1 }), kind: 'state' })),
    { id: 33, ...row('worker', 'internal-question', { id: 'internal-question', requestId: 'r1', conductorId: 'c1', status: 'awaiting-answer', waitReason: 'dependency:r2', version: 1 }), kind: 'state' },
    { id: 34, kind: 'chat', key: 'internal-question', version: 1, payload: { role: 'question', question: 'worker', delegationId: 'internal-question', requestId: 'r1', conductorId: 'c1', text: 'Waiting for a prerequisite', detail: { decisionKind: 'clarification', requiresHuman: false } } }
  ] });
  await page.locator('#conductor-filters button').nth(2).click();
  assert.equal(await page.locator('.message[data-id="cq-internal-question"]').count(), 0, 'internal waits are absent from the Human decision filter');
  assert.match(await page.locator('[data-item-id="queue"]').innerText(), /사용자 결정 대기 2/);
  await page.locator('#conductor-filters button').nth(0).click();
  assert.equal(await page.locator('.message[data-id="cq-internal-question"] input').count(), 0);
  if (!(await page.locator('.conductor-thread[data-task-id="r1"]').evaluate(thread => thread.open))) await page.locator('.conductor-thread[data-task-id="r1"] > summary').click();
  const internal = page.locator('.message[data-id="cq-internal-question"]');
  await internal.scrollIntoViewIfNeeded();
  assert.match(await internal.innerText(), /내부 대기/);
  assert.match(await page.locator('[data-item-id="agents"]').innerText(), /수행자 활성 1/);
  // Current runtime projection: durable question rows may precede the chat event.
  const nativeQuestion = { id: 'q-native', kind: 'conductor', state: 'pending', request_id: 'r2', conductor_id: 'c2', slot: 'B', epoch: 2, text: 'Choose the final style' };
  await post({ type: 'conductor.feed', entries: [{ id: 40, ...row('question', 'q-native', nativeQuestion), kind: 'state' }] });
  await page.locator('#conductor-filters button').nth(2).click();
  const nativeCard = page.locator('.message[data-id="cq-question-q-native"]');
  assert.equal(await nativeCard.count(), 1, 'a committed question is visible even before its chat delivery');
  await nativeCard.locator('input').fill('Compact style');
  await post({ type: 'conductor.feed', entries: [
    { id: 41, ...row('request', 'r2', { ...state.find(item => item.key === 'request:r2').payload, version: 2, ownerEpoch: 2 }, 2), kind: 'state' },
    { id: 42, ...row('conductor', 'c2', { ...state.find(item => item.key === 'conductor:c2').payload, slot: 'A', epoch: 3, area: { domain: 'UI', subdomain: 'Chat' } }, 2), kind: 'state' },
    { id: 43, ...row('question', 'q-native', { ...nativeQuestion, slot: 'A', epoch: 3 }, 2), kind: 'state' }
  ] });
  assert.equal(await nativeCard.locator('input').inputValue(), 'Compact style', 'the same question draft survives handoff');
  await nativeCard.locator('button').filter({ hasText: '답변' }).click();
  const nativeAnswer = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'conductor.control' && message.action === 'answer-question').at(-1));
  assert.equal(nativeAnswer.questionId, 'q-native'); assert.equal(nativeAnswer.requestId, 'r2'); assert.equal(nativeAnswer.expectedVersion, 2);
  await post({ type: 'conductor.feed', entries: [{ id: 44, ...row('question', 'q-native', { ...nativeQuestion, state: 'answered' }, 3), kind: 'state' }] });
  assert.equal(await nativeCard.count(), 0);
  await post({ type: 'conductor.feed', entries: [{ id: 45, ...row('question', 'q-native', nativeQuestion, 2), kind: 'state' }] });
  assert.equal(await nativeCard.count(), 0, 'replay cannot reopen an answered question');
  const catalog = { domains: [{ id: 'domain-ui', name: 'Main UI' }], subdomains: [{ id: 'sub-chat', domainId: 'domain-ui', name: 'Chat' }] };
  const areaQuestion = { id: 'q-area', kind: 'area', state: 'pending', input_id: 'input-area', text: 'Choose the assigned area' };
  await post({ type: 'conductor.feed', entries: [
    { id: 46, ...row('input', 'input-area', { inputId: 'input-area', status: 'held', waitReason: 'area-required', catalog }), kind: 'state' },
    { id: 47, ...row('question', 'q-area', areaQuestion), kind: 'state' }
  ] });
  const areaCard = page.locator('.message[data-id="cq-question-q-area"]');
  await areaCard.scrollIntoViewIfNeeded();
  assert.match(await areaCard.locator('select').nth(0).innerText(), /Main UI/, 'user domain names are preserved');
  await areaCard.locator('select').nth(0).selectOption('domain-ui'); await areaCard.locator('select').nth(1).selectOption('sub-chat');
  await areaCard.locator('button').filter({ hasText: '답변' }).click();
  const areaAnswer = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'conductor.control' && message.action === 'resolve-area').at(-1));
  assert.equal(areaAnswer.inputId, 'input-area'); assert.deepEqual(areaAnswer.area, { domainId: 'domain-ui', subdomainId: 'sub-chat' });
  await page.locator('[data-item-id="context"]').click();
  assert.match(await page.locator('#conductor-sessions li').nth(1).innerText(), /UI \/ Chat.*교대 슬롯.*A/s);
  await page.locator('#conductor-sessions button').click();
}
module.exports = { checkConductorUI };
