import * as vscode from "vscode";
import { randomUUID, createHash } from "node:crypto";
import * as path from "node:path";
import { AgentSetStorage } from "./agent-set-storage";
import { isDeepStrictEqual } from "node:util";
import { localize } from "../../common/localization";
import { parseAgentFastModes, parseModelFastModes } from "../../common/types/agent-models";
import { factoryAgentPresets } from "../agent-factory/provider-defaults";
import { AGENT_ROLES, AGENT_FIELDS, REQUIRED_AGENT_ROLES, mergeAgentSettings, type AgentDefaultsSnapshot, type AgentDefaults, type AgentPresetScope, validAgentValue } from "../../core/config/agent-settings";
const section = "agentFactory.agents";
type PresetState = Pick<vscode.Memento, "get" | "update">;
type DetectedProviders = { codex: boolean; claude: boolean; antigravity?: boolean };
interface StoredSet { id: string; name: string; settings: AgentDefaults }
interface Library { sets: StoredSet[]; projectDefaults: Record<string, string>; migratedProjects: string[]; factoryVersion?: number; legacySources?: Record<string, string[]>; deletedLegacySources?: string[]; legacyTrackedProjects?: string[]; legacyGlobalTracked?: boolean }
const libraryKey = "agentFactory.agentSets.v3";
const operations = new WeakMap<object, Promise<unknown>>();
const pendingInitialization = new WeakMap<object, {base: string; library: Library}>();
const sharedStorage = new WeakMap<object, AgentSetStorage>();
export function bindAgentSetStorage(context: vscode.ExtensionContext, storage = new AgentSetStorage(path.join(context.globalStorageUri.fsPath, "agent-sets-v3.json"))): void {
  if (!sharedStorage.has(context.globalState)) sharedStorage.set(context.globalState,
    storage);
}
export function watchAgentSets(context: vscode.ExtensionContext, refresh: () => void): vscode.Disposable | undefined {
  if (!sharedStorage.has(context.globalState)) return undefined;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.globalStorageUri, "agent-sets-v3.json"));
  const listeners = [watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh)];
  return {dispose: () => { for (const listener of listeners) listener.dispose(); watcher.dispose(); }};
}
function serialized<T>(state: PresetState, action: () => Promise<T>): Promise<T> {
  const operation = (operations.get(state) ?? Promise.resolve()).catch(() => undefined).then(() => {
    const storage = sharedStorage.get(state);
    return storage ? storage.transaction(action) : action();
  });
  operations.set(state, operation);
  return operation;
}
function projectKey(): string | undefined {
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  return uri ? uri.toString() === "[object Object]" ? uri.fsPath : uri.toString() : undefined;
}
function readLibrary(state?: Pick<vscode.Memento, "get">): Library | undefined {
  const library = state && (sharedStorage.get(state)?.read<Library>() ?? state.get<Library>(libraryKey));
  if (library && (!Array.isArray(library.sets) || !library.projectDefaults || !Array.isArray(library.migratedProjects))) throw new Error("Invalid agent set library");
  return library ? structuredClone(library) : undefined;
}
async function writeLibrary(state: PresetState, library: Library): Promise<void> {
  const storage = sharedStorage.get(state);
  if (!storage) { await state.update(libraryKey, library); return; }
  await storage.write(library);
  // Retire the cached v3 payload only after its replacement is durably written.
  if (state.get(libraryKey) !== undefined) await state.update(libraryKey, undefined);
}
/** Only migration reads the retired VS Code settings layers. Never write them again. */
function readLegacyDefaults(): {global: AgentDefaults; project: AgentDefaults} {
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
  const roleFastEntry = config?.inspect?.<unknown>("fastByRoleModel");
  const globalFast = parseModelFastModes(fastEntry?.globalValue);
  const projectFast = parseModelFastModes(fastEntry?.workspaceFolderValue ?? fastEntry?.workspaceValue);
  const globalRoleFast = parseAgentFastModes(roleFastEntry?.globalValue);
  const projectRoleFast = parseAgentFastModes(roleFastEntry?.workspaceFolderValue ?? roleFastEntry?.workspaceValue);
  if (globalRoleFast) global.fastByRoleModel = globalRoleFast;
  if (projectRoleFast) project.fastByRoleModel = projectRoleFast;
  if (globalFast) global.fastByModel = globalFast;
  if (projectFast) project.fastByModel = projectFast;
  // Legacy model-wide and role-scoped values seed role-specific preferences in memory.
  for (const [, settings, canonical] of [
    ["global", global, globalRoleFast !== undefined],
    ["project", project, projectRoleFast !== undefined]
  ] as const) {
    // Once materialized, even an empty canonical map replaces the legacy Fast values.
    if (canonical) {
      for (const role of AGENT_ROLES) if (settings[role]) {
        const {fast, ...fields} = settings[role]!;
        settings[role] = fields;
      }
      delete settings.fastByModel;
      continue;
    }
    const migrated = Object.fromEntries(AGENT_ROLES.map(role => [role, {...settings.fastByRoleModel?.[role]}])) as Record<typeof AGENT_ROLES[number], Record<string, boolean>>;
    for (const role of AGENT_ROLES) {
      const value = settings[role];
      for (const [model, enabled] of Object.entries(settings.fastByModel ?? {})) if (migrated[role][model] === undefined) migrated[role][model] = enabled;
      if (value?.model && typeof value.fast === "boolean" && migrated[role][value.model] === undefined) migrated[role][value.model] = value.fast;
    }
    const populated = Object.fromEntries(Object.entries(migrated).filter(([, modes]) => Object.keys(modes).length));
    if (Object.keys(populated).length) settings.fastByRoleModel = populated;
    delete settings.fastByModel;
  }
  return {global, project};
}

