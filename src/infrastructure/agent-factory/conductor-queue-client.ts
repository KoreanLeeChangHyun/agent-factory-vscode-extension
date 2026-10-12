import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** How to start the plugin's conductor queue runtime (conductor_queue.py serve) for one project. */
export interface ConductorQueueCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type ConductorQueueLine =
  | { readonly type: "reply"; readonly id?: number; readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } }
  | { readonly type: "feed"; readonly cursor: number; readonly entries: readonly ConductorFeedEntry[]; readonly emittedAt: number }
  | { readonly type: "role"; readonly role: "starting" | "leader" | "follower" | "disconnected"; readonly at?: string; readonly diagnostic?: string };

export interface ConductorFeedEntry {
  readonly id: number;
  readonly chatId: string;
  readonly kind: "chat" | "state" | "ops";
  readonly key: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
  readonly eventSeq: number;
  readonly eventAt: number;
  readonly appliedAt: number;
}

/**
 * One long-lived runtime process per project. Requests resolve when the runtime replies or
 * the process ends; there is no artificial deadline. The runtime owns every durable state change.
 */
export class ConductorQueueChannel {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(line: ConductorQueueLine) => void>();
  private nextId = 1;
  private buffer = "";
  private diagnostic = "";
  private starting?: Promise<ChildProcessWithoutNullStreams>;
  public role: "starting" | "leader" | "follower" | "disconnected" = "disconnected";

  public constructor(private readonly command: () => Promise<ConductorQueueCommand>, private readonly spawnProcess = spawn) {}

  public onLine(listener: (line: ConductorQueueLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const child = await this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ ...fields, op, id }) + "\n", error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public dispose(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  }

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return Promise.resolve(this.child);
    return this.starting ??= this.start().finally(() => { this.starting = undefined; });
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    const command = await this.command();
    const child = this.spawnProcess(command.executable, [...command.args], { stdio: ["pipe", "pipe", "pipe"], env: command.env });
    this.child = child;
    this.buffer = "";
    this.diagnostic = "";
    this.role = "starting";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    // Diagnostics only: the latest stderr text explains an unexpected exit.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.diagnostic = (this.diagnostic + chunk).slice(-8192); });
    const ended = (code: number | null, error?: Error) => {
      if (this.child === child) this.child = undefined;
      this.role = "disconnected";
      const failure = error ?? new Error(this.diagnostic.trim() || `Conductor queue runtime exited (${code ?? "signal"})`);
      for (const waiter of this.pending.values()) waiter.reject(failure);
      this.pending.clear();
      this.emit({ type: "role", role: "disconnected", diagnostic: failure.message });
    };
    child.on("error", error => ended(null, error));
    child.on("close", code => ended(code));
    return child;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const text = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!text) continue;
      let line: ConductorQueueLine;
      try { line = JSON.parse(text) as ConductorQueueLine; } catch { continue; }
      if (line.type === "reply" && typeof line.id === "number") {
        const waiter = this.pending.get(line.id);
        this.pending.delete(line.id);
        if (waiter) {
          if (line.ok) waiter.resolve(line.result);
          else waiter.reject(Object.assign(new Error(line.error?.message ?? "Conductor queue request failed"), { code: line.error?.code }));
        }
        continue;
      }
      if (line.type === "role") this.role = line.role;
      this.emit(line);
    }
  }

  private emit(line: ConductorQueueLine): void {
    for (const listener of this.listeners) {
      try { listener(line); } catch { /* A failing listener does not block the others. */ }
    }
  }
}
