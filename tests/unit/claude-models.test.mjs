import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/infrastructure/agent-factory/model-catalog.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { readProviderModels, CLAUDE_MODELS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('Claude discovery augments Codex and missing optional CLI preserves its catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-claude-catalog-'));
  try {
    await writeFile(join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-existing', visibility: 'list' }] }));
    assert.deepEqual(await readProviderModels(root, join(root, 'missing')), ['gpt-existing']);
    const cli = join(root, 'claude');
    await writeFile(cli, '#!/bin/sh\nprintf "2.1.283 (Claude Code)\\n"\n');
    await chmod(cli, 0o700);
    assert.deepEqual(await readProviderModels(root, cli), ['gpt-existing', ...CLAUDE_MODELS]);
    await rm(join(root, 'models_cache.json'));
    assert.deepEqual(await readProviderModels(root, cli), [...CLAUDE_MODELS]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude catalog lists pinned model versions before the tracking aliases', () => {
  assert.deepEqual(CLAUDE_MODELS.slice(0, 4), ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
  assert.ok(['claude-opus', 'claude-sonnet', 'claude-haiku'].every(alias => CLAUDE_MODELS.includes(alias)));
  assert.ok(CLAUDE_MODELS.every(id => /^claude-[a-z0-9-]{1,90}$/.test(id)));
});
