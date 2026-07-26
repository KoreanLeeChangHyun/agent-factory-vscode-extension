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
const DND_TARGETS = new Set(["backlog", "ready", "blocked"]);
const ACTION_REQUIRED_REASONS = Object.freeze({
  working: "working 전이는 실행 Action이 필요합니다.",
  review: "review 전이는 실행 완료 검증 Action이 필요합니다.",
  done: "done 전이는 Human 승인 Action이 필요합니다.",
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

function getTransitionCapabilities(status, transitionContext) {
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
    if (!DND_TARGETS.has(target)) {
      return {
        target,
        allowed: false,
        reason: ACTION_REQUIRED_REASONS[target],
      };
    }
    if (
      transitionContext &&
      target === "blocked" &&
      !transitionContext.hasBlockingOpenItem
    ) {
      return {
        target,
        allowed: false,
        reason: "blocked 전이는 미해결 blocking open item이 필요합니다.",
      };
    }
    if (
      transitionContext &&
      target === "blocked" &&
      !transitionContext.hasExecutionState
    ) {
      return {
        target,
        allowed: false,
        reason: "blocked 전이는 초기화된 execution state가 필요합니다.",
      };
    }
    if (
      transitionContext &&
      target === "ready" &&
      !transitionContext.readyCandidate
    ) {
      return {
        target,
        allowed: false,
        reason: "ready 전이 조건(완료된 readiness·execution context·미해결 blocker 없음)이 충족되지 않았습니다.",
      };
    }
    return {
      target,
      allowed: true,
      reason: `${target} 전이는 Work Unit manager가 실행 직전에 다시 검증합니다.`,
    };
  });
}

function projectCard({
  metadata,
  title,
  sections,
}) {
  const executionContext = sections.get("execution-context");
  const humanReview = sections.get("human-review");
  const report = sections.get("report");
  const executionState = findKind(executionContext, "execution-state");
  const executionContextItem = findKind(executionContext, "execution-context");
  const humanReviewResult = findKind(humanReview, "human-review-result");
  const integrationResult = findKind(report, "integration-result");
  const pullRequestResult =
    findKind(report, "pull-request-result") || findKind(report, "pr-result");
  const hasBlockingOpenItem = Array.from(sections.values()).some(
    (section) => hasUnresolvedBlockingOpenItem(section),
  );
  const readiness = metadata.readiness || {};
  const readinessKeys = [
    "contractValid",
    "intakeTraceabilityValid",
    "definitionComplete",
    "executionContextComplete",
    "verificationPlanComplete",
  ];
  const executionContextContent = executionContextItem?.content;
  const requiredExecutionContextFields = [
    "goalId",
    "objective",
    "execInvocation",
    "executionAgent",
    "repository",
    "baseRef",
    "branch",
    "worktreePath",
  ];
  const readyCandidate =
    readinessKeys.every((key) => readiness[key] === true) &&
    typeof readiness.reviewedAt === "string" &&
    !hasBlockingOpenItem &&
    executionContextContent &&
    requiredExecutionContextFields.every(
      (field) => Object.hasOwn(executionContextContent, field),
    );

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
    capabilities: getTransitionCapabilities(metadata.lifecycle.status, {
      hasBlockingOpenItem,
      hasExecutionState: Boolean(executionState),
      readyCandidate: Boolean(readyCandidate),
    }),
  };
}

function hasUnresolvedBlockingOpenItem(value) {
  if (Array.isArray(value)) {
    return value.some(hasUnresolvedBlockingOpenItem);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (
    value.kind === "open-item" &&
    value.attributes?.blocking === true &&
    value.attributes?.resolved !== true
  ) {
    return true;
  }
  return (
    hasUnresolvedBlockingOpenItem(value.content) ||
    hasUnresolvedBlockingOpenItem(value.subsections)
  );
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

  const [metadata, title, tableOfContents] = await Promise.all([
    readJson(packageRoot, "data/metadata.json"),
    readJson(packageRoot, "data/title.json"),
    readJson(packageRoot, "data/table-of-contents.json"),
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
  if (
    !Array.isArray(tableOfContents.sections) ||
    tableOfContents.sections.length > 32 ||
    tableOfContents.sections.some(
      (section) =>
        !section ||
        typeof section.id !== "string" ||
        typeof section.path !== "string" ||
        !/^data\/sections\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(
          section.path,
        ),
    )
  ) {
    throw new KanbanReadError(
      "invalid_contract",
      `${workUnitId}의 table of contents 계약이 유효하지 않습니다.`,
    );
  }
  const sectionEntries = await Promise.all(
    tableOfContents.sections.map(async (section) => [
      section.id,
      await readJson(packageRoot, section.path),
    ]),
  );
  const sections = new Map(sectionEntries);
  if (sections.size !== sectionEntries.length) {
    throw new KanbanReadError(
      "invalid_contract",
      `${workUnitId}의 section id가 중복됩니다.`,
    );
  }

  return projectCard({
    metadata,
    title,
    sections,
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
