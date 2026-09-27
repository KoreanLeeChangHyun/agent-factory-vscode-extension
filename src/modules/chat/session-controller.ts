import { localize, describeLocalizedMessage, joinLocalizedMessages, type LocalizedMessage } from "../../common/localization";
import type { MessageSubmission } from "../../protocol/messages";
import { withInspectionGuidance, withContractExecutionGuidance } from "./task-selection";
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
  readonly onAssistantText: (text: string, phase?: "commentary" | "final", runId?: string, localization?: LocalizedMessage) => void;
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
  readonly onDecision?: (runId: string | null, canApprove?: boolean) => void;
  readonly onHumanDecision?: (text: string, submission: MessageSubmission) => void;
  readonly onGoal?: (goal: NativeGoal | null, error?: string) => void;
  readonly onStatusObserved?: (status: string) => void;
  readonly onError: (message: string) => void;
}

export interface SessionControllerOptions {
  readonly pollIntervalMs?: number;
  /** Optional bounded observation for tests; production observes until terminal or disposal. */
  readonly maxPolls?: number;
}

interface PendingSend {
  readonly text: string;
  readonly attachments: readonly AttachmentReference[];
  readonly execution: ExecutionOptions;
  readonly resolve?: () => void;
  readonly onStarted?: (submission: MessageSubmission) => void;
}

export class ChatSessionController {
  private agentId: string | undefined;
  private currentRunId: string | undefined;
  private currentRunAgentId: string | undefined;
  private busy = false;
  private pendingDecisionRunId: string | undefined;
  private pendingDecisionCanApprove = false;
  private submittedAgentPermissions: ExecutionOptions["agentPermissions"];
  private pendingDecisionAgentPermissions: ExecutionOptions["agentPermissions"];
  private submittedAgentModels: ExecutionOptions["agentModels"];
  private pendingDecisionAgentModels: ExecutionOptions["agentModels"];
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
  private conversationResetInFlight: Promise<{ readonly conversationId: string; readonly startedAt: string }> | undefined;
  private worktreeInFlight?: Promise<import("../../infrastructure/agent-factory/agent-client").ConversationWorktree>;
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

  public get conversationResetBlockedReason(): string | undefined {
    if (this.worktreeInFlight) return localize("worktree.busy");
    if (this.conversationResetInFlight) return localize("ui.a.conversation.reset.is.already.processing");
    if (this.running || this.currentRunId) return localize("ui.finish.or.cancel.the.current.run.first");
    if (this.queuedSends.length) return localize("ui.send.restore.or.remove.queued.messages.first");
    if (this.pendingDecisionRunId) return localize("ui.resolve.the.pending.human.decision.first");
    if (this.goalControlPending) return localize("ui.wait.for.the.goal.control.request.to.finish");
    return undefined;
  }

  public async resetConversation(): Promise<{ readonly conversationId: string; readonly startedAt: string }> {
    const blocked = this.conversationResetBlockedReason;
    if (blocked) throw new Error(blocked);
    if (!this.agentId) throw new Error(localize("ui.send.a.message.before.clearing.this.conversation"));
    const reset = this.runtime.resetConversation(this.agentId);
    this.conversationResetInFlight = reset;
    try {
      return await reset;
    } finally {
      if (this.conversationResetInFlight === reset) this.conversationResetInFlight = undefined;
    }
  }

  public async changeWorktree(action: "create" | "merge", options: import("../../infrastructure/agent-factory/agent-client").WorktreeOptions = {}): Promise<import("../../infrastructure/agent-factory/agent-client").ConversationWorktree> {
    if (this.worktreeInFlight || this.running || this.currentRunId || this.queueLength || this.conversationResetInFlight || this.goalControlPending) throw new Error(localize("worktree.busy"));
    if (!this.runtime.worktree) throw new Error(localize("worktree.unsupported"));
    const agent = this.agentId ?? `main-${randomUUID()}`;
    const operation = this.runtime.worktree(agent, action, options);
    this.worktreeInFlight = operation;
    try {
      const result = await operation;
      if (!this.agentId) { this.agentId = agent; this.events.onBound(agent); }
      return result;
    } catch (error) {
      // A failed Git operation can still have persisted a recoverable session.
      if (!this.agentId) {
        try {
          await this.runtime.worktree(agent, "status");
          this.agentId = agent;
          this.events.onBound(agent);
        } catch { /* No session was accepted. */ }
      }
      throw error;
    } finally {
      this.worktreeInFlight = undefined;
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const queued of this.queuedSends.splice(0)) queued.resolve?.();
    this.events.onQueueChanged?.(0);
  }

