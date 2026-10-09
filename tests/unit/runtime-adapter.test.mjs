import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fsPromises from "node:fs/promises";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runUiInNewContext as runInNewContext } from "../support/ui-localization.mjs";
import { build } from "esbuild";
import { importTypeScript } from "../support/import-typescript.mjs";
import { readChatSource } from "../support/chat-source.mjs";

const runtimeTestHome = await mkdtemp(join(tmpdir(), "af-extension-home-"));
process.env.AGENT_FACTORY_HOME = runtimeTestHome;
test.after(() => rm(runtimeTestHome, { recursive: true, force: true }));
function agentsRoot(root) {
  const id = "project-" + createHash("sha256").update(root).digest("hex").slice(0, 32);
  return join(runtimeTestHome, "projects", id, "agents");
}

test("engine send validates dispatch IDs before runtime calls and preserves structured rejection codes", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("unused-exec.py", "/unused-project");
  let processes = 0;
  client.checkedExecution = async () => { processes++; return []; };
  for (const deliveryId of ["report-old", "", "dispatch-a\n", "dispatch-" + "a".repeat(129)]) {
    await assert.rejects(client.send("main-report", "exact report", { deliveryId }),
      error => error.code === "invalid_dispatch_id");
  }
  assert.equal(processes, 0);
  client.location = async () => ({ home: "/unused-home", projectId: "unused-project" });
  client.runRuntimeProcess = async () => ({ exitCode: 1, stderr: "", stdout: JSON.stringify({
    kind: "error", error: { code: "dispatch_id_collision", message: "Immutable request conflict" }
  }) });
  await assert.rejects(client.command(["send"]), error => error.code === "dispatch_id_collision"
    && error.message === "Immutable request conflict");
});

test("dispatch lookup distinguishes absent, accepted, invalid and unobservable acceptance", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/workspace");
  const args = [];
  let response = { run: { agentId: "main-report", runId: "report-run", dispatchId: "dispatch-child-one" } };
  client.command = async value => { args.push(value); return response; };
  assert.deepEqual(await client.dispatchAcceptance("main-report", "dispatch-child-one"), { agentId: "main-report", runId: "report-run" });
  assert.deepEqual(args[0], ["status", "--project-root", "/workspace", "--agent", "main-report", "--dispatch-id", "dispatch-child-one"]);
  for (const run of [{ agentId: "other", runId: "report-run", dispatchId: "dispatch-child-one" },
    { agentId: "main-report", runId: "../unsafe", dispatchId: "dispatch-child-one" },
    { agentId: "main-report", runId: "report-run", dispatchId: "dispatch-other" }, {}]) {
    response = { run };
    await assert.rejects(client.dispatchAcceptance("main-report", "dispatch-child-one"), /Invalid dispatch acceptance/);
  }
  for (const code of ["dispatch_not_found", "dispatch_id_collision", "transport_error"]) {
    client.command = async () => { throw Object.assign(new Error(code), { code }); };
    if (code === "dispatch_not_found") assert.equal(await client.dispatchAcceptance("main-report", "dispatch-child-one"), undefined);
    else await assert.rejects(client.dispatchAcceptance("main-report", "dispatch-child-one"), error => error.code === code);
  }
  await assert.rejects(client.dispatchAcceptance("main-report", "report-old"), error => error.code === "invalid_dispatch_id");
});

test("managed snapshots recover atomic replacement without accepting unsafe paths or stale event offsets", async t => {
  const output = await build({ entryPoints: ['src/infrastructure/agent-factory/agent-client.ts'],
    bundle: true, format: 'cjs', platform: 'node', write: false });
  const require = createRequire(import.meta.url), module = { exports: {} };
  const root = await mkdtemp(join(tmpdir(), 'af-read-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json'), outside = join(root, 'outside.json');
  await writeFile(outside, JSON.stringify({ status: 'outside' }));
  let target = path, remaining = 0, mode = 'regular', opens = 0, closes = 0;
  const fs = { ...fsPromises, async open(name, flags) {
    const file = await fsPromises.open(name, flags);
    if (name !== target) return file;
    opens++;
    const read = file.read.bind(file), close = file.close.bind(file);
    let changed = false;
    file.close = async () => { closes++; return close(); };
    file.read = async (...args) => {
      const result = await read(...args);
      if (!changed && remaining > 0) {
        changed = true; remaining--;
        const replacement = name + '.tmp';
        if (mode === 'symlink') await symlink(outside, replacement);
        else await writeFile(replacement, mode === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : JSON.stringify({ status: 'completed' }));
        await fsPromises.rename(replacement, name);
      }
      return result;
    };
    return file;
  } };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, Buffer, URL, process,
    setTimeout, clearTimeout, console, require: name => name === 'node:fs/promises' ? fs : require(name) });
  const client = new module.exports.AgentFactoryClient('/unused', root);
  for (const replacements of [1, 2]) {
    await writeFile(path, JSON.stringify({ status: 'running' }));
    remaining = replacements; opens = closes = 0;
    assert.equal((await client.cachedRunState(path)).status, 'completed');
    assert.equal(opens, replacements + 1);
    assert.equal(closes, opens);
    assert.equal((await client.cachedRunState(path)).status, 'completed');
  }
  for (mode of ['regular', 'symlink', 'oversized']) {
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify({ status: 'running' }));
    remaining = 10; opens = closes = 0;
    await assert.rejects(client.cachedRunState(path), /replaced|unsafe/i);
    assert.equal(opens, mode === 'regular' ? 3 : 1);
    assert.equal(closes, opens);
  }
  mode = 'regular'; remaining = 1; opens = closes = 0;
  const directory = join(root, 'agents', 'main-one', 'runs', 'run-one');
  await mkdir(directory, { recursive: true });
  target = join(directory, 'events.jsonl');
  await writeFile(target, '{}\n');
  client.location = async () => ({ agentsRoot: join(root, 'agents') });
  await assert.rejects(client.updates('main-one', 'run-one', 0), /replaced/i);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});


test("conversation history restores ordered durable messages and honors reset boundaries", async (t) => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentRoot = join(agentsRoot(root), "main-history");
  await mkdir(agentRoot, { recursive: true });
  const sessionPath = join(agentRoot, "session.json");
  await writeFile(sessionPath, JSON.stringify({ agentId: "main-history" }));
  async function run(id, fields = {}) {
    const directory = join(agentRoot, "runs", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "state.json"), JSON.stringify({ agentId: "main-history", runId: id, status: "completed", ...fields }));
    await writeFile(join(directory, "request.md"), `question ${id}`);
    await writeFile(join(directory, "result.md"), `answer ${id}`);
  }
  await run("run-002");
  await run("run-001");
  await run("run-003", { status: "running" });
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  assert.deepEqual((await client.history("main-history")).messages.map(item => item.text), [
    "question run-001", "answer run-001", "question run-002", "answer run-002"
  ]);
  const firstPage = await client.history("main-history", { limit: 2 });
  assert.equal(firstPage.nextBefore, "run-002");
  assert.deepEqual(firstPage.messages.map(item => item.runId), ["run-002", "run-002"]);
  const older = await client.history("main-history", { limit: 2, before: firstPage.nextBefore });
  assert.equal(older.nextBefore, undefined);
  assert.deepEqual(older.messages.map(item => item.runId), ["run-001", "run-001"]);
  await assert.rejects(client.history("main-history", { limit: 0 }));
  await assert.rejects(client.history("main-history", { limit: 10, before: "../escape" }));
  await writeFile(sessionPath, JSON.stringify({ agentId: "main-history", conversationId: "conversation-new" }));
  assert.deepEqual((await client.history("main-history")).messages, []);
  await run("run-004", { conversationId: "conversation-new" });
  const question = { id: "interview-1-of-1", current: 1, total: 1, text: "Choose a route", yesNo: false,
    options: [{ value: "safe", label: "Safe", pros: "Lower risk", cons: "Slower" },
      { value: "fast", label: "Fast", pros: "Quicker", cons: "Higher risk" }], recommendedValue: "safe" };
  await writeFile(join(agentRoot, "runs/run-004/events.jsonl"), JSON.stringify({ type: "interview.question", question }) + "\n");
  const restored = await client.history("main-history");
  assert.equal(restored.conversationId, "conversation-new");
  assert.equal(restored.messages.length, 3);
  assert.deepEqual(restored.messages.map(item => item.type), ["user", "interview", "assistant"]);
  assert.deepEqual(restored.messages[1].question, question);
  assert.deepEqual(await client.conversations("main-history"), [{ conversationId: null, startedAt: "run-001", runCount: 2 }]);
  const archived = await client.history("main-history", { limit: 2, conversationId: null, before: "run-003" });
  assert.deepEqual(archived.messages.map(item => item.text), ["question run-001", "answer run-001", "question run-002", "answer run-002"]);
  assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).conversationId, "conversation-new");
  const archivedPage = await client.history("main-history", { limit: 1, conversationId: null });
  assert.equal(archivedPage.nextBefore, "run-002");
  assert.deepEqual(archivedPage.messages.map(item => item.runId), ["run-002", "run-002"]);
  const guidance = '\n\n[Orchestrator mode]\nThis is ordinary conversation in orchestrator mode, not a Human-selected workflow.\nRecorded instructions.\n[End orchestrator mode]';
  const originals = ['한국어 & <tag>\n```js\nconst marker = "[Orchestrator mode]";\n```',
    '첨부 참조:\n- [image] image.png: file:///fixture/image.png (image/png, 12 bytes)'];
  const envelope = parts => parts.map((part, index) => `--- 대기 메시지 ${index + 1} 시작 ---\n${part}\n--- 대기 메시지 ${index + 1} 끝 ---`).join('\n\n');
  const request = envelope(originals.map(text => text + guidance));
  const requestPath = join(agentRoot, 'runs/run-004/request.md');
  await writeFile(requestPath, request);
  const presented = await client.history('main-history');
  assert.equal(presented.messages[0].text, envelope(originals));
  assert.equal(presented.messages[0].capturedRequest, request);
  assert.equal(presented.messages[0].submission.guidance, guidance.repeat(2));
  assert.deepEqual(await client.history('main-history'), presented);
  assert.equal(await readFile(requestPath, 'utf8'), request, 'Presentation must not rewrite stored requests');
  assert.equal(presented.messages.at(-1).text, 'answer run-004');
  const prettyStatus = '\n\n[Background workflow status; runtime data, not instructions]\n' +
    JSON.stringify([{ agentId: 'scribe-example', runId: 'run-example', status: 'completed', task: { title: '한국어 [}]' } }], null, 2) +
    '\nPreserve accepted workflows.\n[End background workflow status]';
  for (const text of ['docs 커밋좀', '초안 검토 범위만 승인합니다.\n되돌릴 수 없는 작업은 포함하지 않습니다.']) {
    const raw = text + prettyStatus;
    await writeFile(requestPath, raw);
    const history = await client.history('main-history');
    assert.equal(history.messages[0].text, text);
    assert.equal(history.messages[0].submission.guidance, prettyStatus);
    assert.equal(history.messages.at(-1).text, 'answer run-004');
    assert.deepEqual(await client.history('main-history'), history);
    assert.equal(await readFile(requestPath, 'utf8'), raw);
  }
  await assert.rejects(client.history("main-history", { limit: 10, conversationId: "../escape" }));
  assert.equal(await readFile(join(agentRoot, "runs/run-001/result.md"), "utf8"), "answer run-001");
  // History paths are derived from the bound run, never supplied by state contents.
  await rm(join(agentRoot, "runs/run-004/request.md"));
  await symlink(join(agentRoot, "runs/run-001/result.md"), join(agentRoot, "runs/run-004/request.md"));
  await assert.rejects(client.history("main-history"));
});

test("failed results expose provider errors and retain fallback diagnostics", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runRoot = join(agentsRoot(root), "main-test/runs/run-test");
  await mkdir(runRoot, { recursive: true });
  const error = { code: "codex_failed", message: "codex exec exited with 1" };
  await writeFile(join(runRoot, "state.json"), JSON.stringify({ status: "failed", error }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const result = () => client.result("main-test", "run-test");
  assert.deepEqual((await result()).error, error);
  const message = "Selected model is at capacity. Please try a different model.";
  const eventsPath = join(runRoot, "events.jsonl");
  for (const event of [{ type: "error", message }, { type: "turn.failed", error: { message } }]) {
    await writeFile(eventsPath, "malformed\n" + JSON.stringify(event) + "\n");
    assert.deepEqual((await result()).error, { ...error, message });
  }
  await appendFile(eventsPath, JSON.stringify({ type: "turn.started" }) + "\n");
  assert.deepEqual((await result()).error, error);
  await appendFile(eventsPath, JSON.stringify({ type: "error", message }));
  assert.deepEqual((await result()).error, error);
  await appendFile(eventsPath, "\n");
  await writeFile(join(runRoot, "state.json"), JSON.stringify({ status: "completed" }));
  await writeFile(join(runRoot, "result.md"), "done");
  assert.deepEqual(await result(), { status: "completed", text: "done" });
  const specific = { code: "execution_preflight_failed", message: "preflight failed" };
  await writeFile(join(runRoot, "state.json"), JSON.stringify({ status: "failed", error: specific }));
  assert.deepEqual((await result()).error, specific);
});

test("branch status follows checkout and handles unborn, detached and non-Git folders", async function (t) {
  const { readGitBranch } = await importTypeScript("src/infrastructure/vscode/git-branch.ts");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "af-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(await readGitBranch(), undefined);
  assert.equal(await readGitBranch(root), undefined);
  git("init", "-b", "main");
  assert.equal(await readGitBranch(root), "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial");
  git("checkout", "-b", "feature/status");
  assert.equal(await readGitBranch(root), "feature/status");
  git("checkout", "--detach");
  assert.equal(await readGitBranch(root), "detached " + git("rev-parse", "--short", "HEAD"));
});

test("async cache shares work, expires, isolates keys and retries failures", async function () {
  const { AsyncCache } = await importTypeScript("src/common/async-cache.ts");
  let now = 0;
  let calls = 0;
  const cache = new AsyncCache(30, 2, () => now);
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load)]), [1, 1]);
  assert.equal(await cache.get('a', load), 1);
  assert.equal(await cache.get('b', load), 2);
  now = 30;
  assert.equal(await cache.get('a', load), 3);
  await assert.rejects(cache.get('failure', async () => { throw new Error('retry'); }), /retry/);
  assert.equal(await cache.get('failure', load), 4);
  assert.equal(await cache.get('unavailable', load, () => false), 5);
  assert.equal(await cache.get('unavailable', load), 6);
  assert.equal(await cache.get('b', load), 7);
});

test("event snapshots preserve cursor replay, partial appends and replacement", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), 'agent-factory-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(agentsRoot(root), 'main-test/runs/run-test/events.jsonl');
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify({ type: 'turn.started' });
  await writeFile(path, line + '\n');
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const first = await client.updates('main-test', 'run-test', 0);
  assert.equal(first.cursor, 1);
  assert.equal(first.updates.length, 1);
  assert.deepEqual(await client.updates('main-test', 'run-test', 0), first);
  assert.deepEqual(await client.updates('main-test', 'run-test', 1), { cursor: 1, updates: [] });
  await appendFile(path, line);
  assert.deepEqual(await client.updates('main-test', 'run-test', 1), { cursor: 1, updates: [] });
  await appendFile(path, '\n');
  assert.equal((await client.updates('main-test', 'run-test', 1)).updates.length, 1);
  await rm(path);
  assert.deepEqual(await client.updates('main-test', 'run-test', 2), { cursor: 2, updates: [] });
  await writeFile(path, line + '\n');
  assert.deepEqual(await client.updates('main-test', 'run-test', 0), first);
});

test("model catalog discovers new models and tolerates unavailable caches", async function (t) {
  const { readCodexModels } = await importTypeScript("src/infrastructure/agent-factory/model-catalog.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "models_cache.json");
  assert.equal(await readCodexModels(root), undefined);
  await writeFile(cache, JSON.stringify({ models: [
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "internal", visibility: "hide" },
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "codex-only", visibility: "list", supported_in_api: false },
    { slug: "bad model", visibility: "list" }, null
  ] }));
  assert.deepEqual(await readCodexModels(root), ["gpt-6-astra", "codex-only"]);
  await writeFile(cache, JSON.stringify({ models: [{ slug: "future-model", visibility: "list" }] }));
  assert.deepEqual(await readCodexModels(root), ["future-model"]);
  for (const content of ['{"models":', '{"models":null}', 'null', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(cache, content);
    assert.equal(await readCodexModels(root), undefined);
  }
  await writeFile(cache, '{"models":[]}');
  assert.deepEqual(await readCodexModels(root), []);
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "models.request" }), { type: "models.request" });
});

