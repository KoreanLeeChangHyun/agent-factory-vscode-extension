import { contractAgentIds } from "../filesystem/contract-agents";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { readContractDetail } from "../filesystem/contract-detail";

export async function openContractPanel(extensionUri: vscode.Uri, root: string, id: string, workflows: () => Promise<readonly Record<string, unknown>[]>, openAgent: (agentId: string) => Promise<void>) {
  const initial = await readContractDetail(root, id);
  const panel = vscode.window.createWebviewPanel("agentFactory.contract", initial.versions[0]?.title ?? id, vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "static")]
  });
  const nonce = randomUUID();
  const resource = (path: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "static", ...path.split("/"))).toString();
  panel.webview.html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource("css/contracts.css")}"></head><body><main id="contract-app"></main><script nonce="${nonce}" src="${resource("vendor/markdown-it.min.js")}"></script><script nonce="${nonce}" src="${resource("js/contracts.js")}"></script></body></html>`;
  let revision = 0;
  let allowedAgents = new Set<string>();
  const send = async () => {
    const request = ++revision;
    try {
      const data = await readContractDetail(root, id);
      let snapshots: readonly Record<string, unknown>[] = [], workflowError: string | undefined;
      try { snapshots = await workflows(); } catch (error) { workflowError = String(error); }
      if (request === revision) {
        allowedAgents = contractAgentIds(id, snapshots);
        await panel.webview.postMessage({ type: "detail", data, workflows: snapshots, workflowError });
      }
    }
    catch (error) { if (request === revision) await panel.webview.postMessage({ type: "error", message: String(error) }); }
  };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (message?.type === "agent.open" && typeof message.agentId === "string" && allowedAgents.has(message.agentId)) {
      try { await openAgent(message.agentId); }
      catch (error) { await panel.webview.postMessage({ type: "error", message: String(error) }); }
      return;
    }
    if (message?.type === "ready" || message?.type === "refresh") await send();
  });
  panel.onDidDispose(() => listener.dispose());
}
