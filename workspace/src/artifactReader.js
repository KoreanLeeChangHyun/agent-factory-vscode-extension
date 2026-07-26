"use strict";

const { lstat, readdir, readFile, realpath } = require("node:fs/promises");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");

const SNAPSHOT_SCHEMA_VERSION = "1.0.0";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SECTIONS = 64;
const ARTIFACT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const ARTIFACT_DEFINITIONS = Object.freeze({
  intake: Object.freeze({ directory: "intakes", schemaVersion: "2.0.0" }),
  specification: Object.freeze({
    directory: "specifications",
    schemaVersion: "1.0.0",
  }),
  "work-unit": Object.freeze({
    directory: "work-units",
    schemaVersion: "4.0.0",
  }),
});

class ArtifactReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

async function requireProjectRoot(projectRoot) {
  if (!projectRoot || !isAbsolute(projectRoot)) {
    throw new ArtifactReadError(
      "invalid_project_root",
      "절대 경로 project root가 필요합니다.",
    );
  }
  const requestedRoot = resolve(projectRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch {
    throw new ArtifactReadError(
      "invalid_project_root",
      "project root를 확인할 수 없습니다.",
    );
  }
  if (canonicalRoot !== requestedRoot) {
    throw new ArtifactReadError(
      "invalid_project_root",
      "project root에 symbolic link를 사용할 수 없습니다.",
    );
  }
  return canonicalRoot;
}

async function readJson(packageRoot, relativePath) {
  const requestedPath = resolve(packageRoot, relativePath);
  if (!isWithin(packageRoot, requestedPath)) {
    throw new ArtifactReadError(
      "unsafe_path",
      `${relativePath} 경로가 package 밖입니다.`,
    );
  }
  let canonicalPath;
  let stats;
  try {
    [canonicalPath, stats] = await Promise.all([
      realpath(requestedPath),
      lstat(requestedPath),
    ]);
  } catch {
    throw new ArtifactReadError(
      "missing_file",
      `${relativePath} 파일을 읽을 수 없습니다.`,
    );
  }
  if (
    canonicalPath !== requestedPath ||
    !isWithin(packageRoot, canonicalPath) ||
    stats.isSymbolicLink()
  ) {
    throw new ArtifactReadError(
      "symlink_not_allowed",
      `${relativePath} 경로에 symbolic link를 사용할 수 없습니다.`,
    );
  }
  if (!stats.isFile() || stats.size > MAX_JSON_BYTES) {
    throw new ArtifactReadError(
      "invalid_file",
      `${relativePath} 파일이 유효하지 않습니다.`,
    );
  }
  try {
    return JSON.parse(await readFile(canonicalPath, "utf8"));
  } catch {
    throw new ArtifactReadError(
      "invalid_json",
      `${relativePath} JSON이 유효하지 않습니다.`,
    );
  }
}

function definitionFor(artifactType) {
  const definition = ARTIFACT_DEFINITIONS[artifactType];
  if (!definition) {
    throw new ArtifactReadError(
      "unsupported_artifact",
      `${artifactType} artifact는 지원하지 않습니다.`,
    );
  }
  return definition;
}

async function requirePackage(projectRoot, artifactType, artifactId) {
  const definition = definitionFor(artifactType);
  if (
    typeof artifactId !== "string" ||
    !ARTIFACT_ID_PATTERN.test(artifactId)
  ) {
    throw new ArtifactReadError(
      "invalid_artifact_id",
      "artifact id가 안전한 형식이 아닙니다.",
    );
  }
  const canonicalRoot = await requireProjectRoot(projectRoot);
  const artifactRoot = join(
    canonicalRoot,
    ".agent-factory",
    definition.directory,
  );
  const packagePath = join(artifactRoot, artifactId);
  if (!isWithin(artifactRoot, packagePath)) {
    throw new ArtifactReadError(
      "unsafe_path",
      "artifact package가 canonical root 밖을 가리킵니다.",
    );
  }
  let canonicalPackage;
  let stats;
  try {
    [canonicalPackage, stats] = await Promise.all([
      realpath(packagePath),
      lstat(packagePath),
    ]);
  } catch {
    throw new ArtifactReadError(
      "missing_package",
      "artifact package를 찾을 수 없습니다.",
    );
  }
  if (
    canonicalPackage !== packagePath ||
    !isWithin(artifactRoot, canonicalPackage) ||
    stats.isSymbolicLink() ||
    !stats.isDirectory()
  ) {
    throw new ArtifactReadError(
      "symlink_not_allowed",
      "artifact package 경로가 안전하지 않습니다.",
    );
  }
  return { canonicalRoot, packagePath, definition };
}

function validateTableOfContents(tableOfContents) {
  const sections = tableOfContents?.sections;
  if (
    !Array.isArray(sections) ||
    sections.length > MAX_SECTIONS ||
    sections.some(
      (section) =>
        !section ||
        typeof section.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section.id) ||
        typeof section.path !== "string" ||
        !/^data\/sections\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(section.path),
    )
  ) {
    throw new ArtifactReadError(
      "invalid_contract",
      "artifact table of contents가 유효하지 않습니다.",
    );
  }
  return sections;
}

