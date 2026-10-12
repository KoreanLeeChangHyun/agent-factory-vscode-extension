const assert = require('node:assert/strict');
const path = require('node:path');
async function selectFilter(page, selector, value) {
  if (await page.locator(selector).isHidden()) await page.locator('#maestro-filter-toggle').click();
  if (selector === '#maestro-status') {
    await page.locator('#maestro-status-all').check();
    if (value) await page.locator('#maestro-status-' + value).check();
  } else await page.locator(selector).selectOption(value);
  await page.keyboard.press("Escape");
}
async function checkWorkerControls(page, context) {
  const failures = await page.locator('.maestro-worker-row').evaluateAll(rows => rows.flatMap(row => {
    const cell = row.querySelector('.maestro-worker-cell');
    const badge = cell.querySelector('.maestro-role');
    const role = badge.getBoundingClientRect();
    const model = cell.querySelector('.maestro-worker-model');
    const hide = cell.querySelector('.maestro-worker-hide');
    const open = cell.querySelector('.maestro-session-open');
    const controls = [badge, hide, ...(open && !open.hidden ? [open] : [])];
    const boxes = controls.map(element => element.getBoundingClientRect());
    const bounds = cell.getBoundingClientRect();
    const errors = [];
    const modelBox = model.getBoundingClientRect();
    if (role.bottom > modelBox.top + 1 || Math.abs(role.left - modelBox.left) > 1) errors.push('role above model');
    for (let index = 1; index < boxes.length; index++) {
      const previous = boxes[index - 1], current = boxes[index];
      if (Math.abs(current.left - previous.right - 2) > 1 || Math.abs((current.top + current.bottom - previous.top - previous.bottom) / 2) > 1) errors.push('aligned 2px gaps');
      if (Math.abs(current.width - 18) > 1 || current.left < bounds.left - 1 || current.right > bounds.right + 1) errors.push('unclipped icons');
    }
    if (badge.nextElementSibling !== hide || (open && hide.nextElementSibling !== open) || model.previousElementSibling !== badge.parentElement) errors.push('focus order');
    if (open?.hidden && (open.getBoundingClientRect().width || getComputedStyle(open).display !== 'none')) errors.push('hidden open leaves a gap');
    const label = model.querySelector('.maestro-model-label');
    if (label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow !== 'ellipsis') errors.push('model ellipsis');
    return errors.map(error => (row.dataset.centerWorker || row.dataset.teamWorker) + ': ' + error);
  }));
  assert.deepEqual(failures, [], context + ': role, hide, open above model');
}
// Column 1 has its own check so concurrent title, time and animation work cannot mask its result.
async function checkWorkerCellOrder(page, post) {
  const entries = [
    {id:'cell-flow', mainAgentId:'cell-main', status:'active', tasks:[{id:'cell-task', title:'Current task', workStatus:'running',
      runs:[{role:'work',workProfile:'work',agentId:'cell-worker',runId:'cell-run',status:'running',model:'model-with-a-very-long-recorded-name'}]}]},
    {id:'cell-missing-main', status:'completed', tasks:[{id:'cell-completed', title:'Latest task', workStatus:'completed',
      runs:[{role:'work',workProfile:'work',agentId:'cell-no-session',runId:'cell-no-session-run',status:'completed',model:'short-model'}]}]}
  ];
  await post({type:'project.tasks',entries,team:{status:'ok',workers:[{agentId:'cell-team',role:'work',workProfile:'work',availability:'idle',removed:false,
    current:[],queued:[],failed:[],holds:[],taskCounts:{},runCount:1,latestRun:{runId:'cell-team-run',status:'completed',model:'team-model'}}]}});
  await page.locator('#maestro-scope-all').click();
  await page.locator('.maestro-section-toggle').evaluateAll(toggles=>{
    const team=toggles.find(toggle=>toggle.dataset.centerGroup===JSON.stringify(['team-only']));
    if (team?.getAttribute('aria-expanded')==='false') team.click();
  });
  assert.equal(await page.locator('.maestro-worker-row').count(),3,'Includes regular, missing-session and team-only workers');
  for (const width of [1100,783,600,465,360,320]) {
    await page.setViewportSize({width,height:650});
    for (const theme of ['vscode-dark','vscode-light','vscode-high-contrast']) {
      await page.evaluate(theme=>{
        document.body.className=theme;
        const colors=theme==='vscode-light'?['#fff','#333','#f3f3f3','#bbb']:theme==='vscode-high-contrast'?['#000','#fff','#000','#fff']:['#1e1e1e','#d4d4d4','#252526','#454545'];
        for(const [index,key] of ['--vscode-editor-background','--vscode-foreground','--vscode-editorWidget-background','--vscode-panel-border'].entries())document.documentElement.style.setProperty(key,colors[index]);
      },theme);
      await checkWorkerControls(page, width+'px '+theme);
      assert.ok(await page.locator('.maestro-worker-model').evaluateAll(models=>models.every(model=>model.getBoundingClientRect().width>20)), 'Model remains readable');
      if (process.env.WORKER_CELL_EVIDENCE && [1100,320].includes(width)) await page.screenshot({path:path.join(process.env.WORKER_CELL_EVIDENCE,'worker-cell-'+theme+'-'+width+'.png')});
    }
  }
  const worker = page.locator('[data-center-worker="cell-worker"]');
  for (const key of ['Tab','ArrowDown']) {
    await worker.locator('.maestro-worker-hide').focus();
    for (const selector of ['.maestro-session-open','.maestro-worker-model','.maestro-worker-select']) {
      await page.keyboard.press(key);
      assert.equal(await worker.locator(selector).evaluate(element=>element===document.activeElement),true,key+': '+selector);
    }
  }
  await worker.locator('.maestro-worker-model').press('ArrowUp');
  assert.equal(await worker.locator('.maestro-session-open').evaluate(element=>element===document.activeElement),true,'Up reaches open above model');
  await page.keyboard.press('ArrowUp');
  assert.equal(await worker.locator('.maestro-worker-hide').evaluate(element=>element===document.activeElement),true);
  for (const selector of ['[data-center-worker="cell-no-session"]','[data-team-worker="cell-team"]']) {
    const row = page.locator(selector);
    await row.locator('.maestro-worker-hide').press('ArrowDown');
    assert.equal(await row.locator('.maestro-worker-select').evaluate(element=>element===document.activeElement),true,'Unavailable controls are skipped');
  }
  for (const selector of ['.maestro-session-open','.maestro-worker-model']) {
    await worker.locator(selector).click();
    assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(message=>message.type==='project.task.open').at(-1)),
      {type:'project.task.open',workflowId:'cell-flow',taskId:'cell-task',target:'run',agentId:'cell-worker',runId:'cell-run'},'Session target is preserved');
  }
  await worker.locator('.maestro-worker-hide').click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(message=>message.type==='worker.visibility').at(-1)),
    {type:'worker.visibility',agentId:'cell-worker',hidden:true},'Hide retains its display-only action');
}
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
    // The Maestro fixture isolates worker controls from the separately tested conductor queue module.
    window.AgentFactoryChat=window.AgentFactoryChat||{};
    window.AgentFactoryChat.conductorQueue=()=>({receive(){}});
    window.saved=JSON.parse(sessionStorage.getItem('submission-restoration-fixture')||'null');window.sentMessages=[];
    window.acquireVsCodeApi=()=>({getState:()=>window.saved,setState:value=>{window.saved=value;},postMessage:message=>window.sentMessages.push(message)});
  });
  await page.goto(new URL((process.argv.includes('--request-view-only') || process.argv.includes('--worker-display-only')) ? '/center?lang=ko' : '/center',chatPage.url()).href);
  const centerPost=message=>page.evaluate(message=>window.dispatchEvent(new MessageEvent('message',{data:message})),message);
  if (process.argv.includes('--worker-detail-only')) {
    await checkWorkerControl(page, centerPost);
    assert.deepEqual(centerErrors, []);
    await page.close(); return;
  }
  if (process.argv.includes('--no-match-only')) {
    await checkNoMatch(page, centerPost, entries);
    assert.deepEqual(centerErrors, [], 'Empty states render without page errors');
    await page.close(); return;
  }
  if (process.argv.includes('--worker-status-time-only')) {
    await checkWorkerStatusTime(page, centerPost);
    assert.deepEqual(centerErrors, []);
    await page.close(); return;
  }
  if (process.env.MAESTRO_COLUMN2_ONLY) {
    await checkWorkerColumn2(page, centerPost);
    assert.deepEqual(centerErrors, [], 'Column 2 renders without page errors');
    await page.close(); return;
  }
  if (process.argv.includes('--worker-row-motion-only')) {
    await checkWorkerRowMotion(page, centerPost);
    assert.deepEqual(centerErrors, []);
    await page.close(); return;
  }
  if (process.argv.includes('--worker-cell-order-only')) {
    await checkWorkerCellOrder(page, centerPost);
    assert.deepEqual(centerErrors, [], 'Worker cells caused a browser error');
    await page.close(); return;
  }
  if (process.argv.includes('--worker-display-only')) {
    await checkWorkerStatusTime(page, centerPost);
    await checkWorkerDisplay(page, centerPost);
    assert.deepEqual(centerErrors, []);
    await page.close(); return;
  }
  if (process.argv.includes('--request-view-only')) {
    await checkRequestView(page, centerPost);
    assert.deepEqual(centerErrors, []);
    await page.close();
    return;
  }
  assert.equal(await page.locator('#maestro-refresh').getAttribute('aria-label'),'Refresh');
  assert.equal(await page.locator('#maestro-workers-view').getAttribute('aria-selected'),'true');
  // The center shares Main's surface and accent: same computed colours under the same theme variables.
  const mainSurface=await chatPage.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor);
  assert.equal(await page.locator('#maestro-center').evaluate(element=>getComputedStyle(element).backgroundColor),mainSurface);
  await centerPost({type:'project.tasks',entries});
  assert.deepEqual(centerErrors,[],'The Control Center must render without a page exception');
  // The earlier checks look at every worker; the active scope (the first-visit default when work is active) has its own check.
  if (await page.locator('#maestro-scope-all').isVisible()) await page.locator('#maestro-scope-all').click();
  const workerTabCount=await page.locator('#maestro-workers-count').textContent();
  assert.equal(workerTabCount,'1','The worker tab counts unique workers, not assignments; selected='+await page.locator('#maestro-workers-view').getAttribute('aria-selected')+' scope='+await page.locator('#maestro-scope-switch').isVisible()+' centerErrors='+JSON.stringify(centerErrors));
  assert.equal(await page.locator('#maestro-observation').count(),0,'The separate observation line is removed');
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'list','No empty detail pane before a selection');
  assert.equal(await page.locator('#maestro-detail').isHidden(),true);
  await page.locator('[data-select-worker=\"worker\"]').click();
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'split');
  await openWorkerTask(page,'flow-one/task-one','worker');
  await page.waitForFunction(()=>document.getElementById('maestro-detail').textContent.includes('designated-model'));
  assert.match(await page.locator('#maestro-detail').textContent(),/inputTokens: 100/);
  assert.match(await page.locator('#maestro-detail').textContent(),/outputTokens: Not recorded/);
  assert.match(await page.locator('#maestro-detail').textContent(),new RegExp(request.id));
  assert.equal(await page.locator('#maestro-detail pre').first().isVisible(),false,'Exact records stay collapsed by default');
  await page.locator('#maestro-detail summary').filter({hasText:'Assignment and session'}).click();
  await page.locator('#maestro-detail button').filter({hasText:'prior ·'}).click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'prior');
  await page.getByRole('button',{name:'Back to agent',exact:true}).click();
  await openWorkerTask(page,'flow-one/task-one','worker');
  await page.locator('#maestro-detail button').filter({hasText:'Execution records'}).click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='project.task.open').at(-1)),{type:'project.task.open',workflowId:'flow-one',taskId:'task-one',target:'records'});
  await centerPost({type:'project.tasks',entries:[],error:'Fixture refresh unavailable'});
  await page.waitForFunction(()=>document.querySelector('#maestro-tasks .maestro-error')?.textContent.includes('could not be refreshed'));
  assert.match(await page.locator('#maestro-tasks .maestro-error').textContent(),/could not be refreshed/);
  assert.equal(await page.locator('[data-center-worker="worker"]').count(),1,'Refresh failure preserves known records');
  for (const [width,height] of [[795,700],[465,556],[721,402],[320,556]]) {
    await page.setViewportSize({width,height});
    for (const theme of ['vscode-dark','vscode-light','vscode-high-contrast']) {
      await page.evaluate(theme=>{
        document.body.className=theme;
        const colors=theme==='vscode-light'?['#fff','#333','#f3f3f3','#bbb']:theme==='vscode-high-contrast'?['#000','#fff','#000','#fff']:['#1e1e1e','#d4d4d4','#252526','#454545'];
        for(const [index,key] of ['--vscode-editor-background','--vscode-foreground','--vscode-editorWidget-background','--vscode-panel-border'].entries())document.documentElement.style.setProperty(key,colors[index]);
      },theme);
      assert.equal(await page.locator('#maestro-center').isVisible(),true);
      assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
      assert.equal(await page.locator('#maestro-refresh').isVisible(),true);
      if (process.env.WORKER_COUNT_EVIDENCE && (width===795 || width===320) && theme==='vscode-dark') await page.screenshot({path:path.join(process.env.WORKER_COUNT_EVIDENCE,'control-center-worker-count-20261010-140414-'+width+'.png')});
      // Narrow splits show the opened detail in place of the list.
      assert.equal(await page.locator('#maestro-tasks').isVisible(),width>=760);
    }
  }
  await page.setViewportSize({width:795,height:700});
  const updated=JSON.parse(JSON.stringify(entries));
  updated[0].tasks[1].workStatus='completed';updated[0].tasks[1].runs[0].status='completed';updated[0].tasks[1].runs[0].receipt={outcome:'completed'};
  await centerPost({type:'project.tasks',entries:updated});
  // The worker row summarises its latest task; with both tasks finished it shows Completed.
  await page.waitForFunction(()=>document.querySelector('[data-center-worker="worker"] .maestro-worker-status .maestro-state').textContent==='Completed');
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
  await checkWorkerRowMotion(page, centerPost);
  await checkWorkers(page, centerPost, chatPage);
  assert.deepEqual(centerErrors,[]);
  await checkDomainEditing(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerControl(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerDrag(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerStatusTime(page, centerPost);
  await checkWorkerColumns(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerNames(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerReorder(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkPaneSplitter(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkTeamView(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await page.close();
}
module.exports={checkMaestro};

async function checkNoMatch(page, post, entries) {
  for (const language of ['en', 'ko']) {
    await page.goto(new URL('/center?lang=' + language, page.url()).href);
    const empty = page.locator('#maestro-tasks .maestro-empty');
    const loading = language === 'en' ? 'Reading runtime records…' : '런타임 기록 조회 중…';
    const noRecords = language === 'en' ? 'No task records in this project yet' : '이 프로젝트에 작업 기록이 아직 없습니다';
    assert.equal(await empty.locator('p').textContent(), loading);
    await post({type:'project.tasks', entries:[]});
    assert.equal(await empty.locator('p').textContent(), noRecords);
    await post({type:'project.tasks', entries});
    await page.locator('#maestro-scope-all').click();
    for (const view of ['workers', 'tasks']) {
      await page.locator('#maestro-' + view + '-view').click();
      await page.locator('#maestro-search').fill('unmatched-fixture-needle');
      assert.equal(await page.locator('#maestro-tasks').evaluate(el => el.childElementCount), 0, 'No text, controls or placeholder box remains');
      await page.locator('#maestro-refresh').click();
      assert.equal(await empty.locator('p').textContent(), loading, 'Loading remains visible with unmatched records');
      await post({type:'project.tasks', entries});
      assert.equal(await page.locator('#maestro-tasks').evaluate(el => el.childElementCount), 0);
      await page.locator('#maestro-search').fill('');
      assert.ok(await page.locator('#maestro-tasks').evaluate(el => el.childElementCount) > 0, 'Clearing search restores records');
    }
    await page.locator('#maestro-workers-view').click();
    await post({type:'project.tasks', entries:[{...entries[0], status:'completed', tasks:[entries[0].tasks[0]]}]});
    await page.locator('#maestro-scope-active').click();
    assert.equal(await empty.locator('p').textContent(), language === 'en' ? 'No agent is running, queued, waiting for a decision or failed.' : '실행 중·대기·결정 필요·실패 상태인 수행자가 없습니다.');
    assert.ok(await empty.locator('button').count() > 0, 'Active scope retains its show-all action');
    await page.reload();
    await post({type:'project.tasks', entries:[], error:'Fixture unavailable'});
    assert.match(await empty.locator('p').textContent(), /Fixture unavailable/, 'Initial error remains visible');
  }
}
// 240 workers with team records: active work first, real models, titles, wait reasons; everyone reachable; the reading
// position, selection, open groups, filters and pane width survive refreshes, additions, reordering and removals.
function teamFixture(now, {extra=[], drop=[]}={}) {
  const at=minutes=>new Date(now-minutes*60_000).toISOString(), by={actor:'human',at:at(1),source:'control-center'};
  const domains=['도메인-A','도메인-B','도메인-C','도메인-D','도메인-E','도메인-F'].map((name,index)=>({id:'domain-'+String(index).repeat(12).slice(0,12).replace(/./g,()=>'abcdef'[index]),name,aliases:[],createdBy:by,nameSetBy:by}));
  const kinds=index=>index<5?'running':index<8?'waiting':index<10?'decision':index<12?'failed':'completed';
  const ids=[...Array.from({length:240},(_,index)=>'team-w'+String(index).padStart(3,'0')),...extra].filter(id=>!drop.includes(id));
  const entries=[],workers=[],assignments={};
  ids.forEach((agent,index)=>{
    const kind=kinds(index), model=index%7===6?undefined:['claude-opus-5-5','gpt-6.1-sol','gpt-6-luna'][index%3];
    const status={running:'running',waiting:'pending',decision:'blocked',failed:'failed',completed:'completed'}[kind];
    const runStatus={running:'running',waiting:'queued',decision:'needs-human-decision',failed:'failed',completed:'completed'}[kind];
    const run={role:'work',agentId:agent,runId:'run-'+agent,status:runStatus,...(model?{model}:{}),workProfile:'work',startedAt:at(30+index),...(kind==='running'||kind==='waiting'?{}:{finishedAt:at(20+index)}),
      ...(kind==='completed'?{receipt:{outcome:'completed'},result:{availability:index%5===0?'missing':'recorded',summary:'결과 '+agent}}:{}),request:{availability:'recorded'}};
    entries.push({id:'flow-'+agent,title:agent,status:kind==='completed'||kind==='failed'?'completed':kind==='decision'?'needs-human-decision':'active',mainAgentId:'main-team',loopId:'loop-'+agent,workAgentId:agent,latestWorkRunId:run.runId,updatedAt:at(index),
      tasks:[{id:'task-'+agent,title:'작업 '+agent+' 제목은 길어도 읽을 수 있어야 함',workAgentId:agent,workStatus:status,runs:[run],commands:[]}]});
    assignments[agent]={domainId:domains[index%6].id,setBy:by};
    const availability={running:'busy',waiting:'queued',decision:'waiting-human',failed:'idle',completed:'idle'}[kind];
    const ref={workflowId:'flow-'+agent,taskId:'task-'+agent,title:'작업 '+agent,state:kind==='running'?'current':kind==='waiting'?'queued':kind==='decision'?'waiting-human':kind};
    workers.push({agentId:agent,role:'work',workProfile:'work',provider:'claude',...(model?{model}:{}),availability,removed:false,domain:{domainId:domains[index%6].id,name:domains[index%6].name},
      current:kind==='running'||kind==='decision'?[ref]:[],queued:kind==='waiting'?[ref]:[],failed:kind==='failed'?[ref]:[],
      holds:kind==='decision'?[{kind:'waiting-human',source:'run',runStatus:'needs-human-decision'}]:kind==='waiting'?[{kind:'queued',source:'loop'}]:kind==='failed'?[{kind:'failed',source:'loop',phase:'control-plane-error'}]:kind==='running'?[{kind:'busy',source:'loop'}]:[],
      latestRun:{runId:run.runId,status:runStatus,...(model?{model}:{}),updatedAt:at(index),report:kind==='completed'?(index%5===0?'missing':'present'):'pending',receipt:kind==='completed'?'present':'pending'},taskCounts:{[kind]:1},runCount:1});
  });
  for (const id of ['team-direct-1','team-direct-2','team-direct-3','team-direct-4']) workers.push({agentId:id,role:'verification',provider:'codex',model:'gpt-6-astra',availability:'idle',removed:false,current:[],queued:[],failed:[],holds:[],
    latestRun:{runId:'run-'+id,status:'completed',model:'gpt-6-astra',updatedAt:at(900),trigger:'untracked',report:id.endsWith('4')?'missing':'present',receipt:'present'},taskCounts:{unknown:1},runCount:1});
  return {type:'project.tasks',entries,domains:{revision:7,domains,assignments,removedWorkers:{}},team:{status:'ok',workers}};
}
async function checkTeamView(page, post) {
  const now=Date.now();
  await page.setViewportSize({width:1200,height:760});
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-scope', '');await selectFilter(page, '#maestro-domain', '');
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  await post(teamFixture(now));
  // Active scope: the 12 workers to watch (running, queued, waiting for a decision, failed), with real model, title and why.
  await page.locator('#maestro-scope-active').click();
  assert.equal(await page.locator('#maestro-scope-active').textContent(),'Active · attention 12');
  assert.equal(await page.locator('#maestro-scope-all').textContent(),'All 244','Every worker counts, including those with team records only');
  assert.equal(await page.locator('.maestro-worker-row[data-center-worker]').count(),12);
  const decision=page.locator('[data-center-worker="team-w008"]');
  assert.deepEqual(await decision.evaluate(row=>[row.querySelector('.maestro-model-label').textContent,row.querySelector('.maestro-worker-purpose').textContent,row.querySelector('.maestro-worker-status .maestro-state').dataset.status,row.querySelector('.maestro-worker-wait')?.textContent]),
    ['gpt-6-luna','작업 team-w008 제목은 길어도 읽을 수 있어야 함','decision','Waiting for your decision']);
  assert.equal(await page.locator('[data-center-worker="team-w005"] .maestro-worker-wait').textContent(),'Queued behind earlier work');
  assert.equal(await page.locator('[data-center-worker="team-w010"] .maestro-worker-failed').textContent(),'1 failed','A failed loop is visible on its worker');
  assert.equal(await page.locator('[data-center-worker="team-w006"] .maestro-model-label').textContent(),'claude · default model','Without a recorded model only the recorded provider is named, never a guessed model');
  // A search looks at everyone even in the active scope; switching to all lists every worker plus the team-only group.
  await page.locator('#maestro-search').fill('team-w199');
  assert.equal(await page.locator('[data-center-worker="team-w199"]').count(),1);
  await page.locator('#maestro-search').fill('');
  await page.locator('#maestro-scope-all').click();
  assert.equal(await page.locator('.maestro-worker-row[data-center-worker]').count(),240);
  assert.equal(await page.locator('.maestro-section-toggle[data-center-group="[\\"team-only\\"]"]').count(),1);
  await page.locator('.maestro-section-toggle[data-center-group="[\\"team-only\\"]"]').click();
  assert.equal(await page.locator('[data-team-worker]').count(),4);
  await checkWorkerControls(page, 'Team-only workers');
  const teamRow=page.locator('[data-team-worker="team-direct-4"]');
  await teamRow.locator('.maestro-worker-hide').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await teamRow.locator('.maestro-worker-select').evaluate(element=>element===document.activeElement),true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await teamRow.locator('.maestro-worker-hide').evaluate(element=>element===document.activeElement),true,'Static team model labels are skipped');
  assert.equal(await page.locator('[data-team-worker="team-direct-4"] [data-document]').count(),0);
  await page.locator('[data-team-worker="team-direct-4"] .maestro-worker-select').click();
  assert.deepEqual(await page.locator('#maestro-detail > .maestro-worker-docs [data-document]').evaluateAll(items=>items.map(item=>item.dataset.document+':'+(item.tagName==='BUTTON'?'open':item.textContent))),['request:open','result:No report','receipt:open']);
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  await page.locator('[data-team-worker="team-direct-1"] .maestro-worker-select').click();
  await page.locator('#maestro-detail > .maestro-worker-docs [data-document="receipt"]').click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='team.run.open').at(-1)),{type:'team.run.open',agentId:'team-direct-1',runId:'run-team-direct-1',document:'receipt'});
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  // Reading position: scroll into the middle, then refresh with new workers added above and a different order.
  const list=page.locator('#maestro-tasks');
  await list.evaluate(node=>{node.scrollTop=node.scrollHeight*0.45;});
  const anchor=await list.evaluate(node=>{const top=node.getBoundingClientRect().top;const row=[...node.querySelectorAll('[data-center-worker]')].find(item=>item.getBoundingClientRect().bottom>top+1);return {id:row.dataset.centerWorker,offset:row.getBoundingClientRect().top-top};});
  await post(teamFixture(now,{extra:['team-new-000','team-new-001','team-new-002']}));
  const after=await list.evaluate((node,id)=>{const row=node.querySelector('[data-center-worker="'+id+'"]');return row.getBoundingClientRect().top-node.getBoundingClientRect().top;},anchor.id);
  assert.ok(Math.abs(after-anchor.offset)<=2,'The row being read stays in place across a refresh with additions '+JSON.stringify({anchor,after}));
  // The row being read disappears: its next neighbour stays where it was on screen instead of a jump to the top.
  const {neighbour,neighbourOffset}=await list.evaluate((node,id)=>{const rows=[...node.querySelectorAll('[data-center-worker]')];const index=rows.findIndex(row=>row.dataset.centerWorker===id);return {neighbour:rows[index+1].dataset.centerWorker,neighbourOffset:rows[index+1].getBoundingClientRect().top-node.getBoundingClientRect().top};},anchor.id);
  await post(teamFixture(now,{extra:['team-new-000','team-new-001','team-new-002'],drop:[anchor.id]}));
  const replaced=await list.evaluate((node,id)=>{const row=node.querySelector('[data-center-worker="'+id+'"]');return row.getBoundingClientRect().top-node.getBoundingClientRect().top;},neighbour);
  assert.ok(Math.abs(replaced-neighbourOffset)<=2&&await list.evaluate(node=>node.scrollTop>0),'The neighbour keeps its reading position '+JSON.stringify({replaced,neighbourOffset}));
  // An unchanged read keeps the very same DOM (no rebuild, no focus jump).
  const marker=await page.locator('[data-center-worker="'+neighbour+'"]').evaluate(row=>{row.dataset.probe='kept';return row.dataset.probe;});
  await post({type:'project.tasks.unchanged'});
  assert.equal(await page.locator('[data-center-worker="'+neighbour+'"]').getAttribute('data-probe'),marker);
  // Selection, detail, collapsed group, filter and pane width survive refreshes.
  await page.locator('[data-select-worker="'+neighbour+'"]').click();
  await page.locator('#maestro-splitter').focus();await page.keyboard.press('ArrowLeft');
  const width=await page.evaluate(()=>window.saved.centerListWidth);
  const domainB=await page.locator('.maestro-domain-toggle').nth(1).getAttribute('data-center-group');
  await page.locator('.maestro-domain-toggle').nth(1).click();
  await selectFilter(page, '#maestro-status', '');
  await post(teamFixture(now,{extra:['team-new-000','team-new-001','team-new-002','team-new-003'],drop:[anchor.id]}));
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),neighbour,'The opened worker stays open');
  assert.equal(await page.evaluate(()=>window.saved.centerListWidth),width);
  assert.equal(await page.locator('.maestro-domain-toggle[data-center-group="'+domainB.replace(/"/g,'\\"')+'"]').getAttribute('aria-expanded'),'false','A collapsed group stays collapsed');
  await page.locator('.maestro-domain-toggle[data-center-group="'+domainB.replace(/"/g,'\\"')+'"]').click();
  // Team history: requested for the opened worker; a reply to a superseded request is dropped, the latest is shown.
  const requests=await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='team.history.request'));
  const latest=requests.filter(value=>value.agentId===neighbour).at(-1);
  assert.ok(latest,'History is requested for the opened worker');
  await post({type:'team.history',requestId:latest.requestId-1,history:{status:'ok',agentId:neighbour,tasks:[{taskId:'stale',title:'Stale reply',state:'completed',runs:[]}]}});
  assert.doesNotMatch(await page.locator('#maestro-detail').textContent(),/Stale reply/,'An older reply is dropped');
  await post({type:'team.history',requestId:latest.requestId,history:{status:'ok',agentId:neighbour,tasks:[
    {workflowId:'flow-x',taskId:'task-now',title:'Current work '+'with a long recorded request title '.repeat(8),state:'current',runs:[{runId:'run-2',status:'running',model:'claude-opus-5-5',trigger:'steering',report:'pending',receipt:'pending'}]},
    {workflowId:'flow-y',taskId:'task-old',title:'Earlier work',state:'completed',runs:[{runId:'run-1',status:'completed',model:'gpt-6-luna',trigger:'initial',report:'missing',receipt:'present'}]}]}});
  const history=page.locator('#maestro-detail .maestro-team-history');
  // One history: the worker's recorded task and the two team-only tasks, each once, current work apart from the rest.
  assert.match(await history.textContent(),/3 tasks · 3 runs/);
  assert.deepEqual(await history.locator('.maestro-team-group h4').allTextContents(),['Current · 1','History · 2'],'Current work apart from the accumulated history');
  assert.equal(await page.locator('#maestro-detail .maestro-team-history').count(),1,'Task history and team runs are one section');
  assert.deepEqual(await history.locator('[data-team-run="run-1"] [data-document]').evaluateAll(items=>items.map(item=>item.dataset.document+':'+(item.tagName==='BUTTON'?'open':item.textContent))),['request:open','result:No report','receipt:open']);
  assert.match(await history.locator('[data-team-run="run-2"]').textContent(),/Added instruction.*claude-opus-5-5/);
  // Long recorded titles ellipsize inside the detail column; neither history block widens the pane.
  assert.ok(await page.locator('#maestro-detail').evaluate(detail=>detail.scrollWidth<=detail.clientWidth+1),'The detail does not scroll sideways for long history titles');
  // A runtime without team records: a plain note in the detail; the list and its task history still work.
  await post({...teamFixture(now),team:{status:'unsupported'}});
  assert.match(await page.locator('#maestro-detail .maestro-team-history').textContent(),/installed plugin has no team records/);
  assert.ok(await page.locator('.maestro-worker-row[data-center-worker]').count()>=240);
  // Widths: 889 (split, list wider by default), narrow and wide: no overflow; the title column keeps readable room.
  await post(teamFixture(now));
  await page.locator('#maestro-splitter').focus();await page.keyboard.press('Home');
  for (const width of [1400,889,600,360]) {
    await page.setViewportSize({width,height:760});await page.waitForTimeout(60);
    const layout=await page.evaluate(()=>{const space=document.getElementById('maestro-workspace'),list=document.getElementById('maestro-tasks');const title=list.querySelector('.maestro-worker-title');
      return {overflow:space.scrollWidth>space.clientWidth+1||list.scrollWidth>list.clientWidth+1,title:title?Math.round(title.getBoundingClientRect().width):0,listShown:getComputedStyle(list).display!=='none'};});
    assert.equal(layout.overflow,false,width+': no overflow '+JSON.stringify(layout));
    if (width===889) assert.ok(layout.title>=140,'889: the title column keeps readable room beside the detail '+JSON.stringify(layout));
    if (process.env.TEAM_VIEW_EVIDENCE) await page.screenshot({path:path.join(process.env.TEAM_VIEW_EVIDENCE,'after-20261012-team-view-fixture-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:760});
  await page.getByRole('button',{name:'Back to list',exact:true}).click().catch(()=>{});
}
// The boundary between the list and the opened detail is draggable (pointer), adjustable by keyboard, bounded, kept in the
// saved UI state, and restorable to the default; it never fights the row drag, and nothing overflows.
async function checkPaneSplitter(page, post) {
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString();
  const task=(id,agent,title)=>({id,title,workAgentId:agent,workStatus:'completed',runs:[{role:'work',agentId:agent,runId:'run-'+id,status:'completed',model:'claude-opus-5-5',finishedAt:at(5),receipt:{outcome:'completed'},result:{availability:'recorded',summary:'결과 '+title}}],commands:[]});
  const entries=['a','b','c'].map(id=>({id:'flow-'+id,title:id,status:'completed',mainAgentId:'main-a',loopId:'loop-'+id,workAgentId:'split-'+id,updatedAt:at(1),tasks:[task('t-'+id,'split-'+id,'긴 제목을 가진 작업 '+id+' 분할 경계 조절 확인용')]}));
  await page.setViewportSize({width:889,height:700});
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries,domains:{revision:1,domains:[],assignments:{},removedWorkers:{}}});
  const splitter=page.locator('#maestro-splitter');
  assert.equal(await splitter.isHidden(),true,'No splitter while no detail is open');
  await page.locator('[data-select-worker="split-a"]').click();
  assert.equal(await splitter.isVisible(),true);
  assert.deepEqual(await splitter.evaluate(node=>[node.getAttribute('role'),node.getAttribute('aria-orientation'),node.tabIndex,Boolean(node.getAttribute('aria-label'))]),['separator','vertical',0,true]);
  const widths=()=>page.evaluate(()=>{const list=document.getElementById('maestro-tasks').getBoundingClientRect(),detail=document.getElementById('maestro-detail').getBoundingClientRect(),bar=document.getElementById('maestro-splitter').getBoundingClientRect(),space=document.getElementById('maestro-workspace');
    const title=document.querySelector('.maestro-worker-title');return {list:Math.round(list.width),detail:Math.round(detail.width),bar:Math.round(bar.width),title:Math.round(title.getBoundingClientRect().width),fits:Math.round(list.width+bar.width+detail.width)<=space.clientWidth+1,overflow:space.scrollWidth>space.clientWidth+1,listOverflow:document.getElementById('maestro-tasks').scrollWidth>document.getElementById('maestro-tasks').clientWidth+1};});
  const initial=await widths();
  assert.ok(initial.fits&&!initial.overflow&&!initial.listOverflow,'Default split fits '+JSON.stringify(initial));
  const centre=async()=>{const box=await splitter.boundingBox();return {x:box.x+box.width/2,y:box.y+box.height/2};};
  // The default gives the list most of the room (3:2); pointer drag: left narrows the list (and its title column), right widens it.
  assert.ok(initial.list>initial.detail&&initial.detail>=340,'The list gets the larger default share '+JSON.stringify(initial));
  let c=await centre();await page.mouse.move(c.x,c.y);await page.mouse.down();await page.mouse.move(c.x-200,c.y,{steps:6});await page.mouse.up();
  const narrower=await widths();
  assert.ok(narrower.list<initial.list-150&&narrower.detail>initial.detail+150&&narrower.title<initial.title,'Dragging left narrows the list and its title '+JSON.stringify({initial,narrower}));
  assert.ok(narrower.fits&&!narrower.overflow&&!narrower.listOverflow,'No overflow after narrowing '+JSON.stringify(narrower));
  c=await centre();await page.mouse.move(c.x,c.y);await page.mouse.down();await page.mouse.move(c.x+120,c.y,{steps:6});await page.mouse.up();
  const wider=await widths();
  assert.ok(wider.list>narrower.list+100&&wider.detail<narrower.detail-100&&wider.title>narrower.title,'Dragging right widens it '+JSON.stringify({narrower,wider}));
  // Bounds: neither pane can be dragged below its minimum, and the detail keeps room.
  c=await centre();await page.mouse.move(c.x,c.y);await page.mouse.down();await page.mouse.move(c.x-2000,c.y,{steps:4});await page.mouse.up();
  const least=await widths();assert.equal(least.list,280,'The list keeps its minimum width');
  c=await centre();await page.mouse.move(c.x,c.y);await page.mouse.down();await page.mouse.move(c.x+2000,c.y,{steps:4});await page.mouse.up();
  await splitter.focus();await page.keyboard.press('End');
  const most=await widths();assert.ok(most.detail>=340&&most.fits&&!most.overflow&&!most.listOverflow,'At the largest list width the detail keeps its minimum and nothing overflows '+JSON.stringify(most));
  // The chosen width is kept in the saved UI state and survives a re-render (new data) and closing/reopening the detail.
  assert.equal(await page.evaluate(()=>window.saved?.centerListWidth),most.list,'Saved with the UI state');
  await post({type:'project.tasks',entries,domains:{revision:2,domains:[],assignments:{},removedWorkers:{}}});
  assert.equal((await widths()).list,most.list,'Kept after a refresh');
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  await page.locator('[data-select-worker="split-b"]').click();
  assert.equal((await widths()).list,most.list,'Kept after reopening a detail');
  // Keyboard: arrows move by 24px (4x with Shift), End/Home go to the limit / the default; focus stays on the splitter.
  await splitter.focus();
  const before=(await widths()).list;await page.keyboard.press('ArrowLeft');
  assert.equal((await widths()).list,before-24,'ArrowLeft narrows the list by one step');
  await page.keyboard.press('ArrowRight');assert.equal((await widths()).list,before,'ArrowRight widens it back');
  await page.keyboard.press('Shift+ArrowLeft');assert.equal((await widths()).list,before-96,'Shift moves four steps');
  await page.keyboard.press('End');assert.ok((await widths()).detail>=340&&(await widths()).fits,'End gives the list its largest width');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'maestro-splitter','Focus stays on the splitter');
  // Home and double-click restore the default width and clear the saved choice.
  await page.keyboard.press('Home');
  assert.deepEqual([(await widths()).list,await page.evaluate(()=>window.saved?.centerListWidth)],[initial.list,undefined],'Home restores the default');
  await page.keyboard.press('ArrowRight');assert.ok(await page.evaluate(()=>Number.isFinite(window.saved?.centerListWidth)));
  await splitter.dblclick();
  assert.deepEqual([(await widths()).list,await page.evaluate(()=>window.saved?.centerListWidth)],[initial.list,undefined],'Double-click restores the default');
  // A row can still be dragged: grabbing a row moves the worker, not the boundary.
  const rowBefore=(await widths()).list;await page.locator('[data-center-worker="split-a"] .maestro-role').dragTo(page.locator('[data-center-worker="split-c"] .maestro-role'));
  assert.equal((await widths()).list,rowBefore,'Dragging a row does not resize the panes');
  // A saved width is clamped when the window shrinks, and nothing overflows at any width.
  await page.keyboard.press('Escape');
  await splitter.focus();await page.keyboard.press('End');
  for (const width of [1200,889,760,600]) {
    await page.setViewportSize({width,height:700});await page.waitForTimeout(80);
    const layout=await widths();
    if (width>=760) assert.ok(layout.list>=280&&layout.detail>=340&&layout.fits&&!layout.overflow,width+': both panes stay usable '+JSON.stringify(layout));
    else assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('maestro-splitter')).display),'none',width+': below the split breakpoint the detail replaces the list and the splitter is gone');
    if (process.env.PANE_SPLIT_EVIDENCE&&width===889) await page.screenshot({path:path.join(process.env.PANE_SPLIT_EVIDENCE,'after-20261011-pane-width-fixture-889-wide-list.png')});
  }
  await page.setViewportSize({width:889,height:700});
  await splitter.focus().catch(()=>{});
  await page.getByRole('button',{name:'Back to list',exact:true}).click().catch(()=>{});
}
// The worker view lists each worker once; its tasks open from the worker's detail.
async function openWorkerTask(page, task, agent) {
  const inDetail=page.locator('#maestro-detail [data-center-task="'+task+'"][data-center-agent="'+agent+'"]');
  if (!await inDetail.count()) await page.locator('[data-select-worker="'+agent+'"]').click();
  await inDetail.click();
}

async function checkRequestView(page, post) {
  const original = '# 목표\n' + '긴 한국어 요청과😀원문 보존\n'.repeat(1800) + '마지막 완료 조건을 보존합니다.';
  const view = { title: '작업 A · 설정 복원과 재작업 이력', agentId: 'worker-A', runId: 'run-A2',
    fields: { goal: '다시 열어도 선택한 설정이 복원됩니다.', scope: '설정 저장과 복원만 수정합니다.\n다른 동작을 보존합니다.',
      completion: '재시작과 창 재열기 검사를 통과합니다.', constraints: '원래 권한을 유지합니다.' },
    changes: [{ number: 1, baseRevision: 1, text: 'A-1: 창 재열기 검사 추가', status: 'delivered' },
      { number: 2, baseRevision: 2, text: 'A-2: 한국어 긴 요청을 보존', status: 'delivered' }],
    original, metadata: JSON.stringify({ taskId: 'task-A', requestRevision: 3, receiptRequestHash: 'original-bound-hash' }, null, 2) };
  const focus = page.locator('#maestro-refresh');
  for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast']) {
    await page.evaluate(theme => { document.body.className = theme; }, theme);
    for (const width of [320, 890]) {
      await page.setViewportSize({ width, height: 650 }); await focus.focus();
      await post({ type: 'request.view', view });
      const dialog = page.getByRole('dialog'); await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.getAttribute('aria-labelledby'), 'request-view-title');
      assert.match(await dialog.locator('h3').first().textContent(), /목표/);
      assert.match(await dialog.textContent(), /A-1: 창 재열기 검사 추가/);
      assert.match(await dialog.textContent(), /A-2: 한국어 긴 요청을 보존/);
      assert.equal(await dialog.locator('details').count(), 2);
      assert.equal(await dialog.locator('details[open]').count(), 0, 'Original and machine records begin separated and collapsed');
      const originalFold = dialog.locator('details').first(); await originalFold.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await originalFold.locator('pre').textContent(), original, 'No clipping or replacement of the long multibyte original');
      const metadataFold = dialog.locator('details').last(); await metadataFold.locator('summary').click();
      assert.equal(await metadataFold.locator('pre').textContent(), view.metadata);
      const geometry = await dialog.evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, viewport: innerWidth }));
      assert.ok(geometry.scroll <= geometry.width + 1 && geometry.left >= 0 && geometry.right <= geometry.viewport, JSON.stringify(geometry));
      if (process.env.REQUEST_VIEW_EVIDENCE && theme === 'vscode-dark') {
        await originalFold.locator('summary').click(); await metadataFold.locator('summary').click();
        await dialog.evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.REQUEST_VIEW_EVIDENCE, 'request-view-' + width + '.png') });
      }
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await focus.evaluate(el => document.activeElement === el), true, 'Closing restores keyboard focus to its origin');
    }
  }
  const task = { id: 'task-A', title: '같은 제목', workAgentId: 'worker-A', userRevisionCount: 2, verificationDisposition: 'not-requested',
    runs: [{ role: 'work', agentId: 'worker-A', runId: 'run-A2', status: 'running' }] };
  const entry = { id: 'flow-A', title: 'A', workAgentId: 'worker-A', status: 'active', tasks: [{ ...task, workStatus: 'running' }] };
  const independent = { id: 'flow-B', title: 'B', workAgentId: 'worker-A', status: 'completed', tasks: [{ id: 'task-B', title: '같은 제목', workStatus: 'completed' }] };
  await post({ type: 'project.tasks', entries: [entry, independent] });
  await page.locator('#maestro-tasks-view').click();
  assert.equal(await page.locator('.maestro-card').count(), 2, 'A and identical-title B stay two tasks');
  const card = page.locator('[data-center-task="flow-A/task-A"]');
  await card.click();
  assert.match(await page.locator('.maestro-summary').textContent(), /수정 2회/);
  for (const [status, loopStatus, badge] of [['failed', 'runtime-error', 'failed'], ['completed', 'completed', 'completed']]) {
    await post({ type: 'project.tasks', entries: [{ ...entry, status: loopStatus, tasks: [{ ...task, workStatus: status, runs: [{ ...task.runs[0], status,
      ...(status === 'completed' ? { receipt: { outcome: 'completed' } } : {}) }] }] }, independent] });
    assert.equal(await page.locator('.maestro-card').count(), 2);
    assert.equal(await card.locator('.maestro-state').first().getAttribute('data-status'), badge);
  }
}



