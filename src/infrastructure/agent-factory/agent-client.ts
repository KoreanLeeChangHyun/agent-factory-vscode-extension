import { codexConnectionEnvironment } from "./codex-connection-host";
import { randomUUID } from "node:crypto";
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
import { lstat, mkdtemp, open as openFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AsyncCache } from "../../common/async-cache";
import { parseInterviewQuestion } from "../../common/types/business-mode";
import type { ActivityDetails as ProtocolActivityDetails, ActivityKind, ProjectDomainEdit, ProjectDomains, ProjectTaskEntry } from "../../protocol/messages";
import {
  DISPATCH_ID,
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

/** Last inference observation for opt-in experiments; never cumulative billing usage. */
export interface ContextObservation {
  readonly usedTokens: number | null;
  readonly contextWindowTokens: number | null;
  readonly observedAt: string | null;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly source: string | null;
  readonly estimated: boolean;
  readonly providerVersion: string | null;
}

export interface HandoffStatus {
  readonly state: null | {
    readonly owner: "A" | "B";
    readonly epoch: number;
    readonly preparation: null | { readonly status: string; readonly slot: "A" | "B" };
  };
  readonly preparationSnapshot: Record<string, unknown> | null;
}

export type RunUpdate =
  | { readonly kind: "contextObservation"; readonly observation: ContextObservation }
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
    readonly capturedRequest?: string;
  }[];
}

export interface ChildAgentSession {
  readonly taskBinding?: Record<string, unknown>;
  readonly parentRunId?: string;
  readonly parentConversationId?: string;
  readonly currentConversation?: boolean;
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
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly verifiedWorkRunId?: string;
  /** Steps the agent's own to-do list reports done; absent when it keeps no list. */
  readonly planProgress?: PlanProgress;
  /** The first line of the agent's latest commentary. */
  readonly activity?: string;
  /** Localizable current phase from this exact run’s provider events. */
  readonly progressKey?: string;
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
  handoff?(agentId: string, action: "status" | "configure" | "ready" | "switch" | "event", payload?: Record<string, unknown>): Promise<HandoffStatus>;
  worktreeRepositories?(): Promise<readonly WorktreeRepository[]>;
  worktree?(agentId: string, action: "status" | "create" | "merge", options?: WorktreeOptions): Promise<ConversationWorktree>;
  conversations?(agentId: string): Promise<readonly SavedConversation[]>;
  history?(agentId: string, options?: { before?: string; limit: number; conversationId?: string | null }): Promise<ConversationHistory>;
  capabilities(agentId?: string, model?: string): Promise<{ readonly submit: ExecutionCapabilities; readonly send: ExecutionCapabilities; readonly executionMode?: "read-only" | "workspace-write" | "danger-full-access" | "bypass" }>;
  submit(agentId: string, message: string, execution: ExecutionOptions, images?: readonly RuntimeImageInput[]): Promise<RunAcceptance>;
  send(agentId: string, message: string, execution: ExecutionOptions, images?: readonly RuntimeImageInput[]): Promise<RunAcceptance>;
  status(agentId: string, runId: string): Promise<RunStatus>;
  /** Resolve a durable dispatch. Only an explicit not-found response proves absence. */
  dispatchAcceptance?(agentId: string, dispatchId: string): Promise<RunAcceptance | undefined>;
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
  deleteTask?(mainAgentId: string, workflowId: string, taskId: string): Promise<Record<string, unknown>>;
  deleteAgent?(agentId: string): Promise<Record<string, unknown>>;
  closeWorkflow?(mainAgentId: string, workAgentId: string, loopId: string): Promise<Record<string, unknown>>;
  decideRevisionLimit?(mainAgentId: string, workAgentId: string, loopId: string, decision: RevisionLimitDecision): Promise<Record<string, unknown>>;
  answerWorkflow?(mainAgentId: string, workAgentId: string, loopId: string, decisionId: string, questionHash: string, answer: string): Promise<Record<string, unknown>>;
  advanceWorkflows?(mainAgentId: string, agents: readonly ChildAgentSession[], drive?: boolean): Promise<readonly Record<string, unknown>[]>;
  listProjectTasks?(): Promise<readonly ProjectTaskEntry[]>;
  listProjectDomains?(): Promise<ProjectDomains | undefined>;
  editProjectDomains?(edit: ProjectDomainEdit): Promise<ProjectDomains>;
  sendWorkerCommand?(agentId: string, text: string, commandId: string, expected?: WorkerCommandTarget): Promise<WorkerCommandResult>;
  stopWorkerTask?(agentId: string, loopId: string, workflowId: string, taskId: string): Promise<Record<string, unknown>>;
  removeWorker?(agentId: string, revision: number): Promise<ProjectDomains>;
  handoffWorker?(agentId: string, loopId: string, toModel: string, reason: string, reference: string): Promise<Record<string, unknown>>;
  superviseProject?(): Promise<Record<string, unknown>>;
  projectTaskRecords?(workflowId: string, taskId: string): Promise<readonly { readonly name: string; readonly path: string }[]>;
}

export interface WorkerCommandResult { readonly mode: "addition" | "task"; readonly loopId: string; readonly runId?: string; readonly taskId?: string;
  readonly rework?: { readonly workflowId: string; readonly taskId: string } }
