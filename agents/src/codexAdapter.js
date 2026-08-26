"use strict";

const { spawn: nodeSpawn } = require("node:child_process");
const { existsSync: nodeExistsSync } = require("node:fs");
const { join } = require("node:path");

const MAX_STDERR_LENGTH = 8_192;
const MODEL_REASONING_LEVELS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
};

function resolveBundledCodexPath({
  extensionPath,
  platform = process.platform,
  arch = process.arch,
  existsSync = nodeExistsSync,
}) {
  if (!extensionPath) {
    throw new TypeError("extensionPath is required");
  }

  const payloads = {
    "linux-x64": {
      packageName: "codex-linux-x64",
      target: "x86_64-unknown-linux-musl",
      executable: "codex",
    },
  };
  const payload = payloads[`${platform}-${arch}`];
  if (!payload) {
    throw new Error(`지원하지 않는 플랫폼입니다: ${platform}-${arch}`);
  }

  const executablePath = join(
    extensionPath,
    "node_modules",
    "@openai",
    payload.packageName,
    "vendor",
    payload.target,
    "bin",
    payload.executable,
  );
  if (!existsSync(executablePath)) {
    throw new Error("포함된 Codex CLI를 찾을 수 없습니다. 확장을 다시 설치하세요.");
  }
  return executablePath;
}

function buildExecArgs({
  prompt,
  cwd,
  providerSessionId = null,
  model = "gpt-5.5",
  reasoningEffort = "medium",
  fastMode = false,
  images = [],
}) {
  const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!normalizedPrompt) {
    throw new TypeError("메시지는 비어 있을 수 없습니다.");
  }
  if (!cwd) {
    throw new TypeError("cwd is required");
  }
  if (!Object.hasOwn(MODEL_REASONING_LEVELS, model)) {
    throw new TypeError("지원하지 않는 모델입니다.");
  }
  if (!MODEL_REASONING_LEVELS[model].includes(reasoningEffort)) {
    throw new TypeError("지원하지 않는 추론 수준입니다.");
  }
  const configuration = [
    "--model",
    model,
    "--config",
    `model_reasoning_effort="${reasoningEffort}"`,
  ];
  if (fastMode) {
    configuration.push("--config", 'service_tier="priority"');
  }
  const imageArgs = images.flatMap((imagePath) => ["--image", imagePath]);
  if (providerSessionId) {
    return [
      "exec",
      "resume",
      "--json",
      ...configuration,
      ...imageArgs,
      providerSessionId,
      normalizedPrompt,
    ];
  }
  return ["exec", "--json", ...configuration, ...imageArgs, "--cd", cwd, normalizedPrompt];
}

class JsonLinesParser {
  constructor({ onEvent, onMalformedLine }) {
    this.buffer = "";
    this.onEvent = onEvent;
    this.onMalformedLine = onMalformedLine;
  }

  push(chunk) {
    this.buffer += chunk.toString("utf8");
    this.#drain(false);
  }

  end() {
    this.#drain(true);
  }

  #drain(flush) {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = flush ? "" : lines.pop();
    if (flush && lines.at(-1) === "") {
      lines.pop();
    }
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.onMalformedLine(new Error("Codex JSONL 응답을 해석할 수 없습니다."));
        continue;
      }
      this.onEvent(event);
    }
  }
}

function normalizeCodexEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (
    event.type === "thread.started" &&
    typeof event.thread_id === "string"
  ) {
    return { type: "session", providerSessionId: event.thread_id };
  }
  if (
    event.type === "item.updated" &&
    event.item?.type === "agent_message" &&
    typeof event.delta === "string"
  ) {
    return { type: "assistant.delta", text: event.delta };
  }
  if (
    event.type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    return { type: "assistant.message", text: event.item.text };
  }
  if (event.type === "turn.started") {
    return { type: "progress", label: "응답 준비 중" };
  }
  if (event.type === "item.started" && typeof event.item?.type === "string") {
    return {
      type: "progress",
      label: progressLabel(event.item.type),
    };
  }
  if (event.type === "turn.completed") {
    return { type: "complete", usage: event.usage || null };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return {
      type: "error",
      message: "Codex 실행이 완료되지 않았습니다. 로그인과 설정을 확인하세요.",
    };
  }
  return null;
}

