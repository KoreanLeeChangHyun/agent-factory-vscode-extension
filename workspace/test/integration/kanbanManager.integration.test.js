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
} = require("../../src/kanbanManager");
const { readKanbanSnapshot } = require("../../src/kanbanReader");

const execFile = promisify(execFileCallback);
const FIXTURE_ID = "agent-factory-agents-chat-web-alignment";

test("installed manager transitions an isolated canonical fixture", async () => {
  const repositoryRoot = join(__dirname, "..", "..", "..");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "kanban-manager-integration-"));
  try {
    await execFile("git", ["clone", "--quiet", "--shared", repositoryRoot, fixtureRoot], {
      shell: false,
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
