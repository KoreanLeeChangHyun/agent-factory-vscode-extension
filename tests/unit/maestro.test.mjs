import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {importTypeScript} from '../support/import-typescript.mjs';

test('Maestro persists only the chat choice, and protocol rejects unbound navigation shapes', async () => {
  const {restoreChatState, createDraftChatState} = await importTypeScript('src/modules/chat/chat-state.ts');
  const settings = {panelId:'same-panel',agentId:'same-main',maestroMode:true,model:'fixed',fastMode:false,agentPermissions:{main:'workspace-write'},role:'main'};
  const restored = restoreChatState(settings);
  assert.equal(restored.maestroMode,true);
  assert.equal(restored.agentId,'same-main');
  assert.deepEqual(restored.agentPermissions,settings.agentPermissions);
  assert.equal(createDraftChatState(settings).maestroMode,false);
  const {parseClientMessage} = await importTypeScript('src/protocol/validator.ts');
  assert.equal(parseClientMessage({type:'composer.settings',fastMode:false,goalMode:false,maestroMode:'true'}),undefined);
  const request={type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'records'};
  assert.deepEqual(parseClientMessage(request),request);
  assert.equal(parseClientMessage({...request,workflowId:'../escape'}),undefined);
});

test('control center distinguishes actual completion receipts, decisions, blocked inputs and legacy unknowns', async () => {
  const context={};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const status=context.AgentFactoryChat.maestroStatus;
  assert.equal(status({status:'completed'},{workStatus:'completed'}),'unknown');
  assert.equal(status({status:'completed'},{runs:[{role:'work',status:'completed',receipt:{outcome:'completed'}}]}),'completed');
  assert.equal(status({status:'needs-human-decision'},{workStatus:'blocked'}),'decision');
  assert.equal(status({status:'active'},{workStatus:'pending',allocation:{dependencies:[{confirmed:false}]}}),'blocked');
  assert.equal(status({status:'active'},{workStatus:'pending'}),'waiting');
  assert.equal(status({status:'active'},{workStatus:'running'}),'running');
  assert.equal(status({status:'active'},{workStatus:'completed',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'completed');
  assert.equal(status({status:'active'},{workStatus:'completed',verificationStatus:'running',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'running');
  assert.equal(status({status:'runtime-error'},{workStatus:'pending'}),'failed');
  assert.equal(status({status:'failed'},{workStatus:'completed',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'completed','A later loop failure cannot rewrite a completed predecessor');
});

// Exercise the window boundary without creating a runtime session or using real user records.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const windowBundle = await build({ entryPoints: ['src/infrastructure/vscode/control-center-window.ts'], bundle:true, write:false, platform:'node', format:'cjs', external:['vscode'] });
function windowFixture({ supported = true, web = false, active = true, moveError = false, read } = {}) {
  const panels = [], moves = [], actions = [], reads = [], timers = [];
  const makePanel = (type, title) => {
    const disposeHandlers = new Set(), viewHandlers = new Set();
    let receive;
    const panel = { type, title, active, disposed:false, reveals:0, messages:[],
      reveal() { this.reveals++; this.active = true; for (const listener of viewHandlers) listener({webviewPanel:this}); },
      dispose() { if (this.disposed) return; this.disposed=true; for(const listener of [...disposeHandlers]) listener(); },
      onDidDispose(listener) { disposeHandlers.add(listener); return {dispose(){disposeHandlers.delete(listener);}}; },
      onDidChangeViewState(listener) { viewHandlers.add(listener); return {dispose(){viewHandlers.delete(listener);}}; },
      webview: { onDidReceiveMessage(listener) { receive=listener; return {dispose(){receive=undefined;}}; },
        postMessage(message) { panel.messages.push(message); return Promise.resolve(true); } },
      send(message) { receive?.(message); } };
    panels.push(panel); return panel;
  };
  const vscode = { UIKind:{Web:2}, env:{uiKind:web?2:1}, ViewColumn:{Active:-1},
    window:{createWebviewPanel:makePanel},
    commands:{async getCommands(){return supported?['workbench.action.moveEditorToNewWindow']:[];},
      async executeCommand(command){moves.push(command);if(moveError)throw new Error('Fixture window failure');}} };
  const module = {exports:{}};
  runInNewContext(windowBundle.outputFiles[0].text,{ module,exports:module.exports, Buffer, console, process, setTimeout, clearTimeout,
    setInterval(callback){const timer={callback,unref(){}};timers.push(timer);return timer;},
    clearInterval(timer){timer.cleared=true;}, require:name=>name==='vscode'?vscode:nodeRequire(name) });
  const windows = new module.exports.ControlCenterWindows({localResourceRoots:[],async render(_webview,name){assert.equal(name,'control-center.html');return '<html>Center</html>'; }},
    async root=>{reads.push(root);return read?read(root):[{id:root,tasks:[]}];},async(root,message)=>{actions.push({root,message});});
  return {windows,panels,moves,actions,reads,timers};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));

test('separate window is singleton per project under concurrent opening; close/reopen leaves task state alone', async()=>{
  const f=windowFixture();
  await Promise.all([f.windows.open('/projects/A'),f.windows.open('/projects/A',{workflowId:'flow-one',taskId:'task-one'})]);
  assert.equal(f.panels.length,1);assert.deepEqual(f.moves,['workbench.action.moveEditorToNewWindow']);
  f.panels[0].send({type:'client.ready'});await settle();
  assert.equal(f.reads.at(-1),'/projects/A');
  assert.equal(f.panels[0].messages.find(value=>value.type==='control.center.selection').taskId,'task-one');
  assert.ok(f.panels[0].messages.some(value=>value.type==='project.tasks'));
  f.timers[0].callback();await settle();assert.equal(f.reads.length,2);
  f.panels[0].send({type:'run.cancel'});f.panels[0].send({type:'chat.send'});await settle();assert.equal(f.actions.length,0);
  f.panels[0].send({type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'feedback'});await settle();
  assert.equal(f.actions[0].root,'/projects/A');assert.equal(f.actions[0].message.target,'feedback');
  f.panels[0].dispose();assert.equal(f.timers[0].cleared,true);
  await f.windows.open('/projects/A');assert.equal(f.panels.length,2);assert.equal(f.moves.length,2);
  await f.windows.open('/projects/B');assert.equal(f.panels.length,3);assert.notEqual(f.panels[1].type,f.panels[2].type);
  f.windows.dispose();assert.ok(f.panels.every(panel=>panel.disposed));
});

test('window activation completes before detaching, unavailable hosts cannot silently substitute a tab',async()=>{
  const f=windowFixture({active:false});await f.windows.open('/projects/A');assert.equal(f.moves.length,1);f.windows.dispose();
  for(const options of [{supported:false},{web:true}]){
    const absent=windowFixture(options);await assert.rejects(absent.windows.open('/projects/A'),/separate control center window/);assert.equal(absent.panels.length,0);
  }
  const failed=windowFixture({moveError:true});await assert.rejects(failed.windows.open('/projects/A'),/Fixture window failure/);assert.equal(failed.panels[0].disposed,true);
});

test('close while refresh is pending suppresses delivery; refresh errors remain display errors',async()=>{
  let done;const pending=new Promise(resolve=>{done=resolve;});
  const f=windowFixture({read:()=>pending});await f.windows.open('/projects/A');f.panels[0].send({type:'client.ready'});
  f.panels[0].dispose();done([]);await settle();assert.equal(f.panels[0].messages.length,0);
  const failed=windowFixture({read:()=>{throw new Error('Fixture refresh error');}});await failed.windows.open('/projects/A');failed.panels[0].send({type:'client.ready'});await settle();
  assert.match(failed.panels[0].messages[0].error,/Fixture refresh error/);assert.equal(failed.actions.length,0);failed.windows.dispose();
});

test('chat template has no center tabs or hidden center; navigation is validated',async()=>{
  const html=await readFile(new URL('../../templates/chat.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="maestro-(mode|open|center)"/);assert.match(html,/id="prompt"/);assert.match(html,/id="timeline"/);
  const {parseClientMessage}=await importTypeScript('src/protocol/validator.ts');
  assert.deepEqual(parseClientMessage({type:'control.center.open'}),{type:'control.center.open'});
  assert.equal(parseClientMessage({type:'control.center.open',workflowId:'flow-one'}),undefined);
  assert.equal(parseClientMessage({type:'control.center.open',workflowId:'../bad',taskId:'task-one'}),undefined);
});