function importSet(library: Library, name: string, settings: AgentDefaults, deduplicate = true): StoredSet {
  const normalized = mergeAgentSettings(settings);
  const same = library.sets.find(set => (set.name === name || set.name.startsWith(`${name} (`)) && settingsEqual(set.settings, normalized));
  if (deduplicate && same) return same;
  let unique = name, suffix = 2;
  while (library.sets.some(set => set.name === unique)) unique = `${name} (${suffix++})`;
  const set = {id: randomUUID(), name: unique, settings: normalized};
  library.sets.push(set);
  return set;
}
const hasValues = (settings: AgentDefaults) => AGENT_ROLES.some(role => Object.keys(settings[role] ?? {}).length > 0) || Boolean(settings.fastByRoleModel && Object.keys(settings.fastByRoleModel).length);
const factoryIds = new Set(factoryAgentPresets().map(set => set.id));
function settingsEqual(a: AgentDefaults, b: AgentDefaults): boolean {
  return isDeepStrictEqual(mergeAgentSettings(a), mergeAgentSettings(b));
}
function legacyFingerprint(name: string, settings: AgentDefaults): string {
  const canonical = (value: unknown): unknown => value && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify([name, canonical(mergeAgentSettings(settings))])).digest("hex");
}
function importLegacySet(library: Library, name: string, settings: AgentDefaults): StoredSet | undefined {
  const fingerprint = legacyFingerprint(name, settings);
  if (library.deletedLegacySources?.includes(fingerprint)) return undefined;
  const set = importSet(library, name, settings);
  library.legacySources ??= {};
  library.legacySources[set.id] = [...new Set([...(library.legacySources[set.id] ?? []), fingerprint])];
  return set;
}
/** Existing v3 libraries predate source identities; associate only demonstrable matches. */
function trackLegacySources(library: Library, globalState: PresetState, workspaceState?: PresetState): boolean {
  const key = projectKey();
  const trackGlobal = !library.legacyGlobalTracked;
  const trackProject = key && !library.legacyTrackedProjects?.includes(key);
  if (!trackGlobal && !trackProject) return false;
  const legacy = readLegacyDefaults();
  type OldSet = {name: string; settings: AgentDefaults; isDefault?: boolean};
  const associate = (name: string, settings: AgentDefaults) => {
    for (const set of library.sets) if ((set.name === name || set.name.startsWith(`${name} (`)) && settingsEqual(set.settings, settings)) {
      library.legacySources ??= {};
      library.legacySources[set.id] = [...new Set([...(library.legacySources[set.id] ?? []), legacyFingerprint(name, settings)])];
    }
  };
  if (trackGlobal) {
    for (const storageKey of ["agentFactory.agentPresets.v1", "agentFactory.agentPresets.global.v2"]) {
      for (const set of globalState.get<OldSet[]>(storageKey, [])) associate(set.name, set.isDefault && hasValues(legacy.global) ? legacy.global : set.settings);
    }
    if (hasValues(legacy.global)) associate("Imported settings", legacy.global);
    library.legacyGlobalTracked = true;
  }
  if (trackProject) {
    for (const set of workspaceState?.get<OldSet[]>("agentFactory.agentPresets.project.v2", []) ?? []) associate(set.name, set.isDefault && hasValues(legacy.project) ? mergeAgentSettings(legacy.global, legacy.project) : set.settings);
    for (const sets of Object.values(workspaceState?.get<Record<string, OldSet[]>>("agentFactory.agentPresets.chat.v2", {}) ?? {})) for (const set of sets) associate(set.name, set.settings);
    if (hasValues(legacy.project)) associate("Imported settings", mergeAgentSettings(legacy.global, legacy.project));
    library.legacyTrackedProjects = [...(library.legacyTrackedProjects ?? []), key];
  }
  return true;
}
function assertCustom(set: StoredSet): void {
  if (factoryIds.has(set.id)) throw new Error(localize("preset.builtin.readonly"));
}
function upgradeFactorySets(library: Library): void {
  if (library.factoryVersion === 1) return;
  for (const factory of factoryAgentPresets()) {
    const old = library.sets.find(set => set.id === factory.id);
    const provider = factory.id.slice("factory-".length);
    const previousModel = provider === "codex" ? "gpt-6-astra" : provider === "claude" ? "claude-opus-5-5" : "gemini-3.8-flash";
    // The previous supplied sets predate the Explorer and Scribe rows.
    const previous = mergeAgentSettings(Object.fromEntries(AGENT_ROLES.filter(role => role !== "explore" && role !== "scribe").map(role => [role, {
      model: previousModel, reasoningEffort: provider === "antigravity" ? "high" : "medium", ...(provider === "codex" ? {fast: false} : {})
    }])));
    if (old && !settingsEqual(old.settings, factory.settings) &&
      !(old.name === `Agent Factory · ${factory.name}` && settingsEqual(old.settings, previous))) {
      const preserved = importSet(library, `${old.name} (Custom)`, old.settings);
      for (const key of Object.keys(library.projectDefaults)) if (library.projectDefaults[key] === old.id) library.projectDefaults[key] = preserved.id;
    }
    // Reserve supplied names without losing an existing custom set with that name.
    const conflict = library.sets.find(set => set.id !== factory.id && set.name === factory.name);
    if (conflict) {
      let suffix = 2;
      let name = `${conflict.name} (Custom)`;
      while (library.sets.some(set => set.name === name)) name = `${conflict.name} (Custom ${suffix++})`;
      conflict.name = name;
    }
    if (old) Object.assign(old, factory); else library.sets.push(factory);
  }
  const imported = new Map<string, StoredSet>();
  library.sets = library.sets.filter(set => {
    if (!/^(Default|Imported settings)( \(\d+\))?$/.test(set.name)) return true;
    const base = set.name.replace(/ \(\d+\)$/, "");
    const previous = [...imported.values()].find(other => other.name.replace(/ \(\d+\)$/, "") === base && settingsEqual(other.settings, set.settings));
    if (!previous) { imported.set(set.id, set); return true; }
    for (const key of Object.keys(library.projectDefaults)) if (library.projectDefaults[key] === set.id) library.projectDefaults[key] = previous.id;
    return false;
  });
  library.factoryVersion = 1;
}

