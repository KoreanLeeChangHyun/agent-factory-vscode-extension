"use strict";

const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;

const EXCLUDED_ENTRY_NAMES = new Set([
  ".git",
  ".pytest_cache",
  ".vscode-test",
  "__pycache__",
  "node_modules",
]);

function createExplorerEntries(entries) {
  return entries
    .filter(([name, type]) => (
      !EXCLUDED_ENTRY_NAMES.has(name)
      && (type === FILE_TYPE_FILE || type === FILE_TYPE_DIRECTORY)
    ))
    .map(([name, type]) => ({
      name,
      type: type === FILE_TYPE_DIRECTORY ? "directory" : "file",
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      });
    });
}

module.exports = {
  EXCLUDED_ENTRY_NAMES,
  createExplorerEntries,
};

