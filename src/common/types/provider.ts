export const PROVIDER_IDS = ["codex", "claude", "antigravity"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

/** `agentFactory.mainChat.pluginUpdateMode`: keep each detected CLI's Agent Factory plugin in sync automatically, or only on request. */
export const PLUGIN_UPDATE_MODES = ["auto", "manual"] as const;
export type PluginUpdateMode = typeof PLUGIN_UPDATE_MODES[number];
