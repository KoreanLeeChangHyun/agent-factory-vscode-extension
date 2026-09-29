import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { runtimeEnvironment } from "./process-environment";

// One owner per installed runtime and Extension Host. Its stdin closes on host
// exit, causing the runtime to stop all retained, independently contained workers.
const owners = new Set<ReturnType<typeof spawn>>();
export function disposeCodexConnections(): void {
  for (const owner of owners) owner.stdin?.end();
  hosts.clear();
}

const hosts = new Map<string, Promise<string | undefined>>();
export async function codexConnectionEnvironment(
  python: string, execPath: string, environment: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const transport = join(dirname(execPath), "..", "runtime", "adapters", "codex", "transport.py");
  const key = `${python}\0${transport}`;
  let pending = hosts.get(key);
  if (!pending) {
    pending = startHost(python, transport, environment, () => hosts.delete(key));
    hosts.set(key, pending);
  }
  const endpoint = await pending;
  return endpoint ? { ...environment, AGENT_FACTORY_CODEX_POOL: endpoint } : environment;
}

async function startHost(
  python: string, transport: string, environment: NodeJS.ProcessEnv, invalidate: () => void
): Promise<string | undefined> {
  // Old installed plugins retain their existing per-run behavior.
  const source = await readFile(transport, "utf8").catch(() => "");
  if (!source.includes("def connection_host():")) return undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [transport, "--connection-host"], {
      stdio: ["pipe", "pipe", "ignore"], env: runtimeEnvironment(environment)
    });
    owners.add(child);
    let ready = false;
    const lines = createInterface({ input: child.stdout });
    child.once("error", error => { invalidate(); reject(error); });
    child.once("exit", () => {
      owners.delete(child);
      invalidate();
      lines.close();
      if (!ready) reject(new Error("Codex connection host exited before startup"));
    });
    lines.once("line", line => {
      try {
        const endpoint = JSON.parse(line);
        if (!Number.isInteger(endpoint.port) || typeof endpoint.token !== "string") {
          throw new Error("Invalid Codex connection host endpoint");
        }
        ready = true;
        resolve(JSON.stringify(endpoint));
      } catch (error) {
        child.stdin.end();
        reject(error);
      }
    });
  });
}
