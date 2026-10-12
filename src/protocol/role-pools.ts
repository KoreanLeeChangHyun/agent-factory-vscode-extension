/** Control-center-only messages; the shared chat protocol remains owned by the chat Work. */
export interface RolePoolMessage {
  readonly type: "role.pool.control";
  readonly action: "hire-role" | "configure-area" | "accept-area-task" | "create-child";
  readonly name?: string;
  readonly expectedRevision?: number;
  readonly text?: string;
  readonly chatId: string;
  readonly commandId?: string;
  readonly areaId?: string;
  readonly area?: { readonly domainId: string; readonly subdomainId: string };
  readonly profile?: "workLight" | "work" | "verification";
  readonly route?: "work" | "work-verification";
}
export function parseRolePoolMessage(value: unknown): RolePoolMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const id = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 200;
  if (v.type !== "role.pool.control" || !id(v.chatId) || (v.commandId !== undefined && !id(v.commandId))) return;
  if (v.action === "create-child" && id(v.areaId) && typeof v.name === "string" && v.name.trim() && Number.isInteger(v.expectedRevision)) return { type: v.type, action: v.action, chatId: v.chatId, areaId: v.areaId, name: v.name, expectedRevision: v.expectedRevision as number, ...(v.commandId ? { commandId: v.commandId as string } : {}) };
  if (v.action === "configure-area" && id(v.areaId) && (v.route === "work" || v.route === "work-verification")) {
    return { type: v.type, action: v.action, chatId: v.chatId, ...(v.commandId ? { commandId: v.commandId as string } : {}), areaId: v.areaId, route: v.route };
  }
  if (!["hire-role", "accept-area-task"].includes(String(v.action)) || !["work", "workLight", "verification"].includes(String(v.profile)) || !v.area || typeof v.area !== "object") return;
  const area = v.area as Record<string, unknown>;
  if (!id(area.domainId) || !id(area.subdomainId)) return;
  if (v.action === "accept-area-task") {
    if (typeof v.text !== "string" || !v.text.trim() || v.profile === "verification" || (v.route !== undefined && v.route !== "work" && v.route !== "work-verification")) return;
    return { type: "role.pool.control", action: v.action, chatId: v.chatId, ...(v.commandId ? { commandId: v.commandId as string } : {}), area: { domainId: area.domainId, subdomainId: area.subdomainId }, text: v.text, profile: v.profile as RolePoolMessage["profile"], route: v.route as RolePoolMessage["route"] };
  }
  return { type: "role.pool.control", action: "hire-role", chatId: v.chatId, ...(v.commandId ? { commandId: v.commandId as string } : {}), profile: v.profile as RolePoolMessage["profile"], area: { domainId: area.domainId, subdomainId: area.subdomainId } };
}
