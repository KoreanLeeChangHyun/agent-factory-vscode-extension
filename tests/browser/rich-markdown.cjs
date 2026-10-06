const assert = require('node:assert/strict');

// Math renders as MathML and diagrams as data: SVG images, both inside the strict webview CSP.
async function checkRichMarkdown(page) {
  const text = [
    'Inline $E = mc^2$ and \\(a^2\\), price $5 and $HOME stay text, code `$x$` stays code.',
    '',
    '$$',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '=',
    '\\begin{pmatrix} x \\\\ y \\end{pmatrix}',
    '$$',
    '',
    '```mermaid', 'flowchart LR', '  A[요청] --> B{유효?}', '  B -- 예 --> C((완료))', '```',
    '',
    '```mermaid', 'not a diagram ][', '```'
  ].join('\n');
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chat.assistant', id: 'rich-markdown', phase: 'final', text } })), text);
  const body = page.locator('.message-assistant .markdown-body').last();
  await page.waitForFunction(() => document.querySelectorAll('.mermaid-diagram img').length === 1 && document.querySelector('code.language-mermaid[data-mermaid="failed"]'), null, { timeout: 20000 });
  assert.equal(await body.locator('.math-inline math').count(), 2, 'Inline TeX renders as MathML');
  assert.equal(await body.locator('.math-block math mtable').count(), 2, 'Block matrices keep their rows after Markdown escapes');
  assert.equal(await body.locator('h1, h2').count(), 0, 'A line of "=" inside display math is not a setext heading');
  const paragraph = await body.locator('p').first().textContent();
  assert.match(paragraph, /price \$5 and \$HOME stay text/);
  assert.equal(await body.locator('p code').first().textContent(), '$x$');
  const image = body.locator('.mermaid-diagram img');
  assert.match(await image.getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  await page.waitForFunction(() => document.querySelector('.mermaid-diagram img').naturalWidth > 0);
  assert.equal(await body.locator('pre code.language-mermaid').count(), 1, 'Invalid diagrams keep their source');
}

// Attribute-free formatting tags render; anything else stays escaped text. Table alignment survives the CSP as classes.
async function checkSafeMarkup(page) {
  const text = 'A <u>u</u> <mark>m</mark> H<sub>2</sub>O x<sup>2</sup> <kbd>C</kbd>, <script>x</script> <u onclick="x">a</u> <img src=x>\n\n| L | C | R |\n|:--|:-:|--:|\n| a | b | c |';
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'chat.assistant', id: 'safe-markup', phase: 'final', text } })), text);
  const body = page.locator('.message-assistant .markdown-body').last();
  await body.locator('table').waitFor();
  for (const tag of ['u', 'mark', 'sub', 'sup', 'kbd']) assert.equal(await body.locator('p ' + tag).count(), 1, tag + ' renders');
  assert.equal(await body.locator('script, img, [onclick]').count(), 0);
  assert.match(await body.locator('p').first().textContent(), /<script>x<\/script> <u onclick="x">a<\/u> <img src=x>/);
  assert.deepEqual(await body.locator('td').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).textAlign)), ['left', 'center', 'right']);
  assert.equal(await body.locator('[style]').count(), 0);
}

async function checkManagedEnvelope(page) {
  const envelope = JSON.stringify({ decisionKind: null, resultPath: '/runtime/result.md',
    resultText: '**Readable answer**', status: 'completed' });
  await page.evaluate(envelope => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'chat.assistant', phase: 'commentary', text: envelope }
  })), envelope);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.message-assistant .markdown-body')).at(-1)?.textContent.includes('Readable answer'));
  const body = page.locator('.message-assistant .markdown-body').last();
  assert.equal((await body.textContent()).trim(), 'Readable answer');
  assert.equal(await body.locator('strong').textContent(), 'Readable answer');
  assert.ok(!(await body.textContent()).includes('resultPath'));

  await page.evaluate(envelope => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'chat.assistant', phase: 'commentary', text: '- ' + envelope }
  })), envelope);
  const listWrappedBody = page.locator('.message-assistant .markdown-body').last();
  await listWrappedBody.locator('strong').waitFor();
  assert.equal((await listWrappedBody.textContent()).trim(), 'Readable answer');
  assert.equal(await listWrappedBody.locator('li').count(), 0, 'Managed envelope list marker is not rendered');

  await page.evaluate(envelope => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'chat.delta', runId: 'managed-envelope-preview', stream: 'commentary', id: 'preview', text: '- ' + envelope }
  })), envelope);
  const streamedBody = page.locator('.message-assistant .markdown-body').last();
  await streamedBody.locator('strong').waitFor();
  assert.equal((await streamedBody.textContent()).trim(), 'Readable answer');
  assert.ok(!(await streamedBody.textContent()).includes('resultPath'));

  const ordinary = '{"answer":"visible JSON"}';
  await page.evaluate(ordinary => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'chat.assistant', phase: 'final', text: ordinary }
  })), ordinary);
  await page.waitForFunction(ordinary => Array.from(document.querySelectorAll('.message-assistant .markdown-body')).at(-1)?.textContent.includes(ordinary), ordinary);
  assert.equal((await page.locator('.message-assistant .markdown-body').last().textContent()).trim(), ordinary);
}