async function initializeLibrary(globalState: PresetState, workspaceState?: PresetState, providers: DetectedProviders = {codex: false, claude: false}, random: () => number = Math.random): Promise<void> {
  const saved = readLibrary(globalState);
  const key = projectKey();
  if (saved?.factoryVersion === 1 && (!key || saved.migratedProjects.includes(key))) {
    const tracked = trackLegacySources(saved, globalState, workspaceState);
    if (tracked || (sharedStorage.has(globalState) && globalState.get(libraryKey) !== undefined)) await writeLibrary(globalState, saved);
    return;
  }
  const base = JSON.stringify(saved);
  const pending = pendingInitialization.get(globalState);
  let library = pending && pending.base === base ? pending.library : undefined;
  if (!library) {
    library = saved ?? {sets: factoryAgentPresets(), projectDefaults: {}, migratedProjects: []};
    upgradeFactorySets(library);
    const legacy = readLegacyDefaults();
    type OldSet = {name: string; settings: AgentDefaults; isDefault?: boolean};
    if (!saved) {
      for (const storageKey of ["agentFactory.agentPresets.v1", "agentFactory.agentPresets.global.v2"]) {
        for (const set of globalState.get<OldSet[]>(storageKey, [])) importLegacySet(library, set.name, set.isDefault && hasValues(legacy.global) ? legacy.global : set.settings);
      }
      if (hasValues(legacy.global)) importLegacySet(library, "Imported settings", legacy.global);
    }
    if (key && !library.migratedProjects.includes(key)) {
      const oldProject = workspaceState?.get<OldSet[]>("agentFactory.agentPresets.project.v2", []) ?? [];
      for (const set of oldProject) importLegacySet(library, set.name, set.isDefault && hasValues(legacy.project) ? mergeAgentSettings(legacy.global, legacy.project) : set.settings);
      const oldChats = workspaceState?.get<Record<string, OldSet[]>>("agentFactory.agentPresets.chat.v2", {}) ?? {};
      for (const sets of Object.values(oldChats)) for (const set of sets) importLegacySet(library, set.name, set.settings);
      let initial: StoredSet | undefined;
      if (hasValues(legacy.project)) initial = importLegacySet(library, "Imported settings", mergeAgentSettings(legacy.global, legacy.project));
      else if (oldProject.find(set => set.isDefault)) {
        const old = oldProject.find(set => set.isDefault)!;
        initial = importLegacySet(library, old.name, old.settings);
      } else if (hasValues(legacy.global) && (!saved || workspaceState?.get<boolean>("agentFactory.projectAgentDefaults.initialized.v3"))) initial = importLegacySet(library, "Imported settings", legacy.global);
      if (!initial) {
        const available = (["codex", "claude", "antigravity"] as const).filter(id => providers[id]);
        const provider = available.length ? available[Math.min(available.length - 1, Math.max(0, Math.floor(random() * available.length)))] : undefined;
        initial = provider ? library.sets.find(set => set.id === `factory-${provider}`) : undefined;
        // A deleted supplied set is recreated only when a new project needs it.
        if (provider && !initial) { initial = factoryAgentPresets().find(set => set.id === `factory-${provider}`)!; library.sets.push(initial); }
        if (!initial) initial = importSet(library, "Unconfigured", {});
      }
      library.projectDefaults[key] = initial.id;
      library.migratedProjects.push(key);
    }
    trackLegacySources(library, globalState, workspaceState);
    pendingInitialization.set(globalState, {base, library});
  }
  // One atomic write keeps sets, deletion history, migration and designations consistent.
  await writeLibrary(globalState, library);
  pendingInitialization.delete(globalState);
}

