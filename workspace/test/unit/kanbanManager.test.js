"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  discoverWorkUnitManager,
  runWorkUnitTransition,
} = require("../../src/kanbanManager");

const VERSION = "0.1.0+codex.20260726140548";

async function createManager(codexHome) {
  const managerPath = join(
    codexHome,
    "plugins",
    "cache",
    "agent-factory",
    "agent-factory",
    VERSION,
    "skills",
    "work-unit-planner",
    "assets",
    "scripts",
    "work_unit.py",
  );
  await mkdir(join(managerPath, ".."), { recursive: true });
  await writeFile(managerPath, "# manager\n", "utf8");
  return managerPath;
}

function pluginListJson(overrides = {}) {
  return JSON.stringify({
    installed: [
      {
        pluginId: "agent-factory@agent-factory",
        version: VERSION,
        installed: true,
        enabled: true,
        ...overrides,
      },
    ],
    available: [],
  });
}

test("manager discovery resolves the enabled installed plugin version", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "kanban-manager-home-"));
  const managerPath = await createManager(codexHome);
  const calls = [];
  const result = await discoverWorkUnitManager({
    codexHome,
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: pluginListJson(), stderr: "" };
    },
  });

  assert.deepEqual(result, { path: managerPath, version: VERSION });
  assert.deepEqual(calls[0][0], "codex");
  assert.deepEqual(calls[0][1], [
    "plugin",
    "list",
    "--marketplace",
    "agent-factory",
    "--json",
  ]);
  assert.equal(calls[0][2].shell, false);
});

test("manager discovery rejects disabled, unsafe-version, and symlink managers", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "kanban-manager-reject-"));
  await createManager(codexHome);

  await assert.rejects(
    discoverWorkUnitManager({
      codexHome,
      execFile: async () => ({
        stdout: pluginListJson({ enabled: false }),
        stderr: "",
      }),
    }),
    { code: "manager_unavailable" },
  );
  await assert.rejects(
    discoverWorkUnitManager({
      codexHome,
      execFile: async () => ({
        stdout: pluginListJson({ version: "../../escape" }),
        stderr: "",
      }),
    }),
    { code: "unsafe_manager_version" },
  );

  const linkedHome = await mkdtemp(join(tmpdir(), "kanban-manager-link-"));
  const outside = await mkdtemp(join(tmpdir(), "kanban-manager-outside-"));
  const outsideManager = await createManager(outside);
  const linkedManager = join(
    linkedHome,
    "plugins/cache/agent-factory/agent-factory",
    VERSION,
    "skills/work-unit-planner/assets/scripts/work_unit.py",
  );
  await mkdir(join(linkedManager, ".."), { recursive: true });
  await symlink(outsideManager, linkedManager);
  await assert.rejects(
    discoverWorkUnitManager({
      codexHome: linkedHome,
      execFile: async () => ({ stdout: pluginListJson(), stderr: "" }),
    }),
    { code: "unsafe_manager_path" },
  );
});

test("runner invokes only the allowlisted manager transition with shell disabled", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "kanban-project-"));
  const packagePath = join(
    projectRoot,
    ".agent-factory",
    "work-units",
    "safe-work-unit",
  );
  await mkdir(packagePath, { recursive: true });
  const managerPath = join(projectRoot, "work_unit.py");
  await writeFile(managerPath, "# manager\n", "utf8");
  const calls = [];

  const result = await runWorkUnitTransition({
    projectRoot,
    workUnitId: "safe-work-unit",
    targetStatus: "blocked",
    manager: { path: managerPath, version: VERSION },
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: '{"valid":true}', stderr: "" };
    },
  });

  assert.deepEqual(result, { valid: true });
  assert.deepEqual(calls[0][0], "python3");
  assert.deepEqual(calls[0][1], [
    managerPath,
    "transition",
    packagePath,
    "blocked",
  ]);
  assert.equal(calls[0][2].cwd, projectRoot);
  assert.equal(calls[0][2].shell, false);
});

test("runner rejects path escape, action-only target, and symlink package before execution", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "kanban-project-reject-"));
  const workUnitsRoot = join(projectRoot, ".agent-factory", "work-units");
  await mkdir(workUnitsRoot, { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "kanban-package-outside-"));
  await symlink(outside, join(workUnitsRoot, "linked-work-unit"), "dir");
  const never = async () => assert.fail("unsafe request must not execute");
  const manager = { path: join(projectRoot, "work_unit.py"), version: VERSION };

  await assert.rejects(
    runWorkUnitTransition({
      projectRoot,
      workUnitId: "../escape",
      targetStatus: "backlog",
      manager,
      execFile: never,
    }),
    { code: "invalid_work_unit_id" },
  );
  await assert.rejects(
    runWorkUnitTransition({
      projectRoot,
      workUnitId: "linked-work-unit",
      targetStatus: "working",
      manager,
      execFile: never,
    }),
    { code: "action_required" },
  );
  await assert.rejects(
    runWorkUnitTransition({
      projectRoot,
      workUnitId: "linked-work-unit",
      targetStatus: "backlog",
      manager,
      execFile: never,
    }),
    { code: "unsafe_package_path" },
  );
});
