import { execFile } from "node:child_process";
import type { ProviderAuthMethod, ProviderAuthStatus, ProviderId } from "../../common/types/provider";
import { runtimeEnvironment } from "./process-environment";

/**
 * Each provider CLI's own authentication commands, taken from its installed help:
 * `codex login status` / `codex login` (codex-cli 0.160.0) and
 * `claude auth status --json` / `claude auth login` (Claude Code 2.1.295).
 * Antigravity (agy 1.3.3) has no status or login subcommand; its interactive session shows the
 * sign-in screen when signed out and offers `/login`, so its state is never inferred here.
 */
export const PROVIDER_AUTH_COMMANDS: Readonly<Record<ProviderId, { readonly status?: readonly string[]; readonly login: readonly string[] }>> = {
  codex: { status: ["login", "status"], login: ["login"] },
  claude: { status: ["auth", "status", "--json"], login: ["auth", "login"] },
  antigravity: { login: [] }
};

export const AUTH_STATUS_TIMEOUT_MS = 15_000;

export interface AuthProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly error?: boolean;
}

export type AuthProbe = (executable: string, args: readonly string[]) => Promise<AuthProbeResult>;

/** `codex login status` prints one line to stderr and exits 0 only when signed in. */
export function parseCodexAuthStatus(result: AuthProbeResult): Omit<ProviderAuthStatus, "path"> {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0 && /^Logged in using an API key\b/m.test(text)) return { state: "signed-in", method: "api-key" };
  if (result.exitCode === 0 && /^Logged in using ChatGPT\b/m.test(text)) return { state: "signed-in", method: "account" };
  if (result.exitCode === 0 && /^Logged in\b/m.test(text)) return { state: "signed-in" };
  if (result.exitCode === 1 && /^Not logged in\b/m.test(text)) return { state: "signed-out" };
  return { state: "unknown", reason: "error" };
}

/** `claude auth status --json` reports `loggedIn` and `authMethod`, exiting 1 when signed out. */
export function parseClaudeAuthStatus(result: AuthProbeResult): Omit<ProviderAuthStatus, "path"> {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { state: "unknown", reason: "error" };
  }
  if (!value || typeof value !== "object") return { state: "unknown", reason: "error" };
  const { loggedIn, authMethod } = value as { loggedIn?: unknown; authMethod?: unknown };
  if (loggedIn === true && result.exitCode === 0) {
    const method: ProviderAuthMethod | undefined = authMethod === "api_key" ? "api-key"
      : typeof authMethod === "string" && authMethod !== "none" ? "account" : undefined;
    return { state: "signed-in", ...(method ? { method } : {}) };
  }
  if (loggedIn === false) return { state: "signed-out" };
  return { state: "unknown", reason: "error" };
}

const PARSERS: Readonly<Record<ProviderId, ((result: AuthProbeResult) => Omit<ProviderAuthStatus, "path">) | undefined>> = {
  codex: parseCodexAuthStatus,
  claude: parseClaudeAuthStatus,
  antigravity: undefined
};

/** Non-interactive status command run with the Work runtime environment; output stays in this process. */
export const authProbe = (timeout = AUTH_STATUS_TIMEOUT_MS): AuthProbe => (executable, args) => new Promise(resolve => {
  const invocation = cliInvocation(executable, args);
  if (!invocation) { resolve({ exitCode: null, stdout: "", stderr: "", error: true }); return; }
  const child = execFile(invocation.file, typeof invocation.args === "string" ? [invocation.args] : [...invocation.args], {
    env: { ...runtimeEnvironment(), NO_COLOR: "1" }, timeout, windowsHide: true,
    windowsVerbatimArguments: typeof invocation.args === "string", maxBuffer: 256 * 1024, encoding: "utf8"
  }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
    if (!failure) { resolve({ exitCode: 0, stdout, stderr }); return; }
    if (typeof failure.code === "number") { resolve({ exitCode: failure.code, stdout, stderr }); return; }
    const timedOut = failure.code === undefined || failure.code === null ? Boolean(failure.killed || failure.signal) : false;
    resolve({ exitCode: null, stdout: "", stderr: "", ...(timedOut ? { timedOut: true } : { error: true }) });
  });
  child.stdin?.end();
});

export const runAuthProbe = authProbe();

/**
 * Ask the detected CLI whether it is signed in. Credentials are never read here: only the CLI's
 * own status command decides, and anything it cannot answer clearly is reported as unknown.
 */
export async function probeProviderAuth(id: ProviderId, executable: string | undefined, probe: AuthProbe = runAuthProbe): Promise<ProviderAuthStatus> {
  if (!executable) return { state: "missing" };
  const parse = PARSERS[id];
  const args = PROVIDER_AUTH_COMMANDS[id].status;
  if (!parse || !args) return { state: "unknown", reason: "unsupported", path: executable };
  let result: AuthProbeResult;
  try {
    result = await probe(executable, args);
  } catch {
    return { state: "unknown", reason: "error", path: executable };
  }
  if (result.timedOut) return { state: "unknown", reason: "timeout", path: executable };
  if (result.error) return { state: "unknown", reason: "error", path: executable };
  return { ...parse(result), path: executable };
}

export interface CliInvocation {
  readonly file: string;
  /** An array is passed to the process unchanged; a string is a raw Windows command line. */
  readonly args: readonly string[] | string;
}

/**
 * Run the CLI directly so the executable path and arguments never pass through a shell. Windows
 * batch shims need cmd.exe, whose command line is quoted here; a path cmd cannot quote safely
 * (a quote, `%` expansion or a line break) is refused instead of being guessed at.
 */
export function cliInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec
): CliInvocation | undefined {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) return { file: executable, args: [...args] };
  if (/["%\r\n]/.test(executable)) return undefined;
  return { file: comSpec?.trim() || "cmd.exe", args: `/d /s /c ""${executable}"${args.map(arg => " " + arg).join("")}"` };
}

/** The terminal process that starts the provider's own sign-in flow. */
export function loginTerminalLaunch(
  id: ProviderId,
  executable: string,
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec
): CliInvocation | undefined {
  return cliInvocation(executable, PROVIDER_AUTH_COMMANDS[id].login, platform, comSpec);
}
