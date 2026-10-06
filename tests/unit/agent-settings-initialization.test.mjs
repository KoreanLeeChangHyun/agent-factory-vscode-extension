import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
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
  globalThis[fixtureKey]={workspace:{workspaceFolders:[{uri:{fsPath:'/project'}}],getConfiguration:()=>config},ConfigurationTarget:{Global:1,WorkspaceFolder:3},RelativePattern:class {constructor(base,pattern){this.base=base;this.pattern=pattern;}}};
  const load=createTypeScriptImporter({plugins:[{name:'vscode',setup(build){
    build.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports=globalThis.'+fixtureKey,loader:'js'}));
  }}]});
  return {store:await load('src/infrastructure/vscode/agent-settings-store.ts'),Storage:(await load('src/infrastructure/vscode/agent-set-storage.ts')).AgentSetStorage,values,writes,config,global:memory(),workspace:memory(),vscode:globalThis[fixtureKey]};
}

function persistent(t, f, file = path.join(os.tmpdir(), `agent-sets-test-${randomUUID()}.json`)) {
  const storage = new f.Storage(file);
  f.store.bindAgentSetStorage({globalState:f.global}, storage);
  t.after(async()=>{
    for(const name of await fs.readdir(path.dirname(file))) if(name === path.basename(file) || name.startsWith(path.basename(file)+'.')) {
      await fs.rm(path.join(path.dirname(file),name),{force:true});
    }
  });
  return storage;
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
    assert.equal(snapshot(f).presets.length,5);
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

test('deleting an in-use custom set clears every project reference and preserves copied chats across restart',async t=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  const storage=persistent(t,f);
  await f.store.ensureAgentPresets(f.global,f.workspace);
  await act(f,'save','First custom',selected(f).settings);await act(f,'default','First custom');
  const first=selected(f);
  const copied=await act(f,'copy',first.name);
  await f.workspace.update('history',{chat:{settings:copied,messages:['keep this conversation']}});
  await f.global.update('unrelated',{setting:'preserve'});
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/second'}}];
  await f.store.initializeAgentDefaults(f.global,providers,memory(),()=>0.99);
  assert.equal(selected(f).id,'factory-antigravity');assert.equal(snapshot(f).presets.length,6);
  await act(f,'save','Second custom',selected(f).settings);await act(f,'default','Second custom');
  const second=selected(f);
  await act(f,'rename',second.name,undefined,'Shared name');
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/third'}}];
  await f.store.initializeAgentDefaults(f.global,providers,memory(),()=>0);
  await act(f,'default',first.name);
  const before=storage.read();
  await act(f,'delete',first.name);
  assert.equal(snapshot(f).presets.some(set=>set.id===first.id),false);
  const after=storage.read();
  assert.deepEqual(after.projectDefaults,{'/second':second.id});
  assert.deepEqual(after.sets,before.sets.filter(set=>set.id!==first.id));
  assert.deepEqual(after.migratedProjects,before.migratedProjects);
  assert.deepEqual(f.workspace.get('history'),{chat:{settings:copied,messages:['keep this conversation']}});
  assert.deepEqual(f.global.get('unrelated'),{setting:'preserve'});
  assert.deepEqual(f.writes,[]);
  const restarted=await fixture();persistent(t,restarted,storage.file);
  for(const project of ['/project','/third']) {
    restarted.vscode.workspace.workspaceFolders=[{uri:{fsPath:project}}];
    await restarted.store.initializeAgentDefaults(restarted.global,providers,restarted.workspace,()=>{throw Error('must not reselect');});
    assert.equal(snapshot(restarted).defaultSetId,undefined);
    assert.deepEqual(snapshot(restarted).project,{main:{},work:{},workLight:{},verification:{},explore:{},scribe:{}});
    assert.ok(!snapshot(restarted).presets.some(set=>set.id===first.id));
  }
  restarted.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/second'}}];
  assert.equal(selected(restarted).id,second.id);
  assert.equal(selected(restarted).name,'Shared name');
});

