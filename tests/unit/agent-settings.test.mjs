import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { readChatSourceSync, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";
async function load(path) {
  const result = await build({entryPoints:[path],bundle:true,format:'esm',platform:'node',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { mergeAgentSettings } = await load('src/core/config/agent-settings.ts');
const { parseClientMessage } = await load('src/protocol/validator.ts');
const source = readChatSourceSync();
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('setting snapshots are copied without mutating their source',()=>{
  const project={main:{model:'project-main',reasoningEffort:'high',fast:true},work:{model:'project-work',reasoningEffort:'medium',fast:false}};
  const chat=structuredClone(project);
  chat.main.model='chat-main';
  assert.equal(project.main.model,'project-main');
  assert.equal(chat.main.model,'chat-main');
  assert.deepEqual(mergeAgentSettings(chat).main,chat.main);
  assert.deepEqual(mergeAgentSettings(chat).work,chat.work);
});
test('scope writes reject unknown roles, fields, unsafe models and effort',()=>{
  const good={type:'agent.defaults.save',scope:'project',role:'work',field:'model',value:'claude-sonnet'};
  assert.deepEqual(parseClientMessage(good),good);
  assert.deepEqual(parseClientMessage({...good,role:'workLight'}),{...good,role:'workLight'});
  assert.deepEqual(parseClientMessage({...good,field:'fast',value:true}),{...good,field:'fast',value:true});
  assert.deepEqual(parseClientMessage({type:'agent.defaults.fast',scope:'project',model:'gpt-6-astra',value:true}),{type:'agent.defaults.fast',scope:'project',model:'gpt-6-astra',value:true});
  assert.deepEqual(parseClientMessage({type:'agent.preset.fast',scope:'chat',name:'Default',model:'gpt-6-astra',value:false}),{type:'agent.preset.fast',scope:'chat',name:'Default',model:'gpt-6-astra',value:false});
  assert.equal(parseClientMessage({type:'agent.defaults.fast',scope:'chat',model:'gpt-6-astra',value:true}),undefined);
  assert.equal(parseClientMessage({type:'agent.preset.fast',scope:'chat',name:'Default',model:'bad\nmodel',value:true}),undefined);
  assert.equal(parseClientMessage({...good,field:'fast',value:'true'}),undefined);
  assert.equal(parseClientMessage({...good,value:''}),undefined);
  for(const change of [{scope:'chat'},{role:'other'},{field:'permissions'},{value:'bad\n--flag'},{field:'reasoningEffort',value:'extreme'}]) assert.equal(parseClientMessage({...good,...change}),undefined);
});
test('chat uses only its copied settings after defaults change',()=>{
  const sent=[];
  const ctx={state:{role:'main',model:'chat-main',reasoning:'high',fastMode:true,agentModels:{work:{model:'gpt-project-work',reasoningEffort:'low',fast:true},verification:{model:'claude-review',reasoningEffort:'medium',fast:true}},agentDefaults:{project:{work:{model:'changed'}}}},vscode:{postMessage:m=>sent.push(m)}};
  runInNewContext(section('  function normalizeModelFastModes(', '  function normalizeModel(')+section('  function agentSettingRole(', '  function renderAgentDefaults(')+section('  function saveComposerSettings()', '  function contextStatusLabel('),ctx);
  const run=s=>runInNewContext(s,ctx);
  assert.equal(run('effectiveAgentValue("main","model")'),'chat-main');
  run('saveComposerSettings()'); assert.equal(sent[0].model,'chat-main');
  const captured=run('effectiveDelegatedModels()');
  ctx.state.agentDefaults.project.work.model='changed-again';
  assert.equal(captured.work.model,'gpt-project-work'); assert.equal(captured.work.reasoningEffort,'low'); assert.equal(captured.work.fast,true);
  assert.equal(captured.verification.fast,undefined,'Fast is not sent to a non-Codex provider');
  assert.equal(run('effectiveDelegatedModels().work.model'),'gpt-project-work');
  ctx.state.role='verification'; ctx.state.model='review'; assert.equal(run('effectiveAgentValue("main","model")'),'review');
});
test('active chat settings allow same-CLI changes and distinguish route from capability failures',()=>{
  const status={hidden:true,textContent:''}, scope={value:''};
  const ctx={
    state:{role:'main',agentId:'main-test',model:'claude-opus-5-5',reasoning:'medium',modelFastModes:{'gpt-old':true},timeline:[{type:'user'}]},
    settingOptions:{model:['claude-opus-5-5','claude-fable-5-1','gpt-6-astra']},
    capabilities:{model:true,reasoning:true,sessionProvider:'claude'},
    t:key=>key,
    document:{getElementById:id=>id==='agent-preset-status'?status:id==='agent-default-scope'?scope:null},
    persist(){},saveComposerSettings(){},updateModeControls(){}
  };
  ctx.currentCapabilities=()=>ctx.capabilities;
  runInNewContext(section('  function normalizeModelFastModes(', '  function normalizeModel(')+section('  const MODEL_VENDORS =', '  function renderAgentDefaults('),ctx);
  const run=expression=>runInNewContext(expression,ctx);
  const sameCli={main:{model:'claude-fable-5-1',reasoningEffort:'high'}};
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify(sameCli)})`),'');
  assert.equal(run(`applyAgentSettingsToChat(${JSON.stringify(sameCli)},'chat','Default')`),true);
  assert.equal(ctx.state.model,'claude-fable-5-1');
  assert.equal(ctx.state.reasoning,'high');
  assert.equal(Object.keys(ctx.state.modelFastModes).length,0,'Applying a set without model Fast values must not inherit another scope\'s map');
  ctx.state.model='claude-opus-5-5';ctx.state.reasoning='medium';
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify({main:{model:'gpt-6-astra',reasoningEffort:'high'}})})`),'ui.model.route.new.chat');
  ctx.capabilities={model:false,reasoning:true,sessionProvider:'claude'};
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify(sameCli)})`),'ui.model.change.unavailable.active.chat');
  ctx.capabilities={model:true,reasoning:false,sessionProvider:'claude'};
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify({main:{model:'claude-opus-5-5',reasoningEffort:'high'}})})`),'ui.reasoning.change.unavailable.active.chat');
  for(const [provider,current,next] of [['codex','gpt-6-astra','gpt-6-sol'],['antigravity','antigravity/gemini-3-pro','gemini-3-flash']]){
    ctx.state.model=current;ctx.state.reasoning='medium';ctx.capabilities={model:true,reasoning:true,sessionProvider:provider};
    assert.equal(run(`agentSettingsApplyError(${JSON.stringify({main:{model:next,reasoningEffort:'high'}})})`),'',provider);
  }
  assert.match(readFileSync('static/js/localization.js','utf8'),/current CLI cannot change the model[\s\S]*현재 CLI는 진행 중인 대화에서 모델을 변경할 수 없습니다/);
});
test('VS Code scopes are declared as independent resource settings',()=>{
  const props=JSON.parse(readFileSync('package.json','utf8')).contributes.configuration.properties;
  for(const role of ['main','work','workLight','verification'])for(const field of ['model','reasoningEffort']){
    const value=props[`agentFactory.agents.${role}.${field}`];assert.equal(value.scope,'resource');
    if(field==='reasoningEffort') assert.equal(value.default,role==='workLight'?'low':'medium');
  }
  assert.equal(props['agentFactory.agents.fastByModel'].scope,'resource');
  assert.deepEqual(props['agentFactory.agents.fastByModel'].default,{});
  for(const role of ['main','work','workLight','verification']) assert.equal(props[`agentFactory.agents.${role}.fast`],undefined);
});

