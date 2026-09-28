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
  const reaction = page.locator('#companion-reaction');
  let reactionSequence = 0;
  const react = () => emit({ type: 'bot.companion', working: 0, outcomeUntil: 0, companion: {
    emotion: 'happy', action: 'call', reactionUntil: Date.now() + 60000 + (++reactionSequence * 1000),
    lastInteractionAt: Date.now(), fullness: 80, happiness: 80, energy: 80, careCount: 0, updatedAt: Date.now()
  } });
  await react();
  assert.equal(await reaction.isVisible(), true);
  await prompt.fill('줄바꿈');
  await prompt.press('Shift+Enter');
  assert.equal((await sent()).length, 0, 'Shift+Enter does not talk to the bot');
  assert.ok((await prompt.inputValue()).includes('\n'), 'Shift+Enter remains a newline');
  await prompt.fill('안녕하세요, 봇!');
  const sleeping = { emotion: 'sleepy', action: 'sleep', reactionUntil: Date.now() + 5000,
    lastInteractionAt: Date.now() - 70000, fullness: 80, happiness: 80, energy: 80, careCount: 0, updatedAt: Date.now() };
  await emit({ type: 'bot.companion', companion: sleeping, working: 0 });
  assert.equal(await bot.getAttribute('data-emotion'), 'sleepy');
  const submissions = await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').length);
  await prompt.press('Control+Shift+Enter');
  const request = (await sent()).at(-1);
  await emit({ type: 'bot.reply.partial', requestId: request.requestId, text: '첫 글자' });
  assert.equal(await page.locator('#bot-speech-text').textContent(), '첫 글자');
  await emit({ type: 'bot.reply.partial', requestId: 'stale', text: 'Wrong' });
  assert.equal(await page.locator('#bot-speech-text').textContent(), '첫 글자');
  await emit({ type: 'bot.reply.partial', requestId: request.requestId, text: 'Thinking…' });

  assert.equal(await page.evaluate(() => window.sentMessages.filter(m => m.type === 'chat.send').length), submissions);
  assert.equal(await speech.isVisible(), true);
  assert.notEqual(await bot.getAttribute('data-emotion'), 'sleepy', 'Talking wakes the sleeping visual immediately');
  await emit({ type: 'bot.companion', companion: sleeping, working: 0 });
  assert.notEqual(await bot.getAttribute('data-emotion'), 'sleepy', 'A stale sleep snapshot cannot put a talking bot back to sleep');
  assert.equal(await prompt.evaluate(el => document.activeElement === el), true, 'Talk shortcut keeps composer focus');
  const placement = await page.evaluate(() => {
    const bot = document.querySelector('#factory-bot').getBoundingClientRect();
    const speech = document.querySelector('#bot-speech').getBoundingClientRect();
    return { above: speech.bottom <= bot.top - 7, aboveInput: speech.bottom <= bot.bottom + 1 };
  });
  assert.ok(placement.above && placement.aboveInput, 'Thinking sits above the character');
  assert.match(await page.locator('#bot-talk-shortcut-row').textContent(), /Shift/);

  assert.equal(await reaction.isVisible(), false, 'Thinking replaces the greeting');
  await react();
  assert.equal(await reaction.isVisible(), false, 'Late shared reactions cannot duplicate thinking');
  await page.locator('#bot-speech-close').click();
  await react();
  assert.equal(await reaction.isVisible(), false, 'Closing thinking does not expose greetings while the request is pending');
  assert.deepEqual(Object.keys(request).sort(), ['requestId', 'text', 'type']);
  assert.equal(request.text, '안녕하세요, 봇!');
  assert.equal(await prompt.inputValue(), "", "Submitting clears the composer before the reply");
  assert.match(await page.locator('#bot-speech-text').innerText(), /Thinking|생각/);
  await talk.evaluate(el => el.click()); assert.equal((await sent()).length, 1);
  await emit({ type: 'bot.reply', requestId: 'stale', text: 'Wrong response' });
  assert.notEqual(await page.locator('#bot-speech-text').innerText(), 'Wrong response');
  const answer = '<img src=x onerror="window.injected=true">\n' + '긴 답변입니다. '.repeat(300);
  await emit({ type: 'bot.reply', requestId: request.requestId, text: answer, emotion: 'shy' });
  assert.equal(await prompt.inputValue(), '');
  await react();
  assert.equal(await reaction.isVisible(), false, 'Answer has priority over reactions');
  assert.equal(await page.locator('#bot-speech-text').textContent(), answer);
  assert.equal(await speech.locator('img').count(), 0);
  assert.equal(await bot.getAttribute('data-emotion'), 'shy', 'Reply emotion controls the character expression');
  assert.equal(await page.locator('.companion-sprite').getAttribute('data-sheet'), 'emotions');
  await emit({ type: 'bot.companion', companion: { ...sleeping, reactionUntil: 0 }, working: 0 });
  assert.notEqual(await bot.getAttribute('data-emotion'), 'sleepy', 'The bot stays awake while its reply is visible');
  assert.equal(await page.locator('#bot-speech-expand').count(), 0);
  assert.equal(await page.locator('#bot-speech-text').evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  }), true, 'Long answers can be read through to the end without expanding');
  for (const width of [360, 795]) {
    await page.setViewportSize({ width, height: 400 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await speech.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 400);
  }
  await page.locator('#bot-speech-close').click();
  assert.equal(await reaction.isVisible(), false, 'Closing does not resurrect an old greeting');
  await react();
  assert.equal(await reaction.isVisible(), true, 'A new interaction can speak after closing');
  const second = await begin('첫 번째 글');
  await prompt.fill('새로 작성한 글');
  await emit({ type: 'bot.reply', requestId: second.requestId, text: '반갑습니다.' });
  assert.equal(await prompt.inputValue(), '새로 작성한 글');
  const same = await begin('같은 내용');
  await prompt.fill('같은 내용');
  await emit({ type: 'bot.reply', requestId: same.requestId, text: '완료' });
  assert.equal(await prompt.inputValue(), '같은 내용', 'Reply cannot erase an identical newly typed draft');
  const failedWithDraft = await begin('실패할 요청');
  await prompt.fill('새 초안');
  await emit({ type: 'bot.reply', requestId: failedWithDraft.requestId, failed: true });
  assert.equal(await prompt.inputValue(), '새 초안', 'Failure cannot overwrite a new draft');
  const third = await begin('다시 시도할 글');
  await emit({ type: 'bot.reply', requestId: third.requestId, failed: true });
  assert.equal(await prompt.inputValue(), third.text);
  assert.match(await page.locator('#bot-speech-text').innerText(), /try again|다시 시도/);
  await react();
  assert.equal(await reaction.isVisible(), false, 'Failure reply is also the only speech surface');
  const fourth = await begin(third.text);
  await prompt.fill('편집'); await prompt.fill(third.text);
  await emit({ type: 'bot.reply', requestId: fourth.requestId, text: '수정한 초안은 유지합니다.' });
  assert.equal(await prompt.inputValue(), third.text);
  assert.equal(await page.locator('#bot-speech').count(), 1);
  const pending = await begin('비활성화 중 응답');
  await emit({ type: 'bots.updated', enabled: false });
  await emit({ type: 'bot.reply', requestId: pending.requestId, text: 'Late reply' });
  assert.equal(await speech.isVisible(), false);
  assert.equal(await prompt.inputValue(), "");
  await emit({ type: 'bots.updated', enabled: true });
  const final = await begin('오늘도 잘 부탁해요');
  await emit({ type: 'bot.reply', requestId: final.requestId, text: '반갑습니다! 오늘도 곁에서 함께하겠습니다.' });
  if (process.env.BOT_TALK_SCREENSHOT) await page.screenshot({ path: process.env.BOT_TALK_SCREENSHOT });
  await page.keyboard.press('Escape');
  assert.equal(await speech.isVisible(), false);
  for (const character of ['lumi', 'factory']) {
    await emit({ type: 'bots.updated', enabled: true, botCharacter: character, localCompanionAvailable: true });
    await prompt.fill('Keep my draft');
    const before = (await sent()).length;
    await bot.click();
    await page.locator('[data-bot-action="play"]').click();
    const game = (await sent()).at(-1);
    assert.equal((await sent()).length, before + 1, character + ' starts a conversation game');
    assert.match(game.text, /quiz|퀴즈/);
    assert.match(game.text, /word chain|끝말잇기/);
    assert.equal(await prompt.inputValue(), 'Keep my draft');
    assert.equal(await prompt.evaluate(el => document.activeElement === el), true);
    await bot.click();
    await page.locator('[data-bot-action="play"]').click();
    assert.equal((await sent()).length, before + 1, 'Repeated play cannot start overlapping games');
    await page.keyboard.press('Escape');
    await emit({ type: 'bot.reply', requestId: game.requestId, text: 'Name a fruit beginning with A.', emotion: 'playful' });
    await prompt.fill('Apple');
    await prompt.press('Control+Shift+Enter');
    const answer = (await sent()).at(-1);
    assert.equal(answer.text, 'Apple', 'Game continues through the ordinary bot conversation');
    await emit({ type: 'bot.reply', requestId: answer.requestId, text: 'Correct!', emotion: 'happy' });
    await page.locator('#bot-speech-close').click();
    await bot.click();
    await page.locator('[data-bot-action="play"]').click();
    const failure = (await sent()).at(-1);
    await emit({ type: 'bot.reply', requestId: failure.requestId, failed: true });
    assert.equal(await prompt.inputValue(), '', 'Failed game start never inserts its generated instructions into the draft');
    await page.locator('#bot-speech-close').click();
  }
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-keyboard').click();
  assert.equal(await page.locator('#bot-talk-shortcut-row').isVisible(), true);
  for (const [action, keys] of [['botMenu', 'Alt+Shift+B'], ['botPet', 'Alt+Shift+J']]) {
    await page.locator('[data-shortcut-action="' + action + '"] .shortcut-change').click();
    await page.keyboard.press(keys);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#shortcut-' + action).getAttribute('data-binding'), keys);
  }
  await page.keyboard.press('Escape');
  await prompt.focus();
  await page.keyboard.press('Alt+Shift+B');
  assert.equal(await page.locator('#bot-menu').isVisible(), true, 'Menu shortcut opens the bot menu');
  await page.keyboard.press('Alt+Shift+B');
  assert.equal(await page.locator('#bot-menu').isVisible(), false, 'Menu shortcut closes the bot menu');
  await prompt.focus();
  const interactions = () => page.evaluate(() => window.sentMessages.filter(m => m.type === 'bot.interact').length);
  const gestureBefore = await interactions();
  await page.keyboard.press('Alt+Shift+J');
  assert.ok(await interactions() > gestureBefore || await bot.getAttribute('data-gesture') === 'shy', 'Pet shortcut runs the bot action');
  assert.equal(await prompt.evaluate(el => document.activeElement === el), true, 'Action shortcuts keep composer focus');
  await page.locator('#status-settings-button').click();
  await page.locator('#settings-tab-keyboard').click();
  await emit({ type: 'host.initialize', botsEnabled: false, botsAvailable: false, runtimeAvailable: true });
  assert.equal(await page.locator('#bot-talk-shortcut-row').isVisible(), false, 'Release build hides unavailable bot shortcut');

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
