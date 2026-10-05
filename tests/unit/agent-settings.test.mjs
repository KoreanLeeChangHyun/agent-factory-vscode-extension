import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
import { readFileSync } from 'node:fs';
import { readChatSourceSync, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";
const { createDraftChatState, restoreChatState } = await importTypeScript('src/modules/chat/chat-state.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
const source = readChatSourceSync();
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('draft and restart preserve independent copied settings, including empty Fast maps',()=>{
  const parent={model:'project-main',reasoning:'high',agentModels:{work:{model:'project-work',reasoningEffort:'medium'}},agentFastModes:{work:{'project-work':true}}};
  const chat=createDraftChatState(parent);
  parent.agentModels.work.model='new-project-work'; parent.agentFastModes.work['project-work']=false;
  assert.equal(chat.agentModels.work.model,'project-work');
  assert.equal(chat.agentFastModes.work['project-work'],true);
  const saved=JSON.parse(JSON.stringify({...chat,agentFastModes:{}}));
  const restored=restoreChatState(saved,parent);
  assert.equal(restored.model,'project-main');
  assert.equal(restored.agentModels.work.model,'project-work');
  assert.deepEqual(restored.agentFastModes,{});
  const legacy=restoreChatState({panelId:'legacy',model:'chosen',agentModels:{work:{model:'chosen-work'}}},parent);
  assert.equal(legacy.model,'chosen'); assert.equal(legacy.agentModels.work.model,'chosen-work');
  assert.equal(legacy.agentModels.work.reasoningEffort,'medium');
});
test('scope writes reject unknown roles, fields, unsafe models and effort',()=>{
  const good={type:'agent.defaults.save',scope:'project',role:'work',field:'model',value:'claude-sonnet'};
  assert.deepEqual(parseClientMessage(good),good);
  assert.deepEqual(parseClientMessage({...good,role:'workLight'}),{...good,role:'workLight'});
  assert.deepEqual(parseClientMessage({...good,field:'fast',value:true}),{...good,field:'fast',value:true});
  assert.deepEqual(parseClientMessage({type:'agent.defaults.fast',scope:'project',role:'work',model:'gpt-6-astra',value:true}),{type:'agent.defaults.fast',scope:'project',role:'work',model:'gpt-6-astra',value:true});
  assert.deepEqual(parseClientMessage({type:'agent.preset.fast',scope:'chat',name:'Default',role:'verification',model:'gpt-6-astra',value:false}),{type:'agent.preset.fast',scope:'chat',name:'Default',role:'verification',model:'gpt-6-astra',value:false});
  assert.equal(parseClientMessage({type:'agent.defaults.fast',scope:'chat',role:'work',model:'gpt-6-astra',value:true}),undefined);
  assert.equal(parseClientMessage({type:'agent.preset.fast',scope:'chat',name:'Default',role:'work',model:'bad\nmodel',value:true}),undefined);
  assert.equal(parseClientMessage({...good,field:'fast',value:'true'}),undefined);
  assert.equal(parseClientMessage({...good,value:''}),undefined);
  for(const change of [{scope:'chat'},{role:'other'},{field:'permissions'},{value:'bad\n--flag'},{field:'reasoningEffort',value:'extreme'}]) assert.equal(parseClientMessage({...good,...change}),undefined);
});
test('chat uses only its copied settings after defaults change',()=>{
  const sent=[];
  const ctx={state:{role:'main',model:'chat-main',reasoning:'high',fastMode:true,agentModels:{work:{model:'gpt-project-work',reasoningEffort:'low',fast:true},verification:{model:'claude-review',reasoningEffort:'medium',fast:true}},agentDefaults:{project:{work:{model:'changed'}}}},normalizeAgentFastModes:()=>({}),vscode:{postMessage:m=>sent.push(m)}};
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
    state:{role:'main',agentId:'main-test',model:'claude-opus-5-5',reasoning:'medium',agentFastModes:{main:{'gpt-old':true}},timeline:[{type:'user'}]},
    settingOptions:{model:['claude-opus-5-5','claude-fable-5-1','gpt-6-astra']},
    capabilities:{model:true,reasoning:true,sessionProvider:'claude'},
    t:key=>key,
    document:{getElementById:id=>id==='agent-preset-status'?status:id==='agent-default-scope'?scope:null},
    normalizeAgentFastModes:()=>({}),persist(){},saveComposerSettings(){},updateModeControls(){}
  };
  ctx.currentCapabilities=()=>ctx.capabilities;
  runInNewContext(section('  function normalizeModelFastModes(', '  function normalizeModel(')+section('  function agentSettingRole(', '  function renderAgentDefaults('),ctx);
  const run=expression=>runInNewContext(expression,ctx);
  const sameCli={main:{model:'claude-fable-5-1',reasoningEffort:'high'}};
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify(sameCli)})`),'');
  assert.equal(run(`applyAgentSettingsToChat(${JSON.stringify(sameCli)},'chat','Default')`),true);
  assert.equal(ctx.state.model,'claude-fable-5-1');
  assert.equal(ctx.state.reasoning,'high');
  assert.equal(Object.keys(ctx.state.agentFastModes).length,0,'Applying a set without role/model Fast values must not inherit another scope\'s map');
  ctx.state.model='claude-opus-5-5';ctx.state.reasoning='medium';
  assert.equal(run(`agentSettingsApplyError(${JSON.stringify({main:{model:'gpt-6-astra',reasoningEffort:'high'}})})`),'ui.model.provider.fixed');
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
  assert.equal(props['agentFactory.agents.fastByRoleModel'].scope,'resource');
  assert.deepEqual(props['agentFactory.agents.fastByRoleModel'].default,{});
  for(const role of ['main','work','workLight','verification']) assert.equal(props[`agentFactory.agents.${role}.fast`],undefined);
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
  assert.deepEqual(parseClientMessage({...good,action:'default'}),{...good,action:'default'});
  assert.deepEqual(parseClientMessage({...good,sourceName:' Source '}),{...good,sourceName:'Source'});
  assert.equal(parseClientMessage({...good,scope:'chat',action:'update'}).action,'update');
  assert.equal(parseClientMessage({...good,scope:'chat',action:'delete'}).action,'delete');
  assert.deepEqual(parseClientMessage({...good,scope:'chat',action:'rename',newName:' Better '}),{...good,scope:'chat',action:'rename',newName:'Better'});
  assert.equal(parseClientMessage({...good,scope:'chat',action:'rename',newName:' '}),undefined);
  for(const change of [{action:'remove'},{scope:'bad'},{name:''},{name:'   '},{name:4}])assert.equal(parseClientMessage({...good,...change}),undefined);
});
