import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.deepEqual(Object.keys(first.tasks[0]).sort(), ["commands", "description", "id", "runs", "title", "workAgentId", "workStatus"], "Only known task fields leave the host");
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
  await writeLoop(agentsRoot,"worker","loop-center",{status:"completed",phase:"ended",workAgentId:"worker",parentStatePath:join(agentsRoot,"main","runs","parent","state.json"),workflow:{id:"flow-center",title:"Actual task",tasks:[{id:"task-center",title:"Integrate",description:"Original / interpretation / assumptions",completionCriteria:"Works",allocation,workStatus:"completed",workAgentId:"worker",workRunId:"run-center",verificationAgentId:"verifier",verificationRunId:"run-verifying"}]}});
  const runDir=join(agentsRoot,"worker","runs","run-center");await mkdir(runDir,{recursive:true});
  const state={agentId:"worker",runId:"run-center",role:"work",status:"completed",parentRunId:"parent",taskBinding:{workflowId:"flow-center",taskId:"task-center"},receiptRequestHash:"hash-exact",resultPath:join(runDir,"result.md"),executionOptions:{model:"fixed-model"},provider:"claude",tokenUsage:{inputTokens:100,cachedInputTokens:20,outputTokens:30,reasoningOutputTokens:10},contextUsage:{usedTokens:80,contextWindowTokens:100,observedAt:"2026-10-07T20:01:00Z",estimated:true},handoffBinding:{slot:"B",epoch:2},attempt:2,finishedAt:"2026-10-07T20:02:00Z",secret:"DO_NOT_PROJECT"};
  await writeFile(join(runDir,"state.json"),JSON.stringify(state));
  await writeFile(join(runDir,"receipt.json"),JSON.stringify({runId:"run-center",requestHash:"hash-exact",outcome:"completed",tests:{run:true,reason:"Own checks"},changedPaths:["src/main.ts",99]}));
  await writeFile(join(runDir,"result.md"), "Implemented actual runtime connection.\n\nRemaining: GUI check.\n");
  await writeFile(join(runDir,"request.md"), "# Goal\nIntegrate.\n");
  const verifyDir=join(agentsRoot,"verifier","runs","run-verifying");await mkdir(verifyDir,{recursive:true});
  const verificationState={agentId:"verifier",runId:"run-verifying",role:"verification",status:"completed",requestHash:"verify-hash",verifiedWorkRunId:"run-center",taskBinding:{workflowId:"flow-center",taskId:"task-center"}};
  const verificationReceipt={schemaVersion:"0.1.0",kind:"verification-receipt",runId:"run-verifying",verifiedWorkRunId:"run-center",verifiedRequestHash:"verify-hash",decision:"fail",findings:[{id:"finding-one",path:"src/view.ts",location:"result link",problem:"Wrong target",evidence:"Recorded source mismatch",correction:"Bind exact run",secret:"DO_NOT_PROJECT"}],secret:"DO_NOT_PROJECT"};
  await writeFile(join(verifyDir,"state.json"),JSON.stringify(verificationState));await writeFile(join(verifyDir,"receipt.json"),JSON.stringify(verificationReceipt));

  const client=new AgentFactoryClient(join(root,"exec.py"),root);client.location=async()=>({home:root,projectId:"project-test",agentsRoot});
  const [entry]=await client.listProjectTasks(); const task=entry.tasks[0],run=task.runs[0];
  assert.equal(entry.loopId,"loop-center");assert.equal(entry.mainAgentId,"main");assert.equal(task.allocation.inputs[0].revision,"revision-1");
  assert.deepEqual(run.usage,{inputTokens:100,cachedInputTokens:20,outputTokens:30,reasoningOutputTokens:10});assert.equal(run.receipt.outcome,"completed");assert.equal(run.handoff.epoch,2);
  assert.equal(task.workAgentId,"worker");
  assert.equal(run.result.summary,"Implemented actual runtime connection.");
  // The summary is the first prose line; a bare heading such as "Summary" is used only when nothing else exists.
  const {resultSummaryLine}=await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  // Outcome line: a stated value/count/remaining problem wins over narration; boilerplate and long commands are dropped;
  // nothing is added. Without a stated outcome it is undefined so the list falls back to the first sentence.
  const {resultHighlight}=await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.equal(resultHighlight("작업 B의 계산 명령을 실행했습니다. 표준 출력은 `55`, 종료 코드는 `0`입니다. 교훈 조회 결과 기록은 없었습니다. 별도 Verification은 요청되지 않았습니다."),"표준 출력은 55, 종료 코드는 0입니다.");
  assert.equal(resultHighlight("작업 A의 `python3 -c 'print(sum(range(1, 6)))'` 실행 결과는 stdout `15`, 종료 코드 `0`입니다. 기존 작업트리 변경은 보존했습니다."),"작업 A의 실행 결과는 stdout 15, 종료 코드 0입니다.");
  assert.equal(resultHighlight("48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다. 수행 시간은 약 16분입니다."),"48개 고유 사례를 각각 3회 실행하여 본시험 144회가 모두 통과했습니다.");
  assert.equal(resultHighlight("작업을 마쳤습니다. 별도 Verification은 요청되지 않았습니다. lesson audit missing은 비어 있습니다."),undefined,"No stated outcome: no highlight");
  assert.equal(resultHighlight("## 결론\n\n기능을 정리했습니다.\n\n| 범주 | 실행 |\n|---|---|\n| A | 18/18 통과 |\n"),undefined,"Tables and later sections are not mined");
  assert.equal(resultHighlight("문서: `docs/a.md`, `docs/b.md`\n: 제안 10개와 금지 항목 3개를 담았습니다."),"제안 10개와 금지 항목 3개를 담았습니다.","Leading punctuation is not kept");
  assert.equal(resultHighlight("남은 문제: 설치본에는 operation_records.py가 없어 2건이 실패합니다."),"남은 문제: 설치본에는 operation_records.py가 없어 2건이 실패합니다.");
  for (const [text,expected] of [["## Summary\n\n- **Done:** wired the list.\n","**Done:** wired the list."],["# Result only\n","Result only"],["| a | b |\n\nPlain line\n","Plain line"],["\n\n",undefined]]) assert.equal(resultSummaryLine(text),expected);
  assert.deepEqual(run.request,{availability:"recorded"},"The run's request.md is projected by presence only");
  assert.equal(run.model,"fixed-model");assert.equal(run.provider,"claude","The provider identifies a run whose model is the provider default");
  assert.equal(run.result.availability,"recorded");
  assert.deepEqual(run.receipt.changedPaths,["src/main.ts"]);
  assert.equal(task.runs[1].receipt,undefined,"Verification is not a Work own-check receipt");
  assert.equal(task.runs[1].verification.decision,"fail");assert.equal(task.runs[1].verification.verifiedWorkRunId,"run-center");
  assert.equal(task.runs[1].verification.findings[0].evidence,"Recorded source mismatch");

  assert.equal(JSON.stringify(entry).includes("DO_NOT_PROJECT"),false);
  const records=await client.projectTaskRecords(entry.id,task.id); assert.ok(records.some(value=>value.name.endsWith("receipt.json")));assert.equal((await client.projectTaskRecords("unbound","task-center")).length,0);
  state.receiptRequestHash="other"; state.tokenUsage={inputTokens:100};await writeFile(join(runDir,"state.json"),JSON.stringify(state));client.projectTaskCache.deleteWhere(()=>true);
  const fresh=(await client.listProjectTasks())[0].tasks[0].runs[0];assert.equal(fresh.receipt,undefined);assert.equal(fresh.usage.outputTokens,null);
  verificationReceipt.verifiedWorkRunId="another-work";await writeFile(join(verifyDir,"receipt.json"),JSON.stringify(verificationReceipt));client.projectTaskCache.deleteWhere(()=>true);
  assert.equal((await client.listProjectTasks())[0].tasks[0].runs[1].verification,undefined,"A different Work target cannot supply a Verification decision");
  verificationReceipt.verifiedWorkRunId="run-center";verificationReceipt.decision="pass";verificationReceipt.findings=[];await writeFile(join(verifyDir,"receipt.json"),JSON.stringify(verificationReceipt));client.projectTaskCache.deleteWhere(()=>true);
  assert.equal((await client.listProjectTasks())[0].tasks[0].runs[1].verification.decision,"pass");
  verificationReceipt.verifiedRequestHash="another-hash";await writeFile(join(verifyDir,"receipt.json"),JSON.stringify(verificationReceipt));client.projectTaskCache.deleteWhere(()=>true);
  assert.equal((await client.listProjectTasks())[0].tasks[0].runs[1].verification,undefined,"Hash-mismatched inspection evidence remains unconfirmed");

});


