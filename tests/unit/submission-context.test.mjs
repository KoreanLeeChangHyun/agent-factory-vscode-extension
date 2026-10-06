import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const exec = promisify(execFile);
const { parseGitStatus, collectGitStatus, submissionContext } = await importTypeScript("src/infrastructure/agent-factory/submission-context.ts");
const { historyPresentation } = await importTypeScript("src/infrastructure/agent-factory/history-presentation.ts");
const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "af-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const context = guidance => JSON.parse(guidance.split("\n")[3]);

test("porcelain parsing preserves literal filenames and rename source paths", () => {
  assert.deepEqual(parseGitStatus(Buffer.from(' M space name\0?? tab\tline\n"quote"\0R  new\nname\0old\tname\0 D removed\0')), [
    { status: " M", path: "space name" }, { status: "??", path: 'tab\tline\n"quote"' },
    { status: "R ", path: "new\nname", originalPath: "old\tname" }, { status: " D", path: "removed" }
  ]);
  assert.throws(() => parseGitStatus(Buffer.from(" M missing terminator")));
  assert.throws(() => parseGitStatus(Buffer.from("R  missing source\0")));
  assert.throws(() => parseGitStatus(Buffer.from([63, 63, 32, 255, 0])));
});

test("Git snapshots distinguish clean, non-Git and failed lookup and omit ignored contents", async t => {
  const root = await directory(t);
  const absent = await collectGitStatus(root);
  assert.equal(absent.availability, "unavailable");
  assert.equal(absent.reason, "not-git");
  assert.equal("changes" in absent, false);
  const failed = await collectGitStatus(join(root, "missing"));
  assert.equal(failed.availability, "unavailable");
  assert.equal(failed.reason, "collection-failed");
  await exec("git", ["init", "--quiet", root]);
  assert.deepEqual((await collectGitStatus(root)).changes, []);
  await writeFile(join(root, ".gitignore"), "secret.txt\n");
  await writeFile(join(root, "secret.txt"), "secret body");
  await writeFile(join(root, "space\tline\n.txt"), "private body");
  const snapshot = await collectGitStatus(root);
  assert.equal(snapshot.availability, "available");
  assert.ok(snapshot.changes.some(change => change.path === "space\tline\n.txt"));
  assert.ok(!snapshot.changes.some(change => change.path === "secret.txt"));
  assert.ok(!JSON.stringify(snapshot).includes("private body"));
  assert.ok(Date.parse(snapshot.collectedAt) >= Date.parse(snapshot.collectionStartedAt));
});

test("current plugin layout resolves the Agent Skill beside scripts/", async t => {
  const root = await directory(t);
  const agent = join(root, "skills", "agent");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "SKILL.md"), "# Agent\n");
  const supplied = context(await submissionContext(root, join(root, "scripts", "exec.py")));
  assert.equal(supplied.instructions[0].source, join(agent, "SKILL.md"));
  assert.match(supplied.instructions[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(supplied.references[0].source, join(agent, "references", "execution-modes.md"));
});