async function checkWorkers(page, post, chatPage) {
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString();
  const entries=[{id:'fixture-workers',title:'Explicit fixture only',status:'active',mainAgentId:'fixture-main',loopId:'fixture-loop',updatedAt:at(1),tasks:[
    {id:'assigned-one',title:'Connect actual results',domain:'Extension',workAgentId:'worker-reused',workStatus:'completed',verificationStatus:'running',runs:[
      {role:'work',agentId:'worker-reused',runId:'run-completed',status:'completed',workProfile:'work',model:'fixture-model',startedAt:at(50),finishedAt:at(40),result:{availability:'recorded',summary:'Preserved stable result provenance.'},receipt:{outcome:'completed',changedPaths:['src/view.ts'],checks:'Own check evidence'}},
      {role:'verification',agentId:'worker-verifier',runId:'run-verifying',status:'running',startedAt:at(5)}]},
    {id:'assigned-two',title:'Read contract',domain:'Runtime',workAgentId:'worker-reused',workStatus:'running',verificationDisposition:'not-requested',runs:[{role:'work',agentId:'worker-reused',runId:'run-active',status:'running',workProfile:'explore',startedAt:at(3)}]},
    {id:'missing-run',title:'Assignment without run',workAgentId:'worker-pending',workStatus:'pending'},
    {id:'missing-result',title:'Completed with missing result',workAgentId:'worker-reused',workStatus:'completed',runs:[{role:'work',agentId:'worker-reused',runId:'run-missing',status:'completed',finishedAt:at(60*30),receipt:{outcome:'completed',checksRun:false,checks:'Fixture checks not executed',changedPaths:[]},result:{availability:'missing'}}]},
    {id:'error-result',title:'Result read failed',workAgentId:'worker-reused',workStatus:'completed',runs:[{role:'work',agentId:'worker-reused',runId:'run-error',status:'completed',finishedAt:at(60*48),result:{availability:'error',error:'Fixture result read failure'}}]},
    {id:'stale-decision',title:'Decision overtaken by cancellation',workAgentId:'worker-stale',workStatus:'cancelled',runs:[{role:'work',agentId:'worker-stale',runId:'run-stale',status:'needs-human-decision',finishedAt:at(20)}]},
    {id:'open-decision',title:'Decision still open',workAgentId:'worker-decision',workStatus:'blocked',runs:[{role:'work',agentId:'worker-decision',runId:'run-decision',status:'needs-human-decision',finishedAt:at(10)}]},
    {id:'unassigned',title:'Still visible in task view',workStatus:'pending'}]}];
  await page.locator('#maestro-search').fill('');
  await page.locator('#maestro-workers-view').click();await post({type:'project.tasks',entries});
  // Worker view: domain → one row per worker (its membership or latest task's domain) → the latest task as its summary.
  assert.deepEqual(await page.locator('.maestro-domain-toggle').evaluateAll(items=>items.map(item=>[item.dataset.domain,item.getAttribute('aria-expanded')])),
    [['__required','true'],['Extension','true'],['Runtime','true']],'Workers without a domain lead, under "Domain required" (no unclassified group)');
  assert.equal(await page.locator('[data-domain="__required"]').textContent(),'Domain required · Agents 3 · 3 assignments','Domain header counts workers and assignments');
  assert.equal(await page.locator('[data-section]').count(),0,'No status/time section replaces the worker grouping');
  const workersIn=domain=>page.locator('[data-domain="'+domain+'"]').evaluate(header=>{const ids=[];for(let node=header.nextElementSibling;node&&!node.classList.contains('maestro-domain-toggle');node=node.nextElementSibling)if(node.dataset.centerWorker)ids.push(node.dataset.centerWorker);return ids;});
  assert.deepEqual(await workersIn('Extension'),['worker-verifier']);
  assert.deepEqual(await workersIn('Runtime'),['worker-reused'],'A worker is listed once, under its latest task\'s domain');
  assert.deepEqual(await workersIn('__required'),['worker-decision','worker-pending','worker-stale'],'Attention, then running/waiting, then recent');
  assert.equal(await page.locator('[data-center-worker="worker-reused"]').count(),1,'Not repeated per task or run');
  const reused=page.locator('[data-center-worker="worker-reused"]');
  // The worker is named by the model its runs recorded; the ID stays the link key.
  assert.equal(await reused.locator('.maestro-row-title').textContent(),'fixture-model');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-row-title').textContent(),'Model not recorded','No model is invented without a run');
  // The model opens the worker's own session; the title opens its detail. Both keep the exact agent ID.
  assert.equal(await reused.locator('.maestro-row-title').getAttribute('data-open-session'),'worker-reused');
  assert.equal(await reused.locator('.maestro-worker-select').getAttribute('data-select-worker'),'worker-reused');
  assert.equal(await reused.locator('.maestro-worker-status .maestro-state').textContent(),'Running','The row state is the open task, not a past result');
  // Four columns in one row, in this order: worker | title (the row's task) | state | history; the work area follows.
  assert.deepEqual(await reused.evaluate(row=>[...row.children].map(cell=>cell.className.split(' ')[0])),['maestro-worker-cell','maestro-worker-title','maestro-worker-status','maestro-worker-work']);
  // Title, state and the line under the row all describe one task: the worker's most urgent open task (else its newest).
  // Column 2: the sub-domain on line 1 (none recorded here); line 2 under it is the running task's title until its run records an action.
  assert.equal(await reused.locator('.maestro-worker-title').textContent(),'Not recorded','Line 1 is the recorded sub-domain');
  assert.equal(await reused.locator('.maestro-worker-purpose').textContent(),'Read contract','Without a recorded action line 2 keeps the row\'s own task');
  assert.match(await reused.locator('.maestro-worker-title').getAttribute('title'),/Employment purpose: Result read failed/,'The first assignment stays in the tooltip');
  // Under the row: only the row's task — "Now" with its own documents; earlier results stay in the task history.
  const lines=await reused.locator('.maestro-worker-line').evaluateAll(items=>items.map(item=>[item.querySelector('.maestro-worker-kind')?.textContent||'',item.dataset.lineTask.split('/')[1],item.querySelector('.maestro-worker-line-main').textContent,[...item.querySelectorAll('[data-document]')].map(doc=>doc.textContent)]));
  assert.deepEqual(lines,[['','assigned-two','Read contract',[]]],'The row\'s own line needs no repeated "Now"');
  assert.equal(await reused.locator('.maestro-history-button').count(),0);
  assert.deepEqual(await page.locator('.maestro-worker-head [role="columnheader"]').allTextContents(),['Agent','Title','Status']);
  const top=await reused.evaluate(row=>{const cells=row=>row.classList.contains('maestro-worker-head')?[...row.children]:[row.querySelector('.maestro-role'),row.querySelector(':scope > .maestro-worker-title'),row.querySelector(':scope > .maestro-worker-status')];return cells(row).map(cell=>Math.round(cell.getBoundingClientRect().top+cell.getBoundingClientRect().height/2));});
  assert.ok(Math.max(...top)-Math.min(...top)<=4,'The four cells sit on one line: '+top);
  assert.equal(await reused.locator('.maestro-role').textContent(),'Explorer');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-role').textContent(),'Unassigned','No profile is invented without a run or allocation');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-worker-status .maestro-state').textContent(),'Waiting','The recorded task state stands in for a missing run');
  assert.equal(await page.locator('[data-center-worker="worker-stale"] .maestro-worker-status .maestro-state').textContent(),'Cancelled','A cancelled task does not wait for its stale decision');
  // A finished row's line 2 is its task title; its missing result is said in the line's full text, never a success.
  const staleLine=page.locator('[data-center-worker="worker-stale"] .maestro-worker-line');
  assert.equal(await staleLine.locator('.maestro-worker-purpose').textContent(),'Decision overtaken by cancellation');
  assert.match(await staleLine.getAttribute('title'),/Result not collected/,'A missing result is said, never a success');
  assert.equal(await page.locator('.maestro-list [data-center-task]:not(.maestro-worker-work [data-center-task])').count(),0,'Tasks in the list belong to a worker\'s work area');
  assert.deepEqual(await page.locator('#maestro-domain option').evaluateAll(options=>options.map(option=>option.value)),['','name:Extension','name:Runtime','__required']);
  // Rows share one column grid: role tags and status texts start at the same x in every row.
  // Header and every row share the column lines.
  const columns=await page.locator('.maestro-worker-head, .maestro-worker-row').evaluateAll(rows=>rows.map(row=>{const cells=row=>row.classList.contains('maestro-worker-head')?[...row.children]:[row.querySelector('.maestro-role'),row.querySelector(':scope > .maestro-worker-title'),row.querySelector(':scope > .maestro-worker-status')];return cells(row).map(cell=>Math.round(cell.getBoundingClientRect().left));}));
  for (const index of [1,2]) assert.equal(new Set(columns.map(value=>value[index])).size,1,'Column '+(index+1)+' is aligned');
  // A worker's detail lists its tasks newest first; each opens the task with its request, result and artifacts.
  await reused.locator('.maestro-worker-select').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'worker-reused');
  assert.deepEqual(await page.locator('#maestro-detail .maestro-worker-tasks [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask.split('/')[1])),
    ['assigned-two','assigned-one','missing-result','error-result']);
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-verifier');
  await page.getByRole('button',{name:'Agent run',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.target==='run').at(-1)),{type:'project.task.open',workflowId:'fixture-workers',taskId:'assigned-one',target:'run',agentId:'worker-verifier',runId:'run-verifying'});
  const inspected=JSON.parse(JSON.stringify(entries));inspected[0].tasks[0].verificationStatus='failed';
  inspected[0].tasks[0].runs[1].status='completed';inspected[0].tasks[0].runs[1].verification={decision:'fail',verifiedWorkRunId:'run-completed',findings:[{id:'finding-one',path:'src/view.ts',location:'result link',problem:'Wrong target',evidence:'Recorded source mismatch',correction:'Bind exact run'}]};
  await post({type:'project.tasks',entries:inspected});
  assert.match(await page.locator('#maestro-detail').textContent(),/Fail \(recorded\)/);
  assert.match(await page.locator('#maestro-detail').textContent(),/Inspected Work runrun-completed/);
  assert.match(await page.locator('#maestro-detail').textContent(),/Recorded source mismatch/);
  assert.doesNotMatch(await page.locator('#maestro-detail').textContent(),/Own checks/);
  await post({type:'project.tasks',entries});
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-reused');
  const content=await page.locator('#maestro-detail').textContent();
  assert.match(content,/DomainExtension/);assert.match(content,/Task work stateCompleted/);assert.match(content,/Verification stateRunning/);assert.match(content,/Integration stateUnconfirmed/);
  assert.match(content,/Preserved stable result provenance/);assert.match(content,/src\/view\.ts/);
  assert.match(content,/worker-reused\/run-completed/);assert.doesNotMatch(content,/worker-verifier\/run-verifying/);
  assert.match(content,/Other assignments of this agent · 3/);
  // The primary action uses Main's shared accent (Main's send button no longer carries it, so compare the token itself).
  await chatPage.mouse.move(0,0);await chatPage.waitForTimeout(300);
  assert.equal(await page.getByRole('button',{name:'Open original result',exact:true}).evaluate(element=>getComputedStyle(element).backgroundColor),
    await chatPage.evaluate(()=>{const probe=document.createElement('span');probe.style.color='var(--af-color-accent)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;}));
  await page.getByRole('button',{name:'Open original result',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.target==='result').at(-1)),{type:'project.task.open',workflowId:'fixture-workers',taskId:'assigned-one',target:'result',agentId:'worker-reused',runId:'run-completed'});
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'list');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'worker-reused','Returning focuses the worker row');
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-reused');await page.locator('#maestro-detail').press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'worker-reused');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.openSession),'worker-reused','Arrow keys reach the worker model');
  await page.keyboard.press('ArrowDown');
  await post({type:'project.tasks',entries});assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'worker-reused','Refresh retains focus');
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-reused');
  await page.getByRole('button',{name:'Show in task list',exact:true}).click();
  assert.equal(await page.locator('#maestro-tasks-view').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-center-task="fixture-workers/unassigned"]').count(),1);
  // Task view: a kanban board with one column per recorded state; unassigned and unclassified tasks stay on it.
  assert.deepEqual(await page.locator('.maestro-column').evaluateAll(columns=>columns.map(column=>[column.dataset.column,[...column.querySelectorAll('.maestro-card')].map(card=>card.dataset.centerTask.split('/')[1]).sort()])),
    [['waiting',['missing-run','unassigned']],['running',['assigned-two']],['verifying',['assigned-one']],['decision',['open-decision']],['completed',['missing-result']],['ended',['stale-decision']],['unknown',['error-result']]]);
  assert.equal(await page.locator('.maestro-card[aria-current="true"]').getAttribute('data-center-task'),'fixture-workers/assigned-one','Switching views keeps the selection');
  assert.match(await page.locator('[data-center-task="fixture-workers/unassigned"]').textContent(),/Domain required.*Unassigned/);
  assert.match(await page.locator('[data-center-task="fixture-workers/assigned-two"]').textContent(),/Runtime.*worker-reused/);
  assert.equal(await page.locator('[data-center-task="fixture-workers/stale-decision"] .maestro-state').textContent(),'Cancelled');
  assert.equal(await page.locator('.maestro-column[data-column="decision"] .maestro-state').textContent(),'Human decision needed');
  await selectFilter(page, '#maestro-domain', 'name:Runtime');assert.equal(await page.locator('.maestro-card').count(),1,'Domain filters the board');
  await selectFilter(page, '#maestro-domain', '');
  assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'The board scrolls inside itself');
  assert.equal(await page.locator('[data-center-task="fixture-workers/assigned-one"]').getAttribute('aria-current'),'true');
  await page.getByRole('button',{name:'Show assigned agents',exact:true}).click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'assigned-one');
  assert.equal(await page.getByRole('button',{name:'Back to agent',exact:true}).count(),1);
  await selectFilter(page, '#maestro-domain', 'name:Runtime');assert.equal(await page.locator('.maestro-row').count(),1);
  assert.deepEqual(await page.locator('.maestro-domain-toggle').evaluateAll(items=>items.map(item=>item.dataset.domain)),['Runtime']);
  await selectFilter(page, '#maestro-domain', '__required');assert.equal(await page.locator('.maestro-row').count(),3,'Workers needing a domain are listed when filtered');
  await page.locator('#maestro-search').fill('Extension');assert.equal(await page.locator('.maestro-row').count(),0,'Search and domain filter combine');
  await selectFilter(page, '#maestro-domain', '');assert.equal(await page.locator('.maestro-row').count(),2,'Search matches the recorded domain');
  await page.locator('#maestro-search').fill('');
  await selectFilter(page, '#maestro-domain', '');await selectFilter(page, '#maestro-status', 'running');assert.equal(await page.locator('.maestro-row').count(),2);
  await selectFilter(page, '#maestro-status', '');await page.locator('#maestro-search').fill('stable result');assert.equal(await page.locator('.maestro-row').count(),1);
  await page.locator('#maestro-search').fill('');
  const extension=page.locator('[data-domain="Extension"]');await extension.click();
  assert.equal(await extension.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('[data-center-worker="worker-verifier"]').count(),0);
  await post({type:'project.tasks',entries});assert.equal(await page.locator('[data-domain="Extension"]').getAttribute('aria-expanded'),'false','Refresh retains domain collapse');
  await page.locator('[data-domain="Extension"]').click();
  await openWorkerTask(page,'fixture-workers/error-result','worker-reused');assert.match(await page.locator('#maestro-detail').textContent(),/Fixture result read failure/);
  assert.equal(await page.getByRole('button',{name:'Open original result',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Back to agent',exact:true}).click();
  await openWorkerTask(page,'fixture-workers/missing-result','worker-reused');assert.match(await page.locator('#maestro-detail').textContent(),/Not recorded/);
  assert.equal(await page.getByRole('button',{name:'Open original result',exact:true}).isDisabled(),true);
  assert.match(await page.locator('#maestro-detail').textContent(),/Own checks · Not executed/);
  assert.match(await page.locator('#maestro-detail').textContent(),/None recorded/);
  const emptyResult=JSON.parse(JSON.stringify(entries));emptyResult[0].tasks[3].runs[0].result={availability:'recorded'};
  await post({type:'project.tasks',entries:emptyResult});assert.match(await page.locator('#maestro-detail').textContent(),/Recorded result is empty/);
  assert.equal(await page.getByRole('button',{name:'Open original result',exact:true}).isDisabled(),false);
  await post({type:'project.tasks',entries});
  await openWorkerTask(page,'fixture-workers/missing-run','worker-pending');assert.match(await page.locator('#maestro-detail').textContent(),/Observed run stateNot recorded/);
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-reused');
  const evidence=process.env.CONTROL_CENTER_EVIDENCE;
  for (const [width,height] of [[1100,760],[465,556],[721,402],[320,556]]) {
    await page.setViewportSize({width,height});
    for (const theme of ['dark','light','contrast']) {
      await page.evaluate(theme=>{
        const colors=theme==='light'?['#ffffff','#333333','#f3f3f3','#cecece','#e8e8e8','#0060c0','#ffffff','#0060c0','#ffffff','#333333']:theme==='contrast'?['#000000','#ffffff','#000000','#6fc3df','#1a1a1a','#0f4a85','#ffffff','#f38518','#000000','#ffffff']:['#1e1e1e','#d4d4d4','#252526','#454545','#2a2d2e','#094771','#ffffff','#007fd4','#313131','#cccccc'];
        const keys=['editor-background','foreground','editorWidget-background','panel-border','list-hoverBackground','list-activeSelectionBackground','list-activeSelectionForeground','focusBorder','input-background','input-foreground'];
        keys.forEach((key,index)=>document.documentElement.style.setProperty('--vscode-'+key,colors[index]));
        for(const key of ['editor-foreground','dropdown-foreground'])document.documentElement.style.setProperty('--vscode-'+key,colors[1]);
        document.documentElement.style.setProperty('--vscode-dropdown-background',colors[2]);document.documentElement.style.setProperty('--vscode-dropdown-border',colors[3]);
        document.documentElement.style.colorScheme=theme==='light'?'light':'dark';document.body.className=theme==='contrast'?'vscode-high-contrast':'vscode-'+theme;
      },theme);
      assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
      assert.equal(await page.locator('#maestro-refresh').isVisible(),true);
      assert.ok(await page.locator('[aria-current="true"]').first().evaluate(element=>getComputedStyle(element).color!==getComputedStyle(element).backgroundColor));
      await page.locator('#maestro-search').focus();assert.notEqual(await page.locator('#maestro-search').evaluate(element=>getComputedStyle(element).outlineStyle),'none');
      if(evidence && (width===1100 || width===465))await page.screenshot({path:path.join(evidence,'control-center-rebuild-20261009-fixture-'+theme+'-'+width+'.png')});
    }
  }
  await page.emulateMedia({forcedColors:'active'});
  assert.ok(await page.locator('[aria-current="true"]').first().evaluate(element=>getComputedStyle(element).color!==getComputedStyle(element).backgroundColor));
  await page.emulateMedia({forcedColors:'none'});
  await page.setViewportSize({width:1100,height:760});
  await page.locator('#maestro-search').fill('no-match');assert.equal(await page.locator('[data-center-worker]').count(),0);assert.equal(await page.locator('#maestro-workers-count').textContent(),'5','Filtering does not change the worker total');
  // No match leaves the list empty without a separate message or clear-filters control.
  assert.equal(await page.getByRole('button',{name:'Clear filters',exact:true}).count(),0);
  await page.locator('#maestro-search').fill('');assert.equal(await page.locator('[data-center-worker]').count(),5);
  await post({type:'project.tasks',entries:[],error:'Fixture load error'});assert.match(await page.locator('#maestro-tasks .maestro-error').textContent(),/Fixture load error/);
  assert.equal(await page.locator('[data-center-worker]').count(),5,'Read error preserves last observations');
  await post({type:'project.tasks',entries:[]});assert.equal(await page.locator('[data-center-worker]').count(),0);assert.equal(await page.locator('#maestro-workers-count').textContent(),'0','An empty result reports zero workers');
  assert.match(await page.locator('#maestro-tasks').textContent(),/No task records in this project yet/);
  await page.locator('#maestro-refresh').click();assert.equal(await page.locator('#maestro-workers-count').textContent(),'0','Refreshing preserves the known worker count without a status line');
  await post({type:'project.tasks',entries:[],error:'Empty read failed'});assert.match(await page.locator('#maestro-tasks').textContent(),/Empty read failed/);
}


// The fake host answers like the plugin: it returns the edit result, then the refreshed list.
async function checkDomainEditing(page, post) {
  await page.setViewportSize({width:1100,height:760});
  const by=(actor,source='control-center')=>({actor,at:new Date().toISOString(),source});
  const extension='domain-aaaaaaaaaaaa', docs='domain-bbbbbbbbbbbb';
  const entries=[{id:'flow-domains',title:'Domain fixture',status:'active',mainAgentId:'fixture-main',updatedAt:new Date().toISOString(),tasks:[
    {id:'ui-task',title:'Recorded Extension task',domain:'Extension',workAgentId:'worker-ui',workStatus:'running',runs:[{role:'work',agentId:'worker-ui',runId:'run-ui',status:'running',startedAt:new Date().toISOString()}]},
    {id:'legacy-task',title:'Legacy unclassified task',workAgentId:'worker-legacy',workStatus:'running',runs:[{role:'work',agentId:'worker-legacy',runId:'run-legacy',status:'running',startedAt:new Date().toISOString()}]},
    {id:'runtime-task',title:'Recorded Runtime task',domain:'Runtime',workAgentId:'worker-runtime',workStatus:'pending'}]}];
  const unnamed='domain-eeeeeeeeeeee', runtime='domain-dddddddddddd';
  // A legacy unnamed domain from the former placeholder button is kept, but nothing can be placed in it until it is named.
  let domains={revision:3,domains:[{id:extension,name:'Extension',aliases:[],createdBy:by('ai','loop one'),nameSetBy:by('ai','loop one')},
    {id:unnamed,name:'미분류',provisional:true,aliases:[],createdBy:by('human'),nameSetBy:by('human')}],assignments:{'worker-ui':{domainId:extension,setBy:by('ai','loop one')}}};
  const sent=()=>page.evaluate(()=>window.sentMessages.filter(value=>value.type.startsWith('domain.')));
  const toggles=()=>page.locator('.maestro-domain-toggle').evaluateAll(items=>items.map(item=>item.dataset.domainKey||item.dataset.domain));
  const workersIn=domain=>page.locator('[data-domain="'+domain+'"]').evaluate(header=>{const ids=[];for(let node=header.nextElementSibling;node&&!node.classList.contains('maestro-domain-toggle');node=node.nextElementSibling)if(node.dataset.centerWorker)ids.push(node.dataset.centerWorker);return ids.sort();});
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-scope', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries});
  assert.equal(await page.locator('#maestro-domain-add').isHidden(),true,'Without the shared list nothing is editable');
  await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('#maestro-domain-add').isVisible(),true);
  assert.equal(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('data-domain'),'Extension');
  // Only a real membership places a worker. The others (no entry; a recorded name is only a suggestion) wait in
  // "Domain required", which is not a domain: it is not a drop target and nothing can be moved back into it.
  assert.deepEqual(await toggles(),['__required',extension,unnamed]);
  assert.deepEqual(await workersIn('__required'),['worker-legacy','worker-runtime']);
  assert.equal(await page.locator('[data-domain="__required"]').getAttribute('data-membership-required'),'true');
  assert.deepEqual(await page.locator('[data-drop-target]').evaluateAll(items=>items.map(item=>item.dataset.dropTarget)),[extension],'Only named, listed domains take drops');
  assert.equal(await page.locator('[data-domain-key="'+unnamed+'"]').getAttribute('data-provisional'),'true');
  // Its former placeholder text is not shown as a name; it is named from an empty field.
  assert.equal(await page.locator('[data-domain-key="'+unnamed+'"]').getAttribute('data-domain'),'Unnamed domain');
  assert.equal(await page.getByText('미분류',{exact:true}).count(),0,'The former placeholder text is not shown');
  assert.equal(await page.locator('[data-domain-key="'+unnamed+'"] + .maestro-domain-edit').getAttribute('aria-label'),'Rename Unnamed domain','A legacy unnamed domain can be named');
  await page.locator('[data-domain-key="'+unnamed+'"] + .maestro-domain-edit').click();
  assert.equal(await page.locator('[data-domain-input="rename:'+unnamed+'"]').inputValue(),'');
  await page.locator('[data-domain-input="rename:'+unnamed+'"]').press('Escape');
  assert.equal(await page.getByText('Unclassified',{exact:true}).count(),0,'No unclassified group or label');
  // Rows carry no membership line: placing is by dragging onto a domain header, or from the worker detail's domain menu,
  // which says why a worker needs a domain and offers only real domains; nothing is preselected.
  assert.equal(await page.locator('.maestro-worker-row .maestro-worker-membership, .maestro-worker-row select').count(),0,'No membership line or menu in the rows');
  const memberSelect=agent=>page.locator('#maestro-detail [data-domain-assign="'+agent+'"]');
  await page.locator('[data-select-worker="worker-runtime"]').click();
  assert.match(await page.locator('#maestro-detail .maestro-domain-field').getAttribute('title'),/No domain chosen yet · From the assignment record: Runtime/);
  assert.deepEqual(await memberSelect('worker-runtime').evaluate(select=>[select.value,[...select.options].map(option=>[option.value,option.textContent,option.disabled])]),
    ['',[['','Choose a domain…',true],[extension,'Extension',false],['create:Runtime','Create “Runtime” and place here',false]]]);
  await page.locator('[data-select-worker="worker-legacy"]').click();
  assert.deepEqual(await memberSelect('worker-legacy').evaluate(select=>[...select.options].map(option=>option.value)),['',extension]);
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  // Without the line the list fits a narrow editor too.
  for (const width of [1100,320]) {
    await page.setViewportSize({width,height:760});
    assert.ok(await page.locator('#maestro-tasks').evaluate(element=>element.scrollWidth<=element.clientWidth+1),width+': no horizontal overflow');
  }
  await page.setViewportSize({width:1100,height:760});
  // Create: the name comes first; an empty name or Escape creates nothing.
  await page.locator('#maestro-domain-add').click();
  const createInput=page.locator('[data-domain-input="create"]');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.domainInput),'create');
  await createInput.press('Enter');assert.match(await page.locator('.maestro-domain-editor').textContent(),/Enter a name/);
  await createInput.press('Escape');assert.equal(await page.locator('.maestro-domain-editor').count(),0);
  assert.equal((await sent()).length,0,'Nothing is created before it has a name');
  await page.locator('#maestro-domain-add').click();
  await createInput.fill('미분류');await createInput.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.create',name:'미분류',revision:3});
  assert.equal(await createInput.isDisabled(),true,'One edit at a time');
  await post({type:'domain.result',edit:'domain.create',error:'does not name a work area',code:'domain_name_reserved'});
  assert.match(await page.locator('.maestro-domain-editor [role="alert"]').textContent(),/real work area/,'A catch-all name is refused by the plugin and said so');
  await createInput.fill('Docs');await createInput.press('Enter');
  await post({type:'domain.result',edit:'domain.create',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-domain-editor [role="alert"]').textContent(),/changed meanwhile/);
  assert.equal(await createInput.inputValue(),'Docs','The typed name survives a failed save');
  await createInput.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.create',name:'Docs',revision:3});
  domains={...domains,revision:4,domains:[...domains.domains,{id:docs,name:'Docs',aliases:[],createdBy:by('human'),nameSetBy:by('human')}]};
  await post({type:'domain.result',edit:'domain.create',domainId:docs});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('.maestro-domain-editor').count(),0);
  assert.equal(await page.locator('[data-domain-key="'+docs+'"]').textContent(),'Docs · Agents 0 · 0 assignments','A new domain is listed before any worker joins it');
  assert.deepEqual(await page.locator('[data-drop-target]').evaluateAll(items=>items.map(item=>item.dataset.dropTarget)),[docs,extension]);
  // Rename later with the usual pencil: empty and duplicate names are refused, typing survives a refresh.
  await page.locator('[data-domain-key="'+docs+'"] + .maestro-domain-edit').click();
  const renameDocs=page.locator('[data-domain-input="rename:'+docs+'"]');
  assert.equal(await renameDocs.inputValue(),'Docs');
  await renameDocs.fill('');await renameDocs.press('Enter');assert.match(await page.locator('.maestro-domain-editor').textContent(),/Enter a name/);
  await renameDocs.fill('Extension');await renameDocs.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:docs,name:'Extension',revision:4});
  assert.equal(await renameDocs.isDisabled(),true,'One edit at a time');
  await post({type:'domain.result',edit:'domain.rename',error:'Another domain is already named Extension',code:'domain_name_taken'});
  assert.match(await page.locator('.maestro-domain-editor [role="alert"]').textContent(),/already exists/);
  assert.equal(await renameDocs.inputValue(),'Extension','The typed name survives a failed save');
  await renameDocs.fill('Docs site');
  await post({type:'project.tasks',entries,domains});
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.domainInput),'rename:'+docs);
  assert.equal(await renameDocs.inputValue(),'Docs site');
  await renameDocs.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:docs,name:'Docs site',revision:4});
  domains={...domains,revision:5,domains:domains.domains.map(item=>item.id===docs?{...item,name:'Docs site',aliases:['Docs'],nameSetBy:by('human')}:item)};
  await post({type:'domain.result',edit:'domain.rename',domainId:docs});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('.maestro-domain-editor').count(),0);
  assert.equal(await page.locator('[data-domain-key="'+docs+'"]').textContent(),'Docs site · Agents 0 · 0 assignments');
  assert.equal(await page.locator('[data-domain-key="'+unnamed+'"]').getAttribute('data-provisional'),'true','The legacy unnamed domain is unchanged');
  // Filter by the domain ID, then rename: the filter, collapse key and membership stay linked by ID.
  await selectFilter(page, '#maestro-domain', extension);
  assert.equal(await page.locator('.maestro-row').count(),1);
  await page.locator('[data-domain-key="'+extension+'"] + .maestro-domain-edit').click();
  assert.equal(await page.locator('[data-domain-input="rename:'+extension+'"]').inputValue(),'Extension');
  await page.locator('[data-domain-input="rename:'+extension+'"]').fill('Extension UI');await page.locator('[data-domain-input="rename:'+extension+'"]').press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:extension,name:'Extension UI',revision:5});
  domains={...domains,revision:6,domains:[{...domains.domains[0],name:'Extension UI',aliases:['Extension'],nameSetBy:by('human')},...domains.domains.slice(1)]};
  await post({type:'domain.result',edit:'domain.rename'});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('#maestro-domain').inputValue(),extension);
  assert.equal(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('data-domain'),'Extension UI');
  assert.equal(await page.locator('[data-center-worker="worker-ui"]').evaluate(row=>{let node=row.previousElementSibling;while(node&&!node.classList.contains('maestro-domain-toggle'))node=node.previousElementSibling;return node?.dataset.domainKey;}),extension,'The member follows the renamed domain');
  assert.match(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('title'),/Set by you/);
  await selectFilter(page, '#maestro-domain', '');
  // Place the legacy worker from its detail: the menu starts on "choose" and offers only real domains.
  await page.locator('[data-select-worker=\"worker-legacy\"]').click();
  const legacyMenu=page.locator('#maestro-detail [data-domain-assign="worker-legacy"]');
  assert.equal(await legacyMenu.inputValue(),'');
  assert.deepEqual(await legacyMenu.evaluate(select=>[...select.options].map(option=>[option.value,option.disabled])),[['',true],[docs,false],[extension,false]]);
  await legacyMenu.selectOption(docs);
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'worker-legacy',domainId:docs,revision:6});
  domains={...domains,revision:7,assignments:{...domains.assignments,'worker-legacy':{domainId:docs,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('[data-domain-key="'+docs+'"] ~ [data-center-worker]').first().getAttribute('data-center-worker'),'worker-legacy');
  assert.match(await page.locator('.maestro-domain-field').getAttribute('title'),/Set by you/);
  assert.equal(await legacyMenu.evaluate(select=>select.options[0].value),docs,'A placed worker has no "choose" or empty entry: it only moves');
  // Move it again; a stale revision is reported and the latest list stays shown.
  await legacyMenu.selectOption(extension);
  await post({type:'domain.result',edit:'domain.assign',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-domain-field').textContent(),/changed meanwhile/);
  await post({type:'project.tasks',entries,domains});
  assert.equal(await legacyMenu.inputValue(),docs);
  // The recorded but unlisted name is created on request, then the worker is placed in it with the new revision.
  await page.locator('[data-select-worker="worker-runtime"]').click();
  await memberSelect('worker-runtime').selectOption('create:Runtime');
  assert.deepEqual((await sent()).at(-1),{type:'domain.create',name:'Runtime',revision:7});
  domains={...domains,revision:8,domains:[...domains.domains,{id:runtime,name:'Runtime',aliases:[],createdBy:by('human'),nameSetBy:by('human')}]};
  await post({type:'domain.result',edit:'domain.create',domainId:runtime});
  assert.equal((await sent()).at(-1).type,'domain.create','The placement waits for the refreshed list');
  await post({type:'project.tasks',entries,domains});
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'worker-runtime',domainId:runtime,revision:8});
  domains={...domains,revision:9,assignments:{...domains.assignments,'worker-runtime':{domainId:runtime,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('[data-domain="__required"]').count(),0,'Once every worker has a domain the section is gone');
  assert.equal(await page.locator('#maestro-domain option[value="__required"]').count(),0);
  // An AI membership is labelled; the recorded allocation name stays visible as evidence.
  await page.locator('[data-select-worker=\"worker-ui\"]').click();
  assert.match(await page.locator('.maestro-domain-field').getAttribute('title'),/Set by AI/);
  assert.match(await page.locator('.maestro-domain-field').getAttribute('title'),/From the assignment record: Extension/,'The recorded allocation name stays available');
  await page.locator('[data-select-worker=\"worker-runtime\"]').click();
  assert.match(await page.locator('.maestro-domain-field').getAttribute('title'),/Set by you.*From the assignment record: Runtime/);
  // The kanban shows the same membership on each card.
  await page.locator('#maestro-tasks-view').click();
  assert.match(await page.locator('.maestro-card[data-center-task="flow-domains/legacy-task"]').textContent(),/Docs site/);
  assert.match(await page.locator('.maestro-card[data-center-task="flow-domains/runtime-task"]').textContent(),/Runtime/);
  await selectFilter(page, '#maestro-domain', docs);assert.equal(await page.locator('.maestro-card').count(),1);
  await selectFilter(page, '#maestro-domain', '');await page.locator('#maestro-workers-view').click();
  // A failed domain read keeps the tasks, reports the error and turns editing off.
  await post({type:'project.tasks',entries,domainsError:'Fixture domain store invalid'});
  assert.match(await page.locator('#maestro-tasks .maestro-error').textContent(),/Fixture domain store invalid/);
  assert.equal(await page.locator('#maestro-domain-add').isHidden(),true);assert.equal(await page.locator('.maestro-domain-edit').count(),0);
  assert.equal(await page.locator('[data-center-worker="worker-legacy"]').count(),1);
  await post({type:'project.tasks',entries,domains});
  // Toolbar: at the reference width the title, tabs, search and actions share one row; all three filters live in one
  // keyboard-accessible popover with a count of the non-default conditions.
  await page.locator('#maestro-filter-toggle').click();
  const toolbar=()=>page.evaluate(()=>{
    const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:Math.round(r.top),center:Math.round(r.top+r.height/2),left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)};};
    const header=document.querySelector('.maestro-header');
    return {tabs:box('maestro-workers-view'),scope:box('maestro-scope-switch'),search:box('maestro-search'),toggle:box('maestro-filter-toggle'),add:box('maestro-domain-add'),supervision:box('maestro-supervision'),refresh:box('maestro-refresh'),header:header.getBoundingClientRect(),overflow:header.scrollWidth>header.clientWidth};
  });
  // Measured with a proportional UI font like VS Code's; the shared fixture's 14px monospace is wider than any real UI font.
  await page.evaluate(()=>{document.documentElement.style.setProperty('--vscode-font-family','sans-serif');document.documentElement.style.setProperty('--vscode-font-size','13px');});
  for (const width of [1100,890]) {
    await page.setViewportSize({width,height:600});const bar=await toolbar();
    assert.ok([bar.tabs,bar.scope,bar.toggle,bar.add,bar.supervision,bar.refresh].every(item=>item.center===bar.search.center),width+': one row '+JSON.stringify(bar));
    assert.equal(bar.overflow,false,width+': no header overflow');
    assert.ok(bar.search.width>=120,width+': search retains an operable width');
  }
  assert.equal(await page.locator('#maestro-filter-count').isVisible(),false,'Default filter choices are not counted');
  assert.equal(await page.locator('#maestro-filter-popover').getAttribute('role'),'group');
  await page.locator('#maestro-search').fill('toolbar search');
  assert.equal(await page.locator('#maestro-filter-count').isVisible(),false,'Search is not counted as a filter condition');
  await page.locator('#maestro-search').fill('');
  await selectFilter(page, '#maestro-status', 'running');
  await selectFilter(page, '#maestro-scope', 'fixture-main');
  await selectFilter(page, '#maestro-domain', '');
  assert.equal(await page.locator('#maestro-filter-count').textContent(),'2','Only non-default filters are counted');
  await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-scope', '');
  assert.equal(await page.locator('#maestro-filter-count').isVisible(),false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#maestro-filter-popover').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'maestro-filter-toggle','Escape returns focus to the opener');
  await page.locator('#maestro-filter-toggle').click();
  await page.locator('#maestro-workers-view').click();
  assert.equal(await page.locator('#maestro-filter-popover').isHidden(),true,'Outside click dismisses the popover');
  for (const width of [465,320]) {
    await page.setViewportSize({width,height:600});const bar=await toolbar();
    assert.equal(bar.overflow,false,width+': no header overflow');
    assert.ok([bar.search,bar.toggle,bar.add,bar.supervision,bar.refresh].every(item=>item.width>0),width+': controls remain available');
    await page.locator('#maestro-filter-toggle').click();
    assert.equal(await page.locator('#maestro-filter-popover').isVisible(),true,width+': filter popover opens');
    assert.ok(await page.locator('#maestro-filter-popover').evaluate(element=>element.scrollWidth<=element.clientWidth+1),width+': filter controls fit');
    assert.ok(await page.locator('#maestro-filter-popover').evaluate(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth;}),width+': filter popover stays inside the viewport');
    await page.keyboard.press('Escape');
  }
  // Keyboard order follows visual order and the visible new-domain label names its control.
  await page.setViewportSize({width:890,height:600});
  const koreanToolbar=await page.evaluate(()=>{
    const byId=id=>document.getElementById(id),label=(id,value)=>{const element=byId(id).querySelector('[data-i18n]');element.textContent=value;};
    const original={workers:byId('maestro-workers-view').querySelector('[data-i18n]').textContent,count:byId('maestro-workers-count').textContent,tasks:byId('maestro-tasks-view').textContent,active:byId('maestro-scope-active').textContent,all:byId('maestro-scope-all').textContent,search:byId('maestro-search').placeholder,filters:byId('maestro-filter-toggle').querySelector('[data-i18n]').textContent,domain:byId('maestro-domain-add').querySelector('[data-i18n]').textContent,supervision:byId('maestro-supervision').textContent};
    label('maestro-workers-view','수행자');byId('maestro-workers-count').textContent='14';byId('maestro-tasks-view').textContent='작업';byId('maestro-scope-active').textContent='진행·주의 0';byId('maestro-scope-all').textContent='전체 29';byId('maestro-search').placeholder='수행자, 작업 검색';label('maestro-filter-toggle','필터');label('maestro-domain-add','새 분류');byId('maestro-supervision').textContent='감독 보고';
    const ids=['maestro-workers-view','maestro-tasks-view','maestro-scope-switch','maestro-search','maestro-filter-toggle','maestro-domain-add','maestro-supervision','maestro-refresh'];
    const centers=ids.map(id=>{const rect=byId(id).getBoundingClientRect();return Math.round(rect.top+rect.height/2);});
    const header=document.querySelector('.maestro-header');
    label('maestro-workers-view',original.workers);byId('maestro-workers-count').textContent=original.count;byId('maestro-tasks-view').textContent=original.tasks;byId('maestro-scope-active').textContent=original.active;byId('maestro-scope-all').textContent=original.all;byId('maestro-search').placeholder=original.search;label('maestro-filter-toggle',original.filters);label('maestro-domain-add',original.domain);byId('maestro-supervision').textContent=original.supervision;
    return {centers,overflow:header.scrollWidth>header.clientWidth};
  });
  assert.ok(koreanToolbar.centers.every(center=>center===koreanToolbar.centers[0]),'890: Korean title, tabs, active/all counts, search, filters and actions share one row '+JSON.stringify(koreanToolbar));
  assert.equal(koreanToolbar.overflow,false,'890: localized toolbar has no horizontal overflow');
  await page.locator('#maestro-search').focus();
  const order=[];for(let i=0;i<2;i++){await page.keyboard.press('Tab');order.push(await page.evaluate(()=>document.activeElement.id));}
  assert.deepEqual(order,['maestro-filter-toggle','maestro-domain-add']);
  await page.locator('#maestro-filter-toggle').focus();
  await page.keyboard.press('Enter');assert.equal(await page.locator('#maestro-filter-popover').isVisible(),true);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'maestro-status-all');
  await page.keyboard.press('Escape');
  assert.notEqual(await page.locator('#maestro-filter-toggle').evaluate(element=>getComputedStyle(element).outlineStyle),'none');
  assert.equal(await page.locator('#maestro-domain-add').getAttribute('aria-label'),null);
  assert.equal(await page.locator('#maestro-domain-add').textContent(),'New domain','The visible label is the accessible name');
  await page.evaluate(()=>{document.documentElement.style.removeProperty('--vscode-font-family');document.documentElement.style.removeProperty('--vscode-font-size');});
  for (const [width,height] of [[465,556],[320,556]]) {
    await page.setViewportSize({width,height});
    assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1));
    if (process.env.CONTROL_CENTER_EVIDENCE) await page.screenshot({path:path.join(process.env.CONTROL_CENTER_EVIDENCE,'control-center-domain-edit-20261010-fixture-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:760});
}


// Worker control: the fake host answers like the control-center window (worker.result), then refreshes.
async function checkWorkerControl(page, post) {
  await page.setViewportSize({width:1100,height:900});
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString();
  const long=Array.from({length:12},(_,index)=>'Line '+(index+1)+' of a long instruction').join('\n');
  const live=(status='running')=>({id:'flow-live',title:'Live',status:status==='running'?'active':'cancelled',mainAgentId:'main-a',loopId:'loop-live',workAgentId:'worker-live',latestWorkRunId:'run-live',updatedAt:at(1),tasks:[
    {id:'task-live',title:'Live task',workAgentId:'worker-live',workStatus:status,runs:[{role:'work',agentId:'worker-live',runId:'run-live',status,startedAt:at(4),...(status==='running'?{}:{finishedAt:at(1)})}],
     commands:[{kind:'request',text:'First line\nSecond line',sender:'main',at:at(4),status:'delivered',runId:'run-live'},
       {kind:'addition',text:long,sender:'human',at:at(2),status:status==='running'?'queued':'undelivered'}]}]});
  const old={id:'flow-old',title:'Old',status:'completed',mainAgentId:'main-a',loopId:'loop-old',workAgentId:'worker-live',updatedAt:at(600),tasks:[
    {id:'task-old',title:'Old task',workAgentId:'worker-live',workStatus:'completed',runs:[{role:'work',agentId:'worker-live',runId:'run-old',status:'completed',finishedAt:at(600),receipt:{outcome:'completed'},result:{availability:'recorded',summary:'Old result'}}],
     commands:[{kind:'request',text:'Old request',sender:'human',at:at(700),status:'delivered',runId:'run-old'}]}]};
  const idle={id:'flow-idle',title:'Idle',status:'completed',loopId:'loop-idle',workAgentId:'worker-idle',updatedAt:at(30),tasks:[
    {id:'task-idle',title:'Idle task',workAgentId:'worker-idle',workStatus:'completed',runs:[{role:'work',agentId:'worker-idle',runId:'run-idle',status:'completed',finishedAt:at(30),receipt:{outcome:'completed'}}],commands:[]}]};
  let domains={revision:1,domains:[],assignments:{},removedWorkers:{}};
  const entries=()=>[live(),old,idle];
  const sent=type=>page.evaluate(type=>window.sentMessages.filter(value=>value.type===type),type);
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries:entries(),domains});
  await page.locator('#maestro-scope-all').click();
  const publishWorkerActivity=(status,liveActivity)=>post({type:'project.tasks',entries:entries(),domains,team:{status:'ok',workers:[{agentId:'worker-live',role:'work',availability:status==='running'?'busy':'idle',removed:false,current:[],queued:[],failed:[],holds:[],latestRun:{runId:'run-live',status,progressKey:'ui.running.command',activity:'Private commentary must not appear in the worker row',...(liveActivity?{liveActivity}:{})},taskCounts:{},runCount:1}]}});
  await publishWorkerActivity('running');
  // The worker first, then its latest task; a running worker is marked.
  const row=page.locator('[data-center-worker="worker-live"]');
  assert.equal(await row.count(),1);assert.equal(await row.getAttribute('data-running'),'true');
  assert.equal(await row.locator('.maestro-worker-title').textContent(),'Not recorded','Column 2 line 1 is the sub-domain');assert.equal(await row.locator('.maestro-history-button').count(),0);
  // One line for the row's task (title and state not repeated); the finished task's result stays in the task history.
  assert.equal(await row.locator('.maestro-worker-line').count(),1);
  // Running, no action recorded yet: line 2 keeps the task title; the provider phase and commentary are not shown as an action.
  const purpose=row.locator('.maestro-worker-line .maestro-worker-purpose');
  assert.equal(await purpose.textContent(),'Live task','Without a recorded action the running row keeps its task title');
  assert.equal(await row.locator('.maestro-worker-action').count(),0);
  assert.equal(await row.locator('.maestro-worker-line').innerText().then(text=>text.includes('Private commentary')),false,'Commentary content is not exposed');
  assert.notEqual(await row.evaluate(element=>getComputedStyle(element,'::before').animationName),'none','A running row animates');
  // Running with a recorded action: line 2 is that action in the session row's words, with its glyph; hover gives the full text.
  const skillPath='/home/u/.claude/skills/agent/references/task-dispatch.md';
  await publishWorkerActivity('running',{category:'command',phase:'completed',text:'sed -n 1,80p '+skillPath,durationMs:40});
  const action=row.locator('.maestro-worker-line .maestro-worker-action');
  assert.equal(await action.count(),1);
  assert.equal(await action.textContent(),'Read Skill agent · references/task-dispatch.md · 40ms');
  assert.equal(await action.getAttribute('data-activity-kind'),'skill');
  assert.equal(await action.locator('svg.maestro-activity-icon').count(),1,'The session row glyph leads the action');
  assert.match(await action.getAttribute('title'),new RegExp(skillPath.replaceAll('.','\\.')),'The full command is the hover text');
  const actionBox=await action.evaluate(element=>({overflow:getComputedStyle(element).textOverflow,wrap:getComputedStyle(element).whiteSpace,height:element.getBoundingClientRect().height}));
  assert.deepEqual([actionBox.overflow,actionBox.wrap],['ellipsis','nowrap'],'One ellipsized line');
  assert.ok(actionBox.height<=20,'The action stays on one line: '+actionBox.height);
  // A newer action replaces it on the next read.
  await publishWorkerActivity('running',{category:'tool',phase:'started',text:'Reasoning',kind:'think'});
  assert.equal(await action.textContent(),'Thinking');
  assert.equal(await action.getAttribute('data-activity-phase'),'started');
  await publishWorkerActivity('running',{category:'tool',phase:'completed',text:'Read',kind:'read',target:'/runs/run-live/result.md'});
  assert.equal(await action.textContent(),'Read result.md');
  assert.match(await action.getAttribute('title'),/\/runs\/run-live\/result\.md/);
  // Malformed host entries are dropped, never guessed: the task title stays.
  await publishWorkerActivity('running',{category:'bogus',phase:'started',text:'x'});
  assert.equal(await row.locator('.maestro-worker-action').count(),0);assert.equal(await purpose.textContent(),'Live task');
  await checkWorkerControls(page, 'Live worker');
  // Not running: line 2 falls back to the task title even when an older action is still in the record.
  for (const status of ['completed','failed','needs-human-decision','queued']) {
    await publishWorkerActivity(status,{category:'command',phase:'started',text:'npm test'});
    assert.equal(await row.locator('.maestro-worker-action').count(),0,status+': an inactive run shows no live action');
    assert.equal(await purpose.textContent(),'Live task',status+': the task title stands in');
  }
  await publishWorkerActivity('running');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await row.evaluate(element=>getComputedStyle(element,'::before').animationName),'none','Reduced motion disables the running animation');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await row.locator('.maestro-session-open').click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='project.task.open').at(-1)),{type:'project.task.open',workflowId:'flow-live',taskId:'task-live',target:'run',agentId:'worker-live',runId:'run-live'},'The relocated session control keeps its exact run target');
  await row.locator('.maestro-worker-select').click();
  const detail=page.locator('#maestro-detail');
  assert.deepEqual(await detail.locator('.maestro-running-task [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask)),['flow-live/task-live']);
  assert.deepEqual(await detail.locator('.maestro-worker-tasks [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask)),['flow-old/task-old'],'History keeps finished tasks apart from running ones');
  const remove=page.getByRole('button',{name:'Remove agent',exact:true});
  assert.equal(await remove.isDisabled(),true,'A running worker cannot be removed');
  assert.match(await remove.getAttribute("title"),/Stop the running task before removing this agent/);
  // Assignment and header stay visible; conversations use the existing session target.
  assert.equal(await detail.locator('textarea, .maestro-instruction, .maestro-command-log, .maestro-command').count(),0);
  assert.equal(await detail.locator('.maestro-detail-header [data-remove-worker="worker-live"]').count(),1);
  assert.equal(await detail.locator('.maestro-detail-header [data-stop-loop="loop-live"]').count(),1);
  assert.equal(await detail.locator('.maestro-detail-header [data-handoff-worker="worker-live"]').count(),1);
  await detail.locator('[data-open-session="worker-live"]').click();
  assert.deepEqual((await sent('project.task.open')).at(-1),{type:'project.task.open',workflowId:'flow-live',taskId:'task-live',target:'run',agentId:'worker-live',runId:'run-live'});
  await page.locator('[data-select-worker="worker-idle"]').click();
  assert.equal(await detail.locator('[data-open-session="worker-idle"]').isDisabled(),true,'No recorded Main session keeps its existing unavailable state');
  assert.equal(await page.getByRole('button',{name:'Remove agent',exact:true}).isDisabled(),false,'An idle performer can be removed');
  // Force stop: exact loop/task, one at a time; cancelling the confirmation or a failure changes nothing.
  await page.locator('[data-select-worker=\"worker-live\"]').click();
  await page.getByRole('button',{name:'Force stop · Live task',exact:true}).click();
  assert.deepEqual((await sent('worker.stop')).at(-1),{type:'worker.stop',agentId:'worker-live',loopId:'loop-live',workflowId:'flow-live',taskId:'task-live'});
  assert.equal(await page.getByRole('button',{name:'Stopping… · Live task',exact:true}).isDisabled(),true);
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',cancelled:true});
  assert.equal(await page.getByRole('button',{name:'Force stop · Live task',exact:true}).isDisabled(),false);
  await page.getByRole('button',{name:'Force stop · Live task',exact:true}).click();
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',error:'Resolve the uncertain dispatch before stopping this task',code:'loop_stop_dispatch_uncertain'});
  assert.match(await page.locator('#maestro-detail .maestro-worker-notice').textContent(),/Failed: Resolve the uncertain dispatch/);
  assert.equal(await page.locator('.maestro-running-task').count(),1,'A failed stop is not shown as stopped');
  await page.getByRole('button',{name:'Force stop · Live task',exact:true}).click();
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',result:{}});
  assert.equal(await page.locator('.maestro-running-task').count(),1,'Only the refreshed record shows the stop');
  await post({type:'project.tasks',entries:[live('cancelled'),old,idle],domains});
  assert.equal(await page.locator('.maestro-running-task').count(),0);
  assert.equal(await page.locator('[data-center-worker="worker-live"] .maestro-worker-status .maestro-state').textContent(),'Cancelled');
  await openWorkerTask(page,'flow-live/task-live','worker-live');
  assert.match(await detail.locator('.maestro-command[data-status="undelivered"]').textContent(),/Not delivered · task ended/,'Saved messages remain readable in task detail');
  await page.getByRole('button',{name:'Back to agent',exact:true}).click();
  // Removal: confirmed by the host, then the worker leaves the list; its tasks stay readable in the task view.
  await page.getByRole('button',{name:'Remove agent',exact:true}).click();
  assert.deepEqual((await sent('worker.remove')).at(-1),{type:'worker.remove',agentId:'worker-live',revision:1});
  assert.equal(await page.getByRole('button',{name:'Removing…',exact:true}).isDisabled(),true);
  await post({type:'worker.result',action:'worker.remove',agentId:'worker-live',error:'Stop this worker\'s running task before removing it',code:'worker_running'});
  assert.match(await page.locator('#maestro-detail .maestro-worker-notice').textContent(),/Failed: Stop this worker's running task/);
  assert.equal(await page.locator('[data-center-worker="worker-live"]').count(),1,'A refused removal keeps the worker');
  await page.getByRole('button',{name:'Remove agent',exact:true}).click();
  domains={...domains,revision:2,removedWorkers:{'worker-live':{removedBy:{actor:'human',at:new Date().toISOString(),source:'control-center'}}}};
  await post({type:'worker.result',action:'worker.remove',agentId:'worker-live',result:{}});await post({type:'project.tasks',entries:[live('cancelled'),old,idle],domains});
  assert.equal(await page.locator('[data-center-worker="worker-live"]').count(),0);
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'list');
  await page.locator('#maestro-tasks-view').click();
  assert.equal(await page.locator('.maestro-card[data-center-task="flow-old/task-old"]').count(),1,'History of a removed worker stays in the task view');
  await page.locator('.maestro-card[data-center-task="flow-old/task-old"]').click();
  assert.match(await page.locator('#maestro-detail').textContent(),/Removed from the agent list/);
  assert.match(await page.locator('#maestro-detail').textContent(),/Old result/);
  await page.locator('#maestro-workers-view').click();
  // A long history scrolls without moving the header or assignment, even at short/narrow sizes.
  const historyTasks=Array.from({length:40},(_,i)=>({...old.tasks[0],id:'old-'+i,title:'Historical task '+i+' with a long title',runs:old.tasks[0].runs.map(run=>({...run,runId:'old-run-'+i}))}));
  historyTasks.at(-1).title='문서 관리 수행자 고용 시험: 모의 문서 목록 검사를 자기 세션에서 구현하고 여섯 개 사례를 각각 세 번 실행하여 실제 수행 증거를 제출하십시오.';
  const longHistory={...old,tasks:historyTasks};
  await post({type:'project.tasks',entries:[live(),longHistory,idle],domains:{...domains,removedWorkers:{}}});
  await page.locator('[data-select-worker="worker-live"]').click();
  const artifact=process.env.WORKER_CONTROL_EVIDENCE;
  for (const [width,height] of [[1100,900],[783,900],[465,556],[721,402],[320,556]]) {
    await page.setViewportSize({width,height});
    const measure=()=>detail.evaluate(element=>{
      const header=element.querySelector('.maestro-detail-header'),facts=element.querySelector('.maestro-worker-assignment'),history=element.querySelector('.maestro-worker-history-block');
      return {header:header.getBoundingClientRect().top,facts:facts.getBoundingClientRect().top,historyTop:history.scrollTop,
        historyHeight:history.clientHeight,historyTotal:history.scrollHeight,outerScroll:element.scrollTop,
        overflow:element.scrollWidth-element.clientWidth, bottom:history.getBoundingClientRect().bottom, paneBottom:element.getBoundingClientRect().bottom};
    });
    await detail.locator('.maestro-worker-history-block').evaluate(element=>{element.scrollTop=0;});
    const before=await measure();
    assert.ok(before.historyHeight>=40,width+'x'+height+': usable history height '+JSON.stringify(before));
    assert.ok(before.historyTotal>before.historyHeight);
    await detail.locator('.maestro-worker-history-block').evaluate(element=>{element.scrollTop=180;});
    const after=await measure();
    assert.ok(after.historyTop>0);assert.equal(after.header,before.header);assert.equal(after.facts,before.facts);
    assert.equal(after.outerScroll,0);assert.ok(after.overflow<=1);assert.ok(after.bottom<=after.paneBottom+1);
    await post({type:'project.tasks',entries:[live(),longHistory,idle],domains:{...domains,removedWorkers:{}}});
    assert.equal((await measure()).historyTop,after.historyTop,'Refresh preserves the reading position');
    for (const selector of ['.maestro-worker-assignment','.maestro-detail-header .maestro-actions']) {
      assert.equal(await detail.locator(selector).evaluate(element=>{const r=element.getBoundingClientRect(),p=element.closest('#maestro-detail').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&r.right<=p.right+1;}),true,width+': fixed facts and actions stay reachable');
    }
    if (artifact) await page.screenshot({path:path.join(artifact,'performer-detail-'+width+'x'+height+'.png')});
  }
  await detail.locator('[data-open-session="worker-live"]').focus();
  await post({type:'project.tasks',entries:[live(),longHistory,idle],domains:{...domains,removedWorkers:{}}});
  assert.equal(await detail.locator('[data-open-session="worker-live"]').evaluate(element=>element===document.activeElement),true,'Refresh retains header session focus');
  await page.keyboard.press('Tab');
  await detail.locator('.maestro-worker-history-block').focus();
  assert.notEqual(await detail.locator('.maestro-worker-history-block').evaluate(element=>getComputedStyle(element).outlineStyle),'none');
  const scrollBefore=await detail.locator('.maestro-worker-history-block').evaluate(element=>element.scrollTop);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(value=>document.querySelector('#maestro-detail .maestro-worker-history-block').scrollTop>value,scrollBefore);
  await post({type:'project.tasks',entries:[live(),longHistory,idle],domains:{...domains,removedWorkers:{}}});
  assert.equal(await detail.locator('.maestro-worker-history-block').evaluate(element=>element===document.activeElement),true,'Refresh retains keyboard scrolling focus');
  for (const theme of ['vscode-light','vscode-high-contrast','vscode-dark']) {
    await page.evaluate(theme=>{
      document.body.className=theme;
      const colors=theme==='vscode-light'?['#fff','#333','#f3f3f3','#bbb']:theme==='vscode-high-contrast'?['#000','#fff','#000','#fff']:['#1e1e1e','#d4d4d4','#252526','#454545'];
      for(const [i,key] of ['--vscode-editor-background','--vscode-foreground','--vscode-editorWidget-background','--vscode-panel-border'].entries())document.documentElement.style.setProperty(key,colors[i]);
    },theme);
    assert.equal(await detail.locator('.maestro-detail-header [data-open-session="worker-live"]').isVisible(),true);
    assert.equal(await detail.evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,theme+': no horizontal overflow');
    if (artifact) await page.screenshot({path:path.join(artifact,'performer-detail-'+theme+'.png')});
  }

}


// Dragging a worker onto a domain header sends the same Human membership edit as the detail's domain menu.
async function checkWorkerDrag(page, post) {
  await page.setViewportSize({width:1100,height:900});
  const now=new Date().toISOString(), by=actor=>({actor,at:now,source:'control-center'});
  const coord='domain-aaaaaaaaaaaa', empty='domain-bbbbbbbbbbbb', fresh='domain-cccccccccccc';
  const task=(id,agent,status='running')=>({id,title:id+' task',workAgentId:agent,workStatus:status,runs:[{role:'work',agentId:agent,runId:'run-'+id,status,startedAt:now}],commands:[]});
  const entries=[{id:'flow-drag',title:'Drag',status:'active',mainAgentId:'main-a',loopId:'loop-drag',workAgentId:'coord-a',latestWorkRunId:'run-a',updatedAt:now,tasks:[task('a','coord-a')]},
    {id:'flow-b',title:'B',status:'completed',loopId:'loop-b',workAgentId:'coord-b',updatedAt:now,tasks:[task('b','coord-b','completed')]},
    {id:'flow-c',title:'C',status:'completed',loopId:'loop-c',workAgentId:'scribe-c',updatedAt:now,tasks:[task('c','scribe-c','completed')]}];
  let domains={revision:10,domains:[{id:coord,name:'작업 조율',aliases:[],createdBy:by('human'),nameSetBy:by('human')},{id:empty,name:'Empty area',aliases:[],createdBy:by('human'),nameSetBy:by('human')},
    {id:fresh,name:'미분류',provisional:true,aliases:[],createdBy:by('human'),nameSetBy:by('human')}],
    assignments:{'coord-a':{domainId:coord,setBy:by('human')},'coord-b':{domainId:coord,setBy:by('human')}},removedWorkers:{}};
  const sent=()=>page.evaluate(()=>window.sentMessages.filter(value=>value.type==='domain.assign'));
  const groupOf=agent=>page.locator('[data-center-worker="'+agent+'"]').evaluate(row=>{let node=row.previousElementSibling;while(node&&!node.classList.contains('maestro-domain-toggle'))node=node.previousElementSibling;return node?.dataset.dropTarget;});
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-scope', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries,domains});
  const before=(await sent()).length;
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('draggable'),'true');
  // Targets are the listed, named domains by ID (also an empty one). A legacy unnamed domain and "Domain required" are not.
  assert.deepEqual(await page.locator('[data-drop-target]').evaluateAll(items=>items.map(item=>item.dataset.dropTarget)),[empty,coord]);
  assert.equal(await groupOf('scribe-c'),undefined,'A worker without a membership is in no domain');
  assert.equal(await page.locator('[data-membership-required="true"]').getAttribute('data-drop-target'),null);
  // Drop on the same group, or cancel the drag: nothing is sent.
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+coord+'"]'));
  assert.equal((await sent()).length,before,'Same-group drop changes nothing');
  await page.locator('[data-center-worker="coord-a"]').dispatchEvent('dragstart',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
  await page.locator('[data-center-worker="coord-a"]').dispatchEvent('dragend');
  assert.equal((await sent()).length,before,'A cancelled drag changes nothing');
  assert.equal(await page.locator('.is-drop-target').count(),0);
  // Dropped on "Domain required" or the unnamed domain, nothing is sent: a membership is never removed.
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-membership-required="true"]'));
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-domain-key="'+fresh+'"]'));
  assert.equal((await sent()).length,before,'No drop removes or blanks a membership');
  assert.equal(await groupOf('coord-a'),coord);
  // Move a running worker to another real domain: only its membership changes, with the read revision.
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+empty+'"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'coord-a',domainId:empty,revision:10});
  assert.equal(await page.locator('[data-center-worker="coord-b"]').getAttribute('draggable'),'false','No second move while one saves');
  assert.equal(await groupOf('coord-a'),coord,'The list waits for the saved record');
  // A failed save (conflict) keeps the original group and says so.
  await post({type:'domain.result',edit:'domain.assign',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-drag-error').textContent(),/changed meanwhile/);
  assert.equal(await groupOf('coord-a'),coord);
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+empty+'"]'));
  domains={...domains,revision:11,assignments:{...domains.assignments,'coord-a':{domainId:empty,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('coord-a'),empty);
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('data-running'),'true','The running task keeps running');
  // Back into a collapsed domain, then the worker without a domain into a real one.
  await page.locator('[data-drop-target="'+coord+'"]').click();
  assert.equal(await page.locator('[data-drop-target="'+coord+'"]').getAttribute('aria-expanded'),'false');
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+coord+'"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'coord-a',domainId:coord,revision:11});
  domains={...domains,revision:12,assignments:{...domains.assignments,'coord-a':{domainId:coord,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  await page.locator('[data-drop-target="'+coord+'"]').click();
  assert.equal(await groupOf('coord-a'),coord,'Dropped into the collapsed group');
  assert.equal(await page.locator('[data-center-worker="scribe-c"]').getAttribute('draggable'),'true','A worker needing a domain can be dragged into one');
  await page.locator('[data-center-worker="scribe-c"]').dragTo(page.locator('[data-drop-target="'+empty+'"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'scribe-c',domainId:empty,revision:12});
  domains={...domains,revision:13,assignments:{...domains.assignments,'scribe-c':{domainId:empty,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('scribe-c'),empty);
  assert.equal(await page.locator('[data-membership-required="true"]').count(),0);
  // Reload: the moved memberships come back from the saved list; selection and the worker detail still work.
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('scribe-c'),empty);assert.equal(await groupOf('coord-a'),coord);
  await page.locator('[data-select-worker=\"scribe-c\"]').click();
  assert.equal(await page.locator('#maestro-detail [data-domain-assign="scribe-c"]').inputValue(),empty,'The keyboard menu shows the dragged membership');
  // While a search or filter hides groups, dragging is off and the menu remains.
  await page.locator('#maestro-search').fill('coord');
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('draggable'),'false');
  assert.equal(await page.locator('[data-drop-target]').count(),0);
  assert.match(await page.locator('[data-center-worker="coord-a"]').getAttribute('title'),/Clear search and filters/);
  await page.locator('#maestro-search').fill('');
  if (process.env.WORKER_CONTROL_EVIDENCE) {
    await page.locator('[data-center-worker="coord-b"]').dispatchEvent('dragstart',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
    await page.locator('[data-drop-target="'+empty+'"]').dispatchEvent('dragover',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
    await page.screenshot({path:path.join(process.env.WORKER_CONTROL_EVIDENCE,'control-center-worker-drag-20261010-005858-fixture-1100.png')});
    await page.locator('[data-center-worker="coord-b"]').dispatchEvent('dragend');
  }
}


// Worker list: one row per worker with four columns — worker | title | status | history — at every width.
async function checkWorkerColumns(page, post) {
  const now=new Date().toISOString();
  const longName='work-control-center-rebuild-20261009-131013-with-a-very-long-identity';
  const task=(id,agent,title,status)=>({id,...(title===undefined?{}:{title}),workAgentId:agent,workStatus:status,runs:[{role:'work',agentId:agent,runId:'run-'+id,status,startedAt:now}],commands:[]});
  const entries=[{id:'c1',title:'c',status:'active',loopId:'lc1',workAgentId:longName,updatedAt:now,tasks:[task('long',longName,'A very long latest task title that keeps going well past the width of any editor split so it must shorten instead of pushing the history control away','running')]},
    {id:'c2',title:'c',status:'completed',loopId:'lc2',workAgentId:'w-empty',updatedAt:now,tasks:[task('empty','w-empty',undefined,'completed')]}];
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries,domains:{revision:1,domains:[],assignments:{},removedWorkers:{}}});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  // Column 2 line 1 is the sub-domain; a finished row's line 2 says a missing title, never an ID in its place.
  assert.equal(await page.locator('[data-center-worker="w-empty"] .maestro-worker-title').textContent(),'Not recorded');
  assert.equal(await page.locator('[data-center-worker="w-empty"] .maestro-worker-purpose').textContent(),'Employment purpose not recorded','A missing title is said, not replaced by an ID');
  for (const width of [1100,783,465,320]) {
    await page.setViewportSize({width,height:600});
    const layout=await page.locator('.maestro-list').evaluate(list=>{
      const rows=[...list.querySelectorAll('.maestro-worker-head, .maestro-worker-row')];
      const box=element=>element.getBoundingClientRect();const cells=row=>row.classList.contains('maestro-worker-head')?[...row.children]:[row.querySelector('.maestro-role'),row.querySelector(':scope > .maestro-worker-title'),row.querySelector(':scope > .maestro-worker-status')];
      return {overflow:list.scrollWidth>list.clientWidth+1,
        order:rows.map(row=>cells(row).map(cell=>Math.round(box(cell).left))),
        inside:rows.every(row=>cells(row).every(cell=>box(cell).right<=box(list).right+1)),
        history:[...list.querySelectorAll('.maestro-history-button')].every(button=>{const b=box(button),cell=box(button.parentElement);return b.width>20&&b.right<=box(list).right+1&&b.left>=cell.left-1;}),
        oneLine:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const first=cell=>getComputedStyle(row).alignItems==='start'?box(cell).top:box(cell).top+box(cell).height/2;const tops=cells(row).slice(1).map(first);return Math.max(...tops)-Math.min(...tops)<=4;})};
    });
    assert.equal(layout.overflow,false,width+': no horizontal overflow');
    assert.ok(layout.inside&&layout.history,width+': cells and the history control stay visible');
    assert.ok(layout.order.every(lefts=>lefts[0]<lefts[1]&&lefts[1]<lefts[2]),width+': worker | title | status | history order');
    for (const index of [1,2]) assert.equal(new Set(layout.order.map(value=>value[index])).size,1,width+': column '+(index+1)+' aligned');
    assert.ok(layout.oneLine,width+': title, status and history share one line');
    if (process.env.WORKER_COLUMNS_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_COLUMNS_EVIDENCE,'control-center-worker-columns-20261010-075302-fixture-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:700});
  // Enter on the worker title opens detail, where history remains accessible.
  await page.locator('[data-select-worker="'+longName+'"]').focus();
  assert.notEqual(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),longName);
  assert.equal(await page.locator('#maestro-detail .maestro-worker-history-block').count(),1);
  // Clicking the worker name or the row opens the same detail.
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  await page.locator('[data-center-worker="w-empty"] .maestro-worker-title').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'w-empty');
}


// Worker rows name the model and what it was assigned for; open tasks and the newest ended result sit under the row.
async function checkWorkerNames(page, post) {
  await page.setViewportSize({width:1100,height:700});
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString(), by={actor:'human',at:at(1),source:'control-center'};
  const customer='domain-dddddddddddd';
  const coordTitle='Agent Factory 작업 조율을 다양한 정상·경계·실패 조건에서 반복 시험하고, 실제 실행 증거와 남은 취약 지점을 보고하십시오. 단순 계산 반복이 아니라 실제 런타임 조율 로직을 대상으로 최소 40개 구별되는';
  const coordResult='48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다. 기존 사례 43개와 실제 런타임 함수를 호출하는 보조 사례 5개를 사용했습니다. 수행 시간은 약 16분입니다.';
  const longResult='API 페이지네이션 구현과 회귀 테스트를 마쳤습니다. '+'커서 기반 조회, 정렬 안정성, 빈 페이지 처리와 기존 클라이언트 호환을 확인했습니다. '.repeat(4);
  const task=(id,agent,title,{domain,status='completed',minutes=5,model,provider,result,reason,request}={})=>({id,title,...(domain?{domain}:{}),workAgentId:agent,workStatus:status,
    ...(reason?{allocation:{unitReason:reason}}:{}),
    runs:[{role:'work',agentId:agent,runId:'run-'+id,status,...(model?{model}:{}),...(provider?{provider}:{}),startedAt:at(minutes+2),...(['running','pending'].includes(status)?{}:{finishedAt:at(minutes)}),
      ...(status==='completed'?{receipt:{outcome:'completed'}}:{}),...(result?{result}:{}),...(request?{request:{availability:'recorded'}}:{})}],commands:[]});
  const loop=(id,agent,tasks,status='completed')=>({id,title:id,mainAgentId:'main-fixture',status,loopId:'loop-'+id,workAgentId:agent,updatedAt:at(1),tasks});
  const entries=[
    // Same model, different workers and purposes: never merged.
    loop('api-origin','work-api-7f3a',[task('t-api-1','work-api-7f3a','주문 조회 API 개발',{domain:'API 개발',minutes:300,model:'claude-opus-5-5',reason:'주문 API 담당 한 명이 통합합니다.',result:{availability:'recorded',summary:'**주문 조회 API** 1차 구현 완료'}})]),
    loop('api-now','work-api-7f3a',[task('t-api-2','work-api-7f3a','주문 조회 API에 페이지네이션 추가',{domain:'API 개발',status:'running',minutes:3,model:'claude-opus-5-5',request:true}),
      task('t-api-3','work-api-7f3a','응답 캐시 헤더 정리',{domain:'API 개발',status:'pending',minutes:2})],'active'),
    loop('api-done','work-api-7f3a',[task('t-api-4','work-api-7f3a','페이지네이션 회귀 테스트',{domain:'API 개발',minutes:30,model:'claude-opus-5-5',request:true,result:{availability:'recorded',summary:longResult}})]),
    loop('db','work-db-91c2',[task('t-db','work-db-91c2','고객 테이블 인덱스 설계',{domain:'DB 모델링',model:'claude-opus-5-5',result:{availability:'recorded',summary:'**인덱스** 3종 [설계안](docs/db/index.md) 작성'}})]),
    loop('bug-1','work-bug-0d11',[task('t-bug-1','work-bug-0d11','결제 실패 시 중복 주문 수정',{domain:'버그 수정',status:'failed',model:'gpt-6.1-sol'})]),
    loop('bug-2','work-bug-2b77',[task('t-bug-2','work-bug-2b77','결제 실패 시 중복 주문 수정',{domain:'버그 수정',status:'cancelled',minutes:20,model:'gpt-6.1-sol'})]),
    loop('ui','work-ui-55e0',[task('t-ui','work-ui-55e0','주문 목록 반응형 정렬 조정',{domain:'UI/UX 조정',status:'completed',provider:'claude',result:{availability:'missing'}})]),
    loop('roles','worker-roles-5b2748a4',[task('t-roles','worker-roles-5b2748a4','sandbox normalize_label 테스트 실행')]),
    // The attached case: a recorded brief title and a result whose first paragraph is several sentences (copied text).
    loop('coord','coord-matrix-e855264c',[task('t-coord','coord-matrix-e855264c',coordTitle,{domain:'작업 조율',minutes:780,model:'gpt-6.1-sol',request:true,result:{availability:'recorded',summary:coordResult,highlight:'본시험 144회가 모두 통과했습니다.'}})]),
    loop('brief','work-brief-1a2b',[task('t-brief','work-brief-1a2b','사용자님께서 정리한 지휘자 운영 흐름에 대해 “작업배정해서 작업 진행하세요”라고 실행을 승인하셨습니다. 하나의 채팅에서 여러 세션과 작업자를 운영할 수 있는 플러그인 실행 기반을 구현하고, 특히 장시간 작업이 끝날 때까지 진전을 감찰하십시오.',{minutes:90,model:'claude-opus-5-5',result:{availability:'recorded',summary:'사용자님, 플러그인의 지휘자 실행 기반을 구현했습니다. 메시지 수신부터 보고 이벤트까지 연결했습니다.'}})]),
    loop('long','work-long-title',[task('t-long','work-long-title','고객 문의 응답 자동 분류와 우선순위 조정 및 상담원 배정 규칙 정비를 위한 장기 개선 과제',{domain:'고객 문의 응답 자동 분류와 우선순위 조정',status:'running',minutes:1,request:true,model:'claude-opus-5-5-with-a-very-long-model-identifier'})],'active')];
  // A worker whose loop has no recorded Main conversation (cannot open a session).
  delete entries.find(entry=>entry.id==='roles').mainAgentId;
  const domains={revision:20,domains:[{id:customer,name:'고객',aliases:[],createdBy:by,nameSetBy:by}],
    assignments:Object.fromEntries(['work-api-7f3a','work-db-91c2','work-bug-0d11','work-ui-55e0','work-bug-2b77','work-long-title'].map(agent=>[agent,{domainId:customer,setBy:by}])),removedWorkers:{}};
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries,domains});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  const rows=await page.locator('.maestro-worker-row').evaluateAll(rows=>Object.fromEntries(rows.map(row=>[row.dataset.centerWorker,{
    name:row.querySelector('.maestro-worker-model').textContent,area:row.querySelector('.maestro-worker-area')?.textContent,purpose:row.querySelector('.maestro-worker-purpose').textContent,
    state:row.querySelector('.maestro-worker-status .maestro-state').dataset.status,history:row.querySelector('.maestro-history-button')?.textContent,
    full:row.querySelector('.maestro-worker-title').title,height:Math.round(row.getBoundingClientRect().height),tips:[...row.querySelectorAll('.maestro-worker-line')].map(line=>line.title),
    lines:[...row.querySelectorAll('.maestro-worker-line')].map(line=>[line.classList.contains('is-current')?'current':'result',line.dataset.lineTask,
      line.querySelector('.maestro-worker-task-title')?.textContent,line.querySelector('.maestro-state')?.dataset.status,line.querySelector('.maestro-worker-summary')?.textContent,
      [...line.querySelectorAll('[data-document]')].map(doc=>doc.dataset.document+':'+(doc.tagName==='BUTTON'?'open':doc.textContent)).join(',')])}])));
  const api=rows['work-api-7f3a'];
  // Worker column: the model; title column: the narrower area and the row's task — its most urgent open task — whose
  // state is the status column. The first assignment stays in the tooltip ("Employment purpose").
  assert.deepEqual([api.name,api.area,api.purpose,api.state,api.history],['claude-opus-5-5','API 개발','주문 조회 API에 페이지네이션 추가','running',undefined]);
  assert.match(api.full,/Employment purpose: 주문 조회 API 개발/);
  // Under the row: the row's own task first (no repeated title or state, only its documents), then every other open task
  // with its name and state. Results of earlier tasks stay in the task history, so title and lines never mix tasks.
  assert.deepEqual(api.lines,[['current','api-now/t-api-2',undefined,undefined,undefined,''],['current','api-now/t-api-3','응답 캐시 헤더 정리','waiting',undefined,'']]);
  assert.equal(api.lines.some(line=>['api-origin/t-api-1','api-done/t-api-4'].includes(line[1])),false,'Older results stay in History');
  // A finished single task: line 2 is its title; its result is in the line's full text, not a second visible line.
  assert.deepEqual([rows['work-db-91c2'].name,rows['work-db-91c2'].purpose,rows['work-db-91c2'].lines],['claude-opus-5-5','고객 테이블 인덱스 설계',[['result','db/t-db',undefined,undefined,undefined,'']]],'Same model, separate worker');
  assert.match(rows['work-db-91c2'].tips[0],/인덱스/);
  // The attached case: a short purpose instead of the brief, and the first result sentence instead of the paragraph.
  const coord=rows['coord-matrix-e855264c'];
  // Line 1 always names the sub-domain (or says it is not recorded); line 2 is the whole task title, shortened only by the ellipsis.
  assert.deepEqual([coord.name,coord.area,coord.purpose,coord.state],['gpt-6.1-sol','Not recorded',coordTitle,'completed']);
  // The host's recorded outcome line wins over the first sentence; the first sentence stays the fallback (tooltip has both).
  assert.deepEqual(coord.lines,[['result','coord/t-coord',undefined,undefined,undefined,'']]);
  assert.match(coord.tips[0],/본시험 144회가 모두 통과했습니다\.\n[^]*48개 고유 사례/,'The outcome line, then the full result, in the line\'s full text');
  assert.match(coord.full,/최소 40개 구별되는/,'The full brief stays in the tooltip');
  // A brief that opens with who approved it: the task's own clause; the result without its opening address.
  assert.match(rows['work-brief-1a2b'].purpose,/^사용자님께서 정리한 지휘자 운영 흐름에/);
  assert.match(rows['work-brief-1a2b'].tips[0],/플러그인의 지휘자 실행 기반을 구현했습니다/);
  // Failure, cancellation and a missing result are said as such, never as a success; the state is not repeated.
  assert.deepEqual(rows['work-bug-0d11'].lines,[['result','bug-1/t-bug-1',undefined,undefined,undefined,'']]);
  assert.deepEqual(rows['work-bug-2b77'].lines,[['result','bug-2/t-bug-2',undefined,undefined,undefined,'']]);
  for (const agent of ['work-bug-0d11','work-bug-2b77','work-ui-55e0']) assert.match(rows[agent].tips[0],/Result not collected/,agent);
  assert.deepEqual([rows['work-bug-0d11'].state,rows['work-bug-2b77'].state],['failed','cancelled']);
  assert.equal(rows['work-ui-55e0'].name,'claude · default model');
  // A running single task is the row itself: its line repeats no title or state, only its documents.
  assert.deepEqual([rows['work-long-title'].state,rows['work-long-title'].lines],['running',[['current','long/t-long',undefined,undefined,undefined,'']]]);
  // Compact: every worker is two short lines, never the brief or the result paragraph; there is no membership line.
  for (const agent of ['coord-matrix-e855264c','work-brief-1a2b','work-db-91c2','work-bug-0d11','work-long-title']) assert.ok(rows[agent].height<=56,agent+' row is two shared lines: '+rows[agent].height);
  // Role, hide and open above the model; disabled sessions reserve no space.
  await checkWorkerControls(page, 'Worker summary');
  assert.equal(await page.locator('.maestro-worker-kind').evaluateAll(items=>items.filter(item=>item.textContent.startsWith('Result')).length),0,'No repeated "Result ·" label');
  // Same model and same purpose: numbered, each row still its own worker.
  assert.deepEqual([rows['work-bug-0d11'].name,rows['work-bug-2b77'].name].sort(),['gpt-6.1-sol · 1','gpt-6.1-sol · 2']);
  assert.deepEqual([rows['worker-roles-5b2748a4'].name,rows['worker-roles-5b2748a4'].area],['Model not recorded','Not recorded']);
  assert.equal(await page.locator('.maestro-worker-model').evaluateAll(items=>items.some(item=>item.textContent.includes(item.dataset.openSession))),false,'No row shows its agent ID as the name');
  assert.match(await page.locator('[data-open-session="work-api-7f3a"].maestro-session-open').getAttribute('title'),/work-api-7f3a\/run-t-api-2/,'The ID and run stay reachable on hover');
  // The model reads as clickable: an open glyph and the "Open model session" hint; disabled models carry no glyph.
  assert.equal(await page.locator('[data-open-session="work-api-7f3a"].maestro-session-open .maestro-open-glyph').count(),1);
  assert.match(await page.locator('.maestro-worker-model[data-open-session="work-api-7f3a"]').getAttribute('title'),/^Open model session · /);
  assert.equal(await page.locator('[data-open-session="worker-roles-5b2748a4"].maestro-session-open .maestro-open-glyph').count(),0);
  await page.locator('.maestro-worker-model[data-open-session="work-db-91c2"]').focus();
  await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('.maestro-worker-model[data-open-session="work-db-91c2"]').evaluate(e=>getComputedStyle(e).textDecorationLine),'underline','Focus shows the same cue as hover');
  // Column 1 focus order: hide → open → model, then the title column.
  const focusRow=page.locator('[data-center-worker="work-db-91c2"]');
  for (const key of ['Tab','ArrowDown']) {
    await focusRow.locator('.maestro-worker-hide').focus();
    for (const selector of ['.maestro-session-open','.maestro-worker-model','.maestro-worker-select']) {
      await page.keyboard.press(key);
      assert.equal(await focusRow.locator(selector).evaluate(element=>element===document.activeElement),true,key+': '+selector);
    }
  }
  await focusRow.locator('.maestro-session-open').press('ArrowUp');
  assert.equal(await focusRow.locator('.maestro-worker-hide').evaluate(element=>element===document.activeElement),true);
  // 1. Model open: the model opens that worker's own session through the existing "run" open, by exact agent/run —
  //    its running task first; a worker on the same model opens its own run, never another's.
  const opened=()=>page.evaluate(()=>window.sentMessages.filter(value=>value.type==='project.task.open').at(-1));
  await page.locator('.maestro-worker-model[data-open-session="work-api-7f3a"]').click();
  assert.deepEqual(await opened(),{type:'project.task.open',workflowId:'api-now',taskId:'t-api-2',target:'run',agentId:'work-api-7f3a',runId:'run-t-api-2'});
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'list','Opening the session does not open the detail');
  await page.locator('.maestro-worker-model[data-open-session="work-db-91c2"]').click();
  assert.deepEqual(await opened(),{type:'project.task.open',workflowId:'db',taskId:'t-db',target:'run',agentId:'work-db-91c2',runId:'run-t-db'});
  // Without a recorded Main conversation the host cannot open a session: the model says so and sends nothing.
  const noMain=page.locator('.maestro-worker-model[data-open-session="worker-roles-5b2748a4"]');
  assert.equal(await noMain.isDisabled(),true);assert.match(await noMain.getAttribute('title'),/Main conversation not recorded/);
  const noSessionRow=page.locator('[data-center-worker="worker-roles-5b2748a4"]');
  await noSessionRow.locator('.maestro-worker-hide').press('ArrowDown');
  assert.equal(await noSessionRow.locator('.maestro-worker-select').evaluate(element=>element===document.activeElement),true,'Hidden session controls are skipped');
  // Requests and reports have moved to detail, bound to each exact agent/run.
  const openWorker=async id=>page.locator('[data-select-worker="'+id+'"]').click();
  await openWorker('coord-matrix-e855264c');
  await page.locator('#maestro-detail [data-document="request"]').first().click();
  assert.deepEqual(await opened(),{type:'project.task.open',workflowId:'coord',taskId:'t-coord',target:'request',agentId:'coord-matrix-e855264c',runId:'run-t-coord'});
  await openWorker('work-api-7f3a');
  await page.locator('#maestro-detail [data-document="request"][data-document-run="work-api-7f3a/run-t-api-2"]').click();
  assert.deepEqual(await opened(),{type:'project.task.open',workflowId:'api-now',taskId:'t-api-2',target:'request',agentId:'work-api-7f3a',runId:'run-t-api-2'});
  // Logical removal remains in detail and is blocked while a worker runs.
  const removeApi=page.locator('#maestro-detail [data-remove-worker="work-api-7f3a"]');
  assert.equal(await removeApi.isDisabled(),true);assert.match(await removeApi.getAttribute('title'),/Stop the running task/);
  await openWorker('work-db-91c2');
  const removeDb=page.locator('#maestro-detail [data-remove-worker="work-db-91c2"]');
  assert.equal(await removeDb.isDisabled(),false);
  await removeDb.focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='worker.remove')),[{type:'worker.remove',agentId:'work-db-91c2',revision:20}]);
  assert.equal(await removeDb.isDisabled(),true);
  await post({type:'worker.result',action:'worker.remove',agentId:'work-db-91c2',cancelled:true});
  assert.equal(await removeDb.isDisabled(),false);assert.equal(await page.locator('[data-center-worker="work-db-91c2"]').count(),1);
  assert.match(await page.locator('[data-center-worker="work-api-7f3a"] .maestro-worker-title').getAttribute('title'),/Assignment reason: 주문 API 담당 한 명이 통합합니다\./);
  assert.match(await page.locator('[data-center-worker="coord-matrix-e855264c"] .maestro-worker-line').getAttribute('title'),/48개 고유 사례를 각각 3회 실행하여/);
  await openWorker('coord-matrix-e855264c');
  await page.locator('#maestro-detail [data-document="result"]').first().click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.target==='result').at(-1)),{type:'project.task.open',workflowId:'coord',taskId:'t-coord',target:'result',agentId:'coord-matrix-e855264c',runId:'run-t-coord'});
  // A listed task opens its own task detail.
  await page.locator('[data-center-worker="work-api-7f3a"] [data-center-task="api-now/t-api-3"]').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'t-api-3');
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'work-api-7f3a','Returning focuses the worker');
  // Arrow keys reach the other open task after the worker title; removed links leave no focus stops.
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.centerTask),'api-now/t-api-3');
  // The detail heads with the model, the purpose and the agent ID.
  await page.locator('[data-center-worker="work-api-7f3a"] .maestro-worker-select').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'work-api-7f3a');
  assert.equal(await page.locator('#maestro-detail h2').textContent(),'claude-opus-5-5');
  assert.match(await page.locator('#maestro-detail .maestro-worker-assignment').textContent(),/Sub-domainAPI 개발Employment purpose주문 조회 API 개발/);
  assert.match(await page.locator('#maestro-detail [data-open-session="work-api-7f3a"]').getAttribute('title'),/work-api-7f3a/);
  // Task history: each finished entry keeps its time and state and links that exact run's request and report.
  const history=await page.locator('#maestro-detail .maestro-worker-history-item').evaluateAll(items=>items.map(item=>[item.querySelector('[data-center-task]').dataset.centerTask,item.querySelector('.maestro-state').dataset.status,Boolean(item.querySelector('.maestro-time')?.textContent),[...item.querySelectorAll('[data-document]')].map(doc=>doc.dataset.document+':'+(doc.dataset.documentRun||doc.textContent))]));
  assert.deepEqual(history,[['api-done/t-api-4','completed',true,['request:work-api-7f3a/run-t-api-4','result:work-api-7f3a/run-t-api-4']],['api-origin/t-api-1','completed',true,['request:No request','result:work-api-7f3a/run-t-api-1']]]);
  await page.locator('#maestro-detail .maestro-worker-history-item [data-document="request"]').first().click();
  assert.deepEqual(await opened(),{type:'project.task.open',workflowId:'api-done',taskId:'t-api-4',target:'request',agentId:'work-api-7f3a',runId:'run-t-api-4'});
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  // Search by the agent ID, the model or the area still finds the worker.
  await page.locator('#maestro-search').fill('work-db-91c2');assert.equal(await page.locator('.maestro-worker-row').count(),1);
  await page.locator('#maestro-search').fill('gpt-6.1-sol');assert.equal(await page.locator('.maestro-worker-row').count(),3);
  await page.locator('#maestro-search').fill('UI/UX');assert.equal(await page.locator('.maestro-worker-row').count(),1);
  await page.locator('#maestro-search').fill('');
  // Long names shorten without pushing the columns; the four columns stay aligned and the work area stays inside.
  for (const width of [1100,783,465,320]) {
    await page.setViewportSize({width,height:900});
    const layout=await page.locator('.maestro-list').evaluate(list=>{const rows=[...list.querySelectorAll('.maestro-worker-head, .maestro-worker-row')];const box=element=>element.getBoundingClientRect();const cells=row=>row.classList.contains('maestro-worker-head')?[...row.children]:[row.querySelector('.maestro-role'),row.querySelector(':scope > .maestro-worker-title'),row.querySelector(':scope > .maestro-worker-status')];
      return {overflow:list.scrollWidth>list.clientWidth+1,lefts:rows.map(row=>cells(row).map(cell=>Math.round(box(cell).left))),
        inside:[...list.querySelectorAll('.maestro-worker-row > *, .maestro-worker-work button, .maestro-worker-summary, .maestro-worker-kind, .maestro-worker-work .maestro-state')].find(cell=>box(cell).width>0&&box(cell).right>box(list).right+1)?.outerHTML.slice(0,160)??true,
        oneLine:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const first=cell=>getComputedStyle(row).alignItems==='start'?box(cell).top:box(cell).top+box(cell).height/2;const tops=cells(row).slice(1).map(first);return Math.max(...tops)-Math.min(...tops)<=4;}),
        under:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const work=row.querySelector('.maestro-worker-work');return !work||box(work).top>=Math.max(...cells(row).map(cell=>box(cell).bottom))-1;}),
        controls:[...list.querySelectorAll('.maestro-worker-doc:not(.is-missing), .maestro-worker-model, .maestro-worker-remove, .maestro-worker-select, .maestro-worker-work .maestro-worker-task')].every(element=>box(element).width>20)};});
    assert.equal(layout.overflow,false,width+': no overflow');assert.ok(layout.inside===true,width+': everything inside '+layout.inside);
    for (const index of [1,2]) assert.equal(new Set(layout.lefts.map(value=>value[index])).size,1,width+': column '+(index+1)+' aligned');
    assert.ok(layout.oneLine&&layout.under&&layout.controls,width+': one summary line, work below it, controls usable '+JSON.stringify(layout));
    assert.equal(await page.locator('.maestro-list [data-document], .maestro-list .maestro-history-button, .maestro-list [data-remove-worker]').count(),0,width+': document, history and removal controls are in detail');
    // Role first: the recorded role badge is the leftmost item of every row, before the model, at every width.
    const roleFirst=await page.locator('.maestro-worker-row').evaluateAll(rows=>rows.map(row=>{const cell=row.querySelector('.maestro-worker-cell');const role=cell.querySelector('.maestro-role'),name=cell.querySelector('.maestro-worker-model');
      const r=role.getBoundingClientRect(),n=name.getBoundingClientRect();return [cell.firstElementChild.firstElementChild===role,r.left<=n.left+1&&(r.top<n.top-1||r.right<=n.left+1)];}));
    assert.ok(roleFirst.every(([dom,box])=>dom&&box),width+': role precedes the model '+JSON.stringify(roleFirst));
    await checkWorkerControls(page, width + 'px');
    if (process.env.WORKER_COMPACT_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_COMPACT_EVIDENCE,'control-center-worker-actions-20261010-164335-check-'+width+'.png'),fullPage:true});
  }
  // Vertical alignment: every line of every row starts on its header column (within 1px) at several widths — the first
  // line's four cells, the result text and other tasks at the title column, line states at the status column, the
  // request · report links and the task-history button at the task-history column, and the domain menu at the title column.
  for (const width of [1200,850,816,600,480,360,320]) {
    await page.setViewportSize({width,height:900});
    const misaligned=await page.locator('.maestro-list').evaluate(list=>{
      const L=element=>element.getBoundingClientRect().left;
      const head=[...list.querySelectorAll('.maestro-worker-head > [role="columnheader"]')].map(L);
      const checks=[['.maestro-role',0],['.maestro-worker-model',0],['.maestro-worker-title',1],['.maestro-worker-status',2],['.maestro-history-button',3],['.maestro-worker-kind',1],
        ['.maestro-worker-line-main',1],['.maestro-worker-summary',1],['.maestro-worker-line-state',2],['.maestro-worker-line > .maestro-worker-docs',3],
      ];
      const out=[];let count=0;
      for (const row of list.querySelectorAll('.maestro-worker-row')) for (const [selector,column] of checks) for (const element of row.querySelectorAll(selector)) {
        count++; const delta=L(element)-head[column]; if (Math.abs(delta)>1) out.push(row.dataset.centerWorker+' '+selector+' '+delta.toFixed(1));
      }
      return {count,out,overflow:list.scrollWidth>list.clientWidth+1};
    });
    assert.ok(misaligned.count>60,width+': alignment measured on '+misaligned.count+' elements');
    assert.deepEqual(misaligned.out,[],width+': every line starts on its header column');
    assert.equal(misaligned.overflow,false,width+': no horizontal overflow');
    // Two shared horizontal lines per row: line 1 (role, title, state, task-history button) and line 2 (model, result text,
    // request · report links) each sit on one centre line (within 2px), and line 2 lies below line 1.
    await checkWorkerControls(page, width + 'px alignment');
    const lines=await page.locator('.maestro-list').evaluate(list=>{
      const mid=element=>{const box=element.getBoundingClientRect();return (box.top+box.bottom)/2;};
      // Line 2 may hold wrapped text (narrow: "No request / No report" on two lines); its reference is the first 18px text line.
      const first=element=>element.getBoundingClientRect().top+9;
      let worst1=0,worst2=0,order=0,count=0;
      for (const row of list.querySelectorAll('.maestro-worker-row')) {
        const one=['.maestro-role','.maestro-worker-title','.maestro-worker-status .maestro-state','.maestro-history-button'].map(selector=>row.querySelector(selector)).filter(Boolean).map(mid);
        const two=['.maestro-worker-model','.maestro-worker-line-main','.maestro-worker-docs'].map(selector=>row.querySelector(selector)).filter(Boolean).map(first);
        worst1=Math.max(worst1,Math.max(...one)-Math.min(...one));worst2=Math.max(worst2,Math.max(...two)-Math.min(...two));if (Math.min(...two)-9<Math.max(...one)) order++;count++;
      }
      return {worst1,worst2,order,count};
    });
    assert.ok(lines.count>8&&lines.order===0,width+': line 2 is below line 1 '+JSON.stringify(lines));
    assert.ok(lines.worst1<=2&&lines.worst2<=2,width+': both lines share one centre line '+JSON.stringify(lines));
    // The column header row is not shown: no height, no separator and no gap above the first worker row,
    // while its accessible column names remain.
    const hidden=await page.locator('.maestro-list').evaluate(list=>{const head=list.querySelector('.maestro-worker-head');const first=head.nextElementSibling;const style=getComputedStyle(head);
      return {height:head.getBoundingClientRect().height,border:style.borderBottomWidth,gap:Math.round(first.getBoundingClientRect().top-head.getBoundingClientRect().bottom),
        names:[...head.querySelectorAll('[role="columnheader"]')].map(cell=>cell.textContent)};});
    assert.deepEqual([hidden.height,hidden.border],[0,'0px'],width+': header row has no visible height or separator');
    assert.ok(hidden.gap<=6,width+': the next list item follows with only its first-item spacing '+hidden.gap);
    assert.equal(hidden.names.filter(Boolean).length,3,width+': accessible column names remain');
    await page.setViewportSize({width,height:360});
    await page.locator('.maestro-list').evaluate(list=>{list.scrollTop=list.scrollHeight;});
    assert.ok(await page.locator('.maestro-list').evaluate(list=>list.scrollTop>0),width+': the list scrolled');
    if (process.env.WORKER_ALIGN_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_ALIGN_EVIDENCE,'after-20261011-header-flush-scrolled-fixture-'+width+'.png')});
    await page.locator('.maestro-list').evaluate(list=>{list.scrollTop=0;});await page.setViewportSize({width,height:900});
    if (process.env.WORKER_ALIGN_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_ALIGN_EVIDENCE,'after-20261011-alignment-fixture-'+width+'.png'),fullPage:true});
  }
  // Dragging still moves the worker by its ID.
  await page.setViewportSize({width:1100,height:700});
  await page.locator('[data-center-worker="work-brief-1a2b"] .maestro-role').dragTo(page.locator('[data-drop-target="'+customer+'"]'));
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='domain.assign').at(-1)),{type:'domain.assign',agentId:'work-brief-1a2b',domainId:customer,revision:20});
}

