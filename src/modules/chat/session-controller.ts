import { withInspectionGuidance } from "./task-selection";
import { withBusinessMode } from "../../common/types/business-mode";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AttachmentReference } from "../../common/types/attachment";
import type { AgentRuntimeClient, ExecutionOptions, NativeGoal, GoalAction } from "../../infrastructure/agent-factory/agent-client";

const TERMINAL_STATES = new Set(["completed", "needs-human-decision", "failed", "cancelled"]);

export interface SessionControllerEvents {
  readonly onBound: (agentId: string) => void;
  readonly onRunningChanged: (running: boolean) => void;
  readonly onQueueChanged?: (count: number) => void;
  readonly onBeforeQueueDrain?: () => Promise<void>;
  readonly onAssistantText: (text: string, phase?: "commentary" | "final", runId?: string) => void;
  readonly onProgress: (text: string) => void;
  readonly onUsage: (usedTokens: number, contextWindowTokens: number, weeklyUsedPercent?: number) => void;
  readonly onActivity: (activity: {
    readonly id: string;
    readonly category: "command" | "file" | "tool";
    readonly phase: "started" | "completed" | "failed";
    readonly text: string;
    readonly title?: string;
    readonly diff?: string;
    readonly output?: string;
  }) => void;
  readonly onDecision?: (runId: string | null) => void;
  readonly onHumanDecision?: (text: string) => void;
  readonly onGoal?: (goal: NativeGoal | null, error?: string) => void;
  readonly onStatusObserved?: (status: string) => void;
  readonly onError: (message: string) => void;
}

export interface SessionControllerOptions {
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

interface PendingSend {
  readonly text: string;
  readonly attachments: readonly AttachmentReference[];
  readonly execution: ExecutionOptions;
  readonly resolve?: () => void;
  readonly onStarted?: () => void;
}

export class ChatSessionController {
  private agentId: string | undefined;
  private currentRunId: string | undefined;
  private currentRunAgentId: string | undefined;
  private busy = false;
  private pendingDecisionRunId: string | undefined;
  private pendingDecisionTaskMode: ExecutionOptions["taskMode"];
  private pendingDecisionBusinessMode: ExecutionOptions["businessMode"];
  private pendingDecisionInspectionOnly: boolean | undefined;
  private submittedInspectionOnly: boolean | undefined;
  private submittedBusinessMode: ExecutionOptions["businessMode"];
  private submittedTaskMode: ExecutionOptions["taskMode"];
  private cancelRequested = false;
  private cancellationInFlight: Promise<void> | undefined;
  private goalControlPending = false;
  private pendingGoalAction: GoalAction | undefined;
  private disposed = false;
  private readonly queuedSends: PendingSend[] = [];

  public constructor(
    private readonly runtime: AgentRuntimeClient,
    private readonly events: SessionControllerEvents,
    agentId?: string,
    private readonly options: SessionControllerOptions = {}
  ) {
    this.agentId = agentId;
  }

  public get running(): boolean {
    return this.busy || (this.goalControlPending && this.pendingGoalAction === "reopen");
  }

  public get runId(): string | undefined { return this.currentRunId; }
  public get queueLength(): number { return this.queuedSends.length; }

  public dispose(): void {
    this.disposed = true;
    for (const queued of this.queuedSends.splice(0)) queued.resolve?.();
    this.events.onQueueChanged?.(0);
  }

  public async reconnect(): Promise<boolean> {
    if (this.disposed || this.running) return this.running;
    if (!this.agentId) {
      this.releaseBusyAndDrainQueue();
      return this.running;
    }
    this.cancelRequested = false;
    this.busy = true;
    this.events.onRunningChanged(true);
    try {
      const active = this.currentRunId && this.currentRunAgentId
        ? { runId: this.currentRunId, agentId: this.currentRunAgentId }
        : await this.runtime.activeRun?.(this.agentId);
      if (this.disposed) return false;
      if (active) {
        this.currentRunId = active.runId;
        this.currentRunAgentId = active.agentId;
        this.events.onProgress("Reconnected to the active run.");
        await this.flushCancellation();
        void this.followExistingRun(active.agentId, active.runId);
        return true;
      }
      this.releaseBusyAndDrainQueue();
      return false;
    } catch (error) {
      this.busy = false;
      this.events.onRunningChanged(false);
      throw error;
    }
  }

  private async followExistingRun(agentId: string, runId: string): Promise<void> {
    try {
      await this.pollUntilTerminal(agentId, runId);
      this.releaseBusyAndDrainQueue();
    } catch (error) {
      this.busy = false;
      if (!this.disposed) {
        this.events.onError(errorMessage(error));
        this.events.onRunningChanged(false);
      }
    }
  }

