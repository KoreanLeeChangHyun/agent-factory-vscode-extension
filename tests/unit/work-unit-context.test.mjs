import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';
const { workUnitContextText, workUnitBranch } = await importTypeScript('src/infrastructure/vscode/work-unit-context.ts');
test('carry only conversation content from raw, wrapped and JSON messages', () => {
  assert.equal(workUnitContextText('테스트\n[Agent Factory administrator command handoff]\nsecret instructions'), '테스트');
  assert.equal(workUnitContextText('header<agent-factory-request>요구사항\n[Agent Factory administrator command handoff]\ncommands</agent-factory-request>footer'), '요구사항');
  assert.equal(workUnitContextText(JSON.stringify({ resultText: '결정', status: 'completed', resultPath: '/runtime' })), '결정');
  assert.equal(workUnitContextText('These are the current Agent Factory fixed instructions.\nrole only'), '');
  assert.equal(workUnitContextText('Keep `code` and requirements.'), 'Keep `code` and requirements.');
});
test('derive a stable branch from one task name without duplicate suffixes', () => {
  assert.equal(workUnitBranch(' My task '), 'My-task');
  assert.equal(workUnitBranch('로그인 수정 / API'), '로그인-수정-API');
  assert.equal(workUnitBranch('feature..@{x}.lock'), 'feature-x-lock');
  assert.equal(workUnitBranch('***'), 'work');
});
