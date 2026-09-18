import { parseAgentModels } from "../../common/types/agent-models";
import type { AgentModels } from "../../common/types/agent-models";
import type { BusinessMode } from "../../common/types/business-mode";
import { type TaskSelection } from "./task-selection";
import { randomUUID } from "node:crypto";

export interface ChatPanelState {
  readonly panelId: string;
  readonly title: string;
  readonly agentId?: string;
  readonly role?: "main" | "work" | "verification";
  readonly verifiedWorkRunId?: string;
  readonly model?: string;
  readonly agentModels?: AgentModels;
  readonly reasoning?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly fastMode?: boolean;
  readonly goalMode?: boolean;
  readonly workLoopMode?: boolean;
  readonly taskMode?: TaskSelection;
  readonly businessMode?: BusinessMode;
  readonly contextUsedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly weeklyUsedPercent?: number;
}

export type ComposerPreferences = Pick<
  ChatPanelState,
  "agentModels" | "model" | "reasoning" | "fastMode" | "goalMode" | "workLoopMode" | "taskMode" | "businessMode"
>;

export function createDraftChatState(preferences: ComposerPreferences = {}): ChatPanelState {
  return {
    panelId: randomUUID(),
    title: "Main Agent",
    ...preferences,
    businessMode: "normal",
    goalMode: false,
    taskMode: "direct",
    workLoopMode: false
  };
}

export function restoreChatState(
  value: unknown,
  preferences: ComposerPreferences = {}
): ChatPanelState {
  if (!isRecord(value)) {
    return createDraftChatState(preferences);
  }

  return {
    panelId: readNonEmptyString(value.panelId) ?? randomUUID(),
    title: readNonEmptyString(value.title) ?? "Main Agent",
    ...(readRole(value.role) ? { role: readRole(value.role) } : {}),
    ...(readManagedId(value.verifiedWorkRunId) ? { verifiedWorkRunId: readManagedId(value.verifiedWorkRunId) } : {}),
    ...(readNonEmptyString(value.model)
      ? { model: readNonEmptyString(value.model) }
      : preferences.model ? { model: preferences.model } : {}),
    ...(readReasoning(value.reasoning)
      ? { reasoning: readReasoning(value.reasoning) }
      : preferences.reasoning ? { reasoning: preferences.reasoning } : {}),
    ...((parseAgentModels(value.agentModels) ?? preferences.agentModels) ? { agentModels: parseAgentModels(value.agentModels) ?? preferences.agentModels } : {}),
    fastMode: typeof value.fastMode === "boolean" ? value.fastMode : preferences.fastMode === true,
    goalMode: false,
    businessMode: "normal",
    taskMode: "direct",
    workLoopMode: false,
    ...(readCount(value.contextUsedTokens) !== undefined
      ? { contextUsedTokens: readCount(value.contextUsedTokens) }
      : {}),
    ...(readCount(value.contextWindowTokens) !== undefined
      ? { contextWindowTokens: readCount(value.contextWindowTokens) }
      : {}),
    ...(readPercent(value.weeklyUsedPercent) !== undefined
      ? { weeklyUsedPercent: readPercent(value.weeklyUsedPercent) }
      : {}),
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

function readManagedId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function readReasoning(value: unknown): ChatPanelState["reasoning"] {
  return typeof value === "string" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ChatPanelState["reasoning"]
    : undefined;
}

function readRole(value: unknown): ChatPanelState["role"] {
  return typeof value === "string" && ["main", "work", "verification"].includes(value)
    ? value as ChatPanelState["role"]
    : undefined;
}

function readCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function readPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}
