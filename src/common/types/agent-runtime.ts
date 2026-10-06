import type { AgentModels } from "./agent-models";
import type { AgentPermissions } from "./agent-permissions";
import type { BusinessMode } from "./business-mode";

/** Latest account-wide limit windows reported by one provider, independent of any chat's context. */
export interface AccountLimits {
  readonly provider: string;
  readonly weeklyUsedPercent?: number;
  readonly fiveHourUsedPercent?: number;
  readonly weeklyResetsAt?: number;
  readonly fiveHourResetsAt?: number;
}

export interface ExecutionCapabilities {
  readonly model: boolean;
  readonly reasoning: boolean;
  readonly fast: boolean;
  readonly goal: boolean;
  readonly sessionProvider?: "codex" | "claude" | "antigravity";
  readonly images?: boolean;
  readonly automaticRequestHash?: boolean;
  readonly worktrees?: boolean;
  /** Captured per-task Work Units, checked integration and same-session conflict revisions. */
  readonly taskWorkspaces?: boolean;
  /** Main runs accept `--work-isolation on|off`, the Human's Work isolation toggle that loops inherit. */
  readonly workIsolation?: boolean;
  /** The runtime accepts and records `loop.py start --work-profile`. */
  readonly workProfile?: boolean;
  /** `--work-profile` also accepts explore (assigned evidence Documents) and scribe (writes only inside docs/), enforced by the runtime. */
  readonly restrictedWorkProfiles?: boolean;
  /** Receipt-bound Main commits and exact task-bound Explorer Documents are enforced. */
  readonly roleDirectExceptions?: boolean;
  /** Optional allocation evidence is validated and retained in taskBinding. */
  readonly taskAllocation?: boolean;
  /** A stopped loop reports `failureClass`; Main is then told what to do for each class. */
  readonly failureClass?: boolean;
  /** A loop stopped on its revision limit carries a structured `pause`; the task panel then offers the Human's decision. */
  readonly revisionLimitPause?: boolean;
  readonly taskModes?: readonly TaskMode[];
  readonly diagnostic?: string;
}

export const TASK_MODES = ["orchestrate", "direct", "work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"] as const;
export type TaskMode = typeof TASK_MODES[number];

export type ExecutionMode = "cli-default" | "workspace-write" | "danger-full-access" | "bypass";

/** Runtime exec.py dispatch identity; distinct from agent/run identifiers. */
// Strict end-of-input matches Python fullmatch (JS `$` also accepts a final newline).
export const DISPATCH_ID = /^dispatch-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/;

export interface ExecutionOptions {
  /** Host-owned idempotency identity for a durable engine-result delivery. */
  readonly deliveryId?: string;
  readonly inspectionOnly?: boolean;
  readonly businessMode?: BusinessMode;
  readonly taskMode?: TaskMode;
  readonly executionMode?: ExecutionMode;
  readonly model?: string;
  readonly agentModels?: AgentModels;
  readonly agentPermissions?: AgentPermissions;
  /** The Human's per-project Work isolation toggle; sent only to a runtime advertising `workIsolation`. */
  readonly workIsolation?: boolean;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly fast?: boolean;
  readonly goalMode?: boolean;
  readonly goalObjective?: string;
  readonly actor?: "main" | "human";
  readonly verifiedWorkRunId?: string;
}

export interface NativeGoal {
  readonly threadId: string;
  readonly objective: string;
  readonly status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly tokenBudget?: number | null;
}

export interface TaskStopTarget {
  readonly workflowId: string;
  readonly taskId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly workAgentId?: string;
  readonly loopId?: string;
}

export type GoalAction = "get" | "refresh" | "pause" | "cancel" | "disable" | "reopen";

export interface SavedConversation {
  readonly conversationId: string | null;
  readonly startedAt: string;
  readonly runCount: number;
}

export interface WorktreeRepository { readonly path: string; readonly branches: readonly string[]; readonly defaultBranch: string | null; }

export interface ConversationWorktree {
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly available: boolean;
  readonly conflicts: readonly string[];
  readonly worktree: { readonly workUnit?: boolean; readonly cleaned?: boolean; readonly repositoryRoot?: string; readonly name?: string; readonly id: string; readonly path: string; readonly branch: string; readonly targetBranch: string; readonly phase: "creating" | "active" | "merging" | "conflict" | "merged" } | null;
}

export interface WorktreeOptions {
  readonly repository?: string;
  readonly name?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly target?: string;
  readonly changes?: "keep" | "copy";
  readonly path?: string;
  readonly executionMode?: ExecutionMode;
  /** Selects the provider when the worktree creates the conversation's first session. */
  readonly model?: string;
}