// Reordering workers by drag and drop (or the handle's arrow keys) changes their display order only. The order is saved
// by agent ID through the host and restored on refresh and reopen; selection, drafts and run state stay with each ID.
async function checkWorkerReorder(page, post) {
  const evidence=process.env.PERFORMER_DND_EVIDENCE;
  const shot=async name=>{ if (evidence) await page.screenshot({path:path.join(evidence,'performer-dnd-20261010-201415-'+name+'.png')}); };
  await page.setViewportSize({width:1100,height:760});
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString();
  const task=(id,agent,title,{status='completed',minutes=5,model='claude-opus-5-5'}={})=>({id,title,workAgentId:agent,workStatus:status,
    runs:[{role:'work',agentId:agent,runId:'run-'+id,status,model,startedAt:at(minutes+2),...(status==='running'?{}:{finishedAt:at(minutes)}),
      ...(status==='completed'?{receipt:{outcome:'completed'}}:{})}],commands:[]});
  const loop=(id,agent,tasks,status='completed')=>({id,title:id,mainAgentId:'main-order',status,loopId:'loop-'+id,workAgentId:agent,updatedAt:at(1),tasks});
  // Two workers share a model and purpose (numbered), one runs, and all sit in one (unclassified) group.
  let entries=[loop('o-run','perf-run',[task('t-run','perf-run','실행 중 작업',{status:'running',minutes:1})],'active'),
    loop('o-twin-a','perf-twin-a',[task('t-twin-a','perf-twin-a','같은 목적 작업',{minutes:10})]),
    loop('o-twin-b','perf-twin-b',[task('t-twin-b','perf-twin-b','같은 목적 작업',{minutes:20})]),
    loop('o-gpt','perf-gpt',[task('t-gpt','perf-gpt','다른 모델 작업',{minutes:30,model:'gpt-6.1-sol'})])];
  // Every worker belongs to one real domain, as Main places it at dispatch (the new worker below included).
  const area='domain-0a0a0a0a0a0a', by={actor:'ai',at:at(1),source:'loop'};
  const domains={revision:30,domains:[{id:area,name:'Order area',aliases:[],createdBy:by,nameSetBy:by}],
    assignments:Object.fromEntries(['perf-run','perf-twin-a','perf-twin-b','perf-gpt','perf-new'].map(agent=>[agent,{domainId:area,setBy:by}])),removedWorkers:{}};
  // The previous check left its membership save open; answer it so no edit is still saving.
  await post({type:'domain.result',edit:'domain.assign'});
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await selectFilter(page, '#maestro-status', '');await selectFilter(page, '#maestro-scope', '');await selectFilter(page, '#maestro-domain', '');
  await post({type:'project.tasks',entries,domains,workerOrder:[]});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  const shown=()=>page.locator('.maestro-worker-row').evaluateAll(rows=>rows.map(row=>row.dataset.centerWorker));
  const orders=()=>page.evaluate(()=>window.sentMessages.filter(value=>value.type==='worker.order'));
  const others=()=>page.evaluate(()=>window.sentMessages.filter(value=>['worker.command','worker.stop','worker.remove','worker.handoff','domain.assign','project.task.open'].includes(value.type)).length);
  const row=agent=>page.locator('[data-center-worker="'+agent+'"]');
  const names=()=>page.locator('.maestro-worker-row').evaluateAll(rows=>Object.fromEntries(rows.map(row=>[row.dataset.centerWorker,row.querySelector('.maestro-worker-model').textContent])));
  assert.equal(await page.locator('[data-membership-required="true"]').count(),0,'All four workers are members of a real domain');
  const initial=await shown();
  assert.deepEqual(initial,['perf-run','perf-twin-a','perf-twin-b','perf-gpt'],'Without a saved order the usual order is kept');
  const twinNames=await names();
  assert.notEqual(twinNames['perf-twin-a'],twinNames['perf-twin-b'],'Same model and purpose are told apart');
  // The drag handle and its dedicated empty cell have been removed.
  assert.equal(await page.locator('.maestro-worker-grip, .maestro-worker-row > .maestro-worker-history').count(),0);
  assert.equal(await row('perf-gpt').getAttribute('draggable'),'true');
  // Reordering keeps the selected performer and its open detail.
  await page.locator('[data-select-worker="perf-twin-b"]').click();
  const before=await others();
  // A real drag from the worker row (Playwright's native drag and drop) onto the upper or lower edge of another row.
  const drag=async (from,to,where)=>{
    const box=await row(to).boundingBox();
    await row(from).dragTo(row(to),{targetPosition:{x:box.width/2,y:where==='before'?3:box.height-3}});
  };
  // The state while a drag is in progress, held still for inspection: the same events the browser sends.
  const hold=async (from,to,where)=>{
    const data=await page.evaluateHandle(()=>new DataTransfer());
    await row(from).dispatchEvent('dragstart',{dataTransfer:data});
    const box=await row(to).boundingBox();
    await row(to).dispatchEvent('dragover',{dataTransfer:data,clientX:box.x+box.width/2,clientY:where==='before'?box.y+3:box.y+box.height-3});
    return async ()=>{ await row(from).dispatchEvent('dragend',{dataTransfer:data}); };
  };
  // Back → front: the last worker goes before the first.
  let release=await hold('perf-gpt','perf-run','before');
  assert.equal(await row('perf-run').getAttribute('data-drop-position'),'before','The insertion line shows above the target');
  assert.equal(await page.locator('.is-reorder-target').count(),1);
  assert.equal(await row('perf-gpt').evaluate(element=>element.classList.contains('is-drag-source')),true);
  assert.notEqual(await row('perf-run').evaluate(element=>getComputedStyle(element).boxShadow),'none');
  await shot('dragging-1100');
  await release();
  assert.equal(await page.locator('.is-reorder-target, .is-drag-source').count(),0,'Ending the drag without a drop clears the marks');
  assert.deepEqual(await shown(),initial,'Ending the drag without a drop keeps the order');
  await drag('perf-gpt','perf-run','before');
  assert.deepEqual(await shown(),['perf-gpt','perf-run','perf-twin-a','perf-twin-b']);
  assert.deepEqual((await orders()).at(-1),{type:'worker.order',order:['perf-gpt','perf-run','perf-twin-a','perf-twin-b']});
  assert.equal(await page.locator('.is-reorder-target, .is-drag-source').count(),0,'Marks clear after the drop');
  // Middle: the first worker goes after the second.
  release=await hold('perf-gpt','perf-run','after');
  assert.equal(await row('perf-run').getAttribute('data-drop-position'),'after','The insertion line shows below the target');
  await release();
  await drag('perf-gpt','perf-run','after');
  assert.deepEqual(await shown(),['perf-run','perf-gpt','perf-twin-a','perf-twin-b']);
  // Front → back: the first worker goes after the last.
  await drag('perf-run','perf-twin-b','after');
  assert.deepEqual(await shown(),['perf-gpt','perf-twin-a','perf-twin-b','perf-run']);
  // Display only: selection, detail, typed draft, running mark and numbered names stay with their agent IDs.
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'perf-twin-b');
  assert.equal(await page.evaluate(()=>window.saved.centerSelection.agentId),'perf-twin-b');
  assert.equal(await row('perf-twin-b').getAttribute('aria-current'),'true');
  assert.equal(await row('perf-run').getAttribute('data-running'),'true');
  assert.deepEqual(await names(),twinNames,'Moving rows never renumbers same-model workers');
  assert.equal(await others(),before,'No worker, run, domain or session message is sent by reordering');
  // Dropping on itself, and a cancelled drag (Escape / released outside), change nothing.
  const sentBefore=(await orders()).length;
  release=await hold('perf-twin-a','perf-twin-a','after');
  assert.equal(await page.locator('.is-reorder-target').count(),0,'No insertion line on the moved row itself');
  await release();
  await drag('perf-twin-a','perf-twin-a','after');
  release=await hold('perf-twin-a','perf-run','before');await release();
  assert.equal((await orders()).length,sentBefore,'Self drop and a cancelled drag send nothing');
  assert.equal(await page.locator('.is-reorder-target, .is-drag-source').count(),0,'A cancelled drag leaves no marks');
  assert.deepEqual(await shown(),['perf-gpt','perf-twin-a','perf-twin-b','perf-run']);
  // Reordering the whole row preserves display order without a separate handle.
  await drag('perf-run','perf-twin-b','before');
  assert.deepEqual(await shown(),['perf-gpt','perf-twin-a','perf-run','perf-twin-b']);
  await drag('perf-run','perf-twin-b','after');
  assert.deepEqual(await shown(),['perf-gpt','perf-twin-a','perf-twin-b','perf-run']);
  // While saves are pending, a periodic refresh carrying the older saved order does not move rows back.
  await post({type:'project.tasks',entries,domains,workerOrder:['perf-run','perf-twin-a','perf-twin-b','perf-gpt']});
  assert.deepEqual(await shown(),['perf-gpt','perf-twin-a','perf-twin-b','perf-run']);
  const saved=(await orders()).at(-1).order;
  for (const value of await orders()) if (value!==undefined) await post({type:'worker.order.result',order:saved});
  await post({type:'project.tasks',entries,domains,workerOrder:saved});
  assert.deepEqual(await shown(),saved,'The host order is shown after the saves return');
  // A failed save shows the order the host kept, with the error.
  await drag('perf-gpt','perf-twin-a','after');
  await post({type:'worker.order.result',order:saved,error:'Fixture storage unavailable'});
  assert.match(await page.locator('.maestro-order-error').textContent(),/could not be saved: Fixture storage unavailable/);
  assert.deepEqual(await shown(),saved);
  // Reopen: a new tab restores the host's saved order (here also different from the tab's own saved state).
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify({...window.saved,workerOrder:undefined})));
  await page.reload();
  await post({type:'project.tasks',entries,domains,workerOrder:saved});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  assert.deepEqual(await shown(),saved,'The saved order returns after reopening');
  // Added and removed workers: a new worker leads (usual order), a gone worker leaves no gap, stale IDs are ignored.
  entries=[...entries.filter(entry=>entry.workAgentId!=='perf-twin-a'),loop('o-new','perf-new',[task('t-new','perf-new','새 작업',{minutes:0})])];
  await post({type:'project.tasks',entries,domains,workerOrder:[...saved,'perf-stale']});
  assert.deepEqual(await shown(),['perf-new',...saved.filter(id=>id!=='perf-twin-a')]);
  assert.equal(new Set(await shown()).size,(await shown()).length,'No worker is listed twice');
  await drag('perf-new','perf-run','after');
  assert.deepEqual((await orders()).at(-1).order,['perf-gpt','perf-twin-b','perf-run','perf-new'],'The saved order drops IDs no longer recorded');
  await post({type:'worker.order.result',order:(await orders()).at(-1).order});
  // Narrow editor: no handle or empty control cell; whole-row dragging remains usable.
  await page.setViewportSize({width:320,height:640});
  assert.equal(await page.locator('.maestro-worker-grip, .maestro-worker-row > .maestro-worker-history').count(),0);
  assert.equal(await page.locator('#maestro-tasks').evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'320: no horizontal overflow');
  release=await hold('perf-run','perf-gpt','before');
  await shot('dragging-320');
  await release();
  await drag('perf-run','perf-gpt','before');
  assert.deepEqual(await shown(),['perf-run','perf-gpt','perf-twin-b','perf-new']);
  await post({type:'worker.order.result',order:(await orders()).at(-1).order});
  // Filtering hides workers, so rows and handles wait until the full list is shown.
  await page.locator('#maestro-search').fill('perf-gpt');
  assert.equal(await row('perf-gpt').getAttribute('draggable'),'false');
  assert.equal(await page.locator('[data-reorder-worker]').count(),0);
  await page.locator('#maestro-search').fill('');
  await page.setViewportSize({width:1100,height:760});
  await shot('after-1100');
}

