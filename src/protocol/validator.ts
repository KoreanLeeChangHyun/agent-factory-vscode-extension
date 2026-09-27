import { validAgentValue } from "../core/config/agent-settings";
import { parseAgentPermissions } from "../common/types/agent-permissions";
import { parseAgentModels } from "../common/types/agent-models";
import { BUSINESS_MODES, type BusinessMode } from "../common/types/business-mode";
import { TASK_SELECTIONS, type TaskSelection } from "../modules/chat/task-selection";
import { STATUS_ITEM_IDS, type StatusItemId } from "../core/config/types";
import type { AttachmentKind, AttachmentReference } from "../common/types/attachment";
import type { ClientMessage } from "./messages";

const clientMessageTypes = new Set([
  "agent.defaults.save",
  "client.ready",
  "worktree.create", "worktree.merge", "worktree.refresh",
  "notes.list",
  "notes.save",
  "bots.configure",
  "bot.talk",
  "bot.prompt.save",
  "execution.select",
  "reference.copy",
  "message.copy",
  "link.open",
  "image.resolve",
  "chat.send",
  "decision.approve",
  "sudo.reply",
  "run.cancel",
  "queue.resume",
  "conversation.clear",
  "goal.control",
  "sessions.request",
  "models.request",
  "session.select",
  "agents.request",
  "history.request",
  "contract.open",
  "contracts.request",
  "conversations.request",
  "conversation.read",
  "workflow.close",
  "agent.open",
  "attachments.pick",
  "attachments.createText",
  "attachments.createImage",
  "attachments.createFile",
  "attachments.restore",
  "attachment.revealConverted",
  "attachment.convert",
  "attachment.converted",
  "attachment.conversionFailed",
  "attachment.open",
  "attachment.remove",
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
    case "sudo.reply":
      if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) return undefined;
      if (value.cancelled === true) return { type: "sudo.reply", id: value.id, cancelled: true };
      if ([value.key, value.iv, value.data].every(part => typeof part === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(part)))
        return { type: "sudo.reply", id: value.id, key: value.key as string, iv: value.iv as string, data: value.data as string };
      return undefined;
    case "worktree.create":
    case "worktree.merge":
    case "worktree.refresh":
      return { type: value.type };
    case "bots.configure":
      return typeof value.enabled === "boolean" ? { type: value.type, enabled: value.enabled } : undefined;
    case "bot.prompt.save":
      return typeof value.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId) && typeof value.prompt === "string"
        ? { type: value.type, requestId: value.requestId, prompt: value.prompt } : undefined;
    case "bot.talk":
      return typeof value.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId) &&
        typeof value.text === "string" && value.text.trim().length > 0
        ? { type: value.type, requestId: value.requestId, text: value.text } : undefined;
    case "image.resolve":
    case "link.open":
      if (typeof value.href !== "string" || value.href.length < 1 || value.href.length > 8192 || /[\u0000-\u001f]/.test(value.href)) return undefined;
      if (!/^(?:https?:\/\/|mailto:|file:\/\/|\/|\.\.?\/)/i.test(value.href)) return undefined;
      return { type: value.type, href: value.href };
    case "message.copy":
      if (typeof value.text !== "string" || !value.text.length) return undefined;
      return { type: value.type, text: value.text };
    case "contract.open":
    case "reference.copy":
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) return undefined;
      return { type: value.type, id: value.id };
    case "decision.approve":
      if (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) return undefined;
      return { type: value.type, runId: value.runId };
    case "goal.control":
      if (typeof value.action !== "string" || !["get", "refresh", "pause", "cancel", "disable", "reopen"].includes(value.action)) return undefined;
      return { type: "goal.control", action: value.action as import("../infrastructure/agent-factory/agent-client").GoalAction };
    case "execution.select":
      if (typeof value.mode !== "string" || !["cli-default", "workspace-write", "danger-full-access", "bypass"].includes(value.mode)) return undefined;
      return { type: value.type, mode: value.mode as import("../infrastructure/agent-factory/agent-client").ExecutionMode };
    case "attachments.createText":
      if (typeof value.text !== "string" || value.text.length < 8_000) return undefined;
      return { type: value.type, text: value.text };
    case "attachments.createFile": {
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
          || typeof value.name !== "string" || !value.name || value.name.length > 255 || /[\\/\x00-\x1f]/.test(value.name) || [".", ".."].includes(value.name)
          || !Number.isSafeInteger(value.size) || (value.size as number) < 0
          || typeof value.data !== "string") return undefined;
      const content = Buffer.from(value.data, "base64");
      if (content.byteLength !== value.size || content.toString("base64") !== value.data) return undefined;
      return { type: value.type, id: value.id, name: value.name, size: value.size as number, data: value.data };
    }
    case "attachment.converted":
    case "attachments.createImage": {
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
          || typeof value.name !== "string" || !value.name || value.name.length > 255
          || typeof value.mediaType !== "string" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.mediaType)
          || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1
          || typeof value.data !== "string"
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return undefined;
      if (value.type === "attachment.converted" && value.mediaType === "image/gif") return undefined;
      const content = Buffer.from(value.data, "base64");
      if (content.byteLength !== value.size || content.toString("base64") !== value.data) return undefined;
      return { type: value.type, id: value.id, name: value.name, mediaType: value.mediaType, size: value.size, data: value.data };
    }
    case "attachments.restore": {
      if (!Array.isArray(value.attachments)) return undefined;
      const attachments = value.attachments.filter((item): item is { id: string; name: string; target: "composer" | "history" } => isRecord(item)
        && typeof item.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id)
        && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 255
        && (item.target === "composer" || item.target === "history"))
        .map(item => ({ id: item.id, name: item.name, target: item.target }));
      if (attachments.length !== value.attachments.length) return undefined;
      return { type: value.type, attachments };
    }
    case "attachment.convert":
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
          || typeof value.name !== "string" || !value.name || value.name.length > 255
          || typeof value.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.requestId)
          || typeof value.mediaType !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(value.mediaType)) return undefined;
      return { type: value.type, id: value.id, name: value.name, requestId: value.requestId, mediaType: value.mediaType };
    case "attachment.revealConverted":
    case "attachment.conversionFailed":
    case "attachment.open":
    case "attachment.remove":
      if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) return undefined;
      return { type: value.type, id: value.id };
    case "notes.list":
      if (value.scope !== "global" && value.scope !== "workspace") return undefined;
      return { type: value.type, scope: value.scope };
    case "notes.save": {
      if (value.scope !== "global" && value.scope !== "workspace") return undefined;
      const note = value.note as Record<string, unknown> | undefined;
      if (!note || typeof note.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(note.id) || typeof note.title !== "string" || typeof note.body !== "string" || !Number.isSafeInteger(note.revision) || Number(note.revision) < 0) return undefined;
      return { type: value.type, scope: value.scope, note: { id: note.id, title: note.title, body: note.body, revision: Number(note.revision) } };
    }
    case "agent.defaults.save":
      if ((value.scope !== "global" && value.scope !== "project") ||
          !["main", "work", "verification"].includes(String(value.role)) ||
          (value.field !== "model" && value.field !== "reasoningEffort") || !validAgentValue(value.field, value.value)) return undefined;
      return { type: value.type, scope: value.scope, role: value.role as "main" | "work" | "verification", field: value.field, value: value.value };
    case "client.ready":
    case "queue.resume":
    case "run.cancel":
    case "conversation.clear":
    case "contracts.request":
    case "conversations.request":
    case "sessions.request":
    case "models.request":
    case "agents.request":
    case "attachments.pick":
      return { type: value.type };
    case "conversation.read": {
      const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
      if ((value.conversationId !== null && !id(value.conversationId)) || !id(value.requestId) || (value.before !== undefined && !id(value.before))) return undefined;
      return { type: value.type, conversationId: value.conversationId as string | null, requestId: value.requestId, ...(value.before ? { before: value.before as string } : {}) };
    }
    case "history.request":
      if (typeof value.before !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.before)) return undefined;
      return { type: value.type, before: value.before };
    case "workflow.close":
      if (![value.workAgentId, value.loopId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) return undefined;
      return { type: value.type, workAgentId: value.workAgentId as string, loopId: value.loopId as string };
    case "session.select":
    case "agent.open":
      if (typeof value.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.agentId)) {
        return undefined;
      }
      return { type: value.type, agentId: value.agentId };
    case "composer.settings":
      if (
        (value.businessMode !== undefined && !BUSINESS_MODES.includes(value.businessMode as BusinessMode)) ||
        (value.taskMode !== undefined && !TASK_SELECTIONS.includes(value.taskMode as TaskSelection)) ||
        (value.agentModels !== undefined && !parseAgentModels(value.agentModels)) ||
        (value.agentPermissions !== undefined && !parseAgentPermissions(value.agentPermissions)) ||
        (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 100)) ||
        (value.reasoning !== undefined && (typeof value.reasoning !== "string" || !reasoningEfforts.has(value.reasoning))) ||
        typeof value.fastMode !== "boolean" ||
        (value.workLoopMode !== undefined && typeof value.workLoopMode !== "boolean") ||
        typeof value.goalMode !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: value.type,
        ...(value.agentModels !== undefined ? { agentModels: parseAgentModels(value.agentModels) } : {}),
        ...(value.agentPermissions !== undefined ? { agentPermissions: parseAgentPermissions(value.agentPermissions) } : {}),
        ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
        ...(typeof value.reasoning === "string"
          ? { reasoning: value.reasoning as "none" | "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(value.businessMode !== undefined ? { businessMode: value.businessMode as BusinessMode } : {}),
        ...(value.taskMode !== undefined ? { taskMode: value.taskMode as TaskSelection } : {}),
        fastMode: value.fastMode,
        goalMode: value.goalMode,
        ...(typeof value.workLoopMode === "boolean" ? { workLoopMode: value.workLoopMode } : {})
      };
    case "chat.send": {
      if (
        typeof value.id !== "string" ||
        !value.id ||
        typeof value.text !== "string" ||
        !Array.isArray(value.attachments) ||
        !isRecord(value.execution) ||
        (value.execution.businessMode !== undefined && !BUSINESS_MODES.includes(value.execution.businessMode as BusinessMode)) ||
        (value.execution.taskMode !== undefined && !TASK_SELECTIONS.includes(value.execution.taskMode as TaskSelection)) ||
        (value.execution.agentModels !== undefined && !parseAgentModels(value.execution.agentModels)) ||
        (value.execution.agentPermissions !== undefined && !parseAgentPermissions(value.execution.agentPermissions)) ||
        (value.execution.model !== undefined && (
          typeof value.execution.model !== "string" || value.execution.model.length > 100
        )) ||
        (value.execution.reasoningEffort !== undefined && (
          typeof value.execution.reasoningEffort !== "string" ||
          !reasoningEfforts.has(value.execution.reasoningEffort)
        )) ||
        (value.execution.goalObjective !== undefined && (typeof value.execution.goalObjective !== "string" ||
          !value.execution.goalObjective.trim() || value.execution.goal !== true)) ||
        typeof value.execution.fast !== "boolean" ||
        typeof value.execution.goal !== "boolean"
      ) {
        return undefined;
      }
      const attachments = value.attachments
        .map(parseAttachment)
        .filter((attachment): attachment is AttachmentReference => Boolean(attachment));
      if (attachments.length !== value.attachments.length) {
        return undefined;
      }
      const images = attachments.filter((attachment) => attachment.kind === "image");

      return {
        type: value.type,
        id: value.id,
        text: value.text,
        attachments,
        execution: {
          ...(value.execution.businessMode !== undefined ? { businessMode: value.execution.businessMode as BusinessMode } : {}),
          ...(value.execution.taskMode !== undefined ? { taskMode: value.execution.taskMode as TaskSelection } : {}),
          ...(value.execution.agentModels !== undefined ? { agentModels: parseAgentModels(value.execution.agentModels) } : {}),
          ...(value.execution.agentPermissions !== undefined ? { agentPermissions: parseAgentPermissions(value.execution.agentPermissions) } : {}),
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
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name || value.name.length > 255 ||
    typeof value.kind !== "string" ||
    !attachmentKinds.has(value.kind as AttachmentKind)
  ) {
    return undefined;
  }

  if (
    (value.uri !== undefined && (typeof value.uri !== "string" || value.uri.length > 8192 || /[\u0000-\u001f]/.test(value.uri))) ||
    (value.previewUri !== undefined && (typeof value.previewUri !== "string" || value.previewUri.length > 8192)) ||
    (value.mediaType !== undefined && (typeof value.mediaType !== "string" || value.mediaType.length > 100)) ||
    (value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0))
  ) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    kind: value.kind as AttachmentKind,
    ...(typeof value.uri === "string" ? { uri: value.uri } : {}),
    ...(typeof value.previewUri === "string" ? { previewUri: value.previewUri } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