  private releaseBusyAndDrainQueue(): void {
    this.currentRunId = undefined;
    this.currentRunAgentId = undefined;
    this.cancelRequested = false;
    this.busy = false;
    const batch = this.pendingDecisionRunId ? [] : this.queuedSends.splice(0);
    if (batch.length) this.events.onQueueChanged?.(this.queuedSends.length);
    const first = batch[0];
    if (first && !this.disposed) {
      void this.sendAndDrainQueue(first.text, first.attachments, first.execution, false, undefined, batch);
    } else if (!this.disposed) {
      this.events.onRunningChanged(false);
    } else {
      for (const item of batch) item.resolve?.();
    }
  }

  public async send(
    text: string,
    attachments: readonly AttachmentReference[],
    execution: ExecutionOptions,
    onStarted?: () => void
  ): Promise<void> {
    if (this.disposed) return;
    execution = { ...execution };
    attachments = attachments.map(attachment => ({ ...attachment }));
    if (this.busy || (this.goalControlPending && this.pendingGoalAction === "reopen")) {
      return new Promise((resolve) => {
        this.queuedSends.push({ text, attachments, execution, resolve, onStarted });
        this.events.onQueueChanged?.(this.queuedSends.length);
      });
    }
    if (this.goalControlPending) {
      this.events.onError("The previous Goal control request is still processing. Send again after it finishes.");
      if (!this.running) this.events.onRunningChanged(false);
      return;
    }
    if ((this.queuedSends.length || this.currentRunId) && !this.pendingDecisionRunId) {
      const queued = new Promise<void>(resolve => {
        this.queuedSends.push({ text, attachments, execution, resolve, onStarted });
        this.events.onQueueChanged?.(this.queuedSends.length);
      });
      await this.reconnect();
      return queued;
    }
    await this.sendAndDrainQueue(text, attachments, execution, true, onStarted);
  }

  private async sendAndDrainQueue(
    text: string,
    attachments: readonly AttachmentReference[],
    execution: ExecutionOptions,
    checkActiveRun = true,
    onStarted?: () => void,
    initialBatch?: PendingSend[]
  ): Promise<void> {
    // A decision answer must complete before unrelated pending input is drained.
    let priorityAnswer = Boolean(this.pendingDecisionRunId);
    this.busy = true;
    this.events.onRunningChanged(true);
    let next: PendingSend[] = initialBatch ?? [{ text, attachments, execution, onStarted }];
    const retainedCompletions: Promise<void>[] = [];
    let interrupted = false;
    while (next.length && !this.disposed) {
      let started = false;
      let attempted = false;
      this.clearDecision();
      this.cancelRequested = false;
      try {
        if (this.agentId && checkActiveRun) {
          const active = await this.runtime.activeRun?.(this.agentId);
          if (active) {
            this.currentRunId = active.runId;
            this.currentRunAgentId = active.agentId;
            this.events.onProgress("Queued messages will run together after the current run finishes.");
            await this.flushCancellation();
            await this.pollUntilTerminal(active.agentId, active.runId);
            this.currentRunId = undefined;
            this.currentRunAgentId = undefined;
            this.cancelRequested = false;
            if (this.pendingDecisionRunId) throw new Error("Queued messages will be processed together after your decision.");
          }
        }
        if (this.events.onBeforeQueueDrain) await this.events.onBeforeQueueDrain();
        if (this.disposed) { for (const item of next) item.resolve?.(); break; }
        // Freeze the original messages immediately before dispatch, after discovery.
        // Arrivals during acceptance/polling belong to the next batch.
        if (!priorityAnswer && this.queuedSends.length) {
          next.push(...this.queuedSends.splice(0));
          this.events.onQueueChanged?.(0);
        }
        // Inspection must never inherit an implementation route from a different message.
        const boundary = next.findIndex(item => Boolean(item.execution.inspectionOnly) !== Boolean(next[0]!.execution.inspectionOnly));
        if (boundary > 0) {
          this.queuedSends.unshift(...next.splice(boundary));
          this.events.onQueueChanged?.(this.queuedSends.length);
        }
        attempted = true;
        const merged = mergePendingSends(next);
        if (next.length > 1) this.events.onProgress(`Submitting ${next.length} queued messages as one request. Task mode, model, and reasoning use the first message settings; permissions use their common allowed scope.`);
        await this.sendOne(merged.text, merged.attachments, merged.execution, () => {
          started = true;
          for (const item of next) item.onStarted?.();
        });
        if (!this.pendingDecisionRunId && this.events.onBeforeQueueDrain) await this.events.onBeforeQueueDrain();
      } catch (error) {
        interrupted = true;
        if (!started && !attempted) {
          // Discovery failure retains each original identity and completion promise.
          const retained = next.map(item => {
            if (item.resolve) return item;
            let resolve!: () => void;
            retainedCompletions.push(new Promise<void>(done => { resolve = done; }));
            return { ...item, resolve };
          });
          this.queuedSends.unshift(...retained);
          this.events.onQueueChanged?.(this.queuedSends.length);
        } else {
          // Never replay an unacknowledged submission. The host restores originals.
          for (const item of next) item.resolve?.();
        }
        this.events.onError(errorMessage(error));
        break;
      }
      for (const item of next) item.resolve?.();
      if (this.pendingDecisionRunId) break;
      priorityAnswer = false;
      checkActiveRun = false;
      next = this.queuedSends.splice(0);
      if (next.length) this.events.onQueueChanged?.(0);
    }
    if (!interrupted) {
      this.currentRunId = undefined;
      this.currentRunAgentId = undefined;
      this.cancelRequested = false;
    }
    this.busy = false;
    if (!this.disposed) this.events.onRunningChanged(false);
    await Promise.all(retainedCompletions);
  }

