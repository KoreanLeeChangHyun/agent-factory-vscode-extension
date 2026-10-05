import assert from 'node:assert/strict';
import test from 'node:test';
import {createTypeScriptImporter} from '../support/import-typescript.mjs';

const memory = () => {
  const data = new Map();
  return {data, get:(key,fallback)=>data.has(key)?structuredClone(data.get(key)):fallback,
    update:async(key,value)=>{if(value===undefined)data.delete(key);else data.set(key,structuredClone(value));}};
};
let fixtureId=0;
async function fixture() {
  const values={}, writes=[];
  const config={inspect:key=>values[key],update:async(key,value,target)=>{
    writes.push([key,structuredClone(value),target]);
    values[key]={...values[key],[target===1?'globalValue':'workspaceFolderValue']:structuredClone(value)};
  }};
  const fixtureKey='__initConfig'+(++fixtureId);
  globalThis[fixtureKey]={workspace:{workspaceFolders:[{uri:{fsPath:'/project'}}],getConfiguration:()=>config},ConfigurationTarget:{Global:1,WorkspaceFolder:3}};
  const load=createTypeScriptImporter({plugins:[{name:'vscode',setup(build){
    build.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports=globalThis.'+fixtureKey,loader:'js'}));
  }}]});
  return {store:await load('src/infrastructure/vscode/agent-settings-store.ts'),values,writes,config,global:memory(),workspace:memory(),vscode:globalThis[fixtureKey]};
}

const providers={codex:true,claude:true,antigravity:true};
const snapshot=f=>f.store.readAgentDefaults(f.global,f.workspace);
const selected=f=>snapshot(f).presets.find(set=>set.id===snapshot(f).defaultSetId);
const act=(f,action,name,settings,newName)=>f.store.useAgentPreset(f.global,f.workspace,'chat',action,'global',name,settings,newName);
const field=(f,name,role,key,value)=>f.store.updateAgentPresetField(f.global,f.workspace,'chat','global',name,role,key,value);

test('supplied sets are available once; detection selects the project default without writing VS Code scopes',async()=>{
  for(const [detected,choice,id] of [
    [{codex:true,claude:false},0,'codex'], [{codex:false,claude:true},0,'claude'],
    [{codex:false,claude:false,antigravity:true},0,'antigravity'],
    [providers,0,'codex'],[providers,0.4,'claude'],[providers,0.99,'antigravity']
  ]) {
    const f=await fixture();let choices=0;
    await Promise.all([1,2,3].map(()=>f.store.initializeAgentDefaults(f.global,detected,f.workspace,()=>{choices++;return choice;})));
    assert.equal(snapshot(f).presets.length,3);
    assert.equal(selected(f).id,'factory-'+id);
    assert.equal(choices,1);assert.deepEqual(f.writes,[]);
    for(const set of snapshot(f).presets) for(const role of ['main','work','workLight','verification']) {
      assert.ok(set.settings[role].model);assert.ok(set.settings[role].reasoningEffort);
    }
    await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>{throw Error('must not reselect');});
    assert.equal(selected(f).id,'factory-'+id);
    assert.deepEqual(snapshot(f).global,{});
  }
});

test('default designation uses stable set identity; renaming and editing it affect only future copies',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','Quality',selected(f).settings);
  const before=await act(f,'copy',selected(f).name);
  await act(f,'default','Quality');
  const id=selected(f).id;
  await act(f,'rename','Quality',undefined,'Renamed');
  assert.equal(selected(f).id,id);assert.equal(selected(f).name,'Renamed');
  await field(f,'Renamed','main','model','gpt-custom');
  await f.store.updateAgentPresetFastMode(f.global,f.workspace,'chat','global','Renamed','main','gpt-custom',true);
  const next=await act(f,'copy','Renamed');
  assert.equal(next.main.model,'gpt-custom');assert.equal(next.fastByRoleModel.main['gpt-custom'],true);
  assert.equal(before.main.model,'gpt-6-astra');
  next.main.model='chat-only';next.fastByRoleModel.main['gpt-custom']=false;
  assert.equal(selected(f).settings.main.model,'gpt-custom');assert.equal(selected(f).settings.fastByRoleModel.main['gpt-custom'],true);
  assert.deepEqual(f.writes,[]);
});

test('projects share one library and keep separate default set references, including deletion protection',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  const first=selected(f);
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/second'}}];
  await f.store.initializeAgentDefaults(f.global,providers,memory(),()=>0.99);
  assert.equal(selected(f).id,'factory-antigravity');assert.equal(snapshot(f).presets.length,3);
  await assert.rejects(act(f,'delete',first.name),/cannot be deleted/);
  const second=selected(f);
  await act(f,'rename',second.name,undefined,'Shared name');
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/project'}}];
  assert.equal(selected(f).id,first.id);
  assert.equal(snapshot(f).presets.find(set=>set.id===second.id).name,'Shared name');
  await act(f,'default','Shared name');
  await act(f,'delete',first.name);
  assert.equal(snapshot(f).presets.some(set=>set.id===first.id),false);
});

test('no provider leaves an explicit unconfigured set and reconnecting never overwrites the choice',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,{codex:false,claude:false},f.workspace);
  assert.equal(selected(f).name,'Unconfigured');assert.equal(selected(f).settings.main.model,undefined);
  assert.equal(snapshot(f).presets.length,4,'Supplied sets remain available for later selection');
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(selected(f).name,'Unconfigured');
  await assert.rejects(act(f,'copy','Unconfigured'),/complete|valid/i);
  await act(f,'default','Agent Factory · Codex');assert.equal(selected(f).id,'factory-codex');
});

