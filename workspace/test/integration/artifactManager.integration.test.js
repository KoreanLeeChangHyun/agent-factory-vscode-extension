"use strict";

const assert = require("node:assert/strict");
const { execFile: execFileCallback } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { runArtifactItemSave } = require("../../src/artifactManager");
const { readArtifactDocument } = require("../../src/artifactReader");

const execFile = promisify(execFileCallback);

test("installed Intake manager saves a structured field in an isolated clone", async (t) => {
  const repositoryRoot = join(__dirname, "..", "..", "..");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "artifact-manager-integration-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await execFile(
    "git",
    ["clone", "--quiet", "--shared", repositoryRoot, fixtureRoot],
    { shell: false },
  );

  const before = await readArtifactDocument(
    fixtureRoot,
    "intake",
    "agent-factory-workspace-editor",
  );
  const section = before.sections.find(({ id }) => id === "request-and-goal");
  const item = section.items.find(({ id }) => id === "HUMAN-REQUEST-001");
  const nextContent = {
    ...item.content,
    request: `${item.content.request} integration`,
  };

  const after = await runArtifactItemSave({
    projectRoot: fixtureRoot,
    artifactType: "intake",
    artifactId: "agent-factory-workspace-editor",
    sectionId: section.id,
    itemId: item.id,
    documentVersion: before.documentVersion,
    content: nextContent,
  });

  assert.notEqual(after.documentVersion, before.documentVersion);
  assert.equal(
    after.sections
      .find(({ id }) => id === section.id)
      .items.find(({ id }) => id === item.id).content.request,
    nextContent.request,
  );
});
