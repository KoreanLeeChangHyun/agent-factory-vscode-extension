"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { join } = require("node:path");
const test = require("node:test");

const {
  CodexRunner,
  JsonLinesParser,
  buildExecArgs,
  normalizeCodexEvent,
  resolveBundledCodexPath,
} = require("../../src/codexAdapter");

test("resolveBundledCodexPath resolves only the bundled linux-x64 payload", () => {
  const extensionPath = "/extension";
  const expected = join(
    extensionPath,
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "bin",
    "codex",
  );

  assert.equal(
    resolveBundledCodexPath({
      extensionPath,
      platform: "linux",
      arch: "x64",
      existsSync: (candidate) => candidate === expected,
    }),
    expected,
  );
  assert.throws(
    () =>
      resolveBundledCodexPath({
        extensionPath,
        platform: "darwin",
        arch: "x64",
      }),
    /지원하지 않는 플랫폼/,
  );
  assert.throws(
    () =>
      resolveBundledCodexPath({
        extensionPath,
        platform: "linux",
        arch: "x64",
        existsSync: () => false,
      }),
    /포함된 Codex CLI를 찾을 수 없습니다/,
  );
});

test("buildExecArgs creates exact new and resume argument arrays without a shell", () => {
  assert.deepEqual(
    buildExecArgs({
      prompt: "hello",
      cwd: "/workspace",
    }),
    ["exec", "--json", "--cd", "/workspace", "hello"],
  );
  assert.deepEqual(
    buildExecArgs({
      prompt: "again",
      cwd: "/workspace",
      providerSessionId: "019f-session",
    }),
    [
      "exec",
      "resume",
      "--json",
      "019f-session",
      "again",
    ],
  );
  assert.throws(() => buildExecArgs({ prompt: "  ", cwd: "/workspace" }), /비어/);
});

test("JsonLinesParser handles partial chunks and reports malformed lines", () => {
  const events = [];
  const errors = [];
  const parser = new JsonLinesParser({
    onEvent: (event) => events.push(event),
    onMalformedLine: (error) => errors.push(error.message),
  });

  parser.push('{"type":"thread.started","thread_id":"abc"}\n{"type":"item.');
  parser.push('completed","item":{"type":"agent_message","text":"hi"}}\nnope\n');
  parser.end();

  assert.deepEqual(events, [
    { type: "thread.started", thread_id: "abc" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "hi" },
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /JSONL/);
});

test("normalizeCodexEvent maps provider session, assistant output and completion", () => {
  assert.deepEqual(
    normalizeCodexEvent({ type: "thread.started", thread_id: "provider-1" }),
    { type: "session", providerSessionId: "provider-1" },
  );
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.updated",
      item: { type: "agent_message" },
      delta: "hel",
    }),
    { type: "assistant.delta", text: "hel" },
  );
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    }),
    { type: "assistant.message", text: "hello" },
  );
  assert.deepEqual(
    normalizeCodexEvent({ type: "turn.completed", usage: { input_tokens: 1 } }),
    { type: "complete", usage: { input_tokens: 1 } },
  );
  assert.deepEqual(
    normalizeCodexEvent({
      type: "item.started",
      item: { type: "command_execution" },
    }),
    { type: "progress", label: "명령 실행 중" },
  );
  assert.equal(normalizeCodexEvent({ type: "item.completed", item: {} }), null);
});

test("CodexRunner streams normalized events and binds each child to its owner session", async () => {
  const children = [];
  const spawnCalls = [];
  const spawn = (executable, args, options) => {
    const child = createFakeChild();
    children.push(child);
    spawnCalls.push({ executable, args, options });
    return child;
  };
  const runner = new CodexRunner({
    executablePath: "/extension/codex",
    spawn,
  });
  const events = [];
  const runPromise = runner.run({
    sessionId: "local-1",
    prompt: "hello",
    cwd: "/workspace",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(spawnCalls[0], {
    executable: "/extension/codex",
    args: ["exec", "--json", "--cd", "/workspace", "hello"],
    options: {
      cwd: "/workspace",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  });
  children[0].stdout.emit(
    "data",
    Buffer.from(
      '{"type":"thread.started","thread_id":"provider-1"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n',
    ),
  );
  children[0].emit("close", 0, null);

  await runPromise;
  assert.deepEqual(events, [
    { type: "session", providerSessionId: "provider-1" },
    { type: "assistant.message", text: "hello" },
    { type: "complete", usage: null },
  ]);
  assert.equal(runner.hasRunning("local-1"), false);
});

test("CodexRunner cancellation terminates only the requested session", async () => {
  const children = [createFakeChild(), createFakeChild()];
  const runner = new CodexRunner({
    executablePath: "/extension/codex",
    spawn: () => children.shift(),
  });
  const first = runner.run({
    sessionId: "local-1",
    prompt: "one",
    cwd: "/workspace",
    onEvent() {},
  });
  const second = runner.run({
    sessionId: "local-2",
    prompt: "two",
    cwd: "/workspace",
    onEvent() {},
  });
  const firstChild = runner.running.get("local-1").child;
  const secondChild = runner.running.get("local-2").child;

  assert.equal(runner.cancel("local-1"), true);
  assert.deepEqual(firstChild.kills, ["SIGTERM"]);
  assert.deepEqual(secondChild.kills, []);

  firstChild.emit("close", null, "SIGTERM");
  secondChild.emit("close", 0, null);
  await Promise.all([first, second]);
});

test("CodexRunner rejects malformed and failed output without exposing stderr", async () => {
  const malformedChild = createFakeChild();
  const failedChild = createFakeChild();
  const children = [malformedChild, failedChild];
  const runner = new CodexRunner({
    executablePath: "/extension/codex",
    spawn: () => children.shift(),
  });

  const malformed = runner.run({
    sessionId: "malformed",
    prompt: "one",
    cwd: "/workspace",
    onEvent() {},
  });
  malformedChild.stdout.emit("data", Buffer.from("not-json\n"));
  malformedChild.emit("close", 0, null);
  await assert.rejects(malformed, /JSONL/);

  const failed = runner.run({
    sessionId: "failed",
    prompt: "two",
    cwd: "/workspace",
    onEvent() {},
  });
  failedChild.stderr.emit("data", Buffer.from("SECRET_TOKEN=do-not-leak"));
  failedChild.emit("close", 1, null);
  await assert.rejects(failed, (error) => {
    assert.match(error.message, /Codex 실행이 실패/);
    assert.doesNotMatch(error.message, /SECRET_TOKEN|do-not-leak/);
    return true;
  });
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}
