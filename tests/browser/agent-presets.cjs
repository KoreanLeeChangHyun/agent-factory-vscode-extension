const assert = require('node:assert/strict');
async function checkAgentPresets(page) {
  const fs=require('node:fs'),path=require('node:path');
  const artifactDir=process.env.AF_PRESETS_ARTIFACT_DIR || path.resolve(__dirname,'../../../docs/artifact/agent-settings-sets');
  fs.mkdirSync(artifactDir,{recursive:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const emit=async data=>{await page.evaluate(data=>window.postMessage(data,'*'),data);await page.evaluate(()=>new Promise(requestAnimationFrame));};
  const messages=type=>page.evaluate(type=>window.sentMessages.filter(m=>m.type===type),type);
  const chooseModel=async(container,value)=>{
    await container.locator('button[data-field="model"]').click();
    const option=container.locator('.model-picker-option[data-value="'+value+'"]');
    if(!await option.count()) for(const tab of await container.locator('.model-vendor-tab').all()) {
      if(!await tab.isDisabled())await tab.click();if(await option.count())break;
    }
    await option.click();
  };
  const settingsFor=model=>Object.fromEntries(['main','work','workLight','verification'].map(role=>[role,{model,reasoningEffort:'medium'}]));
  const projectSet=settingsFor('gpt-6-sol'), quality=settingsFor('gpt-6-astra'), globalSet=settingsFor('claude-opus-5-5');
  const capabilities={submit:{model:true,reasoning:true,fast:true},send:{model:true,reasoning:true,fast:true}};
  const initialize=async(panelId,model='gpt-6-sol',extra={})=>emit({type:'host.initialize',panelId,role:'main',projectName:'project',runtimeAvailable:true,running:false,statusItems:[],queueCount:0,agentSettingsVersion:1,agentSettingsScope:'chat',agentSettingsSet:'Default',model,reasoning:'medium',agentModels:{work:projectSet.work,workLight:projectSet.workLight,verification:projectSet.verification},capabilities,...extra});
  await initialize('preset-check');
  await emit({type:'models.list',models:['gpt-6-astra','gpt-6-sol','claude-opus-5-5']});
  const settings={global:globalSet,project:projectSet,projectAvailable:true,presets:[
    {scope:'global',name:'Default',isDefault:true,settings:globalSet},
    {scope:'project',name:'Default',isDefault:true,settings:projectSet},
    {scope:'project',name:'Quality',settings:quality},
    {scope:'chat',name:'Legacy',settings:globalSet}
  ]};
  await emit({type:'agent.defaults',settings});
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-menu #agent-default-scope').count(),0,'Chat has no scope selector');
  for(const id of ['create','rename','delete']) assert.equal(await page.locator('#model-menu #agent-preset-'+id).count(),0,'Set management is settings-only');
  assert.deepEqual(await page.locator('#agent-preset-select option').evaluateAll(options=>options.map(o=>o.value)),['','Default','Quality']);
  const beforeFields=(await messages('agent.preset.field')).length;
  await chooseModel(page.locator('#model-menu [data-agent-role="main"]'),'gpt-6-astra');
  assert.equal((await messages('agent.preset.field')).length,beforeFields,'Chat edits never write to a stored set');
  assert.equal((await messages('composer.settings')).at(-1).model,'gpt-6-astra');
  await page.locator('#agent-preset-select').selectOption('Quality');
  assert.deepEqual((await messages('agent.preset')).at(-1),{type:'agent.preset',action:'copy',scope:'project',name:'Quality'});
  await emit({type:'agent.preset.result',scope:'chat',name:'Quality',settings:quality});
  assert.equal(await page.evaluate(()=>window.saved.model),'gpt-6-astra');
  await emit({type:'agent.defaults',settings:{...settings,project:globalSet}});
  assert.equal(await page.evaluate(()=>window.saved.model),'gpt-6-astra','Later project edits do not change an existing chat');
  await emit({type:'agent.defaults',settings});
  await page.keyboard.press('Escape');
  await page.locator('#status-settings-button').evaluate(el=>el.click());
  await page.locator('#settings-tab-agents').click();
  assert.equal(await page.locator('#agent-default-scope').inputValue(),'project');
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Default');
  const beforeDefaults=(await messages('agent.defaults.save')).length;
  const beforeActions=(await messages('agent.preset')).length;
  await page.locator('#agent-preset-select').selectOption('Quality');
  assert.equal((await messages('agent.preset')).length,beforeActions,'Opening a set in settings does not apply it to project or chat');
  await chooseModel(page.locator('#agent-default-fields [data-agent-role="work"]'),'claude-opus-5-5');
  assert.deepEqual((await messages('agent.preset.field')).at(-1),{type:'agent.preset.field',scope:'project',name:'Quality',role:'work',field:'model',value:'claude-opus-5-5'});
  assert.equal((await messages('agent.defaults.save')).length,beforeDefaults,'Editing a custom set leaves project defaults alone');
  assert.equal(await page.evaluate(()=>window.saved.agentModels.work.model),'gpt-6-astra','Editing a source set leaves the copied chat alone');
  await page.locator('#agent-preset-select').selectOption('Default');
  await chooseModel(page.locator('#agent-default-fields [data-agent-role="main"]'),'claude-opus-5-5');
  assert.deepEqual((await messages('agent.defaults.save')).at(-1),{type:'agent.defaults.save',scope:'project',role:'main',field:'model',value:'claude-opus-5-5'});
  assert.equal(await page.evaluate(()=>window.saved.model),'gpt-6-astra');
  assert.equal(await page.locator('#agent-preset-delete').isDisabled(),true);
  await page.locator('#agent-preset-create summary').click();
  await page.locator('#agent-preset-name').fill('New set');await page.locator('#agent-preset-save').click();
  assert.deepEqual((await messages('agent.preset')).at(-1),{type:'agent.preset',action:'save',scope:'project',name:'New set'});
  await emit({type:'agent.preset.result',error:'Save failed'});
  assert.equal(await page.locator('#agent-preset-name').inputValue(),'New set');
  assert.equal(await page.locator('#agent-preset-status').textContent(),'Save failed');
  await page.locator('#agent-preset-save').click();
  settings.presets.push({scope:'project',name:'New set',settings:projectSet});
  await emit({type:'agent.defaults',settings});await emit({type:'agent.preset.result',scope:'project',name:'New set'});
  assert.equal(await page.locator('#agent-preset-create').getAttribute('open'),null);
  await page.locator('#agent-preset-rename summary').click();
  await page.locator('#agent-preset-rename-name').fill('Renamed');await page.locator('#agent-preset-rename-save').click();
  assert.deepEqual((await messages('agent.preset')).at(-1),{type:'agent.preset',action:'rename',scope:'project',name:'New set',newName:'Renamed'});
  settings.presets.find(p=>p.name==='New set').name='Renamed';
  await emit({type:'agent.defaults',settings});await emit({type:'agent.preset.result',scope:'project',name:'Renamed'});
  await page.locator('#agent-preset-delete').click();
  assert.deepEqual((await messages('agent.preset')).at(-1),{type:'agent.preset',action:'delete',scope:'project',name:'Renamed'});
  settings.presets=settings.presets.filter(p=>p.name!=='Renamed');
  await emit({type:'agent.defaults',settings});await emit({type:'agent.preset.result',scope:'project',name:'Renamed'});
  await page.locator('#settings-tab-general').click();await page.locator('#ui-language').selectOption('ko');
  await page.locator('#settings-tab-agents').click();
  for(const theme of ['vscode-dark','vscode-light','vscode-high-contrast']) {
    await page.evaluate(value=>document.body.className=value,theme);
    for(const size of [{width:795,height:900},{width:465,height:556},{width:320,height:556},{width:721,height:402}]) {
      await page.setViewportSize(size);
      assert.equal(await page.locator('#global-agent-settings').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Settings fit '+size.width);
      await page.screenshot({path:path.join(artifactDir,`settings-${theme}-${size.width}.png`)});
      await page.locator('#status-settings-close').click();await page.locator('#model-button').click();
      assert.equal(await page.locator('#model-menu').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Chat fits '+size.width);
      const picker=page.locator('#model-menu [data-agent-role="main"] .model-picker-button');
      await picker.focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');
      assert.equal(await picker.evaluate(el=>el===document.activeElement),true);
      await page.screenshot({path:path.join(artifactDir,`chat-${theme}-${size.width}.png`)});
      await page.keyboard.press('Escape');await page.locator('#status-settings-button').evaluate(el=>el.click());await page.locator('#settings-tab-agents').click();
    }
  }
  await page.locator('#status-settings-close').click();await page.setViewportSize({width:795,height:900});
  await initialize('fresh-chat');await emit({type:'agent.defaults',settings});
  assert.equal(await page.evaluate(()=>window.saved.model),'gpt-6-sol','New host snapshots always start from project defaults');
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-preset-select').inputValue(),'Default');
  await chooseModel(page.locator('#model-menu [data-agent-role="main"]'),'claude-opus-5-5');
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();await initialize('fresh-chat','claude-opus-5-5');await emit({type:'agent.defaults',settings});
  assert.equal(await page.evaluate(()=>window.saved.model),'claude-opus-5-5','Restoring a chat keeps its own values');
  await page.locator('#prompt').fill('Check copied settings');await page.locator('#prompt').press('Enter');
  assert.equal((await messages('chat.send')).at(-1).execution.model,'claude-opus-5-5');
  await emit({type:'session.bound',agentId:'bound-chat'});
  await emit({type:'capabilities.updated',capabilities:{...capabilities,send:{model:true,reasoning:true,sessionProvider:'claude'}}});
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#agent-preset-select').isDisabled(),true,'Existing provider-bound session protection remains');
  await page.keyboard.press('Escape');
  await initialize('unconfigured',undefined,{model:undefined,reasoning:undefined,agentModels:{}});
  await emit({type:'agent.defaults',settings:{global:{},project:{},projectAvailable:true,presets:[{scope:'project',name:'Default',isDefault:true,settings:{}}]}});
  await page.locator('#model-button').click();
  assert.ok(!await page.evaluate(()=>window.saved.model),'Opening settings does not invent a model for an unconfigured project');
  await page.evaluate(()=>sessionStorage.removeItem('submission-restoration-fixture'));
  assert.deepEqual(errors,[],'No page errors');
  console.log('Settings-only set management, independent chat copies, empty defaults, restoration, request capture and responsive/theme/keyboard checks passed');
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
