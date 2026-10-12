export const PROVIDER_IDS = ["codex", "claude", "antigravity"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity" };

/** `agentFactory.mainChat.pluginUpdateMode`: keep each detected CLI's Agent Factory plugin in sync automatically, or only on request. */
export const PLUGIN_UPDATE_MODES = ["auto", "manual"] as const;
export type PluginUpdateMode = typeof PLUGIN_UPDATE_MODES[number];

/** Sign-in state reported by the CLI itself; `unknown` covers unsupported checks, timeouts and errors. */
export type ProviderAuthState = "signed-in" | "signed-out" | "unknown" | "missing";
export type ProviderAuthMethod = "account" | "api-key";

export interface ProviderAuthStatus {
  readonly state: ProviderAuthState;
  readonly method?: ProviderAuthMethod;
  readonly reason?: "unsupported" | "timeout" | "error";
  /** The executable that was asked, so a result for a replaced path is not shown. */
  readonly path?: string;
}
