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
    submit: { model: true, reasoning: false, fast: false, goal: false, images: false, taskModes: [] },
    send: { model: false, reasoning: false, fast: false, goal: false, images: false, taskModes: [] }
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

test("composer shows only supported controls across draft and bound sessions", async function () {
  const script = await readFile(new URL('../../static/js/chat.js', import.meta.url), 'utf8');
  const functions = script.slice(script.indexOf('  function currentCapabilities()'), script.indexOf('  function openSetting(setting)'));
  const iconFunction = script.slice(script.indexOf('  function createTaskModeIcon(mode)'), script.indexOf('  function handleSettingMenuKeydown(event)'));
  const element = (namespaceURI, localName) => ({
    namespaceURI, localName, children: [], attributes: {},
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
  const button = () => Object.assign(element('http://www.w3.org/1999/xhtml', 'button'), { parentElement: {} });
  let statusRenders = 0;
  const context = {
    document: { createElementNS: element },
    renderStatusBar() { statusRenders++; },
    state: { capabilities: { submit: { model: true }, send: {} }, model: 'gpt-6-astra', reasoning: 'medium', fastMode: true, goalMode: true },
    modelButton: button(), reasoningButton: button(), fastModeButton: button(), goalModeButton: button(), workLoopButton: button(),
    taskModeNames: { work: "Work" },
    executionModeButton: button(), executionModeLabel: {}, modelLabel: {}, reasoningLabel: {}, openSettingId: undefined,
    goalPanel: { querySelectorAll() { return []; } }, goalStatus: {}, nativeGoal: null, goalError: undefined
  };
  runInNewContext(functions + iconFunction + '\nupdateModeControls();', context);
  assert.equal(context.workLoopButton.children.length, 1);
  const icon = context.workLoopButton.children[0];
  assert.equal(icon.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(icon.localName, 'svg');
  assert.equal(icon.children[0].localName, 'path');
  assert.ok(icon.children[0].attributes.d);
  assert.equal(statusRenders, 1);
  assert.equal(context.modelButton.parentElement.hidden, false);
  assert.equal(context.reasoningButton.parentElement.hidden, true);
  assert.equal(context.fastModeButton.hidden, true);
  assert.equal(context.goalModeButton.hidden, true);
  context.state.agentId = 'bound-session';
  runInNewContext('updateModeControls();', context);
  assert.equal(context.modelButton.parentElement.hidden, true);
  assert.equal(context.workLoopButton.children.length, 1);
  assert.notEqual(context.workLoopButton.children[0], icon);
  assert.equal(statusRenders, 2);
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
    workLoopMode: true,
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000,
    weeklyUsedPercent: 12.5
  }), {
    panelId: "panel-one",
    title: "Main Agent",
    model: "gpt-5.6-terra",
    reasoning: "high",
    fastMode: true,
    goalMode: true,
    workLoopMode: true,
    taskMode: "work-verification",
    contextUsedTokens: 39_300,
    contextWindowTokens: 1_050_000,
    weeklyUsedPercent: 12.5
  });
});

