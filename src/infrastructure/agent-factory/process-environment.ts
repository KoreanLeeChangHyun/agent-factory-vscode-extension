import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { localize } from "../../common/localization";

export type CodexCliSource = "configured" | "path" | "nvm";

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

/** Apply one selection to dependency setup and every subsequently spawned runtime process. */
export function configureCodexCli(selection: CodexCliSelection | undefined): void {
  selectedCodexCli = selection;
}

export function codexExecutable(): string {
  return selectedCodexCli?.executable ?? "codex";
}

/** Resolve without a shell: explicit absolute path, current PATH, then stable highest NVM Node version. */
export async function resolveCodexCli(options: CodexCliResolutionOptions = {}): Promise<CodexCliSelection> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      throw new Error(localize("ui.the.configured.codex.cli.path.must.be.an.absolute.executable.path.no.shell.arguments.are.allowed.0", configuredPath));
    }
    if (!await isExecutableFile(configuredPath)) {
      throw new Error(localize("ui.the.configured.codex.cli.path.is.not.an.executable.file.0.correct.agentfactory.mainchat.codexpath.then.retry", configuredPath));
    }
    return { executable: configuredPath, source: "configured", binDirectory: dirname(configuredPath) };
  }

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
  }
  throw new Error(localize("ui.codex.cli.was.not.found.on.the.workspace.extension.host.path.or.in.nvm.install.codex.there.or.set.agentfactory.mainchat.codexpath.then.retry"));
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

async function findOnPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  const value = platform === "win32" ? environment.PATH ?? environment.Path : environment.PATH;
  if (!value) return undefined;
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  for (const directory of value.split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isExecutableFile(candidate)) return candidate;
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
