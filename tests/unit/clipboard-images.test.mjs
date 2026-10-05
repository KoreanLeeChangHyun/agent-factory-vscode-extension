import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const context = {};
runInNewContext(await readFile(new URL('../../static/js/chat/attachments.js', import.meta.url), 'utf8'), context);
const { clipboardImages } = context.AgentFactoryChat.attachments({});
const file = (name, type = '', size = 10) => ({ name, type, size });
const item = (value, type = value.type) => ({ kind: 'file', type, getAsFile: () => value });

test('clipboard collection preserves multiplicity across files/items without duplicating their shared view', () => {
  const first = file('image.png', 'image/png');
  const second = file('image.png', 'image/png');
  assert.deepEqual(Array.from(clipboardImages({ files: [first], items: [item(first), item(second)] })), [first, second]);
  assert.deepEqual(Array.from(clipboardImages({ files: [first, second], items: [item(first)] })), [first, second]);
  assert.deepEqual(Array.from(clipboardImages({ files: [first], items: [item(first)] })), [first]);
});

test('clipboard metadata variants keep bytes local to the Webview instead of turning UI paths into Host paths', () => {
  for (const candidate of [file('', ''), file('image', 'application/octet-stream'), file('capture.PNG', ''),
    file('캡처.bmp', 'image/bmp'), file('capture.tiff', 'image/tiff'), file('capture', 'image/x-png')]) {
    assert.deepEqual(Array.from(clipboardImages({ items: [item(candidate)], files: [] })), [candidate]);
  }
  const noMetadata = file('unnamed.bin');
  assert.deepEqual(Array.from(clipboardImages({ items: [item(noMetadata, 'image/png')] })), [noMetadata]);
  for (const uri of ['file:///C:/Users/test/image.png', 'file:///Users/test/image.png', 'file:///mnt/c/image.png']) {
    assert.deepEqual(Array.from(clipboardImages({ items: [{ kind: 'string', type: 'text/uri-list' }],
      files: [], getData: () => uri })), []);
  }
});

test('unreadable optional clipboard items do not suppress available files or capture ordinary text', () => {
  const png = file('image.png', 'image/png');
  assert.deepEqual(Array.from(clipboardImages({ files: [png], items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] })), [png]);
  assert.deepEqual(Array.from(clipboardImages({ files: [file('text.txt', 'text/plain')], items: [] })), []);
  assert.deepEqual(Array.from(clipboardImages({ files: [file('text.txt', '')], items: [] })), []);
});
