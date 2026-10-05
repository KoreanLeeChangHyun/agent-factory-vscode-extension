import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

async function writeLoop(agentsRoot, agent, loop, state) {
  const path = join(agentsRoot, agent, "loops", loop, "state.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state));
}

test("project task history reads every conversation's briefs without driving loops", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-project-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsRoot = join(root, "agents");
  const parent = main => join(agentsRoot, main, "runs", "run-parent", "state.json");
  await writeLoop(agentsRoot, "work-one", "loop-one", {
    status: "completed", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T11:00:00Z", parentStatePath: parent("main-a"),
    contract: { id: "WC-1", version: 2, fileOperations: [] },
    workflow: { id: "brief-one", title: "First brief", tasks: [{ id: "task-a", title: "Task A", description: "x".repeat(5000), workStatus: "completed", workAgentId: "work-one" }] }
  });
  await writeLoop(agentsRoot, "work-two", "loop-two", {
    status: "runtime-error", createdAt: "2026-10-02T10:00:00Z", parentStatePath: parent("main-b"), contract: null,
    workflow: { id: "brief-two", title: "Second brief", tasks: [{ id: "task-b", title: "Task B", workStatus: "failed" }] }
  });
  // A re-dispatched brief keeps one row: its newest loop state.
  await writeLoop(agentsRoot, "work-two", "loop-three", {
    status: "completed", createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T12:00:00Z", parentStatePath: parent("main-b"),
    workflow: { id: "brief-two", title: "Second brief", tasks: [{ id: "task-b", title: "Task B", workStatus: "completed" }] }
  });
  await writeLoop(agentsRoot, "work-three", "loop-bad", { status: "completed", workflow: { id: "../escape", title: "Bad", tasks: [] } });
  await mkdir(join(agentsRoot, "main-a", "runs"), { recursive: true });
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: root, projectId: "project-test", agentsRoot });
  const entries = await client.listProjectTasks();
  assert.deepEqual(entries.map(entry => entry.id), ["brief-two", "brief-one"], "Newest brief first; invalid identities dropped");
  const [second, first] = entries;
  assert.equal(second.status, "completed");
  assert.equal(second.mainAgentId, "main-b");
  assert.equal(second.contract, undefined);
  assert.deepEqual(first.contract, { id: "WC-1", version: 2 });
  assert.equal(first.mainAgentId, "main-a");
  assert.equal(first.tasks[0].description.length, 4000, "Descriptions are bounded");
  assert.deepEqual(Object.keys(first.tasks[0]).sort(), ["description", "id", "title", "workStatus"], "No agent identity or path leaves the host");
  assert.equal(JSON.stringify(entries).includes(agentsRoot), false);
});

test("project task protocol carries only the request type", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "project.tasks.request", extra: 1 }), { type: "project.tasks.request" });
});
