import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { runtimeEnvironment } from "./process-environment";

const CODEX_COMMAND = "codex";
const LIST_INSTALLED_ARGUMENTS = ["plugin", "list", "--json"] as const;
const LIST_AVAILABLE_ARGUMENTS = ["plugin", "list", "--available", "--json"] as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
// The repair-only catalog is substantially larger than the installed list, but remains bounded.
const MAX_AVAILABLE_OUTPUT_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 15_000;
const ADD_TIMEOUT_MS = 30_000;
const OFFICIAL_SOURCE = "KoreanLeeChangHyun/agent-factory-codex-plugin";
const pendingRepairs = new WeakMap<ProcessRunner, { version: string; promise: Promise<void> }>();

export interface ProcessRunOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export type ProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: ProcessRunOptions
) => Promise<ProcessResult>;

interface PluginRecord {
  readonly pluginId: string;
  readonly name: string;
  readonly marketplaceName: string;
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
}

export class PluginDependencyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginDependencyError";
  }
}

export async function ensureAgentFactoryPlugin(
  requiredExtensionVersion: string,
  runner: ProcessRunner = runProcess
): Promise<void> {
  const requiredBase = semanticBase(requiredExtensionVersion);
  const pending = pendingRepairs.get(runner);
  if (pending) {
    if (pending.version === requiredBase) return pending.promise;
    await pending.promise.catch(() => undefined);
    return ensureAgentFactoryPlugin(requiredExtensionVersion, runner);
  }
  const promise = ensurePlugin(requiredBase, runner);
  pendingRepairs.set(runner, { version: requiredBase, promise });
  try {
    await promise;
  } finally {
    pendingRepairs.delete(runner);
  }
}

async function ensurePlugin(requiredBase: string, runner: ProcessRunner): Promise<void> {
  let records = await listPlugins(runner, "installed");
  if (hasCompatibleInstalledPlugin(records, requiredBase)) return;

  await ensureOfficialMarketplace(runner);
  const availableRecords = await listPlugins(runner, "available");
  const candidate = availableRecords
    .filter((record) => record.name === "agent-factory" && semanticBase(record.version) === requiredBase)
    .sort(compareCandidates)[0];
  if (!candidate) {
    throw new PluginDependencyError(
      `Unable to install Agent Factory plugin version ${requiredBase}. The configured catalogs do not offer this exact version. Refresh the official marketplace or install the matching extension version, then Retry.`
    );
  }

  const addResult = await invoke(
    runner,
    ["plugin", "add", candidate.pluginId, "--json"],
    ADD_TIMEOUT_MS,
    "Agent Factory plugin installation"
  );
  parseJsonObject(addResult.stdout, "Agent Factory plugin installation result");

  records = await listPlugins(runner, "installed");
  if (!hasCompatibleInstalledPlugin(records.filter((record) => record.pluginId === candidate.pluginId), requiredBase)) {
    throw new PluginDependencyError(
      `Unable to confirm that Agent Factory plugin ${requiredBase} is active after installation. Check the Codex plugin settings.`
    );
  }
}

async function ensureOfficialMarketplace(runner: ProcessRunner): Promise<void> {
  if (await hasOfficialMarketplace(runner)) return;
  const result = await invoke(runner,
    ["plugin", "marketplace", "add", OFFICIAL_SOURCE, "--ref", "main", "--json"],
    ADD_TIMEOUT_MS, "Register official Agent Factory marketplace");
  parseJsonObject(result.stdout, "Marketplace registration result");
  if (!await hasOfficialMarketplace(runner)) {
    throw new PluginDependencyError("Unable to confirm official Agent Factory marketplace registration. Retry after checking Codex marketplace settings.");
  }
}

async function hasOfficialMarketplace(runner: ProcessRunner): Promise<boolean> {
  const result = await invoke(runner, ["plugin", "marketplace", "list", "--json"],
    LIST_TIMEOUT_MS, "List Codex marketplaces");
  const value = parseJsonObject(result.stdout, "Codex marketplace list");
  if (!Array.isArray(value.marketplaces)
    || value.marketplaces.some((entry) => !isObject(entry) || !isNonEmptyString(entry.name))) {
    throw new PluginDependencyError("The Codex marketplace list has an invalid format.");
  }
  const matches = value.marketplaces.filter((entry) => entry.name === "agent-factory");
  if (!matches.length) return false;
  // CLI list exposes repository identity but may omit the configured ref. Never rewrite it.
  const sources = new Set([
    OFFICIAL_SOURCE,
    `https://github.com/${OFFICIAL_SOURCE}`,
    `https://github.com/${OFFICIAL_SOURCE}.git`,
    `git@github.com:${OFFICIAL_SOURCE}.git`,
    `ssh://git@github.com/${OFFICIAL_SOURCE}.git`
  ]);
  if (matches.length !== 1 || !isObject(matches[0].marketplaceSource)
    || matches[0].marketplaceSource.sourceType !== "git"
    || typeof matches[0].marketplaceSource.source !== "string"
    || !sources.has(matches[0].marketplaceSource.source)) {
    throw new PluginDependencyError("Marketplace name conflict: agent-factory is configured with a different or unconfirmed source. Resolve it in Codex marketplace settings, then Retry. No source was overwritten.");
  }
  return true;
}

