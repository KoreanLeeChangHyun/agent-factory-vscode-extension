import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { localize } from "../../common/localization";

export type CodexCliSource = "configured" | "path" | "nvm" | "local";

export interface CodexCliSelection {
  readonly executable: string;
  readonly source: CodexCliSource;
  readonly binDirectory: string;
  readonly nodeVersion?: string;
}

export interface CodexCliResolutionOptions {
  readonly configuredPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

let selectedCodexCli: CodexCliSelection | undefined;

export class CodexCliNotFoundError extends Error {
  // Named so activation can recognize it across separately bundled modules and test doubles.
  public override readonly name = "CodexCliNotFoundError";
}

/** Apply one selection to dependency setup and every subsequently spawned runtime process. */
export function configureCodexCli(selection: CodexCliSelection | undefined): void {
  selectedCodexCli = selection;
}

export function codexExecutable(): string {
  return selectedCodexCli?.executable ?? "codex";
}

/** A configured override is honored only when it is a usable file on this host (settings can sync across hosts). */
async function usableConfiguredPath(configuredPath: string | undefined): Promise<string | undefined> {
  return configuredPath && isAbsolute(configuredPath) && await isExecutableFile(configuredPath) ? configuredPath : undefined;
}

/** Resolve the `codex` command without a shell: a usable override, PATH, stable NVM, then the user-local installation. */
export async function resolveCodexCli(options: CodexCliResolutionOptions = {}): Promise<CodexCliSelection> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredPath = await usableConfiguredPath(options.configuredPath?.trim());
  if (configuredPath) return { executable: configuredPath, source: "configured", binDirectory: dirname(configuredPath) };

  const pathEnvironment = baseEnvironment(environment, platform, homeDirectory);
  const fromPath = await findOnPath(pathEnvironment, platform);
  if (fromPath) return { executable: fromPath, source: "path", binDirectory: dirname(fromPath) };

  if (platform !== "win32") {
    const configuredNvmDirectory = environment.NVM_DIR?.trim();
    const nvmDirectory = configuredNvmDirectory && isAbsolute(configuredNvmDirectory)
      ? configuredNvmDirectory
      : join(homeDirectory, ".nvm");
    const nvm = await findInNvm(nvmDirectory);
    if (nvm) return nvm;
    // Remote/GUI hosts need not inherit the shell's ~/.local/bin PATH entry.
    const binDirectory = join(homeDirectory, ".local", "bin");
    const executable = join(binDirectory, "codex");
    if (await isExecutableFile(executable)) {
      return { executable, source: "local", binDirectory };
    }
  }
  throw new CodexCliNotFoundError(localize("ui.codex.cli.was.not.found.on.the.workspace.extension.host.path.or.in.nvm.install.codex.there.or.set.agentfactory.mainchat.codexpath.then.retry"));
}

let selectedClaudeCli: string | undefined;

/** Optional provider: a usable override, the `claude` command on PATH, then Claude Code's user-local installations. */
export async function resolveClaudeCli(options: CodexCliResolutionOptions = {}): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredPath = await usableConfiguredPath(options.configuredPath?.trim());
  if (configuredPath) return configuredPath;
  const fromPath = await findOnPath(baseEnvironment(environment, platform, homeDirectory), platform, "claude");
  if (fromPath) return fromPath;
  if (platform === "win32") return undefined;
  for (const candidate of [join(homeDirectory, ".local", "bin", "claude"), join(homeDirectory, ".claude", "local", "claude")]) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function configureClaudeCli(executable: string | undefined): void {
  selectedClaudeCli = executable;
}

export function claudeExecutable(): string {
  return selectedClaudeCli ?? "claude";
}

