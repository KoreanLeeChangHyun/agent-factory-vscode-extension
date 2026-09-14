import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AttachmentReference } from "../../common/types/attachment";
import type { AgentRuntimeClient, ExecutionOptions, NativeGoal, GoalAction } from "../../infrastructure/agent-factory/agent-client";

const TERMINAL_STATES = new Set(["completed", "needs-human-decision", "failed", "cancelled"]);

export interface SessionControllerEvents {
  readonly onBound: (agentId: string) => void;
  readonly onRunningChanged: (running: boolean) => void;
  readonly onQueueChanged?: (count: number) => void;
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

export class ChatSessionController {
  private agentId: string | undefined;
  private currentRunId: string | undefined;
  private currentRunAgentId: string | undefined;
  private busy = false;
  private pendingDecisionRunId: string | undefined;
  private pendingDecisionTaskMode: ExecutionOptions["taskMode"];
  private submittedTaskMode: ExecutionOptions["taskMode"];
  private cancelRequested = false;
  private cancellationInFlight: Promise<void> | undefined;
  private goalControlPending = false;
  private pendingGoalAction: GoalAction | undefined;
  private disposed = false;
  private readonly queuedSends: Array<{
    readonly text: string;
    readonly attachments: readonly AttachmentReference[];
    readonly execution: ExecutionOptions;
    readonly resolve: () => void;
    readonly onStarted?: () => void;
  }> = [];

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
    for (const queued of this.queuedSends.splice(0)) queued.resolve();
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
        this.events.onProgress("진행 중인 작업에 다시 연결했습니다.");
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
    const queued = this.pendingDecisionRunId ? undefined : this.queuedSends.shift();
    if (queued) this.events.onQueueChanged?.(this.queuedSends.length);
    if (queued && !this.disposed) {
      void this.sendAndDrainQueue(queued.text, queued.attachments, queued.execution, false, queued.onStarted).finally(queued.resolve);
    } else if (!this.disposed) {
      this.events.onRunningChanged(false);
    } else {
      queued?.resolve();
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
      this.events.onError("이전 Goal 제어 요청이 처리 중입니다. 완료된 뒤 다시 보내세요.");
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
    onStarted?: () => void
  ): Promise<void> {
    this.busy = true;
    this.events.onRunningChanged(true);
    let next: { readonly text: string; readonly attachments: readonly AttachmentReference[]; readonly execution: ExecutionOptions; readonly resolve?: () => void; readonly onStarted?: () => void } | undefined = {
      text, attachments, execution, onStarted
    };
    let retainedCompletion: Promise<void> | undefined;
    let interrupted = false;
    while (next && !this.disposed) {
      let started = false;
      let dispatched = false;
      try {
        await this.sendOne(next.text, next.attachments, next.execution, checkActiveRun, () => {
          started = true;
          next?.onStarted?.();
        }, () => { dispatched = true; });
      } catch (error) {
        // Discovery/transport errors cannot establish that the active execution ended.
        interrupted = true;
        if (!started && !dispatched) {
          let resolve = next.resolve;
          if (!resolve) retainedCompletion = new Promise<void>(done => { resolve = done; });
          this.queuedSends.unshift({ ...next, resolve: resolve! });
          this.events.onQueueChanged?.(this.queuedSends.length);
        } else next.resolve?.();
        this.events.onError(errorMessage(error));
        break;
      }
      checkActiveRun = false;
      next.resolve?.();
      if (this.pendingDecisionRunId) break;
      next = this.queuedSends.shift();
      if (next) this.events.onQueueChanged?.(this.queuedSends.length);
    }
    if (!interrupted) {
      this.currentRunId = undefined;
      this.currentRunAgentId = undefined;
      this.cancelRequested = false;
    }
    this.busy = false;
    if (!this.disposed) this.events.onRunningChanged(false);
    await retainedCompletion;
  }