test("runtime capability checks respect each command and preserve structured errors", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "exec.py");
  await writeFile(script, `import argparse, json, pathlib, os, hashlib
p = argparse.ArgumentParser()
s = p.add_subparsers(dest='command')
for name in ['init', 'capabilities', 'submit', 'send', 'list']:
    c = s.add_parser(name)
    c.add_argument('--agent')
    c.add_argument('--project-root')
    c.add_argument('--runtime-home')
    c.add_argument('--project-id')
    if name in ['submit', 'capabilities']: c.add_argument('--model')
args = p.parse_args()
if args.command == 'init':
    home = pathlib.Path(os.environ['AGENT_FACTORY_HOME'])
    root = pathlib.Path(args.project_root).resolve()
    identity = 'project-' + hashlib.sha256(str(root).encode()).hexdigest()[:32]
    runtime = home/'projects'/identity
    (runtime/'agents').mkdir(parents=True,exist_ok=True)
    print(json.dumps({'schemaVersion':1,'kind':'runtime-location','home':str(home),'projectRoot':str(root),'projectId':identity,'runtimeRoot':str(runtime),'agentsRoot':str(runtime/'agents'),'registered':True}))
    raise SystemExit(0)
if args.command == 'capabilities':
    print(json.dumps({'kind': 'execution-capabilities', 'schemaVersion': '0.1.0', 'submit': {'model': True, 'reasoning': False, 'fast': False, 'goal': False}, 'send': {'model': False, 'reasoning': False, 'fast': False, 'goal': False, 'sessionProvider': 'claude'}}))
    raise SystemExit(0)
print(json.dumps({'kind': 'error', 'error': {'code': 'test', 'message': 'specific runtime failure'}}))
raise SystemExit(2)
`);
  const client = new AgentFactoryClient(script, root);
  assert.deepEqual(await client.capabilities(), {
    submit: { model: true, reasoning: false, fast: false, goal: false, roleDirectExceptions: false, taskAllocation: false, images: undefined, taskModes: [] },
    send: { model: false, reasoning: false, fast: false, goal: false, sessionProvider: "claude", roleDirectExceptions: false, taskAllocation: false, images: undefined, taskModes: [] }
  });
  const compatible = new AgentFactoryClient("/unused/exec.py", root);
  compatible.command = async () => ({
    kind: "execution-capabilities", schemaVersion: "0.1.0",
    submit: { model: true, reasoning: false, fast: false, goal: false, images: true },
    send: { model: false, reasoning: false, fast: false, goal: false, images: true }
  });
  assert.equal((await compatible.capabilities()).submit.images, true);
  assert.equal((await compatible.capabilities()).send.images, true);
  await assert.rejects(client.submit('test', 'test', { reasoningEffort: 'medium', fast: false, goalMode: false }), /reasoning effort/);
  await assert.rejects(client.send('test', 'test', { model: 'gpt-6-astra', fast: false, goalMode: false }), /model changes/);
  await assert.rejects(client.listSessions(), /specific runtime failure/);
});

test("conversation reset uses the runtime command and requires retained-history evidence", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const client = new AgentFactoryClient("/unused/exec.py", root);
  client.command = async (arguments_) => {
    calls.push(arguments_);
    return {
      kind: "conversation-reset", agentId: "main-test",
      conversationId: "conversation-new", startedAt: "2026-09-19T00:00:00Z",
      historyRetained: true
    };
  };
  assert.deepEqual(await client.resetConversation("main-test"), {
    conversationId: "conversation-new", startedAt: "2026-09-19T00:00:00Z"
  });
  assert.deepEqual(calls[0], ["reset-conversation", "--project-root", root, "--agent", "main-test"]);
  client.command = async () => ({
    kind: "conversation-reset", agentId: "main-test",
    conversationId: "conversation-new", startedAt: "2026-09-19T00:00:00Z",
    historyRetained: false
  });
  await assert.rejects(client.resetConversation("main-test"), /invalid conversation reset response/i);
});

test("composer shows only supported controls across draft and bound sessions", async function () {
  const script = await readChatSource();
  const functions = script.slice(script.indexOf('  function agentSettingRole('), script.indexOf('  function renderAgentDefaults(')) + '\n' + script.slice(script.indexOf('  function currentCapabilities()'), script.indexOf('  function openSetting(setting)'));
  const iconFunction = script.slice(script.indexOf('  function createBusinessModeIcon(mode)'), script.indexOf('  function handleSettingMenuKeydown(event)'));
  const element = (namespaceURI, localName) => ({
    namespaceURI, localName, children: [], attributes: {}, dataset: {},
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
  const button = () => Object.assign(element('http://www.w3.org/1999/xhtml', 'button'), { parentElement: {} });
  let statusRenders = 0;
  const clearButton = button();
  const clearControl = script.slice(script.indexOf('  function updateConversationClearControl()'), script.indexOf('  function resetConversationState()'));
  const context = {
    document: { createElementNS: element, querySelector() { return null; }, getElementById() { return clearButton; } },
    conversationClearing: false, conversationWorktree: undefined,
    renderStatusBar() { statusRenders++; },
    updateComposerControls() {},
    modelMenu: { querySelector() { return null; } }, submissionButton: button(),
    promptSurface: { classList: { toggle() {} } },
    state: { role: 'main', businessMode: 'normal', taskMode: 'work', capabilities: { submit: { model: true }, send: {} }, model: 'gpt-6-astra', reasoning: 'medium', fastMode: true, goalMode: true },
    modelButton: button(), reasoningButton: button(), fastModeSetting: button(), fastModeButton: button(), fastModeValue: {}, orchestrateModeButton: button(), workIsolationButton: button(), goalModeButton: button(), workLoopButton: button(),
    orchestrateAvailable: () => true, enterAction: () => context.state.orchestrateMode === false ? "direct" : "orchestrate",
    taskModeNames: { work: "Work" }, businessModeNames: { normal: "Normal" }, businessModeButton: button(),
    executionModeButton: button(), executionModeLabel: {}, modelLabel: {}, reasoningLabel: {}, openSettingId: undefined,
    goalPanel: { querySelectorAll() { return []; } }, goalStatus: {}, nativeGoal: null, goalError: undefined
  };
  runInNewContext(functions + iconFunction + clearControl + '\nupdateModeControls();', context);
  assert.equal(clearButton.disabled, true);
  assert.equal(statusRenders, 1);
  assert.equal(context.modelButton.parentElement.hidden, false);
  assert.equal(context.submissionButton.hidden, false);
  assert.equal(context.fastModeButton.hidden, true);
  assert.equal(context.fastModeSetting.hidden, true);
  assert.equal(context.orchestrateModeButton.hidden, false);
  assert.equal(context.orchestrateModeButton.title.length > 0, true);
  // Work isolation sits beside the mode toggle; it is off until the runtime supports it and the Human turns it on.
  assert.equal(context.workIsolationButton.hidden, false);
  assert.equal(context.workIsolationButton.disabled, true);
  assert.equal(context.workIsolationButton.attributes['aria-pressed'], 'false');
  context.state.workIsolation = true;
  context.state.capabilities = { submit: { model: true, workIsolation: true }, send: { workIsolation: true } };
  runInNewContext('updateModeControls();', context);
  assert.equal(context.workIsolationButton.disabled, false);
  assert.equal(context.workIsolationButton.attributes['aria-pressed'], 'true');
  context.state.workIsolation = false;
  runInNewContext('updateModeControls();', context);
  assert.equal(context.workIsolationButton.attributes['aria-pressed'], 'false');
  statusRenders -= 2;
  context.state.agentId = 'bound-session';
  runInNewContext('updateModeControls();', context);
  assert.equal(context.modelButton.parentElement.hidden, false);
  assert.equal(statusRenders, 2);
  assert.equal(clearButton.disabled, false);
  assert.equal(context.state.model, 'gpt-6-astra');
  context.state.role = 'work';
  runInNewContext('updateModeControls();', context);
  assert.equal(context.submissionButton.hidden, true);
  assert.equal(context.orchestrateModeButton.hidden, true);
  assert.equal(context.workIsolationButton.hidden, true);
  assert.equal(clearButton.hidden, true);
});

test("chat panel restoration preserves composer settings and context usage", async function () {
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  assert.deepEqual(restoreChatState({
    panelId: "panel-one",
    title: "Main Agent",
    model: "gpt-5.6-terra",
    reasoning: "high",
    fastMode: true,
    goalMode: true,
    workLoopMode: true,
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000,
    weeklyUsedPercent: 12.5,
    fiveHourUsedPercent: 40,
    weeklyResetsAt: 1_790_953_200,
    fiveHourResetsAt: -1
  }), {
    panelId: "panel-one",
    title: "Main Agent",
    model: "gpt-5.6-terra",
    reasoning: "high",
    fastMode: true,
    goalMode: false,
    maestroMode: false,
    workLoopMode: false,
    taskMode: "direct",
    businessMode: "normal",
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000,
    fiveHourUsedPercent: 40,
    weeklyUsedPercent: 12.5,
    weeklyResetsAt: 1_790_953_200
  });
});

test("webview persistence carries weekly usage through chat state restoration", async function () {
  const script = await readChatSource();
  const persist = script.slice(
    script.indexOf("  function persist("),
    script.indexOf("  function safeCount(value)")
  );
  let serialized;
  runInNewContext("let persistenceScheduled = false; let persistenceTimer, persistenceStartedAt, lastPersistedState;\n" + persist + "\npersist(false); persist(false);", {
    setTimeout,
    clearTimeout,
    currentTaskFlows: () => [],
    shortcuts: {},
    shortcutDefaultsVersion: 2,
    chatNotes: { selectedNotesScope: "chat", noteDraft: null },
    state: {
      panelId: "panel-one",
      title: "Main Agent",
      role: "main",
      draft: "",
      attachments: [],
      timeline: [],
      statusItems: [],
      runtimeAvailable: true,
      running: false,
      fastMode: false,
      goalMode: false,
      workLoopMode: false,
      contextUsedTokens: 39_300,
      contextWindowTokens: 1_050_000,
      weeklyUsedPercent: 12.5,
      workUnits: {},
      childAgents: []
    },
    vscode: {
      setState(value) {
        serialized = JSON.parse(JSON.stringify(value));
      }
    }
  });

  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(serialized.weeklyUsedPercent, 12.5);
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  assert.equal(restoreChatState(serialized).weeklyUsedPercent, 12.5);
});

test("Ctx left is independent of Weekly availability", async function () {
  const script = await readChatSource();
  const functions = script.slice(
    script.indexOf("  function contextStatusLabel()"),
    script.indexOf("  function renderContextStatus(item)")
  );
  const context = {
    state: { contextUsedTokens: 54_264, contextWindowTokens: 258_400, weeklyUsedPercent: 12.5 }
  };
  assert.equal(
    runInNewContext(functions + "\ncontextStatusLabel();", context),
    "Ctx left 79%"
  );
  context.state.weeklyUsedPercent = undefined;
  assert.equal(
    runInNewContext("contextStatusLabel();", context),
    "Ctx left 79%"
  );
});

test("composer settings messages are strictly validated", async function () {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({
    type: "composer.settings",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    fastMode: true,
    goalMode: false
  }), {
    type: "composer.settings",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    fastMode: true,
    goalMode: false
  });
  assert.equal(parseClientMessage({
    type: "composer.settings",
    reasoning: "extreme",
    fastMode: true,
    goalMode: false
  }), undefined);
  assert.deepEqual(parseClientMessage({ type: "agents.request" }), { type: "agents.request" });
  assert.deepEqual(parseClientMessage({ type: "agent.open", agentId: "main-one-work" }), {
    type: "agent.open",
    agentId: "main-one-work"
  });
  assert.deepEqual(parseClientMessage({ type: "agent.open", agentId: "main-one-work", runId: "run-old" }), { type: "agent.open", agentId: "main-one-work", runId: "run-old" });
  for (const runId of ["../old", "", 12]) assert.equal(parseClientMessage({ type: "agent.open", agentId: "main-one-work", runId }), undefined);
  assert.equal(parseClientMessage({ type: "agent.open", agentId: "../work" }), undefined);
});

test("chat links allow browser and local-file targets while rejecting active schemes", async function () {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  for (const href of ["https://example.com/docs", "mailto:test@example.com", "file:///workspace/app.ts#L12", "/workspace/app.ts:12:3", "./README.md"]) {
    assert.deepEqual(parseClientMessage({ type: "link.open", href }), { type: "link.open", href });
  }
  for (const href of ["javascript:alert(1)", "data:text/html,test", "command:workbench.action.closeWindow", "", "https://example.com\nnext"]) {
    assert.equal(parseClientMessage({ type: "link.open", href }), undefined);
  }
});

test("long pasted text attachment requests preserve content", async function () {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const text = "가".repeat(8_000);
  assert.deepEqual(parseClientMessage({ type: "attachments.createText", text }), {
    type: "attachments.createText",
    text
  });
  assert.equal(parseClientMessage({ type: "attachments.createText", text: "short" }), undefined);
  assert.equal(parseClientMessage({ type: "attachments.createText", text: "x".repeat(1_000_001) }).text.length, 1_000_001);
});

test("plugin locator honors an override and discovers the newest install across marketplaces", async function () {
  const { locateAgentFactoryExec } = await importTypeScript("src/infrastructure/agent-factory/plugin-locator.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-locator-"));
  const older = join(root, "plugins/cache/agent-factory/agent-factory/0.1.0/skills/agent/scripts/exec.py");
  const newer = join(root, "plugins/cache/agent-factory/agent-factory/0.2.0/skills/agent/scripts/exec.py");
  const personal = join(root, "plugins/cache/personal/agent-factory/0.3.0/skills/agent/scripts/exec.py");
  await mkdir(dirname(older), { recursive: true });
  await mkdir(dirname(newer), { recursive: true });
  await mkdir(dirname(personal), { recursive: true });
  await writeFile(older, "# older\n");
  await writeFile(newer, "# newer\n");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(personal, "# personal newest\n");

  assert.deepEqual(await locateAgentFactoryExec({ configuredPath: older }), {
    available: true,
    execPath: older
  });
  assert.deepEqual(await locateAgentFactoryExec({ environment: { CODEX_HOME: root } }), {
    available: true,
    execPath: personal
  });
});

test("plugin locator keeps an older matching release when newer plugins are cached", async function (t) {
  const { locateAgentFactoryExec } = await importTypeScript("src/infrastructure/agent-factory/plugin-locator.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-version-match-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versions = ["1.0.8+codex.old", "1.0.11+codex.new"];
  const paths = [];
  for (const version of versions) {
    const plugin = join(root, "plugins/cache/agent-factory/agent-factory", version);
    const execPath = join(plugin, "skills/agent/scripts/exec.py");
    await mkdir(dirname(execPath), { recursive: true });
    await mkdir(join(plugin, ".codex-plugin"));
    await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "agent-factory", version }));
    await writeFile(execPath, "# fixture");
    paths.push(execPath);
  }
  assert.deepEqual(await locateAgentFactoryExec({ environment: { CODEX_HOME: root }, requiredVersion: "1.0.8" }), {
    available: true, execPath: paths[0]
  });
  const missing = await locateAgentFactoryExec({ environment: { CODEX_HOME: root }, requiredVersion: "1.0.9" });
  assert.equal(missing.available, false);
  assert.match(missing.diagnostic, /matching extension version 1\.0\.9/);
});

test("plugin locator prefers the root scripts layout and still finds legacy installs", async function (t) {
  const { locateAgentFactoryExec } = await importTypeScript("src/infrastructure/agent-factory/plugin-locator.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, "plugins/cache/agent-factory/agent-factory/1.0.16+codex.new");
  const legacy = join(plugin, "skills/agent/scripts/exec.py");
  const current = join(plugin, "scripts/exec.py");
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, "# legacy");
  assert.deepEqual(await locateAgentFactoryExec({ environment: { CODEX_HOME: root } }), { available: true, execPath: legacy });
  await mkdir(dirname(current), { recursive: true });
  await writeFile(current, "# current");
  assert.deepEqual(await locateAgentFactoryExec({ environment: { CODEX_HOME: root } }), { available: true, execPath: current });
});

test("runtime client rediscovers an installed exec after its cache path is replaced", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-factory-runtime-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL("../fixtures/fake-exec.py", import.meta.url).pathname;
  const oldExec = join(root, "cache/old/exec.py");
  const newExec = join(root, "cache/new/exec.py");
  await mkdir(dirname(oldExec), { recursive: true });
  await mkdir(dirname(newExec), { recursive: true });
  const script = await readFile(source);
  await writeFile(oldExec, script);
  await writeFile(newExec, script);
  let rediscoveries = 0;
  const client = new AgentFactoryClient(oldExec, root, "python3", join(root, "codex-home"), async () => {
    rediscoveries += 1;
    return newExec;
  });

  await client.listSessions();
  await rm(oldExec);
  assert.deepEqual(await client.status("main-test", "run-fake"), { status: "completed" });
  assert.equal(rediscoveries, 1);
});