  public async reconnect(): Promise<boolean> {
    if (this.worktreeInFlight) await this.worktreeInFlight;
    if (this.conversationResetInFlight) await this.conversationResetInFlight;
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
        this.events.onProgress(localize("ui.reconnected.to.the.active.run"));
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
    onStarted?: (submission: MessageSubmission) => void
  ): Promise<void> {
    if (this.worktreeInFlight) await this.worktreeInFlight;
    if (this.conversationResetInFlight) await this.conversationResetInFlight;
    if (this.disposed) return;
    execution = { ...execution, ...(execution.agentPermissions ? { agentPermissions: structuredClone(execution.agentPermissions) } : {}), ...(execution.agentModels ? { agentModels: structuredClone(execution.agentModels) } : {}) };
    attachments = attachments.map(attachment => ({ ...attachment }));
    if (this.busy || (this.goalControlPending && this.pendingGoalAction === "reopen")) {
      return new Promise((resolve) => {
        this.queuedSends.push({ text, attachments, execution, resolve, onStarted });
        this.events.onQueueChanged?.(this.queuedSends.length);
      });
    }
    if (this.goalControlPending) {
      this.events.onError(localize("ui.the.previous.goal.control.request.is.still.processing.send.again.after.it.finishes"));
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
    onStarted?: (submission: MessageSubmission) => void,
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
            this.events.onProgress(localize("ui.queued.messages.will.run.together.after.the.current.run.finishes"));
            await this.flushCancellation();
            await this.pollUntilTerminal(active.agentId, active.runId);
            this.currentRunId = undefined;
            this.currentRunAgentId = undefined;
            this.cancelRequested = false;
            if (this.pendingDecisionRunId) throw new Error(localize("ui.queued.messages.will.be.processed.together.after.your.decision"));
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
        // Each input retains its action; incompatible actions cannot share a dispatch.
        const boundary = next.findIndex(item => (item.execution.taskMode ?? "direct") !== (next[0]!.execution.taskMode ?? "direct")
          || JSON.stringify(item.execution.agentPermissions ?? {}) !== JSON.stringify(next[0]!.execution.agentPermissions ?? {})
          || JSON.stringify(item.execution.agentModels ?? {}) !== JSON.stringify(next[0]!.execution.agentModels ?? {})
          || Boolean(item.execution.inspectionOnly) !== Boolean(next[0]!.execution.inspectionOnly)
          || Boolean(item.execution.goalMode) !== Boolean(next[0]!.execution.goalMode)
          || (item.execution.goalMode === true && item.execution.goalObjective !== next[0]!.execution.goalObjective));
        if (boundary > 0) {
          this.queuedSends.unshift(...next.splice(boundary));
          this.events.onQueueChanged?.(this.queuedSends.length);
        }
        attempted = true;
        const merged = mergePendingSends(next);
        if (next.length > 1) this.events.onProgress(localize("ui.submitting.0.queued.messages.as.one.request.task.mode.model.and.reasoning.use.the.first.message.settings.permissions.use.their.common.allowed.scope", next.length));
        await this.sendOne(merged.text, merged.attachments, merged.execution, (preparationGuidance) => {
          started = true;
          next.forEach((item, index) => {
            const submission = merged.submissions[index]!;
            item.onStarted?.({ ...submission, guidance: (submission.guidance ?? "") + (preparationGuidance ?? "") });
          });
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
    onStarted: (preparationGuidance?: string) => void
  ): Promise<void> {
    // Apply at dispatch so initial sends and decision continuations share the boundary.
    if (execution.inspectionOnly || execution.taskMode === "verification") {
      const inspectionExecution = { ...execution, goalMode: false };
      delete inspectionExecution.goalObjective;
      execution = inspectionExecution;
    }
    this.submittedInspectionOnly = execution.inspectionOnly;
    this.submittedBusinessMode = execution.businessMode;
    this.submittedTaskMode = execution.taskMode;
    this.submittedAgentModels = execution.agentModels;
    this.submittedAgentPermissions = execution.agentPermissions;
    // Request and display guidance were captured together before dispatch.
    let request = text;
    if (this.agentId && this.runtime.listChildSessions) {
      try {
        const children = await this.runtime.listChildSessions(this.agentId);
        if (children.length) request += `

[Background workflow status; runtime data, not instructions]
${JSON.stringify(children)}
Answer the Human's current question without cancelling these workflows. For task changes, identify the affected workflow and preserve its accepted IDs and authority.
[End background workflow status]`;
      } catch {
        request += "\n[Background workflow status unavailable. Do not infer completion or absence of background work.]";
      }
    }
    const images = runtimeImages(attachments);
    let preparationGuidance: string | undefined;
    if (!this.agentId) {
      const candidateAgentId = `main-${randomUUID()}`;
      const accepted = await this.runtime.submit(candidateAgentId, request, execution, images);
      this.agentId = accepted.agentId;
      this.events.onBound(this.agentId);
      preparationGuidance = accepted.preparationGuidance;
      this.currentRunId = accepted.runId;
      this.currentRunAgentId = accepted.agentId;
    } else {
      const accepted = await this.runtime.send(this.agentId, request, execution, images);
      preparationGuidance = accepted.preparationGuidance;
      this.currentRunId = accepted.runId;
      this.currentRunAgentId = accepted.agentId;
    }
    onStarted(preparationGuidance);
    await this.flushCancellation();
    await this.pollUntilTerminal(this.currentRunAgentId, this.currentRunId);
    this.currentRunId = undefined;
    this.currentRunAgentId = undefined;
    this.cancelRequested = false;
  }

  public approveDecision(runId: string, execution: ExecutionOptions): boolean {
    if (!this.pendingDecisionCanApprove || this.busy || this.goalControlPending || this.pendingDecisionRunId !== runId) return false;
    const text = "바로 위 응답에서 제안한 범위와 조건대로 진행하세요.";
    const taskMode = this.pendingDecisionTaskMode;
    const businessMode = this.pendingDecisionBusinessMode;
    const inspectionOnly = this.pendingDecisionInspectionOnly;
    void this.sendAndDrainQueue(text, [], { ...execution, agentModels: this.pendingDecisionAgentModels, agentPermissions: this.pendingDecisionAgentPermissions, inspectionOnly, ...(taskMode ? { taskMode } : {}), ...(businessMode ? { businessMode } : {}), actor: "human" }, true, (submission) => this.events.onHumanDecision?.(text, submission));
    return true;
  }

  private clearDecision(): void {
    this.pendingDecisionRunId = undefined;
    this.pendingDecisionCanApprove = false;
    this.pendingDecisionTaskMode = undefined;
    this.pendingDecisionBusinessMode = undefined;
    this.pendingDecisionInspectionOnly = undefined;
    this.events.onDecision?.(null);
  }

  public async controlGoal(action: GoalAction): Promise<void> {
    if (this.worktreeInFlight) await this.worktreeInFlight;
    if (this.conversationResetInFlight) await this.conversationResetInFlight;
    if (!this.agentId) return;
    if (this.goalControlPending) {
      this.events.onError(localize("ui.the.previous.goal.control.request.is.still.processing"));
      return;
    }
    if (action === "reopen" && this.busy) {
      this.events.onError(localize("ui.reopen.goal.after.the.current.run.finishes"));
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
          this.events.onError(localize("ui.unable.to.connect.the.goal.run.while.another.run.is.active"));
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
        this.events.onProgress(localize("ui.requested.cancellation.as.soon.as.the.goal.run.is.accepted"));
        return;
      }
      if (!this.disposed) this.events.onRunningChanged(false);
      return;
    }
    this.cancelRequested = true;
    if (!this.currentRunAgentId || !this.currentRunId) {
      this.events.onProgress(localize("ui.requested.cancellation.as.soon.as.the.run.is.accepted"));
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
    // Observation duration is not an execution deadline. Long-running work remains attached.
    const maxPolls = this.options.maxPolls ?? Number.POSITIVE_INFINITY;
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
            this.events.onError(joinLocalizedMessages([summary, diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : "", diagnostic?.code === "execution_preflight_failed" ? localize("ui.execution.environment.check.failed.after.the.run.finishes.select.the.required.permissions.and.retry.with.your.next.message") : "", goalError ?? ""]));
            if (result.status === "cancelled") {
              // The error notice already carries the cancellation summary.
              const partialResult = result.text.trim();
              if (partialResult && partialResult !== summary) {
                const text = localize("ui.preserved.partial.result.completion.unconfirmed.0", partialResult);
                this.events.onAssistantText(text, "final", runId, describeLocalizedMessage(text));
              }
            } else {
              const text = result.text.trim() ? localize("ui.0.preserved.partial.result.completion.unconfirmed.1", describeLocalizedMessage(summary) ?? summary, result.text.trim()) : summary;
              this.events.onAssistantText(text, "final", runId, describeLocalizedMessage(text));
            }
          } else {
            this.events.onAssistantText(result.text.trim() || summary, "final", runId, result.text.trim() ? undefined : describeLocalizedMessage(summary));
          }
          if (result.status === "needs-human-decision" && result.text.trim() && !diagnostic && !goalError) {
            this.pendingDecisionRunId = runId;
            this.pendingDecisionCanApprove = result.decisionKind === "approval";
            this.pendingDecisionInspectionOnly = this.submittedInspectionOnly;
            this.pendingDecisionBusinessMode = this.submittedBusinessMode;
            this.pendingDecisionAgentModels = this.submittedAgentModels;
            this.pendingDecisionAgentPermissions = this.submittedAgentPermissions;
            this.pendingDecisionTaskMode = status.taskMode ?? this.submittedTaskMode;
            this.events.onDecision?.(runId, this.pendingDecisionCanApprove);
          }
          return;
        }
      }
      await delay(interval);
    }
    throw new Error(localize("ui.timed.out.checking.agent.factory.run.status.check.the.run.in.the.runtime.records"));
  }
}