test("worker projection distinguishes assigned missing runs, missing results, result read errors and scoped integration", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-worker-projection-")); t.after(() => rm(root, {recursive:true,force:true}));
  const agentsRoot = join(root,"agents"), runDir = join(agentsRoot,"worker","runs","run-result");
  await mkdir(runDir,{recursive:true});
  await writeLoop(agentsRoot,"worker","loop-worker",{status:"active",execution:{taskMode:"work"},taskWorkspaces:{"task-result":{repositories:[{repositoryRoot:"extension",phase:"integrated",mergeCommit:"merge-exact",secret:"DO_NOT_PROJECT"}]}},workflow:{id:"flow-worker",title:"Recorded flow",tasks:[
    {id:"task-assigned",title:"Awaiting run",workAgentId:"worker",workStatus:"pending"},
    {id:"task-result",title:"Recorded result",workAgentId:"worker",workRunId:"run-result",workStatus:"completed"},
    {id:"task-unassigned",title:"Unassigned",workStatus:"pending"}]}});
  const state={agentId:"worker",runId:"run-result",role:"work",status:"completed",taskBinding:{workflowId:"flow-worker",taskId:"task-result"},resultPath:join(runDir,"result.md")};
  await writeFile(join(runDir,"state.json"),JSON.stringify(state));
  const client=new AgentFactoryClient(join(root,"exec.py"),root);client.location=async()=>({home:root,projectId:"project-test",agentsRoot});
  let tasks=(await client.listProjectTasks())[0].tasks;
  assert.equal(tasks[0].workAgentId,"worker");assert.deepEqual(tasks[0].runs,[]);
  assert.equal(tasks[2].workAgentId,undefined);assert.equal(tasks[1].verificationDisposition,"not-requested");
  assert.equal(tasks[1].runs[0].result.availability,"missing");
  assert.equal(tasks[1].runs[0].request.availability,"missing","A run without request.md says so");
  assert.deepEqual(tasks[1].integration,[{repository:"extension",phase:"integrated",mergeCommit:"merge-exact"}]);
  await writeFile(join(runDir,"result.md"),"");client.projectTaskCache.deleteWhere(()=>true);
  const emptyResult=(await client.listProjectTasks())[0].tasks[1].runs[0].result;
  assert.equal(emptyResult.availability,"recorded");assert.equal(emptyResult.summary,undefined,"An empty recorded file is distinct from a missing file");
  state.resultPath=join(root,"outside.md");await writeFile(join(runDir,"state.json"),JSON.stringify(state));client.projectTaskCache.deleteWhere(()=>true);
  tasks=(await client.listProjectTasks())[0].tasks;assert.equal(tasks[1].runs[0].result.availability,"error");
  state.taskBinding.taskId="other-task";await writeFile(join(runDir,"state.json"),JSON.stringify(state));client.projectTaskCache.deleteWhere(()=>true);
  assert.deepEqual((await client.listProjectTasks())[0].tasks[1].runs,[],"A reused agent cannot attach another task's result");
  state.taskBinding.taskId="task-result";state.role="verification";await writeFile(join(runDir,"state.json"),JSON.stringify(state));client.projectTaskCache.deleteWhere(()=>true);
  assert.deepEqual((await client.listProjectTasks())[0].tasks[1].runs,[],"An execution role mismatch cannot attach a result");
  await writeLoop(agentsRoot,"worker","loop-fallback",{status:"active",workAgentId:"worker-default",workflow:{id:"flow-fallback",title:"Explicit loop assignment",tasks:[{id:"task-default",title:"Awaiting dispatch",workStatus:"pending"}]}});
  client.projectTaskCache.deleteWhere(()=>true);
  const fallback=(await client.listProjectTasks()).find(entry=>entry.id==="flow-fallback").tasks[0];
  assert.equal(fallback.workAgentId,"worker-default");assert.deepEqual(fallback.runs,[],"An explicit assignment does not establish a running worker");
});

