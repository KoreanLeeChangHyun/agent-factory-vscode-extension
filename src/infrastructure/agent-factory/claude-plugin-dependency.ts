import { localize } from "../../common/localization";
import { PluginDependencyError, runProcess, semanticBase, type ProcessRunner } from "./plugin-dependency";
import { claudeExecutable } from "./process-environment";

const MARKETPLACE = "agent-factory";
const PLUGIN_ID = "agent-factory@agent-factory";
const OFFICIAL_REPOSITORY = "KoreanLeeChangHyun/agent-factory-claude-plugin";
const LIST_TIMEOUT_MS = 15_000;
const CHANGE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const pending = new WeakMap<ProcessRunner, Promise<void>>();

interface InstalledRecord {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
}

/**
 * Install or update the Claude Code plugin whose base version matches the extension.
 * A plugin the Human disabled stays disabled; it only has to be present at the right version.
 */
export async function ensureAgentFactoryClaudePlugin(
  requiredExtensionVersion: string,
  runner: ProcessRunner = runProcess
): Promise<void> {
  const inFlight = pending.get(runner);
  if (inFlight) return inFlight;
  const promise = ensure(semanticBase(requiredExtensionVersion), runner);
  pending.set(runner, promise);
  try {
    await promise;
  } finally {
    pending.delete(runner);
  }
}

async function ensure(requiredBase: string, runner: ProcessRunner): Promise<void> {
  const current = await installed(runner);
  if (current && semanticBase(current.version) === requiredBase) return;
  await ensureMarketplace(runner);
  // Refresh the catalog so a newly released version is visible before installing or updating.
  await run(runner, ["plugin", "marketplace", "update", MARKETPLACE], CHANGE_TIMEOUT_MS, localize("claude.plugin.marketplace.update"));
  const available = await availableVersion(runner);
  if (!available || semanticBase(available) !== requiredBase) {
    throw new PluginDependencyError(localize("claude.plugin.version.unavailable", requiredBase, available ?? "-"));
  }
  await run(runner, current ? ["plugin", "update", PLUGIN_ID] : ["plugin", "install", PLUGIN_ID],
    CHANGE_TIMEOUT_MS, localize("claude.plugin.install"));
  const after = await installed(runner);
  if (!after || semanticBase(after.version) !== requiredBase) {
    throw new PluginDependencyError(localize("claude.plugin.unconfirmed", requiredBase));
  }
}

async function installed(runner: ProcessRunner): Promise<InstalledRecord | undefined> {
  const value = parseJson(await run(runner, ["plugin", "list", "--json"], LIST_TIMEOUT_MS, localize("claude.plugin.list")));
  if (!Array.isArray(value)) throw new PluginDependencyError(localize("claude.plugin.invalid.output", localize("claude.plugin.list")));
  const records = value.filter((record): record is InstalledRecord => isRecord(record) && record.id === PLUGIN_ID
    && typeof record.version === "string" && typeof record.enabled === "boolean");
  return records[0];
}

async function availableVersion(runner: ProcessRunner): Promise<string | undefined> {
  const value = parseJson(await run(runner, ["plugin", "list", "--available", "--json"], LIST_TIMEOUT_MS, localize("claude.plugin.list")));
  const available = isRecord(value) && Array.isArray(value.available) ? value.available : undefined;
  if (!available) throw new PluginDependencyError(localize("claude.plugin.invalid.output", localize("claude.plugin.list")));
  const match = available.find(record => isRecord(record) && record.pluginId === PLUGIN_ID && typeof record.version === "string");
  return isRecord(match) ? String(match.version) : undefined;
}

async function ensureMarketplace(runner: ProcessRunner): Promise<void> {
  const value = parseJson(await run(runner, ["plugin", "marketplace", "list", "--json"], LIST_TIMEOUT_MS, localize("claude.plugin.marketplace.list")));
  if (!Array.isArray(value)) throw new PluginDependencyError(localize("claude.plugin.invalid.output", localize("claude.plugin.marketplace.list")));
  const existing = value.find(entry => isRecord(entry) && entry.name === MARKETPLACE);
  if (existing) {
    // Never overwrite a same-named marketplace that points elsewhere.
    if (!isRecord(existing) || String(existing.repo ?? existing.url ?? "").replace(/^https:\/\/github\.com\/|\.git$/g, "") !== OFFICIAL_REPOSITORY) {
      throw new PluginDependencyError(localize("claude.plugin.marketplace.conflict", OFFICIAL_REPOSITORY));
    }
    return;
  }
  await run(runner, ["plugin", "marketplace", "add", OFFICIAL_REPOSITORY], CHANGE_TIMEOUT_MS, localize("claude.plugin.marketplace.add"));
}

async function run(runner: ProcessRunner, arguments_: readonly string[], timeout: number, operation: string): Promise<string> {
  try {
    const result = await runner(claudeExecutable(), arguments_, { timeout, maxBuffer: MAX_OUTPUT_BYTES });
    return result.stdout;
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === "string" && error.stderr.trim() ? error.stderr.trim().slice(0, 500) : String(error);
    throw new PluginDependencyError(localize("claude.plugin.command.failed", operation, detail), { cause: error });
  }
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new PluginDependencyError(localize("claude.plugin.invalid.output", stdout.slice(0, 200)), { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
