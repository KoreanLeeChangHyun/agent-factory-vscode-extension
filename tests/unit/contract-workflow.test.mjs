import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';

const { withBusinessMode, BUSINESS_MODES } = await importTypeScript('src/common/types/business-mode.ts');
const { withContractExecutionGuidance } = await importTypeScript('src/modules/chat/task-selection.ts');
const { historyPresentation } = await importTypeScript('src/infrastructure/agent-factory/history-presentation.ts');

test('planning starts a conversation listening phase and preserves its guidance on restore', () => {
  const request = 'I will describe the product';
  const guided = withBusinessMode(request, 'planning');
  assert.match(guided, /ongoing planning listening and organizing phase/);
  assert.match(guided, /ordinary messages without a workflow selection/);
  assert.match(guided, /Listen and concisely organize the substance/);
  assert.match(guided, /When the Human asks for research, investigate/);
  assert.match(guided, /Research or a summary request does not by itself end planning/);
  assert.doesNotMatch(guided, /Reply only with a brief, polite acknowledgment/);
  assert.match(guided, /must not leak to another chat/);
  assert.doesNotMatch(guided, /completion-based Specification promotion/);
  const restored = historyPresentation(guided, 'direct', false);
  assert.equal(restored.text, request);
  assert.equal(restored.submission.businessMode, 'planning');
  assert.equal(restored.submission.taskMode, 'direct');
  assert.equal(restored.submission.guidance, guided.slice(request.length));
  assert.equal(withBusinessMode('One more idea', 'normal'), 'One more idea');
});

test('interview confirmation retains the request and clickable Yes/No continuation guidance', () => {
  const request = 'Discuss the current login flow';
  const guided = withBusinessMode(request, 'interview');
  assert.match(guided, /before proposing an interview/);
  assert.match(guided, /exactly two options whose labels are Yes and No and whose stable values are 1 and 2/);
  assert.match(guided, /Wait for the Human's answer/);
  assert.match(guided, /No \(2\) does not start it/);
  const restored = historyPresentation(guided, 'direct', false);
  assert.equal(restored.text, request);
  assert.equal(restored.submission.businessMode, 'interview');
  assert.equal(restored.submission.guidance, guided.slice(request.length));
});

test('design delegates document layout and synchronization while preserving promotion authority and history', () => {
  const request = 'Design the storage boundary';
  const guided = withBusinessMode(request, 'design');
  assert.match(guided, /Document skill's current document contract/);
  assert.match(guided, /non-authoritative Refined documents \(compatible metadata type: processed\)/);
  assert.match(guided, /Expose only Specification packages to host Skill directories/);
  assert.doesNotMatch(guided, /docs\/processed\/|\.codex\/original\/|\.codex\/processed\//);
  assert.match(guided, /mode selection or Agent completion alone does not accept content/);
  assert.match(guided, /Do not overwrite existing conflicting documents or delete drafts/);
  const restored = historyPresentation(guided, 'direct', false);
  assert.equal(restored.text, request);
  assert.equal(restored.submission.businessMode, 'design');
  assert.equal(restored.submission.guidance, guided.slice(request.length));
  const historical = '\n\n[Workflow guidance for this message only: design]\nOld docs/processed/ guidance\n[End workflow guidance]';
  assert.equal(historyPresentation(request + historical, 'direct', false).submission.guidance, historical);
});

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
      assert.match(guided, /analyze all documents in the current project/);
      assert.match(guided, /Honor an explicit target or constraint first/);
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

test('pipeline guidance creates a dispatchable workflow without dispatching it', () => {
  const guided = withBusinessMode('Set up deploys', 'pipeline');
  assert.ok(BUSINESS_MODES.includes('pipeline'));
  assert.match(guided, /workflow_dispatch/);
  assert.match(guided, /never contain AI co-author trailers/);
  assert.match(guided, /Do not dispatch or publish a release unless the Human separately requests it/);
  assert.match(guided, /Reuse and extend an existing release workflow/);
  const restored = historyPresentation(guided, 'direct', false);
  assert.equal(restored.text, 'Set up deploys');
  assert.equal(restored.submission.businessMode, 'pipeline');
});
