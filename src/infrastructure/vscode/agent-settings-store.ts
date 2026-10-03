import * as vscode from "vscode";
import { localize } from "../../common/localization";
import { parseModelFastModes } from "../../common/types/agent-models";
import { AGENT_ROLES, AGENT_FIELDS, REQUIRED_AGENT_ROLES, mergeAgentSettings, type AgentDefaultsSnapshot, type AgentDefaults, type AgentPreset, type AgentPresetScope, validAgentValue } from "../../core/config/agent-settings";
const section = "agentFactory.agents";
const globalInitializationKey = "agentFactory.agentDefaults.initialized.v3";
const projectInitializationKey = "agentFactory.projectAgentDefaults.initialized.v2";
const initializedFields = ["model", "reasoningEffort"] as const;

/** Seed a complete global set, then copy it once into a newly opened project. */
export async function initializeAgentDefaults(
  globalState: Pick<vscode.Memento, "get" | "update">,
  providers: { codex: boolean; claude: boolean },
  workspaceState?: Pick<vscode.Memento, "get" | "update">
): Promise<void> {
  const model = providers.codex ? "gpt-6-astra" : providers.claude ? "claude-opus-5-5" : undefined;
  const config = vscode.workspace.getConfiguration(section);
  if (!globalState.get<boolean>(globalInitializationKey)) {
    for (const role of REQUIRED_AGENT_ROLES) {
      for (const field of initializedFields) {
        const key = `${role}.${field}`;
        const value = field === "model" ? model : "medium";
        if (value !== undefined && !validAgentValue(field, config.inspect<unknown>(key)?.globalValue)) {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
        }
      }
    }
    if (model) await globalState.update(globalInitializationKey, true);
  }
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!uri || !workspaceState || workspaceState.get<boolean>(projectInitializationKey)) return;
  const projectConfig = vscode.workspace.getConfiguration(section, uri);
  const global = readAgentDefaults().global;
  if (!REQUIRED_AGENT_ROLES.every(role => ["model", "reasoningEffort"].every(field => validAgentValue(field, global[role]?.[field as "model" | "reasoningEffort"])))) return;
  for (const role of AGENT_ROLES) for (const field of initializedFields) {
    if (!validAgentValue(field, global[role]?.[field])) continue; // Optional roles copy only what is set.
    const key = `${role}.${field}`;
    const entry = projectConfig.inspect<unknown>(key);
    if (!validAgentValue(field, entry?.workspaceFolderValue ?? entry?.workspaceValue)) {
      await projectConfig.update(key, global[role]![field], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
  if (global.fastByModel) await projectConfig.update("fastByModel", global.fastByModel, vscode.ConfigurationTarget.WorkspaceFolder);
  await workspaceState.update(projectInitializationKey, true);
}

export function readAgentDefaults(
  globalState?: Pick<vscode.Memento, "get">,
  workspaceState?: Pick<vscode.Memento, "get">,
  chatId?: string
): AgentDefaultsSnapshot {
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const config = vscode.workspace.getConfiguration?.(section, uri);
  const global: AgentDefaults = {}, project: AgentDefaults = {};
  for (const role of AGENT_ROLES) {
    const g: Record<string, string | boolean> = {}, p: Record<string, string | boolean> = {};
    for (const field of AGENT_FIELDS) {
      const entry = config?.inspect?.<unknown>(`${role}.${field}`);
      const globalValue = entry?.globalValue;
      const projectValue = entry?.workspaceFolderValue ?? entry?.workspaceValue;
      if (validAgentValue(field, globalValue)) g[field] = globalValue;
      if (validAgentValue(field, projectValue)) p[field] = projectValue;
    }
    global[role] = g; project[role] = p;
  }
  const fastEntry = config?.inspect?.<unknown>("fastByModel");
  const globalFast = parseModelFastModes(fastEntry?.globalValue);
  const projectFast = parseModelFastModes(fastEntry?.workspaceFolderValue ?? fastEntry?.workspaceValue);
  if (globalFast) global.fastByModel = globalFast;
  if (projectFast) project.fastByModel = projectFast;
  // Legacy role-scoped values seed one model preference until that scope is next saved.
  for (const settings of [global, project]) {
    const migrated = {...settings.fastByModel};
    for (const role of AGENT_ROLES) {
      const value = settings[role];
      if (value?.model && typeof value.fast === "boolean" && migrated[value.model] === undefined) migrated[value.model] = value.fast;
    }
    if (Object.keys(migrated).length) settings.fastByModel = migrated;
  }
  return { presets: readAgentPresets(globalState, workspaceState, chatId), global, project, projectAvailable: Boolean(uri) };
}
export async function saveAgentDefault(scope: "global" | "project", role: string, field: string, value: string | boolean): Promise<void> {
  if (!(AGENT_ROLES as readonly string[]).includes(role) || !(AGENT_FIELDS as readonly string[]).includes(field) || !validAgentValue(field, value)) throw new Error("Invalid agent setting");
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (scope === "project" && !uri) throw new Error("Open a project before changing project settings");
  const config = vscode.workspace.getConfiguration(section, uri);
  await config.update(`${role}.${field}`, value, scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder);
}

export async function saveModelFastMode(scope: "global" | "project", model: string, value: boolean): Promise<void> {
  if (!validAgentValue("model", model)) throw new Error("Invalid model Fast setting");
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (scope === "project" && !uri) throw new Error("Open a project before changing project settings");
  const config = vscode.workspace.getConfiguration(section, uri);
  const entry = config.inspect<unknown>("fastByModel");
  const current = parseModelFastModes(scope === "global" ? entry?.globalValue : entry?.workspaceFolderValue ?? entry?.workspaceValue) ?? {};
  await config.update("fastByModel", {...current, [model]: value}, scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder);
}

interface StoredAgentPreset { name: string; settings: AgentDefaults; isDefault?: boolean }
type PresetState = Pick<vscode.Memento, "get" | "update">;
const legacyPresetKey = "agentFactory.agentPresets.v1";
const globalPresetKey = "agentFactory.agentPresets.global.v2";
const projectPresetKey = "agentFactory.agentPresets.project.v2";
const chatPresetKey = "agentFactory.agentPresets.chat.v2";
const presetOperations = new WeakMap<object, Promise<void>>();

function scoped(presets: readonly StoredAgentPreset[], scope: AgentPresetScope): AgentPreset[] {
  return presets.map(preset => ({...preset, scope, settings: mergeAgentSettings(preset.settings)}));
}

function chatPresetMap(state?: Pick<vscode.Memento, "get">): Record<string, StoredAgentPreset[]> {
  return state?.get<Record<string, StoredAgentPreset[]>>(chatPresetKey, {}) ?? {};
}

function readAgentPresets(globalState?: Pick<vscode.Memento, "get">, workspaceState?: Pick<vscode.Memento, "get">, chatId?: string): AgentPreset[] {
  return [
    ...scoped(globalState?.get<StoredAgentPreset[]>(globalPresetKey, []) ?? [], "global"),
    ...scoped(workspaceState?.get<StoredAgentPreset[]>(projectPresetKey, []) ?? [], "project"),
    ...scoped(chatId ? chatPresetMap(workspaceState)[chatId] ?? [] : [], "chat")
  ];
}

function defaultPreset(settings: AgentDefaults): StoredAgentPreset {
  return {name: "Default", isDefault: true, settings: mergeAgentSettings(settings)};
}

function migratedPresets(legacy: readonly StoredAgentPreset[], settings: AgentDefaults): StoredAgentPreset[] {
  const custom = legacy.filter(preset => !preset.isDefault && preset.name !== "Default")
    .map(preset => ({name: preset.name, settings: mergeAgentSettings(preset.settings)}));
  return [defaultPreset(settings), ...custom];
}

async function seedAgentPresets(globalState: PresetState, workspaceState?: PresetState, chatId?: string, chatSettings: AgentDefaults = {}): Promise<void> {
  const defaults = readAgentDefaults();
  const legacy = globalState.get<StoredAgentPreset[]>(legacyPresetKey, []);
  if (!globalState.get<boolean>(globalPresetKey + ".initialized", false)) {
    if (!globalState.get<StoredAgentPreset[]>(globalPresetKey)?.length) await globalState.update(globalPresetKey, migratedPresets(legacy, defaults.global));
    await globalState.update(globalPresetKey + ".initialized", true);
  }
  if (workspaceState && !workspaceState.get<boolean>(projectPresetKey + ".initialized", false)) {
    if (!workspaceState.get<StoredAgentPreset[]>(projectPresetKey)?.length) await workspaceState.update(projectPresetKey, migratedPresets(legacy, defaults.project));
    await workspaceState.update(projectPresetKey + ".initialized", true);
  }
  if (workspaceState && chatId) {
    const map = chatPresetMap(workspaceState);
    if (!map[chatId]?.length) await workspaceState.update(chatPresetKey, {...map, [chatId]: migratedPresets(legacy, chatSettings)});
  }
}

export function ensureAgentPresets(globalState: PresetState, workspaceState?: PresetState, chatId?: string, chatSettings?: AgentDefaults): Promise<void> {
  const operation = (presetOperations.get(globalState) ?? Promise.resolve()).catch(() => undefined)
    .then(() => seedAgentPresets(globalState, workspaceState, chatId, chatSettings));
  presetOperations.set(globalState, operation);
  return operation;
}

function readScopePresets(globalState: PresetState, workspaceState: PresetState | undefined, chatId: string | undefined, scope: AgentPresetScope): StoredAgentPreset[] {
  if (scope === "global") return globalState.get<StoredAgentPreset[]>(globalPresetKey, []);
  if (scope === "project") return workspaceState?.get<StoredAgentPreset[]>(projectPresetKey, []) ?? [];
  return chatId && workspaceState ? chatPresetMap(workspaceState)[chatId] ?? [] : [];
}

async function writeScopePresets(globalState: PresetState, workspaceState: PresetState | undefined, chatId: string | undefined, scope: AgentPresetScope, presets: StoredAgentPreset[]): Promise<void> {
  if (scope === "global") { await globalState.update(globalPresetKey, presets); return; }
  if (!workspaceState) throw new Error("Open a project before changing project or chat sets");
  if (scope === "project") { await workspaceState.update(projectPresetKey, presets); return; }
  if (!chatId) throw new Error("Open a chat before changing chat sets");
  const map = chatPresetMap(workspaceState);
  await workspaceState.update(chatPresetKey, {...map, [chatId]: presets});
}

/** Serialize preset updates across panels sharing this extension host. */
export function useAgentPreset(globalState: PresetState, workspaceState: PresetState | undefined, chatId: string | undefined, action: "save" | "apply" | "update" | "delete", scope: AgentPresetScope, name: string, chatSettings?: AgentDefaults): Promise<AgentDefaults | undefined> {
  const previous = presetOperations.get(globalState) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await seedAgentPresets(globalState, workspaceState, chatId, chatSettings);
    const presets = readScopePresets(globalState, workspaceState, chatId, scope);
    name = name.trim();
    if (!name) throw new Error(localize("preset.name.required"));
    if (action === "delete") {
      const preset = presets.find(item => item.name === name);
      if (!preset) throw new Error(localize("preset.missing"));
      if (preset.isDefault) throw new Error(localize("preset.default.required"));
      await writeScopePresets(globalState, workspaceState, chatId, scope, presets.filter(item => item.name !== name));
      return;
    }
    if (scope === "project" && !vscode.workspace.workspaceFolders?.length) throw new Error("Open a project before changing project settings");
    if (action === "save" || action === "update") {
      if (action === "save" && presets.some(preset => preset.name === name)) throw new Error(localize("preset.duplicate"));
      if (action === "update" && !presets.some(preset => preset.name === name)) throw new Error(localize("preset.missing"));
      const settings = scope === "chat" ? mergeAgentSettings(chatSettings ?? {}) : readAgentDefaults()[scope];
      if (!REQUIRED_AGENT_ROLES.every(role => ["model", "reasoningEffort"].every(field => validAgentValue(field, settings[role]?.[field as "model" | "reasoningEffort"])))) throw new Error(localize("preset.invalid"));
      const replacement = {name, settings};
      await writeScopePresets(globalState, workspaceState, chatId, scope, action === "save" ? [...presets, replacement] : presets.map(preset => preset.name === name ? {...preset, ...replacement} : preset));
      return mergeAgentSettings(settings);
    }
    const preset = presets.find(preset => preset.name === name);
    if (!preset) throw new Error(localize("preset.missing"));
    // Validate the complete stored set before writing any setting.
    // Presets saved before the light Work profile omit it; applying them leaves unset optional fields unchanged.
    const required = (role: string) => (REQUIRED_AGENT_ROLES as readonly string[]).includes(role);
    const pairs = AGENT_ROLES.flatMap(role => AGENT_FIELDS.map(field => [role, field] as const))
      .filter(([role, field]) => field !== "fast" && (required(role) || preset.settings[role]?.[field] !== undefined));
    for (const [role, field] of pairs) {
      if (!validAgentValue(field, preset.settings[role]?.[field])) throw new Error(localize("preset.invalid"));
    }
    if (scope === "chat") return mergeAgentSettings(preset.settings);
    const config = vscode.workspace.getConfiguration(section, vscode.workspace.workspaceFolders?.[0]?.uri);
    const target = scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder;
    const before = new Map<string, string | boolean | undefined>();
    const fastEntry = config.inspect<unknown>("fastByModel");
    const beforeFast = scope === "global" ? fastEntry?.globalValue : fastEntry?.workspaceFolderValue;
    for (const [role, field] of pairs) {
      const key = `${role}.${field}`;
      const entry = config.inspect<string | boolean>(key);
      before.set(key, scope === "global" ? entry?.globalValue : entry?.workspaceFolderValue);
    }
    const changed: [typeof AGENT_ROLES[number], typeof AGENT_FIELDS[number]][] = [];
    let changedFast = false;
    try {
      for (const [role, field] of pairs) {
        await saveAgentDefault(scope, role, field, preset.settings[role]![field]!);
        changed.push([role, field]);
      }
      if (preset.settings.fastByModel) {
        await config.update("fastByModel", preset.settings.fastByModel, target);
        changedFast = true;
      }
    } catch (error) {
      // Restore earlier writes if a later configuration write fails.
      const rollback = await Promise.allSettled([
        ...changed.map(([role, field]) => config.update(`${role}.${field}`, before.get(`${role}.${field}`), target)),
        ...(changedFast ? [config.update("fastByModel", beforeFast, target)] : [])
      ]);
      if (rollback.some(result => result.status === "rejected")) throw new Error(localize("preset.rollback.failed"));
      throw error;
    }
    return mergeAgentSettings(preset.settings);
  });
  presetOperations.set(globalState, operation.then(() => undefined, () => undefined));
  return operation;
}

