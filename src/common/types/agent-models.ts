/** Model overrides for agents delegated by Main; Main retains its own model fields. */
export interface AgentModelSetting {
  readonly model?: string;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Codex service tier. Independent from reasoning effort; omitted for non-Codex routes. */
  readonly fast?: boolean;
}
export type AgentModels = Partial<Record<"work" | "workLight" | "verification", AgentModelSetting>>;
export type ModelFastModes = Readonly<Record<string, boolean>>;
export type AgentFastModes = Partial<Record<"main" | "work" | "workLight" | "verification", ModelFastModes>>;
/** Work profile Main recorded at dispatch: `work` is Expert, `workLight` is Worker. */
export type WorkProfile = "work" | "workLight";

export function parseWorkProfile(value: unknown): WorkProfile | undefined {
  return value === "work" || value === "workLight" ? value : undefined;
}

export function parseAgentModels(value: unknown): AgentModels | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: AgentModels = {};
  for (const [role, setting] of Object.entries(value)) {
    if (role !== "work" && role !== "workLight" && role !== "verification") return undefined;
    if (typeof setting !== "object" || setting === null || Array.isArray(setting)) return undefined;
    const fields = setting as Record<string, unknown>;
    if (Object.keys(fields).some(key => key !== "model" && key !== "reasoningEffort" && key !== "fast")) return undefined;
    if (fields.model !== undefined && (typeof fields.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(fields.model))) return undefined;
    if (fields.reasoningEffort !== undefined && (typeof fields.reasoningEffort !== "string" || !["none", "low", "medium", "high", "xhigh", "max"].includes(fields.reasoningEffort))) return undefined;
    if (fields.fast !== undefined && typeof fields.fast !== "boolean") return undefined;
    result[role] = { ...(fields.model ? { model: fields.model as string } : {}), ...(fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort as AgentModelSetting["reasoningEffort"] } : {}), ...(typeof fields.fast === "boolean" ? { fast: fields.fast } : {}) };
  }
  return result;
}

export function parseModelFastModes(value: unknown): ModelFastModes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [model, enabled] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model) || typeof enabled !== "boolean") return undefined;
    result[model] = enabled;
  }
  return result;
}

export function parseAgentFastModes(value: unknown): AgentFastModes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: AgentFastModes = {};
  for (const [role, modes] of Object.entries(value)) {
    if (role !== "main" && role !== "work" && role !== "workLight" && role !== "verification") return undefined;
    const parsed = parseModelFastModes(modes);
    if (!parsed) return undefined;
    result[role] = parsed;
  }
  return result;
}