test("control center projects the recorded allocation domain and leaves missing or invalid domains unclassified", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-domain-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentsRoot = join(root, "agents");
  const allocation = domain => ({ schemaVersion: 1, unitReason: "u", writeScopeReason: "w", parallelCandidate: false, profile: { id: "work", reason: "r" },
    session: { strategy: "new", reason: "r" }, readScope: [], inputs: [], dependencies: [], sharedResources: [], ...(domain === undefined ? {} : { domain }) });
  await writeLoop(agentsRoot, "work-domain", "loop-domain", { status: "completed", createdAt: "2026-10-09T10:00:00Z", parentStatePath: join(agentsRoot, "main-a", "runs", "run-parent", "state.json"),
    workflow: { id: "brief-domain", title: "Domains", tasks: [
      { id: "task-ui", title: "UI", workAgentId: "work-domain", allocation: allocation("extension UI") },
      { id: "task-none", title: "No domain", workAgentId: "work-domain", allocation: allocation() },
      { id: "task-legacy", title: "No allocation", workAgentId: "work-domain" },
      { id: "task-bad", title: "Invalid", workAgentId: "work-domain", allocation: allocation("two\nlines") },
      { id: "task-title-only", title: "plugin runtime", workAgentId: "work-domain", domain: "unrecorded top-level guess" }] } });
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: root, projectId: "project-test", agentsRoot });
  const [entry] = await client.listProjectTasks();
  assert.deepEqual(entry.tasks.map(task => [task.id, task.domain]), [["task-ui", "extension UI"], ["task-none", undefined], ["task-legacy", undefined], ["task-bad", undefined], ["task-title-only", undefined]]);
  assert.equal(entry.tasks[0].allocation.domain, "extension UI");
});

