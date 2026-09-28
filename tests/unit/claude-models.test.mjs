import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/infrastructure/agent-factory/model-catalog.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { readProviderModels, antigravityModels, CLAUDE_MODELS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('Claude discovery augments Codex and missing optional CLI preserves its catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-claude-catalog-'));
  try {
    await writeFile(join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-existing', visibility: 'list' }] }));
    assert.deepEqual(await readProviderModels(root, join(root, 'missing'), join(root, 'missing-agy')), ['gpt-existing']);
    const cli = join(root, 'claude');
    await writeFile(cli, '#!/bin/sh\nprintf "2.1.283 (Claude Code)\\n"\n');
    await chmod(cli, 0o700);
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy')), ['gpt-existing', ...CLAUDE_MODELS]);
    await rm(join(root, 'models_cache.json'));
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy')), [...CLAUDE_MODELS]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude catalog lists pinned model versions before the tracking aliases', () => {
  assert.deepEqual(CLAUDE_MODELS.slice(0, 4), ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
  assert.ok(['claude-opus', 'claude-sonnet', 'claude-haiku'].every(alias => CLAUDE_MODELS.includes(alias)));
  assert.ok(CLAUDE_MODELS.every(id => /^claude-[a-z0-9-]{1,90}$/.test(id)));
});

test('Antigravity models collapse Gemini effort variants and qualify other families', async () => {
  // Observed `agy models` identifiers (agy 1.2.12, Google AI Pro).
  assert.deepEqual(antigravityModels(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium', '', 'Fetching available models...']),
    ['gemini-3.8-flash', 'gemini-3.1-pro', 'antigravity/claude-sonnet-4-6', 'antigravity/claude-opus-4-6-thinking', 'antigravity/gpt-oss-120b-medium']);
  const root = await mkdtemp(join(tmpdir(), 'af-agy-catalog-'));
  try {
    const agy = join(root, 'agy');
    await writeFile(agy, '#!/bin/sh\nprintf "Fetching available models...\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n"\n');
    await chmod(agy, 0o700);
    assert.deepEqual(await readProviderModels(join(root, 'no-codex'), join(root, 'missing'), agy), ['gemini-3.8-flash', 'antigravity/claude-sonnet-4-6']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
