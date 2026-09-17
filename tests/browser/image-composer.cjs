const assert = require('node:assert/strict');

async function checkImageComposer(page) {
  const emit = async message => {
    await page.evaluate(value => window.postMessage(value, '*'), message);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const capabilities = { submit: { model: true, reasoning: true, fast: true, goal: true }, send: { model: true, reasoning: true, fast: true, goal: true } };
  await emit({ type: 'capabilities.updated', capabilities });
  await page.locator('#prompt').fill('before after');
  await page.locator('#prompt').evaluate(element => element.setSelectionRange(7, 7));
  await page.evaluate(() => {
    window.composerNodes = ['business-mode-button', 'work-loop-button', 'model-button', 'reasoning-button', 'fast-mode-button', 'goal-mode-button'].map(id => document.getElementById(id));
    window.composerIcons = window.composerNodes.map(node => node.querySelector('svg'));
    window.composerMutations = [];
    window.composerObserver = new MutationObserver(records => window.composerMutations.push(...records));
    for (const node of window.composerNodes.slice(0, 2)) window.composerObserver.observe(node, { childList: true, subtree: true });
  });
  async function paste(name, source = 'paste') {
    const count = await page.evaluate(() => window.sentMessages.filter(item => item.type === 'attachments.createImage').length);
    await page.evaluate(({ name, source }) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      if (source === 'drop') {
        document.activeElement.blur();
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      } else {
        document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
    }, { name, source });
    await page.waitForFunction(count => window.sentMessages.filter(item => item.type === 'attachments.createImage').length > count, count);
    return page.evaluate(() => window.sentMessages.filter(item => item.type === 'attachments.createImage').at(-1));
  }
  function attachment(message) {
    return { id: message.id, name: message.name, kind: 'image', uri: 'file:///test/' + message.id + '.png', previewUri: 'data:image/png;base64,' + message.data, mediaType: message.mediaType, size: message.size };
  }
  const first = await paste('first.png');
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element && element.selectionStart === 7), true);
  await page.keyboard.type('typing ');
  await emit({ type: 'capabilities.updated', capabilities });
  await emit({ type: 'attachments.add', attachments: [attachment(first)] });
  assert.equal(await page.locator('#prompt').inputValue(), 'before typing after');
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element && element.selectionStart === 14), true);
  for (const id of ['model-button', 'reasoning-button', 'fast-mode-button', 'goal-mode-button']) assert.equal(await page.locator('#' + id).isVisible(), true);
  assert.equal(await page.evaluate(() => window.composerMutations.length), 0);
  assert.equal(await page.evaluate(() => window.composerNodes.every((node, index) => node.isConnected && node.querySelector('svg') === window.composerIcons[index])), true);
  await page.evaluate(() => window.composerObserver.disconnect());

  const second = await paste('second.png');
  await page.locator('#model-button').click();
  const focused = await page.evaluateHandle(() => document.activeElement);
  await emit({ type: 'attachments.add', attachments: [attachment(second)] });
  assert.equal(await focused.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await page.locator('#attach-button').click();
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  await emit({ type: 'attachments.add', attachments: [{ id: 'picked', name: 'picked.txt', kind: 'file', uri: 'file:///test/picked.txt' }] });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);

  await page.locator('#attach-button').click();
  await page.locator('#model-button').click();
  const pickerMovedFocus = await page.evaluateHandle(() => document.activeElement);
  await emit({ type: 'attachments.add', attachments: [{ id: 'picked-later', name: 'later.txt', kind: 'file', uri: 'file:///test/later.txt' }] });
  assert.equal(await pickerMovedFocus.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  const dropped = await paste('dropped.png', 'drop');
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  await emit({ type: 'attachments.add', attachments: [attachment(dropped)] });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);

  await page.evaluate(() => {
    document.activeElement.blur();
    const data = new DataTransfer();
    data.setData('text/uri-list', 'file:///test/dropped.txt');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  const rejected = await paste('rejected.png');
  await emit({ type: 'attachment.rejected', id: rejected.id });
  await emit({ type: 'host.notice', level: 'error', text: 'Unable to save the image attachment: test rejection' });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  assert.equal(await page.locator('.attachment-chip-name', { hasText: 'rejected.png' }).count(), 0);
  assert.ok(await page.getByText('Unable to save the image attachment: test rejection', { exact: true }).count());
  // Leave the existing rendering suite with its original empty draft.
  while (await page.locator('.attachment-remove').count()) await page.locator('.attachment-remove').first().click();
  await page.locator('#prompt').fill('');
}
module.exports = { checkImageComposer };
