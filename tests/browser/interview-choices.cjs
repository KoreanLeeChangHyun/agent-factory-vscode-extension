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
  for (const heading of ['**질문 [9/10, 추가 확인]:** 알림 조건은?', '**Question [9/10, follow-up]:** Which condition?']) {
    await emit({ type: 'session.bound', agentId: 'interview', conversationId: 'variant-' + heading, reset: true });
    await emit({ type: 'chat.assistant', text: heading + '\n\n조건에 대한 설명입니다.\n\n' + table + '\n\n' + table, phase: 'final', runId: heading });
    assert.equal(await page.locator('.interview-choice').count(), 3, 'Only the designated table gets buttons');
    await page.setViewportSize({ width: 380, height: 720 });
    const header = page.locator('table.interview-options th').first();
    assert.equal(await header.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
    assert.ok((await header.boundingBox()).width >= 50);
  }
  await emit({ type: 'session.bound', agentId: 'interview', conversationId: 'standard', reset: true });
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
  for (const [label, answer] of [['Yes', '1'], ['No', '2']]) {
    const previous = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1));
    await emit({ ...previous, type: 'chat.started' });
    await emit({ type: 'session.bound', agentId: 'interview', conversationId: 'confirmation-' + label, reset: true });
    await emit({ type: 'chat.assistant', text: '로그인 흐름의 요구사항을 확인하는 인터뷰를 제안합니다.\n\n**질문 [1/1]:** 이 범위로 인터뷰를 진행할까요?\n\n| 선택지 | 결정 | 설명 |\n|---|---|---|\n| 1 | Yes | 제안한 인터뷰 시작 |\n| 2 | No | 주제나 범위 수정 |', phase: 'final', runId: 'confirm-' + label });
    assert.equal(await page.locator('.interview-choice').count(), 2);
    await page.locator('.interview-choice').filter({ hasText: label }).click();
    assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').at(-1).text), answer);
    assert.equal(await page.locator('#prompt').inputValue(), '작성 중인 초안');
  }
}

module.exports = { checkInterviewChoices };
