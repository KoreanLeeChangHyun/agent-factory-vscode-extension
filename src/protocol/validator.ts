import { STATUS_ITEM_IDS, type StatusItemId } from "../core/config/types";
import type { AttachmentKind, AttachmentReference } from "../common/types/attachment";
import type { ClientMessage } from "./messages";

const clientMessageTypes = new Set([
  "client.ready",
  "chat.send",
  "run.cancel",
  "resume.request",
  "attachments.pick",
  "settings.open",
  "status.reorder"
]);
const attachmentKinds = new Set<AttachmentKind>(["file", "folder", "image"]);
const statusItemIds = new Set<string>(STATUS_ITEM_IDS);

export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !clientMessageTypes.has(value.type)) {
    return undefined;
  }

  switch (value.type) {
    case "client.ready":
    case "run.cancel":
    case "resume.request":
    case "attachments.pick":
    case "settings.open":
      return { type: value.type };
    case "chat.send": {
      if (
        typeof value.id !== "string" ||
        !value.id ||
        typeof value.text !== "string" ||
        value.text.length > 100_000 ||
        !Array.isArray(value.attachments) ||
        !isRecord(value.execution) ||
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
          fast: value.execution.fast,
          goal: value.execution.goal
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
