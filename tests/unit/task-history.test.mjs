import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importTypeScript } from "../support/import-typescript.mjs";

test("task delete protocol accepts only the exact task and optional project owner", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const target = { type: "task.delete", workflowId: "flow-one", taskId: "task-one", mainAgentId: "main-other" };
  assert.deepEqual(parseClientMessage({ ...target, path: "/unrelated", runId: "run-other" }), target);
  for (const change of [{ workflowId: "../escape" }, { taskId: "" }, { mainAgentId: "../other" }]) {
    assert.equal(parseClientMessage({ ...target, ...change }), undefined);
  }
  assert.deepEqual(parseClientMessage({ type: "task.delete", workflowId: "flow-one", taskId: "task-one" }),
    { type: "task.delete", workflowId: "flow-one", taskId: "task-one" });
});

test("runtime deletion invokes exact storage API and invalidates historical reads after acknowledgement", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/project");
  let stored = [{ id: "flow-one" }];
  client.readProjectTasks = async () => stored;
  assert.equal((await client.listProjectTasks()).length, 1);
  const commands = [];
  client.command = async args => {
    commands.push(args);
    stored = [];
    return { kind: "task-history-deleted", mainAgentId: "main-one", workflowId: "flow-one", taskId: "task-one", deletedRuns: [] };
  };
  await client.deleteTask("main-one", "flow-one", "task-one");
  assert.deepEqual(commands[0].slice(0, 9), ["delete-task", "--project-root", "/project", "--main-agent", "main-one",
    "--workflow-id", "flow-one", "--task-id", "task-one"]);
  assert.ok(commands[0].includes("human"));
  assert.equal((await client.listProjectTasks()).length, 0, "The old project history cache is discarded");
  await assert.rejects(client.deleteTask("main-one", "../flow", "task-one"));
  assert.equal(commands.length, 1, "Invalid identity never reaches the runtime");
});

test("runtime deletion rejects failure and mismatched acknowledgements without clearing stored history", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/project");
  client.readProjectTasks = async () => [{ id: "flow-one" }];
  const cached = await client.listProjectTasks();
  client.command = async () => { throw new Error("Task process still owns its history"); };
  await assert.rejects(client.deleteTask("main-one", "flow-one", "task-one"), /still owns/);
  assert.equal(await client.listProjectTasks(), cached);
  client.command = async () => ({ kind: "task-history-deleted", mainAgentId: "main-one", workflowId: "other", taskId: "task-one" });
  await assert.rejects(client.deleteTask("main-one", "flow-one", "task-one"), /acknowledg/i);
  assert.equal(await client.listProjectTasks(), cached);
});

test("real Host client deletes runtime files and fresh clients cannot restore them", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const base = await mkdtemp(join(tmpdir(), "af-history-delete-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project"), home = join(base, "home");
  await mkdir(project);
  const script = new URL("../../../plugin/scripts/exec.py", import.meta.url).pathname;
  const { stdout } = await promisify(execFile)("python3", [script, "init", "--project-root", project, "--runtime-home", home]);
  const binding = JSON.parse(stdout);
  const store = async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const parent = join(binding.agentsRoot, "main-history", "runs", "run-parent");
  const worker = join(binding.agentsRoot, "work-history");
  await store(join(binding.agentsRoot, "main-history", "session.json"), { role: "main" });
  await store(join(parent, "state.json"), { role: "main" });
  await store(join(parent, "events.jsonl"), "Main conversation remains\n");
  for (const [workflowId, taskId, runId, loopId] of [["flow-delete", "task-delete", "run-delete", "loop-delete"],
    ["flow-keep", "task-keep", "run-keep", "loop-keep"]]) {
    await store(join(worker, "runs", runId, "state.json"), { agentId: "work-history", runId, role: "work", status: "completed",
      parentAgentId: "main-history", parentRunId: "run-parent", taskBinding: { workflowId, taskId } });
    await store(join(worker, "runs", runId, "result.md"), taskId);
    await store(join(worker, "loops", loopId, "state.json"), { status: "completed", loopId, parentStatePath: join(parent, "state.json"),
      workflow: { id: workflowId, title: workflowId, tasks: [{ id: taskId, title: taskId, workStatus: "completed" }] } });
  }
  await store(join(parent, "children", "work-history.json"), { parentAgentId: "main-history", parentRunId: "run-parent", agentId: "work-history", runId: "run-delete" });
  const client = () => {
    const value = new AgentFactoryClient(script, project);
    value.location = async () => binding;
    return value;
  };
  const original = client();
  assert.deepEqual((await original.listProjectTasks()).map(entry => entry.id).sort(), ["flow-delete", "flow-keep"]);
  const deleted = await original.deleteTask("main-history", "flow-delete", "task-delete");
  assert.equal(deleted.kind, "task-history-deleted");
  await assert.rejects(readFile(join(worker, "runs", "run-delete", "result.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(worker, "loops", "loop-delete", "state.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(worker, "runs", "run-keep", "result.md"), "utf8"), "task-keep");
  assert.equal(await readFile(join(parent, "events.jsonl"), "utf8"), "Main conversation remains\n");
  assert.equal(JSON.parse(await readFile(join(parent, "children", "work-history.json"), "utf8")).runId, "run-keep");
  for (const fresh of [original, client()]) assert.deepEqual((await fresh.listProjectTasks()).map(entry => entry.id), ["flow-keep"]);
});
