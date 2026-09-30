import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const run = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export function providerCliInstallMethod(
  provider: "codex" | "claude", selected: string, npmRoot: string | undefined,
  home: string = homedir(), codexHome: string = process.env.CODEX_HOME || join(home, ".codex")
): "npm" | "claude-native" | "codex-standalone" | undefined {
  const npmPackage = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  if (npmRoot && inside(selected, join(npmRoot, npmPackage))) return "npm";
  if (provider === "claude" && inside(selected, join(home, ".local", "share", "claude", "versions"))) return "claude-native";
  if (provider === "codex" && inside(selected, join(codexHome, "packages", "standalone"))) return "codex-standalone";
  return undefined;
}

function installedVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

async function npmPackageRoot(): Promise<string | undefined> {
  try {
    return (await run(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { timeout: 10_000 })).stdout.trim();
  } catch {
    return undefined;
  }
}

async function downloadOfficialInstaller(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error(`Official Codex installer download failed (${response.status}).`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024) throw new Error("Official Codex installer exceeded the size limit.");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Install a version of the selected CLI, never an Agent Factory plugin. */
export async function installProviderCliVersion(provider: "codex" | "claude", executable: string, version: string): Promise<void> {
  if (!VERSION_PATTERN.test(version)) throw new Error("Invalid CLI version.");
  const selected = await realpath(executable);
  const npmRoot = await npmPackageRoot();
  const npmPackage = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const method = providerCliInstallMethod(provider, selected, npmRoot);
  if (method === "npm") {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", `${npmPackage}@${version}`],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
  } else if (method === "claude-native") {
    await run(executable, ["install", version], { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 });
  } else if (method === "codex-standalone") {
    const scratch = await mkdtemp(join(tmpdir(), "af-codex-cli-"));
    try {
      const windows = process.platform === "win32";
      const script = join(scratch, windows ? "install.ps1" : "install.sh");
      await writeFile(script, await downloadOfficialInstaller(`https://chatgpt.com/codex/${windows ? "install.ps1" : "install.sh"}`), { mode: 0o600 });
      const command = windows ? "powershell.exe" : "sh";
      const args = windows
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Release", version]
        : [script, "--release", version];
      await run(command, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, CODEX_NON_INTERACTIVE: "1" } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else {
    throw new Error(`Cannot select a version for this ${provider} CLI installation. Use its original installer.`);
  }
  const active = (await run(executable, ["--version"], { timeout: 10_000, maxBuffer: 4096 })).stdout;
  if (installedVersion(active) !== version) {
    throw new Error(`The selected ${provider} CLI still reports ${installedVersion(active) ?? "an unknown version"}; expected ${version}.`);
  }
}
