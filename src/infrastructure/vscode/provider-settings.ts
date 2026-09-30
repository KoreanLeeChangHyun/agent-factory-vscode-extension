import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { localize } from "../../common/localization";
import { installedCodexPluginVersion } from "../agent-factory/plugin-dependency";
import { ensureAgentFactoryCodexRuntime } from "../agent-factory/codex-plugin-setup";
import { ensureAgentFactoryClaudePlugin, installedClaudePluginVersion } from "../agent-factory/claude-plugin-dependency";
import { ensureAgentFactoryAntigravityPlugin, installedAntigravityPluginVersion } from "../agent-factory/antigravity-plugin-dependency";
import { developmentPluginRoot } from "../agent-factory/development-plugin";
import {
  canInstallSpecificPluginVersion, detectProviders, pluginVersionIsCurrent, PROVIDER_IDS, PROVIDER_PATH_SETTINGS, providerStatuses,
  type ProviderId, type ProviderPaths, type ProviderStatus, type PluginUpdateMode
} from "../agent-factory/provider-detection";
import { initializeAgentDefaults } from "./agent-settings-store";

const SECTION = "agentFactory.mainChat";

export interface ProviderSnapshot {
  readonly providers: readonly ProviderStatus[];
  /** Plugin setup failures for providers found by this detection, keyed by provider. */
  readonly errors: Partial<Readonly<Record<ProviderId, string>>>;
}

export function configuredProviderPaths(): ProviderPaths {
  const settings = vscode.workspace?.getConfiguration(SECTION);
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, settings?.get<string>(PROVIDER_PATH_SETTINGS[id])?.trim() ?? ""]));
}

export function affectsProviderPaths(event: vscode.ConfigurationChangeEvent): boolean {
  return PROVIDER_IDS.some(id => event.affectsConfiguration(`${SECTION}.${PROVIDER_PATH_SETTINGS[id]}`));
}

/** Machine-scoped manual path; an empty value returns the provider to automatic detection. */
export async function saveProviderPath(id: ProviderId, path: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION)
    .update(PROVIDER_PATH_SETTINGS[id], path.trim() || undefined, vscode.ConfigurationTarget.Global);
}

/** "auto" keeps each detected CLI's Agent Factory plugin in sync with this extension version; "manual" only updates it on request. */
export function pluginUpdateMode(): PluginUpdateMode {
  return vscode.workspace?.getConfiguration(SECTION)?.get<string>("pluginUpdateMode") === "manual" ? "manual" : "auto";
}

export async function savePluginUpdateMode(mode: PluginUpdateMode): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update("pluginUpdateMode", mode, vscode.ConfigurationTarget.Global);
}

export function affectsPluginUpdateMode(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(`${SECTION}.pluginUpdateMode`);
}

const PLUGIN_INSTALLERS: Readonly<Record<ProviderId, (version: string) => Promise<void>>> = {
  codex: ensureAgentFactoryCodexRuntime,
  claude: ensureAgentFactoryClaudePlugin,
  antigravity: version => ensureAgentFactoryAntigravityPlugin(version)
};

async function installPlugins(
  context: vscode.ExtensionContext,
  ids: readonly ProviderId[],
  requestedVersion?: string
): Promise<Partial<Record<ProviderId, string>>> {
  const errors: Partial<Record<ProviderId, string>> = {};
  const requiredVersion: unknown = requestedVersion ?? context.extension?.packageJSON?.version;
  const development = Boolean(developmentPluginRoot(context.extensionMode === vscode.ExtensionMode.Development));
  if (typeof requiredVersion !== "string" || development) return errors;
  for (const id of ids) {
    try {
      if (requestedVersion && id === "antigravity") {
        const installed = await installedAntigravityPluginVersion();
        if (!canInstallSpecificPluginVersion(id, installed, requestedVersion)) {
          errors[id] = localize("antigravity.plugin.specific.version.unsupported", requestedVersion);
        }
        continue;
      }
      await PLUGIN_INSTALLERS[id](requiredVersion);
    } catch (error) {
      errors[id] = error instanceof Error ? error.message : String(error);
    }
  }
  return errors;
}

/**
 * Detect again after a manual change and, in automatic update mode, prepare the plugin for each
 * provider now found, so a chat opened without any CLI becomes usable without reloading the window.
 */
export async function redetectProviders(context: vscode.ExtensionContext): Promise<ProviderSnapshot> {
  const before = new Map(providerStatuses().map(status => [status.id, status.path]));
  const providers = await detectProviders(configuredProviderPaths());
  const changed = providers.filter(status => status.detected && before.get(status.id) !== status.path).map(status => status.id);
  const errors = pluginUpdateMode() === "auto" && changed.length ? await installPlugins(context, changed) : {};
  const detected = (id: ProviderId) => providers.some(status => status.id === id && status.detected);
  await initializeAgentDefaults(context.globalState, { codex: detected("codex"), claude: detected("claude") }, context.workspaceState);
  return { providers, errors };
}

/** Update or install the requested Agent Factory plugin version for every detected provider. */
export async function updateProviderPlugins(context: vscode.ExtensionContext, version?: string): Promise<Partial<Record<ProviderId, string>>> {
  return installPlugins(context, providerStatuses().filter(status => status.detected).map(status => status.id), version);
}

export interface ProviderVersions {
  /** The detected CLI's own `--version` output. */
  readonly cli?: string;
  /** The installed Agent Factory plugin's version, if any. */
  readonly plugin?: string;
  /** Whether the installed plugin's base version matches the extension version. */
  readonly pluginCurrent?: boolean;
}

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const PLUGIN_VERSION_READERS: Readonly<Record<ProviderId, () => Promise<string | undefined>>> = {
  codex: () => installedCodexPluginVersion(),
  claude: () => installedClaudePluginVersion(),
  antigravity: () => installedAntigravityPluginVersion()
};

function probeCliVersion(executable: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(executable, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      resolve(/\d+\.\d+(?:\.\d+)?[\w.-]*/.exec(stdout)?.[0] ?? (stdout.trim().slice(0, 40) || undefined));
    });
  });
}

let cachedVersions: Partial<Record<ProviderId, ProviderVersions>> = {};

export function providerVersions(): Partial<Readonly<Record<ProviderId, ProviderVersions>>> {
  return cachedVersions;
}

/**
 * Look up each detected provider's CLI and Agent Factory plugin version. Read-only: never installs
 * or updates anything. Spawns one or two short-lived processes per detected provider, so this is
 * called on request (opening the providers settings tab, or a manual refresh), not on every detect.
 */
export async function refreshProviderVersions(requiredVersion?: string): Promise<Partial<Readonly<Record<ProviderId, ProviderVersions>>>> {
  const detected = providerStatuses().filter((status): status is ProviderStatus & { path: string } => status.detected && typeof status.path === "string");
  const entries = await Promise.all(detected.map(async status => {
    const [cli, plugin] = await Promise.all([probeCliVersion(status.path), PLUGIN_VERSION_READERS[status.id]().catch(() => undefined)]);
    return [status.id, {
      ...(cli ? { cli } : {}),
      ...(plugin ? { plugin } : {}),
      ...(requiredVersion ? { pluginCurrent: pluginVersionIsCurrent(plugin, requiredVersion) } : {})
    }] as const;
  }));
  cachedVersions = Object.fromEntries(entries);
  return cachedVersions;
}
