import * as vscode from "vscode";
import { AGENT_ROLES, AGENT_FIELDS, mergeAgentSettings, type AgentDefaultsSnapshot, type AgentDefaults, validAgentValue } from "../../core/config/agent-settings";
const section = "agentFactory.agents";
export function readAgentDefaults(): AgentDefaultsSnapshot {
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const config = vscode.workspace.getConfiguration?.(section, uri);
  const global: AgentDefaults = {}, project: AgentDefaults = {};
  const sources: AgentDefaultsSnapshot["sources"] = {};
  for (const role of AGENT_ROLES) {
    const g: Record<string, string> = {}, p: Record<string, string> = {};
    sources[role] = {};
    for (const field of AGENT_FIELDS) {
      const entry = config?.inspect?.<string>(`${role}.${field}`);
      const globalValue = entry?.globalValue;
      const projectValue = entry?.workspaceFolderValue || entry?.workspaceValue;
      if (globalValue && validAgentValue(field, globalValue)) g[field] = globalValue;
      if (projectValue && validAgentValue(field, projectValue)) p[field] = projectValue;
      sources[role]![field] = p[field] ? "project" : g[field] ? "global" : "product";
    }
    global[role] = g; project[role] = p;
  }
  return { global, project, effective: mergeAgentSettings(global, project), sources, projectAvailable: Boolean(uri) };
}
export async function saveAgentDefault(scope: "global" | "project", role: string, field: string, value: string): Promise<void> {
  if (!(AGENT_ROLES as readonly string[]).includes(role) || !(AGENT_FIELDS as readonly string[]).includes(field) || !validAgentValue(field, value)) throw new Error("Invalid agent setting");
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (scope === "project" && !uri) throw new Error("Open a project before changing project settings");
  const config = vscode.workspace.getConfiguration(section, uri);
  await config.update(`${role}.${field}`, value || undefined, scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.WorkspaceFolder);
}