test('no provider leaves an explicit unconfigured set and reconnecting never overwrites the choice',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,{codex:false,claude:false},f.workspace);
  assert.equal(selected(f).name,'Unconfigured');assert.equal(selected(f).settings.main.model,undefined);
  assert.equal(snapshot(f).presets.length,6,'Supplied sets remain available for later selection');
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(selected(f).name,'Unconfigured');
  await assert.rejects(act(f,'copy','Unconfigured'),/complete|valid/i);
  await act(f,'default','Codex');assert.equal(selected(f).id,'factory-codex');
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
  assert.equal(choices,1);assert.equal(selected(f).id,'factory-antigravity');assert.equal(snapshot(f).presets.length,5);
});

test('failed designation retains the prior default and serial edits retain each changed field',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  const update=f.global.update;
  f.global.update=async()=>{throw Error('cannot persist');};
  await assert.rejects(act(f,'default','Claude'),/cannot persist/);
  assert.equal(selected(f).id,'factory-codex');f.global.update=update;
  await act(f,'save','Editable',selected(f).settings);await act(f,'default','Editable');
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
  assert.equal(snapshot(f).presets.length,5);assert.deepEqual(snapshot(f).global,{});
  await assert.rejects(act(f,'default','Codex'),/Open a project/);
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


test('all five supplied sets are immutable, with independent editable clones', async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  assert.deepEqual(snapshot(f).presets.map(set=>set.name),['Codex','Claude','Antigravity','Agent Factory','Super Factory']);
  for(const set of snapshot(f).presets){
    assert.equal(set.builtIn,true);
    for(const action of ['rename','delete','update'])await assert.rejects(act(f,action,set.name,{},'New name'),/Built-in/);
    await assert.rejects(field(f,set.name,'main','model','gpt-other'),/Built-in/);
    await assert.rejects(f.store.updateAgentPresetFastMode(f.global,f.workspace,'chat','global',set.name,'main','gpt-6-astra',true),/Built-in/);
  }
  const source=snapshot(f).presets.find(set=>set.name==='Super Factory');
  assert.deepEqual(['main','work','workLight','verification'].map(role=>[source.settings[role].model,source.settings[role].reasoningEffort]),[
    ['gpt-6-astra','high'],['claude-fable-5-1','high'],['gpt-6.1-sol','high'],['gpt-6-astra','high']]);
  await act(f,'save','My Super',source.settings);
  await field(f,'My Super','workLight','model','gpt-custom');
  assert.equal(snapshot(f).presets.find(set=>set.name==='My Super').builtIn,false);
  assert.equal(snapshot(f).presets.find(set=>set.name==='Super Factory').settings.workLight.model,'gpt-6.1-sol');
  await act(f,'save','Second copy',snapshot(f).presets.find(set=>set.name==='My Super').settings);
  await act(f,'delete','My Super');
  assert.equal(snapshot(f).presets.find(set=>set.name==='Second copy').settings.workLight.model,'gpt-custom');
});

test('upgrade preserves customized supplied sets and defaults, restores missing built-ins and merges identical legacy defaults',async()=>{
  const f=await fixture();
  const value={main:{model:'gpt-preserved',reasoningEffort:'high'}};
  await f.global.update('agentFactory.agentSets.v3',{sets:[
    {id:'factory-codex',name:'My old Codex',settings:value},
    {id:'default1',name:'Default',settings:value},
    {id:'default2',name:'Default (2)',settings:value},
    {id:'default3',name:'Default (3)',settings:{main:{model:'gpt-different'}}}
  ],projectDefaults:{'/project':'factory-codex','/second':'default2'},migratedProjects:['/project']});
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>{throw Error('must not reselect');});
  assert.equal(selected(f).settings.main.model,'gpt-preserved');assert.equal(selected(f).builtIn,false);
  assert.equal(snapshot(f).presets.filter(set=>set.builtIn).length,5);
  assert.equal(snapshot(f).presets.some(set=>set.name==='Default (2)'),false);
  assert.equal(snapshot(f).presets.find(set=>set.name==='Default (3)').settings.main.model,'gpt-different');
  assert.equal(f.global.get('agentFactory.agentSets.v3').projectDefaults['/second'],'default1');
  const before=snapshot(f);await f.store.ensureAgentPresets(f.global,f.workspace);assert.deepEqual(snapshot(f),before);
});


