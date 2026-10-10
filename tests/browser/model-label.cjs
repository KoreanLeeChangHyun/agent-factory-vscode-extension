const assert = require('node:assert/strict');
async function checkModelLabel(page) {
  for(const timeline of [[],[{type:'user',id:'restore-human',text:'Original saved message'}]]) {
    await page.evaluate(timeline=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify({panelId:'model-label',role:'main',model:'gpt-6-astra',reasoning:'high',draft:'Original draft',timeline})),timeline);
    await page.reload();
    await page.waitForTimeout(100);
    const label=await page.locator('#model-label').textContent();
    console.log(JSON.stringify({stage:'restored',timeline:timeline.length,label}));
    assert.equal(label,'gpt-6-astra · high');
    assert.equal(await page.locator('#prompt').inputValue(),'Original draft');
    assert.equal(await page.locator('.prompt-surface').evaluate(el=>el.classList.contains('is-astra')),false);
  }
  const capability={model:true,reasoning:true,fast:true,taskModes:['direct','orchestrate']};
  await page.evaluate(capability=>window.postMessage({type:'host.initialize',panelId:'model-label',role:'main',model:'gpt-5.6-sol',reasoning:'medium',runtimeAvailable:true,capabilities:{submit:capability,send:capability}},'*'),capability);
  await page.waitForFunction(()=>document.getElementById('model-label').textContent==='gpt-5.6-sol · medium');
  await page.evaluate(()=>window.postMessage({type:'models.list',models:['gpt-6-astra','gpt-5.6-sol']},'*'));
  await page.locator('#model-button').click();
  const main=page.locator('#model-menu .agent-model-row[data-agent-role="main"]');
  await main.locator('button[data-field="model"]').click();
  await main.locator('.model-picker-option[data-value="gpt-6-astra"]').click();
  await page.waitForFunction(()=>document.getElementById('model-label').textContent==='gpt-6-astra · medium');
  await main.locator('input[data-field="reasoningEffort"]').fill('3');
  await page.waitForFunction(()=>document.getElementById('model-label').textContent==='gpt-6-astra · high');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.astra-stars, .astra-star').count(),0);
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('model-label').textContent==='gpt-6-astra · high');
  assert.equal(await page.locator('#prompt').inputValue(),'Original draft');
  console.log('Model label: empty/restored chat, Host initialization, model/effort selection, reload, draft preservation and no starfield passed.');
}
module.exports={checkModelLabel};