async function checkWorkerDisplay(page, post) {
  const statuses=['running','verifying','waiting','blocked','decision','completed','failed','cancelled','unknown'];
  const domains={revision:1,domains:[{id:'domain-a',name:'분류 A'},{id:'domain-b',name:'분류 B'}],assignments:{},removedWorkers:{}};
  const entries=statuses.map((status,index)=>{
    const agentId='display-'+status;
    domains.assignments[agentId]={domainId:index%2?'domain-b':'domain-a'};
    const run={agentId,runId:'run-'+status,role:'work',workProfile:'work',model:'동일 모델',request:{availability:'recorded',summary:'요청 원문'},status:status==='verifying'?'completed':status==='decision'?'needs-human-decision':status==='waiting'?'pending':status==='blocked'?'blocked':status,startedAt:'2026-10-12T13:00:00Z',result:{availability:'recorded',summary:'결과 원문 보존'}};
    if(status==='completed')run.receipt={outcome:'completed'};
    return {id:'flow-'+status,title:status,mainAgentId:index%2?'main-b':'main-a',workAgentId:agentId,loopId:'loop-'+status,status:status==='completed'?'completed':status==='decision'?'needs-human-decision':['failed','cancelled'].includes(status)?status:'active',decisionReason:status==='blocked'?'external prerequisite unavailable':undefined,updatedAt:'2026-10-12T13:00:00Z',tasks:[{id:'task-'+status,title:status+' 상세 원본',domain:index%2?'분류 B':'분류 A',workStatus:status==='verifying'?'completed':status==='waiting'?'pending':status,verificationStatus:status==='verifying'?'pending':undefined,runs:[run]}]};
  });
  await post({type:'project.tasks',entries,domains,hiddenWorkers:[]});
  await page.locator('#maestro-scope-all').click();
  assert.equal(await page.locator('#maestro-center-title').count(),0);
  assert.equal(await page.locator('.maestro-worker-row').count(),9);
  assert.equal(await page.locator('.maestro-worker-grip, [data-reorder-worker], .maestro-worker-row > .maestro-worker-history').count(),0);
  assert.equal(await page.locator('.maestro-list').evaluate(el=>getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length),3,'The dedicated fourth column is removed');
  assert.equal(await page.locator('.maestro-list .maestro-history-button, .maestro-list [data-document], .maestro-list [data-remove-worker]').count(),0);
  assert.deepEqual(await page.locator('.maestro-worker-head [role="columnheader"]').allTextContents(),['수행자','제목','상태']);
  const count=await page.locator('#maestro-workers-count').textContent();
  const source=JSON.stringify(entries);
  const hide=page.locator('[data-visibility-worker="display-running"]');
  assert.match(await hide.getAttribute('aria-label'),/목록에서 숨기기/);
  assert.notEqual(await hide.locator('path').getAttribute('d'),await page.locator('[data-center-worker="display-running"] .maestro-session-open path').getAttribute('d'));
  await hide.focus();await page.keyboard.press('Enter');
  const messages=()=>page.evaluate(()=>window.sentMessages);
  assert.deepEqual((await messages()).at(-1),{type:'worker.visibility',agentId:'display-running',hidden:true});
  await post({type:'worker.visibility.result',hiddenWorkers:['display-running']});
  assert.equal(await page.locator('[data-center-worker="display-running"]').count(),0);
  assert.equal(await page.locator('#maestro-workers-count').textContent(),count);
  await post({type:'project.tasks',entries,domains,hiddenWorkers:['display-running']});
  assert.equal(await page.locator('[data-center-worker="display-running"]').count(),0,'Refresh restores the host preference');
  await page.locator('#maestro-filter-toggle').click();
  await page.locator('#maestro-show-hidden').check();
  assert.equal(await page.locator('[data-center-worker="display-running"]').count(),1);
  assert.match(await page.locator('[data-visibility-worker="display-running"]').getAttribute('aria-label'),/목록에 다시 표시/);
  await page.keyboard.press('Escape');
  await page.locator('[data-visibility-worker="display-running"]').click();
  assert.deepEqual((await messages()).at(-1),{type:'worker.visibility',agentId:'display-running',hidden:false});
  await post({type:'worker.visibility.result',hiddenWorkers:[]});
  assert.equal(JSON.stringify(entries),source,'Hiding does not mutate tasks or runs');
  assert.equal((await messages()).filter(m=>['worker.stop','worker.remove'].includes(m.type)).length,0);
  await page.locator('[data-select-worker="display-completed"]').click();
  assert.equal(await page.locator('#maestro-detail .maestro-worker-history-block').count(),1);
  await page.locator('#maestro-detail [data-document="request"]').first().click();
  assert.deepEqual((await messages()).at(-1),{type:'project.task.open',workflowId:'flow-completed',taskId:'task-completed',target:'request',agentId:'display-completed',runId:'run-completed'});
  assert.equal(await page.locator('#maestro-detail button').filter({hasText:'수행자 삭제'}).count(),1,'Logical deletion remains available in detail');
  await page.locator('#maestro-detail .maestro-close').click();
  await page.locator('#maestro-filter-toggle').click();
  await page.locator('#maestro-status-running').check();
  await page.locator('#maestro-status-completed').check();
  assert.equal(await page.locator('#maestro-filter-popover').isVisible(),true);
  assert.deepEqual((await page.locator('[data-center-worker]').evaluateAll(rows=>rows.map(r=>r.dataset.centerWorker))).sort(),['display-completed','display-running','display-verifying']);
  assert.match(await page.locator('#maestro-status-summary').textContent(),/실행 중.*완료/);
  await page.locator('#maestro-domain').selectOption('domain-a');
  await page.locator('#maestro-scope').selectOption('main-a');
  assert.deepEqual(await page.locator('[data-center-worker]').evaluateAll(rows=>rows.map(r=>r.dataset.centerWorker)),['display-running']);
  await page.locator('#maestro-status-all').check();
  assert.equal(await page.locator('#maestro-status-running').isChecked(),false);
  assert.equal(await page.locator('#maestro-domain').inputValue(),'domain-a');
  assert.equal(await page.locator('#maestro-scope').inputValue(),'main-a');
  await page.locator('#maestro-domain').selectOption('');await page.locator('#maestro-scope').selectOption('');
  // Every option fits the popover without internal scrolling; the popover stays within each viewport.
  for(const [width,height] of [[890,600],[320,480],[890,300],[320,320]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(30);
    const geometry=await page.locator('#maestro-filter-popover').evaluate(el=>{
      const r=el.getBoundingClientRect();
      return {sizes:[el.scrollWidth,el.clientWidth,el.scrollHeight,el.clientHeight],overflow:[...el.querySelectorAll('*')].filter(c=>c.getBoundingClientRect().right>r.right||c.getBoundingClientRect().bottom>r.bottom).map(c=>c.outerHTML.slice(0,150)),fits:el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1,viewport:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,options:[...el.querySelectorAll('[data-status]')].every(input=>{const b=input.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;})};
    });
    assert.deepEqual({fits:geometry.fits,viewport:geometry.viewport,options:geometry.options},{fits:true,viewport:true,options:true},JSON.stringify({width,height,geometry}));
    assert.equal(await page.locator('#maestro-status-options [data-status]').count(),10);
    if(process.env.WORKER_DISPLAY_EVIDENCE&&width===320&&height===480) await page.screenshot({path:path.join(process.env.WORKER_DISPLAY_EVIDENCE,'worker-display-320.png')});
  }
  for(const theme of ['vscode-light','vscode-high-contrast','vscode-dark']) {
    await page.evaluate(theme=>{
      document.body.className=theme;
      const colors=theme==='vscode-light'?['#fff','#333','#f3f3f3','#bbb']:theme==='vscode-high-contrast'?['#000','#fff','#000','#fff']:['#1e1e1e','#d4d4d4','#252526','#454545'];
      for(const [index,key] of ['--vscode-editor-background','--vscode-foreground','--vscode-editorWidget-background','--vscode-panel-border'].entries())document.documentElement.style.setProperty(key,colors[index]);
    },theme);
    await page.setViewportSize({width:320,height:320});
    for(const status of statuses)await page.locator('#maestro-status-'+status).check();
    assert.ok(await page.locator('#maestro-filter-popover').evaluate(el=>{const r=el.getBoundingClientRect();return el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1&&r.bottom<=innerHeight+1;}),theme+': all statuses remain visible');
    await page.locator('#maestro-status-all').check();
    await checkWorkerControls(page, theme);
  }
  await page.locator('#maestro-status-all').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'maestro-status-running');
  await page.keyboard.press('Space');assert.equal(await page.locator('#maestro-status-running').isChecked(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#maestro-filter-popover').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'maestro-filter-toggle');
  await page.setViewportSize({width:890,height:600});
  await page.locator('#maestro-filter-toggle').click();await page.locator('#maestro-status-all').check();await page.keyboard.press('Escape');
  if(process.env.WORKER_DISPLAY_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_DISPLAY_EVIDENCE,'worker-display-890.png')});
  // The same multi-status union applies to tasks, including all nine recorded status categories.
  await page.locator('#maestro-tasks-view').click();await page.locator('#maestro-filter-toggle').click();
  for(const status of statuses) {
    await page.locator('#maestro-status-all').check();await page.locator('#maestro-status-'+status).check();
    assert.deepEqual(await page.locator('.maestro-card').evaluateAll(cards=>cards.map(card=>card.dataset.centerTask)),['flow-'+status+'/task-'+status]);
  }
  await page.locator('#maestro-status-running').check();
  assert.deepEqual((await page.locator('.maestro-card').evaluateAll(cards=>cards.map(card=>card.dataset.centerTask))).sort(),['flow-running/task-running','flow-unknown/task-unknown']);
  await page.keyboard.press('Escape');
  // Legacy saved single-status selections remain usable; hidden IDs come from the project host after reopening.
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify({...window.saved,centerView:'workers',centerScope:'all',centerFilter:{status:'running'}})));
  await page.reload();await post({type:'project.tasks',entries,domains,hiddenWorkers:['display-running']});
  assert.equal(await page.locator('[data-center-worker="display-running"]').count(),0);
  await page.locator('#maestro-filter-toggle').click();await page.locator('#maestro-show-hidden').check();
  assert.equal(await page.locator('#maestro-status-running').isChecked(),true);
  assert.equal(await page.locator('[data-center-worker="display-running"]').count(),1);
  await page.keyboard.press('Escape');
}


