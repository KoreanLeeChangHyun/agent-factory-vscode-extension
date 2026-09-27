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
  delete globalThis.__agentConfigFixture;
});