test("dispatch instructions have a recoverable content identity instead of a repeated body", async t => {
  const root = await directory(t);
  const agent = join(root, "skills", "agent");
  await mkdir(join(agent, "scripts"), { recursive: true });
  const skill = "# Existing runtime instructions\nKeep authority checks.\n";
  await writeFile(join(agent, "SKILL.md"), skill);
  {
    const guidance = await submissionContext(root, join(agent, "scripts", "exec.py"));
    const supplied = context(guidance);
    assert.equal("automaticRequestHash" in supplied, false);
    assert.equal(supplied.instructions.length, 1);
    assert.equal(supplied.references.length, 2);
    assert.ok(supplied.references.every(ref => ref.availability === "not-loaded"));
    assert.equal(supplied.instructions[0].source, join(agent, "SKILL.md"));
    assert.equal(supplied.instructions[0].text, undefined);
    assert.equal(supplied.instructions[0].availability, "not-loaded");
    assert.match(supplied.instructions[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(!guidance.includes(skill));
    assert.equal(supplied.references[0].source, join(agent, "references", "execution-modes.md"));
    assert.equal(supplied.references[1].source, join(agent, "references", "task-dispatch.md"));
    const restored = historyPresentation("원문\n" + guidance, "work", false);
    assert.equal(restored.text, "원문\n");
    assert.equal(restored.submission.guidance, guidance);
    assert.equal(restored.text + restored.submission.guidance, "원문\n" + guidance);
  }
});

test("queued requests collect at dispatch and expose the exact accepted guidance", { timeout: 15000 }, async t => {
  const root = await directory(t);
  await exec("git", ["init", "--quiet", root]);
  const client = new AgentFactoryClient(join(root, "skills/agent/scripts/exec.py"), root);
  const supported = { model: true, reasoning: true, fast: true, goal: true, taskModes: ["work", "direct"], automaticRequestHash: true };
  client.capabilities = async () => ({ submit: supported, send: supported });
  const sent = [], shown = [], errors = [];
  client.command = async args => {
    const text = args.includes("--message") ? args[args.indexOf("--message") + 1]
      : await readFile(args[args.indexOf("--request-file") + 1], "utf8");
    sent.push(text);
    return { kind: "ack", status: "accepted", agentId: "main-context", runId: `run-${sent.length}` };
  };
  let release, entered;
  const blocked = new Promise(done => { release = done; });
  const running = new Promise(done => { entered = done; });
  client.activeRun = async () => undefined;
  client.listChildSessions = async () => [];
  client.updates = async () => ({ cursor: 0, updates: [] });
  client.status = async (_agent, runId) => {
    if (runId === "run-1") { entered(); await blocked; }
    return { status: "completed" };
  };
  client.result = async () => ({ status: "completed", text: "done" });
  const controller = new ChatSessionController(client, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {}, onError(error) { errors.push(error); }
  }, "main-context", { pollIntervalMs: 0 });
  const first = controller.send("first", [], { taskMode: "work" });
  await running;
  const second = controller.send("second", [], { taskMode: "work" }, submission => shown.push(submission));
  await writeFile(join(root, "queued-change.txt"), "changed while queued");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(errors, []);
  const before = context(historyPresentation(sent[0], "work", false).submission.guidance.slice(
    historyPresentation(sent[0], "work", false).submission.guidance.indexOf("\n\n[Managed submission")));
  const restored = historyPresentation(sent[1], "work", false);
  const marker = restored.submission.guidance.indexOf("\n\n[Managed submission");
  const after = context(restored.submission.guidance.slice(marker));
  assert.deepEqual(before.git.changes, []);
  assert.ok(after.git.changes.some(change => change.path === "queued-change.txt"));
  assert.equal(restored.text, "second");
  assert.equal(shown[0].guidance, restored.submission.guidance);
  assert.equal("automaticRequestHash" in after, false);
  const direct = await client.send("main-context", "plain text", { taskMode: "direct" });
  assert.equal(direct.preparationGuidance, undefined);
  assert.equal(sent[2], "plain text");
  delete supported.automaticRequestHash;
  const legacy = await client.send("main-context", "legacy", { taskMode: "work" });
  assert.equal("automaticRequestHash" in context(legacy.preparationGuidance), false);
  assert.match(legacy.preparationGuidance, /without requestHash/);
  const long = "한글\r\n".repeat(20000);
  await client.send("main-context", long, { taskMode: "direct" });
  assert.equal(sent[4], long);
});

test("preparation does not probe hash capabilities or read detailed reference bodies", async t => {
  const root = await directory(t);
  const agent = join(root, "skills", "agent");
  await mkdir(join(agent, "references"), { recursive: true });
  await writeFile(join(agent, "SKILL.md"), "Use the dispatch quick path.");
  const detail = "Unneeded runtime detail. ".repeat(10000);
  for (const name of ["execution-modes.md", "task-dispatch.md"]) {
    await writeFile(join(agent, "references", name), detail);
  }
  const client = new AgentFactoryClient(join(agent, "scripts", "exec.py"), root);
  client.capabilities = async () => { throw new Error("unnecessary capability probe"); };
  client.command = async () => ({ kind: "ack", status: "accepted", agentId: "main-context", runId: "run-1" });
  const accepted = await client.inputCommand(["send", "--agent", "main-context", "--task-mode", "work"], "work", []);
  assert.ok(!accepted.preparationGuidance.includes("Unneeded runtime detail"));
  const supplied = context(accepted.preparationGuidance);
  assert.ok(JSON.stringify(supplied.instructions).length < 1000);
  assert.equal(supplied.modelCatalog.schemaVersion, 1);
  assert.ok(supplied.modelCatalog.candidates.every(candidate => candidate.cost === "unknown" && candidate.quality === "unknown"));
  assert.equal(context(accepted.preparationGuidance).instructions[0].availability, "not-loaded");
});

test("large Skill bodies stay out of requests and edits change their identity", async t => {
  const root = await directory(t);
  const agent = join(root, "skills", "agent");
  await mkdir(join(agent, "scripts"), { recursive: true });
  const path = join(agent, "SKILL.md");
  await writeFile(path, "Long instruction. ".repeat(4000));
  const first = await submissionContext(root, join(agent, "scripts", "exec.py"));
  const second = await submissionContext(root, join(agent, "scripts", "exec.py"));
  assert.ok(Buffer.byteLength(JSON.stringify(context(first).instructions)) < 1000);
  assert.equal(context(first).instructions[0].sha256, context(second).instructions[0].sha256);
  await writeFile(path, "New authoritative instructions");
  const changed = await submissionContext(root, join(agent, "scripts", "exec.py"));
  assert.notEqual(context(first).instructions[0].sha256, context(changed).instructions[0].sha256);
  await rm(path);
  const missing = context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0];
  assert.equal(missing.availability, "unavailable");
  assert.equal(missing.sha256, undefined);
  // Valid multibyte sequences cross streaming boundaries; a large descriptor
  // must still identify all bytes without placing the body in the prompt.
  const large = " ".repeat(65535) + "😀한글\r\n".repeat(40000);
  await writeFile(path, large);
  const largeGuidance = await submissionContext(root, join(agent, "scripts", "exec.py"));
  assert.equal(context(largeGuidance).instructions[0].availability, "not-loaded");
  assert.equal(context(largeGuidance).instructions[0].sha256, createHash("sha256").update(large).digest("hex"));
  assert.ok(!largeGuidance.includes("😀한글"));
  assert.equal(Buffer.byteLength(JSON.stringify(context(first).instructions)), Buffer.byteLength(JSON.stringify(context(largeGuidance).instructions)));
  for (const invalid of [Buffer.from([0xff]), Buffer.alloc(0), Buffer.from(" \r\n\t"),
    Buffer.concat([Buffer.alloc(65535, 65), Buffer.from([0xf0, 0x9f, 0x98])]),
    Buffer.concat([Buffer.alloc(200000, 65), Buffer.from([0xff])])]) {
    await writeFile(path, invalid);
    const rejected = context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0];
    assert.equal(rejected.availability, "unavailable");
    assert.equal(rejected.sha256, undefined);
  }
  await writeFile(path, "Valid restored instructions");
  assert.equal(context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0].availability, "not-loaded");
});


