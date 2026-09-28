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

interface AgentPreset { name: string; settings: AgentDefaults; isDefault?: boolean }
const presetKey = "agentFactory.agentPresets.v1";
const presetOperations = new WeakMap<object, Promise<void>>();

async function seedAgentPreset(state: Pick<vscode.Memento, "get" | "update">): Promise<void> {
  const presets = state.get<AgentPreset[]>(presetKey, []);
  if (state.get<boolean>(presetKey + ".initialized", false)) return;
  if (presets.some(preset => preset.isDefault)) { await state.update(presetKey + ".initialized", true); return; }
  const existing = presets.find(preset => preset.name === "Default");
  await state.update(presetKey, existing
    ? presets.map(preset => preset === existing ? {...preset, isDefault: true} : preset)
    : [{name: "Default", isDefault: true, settings: readAgentDefaults().global}, ...presets]);
  await state.update(presetKey + ".initialized", true);
}

export function ensureAgentPresets(state: Pick<vscode.Memento, "get" | "update">): Promise<void> {
  const operation = (presetOperations.get(state) ?? Promise.resolve()).catch(() => undefined).then(() => seedAgentPreset(state));
  presetOperations.set(state, operation);
  return operation;
}

/** Serialize preset updates across panels sharing this extension host. */
export function useAgentPreset(state: Pick<vscode.Memento, "get" | "update">, action: "save" | "apply" | "update" | "delete", scope: "global" | "project" | "chat", name: string, chatSettings?: AgentDefaults): Promise<void> {
  const previous = presetOperations.get(state) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await seedAgentPreset(state);
    const presets = state.get<AgentPreset[]>(presetKey, []);
    name = name.trim();
    if (!name) throw new Error(localize("preset.name.required"));
    if (action === "delete") {
      if (!presets.some(preset => preset.name === name)) throw new Error(localize("preset.missing"));
      await state.update(presetKey, presets.filter(preset => preset.name !== name));
      return;
    }
    if (scope === "project" && !vscode.workspace.workspaceFolders?.length) throw new Error("Open a project before changing project settings");
    if (action === "save" || action === "update") {
      if (action === "save" && presets.some(preset => preset.name === name)) throw new Error(localize("preset.duplicate"));
      if (action === "update" && !presets.some(preset => preset.name === name)) throw new Error(localize("preset.missing"));
      const replacement = {name, settings: scope === "chat" ? mergeAgentSettings(chatSettings ?? {}) : readAgentDefaults()[scope]};
      await state.update(presetKey, action === "save" ? [...presets, replacement] : presets.map(preset => preset.name === name ? {...preset, ...replacement} : preset));
      return;
    }
    if (scope === "chat") throw new Error("Chat sets must be applied through composer settings");
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

/** Patch only the edited field; serialize with save/delete to preserve concurrent edits. */
export function updateAgentPresetField(state: Pick<vscode.Memento, "get" | "update">, name: string, role: typeof AGENT_ROLES[number], field: typeof AGENT_FIELDS[number], value: string): Promise<void> {
  const operation = (presetOperations.get(state) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!AGENT_ROLES.includes(role) || !AGENT_FIELDS.includes(field) || !validAgentValue(field, value)) throw new Error(localize("preset.invalid"));
    const presets = state.get<AgentPreset[]>(presetKey, []);
    const preset = presets.find(item => item.name === name);
    if (!preset) throw new Error(localize("preset.missing"));
    const fields = {...preset.settings[role]};
    if (!value) delete fields[field];
    else if (field === "model") fields.model = value;
    else fields.reasoningEffort = value as NonNullable<typeof fields.reasoningEffort>;
    const replacement = {...preset, settings: {...preset.settings, [role]: fields}};
    await state.update(presetKey, presets.map(item => item === preset ? replacement : item));
  });
  presetOperations.set(state, operation);
  return operation;
}
