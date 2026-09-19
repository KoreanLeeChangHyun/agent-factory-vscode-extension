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
  assert.equal(await page.locator('[data-id="factory-skill"] .skill-read-card').count(), 1);
  assert.equal(await page.locator('[data-id="ordinary-example"] .managed-agent-card').count(), 0);
  assert.match(await page.locator('[data-id="factory-util"] .managed-agent-heading').textContent(), /Check supported features.*Command completed/);
  const failed = { id: 'failed-submit', text: 'python3 skills/agent/scripts/exec.py submit --agent work-failed --role work', output: JSON.stringify({ kind: 'error', error: { code: 'invalid_dispatch_id', message: 'Invalid ID <script>unsafe</script>' } }) };
  await page.evaluate(event => window.postMessage({ type: 'run.activity', category: 'command', phase: 'failed', ...event }, '*'), failed);
  await page.waitForSelector('[data-id="failed-submit"] .command-error-summary');
  assert.match(await page.locator('[data-id="failed-submit"] .managed-agent-progress').textContent(), /failed/);
  assert.equal(await page.locator('[data-id="failed-submit"] .managed-agent-card').getAttribute('data-status'), 'failed');
  assert.equal(await page.locator('[data-id="failed-submit"] .command-error-summary script').count(), 0);
  assert.match(await page.locator('[data-id="failed-submit"] .command-error-summary').textContent(), /<script>unsafe<\/script>/);
  // A utility's lifecycle updates one item; it does not append another card.
  await page.evaluate(() => window.postMessage({ type: 'run.activity', id: 'factory-util', category: 'command', phase: 'failed', text: 'env X=1 python3 -u skills/agent/scripts/exec.py capabilities', output: 'failed output' }, '*'));
  await page.waitForFunction(() => document.querySelector('[data-id="factory-util"] .managed-agent-status')?.textContent === 'Failed');
  assert.equal(await page.locator('[data-id="factory-util"]').count(), 1);
  await page.evaluate(() => window.postMessage({ type: 'run.activity', id: 'wrapped-submit', category: 'command', phase: 'failed', text: "python3 - <<'PY'\n# runtime wrapper\nPY", output: JSON.stringify({ kind: 'error', operation: { schemaVersion: 1, provider: 'agent-factory', script: 'exec.py', action: 'submit' }, error: { code: 'invalid_dispatch_id', message: 'Use a valid ID' } }) }, '*'));
  await page.waitForSelector('[data-id="wrapped-submit"] .managed-agent-card');
  assert.match(await page.locator('[data-id="wrapped-submit"] .managed-agent-heading').textContent(), /Submit task.*Failed/);
  await page.locator('[data-id="factory-multi"] summary.skill-read-document').click();
  assert.match(await page.locator('[data-id="factory-multi"]').textContent(), /both-outputs/);

  const activity = async event => {
    await page.evaluate(event => window.postMessage({ type: 'run.activity', category: 'command', ...event }, '*'), event);
  };
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
  const artifactDir = path.resolve(__dirname, '../../out/factory-rendering');
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.locator('[data-id="long-loop-heading"]').screenshot({ path: path.join(artifactDir, 'narrow-card.png') });
  await page.setViewportSize({ width: 795, height: 900 });
  await page.locator('[data-id="next-send"]').screenshot({ path: path.join(artifactDir, 'history-card.png') });
}
module.exports = { checkFactoryRendering };
