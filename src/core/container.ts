import * as vscode from "vscode";
import { resolveStatusItems } from "./config/resolver";
import { ChatPanelManager } from "../infrastructure/vscode/chat-panel-manager";
import { ChatTemplateRenderer } from "../infrastructure/vscode/chat-template-renderer";
import { locateAgentFactoryExec } from "../infrastructure/agent-factory/plugin-locator";
import { AgentFactoryClient } from "../infrastructure/agent-factory/agent-client";

export interface Container {
  readonly chatPanels: ChatPanelManager;
}

export function createContainer(context: vscode.ExtensionContext): Container {
  const templateRenderer = new ChatTemplateRenderer(context.extensionUri);
  const chatPanels = new ChatPanelManager(
    context,
    templateRenderer,
    () => resolveStatusItems(vscodeConfiguration()),
    async () => {
      const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectRoot) {
        return { available: false, diagnostic: "Main Agent를 실행할 VS Code 작업 영역을 먼저 여세요." };
      }
      const configuredPath = vscode.workspace
        .getConfiguration("agentFactory.mainChat")
        .get<string>("runtimeExecPath");
      const location = await locateAgentFactoryExec({ configuredPath });
      if (!location.available) return location;
      const client = new AgentFactoryClient(location.execPath, projectRoot);
      const diagnosis = await client.diagnose();
      if (!diagnosis.available) return diagnosis;
      return {
        available: true,
        client
      };
    }
  );

  return { chatPanels };
}

function vscodeConfiguration(): readonly unknown[] | undefined {
  return vscode.workspace
    .getConfiguration("agentFactory.mainChat")
    .get<readonly unknown[]>("statusItems");
}
