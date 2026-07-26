"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const archive = resolve(
  process.argv[2] || "dist/agent-factory-agents-linux-x64.vsix",
);
const binaryEntry =
  "extension/node_modules/@openai/codex-linux-x64/vendor/" +
  "x86_64-unknown-linux-musl/bin/codex";
const listing = run("unzip", ["-Z1", archive]).stdout
  .trim()
  .split(/\r?\n/);

assert.ok(listing.includes("extension/package.json"));
assert.ok(listing.includes("extension/src/codexAdapter.js"));
assert.ok(listing.includes(binaryEntry));
assert.ok(
  listing.every(
    (entry) =>
      !entry.startsWith("extension/test/") &&
      !entry.includes("../web") &&
      !entry.includes("@openai/codex-darwin") &&
      !entry.includes("@openai/codex-win32") &&
      !entry.includes("@openai/codex-linux-arm64"),
  ),
);

const directory = mkdtempSync(join(tmpdir(), "agent-factory-vsix-"));
try {
  run("unzip", ["-q", archive, binaryEntry, "-d", directory]);
  const binary = join(directory, binaryEntry);
  assert.notEqual(statSync(binary).mode & 0o111, 0);
  const version = run(binary, ["--version"]).stdout.trim();
  assert.equal(version, "codex-cli 0.145.0");
  process.stdout.write(
    `${JSON.stringify({
      archive,
      binaryEntry,
      fileCount: listing.length,
      version,
    })}\n`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}
