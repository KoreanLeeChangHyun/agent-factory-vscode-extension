const assert = require('node:assert/strict');
async function checkAgentPresets(page) {
  const emit=async data=>{await page.evaluate(data=>window.postMessage(data,'*'),data);await page.evaluate(()=>new Promise(requestAnimationFrame));};
  const chooseModel=async(container,value)=>{
    const button=container.locator('button[data-field="model"]');
    await button.click();
    const option=container.locator('.model-picker-option[data-value="'+value+'"]');
    if(!await option.count()){
      for(const tab of await container.locator('.model-vendor-tab').all()){
        if(!await tab.isDisabled()) await tab.click();
        if(await option.count()) break;
      }
    }
    await option.click();
  };
  await emit({type:'host.initialize',panelId:'preset-check',role:'main',projectName:'project',runtimeAvailable:true,running:false,statusItems:[],queueCount:0,fastMode:false,goalMode:false,capabilities:{submit:{model:true,reasoning:true},send:{model:true,reasoning:true}}});
  await emit({type:'models.list',models:['gpt-6-astra','gpt-6-sol','claude-opus-5-5']});
  const globalSet={main:{model:'gpt-6-astra',reasoningEffort:'medium'},work:{model:'gpt-6-sol',reasoningEffort:'medium'},verification:{model:'gpt-6-sol',reasoningEffort:'medium'}};
  const projectSet={main:{model:'gpt-6-sol',reasoningEffort:'medium'},work:{model:'gpt-6-sol',reasoningEffort:'medium'},verification:{model:'gpt-6-sol',reasoningEffort:'medium'}};
  const settings={global:globalSet,project:projectSet,projectAvailable:true,presets:[
    {scope:'global',name:'Default',isDefault:true,settings:globalSet},
    {scope:'project',name:'Default',isDefault:true,settings:projectSet},
    {scope:'chat',name:'Default',isDefault:true,settings:projectSet}
  ]};
  await emit({type:'agent.defaults',settings});
  if (!await page.locator('#model-menu').isVisible()) await page.locator('#model-button').click();
  await page.locator('#agent-default-scope').selectOption('global');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').at(-1)),{type:'agent.preset',action:'apply',scope:'global',name:'Default'});
  await emit({type:'agent.preset.result',scope:'global',name:'Default',settings:globalSet});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Default');
  assert.equal(await page.locator('.agent-settings-heading #agent-preset-select').count(),1);
  assert.equal(await page.locator('#agent-preset-update').count(),0);
  await chooseModel(page.locator('#agent-default-fields .agent-model-row[data-agent-role="main"]'),'gpt-6-astra');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset.field').at(-1)),{type:'agent.preset.field',scope:'global',name:'Default',role:'main',field:'model',value:'gpt-6-astra'});
  assert.equal(await page.locator('.agent-settings-heading > strong').count(),0);
  const picker=await page.locator('#agent-preset-select').boundingBox();
  const scope=await page.locator('#agent-default-scope').boundingBox();
  assert.ok(picker.x>=scope.x+scope.width && Math.abs(scope.y-picker.y)<2);
  assert.equal(await page.locator('#agent-preset-apply').count(),0);
  assert.equal(await page.locator('#agent-preset-save').isDisabled(),true);
  assert.equal(await page.locator('#agent-preset-name').isVisible(),false);
  await page.locator('#agent-preset-create summary').click();
  await page.locator('#agent-preset-name').fill('Quality');
  await page.locator('#agent-preset-save').click();
  const last=()=>page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').at(-1));
  assert.deepEqual(await last(),{type:'agent.preset',action:'save',scope:'global',name:'Quality'});
  assert.equal(await page.locator('#agent-default-scope').isDisabled(),true);
  assert.equal(await page.locator('#agent-preset-save').isDisabled(),true);
  settings.presets=[
    {scope:'global',name:'Default',isDefault:true,settings:globalSet},{scope:'global',name:'Quality',settings:globalSet},{scope:'global',name:'Fast',settings:projectSet},
    {scope:'project',name:'Default',isDefault:true,settings:projectSet},{scope:'project',name:'Quality',settings:globalSet},{scope:'project',name:'Fast',settings:projectSet},
    {scope:'chat',name:'Default',isDefault:true,settings:projectSet},{scope:'chat',name:'Fast',settings:projectSet}
  ];
  await emit({type:'agent.defaults',settings});
  await emit({type:'agent.preset.result',scope:'global',name:'Quality',settings:globalSet});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Quality');
  assert.equal(await page.locator('#agent-preset-create').getAttribute('open'),null,'Successful save closes the new-set popup');
  assert.equal(await page.locator('#agent-preset-name').inputValue(),'','Successful save clears the completed name');
  await page.locator('#agent-preset-rename summary').click();
  await page.locator('#agent-preset-rename-name').fill('Better');
  await page.locator('#agent-preset-rename-save').click();
  assert.deepEqual(await last(),{type:'agent.preset',action:'rename',scope:'global',name:'Quality',newName:'Better'});
  settings.presets=settings.presets.map(preset=>preset.scope==='global'&&preset.name==='Quality'?{...preset,name:'Better'}:preset);
  await emit({type:'agent.defaults',settings});
  await emit({type:'agent.preset.result',scope:'global',name:'Better'});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Better');
  assert.equal(await page.evaluate(()=>window.saved.agentSettingsSet),'Better');
  assert.equal(await page.locator('#agent-preset-rename').getAttribute('open'),null);
  await page.locator('#agent-preset-rename summary').click();
  await page.locator('#agent-preset-rename-name').fill('Fast');
  await page.locator('#agent-preset-rename-save').click();
  await emit({type:'agent.preset.result',error:'A set with this name already exists. Use a different name.'});
  assert.notEqual(await page.locator('#agent-preset-rename').getAttribute('open'),null,'Failed rename keeps the editor open');
  assert.equal(await page.locator('#agent-preset-rename-name').inputValue(),'Fast');
  await page.locator('#agent-preset-rename summary').click();
  await page.locator('#agent-preset-create summary').click();
  await page.locator('#agent-preset-name').fill('Retry me');
  await page.locator('#agent-preset-save').click();
  await emit({type:'agent.preset.result',error:'Save failed'});
  assert.notEqual(await page.locator('#agent-preset-create').getAttribute('open'),null,'Failed save keeps the popup open');
  assert.equal(await page.locator('#agent-preset-name').inputValue(),'Retry me','Failed save preserves the name');
  assert.equal(await page.locator('#agent-preset-status').textContent(),'Save failed');
  await page.locator('#agent-preset-create summary').click();
  await page.locator('#agent-default-scope').selectOption('project');
  assert.deepEqual(await last(),{type:'agent.preset',action:'apply',scope:'project',name:'Default'});
  await emit({type:'agent.preset.result',scope:'project',name:'Default',settings:projectSet});
  await page.locator('#agent-preset-select').selectOption('Quality');
  assert.deepEqual(await last(),{type:'agent.preset',action:'apply',scope:'project',name:'Quality'});
  await emit({type:'agent.preset.result',error:'Simulated write failure'});
  assert.equal(await page.locator('#agent-preset-status').textContent(),'Simulated write failure');
  assert.equal(await page.locator('#agent-preset-select').isEnabled(),true);
  await page.locator('#agent-preset-select').selectOption('Fast');
  assert.equal((await last()).name,'Fast');
  await emit({type:'agent.preset.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  await page.setViewportSize({width:375,height:800});
  const bounds=await page.locator('.agent-settings-heading').boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=375,JSON.stringify(bounds));
  assert.equal(await page.locator('.agent-settings-heading').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await page.locator('#agent-default-scope').selectOption('chat');
  assert.deepEqual(await last(),{type:'agent.preset',action:'apply',scope:'chat',name:'Default'});
  await emit({type:'agent.preset.result',scope:'chat',name:'Default',settings:projectSet});
  assert.equal(await page.locator('.agent-settings-heading #agent-preset-delete').count(), 1);
  assert.equal(await page.locator('.agent-settings-heading #agent-preset-create').count(), 1);
  assert.equal(await page.locator('#model-menu .agent-model-name .agent-role-icon').count(), 4);
  await page.locator('#agent-preset-create summary').click();
  await page.locator('#agent-preset-name').fill('Chat set');
  await page.locator('#agent-preset-save').click();
  assert.deepEqual(await last(), {type:'agent.preset',action:'save',scope:'chat',name:'Chat set'});
  await emit({type:'agent.preset.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  settings.presets.push({scope:'chat',name:'Chat set',settings:settings.global});
  await emit({type:'agent.defaults',settings});
  await emit({type:'session.bound',agentId:'preset-bound'});
  await emit({type:'capabilities.updated',capabilities:{submit:{model:true},send:{model:true,sessionProvider:'codex'}}});
  assert.equal(await page.locator('#agent-preset-select').isDisabled(),true,'A provider-bound conversation disables the whole set picker');
  const presetMessages=await page.evaluate(()=>window.sentMessages.filter(message=>message.type==='agent.preset').length);
  await page.locator('#agent-preset-select').evaluate(select=>{select.value='Fast';select.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(message=>message.type==='agent.preset').length),presetMessages,'Programmatic change cannot bypass the bound set guard');
  const mainRow=page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  await mainRow.locator('button[data-field="model"]').click();
  assert.equal(await mainRow.locator('.model-vendor-tab[data-vendor="anthropic"]').isDisabled(),true,'Main cannot switch to another provider while bound');
  await page.keyboard.press('Escape');
  const workRow=page.locator('#model-menu .agent-model-row[data-agent-role="work"]');
  await workRow.locator('button[data-field="model"]').click();
  assert.equal(await workRow.locator('.model-vendor-tab[data-vendor="anthropic"]').isDisabled(),false,'An unbound delegated role keeps other-provider choices');
  await page.keyboard.press('Escape');
  await emit({type:'conversation.cleared',conversationId:'cleared-preset'});
  await emit({type:'capabilities.updated',capabilities:{submit:{model:true},send:{model:true}}});
  assert.equal(await page.locator('#agent-preset-select').isEnabled(),true,'A cleared conversation can choose a set again');
  await page.locator('#agent-preset-select').selectOption('Fast');
  await emit({type:'agent.preset.result',scope:'chat',name:'Fast',settings:projectSet});
  assert.equal(await page.evaluate(()=>window.saved.model), 'gpt-6-sol');
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='composer.settings').at(-1).model),'gpt-6-sol');
  await chooseModel(page.locator('#model-menu .agent-model-row[data-agent-role="main"]'),'gpt-6-astra');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset.field').at(-1)),{type:'agent.preset.field',scope:'chat',name:'Fast',role:'main',field:'model',value:'gpt-6-astra'});
  await emit({type:'agent.preset.field.result',error:'Autosave failed'});
  assert.equal(await page.locator('#agent-preset-status').textContent(),'Autosave failed');
  await emit({type:'agent.preset.field.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  await chooseModel(page.locator('#model-menu .agent-model-row[data-agent-role="main"]'),'gpt-6-sol');
  await emit({type:'agent.preset.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  settings.presets.push({scope:'chat',name:'Partial legacy set',settings:{}});
  await emit({type:'agent.defaults',settings});
  const beforePartial=await page.evaluate(()=>({model:window.saved.model,reasoning:window.saved.reasoning}));
  await page.locator('#agent-preset-select').selectOption('Partial legacy set');
  assert.deepEqual(await page.evaluate(()=>({model:window.saved.model,reasoning:window.saved.reasoning})),beforePartial,'A legacy partial set must not restore values from another scope');
  await emit({type:'agent.preset.result',error:'Invalid legacy set'});
  settings.presets.push({scope:'chat',name:'Other provider',settings:{main:{model:'claude-opus-5-5'},work:{model:'claude-opus-5-5'}}});
  await emit({type:'agent.defaults',settings});
  const before=await page.evaluate(()=>JSON.stringify({model:window.saved.model,agentModels:window.saved.agentModels}));
  assert.equal(await page.evaluate(()=>JSON.stringify({model:window.saved.model,agentModels:window.saved.agentModels})),before);
  await page.locator('#agent-preset-create summary').click();
  assert.equal(await page.locator('[data-i18n="preset.help"]').count(),0);
  await page.locator('#agent-preset-create summary').click();
  for (const size of [{width:465,height:556},{width:560,height:650}]) {
    await page.setViewportSize(size);
    const geometry=await page.locator('#model-menu').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));
    assert.ok(geometry.top>=0 && geometry.bottom<=size.height,JSON.stringify({size,geometry}));
    assert.equal(await page.locator('#model-menu').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    assert.equal(await page.locator('#model-menu').evaluate(el=>getComputedStyle(el).position),'fixed');
  }
  await page.locator('#agent-preset-select').evaluate(select=>{select.value='Other provider';});
  await page.locator('#agent-preset-delete').click();
  assert.deepEqual(await last(),{type:'agent.preset',action:'delete',scope:'chat',name:'Other provider'});
  assert.equal(await page.locator('#agent-preset-delete').isDisabled(),true);
  await emit({type:'agent.preset.result',error:'Delete failed'});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Fast');
  await page.locator('#agent-preset-select').evaluate(select=>{select.value='Other provider';});
  await page.locator('#agent-preset-delete').click();
  await emit({type:'agent.preset.result'});
  settings.presets=[
    {scope:'global',name:'Default',isDefault:true,settings:globalSet},
    {scope:'project',name:'Default',isDefault:true,settings:projectSet},
    {scope:'chat',name:'Default',isDefault:true,settings:projectSet}
  ];
  await emit({type:'agent.defaults',settings});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Default');
  assert.equal(await page.locator('#agent-preset-delete').isDisabled(),true);
  assert.equal(await page.evaluate(()=>JSON.stringify({model:window.saved.model,agentModels:window.saved.agentModels})),before);
  const fs=require('node:fs'),path=require('node:path');
  const artifactDir=path.resolve(__dirname,'../../../docs/artifact/agent-settings-followup');
  fs.mkdirSync(artifactDir,{recursive:true});
  await page.screenshot({path:path.join(artifactDir,'presets-layout.png')});
  console.log('Agent preset save/apply, scope selection, errors and narrow layout passed');
}
module.exports={checkAgentPresets};
