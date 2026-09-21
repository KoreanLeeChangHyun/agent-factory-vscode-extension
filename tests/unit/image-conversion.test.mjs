import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('conversion output preserves existing files and allocates unique names concurrently', async () => {
  const { saveConvertedImage } = await importTypeScript('src/infrastructure/vscode/converted-image-store.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-convert-'));
  try {
    const paths = await Promise.all(Array.from({ length: 6 }, () => saveConvertedImage(root, '사진.webp', 'image/png', png.toString('base64'), png.length)));
    assert.equal(new Set(paths).size, 6);
    assert.ok(paths.includes(join(root, 'docs/output/사진.png')));
    assert.ok(paths.includes(join(root, 'docs/output/사진 (5).png')));
    for (const path of paths) assert.deepEqual(await readFile(path), png);
    const escaped = await saveConvertedImage(root, '../../escape.webp', 'image/png', png.toString('base64'), png.length);
    assert.equal(dirname(escaped), join(root, 'docs/output'));
    await assert.rejects(saveConvertedImage(root, 'bad.png', 'image/jpeg', png.toString('base64'), png.length));
    await assert.rejects(saveConvertedImage(root, 'bad.png', 'image/png', png.toString('base64'), 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conversion refuses output directories linked outside the project', async () => {
  const { saveConvertedImage } = await importTypeScript('src/infrastructure/vscode/converted-image-store.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-convert-'));
  const external = await mkdtemp(join(tmpdir(), 'af-external-'));
  try {
    await mkdir(join(root, 'docs'));
    await symlink(external, join(root, 'docs/output'));
    await assert.rejects(saveConvertedImage(root, 'one.png', 'image/png', png.toString('base64'), png.length), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('conversion protocol rejects unsafe identifiers, output types and corrupt data', async () => {
  const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
  const start = { type: 'attachment.convert', id: 'source-one', name: '사진.png', requestId: 'conversion-one', mediaType: 'image/webp' };
  assert.deepEqual(parseClientMessage(start), start);
  assert.equal(parseClientMessage({ ...start, id: '../escape' }), undefined);
  assert.equal(parseClientMessage({ ...start, mediaType: 'image/gif' }), undefined);
  assert.equal(parseClientMessage({ ...start, requestId: '../escape' }), undefined);
  const result = { type: 'attachment.converted', id: 'request-one', name: '사진.png', mediaType: 'image/png', size: png.length, data: png.toString('base64') };
  assert.deepEqual(parseClientMessage(result), result);
  assert.equal(parseClientMessage({ ...result, mediaType: 'image/gif' }), undefined);
  assert.equal(parseClientMessage({ ...result, size: png.length + 1 }), undefined);
});

test('host binds output to a confirmed request, preserves source, and reveals the saved file', async () => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const { runInNewContext } = await import('node:vm');
  const require = createRequire(import.meta.url);
  const output = await build({ entryPoints: [new URL('../../src/infrastructure/vscode/chat-panel-manager.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'] });
  const root = await mkdtemp(join(tmpdir(), 'af-convert-host-'));
  const source = join(root, 'original.png');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(source, png);
  const notices = [], commands = [];
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
    window: {
      showQuickPick() { assert.fail('Conversion must use the chat UI'); },
      showWarningMessage() { assert.fail('Conversion must use the chat UI'); },
      showInformationMessage() { assert.fail('Conversion must use the chat UI'); }
    },
    commands: { async executeCommand(...args) { commands.push(args); } },
    Uri: { file(fsPath) { return { fsPath }; } }
  };
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, Buffer, URL, console, process, setTimeout, clearTimeout, global: { Date },
    require: name => name === 'vscode' ? vscode : require(name) });
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => ({ available: false }));
  manager.imageAttachmentPath = async () => ({ fsPath: source });
  manager.post = async (_panel, message) => { notices.push(message); };
  const managed = { state: { panelId: 'panel' }, panel: {} };
  try {
    await manager.convertImageAttachment(managed, 'image-one', 'original.png', 'convert-one', 'image/webp');
    const encode = notices.find(message => message.type === 'attachment.encode');
    assert.ok(encode); assert.equal(encode.mediaType, 'image/webp');
    await manager.finishImageConversion(managed, { type: 'attachment.converted', id: encode.id, name: 'forged', mediaType: 'image/png', size: png.length, data: png.toString('base64') });
    assert.equal(commands.length, 0);
    assert.equal(managed.imageConversions.size, 0);
    managed.imageConversions.set('confirmed', { root, name: 'original.webp', mediaType: 'image/png' });
    const result = { type: 'attachment.converted', id: 'confirmed', name: '../forged', mediaType: 'image/png', size: png.length, data: png.toString('base64') };
    await manager.finishImageConversion(managed, result);
    await manager.finishImageConversion(managed, result);
    assert.equal(commands.length, 0);
    const saved = notices.find(message => message.type === 'attachment.conversionResult' && message.id === 'confirmed');
    assert.equal(saved.path, join(root, 'docs/output/original.png'));
    await manager.handleMessage(managed, { type: 'attachment.revealConverted', id: 'untrusted' });
    assert.equal(commands.length, 0);
    await manager.handleMessage(managed, { type: 'attachment.revealConverted', id: 'confirmed' });
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'revealInExplorer');
    assert.equal(commands[0][1].fsPath, join(root, 'docs/output/original.png'));
    assert.deepEqual(await readFile(source), png);
    assert.deepEqual(await readFile(commands[0][1].fsPath), png);
  } finally { await rm(root, { recursive: true, force: true }); }
});
