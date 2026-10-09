const assert = require('node:assert/strict');

async function checkQueueConfirmation(page) {
  const capability = { model: true, reasoning: true, fast: true, goal: true, taskModes: ['direct', 'work'] };
  const post = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  await post({ type: 'host.initialize', panelId: 'queue-test', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, executionMode: 'workspace-write', capabilities: { submit: capability, send: capability } });
  const sends = () => page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send'));
  await page.locator('#prompt').fill('holding');
  await page.locator('#send-button').click();
  await post({ type: 'run.state', running: true });
  await page.locator('#prompt').fill('queued first');
  await page.locator('#send-button').click();
  await page.locator('#prompt').fill('queued second');
  await page.locator('#send-button').click();
  const requests = await sends();
  assert.equal(requests.length, 3);
  await page.waitForFunction(() => window.sentMessages.some(message => message.type === 'chat.status' && message.ids.length === 3));
  assert.equal((await sends()).length, 3, 'confirmation queries cannot resubmit');
  // The run may finish before any acknowledgement arrives.
  await post({ type: 'run.state', running: false });
  for (const request of requests) {
    await post({ ...request, type: 'chat.started' });
    await post({ ...request, type: 'chat.started' });
  }
  await page.waitForFunction(() => window.saved.pendingRequests.length === 0);
  for (const request of requests) {
    assert.equal(await page.evaluate(id => window.saved.timeline.filter(event => event.type === 'user' && event.id === id).length, request.id), 1);
  }
  await post({ type: 'attachments.add', attachments: [{ id: 'file-one', kind: 'file', name: 'notes.md', uri: 'file:///fixture/notes.md' }] });
  await page.locator('#prompt').fill('recover with original action');
  await page.locator('#submission-button').click();
  await page.locator('#submission-menu [data-action="work"][data-workflow="normal"][data-goal="false"]').click();
  const original = (await sends()).at(-1);
  assert.equal(original.execution.taskMode, 'work');
  assert.equal(original.execution.goal, false);
  await post({ type: 'chat.rejected', id: original.id });
  if (await page.locator('#pending-queue-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#pending-queue-toggle').click();
  await page.locator('[data-queue-recover]').click();
  assert.equal(await page.locator('#prompt').inputValue(), original.text);
  await page.locator('#send-button').click();
  const recovered = (await sends()).at(-1);
  assert.equal(recovered.id, original.id);
  assert.deepEqual(recovered.execution, original.execution);
  assert.deepEqual(recovered.attachments, original.attachments);
  await post({ type: 'chat.rejected', id: original.id });
  // A stale initialize snapshot must not reject an in-flight request.
  await post({ type: 'host.initialize', panelId: 'queue-test', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, executionMode: 'workspace-write', pendingMessageIds: [original.id], capabilities: { submit: capability, send: capability } });
  await post({ type: 'chat.pending', id: original.id });
  await page.waitForFunction(() => window.saved.pendingRequests[0]?.rejected === false);
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(() => window.sentMessages.some(message => message.type === 'client.ready' && message.pendingMessageIds.length === 1));
  assert.equal((await sends()).length, 0, 'reload requests confirmation, not execution');
  await post({ type: 'host.initialize', panelId: 'queue-test', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, executionMode: 'workspace-write', pendingMessageIds: [original.id], capabilities: { submit: capability, send: capability } });
  await post({ ...original, type: 'chat.started' });
  await page.waitForFunction(() => window.saved.pendingRequests.length === 0);
  assert.equal(await page.evaluate(id => window.saved.timeline.filter(event => event.type === 'user' && event.id === id).length, original.id), 1);
  for (const selector of ['[data-workflow="planning"]', '[data-goal="true"]']) {
    await page.locator('#prompt').fill('retain one-shot execution ' + selector);
    await page.locator('#submission-button').click();
    await page.locator('#submission-menu ' + selector).click();
    const request = (await sends()).at(-1);
    await post({ type: 'chat.rejected', id: request.id });
    if (await page.locator('#pending-queue-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#pending-queue-toggle').click();
    await page.locator('[data-queue-recover]').click();
    await page.locator('#send-button').click();
    const retry = (await sends()).at(-1);
    assert.equal(retry.id, request.id);
    assert.deepEqual(retry.execution, request.execution);
    await post({ ...request, type: 'chat.started' });
    await page.waitForFunction(() => window.saved.pendingRequests.length === 0);
  }
}
module.exports = { checkQueueConfirmation };
