"use strict";

const { execFile: execFileCallback } = require("node:child_process");
const {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { promisify } = require("node:util");

const { discoverWorkUnitManager } = require("./kanbanManager");
const {
  ARTIFACT_DEFINITIONS,
  readArtifactDocument,
} = require("./artifactReader");

const execFile = promisify(execFileCallback);
const MAX_CONTENT_BYTES = 128 * 1024;
const MANAGER_RELATIVE_PATHS = Object.freeze({
  intake: ["intake", "scripts", "intake.py"],
  specification: ["specification", "scripts", "specification.py"],
  "work-unit": [
    "work-unit-planner",
    "assets",
    "scripts",
    "work_unit.py",
  ],
});

class ArtifactManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pointerEscape(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function encodeTypedValue(args, pointer, value) {
  if (value === null) {
    args.push("--null", pointer);
    return;
  }
  if (typeof value === "string") {
    args.push("--string", pointer, value);
    return;
  }
  if (typeof value === "boolean") {
    args.push("--boolean", pointer, String(value));
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(
      Number.isInteger(value) ? "--integer" : "--number",
      pointer,
      String(value),
    );
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      args.push("--string-list", pointer, ...value);
      return;
    }
    if (value.length === 0) {
      args.push("--empty-list", pointer);
      return;
    }
    value.forEach((entry, index) => {
      encodeTypedValue(args, `${pointer}/${index}`, entry);
    });
    return;
  }
  if (value && typeof value === "object") {
    if (pointer && Object.keys(value).length === 0) {
      args.push("--empty-object", pointer);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      encodeTypedValue(args, `${pointer}/${pointerEscape(key)}`, entry);
    }
    return;
  }
  throw new ArtifactManagerError(
    "unsupported_value",
    "지원하지 않는 semantic value입니다.",
  );
}

function sameShape(current, next) {
  if (Array.isArray(current)) {
    return (
      Array.isArray(next) &&
      (current.every((entry) => typeof entry === "string")
        ? next.every((entry) => typeof entry === "string")
        : current.length === next.length &&
          current.every((entry, index) => sameShape(entry, next[index])))
    );
  }
  if (current === null) {
    return next === null || ["string", "number", "boolean"].includes(typeof next);
  }
  if (current && typeof current === "object") {
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return false;
    }
    const currentKeys = Object.keys(current).sort();
    const nextKeys = Object.keys(next).sort();
    return (
      currentKeys.length === nextKeys.length &&
      currentKeys.every(
        (key, index) =>
          key === nextKeys[index] && sameShape(current[key], next[key]),
      )
    );
  }
  return typeof current === typeof next;
}

async function discoverArtifactManager(
  artifactType,
  { discoverWorkUnit = discoverWorkUnitManager } = {},
) {
  const relativePath = MANAGER_RELATIVE_PATHS[artifactType];
  if (!relativePath) {
    throw new ArtifactManagerError(
      "unsupported_artifact",
      "지원하지 않는 artifact type입니다.",
    );
  }
  const workUnitManager = await discoverWorkUnit();
  const skillsRoot = dirname(dirname(dirname(dirname(workUnitManager.path))));
  const managerPath = join(skillsRoot, ...relativePath);
  let canonicalPath;
  let stats;
  try {
    [canonicalPath, stats] = await Promise.all([
      realpath(managerPath),
      lstat(managerPath),
    ]);
  } catch {
    throw new ArtifactManagerError(
      "manager_unavailable",
      "artifact manager를 찾을 수 없습니다.",
    );
  }
  if (
    canonicalPath !== managerPath ||
    stats.isSymbolicLink() ||
    !stats.isFile()
  ) {
    throw new ArtifactManagerError(
      "unsafe_manager_path",
      "artifact manager 경로가 안전하지 않습니다.",
    );
  }
  return { path: managerPath, version: workUnitManager.version };
}

async function runArtifactItemSave(
  request,
  {
    readDocument = readArtifactDocument,
    discoverManager = discoverArtifactManager,
    execFile: execute = execFile,
  } = {},
) {
  const current = await readDocument(
    request.projectRoot,
    request.artifactType,
    request.artifactId,
  );
  if (current.documentVersion !== request.documentVersion) {
    throw new ArtifactManagerError(
      "stale_document",
      "artifact가 변경되었습니다. 새로 고침 후 다시 시도하세요.",
    );
  }
  const section = current.sections.find(
    (candidate) => candidate.id === request.sectionId,
  );
  const item = section?.items.find(
    (candidate) => candidate.id === request.itemId,
  );
  if (!item) {
    throw new ArtifactManagerError(
      "missing_item",
      "편집할 content item을 찾을 수 없습니다.",
    );
  }
  if (
    JSON.stringify(request.content).length > MAX_CONTENT_BYTES ||
    !sameShape(item.content, request.content)
  ) {
    throw new ArtifactManagerError(
      "invalid_content_shape",
      "기존 semantic field 구조와 같은 형식만 저장할 수 있습니다.",
    );
  }
  const updatedItem = { ...item, content: request.content };
  const typedArgs = [];
  encodeTypedValue(typedArgs, "", updatedItem);
  const manager = await discoverManager(request.artifactType);
  const mutationArgs = (packagePath) => [
    manager.path,
    "section-item-put",
    packagePath,
    request.sectionId,
    ...typedArgs,
  ];
  const executeManager = (args, cwd = request.projectRoot) =>
    execute("python3", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "artifact-manager-"));
  const temporaryAgentFactory = join(temporaryRoot, ".agent-factory");
  const temporaryPackage = join(
    temporaryAgentFactory,
    ARTIFACT_DEFINITIONS[request.artifactType].directory,
    request.artifactId,
  );
  try {
    await mkdir(temporaryAgentFactory, { recursive: true });
    for (const { directory } of Object.values(ARTIFACT_DEFINITIONS)) {
      const source = join(request.projectRoot, ".agent-factory", directory);
      try {
        await cp(source, join(temporaryAgentFactory, directory), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await executeManager(mutationArgs(temporaryPackage), temporaryRoot);
    await executeManager([
      manager.path,
      "validate",
      temporaryPackage,
      "--full",
    ], temporaryRoot);
    const latest = await readDocument(
      request.projectRoot,
      request.artifactType,
      request.artifactId,
    );
    if (latest.documentVersion !== request.documentVersion) {
      throw new ArtifactManagerError(
        "stale_document",
        "artifact가 변경되었습니다. 새로 고침 후 다시 시도하세요.",
      );
    }
    await executeManager(mutationArgs(current.packagePath));
    await executeManager([
      manager.path,
      "validate",
      current.packagePath,
      "--full",
    ]);
  } catch (error) {
    if (error instanceof ArtifactManagerError) {
      throw error;
    }
    const detail = String(error.stderr || error.message || "").trim();
    throw new ArtifactManagerError(
      "manager_failed",
      detail || "artifact manager가 저장을 거부했습니다.",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return readDocument(
    request.projectRoot,
    request.artifactType,
    request.artifactId,
  );
}

function createArtifactItemSaveRunner(options = {}) {
  return (request) => runArtifactItemSave(request, options);
}

module.exports = {
  ArtifactManagerError,
  createArtifactItemSaveRunner,
  discoverArtifactManager,
  encodeTypedValue,
  runArtifactItemSave,
  sameShape,
};
