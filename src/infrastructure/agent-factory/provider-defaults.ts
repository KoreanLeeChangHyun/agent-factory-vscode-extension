import { AGENT_ROLES, mergeAgentSettings, type AgentDefaults } from "../../core/config/agent-settings";
import type { AgentModelSetting } from "../../common/types/agent-models";

/** Agent Factory supplies these sets. CLI preferences do not redefine their contents. */
const model = (model: string, reasoningEffort: AgentModelSetting["reasoningEffort"]): AgentModelSetting => ({model, reasoningEffort, fast: false});
export function factoryAgentPresets(): {id: string; name: string; settings: AgentDefaults}[] {
  const astra = model("gpt-6-astra", "medium"), astraHigh = model("gpt-6-astra", "high");
  const sol = model("gpt-6.1-sol", "high"), luna = model("gpt-6-luna", "high");
  const opus = model("claude-opus-5-5", "high");
  const sets: [string, string, AgentModelSetting[]][] = [
    ["codex", "Codex", [astra, sol, luna, astraHigh]],
    ["claude", "Claude", [model("claude-opus-5-5", "medium"), opus, model("claude-sonnet-5-5", "medium"), opus]],
    ["antigravity", "Antigravity", ["medium", "high", "low", "high"].map(effort => model("gemini-3.8-flash", effort as AgentModelSetting["reasoningEffort"]))],
    ["mixed", "Agent Factory", [astra, opus, luna, astraHigh]],
    ["super", "Super Factory", [astraHigh, model("claude-fable-5-1", "high"), sol, astraHigh]]
  ];
  return sets.map(([id, name, models]) => ({id: `factory-${id}`, name,
    // Explorer and Scribe start from the Worker (workLight) model of each set.
    settings: mergeAgentSettings(Object.fromEntries(AGENT_ROLES.map((role, index) => [role, {...(models[index] ?? models[2])}])))}));
}
