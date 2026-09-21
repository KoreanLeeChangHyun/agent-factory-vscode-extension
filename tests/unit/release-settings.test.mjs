import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fixture } from '../support/release-fixture.mjs';

for (const trackedSettings of [true, false]) {
  test(`${trackedSettings ? 'tracked' : 'untracked'} local settings survive release and resume without entering the commit`, t => {
    const f = fixture(t, { trackedSettings });
    const settings = '.vscode/settings.json';
    const baseTree = f.command('git', ['ls-tree', 'HEAD', '--', settings]);
    mkdirSync(path.join(f.root, '.vscode'), { recursive: true });
    const localSettings = '{\n  "agentFactory.mainChat.statusItems": ["branch", "queue"]\n}\n';
    writeFileSync(path.join(f.root, settings), localSettings);

    // A different tracked file still blocks preparation before any release state exists.
    writeFileSync(path.join(f.root, 'scripts/node-file-polyfill.cjs'), '// unrelated local edit\n');
    let r = f.release('--message', 'Settings release');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Changes outside --files: scripts\/node-file-polyfill\.cjs/);
    assert.throws(f.state, /ENOENT/);
    writeFileSync(path.join(f.root, 'scripts/node-file-polyfill.cjs'), '');

    r = f.release('--message', 'Settings release');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().stage, 'awaiting-browser');
    assert.deepEqual(f.command('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'),
      ['package-lock.json', 'package.json']);
    assert.equal(f.command('git', ['ls-tree', 'HEAD', '--', settings]), baseTree);
    assert.equal(f.command('git', ['ls-tree', 'origin/main', '--', settings]), baseTree);
    assert.ok(!f.state().files.includes(settings));
    assert.equal(f.command('git', ['diff', '--cached', '--name-only']), '');

    // An unrelated untracked editor file must also block resume.
    const other = path.join(f.root, '.vscode/other.json');
    writeFileSync(other, '{}\n');
    r = f.release('--resume', '--browser-start');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Changes outside --files: \.vscode\/other\.json/);
    assert.equal(f.state().stage, 'awaiting-browser');
    rmSync(other);
    r = f.release('--resume', '--browser-start');
    assert.equal(r.status, 0, r.stderr);
    r = f.release('--resume', '--published', '--publication-evidence', 'Fixture sample 1.0.1 accepted');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().stage, 'completed');
    assert.equal(readFileSync(path.join(f.root, settings), 'utf8'), localSettings);
    assert.equal(f.command('git', ['ls-tree', 'HEAD', '--', settings]), baseTree);
    assert.equal(f.command('git', ['diff', '--cached', '--name-only']), '');
  });
}

test('local settings cannot be selected or staged for release', t => {
  const f = fixture(t, { trackedSettings: true });
  const settings = '.vscode/settings.json';
  const before = f.command('git', ['rev-parse', 'HEAD']);
  const localSettings = '{"agentFactory.mainChat.statusItems":["queue"]}\n';
  writeFileSync(path.join(f.root, settings), localSettings);
  let r = f.release('--message', 'Forbidden settings', '--files', settings);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unsafe file path: \.vscode\/settings\.json/);
  f.command('git', ['add', '--', settings]);
  r = f.release('--message', 'Staged settings');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Resolve conflicts and staged changes before releasing/);
  assert.equal(f.command('git', ['rev-parse', 'HEAD']), before);
  assert.equal(f.command('git', ['diff', '--cached', '--name-only']), settings);
  assert.equal(readFileSync(path.join(f.root, settings), 'utf8'), localSettings);
  assert.throws(f.state, /ENOENT/);
});
