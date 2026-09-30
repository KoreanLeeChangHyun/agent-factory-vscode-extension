import type { AgentModelSetting } from "../../common/types/agent-models";
// workLight is the optional light Work profile Main uses for bounded, already-decided changes.
export const AGENT_ROLES = ["main", "work", "workLight", "verification"] as const;
/** Roles every complete settings set and preset must contain; older sets omit workLight. */
export const REQUIRED_AGENT_ROLES = ["main", "work", "verification"] as const;
export const AGENT_FIELDS = ["model", "reasoningEffort"] as const;
export type AgentDefaults = Partial<Record<typeof AGENT_ROLES[number], AgentModelSetting>>;
export type AgentPresetScope = "global" | "project" | "chat";
export interface AgentPreset {
  scope: AgentPresetScope;
  name: string;
  settings: AgentDefaults;
  isDefault?: boolean;
}
export interface AgentDefaultsSnapshot {
  presets?: AgentPreset[];
  global: AgentDefaults;
  project: AgentDefaults;
  projectAvailable: boolean;
}
export function validAgentValue(field: string, value: unknown): value is string {
  return typeof value === "string" && (field === "model"
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value)
    : field === "reasoningEffort" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value));
}
export function mergeAgentSettings(...layers: AgentDefaults[]): AgentDefaults {
  const result: AgentDefaults = {};
  for (const role of AGENT_ROLES) {
    const setting: Record<string, string> = {};
    for (const layer of layers) for (const field of AGENT_FIELDS) {
      const value = layer[role]?.[field];
      if (value && validAgentValue(field, value)) setting[field] = value;
    }
    result[role] = setting;
  }
  return result;
}
