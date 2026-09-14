import { execFile } from "node:child_process";
import { runtimeEnvironment } from "./process-environment";

const CODEX_COMMAND = "codex";
const LIST_INSTALLED_ARGUMENTS = ["plugin", "list", "--json"] as const;
const LIST_AVAILABLE_ARGUMENTS = ["plugin", "list", "--available", "--json"] as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
// The repair-only catalog is substantially larger than the installed list, but remains bounded.
const MAX_AVAILABLE_OUTPUT_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 15_000;
const ADD_TIMEOUT_MS = 30_000;

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
  let records = await listPlugins(runner, "installed");
  if (hasCompatibleInstalledPlugin(records, requiredBase)) return;

  const availableRecords = await listPlugins(runner, "available");
  const candidate = availableRecords
    .filter((record) => record.name === "agent-factory" && semanticBase(record.version) === requiredBase)
    .sort(compareCandidates)[0];
  if (!candidate) {
    throw new PluginDependencyError(
      `Agent Factory 플러그인 ${requiredBase} 버전을 설치할 수 없습니다. 공식 marketplace가 구성되어 해당 버전이 제공되는지 확인해 주세요.`
    );
  }

  const addResult = await invoke(
    runner,
    ["plugin", "add", candidate.pluginId, "--json"],
    ADD_TIMEOUT_MS,
    "Agent Factory 플러그인 설치"
  );
  parseJsonObject(addResult.stdout, "Agent Factory 플러그인 설치 결과");

  records = await listPlugins(runner, "installed");
  if (!hasCompatibleInstalledPlugin(records, requiredBase)) {
    throw new PluginDependencyError(
      `Agent Factory 플러그인 ${requiredBase} 설치 후 활성 상태를 확인하지 못했습니다. Codex 플러그인 설정을 확인해 주세요.`
    );
  }
}

export function semanticBase(version: string): string {
  const base = version.split("+", 1)[0]?.trim();
  if (!base) throw new PluginDependencyError("비어 있거나 올바르지 않은 플러그인 버전입니다.");
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
    includeAvailable ? "설치 가능한 Codex 플러그인 목록 조회" : "설치된 Codex 플러그인 목록 조회",
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
      throw new PluginDependencyError(`${operation} 결과가 문자열이 아닙니다.`);
    }
    if (Buffer.byteLength(result.stdout, "utf8") > maxOutputBytes) {
      throw new PluginDependencyError(`${operation} 결과가 허용된 크기를 초과했습니다.`);
    }
    return result;
  } catch (error) {
    if (error instanceof PluginDependencyError) throw error;
    if (isErrorWithCode(error, "ENOENT")) {
      throw new PluginDependencyError(
        `${operation}에 실패했습니다. Codex CLI 실행 파일을 찾을 수 없습니다. 설치 상태와 PATH를 확인해 주세요.`,
        { cause: error }
      );
    }
    if (isErrorWithCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
      throw new PluginDependencyError(`${operation} 결과가 허용된 크기를 초과했습니다.`, { cause: error });
    }
    if (isTimedOutProcess(error)) {
      throw new PluginDependencyError(`${operation} 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.`, { cause: error });
    }
    throw new PluginDependencyError(`${operation}에 실패했습니다. Codex CLI 설치와 실행 환경을 확인해 주세요.`, {
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
    throw new PluginDependencyError("Codex 플러그인 목록이 올바른 JSON이 아닙니다.", { cause: error });
  }
  const records = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value[list])
      ? value[list]
      : isObject(value) && Array.isArray(value.plugins)
        ? value.plugins
        : undefined;
  if (!records) {
    throw new PluginDependencyError(`Codex 플러그인 목록 JSON에 ${list} 배열이 없습니다.`);
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
    throw new PluginDependencyError(`Codex 플러그인 목록의 ${index + 1}번째 레코드 형식이 올바르지 않습니다.`);
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
    throw new PluginDependencyError(`${label}가 올바른 JSON이 아닙니다.`, { cause: error });
  }
  if (!isObject(value)) throw new PluginDependencyError(`${label}가 JSON 객체가 아닙니다.`);
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
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true
  }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});