// Status column regression: real time labels and badges must fit without shortening, including a narrowed split pane.
async function checkWorkerStatusTime(page, post) {
  const ages = [4 * 60 + 1, 15 * 60 + 1, 2 * 24 * 60 + 1, 400 * 24 * 60, null, 15 * 60 + 30];
  const entries = ages.map((minutes, index) => {
    const agentId = 'status-time-' + index;
    const at = minutes === null ? undefined : new Date(Date.now() - minutes * 60000).toISOString();
    const status = index === ages.length - 1 ? 'running' : index === 1 ? 'needs-human-decision' : 'completed';
    return {id: agentId, title: 'Time width fixture', status: status === 'running' ? 'active' : status, workAgentId: agentId,
      updatedAt: at, tasks: [{id: agentId, title: 'A long assignment title yields space to the complete status and time',
        workStatus: status, runs: [{agentId, runId: agentId, role: 'work', status,
          model: 'GPT', ...(status === 'running' ? {startedAt: at} : {finishedAt: at}),
          ...(status === 'completed' ? {receipt: {outcome: 'completed'}} : {})}]}]};
  });
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');
  await selectFilter(page, '#maestro-status', '');
  await selectFilter(page, '#maestro-domain', '');
  await post({type: 'project.tasks', entries, domains: {revision: 1, domains: [], assignments: {}, removedWorkers: {}}});
  await page.locator('#maestro-scope-all').click();
  if (await page.locator('#maestro-workspace').getAttribute('data-layout') === 'split')
    await page.locator('#maestro-detail .maestro-close').click();
  const inspect = async context => {
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const sizes = await page.locator('.maestro-worker-row > .maestro-worker-status').evaluateAll(cells => cells.map(cell => {
      const time = cell.querySelector('.maestro-time');
      const badge = cell.querySelector('.maestro-state');
      const bounds = cell.getBoundingClientRect();
      const list = cell.closest('.maestro-list').getBoundingClientRect();
      const fits = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && element.scrollWidth <= element.clientWidth && rect.left >= bounds.left &&
          rect.right <= bounds.right + 0.5 && rect.right <= list.right + 0.5;
      };
      const sameLine = !!time && Math.abs((time.getBoundingClientRect().top+time.getBoundingClientRect().bottom-badge.getBoundingClientRect().top-badge.getBoundingClientRect().bottom)/2)<=1;
      const wrapped = !!time && time.getBoundingClientRect().top>=badge.getBoundingClientRect().bottom-.5;
      return {text:time?.textContent,time:fits(time),badge:fits(badge),arranged:cell.closest('.maestro-list').clientWidth>400?sameLine:sameLine||wrapped};
    }));
    assert.equal(sizes.length, ages.length, context + ': every worker has a status cell');
    assert.ok(sizes.every(size => size.text && size.time && size.badge && size.arranged), context + ': ' + JSON.stringify(sizes));
    assert.equal(await page.locator('.maestro-list.is-workers').evaluate(list => list.scrollWidth <= list.clientWidth + 1), true, context + ': no horizontal overflow');
  };
  for (const width of [1100, 783, 465, 320]) {
    await page.setViewportSize({width, height: 700});
    await inspect(width + 'px');
  }
  await page.locator('.maestro-list .maestro-time').evaluateAll(times => times.forEach(time => {time.style.fontSize = '20px';}));
  await inspect('320px enlarged time text');
  await page.locator('.maestro-list .maestro-time').evaluateAll(times => times.forEach(time => {time.style.removeProperty('font-size');}));
  await page.setViewportSize({width: 1100, height: 700});
  await page.locator('[data-select-worker="status-time-0"]').click();
  await page.locator('.maestro-list.is-workers').evaluate(list => {list.style.width = '300px';});
  try {
    await page.waitForFunction(() => document.querySelector('.maestro-list.is-workers')?.dataset.compact === 'true');
    await inspect('300px compact split pane');
  } finally {
    await page.locator('.maestro-list.is-workers').evaluate(list => {list.style.removeProperty('width');});
    await page.locator('#maestro-detail .maestro-close').click();
  }
}