test("runtime client invokes official commands and reads the bounded managed result", async function () {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-factory-client-"));
  const codexHome = join(projectRoot, "codex-home");
  const fakeExec = new URL("../fixtures/fake-exec.py", import.meta.url).pathname;
  const resultPath = join(agentsRoot(projectRoot), "main-test/runs/run-fake/result.md");
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, "Main result text\n");
  await writeFile(join(dirname(resultPath), "state.json"), JSON.stringify({ sessionId: "session-context" }));
  const rolloutPath = join(codexHome, "sessions/2026/09/03/rollout-2026-09-03T00-00-00-session-context.jsonl");
  await mkdir(dirname(rolloutPath), { recursive: true });
  await writeFile(rolloutPath, JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 39_300 },
        model_context_window: 258_400
      },
      rate_limits: { primary: { used_percent: 3, window_minutes: 10_080 } }
    }
  }) + "\n");
  const client = new AgentFactoryClient(fakeExec, projectRoot, "python3", codexHome);

  assert.deepEqual(await client.listSessions(), [
    { agentId: "main-newer", sessionId: "session-newer", updatedAt: "2026-09-01T09:00:00Z", model: "gpt-5.6-sol" },
    { agentId: "main-older", sessionId: "session-older", updatedAt: "2026-08-30T10:00:00Z" }
  ]);

  assert.deepEqual(await client.submit("main-test", "hello", {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    fast: true,
    goalMode: true
  }), {
    agentId: "main-test",
    runId: "run-fake"
  });
  assert.deepEqual(await client.status("main-test", "run-fake"), { status: "completed" });
  const eventsPath = join(agentsRoot(projectRoot), "main-test/runs/run-fake/events.jsonl");
  await writeFile(eventsPath, [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.started", item: { id: "command-1", type: "command_execution", command: "/usr/bin/zsh -lc 'npm run check'" } }),
    JSON.stringify({ type: "item.completed", item: { id: "command-1", type: "command_execution", command: "/usr/bin/zsh -lc 'npm run check'", exit_code: 0 } }),
    JSON.stringify({ type: "item.started", item: { id: "change-1", type: "file_change", changes: [
      { path: join(projectRoot, "static/js/chat.js") },
      { path: join(projectRoot, "static/css/chat.css") },
      { path: join(projectRoot, "templates/chat.html") }
    ] } }),
    JSON.stringify({ type: "item.started", item: { id: "runtime-1", type: "file_change", changes: [
      { path: resultPath }
    ] } }),
    JSON.stringify({ type: "item.started", item: { id: "skill-1", type: "command_execution", command: "sed -n '1,240p' /home/test/.codex/plugins/cache/personal/agent-factory/0.1.0/skills/agent/SKILL.md" } }),
    JSON.stringify({ type: "item.started", item: { id: "request-read-1", type: "command_execution", command: `sed -n '1,260p' ${dirname(resultPath)}/request.md` } }),
    JSON.stringify({ type: "item.started", item: { id: "result-read-1", type: "command_execution", command: `sed -n '1,20p' ${resultPath}` } }),
    JSON.stringify({ type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "codex", tool: "list_mcp_resources" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 39098, output_tokens: 202 } }),
    ""
  ].join("\n"));
  assert.deepEqual(await client.updates("main-test", "run-fake", 0), {
    cursor: 10,
    updates: [
      { kind: "status", text: "Main Agent is analyzing the request" },
      { kind: "activity", id: "command-1", category: "command", phase: "started", text: "npm run check" },
      { kind: "status", text: "Running command" },
      { kind: "activity", id: "command-1", category: "command", phase: "completed", text: "npm run check" },
      { kind: "status", text: "Analyzing results" },
      { kind: "activity", id: "change-1", category: "file", phase: "started", text: "static/js/chat.js, static/css/chat.css and 1 more" },
      { kind: "status", text: "Applying Git changes" },
      { kind: "status", text: "Recording response" },
      { kind: "activity", id: "skill-1", category: "command", phase: "started", text: "sed -n '1,240p' /home/test/.codex/plugins/cache/personal/agent-factory/0.1.0/skills/agent/SKILL.md", title: "Read Skill · agent-factory:agent" },
      { kind: "status", text: "Running command" },
      { kind: "status", text: "Main Agent is analyzing the request" },
      { kind: "status", text: "Finalizing response" },
      { kind: "activity", id: "mcp-1", category: "tool", phase: "started", text: "codex/list_mcp_resources" },
      { kind: "status", text: "Running connected tool" },
      { kind: "status", text: "Finalizing response" },
      { kind: "usage", usedTokens: 39300, contextWindowTokens: 258400, weeklyUsedPercent: 3 },
      { kind: "accountLimits", limits: { provider: "codex", weeklyUsedPercent: 3 } }
    ]
  });
  await appendFile(eventsPath, '{"type":"turn.completed"');
  assert.deepEqual(await client.updates("main-test", "run-fake", 10), {
    cursor: 10,
    updates: []
  });
  await writeFile(eventsPath, [
    { id: "native-output", aggregatedOutput: "native result\n", exit_code: 0 },
    { id: "legacy-output", aggregated_output: "legacy error\n", exit_code: 1 },
    { id: "empty-output", aggregatedOutput: "", exit_code: 0 },
    { id: "bounded-output", aggregatedOutput: "x".repeat(40000), exit_code: 1 }
  ].map((item) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd", ...item } })).join("\n") + "\n");
  const outputUpdates = (await client.updates("main-test", "run-fake", 0)).updates.filter((update) => update.kind === "activity");
  assert.equal(outputUpdates[0].output, "native result\n");
  assert.equal(outputUpdates[1].output, "legacy error\n");
  assert.equal(outputUpdates[1].phase, "failed");
  assert.equal(outputUpdates[2].output, "");
  assert.equal(outputUpdates[3].output.length, 32768);
  assert.ok(outputUpdates[3].output.endsWith("…"));
  const commentary = "전체 진행 설명 ".repeat(100);
  await writeFile(eventsPath, [
    { type: "item.started", item: { id: "web-1", type: "webSearch", action: { type: "search", queries: ["첫 검색", "second query"] } } },
    { type: "item.completed", item: { id: "web-1", type: "webSearch", action: { type: "search", queries: ["첫 검색", "second query"] } } },
    { type: "item.completed", item: { id: "web-2", type: "web_search", query: "legacy query" } },
    { type: "item.started", item: { id: "web-3", type: "webSearch" } },
    { type: "item.completed", item: { id: "web-3", type: "webSearch", status: "failed" } }
  ].map(JSON.stringify).join("\n") + "\n");
  const webUpdates = (await client.updates("main-test", "run-fake", 0)).updates;
  assert.deepEqual(webUpdates.filter(update => update.kind === "activity").map(({ id, category, phase, text, title }) => ({ id, category, phase, text, title })), [
    { id: "web-1", category: "tool", phase: "started", text: "첫 검색\nsecond query", title: "Web search" },
    { id: "web-1", category: "tool", phase: "completed", text: "첫 검색\nsecond query", title: "Web search" },
    { id: "web-2", category: "tool", phase: "completed", text: "legacy query", title: "Web search" },
    { id: "web-3", category: "tool", phase: "started", text: "Web search", title: "Web search" },
    { id: "web-3", category: "tool", phase: "failed", text: "Web search", title: "Web search" }
  ]);
  assert.equal(webUpdates[1].text, "Searching the web");
  assert.equal(webUpdates.at(-1).text, "Web search failed");
  for (const type of ["openPage", "open_page", undefined]) {
    const url = "https://dictionary.cambridge.org/us/dictionary/english/wave";
    await writeFile(eventsPath, [
      { type: "item.started", item: { id: "open-1", type: "webSearch", action: { type, url } } },
      { type: "item.completed", item: { id: "open-1", type: "webSearch", action: { type, url } } },
      { type: "item.completed", item: { id: "open-2", type: "web_search", action: { type, url }, error: "unavailable" } },
      { type: "item.completed", item: { id: "url-search", type: "webSearch", action: { type: "search", query: url } } }
    ].map(JSON.stringify).join("\n") + "\n");
    const updates = (await client.updates("main-test", "run-fake", 0)).updates;
    assert.deepEqual(updates.filter(update => update.kind === "activity").map(({ title, text, phase }) => ({ title, text, phase })), [
      { title: "Open webpage", text: url, phase: "started" },
      { title: "Open webpage", text: url, phase: "completed" },
      { title: "Open webpage", text: url, phase: "failed" },
      { title: "Web search", text: url, phase: "completed" }
    ]);
    assert.equal(updates[1].text, "Opening webpage");
    assert.equal(updates[5].text, "Failed to open webpage");
  }
  await writeFile(eventsPath, [
    { type: "native.commentary", text: "   " },
    { type: "native.commentary", text: commentary },
    { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "private reasoning" } }
  ].map(JSON.stringify).join("\n") + "\n");
  const commentaryUpdates = (await client.updates("main-test", "run-fake", 0)).updates;
  assert.deepEqual(commentaryUpdates.filter((update) => update.kind === "commentary"), [{ kind: "commentary", text: commentary }]);
  assert.equal(commentaryUpdates[1].text, "Working");

  await writeFile(eventsPath, [
    { type: "native.delta", stream: "commentary", id: "msg:1", text: "Work" },
    { type: "native.delta", stream: "final", id: "toolu", text: "결과" },
    { type: "native.delta", stream: "reasoning", id: "x", text: "hidden" },
    { type: "native.delta", stream: "final", id: "toolu", text: "" }
  ].map(JSON.stringify).join("\n") + "\n");
  assert.deepEqual((await client.updates("main-test", "run-fake", 0)).updates, [
    { kind: "delta", stream: "commentary", id: "msg:1", text: "Work" },
    { kind: "delta", stream: "final", id: "toolu", text: "결과" }
  ]);

  await writeFile(eventsPath, [
    { type: "item.started", item: { id: "compact-1", type: "contextCompaction" } },
    { type: "item.completed", item: { id: "compact-1", type: "contextCompaction" } }
  ].map(JSON.stringify).join("\n") + "\n");
  const compactionUpdates = (await client.updates("main-test", "run-fake", 0)).updates;
  assert.deepEqual(compactionUpdates.filter(update => update.kind !== "usage"), [
    { kind: "activity", id: "compact-1", category: "tool", phase: "started", text: "Compacting context", title: "Context compaction" },
    { kind: "status", text: "Compacting context" },
    { kind: "activity", id: "compact-1", category: "tool", phase: "completed", text: "Context compaction completed", title: "Context compaction" },
    { kind: "status", text: "Context compaction completed" }
  ]);

  await writeFile(eventsPath, [
    { type: "item.completed", item: { id: "read-1", type: "command_execution", command: "/bin/zsh -lc 'nl -ba src/a.ts | sed -n 1,20p'", exit_code: 0, durationMs: 42,
      commandActions: [{ type: "read", command: "nl -ba src/a.ts", name: "a.ts", path: join(projectRoot, "src/a.ts") }] } },
    { type: "item.completed", item: { id: "search-1", type: "command_execution", command: "rg -n TODO src", exit_code: 1,
      commandActions: [{ type: "search", command: "rg -n TODO src", query: "TODO", path: "src" }] } },
    { type: "item.completed", item: { id: "bash-1", type: "command_execution", command: "npm test", status: "failed", error: "Exit code 2\nnpm ERR!" } },
    { type: "item.started", item: { id: "tool-1", type: "mcp_tool_call", server: "claude", tool: "Read", arguments: { file_path: join(projectRoot, "src/b.py"), offset: 120, limit: 40 } } },
    { type: "item.completed", item: { id: "tool-2", type: "mcp_tool_call", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" },
      durationMs: 700, status: "failed", error: { message: "net::ERR_FAILED" }, result: { content: [{ type: "text", text: "navigation failed" }] } } },
    { type: "item.started", item: { id: "think-1", type: "reasoning", summary: [] } },
    { type: "item.completed", item: { id: "think-1", type: "reasoning", summary: ["**Plan**", "Check rows"], content: ["private"] } },
    { type: "item.completed", item: { id: "patch-1", type: "file_change", status: "failed", changes: [{ path: join(projectRoot, "src/c.ts") }] } }
  ].map(JSON.stringify).join("\n") + "\n");
  const detailUpdates = (await client.updates("main-test", "run-fake", 0)).updates.filter(update => update.kind === "activity");
  const pick = ({ id, phase, activityKind, target, scope, lineStart, lineEnd, durationMs, exitCode, error, summary, output }) =>
    JSON.parse(JSON.stringify({ id, phase, activityKind, target, scope, lineStart, lineEnd, durationMs, exitCode, error, summary, output }));
  assert.deepEqual(detailUpdates.map(pick), [
    { id: "read-1", phase: "completed", activityKind: "read", target: "src/a.ts", durationMs: 42 },
    { id: "search-1", phase: "failed", activityKind: "search", target: "TODO", scope: "src", exitCode: 1 },
    { id: "bash-1", phase: "failed", error: "Exit code 2\nnpm ERR!" },
    { id: "tool-1", phase: "started", activityKind: "read", target: "src/b.py", lineStart: 120, lineEnd: 159 },
    { id: "tool-2", phase: "failed", activityKind: "tool", scope: "https://example.com", durationMs: 700, error: "net::ERR_FAILED", output: "navigation failed" },
    { id: "think-1", phase: "started", activityKind: "think" },
    { id: "think-1", phase: "completed", activityKind: "think", summary: "**Plan**\n\nCheck rows" },
    { id: "patch-1", phase: "failed" }
  ]);
  assert.ok(detailUpdates.every(update => !JSON.stringify(update).includes("private")), "raw reasoning content stays private");

  assert.deepEqual(await client.result("main-test", "run-fake"), {
    status: "completed",
    text: "Main result text\n"
  });
  await client.cancel("main-test", "run-fake");

  const parentEvents = join(agentsRoot(projectRoot), "main-parent/runs/run-parent/events.jsonl");
  await mkdir(dirname(parentEvents), { recursive: true });
  await writeFile(parentEvents, JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "python3 loop.py start --work-agent work-hidden --verification-agent verification-not-started"
    }
  }) + "\n");
  const childState = join(agentsRoot(projectRoot), "work-hidden/runs/run-child/state.json");
  await mkdir(dirname(childState), { recursive: true });
  await writeFile(childState, JSON.stringify({ status: "completed", executionOptions: { model: "gpt-expert", reasoningEffort: "high" } }));
  assert.deepEqual(await client.listChildSessions("main-parent"), [{
    agentId: "work-hidden",
    parentRunId: "run-parent",
    runId: "run-child",
    role: "work",
    status: "completed",
    model: "gpt-expert",
    reasoningEffort: "high",
    updatedAt: "2026-09-01T10:00:00Z"
  }]);

  const invocations = (await readFile(join(projectRoot, "fake-invocations.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(invocations.map((arguments_) => arguments_[0]), ["list", "submit", "status", "result", "cancel"],
    "Session and child lookups share the equivalent project list snapshot");
  assert.ok(invocations[1].includes("--role"));
  assert.ok(invocations[1].includes("main"));
  assert.ok(invocations[1].includes("gpt-5.6-sol"));
  assert.ok(invocations[1].includes("high"));
  assert.ok(invocations[1].includes("--fast"));
  assert.ok(invocations[1].includes("--goal-mode"));
});

