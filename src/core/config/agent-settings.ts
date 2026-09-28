import type { AgentModelSetting } from "../../common/types/agent-models";
export const AGENT_ROLES = ["main", "work", "verification"] as const;
export const AGENT_FIELDS = ["model", "reasoningEffort"] as const;
export type AgentDefaults = Partial<Record<typeof AGENT_ROLES[number], AgentModelSetting>>;
export interface AgentDefaultsSnapshot {
  presets?: { name: string; settings: AgentDefaults; isDefault?: boolean }[];
  global: AgentDefaults;
  project: AgentDefaults;
  effective: AgentDefaults;
  sources: Partial<Record<typeof AGENT_ROLES[number], Partial<Record<typeof AGENT_FIELDS[number], "global" | "project" | "product">>>>;
  projectAvailable: boolean;
}
export function validAgentValue(field: string, value: unknown): value is string {
  return typeof value === "string" && (value === "" || (field === "model"
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value)
    : field === "reasoningEffort" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value)));
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
