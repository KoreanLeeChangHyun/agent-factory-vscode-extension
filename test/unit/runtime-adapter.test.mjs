import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

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

test("runtime client invokes official commands and reads the bounded managed result", async function () {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-factory-client-"));
  const codexHome = join(projectRoot, "codex-home");
  const fakeExec = new URL("../fixtures/fake-exec.py", import.meta.url).pathname;
  const resultPath = join(projectRoot, ".agent-factory/agent/main-test/runs/run-fake/result.md");
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
  const eventsPath = join(projectRoot, ".agent-factory/agent/main-test/runs/run-fake/events.jsonl");
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
  assert.deepEqual(await client.result("main-test", "run-fake"), {
    status: "completed",
    text: "Main result text\n"
  });
  await client.cancel("main-test", "run-fake");

  const parentEvents = join(projectRoot, ".agent-factory/agent/main-parent/runs/run-parent/events.jsonl");
  await mkdir(dirname(parentEvents), { recursive: true });
  await writeFile(parentEvents, JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "python3 loop.py start --work-agent work-hidden --verification-agent verification-not-started"
    }
  }) + "\n");
  const childState = join(projectRoot, ".agent-factory/agent/work-hidden/runs/run-child/state.json");
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