test("project domains are read and edited through the plugin's domains.py as the Human, with errors kept", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-domains-")); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(join(root, "exec.py"), root, process.execPath);
  client.location = async () => ({ home: join(root, "home"), projectId: "project-test", agentsRoot: join(root, "agents") });
  assert.equal(await client.listProjectDomains(), undefined, "An older plugin without domains.py has no editable list");
  const log = join(root, "calls.jsonl");
  // A stand-in plugin script (run by node): records argv, then answers like domains.py.
  await writeFile(join(root, "domains.py"), `
    const fs = require("node:fs"); const argv = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
    const store = { schemaVersion: 1, kind: "project-domains", revision: 2, history: [{ actor: "ai" }],
      domains: [{ id: "domain-aaaaaaaaaaaa", name: "UI", aliases: ["ui old"], createdBy: { actor: "ai", at: "t", source: "loop one" }, nameSetBy: { actor: "human", at: "t", source: "control-center" }, secret: "x" },
        { id: "bad id", name: "dropped" }],
      assignments: { "work-a": { domainId: "domain-aaaaaaaaaaaa", setBy: { actor: "human", at: "t", source: "control-center" } }, "../bad": { domainId: null, setBy: {} }, "work-b": { domainId: "domain-ffffffffffff", setBy: {} } } };
    if (argv.includes("--name") && argv[argv.indexOf("--name") + 1] === "taken") { console.log(JSON.stringify({ kind: "error", error: { code: "domain_name_taken", message: "already exists" } })); process.exit(1); }
    console.log(JSON.stringify({ kind: "project-domains-result", ...(argv[0] === "create" ? { domainId: "domain-cccccccccccc" } : {}), domains: store }));`);
  const listed = await client.listProjectDomains();
  assert.deepEqual(listed, { revision: 2, domains: [{ id: "domain-aaaaaaaaaaaa", name: "UI", aliases: ["ui old"],
    createdBy: { actor: "ai", at: "t", source: "loop one" }, nameSetBy: { actor: "human", at: "t", source: "control-center" } }],
  assignments: { "work-a": { domainId: "domain-aaaaaaaaaaaa", setBy: { actor: "human", at: "t", source: "control-center" } } }, removedWorkers: {} }, "Only known, valid fields leave the host");
  const created = await client.editProjectDomains({ type: "domain.create", name: "Docs", revision: 2 });
  assert.equal(created.changedDomainId, "domain-cccccccccccc", "The created domain is reported so a worker can be placed in it");
  await client.editProjectDomains({ type: "domain.rename", domainId: "domain-aaaaaaaaaaaa", name: "UI shell", revision: 3 });
  await client.editProjectDomains({ type: "domain.assign", agentId: "work-a", domainId: "domain-aaaaaaaaaaaa", revision: 4 });
  await assert.rejects(client.editProjectDomains({ type: "domain.create", name: "taken", revision: 5 }), error => error.message === "already exists" && error.code === "domain_name_taken");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const scope = ["--project-root", root, "--runtime-home", join(root, "home"), "--project-id", "project-test"];
  assert.deepEqual(calls[0], ["list", ...scope]);
  assert.deepEqual(calls[1], ["create", ...scope, "--actor", "human", "--source", "control-center", "--expected-revision", "2", "--name", "Docs"]);
  assert.deepEqual(calls[2], ["rename", ...scope, "--actor", "human", "--source", "control-center", "--expected-revision", "3", "--domain-id", "domain-aaaaaaaaaaaa", "--name", "UI shell"]);
  assert.deepEqual(calls[3], ["assign", ...scope, "--actor", "human", "--source", "control-center", "--expected-revision", "4", "--agent", "work-a", "--domain-id", "domain-aaaaaaaaaaaa"]);
  // Only the real-domain calls are made: no --placeholder or --unclassified ever reaches domains.py.
  assert.equal(calls.flat().some(argument => ["--placeholder", "--unclassified"].includes(argument)), false);
});

test("domain edits are validated before they reach the host", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const ok = [{ type: "domain.create", name: "extension UI", revision: 0 }, { type: "domain.rename", domainId: "domain-0123456789ab", name: "UI", revision: 3 },
    { type: "domain.assign", agentId: "work-a", domainId: "domain-0123456789ab", revision: 1 }];
  for (const message of ok) assert.deepEqual(parseClientMessage({ ...message, extra: 1 }), message);
  for (const message of [{ type: "domain.create", name: "", revision: 0 }, { type: "domain.create", name: " padded", revision: 0 }, { type: "domain.create", name: "a\nb", revision: 0 },
    { type: "domain.create", name: "x".repeat(81), revision: 0 }, { type: "domain.create", placeholder: true, name: "x", revision: 0 }, { type: "domain.create", placeholder: "yes", revision: 0 }, { type: "domain.create", name: "x", revision: -1 }, { type: "domain.create", name: "x" },
    { type: "domain.rename", domainId: "../x", name: "x", revision: 0 }, { type: "domain.assign", agentId: "../bad", domainId: null, revision: 0 },
    { type: "domain.assign", agentId: "work-a", domainId: "other", revision: 0 }, { type: "domain.assign", agentId: "work-a", revision: 0 },
    // A worker always belongs to a named domain: no unnamed (placeholder) domain and no "unclassified" (null) placement.
    { type: "domain.create", placeholder: true, revision: 2 }, { type: "domain.assign", agentId: "work-a", domainId: null, revision: 1 }]) {
    assert.equal(parseClientMessage(message), undefined, JSON.stringify(message));
  }
});

