"use strict";

const CHAT_STATE_KEY = "agentFactoryAgents.chat.sessions.v1";
const MAX_PROMPT_LENGTH = 50_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_REASONING_LEVELS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
};
const SUPPORTED_MODELS = new Set(Object.keys(MODEL_REASONING_LEVELS));
const SUPPORTED_REASONING_EFFORTS = new Set(
  Object.values(MODEL_REASONING_LEVELS).flat(),
);

function validateWebviewMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  if (message.type === "chat.ready") {
    return { type: "chat.ready" };
  }
  if (
    message.type === "chat.cancel" &&
    validSessionId(message.sessionId)
  ) {
    return { type: "chat.cancel", sessionId: message.sessionId };
  }
  if (
    message.type === "chat.session.delete" &&
    validSessionId(message.sessionId)
  ) {
    return { type: "chat.session.delete", sessionId: message.sessionId };
  }
  if (
    message.type === "chat.submit" &&
    validSessionId(message.sessionId) &&
    typeof message.prompt === "string"
  ) {
    const prompt = message.prompt.trim();
    const model = SUPPORTED_MODELS.has(message.model) ? message.model : "gpt-5.5";
    const reasoningEffort = MODEL_REASONING_LEVELS[model].includes(message.reasoningEffort)
      ? message.reasoningEffort
      : "medium";
    if (prompt && prompt.length <= MAX_PROMPT_LENGTH) {
      return {
        type: "chat.submit",
        sessionId: message.sessionId,
        prompt,
        model,
        reasoningEffort,
      };
    }
  }
  return null;
}

function validSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function defaultSnapshot() {
  return { version: 1, sessions: {} };
}