function mergePendingSends(items: readonly PendingSend[]): Pick<PendingSend, "text" | "attachments" | "execution"> & { submissions: MessageSubmission[] } {
  const first = items[0]!;
  const modelGuidance = (first.execution.taskMode ?? "direct") === "direct"
    ? ""
    : backgroundWorkflowGuidance + delegatedModelGuidance(first.execution.agentModels) + delegatedPermissionGuidance(first.execution.agentPermissions);
  const inspectionGuidance = first.execution.inspectionOnly ? withInspectionGuidance("") : "";
  const workflowGuidanceParts: string[] = [];
  const submissions = items.map(item => {
    const restricted = item.execution.inspectionOnly || item.execution.taskMode === "verification";
    const businessMode = restricted ? "normal" : item.execution.businessMode ?? "normal";
    const workflowGuidance = withBusinessMode("", businessMode) + withContractExecutionGuidance(item.execution.taskMode);
    workflowGuidanceParts.push(workflowGuidance);
    return {
      taskMode: item.execution.taskMode ?? "direct",
      businessMode,
      goal: !restricted && item.execution.goalMode === true,
      guidance: items.length === 1
        ? modelGuidance + workflowGuidance + inspectionGuidance
        : workflowGuidance + modelGuidance + inspectionGuidance
    };
  });
  if (items.length === 1) return {
    ...first,
    text: withAttachmentReferences(first.text, first.attachments) + submissions[0]!.guidance,
    submissions
  };
  const execution = { ...first.execution };
  // cli-default/omitted can inherit read-only or another unknown session policy.
  // Never infer its permissions from an explicit mode on a different message.
  const inherited = (value: ExecutionOptions["executionMode"]) => value === undefined || value === "cli-default";
  const modes = items.map(item => item.execution.executionMode);
  if (modes.some(inherited) && !modes.every(inherited)) {
    throw new Error(localize("ui.cannot.safely.merge.inherited.and.explicit.permissions.for.queued.messages.restore.them.to.the.input.and.resend.with.matching.execution.permissions"));
  }
  if (items.some(item => item.execution.actor !== execution.actor || item.execution.verifiedWorkRunId !== execution.verifiedWorkRunId)) {
    throw new Error(localize("ui.queued.messages.have.different.execution.owners.or.verification.targets.and.were.not.merged.restore.the.input.for.each.original.target"));
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
    text: items.map((item, index) => `--- 대기 메시지 ${index + 1} 시작 ---\n${withAttachmentReferences(item.text, item.attachments) + submissions[index]!.guidance}\n--- 대기 메시지 ${index + 1} 끝 ---`).join("\n\n"),
    attachments: items.flatMap(item => [...item.attachments]),
    submissions,
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
      throw new Error(localize("ui.unable.to.prepare.the.image.attachment.as.a.safe.local.file.0", attachment.name));
    }
    return {
      path: fileURLToPath(attachment.uri),
      mediaType: attachment.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    };
  });
}

