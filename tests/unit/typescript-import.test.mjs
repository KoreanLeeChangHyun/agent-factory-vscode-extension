import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createTypeScriptBuilder, createTypeScriptImporter } from '../support/import-typescript.mjs';

const source = 'src/common/types/agent-permissions.ts';

function importer(marker, onStart) {
  return createTypeScriptImporter({
    logLevel: 'silent',
    plugins: [{ name: 'import-fixture', setup(api) {
      api.onStart(onStart);
      api.onLoad({ filter: /agent-permissions\.ts$/ }, () => ({
        contents: `export const marker = ${JSON.stringify(marker)};`
      }));
    } }]
  });
}

test('TypeScript preparation shares concurrent builds and isolates mock options', async () => {
  let builds = 0;
  const left = importer('left', () => { builds++; });
  const [first, second] = await Promise.all([left(source), left(source)]);
  assert.strictEqual(first, second);
  assert.strictEqual(await left(source), first);
  assert.equal(builds, 1);
  assert.equal(first.marker, 'left');

  const right = importer('right', () => { builds++; });
  assert.equal((await right(source)).marker, 'right');
  assert.equal(builds, 2);
  assert.equal(first.marker, 'left');
});

test('failed TypeScript preparation can retry within the same worker', async () => {
  let attempts = 0;
  const load = importer('recovered', () => {
    if (++attempts === 1) throw new Error('fixture build failure');
  });
  await assert.rejects(load(source), /fixture build failure/);
  assert.equal((await load(source)).marker, 'recovered');
  assert.equal(attempts, 2);
});

test('CommonJS preparation shares immutable code while VM mocks and state stay isolated', async () => {
  let builds = 0;
  const prepare = createTypeScriptBuilder({
    format: 'cjs', plugins: [{ name: 'cjs-fixture', setup(api) {
      api.onStart(() => { builds++; });
      api.onLoad({ filter: /agent-permissions\.ts$/ }, () => ({
        contents: 'export const state = { marker: globalThis.marker, count: 0 };'
      }));
    } }]
  });
  const [left, right] = await Promise.all([prepare(source), prepare(source)]);
  assert.equal(left, right);
  assert.equal(builds, 1);
  const evaluate = marker => {
    const module = { exports: {} };
    runInNewContext(left, { module, exports: module.exports, marker });
    return module.exports.state;
  };
  const first = evaluate('left'), second = evaluate('right');
  first.count++;
  assert.equal(first.marker, 'left');
  assert.equal(second.marker, 'right');
  assert.equal(second.count, 0);
});