test('store reads each scope separately and writes only the selected scope', async()=>{
  const entries = { 'main.model': {globalValue:'global',workspaceValue:'workspace',workspaceFolderValue:'project'}, 'main.reasoningEffort':{globalValue:'high'}, 'work.model':{globalValue:'worker'} };
  const writes=[];
  globalThis.__agentConfigFixture = { workspace:{workspaceFolders:[{uri:{fsPath:'/project'}}],getConfiguration:()=>({inspect:key=>entries[key],update:async(...args)=>writes.push(args)})},ConfigurationTarget:{Global:1,WorkspaceFolder:3} };
  const result=await build({entryPoints:['src/infrastructure/vscode/agent-settings-store.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'mock-vscode',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'module.exports = globalThis.__agentConfigFixture;',loader:'js'}));}}]});
  const store=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  assert.equal(store.readAgentDefaults().project.main.model,'project');
  assert.equal(store.readAgentDefaults().global.main.reasoningEffort,'high');
  await store.saveAgentDefault('global','work','model','new-worker');
  await store.saveAgentDefault('project','main','model','project-new');
  await store.saveModelFastMode('project','gpt-6-astra',true);
  assert.deepEqual(writes,[['work.model','new-worker',1],['main.model','project-new',3],['fastByModel',{'gpt-6-astra':true},3]]);
  await assert.rejects(store.saveAgentDefault('project','main','model',''),/Invalid agent setting/);
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
    assert.deepEqual(seeded,expected ? [
      ['main.reasoningEffort','medium',1],['work.model',expected,1],['work.reasoningEffort','medium',1],
      ['verification.model',expected,1],['verification.reasoningEffort','medium',1]
    ] : [['main.reasoningEffort','medium',1],['work.reasoningEffort','medium',1],['verification.reasoningEffort','medium',1]]);
    if (expected) {
      values['work.model']={}; // A later edit must not trigger reseeding.
      await store.initializeAgentDefaults(state,providers);
      assert.equal(seeded.length,5);
    } else assert.equal(saved.size,0);
  }
  const explicitEmpty=[];
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({inspect:()=>({globalValue:''}),update:async(...args)=>explicitEmpty.push(args)});
  await store.initializeAgentDefaults({get:()=>false,update:async()=>{}},{codex:true,claude:false});
  assert.equal(explicitEmpty.length,6,'Empty legacy model and reasoning values are replaced without creating role Fast settings');
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
  const copied={};
  for(const role of ['main','work','verification']){
    copied[`${role}.model`]={globalValue:`${role}-global`};
    copied[`${role}.reasoningEffort`]={globalValue:'medium'};
    copied[`${role}.fast`]={globalValue:role==='work'};
  }
  const projectWrites=[], projectState=new Map();
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[{uri:{fsPath:'/project'}}];
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({inspect:key=>copied[key],update:async(key,value,target)=>{
    projectWrites.push([key,value,target]); copied[key]={...copied[key],workspaceFolderValue:value};
  }});
  await store.initializeAgentDefaults({get:()=>true,update:async()=>{}},{codex:true,claude:false},{get:key=>projectState.get(key),update:async(key,value)=>projectState.set(key,value)});
  assert.equal(projectWrites.length,7,'A new project receives model, reasoning and one model-scoped Fast map');
  copied['main.model'].globalValue='changed-global';
  await store.initializeAgentDefaults({get:()=>true,update:async()=>{}},{codex:true,claude:false},{get:key=>projectState.get(key),update:async(key,value)=>projectState.set(key,value)});
  assert.equal(projectWrites.length,7,'Later global changes do not update an initialized project');
  assert.equal(copied['main.model'].workspaceFolderValue,'main-global');
  const createMemory=()=>{const data=new Map();return {data,get:(key,fallback)=>data.has(key)?structuredClone(data.get(key)):fallback,update:async(key,value)=>data.set(key,structuredClone(value))};};
  const globalMemory=createMemory(), workspaceMemory=createMemory(), chatId='chat-1';
  const presetValues={
    'main.model':{globalValue:'gpt-6-astra',workspaceValue:'workspace-default'},'main.reasoningEffort':{globalValue:'high'},'main.fast':{globalValue:true},
    'work.model':{globalValue:'claude-opus-5-5'},'work.reasoningEffort':{globalValue:'medium'},'work.fast':{globalValue:false},
    'verification.model':{globalValue:'gpt-6-sol'},'verification.reasoningEffort':{globalValue:'low'},'verification.fast':{globalValue:true}
  };
  const presetWrites=[];
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[{uri:{fsPath:'/project'}}];
  let failureKey;
  globalThis.__agentConfigFixture.workspace.getConfiguration=()=>({inspect:key=>presetValues[key],update:async(key,value,target)=>{
    if(key===failureKey){failureKey=undefined;throw new Error('preset write failed');}
    presetWrites.push([key,value,target]);presetValues[key]={...presetValues[key],[target===1?'globalValue':'workspaceFolderValue']:value};
  }});
  const completeChat={main:{model:'gpt-6-sol',reasoningEffort:'high',fast:true},work:{model:'gpt-6-astra',reasoningEffort:'medium',fast:false},verification:{model:'gpt-6-sol',reasoningEffort:'low',fast:true}};
  for(const role of ['main','work','verification'])for(const field of ['model','reasoningEffort','fast']){
    const key=`${role}.${field}`;presetValues[key]??={};presetValues[key].workspaceFolderValue=presetValues[key].globalValue ?? (field==='model'?'gpt-6-sol':field==='reasoningEffort'?'medium':false);
  }
  await Promise.all([
    store.ensureAgentPresets(globalMemory,workspaceMemory,chatId,completeChat),
    store.ensureAgentPresets(globalMemory,workspaceMemory,chatId,completeChat)
  ]);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.filter(p=>p.isDefault).length,3);
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'update','chat','Default',completeChat);
  await store.ensureAgentPresets(globalMemory,workspaceMemory,chatId,completeChat);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.isDefault).settings.main.model,'gpt-6-sol');
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'save','global','Quality');
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'save','project','Quality');
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.filter(p=>p.name==='Quality').length,2,'The same set name is independent in each scope');
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='global'&&p.name==='Quality').settings.main.model,'gpt-6-astra');
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'save','global','Quality'),/already exists/);
  presetValues['main.model'].globalValue='changed-after-save';
  presetValues['verification.model']={workspaceFolderValue:'stale'};
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'apply','project','Quality');
  assert.equal(presetWrites.length,7);
  assert.deepEqual(presetValues.fastByModel.workspaceFolderValue,{'gpt-6-astra':true,'claude-opus-5-5':false,'gpt-6-sol':true});
  assert.equal(presetValues['main.model'].workspaceFolderValue,'gpt-6-astra');
  assert.equal(presetValues['main.model'].globalValue,'changed-after-save');
  assert.equal(presetValues['verification.model'].workspaceFolderValue,'gpt-6-sol');
  const snapshot=structuredClone(presetValues);
  failureKey='work.model';
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'apply','global','Quality'),/preset write failed/);
  assert.deepEqual(presetValues,snapshot,'Partial application restores the exact target layer');
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'apply','global','missing'),/no longer exists/);
  globalThis.__agentConfigFixture.workspace.workspaceFolders=[];
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'apply','project','Quality'),/Open a project/);
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'save','chat','Chat',completeChat);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Chat').settings.main.model,'gpt-6-sol');
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'update','chat','Chat',{...completeChat,main:{model:'gpt-6-astra',reasoningEffort:'low'}});
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.filter(p=>p.scope==='chat'&&p.name==='Chat').length,1);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Chat').settings.main.reasoningEffort,'low');
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'update','chat','missing',{}),/no longer exists/);
  await Promise.all([
    store.updateAgentPresetField(globalMemory,workspaceMemory,chatId,'chat','Chat','main','model','gpt-6-sol'),
    store.updateAgentPresetField(globalMemory,workspaceMemory,chatId,'chat','Chat','work','reasoningEffort','high'),
    store.updateAgentPresetField(globalMemory,workspaceMemory,chatId,'chat','Chat','verification','fast',false)
  ]);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Chat').settings.main.model,'gpt-6-sol');
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Chat').settings.work.reasoningEffort,'high');
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Chat').settings.verification.fast,false);
  await assert.rejects(store.updateAgentPresetField(globalMemory,workspaceMemory,chatId,'chat','Chat','main','model',''),/invalid/i);
  await assert.rejects(store.updateAgentPresetField(globalMemory,workspaceMemory,chatId,'chat','missing','main','model','gpt-6-sol'),/no longer exists/);
  const beforeDelete=structuredClone(presetValues);
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'delete','chat','Chat');
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.some(p=>p.scope==='chat'&&p.name==='Chat'),false);
  assert.deepEqual(presetValues,beforeDelete,'Deleting a set preserves applied configuration');
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'delete','chat','Chat'),/no longer exists/);
  await assert.rejects(store.useAgentPreset(globalMemory,workspaceMemory,chatId,'delete','global','Default'),/cannot be deleted/);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.filter(p=>p.isDefault).length,3,'Every scope keeps its default set');
  await store.useAgentPreset(globalMemory,workspaceMemory,chatId,'save','chat',' Fresh ',completeChat);
  assert.equal(store.readAgentDefaults(globalMemory,workspaceMemory,chatId).presets.find(p=>p.scope==='chat'&&p.name==='Fresh').name,'Fresh');

  delete globalThis.__agentConfigFixture;
});

