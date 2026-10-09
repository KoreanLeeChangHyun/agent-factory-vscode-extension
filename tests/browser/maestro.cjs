const assert = require('node:assert/strict');
const path = require('node:path');
async function checkMaestro(page) {
  const originalChatPage = page;
  const post = message => originalChatPage.evaluate(message => window.postMessage(message, '*'), message);
  const capability = {model:true,reasoning:true,fast:true,goal:true,taskModes:['direct','orchestrate','work']};
  const init = {type:'host.initialize',panelId:'maestro-panel',agentId:'main-maestro',role:'main',runtimeAvailable:true,botsEnabled:false,botsAvailable:false,companionAvailable:false,executionMode:'workspace-write',capabilities:{submit:capability,send:capability}};
  await post(init);
  await post({type:"execution.updated",mode:"workspace-write"});
  await page.locator('#prompt').fill('Original draft');
  await post({...init,maestroMode:true});
  assert.equal(await page.locator('#prompt').inputValue(),'Original draft');
  await page.locator('#send-button').click();
  const request = await page.evaluate(() => window.sentMessages.filter(value=>value.type==='chat.send').at(-1));
  assert.equal(request.execution.businessMode,'maestro');
  assert.equal(request.execution.taskMode,'orchestrate');
  assert.equal(request.execution.agentPermissions.main,'workspace-write');
  await post({type:'chat.pending',id:request.id});
  await post({...init,maestroMode:false});
  assert.equal(await page.evaluate(()=>window.saved.pendingRequests[0].execution.businessMode),'maestro');
  await post({type:'chat.rejected',id:request.id});
  if (await page.locator('#pending-queue-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#pending-queue-toggle').click();
  await page.locator('[data-queue-recover]').click();
  await page.locator('#send-button').click();
  const retry=await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='chat.send').at(-1));
  assert.equal(retry.id,request.id);
  assert.deepEqual(retry.execution,request.execution,'Recovery retains captured Maestro mode after the toggle is turned off');

  await post({type:'chat.started',id:request.id,text:request.text,attachments:[],submission:{businessMode:'maestro',taskMode:'orchestrate',goal:false,runId:'run-main',acceptedAt:'2026-10-07T20:00:00Z'}});
  const entries=[{id:'flow-one',title:'Integration flow',mainAgentId:'main-maestro',workAgentId:'worker',loopId:'loop-one',status:'active',updatedAt:'2026-10-07T20:00:00Z',tasks:[
    {id:'prior',title:'Prior completed task',workStatus:'completed',runs:[{role:'work',agentId:'worker',runId:'run-prior',status:'completed',receipt:{outcome:'completed'}}]},
    {id:'task-one',title:'Actual runtime task',description:'Original: preserve queue\nInterpretation: connect state\nAssumption: none',completionCriteria:'Runtime connected',workStatus:'running',allocation:{profile:{id:'work',reason:'Integration'},session:{strategy:'reuse',reason:'Same task'},writeScopeReason:'main.ts',dependencies:[{taskId:'prior',source:'receipt',revision:'r1',confirmed:true}],inputs:[{source:request.id,revision:'run-main',capturedAt:'2026-10-07T20:00:00Z',confirmed:true}],sharedResources:[{resource:'main.ts',ownerTaskId:'self',confirmed:true}],parallelCandidate:false},runs:[{role:'work',agentId:'worker',runId:'run-work',parentRunId:'run-main',status:'running',model:'designated-model',attempt:1,usage:{inputTokens:100,cachedInputTokens:20,outputTokens:null,reasoningOutputTokens:null},context:{observedAt:'2026-10-07T20:00:00Z',estimated:true},handoff:{slot:'B',epoch:2}}]}
  ]}];
  assert.equal(await page.locator('#maestro-open, #maestro-mode, #maestro-center').count(),0);
  assert.equal(await page.locator('#timeline').isVisible(),true);
  const chatPage=page;
  page=await chatPage.context().browser().newPage();
  const centerErrors=[];page.on('pageerror',error=>centerErrors.push(error.message));
  await page.addInitScript(()=>{
    window.saved=JSON.parse(sessionStorage.getItem('submission-restoration-fixture')||'null');window.sentMessages=[];
    window.acquireVsCodeApi=()=>({getState:()=>window.saved,setState:value=>{window.saved=value;},postMessage:message=>window.sentMessages.push(message)});
  });
  await page.goto(new URL('/center',chatPage.url()).href);
  const centerPost=message=>page.evaluate(message=>window.dispatchEvent(new MessageEvent('message',{data:message})),message);
  assert.equal(await page.locator('#maestro-refresh').textContent(),'Refresh');
  await centerPost({type:'project.tasks',entries});
  await page.locator('[data-center-task="flow-one/task-one"]').click();
  await page.waitForFunction(()=>document.getElementById('maestro-detail').textContent.includes('designated-model'));
  assert.match(await page.locator('#maestro-detail').textContent(),/inputTokens: 100/);
  assert.match(await page.locator('#maestro-detail').textContent(),/outputTokens: Not recorded/);
  assert.match(await page.locator('#maestro-detail').textContent(),new RegExp(request.id));
  await page.locator('#maestro-detail button').filter({hasText:'prior ·'}).click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'prior');
  await page.locator('[data-center-task="flow-one/task-one"]').click();
  await page.locator('#maestro-detail button').filter({hasText:'Execution records'}).click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='project.task.open').at(-1)),{type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'records'});
  await centerPost({type:'project.tasks',entries:[],error:'Fixture refresh unavailable'});
  await page.waitForFunction(()=>document.getElementById('maestro-observation').textContent.includes('could not be refreshed'));
  assert.match(await page.locator('#maestro-observation').textContent(),/could not be refreshed/);
  assert.equal(await page.locator('[data-center-task="flow-one/task-one"]').count(),1,'Refresh failure preserves known records');
  for (const width of [795,465,320]) {
    await page.setViewportSize({width,height:700});
    for (const theme of ['vscode-dark','vscode-light','vscode-high-contrast']) {
      await page.evaluate(theme=>document.body.className=theme,theme);
      assert.equal(await page.locator('#maestro-center').isVisible(),true);
      assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
      assert.equal(await page.locator('#maestro-refresh').isVisible(),true);
      if (process.env.MAESTRO_EVIDENCE && theme === 'vscode-dark' && width !== 320) await page.screenshot({path:path.join(process.env.MAESTRO_EVIDENCE, 'center-' + width + '.png')});
    }
  }
  await page.locator('#maestro-search').fill('Actual');
  await page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved));});
  await page.reload();
  await centerPost({type:'project.tasks',entries});
  await page.waitForFunction(()=>document.getElementById('maestro-detail').dataset.taskId==='task-one');
  assert.equal(await page.locator('#maestro-search').inputValue(),'Actual');
  await page.locator('#maestro-detail button').filter({hasText:'Add feedback reference'}).click();
  const feedback=await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='project.task.open').at(-1));
  assert.deepEqual(feedback,{type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'feedback'});
  await post({type:'composer.reference',text:'Feedback reference flow-one run-work'});
  assert.match(await chatPage.locator('#prompt').inputValue(),/flow-one/);
  assert.equal(await chatPage.locator('#timeline').isVisible(),true);
  assert.equal(await chatPage.evaluate(id=>window.saved.timeline.filter(value=>value.type==='user'&&value.id===id).length,request.id),1);
  assert.equal(await page.locator('#prompt').count(),0);
  assert.equal(await page.evaluate(()=>window.sentMessages.some(value=>['task.stop','workflow.answer','workflow.decision','run.cancel','chat.send'].includes(value.type))),false);
  assert.deepEqual(centerErrors,[]);
  await page.close();
}
module.exports={checkMaestro};
