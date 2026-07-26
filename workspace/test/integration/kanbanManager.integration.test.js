"use strict";

const assert = require("node:assert/strict");
const { execFile: execFileCallback } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const {
  createWorkUnitTransitionRunner,
  discoverWorkUnitManager,
} = require("../../src/kanbanManager");
const { readKanbanSnapshot } = require("../../src/kanbanReader");
const {
  FIXTURE_ID,
  createReadyKanbanFixture,
} = require("../helpers/kanbanFixture");

const execFile = promisify(execFileCallback);

test("installed manager transitions an isolated canonical fixture", async () => {
  const repositoryRoot = join(__dirname, "..", "..", "..");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "kanban-manager-integration-"));
  try {
    await execFile("git", ["clone", "--quiet", "--shared", repositoryRoot, fixtureRoot], {
      shell: false,
    });
    const manager = await discoverWorkUnitManager();
    await createReadyKanbanFixture({
      managerPath: manager.path,
      projectRoot: fixtureRoot,
    });
    const before = await readKanbanSnapshot(fixtureRoot);
    assert.equal(
      before.columns.find(({ id }) => id === "ready").cards.some(
        ({ id }) => id === FIXTURE_ID,
      ),
      true,
    );

    const transition = createWorkUnitTransitionRunner();
    await transition({
      projectRoot: fixtureRoot,
      workUnitId: FIXTURE_ID,
      targetStatus: "backlog",
    });

    const after = await readKanbanSnapshot(fixtureRoot);
    assert.equal(
      after.columns.find(({ id }) => id === "backlog").cards.some(
        ({ id }) => id === FIXTURE_ID,
      ),
      true,
    );
    assert.equal(
      after.columns.find(({ id }) => id === "ready").cards.some(
        ({ id }) => id === FIXTURE_ID,
      ),
      false,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
