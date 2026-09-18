/** Model overrides for agents delegated by Main; Main retains its own model fields. */
export interface AgentModelSetting {
  readonly model?: string;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
}
export type AgentModels = Partial<Record<"work" | "verification", AgentModelSetting>>;

export function parseAgentModels(value: unknown): AgentModels | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: AgentModels = {};
  for (const [role, setting] of Object.entries(value)) {
    if (role !== "work" && role !== "verification") return undefined;
    if (typeof setting !== "object" || setting === null || Array.isArray(setting)) return undefined;
    const fields = setting as Record<string, unknown>;
    if (Object.keys(fields).some(key => key !== "model" && key !== "reasoningEffort")) return undefined;
    if (fields.model !== undefined && (typeof fields.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(fields.model))) return undefined;
    if (fields.reasoningEffort !== undefined && (typeof fields.reasoningEffort !== "string" || !["none", "low", "medium", "high", "xhigh", "max"].includes(fields.reasoningEffort))) return undefined;
    result[role] = { ...(fields.model ? { model: fields.model as string } : {}), ...(fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort as AgentModelSetting["reasoningEffort"] } : {}) };
  }
  return result;
}