  private async sendOne(
    text: string,
    attachments: readonly AttachmentReference[],
    execution: ExecutionOptions,
    onStarted: () => void
  ): Promise<void> {
    // Apply at dispatch so initial sends and decision continuations share the boundary.
    if (execution.inspectionOnly) {
      const inspectionExecution = { ...execution, goalMode: false };
      delete inspectionExecution.goalObjective;
      execution = inspectionExecution;
    }
    this.submittedInspectionOnly = execution.inspectionOnly;
    this.submittedBusinessMode = execution.businessMode;
    this.submittedTaskMode = execution.taskMode;
    const content = withAttachmentReferences(text, attachments);
    const request = execution.inspectionOnly ? withInspectionGuidance(content) : withBusinessMode(content, execution.businessMode);
    const images = runtimeImages(attachments);
    if (!this.agentId) {
      const candidateAgentId = `main-${randomUUID()}`;
      const accepted = await this.runtime.submit(candidateAgentId, request, execution, images);
      this.agentId = accepted.agentId;
      this.events.onBound(this.agentId);
      this.currentRunId = accepted.runId;
      this.currentRunAgentId = accepted.agentId;
    } else {
      const accepted = await this.runtime.send(this.agentId, request, execution, images);
      this.currentRunId = accepted.runId;
      this.currentRunAgentId = accepted.agentId;
    }
    onStarted();
    await this.flushCancellation();
    await this.pollUntilTerminal(this.currentRunAgentId, this.currentRunId);
    this.currentRunId = undefined;
    this.currentRunAgentId = undefined;
    this.cancelRequested = false;
  }

  public approveDecision(runId: string, execution: ExecutionOptions): boolean {
    if (this.busy || this.goalControlPending || this.pendingDecisionRunId !== runId) return false;
    const text = "바로 위 응답에서 제안한 범위와 조건대로 진행하세요.";
    const taskMode = this.pendingDecisionTaskMode;
    const businessMode = this.pendingDecisionBusinessMode;
    const inspectionOnly = this.pendingDecisionInspectionOnly;
    void this.sendAndDrainQueue(text, [], { ...execution, inspectionOnly, ...(taskMode ? { taskMode } : {}), ...(businessMode ? { businessMode } : {}), actor: "human" }, true, () => this.events.onHumanDecision?.(text));
    return true;
  }

  private clearDecision(): void {
    this.pendingDecisionRunId = undefined;
    this.pendingDecisionTaskMode = undefined;
    this.pendingDecisionBusinessMode = undefined;
    this.pendingDecisionInspectionOnly = undefined;
    this.events.onDecision?.(null);
  }