test("worker commands bind the exact running loop or start a same-session task; stop and removal check the worker", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-worker-control-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentsRoot = join(root, "agents"), log = join(root, "calls.jsonl");
  const parent = join(agentsRoot, "main-a", "runs", "run-parent", "state.json");
  await mkdir(dirname(parent), { recursive: true });
  await writeFile(parent, JSON.stringify({ executionPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "workspace-write" }, schemaVersion: 1 } }));
  const loop = (status, extra = {}) => ({ status, createdAt: extra.createdAt ?? "2026-10-10T00:00:00Z", parentStatePath: parent, latestWorkRunId: "run-live",
    execution: { taskBinding: { workflowId: "flow-live", taskId: "task-live" }, workProfile: "work", executionPolicy: { approvalPolicy: "never", schemaVersion: 1 },
      agentModels: { work: { model: "fixture-model", reasoningEffort: "medium" } }, agentPermissions: { work: { humanApprovalPolicy: "bypass" } } },
    workflow: { id: "flow-live", title: "Live", tasks: [{ id: "task-live", title: "Live task", description: "Original request\nline two", workAgentId: "worker-live" }] }, ...extra });
  await writeLoop(agentsRoot, "worker-live", "loop-live", loop("active", { steering: [
    { id: "s1", taskId: "task-live", runId: "run-live", message: "Delivered addition", actor: "human", authorizationReference: "secret-ref", evidence: "e", status: "delivered", continuationRunId: "run-next", createdAt: "2026-10-10T00:01:00Z" },
    { id: "s2", taskId: "task-live", runId: "run-live", message: "Waiting addition", actor: "ai", status: "queued", createdAt: "2026-10-10T00:02:00Z" }] }));
  await writeLoop(agentsRoot, "worker-idle", "loop-old", loop("completed", { createdAt: "2026-10-01T00:00:00Z", requestedBy: "human", parentStatePath: "/elsewhere/runs/x/state.json" }));
  await writeLoop(agentsRoot, "worker-idle", "loop-new", loop("completed", { createdAt: "2026-10-09T00:00:00Z",
    execution: { ...loop("completed").execution, agentModels: { work: { model: "newest-model" } } } }));
  // A stand-in plugin: records argv, environment and the request file, then answers like loop.py/domains.py.
  const fake = `const fs=require("node:fs");const argv=process.argv.slice(2);const file=argv[argv.indexOf("--request-file")+1];
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({script:require("node:path").basename(process.argv[1]),argv,parent:process.env.AGENT_FACTORY_PARENT_STATE||null,policy:process.env.AGENT_FACTORY_EXECUTION_POLICY||null,request:argv.includes("--request-file")?fs.readFileSync(file,"utf8"):null})+"\\n");
    if(argv.includes("--message")&&argv[argv.indexOf("--message")+1]==="fail"){console.log(JSON.stringify({kind:"error",error:{code:"steering_binding_invalid",message:"Addition must bind the current task and Work run"}}));process.exit(2);}
    console.log(JSON.stringify(argv[0]==="start"?{kind:"loop",loopId:"loop-created",status:"active"}:argv[0]==="remove-worker"?{kind:"project-domains-result",domains:{revision:3,domains:[],assignments:{},removedWorkers:{"worker-idle":{removedBy:{actor:"human",at:"t",source:"control-center"}}}}}:{kind:"loop",status:"cancelled"}));`;
  for (const name of ["loop.py", "domains.py"]) await writeFile(join(root, name), fake);
  const client = new AgentFactoryClient(join(root, "exec.py"), root, process.execPath);
  client.location = async () => ({ home: root, projectId: "project-test", agentsRoot });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const scope = ["--project-root", root, "--runtime-home", root, "--project-id", "project-test"];
  // Running worker: an addition to its exact loop/task/run, with that loop's parent and policy.
  assert.deepEqual(await client.sendWorkerCommand("worker-live", "Also check\nthe tests", "cmd-00000001", { loopId: "loop-live", runId: "run-live" }),
    { mode: "addition", loopId: "loop-live", runId: "run-live", taskId: "task-live" });
  let call = (await calls()).at(-1);
  assert.deepEqual(call.argv, ["steer", ...scope, "--work-agent", "worker-live", "--loop-id", "loop-live", "--actor", "human",
    "--authorization-reference", "control-center:worker-live:cmd-00000001", "--decision-evidence", "Human instruction from the control center",
    "--task-id", "task-live", "--run-id", "run-live", "--message", "Also check\nthe tests"]);
  assert.equal(call.parent, parent);
  assert.deepEqual(JSON.parse(call.policy), { approvalPolicy: "never", sandboxPolicy: { type: "workspace-write" }, schemaVersion: 1 }, "The parent Main run's policy, not a new one");
  // A stale screen (other run) is refused before anything runs; a plugin refusal keeps its code.
  const count = (await calls()).length;
  await assert.rejects(client.sendWorkerCommand("worker-live", "x", "cmd-00000002", { runId: "run-old" }), error => error.code === "worker_command_stale");
  assert.equal((await calls()).length, count);
  await assert.rejects(client.sendWorkerCommand("worker-live", "fail", "cmd-00000003"), error => error.code === "steering_binding_invalid");
  // Idle worker: a new task in the same session with its newest loop's model/permission/profile; the parent outside the project is not passed.
  assert.deepEqual(await client.sendWorkerCommand("worker-idle", "Start\nfollow-up", "cmd-00000004"), { mode: "task", loopId: "loop-created" });
  call = (await calls()).at(-1);
  assert.deepEqual(call.argv.filter((value, index) => call.argv[index - 1] !== "--request-file"),
    ["start", ...scope, "--work-agent", "worker-idle", "--requested-by", "human", "--task-mode", "work", "--request-file", "--receipt-recovery", "auto",
      "--work-model", "newest-model", "--work-execution-mode", "bypass", "--work-profile", "work"]);
  assert.equal(call.request, "Start\nfollow-up", "The Human's text is the request, unchanged");
  assert.equal(call.parent, parent);
  await assert.rejects(client.sendWorkerCommand("worker-idle", "x", "cmd-00000005", { loopId: "loop-old" }), error => error.code === "worker_command_stale");
  await assert.rejects(client.sendWorkerCommand("worker-none", "x", "cmd-00000006"), error => error.code === "worker_command_unsupported");
  await assert.rejects(client.sendWorkerCommand("../bad", "x", "cmd-00000007"));
  // Stop: only a loop of this worker holding the task; then exactly that loop's stop-task.
  await assert.rejects(client.stopWorkerTask("worker-idle", "loop-live", "flow-live", "task-live"), error => error.code === "worker_stop_scope");
  await assert.rejects(client.stopWorkerTask("worker-live", "loop-live", "flow-live", "task-other"), error => error.code === "worker_stop_scope");
  await client.stopWorkerTask("worker-live", "loop-live", "flow-live", "task-live");
  assert.deepEqual((await calls()).at(-1).argv, ["stop-task", ...scope, "--work-agent", "worker-live", "--loop-id", "loop-live", "--actor", "human",
    "--authorization-reference", "control-center:worker-live:loop-live:stop", "--decision-evidence", "Human selected Force stop in the control center",
    "--workflow-id", "flow-live", "--task-id", "task-live"]);
  // Removal goes to the shared list as the Human, with the revision the screen read.
  const removed = await client.removeWorker("worker-idle", 2);
  assert.deepEqual((await calls()).at(-1).argv, ["remove-worker", ...scope, "--actor", "human", "--source", "control-center", "--expected-revision", "2", "--agent", "worker-idle"]);
  assert.deepEqual(Object.keys(removed.removedWorkers), ["worker-idle"]);
  // Command history comes from the managed records only, with delivery state and target run; internal references stay out.
  const entries = await client.listProjectTasks();
  const live = entries.find(entry => entry.id === "flow-live" && entry.workAgentId === "worker-live");
  assert.equal(live.latestWorkRunId, "run-live");
  assert.deepEqual(live.tasks[0].commands, [
    { kind: "request", text: "Original request\nline two", sender: "main", at: "2026-10-10T00:00:00Z", status: "queued" },
    { kind: "addition", text: "Delivered addition", sender: "human", at: "2026-10-10T00:01:00Z", status: "delivered", runId: "run-next" },
    { kind: "addition", text: "Waiting addition", sender: "ai", at: "2026-10-10T00:02:00Z", status: "queued" }]);
  assert.equal(JSON.stringify(entries).includes("secret-ref"), false);
});

