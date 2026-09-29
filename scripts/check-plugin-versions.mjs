#!/usr/bin/env node
// Preflight for `npm run release`: confirm the plugin source and every declared,
// active plugin host already report the same base version on their own
// origin/main before this repository cuts a matching extension release.
//
// This script only reads Git state; it never commits, pushes or modifies any
// repository, and never adds a Co-Authored-By trailer (it makes no commits at
// all). See ../../docs/skills/rule-plugin-development/SKILL.md #3 and
// ../../docs/skills/rule-extension-development/SKILL.md #9 for the rule this
// implements: extension and plugin ship together at one matching base version,
// and this repository confirms the plugin side before releasing.
//
// Usage:
//   node scripts/check-plugin-versions.mjs --version X.Y.Z \
//     --source <path-to-agent-factory-plugin-source-checkout> \
//     --checkout codex=<path> --checkout claude=<path> \
//     [--skip-host antigravity ...]
//
// Every host declared in <source>/distribution/package.json["hosts"] needs
// either a --checkout or an explicit --skip-host (for hosts not active yet,
// e.g. antigravity before its sidecar checkout exists). Exits non-zero on any
// mismatch, missing checkout, dirty tree or unpushed commit.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const fail = (message) => { throw new Error(message); };

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function baseVersion(value) {
  // Strips the plugin's own `+codex.<build>` (or any `+build`) metadata suffix.
  return value.split("+")[0];
}

function requireCleanTrackingRepo(cwd, label) {
  if (!existsSync(cwd)) fail(`${label}: no such directory: ${cwd}`);
  if (path.resolve(git(cwd, "rev-parse", "--show-toplevel")) !== path.resolve(cwd)) fail(`${label}: not a Git repository root: ${cwd}`);
  if (git(cwd, "status", "--porcelain") !== "") fail(`${label}: has uncommitted changes.`);
  if (git(cwd, "branch", "--show-current") !== "main") fail(`${label}: must be on branch main.`);
  let upstream;
  try { upstream = git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}"); }
  catch { fail(`${label}: main must track origin/main.`); }
  if (upstream !== "origin/main") fail(`${label}: main tracks ${upstream}, expected origin/main.`);
  git(cwd, "fetch", "origin", "main");
  if (git(cwd, "rev-parse", "HEAD") !== git(cwd, "rev-parse", "origin/main")) fail(`${label}: local main is not pushed to origin/main.`);
}

function options(argv) {
  const result = { checkouts: {}, skip: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--version") result.version = argv[++i];
    else if (key === "--source") result.source = argv[++i];
    else if (key === "--checkout") {
      const [host, ...rest] = argv[++i].split("=");
      if (!host || !rest.length) fail("--checkout requires host=path.");
      result.checkouts[host] = rest.join("=");
    } else if (key === "--skip-host") result.skip.add(argv[++i]);
    else fail(`Unknown option: ${key}`);
  }
  if (!result.version) fail("Provide --version X.Y.Z.");
  if (!result.source) fail("Provide --source <plugin-source checkout path>.");
  return result;
}

const opts = options(process.argv.slice(2));

requireCleanTrackingRepo(opts.source, "plugin source");
const meta = json(path.join(opts.source, "distribution", "package.json"));
if (meta.version !== opts.version) fail(`plugin source: version is ${meta.version}, expected ${opts.version}.`);
console.log(`plugin source: ${meta.version} OK`);

const declared = Object.keys(meta.hosts);
const missing = declared.filter((host) => !opts.checkouts[host] && !opts.skip.has(host));
if (missing.length) fail(`Missing --checkout or --skip-host for declared host(s): ${missing.join(", ")}`);

for (const host of declared) {
  if (opts.skip.has(host)) { console.log(`${host}: skipped (not active yet)`); continue; }
  const checkout = opts.checkouts[host];
  requireCleanTrackingRepo(checkout, host);
  const provenance = json(path.join(checkout, "DISTRIBUTION.json"));
  if (provenance.host !== host) fail(`${host}: DISTRIBUTION.json declares host ${provenance.host}.`);
  if (baseVersion(provenance.version) !== opts.version) fail(`${host}: version is ${provenance.version}, expected base ${opts.version}.`);
  console.log(`${host}: ${provenance.version} OK`);
}

console.log(`\nAll active components report ${opts.version}. Safe to run: npm run release -- --version ${opts.version} --message '...'`);
