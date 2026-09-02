import { randomUUID } from "node:crypto";
import type { AttachmentReference } from "../../common/types/attachment";
import type { AgentRuntimeClient, ExecutionOptions } from "../../infrastructure/agent-factory/agent-client";

const TERMINAL_STATES = new Set(["completed", "needs-human-decision", "failed", "cancelled"]);

export interface SessionControllerEvents {
  readonly onBound: (agentId: string) => void;
  readonly onRunningChanged: (running: boolean) => void;
  readonly onAssistantText: (text: string) => void;
  readonly onProgress: (text: string) => void;
  readonly onActivity: (activity: {
    readonly id: string;
    readonly category: "command" | "file" | "tool";
    readonly phase: "started" | "completed" | "failed";
    readonly text: string;
    readonly title?: string;
    readonly diff?: string;
  }) => void;
  readonly onError: (message: string) => void;
}

export interface SessionControllerOptions {
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export class ChatSessionController {
  private agentId: string | undefined;
  private currentRunId: string | undefined;
  private busy = false;

  public constructor(
    private readonly runtime: AgentRuntimeClient,
    private readonly events: SessionControllerEvents,
    agentId?: string,
    private readonly options: SessionControllerOptions = {}
  ) {
    this.agentId = agentId;
  }

  public get running(): boolean {
    return this.busy;
  }

  public async send(
    text: string,
    attachments: readonly AttachmentReference[],
    execution: ExecutionOptions
  ): Promise<void> {
    if (this.busy) {
      this.events.onError("현재 Main Agent turn이 실행 중입니다. 완료되거나 취소된 뒤 다시 보내세요.");
      return;
    }
    this.busy = true;
    this.events.onRunningChanged(true);
    try {
      const request = withAttachmentReferences(text, attachments);
      if (!this.agentId) {
        const candidateAgentId = `main-${randomUUID()}`;
        const accepted = await this.runtime.submit(candidateAgentId, request, execution);
        this.agentId = accepted.agentId;
        this.events.onBound(this.agentId);
        this.currentRunId = accepted.runId;
        await this.pollUntilTerminal(accepted.agentId, accepted.runId);
      } else {
        const accepted = await this.runtime.send(this.agentId, request, execution);
        this.currentRunId = accepted.runId;
        await this.pollUntilTerminal(accepted.agentId, accepted.runId);
      }
    } catch (error) {
      this.events.onError(errorMessage(error));
    } finally {
      this.currentRunId = undefined;
      this.busy = false;
      this.events.onRunningChanged(false);
    }
  }

  public async cancel(): Promise<void> {
    if (!this.busy || !this.agentId || !this.currentRunId) {
      this.events.onError("현재 실행 중인 Agent가 없습니다.");
      return;
    }
    try {
      await this.runtime.cancel(this.agentId, this.currentRunId);
    } catch (error) {
      this.events.onError(errorMessage(error));
    }
  }

  private async pollUntilTerminal(agentId: string, runId: string): Promise<void> {
    const maxPolls = this.options.maxPolls ?? 7_200;
    const interval = this.options.pollIntervalMs ?? 250;
    const statusPollStride = this.options.pollIntervalMs === undefined ? 3 : 1;
    let cursor = 0;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const updates = await this.runtime.updates(agentId, runId, cursor);
      cursor = updates.cursor;
      for (const update of updates.updates) {
        if (update.kind === "status") {
          this.events.onProgress(update.text);
        } else {
          this.events.onActivity({ ...update, id: `${runId}:${update.id}` });
        }
      }
      if (poll % statusPollStride === 0) {
        const status = await this.runtime.status(agentId, runId);
        if (TERMINAL_STATES.has(status.status)) {
          const result = await this.runtime.result(agentId, runId);
          const text = result.text.trim() || terminalSummary(result.status);
          this.events.onAssistantText(text);
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
