import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function fixture(t, { trackedSettings = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'release-playwright-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  mkdirSync(root); mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete env.VSCE_PAT;
  const command = (exe, args, cwd = root) => {
    const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${exe}: ${r.stderr}\n${r.stdout}`);
    return r.stdout.trim();
  };
  command('git', ['init', '--bare', path.join(base, 'remote.git')]);
  command('git', ['init', '-b', 'main']);
  command('git', ['config', 'user.email', 'release-test@example.invalid']);
  command('git', ['config', 'user.name', 'Release Test']);
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'node_modules/@vscode/vsce'), { recursive: true });
  copyFileSync(new URL('../../scripts/release.mjs', import.meta.url), path.join(root, 'scripts/release.mjs'));
  writeFileSync(path.join(root, 'scripts/node-file-polyfill.cjs'), '');
  writeFileSync(path.join(root, 'node_modules/@vscode/vsce/vsce'), `const fs = require('fs'); const args = process.argv.slice(2); if(args[0] !== 'package') throw Error('Unexpected VSCE publication/token use'); fs.writeFileSync(args[args.indexOf('--out')+1], 'fixed-vsix');`);
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nreleases/\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sample', publisher: 'sample-publisher', version: '1.0.0' }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  if (trackedSettings) {
    mkdirSync(path.join(root, '.vscode'));
    writeFileSync(path.join(root, '.vscode/settings.json'), '{"agentFactory.mainChat.statusItems":["status"]}\n');
  }
  command('git', ['add', '.']); command('git', ['commit', '-m', 'fixture']);
  command('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  command('git', ['push', '-u', 'origin', 'main']);
  const release = (...args) => spawnSync(process.execPath, ['scripts/release.mjs', ...args], { cwd: root, env, encoding: 'utf8' });
  const state = () => JSON.parse(readFileSync(path.join(root, '.git/agent-factory-release.json'), 'utf8'));
  return { root, release, state, command };
}

