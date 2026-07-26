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
  COLUMN_DEFINITIONS,
  getTransitionCapabilities,
  readKanbanSnapshot,
} = require("../../src/kanbanReader");

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createWorkUnit(root, {
  id,
  status,
  schemaVersion = "4.0.0",
  title = id,
}) {
  const packagePath = join(root, ".agent-factory", "work-units", id);
  const sectionsPath = join(packagePath, "data", "sections");
  await mkdir(sectionsPath, { recursive: true });
  await writeJson(join(packagePath, "data", "metadata.json"), {
    schemaVersion,
    id,
    artifactType: "work-unit",
    lifecycle: { phase: "work-unit", status },
    updatedAt: "2026-07-26T12:00:00Z",
  });
  await writeJson(join(packagePath, "data", "title.json"), { title });
  await writeJson(join(sectionsPath, "execution-context.json"), {
    content: [
      {
        id: "EXECUTION-STATE-001",
        kind: "execution-state",
        content: {
          state: "running",
          currentRevision: 2,
          currentAttempt: 1,
        },
      },
    ],
  });
  await writeJson(join(sectionsPath, "human-review.json"), {
    content: [
      {
        id: "HUMAN-REVIEW-RESULT-001",
        kind: "human-review-result",
        content: "대기",
        attributes: { status: "pending" },
      },
    ],
  });
  await writeJson(join(sectionsPath, "report.json"), {
    content: [
      {
        id: "INTEGRATION-RESULT-001",
        kind: "integration-result",
        content: { operationResult: "integrated" },
      },
      {
        id: "PR-RESULT-001",
        kind: "pull-request-result",
        content: "draft PR",
        attributes: { status: "draft" },
      },
    ],
  });
}

test("reader projects canonical v4 Work Units into all six lifecycle columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanban-reader-"));
  await createWorkUnit(root, {
    id: "wu-ready",
    status: "ready",
    title: "Ready Work",
  });
  await createWorkUnit(root, {
    id: "wu-blocked",
    status: "blocked",
    title: "Blocked Work",
  });

  const snapshot = await readKanbanSnapshot(root, {
    now: () => "2026-07-26T12:30:00Z",
  });

  assert.equal(snapshot.schemaVersion, "1.0.0");
  assert.equal(snapshot.generatedAt, "2026-07-26T12:30:00Z");
  assert.deepEqual(
    snapshot.columns.map(({ id }) => id),
    COLUMN_DEFINITIONS.map(({ id }) => id),
  );
  assert.equal(snapshot.columns.find(({ id }) => id === "ready").cards.length, 1);
  const readyCard = snapshot.columns.find(({ id }) => id === "ready").cards[0];
  assert.equal(readyCard.id, "wu-ready");
  assert.equal(readyCard.title, "Ready Work");
  assert.deepEqual(readyCard.execution, {
    state: "running",
    revision: 2,
    attempt: 1,
  });
  assert.equal(readyCard.humanReviewStatus, "pending");
  assert.equal(readyCard.integrationStatus, "integrated");
  assert.equal(readyCard.pullRequestStatus, "draft");
  assert.equal(snapshot.errors.length, 0);
});

test("capabilities expose only manager transition graph targets with reasons", () => {
  const capabilities = getTransitionCapabilities("review");
  assert.deepEqual(
    capabilities.filter(({ allowed }) => allowed).map(({ target }) => target),
    ["working", "done", "blocked"],
  );
  assert.equal(
    capabilities.find(({ target }) => target === "ready").reason,
    "review에서 ready로 직접 전이할 수 없습니다.",
  );
});

test("reader keeps valid cards while reporting unsupported and symlink packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanban-partial-"));
  await createWorkUnit(root, { id: "valid", status: "backlog" });
  await createWorkUnit(root, {
    id: "unsupported",
    status: "ready",
    schemaVersion: "3.0.0",
  });

  const outside = await mkdtemp(join(tmpdir(), "kanban-outside-"));
  await createWorkUnit(outside, { id: "linked", status: "done" });
  await symlink(
    join(outside, ".agent-factory", "work-units", "linked"),
    join(root, ".agent-factory", "work-units", "linked"),
    "dir",
  );

  const snapshot = await readKanbanSnapshot(root);
  assert.equal(
    snapshot.columns.reduce((total, column) => total + column.cards.length, 0),
    1,
  );
  assert.deepEqual(
    snapshot.errors.map(({ code }) => code).sort(),
    ["symlink_not_allowed", "unsupported_schema"],
  );
});
