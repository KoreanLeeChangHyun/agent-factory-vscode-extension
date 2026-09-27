import { createServer, type Server, type Socket } from "node:net";
import { createPrivateKey, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID, timingSafeEqual, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SudoChallenge {
  readonly type: "sudo.challenge";
  readonly id: string;
  readonly command: readonly string[];
  readonly publicKey: string;
  readonly cwd: string;
  readonly runId: string;
  readonly agentId: string;
}
export interface SudoReply {
  readonly id: string;
  readonly key?: string;
  readonly iv?: string;
  readonly data?: string;
  readonly cancelled?: boolean;
}
export interface SudoOutput { exitCode: number; stdout: string; stderr: string }
export interface SudoLimits {
  readonly requestMs: number;
  readonly challengeMs: number;
  readonly executionMs: number;
  readonly promptGraceMs: number;
  readonly maxOutputBytes: number;
}
const DEFAULT_LIMITS: SudoLimits = {
  requestMs: 10_000, challengeMs: 5 * 60_000, executionMs: 10 * 60_000, promptGraceMs: 5_000, maxOutputBytes: 8 * 1024 * 1024
};

/** Handoff variables for runtime processes only; never written to the extension host's process.env. */
let handoffEnvironment: Readonly<Record<string, string>> | undefined;
export function sudoHandoffEnvironment(): Readonly<Record<string, string>> {
  return handoffEnvironment ?? {};
}

interface Pending {
  readonly id: string;
  readonly panelId: string;
  readonly resolve: (value: SudoReply) => void;
  readonly challenge: SudoChallenge;
}

/** The extension host is the only process that handles the decrypted secret. */
export class SudoBroker {
  private server?: Server;
  private directory?: string;
  private starting?: Promise<void>;
  private pending?: Pending;
  private busy = false;
  private token?: Buffer;

  public constructor(
    private readonly selectPanel: (runId: string, agentId: string) => { id: string; post: (message: SudoChallenge | { type: "sudo.closed" }) => Promise<unknown>; cwd: string } | undefined,
    private readonly executeCommand: (command: readonly string[], password: string, cwd: string, signal: AbortSignal, limits: SudoLimits) => Promise<SudoOutput> = execute,
    private readonly limits: SudoLimits = DEFAULT_LIMITS
  ) {}

  public async start(helperPath: string): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.listen(helperPath);
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async listen(helperPath: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "agent-factory-sudo-"));
    const socketPath = join(directory, "broker.sock");
    const server = createServer(socket => { void this.handle(socket); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.off("error", reject); resolve(); });
      });
      this.directory = directory;
      this.server = server;
      // Unrelated extension-host children must not inherit the handoff; runtime processes receive it explicitly.
      this.token = randomBytes(32);
      handoffEnvironment = { AGENT_FACTORY_SUDO_SOCKET: socketPath, AGENT_FACTORY_SUDO_HELPER: helperPath,
        AGENT_FACTORY_SUDO_TOKEN: this.token.toString("hex") };
    } catch (error) {
      server.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public respond(panelId: string, reply: SudoReply): void {
    if (!this.pending || this.pending.panelId !== panelId || this.pending.id !== reply.id) return;
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(reply);
  }

  public challengeFor(panelId: string): SudoChallenge | undefined {
    return this.pending?.panelId === panelId ? this.pending.challenge : undefined;
  }

  public cancelPanel(panelId: string): void {
    if (this.pending?.panelId === panelId) this.respond(panelId, { id: this.pending.id, cancelled: true });
  }

  private async handle(socket: Socket): Promise<void> {
    if (this.busy) { socket.end(JSON.stringify({ error: "Another administrator request is pending" }) + "\n"); return; }
    this.busy = true;
    let panel: ReturnType<SudoBroker["selectPanel"]>;
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    let requestTimer: NodeJS.Timeout | undefined;
    let challengeTimer: NodeJS.Timeout | undefined;
    try {
      const request = await new Promise<unknown>((resolve, reject) => {
        requestTimer = setTimeout(() => reject(new Error("Request timed out")), this.limits.requestMs);
        let input = "";
        const onData = (chunk: Buffer) => {
          input += chunk.toString("utf8");
          if (Buffer.byteLength(input) > 1024 * 1024) { reject(new Error("Request metadata is too large")); return; }
          const newline = input.indexOf("\n");
          if (newline >= 0) {
            socket.off("data", onData);
            try { resolve(JSON.parse(input.slice(0, newline))); } catch { reject(new Error("Invalid request")); }
          }
        };
        socket.on("data", onData);
        socket.once("close", () => reject(new Error("Request disconnected")));
        socket.once("error", reject);
      });
      clearTimeout(requestTimer);
      if (!isRequest(request)) throw new Error("Expected a command and arguments");
      if (!this.authorized(request.token)) throw new Error("Administrator request is not authorized");
      panel = this.selectPanel(request.runId, request.agentId);
      if (!panel) throw new Error("No active Main run is available for this request");
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      const id = randomUUID();
      const challenge: SudoChallenge = { type: "sudo.challenge", id, command: request.command, publicKey,
        cwd: panel.cwd, runId: request.runId, agentId: request.agentId };
      const replyPromise = new Promise<SudoReply>(resolve => { this.pending = { id, panelId: panel!.id, resolve, challenge }; });
      let timedOut = false;
      const expiry = new Promise<SudoReply>(resolve => {
        challengeTimer = setTimeout(() => { timedOut = true; resolve({ id, cancelled: true }); }, this.limits.challengeMs);
      });
      await panel.post(challenge);
      const reply = await Promise.race([replyPromise, expiry, new Promise<SudoReply>(resolve => socket.once("close", () => resolve({ id, cancelled: true })))]);
      clearTimeout(challengeTimer);
      if (this.pending?.id === id) this.pending = undefined;
      if (timedOut) throw new Error("Administrator request timed out");
      if (reply.cancelled) throw new Error("Administrator request cancelled");
      if (!reply.key || !reply.iv || !reply.data) throw new Error("Missing encrypted credential");
      const encryptedKey = Buffer.from(reply.key, "base64");
      const aesBytes = privateDecrypt({ key: createPrivateKey(privateKey), oaepHash: "sha256" }, encryptedKey);
      let password = "";
      try {
        const aesKey = await webcrypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, ["decrypt"]);
        const clear = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(reply.iv, "base64") }, aesKey, Buffer.from(reply.data, "base64"));
        password = Buffer.from(clear).toString("utf8");
        if (!password || /[\r\n\0]/.test(password)) throw new Error("A valid password is required");
        const output = await this.executeCommand(request.command, password, panel.cwd, abort.signal, this.limits);
        socket.end(JSON.stringify(output) + "\n");
      } finally {
        aesBytes.fill(0);
        password = "";
      }
    } catch (error) {
      if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
    } finally {
      clearTimeout(requestTimer);
      clearTimeout(challengeTimer);
      this.pending = undefined;
      try { if (panel) await panel.post({ type: "sudo.closed" }); }
      finally { this.busy = false; }
    }
  }

  private authorized(token: string): boolean {
    if (!this.token || !/^[0-9a-f]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token, "hex"), this.token);
  }

  public dispose(): void {
    if (this.pending) this.respond(this.pending.panelId, { id: this.pending.id, cancelled: true });
    this.server?.close();
    this.server = undefined;
    if (this.directory) void rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.token?.fill(0);
    this.token = undefined;
    handoffEnvironment = undefined;
  }
}