function restoreSnapshot(value) {
  const restored = defaultSnapshot();
  if (!value || value.version !== 1 || typeof value.sessions !== "object") {
    return restored;
  }
  for (const [id, candidate] of Object.entries(value.sessions)) {
    if (!validSessionId(id) || !candidate || candidate.id !== id) {
      continue;
    }
    const messages = Array.isArray(candidate.messages)
      ? candidate.messages
          .filter(
            (message) =>
              message &&
              (message.role === "user" || message.role === "assistant") &&
              typeof message.text === "string",
          )
          .map((message) => ({
            role: message.role,
            text: message.text,
            streaming: false,
          }))
      : [];
    const interrupted =
      candidate.status === "running" || candidate.status === "cancelling";
    const model = SUPPORTED_MODELS.has(candidate.model) ? candidate.model : "gpt-5.5";
    const reasoningEffort = MODEL_REASONING_LEVELS[model].includes(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : "medium";
    restored.sessions[id] = {
      id,
      providerSessionId:
        typeof candidate.providerSessionId === "string"
          ? candidate.providerSessionId
          : null,
      messages,
      status: interrupted ? "interrupted" : candidate.status || "idle",
      progress: null,
      error: interrupted
        ? "이전 실행이 중단되었습니다. 같은 세션에서 메시지를 보내 재개할 수 있습니다."
        : typeof candidate.error === "string"
          ? candidate.error
          : null,
      model,
      reasoningEffort,
      usage: candidate.usage && typeof candidate.usage === "object"
        ? candidate.usage
        : null,
      startedAt: Number.isFinite(candidate.startedAt) ? candidate.startedAt : null,
      completedAt: Number.isFinite(candidate.completedAt) ? candidate.completedAt : null,
    };
  }
  return restored;
}

class AgentsChatController {
  constructor({
    runner,
    workspaceState,
    workspaceRoot,
    postMessage = async () => {},
  }) {
    this.runner = runner;
    this.workspaceState = workspaceState;
    this.workspaceRoot = workspaceRoot;
    this.postMessage = postMessage;
    this.publishQueue = Promise.resolve();
    this.state = restoreSnapshot(
      workspaceState.get(CHAT_STATE_KEY, defaultSnapshot()),
    );
  }

  setPostMessage(postMessage) {
    this.postMessage = postMessage;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async handleMessage(rawMessage) {
    const message = validateWebviewMessage(rawMessage);
    if (!message) {
      return false;
    }
    if (message.type === "chat.ready") {
      await this.#publish();
      return true;
    }
    if (message.type === "chat.cancel") {
      const session = this.state.sessions[message.sessionId];
      if (session && this.runner.cancel(message.sessionId)) {
        session.status = "cancelling";
        session.error = null;
        await this.#publish(message.sessionId);
      }
      return true;
    }
    if (message.type === "chat.session.delete") {
      const session = this.state.sessions[message.sessionId];
      if (session?.status === "running" || session?.status === "cancelling") {
        return true;
      }
      delete this.state.sessions[message.sessionId];
      await this.#publish(message.sessionId);
      return true;
    }
    this.#submit(message);
    return true;
  }

  #submit({ sessionId, prompt, model, reasoningEffort }) {
    const session = this.#session(sessionId);
    if (session.status === "running" || session.status === "cancelling") {
      return;
    }
    session.messages.push({ role: "user", text: prompt, streaming: false });
    session.status = "running";
    session.progress = "Codex 시작 중";
    session.error = null;
    session.model = model;
    session.reasoningEffort = reasoningEffort;
    session.startedAt = Date.now();
    session.completedAt = null;
    void this.#publish(sessionId);

    void this.runner
      .run({
        sessionId,
        prompt,
        cwd: this.workspaceRoot,
        providerSessionId: session.providerSessionId,
        model,
        reasoningEffort,
        onEvent: (event) => this.#handleRunnerEvent(sessionId, event),
      })
      .then(() => {
        const current = this.state.sessions[sessionId];
        if (current.status === "running") {
          current.status = "complete";
        } else if (current.status === "cancelling") {
          current.status = "cancelled";
        }
        current.progress = null;
        current.completedAt = Date.now();
        return this.#publish(sessionId);
      })
      .catch((error) => {
        const current = this.state.sessions[sessionId];
        current.status = "error";
        current.progress = null;
        current.error = safeErrorMessage(error);
        current.completedAt = Date.now();
        return this.#publish(sessionId);
      });
  }

  #handleRunnerEvent(sessionId, event) {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return;
    }
    if (event.type === "session") {
      session.providerSessionId = event.providerSessionId;
    } else if (event.type === "progress") {
      session.progress = event.label;
    } else if (event.type === "assistant.delta") {
      const message = streamingMessage(session);
      message.text += event.text;
    } else if (event.type === "assistant.message") {
      const current = session.messages.at(-1);
      if (current?.role === "assistant" && current.streaming) {
        current.text = event.text;
        current.streaming = false;
      } else {
        session.messages.push({
          role: "assistant",
          text: event.text,
          streaming: false,
        });
      }
    } else if (event.type === "complete") {
      const current = session.messages.at(-1);
      if (current?.role === "assistant") {
        current.streaming = false;
      }
      session.status = "complete";
      session.progress = null;
      session.completedAt = Date.now();
      session.usage = event.usage;
    } else if (event.type === "cancelled") {
      session.status = "cancelled";
      session.progress = null;
      session.completedAt = Date.now();
    } else if (event.type === "error") {
      session.status = "error";
      session.progress = null;
      session.error = event.message;
      session.completedAt = Date.now();
    }
    void this.#publish(sessionId);
  }

  #session(sessionId) {
    if (!this.state.sessions[sessionId]) {
      this.state.sessions[sessionId] = {
        id: sessionId,
        providerSessionId: null,
        messages: [],
        status: "idle",
        progress: null,
        error: null,
        model: "gpt-5.5",
        reasoningEffort: "medium",
        usage: null,
        startedAt: null,
        completedAt: null,
      };
    }
    return this.state.sessions[sessionId];
  }

  async #publish(sessionId) {
    const snapshot = this.snapshot();
    this.publishQueue = this.publishQueue.then(async () => {
      await this.workspaceState.update(CHAT_STATE_KEY, snapshot);
      await this.postMessage({
        type: "chat.snapshot",
        sessionId,
        snapshot,
      });
    });
    return this.publishQueue;
  }
}

function streamingMessage(session) {
  const current = session.messages.at(-1);
  if (current?.role === "assistant" && current.streaming) {
    return current;
  }
  const message = { role: "assistant", text: "", streaming: true };
  session.messages.push(message);
  return message;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("Codex ") ||
    message.startsWith("이 세션") ||
    message.startsWith("포함된")
  ) {
    return message.slice(0, 500);
  }
  return "Codex 실행 중 오류가 발생했습니다. 로그인과 설정을 확인하세요.";
}

module.exports = {
  AgentsChatController,
  CHAT_STATE_KEY,
  restoreSnapshot,
  validateWebviewMessage,
};
