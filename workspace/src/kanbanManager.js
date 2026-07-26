"use strict";

const { execFile: execFileCallback } = require("node:child_process");
const { lstat, realpath } = require("node:fs/promises");
const { homedir } = require("node:os");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
const { promisify } = require("node:util");

const execFile = promisify(execFileCallback);
const WORK_UNIT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const DND_TARGETS = new Set(["backlog", "ready", "blocked"]);

class KanbanManagerError extends Error {
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

async function requireCanonicalFile(path, code) {
  let canonicalPath;
  let stats;
  try {
    [canonicalPath, stats] = await Promise.all([realpath(path), lstat(path)]);
  } catch {
    throw new KanbanManagerError(code, "설치된 Work Unit manager를 찾을 수 없습니다.");
  }
  if (canonicalPath !== path || stats.isSymbolicLink() || !stats.isFile()) {
    throw new KanbanManagerError(code, "Work Unit manager 경로가 안전하지 않습니다.");
  }
}

async function discoverWorkUnitManager({
  codexHome = join(homedir(), ".codex"),
  execFile: execute = execFile,
} = {}) {
  let stdout;
  try {
    ({ stdout } = await execute(
      "codex",
      [
        "plugin",
        "list",
        "--marketplace",
        "agent-factory",
        "--json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    ));
  } catch {
    throw new KanbanManagerError(
      "manager_discovery_failed",
      "Codex plugin 목록에서 Agent Factory manager를 확인하지 못했습니다.",
    );
  }

  let catalog;
  try {
    catalog = JSON.parse(stdout);
  } catch {
    throw new KanbanManagerError(
      "manager_discovery_failed",
      "Codex plugin 목록 응답이 유효하지 않습니다.",
    );
  }
  const plugin = catalog.installed?.find(
    (candidate) =>
      candidate.pluginId === "agent-factory@agent-factory" &&
      candidate.installed === true &&
      candidate.enabled === true,
  );
  if (!plugin) {
    throw new KanbanManagerError(
      "manager_unavailable",
      "활성화된 Agent Factory plugin이 필요합니다.",
    );
  }
  if (
    typeof plugin.version !== "string" ||
    !VERSION_PATTERN.test(plugin.version)
  ) {
    throw new KanbanManagerError(
      "unsafe_manager_version",
      "Agent Factory plugin version이 안전하지 않습니다.",
    );
  }

  const canonicalCodexHome = resolve(codexHome);
  const cacheRoot = join(
    canonicalCodexHome,
    "plugins",
    "cache",
    "agent-factory",
    "agent-factory",
  );
  const managerPath = join(
    cacheRoot,
    plugin.version,
    "skills",
    "work-unit-planner",
    "assets",
    "scripts",
    "work_unit.py",
  );
  if (!isWithin(cacheRoot, managerPath)) {
    throw new KanbanManagerError(
      "unsafe_manager_path",
      "Work Unit manager가 plugin cache 밖을 가리킵니다.",
    );
  }
  await requireCanonicalFile(managerPath, "unsafe_manager_path");
  return { path: managerPath, version: plugin.version };
}

async function requireCanonicalPackage(projectRoot, workUnitId) {
  if (!isAbsolute(projectRoot)) {
    throw new KanbanManagerError(
      "invalid_project_root",
      "절대 경로 Workspace root가 필요합니다.",
    );
  }
  const requestedRoot = resolve(projectRoot);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch {
    throw new KanbanManagerError(
      "invalid_project_root",
      "Workspace root를 확인할 수 없습니다.",
    );
  }
  if (canonicalRoot !== requestedRoot) {
    throw new KanbanManagerError(
      "invalid_project_root",
      "Workspace root에 symbolic link를 사용할 수 없습니다.",
    );
  }
  if (
    typeof workUnitId !== "string" ||
    !WORK_UNIT_ID_PATTERN.test(workUnitId)
  ) {
    throw new KanbanManagerError(
      "invalid_work_unit_id",
      "Work Unit id가 안전한 형식이 아닙니다.",
    );
  }

  const workUnitsRoot = join(
    canonicalRoot,
    ".agent-factory",
    "work-units",
  );
  const packagePath = join(workUnitsRoot, workUnitId);
  if (!isWithin(workUnitsRoot, packagePath)) {
    throw new KanbanManagerError(
      "unsafe_package_path",
      "Work Unit package가 canonical root 밖을 가리킵니다.",
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
    throw new KanbanManagerError(
      "missing_package",
      "Work Unit package를 찾을 수 없습니다.",
    );
  }
  if (
    canonicalPackage !== packagePath ||
    !isWithin(workUnitsRoot, canonicalPackage) ||
    stats.isSymbolicLink() ||
    !stats.isDirectory()
  ) {
    throw new KanbanManagerError(
      "unsafe_package_path",
      "Work Unit package 경로가 안전하지 않습니다.",
    );
  }
  return { canonicalRoot, packagePath };
}

async function runWorkUnitTransition({
  projectRoot,
  workUnitId,
  targetStatus,
  manager,
  execFile: execute = execFile,
}) {
  if (!DND_TARGETS.has(targetStatus)) {
    throw new KanbanManagerError(
      "action_required",
      `${targetStatus} 전이는 전용 Action이 필요합니다.`,
    );
  }
  const { canonicalRoot, packagePath } = await requireCanonicalPackage(
    projectRoot,
    workUnitId,
  );
  if (!manager || typeof manager.path !== "string") {
    throw new KanbanManagerError(
      "manager_unavailable",
      "Work Unit manager가 준비되지 않았습니다.",
    );
  }

  let stdout;
  try {
    ({ stdout } = await execute(
      "python3",
      [manager.path, "transition", packagePath, targetStatus],
      {
        cwd: canonicalRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    throw new KanbanManagerError(
      "manager_failed",
      detail || "Work Unit manager가 전이를 거부했습니다.",
    );
  }

  try {
    const result = JSON.parse(stdout);
    if (result?.valid !== true) {
      throw new Error("invalid result");
    }
    return result;
  } catch {
    throw new KanbanManagerError(
      "manager_invalid_response",
      "Work Unit manager 검증 응답이 유효하지 않습니다.",
    );
  }
}

function createWorkUnitTransitionRunner(options = {}) {
  let managerPromise;
  return async (request) => {
    managerPromise ||= discoverWorkUnitManager(options);
    let manager;
    try {
      manager = await managerPromise;
    } catch (error) {
      managerPromise = undefined;
      throw error;
    }
    return runWorkUnitTransition({
      ...request,
      manager,
      execFile: options.execFile || execFile,
    });
  };
}

module.exports = {
  DND_TARGETS,
  KanbanManagerError,
  WORK_UNIT_ID_PATTERN,
  createWorkUnitTransitionRunner,
  discoverWorkUnitManager,
  runWorkUnitTransition,
};
