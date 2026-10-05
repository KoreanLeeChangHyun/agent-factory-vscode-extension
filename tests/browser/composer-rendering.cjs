const assert = require('node:assert/strict');

async function checkComposerRendering(page) {
  const viewport = page.viewportSize();
  const geometry = () => page.evaluate(() => Object.fromEntries(
    ['#prompt', '.composer', '#timeline', '#notes-panel'].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return [selector, { y: rect.y, height: rect.height }];
    })
  ));
  await page.locator('#notes-toggle').click();
  for (const width of [360, 820, 1280]) {
    await page.setViewportSize({ width, height: 974 });
    const empty = await geometry();
    await page.locator('#prompt').fill('한 줄 입력');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await geometry(), empty, 'One-line drafts retain default heights');
    await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
    await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
    assert.deepEqual(await geometry(), empty, 'Compact run status must not shrink the transcript or notes');
    const status = await page.locator('#run-status-toggle').boundingBox();
    assert.ok(status.height > 0 && status.y + status.height <= empty['.composer'].y, 'Status remains above the composer');
    await page.locator('#prompt').fill('first\nsecond\nthird');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height > height, empty['#prompt'].height);
    assert.ok((await geometry())['#prompt'].height > empty['#prompt'].height, 'Multiline drafts still grow');
    await page.locator('#prompt').fill('');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height === height, empty['#prompt'].height);
    await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
    // The Main workflow header stays visible; completion hides only the loading indicator.
    await page.waitForFunction(() => document.querySelector('#agent-progress').hidden);
    assert.deepEqual(await geometry(), empty, 'Clearing and completing restores the same geometry');
  }
  await page.locator('#notes-close').click();
  await page.setViewportSize({ width: 721, height: 402 });
  const restingTimelinePadding = await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom);
  await page.evaluate(() => {
    document.querySelector('#companion-dock').hidden = false;
    document.querySelector('#factory-bot').hidden = false;
  });
  assert.equal(await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom), restingTimelinePadding,
    'Floating bot does not reserve transcript clearance');
  await page.evaluate(() => {
    document.querySelector('#companion-dock').hidden = true;
    document.querySelector('#factory-bot').hidden = true;
  });
  await page.evaluate(() => window.postMessage({ type: 'chat.assistant', phase: 'final', text: 'Latest visible transcript line' }, '*'));
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: true }, '*'));
  await page.waitForFunction(() => !document.querySelector('#run-status').hidden);
  // The Main workflow header is always shown, so its transcript clearance is already in place before loading starts.
  assert.equal(await page.locator('#timeline').evaluate(element => getComputedStyle(element).paddingBottom), restingTimelinePadding,
    'Compact loading status keeps the header clearance');
  await page.evaluate(() => { const timeline = document.querySelector('#timeline'); timeline.scrollTop = timeline.scrollHeight; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const latestMessage = await page.locator('.message-assistant').last().boundingBox();
  const compactStatus = await page.locator('#run-status-toggle').boundingBox();
  assert.ok(latestMessage.y + latestMessage.height <= compactStatus.y,
    'Latest chat message stays above the compact loading status');
  await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
  await page.setViewportSize(viewport);
  const pendingRequests = Array.from({ length: 100 }, (_, i) => ({
    id: 'queued-' + i, text: 'Queued ' + i, attachments: [], rejected: i === 0,
    execution: { taskMode: 'direct', businessMode: 'normal', model: 'test-model', fast: false }
  }));
  await page.evaluate(pendingRequests => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ pendingRequests, timeline: [] })), pendingRequests);
  await page.reload();
  const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const queue = page.locator('#pending-message-queue');
  assert.equal(await queue.locator('*').count(), 0, 'Collapsed queues defer content creation');
  await page.locator('#pending-queue-toggle').click();
  assert.match(await queue.textContent(), /Queued 99/);
  const recover = queue.locator('[data-queue-recover]');
  assert.equal(await recover.isEnabled(), true);
  await page.evaluate(() => {
    window.originalQueueChild = document.querySelector('#pending-message-queue').firstChild;
    window.queueWrites = 0;
    new MutationObserver(records => { window.queueWrites += records.length; }).observe(document.querySelector('#pending-message-queue'), { childList: true, subtree: true });
  });
  for (let i = 0; i < 20; i++) {
    await page.locator('#prompt').fill('draft ' + i);
    await settle();
  }
  assert.equal(await recover.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.queueWrites), 0, 'Typing must not rebuild queued content');
  assert.equal(await page.evaluate(() => window.originalQueueChild === document.querySelector('#pending-message-queue').firstChild), true);
  await page.evaluate(() => {
    window.retainedRecover = document.querySelector('[data-queue-recover]');
  });
  await emit({ type: 'chat.rejected', id: 'queued-99' });
  assert.equal(await queue.locator('[data-queue-recover]').count(), 2);
  assert.equal(await page.evaluate(() => window.retainedRecover === document.querySelector('[data-queue-recover]')), true);
  await page.locator('#prompt').fill('   ');
  await settle();
  assert.equal(await recover.first().isEnabled(), true, 'Whitespace permits recovery');
  await recover.first().focus();
  await emit({ type: 'run.state', running: true });
  assert.equal(await page.evaluate(() => document.activeElement === window.retainedRecover), true, 'Run updates retain recovery focus');
  await recover.first().click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Queued 0');
  assert.equal(await queue.locator('[data-queue-recover]').count(), 1);
  await page.locator('#pending-queue-toggle').click();
  assert.equal(await queue.locator('*').count(), 0);
  await emit({ type: 'chat.rejected', id: 'queued-1' });
  assert.equal(await queue.locator('*').count(), 0, 'Hidden queue updates remain lazy');
  await page.locator('#pending-queue-toggle').click();
  assert.equal(await queue.locator('[data-queue-recover]').first().isDisabled(), true, 'Reopening reflects latest rejection and draft');
  await emit({ type: 'run.state', running: true });
  await page.locator('#prompt').fill('');
  await settle();
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /Stop/i);
  await page.locator('#prompt').fill('next');
  await settle();
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /queue/i);
  await emit({ type: 'run.state', running: false });
  await emit({ type: 'goal.updated', goal: { status: 'active', objective: 'Test goal' } });
  assert.equal(await page.locator('#goal-send-icon').isVisible(), true);
  assert.equal(await page.locator('#send-icon').isVisible(), false);
  assert.match(await page.locator('#send-button').getAttribute('aria-label'), /Goal active/);
  await emit({ type: 'run.state', running: true });
  await page.locator('#prompt').fill('');
  await settle();
  assert.equal(await page.locator('#stop-icon').isVisible(), true);
  assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
  await page.locator('#prompt').fill('next');
  await settle();
  assert.equal(await page.locator('#goal-send-icon').isVisible(), true);
  for (const status of ['paused', 'complete', 'blocked']) {
    await emit({ type: 'goal.updated', goal: { status } });
    assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
    assert.equal(await page.locator('#send-icon').isVisible(), true);
  }
  await emit({ type: 'goal.updated', goal: { status: 'active' }, error: 'Unavailable' });
  assert.equal(await page.locator('#goal-send-icon').isVisible(), false);
  await emit({ type: 'goal.updated', goal: null });
  await emit({ type: 'run.state', running: false });
  console.log('Composer rendering: 100 queued messages, 20 input frames, 0 queue child mutations; lazy queue, recovery and send/stop controls passed.');
}
async function checkPendingQueueHeader(page) {
  let cases = 0;
  for (const language of ['en', 'ko']) for (const count of [0, 1, 3]) {
    const pendingRequests = Array.from({length:count}, (_, i) => ({id:'header-queue-'+i, text:'Queued message '+i, attachments:[], execution:{taskMode:'direct', businessMode:'normal', model:'test-model', fast:false}}));
    await page.evaluate(pendingRequests => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({pendingRequests, timeline:[], botVisible:false})), pendingRequests);
    await page.goto(new URL('?lang='+language, page.url()).href);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data:{type:'agents.list',agents:[],workflows:[
      {kind:'work-verification-loop',loopId:'queue-header-active',taskMode:'work-verification',status:'active',workflow:{id:'queue-header-active',title:'Queue header tasks',tasks:Array.from({length:4},(_,i)=>({id:'task-'+i,title:'Task '+i,workStatus:i===0?'running':'completed',verificationStatus:'pending'}))}},
      {kind:'work-verification-loop',loopId:'queue-header-history',taskMode:'work-verification',status:'completed',workflow:{id:'queue-header-history',title:'Retained history',tasks:[{id:'done',title:'Completed task',workStatus:'completed',verificationStatus:'completed'}]}}
    ]}})));
    for (const size of [{width:1200,height:900}, {width:721,height:402}, {width:465,height:556}, {width:320,height:800}]) {
      await page.setViewportSize(size);
      for (const bot of [false,true]) for (const running of [false,true]) for (const expanded of [false,true]) {
        await page.evaluate(bot => {document.getElementById("companion-dock").hidden=!bot;document.getElementById("factory-bot").hidden=!bot;},bot);
        await page.evaluate(running => window.dispatchEvent(new MessageEvent('message',{data:{type:'run.state',running}})),running);
        const flow = page.locator('#run-status-toggle'), toggle = page.locator('#pending-queue-toggle');
        if ((await flow.getAttribute('aria-expanded') === 'true') !== expanded) await flow.click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await toggle.isVisible(), count > 0, 'Zero queues keep the existing hidden toggle');
        const boxes = await page.evaluate(() => {
          const box = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,center:r.y+r.height/2};};
          return {flow:box('#run-status-toggle'),history:box('#workflow-history'),queue:box('#pending-queue-toggle'),progress:box('#agent-progress'),details:box('#run-details')};
        });
        const context=JSON.stringify({language,count,size,bot,running,expanded,boxes});
        if (count) {
          assert.ok(Math.abs(boxes.queue.center-boxes.flow.center)<2, 'Queue shares workflow baseline '+context);
          assert.ok(boxes.flow.right<=boxes.history.x+1 && boxes.history.right<=boxes.queue.x+1, 'Header order is preserved '+context);
          assert.ok(boxes.flow.x>=0 && boxes.queue.right<=size.width, 'Header fits viewport '+context);
          if(running) assert.ok(boxes.progress.right<=boxes.flow.x+1, 'Loading does not overlap '+context);
          // The open header keeps Main's indicator at its left edge, as the closed dock does.
          if(running && expanded) assert.ok(boxes.progress.x<=boxes.details.x+8, 'Loading leads the open header at the left '+context);
          if(expanded) assert.ok(boxes.queue.bottom<=boxes.details.y+1, 'Queue stays above task cards '+context);
          if (process.env.AF_RENDERING_ARTIFACT_DIR && language==='ko' && count===1 && !bot && running && expanded && [465,1200].includes(size.width)) {
            await page.screenshot({path:require('node:path').join(process.env.AF_RENDERING_ARTIFACT_DIR,'queue-header-'+size.width+'.png')});
          }
          await toggle.focus(); await page.keyboard.press('Enter');
          assert.equal(await page.locator('#pending-message-queue').isVisible(),true);
          assert.match(await page.locator('#pending-message-queue').textContent(),/Queued message 0/);
          if (language==='ko' && count===1 && !bot && expanded && size.width===1200) {
            await page.locator(running?'[data-queue-send-now]':'[data-queue-resume]').click();
            assert.deepEqual(await page.evaluate(()=>window.sentMessages.at(-1)), {type:running?'run.cancel':'queue.resume'}, 'Existing manual queue actions keep their Host message');
          }
          if (process.env.AF_RENDERING_ARTIFACT_DIR && language==='ko' && count===1 && !bot && running && expanded && [465,1200].includes(size.width)) {
            await page.screenshot({path:require('node:path').join(process.env.AF_RENDERING_ARTIFACT_DIR,'queue-list-'+size.width+'.png')});
          }
          const openHeader=await flow.boundingBox(), composer=await page.locator('.composer').boundingBox();
          assert.ok(openHeader.y>=0 && composer.y+composer.height<=size.height, 'Open queue retains the header and composer inside the viewport '+context);
          const notes=await page.locator('#notes-toggle').boundingBox(), openToggle=await toggle.boundingBox();
          if(notes) assert.ok(openToggle.y>=notes.y+notes.height || openToggle.x+openToggle.width<=notes.x || openToggle.x>=notes.x+notes.width, 'Open queue clears the fixed notes button '+JSON.stringify({context,notes,openToggle}));
          const list=await page.locator('#pending-message-queue').boundingBox();
          const statusBottom=await page.locator(expanded?'#run-details':'#pending-queue-toggle').evaluate(el=>el.getBoundingClientRect().bottom);
          assert.ok(list.y>=statusBottom-1,'Queue list opens below status');
          await flow.click();
          assert.equal(await toggle.getAttribute('aria-expanded'),'true','Workflow disclosure preserves open queue');
          await flow.click(); await toggle.focus(); await page.keyboard.press('Space');
          assert.equal(await page.locator('#pending-message-queue').isVisible(),false);
          assert.equal(await page.evaluate(()=>window.saved.pendingRequests.length),count,'Queued data survives layout and disclosure');
        }
        cases++;
      }
    }
  }
  console.log('Queue header: '+cases+' language/count/viewport/loading/disclosure combinations passed.');
}
module.exports = { checkComposerRendering, checkPendingQueueHeader };
