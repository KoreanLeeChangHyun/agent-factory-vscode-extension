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
  assert.deepEqual(parseClientMessage(message), message);
  assert.equal(parseClientMessage({ ...message, scope: 'other' }), undefined);
  for (const patch of [{ id: '../escape' }, { body: 1 }, { revision: -1 }]) {
    assert.equal(parseClientMessage({ ...message, note: { ...message.note, ...patch } }), undefined);
  }
});
