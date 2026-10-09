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
  assert.equal(first.tasks[0].description.length, 5000, "The complete original remains accessible");
  assert.deepEqual(Object.keys(first.tasks[0]).sort(), ["description", "id", "runs", "title", "workStatus"], "Only known task fields leave the host");
  assert.equal(JSON.stringify(entries).includes(agentsRoot), false);
});

test("project task protocol carries only the request type", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "project.tasks.request", extra: 1 }), { type: "project.tasks.request" });
});


test("control center projects accepted allocation, bound receipt and observed usage without driving work", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-center-")); t.after(() => rm(root, {recursive:true, force:true}));
  const agentsRoot = join(root, "agents");
  const allocation = {schemaVersion:1, unitReason:"One shared owner", profile:{id:"work",reason:"Integration"}, session:{strategy:"reuse",reason:"Same task"}, readScope:["src/"], writeScopeReason:"src/main.ts", parallelCandidate:false, inputs:[{source:"message-exact",revision:"revision-1",capturedAt:"2026-10-07T20:00:00Z",confirmed:true}], dependencies:[{taskId:"prior",source:"prior receipt",revision:"r1",capturedAt:"2026-10-07T20:00:00Z",confirmed:true}], sharedResources:[{resource:"src/main.ts",ownerTaskId:"self",confirmed:true,evidence:"Main handoff"}], secret:"DO_NOT_PROJECT"};
  await writeLoop(agentsRoot,"worker","loop-center",{status:"completed",phase:"ended",workAgentId:"worker",parentStatePath:join(agentsRoot,"main","runs","parent","state.json"),workflow:{id:"flow-center",title:"Actual task",tasks:[{id:"task-center",title:"Integrate",description:"Original / interpretation / assumptions",completionCriteria:"Works",allocation,workStatus:"completed",workAgentId:"worker",workRunId:"run-center"}]}});
  const runDir=join(agentsRoot,"worker","runs","run-center");await mkdir(runDir,{recursive:true});
  const state={agentId:"worker",runId:"run-center",role:"work",status:"completed",parentRunId:"parent",taskBinding:{workflowId:"flow-center",taskId:"task-center"},receiptRequestHash:"hash-exact",executionOptions:{model:"fixed-model"},tokenUsage:{inputTokens:100,cachedInputTokens:20,outputTokens:30,reasoningOutputTokens:10},contextUsage:{usedTokens:80,contextWindowTokens:100,observedAt:"2026-10-07T20:01:00Z",estimated:true},handoffBinding:{slot:"B",epoch:2},attempt:2,finishedAt:"2026-10-07T20:02:00Z",secret:"DO_NOT_PROJECT"};
  await writeFile(join(runDir,"state.json"),JSON.stringify(state));
  await writeFile(join(runDir,"receipt.json"),JSON.stringify({runId:"run-center",requestHash:"hash-exact",outcome:"completed",tests:{run:true,reason:"Own checks"}}));
  const client=new AgentFactoryClient(join(root,"exec.py"),root);client.location=async()=>({home:root,projectId:"project-test",agentsRoot});
  const [entry]=await client.listProjectTasks(); const task=entry.tasks[0],run=task.runs[0];
  assert.equal(entry.loopId,"loop-center");assert.equal(entry.mainAgentId,"main");assert.equal(task.allocation.inputs[0].revision,"revision-1");
  assert.deepEqual(run.usage,{inputTokens:100,cachedInputTokens:20,outputTokens:30,reasoningOutputTokens:10});assert.equal(run.receipt.outcome,"completed");assert.equal(run.handoff.epoch,2);
  assert.equal(JSON.stringify(entry).includes("DO_NOT_PROJECT"),false);
  const records=await client.projectTaskRecords(entry.id,task.id); assert.ok(records.some(value=>value.name.endsWith("receipt.json")));assert.equal((await client.projectTaskRecords("unbound","task-center")).length,0);
  state.receiptRequestHash="other"; state.tokenUsage={inputTokens:100};await writeFile(join(runDir,"state.json"),JSON.stringify(state));client.projectTaskCache.deleteWhere(()=>true);
  const fresh=(await client.listProjectTasks())[0].tasks[0].runs[0];assert.equal(fresh.receipt,undefined);assert.equal(fresh.usage.outputTokens,null);
});
