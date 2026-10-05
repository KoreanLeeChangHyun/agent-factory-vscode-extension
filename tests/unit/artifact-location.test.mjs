import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Lessons and generated artifacts belong to the workspace docs/, not to this repository.
test("extension repository has no stray docs or out directories", () => {
  for (const name of ["docs", "out"]) {
    assert.equal(existsSync(path.join(root, name)), false,
      `${name}/ must not exist in extension/; move its files to the workspace docs/lessons-learned or docs/artifact/<category>/<topic>/`);
  }
});

test("browser tests write screenshots to workspace docs/artifact instead of out/", () => {
  const directory = path.join(root, "tests/browser");
  for (const name of readdirSync(directory)) {
    const source = readFileSync(path.join(directory, name), "utf8");
    assert.doesNotMatch(source, /['"`](?:\.\.\/\.\.\/)?out\//, `${name} writes generated files under extension/out`);
    assert.doesNotMatch(source, /docs\/artifact\/(?!(?:preview|evidence|media|release)\/)[\w-]+/,
      `${name} writes an artifact without a purpose category`);
  }
});
