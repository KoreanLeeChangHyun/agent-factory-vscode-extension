import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from '../support/import-typescript.mjs';
const { ObservedRunCache } = await importTypeScript('src/infrastructure/agent-factory/observed-run-cache.ts');
async function fixture(t) {
 const path=await mkdtemp(join(tmpdir(),'af-observed-'));const cache=new ObservedRunCache();
 t.after(async()=>{cache.dispose();await rm(path,{recursive:true,force:true});});return {path,cache};
}
async function invalidated(cache,key,identity) {
 const end=Date.now()+2000;
 while(cache.get(key,identity)!==undefined && Date.now()<end) await new Promise(r=>setTimeout(r,5));
 assert.equal(cache.get(key,identity),undefined);
}
test('directory notifications invalidate creation, in-place writes, atomic replacement and deletion',async t=>{
 const {path,cache}=await fixture(t);const identity={};const file=join(path,'events.jsonl');
 for(const change of [()=>writeFile(file,'one'),()=>writeFile(file,'two'),async()=>{await writeFile(join(path,'next'),'three');await rename(join(path,'next'),file);},()=>rm(file)]) {
  cache.observe(path,identity,[path])('cached');assert.equal(cache.get(path,identity),'cached');
  await change();await invalidated(cache,path,identity);
 }
});
test('events during a scan cannot publish stale results; missing directories use uncached fallback',async t=>{
 const {path,cache}=await fixture(t);const identity={};
 const publish=cache.observe(path,identity,[path]);await writeFile(join(path,'change'),'x');
 await new Promise(r=>setTimeout(r,20));publish('stale');assert.equal(cache.get(path,identity),undefined);
 cache.observe('absent',identity,[join(path,'absent')])('value');assert.equal(cache.get('absent',identity),undefined);
});
test('missed-event expiry, clock progression, identity changes and watcher bounds across 30 simulated days',async t=>{
 const {path}=await fixture(t);let now=0;const cache=new ObservedRunCache(()=>now,10000,4);t.after(()=>cache.dispose());
 const identity={};
 for(let day=0;day<30;day++) {
  for(let i=0;i<20;i++) {cache.observe(String(i),identity,[path])(i);assert.ok(cache.entries.size<=4);}
  assert.equal(cache.get('0',identity),0);assert.equal(cache.get('19',identity),undefined);
  now+=86400000;for(let i=0;i<4;i++) assert.equal(cache.get(String(i),identity),undefined);
 }
 cache.observe('last',identity,[path])('value');assert.equal(cache.get('last',{}),undefined);
 cache.dispose();assert.equal(cache.entries.size,0);
});
test('abandoned entries release watchers after their lifetime',async t=>{
 const {path}=await fixture(t);const cache=new ObservedRunCache(Date.now,25,4);t.after(()=>cache.dispose());
 cache.observe('key',{},[path])('value');await new Promise(r=>setTimeout(r,60));assert.equal(cache.entries.size,0);
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
