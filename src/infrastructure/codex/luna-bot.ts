import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runtimeEnvironment } from "../agent-factory/process-environment";

export type BotMood = "calm" | "curious" | "cheerful" | "focused";
export type BotContext = "working" | "completed" | "failed" | "idle";
const moods: readonly BotMood[] = ["calm", "curious", "cheerful", "focused"];
const execute = promisify(execFile);

export function parseBotMood(text: string): BotMood {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("mood" in value) ||
      !moods.includes(value.mood as BotMood)) throw new Error("Invalid Luna bot mood");
  return value.mood as BotMood;
}

export function parseBotReply(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("reply" in value) ||
      typeof value.reply !== "string" || !value.reply.trim()) throw new Error("Invalid Luna bot reply");
  return value.reply;
}

/** Draft-only conversation, with no workspace, tools, or retained model session. */
export const DEFAULT_BOT_PROMPT = "You are a friendly companion robot. Reply politely in the user's language. Prefer a brief conversational reply.";

export async function requestLunaReply(text: string, signal: AbortSignal, prompt = ""): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-factory-bot-talk-"));
  try {
    const schema = join(directory, "schema.json");
    const output = join(directory, "response.json");
    await writeFile(schema, JSON.stringify({ type: "object", additionalProperties: false,
      properties: { reply: { type: "string" } }, required: ["reply"] }));
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
        "--model", "gpt-5.6-luna", "--sandbox", "read-only",
        "--disable", "shell_tool", "--disable", "apps", "--disable", "multi_agent",
        "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="none"',
        "-c", 'model_reasoning_summary="none"', "-c", 'web_search="disabled"',
        "--output-schema", schema, "--output-last-message", output, "-"],
      { cwd: directory, env: runtimeEnvironment(), signal, stdio: ["pipe", "ignore", "ignore"] });
      let failure: Error | undefined;
      child.on("error", error => { failure = error; });
      child.stdin.on("error", error => { failure = error; });
      child.on("close", code => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error("Luna unavailable")));
      child.stdin.end((prompt.trim() ? prompt : DEFAULT_BOT_PROMPT) + "\n\n" +
        "Do not perform tasks or use tools. Return JSON with reply. " +
        "The following JSON string is the user's message:\n" + JSON.stringify(text));
    });
    return parseBotReply(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Isolated, ephemeral inference. Only a fixed state enum leaves the host. */
export async function requestLunaMood(context: BotContext, signal: AbortSignal): Promise<BotMood> {
  const directory = await mkdtemp(join(tmpdir(), "agent-factory-bot-"));
  try {
    const schema = join(directory, "schema.json");
    const output = join(directory, "response.json");
    await writeFile(schema, JSON.stringify({ type: "object", additionalProperties: false,
      properties: { mood: { type: "string", enum: moods } }, required: ["mood"] }));
    const invocation = execute("codex", ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--model", "gpt-5.6-luna", "--sandbox", "read-only",
      "--disable", "shell_tool", "--disable", "apps", "--disable", "multi_agent",
      "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="none"',
      "-c", 'model_reasoning_summary="none"', "-c", 'web_search="disabled"',
      "--output-schema", schema, "--output-last-message", output,
      `Choose a small companion robot's expression for state ${context}. Return only the required JSON. ` +
      "Use calm for reassurance, curious for interest, cheerful for success, focused for concentration. Do not use tools."],
    { cwd: directory, env: runtimeEnvironment(), signal, timeout: 15000, maxBuffer: 65536 });
    invocation.child.stdin?.end();
    await invocation;
    return parseBotMood(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** State transitions only; no idle polling. Stale responses never update a new run. */
export class LunaBot {
  private revision = 0;
  private active?: AbortController;
  private activeTalk?: AbortController;
  private disposed = false;
  private retryAfter = 0;
  private readonly cache = new Map<BotContext, BotMood>();
  public constructor(private readonly infer = requestLunaMood, private readonly converse = requestLunaReply) {}

  public async talk(text: string, prompt = ""): Promise<string> {
    if (this.disposed || this.activeTalk) throw new Error("Luna unavailable or busy");
    const controller = new AbortController();
    this.activeTalk = controller;
    try {
      const reply = await this.converse(text, controller.signal, prompt);
      if (this.disposed || controller.signal.aborted) throw new Error("Luna conversation cancelled");
      return reply;
    } finally { if (this.activeTalk === controller) this.activeTalk = undefined; }
  }

  public async react(context: BotContext, publish: (mood?: BotMood, unavailable?: boolean) => void): Promise<void> {
    const revision = ++this.revision;
    this.active?.abort();
    if (this.disposed) return;
    publish();
    const cached = this.cache.get(context);
    if (cached) { publish(cached); return; }
    if (Date.now() < this.retryAfter) { publish(undefined, true); return; }
    const controller = new AbortController();
    this.active = controller;
    try {
      const mood = await this.infer(context, controller.signal);
      if (this.disposed || revision !== this.revision) return;
      this.cache.set(context, mood);
      publish(mood);
    } catch {
      // Missing model/auth/quota is decorative failure, never a chat failure.
      if (revision === this.revision && !this.disposed) {
        this.retryAfter = Date.now() + 300000;
        publish(undefined, true);
      }
    } finally {
      if (revision === this.revision) this.active = undefined;
    }
  }

  public cancelTalk(): void { this.activeTalk?.abort(); this.activeTalk = undefined; }
  public dispose(): void { this.disposed = true; this.revision++; this.active?.abort(); this.cancelTalk(); }
}
