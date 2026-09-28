import * as vscode from "vscode";
import { localize } from "../../common/localization";
import { AGENT_ROLES, AGENT_FIELDS, mergeAgentSettings, type AgentDefaultsSnapshot, type AgentDefaults, validAgentValue } from "../../core/config/agent-settings";
const section = "agentFactory.agents";
const initializationKey = "agentFactory.agentDefaults.initialized.v1";

/** Seed only unset global models; explicit values (including inheritance) remain Human-owned. */
export async function initializeAgentDefaults(
  state: Pick<vscode.Memento, "get" | "update">,
  providers: { codex: boolean; claude: boolean }
): Promise<void> {
  if (state.get<boolean>(initializationKey)) return;
  const model = providers.codex ? "gpt-6-astra" : providers.claude ? "claude-opus-5-5" : undefined;
  if (!model) return;
  const config = vscode.workspace.getConfiguration(section);
  for (const role of AGENT_ROLES) {
    const key = `${role}.model`;
    if (config.inspect<string>(key)?.globalValue === undefined) {
      await config.update(key, model, vscode.ConfigurationTarget.Global);
    }
  }
  await state.update(initializationKey, true);
}

export function readAgentDefaults(state?: Pick<vscode.Memento, "get">): AgentDefaultsSnapshot {
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const config = vscode.workspace.getConfiguration?.(section, uri);
  const global: AgentDefaults = {}, project: AgentDefaults = {};
  const sources: AgentDefaultsSnapshot["sources"] = {};
  for (const role of AGENT_ROLES) {
    const g: Record<string, string> = {}, p: Record<string, string> = {};
    sources[role] = {};
    for (const field of AGENT_FIELDS) {
      const entry = config?.inspect?.<string>(`${role}.${field}`);
      const globalValue = entry?.globalValue;
      const projectValue = entry?.workspaceFolderValue || entry?.workspaceValue;
      if (globalValue && validAgentValue(field, globalValue)) g[field] = globalValue;
      if (projectValue && validAgentValue(field, projectValue)) p[field] = projectValue;
      sources[role]![field] = p[field] ? "project" : g[field] ? "global" : "product";
    }
    global[role] = g; project[role] = p;
  }
  return { presets: state?.get<AgentPreset[]>(presetKey, []) ?? [], global, project, effective: mergeAgentSettings(global, project), sources, projectAvailable: Boolean(uri) };
}
export async function saveAgentDefault(scope: "global" | "project", role: string, field: string, value: string): Promise<void> {
  if (!(AGENT_ROLES as readonly string[]).includes(role) || !(AGENT_FIELDS as readonly string[]).includes(field) || !validAgentValue(field, value)) throw new Error("Invalid agent setting");
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (scope === "project" && !uri) throw new Error("Open a project before changing project settings");
  const config = vscode.workspace.getConfiguration(section, uri);
  await config.update(`${role}.${field}`, value || undefined, scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder);
}

interface AgentPreset { name: string; settings: AgentDefaults }
const presetKey = "agentFactory.agentPresets.v1";
const presetOperations = new WeakMap<object, Promise<void>>();

/** Serialize preset updates across panels sharing this extension host. */
export function useAgentPreset(state: Pick<vscode.Memento, "get" | "update">, action: "save" | "apply", scope: "global" | "project", name: string): Promise<void> {
  const previous = presetOperations.get(state) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const presets = state.get<AgentPreset[]>(presetKey, []);
    if (!name.trim()) throw new Error(localize("preset.name.required"));
    if (scope === "project" && !vscode.workspace.workspaceFolders?.length) throw new Error("Open a project before changing project settings");
    if (action === "save") {
      if (presets.some(preset => preset.name === name)) throw new Error(localize("preset.duplicate"));
      await state.update(presetKey, [...presets, {name, settings: readAgentDefaults()[scope]}]);
      return;
    }
    const preset = presets.find(preset => preset.name === name);
    if (!preset) throw new Error(localize("preset.missing"));
    // Validate the complete stored set before writing any setting.
    for (const role of AGENT_ROLES) for (const field of AGENT_FIELDS) {
      if (!validAgentValue(field, preset.settings[role]?.[field] ?? "")) throw new Error(localize("preset.invalid"));
    }
    const config = vscode.workspace.getConfiguration(section, vscode.workspace.workspaceFolders?.[0]?.uri);
    const target = scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder;
    const before = new Map<string, string | undefined>();
    for (const role of AGENT_ROLES) for (const field of AGENT_FIELDS) {
      const key = `${role}.${field}`;
      const entry = config.inspect<string>(key);
      before.set(key, scope === "global" ? entry?.globalValue : entry?.workspaceFolderValue);
    }
    const changed: [typeof AGENT_ROLES[number], typeof AGENT_FIELDS[number]][] = [];
    try {
      for (const role of AGENT_ROLES) for (const field of AGENT_FIELDS) {
        await saveAgentDefault(scope, role, field, preset.settings[role]?.[field] ?? "");
        changed.push([role, field]);
      }
    } catch (error) {
      // Restore earlier writes if a later configuration write fails.
      const rollback = await Promise.allSettled(changed.map(([role, field]) => config.update(`${role}.${field}`, before.get(`${role}.${field}`), target)));
      if (rollback.some(result => result.status === "rejected")) throw new Error(localize("preset.rollback.failed"));
      throw error;
    }
  });
  presetOperations.set(state, operation);
  return operation;
}
