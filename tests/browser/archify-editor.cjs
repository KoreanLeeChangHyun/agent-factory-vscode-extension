const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const { fixture, waitFor } = await import('../support/archify-editor-fixture.mjs');
  const { importTypeScript } = await import('../support/import-typescript.mjs');
  const { ArchifyClient } = await importTypeScript('src/infrastructure/agent-factory/archify-client.ts');
  const root = path.resolve('.');
  const client = new ArchifyClient(async () => ({ script: path.resolve('../plugin/scripts/archify.py'), python: 'python3', environment: process.env }));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-editor-browser-'));
  const evidence = path.resolve('../docs/artifact/evidence/archify-editor');
  await fs.mkdir(evidence, { recursive: true });
  let browser, host;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type','text/html'); response.end(host.panel.webview.html.replace('<body>', '<body class="vscode-light">')); return; }
      if (request.url === '/theme.css') {
        response.setHeader('Content-Type','text/css'); response.end('body{--vscode-font-family:sans-serif;--vscode-font-size:14px;--vscode-focusBorder:#007acc;--vscode-errorForeground:#f14c4c}body.vscode-light{--vscode-editor-background:#f5f5f5;--vscode-editor-foreground:#202020;--vscode-descriptionForeground:#666;--vscode-panel-border:#888;--vscode-button-secondaryBackground:#ddd;--vscode-button-secondaryForeground:#222}body.vscode-dark{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#555;--vscode-button-secondaryBackground:#444;--vscode-button-secondaryForeground:#eee}'); return;
      }
      const file = path.resolve(root, '.' + decodeURIComponent(request.url));
      if (!file.startsWith(path.join(root, 'static') + path.sep)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const errors = [], requests = [], results = [];
    for (const type of ['architecture', 'sequence']) {
      const name = type === 'architecture' ? 'local-path.architecture' : 'render-flow.sequence';
      let text = await fs.readFile(path.resolve(`../docs/refined/analysis/archify-integration/assets/${name}.json`), 'utf8');
      const original = text;
      const file = path.join(temporary, `${name}.json`);
      await fs.writeFile(file, original);
      const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) requests.push(request.url()); });
      host = fixture(client, { cspSource: "'self'", resource: value => '/' + path.relative(root, value.fsPath).split(path.sep).join('/'),
        postMessage: async message => { if (!page.isClosed()) await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), message); } });
      const document = { uri: host.uri(file), getText: () => text };
      await host.provider.resolveCustomTextEditor(document, host.panel);
      await page.exposeFunction('archifyHostPost', message => host.send(message));
      await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ postMessage: message => window.archifyHostPost(message) });
      });
      // Mirror the VS Code theme variables through an external stylesheet under the unchanged CSP.
      host.panel.webview.html = host.panel.webview.html.replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>');
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => document.querySelector('#image').naturalWidth > 0, null, {timeout:30000});
      const svg = Buffer.from((await page.locator('#image').getAttribute('src')).split(',')[1], 'base64').toString();
      assert.match(svg, type === 'architecture' ? /JSON 원본/ : /공식 스키마 검증/);
      assert.ok(await page.locator('#image').isVisible());
      await page.screenshot({path:path.join(evidence,`${type}-light.png`),fullPage:true});
      await page.evaluate(() => { document.body.className = 'vscode-dark'; });
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',{data:{type:'theme'}})));
      await page.waitForFunction(() => document.querySelector('#image').naturalWidth > 0);
      await page.screenshot({path:path.join(evidence,`${type}-dark.png`),fullPage:true});
      await page.evaluate(() => { document.body.className = 'vscode-dark vscode-high-contrast'; window.dispatchEvent(new MessageEvent('message',{data:{type:'theme'}})); });
      await page.waitForFunction(() => document.querySelector('#image').complete && document.querySelector('#image').naturalWidth > 0);
      const contrastSvg = Buffer.from((await page.locator('#image').getAttribute('src')).split(',')[1], 'base64').toString();
      assert.match(contrastSvg,/text\[class\]\{fill:rgb\(221, 221, 221\)!important\}/);
      await page.evaluate(() => { document.body.className = 'vscode-dark'; window.dispatchEvent(new MessageEvent('message',{data:{type:'theme'}})); });
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:path.join(evidence,`${type}-narrow.png`),fullPage:true});
      await page.locator('#source').click(); await waitFor(() => host.commands.length === 1);
      assert.equal(host.commands[0][0], 'vscode.openWith'); assert.equal(host.commands[0][2], 'default');
      const updated = JSON.parse(text); updated.meta.title = '저장 후 갱신된 도표'; text = JSON.stringify(updated);
      await fs.writeFile(file,text); host.save(document);
      await page.getByRole('heading', {name:'저장 후 갱신된 도표'}).waitFor();
      text = '{'; await fs.writeFile(file,text); host.save(document);
      await page.locator('#status.error').waitFor(); assert.equal(await page.locator('#image').isVisible(),false);
      await page.locator('#source').click(); await waitFor(() => host.commands.length === 2);
      text = '{"diagram_type":"erd"}'; await fs.writeFile(file,text); host.save(document);
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('diagram_type'));
      await page.screenshot({path:path.join(evidence,`${type}-error.png`),fullPage:true});
      assert.equal(await fs.readFile(file,'utf8'),text);
      results.push({type,fileOpened:true,rendered:true,sourceEditor:true,saveRefreshed:true,invalidJson:true,unsupportedType:true});
      host.dispose();await page.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    assert.equal((await fs.readdir(temporary)).length,2);
    await fs.writeFile(path.join(evidence,'checks.json'),JSON.stringify({results,errors,externalRequests:requests,environment:'Chromium with VS Code lifecycle fixture and real official renderer'},null,2)+'\n');
    console.log('Archify file-open → auto-install → SVG display, save refresh, source access and error checks passed.');
  } finally {
    host?.dispose();client.dispose();await browser?.close();await new Promise(resolve=>server.close(resolve));
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