  public async controlGoal(action: GoalAction): Promise<void> {
    if (!this.agentId) return;
    if (this.goalControlPending) {
      this.events.onError("The previous Goal control request is still processing.");
      return;
    }
    if (action === "reopen" && this.busy) {
      this.events.onError("Reopen Goal after the current run finishes.");
      return;
    }
    if (action === "reopen") this.cancelRequested = false;
    this.goalControlPending = true;
    this.pendingGoalAction = action;
    let result: Awaited<ReturnType<AgentRuntimeClient["goal"]>>;
    try {
      result = await this.runtime.goal(this.agentId, action);
    } catch (error) {
      if (action === "reopen") {
        this.cancelRequested = false;
        if (!this.disposed) this.events.onRunningChanged(this.busy);
      }
      this.events.onError(errorMessage(error));
      return;
    } finally {
      this.goalControlPending = false;
      this.pendingGoalAction = undefined;
    }
    try {
      if ("goal" in result) this.events.onGoal?.(result.goal ?? null, result.error);
      if (result.accepted) {
        if (this.busy) {
          this.events.onError("Unable to connect the Goal run while another run is active.");
          return;
        }
        this.currentRunId = result.accepted.runId;
        this.currentRunAgentId = result.accepted.agentId;
        if (this.disposed) {
          await this.flushCancellation();
          this.currentRunId = undefined;
          this.currentRunAgentId = undefined;
          this.cancelRequested = false;
          return;
        }
        this.clearDecision();
        this.busy = true;
        this.events.onRunningChanged(true);
        await this.flushCancellation();
        await this.pollUntilTerminal(result.accepted.agentId, result.accepted.runId);
        this.releaseBusyAndDrainQueue();
      } else if (action === "reopen") {
        this.releaseBusyAndDrainQueue();
      }
    } catch (error) {
      this.busy = false;
      this.events.onRunningChanged(false);
      this.events.onError(errorMessage(error));
    }
  }

  public async cancel(): Promise<void> {
    if (!this.busy && !this.currentRunId) {
      if (this.goalControlPending && this.pendingGoalAction === "reopen") {
        this.cancelRequested = true;
        this.events.onProgress("Requested cancellation as soon as the Goal run is accepted.");
        return;
      }
      if (!this.disposed) this.events.onRunningChanged(false);
      return;
    }
    this.cancelRequested = true;
    if (!this.currentRunAgentId || !this.currentRunId) {
      this.events.onProgress("Requested cancellation as soon as the run is accepted.");
      return;
    }
    await this.flushCancellation();
  }

  private async flushCancellation(): Promise<void> {
    if (!this.cancelRequested || !this.currentRunAgentId || !this.currentRunId) return;
    if (!this.cancellationInFlight) {
      const agentId = this.currentRunAgentId;
      const runId = this.currentRunId;
      const request = this.runtime.cancel(agentId, runId).catch((error) => {
        this.cancelRequested = false;
        this.events.onError(errorMessage(error));
      });
      let tracked: Promise<void>;
      tracked = request.finally(() => {
        if (this.cancellationInFlight === tracked) this.cancellationInFlight = undefined;
      });
      this.cancellationInFlight = tracked;
    }
    await this.cancellationInFlight;
  }

  private async pollUntilTerminal(agentId: string, runId: string): Promise<void> {
    const maxPolls = this.options.maxPolls ?? 7_200;
    const interval = this.options.pollIntervalMs ?? 250;
    const statusPollStride = this.options.pollIntervalMs === undefined ? 3 : 1;
    let cursor = 0;
    let lastCommentary: string | undefined;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (this.disposed) return;
      const updates = await this.runtime.updates(agentId, runId, cursor);
      if (this.disposed) return;
      cursor = updates.cursor;
      for (const update of updates.updates) {
        if (update.kind === "commentary") {
          if (update.text.trim() && update.text !== lastCommentary) {
            this.events.onAssistantText(update.text, "commentary", runId);
            lastCommentary = update.text;
          }
        } else if (update.kind === "status") {
          this.events.onProgress(update.text);
        } else if (update.kind === "goal") {
          this.events.onGoal?.(update.goal, update.error);
        } else if (update.kind === "usage") {
          this.events.onUsage(update.usedTokens, update.contextWindowTokens, update.weeklyUsedPercent);
        } else {
          lastCommentary = undefined;
          this.events.onActivity({ ...update, id: `${runId}:${update.id}` });
        }
      }
      if (poll % statusPollStride === 0) {
        const status = await this.runtime.status(agentId, runId);
        if (this.disposed) return;
        this.events.onStatusObserved?.(status.status);
        if (TERMINAL_STATES.has(status.status)) {
          const result = await this.runtime.result(agentId, runId);
          const diagnostic = result.error ?? status.error;
          const goalError = result.goalError ?? status.goalError;
          if (goalError) this.events.onGoal?.(null, goalError);
          const summary = terminalSummary(result.status);
          this.events.onProgress(summary);
          if ((result.status !== "completed" && result.status !== "needs-human-decision") || diagnostic || goalError) {
            this.events.onError([summary, diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : "", diagnostic?.code === "execution_preflight_failed" ? "Execution environment check failed. After the run finishes, select the required permissions and retry with your next message." : "", goalError ?? ""].filter(Boolean).join("\n"));
            if (result.status === "cancelled") {
              // The error notice already carries the cancellation summary.
              const partialResult = result.text.trim();
              if (partialResult && partialResult !== summary) {
                this.events.onAssistantText(`Preserved partial result (completion unconfirmed):\n${partialResult}`, "final", runId);
              }
            } else {
              this.events.onAssistantText(result.text.trim() ? `${summary}\n\nPreserved partial result (completion unconfirmed):\n${result.text.trim()}` : summary, "final", runId);
            }
          } else {
            this.events.onAssistantText(result.text.trim() || summary, "final", runId);
          }
          if (result.status === "needs-human-decision" && result.text.trim() && !diagnostic && !goalError) {
            this.pendingDecisionRunId = runId;
            this.pendingDecisionInspectionOnly = this.submittedInspectionOnly;
            this.pendingDecisionBusinessMode = this.submittedBusinessMode;
            this.pendingDecisionTaskMode = status.taskMode ?? this.submittedTaskMode;
            this.events.onDecision?.(runId);
          }
          return;
        }
      }
      await delay(interval);
    }
    throw new Error("Timed out checking Agent Factory run status. Check the run in the runtime records.");
  }
}