/** Patch only the edited field; serialize with save/delete to preserve concurrent edits. */
export function updateAgentPresetField(globalState: PresetState, workspaceState: PresetState | undefined, chatId: string | undefined, scope: AgentPresetScope, name: string, role: typeof AGENT_ROLES[number], field: typeof AGENT_FIELDS[number], value: string | boolean): Promise<void> {
  const operation = (presetOperations.get(globalState) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!AGENT_ROLES.includes(role) || !AGENT_FIELDS.includes(field) || !validAgentValue(field, value)) throw new Error(localize("preset.invalid"));
    const presets = readScopePresets(globalState, workspaceState, chatId, scope);
    const preset = presets.find(item => item.name === name);
    if (!preset) throw new Error(localize("preset.missing"));
    const fields = {...preset.settings[role]};
    if (field === "model") fields.model = value as string;
    else if (field === "reasoningEffort") fields.reasoningEffort = value as NonNullable<typeof fields.reasoningEffort>;
    else fields.fast = value as boolean;
    const replacement = {...preset, settings: {...preset.settings, [role]: fields}};
    await writeScopePresets(globalState, workspaceState, chatId, scope, presets.map(item => item === preset ? replacement : item));
  });
  presetOperations.set(globalState, operation);
  return operation;
}

export function updateAgentPresetFastMode(globalState: PresetState, workspaceState: PresetState | undefined, chatId: string | undefined, scope: AgentPresetScope, name: string, model: string, value: boolean): Promise<void> {
  const operation = (presetOperations.get(globalState) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!validAgentValue("model", model)) throw new Error(localize("preset.invalid"));
    const presets = readScopePresets(globalState, workspaceState, chatId, scope);
    const preset = presets.find(item => item.name === name);
    if (!preset) throw new Error(localize("preset.missing"));
    const replacement = {...preset, settings: {...preset.settings, fastByModel: {...preset.settings.fastByModel, [model]: value}}};
    await writeScopePresets(globalState, workspaceState, chatId, scope, presets.map(item => item === preset ? replacement : item));
  });
  presetOperations.set(globalState, operation);
  return operation;
}
