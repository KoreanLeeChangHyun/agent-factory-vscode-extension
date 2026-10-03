const assert = require('node:assert/strict');
async function checkLocalFilePicker(page) {
  await page.locator('#prompt').fill('Preserve this draft');
  const chooserEvent = page.waitForEvent('filechooser');
  await page.locator('#attach-button').click();
  const chooser = await chooserEvent;
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('로컬 파일 내용') },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }
  ]);
  await page.waitForFunction(() => window.sentMessages.filter(m => m.type === 'attachments.createFile').length === 2);
  const files = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachments.createFile'));
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), '로컬 파일 내용');
  assert.equal(files[1].size, 0);
  assert.equal(await page.locator('#prompt').inputValue(), 'Preserve this draft');
  assert.equal(await page.evaluate(() => window.sentMessages.some(m => m.type === 'attachments.pick')), false);
  await page.evaluate(files => window.postMessage({ type: 'attachments.add', attachments: files.map(m => ({
    id: m.id, name: m.name, size: m.size, kind: 'file', uri: 'file:///remote/uploads/' + m.name
  })) }, '*'), files);
  await page.waitForFunction(() => window.saved.attachments.filter(a => a.uri?.startsWith('file:///remote/uploads/')).length === 2);
  await page.locator('#attachment-file-input').setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'attachments.createImage'));
  const imageCount = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachments.createImage').length);
  await page.locator('#attachment-file-input').setInputFiles({ name: 'macos-empty-mime.png', mimeType: '', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(count => window.sentMessages.filter(m => m.type === 'attachments.createImage').length > count, imageCount);
  const before = await page.evaluate(() => window.sentMessages.length);
  await page.locator('#attachment-file-input').setInputFiles([]);
  assert.equal(await page.evaluate(() => window.sentMessages.length), before);
  await page.locator('#attachment-file-input').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'attachments.createFile').length), 2);
  console.log('Local file chooser, bytes, empty files, images, cancel and size limit checks passed');
}
module.exports = { checkLocalFilePicker };
