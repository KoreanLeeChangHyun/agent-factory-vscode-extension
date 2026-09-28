import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
const result = await build({ entryPoints: ['src/modules/chat/bot-prompts.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: new URL('../..', import.meta.url).pathname });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { BOT_DEFAULT_PROMPTS, resolveBotPrompt } = module.exports;
test('empty and whitespace settings use the corresponding character default', () => {
  for (const character of ['factory', 'lumi']) {
    for (const empty of ['', ' \n\t']) assert.equal(resolveBotPrompt(character, empty), BOT_DEFAULT_PROMPTS[character]);
  }
  assert.notEqual(resolveBotPrompt('factory', ''), resolveBotPrompt('lumi', ''));
});
test('user prompt is preserved exactly for either character', () => {
  const custom = '  이름: 나의 봇\n사용자가 지정한 말투\n';
  for (const character of ['factory', 'lumi']) assert.equal(resolveBotPrompt(character, custom), custom);
});
