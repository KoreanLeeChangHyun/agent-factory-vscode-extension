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
  const fakeExec = new URL("../fixtures/fake-exec.py", import.meta.url).pathname;
  const resultPath = join(projectRoot, ".agent-factory/agent/main-test/runs/run-fake/result.md");
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, "Main result text\n");
  const client = new AgentFactoryClient(fakeExec, projectRoot);

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
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "/usr/bin/zsh -lc 'npm run check'" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/usr/bin/zsh -lc 'npm run check'" } }),
    JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [
      { path: join(projectRoot, "static/js/chat.js") },
      { path: join(projectRoot, "static/css/chat.css") },
      { path: join(projectRoot, "templates/chat.html") }
    ] } }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "codex", tool: "list_mcp_resources" } }),
    ""
  ].join("\n"));
  assert.deepEqual(await client.updates("main-test", "run-fake", 0), {
    cursor: 5,
    labels: [
      "Main Agent가 요청을 분석 중",
      "명령 실행 중 · npm run check",
      "명령 결과 분석 중 · npm run check",
      "파일 변경 중 · static/js/chat.js, static/css/chat.css 외 1개",
      "연결 도구 실행 중 · codex/list_mcp_resources"
    ]
  });
  await appendFile(eventsPath, '{"type":"turn.completed"');
  assert.deepEqual(await client.updates("main-test", "run-fake", 5), {
    cursor: 5,
    labels: []
  });
  assert.deepEqual(await client.result("main-test", "run-fake"), {
    status: "completed",
    text: "Main result text\n"
  });
  await client.cancel("main-test", "run-fake");

  const invocations = (await readFile(join(projectRoot, "fake-invocations.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(invocations.map((arguments_) => arguments_[0]), ["submit", "status", "result", "cancel"]);
  assert.ok(invocations[0].includes("--role"));
  assert.ok(invocations[0].includes("main"));
  assert.ok(invocations[0].includes("gpt-5.6-sol"));
  assert.ok(invocations[0].includes("high"));
  assert.ok(invocations[0].includes("--fast"));
  assert.ok(invocations[0].includes("--goal-mode"));
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
    async updates(_agentId, _runId, cursor) { return { cursor, labels: [] }; },
    async status() { return { status: "completed" }; },
    async result() { return { status: "completed", text: "done" }; },
    async cancel() {}
  };
  const controller = new ChatSessionController(runtime, {
    onBound(agentId) { messages.push(["bound", agentId]); },
    onRunningChanged(running) { messages.push(["running", running]); },
    onAssistantText(text) { messages.push(["assistant", text]); },
    onProgress(text) { messages.push(["progress", text]); },
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
    async updates(_agentId, _runId, cursor) { return { cursor, labels: [] }; },
    status() { return new Promise((resolve) => { releaseStatus = resolve; }); },
    async result() { return { status: "completed", text: "done" }; },
    async cancel() {}
  };
  const controller = new ChatSessionController(runtime, {
    onBound() {},
    onRunningChanged() {},
    onAssistantText() {},
    onProgress() {},
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
