import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';

const { withBusinessMode, BUSINESS_MODES } = await importTypeScript('src/common/types/business-mode.ts');
const { withContractExecutionGuidance } = await importTypeScript('src/modules/chat/task-selection.ts');
const { historyPresentation } = await importTypeScript('src/infrastructure/agent-factory/history-presentation.ts');

test('contract preparation is restored with its captured guidance and direct route', () => {
  const request = 'Use the current conversation';
  const guided = withBusinessMode(request, 'contract');
  assert.ok(BUSINESS_MODES.includes('contract'));
  assert.match(guided, /contract preparation only, not implementation/);
  assert.match(guided, /minimum questions/);
  const restored = historyPresentation(guided, 'direct', false);
  assert.equal(restored.text, request);
  assert.equal(restored.submission.businessMode, 'contract');
  assert.equal(restored.submission.taskMode, 'direct');
  assert.equal(restored.submission.guidance, guided.slice(request.length));
});

test('contract execution preserves each route and round-trips historical guidance', () => {
  for (const mode of ['work', 'work-verification']) {
    const guidance = withContractExecutionGuidance(mode);
    assert.match(guidance, /exact contract ID, version, selected task IDs and file operations/);
    assert.match(guidance, /before dispatching work/);
    assert.match(guidance, mode === 'work' ? /without separate Verification/ : /Work–Verification loop/);
    const restored = historyPresentation('Execute' + guidance, mode, false);
    assert.equal(restored.text, 'Execute');
    assert.equal(restored.submission.guidance, guidance);
    assert.equal(restored.submission.taskMode, mode);
    assert.equal(restored.submission.businessMode, 'normal');
  }
  for (const mode of ['direct', 'plan', 'verification', 'plan-work', 'plan-work-verification']) {
    assert.equal(withContractExecutionGuidance(mode), '');
  }
});

for (const mode of ['migration', 'lessons']) {
  test(`${mode} preserves the requested target and captured document guidance on restore`, () => {
    const request = 'Apply to the documents discussed above';
    const guided = withBusinessMode(request, mode);
    assert.ok(BUSINESS_MODES.includes(mode));
    assert.match(guided, /Document skill's current document contract/);
    assert.match(guided, /does not change the captured execution route/);
    if (mode === 'migration') {
      assert.match(guided, /do not assume the installed version is latest/);
      assert.match(guided, /preserve their meaning, language, provenance and authority/);
    } else {
      assert.match(guided, /retaining concrete evidence and provenance/);
      assert.match(guided, /Consolidate with existing rules without duplication/);
    }
    const restored = historyPresentation(guided, 'direct', false);
    assert.equal(restored.text, request);
    assert.equal(restored.submission.businessMode, mode);
    assert.equal(restored.submission.taskMode, 'direct');
    assert.equal(restored.submission.guidance, guided.slice(request.length));
  });
}