test('cloning reads its source after prior edits and never aliases a similarly named custom set',async()=>{
  const f=await fixture();await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','Copy (2)',selected(f).settings);
  await act(f,'save','Copy',selected(f).settings);
  assert.ok(snapshot(f).presets.some(set=>set.name==='Copy'));
  const edit=field(f,'Copy','main','model','gpt-latest');
  const clone=f.store.useAgentPreset(f.global,f.workspace,'chat','save','global','Latest clone',undefined,undefined,'Copy');
  await Promise.all([edit,clone]);
  assert.equal(snapshot(f).presets.find(set=>set.name==='Latest clone').settings.main.model,'gpt-latest');
  await assert.rejects(f.store.useAgentPreset(f.global,f.workspace,'chat','save','global','Invalid clone',undefined,undefined,'Deleted'),/no longer exists/);
  assert.ok(!snapshot(f).presets.some(set=>set.name==='Invalid clone'));
});

test('untouched old supplied sets upgrade in place while retaining the project designation',async()=>{
  const f=await fixture();
  const settings=Object.fromEntries(['main','work','workLight','verification'].map(role=>[role,{model:'gpt-6-astra',reasoningEffort:'medium',fast:false}]));
  await f.global.update('agentFactory.agentSets.v3',{sets:[{id:'factory-codex',name:'Agent Factory · Codex',settings}],projectDefaults:{'/project':'factory-codex'},migratedProjects:['/project']});
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace);
  assert.equal(selected(f).name,'Codex');assert.equal(selected(f).settings.workLight.model,'gpt-6-luna');
  assert.equal(snapshot(f).presets.length,5);
});

test('deleted imported sets stay deleted in new projects, after rename/edit and restart; explicit creation remains available',async t=>{
  const f=await fixture();const storage=persistent(t,f);
  const old={name:'Legacy choice',settings:{main:{model:'gpt-retired',reasoningEffort:'high'}}};
  await f.workspace.update('agentFactory.agentPresets.project.v2',[old]);
  await f.workspace.update('agentFactory.agentPresets.chat.v2',{chat:[old]});
  await f.workspace.update('history',{chat:['keep this conversation']});
  await f.global.update('unrelated',{setting:'preserve'});
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'rename',old.name,undefined,'Renamed legacy');
  await field(f,'Renamed legacy','main','model','gpt-edited');
  const deleted=snapshot(f).presets.find(set=>set.name==='Renamed legacy');
  await act(f,'delete',deleted.name);
  const saved=JSON.parse(await fs.readFile(storage.file,'utf8'));
  assert.ok(!saved.sets.some(set=>set.id===deleted.id));
  assert.ok(!JSON.stringify(saved).includes('gpt-retired'));
  assert.ok(!JSON.stringify(saved).includes('gpt-edited'));
  assert.equal(f.global.get('agentFactory.agentSets.v3'),undefined);
  const restarted=await fixture();persistent(t,restarted,storage.file);
  restarted.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/unmigrated'}}];
  await restarted.workspace.update('agentFactory.agentPresets.project.v2',[{...old,isDefault:true}]);
  await restarted.workspace.update('agentFactory.agentPresets.chat.v2',{other:[old]});
  await restarted.store.initializeAgentDefaults(restarted.global,providers,restarted.workspace,()=>0.4);
  assert.ok(!snapshot(restarted).presets.some(set=>set.settings.main.model==='gpt-retired'));
  assert.equal(selected(restarted).id,'factory-claude');
  await restarted.store.ensureAgentPresets(restarted.global,restarted.workspace);
  assert.deepEqual(f.workspace.get('agentFactory.agentPresets.chat.v2'),{chat:[old]});
  assert.deepEqual(f.workspace.get('history'),{chat:['keep this conversation']});
  assert.deepEqual(f.global.get('unrelated'),{setting:'preserve'});
  assert.equal(storage.read().projectDefaults['/project'],'factory-codex');
  await act(restarted,'save',old.name,old.settings);
  assert.ok(snapshot(restarted).presets.some(set=>set.name===old.name));
});