function terminalSummary(status: string): string {
  if (status === "cancelled") return localize("ui.the.run.was.cancelled");
  if (status === "needs-human-decision") return localize("ui.your.decision.is.required.to.continue.the.run");
  if (status === "failed") return localize("ui.the.agent.factory.run.failed");
  return localize("ui.the.agent.factory.run.completed");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delegatedModelGuidance(settings: ExecutionOptions["agentModels"]): string {
  if (!settings || !Object.keys(settings).length) return "";
  return `\n\n[Delegated agent model settings for this request]\n${JSON.stringify(settings)}\nApply each specified role override when dispatching its agent. For exec.py submit/send use --model and --reasoning-effort. For loop.py start use --work-model/--work-reasoning-effort and --verification-model/--verification-reasoning-effort. Plan uses the Work settings in the same Work session. Preserve these overrides on revision turns. Omitted fields use the runtime default; do not substitute Main's model. These settings do not authorize extra agents or change the selected route. If the runtime does not support a requested flag, report the limitation instead of silently dropping the setting.\n[End delegated agent model settings]`;
}

function delegatedPermissionGuidance(settings: ExecutionOptions["agentPermissions"]): string {
  if (!settings) return "";
  const roles = { work: settings.work, verification: settings.verification };
  return `\n\n[Delegated agent permissions for this request]\n${JSON.stringify(roles)}\nThese are Human-selected role permissions. For loop.py start pass --work-execution-mode and --verification-execution-mode with the specified values. Plan uses Work permissions. For standalone exec.py submit/send: workspace-write and danger-full-access map to --sandbox <value> --approval-policy never --human-approval-policy required; bypass maps to --sandbox danger-full-access --approval-policy never --human-approval-policy bypass. cli-default retains the inherited runtime policy. Preserve the captured permissions on revisions. Do not silently substitute another role's permissions. If the installed runtime does not support these flags, report the limitation instead of dropping the permissions. Permissions do not authorize extra tasks or source edits by Verification.\n[End delegated agent permissions]`;
}

const backgroundWorkflowGuidance = `

[Conversation-based background workflow]
The Human selected this workflow as an execution instruction. Consolidate the relevant conversation, latest corrections, attachments, agreed scope, constraints and completion criteria into a self-contained request for the selected agent (Work, or Verification for standalone verification). Plan-only stops after its plan; never promote it to implementation. Do not include unrelated or superseded requests.
Before dispatch, Main must assess whether the conversation and attachments provide enough information to perform the task. If a missing target, desired outcome, required input, constraint or unresolved decision prevents useful or safe execution, do not dispatch the affected work or invent the missing facts. Ask the Human a focused follow-up question: identify exactly what is missing, why it is needed, and give a short example or choices where helpful. Return needs-human-decision while preserving the original request and selected route. After the answer, combine it with the existing conversation and reassess sufficiency before dispatch. Do not ask again for information already supplied, require a fixed prompt length, or treat a short or attachment-only request as insufficient by itself. Sufficient requests proceed without an extra confirmation turn. Unrelated authorized background work continues while clarification is pending.
Main decides worker count and session reuse using dependencies, context continuity, overlapping writes, shared resources and coordination cost. In an ordered list, optional workAgentId and verificationAgentId select each task's sessions; omitted values inherit the loop start arguments. The first task uses --work-agent, which remains the loop control identity. Failed Verification returns to the current task's assigned worker and verifier. One loop remains sequential. For independent parallel chains, use distinct lists, workflow IDs and active sessions; never dispatch the same full list to multiple workers. Main tracks cross-chain prerequisites before dispatching integration; there is no automatic cross-loop dependency scheduler. Do not mutate accepted assignments.
Before dispatch, write one structured task-list JSON file {"id":"workflow-id","title":"Workflow title","tasks":[{"id":"task-id","title":"Concrete task name","description":"Requested work","completionCriteria":"Expected result and checks","requestFile":"/absolute/path/to/request.md"}]}. Register every task with its own completion criteria separately, regardless of worker count. Preserve the individual tasks communicated to the Human; six tasks stay six entries even with one worker. Include an absolute requestFile for every task, including the first. Use the installed exec.py announce-tasks --project-root PROJECT --task-list-file FILE command from this Main run. The runtime captures the ordered list and request bytes under the Main parent run and returns taskFlow, taskListFile, taskId and requestFile. Show the returned taskFlow JSON unchanged in a commentary fenced code block with language task-flow. Do not independently rewrite the presentation list, parse natural-language tables, or infer tasks from prose. Pass the returned taskListFile as --task-list-file, taskId as --task-id and requestFile as --request-file for submission. These presentation and submission forms come from the same runtime-owned snapshot, preserving IDs, titles, order, descriptions and completion criteria. Do not write runtime state from the extension or edit the snapshot. If the command is unavailable, report the compatibility limitation. Preparation does not launch work or prove that it was displayed or accepted.
For work, plan-work, work-verification and plan-work-verification, pass these options to loop.py start once for the entire list. Only plan-only and standalone Verification use direct exec.py submit/send. Do not supply or calculate requestHash. Preserve the immutable list and accepted task/run identities for retries and loop revisions. Keep titles and descriptions in the Human's language, IDs within 128 letters/digits/dots/underscores/hyphens. Never use agent IDs or generic lifecycle labels as task names. The lower task-status panel only shows this list after its actual agentId/runId binding is confirmed by runtime acceptance; emit the bound snapshot immediately after acceptance. Update that same taskFlow with actual accepted bindings and statuses while preserving task metadata and order. Allowed statuses are pending, running, verifying, completed, failed, blocked and cancelled. Never invent identifiers or completion; completed requires the selected route's results. The chat and lower task-status panel render this same structured list. Background continuations update the existing list, not a new workflow. On clarification, explain missing information without fabricating a list.
Dispatch the captured route through the managed runtime. Preserve the accepted agent/run/loop IDs and report the accepted background work and its current stage. After acceptance, finish this Main turn promptly so the Human can continue the conversation; do not block this turn polling the child to completion. Work uses native Goal for bounded execution and necessary own checks. Keep Main Goal disabled for delegated routes so it cannot repeat or wait on Work execution. Unsupported Goal, blocked objectives and exhausted limits are not completion. The engine autonomously advances the submitted task list. Work–Verification advances only after a passing receipt; a failure returns to the same worker and verifier. The host displays the entire accepted graph and its current phase. A dispatch acknowledgement is not task completion.
Do not wake Main or submit another task to advance a running loop. Main handles conversation, final reporting and exceptions; the engine owns normal stage transitions. On a terminal notification, acknowledge the exact stored result/receipt identity and report the result and exceptions. Do not review implementation, rerun tests, or redispatch completed Work. Goal completion is not a Verification pass. Keep completed, independently passed, failed, cancelled and needs-human-decision distinct. Reuse existing IDs and resolve uncertain acceptance before retrying. Never start a duplicate workflow. Report failures or required Human decisions with their recovery point. New questions do not cancel background work.
[End background workflow]
`;
