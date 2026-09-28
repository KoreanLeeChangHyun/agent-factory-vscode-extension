import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
const native = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ['src/infrastructure/codex/bot-stream.ts'], absWorkingDir: new URL('../..', import.meta.url).pathname, bundle: true, write: false, platform: 'node', format: 'cjs' });
function load(spawn) {
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, process,
    require: name => name === 'node:child_process' ? { spawn } : native(name) });
  return module.exports;
}
test('partial reply handles split escapes and never displays JSON metadata', () => {
  const { partialBotReply } = load();
  assert.equal(partialBotReply('{"emotion":"happy","reply":"Hello\\nworld\\uD83D'), 'Hello\nworld');
  assert.equal(partialBotReply('{"reply":"Hi\\uD83D\\uDE00","emotion":"happy"}'), 'Hi😀');
  assert.equal(partialBotReply('{"reply":"quote\\"yes\\'), 'quote"yes');
  assert.equal(partialBotReply('{"emotion":"happy"'), '');
});
for (const provider of ['codex', 'claude']) test(provider + ' forwards partial reply before validated completion', async () => {
  let child, invocation, completing = false;
  const partials = [];
  const { streamBotTurn } = load((command, args, options) => {
    invocation = { command, args, options };
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 0));
    const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
    const complete = () => {
      if (provider === 'codex') {
        emit({ method: 'item/agentMessage/delta', params: { delta: '{"reply":"안녕' } });
        emit({ method: 'item/agentMessage/delta', params: { delta: '하세요","emotion":"happy"}' } });
        completing = true;
        emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      } else {
        emit({ type: 'stream_event', event: { type: 'content_block_start' } });
        for (const partial_json of ['{"reply":"안녕', '하세요","emotion":"happy"}']) emit({ type: 'stream_event', event: { delta: { type: 'input_json_delta', partial_json } } });
        completing = true;
        emit({ type: 'result', structured_output: { reply: '안녕하세요', emotion: 'happy' } });
      }
    };
    child.stdin.on('data', buffer => {
      if (provider === 'claude') return queueMicrotask(complete);
      const message = JSON.parse(buffer.toString());
      if (message.id === 1) queueMicrotask(() => emit({ id: 1, result: {} }));
      if (message.id === 2) queueMicrotask(() => emit({ id: 2, result: { thread: { id: 'test' } } }));
      if (message.id === 3) queueMicrotask(complete);
    });
    return child;
  });
  const answer = await streamBotTurn(provider, 'Hello', {}, 'model', '/tmp', new AbortController().signal, text => {
    assert.equal(completing, false, 'Text arrives while generation is in progress'); partials.push(text);
  });
  assert.deepEqual(partials, ['안녕', '안녕하세요']);
  assert.equal(JSON.parse(answer).emotion, 'happy');
  assert.equal(invocation.options.stdio[1], 'pipe');
});
test('premature process exit rejects instead of saving a partial reply', async () => {
  const { streamBotTurn } = load(() => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', 1)); return child;
  });
  await assert.rejects(streamBotTurn('codex', '', {}, '', '/tmp', new AbortController().signal, () => {}), /before completion/);
});
