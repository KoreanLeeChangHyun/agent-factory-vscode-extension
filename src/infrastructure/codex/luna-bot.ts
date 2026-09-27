import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeExecutable, codexExecutable, runtimeEnvironment } from "../agent-factory/process-environment";

export type BotMood = "calm" | "curious" | "cheerful" | "focused";
export type BotContext = "working" | "completed" | "failed" | "idle";
const moods: readonly BotMood[] = ["calm", "curious", "cheerful", "focused"];
const execute = promisify(execFile);

const CLAUDE_BOT_MODEL = "claude-haiku-4-5-20251001";

/** Claude fallback when Codex is unavailable: no tools, settings, MCP servers or saved session. */
async function requestClaudeJson(prompt: string, schema: object, signal: AbortSignal, timeout: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-factory-bot-claude-"));
  try {
    const { stdout } = await execute(claudeExecutable(), ["-p", "--model", CLAUDE_BOT_MODEL, "--tools", "",
      "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
      "--output-format", "json", "--json-schema", JSON.stringify(schema), prompt],
    { cwd: directory, env: runtimeEnvironment(), signal, timeout, maxBuffer: 1024 * 1024 });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || !("structured_output" in result)) throw new Error("Luna unavailable");
    return JSON.stringify(result.structured_output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

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
  const replySchema = { type: "object", additionalProperties: false, properties: { reply: { type: "string" } }, required: ["reply"] };
  const instruction = (prompt.trim() ? prompt : DEFAULT_BOT_PROMPT) + "\n\n" +
    "Do not perform tasks or use tools. Return JSON with reply. " +
    "The following JSON string is the user's message:\n" + JSON.stringify(text);
  try {
    return await requestCodexReply(instruction, replySchema, signal);
  } catch (error) {
    if (!isMissingExecutable(error)) throw error;
    return parseBotReply(await requestClaudeJson(instruction, replySchema, signal, 60000));
  }
}

async function requestCodexReply(instruction: string, replySchema: object, signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-factory-bot-talk-"));
  try {
    const schema = join(directory, "schema.json");
    const output = join(directory, "response.json");
    await writeFile(schema, JSON.stringify(replySchema));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(codexExecutable(), ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
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
      child.stdin.end(instruction);
    });
    return parseBotReply(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Isolated, ephemeral inference. Only a fixed state enum leaves the host. */
export async function requestLunaMood(context: BotContext, signal: AbortSignal): Promise<BotMood> {
  const moodSchema = { type: "object", additionalProperties: false, properties: { mood: { type: "string", enum: moods } }, required: ["mood"] };
  const instruction = `Choose a small companion robot's expression for state ${context}. Return only the required JSON. ` +
    "Use calm for reassurance, curious for interest, cheerful for success, focused for concentration. Do not use tools.";
  try {
    return await requestCodexMood(instruction, moodSchema, signal);
  } catch (error) {
    if (!isMissingExecutable(error)) throw error;
    return parseBotMood(await requestClaudeJson(instruction, moodSchema, signal, 15000));
  }
}

async function requestCodexMood(instruction: string, moodSchema: object, signal: AbortSignal): Promise<BotMood> {
  const directory = await mkdtemp(join(tmpdir(), "agent-factory-bot-"));
  try {
    const schema = join(directory, "schema.json");
    const output = join(directory, "response.json");
    await writeFile(schema, JSON.stringify(moodSchema));
    const invocation = execute(codexExecutable(), ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--model", "gpt-5.6-luna", "--sandbox", "read-only",
      "--disable", "shell_tool", "--disable", "apps", "--disable", "multi_agent",
      "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="none"',
      "-c", 'model_reasoning_summary="none"', "-c", 'web_search="disabled"',
      "--output-schema", schema, "--output-last-message", output, instruction],
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