test('a cached v3 library migrates to shared storage; stale windows cannot restore a deletion or overwrite unrelated edits',async t=>{
  const first=await fixture();
  await first.store.initializeAgentDefaults(first.global,providers,first.workspace,()=>0);
  await act(first,'save','Delete me',selected(first).settings);
  await act(first,'save','Keep me',selected(first).settings);
  const cached=first.global.get('agentFactory.agentSets.v3');
  const storage=persistent(t,first);
  const stale=await fixture();await stale.global.update('agentFactory.agentSets.v3',cached);
  persistent(t,stale,storage.file);
  await first.store.ensureAgentPresets(first.global,first.workspace);
  assert.ok(storage.read().sets.some(set=>set.name==='Delete me'));
  assert.equal(first.global.get('agentFactory.agentSets.v3'),undefined);
  await Promise.all([act(first,'delete','Delete me'),field(stale,'Keep me','main','model','gpt-preserved')]);
  await stale.store.ensureAgentPresets(stale.global,stale.workspace);
  assert.equal(stale.global.get('agentFactory.agentSets.v3'),undefined);
  assert.ok(!snapshot(stale).presets.some(set=>set.name==='Delete me'));
  assert.equal(snapshot(first).presets.find(set=>set.name==='Keep me').settings.main.model,'gpt-preserved');
  await assert.rejects(field(stale,'Delete me','main','model','gpt-resurrected'),/no longer exists/);
  await Promise.all([field(first,'Keep me','work','reasoningEffort','high'),field(stale,'Keep me','verification','reasoningEffort','low')]);
  const kept=storage.read().sets.find(set=>set.name==='Keep me');
  assert.equal(kept.settings.work.reasoningEffort,'high');assert.equal(kept.settings.verification.reasoningEffort,'low');
  assert.deepEqual(storage.read().projectDefaults,cached.projectDefaults);
});

test('failed deletion does not report success or lose the saved set; a retry persists it',async t=>{
  const f=await fixture();const storage=persistent(t,f);
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','Retry delete',selected(f).settings);
  await act(f,'default','Retry delete');
  const before=await fs.readFile(storage.file,'utf8');const write=storage.write;
  storage.write=async()=>{throw Error('disk unavailable');};
  await assert.rejects(act(f,'delete','Retry delete'),/disk unavailable/);
  assert.equal(await fs.readFile(storage.file,'utf8'),before);
  assert.ok(snapshot(f).presets.some(set=>set.name==='Retry delete'));
  assert.equal(selected(f).name,'Retry delete');
  storage.write=write;await act(f,'delete','Retry delete');
  assert.ok(!snapshot(f).presets.some(set=>set.name==='Retry delete'));
  assert.equal(snapshot(f).defaultSetId,undefined);
});

test('shared store serializes separate process writers and recovers an exited owner ticket',async t=>{
  const {spawn}=await import('node:child_process');
  const {build}=await import('esbuild');
  const f=await fixture();const storage=persistent(t,f);
  await storage.transaction(()=>storage.write({count:0}));
  const source=(await build({entryPoints:['src/infrastructure/vscode/agent-set-storage.ts'],bundle:true,format:'esm',platform:'node',write:false})).outputFiles[0].text;
  const moduleUrl='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const script=`const {AgentSetStorage}=await import(${JSON.stringify(moduleUrl)});const s=new AgentSetStorage(${JSON.stringify(storage.file)});for(let i=0;i<12;i++)await s.transaction(async()=>{const v=s.read();await new Promise(r=>setTimeout(r,2));await s.write({count:v.count+1});});`;
  const execute=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script]);let errors='';
    child.stderr.on('data',data=>{errors+=data;});child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(Error(errors||`child exit ${code}`)));
  });
  await Promise.all([execute(),execute(),execute()]);
  assert.equal(storage.read().count,36);
  const dead=spawn(process.execPath,['-e','']);await new Promise(resolve=>dead.on('exit',resolve));
  await fs.writeFile(`${storage.file}.lock.${dead.pid}.${randomUUID()}`,'1');
  await storage.transaction(()=>storage.write({count:37}));
  assert.equal(storage.read().count,37);
});

