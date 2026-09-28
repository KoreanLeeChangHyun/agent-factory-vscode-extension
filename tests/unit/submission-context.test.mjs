import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const exec = promisify(execFile);
async function module(path) {
  const compiled = await build({ entryPoints: [new URL(`../../src/${path}.ts`, import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "esm" });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
}
const { parseGitStatus, collectGitStatus, submissionContext } = await module("infrastructure/agent-factory/submission-context");
const { historyPresentation } = await module("infrastructure/agent-factory/history-presentation");
const { AgentFactoryClient } = await module("infrastructure/agent-factory/agent-client");
const { ChatSessionController } = await module("modules/chat/session-controller");
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
  assert.ok(accepted.preparationGuidance.length < 2500);
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
  assert.ok(Buffer.byteLength(first) < 2500);
  assert.equal(context(first).instructions[0].sha256, context(second).instructions[0].sha256);
  await writeFile(path, "New authoritative instructions");
  const changed = await submissionContext(root, join(agent, "scripts", "exec.py"));
  assert.notEqual(context(first).instructions[0].sha256, context(changed).instructions[0].sha256);
  await rm(path);
  const missing = context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0];
  assert.equal(missing.availability, "unavailable");
  assert.equal(missing.sha256, undefined);
  for (const invalid of [Buffer.from([0xff]), Buffer.alloc(0), Buffer.from(" \r\n\t"), Buffer.alloc(128 * 1024 + 1, 65)]) {
    await writeFile(path, invalid);
    const rejected = context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0];
    assert.equal(rejected.availability, "unavailable");
    assert.equal(rejected.sha256, undefined);
  }
  await writeFile(path, "Valid restored instructions");
  assert.equal(context(await submissionContext(root, join(agent, "scripts", "exec.py"))).instructions[0].availability, "not-loaded");
});