async function readArtifactDocument(projectRoot, artifactType, artifactId) {
  const { packagePath, definition } = await requirePackage(
    projectRoot,
    artifactType,
    artifactId,
  );
  const [metadata, title, tableOfContents] = await Promise.all([
    readJson(packagePath, "data/metadata.json"),
    readJson(packagePath, "data/title.json"),
    readJson(packagePath, "data/table-of-contents.json"),
  ]);
  if (
    metadata?.id !== artifactId ||
    metadata?.artifactType !== artifactType ||
    metadata?.schemaVersion !== definition.schemaVersion ||
    typeof metadata?.documentVersion !== "string" ||
    typeof title?.title !== "string"
  ) {
    throw new ArtifactReadError(
      "unsupported_schema",
      `${artifactId} package 계약 또는 schema를 지원하지 않습니다.`,
    );
  }
  const tocSections = validateTableOfContents(tableOfContents);
  const sections = [];
  const previewSections = {};
  for (const entry of tocSections) {
    const section = await readJson(packagePath, entry.path);
    if (
      section?.id !== entry.id ||
      !Array.isArray(section.content) ||
      !Array.isArray(section.subsections)
    ) {
      throw new ArtifactReadError(
        "invalid_contract",
        `${entry.id} section 계약이 유효하지 않습니다.`,
      );
    }
    sections.push({
      id: entry.id,
      title: typeof section.title === "string" ? section.title : entry.id,
      items: section.content,
      subsections: section.subsections,
    });
    previewSections[entry.id] = section;
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    artifactType,
    id: artifactId,
    title: title.title,
    documentVersion: metadata.documentVersion,
    status: metadata.lifecycle?.status || null,
    packagePath,
    sections,
    preview: {
      metadata,
      title,
      tableOfContents,
      sections: previewSections,
    },
  };
}

async function readArtifactIndex(projectRoot) {
  const canonicalRoot = await requireProjectRoot(projectRoot);
  const artifacts = [];
  const errors = [];
  for (const [artifactType, definition] of Object.entries(
    ARTIFACT_DEFINITIONS,
  )) {
    const artifactRoot = join(
      canonicalRoot,
      ".agent-factory",
      definition.directory,
    );
    let entries;
    try {
      const canonicalArtifactRoot = await realpath(artifactRoot);
      if (
        canonicalArtifactRoot !== artifactRoot ||
        !isWithin(canonicalRoot, canonicalArtifactRoot)
      ) {
        throw new ArtifactReadError(
          "symlink_not_allowed",
          `${definition.directory} root가 안전하지 않습니다.`,
        );
      }
      entries = await readdir(canonicalArtifactRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) {
        errors.push({
          artifactType,
          id: entry.name,
          code: "symlink_not_allowed",
          message: `${entry.name} package가 symbolic link입니다.`,
        });
        continue;
      }
      if (!entry.isDirectory() || !ARTIFACT_ID_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        const document = await readArtifactDocument(
          canonicalRoot,
          artifactType,
          entry.name,
        );
        artifacts.push({
          artifactType,
          id: document.id,
          title: document.title,
          documentVersion: document.documentVersion,
          status: document.status,
          sections: document.sections.map(({ id, title }) => ({ id, title })),
        });
      } catch (error) {
        errors.push({
          artifactType,
          id: entry.name,
          code: error.code || "read_failed",
          message: error.message,
        });
      }
    }
  }
  artifacts.sort(
    (left, right) =>
      Object.keys(ARTIFACT_DEFINITIONS).indexOf(left.artifactType) -
        Object.keys(ARTIFACT_DEFINITIONS).indexOf(right.artifactType) ||
      left.id.localeCompare(right.id),
  );
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    projectRoot: canonicalRoot,
    artifacts,
    errors,
  };
}

module.exports = {
  ARTIFACT_DEFINITIONS,
  ARTIFACT_ID_PATTERN,
  ArtifactReadError,
  readArtifactDocument,
  readArtifactIndex,
};
