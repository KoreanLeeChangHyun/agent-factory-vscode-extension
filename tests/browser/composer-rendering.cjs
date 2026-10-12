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
    const active = await geometry();
    assert.deepEqual(active['#prompt'], empty['#prompt'], 'Feedback preserves the draft dimensions and position');
    assert.deepEqual(active['.composer'], empty['.composer'], 'Feedback stays above the composer');
    for (const selector of ['#timeline', '#notes-panel']) {
      assert.equal(active[selector].y, empty[selector].y);
      const reserved = empty[selector].height - active[selector].height;
      assert.ok(reserved >= 0 && reserved <= 64, 'Only the readable feedback/header rows reserve transcript height');
    }
    const status = await page.locator('#run-status-toggle').boundingBox();
    assert.ok(status.height > 0 && status.y + status.height <= empty['.composer'].y, 'Status remains above the composer');
    await page.locator('#prompt').fill('first\nsecond\nthird');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height > height, empty['#prompt'].height);
    assert.ok((await geometry())['#prompt'].height > empty['#prompt'].height, 'Multiline drafts still grow');
    await page.locator('#prompt').fill('');
    await page.waitForFunction(height => document.querySelector('#prompt').getBoundingClientRect().height === height, empty['#prompt'].height);
    await page.evaluate(() => window.postMessage({ type: 'run.state', running: false }, '*'));
    // A stopped run without an explicit outcome keeps the honest terminal feedback visible.
    await page.waitForFunction(() => document.querySelector('#run-status-label').textContent === 'Execution ended');
    assert.deepEqual(await geometry(), active, 'Clearing and ending retain one feedback row without accumulating height');
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
  assert.equal(await queue.isVisible(), true, 'Rejected submission exposes the recovery controls');
  await page.locator('#pending-queue-toggle').click();
  await emit({ type: 'chat.pending', id: 'queued-2' });
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
          if(running) assert.ok(boxes.progress.bottom<=boxes.flow.y+1 || boxes.flow.bottom<=boxes.progress.y+1 || boxes.progress.right<=boxes.flow.x+1, 'Loading does not overlap '+context);
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
// Status line and composer share one set of edges; toggles and icon buttons follow one shared rule each.
async function checkComposerStatusLine(page) {
  await page.goto(new URL('/?lang=ko', page.url()).href);
  const post = message => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
  const capability = { model: true, reasoning: true, fast: true, workIsolation: true, taskModes: ['direct', 'orchestrate', 'work'] };
  await post({ type: 'host.initialize', panelId: 'status-line', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false, capabilities: { submit: capability, send: capability } });
  const sends = () => page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send'));
  for (const width of [795, 360, 320]) {
    await page.setViewportSize({ width, height: 700 });
    const idle = await page.evaluate(() => {
      const prompt = document.querySelector('#prompt');
      return { promptLeft: prompt.getBoundingClientRect().left + parseFloat(getComputedStyle(prompt).paddingLeft),
        modelLeft: document.querySelector('#model-label').getBoundingClientRect().left,
        progressHidden: document.querySelector('#agent-progress').hidden, queueHidden: document.querySelector('#pending-queue-toggle').hidden };
    });
    assert.equal(idle.progressHidden, true);
    assert.equal(idle.queueHidden, true);
    assert.ok(Math.abs(idle.promptLeft - idle.modelLeft) <= 0.25, 'Idle prompt/model alignment ' + JSON.stringify({ width, idle }));
  }
  await page.setViewportSize({ width: 795, height: 700 });
  await page.locator('#prompt').fill('현재 작업');
  await page.locator('#send-button').click();
  await post({ type: 'run.state', running: true });
  await post({ ...(await sends()).at(-1), type: 'chat.started' });
  await post({ type: 'run.observed', status: 'running' });
  assert.equal(await page.locator('#run-status-label').textContent(), '첫 응답 대기', 'Without a queue the line keeps the run phase');
  // Compare visible edges: the prompt text inside the textarea padding, a running dot's widest ripple ring and the chevron's stroke cap.
  const edges = () => page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const chevron = document.querySelector('#pending-queue-toggle:not([hidden]) svg path');
    const prompt = document.querySelector('#prompt');
    const promptLeft = prompt.getBoundingClientRect().left + parseFloat(getComputedStyle(prompt).paddingLeft);
    const dot = document.querySelector('#agent-progress .run-status-pulse'), progressing = document.querySelector('#agent-progress').classList.contains('is-progressing') && matchMedia('(prefers-reduced-motion: no-preference)').matches;
    const animation = dot.style.animation; dot.style.animation = 'none';
    const rest = dot.getBoundingClientRect(); dot.style.animation = animation;
    const ringScale = progressing ? parseFloat(getComputedStyle(dot).getPropertyValue('--run-status-ring-scale')) : 1;
    const ring = progressing ? document.getAnimations().find(item => item.animationName === 'run-status-dot-ripple' && item.effect.target === dot && item.effect.pseudoElement === '::before') : null;
    let drawnScale = null;
    if (ring) { const time = ring.currentTime; ring.pause(); ring.currentTime = 1799; drawnScale = new DOMMatrix(getComputedStyle(dot, '::before').transform).a; ring.currentTime = time; ring.play(); }
    const chevronRight = chevron ? chevron.getBoundingClientRect().right + parseFloat(getComputedStyle(chevron).strokeWidth) * chevron.ownerSVGElement.getBoundingClientRect().width / 16 / 2 : null;
    return { promptLeft, dotLeft: rest.left + rest.width / 2 - rest.width * ringScale / 2, ringScale, drawnScale, modelLeft: box('#model-label').left, sendRight: box('#send-button').right, chevronRight,
      label: document.getElementById('run-status-label').textContent, queueHidden: document.getElementById('pending-queue-toggle').hidden };
  });
  const aligned = async (queued, width) => {
    await page.mouse.move(1, 1); await page.locator('#prompt').blur(); await page.waitForTimeout(250);
    const value = await edges(), context = JSON.stringify({ queued, width, value });
    if (value.drawnScale !== null) assert.ok(Math.abs(value.drawnScale - value.ringScale) <= 0.01, 'The ripple ring grows to the scale used for alignment ' + context);
    assert.ok(Math.abs(value.dotLeft - value.modelLeft) <= 1, 'Dot starts on the model label edge ' + context);
    assert.ok(Math.abs(value.promptLeft - value.modelLeft) <= 0.25, 'Prompt and model share the left edge ' + context);
    assert.ok(Math.abs(value.dotLeft - value.promptLeft) <= 1, 'Dot and prompt share the left edge ' + context);
    if (queued) assert.ok(Math.abs(value.chevronRight - value.sendRight) <= 1, 'Queued count ends on the send button edge ' + context);
    else assert.equal(value.queueHidden, true, 'No queued count without queued messages ' + context);
  };
  for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(0, width); }
  // Response phases keep the same edges as the first-response wait.
  const runId = (await sends()).at(-1).id;
  await post({ type: 'chat.delta', runId, id: 'status-line-delta', stream: 'commentary', text: '진행 중' });
  assert.equal(await page.locator('#run-status-label').textContent(), '응답 수신 · 후속 결과 대기');
  for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(0, width); }
  await post({ type: 'chat.assistant', runId, text: '응답', phase: 'final' });
  assert.equal(await page.locator('#run-status-label').textContent(), '응답 수신 · 실행 종료 확인 중');
  for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(0, width); }
  await page.setViewportSize({ width: 795, height: 700 });
  for (const [index, text] of ['다음 메시지', '그다음 메시지'].entries()) {
    await page.locator('#prompt').fill(text);
    await page.locator('#send-button').click();
    await post({ type: 'chat.pending', id: (await sends()).at(-1).id });
    if (index === 0) for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(1, width); }
  }
  await page.setViewportSize({ width: 795, height: 700 });
  await page.mouse.move(1, 1);
  await page.locator('#prompt').blur();
  for (const width of [795, 360, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 }; };
      const chevron = document.querySelector('#pending-queue-toggle svg path').getBoundingClientRect();
      return { composer: box('.composer'), prompt: box('#prompt'), dot: box('#agent-progress .run-status-pulse'), label: box('#run-status-label'), elapsed: box('#run-elapsed'), count: box('#pending-queue-label'), chevronRight: chevron.right };
    });
    const context = JSON.stringify({ width, geometry });
    assert.equal(await page.locator('#run-status-label').textContent(), '앞 메시지 처리 중', 'The line names why messages wait');
    assert.equal(await page.locator('#pending-queue-label').textContent(), '남은 메시지 2건', 'The count reads as remaining messages');
    for (const part of ['label', 'elapsed', 'count']) assert.ok(Math.abs(geometry[part].mid - geometry.dot.mid) <= 1, part + ' shares the dot line ' + context);
    await aligned(2, width);
    assert.ok(geometry.count.bottom <= geometry.composer.top && geometry.composer.top - geometry.label.bottom <= 8, 'Status line sits just above the composer ' + context);
  }
  for (const theme of ['vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-dark']) {
    await page.evaluate(theme => { document.body.className = theme; }, theme);
    for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(2, width); }
  }
  // Without motion there is no ring, so the dot itself starts on the edge.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [795, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(2, width); }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 795, height: 700 });
  // Let the send-to-stop colour transition finish before comparing surfaces.
  await page.waitForTimeout(300);
  const accent = await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--af-color-accent)'; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
  const styles = await page.evaluate(() => {
    const read = selector => { const node = document.querySelector(selector); const style = getComputedStyle(node); const r = node.getBoundingClientRect(); return { color: style.color, background: style.backgroundColor, border: style.borderTopColor, width: r.width, height: r.height, pressed: node.getAttribute('aria-pressed') }; };
    return { label: read('#run-status-label'), count: read('#pending-queue-toggle'), composer: read('.composer'),
      icons: ['#conversation-clear-button', '#question-button', '#submission-button', '#send-button'].map(read),
      toggles: ['#orchestrate-mode-button', '#work-isolation-button', '#auto-scroll-button'].map(read) };
  });
  assert.notEqual(styles.composer.border, accent, 'A running composer has no accent border');
  assert.notEqual(styles.count.color, accent, 'The queued count stays neutral');
  assert.equal(await page.locator('.astra-stars').isVisible(), false, 'The starfield shows only for an Astra Main model');
  assert.equal(await page.locator('#send-button').evaluate(node => node.classList.contains('is-running')), true, 'Empty composer shows stop');
  assert.equal(new Set(styles.icons.map(icon => icon.width + 'x' + icon.height)).size, 1, 'Icon buttons share one size ' + JSON.stringify(styles.icons));
  assert.equal(new Set(styles.icons.map(icon => icon.background)).size, 1, 'Clear, question, submit and stop share one surface ' + JSON.stringify(styles.icons));
  assert.ok(styles.toggles.some(toggle => toggle.pressed === 'true') && styles.toggles.some(toggle => toggle.pressed === 'false'), 'Fixture covers both toggle states');
  assert.equal(new Set(styles.toggles.map(toggle => toggle.background + '|' + toggle.height)).size, 1, 'On and off chips share one surface ' + JSON.stringify(styles.toggles));
  for (const toggle of styles.toggles) assert.notEqual(toggle.color, accent, 'Toggle chips do not use the accent');
  // An "on" switch fills its track with the project blue and an "off" track stays outlined; the thumb position and
  // aria-pressed still carry the state, so colour is not the only cue.
  const tracks = await page.evaluate(() => ['#orchestrate-mode-button', '#work-isolation-button', '#auto-scroll-button'].map(selector => { const node = document.querySelector(selector); const rect = node.querySelector('.toggle-icon rect'), thumb = node.querySelector('.toggle-thumb');
    return { pressed: node.getAttribute('aria-pressed'), fill: getComputedStyle(rect).fill, thumbX: thumb.getBoundingClientRect().left - rect.getBoundingClientRect().left }; }));
  for (const track of tracks) assert.equal(track.fill === accent, track.pressed === 'true', 'Only an on switch is blue ' + JSON.stringify(tracks));
  const on = tracks.find(track => track.pressed === 'true'), off = tracks.find(track => track.pressed === 'false');
  assert.ok(on.thumbX > off.thumbX, 'The thumb position differs between on and off');
  await page.locator('#pending-queue-toggle').click();
  const list = await page.locator('#pending-message-queue').boundingBox(), toggle = await page.locator('#pending-queue-toggle').boundingBox(), composer = await page.locator('.composer').boundingBox();
  assert.ok(list.y >= toggle.y + toggle.height - 1 && list.y + list.height <= composer.y, 'Queue list opens between the status line and composer');
  assert.ok(Math.abs(list.x - composer.x) <= 1 && Math.abs(list.width - composer.width) <= 1, 'Queue list spans the composer width');
  assert.match(await page.locator('#pending-message-queue').textContent(), /다음 메시지[\s\S]*그다음 메시지/);
  await page.locator('#pending-queue-toggle').click();
  // A stopped run with queued messages shows a plain dot; it starts on the same edge without the ring allowance.
  await post({ type: 'run.observed', status: 'completed' });
  await post({ type: 'run.state', running: false });
  assert.equal(await page.locator('#run-status-label').textContent(), '대기열에 접수됨');
  for (const width of [795, 360, 320]) { await page.setViewportSize({ width, height: 700 }); await aligned(2, width); }
  await page.setViewportSize({ width: 795, height: 700 });
  if (process.env.AF_RENDERING_ARTIFACT_DIR) await page.locator('.composer-region').screenshot({ path: require('node:path').join(process.env.AF_RENDERING_ARTIFACT_DIR, 'composer-status-line-795.png') });
  console.log('Composer status line: one line, shared edges, neutral text, blue on-switch tracks, shared toggles and icon buttons passed.');
}
module.exports = { checkComposerRendering, checkPendingQueueHeader, checkComposerStatusLine };
