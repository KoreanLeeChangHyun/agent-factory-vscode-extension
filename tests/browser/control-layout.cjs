const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function densityFixture() {
  const now=Date.now(), at=minutes=>new Date(now-minutes*60_000).toISOString();
  const names=['문서 관리','외부 도구 연동','작업 조율','테스트 도구','플러그인 런타임','확장 UI'];
  const by={actor:'human',at:at(1),source:'layout-fixture'};
  const domains=names.map((name,i)=>({id:'domain-'+String(i+1).repeat(12),name,aliases:[],createdBy:by,nameSetBy:by}));
  const assignments={},entries=[],workers=[];
  domains.forEach((domain,i)=>{
    for(let j=0;j<2;j++) {
      const agentId='layout-'+i+'-'+j, status=j?'completed':i===1?'blocked':'running';
      const run={role:'work',workProfile:'workLight',agentId,runId:'run-'+agentId,model:'gpt-6-luna',status,startedAt:at(j?55:4),...(j?{finishedAt:at(51),receipt:{outcome:'completed'}}:{})};
      const task={id:'task-'+agentId,title:domain.name+' 도메인의 신규 수행자 고용 시험: 정상·경계 사례를 자기 세션에서 구현하고 반복 실행하여 증거를 제출하십시오.',domain:'사례 검사',workAgentId:agentId,workStatus:status,runs:[run]};
      assignments[agentId]={domainId:domain.id,setBy:by};
      const tasks=[task];
      if(i===0&&j===0)tasks.push({...task,id:'parallel-task',title:'동시에 진행하는 추가 배정의 결과를 확인하십시오.',workStatus:'pending',runs:[{...run,runId:'parallel-run',status:'pending'}]});
      entries.push({id:'flow-'+agentId,title:task.title,status:j?'completed':'active',workAgentId:agentId,mainAgentId:'fixture-main',loopId:'loop-'+agentId,updatedAt:at(j?51:4),tasks});
      workers.push({agentId,role:'work',workProfile:'workLight',availability:j?'idle':'busy',removed:false,current:[],queued:[],holds:[],failed:i===0&&j===0?[{title:'보존해야 하는 실패 기록'}]:[],taskCounts:{},runCount:tasks.length,
        latestRun:{...run,...(!j?{liveActivity:{category:'command',phase:'completed',text:'cat /fixture/layout-source.js',durationMs:12}}:{})}});
    }
  });
  return {type:'project.tasks',entries,domains:{revision:1,domains,assignments,removedWorkers:{}},team:{status:'ok',workers},workerOrder:[],domainOrder:[],hiddenWorkers:[]};
}
async function checkControlLayout(chatPage) {
  const before=process.argv.includes('--layout-before'), artifact=process.env.CONTROL_LAYOUT_EVIDENCE;
  const context=await chatPage.context().browser().newContext();
  await context.addInitScript(()=>{
    window.sentMessages=[];
    window.acquireVsCodeApi=()=>({getState:()=>({centerScope:'all'}),setState(){},postMessage:message=>window.sentMessages.push(message)});
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/center?lang=ko',chatPage.url()).href);
  const fixture=densityFixture();
  await page.evaluate(message=>window.dispatchEvent(new MessageEvent('message',{data:message})),fixture);
  await page.locator('[data-center-worker="layout-0-0"]').waitFor();
  const measurements=[];
  for(const [width,height,zoom] of [[1200,900,1],[820,900,1],[465,760,1],[320,760,1],[1200,900,1.25]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(zoom=>{document.documentElement.style.zoom=String(zoom);},zoom);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const measured=await page.locator('#maestro-tasks').evaluate(list=>{
      const rect=element=>element.getBoundingClientRect();
      const rows=[...list.querySelectorAll('[data-center-worker]')];
      const headers=[...list.querySelectorAll('.maestro-domain-toggle')];
      return {
        rowHeights:rows.map(row=>rect(row).height),
        contentHeight:rect(rows.at(-1)).bottom-rect(headers[0]).top,
        overflow:list.scrollWidth-list.clientWidth,
        statusTime:rows.map(row=>{const state=row.querySelector('.maestro-worker-status .maestro-state'),time=row.querySelector('.maestro-time');return {agent:row.dataset.centerWorker,delta:Math.abs((rect(state).top+rect(state).bottom-rect(time).top-rect(time).bottom)/2),text:time.textContent,state:state.textContent};}),
        headers:headers.map(header=>{const count=header.querySelector('.maestro-count'),summary=header.querySelector('.maestro-group-summary'),name=header.children[1];return {text:header.textContent,countGap:rect(count).left-rect(name).right,summaryGap:rect(summary).left-rect(count).right,summaryClipped:summary.scrollWidth>summary.clientWidth+1,editWidth:rect(header.nextElementSibling).width,childrenInside:[...header.children].every(child=>rect(child).right<=rect(header).right+.5&&rect(child).bottom<=rect(header).bottom+.5)};}),
        targets:rows.flatMap(row=>[...row.querySelectorAll('.maestro-worker-hide,.maestro-session-open')].filter(el=>!el.hidden).map(el=>({width:rect(el).width,height:rect(el).height}))),
        information:rows.map(row=>({id:row.dataset.centerWorker,role:row.querySelector('.maestro-role').textContent,model:row.querySelector('.maestro-model-label').textContent,purpose:row.querySelector('.maestro-worker-purpose').title,failed:[...row.querySelectorAll('.maestro-worker-failed')].map(el=>el.textContent),otherTasks:[...row.querySelectorAll('[data-center-task]')].map(el=>el.dataset.centerTask)}))
      };
    });
    measurements.push({width,height,zoom,...measured});
    assert.equal(measured.rowHeights.length,12,'Every performer is kept');
    assert.equal(measured.overflow,0,width+': no horizontal overflow');
    assert.ok(measured.targets.every(target=>target.width>=18*zoom-.5&&target.height>=18*zoom-.5),'Original click target sizes are kept');
    assert.ok(measured.headers.every(header=>header.editWidth>=24*zoom-.5),'Edit targets stay usable');
    assert.ok(measured.information.some(row=>row.failed.length===1),'Failure counts are kept');
    assert.ok(measured.information.some(row=>row.otherTasks.includes('flow-layout-0-0/parallel-task')),'Other active assignments are kept');
    if(!before) {
      if(width>=465)assert.ok(measured.statusTime.every(item=>item.delta<=1.5*zoom),width+': status and time share one line '+JSON.stringify(measured.statusTime));
      assert.ok(measured.headers.every(header=>!header.summaryClipped&&header.childrenInside),'Header labels are readable without overlapping the next row');
      if(width>=465)assert.ok(measured.headers.every(header=>header.countGap>=0&&header.countGap<=12*zoom&&header.summaryGap>=0&&header.summaryGap<=12*zoom),'Header information stays together');
      assert.ok(measured.headers.every(header=>header.text.includes('수행자 2')&&header.text.includes('배정 ')),'Counts have explicit labels');
    }
    if(artifact)await page.screenshot({path:path.join(artifact,(before?'before':'after')+'-'+width+'-'+zoom+'.png')});
  }
  if(!before) {
    await page.setViewportSize({width:820,height:900});await page.evaluate(()=>{document.documentElement.style.zoom='1';});
    for(const theme of ['vscode-light','vscode-high-contrast','vscode-dark']) {
      await page.evaluate(theme=>{
        document.body.className=theme;
        const colors=theme==='vscode-light'?['#fff','#333','#f3f3f3','#bbb','#666']:theme==='vscode-high-contrast'?['#000','#fff','#000','#fff','#fff']:['#1e1e1e','#d4d4d4','#252526','#454545','#999'];
        for(const [i,key] of ['--vscode-editor-background','--vscode-foreground','--vscode-editorWidget-background','--vscode-panel-border','--vscode-descriptionForeground'].entries())document.documentElement.style.setProperty(key,colors[i]);
      },theme);
      assert.equal(await page.locator('#maestro-tasks').evaluate(list=>list.scrollWidth<=list.clientWidth),true,theme+': labels remain within the list');
      if(artifact)await page.screenshot({path:path.join(artifact,'after-'+theme+'.png')});
    }

    await page.locator('[data-select-worker="layout-0-0"]').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#maestro-detail').getAttribute('data-view'),'worker');
    assert.equal(await page.locator('#maestro-detail .maestro-worker-history-block').count(),1);
    await page.locator('#maestro-detail .maestro-close').click();
    await page.locator('.maestro-domain-edit').first().focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-domain-input]').count(),1,'Domain editing remains reachable');
    await page.locator('[data-domain-input]').press('Escape');
  }
  assert.deepEqual(errors,[]);
  if(artifact)fs.writeFileSync(path.join(artifact,before?'before.json':'after.json'),JSON.stringify(measurements,null,2));
  console.log(JSON.stringify(measurements.map(value=>({width:value.width,zoom:value.zoom,meanRowHeight:value.rowHeights.reduce((a,b)=>a+b)/value.rowHeights.length,contentHeight:value.contentHeight,statusTimeOneLine:value.statusTime.filter(item=>item.delta<=2).length,headerSummaryGaps:value.headers.map(header=>header.summaryGap)}))));
  await context.close();
}
module.exports={checkControlLayout};