test("runtime client refreshes changed context usage during a turn and forces the final refresh", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-factory-live-usage-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const codexHome = join(projectRoot, "codex-home");
  const runRoot = join(agentsRoot(projectRoot), "main-test/runs/run-live");
  const eventsPath = join(runRoot, "events.jsonl");
  const rolloutPath = join(codexHome, "sessions/2026/09/10/rollout-session-live.jsonl");
  await mkdir(dirname(eventsPath), { recursive: true });
  await mkdir(dirname(rolloutPath), { recursive: true });
  await writeFile(join(runRoot, "state.json"), JSON.stringify({ sessionId: "session-live" }));
  await writeFile(eventsPath, JSON.stringify({ type: "turn.started" }) + "\n");
  const tokenCount = (inputTokens, rate_limits) => JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: inputTokens },
        model_context_window: 258_400
      },
      rate_limits
    }
  }) + "\n";
  await writeFile(rolloutPath, tokenCount(10_000, {
    primary: { used_percent: 25, window_minutes: 300, resets_at: 1_790_506_200 },
    secondary: { used_percent: 12.5, window_minutes: 10_080, resets_at: 1_790_953_200 }
  }));
  let now = 0;
  const client = new AgentFactoryClient(
    new URL("../fixtures/fake-exec.py", import.meta.url).pathname,
    projectRoot,
    "python3",
    codexHome,
    undefined,
    () => now
  );

  assert.deepEqual(await client.updates("main-test", "run-live", 0), {
    cursor: 1,
    updates: [
      { kind: "status", text: "Main Agent is analyzing the request" },
      { kind: "usage", usedTokens: 10_000, contextWindowTokens: 258_400, weeklyUsedPercent: 12.5,
        weeklyResetsAt: 1_790_953_200, fiveHourUsedPercent: 25, fiveHourResetsAt: 1_790_506_200 },
      { kind: "accountLimits", limits: { provider: "codex", weeklyUsedPercent: 12.5, weeklyResetsAt: 1_790_953_200,
        fiveHourUsedPercent: 25, fiveHourResetsAt: 1_790_506_200 } }
    ]
  });
  await appendFile(rolloutPath, tokenCount(20_000, {
    primary: { used_percent: 25, window_minutes: 300 }
  }));
  now = 999;
  assert.deepEqual(await client.updates("main-test", "run-live", 1), { cursor: 1, updates: [] });
  now = 1_000;
  assert.deepEqual(await client.updates("main-test", "run-live", 1), {
    cursor: 1,
    updates: [
      { kind: "usage", usedTokens: 20_000, contextWindowTokens: 258_400, fiveHourUsedPercent: 25 },
      { kind: "accountLimits", limits: { provider: "codex", fiveHourUsedPercent: 25 } }
    ]
  });

  await appendFile(rolloutPath, tokenCount(30_000, {
    primary: { used_percent: 140, window_minutes: 10_080 }
  }));
  await appendFile(eventsPath, JSON.stringify({ type: "turn.completed" }) + "\n");
  assert.deepEqual(await client.updates("main-test", "run-live", 1), {
    cursor: 2,
    updates: [
      { kind: "status", text: "Finalizing response" },
      { kind: "usage", usedTokens: 30_000, contextWindowTokens: 258_400 }
    ]
  });

  // Claude runs have no rollout; the runtime records context and weekly usage in the run state.
  const claudeRunRoot = join(agentsRoot(projectRoot), "main-test/runs/run-claude");
  await mkdir(claudeRunRoot, { recursive: true });
  await writeFile(join(claudeRunRoot, "state.json"), JSON.stringify({
    provider: "claude",
    contextUsage: { usedTokens: 40_000, contextWindowTokens: 1_000_000, weeklyUsedPercent: 19, fiveHourUsedPercent: 25,
      weeklyResetsAt: 1_790_953_200, fiveHourResetsAt: 1_790_506_200 }
  }));
  await writeFile(join(claudeRunRoot, "events.jsonl"), JSON.stringify({ type: "turn.started" }) + "\n");
  assert.deepEqual((await client.updates("main-test", "run-claude", 0)).updates.slice(-2), [
    { kind: "usage", usedTokens: 40_000, contextWindowTokens: 1_000_000, weeklyUsedPercent: 19, weeklyResetsAt: 1_790_953_200,
      fiveHourUsedPercent: 25, fiveHourResetsAt: 1_790_506_200 },
    { kind: "accountLimits", limits: { provider: "claude", weeklyUsedPercent: 19, weeklyResetsAt: 1_790_953_200,
      fiveHourUsedPercent: 25, fiveHourResetsAt: 1_790_506_200 } }
  ]);
  // Account limits arrive before the run records context tokens, and repeat only when they change.
  const limitsOnlyRoot = join(agentsRoot(projectRoot), "main-test/runs/run-claude-limits");
  await mkdir(limitsOnlyRoot, { recursive: true });
  await writeFile(join(limitsOnlyRoot, "state.json"), JSON.stringify({
    provider: "claude", contextUsage: { fiveHourUsedPercent: 80, fiveHourResetsAt: 1_790_709_600 }
  }));
  await writeFile(join(limitsOnlyRoot, "events.jsonl"), JSON.stringify({ type: "turn.started" }) + "\n");
  assert.deepEqual((await client.updates("main-test", "run-claude-limits", 0)).updates.at(-1),
    { kind: "accountLimits", limits: { provider: "claude", fiveHourUsedPercent: 80, fiveHourResetsAt: 1_790_709_600 } });
  now += 1_000;
  assert.ok(!(await client.updates("main-test", "run-claude-limits", 1)).updates.some(update => update.kind === "accountLimits"));
});

test("session controller binds once, sends later turns, and retains attachment references", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const calls = [];
  const messages = [];
  const runtime = {
    async submit(agentId, message, execution) {
      calls.push(["submit", agentId, message, execution]);
      return { agentId, runId: "run-one" };
    },
    async send(agentId, message, execution) {
      calls.push(["send", agentId, message, execution]);
      return { agentId, runId: "run-two" };
    },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; },
    async cancel() {}
  };
  const controller = new ChatSessionController(runtime, {
    onBound(agentId) { messages.push(["bound", agentId]); },
    onRunningChanged(running) { messages.push(["running", running]); },
    onAssistantText(text) { messages.push(["assistant", text]); },
    onProgress(text) { messages.push(["progress", text]); },
    onActivity(activity) { messages.push(["activity", activity]); },
    onStatusObserved(status) { messages.push(["status", status]); },
    onError(text) { messages.push(["error", text]); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 2 });

  const execution = { model: "gpt-5.6-terra", reasoningEffort: "medium", fast: false, goalMode: false };
  await controller.send("first", [{ id: "a", name: "notes.md", kind: "file", uri: "file:///tmp/notes.md" }], execution);
  await controller.send("second", [], execution);

  assert.equal(calls[0][0], "submit");
  assert.match(calls[0][1], /^main-[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(calls[0][2].split("첨부 참조:\n")[1].split("\n")[0]),
    [{ kind: "file", name: "notes.md", uri: "file:///tmp/notes.md" }]);
  assert.deepEqual(calls.map((call) => call[0]), ["submit", "send"]);
  assert.equal(calls[1][1], calls[0][1]);
  assert.deepEqual(calls[0][3], execution);
  assert.deepEqual(calls[1][3], execution);
  assert.equal(messages.filter((message) => message[0] === "assistant").length, 2);
  assert.deepEqual(messages.filter((message) => message[0] === "status"), [["status", "completed"], ["status", "completed"]]);
});

test("session controller batches concurrent sends in order without dropping attachments or first settings", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let releaseStatus;
  let statusCalls = 0;
  const calls = [], queueCounts = [], running = [], errors = [];
  const runtime = {
    async submit(agentId, message, execution) {
      calls.push(["submit", message, execution]);
      return { agentId, runId: "run-busy" };
    },
    async send(agentId, message, execution) {
      calls.push(["send", message, execution]);
      return { agentId, runId: `run-${calls.length}` };
    },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    status() {
      statusCalls += 1;
      return statusCalls === 1
        ? new Promise((resolve) => { releaseStatus = resolve; })
        : Promise.resolve({ status: "completed" });
    },
    async result() { return { status: "completed", text: "done" }; },
    async cancel() {}
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {},
    onRunningChanged(value) { running.push(value); },
    onQueueChanged(count) { queueCounts.push(count); },
    onAssistantText() {},
    onProgress() {},
    onActivity() {},
    onError(message) { errors.push(message); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 2 });

  const execution = { fast: false, goalMode: false };
  const first = controller.send("first", [], execution);
  while (!releaseStatus) await new Promise((resolve) => setImmediate(resolve));
  const secondExecution = { model: "gpt-6-astra", fast: true, goalMode: false };
  const second = controller.send("second", [{ id: "queued", name: "queued.md", kind: "file", uri: "file:///tmp/queued.md" }], secondExecution);
  const third = controller.send("third", [], execution);
  assert.equal(controller.queueLength, 2);
  releaseStatus({ status: "completed" });
  await Promise.all([first, second, third]);

  assert.deepEqual(calls.map(call => call[0]), ["submit", "send"]);
  assert.match(calls[1][1], /대기 메시지 1 시작 ---\nsecond\n\n첨부 참조:/);
  assert.deepEqual(JSON.parse(calls[1][1].split("첨부 참조:\n")[1].split("\n")[0]),
    [{ kind: "file", name: "queued.md", uri: "file:///tmp/queued.md" }]);
  assert.match(calls[1][1], /대기 메시지 2 시작 ---\nthird/);
  assert.deepEqual(calls[1][2], { ...secondExecution, businessMode: "normal" });
  assert.deepEqual(queueCounts, [1, 2, 0]);
  assert.deepEqual(running, [true, false]);
  assert.deepEqual(errors, []);
  assert.equal(controller.queueLength, 0);
});

test("cancellation requested during submission is delivered once to the accepted run", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let acceptSubmit, releaseCancel;
  const submitGate = new Promise(resolve => { acceptSubmit = resolve; });
  const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
  const cancellations = [], progress = [];
  const runtime = {
    async submit() { return submitGate; },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "cancelled result" }; },
    async cancel(...args) { cancellations.push(args); await cancelGate; }
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onActivity() {}, onError() {},
    onProgress(text) { progress.push(text); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 1 });

  const sending = controller.send("task", [], {});
  await new Promise(resolve => setImmediate(resolve));
  await controller.cancel();
  await controller.cancel();
  assert.match(progress.at(-1), /cancellation as soon as the run is accepted/);
  acceptSubmit({ agentId: "main-accepted", runId: "run-accepted" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancellations, [["main-accepted", "run-accepted"]]);
  releaseCancel();
  await sending;
});

test("Goal control serializes reopen requests before runtime acceptance", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let releaseGoal;
  const gate = new Promise(resolve => { releaseGoal = resolve; });
  const calls = [], errors = [];
  const controller = new ChatSessionController({
    async goal(agentId, action) { calls.push([agentId, action]); return gate; },
    async send() { throw new Error("send must not race Goal reopen"); }
  }, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {},
    onError(error) { errors.push(error); }
  }, "main-exact");

  const first = controller.controlGoal("reopen");
  await new Promise(resolve => setImmediate(resolve));
  await controller.controlGoal("reopen");
  const queued = controller.send("racing request", [], {});
  assert.equal(controller.queueLength, 1);
  assert.deepEqual(calls, [["main-exact", "reopen"]]);
  assert.deepEqual(errors, [
    "The previous Goal control request is still processing."
  ]);
  releaseGoal({ goal: null });
  await first;
  await queued;
});

test("cancellation during Goal reopen acceptance targets the accepted run once", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let acceptGoal;
  const gate = new Promise(resolve => { acceptGoal = resolve; });
  const cancellations = [], progress = [];
  const controller = new ChatSessionController({
    async goal() { return gate; },
    async cancel(...args) { cancellations.push(args); },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; }
  }, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onActivity() {}, onError() {},
    onProgress(text) { progress.push(text); }
  }, "main-exact", { pollIntervalMs: 0, maxPolls: 1 });

  const reopening = controller.controlGoal("reopen");
  await new Promise(resolve => setImmediate(resolve));
  await controller.cancel();
  await controller.cancel();
  assert.match(progress.at(-1), /cancellation as soon as the Goal run is accepted/);
  acceptGoal({ accepted: { agentId: "main-exact", runId: "run-reopened" } });
  await reopening;
  assert.deepEqual(cancellations, [["main-exact", "run-reopened"]]);
});

test("native settings forward changed model and reasoning on exact-session send", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "native-settings-"));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  await client.send("main-exact", "off", { model: "claude-fable-5-1", reasoningEffort: "high", fast: false, goalMode: false });
  await client.send("main-exact", "inherit", {});
  const calls = (await readFile(join(root, "fake-invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf("--agent") + 1], "main-exact");
  assert.ok(calls[0].includes("--no-fast"));
  assert.ok(calls[0].includes("--no-goal-mode"));
  assert.equal(calls[0][calls[0].indexOf("--model") + 1], "claude-fable-5-1");
  assert.equal(calls[0][calls[0].indexOf("--reasoning-effort") + 1], "high");
  assert.ok(!calls[1].some(value => ["--fast", "--no-fast", "--goal-mode", "--no-goal-mode"].includes(value)));
});

test("native Goal events expose status and usage without turning a turn end into goal completion", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "native-goal-events-"));
  const path = join(agentsRoot(root), "main-exact/runs/run-one/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const goal = { threadId: "thread-exact", objective: "Finish the migration", status: "active", tokensUsed: 124, timeUsedSeconds: 9 };
  await writeFile(path, [
    { type: "goal.updated", goal },
    { type: "turn.completed" },
    { type: "goal.continuing" },
    { type: "goal.updated", goal: { ...goal, status: "paused" } }
  ].map(JSON.stringify).join("\n") + "\n");
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const updates = await client.updates("main-exact", "run-one", 0);
  assert.deepEqual(updates.updates.filter(update => update.kind === "goal"), [
    { kind: "goal", goal }, { kind: "goal", goal: { ...goal, status: "paused" } }
  ]);
  assert.ok(updates.updates.some(update => update.kind === "status" && update.text.includes("next turn")));
});

test("Goal control rejects unsupported actions and preserves long objectives", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  for (const action of ["get", "refresh", "pause", "cancel", "disable", "reopen"]) {
    assert.deepEqual(parseClientMessage({ type: "goal.control", action }), { type: "goal.control", action });
  }
  assert.equal(parseClientMessage({ type: "goal.control", action: "complete" }), undefined);
  const message = { type: "chat.send", id: "one", text: "request", attachments: [], execution: { fast: false, goal: true, goalObjective: "finish" } };
  assert.equal(parseClientMessage(message).execution.goalObjective, "finish");
  assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, goalObjective: "x".repeat(4001) } }).execution.goalObjective.length, 4001);
  assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, goal: false } }), undefined);
});

test("runtime acceptance validates identities and permits managed Goal recovery runs", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/workspace");
  client.capabilities = async () => ({
    submit: { model: true, reasoning: true, fast: true, goal: true },
    send: { model: true, reasoning: true, fast: true, goal: true }
  });
  client.command = async () => ({ kind: "ack", status: "accepted", agentId: "main-exact", runId: "../outside" });
  await assert.rejects(client.submit("main-exact", "task", {}), /acceptance response/);
  client.command = async () => ({ kind: "ack", status: "accepted", agentId: "main-exact", runId: "run-exact" });
  for (const action of ["refresh", "pause", "cancel", "disable", "reopen"]) {
    assert.equal((await client.goal("main-exact", action)).accepted.runId, "run-exact");
  }
  await assert.rejects(client.goal("main-exact", "get"), /unexpected run/);
});

test("Goal controls use the bound session and report backend errors", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const calls = [], observed = [], errors = [];
  const goal = { threadId: "thread-exact", objective: "finish", status: "paused", tokensUsed: 9, timeUsedSeconds: 3 };
  const runtime = { async goal(agentId, action) {
    calls.push([agentId, action]);
    if (action === "reopen") throw new Error("native goal unavailable");
    return { goal };
  }};
  const controller = new ChatSessionController(runtime, {
    onGoal(value) { observed.push(value); }, onError(error) { errors.push(error); },
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onUsage() {}, onActivity() {}
  }, "main-exact");
  await controller.controlGoal("get");
  await controller.controlGoal("reopen");
  assert.deepEqual(calls, [["main-exact", "get"], ["main-exact", "reopen"]]);
  assert.deepEqual(observed, [goal]);
  assert.deepEqual(errors, ["native goal unavailable"]);
});

test("authoritative terminal failures cannot be hidden by nonempty completion text", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const status of ["failed", "cancelled", "needs-human-decision"]) {
    const text = [], errors = [], goals = [];
    const runtime = {
      async submit(agentId) { return { agentId, runId: "run-partial" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status, goalError: "pause unconfirmed" }; },
      async result() { return { status, text: "Implementation complete.", error: { code: "native_backend_error", message: "native interrupted or blocked" } }; }
    };
    const controller = new ChatSessionController(runtime, {
      onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {},
      onGoal(goal, error) { goals.push(error); }, onAssistantText(value) { text.push(value); }, onError(value) { errors.push(value); }
    }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
    await controller.send("task", [], {});
    assert.match(text[0], /Preserved partial result/);
    assert.notEqual(text[0], "Implementation complete.");
    assert.match(errors[0], /native_backend_error/);
    assert.deepEqual(goals, ["pause unconfirmed"]);
  }
});

test("framed repeated pause warnings retain the following normal progress event", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "goal-warning-framing-"));
  const path = join(agentsRoot(root), "main-exact/runs/run-one/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    { type: "goal.error", message: "warning one" },
    { type: "goal.error", message: "warning two" },
    { type: "turn.completed" }
  ].map(value => JSON.stringify(value) + "\n").join(""));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const result = await client.updates("main-exact", "run-one", 0);
  assert.equal(result.cursor, 3);
  assert.deepEqual(result.updates.filter(value => value.kind === "goal").map(value => value.error), ["warning one", "warning two"]);
  assert.ok(result.updates.some(value => value.kind === "status" && value.text.includes("Finalizing response")));
});


test("runtime reads reject symlink ancestors and arbitrary result paths", async function (t) {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-extension-safe-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  await client.listSessions();
  assert.equal(await readFile(join(root, "fake-invocations.jsonl"), "utf8").then((text) => text.includes('"list"')), true);
  const external = join(root, "external");
  await mkdir(external);
  await writeFile(join(external, "result.md"), "outside");
  await assert.rejects(client.readManagedResult(join(external, "result.md"), "main-test", "run-fake"), /outside the expected scope/);
  await symlink(external, join(agentsRoot(root), "main-test"), "dir");
  await assert.rejects(client.updates("main-test", "run-fake", 0), /Unsafe/);
  await assert.rejects(readFile(join(root, ".agent-factory")), { code: "ENOENT" });
});


