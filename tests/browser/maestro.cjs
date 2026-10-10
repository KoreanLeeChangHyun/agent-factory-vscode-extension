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
  assert.equal(await page.locator('#maestro-refresh').getAttribute('aria-label'),'Refresh');
  assert.equal(await page.locator('#maestro-workers-view').getAttribute('aria-selected'),'true');
  // The center shares Main's surface and accent: same computed colours under the same theme variables.
  const mainSurface=await chatPage.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor);
  assert.equal(await page.locator('#maestro-center').evaluate(element=>getComputedStyle(element).backgroundColor),mainSurface);
  await centerPost({type:'project.tasks',entries});
  assert.equal(await page.locator('#maestro-workers-count').textContent(),'1','The worker tab counts unique workers, not assignments');
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
  await page.getByRole('button',{name:'Back to worker',exact:true}).click();
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
  await checkWorkers(page, centerPost, chatPage);
  assert.deepEqual(centerErrors,[]);
  await checkDomainEditing(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerControl(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerDrag(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerColumns(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await checkWorkerNames(page, centerPost);
  assert.deepEqual(centerErrors,[]);
  await page.close();
}
module.exports={checkMaestro};
// The worker view lists each worker once; its tasks open from the worker's detail.
async function openWorkerTask(page, task, agent) {
  const inDetail=page.locator('#maestro-detail [data-center-task="'+task+'"][data-center-agent="'+agent+'"]');
  if (!await inDetail.count()) await page.locator('[data-select-worker="'+agent+'"]').click();
  await inDetail.click();
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
    [['Extension','true'],['Runtime','true'],['__unclassified','true']]);
  assert.equal(await page.locator('[data-domain="__unclassified"]').textContent(),'Unclassified33 assignments','Domain header counts workers and assignments');
  assert.equal(await page.locator('[data-section]').count(),0,'No status/time section replaces the worker grouping');
  const workersIn=domain=>page.locator('[data-domain="'+domain+'"]').evaluate(header=>{const ids=[];for(let node=header.nextElementSibling;node&&!node.classList.contains('maestro-domain-toggle');node=node.nextElementSibling)if(node.dataset.centerWorker)ids.push(node.dataset.centerWorker);return ids;});
  assert.deepEqual(await workersIn('Extension'),['worker-verifier']);
  assert.deepEqual(await workersIn('Runtime'),['worker-reused'],'A worker is listed once, under its latest task\'s domain');
  assert.deepEqual(await workersIn('__unclassified'),['worker-decision','worker-pending','worker-stale'],'Attention, then running/waiting, then recent');
  assert.equal(await page.locator('[data-center-worker="worker-reused"]').count(),1,'Not repeated per task or run');
  const reused=page.locator('[data-center-worker="worker-reused"]');
  // The worker is named by the model its runs recorded; the ID stays the link key.
  assert.equal(await reused.locator('.maestro-row-title').textContent(),'fixture-model');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-row-title').textContent(),'Model not recorded','No model is invented without a run');
  assert.equal(await reused.locator('.maestro-row-title').getAttribute('data-select-worker'),'worker-reused');
  assert.equal(await reused.locator('.maestro-worker-status .maestro-state').textContent(),'Running','The row state is the open task, not a past result');
  // Four columns in one row, in this order: worker | title (assignment purpose) | state | history; the work area follows.
  assert.deepEqual(await reused.evaluate(row=>[...row.children].map(cell=>cell.className.split(' ')[0])),['maestro-worker-cell','maestro-worker-title','maestro-worker-status','maestro-worker-history','maestro-worker-work']);
  assert.equal(await reused.locator('.maestro-worker-title').textContent(),'Result read failed','The title is the first assignment, not the latest request');
  // Under the row: the open task, then one result line of the newest ended task, naming that task and its state.
  const lines=await reused.locator('.maestro-worker-line').evaluateAll(items=>items.map(item=>[item.querySelector('.maestro-worker-kind').textContent,(item.querySelector('[data-center-task]')?.dataset.centerTask||item.dataset.resultTask).split('/')[1],item.querySelector('.maestro-worker-for')?.textContent,item.querySelector('.maestro-state').textContent,item.querySelector('.maestro-worker-summary')?.textContent]));
  assert.deepEqual(lines,[['Now','assigned-two',undefined,'Running',undefined],['Result','assigned-one','Connect actual results','Completed','Preserved stable result provenance.']]);
  await reused.locator('.maestro-worker-original').click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.target==='result').at(-1)),{type:'project.task.open',workflowId:'fixture-workers',taskId:'assigned-one',target:'result',agentId:'worker-reused',runId:'run-completed'},'The original is the ended task\'s own run');
  assert.equal(await reused.locator('.maestro-history-button').textContent(),'History 4');
  assert.deepEqual(await page.locator('.maestro-worker-head [role="columnheader"]').allTextContents(),['Worker','Title','Status','History']);
  const top=await reused.evaluate(row=>[...row.children].slice(0,4).map(cell=>Math.round(cell.getBoundingClientRect().top+cell.getBoundingClientRect().height/2)));
  assert.ok(Math.max(...top)-Math.min(...top)<=4,'The four cells sit on one line: '+top);
  assert.equal(await reused.locator('.maestro-role').textContent(),'Explorer');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-role').textContent(),'Unassigned','No profile is invented without a run or allocation');
  assert.equal(await page.locator('[data-center-worker="worker-pending"] .maestro-worker-status .maestro-state').textContent(),'Waiting','The recorded task state stands in for a missing run');
  assert.equal(await page.locator('[data-center-worker="worker-stale"] .maestro-worker-status .maestro-state').textContent(),'Cancelled','A cancelled task does not wait for its stale decision');
  assert.equal(await page.locator('[data-center-worker="worker-stale"] .maestro-worker-summary').textContent(),'Result not collected','A missing result is said, never a success');
  assert.equal(await page.locator('.maestro-list [data-center-task]:not(.maestro-worker-work [data-center-task])').count(),0,'Tasks in the list belong to a worker\'s work area');
  assert.deepEqual(await page.locator('#maestro-domain option').evaluateAll(options=>options.map(option=>option.value)),['','name:Extension','name:Runtime','__unclassified']);
  // Rows share one column grid: role tags and status texts start at the same x in every row.
  // Header and every row share the column lines.
  const columns=await page.locator('.maestro-worker-head, .maestro-worker-row').evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>Math.round(cell.getBoundingClientRect().left))));
  for (const index of [1,2,3]) assert.equal(new Set(columns.map(value=>value[index])).size,1,'Column '+(index+1)+' is aligned');
  // A worker's detail lists its tasks newest first; each opens the task with its request, result and artifacts.
  await reused.locator('.maestro-worker-select').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'worker-reused');
  assert.deepEqual(await page.locator('#maestro-detail .maestro-worker-tasks [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask.split('/')[1])),
    ['assigned-two','assigned-one','missing-result','error-result']);
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-verifier');
  await page.getByRole('button',{name:'Worker run',exact:true}).click();
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
  assert.match(content,/Other assignments of this worker · 3/);
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
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.evaluate(()=>document.activeElement.dataset.selectWorker || document.activeElement.dataset.centerGroup),'worker-reused','Arrow keys move through the list');
  await page.keyboard.press('ArrowUp');
  await post({type:'project.tasks',entries});assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'worker-reused','Refresh retains focus');
  await openWorkerTask(page,'fixture-workers/assigned-one','worker-reused');
  await page.getByRole('button',{name:'Show in task list',exact:true}).click();
  assert.equal(await page.locator('#maestro-tasks-view').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-center-task="fixture-workers/unassigned"]').count(),1);
  // Task view: a kanban board with one column per recorded state; unassigned and unclassified tasks stay on it.
  assert.deepEqual(await page.locator('.maestro-column').evaluateAll(columns=>columns.map(column=>[column.dataset.column,[...column.querySelectorAll('.maestro-card')].map(card=>card.dataset.centerTask.split('/')[1]).sort()])),
    [['waiting',['missing-run','unassigned']],['running',['assigned-two']],['verifying',['assigned-one']],['decision',['open-decision']],['completed',['missing-result']],['ended',['stale-decision']],['unknown',['error-result']]]);
  assert.equal(await page.locator('.maestro-card[aria-current="true"]').getAttribute('data-center-task'),'fixture-workers/assigned-one','Switching views keeps the selection');
  assert.match(await page.locator('[data-center-task="fixture-workers/unassigned"]').textContent(),/Unclassified.*Unassigned/);
  assert.match(await page.locator('[data-center-task="fixture-workers/assigned-two"]').textContent(),/Runtime.*worker-reused/);
  assert.equal(await page.locator('[data-center-task="fixture-workers/stale-decision"] .maestro-state').textContent(),'Cancelled');
  assert.equal(await page.locator('.maestro-column[data-column="decision"] .maestro-state').textContent(),'Human decision needed');
  await page.locator('#maestro-domain').selectOption('name:Runtime');assert.equal(await page.locator('.maestro-card').count(),1,'Domain filters the board');
  await page.locator('#maestro-domain').selectOption('');
  assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'The board scrolls inside itself');
  assert.equal(await page.locator('[data-center-task="fixture-workers/assigned-one"]').getAttribute('aria-current'),'true');
  await page.getByRole('button',{name:'Show assigned workers',exact:true}).click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'assigned-one');
  assert.equal(await page.getByRole('button',{name:'Back to worker',exact:true}).count(),1);
  await page.locator('#maestro-domain').selectOption('name:Runtime');assert.equal(await page.locator('.maestro-row').count(),1);
  assert.deepEqual(await page.locator('.maestro-domain-toggle').evaluateAll(items=>items.map(item=>item.dataset.domain)),['Runtime']);
  await page.locator('#maestro-domain').selectOption('__unclassified');assert.equal(await page.locator('.maestro-row').count(),3,'Unclassified workers are listed when filtered');
  await page.locator('#maestro-search').fill('Extension');assert.equal(await page.locator('.maestro-row').count(),0,'Search and domain filter combine');
  await page.locator('#maestro-domain').selectOption('');assert.equal(await page.locator('.maestro-row').count(),2,'Search matches the recorded domain');
  await page.locator('#maestro-search').fill('');
  await page.locator('#maestro-domain').selectOption('');await page.locator('#maestro-status').selectOption('running');assert.equal(await page.locator('.maestro-row').count(),2);
  await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-search').fill('stable result');assert.equal(await page.locator('.maestro-row').count(),1);
  await page.locator('#maestro-search').fill('');
  const extension=page.locator('[data-domain="Extension"]');await extension.click();
  assert.equal(await extension.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('[data-center-worker="worker-verifier"]').count(),0);
  await post({type:'project.tasks',entries});assert.equal(await page.locator('[data-domain="Extension"]').getAttribute('aria-expanded'),'false','Refresh retains domain collapse');
  await page.locator('[data-domain="Extension"]').click();
  await openWorkerTask(page,'fixture-workers/error-result','worker-reused');assert.match(await page.locator('#maestro-detail').textContent(),/Fixture result read failure/);
  assert.equal(await page.getByRole('button',{name:'Open original result',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Back to worker',exact:true}).click();
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
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await page.locator('#maestro-search').inputValue(),'');
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
  let domains={revision:3,domains:[{id:extension,name:'Extension',aliases:[],createdBy:by('ai','loop one'),nameSetBy:by('ai','loop one')}],assignments:{'worker-ui':{domainId:extension,setBy:by('ai','loop one')}}};
  const sent=()=>page.evaluate(()=>window.sentMessages.filter(value=>value.type.startsWith('domain.')));
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-scope').selectOption('');await page.locator('#maestro-domain').selectOption('');
  await post({type:'project.tasks',entries});
  assert.equal(await page.locator('#maestro-domain-add').isHidden(),true,'Without the shared list nothing is editable');
  await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('#maestro-domain-add').isVisible(),true);
  assert.equal(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('data-domain'),'Extension');
  assert.equal(await page.locator('[data-domain-key="name:Runtime"] + .maestro-domain-edit').getAttribute('aria-label'),'Add Runtime to the domain list','A recorded name not in the list can be adopted');
  // Create: one click makes a real domain named 미분류 with no name prompt; its rename field opens afterwards.
  const other='domain-cccccccccccc', placeholder=(id,revisionBy='human')=>({id,name:'미분류',provisional:true,aliases:[],createdBy:by(revisionBy),nameSetBy:by(revisionBy)});
  await page.locator('#maestro-domain-add').click();
  assert.deepEqual((await sent()).at(-1),{type:'domain.create',placeholder:true,revision:3});
  assert.equal(await page.locator('.maestro-domain-editor').count(),0,'No name is asked before creating');
  assert.equal(await page.locator('#maestro-domain-add').isDisabled(),true,'A second click waits for the first');
  await page.locator('#maestro-domain-add').click({force:true});assert.equal((await sent()).length,1);
  await post({type:'domain.result',edit:'domain.create',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-list > [role="alert"]').textContent(),/changed meanwhile/);
  assert.equal(await page.locator('#maestro-domain-add').isDisabled(),false);
  await page.locator('#maestro-domain-add').click();
  domains={...domains,revision:4,domains:[...domains.domains,placeholder(docs)]};
  await post({type:'domain.result',edit:'domain.create',domainId:docs});await post({type:'project.tasks',entries,domains});
  const renameDocs=page.locator('[data-domain-input="rename:'+docs+'"]');
  assert.equal(await renameDocs.inputValue(),'미분류');
  assert.equal(await renameDocs.evaluate(element=>element===document.activeElement&&element.selectionStart===0&&element.selectionEnd===3),true,'The new name is selected for typing');
  await renameDocs.press('Escape');
  // Cancelling keeps the created domain; it is separate from the fallback group of workers without a domain.
  assert.equal(await page.locator('[data-domain-key="'+docs+'"]').getAttribute('data-provisional'),'true');
  assert.equal(await page.locator('[data-domain-key="'+docs+'"]').textContent(),'미분류0Name not set · 0 assignments');
  assert.equal(await page.locator('[data-domain="__unclassified"] ~ [data-center-worker="worker-legacy"]').count(),1,'The fallback keeps its workers');
  assert.deepEqual(await page.locator('.maestro-domain-toggle').evaluateAll(items=>items.map(item=>item.dataset.domainKey||item.dataset.domain)),['domain-aaaaaaaaaaaa','name:Runtime',docs,'__unclassified']);
  // A second creation is another independent domain with the same provisional name.
  await page.locator('#maestro-domain-add').click();
  assert.deepEqual((await sent()).at(-1),{type:'domain.create',placeholder:true,revision:4});
  domains={...domains,revision:5,domains:[...domains.domains,placeholder(other)]};
  await post({type:'domain.result',edit:'domain.create',domainId:other});await post({type:'project.tasks',entries,domains});
  await page.locator('[data-domain-input="rename:'+other+'"]').press('Escape');
  assert.equal(await page.locator('[data-provisional="true"]').count(),2);
  assert.deepEqual(await page.locator('#maestro-domain option').evaluateAll(options=>options.filter(option=>option.value.startsWith('domain-')).map(option=>option.textContent)),['Extension','미분류 · Name not set','미분류 · Name not set']);
  // Rename later with the usual pencil: empty and duplicate names are refused, typing survives a refresh.
  await page.locator('[data-domain-key="'+docs+'"] + .maestro-domain-edit').click();
  await renameDocs.fill('');await renameDocs.press('Enter');assert.match(await page.locator('.maestro-domain-editor').textContent(),/Enter a name/);
  await renameDocs.fill('Extension');await renameDocs.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:docs,name:'Extension',revision:5});
  assert.equal(await renameDocs.isDisabled(),true,'One edit at a time');
  await post({type:'domain.result',edit:'domain.rename',error:'Another domain is already named Extension',code:'domain_name_taken'});
  assert.match(await page.locator('.maestro-domain-editor [role="alert"]').textContent(),/already exists/);
  assert.equal(await renameDocs.inputValue(),'Extension','The typed name survives a failed save');
  await renameDocs.fill('Docs site');
  await post({type:'project.tasks',entries,domains});
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.domainInput),'rename:'+docs);
  assert.equal(await renameDocs.inputValue(),'Docs site');
  await renameDocs.press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:docs,name:'Docs site',revision:5});
  domains={...domains,revision:6,domains:domains.domains.map(item=>item.id===docs?{id:docs,name:'Docs site',aliases:[],createdBy:item.createdBy,nameSetBy:by('human')}:item)};
  await post({type:'domain.result',edit:'domain.rename',domainId:docs});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('.maestro-domain-editor').count(),0);
  assert.equal(await page.locator('[data-domain-key="'+docs+'"]').textContent(),'Docs site00 assignments','A new domain is listed before any worker joins it');
  assert.equal(await page.locator('[data-domain-key="'+other+'"]').getAttribute('data-provisional'),'true','The other new domain is unchanged');
  // Filter by the domain ID, then rename: the filter, collapse key and recorded task stay linked through the former name.
  await page.locator('#maestro-domain').selectOption(extension);
  assert.equal(await page.locator('.maestro-row').count(),1);
  await page.locator('[data-domain-key="'+extension+'"] + .maestro-domain-edit').click();
  assert.equal(await page.locator('[data-domain-input="rename:'+extension+'"]').inputValue(),'Extension');
  await page.locator('[data-domain-input="rename:'+extension+'"]').fill('Extension UI');await page.locator('[data-domain-input="rename:'+extension+'"]').press('Enter');
  assert.deepEqual((await sent()).at(-1),{type:'domain.rename',domainId:extension,name:'Extension UI',revision:6});
  domains={...domains,revision:7,domains:[{...domains.domains[0],name:'Extension UI',aliases:['Extension'],nameSetBy:by('human')},...domains.domains.slice(1)],assignments:{}};
  await post({type:'domain.result',edit:'domain.rename'});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('#maestro-domain').inputValue(),extension);
  assert.equal(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('data-domain'),'Extension UI');
  assert.equal(await page.locator('[data-center-worker="worker-ui"]').evaluate(row=>{let node=row.previousElementSibling;while(node&&!node.classList.contains('maestro-domain-toggle'))node=node.previousElementSibling;return node?.dataset.domainKey;}),extension,'The worker recorded as Extension follows the renamed domain');
  assert.match(await page.locator('[data-domain-key="'+extension+'"]').getAttribute('title'),/Set by you/);
  await page.locator('#maestro-domain').selectOption('');
  // Place the legacy unclassified worker from its detail; the accepted allocation is not part of the edit.
  await page.locator('[data-select-worker=\"worker-legacy\"]').click();
  assert.equal(await page.locator('[data-domain-assign="worker-legacy"]').inputValue(),'');
  await page.locator('[data-domain-assign="worker-legacy"]').selectOption(docs);
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'worker-legacy',domainId:docs,revision:7});
  domains={...domains,revision:8,assignments:{'worker-legacy':{domainId:docs,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('[data-domain-key="'+docs+'"] ~ [data-center-worker]').first().getAttribute('data-center-worker'),'worker-legacy');
  assert.match(await page.locator('.maestro-domain-field').textContent(),/Set by you/);
  // Move it again; a stale revision is reported and the latest list stays shown.
  await page.locator('[data-domain-assign="worker-legacy"]').selectOption('');
  await post({type:'domain.result',edit:'domain.assign',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-domain-field').textContent(),/changed meanwhile/);
  await post({type:'project.tasks',entries,domains});
  assert.equal(await page.locator('[data-domain-assign="worker-legacy"]').inputValue(),docs);
  // An AI membership is labelled; the recorded allocation name is shown as the basis otherwise.
  domains={...domains,revision:9,assignments:{...domains.assignments,'worker-runtime':{domainId:extension,setBy:by('ai','loop two')}}};
  await post({type:'project.tasks',entries,domains});
  await page.locator('[data-select-worker=\"worker-runtime\"]').click();
  assert.match(await page.locator('.maestro-domain-field').textContent(),/Set by AI/);
  assert.match(await page.locator('.maestro-domain-field').textContent(),/From the assignment record: Runtime/,'The recorded allocation name stays visible');
  await page.locator('[data-select-worker=\"worker-ui\"]').click();
  assert.match(await page.locator('.maestro-domain-field').textContent(),/From the assignment record: Extension/);
  // The kanban shows the same display domain on each card.
  await page.locator('#maestro-tasks-view').click();
  assert.match(await page.locator('.maestro-card[data-center-task="flow-domains/legacy-task"]').textContent(),/Docs site/);
  assert.match(await page.locator('.maestro-card[data-center-task="flow-domains/runtime-task"]').textContent(),/Extension UI/);
  await page.locator('#maestro-domain').selectOption(docs);assert.equal(await page.locator('.maestro-card').count(),1);
  await page.locator('#maestro-domain').selectOption('');await page.locator('#maestro-workers-view').click();
  // A failed domain read keeps the tasks, reports the error and turns editing off.
  await post({type:'project.tasks',entries,domainsError:'Fixture domain store invalid'});
  assert.match(await page.locator('#maestro-tasks .maestro-error').textContent(),/Fixture domain store invalid/);
  assert.equal(await page.locator('#maestro-domain-add').isHidden(),true);assert.equal(await page.locator('.maestro-domain-edit').count(),0);
  assert.equal(await page.locator('[data-center-worker="worker-legacy"]').count(),1);
  await post({type:'project.tasks',entries,domains});
  // Toolbar: search, the three filters and "new domain" share one row when they fit; narrower editors keep
  // search with "new domain" and give the filters their own row; no control is clipped or pushed off screen.
  const toolbar=()=>page.evaluate(()=>{
    const box=id=>{const r=document.getElementById(id).closest('.maestro-search, .maestro-select, button').getBoundingClientRect();return {top:Math.round(r.top),left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)};};
    const fits=[...document.querySelectorAll('.maestro-filter-group select')].every(select=>{const style=getComputedStyle(select),context=document.createElement('canvas').getContext('2d');
      context.font=style.fontSize+' '+style.fontFamily;return context.measureText(select.selectedOptions[0]?.textContent||'').width<=select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)+0.5;});
    return {search:box('maestro-search'),status:box('maestro-status'),scope:box('maestro-scope'),domain:box('maestro-domain'),add:box('maestro-domain-add'),fits,width:document.querySelector('.maestro-filters').clientWidth};
  });
  // Measured with a proportional UI font like VS Code's; the shared fixture's 14px monospace is wider than any real UI font.
  await page.evaluate(()=>{document.documentElement.style.setProperty('--vscode-font-family','sans-serif');document.documentElement.style.setProperty('--vscode-font-size','13px');});
  for (const width of [1100,783]) {
    await page.setViewportSize({width,height:600});const bar=await toolbar();
    assert.ok([bar.status,bar.scope,bar.domain,bar.add].every(item=>item.top===bar.search.top),width+': one row');
    assert.ok(bar.search.right<bar.status.left&&bar.domain.right<bar.add.left&&bar.fits,width+': ordered, unclipped '+JSON.stringify(bar));
  }
  await page.setViewportSize({width:465,height:600});let bar=await toolbar();
  assert.equal(bar.add.top,bar.search.top,'465: new domain stays beside search');
  assert.ok(bar.status.top>bar.search.top&&bar.scope.top===bar.status.top&&bar.domain.top===bar.status.top&&bar.fits,'465: filters share the next row');
  assert.ok(Math.abs(bar.status.width-bar.domain.width)<=1,'465: equal filter widths');
  await page.setViewportSize({width:320,height:600});bar=await toolbar();
  assert.equal(bar.add.top,bar.search.top);assert.ok(bar.fits,'320: filter labels are not clipped');
  // Keyboard order follows the visual order and the new-domain button shows the focus ring.
  await page.setViewportSize({width:783,height:600});
  await page.locator('#maestro-search').focus();
  const order=[];for(let i=0;i<4;i++){await page.keyboard.press('Tab');order.push(await page.evaluate(()=>document.activeElement.id));}
  assert.deepEqual(order,['maestro-status','maestro-scope','maestro-domain','maestro-domain-add']);
  assert.notEqual(await page.locator('#maestro-domain-add').evaluate(element=>getComputedStyle(element).outlineStyle),'none');
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
  await page.locator('#maestro-search').fill('');await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-domain').selectOption('');
  await post({type:'project.tasks',entries:entries(),domains});
  // The worker first, then its latest task; a running worker is marked.
  const row=page.locator('[data-center-worker="worker-live"]');
  assert.equal(await row.count(),1);assert.equal(await row.getAttribute('data-running'),'true');
  assert.equal(await row.locator('.maestro-worker-title').textContent(),'Old task','The title is what the worker was first assigned');assert.equal(await row.locator('.maestro-history-button').textContent(),'History 2');
  // The running task is current; the finished one is labelled as the last ended task with its own result.
  assert.equal(await row.locator('.maestro-worker-line').count(),2);
  assert.match(await row.locator('.maestro-worker-line.is-current').textContent(),/^NowLive task/);
  // The result is the row's own first task, so its title is not repeated; its state shows because other work is open.
  assert.equal(await row.locator('.maestro-worker-line.is-ended').textContent(),'ResultCompletedOld resultOriginal');
  await row.locator('.maestro-worker-select').click();
  const detail=page.locator('#maestro-detail');
  assert.deepEqual(await detail.locator('.maestro-running-task [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask)),['flow-live/task-live']);
  assert.deepEqual(await detail.locator('.maestro-worker-tasks [data-center-task]').evaluateAll(items=>items.map(item=>item.dataset.centerTask)),['flow-old/task-old'],'History keeps finished tasks apart from running ones');
  const remove=page.getByRole('button',{name:'Remove worker',exact:true});
  assert.equal(await remove.isDisabled(),true,'A running worker cannot be removed');
  assert.match(await detail.textContent(),/Stop the running task before removing this worker/);
  // Commands: newest first, sender/status/target recorded; line breaks kept, long text folded with the full text inside.
  const commands=detail.locator('.maestro-command');
  assert.deepEqual(await commands.evaluateAll(items=>items.map(item=>item.dataset.status)),['queued','delivered','delivered']);
  assert.match(await commands.nth(0).textContent(),/Addition.*You.*Waiting for delivery/);
  assert.match(await commands.nth(1).textContent(),/Task request.*Main.*Delivered/);
  assert.match(await commands.nth(1).textContent(),/Live task · run-live/);
  assert.equal(await commands.nth(1).locator('pre').textContent(),'First line\nSecond line');
  const fold=commands.nth(0).locator('details');assert.equal(await fold.locator('pre').isVisible(),false);
  await fold.locator('summary').click();assert.equal(await fold.locator('pre').textContent(),long);
  // A running worker receives an addition bound to its exact loop and run; one send at a time.
  assert.match(await detail.locator('.maestro-command-target').textContent(),/Target: running task Live task/);
  const input=page.locator('#maestro-command-input');
  await input.fill('Also update the tests\nand report');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  const command=(await sent('worker.command')).at(-1);
  assert.deepEqual({...command,commandId:undefined},{type:'worker.command',agentId:'worker-live',text:'Also update the tests\nand report',commandId:undefined,loopId:'loop-live',runId:'run-live'});
  assert.match(command.commandId,/^[A-Za-z0-9-]{8,64}$/);
  assert.equal(await page.getByRole('button',{name:'Sending…',exact:true}).isDisabled(),true);
  await input.press('Control+Enter').catch(()=>{});await page.locator('.maestro-command-form').evaluate(form=>form.requestSubmit());
  assert.equal((await sent('worker.command')).length,1,'A second submit while sending does not send again');
  assert.equal(await commands.nth(0).getAttribute('data-status'),'sending');
  await post({type:'worker.result',action:'worker.command',agentId:'worker-live',commandId:command.commandId,result:{mode:'addition',loopId:'loop-live',runId:'run-live',taskId:'task-live'}});
  assert.equal(await commands.nth(0).getAttribute('data-status'),'accepted');assert.equal(await input.inputValue(),'');
  // Once the managed record holds the command, the local entry gives way to it.
  const recorded=live();recorded.tasks[0].commands.push({kind:'addition',text:'Also update the tests\nand report',sender:'human',at:new Date().toISOString(),status:'queued'});
  await post({type:'project.tasks',entries:[recorded,old,idle],domains});
  assert.equal(await commands.count(),4);assert.equal(await commands.nth(0).getAttribute('data-status'),'queued');
  // A refused send stays visible as not sent, with the reason, across a reload.
  await input.fill('Refused instruction');await page.getByRole('button',{name:'Send',exact:true}).click();
  const refused=(await sent('worker.command')).at(-1);
  await post({type:'worker.result',action:'worker.command',agentId:'worker-live',commandId:refused.commandId,error:'The worker\'s running task changed; reload before sending',code:'worker_command_stale'});
  assert.equal(await commands.nth(0).getAttribute('data-status'),'failed');
  assert.match(await commands.nth(0).textContent(),/Not sent: The worker's running task changed/);
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();await post({type:'project.tasks',entries:[recorded,old,idle],domains});
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'worker-live','The selected worker is restored');
  assert.match(await page.locator('.maestro-command[data-status="failed"]').textContent(),/Refused instruction/,'Send state survives restoring the tab');
  // An idle worker gets a new task in its session: no loop or run binding is sent.
  await page.locator('[data-select-worker=\"worker-idle\"]').click();
  assert.match(await page.locator('.maestro-command-target').textContent(),/Target: new task in this worker's session/);
  await page.locator('#maestro-command-input').fill('Start the follow-up');await page.getByRole('button',{name:'Send',exact:true}).click();
  const fresh=(await sent('worker.command')).at(-1);
  assert.deepEqual([fresh.agentId,fresh.text,fresh.loopId,fresh.runId],['worker-idle','Start the follow-up',undefined,undefined]);
  await post({type:'worker.result',action:'worker.command',agentId:'worker-idle',commandId:fresh.commandId,result:{mode:'task',loopId:'loop-new'}});
  assert.equal(await page.getByRole('button',{name:'Remove worker',exact:true}).isDisabled(),false,'An idle worker can be removed');
  // Force stop: exact loop/task, one at a time; cancelling the confirmation or a failure changes nothing.
  await page.locator('[data-select-worker=\"worker-live\"]').click();
  await page.getByRole('button',{name:'Force stop',exact:true}).click();
  assert.deepEqual((await sent('worker.stop')).at(-1),{type:'worker.stop',agentId:'worker-live',loopId:'loop-live',workflowId:'flow-live',taskId:'task-live'});
  assert.equal(await page.getByRole('button',{name:'Stopping…',exact:true}).isDisabled(),true);
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',cancelled:true});
  assert.equal(await page.getByRole('button',{name:'Force stop',exact:true}).isDisabled(),false);
  await page.getByRole('button',{name:'Force stop',exact:true}).click();
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',error:'Resolve the uncertain dispatch before stopping this task',code:'loop_stop_dispatch_uncertain'});
  assert.match(await page.locator('#maestro-detail .maestro-worker-notice').textContent(),/Failed: Resolve the uncertain dispatch/);
  assert.equal(await page.locator('.maestro-running-task').count(),1,'A failed stop is not shown as stopped');
  await page.getByRole('button',{name:'Force stop',exact:true}).click();
  await post({type:'worker.result',action:'worker.stop',agentId:'worker-live',result:{}});
  assert.equal(await page.locator('.maestro-running-task').count(),1,'Only the refreshed record shows the stop');
  await post({type:'project.tasks',entries:[live('cancelled'),old,idle],domains});
  assert.equal(await page.locator('.maestro-running-task').count(),0);
  assert.equal(await page.locator('[data-center-worker="worker-live"] .maestro-worker-status .maestro-state').textContent(),'Cancelled');
  assert.match(await page.locator('.maestro-command[data-status="undelivered"]').first().textContent(),/Not delivered · task ended/,'An addition still waiting when the task stopped is not shown as delivered');
  // Removal: confirmed by the host, then the worker leaves the list; its tasks stay readable in the task view.
  await page.getByRole('button',{name:'Remove worker',exact:true}).click();
  assert.deepEqual((await sent('worker.remove')).at(-1),{type:'worker.remove',agentId:'worker-live',revision:1});
  assert.equal(await page.getByRole('button',{name:'Removing…',exact:true}).isDisabled(),true);
  await post({type:'worker.result',action:'worker.remove',agentId:'worker-live',error:'Stop this worker\'s running task before removing it',code:'worker_running'});
  assert.match(await page.locator('#maestro-detail .maestro-worker-notice').textContent(),/Failed: Stop this worker's running task/);
  assert.equal(await page.locator('[data-center-worker="worker-live"]').count(),1,'A refused removal keeps the worker');
  await page.getByRole('button',{name:'Remove worker',exact:true}).click();
  domains={...domains,revision:2,removedWorkers:{'worker-live':{removedBy:{actor:'human',at:new Date().toISOString(),source:'control-center'}}}};
  await post({type:'worker.result',action:'worker.remove',agentId:'worker-live',result:{}});await post({type:'project.tasks',entries:[live('cancelled'),old,idle],domains});
  assert.equal(await page.locator('[data-center-worker="worker-live"]').count(),0);
  assert.equal(await page.locator('#maestro-workspace').getAttribute('data-layout'),'list');
  await page.locator('#maestro-tasks-view').click();
  assert.equal(await page.locator('.maestro-card[data-center-task="flow-old/task-old"]').count(),1,'History of a removed worker stays in the task view');
  await page.locator('.maestro-card[data-center-task="flow-old/task-old"]').click();
  assert.match(await page.locator('#maestro-detail').textContent(),/Removed from the worker list/);
  assert.match(await page.locator('#maestro-detail').textContent(),/Old result/);
  await page.locator('#maestro-workers-view').click();
  // Layout and keyboard at the four widths: the form, its send button and stop stay reachable without overflow.
  await post({type:'project.tasks',entries:[live(),old,idle],domains:{...domains,removedWorkers:{}}});
  await page.locator('[data-select-worker=\"worker-live\"]').click();
  for (const width of [1100,783,465,320]) {
    await page.setViewportSize({width,height:900});
    assert.ok(await page.locator('#maestro-center').evaluate(element=>element.scrollWidth<=element.clientWidth+1),width+': no horizontal overflow');
    const fits=await page.locator('#maestro-detail').evaluate(element=>[...element.querySelectorAll('button, textarea, select')].every(control=>{const r=control.getBoundingClientRect(),p=element.getBoundingClientRect();return r.width===0||(r.left>=p.left-1&&r.right<=p.right+1);}));
    assert.ok(fits,width+': controls stay inside the detail');
    if (process.env.WORKER_CONTROL_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_CONTROL_EVIDENCE,'control-center-worker-control-20261010-005424-fixture-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:900});
  await page.locator('#maestro-command-input').focus();
  assert.notEqual(await page.locator('#maestro-command-input').evaluate(element=>getComputedStyle(element).outlineStyle),'none','The instruction field shows its focus ring');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Send');
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
  await page.locator('#maestro-search').fill('');await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-scope').selectOption('');await page.locator('#maestro-domain').selectOption('');
  await post({type:'project.tasks',entries,domains});
  const before=(await sent()).length;
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('draggable'),'true');
  // Targets are listed domains by ID (empty, provisional) and the fallback; the fallback is not the provisional 미분류.
  assert.deepEqual(await page.locator('[data-drop-target]').evaluateAll(items=>items.map(item=>item.dataset.dropTarget)),['domain-bbbbbbbbbbbb','domain-aaaaaaaaaaaa','domain-cccccccccccc','__unclassified']);
  // Drop on the same group, or cancel the drag: nothing is sent.
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+coord+'"]'));
  assert.equal((await sent()).length,before,'Same-group drop changes nothing');
  await page.locator('[data-center-worker="coord-a"]').dispatchEvent('dragstart',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
  await page.locator('[data-center-worker="coord-a"]').dispatchEvent('dragend');
  assert.equal((await sent()).length,before,'A cancelled drag changes nothing');
  assert.equal(await page.locator('.is-drop-target').count(),0);
  // Move a running worker to the unclassified fallback: only its membership changes, with the read revision.
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="__unclassified"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'coord-a',domainId:null,revision:10});
  assert.equal(await page.locator('[data-center-worker="coord-b"]').getAttribute('draggable'),'false','No second move while one saves');
  assert.equal(await groupOf('coord-a'),coord,'The list waits for the saved record');
  // A failed save (conflict) keeps the original group and says so.
  await post({type:'domain.result',edit:'domain.assign',error:'Domains changed',code:'domain_conflict'});
  assert.match(await page.locator('.maestro-drag-error').textContent(),/changed meanwhile/);
  assert.equal(await groupOf('coord-a'),coord);
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="__unclassified"]'));
  domains={...domains,revision:11,assignments:{...domains.assignments,'coord-a':{domainId:null,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('coord-a'),'__unclassified');
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('data-running'),'true','The running task keeps running');
  // Back from unclassified into a collapsed, then an empty domain.
  await page.locator('[data-drop-target="'+coord+'"]').click();
  assert.equal(await page.locator('[data-drop-target="'+coord+'"]').getAttribute('aria-expanded'),'false');
  await page.locator('[data-center-worker="coord-a"]').dragTo(page.locator('[data-drop-target="'+coord+'"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'coord-a',domainId:coord,revision:11});
  domains={...domains,revision:12,assignments:{...domains.assignments,'coord-a':{domainId:coord,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  await page.locator('[data-drop-target="'+coord+'"]').click();
  assert.equal(await groupOf('coord-a'),coord,'Dropped into the collapsed group');
  await page.locator('[data-center-worker="scribe-c"]').dragTo(page.locator('[data-drop-target="'+empty+'"]'));
  assert.deepEqual((await sent()).at(-1),{type:'domain.assign',agentId:'scribe-c',domainId:empty,revision:12});
  domains={...domains,revision:13,assignments:{...domains.assignments,'scribe-c':{domainId:empty,setBy:by('human')}}};
  await post({type:'domain.result',edit:'domain.assign'});await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('scribe-c'),empty);
  // Reload: the moved memberships come back from the saved list; selection and the worker detail still work.
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();await post({type:'project.tasks',entries,domains});
  assert.equal(await groupOf('scribe-c'),empty);assert.equal(await groupOf('coord-a'),coord);
  await page.locator('[data-select-worker=\"scribe-c\"]').click();
  assert.equal(await page.locator('[data-domain-assign="scribe-c"]').inputValue(),empty,'The keyboard menu shows the dragged membership');
  // While a search or filter hides groups, dragging is off and the menu remains.
  await page.locator('#maestro-search').fill('coord');
  assert.equal(await page.locator('[data-center-worker="coord-a"]').getAttribute('draggable'),'false');
  assert.equal(await page.locator('[data-drop-target]').count(),0);
  assert.match(await page.locator('[data-center-worker="coord-a"]').getAttribute('title'),/Clear search and filters/);
  await page.locator('#maestro-search').fill('');
  if (process.env.WORKER_CONTROL_EVIDENCE) {
    await page.locator('[data-center-worker="coord-b"]').dispatchEvent('dragstart',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
    await page.locator('[data-drop-target="__unclassified"]').dispatchEvent('dragover',{dataTransfer:await page.evaluateHandle(()=>new DataTransfer())});
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
  await page.locator('#maestro-search').fill('');await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-domain').selectOption('');
  await post({type:'project.tasks',entries,domains:{revision:1,domains:[],assignments:{},removedWorkers:{}}});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  assert.equal(await page.locator('[data-center-worker="w-empty"] .maestro-worker-title').textContent(),'Assignment purpose not recorded','A missing title is said, not replaced by an ID');
  for (const width of [1100,783,465,320]) {
    await page.setViewportSize({width,height:600});
    const layout=await page.locator('.maestro-list').evaluate(list=>{
      const rows=[...list.querySelectorAll('.maestro-worker-head, .maestro-worker-row')];
      const box=element=>element.getBoundingClientRect();
      return {overflow:list.scrollWidth>list.clientWidth+1,
        order:rows.map(row=>[...row.children].map(cell=>Math.round(box(cell).left))),
        inside:rows.every(row=>[...row.children].every(cell=>box(cell).right<=box(list).right+1)),
        history:[...list.querySelectorAll('.maestro-history-button')].every(button=>{const b=box(button),cell=box(button.parentElement);return b.width>20&&b.right<=box(list).right+1&&b.left>=cell.left-1;}),
        oneLine:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const first=cell=>getComputedStyle(row).alignItems==='start'?box(cell).top:box(cell).top+box(cell).height/2;const tops=[...row.children].slice(1,4).map(first);return Math.max(...tops)-Math.min(...tops)<=4;})};
    });
    assert.equal(layout.overflow,false,width+': no horizontal overflow');
    assert.ok(layout.inside&&layout.history,width+': cells and the history control stay visible');
    assert.ok(layout.order.every(lefts=>lefts[0]<lefts[1]&&lefts[1]<lefts[2]&&lefts[2]<lefts[3]),width+': worker | title | status | history order');
    for (const index of [1,2,3]) assert.equal(new Set(layout.order.map(value=>value[index])).size,1,width+': column '+(index+1)+' aligned');
    assert.ok(layout.oneLine,width+': title, status and history share one line');
    if (process.env.WORKER_COLUMNS_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_COLUMNS_EVIDENCE,'control-center-worker-columns-20261010-075302-fixture-'+width+'.png')});
  }
  await page.setViewportSize({width:1100,height:700});
  // Keyboard: Tab from the worker reaches its history; Enter opens the worker detail at the history section.
  await page.locator('[data-select-worker="'+longName+'"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.historyWorker),longName);
  assert.notEqual(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),longName);
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('maestro-worker-history-block')),true,'History opens at the history section');
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
  const task=(id,agent,title,{domain,status='completed',minutes=5,model,provider,result,reason}={})=>({id,title,...(domain?{domain}:{}),workAgentId:agent,workStatus:status,
    ...(reason?{allocation:{unitReason:reason}}:{}),
    runs:[{role:'work',agentId:agent,runId:'run-'+id,status,...(model?{model}:{}),...(provider?{provider}:{}),startedAt:at(minutes+2),...(['running','pending'].includes(status)?{}:{finishedAt:at(minutes)}),
      ...(status==='completed'?{receipt:{outcome:'completed'}}:{}),...(result?{result}:{})}],commands:[]});
  const loop=(id,agent,tasks,status='completed')=>({id,title:id,status,loopId:'loop-'+id,workAgentId:agent,updatedAt:at(1),tasks});
  const entries=[
    // Same model, different workers and purposes: never merged.
    loop('api-origin','work-api-7f3a',[task('t-api-1','work-api-7f3a','주문 조회 API 개발',{domain:'API 개발',minutes:300,model:'claude-opus-5-5',reason:'주문 API 담당 한 명이 통합합니다.',result:{availability:'recorded',summary:'**주문 조회 API** 1차 구현 완료'}})]),
    loop('api-now','work-api-7f3a',[task('t-api-2','work-api-7f3a','주문 조회 API에 페이지네이션 추가',{domain:'API 개발',status:'running',minutes:3,model:'claude-opus-5-5'}),
      task('t-api-3','work-api-7f3a','응답 캐시 헤더 정리',{domain:'API 개발',status:'pending',minutes:2})],'active'),
    loop('api-done','work-api-7f3a',[task('t-api-4','work-api-7f3a','페이지네이션 회귀 테스트',{domain:'API 개발',minutes:30,model:'claude-opus-5-5',result:{availability:'recorded',summary:longResult}})]),
    loop('db','work-db-91c2',[task('t-db','work-db-91c2','고객 테이블 인덱스 설계',{domain:'DB 모델링',model:'claude-opus-5-5',result:{availability:'recorded',summary:'**인덱스** 3종 [설계안](docs/db/index.md) 작성'}})]),
    loop('bug-1','work-bug-0d11',[task('t-bug-1','work-bug-0d11','결제 실패 시 중복 주문 수정',{domain:'버그 수정',status:'failed',model:'gpt-6.1-sol'})]),
    loop('bug-2','work-bug-2b77',[task('t-bug-2','work-bug-2b77','결제 실패 시 중복 주문 수정',{domain:'버그 수정',status:'cancelled',minutes:20,model:'gpt-6.1-sol'})]),
    loop('ui','work-ui-55e0',[task('t-ui','work-ui-55e0','주문 목록 반응형 정렬 조정',{domain:'UI/UX 조정',status:'completed',provider:'claude',result:{availability:'missing'}})]),
    loop('roles','worker-roles-5b2748a4',[task('t-roles','worker-roles-5b2748a4','sandbox normalize_label 테스트 실행')]),
    // The attached case: a recorded brief title and a result whose first paragraph is several sentences (copied text).
    loop('coord','coord-matrix-e855264c',[task('t-coord','coord-matrix-e855264c',coordTitle,{domain:'작업 조율',minutes:780,model:'gpt-6.1-sol',result:{availability:'recorded',summary:coordResult}})]),
    loop('brief','work-brief-1a2b',[task('t-brief','work-brief-1a2b','사용자님께서 정리한 지휘자 운영 흐름에 대해 “작업배정해서 작업 진행하세요”라고 실행을 승인하셨습니다. 하나의 채팅에서 여러 세션과 작업자를 운영할 수 있는 플러그인 실행 기반을 구현하고, 특히 장시간 작업이 끝날 때까지 진전을 감찰하십시오.',{minutes:90,model:'claude-opus-5-5',result:{availability:'recorded',summary:'사용자님, 플러그인의 지휘자 실행 기반을 구현했습니다. 메시지 수신부터 보고 이벤트까지 연결했습니다.'}})]),
    loop('long','work-long-title',[task('t-long','work-long-title','고객 문의 응답 자동 분류와 우선순위 조정 및 상담원 배정 규칙 정비를 위한 장기 개선 과제',{domain:'고객 문의 응답 자동 분류와 우선순위 조정',status:'running',minutes:1,model:'claude-opus-5-5-with-a-very-long-model-identifier'})],'active')];
  const domains={revision:20,domains:[{id:customer,name:'고객',aliases:[],createdBy:by,nameSetBy:by}],
    assignments:Object.fromEntries(['work-api-7f3a','work-db-91c2','work-bug-0d11','work-ui-55e0','work-bug-2b77','work-long-title'].map(agent=>[agent,{domainId:customer,setBy:by}])),removedWorkers:{}};
  await page.locator('#maestro-workers-view').click();
  await page.locator('#maestro-search').fill('');await page.locator('#maestro-status').selectOption('');await page.locator('#maestro-domain').selectOption('');
  await post({type:'project.tasks',entries,domains});
  if (await page.locator('#maestro-workspace').getAttribute('data-layout')==='split') await page.getByRole('button',{name:'Back to list',exact:true}).click();
  const rows=await page.locator('.maestro-worker-row').evaluateAll(rows=>Object.fromEntries(rows.map(row=>[row.dataset.centerWorker,{
    name:row.querySelector('.maestro-worker-select').textContent,area:row.querySelector('.maestro-worker-area')?.textContent,purpose:row.querySelector('.maestro-worker-purpose').textContent,
    state:row.querySelector('.maestro-worker-status .maestro-state').dataset.status,history:row.querySelector('.maestro-history-button').textContent,
    full:row.querySelector('.maestro-worker-title').title,height:Math.round(row.getBoundingClientRect().height),
    lines:[...row.querySelectorAll('.maestro-worker-line')].map(line=>[line.classList.contains('is-current')?'current':'result',line.querySelector('[data-center-task]')?.dataset.centerTask||line.dataset.resultTask,
      line.querySelector('.maestro-worker-task-title, .maestro-worker-for')?.textContent,line.querySelector('.maestro-state')?.dataset.status,line.querySelector('.maestro-worker-summary')?.textContent,Boolean(line.querySelector('.maestro-worker-original'))])}])));
  const api=rows['work-api-7f3a'];
  // Worker column: the model; title column: the narrower area and the first assignment, not the latest request.
  assert.deepEqual([api.name,api.area,api.purpose,api.state,api.history],['claude-opus-5-5','API 개발','주문 조회 API 개발','running','History 4']);
  // Every open task is listed with its state; then one result line of the newest ended task, which is another task than
  // the row's, so it names that task and its state. Only its first sentence shows; older results stay in History.
  assert.deepEqual(api.lines,[['current','api-now/t-api-2','주문 조회 API에 페이지네이션 추가','running',undefined,false],['current','api-now/t-api-3','응답 캐시 헤더 정리','waiting',undefined,false],
    ['result','api-done/t-api-4','페이지네이션 회귀 테스트','completed','API 페이지네이션 구현과 회귀 테스트를 마쳤습니다.',true]]);
  assert.equal(api.lines.some(line=>line[1]==='api-origin/t-api-1'),false,'Older results stay in History');
  // A finished single task: its title and state are the row's, so the second line is only "Result · …" (markup removed).
  assert.deepEqual([rows['work-db-91c2'].name,rows['work-db-91c2'].purpose,rows['work-db-91c2'].lines],['claude-opus-5-5','고객 테이블 인덱스 설계',[['result','db/t-db',undefined,undefined,'인덱스 3종 설계안 작성',true]]],'Same model, separate worker');
  // The attached case: a short purpose instead of the brief, and the first result sentence instead of the paragraph.
  const coord=rows['coord-matrix-e855264c'];
  assert.deepEqual([coord.name,coord.area,coord.purpose,coord.state],['gpt-6.1-sol',undefined,'Agent Factory 작업 조율을 다양한 정상·경계·실패 조건에서 반복 시험','completed']);
  assert.deepEqual(coord.lines,[['result','coord/t-coord',undefined,undefined,'48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다.',true]]);
  assert.match(coord.full,/최소 40개 구별되는/,'The full brief stays in the tooltip');
  // A brief that opens with who approved it: the task's own clause; the result without its opening address.
  assert.deepEqual([rows['work-brief-1a2b'].purpose,rows['work-brief-1a2b'].lines[0][4]],['하나의 채팅에서 여러 세션과 작업자를 운영할 수 있는 플러그인 실행 기반 구현','플러그인의 지휘자 실행 기반을 구현했습니다.']);
  // Failure, cancellation and a missing result are said as such, never as a success; the state is not repeated.
  assert.deepEqual(rows['work-bug-0d11'].lines,[['result','bug-1/t-bug-1',undefined,undefined,'Result not collected',false]]);
  assert.deepEqual(rows['work-bug-2b77'].lines,[['result','bug-2/t-bug-2',undefined,undefined,'Result not collected',false]]);
  assert.deepEqual([rows['work-bug-0d11'].state,rows['work-bug-2b77'].state],['failed','cancelled']);
  assert.deepEqual([rows['work-ui-55e0'].name,rows['work-ui-55e0'].lines[0][4]],['claude · default model','Result not collected']);
  // A running single task is the row itself: one line, nothing repeated under it.
  assert.deepEqual([rows['work-long-title'].state,rows['work-long-title'].lines],['running',[]]);
  // Compact: a finished worker is two short lines, never the brief or the result paragraph.
  for (const agent of ['coord-matrix-e855264c','work-brief-1a2b','work-db-91c2','work-bug-0d11']) assert.ok(rows[agent].height<=56,agent+' row is two lines: '+rows[agent].height);
  assert.ok(rows['work-long-title'].height<=36,'A running single task is one line: '+rows['work-long-title'].height);
  // Same model and same purpose: numbered, each row still its own worker.
  assert.deepEqual([rows['work-bug-0d11'].name,rows['work-bug-2b77'].name].sort(),['gpt-6.1-sol · 1','gpt-6.1-sol · 2']);
  assert.deepEqual([rows['worker-roles-5b2748a4'].name,rows['worker-roles-5b2748a4'].area],['Model not recorded',undefined]);
  assert.equal(await page.locator('.maestro-worker-select').evaluateAll(items=>items.some(item=>item.textContent.includes(item.dataset.selectWorker))),false,'No row shows its agent ID as the name');
  assert.match(await page.locator('[data-select-worker="work-api-7f3a"]').getAttribute('title'),/work-api-7f3a/,'The ID stays reachable on hover');
  assert.match(await page.locator('[data-center-worker="work-api-7f3a"] .maestro-worker-title').getAttribute('title'),/Assignment reason: 주문 API 담당 한 명이 통합합니다\./);
  // The full result stays in the summary's tooltip and the original one click away; it opens that task's own run.
  assert.equal(await page.locator('[data-center-worker="work-api-7f3a"] .maestro-worker-summary').getAttribute('title'),longResult);
  await page.locator('[data-center-worker="work-api-7f3a"] .maestro-worker-original').click();
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.target==='result').at(-1)),{type:'project.task.open',workflowId:'api-done',taskId:'t-api-4',target:'result',agentId:'work-api-7f3a',runId:'run-t-api-4'});
  // A listed task opens its own task detail.
  await page.locator('[data-center-worker="work-api-7f3a"] [data-center-task="api-now/t-api-3"]').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-task-id'),'t-api-3');
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.selectWorker),'work-api-7f3a','Returning focuses the worker');
  // Keyboard: arrows walk worker → history → its listed work.
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.historyWorker),'work-api-7f3a');
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.centerTask),'api-now/t-api-2');
  // The detail heads with the model, the purpose and the agent ID.
  await page.locator('[data-center-worker="work-api-7f3a"] .maestro-history-button').click();
  assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'work-api-7f3a');
  assert.equal(await page.locator('#maestro-detail h2').textContent(),'claude-opus-5-5');
  assert.equal(await page.locator('#maestro-detail .maestro-worker-purpose-line').textContent(),'Assigned forAPI 개발주문 조회 API 개발');
  assert.equal(await page.locator('#maestro-detail .maestro-worker-id').textContent(),'Agent ID work-api-7f3a');
  await page.getByRole('button',{name:'Back to list',exact:true}).click();
  // Search by the agent ID, the model or the area still finds the worker.
  await page.locator('#maestro-search').fill('work-db-91c2');assert.equal(await page.locator('.maestro-worker-row').count(),1);
  await page.locator('#maestro-search').fill('gpt-6.1-sol');assert.equal(await page.locator('.maestro-worker-row').count(),3);
  await page.locator('#maestro-search').fill('UI/UX');assert.equal(await page.locator('.maestro-worker-row').count(),1);
  await page.locator('#maestro-search').fill('');
  // Long names shorten without pushing the columns; the four columns stay aligned and the work area stays inside.
  for (const width of [1100,783,465,320]) {
    await page.setViewportSize({width,height:900});
    const layout=await page.locator('.maestro-list').evaluate(list=>{const rows=[...list.querySelectorAll('.maestro-worker-head, .maestro-worker-row')];const box=element=>element.getBoundingClientRect();
      return {overflow:list.scrollWidth>list.clientWidth+1,lefts:rows.map(row=>[...row.children].slice(0,4).map(cell=>Math.round(box(cell).left))),
        inside:[...list.querySelectorAll('.maestro-worker-row > *, .maestro-worker-work button, .maestro-worker-summary, .maestro-worker-kind, .maestro-worker-work .maestro-state')].find(cell=>box(cell).width>0&&box(cell).right>box(list).right+1)?.outerHTML.slice(0,160)??true,
        oneLine:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const first=cell=>getComputedStyle(row).alignItems==='start'?box(cell).top:box(cell).top+box(cell).height/2;const tops=[...row.children].slice(1,4).map(first);return Math.max(...tops)-Math.min(...tops)<=4;}),
        under:[...list.querySelectorAll('.maestro-worker-row')].every(row=>{const work=row.querySelector('.maestro-worker-work');return !work||box(work).top>=Math.max(...[...row.children].slice(0,4).map(cell=>box(cell).bottom))-1;}),
        controls:[...list.querySelectorAll('.maestro-worker-original, .maestro-history-button, .maestro-worker-work .maestro-worker-task')].every(element=>box(element).width>20)};});
    assert.equal(layout.overflow,false,width+': no overflow');assert.ok(layout.inside===true,width+': everything inside '+layout.inside);
    for (const index of [1,2,3]) assert.equal(new Set(layout.lefts.map(value=>value[index])).size,1,width+': column '+(index+1)+' aligned');
    assert.ok(layout.oneLine&&layout.under&&layout.controls,width+': one summary line, work below it, controls usable '+JSON.stringify(layout));
    // Role first: the recorded role badge is the leftmost item of every row, before the model, at every width.
    const roleFirst=await page.locator('.maestro-worker-row').evaluateAll(rows=>rows.map(row=>{const cell=row.querySelector('.maestro-worker-cell');const role=cell.querySelector('.maestro-role'),name=cell.querySelector('.maestro-worker-select');
      const r=role.getBoundingClientRect(),n=name.getBoundingClientRect();return [cell.firstElementChild===role,r.left<=n.left+1&&(r.top<n.top-1||r.right<=n.left+1)];}));
    assert.ok(roleFirst.every(([dom,box])=>dom&&box),width+': role precedes the model '+JSON.stringify(roleFirst));
    if (process.env.WORKER_COMPACT_EVIDENCE) await page.screenshot({path:path.join(process.env.WORKER_COMPACT_EVIDENCE,'control-center-worker-compact-20261010-142020-role-first-check-'+width+'.png'),fullPage:true});
  }
  // Dragging still moves the worker by its ID.
  await page.setViewportSize({width:1100,height:700});
  await page.locator('[data-center-worker="work-ui-55e0"] .maestro-worker-cell').dragTo(page.locator('[data-drop-target="__unclassified"]'));
  assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(value=>value.type==='domain.assign').at(-1)),{type:'domain.assign',agentId:'work-ui-55e0',domainId:null,revision:20});
}
