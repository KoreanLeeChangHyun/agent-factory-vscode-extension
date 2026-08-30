import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export class ChatTemplateRenderer {
  public constructor(private readonly extensionUri: vscode.Uri) {}

  public get localResourceRoots(): readonly vscode.Uri[] {
    return [vscode.Uri.joinPath(this.extensionUri, "static")];
  }

  public async render(webview: vscode.Webview): Promise<string> {
    const templateUri = vscode.Uri.joinPath(this.extensionUri, "templates", "chat.html");
    const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString("utf8");
    const nonce = randomBytes(24).toString("base64url");
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "static", "css", "chat.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "static", "js", "chat.js")
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "static", "images", "agent-factory.svg")
    );

    const replacements: Readonly<Record<string, string>> = {
      "{{cspSource}}": webview.cspSource,
      "{{nonce}}": nonce,
      "{{styleUri}}": styleUri.toString(),
      "{{scriptUri}}": scriptUri.toString(),
      "{{iconUri}}": iconUri.toString()
    };

    return Object.entries(replacements).reduce(
      (html, [placeholder, value]) => html.replaceAll(placeholder, escapeAttribute(value)),
      template
    );
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
