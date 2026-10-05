import assert from 'node:assert/strict';
import test from 'node:test';
import {createTypeScriptImporter, importTypeScript} from '../support/import-typescript.mjs';

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
  return {store:await load('src/infrastructure/vscode/agent-settings-store.ts'),values,writes,config,global:memory(),workspace:memory()};
}
const supplied={codex:{model:'gpt-saved',reasoningEffort:'high',fast:true},claude:{model:'claude-saved',reasoningEffort:'low'},antigravity:{model:'gemini-saved',reasoningEffort:'high'}};

test('fresh projects choose one detected provider once and retain its complete snapshot across restarts',async()=>{
  for(const [providers,choice,expected] of [
    [{codex:true,claude:false},0,'codex'],
    [{codex:false,claude:true},0,'claude'],
    [{codex:false,claude:false,antigravity:true},0,'antigravity'],
    [{codex:true,claude:true,antigravity:true},0,'codex'],
    [{codex:true,claude:true,antigravity:true},0.4,'claude'],
    [{codex:true,claude:true,antigravity:true},0.99,'antigravity']
  ]) {
    const f=await fixture(); let selections=0;
    const random=()=>{selections++;return choice;};
    await Promise.all([1,2,3].map(()=>f.store.initializeAgentDefaults(f.global,providers,f.workspace,supplied,random)));
    const project=f.store.readAgentDefaults().project;
    for(const role of ['main','work','workLight','verification']) {
      assert.equal(project[role].model,supplied[expected].model);
      assert.equal(project[role].reasoningEffort,supplied[expected].reasoningEffort);
    }
    if(expected==='codex') assert.equal(project.fastByRoleModel.main['gpt-saved'],true);
    const before=f.writes.length;
    await f.store.initializeAgentDefaults(f.global,{codex:true,claude:true},f.workspace,supplied,()=>{throw Error('must not select again');});
    assert.equal(f.writes.length,before); assert.equal(selections,1);
  }
});

test('no detected provider creates an empty durable project default without inventing a model',async()=>{
  const f=await fixture();
  await f.store.initializeAgentDefaults(f.global,{codex:false,claude:false,antigravity:false},f.workspace);
  await f.store.ensureAgentPresets(f.global,f.workspace,'empty-chat',{});
  const snapshot=f.store.readAgentDefaults(f.global,f.workspace,'empty-chat');
  assert.equal(snapshot.project.main.model,undefined);
  assert.ok(snapshot.presets.find(p=>p.scope==='project'&&p.isDefault));
  assert.equal(f.workspace.get('agentFactory.projectAgentDefaults.initialized.v3'),true);
  await f.store.initializeAgentDefaults(f.global,{codex:true,claude:false},f.workspace,supplied);
  assert.equal(f.store.readAgentDefaults().project.main.model,undefined,'Connecting a provider does not silently overwrite an existing empty project');
});

test('failed writes retry the same random snapshot and existing projects are preserved',async()=>{
  const f=await fixture(); let fail=true, selections=0;
  const update=f.config.update;
  f.config.update=async(key,value,target)=>{if(target===3&&key==='work.model'&&fail)throw Error('write failed');await update(key,value,target);};
  const random=()=>{selections++;return 0.99;};
  await assert.rejects(f.store.initializeAgentDefaults(f.global,{codex:true,claude:true},f.workspace,supplied,random),/write failed/);
  assert.equal(f.workspace.get('agentFactory.projectAgentDefaults.initialized.v3'),undefined);
  fail=false;
  await f.store.initializeAgentDefaults(f.global,{codex:true,claude:true},f.workspace,supplied,random);
  assert.equal(selections,1);
  assert.equal(f.store.readAgentDefaults().project.work.model,'claude-saved');
  f.values['main.model'].workspaceFolderValue='chosen-later';
  await f.store.initializeAgentDefaults(f.global,{codex:true,claude:false},f.workspace,supplied);
  assert.equal(f.store.readAgentDefaults().project.main.model,'chosen-later');
});

