import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export class LoadingAnimationGallery {
  private static panel: vscode.WebviewPanel | undefined;

  public static async open(extensionUri: vscode.Uri): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentFactory.loadingAnimations",
      "Loading Animation Samples",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "static")
        ]
      }
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.html = await renderGallery(panel.webview, extensionUri);
  }
}

async function renderGallery(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const templateUri = vscode.Uri.joinPath(extensionUri, "templates", "loading-animation-gallery.html");
  const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString("utf8");
  const nonce = randomBytes(24).toString("base64url");
  const replacements: Readonly<Record<string, string>> = {
    "{{cspSource}}": webview.cspSource,
    "{{nonce}}": nonce,
    "{{styleUri}}": webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "static", "css", "loading-animation-gallery.css")
    ).toString(),
    "{{scriptUri}}": webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "static", "js", "loading-animation-gallery.js")
    ).toString()
  };
  return Object.entries(replacements).reduce(
    (html, [placeholder, value]) => html.replaceAll(placeholder, escapeAttribute(value)),
    template
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
