import { localize } from "../common/localization";
import * as vscode from "vscode";
import { resolveStatusItems } from "./config/resolver";
import { ChatPanelManager } from "../infrastructure/vscode/chat-panel-manager";
import { ChatTemplateRenderer } from "../infrastructure/vscode/chat-template-renderer";
import { locateAgentFactoryExec } from "../infrastructure/agent-factory/plugin-locator";
import { AgentFactoryClient } from "../infrastructure/agent-factory/agent-client";
import { AsyncCache } from "../common/async-cache";
import { developmentPluginRoot, developmentExecPath } from "../infrastructure/agent-factory/development-plugin";
import { defaultPythonCommand } from "../infrastructure/agent-factory/process-environment";

type RuntimeConnection = { readonly available: true; readonly client: AgentFactoryClient } | { readonly available: false; readonly diagnostic: string };

export interface Container {
  readonly chatPanels: ChatPanelManager;
}

export function createContainer(context: vscode.ExtensionContext): Container {
  const requiredVersion: string = context.extension.packageJSON.version;
  const templateRenderer = new ChatTemplateRenderer(context.extensionUri);
  const connections = new AsyncCache<RuntimeConnection>(30_000, 4);
  const chatPanels = new ChatPanelManager(
    context,
    templateRenderer,
    () => resolveStatusItems(vscodeConfiguration()),
    async () => {
      const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectRoot) {
        return { available: false, diagnostic: localize("host.workspace.required") };
      }
      const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
      const developmentRoot = developmentPluginRoot(isDevelopment);
      const configuredPath = developmentRoot ? developmentExecPath(developmentRoot) : isDevelopment ? vscode.workspace
        .getConfiguration("agentFactory.mainChat")
        .get<string>("runtimeExecPath") : undefined;
      const pythonPath = vscode.workspace.getConfiguration("agentFactory.mainChat").get<string>("pythonPath")?.trim() || defaultPythonCommand();
      const key = JSON.stringify([projectRoot, configuredPath, pythonPath, process.env.CODEX_HOME, process.env.PATH]);
      return connections.get(key, async () => {
        const location = await locateAgentFactoryExec({ configuredPath, requiredVersion });
        if (!location.available) return location;
        const client = new AgentFactoryClient(location.execPath, projectRoot, pythonPath, undefined, async () => {
          const refreshed = await locateAgentFactoryExec({ configuredPath, requiredVersion });
          if (!refreshed.available) throw new Error(refreshed.diagnostic);
          return refreshed.execPath;
        }, undefined, developmentRoot);
        const diagnosis = await client.diagnose();
        if (!diagnosis.available) return diagnosis;
        return { available: true, client };
      }, (connection) => connection.available);
    }
  );

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("agentFactory.mainChat.botsEnabled") || event.affectsConfiguration("agentFactory.mainChat.botPrompt")) void chatPanels.refreshBots();
    if (event.affectsConfiguration("agentFactory.mainChat.statusItems")) {
      void chatPanels.refreshStatusItems();
    }
  }));

  return { chatPanels };
}

function vscodeConfiguration(): readonly unknown[] | undefined {
  return vscode.workspace
    .getConfiguration("agentFactory.mainChat")
    .get<readonly unknown[]>("statusItems");
}
