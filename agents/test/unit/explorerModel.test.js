"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXCLUDED_ENTRY_NAMES,
  createExplorerEntries,
} = require("../../src/explorerModel");

test("Explorer excludes generated directories and sorts folders before files", () => {
  assert.ok(EXCLUDED_ENTRY_NAMES.has(".git"));
  assert.ok(EXCLUDED_ENTRY_NAMES.has("node_modules"));

  const entries = createExplorerEntries([
    ["zeta.js", 1],
    ["node_modules", 2],
    ["src", 2],
    [".git", 2],
    ["README.md", 1],
    ["docs", 2],
  ]);

  assert.deepEqual(entries, [
    { name: "docs", type: "directory" },
    { name: "src", type: "directory" },
    { name: "README.md", type: "file" },
    { name: "zeta.js", type: "file" },
  ]);
});

test("Explorer drops unknown filesystem entry types", () => {
  assert.deepEqual(createExplorerEntries([
    ["socket", 99],
    ["file.txt", 1],
  ]), [
    { name: "file.txt", type: "file" },
  ]);
});

