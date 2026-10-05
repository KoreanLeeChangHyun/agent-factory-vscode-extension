import { parseAgentFastModes, parseModelFastModes, type AgentFastModes, type AgentModelSetting, type ModelFastModes } from "../../common/types/agent-models";
// workLight is the optional light Work profile Main uses for bounded, already-decided changes.
export const AGENT_ROLES = ["main", "work", "workLight", "verification"] as const;
/** Roles every complete settings set and preset must contain; older sets omit workLight. */
export const REQUIRED_AGENT_ROLES = ["main", "work", "verification"] as const;
export const AGENT_FIELDS = ["model", "reasoningEffort", "fast"] as const;
export interface AgentDefaults extends Partial<Record<typeof AGENT_ROLES[number], AgentModelSetting>> {
  /** Current role-scoped model preferences. */
  fastByRoleModel?: AgentFastModes;
  /** Legacy model-wide preferences, read only for compatibility. */
  fastByModel?: ModelFastModes;
}
export type AgentPresetScope = "global" | "project" | "chat";
export interface AgentPreset {
  id?: string;
  inUse?: boolean;
  scope: AgentPresetScope;
  name: string;
  settings: AgentDefaults;
  isDefault?: boolean;
}
export interface AgentDefaultsSnapshot {
  defaultSetId?: string;
  presets?: AgentPreset[];
  global: AgentDefaults;
  project: AgentDefaults;
  projectAvailable: boolean;
}
export function validAgentValue(field: string, value: unknown): value is string | boolean {
  if (field === "fast") return typeof value === "boolean";
  return typeof value === "string" && (field === "model"
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value)
    : field === "reasoningEffort" && ["none", "low", "medium", "high", "xhigh", "max"].includes(value));
}
export function mergeAgentSettings(...layers: AgentDefaults[]): AgentDefaults {
  const result: AgentDefaults = {};
  const fastByRoleModel: Record<string, Record<string, boolean>> = {};
  for (const layer of layers) {
    const explicit = parseAgentFastModes(layer.fastByRoleModel);
    if (explicit) for (const role of AGENT_ROLES) {
      if (explicit[role]) Object.assign(fastByRoleModel[role] ??= {}, explicit[role]);
    }
    const legacy = parseModelFastModes(layer.fastByModel);
    if (legacy) for (const role of AGENT_ROLES) {
      const roleModes = fastByRoleModel[role] ??= {};
      for (const [model, enabled] of Object.entries(legacy)) if (roleModes[model] === undefined) roleModes[model] = enabled;
    }
    for (const role of AGENT_ROLES) {
      const setting = layer[role];
      if (setting?.model && typeof setting.fast === "boolean") {
        const roleModes = fastByRoleModel[role] ??= {};
        if (roleModes[setting.model] === undefined) roleModes[setting.model] = setting.fast;
      }
    }
  }
  for (const role of AGENT_ROLES) {
    const setting: { model?: string; reasoningEffort?: AgentModelSetting["reasoningEffort"]; fast?: boolean } = {};
    for (const layer of layers) for (const field of AGENT_FIELDS) {
      const value = layer[role]?.[field];
      if (!validAgentValue(field, value)) continue;
      if (field === "model") setting.model = value as string;
      else if (field === "reasoningEffort") setting.reasoningEffort = value as AgentModelSetting["reasoningEffort"];
      else setting.fast = value as boolean;
    }
    result[role] = setting;
  }
  const populatedFast = Object.fromEntries(Object.entries(fastByRoleModel).filter(([, modes]) => Object.keys(modes).length));
  if (Object.keys(populatedFast).length) result.fastByRoleModel = populatedFast;
  return result;
}
