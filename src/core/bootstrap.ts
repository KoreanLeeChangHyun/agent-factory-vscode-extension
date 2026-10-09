import * as vscode from "vscode";
import { AgentSidebar } from "../infrastructure/vscode/agent-sidebar";
import { createContainer } from "./container";
import { ChatPanelSerializer } from "../infrastructure/vscode/chat-panel-serializer";
import { LoadingAnimationGallery } from "../infrastructure/vscode/loading-animation-gallery";
import { ArchifyEditor } from "../infrastructure/vscode/archify-editor";

export function bootstrap(context: vscode.ExtensionContext): void {
  const container = createContainer(context);
  ArchifyEditor.register(context);

  context.subscriptions.push(
    container.chatPanels,
    new AgentSidebar(context, container.chatPanels),
    vscode.commands.registerCommand("agentFactory.mainChat.open", async () => {
      await container.chatPanels.openDraft();
    }),
    vscode.commands.registerCommand("agentFactory.mainChat.resume", async () => {
      await container.chatPanels.requestResume();
    }),
    vscode.commands.registerCommand("agentFactory.mainChat.rename", async () => {
      await container.chatPanels.renameActive();
    }),
    vscode.commands.registerCommand("agentFactory.mainChat.clearConversation", async () => {
      await container.chatPanels.clearActiveConversation();
    }),
    vscode.commands.registerCommand("agentFactory.loadingAnimations.preview", async () => {
      await LoadingAnimationGallery.open(context.extensionUri);
    }),
    vscode.window.registerWebviewPanelSerializer(
      container.chatPanels.viewType,
      new ChatPanelSerializer(container.chatPanels)
    )
  );
  // Let a command that activated the extension open its requested chat first.
  const startup = setTimeout(() => { void container.chatPanels.openStartup().catch(error => console.warn("[Agent Factory] Startup chat could not be opened", error)); }, 0);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(startup)));
}
