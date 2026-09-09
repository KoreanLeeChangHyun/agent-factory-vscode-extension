const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const longCommand = Array.from({ length: 8 }, (_, index) => 'echo ' + index).join('\n');
const diff = [
  'diff --git a/example.py b/example.py', '--- a/example.py', '+++ b/example.py',
  '@@ -1,2 +1,2 @@', '-value = """old', '-old continuation"""',
  '+value = """new', '+new continuation"""',
  '@@ -20 +30 @@', '-print("before")', '+print("after")'
].join('\n');
const fixture = [
  { type: 'user', id: 'user', text: 'Render CLI transcript' },
  { type: 'assistant', id: 'fences', phase: 'final', text: '```python\nprint("hello")\n```\n\n```unknown\n<raw> preserved\n```' },
  { type: 'activity', id: 'long', category: 'command', phase: 'started', text: longCommand, output: 'one\ntwo\nthree\nfour' },
  { type: 'activity', id: 'diff', category: 'file', phase: 'completed', text: 'example.py', diff }
];
const secondDiff = [
  'diff --git a/app.ts b/app.ts', '--- a/app.ts', '+++ b/app.ts',
  '@@ -1 +1 @@', '-const count: number = 1;', '+const count: number = 2;'
].join('\n');
const ansiOutput = '\x1b[31mred\x1b[0m plain \x1b[94mbright\x1b[0m \x1b[38;5;196mindexed\x1b[0m \x1b[38;2;12;34;56mtruecolor\x1b[0m <raw>';
fixture.push(
  { type: 'assistant', id: 'aliases', phase: 'final', text: '```py\nprint("python alias")\n```\n```ts\nconst value: number = 42;\n```\n```shell\necho "$HOME"\n```' },
  { type: 'assistant', id: 'inferred', phase: 'final', text: '```\n#!/usr/bin/env python3\nprint("inferred")\n```\n```\nplain <raw> text\n```' },
  { type: 'activity', id: 'ansi', category: 'command', phase: 'completed', text: 'printf colors', output: ansiOutput },
  { type: 'activity', id: 'multi-diff', category: 'file', phase: 'completed', text: 'Two files', diff: diff + '\n' + secondDiff }
);
const theme = ':root{--vscode-font-family:monospace;--vscode-font-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-foreground:#d4d4d4;--vscode-foreground:#d4d4d4;--vscode-descriptionForeground:#999;--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-panel-border:#454545;--vscode-input-background:#313131}';

