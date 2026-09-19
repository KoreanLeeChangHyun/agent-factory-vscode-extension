import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const result = await build({ entryPoints: ['src/infrastructure/codex/luna-bot.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: new URL('../..', import.meta.url).pathname });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), AbortController, Date, process });
const { LunaBot, parseBotMood } = module.exports;

test('only known expressions are accepted', () => {
  assert.equal(parseBotMood('{"mood":"focused"}'), 'focused');
  for (const value of ['null', '{}', '{"mood":"<script>"}', 'hello']) assert.throws(() => parseBotMood(value));
});
test('stale inference is discarded and completed reactions are cached', async () => {
  const pending = [];
  const bot = new LunaBot((context, signal) => new Promise(resolve => pending.push({ context, signal, resolve })));
  const seen = [];
  const first = bot.react('working', mood => seen.push(mood));
  const second = bot.react('completed', mood => seen.push(mood));
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve('focused'); await first;
  pending[1].resolve('cheerful'); await second;
  assert.deepEqual(seen, [undefined, undefined, 'cheerful']);
  await bot.react('completed', mood => seen.push(mood));
  assert.equal(pending.length, 2);
  assert.equal(seen.at(-1), 'cheerful');
});
test('failures back off and disposal aborts and suppresses late responses', async () => {
  let calls = 0;
  const bot = new LunaBot(async () => { calls++; throw Error('unavailable'); });
  await bot.react('working', () => {});
  await bot.react('idle', () => {});
  assert.equal(calls, 1);
  let finish, signal;
  const second = new LunaBot((_context, abortSignal) => { signal = abortSignal; return new Promise(resolve => { finish = resolve; }); });
  const seen = [];
  const request = second.react('working', mood => seen.push(mood));
  second.dispose(); finish('focused'); await request;
  assert.equal(signal.aborted, true);
  assert.deepEqual(seen, [undefined]);
});
