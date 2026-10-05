const assert = require('node:assert/strict');

async function checkClipboardImages(page) {
  await page.locator('#prompt').fill('clipboard test');
  await page.evaluate(() => {
    window.clipboardTestBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    window.clipboardTestPaste = (files, items, target = document.getElementById('prompt')) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files, items, getData: () => '' } });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
  });
  // Paste in unrelated editors must remain native, including image+text clipboard data.
  assert.equal(await page.evaluate(() => {
    const editor = document.createElement('textarea'); document.body.append(editor);
    const prevented = window.clipboardTestPaste([new File([window.clipboardTestBytes], 'settings.png', { type: 'image/png' })], [], editor);
    editor.remove(); return prevented;
  }), false);
  const uploadCount = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachments.createImage').length);
  let count = await uploadCount();
  // Exercise an actual Chromium clipboard write + keyboard paste in this
  // isolated browser, as well as the synthetic OS transfer variants below.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d'); context.fillStyle = '#12ab34'; context.fillRect(0, 0, 2, 2);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  });
  await page.locator('#prompt').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.waitForFunction(n => window.sentMessages.filter(m => m.type === 'attachments.createImage').length === n + 1, count);
  count++;
  // Simulate unnamed OS screenshot bytes, item-only transfers, and MIME aliases.
  for (const [name, type, itemOnly] of [['', '', true], ['screenshot', 'application/octet-stream', false], ['same.png', 'image/x-png', true]]) {
    await page.evaluate(({ name, type, itemOnly }) => {
      const file = new File([window.clipboardTestBytes], name, { type });
      window.clipboardTestPaste(itemOnly ? [] : [file], [{ kind: 'file', type: 'image/png', getAsFile: () => file }]);
    }, { name, type, itemOnly });
    await page.waitForFunction(n => window.sentMessages.filter(m => m.type === 'attachments.createImage').length === n + 1, count);
    count++;
  }
  // Files and items are two views of the clipboard. Preserve additional items once.
  await page.evaluate(() => {
    const a = new File([window.clipboardTestBytes], 'duplicate.png', { type: 'image/png' });
    const b = new File([window.clipboardTestBytes], 'duplicate.png', { type: 'image/png' });
    window.clipboardTestPaste([a], [a, b].map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })));
  });
  await page.waitForFunction(n => window.sentMessages.filter(m => m.type === 'attachments.createImage').length === n + 2, count);
  count += 2;
  assert.equal(await page.locator('.attachment-chip-name', { hasText: 'duplicate.png' }).count(), 2);
  // Remove before Host acknowledgement: a late response must not resurrect the chip.
  const last = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachments.createImage').at(-1));
  await page.locator('.attachment-remove').last().click();
  await page.evaluate(message => window.postMessage({ type: 'attachments.add', attachments: [{
    id: message.id, name: message.name, kind: 'image', uri: 'file:///remote-host/staged.png', mediaType: message.mediaType, size: message.size
  }] }, '*'), last);
  await page.waitForFunction(id => window.sentMessages.some(m => m.type === 'attachment.remove' && m.id === id), last.id);
  assert.equal(await page.locator('.attachment-chip-name', { hasText: 'duplicate.png' }).count(), 1);
  // A 2x1 Windows-style BMP is normalized into an actual PNG, not just relabeled.
  await page.evaluate(() => {
    const bytes = new Uint8Array(62); const view = new DataView(bytes.buffer);
    bytes.set([66, 77]); view.setUint32(2, 62, true); view.setUint32(10, 54, true);
    view.setUint32(14, 40, true); view.setInt32(18, 2, true); view.setInt32(22, 1, true);
    view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, 8, true);
    bytes.set([0, 0, 255, 0, 255, 0, 0, 0], 54);
    window.clipboardTestPaste([new File([bytes], '윈도우 캡처.bmp', { type: 'image/bmp' })], []);
  });
  await page.waitForFunction(n => window.sentMessages.filter(m => m.type === 'attachments.createImage').length === n + 1, count);
  count++;
  const bmp = await page.evaluate(async () => {
    const m = window.sentMessages.filter(m => m.type === 'attachments.createImage').at(-1);
    const img = new Image(); img.src = 'data:' + m.mediaType + ';base64,' + m.data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
    return { ...m, width: img.naturalWidth, height: img.naturalHeight, pixels: [...context.getImageData(0, 0, 2, 1).data] };
  });
  assert.equal(bmp.mediaType, 'image/png'); assert.equal(bmp.name, '윈도우 캡처.png');
  assert.equal(bmp.width, 2); assert.equal(bmp.height, 1);
  assert.deepEqual(bmp.pixels, [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.deepEqual([...Buffer.from(bmp.data, 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // Release all other pending chips through the ordinary Host response path.
  await page.evaluate(() => {
    for (const m of window.sentMessages.filter(m => m.type === 'attachments.createImage')) window.postMessage({ type: 'attachment.rejected', id: m.id }, '*');
  });
  await page.waitForFunction(() => document.querySelectorAll('.attachment-remove').length === 0);
  // Aborted FileReader must release the pending chip, preview URL and send lock.
  await page.evaluate(() => {
    window.clipboardOriginalReader = window.FileReader;
    window.clipboardRevoked = [];
    window.clipboardOriginalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { window.clipboardRevoked.push(url); window.clipboardOriginalRevoke.call(URL, url); };
    window.FileReader = class extends EventTarget {
      readAsDataURL() { queueMicrotask(() => this.dispatchEvent(new Event('abort'))); }
    };
    window.clipboardTestPaste([new File([window.clipboardTestBytes], 'aborted.png', { type: 'image/png' })], []);
  });
  await page.waitForFunction(() => !document.querySelector('.attachment-remove') && !document.getElementById('send-button').disabled);
  assert.ok(await page.evaluate(() => window.clipboardRevoked.length > 0));
  assert.equal(await uploadCount(), count);
  await page.evaluate(() => { window.FileReader = window.clipboardOriginalReader; URL.revokeObjectURL = window.clipboardOriginalRevoke; });
  // Cancelling while bytes are still being read must never send an upload.
  await page.evaluate(() => {
    const Original = window.FileReader;
    window.FileReader = class extends Original {
      readAsDataURL(blob) { window.clipboardFinishRead = () => super.readAsDataURL(blob); }
    };
    window.clipboardTestPaste([new File([window.clipboardTestBytes], 'cancel-reading.png', { type: 'image/png' })], []);
  });
  await page.waitForFunction(() => Boolean(window.clipboardFinishRead));
  await page.locator('.attachment-remove').last().click();
  await page.evaluate(async () => {
    window.clipboardFinishRead();
    await new Promise(resolve => setTimeout(resolve, 50));
    window.FileReader = window.clipboardOriginalReader;
  });
  assert.equal(await uploadCount(), count);
  assert.equal(await page.locator('.attachment-remove').count(), 0);
  // Invalid advertised image data fails visibly without trapping the composer.
  await page.evaluate(() => window.clipboardTestPaste([new File(['not a tiff'], 'capture.tiff', { type: 'image/tiff' })], []));
  await page.waitForFunction(() => !document.querySelector('.attachment-remove') && !document.getElementById('send-button').disabled);
  assert.equal(await uploadCount(), count);
  assert.ok(await page.getByText('Unable to read this image. Copy it again or attach a PNG, JPEG, GIF, or WebP file.', { exact: true }).count());
  await page.locator('#prompt').fill('');
}
module.exports = { checkClipboardImages };
