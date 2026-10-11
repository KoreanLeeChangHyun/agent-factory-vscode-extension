const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Long-conversation cost at increasing timeline sizes. Each run mirrors the
// median recorded Main run: a short Human request whose stored request carries
// ~38 KB of captured runtime guidance, three command rows and a ~1 KB answer.
// VS Code's webview host JSON-serializes every setState value, so persistence
// is measured with that serialization (window.measurePersistence).
async function checkConversationScale(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const results = [];
  for (const amount of [50, 200, 500]) {
    await page.reload();
    await page.waitForFunction(() => window.performanceChat !== undefined);
    await session.send('HeapProfiler.collectGarbage');
    const baseHeap = (await session.send('Runtime.getHeapUsage')).usedSize;
    const restoreBefore = await metrics();
    const loaded = await page.evaluate(async amount => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const api = window.performanceChat;
      const guidance = index => '\n\n[Managed submission preparation; system context, not Human text]\n' +
        JSON.stringify({ schemaVersion: 1, kind: 'managed-submission-preparation', run: index }) + '\n' +
        ('Runtime instruction ' + index + ' keeps the captured route and evidence contract. ').repeat(480) +
        '[End managed submission preparation]';
      const answer = index => '## Result ' + index + '\n\n' + Array.from({ length: 8 }, (_, line) =>
        '- Item ' + line + ' explains the outcome with `code` and **emphasis**.').join('\n') +
        '\n\n```ts\nconst value' + index + ' = ' + index + ';\n```\n' + 'Closing paragraph. '.repeat(20);
      const events = [];
      for (let run = 0; events.length < amount; run++) {
        const runId = 'scale-run-' + run;
        events.push({ type: 'user', id: 'history-user-' + runId, runId, text: 'Request ' + run + ' ' + 'question text '.repeat(15),
          submission: { taskMode: 'direct', businessMode: 'normal', goal: false, guidance: guidance(run) } });
        for (let activity = 0; activity < 3 && events.length < amount; activity++) {
          events.push({ type: 'activity', id: 'scale-activity-' + run + '-' + activity, runId, category: 'command', phase: 'completed',
            text: 'rg -n "pattern ' + activity + '" src', output: Array.from({ length: 20 }, (_, line) => 'src/file' + line + '.ts:' + line + ': match').join('\n') });
        }
        if (events.length < amount) events.push({ type: 'assistant', id: 'history-assistant-' + runId, runId, phase: 'final', text: answer(run) });
      }
      api.state.agentId = 'scale-main';
      api.state.timeline = events;
      const restoreStart = performance.now();
      api.renderTimeline();
      await frame();
      const restoreMs = performance.now() - restoreStart;
      // Restoration follows to the real bottom although off-screen sizes are estimates.
      const view = document.getElementById('timeline');
      const pinnedAfterRestore = view.scrollHeight - view.clientHeight - view.scrollTop <= 24;
      // Host -> webview size of the restoration page (latest 50 runs, user + final answer).
      const runs = [...new Set(events.map(event => event.runId))].slice(-50);
      const historyMessages = events.filter(event => runs.includes(event.runId) && (event.type === 'user' || event.type === 'assistant'))
        .map(({ type, id, runId, text, phase, submission }) => ({ type, id, runId, text, ...(phase ? { phase } : {}), ...(submission ? { submission } : {}) }));
      return {
        historyMessageCharacters: JSON.stringify({ type: 'conversation.history', agentId: 'scale-main', history: { messages: historyMessages } }).length,
        guidanceCharacters: guidance(0).length, restoreMs, pinnedAfterRestore
      };
    }, amount);
    const restoreAfter = await metrics();
    loaded.restoreStyleLayoutMs = Number((((restoreAfter.RecalcStyleDuration - restoreBefore.RecalcStyleDuration) + (restoreAfter.LayoutDuration - restoreBefore.LayoutDuration)) * 1000).toFixed(2));
    const profile = process.env.CONVERSATION_SCALE_PROFILE === '1' && amount === 500;
    if (profile) { await session.send('Profiler.enable'); await session.send('Profiler.start'); }
    const metricsBefore = await metrics();
    const turn = await page.evaluate(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const api = window.performanceChat;
      const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      window.measurePersistence = true;
      const timeline = document.getElementById('timeline');
      let pinnedAfterAppend;
      const append = [], persistMs = [], persistBytes = [], draftMs = [], startedCharacters = [];
      for (let turn = 0; turn < 7; turn++) {
        const id = 'scale-new-' + turn, runId = 'scale-new-run-' + turn;
        const started = { type: 'chat.started', id, text: 'New request ' + turn, attachments: [],
          submission: { taskMode: 'direct', businessMode: 'normal', goal: false, guidance: api.state.timeline.find(event => event.submission?.guidance)?.submission.guidance } };
        startedCharacters.push(JSON.stringify(started).length);
        // VS Code delivers each host message as its own task; yield between them.
        const task = () => new Promise(resolve => setTimeout(resolve, 0));
        const begin = performance.now();
        send(started);
        await task();
        send({ type: 'run.activity', id: 'scale-new-activity-' + turn, category: 'command', phase: 'completed', text: 'npm test', output: 'ok' });
        await task();
        send({ type: 'chat.assistant', runId, phase: 'final', text: 'Answer ' + turn + ' with **markdown**.' });
        await frame();
        append.push(performance.now() - begin);
        if (turn === 0) await frame();
        if (turn === 0) pinnedAfterAppend = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 24;
        let start = performance.now();
        api.persistNow();
        persistMs.push(performance.now() - start);
        persistBytes.push(window.persistenceBytes);
        // A typing burst saves the draft once per debounce; that save carries the timeline too.
        api.state.draft = 'draft ' + turn;
        start = performance.now();
        api.persistNow();
        draftMs.push(performance.now() - start);
      }
      window.measurePersistence = false;
      // Question navigation still lands on a message that was off-screen
      // (never rendered at its real size).
      const target = api.messageElements.get(api.state.timeline.find(event => event.type === 'user' && api.messageElements.has(event.id)).id);
      target.scrollIntoView({ block: 'center' });
      await frame();
      await frame();
      const box = target.getBoundingClientRect(), view = timeline.getBoundingClientRect();
      const navigated = box.bottom > view.top && box.top < view.bottom;
      return { pinnedAfterAppend, navigated,
        appendTurnMs: median(append), persistMs: median(persistMs), draftPersistMs: median(draftMs),
        persistedCharacters: median(persistBytes), startedMessageCharacters: median(startedCharacters),
        timelineEvents: api.state.timeline.length, renderedMessages: api.messageElements.size,
        timelineNodes: document.querySelectorAll('#timeline *').length, documentNodes: document.querySelectorAll('*').length,
        retainedGuidance: api.state.timeline.filter(event => event.submission?.guidance).length
      };
    });
    const metricsAfter = await metrics();
    // Main-thread time spent across the 7 appended turns, split by phase (ms per turn).
    const perTurn = name => Number((((metricsAfter[name] - metricsBefore[name]) * 1000) / 7).toFixed(2));
    Object.assign(turn, { scriptMsPerTurn: perTurn('ScriptDuration'), layoutMsPerTurn: perTurn('LayoutDuration'), styleMsPerTurn: perTurn('RecalcStyleDuration') });
    if (profile) {
      const { profile: data } = await session.send('Profiler.stop');
      const self = new Map();
      const interval = (data.endTime - data.startTime) / data.samples.length / 1000;
      const byId = new Map(data.nodes.map(node => [node.id, node]));
      for (const id of data.samples) {
        const frame = byId.get(id).callFrame;
        const key = (frame.functionName || '(anonymous)') + ' ' + frame.url.split('/').pop() + ':' + frame.lineNumber;
        self.set(key, (self.get(key) || 0) + interval);
      }
      console.error([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([key, ms]) => ms.toFixed(1) + 'ms ' + key).join('\n'));
    }
    await session.send('HeapProfiler.collectGarbage');
    const heap = (await session.send('Runtime.getHeapUsage')).usedSize;
    results.push({ events: amount, ...loaded, ...turn, heapMB: Number(((heap - baseHeap) / 1048576).toFixed(2)) });
  }
  const report = { scenario: 'Chromium headless; median of 7 appended turns (user + activity + final answer)', label: process.env.CONVERSATION_SCALE_LABEL || 'current', results };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CONVERSATION_SCALE_OUTPUT) {
    fs.mkdirSync(path.dirname(process.env.CONVERSATION_SCALE_OUTPUT), { recursive: true });
    fs.writeFileSync(process.env.CONVERSATION_SCALE_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  }
  // Full history stays reachable: every event remains in the timeline.
  for (const result of results) {
    assert.equal(result.timelineEvents, result.events + 21);
    assert.equal(result.pinnedAfterRestore, true, 'Restoration follows to the latest message at ' + result.events);
    assert.equal(result.pinnedAfterAppend, true, 'A new message keeps following at ' + result.events);
    assert.equal(result.navigated, true, 'Navigating to the first rendered question reaches it at ' + result.events);
  }
  return report;
}

module.exports = { checkConversationScale };
