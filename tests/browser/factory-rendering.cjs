const assert = require('node:assert/strict');

async function checkFactoryRendering(page) {
  const events = [
    { id: 'factory-util', text: 'env X=1 python3 -u skills/agent/scripts/exec.py capabilities', output: 'utility-output' },
    { id: 'factory-plan', text: 'bash -lc "python3 skills/agent/scripts/exec.py submit --agent plan-1 --role work --task-mode plan"', output: '{"agentId":"plan-1","runId":"run-1"}' },
    { id: 'factory-multi', text: 'python3 skills/agent/scripts/exec.py status --agent work-1; python3 skills/agent/scripts/exec.py status --agent work-2', output: 'both-outputs' },
    { id: 'factory-skill', text: 'bash -lc "cat docs/skills/design-main-chat/SKILL.md"', output: 'skill-contents' },
    { id: 'ordinary-example', text: 'echo "python3 skills/agent/scripts/exec.py status"', output: 'example' }
  ];
  for (const event of events) {
    await page.evaluate(event => window.postMessage({ type: 'run.activity', category: 'command', phase: 'completed', ...event }, '*'), event);
  }
  await page.waitForSelector('[data-id="factory-util"] .managed-agent-card');
  for (const id of ['factory-util', 'factory-plan', 'factory-multi']) {
    assert.equal(await page.locator(`[data-id="${id}"] .managed-agent-card`).count(), 1);
  }
  assert.match(await page.locator('[data-id="factory-plan"] .managed-agent-heading').textContent(), /Plan/);
  assert.equal(await page.locator('[data-id="factory-skill"] .act-row-wrap[data-kind="skill"]').count(), 1);
  assert.equal(await page.locator('[data-id="ordinary-example"] .managed-agent-card').count(), 0);
  assert.match(await page.locator('[data-id="factory-util"] .managed-agent-heading').textContent(), /Check supported features.*Command completed/);
  const failed = { id: 'failed-submit', text: 'python3 skills/agent/scripts/exec.py submit --agent work-failed --role work', output: JSON.stringify({ kind: 'error', error: { code: 'invalid_dispatch_id', message: 'Invalid ID <script>unsafe</script>' } }) };
  await page.evaluate(event => window.postMessage({ type: 'run.activity', category: 'command', phase: 'failed', ...event }, '*'), failed);
  await page.waitForSelector('[data-id="failed-submit"] .command-error-summary');
  assert.match(await page.locator('[data-id="failed-submit"] .managed-agent-progress').textContent(), /failed/);
  assert.equal(await page.locator('[data-id="failed-submit"] .managed-agent-card').getAttribute('data-status'), 'failed');
  assert.equal(await page.locator('[data-id="failed-submit"] .command-error-summary script').count(), 0);
  assert.match(await page.locator('[data-id="failed-submit"] .command-error-summary').textContent(), /<script>unsafe<\/script>/);
  for (const event of [
    { id: 'plain-test', category: 'command', phase: 'completed', text: 'python3 -m unittest discover', output: 'line\n'.repeat(20) + 'OK' },
    { id: 'plain-failure', category: 'command', phase: 'failed', text: 'python3 scripts/check_site_links.py', output: 'Broken link' },
    { id: 'plain-tool', category: 'tool', phase: 'completed', text: 'Tool result' },
    { id: 'factory-path-only', category: 'command', phase: 'completed', text: 'sha256sum /tmp/.agent-factory/result.md', output: 'checksum' }
  ]) {
    await page.evaluate(event => window.dispatchEvent(new MessageEvent('message', { data: { type: 'run.activity', ...event } })), event);
    const content = page.locator(`[data-id="${event.id}"] > .message-content`);
    await content.waitFor({ state: 'attached' });
    assert.equal(await content.evaluate(el => getComputedStyle(el).borderTopStyle), 'none');
    assert.equal(await content.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await content.locator('.managed-agent-card').count(), 0);
  }
  assert.equal(await page.locator('[data-id="factory-util"] .managed-agent-card').evaluate(el => getComputedStyle(el).borderTopStyle), 'solid');
  // Ordinary commands are tracking rows; their output opens from the row.
  await page.locator('[data-id="plain-test"] .act-row').click();
  const ordinaryDetails = page.locator('[data-id="plain-test"] .terminal-output-details');
  await ordinaryDetails.locator('summary').click();
  assert.match(await ordinaryDetails.textContent(), /OK/);
  assert.equal(await page.locator('[data-id="plain-failure"] .act-row-wrap').getAttribute('data-phase'), 'failed');
  assert.equal(await page.locator('[data-id="plain-failure"] .act-error').textContent(), 'Broken link');
  // A utility's lifecycle updates one item; it does not append another card.
  await page.evaluate(() => window.postMessage({ type: 'run.activity', id: 'factory-util', category: 'command', phase: 'failed', text: 'env X=1 python3 -u skills/agent/scripts/exec.py capabilities', output: 'failed output' }, '*'));
  await page.waitForFunction(() => document.querySelector('[data-id="factory-util"] .managed-agent-status')?.textContent === 'Failed');
  assert.equal(await page.locator('[data-id="factory-util"]').count(), 1);
  await page.evaluate(() => window.postMessage({ type: 'run.activity', id: 'wrapped-submit', category: 'command', phase: 'failed', text: "python3 - <<'PY'\n# runtime wrapper\nPY", output: JSON.stringify({ kind: 'error', operation: { schemaVersion: 1, provider: 'agent-factory', script: 'exec.py', action: 'submit' }, error: { code: 'invalid_dispatch_id', message: 'Use a valid ID' } }) }, '*'));
  await page.waitForSelector('[data-id="wrapped-submit"] .managed-agent-card');
  assert.match(await page.locator('[data-id="wrapped-submit"] .managed-agent-heading').textContent(), /Submit task.*Failed/);
  await page.locator('[data-id="factory-multi"] .factory-command-details > summary').click();
  assert.match(await page.locator('[data-id="factory-multi"]').textContent(), /both-outputs/);

  const activity = async event => {
    await page.evaluate(event => window.postMessage({ type: 'run.activity', category: 'command', ...event }, '*'), event);
  };
  const lessonCommand = 'python3 "/home/test/.codex/plugins/cache/personal/agent-factory/local/scripts/lessons.py" --project-root "/work/repository with spaces" record --input "/tmp/lesson.json"';
  await activity({ id: 'lesson-record', phase: 'started', text: lessonCommand });
  await page.waitForSelector('[data-id="lesson-record"] .factory-command-context');
  const lessonCard = page.locator('[data-id="lesson-record"]');
  assert.match(await lessonCard.locator('.managed-agent-heading').textContent(), /Record a lesson.*In progress/);
  assert.equal(await lessonCard.locator('.factory-command-target').textContent(), 'repository with spaces');
  assert.equal(await lessonCard.locator('.factory-command-target').getAttribute('title'), '/work/repository with spaces');
  const lessonDetails = lessonCard.locator('.factory-command-details');
  await lessonDetails.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await lessonDetails.getAttribute('open'), '');
  await activity({ id: 'lesson-record', phase: 'completed', text: lessonCommand, output: '{"id":"lesson-1","status":"unresolved"}' });
  await page.waitForFunction(() => document.querySelector('[data-id="lesson-record"] .managed-agent-card')?.dataset.status === 'completed');
  assert.equal(await lessonDetails.getAttribute('open'), '', 'Keep raw command details open after lifecycle update');
  assert.match(await lessonDetails.textContent(), /--project-root/);
  assert.match(await lessonCard.locator('.managed-agent-status').textContent(), /Command completed/);
  assert.match(await lessonDetails.textContent(), /lesson-1/);
  await activity({ id: 'ordinary-exec', phase: 'completed', text: 'python3 /some-app/scripts/exec.py status --agent ordinary', output: 'ordinary output' });
  assert.equal(await page.locator('[data-id="ordinary-exec"] .managed-agent-card').count(), 0);
  await activity({ id: 'factory-exit-failed', phase: 'completed', exitCode: 2, text: lessonCommand, output: 'usage: invalid input' });
  await page.waitForSelector('[data-id="factory-exit-failed"] .managed-agent-card[data-status="failed"]');
  await activity({ id: 'relocated-factory', phase: 'completed', text: 'python3 /custom/location/scripts/exec.py doctor', output: JSON.stringify({ operation: { schemaVersion: 1, provider: 'agent-factory', script: 'exec.py', action: 'doctor' } }) });
  assert.match(await page.locator('[data-id="relocated-factory"] .managed-agent-heading').textContent(), /Check execution environment/);
  const command = 'python3 skills/agent/scripts/exec.py';
  await activity({ id: 'previous-run', phase: 'completed', text: command + ' status --agent repeat-agent --run-id run-old', output: JSON.stringify({ agentId: 'repeat-agent', runId: 'run-old', status: 'completed' }) });
  await activity({ id: 'next-send', phase: 'started', text: command + ' send --agent repeat-agent --message next' });
  await page.waitForSelector('[data-id="next-send"] .managed-agent-card', { timeout: 2000 });
  assert.doesNotMatch(await page.locator('[data-id="next-send"] .managed-agent-status').textContent(), /Completed/i);
  assert.match(await page.locator('[data-id="previous-run"] .managed-agent-status').textContent(), /Completed/i);
  await activity({ id: 'next-send', phase: 'completed', text: command + ' send --agent repeat-agent --message next', output: JSON.stringify({ agentId: 'repeat-agent', runId: 'run-next', status: 'accepted' }) });
  await page.waitForFunction(() => document.querySelector('[data-id="next-send"] .managed-agent-identity')?.textContent.includes('run-next'));
  await page.locator('[data-id="next-send"] .managed-agent-details > summary').click();
  await activity({ id: 'next-status', phase: 'completed', text: command + ' status --agent repeat-agent --run-id run-next', output: JSON.stringify({ agentId: 'repeat-agent', runId: 'run-next', status: 'running' }) });
  await page.waitForFunction(() => document.querySelector('[data-id="next-send"] .managed-agent-card')?.dataset.status === 'running');
  assert.equal(await page.locator('[data-id="next-send"] .managed-agent-details').getAttribute('open'), '');
  assert.equal(await page.locator('[data-id="next-status"]').count(), 0);
  const outputs = page.locator('[data-id="next-send"] .terminal-output-details');
  await outputs.nth(1).evaluate(node => { node.open = true; });
  await activity({ id: 'next-status', phase: 'completed', text: command + ' status --agent repeat-agent --run-id run-next', output: JSON.stringify({ agentId: 'repeat-agent', runId: 'run-next', status: 'completed' }) });
  await page.waitForFunction(() => document.querySelector('[data-id="next-send"] .managed-agent-card')?.dataset.status === 'completed');
  assert.equal(await outputs.nth(0).getAttribute('open'), null);
  assert.equal(await outputs.nth(1).getAttribute('open'), '', 'Keep each history output disclosure independently open');
  await page.setViewportSize({ width: 320, height: 740 });
  await activity({ id: 'long-loop-heading', phase: 'completed', text: 'python3 skills/agent/scripts/loop.py start --work-agent long-loop --task-mode plan-work-verification', output: JSON.stringify({ workAgentId: 'long-loop', loopId: 'loop-long', taskMode: 'plan-work-verification', status: 'needs-human-decision' }) });
  await page.waitForSelector('[data-id="long-loop-heading"] .managed-agent-card');
  const overflowing = await page.locator('.managed-agent-heading').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
  assert.deepEqual(overflowing, [], 'Card headings must fit narrow panels');
  const fs = require('node:fs');
  const path = require('node:path');
  const artifactDir = path.resolve(__dirname, '../../../docs/artifact/agent-factory-command-rendering');
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.locator('[data-id="long-loop-heading"]').screenshot({ path: path.join(artifactDir, 'narrow-card.png') });
  await lessonCard.screenshot({ path: path.join(artifactDir, 'lesson-narrow.png') });
  await page.setViewportSize({ width: 795, height: 900 });
  await page.locator('[data-id="next-send"]').screenshot({ path: path.join(artifactDir, 'history-card.png') });
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#status-settings-close').click();
  assert.match(await lessonCard.locator('.managed-agent-heading').textContent(), /교훈 기록.*명령 완료/);
  assert.equal(await lessonDetails.getAttribute('open'), '', 'Language changes preserve disclosure');
  assert.equal(await lessonDetails.locator('.syntax-code').textContent(), lessonCommand);
  await lessonDetails.locator(':scope > summary').click();
  await lessonCard.screenshot({ path: path.join(artifactDir, 'lesson-korean.png') });
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForSelector('[data-id="lesson-record"] .factory-command-context');
  assert.equal(await lessonCard.locator('.factory-command-target').getAttribute('title'), '/work/repository with spaces');
  assert.equal(await page.locator('[data-id="ordinary-exec"] .managed-agent-card').count(), 0);
}
module.exports = { checkFactoryRendering };
