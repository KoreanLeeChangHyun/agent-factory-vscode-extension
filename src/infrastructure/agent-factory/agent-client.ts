import { codexConnectionEnvironment } from "./codex-connection-host";
import { ObservedRunCache } from "./observed-run-cache";
import { localize } from "../../common/localization";
import { submissionContext } from "./submission-context";
import { historyPresentation } from "./history-presentation";
import { parseWorkProfile, type WorkProfile } from "../../common/types/agent-models";
import { constants as fsConstants, type Dirent } from "node:fs";
import { spawn } from "node:child_process";
import { antigravityExecutable, claudeExecutable, codexExecutable, defaultPythonCommand, runtimeEnvironment } from "./process-environment";
import { sudoHandoffEnvironment } from "../vscode/sudo-broker";
import { pluginRuntimeEnvironment } from "./development-plugin";
import { lstat, mkdtemp, open as openFile, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AsyncCache } from "../../common/async-cache";
import { parseInterviewQuestion } from "../../common/types/business-mode";
import type { ActivityDetails as ProtocolActivityDetails, ActivityKind, ProjectTaskEntry } from "../../protocol/messages";
import {
  TASK_MODES,
  type AccountLimits, type ConversationWorktree, type ExecutionCapabilities, type ExecutionMode, type ExecutionOptions,
  type GoalAction, type NativeGoal, type SavedConversation, type TaskMode, type TaskStopTarget, type WorktreeOptions, type WorktreeRepository
} from "../../common/types/agent-runtime";

export {
  TASK_MODES,
  type AccountLimits, type ConversationWorktree, type ExecutionCapabilities, type ExecutionMode, type ExecutionOptions,
  type GoalAction, type NativeGoal, type SavedConversation, type TaskMode, type TaskStopTarget, type WorktreeOptions, type WorktreeRepository
};

/** Activity details inside a RunUpdate, whose own `kind` is the update discriminant. */
export type ActivityDetails = Omit<ProtocolActivityDetails, "kind"> & { readonly activityKind?: ActivityKind };

const MAX_PROCESS_OUTPUT_BYTES = Infinity;
const MAX_RESULT_BYTES = Infinity;
const MAX_EVENTS_BYTES = Infinity;
const COMMAND_TIMEOUT_MS = 0;
const CONTEXT_USAGE_REFRESH_INTERVAL_MS = 1_000;
const MANAGED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ContextUsage {
  readonly usedTokens: number;
  readonly contextWindowTokens: number;
  readonly weeklyUsedPercent?: number;
  readonly fiveHourUsedPercent?: number;
  /** Unix seconds when each account window next refills, as reported by the provider. */
  readonly weeklyResetsAt?: number;
  readonly fiveHourResetsAt?: number;
}

interface ContextUsageSnapshot {
  readonly checkedAt: number;
  readonly limitsSignature?: string;
  readonly rolloutPath?: string;
  readonly signature?: string;
  readonly nextLookupAt?: number;
  readonly usage?: ContextUsage;
}

export interface RunAcceptance {
  readonly preparationGuidance?: string;
  readonly agentId: string;
  readonly runId: string;
}

export interface RuntimeImageInput {
  readonly path: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface RunStatus {
  readonly taskMode?: TaskMode;
  readonly error?: { readonly code: string; readonly message: string };
  readonly goalError?: string;
  readonly status: string;
}

export interface RunResult extends RunStatus {
  readonly decisionKind?: "approval" | "clarification";
  readonly text: string;
}

export interface RunUpdates {
  readonly cursor: number;
  readonly updates: readonly RunUpdate[];
}

export type RunUpdate =
  | { readonly kind: "interviewQuestion"; readonly question: import("../../common/types/business-mode").InterviewQuestion }
  | { readonly kind: "commentary"; readonly text: string }
  /** Live preview of text still being generated; the complete commentary or final result supersedes it. */
  | { readonly kind: "delta"; readonly stream: "commentary" | "final"; readonly id: string; readonly text: string }
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "goal"; readonly goal: NativeGoal | null; readonly error?: string }
  | {
      readonly kind: "usage";
      readonly usedTokens: number;
      readonly contextWindowTokens: number;
      readonly weeklyUsedPercent?: number;
      readonly fiveHourUsedPercent?: number;
      readonly weeklyResetsAt?: number;
      readonly fiveHourResetsAt?: number;
    }
  | { readonly kind: "accountLimits"; readonly limits: AccountLimits }
  | ({
      readonly kind: "activity";
      readonly id: string;
      readonly category: "command" | "file" | "tool";
      readonly phase: "started" | "completed" | "failed";
      readonly text: string;
      readonly title?: string;
      readonly diff?: string;
      readonly output?: string;
    } & ActivityDetails);

export interface MainAgentSession {
  readonly agentId: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly updatedAt?: string;
  readonly model?: string;
}

export interface ConversationHistory {
  readonly conversationId?: string;
  readonly nextBefore?: string;
  readonly messages: readonly {
    readonly type: "user" | "assistant" | "interview";
    readonly id: string;
    readonly runId: string;
    readonly text: string;
    readonly question?: import("../../common/types/business-mode").InterviewQuestion;
    readonly phase?: "final";
    readonly submission?: import("../../protocol/messages").MessageSubmission;
  }[];
}

export interface ChildAgentSession {
  readonly taskBinding?: Record<string, unknown>;
  readonly parentRunId?: string;
  readonly taskMode?: TaskMode;
  readonly agentId: string;
  readonly runId?: string;
  readonly role: "work" | "verification";
  readonly status: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Recorded by the runtime at dispatch; absent on runs that predate the record. */
  readonly workProfile?: WorkProfile;
  readonly updatedAt?: string;
  /** When the runtime accepted this run; orders task cards, unlike `updatedAt` it never changes. */
  readonly dispatchedAt?: string;
  readonly verifiedWorkRunId?: string;
  /** Steps the agent's own to-do list reports done; absent when it keeps no list. */
  readonly planProgress?: PlanProgress;
  /** The first line of the agent's latest commentary. */
  readonly activity?: string;
}

export interface PlanProgress { readonly completed: number; readonly total: number; }

/** A recorded step count, only when it is a consistent completed/total pair. */
function parsePlanProgress(value: unknown): PlanProgress | undefined {
  const record = readRecordOrUndefined(value);
  const completed = record?.completed, total = record?.total;
  return Number.isInteger(completed) && Number.isInteger(total) && (total as number) > 0 && (total as number) <= 200 &&
    (completed as number) >= 0 && (completed as number) <= (total as number)
    ? { completed: completed as number, total: total as number } : undefined;
}

export type RevisionLimitDecision = "continue" | "stop";
/** Revisions one "계속" click authorizes after a loop stopped on its revision limit. */
export const REVISION_LIMIT_EXTENSION = 3;

export interface AgentRuntimeClient {
  worktreeRepositories?(): Promise<readonly WorktreeRepository[]>;
  worktree?(agentId: string, action: "status" | "create" | "merge", options?: WorktreeOptions): Promise<ConversationWorktree>;
  conversations?(agentId: string): Promise<readonly SavedConversation[]>;
  history?(agentId: string, options?: { before?: string; limit: number; conversationId?: string | null }): Promise<ConversationHistory>;
  capabilities(agentId?: string, model?: string): Promise<{ readonly submit: ExecutionCapabilities; readonly send: ExecutionCapabilities; readonly executionMode?: "read-only" | "workspace-write" | "danger-full-access" | "bypass" }>;
  submit(agentId: string, message: string, execution: ExecutionOptions, images?: readonly RuntimeImageInput[]): Promise<RunAcceptance>;
  send(agentId: string, message: string, execution: ExecutionOptions, images?: readonly RuntimeImageInput[]): Promise<RunAcceptance>;
  status(agentId: string, runId: string): Promise<RunStatus>;
  updates(agentId: string, runId: string, cursor: number): Promise<RunUpdates>;
  result(agentId: string, runId: string): Promise<RunResult>;
  cancel(agentId: string, runId: string): Promise<void>;
  activeRun(agentId: string): Promise<RunAcceptance | undefined>;
  pendingDecision?(agentId: string): Promise<{ readonly runId: string } | undefined>;
  goal(agentId: string, action: GoalAction): Promise<{ readonly goal?: NativeGoal | null; readonly accepted?: RunAcceptance; readonly error?: string }>;
  resetConversation(agentId: string): Promise<{ readonly conversationId: string; readonly startedAt: string }>;
  listSessions(): Promise<readonly MainAgentSession[]>;
  childRun?(mainAgentId: string, agentId: string, runId: string): Promise<ChildAgentSession | undefined>;
  listChildSessions(mainAgentId: string, runId?: string): Promise<readonly ChildAgentSession[]>;
  stopTask?(mainAgentId: string, target: TaskStopTarget): Promise<Record<string, unknown> | undefined>;
  closeWorkflow?(mainAgentId: string, workAgentId: string, loopId: string): Promise<Record<string, unknown>>;
  decideRevisionLimit?(mainAgentId: string, workAgentId: string, loopId: string, decision: RevisionLimitDecision): Promise<Record<string, unknown>>;
  advanceWorkflows?(mainAgentId: string, agents: readonly ChildAgentSession[], drive?: boolean): Promise<readonly Record<string, unknown>[]>;
  listProjectTasks?(): Promise<readonly ProjectTaskEntry[]>;
}

export class AgentFactoryClient implements AgentRuntimeClient {
  private readonly worktreeAgents = new Set<string>();
  private readonly capabilityCache = new AsyncCache<Awaited<ReturnType<AgentRuntimeClient["capabilities"]>>>(30_000);
  private readonly statusSnapshots = new Map<string, { signature: string; observedAt: number; value: RunStatus }>();
  private readonly statusCache = new AsyncCache<RunStatus>(0, 64);
  private readonly agentListCache = new AsyncCache<Record<string, unknown>>(1_000, 1);
  private readonly childSessionCache = new AsyncCache<readonly ChildAgentSession[]>(0, 64);
  private readonly workflowRefreshCache = new AsyncCache<readonly Record<string, unknown>[]>(0, 32);
  private readonly projectTaskCache = new AsyncCache<readonly ProjectTaskEntry[]>(2_000, 1);
  private readonly contextUsageSnapshots = new Map<string, ContextUsageSnapshot>();
  private readonly observedChildRuns = new ObservedRunCache<ReadonlyMap<string, ChildAgentReference>>(() => this.now());
  private readonly childEventSnapshots = new Map<string, { readonly signature: string; readonly references: readonly ChildAgentReference[] }>();
  private readonly directorySnapshots = new Map<string, { signature: string; entries: Dirent[]; checkedAt: number }>();
  private directorySnapshotEntries = 0;
  private readonly runStateSnapshots = new Map<string, { signature: string; value: Record<string, unknown>; bytes: number }>();
  private runStateSnapshotBytes = 0;
  private readonly workflowSnapshots = new Map<string, { readonly signature: string; readonly observedAt: number; readonly state: Record<string, unknown>; readonly snapshot: Record<string, unknown> }>();
  private locationPromise?: Promise<{ home: string; projectId: string; agentsRoot: string }>;

  private async location(): Promise<{ home: string; projectId: string; agentsRoot: string }> {
    if (!this.locationPromise) {
      this.locationPromise = this.loadLocation().catch((error) => {
        this.locationPromise = undefined;
        this.eventSnapshots.clear();
        this.contextUsageSnapshots.clear();
        throw error;
      });
    }
    return this.locationPromise;
  }

  private async loadLocation(): Promise<{ home: string; projectId: string; agentsRoot: string }> {
    // Runs on the workspace extension host, including SSH/container hosts.
    const value = await this.command(["init", "--project-root", this.projectRoot]);
    if (value.kind !== "runtime-location" || value.schemaVersion !== 1 || value.registered !== true
        || typeof value.home !== "string" || !isAbsolute(value.home)
        || typeof value.projectId !== "string" || !/^project-[a-f0-9]{32}$/.test(value.projectId)
        || value.projectRoot !== await realProjectRoot(this.projectRoot)
        || value.runtimeRoot !== join(value.home, "projects", value.projectId)
        || value.agentsRoot !== join(value.home, "projects", value.projectId, "agents")) {
      throw new Error(localize("ui.invalid.agent.factory.storage.location.response"));
    }
    const expectedHome = resolve(process.env.AGENT_FACTORY_HOME ?? join(homedir(), ".agent-factory"));
    if (value.home !== expectedHome) throw new Error(localize("ui.agent.factory.storage.home.binding.does.not.match"));
    await checkManagedComponents(value.agentsRoot as string);
    this.eventSnapshots.clear();
    this.contextUsageSnapshots.clear();
    return { home: value.home, projectId: value.projectId, agentsRoot: value.agentsRoot as string };
  }

  private async managedPath(agentId: string, ...members: string[]): Promise<string> {
    if (!MANAGED_ID.test(agentId) || members.some((member) => !MANAGED_ID.test(member))) {
      throw new Error(localize("ui.invalid.agent.factory.managed.path"));
    }
    const location = await this.location();
    const path = join(location.agentsRoot, agentId, ...members);
    await checkManagedComponents(path);
    return path;
  }

  private readonly eventSnapshots = new Map<string, { readonly signature: string; readonly lines: readonly string[]; readonly bytes: number; readonly offset: number; readonly identity: string }>();

  public async capabilities(agentId?: string, model?: string): ReturnType<AgentRuntimeClient["capabilities"]> {
    return this.capabilityCache.get(JSON.stringify([this.execPath, agentId ?? "", model ?? "", codexExecutable()]), () => this.readCapabilities(agentId, model));
  }