test("worker control messages are validated before reaching the host", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const ok = [{ type: "worker.command", agentId: "worker-a", text: "Do this\nnow", commandId: "cmd-12345678" },
    { type: "worker.command", agentId: "worker-a", text: "x", commandId: "cmd-12345678", loopId: "loop-a", runId: "run-a" },
    { type: "worker.stop", agentId: "worker-a", loopId: "loop-a", workflowId: "flow-a", taskId: "task-a" },
    { type: "worker.remove", agentId: "worker-a", revision: 0 }];
  for (const message of ok) assert.deepEqual(parseClientMessage({ ...message, extra: 1 }), message);
  for (const message of [{ type: "worker.command", agentId: "worker-a", text: "  ", commandId: "cmd-12345678" },
    { type: "worker.command", agentId: "../a", text: "x", commandId: "cmd-12345678" }, { type: "worker.command", agentId: "a", text: "x", commandId: "bad id" },
    { type: "worker.command", agentId: "a", text: "x".repeat(20001), commandId: "cmd-12345678" }, { type: "worker.stop", agentId: "a", loopId: "../x", workflowId: "f", taskId: "t" },
    { type: "worker.remove", agentId: "a", revision: -1 }, { type: "worker.remove", agentId: "a" }]) {
    assert.equal(parseClientMessage(message), undefined, JSON.stringify(message).slice(0, 80));
  }
});