test("webview persistence carries weekly usage through chat state restoration", async function () {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const persist = script.slice(
    script.indexOf("  function persist()"),
    script.indexOf("  function safeCount(value)")
  );
  let serialized;
  runInNewContext(persist + "\npersist();", {
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

  assert.equal(serialized.weeklyUsedPercent, 12.5);
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  assert.equal(restoreChatState(serialized).weeklyUsedPercent, 12.5);
});

test("Content remaining is independent of Weekly availability", async function () {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const functions = script.slice(
    script.indexOf("  function contextStatusLabel()"),
    script.indexOf("  function renderContextStatus(item)")
  );
  const context = {
    state: { contextUsedTokens: 54_264, contextWindowTokens: 258_400, weeklyUsedPercent: 12.5 }
  };
  assert.equal(
    runInNewContext(functions + "\ncontextStatusLabel();", context),
    "Content remaining 79%"
  );
  context.state.weeklyUsedPercent = undefined;
  assert.equal(
    runInNewContext("contextStatusLabel();", context),
    "Content remaining 79%"
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

test("long pasted text attachment requests are bounded", async function () {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const text = "가".repeat(8_000);
  assert.deepEqual(parseClientMessage({ type: "attachments.createText", text }), {
    type: "attachments.createText",
    text
  });
  assert.equal(parseClientMessage({ type: "attachments.createText", text: "short" }), undefined);
  assert.equal(parseClientMessage({ type: "attachments.createText", text: "x".repeat(1_000_001) }), undefined);
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
      { kind: "usage", usedTokens: 39300, contextWindowTokens: 258400, weeklyUsedPercent: 3 }
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
  assert.equal(commentaryUpdates[1].text, "Working");

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
    runId: "run-child",
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
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 12.5, window_minutes: 10_080 }
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
      { kind: "usage", usedTokens: 10_000, contextWindowTokens: 258_400, weeklyUsedPercent: 12.5 }
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
    updates: [{ kind: "usage", usedTokens: 20_000, contextWindowTokens: 258_400 }]
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
  assert.match(calls[1][1], /queued\.md: file:\/\/\/tmp\/queued\.md/);
  assert.match(calls[1][1], /대기 메시지 2 시작 ---\nthird/);
  assert.deepEqual(calls[1][2], secondExecution);
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
  assert.ok(updates.updates.some(update => update.kind === "status" && update.text.includes("next turn")));
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

test("runtime acceptance rejects malformed run identities and Goal acknowledgements for non-reopen actions", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/workspace");
  client.capabilities = async () => ({
    submit: { model: true, reasoning: true, fast: true, goal: true },
    send: { model: true, reasoning: true, fast: true, goal: true }
  });
  client.command = async () => ({ kind: "ack", status: "accepted", agentId: "main-exact", runId: "../outside" });
  await assert.rejects(client.submit("main-exact", "task", {}), /acceptance response/);
  client.command = async () => ({ kind: "ack", status: "accepted", agentId: "main-exact", runId: "run-exact" });
  await assert.rejects(client.goal("main-exact", "refresh"), /unexpected run/);
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
  assert.match(context.goalStatus.textContent, /In progress/);
  assert.equal(buttons[2].disabled, true);
  context.nativeGoal.status = "complete";
  context.state.running = false;
  runInNewContext("renderGoal();", context);
  assert.match(context.goalStatus.textContent, /Goal completed/);
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
  await controller.send("task", [], { taskMode: "plan-work-verification" });
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
  assert.equal(sent[0].execution.taskMode, "plan-work-verification");
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
  assert.deepEqual(finals, ["Recovered result", "Recovered result"]);
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
  await assert.rejects(client.listChildSessions("main-parent", "../run-old"));
});

test("child progress counts queued work and excludes completed verification", async () => {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const source = script.slice(script.indexOf("  function summarizeChildAgents("), script.indexOf("  function childAgentStatusLabel("));
  const context = { agents: [{ role: "work", status: "queued" }, { role: "verification", status: "completed" }] };
  const result = runInNewContext(source + "\nsummarizeChildAgents(agents)", context);
  assert.equal(result.activeUnits, 1);
  assert.equal(result.workActive, 1);
  assert.equal(result.verificationActive, 0);
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
    { agentId: "verification-hidden", role: "verification", runId: "run-verification", status: "running", verifiedWorkRunId: "run-old", updatedAt: "2026-09-01T11:00:00Z" },
    { agentId: "work-hidden", role: "work", runId: "run-old", status: "completed", updatedAt: "2026-09-01T10:00:00Z" }
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
  for (const taskMode of ["direct", "work", "work-verification", "plan-work-verification"]) {
    const message = { type: "chat.send", id: "message", text: "request", attachments: [], execution: { taskMode, fast: false, goal: false } };
    assert.equal(parseClientMessage(message).execution.taskMode, taskMode);
    assert.equal(parseClientMessage({ ...message, execution: { ...message.execution, taskMode: "plan-agent" } }), undefined);
  }
  const { restoreChatState } = await importTypeScript("src/modules/chat/chat-state.ts");
  assert.equal(restoreChatState({}).taskMode, "work");
  assert.equal(restoreChatState({ taskMode: "direct", workLoopMode: true }).taskMode, "direct");
  assert.equal(restoreChatState({ taskMode: "invalid" }).taskMode, "work");
});

test("mode capability negotiation rejects old runtimes and forwards supported flags", async () => {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("unused", "/project");
  client.capabilities = async () => ({ submit: {}, send: { taskModes: ["direct", "work"] } });
  await assert.rejects(client.checkedExecution("submit", { taskMode: "work" }), /Update/);
  await assert.rejects(client.checkedExecution("send", { taskMode: "plan-work-verification" }), /Update/);
  assert.deepEqual(await client.checkedExecution("send", { taskMode: "direct" }), ["--task-mode", "direct"]);
});
