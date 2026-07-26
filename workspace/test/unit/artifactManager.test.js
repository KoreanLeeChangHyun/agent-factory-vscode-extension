"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ArtifactManagerError,
  encodeTypedValue,
  runArtifactItemSave,
} = require("../../src/artifactManager");

test("typed argument encoder preserves nested semantic item values", () => {
  const args = [];
  encodeTypedValue(args, "", {
    id: "ITEM-001",
    kind: "context",
    content: {
      title: "safe",
      enabled: true,
      tags: ["one", "two"],
      optional: null,
    },
  });
  assert.deepEqual(args, [
    "--string", "/id", "ITEM-001",
    "--string", "/kind", "context",
    "--string", "/content/title", "safe",
    "--boolean", "/content/enabled", "true",
    "--string-list", "/content/tags", "one", "two",
    "--null", "/content/optional",
  ]);
});

test("save refuses stale and shape-changing content before manager execution", async () => {
  let executions = 0;
  const base = {
    projectRoot: "/project",
    artifactType: "intake",
    artifactId: "safe-intake",
    sectionId: "overview",
    itemId: "ITEM-001",
    documentVersion: "1.0.3",
    content: { value: "after" },
  };
  const options = {
    readDocument: async () => ({
      documentVersion: "1.0.4",
      packagePath: "/project/.agent-factory/intakes/safe-intake",
      sections: [{
        id: "overview",
        items: [{ id: "ITEM-001", kind: "context", content: { value: "before" } }],
      }],
    }),
    discoverManager: async () => ({ path: "/manager.py" }),
    execFile: async () => {
      executions += 1;
      return { stdout: "{}" };
    },
  };

  await assert.rejects(
    runArtifactItemSave(base, options),
    (error) => error instanceof ArtifactManagerError && error.code === "stale_document",
  );
  await assert.rejects(
    runArtifactItemSave(
      { ...base, documentVersion: "1.0.4", content: ["shape changed"] },
      { ...options, readDocument: async () => ({
        ...(await options.readDocument()),
        documentVersion: "1.0.4",
      }) },
    ),
    (error) => error instanceof ArtifactManagerError && error.code === "invalid_content_shape",
  );
  assert.equal(executions, 0);
});
