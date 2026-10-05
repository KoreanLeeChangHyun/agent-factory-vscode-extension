import { AGENT_ROLES, mergeAgentSettings, type AgentDefaults } from "../../core/config/agent-settings";
import type { AgentModelSetting } from "../../common/types/agent-models";
import type { ProviderId } from "../../common/types/provider";

/** Agent Factory supplies these sets. CLI preferences do not redefine their contents. */
const defaults: Record<ProviderId, AgentModelSetting> = {
  codex: {model: "gpt-6-astra", reasoningEffort: "medium", fast: false},
  claude: {model: "claude-opus-5-5", reasoningEffort: "medium"},
  antigravity: {model: "gemini-3.8-flash", reasoningEffort: "high"}
};
export function factoryAgentPresets(): {id: string; name: string; settings: AgentDefaults}[] {
  return (["codex", "claude", "antigravity"] as const).map(provider => ({
    id: `factory-${provider}`,
    name: `Agent Factory · ${{codex: "Codex", claude: "Claude", antigravity: "Antigravity"}[provider]}`,
    settings: mergeAgentSettings(Object.fromEntries(AGENT_ROLES.map(role => [role, {...defaults[provider]}])))
  }));
}
