import { localize } from "../../common/localization";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** F5 supplies this path only to the development host and its child processes. */
export function developmentPluginRoot(isDevelopment: boolean, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isDevelopment) return undefined;
  const root = environment.AGENT_FACTORY_DEV_PLUGIN_ROOT?.trim();
  return root ? resolve(root) : undefined;
}

export function pluginRuntimeEnvironment(root?: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.AGENT_FACTORY_DEV_PLUGIN_ROOT;
  if (root) result.AGENT_FACTORY_DEV_PLUGIN_ROOT = root;
  return result;
}

export function developmentExecPath(root: string): string {
  const current = join(root, "scripts", "exec.py");
  return existsSync(current) ? current : join(root, "skills", "agent", "scripts", "exec.py");
}

/** The plugin source keeps shared metadata in distribution/package.json; generated or legacy roots carry the Codex manifest. */
async function developmentManifest(root: string): Promise<{ readonly name?: unknown; readonly version?: unknown }> {
  for (const path of [join(root, "distribution", "package.json"), join(root, ".codex-plugin", "plugin.json")]) {
    if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  }
  throw new Error(localize("ui.missing.local.development.plugin.file.0", join(root, ".codex-plugin", "plugin.json")));
}

export async function validateDevelopmentPlugin(root: string, requiredVersion: string): Promise<void> {
  const manifest = await developmentManifest(root);
  if (manifest.name !== "agent-factory" || typeof manifest.version !== "string"
      || manifest.version.split("+")[0] !== requiredVersion.split("+")[0]) {
    throw new Error(localize("ui.local.development.plugin.must.match.extension.version.0.1", requiredVersion, root));
  }
  for (const file of [developmentExecPath(root), ...["agent", "convention", "document"].map(
    name => join(root, "skills", name, "SKILL.md")
  )]) {
    if (!(await stat(file)).isFile()) throw new Error(localize("ui.missing.local.development.plugin.file.0", file));
  }
}
