import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build, transform } from 'esbuild';

test('local file upload validates size, encoding and path-free names', async () => {
  const output = await build({ entryPoints: ['src/protocol/validator.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
  const { parseClientMessage } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const message = { type: 'attachments.createFile', id: 'file-one', name: 'notes.txt', size: 3, data: 'YWJj' };
  assert.deepEqual(parseClientMessage(message), message);
  assert.ok(parseClientMessage({ ...message, size: 0, data: '' }));
  for (const invalid of [{ name: '../escape' }, { name: 'C:\\escape' }, { name: '..' }, { size: 2 }, { size: 10 * 1024 * 1024 + 1 }, { data: 'not base64' }]) {
    assert.equal(parseClientMessage({ ...message, ...invalid }), undefined);
  }
});

test('selected file bytes are stored on the host and acknowledged only after storage succeeds', async () => {
  const source = await readFile('src/infrastructure/vscode/chat-panel-manager.ts', 'utf8');
  const method = source.slice(source.indexOf('  private async createFileAttachment('), source.indexOf('  private async createTextAttachment('));
  const { code } = await transform(method.replace('private async createFileAttachment(', 'async function createFileAttachment('), { loader: 'ts' });
  const writes = [], messages = [];
  let fail = false;
  const vscode = { Uri: { joinPath: (...parts) => parts.join('/') }, workspace: { fs: {
    async createDirectory() {}, async writeFile(uri, bytes) { if (fail) throw Error('write failed'); writes.push({ uri, bytes }); }
  } } };
  const create = runInNewContext(code + '\ncreateFileAttachment', { vscode, randomUUID: () => 'unique-upload', Buffer, localize: key => key });
  const owner = { context: { globalStorageUri: '/remote/storage' }, async post(panel, message) { messages.push(message); } };
  const managed = { state: { panelId: 'panel-one' }, panel: {} };
  const input = { type: 'attachments.createFile', id: 'file-one', name: 'notes.txt', size: 3, data: 'YWJj' };
  await create.call(owner, managed, input);
  assert.equal(writes[0].uri, '/remote/storage/uploaded-files/panel-one/unique-upload/notes.txt');
  assert.equal(writes[0].bytes.toString(), 'abc');
  assert.equal(messages[0].type, 'attachments.add');
  assert.equal(messages[0].attachments[0].id, input.id);
  messages.length = 0;
  fail = true;
  await create.call(owner, managed, input);
  assert.equal(messages[0].type, 'attachment.rejected');
  assert.equal(messages.some(m => m.type === 'attachments.add'), false);
});
