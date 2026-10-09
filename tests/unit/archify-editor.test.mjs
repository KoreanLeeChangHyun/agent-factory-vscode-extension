import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
import { fixture, waitFor } from '../support/archify-editor-fixture.mjs';
const { ArchifyClient } = await importTypeScript('src/infrastructure/agent-factory/archify-client.ts');

const diagram=title=>({title,type:'architecture',svg:'<svg viewBox="0 0 640 240"></svg>',styles:''});

test('manifest opts in only dedicated suffixes and provider keeps source/CSP boundaries', async()=>{
  const meta=JSON.parse(await readFile('package.json','utf8'));
  const editor=meta.contributes.customEditors.find(item=>item.viewType==='agentFactory.archify');
  assert.equal(editor.priority,'default');
  assert.deepEqual(editor.selector.map(item=>item.filenamePattern),['*.archify.json','*.architecture.json','*.sequence.json']);
  const host=fixture({preview:async()=>diagram('sample')});
  const context={extensionUri:host.uri(resolve('.')),extensionMode:1,extension:{packageJSON:{version:meta.version}},subscriptions:[]};
  host.exports.ArchifyEditor.register(context);
  assert.equal(host.registrations[0][0],editor.viewType);
  assert.equal(host.registrations[0][2].supportsMultipleEditorsPerDocument,true);
  context.subscriptions.forEach(item=>item.dispose());
  assert.equal(host.exports.isArchifyFile('/tmp/ordinary.json'),false);
  const document={uri:host.uri('/tmp/model.architecture.json'),getText:()=>'{"diagram_type":"architecture"}'};
  await host.provider.resolveCustomTextEditor(document,host.panel);
  assert.match(host.panel.webview.html,/default-src 'none'/);
  assert.match(host.panel.webview.html,/img-src data:/);
  assert.match(host.panel.webview.html,/connect-src 'none'/);
  assert.equal(host.panel.webview.options.localResourceRoots.length,1);
  assert.equal(host.panel.webview.options.localResourceRoots[0].fsPath,join(resolve('.'),'static'));
  host.send({type:'source'}); await waitFor(()=>host.commands.length);
  assert.deepEqual(host.commands[0],['vscode.openWith',document.uri,'default',2]);
  host.dispose();assert.equal(host.listenerCount(),0);
});

test('save coalescing discards stale preview, skips unrelated files, and retains source access on errors', async()=>{
  let text='{"diagram_type":"architecture"}', release;
  const renders=[];
  const host=fixture({preview:async value=>{renders.push(value);if(renders.length===1)await new Promise(resolve=>{release=resolve;});return diagram(value);}});
  const document={uri:host.uri('/tmp/model.archify.json'),getText:()=>text};
  await host.provider.resolveCustomTextEditor(document,host.panel);
  host.send({type:'ready'});await waitFor(()=>release);
  text='{"diagram_type":"sequence"}';host.save(document);release();
  await waitFor(()=>host.messages.some(m=>m.type==='diagram'));
  assert.equal(host.messages.filter(m=>m.type==='diagram').length,1);
  assert.equal(host.messages.find(m=>m.type==='diagram').title,text);
  const count=renders.length;host.save({uri:host.uri('/tmp/ordinary.json')});assert.equal(renders.length,count);
  text='{';host.save(document);await waitFor(()=>host.messages.at(-1).type==='error');
  host.send({type:'source'});assert.equal(host.commands.length,1);
  text='{"diagram_type":"erd"}';host.save(document);await waitFor(()=>host.messages.at(-1).message?.includes('diagram_type'));
  assert.equal(renders.length,count);
  host.vscode.workspace.isTrusted=false;host.send({type:'refresh'});await waitFor(()=>host.messages.at(-1).message?.includes('신뢰'));
  assert.equal(renders.length,count);host.dispose();
});

test('file-open lifecycle auto-installs pinned renderer and renders both types without modifying files', async t=>{
  const client=new ArchifyClient(async()=>({script:resolve('../plugin/scripts/archify.py'),python:'python3',environment:process.env}));
  t.after(()=>client.dispose());
  const root=await mkdtemp(join(tmpdir(),'archify-open-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const type of ['architecture','sequence']){
    const data=JSON.parse(await readFile(`../docs/refined/analysis/archify-integration/assets/${type==='architecture'?'local-path.architecture':'render-flow.sequence'}.json`,'utf8'));
    const original=JSON.stringify(data);const file=join(root,`한글 $(touch injected).${type}.json`);await writeFile(file,original);
    const host=fixture(client);const document={uri:host.uri(file),getText:()=>original};
    await host.provider.resolveCustomTextEditor(document,host.panel);host.send({type:'ready'});
    await waitFor(()=>host.messages.some(m=>['diagram','error'].includes(m.type)));
    const message=host.messages.at(-1);assert.equal(message.type,'diagram',message.message);
    assert.match(message.svg,type==='architecture'?/JSON 원본/:/공식 스키마 검증/);
    assert.match(message.styles,/\.t-primary/);assert.equal(await readFile(file,'utf8'),original);host.dispose();
  }
  assert.equal((await readdir(root)).length,2);
});
