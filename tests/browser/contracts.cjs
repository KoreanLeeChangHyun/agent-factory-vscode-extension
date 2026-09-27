const assert = require('node:assert/strict');
exports.checkContracts = async page => {
 const emit = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), data);
 await emit({type:'host.initialize', panelId:'contracts', agentId:'main-test', role:'main', runtimeAvailable:true, capabilities:{submit:{},send:{}}});
 await page.locator('#submission-button').click();
 assert.equal(await page.locator('#contract-list').evaluate(el => el.nextElementSibling.id), 'task-history');
 await page.locator('#contract-list > summary').click();
 await page.waitForFunction(() => window.sentMessages.some(m => m.type === 'contracts.request'));
 await emit({type:'contracts.list', contracts:[{id:'WC-1',version:'1',title:'<b>Contract</b>',href:'file:///tmp/contract-v1.md'}]});
 const entry = page.locator('#contract-list-list button');
 assert.equal(await entry.locator('.contract-list-title').textContent(), '<b>Contract</b>');
 assert.equal(await entry.locator('.contract-list-metadata').textContent(), 'WC-1 · v1');
 assert.equal(await entry.locator('b').count(), 0);
 await entry.click();
 assert.equal(await page.evaluate(() => window.sentMessages.at(-1).type), 'contract.open');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#contract-list').evaluate(el => el.open), false);
 await page.locator('#contract-list > summary').click();
 for (const width of [1000, 440]) {
  await page.setViewportSize({width,height:800});
  await emit({type:'contracts.list', contracts:[1,2].map(i=>({id:'WC-20260927-DOCUMENT-STRUCTURE-'+i,version:'5',title:'회귀 검사 복구 및 범위 외 변경 기록 계약 '+i}))});
  const dimensions = await page.locator('#contract-list-list').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,height:e.getBoundingClientRect().height}));
  assert.ok(dimensions.scroll <= dimensions.width, 'long contract names fit horizontally');
  if (await page.locator('#contract-list-list').evaluate(e=>e.classList.contains('is-flyout'))) {
   const menu = await page.locator('#submission-menu').boundingBox();
   const list = await page.locator('#contract-list-list').boundingBox();
   assert.ok(Math.abs(list.y - menu.y) < 1, 'flyout top aligns with parent menu');
   assert.ok(Math.abs(list.height - menu.height) < 1, 'flyout retains the full parent menu height');
  }
 }
 await emit({type:'contracts.list',contracts:[],error:'read error'});
 assert.match(await page.locator('#contract-list-list').textContent(), /Could not load/);
};
