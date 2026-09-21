const assert = require('node:assert/strict');

async function checkBotTalk(page) {
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  await emit({ type: 'host.initialize', botsEnabled: true, runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await emit({ type: 'run.state', running: false });
  const bot = page.locator('#factory-bot'), talk = page.locator('#bot-talk');
  const prompt = page.locator('#prompt'), speech = page.locator('#bot-speech');
  const sent = () => page.evaluate(() => window.sentMessages.filter(message => message.type === 'bot.talk'));
  await prompt.fill(''); await bot.click(); assert.equal(await talk.isDisabled(), true);
  await page.keyboard.press('Escape');
  const begin = async text => {
    await prompt.fill(text); await bot.click(); await talk.click();
    return (await sent()).at(-1);
  };
  const request = await begin('안녕하세요, 봇!');
  assert.deepEqual(Object.keys(request).sort(), ['requestId', 'text', 'type']);
  assert.equal(request.text, '안녕하세요, 봇!');
  assert.equal(await prompt.inputValue(), request.text);
  assert.match(await page.locator('#bot-speech-text').innerText(), /Thinking|생각/);
  await talk.evaluate(el => el.click()); assert.equal((await sent()).length, 1);
  await emit({ type: 'bot.reply', requestId: 'stale', text: 'Wrong response' });
  assert.notEqual(await page.locator('#bot-speech-text').innerText(), 'Wrong response');
  const answer = '<img src=x onerror="window.injected=true">\n' + '긴 답변입니다. '.repeat(300);
  await emit({ type: 'bot.reply', requestId: request.requestId, text: answer });
  assert.equal(await prompt.inputValue(), '');
  assert.equal(await page.locator('#bot-speech-text').textContent(), answer);
  assert.equal(await speech.locator('img').count(), 0);
  assert.equal(await page.locator('#bot-speech-expand').isVisible(), true);
  await page.locator('#bot-speech-expand').click();
  assert.equal(await page.locator('#bot-speech-expand').getAttribute('aria-expanded'), 'true');
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 400 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await speech.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 400);
  }
  await page.locator('#bot-speech-close').click();
  const second = await begin('첫 번째 글');
  await prompt.fill('새로 작성한 글');
  await emit({ type: 'bot.reply', requestId: second.requestId, text: '반갑습니다.' });
  assert.equal(await prompt.inputValue(), '새로 작성한 글');
  const third = await begin('다시 시도할 글');
  await emit({ type: 'bot.reply', requestId: third.requestId, failed: true });
  assert.equal(await prompt.inputValue(), third.text);
  assert.match(await page.locator('#bot-speech-text').innerText(), /try again|다시 시도/);
  const fourth = await begin(third.text);
  await prompt.fill('편집'); await prompt.fill(third.text);
  await emit({ type: 'bot.reply', requestId: fourth.requestId, text: '수정한 초안은 유지합니다.' });
  assert.equal(await prompt.inputValue(), third.text);
  assert.equal(await page.locator('#bot-speech').count(), 1);
  const pending = await begin('비활성화 중 응답');
  await emit({ type: 'bots.updated', enabled: false });
  await emit({ type: 'bot.reply', requestId: pending.requestId, text: 'Late reply' });
  assert.equal(await speech.isVisible(), false);
  assert.equal(await prompt.inputValue(), pending.text);
  await emit({ type: 'bots.updated', enabled: true });
  const final = await begin('오늘도 잘 부탁해요');
  await emit({ type: 'bot.reply', requestId: final.requestId, text: '반갑습니다! 오늘도 곁에서 함께하겠습니다.' });
  if (process.env.BOT_TALK_SCREENSHOT) await page.screenshot({ path: process.env.BOT_TALK_SCREENSHOT });
  await page.keyboard.press('Escape');
  assert.equal(await speech.isVisible(), false);
}
module.exports = { checkBotTalk };

async function checkBotPrompt(page) {
  const emit = async data => {
    await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  await emit({ type: 'host.initialize', botsEnabled: true, botPrompt: '기존 프롬프트', runtimeAvailable: true, capabilities: { submit: {}, send: {} } });
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-bot').click();
  const editor = page.locator('#bot-prompt'), save = page.locator('#bot-prompt-save');
  assert.equal(await editor.inputValue(), '기존 프롬프트');
  assert.equal(await save.isDisabled(), true);
  await editor.fill('다정하게 답하세요.\n원문 유지');
  await save.click();
  const latest = () => page.evaluate(() => window.sentMessages.filter(message => message.type === 'bot.prompt.save').at(-1));
  const first = await latest();
  assert.equal(first.prompt, '다정하게 답하세요.\n원문 유지');
  assert.equal(await save.isDisabled(), true);
  await editor.fill('저장 도중 새 편집');
  await emit({ type: 'bots.updated', enabled: true, botPrompt: first.prompt });
  await emit({ type: 'bot.prompt.saved', requestId: first.requestId, prompt: first.prompt });
  assert.equal(await editor.inputValue(), '저장 도중 새 편집');
  assert.equal(await save.isEnabled(), true);
  await save.click(); const second = await latest();
  await emit({ type: 'bot.prompt.saved', requestId: second.requestId, failed: true });
  assert.equal(await editor.inputValue(), second.prompt);
  assert.equal(await save.isEnabled(), true);
  await page.locator('#bot-prompt-reset').click();
  assert.equal(await editor.inputValue(), '');
  await save.click(); const reset = await latest();
  assert.equal(reset.prompt, '');
  await emit({ type: 'bot.prompt.saved', requestId: reset.requestId, prompt: '' });
  assert.equal(await save.isDisabled(), true);
  await emit({ type: 'bots.updated', enabled: true, botPrompt: '다른 창에서 저장한 설정' });
  assert.equal(await editor.inputValue(), '다른 창에서 저장한 설정');
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 700 });
    await editor.scrollIntoViewIfNeeded();
    const box = await editor.boundingBox();
    assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= width);
  }
  if (process.env.BOT_PROMPT_SCREENSHOT) await page.screenshot({ path: process.env.BOT_PROMPT_SCREENSHOT });
}
module.exports.checkBotPrompt = checkBotPrompt;
