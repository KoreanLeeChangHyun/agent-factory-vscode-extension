import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { localize } from "../../common/localization";

export type CodexCliSource = "configured" | "path" | "shell" | "nvm" | "local";

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
  /**
   * PATH entries a newly opened terminal would have (login shell on POSIX, registry on Windows).
   * Defaults to probing the real host only when `environment` is the live process environment.
   */
  readonly terminalPath?: () => Promise<readonly string[]>;
  /** Confirms that a candidate starts; defaults to running `<cli> --version` without a shell. */
  readonly probe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<boolean>;
}

let selectedCodexCli: CodexCliSelection | undefined;
let hostTerminalPath: readonly string[] | undefined;

/** Windows Python installers provide `python`; `python3` is often only the Store alias stub. */
export function defaultPythonCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "python" : "python3";
}

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

/**
 * Find the `codex` command a terminal on this extension host would run. Works identically on
 * Windows, macOS, Linux, WSL, SSH and container hosts; a configured path is only an override.
 */
export async function resolveCodexCli(options: CodexCliResolutionOptions = {}): Promise<CodexCliSelection> {
  const selection = await resolveCli("codex", options);
  if (selection) return selection;
  throw new CodexCliNotFoundError(localize("ui.codex.cli.was.not.found.on.the.workspace.extension.host.path.or.in.nvm.install.codex.there.or.set.agentfactory.mainchat.codexpath.then.retry"));
}

let selectedClaudeCli: string | undefined;

/** Optional provider resolved exactly like Codex: the `claude` command a terminal on this host would run. */
export async function resolveClaudeCli(options: CodexCliResolutionOptions = {}): Promise<string | undefined> {
  return (await resolveCli("claude", options))?.executable;
}

export function configureClaudeCli(executable: string | undefined): void {
  selectedClaudeCli = executable;
}

export function claudeExecutable(): string {
  return selectedClaudeCli ?? "claude";
}

let selectedAntigravityCli: string | undefined;

export function configureAntigravityCli(executable: string | undefined): void {
  selectedAntigravityCli = executable;
}

export function antigravityExecutable(): string {
  return selectedAntigravityCli ?? "agy";
}

export type ProviderCommand = "codex" | "claude" | "agy";

/** One CLI resolved like Codex; undefined when this host has none. */
export function resolveProviderCli(command: ProviderCommand, options: CodexCliResolutionOptions = {}): Promise<CodexCliSelection | undefined> {
  return resolveCli(command, options);
}

/** The live host's terminal PATH, so several CLI lookups can share one login-shell probe. */
export function probeTerminalPath(): Promise<readonly string[]> {
  return terminalPathOf(process.platform, process.env);
}

interface Candidate extends CodexCliSelection {}

async function resolveCli(command: ProviderCommand, options: CodexCliResolutionOptions): Promise<CodexCliSelection | undefined> {
  const live = options.environment === undefined;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const windows = platform === "win32";
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate | undefined) => {
    if (!candidate) return;
    const key = windows ? candidate.executable.toLocaleLowerCase() : candidate.executable;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  };
  const addDirectories = async (directories: readonly string[], source: CodexCliSource) => {
    for (const directory of orderForHost(directories, platform, environment)) {
      add(await findInDirectory(directory, command, platform, source));
    }
  };

  const configured = options.configuredPath?.trim();
  if (configured && isAbsolute(configured) && await isExecutableFile(configured)) {
    add(windows ? await windowsNative(configured, command) : { executable: configured, source: "configured", binDirectory: dirname(configured) });
    if (candidates[0]) candidates[0] = { ...candidates[0], source: "configured" };
  }
  await addDirectories(splitPath(baseEnvironment(environment, platform, homeDirectory), platform), "path");
  const terminal = options.terminalPath ?? (live ? () => terminalPathOf(platform, environment) : undefined);
  if (terminal) {
    const entries = await terminal().catch(() => [] as readonly string[]);
    if (live) hostTerminalPath = entries;
    await addDirectories(entries, "shell");
  }
  if (!windows) add(await findInNodeVersions(command, environment, homeDirectory));
  await addDirectories(knownDirectories(platform, environment, homeDirectory), "local");
  if (windows) add(await findInWingetNode(command, environment, homeDirectory));

  const probe = options.probe ?? probeVersion;
  for (const candidate of candidates) {
    if (await probe(candidate.executable, probeEnvironment(candidate, environment, platform, homeDirectory))) return candidate;
  }
  // A failed probe must not hide the only installation; its own error is more useful at use time.
  return candidates[0];
}

function splitPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const value = platform === "win32" ? environment.PATH ?? environment.Path : environment.PATH;
  return (value ?? "").split(platform === "win32" ? ";" : delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/** WSL appends Windows PATH entries (/mnt/c/...); a Windows CLI there cannot drive the Linux workspace. */
function orderForHost(directories: readonly string[], platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): readonly string[] {
  if (platform !== "linux" || !(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP)) return directories;
  const foreign = (directory: string) => /^\/mnt\/[a-z]\//i.test(directory);
  return [...directories.filter(directory => !foreign(directory)), ...directories.filter(foreign)];
}

async function findInDirectory(directory: string, command: string, platform: NodeJS.Platform, source: CodexCliSource): Promise<Candidate | undefined> {
  if (!isAbsolute(directory)) return undefined;
  if (platform !== "win32") {
    const executable = join(directory, command);
    return await isExecutableFile(executable) ? { executable, source, binDirectory: directory } : undefined;
  }
  for (const name of [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.ps1`, command]) {
    const candidate = join(directory, name);
    if (!await isExecutableFile(candidate)) continue;
    const native = await windowsNative(candidate, command);
    if (native) return { ...native, source };
  }
  return undefined;
}

/**
 * Node cannot spawn .cmd/.bat/.ps1 shims without a shell, so npm, pnpm, yarn and nvm-windows shims
 * are mapped to the native executable their package ships.
 */
async function windowsNative(path: string, command: string): Promise<Candidate | undefined> {
  if (/\.exe$/i.test(path)) return { executable: path, source: "path", binDirectory: dirname(path) };
  // Antigravity ships a native executable; its shims have no npm package to map.
  if (command === "agy") return undefined;
  const packageName = command === "claude" ? ["@anthropic-ai", "claude-code"] : ["@openai", "codex"];
  const roots = new Set<string>([join(dirname(path), "node_modules", ...packageName)]);
  try {
    const shim = await readFile(path, "utf8");
    // npm/pnpm/yarn shims reference the package relative to their own directory.
    for (const match of shim.matchAll(/(?:%~?dp0%?|\$basedir|\$PSScriptRoot)[\\/]+([^"'\s]+?\.(?:js|cjs|mjs|exe))/gi)) {
      const target = resolve(dirname(path), match[1]!.replace(/[\\/]+/g, sep));
      if (/\.exe$/i.test(target) && await isExecutableFile(target)) return { executable: target, source: "path", binDirectory: dirname(target) };
      const marker = ["node_modules", ...packageName].join(sep);
      const index = target.toLocaleLowerCase().lastIndexOf(marker.toLocaleLowerCase());
      if (index >= 0) roots.add(target.slice(0, index + marker.length));
    }
  } catch {
    // Unreadable shim: the conventional npm layout below still applies.
  }
  for (const root of roots) {
    const executable = command === "claude" ? await claudeInPackage(root) : await codexInPackage(root);
    if (executable) return { executable, source: "path", binDirectory: dirname(executable) };
  }
  return undefined;
}

async function claudeInPackage(root: string): Promise<string | undefined> {
  return findFileBelow([root, ...await siblingPackages(root, "claude-code-win32-")], "claude.exe");
}

/** Search the package, its nested and hoisted per-platform packages; layouts change between releases. */
async function codexInPackage(root: string): Promise<string | undefined> {
  return findFileBelow([root, ...await siblingPackages(root, "codex-win32-")], "codex.exe");
}

/** Per-platform packages hoisted next to the main package (e.g. `@openai/codex-win32-x64`). */
async function siblingPackages(root: string, prefix: string): Promise<string[]> {
  try {
    const preferred = process.arch === "arm64" ? "arm64" : "x64";
    return (await readdir(dirname(root), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
      .map(entry => entry.name)
      .sort((left, right) => Number(!left.includes(preferred)) - Number(!right.includes(preferred)) || left.localeCompare(right))
      .map(name => join(dirname(root), name));
  } catch {
    return [];
  }
}

/** Bounded breadth-first search; prefers the host architecture when a package ships several binaries. */
async function findFileBelow(roots: readonly string[], fileName: string, maxDepth = 8): Promise<string | undefined> {
  const machine = process.arch === "arm64" ? /aarch64|arm64/i : /x86_64|x64|amd64/i;
  const found: string[] = [];
  let level = roots.map(root => ({ directory: root, depth: 0 }));
  const visited = new Set<string>();
  while (level.length && !found.length) {
    const next: typeof level = [];
    for (const { directory, depth } of level) {
      if (visited.has(directory)) continue;
      visited.add(directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name.toLocaleLowerCase() === fileName && await isExecutableFile(path)) found.push(path);
        else if (entry.isDirectory() && depth < maxDepth && entry.name !== ".bin") next.push({ directory: path, depth: depth + 1 });
      }
    }
    level = next;
  }
  return found.sort((left, right) => Number(!machine.test(left)) - Number(!machine.test(right)) || left.localeCompare(right))[0];
}

/** Install locations that are often absent from GUI, SSH, WSL and container extension-host PATHs. */
function knownDirectories(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const value = (name: string) => environment[name]?.trim() || undefined;
  const directories: Array<string | undefined> = [];
  if (platform === "win32") {
    const profile = value("USERPROFILE") ?? homeDirectory;
    const local = value("LOCALAPPDATA") ?? join(profile, "AppData", "Local");
    const roaming = value("APPDATA") ?? join(profile, "AppData", "Roaming");
    directories.push(
      join(profile, ".local", "bin"), // Claude Code native installer
      join(roaming, "npm"), value("npm_config_prefix"), value("PNPM_HOME"), join(local, "pnpm"),
      value("VOLTA_HOME") && join(value("VOLTA_HOME")!, "bin"), join(local, "Volta", "bin"),
      value("NVM_SYMLINK"), value("ProgramFiles") && join(value("ProgramFiles")!, "nodejs"),
      join(profile, "scoop", "shims"), join(local, "Microsoft", "WinGet", "Links"),
      join(profile, ".bun", "bin"), join(profile, ".cargo", "bin"), join(local, "Programs", "codex"));
    return directories.filter((directory): directory is string => Boolean(directory));
  }
  directories.push(
    join(homeDirectory, ".local", "bin"), join(homeDirectory, ".claude", "local"),
    value("npm_config_prefix") && join(value("npm_config_prefix")!, "bin"), join(homeDirectory, ".npm-global", "bin"),
    value("PNPM_HOME"), join(homeDirectory, ".local", "share", "pnpm"), join(homeDirectory, "Library", "pnpm"),
    join(value("VOLTA_HOME") ?? join(homeDirectory, ".volta"), "bin"), join(value("BUN_INSTALL") ?? join(homeDirectory, ".bun"), "bin"),
    join(homeDirectory, ".asdf", "shims"), join(homeDirectory, ".local", "share", "mise", "shims"), join(homeDirectory, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/snap/bin");
  return directories.filter((directory): directory is string => Boolean(directory));
}

/** nvm and fnm keep one bin directory per Node version; the npm shim needs that version's node. */
async function findInNodeVersions(command: string, environment: NodeJS.ProcessEnv, homeDirectory: string): Promise<Candidate | undefined> {
  const configuredNvm = environment.NVM_DIR?.trim();
  const nvm = await findInVersionDirectory(join(configuredNvm && isAbsolute(configuredNvm) ? configuredNvm : join(homeDirectory, ".nvm"), "versions", "node"), [], command);
  if (nvm) return nvm;
  const fnmRoots = [environment.FNM_DIR?.trim(), join(homeDirectory, ".local", "share", "fnm"),
    join(homeDirectory, "Library", "Application Support", "fnm"), join(homeDirectory, ".fnm")];
  for (const root of fnmRoots) {
    if (!root || !isAbsolute(root)) continue;
    const found = await findInVersionDirectory(join(root, "node-versions"), ["installation"], command);
    if (found) return found;
  }
  return undefined;
}

async function findInVersionDirectory(versionsDirectory: string, prefix: readonly string[], command: string): Promise<Candidate | undefined> {
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
    const binDirectory = join(versionsDirectory, version, ...prefix, "bin");
    const executable = join(binDirectory, command);
    if (await isExecutableFile(executable) && await isExecutableFile(join(binDirectory, "node"))) {
      return { executable, source: "nvm", binDirectory, nodeVersion: version };
    }
  }
  return undefined;
}

/** WinGet's Node.js packages install npm globals next to node.exe inside the package directory. */
async function findInWingetNode(command: string, environment: NodeJS.ProcessEnv, homeDirectory: string): Promise<Candidate | undefined> {
  const local = environment.LOCALAPPDATA?.trim() || join(environment.USERPROFILE?.trim() || homeDirectory, "AppData", "Local");
  const packages = join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of await readdir(packages, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^OpenJS\.NodeJS/i.test(entry.name)) continue;
      for (const inner of await readdir(join(packages, entry.name), { withFileTypes: true })) {
        if (!inner.isDirectory()) continue;
        const found = await findInDirectory(join(packages, entry.name, inner.name), command, "win32", "local");
        if (found) return found;
      }
    }
  } catch {
    // WinGet is optional.
  }
  return undefined;
}

/** The PATH a new terminal would get, including entries added after VS Code started. */
async function terminalPathOf(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): Promise<readonly string[]> {
  if (platform === "win32") {
    const entries: string[] = [];
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      const output = await run("reg", ["query", key, "/v", "Path"], environment, 3000).catch(() => "");
      const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
      if (match) entries.push(...match[1]!.split(";").map(entry => expandWindows(entry.trim(), environment)).filter(Boolean));
    }
    return entries;
  }
  const shell = environment.SHELL?.trim() || safeUserShell() || "/bin/sh";
  // Interactive login shells load nvm, fnm, volta, asdf, mise, Homebrew and custom npm prefixes.
  const output = await run(shell, ["-ilc", "echo __AF_ENV_START__; env; echo __AF_ENV_END__"], environment, 5000);
  const body = output.slice(output.indexOf("__AF_ENV_START__"), output.lastIndexOf("__AF_ENV_END__"));
  const line = body.split("\n").find(entry => entry.startsWith("PATH="));
  return line ? line.slice(5).split(":").filter(Boolean) : [];
}

function safeUserShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function expandWindows(value: string, environment: NodeJS.ProcessEnv): string {
  const lookup = new Map(Object.entries(environment).map(([key, entry]) => [key.toLocaleLowerCase(), entry ?? ""]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => lookup.get(name.toLocaleLowerCase()) ?? whole);
}

function run(file: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { env: environment, timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolvePromise(stdout));
  });
}

function probeEnvironment(candidate: Candidate, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDirectory: string): NodeJS.ProcessEnv {
  const result = baseEnvironment(environment, platform, homeDirectory);
  const key = platform === "win32" && result.PATH === undefined && result.Path !== undefined ? "Path" : "PATH";
  const separator = platform === "win32" ? ";" : delimiter;
  result[key] = [candidate.binDirectory, result[key] ?? "", ...(hostTerminalPath ?? [])].filter(Boolean).join(separator);
  return result;
}

async function probeVersion(executable: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await run(executable, ["--version"], environment, 15000);
    return true;
  } catch {
    return false;
  }
}

/** GUI hosts may omit package-manager paths; preserve caller order except for the selected CLI bin. */
export function runtimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir()
): NodeJS.ProcessEnv {
  const result = baseEnvironment(environment, platform, homeDirectory);
  const key = platform === "win32" && result.PATH === undefined && result.Path !== undefined ? "Path" : "PATH";
  const separator = platform === "win32" ? ";" : delimiter;
  const same = (left: string, right: string) => platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
  // Children (Codex's Node shim, Claude's tools) need the same PATH a terminal would have.
  if (hostTerminalPath?.length) {
    const current = (result[key] ?? "").split(separator).filter(Boolean);
    result[key] = [...current, ...hostTerminalPath.filter(entry => !current.some(existing => same(existing, entry)))].join(separator);
  }
  if (!selectedCodexCli) return result;
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