// Whole-row activity: actual running work moves, terminal/waiting/blocked work stays still.
async function checkWorkerRowMotion(page, post) {
  await page.locator('#maestro-search').fill('');
  await page.locator('#maestro-workers-view').click();
  if (await page.locator('#maestro-scope-all').isVisible()) await page.locator('#maestro-scope-all').click();
  await selectFilter(page, '#maestro-status', '');
  const entries = ['running', 'completed', 'waiting', 'blocked'].map(status => ({
    id: 'motion-' + status, title: 'Motion fixture', status: status === 'completed' ? 'completed' : 'active',
    loopId: 'motion-loop-' + status, workAgentId: 'motion-' + status,
    tasks: [{ id: 'motion-task-' + status, title: 'Readable task title', workStatus: status === 'waiting' ? 'pending' : status,
      runs: [{ role: 'work', agentId: 'motion-' + status, runId: 'motion-run-' + status, status: status === 'waiting' ? 'pending' : status }] }]
  }));
  await post({type: 'project.tasks', entries});
  await page.waitForFunction(() => document.querySelectorAll('[data-center-worker^="motion-"]').length === 4);
  const row = page.locator('[data-center-worker="motion-running"]');
  const sample = () => row.evaluate(element => {
    const box = element.getBoundingClientRect();
    const state = element.querySelector('.maestro-worker-status .maestro-state');
    const dot = getComputedStyle(state, '::before');
    const label = state.getBoundingClientRect();
    const textRange = document.createRange();
    textRange.selectNodeContents(state);
    const text = textRange.getBoundingClientRect();
    return {opacity: getComputedStyle(element, '::before').opacity, scan: getComputedStyle(element, '::after').backgroundPosition,
      dot: {animation: dot.animationName, opacity: dot.opacity, transform: dot.transform},
      textOffset: [text.x - label.x, text.y - label.y, text.width, text.height], box: [box.x, box.y, box.width, box.height]};
  });
  await page.emulateMedia({reducedMotion: 'no-preference'});
  for (const width of [795, 320]) {
    await page.setViewportSize({width, height: 700});
    for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast']) {
      await page.evaluate(theme => {
        document.body.className = theme;
        document.documentElement.style.setProperty('--vscode-textLink-foreground', theme === 'vscode-light' ? '#006ab1' : '#4daafc');
        document.documentElement.style.setProperty('--vscode-foreground', theme === 'vscode-light' ? '#333' : '#fff');
        document.documentElement.style.setProperty('--vscode-editor-background', theme === 'vscode-light' ? '#fff' : '#1e1e1e');
      }, theme);
      const before = await sample();
      await page.waitForFunction(previous => {
        const el = document.querySelector('[data-center-worker="motion-running"]');
        const state = el.querySelector('.maestro-worker-status .maestro-state');
        const dot = getComputedStyle(state, '::before');
        return getComputedStyle(el, '::before').opacity !== previous.opacity && getComputedStyle(el, '::after').backgroundPosition !== previous.scan
          && dot.animationName === 'maestro-status-dot-pulse' && (dot.opacity !== previous.dot.opacity || dot.transform !== previous.dot.transform);
      }, before);
      const after = await sample();
      if (process.env.WORKER_MOTION_EVIDENCE) await page.screenshot({path: path.join(process.env.WORKER_MOTION_EVIDENCE, 'worker-motion-' + theme + '-' + width + '.png')});
      assert.deepEqual(after.box, before.box, 'Motion never changes row geometry');
      assert.deepEqual(after.textOffset, before.textOffset, 'Dot pulse never moves or resizes the status text');
      assert.ok(await row.evaluate(el => ['::before', '::after'].every(pseudo => {
        const style = getComputedStyle(el, pseudo), box = el.getBoundingClientRect();
        return style.pointerEvents === 'none' && Math.abs(parseFloat(style.width) - el.clientWidth) <= 1
          && Math.abs(parseFloat(style.height) - el.clientHeight) <= 1 && box.height > 30;
      })), 'Both layers cover all columns and lines without blocking controls');
      for (const status of ['completed', 'waiting', 'blocked']) {
        assert.ok(await page.locator('[data-center-worker="motion-' + status + '"]').evaluate(el =>
          ['::before', '::after'].every(pseudo => getComputedStyle(el, pseudo).animationName === 'none')
          && getComputedStyle(el.querySelector('.maestro-worker-status .maestro-state'), '::before').animationName === 'none'), status + ' stays static');
      }
    }
  }
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.ok(await row.evaluate(el => {
    const pulse = getComputedStyle(el, '::before'), scan = getComputedStyle(el, '::after');
    const dot = getComputedStyle(el.querySelector('.maestro-worker-status .maestro-state'), '::before');
    return pulse.animationName === 'none' && scan.animationName === 'none' && scan.content === 'none'
      && pulse.opacity === '1' && pulse.backgroundColor !== 'rgba(0, 0, 0, 0)'
      && dot.animationName === 'none' && dot.opacity === '1' && dot.transform === 'none';
  }), 'Reduced motion leaves static status dot and subtle row tint');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  entries[0].tasks[0].workStatus = 'completed';
  entries[0].tasks[0].runs[0].status = 'completed';
  await post({type: 'project.tasks', entries});
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-center-worker="motion-running"]');
    return getComputedStyle(row, '::before').animationName === 'none'
      && getComputedStyle(row.querySelector('.maestro-worker-status .maestro-state'), '::before').animationName === 'none';
  });
  await page.setViewportSize({width: 795, height: 700});
}

