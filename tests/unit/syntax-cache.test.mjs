import test from 'node:test';
import assert from 'node:assert/strict';
import { importTypeScript } from '../support/import-typescript.mjs';

test('syntax results reuse concurrent work, separate themes and evict bounded entries', async () => {
  await importTypeScript('src/webview/syntax-highlighter.ts');
  const api = globalThis.agentFactorySyntaxHighlighter;
  const code = 'const answer = 42;';
  const [first, second] = await Promise.all([api.highlight(code, 'js', true), api.highlight(code, 'javascript', true)]);
  assert.ok(first.flat().length);
  assert.strictEqual(first, second, 'Concurrent aliases reuse one token result');
  assert.equal(first.flat().map(t => t.content).join(''), code);
  assert.notStrictEqual(await api.highlight(code, 'js', false), first);
  assert.notStrictEqual(await api.highlight(code, 'js', true, true), first);
  await api.configureTheme({ theme: { name: 'custom', settings: [{ settings: { foreground: '#112233', background: '#000000' } }] } });
  const custom = await api.highlight(code, 'js', true);
  await api.configureTheme({ theme: { name: 'custom', settings: [{ settings: { foreground: '#abcdef', background: '#000000' } }] } });
  const changed = await api.highlight(code, 'js', true);
  assert.notStrictEqual(custom, changed, 'Reloading the same theme name invalidates tokens');
  assert.notDeepEqual(custom, changed);
  await api.configureTheme({});
  const oldest = await api.highlight(code, 'js', true);
  for (let i = 0; i < 128; i++) await api.highlight('let value = ' + i, 'js', true);
  assert.notStrictEqual(await api.highlight(code, 'js', true), oldest, 'Entry limit evicts old snippets');
  const sentinel = await api.highlight('const sentinel = 1;', 'js', true);
  // Many tokens force weight eviction before the 128-entry limit.
  for (let i = 0; i < 8; i++) await api.highlight(('let x = 1;\n').repeat(1000) + '// ' + i, 'js', true);
  assert.notStrictEqual(await api.highlight('const sentinel = 1;', 'js', true), sentinel);
  assert.deepEqual(await api.highlight('x'.repeat(512001), 'js', true), []);
  assert.deepEqual(await api.highlight('hello', 'unknown-language', true), []);
});