test('existing suffixed v3 imports retain their source identity through editing and deletion',async t=>{
  const f=await fixture();const old={name:'Old name',settings:{main:{model:'gpt-original'}}};
  await f.workspace.update('agentFactory.agentPresets.chat.v2',{chat:[old]});
  await f.global.update('agentFactory.agentSets.v3',{factoryVersion:1,sets:[{id:'old-id',name:'Old name (2)',settings:old.settings}],projectDefaults:{},migratedProjects:['/project']});
  const storage=persistent(t,f);
  await f.store.ensureAgentPresets(f.global,f.workspace);
  await act(f,'rename','Old name (2)',undefined,'Changed name');
  await field(f,'Changed name','main','model','gpt-changed');
  await act(f,'delete','Changed name');
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/another-project'}}];
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  assert.ok(!snapshot(f).presets.some(set=>set.settings.main.model==='gpt-original'));
  assert.ok(!storage.read().sets.some(set=>set.id==='old-id'));
});

test('retrying failed initialization rebases on another window deletion and preserves different legacy settings',async t=>{
  const f=await fixture();const storage=persistent(t,f);
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','Old choice',selected(f).settings);
  const old=snapshot(f).presets.find(set=>set.name==='Old choice');
  const other=await fixture();persistent(t,other,storage.file);
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/pending-project'}}];
  await f.workspace.update('agentFactory.agentPresets.chat.v2',{chat:[old]});
  const write=storage.write;storage.write=async()=>{throw Error('initialization failed');};
  await assert.rejects(f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0),/initialization failed/);
  await act(other,'delete','Old choice');
  storage.write=write;
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  assert.ok(!snapshot(f).presets.some(set=>set.name==='Old choice'));
  f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/different-source'}}];
  await f.workspace.update('agentFactory.agentPresets.chat.v2',{chat:[{name:'Old choice',settings:{main:{model:'gpt-different'}}}]});
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  assert.equal(snapshot(f).presets.find(set=>set.name==='Old choice').settings.main.model,'gpt-different');
});

test('storage events refresh snapshots across windows and dispose every listener',async t=>{
  const f=await fixture();const storage=persistent(t,f);
  await f.store.initializeAgentDefaults(f.global,providers,f.workspace,()=>0);
  await act(f,'save','External deletion',selected(f).settings);
  const other=await fixture();persistent(t,other,storage.file);
  const handlers=new Map();let disposed=0,latest;
  other.vscode.workspace.createFileSystemWatcher=pattern=>{
    assert.equal(pattern.pattern,'agent-sets-v3.json');
    const register=event=>callback=>{handlers.set(event,callback);return {dispose:()=>handlers.delete(event)};};
    return {onDidCreate:register('create'),onDidChange:register('change'),onDidDelete:register('delete'),dispose:()=>{disposed++;}};
  };
  const listener=other.store.watchAgentSets({globalState:other.global,globalStorageUri:{fsPath:path.dirname(storage.file)}},()=>{latest=snapshot(other);});
  await act(f,'delete','External deletion');
  for(const event of ['create','change','delete']) {
    handlers.get(event)();assert.ok(!latest.presets.some(set=>set.name==='External deletion'));
  }
  listener.dispose();assert.equal(handlers.size,0);assert.equal(disposed,1);
  await fs.writeFile(storage.file,'null');
  await assert.rejects(other.store.ensureAgentPresets(other.global,other.workspace),/Invalid agent set storage/);
  assert.equal(await fs.readFile(storage.file,'utf8'),'null','Corrupt storage must never be replaced with a stale cached library');
});
