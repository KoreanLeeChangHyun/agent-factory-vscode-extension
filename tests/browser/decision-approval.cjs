const assert = require('node:assert/strict');

// One-click approval shows what it approves; irreversible proposals offer no approve button.
async function checkDecisionApproval(page) {
  const emit = async data => {
    await page.evaluate(data => {
      window.dispatchEvent(new MessageEvent('message', { data }));
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, data);
  };
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work'] };
  await emit({ type: 'host.initialize', panelId: 'decision', title: 'Decision', projectName: 'Work', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability }, executionMode: 'danger-full-access' });

  const request = '문서 두 개를 갱신하는 범위로 Work를 진행할까요?';
  await emit({ type: 'chat.assistant', text: `변경 계획입니다.\n\n${request}`, phase: 'final', runId: 'scoped-run' });
  await emit({ type: 'decision.pending', runId: 'scoped-run', canApprove: true, approval: { request, irreversible: [] } });
  const scoped = page.locator('.message-assistant').last();
  assert.equal(await scoped.locator('.decision-target q').textContent(), request);
  assert.equal(await scoped.locator('.decision-irreversible').count(), 0);
  const approve = scoped.locator('.decision-actions button');
  assert.equal(await approve.count(), 1);
  assert.equal(await approve.isEnabled(), true);
  const order = await scoped.evaluate(element => [...element.querySelectorAll('.decision-target, .decision-actions')].map(node => node.className));
  assert.deepEqual(order, ['decision-target', 'decision-actions'], 'The target is shown before the approve button');
  await approve.click();
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'decision.approve').at(-1)), { type: 'decision.approve', runId: 'scoped-run', language: 'en' }, 'The English UI requests an English approval message');

  const command = 'git checkout -- docs/artifact/evidence/cli-comparison';
  const revert = `아티팩트 44개를 \`${command}\` 로 되돌릴까요?`;
  await emit({ type: 'chat.assistant', text: revert, phase: 'final', runId: 'revert-run' });
  await emit({ type: 'decision.pending', runId: 'revert-run', canApprove: false, approval: { request: revert, irreversible: [command] } });
  const blocked = page.locator('.message-assistant').last();
  assert.equal(await blocked.locator('.decision-actions').count(), 0, 'Irreversible proposals offer no one-click approval');
  assert.equal(await blocked.locator('button').filter({ hasText: /Proceed as proposed|제안대로 진행/ }).count(), 0);
  assert.equal(await blocked.locator('.decision-target q').textContent(), revert);
  assert.equal(await blocked.locator('.decision-irreversible[role="note"] li code').textContent(), command);
  assert.match(await blocked.locator('.decision-irreversible p').textContent(), /irreversible|되돌릴 수 없는/);
  const border = await blocked.locator('.decision-irreversible').evaluate(element => getComputedStyle(element).borderLeftWidth);
  assert.equal(border, '0px', 'No status-coloured border');
  assert.equal(await page.locator('.message-assistant').filter({ hasText: request }).locator('.decision-actions').count(), 0, 'Only the pending response shows decision controls');

  await emit({ type: 'chat.assistant', text: 'Which target?', phase: 'final', runId: 'question-run' });
  await emit({ type: 'decision.pending', runId: 'question-run', canApprove: false });
  const question = page.locator('.message-assistant').last();
  assert.equal(await question.locator('.decision-target, .decision-actions, .decision-irreversible').count(), 0, 'Clarifications keep the direct-reply path only');
  await emit({ type: 'decision.pending', runId: null });
}

module.exports = { checkDecisionApproval };
