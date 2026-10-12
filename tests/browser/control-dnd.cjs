const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = 'domain-aaaaaaaaaaaa', B = 'domain-bbbbbbbbbbbb', C = 'domain-cccccccccccc';
function fixture(hidden) {
  const at = '2026-10-12T18:40:00Z';
  const by = {actor:'human',at,source:'fixture'};
  const ids = ['dnd-a1','dnd-a2','dnd-a3','dnd-b1','dnd-hidden'];
  return {workerOrder:ids,domainOrder:[],hiddenWorkers:hidden?['dnd-hidden']:[],
    domains:{revision:1,domains:[A,B,C].map((id,i)=>({id,name:['A 영역','B 영역','C 빈 영역'][i],aliases:[],createdBy:by,nameSetBy:by})),
      assignments:Object.fromEntries(ids.map(id=>[id,{domainId:id.startsWith('dnd-a')?A:B,setBy:by}])),removedWorkers:{}},
    entries:ids.map((id,i)=>({id:'flow-'+id,title:id,status:'completed',mainAgentId:'fixture-main',workAgentId:id,loopId:'loop-'+id,updatedAt:at,
      tasks:[{id:'task-'+id,title:'고용 목적 '+id,workAgentId:id,workStatus:'completed',runs:[{role:'work',workProfile:'workLight',agentId:id,runId:'run-'+id,status:'completed',model:'fixture-model-'+i,finishedAt:at,receipt:{outcome:'completed'}}]}]}))};
}
async function pointerDrag(page, source, target, after=false, refresh=false) {
  const start = await source.boundingBox(), end = await target.boundingBox();
  assert.ok(start && end, 'Drag endpoints are visible');
  const x = start.x + Math.min(start.width/2, 60), y = start.y + start.height/2;
  await page.mouse.move(x,y);
  await page.mouse.down();
  await page.mouse.move(x+8,y+2,{steps:4});
  if (refresh) await page.evaluate(()=>window.refreshFixture());
  await page.mouse.move(end.x+Math.min(end.width/2,80),end.y+(after?end.height-3:3),{steps:16});
  // A second move inside the target delivers the native dragover before releasing.
  await page.mouse.move(end.x+Math.min(end.width/2,80)+1,end.y+(after?end.height-3:3),{steps:2});
  await page.mouse.up();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function checkControlDnD(chatPage) {
  const results = [], reproduce = process.argv.includes('--dnd-reproduce');
  const artifact = process.env.CONTROL_DND_EVIDENCE;
  for (const width of (reproduce?[1100]:[1100,465])) for (const scenario of ['same-domain-hidden','cross-domain','cross-domain-hidden','domain-order']) {
    const context = await chatPage.context().browser().newContext({viewport:{width,height:700}});
    let page = await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(seed=>{
      const key = 'native-dnd-fixture';
      if (!localStorage.getItem(key)) localStorage.setItem(key,JSON.stringify(seed));
      window.sentMessages=[]; window.dragStarts=[];
      document.addEventListener('dragstart',event=>window.dragStarts.push({worker:event.target.closest('[data-center-worker]')?.dataset.centerWorker,domain:event.target.closest('[data-domain-key]')?.dataset.domainKey}),true);
      const get=()=>JSON.parse(localStorage.getItem(key));
      const post=message=>window.dispatchEvent(new MessageEvent('message',{data:message}));
      window.refreshFixture=()=>post({type:'project.tasks',...get(),team:{status:'unsupported'}});
      window.acquireVsCodeApi=()=>({
        getState:()=>JSON.parse(localStorage.getItem('native-dnd-panel')||'null')||{centerScope:'all'},
        setState:state=>localStorage.setItem('native-dnd-panel',JSON.stringify(state)),
        postMessage:message=>{
          window.sentMessages.push(message);
          queueMicrotask(()=>{
            if (message.type==='client.ready'||message.type==='project.tasks.request') return window.refreshFixture();
            const state=get();
            if (message.type==='worker.order'||message.type==='domain.order') {
              const property=message.type==='worker.order'?'workerOrder':'domainOrder';
              state[property]=message.order;localStorage.setItem(key,JSON.stringify(state));
              post({type:message.type+'.result',order:message.order});window.refreshFixture();
            } else if (message.type==='domain.assign') {
              state.domains.assignments[message.agentId]={domainId:message.domainId,setBy:{actor:'human',at:'2026-10-12T18:41:00Z',source:'fixture-drop'}};
              state.domains.revision++;localStorage.setItem(key,JSON.stringify(state));
              post({type:'domain.result',edit:'domain.assign'});window.refreshFixture();
            }
          });
        }
      });
    },fixture(scenario.includes('hidden')));
    await page.goto(new URL('/center?lang=ko',chatPage.url()).href);
    const row=id=>page.locator('[data-center-worker="'+id+'"]');
    const header=id=>page.locator('[data-domain-key="'+id+'"]');
    await row('dnd-a3').waitFor();
    const selectionBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('native-dnd-panel')||'{}').centerSelection);
    if (scenario.startsWith('same')) await pointerDrag(page,row('dnd-a3').locator('.maestro-worker-select'),row('dnd-a1'),false,!reproduce);
    else if (scenario.startsWith('cross')) await pointerDrag(page,row('dnd-a3').locator('.maestro-role'),header(B),false,!reproduce);
    else await pointerDrag(page,header(B).locator('span').first(),header(A),false,!reproduce);
    const observed=await page.evaluate(()=>({stored:JSON.parse(localStorage.getItem('native-dnd-fixture')),messages:window.sentMessages,dragStarts:window.dragStarts,
      selection:JSON.parse(localStorage.getItem('native-dnd-panel')||'{}').centerSelection,
      domains:[...document.querySelectorAll('[data-domain-key]')].map(el=>el.dataset.domainKey)}));
    const type=scenario.startsWith('same')?'worker.order':scenario.startsWith('cross')?'domain.assign':'domain.order';
    const sent=observed.messages.filter(message=>message.type===type);
    results.push({scenario,width,type,sent:sent.length,dragStarts:observed.dragStarts,order:observed.stored.workerOrder,domainOrder:observed.domains,assignment:observed.stored.domains.assignments['dnd-a3'].domainId});
    if (!reproduce) {
      assert.equal(sent.length,1,scenario+': one save after a real pointer drag '+JSON.stringify(results.at(-1)));
      assert.equal(observed.dragStarts.length,1,scenario+': native drag started');
      assert.deepEqual(observed.selection,selectionBefore,'Dragging does not open or collapse a target');
      if (scenario.startsWith('same')) assert.deepEqual(observed.stored.workerOrder.slice(0,3),['dnd-a3','dnd-a1','dnd-a2']);
      else if (scenario.startsWith('cross')) assert.equal(observed.stored.domains.assignments['dnd-a3'].domainId,B);
      else assert.deepEqual(observed.domains,[B,A,C]);
      // Refresh and tab reopen read the fake host's stored records, not optimistic DOM order.
      await page.evaluate(()=>window.refreshFixture());
      const reopened=await context.newPage();reopened.on('pageerror',error=>errors.push(error.message));
      await reopened.goto(new URL('/center?lang=ko',chatPage.url()).href);
      await page.close();page=reopened;await row('dnd-a3').waitFor();
      const kept=await page.evaluate(()=>JSON.parse(localStorage.getItem('native-dnd-fixture')));
      assert.deepEqual(kept,observed.stored,scenario+': stored data survives reopening');
      if (scenario.startsWith('same')) assert.deepEqual(await page.locator('[data-center-worker]').evaluateAll(rows=>rows.slice(0,3).map(el=>el.dataset.centerWorker)),['dnd-a3','dnd-a1','dnd-a2']);
      assert.equal(await row('dnd-a3').evaluate(element=>{let previous=element.previousElementSibling;while(previous&&!previous.dataset.domainKey)previous=previous.previousElementSibling;return previous?.dataset.domainKey;}),scenario.startsWith('cross')?B:A,'Reopening restores rendered membership');
      if (scenario==='domain-order') assert.deepEqual(await page.locator('[data-domain-key]').evaluateAll(headers=>headers.map(el=>el.dataset.domainKey)),[B,A,C]);
      // A click still opens the performer detail; the model still opens its exact session.
      await row('dnd-a3').locator('.maestro-worker-select').click();
      assert.equal(await page.locator('#maestro-detail').getAttribute('data-worker-id'),'dnd-a3');
      assert.equal(await page.locator('#maestro-detail').getAttribute('data-view'),'worker');
      if (width>=760) await row('dnd-a3').locator('.maestro-worker-model').click();
      else await page.locator('#maestro-detail [data-open-session="dnd-a3"]').click();
      assert.deepEqual(await page.evaluate(()=>window.sentMessages.filter(message=>message.type==='project.task.open').at(-1)),{type:'project.task.open',workflowId:'flow-dnd-a3',taskId:'task-dnd-a3',target:'run',agentId:'dnd-a3',runId:'run-dnd-a3'});
      await page.locator('#maestro-detail .maestro-close').click();
      await header(A).click();assert.equal(await header(A).getAttribute('aria-expanded'),'false');
      await header(A).click();assert.equal(await header(A).getAttribute('aria-expanded'),'true');
    }
    assert.deepEqual(errors,[],scenario+': no browser errors');
    if (artifact) await page.screenshot({path:path.join(artifact,scenario+'-'+width+(reproduce?'-before':'-after')+'.png')});
    await context.close();
  }
  console.log(JSON.stringify(results));
  if (artifact) fs.writeFileSync(path.join(artifact,reproduce?'before.json':'after.json'),JSON.stringify(results,null,2));
}
module.exports={checkControlDnD};
