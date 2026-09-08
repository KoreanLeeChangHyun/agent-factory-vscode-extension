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
        syntaxScriptUri: '/static/vendor/syntax-highlighter.js', iconUri: '/static/images/agent-factory.svg'
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
    assert.deepEqual(errors, []);
    console.log('Strict CSP, code fences, live disclosures/focus, and multiline diff rendering passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
