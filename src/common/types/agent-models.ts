/** Model overrides for agents delegated by Main; Main retains its own model fields. */
export interface AgentModelSetting {
  readonly model?: string;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Codex service tier. Independent from reasoning effort; omitted for non-Codex routes. */
  readonly fast?: boolean;
}
/** Delegated roles with their own model settings; explore and scribe fall back to workLight. */
export const DELEGATED_MODEL_ROLES = ["work", "workLight", "verification", "explore", "scribe"] as const;
export type AgentModels = Partial<Record<typeof DELEGATED_MODEL_ROLES[number], AgentModelSetting>>;
export type ModelFastModes = Readonly<Record<string, boolean>>;
export type AgentFastModes = Partial<Record<"main" | typeof DELEGATED_MODEL_ROLES[number], ModelFastModes>>;
/** Work profile Main recorded at dispatch: `work` is Expert, `workLight` Worker, `explore` Explorer and `scribe` Scribe. */
export type WorkProfile = "work" | "workLight" | "explore" | "scribe";

export function parseWorkProfile(value: unknown): WorkProfile | undefined {
  return value === "work" || value === "workLight" || value === "explore" || value === "scribe" ? value : undefined;
}

export function parseAgentModels(value: unknown): AgentModels | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: AgentModels = {};
  for (const [role, setting] of Object.entries(value)) {
    if (!(DELEGATED_MODEL_ROLES as readonly string[]).includes(role)) return undefined;
    if (typeof setting !== "object" || setting === null || Array.isArray(setting)) return undefined;
    const fields = setting as Record<string, unknown>;
    if (Object.keys(fields).some(key => key !== "model" && key !== "reasoningEffort" && key !== "fast")) return undefined;
    if (fields.model !== undefined && (typeof fields.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(fields.model))) return undefined;
    if (fields.reasoningEffort !== undefined && (typeof fields.reasoningEffort !== "string" || !["none", "low", "medium", "high", "xhigh", "max"].includes(fields.reasoningEffort))) return undefined;
    if (fields.fast !== undefined && typeof fields.fast !== "boolean") return undefined;
    result[role as keyof AgentModels] = { ...(fields.model ? { model: fields.model as string } : {}), ...(fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort as AgentModelSetting["reasoningEffort"] } : {}), ...(typeof fields.fast === "boolean" ? { fast: fields.fast } : {}) };
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
    if (role !== "main" && !(DELEGATED_MODEL_ROLES as readonly string[]).includes(role)) return undefined;
    const parsed = parseModelFastModes(modes);
    if (!parsed) return undefined;
    result[role as keyof AgentFastModes] = parsed;
  }
  return result;
}