  private async readCapabilities(agentId?: string, model?: string): ReturnType<AgentRuntimeClient["capabilities"]> {
    const document = await this.command(["capabilities", "--project-root", this.projectRoot, ...(agentId ? ["--agent", agentId] : []), ...(model ? ["--model", model] : [])]);
    if (document.kind !== "execution-capabilities" || document.schemaVersion !== "0.1.0") {
      throw new Error(localize("ui.update.to.an.agent.factory.runtime.that.provides.native.capability.information"));
    }
    const readCapabilities = (value: unknown): ExecutionCapabilities => {
      const record = readRecord(value, "execution capabilities");
      for (const key of ["model", "reasoning", "fast", "goal"]) {
        if (typeof record[key] !== "boolean") throw new Error(localize("ui.invalid.codex.capability.response.format"));
      }
      if (record.sessionProvider !== undefined && !["codex", "claude", "antigravity"].includes(String(record.sessionProvider))) {
        throw new Error(localize("ui.invalid.codex.capability.response.format"));
      }
      return {
        ...record,
        images: record.images === true,
        taskModes: Array.isArray(record.taskModes) ? record.taskModes.filter((mode): mode is TaskMode => TASK_MODES.includes(mode as TaskMode)) : [],
        ...(typeof document.diagnostic === "string" ? { diagnostic: document.diagnostic } : {})
      } as unknown as ExecutionCapabilities;
    };
    return {
      submit: readCapabilities(document.submit), send: readCapabilities(document.send),
      ...(document.executionMode === "read-only" || document.executionMode === "workspace-write" || document.executionMode === "danger-full-access" || document.executionMode === "bypass"
        ? { executionMode: document.executionMode } : {})
    };
  }

  public async goal(agentId: string, action: GoalAction): Promise<{ goal?: NativeGoal | null; accepted?: RunAcceptance; error?: string }> {
    const document = await this.command(["goal", "--project-root", this.projectRoot, "--agent", agentId, action]);
    if (document.kind === "ack") {
      if (action === "get") throw new Error(localize("ui.agent.factory.goal.control.accepted.an.unexpected.run"));
      return { accepted: readAcceptance(document, agentId) };
    }
    if (document.kind === "goal-control") return {};
    return { goal: readNativeGoal(document.goal), ...(typeof document.error === "string" ? { error: document.error } : {}) };
  }

  public async worktreeRepositories(): Promise<readonly WorktreeRepository[]> {
    const value = await this.command(["worktree", "--project-root", this.projectRoot, "--agent", "main-discovery", "repositories"]);
    if (value.kind !== "worktree-repositories" || value.schemaVersion !== 1 || !Array.isArray(value.repositories) ||
      !value.repositories.every((r: any) => typeof r.path === "string" && isAbsolute(r.path) && Array.isArray(r.branches) &&
        r.branches.every((b: unknown) => typeof b === "string") && (r.defaultBranch === null || typeof r.defaultBranch === "string"))) throw new Error(localize("worktree.invalid"));
    return value.repositories as unknown as readonly WorktreeRepository[];
  }

  public async worktree(agentId: string, action: "status" | "create" | "merge", options: WorktreeOptions = {}): Promise<ConversationWorktree> {
    const value = await this.command(["worktree", "--project-root", this.projectRoot, "--agent", agentId, action,
      ...(options.changes ? ["--changes", options.changes] : []),
      ...(options.path ? ["--path", options.path] : []),
      ...(["repository", "name", "branch", "base", "target"] as const).flatMap(key => options[key] ? [`--${key}`, options[key]!] : []),
      ...(options.model ? ["--model", options.model] : []),
      ...executionPolicyArguments(options.executionMode)]);
    if (value.kind !== "worktree" || value.schemaVersion !== 1 || value.agentId !== agentId ||
        typeof value.workspaceRoot !== "string" || typeof value.workingDirectory !== "string" ||
        !isAbsolute(value.workingDirectory) || typeof value.available !== "boolean" || typeof value.dirty !== "boolean" ||
        !(value.branch === null || typeof value.branch === "string") || !Array.isArray(value.conflicts) ||
        !value.conflicts.every(item => typeof item === "string")) throw new Error(localize("worktree.invalid"));
    const tree = readRecordOrUndefined(value.worktree);
    if (value.worktree !== null && (!tree || !["creating", "active", "merging", "conflict", "merged"].includes(String(tree.phase)) ||
        !["id", "path", "branch", "targetBranch"].every(key => typeof tree[key] === "string"))) throw new Error(localize("worktree.invalid"));
    return value as unknown as ConversationWorktree;
  }

  private async workingDirectory(agentId: string): Promise<string> {
    const path = await this.managedPath(agentId, "session.json");
    let session: Record<string, unknown>;
    try { session = readRecord(JSON.parse((await readManagedBytes(path, MAX_RESULT_BYTES)).toString("utf8")), "session"); }
    catch (error) { if (isMissingFile(error)) return this.projectRoot; throw error; }
    const tree = readRecordOrUndefined(session.worktree);
    return tree && tree.phase !== "merged" && typeof tree.path === "string" ? tree.path : this.projectRoot;
  }

  public async resetConversation(agentId: string): Promise<{ conversationId: string; startedAt: string }> {
    const document = await this.command([
      "reset-conversation", "--project-root", this.projectRoot, "--agent", agentId
    ]);
    if (document.kind !== "conversation-reset" || document.agentId !== agentId ||
        typeof document.conversationId !== "string" || !MANAGED_ID.test(document.conversationId) ||
        typeof document.startedAt !== "string" || document.historyRetained !== true) {
      throw new Error(localize("ui.the.agent.factory.runtime.returned.an.invalid.conversation.reset.response"));
    }
    this.contextUsageSnapshots.clear();
    this.eventSnapshots.clear();
    return { conversationId: document.conversationId, startedAt: document.startedAt };
  }

  private async checkedExecution(command: "submit" | "send", execution: ExecutionOptions, agentId?: string, hasImages = false): Promise<string[]> {
    const supported = (await this.capabilities(agentId, execution.model))[command];
    if (agentId && supported.worktrees === true) this.worktreeAgents.add(agentId);
    else if (agentId) this.worktreeAgents.delete(agentId);
    if (execution.taskMode && !supported.taskModes?.includes(execution.taskMode)) {
      throw new Error(localize("ui.update.the.agent.factory.plugin.and.codex.to.versions.that.support.the.selected.task.mode"));
    }
    if (hasImages && supported.images !== true) {
      throw new Error(
        localize("ui.the.current.agent.factory.runtime.has.an.incompatible.0.image.transfer.contract", command) +
        localize("ui.install.or.update.the.agent.factory.plugin.to.a.version.compatible.with.this.extension.then") +
        localize("ui.reload.the.vs.code.extension.host.and.try.attaching.the.images.again")
      );
    }
    const unsupported = [
      execution.model && !supported.model ? localize("host.setting.model") : "",
      execution.reasoningEffort && !supported.reasoning ? localize("host.setting.reasoning") : "",
      execution.fast && !supported.fast ? localize("ui.fast") : "",
      execution.goalMode && !supported.goal ? localize("ui.goal") : ""
    ].filter(Boolean);
    if (unsupported.length) throw new Error(localize("ui.the.current.runtime.0.command.does.not.support.these.settings.1", command, unsupported.join(", ")));
    return executionArguments(execution);
  }
  public constructor(
    private execPath: string,
    private readonly projectRoot: string,
    private readonly pythonCommand = defaultPythonCommand(),
    private readonly codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    private readonly rediscoverExecPath?: () => Promise<string>,
    private readonly now = Date.now,
    private readonly developmentRoot?: string,
    private readonly afterChildEventRead?: (path: string) => Promise<void>
  ) {}