/** GUI hosts may omit package-manager paths; preserve caller order except for the selected CLI bin. */
export function runtimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir()
): NodeJS.ProcessEnv {
  const result = baseEnvironment(environment, platform, homeDirectory);
  if (!selectedCodexCli) return result;
  const key = platform === "win32" && result.PATH === undefined && result.Path !== undefined ? "Path" : "PATH";
  const separator = platform === "win32" ? ";" : delimiter;
  const paths = (result[key] ?? "").split(separator).filter(Boolean);
  const selectedBin = selectedCodexCli.binDirectory;
  const matches = (value: string) => platform === "win32"
    ? value.toLocaleLowerCase() === selectedBin.toLocaleLowerCase()
    : value === selectedBin;
  result[key] = [selectedBin, ...paths.filter(path => !matches(path))].join(separator);
  return result;
}

function baseEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDirectory: string): NodeJS.ProcessEnv {
  if (platform !== "darwin") return { ...environment };
  const paths = environment.PATH === undefined ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] : environment.PATH.split(delimiter);
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", join(homeDirectory, ".local", "bin")]) {
    if (!paths.includes(directory)) paths.push(directory);
  }
  return { ...environment, PATH: paths.join(delimiter) };
}

async function findOnPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, command = "codex"): Promise<string | undefined> {
  const value = platform === "win32" ? environment.PATH ?? environment.Path : environment.PATH;
  const directories = (value ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  // npm's global bin is frequently missing from GUI/remote extension-host PATHs.
  const npmPrefix = environment.npm_config_prefix?.trim();
  if (platform === "win32") {
    if (environment.APPDATA?.trim()) directories.push(join(environment.APPDATA.trim(), "npm"));
    if (npmPrefix) directories.push(npmPrefix);
  } else if (npmPrefix) {
    directories.push(join(npmPrefix, "bin"));
  }
  const names = platform === "win32" ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command] : [command];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (!await isExecutableFile(candidate)) continue;
      if (platform !== "win32" || /\.exe$/i.test(name)) return candidate;
      // Node refuses to spawn .cmd/.bat shims without a shell; use the native binary the npm shim wraps.
      const native = await npmNativeExecutable(directory, command);
      if (native) return native;
    }
  }
  return undefined;
}

/** Native Windows binaries behind npm global shims for `@openai/codex` and `@anthropic-ai/claude-code`. */
async function npmNativeExecutable(shimDirectory: string, command: string): Promise<string | undefined> {
  const modules = join(shimDirectory, "node_modules");
  if (command === "claude") {
    const executable = join(modules, "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return await isExecutableFile(executable) ? executable : undefined;
  }
  if (command !== "codex") return undefined;
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  for (const scope of [join(modules, "@openai", "codex", "node_modules"), modules]) {
    const vendor = join(scope, "@openai", `codex-win32-${architecture}`, "vendor");
    let targets: string[];
    try {
      targets = (await readdir(vendor, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      continue;
    }
    for (const target of targets.sort()) {
      for (const executable of [join(vendor, target, "bin", "codex.exe"), join(vendor, target, "codex", "codex.exe")]) {
        if (await isExecutableFile(executable)) return executable;
      }
    }
  }
  return undefined;
}

async function findInNvm(nvmDirectory: string): Promise<CodexCliSelection | undefined> {
  const versionsDirectory = join(nvmDirectory, "versions", "node");
  let versions: string[];
  try {
    versions = (await readdir(versionsDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && parseNodeVersion(entry.name)?.prerelease === false)
      .map(entry => entry.name)
      .sort(compareNodeVersions);
  } catch {
    return undefined;
  }
  for (const version of versions) {
    const binDirectory = join(versionsDirectory, version, "bin");
    const executable = join(binDirectory, "codex");
    // npm's Codex shim requires the Node binary from the same NVM installation.
    if (await isExecutableFile(executable) && await isExecutableFile(join(binDirectory, "node"))) {
      return { executable, source: "nvm", binDirectory, nodeVersion: version };
    }
  }
  return undefined;
}

function compareNodeVersions(left: string, right: string): number {
  const a = parseNodeVersion(left)!;
  const b = parseNodeVersion(right)!;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return b.numbers[index]! - a.numbers[index]!;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
  return right.localeCompare(left);
}

function parseNodeVersion(value: string): { numbers: readonly number[]; prerelease: boolean } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(value);
  if (!match) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
