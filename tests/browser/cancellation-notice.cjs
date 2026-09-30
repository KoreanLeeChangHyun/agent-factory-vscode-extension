const assert = require('node:assert/strict');

async function checkCancellationNotice(page) {
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await emit({ type: 'host.notice', level: 'warning', text: 'Warning reference' });
  await emit({ type: 'host.notice', level: 'error', text: 'Error reference' });
  await emit({ type: 'host.notice', level: 'cancelled', text: 'The run was cancelled.' });
  const notices = page.locator('.message-notice');
  const warning = notices.filter({ hasText: 'Warning reference' });
  const error = notices.filter({ hasText: 'Error reference' });
  const cancelled = notices.filter({ hasText: 'The run was cancelled.' });
  assert.equal(await cancelled.getAttribute('data-level'), 'cancelled');
  assert.equal((await cancelled.locator('.notice-mark').textContent()).trim(), '×');
  const colors = async notice => notice.locator('.message-content').evaluate(element => getComputedStyle(element).color);
  assert.equal(await colors(cancelled), await colors(warning), 'Cancellation uses the themed warning color');
  assert.notEqual(await colors(cancelled), await colors(error), 'Cancellation remains visually distinct from failure');
}

module.exports = { checkCancellationNotice };