test("a rework starts a new same-session task linked to the ended task and never steers a running one", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-worker-rework-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentsRoot = join(root, "agents"), log = join(root, "calls.jsonl");
  const loop = (status, workflowId, taskId, model, createdAt) => ({ status, createdAt, latestWorkRunId: "run-" + taskId,
    execution: { taskBinding: { workflowId, taskId }, workProfile: "work", agentModels: { work: { model, reasoningEffort: "high" } }, agentPermissions: { work: { humanApprovalPolicy: "bypass" } } },
    workflow: { id: workflowId, title: "Brief", tasks: [{ id: taskId, title: "Done task", workAgentId: "worker-a", workStatus: "completed" }] } });
  await writeLoop(agentsRoot, "worker-a", "loop-old", loop("completed", "flow-old", "task-old", "old-model", "2026-10-01T00:00:00Z"));
  await writeLoop(agentsRoot, "worker-a", "loop-new", loop("completed", "flow-new", "task-new", "new-model", "2026-10-09T00:00:00Z"));
  await writeLoop(agentsRoot, "worker-busy", "loop-done", loop("completed", "flow-done", "task-done", "m", "2026-10-01T00:00:00Z"));
  await writeLoop(agentsRoot, "worker-busy", "loop-run", loop("active", "flow-run", "task-run", "m", "2026-10-09T00:00:00Z"));
  const fake = `const fs=require("node:fs");const argv=process.argv.slice(2);const file=argv[argv.indexOf("--request-file")+1];
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,request:argv.includes("--request-file")?fs.readFileSync(file,"utf8"):null})+"\\n");
    console.log(JSON.stringify({kind:"loop",loopId:"loop-rework",status:"active"}));`;
  await writeFile(join(root, "loop.py"), fake);
  const client = new AgentFactoryClient(join(root, "exec.py"), root, process.execPath);
  client.location = async () => ({ home: root, projectId: "project-test", agentsRoot });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  // The ended task's own loop supplies the settings, not the worker's newest loop.
  assert.deepEqual(await client.sendWorkerCommand("worker-a", "Fix the empty state", "cmd-00000011", { rework: { workflowId: "flow-old", taskId: "task-old" } }),
    { mode: "task", loopId: "loop-rework", rework: { workflowId: "flow-old", taskId: "task-old" } });
  const call = (await calls()).at(-1);
  assert.equal(call.argv[0], "start");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--work-model"), call.argv.indexOf("--work-model") + 2), ["--work-model", "old-model"]);
  assert.match(call.request, /^Rework of task task-old \(Done task\)\nEarlier workflow flow-old, loop loop-old, latest Work run run-task-old\./);
  assert.ok(call.request.endsWith("\n\nFix the empty state"), "The Human's text follows the reference unchanged");
  // Busy worker, a task of another worker, or a rework that also names a loop: refused before anything runs.
  const count = (await calls()).length;
  await assert.rejects(client.sendWorkerCommand("worker-busy", "x", "cmd-00000012", { rework: { workflowId: "flow-done", taskId: "task-done" } }), error => error.code === "worker_rework_busy");
  await assert.rejects(client.sendWorkerCommand("worker-a", "x", "cmd-00000013", { rework: { workflowId: "flow-done", taskId: "task-done" } }), error => error.code === "worker_rework_scope");
  await assert.rejects(client.sendWorkerCommand("worker-a", "x", "cmd-00000014", { loopId: "loop-old", rework: { workflowId: "flow-old", taskId: "task-old" } }));
  assert.equal((await calls()).length, count);
});

