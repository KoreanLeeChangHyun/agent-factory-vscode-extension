import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const output = await build({ entryPoints: ['src/infrastructure/vscode/work-unit-git.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { unitGit, validateUnitBranch, directBranchEvidence, completedGitOperations } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
test('only confirmed push and merge reflogs reset a notice, never reset or fetch', () => {
  assert.deepEqual(completedGitOperations('HEAD@{date}\treset: moving to HEAD~1\ta\norigin/main@{date}\tfetch origin: fast-forward\tb'), []);
  assert.equal(completedGitOperations('origin/main@{date}\tupdate by push\ta\nHEAD@{date}\tmerge feature: Fast-forward\tb').length, 2);
});
test('real repository branch collision, push evidence and reset distinction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unit-git-'));
  try {
    const git = (...args) => unitGit(home, args);
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(home, 'file'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
    assert.match(await validateUnitBranch(home, 'main'), /already exists/);
    assert.equal(await validateUnitBranch(home, 'feature'), undefined);
    assert.ok(await validateUnitBranch(home, 'bad name'));
    assert.ok(await validateUnitBranch(home, '@{-1}'));
    const before = await directBranchEvidence(home);
    await git('init', '--bare', join(home, 'remote.git')); await git('remote', 'add', 'origin', join(home, 'remote.git')); await git('push', '-u', 'origin', 'main');
    const pushed = await directBranchEvidence(home);
    assert.equal(before.key, pushed.key); assert.equal(pushed.operations.length, 1);
    await git('reset', '--soft', 'HEAD');
    assert.deepEqual((await directBranchEvidence(home)).operations, pushed.operations);
    await git('checkout', '-b', 'feature'); await writeFile(join(home, 'file'), 'feature'); await git('commit', '-am', 'feature'); await git('checkout', 'main'); await git('merge', 'feature');
    assert.ok((await directBranchEvidence(home)).operations.length > pushed.operations.length);
  } finally { await rm(home, { recursive: true, force: true }); }
});
