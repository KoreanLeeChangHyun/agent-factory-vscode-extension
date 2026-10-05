const assert = require('node:assert/strict');
exports.checkContracts = async page => {
 // The fixture's moved companion would sit over the history button; these checks concern the list only.
 await page.evaluate(() => sessionStorage.setItem('submission-restoration-fixture', JSON.stringify({ botVisible: false })));
 await page.reload();
 const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), data);
 await emit({type:'host.initialize', panelId:'contracts', agentId:'main-test', role:'main', runtimeAvailable:true, capabilities:{submit:{},send:{}}});
 assert.equal(await page.locator('#submission-menu #contract-list').count(), 0);
 if (await page.locator('#workflow-history-toggle').isVisible()) await page.locator('#workflow-history-toggle').click();
 // Contracts are a tab of the one task history disclosure; there is no separate contract button.
 assert.equal(await page.locator('#contract-list').count(), 0);
 assert.equal(await page.locator('#workflow-history-items > details').count(), 1);
 await page.locator('#task-history > summary').click();
 await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'project.tasks.request'));
 assert.equal(await page.locator('#history-tab-tasks').getAttribute('aria-selected'), 'true');
 assert.equal(await page.locator('#contract-list-list').isHidden(), true);
 await page.locator('#history-tab-tasks').focus();
 await page.keyboard.press('ArrowRight');
 assert.equal(await page.locator('#history-tab-contracts').getAttribute('aria-selected'), 'true');
 assert.equal(await page.evaluate(() => document.activeElement.id), 'history-tab-contracts');
 assert.equal(await page.locator('#task-history-panel').isHidden(), true);
 await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'contracts.request'));
 const frame = await page.locator('#task-history-list').boundingBox();
 await emit({type:'contracts.list', contracts:[{id:'WC-1',version:'1',title:'<b>Contract</b>',href:'file:///tmp/contract-v1.md'}]});
 const entry = page.locator('#contract-list-list button');
 assert.equal(await entry.locator('.contract-list-title').textContent(), '<b>Contract</b>');
 assert.equal(await entry.locator('.contract-list-metadata').textContent(), 'WC-1 · v1');
 assert.equal(await entry.locator('b').count(), 0);
 // Task briefs bound to a long-term contract are counted on it.
 await emit({type:'project.tasks', entries:[{id:'brief-1',title:'Bound brief',status:'completed',mainAgentId:'main-other',contract:{id:'WC-1',version:1},tasks:[{id:'t1',title:'T1',workStatus:'completed'}]}]});
 await page.waitForFunction(() => /^WC-1 · v1 · \D*1\D*$/.test(document.querySelector('#contract-list-list .contract-list-metadata')?.textContent || ''));
 assert.deepEqual(await page.locator('#task-history-list').boundingBox(), frame, 'Switching tabs keeps the same frame');
 await entry.click();
 assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'contract.open');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#task-history').evaluate(el => el.open), false);
 await page.locator('#task-history > summary').click();
 assert.equal(await page.locator('#history-tab-contracts').getAttribute('aria-selected'), 'true', 'The last tab is kept');
 for (const width of [1000, 440]) {
  await page.setViewportSize({width,height:800});
  await page.waitForTimeout(100);
  if (await page.locator('#workflow-history-toggle').isVisible() && !await page.locator('#workflow-history').evaluate(el => el.classList.contains('is-open'))) await page.locator('#workflow-history-toggle').click();
  if (!await page.locator('#task-history').evaluate(el => el.open)) await page.locator('#task-history > summary').click();
  await emit({type:'contracts.list', contracts:[1,2].map(i=>({id:'WC-20260927-DOCUMENT-STRUCTURE-'+i,version:'5',title:'회귀 검사 복구 및 범위 외 변경 기록 계약 '+i}))});
  const dimensions = await page.locator('#contract-list-list').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,height:e.getBoundingClientRect().height}));
  assert.ok(dimensions.scroll <= dimensions.width, 'long contract names fit horizontally');
  if (await page.locator('#task-history-list').evaluate(e=>e.classList.contains('is-flyout'))) {
   const list = await page.locator('#task-history-list').boundingBox();
   assert.ok(list.x >= 0 && list.x + list.width <= width && list.y >= 0 && list.y + list.height <= 800, 'List fits viewport');
  }
  if (process.env.AF_HISTORY_ARTIFACT_DIR) {
   const path = require('node:path');
   await emit({type:'contracts.list', contracts:[1,2].map(i=>({id:'WC-20260927-DOCUMENT-STRUCTURE-'+i,version:'5',title:'회귀 검사 복구 및 범위 외 변경 기록 계약 '+i}))});
   await page.locator('#contract-list-list .contract-list-entry').first().waitFor();
   await page.screenshot({path: path.join(process.env.AF_HISTORY_ARTIFACT_DIR, 'history-tabs-contracts-' + width + '.png')});
   await emit({type:'project.tasks', entries:[
    {id:'brief-a',title:'작업 현황 패널 테두리 통일',status:'completed',mainAgentId:'main-other',contract:{id:'WC-20260927-DOCUMENT-STRUCTURE-1',version:5},tasks:[{id:'t1',title:'테두리 통일',description:'작업 현황 패널과 작성기 테두리를 같은 값으로 맞춥니다.',workStatus:'completed'}]},
    {id:'brief-b',title:'작업 흐름 헤더 다듬기',status:'runtime-error',mainAgentId:'main-other',tasks:[{id:'t2',title:'헤더 표시',workStatus:'failed'}]}]});
   await page.locator('#history-tab-tasks').click();
   await page.locator('#task-history-panel .project-history-entry').first().waitFor();
   await page.screenshot({path: path.join(process.env.AF_HISTORY_ARTIFACT_DIR, 'history-tabs-tasks-' + width + '.png')});
   await page.locator('#history-tab-contracts').click();
  }
 }
 await emit({type:'contracts.list',contracts:[],error:'read error'});
 assert.match(await page.locator('#contract-list-list').textContent(), /Could not load/);
};