test("session controller forwards live deltas with their run before the complete output", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const order = [];
  const runtime = {
    async submit(agentId) { return { agentId, runId: "delta-run" }; },
    async updates() { return { cursor: 4, updates: [
      { kind: "delta", stream: "commentary", id: "m:1", text: "Look" },
      { kind: "delta", stream: "final", id: "toolu", text: "fin" },
      { kind: "delta", stream: "final", id: "toolu", text: "al" },
      { kind: "status", text: "Working" }
    ] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "final" }; }
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onError() {},
    onAssistantDelta(delta) { order.push(delta); },
    onAssistantText(text, phase, runId) { order.push({ text, phase, runId }); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await controller.send("request", [], { fast: false, goalMode: false });
  // Consecutive fragments of one block arrive as one merged message.
  assert.deepEqual(order, [
    { runId: "delta-run", stream: "commentary", id: "m:1", text: "Look" },
    { runId: "delta-run", stream: "final", id: "toolu", text: "final" },
    { text: "final", phase: "final", runId: "delta-run" }
  ]);
});

test("session controller emits complete commentary once and marks final output", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const messages = [];
  const commentary = "긴 진행 설명 ".repeat(100);
  const runtime = {
    async submit(agentId) { return { agentId, runId: "commentary-run" }; },
    async updates() { return { cursor: 3, updates: [
      { kind: "commentary", text: " " },
      { kind: "commentary", text: commentary },
      { kind: "status", text: "Working" },
      { kind: "commentary", text: commentary }
    ] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "final result" }; }
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onError() {},
    onAssistantText(text, phase) { messages.push({ text, phase }); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await controller.send("request", [], { fast: false, goalMode: false });
  assert.deepEqual(messages, [
    { text: commentary, phase: "commentary" },
    { text: "final result", phase: "final" }
  ]);
});


for (const taskMode of ["plan-work", "plan-work-verification"]) {
test(`human decision approvals preserve ${taskMode}, are explicit, once-only and bound to the pending run`, async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const decisions = [], texts = [], sent = [], errors = [], human = [];
  let nextStatus = "needs-human-decision";
  const runtime = {
    async submit(agentId) { return { agentId, runId: "proposal-run" }; },
    async send(agentId, text, execution) { sent.push({ text, execution }); return { agentId, runId: "reply-run" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: nextStatus }; },
    async result() { return { status: nextStatus, text: "제안한 범위로 진행할까요?", decisionKind: nextStatus === "needs-human-decision" ? "approval" : undefined }; }
  };
  const events = {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {},
    onAssistantText(text, phase, runId) { texts.push({ text, phase, runId }); },
    onDecision(runId) { decisions.push(runId); }, onHumanDecision(text) { human.push(text); },
    onError(error) { errors.push(error); }
  };
  const controller = new ChatSessionController(runtime, events, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await controller.send("task", [], { taskMode });
  assert.deepEqual(errors, []);
  assert.equal(decisions.at(-1), "proposal-run");
  assert.deepEqual(texts.at(-1), { text: "제안한 범위로 진행할까요?", phase: "final", runId: "proposal-run" });
  assert.equal(sent.length, 0);
  assert.equal(controller.approveDecision("stale-run", {}), false);
  const restored = new ChatSessionController(runtime, events, "restored-agent");
  assert.equal(restored.approveDecision("proposal-run", {}), false);
  nextStatus = "completed";
  assert.equal(controller.approveDecision("proposal-run", {}), true);
  assert.equal(controller.approveDecision("proposal-run", {}), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].execution.actor, "human");
  assert.equal(sent[0].execution.taskMode, taskMode);
  assert.ok(sent[0].text.startsWith(human[0]));
  assert.equal(controller.approveDecision("proposal-run", {}), false);
  nextStatus = "needs-human-decision";
  await controller.send("another proposal", [], {});
  assert.equal(decisions.at(-1), "reply-run");
  nextStatus = "completed";
  await controller.send("직접 답변", [], {});
  assert.equal(controller.approveDecision("reply-run", {}), false);
});
}

test("decision buttons are not inferred from completed prose or diagnostic partial results", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const result of [
    { status: "completed", text: "진행할까요?" },
    { status: "needs-human-decision", text: "진행할까요?", error: { code: "failed", message: "failed" } },
    { status: "needs-human-decision", text: "" }
  ]) {
    const decisions = [];
    const controller = new ChatSessionController({
      async submit(agentId) { return { agentId, runId: "run-one" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status: result.status }; }, async result() { return result; }
    }, {
      onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {},
      onAssistantText() {}, onError() {}, onDecision(runId) { decisions.push(runId); }
    }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
    await controller.send("task", [], {});
    assert.deepEqual(decisions, [null]);
    assert.equal(controller.approveDecision("run-one", {}), false);
  }
});

test("approval protocol accepts only explicit bounded run identifiers", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "decision.approve", runId: "run-123" }), { type: "decision.approve", runId: "run-123" });
  for (const runId of [undefined, "", "../run", "r".repeat(129), 123]) {
    assert.equal(parseClientMessage({ type: "decision.approve", runId }), undefined);
  }
  assert.deepEqual(parseClientMessage({ type: "decision.approve", runId: "run-123", language: "en" }), { type: "decision.approve", runId: "run-123", language: "en" });
  assert.equal(parseClientMessage({ type: "decision.approve", runId: "run-123", language: "fr" }), undefined);
});

test("execution selection protocol accepts only listed modes", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  for (const mode of ["cli-default", "workspace-write", "danger-full-access", "bypass"]) {
    assert.deepEqual(parseClientMessage({ type: "execution.select", mode }), { type: "execution.select", mode });
  }
  for (const mode of [undefined, "read-only", "unsafe", 1]) {
    assert.equal(parseClientMessage({ type: "execution.select", mode }), undefined);
  }
});

test("explicit execution mode applies sandbox and never approval to submit and send", async () => {
  const { AgentFactoryClient, executionPolicyArguments } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.deepEqual(executionPolicyArguments(), []);
  assert.throws(() => executionPolicyArguments("unsafe-unknown"), /execution permissions/);
  const root = await mkdtemp(join(tmpdir(), "af-execution-mode-"));
  try {
    const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
    await client.submit("main-default", "task", { executionMode: "cli-default" });
    await client.submit("main-workspace", "task", { executionMode: "workspace-write" });
    await client.submit("main-full", "task", { executionMode: "danger-full-access" });
    await client.submit("main-bypass", "task", { executionMode: "bypass" });
    await client.send("main-full", "next", { executionMode: "bypass" });
    await client.send("main-full", "keep policy", { executionMode: "cli-default" });
    const calls = (await readFile(join(root, "fake-invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls[0].includes("--sandbox"), false);
    for (const [index, mode] of [[1, "workspace-write"], [2, "danger-full-access"], [3, "danger-full-access"]]) {
      assert.equal(calls[index][calls[index].indexOf("--sandbox") + 1], mode);
      assert.equal(calls[index][calls[index].indexOf("--approval-policy") + 1], "never");
      assert.equal(calls[index][calls[index].indexOf("--human-approval-policy") + 1], index === 3 ? "bypass" : "required");
    }
    assert.equal(calls[4][0], "send");
    assert.equal(calls[4][calls[4].indexOf("--sandbox") + 1], "danger-full-access");
    assert.equal(calls[4][calls[4].indexOf("--approval-policy") + 1], "never");
    assert.equal(calls[4][calls[4].indexOf("--human-approval-policy") + 1], "bypass");
    assert.equal(calls[5].includes("--sandbox"), false);
    assert.equal(calls[5].includes("--approval-policy"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime capabilities expose only recognized stored session execution modes", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/unused/project");
  const flags = { model: false, reasoning: false, fast: false, goal: false };
  for (const mode of ["read-only", "workspace-write", "danger-full-access", "bypass", "unknown", undefined]) {
    client.command = async () => ({ kind: "execution-capabilities", schemaVersion: "0.1.0", submit: flags, send: flags, executionMode: mode });
    const observed = await client.capabilities(String(mode));
    assert.equal(observed.executionMode, mode === "unknown" ? undefined : mode);
  }
});

test("active run discovery includes queued runs, skips terminal runs and validates identities", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  assert.equal(await client.activeRun("main-test"), undefined);
  for (const [runId, status, agentId] of [["run-1", "queued", "main-test"], ["run-2", "completed", "main-test"], ["run-3", "running", "different-agent"]]) {
    const path = join(agentsRoot(root), "main-test", "runs", runId, "state.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ runId, agentId, status }));
  }
  assert.deepEqual(await client.activeRun("main-test"), { agentId: "main-test", runId: "run-1" });
  await writeFile(join(agentsRoot(root), "main-test/runs/run-1/state.json"), JSON.stringify({ agentId: "main-test", runId: "run-1", status: "cancelled" }));
  assert.equal(await client.activeRun("main-test"), undefined);
});

test("pending decision discovery uses the latest accepted run", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-decision-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const runDirectory = join(agentsRoot(root), "main-test", "runs");
  await mkdir(join(runDirectory, "run-1"), { recursive: true });
  await mkdir(join(runDirectory, "run-2"), { recursive: true });
  await writeFile(join(runDirectory, "run-1", "state.json"), JSON.stringify({ agentId: "main-test", runId: "run-1", status: "needs-human-decision", acceptedAt: "2026-09-30T10:00:00Z" }));
  await writeFile(join(runDirectory, "run-2", "state.json"), JSON.stringify({ agentId: "main-test", runId: "run-2", status: "completed", acceptedAt: "2026-09-30T11:00:00Z" }));
  assert.equal(await client.pendingDecision("main-test"), undefined);
  await writeFile(join(runDirectory, "run-2", "state.json"), JSON.stringify({ agentId: "main-test", runId: "run-2", status: "needs-human-decision", acceptedAt: "2026-09-30T11:00:00Z" }));
  assert.deepEqual(await client.pendingDecision("main-test"), { runId: "run-2" });
});

test("reconnect with no active run hands racing input to the pending batch exactly once", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let resolveDiscovery;
  const discovery = new Promise(resolve => { resolveDiscovery = resolve; });
  let discoveries = 0;
  const sent = [], queueCounts = [];
  const controller = new ChatSessionController({
    activeRun() { discoveries += 1; return discovery; },
    async send(agentId, message) { sent.push(message); return { agentId, runId: `run-${sent.length}` }; },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; }
  }, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onError() {},
    onQueueChanged(count) { queueCounts.push(count); }
  }, "main-race", { pollIntervalMs: 0, maxPolls: 1 });

  const reconnecting = controller.reconnect();
  const first = controller.send("first", [], {});
  const second = controller.send("second", [], {});
  resolveDiscovery(undefined);
  const third = controller.send("third", [], {});

  assert.equal(await reconnecting, false);
  await Promise.all([first, second, third]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].indexOf("first") < sent[0].indexOf("second"));
  assert.ok(sent[0].indexOf("second") < sent[0].indexOf("third"));
  assert.deepEqual(queueCounts, [1, 2, 3, 0]);
  assert.equal(discoveries, 1);
  assert.equal(controller.queueLength, 0);
});

test("reconnect discovery failure preserves input until a successful reconnect", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let rejectDiscovery;
  const discovery = new Promise((_resolve, reject) => { rejectDiscovery = reject; });
  let discoveries = 0;
  const sent = [];
  const controller = new ChatSessionController({
    activeRun() { discoveries += 1; return discoveries === 1 ? discovery : Promise.resolve(undefined); },
    async send(agentId, message) { sent.push(message); return { agentId, runId: "run-after-error" }; },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; }
  }, {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onActivity() {}, onError() {}
  }, "main-race", { pollIntervalMs: 0, maxPolls: 1 });

  const reconnecting = controller.reconnect();
  const queued = controller.send("preserved", [], {});
  rejectDiscovery(new Error("discovery failed"));

  await assert.rejects(reconnecting, /discovery failed/);
  assert.deepEqual(sent, []);
  assert.equal(controller.queueLength, 1);
  await controller.reconnect();
  await queued;
  assert.deepEqual(sent, ["preserved"]);
  assert.equal(discoveries, 2);
  assert.equal(controller.queueLength, 0);
});

test("reconnect follows an existing run, queues new input and cancels the correct run", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const calls = [], running = [], finals = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  let discovers = 0;
  const runtime = {
    async activeRun() { calls.push("discover"); discovers += 1; return discovers === 1 ? { agentId: "main-existing", runId: "run-active" } : undefined; },
    async updates() { await gate; return { cursor: 0, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "Recovered result" }; },
    async cancel(...args) { calls.push(args); },
    async send(agentId, message) { calls.push(["send", agentId, message]); return { agentId, runId: "run-queued" }; },
    async submit() { throw new Error("Must not submit"); }
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {}, onRunningChanged(value) { running.push(value); if (!value) finished(); },
    onAssistantText(text) { finals.push(text); }, onProgress() {}, onUsage() {}, onActivity() {}, onError() {}
  }, "main-existing", { pollIntervalMs: 1 });
  assert.equal(await controller.reconnect(), true);
  assert.equal(await controller.reconnect(), true);
  assert.equal(calls.filter(value => value === "discover").length, 1);
  assert.equal(controller.running, true);
  const queued = controller.send("new request", [], {});
  assert.equal(controller.queueLength, 1);
  await controller.cancel();
  assert.deepEqual(calls.at(-1), ["main-existing", "run-active"]);
  release();
  await queued;
  await done;
  assert.equal(controller.running, false);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "send" && call[2] === "new request"));
  // The cancelled recovered run does not surface a final result; only the queued request does.
  assert.deepEqual(finals, ["Recovered result"]);
});

test("send discovered during a reconnect race waits for the active run and then preserves the input", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const errors = [], sent = [];
  let discovered = 0;
  const controller = new ChatSessionController({
    async activeRun() { discovered++; return { agentId: "main-existing", runId: "run-active" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; },
    async send(agentId, message) { sent.push([agentId, message]); return { agentId, runId: "run-next" }; }
  }, { onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {}, onUsage() {}, onActivity() {}, onError(error) { errors.push(error); } }, "main-existing");
  await controller.send("task", [], {});
  assert.equal(discovered, 1);
  assert.deepEqual(sent, [["main-existing", "task"]]);
  assert.deepEqual(errors, []);
});

test("closing a recovered chat detaches polling without cancelling its runtime", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let statusCalls = 0, cancelCalls = 0;
  const controller = new ChatSessionController({
    async activeRun() { return { agentId: "main-existing", runId: "run-active" }; },
    async updates() { await gate; return { cursor: 1, updates: [{ kind: "commentary", text: "hidden" }] }; },
    async status() { statusCalls++; return { status: "running" }; },
    async cancel() { cancelCalls++; }
  }, { onBound() {}, onRunningChanged() {}, onAssistantText() { assert.fail("Detached chat received output"); }, onProgress() {}, onUsage() {}, onActivity() {}, onError() {} }, "main-existing");
  await controller.reconnect();
  controller.dispose();
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(statusCalls, 0);
  assert.equal(cancelCalls, 0);
});

test("current run child lookup excludes agents called by earlier turns", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-current-children-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const oldEvents = join(agentsRoot(root), "main-parent/runs/run-old/events.jsonl");
  const newEvents = join(agentsRoot(root), "main-parent/runs/run-new/events.jsonl");
  const childState = join(agentsRoot(root), "work-hidden/runs/run-child/state.json");
  for (const path of [oldEvents, newEvents, childState]) await mkdir(dirname(path), { recursive: true });
  const event = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "python3 loop.py start --work-agent work-hidden" } }) + "\n";
  await writeFile(oldEvents, event);
  await writeFile(newEvents, "");
  await writeFile(childState, JSON.stringify({ status: "completed" }));
  assert.equal((await client.listChildSessions("main-parent")).length, 1);
  assert.deepEqual(await client.listChildSessions("main-parent", "run-new"), []);
  await writeFile(newEvents, event);
  assert.equal((await client.listChildSessions("main-parent", "run-new")).length, 1);
  await writeFile(join(dirname(oldEvents), "state.json"), JSON.stringify({ taskMode: "work-verification" }));
  await writeFile(join(dirname(newEvents), "state.json"), JSON.stringify({ taskMode: "direct" }));
  await writeFile(childState, JSON.stringify({ status: "completed", parentAgentId: "main-parent", parentRunId: "run-old" }));
  const tracked = (await client.listChildSessions("main-parent"))[0];
  assert.equal(tracked.parentRunId, "run-old", "A later status lookup must not replace dispatch authority");
  assert.equal(tracked.taskMode, "work-verification");
  await assert.rejects(client.listChildSessions("main-parent", "../run-old"));
});

