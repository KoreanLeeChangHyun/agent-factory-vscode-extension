import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from '../support/release-fixture.mjs';

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
