import { spawn } from "node:child_process";
import { lstat, open as openFile, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;
const MANAGED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ExecutionOptions {
  readonly model?: string;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly fast: boolean;
  readonly goalMode: boolean;
  readonly actor?: "main" | "human";
  readonly verifiedWorkRunId?: string;
}

export interface RunAcceptance {
  readonly agentId: string;
  readonly runId: string;
}

export interface RunStatus {
  readonly status: string;
}

export interface RunResult extends RunStatus {
  readonly text: string;
}

export interface RunUpdates {
  readonly cursor: number;
  readonly updates: readonly RunUpdate[];
}

export type RunUpdate =
  | { readonly kind: "status"; readonly text: string }
  | {
      readonly kind: "usage";
      readonly usedTokens: number;
      readonly contextWindowTokens: number;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly category: "command" | "file" | "tool";
      readonly phase: "started" | "completed" | "failed";
      readonly text: string;
      readonly title?: string;
      readonly diff?: string;
    };

export interface MainAgentSession {
  readonly agentId: string;
  readonly sessionId: string;
  readonly updatedAt?: string;
  readonly model?: string;
}

export interface ChildAgentSession {
  readonly agentId: string;
  readonly role: "work" | "verification";
  readonly status: string;
  readonly updatedAt?: string;
  readonly verifiedWorkRunId?: string;
}

export interface AgentRuntimeClient {
  submit(agentId: string, message: string, execution: ExecutionOptions): Promise<RunAcceptance>;
  send(agentId: string, message: string, execution: ExecutionOptions): Promise<RunAcceptance>;
  status(agentId: string, runId: string): Promise<RunStatus>;
  updates(agentId: string, runId: string, cursor: number): Promise<RunUpdates>;
  result(agentId: string, runId: string): Promise<RunResult>;
  cancel(agentId: string, runId: string): Promise<void>;
  listSessions(): Promise<readonly MainAgentSession[]>;
  listChildSessions(mainAgentId: string): Promise<readonly ChildAgentSession[]>;
}

export class AgentFactoryClient implements AgentRuntimeClient {
  public constructor(
    private readonly execPath: string,
    private readonly projectRoot: string,
    private readonly pythonCommand = "python3",
    private readonly codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")
  ) {}

  public async diagnose(): Promise<{ readonly available: true } | { readonly available: false; readonly diagnostic: string }> {
    try {
      const output = await runBoundedProcess(
        this.pythonCommand,
        [this.execPath, "--help"],
        5_000,
        64 * 1024
      );
      if (output.exitCode === 0) return { available: true };
      return {
        available: false,
        diagnostic: output.stderr.trim() || "Agent Factory exec.py를 실행할 수 없습니다."
      };
    } catch (error) {
      return {
        available: false,
        diagnostic: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async submit(agentId: string, message: string, execution: ExecutionOptions): Promise<RunAcceptance> {
    const document = await this.command([
      "submit",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--role",
      "main",
      "--message",
      message,
      ...executionArguments(execution)
    ]);
    return readAcceptance(document, agentId);
  }

  public async send(agentId: string, message: string, execution: ExecutionOptions): Promise<RunAcceptance> {
    const document = await this.command([
      "send",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--message",
      message,
      ...executionArguments(execution)
    ]);
    return readAcceptance(document, agentId);
  }

  public async status(agentId: string, runId: string): Promise<RunStatus> {
    const document = await this.command([
      "status",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--run-id",
      runId
    ]);
    return { status: readRunStatus(document) };
  }

  public async updates(agentId: string, runId: string, cursor: number): Promise<RunUpdates> {
    if (!MANAGED_ID.test(agentId) || !MANAGED_ID.test(runId) || !Number.isInteger(cursor) || cursor < 0) {
      throw new Error("Agent Factory 진행 이벤트 요청이 올바르지 않습니다.");
    }
    const path = resolve(
      this.projectRoot,
      ".agent-factory",
      "agent",
      agentId,
      "runs",
      runId,
      "events.jsonl"
    );
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_EVENTS_BYTES) {
        throw new Error("Agent Factory 이벤트 파일이 없거나 허용 크기를 초과했습니다.");
      }
      bytes = await readFile(path);
    } catch (error) {
      if (isMissingFile(error)) return { cursor, updates: [] };
      throw error;
    }
    if (bytes.length > MAX_EVENTS_BYTES) {
      throw new Error("Agent Factory 이벤트 파일이 허용 크기를 초과했습니다.");
    }
    const content = bytes.toString("utf8");
    const splitLines = content.split("\n");
    if (!content.endsWith("\n")) splitLines.pop();
    const lines = splitLines.filter((line) => line.trim().length > 0);
    const start = Math.min(cursor, lines.length);
    const updates: RunUpdate[] = [];
    const newLines = lines.slice(start);
    for (const line of newLines) {
      updates.push(...await progressUpdates(line, this.projectRoot));
    }
    if (newLines.some(isTurnCompletedLine)) {
      const usage = await this.readCurrentContextUsage(agentId, runId);
      if (usage) updates.push({ kind: "usage", ...usage });
    }
    return { cursor: lines.length, updates };
  }

  private async readCurrentContextUsage(
    agentId: string,
    runId: string
  ): Promise<{ readonly usedTokens: number; readonly contextWindowTokens: number } | undefined> {
    const statePath = resolve(this.projectRoot, ".agent-factory", "agent", agentId, "runs", runId, "state.json");
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.size > 256 * 1024) return undefined;
      const state = readRecordOrUndefined(JSON.parse(await readFile(statePath, "utf8")));
      const sessionId = typeof state?.sessionId === "string" && MANAGED_ID.test(state.sessionId)
        ? state.sessionId
        : undefined;
      if (!sessionId) return undefined;
      const rolloutPath = await findSessionRollout(join(this.codexHome, "sessions"), sessionId);
      return rolloutPath ? readLatestTokenCount(rolloutPath) : undefined;
    } catch {
      return undefined;
    }
  }

  public async result(agentId: string, runId: string): Promise<RunResult> {
    const document = await this.command([
      "result",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--run-id",
      runId
    ]);
    const status = readRunStatus(document);
    const run = readRecord(document.run, "result run");
    const resultPath = typeof run.resultPath === "string" ? run.resultPath : undefined;
    let text = "";
    if (resultPath) {
      try {
        text = await this.readManagedResult(resultPath, agentId, runId);
      } catch (error) {
        if (status !== "cancelled" && status !== "failed") throw error;
      }
    }
    return {
      status,
      text
    };
  }

  public async cancel(agentId: string, runId: string): Promise<void> {
    await this.command([
      "cancel",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--run-id",
      runId
    ]);
  }

  public async listSessions(): Promise<readonly MainAgentSession[]> {
    const document = await this.command(["list", "--project-root", this.projectRoot]);
    if (!Array.isArray(document.agents) || document.agents.length > 1_000) {
      throw new Error("Agent Factory 세션 목록 응답이 올바르지 않습니다.");
    }
    return document.agents.flatMap((value) => {
      const agent = readRecordOrUndefined(value);
      if (
        !agent ||
        agent.role !== "main" ||
        typeof agent.agentId !== "string" ||
        !MANAGED_ID.test(agent.agentId) ||
        typeof agent.sessionId !== "string" ||
        !agent.sessionId
      ) {
        return [];
      }
      return [{
        agentId: agent.agentId,
        sessionId: agent.sessionId,
        ...(typeof agent.updatedAt === "string" ? { updatedAt: agent.updatedAt } : {}),
        ...(typeof agent.model === "string" && agent.model ? { model: agent.model } : {})
      }];
    }).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  public async listChildSessions(mainAgentId: string): Promise<readonly ChildAgentSession[]> {
    if (!MANAGED_ID.test(mainAgentId)) {
      throw new Error("Main Agent 식별자가 올바르지 않습니다.");
    }
    const referenced = await this.discoverChildAgents(mainAgentId);
    if (referenced.size === 0) return [];
    const document = await this.command(["list", "--project-root", this.projectRoot]);
    if (!Array.isArray(document.agents) || document.agents.length > 1_000) {
      throw new Error("Agent Factory 세션 목록 응답이 올바르지 않습니다.");
    }
    const agents: ChildAgentSession[] = [];
    for (const value of document.agents) {
      const agent = readRecordOrUndefined(value);
      if (
        !agent ||
        typeof agent.agentId !== "string" ||
        !referenced.has(agent.agentId) ||
        (agent.role !== "work" && agent.role !== "verification")
      ) {
        continue;
      }
      const latest = await this.latestRunInfo(agent.agentId);
      agents.push({
        agentId: agent.agentId,
        role: agent.role,
        status: latest.status,
        ...(latest.verifiedWorkRunId ? { verifiedWorkRunId: latest.verifiedWorkRunId } : {}),
        ...(typeof agent.updatedAt === "string" ? { updatedAt: agent.updatedAt } : {})
      });
    }
    return agents.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  private async discoverChildAgents(mainAgentId: string): Promise<ReadonlySet<string>> {
    const runsDirectory = resolve(this.projectRoot, ".agent-factory", "agent", mainAgentId, "runs");
    const childIds = new Set<string>();
    let runs;
    try {
      runs = (await readdir(runsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && MANAGED_ID.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, 500);
    } catch (error) {
      if (isMissingFile(error)) return childIds;
      throw error;
    }
    for (const run of runs) {
      const eventsPath = resolve(runsDirectory, run.name, "events.jsonl");
      let content: string;
      try {
        const info = await lstat(eventsPath);
        if (!info.isFile() || info.size > MAX_EVENTS_BYTES) continue;
        content = await readFile(eventsPath, "utf8");
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      for (const line of content.split("\n")) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const item = readRecordOrUndefined(readRecordOrUndefined(event)?.item);
        if (item?.type !== "command_execution" || typeof item.command !== "string") continue;
        for (const childId of childAgentIdsFromCommand(item.command)) childIds.add(childId);
      }
    }
    return childIds;
  }

  private async latestRunInfo(agentId: string): Promise<{ readonly status: string; readonly verifiedWorkRunId?: string }> {
    const runsDirectory = resolve(this.projectRoot, ".agent-factory", "agent", agentId, "runs");
    try {
      const runs = (await readdir(runsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && MANAGED_ID.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const run of runs.slice(0, 100)) {
        const statePath = resolve(runsDirectory, run.name, "state.json");
        try {
          const info = await lstat(statePath);
          if (!info.isFile() || info.size > 256 * 1024) continue;
          const state = readRecordOrUndefined(JSON.parse(await readFile(statePath, "utf8")));
          if (typeof state?.status === "string" && state.status) {
            return {
              status: state.status,
              ...(typeof state.verifiedWorkRunId === "string" && MANAGED_ID.test(state.verifiedWorkRunId)
                ? { verifiedWorkRunId: state.verifiedWorkRunId }
                : {})
            };
          }
        } catch (error) {
          if (!isMissingFile(error)) continue;
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return { status: "unknown" };
  }

  private async command(arguments_: readonly string[]): Promise<Record<string, unknown>> {
    const output = await runBoundedProcess(
      this.pythonCommand,
      [this.execPath, ...arguments_],
      COMMAND_TIMEOUT_MS,
      MAX_PROCESS_OUTPUT_BYTES
    );
    let document: unknown;
    try {
      document = JSON.parse(output.stdout);
    } catch {
      throw new Error("Agent Factory 런타임이 올바른 JSON 응답을 반환하지 않았습니다.");
    }
    const record = readRecord(document, "runtime response");
    if (output.exitCode !== 0 || record.kind === "error") {
      const message = typeof record.message === "string" ? record.message : output.stderr.trim();
      throw new Error(message || `Agent Factory 런타임 명령이 종료 코드 ${output.exitCode}로 실패했습니다.`);
    }
    return record;
  }

  private async readManagedResult(path: string, agentId: string, runId: string): Promise<string> {
    const expectedDirectory = resolve(
      this.projectRoot,
      ".agent-factory",
      "agent",
      agentId,
      "runs",
      runId
    );
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(`${expectedDirectory}${sep}`)) {
      throw new Error("Agent Factory 런타임이 예상 범위 밖의 결과 경로를 반환했습니다.");
    }
    const info = await lstat(resolvedPath);
    if (!info.isFile() || info.size > MAX_RESULT_BYTES) {
      throw new Error("Agent Factory 결과 파일이 없거나 허용 크기를 초과했습니다.");
    }
    return readFile(resolvedPath, "utf8");
  }
}

function executionArguments(execution: ExecutionOptions): string[] {
  const arguments_: string[] = [];
  if (execution.model) arguments_.push("--model", execution.model);
  if (execution.reasoningEffort) arguments_.push("--reasoning-effort", execution.reasoningEffort);
  if (execution.fast) arguments_.push("--fast");
  if (execution.goalMode) arguments_.push("--goal-mode");
  if (execution.actor) arguments_.push("--actor", execution.actor);
  if (execution.verifiedWorkRunId) arguments_.push("--verified-work-run-id", execution.verifiedWorkRunId);
  return arguments_;
}

function childAgentIdsFromCommand(command: string): readonly string[] {
  const ids = new Set<string>();
  for (const flag of ["work-agent", "verification-agent"] as const) {
    const pattern = new RegExp(`--${flag}(?:=|\\s+)(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z0-9][A-Za-z0-9._-]{0,127}))`, "g");
    for (const match of command.matchAll(pattern)) {
      const candidate = match[1] ?? match[2] ?? match[3];
      if (candidate && MANAGED_ID.test(candidate)) ids.add(candidate);
    }
  }
  return [...ids];
}

async function progressUpdates(line: string, projectRoot: string): Promise<readonly RunUpdate[]> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  const event = readRecordOrUndefined(value);
  if (!event) return [];
  if (event.type === "thread.started") return [statusUpdate("Main Agent 연결됨")];
  if (event.type === "turn.started") return [statusUpdate("Main Agent가 요청을 분석 중")];
  if (event.type === "turn.completed") {
    return [statusUpdate("응답 정리 중")];
  }
  const item = readRecordOrUndefined(event.item);
  if (!item || (event.type !== "item.started" && event.type !== "item.completed")) return [];
  const completed = event.type === "item.completed";
  const itemId = typeof item.id === "string" && item.id ? item.id : undefined;
  if (item.type === "command_execution") {
    const detail = summarizeCommand(item.command) ?? "명령 내용 없음";
    const title = summarizeReadActivity(item.command);
    const failed = completed && typeof item.exit_code === "number" && item.exit_code !== 0;
    if (title === "실행 요청 읽기") {
      return [statusUpdate("Main Agent가 요청을 분석 중")];
    }
    return compactUpdates(
      itemId ? activityUpdate(itemId, "command", failed ? "failed" : completed ? "completed" : "started", detail, undefined, title) : undefined,
      statusUpdate(failed ? "명령 실패 확인 중" : completed ? "결과 분석 중" : "명령 실행 중")
    );
  }
  if (item.type === "file_change") {
    if (changesOnlyManagedRunFiles(item.changes, projectRoot)) {
      return [statusUpdate(completed ? "응답 기록 확인 중" : "응답 기록 중")];
    }
    const detail = summarizeChanges(item.changes, projectRoot) ?? "변경 파일 정보 없음";
    const diff = completed ? await readGitDiff(item.changes, projectRoot) : undefined;
    return compactUpdates(
      itemId ? activityUpdate(itemId, "file", completed ? "completed" : "started", detail, diff) : undefined,
      statusUpdate(completed ? "Git 변경 확인 중" : "Git 변경 중")
    );
  }
  if (item.type === "mcp_tool_call") {
    const detail = [item.server, item.tool].filter((value) => typeof value === "string").join("/") || "도구 정보 없음";
    const failed = completed && item.error !== null && item.error !== undefined;
    return compactUpdates(
      itemId ? activityUpdate(itemId, "tool", failed ? "failed" : completed ? "completed" : "started", detail) : undefined,
      statusUpdate(failed ? "연결 도구 실패 확인 중" : completed ? "결과 분석 중" : "연결 도구 실행 중")
    );
  }
  if (item.type === "reasoning") return [statusUpdate("추론 중")];
  if (item.type === "agent_message") return [statusUpdate("응답 정리 중")];
  return [];
}

function statusUpdate(text: string): RunUpdate {
  return { kind: "status", text };
}

function readTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isTurnCompletedLine(line: string): boolean {
  try {
    return readRecordOrUndefined(JSON.parse(line))?.type === "turn.completed";
  } catch {
    return false;
  }
}

async function findSessionRollout(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  const stack: Array<{ readonly path: string; readonly depth: number }> = [{ path: sessionsRoot, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += entries.length;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 3) {
        stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

async function readLatestTokenCount(
  rolloutPath: string
): Promise<{ readonly usedTokens: number; readonly contextWindowTokens: number } | undefined> {
  const handle = await openFile(rolloutPath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const length = Math.min(info.size, 2 * 1024 * 1024);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, info.size - length);
    for (const line of bytes.toString("utf8").split("\n").reverse()) {
      let record: Record<string, unknown> | undefined;
      try {
        record = readRecordOrUndefined(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = readRecordOrUndefined(record?.payload);
      const infoRecord = readRecordOrUndefined(payload?.info);
      const lastUsage = readRecordOrUndefined(infoRecord?.last_token_usage);
      const usedTokens = readTokenCount(lastUsage?.input_tokens);
      const contextWindowTokens = readTokenCount(infoRecord?.model_context_window);
      if (payload?.type === "token_count" && usedTokens !== undefined && contextWindowTokens !== undefined) {
        return { usedTokens, contextWindowTokens };
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function activityUpdate(
  id: string,
  category: "command" | "file" | "tool",
  phase: "started" | "completed" | "failed",
  text: string,
  diff?: string,
  title?: string
): RunUpdate {
  return {
    kind: "activity",
    id,
    category,
    phase,
    text,
    ...(title ? { title } : {}),
    ...(diff ? { diff } : {})
  };
}

function compactUpdates(...updates: readonly (RunUpdate | undefined)[]): readonly RunUpdate[] {
  return updates.filter((update): update is RunUpdate => Boolean(update));
}

function summarizeCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const shellPrefix = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+/;
  let summary = value.replace(/^\/usr\/bin\/env\s+/, "").replace(shellPrefix, "").trim();
  if ((summary.startsWith("\"") && summary.endsWith("\"")) || (summary.startsWith("'") && summary.endsWith("'"))) {
    summary = summary.slice(1, -1);
  }
  return summary.trim() || undefined;
}

function summarizeReadActivity(value: unknown): string | undefined {
  if (typeof value !== "string" || !/\b(?:cat|head|tail|sed|awk)\b/.test(value)) return undefined;
  const skills = new Set<string>();
  const cached = /plugins\/cache\/[^/\s'\"]+\/([^/\s'\"]+)\/[^/\s'\"]+\/skills\/([^/\s'\"]+)\/SKILL\.md/g;
  for (const match of value.matchAll(cached)) {
    const plugin = match[1];
    const skill = match[2];
    if (plugin && skill) skills.add(`${plugin}:${skill}`);
  }
  const system = /skills\/\.system\/([^/\s'\"]+)\/SKILL\.md/g;
  for (const match of value.matchAll(system)) {
    const skill = match[1];
    if (skill) skills.add(skill);
  }
  const generic = /skills\/([^/.\s'\"]+)\/SKILL\.md/g;
  for (const match of value.matchAll(generic)) {
    const name = match[1];
    if (name && ![...skills].some((skill) => skill === name || skill.endsWith(`:${name}`))) {
      skills.add(name);
    }
  }
  if (skills.size > 0) return `Skill 읽기 · ${[...skills].join(", ")}`;
  const runDocument = value.match(/\.agent-factory\/agent\/[^/\s'\"]+\/runs\/[^/\s'\"]+\/(request|result)\.md\b/);
  if (runDocument?.[1] === "request") return "실행 요청 읽기";
  if (runDocument?.[1] === "result") return "실행 결과 읽기";
  return undefined;
}

function summarizeChanges(value: unknown, projectRoot: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.flatMap((change) => {
    const record = readRecordOrUndefined(change);
    if (!record || typeof record.path !== "string") return [];
    const path = relative(projectRoot, record.path);
    return [path && !path.startsWith("..") ? path : record.path];
  });
  if (paths.length === 0) return undefined;
  const visible = paths.slice(0, 2).join(", ");
  return truncate(paths.length > 2 ? `${visible} 외 ${paths.length - 2}개` : visible, 140);
}

function changesOnlyManagedRunFiles(value: unknown, projectRoot: string): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((change) => {
    const record = readRecordOrUndefined(change);
    if (!record || typeof record.path !== "string") return false;
    const path = relative(projectRoot, record.path).split(sep).join("/");
    return path.startsWith(".agent-factory/agent/") && path.includes("/runs/");
  });
}

async function readGitDiff(value: unknown, projectRoot: string): Promise<string | undefined> {
  const paths = safeProjectChangePaths(value, projectRoot);
  if (paths.length === 0) return undefined;
  try {
    let output = await runBoundedProcess(
      "git",
      ["-C", projectRoot, "diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", ...paths],
      5_000,
      256 * 1024
    );
    if (output.exitCode !== 0) {
      output = await runBoundedProcess(
        "git",
        ["-C", projectRoot, "diff", "--no-ext-diff", "--no-color", "--unified=3", "--", ...paths],
        5_000,
        256 * 1024
      );
    }
    const parts = [output.exitCode === 0 ? output.stdout.trimEnd() : ""].filter(Boolean);
    const untracked = await runBoundedProcess(
      "git",
      ["-C", projectRoot, "ls-files", "--others", "--exclude-standard", "--", ...paths],
      5_000,
      64 * 1024
    );
    if (untracked.exitCode === 0) {
      for (const path of untracked.stdout.split("\n").filter(Boolean).slice(0, 20)) {
        const addition = await runBoundedProcess(
          "git",
          ["-C", projectRoot, "diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", path],
          5_000,
          64 * 1024
        );
        if ((addition.exitCode === 0 || addition.exitCode === 1) && addition.stdout) {
          parts.push(addition.stdout.trimEnd());
        }
      }
    }
    const diff = parts.join("\n").slice(0, 256 * 1024);
    return diff || undefined;
  } catch {
    return undefined;
  }
}

function safeProjectChangePaths(value: unknown, projectRoot: string): string[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  const root = resolve(projectRoot);
  const paths: string[] = [];
  for (const change of value) {
    const record = readRecordOrUndefined(change);
    if (!record || typeof record.path !== "string") return [];
    const target = resolve(root, record.path);
    if (!target.startsWith(`${root}${sep}`)) return [];
    const path = relative(root, target);
    if (!path || path.startsWith("..") || paths.includes(path)) continue;
    paths.push(path);
  }
  return paths;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function readRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runBoundedProcess(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number
): Promise<ProcessOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        finishWithError(new Error("Agent Factory 런타임 출력이 허용 크기를 초과했습니다."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finishWithError(
      new Error(`Agent Factory 런타임 프로세스를 시작하지 못했습니다: ${error.message}`)
    ));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    timer = setTimeout(
      () => finishWithError(new Error("Agent Factory 런타임 명령 시간이 초과되었습니다.")),
      timeoutMs
    );
  });
}

function readAcceptance(document: Record<string, unknown>, expectedAgentId: string): RunAcceptance {
  if (
    document.kind !== "ack" ||
    document.status !== "accepted" ||
    document.agentId !== expectedAgentId ||
    typeof document.runId !== "string"
  ) {
    throw new Error("Agent Factory 런타임이 올바른 실행 접수 응답을 반환하지 않았습니다.");
  }
  return { agentId: document.agentId, runId: document.runId };
}

function readRunStatus(document: Record<string, unknown>): string {
  const run = readRecord(document.run, "run status");
  if (typeof run.status !== "string") {
    throw new Error("Agent Factory 런타임 실행 상태가 올바르지 않습니다.");
  }
  return run.status;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Agent Factory ${label} 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}
