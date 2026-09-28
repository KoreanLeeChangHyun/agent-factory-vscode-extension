import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
const { NoteStore } = await importTypeScript('src/infrastructure/vscode/note-store.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
function storage() {
  const data = new Map();
  return { keys: () => [...data.keys()], get: key => data.get(key), async update(key, value) { data.set(key, value); } };
}
test('notes persist across chats, separate scopes and reject conflicting edits without loss', async () => {
  const global = storage(), workspace = storage();
  const store = new NoteStore(global, workspace);
  const note = { id: 'one', title: 'Prompt', body: 'Keep all text\n한글', revision: 0 };
  const first = await store.save('global', note);
  assert.equal(first.revision, 1);
  assert.deepEqual(await store.list('workspace'), []);
  const reopened = new NoteStore(global, workspace);
  assert.equal((await reopened.list('global'))[0].body, note.body);
  await store.save('workspace', { ...note, body: 'Workspace only' });
  const results = await Promise.allSettled([
    store.save('global', { ...note, revision: 1, body: 'Changed' }),
    store.save('global', { ...note, revision: 1, body: 'Stale' })
  ]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.equal((await store.list('global'))[0].body, 'Changed');
  assert.equal((await store.list('workspace'))[0].body, 'Workspace only');
});
test('notes protocol validates storage scope, identifiers and revision', () => {
  const message = { type: 'notes.save', scope: 'global', note: { id: 'one', title: '', body: '', revision: 0 } };
  assert.deepEqual(parseClientMessage(message), {...message, note: {...message.note, folder: ''}});
  assert.equal(parseClientMessage({ ...message, scope: 'other' }), undefined);
  for (const patch of [{ id: '../escape' }, { body: 1 }, { revision: -1 }]) {
    assert.equal(parseClientMessage({ ...message, note: { ...message.note, ...patch } }), undefined);
  }
});

test('folders and moves persist with note content and revision protection', async () => {
 const g=storage(), w=storage(), store=new NoteStore(g,w);
 await store.createFolder('workspace','Projects/Sub');
 assert.deepEqual(await store.folders('workspace'), ['Projects','Projects/Sub']);
 await assert.rejects(store.createFolder('workspace','../escape'));
 await assert.rejects(store.createFolder('workspace','Projects'));
 const note=await store.save('workspace',{id:'n', title:'Title', body:'Keep text', revision:0});
 const moved=await store.save('workspace',{...note,folder:'Projects/Sub'});
 await assert.rejects(store.save('workspace',{...note,folder:''}));
 const restored=new NoteStore(g,w);
 assert.equal((await restored.list('workspace'))[0].folder,'Projects/Sub');
 assert.equal((await restored.list('workspace'))[0].body,'Keep text');
 assert.deepEqual(await restored.folders('global'),[]);
 await restored.save('workspace',{...moved,folder:''});
 assert.equal((await restored.list('workspace'))[0].folder,'');
 assert.equal(parseClientMessage({type:'notes.folder',scope:'workspace',folder:'../x'}),undefined);
});
