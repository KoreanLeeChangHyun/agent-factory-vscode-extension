import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const runtimeTestHome = await mkdtemp(join(tmpdir(), "af-extension-home-"));
process.env.AGENT_FACTORY_HOME = runtimeTestHome;
test.after(() => rm(runtimeTestHome, { recursive: true, force: true }));
function agentsRoot(root) {
  const id = "project-" + createHash("sha256").update(root).digest("hex").slice(0, 32);
  return join(runtimeTestHome, "projects", id, "agents");
}

async function importTypeScript(relativePath) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  const output = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    write: false
  });
  const source = output.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

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
    if name == 'submit': c.add_argument('--model')
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
    print(json.dumps({'kind': 'execution-capabilities', 'schemaVersion': '0.1.0', 'submit': {'model': True, 'reasoning': False, 'fast': False, 'goal': False}, 'send': {'model': False, 'reasoning': False, 'fast': False, 'goal': False}}))
    raise SystemExit(0)
print(json.dumps({'kind': 'error', 'error': {'code': 'test', 'message': 'specific runtime failure'}}))
raise SystemExit(2)
`);
  const client = new AgentFactoryClient(script, root);
  assert.deepEqual(await client.capabilities(), {
    submit: { model: true, reasoning: false, fast: false, goal: false },
    send: { model: false, reasoning: false, fast: false, goal: false }
  });
  await assert.rejects(client.submit('test', 'test', { reasoningEffort: 'medium', fast: false, goalMode: false }), /추론 수준/);
  await assert.rejects(client.send('test', 'test', { model: 'gpt-6-astra', fast: false, goalMode: false }), /모델 변경/);
  await assert.rejects(client.listSessions(), /specific runtime failure/);
});

test("composer shows only supported controls across draft and bound sessions", async function () {
  const script = await readFile(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
  const functions = script.slice(script.indexOf('  function currentCapabilities()'), script.indexOf('  function openSetting(setting)'));
  const button = () => ({ parentElement: {}, setAttribute() {} });
  const context = {
    state: { capabilities: { submit: { model: true }, send: {} }, model: 'gpt-6-astra', reasoning: 'medium', fastMode: true, goalMode: true },
    modelButton: button(), reasoningButton: button(), fastModeButton: button(), goalModeButton: button(),
    modelLabel: {}, reasoningLabel: {}, openSettingId: undefined,
    goalPanel: { querySelectorAll() { return []; } }, goalStatus: {}, nativeGoal: null, goalError: undefined
  };
  runInNewContext(functions + '\nupdateModeControls();', context);
  assert.equal(context.modelButton.parentElement.hidden, false);
  assert.equal(context.reasoningButton.parentElement.hidden, true);
  assert.equal(context.fastModeButton.hidden, true);
  assert.equal(context.goalModeButton.hidden, true);
  context.state.agentId = 'bound-session';
  runInNewContext('updateModeControls();', context);
  assert.equal(context.modelButton.parentElement.hidden, true);
  assert.equal(context.state.model, 'gpt-6-astra');
  assert.equal(context.state.reasoning, 'medium');
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
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000
  }), {
    panelId: "panel-one",
    title: "Main Agent",
    model: "gpt-5.6-terra",
    reasoning: "high",
    fastMode: true,
    goalMode: true,
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000
  });
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
  assert.equal(parseClientMessage({ type: "agent.open", agentId: "../work" }), undefined);
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
      }
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
      { kind: "status", text: "Main Agent가 요청을 분석 중" },
      { kind: "activity", id: "command-1", category: "command", phase: "started", text: "npm run check" },
      { kind: "status", text: "명령 실행 중" },
      { kind: "activity", id: "command-1", category: "command", phase: "completed", text: "npm run check" },
      { kind: "status", text: "결과 분석 중" },
      { kind: "activity", id: "change-1", category: "file", phase: "started", text: "static/js/chat.js, static/css/chat.css 외 1개" },
      { kind: "status", text: "Git 변경 중" },
      { kind: "status", text: "응답 기록 중" },
      { kind: "activity", id: "skill-1", category: "command", phase: "started", text: "sed -n '1,240p' /home/test/.codex/plugins/cache/personal/agent-factory/0.1.0/skills/agent/SKILL.md", title: "Skill 읽기 · agent-factory:agent" },
      { kind: "status", text: "명령 실행 중" },
      { kind: "status", text: "Main Agent가 요청을 분석 중" },
      { kind: "activity", id: "result-read-1", category: "command", phase: "started", text: `sed -n '1,20p' ${resultPath}`, title: "실행 결과 읽기" },
      { kind: "status", text: "명령 실행 중" },
      { kind: "activity", id: "mcp-1", category: "tool", phase: "started", text: "codex/list_mcp_resources" },
      { kind: "status", text: "연결 도구 실행 중" },
      { kind: "status", text: "응답 정리 중" },
      { kind: "usage", usedTokens: 39300, contextWindowTokens: 258400 }
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
    { type: "native.commentary", text: "   " },
    { type: "native.commentary", text: commentary },
    { type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "private reasoning" } }
  ].map(JSON.stringify).join("\n") + "\n");
  const commentaryUpdates = (await client.updates("main-test", "run-fake", 0)).updates;
  assert.deepEqual(commentaryUpdates.filter((update) => update.kind === "commentary"), [{ kind: "commentary", text: commentary }]);
  assert.equal(commentaryUpdates[1].text, "작업 중");

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
  await writeFile(childState, JSON.stringify({ status: "completed" }));
  assert.deepEqual(await client.listChildSessions("main-parent"), [{
    agentId: "work-hidden",
    role: "work",
    status: "completed",
    updatedAt: "2026-09-01T10:00:00Z"
  }]);

  const invocations = (await readFile(join(projectRoot, "fake-invocations.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(invocations.map((arguments_) => arguments_[0]), ["list", "submit", "status", "result", "cancel", "list"]);
  assert.ok(invocations[1].includes("--role"));
  assert.ok(invocations[1].includes("main"));
  assert.ok(invocations[1].includes("gpt-5.6-sol"));
  assert.ok(invocations[1].includes("high"));
  assert.ok(invocations[1].includes("--fast"));
  assert.ok(invocations[1].includes("--goal-mode"));
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
  assert.match(calls[0][2], /notes\.md: file:\/\/\/tmp\/notes\.md/);
  assert.deepEqual(calls.map((call) => call[0]), ["submit", "send"]);
  assert.equal(calls[1][1], calls[0][1]);
  assert.deepEqual(calls[0][3], execution);
  assert.equal(messages.filter((message) => message[0] === "assistant").length, 2);
  assert.deepEqual(messages.filter((message) => message[0] === "status"), [["status", "completed"], ["status", "completed"]]);
});

test("session controller clearly rejects a concurrent send", async function () {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let releaseStatus;
  const errors = [];
  const runtime = {
    async submit(agentId) { return { agentId, runId: "run-busy" }; },
    async send() { throw new Error("unexpected send"); },
    async updates(_agentId, _runId, cursor) { return { cursor, updates: [] }; },
    status() { return new Promise((resolve) => { releaseStatus = resolve; }); },
    async result() { return { status: "completed", text: "done" }; },
    async cancel() {}
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {},
    onRunningChanged() {},
    onAssistantText() {},
    onProgress() {},
    onActivity() {},
    onError(message) { errors.push(message); }
  }, undefined, { pollIntervalMs: 0, maxPolls: 2 });

  const execution = { fast: false, goalMode: false };
  const first = controller.send("first", [], execution);
  while (!releaseStatus) await new Promise((resolve) => setImmediate(resolve));
  await controller.send("second", [], execution);
  releaseStatus({ status: "completed" });
  await first;

  assert.match(errors[0], /실행 중/);
});

test("native settings preserve explicit off and inherit on exact-session send", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const root = await mkdtemp(join(tmpdir(), "native-settings-"));
  const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
  await client.send("main-exact", "off", { model: "model-one", reasoningEffort: "high", fast: false, goalMode: false });
  await client.send("main-exact", "inherit", {});
  const calls = (await readFile(join(root, "fake-invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf("--agent") + 1], "main-exact");
  assert.ok(calls[0].includes("--no-fast"));
  assert.ok(calls[0].includes("--no-goal-mode"));
  assert.ok(calls[0].includes("model-one"));
  assert.ok(calls[0].includes("high"));
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
  assert.ok(updates.updates.some(update => update.kind === "status" && update.text.includes("다음 turn")));
});

test("Goal control and objective protocol rejects unsupported actions and overlong objectives", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  for (const action of ["get", "refresh", "pause", "cancel", "disable", "reopen"]) {
    assert.deepEqual(parseClientMessage({ type: "goal.control", action }), { type: "goal.control", action });
  }
  assert.equal(parseClientMessage({ type: "goal.control", action: "complete" }), undefined);
  const message = { type: "chat.send", id: "one", text: "request", attachments: [], execution: { fast: false, goal: true, goalObjective: "finish" } };
  assert.equal(parseClientMessage(message).execution.goalObjective, "finish");
  assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, goalObjective: "x".repeat(4001) } }), undefined);
  assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, goal: false } }), undefined);
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

test("Goal UI shows native completion separately and keeps reopen unavailable during execution", async () => {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const render = script.slice(script.indexOf("  function renderGoal()"), script.indexOf("  function openSetting(setting)"));
  const buttons = ["refresh", "pause", "reopen", "cancel", "disable"].map(action => ({ dataset: { goalAction: action } }));
  const context = {
    state: { role: "main", agentId: "main-exact", goalMode: true, running: true },
    goalPanel: { querySelectorAll() { return buttons; } }, goalStatus: {}, goalError: undefined,
    nativeGoal: { objective: "finish", status: "active", tokensUsed: 20, timeUsedSeconds: 3 }
  };
  runInNewContext(render + "\nrenderGoal();", context);
  assert.match(context.goalStatus.textContent, /진행 중/);
  assert.equal(buttons[2].disabled, true);
  context.nativeGoal.status = "complete";
  context.state.running = false;
  runInNewContext("renderGoal();", context);
  assert.match(context.goalStatus.textContent, /목표 완료/);
  assert.equal(buttons[2].disabled, false);
  context.state.role = "work";
  runInNewContext("renderGoal();", context);
  assert.equal(context.goalPanel.hidden, true);
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
    assert.match(text[0], /보존된 부분 결과/);
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
  assert.ok(result.updates.some(value => value.kind === "status" && value.text.includes("응답 정리")));
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
  await assert.rejects(client.readManagedResult(join(external, "result.md"), "main-test", "run-fake"), /범위 밖/);
  await symlink(external, join(agentsRoot(root), "main-test"), "dir");
  await assert.rejects(client.updates("main-test", "run-fake", 0), /안전하지/);
  await assert.rejects(readFile(join(root, ".agent-factory")), { code: "ENOENT" });
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
      { kind: "status", text: "작업 중" },
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


test("human decision approvals are explicit, once-only and bound to the pending run", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  const decisions = [], texts = [], sent = [], errors = [], human = [];
  let nextStatus = "needs-human-decision";
  const runtime = {
    async submit(agentId) { return { agentId, runId: "proposal-run" }; },
    async send(agentId, text, execution) { sent.push({ text, execution }); return { agentId, runId: "reply-run" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: nextStatus }; },
    async result() { return { status: nextStatus, text: "제안한 범위로 진행할까요?" }; }
  };
  const events = {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {},
    onAssistantText(text, phase, runId) { texts.push({ text, phase, runId }); },
    onDecision(runId) { decisions.push(runId); }, onHumanDecision(text) { human.push(text); },
    onError(error) { errors.push(error); }
  };
  const controller = new ChatSessionController(runtime, events, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await controller.send("task", [], {});
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
  assert.equal(sent[0].text, human[0]);
  assert.equal(controller.approveDecision("proposal-run", {}), false);
  nextStatus = "needs-human-decision";
  await controller.send("another proposal", [], {});
  assert.equal(decisions.at(-1), "reply-run");
  nextStatus = "completed";
  await controller.send("직접 답변", [], {});
  assert.equal(controller.approveDecision("reply-run", {}), false);
});

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
});

test("explicit execution mode applies sandbox and never approval only to root submit", async () => {
  const { AgentFactoryClient, rootExecutionArguments } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  assert.deepEqual(rootExecutionArguments(), []);
  assert.throws(() => rootExecutionArguments("unsafe-unknown"), /실행 권한/);
  const root = await mkdtemp(join(tmpdir(), "af-execution-mode-"));
  try {
    const client = new AgentFactoryClient(new URL("../fixtures/fake-exec.py", import.meta.url).pathname, root);
    await client.submit("main-default", "task", { executionMode: "cli-default" });
    await client.submit("main-workspace", "task", { executionMode: "workspace-write" });
    await client.submit("main-full", "task", { executionMode: "danger-full-access" });
    await client.send("main-full", "next", { executionMode: "workspace-write" });
    const calls = (await readFile(join(root, "fake-invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls[0].includes("--sandbox"), false);
    for (const [index, mode] of [[1, "workspace-write"], [2, "danger-full-access"]]) {
      assert.equal(calls[index][calls[index].indexOf("--sandbox") + 1], mode);
      assert.equal(calls[index][calls[index].indexOf("--approval-policy") + 1], "never");
    }
    assert.equal(calls[3][0], "send");
    assert.equal(calls[3].includes("--sandbox"), false);
    assert.equal(calls[3].includes("--approval-policy"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
