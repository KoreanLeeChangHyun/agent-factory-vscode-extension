import {
  configureAntigravityCli, configureClaudeCli, configureCodexCli, probeTerminalPath, resolveProviderCli,
  type CodexCliResolutionOptions, type CodexCliSelection, type CodexCliSource, type ProviderCommand
} from "./process-environment";

export const PROVIDER_IDS = ["codex", "claude", "antigravity"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

/** `agentFactory.mainChat.<key>` holding each provider's manual executable path. */
export const PROVIDER_PATH_SETTINGS: Readonly<Record<ProviderId, string>> = {
  codex: "codexPath", claude: "claudePath", antigravity: "antigravityPath"
};

/** `agentFactory.mainChat.pluginUpdateMode`: keep each detected CLI's Agent Factory plugin in sync automatically, or only on request. */
export const PLUGIN_UPDATE_MODES = ["auto", "manual"] as const;
export type PluginUpdateMode = typeof PLUGIN_UPDATE_MODES[number];

/** Plugin compatibility follows the shared release base version and ignores build metadata. */
export function pluginVersionIsCurrent(installed: string | undefined, required: string): boolean {
  return installed?.split("+", 1)[0]?.trim() === required.split("+", 1)[0]?.trim();
}

/** Antigravity has no version-selection install option, so only an already-matching copy is safe. */
export function canInstallSpecificPluginVersion(id: ProviderId, installed: string | undefined, requested: string): boolean {
  return id !== "antigravity" || pluginVersionIsCurrent(installed, requested);
}

const COMMANDS: Readonly<Record<ProviderId, ProviderCommand>> = { codex: "codex", claude: "claude", antigravity: "agy" };

export interface ProviderStatus {
  readonly id: ProviderId;
  readonly detected: boolean;
  readonly path?: string;
  readonly source?: CodexCliSource;
  readonly configuredPath?: string;
  /** A manual path was set but is not an executable file, so detection fell back to the search. */
  readonly configuredInvalid?: boolean;
}

export type ProviderPaths = Partial<Readonly<Record<ProviderId, string>>>;

let current: readonly ProviderStatus[] = PROVIDER_IDS.map(id => ({ id, detected: false }));
const listeners = new Set<(statuses: readonly ProviderStatus[]) => void>();

export function providerStatuses(): readonly ProviderStatus[] {
  return current;
}

export function isProviderDetected(id: ProviderId): boolean {
  return current.some(status => status.id === id && status.detected);
}

export function onProvidersChanged(listener: (statuses: readonly ProviderStatus[]) => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/**
 * Resolve every provider CLI independently and apply the results to all later process spawns.
 * A missing provider is reported, never thrown: any one detected CLI keeps the chat usable.
 */
export async function detectProviders(
  configured: ProviderPaths,
  options: Omit<CodexCliResolutionOptions, "configuredPath"> = {}
): Promise<readonly ProviderStatus[]> {
  let terminal: Promise<readonly string[]> | undefined;
  const terminalPath = options.terminalPath
    ?? (options.environment === undefined ? () => (terminal ??= probeTerminalPath().catch(() => [])) : undefined);
  const selections = await Promise.all(PROVIDER_IDS.map(id =>
    resolveProviderCli(COMMANDS[id], { ...options, terminalPath, configuredPath: configured[id]?.trim() || undefined })));
  const byId = Object.fromEntries(PROVIDER_IDS.map((id, index) => [id, selections[index]])) as Record<ProviderId, CodexCliSelection | undefined>;
  configureCodexCli(byId.codex);
  configureClaudeCli(byId.claude?.executable);
  configureAntigravityCli(byId.antigravity?.executable);
  current = PROVIDER_IDS.map(id => {
    const selection = byId[id];
    const configuredPath = configured[id]?.trim() || undefined;
    return {
      id,
      detected: selection !== undefined,
      ...(selection ? { path: selection.executable, source: selection.source } : {}),
      ...(configuredPath ? { configuredPath, configuredInvalid: selection?.source !== "configured" } : {})
    };
  });
  for (const listener of listeners) listener(current);
  return current;
}