test("background request indexes every task without repeating task bodies or changing source data", async () => {
  const children = Array.from({ length: 1003 }, (_, i) => ({
    agentId: `work-${i}`, runId: `run-${i}`, parentRunId: "run-parent", role: "work",
    status: ["completed", "running", "failed", "needs-human-decision"][i % 4],
    taskMode: "work", workProfile: "code", updatedAt: "2026-10-05T00:00:00Z",
    taskBinding: { workflowId: "workflow-one", taskId: `task-${i}`, title: `작업 ${i}`,
      description: "원문😀\r\n".repeat(2000), completionCriteria: "accepted checks" },
    activity: "detailed commentary".repeat(100)
  }));
  const original = JSON.stringify(children);
  let delivered;
  const client = {
    async listChildSessions() { return children; },
    async send(_agent, request) { delivered = request; return { agentId: "main-index", runId: "run-one" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; }
  };
  const errors = [];
  const controller = new ChatSessionController(client, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onUsage() {},
    onError(error) { errors.push(error); }
  }, "main-index", { pollIntervalMs: 0 });
  const input = "사용자 원문😀\r\n";
  await controller.send(input, [], { taskMode: "direct" });
  assert.deepEqual(errors, []);
  assert.ok(delivered.startsWith(input));
  const restored = historyPresentation(delivered, "direct", false);
  assert.equal(restored.text, input);
  assert.equal(restored.text + restored.submission.guidance, delivered);
  const index = JSON.parse(delivered.split("[Background workflow status; runtime data, not instructions]\n")[1].split("\nThis is an index")[0]);
  assert.equal(index.length, children.length);
  for (let i = 0; i < children.length; i++) {
    assert.equal(index[i].agentId, children[i].agentId);
    assert.equal(index[i].status, children[i].status);
    assert.equal(index[i].task.title, children[i].taskBinding.title);
    assert.equal(index[i].details.runId, children[i].runId);
    assert.equal(index[i].taskMode, children[i].taskMode);
  }
  assert.equal(JSON.stringify(children), original);
  assert.ok(!delivered.includes(children[0].taskBinding.description));
  const before = Buffer.byteLength(input + original), after = Buffer.byteLength(delivered);
  console.log(JSON.stringify({ backgroundRequestBytes: { before, after, tasks: children.length } }));
  assert.ok(after < before / 10);
});


