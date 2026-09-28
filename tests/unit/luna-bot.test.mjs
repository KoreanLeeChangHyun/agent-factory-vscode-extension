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

test('reply parsing preserves complete plain text and rejects missing replies', () => {
  const { parseBotReply } = module.exports;
  const reply = '<script>literal</script>\n' + '긴 답변 '.repeat(10000);
  assert.equal(parseBotReply(JSON.stringify({ reply })), reply);
  for (const value of ['null', '{}', '{"reply":3}', '{"reply":" "}']) assert.throws(() => parseBotReply(value));
});

test('talk sends only the supplied draft, keeps mood independent and rejects concurrent requests', async () => {
  let finish, seen, signal;
  const bot = new LunaBot(async () => 'calm', (text, abort) => {
    seen = text; signal = abort; return new Promise(resolve => { finish = resolve; });
  });
  const request = bot.talk('안녕하세요');
  await assert.rejects(bot.talk('duplicate'));
  await bot.react('idle', () => {});
  assert.equal(signal.aborted, false);
  assert.equal(seen, '안녕하세요');
  finish('반갑습니다'); assert.equal(await request, '반갑습니다');
  const next = bot.talk('다시'); finish('네'); assert.equal(await next, '네');
});

test('talk failure permits retry and disposal aborts pending conversation', async () => {
  let calls = 0;
  const retry = new LunaBot(undefined, async () => { if (!calls++) throw Error('offline'); return 'ok'; });
  await assert.rejects(retry.talk('draft'));
  assert.equal(await retry.talk('draft'), 'ok');
  let finish, signal;
  const bot = new LunaBot(undefined, (_text, abort) => {
    signal = abort; return new Promise(resolve => { finish = resolve; });
  });
  const pending = bot.talk('draft'); bot.dispose();
  assert.equal(signal.aborted, true);
  finish('late'); await assert.rejects(pending);
});

test('Luna reply process uses stdin, isolated temporary files and no retained session', async () => {
  const native = createRequire(import.meta.url);
  const { EventEmitter } = native('node:events');
  const fs = native('node:fs');
  let invocation, input, folder;
  const isolated = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module: isolated, exports: isolated.exports,
    AbortController, Date, process,
    require: name => name !== 'node:child_process' ? native(name) : {
      ...native(name),
      spawn(command, args, options) {
        invocation = { command, args, options }; folder = options.cwd;
        const child = new EventEmitter(); child.stdin = new EventEmitter();
        child.stdin.end = text => {
          input = text;
          fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ reply: '안녕하세요!', emotion: 'happy' }));
          queueMicrotask(() => child.emit('close', 0));
        };
        return child;
      }
    }
  });
  const draft = 'Hello `$(touch nope)`\n원문';
  assert.equal(await isolated.exports.requestLunaReply(draft, new AbortController().signal), '안녕하세요!');
  assert.equal(invocation.command, 'codex');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(invocation.args.includes(flag));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.args.includes(draft), false);
  assert.ok(input.endsWith(JSON.stringify(draft)));
  assert.equal(invocation.options.stdio[1], 'ignore');
  assert.equal(fs.existsSync(folder), false, 'Request files are removed on completion');
  assert.ok(input.startsWith(isolated.exports.DEFAULT_BOT_PROMPT));
  await isolated.exports.requestLunaReply(draft, new AbortController().signal, '나만의 봇\n친절하게 답하세요.');
  assert.ok(input.startsWith('나만의 봇\n친절하게 답하세요.\n\n'));
  assert.ok(input.endsWith(JSON.stringify(draft)));
  assert.equal(fs.existsSync(folder), false);
  await isolated.exports.requestLunaReply(draft, new AbortController().signal, ' \n ');
  assert.ok(input.startsWith(isolated.exports.DEFAULT_BOT_PROMPT));
  await isolated.exports.requestLunaReply(draft, new AbortController().signal, '', 'gpt-6-sol');
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'gpt-6-sol');
  assert.equal(invocation.args.includes('model_reasoning_effort="none"'), false);
  await assert.rejects(isolated.exports.requestLunaReply(draft, new AbortController().signal, '', '--bad'));
  const turn = await isolated.exports.requestLunaTurn(draft, new AbortController().signal, '', '', [{ role: 'user', content: 'Remember Ada' }]);
  assert.equal(turn.emotion, 'happy');
  assert.ok(input.includes('Remember Ada'));
  assert.ok(input.includes('reply and emotion'));

});

test('cancelled talk releases its slot without a late answer clearing the newer request', async () => {
  const pending = [];
  const bot = new LunaBot(undefined, (_text, signal) => new Promise(resolve => pending.push({ signal, resolve })));
  const old = bot.talk('old'); bot.cancelTalk();
  const current = bot.talk('current');
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve('old'); await assert.rejects(old);
  await assert.rejects(bot.talk('duplicate'));
  pending[1].resolve('current'); assert.equal(await current, 'current');
});

test('each conversation receives its selected prompt without changing active requests', async () => {
  const calls = [];
  const bot = new LunaBot(undefined, (text, signal, prompt) => new Promise(resolve => calls.push({ text, signal, prompt, resolve })));
  const first = bot.talk('hello', '첫 프롬프트\n원문');
  assert.equal(calls[0].prompt, '첫 프롬프트\n원문');
  calls[0].resolve('reply'); await first;
  const second = bot.talk('next', '새 프롬프트');
  assert.equal(calls[1].prompt, '새 프롬프트');
  calls[1].resolve('reply'); await second;
});

test('selected model is forwarded to the conversation', async () => {
  let received;
  const bot = new LunaBot(undefined, async (_text, _signal, _prompt, model) => { received = model; return 'ok'; });
  await bot.talk('hello', '', 'claude-haiku-4-5-20251001');
  assert.equal(received, 'claude-haiku-4-5-20251001');
});

 test('conversation turns preserve history and validate model emotion', async () => {
  const { parseBotTurn } = module.exports;
  assert.equal(parseBotTurn('{"reply":"Hello","emotion":"shy"}').emotion, 'shy');
  for (const emotion of [undefined, 'invalid', '<script>']) {
    assert.throws(() => parseBotTurn(JSON.stringify({ reply: 'Hello', emotion })));
  }
  const history = [{ role: 'user', content: 'My name is Ada' }, { role: 'assistant', content: 'Hello Ada' }];
  let received;
  const bot = new LunaBot(undefined, async (_text, _signal, _prompt, _model, turns) => {
    received = turns;
    return { reply: 'Ada', emotion: 'happy' };
  });
  assert.equal(await bot.talk('What is my name?', '', '', history), 'Ada');
  assert.equal(received, history);
  assert.equal(bot.lastEmotion, 'happy');
});

test('streamed text is suppressed after cancellation and is not treated as a final reply', async () => {
  let publish, finish;
  const seen = [];
  const bot = new LunaBot(undefined, (_text, _signal, _prompt, _model, _history, partial) => {
    publish = partial; return new Promise(resolve => { finish = resolve; });
  });
  const pending = bot.talk('hello', '', '', [], text => seen.push(text));
  publish('first'); bot.cancelTalk(); publish('late');
  finish({ reply: 'final', emotion: 'happy' });
  await assert.rejects(pending);
  assert.deepEqual(seen, ['first']);
});