test('legacy global, project and chat values migrate without data loss or repeat imports',async()=>{
  const f=await fixture();
  f.values['main.model']={globalValue:'gpt-old',workspaceFolderValue:'claude-old'};
  f.values['main.reasoningEffort']={globalValue:'high'};
  f.values['work.model']={globalValue:'gpt-worker'};
  f.values.fastByRoleModel={globalValue:{main:{'gpt-old':true}},workspaceFolderValue:{main:{'claude-old':false}}};
  const original={old:[{name:'Quality',settings:{main:{model:'gpt-chat',reasoningEffort:'low'}}}]};
  await f.workspace.update('agentFactory.agentPresets.chat.v2',original);
  await f.global.update('agentFactory.agentPresets.global.v2',[{name:'Quality',settings:{main:{model:'gpt-global',reasoningEffort:'high'}}}]);
  await f.workspace.update('agentFactory.agentPresets.project.v2',[{name:'Quality',settings:{main:{model:'gpt-project',reasoningEffort:'medium'}}}]);
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(selected(f).settings.main.model,'claude-old');assert.equal(selected(f).settings.main.reasoningEffort,'high');
  assert.equal(selected(f).settings.work.model,'gpt-worker');assert.equal(selected(f).settings.fastByRoleModel.main['claude-old'],false);
  const sets=snapshot(f).presets;
  for(const model of ['gpt-old','gpt-global','gpt-project','gpt-chat'])assert.ok(sets.some(set=>set.settings.main.model===model));
  assert.equal(new Set(sets.map(set=>set.name)).size,sets.length);
  assert.deepEqual(f.workspace.get('agentFactory.agentPresets.chat.v2'),original);
  f.values['main.model'].workspaceFolderValue='ignored-after-migration';
  await f.store.ensureAgentPresets(f.global,f.workspace);
  assert.deepEqual(snapshot(f).presets,sets);assert.deepEqual(f.writes,[]);
});

test('an explicit empty canonical Fast map suppresses old model-wide Fast during migration',async()=>{
  const f=await fixture();f.values['main.model']={workspaceFolderValue:'gpt-old'};
  f.values['main.fast']={workspaceFolderValue:true};f.values.fastByModel={workspaceFolderValue:{'gpt-old':true}};
  f.values.fastByRoleModel={workspaceFolderValue:{}};
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(selected(f).settings.main.fast,undefined);assert.equal(selected(f).settings.fastByRoleModel,undefined);
});

test('failed atomic initialization retries the original provider choice without duplicating migrations',async()=>{
  const f=await fixture();const update=f.global.update;let fail=true,choices=0;
  f.global.update=async(key,value)=>{if(fail&&key==='agentFactory.agentSets.v3')throw Error('storage unavailable');await update(key,value);};
  const choose=()=>{choices++;return 0.99;};
  await assert.rejects(f.store.initializeAgentDefaults(f.global,providers,f.workspace,choose),/storage unavailable/);
  assert.equal(snapshot(f).presets.length,0);
  fail=false;await f.store.initializeAgentDefaults(f.global,providers,f.workspace,choose);
  assert.equal(choices,1);assert.equal(selected(f).id,'factory-antigravity');assert.equal(snapshot(f).presets.length,3);
});

test('failed designation retains the prior default and serial edits retain each changed field',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  const update=f.global.update;
  f.global.update=async()=>{throw Error('cannot persist');};
  await assert.rejects(act(f,'default','Agent Factory · Claude'),/cannot persist/);
  assert.equal(selected(f).id,'factory-codex');f.global.update=update;
  const name=selected(f).name;
  await Promise.all([field(f,name,'main','model','gpt-edited'),field(f,name,'work','reasoningEffort','high')]);
  assert.equal(selected(f).settings.main.model,'gpt-edited');assert.equal(selected(f).settings.work.reasoningEffort,'high');
});

test('library CRUD validates duplicates, missing sets and fields without introducing another settings layer',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','Copy',selected(f).settings);
  await assert.rejects(act(f,'save',' Copy ',{}),/already exists/);
  await assert.rejects(act(f,'rename','Copy',undefined,' '),/name is required/i);
  await assert.rejects(act(f,'rename','Copy',undefined,selected(f).name),/already exists/);
  await assert.rejects(act(f,'copy','Missing'),/no longer exists/);
  await assert.rejects(field(f,'Copy','other','model','gpt-x'),/complete|valid/i);
  await assert.rejects(field(f,'Copy','main','model','bad\nmodel'),/complete|valid/i);
  await act(f,'delete','Copy');assert.ok(!snapshot(f).presets.some(set=>set.name==='Copy'));
});

test('a window without a project has the set library but no global default',async()=>{
  const f=await fixture();f.vscode.workspace.workspaceFolders=[];
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(snapshot(f).projectAvailable,false);assert.equal(snapshot(f).defaultSetId,undefined);
  assert.equal(snapshot(f).presets.length,3);assert.deepEqual(snapshot(f).global,{});
  await assert.rejects(act(f,'default','Agent Factory · Codex'),/Open a project/);
});


test('legacy globals are retained as sets but never become a settings layer for later new projects',async()=>{
  const f=await fixture();f.values['main.model']={globalValue:'gpt-legacy'};
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  assert.equal(selected(f).settings.main.model,'gpt-legacy');
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/new-project'}}];
  await f.store.initializeAgentDefaults(f.global,providers,memory(),()=>0.4);
  assert.equal(selected(f).id,'factory-claude');
  assert.ok(snapshot(f).presets.some(set=>set.settings.main.model==='gpt-legacy'));
});
