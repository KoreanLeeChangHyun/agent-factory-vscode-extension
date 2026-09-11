import * as vscode from "vscode";
import { createContainer } from "./container";
import { ChatPanelSerializer } from "../infrastructure/vscode/chat-panel-serializer";
import { LoadingAnimationGallery } from "../infrastructure/vscode/loading-animation-gallery";

export function bootstrap(context: vscode.ExtensionContext): void {
  const container = createContainer(context);

  context.subscriptions.push(
    container.chatPanels,
    vscode.commands.registerCommand("agentFactory.mainChat.open", async () => {
      await container.chatPanels.openDraft();
    }),
    vscode.commands.registerCommand("agentFactory.mainChat.resume", async () => {
      await container.chatPanels.requestResume();
    }),
    vscode.commands.registerCommand("agentFactory.mainChat.rename", async () => {
      await container.chatPanels.renameActive();
    }),
    vscode.commands.registerCommand("agentFactory.loadingAnimations.preview", async () => {
      await LoadingAnimationGallery.open(context.extensionUri);
    }),
    vscode.window.registerWebviewPanelSerializer(
      container.chatPanels.viewType,
      new ChatPanelSerializer(container.chatPanels)
    )
  );
}
