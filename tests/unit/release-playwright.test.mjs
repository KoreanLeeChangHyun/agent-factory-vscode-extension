import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
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
  command('git', ['add', '.']); command('git', ['commit', '-m', 'fixture']);
  command('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  command('git', ['push', '-u', 'origin', 'main']);
  const release = (...args) => spawnSync(process.execPath, ['scripts/release.mjs', ...args], { cwd: root, env, encoding: 'utf8' });
  const state = () => JSON.parse(readFileSync(path.join(root, '.git/agent-factory-release.json'), 'utf8'));
  return { root, release, state, command };
}

test('PAT-free preparation, explicit browser attempt and acceptance preserve exact artifact', t => {
  const f = fixture(t);
  let r = f.release('--message', 'Browser release');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /playwright-marketplace-handoff/);
  const prepared = f.state();
  assert.equal(prepared.stage, 'awaiting-browser');
  assert.equal(prepared.publishVia, 'playwright');
  assert.equal(f.command('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], prepared.commit);
  assert.equal(f.release('--resume', '--published', '--publication-evidence', 'too soon').status, 1);
  assert.equal(f.release('--resume', '--publish-via', 'vsce').status, 1);
  r = f.release('--resume', '--browser-start');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.state().stage, 'publishing');
  assert.equal(f.release('--resume').status, 1); // Uncertain upload must not replay.
  assert.equal(f.release('--resume', '--published').status, 1);
  r = f.release('--resume', '--published', '--publication-evidence', 'https://marketplace.visualstudio.com/manage/publishers/sample-publisher sample 1.0.1 accepted');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.state().stage, 'completed');
  assert.equal(f.state().commit, prepared.commit);
  assert.equal(f.state().sha256, prepared.sha256);
  assert.match(f.state().publicationEvidence.description, /1.0.1 accepted/);
});

test('confirmed retry returns to browser handoff and changed artifact blocks resume', t => {
  const f = fixture(t);
  assert.equal(f.release('--message', 'Browser release').status, 0);
  assert.equal(f.release('--resume', '--browser-start').status, 0);
  assert.equal(f.release('--resume', '--retry-publish').status, 0);
  assert.equal(f.state().stage, 'awaiting-browser');
  writeFileSync(f.state().vsix, 'different-vsix');
  const r = f.release('--resume', '--browser-start');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VSIX has changed/);
  assert.equal(f.state().stage, 'awaiting-browser');
});

test('dry-run is read-only and explicit VSCE still requires credentials', t => {
  const f = fixture(t);
  const before = f.command('git', ['rev-parse', 'HEAD']);
  let r = f.release('--message', 'Browser release', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).publishVia, 'playwright');
  assert.throws(f.state, /ENOENT/);
  r = f.release('--message', 'CLI release', '--publish-via', 'vsce');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VSCE_PAT/);
  assert.equal(f.command('git', ['rev-parse', 'HEAD']), before);
  assert.equal(JSON.parse(readFileSync(path.join(f.root, 'package.json'))).version, '1.0.0');
});
