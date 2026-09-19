const assert = require('node:assert/strict');

async function checkInterviewChoices(page) {
  const emit = async value => {
    await page.evaluate(value => window.postMessage(value, '*'), value);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const capability = { model: true, taskModes: ['direct'] };
  await emit({ type: 'host.initialize', panelId: 'interview', role: 'main', runtimeAvailable: true, capabilities: { submit: capability, send: capability } });
  const table = '| 선택지 | 결정 | 장점 | 단점 |\n|---|---|---|---|\n| 1 | 집 | 조용함 | 고립 |\n| 2 | 사무실 | 협업 | 소음 |\n| 3 | 카페 | 전환 | 비용 |';
  await emit({ type: 'chat.assistant', text: table, phase: 'final', runId: 'comparison' });
  assert.equal(await page.locator('.interview-choice').count(), 0);
  await emit({ type: 'chat.assistant', text: '**질문 [1/5]:** 어디에서 일하시겠습니까?\n\n' + table, phase: 'final', runId: 'question' });
  const choices = page.locator('.interview-choice');
  assert.equal(await choices.count(), 3);
  for (let i = 0; i < 3; i++) assert.equal(await choices.nth(i).isEnabled(), true);
  await page.locator('#prompt').fill('작성 중인 초안');
  await choices.nth(1).focus();
  await page.keyboard.press('Enter');
  const sends = await page.evaluate(() => window.sentMessages.filter(message => message.type === 'chat.send'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, '2');
  assert.deepEqual(sends[0].attachments, []);
  assert.equal(sends[0].execution.goal, false);
  assert.equal(await page.locator('#prompt').inputValue(), '작성 중인 초안');
  for (let i = 0; i < 3; i++) assert.equal(await choices.nth(i).isDisabled(), true);
  assert.equal(await page.locator('.decision-reply').count(), 0);
}

module.exports = { checkInterviewChoices };
