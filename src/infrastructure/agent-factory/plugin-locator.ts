import { localize } from "../../common/localization";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { semanticBase } from "./plugin-dependency";

/** Plugin-relative exec.py locations, newest layout first. */
export const RELATIVE_EXEC_PATHS = [join("scripts", "exec.py"), join("skills", "agent", "scripts", "exec.py")] as const;

export interface PluginLocatorOptions {
  readonly configuredPath?: string;
  readonly requiredVersion?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export type PluginLocation =
  | { readonly available: true; readonly execPath: string }
  | { readonly available: false; readonly diagnostic: string };

export async function locateAgentFactoryExec(
  options: PluginLocatorOptions = {}
): Promise<PluginLocation> {
  if (options.configuredPath?.trim()) {
    const configured = resolve(options.configuredPath.trim());
    return (await isRegularFile(configured))
      ? { available: true, execPath: configured }
      : {
          available: false,
          diagnostic: localize("ui.the.configured.agent.factory.exec.py.is.not.a.valid.regular.file.0", configured)
        };
  }

  const environment = options.environment ?? process.env;
  const codexHome = environment.CODEX_HOME?.trim()
    ? resolve(environment.CODEX_HOME)
    : join(options.homeDirectory ?? homedir(), ".codex");
  const cacheRoot = join(codexHome, "plugins", "cache");
  const candidates: Array<{ readonly path: string; readonly modifiedAt: number }> = [];
  try {
    const marketplaces = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    for (const marketplace of marketplaces) {
      const pluginRoot = join(cacheRoot, marketplace.name, "agent-factory");
      let versions;
      try {
        versions = (await readdir(pluginRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
      } catch {
        continue;
      }
      for (const version of versions) {
        try {
          if (options.requiredVersion) {
            const manifest = JSON.parse(await readFile(join(pluginRoot, version.name, ".codex-plugin", "plugin.json"), "utf8"));
            if (manifest.name !== "agent-factory" || typeof manifest.version !== "string"
              || semanticBase(manifest.version) !== semanticBase(options.requiredVersion)) continue;
          }
          for (const relative of RELATIVE_EXEC_PATHS) {
            const candidate = join(pluginRoot, version.name, relative);
            const info = await lstat(candidate).catch(() => undefined);
            if (info?.isFile()) {
              candidates.push({ path: candidate, modifiedAt: info.mtimeMs });
              break;
            }
          }
        } catch {
          // Ignore incomplete or stale cache entries and keep searching.
        }
      }
    }
  } catch {
    return {
      available: false,
      diagnostic: localize("ui.unable.to.find.the.agent.factory.plugin.cache.0", cacheRoot)
    };
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));
  if (candidates[0]) return { available: true, execPath: candidates[0].path };
  return {
    available: false,
    diagnostic: localize("ui.unable.to.find.0.in.the.agent.factory.plugin.1.installed.from.the.marketplace", RELATIVE_EXEC_PATHS[0], options.requiredVersion ? localize("ui.matching.extension.version.0", semanticBase(options.requiredVersion)) : "")
  };
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
