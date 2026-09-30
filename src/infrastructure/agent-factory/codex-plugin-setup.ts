import { ensureAgentFactoryPlugin } from "./plugin-dependency";
import { locateAgentFactoryExec, type PluginLocation, type PluginLocatorOptions } from "./plugin-locator";

export type LocalPluginLocator = (options: PluginLocatorOptions) => Promise<PluginLocation>;
export type PluginRepair = (requiredVersion: string) => Promise<void>;

/**
 * Use the extension's directly executable local runtime when it already matches. The Codex CLI
 * list command also consults remote marketplaces, so it belongs only on the missing/outdated
 * repair path and must not delay every activation or provider refresh.
 */
export async function ensureAgentFactoryCodexRuntime(
  requiredVersion: string,
  locate: LocalPluginLocator = locateAgentFactoryExec,
  repair: PluginRepair = ensureAgentFactoryPlugin
): Promise<void> {
  const local = await locate({ requiredVersion });
  if (local.available) return;
  await repair(requiredVersion);
}
