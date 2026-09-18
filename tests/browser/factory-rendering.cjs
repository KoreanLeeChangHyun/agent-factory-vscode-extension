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
  await page.locator('[data-id="factory-multi"] summary.skill-read-document').click();
  assert.match(await page.locator('[data-id="factory-multi"]').textContent(), /both-outputs/);
}
module.exports = { checkFactoryRendering };
