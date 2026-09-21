import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

async function load(file, mock) {
  const result = await build({ entryPoints: [new URL(`../../src/${file}`, import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: mock ? [{ name: 'vscode', setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
        export const env = globalThis.wslMock.env;
        export const workspace = globalThis.wslMock.workspace;
        export const extensions = globalThis.wslMock.extensions;
        export const Uri = { from: value => value };
        export const commands = globalThis.wslMock.commands;
      ` }));
    } }] : [] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { discoverWslWorkspace } = await load('infrastructure/agent-factory/wsl-discovery.ts');

test('WSL discovery decodes UTF-16, skips failed distributions and passes paths as opaque arguments', async () => {
  const calls = [];
  const path = 'C:\\workspace\\space & $(touch hacked)';
  const target = await discoverWslWorkspace(path, async (exe, args, timeout) => {
    calls.push({ exe, args, timeout });
    if (args[0] === '--list') return Buffer.from('\uFEFFdocker-desktop\r\nDebian\r\nUbuntu\r\n', 'utf16le');
    if (args[1] === 'Debian') throw new Error('timeout');
    return Buffer.from('AGENT_FACTORY_WSL:/custom/c/workspace/space & $(touch hacked)\n');
  }, { SystemRoot: 'D:\\Windows' });
  assert.deepEqual(target, { distribution: 'Ubuntu', path: '/custom/c/workspace/space & $(touch hacked)' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].exe, 'D:\\Windows\\System32\\wsl.exe');
  assert.equal(calls[2].args.at(-1), path);
  assert.ok(!calls[2].args[7].includes(path));
  assert.ok(calls.every(c => c.timeout === 5000));
});

test('missing WSL, no CLI, malformed output and non-local paths cannot trigger an open', async () => {
  assert.equal(await discoverWslWorkspace('C:\\p', async () => { throw new Error('ENOENT'); }), undefined);
  assert.equal(await discoverWslWorkspace('C:\\p', async (_exe, args) => Buffer.from(args[0] === '--list' ? 'Ubuntu\n' : 'warning only')), undefined);
  let calls = 0;
  for (const path of ['relative', '\\\\server\\share', 'C:\\bad\npath']) {
    assert.equal(await discoverWslWorkspace(path, async () => { calls++; return Buffer.alloc(0); }), undefined);
  }
  assert.equal(calls, 0);
});

test('WSL probe finds NVM Codex without shell profiles and checks the mapped folder exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-wsl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
  const helpers = join(root, 'helpers');
  const project = join(root, 'project space');
  for (const dir of [bin, helpers, project]) await mkdir(dir, { recursive: true });
  for (const path of [join(bin, 'node'), join(bin, 'codex')]) {
    await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o755);
  }
  await writeFile(join(root, '.profile'), 'exit 99\n');
  await writeFile(join(helpers, 'wslpath'), '#!/bin/sh\nprintf "%s\\n" "$TEST_PROJECT"\n');
  await chmod(join(helpers, 'wslpath'), 0o755);
  const runner = async (_exe, args) => {
    if (args[0] === '--list') return Buffer.from('Ubuntu\n');
    const { stdout } = await promisify(execFile)('/bin/sh', args.slice(6), {
      env: { HOME: root, PATH: helpers + ':/usr/bin:/bin', TEST_PROJECT: project }, timeout: 5000
    });
    return Buffer.from(stdout);
  };
  assert.deepEqual(await discoverWslWorkspace('C:\\workspace\\wishbone', runner), { distribution: 'Ubuntu', path: project });
  await rm(project, { recursive: true });
  assert.equal(await discoverWslWorkspace('C:\\workspace\\wishbone', runner), undefined);
});

test('Windows handoff opens one remote URI in a new window and refuses remote or multi-root contexts', async () => {
  const calls = [];
  globalThis.wslMock = {
    env: {}, workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: 'C:\\workspace\\wishbone' } }] },
    extensions: { getExtension: () => ({}) },
    commands: { executeCommand: async (...args) => { calls.push(args); } }
  };
  const { openWslWorkspace } = await load('infrastructure/vscode/wsl-workspace.ts', true);
  let probes = 0;
  const discover = async path => { probes++; assert.equal(path, 'C:\\workspace\\wishbone'); return { distribution: 'Ubuntu', path: '/mnt/c/workspace/wishbone' }; };
  assert.equal(await openWslWorkspace(discover, 'win32'), true);
  assert.deepEqual(calls[0], ['vscode.openFolder', { scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/mnt/c/workspace/wishbone' }, { forceNewWindow: true }]);
  assert.equal(await openWslWorkspace(discover, 'linux'), false);
  wslMock.env.remoteName = 'ssh-remote';
  assert.equal(await openWslWorkspace(discover, 'win32'), false);
  delete wslMock.env.remoteName;
  wslMock.workspace.workspaceFile = {};
  assert.equal(await openWslWorkspace(discover, 'win32'), false);
  delete wslMock.workspace.workspaceFile;
  wslMock.workspace.workspaceFolders.push(wslMock.workspace.workspaceFolders[0]);
  assert.equal(await openWslWorkspace(discover, 'win32'), false);
  assert.equal(probes, 1);
  wslMock.workspace.workspaceFolders.pop();
  wslMock.extensions.getExtension = () => undefined;
  await assert.rejects(openWslWorkspace(discover, 'win32'), /Microsoft WSL extension/);
  assert.equal(calls.length, 1);
  wslMock.extensions.getExtension = () => ({});
  wslMock.commands.executeCommand = async () => { throw new Error('open failed'); };
  await assert.rejects(openWslWorkspace(discover, 'win32'), /open failed/);
});
