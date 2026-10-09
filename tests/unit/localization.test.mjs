import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const i18n = require('../../static/js/localization.js');
const root = new URL('../../', import.meta.url);

test('all UI messages provide English/Korean with identical parameter contracts', () => {
  for (const [key, message] of Object.entries(i18n.messages)) {
    assert.ok(message.en && message.ko, key);
    const parameters = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(parameters(message.ko), parameters(message.en), key);
  }
  assert.equal(i18n.locale('auto', 'ko-KR'), 'ko');
  assert.equal(i18n.locale('auto', 'KO'), 'ko');
  assert.equal(i18n.locale('auto', 'ja'), 'en');
  assert.equal(i18n.locale('en', 'ko'), 'en');
  assert.equal(i18n.locale('ko', 'en'), 'ko');
  assert.equal(i18n.format('missing.key', 'ko'), 'missing.key');
});

test('dynamic labels preserve filenames, commands, IDs and parameter-like source text', () => {
  const source = 'Default /tmp/Work <script> {1} gpt-6-astra';
  assert.equal(i18n.format('attachment.open', 'ko', source), source + ' · 원본 열기');
  assert.equal(i18n.format('attachment.open', 'en', source), source + ' · Open original');
  assert.equal(i18n.format('status.runningAgents', 'ko', 2, 1), '작업 2 · 검증 1 진행 중');
  assert.equal(i18n.format('queue.items', 'ko', 3), '대기 메시지 3개');
  assert.equal(i18n.format('toolbar.questions', 'ko', 4), '사용자 질문 (4)');
  const rendered = i18n.format('submission.send', 'en', source);
  const descriptor = i18n.describe(rendered);
  assert.equal(i18n.resolve(descriptor, 'ko', rendered), '작성한 메시지 전송: ' + source);
  assert.equal(i18n.resolve(undefined, 'ko', 'Runtime online'), 'Runtime online');
  assert.equal(i18n.resolve({ key: 'attachment.open', values: [{}] }, 'ko', source), source);
});

test('VS Code command, configuration and public view resources are packaged', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root)));
  const en = JSON.parse(await readFile(new URL('package.nls.json', root)));
  const ko = JSON.parse(await readFile(new URL('package.nls.ko.json', root)));
  const texts = [pkg.description, ...pkg.contributes.commands.map(command => command.title),
    ...Object.values(pkg.contributes.configuration.properties).flatMap(setting => [setting.description, ...(setting.enumDescriptions || [])]),
    ...Object.values(pkg.contributes.views).flatMap(views => views.map(view => view.name))];
  for (const text of texts) {
    assert.match(text, /^%[^%]+%$/);
    const key = text.slice(1, -1);
    assert.ok(en[key] && ko[key], key);
  }
  assert.match(await readFile(new URL('.vscodeignore', root), 'utf8'), /!package\.nls\*\.json/);
  for (const template of ['chat', 'loading-animation-gallery', 'control-center']) {
    const html = await readFile(new URL(`templates/${template}.html`, root), 'utf8');
    assert.match(html, /nonce="\{\{nonce\}\}" src="\{\{localizationScriptUri\}\}"/);
    for (const key of [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(match => match[1])) {
      assert.ok(i18n.messages[key], key);
    }
  }
});

test('host localization follows host locale with English fallback and keeps diagnostic arguments', async () => {
  const output = await build({ entryPoints: [new URL('src/common/localization.ts', root).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
  const host = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  host.setHostLanguage('ko-KR');
  assert.equal(host.localize('ui.retry'), '다시 시도');
  const raw = 'ENOENT /tmp/Default.exe';
  const result = host.localize('ui.unable.to.check.the.active.run.0', raw);
  assert.equal(result, '진행 중인 실행을 확인할 수 없습니다: ' + raw);
  assert.deepEqual(host.describeLocalizedMessage(result), { key: 'ui.unable.to.check.the.active.run.0', values: [raw] });
  assert.equal(host.describeLocalizedMessage(raw), undefined);
  host.setHostLanguage('fr');
  assert.equal(host.localize('ui.retry'), 'Retry');
});