function mergePendingSends(items: readonly PendingSend[]): Pick<PendingSend, "text" | "attachments" | "execution"> {
  const first = items[0]!;
  if (items.length === 1) return first;
  const execution = { ...first.execution };
  // cli-default/omitted can inherit read-only or another unknown session policy.
  // Never infer its permissions from an explicit mode on a different message.
  const inherited = (value: ExecutionOptions["executionMode"]) => value === undefined || value === "cli-default";
  const modes = items.map(item => item.execution.executionMode);
  if (modes.some(inherited) && !modes.every(inherited)) {
    throw new Error("Cannot safely merge inherited and explicit permissions for queued messages. Restore them to the input and resend with matching execution permissions.");
  }
  if (items.some(item => item.execution.actor !== execution.actor || item.execution.verifiedWorkRunId !== execution.verifiedWorkRunId)) {
    throw new Error("Queued messages have different execution owners or verification targets and were not merged. Restore the input for each original target.");
  }
  if (!modes.some(inherited)) {
    execution.executionMode = modes.includes("workspace-write") ? "workspace-write"
      : modes.includes("danger-full-access") ? "danger-full-access" : "bypass";
  }
  // Goal continuation needs agreement from every original request.
  if (!items.every(item => item.execution.goalMode === true && item.execution.goalObjective === execution.goalObjective)) {
    execution.goalMode = false;
    delete execution.goalObjective;
  }
  // Each original retains its workflow; do not apply the first workflow to the batch.
  execution.businessMode = "normal";
  return {
    text: items.map((item, index) => `--- 대기 메시지 ${index + 1} 시작 ---\n${withBusinessMode(withAttachmentReferences(item.text, item.attachments), item.execution.inspectionOnly ? "normal" : item.execution.businessMode)}\n--- 대기 메시지 ${index + 1} 끝 ---`).join("\n\n"),
    attachments: items.flatMap(item => [...item.attachments]),
    execution
  };
}

export function withAttachmentReferences(
  text: string,
  attachments: readonly AttachmentReference[]
): string {
  if (attachments.length === 0) return text;
  const references = attachments.map((attachment) => {
    const target = attachment.uri ?? "브라우저 첨부(파일 시스템 경로 없음)";
    const details = [attachment.mediaType, attachment.size === undefined ? undefined : `${attachment.size} bytes`]
      .filter(Boolean)
      .join(", ");
    return `- [${attachment.kind}] ${attachment.name}: ${target}${details ? ` (${details})` : ""}`;
  });
  return `${text}\n\n첨부 참조:\n${references.join("\n")}`;
}

export function runtimeImages(attachments: readonly AttachmentReference[]) {
  return attachments.filter((attachment) => attachment.kind === "image").map((attachment) => {
    if (!attachment.uri?.startsWith("file:") || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mediaType ?? "")) {
      throw new Error(`Unable to prepare the image attachment as a safe local file: ${attachment.name}`);
    }
    return {
      path: fileURLToPath(attachment.uri),
      mediaType: attachment.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    };
  });
}

function terminalSummary(status: string): string {
  if (status === "cancelled") return "The run was cancelled.";
  if (status === "needs-human-decision") return "Your decision is required to continue the run.";
  if (status === "failed") return "The Agent Factory run failed.";
  return "The Agent Factory run completed.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
