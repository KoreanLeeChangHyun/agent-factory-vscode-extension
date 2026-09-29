import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from '../support/import-typescript.mjs';

const deploy = await importTypeScript('src/infrastructure/github/deploy-workflows.ts');
const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');

const RELEASE = `name: Joint release
on:
  workflow_dispatch:
    inputs:
      version:
        description: "Release version (X.Y.Z)"
        required: true
        type: string
      channel:
        type: choice
        options:
          - stable
          - 'beta' # comment
      execute:
        description: Publish
        default: false
        type: boolean
jobs:
  release:
    env:
      GH_TOKEN: \${{ secrets.RELEASE_TOKEN }}
      OTHER: \${{ secrets.GITHUB_TOKEN }}
`;

test('parses workflow_dispatch inputs in block, list and scalar forms', () => {
  assert.deepEqual(deploy.parseDispatchInputs(RELEASE), [
    { name: 'version', type: 'string', description: 'Release version (X.Y.Z)', required: true },
    { name: 'channel', type: 'choice', description: '', required: false, options: ['stable', 'beta'] },
    { name: 'execute', type: 'boolean', description: 'Publish', required: false, default: 'false' }
  ]);
  assert.deepEqual(deploy.parseDispatchInputs('on: [push, workflow_dispatch]\n'), []);
  assert.deepEqual(deploy.parseDispatchInputs('on:\n  - workflow_dispatch\n'), []);
  assert.deepEqual(deploy.parseDispatchInputs('"on":\n  workflow_dispatch:\n'), []);
  assert.equal(deploy.parseDispatchInputs('on:\n  push:\n    branches: [main]\n'), undefined);
  assert.equal(deploy.parseDispatchInputs('on: push\n'), undefined);
  assert.equal(deploy.parseDispatchInputs('name: none\n'), undefined);
});

const workflow = { id: 7, name: 'Joint release', path: '.github/workflows/release.yml', missingSecrets: [], inputs: [
  { name: 'version', type: 'string', description: '', required: true, suggestion: '1.0.21' },
  { name: 'channel', type: 'choice', description: '', required: false, options: ['stable', 'beta'] },
  { name: 'execute', type: 'boolean', description: '', required: false, default: 'false' }
] };

test('validates only declared inputs with their declared types', () => {
  assert.deepEqual(deploy.validateDeployInputs(workflow, { version: ' 1.0.21 ', channel: 'beta', execute: true }),
    { version: '1.0.21', channel: 'beta', execute: 'true' });
  assert.deepEqual(deploy.validateDeployInputs(workflow, { version: '1.0.21' }), { version: '1.0.21' });
  for (const values of [{}, { version: 'next' }, { version: '1.0.21', other: 'x' }, { version: '1.0.21', channel: 'nightly' },
    { version: '1.0.21', execute: 'true' }, { version: '1.0.21\u0001' }]) {
    assert.throws(() => deploy.validateDeployInputs(workflow, values), deploy.DeployError, JSON.stringify(values));
  }
});

test('detects dispatchable workflows and suggests the next project version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'af-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await mkdir(join(root, 'extension'));
  await writeFile(join(root, '.github/workflows/release.yml'), RELEASE);
  await writeFile(join(root, 'extension/package.json'), JSON.stringify({ version: '1.0.20' }));
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' } });
    if (args[0] === 'workflow') return JSON.stringify([
      { id: 7, name: 'Joint release', path: '.github/workflows/release.yml', state: 'active' },
      { id: 8, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { id: 9, name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
      { id: 10, name: 'Dependency Graph', path: 'dynamic/dependabot', state: 'active' }
    ]);
    if (args[0] === 'secret') return JSON.stringify([{ name: 'UNRELATED' }]);
    if (args[0] === 'api') return Buffer.from('on:\n  push:\n').toString('base64');
    throw new Error('unexpected ' + args.join(' '));
  };
  const target = await deploy.detectDeployTarget(root, gh);
  assert.equal(target.repository, 'owner/repo');
  assert.equal(target.ref, 'main');
  assert.deepEqual(target.workflows.map(w => w.id), [7]);
  assert.equal(target.workflows[0].inputs[0].suggestion, '1.0.21');
  assert.equal(target.workflows[0].inputs[1].suggestion, undefined);
  assert.deepEqual(target.workflows[0].missingSecrets, ['RELEASE_TOKEN']);
  assert.ok(calls.some(call => call.includes('contents/.github/workflows/ci.yml')), 'remote copy read when not checked out');
});

