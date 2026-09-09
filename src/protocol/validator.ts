import { STATUS_ITEM_IDS, type StatusItemId } from "../core/config/types";
import type { AttachmentKind, AttachmentReference } from "../common/types/attachment";
import type { ClientMessage } from "./messages";

const clientMessageTypes = new Set([
  "client.ready",
  "execution.pick",
  "reference.copy",
  "chat.send",
  "decision.approve",
  "run.cancel",
  "goal.control",
  "sessions.request",
  "models.request",
  "session.select",
  "agents.request",
  "agent.open",
  "attachments.pick",
  "composer.settings",
  "status.reorder"
]);
const attachmentKinds = new Set<AttachmentKind>(["file", "folder", "image"]);
const statusItemIds = new Set<string>(STATUS_ITEM_IDS);
const reasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !clientMessageTypes.has(value.type)) {
    return undefined;
  }

  switch (value.type) {
    case "reference.copy":
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) return undefined;
      return { type: value.type, id: value.id };
    case "decision.approve":
      if (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) return undefined;
      return { type: value.type, runId: value.runId };
    case "goal.control":
      if (typeof value.action !== "string" || !["get", "refresh", "pause", "cancel", "disable", "reopen"].includes(value.action)) return undefined;
      return { type: "goal.control", action: value.action as import("../infrastructure/agent-factory/agent-client").GoalAction };
    case "execution.pick":
    case "client.ready":
    case "run.cancel":
    case "sessions.request":
    case "models.request":
    case "agents.request":
    case "attachments.pick":
      return { type: value.type };
    case "session.select":
    case "agent.open":
      if (typeof value.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.agentId)) {
        return undefined;
      }
      return { type: value.type, agentId: value.agentId };
    case "composer.settings":
      if (
        (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 100)) ||
        (value.reasoning !== undefined && (typeof value.reasoning !== "string" || !reasoningEfforts.has(value.reasoning))) ||
        typeof value.fastMode !== "boolean" ||
        typeof value.goalMode !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: value.type,
        ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
        ...(typeof value.reasoning === "string"
          ? { reasoning: value.reasoning as "none" | "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        fastMode: value.fastMode,
        goalMode: value.goalMode
      };
    case "chat.send": {
      if (
        typeof value.id !== "string" ||
        !value.id ||
        typeof value.text !== "string" ||
        value.text.length > 100_000 ||
        !Array.isArray(value.attachments) ||
        !isRecord(value.execution) ||
        (value.execution.model !== undefined && (
          typeof value.execution.model !== "string" || value.execution.model.length > 100
        )) ||
        (value.execution.reasoningEffort !== undefined && (
          typeof value.execution.reasoningEffort !== "string" ||
          !reasoningEfforts.has(value.execution.reasoningEffort)
        )) ||
        (value.execution.goalObjective !== undefined && (typeof value.execution.goalObjective !== "string" ||
          !value.execution.goalObjective.trim() || value.execution.goalObjective.length > 4000 || value.execution.goal !== true)) ||
        typeof value.execution.fast !== "boolean" ||
        typeof value.execution.goal !== "boolean"
      ) {
        return undefined;
      }
      const attachments = value.attachments
        .map(parseAttachment)
        .filter((attachment): attachment is AttachmentReference => Boolean(attachment));
      if (attachments.length !== value.attachments.length || attachments.length > 100) {
        return undefined;
      }
      return {
        type: value.type,
        id: value.id,
        text: value.text,
        attachments,
        execution: {
          ...(typeof value.execution.model === "string" && value.execution.model
            ? { model: value.execution.model }
            : {}),
          ...(typeof value.execution.reasoningEffort === "string"
            ? { reasoningEffort: value.execution.reasoningEffort as "none" | "low" | "medium" | "high" | "xhigh" | "max" }
            : {}),
          fast: value.execution.fast,
          goal: value.execution.goal,
          ...(typeof value.execution.goalObjective === "string" ? { goalObjective: value.execution.goalObjective } : {})
        }
      };
    }
    case "status.reorder": {
      if (!Array.isArray(value.items)) {
        return undefined;
      }
      const items = value.items.filter(
        (item): item is StatusItemId => typeof item === "string" && statusItemIds.has(item)
      );
      if (items.length !== value.items.length || new Set(items).size !== items.length) {
        return undefined;
      }
      return { type: value.type, items };
    }
  }
}

function parseAttachment(value: unknown): AttachmentReference | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.kind !== "string" ||
    !attachmentKinds.has(value.kind as AttachmentKind)
  ) {
    return undefined;
  }

  if (
    (value.uri !== undefined && typeof value.uri !== "string") ||
    (value.mediaType !== undefined && typeof value.mediaType !== "string") ||
    (value.size !== undefined && (typeof value.size !== "number" || value.size < 0))
  ) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    kind: value.kind as AttachmentKind,
    ...(typeof value.uri === "string" ? { uri: value.uri } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
