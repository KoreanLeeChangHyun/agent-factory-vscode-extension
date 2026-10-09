import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { ArchifyClient, ArchifyPreview } from "../agent-factory/archify-client";
import { locateAgentFactoryExec } from "../agent-factory/plugin-locator";
import { developmentPluginRoot, runtimeExecOverride } from "../agent-factory/development-plugin";
import { defaultPythonCommand, runtimeEnvironment } from "../agent-factory/process-environment";
import { configuredDevelopmentPluginRoot } from "./provider-settings";

export const ARCHIFY_VIEW_TYPE = "agentFactory.archify";

export interface ArchifyRenderer {
  preview(text: string): Promise<ArchifyPreview>;
}

/** Explicit suffixes opt into this viewer; ordinary .json files keep the text editor. */
export function isArchifyFile(path: string): boolean {
  return /\.(?:archify|architecture|sequence)\.json$/i.test(path);
}

export class ArchifyEditor implements vscode.CustomTextEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri, private readonly renderer: ArchifyRenderer) {}

  static register(context: vscode.ExtensionContext): void {
    const renderer = new ArchifyClient(async () => {
      const development = context.extensionMode === vscode.ExtensionMode.Development;
      const settings = vscode.workspace.getConfiguration("agentFactory.mainChat");
      const root = developmentPluginRoot(development, process.env, configuredDevelopmentPluginRoot());
      const location = await locateAgentFactoryExec({
        configuredPath: runtimeExecOverride(development, root, settings.get<string>("runtimeExecPath")),
        requiredVersion: context.extension.packageJSON.version as string
      });
      if (!location.available) throw new Error(location.diagnostic);
      return { script: join(dirname(location.execPath), "archify.py"),
        python: settings.get<string>("pythonPath")?.trim() || defaultPythonCommand(), environment: runtimeEnvironment() };
    });
    context.subscriptions.push(renderer, vscode.window.registerCustomEditorProvider(
      ARCHIFY_VIEW_TYPE, new ArchifyEditor(context.extensionUri, renderer),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
    ));
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "static")]
    };
    const nonce = randomUUID();
    const resource = (path: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "static", ...path.split("/"))).toString();
    let html = await readFile(vscode.Uri.joinPath(this.extensionUri, "templates", "archify.html").fsPath, "utf8");
    for (const [key, value] of Object.entries({ nonce, cspSource: panel.webview.cspSource,
      styleUri: resource("css/archify.css"), scriptUri: resource("js/archify.js") })) html = html.replaceAll(`{{${key}}}`, value);
    let version = 0, closed = false;
    // Serializing one panel coalesces saves and prevents older renders from replacing newer content.
    let running = false, requested = false;
    const update = async () => {
      requested = true;
      if (running) { version++; return; }
      running = true;
      try {
        while (requested && !closed) {
          requested = false;
          const current = ++version;
          await panel.webview.postMessage({ type: "loading" });
          try {
            if (!vscode.workspace.isTrusted) throw new Error("신뢰할 수 있는 작업 영역에서 도표를 열어 주십시오.");
            if (!isArchifyFile(document.uri.fsPath)) throw new Error("Archify 파일 이름은 .archify.json, .architecture.json 또는 .sequence.json으로 끝나야 합니다.");
            const text = document.getText();
            const data = JSON.parse(text) as { diagram_type?: unknown };
            if (!data || !["architecture", "sequence"].includes(String(data.diagram_type))) throw new Error("지원하는 diagram_type은 architecture와 sequence입니다. 원문 편집으로 JSON을 확인하십시오.");
            const preview = await this.renderer.preview(text);
            const { type: diagramType, ...content } = preview;
            if (!closed && current === version) await panel.webview.postMessage({ type: "diagram", diagramType, ...content });
          } catch (error) {
            if (!closed && current === version) await panel.webview.postMessage({ type: "error", message: String(error) });
          }
        }
      } finally { running = false; }
    };
    const listener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === "ready" || message?.type === "refresh") void update();
      if (message?.type === "source") void vscode.commands.executeCommand("vscode.openWith", document.uri, "default", vscode.ViewColumn.Beside);
    });
    const save = vscode.workspace.onDidSaveTextDocument(saved => {
      if (saved.uri.toString() === document.uri.toString()) void update();
    });
    const theme = vscode.window.onDidChangeActiveColorTheme(() => panel.webview.postMessage({ type: "theme" }));
    panel.onDidDispose(() => { closed = true; version++; listener.dispose(); save.dispose(); theme.dispose(); });
    panel.webview.html = html;
  }
}
