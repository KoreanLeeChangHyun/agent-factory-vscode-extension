const assert = require('node:assert/strict');

async function checkImageComposer(page) {
  const emit = async message => {
    await page.evaluate(value => window.postMessage(value, '*'), message);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const capabilities = { submit: { model: true, reasoning: true, fast: true, goal: true }, send: { model: true, reasoning: true, fast: true, goal: true } };
  await emit({ type: 'host.initialize', panelId: 'attachments', role: 'main', runtimeAvailable: true, running: false, statusItems: ['agents'] });
  await emit({ type: 'agents.list', agents: [] });
  await emit({ type: 'capabilities.updated', capabilities });
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/uri-list', 'file:///test/dragged.txt');
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#drop-overlay').isVisible(), true);
  const overlay = await page.locator('#drop-overlay').boundingBox();
  const composer = await page.locator('.composer').boundingBox();
  assert.ok(overlay.x >= composer.x && overlay.y >= composer.y);
  assert.ok(overlay.x + overlay.width <= composer.x + composer.width);
  assert.ok(overlay.y + overlay.height <= composer.y + composer.height);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/uri-list', 'file:///test/dragged.txt');
    document.body.dispatchEvent(new DragEvent('dragleave', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#drop-overlay').isVisible(), false);
  await page.locator('#prompt').fill('before after');
  await page.locator('#prompt').evaluate(element => element.setSelectionRange(7, 7));
  await page.evaluate(() => {
    window.composerNodes = ['submission-button', 'model-button', 'fast-mode-button'].map(id => document.getElementById(id));
    window.composerIcons = window.composerNodes.map(node => node.querySelector('svg'));
    window.composerMutations = [];
    window.composerObserver = new MutationObserver(records => window.composerMutations.push(...records));
    for (const node of window.composerNodes.slice(0, 2)) window.composerObserver.observe(node, { childList: true, subtree: true });
  });
  async function paste(name, source = 'paste', mimeType = 'image/png') {
    const count = await page.evaluate(() => window.sentMessages.filter(item => item.type === 'attachments.createImage').length);
    await page.evaluate(({ name, source, mimeType }) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: mimeType }));
      if (source === 'drop') {
        document.activeElement.blur();
        document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      } else {
        document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
    }, { name, source, mimeType });
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
  for (const id of ['model-button', 'submission-button']) assert.equal(await page.locator('#' + id).isVisible(), true);
  assert.equal(await page.locator('#fast-mode-button').isVisible(), false);
  assert.equal(await page.evaluate(() => window.composerMutations.length), 0);
  assert.equal(await page.evaluate(() => window.composerNodes.every((node, index) => node.isConnected && node.querySelector('svg') === window.composerIcons[index])), true);
  await page.evaluate(() => window.composerObserver.disconnect());

  assert.equal(await page.locator('.composer-actions #attach-button').count(), 0);
  assert.equal(await page.locator('#agents-menu #attach-button').count(), 1);
  for (const [width, height] of [[465, 556], [721, 402]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#status-bar [data-item-id=agents]').click();
    const button = page.locator('#attach-button');
    assert.ok(await button.getAttribute('aria-label'));
    const box = await button.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
    await page.keyboard.press('Escape');
  }
  await page.locator('#status-bar [data-item-id=agents]').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#attach-button').press('Enter');
  const chooser = await chooserPromise;
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles({ name: 'picker.txt', mimeType: 'text/plain', buffer: Buffer.from('picked file') });
  await page.waitForFunction(() => window.sentMessages.some(message => message.type === 'attachments.createFile' && message.name === 'picker.txt'));
  const picked = await page.evaluate(() => window.sentMessages.find(message => message.type === 'attachments.createFile' && message.name === 'picker.txt'));
  assert.equal(Buffer.from(picked.data, 'base64').toString(), 'picked file');
  await emit({ type: 'attachments.add', attachments: [{ id: picked.id, name: picked.name, kind: 'file', uri: 'file:///test/picker.txt' }] });
  assert.equal(await page.locator('#agents-menu').isVisible(), false);
  assert.equal(await page.locator('#prompt').inputValue(), 'before typing after');
  await page.setViewportSize({ width: 795, height: 900 });

  const second = await paste('second.png');
  await page.locator('#model-button').click();
  const focused = await page.evaluateHandle(() => document.activeElement);
  await emit({ type: 'attachments.add', attachments: [attachment(second)] });
  assert.equal(await focused.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#attach-button').click();
  assert.equal(await page.locator('#agents-menu').isVisible(), false);
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  await emit({ type: 'attachments.add', attachments: [{ id: 'picked', name: 'picked.txt', kind: 'file', uri: 'file:///test/picked.txt' }] });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);

  await page.locator('#status-bar [data-item-id=agents]').click();
  await page.locator('#attach-button').click();
  assert.equal(await page.locator('#agents-menu').isVisible(), false);
  await page.locator('#model-button').click();
  const pickerMovedFocus = await page.evaluateHandle(() => document.activeElement);
  await emit({ type: 'attachments.add', attachments: [{ id: 'picked-later', name: 'later.txt', kind: 'file', uri: 'file:///test/later.txt' }] });
  assert.equal(await pickerMovedFocus.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  const macClipboard = await paste('macos-clipboard.png', 'paste', '');
  assert.equal(macClipboard.mediaType, 'image/png');
  await emit({ type: 'attachments.add', attachments: [attachment(macClipboard)] });
  const dropped = await paste('dropped.png', 'drop');
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  await emit({ type: 'attachments.add', attachments: [attachment(dropped)] });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);

  await page.evaluate(() => {
    document.activeElement.blur();
    const data = new DataTransfer();
    data.setData('text/uri-list', 'file:///Users/test/Pictures/dropped%20image.png');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'attachments.addUris').at(-1)?.uris), ['file:///Users/test/Pictures/dropped%20image.png']);
  // Explorer's public URI list contains only the first item; the internal list
  // carries the complete selection, even when browser Files is empty in SSH.
  const explorerUris = [
    'vscode-remote://ssh-remote+lchserver.iptime.org/home/test/docs',
    'vscode-remote://ssh-remote+lchserver.iptime.org/home/test/docs/hello%20world.txt'
  ];
  for (const transfer of [
    { 'application/vnd.code.uri-list': '# Explorer\r\n' + explorerUris.join('\r\n'), 'text/uri-list': explorerUris[0] },
    { 'ResourceURLs': JSON.stringify(['file:///test/one.txt', 'file:///test/two.txt']) },
    { 'application/vnd.code.uri-list': [...explorerUris, explorerUris[0]].join('\n') },
    { 'ResourceURLs': '{invalid', 'text/uri-list': 'file:///test/fallback.txt' }
  ]) {
    const expected = transfer['application/vnd.code.uri-list'] ? explorerUris
      : transfer['text/uri-list'] ? ['file:///test/fallback.txt'] : ['file:///test/one.txt', 'file:///test/two.txt'];
    await page.evaluate(transfer => {
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(transfer)) data.setData(type, value);
      const target = document.getElementById('prompt');
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
      const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
      target.dispatchEvent(over);
      // Synthetic DataTransfer keeps dropEffect='none' even after assignment.
      // preventDefault is the observable acceptance signal in this fixture.
      window.explorerDragAccepted = over.defaultPrevented;
    }, transfer);
    assert.equal(await page.locator('#drop-overlay').isVisible(), true);
    assert.equal(await page.evaluate(() => window.explorerDragAccepted), true);
    await page.evaluate(transfer => {
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(transfer)) data.setData(type, value);
      document.getElementById('prompt').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, transfer);
    assert.equal(await page.locator('#drop-overlay').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.sentMessages.filter(message => message.type === 'attachments.addUris').at(-1).uris), expected);
    assert.equal(await page.locator('#prompt').inputValue(), 'before typing after');
  }
  const explorerAttachments = explorerUris.map((uri, index) => ({ id: 'explorer-' + index,
    name: index ? 'hello world.txt' : 'docs', kind: index ? 'file' : 'folder', uri }));
  await emit({ type: 'attachments.add', attachments: explorerAttachments });
  for (const attachment of explorerAttachments) {
    assert.equal(await page.locator('.attachment-chip-name', { hasText: attachment.name }).count(), 1);
  }
  // Text drags remain text; a native file drop still uploads its bytes.
  assert.equal(await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'ordinary text');
    const event = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
    document.getElementById('prompt').dispatchEvent(event);
    return event.defaultPrevented;
  }), false);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.items.add(new File(['ordinary file'], 'native.txt', { type: 'text/plain' }));
    document.getElementById('prompt').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.sentMessages.some(message => message.type === 'attachments.createFile' && message.name === 'native.txt'));
  const native = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'attachments.createFile').at(-1));
  assert.equal(Buffer.from(native.data, 'base64').toString(), 'ordinary file');
  await emit({ type: 'attachments.add', attachments: [{ id: native.id, name: native.name, kind: 'file', uri: 'file:///test/native.txt' }] });
  const rejected = await paste('rejected.png');
  await emit({ type: 'attachment.rejected', id: rejected.id });
  await emit({ type: 'host.notice', level: 'error', text: 'Unable to save the image attachment: test rejection' });
  assert.equal(await page.locator('#prompt').evaluate(element => document.activeElement === element), true);
  assert.equal(await page.locator('.attachment-chip-name', { hasText: 'rejected.png' }).count(), 0);
  assert.ok(await page.getByText('Unable to save the image attachment: test rejection', { exact: true }).count());
  await emit({ type: 'runtime.updated', runtimeAvailable: true, capabilities });
  await page.locator('#send-button').click();
  const sent = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send').at(-1));
  assert.equal(sent.text, 'before typing after');
  assert.ok(sent.attachments.some(item => item.id === picked.id && item.name === 'picker.txt'));
  for (const attachment of explorerAttachments) assert.deepEqual(sent.attachments.find(item => item.id === attachment.id), attachment);
  // Leave the existing rendering suite with its original empty draft.
  while (await page.locator('.attachment-remove').count()) await page.locator('.attachment-remove').first().click();
  await page.locator('#prompt').fill('');
}
module.exports = { checkImageComposer };
