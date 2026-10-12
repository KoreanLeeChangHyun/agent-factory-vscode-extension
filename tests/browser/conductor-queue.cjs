const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Real plugin runtime (conductor_queue.py serve, fake conductor/worker drivers) + the extension's
 * ConductorQueueChannel + the real chat webview. The glue below mirrors ChatPanelManager's
 * conductor forwarding; the VS Code Extension Host itself is not part of this check.
 */
async function checkConductorQueue(page) {
  const pluginRoot = process.env.AGENT_FACTORY_PLUGIN_SOURCE || path.resolve(__dirname, '../../../plugin');
  const script = path.join(pluginRoot, 'scripts', 'conductor_queue.py');
  assert.ok(fs.existsSync(script), 'plugin source with conductor_queue.py is required: ' + script);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cq-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cq-project-'));
  const env = { ...process.env, AGENT_FACTORY_HOME: home };
  delete env.AGENT_FACTORY_CODEX_POOL;
  execFileSync('python3', ['-c', 'import sys; from storage import paths; paths.resolve(sys.argv[1], create=True)', project],
    { env: { ...env, PYTHONPATH: path.join(pluginRoot, 'runtime') } });
  const { importTypeScript } = await import('../support/import-typescript.mjs');
  const { ConductorQueueChannel } = await importTypeScript('src/infrastructure/agent-factory/conductor-queue-client.ts');
  const channel = new ConductorQueueChannel(async () => ({ executable: 'python3', args: [script, 'serve', '--project-root', project, '--conductor-delay', '0.5'], env }));
  const chatId = 'panel-browser';
  const post = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message).catch(() => undefined);
  const timings = { accepted: [], firstReply: [], finalReply: [], uiLag: [] };
  let handled = 0, commandSequence = 0, stopped = false, center, centerHandled = 0, centerReady = false;
  const centerPost = message => center ? center.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message).catch(() => undefined) : undefined;
  channel.onLine(line => {
    if (centerReady && line.type === 'feed') {
      const states = line.entries.filter(entry => entry.kind === 'state');
      if (states.length) void centerPost({ type: 'conductor.feed', cursor: line.cursor, entries: states, emittedAt: line.emittedAt });
    }
    if (line.type === 'feed') {
      const entries = line.entries.filter(entry => entry.chatId === chatId);
      const received = Date.now();
      for (const entry of entries) timings.uiLag.push(received - entry.eventAt * 1000);
      if (entries.length) void post({ type: 'conductor.feed', cursor: line.cursor, entries, emittedAt: line.emittedAt });
    } else if (line.type === 'role') void post({ type: 'conductor.state', enabled: true, targeting: true, role: line.role });
  });
  const policy = { approvalPolicy: 'bypass', reference: 'browser integration check', executor: 'fake', conductor: 'fake' };
  async function sync() {
    await channel.request('ensure-chat', { chatId, policy });
    await post({ type: 'conductor.state', enabled: true, targeting: true, role: channel.role });
    await post({ type: 'conductor.snapshot', snapshot: await channel.request('snapshot', { chatId }) });
  }
  const sentAt = new Map();
  async function centerSync() {
    const snapshot = await channel.request('board');
    centerReady = true;
    await centerPost({ type: 'conductor.state', enabled: true, targeting: true, role: channel.role });
    await centerPost({ type: 'conductor.snapshot', snapshot });
  }
  async function pump() {
    while (!stopped) {
      if (center) {
        // Control center glue, mirroring ControlCenterWindows: board snapshot, state rows, controls with their chat.
        const centerMessages = await center.evaluate(() => window.sentMessages).catch(() => []);
        for (const message of centerMessages.slice(centerHandled)) {
          centerHandled++;
          if (message.type === 'client.ready' || message.type === 'conductor.resync') await centerSync();
          else if (message.type === 'conductor.control') {
            const { type, chatId: target, ...control } = message;
            assert.equal(target, chatId, 'the control center names the chat of the row it acts on');
            await channel.request('ingest', { chatId: target, class: 'control', payload: { commandId: 'center-' + centerHandled, ...control } });
          }
        }
      }
      const messages = await page.evaluate(() => window.sentMessages).catch(() => []);
      for (const message of messages.slice(handled)) {
        handled++;
        if (message.type === 'client.ready' || message.type === 'conductor.resync') await sync();
        else if (message.type === 'chat.send') {
          const accepted = await channel.request('ingest', { chatId, class: 'conversation', payload: { clientMessageId: message.id, text: message.text, ...(message.conductorTarget || {}) }, sentAt: Date.now() / 1000 });
          timings.accepted.push(Date.now() - sentAt.get(message.text));
          await post({ type: 'conductor.accepted', id: message.id, text: message.text, acceptedAt: accepted.acceptedAt, inputId: accepted.inputId });
        } else if (message.type === 'conductor.control') {
          const { type, ...control } = message;
          await channel.request('ingest', { chatId, class: 'control', payload: { commandId: 'browser-' + (++commandSequence), ...control } });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work'] };
  const initialize = () => post({ type: 'host.initialize', panelId: 'browser', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, executionMode: 'workspace-write', capabilities: { submit: capability, send: capability } });
  const artifact = process.env.CONDUCTOR_QUEUE_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/evidence/parallel-intents-20261012');
  fs.mkdirSync(artifact, { recursive: true });
  const loop = pump();
  try {
    await initialize();
    await sync();
    await page.waitForSelector('#conductor-queue-board:not([hidden])');
    const send = async text => {
      await page.locator('#prompt').fill(text);
      sentAt.set(text, Date.now());
      await page.locator('#send-button').click();
    };
    const replies = () => page.evaluate(() => window.saved.timeline.filter(item => item.type === 'conductor' && item.kind === 'reply'));
    // 1) First request: accepted durably, conductor 1 streams, delegates and later synthesizes.
    await send('보고서 초안 작업 2개 2초');
    await page.waitForFunction(() => window.saved.timeline.some(item => item.type === 'conductor' && item.kind === 'reply'));
    timings.firstReply.push(Date.now() - sentAt.get('보고서 초안 작업 2개 2초'));
    // 2) A second message while the first is open is ambiguous: held visibly, never attributed arbitrarily.
    await send('테스트 정리 작업 2개 6초 폭주=40');
    await page.waitForSelector('.conductor-entry[data-kind="question"] .conductor-entry-actions button');
    await page.screenshot({ path: path.join(artifact, 'chat-ambiguous-question-795.png') });
    await page.locator('.conductor-entry[data-kind="question"] .conductor-entry-actions button').last().click();
    // Two independent conductors now run in parallel.
    await page.waitForFunction(() => document.querySelectorAll('#conductor-queue-board li').length === 2);
    // Independent requests are answered by separate conductors.
    await page.waitForFunction(() => new Set(window.saved.timeline.filter(item => item.type === 'conductor' && item.kind === 'reply').map(item => item.conductorId)).size === 2);
    await page.screenshot({ path: path.join(artifact, 'chat-two-conductors-795.png') });
    // The control center shows each worker's real task, step, wait reason, last update and result from the same projection.
    center = await page.context().browser().newPage({ viewport: { width: 889, height: 760 } });
    const centerErrors = [];
    center.on('pageerror', error => centerErrors.push(error.message));
    await center.addInitScript(() => {
      window.saved = null; window.sentMessages = [];
      window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => { window.saved = value; }, postMessage: message => window.sentMessages.push(message) });
    });
    await center.goto(new URL('/center', page.url()).href);
    await center.waitForSelector('#conductor-queue-workers:not([hidden]) .conductor-queue-workers-list li');
    await center.waitForFunction(() => [...document.querySelectorAll('.conductor-queue-workers-list li[data-status="running"]')]
      .some(row => /\(\d+\/\d+\)/.test(row.textContent)), null, { timeout: 30000 });
    // Same canonical request status in both screens.
    const statuses = target => target.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-request-id]')].map(row => [row.dataset.requestId, row.dataset.status])));
    for (let attempt = 0; ; attempt++) {
      const [chatRows, centerRows] = [await statuses(page), await statuses(center)];
      if (JSON.stringify(chatRows) === JSON.stringify(centerRows) && Object.keys(chatRows).length > 0) break;
      assert.ok(attempt < 200, 'chat and control center converge on the same request states: ' + JSON.stringify([chatRows, centerRows]));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const width of [889, 360]) {
      await center.setViewportSize({ width, height: 760 });
      await center.locator('#conductor-queue-workers').screenshot({ path: path.join(artifact, `control-center-workers-${width}.png`) });
    }
    // 3) Cancel the flooding request from the control center while its workers stream progress.
    const flooding = center.locator('#conductor-queue-workers li[data-request-id]').filter({ hasText: '테스트 정리' });
    await flooding.locator('.conductor-queue-cancel').click();
    await page.waitForFunction(() => window.saved.timeline.some(item => item.type === 'conductor' && item.kind === 'status' && item.status === 'cancelled' && !item.delegationId));
    // 4) The first request finishes with one final synthesized answer.
    await page.waitForFunction(() => window.saved.timeline.some(item => item.type === 'conductor' && item.kind === 'reply' && item.final), null, { timeout: 60000 });
    timings.finalReply.push(Date.now() - sentAt.get('보고서 초안 작업 2개 2초'));
    await page.waitForFunction(() => document.querySelectorAll('#conductor-queue-board li').length === 0, null, { timeout: 60000 });
    await page.waitForFunction(() => window.saved.timeline.some(item => item.type === 'conductor' && item.kind === 'reply' && item.text?.includes('요청 취소를 확인했습니다')));
    // Cancellation acknowledgement can arrive after the last worker's status. Await the
    // conductor boundary before comparing the stable history across a reload.
    for (let attempt = 0; ; attempt++) {
      const stable = await channel.request('snapshot', { chatId });
      if (stable.state.filter(row => row.kind === 'conductor').every(row => row.payload.status === 'idle') &&
          stable.queue.mailbox.depth === 0 && Object.values(stable.queue.deliveries).every(depth => depth === 0)) break;
      assert.ok(attempt < 200, 'conductor settles before reload');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await sync();
    const before = await page.evaluate(() => ({ users: window.saved.timeline.filter(item => item.type === 'user').map(item => item.id),
      conductor: window.saved.timeline.filter(item => item.type === 'conductor').map(item => item.id + ':' + (item.text || '') + ':' + (item.status || '')) }));
    await page.screenshot({ path: path.join(artifact, 'chat-completed-795.png') });
    // 5) Reconnect: a reloaded webview restores from snapshot + cursor without duplicates or gaps.
    await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
    handled = 0;
    await page.reload();
    await initialize();
    await page.waitForFunction(() => window.sentMessages.some(message => message.type === 'client.ready'));
    try {
      await page.waitForFunction(count => window.saved.timeline.filter(item => item.type === 'conductor').length === count, before.conductor.length);
    } catch (error) {
      console.log(JSON.stringify({ before, afterReload: await page.evaluate(() => window.saved.timeline.filter(item => item.type === 'conductor').map(item => ({ id: item.id, kind: item.kind, text: item.text, status: item.status }))), canonical: await channel.request('snapshot', { chatId }) }));
      throw error;
    }
    const after = await page.evaluate(() => ({ users: window.saved.timeline.filter(item => item.type === 'user').map(item => item.id),
      conductor: window.saved.timeline.filter(item => item.type === 'conductor').map(item => item.id + ':' + (item.text || '') + ':' + (item.status || '')) }));
    assert.deepEqual(after.users, before.users);
    await center.waitForFunction(() => document.querySelectorAll('.conductor-queue-workers-list li[data-status="cancelled"]').length === 2);
    assert.deepEqual(centerErrors, [], 'control center caused a browser error');
    assert.deepEqual(after.conductor, before.conductor);
    for (const width of [360, 795]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(artifact, `chat-after-reload-${width}.png`) });
    }
    // One message now produces an atomic intent plan, two requests/conductors and concurrent workers.
    await send('independent: 보고서 1 task 4s\nindependent: 테스트 1 task 4s');
    await page.waitForSelector('.conductor-entry[data-kind="plan"]');
    await center.waitForFunction(() => document.querySelectorAll('.conductor-queue-workers-list li[data-status="running"]').length >= 2);
    const split = await channel.request('snapshot', { chatId });
    const plan = split.state.find(row => row.kind === 'plan').payload;
    assert.equal(plan.count, 2);
    assert.ok(plan.intents.every(intent => intent.parallelCandidate && intent.dependencies.length === 0));
    const concurrent = split.state.filter(row => row.kind === 'worker' && row.payload.status === 'running');
    assert.equal(concurrent.length, 2);
    assert.equal(new Set(concurrent.map(row => row.payload.requestId)).size, 2);
    assert.equal(new Set(concurrent.map(row => row.payload.conductorId)).size, 2);
    await center.setViewportSize({ width: 889, height: 760 });
    for (const target of [page, center]) {
      await target.waitForFunction(() => [...document.querySelectorAll('.conductor-queue-plans, .conductor-entry[data-kind="plan"]')].some(element => element.textContent.includes('2') && element.getBoundingClientRect().height > 0));
      await target.screenshot({ path: path.join(artifact, target === page ? 'single-message-parallel-chat.png' : 'single-message-parallel-center.png') });
    }
    // The composer carries an explicit follow-up to the existing child, preserving owner and task identity.
    if (await page.locator('#conductor-target').count()) {
      await page.locator('#conductor-target').selectOption(plan.intents[0].requestId);
      await send('표 형식으로 정리');
      await page.waitForFunction(() => window.saved.timeline.some(item => item.type === 'user' && item.text === '표 형식으로 정리'));
      const followupId = await page.evaluate(() => window.saved.timeline.findLast(item => item.type === 'user' && item.text === '표 형식으로 정리').id);
      for (let attempt = 0; ; attempt++) {
        const current = await channel.request('snapshot', { chatId });
        const input = current.state.find(row => row.kind === 'input' && row.payload.clientMessageId === followupId)?.payload;
        if (input?.status === 'routed') {
          assert.equal(input.requestId, plan.intents[0].requestId);
          assert.equal(input.conductorId, concurrent.find(row => row.payload.requestId === input.requestId).payload.conductorId);
          break;
        }
        assert.ok(attempt < 200, 'the selected child accepts the follow-up');
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      await page.locator('#conductor-target').selectOption('');
    }
    await page.waitForFunction(() => document.querySelectorAll('#conductor-queue-board [data-request-id]').length === 0, null, { timeout: 30000 });
    // A fresh snapshot retains decomposition after completion and every child result remains distinct.
    const finished = await channel.request('snapshot', { chatId });
    assert.equal(finished.state.find(row => row.kind === 'plan').payload.count, 2);
    assert.equal(finished.state.filter(row => row.kind === 'request' && row.payload.parentId).length, 2);
    const finalRequestIds = [plan.requestId, ...plan.intents.map(intent => intent.requestId)];
    await page.waitForFunction(ids => ids.every(id => window.saved.timeline.some(item => item.type === 'conductor' && item.kind === 'reply' && item.final && item.requestId === id)), finalRequestIds);
    // A worker's question is projected with its delegation and answered by an exact versioned control.
    await send('질문 1 task 0.2s ask-worker');
    const answerInput = page.locator('.conductor-entry[data-kind="question"] input');
    await answerInput.waitFor();
    await answerInput.fill('table');
    await page.locator('.conductor-entry[data-kind="question"]').filter({ has: page.locator('input') }).getByRole('button').click();
    await page.waitForFunction(() => window.saved.timeline.filter(item => item.type === 'conductor' && item.kind === 'reply' && item.final).length === 5);
    await center.waitForFunction(() => [...document.querySelectorAll('.conductor-queue-worker-meta')].some(row => row.textContent.includes('table')));
    const metrics = await channel.request('metrics', { chatId });
    const finals = (await replies()).filter(item => item.final).length;
    assert.equal(finals, 5, 'first final, two child finals, parent synthesis and answered worker final; cancelled request has none');
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) / 2)], max: sorted.at(-1) } : { count: 0 }; };
    const report = { measuredAt: new Date().toISOString(), environment: 'Playwright Chromium, real plugin conductor_queue.py serve with fake drivers (conductor delay 0.5 s)',
      browser: { acceptRoundTripMs: summary(timings.accepted), firstReplyVisibleMs: summary(timings.firstReply), finalReplyVisibleMs: summary(timings.finalReply), feedLagAtHostMs: summary(timings.uiLag) },
      runtime: metrics };
    fs.writeFileSync(path.join(artifact, 'measurements.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.browser));
  } finally {
    stopped = true;
    await loop.catch(() => undefined);
    await center?.close().catch(() => undefined);
    channel.dispose();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

module.exports = { checkConductorQueue };