async function main() {
  let browser;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      let html = fs.readFileSync(path.join(root, 'templates/chat.html'), 'utf8');
      for (const [key, value] of Object.entries({
        cspSource: "'self'", nonce: 'browser-regression', styleUri: '/static/css/chat.css',
        scriptUri: '/static/js/chat.js', markdownScriptUri: '/static/vendor/markdown-it.min.js',
        syntaxScriptUri: '/static/vendor/syntax-highlighter.js', ansiScriptUri: '/static/js/ansi-renderer.js', iconUri: '/static/images/agent-factory.svg'
      })) html = html.replaceAll('{{' + key + '}}', value);
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>'));
    } else if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
    } else if (url.pathname === '/theme.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(theme);
    } else if (url.pathname.startsWith('/static/')) {
      const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(path.join(root, 'static') + path.sep) || !fs.existsSync(target)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      response.end(fs.readFileSync(target));
    } else response.writeHead(404).end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
    });
    const page = await browser.newPage({ viewport: { width: 795, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(events => {
      window.saved = { timeline: events };
      window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => { window.saved = value; }, postMessage() {} });
    }, fixture);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('code.language-python span') && document.querySelector('.git-diff-source span'));
    const emit = async message => {
      await page.evaluate(value => window.postMessage(value, '*'), message);
      await page.waitForFunction(() => document.querySelector('.bash-command-text .syntax-code span'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const unknown = page.locator('code.language-unknown');
    assert.equal(await unknown.textContent(), '<raw> preserved\n');
    assert.equal(await unknown.locator('span').count(), 0);
    assert.ok(await page.locator('code.language-python span').count() > 0);
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /'wasm-unsafe-eval'/);

    const command = page.locator('[data-id="long"]');
    const file = page.locator('[data-id="diff"]');
    await command.locator('.bash-command-toggle').click();
    await command.locator('summary').click();
    await file.locator('summary').click();
    await command.locator('.bash-command-toggle').focus();
    const checkDisclosures = async () => {
      assert.equal(await command.locator('.bash-command-toggle').getAttribute('aria-expanded'), 'true');
      assert.equal(await command.locator('.bash-command-toggle').isVisible(), true);
      assert.equal(await command.locator('details').evaluate(element => element.open), true);
      assert.equal(await file.locator('details').evaluate(element => element.open), true);
      assert.equal(await command.locator('.bash-command-toggle').evaluate(element => document.activeElement === element), true);
    };
    await emit({ type: 'run.activity', id: 'long', category: 'command', phase: 'completed', text: longCommand, output: 'one\ntwo\nthree\nfour\nfive' });
    await checkDisclosures();
    await emit({ type: 'chat.assistant', phase: 'commentary', text: 'Unrelated progress' });
    await checkDisclosures();
    await page.evaluate(() => { document.body.className = 'vscode-light'; });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.syntax-code span')).some(element => element.style.color === 'rgb(30, 102, 245)'));
    await checkDisclosures();
    await command.locator('summary').focus();
    await emit({ type: 'chat.assistant', phase: 'commentary', text: 'More progress' });
    assert.equal(await command.locator('summary').evaluate(element => document.activeElement === element), true);
    await page.evaluate(() => { document.body.className = 'vscode-dark'; });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.syntax-code span')).some(element => element.style.color === 'rgb(137, 180, 250)'));
    assert.equal(await command.locator('summary').evaluate(element => document.activeElement === element), true);
    assert.equal(await command.locator('details').evaluate(element => element.open), true);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.git-diff-source')).filter(element => element.textContent.includes('continuation')).every(element => Array.from(element.querySelectorAll('span')).some(token => token.textContent.includes('continuation') && token.style.color === 'rgb(166, 227, 161)')));
    const continuations = await file.locator('.git-diff-source').evaluateAll(elements => elements.filter(element => element.textContent.includes('continuation')).map(element => Array.from(element.querySelectorAll('span')).map(token => ({ text: token.textContent, color: token.style.color }))));
    assert.equal(continuations.length, 2);
    for (const tokens of continuations) assert.ok(tokens.some(token => token.text.includes('continuation') && token.color === 'rgb(166, 227, 161)'));
    assert.deepEqual(await file.locator('.git-diff-line-number').allTextContents(), ['1', '2', '1', '2', '20', '30']);
    assert.equal(await file.locator('details code').textContent(), diff.replaceAll('\n', ''));

    // Fence aliases and shebang inference must reach the displayed DOM.
    for (const language of ['py', 'ts', 'shell']) {
      await page.waitForFunction(label => document.querySelector('code.language-' + label + ' span'), language);
    }
    const inferred = page.locator('[data-id="inferred"] pre > code');
    assert.equal(await inferred.count(), 2);
    assert.ok(await inferred.nth(0).locator('span').count() > 0);
    assert.equal(await inferred.nth(1).locator('span').count(), 0);
    assert.equal(await inferred.nth(1).textContent(), 'plain <raw> text\n');

    const ansi = page.locator('[data-id="ansi"] .terminal-command-output').last();
    assert.equal(await ansi.textContent(), 'red plain bright indexed truecolor <raw>');
    const runs = await ansi.locator('span').evaluateAll(elements => elements.map(element => ({ text: element.textContent, color: getComputedStyle(element).color })));
    assert.deepEqual(runs, [
      { text: 'red', color: 'rgb(205, 49, 49)' },
      { text: 'bright', color: 'rgb(59, 142, 234)' },
      { text: 'indexed', color: 'rgb(255, 0, 0)' },
      { text: 'truecolor', color: 'rgb(12, 34, 56)' }
    ]);
    assert.equal(await ansi.locator('raw').count(), 0);
    assert.equal(await ansi.evaluate(element => Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('')), ' plain    <raw>');

    const multi = page.locator('[data-id="multi-diff"]');
    await multi.locator('summary').click();
    assert.equal(await multi.locator('details code').textContent(), (diff + secondDiff).replaceAll('\n', ''));
    assert.deepEqual(await multi.locator('.git-diff-line-number').allTextContents(), ['1', '2', '1', '2', '20', '30', '1', '1']);
    assert.ok(await multi.locator('.git-diff-source span').count() > 8);

    const tokenColors = () => page.locator('code.language-ts span').evaluateAll(elements => elements.map(element => element.style.color).join('|'));
    const darkColors = await tokenColors();
    for (const themeClass of ['vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-light', 'vscode-dark']) {
      const before = await tokenColors();
      await page.evaluate(value => { document.body.className = value; }, themeClass);
      await page.waitForFunction(previous => Array.from(document.querySelectorAll('code.language-ts span')).map(element => element.style.color).join('|') !== previous, before);
      assert.equal(await page.locator('code.language-ts').textContent(), 'const value: number = 42;\n');
    }
    assert.equal(await tokenColors(), darkColors);

    await emit({ type: 'syntax.theme', selection: { name: 'dracula' } });
    await page.waitForFunction(previous => Array.from(document.querySelectorAll('code.language-ts span')).map(element => element.style.color).join('|') !== previous, darkColors);
    const draculaColors = await tokenColors();
    const customSelection = { name: 'browser-custom', theme: { name: 'browser-custom', settings: [
      { settings: { foreground: '#123456', background: '#101010' } },
      { scope: 'keyword, storage', settings: { foreground: '#abcdef', fontStyle: 'italic' } }
    ] } };
    await emit({ type: 'syntax.theme', selection: customSelection });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('code.language-ts span')).some(element => element.style.color === 'rgb(18, 52, 86)'));
    assert.notEqual(await tokenColors(), draculaColors);
    assert.ok(await page.locator('code.language-ts span').evaluateAll(elements => elements.some(element => element.style.color === 'rgb(171, 205, 239)' && element.style.fontStyle === 'italic')));
    await emit({ type: 'syntax.theme', selection: { name: 'nonexistent-browser-theme' } });
    await page.waitForFunction(previous => Array.from(document.querySelectorAll('code.language-ts span')).map(element => element.style.color).join('|') === previous, darkColors);
    assert.ok(await page.locator('[data-id="syntax-theme-warning"]').count());

    // Incomplete fences arrive as transcript snapshots; retain their partial source.
    await emit({ type: 'chat.assistant', phase: 'commentary', text: '```python\nprint("partial' });
    const partial = page.locator('code.language-python').last();
    // EOF has no trailing LF; markdown-it preserves the incomplete source exactly.
    assert.equal(await partial.textContent(), 'print("partial');
    await emit({ type: 'chat.assistant', phase: 'final', text: '```python\nprint("partial complete")\n```' });
    assert.equal(await page.locator('code.language-python').last().textContent(), 'print("partial complete")\n');

    const longCode = 'const oversized = "' + 'x'.repeat(512_000) + '";';
    await emit({ type: 'chat.assistant', phase: 'final', text: '```typescript\n' + longCode + '\n```' });
    const oversized = page.locator('code.language-typescript').last();
    assert.equal(await oversized.textContent(), longCode + '\n');
    assert.equal(await oversized.locator('span').count(), 0);

    // A failed highlighter must not erase or HTML-interpret source text.
    await page.evaluate(() => {
      window.originalHighlight = window.agentFactorySyntaxHighlighter.highlight;
      window.agentFactorySyntaxHighlighter.highlight = async () => { throw new Error('intentional highlighter failure'); };
    });
    await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', text: '```rust\nlet raw = "<unsafe>";\n```' }, '*'));
    await page.waitForFunction(() => document.querySelector('code.language-rust'));
    assert.equal(await page.locator('code.language-rust').textContent(), 'let raw = "<unsafe>";\n');
    assert.equal(await page.locator('code.language-rust span, code.language-rust unsafe').count(), 0);
    await page.evaluate(() => { window.agentFactorySyntaxHighlighter.highlight = window.originalHighlight; });
    await emit({ type: 'run.activity', id: 'long', category: 'command', phase: 'completed', text: longCommand, output: Array.from({ length: 100 }, (_, index) => 'Output line ' + index).join('\n') });
    const fullOutput = command.locator('details .terminal-command-output');
    assert.equal(await command.locator('details').evaluate(element => element.open), true);
    const outputGeometry = await fullOutput.evaluate(element => ({
      height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY
    }));
    assert.ok(outputGeometry.height >= outputGeometry.scrollHeight - 1);
    assert.equal(outputGeometry.overflowY, 'visible');
    assert.equal(await page.locator('.timeline').evaluate(element => element.scrollHeight > element.clientHeight), true);
    const jsonOutput = JSON.stringify({ value: 'x'.repeat(3000) });
    await emit({ type: 'run.activity', id: 'single-line-output', category: 'command', phase: 'completed', text: 'read json', output: jsonOutput });
    const jsonResult = page.locator('[data-id="single-line-output"]');
    await page.waitForFunction(() => !document.querySelector('[data-id="single-line-output"] details').hidden);
    const previewGeometry = await jsonResult.locator('.terminal-output-preview').evaluate(element => ({
      height: element.clientHeight, lineHeight: parseFloat(getComputedStyle(element).lineHeight), overflowY: getComputedStyle(element).overflowY
    }));
    assert.ok(previewGeometry.height <= previewGeometry.lineHeight * 3 + 1);
    assert.equal(previewGeometry.overflowY, 'hidden');
    await jsonResult.locator('summary').click();
    assert.equal(await jsonResult.locator('details .terminal-command-output').textContent(), jsonOutput);
    assert.equal(await jsonResult.locator('details .terminal-command-output').evaluate(element => getComputedStyle(element).overflowY), 'visible');
    await page.setViewportSize({ width: 1200, height: 900 });
    await emit({ type: 'run.activity', id: 'resizing-output', category: 'command', phase: 'completed', text: 'read json', output: JSON.stringify({ value: 'x'.repeat(180) }) });
    await page.waitForFunction(() => document.querySelector('[data-id="resizing-output"] details').hidden);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForFunction(() => !document.querySelector('[data-id="resizing-output"] details').hidden);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(() => document.querySelector('[data-id="resizing-output"] details').hidden);
    assert.deepEqual(errors, []);
    console.log('Strict CSP, aliases, ANSI, themes/contrast, streaming fences, fallback, live disclosures/focus, and multi-file diff rendering passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
