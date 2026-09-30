const assert = require('node:assert/strict');
async function checkAgentPresets(page) {
  const emit=async data=>{await page.evaluate(data=>window.postMessage(data,'*'),data);await page.evaluate(()=>new Promise(requestAnimationFrame));};
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
  await page.locator('#agent-default-fields select[data-role="main"][data-field="model"]').selectOption('gpt-6-astra');
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
  await page.locator('#agent-preset-name').fill('Chat set');
  await page.locator('#agent-preset-save').click();
  assert.deepEqual(await last(), {type:'agent.preset',action:'save',scope:'chat',name:'Chat set'});
  await emit({type:'agent.preset.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  settings.presets.push({scope:'chat',name:'Chat set',settings:settings.global});
  await emit({type:'agent.defaults',settings});
  await emit({type:'capabilities.updated',capabilities:{submit:{model:true},send:{model:true,sessionProvider:'codex'}}});
  await page.locator('#agent-preset-select').selectOption('Fast');
  await emit({type:'agent.preset.result',scope:'chat',name:'Fast',settings:projectSet});
  assert.equal(await page.evaluate(()=>window.saved.model), 'gpt-6-sol');
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='composer.settings').at(-1).model),'gpt-6-sol');
  await page.locator('#model-menu select[data-role="main"][data-field="model"]').selectOption('gpt-6-astra');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset.field').at(-1)),{type:'agent.preset.field',scope:'chat',name:'Fast',role:'main',field:'model',value:'gpt-6-astra'});
  await emit({type:'agent.preset.field.result',error:'Autosave failed'});
  assert.equal(await page.locator('#agent-preset-status').textContent(),'Autosave failed');
  await emit({type:'agent.preset.field.result'});
  assert.equal(await page.locator('#agent-preset-status').isVisible(),false);
  await page.locator('#model-menu select[data-role="main"][data-field="model"]').selectOption('gpt-6-sol');
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
  await emit({type:'chat.started',id:'preset-lock',text:'hello',attachments:[]});
  const before=await page.evaluate(()=>JSON.stringify({model:window.saved.model,agentModels:window.saved.agentModels}));
  await page.locator('#agent-preset-select').selectOption('Other provider');
  assert.equal(await page.evaluate(()=>JSON.stringify({model:window.saved.model,agentModels:window.saved.agentModels})),before);
  assert.equal(await page.locator('#agent-preset-status').isVisible(),true);
  await page.locator('#agent-preset-create summary').click();
  assert.equal(await page.locator('[data-i18n="preset.help"]').count(),0);
  for (const size of [{width:465,height:556},{width:560,height:650}]) {
    await page.setViewportSize(size);
    const geometry=await page.locator('#model-menu').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));
    assert.ok(geometry.scroll<=geometry.height+1,JSON.stringify({size,geometry}));
    assert.ok(geometry.top>=0 && geometry.bottom<=size.height,JSON.stringify({size,geometry}));
    const anchor=await page.locator('#model-menu').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,parentTop:el.offsetParent.getBoundingClientRect().top,position:getComputedStyle(el).position}));
    assert.equal(anchor.position,'absolute');
    assert.ok(Math.abs(anchor.bottom-(anchor.parentTop-6))<2,JSON.stringify(anchor));
  }
  await page.locator('#agent-preset-delete').click();
  assert.deepEqual(await last(),{type:'agent.preset',action:'delete',scope:'chat',name:'Other provider'});
  assert.equal(await page.locator('#agent-preset-delete').isDisabled(),true);
  await emit({type:'agent.preset.result',error:'Delete failed'});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Fast');
  await page.locator('#agent-preset-select').selectOption('Other provider');
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
  await page.screenshot({path:'/tmp/af-preset-layout.png'});
  console.log('Agent preset save/apply, scope selection, errors and narrow layout passed');
}
module.exports={checkAgentPresets};
