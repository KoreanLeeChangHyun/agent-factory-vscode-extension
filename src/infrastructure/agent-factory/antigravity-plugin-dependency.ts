import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { localize } from "../../common/localization";
import { PluginDependencyError, runProcess, semanticBase, type ProcessRunner } from "./plugin-dependency";
import { antigravityExecutable } from "./process-environment";

const PLUGIN_NAME = "agent-factory";
const OFFICIAL_REPOSITORY = "https://github.com/KoreanLeeChangHyun/agent-factory-antigravity-plugin";
const INSTALL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const pending = new WeakMap<ProcessRunner, Promise<void>>();

/** The Antigravity CLI when it runs; agy is optional, so an unusable CLI is simply absent. */
export async function isAntigravityAvailable(agy = antigravityExecutable(), runner: ProcessRunner = runProcess): Promise<boolean> {
  try {
    const { stdout } = await runner(agy, ["--version"], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
    return /^\d+\.\d+\.\d+/.test(stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Install or update the Antigravity plugin whose base version matches the extension.
 * `agy plugin list` reports no versions, so the installed plugin.json is the evidence.
 */
export async function ensureAgentFactoryAntigravityPlugin(
  requiredExtensionVersion: string,
  runner: ProcessRunner = runProcess,
  options: { readonly agy?: string; readonly home?: string } = {}
): Promise<void> {
  const inFlight = pending.get(runner);
  if (inFlight) return inFlight;
  const promise = ensure(semanticBase(requiredExtensionVersion), runner, options.agy ?? antigravityExecutable(), options.home ?? homedir());
  pending.set(runner, promise);
  try {
    await promise;
  } finally {
    pending.delete(runner);
  }
}

async function ensure(requiredBase: string, runner: ProcessRunner, agy: string, home: string): Promise<void> {
  const manifest = join(home, ".gemini", "config", "plugins", PLUGIN_NAME, "plugin.json");
  const current = await installedVersion(manifest);
  if (current && semanticBase(current) === requiredBase) return;
  // Installing over an existing copy replaces it with the repository's current main.
  try {
    await runner(agy, ["plugin", "install", OFFICIAL_REPOSITORY], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
  } catch (error) {
    const detail = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()
      ? error.stderr.trim().slice(0, 500) : String(error);
    throw new PluginDependencyError(localize("antigravity.plugin.command.failed", detail), { cause: error });
  }
  const after = await installedVersion(manifest);
  if (!after || semanticBase(after) !== requiredBase) {
    throw new PluginDependencyError(localize("antigravity.plugin.version.unavailable", requiredBase, after ?? "-"));
  }
}

/** Read-only: the installed Agent Factory Antigravity plugin's version, without installing or updating anything. */
export async function installedAntigravityPluginVersion(home: string = homedir()): Promise<string | undefined> {
  return installedVersion(join(home, ".gemini", "config", "plugins", PLUGIN_NAME, "plugin.json"));
}

async function installedVersion(manifest: string): Promise<string | undefined> {
  try {
    const info = await stat(manifest);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
    const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return record.name === PLUGIN_NAME && typeof record.version === "string" ? record.version : undefined;
  } catch {
    // Missing or unreadable: treat as not installed and let the install establish it.
    return undefined;
  }
}
