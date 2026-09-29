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

module.exports = { checkRichMarkdown, checkSafeMarkup };