test('preset messages validate scope, action and names',()=>{
  assert.deepEqual(parseClientMessage({type:'agent.preset.field',scope:'chat',name:'A',role:'work',field:'reasoningEffort',value:'high'}),{type:'agent.preset.field',scope:'chat',name:'A',role:'work',field:'reasoningEffort',value:'high'});
  assert.deepEqual(parseClientMessage({type:'agent.preset.field',scope:'project',name:'A',role:'workLight',field:'model',value:'gpt-6-luna'}),{type:'agent.preset.field',scope:'project',name:'A',role:'workLight',field:'model',value:'gpt-6-luna'});
  assert.deepEqual(parseClientMessage({type:'agent.preset.field',scope:'project',name:'A',role:'workLight',field:'fast',value:false}),{type:'agent.preset.field',scope:'project',name:'A',role:'workLight',field:'fast',value:false});
  assert.equal(parseClientMessage({type:'agent.preset.field',scope:'chat',name:'A',role:'invalid',field:'model',value:'gpt-6-sol'}),undefined);
  const good={type:'agent.preset',action:'save',scope:'global',name:'Quality'};
  assert.deepEqual(parseClientMessage(good),good);
  assert.deepEqual(parseClientMessage({...good,scope:'chat'}),{...good,scope:'chat'});
  assert.equal(parseClientMessage({...good,scope:'chat',action:'apply'}).action,'apply');
  assert.equal(parseClientMessage({...good,scope:'chat',action:'update'}).action,'update');
  assert.equal(parseClientMessage({...good,scope:'chat',action:'delete'}).action,'delete');
  for(const change of [{action:'remove'},{scope:'bad'},{name:''},{name:'   '},{name:4}])assert.equal(parseClientMessage({...good,...change}),undefined);
});
