import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
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

// Cache lifecycle uses injected notifications; the runtime adapter suite covers
// filesystem changes and fresh inspection when OS watches are unavailable.
const { ObservedRunCache } = await importTypeScript('src/infrastructure/agent-factory/observed-run-cache.ts');
function cacheFixture(t, now = Date.now, lifetime = 10000, limit = 128) {
  const watchers = new Set();
  const cache = new ObservedRunCache(now, lifetime, limit, (path, notify) => {
    const watcher = new EventEmitter();
    watcher.notify = notify;
    watcher.close = () => { if (watchers.delete(watcher)) watcher.emit('close'); };
    watchers.add(watcher);
    return watcher;
  });
  t.after(() => cache.dispose());
  return { cache, watchers };
}
test('watch notifications invalidate cached directory relationships', t => {
  const { cache, watchers } = cacheFixture(t);
  const identity = {};
  cache.observe('run', identity, ['children'])('cached');
  assert.equal(cache.get('run', identity), 'cached');
  [...watchers][0].notify();
  assert.equal(cache.get('run', identity), undefined);
  assert.equal(watchers.size, 0);
});
test('notifications during a scan reject stale publication and missing watches use fresh inspection', t => {
  const { cache, watchers } = cacheFixture(t);
  const identity = {};
  const publish = cache.observe('run', identity, ['children']);
  [...watchers][0].notify();
  publish('stale');
  assert.equal(cache.get('run', identity), undefined);
  const absent = new ObservedRunCache(Date.now, 10000, 128, () => {
    throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
  });
  t.after(() => absent.dispose());
  absent.observe('absent', identity, ['missing'])('value');
  assert.equal(absent.get('absent', identity), undefined);
});
test('missed-event expiry, identity changes and watcher bounds across 30 simulated days', t => {
  let now = 0;
  const { cache, watchers } = cacheFixture(t, () => now, 10000, 4);
  const identity = {};
  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < 20; i++) {
      cache.observe(String(i), identity, ['children'])(i);
      assert.ok(cache.entries.size <= 4);
      assert.ok(watchers.size <= 4);
    }
    assert.equal(cache.get('0', identity), 0);
    assert.equal(cache.get('19', identity), undefined);
    now += 86400000;
    for (let i = 0; i < 4; i++) assert.equal(cache.get(String(i), identity), undefined);
    assert.equal(watchers.size, 0);
  }
  cache.observe('last', identity, ['children'])('value');
  assert.equal(cache.get('last', {}), undefined);
  cache.dispose();
  assert.equal(cache.entries.size, 0);
  assert.equal(watchers.size, 0);
});
test('abandoned cache entries close watchers after their lifetime', async t => {
  const { cache, watchers } = cacheFixture(t, Date.now, 25, 4);
  cache.observe('key', {}, ['children'])('value');
  assert.equal(watchers.size, 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cache.entries.size, 0);
  assert.equal(watchers.size, 0);
});

test('watch exhaustion backs off while preserving uncached reads and later recovery', () => {
 let now=0,attempts=0;const cache=new ObservedRunCache(()=>now,10000,128,()=>{attempts++;throw Object.assign(new Error('watch limit'),{code:'ENOSPC'});});
 try {
  for(let i=0;i<100;i++) {cache.observe('run',{},['path'])('value');assert.equal(cache.get('run',{}),undefined);}
  assert.equal(attempts,1,'watch exhaustion must not retry on every refresh');
  now=10001;cache.observe('run',{},['path'])('value');assert.equal(attempts,2);
 } finally {cache.dispose();}
});


test('watcher errors suspend new watches across runs, then recover after cooldown', () => {
 let now=0, attempts=0, watcher;
 const cache=new ObservedRunCache(()=>now,10000,128,()=>{attempts++;watcher=new EventEmitter();watcher.close=()=>watcher.emit('close');return watcher;});
 const identity={};
 try {
  cache.observe('one',identity,['path'])('before');assert.equal(cache.get('one',identity),'before');
  watcher.emit('error',new Error('ENOSPC'));assert.equal(cache.get('one',identity),undefined);
  for(let i=0;i<1000;i++) cache.observe('run-'+i,identity,['path'])('ignored');
  assert.equal(attempts,1);
  now=10001;cache.observe('one',identity,['path'])('after');assert.equal(attempts,2);assert.equal(cache.get('one',identity),'after');
 } finally {cache.dispose();}
});
