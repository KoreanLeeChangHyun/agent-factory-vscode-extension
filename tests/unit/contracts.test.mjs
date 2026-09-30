import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from '../support/import-typescript.mjs';
const { listContracts } = await importTypeScript('src/infrastructure/filesystem/contracts.ts');
const { withBusinessMode } = await importTypeScript('src/common/types/business-mode.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
test('contracts read disk and refresh versions without execution', async () => {
 const root = await mkdtemp(join(tmpdir(), 'contracts-'));
 try {
  assert.deepEqual(await listContracts(root), []);
  const folder = join(root, 'docs/progress/WC-test');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'contract-v1.md'), '# Contract <one>');
  await writeFile(join(folder, 'progress.md'), '# Not a contract');
  await symlink(join(folder, 'contract-v1.md'), join(folder, 'contract-v9.md'));
  assert.equal((await listContracts(root)).length, 1);
  await writeFile(join(folder, 'contract-v2.md'), '# Revised');
  const entries = await listContracts(root);
  assert.deepEqual(entries.map(x => x.version), ['2', '1']);
  assert.equal(entries[1].title, 'Contract <one>');
  assert.ok(entries[0].href.startsWith('file:'));
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('submission asks for saved contract and chat contents without execution', () => {
 const text = withBusinessMode('prepare', 'contract');
 assert.match(text, /docs\/progress\/<contract-id>\/contract-v<version>\.md/);
 assert.match(text, /display the four contract sections/);
 assert.match(text, /목표, 구조, 작업자 and 순서/);
 assert.match(text, /not implementation, delegation/);
 assert.deepEqual(parseClientMessage({type: 'contracts.request'}), {type: 'contracts.request'});
});

const { readContractDetail, parseOperations } = await importTypeScript('src/infrastructure/filesystem/contract-detail.ts');
test('detail preserves versions, quoted CSV fields and missing evidence', async () => {
 const root = await mkdtemp(join(tmpdir(), 'contract-detail-'));
 try {
  const folder = join(root, 'docs/progress/WC-1');
  await mkdir(folder, {recursive:true});
  await writeFile(join(folder,'contract-v1.md'), '# First\n\n| Task | Work |\n|---|---|\n| T1 | A |');
  await writeFile(join(folder,'contract-v2.md'), '# Second');
  await writeFile(join(folder,'file-operations-v1.csv'), 'task_ids,operation,path\n"T1,T2",modify,"src/a,b.ts"\n');
  const result = await readContractDetail(root,'WC-1');
  assert.equal(result.progress,'');
  assert.deepEqual(result.versions[1].operations,[{task_ids:'T1,T2',operation:'modify',path:'src/a,b.ts'}]);
  assert.deepEqual(result.versions[0].operations,[]);
  await assert.rejects(readContractDetail(root,'../outside'));
  assert.throws(() => parseOperations('path\n"unterminated'));
 } finally {await rm(root,{recursive:true,force:true});}
});

const { contractAgentIds } = await importTypeScript('src/infrastructure/filesystem/contract-agents.ts');
test('agent navigation only accepts actual identities from the bound contract', () => {
 const snapshots = [
  {contract:{id:'WC-1',version:2},parentAgentId:'main-1',workflow:{tasks:[{workAgentId:'work-1',verificationAgentId:'verify-1'},{workAgentId:'work-2'}]}},
  {contract:{id:'WC-other'},parentAgentId:'other-main',workflow:{tasks:[{workAgentId:'other-work'}]}},
  {parentAgentId:'unbound-main'},
 ];
 assert.deepEqual([...contractAgentIds('WC-1',snapshots)],['main-1','work-1','verify-1','work-2']);
 assert.equal(contractAgentIds('missing',snapshots).size,0);
});
