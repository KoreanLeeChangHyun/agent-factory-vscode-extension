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
  await page.locator('#status-settings-button').evaluate(element=>element.click());
  await page.locator('#settings-tab-agents').click();
  assert.equal(await page.locator('#agent-default-scope').inputValue(),'global');
  const originalChat = await page.evaluate(()=>({model:window.saved.model,reasoning:window.saved.reasoning}));
  await emit({type:'agent.preset.result',scope:'global',name:'Default',settings:globalSet});
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Default');
  assert.equal(await page.locator('.agent-settings-heading #agent-preset-select').count(),1);
  assert.equal(await page.locator('#agent-preset-update').count(),0);
  await chooseModel(page.locator('#agent-default-fields .agent-model-row[data-agent-role="main"]'),'gpt-6-astra');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset.field').at(-1)),{type:'agent.preset.field',scope:'global',name:'Default',role:'main',field:'model',value:'gpt-6-astra'});
  assert.equal(await page.locator('#global-agent-settings .agent-settings-heading > strong').count(),1);
  assert.equal(await page.locator('#agent-scope-row').isVisible(),false);
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
  assert.equal(await page.evaluate(()=>window.saved.agentSettingsSet),'Default');
  assert.deepEqual(await page.evaluate(()=>({model:window.saved.model,reasoning:window.saved.reasoning})),originalChat);
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
  await page.locator('#status-settings-close').click();
  await page.locator('#model-button').click();
  const actionsBeforeScope = await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').length);
  await page.locator('#agent-default-scope').selectOption('project');
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').length),actionsBeforeScope);
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
  const bounds=await page.locator('#model-menu .agent-settings-heading').boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=375,JSON.stringify(bounds));
  assert.equal(await page.locator('#model-menu .agent-settings-heading').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  const actionsBeforeChat = await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').length);
  await page.locator('#agent-default-scope').selectOption('chat');
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='agent.preset').length),actionsBeforeChat);
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
  const artifactDir=process.env.AF_PRESETS_ARTIFACT_DIR || path.resolve(__dirname,'../../../docs/artifact/model-settings-copy-20261004');
  fs.mkdirSync(artifactDir,{recursive:true});
  await page.screenshot({path:path.join(artifactDir,'presets-layout.png')});
  // A newly initialized draft must replace a cached running session's identity.
  await emit({type:'session.bound',agentId:'previous-running-chat'});
  await emit({type:'capabilities.updated',capabilities:{submit:{model:true,reasoning:true},send:{model:false,reasoning:false,sessionProvider:'codex'}}});
  await emit({type:'run.state',running:true});
  assert.equal(await page.locator('#agent-preset-select').isDisabled(),true);
  await emit({type:'host.initialize',panelId:'fresh-draft',role:'main',projectName:'project',runtimeAvailable:true,running:false,statusItems:[],queueCount:0,model:'gpt-6-astra',reasoning:'medium',capabilities:{submit:{model:true,reasoning:true},send:{model:false,reasoning:false,sessionProvider:'codex'}}});
  await page.waitForFunction(()=>window.saved.panelId==='fresh-draft' && !window.saved.running);
  assert.equal(await page.evaluate(()=>window.saved.agentId),undefined,'An unbound host snapshot clears the cached session');
  assert.equal(await page.locator('#agent-preset-select').isEnabled(),true,'New drafts use submit capabilities');
  assert.equal(await page.locator('#model-menu button[data-role="main"][data-field="model"]').isEnabled(),true);
  await page.locator('#agent-preset-select').selectOption('Default');
  await emit({type:'agent.preset.result',scope:'chat',name:'Default',settings:projectSet});
  await chooseModel(page.locator('#model-menu .agent-model-row[data-agent-role="main"]'),'claude-opus-5-5');
  await page.waitForFunction(()=>window.saved.model==='claude-opus-5-5');
  assert.equal(await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='composer.settings').at(-1).model),'claude-opus-5-5');
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();
  await emit({type:'host.initialize',panelId:'fresh-draft',role:'main',projectName:'project',runtimeAvailable:true,running:false,statusItems:[],queueCount:0,model:'claude-opus-5-5',reasoning:'medium',capabilities:{submit:{model:true,reasoning:true},send:{model:false,reasoning:false,sessionProvider:'codex'}}});
  await emit({type:'agent.defaults',settings});
  await emit({type:'models.list',models:['gpt-6-astra','gpt-6-sol','claude-opus-5-5']});
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-preset-select').isEnabled(),true,'Restoring an unbound draft keeps settings editable');
  assert.equal(await page.locator('#model-menu button[data-role="main"][data-field="model"]').isEnabled(),true);
  await page.screenshot({path:path.join(artifactDir,'new-draft-restored.png')});
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('New draft selected model');
  await page.locator('#prompt').press('Enter');
  const send=await page.evaluate(()=>window.sentMessages.filter(m=>m.type==='chat.send').at(-1));
  assert.equal(send.execution.model,'claude-opus-5-5','The selected model reaches the execution request');
  await emit({type:'session.bound',agentId:'resumed-claude-chat'});
  await emit({type:'capabilities.updated',capabilities:{submit:{model:true,reasoning:true},send:{model:true,reasoning:true,sessionProvider:'claude'}}});
  await emit({type:'run.state',running:true});
  await page.waitForFunction(()=>window.saved.agentId==='resumed-claude-chat' && window.saved.running);
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();
  await emit({type:'host.initialize',panelId:'fresh-draft',agentId:'resumed-claude-chat',role:'main',projectName:'project',runtimeAvailable:true,running:true,statusItems:[],queueCount:0,model:'claude-opus-5-5',reasoning:'medium',capabilities:{submit:{model:true,reasoning:true},send:{model:true,reasoning:true,sessionProvider:'claude'}}});
  await emit({type:'agent.defaults',settings});
  await emit({type:'models.list',models:['gpt-6-astra','gpt-6-sol','claude-opus-5-5']});
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-preset-select').isDisabled(),true,'Restoring a bound running session retains set protection');
  const restoredMain=page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  await restoredMain.locator('button[data-field="model"]').click();
  assert.equal(await restoredMain.locator('.model-vendor-tab[data-vendor="openai"]').isDisabled(),true,'The resumed session retains its provider lock');
  assert.equal(await restoredMain.locator('.model-picker-option[data-value="claude-opus-5-5"]').isEnabled(),true,'Supported same-provider selections remain available');
  await page.evaluate(()=>sessionStorage.removeItem('submission-restoration-fixture'));
  console.log('Agent preset save/apply, scope selection, errors and narrow layout passed');
}
module.exports={checkAgentPresets};

