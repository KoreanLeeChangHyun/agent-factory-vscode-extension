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
  // A rework names the ended task by IDs only and cannot also aim at a running loop or run.
  const rework={type:'worker.command',agentId:'worker-a',text:'Redo',commandId:'cmd-00000001',rework:{workflowId:'flow-one',taskId:'task-one'}};
  assert.deepEqual(parseClientMessage({...rework,rework:{...rework.rework,extra:true}}),rework);
  assert.equal(parseClientMessage({...rework,rework:{workflowId:'../escape',taskId:'task-one'}}),undefined);
  assert.equal(parseClientMessage({...rework,loopId:'loop-a'}),undefined);
  assert.equal(parseClientMessage({...rework,rework:'flow-one/task-one'}),undefined);
  // A handoff names the loop, a model identifier and a non-empty reason; supervision and model reads carry nothing.
  const handoff={type:'worker.handoff',agentId:'worker-a',loopId:'loop-a',toModel:'antigravity/gemini-3-pro',reason:' limit '};
  assert.deepEqual(parseClientMessage(handoff),{...handoff,reason:'limit'});
  for (const bad of [{toModel:'model; rm -rf'},{toModel:''},{reason:'  '},{reason:'x'.repeat(2001)},{loopId:'../x'}]) assert.equal(parseClientMessage({...handoff,...bad}),undefined);
  assert.deepEqual(parseClientMessage({type:'supervision.request',extra:1}),{type:'supervision.request'});
  assert.deepEqual(parseClientMessage({type:'handoff.models.request'}),{type:'handoff.models.request'});
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
  // Work ended and its requested Verification is still open: the task sits in the check column, not with running work.
  assert.equal(status({status:'active'},{workStatus:'completed',verificationStatus:'running',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'verifying');
  assert.equal(status({status:'active'},{workStatus:'verifying'}),'verifying');
  assert.equal(status({status:'runtime-error'},{workStatus:'pending'}),'failed');
  assert.equal(status({status:'failed'},{workStatus:'completed',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'completed','A later loop failure cannot rewrite a completed predecessor');
});

// Exercise the window boundary without creating a runtime session or using real user records.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const centerBundle = await build({ entryPoints: ['src/infrastructure/vscode/control-center-window.ts'], bundle:true, write:false, platform:'node', format:'cjs', external:['vscode'] });
function editorFixture({ supported = true, web = false, active = true, moveError = false, read, orderStore } = {}) {
  const panels = [], moves = [], actions = [], reads = [], timers = [];
  const groupListeners=new Set(), tabListeners=new Set();
  const mainGroup={tabs:[],viewColumn:1};const tabGroups={all:[mainGroup],
    onDidChangeTabGroups(listener){groupListeners.add(listener);return {dispose(){groupListeners.delete(listener);}};},
    onDidChangeTabs(listener){tabListeners.add(listener);return {dispose(){tabListeners.delete(listener);}};}};
  class TabInputWebview {constructor(viewType){this.viewType=viewType;}}

  const makePanel = (type, title, column) => {
    const disposeHandlers = new Set(), viewHandlers = new Set();
    let receive;
    const panel = { type, viewType:type, title, column, active, disposed:false, reveals:0, messages:[],
      reveal() { this.reveals++; this.active = true; for (const listener of viewHandlers) listener({webviewPanel:this}); },
      dispose() { if (this.disposed) return; this.disposed=true; for (const group of tabGroups.all) group.tabs=group.tabs.filter(tab=>tab.input.viewType!==this.viewType); for(const listener of [...disposeHandlers]) listener(); },
      onDidDispose(listener) { disposeHandlers.add(listener); return {dispose(){disposeHandlers.delete(listener);}}; },
      onDidChangeViewState(listener) { viewHandlers.add(listener); return {dispose(){viewHandlers.delete(listener);}}; },
      webview: { onDidReceiveMessage(listener) { receive=listener; return {dispose(){receive=undefined;}}; },
        postMessage(message) { panel.messages.push(message); return Promise.resolve(true); } },
      send(message) { receive?.(message); } };
    mainGroup.tabs.push({input:new TabInputWebview(type)});panels.push(panel); return panel;
  };
  const prompts=[];let answer;
  const vscode = { TabInputWebview, UIKind:{Web:2}, env:{uiKind:web?2:1}, ViewColumn:{Active:-1,Beside:-2},
    window:{createWebviewPanel:makePanel,tabGroups,async showWarningMessage(text,options,...items){prompts.push({text,options,items});return answer===undefined?items[0]:answer;}},
    commands:{async getCommands(){return supported?['workbench.action.moveEditorToNewWindow']:[];},
      async executeCommand(command){
        moves.push(command);if(moveError)throw new Error('Fixture window failure');
        const panel=panels.at(-1), index=mainGroup.tabs.findIndex(tab=>tab.input.viewType===panel.viewType);
        const group={tabs:[mainGroup.tabs.splice(index,1)[0]],viewColumn:tabGroups.all.length+1};tabGroups.all.push(group);
        for(const listener of groupListeners)listener({closed:[],opened:[group],changed:[]});
        for(const listener of tabListeners)listener({opened:group.tabs,closed:[],changed:[]});
      }} };
  const module = {exports:{}};
  runInNewContext(centerBundle.outputFiles[0].text,{ module,exports:module.exports, Buffer, console, process, setTimeout, clearTimeout,
    setInterval(callback){const timer={callback,unref(){}};timers.push(timer);return timer;},
    clearInterval(timer){timer.cleared=true;}, require:name=>name==='vscode'?vscode:nodeRequire(name) });
  const windows = new module.exports.ControlCenterWindows({localResourceRoots:[],async render(_webview,name){assert.equal(name,'control-center.html');return '<html>Center</html>'; }},
    async root=>{reads.push(root);return read?read(root):[{id:root,tasks:[]}];},async(root,message)=>{actions.push({root,message});},undefined,undefined,undefined,orderStore);
  return {windows,panels,moves,actions,reads,timers,prompts,answer:value=>{answer=value;},
    moveTab(){const group={tabs:mainGroup.tabs.splice(0),viewColumn:2};tabGroups.all=[group];
      for(const listener of groupListeners)listener({closed:[mainGroup],opened:[group],changed:[]});}};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));

test('editor tab is singleton per project under concurrent opening; close/reopen leaves task state alone', async()=>{
  const f=editorFixture();
  await Promise.all([f.windows.open('/projects/A'),f.windows.open('/projects/A',{workflowId:'flow-one',taskId:'task-one'})]);
  assert.equal(f.panels.length,1);assert.deepEqual(f.moves,[]);assert.equal(f.panels[0].column,-2);
  f.panels[0].send({type:'client.ready'});await settle();
  assert.equal(f.reads.at(-1),'/projects/A');
  assert.equal(f.panels[0].messages.find(value=>value.type==='control.center.selection').taskId,'task-one');
  assert.ok(f.panels[0].messages.some(value=>value.type==='project.tasks'));
  f.timers[0].callback();await settle();assert.equal(f.reads.length,2);
  f.panels[0].send({type:'run.cancel'});f.panels[0].send({type:'chat.send'});await settle();assert.equal(f.actions.length,0);
  f.panels[0].send({type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'feedback'});await settle();
  assert.equal(f.actions[0].root,'/projects/A');assert.equal(f.actions[0].message.target,'feedback');
  f.panels[0].dispose();assert.equal(f.timers[0].cleared,true);
  await f.windows.open('/projects/A');assert.equal(f.panels.length,2);assert.equal(f.moves.length,0);
  await f.windows.open('/projects/B');assert.equal(f.panels.length,3);
  // One restorable view type; each tab carries its own project binding.
  assert.ok(f.panels.every(panel=>panel.type==='agentFactory.controlCenter'));
  f.panels[2].send({type:'client.ready'});await settle();
  assert.equal(JSON.stringify(f.panels[2].messages.find(value=>value.type==='control.center.project')),JSON.stringify({type:'control.center.project',projectRoot:'/projects/B'}));
  assert.equal(f.reads.at(-1),'/projects/B');
  f.windows.dispose();assert.ok(f.panels.every(panel=>panel.disposed));
});

test('editor tabs open on desktop and web hosts without requesting new OS windows',async()=>{
  for(const options of [{active:false},{supported:false},{web:true},{moveError:true}]){
    const f=editorFixture(options);await f.windows.open('/projects/A');assert.equal(f.moves.length,0);assert.equal(f.panels.length,1);assert.equal(f.panels[0].column,-2);f.windows.dispose();
  }
});

test('close while refresh is pending suppresses delivery; refresh errors remain display errors',async()=>{
  let done;const pending=new Promise(resolve=>{done=resolve;});
  const f=editorFixture({read:()=>pending});await f.windows.open('/projects/A');f.panels[0].send({type:'client.ready'});
  f.panels[0].dispose();done([]);await settle();assert.equal(f.panels[0].messages.filter(value=>value.type==='project.tasks').length,0);
  const failed=editorFixture({read:()=>{throw new Error('Fixture refresh error');}});await failed.windows.open('/projects/A');failed.panels[0].send({type:'client.ready'});await settle();
  assert.match(failed.panels[0].messages.find(value=>value.type==='project.tasks').error,/Fixture refresh error/);assert.equal(failed.actions.length,0);failed.windows.dispose();
});

test('chat template has no center tabs or hidden center; navigation is validated',async()=>{
  const html=await readFile(new URL('../../templates/chat.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="maestro-(mode|open|center)"/);assert.match(html,/id="prompt"/);assert.match(html,/id="timeline"/);
  const {parseClientMessage}=await importTypeScript('src/protocol/validator.ts');
  assert.deepEqual(parseClientMessage({type:'control.center.open'}),{type:'control.center.open'});
  assert.equal(parseClientMessage({type:'control.center.open',workflowId:'flow-one'}),undefined);
  assert.equal(parseClientMessage({type:'control.center.open',workflowId:'../bad',taskId:'task-one'}),undefined);
});


test('tab movement and group closure do not dispose a surviving editor; reopening focuses it',async()=>{
  const f=editorFixture();await f.windows.open('/projects/A');
  f.moveTab();assert.equal(f.panels[0].disposed,false);
  await f.windows.open('/projects/A');assert.equal(f.panels.length,1);assert.ok(f.panels[0].reveals>0);
  assert.equal(f.moves.length,0);assert.equal(f.actions.length,0);f.windows.dispose();
});


test('worker relationships preserve stable IDs across tasks and explicit fixture domains without fabricating assignments',async()=>{
  const context={};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const rows=context.AgentFactoryChat.maestroWorkers([{id:'flow-a',tasks:[
    {id:'one',domain:'API',workAgentId:'same-worker',runs:[{agentId:'same-worker',runId:'one',status:'completed',role:'work'},{agentId:'verifier',runId:'verify',role:'verification',status:'running'}]},
    {id:'two',domain:'Extension',workAgentId:'same-worker',runs:[]},
    {id:'three',title:'API fake domain',runs:[{agentId:'same-worker',model:'API-model',runId:'three',status:'running'}]},
    {id:'unassigned',title:'No assignment'}]}]);
  assert.deepEqual(Array.from(rows,row=>[row.task.id,row.agentId,row.domain]),[['one','same-worker','API'],['one','verifier','API'],['two','same-worker','Extension'],['three','same-worker','']]);
  assert.equal(context.AgentFactoryChat.maestroActivity(undefined),'unknown');
  assert.equal(context.AgentFactoryChat.maestroActivity({status:'completed'}),'completed');
  assert.equal(context.AgentFactoryChat.maestroActivity({status:'needs-human-decision'}),'decision');
  const {parseClientMessage}=await importTypeScript('src/protocol/validator.ts');
  const request={type:'project.task.open',workflowId:'flow-a',taskId:'one',target:'result',agentId:'same-worker',runId:'one'};
  assert.deepEqual(parseClientMessage(request),request);
  assert.equal(parseClientMessage({...request,runId:'../other'}),undefined);
  assert.equal(parseClientMessage({...request,agentId:undefined}),undefined);
  // The work request opens like the report: only with the exact agent and run.
  assert.deepEqual(parseClientMessage({...request,target:'request'}),{...request,target:'request'});
  assert.equal(parseClientMessage({...request,target:'request',runId:undefined}),undefined);
  assert.equal(parseClientMessage({...request,target:'request',agentId:'../x'}),undefined);
});

test('worker index names the model and first assignment, lists every open task and only the newest ended one',async()=>{
  const context={};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const row=(id,status,at,extra={})=>({agentId:'same-model-a',entry:{id:'flow-'+id,status:'active'},task:{id,title:'Task '+id,...extra.task},run:extra.run,status,at,domain:'',domainName:''});
  const index=context.AgentFactoryChat.maestroWorkerIndex([
    row('first','completed','2026-10-01T00:00:00Z',{task:{allocation:{unitReason:'  One owner for the API  '}},run:{model:'model-x'}}),
    row('older-done','failed','2026-10-02T00:00:00Z'),
    row('newest-done','completed','2026-10-05T00:00:00Z',{run:{provider:'claude'}}),
    row('running','running','2026-10-04T00:00:00Z'),
    row('waiting','waiting','2026-10-06T00:00:00Z'),
    {...row('other','running','2026-10-06T00:00:00Z',{run:{model:'model-x'}}),agentId:'same-model-b'}],undefined,Date.parse('2026-10-06T01:00:00Z'));
  const [a,b]=index;
  assert.equal(a.agentId,'same-model-a');assert.equal(b.agentId,'same-model-b','Workers on the same model stay separate');
  assert.equal(a.model,'model-x','The newest run that recorded a model names the worker');assert.equal(a.provider,'');
  assert.equal(a.purpose,'Task first');assert.equal(a.purposeReason,'One owner for the API','The purpose is the first assignment, not the latest request');
  assert.deepEqual(Array.from(a.current,value=>value.task.id),['running','waiting'],'Running work leads even when a waiting task is newer');
  assert.equal(a.ended.task.id,'newest-done','Only the newest ended task is listed; older ones stay in history');
  assert.equal(a.status,'running','The row state is an open task, not a past result');
  const ended=context.AgentFactoryChat.maestroWorkerIndex([row('only','completed','2026-10-05T00:00:00Z',{run:{provider:'codex'}})],undefined,Date.now())[0];
  assert.equal(ended.model,'');assert.equal(ended.provider,'codex');assert.equal(ended.current.length,0);assert.equal(ended.status,'completed');
  assert.equal(ended.purposeReason,'');
});

test('purpose and result lines shorten recorded text by rule without adding facts',async()=>{
  const context={};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const {maestroPurpose:purpose,maestroResultLine:result}=context.AgentFactoryChat;
  assert.equal(purpose('Agent Factory 작업 조율을 다양한 정상·경계·실패 조건에서 반복 시험하고, 실제 실행 증거와 남은 취약 지점을 보고하십시오. 단순 계산 반복이 아니라'),'Agent Factory 작업 조율을 다양한 정상·경계·실패 조건에서 반복 시험');
  assert.equal(purpose('사용자님이 승인하셨습니다. 하나의 채팅에서 실행 기반을 구현하고, 진전을 감찰하십시오.'),'하나의 채팅에서 실행 기반 구현');
  assert.equal(purpose('사용자님의 “다시 수정해”에 따라 작업자 항목의 높이를 바로잡으십시오.'),'작업자 항목의 높이 바로잡기');
  assert.equal(purpose('주문 목록 반응형 정렬 조정을 진행하십시오.'),'주문 목록 반응형 정렬 조정');
  assert.equal(purpose('Maestro 운영 설계 Document 재작업 2 (Scribe, 교훈 작성 2단계 분리 추가)'),'Maestro 운영 설계 Document 재작업 2 (Scribe, 교훈 작성 2단계 분리 추가)','A short title is kept as recorded');
  assert.equal(purpose('Fix the import order.'),'Fix the import order');
  // A series item keeps its own label: object of the instruction + item label; A and B stay distinct.
  assert.equal(purpose('작업 조율 재시험 A: 독립 계산을 실행하고 결과를 반환하십시오.'),'독립 계산 재시험 A');
  assert.equal(purpose('작업 조율 재시험 B: 독립 계산을 실행하고 결과를 반환하십시오.'),'독립 계산 재시험 B');
  assert.equal(purpose('작업 조율 테스트 A: 독립된 계산을 실행하고 실제 결과를 Main에 반환하십시오.'),'독립된 계산 테스트 A');
  assert.equal(purpose('Brief 1: 통제 화면 버튼 연결과 Main 지침의 자동 배분 안내 (extension, Work, 같은 세션)'),'Brief 1: 통제 화면 버튼 연결과 Main 지침의 자동 배분 안내 (extension, Work, 같은 세션)','Without a stated object the title is kept');
  assert.equal(purpose(''),'');assert.equal(purpose(undefined),'');
  assert.equal(result('48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다. 기존 사례 43개를 사용했습니다.'),'48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다.','Numbers come only from the record');
  assert.equal(result('사용자님, **코드 구현이 완료되었습니다.** 설치본은 그대로입니다.'),'코드 구현이 완료되었습니다.');
  assert.equal(result('사용자님 요청에 따라 [초안](a.md) 두 건을 작성했습니다.'),'초안 두 건을 작성했습니다.');
  assert.equal(result('네. 실행 중인 작업에는 강제 종료를 제공합니다.'),'네. 실행 중인 작업에는 강제 종료를 제공합니다.');
  assert.equal(result(''),'','Nothing recorded stays empty for the caller to say so');
});

test('worker rows follow terminal task records, group by next action and show recorded relative times only', async () => {
  const context={Intl,Date};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const {maestroStatus:status,maestroAssignment:assignment,maestroSection:section,maestroRelative:relative}=context.AgentFactoryChat;
  // A verification that was never requested keeps its initial pending record without running.
  assert.equal(status({status:'completed'},{workStatus:'completed',verificationDisposition:'not-requested',verificationStatus:'pending',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'completed');
  assert.equal(status({status:'completed'},{workStatus:'completed',verificationStatus:'pending',runs:[{role:'work',receipt:{outcome:'completed'}}]}),'verifying');
  assert.equal(section('verifying','2026-01-01T00:00:00Z',Date.parse('2026-10-10T00:00:00Z')),'active','A task under check stays with active work');
  assert.equal(status({status:'cancelled'},{workStatus:'cancelled',runs:[{role:'work',status:'needs-human-decision'}]}),'cancelled');
  assert.equal(status({status:'needs-human-decision'},{workStatus:'blocked',runs:[{role:'work',status:'needs-human-decision'}]}),'decision');
  assert.equal(assignment({workStatus:'cancelled'},{role:'work',status:'needs-human-decision'}),'cancelled');
  assert.equal(assignment({workStatus:'blocked'},{role:'work',status:'needs-human-decision'}),'decision');
  assert.equal(assignment({workStatus:'completed',verificationStatus:'running'},{role:'verification',status:'running'}),'running','Verification uses its own record');
  assert.equal(assignment({workStatus:'completed',verificationStatus:'completed'},{role:'verification',status:'running'}),'completed');
  assert.equal(assignment({workStatus:'pending'},undefined),'waiting');
  assert.equal(assignment({workStatus:'completed'},undefined),'unknown');
  const now=Date.parse('2026-10-09T12:00:00Z');
  assert.equal(section('decision','2026-09-01T00:00:00Z',now),'attention');
  assert.equal(section('running',undefined,now),'active');
  assert.equal(section('failed','2026-10-09T02:00:00Z',now),'recent');
  assert.equal(section('completed','2026-10-07T00:00:00Z',now),'earlier');
  assert.equal(section('completed',undefined,now),'earlier','Missing times never count as recent');
  // Unit and sign selection; the wording itself belongs to the runtime's Intl data.
  const narrow=language=>new Intl.RelativeTimeFormat(language,{numeric:'auto',style:'narrow'});
  assert.equal(relative('2026-10-09T11:57:00Z',now,'en'),narrow('en').format(-3,'minute'));
  assert.equal(relative('2026-10-09T09:00:00Z',now,'ko'),narrow('ko').format(-3,'hour'));
  assert.equal(relative('2026-10-09T11:59:40Z',now,'en'),narrow('en').format(0,'second'));
  assert.equal(relative('2026-10-08T10:00:00Z',now,'en'),narrow('en').format(-1,'day'));
  assert.equal(relative('not-a-time',now,'en'),'');
  assert.equal(relative(undefined,now,'ko'),'');
});


test('restored tabs rebind their project; duplicates and races with manual opening leave one tab per project', async()=>{
  const f=editorFixture();
  const restored=(column=1)=>{const panel={...f.panels.length?{}:{},viewType:'agentFactory.controlCenter',title:'',viewColumn:column,disposed:false,reveals:0,messages:[],
    webview:{options:undefined,html:'',onDidReceiveMessage(listener){panel.receive=listener;return {dispose(){}};},postMessage(message){panel.messages.push(message);return Promise.resolve(true);}},
    onDidDispose(listener){panel.onDispose=listener;return {dispose(){}};},reveal(){panel.reveals++;},dispose(){if(panel.disposed)return;panel.disposed=true;panel.onDispose?.();},send(message){panel.receive?.(message);}};return panel;};
  const a=restored(2);await f.windows.revive('/projects/A',a);
  assert.equal(a.disposed,false);assert.equal(a.webview.html,'<html>Center</html>');assert.equal(a.webview.options.enableScripts,true);
  assert.match(a.title,/A$/);assert.equal(a.viewColumn,2,'Restored tab keeps the position VS Code restored');
  a.send({type:'client.ready'});await settle();
  assert.equal(JSON.stringify(a.messages.find(value=>value.type==='control.center.project')),JSON.stringify({type:'control.center.project',projectRoot:'/projects/A'}));
  assert.ok(a.messages.some(value=>value.type==='project.tasks'));
  assert.equal(f.timers.length,1,'One poller for the restored tab');
  // A manual open focuses the restored tab instead of creating another.
  await f.windows.open('/projects/A');assert.equal(f.panels.length,0);assert.equal(a.reveals,1);
  // A second restored copy of the same project is closed; another project restores separately.
  const copy=restored();await f.windows.revive('/projects/A',copy);assert.equal(copy.disposed,true);assert.equal(f.timers.length,1);
  const b=restored();await f.windows.revive('/projects/B',b);assert.equal(b.disposed,false);assert.equal(f.timers.length,2);
  b.send({type:'client.ready'});await settle();assert.equal(b.messages.find(value=>value.type==='control.center.project').projectRoot,'/projects/B');
  // Closing a tab clears only that project's poller; the other tab is unaffected.
  a.dispose();assert.equal(f.timers[0].cleared,true);assert.equal(f.timers[1].cleared,undefined);
  f.windows.dispose();assert.equal(b.disposed,true);
  const late=restored();await f.windows.revive('/projects/A',late);assert.equal(late.disposed,true,'No tab is bound after extension shutdown');

  // Restore and manual open racing for the same project end with one tab.
  const race=editorFixture();const revived=restored();
  await Promise.all([race.windows.open('/projects/C'),race.windows.revive('/projects/C',revived)]);
  assert.equal(race.panels.length+(revived.disposed?0:1),1);assert.equal(race.timers.filter(timer=>!timer.cleared).length,1);race.windows.dispose();
  const reverse=editorFixture();const first=restored();
  await Promise.all([reverse.windows.revive('/projects/D',first),reverse.windows.open('/projects/D')]);
  assert.equal(first.disposed,false);assert.equal(reverse.panels.length,0);assert.equal(first.reveals,1);reverse.windows.dispose();
});

test('hiding a tab is not closing it; only dispose ends polling', async()=>{
  const f=editorFixture();await f.windows.open('/projects/A');const panel=f.panels[0];panel.send({type:'client.ready'});await settle();
  panel.active=false;assert.equal(panel.disposed,false);f.timers[0].callback();await settle();assert.equal(f.reads.length,2);
  await f.windows.open('/projects/A');assert.equal(f.panels.length,1);f.windows.dispose();
});

test('restored project roots are validated against the workspace and never guessed', async()=>{
  const module={exports:{}};runInNewContext(centerBundle.outputFiles[0].text,{module,exports:module.exports,Buffer,require:name=>name==='vscode'?{}:nodeRequire(name)});
  const root=module.exports.restoredControlCenterRoot;
  assert.equal(root({projectRoot:'/work/a'},['/work/a','/work/b']),'/work/a');
  assert.equal(root({projectRoot:'/work/a/sub/'},['/work/a']),'/work/a/sub');
  assert.equal(root({projectRoot:'/work/b'},['/work/a']),undefined,'Another workspace project is not opened');
  assert.equal(root({projectRoot:'/work/a/../b'},['/work/a']),undefined);
  assert.equal(root({projectRoot:'/work/ab'},['/work/a']),undefined);
  assert.equal(root({projectRoot:'relative'},['/work/a']),undefined);
  assert.equal(root({projectRoot:42},['/work/a']),undefined);
  assert.equal(root({projectRoot:'/'+'x'.repeat(5000)},['/']),undefined);
  assert.equal(root(undefined,['/work/a']),'/work/a','State saved before binding uses the only workspace folder');
  assert.equal(root({centerView:'tasks'},['/work/a','/work/b']),undefined,'Ambiguous older state is closed');
  assert.equal(root(null,[]),undefined);
});

test('control center restoration is registered for activation and VS Code serialization', async()=>{
  const manifest=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  assert.ok(manifest.activationEvents.includes('onWebviewPanel:agentFactory.controlCenter'));
  assert.ok(manifest.activationEvents.includes('onWebviewPanel:agentFactory.mainChat'));
  const bootstrap=await readFile(new URL('../../src/core/bootstrap.ts',import.meta.url),'utf8');
  assert.match(bootstrap,/registerWebviewPanelSerializer\(CONTROL_CENTER_VIEW_TYPE/);
  assert.match(bootstrap,/reviveControlCenter\(panel, state\)/);
  const script=await readFile(new URL('../../static/js/control-center.js',import.meta.url),'utf8');
  assert.match(script,/projectRoot: state\.projectRoot/,'The webview keeps its project binding in the state VS Code restores');
});

test('domain edits from a tab return their result to it and refresh the shared list once more after an in-flight read', async()=>{
  const json=value=>JSON.parse(JSON.stringify(value));let release;const edits=[];let revision=1;
  const f=editorFixture();
  const windows=new f.windows.constructor({localResourceRoots:[],async render(){return '<html>Center</html>';}},
    async()=>[{id:'flow',tasks:[]}],async()=>{},
    async()=>{const value={revision,domains:[],assignments:{}};if(release)await release;return value;},
    async(root,edit)=>{edits.push({root,edit});if(edit.name==='taken')throw Object.assign(new Error('already exists'),{code:'domain_name_taken'});revision++;return {revision,domains:[],assignments:{}};});
  await windows.open('/projects/A');const panel=f.panels.at(-1);panel.send({type:'client.ready'});await settle();
  assert.equal(panel.messages.filter(value=>value.type==='project.tasks').at(-1).domains.revision,1);
  let unblock;release=new Promise(resolve=>{unblock=resolve;});
  f.timers.at(-1).callback();await settle();
  panel.send({type:'domain.create',name:'Docs',revision:1});await settle();
  release=undefined;unblock();for(let i=0;i<5;i++)await settle();
  assert.deepEqual(json(edits[0]),{root:'/projects/A',edit:{type:'domain.create',name:'Docs',revision:1}});
  assert.deepEqual(json(panel.messages.find(value=>value.type==='domain.result')),{type:'domain.result',edit:'domain.create'});
  assert.equal(panel.messages.filter(value=>value.type==='project.tasks').at(-1).domains.revision,2,'The read that raced the edit is followed by a fresh one');
  panel.send({type:'domain.create',name:'taken',revision:2});for(let i=0;i<5;i++)await settle();
  assert.deepEqual(json(panel.messages.filter(value=>value.type==='domain.result').at(-1)),{type:'domain.result',edit:'domain.create',error:'already exists',code:'domain_name_taken'});
  const failing=new f.windows.constructor({localResourceRoots:[],async render(){return '<html>Center</html>';}},async()=>[],async()=>{},async()=>{throw new Error('store invalid');});
  await failing.open('/projects/B');const other=f.panels.at(-1);other.send({type:'client.ready'});await settle();
  assert.deepEqual(json(other.messages.filter(value=>value.type==='project.tasks').at(-1)),{type:'project.tasks',entries:[],domainsError:'Error: store invalid'},'A domain read failure keeps the task list');
  other.send({type:'domain.assign',agentId:'work-a',domainId:'domain-aaaaaaaaaaaa',revision:0});for(let i=0;i<5;i++)await settle();
  assert.equal(other.messages.filter(value=>value.type==='domain.result').at(-1).code,'domains_unavailable');
  windows.dispose();failing.dispose();f.windows.dispose();
});

test('display domains prefer the editable membership, then the recorded allocation name through former names', async()=>{
  const context={Intl,Date};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const resolve=context.AgentFactoryChat.maestroDomain;
  const registry={revision:3,domains:[{id:'domain-aaaaaaaaaaaa',name:'Extension UI',aliases:['Extension']},{id:'domain-bbbbbbbbbbbb',name:'Docs',aliases:[]}],
    assignments:{'work-moved':{domainId:'domain-bbbbbbbbbbbb',setBy:{actor:'human'}},'work-unset':{domainId:null,setBy:{actor:'human'}}}};
  const plain=value=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(resolve(registry,'work-moved',{domain:'Extension'})),{key:'domain-bbbbbbbbbbbb',name:'Docs',domainId:'domain-bbbbbbbbbbbb',basis:'membership',setBy:{actor:'human'}});
  assert.deepEqual(plain(resolve(registry,'work-unset',{domain:'Extension'})),{key:'',name:'',basis:'membership',setBy:{actor:'human'}},'A Human unclassified choice wins over the record');
  assert.deepEqual(plain(resolve(registry,'work-new',{domain:' extension '})),{key:'domain-aaaaaaaaaaaa',name:'Extension UI',domainId:'domain-aaaaaaaaaaaa',basis:'allocation',recorded:'extension'});
  assert.deepEqual(plain(resolve(registry,'work-new',{domain:'Runtime'})),{key:'name:Runtime',name:'Runtime',basis:'allocation',recorded:'Runtime'});
  assert.deepEqual(plain(resolve(undefined,'work-new',{domain:'Runtime'})),{key:'name:Runtime',name:'Runtime',basis:'allocation',recorded:'Runtime'});
  assert.deepEqual(plain(resolve(registry,'work-new',{})),{key:'',name:'',basis:'none'});
  // A provisional new domain named 미분류 never captures a task whose recorded name is 미분류; membership still places workers.
  const withNew={...registry,domains:[...registry.domains,{id:'domain-cccccccccccc',name:'미분류',provisional:true,aliases:[]}],assignments:{'work-placed':{domainId:'domain-cccccccccccc',setBy:{actor:'human'}}}};
  assert.deepEqual(plain(resolve(withNew,'work-new',{domain:'미분류'})),{key:'name:미분류',name:'미분류',basis:'allocation',recorded:'미분류'});
  assert.equal(resolve(withNew,'work-placed',{}).key,'domain-cccccccccccc');
});


test('worker actions confirm stop and removal, never run twice at once, report failures and refresh', async()=>{
  const f=editorFixture();const json=value=>JSON.parse(JSON.stringify(value));
  let release;const calls=[];let reads=0;
  const control={async command(root,action){calls.push(['command',root,action.agentId,action.text]);if(release)await release;return {mode:'addition',loopId:'loop-a'};},
    async stop(root,action){calls.push(['stop',action.loopId,action.taskId]);if(action.taskId==='bad')throw Object.assign(new Error('Only an exactly bound single-task Loop can be stopped'),{code:'loop_stop_scope'});return {};},
    async remove(root,action){calls.push(['remove',action.agentId,action.revision]);throw Object.assign(new Error('Stop this worker\'s running task before removing it'),{code:'worker_running'});}};
  const windows=new f.windows.constructor({localResourceRoots:[],async render(){return '<html>Center</html>';}},async()=>{reads++;return [{id:'flow',tasks:[]}];},async()=>{},async()=>undefined,undefined,control);
  await windows.open('/projects/A');const panel=f.panels.at(-1);panel.send({type:'client.ready'});await settle();
  const results=()=>json(panel.messages.filter(value=>value.type==='worker.result'));
  let unblock;release=new Promise(resolve=>{unblock=resolve;});
  panel.send({type:'worker.command',agentId:'worker-a',text:'Do it',commandId:'cmd-00000001'});await settle();
  panel.send({type:'worker.command',agentId:'worker-a',text:'Again',commandId:'cmd-00000002'});await settle();
  assert.deepEqual(results().at(-1),{type:'worker.result',action:'worker.command',agentId:'worker-a',commandId:'cmd-00000002',error:'This worker\'s previous action is still in progress.',code:'worker_action_pending'});
  release=undefined;unblock();for(let i=0;i<6;i++)await settle();
  assert.deepEqual(calls,[['command','/projects/A','worker-a','Do it']],'The second action did not start while the first ran');
  assert.deepEqual(results().find(value=>value.commandId==='cmd-00000001'),{type:'worker.result',action:'worker.command',agentId:'worker-a',commandId:'cmd-00000001',result:{mode:'addition',loopId:'loop-a'}});
  assert.equal(f.prompts.length,0,'Instructions are not confirmed; they are the Human\'s own text');
  const before=reads;
  // Force stop asks first; declining sends nothing.
  f.answer(undefined);f.answer('');
  panel.send({type:'worker.stop',agentId:'worker-a',loopId:'loop-a',workflowId:'flow',taskId:'task'});for(let i=0;i<6;i++)await settle();
  assert.match(f.prompts.at(-1).text,/Force stop task task of worker-a/);assert.equal(f.prompts.at(-1).options.modal,true);
  assert.deepEqual(results().at(-1),{type:'worker.result',action:'worker.stop',agentId:'worker-a',cancelled:true});assert.equal(calls.length,1);
  f.answer(undefined);
  panel.send({type:'worker.stop',agentId:'worker-a',loopId:'loop-a',workflowId:'flow',taskId:'task'});for(let i=0;i<6;i++)await settle();
  assert.deepEqual(calls.at(-1),['stop','loop-a','task']);assert.deepEqual(results().at(-1).result,{});
  panel.send({type:'worker.stop',agentId:'worker-a',loopId:'loop-a',workflowId:'flow',taskId:'bad'});for(let i=0;i<6;i++)await settle();
  assert.equal(results().at(-1).code,'loop_stop_scope');
  panel.send({type:'worker.remove',agentId:'worker-a',revision:4});for(let i=0;i<6;i++)await settle();
  assert.match(f.prompts.at(-1).text,/Remove worker-a from the worker list\? Its tasks, runs, results and artifacts are kept/);
  assert.deepEqual(calls.at(-1),['remove','worker-a',4]);assert.equal(results().at(-1).code,'worker_running');
  assert.ok(reads>before+3,'Every action refreshes the records afterwards');
  const none=new f.windows.constructor({localResourceRoots:[],async render(){return '<html>Center</html>';}},async()=>[],async()=>{});
  await none.open('/projects/B');const other=f.panels.at(-1);other.send({type:'client.ready'});await settle();
  other.send({type:'worker.command',agentId:'worker-a',text:'x',commandId:'cmd-00000003'});for(let i=0;i<6;i++)await settle();
  assert.equal(json(other.messages.filter(value=>value.type==='worker.result')).at(-1).code,'worker_control_unavailable');
  windows.dispose();none.dispose();f.windows.dispose();
});

test('provider handoff is confirmed and carries a control-center reference; supervision and models are read on request', async()=>{
  const f=editorFixture();const json=value=>JSON.parse(JSON.stringify(value));const calls=[];
  const control={async command(){},async stop(){},async remove(){},
    async handoff(root,action,reference){calls.push(['handoff',root,action.agentId,action.loopId,action.toModel,action.reason,reference]);return {id:'handoff-1'};},
    async supervise(root){calls.push(['supervise',root]);if(calls.filter(call=>call[0]==='supervise').length>1)throw new Error('supervise failed');return {verdicts:[{verdict:'stuck'}]};},
    async models(){return [{id:'claude-opus-5-5',provider:'claude'}];}};
  const windows=new f.windows.constructor({localResourceRoots:[],async render(){return '<html>Center</html>';}},async()=>[],async()=>{},async()=>undefined,undefined,control);
  await windows.open('/projects/A');const panel=f.panels.at(-1);panel.send({type:'client.ready'});await settle();
  const of=type=>json(panel.messages.filter(value=>value.type===type));
  const action={type:'worker.handoff',agentId:'worker-a',loopId:'loop-a',toModel:'claude-opus-5-5',reason:'limit'};
  f.answer('');
  panel.send(action);for(let i=0;i<6;i++)await settle();
  assert.match(f.prompts.at(-1).text,/Move the current task of worker-a \(loop loop-a\) to a new session on claude-opus-5-5\?/);
  assert.equal(f.prompts.at(-1).options.modal,true);
  assert.deepEqual(of('worker.result').at(-1),{type:'worker.result',action:'worker.handoff',agentId:'worker-a',cancelled:true});assert.equal(calls.length,0);
  f.answer(undefined);
  panel.send(action);for(let i=0;i<6;i++)await settle();
  assert.deepEqual(f.prompts.at(-1).items,['Provider handoff']);
  assert.deepEqual(calls.at(-1).slice(0,6),['handoff','/projects/A','worker-a','loop-a','claude-opus-5-5','limit']);
  assert.match(calls.at(-1)[6],/^control-center:worker-a:loop-a:handoff:\d+$/);
  assert.deepEqual(of('worker.result').at(-1).result,{id:'handoff-1'});
  panel.send({type:'supervision.request'});for(let i=0;i<4;i++)await settle();
  assert.deepEqual(of('supervision.report').at(-1),{type:'supervision.report',report:{verdicts:[{verdict:'stuck'}]}});
  panel.send({type:'supervision.request'});for(let i=0;i<4;i++)await settle();
  assert.deepEqual(of('supervision.report').at(-1),{type:'supervision.report',error:'supervise failed'});
  panel.send({type:'handoff.models.request'});for(let i=0;i<4;i++)await settle();
  assert.deepEqual(of('handoff.models').at(-1),{type:'handoff.models',models:[{id:'claude-opus-5-5',provider:'claude'}]});
  windows.dispose();f.windows.dispose();
});

test('worker display order: saved IDs follow the Human, new workers lead, moves keep one entry per ID', async()=>{
  const context={};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const {maestroArrange:arrange,maestroReorder:reorder}=context.AgentFactoryChat;
  const json=value=>JSON.parse(JSON.stringify(value));
  const workers=['run','twin-a','twin-b','gpt'].map(agentId=>({agentId,model:agentId.startsWith('twin')?'same-model':agentId}));
  const ids=list=>json(list.map(worker=>worker.agentId));
  assert.deepEqual(ids(arrange(workers,[])),['run','twin-a','twin-b','gpt'],'No saved order keeps the usual order');
  assert.deepEqual(ids(arrange(workers,['gpt','twin-b','run','twin-a'])),['gpt','twin-b','run','twin-a']);
  // A worker without a saved place leads; a stale saved ID is skipped; same-model workers stay distinct by ID.
  assert.deepEqual(ids(arrange([...workers,{agentId:'new',model:'same-model'}],['stale','gpt','twin-b','run','twin-a'])),['new','gpt','twin-b','run','twin-a']);
  const group=['run','twin-a','twin-b','gpt'];
  assert.deepEqual(json(reorder(group,[],'gpt','run',false)),['gpt','run','twin-a','twin-b'],'Back to front');
  assert.deepEqual(json(reorder(group,[],'run','twin-a',true)),['twin-a','run','twin-b','gpt'],'Into the middle');
  assert.deepEqual(json(reorder(group,[],'run','gpt',true)),['twin-a','twin-b','gpt','run'],'Front to back');
  assert.equal(reorder(group,[],'twin-a','twin-a',true),undefined,'Dropped on itself');
  assert.equal(reorder(group,[],'twin-a','run',true),undefined,'Dropped into its own place');
  assert.equal(reorder(group,[],'twin-a','elsewhere',true),undefined,'A target outside the group is not a reorder');
  // Other groups' saved IDs are kept after this group; IDs of workers no longer recorded are dropped; no ID repeats.
  const next=json(reorder(group,['other-1','gpt','gone','other-2'],'gpt','run',false,['run','twin-a','twin-b','gpt','other-1','other-2']));
  assert.deepEqual(next,['gpt','run','twin-a','twin-b','other-1','other-2']);
  assert.equal(new Set(next).size,next.length);
});

test('worker order message carries unique agent IDs only', async()=>{
  const {parseClientMessage}=await importTypeScript('src/protocol/validator.ts');
  assert.deepEqual(parseClientMessage({type:'worker.order',order:['work-a','work-b'],extra:true}),{type:'worker.order',order:['work-a','work-b']});
  assert.deepEqual(parseClientMessage({type:'worker.order',order:[]}),{type:'worker.order',order:[]});
  for (const order of [['work-a','work-a'],['../escape'],[1],'work-a',undefined,Array.from({length:10_001},(_,index)=>'work-'+index)]) {
    assert.equal(parseClientMessage({type:'worker.order',order}),undefined,JSON.stringify(order)?.slice(0,40));
  }
});

test('control center saves worker order per project in host storage and restores it on refresh and reopen', async()=>{
  const values=new Map();let fail=false;const writes=[];
  const orderStore={get:key=>values.get(key),async update(key,value){if(fail)throw new Error('Fixture storage failure');await settle();writes.push(value);values.set(key,value);}};
  const {parseClientMessage}=await importTypeScript('src/protocol/validator.ts');
  const json=value=>JSON.parse(JSON.stringify(value));
  const f=editorFixture({orderStore});await f.windows.open('/projects/A');const panel=f.panels[0];panel.send({type:'client.ready'});await settle();await settle();
  const tasks=()=>json(panel.messages.filter(message=>message.type==='project.tasks').at(-1));
  assert.deepEqual(tasks().workerOrder,[],'No saved order yet');
  // Two quick drops are written in order; the last one is kept and returned.
  panel.send(parseClientMessage({type:'worker.order',order:['w-2','w-1']}));
  panel.send(parseClientMessage({type:'worker.order',order:['w-3','w-2','w-1']}));
  for (let index=0;index<6;index++) await settle();
  const results=json(panel.messages.filter(message=>message.type==='worker.order.result'));
  assert.deepEqual(results,[{type:'worker.order.result',order:['w-2','w-1']},{type:'worker.order.result',order:['w-3','w-2','w-1']}]);
  assert.deepEqual(json(values.get('agentFactory.controlCenter.workerOrder')),{'/projects/A':['w-3','w-2','w-1']});
  f.timers[0].callback();await settle();await settle();
  assert.deepEqual(tasks().workerOrder,['w-3','w-2','w-1'],'A periodic refresh carries the saved order');
  // A rejected (malformed) message never reaches storage.
  assert.equal(parseClientMessage({type:'worker.order',order:['w-1','w-1']}),undefined);
  // A failed write returns the kept order with the error.
  fail=true;panel.send({type:'worker.order',order:['w-1']});for (let index=0;index<4;index++) await settle();
  assert.deepEqual(json(panel.messages.at(-1)),{type:'worker.order.result',order:['w-3','w-2','w-1'],error:'Fixture storage failure'});
  fail=false;
  // Closing and reopening the tab restores the order; another project has its own (empty) order.
  panel.dispose();
  await f.windows.open('/projects/A');const reopened=f.panels.at(-1);reopened.send({type:'client.ready'});await settle();await settle();
  assert.deepEqual(json(reopened.messages.find(message=>message.type==='project.tasks').workerOrder),['w-3','w-2','w-1']);
  await f.windows.open('/projects/B');const other=f.panels.at(-1);other.send({type:'client.ready'});await settle();await settle();
  assert.deepEqual(json(other.messages.find(message=>message.type==='project.tasks').workerOrder),[]);
  other.send({type:'worker.order',order:['b-1']});for (let index=0;index<4;index++) await settle();
  assert.deepEqual(json(values.get('agentFactory.controlCenter.workerOrder')),{'/projects/A':['w-3','w-2','w-1'],'/projects/B':['b-1']});
  // Ordering touches no task, run or domain action.
  assert.deepEqual(f.actions,[]);
  f.windows.dispose();
  // Without host storage the tab is told the order cannot be saved.
  const bare=editorFixture();await bare.windows.open('/projects/A');bare.panels[0].send({type:'client.ready'});await settle();
  bare.panels[0].send({type:'worker.order',order:['w-1']});for (let index=0;index<4;index++) await settle();
  assert.match(bare.panels[0].messages.at(-1).error,/unavailable/);assert.deepEqual(json(bare.panels[0].messages.at(-1).order),[]);
  bare.windows.dispose();
});

test('every worker belongs to a real domain: legacy and missing memberships need the Human, recorded names only suggest', async()=>{
  const context={Intl,Date};runInNewContext(await readFile(new URL('../../static/js/chat/maestro.js',import.meta.url),'utf8'),context);
  const membership=context.AgentFactoryChat.maestroMembership;
  const plain=value=>JSON.parse(JSON.stringify(value));
  const registry={revision:3,domains:[{id:'domain-aaaaaaaaaaaa',name:'Extension UI',aliases:['Extension']},{id:'domain-bbbbbbbbbbbb',name:'Docs',aliases:[]},
    {id:'domain-cccccccccccc',name:'미분류',provisional:true,aliases:[]}],
    assignments:{'work-placed':{domainId:'domain-bbbbbbbbbbbb',setBy:{actor:'human'}},'work-null':{domainId:null,setBy:{actor:'human'}},
      'work-gone':{domainId:'domain-ffffffffffff',setBy:{actor:'ai'}},'work-unnamed':{domainId:'domain-cccccccccccc',setBy:{actor:'human'}}}};
  assert.deepEqual(plain(membership(registry,'work-placed','Extension')),{state:'placed',domainId:'domain-bbbbbbbbbbbb',name:'Docs',setBy:{actor:'human'}},'A real membership wins over the record');
  assert.deepEqual(plain(membership(registry,'work-null','Extension')),{state:'required',reason:'legacy-unclassified',suggestion:{domainId:'domain-aaaaaaaaaaaa',name:'Extension UI'}},'Legacy null is not placed; its record only suggests');
  assert.deepEqual(plain(membership(registry,'work-gone')),{state:'required',reason:'missing-domain'},'A domain ID no longer listed is not a membership');
  assert.deepEqual(plain(membership(registry,'work-unnamed','미분류')),{state:'required',reason:'unnamed-domain',unnamedDomainId:'domain-cccccccccccc',suggestion:{name:'미분류'}},'A legacy unnamed domain is not a real one');
  assert.deepEqual(plain(membership(registry,'work-new',' Runtime ')),{state:'required',reason:'missing',suggestion:{name:'Runtime'}},'An unlisted recorded name is offered for creation');
  assert.deepEqual(plain(membership(registry,'work-new')),{state:'required',reason:'missing'});
  assert.deepEqual(plain(membership({revision:0,domains:[],assignments:{}},'work-first')),{state:'required',reason:'missing'},'With no domains yet, nothing is placed');
});