// Exercise real delta ingestion, completion replacement, cached reload and runtime history.
async function checkStreamingParity(page) {
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const runId = 'stream-parity';
  const prefix = '[early]: https://example.test/earlier\n\nRead [documentation][ref].\n\n![Local image](/workspace/parity.png)\n\n````js\n```\n\nstill code\n````\n\n';
  const suffix = '**Question [1/1]:** Choose\n\n| Option | Decision |\n|---|---|\n| 1 | A |\n| 2 | B |\n\n실행 식별자:\n- Work Agent: `work-parity`\n- Work Run: `run-parity`\n\nAfter [earlier][early].\n\n[ref]: https://example.test/docs\n';
  const flow = { id: 'flow-parity', title: 'Parity tasks', tasks: [{ id: 'task-parity', title: 'Preserved task', status: 'completed' }] };
  const text = prefix + suffix + '\n```task-flow\n' + JSON.stringify(flow) + '\n```';
  const imageSource = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=';
  const resolveImage = async () => {
    await emit({ type: 'image.resolved', href: '/workspace/parity.png', src: imageSource });
    await page.waitForFunction(() => document.querySelector('#timeline .message-assistant:last-child img[data-local-image]')?.naturalWidth === 1);
  };
  await emit({ type: 'host.initialize', panelId: 'parity', agentId: 'main-parity', role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'chat.delta', runId, stream: 'final', id: 'parity', text: prefix });
  await page.waitForFunction(() => document.querySelector('#timeline .message-assistant:last-child code.language-js'));
  await resolveImage();
  const resolutions = await page.evaluate(() => window.sentMessages.filter(item => item.type === 'image.resolve').length);
  await page.evaluate(() => { window.parityStableCode = document.querySelector('#timeline .message-assistant:last-child code.language-js'); });
  await emit({ type: 'chat.delta', runId, stream: 'final', id: 'parity', text: text.slice(prefix.length) });
  const body = () => page.locator('#timeline .message-assistant .message-content').last();
  await body().locator('a[href="https://example.test/docs"]').waitFor();
  await body().locator('a[href="https://example.test/earlier"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#timeline .message-assistant:last-child code.language-js')?.dataset.highlighted === 'true');
  assert.equal(await body().locator('pre > code').evaluate(code => code === window.parityStableCode), true, 'Unchanged code keeps its DOM while later link definitions update earlier prose');
  assert.equal(await body().locator('pre > code').textContent(), '```\n\nstill code\n');
  assert.equal(await body().locator('.execution-reference').count(), 2);
  assert.equal(await body().locator('.interview-choice').count(), 2);
  assert.equal(await body().locator('.interview-choice:enabled').count(), 0, 'An unfinished answer cannot submit a choice');
  const snapshot = () => body().evaluate(element => {
    const clone = element.cloneNode(true);
    // Streaming choices are disabled until the authoritative answer completes.
    clone.querySelectorAll('button').forEach(button => button.removeAttribute('disabled'));
    return clone.innerHTML;
  });
  assert.equal(await body().locator('.task-flow[data-flow-id="flow-parity"]').count(), 1);
  assert.equal(await page.evaluate(() => window.sentMessages.filter(item => item.type === 'image.resolve').length), resolutions, 'Unchanged local images do not resolve again on every delta');
  const live = await snapshot();
  await emit({ type: 'chat.assistant', runId, phase: 'final', text });
  await page.waitForFunction(() => window.saved.timeline.some(item => item.runId === 'stream-parity' && !item.streaming));
  assert.equal(await page.locator('#timeline .message-assistant').filter({ hasText: 'documentation' }).count(), 1);
  await resolveImage();
  assert.equal(await snapshot(), live, 'Completion keeps the same Markdown and controls');
  await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify(window.saved)));
  await page.reload();
  await body().locator('a[href="https://example.test/docs"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#timeline .message-assistant:last-child code.language-js')?.dataset.highlighted === 'true');
  await resolveImage();
  assert.equal(await snapshot(), live, 'Cached reload keeps the final content and format');
  await page.evaluate(() => {
    sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ timeline: [] }));
  });
  await page.reload();
  await emit({ type: 'host.initialize', panelId: 'parity', agentId: 'main-parity', role: 'main', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'conversation.history', agentId: 'main-parity', history: { messages: [{ type: 'assistant', id: 'history-parity', runId, phase: 'final', text }] } });
  await body().locator('a[href="https://example.test/docs"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#timeline .message-assistant:last-child code.language-js')?.dataset.highlighted === 'true');
  await resolveImage();
  assert.equal(await snapshot(), live, 'Runtime history uses the same content renderer');
  await emit({ type: 'run.status', running: false });
  await emit({ type: 'chat.assistant', runId: 'parity-choices', phase: 'final', text: '**Question [1/1]:** Choose\n\n| Option | Decision |\n|---|---|\n| 1 | A |\n| 2 | B |' });
  await body().locator('.interview-choice:enabled').first().waitFor();
  await body().locator('.interview-choice').nth(1).click();
  assert.equal(await page.evaluate(() => window.sentMessages.filter(item => item.type === 'chat.send').at(-1)?.text), '2');
}

module.exports = { checkRichMarkdown, checkSafeMarkup, checkManagedEnvelope, checkStreamingParity };
