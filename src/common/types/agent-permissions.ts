/** Optional role overrides; omitted roles inherit the common permission selection. */
export type PermissionMode = "cli-default" | "workspace-write" | "danger-full-access" | "bypass";
export type AgentPermissions = Partial<Record<"main" | "work" | "verification", PermissionMode>>;
export function parseAgentPermissions(value: unknown): AgentPermissions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: AgentPermissions = {};
  for (const [role, mode] of Object.entries(value)) {
    if (!["main", "work", "verification"].includes(role) || typeof mode !== "string" || !["cli-default", "workspace-write", "danger-full-access", "bypass"].includes(mode)) return undefined;
    result[role as keyof AgentPermissions] = mode as PermissionMode;
  }
  return result;
}