test("child discovery retries an event log appended between read and metadata validation", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-child-append-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = join(agentsRoot(root), "main-parent/runs/run-current/events.jsonl");
  const childState = join(agentsRoot(root), "work-hidden/runs/run-child/state.json");
  await mkdir(dirname(events), { recursive: true });
  await mkdir(dirname(childState), { recursive: true });
  await writeFile(events, "");
  await writeFile(childState, JSON.stringify({ status: "completed", parentAgentId: "main-parent", parentRunId: "run-current" }));
  const appended = JSON.stringify({ type: "item.completed", item: { type: "command_execution",
    command: "python3 loop.py start --work-agent work-hidden" } }) + "\n";
  let appendOnce = true;
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root,
    undefined, undefined, undefined, Date.now, undefined, async path => {
      if (appendOnce && path === events) { appendOnce = false; await appendFile(events, appended); }
    });
  assert.equal((await client.listChildSessions("main-parent", "run-current")).length, 1,
    "The retry must include a child appended after the first EOF");
  assert.equal((await client.listChildSessions("main-parent", "run-current")).length, 1,
    "The stable retry result may be cached without hiding the appended child");
});

test("child progress counts queued work and verifying children but excludes completed verification", async () => {
  const script = await readChatSource();
  const source = script.slice(script.indexOf("  function summarizeChildAgents("), script.indexOf("  function childAgentStatusLabel("));
  const context = { agents: [{ role: "work", status: "queued" }, { role: "verification", status: "verifying" }, { role: "verification", status: "completed" }] };
  const result = runInNewContext(source + "\nsummarizeChildAgents(agents)", context);
  assert.equal(result.activeUnits, 2);
  assert.equal(result.workActive, 1);
  assert.equal(result.verificationActive, 1);
});

test("direct managed commands discover children through shell wrappers and retain exact run status", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-direct-children-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const events = join(agentsRoot(root), "main-parent/runs/run-current/events.jsonl");
  await mkdir(dirname(events), { recursive: true });
  for (const [agent, run, state] of [
    ["work-hidden", "run-old", { status: "completed" }],
    ["work-hidden", "run-newer", { status: "failed" }],
    ["verification-hidden", "run-verification", { status: "running", verifiedWorkRunId: "run-old" }],
    ["verification-hidden", "run-z-unrelated", { status: "completed" }]
  ]) {
    const path = join(agentsRoot(root), agent, "runs", run, "state.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state));
  }
  const event = (command, output = "") => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: output } });
  const work = `python3 skills/agent/scripts/exec.py result --project-root '${root}' --agent='work-hidden' --run-id=run-old`;
  const verification = `python3 '/installed plugin/skills/agent/scripts/exec.py' submit --project-root='${root}' --agent "verification-hidden" --role verification --message 'Please verify; do not run unrelated --agent work-hidden'`;
  const shell = command => `/usr/bin/zsh -lc '${command.replaceAll("'", "'\\''")}'`;
  await writeFile(events, [event(shell(work)), event(shell(verification), JSON.stringify({ kind: "ack", agentId: "verification-hidden", runId: "run-verification" }))].join("\n"));
  assert.deepEqual(await client.listChildSessions("main-parent", "run-current"), [
    { parentRunId: "run-current", agentId: "verification-hidden", role: "verification", runId: "run-verification", status: "running", progressKey: "ui.working", verifiedWorkRunId: "run-old", updatedAt: "2026-09-01T11:00:00Z" },
    { parentRunId: "run-current", agentId: "work-hidden", role: "work", runId: "run-old", status: "completed", updatedAt: "2026-09-01T10:00:00Z" }
  ]);
  const polling = `for i in {1..15}; do state_json=$(python3 skills/agent/scripts/exec.py status --agent verification-hidden --run-id run-verification); done`;
  await writeFile(events, event(shell(polling)));
  assert.equal((await client.listChildSessions("main-parent", "run-current"))[0].status, "running");
  await writeFile(events, event(shell(verification)));
  const pending = await client.listChildSessions("main-parent", "run-current");
  assert.equal(pending[0].status, "unknown");
  assert.equal(pending[0].runId, undefined);
  await writeFile(events, event(shell(work.replace("run-old", "run-missing"))));
  assert.equal((await client.listChildSessions("main-parent", "run-current"))[0].status, "unknown");

  for (const command of [
    "other-cli status --agent work-hidden",
    "python3 unrelated/exec.py status --agent work-hidden",
    "echo python3 skills/agent/scripts/exec.py status --agent work-hidden",
    "echo 'python3 skills/agent/scripts/exec.py status --agent work-hidden'",
    "python3 skills/agent/scripts/exec.py submit --agent main-older --message 'python3 skills/agent/scripts/exec.py status --agent work-hidden'",
    "python3 skills/agent/scripts/exec.py status --agent work-hidden --project-root /different-project",
    "python3 skills/agent/scripts/exec.py status --agent 'work-hidden/../../outside'",
    "python3 skills/agent/scripts/exec.py status --agent work-hidden --run-id ../run-old",
    "python3 skills/agent/scripts/exec.py list; other-cli --agent work-hidden"
  ]) {
    await writeFile(events, event(shell(command)));
    assert.deepEqual(await client.listChildSessions("main-parent", "run-current"), [], command);
  }
});

test("Goal status lookup cannot block reconnect or leave idle chat running", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const active of [false, true]) {
    let releaseGoal, releaseUpdates, finish;
    const goalGate = new Promise(resolve => { releaseGoal = resolve; });
    const updateGate = new Promise(resolve => { releaseUpdates = resolve; });
    const done = new Promise(resolve => { finish = resolve; });
    const running = [], errors = [], finals = [];
    let discovered = 0;
    const controller = new ChatSessionController({
      async goal() { return goalGate; },
      async activeRun() { discovered++; return active ? { agentId: "main-race", runId: "run-race" } : undefined; },
      async updates() { await updateGate; return { cursor: 0, updates: [] }; },
      async status() { return { status: "completed" }; },
      async result() { return { status: "completed", text: "Recovered" }; }
    }, {
      onBound() {}, onRunningChanged(value) { running.push(value); if (!value) finish(); },
      onAssistantText(text) { finals.push(text); }, onProgress() {}, onUsage() {}, onActivity() {},
      onError(error) { errors.push(error); }
    }, "main-race", { pollIntervalMs: 1 });
    const lookup = controller.controlGoal("get");
    assert.equal(controller.running, false);
    assert.equal(await controller.reconnect(), active);
    assert.equal(discovered, 1);
    releaseUpdates();
    await done;
    assert.equal(controller.running, false);
    for (let i = 0; i < 3; i++) await controller.cancel();
    assert.deepEqual(errors, []);
    assert.equal(running.at(-1), false);
    assert.deepEqual(finals, active ? ["Recovered"] : []);
    releaseGoal({ goal: null });
    await lookup;
    assert.equal(controller.running, false);
  }
});

test("send rejected during Goal lookup restores the optimistic composer state", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = [];
  const controller = new ChatSessionController({ async goal() { return gate; } }, {
    onBound() {}, onRunningChanged(value) { running.push(value); }, onAssistantText() {},
    onProgress() {}, onActivity() {}, onError() {}
  }, "main-race");
  const lookup = controller.controlGoal("get");
  await controller.send("hello", [], {});
  assert.deepEqual(running, [false]);
  release({ goal: null });
  await lookup;
});

test("internal result reads stay hidden while child, mixed and failed reads remain visible", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-own-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runRoot = join(agentsRoot(root), 'main-test/runs/run-fake');
  await mkdir(runRoot, { recursive: true });
  const own = join(runRoot, 'result.md');
  const child = join(agentsRoot(root), 'work-test/runs/run-child/result.md');
  const cases = [
    { id: 'own', command: `cat '${own}'`, exit_code: 0 },
    { id: 'child', command: `cat '${child}'`, exit_code: 0 },
    { id: 'mixed', command: `cat '${own}' README.md`, exit_code: 0 },
    { id: 'failed', command: `cat '${own}'`, exit_code: 1 }
  ];
  await writeFile(join(runRoot, 'events.jsonl'), cases.map(item => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', ...item } })).join('\n') + '\n');
  const client = new AgentFactoryClient(new URL('../fixtures/fake-exec.py', import.meta.url).pathname, root);
  const { updates } = await client.updates('main-test', 'run-fake', 0);
  assert.deepEqual(updates.filter(update => update.kind === 'activity').map(update => update.id), ['child', 'mixed', 'failed']);
});

test("task mode protocol rejects unknown routes and preserves valid snapshots", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  for (const taskMode of ["direct", "work", "plan-work", "work-verification", "plan-work-verification"]) {
    const message = { type: "chat.send", id: "message", text: "request", attachments: [], execution: { taskMode, fast: false, goal: false } };
    assert.equal(parseClientMessage(message).execution.taskMode, taskMode);
    assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, taskMode: "plan-agent" } }), undefined);
  }
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  assert.equal(restoreChatState({}).taskMode, "direct");
  assert.equal(restoreChatState({ taskMode: "plan-work" }).taskMode, "direct");
  assert.equal(restoreChatState({ taskMode: "direct", workLoopMode: true }).taskMode, "direct");
  assert.equal(restoreChatState({ taskMode: "invalid" }).taskMode, "direct");
});

test("mode capability negotiation rejects old runtimes and forwards supported flags", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("unused", "/project");
  client.capabilities = async () => ({ submit: {}, send: { taskModes: ["direct", "work"] } });
  await assert.rejects(client.checkedExecution("submit", { taskMode: "work" }), /Update/);
  await assert.rejects(client.checkedExecution("send", { taskMode: "plan-work-verification" }), /Update/);
  await assert.rejects(client.checkedExecution("send", { taskMode: "plan-work" }), /Update/);
  assert.deepEqual(await client.checkedExecution("send", { taskMode: "direct" }), ["--task-mode", "direct"]);
  client.capabilities = async () => ({ submit: { taskModes: ["plan-work"] }, send: { taskModes: ["plan-work"] } });
  for (const operation of ["submit", "send"]) {
    assert.deepEqual(await client.checkedExecution(operation, { taskMode: "plan-work" }), ["--task-mode", "plan-work"]);
  }
});


test("workflow protocol and preferences preserve valid independent selections", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  for (const businessMode of ["normal", "interview", "planning", "design"]) {
    const execution = { taskMode: "work", businessMode, fast: false, goal: false };
    const sent = parseClientMessage({ type: "chat.send", id: "message", text: "original", attachments: [], execution });
    assert.equal(sent.execution.businessMode, businessMode);
    assert.equal(sent.execution.taskMode, "work");
    assert.equal(sent.text, "original");
    const settings = parseClientMessage({ type: "composer.settings", businessMode, fastMode: false, goalMode: false });
    assert.equal(restoreChatState(settings).businessMode, "normal");
  }
  assert.equal(restoreChatState({}).businessMode, "normal");
  assert.equal(restoreChatState({}, { businessMode: "planning" }).businessMode, "normal");
  assert.equal(restoreChatState({ businessMode: "invalid" }).businessMode, "normal");
  assert.equal(parseClientMessage({ type: "composer.settings", businessMode: "invalid", fastMode: false, goalMode: false }), undefined);
  assert.equal(parseClientMessage({ type: "chat.send", id: "x", text: "", attachments: [], execution: { businessMode: "invalid", fast: false, goal: false } }), undefined);
  assert.equal(parseClientMessage({ type: "chat.send", id: "x", text: "", attachments: [], execution: { taskMode: "verification", fast: false, goal: false } }).execution.taskMode, "verification");
});

test("interview question protocol accepts complete payloads and rejects ambiguous choices", async () => {
  const { parseInterviewQuestion } = await importTypeScript("src/protocol/validator.ts");
  const question = { id: "interview-2-of-3", current: 2, total: 3, text: "Choose a route", yesNo: false,
    options: [{ value: "safe", label: "Safe", pros: "Lower risk", cons: "Slower" },
      { value: "fast", label: "Fast", pros: "Quicker", cons: "Higher risk" }], recommendedValue: "safe" };
  assert.deepEqual(parseInterviewQuestion(question), question);
  assert.equal(parseInterviewQuestion({ ...question, options: [question.options[0]] }), undefined);
  assert.equal(parseInterviewQuestion({ ...question, options: [question.options[0], { ...question.options[1], value: "safe" }] }), undefined);
  assert.equal(parseInterviewQuestion({ ...question, recommendedValue: "missing" }), undefined);
});


test("Verification action requires the managed runtime route and is not restored", async () => {
  const { taskExecution } = await importTypeScript("src/modules/chat/task-selection.ts");
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  const { TASK_MODES, AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.equal(restoreChatState({ taskMode: "verification" }).taskMode, "direct");
  assert.equal(TASK_MODES.includes("verification"), true);
  assert.deepEqual(taskExecution("verification"), { taskMode: "verification", inspectionOnly: false });
  assert.deepEqual(taskExecution("work"), { taskMode: "work", inspectionOnly: false });
  const client = new AgentFactoryClient("unused", "/project");
  client.capabilities = async () => ({ submit: { taskModes: ["verification"] }, send: { taskModes: ["work"] } });
  assert.deepEqual(await client.checkedExecution("submit", taskExecution("verification")), ["--task-mode", "verification"]);
  await assert.rejects(client.checkedExecution("send", taskExecution("verification")), /Update/);
});

test("cancellation summaries are shown once on restore and live delivery without hiding partial results", async () => {
  const script = await readChatSource();
  const helpers = script.slice(script.indexOf("  function isDuplicateCancellation("), script.indexOf("  function appendNotice("));
  const summary = "The run was cancelled.";
  const notice = { type: "notice", level: "error", text: summary };
  const final = { type: "assistant", phase: "final", text: summary, runId: "cancelled-one" };
  const partial = { ...final, text: "Preserved partial result (completion unconfirmed):\nChanges made." };
  const context = { events: [notice, final, partial] };
  runInNewContext(helpers + "\nresult = collapseCancellationNotices(events);", context);
  assert.deepEqual(Array.from(context.result), [notice, partial]);
  for (const events of [
    [notice, { ...final, phase: "commentary" }],
    [notice, { type: "user", text: "next request" }, final],
    [{ ...notice, runId: "other-run" }, final],
    [{ ...notice, text: "Different error" }, final]
  ]) {
    context.events = events;
    runInNewContext("result = collapseCancellationNotices(events);", context);
    assert.deepEqual(Array.from(context.result), events);
  }
  const handler = script.slice(script.indexOf('      case "chat.assistant":'), script.indexOf('      case "run.state":'));
  const previewHelpers = script.slice(script.indexOf("  // A complete message supersedes"), script.indexOf("  function upsertActivity("));
  Object.assign(context, {
    state: { timeline: [{ ...notice, text: summary + "\nprovider: diagnostic" }] },
    message: { ...final, type: "chat.assistant" },
    createId: () => "new", renderTimeline() {}, scheduleTimelineRender() {}, renderRunStatus() {}, renderWorkLoopPanel() {},
    extractTaskFlows: () => ({ flows: [] }), persist() {}
  });
  runInNewContext(previewHelpers + 'switch (message.type) {\n' + handler + '\n}', context);
  assert.equal(context.state.timeline.length, 1);
  context.message = { ...partial, type: "chat.assistant" };
  runInNewContext('switch (message.type) {\n' + handler + '\n}', context);
  assert.equal(context.state.timeline.length, 2);
  assert.equal(context.state.timeline[1].text, partial.text);
});

test("cancelled controller results emit one notice and preserve only meaningful partial text", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  for (const resultText of ["", "The run was cancelled.", "Saved partial work"]) {
    const texts = [], notices = [];
    const runtime = {
      async submit(agentId) { return { agentId, runId: "cancelled-run" }; },
      async updates() { return { cursor: 0, updates: [] }; },
      async status() { return { status: "cancelled" }; },
      async result() { return { status: "cancelled", text: resultText }; }
    };
    const controller = new ChatSessionController(runtime, {
      onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {},
      onAssistantText(text) { texts.push(text); }, onError(text, level) { notices.push([text, level]); }
    }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
    await controller.send("task", [], {});
    assert.deepEqual(notices, [["The run was cancelled.", "cancelled"]]);
    assert.equal(texts.length, resultText === "Saved partial work" ? 1 : 0);
    if (texts.length) assert.match(texts[0], /Saved partial work/);
  }
});

test("cancelled results with diagnostics retain error severity", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const notices = [];
  const runtime = {
    async submit(agentId) { return { agentId, runId: "cancelled-diagnostic" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: "cancelled" }; },
    async result() { return { status: "cancelled", text: "", error: { code: "provider_error", message: "Provider stopped unexpectedly" } }; }
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {}, onAssistantText() {},
    onError(text, level) { notices.push([text, level]); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await controller.send("task", [], {});
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], "error");
  assert.match(notices[0][0], /Provider stopped unexpectedly/);
});

