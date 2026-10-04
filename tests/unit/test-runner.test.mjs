import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { testArguments } from '../../scripts/test.mjs';

const runner = fileURLToPath(new URL('../../scripts/test.mjs', import.meta.url));

test('worker options preserve discovery, Node filters and the serial path', () => {
  const defaults = testArguments([], {});
  const serial = testArguments(['--serial'], {});
  const parallel = testArguments(['--jobs', '2'], {});
  assert.deepEqual(serial.slice(2), defaults.slice(2));
  assert.deepEqual(parallel.slice(2), defaults.slice(2));
  assert.equal(serial[1], '--test-concurrency=1');
  assert.equal(parallel[1], '--test-concurrency=2');
  assert.equal(testArguments([], { TEST_WORKERS: '3' })[1], '--test-concurrency=3');
  assert.deepEqual(testArguments(['--jobs=2', '--test-name-pattern=boundary', '--', 'one.test.mjs'], {}),
    ['--test', '--test-concurrency=2', '--test-name-pattern=boundary', 'one.test.mjs']);
  for (const value of ['0', '-1', '1.5', 'auto', '', '9007199254740992']) {
    assert.throws(() => testArguments(['--jobs', value], {}), /positive integer/);
    assert.throws(() => testArguments([], { TEST_WORKERS: value }), /positive integer/);
  }
  assert.throws(() => testArguments(['--jobs'], {}), /positive integer/);
});

test('serial and parallel workers execute the same files and propagate test failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-test-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['first', 'second'].map(name => join(root, `${name}.test.mjs`));
  for (const [index, path] of files.entries()) {
    await writeFile(path, `import test from 'node:test';
      test('${index ? 'second' : 'first'} sentinel', () => {
        if (process.env.AF_RUNNER_EXPECT_FAILURE === '${index}') throw new Error('intentional sentinel failure');
      });`);
  }
  for (const jobs of [1, 2]) {
    for (const fail of [false, true]) {
      const environment = { ...process.env, AF_RUNNER_EXPECT_FAILURE: fail ? '0' : '' };
      // A fresh runner must not inherit the parent worker's internal IPC mode.
      delete environment.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [runner, '--jobs', String(jobs), '--test-reporter=tap', '--', ...files], {
        encoding: 'utf8', env: environment
      });
      assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# tests 2\b/);
      assert.match(result.stdout, fail ? /# fail 1\b/ : /# pass 2\b/);
      assert.match(result.stdout, /first sentinel/);
      assert.match(result.stdout, /second sentinel/);
    }
  }
});