export function semanticBase(version: string): string {
  const base = version.split("+", 1)[0]?.trim();
  if (!base) throw new PluginDependencyError("The plugin version is empty or invalid.");
  return base;
}

async function listPlugins(
  runner: ProcessRunner,
  list: "installed" | "available"
): Promise<readonly PluginRecord[]> {
  const includeAvailable = list === "available";
  const result = await invoke(
    runner,
    includeAvailable ? LIST_AVAILABLE_ARGUMENTS : LIST_INSTALLED_ARGUMENTS,
    LIST_TIMEOUT_MS,
    includeAvailable ? "List available Codex plugins" : "List installed Codex plugins",
    includeAvailable ? MAX_AVAILABLE_OUTPUT_BYTES : MAX_OUTPUT_BYTES
  );
  return parsePluginRecords(result.stdout, list);
}

async function invoke(
  runner: ProcessRunner,
  arguments_: readonly string[],
  timeout: number,
  operation: string,
  maxOutputBytes = MAX_OUTPUT_BYTES
): Promise<ProcessResult> {
  try {
    const result = await runner(CODEX_COMMAND, arguments_, { timeout, maxBuffer: maxOutputBytes });
    if (typeof result?.stdout !== "string") {
      throw new PluginDependencyError(`${operation} returned a non-string result.`);
    }
    if (Buffer.byteLength(result.stdout, "utf8") > maxOutputBytes) {
      throw new PluginDependencyError(`${operation} output exceeded the size limit.`);
    }
    return result;
  } catch (error) {
    if (error instanceof PluginDependencyError) throw error;
    if (isErrorWithCode(error, "ENOENT")) {
      throw new PluginDependencyError(
        `${operation} failed. The Codex CLI executable was not found. Check its installation and PATH.`,
        { cause: error }
      );
    }
    if (isErrorWithCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
      throw new PluginDependencyError(`${operation} output exceeded the size limit.`, { cause: error });
    }
    if (isTimedOutProcess(error)) {
      throw new PluginDependencyError(`${operation} timed out. Please try again shortly.`, { cause: error });
    }
    throw new PluginDependencyError(`${operation} failed. Check the Codex CLI installation and execution environment.`, {
      cause: error
    });
  }
}

function parsePluginRecords(
  stdout: string,
  list: "installed" | "available"
): readonly PluginRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new PluginDependencyError("The Codex plugin list is not valid JSON.", { cause: error });
  }
  const records = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value[list])
      ? value[list]
      : isObject(value) && Array.isArray(value.plugins)
        ? value.plugins
        : undefined;
  if (!records) {
    throw new PluginDependencyError(`The Codex plugin list JSON is missing the ${list} array.`);
  }
  return records.map((record, index) => validatePluginRecord(record, index));
}

function validatePluginRecord(value: unknown, index: number): PluginRecord {
  if (!isObject(value)
    || !isNonEmptyString(value.pluginId)
    || !isNonEmptyString(value.name)
    || !isNonEmptyString(value.marketplaceName)
    || !isNonEmptyString(value.version)
    || typeof value.installed !== "boolean"
    || typeof value.enabled !== "boolean") {
    throw new PluginDependencyError(`Codex plugin list record ${index + 1} has an invalid format.`);
  }
  return {
    pluginId: value.pluginId,
    name: value.name,
    marketplaceName: value.marketplaceName,
    version: value.version,
    installed: value.installed,
    enabled: value.enabled
  };
}

function parseJsonObject(stdout: string, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new PluginDependencyError(`${label} is not valid JSON.`, { cause: error });
  }
  if (!isObject(value)) throw new PluginDependencyError(`${label} is not a JSON object.`);
  return value;
}

function hasCompatibleInstalledPlugin(records: readonly PluginRecord[], requiredBase: string): boolean {
  return records.some((record) => record.name === "agent-factory"
    && record.installed
    && record.enabled
    && semanticBase(record.version) === requiredBase);
}

function compareCandidates(left: PluginRecord, right: PluginRecord): number {
  const leftOfficial = left.marketplaceName === "agent-factory" ? 0 : 1;
  const rightOfficial = right.marketplaceName === "agent-factory" ? 0 : 1;
  return leftOfficial - rightOfficial
    || left.marketplaceName.localeCompare(right.marketplaceName)
    || left.pluginId.localeCompare(right.pluginId);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function isTimedOutProcess(error: unknown): boolean {
  return isObject(error) && error.killed === true;
}

export const runProcess: ProcessRunner = (executable, arguments_, options) => new Promise((resolve, reject) => {
  execFile(executable, [...arguments_], {
    env: runtimeEnvironment(),
    // Do not load project-local Codex configuration during dependency installation.
    cwd: homedir(),
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true
  }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});
