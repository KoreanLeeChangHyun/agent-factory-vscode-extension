const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

async function checkRenderingFeedback(page) {
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const last = type => page.evaluate(type => window.sentMessages.filter(item => item.type === type).at(-1), type);
  const count = type => page.evaluate(type => window.sentMessages.filter(item => item.type === type).length, type);
  const label = page.locator('#run-status-label');
  const progress = page.locator('#agent-progress');
  const historyStatus = page.locator('#timeline > .history-feedback');
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work'] };
  const initialize = (extra = {}) => emit({ type: 'host.initialize', panelId: 'feedback-panel', agentId: 'feedback-agent', conversationId: 'feedback-conversation',
    role: 'main', runtimeAvailable: true, botsEnabled: false, botVisible: false, capabilities: { submit: capability, send: capability }, ...extra });
  const reset = async fixture => {
    await page.evaluate(fixture => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ agentId: 'feedback-agent', conversationId: 'feedback-conversation', timeline: [], botsEnabled: false, botVisible: false, ...fixture })), fixture || {});
    await page.goto(new URL('/?lang=ko', page.url()).href);
    await initialize();
    await paint();
  };
  const artifactDir = process.env.AF_RENDERING_FEEDBACK_ARTIFACT_DIR;
  const screenshot = async name => {
    if (artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: path.join(artifactDir, name + '.png') });
    }
  };
  await reset();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#prompt').fill('지연 응답 검사');
  await page.locator('#send-button').click();
  await paint();
  const request = await last('chat.send');
  assert.equal(await label.textContent(), '전송 확인 중', 'Submission feedback paints with all Host responses withheld');
  assert.equal(await progress.isVisible(), true);
  assert.equal(await progress.getAttribute('role'), 'status');
  assert.equal(await progress.getAttribute('aria-live'), 'polite');
  assert.equal(await page.locator('[data-id="' + request.id + '"]').count(), 0, 'Unconfirmed submission is not presented as accepted');
  await screenshot('sending-dark-795');
  await page.locator('#send-button').evaluate(button => { button.click(); button.click(); });
  assert.equal(await count('chat.send'), 1, 'Duplicate empty submit cannot enqueue again');
  await emit({ type: 'chat.pending', id: request.id });
  assert.equal(await label.textContent(), '대기열에 접수됨');
  await emit({ ...request, type: 'chat.started' });
  await emit({ type: 'run.state', running: true });
  await paint();
  assert.equal(await label.textContent(), '첫 응답 대기');
  const retained = await page.locator('#timeline .message').first().evaluate(node => { window.feedbackRetained = node; return node.dataset.id; });
  await emit({ type: 'chat.delta', runId: 'feedback-run', id: 'feedback-stream', stream: 'final', text: '부분 응답' });
  await paint();
  assert.match(await label.textContent(), /^응답 수신/);
  await page.waitForFunction(() => window.sentMessages.some(item => item.type === 'chat.status') || document.querySelector('#run-elapsed')?.textContent !== '0초');
  assert.match(await label.textContent(), /^응답 수신/, 'Silence never synthesizes failure or success');
  assert.equal(await progress.evaluate(node => node.classList.contains('is-progressing')), false, 'No activity animation is invented for a silent response interval');
  await emit({ type: 'run.observed', status: 'running' });
  assert.equal(await progress.evaluate(node => node.classList.contains('is-progressing')), true, 'An actual observed running event enables the existing execution indicator');
  assert.equal(await page.evaluate(id => document.querySelector('[data-id="' + id + '"]') === window.feedbackRetained, retained), true, 'Status updates preserve existing message nodes');
  await emit({ type: 'chat.assistant', runId: 'feedback-run', phase: 'final', text: '최종 응답' });
  assert.equal(await label.textContent(), '응답 수신 · 실행 종료 확인 중', 'Final message alone does not imply execution completion');
  await emit({ type: 'run.observed', status: 'completed' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '실행 완료');
  assert.equal(await progress.isVisible(), true, 'Confirmed terminal feedback remains visible');
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '실행 종료', 'An ended run without outcome is not labeled success');
  // An outcome that needs no action clears after a short while instead of staying above an idle composer.
  await page.waitForFunction(() => document.getElementById('agent-progress').hidden, null, { timeout: 6000 });
  assert.equal(await progress.isVisible(), false, 'Settled run feedback leaves no idle status line');
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'decision.pending', runId: 'decision-run', canApprove: false });
  assert.equal(await label.textContent(), '사용자님 응답 대기');
  await emit({ type: 'run.observed', status: 'needs-human-decision' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '사용자님 응답 대기');
  await emit({ type: 'decision.pending' });
  assert.equal(await label.textContent(), '실행 중인 작업 없음');
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'run.observed', status: 'failed' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '실행 실패');
  await page.waitForTimeout(4500);
  assert.equal(await label.textContent(), '실행 실패', 'Failure stays visible until the next action');
  assert.equal(await progress.isVisible(), true);
  await page.locator('#prompt').fill('다시 전송할 내용');
  await page.locator('#send-button').click();
  const rejected = await last('chat.send');
  await emit({ type: 'chat.rejected', id: rejected.id });
  assert.equal(await page.locator('#pending-queue-toggle').getAttribute('aria-expanded'), 'true');
  assert.match(await page.locator('.pending-request-feedback').textContent(), /전송 미확인/);
  await page.locator('[data-queue-recover]').click();
  assert.equal(await label.textContent(), '입력란에 복원됨 · 다시 전송 가능');
  assert.equal(await page.locator('#prompt').inputValue(), rejected.text);
  await page.locator('#send-button').click();
  assert.equal((await last('chat.send')).id, rejected.id, 'Retry preserves the original request identity');
  await emit({ ...rejected, type: 'chat.started' });
  await emit({ type: 'run.state', running: true });
  await page.locator('#send-button').click();
  const cancellations = await count('run.cancel');
  assert.ok(cancellations > 0);
  assert.equal(await label.textContent(), '중단 요청 중');
  await page.locator('#send-button').evaluate(button => button.click());
  assert.equal(await count('run.cancel'), cancellations);
  await emit({ type: 'run.observed', status: 'cancelled' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '실행 취소됨');
  await emit({ type: 'session.bound', agentId: 'another-agent', conversationId: 'another-conversation', reset: true });
  assert.equal(await label.textContent(), '실행 상태 확인 중');
  await emit({ type: 'run.state', running: false });
  assert.equal(await label.textContent(), '실행 중인 작업 없음');

  const timeline = Array.from({ length: 401 }, (_, index) => ({ type: 'assistant', phase: 'final', id: 'feedback-message-' + index, runId: 'history-run-' + index,
    text: '보존된 메시지 ' + index + '\n\n' + '**Markdown content** and `code`\n\n'.repeat(20) }));
  await reset();
  await initialize({ running: true });
  assert.equal(await label.textContent(), '실행 상태 갱신 대기', 'An active snapshot does not invent its response stage');
  assert.equal(await progress.evaluate(node => node.classList.contains('is-progressing')), false);
  await reset({ timeline, autoScroll: false, historyNextBefore: 'older-boundary' });
  const older = page.locator('#timeline .history-older');
  await older.click();
  await paint();
  assert.equal(await historyStatus.textContent(), '이력 응답 대기');
  assert.equal(await older.isDisabled(), true);
  await older.evaluate(button => button.click());
  assert.equal(await count('history.request'), 1);
  await emit({ type: 'conversation.history', agentId: 'foreign-agent', history: { conversationId: 'feedback-conversation', messages: [] } });
  await emit({ type: 'host.notice', level: 'error', text: 'Uncorrelated fixture error' });
  assert.equal(await historyStatus.textContent(), '이력 응답 대기', 'Uncorrelated errors and foreign responses cannot complete this request');
  await emit({ type: 'conversation.history', agentId: 'feedback-agent', history: { conversationId: 'feedback-conversation', nextBefore: 'older-boundary', messages: [] } });
  await paint();
  assert.equal(await historyStatus.textContent(), '새로 반영할 메시지가 없습니다');
  assert.equal(await older.isDisabled(), false);
  await older.click();
  await emit({ type: 'conversation.history', agentId: 'feedback-agent', history: { conversationId: 'feedback-conversation', messages: [{ type: 'assistant', phase: 'final', id: 'history-earliest', runId: 'earliest', text: '더 이전 내용' }] } });
  await paint();
  assert.equal(await historyStatus.textContent(), '이력 1개 반영됨');
  await page.waitForSelector('[data-id="history-earliest"]');

  // Gate only the scheduled callbacks, and use the unmodified browser RAF to paint.
  // This proves the status is on screen while the old page is still mounted.
  await reset({ timeline, autoScroll: false });
  await page.evaluate(() => {
    window.feedbackNativeRaf = window.requestAnimationFrame;
    window.feedbackFrames = [];
    window.requestAnimationFrame = callback => { window.feedbackFrames.push(callback); return 0; };
    window.feedbackOldLast = document.querySelector('#timeline .message:last-child');
  });
  await page.locator('.history-pages button').first().focus();
  await page.keyboard.press('Enter');
  const nativePaint = () => page.evaluate(() => new Promise(resolve => window.feedbackNativeRaf(() => window.feedbackNativeRaf(resolve))));
  await nativePaint();
  assert.equal(await historyStatus.textContent(), '이력 화면 갱신 중');
  assert.equal(await page.evaluate(() => document.querySelector('#timeline .message:last-child') === window.feedbackOldLast), true);
  assert.equal(await page.locator('.history-pages button:disabled').count(), 2);
  await screenshot('rendering-dark-795');
  await page.evaluate(() => window.feedbackFrames.shift()(performance.now()));
  await nativePaint();
  assert.equal(await historyStatus.textContent(), '이력 화면 갱신 중');
  await page.evaluate(() => { window.feedbackFrames.shift()(performance.now()); window.requestAnimationFrame = window.feedbackNativeRaf; });
  assert.equal(await page.locator('#timeline .message:last-child').getAttribute('data-id'), 'feedback-message-200');
  assert.equal(await historyStatus.textContent(), '메시지 2–201 / 전체 401개');
  assert.equal(await page.locator('.history-pages button').first().evaluate(node => node === document.activeElement), true, 'Keyboard focus follows rebuilt pagination');

  // A real renderer exception after several new nodes must preserve the previous page and enable retry.
  await page.evaluate(() => {
    window.feedbackCreateElement = document.createElement;
    let articles = 0;
    document.createElement = function (...args) {
      if (args[0] === 'article' && ++articles === 3) { document.createElement = window.feedbackCreateElement; throw new Error('Injected display failure'); }
      return window.feedbackCreateElement.apply(this, args);
    };
    window.feedbackOldIds = Array.from(document.querySelectorAll('#timeline .message'), node => node.dataset.id);
  });
  await page.locator('.history-pages button').last().click();
  await paint();
  assert.equal(await historyStatus.textContent(), '화면 갱신 실패 · 다시 시도해 주세요');
  assert.deepEqual(await page.locator('#timeline .message').evaluateAll(nodes => nodes.map(node => node.dataset.id)), await page.evaluate(() => window.feedbackOldIds));
  assert.equal(await page.locator('.history-pages button').last().isDisabled(), false);
  await page.locator('.history-pages button').last().click();
  await paint();
  assert.equal(await page.locator('#timeline .message:last-child').getAttribute('data-id'), 'feedback-message-400');
  assert.equal(await historyStatus.getAttribute('title'), null, 'Successful retry clears the old diagnostic');
  await page.locator('.history-pages button').first().click();
  await paint();

  // A queued page rebuild belongs to the conversation that scheduled it.
  await page.evaluate(() => { window.feedbackFrames = []; window.requestAnimationFrame = callback => { window.feedbackFrames.push(callback); return 0; }; });
  await page.locator('.history-pages button').last().click();
  await emit({ type: 'session.bound', agentId: 'new-agent', conversationId: 'new-conversation', reset: true });
  await page.evaluate(() => { while (window.feedbackFrames.length) window.feedbackFrames.shift()(performance.now()); window.requestAnimationFrame = window.feedbackNativeRaf; });
  assert.equal(await page.locator('#timeline .message').count(), 0, 'Old page callbacks cannot repopulate a switched conversation');
  assert.equal(await historyStatus.isVisible(), false);

  await reset();
  await page.locator('#question-button').click();
  await page.locator('#question-tab-history').click();
  await emit({ type: 'conversations.list', conversations: [{ conversationId: 'archive-conversation', startedAt: '2026-10-07T19:00:00Z', runCount: 1 }] });
  await page.locator('.conversation-history-entry').click();
  const archiveStatus = page.locator('#conversation-reader > .history-feedback');
  const archiveMessages = page.locator('#conversation-reader-messages');
  const archiveRetry = page.locator('#conversation-reader > .history-control').filter({ hasText: '불러오기 재시도' });
  const archiveFirst = await last('conversation.read');
  await paint();
  assert.equal(await archiveStatus.textContent(), '이력 응답 대기');
  assert.equal(await archiveMessages.getAttribute('aria-busy'), 'true');
  await emit({ type: 'conversation.read.result', requestId: archiveFirst.requestId, error: 'fixture unavailable' });
  assert.match(await archiveStatus.textContent(), /fixture unavailable/);
  assert.equal(await archiveRetry.isVisible(), true);
  await archiveRetry.click();
  const retryRequest = await last('conversation.read');
  assert.notEqual(retryRequest.requestId, archiveFirst.requestId);
  await archiveRetry.evaluate(button => button.click());
  assert.equal(await count('conversation.read'), 2);
  await emit({ type: 'conversation.read.result', requestId: archiveFirst.requestId, error: 'STALE' });
  assert.equal(await archiveStatus.textContent(), '이력 응답 대기');
  await emit({ type: 'conversation.read.result', requestId: retryRequest.requestId, history: { nextBefore: 'archive-before', messages: [{ type: 'assistant', text: '보존할 대화 내용' }] } });
  assert.equal(await archiveStatus.textContent(), '이력 1개 반영됨');
  assert.equal(await archiveMessages.getAttribute('aria-busy'), 'false');
  await page.locator('#conversation-reader-older').click();
  const archiveOlder = await last('conversation.read');
  await emit({ type: 'conversation.read.result', requestId: archiveOlder.requestId, error: 'append failure' });
  assert.match(await archiveMessages.textContent(), /보존할 대화 내용/);
  await archiveRetry.click();
  const archiveRetryOlder = await last('conversation.read');
  assert.equal(archiveRetryOlder.before, 'archive-before');
  await emit({ type: 'conversation.read.result', requestId: archiveRetryOlder.requestId, history: { nextBefore: 'archive-before', messages: [] } });
  assert.equal(await archiveStatus.textContent(), '새로 반영할 메시지가 없습니다');
  await page.locator('#conversation-reader-older').click();
  const closingRequest = await last('conversation.read');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('conversation-reader').open);
  await page.waitForFunction(() => document.activeElement === document.getElementById('question-button'));
  await emit({ type: 'conversation.read.result', requestId: closingRequest.requestId, error: 'STALE AFTER CLOSE' });
  assert.equal(await archiveStatus.isVisible(), false);
  assert.equal(await page.locator('#question-button').evaluate(node => node === document.activeElement), true);

  for (const theme of ['dark', 'light']) for (const width of [320, 795]) {
    await page.setViewportSize({ width, height: 740 });
    await reset({ historyNextBefore: 'visual-boundary' });
    await page.evaluate(theme => {
      const root = document.documentElement;
      const light = theme === 'light';
      document.body.className = 'vscode-' + theme;
      for (const name of ['foreground', 'editor-foreground', 'terminal-foreground']) root.style.setProperty('--vscode-' + name, light ? '#333333' : '#d4d4d4');
      for (const name of ['editor-background', 'terminal-background']) root.style.setProperty('--vscode-' + name, light ? '#ffffff' : '#1e1e1e');
      root.style.setProperty('--vscode-editorWidget-background', light ? '#f3f3f3' : '#252526');
      root.style.setProperty('--vscode-descriptionForeground', light ? '#555555' : '#aaaaaa');
      root.style.colorScheme = light ? 'light' : 'dark';
    }, theme);
    await page.locator('#timeline .history-older').click();
    await page.locator('#prompt').fill('응답 대기 화면 검사');
    await page.locator('#send-button').click();
    await paint();
    assert.equal(await label.textContent(), '전송 확인 중');
    assert.equal(await historyStatus.getAttribute('aria-live'), 'polite');
    const bounds = await historyStatus.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.equal(await progress.evaluate(node => node.classList.contains('is-progressing')), false);
    const labelBounds = await label.boundingBox();
    const controlsBounds = await page.locator('.composer').boundingBox();
    if (controlsBounds) assert.ok(labelBounds.y + labelBounds.height <= controlsBounds.y, 'Feedback is not covered by existing controls');
    assert.equal(await label.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'The feedback label fits without horizontal clipping');
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 740, 'Waiting feedback is visible even beside the empty transcript');
    await screenshot('waiting-' + theme + '-' + width);
  }
  console.log('Rendering feedback own checks passed: delayed submission/streaming, outcomes, recovery/cancellation, history no-change, native paint before page rebuild, renderer failure recovery, stale context, archive retry and four theme/width fixtures.');
}
module.exports = { checkRenderingFeedback };