test("runtime result carries only explicit decision metadata for pending decisions", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused", "/unused");
  client.readManagedResult = async () => "Which target?";
  for (const status of ["completed", "needs-human-decision"]) {
    for (const decisionKind of [undefined, "approval", "clarification", "unknown"]) {
      client.command = async () => ({ run: { status, resultPath: "/unused/result.md", decisionKind } });
      const result = await client.result("main-test", "run-test");
      assert.equal(result.decisionKind, status === "needs-human-decision" && ["approval", "clarification"].includes(decisionKind) ? decisionKind : undefined);
    }
  }
});

test('workflow monitor reconciles only owned loops with the captured parent binding', async () => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-monitor-'));
  try {
    const directory = agentsRoot(root);
    const parent = join(directory, 'main-owner', 'runs', 'run-parent', 'state.json');
    await mkdir(dirname(parent), { recursive: true });
    const policy = { schemaVersion: 1, sandboxPolicy: { type: 'workspace-write', writable_roots: [root] }, approvalPolicy: 'never' };
    await writeFile(parent, JSON.stringify({ executionPolicy: policy }));
    const loopRoot = join(directory, 'work-one', 'loops', 'loop-one');
    const operations = join(root, 'loop-operations.txt');
    await mkdir(loopRoot, { recursive: true });
    await writeFile(join(loopRoot, 'state.json'), JSON.stringify({ workflow: { id: 'flow' }, status: 'active', parentStatePath: parent }));
    await writeFile(join(root, 'loop.py'), `import json, os, pathlib, sys\npathlib.Path(${JSON.stringify(operations)}).open('a').write(sys.argv[1] + '\\n')\nprint(json.dumps({'kind':'work-verification-loop','loopId':'loop-one','status':'active','parent':os.environ.get('AGENT_FACTORY_PARENT_STATE'),'policy':json.loads(os.environ['AGENT_FACTORY_EXECUTION_POLICY']),'operation':sys.argv[1]}))\n`);
    const client = new AgentFactoryClient(join(root, 'exec.py'), root);
    client.location = async () => ({ home: runtimeTestHome, projectId: 'project-test', agentsRoot: directory });
    const children = [{ agentId: 'work-one', role: 'work', status: 'running', runId: 'run-one' }];
    await client.advanceWorkflows('main-owner', children, false);
    await client.advanceWorkflows('main-owner', children, false);
    assert.deepEqual((await readFile(operations, 'utf8')).trim().split('\n'), ['status']);
    [...client.workflowSnapshots.values()][0].observedAt -= 1001;
    await client.advanceWorkflows('main-owner', children, false);
    assert.deepEqual((await readFile(operations, 'utf8')).trim().split('\n'), ['status', 'status']);
    await writeFile(parent, JSON.stringify({ executionPolicy: policy, changed: true }));
    await client.advanceWorkflows('main-owner', children, false);
    assert.deepEqual((await readFile(operations, 'utf8')).trim().split('\n'), ['status', 'status', 'status']);
    await writeFile(operations, '');
    const snapshots = await client.advanceWorkflows('main-owner', children);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].parent, parent);
    assert.deepEqual(snapshots[0].policy, policy);
    assert.equal(snapshots[0].operation, 'status');
    assert.deepEqual(await client.advanceWorkflows('main-other', children), []);
    await writeFile(join(loopRoot, 'state.json'), JSON.stringify({ workflow: { id: 'flow' }, status: 'completed', parentStatePath: parent }));
    const completed = (await client.advanceWorkflows('main-owner', children))[0];
    assert.equal(completed.operation, 'status');
    assert.deepEqual(completed.policy, policy);
    assert.equal((await client.advanceWorkflows('main-owner', children))[0].operation, 'status');
    assert.deepEqual((await readFile(operations, 'utf8')).trim().split('\n'), ['status', 'status'],
      'An unchanged completed loop must reuse its observed snapshot without another command');
    await assert.rejects(client.closeWorkflow('main-other', 'work-one', 'loop-one'), /does not belong/);
    assert.deepEqual((await readFile(operations, 'utf8')).trim().split('\n'), ['status', 'status']);
    const closed = await client.closeWorkflow('main-owner', 'work-one', 'loop-one');
    assert.equal(closed.operation, 'close');
    assert.equal(closed.parent, parent);
    assert.deepEqual(closed.policy, policy);
    await writeFile(parent, '{}');
    await assert.rejects(client.advanceWorkflows('main-owner', children), /workflow parent execution policy/);
    await writeFile(parent, JSON.stringify({ executionPolicy: [] }));
    await assert.rejects(client.advanceWorkflows('main-owner', children), /workflow parent execution policy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workflow monitor preserves six task bindings across same-worker runs and reconnects', async t => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-six-task-monitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root);
  const parent = join(directory, 'main-six', 'runs', 'run-parent', 'state.json');
  await mkdir(dirname(parent), { recursive: true });
  await writeFile(parent, JSON.stringify({ executionPolicy: { schemaVersion: 1,
    sandboxPolicy: { type: 'danger-full-access', network_access: true }, approvalPolicy: 'never' } }));
  const path = join(directory, 'shared-worker', 'loops', 'loop-six', 'state.json');
  await mkdir(dirname(path), { recursive: true });
  const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index + 1}`, title: `Task ${index + 1}`,
    description: `Request ${index + 1}`, completionCriteria: `Criterion ${index + 1}`, workAgentId: 'shared-worker',
    workStatus: index === 0 ? 'completed' : index === 1 ? 'running' : 'pending',
    ...(index < 2 ? { workRunId: `run-${index + 1}` } : {}) }));
  const state = { kind: 'work-verification-loop', loopId: 'loop-six', status: 'active', taskMode: 'work',
    workAgentId: 'shared-worker', parentStatePath: parent, workflow: { id: 'six', title: 'Six tasks', index: 1, tasks } };
  await writeFile(path, JSON.stringify(state));
  // The fake command returns the exact persisted runtime snapshot and records its operation.
  await writeFile(join(root, 'loop.py'), `import json, pathlib, sys
