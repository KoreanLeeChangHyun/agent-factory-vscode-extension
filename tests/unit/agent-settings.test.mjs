import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
async function load(path) {
  const result = await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { mergeAgentSettings } = await load('src/core/config/agent-settings.ts');
const { parseClientMessage } = await load('src/protocol/validator.ts');
const source = readFileSync('static/js/chat.js','utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('per-field inheritance preserves siblings and reset reveals parent',()=>{
  const global={main:{model:'global-main',reasoningEffort:'high'},work:{model:'global-work'}};
  const project={main:{model:'project-main'}};
  assert.deepEqual(mergeAgentSettings(global,project,{main:{reasoningEffort:'low'}}).main,{model:'project-main',reasoningEffort:'low'});
  assert.deepEqual(mergeAgentSettings(global,project,{main:{}}).main,{model:'project-main',reasoningEffort:'high'});
  assert.equal(mergeAgentSettings(global,project).work.model,'global-work');
  assert.equal(global.main.model,'global-main');
});
test('scope writes reject unknown roles, fields, unsafe models and effort',()=>{
  const good={type:'agent.defaults.save',scope:'project',role:'work',field:'model',value:'claude-sonnet'};
  assert.deepEqual(parseClientMessage(good),good);
  assert.equal(parseClientMessage({...good,value:''}).value,'');
  for(const change of [{scope:'chat'},{role:'other'},{field:'permissions'},{value:'bad\n--flag'},{field:'reasoningEffort',value:'extreme'}]) assert.equal(parseClientMessage({...good,...change}),undefined);
});
test('chat stores overrides only; submission snapshots inherited child settings',()=>{
  const sent=[];
  const ctx={state:{role:'main',model:'',reasoning:'',agentModels:{work:{reasoningEffort:'low'}},agentDefaults:{effective:{main:{model:'project-main'},work:{model:'global-work',reasoningEffort:'high'},verification:{model:'review'}}}},vscode:{postMessage:m=>sent.push(m)}};
  runInNewContext(section('  function inheritedAgentRole(', '  function renderAgentDefaults(')+section('  function saveComposerSettings()', '  function contextStatusLabel('),ctx);
  const run=s=>runInNewContext(s,ctx);
  assert.equal(run('effectiveAgentValue("main","model")'),'project-main');
  run('saveComposerSettings()'); assert.equal(sent[0].model,undefined);
  const captured=run('effectiveDelegatedModels()');
  ctx.state.agentDefaults.effective.work.model='changed';
  assert.equal(captured.work.model,'global-work'); assert.equal(captured.work.reasoningEffort,'low');
  assert.equal(run('effectiveDelegatedModels().work.model'),'changed');
  ctx.state.role='verification'; assert.equal(run('effectiveAgentValue("main","model")'),'review');
});
test('VS Code scopes are declared as independent resource settings',()=>{
  const props=JSON.parse(readFileSync('package.json','utf8')).contributes.configuration.properties;
  for(const role of ['main','work','verification'])for(const field of ['model','reasoningEffort']){
    const value=props[`agentFactory.agents.${role}.${field}`];assert.equal(value.scope,'resource');assert.equal(value.default,'');
  }
});

