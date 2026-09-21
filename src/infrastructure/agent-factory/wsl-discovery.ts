import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { win32 } from "node:path";

export interface WslWorkspace {
  readonly distribution: string;
  readonly path: string;
}

export type WslRunner = (executable: string, args: readonly string[], timeout: number) => Promise<Buffer>;

const run: WslRunner = (executable, args, timeout) => new Promise((resolve, reject) => {
  const child = execFile(executable, [...args], {
    cwd: homedir(), timeout, maxBuffer: 65536, encoding: "buffer", windowsHide: true
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin?.end();
});

// Fixed script only: neither project contents nor interactive shell profiles are executed.
// Match the Linux resolver's PATH, stable NVM and user-local discovery sources.
const probe = `
found=
candidate=$(command -v codex 2>/dev/null)
case "$candidate" in /*) if [ -f "$candidate" ] && [ -x "$candidate" ]; then found=1; fi ;; esac
if [ -z "$found" ]; then
  nvmRoot="$NVM_DIR"
  [ -n "$nvmRoot" ] || nvmRoot="$HOME/.nvm"
  for bin in "$nvmRoot"/versions/node/*/bin; do
    case "$bin" in */v*-*/bin) continue ;; esac
    if [ -f "$bin/codex" ] && [ -x "$bin/codex" ] && [ -x "$bin/node" ]; then found=1; break; fi
  done
fi
if [ -z "$found" ] && [ -f "$HOME/.local/bin/codex" ] && [ -x "$HOME/.local/bin/codex" ]; then found=1; fi
[ -n "$found" ] || exit 1
target=$(wslpath -a -u "$1") || exit 1
[ -d "$target" ] || exit 1
printf 'AGENT_FACTORY_WSL:%s\\n' "$target"
`;

/** Discover a usable distro and its actual mount mapping; never assume /mnt/c. */
export async function discoverWslWorkspace(
  windowsPath: string,
  runner: WslRunner = run,
  environment: NodeJS.ProcessEnv = process.env
): Promise<WslWorkspace | undefined> {
  if (!/^[a-z]:[\\/]/i.test(windowsPath) || /[\r\n\0]/.test(windowsPath)) return undefined;
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  const executable = win32.join(systemRoot, "System32", "wsl.exe");
  let output: Buffer;
  try { output = await runner(executable, ["--list", "--quiet"], 5000); }
  catch { return undefined; }
  // wsl.exe --list emits UTF-16LE on Windows; probe output is Linux UTF-8.
  const list = output.toString(output.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
  const distributions = [...new Set(list.split(/\r?\n/).map(value => value.trim()))]
    .filter(value => /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !/^docker-desktop(?:-data)?$/i.test(value));
  // Bound startup latency even when distributions cannot start.
  for (const distribution of distributions.slice(0, 8)) {
    try {
      const result = await runner(executable,
        ["--distribution", distribution, "--cd", "~", "--exec", "/bin/sh", "-c", probe, "agent-factory-probe", windowsPath], 5000);
      const match = /^AGENT_FACTORY_WSL:(\/[^\r\n\0]+)\r?$/m.exec(result.toString("utf8"));
      if (match) return { distribution, path: match[1]! };
    } catch { /* Try another installed distribution after a failed or timed-out probe. */ }
  }
  return undefined;
}