state = json.loads(pathlib.Path(${JSON.stringify(path)}).read_text())
state['operation'] = sys.argv[1]
print(json.dumps(state))
`);
  const connect = () => {
    const client = new AgentFactoryClient(join(root, 'exec.py'), root);
    client.location = async () => ({ home: runtimeTestHome, projectId: 'project-test', agentsRoot: directory });
    return client;
  };
  const children = [1, 2].map(index => ({ agentId: 'shared-worker', role: 'work', runId: `run-${index}`,
    status: index === 1 ? 'completed' : 'running' }));
  const first = await connect().advanceWorkflows('main-six', children);
  assert.equal(first.length, 1, 'Same worker referenced by two runs must not duplicate its loop');
  assert.deepEqual(first[0].workflow.tasks, tasks);
  assert.equal(first[0].operation, 'status');
  assert.deepEqual(await connect().advanceWorkflows('other-main', children), []);
  state.status = 'runtime-error';
  tasks[1].workStatus = 'failed';
  await writeFile(path, JSON.stringify(state));
  const restored = await connect().advanceWorkflows('main-six', children);
  assert.equal(restored[0].operation, 'status', 'Reconnect must not redispatch a stopped loop');
  assert.deepEqual(restored[0].workflow.tasks.map(task => task.workStatus), ['completed', 'failed', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(restored[0].workflow.tasks.map(task => task.workRunId), ['run-1', 'run-2', undefined, undefined, undefined, undefined]);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(state), 'Host must not rewrite runtime state');
});

test("runtime launch forwards the current CLI filename for new and existing sessions", async (t) => {
  const output = await build({
    stdin: {
      contents: 'export { AgentFactoryClient } from "./src/infrastructure/agent-factory/agent-client"; export { configureCodexCli } from "./src/infrastructure/agent-factory/process-environment";',
      resolveDir: new URL("../../", import.meta.url).pathname,
      loader: "ts"
    },
    bundle: true, format: "esm", platform: "node", target: "node18", write: false
  });
  const { AgentFactoryClient, configureCodexCli } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  const root = await mkdtemp(join(tmpdir(), "af-custom-cli-"));
  t.after(() => { configureCodexCli(undefined); return rm(root, { recursive: true, force: true }); });
  const script = join(root, "exec.py");
  await writeFile(script, 'import json, os, sys\nprint(json.dumps({"args": sys.argv[1:], "path": os.environ["PATH"]}))\n');
  const executable = join(root, "custom-codex");
  configureCodexCli({ executable, source: "configured", binDirectory: root });
  const client = new AgentFactoryClient(script, root);
  for (const command of ["submit", "capabilities"]) {
    const result = await client.runRuntimeProcess([command], 5000, 65536);
    assert.equal(result.exitCode, 0);
    const received = JSON.parse(result.stdout);
    assert.deepEqual(received.args, [command, "--codex", executable]);
    assert.equal(received.path.split(":")[0], root);
  }
  const sent = await client.runRuntimeProcess(["send"], 5000, 65536);
  assert.deepEqual(JSON.parse(sent.stdout).args, ["send", "--codex", executable]);
});


test("incremental logs retain split UTF-8 tails and use bounded per-run buffers", async (t) => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-incremental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const path = join(agentsRoot(root), "main-test/runs/run-log/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const first = JSON.stringify({ type: "turn.started" }) + "\n";
  await writeFile(path, first.repeat(2000));
  const initial = await client.updates("main-test", "run-log", 0);
  const next = Buffer.from(JSON.stringify({ type: "native.commentary", text: "한글 완료" }) + "\n");
  const split = next.indexOf(Buffer.from("한")) + 1;
  await appendFile(path, next.subarray(0, split));
  const allocations = [];
  const allocate = Buffer.alloc;
  Buffer.alloc = function (size, ...rest) { allocations.push(size); return allocate(size, ...rest); };
  try {
    assert.equal((await client.updates("main-test", "run-log", initial.cursor)).cursor, initial.cursor);
    await appendFile(path, next.subarray(split));
    const result = await client.updates("main-test", "run-log", initial.cursor);
    assert.equal(result.cursor, 2001);
    assert.ok(result.updates.some(update => update.text === "한글 완료"));
  } finally { Buffer.alloc = allocate; }
  assert.ok(Math.max(...allocations) < 4096, "append must not allocate or reread the full log");
  for (let i = 0; i < 18; i++) {
    const other = join(agentsRoot(root), `main-test/runs/run-${i}/events.jsonl`);
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, first);
    await client.updates("main-test", `run-${i}`, 0);
  }
  assert.equal(client.eventSnapshots.size, 16);
  await writeFile(path, first);
  assert.equal((await client.updates("main-test", "run-log", 0)).cursor, 1);
});


test("cached run discovery observes new runs and changed state", async (t) => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-run-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  const runs = join(agentsRoot(root), "main-test/runs");
  await mkdir(join(runs, "run-a"), { recursive: true });
  await writeFile(join(runs, "run-a/state.json"), JSON.stringify({ status: "running" }));
  assert.equal((await client.latestRunInfo("main-test")).runId, "run-a");
  assert.equal((await client.latestRunInfo("main-test")).status, "running");
  await writeFile(join(runs, "run-a/state.json"), JSON.stringify({ status: "completed" }));
  assert.equal((await client.latestRunInfo("main-test")).status, "completed");
  await mkdir(join(runs, "run-z"));
  await writeFile(join(runs, "run-z/state.json"), JSON.stringify({ status: "accepted" }));
  assert.equal((await client.latestRunInfo("main-test")).runId, "run-z");
  assert.equal((await client.latestRunInfo("main-test", "run-a")).status, "completed");
  await rm(join(runs, "run-z"), { recursive: true });
  assert.equal((await client.latestRunInfo("main-test")).runId, "run-a");
});

 test("workflow close protocol requires bounded identities", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const request = { type: "workflow.close", workAgentId: "worker", loopId: "loop-one" };
  assert.deepEqual(parseClientMessage(request), request);
  assert.equal(parseClientMessage({ ...request, loopId: "../other" }), undefined);
  assert.equal(parseClientMessage({ ...request, workAgentId: undefined }), undefined);
});

test("status snapshots avoid process starts until file changes or liveness expires", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-status-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(agentsRoot(root), "main-status", "runs", "run-one", "state.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ status: "running" }));
  const client = new AgentFactoryClient("/unused/exec.py", root);
  client.location = async () => ({ agentsRoot: agentsRoot(root) });
  let calls = 0;
  client.command = async () => { calls++; return { run: JSON.parse(await readFile(path, "utf8")) }; };
  assert.equal((await client.status("main-status", "run-one")).status, "running");
  await client.status("main-status", "run-one");
  assert.equal(calls, 1);
  await writeFile(path, JSON.stringify({ status: "completed" }));
  assert.equal((await client.status("main-status", "run-one")).status, "completed");
  assert.equal(calls, 2);
  const snapshot = [...client.statusSnapshots.values()][0]; snapshot.observedAt -= 1001;
  await client.status("main-status", "run-one");
  assert.equal(calls, 3);
});

test("structured child references work without parent logs or a project-wide list", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-child-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root);
  const parent = join(directory, "main-index", "runs", "run-parent");
  const child = join(directory, "work-index", "runs", "run-child");
  await mkdir(join(parent, "children"), { recursive: true });
  await mkdir(child, { recursive: true });
  await writeFile(join(parent, "state.json"), JSON.stringify({ taskMode: "work" }));
  await writeFile(join(parent, "children/work-index.json"), JSON.stringify({ parentAgentId: "main-index", parentRunId: "run-parent", agentId: "work-index", runId: "run-child" }));
  await writeFile(join(directory, "work-index/session.json"), JSON.stringify({ agentId: "work-index", role: "work" }));
  await writeFile(join(child, "state.json"), JSON.stringify({ agentId: "work-index", runId: "run-child", status: "completed", parentAgentId: "main-index", parentRunId: "run-parent" }));
  const client = new AgentFactoryClient("/unused", root);
  client.location = async () => ({ agentsRoot: directory });
  client.listAgentsDocument = async () => { throw new Error("Unexpected global scan"); };
  const children = await client.listChildSessions("main-index");
  assert.equal(children.length, 1);
  assert.equal(children[0].runId, "run-child");
  assert.equal(children[0].taskMode, "work");
});


test("cached legacy directory discovers a new child index and rejects later symlink replacement", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-index-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), parent = join(directory, "main-index", "runs", "run-parent");
  await mkdir(parent, { recursive: true });
  const client = new AgentFactoryClient("/unused", root);
  client.location = async () => ({ agentsRoot: directory });
  assert.equal((await client.discoverChildAgents("main-index")).size, 0);
  await mkdir(join(parent, "children"));
  await writeFile(join(parent, "children/work-one.json"), JSON.stringify({ parentAgentId: "main-index", parentRunId: "run-parent", agentId: "work-one", runId: "run-child" }));
  assert.equal((await client.discoverChildAgents("main-index")).get("work-one").runId, "run-child");
  assert.equal((await client.discoverChildAgents("main-index", "run-missing")).size, 0);
  await rm(join(parent, "children"), { recursive: true });
  const outside = join(root, "outside"); await mkdir(outside);
  await symlink(outside, join(parent, "children"), "dir");
  await assert.rejects(client.discoverChildAgents("main-index"), /[Uu]nsafe/);
});


test("workflow discovery invalidates missing loops on creation, deletion and symlink replacement", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-loop-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), agent = join(directory, "work-one");
  const parent = join(directory, "main-owner", "runs", "run-parent", "state.json");
  await mkdir(agent, { recursive: true }); await mkdir(dirname(parent), { recursive: true });
  await writeFile(parent, JSON.stringify({ executionPolicy: { schemaVersion: 1 } }));
  await writeFile(join(root, "loop.py"), "import json\nprint(json.dumps({'kind':'work-verification-loop','loopId':'loop-one','status':'completed'}))\n");
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: runtimeTestHome, projectId: "project-test", agentsRoot: directory });
  const children = [{ agentId: "work-one", role: "work" }];
  const refresh = () => client.refreshWorkflows("main-owner", children, false);
  assert.deepEqual(await refresh(), []);
  assert.deepEqual(await refresh(), []);
  const loop = join(agent, "loops", "loop-one");
  await mkdir(loop, { recursive: true });
  await writeFile(join(loop, "state.json"), JSON.stringify({ workflow: { id: "one" }, status: "completed", parentStatePath: parent }));
  assert.equal((await refresh())[0].loopId, "loop-one");
  await rm(join(agent, "loops"), { recursive: true });
  assert.deepEqual(await refresh(), []);
  await mkdir(loop, { recursive: true });
  await writeFile(join(loop, "state.json"), JSON.stringify({ workflow: { id: "one" }, status: "completed", parentStatePath: parent }));
  assert.equal((await refresh()).length, 1);
  await rm(join(agent, "loops"), { recursive: true });
  const outside = join(root, "outside"); await mkdir(outside);
  await symlink(outside, join(agent, "loops"), "dir");
  await assert.rejects(refresh(), /[Uu]nsafe/);
});

test("missing legacy event logs are rediscovered on creation and reject symlink replacement", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-event-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), parent = join(directory, "main-index", "runs", "run-parent");
  await mkdir(parent, { recursive: true });
  const client = new AgentFactoryClient("/unused", root);
  client.location = async () => ({ agentsRoot: directory });
  assert.equal((await client.discoverChildAgents("main-index")).size, 0);
  const log = join(parent, "events.jsonl");
  await writeFile(log, '{}\n');
  await client.discoverChildAgents("main-index");
  assert.ok(client.childEventSnapshots.has(log), "new log must be read despite cached missing state");
  await rm(log);
  await client.discoverChildAgents("main-index");
  await symlink(join(root, "outside"), log);
  await assert.rejects(client.discoverChildAgents("main-index"), /[Uu]nsafe/);
});

test('observed relationship cache rereads only changed runs and survives watcher loss', async t => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-observed-relations-'));
  const directory = agentsRoot(root), client = new AgentFactoryClient('/unused', root);
  client.location = async () => ({ agentsRoot: directory });
  t.after(async () => { client.observedChildRuns.dispose(); await rm(root, { recursive: true, force: true }); });
  const files = [];
  for (let i = 0; i < 3; i++) {
    const path = join(directory, 'main-one', 'runs', 'run-' + i, 'children', 'child.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ parentAgentId: 'main-one', parentRunId: 'run-' + i, agentId: 'work-' + i, runId: 'child-before' }));
    files.push(path);
  }
  assert.equal((await client.discoverChildAgents('main-one')).size, 3);
  const original = client.cachedRunState.bind(client); let reads = [];
  client.cachedRunState = async path => { reads.push(path); return original(path); };
  await client.discoverChildAgents('main-one'); assert.equal(reads.length, 0);
  await writeFile(files[1], JSON.stringify({ parentAgentId: 'main-one', parentRunId: 'run-1', agentId: 'work-1', runId: 'child-after' }));
  const deadline = Date.now() + 2000;
  let result;
  do { result = await client.discoverChildAgents('main-one'); if (result.get('work-1')?.runId === 'child-after') break; await new Promise(r => setTimeout(r, 5)); } while (Date.now() < deadline);
  assert.equal(result.get('work-1').runId, 'child-after');
  assert.deepEqual([...new Set(reads)], [files[1]]);
  client.observedChildRuns.dispose(); reads = [];
  assert.equal((await client.discoverChildAgents('main-one')).size, 3);
  assert.equal(reads.length, 3, 'lost watchers must fall back to fresh inspection');
});

test('child run status stays fresh and rejects invalid state files through the shared reader', async t => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-child-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), run = join(directory, 'work-one', 'runs', 'run-one');
  await mkdir(run, { recursive: true });
  const path = join(run, 'state.json');
  const client = new AgentFactoryClient('/unused', root);
  client.location = async () => ({ agentsRoot: directory });
  const read = () => client.latestRunInfo('work-one', 'run-one');
  await writeFile(path, JSON.stringify({ status: 'running' }));
  assert.equal((await read()).status, 'running');
  await writeFile(path, JSON.stringify({ status: 'completed' }));
  assert.equal((await read()).status, 'completed');
  const taskBinding = { taskId: 'task-long', description: '한글😀'.repeat(100000) };
  await writeFile(path, JSON.stringify({ status: 'completed', taskBinding }));
  const large = await read();
  assert.equal(large.status, 'completed');
  assert.deepEqual(large.taskBinding, taskBinding);
  await writeFile(path, '{broken');
  assert.equal((await read()).status, 'unknown');
  await rm(path);
  await mkdir(path);
  assert.equal((await read()).status, 'unknown');
  await rm(path, { recursive: true });
  await writeFile(join(root, 'outside.json'), JSON.stringify({ status: 'completed' }));
  await symlink(join(root, 'outside.json'), path);
  await assert.rejects(read(), /[Uu]nsafe/);
});

test('state snapshots bound both record count and source bytes across replacement and eviction', async t => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-state-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient('/unused', root);
  const verifyBudget = () => {
    assert.ok(client.runStateSnapshots.size <= 2048);
    assert.ok(client.runStateSnapshotBytes <= 8 * 1024 * 1024);
    assert.equal(client.runStateSnapshotBytes, [...client.runStateSnapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0));
  };
  for (let i = 0; i < 2050; i++) {
    const path = join(root, `state-${i}.json`);
    await writeFile(path, JSON.stringify({ status: 'running', index: i }));
    assert.equal((await client.cachedRunState(path)).index, i);
  }
  verifyBudget();
  assert.equal(client.runStateSnapshots.size, 2048);
  assert.equal(client.runStateSnapshots.has(join(root, 'state-0.json')), false);
  for (let i = 0; i < 40; i++) {
    const path = join(root, `large-${i}.json`);
    await writeFile(path, JSON.stringify({ status: 'running', padding: '가'.repeat(80000) }));
    await client.cachedRunState(path);
    verifyBudget();
  }
  const path = join(root, 'large-39.json');
  await writeFile(path, JSON.stringify({ status: 'completed' }));
  assert.equal((await client.cachedRunState(path)).status, 'completed');
  verifyBudget();
  await writeFile(path, 'x'.repeat(256 * 1024 + 1));
  assert.equal(await client.cachedRunState(path), undefined);
  assert.equal(client.runStateSnapshots.has(path), false);
  verifyBudget();
});


test('task chat resolves exact historical models, profiles and missing values without starting runs', async t => {
  const { AgentFactoryClient } = await importTypeScript('src/infrastructure/agent-factory/agent-client.ts');
  const { restoreChatState } = await importTypeScript('src/modules/chat/chat-state.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-chat-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root);
  const client = new AgentFactoryClient('/unused', root);
  client.location = async () => ({ agentsRoot: directory });
  client.listAgentsDocument = async () => ({ agents: [{ agentId: 'work-one', role: 'work', model: 'current-profile' }, { agentId: 'verify-one', role: 'verification' }] });
  for (const [agentId, runId, model, workProfile] of [['work-one', 'run-old', 'captured-old', 'workLight'], ['work-one', 'run-new', 'captured-new', 'work'], ['verify-one', 'run-v', undefined, undefined]]) {
    const path = join(directory, agentId, 'runs', runId, 'state.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ status: 'completed', parentAgentId: 'main-owner', workProfile, executionOptions: { model } }));
    const captured = await client.childRun('main-owner', agentId, runId);
    assert.equal(captured.runId, runId); assert.equal(captured.model, model); assert.equal(captured.workProfile, workProfile);
    const snapshot = { parentAgentId: 'main-owner', agentId, runId, ...(model ? { model } : {}), ...(workProfile ? { workProfile } : {}) };
    const restored = restoreChatState({ agentId, role: captured.role, capturedRun: snapshot }, { model: 'main-setting' });
    assert.deepEqual(restored.capturedRun, snapshot);
    assert.equal(restored.model, 'main-setting', 'Next-send preferences remain independent');
    assert.equal(restoreChatState({ agentId: 'another-agent', capturedRun: snapshot }).capturedRun, undefined);
  }
  assert.equal(await client.childRun('other-main', 'work-one', 'run-old'), undefined);
  assert.equal(await client.childRun('main-owner', 'work-one', 'missing-run'), undefined);
  assert.equal(await client.childRun('main-owner', 'work-one', '../run'), undefined);
});

test("conversation reset and first send refresh the Main session provider lock", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/unused/project");
  const flags = { model: true, reasoning: false, fast: false, goal: false };
  let sessionProvider = "claude";
  client.command = async ([command]) => {
    if (command === "reset-conversation") {
      sessionProvider = undefined;
      return { kind: "conversation-reset", agentId: "main-test", conversationId: "conversation-2", startedAt: "2026-10-05T00:00:00Z", historyRetained: true };
    }
    return { kind: "execution-capabilities", schemaVersion: "0.1.0", submit: flags, send: { ...flags, ...(sessionProvider ? { sessionProvider } : {}) } };
  };
  client.inputCommand = async () => {
    sessionProvider = "codex";
    return { document: { kind: "ack", status: "accepted", agentId: "main-test", runId: "run-1" } };
  };
  assert.equal((await client.capabilities("main-test")).send.sessionProvider, "claude");
  assert.equal((await client.capabilities("work-test")).send.sessionProvider, "claude");
  await client.resetConversation("main-test");
  assert.equal((await client.capabilities("main-test")).send.sessionProvider, undefined);
  assert.equal((await client.capabilities("work-test")).send.sessionProvider, "claude");
  await client.send("main-test", "hello", { model: "gpt-6-astra" });
  assert.equal((await client.capabilities("main-test")).send.sessionProvider, "codex");
});

test("workflow discovery skips a loop whose state is not published yet and reads state through the managed checks", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-loop-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), loops = join(directory, "work-one", "loops");
  const parent = join(directory, "main-owner", "runs", "run-parent", "state.json");
  await mkdir(join(loops, "loop-new"), { recursive: true }); await mkdir(join(loops, "loop-one"), { recursive: true });
  await mkdir(dirname(parent), { recursive: true });
  await writeFile(parent, JSON.stringify({ executionPolicy: { schemaVersion: 1 } }));
  await writeFile(join(loops, "loop-one", "state.json"), JSON.stringify({ workflow: { id: "one" }, status: "completed", parentStatePath: parent }));
  await writeFile(join(root, "loop.py"), "import json\nprint(json.dumps({'kind':'work-verification-loop','loopId':'loop-one','status':'completed'}))\n");
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: runtimeTestHome, projectId: "project-test", agentsRoot: directory });
  const refresh = () => client.refreshWorkflows("main-owner", [{ agentId: "work-one", role: "work" }], false);
  assert.deepEqual((await refresh()).map(snapshot => snapshot.loopId), ["loop-one"], "a loop without state.json does not fail the list");
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ workflow: { id: "new" }, status: "completed", parentStatePath: parent }));
  await symlink(outside, join(loops, "loop-new", "state.json"));
  await assert.rejects(refresh(), /[Uu]nsafe/);
});

test("loop command failures report the runtime error before parsing its output", async t => {
  const { AgentFactoryClient, readLoopOutput } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.throws(() => readLoopOutput({ exitCode: 2, stdout: "", stderr: "loop.py: lock busy\n" }, "Workflow reconciliation failed"),
    { message: "Workflow reconciliation failed: loop.py: lock busy" });
  assert.throws(() => readLoopOutput({ exitCode: 1, stdout: JSON.stringify({ kind: "error", error: { message: "Loop is closed" } }), stderr: "trace" }, "Workflow close failed"),
    { message: "Loop is closed" });
  assert.throws(() => readLoopOutput({ exitCode: 3, stdout: "Traceback", stderr: "" }, "Workflow close failed"),
    { message: "Workflow close failed: exit code 3" });
  assert.throws(() => readLoopOutput({ exitCode: 0, stdout: "not json", stderr: "" }, "Workflow close failed"),
    { message: "Workflow close failed: Runtime returned an invalid response" });
  assert.deepEqual(readLoopOutput({ exitCode: 0, stdout: JSON.stringify({ kind: "work-verification-loop" }), stderr: "" }, "unused"), { kind: "work-verification-loop" });
  const root = await mkdtemp(join(tmpdir(), "af-loop-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = agentsRoot(root), loop = join(directory, "work-one", "loops", "loop-one");
  const parent = join(directory, "main-owner", "runs", "run-parent", "state.json");
  await mkdir(loop, { recursive: true }); await mkdir(dirname(parent), { recursive: true });
  await writeFile(parent, JSON.stringify({ executionPolicy: { schemaVersion: 1 } }));
  await writeFile(join(loop, "state.json"), JSON.stringify({ workflow: { id: "one" }, status: "active", parentStatePath: parent }));
  await writeFile(join(root, "loop.py"), "import sys\nprint('partial output')\nsys.stderr.write('loop state is locked by another process\\n')\nsys.exit(2)\n");
  const client = new AgentFactoryClient(join(root, "exec.py"), root);
  client.location = async () => ({ home: runtimeTestHome, projectId: "project-test", agentsRoot: directory });
  await assert.rejects(client.refreshWorkflows("main-owner", [{ agentId: "work-one", role: "work" }], true),
    { message: "Workflow reconciliation failed: loop state is locked by another process" });
});

test("expected runtime home follows the runtime's normalization without resolving links", async t => {
  const { expectedRuntimeHome } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.equal(expectedRuntimeHome({}, "/home/user"), "/home/user/.agent-factory");
  assert.equal(expectedRuntimeHome({ AGENT_FACTORY_HOME: "" }, "/home/user"), "/home/user/.agent-factory", "an empty value selects the default");
  assert.equal(expectedRuntimeHome({ AGENT_FACTORY_HOME: "~" }, "/home/user"), "/home/user");
  assert.equal(expectedRuntimeHome({ AGENT_FACTORY_HOME: "~/af-home/" }, "/home/user"), "/home/user/af-home");
  assert.equal(expectedRuntimeHome({ AGENT_FACTORY_HOME: "/data//af/./home/" }, "/home/user"), "/data/af/home");
  const root = await mkdtemp(join(tmpdir(), "af-home-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "real")); await symlink(join(root, "real"), join(root, "link"));
  // The runtime rejects a linked home component itself, so the binding is compared as written.
  assert.equal(expectedRuntimeHome({ AGENT_FACTORY_HOME: join(root, "link") }, "/home/user"), join(root, "link"));
});


test("child history indexes more than 500 parent runs and 1000 children", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/unused");
  client.managedPath = async (...parts) => parts.join("/");
  client.managedDirectoryEntries = async () => Array.from({ length: 501 }, (_, i) => ({
    name: `run-${String(i).padStart(4, "0")}`, isDirectory: () => true
  }));
  client.discoverRunChildren = async (_parent, run) => new Map([[`work-${run}`, { parentRunId: run, pending: false }]]);
  assert.equal((await client.discoverChildAgents("main-history")).size, 501);
  client.discoverChildAgents = async () => new Map(Array.from({ length: 1001 }, (_, i) => [
    `work-${i}`, { runId: `run-${i}`, pending: false }
  ]));
  client.cachedRunState = async path => ({ agentId: path.split("/")[0], role: "work" });
  client.latestRunInfo = async (agentId, runId) => ({ status: "completed", runId,
    taskBinding: { taskId: agentId, description: "원문😀".repeat(100) } });
  const children = await client.listChildSessions("main-history");
  assert.equal(children.length, 1001);
  assert.equal(children[1000].taskBinding.description, "원문😀".repeat(100));
});


test("child task indexing preserves a description larger than the metadata cache budget", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-long-task-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "work-one", "runs", "run-one");
  await mkdir(directory, { recursive: true });
  const taskBinding = { taskId: "task-one", title: "큰 작업", description: "한글😀".repeat(100000) };
  await writeFile(join(directory, "state.json"), JSON.stringify({ status: "failed", taskBinding }));
  const client = new AgentFactoryClient("/unused/exec.py", root);
  client.managedPath = async (...parts) => join(root, ...parts);
  const captured = await client.latestRunInfo("work-one", "run-one");
  assert.equal(captured.status, "failed");
  assert.deepEqual(captured.taskBinding, taskBinding);
});


test("child activity follows exact run events, partial appends and terminal state", async t => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "af-child-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AgentFactoryClient("/unused", root);
  client.managedPath = async (agent, _runs, run, name) => name ? join(root, agent + "-" + run + "-" + name) : root;
  const file = join(root, "worker-run-one-events.jsonl");
  const phase = () => client.childProgressKey("worker", "run-one");
  assert.equal(await phase(), "ui.working");
  const append = event => appendFile(file, JSON.stringify(event) + "\n");
  await append({ type: "turn.started" });
  assert.equal(await phase(), "flow.activity.analyzing");
  await append({ type: "item.started", item: { type: "reasoning", text: "private" } });
  assert.equal(await phase(), "flow.activity.reasoning");
  await appendFile(file, '{"type":"item.started","item":{"type":"command_execution"}');
  assert.equal(await phase(), "flow.activity.reasoning", "Incomplete events do not change the phase");
  await appendFile(file, '}\n');
  assert.equal(await phase(), "ui.running.command");
  await append({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } });
  assert.equal(await phase(), "ui.analyzing.results");
  assert.equal(await client.childProgressKey("worker", "run-two"), "ui.working", "No phase leaks to another run");
  await append({ type: "item.completed", item: { type: "mcp_tool_call", error: { message: "failed" } } });
  assert.equal(await phase(), "ui.checking.connected.tool.failure");
  await writeFile(file, JSON.stringify({ type: "turn.started" }) + "\n");
  assert.equal(await phase(), "flow.activity.analyzing", "Truncated logs reset the cache");
  const state = join(root, "worker-run-one-state.json");
  await writeFile(state, JSON.stringify({ status: "running" }));
  assert.equal((await client.latestRunInfo("worker", "run-one")).progressKey, "flow.activity.analyzing");
  for (const status of ["completed", "failed", "cancelled", "needs-human-decision"]) {
    await writeFile(state, JSON.stringify({ status }));
    assert.equal((await client.latestRunInfo("worker", "run-one")).progressKey, undefined);
  }
});