test("provider handoff runs loop.py handoff as the Human for an unfinished loop; supervision is a dry run with display fields only", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-worker-handoff-")); t.after(() => rm(root, { recursive: true, force: true }));
  const agentsRoot = join(root, "agents"), log = join(root, "calls.jsonl");
  const loop = (status, extra = {}) => ({ status, createdAt: "2026-10-10T00:00:00Z", latestWorkRunId: "run-a", execution: { taskBinding: { workflowId: "flow-a", taskId: "task-a" } },
    workflow: { id: "flow-a", title: "Brief", tasks: [{ id: "task-a", title: "Task A", workAgentId: "worker-a", workStatus: "running" }] }, ...extra });
  await writeLoop(agentsRoot, "worker-a", "loop-a", loop("runtime-error", { handoffs: [{ id: "handoff-0", taskId: "task-a", fromAgentId: "worker-0", toAgentId: "worker-a", fromProvider: "codex", toProvider: "codex",
    fromModel: "m0", toModel: "m1", reason: "earlier", actor: "human", createdAt: "2026-10-09T00:00:00Z", authorizationReference: "secret-ref", decisionEvidence: "e", bundlePath: "/x" }] }));
  await writeLoop(agentsRoot, "worker-a", "loop-done", loop("completed", { workflow: { id: "flow-done", title: "Done", tasks: [{ id: "task-d", title: "Done", workAgentId: "worker-a", workStatus: "completed" }] } }));
  const fake = `const fs=require("node:fs");const argv=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({script:require("node:path").basename(process.argv[1]),argv})+"\\n");
    if(argv[0]==="supervise"){console.log(JSON.stringify({kind:"supervision",schemaVersion:1,observedAt:"t",settings:{delayMinutes:20,stuckMinutes:60},alerts:[],errors:[{source:"/p",error:"E"}],
      verdicts:[{loopId:"loop-a",taskId:"task-a",title:"Task A",verdict:"stuck",state:"blocked",reasons:["no-progress",3],elapsedSeconds:10,idleSeconds:5,waitingSeconds:null,nextAction:"inspect",statePath:"/secret/state.json",line:"x"}]}));}
    else console.log(JSON.stringify({kind:"loop",status:"active",handoff:{id:"handoff-1",toAgentId:argv[argv.indexOf("--to-agent")+1],toModel:argv[argv.indexOf("--to-model")+1]}}));`;
  for (const name of ["loop.py", "operation_records.py"]) await writeFile(join(root, name), fake);
  const client = new AgentFactoryClient(join(root, "exec.py"), root, process.execPath);
  client.location = async () => ({ home: root, projectId: "project-test", agentsRoot });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const scope = ["--project-root", root, "--runtime-home", root, "--project-id", "project-test"];
  // A stopped (runtime-error) loop can move; the new session ID is generated and never reuses the worker's.
  const result = await client.handoffWorker("worker-a", "loop-a", "claude-opus-5-5", "limit\nreached", "control-center:worker-a:loop-a:handoff:1");
  const call = (await calls()).at(-1);
  const toAgent = call.argv[call.argv.indexOf("--to-agent") + 1];
  assert.match(toAgent, /^work-handoff-\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.deepEqual(call.argv, ["handoff", ...scope, "--work-agent", "worker-a", "--loop-id", "loop-a", "--actor", "human",
    "--authorization-reference", "control-center:worker-a:loop-a:handoff:1", "--decision-evidence", "Human selected Provider handoff in the control center",
    "--to-agent", toAgent, "--to-model", "claude-opus-5-5", "--reason", "limit\nreached"]);
  assert.deepEqual(result, { id: "handoff-1", toAgentId: toAgent, toModel: "claude-opus-5-5" });
  const count = (await calls()).length;
  await assert.rejects(client.handoffWorker("worker-a", "loop-done", "m", "r", "ref"), error => error.code === "worker_handoff_scope");
  await assert.rejects(client.handoffWorker("worker-b", "loop-a", "m", "r", "ref"), error => error.code === "worker_handoff_scope");
  assert.equal((await calls()).length, count, "Ended or foreign loops are refused before anything runs");
  // Supervision: --dry-run, known fields only (no state path), reasons kept as strings.
  const report = await client.superviseProject();
  assert.deepEqual((await calls()).at(-1), { script: "operation_records.py", argv: ["supervise", ...scope, "--dry-run"] });
  assert.deepEqual(report, { observedAt: "t", settings: { delayMinutes: 20, stuckMinutes: 60 }, alerts: [], errors: ["E"],
    verdicts: [{ loopId: "loop-a", taskId: "task-a", title: "Task A", verdict: "stuck", state: "blocked", nextAction: "inspect", elapsedSeconds: 10, idleSeconds: 5, reasons: ["no-progress"] }] });
  // Recorded handoffs reach the control center without their authorization details.
  const entry = (await client.listProjectTasks()).find(value => value.loopId === "loop-a");
  assert.deepEqual(entry.handoffs, [{ id: "handoff-0", fromAgentId: "worker-0", toAgentId: "worker-a", taskId: "task-a", fromProvider: "codex", toProvider: "codex",
    fromModel: "m0", toModel: "m1", reason: "earlier", actor: "human", createdAt: "2026-10-09T00:00:00Z" }]);
});
