"use strict";

const assert = require("node:assert/strict");
const {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  ArtifactReadError,
  readArtifactDocument,
  readArtifactIndex,
} = require("../../src/artifactReader");

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createPackage(root, type, id, schemaVersion) {
  const plural = {
    intake: "intakes",
    specification: "specifications",
    "work-unit": "work-units",
  }[type];
  const packagePath = join(root, ".agent-factory", plural, id);
  await mkdir(join(packagePath, "data", "sections"), { recursive: true });
  await mkdir(join(packagePath, "blocks"), { recursive: true });
  await writeJson(join(packagePath, "data", "metadata.json"), {
    id,
    artifactType: type,
    schemaVersion,
    documentVersion: "1.0.3",
    lifecycle: { status: type === "work-unit" ? "ready" : "draft" },
  });
  await writeJson(join(packagePath, "data", "title.json"), {
    id: "title",
    title: `${id} title`,
  });
  await writeJson(join(packagePath, "data", "table-of-contents.json"), {
    sections: [{ id: "overview", path: "data/sections/overview.json" }],
  });
  await writeJson(join(packagePath, "data", "sections", "overview.json"), {
    id: "overview",
    title: "Overview",
    content: [{ id: "ITEM-001", kind: "context", content: { value: "before" } }],
    subsections: [],
  });
  await writeJson(join(packagePath, "blocks", "index.json"), { blocks: [] });
  return packagePath;
}

test("reader discovers all supported sectioned artifact types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-reader-"));
  t.after(async () => {
    const { rm } = require("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await createPackage(root, "intake", "safe-intake", "2.0.0");
  await createPackage(root, "specification", "safe-spec", "1.0.0");
  await createPackage(root, "work-unit", "safe-work-unit", "4.0.0");

  const index = await readArtifactIndex(root);
  assert.deepEqual(
    index.artifacts.map(({ artifactType, id }) => [artifactType, id]),
    [
      ["intake", "safe-intake"],
      ["specification", "safe-spec"],
      ["work-unit", "safe-work-unit"],
    ],
  );
  const document = await readArtifactDocument(root, "intake", "safe-intake");
  assert.equal(document.documentVersion, "1.0.3");
  assert.equal(document.sections[0].items[0].id, "ITEM-001");
  assert.equal(document.preview.sections.overview.content[0].content.value, "before");
});

test("reader rejects path escapes and symbolic-link packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-reader-unsafe-"));
  t.after(async () => {
    const { rm } = require("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const target = await createPackage(root, "intake", "target", "2.0.0");
  const link = join(root, ".agent-factory", "intakes", "linked");
  await symlink(target, link);

  await assert.rejects(
    readArtifactDocument(root, "intake", "../target"),
    (error) => error instanceof ArtifactReadError && error.code === "invalid_artifact_id",
  );
  const index = await readArtifactIndex(root);
  assert.equal(index.artifacts.some(({ id }) => id === "linked"), false);
  assert.equal(index.errors.some(({ code }) => code === "symlink_not_allowed"), true);
});
