import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from '../support/import-typescript.mjs';

const { readProviderModels, readClaudeModels, antigravityModels, modelSelectionCatalog } = await importTypeScript('src/infrastructure/agent-factory/model-catalog.ts');

test('selection evidence keeps exact IDs, constraints, unknown facts and recoverable detail revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-model-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A large valid cache remains readable; no model or detail is cut off.
  const model = { slug: 'gpt-exact', visibility: 'list', description: 'Scoped coding',
    context_window: 100000, supported_reasoning_levels: [{ effort: 'high' }],
    input_modalities: ['text'], details: '한'.repeat(1500000) };
  await writeFile(join(root, 'models_cache.json'), JSON.stringify({ client_version: 'fixture', models: [model] }));
  assert.deepEqual(await readProviderModels(root, join(root, 'no-claude'), join(root, 'no-agy')), ['gpt-exact']);
  const catalog = await modelSelectionCatalog(root);
  const candidate = catalog.candidates.find(item => item.id === 'gpt-exact');
  assert.equal(candidate.suitableTasks, 'Scoped coding');
  assert.equal(candidate.quality, 'unknown');
  assert.equal(candidate.cost, 'unknown');
  assert.equal(candidate.constraints.contextWindow, 100000);
  assert.deepEqual(candidate.constraints.reasoningEfforts, ['high']);
  assert.equal(candidate.detail.source, join(root, 'models_cache.json'));
  assert.equal(candidate.detail.providerVersion, 'fixture');
  assert.match(candidate.detail.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(candidate).includes(model.details), false);
  const previous = candidate.detail.revision;
  await writeFile(join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-exact', visibility: 'list' }] }));
  const changed = (await modelSelectionCatalog(root)).candidates.find(item => item.id === 'gpt-exact');
  assert.notEqual(changed.detail.revision, previous);
  assert.equal(changed.suitableTasks, 'unknown');
});

test('Claude discovery augments Codex and missing optional CLI preserves its catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-claude-catalog-'));
  try {
    await writeFile(join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-existing', visibility: 'list' }] }));
    const claudeHome = join(root, 'claude-home');
    const catalogRoot = join(claudeHome, 'cache', 'model-catalog');
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(catalogRoot, 'older.json'), JSON.stringify({ fetchedAt: 10, catalog: { surface: 'cc', config: {
      models: [{ id: 'claude-sonnet-5' }, { id: 'invalid model' }]
    } } }));
    await writeFile(join(catalogRoot, 'current.json'), JSON.stringify({ fetchedAt: 20, catalog: { surface: 'cc', config: {
      models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5-5' }]
    } } }));
    assert.deepEqual(await readProviderModels(root, join(root, 'missing'), join(root, 'missing-agy'), claudeHome), ['gpt-existing']);
    const cli = join(root, 'claude');
    await writeFile(cli, '#!/bin/sh\nprintf "2.1.283 (Claude Code)\\n"\n');
    await chmod(cli, 0o700);
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy'), claudeHome),
      ['gpt-existing', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    // Undetected providers contribute nothing, so no detected CLI leaves an empty picker.
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy'), claudeHome, { codex: false }),
      ['claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy'), claudeHome,
      { codex: false, claude: false, antigravity: false }), []);
    await rm(join(root, 'models_cache.json'));
    assert.deepEqual(await readProviderModels(root, cli, join(root, 'missing-agy'), claudeHome),
      ['claude-opus-5-5', 'claude-sonnet-5-5']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude discovery uses the latest valid Claude Code catalog without a bundled fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-claude-live-catalog-'));
  try {
    assert.deepEqual(await readClaudeModels(root), []);
    const catalogRoot = join(root, 'cache', 'model-catalog');
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(join(catalogRoot, 'malformed.json'), '{');
    await writeFile(join(catalogRoot, 'other-surface.json'), JSON.stringify({ fetchedAt: 30,
      catalog: { surface: 'api', config: { models: [{ id: 'claude-not-for-code' }] } } }));
    await writeFile(join(catalogRoot, 'current.json'), JSON.stringify({ fetchedAt: 20,
      catalog: { surface: 'cc', config: { models: [{ id: 'claude-sonnet-5-5' }, { id: 'gpt-not-claude' }] } } }));
    assert.deepEqual(await readClaudeModels(root), ['claude-sonnet-5-5']);
  } finally { await rm(root, { recursive: true, force: true }); }
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