function progressLabel(itemType) {
  const labels = {
    command_execution: "명령 실행 중",
    file_change: "파일 변경 중",
    mcp_tool_call: "도구 호출 중",
    reasoning: "추론 중",
    web_search: "웹 검색 중",
    plan_update: "계획 갱신 중",
  };
  return labels[itemType] || "작업 진행 중";
}

class CodexRunner {
  constructor({
    executablePath,
    spawn = nodeSpawn,
    forceKillDelayMs = 2_000,
  }) {
    if (!executablePath) {
      throw new TypeError("executablePath is required");
    }
    this.executablePath = executablePath;
    this.spawn = spawn;
    this.forceKillDelayMs = forceKillDelayMs;
    this.running = new Map();
  }

  hasRunning(sessionId) {
    return this.running.has(sessionId);
  }

  run({
    sessionId,
    prompt,
    cwd,
    providerSessionId = null,
    model = "gpt-5.5",
    reasoningEffort = "medium",
    fastMode = false,
    images = [],
    onEvent,
  }) {
    if (this.running.has(sessionId)) {
      return Promise.reject(new Error("이 세션은 이미 실행 중입니다."));
    }
    const args = buildExecArgs({
      prompt,
      cwd,
      providerSessionId,
      model,
      reasoningEffort,
      fastMode,
      images,
    });
    let child;
    try {
      child = this.spawn(this.executablePath, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return Promise.reject(new Error("Codex CLI를 시작할 수 없습니다."));
    }

    const record = {
      child,
      cancelled: false,
      forceKillTimer: null,
      stderr: "",
      malformed: false,
    };
    this.running.set(sessionId, record);

    return new Promise((resolve, reject) => {
      let completed = false;
      let settled = false;
      const parser = new JsonLinesParser({
        onEvent: (providerEvent) => {
          const event = normalizeCodexEvent(providerEvent);
          if (!event) {
            return;
          }
          if (event.type === "complete") {
            completed = true;
          }
          onEvent(event);
        },
        onMalformedLine: () => {
          record.malformed = true;
        },
      });

      child.stdout.on("data", (chunk) => parser.push(chunk));
      child.stderr.on("data", (chunk) => {
        record.stderr = `${record.stderr}${chunk.toString("utf8")}`.slice(
          -MAX_STDERR_LENGTH,
        );
      });
      child.once("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        this.#finish(sessionId, record);
        reject(new Error("Codex CLI를 시작할 수 없습니다."));
      });
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        parser.end();
        this.#finish(sessionId, record);
        if (record.cancelled) {
          onEvent({ type: "cancelled" });
          resolve();
          return;
        }
        if (record.malformed) {
          reject(new Error("Codex JSONL 응답을 해석할 수 없습니다."));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `Codex 실행이 실패했습니다${signal ? ` (${signal})` : ""}. 로그인과 설정을 확인하세요.`,
            ),
          );
          return;
        }
        if (!completed) {
          onEvent({ type: "complete", usage: null });
        }
        resolve();
      });
    });
  }

  cancel(sessionId) {
    const record = this.running.get(sessionId);
    if (!record) {
      return false;
    }
    record.cancelled = true;
    record.child.kill("SIGTERM");
    record.forceKillTimer = setTimeout(() => {
      if (this.running.get(sessionId) === record) {
        record.child.kill("SIGKILL");
      }
    }, this.forceKillDelayMs);
    record.forceKillTimer.unref?.();
    return true;
  }

  dispose() {
    for (const sessionId of this.running.keys()) {
      this.cancel(sessionId);
    }
  }

  #finish(sessionId, record) {
    if (record.forceKillTimer) {
      clearTimeout(record.forceKillTimer);
    }
    if (this.running.get(sessionId) === record) {
      this.running.delete(sessionId);
    }
  }
}

module.exports = {
  CodexRunner,
  JsonLinesParser,
  MODEL_REASONING_LEVELS,
  buildExecArgs,
  normalizeCodexEvent,
  resolveBundledCodexPath,
};
