"use strict";

const {
  lstat,
  readdir,
  readFile,
  realpath,
} = require("node:fs/promises");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");

const SNAPSHOT_SCHEMA_VERSION = "1.0.0";
const WORK_UNIT_SCHEMA_VERSION = "4.0.0";
const MAX_JSON_BYTES = 1024 * 1024;

const COLUMN_DEFINITIONS = Object.freeze([
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "working", label: "Working" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
]);

const STATUS_TRANSITIONS = Object.freeze({
  backlog: Object.freeze(["ready", "blocked"]),
  ready: Object.freeze(["backlog", "working", "blocked"]),
  working: Object.freeze(["ready", "review", "blocked"]),
  review: Object.freeze(["working", "done", "blocked"]),
  done: Object.freeze([]),
  blocked: Object.freeze(["backlog", "ready", "working", "review"]),
});

class KanbanReadError extends Error {
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

async function readJson(packageRoot, relativePath, { optional = false } = {}) {
  const requestedPath = resolve(packageRoot, relativePath);
  if (!isWithin(packageRoot, requestedPath)) {
    throw new KanbanReadError("unsafe_path", `${relativePath} 경로가 package 밖입니다.`);
  }

  let canonicalPath;
  let stats;
  try {
    [canonicalPath, stats] = await Promise.all([
      realpath(requestedPath),
      lstat(requestedPath),
    ]);
  } catch (error) {
    if (optional && error.code === "ENOENT") {
      return null;
    }
    throw new KanbanReadError("missing_file", `${relativePath} 파일을 읽을 수 없습니다.`);
  }

  if (
    canonicalPath !== requestedPath ||
    !isWithin(packageRoot, canonicalPath) ||
    stats.isSymbolicLink()
  ) {
    throw new KanbanReadError(
      "symlink_not_allowed",
      `${relativePath} 경로에 symbolic link를 사용할 수 없습니다.`,
    );
  }
  if (!stats.isFile()) {
    throw new KanbanReadError("invalid_file", `${relativePath}가 파일이 아닙니다.`);
  }
  if (stats.size > MAX_JSON_BYTES) {
    throw new KanbanReadError(
      "file_too_large",
      `${relativePath}가 ${MAX_JSON_BYTES} bytes 제한을 초과했습니다.`,
    );
  }

  try {
    return JSON.parse(await readFile(canonicalPath, "utf8"));
  } catch (error) {
    throw new KanbanReadError("invalid_json", `${relativePath} JSON이 유효하지 않습니다.`);
  }
}

function findKind(value, kind) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findKind(entry, kind);
      if (match) {
        return match;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.kind === kind) {
    return value;
  }
  return findKind(value.content, kind) || findKind(value.subsections, kind);
}

function getTransitionCapabilities(status) {
  const allowedTargets = new Set(STATUS_TRANSITIONS[status] || []);
  return COLUMN_DEFINITIONS.map(({ id: target }) => {
    if (target === status) {
      return {
        target,
        allowed: false,
        reason: `${status}는 현재 상태입니다.`,
      };
    }
    if (!allowedTargets.has(target)) {
      return {
        target,
        allowed: false,
        reason: `${status}에서 ${target}로 직접 전이할 수 없습니다.`,
      };
    }
    return {
      target,
      allowed: true,
      reason: "manager 전이 후보입니다. 현재 Work Unit에서는 미리 보기만 제공합니다.",
    };
  });
}

function projectCard({
  metadata,
  title,
  executionContext,
  humanReview,
  report,
}) {
  const executionState = findKind(executionContext, "execution-state");
  const humanReviewResult = findKind(humanReview, "human-review-result");
  const integrationResult = findKind(report, "integration-result");
  const pullRequestResult =
    findKind(report, "pull-request-result") || findKind(report, "pr-result");

  return {
    id: metadata.id,
    title: title.title,
    status: metadata.lifecycle.status,
    updatedAt: metadata.updatedAt || null,
    execution: executionState
      ? {
          state: executionState.content?.state || null,
          revision: executionState.content?.currentRevision || null,
          attempt: executionState.content?.currentAttempt || null,
        }
      : null,
    humanReviewStatus: humanReviewResult?.attributes?.status || null,
    integrationStatus:
      integrationResult?.attributes?.status ||
      integrationResult?.content?.operationResult ||
      null,
    pullRequestStatus: pullRequestResult?.attributes?.status || null,
    capabilities: getTransitionCapabilities(metadata.lifecycle.status),
  };
}

