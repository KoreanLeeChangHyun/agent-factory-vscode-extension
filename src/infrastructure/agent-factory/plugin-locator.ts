import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RELATIVE_EXEC_PATH = join("skills", "agent", "scripts", "exec.py");

export interface PluginLocatorOptions {
  readonly configuredPath?: string;
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
          diagnostic: `설정된 Agent Factory exec.py가 올바른 일반 파일이 아닙니다: ${configured}`
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
        const candidate = join(pluginRoot, version.name, RELATIVE_EXEC_PATH);
        try {
          const info = await lstat(candidate);
          if (info.isFile()) candidates.push({ path: candidate, modifiedAt: info.mtimeMs });
        } catch {
          // Ignore incomplete or stale cache entries and keep searching.
        }
      }
    }
  } catch {
    return {
      available: false,
      diagnostic: `Agent Factory 플러그인 캐시를 찾을 수 없습니다: ${cacheRoot}`
    };
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));
  if (candidates[0]) return { available: true, execPath: candidates[0].path };
  return {
    available: false,
    diagnostic: `설치된 marketplace의 Agent Factory 플러그인에서 ${RELATIVE_EXEC_PATH}를 찾지 못했습니다.`
  };
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
