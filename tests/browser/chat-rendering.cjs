const { checkTaskFlow } = require('./task-flow.cjs');
const { checkLocalization, checkGalleryLocalization } = require('./localization.cjs');
const { checkGeneralSettings } = require('./general-settings.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { checkStatusCustomizationLayout, checkStatusAvailability } = require('./status-customization.cjs');
const { checkAutoScroll } = require('./auto-scroll.cjs');
const { checkFactoryBot } = require('./factory-bot.cjs');
const { checkImageComposer } = require('./image-composer.cjs');
const { checkFactoryRendering } = require('./factory-rendering.cjs');
const { checkAgentModels, checkReasoningSlider } = require('./agent-models.cjs');
const { checkAstraStars } = require('./astra-stars.cjs');
const { checkOneShotComposer } = require('./one-shot-composer.cjs');
const { checkMessageSubmission, checkMessageLayout } = require('./message-submission.cjs');

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
  { type: 'activity', id: 'short', category: 'command', phase: 'completed', text: 'echo ready', output: 'ready' },
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
    if (url.pathname === '/' || url.pathname === '/gallery') {
      let html = fs.readFileSync(path.join(root, url.pathname === '/gallery' ? 'templates/loading-animation-gallery.html' : 'templates/chat.html'), 'utf8');
      for (const [key, value] of Object.entries({
        hostLanguage: ["ko", "en", "fr"].includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : "en", cspSource: "'self'", nonce: 'browser-regression', styleUri: url.pathname === '/gallery' ? '/static/css/loading-animation-gallery.css' : '/static/css/chat.css',
        localizationScriptUri: '/static/js/localization.js', scriptUri: url.pathname === '/gallery' ? '/static/js/loading-animation-gallery.js' : '/static/js/chat.js', markdownScriptUri: '/static/vendor/markdown-it.min.js',
        syntaxScriptUri: '/static/vendor/syntax-highlighter.js', ansiScriptUri: '/static/js/ansi-renderer.js', executionReferencesScriptUri: '/static/js/execution-references.js', iconUri: '/static/images/agent-factory.svg'
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
      response.setHeader('Content-Type', target.endsWith('.css') ? 'text/css' : target.endsWith('.svg') ? 'image/svg+xml' : target.endsWith('.png') ? 'image/png' : 'text/javascript');
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
    const pageErrors = [];
    page.on('pageerror', error => { errors.push(error.message); pageErrors.push(error.message); console.error('Browser page error:', error.message); });
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(events => {
      window.saved = JSON.parse(sessionStorage.getItem("submission-restoration-fixture") || "null") || { timeline: events };
      window.sentMessages = [];
      window.acquireVsCodeApi = () => ({ getState: () => window.saved, setState: value => {
        window.saved = value;
        if (window.measurePersistence) {
          window.persistenceBytes = JSON.stringify(value).length;
          window.persistenceCalls = (window.persistenceCalls || 0) + 1;
        }
      }, postMessage(message) { window.sentMessages.push(message); } });
    }, fixture);
    await page.goto('http://127.0.0.1:' + server.address().port);
    // A startup exception (e.g. a TDZ access) stops chat.js entirely; fail here instead of timing out in a later check.
    assert.deepEqual(pageErrors, [], 'chat.js threw during startup');
    if (process.argv.includes('--companion-only') || process.argv.includes('--companion-care-only')) {
      await require('./companion.cjs').checkCompanion(page, { careOnly: process.argv.includes('--companion-care-only') });
      assert.deepEqual(errors, []);
      console.log('Companion browser checks passed');
      return;
    }
    if (process.argv.includes('--contracts-only')) {
      await require('./contracts.cjs').checkContracts(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--worktree-only')) {
      await require('./worktrees.cjs').checkWorktrees(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--image-conversion-only')) {
      await require('./image-conversion.cjs').checkImageConversion(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--notes-only')) {
      await require('./notes.cjs').checkNotes(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--conversation-history-only')) {
      await require('./conversation-history.cjs').checkConversationHistory(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--rich-markdown-only')) {
      await require('./rich-markdown.cjs').checkRichMarkdown(page);
      await require('./rich-markdown.cjs').checkSafeMarkup(page);
      await require('./rich-markdown.cjs').checkManagedEnvelope(page);
      // Mermaid measures labels in the document, where the CSP refuses its inline styles; the rendered image is unaffected.
      assert.deepEqual(errors.filter(error => !error.startsWith('Refused to apply inline style')), []);
      console.log('Rich Markdown browser checks passed');
      return;
    }
    if (process.argv.includes('--composer-rendering-only')) {
      await require('./composer-rendering.cjs').checkComposerRendering(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--question-navigation-only')) {
      await require('./question-navigation.cjs').checkQuestionNavigation(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--history-index-only')) {
      await require('./history-index.cjs').checkHistoryIndex(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--rendering-throughput-only')) {
      await require('./rendering-throughput.cjs').checkRenderingThroughput(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--rendering-performance-only')) {
      await require('./rendering-performance.cjs').checkRenderingPerformance(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--local-file-picker-only')) {
      await require('./local-file-picker.cjs').checkLocalFilePicker(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--long-history-only')) {
      await require('./long-history.cjs').checkLongHistory(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--input-performance-only')) {
      await require('./input-performance.cjs').checkInputPerformance(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--resource-only')) {
      await page.evaluate(() => {
        for (let i = 0; i < 120; i++) window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'Resource message ' + i }, '*');
      });
      await page.waitForFunction(() => document.querySelectorAll('.message-assistant').length >= 120);
      await page.evaluate(() => {
        window.resourceInspections = 0;
        const original = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = function (selector) {
          if (this.classList.contains('message') && selector.includes('.bash-command-toggle')) window.resourceInspections++;
          return original.call(this, selector);
        };
        window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'Resource final marker' }, '*');
      });
      await page.waitForFunction(() => document.querySelector('.message-assistant:last-child')?.textContent.includes('Resource final marker'));
      assert.equal(await page.evaluate(() => window.resourceInspections), 0, 'Unchanged message controls must not be rescanned');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(await page.locator('html').getAttribute('data-af-hidden'), 'true');
      assert.equal(await page.locator('.message-assistant').first().evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(await page.locator('html').getAttribute('data-af-hidden'), 'false');
      assert.deepEqual(errors, []);
      await page.evaluate(() => {
        for (let i = 0; i < 500; i++) window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'Paged resource ' + i }, '*');
      });
      await page.waitForFunction(() => document.querySelector('.message-assistant:last-child')?.textContent.includes('Paged resource 499'));
      assert.equal(await page.locator('#timeline .message').count(), 200, 'Long history has a bounded DOM');
      await page.locator('.history-pages button').first().click();
      assert.equal(await page.locator('#timeline .message').count(), 200);
      assert.equal(await page.locator('#timeline').textContent().then(text => text.includes('Paged resource 499')), false);
      await page.locator('.history-pages button').last().click();
      assert.equal(await page.locator('.message-assistant:last-child').textContent().then(text => text.includes('Paged resource 499')), true);
      if (process.env.AF_RESOURCE_REPORT) {
        const session = await page.context().newCDPSession(page);
        await session.send('Performance.enable');
        const before = await session.send('Performance.getMetrics');
        await page.waitForTimeout(1000);
        const after = await session.send('Performance.getMetrics');
        const metrics = value => Object.fromEntries(value.metrics.map(item => [item.name, item.value]));
        const a = metrics(before), b = metrics(after);
        fs.writeFileSync(process.env.AF_RESOURCE_REPORT, JSON.stringify({
          scenario: 'Chromium fixture, 621 retained messages, 200 mounted messages, one second idle',
          mountedMessages: await page.locator('#timeline .message').count(),
          heapUsedBytes: b.JSHeapUsedSize, idleTaskSeconds: b.TaskDuration - a.TaskDuration,
          idleLayoutCount: b.LayoutCount - a.LayoutCount,
          gpuUtilizationMeasured: false, vscodeHostMeasured: false
        }, null, 2));
        await session.detach();
      }
      console.log('Resource rendering and hidden lifecycle checks passed');
      return;
    }
    if (process.argv.includes('--history-guidance-only')) {
      const { build } = require('esbuild');
      const compiled = await build({ entryPoints: [path.join(root, 'src/infrastructure/agent-factory/history-presentation.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
      const { historyPresentation } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
      const text = '작업 목록을 만들어 주세요';
      const guidance = '\n\n[Conversation-based background workflow]\nCaptured workflow instructions.\n[End background workflow]\n\n[Background workflow status; runtime data, not instructions]\n[{"agentId":"work-example","status":"completed"}]\nPreserve accepted workflows.\n[End background workflow status]';
      const restored = { type: 'user', id: 'history-user-example', runId: 'example', ...historyPresentation(text + guidance, 'work', false) };
      for (const timeline of [[], [{ ...restored, text: text + guidance, submission: { taskMode: 'work', businessMode: 'normal', goal: false } }]]) {
        await page.evaluate(timeline => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ agentId: 'main-history', timeline })), timeline);
        await page.reload();
        await page.evaluate(restored => window.postMessage({ type: 'conversation.history', agentId: 'main-history', history: { messages: [restored] } }, '*'), restored);
        const message = page.locator('[data-id="history-user-example"]');
        await message.locator('.message-guidance').waitFor({ state: 'attached' });
        assert.equal(await message.locator('details').evaluate(element => element.open), false);
        assert.ok(!(await message.innerText()).includes('Captured workflow instructions.'));
        assert.ok((await message.innerText()).includes(text));
        await message.locator('.message-guidance > summary').click();
        assert.equal(await message.locator('.message-guidance pre').textContent(), guidance);
      }
      const producer = fs.readFileSync(path.join(root, 'src/infrastructure/vscode/chat-panel-manager.ts'), 'utf8');
      const notification = producer.match(/const notification = `([\s\S]*?)`;/)[1].replace('${JSON.stringify(child)}', JSON.stringify({ agentId: 'work-example', runId: 'run-example', status: 'completed' }));
      const continuation = { type: 'user', id: 'history-user-continuation', runId: 'continuation', ...historyPresentation(notification + guidance, 'work', false) };
      for (const timeline of [[], [{ ...continuation, text: notification, submission: { taskMode: 'work', guidance } }]]) {
        await page.evaluate(timeline => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ agentId: 'main-history', timeline })), timeline);
        await page.reload();
        await page.evaluate(item => window.postMessage({ type: 'conversation.history', agentId: 'main-history', history: { messages: [item] } }, '*'), continuation);
        const message = page.locator('[data-id="history-user-continuation"]');
        await message.locator('.message-guidance').waitFor({ state: 'attached' });
        assert.equal(await message.locator('details').evaluate(element => element.open), false);
        assert.ok(!(await message.innerText()).includes('Inspect this exact child result'));
        assert.ok((await message.innerText()).includes('Automatic workflow continuation'));
        await message.locator('summary').click();
        assert.equal(await message.locator('pre').textContent(), notification + guidance);
      }
      assert.deepEqual(errors, []);
      console.log('Fresh and cached history hide captured workflow/status instructions until expanded.');
      return;
    }
    if (process.argv.includes('--message-layout-only')) {
      await checkMessageLayout(page);
      assert.deepEqual(errors, []);
      console.log('Long messages retain their height across narrow viewports and guidance toggles.');
      return;
    }
    if (process.argv.includes('--markdown-image-only')) {
      const href = '/workspace/preview.png';
      await page.evaluate(href => window.postMessage({ type: 'run.event', event: { type: 'assistant', id: 'local-image', phase: 'final', text: `![Preview](${href})` } }, '*'), href);
      // Replay through persisted timeline to exercise normal transcript restoration.
      await page.evaluate(href => { sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline: [{ type: 'assistant', id: 'local-image', phase: 'final', text: `![Preview](${href})` }] })); }, href);
      await page.reload();
      await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'image.resolve'));
      const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=';
      await page.evaluate(({ href, src }) => window.postMessage({ type: 'image.resolved', href, src }, '*'), { href, src });
      await page.waitForFunction(() => document.querySelector('img[data-local-image]')?.naturalWidth === 1);
      assert.equal(await page.locator('img[data-local-image]').getAttribute('src'), src);
      console.log('Local Markdown image host resolution and browser rendering passed.');
      return;
    }
    if (process.argv.includes('--status-availability-only')) {
      await checkStatusAvailability(page);
      await checkStatusCustomizationLayout(page);
      assert.deepEqual(errors, []);
      console.log('Status availability, saved preferences and settings layout passed.');
      return;
    }
    if (process.argv.includes('--status-layout-only')) {
      await checkStatusCustomizationLayout(page);
      assert.deepEqual(errors, []);
      console.log('Status settings and responsive usage layout passed.');
      return;
    }
    if (process.argv.includes('--cancellation-notice-only')) {
      await require('./cancellation-notice.cjs').checkCancellationNotice(page);
      assert.deepEqual(errors, []);
      console.log('Cancellation notice warning color and failure distinction passed.');
      return;
    }
    if (process.argv.includes('--factory-bot-only')) {
      await checkFactoryBot(page);
      assert.deepEqual(errors, []);
      console.log('Factory Bot states, completion, failure, reduced motion and layout checks passed.');
      return;
    }
    if (process.argv.includes('--bot-talk-only')) {
      await require('./bot-talk.cjs').checkBotTalk(page);
      assert.deepEqual(errors, []);
      console.log('Bot talk routing, draft preservation, reply safety and responsive bubble passed.');
      return;
    }
    if (process.argv.includes('--bot-prompt-only')) {
      await require('./bot-talk.cjs').checkBotPrompt(page);
      assert.deepEqual(errors, []);
      console.log('Bot prompt editing, save failure, reset and settings synchronization passed.');
      return;
    }
    if (process.argv.includes('--document-attachments-only')) {
      const attachments = [
        { id: 'doc', kind: 'file', name: 'communication.md', uri: 'vscode-remote://ssh-remote+host/home/docs/communication.md' },
        { id: 'folder', kind: 'folder', name: 'references', uri: 'file:///tmp/references' }
      ];
      await page.evaluate(attachments => window.postMessage({ type: 'attachments.add', attachments }, '*'), attachments);
      await page.waitForFunction(() => document.querySelectorAll('#attachment-list .attachment-chip').length === 2);
      assert.match(await page.locator('#attachment-list').innerText(), /communication\.md/);
      await page.evaluate(attachments => window.postMessage({ type: 'chat.started', id: 'doc-message', text: 'Attached document', attachments }, '*'), attachments);
      await page.waitForFunction(() => document.querySelectorAll('.history-reference').length === 2);
      assert.deepEqual(await page.locator('.history-reference').allTextContents(), ['communication.md', 'references']);
      assert.equal(await page.locator('.history-reference').first().getAttribute('title'), attachments[0].uri);
      assert.equal(await page.locator('.history-reference button').count(), 0);
      console.log('Document composer and sent-message attachment checks passed.');
      return;
    }
    if (process.argv.includes('--message-submission-only')) {
      await checkMessageSubmission(page);
      assert.deepEqual(errors, []);
      console.log('Submission metadata and guidance rendering checks passed.');
      return;
    }
    if (process.argv.includes('--question-copy-only')) {
      const text = '  질문 원문\n두 번째 줄 <tag> & **내용**  ';
      await page.evaluate(text => window.postMessage({ type: 'chat.started', id: 'copy-question', text, attachments: [], submission: { taskMode: 'work', businessMode: 'normal', goal: false, guidance: 'INTERNAL GUIDANCE' } }, '*'), text);
      const button = page.locator('.message-user[data-id="copy-question"] .message-copy');
      await button.click();
      assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text });
      await page.setViewportSize({ width: 320, height: 600 });
      assert.equal(await button.isVisible(), true);
      await button.focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text });
      assert.deepEqual(errors, []);
      await page.locator('#question-button').click();
      const artifact = path.join(root, 'out/question-menu'); fs.mkdirSync(artifact, { recursive: true });
      for (const width of [795, 494, 320]) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const anchor = await page.locator('#question-button').boundingBox();
        const menu = await page.locator('#question-menu').boundingBox();
        const left = Math.max(8, Math.min(anchor.x + anchor.width - menu.width, width - menu.width - 8));
        assert.ok(Math.abs(menu.x - left) < 2);
        assert.ok(Math.abs(anchor.y - menu.y - menu.height - 8) < 2);
        assert.ok(menu.x >= 8 && menu.x + menu.width <= width - 8 && menu.y >= 0);
        for (const row of await page.locator('.question-row').all()) {
          const item = await row.locator('.question-item').boundingBox();
          const copy = await row.locator('.question-copy').boundingBox();
          assert.ok(Math.abs(item.y + item.height / 2 - copy.y - copy.height / 2) < 1);
          assert.ok(copy.x - item.x - item.width >= 7);
        }
        await page.screenshot({ path: path.join(artifact, `aligned-${width}.png`) });
      }
      await page.locator('.question-row').filter({ has: page.locator('[data-question-id="copy-question"]') }).locator('.question-copy').click();
      assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'message.copy', text });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#question-menu').isVisible(), false);
      assert.equal(await page.locator('#question-button').evaluate(el => el === document.activeElement), true);
      assert.deepEqual(errors, []);
      console.log('Question copy checks passed');
      return;
    }
    if (process.argv.includes('--task-flow-only')) {
      await checkTaskFlow(page);
      console.log('Task flow rendering checks passed');
      return;
    }
    if (process.argv.includes('--document-submissions-only')) {
      await require('./one-shot-composer.cjs').checkDocumentSubmissions(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--one-shot-composer-only')) {
      await checkOneShotComposer(page);
      assert.deepEqual(errors, []);
      console.log('One-shot Goal and workflow composer checks passed.');
      return;
    }
    if (process.argv.includes('--astra-stars-only')) {
      await checkAstraStars(page);
      assert.deepEqual(errors, []);
      console.log('Astra starfield: animation, typing, responsive layout and reduced motion passed.');
      return;
    }
    if (process.argv.includes('--work-units-only')) {
      await require('./work-units.cjs').checkWorkUnits(page);
      assert.deepEqual(errors, []); console.log('Work Unit browser checks passed'); return;
    }
    if (process.argv.includes('--interview-choices-only')) {
      await require('./interview-choices.cjs').checkInterviewChoices(page);
      assert.deepEqual(errors, []);
      console.log('Interview choices: designation, keyboard submission, draft preservation and duplicate prevention passed.');
      return;
    }
    if (process.argv.includes('--localization-only')) {
      await checkLocalization(page);
      await checkGalleryLocalization(page);
      assert.deepEqual(errors, []);
      console.log('Localization, restoration and source preservation checks passed.');
      return;
    }
    if (process.argv.includes('--agent-presets-only')) {
      await require('./agent-presets.cjs').checkAgentPresets(page);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--general-settings-only')) {
      await checkGeneralSettings(page);
      assert.deepEqual(errors, []);
      console.log('General settings permissions, language switching/restoration, source preservation and layout passed.');
      return;
    }
    if (process.argv.includes('--shortcuts-only')) {
      await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'shortcuts', role: 'main', runtimeAvailable: true, capabilities: { submit: { model: true }, send: { model: true } } }, '*'));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.locator('#status-settings-button').click();
      await page.locator('#settings-tab-keyboard').click();
      const record = async (action, keys) => {
        await page.locator('[data-shortcut-action="' + action + '"] .shortcut-change').click();
        assert.equal(await page.locator('[data-shortcut-action="' + action + '"]').getAttribute('data-recording'), 'listening');
        await page.keyboard.press(keys);
      };
      await record('send', 'Control+Enter');
      assert.equal(await page.locator('#shortcut-send').getAttribute('data-binding'), 'Mod+Enter');
      assert.equal(await page.evaluate(() => document.activeElement.className), 'shortcut-confirm', 'Recorded keys wait for confirmation');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#shortcut-send').getAttribute('data-binding'), 'Mod+Enter');
      assert.equal(await page.locator('[data-shortcut-action="send"]').getAttribute('data-recording'), null);
      await record('bot', 'Control+Enter');
      assert.equal(await page.locator('[data-shortcut-action="bot"] .shortcut-confirm').isDisabled(), true);
      assert.match(await page.locator('#shortcuts-status').textContent(), /already|이미/i);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#shortcut-bot').getAttribute('data-binding'), 'Mod+Shift+Enter');
      await record('botFeed', 'KeyF');
      assert.match(await page.locator('#shortcuts-status').textContent(), /Ctrl|Alt/);
      assert.equal(await page.locator('[data-shortcut-action="botFeed"]').getAttribute('data-recording'), 'listening', 'Unmodified letters are rejected');
      await page.keyboard.press('Alt+Shift+F');
      await page.locator('[data-shortcut-action="botFeed"] .shortcut-confirm').click();
      assert.equal(await page.locator('#shortcut-botFeed').getAttribute('data-binding'), 'Alt+Shift+F');
      await record('botMenu', 'Alt+KeyB');
      await page.locator('[data-shortcut-action="botMenu"] .shortcut-cancel').click();
      assert.equal(await page.locator('#shortcut-botMenu').getAttribute('data-binding'), 'Alt+Shift+B');
      const groups = await page.locator('#shortcut-bindings .shortcut-group:not([hidden]) > h3').allTextContents();
      assert.deepEqual(groups.length >= 4, true, JSON.stringify(groups));
      assert.equal(await page.locator('[data-shortcut-group="workflow"] [data-shortcut-action="submitWork"]').count(), 1, 'Menu actions are grouped');
      for (const [action, keys] of [['submitInterview', 'Alt+Shift+I'], ['openConversationHistory', 'Alt+Shift+H']]) {
        await record(action, keys);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#shortcut-' + action).getAttribute('data-binding'), keys);
      }
      await page.keyboard.press('Escape');
      await page.locator('#prompt').fill('shortcut test');
      const count = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').length);
      const before = await count();
      await page.locator('#prompt').press('Enter');
      assert.equal(await count(), before);
      assert.match(await page.locator('#prompt').inputValue(), /\n/);
      await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
      assert.equal(await count(), before);
      await page.locator('#prompt').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true });
      assert.equal(await count(), before);
      await page.locator('#prompt').press('Control+Enter');
      assert.equal(await count(), before + 1);
      await page.locator('#status-settings-button').click();
      await page.locator('#settings-tab-keyboard').click();
      await record('newLine', 'Alt+Enter');
      await page.keyboard.press('Enter');
      await record('close', 'Alt+KeyQ');
      await page.keyboard.press('Enter');
      await record('settingsTabNext', 'Alt+ArrowDown');
      await page.keyboard.press('Enter');
      await record('focusNext', 'Alt+KeyN');
      await page.keyboard.press('Enter');
      const focused = () => page.evaluate(() => (document.activeElement.closest('[data-shortcut-action]')?.dataset.shortcutAction || '') + ':' + document.activeElement.className);
      const beforeTab = await focused();
      await page.keyboard.press('Tab');
      assert.equal(await focused(), beforeTab, 'Replaced Tab no longer moves focus');
      await page.keyboard.press('Alt+KeyN');
      assert.notEqual(await focused(), beforeTab, 'Rebound focus shortcut moves focus');
      assert.equal(await page.locator('#shortcut-close').getAttribute('data-binding'), 'Alt+Q');
      await page.locator('#settings-tab-keyboard').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#settings-tab-keyboard').getAttribute('aria-selected'), 'true', 'Replaced default tab key no longer switches');
      await page.keyboard.press('Alt+ArrowDown');
      assert.equal(await page.locator('#settings-tab-general').getAttribute('aria-selected'), 'true', 'Rebound tab key switches');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#status-settings').isVisible(), true, 'Replaced Esc no longer closes');
      await page.keyboard.press('Alt+KeyQ');
      assert.equal(await page.locator('#status-settings').isVisible(), false, 'Rebound close shortcut closes settings');
      await page.locator('#prompt').fill('a');
      await page.locator('#prompt').press('End');
      await page.locator('#prompt').press('Shift+Enter');
      assert.equal(await page.locator('#prompt').inputValue(), 'a', 'Replaced Shift+Enter no longer inserts a line');
      await page.locator('#prompt').press('Alt+Enter');
      assert.equal(await page.locator('#prompt').inputValue(), 'a\n', 'Rebound new line inserts a line');
      await page.locator('#prompt').fill('interview shortcut');
      await page.locator('#prompt').press('Alt+Shift+I');
      assert.equal(await count(), before + 2, 'Submission shortcuts send through the chosen menu action');
      assert.match(JSON.stringify(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1))), /interview/);
      await page.keyboard.press('Alt+Shift+H');
      assert.equal(await page.locator('#conversation-history').evaluate(el => el.open), true, 'History shortcut opens conversation history');
      assert.match(await page.locator('#submission-menu [data-workflow="interview"]').getAttribute('title'), /Alt/);
      await page.keyboard.press('Alt+KeyQ');
      assert.equal(await page.locator('#conversation-history').evaluate(el => el.open), false, 'Rebound close shortcut collapses the open list first');
      await page.keyboard.press('Alt+KeyQ');
      assert.equal(await page.locator('#submission-menu').isVisible(), false, 'Rebound close shortcut closes menus');
      await page.waitForFunction(() => window.saved.shortcuts?.send === 'Mod+Enter' && window.saved.shortcuts?.botFeed === 'Alt+Shift+F');
      const persisted = await page.evaluate(() => window.saved);
      await page.evaluate(saved => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(saved)), persisted);
      await page.reload();
      assert.equal(await page.locator('#shortcut-send').getAttribute('data-binding'), 'Mod+Enter');
      assert.equal(await page.locator('#shortcut-bot').getAttribute('data-binding'), 'Mod+Shift+Enter');
      assert.equal(await page.locator('#shortcut-botFeed').getAttribute('data-binding'), 'Alt+Shift+F');
      await page.locator('#status-settings-button').click();
      await page.locator('#settings-tab-keyboard').click();
      await page.locator('#shortcuts-reset').click();
      assert.equal(await page.locator('#shortcut-send').getAttribute('data-binding'), 'Enter');
      assert.equal(await page.locator('#shortcut-bot').getAttribute('data-binding'), 'Mod+Shift+Enter');
      assert.equal(await page.locator('#shortcut-botFeed').getAttribute('data-binding'), 'Alt+Shift+1');
      assert.equal(await page.locator('#shortcut-submitWork').getAttribute('data-binding'), 'Alt+Shift+W');
      assert.equal(await page.locator('#shortcut-close').getAttribute('data-binding'), 'Escape');
      assert.equal(await page.locator('#shortcut-newLine').getAttribute('data-binding'), 'Shift+Enter');
      assert.deepEqual(errors, []);
      const controlHeights = await page.evaluate(() => ['status-reset', 'shortcuts-reset', 'bot-prompt-save', 'bot-prompt-reset', 'ui-language', 'bot-character'].map(id => [id, getComputedStyle(document.getElementById(id)).height]));
      assert.ok(controlHeights.every(([, height]) => height === '34px'), JSON.stringify(controlHeights));
      const rowHeights = await page.locator('.settings-shortcuts > div').evaluateAll(rows => rows.filter(row => !row.hidden).map(row => row.getBoundingClientRect().height));
      assert.ok(rowHeights.every(height => Math.abs(height - 54) < 1), JSON.stringify(rowHeights));
      const panelHeights = [];
      for (const name of ['general', 'status', 'bot', 'keyboard']) {
        await page.locator('#settings-tab-' + name).click();
        panelHeights.push((await page.locator('#status-settings').boundingBox()).height);
      }
      assert.ok(panelHeights.every(height => height === panelHeights[0]), JSON.stringify(panelHeights));
      const screenshots = process.env.AF_SHORTCUT_SCREENSHOTS;
      for (const width of [560, 320]) {
        await page.setViewportSize({ width, height: 600 });
        const geometry = await page.locator('#settings-panel-keyboard').evaluate(el => {
          const button = el.querySelector('.shortcut-change'); const style = getComputedStyle(button);
          return { overflow: el.scrollWidth > el.clientWidth + 1, radius: style.borderRadius, background: style.backgroundColor };
        });
        assert.equal(geometry.overflow, false);
        assert.equal(geometry.radius, '6px');
        assert.notEqual(geometry.background, 'rgb(255, 255, 255)');
        if (screenshots) { fs.mkdirSync(screenshots, { recursive: true }); await page.locator('#settings-panel-keyboard').evaluate(el => { el.scrollTop = 0; }); await page.locator('#status-settings').screenshot({ path: path.join(screenshots, 'shortcuts-' + width + '-top.png') }); await page.locator('#settings-panel-keyboard').evaluate(el => { el.scrollTop = el.scrollHeight; }); await page.locator('#status-settings').screenshot({ path: path.join(screenshots, 'shortcuts-' + width + '.png') }); }
      }
      console.log('Shortcut behavior and themed layout at 560px/320px passed.');
      return;
    }
    if (process.argv.includes('--model-lock-only')) {
      const emit = async message => { await page.evaluate(value => window.postMessage(value, '*'), message); await page.evaluate(() => new Promise(requestAnimationFrame)); };
      const caps = { model: true, reasoning: true };
      await emit({ type: 'host.initialize', panelId: 'lock', role: 'main', resetConversation: true, conversationId: 'conversation-lock', runtimeAvailable: true, model: 'gpt-one', capabilities: { submit: caps, send: { ...caps, sessionProvider: 'codex' } } });
      await emit({ type: 'models.list', models: ['gpt-one', 'gpt-two', 'claude-one', 'antigravity/claude-test', 'gemini-test', 'antigravity/gpt-test'] });
      await page.locator('#model-button').click();
      const model = page.locator('#model-menu select[data-role="main"][data-field="model"]');
      const tabs = page.locator('#model-menu .agent-model-row[data-agent-role="main"] .model-vendor-tab');
      assert.equal(await model.isDisabled(), false);
      await emit({ type: 'chat.started', id: 'accepted-lock', text: 'hello', attachments: [] });
      assert.equal(await model.isDisabled(), false);
      await model.selectOption('gpt-two');
      assert.equal(await page.evaluate(() => window.saved.model), 'gpt-two');
      assert.equal(await tabs.nth(0).isDisabled(), false);
      assert.equal(await tabs.nth(1).isDisabled(), true);
      assert.equal(await model.locator('option[value="antigravity/gpt-test"]').evaluate(el => el.disabled), true);
      assert.equal(await page.locator('#model-menu select[data-role="work"][data-field="model"]').isDisabled(), false);
      await emit({ type: 'conversation.cleared', conversationId: 'conversation-new-lock' });
      assert.equal(await tabs.nth(1).isDisabled(), false, 'Reset unlocks providers even before capability refresh');
      await tabs.nth(1).evaluate(el => el.click());
      await model.selectOption('antigravity/claude-test');
      await emit({ type: 'capabilities.updated', capabilities: { submit: caps, send: { ...caps, sessionProvider: 'antigravity' } } });
      await emit({ type: 'chat.started', id: 'accepted-agy', text: 'next', attachments: [] });
      assert.equal(await model.locator('option[value="claude-one"]').evaluate(el => el.disabled), true);
      assert.equal(await tabs.nth(2).isDisabled(), false);
      await tabs.nth(2).evaluate(el => el.click());
      await model.selectOption('gemini-test');
      assert.equal(await page.evaluate(() => window.saved.model), 'gemini-test', 'Different vendors on one provider remain selectable');
      await page.keyboard.press('Escape');
      await page.locator('#prompt').fill('same provider send');
      await page.locator('#prompt').press('Enter');
      await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'chat.send' && m.execution.model === 'gemini-test'));
      assert.deepEqual(errors, []);
      console.log('Same-provider model changes, cross-provider lock, reset and dispatch passed.');
      return;
    }
    if (process.argv.includes('--agent-models-only')) {
      await checkAgentModels(page);
      assert.deepEqual(errors, []);
      console.log('Combined agent model settings checks passed.');
      return;
    }
    if (process.argv.includes('--reasoning-slider-only')) {
      await checkReasoningSlider(page);
      assert.deepEqual(errors, []);
      console.log('Reasoning slider browser checks passed.');
      return;
    }
    if (process.argv.includes('--factory-rendering-only')) {
      await checkFactoryRendering(page);
      assert.deepEqual(errors, []);
      console.log('Factory script and Skill rendering checks passed.');
      return;
    }
    if (process.argv.includes('--compaction-only')) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const [phase, title, text] of [
        ['started', 'Context compaction', 'Compacting context'],
        ['completed', 'Context compaction', 'Context compaction completed'],
        ['started', '컨텍스트 압축', '컨텍스트 압축 중'],
        ['completed', '컨텍스트 압축', '컨텍스트 압축 완료']
      ]) {
        await page.evaluate(({ phase, text, title }) => window.postMessage({
          type: 'run.activity', id: 'compaction-render-check', category: 'tool', phase,
          text, title
        }, '*'), { phase, text, title });
        const card = page.locator('[data-id="compaction-render-check"]');
        await card.waitFor();
        await page.waitForFunction(text => document.querySelector('[data-id="compaction-render-check"]')?.textContent.includes(text), text);
        assert.equal(await card.count(), 1);
        assert.equal(await card.isVisible(), true);
        assert.equal(await card.locator('.message-heading').count(), 0, 'Compaction uses one status row without a duplicate heading');
        assert.equal(await card.locator('[role="status"]').textContent(), (phase === 'completed' ? '✓' : '') + text);
        assert.ok((await card.boundingBox()).height <= 24, 'Compaction occupies a single compact row');
        const indicator = card.locator('.compaction-indicator');
        assert.equal(await indicator.evaluate(el => getComputedStyle(el).animationName), phase === 'started' ? 'compaction-spin' : 'none');
        if (phase === 'started') {
          const before = await indicator.evaluate(el => getComputedStyle(el).transform);
          await page.waitForTimeout(150);
          assert.notEqual(await indicator.evaluate(el => getComputedStyle(el).transform), before, 'The progress indicator rotates');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await indicator.evaluate(el => getComputedStyle(el).animationName), 'none');
          await page.emulateMedia({ reducedMotion: 'no-preference' });
        }
      }
      assert.deepEqual(errors, []);
      console.log('Compact context status, animation, completion and reduced motion checks passed.');
      return;
    }
    if (process.argv.includes('--image-composer-only')) {
      await checkImageComposer(page);
      assert.deepEqual(errors, []);
      console.log('Image composer focus, caret, icons, and attachment lifecycle checks passed.');
      return;
    }
    await page.waitForFunction(() => document.querySelector('code.language-python span') && document.querySelector('.git-diff-source span'));
    const emit = async message => {
      await page.evaluate(value => window.postMessage(value, '*'), message);
      await page.waitForFunction(() => document.querySelector('.bash-command-text .syntax-code span'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await checkStatusCustomizationLayout(page);
    const unknown = page.locator('code.language-unknown');
    assert.equal(await unknown.textContent(), '<raw> preserved\n');
    assert.equal(await unknown.locator('span').count(), 0);
    assert.ok(await page.locator('code.language-python span').count() > 0);
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /'wasm-unsafe-eval'/);

    const command = page.locator('[data-id="long"]');
    const shortCommand = page.locator('[data-id="short"]');
    const file = page.locator('[data-id="diff"]');
    assert.equal(await shortCommand.locator('.terminal-command-card').count(), 0);
    assert.equal(await shortCommand.locator('.terminal-command-content').evaluate(element => getComputedStyle(element).borderTopStyle), 'none');
    const runtimePath = '/home/test/.agent-factory/projects/project-0123456789abcdef0123456789abcdef/agents/main-01234567-89ab-cdef-0123-456789abcdef/runs/run-20260919T101953966118Z-example/path-errors.md';
    const checksumCommand = 'sha256sum ' + runtimePath + ' ' + runtimePath;
    await emit({ type: 'run.activity', id: 'checksum-card', category: 'command', phase: 'completed', text: checksumCommand, output: 'a'.repeat(64) + '  ' + runtimePath });
    const checksumCard = page.locator('[data-id="checksum-card"] .terminal-command-content');
    assert.equal(await checksumCard.locator('.syntax-code').textContent(), checksumCommand);
    assert.equal(await checksumCard.locator('.message-phase').getAttribute('aria-label'), 'Succeeded');
    assert.ok(await checksumCard.evaluate(element => element.scrollWidth <= element.clientWidth));
    await checksumCard.locator('.bash-command-toggle').click();
    assert.equal(await checksumCard.locator('.bash-command-toggle').getAttribute('aria-expanded'), 'true');
    assert.match(await checksumCard.locator('.terminal-output-preview').textContent(), /path-errors\.md/);
    if (process.argv.includes('--terminal-commands-only')) {
      await checkAutoScroll(page);
      assert.deepEqual(errors, []);
      console.log('Terminal command cards, long paths, disclosures, and scroll checks passed.');
      return;
    }
    assert.equal(await shortCommand.locator('.bash-command-toggle').isHidden(), true);
    assert.equal(await command.locator('.bash-command-toggle').isVisible(), true);
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
    await emit({ type: 'run.activity', id: 'skill-reference-card', category: 'command', phase: 'completed', text: 'cat /home/test/.codex/plugins/cache/agent-factory/agent-factory/1.0.0/skills/convention/references/communication.md', output: '# Human communication' });
    const skillCard = page.locator('[data-id="skill-reference-card"] .skill-read-card');
    assert.equal(await skillCard.locator('strong').textContent(), 'agent-factory:convention');
    assert.equal(await skillCard.locator('.skill-read-document span').textContent(), 'references/communication.md');
    assert.equal(await skillCard.locator('details').first().getAttribute('open'), null);
    await skillCard.locator('summary').first().click();
    assert.equal(await skillCard.locator('.syntax-code').first().isVisible(), true);
    await emit({ type: 'run.activity', id: 'skill-reference-card', category: 'command', phase: 'failed', text: 'cat /home/test/.codex/plugins/cache/agent-factory/agent-factory/1.0.0/skills/convention/references/communication.md', output: 'read failed' });
    // The failed update renders on the next frame; wait for it instead of racing the render.
    await page.waitForFunction(() => document.querySelector('[data-id="skill-reference-card"] .skill-read-card summary')?.getAttribute('title') === 'Failed');
    assert.equal(await skillCard.locator('details').first().getAttribute('open'), '');
    const managedSubmit = 'python3 skills/agent/scripts/exec.py submit --agent work-card --role work --message "Update UI"';
    await emit({ type: 'run.activity', id: 'managed-submit', category: 'command', phase: 'completed', text: managedSubmit, output: '{"agentId":"work-card","runId":"run-card"}' });
    const managedCard = page.locator('[data-id="managed-submit"] .managed-agent-card');
    assert.equal(await managedCard.count(), 1);
    assert.equal(await managedCard.locator('.managed-agent-status').textContent(), 'Status unknown');
    assert.equal(await managedCard.locator('.managed-agent-progress').textContent(), 'Request acceptance unconfirmed');
    assert.equal(await managedCard.locator('details').first().getAttribute('open'), null);
    assert.equal(await managedCard.locator('.managed-agent-open').count(), 0);
    await emit({ type: 'agents.list', agents: [{ agentId: 'work-card', role: 'work', status: 'running', runId: 'run-card' }] });
    assert.equal(await managedCard.locator('.managed-agent-status').textContent(), 'Running');
    assert.equal(await managedCard.locator('.managed-agent-progress').textContent(), 'Request accepted');
    await managedCard.locator('.managed-agent-open').click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'work-card' });
    await managedCard.locator('summary').first().click();
    await emit({ type: 'run.activity', id: 'managed-status', category: 'command', phase: 'completed', text: 'for i in {1..15}; do state_json=$(python3 skills/agent/scripts/exec.py status --agent work-card --run-id run-card); done', output: '{"run":{"agentId":"work-card","runId":"run-card","status":"running"}}' });
    assert.equal(await page.locator('.managed-agent-card').count(), 1);
    assert.equal(await managedCard.locator('details').first().getAttribute('open'), '');
    assert.equal(await managedCard.locator('.managed-agent-status').textContent(), 'Running');
    await emit({ type: 'run.activity', id: 'managed-result', category: 'command', phase: 'completed', text: 'python3 skills/agent/scripts/exec.py result --agent work-card --run-id run-card', output: '{"run":{"agentId":"work-card","runId":"run-card","status":"completed"}}' });
    await emit({ type: 'agents.list', agents: [{ agentId: 'work-card', role: 'work', status: 'completed', runId: 'run-card' }] });
    assert.equal(await managedCard.locator('.managed-agent-status').textContent(), 'Completed');
    assert.match(await managedCard.locator('summary').first().textContent(), /3$/);
    await emit({ type: 'agents.list', agents: [{ agentId: 'work-card', role: 'work', status: 'running', runId: 'run-new' }] });
    assert.equal(await managedCard.locator('.managed-agent-status').textContent(), 'Completed');
    await managedCard.locator('summary').first().click();
    await emit({ type: 'run.activity', id: 'managed-verify', category: 'command', phase: 'completed', text: 'python3 skills/agent/scripts/exec.py submit --agent verification-card --role verification --message "Verify UI"', output: '{"agentId":"verification-card","runId":"verify-run"}' });
    await emit({ type: 'agents.list', agents: [{ agentId: 'work-card', role: 'work', status: 'completed', runId: 'run-card' }, { agentId: 'verification-card', role: 'verification', status: 'running', runId: 'verify-run' }] });
    assert.equal(await page.locator('[data-id="managed-verify"] strong').textContent(), 'Verification agent');
    await managedCard.scrollIntoViewIfNeeded();
    fs.mkdirSync(path.join(root, 'out/managed-agents'), { recursive: true });
    const cardBox = await managedCard.boundingBox();
    const verifyBox = await page.locator('[data-id="managed-verify"] .managed-agent-card').boundingBox();
    await page.screenshot({ path: path.join(root, 'out/managed-agents/cards.png'), clip: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: verifyBox.y + verifyBox.height - cardBox.y } });
    await emit({ type: 'run.activity', id: 'managed-pending', category: 'command', phase: 'started', text: managedSubmit });
    assert.equal(await page.locator('[data-id="managed-pending"] .managed-agent-status').textContent(), 'Status unknown');
    if (process.argv.includes('--managed-agents-only')) {
      await checkAutoScroll(page);
    await checkImageComposer(page);
    assert.deepEqual(errors, []);
      console.log('Managed agent cards: browser checks passed');
      return;
    }
    const referencesText = '앞선 설명\n\n실행 식별자:\n- Work Agent: `work-reference`\n- Work Run: run-reference\n- Work Session: session-reference\n- 예약된 Verification Agent: verification-reserved\n- Loop: loop-reference\n\n뒤쪽 설명';
    await emit({ type: 'agents.list', agents: [{ agentId: 'work-reference', role: 'work', status: 'completed' }] });
    await emit({ type: 'chat.assistant', phase: 'final', text: referencesText });
    const references = page.locator('.execution-references').last();
    assert.equal(await references.locator('li').count(), 5);
    assert.equal(await references.locator('button.execution-reference-main').count(), 1);
    await references.locator('button.execution-reference-main').click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'work-reference' });
    await references.getByRole('button', { name: 'Work Run run-reference · Copy', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'reference.copy', id: 'run-reference' });
    assert.equal(await references.locator('.execution-reference-id').first().evaluate(element => getComputedStyle(element).userSelect), 'text');
    const parsedMessage = references.locator('..');
    assert.equal((await parsedMessage.innerText()).includes('실행 식별자:'), false);
    assert.ok((await parsedMessage.innerText()).includes('앞선 설명'));
    assert.ok(await parsedMessage.locator('p').first().evaluate((before, list) => Boolean(before.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING), await references.elementHandle()));
    assert.ok(await parsedMessage.locator('p').last().evaluate((after, list) => Boolean(after.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_PRECEDING), await references.elementHandle()));
    await emit({ type: 'chat.assistant', phase: 'final', text: '[문서](https://example.com/docs) · [파일](/workspace/app.ts:12)' });
    const chatLinks = page.locator('.message-assistant').last().locator('a');
    await chatLinks.first().click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'link.open', href: 'https://example.com/docs' });
    await chatLinks.last().click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'link.open', href: '/workspace/app.ts:12' });
    await emit({ type: 'agents.list', agents: [] });
    assert.equal(await references.locator('button.execution-reference-main').count(), 0);
    await emit({ type: 'chat.assistant', phase: 'final', text: '실행 식별자:\n- Work Agent: ../invalid' });
    assert.equal(await page.locator('.message-assistant').last().locator('.execution-references').count(), 0);
    assert.ok((await page.locator('.message-assistant').last().innerText()).includes('../invalid'));
    await emit({ type: 'chat.assistant', phase: 'commentary', text: referencesText });
    assert.equal(await page.locator('.message-assistant').last().locator('.execution-references').count(), 0);
    await page.setViewportSize({ width: 795, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { document.body.className = 'vscode-dark'; });
    await emit({ type: 'run.state', running: true });
    await emit({ type: 'run.progress', text: '작업 결과를 검증하고 있습니다' });
    await emit({ type: 'agents.list', agents: [
      { agentId: 'work-loop-1', role: 'work', status: 'completed', runId: 'work-run-1' },
      { agentId: 'verification-loop-1', role: 'verification', status: 'running', runId: 'verification-run-1' }
    ], workflows: [{ kind: 'work-verification-loop', loopId: 'loop-status', status: 'active', taskMode: 'work-verification',
      workAgentId: 'work-loop-1', verificationAgentId: 'verification-loop-1', workflow: { id: 'status-flow', title: 'Status fixture', index: 0,
        tasks: [{ id: 'status-task', title: 'Status task', description: 'Bound accepted stages', completionCriteria: 'Open exact child',
          workStatus: 'completed', verificationStatus: 'running', workRunId: 'work-run-1', verificationRunId: 'verification-run-1' }] } }] });
    assert.match(await page.locator('#run-status-agents').textContent(), /Work 0 · Verification 1/);
    if (await page.locator('#run-status-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#run-status-toggle').click();
    assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#run-details').isVisible(), true);
    assert.deepEqual(await page.locator('#run-stage-list [data-flow-id="status-flow"] .task-flow-step').evaluateAll(items => items.map(item => item.dataset.status)), ['completed', 'verifying']);
    await page.locator('#run-stage-list [data-flow-id="status-flow"] .task-flow-open').last().click();
    assert.deepEqual(await page.evaluate(() => window.sentMessages.at(-1)), { type: 'agent.open', agentId: 'verification-loop-1' });
    await page.locator('#run-status-toggle').click();
    assert.equal(await page.locator('#run-details').isHidden(), true);
    const statusStyle = await page.locator('#run-status').evaluate(element => {
      const label = getComputedStyle(element.querySelector('.run-status-label'));
      const meta = getComputedStyle(element.querySelector('.run-status-meta'));
      const copy = getComputedStyle(element.querySelector('.run-status-copy'));
      let background;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const gradientColors = (label.backgroundImage.match(/(?:rgba?|color)\([^)]*\)/g) || []).map(color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
      });
      return {
        gradientColors,
        labelColor: label.color, gradient: label.backgroundImage, labelAnimation: label.animationName,
        metaColor: meta.color, metaFill: meta.webkitTextFillColor, metaAnimation: meta.animationName,
        copyColor: copy.color, copyAnimation: copy.animationName,
        background
      };
    });
    assert.equal(statusStyle.labelColor, 'rgb(212, 212, 212)');
    assert.equal(statusStyle.background, 'rgb(30, 30, 30)');
    assert.equal(statusStyle.labelAnimation, 'run-status-text-scan');
    assert.equal(statusStyle.metaAnimation, 'none');
    assert.equal(statusStyle.copyAnimation, 'none');
    assert.equal(statusStyle.metaColor, statusStyle.labelColor);
    assert.equal(statusStyle.metaFill, statusStyle.metaColor);
    const luminance = color => {
      const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        value /= 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const contrast = color => {
      const foreground = luminance(color), background = luminance(statusStyle.background);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    };
    const gradientColors = statusStyle.gradientColors;
    assert.equal(gradientColors.length, 3);
    assert.equal(gradientColors[0], statusStyle.labelColor);
    assert.equal(gradientColors[2], statusStyle.labelColor);
    const middle = gradientColors[1].match(/\d+/g).map(Number);
    assert.equal(middle[0], middle[1]);
    assert.equal(middle[1], middle[2]);
    assert.ok(luminance(gradientColors[1]) < luminance(statusStyle.labelColor));
    assert.ok(gradientColors.every(color => contrast(color) >= 4.5));
    assert.ok(contrast(statusStyle.metaColor) >= 4.5);
    const artifactDir = process.env.AF_RENDERING_ARTIFACT_DIR || path.join(root, 'out/cli-comparison');
    fs.mkdirSync(artifactDir, { recursive: true });
    const positions = [];
    for (const time of [0, 600, 1200, 1800]) {
      const position = await page.locator('.run-status-label').evaluate((element, time) => {
        const animation = element.getAnimations()[0];
        animation.pause();
        animation.currentTime = time;
        return getComputedStyle(element).backgroundPosition;
      }, time);
      positions.push(position);
    }
    assert.equal(new Set(positions).size, 4);
    await page.locator('.run-status-label').evaluate(element => { element.getAnimations()[0].currentTime = 1200; });
    await page.locator('.composer-region').screenshot({ path: path.join(artifactDir, 'run-status-dark-scan.png'), animations: 'allow' });
    const scanFrames = [];
    for (const viewportWidth of [795, 320]) {
      await page.setViewportSize({ width: viewportWidth, height: 900 });
      for (const [sample, label] of [['short', '검증중'], ['long', '작업 결과를 검증하고 있습니다. 실행 결과와 변경 내용을 확인하고 있습니다']]) {
        await emit({ type: 'run.progress', text: label });
        // The first element screenshot can change layout (scrolling or scrollbar toggling) and resize the
        // label; take a discarded capture so the resting baseline and later frames share one width.
        await page.locator('.run-status-label').screenshot({ animations: 'allow' });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const snapshots = new Map();
        const visibleFrames = [];
        let scanWidth;
        for (const time of [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2399, 2400]) {
          const computed = await page.locator('.run-status-label').evaluate((element, time) => {
            const animation = element.getAnimations()[0];
            animation.pause();
            animation.currentTime = time;
            const style = getComputedStyle(element);
            return { width: element.clientWidth, backgroundSize: style.backgroundSize, repeat: style.backgroundRepeat, delay: style.animationDelay, position: style.backgroundPosition };
          }, time);
          assert.equal(computed.repeat, 'no-repeat');
          assert.equal(computed.backgroundSize, '230% 100%');
          assert.equal(computed.delay, '0s');
          if (time === 0) scanWidth = computed.width;
          assert.equal(computed.width, scanWidth, 'Scan frames must share one settled layout width');
          const screenshot = await page.locator('.run-status-label').screenshot({ path: path.join(artifactDir, 'scan-' + viewportWidth + '-' + sample + '-' + time + '.png'), animations: 'allow' });
          snapshots.set(time, screenshot);
          const pixels = await page.evaluate(async ({ base64, baseline }) => {
            const load = async value => {
              const image = new Image();
              image.src = 'data:image/png;base64,' + value;
              await image.decode();
              return image;
            };
            const image = await load(base64);
            const resting = await load(baseline);
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(resting, 0, 0);
            const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0);
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const xs = [];
            let maxDelta = 0;
            for (let index = 0; index < data.length; index += 4) {
              const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(data[index + channel] - before[index + channel])));
              maxDelta = Math.max(maxDelta, delta);
              if (delta > 8) xs.push(index / 4 % canvas.width);
            }
            return { count: xs.length, maxDelta, center: xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null };
          }, { base64: screenshot.toString('base64'), baseline: snapshots.get(0).toString('base64') });
          const frame = { viewportWidth, sample, time, ...computed, ...pixels };
          scanFrames.push(frame);
          if (pixels.count) visibleFrames.push(frame);
          if ([0, 2399, 2400].includes(time)) {
            // The frame 1 ms before the boundary can round a channel by one level.
            assert.ok(pixels.maxDelta <= (time === 2399 ? 1 : 0), 'Loop boundaries must preserve resting text pixels');
          }
        }
        assert.ok(visibleFrames.length >= 3);
        for (let index = 1; index < visibleFrames.length; index++) {
          assert.ok(visibleFrames[index].center > visibleFrames[index - 1].center, 'Highlight must move right without wrapping back');
        }
      }
    }
    fs.writeFileSync(path.join(artifactDir, 'run-status-scan-frames.json'), JSON.stringify(scanFrames, null, 2));
    await page.setViewportSize({ width: 795, height: 900 });
    await emit({ type: 'run.progress', text: '작업 결과를 검증하고 있습니다' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedStyle = await page.locator('.run-status-label').evaluate(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, color: style.color, fill: style.webkitTextFillColor, background: style.backgroundImage };
    });
    assert.deepEqual(reducedStyle, { animation: 'none', color: statusStyle.labelColor, fill: statusStyle.labelColor, background: 'none' });
    await page.locator('.composer-region').screenshot({ path: path.join(artifactDir, 'run-status-dark-reduced-motion.png') });
    fs.writeFileSync(path.join(artifactDir, 'run-status-visibility.json'), JSON.stringify({ statusStyle, positions, reducedStyle, minimumGradientContrast: Math.min(...gradientColors.map(contrast)), metaContrast: contrast(statusStyle.metaColor) }, null, 2));
    await emit({ type: 'agents.list', agents: [], workflows: [{ kind: 'work-verification-loop', loopId: 'loop-status', status: 'completed', taskMode: 'work-verification',
      workAgentId: 'work-loop-1', verificationAgentId: 'verification-loop-1', workflow: { id: 'status-flow', title: 'Status fixture', index: 0,
        tasks: [{ id: 'status-task', title: 'Status task', description: 'Bound accepted stages', completionCriteria: 'Open exact child',
          workStatus: 'completed', verificationStatus: 'completed', workRunId: 'work-run-1', verificationRunId: 'verification-run-1' }] } }] });
    await emit({ type: 'run.state', running: false });
    assert.equal(await page.locator('#run-status').isHidden(), true);
    assert.equal(await page.locator('#run-status-toggle').getAttribute('aria-expanded'), 'false');
    await checkAutoScroll(page);
    await checkImageComposer(page);
    assert.deepEqual(errors, []);
    console.log('Strict CSP, aliases, ANSI, themes/contrast, streaming fences, fallback, live disclosures/focus, and multi-file diff rendering passed.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