// Independent column-2 fixture preserves other workers' browser checks.
async function checkWorkerColumn2(page, post) {
  const currentTitle = '사용자님이 승인하셨습니다. 현재 수행하는 작업의 원문 제목과 긴 세부 사항을 그대로 표시하십시오.';
  const latestTitle = '가장 최근 완료한 작업의 긴 제목을 생략 표시하되 hover에서 원문 전체를 확인합니다.';
  const makeTask = (id, title, status, at, domain) => ({id, title, domain, workStatus:status, updatedAt:at,
    runs:[{role:'work',agentId:'col2-worker',runId:'run-'+id,status,model:'Column 2 model',startedAt:at,
      request:{availability:'recorded',summary:'Exact request'},result:{availability:'recorded',summary:'결과 문장은 상세 화면에서 보존됩니다.',highlight:'완료 결과 보존'},
      ...(status==='completed'?{receipt:{outcome:'completed'}}:{})}]});
  const tasks=[makeTask('current',currentTitle,'running','2026-10-12T14:00:00Z','작업 칸 서브 도메인'),makeTask('latest',latestTitle,'completed','2026-10-12T15:00:00Z','작업 칸 서브 도메인')];
  const entry={id:'col2-flow',title:'Column 2 fixture',status:'active',mainAgentId:'main-col2',workAgentId:'col2-worker',loopId:'col2-loop',updatedAt:'2026-10-12T15:00:00Z',tasks};
  await post({type:'project.tasks',entries:[entry],domains:{version:1,domains:[{id:'col2-domain',name:'상위 도메인'}],assignments:{'col2-worker':{domainId:'col2-domain'}}},hiddenWorkers:[]});
  await page.locator('#maestro-scope-all').click();
  const row=page.locator('[data-center-worker="col2-worker"]');
  for (const width of [1000,465,320]) {
    await page.setViewportSize({width,height:700});
    for (const theme of ['vscode-dark','vscode-light','vscode-high-contrast']) {
      await page.evaluate(theme=>{document.body.className=theme;},theme);
      assert.equal(await row.locator('.maestro-worker-area').textContent(),'작업 칸 서브 도메인');
      assert.equal(await row.locator('.maestro-worker-purpose').textContent(),currentTitle,'Open task precedes the newer completed task');
      assert.ok((await row.locator('.maestro-worker-purpose').getAttribute('title')).startsWith(currentTitle));
      const geometry=await row.evaluate(row=>{
        const area=row.querySelector('.maestro-worker-area'), purpose=row.querySelector('.maestro-worker-purpose');
        const a=area.getBoundingClientRect(),p=purpose.getBoundingClientRect(),r=row.getBoundingClientRect(),style=getComputedStyle(purpose);
        return {stacked:a.bottom<=p.top+1,aligned:Math.abs(a.left-p.left)<=6,inside:p.right<=r.right+1,
          ellipsis:style.textOverflow==='ellipsis'&&style.whiteSpace==='nowrap',clipped:purpose.scrollWidth>purpose.clientWidth};
      });
      for(const key of ['stacked','aligned','inside','ellipsis'])assert.equal(geometry[key],true,width+': '+key);
      if(width===320)assert.equal(geometry.clipped,true,'Narrow title keeps full hover text');
    }
  }
  tasks[0].workStatus='completed';tasks[0].runs[0].status='completed';tasks[0].runs[0].receipt={outcome:'completed'};entry.status='completed';
  await post({type:'project.tasks',entries:[entry]});
  assert.equal(await row.locator('.maestro-worker-purpose').textContent(),latestTitle,'Idle worker shows newest task');
  assert.match(await row.locator('.maestro-worker-purpose').getAttribute('title'),/결과 문장은 상세 화면에서 보존됩니다/);
  assert.equal(await row.locator('.maestro-worker-summary').count(),0,'Result sentence leaves the task line');
  await row.locator('[data-select-worker]').click();
  assert.ok(await page.locator('#maestro-detail [data-document="request"]').count());
  assert.ok(await page.locator('#maestro-detail [data-document="result"]').count());
  await page.locator('#maestro-detail .maestro-close').click();
  for(const task of tasks)delete task.domain;
  await post({type:'project.tasks',entries:[entry]});
  assert.equal(await row.locator('.maestro-worker-area').textContent(),'Not recorded');
  assert.equal(await row.locator('.maestro-worker-area.is-empty').count(),1,'Missing sub-domain has a muted label');
}
