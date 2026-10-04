import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { readMarkdownImage } = await importTypeScript('src/infrastructure/vscode/markdown-image.ts');
test('local Markdown images resolve while outside files and invalid content are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'af-markdown-'));
  try {
    const root = join(dir, 'workspace'); await mkdir(root);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await writeFile(join(root, 'preview.png'), png);
    await writeFile(join(dir, 'outside.png'), png);
    await writeFile(join(root, 'fake.png'), 'not an image');
    await symlink(join(dir, 'outside.png'), join(root, 'escape.png'));
    assert.equal(await readMarkdownImage(join(root, 'preview.png'), [root]), 'data:image/png;base64,' + png.toString('base64'));
    for (const name of ['../outside.png', './escape.png', './fake.png', './missing.png']) assert.equal(await readMarkdownImage(name, [root]), undefined);
    assert.equal(await readMarkdownImage('https://example.com/image.png', [root]), undefined);
    assert.equal(await readMarkdownImage(join(root, 'preview.png'), []), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
