"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AgentsChatController,
  validateWebviewMessage,
} = require("../../src/chatBackend");

test("validateWebviewMessage allowlists ready, submit and cancel messages", () => {
  assert.deepEqual(validateWebviewMessage({ type: "chat.ready" }), {
    type: "chat.ready",
  });
  assert.deepEqual(
    validateWebviewMessage({
      type: "chat.submit",
      sessionId: "local-1",
      prompt: " hello ",
    }),
    {
      type: "chat.submit",
      sessionId: "local-1",
      prompt: "hello",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    },
  );
  assert.deepEqual(
    validateWebviewMessage({
      type: "chat.submit",
      sessionId: "local-1",
      prompt: "hello",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    }),
    {
      type: "chat.submit",
      sessionId: "local-1",
      prompt: "hello",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    },
  );
  assert.deepEqual(
    validateWebviewMessage({
      type: "chat.submit",
      sessionId: "local-1",
      prompt: "hello",
      model: "gpt-5.5",
      reasoningEffort: "high",
    }),
    {
      type: "chat.submit",
      sessionId: "local-1",
      prompt: "hello",
      model: "gpt-5.5",
      reasoningEffort: "high",
    },
  );
  assert.deepEqual(
    validateWebviewMessage({ type: "chat.cancel", sessionId: "local-1" }),
    { type: "chat.cancel", sessionId: "local-1" },
  );
  assert.deepEqual(
    validateWebviewMessage({ type: "chat.session.delete", sessionId: "local-1" }),
    { type: "chat.session.delete", sessionId: "local-1" },
  );
  assert.equal(validateWebviewMessage({ type: "unknown" }), null);
  assert.equal(
    validateWebviewMessage({
      type: "chat.submit",
      sessionId: "",
      prompt: "hello",
    }),
    null,
  );
  assert.equal(
    validateWebviewMessage({
      type: "chat.submit",
      sessionId: "local-1",
      prompt: " ",
    }),
    null,
  );
});

test("controller routes events to the owning session and restores snapshots", async () => {
  const state = createState();
  const runner = createRunner();
  const posted = [];
  const controller = new AgentsChatController({
    runner,
    workspaceState: state,
    workspaceRoot: "/workspace",
    postMessage: async (message) => posted.push(message),
  });

  await controller.handleMessage({ type: "chat.ready" });
  assert.equal(posted[0].type, "chat.snapshot");

  await controller.handleMessage({
    type: "chat.submit",
    sessionId: "local-1",
    prompt: "hello",
  });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].providerSessionId, null);
  assert.equal(runner.calls[0].model, "gpt-5.5");
  assert.equal(runner.calls[0].reasoningEffort, "medium");
  runner.calls[0].onEvent({
    type: "session",
    providerSessionId: "provider-1",
  });
  runner.calls[0].onEvent({ type: "progress", label: "명령 실행 중" });
  assert.equal(
    controller.snapshot().sessions["local-1"].progress,
    "명령 실행 중",
  );
  runner.calls[0].onEvent({ type: "assistant.delta", text: "hel" });
  runner.calls[0].onEvent({ type: "assistant.message", text: "hello" });
  runner.calls[0].onEvent({
    type: "complete",
    usage: { input_tokens: 120, output_tokens: 30 },
  });
  await runner.finish(0);

  const snapshot = controller.snapshot();
  const session = snapshot.sessions["local-1"];
  assert.equal(session.providerSessionId, "provider-1");
  assert.equal(session.status, "complete");
  assert.deepEqual(session.usage, { input_tokens: 120, output_tokens: 30 });
  assert.deepEqual(
    session.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hello" },
    ],
  );
  assert.ok(posted.every((message) => message.sessionId !== "local-2"));
  assert.ok(state.updates.length > 0);
});

test("controller resumes a provider session and cancellation stays session-scoped", async () => {
  const state = createState({
    version: 1,
    sessions: {
      "local-1": {
        id: "local-1",
        providerSessionId: "provider-1",
        messages: [],
        status: "idle",
        error: null,
      },
    },
  });
  const runner = createRunner();
  const controller = new AgentsChatController({
    runner,
    workspaceState: state,
    workspaceRoot: "/workspace",
    postMessage: async () => {},
  });

  await controller.handleMessage({
    type: "chat.submit",
    sessionId: "local-1",
    prompt: "again",
  });
  assert.equal(runner.calls[0].providerSessionId, "provider-1");
  await controller.handleMessage({
    type: "chat.cancel",
    sessionId: "local-1",
  });
  assert.deepEqual(runner.cancelled, ["local-1"]);
  assert.equal(controller.snapshot().sessions["local-1"].status, "cancelling");
  await runner.finish(0);
});

test("controller rejects duplicate submits and marks restored running work interrupted", async () => {
  const state = createState({
    version: 1,
    sessions: {
      "local-1": {
        id: "local-1",
        providerSessionId: "provider-1",
        messages: [{ role: "assistant", text: "partial", streaming: true }],
        status: "running",
        error: null,
      },
    },
  });
  const runner = createRunner();
  const controller = new AgentsChatController({
    runner,
    workspaceState: state,
    workspaceRoot: "/workspace",
    postMessage: async () => {},
  });
  assert.equal(
    controller.snapshot().sessions["local-1"].status,
    "interrupted",
  );

  await controller.handleMessage({
    type: "chat.submit",
    sessionId: "local-1",
    prompt: "resume",
  });
  await controller.handleMessage({
    type: "chat.submit",
    sessionId: "local-1",
    prompt: "duplicate",
  });
  assert.equal(runner.calls.length, 1);
  await runner.finish(0);
});

test("controller deletes only an idle target session", async () => {
  const state = createState({
    version: 1,
    sessions: {
      "local-1": { id: "local-1", messages: [], status: "idle" },
      "local-2": { id: "local-2", messages: [], status: "idle" },
    },
  });
  const controller = new AgentsChatController({
    runner: createRunner(),
    workspaceState: state,
    workspaceRoot: "/workspace",
    postMessage: async () => {},
  });

  await controller.handleMessage({ type: "chat.session.delete", sessionId: "local-1" });
  await controller.handleMessage({
    type: "chat.submit",
    sessionId: "local-2",
    prompt: "keep running",
  });
  await controller.handleMessage({ type: "chat.session.delete", sessionId: "local-2" });

  assert.equal(controller.snapshot().sessions["local-1"], undefined);
  assert.ok(controller.snapshot().sessions["local-2"]);
});

function createState(initialValue) {
  return {
    value: initialValue,
    updates: [],
    get(_key, fallback) {
      return this.value || fallback;
    },
    async update(_key, value) {
      this.value = value;
      this.updates.push(value);
    },
  };
}

function createRunner() {
  const pending = [];
  return {
    calls: [],
    cancelled: [],
    run(options) {
      this.calls.push(options);
      return new Promise((resolve) => pending.push(resolve));
    },
    cancel(sessionId) {
      this.cancelled.push(sessionId);
      return true;
    },
    async finish(index) {
      pending[index]();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
