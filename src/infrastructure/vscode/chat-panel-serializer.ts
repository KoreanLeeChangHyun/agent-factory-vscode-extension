import type * as vscode from "vscode";
import type { ChatPanelManager } from "./chat-panel-manager";

export class ChatPanelSerializer implements vscode.WebviewPanelSerializer {
  public constructor(private readonly panels: ChatPanelManager) {}

  public async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    state: unknown
  ): Promise<void> {
    await this.panels.revive(panel, state);
  }
}
