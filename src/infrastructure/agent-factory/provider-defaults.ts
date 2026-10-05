import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModelSetting } from "../../common/types/agent-models";
import { validAgentValue } from "../../core/config/agent-settings";
import type { ProviderId } from "../../common/types/provider";

/** Factory starting values, overridden by the detected CLI's saved preferences. */
const defaults: Record<ProviderId, AgentModelSetting> = {
  codex: {model: "gpt-6-astra", reasoningEffort: "medium", fast: false},
  claude: {model: "claude-opus-5-5", reasoningEffort: "medium"},
  antigravity: {model: "gemini-3.8-flash", reasoningEffort: "high"}
};

export function providerDefaultSettings(provider: ProviderId, config: Record<string, unknown>): AgentModelSetting {
  const result = {...defaults[provider]};
  let model = config.model;
  if (provider === "claude" && typeof model === "string" && ["opus", "sonnet", "haiku"].includes(model)) model = `claude-${model}`;
  if (provider === "antigravity" && typeof model === "string" && !model.startsWith("gemini-") && !model.startsWith("antigravity/")) model = `antigravity/${model}`;
  if (validAgentValue("model", model)) result.model = model as string;
  const effort = config.model_reasoning_effort ?? config.effortLevel ?? config.effort;
  if (validAgentValue("reasoningEffort", effort)) result.reasoningEffort = effort as AgentModelSetting["reasoningEffort"];
  if (provider === "codex" && typeof config.service_tier === "string") result.fast = config.service_tier === "fast";
  return result;
}

export async function readProviderDefaults(
  providers: Partial<Record<ProviderId, boolean>>,
  read: (path: string) => Promise<string> = path => readFile(path, "utf8")
): Promise<Partial<Record<ProviderId, AgentModelSetting>>> {
  const paths: Record<ProviderId, string> = {
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
    claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"),
    antigravity: join(homedir(), ".gemini", "antigravity-cli", "settings.json")
  };
  return Object.fromEntries(await Promise.all((Object.keys(paths) as ProviderId[]).filter(id => providers[id]).map(async id => {
    let config: Record<string, unknown> = {};
    try {
      const text = await read(paths[id]);
      const parsed: unknown = id === "codex" ? (await import("@iarna/toml")).parse(text) : JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      if (id === "codex" && typeof config.profile === "string" && config.profiles && typeof config.profiles === "object") {
        const profile = (config.profiles as Record<string, unknown>)[config.profile];
        if (profile && typeof profile === "object") config = {...config, ...profile};
      }
    } catch {
      // A CLI with no saved preferences uses the provider's factory starting values.
    }
    return [id, providerDefaultSettings(id, config)];
  })));
}
