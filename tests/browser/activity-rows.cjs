const assert = require('node:assert/strict');

// Tracking rows: one action per line with its target; raw command, output, diff or summary opens in place.
async function checkActivityRows(page) {
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const emit = async message => {
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
    await settle();
  };
  const row = id => page.locator(`[data-id="${id}"] .act-row`).first();
  // Consecutive rows start their targets in one column, verb, target and result share a baseline,
  // and the failure line starts under the target.
  const alignment = ids => page.evaluate(ids => {
    const baseline = element => {
      // A zero-size inline-block sits on its line's baseline; CSSOM properties pass the webview CSP.
      const probe = document.createElement('span');
      Object.assign(probe.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
      element.prepend(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    return ids.map(id => {
      const wrap = document.querySelector(`[data-id="${id}"] .act-row-wrap`);
      const target = wrap.querySelector('.act-target');
      const lines = ['.act-verb', '.act-target > span', '.act-meta'].map(selector => wrap.querySelector(selector)).filter(Boolean).map(baseline);
      const error = wrap.querySelector('.act-error');
      return { id, targetLeft: target.getBoundingClientRect().left, baselineSpread: Math.max(...lines) - Math.min(...lines),
        errorStart: error ? error.getBoundingClientRect().left + parseFloat(getComputedStyle(error).paddingLeft) : undefined };
    });
  }, ids);
  const assertAligned = async (ids, context) => {
    const rows = await alignment(ids);
    const starts = rows.map(item => item.targetLeft);
    assert.ok(Math.max(...starts) - Math.min(...starts) <= 1, 'Targets start in one column ' + context + ': ' + starts.join(', '));
    for (const item of rows) {
      assert.ok(item.baselineSpread <= 1, item.id + ' keeps verb, target and result on one baseline ' + context);
      if (item.errorStart !== undefined) assert.ok(Math.abs(item.errorStart - item.targetLeft) <= 1, item.id + ' indents its error to the target ' + context);
    }
  };

  // Fixture rows start folded, one line each, with nothing rendered behind them yet.
  for (const id of ['short', 'long', 'ansi']) {
    assert.equal(await page.locator(`[data-id="${id}"] .act-row`).count(), 1, id + ' is one row');
    assert.equal(await row(id).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator(`[data-id="${id}"] .act-detail`).evaluate(element => element.hidden && element.childElementCount === 0), true,
      'Raw output renders only when opened');
  }
  const lineHeight = await row('short').evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
  assert.ok((await row('long').boundingBox()).height <= lineHeight + 1, 'A multi-line command still occupies one row');
  assert.match(await row('long').locator('.act-target').textContent(), /^echo 0 …$/);

  // Host details: exact target, line window, provider duration; nonzero exit code and one error line on failure.
  await emit({ type: 'run.activity', id: 'rows-read', category: 'tool', phase: 'completed', text: 'claude/Read',
    kind: 'read', target: 'static/js/chat/' + 'nested/'.repeat(30) + 'terminal.js', lineStart: 120, lineEnd: 240, durationMs: 30 });
  await emit({ type: 'run.activity', id: 'rows-search', category: 'tool', phase: 'completed', text: 'claude/Grep',
    kind: 'search', target: 'run.activity', scope: 'static/js', output: 'static/js/chat.js:1508:x\nstatic/js/chat.js:1600:y' });
  await emit({ type: 'run.activity', id: 'rows-failed', category: 'command', phase: 'failed', text: 'npm test -- --test-name-pattern activity',
    exitCode: 1, durationMs: 4200, output: '▶ timeline\n  ✖ groups reads\nAssertionError: expected 1, actual 3\n' });
  await emit({ type: 'run.activity', id: 'rows-legacy', category: 'tool', phase: 'completed', text: 'claude/Glob' });
  for (const width of [795, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    for (const id of ['rows-read', 'rows-search', 'rows-failed']) {
      const geometry = await row(id).evaluate(element => {
        const meta = element.querySelector('.act-meta').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { height: box.height, metaTop: meta.top, top: box.top, metaRight: meta.right, right: box.right,
          lineHeight: parseFloat(getComputedStyle(element).lineHeight) };
      });
      assert.ok(geometry.height <= geometry.lineHeight + 1, id + ' stays one line at ' + width + 'px');
      assert.ok(Math.abs(geometry.metaTop - geometry.top) <= 2 && geometry.metaRight <= geometry.right + 1, id + ' keeps its result column at ' + width + 'px');
      assert.equal(await row(id).locator('.act-meta').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Result values stay visible, without clipping');
    }
    const tail = await row('rows-read').locator('.act-target-tail').evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(tail, true, 'The file name stays readable while the directory shrinks');
    assert.equal(await row('rows-failed').locator('.act-meta').innerText(), width === 795 ? 'exit code 1 · 3 lines of output · 4.2s' : 'exit 1 · 3 lines · 4.2s');
    // Verbs of different lengths ("Read", "Searched", "Test failed", none) still start targets together, in both languages.
    for (const language of ['en', 'ko']) {
      await page.evaluate(value => {
        const control = document.getElementById('ui-language');
        control.value = value;
        control.dispatchEvent(new Event('change'));
      }, language);
      await settle();
      await assertAligned(['rows-read', 'rows-search', 'rows-failed', 'rows-legacy'], language + ' at ' + width + 'px');
      for (const id of ['rows-read', 'rows-search', 'rows-failed']) {
        assert.ok((await row(id).boundingBox()).height <= lineHeight + 1, id + ' stays one line in ' + language + ' at ' + width + 'px');
      }
    }
    await page.evaluate(() => {
      const control = document.getElementById('ui-language');
      control.value = 'auto';
      control.dispatchEvent(new Event('change'));
    });
    await settle();
  }
  await page.setViewportSize({ width: 795, height: 900 });
  assert.equal(await row('rows-read').locator('.act-verb').textContent(), 'Read');
  assert.equal(await row('rows-read').locator('.act-meta').textContent(), 'lines 120–240 · 30ms');
  assert.equal(await row('rows-search').locator('.act-target').textContent(), '"run.activity" in js', 'A search scope shows its last directory');
  const readPath = 'static/js/chat/' + 'nested/'.repeat(30) + 'terminal.js';
  assert.equal(await row('rows-read').locator('.act-target').textContent(), 'terminal.js', 'A read row shows only the file name');
  assert.match(await row('rows-read').getAttribute('aria-label'), new RegExp('^Read, ' + readPath.replace(/[.]/g, '\\.') + ','), 'The accessible name keeps the full path');
  await row('rows-read').click();
  assert.deepEqual(await page.locator('[data-id="rows-read"] .act-detail .act-paths > div').allTextContents(), [readPath], 'The opened row starts with the full path');
  assert.equal(await page.locator('[data-id="rows-read"] .act-detail > :first-child').getAttribute('class'), 'act-paths');
  assert.equal(await page.locator('[data-id="rows-read"] .act-paths').evaluate(element => getComputedStyle(element).userSelect), 'text');
  await row('rows-read').click();
  await row('rows-search').click();
  assert.deepEqual(await page.locator('[data-id="rows-search"] .act-paths > div').allTextContents(), ['static/js'], 'The opened search row shows its full scope');
  await row('rows-search').click();
  // Same names in one group gain the parent directories that tell them apart; several files list names only.
  await emit({ type: 'run.activity', id: 'rows-same-a', category: 'command', phase: 'completed', text: 'cat docs/design-main-chat/README.md' });
  await emit({ type: 'run.activity', id: 'rows-same-b', category: 'command', phase: 'completed', text: 'cat docs/rule-documents/README.md src/a.ts' });
  assert.equal(await row('rows-same-a').locator('.act-target').textContent(), 'design-main-chat/README.md');
  assert.equal(await row('rows-same-b').locator('.act-target').textContent(), 'rule-documents/README.md, a.ts');
  await row('rows-same-b').hover();
  await page.locator('#activity-tooltip').waitFor();
  assert.match(await page.locator('#activity-tooltip').textContent(), /^docs\/rule-documents\/README\.md\nsrc\/a\.ts\n/, 'The tooltip lists full paths');
  await page.mouse.move(0, 0);
  assert.equal(await row('rows-search').locator('.act-meta').textContent(), '2 matches');
  assert.equal(await row('rows-legacy').locator('.act-target').textContent(), 'Glob', 'Saved history without new fields still shows its tool');
  const failed = page.locator('[data-id="rows-failed"] .act-row-wrap');
  assert.equal(await failed.locator('.act-mark').textContent(), '!');
  assert.equal(await failed.locator('.act-verb').textContent(), 'Test failed');
  assert.equal(await failed.locator('.act-meta').innerText(), 'exit code 1 · 3 lines of output · 4.2s');
  assert.equal(await failed.locator('.act-error').textContent(), 'AssertionError: expected 1, actual 3');
  const failedStyle = await failed.evaluate(element => {
    const style = getComputedStyle(element.querySelector('.act-row'));
    return { border: style.borderTopStyle, background: style.backgroundColor };
  });
  assert.deepEqual(failedStyle, { border: 'none', background: 'rgba(0, 0, 0, 0)' }, 'Failures use text color, never borders or fills');
  assert.match(await row('rows-failed').getAttribute('aria-label'), /^Test failed, npm test -- --test-name-pattern activity, exit code 1/);

  // Opening a row renders the existing terminal view in place; closing hides it again.
  await row('rows-failed').click();
  assert.equal(await row('rows-failed').getAttribute('aria-expanded'), 'true');
  assert.equal(await failed.locator('.act-detail .syntax-code').textContent(), 'npm test -- --test-name-pattern activity');
  await row('rows-failed').click();
  assert.equal(await failed.locator('.act-detail').isHidden(), true);

  // Keyboard: arrows move between rows and focus shows the tooltip with start, duration, exit code and the full command.
  await row('rows-search').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await row('rows-failed').evaluate(element => document.activeElement === element), true);
  const tooltip = page.locator('#activity-tooltip');
  await tooltip.waitFor();
  const tip = await tooltip.textContent();
  assert.match(tip, /^Started .+\nTook 4\.2s\nExit code 1\nnpm test -- --test-name-pattern activity$/);
  assert.equal(await row('rows-failed').getAttribute('aria-describedby'), 'activity-tooltip');
  await page.keyboard.press('Escape');
  assert.equal(await tooltip.isHidden(), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await row('rows-search').evaluate(element => document.activeElement === element), true);

  // In progress: present-tense verb, spinner (still under reduced motion) and live elapsed seconds.
  await emit({ type: 'run.state', running: true });
  await emit({ type: 'run.activity', id: 'rows-running', category: 'command', phase: 'started', text: 'node tests/browser/chat-rendering.cjs' });
  assert.equal(await row('rows-running').locator('.act-verb').textContent(), 'Testing');
  const spinner = row('rows-running').locator('.act-mark.is-running');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await spinner.evaluate(element => getComputedStyle(element, '::before').animationName), 'act-spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await spinner.evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.match(await row('rows-running').locator('.act-elapsed').textContent(), /^\d+s$/);

  // Thinking stays at its place in time: "Thinking" while running, "Thought · Ns" after, summary on demand.
  await emit({ type: 'run.activity', id: 'rows-think', category: 'tool', phase: 'started', text: 'Reasoning', kind: 'think' });
  assert.equal(await row('rows-think').locator('.act-verb').textContent(), 'Thinking');
  await emit({ type: 'run.activity', id: 'rows-think', category: 'tool', phase: 'completed', text: 'Reasoning', kind: 'think', summary: '**Plan** compare rows' });
  assert.equal(await row('rows-think').locator('.act-verb').textContent(), 'Thought');
  await row('rows-think').click();
  assert.equal((await page.locator('[data-id="rows-think"] .act-summary').textContent()).trim(), 'Plan compare rows');
  assert.equal(await page.locator('[data-id="rows-think"] .act-summary strong').textContent(), 'Plan');
  await emit({ type: 'run.activity', id: 'rows-running', category: 'command', phase: 'completed', text: 'node tests/browser/chat-rendering.cjs' });
  await emit({ type: 'run.state', running: false });
  assert.equal(await page.locator('#timeline .act-mark.is-running').count(), 0);

  // A failed read followed by JSON used to render only its closing brace in red.
  const readError = 'cat: AGENTS.md: No such file or directory';
  const mixedOutput = readError + '\n{\n  "name": "example"\n}\n';
  await emit({ type: 'run.activity', id: 'rows-mixed-failure', category: 'command', phase: 'failed',
    text: 'cat AGENTS.md package.json', exitCode: 1, durationMs: 0, output: mixedOutput });
  const mixed = page.locator('[data-id="rows-mixed-failure"]');
  assert.equal(await mixed.locator('.act-error').textContent(), readError);
  for (const width of [733, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await settle();
    await assertAligned(['rows-mixed-failure'], 'mixed read failure at ' + width + 'px');
    assert.ok((await row('rows-mixed-failure').boundingBox()).height <= lineHeight + 1);
  }
  await row('rows-mixed-failure').click();
  assert.equal(await mixed.locator('.terminal-output-preview').textContent(), mixedOutput);
  await row('rows-mixed-failure').click();
  await emit({ type: 'run.activity', id: 'rows-brace-failure', category: 'command', phase: 'failed',
    text: 'cat package.json', exitCode: 1, output: '{\n  "name": "example"\n}' });
  assert.equal(await page.locator('[data-id="rows-brace-failure"] .act-error').count(), 0);
  assert.match(await row('rows-brace-failure').locator('.act-meta').textContent(), /exit (?:code )?1/);
}

module.exports = { checkActivityRows };
