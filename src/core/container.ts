import * as vscode from "vscode";
import { resolveStatusItems } from "./config/resolver";
import { ChatPanelManager } from "../infrastructure/vscode/chat-panel-manager";
import { ChatTemplateRenderer } from "../infrastructure/vscode/chat-template-renderer";

export interface Container {
  readonly chatPanels: ChatPanelManager;
}

export function createContainer(context: vscode.ExtensionContext): Container {
  const templateRenderer = new ChatTemplateRenderer(context.extensionUri);
  const chatPanels = new ChatPanelManager(
    context,
    templateRenderer,
    () => resolveStatusItems(vscodeConfiguration())
  );

  return { chatPanels };
}

function vscodeConfiguration(): readonly unknown[] | undefined {
  return vscode.workspace
    .getConfiguration("agentFactory.mainChat")
    .get<readonly unknown[]>("statusItems");
}