// Compare the real global editor and chat popover with identical values and content width.
async function checkAgentSettingsConsistency(page) {
  const fs = require('node:fs'), path = require('node:path');
  const artifactDir = process.env.AF_PRESETS_ARTIFACT_DIR || path.resolve(__dirname, '../../../docs/artifact/agent-settings-consistency');
  fs.mkdirSync(artifactDir, {recursive: true});
  const emit = async data => { await page.evaluate(data => window.postMessage(data, '*'), data); await page.evaluate(() => new Promise(requestAnimationFrame)); };
  const settings = {main:{model:'gpt-6-astra',reasoningEffort:'medium'}, work:{model:'claude-opus-5-5',reasoningEffort:'low'}, workLight:{model:'claude-opus-5-5',reasoningEffort:'none'}, verification:{model:'gpt-6-sol',reasoningEffort:'high'}, fastByRoleModel:{main:{'gpt-6-astra':true}, verification:{'gpt-6-sol':false}}};
  await emit({type:'host.initialize',panelId:'settings-consistency',role:'main',model:settings.main.model,reasoning:settings.main.reasoningEffort,agentModels:{work:settings.work,workLight:settings.workLight,verification:settings.verification},agentFastModes:settings.fastByRoleModel,fastMode:true,runtimeAvailable:true,running:false,statusItems:[],queueCount:0,capabilities:{submit:{model:true,reasoning:true,fast:true},send:{model:true,reasoning:true,fast:true}}});
  await emit({type:'models.list',models:['gpt-6-astra','gpt-6-sol','claude-opus-5-5']});
  await emit({type:'agent.defaults',settings:{global:settings,project:settings,projectAvailable:true,presets:['global','project','chat'].map(scope=>({scope,name:'Default',isDefault:true,settings}))}});
  // Exercise Korean labels, rather than replacing controls in a standalone fixture.
  await page.locator('#status-settings-button').evaluate(el=>el.click());
  await page.locator('#settings-tab-general').click();
  await page.locator('#ui-language').selectOption('ko');
  await page.locator('#status-settings-close').click();
  const read = async selector => page.locator(selector).evaluate(editor => {
    const origin = editor.getBoundingClientRect(), es = getComputedStyle(editor);
    const inset = parseFloat(es.paddingLeft) + parseFloat(es.borderLeftWidth);
    const style = el => {
      const s = getComputedStyle(el), b = el.getBoundingClientRect();
      return {x:Math.round((b.x-origin.x-inset)*100)/100,y:Math.round(b.y*100)/100,width:Math.round(b.width*100)/100,height:Math.round(b.height*100)/100,border:s.border,borderRadius:s.borderRadius,background:s.backgroundColor,color:s.color,padding:s.padding,fontSize:s.fontSize,display:s.display};
    };
    return {width:origin.width-parseFloat(es.borderLeftWidth)-parseFloat(es.borderRightWidth)-parseFloat(es.paddingLeft)-parseFloat(es.paddingRight),overflow:editor.scrollWidth>editor.clientWidth+1,rows:[...editor.querySelectorAll('.agent-model-row')].map(row=>({role:row.dataset.agentRole,tracks:getComputedStyle(row).gridTemplateRows,layout:[...row.children].map(el=>({class:el.className,height:el.getBoundingClientRect().height,area:getComputedStyle(el).gridArea,margin:getComputedStyle(el).margin,rows:getComputedStyle(el).gridTemplateRows,display:getComputedStyle(el).display,lineHeight:getComputedStyle(el).lineHeight})),aria:row.getAttribute('aria-label'),box:style(row),model:style(row.querySelector('.model-picker-button')),reasoning:style(row.querySelector('input[type="range"]')),value:row.querySelector('input[type="range"]').getAttribute('aria-valuetext'),pressed:row.querySelector('.agent-fast-toggle')?.getAttribute('aria-pressed') ?? null,icon:row.querySelector('.toggle-icon')?style(row.querySelector('.toggle-icon')):null,fast:row.querySelector('.agent-fast-toggle')?style(row.querySelector('.agent-fast-toggle')):null}))};
  });
  await emit({type:'agent.preset.result',scope:'chat',name:'Default',settings});
  const evidence = [];
  for (const size of [{width:795,height:900},{width:566,height:650},{width:465,height:556},{width:320,height:556},{width:721,height:402}]) {
    await page.setViewportSize(size);
    await page.locator('#model-button').click();
    await page.locator('#model-menu').evaluate(el=>{el.style.width='';el.style.maxWidth='';el.style.right='';});
    const chatAvailable = (await read('#model-menu')).width;
    await page.keyboard.press('Escape');
    await page.locator('#status-settings-button').evaluate(el=>el.click());
    await page.locator('#settings-tab-agents').click();
    await page.locator('#global-agent-settings').evaluate(el=>{el.style.width='';});
    const globalAvailable = (await read('#global-agent-settings')).width;
    await page.locator('#global-agent-settings').evaluate((el,width)=>{el.style.width=width+'px';},Math.min(globalAvailable,chatAvailable));
    await page.mouse.move(0,0);
    const global = await read('#global-agent-settings');
    if(size.width>=465) assert.equal(await page.locator('#settings-panel-agents').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,'Global controls fit without vertical scrolling at '+size.width+'x'+size.height);
    await page.locator('#status-settings').screenshot({path:path.join(artifactDir,`global-${size.width}x${size.height}.png`)});
    await page.locator('#status-settings-close').click();
    await page.locator('#model-button').click();
    // Equal available content width isolates control consistency from outer windows.
    await page.locator('#model-menu').evaluate((el,width)=>{const s=getComputedStyle(el);el.style.width=(width+parseFloat(s.paddingLeft)+parseFloat(s.paddingRight)+parseFloat(s.borderLeftWidth)+parseFloat(s.borderRightWidth))+'px';el.style.maxWidth='none';el.style.right='auto';},global.width);
    await page.mouse.move(0,0);
    const chat = await read('#model-menu');
    if(size.width>=465) assert.equal(await page.locator('#model-menu').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,'Chat controls fit without vertical scrolling');
    await page.locator('#model-menu').screenshot({path:path.join(artifactDir,`chat-${size.width}x${size.height}.png`)});
    evidence.push({size,global,chat});
    fs.writeFileSync(path.join(artifactDir,'control-geometry.json'),JSON.stringify(evidence,null,2));
    assert.equal(global.overflow,false,'Global settings must not overflow horizontally');
    assert.equal(chat.overflow,false,'Chat settings must not overflow horizontally');
    for (let i=0;i<4;i++) {
      const g=global.rows[i], c=chat.rows[i];
      assert.equal(g.role,c.role);
      assert.equal(g.aria,c.aria,'Both scopes expose role groups');
      assert.equal(g.value,c.value,'Reasoning labels preserve the saved values');
      assert.equal(g.pressed,c.pressed,'Fast states match');
      for (const key of ['box','model','reasoning','fast','icon']) {
        if (!g[key] || !c[key]) { assert.equal(g[key],c[key]); continue; }
        const {y:gy,...gs}=g[key],{y:cy,...cs}=c[key];
        assert.deepEqual(gs,cs,`${key} geometry and theme must match at ${size.width}`);
        assert.equal(Math.round((gy-g.box.y)*100),Math.round((cy-c.box.y)*100),`${key} vertical alignment must match`);
      }
      if(i) assert.equal(Math.round(g.box.y-global.rows[i-1].box.y),Math.round(c.box.y-chat.rows[i-1].box.y),'Role row spacing must match');
    }
    // Open picker keyboard navigation retains the real accessible control.
    const picker=page.locator('#model-menu .agent-model-row[data-agent-role="main"] .model-picker-button');
    await picker.focus(); await page.keyboard.press('Enter');
    assert.equal(await picker.getAttribute('aria-expanded'),'true');
    await page.screenshot({path:path.join(artifactDir,`picker-${size.width}x${size.height}.png`)});
    await page.keyboard.press('Escape');
    assert.equal(await picker.getAttribute('aria-expanded'),'false');
    assert.equal(await picker.evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');
  }
  console.log('Global/chat control geometry, Korean labels, role accessibility and picker keyboard own checks passed');
}
module.exports.checkAgentSettingsConsistency = checkAgentSettingsConsistency;