test('reports missing gh and non-GitHub projects distinctly', async () => {
  await assert.rejects(deploy.detectDeployTarget('/tmp', async () => { throw new deploy.DeployError('gh-missing', 'no gh'); }), { code: 'gh-missing' });
  await assert.rejects(deploy.detectDeployTarget('/tmp', async () => { throw new Error('no git remotes'); }), { code: 'not-github' });
});

test('dispatches only a detected workflow and finds its new run', async () => {
  const target = { repository: 'owner/repo', ref: 'main', workflows: [workflow] };
  const calls = [];
  let listed = 0;
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'workflow') return '';
    listed++;
    return JSON.stringify(listed < 2 ? [{ databaseId: 1, url: 'u1', status: 'completed', conclusion: 'success', createdAt: '2026-09-29T00:00:00Z' }]
      : [{ databaseId: 2, url: 'https://github.com/owner/repo/actions/runs/2', status: 'queued', createdAt: '2026-09-30T00:00:05Z' }]);
  };
  const now = () => Date.parse('2026-09-30T00:00:00Z');
  const run = await deploy.dispatchDeploy('/tmp', target, 7, { version: '1.0.21', execute: false }, gh, async () => {}, now);
  assert.deepEqual(calls[0], ['workflow', 'run', '7', '-R', 'owner/repo', '--ref', 'main', '-f', 'version=1.0.21', '-f', 'execute=false']);
  assert.deepEqual(run, { id: 2, url: 'https://github.com/owner/repo/actions/runs/2', workflow: 'Joint release', status: 'queued' });
  await assert.rejects(deploy.dispatchDeploy('/tmp', target, 99, {}, gh, async () => {}, now), { code: 'unknown-workflow' });
  await assert.rejects(deploy.dispatchDeploy('/tmp', target, 7, {}, gh, async () => {}, now), { code: 'invalid-input' });
});

test('deploy messages are allowlisted and bounded', () => {
  assert.deepEqual(parseClientMessage({ type: 'deploy.detect', path: '/x' }), { type: 'deploy.detect' });
  assert.deepEqual(parseClientMessage({ type: 'deploy.run', workflowId: 7, inputs: { version: '1.0.21', execute: true } }),
    { type: 'deploy.run', workflowId: 7, inputs: { version: '1.0.21', execute: true } });
  for (const bad of [{ workflowId: '7', inputs: {} }, { workflowId: 0, inputs: {} }, { workflowId: 7 }, { workflowId: 7, inputs: { 'a b': 'x' } },
    { workflowId: 7, inputs: { v: 1 } }, { workflowId: 7, inputs: { v: 'x'.repeat(1001) } }]) {
    assert.equal(parseClientMessage({ type: 'deploy.run', ...bad }), undefined, JSON.stringify(bad));
  }
});

test('workflow secrets exclude GITHUB_TOKEN and unknown listings report nothing missing', async () => {
  assert.deepEqual(deploy.workflowSecrets(RELEASE), ['RELEASE_TOKEN']);
});

test('token setup stores the gh token through stdin or asks for sign-in', async () => {
  const written = [];
  await deploy.setupDeploySecret('/tmp', 'owner/repo', 'RELEASE_TOKEN', async () => 'gho_x\n', async (...args) => { written.push(args); });
  assert.deepEqual(written, [['owner/repo', 'RELEASE_TOKEN', 'gho_x', '/tmp']]);
  await assert.rejects(deploy.setupDeploySecret('/tmp', 'owner/repo', 'RELEASE_TOKEN', async () => { throw new Error('not logged in'); }, async () => {}), { code: 'auth-required' });
  await assert.rejects(deploy.setupDeploySecret('/tmp', 'owner/repo', 'GITHUB_TOKEN', async () => 'x', async () => {}), { code: 'invalid-input' });
  assert.deepEqual(parseClientMessage({ type: 'deploy.token', secret: 'RELEASE_TOKEN', value: 'leak' }), { type: 'deploy.token', secret: 'RELEASE_TOKEN' });
  assert.equal(parseClientMessage({ type: 'deploy.token', secret: 'a b' }), undefined);
});
