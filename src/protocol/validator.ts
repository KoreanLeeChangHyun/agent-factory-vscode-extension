import { isBotModel } from "../modules/chat/bot-model";
import { COMPANION_ACTIONS, type CompanionAction } from "../modules/chat/companion";
import { validNoteFolder } from "../infrastructure/vscode/note-store";
import { AGENT_ROLES, validAgentValue } from "../core/config/agent-settings";
import { parseAgentPermissions } from "../common/types/agent-permissions";
import { parseAgentFastModes, parseAgentModels, parseModelFastModes } from "../common/types/agent-models";
import { BUSINESS_MODES, type BusinessMode } from "../common/types/business-mode";
export { parseInterviewQuestion } from "../common/types/business-mode";
import { TASK_SELECTIONS, type TaskSelection } from "../modules/chat/task-selection";
import { STATUS_ITEM_IDS, type StatusItemId } from "../core/config/types";
import type { AttachmentKind, AttachmentReference } from "../common/types/attachment";
import type { ClientMessage } from "./messages";
import { PROVIDER_IDS, PLUGIN_UPDATE_MODES, type ProviderId, type PluginUpdateMode } from "../common/types/provider";

const clientMessageTypes = new Set([
  "agent.defaults.save", "agent.defaults.fast", "agent.preset", "agent.preset.field", "agent.preset.fast",
  "client.ready",
  "worktree.create", "worktree.merge", "worktree.refresh", "worktree.repositories",
  "deploy.detect", "deploy.run", "deploy.token",
  "notes.list", "notes.folder",
  "notes.save",
  "bots.configure", "bot.interact",
  "bot.talk",
  "bot.prompt.save",
  "bot.model.save",
  "bot.character.save",
  "execution.select",
  "reference.copy",
  "message.copy",
  "link.open",
  "image.resolve",
  "chat.send",
  "chat.status",
  "decision.approve",
  "sudo.reply",
  "run.cancel",
  "queue.resume",
  "conversation.clear",
  "goal.control",
  "sessions.request",
  "models.request",
  "usage.refresh",
  "providers.request",
  "providers.detect",
  "providers.configure",
  "providers.pick",
  "providers.update",
  "providers.cli.install",
  "providers.versions.request",
  "providers.updateMode.select",
  "session.select",
  "agents.request",
  "history.request",
  "contract.open",
  "contracts.request",
  "project.tasks.request",
  "conversations.request",
  "conversation.read",
  "task.stop",
  "workflow.close",
  "workflow.decision",
  "workflow.answer",
  "agent.open",
  "attachments.pick",
  "attachments.addUris",
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
  "workIsolation.set",
  "docsAudit.set",
  "docsAudit.started",
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
      if (![value.repository, value.name, value.base].every(v => typeof v === "string")) return undefined;
      if (![value.repository, value.name, value.base].every(v => (v as string).trim())) return undefined;
      return { type: value.type, repository: value.repository as string, name: value.name as string, base: value.base as string };
    case "deploy.detect":
      return { type: value.type };
    case "deploy.token":
      return typeof value.secret === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value.secret) ? { type: value.type, secret: value.secret } : undefined;
    case "deploy.run": {
      if (!Number.isSafeInteger(value.workflowId) || (value.workflowId as number) <= 0 || !isRecord(value.inputs)) return undefined;
      const entries = Object.entries(value.inputs);
      if (entries.length > 25 || !entries.every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key) &&
        (typeof item === "boolean" || (typeof item === "string" && item.length <= 1000)))) return undefined;
      return { type: value.type, workflowId: value.workflowId as number, inputs: Object.fromEntries(entries) as Record<string, string | boolean> };
    }
    case "worktree.repositories":
    case "worktree.merge":
    case "worktree.refresh":
      return { type: value.type };
    case "providers.configure":
      if (!PROVIDER_IDS.includes(value.provider as ProviderId) || typeof value.path !== "string"
          || value.path.length > 4096 || /[\u0000-\u001f]/.test(value.path)) return undefined;
      return { type: value.type, provider: value.provider as ProviderId, path: value.path };
    case "providers.pick":
      return PROVIDER_IDS.includes(value.provider as ProviderId)
        ? { type: value.type, provider: value.provider as ProviderId } : undefined;
    case "providers.updateMode.select":
      if (!PLUGIN_UPDATE_MODES.includes(value.mode as PluginUpdateMode)) return undefined;
      return { type: value.type, mode: value.mode as PluginUpdateMode };
    case "bot.interact":
      return COMPANION_ACTIONS.includes(value.action as CompanionAction) ? { type: value.type, action: value.action as CompanionAction } : undefined;
    case "bots.configure":
      return typeof value.enabled === "boolean" ? { type: value.type, enabled: value.enabled } : undefined;
    case "bot.character.save":
      return value.character === "lumi" || value.character === "factory" ? { type: value.type, character: value.character } : undefined;
    case "bot.model.save":
      return isBotModel(value.model) ? { type: value.type, model: value.model } : undefined;
    case "bot.prompt.save":
      return typeof value.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId) && typeof value.prompt === "string" && (value.character === undefined || value.character === "lumi" || value.character === "factory")
        ? { type: value.type, requestId: value.requestId, prompt: value.prompt, character: value.character as "lumi" | "factory" | undefined } : undefined;
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
      if (value.language !== undefined && value.language !== "ko" && value.language !== "en") return undefined;
      return { type: value.type, runId: value.runId, ...(value.language ? { language: value.language } : {}) };
    case "workIsolation.set":
      return typeof value.value === "boolean" ? { type: "workIsolation.set", value: value.value } : undefined;
    case "docsAudit.set":
      return value.interval === "off" || value.interval === "daily" || value.interval === "weekly" ? { type: "docsAudit.set", interval: value.interval } : undefined;
    case "docsAudit.started":
      return { type: "docsAudit.started" };
    case "goal.control":
      if (typeof value.action !== "string" || !["get", "refresh", "pause", "cancel", "disable", "reopen"].includes(value.action)) return undefined;
      return { type: "goal.control", action: value.action as import("../common/types/agent-runtime").GoalAction };
    case "execution.select":
      if (typeof value.mode !== "string" || !["cli-default", "workspace-write", "danger-full-access", "bypass"].includes(value.mode)) return undefined;
      return { type: value.type, mode: value.mode as import("../common/types/agent-runtime").ExecutionMode };
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
    case "notes.folder":
      return (value.scope === "global" || value.scope === "workspace") && validNoteFolder(value.folder) && value.folder ? { type: value.type, scope: value.scope, folder: value.folder } : undefined;
    case "notes.list":
      if (value.scope !== "global" && value.scope !== "workspace") return undefined;
      return { type: value.type, scope: value.scope };
    case "notes.save": {
      if (value.scope !== "global" && value.scope !== "workspace") return undefined;
      const note = value.note as Record<string, unknown> | undefined;
      if (!note || typeof note.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(note.id) || typeof note.title !== "string" || typeof note.body !== "string" || !Number.isSafeInteger(note.revision) || Number(note.revision) < 0) return undefined;
      if (!validNoteFolder(note.folder ?? "")) return undefined;
      return { type: value.type, scope: value.scope, note: { folder: (note.folder as string) || "", id: note.id, title: note.title, body: note.body, revision: Number(note.revision) } };
    }
    case "agent.preset.field":
      if ((value.scope !== "global" && value.scope !== "project" && value.scope !== "chat") || typeof value.name !== "string" || !value.name.trim() || !AGENT_ROLES.includes(value.role as typeof AGENT_ROLES[number]) || !["model", "reasoningEffort", "fast"].includes(String(value.field)) || !validAgentValue(String(value.field), value.value)) return undefined;
      return {type: value.type, scope: value.scope, name: value.name.trim(), role: value.role as typeof AGENT_ROLES[number], field: value.field as "model" | "reasoningEffort" | "fast", value: value.value as string | boolean};
    case "agent.preset.fast":
      if ((value.scope !== "global" && value.scope !== "project" && value.scope !== "chat") || typeof value.name !== "string" || !value.name.trim() || !AGENT_ROLES.includes(value.role as typeof AGENT_ROLES[number]) || !validAgentValue("model", value.model) || typeof value.value !== "boolean") return undefined;
      return {type: value.type, scope: value.scope, name: value.name.trim(), role: value.role as typeof AGENT_ROLES[number], model: value.model as string, value: value.value};
    case "agent.preset":
      if ((value.action !== "save" && value.action !== "apply" && value.action !== "copy" && value.action !== "update" && value.action !== "delete" && value.action !== "rename" && value.action !== "default") || (value.scope !== "global" && value.scope !== "project" && value.scope !== "chat") || typeof value.name !== "string" || !value.name.trim() || (value.action === "rename" && (typeof value.newName !== "string" || !value.newName.trim()))) return undefined;
      return {type: value.type, action: value.action, scope: value.scope, name: value.name.trim(), ...(value.action === "rename" ? {newName: (value.newName as string).trim()} : {}), ...(value.action === "save" && typeof value.sourceName === "string" ? {sourceName: value.sourceName.trim()} : {})};
    case "agent.defaults.save":
      if ((value.scope !== "global" && value.scope !== "project") ||
          !AGENT_ROLES.includes(value.role as typeof AGENT_ROLES[number]) ||
          (value.field !== "model" && value.field !== "reasoningEffort" && value.field !== "fast") || !validAgentValue(value.field, value.value)) return undefined;
      return { type: value.type, scope: value.scope, role: value.role as typeof AGENT_ROLES[number], field: value.field, value: value.value };
    case "agent.defaults.fast":
      if ((value.scope !== "global" && value.scope !== "project") || !AGENT_ROLES.includes(value.role as typeof AGENT_ROLES[number]) || !validAgentValue("model", value.model) || typeof value.value !== "boolean") return undefined;
      return { type: value.type, scope: value.scope, role: value.role as typeof AGENT_ROLES[number], model: value.model as string, value: value.value };
    case "chat.status":
      if (!Array.isArray(value.ids) || !value.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)) return undefined;
      return { type: value.type, ids: value.ids as string[] };
    case "client.ready":
      if (value.pendingMessageIds !== undefined && (!Array.isArray(value.pendingMessageIds) || !value.pendingMessageIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 128))) return undefined;
      return { type: value.type, ...(value.pendingMessageIds ? { pendingMessageIds: value.pendingMessageIds as string[] } : {}) };
    case "queue.resume":
    case "run.cancel":
    case "conversation.clear":
    case "contracts.request":
    case "project.tasks.request":
    case "conversations.request":
    case "sessions.request":
    case "models.request":
    case "usage.refresh":
    case "providers.request":
    case "providers.detect":
    case "providers.versions.request":
    case "agents.request":
    case "attachments.pick":
      return { type: value.type };
    case "attachments.addUris":
      if (!Array.isArray(value.uris) || value.uris.length < 1 || value.uris.length > 100 ||
          !value.uris.every(uri => typeof uri === "string" && uri.length <= 4096 && !/[\u0000-\u001f]/.test(uri))) return undefined;
      return { type: value.type, uris: value.uris as string[] };
    case "providers.update":
      if (value.provider !== undefined) return undefined;
      if (value.version === undefined) return { type: value.type };
      return typeof value.version === "string" && value.version.length <= 128
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)
        ? { type: value.type, version: value.version } : undefined;
    case "providers.cli.install":
      return (value.provider === "codex" || value.provider === "claude")
        && typeof value.version === "string" && value.version.length <= 128
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
        ? { type: value.type, provider: value.provider, version: value.version } : undefined;
    case "conversation.read": {
      const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
      if ((value.conversationId !== null && !id(value.conversationId)) || !id(value.requestId) || (value.before !== undefined && !id(value.before))) return undefined;
      return { type: value.type, conversationId: value.conversationId as string | null, requestId: value.requestId, ...(value.before ? { before: value.before as string } : {}) };
    }
    case "history.request":
      if (typeof value.before !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.before)) return undefined;
      return { type: value.type, before: value.before };
    case "task.stop": {
      const valid = (id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
      if (!valid(value.workflowId) || !valid(value.taskId)) return undefined;
      const loop = value.loopId !== undefined || value.workAgentId !== undefined;
      if (loop ? !valid(value.loopId) || !valid(value.workAgentId) || value.agentId !== undefined || value.runId !== undefined
        : !valid(value.agentId) || !valid(value.runId)) return undefined;
      return { type: value.type, workflowId: value.workflowId as string, taskId: value.taskId as string,
        ...(loop ? { loopId: value.loopId as string, workAgentId: value.workAgentId as string }
          : { agentId: value.agentId as string, runId: value.runId as string }) };
    }
    case "workflow.close":
      if (![value.workAgentId, value.loopId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) return undefined;
      return { type: value.type, workAgentId: value.workAgentId as string, loopId: value.loopId as string };
    case "workflow.answer":
      if (![value.workAgentId, value.loopId, value.decisionId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
        || typeof value.questionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.questionHash)
        || typeof value.answer !== "string" || !value.answer.trim()) return undefined;
      return { type: value.type, workAgentId: value.workAgentId as string, loopId: value.loopId as string,
        decisionId: value.decisionId as string, questionHash: value.questionHash, answer: value.answer };
    case "workflow.decision":
      // Exactly the two revision-limit decisions; accepting failed Verification stays an explicit runtime command.
      if (![value.workAgentId, value.loopId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
        || (value.decision !== "continue" && value.decision !== "stop")) return undefined;
      return { type: value.type, workAgentId: value.workAgentId as string, loopId: value.loopId as string, decision: value.decision };
    case "session.select":
    case "agent.open":
      if (typeof value.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.agentId)) {
        return undefined;
      }
      if (value.type === "agent.open" && value.runId !== undefined &&
        (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId))) return undefined;
      return { type: value.type, agentId: value.agentId,
        ...(value.type === "agent.open" && typeof value.runId === "string" ? { runId: value.runId } : {}) };
    case "composer.settings":
      if (
        (value.businessMode !== undefined && !BUSINESS_MODES.includes(value.businessMode as BusinessMode)) ||
        (value.taskMode !== undefined && !TASK_SELECTIONS.includes(value.taskMode as TaskSelection)) ||
        (value.agentModels !== undefined && !parseAgentModels(value.agentModels)) ||
        (value.modelFastModes !== undefined && !parseModelFastModes(value.modelFastModes)) ||
        (value.agentFastModes !== undefined && !parseAgentFastModes(value.agentFastModes)) ||
        (value.agentPermissions !== undefined && !parseAgentPermissions(value.agentPermissions)) ||
        (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 100)) ||
        (value.reasoning !== undefined && (typeof value.reasoning !== "string" || !reasoningEfforts.has(value.reasoning))) ||
        (value.agentSettingsScope !== undefined && value.agentSettingsScope !== "global" && value.agentSettingsScope !== "project" && value.agentSettingsScope !== "chat") ||
        (value.agentSettingsSet !== undefined && (typeof value.agentSettingsSet !== "string" || !value.agentSettingsSet.trim())) ||
        typeof value.fastMode !== "boolean" ||
        (value.workLoopMode !== undefined && typeof value.workLoopMode !== "boolean") ||
        typeof value.goalMode !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: value.type,
        ...(value.agentModels !== undefined ? { agentModels: parseAgentModels(value.agentModels) } : {}),
        ...(value.modelFastModes !== undefined ? { modelFastModes: parseModelFastModes(value.modelFastModes) } : {}),
        ...(value.agentFastModes !== undefined ? { agentFastModes: parseAgentFastModes(value.agentFastModes) } : {}),
        ...(value.agentPermissions !== undefined ? { agentPermissions: parseAgentPermissions(value.agentPermissions) } : {}),
        ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
        ...(typeof value.reasoning === "string"
          ? { reasoning: value.reasoning as "none" | "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(value.businessMode !== undefined ? { businessMode: value.businessMode as BusinessMode } : {}),
        ...(value.taskMode !== undefined ? { taskMode: value.taskMode as TaskSelection } : {}),
        ...(value.agentSettingsScope !== undefined ? { agentSettingsScope: value.agentSettingsScope as "global" | "project" | "chat" } : {}),
        ...(typeof value.agentSettingsSet === "string" ? { agentSettingsSet: value.agentSettingsSet.trim() } : {}),
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
        (value.execution.workIsolation !== undefined && typeof value.execution.workIsolation !== "boolean") ||
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
          ...(typeof value.execution.workIsolation === "boolean" ? { workIsolation: value.execution.workIsolation } : {}),
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
  return undefined;
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