/** What the sender saw: the running loop/run for an addition, or the ended task a rework revises. */
export interface WorkerCommandTarget { readonly loopId?: string; readonly runId?: string; readonly rework?: { readonly workflowId: string; readonly taskId: string } }

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
    if (value.home !== expectedRuntimeHome()) throw new Error(localize("ui.agent.factory.storage.home.binding.does.not.match"));
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
        roleDirectExceptions: record.roleDirectExceptions === true,
        taskAllocation: record.taskAllocation === true,
        taskDomain: record.taskDomain === true,
        projectDomains: record.projectDomains === true,
        modelRecommendation: record.modelRecommendation === true,
        providerHandoff: record.providerHandoff === true,
        // Missing image metadata means an older runtime contract; an explicit
        // false is a provider limitation (or an unavailable provider CLI).
        images: typeof record.images === "boolean" ? record.images : undefined,
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

  public async handoff(agentId: string, action: "status" | "configure" | "ready" | "switch" | "event", payload?: Record<string, unknown>): Promise<HandoffStatus> {
    const input = payload ? join(tmpdir(), `agent-factory-handoff-${randomUUID()}.json`) : undefined;
    try {
      if (input) await writeFile(input, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const value = await this.command(["handoff", "--project-root", this.projectRoot, "--agent", agentId, action,
        ...(input ? ["--input", input] : [])]);
      const state = readRecordOrUndefined(value.state);
      if (value.kind !== "handoff" || value.schemaVersion !== 1 ||
          (value.state !== null && (!state || !["A", "B"].includes(String(state.owner)) || !Number.isInteger(state.epoch)))) {
        throw new Error("Invalid experimental handoff response");
      }
      return value as unknown as HandoffStatus;
    } finally {
      if (input) await rm(input, { force: true });
    }
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
    this.invalidateCapabilities(agentId);
    this.childSessionCache.deleteWhere(key => (JSON.parse(key) as unknown[])[0] === agentId);
    this.contextUsageSnapshots.clear();
    this.eventSnapshots.clear();
    return { conversationId: document.conversationId, startedAt: document.startedAt };
  }

  private invalidateCapabilities(agentId: string): void {
    this.capabilityCache.deleteWhere((key) => (JSON.parse(key) as unknown[])[1] === agentId);
  }

  private async checkedExecution(command: "submit" | "send", execution: ExecutionOptions, agentId?: string, hasImages = false): Promise<string[]> {
    const supported = (await this.capabilities(agentId, execution.model))[command];
    if (agentId && supported.worktrees === true) this.worktreeAgents.add(agentId);
    else if (agentId) this.worktreeAgents.delete(agentId);
    if (execution.taskMode && !supported.taskModes?.includes(execution.taskMode)) {
      throw new Error(localize("ui.update.the.agent.factory.plugin.and.codex.to.versions.that.support.the.selected.task.mode"));
    }
    if (hasImages && supported.images !== true) {
      if (supported.images === false) {
        throw new Error(supported.diagnostic
          ? localize("ui.image.input.unavailable.0", supported.diagnostic)
          : localize("ui.provider.does.not.support.image.input"));
      }
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
    this.invalidateCapabilities(agentId);
    return { ...readAcceptance(document, agentId), ...(preparationGuidance ? { preparationGuidance } : {}) };
  }

  public async send(agentId: string, message: string, execution: ExecutionOptions, images: readonly RuntimeImageInput[] = []): Promise<RunAcceptance> {
    if (execution.deliveryId !== undefined && !DISPATCH_ID.test(execution.deliveryId)) {
      throw Object.assign(new Error("Invalid engine dispatch identity"), { code: "invalid_dispatch_id" });
    }
    const { document, preparationGuidance } = await this.inputCommand([
      "send",
      "--project-root",
      this.projectRoot,
      "--agent",
      agentId,
      ...(execution.deliveryId ? ["--dispatch-id", execution.deliveryId] : []),
      ...executionPolicyArguments(execution.executionMode),
      ...await this.checkedExecution("send", execution, agentId, images.length > 0)
    ], message, images);
    this.invalidateCapabilities(agentId);
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
    const helper = arguments_.includes("--dispatch-id") ? undefined : sudoHandoffEnvironment().AGENT_FACTORY_SUDO_HELPER;
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
    // macOS /var and redirected Windows TEMP roots can be filesystem aliases.
    // The runtime rejects symlinks in caller paths; canonicalize our staging
    // root without weakening its validation of the contract or sibling images.
    const directory = await mkdtemp(join(await realpath(tmpdir()), "agent-factory-input-"));
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

  public async dispatchAcceptance(agentId: string, dispatchId: string): Promise<RunAcceptance | undefined> {
    if (!DISPATCH_ID.test(dispatchId)) throw Object.assign(new Error("Invalid engine dispatch identity"), { code: "invalid_dispatch_id" });
    try {
      const document = await this.command(["status", "--project-root", this.projectRoot,
        "--agent", agentId, "--dispatch-id", dispatchId]);
      const run = readRecord(document.run, "dispatch run");
      if (run.agentId !== agentId || run.dispatchId !== dispatchId || !MANAGED_ID.test(agentId)
          || typeof run.runId !== "string" || !MANAGED_ID.test(run.runId)) {
        throw new Error("Invalid dispatch acceptance response");
      }
      return { agentId, runId: run.runId };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "dispatch_not_found") return undefined;
      throw error;
    }
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
    const lines = await this.readEventLines(path, cursor);
    if (!lines) return { cursor, updates: [] };
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

  private async readEventLines(path: string, cursor?: number): Promise<readonly string[] | undefined> {
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
        const incremental = cached && (cursor === undefined || (cursor > 0 && cursor >= cached.lines.length))
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
        return undefined;
      }
      throw error;
    }
    return lines;
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

  public async deleteTask(mainAgentId: string, workflowId: string, taskId: string): Promise<Record<string, unknown>> {
    if (![mainAgentId, workflowId, taskId].every(id => MANAGED_ID.test(id))) throw new Error("Invalid task history identity");
    const result = await this.command(["delete-task", "--project-root", this.projectRoot, "--main-agent", mainAgentId,
      "--workflow-id", workflowId, "--task-id", taskId, "--actor", "human",
      "--authorization-reference", `task-history-trash:${mainAgentId}/${workflowId}/${taskId}`]);
    if (result.kind !== "task-history-deleted" || result.mainAgentId !== mainAgentId || result.workflowId !== workflowId || result.taskId !== taskId) {
      throw new Error("Task deletion acknowledgement does not match the selected history");
    }
    this.invalidateDeletedHistory();
    return result;
  }

  public async deleteAgent(agentId: string): Promise<Record<string, unknown>> {
    if (!MANAGED_ID.test(agentId)) throw new Error("Invalid agent deletion identity");
    const result = await this.command(["delete-agent", "--project-root", this.projectRoot, "--agent", agentId,
      "--actor", "human", "--authorization-reference", `sidebar-trash:${agentId}`]);
    if (result.kind !== "agent-deleted" || result.agentId !== agentId) {
      throw new Error("Agent deletion acknowledgement does not match the selected agent");
    }
    this.invalidateDeletedHistory();
    this.capabilityCache.deleteWhere(key => (JSON.parse(key) as unknown[])[1] === agentId);
    return result;
  }

  private invalidateDeletedHistory(): void {
    this.projectTaskCache.deleteWhere(() => true);
    this.agentListCache.deleteWhere(() => true);
    this.childSessionCache.deleteWhere(() => true);
    this.workflowRefreshCache.deleteWhere(() => true);
    this.statusCache.deleteWhere(() => true);
    this.workflowSnapshots.clear();
    this.statusSnapshots.clear();
    this.runStateSnapshots.clear();
    this.runStateSnapshotBytes = 0;
    this.directorySnapshots.clear();
    this.directorySnapshotEntries = 0;
    this.observedChildRuns.dispose();
    this.childEventSnapshots.clear();
    this.eventSnapshots.clear();
    this.contextUsageSnapshots.clear();
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

  public async answerWorkflow(mainAgentId: string, workAgentId: string, loopId: string, decisionId: string, questionHash: string, answer: string): Promise<Record<string, unknown>> {
    const path = await this.managedPath(workAgentId, "loops", loopId, "state.json");
    const state = readRecord(JSON.parse((await readManagedBytes(path, MAX_RESULT_BYTES)).toString("utf8")), "workflow");
    const decisions = readRecord(state.decisions, "workflow decisions");
    const decision = readRecord(decisions[decisionId], "workflow decision");
    if (decision.questionHash !== questionHash || !answer.trim()) throw new Error("Decision question changed; reload it before answering");
    const task = readRecord(decision.taskBinding, "decision task");
    const response = { decisionId, questionHash, answer, projectRoot: this.projectRoot, loopId, taskId: task.taskId, runId: decision.runId };
    return this.workflowDecision(mainAgentId, workAgentId, loopId, "answer", ["--response-json", JSON.stringify(response)], answer, "Workflow answer failed");
  }

  /** Run a Human-only loop command bound to the Main run that started the workflow, with the click as decision evidence. */
  private async workflowDecision(mainAgentId: string, workAgentId: string, loopId: string, command: "close" | "extend-revisions" | "stop-task" | "answer",
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
    const snapshot = readLoopOutput(output, failure);
    snapshot.parentConversationId = parent.conversationId ?? null;
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
    return this.workflowRefreshCache.get(JSON.stringify([mainAgentId, identity, drive]), () => this.refreshWorkflows(mainAgentId, agents, drive, !drive));
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
        // The runtime creates the loop directory before publishing its state;
        // a loop without state yet is listed on a later refresh.
        let info;
        try { info = await lstat(path); }
        catch (error) { if (isMissingFile(error)) continue; throw error; }
        if (info.size > MAX_RESULT_BYTES) throw new Error("Workflow state exceeds limit");
        const fileSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const cached = this.workflowSnapshots.get(path);
        let state: Record<string, unknown>;
        if (cached?.signature.startsWith(fileSignature + "|")) state = cached.state;
        else {
          try { state = readRecord(JSON.parse((await readManagedBytes(path, MAX_RESULT_BYTES)).toString("utf8")), "workflow"); }
          catch (error) { if (isMissingFile(error)) continue; throw error; }
        }
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
          "status", "--project-root", this.projectRoot,
          "--runtime-home", location.home, "--project-id", location.projectId,
          "--work-agent", agentId, "--loop-id", entry.name], COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES,
          { ...pluginRuntimeEnvironment(this.developmentRoot),
            AGENT_FACTORY_PARENT_STATE: state.parentStatePath,
            AGENT_FACTORY_EXECUTION_POLICY: JSON.stringify(policy) });
        const snapshot = readLoopOutput(output, "Workflow reconciliation failed");
        snapshot.parentConversationId = parent.conversationId ?? null;
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
        try { state = await this.cachedRunState(await this.managedPath(agent.name, "loops", loop.name, "state.json"), Infinity); }
        catch (error) { if (isMissingFile(error)) continue; throw error; }
        const entry = state && projectTaskEntry(state, agent.name, loop.name);
        if (entry) for (const task of entry.tasks) {
          const original = (readRecordOrUndefined(state?.workflow)?.tasks as Record<string, unknown>[]).find(value => value.id === task.id);
          const runs: import("../../protocol/messages").ProjectTaskRun[] = [];
          for (const role of ["work", "verification"] as const) {
            const agentId = original?.[role + "AgentId"] ?? state?.[role + "AgentId"];
            const runId = original?.[role + "RunId"];
            if (typeof agentId !== "string" || !MANAGED_ID.test(agentId) || typeof runId !== "string" || !MANAGED_ID.test(runId)) continue;
            const run = await this.cachedRunState(await this.managedPath(agentId, "runs", runId, "state.json"), Infinity).catch(error => { if (isMissingFile(error)) return undefined; throw error; });
            if (!run || run.agentId !== agentId || run.runId !== runId || run.role !== role) continue;
            const binding = readRecordOrUndefined(run.taskBinding);
            if (binding?.workflowId !== entry.id || binding?.taskId !== task.id) continue;
            const receipt = await this.cachedRunState(await this.managedPath(agentId, "runs", runId, "receipt.json"), Infinity).catch(error => { if (isMissingFile(error)) return undefined; throw error; });
            const projected = projectTaskRun(run, receipt, typeof original?.workRunId === "string" ? original.workRunId : undefined);
            // Use the existing managed result reader; a missing/error result is distinct from an empty result.
            let result: import("../../protocol/messages").ProjectTaskRun["result"];
            if (typeof run.resultPath === "string") {
              try {
                const text = await this.readManagedResult(run.resultPath, agentId, runId);
                const summary = resultSummaryLine(text);
                const highlight = resultHighlight(text);
                result = { availability: "recorded", ...(summary ? { summary: truncate(summary, 240) } : {}), ...(highlight ? { highlight: truncate(highlight, 160) } : {}) };
              } catch (error) {
                result = isMissingFile(error) ? { availability: "missing" } : { availability: "error", error: String(error) };
              }
            }
            // The request this run received; only its presence is projected, the text opens from the exact run.
            const requestPath = await this.managedPath(agentId, "runs", runId, "request.md");
            const request = await lstat(requestPath).then(() => ({ availability: "recorded" as const }), error => {
              if (isMissingFile(error)) return { availability: "missing" as const };
              throw error;
            });
            runs.push({ ...projected, ...(result ? { result } : {}), request });
          }
          const workspace = readRecordOrUndefined(readRecordOrUndefined(state?.taskWorkspaces)?.[task.id]);
          const integration = Array.isArray(workspace?.repositories) ? workspace.repositories.flatMap(value => {
            const unit = readRecordOrUndefined(value);
            if (!unit || typeof unit.repositoryRoot !== "string") return [];
            return [{ repository: unit.repositoryRoot, ...(typeof unit.phase === "string" ? { phase: unit.phase } : {}),
              ...(typeof unit.mergeCommit === "string" ? { mergeCommit: unit.mergeCommit } : {}) }];
          }) : undefined;
          Object.assign(task, { runs, ...(integration ? { integration } : {}), commands: projectTaskCommands(state ?? {}, task, runs) });
        }
        // A brief re-dispatched in a newer loop keeps one row: the most recent state wins.
        if (entry && !((latest.get(entry.id)?.updatedAt ?? "") > (entry.updatedAt ?? ""))) latest.set(entry.id, entry);
      }
    }
    return [...latest.values()].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.id.localeCompare(right.id));
  }

  /** The shared editable domain list, or undefined when the installed plugin has no domains.py. */
  public async listProjectDomains(): Promise<ProjectDomains | undefined> {
    const script = join(dirname(this.execPath), "domains.py");
    try { await lstat(script); } catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    return projectDomains(readRecord((await this.domainsCommand(["list"])).domains, "project domains"));
  }

  /** Control-center edits are the Human's (actor human); the plugin protects them from later Main writes. */
  public async editProjectDomains(edit: ProjectDomainEdit): Promise<ProjectDomains> {
    const write = ["--actor", "human", "--source", "control-center", "--expected-revision", String(edit.revision)];
    // Only the real-domain calls: create with a name, rename, assign to a listed domain (no --placeholder/--unclassified).
    const command = edit.type === "domain.create" ? ["create", ...write, "--name", edit.name]
      : edit.type === "domain.rename" ? ["rename", ...write, "--domain-id", edit.domainId, "--name", edit.name]
        : ["assign", ...write, "--agent", edit.agentId, "--domain-id", edit.domainId];
    const result = await this.domainsCommand(command);
    const changed = typeof result.domainId === "string" && /^domain-[0-9a-f]{12}$/.test(result.domainId) ? { changedDomainId: result.domainId } : {};
    return { ...projectDomains(readRecord(result.domains, "project domains")), ...changed };
  }

  /** The Human removes a stopped worker from the worker list; the plugin refuses while it still runs. */
  public async removeWorker(agentId: string, revision: number): Promise<ProjectDomains> {
    if (!MANAGED_ID.test(agentId)) throw new Error("Invalid worker identity");
    const result = await this.domainsCommand(["remove-worker", "--actor", "human", "--source", "control-center", "--expected-revision", String(revision), "--agent", agentId]);
    return projectDomains(readRecord(result.domains, "project domains"));
  }

  /**
   * The Human's instruction to a worker. A running loop of this worker receives it as a bound addition at the next
   * safe Work turn (loop steer, recorded as queued then delivered). An idle worker gets a new task in the same session
   * through loop start, reusing its latest loop's model, effort, permissions and parent policy.
   */
  public async sendWorkerCommand(agentId: string, text: string, commandId: string, expected: WorkerCommandTarget = {}): Promise<WorkerCommandResult> {
    if (!MANAGED_ID.test(agentId) || !text.trim() || !/^[A-Za-z0-9-]{8,64}$/.test(commandId)) throw new Error("Invalid worker command");
    const loops = await this.workerLoops(agentId);
    const active = loops.filter(loop => loop.state.status === "active");
    if (active.length > 1) throw Object.assign(new Error("This worker has more than one active task; send from the task instead"), { code: "worker_command_ambiguous" });
    const reference = `control-center:${agentId}:${commandId}`;
    // A rework starts a new task linked to the ended one; it never becomes an addition to whatever runs now.
    if (expected.rework) {
      if (expected.loopId || expected.runId) throw new Error("Invalid worker command");
      if (active.length) throw Object.assign(new Error("The worker is running another task; send the rework after it ends"), { code: "worker_rework_busy" });
      const { workflowId, taskId } = expected.rework;
      const origin = loops.filter(loop => {
        const workflow = readRecordOrUndefined(loop.state.workflow);
        return workflow?.id === workflowId && Array.isArray(workflow.tasks) && workflow.tasks.some(task => readRecordOrUndefined(task)?.id === taskId);
      }).sort((left, right) => String(right.state.createdAt ?? "").localeCompare(String(left.state.createdAt ?? "")))[0];
      if (!origin) throw Object.assign(new Error("This task does not belong to the selected worker"), { code: "worker_rework_scope" });
      const task = readRecord((readRecord(origin.state.workflow, "loop workflow").tasks as unknown[]).find(value => readRecordOrUndefined(value)?.id === taskId), "task");
      // The new request names the earlier task so its records stay the reference; earlier results are not rewritten.
      const header = [`Rework of task ${taskId} (${typeof task.title === "string" ? task.title : "untitled"})`,
        `Earlier workflow ${workflowId}, loop ${origin.id}${typeof origin.state.latestWorkRunId === "string" ? `, latest Work run ${origin.state.latestWorkRunId}` : ""}.`,
        "Read that task's recorded result first. Where this instruction differs from the earlier request, this instruction applies."].join("\n");
      const started = await this.startWorkerTask(agentId, origin.state, `${header}\n\n${text}`);
      return { ...started, rework: { workflowId, taskId } };
    }
    if (active[0]) {
      const { id, state } = active[0];
      const task = readRecord(readRecord(state.execution, "loop execution").taskBinding, "task binding");
      const runId = state.latestWorkRunId;
      if (typeof runId !== "string" || typeof task.taskId !== "string") throw Object.assign(new Error("The running task has no Work run to receive an addition yet"), { code: "worker_command_not_ready" });
      // The target the Human saw must still be current: a different loop or run means the screen is stale.
      if ((expected.loopId && expected.loopId !== id) || (expected.runId && expected.runId !== runId)) {
        throw Object.assign(new Error("The worker's running task changed; reload before sending"), { code: "worker_command_stale" });
      }
      await this.controlLoopCommand(agentId, id, state, "steer", ["--actor", "human", "--authorization-reference", reference,
        "--decision-evidence", "Human instruction from the control center", "--task-id", task.taskId, "--run-id", runId, "--message", text]);
      this.projectTaskCache.deleteWhere(() => true);
      return { mode: "addition", loopId: id, runId, taskId: task.taskId };
    }
    if (expected.loopId || expected.runId) throw Object.assign(new Error("The worker's task already ended; reload before sending"), { code: "worker_command_stale" });
    const latest = loops.sort((left, right) => String(right.state.createdAt ?? "").localeCompare(String(left.state.createdAt ?? "")))[0];
    if (!latest) throw Object.assign(new Error("This worker has no recorded task to take its settings from"), { code: "worker_command_unsupported" });
    return this.startWorkerTask(agentId, latest.state, text);
  }

  /** New task in the worker's own session, with the model, effort, approval policy and profile of the given loop. */
  private async startWorkerTask(agentId: string, source: Record<string, unknown>, text: string): Promise<WorkerCommandResult> {
    const execution = readRecord(source.execution, "loop execution");
    const models = readRecordOrUndefined(readRecordOrUndefined(execution.agentModels)?.work);
    const permissions = readRecordOrUndefined(readRecordOrUndefined(execution.agentPermissions)?.work);
    const options = [
      ...(typeof models?.model === "string" ? ["--work-model", models.model] : []),
      ...(typeof models?.reasoningEffort === "string" ? ["--work-reasoning-effort", models.reasoningEffort] : []),
      ...(typeof permissions?.humanApprovalPolicy === "string" ? ["--work-execution-mode", permissions.humanApprovalPolicy] : []),
      ...(typeof execution.workProfile === "string" ? ["--work-profile", execution.workProfile] : [])];
    const directory = await mkdtemp(join(tmpdir(), "af-worker-command-"));
    try {
      const request = join(directory, "request.md");
      await writeFile(request, text, { mode: 0o600 });
      const started = await this.controlLoopCommand(agentId, undefined, source, "start", ["--requested-by", "human", "--task-mode", "work",
        "--request-file", request, "--receipt-recovery", "auto", ...options]);
      this.projectTaskCache.deleteWhere(() => true);
      if (typeof started.loopId !== "string") throw new Error("The new task was not accepted");
      return { mode: "task", loopId: started.loopId };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  /** Stop exactly one worker task: the loop records the Human stop first, then cancels its own current child run. */
  public async stopWorkerTask(agentId: string, loopId: string, workflowId: string, taskId: string): Promise<Record<string, unknown>> {
    const loop = (await this.workerLoops(agentId)).find(value => value.id === loopId);
    const workflow = readRecordOrUndefined(loop?.state.workflow);
    if (!loop || workflow?.id !== workflowId || !(Array.isArray(workflow.tasks) && workflow.tasks.some(task => readRecordOrUndefined(task)?.id === taskId))) {
      throw Object.assign(new Error("This task does not belong to the selected worker"), { code: "worker_stop_scope" });
    }
    const result = await this.controlLoopCommand(agentId, loopId, loop.state, "stop-task", ["--actor", "human",
      "--authorization-reference", `control-center:${agentId}:${loopId}:stop`, "--decision-evidence", "Human selected Force stop in the control center",
      "--workflow-id", workflowId, "--task-id", taskId]);
    this.invalidateDeletedHistory();
    return result;
  }

  private async workerLoops(agentId: string): Promise<{ id: string; state: Record<string, unknown> }[]> {
    const directory = await this.managedPath(agentId, "loops").catch(error => { if (isMissingFile(error)) return undefined; throw error; });
    if (!directory) return [];
    const loops: { id: string; state: Record<string, unknown> }[] = [];
    for (const entry of await this.managedDirectoryEntries(directory).catch(error => { if (isMissingFile(error)) return []; throw error; })) {
      if (!entry.isDirectory() || !MANAGED_ID.test(entry.name)) continue;
      const path = await this.managedPath(agentId, "loops", entry.name, "state.json");
      try { loops.push({ id: entry.name, state: readRecord(JSON.parse((await readManagedBytes(path, MAX_RESULT_BYTES)).toString("utf8")), "loop") }); }
      catch (error) { if (!isMissingFile(error)) throw error; }
    }
    return loops;
  }

  /** Run loop.py for a worker with the loop's own parent Main run and policy, verified to lie inside this project's records. */
  private async controlLoopCommand(agentId: string, loopId: string | undefined, state: Record<string, unknown>, command: "steer" | "stop-task" | "start" | "handoff", extra: readonly string[]): Promise<Record<string, unknown>> {
    const location = await this.location();
    const environment: Record<string, string | undefined> = { ...pluginRuntimeEnvironment(this.developmentRoot) };
    // Only this loop's own parent and policy apply; never ones inherited from the extension host's environment.
    delete environment.AGENT_FACTORY_PARENT_STATE;
    delete environment.AGENT_FACTORY_EXECUTION_POLICY;
    const parentPath = typeof state.parentStatePath === "string" ? state.parentStatePath : "";
    const parts = parentPath.split(sep);
    if (parentPath && parts.at(-3) === "runs" && MANAGED_ID.test(parts.at(-4) ?? "") && MANAGED_ID.test(parts.at(-2) ?? "")
        && parentPath === await this.managedPath(parts.at(-4)!, "runs", parts.at(-2)!, "state.json")) {
      // A Main run whose records are gone cannot be the parent; the loop's own captured policy then applies.
      const parent = await readManagedBytes(parentPath, MAX_RESULT_BYTES).then(bytes => readRecordOrUndefined(JSON.parse(bytes.toString("utf8"))),
        error => { if (isMissingFile(error)) return undefined; throw error; });
      if (parent) environment.AGENT_FACTORY_PARENT_STATE = parentPath;
      if (parent?.executionPolicy) environment.AGENT_FACTORY_EXECUTION_POLICY = JSON.stringify(parent.executionPolicy);
    }
    const policy = readRecordOrUndefined(state.execution)?.executionPolicy;
    if (!environment.AGENT_FACTORY_EXECUTION_POLICY && policy) environment.AGENT_FACTORY_EXECUTION_POLICY = JSON.stringify(policy);
    const output = await runBoundedProcess(this.pythonCommand, [join(dirname(this.execPath), "loop.py"), command,
      "--project-root", this.projectRoot, "--runtime-home", location.home, "--project-id", location.projectId,
      "--work-agent", agentId, ...(loopId ? ["--loop-id", loopId] : []), ...extra], COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES, environment);
    let value: Record<string, unknown> | undefined;
    try { value = readRecordOrUndefined(JSON.parse(output.stdout)); } catch { value = undefined; }
    const failure = readRecordOrUndefined(value?.error);
    if (output.exitCode !== 0 || !value || value.kind === "error") {
      throw Object.assign(new Error(typeof failure?.message === "string" ? failure.message : output.stderr.trim() || `exit code ${output.exitCode}`),
        { code: typeof failure?.code === "string" ? failure.code : "worker_control_failed" });
    }
    return value;
  }

  /**
   * The Human moves the current Work task of one loop to a new session on another provider or model. The loop must
   * belong to this worker and not have ended; the plugin stops the current Work run first and records the handoff.
   */
  public async handoffWorker(agentId: string, loopId: string, toModel: string, reason: string, reference: string): Promise<Record<string, unknown>> {
    if (!MANAGED_ID.test(agentId) || !MANAGED_ID.test(loopId)) throw new Error("Invalid worker identity");
    const loop = (await this.workerLoops(agentId)).find(value => value.id === loopId);
    if (!loop || ["completed", "cancelled"].includes(String(loop.state.status))) {
      throw Object.assign(new Error("This worker has no running or stopped task in that loop"), { code: "worker_handoff_scope" });
    }
    // A new session ID for the receiving side; the earlier session and its records stay unchanged.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const toAgent = `work-handoff-${stamp}-${randomUUID().slice(0, 8)}`;
    const result = await this.controlLoopCommand(agentId, loopId, loop.state, "handoff", ["--actor", "human",
      "--authorization-reference", reference, "--decision-evidence", "Human selected Provider handoff in the control center",
      "--to-agent", toAgent, "--to-model", toModel, "--reason", reason]);
    this.projectTaskCache.deleteWhere(() => true);
    return readRecordOrUndefined(result.handoff) ?? { toAgentId: toAgent, toModel };
  }

  /** Read-only supervision verdicts of every unfinished loop; --dry-run appends no report. */
  public async superviseProject(): Promise<Record<string, unknown>> {
    const location = await this.location();
    const output = await runBoundedProcess(this.pythonCommand, [join(dirname(this.execPath), "operation_records.py"), "supervise",
      "--project-root", this.projectRoot, "--runtime-home", location.home, "--project-id", location.projectId, "--dry-run"],
    COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES, pluginRuntimeEnvironment(this.developmentRoot));
    let value: Record<string, unknown> | undefined;
    try { value = readRecordOrUndefined(JSON.parse(output.stdout)); } catch { value = undefined; }
    const failure = readRecordOrUndefined(value?.error);
    if (output.exitCode !== 0 || !value || value.kind !== "supervision") {
      throw Object.assign(new Error(typeof failure?.message === "string" ? failure.message : output.stderr.trim() || `exit code ${output.exitCode}`),
        { code: typeof failure?.code === "string" ? failure.code : "supervision_failed" });
    }
    return projectSupervision(value);
  }

  private async domainsCommand(command: readonly string[]): Promise<Record<string, unknown>> {
    const location = await this.location();
    const output = await runBoundedProcess(this.pythonCommand, [join(dirname(this.execPath), "domains.py"), ...command.slice(0, 1),
      "--project-root", this.projectRoot, "--runtime-home", location.home, "--project-id", location.projectId, ...command.slice(1)],
    COMMAND_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES, pluginRuntimeEnvironment(this.developmentRoot));
    let value: Record<string, unknown> | undefined;
    try { value = readRecordOrUndefined(JSON.parse(output.stdout)); } catch { value = undefined; }
    const failure = readRecordOrUndefined(value?.error);
    if (output.exitCode !== 0 || !value || value.kind === "error") {
      const code = typeof failure?.code === "string" ? failure.code : typeof value?.code === "string" ? value.code : "";
      const message = typeof failure?.message === "string" ? failure.message : typeof value?.message === "string" ? value.message : output.stderr.trim() || `exit code ${output.exitCode}`;
      throw Object.assign(new Error(message), { code });
    }
    return value;
  }

  public async projectTaskRecords(workflowId: string, taskId: string): Promise<readonly { name: string; path: string }[]> {
    const entry = (await this.listProjectTasks()).find(value => value.id === workflowId);
    const task = entry?.tasks.find(value => value.id === taskId);
    if (!entry || !task || !entry.workAgentId || !entry.loopId) return [];
    const records = [{ name: "Loop state", path: await this.managedPath(entry.workAgentId, "loops", entry.loopId, "state.json") }];
    for (const run of task.runs ?? []) for (const name of ["request.md", "state.json", "events.jsonl", "result.md", "receipt.json"]) {
      const path = await this.managedPath(run.agentId, "runs", run.runId, name);
      try { await lstat(path); records.push({ name: `${run.role} · ${run.runId} · ${name}`, path }); }
      catch (error) { if (!isMissingFile(error)) throw error; }
    }
    return records;
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
    const mainSession = await this.managedPath(mainAgentId, "session.json").then(path => this.cachedRunState(path)).catch(error => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    const sessions = await Promise.all([...referenced.keys()].map(async agentId => {
      try { return await this.cachedRunState(await this.managedPath(agentId, "session.json")); }
      catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    }));
    const document = sessions.every(Boolean) ? { agents: sessions } : await this.listAgentsDocument();
    if (!Array.isArray(document.agents)) {
      throw new Error(localize("ui.invalid.agent.factory.session.list.response"));
    }
    const agents: ChildAgentSession[] = [];
    const parentModes = new Map<string, TaskMode | undefined>();
    const parentConversations = new Map<string, string | undefined>();
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
          parentConversations.set(parentRunId, typeof parent.conversationId === "string" ? parent.conversationId : undefined);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          parentModes.set(parentRunId, undefined);
        }
      }
      agents.push({
        parentRunId,
        ...(parentRunId && (parentConversations.get(parentRunId) !== undefined || mainSession?.conversationId !== undefined)
          ? { parentConversationId: parentConversations.get(parentRunId),
          currentConversation: parentConversations.get(parentRunId) === mainSession?.conversationId } : {}),
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
        ...(latest.startedAt ? { startedAt: latest.startedAt } : {}),
        ...(latest.finishedAt ? { finishedAt: latest.finishedAt } : {}),
        ...(latest.planProgress ? { planProgress: latest.planProgress } : {}),
        ...(latest.activity ? { activity: latest.activity } : {}),
        ...(latest.progressKey ? { progressKey: latest.progressKey } : {}),
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
        .sort((left, right) => right.name.localeCompare(left.name));
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

  private async cachedRunState(path: string, maxBytes = 256 * 1024): Promise<Record<string, unknown> | undefined> {
    const before = await lstat(path);
    if (!before.isFile() || before.size > maxBytes) {
      this.deleteRunStateSnapshot(path);
      return undefined;
    }
    const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = this.runStateSnapshots.get(path);
    if (cached?.signature === signature) return cached.value;
    const content = await readManagedBytes(path, maxBytes);
    const value = readRecordOrUndefined(JSON.parse(content.toString("utf8")));
    const after = await lstat(path);
    this.deleteRunStateSnapshot(path);
    if (value && signature === `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`) {
      this.runStateSnapshots.set(path, { signature, value, bytes: content.length });
      this.runStateSnapshotBytes += content.length;
      // A history scan can use four records per run (reference, session,
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

  private async childProgressKey(agentId: string, runId: string): Promise<string> {
    try {
      const path = await this.managedPath(agentId, "runs", runId, "events.jsonl");
      const lines = await this.readEventLines(path) || [];
      for (let index = lines.length - 1; index >= 0; index--) {
        let event: Record<string, unknown> | undefined;
        try { event = readRecordOrUndefined(JSON.parse(lines[index]!)); } catch { continue; }
        if (!event) continue;
        if (event.type === "turn.started") return "flow.activity.analyzing";
        if (event.type === "thread.started" || event.type === "native.commentary") return "ui.working";
        if (event.type === "turn.completed") return "ui.finalizing.response";
        if (event.type === "native.delta" && event.stream === "final") return "ui.finalizing.response";
        if (event.type !== "item.started" && event.type !== "item.completed") continue;
        const item = readRecordOrUndefined(event.item);
        if (!item) continue;
        const completed = event.type === "item.completed";
        const failed = item.status === "failed" || item.status === "declined" ||
          (completed && typeof item.exit_code === "number" && item.exit_code !== 0);
        if (item.type === "reasoning") return "flow.activity.reasoning";
        if (item.type === "agent_message") return "ui.finalizing.response";
        if (item.type === "command_execution") return failed ? "ui.checking.command.failure" : completed ? "ui.analyzing.results" : "ui.running.command";
        if (item.type === "mcp_tool_call") return failed || (completed && item.error != null) ? "ui.checking.connected.tool.failure" : completed ? "ui.analyzing.results" : "ui.running.connected.tool";
        if (item.type === "file_change") return completed ? "ui.checking.git.changes" : "ui.applying.git.changes";
        if (item.type === "webSearch" || item.type === "web_search") return completed ? "ui.analyzing.results" : "ui.searching.the.web";
        if (item.type === "contextCompaction") return completed ? "ui.context.compaction.completed" : "ui.context.compaction.started";
      }
    } catch {
      // Missing/unsafe or temporarily unavailable events must not hide a task.
    }
    return "ui.working";
  }

  private async latestRunInfo(agentId: string, runId?: string): Promise<{ readonly status: string; readonly runId?: string; readonly verifiedWorkRunId?: string; readonly parentAgentId?: string; readonly parentRunId?: string; readonly taskBinding?: Record<string, unknown>; readonly model?: string; readonly reasoningEffort?: string; readonly workProfile?: WorkProfile; readonly dispatchedAt?: string; readonly startedAt?: string; readonly finishedAt?: string; readonly planProgress?: PlanProgress; readonly activity?: string; readonly progressKey?: string }> {
    const runsDirectory = await this.managedPath(agentId, "runs");
    try {
      const runs = runId ? [{ name: runId }] : (await this.managedDirectoryEntries(runsDirectory))
        .filter((entry) => entry.isDirectory() && MANAGED_ID.test(entry.name) && (runId === undefined || entry.name === runId))
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const run of runs.slice(0, 100)) {
        const statePath = await this.managedPath(agentId, "runs", run.name, "state.json");
        try {
          // Task descriptions can exceed the ordinary metadata budget. Keep the
          // cache bounded, but preserve full task data for indexing and detail UI.
          const state = await this.cachedRunState(statePath, Infinity);
          if (typeof state?.status === "string" && state.status) {
            const executionOptions = readRecordOrUndefined(state.executionOptions);
            return {
              ...(readRecordOrUndefined(state.taskBinding) ? { taskBinding: readRecordOrUndefined(state.taskBinding) } : {}),
              status: state.status,
              ...(state.status === "running" ? { progressKey: await this.childProgressKey(agentId, run.name) } : {}),
              runId: run.name,
              ...(typeof executionOptions?.model === "string" && executionOptions.model ? { model: executionOptions.model } : {}),
              ...(typeof executionOptions?.reasoningEffort === "string" && executionOptions.reasoningEffort ? { reasoningEffort: executionOptions.reasoningEffort } : {}),
              ...(parseWorkProfile(state.workProfile) ? { workProfile: parseWorkProfile(state.workProfile) } : {}),
              ...(typeof state.acceptedAt === "string" && state.acceptedAt ? { dispatchedAt: state.acceptedAt } : {}),
              ...(typeof state.startedAt === "string" ? { startedAt: state.startedAt } : {}),
              ...(typeof state.finishedAt === "string" ? { finishedAt: state.finishedAt } : {}),
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
      throw Object.assign(new Error(message || localize("ui.the.agent.factory.runtime.command.failed.with.exit.code.0", output.exitCode)), {
        code: typeof nested?.code === "string" ? nested.code : typeof record.code === "string" ? record.code : undefined
      });
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
  if (event.type === "provider.context") {
    return [{ kind: "contextObservation", observation: {
      usedTokens: readTokenCount(event.usedTokens) ?? null,
      contextWindowTokens: readTokenCount(event.contextWindowTokens) ?? null,
      observedAt: typeof event.observedAt === "string" ? event.observedAt : null,
      sessionId: typeof event.session_id === "string" ? event.session_id : null,
      turnId: typeof event.turn_id === "string" ? event.turn_id : null,
      source: typeof event.source === "string" ? event.source : null,
      estimated: event.estimated !== false,
      providerVersion: typeof event.providerVersion === "string" ? event.providerVersion : null
    } }];
  }
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

/** Read-only loop projection preserving complete briefs; private paths remain in the host. */
function projectTaskEntry(state: Record<string, unknown>, workAgentId?: string, loopId?: string): ProjectTaskEntry | undefined {
  const workflow = readRecordOrUndefined(state.workflow);
  if (!workflow || typeof workflow.id !== "string" || !MANAGED_ID.test(workflow.id) || typeof workflow.title !== "string" || !Array.isArray(workflow.tasks)) return undefined;
  const parentPath = typeof state.parentStatePath === "string" ? state.parentStatePath.split(sep) : [];
  const mainAgentId = parentPath.at(-4);
  const contract = readRecordOrUndefined(state.contract);
  const tasks = workflow.tasks.flatMap(value => {
    const task = readRecordOrUndefined(value);
    if (!task || typeof task.id !== "string" || typeof task.title !== "string") return [];
    // The existing control-center contract uses the loop's explicit role binding when a task has no override.
    const assignedWork = task.workAgentId ?? state.workAgentId;
    const assignedVerification = task.verificationAgentId ?? state.verificationAgentId;
    const allocation = projectTaskAllocation(task.allocation);
    return [{ id: task.id, title: task.title,
      // The work area Main recorded at assignment; absent means none was recorded, and it is never inferred.
      ...(typeof allocation?.domain === "string" ? { domain: allocation.domain } : {}),
      ...(typeof task.description === "string" ? { description: task.description } : {}),
      ...(typeof task.completionCriteria === "string" ? { completionCriteria: task.completionCriteria } : {}),
      ...(allocation ? { allocation } : {}),
      ...(typeof task.workStatus === "string" ? { workStatus: task.workStatus } : {}),
      ...(typeof assignedWork === "string" && MANAGED_ID.test(assignedWork) ? { workAgentId: assignedWork } : {}),
      ...(typeof assignedVerification === "string" && MANAGED_ID.test(assignedVerification) ? { verificationAgentId: assignedVerification } : {}),
      ...(["work", "plan-work"].includes(String(readRecordOrUndefined(state.execution)?.taskMode))
        ? { verificationDisposition: "not-requested" as const }
        : state.humanSkip && task.verificationStatus !== "completed" && task.workStatus === "completed"
          ? { verificationDisposition: "human-skipped" as const } : {}),
      ...(typeof task.verificationStatus === "string" ? { verificationStatus: task.verificationStatus } : {}) }];
  });
  return {
    id: workflow.id, title: workflow.title, ...(workAgentId ? { workAgentId } : {}), ...(loopId ? { loopId } : {}),
    ...(state.requestedBy === "human" ? { requestedBy: "human" as const } : {}),
    ...(typeof state.latestWorkRunId === "string" && MANAGED_ID.test(state.latestWorkRunId) ? { latestWorkRunId: state.latestWorkRunId } : {}),
    ...(Array.isArray(state.handoffs) && state.handoffs.length ? { handoffs: projectTaskHandoffs(state.handoffs) } : {}),
    ...(typeof state.phase === "string" ? { phase: state.phase } : {}), status: typeof state.status === "string" ? state.status : "unknown", tasks,
    ...(typeof state.createdAt === "string" ? { createdAt: state.createdAt } : {}),
    ...(typeof state.updatedAt === "string" ? { updatedAt: state.updatedAt } : {}),
    ...(mainAgentId && MANAGED_ID.test(mainAgentId) && parentPath.at(-3) === "runs" ? { mainAgentId } : {}),
    ...(contract && typeof contract.id === "string" && contract.id
      ? { contract: { id: contract.id, ...(Number.isInteger(contract.version) ? { version: contract.version as number } : {}) } } : {})
  };
}

/** Handoff facts for display; the authorization reference, evidence and bundle stay in the loop record. */
function projectTaskHandoffs(values: readonly unknown[]): import("../../protocol/messages").ProjectTaskHandoff[] {
  return values.flatMap(value => {
    const record = readRecordOrUndefined(value);
    if (!record || typeof record.id !== "string" || typeof record.fromAgentId !== "string" || typeof record.toAgentId !== "string") return [];
    const text = (key: string) => typeof record[key] === "string" && record[key] ? { [key]: (record[key] as string).slice(0, 2_000) } : {};
    return [{ id: record.id, fromAgentId: record.fromAgentId, toAgentId: record.toAgentId,
      ...text("taskId"), ...text("fromProvider"), ...text("toProvider"), ...text("fromModel"), ...text("toModel"),
      ...text("reason"), ...text("actor"), ...text("createdAt"), ...text("toRunId") }];
  });
}

/** Supervision verdicts for display: known fields only, never state paths. */
function projectSupervision(value: Record<string, unknown>): Record<string, unknown> {
  const row = (item: unknown) => {
    const record = readRecordOrUndefined(item);
    if (!record) return [];
    const pick = Object.fromEntries(["loopId", "taskId", "title", "verdict", "state", "loopStatus", "phase", "decisionId", "nextAction", "trigger", "reportedAt"]
      .flatMap(key => typeof record[key] === "string" ? [[key, record[key]]] : []));
    const seconds = Object.fromEntries(["elapsedSeconds", "idleSeconds", "waitingSeconds"]
      .flatMap(key => typeof record[key] === "number" ? [[key, record[key]]] : []));
    return [{ ...pick, ...seconds, reasons: Array.isArray(record.reasons) ? record.reasons.filter(reason => typeof reason === "string") : [] }];
  };
  const list = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).flatMap(row) : [];
  return { observedAt: typeof value.observedAt === "string" ? value.observedAt : undefined,
    settings: readRecordOrUndefined(value.settings) ?? {}, verdicts: list("verdicts"), alerts: list("alerts"),
    errors: Array.isArray(value.errors) ? value.errors.flatMap(item => typeof readRecordOrUndefined(item)?.error === "string" ? [String(readRecordOrUndefined(item)!.error)] : []) : [] };
}

/** Only known allocation fields leave the host, never private run payloads or credentials. */
function projectTaskAllocation(value: unknown): Record<string, unknown> | undefined {
  const allocation = readRecordOrUndefined(value);
  if (!allocation || allocation.schemaVersion !== 1) return undefined;
  const strings = (record: unknown, keys: string[]) => {
    const source = readRecordOrUndefined(record);
    if (!source) return {};
    return Object.fromEntries(keys.flatMap(key => typeof source[key] === "string" || typeof source[key] === "boolean" ? [[key, source[key]]] : []));
  };
  const list = (key: string, keys: string[]) => Array.isArray(allocation[key]) ? (allocation[key] as unknown[]).map(item => strings(item, keys)) : [];
  const domain = typeof allocation.domain === "string" && allocation.domain.trim() && allocation.domain.length <= 80 && !/[\u0000-\u001f\u007f]/.test(allocation.domain)
    ? allocation.domain.trim() : undefined;
  return { schemaVersion: 1, ...strings(allocation, ["unitReason", "writeScopeReason", "parallelCandidate"]), ...(domain ? { domain } : {}),
    profile: strings(allocation.profile, ["id", "reason"]), session: strings(allocation.session, ["strategy", "reason"]),
    readScope: Array.isArray(allocation.readScope) ? allocation.readScope.filter(item => typeof item === "string") : [],
    inputs: list("inputs", ["source", "revision", "capturedAt", "confirmed"]),
    dependencies: list("dependencies", ["taskId", "source", "revision", "capturedAt", "confirmed"]),
    sharedResources: list("sharedResources", ["resource", "ownerTaskId", "confirmed", "evidence"]) };
}

/** Commands the worker received for one task, from managed loop records only: the accepted request, then additions. */
function projectTaskCommands(state: Record<string, unknown>, task: { id: string; description?: string }, runs: readonly import("../../protocol/messages").ProjectTaskRun[]): import("../../protocol/messages").ProjectTaskCommand[] {
  const ended = state.status === "completed" || state.status === "cancelled" || state.status === "failed" || state.status === "runtime-error";
  const firstWork = runs.find(run => run.role === "work");
  const sender = state.requestedBy === "human" ? "human" as const : typeof state.parentStatePath === "string" ? "main" as const : undefined;
  const commands: import("../../protocol/messages").ProjectTaskCommand[] = [];
  if (typeof task.description === "string") {
    commands.push({ kind: "request", text: task.description, ...(sender ? { sender } : {}),
      ...(typeof state.createdAt === "string" ? { at: state.createdAt } : {}),
      // Delivery is recorded only once a Work run exists; before that the request is accepted and waiting.
      status: firstWork ? "delivered" : ended ? "undelivered" : "queued", ...(firstWork ? { runId: firstWork.runId } : {}) });
  }
  for (const value of Array.isArray(state.steering) ? state.steering : []) {
    const item = readRecordOrUndefined(value);
    if (!item || item.taskId !== task.id || typeof item.message !== "string") continue;
    const delivered = item.status === "delivered";
    commands.push({ kind: "addition", text: item.message,
      ...(item.actor === "human" || item.actor === "ai" ? { sender: item.actor } : {}),
      ...(typeof item.createdAt === "string" ? { at: item.createdAt } : {}),
      status: delivered ? "delivered" : ended ? "undelivered" : "queued",
      ...(delivered && typeof item.continuationRunId === "string" ? { runId: item.continuationRunId } : {}) });
  }
  return commands;
}

/** Only the known editable domain fields leave the host. */
export function projectDomains(value: Record<string, unknown>): ProjectDomains {
  const change = (record: unknown) => {
    const source = readRecordOrUndefined(record);
    return { actor: source?.actor === "human" ? "human" as const : "ai" as const,
      at: typeof source?.at === "string" ? source.at : "", source: typeof source?.source === "string" ? source.source : "" };
  };
  const domains = (Array.isArray(value.domains) ? value.domains : []).flatMap(item => {
    const domain = readRecordOrUndefined(item);
    if (!domain || typeof domain.id !== "string" || !/^domain-[0-9a-f]{12}$/.test(domain.id) || typeof domain.name !== "string") return [];
    return [{ id: domain.id, name: domain.name, ...(domain.provisional === true ? { provisional: true } : {}), aliases: Array.isArray(domain.aliases) ? domain.aliases.filter((alias): alias is string => typeof alias === "string") : [],
      createdBy: change(domain.createdBy), nameSetBy: change(domain.nameSetBy) }];
  });
  const assignments = Object.fromEntries(Object.entries(readRecordOrUndefined(value.assignments) ?? {}).flatMap(([agentId, item]) => {
    const assignment = readRecordOrUndefined(item);
    if (!MANAGED_ID.test(agentId) || !assignment || !(assignment.domainId === null || domains.some(domain => domain.id === assignment.domainId))) return [];
    return [[agentId, { domainId: assignment.domainId as string | null, setBy: change(assignment.setBy) }]];
  }));
  const removedWorkers = Object.fromEntries(Object.entries(readRecordOrUndefined(value.removedWorkers) ?? {}).flatMap(([agentId, item]) =>
    MANAGED_ID.test(agentId) && readRecordOrUndefined(item) ? [[agentId, { removedBy: change(readRecordOrUndefined(item)!.removedBy) }]] : []));
  return { revision: Number.isSafeInteger(value.revision) ? value.revision as number : 0, domains, assignments, removedWorkers };
}

/**
 * The report's outcome in one short line, by rule only: sentences that state an output, a value, a count or a remaining
 * problem win over narration ("I ran the command"), boilerplate about lessons, audits and Verification is skipped, and long
 * inline code (a command) is dropped since the full report stays one click away. Words and numbers are only removed,
 * never added or rewritten. Undefined when no sentence states such an outcome; the caller then falls back.
 */
export function resultHighlight(text: string): string | undefined {
  // The outcome is stated near the top: the first two prose paragraphs, each line its own sentence source.
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map(block => block.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^(#{1,6}\s|```|~~~|\||-{3,}$|>)/.test(line)).map(line => line.replace(/^(?:[-*+]|\d+[.)])\s+/, "")))
    .filter(lines => lines.length).slice(0, 2);
  const sentences = paragraphs.flat().flatMap(line => line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").split(/(?<=[.!?。])\s+/))
    .map(value => value.trim()).filter(value => value.length >= 6 && value.length <= 200).slice(0, 8);
  const boilerplate = /lesson|교훈|audit|감사|Verification|검증은 요청|Goal 사용량|tokens|변경 경로는 없|changedPaths|작업트리 변경은 보존|사용자님 결정은 없|run-local|occurrence/i;
  const outcome = /(출력|stdout|stderr|결과는|결과가|종료 코드|exit code|통과|실패|성공|오류|남은|미해결|미확인|확인하지 못|\d+\s*(회|건|개|개의|%|초|분|행|명|줄|파일|tests?|passed|failed))/i;
  const scored = sentences.map((sentence, index) => {
    if (boilerplate.test(sentence)) return { sentence, index, score: -1 };
    const value = /`[^`]{1,24}`|\d/.test(sentence) ? 2 : 0;
    return { sentence, index, score: (outcome.test(sentence) ? 2 : 0) + value };
  }).filter(item => item.score >= 3);
  if (!scored.length) return undefined;
  const best = scored.sort((left, right) => right.score - left.score || left.index - right.index)[0]!.sentence;
  // Drop long inline code (commands) with the particle that tied it to the sentence; short code keeps its text.
  const line = best.replace(/`([^`]{25,})`\s*(?:의|를|을|로|으로|에서)?\s*/g, "").replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__/g, "").replace(/\(\s*\)/g, "").replace(/^(사용자님|Dear user)[,，]\s*/, "").replace(/\s+/g, " ").trim().replace(/^[:：·,，;\s]+/, "");
  return line.length >= 6 ? line : undefined;
}

/** A result's summary line: its first prose line (a heading such as "Summary" says little), else its first heading. */
export function resultSummaryLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const prose = lines.find(line => !/^(#{1,6}\s|```|~~~|\||-{3,}$|\*{3,}$|_{3,}$)/.test(line));
  const line = prose ?? lines[0]?.replace(/^#+\s*/, "");
  return line?.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim() || undefined;
}

function projectTaskRun(run: Record<string, unknown>, receipt?: Record<string, unknown>, expectedWorkRunId?: string): import("../../protocol/messages").ProjectTaskRun {
  const options = readRecordOrUndefined(run.executionOptions);
  const fields = Object.fromEntries(["parentRunId", "acceptedAt", "startedAt", "finishedAt", "updatedAt", "workProfile"].flatMap(key => typeof run[key] === "string" ? [[key, run[key]]] : []));
  const tokens = readRecordOrUndefined(run.tokenUsage);
  const usage = tokens && Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"].map(key => [key, typeof tokens[key] === "number" && Number.isSafeInteger(tokens[key]) && Number(tokens[key]) >= 0 ? tokens[key] : null]));
  const contextSource = readRecordOrUndefined(run.contextUsage);
  const context = contextSource && Object.fromEntries(["availability", "usedTokens", "contextWindowTokens", "usedPercent", "observedAt", "source", "estimated", "sessionId", "turnId"].flatMap(key => ["string", "number", "boolean"].includes(typeof contextSource[key]) || contextSource[key] === null ? [[key, contextSource[key]]] : []));
  const handoff = readRecordOrUndefined(run.handoffBinding);
  const error = readRecordOrUndefined(run.error);
  const checks = readRecordOrUndefined(receipt?.tests);
  const expectedHash = run.receiptRequestHash ?? run.requestHash;
  const boundReceipt = run.role === "work" && receipt?.runId === run.runId && receipt?.requestHash === expectedHash
    && ["completed", "implemented"].includes(String(receipt?.outcome));
  const verifiedWorkRunId = expectedWorkRunId ?? run.verifiedWorkRunId;
  const rawFindings = Array.isArray(receipt?.findings) ? receipt.findings : undefined;
  const findings = rawFindings?.flatMap(value => {
    const finding = readRecordOrUndefined(value);
    if (!finding || ["id", "path", "location", "problem", "evidence", "correction"].some(key => typeof finding[key] !== "string")
      || !finding.id || !finding.problem || !finding.evidence || !finding.correction) return [];
    return [{ id: String(finding.id), path: String(finding.path), location: String(finding.location),
      problem: String(finding.problem), evidence: String(finding.evidence), correction: String(finding.correction) }];
  });
  // Recorded Verification is distinct from Work own checks and must identify the exact inspected Work run.
  const boundVerification = run.role === "verification" && receipt?.schemaVersion === "0.1.0" && receipt?.kind === "verification-receipt"
    && receipt?.runId === run.runId && typeof expectedHash === "string" && expectedHash.length > 0 && receipt?.verifiedRequestHash === expectedHash
    && typeof verifiedWorkRunId === "string" && receipt?.verifiedWorkRunId === verifiedWorkRunId
    && (run.verifiedWorkRunId === undefined || run.verifiedWorkRunId === verifiedWorkRunId)
    && findings && findings.length === rawFindings?.length
    && (receipt?.decision === "pass" ? findings.length === 0 : receipt?.decision === "fail" && findings.length > 0);
  return { agentId: String(run.agentId), runId: String(run.runId), role: run.role === "verification" ? "verification" : "work", status: typeof run.status === "string" ? run.status : "unknown",
    ...fields, ...(typeof options?.model === "string" ? { model: options.model } : {}),
    // Without a recorded model the run used its provider's default; the provider still identifies it.
    ...(typeof run.provider === "string" && run.provider ? { provider: run.provider } : {}),
    ...(Number.isInteger(run.attempt) ? { attempt: Number(run.attempt) } : {}),
    ...(boundReceipt ? { receipt: { outcome: String(receipt?.outcome), ...(typeof checks?.run === "boolean" ? { checksRun: checks.run } : {}), ...(typeof checks?.reason === "string" ? { checks: checks.reason } : {}), ...(Array.isArray(receipt?.changedPaths) ? { changedPaths: receipt.changedPaths.filter((path): path is string => typeof path === "string") } : {}) } } : {}),
    ...(boundVerification ? { verification: { decision: receipt?.decision as "pass" | "fail", verifiedWorkRunId: String(verifiedWorkRunId), findings: findings! } } : {}),
    ...(usage ? { usage: usage as Record<string, number | null> } : {}),
    ...(context ? { context: context as Record<string, string | number | boolean | null> } : {}),
    ...(handoff ? { handoff: { ...(typeof handoff.slot === "string" ? { slot: handoff.slot } : {}), ...(Number.isInteger(handoff.epoch) ? { epoch: Number(handoff.epoch) } : {}) } } : {}),
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}) };
}

function readRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The home the runtime binds, normalized as its `home_path()` does: an empty
 * value selects the default and `~` expands. Links are not resolved because the
 * runtime rejects a link in any home component before reporting a location.
 */
export function expectedRuntimeHome(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const value = environment.AGENT_FACTORY_HOME || join(home, ".agent-factory");
  return resolve(value === "~" ? home : /^~[\\/]/.test(value) ? join(home, value.slice(2)) : value);
}

/** Reads a loop.py snapshot; a failed exit reports its structured error or stderr, never a JSON parse error. */
export function readLoopOutput(output: ProcessOutput, failure: string): Record<string, unknown> {
  let snapshot: Record<string, unknown> | undefined;
  try { snapshot = readRecordOrUndefined(JSON.parse(output.stdout)); }
  catch { snapshot = undefined; }
  if (output.exitCode !== 0 || !snapshot || snapshot.kind === "error") {
    const nested = readRecordOrUndefined(snapshot?.error);
    if (typeof nested?.message === "string" && nested.message) throw new Error(nested.message);
    const stderr = output.stderr.trim();
    throw new Error(`${failure}: ${stderr || (output.exitCode !== 0 ? `exit code ${output.exitCode}` : "Runtime returned an invalid response")}`);
  }
  return snapshot;
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