export function initializeAgentDefaults(globalState: PresetState, providers: DetectedProviders, workspaceState?: PresetState, random: () => number = Math.random): Promise<void> {
  return serialized(globalState, () => initializeLibrary(globalState, workspaceState, providers, random));
}
export function ensureAgentPresets(globalState: PresetState, workspaceState?: PresetState, _chatId?: string, _chatSettings?: AgentDefaults): Promise<void> {
  return serialized(globalState, () => initializeLibrary(globalState, workspaceState));
}

export function readAgentDefaults(globalState?: Pick<vscode.Memento, "get">, _workspaceState?: Pick<vscode.Memento, "get">, _chatId?: string): AgentDefaultsSnapshot {
  const library = readLibrary(globalState);
  const key = projectKey();
  const defaultSetId = key ? library?.projectDefaults[key] : undefined;
  const selected = library?.sets.find(set => set.id === defaultSetId);
  return {
    // These compatibility fields are derived snapshots, never independent settings layers.
    global: {}, project: mergeAgentSettings(selected?.settings ?? {}), projectAvailable: Boolean(key), defaultSetId,
    presets: (library?.sets ?? []).map(set => ({...set, scope: "global", isDefault: set.id === defaultSetId,
      builtIn: factoryIds.has(set.id),
      inUse: Object.values(library?.projectDefaults ?? {}).includes(set.id), settings: mergeAgentSettings(set.settings)}))
  };
}