  private async sendOne(
    text: string,
    attachments: readonly AttachmentReference[],
    execution: ExecutionOptions,
    checkActiveRun = true,
    onStarted?: () => void,
    onDispatch?: () => void
  ): Promise<void> {
    this.clearDecision();
    this.cancelRequested = false;
    {
      if (this.agentId && checkActiveRun) {
        const active = await this.runtime.activeRun?.(this.agentId);
        if (active) {
          this.currentRunId = active.runId;
          this.currentRunAgentId = active.agentId;
          this.events.onProgress("진행 중인 작업이 끝난 뒤 입력한 요청을 이어서 실행합니다.");
          await this.flushCancellation();
          await this.pollUntilTerminal(active.agentId, active.runId);
          this.currentRunId = undefined;
          this.currentRunAgentId = undefined;
          this.cancelRequested = false;
          if (this.pendingDecisionRunId) throw new Error("사용자 결정 후 대기 메시지를 이어서 처리합니다.");
        }
      }
      if (this.disposed) return;
      this.submittedTaskMode = execution.taskMode;
      onDispatch?.();
      const request = withAttachmentReferences(text, attachments);
      const images = runtimeImages(attachments);
      if (!this.agentId) {
        const candidateAgentId = `main-${randomUUID()}`;
        const accepted = await this.runtime.submit(candidateAgentId, request, execution, images);
        this.agentId = accepted.agentId;
        this.events.onBound(this.agentId);
        onStarted?.();
        this.currentRunId = accepted.runId;
        this.currentRunAgentId = accepted.agentId;
        await this.flushCancellation();
        await this.pollUntilTerminal(accepted.agentId, accepted.runId);
      } else {
        const accepted = await this.runtime.send(this.agentId, request, execution, images);
        onStarted?.();
        this.currentRunId = accepted.runId;
        this.currentRunAgentId = accepted.agentId;
        await this.flushCancellation();
        await this.pollUntilTerminal(accepted.agentId, accepted.runId);
      }
    }
    this.currentRunId = undefined;
    this.currentRunAgentId = undefined;
    this.cancelRequested = false;
  }

  public approveDecision(runId: string, execution: ExecutionOptions): boolean {
    if (this.busy || this.goalControlPending || this.pendingDecisionRunId !== runId) return false;
    const text = "바로 위 응답에서 제안한 범위와 조건대로 진행하세요.";
    const taskMode = this.pendingDecisionTaskMode;
    void this.sendAndDrainQueue(text, [], { ...execution, ...(taskMode ? { taskMode } : {}), actor: "human" }, true, () => this.events.onHumanDecision?.(text));
    return true;
  }

  private clearDecision(): void {
    this.pendingDecisionRunId = undefined;
    this.pendingDecisionTaskMode = undefined;
    this.events.onDecision?.(null);
  }

  public async controlGoal(action: GoalAction): Promise<void> {
    if (!this.agentId) return;
    if (this.goalControlPending) {
      this.events.onError("이전 Goal 제어 요청이 처리 중입니다.");
      return;
    }
    if (action === "reopen" && this.busy) {
      this.events.onError("현재 실행이 끝난 뒤 Goal을 다시 여세요.");
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
          this.events.onError("다른 실행이 진행 중이어서 Goal 실행을 연결할 수 없습니다.");
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
        this.events.onProgress("Goal 실행 접수 즉시 취소하도록 요청했습니다.");
        return;
      }
      if (!this.disposed) this.events.onRunningChanged(false);
      return;
    }
    this.cancelRequested = true;
    if (!this.currentRunAgentId || !this.currentRunId) {
      this.events.onProgress("실행 접수 즉시 취소하도록 요청했습니다.");
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
            this.events.onError([summary, diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : "", diagnostic?.code === "execution_preflight_failed" ? "실행 환경 확인에 실패했습니다. 실행이 끝난 뒤 필요한 권한을 선택하고 다음 메시지로 다시 시도하세요." : "", goalError ?? ""].filter(Boolean).join("\n"));
            this.events.onAssistantText(result.text.trim() ? `${summary}\n\n보존된 부분 결과 (완료 확인 아님):\n${result.text.trim()}` : summary, "final", runId);
          } else {
            this.events.onAssistantText(result.text.trim() || summary, "final", runId);
          }
          if (result.status === "needs-human-decision" && result.text.trim() && !diagnostic && !goalError) {
            this.pendingDecisionRunId = runId;
            this.pendingDecisionTaskMode = status.taskMode ?? this.submittedTaskMode;
            this.events.onDecision?.(runId);
          }
          return;
        }
      }
      await delay(interval);
    }
    throw new Error("Agent Factory 실행 상태 확인 시간이 초과되었습니다. 런타임 기록에서 실행을 확인하세요.");
  }
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
      throw new Error(`이미지 첨부를 안전한 로컬 파일로 준비하지 못했습니다: ${attachment.name}`);
    }
    return {
      path: fileURLToPath(attachment.uri),
      mediaType: attachment.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    };
  });
}

function terminalSummary(status: string): string {
  if (status === "cancelled") return "실행이 취소되었습니다.";
  if (status === "needs-human-decision") return "실행을 계속하려면 사용자 결정이 필요합니다.";
  if (status === "failed") return "Agent Factory 실행이 실패했습니다.";
  return "Agent Factory 실행이 완료되었습니다.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
