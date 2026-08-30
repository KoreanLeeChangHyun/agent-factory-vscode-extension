import { randomUUID } from "node:crypto";

export interface ChatPanelState {
  readonly panelId: string;
  readonly title: string;
  readonly agentId?: string;
}

export function createDraftChatState(): ChatPanelState {
  return {
    panelId: randomUUID(),
    title: "Main Agent"
  };
}

export function restoreChatState(value: unknown): ChatPanelState {
  if (!isRecord(value)) {
    return createDraftChatState();
  }

  return {
    panelId: readNonEmptyString(value.panelId) ?? randomUUID(),
    title: readNonEmptyString(value.title) ?? "Main Agent",
    ...(readNonEmptyString(value.agentId)
      ? { agentId: readNonEmptyString(value.agentId) }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