test('copying a project set into a chat does not apply or mutate project settings',async()=>{
  const f=await fixture();
  await f.store.initializeAgentDefaults(f.global,{codex:true,claude:false},f.workspace,supplied);
  await f.store.ensureAgentPresets(f.global,f.workspace,'chat');
  await f.store.useAgentPreset(f.global,f.workspace,'chat','save','project','Quality');
  await f.store.updateAgentPresetField(f.global,f.workspace,'chat','project','Quality','main','model','gpt-custom');
  const before=f.writes.length;
  const copy=await f.store.useAgentPreset(f.global,f.workspace,'chat','copy','project','Quality');
  assert.equal(copy.main.model,'gpt-custom');
  assert.equal(f.writes.length,before);
  assert.equal(f.store.readAgentDefaults().project.main.model,'gpt-saved');
  copy.main.model='chat-only';copy.fastByRoleModel.main['gpt-saved']=false;
  const source=f.store.readAgentDefaults(f.global,f.workspace,'chat').presets.find(p=>p.name==='Quality');
  assert.equal(source.settings.main.model,'gpt-custom');
  assert.equal(source.settings.fastByRoleModel.main['gpt-saved'],true);
  await f.store.saveAgentDefault('project','main','model','gpt-new-default');
  const next=await f.store.useAgentPreset(f.global,f.workspace,'chat','copy','project','Default');
  assert.equal(next.main.model,'gpt-new-default','The default entry reflects current project settings');
  assert.equal(copy.main.model,'chat-only','An existing copy remains independent');
});

test('provider defaults import saved model, reasoning and Fast with valid provider routing',async()=>{
  const {providerDefaultSettings}=await importTypeScript('src/infrastructure/agent-factory/provider-defaults.ts');
  assert.deepEqual(providerDefaultSettings('codex',{model:'gpt-configured',model_reasoning_effort:'high',service_tier:'fast'}),{model:'gpt-configured',reasoningEffort:'high',fast:true});
  assert.deepEqual(providerDefaultSettings('claude',{model:'sonnet',effortLevel:'low'}),{model:'claude-sonnet',reasoningEffort:'low'});
  assert.deepEqual(providerDefaultSettings('antigravity',{model:'claude-sonnet-5-5',effort:'high'}),{model:'antigravity/claude-sonnet-5-5',reasoningEffort:'high'});
  assert.equal(providerDefaultSettings('codex',{model:'bad\n--model'}).model,'gpt-6-astra');
});

test('existing chat sets remain accessible from project settings without overwriting name collisions',async()=>{
  const f=await fixture();
  await f.workspace.update('agentFactory.agentPresets.chat.v2',{
    oldA:[{name:'Default',isDefault:true,settings:{main:supplied.codex}},{name:'Quality',settings:{main:supplied.codex}}],
    oldB:[{name:'Quality',settings:{main:supplied.claude}}]
  });
  const original=f.workspace.get('agentFactory.agentPresets.chat.v2');
  const update=f.workspace.update;let fail=true;
  f.workspace.update=async(key,value)=>{
    if(key.endsWith('.chatImport.v1')&&fail){fail=false;throw Error('migration marker failed');}
    await update(key,value);
  };
  await assert.rejects(f.store.ensureAgentPresets(f.global,f.workspace),/migration marker failed/);
  await f.store.ensureAgentPresets(f.global,f.workspace);
  const presets=f.store.readAgentDefaults(f.global,f.workspace).presets.filter(p=>p.scope==='project');
  assert.equal(presets.find(p=>p.name==='Quality').settings.main.model,'gpt-saved');
  assert.equal(presets.find(p=>p.name==='Quality (2)').settings.main.model,'claude-saved');
  assert.deepEqual(f.workspace.get('agentFactory.agentPresets.chat.v2'),original);
  await f.store.ensureAgentPresets(f.global,f.workspace);
  assert.equal(f.store.readAgentDefaults(f.global,f.workspace).presets.filter(p=>p.scope==='project').length,3);
});

test('CLI configuration readers use saved profiles and read only detected providers',async()=>{
  const load=createTypeScriptImporter({banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(new URL('../../package.json',import.meta.url).href)});`}});
  const {readProviderDefaults}=await load('src/infrastructure/agent-factory/provider-defaults.ts');
  const paths=[];
  const configured=await readProviderDefaults({codex:true},async path=>{
    paths.push(path);return 'model="gpt-main"\nprofile="work"\n[profiles.work]\nmodel="gpt-profile"\nmodel_reasoning_effort="high"\nservice_tier="fast"';
  });
  assert.equal(paths.length,1);assert.ok(paths[0].endsWith('config.toml'));
  assert.deepEqual(configured,{codex:{model:'gpt-profile',reasoningEffort:'high',fast:true}});
  const absent=await readProviderDefaults({},async()=>{throw Error('No provider config should be read');});
  assert.deepEqual(absent,{});
});