  public async diagnose(): Promise<{ readonly available: true } | { readonly available: false; readonly diagnostic: string }> {
    try {
      const output = await this.runRuntimeProcess(["--help"], 5_000, 64 * 1024);
      if (output.exitCode === 0) {
        await this.location();
        return { available: true };
      }
      return {
        available: false,
        diagnostic: output.stderr.trim() || localize("ui.unable.to.run.agent.factory.exec.py")
      };
    } catch (error) {
      return {
        available: false,
        diagnostic: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async submit(agentId: string, message: string, execution: ExecutionOptions, images: readonly RuntimeImageInput[] = []): Promise<RunAcceptance> {
    const { document, preparationGuidance } = await this.inputCommand([
      "submit",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--role",
      "main",
      ...executionPolicyArguments(execution.executionMode),
      ...await this.checkedExecution("submit", execution, undefined, images.length > 0)
    ], message, images);
    return { ...readAcceptance(document, agentId), ...(preparationGuidance ? { preparationGuidance } : {}) };
  }

  public async send(agentId: string, message: string, execution: ExecutionOptions, images: readonly RuntimeImageInput[] = []): Promise<RunAcceptance> {
    const { document, preparationGuidance } = await this.inputCommand([
      "send",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      ...executionPolicyArguments(execution.executionMode),
      ...await this.checkedExecution("send", execution, agentId, images.length > 0)
    ], message, images);
    return { ...readAcceptance(document, agentId), ...(preparationGuidance ? { preparationGuidance } : {}) };
  }

  private async inputCommand(arguments_: string[], message: string, images: readonly RuntimeImageInput[]): Promise<{ document: Record<string, unknown>; preparationGuidance?: string }> {
    let preparationGuidance: string | undefined;
    const modeIndex = arguments_.indexOf("--task-mode");
    if (modeIndex >= 0 && arguments_[modeIndex + 1] !== "direct") {
      const agentIndex = arguments_.indexOf("--agent");
      const agent = arguments_[agentIndex + 1]!;
      const directory = arguments_[0] === "send" && this.worktreeAgents.has(agent) ? await this.workingDirectory(agent) : this.projectRoot;
      preparationGuidance = await submissionContext(directory, this.execPath);
    }
    const helper = sudoHandoffEnvironment().AGENT_FACTORY_SUDO_HELPER;
    const sudoGuidance = helper ? `
[Agent Factory administrator command handoff]
When a command needs sudo and the Human has requested it, use python3 ${JSON.stringify(helper)} -- <executable> <arguments...>. This opens a protected password form in the current Main chat. Pass exact argument tokens, never a shell command string. Wait for the command result before reporting completion. Never ask for the password in a normal chat message.
` : "";
    preparationGuidance = (preparationGuidance ?? "") + sudoGuidance;
    return { document: await this.rawInputCommand(arguments_, message + preparationGuidance, images), preparationGuidance };
  }

  private async rawInputCommand(arguments_: string[], message: string, images: readonly RuntimeImageInput[]): Promise<Record<string, unknown>> {
    if (images.length === 0 && Buffer.byteLength(message, "utf8") <= 64 * 1024) return this.command([...arguments_, "--message", message]);
    if (images.length > 8) throw new Error(localize("ui.you.can.attach.up.to.8.images"));
    const directory = await mkdtemp(join(tmpdir(), "agent-factory-input-"));
    try {
      if (images.length === 0) {
        const requestPath = join(directory, "request.md");
        await writeFile(requestPath, message, { mode: 0o600, flag: "wx" });
        return await this.command([...arguments_, "--request-file", requestPath]);
      }
      const contractImages: { path: string; mediaType: string }[] = [];
      for (const [index, image] of images.entries()) {
        const suffix = imageSuffix(image.mediaType);
        const source = await openFile(image.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let content: Buffer;
        try {
          const before = await source.stat();
          if (!before.isFile() || before.size < 1) throw new Error(localize("ui.image.file.size.is.outside.the.allowed.range"));
          content = await source.readFile();
          const after = await source.stat();
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(localize("ui.the.image.file.changed.while.being.read"));
        } finally { await source.close(); }

        const name = `${String(index).padStart(2, "0")}${suffix}`;
        await writeFile(join(directory, name), content, { mode: 0o600, flag: "wx" });
        contractImages.push({ path: name, mediaType: image.mediaType });
      }
      const contractPath = join(directory, "input.json");
      await writeFile(contractPath, JSON.stringify({ schemaVersion: "0.1.0", kind: "agent-input", message, images: contractImages }), { mode: 0o600, flag: "wx" });
      return await this.command([...arguments_, "--input-file", contractPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  public async status(agentId: string, runId: string): Promise<RunStatus> {
    return this.statusCache.get(JSON.stringify([agentId, runId]), () => this.readStatus(agentId, runId));
  }

  private async readStatus(agentId: string, runId: string): Promise<RunStatus> {
    const key = JSON.stringify([agentId, runId]);
    const path = await this.managedPath(agentId, "runs", runId, "state.json");
    const signatureOf = async () => {
      try { const info = await lstat(path); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
      catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    };
    const signature = await signatureOf();
    const cached = this.statusSnapshots.get(key);
    // Refresh active liveness at least once per second even without state writes.
    if (signature && cached?.signature === signature && Date.now() - cached.observedAt < 1000) return cached.value;
    const document = await this.command([
      "status",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      "--run-id",
      runId
    ]);
    const run = readRecord(document.run, "status run");
    const value = { status: readRunStatus(document), ...runDiagnostics(run),
      ...(TASK_MODES.includes(run.taskMode as TaskMode) ? { taskMode: run.taskMode as TaskMode } : {}) };
    if (signature && await signatureOf() === signature) {
      this.statusSnapshots.delete(key);
      this.statusSnapshots.set(key, { signature, observedAt: Date.now(), value });
      while (this.statusSnapshots.size > 64) this.statusSnapshots.delete(this.statusSnapshots.keys().next().value!);
    } else this.statusSnapshots.delete(key);
    return value;
  }

  public async activeRun(agentId: string): Promise<RunAcceptance | undefined> {
    const path = await this.managedPath(agentId, "runs");
    let entries;
    try { entries = await this.managedDirectoryEntries(path); }
    catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    const active = new Set(["accepted", "queued", "starting", "running", "verifying", "cancelling"]);
    for (const entry of entries.filter(entry => entry.isDirectory() && MANAGED_ID.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name))) {
      const statePath = await this.managedPath(agentId, "runs", entry.name, "state.json");
      let state: Record<string, unknown> | undefined;
      try { state = await this.cachedRunState(statePath); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      if (state?.agentId === agentId && state.runId === entry.name && typeof state.status === "string" && active.has(state.status)) {
        return { agentId, runId: entry.name };
      }
    }
    return undefined;
  }

  public async pendingDecision(agentId: string): Promise<{ readonly runId: string } | undefined> {
    const path = await this.managedPath(agentId, "runs");
    let entries;
    try { entries = await this.managedDirectoryEntries(path); }
    catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    let latest: { readonly key: string; readonly runId: string; readonly status: string } | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory() || !MANAGED_ID.test(entry.name)) continue;
      const statePath = await this.managedPath(agentId, "runs", entry.name, "state.json");
      let state: Record<string, unknown> | undefined;
      try { state = await this.cachedRunState(statePath); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      if (state?.agentId !== agentId || state.runId !== entry.name || typeof state.status !== "string") continue;
      const key = typeof state.acceptedAt === "string" ? state.acceptedAt : entry.name;
      if (!latest || key > latest.key) latest = { key, runId: entry.name, status: state.status };
    }
    return latest?.status === "needs-human-decision" ? { runId: latest.runId } : undefined;
  }

  public async conversations(agentId: string): Promise<readonly SavedConversation[]> {
    const sessionPath = await this.managedPath(agentId, "session.json");
    const session = readRecord(JSON.parse((await readManagedBytes(sessionPath, 256 * 1024)).toString("utf8")), "history session");
    if (session.agentId !== agentId) throw new Error("Invalid conversation history binding.");
    const current = session.conversationId ?? null;
    const groups = new Map<string | null, SavedConversation>();
    const runsPath = await this.managedPath(agentId, "runs");
    const entries = await this.managedDirectoryEntries(runsPath).catch(error => {
      if (isMissingFile(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !MANAGED_ID.test(entry.name)) continue;
      const path = await this.managedPath(agentId, "runs", entry.name, "state.json");
      let state: Record<string, unknown>;
      try { state = readRecord(JSON.parse((await readManagedBytes(path, 256 * 1024)).toString("utf8")), "history run"); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      if (state.agentId !== agentId || state.runId !== entry.name) throw new Error("Invalid conversation history run binding.");
      const id = typeof state.conversationId === "string" ? state.conversationId : null;
      if (id === current || (id !== null && !MANAGED_ID.test(id))) continue;
      if (!["completed", "failed", "cancelled", "needs-human-decision"].includes(String(state.status))) continue;
      const startedAt = typeof state.acceptedAt === "string" ? state.acceptedAt : entry.name;
      const previous = groups.get(id);
      groups.set(id, { conversationId: id, startedAt: previous && previous.startedAt < startedAt ? previous.startedAt : startedAt, runCount: (previous?.runCount ?? 0) + 1 });
    }
    return [...groups.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public async history(agentId: string, options?: { before?: string; limit: number; conversationId?: string | null }): Promise<ConversationHistory> {
    if (options && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
        (options.before !== undefined && !MANAGED_ID.test(options.before)))) throw new Error("Invalid history page");
    if (options?.conversationId != null && !MANAGED_ID.test(options.conversationId)) throw new Error("Invalid conversation ID");
    const sessionPath = await this.managedPath(agentId, "session.json");
    const readSession = async () => readRecord(JSON.parse((await readManagedBytes(sessionPath, 256 * 1024)).toString("utf8")), "history session");
    const session = await readSession();
    if (session.agentId !== agentId) throw new Error("Invalid conversation history binding.");
    const currentConversationId = typeof session.conversationId === "string" ? session.conversationId : undefined;
    const conversationId = options?.conversationId !== undefined ? options.conversationId ?? undefined : currentConversationId;
    const runsPath = await this.managedPath(agentId, "runs");
    const entries = await this.managedDirectoryEntries(runsPath).catch(error => {
      if (isMissingFile(error)) return [];
      throw error;
    });
    const messages: ConversationHistory["messages"][number][] = [];
    const ordered = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && MANAGED_ID.test(entry.name) &&
      (!options?.before || entry.name < options.before)).sort((a, b) => a.name.localeCompare(b.name));
    // Archived pagination counts only runs from the selected conversation.
    const selected = [];
    if (options?.conversationId !== undefined) {
      for (const entry of ordered) {
        const path = await this.managedPath(agentId, "runs", entry.name, "state.json");
        let state: Record<string, unknown>;
        try { state = readRecord(JSON.parse((await readManagedBytes(path, 256 * 1024)).toString("utf8")), "history run"); }
        catch (error) { if (isMissingFile(error)) continue; throw error; }
        if (state.agentId !== agentId || state.runId !== entry.name) throw new Error("Invalid conversation history run binding.");
        if ((state.conversationId ?? undefined) === conversationId && ["completed", "failed", "cancelled", "needs-human-decision"].includes(String(state.status))) selected.push(entry);
      }
    } else selected.push(...ordered);
    const page = options ? selected.slice(-options.limit) : selected;
    const nextBefore = options && page.length < selected.length ? page[0]?.name : undefined;
    for (const entry of page) {
      const statePath = await this.managedPath(agentId, "runs", entry.name, "state.json");
      let state: Record<string, unknown>;
      try { state = readRecord(JSON.parse((await readManagedBytes(statePath, 256 * 1024)).toString("utf8")), "history run"); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      if (state.agentId !== agentId || state.runId !== entry.name) throw new Error("Invalid conversation history run binding.");
      if ((state.conversationId ?? undefined) !== conversationId) continue;
      // The controller replays active-run events separately after history is restored.
      if (!["completed", "failed", "cancelled", "needs-human-decision"].includes(String(state.status))) continue;
      const requestPath = await this.managedPath(agentId, "runs", entry.name, "request.md");
      const request = (await readManagedBytes(requestPath, 8 * 1024 * 1024)).toString("utf8");

      const taskMode = TASK_MODES.includes(state.taskMode as TaskMode) ? state.taskMode as TaskMode : "direct";
      const options = readRecordOrUndefined(state.executionOptions);
      messages.push({ type: "user", id: `history-user-${entry.name}`, runId: entry.name,
        ...historyPresentation(request, taskMode, options?.goalMode === true) });
      if (["completed", "failed", "cancelled", "needs-human-decision"].includes(String(state.status))) {
        const eventsPath = await this.managedPath(agentId, "runs", entry.name, "events.jsonl");
        try {
          const rawEvents = (await readManagedBytes(eventsPath, MAX_EVENTS_BYTES)).toString("utf8");
          for (const [index, line] of rawEvents.split("\n").entries()) {
            if (!line.trim()) continue;
            const event = readRecordOrUndefined(JSON.parse(line));
            const question = event?.type === "interview.question" ? parseInterviewQuestion(event.question) : undefined;
            if (question) messages.push({ type: "interview", id: `history-interview-${entry.name}-${index}`,
              runId: entry.name, text: question.text, question });
          }
        } catch (error) { if (!isMissingFile(error)) throw error; }
        const resultPath = await this.managedPath(agentId, "runs", entry.name, "result.md");
        let response = "";
        try { response = await this.readManagedResult(resultPath, agentId, entry.name); }
        catch (error) { if (!isMissingFile(error)) throw error; }

        if (response) messages.push({ type: "assistant", id: `history-assistant-${entry.name}`, runId: entry.name, text: response, phase: "final" });
      }
    }
    if (((await readSession()).conversationId ?? undefined) !== currentConversationId) {
      throw new Error("The conversation changed while history was loading. Reopen the conversation.");
    }
    return { conversationId, messages, ...(nextBefore ? { nextBefore } : {}) };
  }

  public async updates(agentId: string, runId: string, cursor: number): Promise<RunUpdates> {
    if (!MANAGED_ID.test(agentId) || !MANAGED_ID.test(runId) || !Number.isInteger(cursor) || cursor < 0) {
      throw new Error(localize("ui.invalid.agent.factory.progress.event.request"));
    }
    const path = await this.managedPath(agentId, "runs", runId, "events.jsonl");
    let lines: readonly string[];
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_EVENTS_BYTES) {
        throw new Error(localize("ui.the.agent.factory.event.file.is.missing.or.exceeds.the.size.limit"));
      }
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.eventSnapshots.get(path);
      if (cached?.signature === signature) {
        this.eventSnapshots.delete(path);
        this.eventSnapshots.set(path, cached);
        lines = cached.lines;
      } else {
        // Runtime event logs are append-only. Re-read the unfinished byte tail so
        // split UTF-8 characters are decoded only after their newline arrives.
        const identity = `${info.dev}:${info.ino}`;
        const incremental = cached && cursor > 0 && cursor >= cached.lines.length
          && cached.identity === identity && info.size > cached.bytes;
        const offset = incremental ? cached.offset : 0;
        const bytes = await readManagedBytes(path, MAX_EVENTS_BYTES, offset, identity);
        const end = bytes.lastIndexOf(10) + 1;
        const parsed = bytes.subarray(0, end).toString("utf8").split("\n").filter(line => line.trim().length > 0);
        lines = incremental ? [...cached.lines, ...parsed] : parsed;
        // A changed read must never be cached under a newer file signature.
        const after = await lstat(path);
        const observed = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
        this.eventSnapshots.delete(path);
        if (observed === signature) this.eventSnapshots.set(path, { signature, lines, bytes: info.size, offset: offset + end, identity });
        let retained = [...this.eventSnapshots.values()].reduce((sum, item) => sum + item.bytes, 0);
        while (this.eventSnapshots.size > 16 || retained > 16 * 1024 * 1024) {
          const oldest = this.eventSnapshots.keys().next().value!;
          retained -= this.eventSnapshots.get(oldest)!.bytes;
          this.eventSnapshots.delete(oldest);
        }
      }
    } catch (error) {
      if (isMissingFile(error)) {
        this.eventSnapshots.clear();
        return { cursor, updates: [] };
      }
      throw error;
    }
    const start = Math.min(cursor, lines.length);
    const updates: RunUpdate[] = [];
    const newLines = lines.slice(start);
    let runWorkingDirectory: unknown;
    if (newLines.length) {
      try { runWorkingDirectory = (await this.cachedRunState(join(dirname(path), "state.json")))?.workingDirectory; }
      catch (error) { if (!isMissingFile(error)) throw error; }
    }
    for (const line of newLines) {
      updates.push(...await progressUpdates(line, typeof runWorkingDirectory === "string" ? runWorkingDirectory : this.projectRoot, join(dirname(path), "result.md")));
    }
    const { usage, limits } = await this.readContextUsageUpdate(agentId, runId, newLines.some(isTurnCompletedLine));
    if (usage) updates.push({ kind: "usage", ...usage });
    if (limits) updates.push({ kind: "accountLimits", limits });
    return { cursor: lines.length, updates };
  }

  private async readContextUsageUpdate(
    agentId: string,
    runId: string,
    force: boolean
  ): Promise<{ readonly usage?: ContextUsage; readonly limits?: AccountLimits }> {
    const key = `${agentId}/${runId}`;
    const previous = this.contextUsageSnapshots.get(key);
    const checkedAt = this.now();
    if (!force && previous && checkedAt - previous.checkedAt < CONTEXT_USAGE_REFRESH_INTERVAL_MS) return {};

    let rolloutPath = previous?.rolloutPath;
    if (!rolloutPath && (force || checkedAt >= (previous?.nextLookupAt ?? 0))) {
      rolloutPath = await this.findCurrentRolloutPath(agentId, runId);
    }
    let signature: string | undefined;
    if (rolloutPath) {
      try {
        const info = await lstat(rolloutPath);
        signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch { rolloutPath = undefined; }
    }
    let usage: ContextUsage | undefined;
    let limits: AccountLimits | undefined;
    if (rolloutPath && (force || signature !== previous?.signature)) {
      usage = await readLatestTokenCount(rolloutPath).catch(() => undefined);
      limits = usage && accountLimits("codex", usage);
    } else if (!rolloutPath) {
      // Claude runs have no Codex rollout; the runtime records their context usage in the run state.
      ({ usage, limits } = await this.readRecordedContextUsage(agentId, runId));
    }
    const limitsSignature = limits ? JSON.stringify(limits) : previous?.limitsSignature;
    if (limits && limitsSignature === previous?.limitsSignature) limits = undefined;
    const latestUsage = usage ?? previous?.usage;
    this.contextUsageSnapshots.set(key, {
      checkedAt,
      ...(limitsSignature ? { limitsSignature } : {}),
      nextLookupAt: rolloutPath ? 0 : (previous?.nextLookupAt && previous.nextLookupAt > checkedAt
        ? previous.nextLookupAt : checkedAt + 10_000),
      ...(signature ? { signature } : {}),
      ...(rolloutPath ? { rolloutPath } : {}),
      ...(latestUsage ? { usage: latestUsage } : {})
    });
    while (this.contextUsageSnapshots.size > 128) this.contextUsageSnapshots.delete(this.contextUsageSnapshots.keys().next().value!);
    if (!usage || (previous?.usage?.usedTokens === usage.usedTokens &&
        previous.usage.contextWindowTokens === usage.contextWindowTokens &&
        previous.usage.weeklyUsedPercent === usage.weeklyUsedPercent &&
        previous.usage.fiveHourUsedPercent === usage.fiveHourUsedPercent &&
        previous.usage.weeklyResetsAt === usage.weeklyResetsAt &&
        previous.usage.fiveHourResetsAt === usage.fiveHourResetsAt)) return { limits };
    return { usage, limits };
  }

  private async readRecordedContextUsage(
    agentId: string,
    runId: string
  ): Promise<{ readonly usage?: ContextUsage; readonly limits?: AccountLimits }> {
    try {
      const statePath = await this.managedPath(agentId, "runs", runId, "state.json");
      const info = await lstat(statePath);
      if (!info.isFile() || info.size > 256 * 1024) return {};
      const state = readRecordOrUndefined(JSON.parse((await readManagedBytes(statePath, 256 * 1024)).toString("utf8")));
      const recorded = readRecordOrUndefined(state?.contextUsage);
      const usedTokens = readTokenCount(recorded?.usedTokens);
      const contextWindowTokens = readTokenCount(recorded?.contextWindowTokens);
      const windows = {
        ...usageWindow("weekly", readUsedPercent(recorded?.weeklyUsedPercent), readResetsAt(recorded?.weeklyResetsAt)),
        ...usageWindow("fiveHour", readUsedPercent(recorded?.fiveHourUsedPercent), readResetsAt(recorded?.fiveHourResetsAt))
      };
      // Limits are account-wide, so they are reported even before the run records context tokens.
      const limits = typeof state?.provider === "string" ? accountLimits(state.provider, windows) : undefined;
      if (usedTokens === undefined || contextWindowTokens === undefined) return { limits };
      return { usage: { usedTokens, contextWindowTokens, ...windows }, limits };
    } catch {
      return {};
    }
  }

  private async findCurrentRolloutPath(agentId: string, runId: string): Promise<string | undefined> {
    const statePath = await this.managedPath(agentId, "runs", runId, "state.json");
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.size > 256 * 1024) return undefined;
      const state = readRecordOrUndefined(JSON.parse((await readManagedBytes(statePath, 256 * 1024)).toString("utf8")));
      const sessionId = typeof state?.sessionId === "string" && MANAGED_ID.test(state.sessionId)
        ? state.sessionId
        : undefined;
      if (!sessionId) return undefined;
      return findSessionRollout(join(this.codexHome, "sessions"), sessionId);
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
    this.contextUsageSnapshots.delete(`${agentId}/${runId}`);
    let diagnostics = runDiagnostics(run);
    if (status === "failed" && diagnostics.error?.code === "codex_failed") {
      const message = await this.readFailureMessage(agentId, runId);
      if (message) diagnostics = { ...diagnostics, error: { ...diagnostics.error, message } };
    }
    return {
      ...diagnostics,
      status,
      ...(status === "needs-human-decision" && (run.decisionKind === "approval" || run.decisionKind === "clarification") ? { decisionKind: run.decisionKind } : {}),
      text
    };
  }

  private async readFailureMessage(agentId: string, runId: string): Promise<string | undefined> {
    try {
      const path = await this.managedPath(agentId, "runs", runId, "events.jsonl");
      const content = (await readManagedBytes(path, MAX_EVENTS_BYTES)).toString("utf8");
      let message: string | undefined;
      for (const line of content.split("\n").slice(0, -1)) {
        let event: Record<string, unknown> | undefined;
        try { event = readRecordOrUndefined(JSON.parse(line)); } catch { continue; }
        if (!event) continue;
        if (event.type === "thread.started" || event.type === "turn.started" || event.type === "turn.completed") {
          message = undefined;
        } else if (event.type === "error" || event.type === "turn.failed") {
          const detail = event.type === "error" ? event.message : readRecordOrUndefined(event.error)?.message;
          if (typeof detail === "string" && detail.trim()) message = detail.trim().slice(0, 4096);
        }
      }
      return message;
    } catch {
      // The runtime diagnostic remains available when event details cannot be read.
      return undefined;
    }
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
    const document = await this.listAgentsDocument();
    if (!Array.isArray(document.agents) || document.agents.length > 1_000) {
      throw new Error(localize("ui.invalid.agent.factory.session.list.response"));
    }
    return document.agents.flatMap((value) => {
      const agent = readRecordOrUndefined(value);
      if (
        !agent ||
        agent.role !== "main" ||
        typeof agent.agentId !== "string" ||
        !MANAGED_ID.test(agent.agentId) ||
        (agent.sessionId !== null && (typeof agent.sessionId !== "string" || !agent.sessionId))
      ) {
        return [];
      }
      return [{
        agentId: agent.agentId,
        ...(typeof agent.sessionId === "string" ? { sessionId: agent.sessionId } : {}),
        ...(typeof agent.conversationId === "string" && MANAGED_ID.test(agent.conversationId)
          ? { conversationId: agent.conversationId } : {}),
        ...(typeof agent.updatedAt === "string" ? { updatedAt: agent.updatedAt } : {}),
        ...(typeof agent.model === "string" && agent.model ? { model: agent.model } : {})
      }];
    }).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  private listAgentsDocument(): Promise<Record<string, unknown>> {
    return this.agentListCache.get(this.projectRoot, () => this.command(["list", "--project-root", this.projectRoot]));
  }

  public async stopTask(mainAgentId: string, target: TaskStopTarget): Promise<Record<string, unknown> | undefined> {
    const agents = await this.listChildSessions(mainAgentId);
    // Read fresh engine state before allowing a direct-run cancel. An omitted Loop binding
    // must not bypass its engine and leave it free to dispatch the next stage.
    const loops = await this.refreshWorkflows(mainAgentId, agents, false, true);
    const owned = loops.filter(loop => (loop.workflow as { id?: string } | undefined)?.id === target.workflowId);
    if (target.loopId) {
      const loop = owned.find(loop => loop.loopId === target.loopId && loop.workAgentId === target.workAgentId);
      if (!loop) throw new Error("Task Loop does not belong to this Main conversation");
      const tasks = (loop.workflow as { tasks?: { id?: string }[] }).tasks;
      if (tasks?.length !== 1 || tasks[0]?.id !== target.taskId) throw new Error("Stopping one task in a multi-task Loop is unsupported");
      return this.workflowDecision(mainAgentId, target.workAgentId!, target.loopId, "stop-task",
        ["--workflow-id", target.workflowId, "--task-id", target.taskId], "Human selected Stop task", "Task stop failed");
    }
    if (owned.length) throw new Error("This task requires its exact Loop binding");
    const agent = agents.find(agent => agent.agentId === target.agentId && agent.runId === target.runId &&
      agent.taskBinding?.workflowId === target.workflowId && agent.taskBinding?.taskId === target.taskId);
    if (!agent || agent.agentId === mainAgentId) throw new Error("Task run does not belong to this Main conversation");
    if (!["accepted", "queued", "starting", "running", "cancelling"].includes(agent.status)) throw new Error("This task run cannot be cancelled in its current state");
    await this.cancel(agent.agentId, agent.runId!);
    return undefined;
  }

  public closeWorkflow(mainAgentId: string, workAgentId: string, loopId: string): Promise<Record<string, unknown>> {
    return this.workflowDecision(mainAgentId, workAgentId, loopId, "close", [], "Human selected Close failed workflow", "Workflow close failed");
  }

  /** The Human's click on a loop stopped at its revision limit: three more revisions, or the end of the loop. */
  public decideRevisionLimit(mainAgentId: string, workAgentId: string, loopId: string, decision: RevisionLimitDecision): Promise<Record<string, unknown>> {
    return decision === "continue"
      ? this.workflowDecision(mainAgentId, workAgentId, loopId, "extend-revisions", ["--additional", String(REVISION_LIMIT_EXTENSION)],
        `Human selected Continue at the revision limit (${REVISION_LIMIT_EXTENSION} more revisions)`, "Workflow continuation failed")
      : this.workflowDecision(mainAgentId, workAgentId, loopId, "close", [], "Human selected Stop at the revision limit", "Workflow close failed");
  }

  /** Run a Human-only loop command bound to the Main run that started the workflow, with the click as decision evidence. */
  private async workflowDecision(mainAgentId: string, workAgentId: string, loopId: string, command: "close" | "extend-revisions" | "stop-task",
    extra: readonly string[], evidence: string, failure: string): Promise<Record<string, unknown>> {
    const location = await this.location();
    const path = await this.managedPath(workAgentId, "loops", loopId, "state.json");
    const state = readRecord(JSON.parse((await readManagedBytes(path, MAX_RESULT_BYTES)).toString("utf8")), "workflow");
    const parentPath = typeof state.parentStatePath === "string" ? state.parentStatePath : "";
    const parentRun = parentPath.split(sep).at(-2);
    if (!parentRun || !MANAGED_ID.test(parentRun) || parentPath !== await this.managedPath(mainAgentId, "runs", parentRun, "state.json")) {
      throw new Error("Workflow does not belong to this Main conversation");
    }
    const parent = readRecord(JSON.parse((await readManagedBytes(parentPath, MAX_RESULT_BYTES)).toString("utf8")), "workflow parent");
    const output = await runBoundedProcess(this.pythonCommand, [join(dirname(this.execPath), "loop.py"), command,
      "--project-root", this.projectRoot, "--runtime-home", location.home, "--project-id", location.projectId,
      "--work-agent", workAgentId, "--loop-id", loopId, "--actor", "human",
      "--authorization-reference", `chat:${mainAgentId}:workflow:${loopId}`,
      "--decision-evidence", evidence, ...extra], COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES,
      { ...pluginRuntimeEnvironment(this.developmentRoot), AGENT_FACTORY_PARENT_STATE: parentPath,
        AGENT_FACTORY_EXECUTION_POLICY: JSON.stringify(parent.executionPolicy) });
    let snapshot: Record<string, unknown>;
    try { snapshot = JSON.parse(output.stdout); }
    catch { throw new Error(`${failure}: ${output.stderr.trim() || "Runtime returned an invalid response"}`); }
    if (output.exitCode !== 0 || snapshot.kind === "error") throw new Error((snapshot.error as { message?: string } | undefined)?.message || failure);
    this.workflowSnapshots.delete(path);
    return this.presentWorkflow(snapshot, state, mainAgentId, parentRun);
  }

  /** Add what the task panel needs beside the runtime snapshot; the pause only where the runtime advertises it. */
  private async presentWorkflow(snapshot: Record<string, unknown>, state: Record<string, unknown>, mainAgentId: string, parentRun: string): Promise<Record<string, unknown>> {
    // The parent state path was checked against this Main and exact run by the caller.
    snapshot.parentAgentId = mainAgentId;
    snapshot.parentRunId = parentRun;
    // Loop creation is the dispatch time of its cards; older runtimes omit it from the snapshot.
    const dispatchedAt = typeof snapshot.createdAt === "string" ? snapshot.createdAt : state.createdAt;
    if (typeof dispatchedAt === "string" && dispatchedAt) snapshot.dispatchedAt = dispatchedAt;
    // Enrich each stage from its own captured run, including earlier tasks no longer in the child list.
    const workflow = readRecordOrUndefined(snapshot.workflow);
    if (workflow && Array.isArray(workflow.tasks)) {
      await Promise.all(workflow.tasks.map(async value => {
        const task = readRecordOrUndefined(value);
        if (!task) return;
        const workspace = readRecordOrUndefined(readRecordOrUndefined(snapshot.taskWorkspaces)?.[String(task.id)]);
        if (workspace && Array.isArray(workspace.repositories)) {
          task.workspaceSummary = workspace.repositories.map(value => {
            const unit = readRecordOrUndefined(value);
            if (!unit) return "";
            return localize("unit.task.detail", String(unit.repositoryRoot), String(unit.branch), String(unit.targetBranch),
              localize("unit.task." + String(unit.phase)), String(unit.path), String(unit.baseCommit),
              unit.mergeCommit ? localize("unit.task.merge", String(unit.mergeCommit)) : "",
              unit.cleanupPending ? localize("unit.task.cleanup.pending") : "");
          }).filter(Boolean).join("\n");
        }
        for (const role of ["work", "verification"] as const) {
          const agentId = task[role + "AgentId"] || snapshot[role + "AgentId"];
          const runId = task[role + "RunId"];
          if (typeof agentId !== "string" || !MANAGED_ID.test(agentId) || typeof runId !== "string" || !MANAGED_ID.test(runId)) continue;
          const captured = await this.latestRunInfo(agentId, runId);
          if (captured.model) task[role + "Model"] = captured.model;
          if (role === "work" && captured.workProfile) task.workProfile = captured.workProfile;
        }
      }));
    }
    if (snapshot.pause !== undefined && snapshot.pause !== null && !(await this.revisionLimitPauseAdvertised(mainAgentId))) delete snapshot.pause;
    return snapshot;
  }

  private async revisionLimitPauseAdvertised(mainAgentId: string): Promise<boolean> {
    // The cached probe of this conversation; a failed probe keeps the text message only.
    try { return (await this.capabilities(mainAgentId)).submit.revisionLimitPause === true; }
    catch { return false; }
  }

  public async advanceWorkflows(mainAgentId: string, agents: readonly ChildAgentSession[], drive = true): Promise<readonly Record<string, unknown>[]> {
    const identity = [...new Set(agents.filter(agent => agent.role === "work").map(agent => agent.agentId))].sort();
    return this.workflowRefreshCache.get(JSON.stringify([mainAgentId, identity, drive]), () => this.refreshWorkflows(mainAgentId, agents, drive));
  }

  private async refreshWorkflows(mainAgentId: string, agents: readonly ChildAgentSession[], drive: boolean, fullScan = false): Promise<readonly Record<string, unknown>[]> {
    const location = await this.location();
    const snapshots: Record<string, unknown>[] = [];
    for (const agentId of new Set(agents.filter(agent => agent.role === "work").map(agent => agent.agentId))) {
      // Reuse the parent listing while its identity/timestamps are unchanged.
      // Creating or removing loops changes this signature, so absence is not
      // cached on a timer and newly accepted workflows remain discoverable.
      const agentDirectory = await this.managedPath(agentId);
      const agentEntries = await this.managedDirectoryEntries(agentDirectory).catch(error => {
        if (isMissingFile(error)) return [];
        throw error;
      });
      if (!agentEntries.some(entry => entry.name === "loops")) continue;
      const directory = await this.managedPath(agentId, "loops");
      const entries = await this.managedDirectoryEntries(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of fullScan ? entries : entries.slice(-100)) {
        if (!entry.isDirectory() || !MANAGED_ID.test(entry.name)) continue;
        const path = await this.managedPath(agentId, "loops", entry.name, "state.json");
        const info = await lstat(path);
        if (info.size > MAX_RESULT_BYTES) throw new Error("Workflow state exceeds limit");
        const fileSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const cached = this.workflowSnapshots.get(path);
        const state = cached?.signature.startsWith(fileSignature + "|")
          ? cached.state : JSON.parse(await readFile(path, "utf8"));
        if (!state.workflow || typeof state.parentStatePath !== "string") continue;
        const parentRun = state.parentStatePath.split(sep).at(-2);
        if (!parentRun || !MANAGED_ID.test(parentRun) || state.parentStatePath !== await this.managedPath(mainAgentId, "runs", parentRun, "state.json")) continue;
        const parentInfo = await lstat(state.parentStatePath);
        const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}|${parentInfo.dev}:${parentInfo.ino}:${parentInfo.size}:${parentInfo.mtimeMs}:${parentInfo.ctimeMs}`;
        if (cached?.signature === signature && (state.status !== "active" ||
          (!drive && Date.now() - cached.observedAt < 1000))) {
          snapshots.push(cached.snapshot);
          continue;
        }
        const parent = readRecord(JSON.parse((await readManagedBytes(state.parentStatePath, MAX_RESULT_BYTES)).toString("utf8")), "workflow parent run");
        const policy = readRecord(parent.executionPolicy, "workflow parent execution policy");
        // Bind both values to the same captured run. The runtime validates the
        // snapshot against that run and its session before advancing any work.
        const output = await runBoundedProcess(this.pythonCommand, [join(dirname(this.execPath), "loop.py"),
          drive && state.status === "active" ? "reconcile" : "status", "--project-root", this.projectRoot,
          "--runtime-home", location.home, "--project-id", location.projectId,
          "--work-agent", agentId, "--loop-id", entry.name], COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES,
          { ...pluginRuntimeEnvironment(this.developmentRoot),
            AGENT_FACTORY_PARENT_STATE: state.parentStatePath,
            AGENT_FACTORY_EXECUTION_POLICY: JSON.stringify(policy) });
        const snapshot = JSON.parse(output.stdout);
        if (output.exitCode !== 0 || snapshot.kind === "error") throw new Error(snapshot.error?.message || "Workflow reconciliation failed");
        await this.presentWorkflow(snapshot, state, mainAgentId, parentRun);
        this.workflowSnapshots.set(path, { signature, observedAt: Date.now(), state, snapshot });
        while (this.workflowSnapshots.size > 256) this.workflowSnapshots.delete(this.workflowSnapshots.keys().next().value!);
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  /** Every task brief of this project, read from the loop states of every conversation. Read-only: no loop is driven. */
  public listProjectTasks(): Promise<readonly ProjectTaskEntry[]> {
    return this.projectTaskCache.get("project", () => this.readProjectTasks());
  }

  private async readProjectTasks(): Promise<readonly ProjectTaskEntry[]> {
    const location = await this.location();
    const latest = new Map<string, ProjectTaskEntry>();
    for (const agent of await this.managedDirectoryEntries(location.agentsRoot)) {
      if (!agent.isDirectory() || !MANAGED_ID.test(agent.name)) continue;
      const members = await this.managedDirectoryEntries(await this.managedPath(agent.name)).catch(error => {
        if (isMissingFile(error)) return [];
        throw error;
      });
      if (!members.some(entry => entry.name === "loops" && entry.isDirectory())) continue;
      for (const loop of await this.managedDirectoryEntries(await this.managedPath(agent.name, "loops"))) {
        if (!loop.isDirectory() || !MANAGED_ID.test(loop.name)) continue;
        let state: Record<string, unknown> | undefined;
        try { state = await this.cachedRunState(await this.managedPath(agent.name, "loops", loop.name, "state.json")); }
        catch (error) { if (isMissingFile(error)) continue; throw error; }
        const entry = state && projectTaskEntry(state);
        // A brief re-dispatched in a newer loop keeps one row: the most recent state wins.
        if (entry && !((latest.get(entry.id)?.updatedAt ?? "") > (entry.updatedAt ?? ""))) latest.set(entry.id, entry);
      }
    }
    return [...latest.values()].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.id.localeCompare(right.id));
  }

  /** Resolve the clicked historical run, retaining Main ownership and its captured options. */
  public async childRun(mainAgentId: string, agentId: string, runId: string): Promise<ChildAgentSession | undefined> {
    if (![mainAgentId, agentId, runId].every(id => MANAGED_ID.test(id))) return undefined;
    const captured = await this.latestRunInfo(agentId, runId);
    if (captured.status === "unknown" || captured.parentAgentId !== mainAgentId) return undefined;
    const document = await this.listAgentsDocument();
    const session = Array.isArray(document.agents) && document.agents.find(value => {
      const agent = readRecordOrUndefined(value);
      return agent?.agentId === agentId && (agent.role === "work" || agent.role === "verification");
    });
    const agent = readRecordOrUndefined(session);
    if (!agent) return undefined;
    return { ...captured, agentId, role: agent.role as "work" | "verification" };
  }

  public async listChildSessions(mainAgentId: string, runId?: string): Promise<readonly ChildAgentSession[]> {
    if (!MANAGED_ID.test(mainAgentId)) {
      throw new Error(localize("ui.invalid.main.agent.identifier"));
    }
    if (runId !== undefined && !MANAGED_ID.test(runId)) throw new Error(localize("ui.invalid.main.agent.run.identifier"));
    return this.childSessionCache.get(JSON.stringify([mainAgentId, runId ?? ""]), () => this.readChildSessions(mainAgentId, runId));
  }

  private async readChildSessions(mainAgentId: string, runId?: string): Promise<readonly ChildAgentSession[]> {
    const referenced = await this.discoverChildAgents(mainAgentId, runId);
    if (referenced.size === 0) return [];
    const sessions = await Promise.all([...referenced.keys()].map(async agentId => {
      try { return await this.cachedRunState(await this.managedPath(agentId, "session.json")); }
      catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    }));
    const document = sessions.every(Boolean) ? { agents: sessions } : await this.listAgentsDocument();
    if (!Array.isArray(document.agents) || document.agents.length > 1_000) {
      throw new Error(localize("ui.invalid.agent.factory.session.list.response"));
    }
    const agents: ChildAgentSession[] = [];
    const parentModes = new Map<string, TaskMode | undefined>();
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
      const reference = referenced.get(agent.agentId)!;
      const latest = reference.pending
        ? { status: "unknown" }
        : await this.latestRunInfo(agent.agentId, reference.runId);
      // Read-only status commands in later conversation turns are not dispatch authority.
      const parentRunId = latest.parentAgentId === mainAgentId && latest.parentRunId ? latest.parentRunId : reference.parentRunId;
      if (parentRunId && !parentModes.has(parentRunId)) {
        const path = await this.managedPath(mainAgentId, "runs", parentRunId, "state.json");
        try {
          const parent = readRecord(await this.cachedRunState(path), "parent run");
          parentModes.set(parentRunId, TASK_MODES.includes(parent.taskMode as TaskMode) ? parent.taskMode as TaskMode : undefined);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          parentModes.set(parentRunId, undefined);
        }
      }
      agents.push({
        parentRunId,
        ...(parentRunId && parentModes.get(parentRunId) ? { taskMode: parentModes.get(parentRunId) } : {}),
        agentId: agent.agentId,
        role: agent.role,
        ...(latest.taskBinding ? { taskBinding: latest.taskBinding } : {}),
        status: latest.status,
        ...(latest.model ? { model: latest.model } : {}),
        ...(latest.reasoningEffort ? { reasoningEffort: latest.reasoningEffort } : {}),
        ...(latest.workProfile ? { workProfile: latest.workProfile } : {}),
        ...(latest.runId ? { runId: latest.runId } : {}),
        ...(latest.verifiedWorkRunId ? { verifiedWorkRunId: latest.verifiedWorkRunId } : {}),
        ...(latest.planProgress ? { planProgress: latest.planProgress } : {}),
        ...(latest.activity ? { activity: latest.activity } : {}),
        ...(typeof agent.updatedAt === "string" ? { updatedAt: agent.updatedAt } : {}),
        ...(latest.dispatchedAt ? { dispatchedAt: latest.dispatchedAt } : {})
      });
    }
    return agents.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  private async discoverChildAgents(mainAgentId: string, runId?: string): Promise<ReadonlyMap<string, ChildAgentReference>> {
    const runsDirectory = await this.managedPath(mainAgentId, "runs");
    const childIds = new Map<string, ChildAgentReference>();
    let runs;
    try {
      runs = (runId ? [{ name: runId, isDirectory: () => true }] : await this.managedDirectoryEntries(runsDirectory))
        .filter((entry) => entry.isDirectory() && MANAGED_ID.test(entry.name) && (runId === undefined || entry.name === runId))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, 500);
    } catch (error) {
      if (isMissingFile(error)) return childIds;
      throw error;
    }
    for (const run of runs) {
      const references = await this.discoverRunChildren(mainAgentId, run.name);
      for (const [agentId, reference] of references) if (!childIds.has(agentId)) childIds.set(agentId, reference);
    }
    return childIds;
  }

  private async discoverRunChildren(mainAgentId: string, runName: string): Promise<ReadonlyMap<string, ChildAgentReference>> {
    const childIds = new Map<string, ChildAgentReference>();
      // A missing children directory is common in legacy histories. Check the
      // containing directory signature, so a newly published index is discovered.
      const runDirectory = await this.managedPath(mainAgentId, "runs", runName);
      let runEntries: Dirent[];
      try { runEntries = await this.managedDirectoryEntries(runDirectory); }
      catch (error) { if (isMissingFile(error)) return childIds; throw error; }
      const cachedRun = this.observedChildRuns.get(runDirectory, runEntries);
      if (cachedRun) return cachedRun;
      const hasReferences = runEntries.some(entry => entry.name === "children");
      const referencesPath = hasReferences ? await this.managedPath(mainAgentId, "runs", runName, "children") : undefined;
      const publish = this.observedChildRuns.observe(runDirectory, runEntries,
        referencesPath ? [runDirectory, referencesPath] : [runDirectory]);
      let references: import("node:fs").Dirent[] = [];
      try { if (referencesPath) references = await this.managedDirectoryEntries(referencesPath); }
      catch (error) { if (!isMissingFile(error)) throw error; }
      for (const entry of references) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || !MANAGED_ID.test(entry.name)) continue;
        const reference = await this.cachedRunState(await this.managedPath(mainAgentId, "runs", runName, "children", entry.name));
        if (reference && reference.parentAgentId === mainAgentId && reference.parentRunId === runName &&
            typeof reference.agentId === "string" && MANAGED_ID.test(reference.agentId) &&
            typeof reference.runId === "string" && MANAGED_ID.test(reference.runId) && !childIds.has(reference.agentId)) {
          childIds.set(reference.agentId, { agentId: reference.agentId, runId: reference.runId, parentRunId: runName, pending: false });
        }
      }
      // The fresh directory signature also detects a newly created legacy log.
      if (!runEntries.some(entry => entry.name === "events.jsonl")) { publish(childIds); return childIds; }
      const eventsPath = await this.managedPath(mainAgentId, "runs", runName, "events.jsonl");
      let content: string;
      let observedSignature = "";
      const runChildren = new Map<string, ChildAgentReference>();
      try {
        let info = await lstat(eventsPath);
        if (!info.isFile() || info.size > MAX_EVENTS_BYTES) return childIds;
        let signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const cached = this.childEventSnapshots.get(eventsPath);
        if (cached?.signature === signature) {
          for (const reference of cached.references) runChildren.set(reference.agentId, { ...reference, parentRunId: runName });
          for (const [agentId, reference] of runChildren) if (!childIds.has(agentId)) childIds.set(agentId, reference);
          publish(childIds);
          return childIds;
        }
        content = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          content = (await readManagedBytes(eventsPath, MAX_EVENTS_BYTES)).toString("utf8");
          await this.afterChildEventRead?.(eventsPath);
          const after = await lstat(eventsPath);
          observedSignature = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
          if (signature === observedSignature) break;
          observedSignature = "";
          if (attempt === 0) {
            info = after;
            if (!info.isFile() || info.size > MAX_EVENTS_BYTES) break;
            signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          }
        }
        this.childEventSnapshots.delete(eventsPath);
      } catch (error) {
        if (isMissingFile(error)) { this.childEventSnapshots.delete(eventsPath); return childIds; }
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
        for (const reference of childAgentReferencesFromCommand(item.command, this.execPath, this.projectRoot)) {
          const output = typeof item.aggregated_output === "string" ? item.aggregated_output : item.aggregatedOutput;
          if (reference.pending && typeof output === "string") {
            for (const outputLine of output.split("\n")) {
              try {
                const ack = readRecordOrUndefined(JSON.parse(outputLine));
                if (ack?.kind === "ack" && ack.agentId === reference.agentId && typeof ack.runId === "string" && MANAGED_ID.test(ack.runId)) {
                  reference.runId = ack.runId;
                  reference.pending = false;
                }
              } catch { /* Command output may also contain ordinary log lines. */ }
            }
          }
          reference.parentRunId = runName;
          runChildren.set(reference.agentId, reference);
        }
      }
      if (observedSignature) {
        this.childEventSnapshots.set(eventsPath, {
          signature: observedSignature,
          references: [...runChildren.values()].map(reference => ({ ...reference, parentRunId: undefined }))
        });
      }
      while (this.childEventSnapshots.size > 1_000) this.childEventSnapshots.delete(this.childEventSnapshots.keys().next().value!);
      for (const [agentId, reference] of runChildren) {
        if (!childIds.has(agentId)) childIds.set(agentId, reference);
      }
    publish(childIds);
    return childIds;
  }

  private async managedDirectoryEntries(path: string): Promise<Dirent[]> {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Unsafe managed directory");
    const signature = `${before.dev}:${before.ino}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = this.directorySnapshots.get(path);
    if (cached?.signature === signature && this.now() - cached.checkedAt < 10_000) return cached.entries;
    const entries = await readdir(path, { withFileTypes: true });
    const after = await lstat(path);
    this.directorySnapshotEntries -= this.directorySnapshots.get(path)?.entries.length ?? 0;
    this.directorySnapshots.delete(path);
    if (signature === `${after.dev}:${after.ino}:${after.mtimeMs}:${after.ctimeMs}`) {
      this.directorySnapshots.set(path, { signature, entries, checkedAt: this.now() });
      // Bound retained directory entries as well as the number of directories.
      this.directorySnapshotEntries += entries.length;
      while (this.directorySnapshots.size > 1_024 || this.directorySnapshotEntries > 10_000) {
        const oldest = this.directorySnapshots.keys().next().value!;
        this.directorySnapshotEntries -= this.directorySnapshots.get(oldest)!.entries.length;
        this.directorySnapshots.delete(oldest);
      }
    }
    return entries;
  }

  private async cachedRunState(path: string): Promise<Record<string, unknown> | undefined> {
    const before = await lstat(path);
    if (!before.isFile() || before.size > 256 * 1024) {
      this.deleteRunStateSnapshot(path);
      return undefined;
    }
    const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = this.runStateSnapshots.get(path);
    if (cached?.signature === signature) return cached.value;
    const content = await readManagedBytes(path, 256 * 1024);
    const value = readRecordOrUndefined(JSON.parse(content.toString("utf8")));
    const after = await lstat(path);
    this.deleteRunStateSnapshot(path);
    if (value && signature === `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`) {
      this.runStateSnapshots.set(path, { signature, value, bytes: content.length });
      this.runStateSnapshotBytes += content.length;
      // A 500-run scan can use four records per run (reference, session,
      // child state, parent state). Bound source bytes separately so larger
      // records cannot consume the old entry-only budget of up to 256 MiB.
      while (this.runStateSnapshots.size > 2_048 || this.runStateSnapshotBytes > 8 * 1024 * 1024) {
        this.deleteRunStateSnapshot(this.runStateSnapshots.keys().next().value!);
      }
    }
    return value;
  }

  private deleteRunStateSnapshot(path: string): void {
    const previous = this.runStateSnapshots.get(path);
    if (previous) this.runStateSnapshotBytes -= previous.bytes;
    this.runStateSnapshots.delete(path);
  }

  private async latestRunInfo(agentId: string, runId?: string): Promise<{ readonly status: string; readonly runId?: string; readonly verifiedWorkRunId?: string; readonly parentAgentId?: string; readonly parentRunId?: string; readonly taskBinding?: Record<string, unknown>; readonly model?: string; readonly reasoningEffort?: string; readonly workProfile?: WorkProfile; readonly dispatchedAt?: string; readonly planProgress?: PlanProgress; readonly activity?: string }> {
    const runsDirectory = await this.managedPath(agentId, "runs");
    try {
      const runs = runId ? [{ name: runId }] : (await this.managedDirectoryEntries(runsDirectory))
        .filter((entry) => entry.isDirectory() && MANAGED_ID.test(entry.name) && (runId === undefined || entry.name === runId))
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const run of runs.slice(0, 100)) {
        const statePath = await this.managedPath(agentId, "runs", run.name, "state.json");
        try {
          // cachedRunState already checks file type, size and freshness before
          // returning a value. Avoid a second metadata read for every child.
          const state = await this.cachedRunState(statePath);
          if (typeof state?.status === "string" && state.status) {
            const executionOptions = readRecordOrUndefined(state.executionOptions);
            return {
              ...(readRecordOrUndefined(state.taskBinding) ? { taskBinding: readRecordOrUndefined(state.taskBinding) } : {}),
              status: state.status,
              runId: run.name,
              ...(typeof executionOptions?.model === "string" && executionOptions.model ? { model: executionOptions.model } : {}),
              ...(typeof executionOptions?.reasoningEffort === "string" && executionOptions.reasoningEffort ? { reasoningEffort: executionOptions.reasoningEffort } : {}),
              ...(parseWorkProfile(state.workProfile) ? { workProfile: parseWorkProfile(state.workProfile) } : {}),
              ...(typeof state.acceptedAt === "string" && state.acceptedAt ? { dispatchedAt: state.acceptedAt } : {}),
              ...(parsePlanProgress(state.planProgress) ? { planProgress: parsePlanProgress(state.planProgress) } : {}),
              ...(typeof state.activity === "string" && state.activity.trim() ? { activity: state.activity.trim().slice(0, 160) } : {}),
              ...(typeof state.parentAgentId === "string" && MANAGED_ID.test(state.parentAgentId) ? { parentAgentId: state.parentAgentId } : {}),
              ...(typeof state.parentRunId === "string" && MANAGED_ID.test(state.parentRunId) ? { parentRunId: state.parentRunId } : {}),
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
    return { status: "unknown", ...(runId ? { runId } : {}) };
  }

  private async command(arguments_: readonly string[]): Promise<Record<string, unknown>> {
    const binding = arguments_[0] === "init" ? undefined : await this.location();
    const output = await this.runRuntimeProcess(
      [...arguments_, ...(binding ? ["--runtime-home", binding.home, "--project-id", binding.projectId] : [])],
      COMMAND_TIMEOUT_MS,
      MAX_PROCESS_OUTPUT_BYTES
    );
    if (output.exitCode !== 0 && ["submit", "send"].includes(arguments_[0] ?? "") && arguments_.includes("--approval-policy") &&
      /unrecognized arguments|unknown option|no such option/i.test(output.stderr)) {
      throw new Error(localize("ui.the.current.agent.factory.runtime.does.not.support.execution.permission.selection.update.the.plugin.and.try.again"));
    }
    let document: unknown;
    try {
      document = JSON.parse(output.stdout);
    } catch {
      throw new Error(output.stderr.trim() || localize("ui.the.agent.factory.runtime.did.not.return.a.valid.json.response"));
    }
    const record = readRecord(document, "runtime response");
    if (output.exitCode !== 0 || record.kind === "error") {
      const nested = readRecordOrUndefined(record.error);
      const message = typeof nested?.message === "string" ? nested.message : typeof record.message === "string" ? record.message : output.stderr.trim();
      throw new Error(message || localize("ui.the.agent.factory.runtime.command.failed.with.exit.code.0", output.exitCode));
    }
    return record;
  }

  private async runRuntimeProcess(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<ProcessOutput> {
    // Every turn uses the host's current CLI selection, including resumed conversations.
    if (codexExecutable() !== "codex" && ["submit", "send", "capabilities", "worktree"].includes(arguments_[0] ?? "") && !arguments_.includes("--codex")) {
      arguments_ = [...arguments_, "--codex", codexExecutable()];
    }
    if (claudeExecutable() !== "claude" && ["submit", "capabilities", "worktree"].includes(arguments_[0] ?? "") && !arguments_.includes("--claude")) {
      arguments_ = [...arguments_, "--claude", claudeExecutable()];
    }
    if (antigravityExecutable() !== "agy" && ["submit", "capabilities", "worktree"].includes(arguments_[0] ?? "") && !arguments_.includes("--agy")) {
      arguments_ = [...arguments_, "--agy", antigravityExecutable()];
    }
    try {
      const info = await lstat(this.execPath);
      if (!info.isFile()) throw new Error(localize("ui.agent.factory.exec.py.is.not.a.regular.file"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.refreshExecPath(error);
    }
    try {
      return await runBoundedProcess(this.pythonCommand, [this.execPath, ...arguments_], timeoutMs, maxOutputBytes, await this.connectionEnvironment(arguments_));
    } catch (error) {
      if (!this.rediscoverExecPath || !isMissingFile(error)) throw error;
      await this.refreshExecPath(error);
      return runBoundedProcess(this.pythonCommand, [this.execPath, ...arguments_], timeoutMs, maxOutputBytes, await this.connectionEnvironment(arguments_));
    }
  }

  private async connectionEnvironment(arguments_: readonly string[]): Promise<NodeJS.ProcessEnv> {
    const environment = pluginRuntimeEnvironment(this.developmentRoot, { ...process.env, ...sudoHandoffEnvironment() });
    return ["submit", "send"].includes(arguments_[0] ?? "")
      ? codexConnectionEnvironment(this.pythonCommand, this.execPath, environment)
      : environment;
  }

  private async refreshExecPath(originalError: unknown): Promise<void> {
    if (!this.rediscoverExecPath) throw originalError;
    const previous = this.execPath;
    const refreshed = await this.rediscoverExecPath();
    if (refreshed === previous) throw originalError;
    this.execPath = refreshed;
    this.locationPromise = undefined;
    this.eventSnapshots.clear();
    this.contextUsageSnapshots.clear();
  }

  private async readManagedResult(path: string, agentId: string, runId: string): Promise<string> {
    const expectedPath = await this.managedPath(agentId, "runs", runId, "result.md");
    const resolvedPath = resolve(path);
    if (resolvedPath !== expectedPath) {
      throw new Error(localize("ui.the.agent.factory.runtime.returned.a.result.path.outside.the.expected.scope"));
    }
    const info = await lstat(resolvedPath);
    if (!info.isFile() || info.size > MAX_RESULT_BYTES) {
      throw new Error(localize("ui.the.agent.factory.result.file.is.missing.or.exceeds.the.size.limit"));
    }
    return (await readManagedBytes(resolvedPath, MAX_RESULT_BYTES)).toString("utf8");
  }
}

export function executionPolicyArguments(mode: ExecutionMode = "cli-default"): string[] {
  if (mode === "cli-default") return [];
  const humanApprovalPolicy = mode === "bypass" ? "bypass" : "required";
  if (mode === "bypass") mode = "danger-full-access";
  if (mode !== "workspace-write" && mode !== "danger-full-access") throw new Error(localize("ui.invalid.execution.permissions"));
  return ["--sandbox", mode, "--approval-policy", "never", "--human-approval-policy", humanApprovalPolicy];
}

function executionArguments(execution: ExecutionOptions): string[] {
  const arguments_: string[] = [];
  if (execution.taskMode) arguments_.push("--task-mode", execution.taskMode);
  if (execution.agentPermissions) arguments_.push("--agent-permissions", JSON.stringify(execution.agentPermissions));
  if (execution.workIsolation !== undefined) arguments_.push("--work-isolation", execution.workIsolation ? "on" : "off");
  if (execution.model) arguments_.push("--model", execution.model);
  if (execution.reasoningEffort) arguments_.push("--reasoning-effort", execution.reasoningEffort);
  if (execution.fast !== undefined) arguments_.push(execution.fast ? "--fast" : "--no-fast");
  if (execution.goalMode !== undefined) arguments_.push(execution.goalMode ? "--goal-mode" : "--no-goal-mode");
  if (execution.goalObjective) arguments_.push("--goal-objective", execution.goalObjective);
  if (execution.actor) arguments_.push("--actor", execution.actor);
  if (execution.verifiedWorkRunId) arguments_.push("--verified-work-run-id", execution.verifiedWorkRunId);
  return arguments_;
}

interface ChildAgentReference {
  parentRunId?: string;
  readonly agentId: string;
  runId?: string;
  pending?: boolean;
}

function childAgentReferencesFromCommand(command: string, execPath: string, projectRoot: string): readonly ChildAgentReference[] {
  const ids = new Map<string, ChildAgentReference>();
  for (const flag of ["work-agent", "verification-agent"] as const) {
    const pattern = new RegExp(`--${flag}(?:=|\\s+)(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z0-9][A-Za-z0-9._-]{0,127}))`, "g");
    for (const match of command.matchAll(pattern)) {
      const candidate = match[1] ?? match[2] ?? match[3];
      if (candidate && MANAGED_ID.test(candidate)) ids.set(candidate, { agentId: candidate });
    }
  }
  for (const words of shellCommandWords(command)) {
    const executable = /(?:^|\/)python(?:3(?:\.\d+)?)?$/.test(words[0] ?? "") ? 1 : 0;
    const script = words[executable] ?? "";
    if (script !== execPath && !/(?:^|\/)(?:skills\/agent\/)?scripts\/exec\.py$/.test(script)) continue;
    if (!["submit", "send", "status", "result", "cancel"].includes(words[executable + 1] ?? "")) continue;
    const options = words.slice(executable + 2);
    const option = (name: string): string | undefined => {
      const index = options.findIndex((word) => word === name || word.startsWith(`${name}=`));
      if (index < 0) return undefined;
      return options[index] === name ? options[index + 1] : options[index]!.slice(name.length + 1);
    };
    const root = option("--project-root");
    if (root && isAbsolute(root) && resolve(root) !== resolve(projectRoot)) continue;
    const candidate = option("--agent");
    const runId = option("--run-id");
    if (runId !== undefined && !MANAGED_ID.test(runId)) continue;
    if (candidate && MANAGED_ID.test(candidate)) ids.set(candidate, {
      agentId: candidate,
      ...(runId ? { runId } : {}),
      ...(!runId && ["submit", "send"].includes(words[executable + 1]!) ? { pending: true } : {})
    });
  }
  return [...ids.values()];
}

// Read shell words without evaluating them. Quoted message text is one argument,
// while shell -c payloads and unquoted command substitutions contain commands.
function shellCommandWords(command: string, depth = 0): readonly (readonly string[])[] {
  if (depth > 4) return [];
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const finishWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const finishCommand = (): void => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      const next = command[index + 1]!;
      if (!quote || /[\\"$`\n]/.test(next)) {
        if (next !== "\n") { word += next; started = true; }
        index++;
        continue;
      }
    }
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '\"') {
      quote = char;
      started = true;
    } else if (/[;|&()\n]/.test(char)) {
      finishCommand();
    } else if (/\s/.test(char)) {
      finishWord();
    } else if (char === "#" && !started) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index++;
    } else {
      word += char;
      started = true;
    }
  }
  if (!quote) finishCommand();
  return commands.flatMap((arguments_) => {
    if (/^(?:do|then|else)$/.test(arguments_[0] ?? "")) arguments_ = arguments_.slice(1);
    if (/(?:^|\/)(?:ba|z|da)?sh$/.test(arguments_[0] ?? "") && /^-[a-z]*c[a-z]*$/.test(arguments_[1] ?? "")) {
      return shellCommandWords(arguments_[2] ?? "", depth + 1);
    }
    return [arguments_];
  });
}

async function progressUpdates(line: string, projectRoot: string, ownResultPath: string): Promise<readonly RunUpdate[]> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  const event = readRecordOrUndefined(value);
  if (!event) return [];
  if (event.type === "interview.question") {
    const question = parseInterviewQuestion(event.question);
    return question ? [{ kind: "interviewQuestion", question }] : [];
  }
  if (event.type === "goal.updated") return [{ kind: "goal", goal: readNativeGoal(event.goal) }];
  if (event.type === "goal.error") return [{ kind: "goal", goal: null, error: typeof event.message === "string" ? event.message : localize("ui.goal.status.needs.attention") }];
  if (event.type === "goal.continuing") return [statusUpdate(localize("ui.the.goal.is.active.codex.will.continue.with.the.next.turn"))];
  if (event.type === "native.delta") {
    return (event.stream === "commentary" || event.stream === "final") && typeof event.id === "string"
      && typeof event.text === "string" && event.text
      ? [{ kind: "delta", stream: event.stream, id: event.id, text: event.text }]
      : [];
  }
  if (event.type === "native.commentary") {
    return typeof event.text === "string" && event.text.trim()
      ? [{ kind: "commentary", text: event.text }, statusUpdate(localize("ui.working"))]
      : [];
  }
  if (event.type === "thread.started") return [statusUpdate(localize("ui.main.agent.connected"))];
  if (event.type === "turn.started") return [statusUpdate(localize("ui.main.agent.is.analyzing.the.request"))];
  if (event.type === "turn.completed") {
    return [statusUpdate(localize("ui.finalizing.response"))];
  }
  const item = readRecordOrUndefined(event.item);
  if (!item || (event.type !== "item.started" && event.type !== "item.completed")) return [];
  const completed = event.type === "item.completed";
  const itemId = typeof item.id === "string" && item.id ? item.id : undefined;
  if (item.type === "contextCompaction") {
    const text = localize(completed ? "ui.context.compaction.completed" : "ui.context.compaction.started");
    return compactUpdates(
      itemId ? activityUpdate(itemId, "tool", completed ? "completed" : "started", text, undefined, localize("ui.context.compaction")) : undefined,
      statusUpdate(text)
    );
  }
  if (item.type === "command_execution") {
    if (typeof item.command === "string" && (!completed || item.exit_code === 0)) {
      const commands = shellCommandWords(item.command);
      const ownResultRead = commands.length > 0 && commands.every(words =>
        /^(?:.*\/)?(?:cat|head|tail|sed)$/.test(words[0] ?? "") &&
        words.includes(ownResultPath) && words.slice(1).every(word =>
          word === ownResultPath || /^(?:-n|-q|--|-?\d+|\d+(?:,\d+)?p)$/.test(word)));
      if (ownResultRead) return [statusUpdate(localize("ui.finalizing.response"))];
    }
    const detail = summarizeCommand(item.command) ?? localize("ui.no.command.details");
    const title = summarizeReadActivity(item.command);
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : item.aggregated_output;
    const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
    // Claude reports a failed Bash call by status without always knowing its exit code.
    const failed = completed && ((exitCode !== undefined && exitCode !== 0) || item.status === "failed" || item.status === "declined");
    if (title === "Read run request") {
      return [statusUpdate(localize("ui.main.agent.is.analyzing.the.request"))];
    }
    const details: ActivityDetails = {
      ...(title ? {} : commandActionDetails(item.commandActions, projectRoot)),
      ...durationDetails(item.durationMs),
      ...(completed && exitCode ? { exitCode } : {}),
      ...(failed ? errorDetails(item.error) : {})
    };
    return compactUpdates(
      itemId ? activityUpdate(itemId, "command", failed ? "failed" : completed ? "completed" : "started", detail, undefined, title, typeof output === "string" ? truncate(output, 32768) : undefined, details) : undefined,
      statusUpdate(failed ? localize("ui.checking.command.failure") : completed ? localize("ui.analyzing.results") : localize("ui.running.command"))
    );
  }
  if (item.type === "file_change") {
    if (changesOnlyManagedRunFiles(item.changes, projectRoot)) {
      return [statusUpdate(completed ? localize("ui.checking.response.record") : localize("ui.recording.response"))];
    }
    const detail = summarizeChanges(item.changes, projectRoot) ?? localize("ui.no.changed.file.details");
    const diff = completed ? await readGitDiff(item.changes, projectRoot) : undefined;
    const failed = completed && (item.status === "failed" || item.status === "declined");
    return compactUpdates(
      itemId ? activityUpdate(itemId, "file", failed ? "failed" : completed ? "completed" : "started", detail, diff, undefined, undefined, failed ? errorDetails(item.error) : undefined) : undefined,
      statusUpdate(completed ? localize("ui.checking.git.changes") : localize("ui.applying.git.changes"))
    );
  }
  if (item.type === "webSearch" || item.type === "web_search") {
    const action = readRecordOrUndefined(item.action);
    const queries = Array.isArray(action?.queries) ? action.queries.filter((query): query is string => typeof query === "string") : [];
    const opensPage = action?.type === "openPage" || action?.type === "open_page" ||
      (action?.type == null && typeof action?.url === "string" && !queries.length && typeof action?.query !== "string" && typeof item.query !== "string");
    const title = localize(opensPage ? "ui.web.page.open" : "ui.web.search");
    const detail = queries.length ? queries.join("\n")
      : typeof action?.query === "string" ? action.query
      : typeof item.query === "string" ? item.query
      : typeof action?.url === "string" ? action.url
      : title;
    const failed = item.status === "failed" || (completed && item.error != null);
    const target = queries.length ? queries.join(" · ") : typeof action?.query === "string" ? action.query
      : typeof item.query === "string" ? item.query : typeof action?.url === "string" ? action.url : undefined;
    const details: ActivityDetails = {
      activityKind: opensPage ? "page" : "web",
      ...(target ? { target: truncate(target, 500) } : {}),
      ...(action?.type === "findInPage" && typeof action.pattern === "string" ? { scope: truncate(action.pattern, 200) } : {}),
      ...(failed ? errorDetails(item.error) : {})
    };
    return compactUpdates(
      itemId ? activityUpdate(itemId, "tool", failed ? "failed" : completed ? "completed" : "started", truncate(detail, 32768), undefined, title, undefined, details) : undefined,
      statusUpdate(failed ? localize(opensPage ? "ui.web.page.open.failed" : "ui.web.search.failed") : completed ? localize("ui.analyzing.results") : localize(opensPage ? "ui.web.page.opening" : "ui.searching.the.web"))
    );
  }
  if (item.type === "mcp_tool_call") {
    const detail = [item.server, item.tool].filter((value) => typeof value === "string").join("/") || localize("ui.no.tool.details");
    const failed = completed && ((item.error !== null && item.error !== undefined) || item.status === "failed");
    const output = completed ? toolResultText(item.result) : undefined;
    const details: ActivityDetails = {
      ...toolActivityDetails(item.tool, item.arguments, projectRoot),
      ...durationDetails(item.durationMs),
      ...(failed ? errorDetails(item.error) : {})
    };
    return compactUpdates(
      itemId ? activityUpdate(itemId, "tool", failed ? "failed" : completed ? "completed" : "started", detail, undefined, undefined, output ? truncate(output, 32768) : undefined, details) : undefined,
      statusUpdate(failed ? localize("ui.checking.connected.tool.failure") : completed ? localize("ui.analyzing.results") : localize("ui.running.connected.tool"))
    );
  }
  if (item.type === "reasoning") {
    // Only the provider's user-facing summary is shown; raw reasoning content stays private.
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n\n").trim() : "";
    return compactUpdates(
      itemId ? activityUpdate(itemId, "tool", completed ? "completed" : "started", localize("ui.reasoning"), undefined, undefined, undefined,
        { activityKind: "think", ...(summary ? { summary: truncate(summary, 16384) } : {}) }) : undefined,
      statusUpdate(localize("ui.reasoning"))
    );
  }
  if (item.type === "agent_message") return [statusUpdate(localize("ui.finalizing.response"))];
  return [];
}

function readNativeGoal(value: unknown): NativeGoal | null {
  if (value === null || value === undefined) return null;
  const goal = readRecord(value, "native goal");
  if (typeof goal.threadId !== "string" || typeof goal.objective !== "string" ||
      !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(goal.status)) ||
      readTokenCount(goal.tokensUsed) === undefined || readTokenCount(goal.timeUsedSeconds) === undefined) {
    throw new Error(localize("ui.invalid.native.goal.state"));
  }
  return { threadId: goal.threadId, objective: goal.objective, status: goal.status as NativeGoal["status"],
    tokensUsed: Number(goal.tokensUsed), timeUsedSeconds: Number(goal.timeUsedSeconds),
    ...(goal.tokenBudget === null || readTokenCount(goal.tokenBudget) !== undefined ? { tokenBudget: goal.tokenBudget as number | null } : {}) };
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
): Promise<ContextUsage | undefined> {
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
        const weekly = readRateLimitWindow(payload.rate_limits, 7 * 24 * 60);
        const fiveHour = readRateLimitWindow(payload.rate_limits, 5 * 60);
        return {
          usedTokens,
          contextWindowTokens,
          ...usageWindow("weekly", weekly?.usedPercent, weekly?.resetsAt),
          ...usageWindow("fiveHour", fiveHour?.usedPercent, fiveHour?.resetsAt)
        };
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function readRateLimitWindow(
  value: unknown,
  windowMinutes: number
): { readonly usedPercent: number; readonly resetsAt?: number } | undefined {
  const rateLimits = readRecordOrUndefined(value);
  for (const key of ["primary", "secondary"] as const) {
    const window = readRecordOrUndefined(rateLimits?.[key]);
    if (window?.window_minutes !== windowMinutes) continue;
    const usedPercent = readUsedPercent(window.used_percent);
    if (usedPercent !== undefined) return { usedPercent, resetsAt: readResetsAt(window.resets_at) };
  }
  return undefined;
}

function usageWindow(
  name: "weekly" | "fiveHour",
  usedPercent: number | undefined,
  resetsAt: number | undefined
): Partial<ContextUsage> {
  return {
    ...(usedPercent !== undefined ? { [`${name}UsedPercent`]: usedPercent } : {}),
    ...(resetsAt !== undefined ? { [`${name}ResetsAt`]: resetsAt } : {})
  };
}

function accountLimits(provider: string, usage: Partial<ContextUsage>): AccountLimits | undefined {
  const limits = {
    provider,
    ...usageWindow("weekly", usage.weeklyUsedPercent, usage.weeklyResetsAt),
    ...usageWindow("fiveHour", usage.fiveHourUsedPercent, usage.fiveHourResetsAt)
  };
  return Object.keys(limits).length > 1 ? limits : undefined;
}

function readResetsAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readUsedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function activityUpdate(
  id: string,
  category: "command" | "file" | "tool",
  phase: "started" | "completed" | "failed",
  text: string,
  diff?: string,
  title?: string,
  output?: string,
  details?: ActivityDetails
): RunUpdate {
  return {
    kind: "activity",
    id,
    category,
    phase,
    text,
    ...(title ? { title } : {}),
    ...(diff ? { diff } : {}),
    ...(output !== undefined ? { output } : {}),
    ...details
  };
}

// Provider tool names whose action is a read, search or listing; other tools stay generic.
const TOOL_ACTIVITY_KINDS: Readonly<Record<string, ActivityKind>> = {
  Read: "read", view_file: "read",
  Grep: "search", grep_search: "search",
  Glob: "list", LS: "list", list_dir: "list", find_by_name: "list"
};
// The agy names are those agy 1.2.16 stream-json reports; it omits line windows and include filters.
const TOOL_ARGUMENT_NAMES: Readonly<Record<string, string>> = {
  file_path: "file_path", absolutepath: "file_path", notebook_path: "file_path",
  path: "path", directorypath: "path", searchpath: "path", searchdirectory: "path",
  pattern: "pattern", query: "query", glob: "glob", url: "url",
  offset: "offset", limit: "limit"
};

/** Bounded copy of the arguments naming a tool's target, keyed by normalized name. */
export function summarizeToolArguments(value: unknown): Readonly<Record<string, string | number>> {
  const record = readRecordOrUndefined(value);
  const summary: Record<string, string | number> = {};
  if (!record) return summary;
  for (const [key, argument] of Object.entries(record)) {
    const name = TOOL_ARGUMENT_NAMES[key.toLowerCase()];
    if (!name || name in summary) continue;
    if (name === "offset" || name === "limit") {
      if (typeof argument === "number" && Number.isInteger(argument) && argument >= 0) summary[name] = argument;
    } else if (typeof argument === "string" && argument.trim()) {
      summary[name] = truncate(argument, 200);
    }
  }
  return summary;
}

/** What a provider tool call acted on; nothing is invented when its arguments do not say. */
export function toolActivityDetails(tool: unknown, value: unknown, projectRoot: string): ActivityDetails {
  const name = typeof tool === "string" ? tool : "";
  const kind = Object.hasOwn(TOOL_ACTIVITY_KINDS, name) ? TOOL_ACTIVITY_KINDS[name] : undefined;
  const args = summarizeToolArguments(value);
  const text = (key: string): string | undefined => typeof args[key] === "string" ? args[key] as string : undefined;
  const count = (key: string): number | undefined => typeof args[key] === "number" ? args[key] as number : undefined;
  const path = (key: string): string | undefined => { const raw = text(key); return raw ? projectPath(raw, projectRoot) : undefined; };
  if (kind === "read") {
    const target = path("file_path") ?? path("path");
    const offset = count("offset"), limit = count("limit");
    const start = offset ?? (limit !== undefined ? 1 : undefined);
    const end = (limit !== undefined && limit > 0 && start !== undefined ? start + limit - 1 : undefined);
    return { activityKind: kind, ...(target ? { target } : {}), ...(start !== undefined && start > 0 ? { lineStart: start } : {}),
      ...(end !== undefined && start !== undefined && end >= start ? { lineEnd: end } : {}) };
  }
  if (kind === "search") {
    const target = text("pattern") ?? text("query");
    const scope = [path("path"), text("glob")].filter(Boolean).join(" · ");
    return { activityKind: kind, ...(target ? { target } : {}), ...(scope ? { scope } : {}) };
  }
  if (kind === "list") {
    const pattern = text("pattern") ?? text("glob");
    const directory = path("path");
    const target = pattern ?? directory;
    return { activityKind: kind, ...(target ? { target } : {}), ...(pattern && directory ? { scope: directory } : {}) };
  }
  // A generic tool shows one key argument: a known target field, else its first short text argument.
  const key = path("file_path") ?? path("path") ?? text("query") ?? text("url") ?? text("pattern") ?? text("glob") ??
    Object.values(readRecordOrUndefined(value) ?? {}).find((argument): argument is string => typeof argument === "string" && argument.trim() !== "" && argument.length <= 200);
  return key ? { activityKind: "tool", scope: truncate(key, 200) } : {};
}

/** Codex's parsed command actions when they name one read, search or listing. */
export function commandActionDetails(value: unknown, projectRoot: string): ActivityDetails {
  if (!Array.isArray(value) || value.length === 0) return {};
  const actions = value.map(readRecordOrUndefined);
  if (actions.some((action) => !action)) return {};
  const records = actions as Record<string, unknown>[];
  const type = records[0]!.type;
  if (!records.every((action) => action.type === type)) return {};
  const paths = (key: string) => records.map((action) => typeof action[key] === "string" && action[key] ? projectPath(action[key] as string, projectRoot) : undefined);
  if (type === "read") {
    const targets = paths("path");
    return targets.every(Boolean) ? { activityKind: "read", target: truncate([...new Set(targets)].join(", "), 500) } : {};
  }
  if (type === "search" && records.length === 1) {
    const query = typeof records[0]!.query === "string" && records[0]!.query ? truncate(records[0]!.query as string, 200) : undefined;
    const scope = paths("path")[0];
    return { activityKind: "search", ...(query ? { target: query } : {}), ...(scope ? { scope } : {}) };
  }
  if (type === "listFiles" && records.length === 1) {
    const target = paths("path")[0];
    return { activityKind: "list", ...(target ? { target } : {}) };
  }
  return {};
}

function projectPath(path: string, projectRoot: string): string {
  if (!isAbsolute(path)) return truncate(path, 500);
  const inside = relative(projectRoot, path);
  return truncate(inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : path, 500);
}

function durationDetails(value: unknown): ActivityDetails {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { durationMs: Math.round(value) } : {};
}

function errorDetails(value: unknown): ActivityDetails {
  const message = typeof value === "string" ? value : typeof readRecordOrUndefined(value)?.message === "string" ? readRecordOrUndefined(value)!.message as string : "";
  return message.trim() ? { error: truncate(message.trim(), 2000) } : {};
}

/** Plain text of a tool result: a string, or the text parts of an MCP content list. */
function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  const content = readRecordOrUndefined(value)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => {
    const record = readRecordOrUndefined(part);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
  return text || undefined;
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
  if (skills.size > 0) return `Read Skill · ${[...skills].join(", ")}`;
  const runDocument = value.match(/(?:\.agent-factory\/agent|projects\/project-[a-f0-9]{32}\/agents)\/[^/\s'\"]+\/runs\/[^/\s'\"]+\/(request|result)\.md\b/);
  if (runDocument?.[1] === "request") return "Read run request";
  if (runDocument?.[1] === "result") return "Read run result";
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
  return truncate(paths.length > 2 ? `${visible} and ${paths.length - 2} more` : visible, 140);
}

function changesOnlyManagedRunFiles(value: unknown, projectRoot: string): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((change) => {
    const record = readRecordOrUndefined(change);
    if (!record || typeof record.path !== "string") return false;
    const path = relative(projectRoot, record.path).split(sep).join("/");
    return (path.startsWith(".agent-factory/agent/") || /(?:^|\/)projects\/project-[a-f0-9]{32}\/agents\//.test(path)) && path.includes("/runs/");
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

/** The display summary of one loop state; descriptions are bounded and no path or policy leaves the host. */
function projectTaskEntry(state: Record<string, unknown>): ProjectTaskEntry | undefined {
  const workflow = readRecordOrUndefined(state.workflow);
  if (!workflow || typeof workflow.id !== "string" || !MANAGED_ID.test(workflow.id) || typeof workflow.title !== "string" || !Array.isArray(workflow.tasks)) return undefined;
  const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;
  const parentPath = typeof state.parentStatePath === "string" ? state.parentStatePath.split(sep) : [];
  const mainAgentId = parentPath.at(-4);
  const contract = readRecordOrUndefined(state.contract);
  const tasks = workflow.tasks.flatMap(value => {
    const task = readRecordOrUndefined(value);
    if (!task || typeof task.id !== "string" || typeof task.title !== "string") return [];
    return [{ id: task.id, title: task.title.slice(0, 300),
      ...(text(task.description, 4_000) ? { description: text(task.description, 4_000) } : {}),
      ...(typeof task.workStatus === "string" ? { workStatus: task.workStatus } : {}),
      ...(typeof task.verificationStatus === "string" ? { verificationStatus: task.verificationStatus } : {}) }];
  });
  return {
    id: workflow.id, title: workflow.title.slice(0, 300), status: typeof state.status === "string" ? state.status : "unknown", tasks,
    ...(typeof state.createdAt === "string" ? { createdAt: state.createdAt } : {}),
    ...(typeof state.updatedAt === "string" ? { updatedAt: state.updatedAt } : {}),
    ...(mainAgentId && MANAGED_ID.test(mainAgentId) && parentPath.at(-3) === "runs" ? { mainAgentId } : {}),
    ...(contract && typeof contract.id === "string" && contract.id
      ? { contract: { id: contract.id, ...(Number.isInteger(contract.version) ? { version: contract.version as number } : {}) } } : {})
  };
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
  maxOutputBytes: number,
  environment: NodeJS.ProcessEnv = process.env
): Promise<ProcessOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], { stdio: ["ignore", "pipe", "pipe"], env: runtimeEnvironment(environment) });
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
        finishWithError(new Error(localize("ui.agent.factory.runtime.output.exceeded.the.size.limit")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      const wrapped = new Error(localize("ui.unable.to.start.the.agent.factory.runtime.process.0", error.message)) as NodeJS.ErrnoException;
      wrapped.code = (error as NodeJS.ErrnoException).code;
      finishWithError(wrapped);
    });
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
    if (timeoutMs > 0) timer = setTimeout(
      () => finishWithError(new Error(localize("ui.the.agent.factory.runtime.command.timed.out"))),
      timeoutMs
    );
  });
}

function readAcceptance(document: Record<string, unknown>, expectedAgentId: string): RunAcceptance {
  if (
    document.kind !== "ack" ||
    document.status !== "accepted" ||
    document.agentId !== expectedAgentId ||
    !MANAGED_ID.test(expectedAgentId) ||
    typeof document.runId !== "string" ||
    !MANAGED_ID.test(document.runId)
  ) {
    throw new Error(localize("ui.the.agent.factory.runtime.did.not.return.a.valid.run.acceptance.response"));
  }
  return { agentId: document.agentId, runId: document.runId };
}

function imageSuffix(mediaType: RuntimeImageInput["mediaType"]): string {
  const suffix = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[mediaType];
  if (!suffix) throw new Error(localize("ui.unsupported.image.format"));
  return suffix;
}

function runDiagnostics(run: Record<string, unknown>): Pick<RunStatus, "error" | "goalError"> {
  const error = readRecordOrUndefined(run.error);
  return {
    ...(error && typeof error.message === "string" ? { error: { code: String(error.code ?? "runtime_error"), message: error.message } } : {}),
    ...(typeof run.goalError === "string" ? { goalError: run.goalError } : {})
  };
}

function readRunStatus(document: Record<string, unknown>): string {
  const run = readRecord(document.run, "run status");
  if (typeof run.status !== "string") {
    throw new Error(localize("ui.invalid.agent.factory.runtime.execution.status"));
  }
  return run.status;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(localize("ui.invalid.agent.factory.0.format", label));
  }
  return value as Record<string, unknown>;
}

async function realProjectRoot(path: string): Promise<string> {
  return realpath(path);
}

async function checkManagedComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  // realpath validates the full existing chain in one native operation. Do not
  // retain the result across calls: ancestor replacements must remain visible.
  try {
    if (await realpath(absolute) !== absolute) {
      throw new Error(localize("ui.unsafe.link.or.file.type.in.an.agent.factory.managed.path"));
    }
    return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  // Missing/dangling paths still require checking every existing component.
  const parts = absolute.split(sep).filter(Boolean);
  let cursor: string = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (cursor !== absolute && !info.isDirectory())) {
        throw new Error(localize("ui.unsafe.link.or.file.type.in.an.agent.factory.managed.path"));
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

class ManagedFileReplacedError extends Error {}

async function readManagedBytes(path: string, limit: number, start = 0, identity?: string): Promise<Buffer> {
  // Runtime JSON snapshots are published by atomic rename. Reopen and validate
  // a replacement instead of breaking polling on this ordinary writer race.
  // Incremental event reads must retain their original inode/offset binding.
  for (let attempt = 0; ; attempt++) {
    try { return await readManagedBytesOnce(path, limit, start, identity); }
    catch (error) {
      if (!(error instanceof ManagedFileReplacedError) || identity !== undefined || start !== 0 || attempt >= 2) throw error;
    }
  }
}

async function readManagedBytesOnce(path: string, limit: number, start = 0, identity?: string): Promise<Buffer> {
  await checkManagedComponents(path);
  const file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit || start > before.size
        || (identity !== undefined && identity !== `${before.dev}:${before.ino}`) || await realpath(path) !== resolve(path)) {
      throw new Error(localize("ui.unsafe.agent.factory.file.path.or.size"));
    }
    // Grow only when a concurrent append requires it, retaining the limit sentinel.
    let bytes = Buffer.alloc(Math.min(limit - start + 1, before.size - start + 1));
    let offset = 0;
    while (offset < limit - start + 1) {
      if (offset === bytes.length) {
        const grown = Buffer.alloc(Math.min(limit - start + 1, Math.max(bytes.length * 2, 4096)));
        bytes.copy(grown);
        bytes = grown;
      }
      const part = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await lstat(path);
    if (start + offset > limit || after.size > limit || !after.isFile() || after.isSymbolicLink()
        || await realpath(path) !== resolve(path)) {
      throw new Error(localize("ui.the.agent.factory.file.was.replaced.while.being.read"));
    }
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new ManagedFileReplacedError(localize("ui.the.agent.factory.file.was.replaced.while.being.read"));
    }
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