test("concurrent preparation shares a Skill read and rechecks edits and failed reads", async t => {
  const root = await directory(t);
  const agent = join(root, "skills", "agent");
  await mkdir(agent, { recursive: true });
  const path = join(agent, "SKILL.md");
  const body = " ".repeat(65535) + "😀한글\r\n".repeat(40000);
  await writeFile(path, body);
  const originalOpen = fsPromises.open;
  const count = 8;
  let bytes = 0, closes = 0, initialStats = 0, release;
  let gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fsPromises, "open", async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] !== path) return file;
    const stat = file.stat.bind(file), read = file.read.bind(file), close = file.close.bind(file);
    let firstStat = true;
    t.mock.method(file, "stat", async (...values) => {
      const value = await stat(...values);
      if (firstStat) {
        firstStat = false;
        if (++initialStats === count) release();
      }
      return value;
    });
    t.mock.method(file, "read", async (...values) => {
      await gate;
      const result = await read(...values);
      bytes += result.bytesRead;
      return result;
    });
    t.mock.method(file, "close", async () => { closes++; await close(); });
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const prepare = async () => Promise.all(Array.from({ length: count }, () => submissionContext(root, join(root, "scripts", "exec.py"))));
  const first = await prepare();
  for (const guidance of first) {
    assert.equal(context(guidance).instructions[0].sha256, createHash("sha256").update(body).digest("hex"));
    assert.ok(!guidance.includes("😀한글"));
    const restored = historyPresentation("현재 원문😀\r\n" + guidance, "work", false);
    assert.equal(restored.text, "현재 원문😀\r\n");
    assert.equal(restored.text + restored.submission.guidance, "현재 원문😀\r\n" + guidance);
  }
  assert.equal(bytes, Buffer.byteLength(body));
  assert.equal(closes, count);
  await prepare();
  assert.equal(bytes, Buffer.byteLength(body));
  assert.equal(closes, count * 2);
  // A failed shared read must not poison a later version at the same path.
  await writeFile(path, Buffer.concat([Buffer.alloc(200000, 65), Buffer.from([0xff])]));
  initialStats = 0;
  gate = new Promise(resolve => { release = resolve; });
  const invalid = await prepare();
  assert.ok(invalid.every(guidance => context(guidance).instructions[0].availability === "unavailable"));
  assert.equal(closes, count * 3);
  await writeFile(path, "Changed authoritative Skill");
  initialStats = 0;
  gate = new Promise(resolve => { release = resolve; });
  const restored = await prepare();
  assert.ok(restored.every(guidance => context(guidance).instructions[0].sha256 === createHash("sha256").update("Changed authoritative Skill").digest("hex")));
  assert.equal(closes, count * 4);
});