function isRequest(value: unknown): value is { command: string[]; runId: string; agentId: string; token: string } {
  if (!value || typeof value !== "object" || !("command" in value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string") return false;
  if (typeof record.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.runId) ||
      typeof record.agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.agentId)) return false;
  const command = record.command;
  return Array.isArray(command) && command.length > 0 &&
    typeof command[0] === "string" && command[0].length > 0 &&
    command.every(arg => typeof arg === "string" && !arg.includes("\0"));
}

/**
 * sudo prompts with a per-run marker; the password is written only after that prompt, so a command that
 * runs without authentication (for example NOPASSWD) never receives it on stdin. A repeated prompt means
 * the password was rejected and ends the command instead of retrying.
 */
function execute(command: readonly string[], password: string, cwd: string, signal: AbortSignal, limits: SudoLimits): Promise<SudoOutput> {
  return new Promise((resolve, reject) => {
    const marker = `[agent-factory-sudo:${randomUUID()}]`;
    const child = spawn("sudo", ["-S", "-k", "-p", marker, "--", ...command], { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, prompts = 0, failure: string | undefined;
    let stderrText = "";
    const stop = (reason: string) => { failure ??= reason; child.kill("SIGTERM"); };
    const endInput = () => { if (!child.stdin.writableEnded) child.stdin.end(); };
    const grace = setTimeout(endInput, limits.promptGraceMs);
    const deadline = setTimeout(() => stop("Administrator command timed out"), limits.executionMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) { stop("Administrator command output is too large"); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      collect(stderr, chunk);
      stderrText += chunk.toString("utf8");
      let index: number;
      while ((index = stderrText.indexOf(marker)) >= 0) {
        stderrText = stderrText.slice(index + marker.length);
        prompts += 1;
        if (prompts > 1) { stop("Administrator password was rejected"); return; }
        clearTimeout(grace);
        if (child.stdin.writableEnded) continue;
        child.stdin.write(password + "\n");
        endInput();
      }
      if (stderrText.length > marker.length) stderrText = stderrText.slice(-marker.length);
    });
    child.stdin.on("error", () => {});
    child.once("error", error => { clearTimeout(grace); clearTimeout(deadline); reject(error); });
    child.once("close", code => {
      clearTimeout(grace);
      clearTimeout(deadline);
      if (failure) { reject(new Error(failure)); return; }
      const clean = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8").replaceAll(marker, "").replaceAll(password, "[redacted]");
      resolve({ exitCode: code ?? 1, stdout: clean(stdout), stderr: clean(stderr) });
    });
  });
}
