const assert = require('node:assert/strict');
async function checkImageConversion(page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 3; canvas.height = 2;
    const context = canvas.getContext('2d');
    context.fillStyle = 'red'; context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png');
  });
  await page.evaluate(source => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachments.add', attachments: [
      { id: 'image-conversion', kind: 'image', name: 'sample.png', uri: 'file:///sample.png', previewUri: source },
      { id: 'pending-conversion', kind: 'image', name: 'pending.png', pending: true },
      { id: 'text-conversion', kind: 'file', name: 'sample.txt', uri: 'file:///sample.txt' }
    ] } }));
  }, png);
  await page.locator('#attachment-list .attachment-chip').first().click({ button: 'right' });
  assert.equal(await page.locator('#image-converter').isVisible(), true);
  assert.equal(await page.locator('#image-converter-name').textContent(), 'sample.png');
  assert.equal(await page.locator('#image-converter-format option').count(), 2);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachment.convert').length), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#image-converter').isVisible(), false);
  await page.locator('#attachment-list .attachment-chip').first().focus();
  await page.keyboard.press('Shift+F10');
  assert.equal(await page.locator('#image-converter').isVisible(), true);
  await page.locator('#image-converter-format').selectOption('image/webp');
  await page.locator('#image-converter-submit').click();
  const request = await page.evaluate(() => window.sentMessages.find(m => m.type === 'attachment.convert'));
  assert.equal(request.mediaType, 'image/webp');
  assert.equal(await page.locator('#image-converter-submit').isDisabled(), true);
  await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachment.conversionResult', id, error: 'Conversion failed; retry.' } })), request.requestId);
  assert.equal(await page.locator('#image-converter-status').textContent(), 'Conversion failed; retry.');
  assert.equal(await page.locator('#image-converter-submit').isDisabled(), false);
  assert.equal(await page.locator('#attachment-list .attachment-chip').count(), 3);
  await page.locator('#image-converter-submit').click();
  const retry = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachment.convert').at(-1));
  await page.evaluate(id => window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachment.conversionResult', id, path: '/project/docs/output/sample.webp' } })), retry.requestId);
  assert.equal(await page.locator('#attachment-list .attachment-chip').count(), 2);
  assert.equal(await page.evaluate(() => window.saved.attachments.some(item => item.id === 'image-conversion')), false);
  assert.equal(await page.evaluate(() => window.sentMessages.some(item => item.type === 'attachment.remove')), false);
  await page.locator('#image-converter-reveal').click();
  assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'attachment.revealConverted');
  await page.setViewportSize({ width: 360, height: 640 });
  const bounds = await page.locator('#image-converter').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
  await page.screenshot({ path: '/tmp/af-image-converter-ui.png' });
  await page.locator('#image-converter-close').click();
  await page.locator('#attachment-list .attachment-chip').nth(0).dispatchEvent('contextmenu');
  await page.locator('#attachment-list .attachment-chip').nth(1).dispatchEvent('contextmenu');
  assert.equal(await page.locator('#image-converter').isVisible(), false);
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp']) {
    await page.evaluate(({ source, mediaType }) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'attachment.encode', id: mediaType, source, mediaType, name: 'sample.png' }
    })), { source: png, mediaType });
    await page.waitForFunction(type => window.sentMessages.some(m => m.type === 'attachment.converted' && m.id === type), mediaType);
    const result = await page.evaluate(type => window.sentMessages.find(m => m.type === 'attachment.converted' && m.id === type), mediaType);
    assert.equal(result.mediaType, mediaType);
    assert.equal(Buffer.from(result.data, 'base64').length, result.size);
    const decoded = await page.evaluate(async result => {
      const image = new Image(); image.src = `data:${result.mediaType};base64,${result.data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, transparentPixel: Array.from(context.getImageData(2, 1, 1, 1).data) };
    }, result);
    assert.equal(decoded.width, 3); assert.equal(decoded.height, 2);
    if (mediaType === 'image/jpeg') {
      assert.equal(decoded.transparentPixel[3], 255);
      assert.ok(decoded.transparentPixel.slice(0, 3).every(channel => channel > 220));
    } else assert.equal(decoded.transparentPixel[3], 0);
  }
  await page.evaluate(source => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'attachment.encode', id: 'unsupported', source, mediaType: 'image/unsupported', name: 'sample.png' }
  })), png);
  await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'attachment.conversionFailed' && m.id === 'unsupported'));
  await page.goto(new URL('?lang=ko', page.url()).href);
  await page.setViewportSize({ width: 479, height: 600 });
  await page.evaluate(source => window.dispatchEvent(new MessageEvent('message', { data: { type: 'attachments.add', attachments: [
    { id: 'long-image', kind: 'image', name: '20244fe9-9620-43c4-ad1d-dff78b3bb88c.webp', uri: 'file:///long.webp', previewUri: source }
  ] } })), png);
  await page.locator('#attachment-list .attachment-chip').first().click({ button: 'right' });
  assert.equal(await page.locator('#image-converter-title').textContent(), '이미지 형식 변환');
  for (const width of [479, 360]) {
    await page.setViewportSize({ width, height: 600 });
    assert.equal(await page.locator('#image-converter').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('#image-converter-name').getAttribute('title'), '20244fe9-9620-43c4-ad1d-dff78b3bb88c.webp');
    await page.screenshot({ path: `/tmp/af-image-converter-ko-${width}.png` });
  }

}
module.exports = { checkImageConversion };
