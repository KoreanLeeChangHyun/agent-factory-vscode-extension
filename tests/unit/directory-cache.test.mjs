import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from '../support/import-typescript.mjs';
const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'af-directory-cache-'));
  const client = new AgentFactoryClient('/unused', root);
  t.after(async () => { client.observedChildRuns.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, client };
}
test('directory cache updates avoid whole-cache scans and preserve directory eviction', async t => {
  const { root, client } = await fixture(t);
  let traversals = 0;
  const values = client.directorySnapshots.values.bind(client.directorySnapshots);
  client.directorySnapshots.values = function* () { for (const entry of values()) { traversals++; yield entry; } };
  for (let i = 0; i < 1030; i++) {
    const path = join(root, String(i));
    await mkdir(path);
    assert.deepEqual(await client.managedDirectoryEntries(path), []);
  }
  assert.equal(client.directorySnapshots.size, 1024);
  assert.equal(client.directorySnapshots.has(join(root, '0')), false);
  assert.equal(traversals, 0, `cache entries revisited while updating: ${traversals}`);
});
test('directory cache tracks refresh, additions, deletions and total entry eviction', async t => {
  const { root, client } = await fixture(t);
  let now = 0;
  client.now = () => now;
  const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  for (const path of [a, b]) {
    for (let start = 0; start < 5100; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(path, String(start + i)), '')));
    }
  }
  assert.equal((await client.managedDirectoryEntries(a)).length, 5100);
  assert.equal((await client.managedDirectoryEntries(b)).length, 5100);
  assert.equal(client.directorySnapshots.has(a), false);
  assert.equal(client.directorySnapshots.has(b), true);
  now += 10001;
  assert.equal((await client.managedDirectoryEntries(b)).length, 5100);
  assert.equal(client.directorySnapshotEntries, 5100);
  await writeFile(join(b, 'new'), '');
  assert.equal((await client.managedDirectoryEntries(b)).length, 5101);
  await rm(join(b, 'new'));
  assert.equal((await client.managedDirectoryEntries(b)).length, 5100);
  assert.equal(client.directorySnapshotEntries, 5100);
  await rm(b, { recursive: true });
  await assert.rejects(client.managedDirectoryEntries(b), { code: 'ENOENT' });
  await mkdir(b);
  assert.deepEqual(await client.managedDirectoryEntries(b), []);
  assert.equal(client.directorySnapshotEntries, 0);
});