test('store reads each scope separately and writes only the selected scope', async()=>{
  const entries = { 'main.model': {globalValue:'global',workspaceValue:'workspace',workspaceFolderValue:'project'}, 'main.reasoningEffort':{globalValue:'high'}, 'work.model':{globalValue:'worker'} };
  const writes=[];
  globalThis.__agentConfigFixture = { workspace:{workspaceFolders:[{uri:{fsPath:'/project'}}],getConfiguration:()=>({inspect:key=>entries[key],update:async(...args)=>writes.push(args)})},ConfigurationTarget:{Global:1,WorkspaceFolder:3} };
  const result=await build({entryPoints:['src/infrastructure/vscode/agent-settings-store.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'mock-vscode',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'module.exports = globalThis.__agentConfigFixture;',loader:'js'}));}}]});
  const store=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  assert.equal(store.readAgentDefaults().effective.main.model,'project');
  assert.equal(store.readAgentDefaults().effective.main.reasoningEffort,'high');
  assert.equal(store.readAgentDefaults().sources.main.reasoningEffort,'global');
  await store.saveAgentDefault('global','work','model','new-worker');
  await store.saveAgentDefault('project','main','model','');
  assert.deepEqual(writes,[['work.model','new-worker',1],['main.model',undefined,3]]);
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[];
  await assert.rejects(store.saveAgentDefault('project','main','model','oops'),/Open a project/);
  for (const [providers, expected] of [
    [{codex:true,claude:false}, 'gpt-6-astra'],
    [{codex:false,claude:true}, 'claude-opus-5-5'],
    [{codex:true,claude:true}, 'gpt-6-astra'],
    [{codex:false,claude:false}, undefined]
  ]) {
    const saved = new Map();
    const state = {get:key=>saved.get(key), update:async(key,value)=>saved.set(key,value)};
    const values = {'main.model':{globalValue:'existing-model'},'work.model':{workspaceValue:'project-model'}};
    const seeded=[];
    globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({
      inspect:key=>values[key],update:async(key,value,target)=>{seeded.push([key,value,target]);values[key]={...values[key],globalValue:value};}
    });
    await store.initializeAgentDefaults(state,providers);
    assert.deepEqual(seeded,expected ? [['work.model',expected,1],['verification.model',expected,1]] : []);
    if (expected) {
      values['work.model']={}; // A later reset must not trigger reseeding.
      await store.initializeAgentDefaults(state,providers);
      assert.equal(seeded.length,2);
    } else assert.equal(saved.size,0);
  }
  const explicitEmpty=[];
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({inspect:()=>({globalValue:''}),update:async(...args)=>explicitEmpty.push(args)});
  await store.initializeAgentDefaults({get:()=>false,update:async()=>{}},{codex:true,claude:false});
  assert.deepEqual(explicitEmpty,[],'Explicit inheritance is preserved');
  const partial={}, completed=new Map(); let fail=true;
  const state={get:key=>completed.get(key),update:async(key,value)=>completed.set(key,value)};
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({
    inspect:key=>partial[key],update:async(key,value)=>{
      if(key==='work.model' && fail) throw new Error('write failed');
      partial[key]={globalValue:value};
    }
  });
  await assert.rejects(store.initializeAgentDefaults(state,{codex:true,claude:false}),/write failed/);
  assert.equal(completed.size,0,'Failed initialization remains retryable');
  partial['main.model']={globalValue:'chosen-after-failure'};fail=false;
  await store.initializeAgentDefaults(state,{codex:true,claude:false});
  assert.equal(partial['main.model'].globalValue,'chosen-after-failure');
  assert.equal(partial['verification.model'].globalValue,'gpt-6-astra');
  assert.equal(completed.size,1);
  const presetData=new Map();
  const memory={get:(key,fallback)=>presetData.has(key)?structuredClone(presetData.get(key)):fallback,update:async(key,value)=>presetData.set(key,structuredClone(value))};
  const presetValues={'main.model':{globalValue:'gpt-6-astra',workspaceValue:'workspace-default'},'main.reasoningEffort':{globalValue:'high'},'work.model':{globalValue:'claude-opus-5-5'}};
  const presetWrites=[];
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[{uri:{fsPath:'/project'}}];
  let failureKey;
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({inspect:key=>presetValues[key],update:async(key,value,target)=>{
    if(key===failureKey){failureKey=undefined;throw new Error('preset write failed');}
    presetWrites.push([key,value,target]);presetValues[key]={...presetValues[key],[target===1?'globalValue':'workspaceFolderValue']:value};
  }});
  await store.useAgentPreset(memory,'save','global','Quality');
  assert.equal(store.readAgentDefaults(memory).presets[0].settings.main.model,'gpt-6-astra');
  await assert.rejects(store.useAgentPreset(memory,'save','global','Quality'),/already exists/);
  presetValues['main.model'].globalValue='changed-after-save';
  presetValues['verification.model']={workspaceFolderValue:'stale'};
  await store.useAgentPreset(memory,'apply','project','Quality');
  assert.equal(presetWrites.length,6);
  assert.equal(presetValues['main.model'].workspaceFolderValue,'gpt-6-astra');
  assert.equal(presetValues['main.model'].globalValue,'changed-after-save');
  assert.equal(presetValues['verification.model'].workspaceFolderValue,undefined,'Unset values restore inheritance');
  const snapshot=structuredClone(presetValues);
  failureKey='work.model';
  await assert.rejects(store.useAgentPreset(memory,'apply','global','Quality'),/preset write failed/);
  assert.deepEqual(presetValues,snapshot,'Partial application restores the exact target layer');
  await assert.rejects(store.useAgentPreset(memory,'apply','global','missing'),/no longer exists/);
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[];
  await assert.rejects(store.useAgentPreset(memory,'apply','project','Quality'),/Open a project/);
  delete globalThis.__agentConfigFixture;
});

test('preset messages validate scope, action and names',()=>{
  const good={type:'agent.preset',action:'save',scope:'global',name:'Quality'};
  assert.deepEqual(parseClientMessage(good),good);
  for(const change of [{action:'remove'},{scope:'chat'},{name:''},{name:'   '},{name:4}])assert.equal(parseClientMessage({...good,...change}),undefined);
});