export function useAgentPreset(globalState: PresetState, workspaceState: PresetState | undefined, _chatId: string | undefined, action: "save" | "apply" | "copy" | "update" | "delete" | "rename" | "default", _scope: AgentPresetScope, name: string, chatSettings?: AgentDefaults, newName?: string, sourceName?: string): Promise<AgentDefaults | undefined> {
  return serialized(globalState, async () => {
    await initializeLibrary(globalState, workspaceState);
    const library = readLibrary(globalState)!;
    name = name.trim();
    if (!name) throw new Error(localize("preset.name.required"));
    const set = library.sets.find(item => item.name === name);
    if (action === "save") {
      if (set) throw new Error(localize("preset.duplicate"));
      const source = sourceName === undefined ? undefined : library.sets.find(item => item.name === sourceName);
      if (sourceName !== undefined && !source) throw new Error(localize("preset.missing"));
      importSet(library, name, source?.settings ?? chatSettings ?? readAgentDefaults(globalState).project, false);
    } else {
      if (!set) throw new Error(localize("preset.missing"));
      if (["rename", "delete", "update"].includes(action)) assertCustom(set);
      if (action === "rename") {
        const replacement = newName?.trim();
        if (!replacement) throw new Error(localize("preset.name.required"));
        if (library.sets.some(item => item !== set && item.name === replacement)) throw new Error(localize("preset.duplicate"));
        set.name = replacement;
      } else if (action === "delete") {
        for (const key of Object.keys(library.projectDefaults)) {
          if (library.projectDefaults[key] === set.id) delete library.projectDefaults[key];
        }
        library.deletedLegacySources = [...new Set([...(library.deletedLegacySources ?? []),
          ...(library.legacySources?.[set.id] ?? []), legacyFingerprint(set.name, set.settings),
          legacyFingerprint(set.name.replace(/ \(\d+\)$/, ""), set.settings)])];
        if (library.legacySources) delete library.legacySources[set.id];
        library.sets = library.sets.filter(item => item !== set);
      } else if (action === "default") {
        const key = projectKey();
        if (!key) throw new Error("Open a project before choosing its default set");
        library.projectDefaults[key] = set.id;
      } else if (action === "update") {
        set.settings = mergeAgentSettings(chatSettings ?? {});
      } else {
        if (!REQUIRED_AGENT_ROLES.every(role => ["model", "reasoningEffort"].every(field => validAgentValue(field, set.settings[role]?.[field as "model" | "reasoningEffort"])))) throw new Error(localize("preset.invalid"));
        return mergeAgentSettings(set.settings);
      }
    }
    await writeLibrary(globalState, library);
    return undefined;
  });
}

export function updateAgentPresetField(globalState: PresetState, workspaceState: PresetState | undefined, _chatId: string | undefined, _scope: AgentPresetScope, name: string, role: typeof AGENT_ROLES[number], field: typeof AGENT_FIELDS[number], value: string | boolean): Promise<void> {
  return serialized(globalState, async () => {
    if (!AGENT_ROLES.includes(role) || !AGENT_FIELDS.includes(field) || !validAgentValue(field, value)) throw new Error(localize("preset.invalid"));
    await initializeLibrary(globalState, workspaceState);
    const library = readLibrary(globalState)!;
    const set = library.sets.find(item => item.name === name);
    if (!set) throw new Error(localize("preset.missing"));
    assertCustom(set);
    set.settings = mergeAgentSettings(set.settings, {[role]: {[field]: value}});
    await writeLibrary(globalState, library);
  });
}
export function updateAgentPresetFastMode(globalState: PresetState, workspaceState: PresetState | undefined, _chatId: string | undefined, _scope: AgentPresetScope, name: string, role: typeof AGENT_ROLES[number], model: string, value: boolean): Promise<void> {
  return serialized(globalState, async () => {
    if (!AGENT_ROLES.includes(role) || !validAgentValue("model", model)) throw new Error(localize("preset.invalid"));
    await initializeLibrary(globalState, workspaceState);
    const library = readLibrary(globalState)!;
    const set = library.sets.find(item => item.name === name);
    if (!set) throw new Error(localize("preset.missing"));
    assertCustom(set);
    set.settings.fastByRoleModel = {...set.settings.fastByRoleModel, [role]: {...set.settings.fastByRoleModel?.[role], [model]: value}};
    await writeLibrary(globalState, library);
  });
}