async function readWorkUnit(packagePath, workUnitId) {
  const requestedPackagePath = resolve(packagePath);
  const packageStats = await lstat(requestedPackagePath);
  if (packageStats.isSymbolicLink()) {
    throw new KanbanReadError(
      "symlink_not_allowed",
      `${workUnitId} package가 symbolic link입니다.`,
    );
  }
  if (!packageStats.isDirectory()) {
    throw new KanbanReadError("invalid_package", `${workUnitId}가 directory가 아닙니다.`);
  }

  const packageRoot = await realpath(requestedPackagePath);
  if (packageRoot !== requestedPackagePath) {
    throw new KanbanReadError(
      "symlink_not_allowed",
      `${workUnitId} package 경로에 symbolic link를 사용할 수 없습니다.`,
    );
  }

  const [
    metadata,
    title,
    executionContext,
    humanReview,
    report,
  ] = await Promise.all([
    readJson(packageRoot, "data/metadata.json"),
    readJson(packageRoot, "data/title.json"),
    readJson(packageRoot, "data/sections/execution-context.json", {
      optional: true,
    }),
    readJson(packageRoot, "data/sections/human-review.json", { optional: true }),
    readJson(packageRoot, "data/sections/report.json", { optional: true }),
  ]);

  if (
    metadata.schemaVersion !== WORK_UNIT_SCHEMA_VERSION ||
    metadata.artifactType !== "work-unit"
  ) {
    throw new KanbanReadError(
      "unsupported_schema",
      `${workUnitId}는 지원하는 Work Unit v4 package가 아닙니다.`,
    );
  }
  if (metadata.id !== workUnitId || !title || typeof title.title !== "string") {
    throw new KanbanReadError(
      "invalid_contract",
      `${workUnitId}의 id 또는 title 계약이 유효하지 않습니다.`,
    );
  }
  if (!STATUS_TRANSITIONS[metadata.lifecycle?.status]) {
    throw new KanbanReadError(
      "invalid_status",
      `${workUnitId}의 lifecycle status가 유효하지 않습니다.`,
    );
  }

  return projectCard({
    metadata,
    title,
    executionContext,
    humanReview,
    report,
  });
}

async function readKanbanSnapshot(projectRoot, { now = () => new Date().toISOString() } = {}) {
  if (!projectRoot || !isAbsolute(projectRoot)) {
    throw new KanbanReadError(
      "invalid_project_root",
      "절대 경로 project root가 필요합니다.",
    );
  }

  const canonicalRoot = await realpath(projectRoot);
  const workUnitsPath = join(canonicalRoot, ".agent-factory", "work-units");
  let entries;
  try {
    const canonicalWorkUnitsPath = await realpath(workUnitsPath);
    if (
      canonicalWorkUnitsPath !== workUnitsPath ||
      !isWithin(canonicalRoot, canonicalWorkUnitsPath)
    ) {
      throw new KanbanReadError(
        "symlink_not_allowed",
        "Work Unit root에 symbolic link를 사용할 수 없습니다.",
      );
    }
    entries = await readdir(canonicalWorkUnitsPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }

  const cards = [];
  const errors = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      errors.push({
        workUnitId: entry.name,
        code: "symlink_not_allowed",
        message: `${entry.name} package가 symbolic link입니다.`,
      });
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      cards.push(await readWorkUnit(join(workUnitsPath, entry.name), entry.name));
    } catch (error) {
      errors.push({
        workUnitId: entry.name,
        code: error.code || "read_failed",
        message: error.message,
      });
    }
  }

  cards.sort((left, right) => {
    const updatedOrder = String(right.updatedAt || "").localeCompare(
      String(left.updatedAt || ""),
    );
    return updatedOrder || left.id.localeCompare(right.id);
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now(),
    projectRoot: canonicalRoot,
    columns: COLUMN_DEFINITIONS.map((column) => ({
      ...column,
      cards: cards.filter(({ status }) => status === column.id),
    })),
    errors,
  };
}

module.exports = {
  COLUMN_DEFINITIONS,
  STATUS_TRANSITIONS,
  getTransitionCapabilities,
  readKanbanSnapshot,
};
